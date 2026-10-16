import { describe, expect, it } from 'vitest';
import { checkDecodedLimits, checkFileLimits, fitRect } from '../src/render/image';
import { cornerTest, rgbaToRgb, solid, transformImage } from '../src/render/matrix';
import { DEFAULT_SETTINGS, exportJson, isGroupPreset, parseImport, type Preset } from '../src/storage/presets';
import { DEFAULT_APPROACH } from '../src/approach/tiers';

const px = (img: { width: number; pixels: Uint8Array }, x: number, y: number) =>
  Array.from(img.pixels.subarray((y * img.width + x) * 3, (y * img.width + x) * 3 + 3));

describe('matrix', () => {
  it('solid has exact size', () => expect(solid(3, 2, [1, 2, 3]).pixels.length).toBe(18));
  it('composites transparency onto background', () => {
    const out = rgbaToRgb(new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 255]), [0, 0, 255]);
    expect(Array.from(out)).toEqual([0, 0, 255, 255, 0, 0]);
  });
  it('rotation moves the red corner clockwise', () => {
    const t = cornerTest(4, 2); // red top-left
    const r = transformImage(t, { rotation: 90, mirrorH: false, mirrorV: false });
    expect([r.width, r.height]).toEqual([2, 4]);
    expect(px(r, 1, 0)).toEqual([255, 0, 0]); // top-left -> top-right
    expect(px(r, 1, 3)).toEqual([0, 255, 0]); // top-right -> bottom-right
  });
  it('mirror and 180 are consistent', () => {
    const t = cornerTest(4, 2);
    const a = transformImage(t, { rotation: 180, mirrorH: false, mirrorV: false });
    const b = transformImage(transformImage(t, { rotation: 0, mirrorH: true, mirrorV: false }), { rotation: 0, mirrorH: false, mirrorV: true });
    expect(a.pixels).toEqual(b.pixels);
  });
  it('four 90s are identity', () => {
    let i = cornerTest(5, 3);
    for (let k = 0; k < 4; k++) i = transformImage(i, { rotation: 90, mirrorH: false, mirrorV: false });
    expect(i.pixels).toEqual(cornerTest(5, 3).pixels);
  });
});

