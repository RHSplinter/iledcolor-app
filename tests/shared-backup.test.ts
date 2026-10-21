import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPROACH } from '../src/approach/tiers';
import { DEFAULT_SETTINGS, exportJson, type ContentPreset, type GroupPreset } from '../src/storage/presets';
import { exportSelectedJson, mergeSharedPresets, parseSharedBackup, type ShareSelection } from '../src/storage/sharedBackup';
import { listPresets, loadKv, loadSettings, restoreBackup } from '../src/storage/db';
import { DEFAULT_GREETING } from '../src/scanner/greeting';
import { defaultPreferences } from '../src/sound/dictionary';

const creation: ContentPreset = { id: 'creation', name: 'Hello', updatedAt: 1, content: { kind: 'solid', color: '#ffffff' } };
const group: GroupPreset = { id: 'group', name: 'Party', updatedAt: 2, groups: structuredClone(DEFAULT_APPROACH.tiers) };
const all = { creations: true, approach: true, scan: true, settings: true };
const localCreation = { ...creation, id: 'local-creation' };
const localGroup = { ...group, id: 'local-group' };
const profiles = { selectedId: '1', profiles: [{ id: '1', note: 'Conference', pattern: '^(.+)$', template: 'Hello {name}!' }] };
const features = {
  settings: { ...DEFAULT_SETTINGS, brightness: 3, chunkSize: 128, interWriteDelayMs: 8, transform: { rotation: 90 as const, mirrorH: true, mirrorV: true } },
  createContent: { kind: 'text' as const, text: 'Current draft', fg: '#123456', bg: '#654321', speed: 9 },
  qrGreeting: { pattern: 'name=(.+)', template: 'Welcome {name}!', repetitions: 17, speed: 8 },
  qrScanLogging: true,
  github: { handle: 'octocat', prefix: 'Saved {handle}: ', postfix: '\u{1f389}' },
};
const approach = { ...DEFAULT_APPROACH, mode: 'hub' as const, beacon: false, countNearbyCaps: false, enterDbm: -62, settleMs: 4500 };

