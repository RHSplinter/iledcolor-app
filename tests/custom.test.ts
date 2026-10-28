// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPROACH } from '../src/approach/tiers';
import { decodeSharedPreset, encodeSharedPreset, sendPreset, ShareReceiver } from '../src/approach/presetShare';
import { DEFAULT_SETTINGS, mergeCustomDrafts, validateContent, validateCustomDrafts, type CustomDrafts } from '../src/storage/presets';
import { exportSelectedJson, parseSharedBackup } from '../src/storage/sharedBackup';
import { listPresets, loadKv, restoreBackup } from '../src/storage/db';
import { initPresetSave, presetSaveInlineMarkup, presetSaveNoteMarkup } from '../src/ui/presetSave';

const drafts: CustomDrafts = {
  text: { kind: 'text', text: 'Hello', fg: '#123456', bg: '#654321', speed: 7, font: 'tiny5' },
  solid: { kind: 'solid', color: '#aabbcc' },
  image: { kind: 'image', dataUrl: '', fit: 'cover', bg: '#abcdef' },
};
const github = { handle: 'octocat', speed: 9, prefix: 'Hi {handle}', postfix: '' };
const preset = { id: 'github-test', name: 'Graph', updatedAt: 1, content: { kind: 'github' as const, ...github } };
const selection = { creations: true, approach: false, scan: false };

