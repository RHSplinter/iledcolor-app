import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/silkscreen/latin-400.css';
import '@fontsource/tiny5/latin-400.css';
import '@fontsource/dotgothic16/latin-400.css';
import '@fontsource/bitcount-prop-single/latin-400.css';
import type { RgbImage } from '../protocol/framing';
import type { Rgb } from './matrix';
import { splitRuns } from './segments';
import { sliceSpan, spanStep } from './span';
import { DEFAULT_TEXT_FONT, TEXT_FONTS, type TextFont } from './fonts';

let textFont: TextFont = DEFAULT_TEXT_FONT;
export const getTextFont = (): TextFont => textFont;
export function setTextFont(font: TextFont): void { textFont = font; }
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const EMOJI_GAP = 2;
/** Pixel-font glyphs cover printable ASCII; emoji are drawn in colour from the system emoji font. */
export { splitRuns } from './segments';

export async function ensureFont(): Promise<void> {
  await Promise.all(TEXT_FONTS.map((font) => document.fonts.load(`${font.size}px ${font.family}`)));
}

export interface TextRender { image: RgbImage; unsupported: string[]; clipped: boolean }

interface Glyph { width: number; top: number; height: number; mask: Uint8Array }
type StripToken = { kind: 'text'; glyph: Glyph; width: number } | { kind: 'emoji'; image: ImageData; width: number };

/** Trim side bearings after rasterization, keeping exactly one unlit column between glyphs. */
function rasterGlyph(char: string, family: string, size: number): Glyph {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * 3;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.font = `${size}px ${family}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  // Some pixel fonts have a fractional baseline offset even at their native size.
  const ascent = ctx.measureText('H').actualBoundingBoxAscent;
  ctx.fillText(char, size, size * 2 + ascent - Math.round(ascent));
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (data[(y * canvas.width + x) * 4 + 3]! < 128) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < left) return { width: Math.max(2, Math.round(size / 3)), top: 0, height: 0, mask: new Uint8Array() };
  const width = right - left + 1, height = bottom - top + 1;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    mask[y * width + x] = data[((y + top) * canvas.width + x + left) * 4 + 3]! >= 128 ? 1 : 0;
  return { width, height, top: top - size * 2, mask };
}

/** Emoji ink can be wider than the font size or advance, depending on the system font. */
function rasterEmoji(text: string, size: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const font = `${size}px ${EMOJI_FONT}`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const origin = 1 + Math.max(0, Math.ceil(metrics.actualBoundingBoxLeft));
  canvas.width = origin + Math.ceil(Math.max(size, metrics.width, metrics.actualBoundingBoxRight)) + 1;
  canvas.height = height;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, origin, Math.round(height / 2));
  const data = ctx.getImageData(0, 0, canvas.width, height).data;
  let left = canvas.width, right = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < canvas.width; x++) {
    if (!data[(y * canvas.width + x) * 4 + 3]) continue;
    left = Math.min(left, x); right = Math.max(right, x);
  }
  if (right < left) throw new Error(`Could not render emoji: ${text}`);
  return ctx.getImageData(left, 0, right - left + 1, height);
}

const PRINTABLE_ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const glyphCaches = new Map<TextFont, Map<string, Glyph>>();
/** Glyphs are reused only after the webfont has loaded; fallback-font rasters must not stick. */
function glyphCache(font: typeof TEXT_FONTS[number]): Map<string, Glyph> {
  if (!document.fonts.check(`${font.size}px ${font.family}`)) return new Map();
  let cache = glyphCaches.get(font.id);
  if (!cache) { cache = new Map(); glyphCaches.set(font.id, cache); }
  return cache;
}

/** One-line strip at natural width: hard-pixel ASCII text plus colour emoji. */
export function renderStrip(text: string, height: number, fg: Rgb, bg: Rgb): { strip: RgbImage; unsupported: string[] } {
  const { runs, unsupported } = splitRuns(text);
  const font = TEXT_FONTS.find((f) => f.id === textFont)!;
  const emojiPx = Math.max(8, height - 2);
  const glyphs = glyphCache(font);
  const glyphFor = (char: string) => {
    let glyph = glyphs.get(char);
    if (!glyph) { glyph = rasterGlyph(char, font.family, font.size); glyphs.set(char, glyph); }
    return glyph;
  };
  const tokens = runs.flatMap<StripToken>((r) => {
    if (r.kind === 'emoji') {
      const image = rasterEmoji(r.text, emojiPx, height);
      return [{ kind: 'emoji', image, width: image.width }];
    }
    return [...r.text].map((char) => ({ kind: 'text', glyph: glyphFor(char), width: glyphFor(char).width }));
  });
  // Centre the font's full ASCII extent so the baseline never moves between different texts.
  const reference = PRINTABLE_ASCII.map(glyphFor).filter((g) => g.height);
  const top = Math.min(...reference.map((g) => g.top));
  const bottom = Math.max(...reference.map((g) => g.top + g.height));
  const baseline = Math.floor((height - (bottom - top)) / 2) - top;
  // Emoji have soft edges and no fixed pixel grid, so give them a wider unlit gutter than letters.
  const gapAfter = (i: number) => (tokens[i]!.kind === 'emoji' || tokens[i + 1]?.kind === 'emoji' ? EMOJI_GAP : 1);
  const total = Math.max(1, tokens.reduce((n, t, i) => n + t.width + (i < tokens.length - 1 ? gapAfter(i) : 0), 0));
  const pixels = new Uint8Array(total * height * 3);
  for (let i = 0; i < total * height; i++) pixels.set(bg, i * 3);
  let x = 0;
  for (const [i, token] of tokens.entries()) {
    if (token.kind === 'text') {
      const g = token.glyph;
      for (let gy = 0; gy < g.height; gy++) for (let gx = 0; gx < g.width; gx++) {
        const y = baseline + g.top + gy;
        if (y >= 0 && y < height && g.mask[gy * g.width + gx]) pixels.set(fg, (y * total + x + gx) * 3);
      }
    } else {
      const { width, data } = token.image;
      for (let y = 0; y < height; y++) for (let ex = 0; ex < width; ex++) {
        const source = (y * width + ex) * 4, target = (y * total + x + ex) * 3;
        const alpha = data[source + 3]! / 255;
        for (let c = 0; c < 3; c++) pixels[target + c] = Math.round(data[source + c]! * alpha + bg[c]! * (1 - alpha));
      }
    }
    x += token.width + (i < tokens.length - 1 ? gapAfter(i) : 0);
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

/** Frames for cap `index` of a marquee spanning `total` caps side by side, plus the step used. */
export function renderSpanMarquee(text: string, width: number, height: number, total: number, index: number, fg: Rgb, bg: Rgb): MarqueeRender & { step: number } {
  const { strip, unsupported } = renderStrip(text, height, fg, bg);
  const step = spanStep(strip.width, width, total);
  return { frames: sliceSpan(strip, width, total, index, bg, step), unsupported, step };
}

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
