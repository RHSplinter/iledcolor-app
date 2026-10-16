import type { RgbImage } from '../protocol/framing';
import type { Rgb } from './matrix';

/** Upper bound on frames per cap so the looping GIF stays well below the 64 KB stream limit. */
export const MAX_SPAN_FRAMES = 120;

/** Pixel step that keeps a scroll of `distance` px within MAX_SPAN_FRAMES. */
export function spanStep(stripWidth: number, segWidth: number, total: number, minStep = 2): number {
  const distance = stripWidth + segWidth * total;
  return Math.max(minStep, Math.ceil(distance / MAX_SPAN_FRAMES));
}

/** Frame delay as stored in a GIF (whole centiseconds, ≥ 20 ms), so the loop period is exact. */
export function gifDelayMs(ms: number): number {
  return Math.max(20, Math.round(ms / 10) * 10);
}

/**
 * Milliseconds until the next wall-clock multiple of `periodMs`. Caps of a spanning marquee
 * (on this or other phones) start their loop on these shared boundaries so their slices stay in step.
 */
export function msUntilLoopStart(now: number, periodMs: number): number {
  if (!(periodMs > 0)) return 0;
  const r = now % periodMs;
  return r === 0 ? 0 : periodMs - r;
}

/**
 * One marquee scrolling across `total` displays placed side by side. Returns the frames of
 * display `index` (0 = leftmost). Every display gets the same number of frames and the same
 * timing, so caps started together stay in step and the text flows from one cap to the next.
 */
export function sliceSpan(strip: RgbImage, segWidth: number, total: number, index: number, bg: Rgb, step: number): RgbImage[] {
  if (index < 0 || index >= total) throw new Error('span index out of range');
  const h = strip.height;
  const wide = segWidth * total;
  const frames: RgbImage[] = [];
  for (let shift = 0; shift < strip.width + wide; shift += step) {
    const pixels = new Uint8Array(segWidth * h * 3);
    for (let i = 0; i < segWidth * h; i++) pixels.set(bg, i * 3);
    for (let x = 0; x < segWidth; x++) {
      const sx = index * segWidth + x + shift - wide; // text enters at the right edge of the last cap
      if (sx < 0 || sx >= strip.width) continue;
      for (let y = 0; y < h; y++)
        pixels.set(strip.pixels.subarray((y * strip.width + sx) * 3, (y * strip.width + sx) * 3 + 3), (y * segWidth + x) * 3);
    }
    frames.push({ width: segWidth, height: h, pixels });
  }
  return frames;
}
