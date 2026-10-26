import type { RgbImage } from '../protocol/framing';
import { solid, type Rgb } from '../render/matrix';
import { sliceSpan } from '../render/span';
import { splitRuns } from '../render/segments';
import { quantizeGifFrame } from '../render/gif';
import { isTextFont, type TextFont } from '../render/fonts';

/** `font` is the caption font; `null` follows the Settings LED text font. Fields absent in older files stay absent. */
export interface GitHubSettings { handle: string; prefix?: string; postfix?: string; speed?: number; font?: TextFont | null }
export const DEFAULT_GITHUB_PREFIX = '2026 contributions by {handle}: ';
export const DEFAULT_GITHUB_POSTFIX = '\u{1f389}\u{1f389}';
export const MAX_GITHUB_CAPTION_LENGTH = 200;
export interface Contribution { date: string; count: number; level: number }
/** A loaded graph kept with presets so they replay offline; `asOf` is the UTC date it was loaded. */
export interface GitHubGraph { asOf: string; days: Contribution[] }
const DAY = 86400000;
// Green channel only: GitHub's mixed palette contains blue that dominates on the hat's LEDs.
const COLORS: Rgb[] = [[0, 8, 0], [0, 48, 0], [0, 100, 0], [0, 170, 0], [0, 255, 0]];

export function validateGitHubSettings(raw: unknown): GitHubSettings {
  if (typeof raw !== 'object' || raw === null || !('handle' in raw) || typeof raw.handle !== 'string'
    || (raw.handle !== '' && !/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(raw.handle))) {
    throw new Error('Enter a valid GitHub handle (up to 39 letters, numbers or single hyphens; no @).');
  }
  const caption = (key: 'prefix' | 'postfix', value: unknown): string => {
    if (typeof value !== 'string' || value.length > MAX_GITHUB_CAPTION_LENGTH) {
      throw new Error(`GitHub ${key} must be text of at most ${MAX_GITHUB_CAPTION_LENGTH} characters.`);
    }
    if (splitRuns(value).unsupported.length) throw new Error(`GitHub ${key} supports printable ASCII text and emoji only.`);
    return value;
  };
  // Missing fields in older files are intentionally not replaced by defaults.
  if ('speed' in raw && (typeof raw.speed !== 'number' || !Number.isInteger(raw.speed) || raw.speed < 1 || raw.speed > 10)) {
    throw new Error('GitHub scroll speed must be an integer from 1 to 10.');
  }
  if ('font' in raw && raw.font !== null && !isTextFont(raw.font)) throw new Error('Invalid GitHub caption font.');
  return {
    handle: raw.handle,
    ...('prefix' in raw ? { prefix: caption('prefix', raw.prefix) } : {}),
    ...('postfix' in raw ? { postfix: caption('postfix', raw.postfix) } : {}),
    ...('speed' in raw ? { speed: raw.speed as number } : {}),
    ...('font' in raw ? { font: raw.font as TextFont | null } : {}),
  };
}

export function formatGitHubCaption(text: string, handle: string): string {
  return text.replaceAll('{handle}', handle);
}

export function parseContributions(raw: unknown): Contribution[] {
  if (typeof raw !== 'object' || raw === null || !('contributions' in raw)
    || !Array.isArray(raw.contributions) || !raw.contributions.length || raw.contributions.length > 372) {
    throw new Error('The contribution service returned invalid data.');
  }
  const seen = new Set<string>();
  return raw.contributions.map((day: unknown) => {
    if (typeof day !== 'object' || day === null || !('date' in day) || typeof day.date !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(Date.parse(day.date))
      || new Date(day.date).toISOString().slice(0, 10) !== day.date || seen.has(day.date)
      || !('count' in day) || typeof day.count !== 'number' || !Number.isSafeInteger(day.count) || day.count < 0
      || !('level' in day) || typeof day.level !== 'number' || !Number.isInteger(day.level) || day.level < 0 || day.level > 4) {
      throw new Error('The contribution service returned invalid daily contributions.');
    }
    seen.add(day.date);
    return { date: day.date, count: day.count, level: day.level };
  });
}

