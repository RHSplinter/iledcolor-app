import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeGif } from '../src/render/gif';
import { parseGif } from '../src/render/gifParse';
import type { RgbImage } from '../src/protocol/framing';

type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0], GREEN: Rgb = [0, 255, 0], BLUE: Rgb = [0, 0, 255];

function image(width: number, height: number, color: (x: number, y: number) => Rgb): RgbImage {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(color(x, y), (y * width + x) * 3);
  return { width, height, pixels };
}

function decode(bytes: Uint8Array, maxFrames = 150) {
  const frames: Uint8ClampedArray[] = [], delays: number[] = [];
  let size = [0, 0];
  parseGif(bytes, { maxFrames }, (rgba, delay, w, h) => { frames.push(rgba.slice()); delays.push(delay); size = [w, h]; });
  return { frames, delays, size };
}

const rgbOf = (rgba: Uint8ClampedArray) => Array.from(rgba.filter((_, i) => i % 4 !== 3));
const pixel = (rgba: Uint8ClampedArray, width: number, x: number, y: number) => Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));

/** Offsets of each frame's graphic control extension in an `encodeGif` result. */
function gceOffsets(gif: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < gif.length - 9; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 4 && gif[i + 8] === 0x2c) out.push(i);
  return out;
}

describe('JS GIF decoder', () => {
  it('round-trips many colours, dictionary resets and per-frame delays', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    const palette = Array.from({ length: 256 }, (_, i): Rgb => [i, (i * 37) & 255, (i * 91) & 255]);
    const frames = [0, 1, 2].map(() => image(64, 64, () => palette[rand()]!));
    const { frames: out, delays, size } = decode(encodeGif(frames, [50, 120, 300]));
    expect(size).toEqual([64, 64]);
    expect(out.map(rgbOf)).toEqual(frames.map((f) => Array.from(f.pixels)));
    expect(delays).toEqual([50, 120, 300]);
  });

  it('decodes solid runs (KwKwK codes) and maps zero delays to 100 ms', () => {
    const frames = [image(32, 16, () => RED), image(32, 16, (x) => (x < 16 ? GREEN : BLUE))];
    const gif = encodeGif(frames, 100);
    for (const o of gceOffsets(gif)) { gif[o + 4] = 0; gif[o + 5] = 0; }
    const { frames: out, delays } = decode(gif);
    expect(out.map(rgbOf)).toEqual(frames.map((f) => Array.from(f.pixels)));
    expect(delays).toEqual([100, 100]);
  });

  // Palette order: green 0, red 1, blue 2. Frame 2 makes blue transparent; frame 3 is fully transparent.
  const layered = (disposal: number) => {
    const gif = encodeGif([image(4, 1, () => GREEN), image(4, 1, (x) => (x < 2 ? RED : BLUE)), image(4, 1, () => BLUE)], 100);
    const [, second, third] = gceOffsets(gif);
    gif[second! + 3] = (disposal << 2) | 1; gif[second! + 6] = 2;
    gif[third! + 3] = (1 << 2) | 1; gif[third! + 6] = 2;
    return decode(gif).frames;
  };

  it('shows the previous frame through transparent pixels', () => {
    const [, second] = layered(1);
    expect(pixel(second!, 4, 0, 0)).toEqual([...RED, 255]);
    expect(pixel(second!, 4, 3, 0)).toEqual([...GREEN, 255]);
  });

  it.each([
    [1, [RED, RED, GREEN, GREEN].map((c) => [...c, 255])],
    [2, Array.from({ length: 4 }, () => [0, 0, 0, 0])],
    [3, Array.from({ length: 4 }, () => [...GREEN, 255])],
  ])('applies disposal method %i before the next frame', (disposal, expected) => {
    const third = layered(disposal)[2]!;
    expect([0, 1, 2, 3].map((x) => pixel(third, 4, x, 0))).toEqual(expected);
  });

  it('de-interlaces rows', () => {
    const rows = 10;
    const frame = image(3, rows, (_, y) => [y * 20, 0, 0]);
    const order = [0, 8, 4, 2, 6, 1, 3, 5, 7, 9];
    const stored = image(3, rows, (_, y) => [order[y]! * 20, 0, 0]);
    const gif = encodeGif([stored], 100);
    gif[gceOffsets(gif)[0]! + 8 + 9] = 0x40;
    expect(rgbOf(decode(gif).frames[0]!)).toEqual(Array.from(frame.pixels));
  });

  it.each(['party-popper.gif', 'copilot-head-blinking.gif'])('decodes the bundled %s animation', (name) => {
    const { frames, delays, size } = decode(new Uint8Array(readFileSync(join('src', 'assets', 'presets', name))));
    expect(size[0]).toBeGreaterThan(0);
    expect(frames.length).toBeGreaterThan(1);
    expect(delays.every((d) => d >= 20)).toBe(true);
    expect(new Set(frames.map((f) => f.join())).size).toBeGreaterThan(1);
  });

  it.each([
    ['rainbow.gif', [32, 18], 15],
    ['nijan-cat.gif', [32, 19], 12],
    ['star.gif', [32, 32], 60],
  ] as const)('decodes the original %s animation', (name, dimensions, frameCount) => {
    const { frames, delays, size } = decode(new Uint8Array(readFileSync(join('src', 'assets', 'presets', name))));
    expect(size).toEqual(dimensions);
    expect(frames).toHaveLength(frameCount);
    expect(delays.every((delay) => delay >= 20)).toBe(true);
    expect(new Set(frames.map((f) => f.join())).size).toBeGreaterThan(1);
  });

  it('rejects invalid, truncated and oversized GIFs', () => {
    const gif = encodeGif([image(4, 4, () => RED), image(4, 4, () => BLUE)], 100);
    expect(() => decode(new TextEncoder().encode('PNG not a gif'))).toThrow(/header/);
    expect(() => decode(gif.subarray(0, 20))).toThrow(/truncated/);
    expect(() => decode(gif, 1)).toThrow(/limit is 1/);
    expect(() => parseGif(gif, { maxFrames: 10, checkSize: () => { throw new Error('too big'); } }, () => undefined)).toThrow('too big');
    const bad = gif.slice();
    bad[gceOffsets(bad)[0]! + 8 + 5] = 0xff; // frame wider than the logical screen
    expect(() => decode(bad)).toThrow(/larger than the image/);
  });
});