describe('Custom configuration', () => {
  it('round-trips all drafts, text font and GitHub presets without fetched data', () => {
    const data = parseSharedBackup(exportSelectedJson([preset], DEFAULT_APPROACH, selection, { customDrafts: drafts, github }));
    expect(data).toMatchObject({ customDrafts: drafts, github, creations: [preset] });
    expect(decodeSharedPreset(encodeSharedPreset(preset))).toEqual({ name: preset.name, content: preset.content });
    expect(validateContent({ kind: 'sequence', steps: [{ content: preset.content, seconds: 2 }] })).toMatchObject({ steps: [{ content: preset.content }] });
  });

  it('round-trips GitHub presets with a stored graph for offline replay', () => {
    const graph = { asOf: '2026-10-20', days: [{ date: '2026-10-20', count: 2, level: 1 }] };
    const stored = { ...preset, id: 'github-graph', content: { ...preset.content, ...graph } };
    const data = parseSharedBackup(exportSelectedJson([stored], DEFAULT_APPROACH, selection, {}));
    expect(data).toMatchObject({ creations: [stored] });
    expect(decodeSharedPreset(encodeSharedPreset(stored))).toEqual({ name: stored.name, content: stored.content });
    expect(validateContent({ kind: 'sequence', steps: [{ content: stored.content, seconds: 2 }] })).toMatchObject({ steps: [{ content: stored.content }] });
    for (const bad of [{ asOf: graph.asOf }, { days: graph.days }, { ...graph, asOf: '2026-02-30' }, { ...graph, asOf: 20261020 },
      { ...graph, days: [] }, { ...graph, days: [{ date: '2026-10-20', count: 1, level: 5 }] }]) {
      expect(() => validateContent({ ...preset.content, ...bad })).toThrow(/GitHub graph/);
    }
  });

  it('validates, round-trips and preserves the GitHub caption font', () => {
    for (const font of ['tiny5', null] as const) {
      const settings = { ...github, font };
      const data = parseSharedBackup(exportSelectedJson([{ ...preset, content: { ...preset.content, font } }], DEFAULT_APPROACH, selection, { github: settings }));
      expect(data).toMatchObject({ github: settings, creations: [{ content: { font } }] });
    }
    for (const font of ['Arial', 3, '']) {
      expect(() => validateContent({ ...preset.content, font })).toThrow(/font/);
      expect(() => parseSharedBackup(JSON.stringify({ app: 'iledcolor-app', version: 2, creations: [], github: { ...github, font } }))).toThrow(/font/);
    }
    expect(validateContent(preset.content)).not.toHaveProperty('font');
  });

  it('excludes all Custom configuration when Creations is unselected', () => {
    const data = JSON.parse(exportSelectedJson([preset], DEFAULT_APPROACH, { ...selection, creations: false, settings: true },
      { customDrafts: drafts, github, settings: DEFAULT_SETTINGS }));
    for (const key of ['customDrafts', 'github', 'creations']) expect(data).not.toHaveProperty(key);
  });

  it('rejects invalid drafts, font IDs, graph settings and misplaced categories', () => {
    for (const raw of [null, [], { text: { ...drafts.text, font: 'Arial' } },
      { text: drafts.solid }, { image: { ...drafts.image, fit: 'tile' } },
      { image: { ...drafts.image, bg: 'black' } }, { image: { ...drafts.image, dataUrl: 'https://example.com/a.png' } }]) {
      expect(() => validateCustomDrafts(raw)).toThrow();
    }
    for (const speed of [0, 11, 2.5, '3', null]) {
      expect(() => validateContent({ ...preset.content, speed })).toThrow(/speed/);
    }
    expect(() => validateContent({ ...preset.content, handle: '' })).toThrow(/handle/);
    expect(() => validateContent(drafts.image)).toThrow(/image data/);
    expect(() => parseSharedBackup(JSON.stringify({ app: 'iledcolor-app', version: 2, settings: DEFAULT_SETTINGS, customDrafts: drafts }))).toThrow(/with creations/);
  });

  it('preserves fields absent from older files and supports an explicit default font', () => {
    const { font: _font, ...oldText } = drafts.text;
    expect(mergeCustomDrafts(drafts, { text: { ...oldText, text: 'Older' } })).toEqual({ ...drafts, text: { ...drafts.text, text: 'Older' } });
    expect(mergeCustomDrafts(drafts, { text: { ...oldText, font: null } }).text?.font).toBeNull();
    expect(validateContent(oldText)).not.toHaveProperty('font');
    expect(validateContent({ kind: 'github', handle: 'octocat' })).not.toHaveProperty('speed');
  });

  it('persists all drafts and preserves omitted sections and old GitHub fields', async () => {
    await restoreBackup([preset], undefined, undefined, { customDrafts: drafts, github: { ...github, font: 'tiny5' } });
    await restoreBackup([preset], undefined, undefined, { customDrafts: { solid: { kind: 'solid', color: '#000000' } }, github: { handle: 'new-user' } });
    expect(await loadKv('customDrafts')).toEqual({ ...drafts, solid: { kind: 'solid', color: '#000000' } });
    expect(await loadKv('github')).toEqual({ ...github, font: 'tiny5', handle: 'new-user' });
    await restoreBackup([preset]);
    expect(await loadKv('github')).toEqual({ ...github, font: 'tiny5', handle: 'new-user' });
  });

  it.each(['customDrafts', 'github'])('rolls back the entire import on a %s write failure', async (key) => {
    await restoreBackup([preset], undefined, undefined, { customDrafts: drafts, github });
    const original = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, storeKey) {
      if (storeKey === key) throw new DOMException('Draft write failed', 'DataCloneError');
      return original.call(this, value, storeKey);
    });
    try {
      await expect(restoreBackup([], undefined, undefined, {
        customDrafts: { ...drafts, solid: { kind: 'solid', color: '#000000' } }, github: { ...github, speed: 1 },
      })).rejects.toThrow(/Draft write failed/);
    } finally { put.mockRestore(); }
    expect(await listPresets()).toEqual([preset]);
    expect(await loadKv('customDrafts')).toEqual(drafts);
    expect(await loadKv('github')).toMatchObject(github);
  });

  it('transfers a GitHub preset through the accepted BLE offer', async () => {
    let status = new Uint8Array();
    const received = vi.fn();
    const receiver = new ShareReceiver({
      publishStatus: (value) => { status = new Uint8Array(value); },
      onOffer: (offer) => receiver.accept(offer.transferId),
      onReceived: received,
      onClosed: vi.fn(),
    });
    const link = {
      connect: async () => undefined, disconnect: async () => undefined, maxWrite: async () => 100,
      write: async (_uuid: string, value: Uint8Array) => { receiver.handleWrite(value); },
      read: async () => status,
    };
    await expect(sendPreset(link, { preset, fromPhoneId: 42, fromName: 'Test', pollMs: 1 })).resolves.toBe('received');
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ kind: 'github' }), { name: preset.name, content: preset.content });
  });
});

describe('inline preset naming', () => {
  it('opens only on request, rejects blank names, reports failures, and resets after success', async () => {
    document.body.innerHTML = presetSaveNoteMarkup('test') + presetSaveInlineMarkup('test');
    const save = vi.fn().mockRejectedValueOnce(new Error('Storage is full')).mockResolvedValueOnce(undefined);
    initPresetSave(document, 'test', save);
    const start = document.querySelector<HTMLButtonElement>('#test-save-start')!;
    const form = document.querySelector<HTMLFormElement>('form')!;
    const name = document.querySelector<HTMLInputElement>('input')!;
    const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(form.hidden).toBe(true);
    start.click();
    expect(form.hidden).toBe(false);
    expect(document.activeElement).toBe(name);
    name.value = '   ';
    submit();
    expect(save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Enter a preset name');
    name.value = '  My graph  ';
    submit();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Storage is full'));
    expect(form.hidden).toBe(false);
    submit();
    await vi.waitFor(() => expect(form.hidden).toBe(true));
    expect(save).toHaveBeenLastCalledWith('My graph');
    expect(name.value).toBe('');
    expect(document.activeElement).toBe(start);
  });
});
