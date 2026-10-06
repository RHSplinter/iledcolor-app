import '@fontsource/press-start-2p/latin-400.css';
import type { RgbImage } from '../protocol/framing';
import type { Rgb } from './matrix';
import { splitRuns } from './segments';

export const FONT_FAMILY = '"Press Start 2P"';
export const FONT_PX = 8; // the font is designed on an 8px grid; other sizes blur
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
/** Pixel-font glyphs cover printable ASCII; emoji are drawn in colour from the system emoji font. */
export { splitRuns } from './segments';

export async function ensureFont(): Promise<void> {
  await document.fonts.load(`${FONT_PX}px ${FONT_FAMILY}`);
}

export interface TextRender { image: RgbImage; unsupported: string[]; clipped: boolean }

/** One-line strip at natural width: hard-pixel ASCII text plus colour emoji. */
function renderStrip(text: string, height: number, fg: Rgb, bg: Rgb): { strip: RgbImage; unsupported: string[] } {
  const { runs, unsupported } = splitRuns(text);
  const emojiPx = Math.max(8, height - 2);
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = `${FONT_PX}px ${FONT_FAMILY}`;
  const widths = runs.map((r) => (r.kind === 'emoji' ? emojiPx + 1 : Math.ceil(probe.measureText(r.text).width)));
  const total = Math.max(1, widths.reduce((a, b) => a + b, 0));
  const layer = () => {
    const c = document.createElement('canvas');
    c.width = total; c.height = height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.textBaseline = 'middle';
    return ctx;
  };
  const textCtx = layer(), emojiCtx = layer();
  textCtx.fillStyle = '#000';
  textCtx.fillRect(0, 0, total, height);
  textCtx.fillStyle = '#fff';
  let x = 0;
  runs.forEach((r, i) => {
    if (r.kind === 'text') { textCtx.font = `${FONT_PX}px ${FONT_FAMILY}`; textCtx.fillText(r.text, x, Math.round(height / 2)); }
    else { emojiCtx.font = `${emojiPx}px ${EMOJI_FONT}`; emojiCtx.fillText(r.text, x, Math.round(height / 2)); }
    x += widths[i]!;
  });
  const t = textCtx.getImageData(0, 0, total, height).data;
  const e = emojiCtx.getImageData(0, 0, total, height).data;
  const pixels = new Uint8Array(total * height * 3);
  for (let i = 0; i < total * height; i++) {
    const base = t[i * 4]! >= 128 ? fg : bg;
    const a = e[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) pixels[i * 3 + c] = Math.round(e[i * 4 + c]! * a + base[c]! * (1 - a));
  }
  return { strip: { width: total, height, pixels }, unsupported };
}

/** Single-line text rendered 1:1 onto the matrix, left-aligned; `clipped` when wider than the display. */
export function renderText(text: string, width: number, height: number, fg: Rgb, bg: Rgb): TextRender {
  const { strip, unsupported } = renderStrip(text, height, fg, bg);
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) pixels.set(bg, i * 3);
  const w = Math.min(width, strip.width);
  for (let y = 0; y < height; y++) pixels.set(strip.pixels.subarray(y * strip.width * 3, (y * strip.width + w) * 3), y * width * 3);
  return { image: { width, height, pixels }, unsupported, clipped: strip.width > width };
}

export interface MarqueeRender { frames: RgbImage[]; unsupported: string[] }

/** Frames of text scrolling in from the right and out to the left; the hat loops them as a GIF. */
export function renderMarquee(text: string, width: number, height: number, fg: Rgb, bg: Rgb, step = 2): MarqueeRender {
  const { strip, unsupported } = renderStrip(text, height, fg, bg);
  const stripW = strip.width;
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