describe('selected backup categories', () => {
  for (let flags = 1; flags < 16; flags++) {
    const selection: ShareSelection = { creations: !!(flags & 1), approach: !!(flags & 2), scan: !!(flags & 4), settings: !!(flags & 8) };
    it(`round-trips selection ${JSON.stringify(selection)} without excluded categories`, () => {
      const json = exportSelectedJson([creation, group], approach, selection, profiles, features);
      const data = parseSharedBackup(json);
      expect(data.version).toBe(2);
      if (data.version !== 2) throw new Error('Wrong version');
      expect(data.creations).toEqual(selection.creations ? [creation] : undefined);
      expect(data.approach).toEqual(selection.approach ? {
        groups: approach.tiers, presets: [group], mode: 'hub', beacon: false, countNearbyCaps: false,
      } : undefined);
      expect(data.scan).toEqual(selection.scan ? {
        enterDbm: -62, leaveDbm: -75, settleMs: 4500, confirmMs: 1000, staleMs: 8000,
      } : undefined);
      expect(data.settings).toEqual(selection.settings ? features.settings : undefined);
      expect(data.createContent).toEqual(selection.creations ? features.createContent : undefined);
      expect(data.github).toEqual(selection.creations ? features.github : undefined);
      expect(data.qrProfiles).toEqual(selection.scan ? profiles : undefined);
      expect(data.qrGreeting).toEqual(selection.scan ? features.qrGreeting : undefined);
      expect(data.qrScanLogging).toEqual(selection.scan ? true : undefined);
      for (const excluded of ['phoneId', 'userName', 'approachCaps', 'approachEnabled', 'qr-scan-log', 'qr-raw']) {
        expect(json).not.toContain(excluded);
      }
      const merged = mergeSharedPresets([localCreation, localGroup], data);
      expect(merged).toHaveLength(2);
      expect(merged).toContainEqual(selection.creations ? creation : localCreation);
      expect(merged).toContainEqual(selection.approach ? group : localGroup);
    });
  }

  it('requires at least one category', () => {
    expect(() => exportSelectedJson([], DEFAULT_APPROACH, { creations: false, approach: false, scan: false })).toThrow(/Choose/);
    expect(() => parseSharedBackup('{"app":"iledcolor-app","version":2}')).toThrow(/No shared categories/);
    expect(() => exportSelectedJson([], DEFAULT_APPROACH, { creations: false, approach: false, scan: false, settings: true }))
      .toThrow(/settings are unavailable/);
  });

  it('keeps older version-2 files importable without inventing absent preferences', () => {
    const data = parseSharedBackup(JSON.stringify({
      app: 'iledcolor-app', version: 2, creations: [creation],
      approach: { groups: DEFAULT_APPROACH.tiers, presets: [group] },
      scan: { enterDbm: -70, leaveDbm: -75, settleMs: 2000, confirmMs: 1000, staleMs: 8000 },
    }));
    expect(data.version).toBe(2);
    if (data.version !== 2) throw new Error('Wrong version');
    expect(data.approach).toEqual({ groups: DEFAULT_APPROACH.tiers, presets: [group] });
    expect(data.createContent).toBeUndefined();
    expect(data.github).toBeUndefined();
    expect(data.settings).toBeUndefined();
    expect(data.qrGreeting).toBeUndefined();
    expect(data.qrScanLogging).toBeUndefined();
    expect(data.qrProfiles).toBeUndefined();
  });

  describe('GitHub settings backup', () => {
    it('rejects invalid and misplaced handles while preserving absent handles in older backups', () => {
      for (const github of [null, {}, { handle: '@octocat' }, { handle: 123 },
        { handle: 'octocat', prefix: null }, { handle: 'octocat', postfix: 123 },
        { handle: 'octocat', prefix: 'x'.repeat(201) }, { handle: 'octocat', postfix: '\n' }]) {
        expect(() => parseSharedBackup(JSON.stringify({ app: 'iledcolor-app', version: 2, creations: [], github }))).toThrow();
      }
      expect(() => parseSharedBackup(JSON.stringify({
        app: 'iledcolor-app', version: 2, scan: {}, github: features.github,
      }))).toThrow(/with creations/);
      const data = parseSharedBackup(exportSelectedJson([], approach, all, undefined, { ...features, github: { handle: '' } }));
      if (data.version !== 2) throw new Error('Wrong version');
      expect(data.github).toEqual({ handle: '' });
    });

    it('persists the handle and captions atomically and preserves them when absent from an import', async () => {
      await restoreBackup([creation], features.settings, undefined, { github: features.github });
      expect(await loadKv('github')).toEqual(features.github);
      await restoreBackup([group]);
      expect(await loadKv('github')).toEqual(features.github);
      const original = IDBObjectStore.prototype.put;
      const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        if (key === 'github') throw new DOMException('GitHub write failed', 'DataCloneError');
        return original.call(this, value, key);
      });
      try {
        await expect(restoreBackup([localCreation], DEFAULT_SETTINGS, undefined, { github: { handle: 'changed', prefix: '', postfix: '' } }))
          .rejects.toThrow(/GitHub write failed/);
      } finally { put.mockRestore(); }
      expect(await loadKv('github')).toEqual(features.github);
      expect(await listPresets()).toEqual([group]);
      expect(await loadSettings()).toEqual(features.settings);
    });

    it('round-trips empty captions and preserves absent fields in handle-only backups', () => {
      for (const github of [{ handle: 'octocat' }, { handle: 'octocat', prefix: '', postfix: '' }]) {
        const data = parseSharedBackup(exportSelectedJson([], approach, all, undefined, { ...features, github }));
        if (data.version !== 2) throw new Error('Wrong version');
        expect(data.github).toEqual(github);
      }
    });

    it('ignores invalid captions when Creations is excluded', () => {
      const json = exportSelectedJson([], approach, { creations: false, approach: false, scan: true }, undefined,
        { github: { handle: 'octocat', prefix: 'x'.repeat(201), postfix: '\n' } });
      expect(JSON.parse(json)).not.toHaveProperty('github');
      expect(parseSharedBackup(json).version).toBe(2);
    });
  });

  it('preserves an explicitly disabled logging preference', () => {
    const data = parseSharedBackup(exportSelectedJson([], approach, { creations: false, approach: false, scan: true },
      undefined, { qrScanLogging: false }));
    if (data.version !== 2) throw new Error('Wrong version');
    expect(data.qrScanLogging).toBe(false);
  });

  it('does not validate excluded feature settings', () => {
    const data = parseSharedBackup(exportSelectedJson([], approach, { creations: true, approach: false, scan: false },
      profiles, { qrGreeting: { ...DEFAULT_GREETING, repetitions: 0 } }));
    if (data.version !== 2) throw new Error('Wrong version');
    expect(data.qrGreeting).toBeUndefined();
  });

  it('distinguishes an empty included category from an excluded one', () => {
    const data = parseSharedBackup(exportSelectedJson([], DEFAULT_APPROACH, { creations: true, approach: false, scan: false }));
    expect(mergeSharedPresets([localCreation, localGroup], data)).toEqual([localGroup]);
  });

  it('shares QR profiles only when scan settings are selected', () => {
    const profiles = { selectedId: null, profiles: [] };
    const withScan = parseSharedBackup(exportSelectedJson([], DEFAULT_APPROACH, all, profiles, features));
    expect(withScan.qrProfiles).toEqual(profiles);
    const withoutScan = parseSharedBackup(exportSelectedJson([], DEFAULT_APPROACH, { ...all, scan: false }, profiles, features));
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
    const file = JSON.parse(exportSelectedJson([creation, group], DEFAULT_APPROACH, all, undefined, features));
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

  it('rejects invalid feature preferences and preferences without their category', () => {
    const file = JSON.parse(exportSelectedJson([creation, group], approach, all, profiles, features));
    const invalid = [
      { ...file, qrGreeting: null },
      { ...file, qrGreeting: { ...features.qrGreeting, pattern: '(' } },
      { ...file, qrGreeting: { ...features.qrGreeting, repetitions: 0 } },
      { ...file, qrGreeting: { ...features.qrGreeting, speed: 11 } },
      { ...file, qrScanLogging: 'true' },
      { ...file, settings: { ...features.settings, brightness: -1 } },
      { ...file, createContent: { kind: 'solid', color: 'red' } },
      { ...file, approach: { ...file.approach, mode: 'unknown' } },
      { ...file, approach: { ...file.approach, beacon: 1 } },
      { ...file, approach: { ...file.approach, countNearbyCaps: null } },
      { ...file, approach: { ...file.approach, mode: 'p2p', beacon: false } },
      { app: file.app, version: 2, creations: [], qrGreeting: features.qrGreeting },
      { app: file.app, version: 2, creations: [], qrScanLogging: false },
      { app: file.app, version: 2, scan: file.scan, createContent: features.createContent },
    ];
    for (const raw of invalid) expect(() => parseSharedBackup(JSON.stringify(raw))).toThrow();
  });

  it('does not overwrite an excluded preset with a colliding ID', () => {
    const data = parseSharedBackup(exportSelectedJson([{ ...creation, id: localGroup.id }], DEFAULT_APPROACH, { creations: true, approach: false, scan: false }));
    expect(() => mergeSharedPresets([localGroup], data)).toThrow(/conflicts/);
  });

  it('rejects exports that are too large to import', () => {
    const huge = { ...creation, name: 'x'.repeat(4 * 1024 * 1024) };
    expect(() => exportSelectedJson([huge], DEFAULT_APPROACH, all, undefined, features)).toThrow(/4 MB/);
  });
});

