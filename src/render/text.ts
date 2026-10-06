import '@fontsource/press-start-2p/latin-400.css';
import type { RgbImage } from '../protocol/framing';
import type { Rgb } from './matrix';

export const FONT_FAMILY = '"Press Start 2P"';
export const FONT_PX = 8; // the font is designed on an 8px grid; other sizes blur
/** Glyphs the bundled font is verified to cover: printable ASCII. */
export function unsupportedChars(text: string): string[] {
  return [...new Set([...text].filter((ch) => ch.codePointAt(0)! < 0x20 || ch.codePointAt(0)! > 0x7e))];
}

export async function ensureFont(): Promise<void> {
  await document.fonts.load(`${FONT_PX}px ${FONT_FAMILY}`);
}

export interface TextRender { image: RgbImage; unsupported: string[]; clipped: boolean }

/** Single-line text rendered 1:1 onto the matrix with hard (thresholded) pixels. */
export function renderText(text: string, width: number, height: number, fg: Rgb, bg: Rgb, scale = 1): TextRender {
  const unsupported = unsupportedChars(text);
  const shown = [...text].filter((c) => !unsupported.includes(c)).join('');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.font = `${FONT_PX * scale}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  const measured = ctx.measureText(shown).width;
  ctx.fillText(shown, 0, Math.round(height / 2));
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) pixels.set(rgba[i * 4]! >= 128 ? fg : bg, i * 3);
  return { image: { width, height, pixels }, unsupported, clipped: measured > width };
}

export interface MarqueeRender { frames: RgbImage[]; unsupported: string[] }

/** Frames of text scrolling in from the right and out to the left; the hat loops them as a GIF. */
export function renderMarquee(text: string, width: number, height: number, fg: Rgb, bg: Rgb, step = 2): MarqueeRender {
  const unsupported = unsupportedChars(text);
  const shown = [...text].filter((c) => !unsupported.includes(c)).join('');
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = `${FONT_PX}px ${FONT_FAMILY}`;
  const stripW = Math.max(1, Math.ceil(probe.measureText(shown).width));
  const strip = renderText(shown, stripW, height, fg, bg).image;
  const frames: RgbImage[] = [];
  for (let shift = 0; shift < stripW + width; shift += step) {
    const pixels = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) pixels.set(bg, i * 3);
    for (let x = 0; x < width; x++) {
      const sx = x + shift - width;
      if (sx < 0 || sx >= stripW) continue;
      for (let y = 0; y < height; y++)
        pixels.set(strip.pixels.subarray((y * stripW + sx) * 3, (y * stripW + sx) * 3 + 3), (y * width + x) * 3);
    }
    frames.push({ width, height, pixels });
  }
  return { frames, unsupported };
}
