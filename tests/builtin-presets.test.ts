import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { builtinPresets } from '../src/storage/builtinPresets';
import { DEFAULT_APPROACH } from '../src/approach/tiers';
import { DEFAULT_SETTINGS, exportJson, parseImport, validateContent } from '../src/storage/presets';
import { exportSelectedJson, mergeSharedPresets, parseSharedBackup } from '../src/storage/sharedBackup';
import { listPresets, loadKv, restoreBackup } from '../src/storage/db';

describe('built-in presets', () => {
  it('uses the exact 32×16 Xebia logo supplied with the issue', () => {
    const dataUrl = builtinPresets()[1]!.content;
    if (dataUrl.kind !== 'image') throw new Error('Xebia logo must be an image');
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl.dataUrl);
    expect(match).not.toBeNull();
    const png = Buffer.from(match![1]!, 'base64');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([32, 16]);
    expect(createHash('sha256').update(png).digest('hex'))
      .toBe('72c7443855bd7fafabf7b386094c08fb3fafceaf4fe82d3f3360cc2edf0aad36');
  });

  it('provides nine valid, independent presets without changing settings', () => {
    const presets = builtinPresets();
    expect(presets.map((p) => p.name)).toEqual(['Xebia 💜 GitHub', 'Xebia logo', 'GitHub Copilot logo', 'GitHub Copilot head', 'GitHub Copilot head (blinking)', 'Party Popper', 'GitHub Copilot head (animated)', '<header>', 'LGTM 👍']);
    expect(new Set(presets.map((p) => p.id)).size).toBe(9);
    for (const p of presets) expect(validateContent(p.content)).toEqual(p.content);
    expect(parseImport(exportJson(DEFAULT_SETTINGS, presets)).presets).toEqual(presets);
    const first = presets[0]!;
    first.name = 'Changed';
    expect(builtinPresets()[0]!.name).toBe('Xebia 💜 GitHub');
  });

  it('bundles the blinking Copilot head as a looping GIF', () => {
    const preset = builtinPresets().find((p) => p.id === 'builtin-copilot-blinking-head')!;
    if (preset.content.kind !== 'image') throw new Error('Expected image content');
    expect(preset.content.dataUrl).toMatch(/^data:image\/gif;base64,/);
    const gif = Buffer.from(preset.content.dataUrl.split(',')[1]!, 'base64');
    expect(gif.toString('ascii', 0, 6)).toBe('GIF89a');
    expect(gif.toString('ascii')).toContain('NETSCAPE2.0');
  });

  for (const preset of builtinPresets()) {
    it(`round-trips a personal copy and current editor content of ${preset.name}`, async () => {
      const copy = { ...preset, id: `copy-${preset.id}`, updatedAt: 1 };
      const data = parseSharedBackup(exportSelectedJson([copy], DEFAULT_APPROACH,
        { creations: true, approach: false, scan: false }, undefined, { createContent: preset.content }));
      if (data.version !== 2) throw new Error('Wrong backup version');
      expect(data.creations).toEqual([copy]);
      expect(data.createContent).toEqual(preset.content);
      await restoreBackup(mergeSharedPresets([], data), undefined, undefined, data);
      expect(await listPresets()).toEqual([copy]);
      expect(await loadKv('createContent')).toEqual(preset.content);
    });
  }

  it('keeps built-ins out of exports and preserves personal copies when Creations is excluded', () => {
    const presets = builtinPresets();
    const data = parseSharedBackup(exportSelectedJson(presets, DEFAULT_APPROACH,
      { creations: false, approach: false, scan: true }, undefined, { createContent: presets[0]!.content }));
    expect(data).not.toHaveProperty('creations');
    expect(data).not.toHaveProperty('createContent');
    expect(mergeSharedPresets(presets, data)).toEqual(presets);
    const empty = parseSharedBackup(exportSelectedJson([], DEFAULT_APPROACH,
      { creations: true, approach: false, scan: false }));
    expect(empty).toHaveProperty('creations', []);
    expect(builtinPresets()).toEqual(presets);
  });

  it('rejects invalid imported artwork rather than persisting it', () => {
    const copy = builtinPresets()[2]!;
    const json = exportSelectedJson([copy], DEFAULT_APPROACH, { creations: true, approach: false, scan: false });
    const file = JSON.parse(json);
    file.creations[0].content.dataUrl = 'https://example.com/logo.png';
    expect(() => parseSharedBackup(JSON.stringify(file))).toThrow(/image data/);
  });

  it('rolls back editor content and saved copies on a failed import without affecting defaults', async () => {
    const presets = builtinPresets();
    const originalPreset = presets[0]!;
    await restoreBackup([originalPreset], undefined, undefined, { createContent: originalPreset.content });
    const original = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (key === 'createContent') throw new DOMException('Content write failed', 'DataCloneError');
      return original.call(this, value, key);
    });
    try {
      await expect(restoreBackup([presets[1]!], undefined, undefined, { createContent: presets[1]!.content }))
        .rejects.toThrow(/Content write failed/);
    } finally { put.mockRestore(); }
    expect(await listPresets()).toEqual([originalPreset]);
    expect(await loadKv('createContent')).toEqual(originalPreset.content);
    expect(builtinPresets()).toEqual(presets);
  });
});
