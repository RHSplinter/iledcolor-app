import type { RgbImage } from '../protocol/framing';

/** LZW as used by GIF (variable code width, deferred clear). */
function lzw(indices: Uint8Array, minCode: number): number[] {
  const clear = 1 << minCode, eoi = clear + 1;
  const out: number[] = [];
  let cur = 0, bits = 0;
  const emit = (code: number, width: number) => {
    cur |= code << bits; bits += width;
    while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; }
  };
  let dict = new Map<number, number>();
  let next = eoi + 1, width = minCode + 1;
  emit(clear, width);
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, width);
    if (next < 4096) {
      dict.set(key, next++);
      if (next - 1 === (1 << width) && width < 12) width++;
    } else {
      emit(clear, width);
      dict = new Map(); next = eoi + 1; width = minCode + 1;
    }
    prefix = k;
  }
  emit(prefix, width);
  emit(eoi, width);
  if (bits > 0) out.push(cur & 255);
  return out;
}

function subBlocks(data: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const n = Math.min(255, data.length - i);
    out.push(n, ...data.slice(i, i + n));
  }
  out.push(0);
  return out;
}

/**
 * Encode frames as a looping GIF89a with one global palette built from the exact colors used.
 * Throws if frames differ in size or use more than 256 colors (text marquees use two).
 */
export function encodeGif(frames: RgbImage[], delayMs: number | number[]): Uint8Array {
  try {
    return encodeExact(frames, delayMs);
  } catch (e) {
    if (!(e instanceof RangeError) || !/256 colors/.test(e.message)) throw e;
    return encodeExact(frames.map(quantize), delayMs);
  }
}

/** Snap to a fixed 6x7x6 colour cube (252 colours) so photographic frames fit a GIF palette. */
function quantize(f: RgbImage): RgbImage {
  const px = new Uint8Array(f.pixels.length);
  const lv = [5, 6, 5];
  for (let i = 0; i < px.length; i++) px[i] = Math.round((Math.round((f.pixels[i]! / 255) * lv[i % 3]!) / lv[i % 3]!) * 255);
  return { ...f, pixels: px };
}

function encodeExact(frames: RgbImage[], delayMs: number | number[]): Uint8Array {
  if (!frames.length) throw new RangeError('no frames');
  const { width, height } = frames[0]!;
  const palette = new Map<number, number>();
  const indexed = frames.map((f) => {
    if (f.width !== width || f.height !== height) throw new RangeError('frame size mismatch');
    const idx = new Uint8Array(width * height);
    for (let i = 0; i < idx.length; i++) {
      const c = (f.pixels[i * 3]! << 16) | (f.pixels[i * 3 + 1]! << 8) | f.pixels[i * 3 + 2]!;
      let p = palette.get(c);
      if (p === undefined) {
        if (palette.size >= 256) throw new RangeError('GIF supports at most 256 colors');
        p = palette.size; palette.set(c, p);
      }
      idx[i] = p;
    }
    return idx;
  });
  let n = 1;
  while ((1 << n) < palette.size) n++;
  const minCode = Math.max(2, n);
  const bytes: number[] = [...'GIF89a'].map((c) => c.charCodeAt(0));
  bytes.push(width & 255, width >> 8, height & 255, height >> 8, 0x80 | ((n - 1) << 4) | (n - 1), 0, 0);
  const table = new Uint8Array(3 << n);
  for (const [c, p] of palette) table.set([(c >> 16) & 255, (c >> 8) & 255, c & 255], p * 3);
  bytes.push(...table);
  bytes.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0); // loop forever
  for (const [fi, idx] of indexed.entries()) {
    const ms = Array.isArray(delayMs) ? delayMs[fi] ?? 100 : delayMs;
    const delay = Math.min(0xffff, Math.max(2, Math.round(ms / 10))); // centiseconds
    bytes.push(0x21, 0xf9, 4, 0x04, delay & 255, delay >> 8, 0, 0); // disposal 1, no transparency
    bytes.push(0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, minCode);
    bytes.push(...subBlocks(lzw(idx, minCode)));
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