describe('saving an imported backup', () => {
  it('persists all feature preferences together and retains omitted preferences', async () => {
    await restoreBackup([creation, group], features.settings, approach, { ...features, qrProfiles: profiles });
    expect(await loadSettings()).toEqual(features.settings);
    expect(await loadKv('approach')).toEqual(approach);
    expect(await loadKv('createContent')).toEqual(features.createContent);
    expect(await loadKv('qrGreeting')).toEqual(features.qrGreeting);
    expect(await loadKv('qrGreetingProfiles')).toEqual(profiles);
    expect(await loadKv('qrScanLogging')).toBe(true);
    await restoreBackup([localCreation], undefined, undefined, { qrScanLogging: false });
    expect(await loadKv('qrScanLogging')).toBe(false);
    expect(await loadKv('qrGreeting')).toEqual(features.qrGreeting);
    expect(await loadKv('qrGreetingProfiles')).toEqual(profiles);
    expect(await loadKv('createContent')).toEqual(features.createContent);
    expect(await loadSettings()).toEqual(features.settings);
    expect(await loadKv('approach')).toEqual(approach);
  });

  it('rolls back every category if a scanner preference cannot be saved', async () => {
    await restoreBackup([creation], features.settings, approach, { ...features, qrProfiles: profiles });
    const original = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (key === 'qrScanLogging') throw new DOMException('Scanner write failed', 'DataCloneError');
      return original.call(this, value, key);
    });
    try {
      await expect(restoreBackup([localCreation], DEFAULT_SETTINGS, DEFAULT_APPROACH, {
        createContent: creation.content, qrProfiles: { selectedId: null, profiles: [] },
        qrGreeting: DEFAULT_GREETING, qrScanLogging: false,
      })).rejects.toThrow(/Scanner write failed/);
    } finally { put.mockRestore(); }
    expect(await listPresets()).toEqual([creation]);
    expect(await loadSettings()).toEqual(features.settings);
    expect(await loadKv('approach')).toEqual(approach);
    expect(await loadKv('createContent')).toEqual(features.createContent);
    expect(await loadKv('qrGreeting')).toEqual(features.qrGreeting);
    expect(await loadKv('qrGreetingProfiles')).toEqual(profiles);
    expect(await loadKv('qrScanLogging')).toBe(true);
  });

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