export function validateGitHubGraph(raw: unknown): GitHubGraph {
  if (typeof raw !== 'object' || raw === null || !('asOf' in raw) || typeof raw.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.asOf)
    || !Number.isFinite(Date.parse(raw.asOf)) || new Date(raw.asOf).toISOString().slice(0, 10) !== raw.asOf) {
    throw new Error('Invalid GitHub graph date.');
  }
  if (!('days' in raw)) throw new Error('Invalid GitHub graph.');
  try { return { asOf: raw.asOf, days: parseContributions({ contributions: raw.days }) }; }
  catch { throw new Error('Invalid GitHub graph.'); }
}

/** The moment a stored graph is drawn for, so replaying it later keeps the same 53 weeks. */
export const graphDate = (asOf: string): Date => new Date(`${asOf}T12:00:00Z`);

export async function fetchContributions(handle: string, signal?: AbortSignal): Promise<Contribution[]> {
  validateGitHubSettings({ handle });
  if (!handle) throw new Error('Enter a GitHub handle first.');
  const response = await fetch(`https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(handle)}?y=last`, {
    signal, credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(response.status === 404 ? 'GitHub user not found.'
    : response.status === 429 ? 'Contribution service rate limit reached. Try again later.'
    : `Contribution service failed (HTTP ${response.status}). Try again later.`);
  return parseContributions(await response.json());
}

export const YEAR_WEEKS = 53;

/** Full-year strip as tall as the display: Sunday at the top, oldest week on the left; future days remain black. */
export function renderContributionStrip(days: Contribution[], height: number, now = new Date()): RgbImage {
  const cell = Math.min(2, Math.floor(height / 7));
  if (cell < 1) throw new Error('The display is too small for a contribution graph.');
  const width = YEAR_WEEKS * cell;
  const image = solid(width, height, [0, 0, 0]);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = today - (now.getUTCDay() + (YEAR_WEEKS - 1) * 7) * DAY;
  const byDate = new Map(days.map((day) => [day.date, day]));
  const ox = 0, oy = Math.floor((height - 7 * cell) / 2);
  for (let week = 0; week < YEAR_WEEKS; week++) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const time = start + (week * 7 + weekday) * DAY;
      if (time > today) continue;
      const day = byDate.get(new Date(time).toISOString().slice(0, 10));
      // Missing historical data stays black rather than claiming zero contributions.
      if (!day) continue;
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        image.pixels.set(COLORS[day.level]!, ((oy + weekday * cell + y) * width + ox + week * cell + x) * 3);
      }
    }
  }
  return image;
}

/** The strip enters from the right and leaves on the left, like text marquees. */
export function renderContributionMarquee(
  days: Contribution[], width: number, height: number, now = new Date(), step = 2,
  caption?: { before: RgbImage; after: RgbImage },
): RgbImage[] {
  const graph = renderContributionStrip(days, height, now);
  // The 252-color caption cube plus the graph's three off-cube greens fits in 255 entries.
  const parts = caption ? [quantizeGifFrame(caption.before), graph, quantizeGifFrame(caption.after)] : [graph];
  const strip = solid(parts.reduce((sum, part) => sum + part.width, 0), height, [0, 0, 0]);
  let offset = 0;
  for (const part of parts) {
    if (part.height !== height) throw new Error('Contribution caption height must match the graph.');
    for (let y = 0; y < height; y++) {
      strip.pixels.set(part.pixels.subarray(y * part.width * 3, (y + 1) * part.width * 3), (y * strip.width + offset) * 3);
    }
    offset += part.width;
  }
  return sliceSpan(strip, width, 1, 0, [0, 0, 0], step);
}
