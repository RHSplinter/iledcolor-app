import type { RgbImage } from '../protocol/framing';
import { checkDecodedLimits, fitRect, IMPORT_LIMITS, type Fit } from './image';
import { rgbaToRgb, type Rgb } from './matrix';
import { parseGif } from './gifParse';

export const MAX_GIF_FRAMES = 150;
export const MAX_GIF_STORE_BYTES = 1024 * 1024;

/** Decode every frame of a GIF locally and scale each onto the matrix (WebCodecs, else a JS decoder). */
export async function gifToFrames(blob: Blob, width: number, height: number, fit: Fit, bg: Rgb): Promise<{ frames: RgbImage[]; delays: number[] }> {
  if (blob.size > IMPORT_LIMITS.maxFileBytes) throw new Error('GIF file is too large (limit 8 MB).');
  if (typeof ImageDecoder === 'undefined') return gifToFramesJs(blob, width, height, fit, bg);
  const decoder = new ImageDecoder({ data: blob.stream(), type: 'image/gif' });
  try {
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
    if (count > MAX_GIF_FRAMES) throw new Error(`GIF has ${count} frames; the limit is ${MAX_GIF_FRAMES}.`);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const frames: RgbImage[] = [], delays: number[] = [];
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      try {
        if (i === 0) checkDecodedLimits(image.displayWidth, image.displayHeight);
        ctx.clearRect(0, 0, width, height);
        const r = fitRect(image.displayWidth, image.displayHeight, width, height, fit);
        ctx.drawImage(image, r.x, r.y, r.w, r.h);
        frames.push({ width, height, pixels: rgbaToRgb(ctx.getImageData(0, 0, width, height).data, bg) });
        delays.push(Math.max(20, Math.round((image.duration ?? 100_000) / 1000)));
      } finally {
        image.close();
      }
    }
    return { frames, delays };
  } finally {
    decoder.close();
  }
}

async function gifToFramesJs(blob: Blob, width: number, height: number, fit: Fit, bg: Rgb): Promise<{ frames: RgbImage[]; delays: number[] }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const target = document.createElement('canvas');
  target.width = width;
  target.height = height;
  const ctx = target.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const source = document.createElement('canvas');
  let sctx: CanvasRenderingContext2D | undefined;
  const frames: RgbImage[] = [], delays: number[] = [];
  parseGif(bytes, { maxFrames: MAX_GIF_FRAMES, checkSize: checkDecodedLimits }, (rgba, delayMs, sw, sh) => {
    if (!sctx) {
      source.width = sw;
      source.height = sh;
      sctx = source.getContext('2d')!;
    }
    sctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), sw, sh), 0, 0);
    ctx.clearRect(0, 0, width, height);
    const r = fitRect(sw, sh, width, height, fit);
    ctx.drawImage(source, r.x, r.y, r.w, r.h);
    frames.push({ width, height, pixels: rgbaToRgb(ctx.getImageData(0, 0, width, height).data, bg) });
    delays.push(Math.max(20, delayMs));
  });
  return { frames, delays };
}
