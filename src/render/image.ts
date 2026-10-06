import type { RgbImage } from '../protocol/framing';
import { rgbaToRgb, type Rgb } from './matrix';

export const IMPORT_LIMITS = { maxFileBytes: 8 * 1024 * 1024, maxDimension: 8192, maxPixels: 25_000_000 } as const;
export type Fit = 'contain' | 'cover' | 'stretch';

export function checkFileLimits(file: { size: number; type: string }): void {
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Only PNG and JPEG images are supported.');
  if (file.size > IMPORT_LIMITS.maxFileBytes) throw new Error('Image file is too large (limit 8 MB).');
}

export function checkDecodedLimits(w: number, h: number): void {
  if (w < 1 || h < 1 || w > IMPORT_LIMITS.maxDimension || h > IMPORT_LIMITS.maxDimension || w * h > IMPORT_LIMITS.maxPixels)
    throw new Error(`Image dimensions ${w}x${h} are outside the supported limits.`);
}

/** Destination rectangle for drawing a (sw x sh) source into a (dw x dh) target. */
export function fitRect(sw: number, sh: number, dw: number, dh: number, fit: Fit) {
  if (fit === 'stretch') return { x: 0, y: 0, w: dw, h: dh };
  const k = fit === 'contain' ? Math.min(dw / sw, dh / sh) : Math.max(dw / sw, dh / sh);
  const w = sw * k, h = sh * k;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

/** Decode locally, check limits BEFORE any rendering work, then scale onto the matrix. */
export async function imageToMatrix(blob: Blob, width: number, height: number, fit: Fit, bg: Rgb): Promise<RgbImage> {
  checkFileLimits(blob);
  const bmp = await createImageBitmap(blob);
  try {
    checkDecodedLimits(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const r = fitRect(bmp.width, bmp.height, width, height, fit);
    ctx.drawImage(bmp, r.x, r.y, r.w, r.h);
    return { width, height, pixels: rgbaToRgb(ctx.getImageData(0, 0, width, height).data, bg) };
  } finally {
    bmp.close();
  }
}

/** Re-encode a source image to a bounded PNG data URL so presets stay small. */
export async function shrinkForStorage(blob: Blob, maxSide = 256): Promise<string> {
  checkFileLimits(blob);
  const bmp = await createImageBitmap(blob);
  try {
    checkDecodedLimits(bmp.width, bmp.height);
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally {
    bmp.close();
  }
}
