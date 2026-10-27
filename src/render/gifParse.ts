/**
 * Pure-JS GIF decoder used where WebCodecs `ImageDecoder` is unavailable (iOS WebKit, e.g. Bluefy).
 * Produces fully composited RGBA frames at the logical screen size, honouring transparency,
 * local palettes, interlacing and disposal methods.
 */
export interface GifParseLimits {
  maxFrames: number;
  checkSize?: (width: number, height: number) => void;
}

/** Receives the composited canvas (reused between calls; copy it to keep it) and the frame delay. */
export type GifFrameCallback = (rgba: Uint8ClampedArray, delayMs: number, width: number, height: number) => void;

function lzwDecode(data: Uint8Array, minCode: number, pixelCount: number): Uint8Array {
  if (minCode < 2 || minCode > 8) throw new Error('Invalid GIF: bad LZW code size.');
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCode, eoi = clear + 1;
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), length = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; length[i] = 1; }
  let width = minCode + 1, next = eoi + 1, prev = -1, pos = 0, cur = 0, bits = 0;
  for (let i = 0; i < data.length && pos < pixelCount; i++) {
    cur |= data[i]! << bits;
    bits += 8;
    while (bits >= width && pos < pixelCount) {
      const code = cur & ((1 << width) - 1);
      cur >>>= width;
      bits -= width;
      if (code === clear) { width = minCode + 1; next = eoi + 1; prev = -1; continue; }
      if (code === eoi) return out;
      if (prev < 0 ? code >= clear : code > next || (code === next && next >= 4096))
        throw new Error('Invalid GIF: corrupt image data.');
      if (prev >= 0 && next < 4096) {
        // When code === next (KwKwK), the new entry is the previous string plus its own first byte.
        prefix[next] = prev;
        suffix[next] = first[code < next ? code : prev]!;
        first[next] = first[prev]!;
        length[next] = length[prev]! + 1;
        next++;
        if (next === 1 << width && width < 12) width++;
      }
      const len = length[code]!;
      for (let c = code, o = pos + len - 1; c >= 0; c = prefix[c]!, o--)
        if (o < pixelCount) out[o] = suffix[c]!;
      pos += len;
      prev = code;
    }
  }
  return out; // truncated data: remaining pixels stay index 0, like browsers do
}

function deinterlace(indices: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(indices.length);
  let row = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const)
    for (let y = start; y < h; y += step) out.set(indices.subarray(row * w, ++row * w), y * w);
  return out;
}

/** Returns the number of frames passed to `onFrame`. */
export function parseGif(bytes: Uint8Array, limits: GifParseLimits, onFrame: GifFrameCallback): number {
  let p = 0;
  const need = (n: number) => { if (p + n > bytes.length) throw new Error('Invalid GIF: file is truncated.'); };
  const u8 = () => { need(1); return bytes[p++]!; };
  const u16 = () => { need(2); const v = bytes[p]! | (bytes[p + 1]! << 8); p += 2; return v; };
  const table = (flags: number) => { const n = 3 << ((flags & 7) + 1); need(n); const t = bytes.subarray(p, p + n); p += n; return t; };
  const blocks = () => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let n = u8(); n; n = u8()) { need(n); parts.push(bytes.subarray(p, p + n)); p += n; total += n; }
    const out = new Uint8Array(total);
    let o = 0;
    for (const part of parts) { out.set(part, o); o += part.length; }
    return out;
  };

  need(6);
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('Invalid GIF: missing GIF header.');
  p = 6;
  const width = u16(), height = u16(), flags = u8();
  p += 2; // background colour index and aspect ratio: browsers clear to transparent instead
  limits.checkSize?.(width, height);
  if (width < 1 || height < 1) throw new Error('Invalid GIF: empty canvas.');
  const globalTable = flags & 0x80 ? table(flags) : undefined;

  const canvas = new Uint8ClampedArray(width * height * 4);
  let count = 0;
  let gce = { disposal: 0, delayCs: 0, transparent: -1 };

  while (p < bytes.length) {
    const block = u8();
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = u8();
      const data = blocks();
      if (label === 0xf9 && data.length >= 4)
        gce = { disposal: (data[0]! >> 2) & 7, delayCs: data[1]! | (data[2]! << 8), transparent: data[0]! & 1 ? data[3]! : -1 };
      continue;
    }
    if (block !== 0x2c) throw new Error('Invalid GIF: unknown block.');
    if (count >= limits.maxFrames) throw new Error(`GIF has more than ${limits.maxFrames} frames; the limit is ${limits.maxFrames}.`);
    const fx = u16(), fy = u16(), fw = u16(), fh = u16(), fflags = u8();
    if (fw * fh > width * height) throw new Error('Invalid GIF: frame is larger than the image.');
    const palette = fflags & 0x80 ? table(fflags) : globalTable;
    const minCode = u8();
    const data = blocks();
    if (!palette) throw new Error('Invalid GIF: frame has no colour table.');
    let indices = lzwDecode(data, minCode, fw * fh);
    if (fflags & 0x40) indices = deinterlace(indices, fw, fh);

    const saved = gce.disposal === 3 ? canvas.slice() : undefined;
    for (let y = 0; y < fh; y++) {
      const cy = fy + y;
      if (cy >= height) break;
      for (let x = 0; x < fw; x++) {
        const cx = fx + x;
        if (cx >= width) break;
        const idx = indices[y * fw + x]!;
        if (idx === gce.transparent || idx * 3 + 2 >= palette.length) continue;
        const o = (cy * width + cx) * 4;
        canvas[o] = palette[idx * 3]!; canvas[o + 1] = palette[idx * 3 + 1]!; canvas[o + 2] = palette[idx * 3 + 2]!; canvas[o + 3] = 255;
      }
    }
    // Browsers treat 0-10 ms frame delays as 100 ms.
    onFrame(canvas, gce.delayCs <= 1 ? 100 : gce.delayCs * 10, width, height);
    count++;

    if (gce.disposal === 2) {
      for (let y = fy; y < Math.min(height, fy + fh); y++)
        canvas.fill(0, (y * width + fx) * 4, (y * width + Math.min(width, fx + fw)) * 4);
    } else if (saved) canvas.set(saved);
    gce = { disposal: 0, delayCs: 0, transparent: -1 };
  }
  if (!count) throw new Error('Invalid GIF: no frames.');
  return count;
}
