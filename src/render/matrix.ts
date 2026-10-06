import type { RgbImage } from '../protocol/framing';

export type Rotation = 0 | 90 | 180 | 270;
export interface Transform { rotation: Rotation; mirrorH: boolean; mirrorV: boolean }
export const NO_TRANSFORM: Transform = { rotation: 0, mirrorH: false, mirrorV: false };

export type Rgb = [number, number, number];

export function parseHexColor(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new RangeError(`invalid color ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function solid(width: number, height: number, [r, g, b]: Rgb): RgbImage {
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) pixels.set([r, g, b], i * 3);
  return { width, height, pixels };
}

/** Composite RGBA onto an opaque background, producing packed RGB. */
export function rgbaToRgb(rgba: Uint8ClampedArray | Uint8Array, bg: Rgb): Uint8Array {
  const n = rgba.length / 4;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(rgba[i * 4 + c]! * a + bg[c]! * (1 - a));
  }
  return out;
}

/** Apply mirror (before) then rotation (clockwise). Rotating 90/270 swaps dimensions. */
export function transformImage(img: RgbImage, t: Transform): RgbImage {
  const { width: w, height: h, pixels: src } = img;
  const swap = t.rotation === 90 || t.rotation === 270;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8Array(ow * oh * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = t.mirrorH ? w - 1 - x : x;
      const sy = t.mirrorV ? h - 1 - y : y;
      let dx = x, dy = y;
      if (t.rotation === 90) { dx = h - 1 - y; dy = x; }
      else if (t.rotation === 180) { dx = w - 1 - x; dy = h - 1 - y; }
      else if (t.rotation === 270) { dx = y; dy = w - 1 - x; }
      const s = (sy * w + sx) * 3;
      out.set(src.subarray(s, s + 3), (dy * ow + dx) * 3);
    }
  }
  return { width: ow, height: oh, pixels: out };
}

/** Asymmetric corner pattern for orientation/RGB-order checks: R top-left, G top-right, B bottom-left, white bottom-right. */
export function cornerTest(width: number, height: number): RgbImage {
  const img = solid(width, height, [0, 0, 0]);
  const put = (x: number, y: number, c: Rgb) => img.pixels.set(c, (y * width + x) * 3);
  put(0, 0, [255, 0, 0]);
  put(width - 1, 0, [0, 255, 0]);
  put(0, height - 1, [0, 0, 255]);
  put(width - 1, height - 1, [255, 255, 255]);
  put(1, 0, [255, 0, 0]); // double the red corner so it is distinguishable from the others
  return img;
}

/** Nearest-neighbour enlarged preview onto a canvas, drawn as round-ish LED dots. */
export function drawPreview(canvas: HTMLCanvasElement, img: RgbImage): void {
  const scale = Math.max(1, Math.floor(Math.min(320 / img.width, 320 / img.height)));
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const s = (Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 3;
      const d = (y * canvas.width + x) * 4;
      data.data[d] = img.pixels[s]!; data.data[d + 1] = img.pixels[s + 1]!; data.data[d + 2] = img.pixels[s + 2]!;
      data.data[d + 3] = 255;
    }
  }
  ctx.putImageData(data, 0, 0);
  canvas.style.imageRendering = 'pixelated';
}
