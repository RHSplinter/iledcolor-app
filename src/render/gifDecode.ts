import type { RgbImage } from '../protocol/framing';
import { checkDecodedLimits, fitRect, IMPORT_LIMITS, type Fit } from './image';
import { rgbaToRgb, type Rgb } from './matrix';

export const MAX_GIF_FRAMES = 150;
export const MAX_GIF_STORE_BYTES = 1024 * 1024;

/** Decode every frame of a GIF locally (WebCodecs) and scale each onto the matrix. */
export async function gifToFrames(blob: Blob, width: number, height: number, fit: Fit, bg: Rgb): Promise<{ frames: RgbImage[]; delays: number[] }> {
  if (blob.size > IMPORT_LIMITS.maxFileBytes) throw new Error('GIF file is too large (limit 8 MB).');
  if (typeof ImageDecoder === 'undefined') throw new Error('This browser cannot decode GIFs (needs Chrome with WebCodecs).');
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