describe('sound settings backup', () => {
  const sound = { ...defaultPreferences(), language: 'de-DE' as const, sounds: false, allowBrowserSpeech: true };
  sound.reactions.greeting = { enabled: false, text: 'SERVUS' };

  it('round-trips sound settings without browser speech consent and keeps other categories excluded', () => {
    const json = exportSelectedJson([creation, group], approach, { creations: false, approach: false, scan: false, sound: true }, profiles, { ...features, sound });
    const raw = JSON.parse(json);
    expect(Object.keys(raw).sort()).toEqual(['app', 'sound', 'version']);
    const data = parseSharedBackup(json);
    if (data.version !== 2) throw new Error('Wrong version');
    expect(data.sound).toEqual({ ...sound, allowBrowserSpeech: false });
    expect(mergeSharedPresets([localCreation, localGroup], data)).toEqual([localCreation, localGroup]);
  });

  it('omits sound settings when unselected and requires them when selected', () => {
    expect(JSON.parse(exportSelectedJson([creation], approach, all, profiles, { ...features, sound }))).not.toHaveProperty('sound');
    expect(() => exportSelectedJson([creation], approach, { ...all, sound: true }, profiles, features)).toThrow('Sound settings are unavailable');
  });

  it('rejects invalid sound settings', () => {
    const file = (value: unknown) => JSON.stringify({ app: 'iledcolor-app', version: 2, sound: value });
    expect(() => parseSharedBackup(file({ ...sound, language: 'fr-FR' }))).toThrow('English or German');
    expect(() => parseSharedBackup(file({ ...sound, reactions: { ...sound.reactions, greeting: { enabled: true, text: 'Grüß' } } }))).toThrow('ASCII');
    expect(() => parseSharedBackup(file({ ...sound, reactions: {} }))).toThrow('Missing reaction');
  });

  it('persists imported sound settings atomically with the rest of the import', async () => {
    await restoreBackup([creation], undefined, undefined, { sound });
    expect(await loadKv('soundPreferences')).toEqual(sound);
    expect(await listPresets()).toEqual([creation]);
  });
});