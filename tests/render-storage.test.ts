import { describe, expect, it } from 'vitest';
import { checkDecodedLimits, checkFileLimits, fitRect } from '../src/render/image';
import { cornerTest, rgbaToRgb, solid, transformImage } from '../src/render/matrix';
import { DEFAULT_SETTINGS, exportJson, parseImport, type Preset } from '../src/storage/presets';

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
});
