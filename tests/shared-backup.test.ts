import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPROACH } from '../src/approach/tiers';
import { DEFAULT_SETTINGS, exportJson, type ContentPreset, type GroupPreset } from '../src/storage/presets';
import { exportSelectedJson, mergeSharedPresets, parseSharedBackup, type ShareSelection } from '../src/storage/sharedBackup';
import { listPresets, loadKv, loadSettings, restoreBackup } from '../src/storage/db';

const creation: ContentPreset = { id: 'creation', name: 'Hello', updatedAt: 1, content: { kind: 'solid', color: '#ffffff' } };
const group: GroupPreset = { id: 'group', name: 'Party', updatedAt: 2, groups: structuredClone(DEFAULT_APPROACH.tiers) };
const all = { creations: true, approach: true, scan: true };
const localCreation = { ...creation, id: 'local-creation' };
const localGroup = { ...group, id: 'local-group' };

describe('selected backup categories', () => {
  for (let flags = 1; flags < 8; flags++) {
    const selection: ShareSelection = { creations: !!(flags & 1), approach: !!(flags & 2), scan: !!(flags & 4) };
    it(`round-trips selection ${JSON.stringify(selection)} without excluded categories`, () => {
      const json = exportSelectedJson([creation, group], DEFAULT_APPROACH, selection);
      const data = parseSharedBackup(json);
      expect(data.version).toBe(2);
      if (data.version !== 2) throw new Error('Wrong version');
      expect(data.creations).toEqual(selection.creations ? [creation] : undefined);
      expect(data.approach).toEqual(selection.approach ? { groups: DEFAULT_APPROACH.tiers, presets: [group] } : undefined);
      expect(data.scan).toEqual(selection.scan ? {
        enterDbm: -70, leaveDbm: -75, settleMs: 2000, confirmMs: 1000, staleMs: 8000,
      } : undefined);
      expect(json).not.toContain('"settings"'); // Device settings and identity are never shared.
      const merged = mergeSharedPresets([localCreation, localGroup], data);
      expect(merged).toHaveLength(2);
      expect(merged).toContainEqual(selection.creations ? creation : localCreation);
      expect(merged).toContainEqual(selection.approach ? group : localGroup);
    });
  }

  it('requires at least one category', () => {
    expect(() => exportSelectedJson([], DEFAULT_APPROACH, { creations: false, approach: false, scan: false })).toThrow(/Choose/);
    expect(() => parseSharedBackup('{"app":"iledcolor-app","version":2}')).toThrow(/No shared categories/);
  });

  it('distinguishes an empty included category from an excluded one', () => {
    const data = parseSharedBackup(exportSelectedJson([], DEFAULT_APPROACH, { creations: true, approach: false, scan: false }));
    expect(mergeSharedPresets([localCreation, localGroup], data)).toEqual([localGroup]);
  });

  it('shares QR profiles only when scan settings are selected', () => {
    const profiles = { selectedId: null, profiles: [] };
    const withScan = parseSharedBackup(exportSelectedJson([], DEFAULT_APPROACH, all, profiles));
    expect(withScan.qrProfiles).toEqual(profiles);
    const withoutScan = parseSharedBackup(exportSelectedJson([], DEFAULT_APPROACH, { ...all, scan: false }, profiles));
    expect(withoutScan.qrProfiles).toBeUndefined();
    expect(() => parseSharedBackup(JSON.stringify({
      app: 'iledcolor-app', version: 2, creations: [], qrProfiles: profiles,
    }))).toThrow(/with scan settings/);
  });

  it('keeps legacy full backups importable with original replacement behavior', () => {
    const data = parseSharedBackup(exportJson(DEFAULT_SETTINGS, [creation, group]));
    expect(data).toEqual({ version: 1, settings: DEFAULT_SETTINGS, presets: [creation, group], qrProfiles: { selectedId: null, profiles: [] } });
    expect(mergeSharedPresets([localCreation, localGroup], data)).toEqual([creation, group]);
  });

  it('rejects malformed or misplaced categories, duplicates, and invalid group content', () => {
    const file = JSON.parse(exportSelectedJson([creation, group], DEFAULT_APPROACH, all));
    const invalid = [
      { ...file, creations: [group] },
      { ...file, creations: null },
      { ...file, approach: null },
      { ...file, approach: { ...file.approach, groups: {} } },
      { ...file, approach: { ...file.approach, presets: [creation] } },
      { ...file, creations: [creation, creation] },
      { ...file, version: 99 },
    ];
    for (const raw of invalid) expect(() => parseSharedBackup(JSON.stringify(raw))).toThrow();
  });

  it('rejects bad scan values instead of quietly replacing them with defaults', () => {
    const file = JSON.parse(exportSelectedJson([], DEFAULT_APPROACH, { creations: false, approach: false, scan: true }));
    for (const patch of [
      { enterDbm: 'near' }, { enterDbm: -111 }, { leaveDbm: -60 }, { confirmMs: -1 }, { staleMs: 0 }, { settleMs: null },
    ]) {
      expect(() => parseSharedBackup(JSON.stringify({ ...file, scan: { ...file.scan, ...patch } }))).toThrow(/scan|threshold/i);
    }
  });

  it('does not overwrite an excluded preset with a colliding ID', () => {
    const data = parseSharedBackup(exportSelectedJson([{ ...creation, id: localGroup.id }], DEFAULT_APPROACH, { creations: true, approach: false, scan: false }));
    expect(() => mergeSharedPresets([localGroup], data)).toThrow(/conflicts/);
  });

  it('rejects exports that are too large to import', () => {
    const huge = { ...creation, name: 'x'.repeat(4 * 1024 * 1024) };
    expect(() => exportSelectedJson([huge], DEFAULT_APPROACH, all)).toThrow(/4 MB/);
  });
});

describe('saving an imported backup', () => {
  it('saves presets and optional settings together, retaining omitted settings', async () => {
    const settings = { ...DEFAULT_SETTINGS, brightness: 3 };
    const approach = { ...DEFAULT_APPROACH, enterDbm: -62 };
    await restoreBackup([creation, group], settings, approach);
    await restoreBackup([localCreation, group]);
    expect(await listPresets()).toEqual([group, localCreation]);
    expect(await loadSettings()).toEqual(settings);
    expect(await loadKv('approach')).toEqual(approach);
    const next = { ...approach, settleMs: 5000 };
    await restoreBackup([localCreation, group], undefined, next);
    expect(await loadSettings()).toEqual(settings);
    expect(await loadKv('approach')).toEqual(next);
  });

  it('rolls back the preset clear if queuing a write fails', async () => {
    await restoreBackup([creation, group], DEFAULT_SETTINGS, DEFAULT_APPROACH);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('Could not clone data', 'DataCloneError');
    });
    try {
      await expect(restoreBackup([localCreation], { ...DEFAULT_SETTINGS, brightness: 1 })).rejects.toThrow(/Could not clone/);
    } finally { put.mockRestore(); }
    expect(await listPresets()).toEqual([group, creation]);
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await loadKv('approach')).toEqual(DEFAULT_APPROACH);
  });
});
