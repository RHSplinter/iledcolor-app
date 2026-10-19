import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPROACH } from '../src/approach/tiers';
import { decodeOffer, decodeSharedPreset, encodeOffer, encodeSharedPreset, makeOffer } from '../src/approach/presetShare';
import { composeSequence, MAX_SEQUENCE_FRAMES } from '../src/render/sequence';
import { solid } from '../src/render/matrix';
import {
  MAX_SEQUENCE_STEPS, validateContent, validateSequenceSteps,
  type ContentPreset, type SequenceContent, type SequenceStep,
} from '../src/storage/presets';
import { exportSelectedJson, parseSharedBackup } from '../src/storage/sharedBackup';
import { listPresets, loadKv, restoreBackup } from '../src/storage/db';

const steps: SequenceStep[] = [
  { content: { kind: 'text', text: 'HELLO', fg: '#ff0000', bg: '#000000', speed: 4 }, seconds: 3 },
  { content: { kind: 'solid', color: '#00ff00' }, seconds: 2 },
];
const seq: SequenceContent = { kind: 'sequence', steps };
const seqPreset: ContentPreset = { id: 'seq', name: 'Show', updatedAt: 1, content: seq };
const creations = { creations: true, approach: false, scan: false };

describe('sequence validation', () => {
  it('accepts valid sequences and rejects invalid ones', () => {
    expect(validateContent(seq)).toEqual(seq);
    expect(() => validateContent({ kind: 'sequence', steps: [] })).toThrow(/at least one/);
    expect(() => validateContent({ kind: 'sequence', steps: [{ content: seq, seconds: 2 }] })).toThrow(/nested/);
    expect(() => validateContent({ kind: 'sequence', steps: [{ ...steps[0], seconds: 0 }] })).toThrow(/duration/);
    expect(() => validateContent({ kind: 'sequence', steps: [{ ...steps[0], seconds: 61 }] })).toThrow(/duration/);
    expect(() => validateContent({ kind: 'sequence', steps: [{ content: { kind: 'solid', color: 'red' }, seconds: 2 }] })).toThrow(/step 1/);
    expect(() => validateContent({ kind: 'sequence', steps: Array(MAX_SEQUENCE_STEPS + 1).fill(steps[1]) })).toThrow(/at most/);
    expect(() => validateContent({ kind: 'sequence' })).toThrow();
  });

  it('limits the combined image size of a sequence', () => {
    const image = { kind: 'image', dataUrl: `data:image/png;base64,${'A'.repeat(800_000)}`, fit: 'contain', bg: '#000000' };
    expect(() => validateSequenceSteps([{ content: image, seconds: 1 }])).not.toThrow();
    expect(() => validateSequenceSteps([{ content: image, seconds: 1 }, { content: image, seconds: 1 }])).toThrow(/too large/);
  });

  it('allows an empty draft', () => {
    expect(validateSequenceSteps([])).toEqual([]);
  });
});

describe('composeSequence', () => {
  const red = solid(2, 1, [255, 0, 0]);
  const blue = solid(2, 1, [0, 0, 255]);

  it('holds static steps and repeats animations for at least the step duration', () => {
    const r = composeSequence([
      { image: red, seconds: 2 },
      { image: red, frames: [red, blue], delays: [400, 400], seconds: 2 },
    ]);
    expect(r.delays).toEqual([2000, 400, 400, 400, 400, 400, 400]);
    expect(r.frames).toEqual([red, red, blue, red, blue, red, blue]);
  });

  it('plays an animation at least once', () => {
    const r = composeSequence([{ image: red, frames: [red, blue], delays: [3000, 3000], seconds: 1 }]);
    expect(r.frames).toHaveLength(2);
  });

  it('rejects empty and oversized sequences', () => {
    expect(() => composeSequence([])).toThrow(/at least one/);
    const frames = Array(MAX_SEQUENCE_FRAMES + 1).fill(red);
    expect(() => composeSequence([{ image: red, frames, delays: frames.map(() => 10), seconds: 1 }])).toThrow(/too long/);
  });
});

describe('sequence presets', () => {
  it('share with nearby phones', () => {
    const bytes = encodeSharedPreset(seqPreset);
    expect(decodeSharedPreset(bytes)).toEqual({ name: 'Show', content: seq });
    const { offer } = makeOffer(seqPreset, 1, 'Me', 7);
    expect(decodeOffer(7, encodeOffer(offer)).kind).toBe('sequence');
  });

  it('round-trip in backups with the current sequence', () => {
    const playing = parseSharedBackup(exportSelectedJson([seqPreset], DEFAULT_APPROACH, creations, undefined,
      { createContent: seq, createSequence: steps }));
    if (playing.version !== 2) throw new Error('Wrong version');
    expect(playing.creations).toEqual([seqPreset]);
    expect(playing.createContent).toEqual(seq);
    expect(playing.createSequence).toBeUndefined(); // stored once, inside createContent

    const draft = parseSharedBackup(exportSelectedJson([], DEFAULT_APPROACH, creations, undefined,
      { createContent: steps[1]!.content, createSequence: steps }));
    if (draft.version !== 2) throw new Error('Wrong version');
    expect(draft.createContent).toEqual(steps[1]!.content);
    expect(draft.createSequence).toEqual(steps);

    const scanOnly = exportSelectedJson([seqPreset], DEFAULT_APPROACH, { creations: false, approach: false, scan: true }, undefined,
      { createContent: seq, createSequence: steps });
    expect(scanOnly).not.toContain('createSequence');
    expect(scanOnly).not.toContain('HELLO');
  });

  it('rejects invalid or misplaced sequence drafts', () => {
    const file = (extra: object) => JSON.stringify({ app: 'iledcolor-app', version: 2, creations: [], ...extra });
    expect(() => parseSharedBackup(file({ createSequence: [{ content: seq, seconds: 1 }] }))).toThrow(/Connect sequence/);
    expect(() => parseSharedBackup(file({ createSequence: 'x' }))).toThrow(/Connect sequence/);
    expect(() => parseSharedBackup(file({ createSequence: steps, createContent: seq }))).toThrow(/twice/);
    expect(() => parseSharedBackup(JSON.stringify({ app: 'iledcolor-app', version: 2, scan: { enterDbm: -70, leaveDbm: -75, settleMs: 0, confirmMs: 0, staleMs: 8000 }, createSequence: steps })))
      .toThrow(/included with creations/);
    expect(() => parseSharedBackup(file({ creations: [{ ...seqPreset, content: { kind: 'sequence', steps: [] } }] }))).toThrow(/Preset 1/);
  });

  it('persists the draft atomically and keeps it when an import omits it', async () => {
    await restoreBackup([seqPreset], undefined, undefined, { createContent: steps[1]!.content, createSequence: steps });
    expect(await loadKv('createSequence')).toEqual(steps);
    await restoreBackup([seqPreset], undefined, undefined, { createContent: steps[0]!.content });
    expect(await loadKv('createSequence')).toEqual(steps);
    const original = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (key === 'createSequence') throw new DOMException('Sequence write failed', 'DataCloneError');
      return original.call(this, value, key);
    });
    try {
      await expect(restoreBackup([], undefined, undefined, { createContent: seq, createSequence: [] })).rejects.toThrow(/Sequence write failed/);
    } finally { put.mockRestore(); }
    expect(await listPresets()).toEqual([seqPreset]);
    expect(await loadKv('createSequence')).toEqual(steps);
    expect(await loadKv('createContent')).toEqual(steps[0]!.content);
  });
});