describe('import limits', () => {
  it('rejects wrong types and oversized files', () => {
    expect(() => checkFileLimits({ size: 10, type: 'image/gif' })).toThrow();
    expect(() => checkFileLimits({ size: 9 * 1024 * 1024, type: 'image/png' })).toThrow(/too large/);
    expect(() => checkFileLimits({ size: 10, type: 'image/jpeg' })).not.toThrow();
  });
  it('rejects excessive decoded dimensions', () => {
    expect(() => checkDecodedLimits(9000, 10)).toThrow();
    expect(() => checkDecodedLimits(6000, 6000)).toThrow();
    expect(() => checkDecodedLimits(100, 100)).not.toThrow();
  });
  it('fit geometry', () => {
    expect(fitRect(100, 50, 10, 10, 'contain')).toEqual({ x: 0, y: 2.5, w: 10, h: 5 });
    expect(fitRect(100, 50, 10, 10, 'cover')).toEqual({ x: -5, y: 0, w: 20, h: 10 });
    expect(fitRect(100, 50, 10, 10, 'stretch')).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

const preset: Preset = { id: 'a', name: 'Hello', updatedAt: 1, content: { kind: 'text', text: 'Hi', fg: '#ffffff', bg: '#000000' } };

describe('preset import/export', () => {
  it('round-trips', () => {
    const out = parseImport(exportJson(DEFAULT_SETTINGS, [preset]));
    expect(out.presets).toEqual([preset]);
    expect(out.settings).toEqual(DEFAULT_SETTINGS);
    expect(out.qrProfiles).toEqual({ selectedId: null, profiles: [] });
  });
  const good = JSON.parse(exportJson(DEFAULT_SETTINGS, [preset]));
  const bad = (mut: (o: any) => void) => { const o = structuredClone(good); mut(o); return JSON.stringify(o); };
  it('rejects malformed data', () => {
    expect(() => parseImport('{nope')).toThrow(/JSON/);
    expect(() => parseImport('[]')).toThrow();
    expect(() => parseImport(bad((o) => { o.version = 2; }))).toThrow(/version/);
    expect(() => parseImport(bad((o) => { o.presets[0].content.fg = 'red'; }))).toThrow(/Preset 1/);
    expect(() => parseImport(bad((o) => { o.presets[0].content.kind = 'video'; }))).toThrow();
    expect(() => parseImport(bad((o) => { o.presets.push(o.presets[0]); }))).toThrow(/duplicate/);
    expect(() => parseImport(bad((o) => { o.settings.brightness = 11; }))).toThrow();
    expect(() => parseImport(bad((o) => { o.settings.width = 0; }))).toThrow();
    expect(() => parseImport(bad((o) => { o.presets[0] = { ...o.presets[0], content: { kind: 'image', dataUrl: 'http://x/y.png', fit: 'cover', bg: '#000000' } }; }))).toThrow();
  });
  it('rejects oversized input', () => expect(() => parseImport('x'.repeat(5 * 1024 * 1024))).toThrow(/too large/));
  it('round-trips QR profiles in the app backup and accepts older backups without them', () => {
    const qrProfiles = {
      selectedId: '1',
      profiles: [{
        id: '1', note: 'MS AI Tour',
        pattern: String.raw`^[^^]*\^(?<firstname>[^^]+)\^(?<lastname>[^^]+)\^(?<company>[^^]+)\^`,
        template: 'Hello {firstname} {lastname} from {company}!',
      }],
    };
    expect(parseImport(exportJson(DEFAULT_SETTINGS, [preset], qrProfiles)).qrProfiles).toEqual(qrProfiles);
    const legacy = JSON.parse(exportJson(DEFAULT_SETTINGS, [preset]));
    delete legacy.qrProfiles;
    expect(parseImport(JSON.stringify(legacy)).qrProfiles).toEqual({ selectedId: null, profiles: [] });
    const malformed = JSON.parse(exportJson(DEFAULT_SETTINGS, [preset], qrProfiles));
    malformed.qrProfiles.profiles.push(qrProfiles.profiles[0]);
    expect(() => parseImport(JSON.stringify(malformed))).toThrow(/slots must be unique/);
  });

  const groupPreset: Preset = { id: 'g1', name: 'Party', updatedAt: 2, groups: structuredClone(DEFAULT_APPROACH.tiers) };
  it('round-trips group content presets next to content presets', () => {
    const out = parseImport(exportJson(DEFAULT_SETTINGS, [preset, groupPreset]));
    expect(out.presets).toEqual([preset, groupPreset]);
    expect(isGroupPreset(out.presets[1]!)).toBe(true);
    expect(isGroupPreset(out.presets[0]!)).toBe(false);
  });
  it('round-trips the solo Create option and rejects invalid sources', () => {
    const p = { id: 'create-solo', name: 'Create solo', updatedAt: 3, groups: structuredClone(DEFAULT_APPROACH.tiers) };
    p.groups.solo.useCreate = true;
    expect(parseImport(exportJson(DEFAULT_SETTINGS, [p])).presets).toEqual([p]);
    const raw = JSON.parse(exportJson(DEFAULT_SETTINGS, [p]));
    raw.presets[0].groups.solo.useCreate = 'yes';
    expect(() => parseImport(JSON.stringify(raw))).toThrow(/useCreate/);
    raw.presets[0].groups.solo.useCreate = true;
    raw.presets[0].groups.pair.useCreate = true;
    expect(() => parseImport(JSON.stringify(raw))).toThrow(/useCreate/);
  });
  it('rejects malformed group content', () => {
    const g = JSON.parse(exportJson(DEFAULT_SETTINGS, [groupPreset]));
    const badG = (mut: (o: any) => void) => { const o = structuredClone(g); mut(o); return JSON.stringify(o); };
    expect(() => parseImport(badG((o) => { delete o.presets[0].groups.pair; }))).toThrow(/Preset 1: missing group pair/);
    expect(() => parseImport(badG((o) => { o.presets[0].groups.solo.mode = 'blink'; }))).toThrow(/mode/);
    expect(() => parseImport(badG((o) => { o.presets[0].groups.upTo4.fg = 'red'; }))).toThrow(/fg/);
    expect(() => parseImport(badG((o) => { o.presets[0].groups.upTo8.speed = 11; }))).toThrow(/speed/);
    expect(() => parseImport(badG((o) => { o.presets[0].groups.moreThan8.text = 'x'.repeat(121); }))).toThrow(/text/);
    expect(() => parseImport(badG((o) => { o.presets[0].content = { kind: 'solid', color: '#000000' }; }))).toThrow(/both/);
  });
});

import { encodeGif } from '../src/render/gif';
import { buildGifStream } from '../src/protocol/framing';
import { crc32c } from '../src/protocol/crc32c';

describe('gif marquee', () => {
  const frame = (on: number) => {
    const pixels = new Uint8Array(32 * 16 * 3);
    pixels.set([255, 255, 255], on * 3);
    return { width: 32, height: 16, pixels };
  };
  it('encodes a looping GIF89a and wraps it in a stream', () => {
    const gif = encodeGif([frame(0), frame(5)], 60);
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe('GIF89a');
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(gif[6]! | (gif[7]! << 8)).toBe(32);
    const s = buildGifStream(gif, 32, 16);
    expect(s.bytes.length).toBe(24 + 22 + gif.length);
  });
});

describe('gif encoder extras', () => {
  it('nonce changes the bytes only in unused palette entries', () => {
    const f = (on: number) => {
      const pixels = new Uint8Array(32 * 16 * 3);
      pixels.set([255, 208, 0], on * 3);
      return { width: 32, height: 16, pixels };
    };
    const frames = [f(0), f(7)];
    const a = encodeGif(frames, 40, { nonce: Uint8Array.of(1, 2, 3, 4, 5, 6) });
    const b = encodeGif(frames, 40, { nonce: Uint8Array.of(9, 8, 7, 6, 5, 4) });
    expect(a.length).toBe(b.length);
    const diff = [...a.keys()].filter((i) => a[i] !== b[i]);
    // Header(13) + 2 used colours (6 bytes): the nonce lives at bytes 19..24 of the 4-entry table.
    expect(a[10]! & 7).toBe(1);
    expect(Math.min(...diff)).toBeGreaterThanOrEqual(19);
    expect(Math.max(...diff)).toBeLessThan(25);
    expect([...a.subarray(13, 19)]).toEqual([255, 208, 0, 0, 0, 0]);
    expect(crc32c(a)).not.toBe(crc32c(b));
  });
  it('quantizes frames with more than 256 colours and accepts per-frame delays', () => {
    const pixels = new Uint8Array(32 * 16 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) & 255;
    const f = { width: 32, height: 16, pixels };
    const gif = encodeGif([f, f], [40, 80]);
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe('GIF89a');
  });
});

import { splitRuns } from '../src/render/segments';

describe('splitRuns', () => {
  it('separates ASCII, emoji clusters and unsupported characters', () => {
    const r = splitRuns('Hi 👍🏽 ❤️ é');
    expect(r.runs.map((x) => x.kind)).toEqual(['text', 'emoji', 'text', 'emoji', 'text']);
    expect(r.runs[1]!.text).toBe('👍🏽');
    expect(r.unsupported).toEqual(['é']);
  });
});
