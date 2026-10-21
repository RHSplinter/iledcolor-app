import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GITHUB_POSTFIX, DEFAULT_GITHUB_PREFIX, MAX_GITHUB_CAPTION_LENGTH, fetchContributions, formatGitHubCaption,
  parseContributions, renderContributionMarquee, renderContributionStrip, validateGitHubSettings,
} from '../src/github/contributions';
import { buildGifStream, MAX_STREAM_BYTES, type RgbImage } from '../src/protocol/framing';
import { encodeGif, gifNonce } from '../src/render/gif';
import { MAX_GIF_FRAMES } from '../src/render/gifDecode';
import { solid, transformImage } from '../src/render/matrix';

afterEach(() => vi.unstubAllGlobals());

describe('GitHub contributions', () => {
  it('validates handles, including an empty saved editor, without allowing URLs or consecutive hyphens', () => {
    for (const handle of ['', 'octocat', 'Fokko-Veegens', 'a'.repeat(39)]) {
      expect(validateGitHubSettings({ handle })).toEqual({ handle });
    }
    for (const handle of ['@octocat', '-a', 'a-', 'a--b', 'a b', 'a/b', 'a'.repeat(40), 12, null]) {
      expect(() => validateGitHubSettings({ handle })).toThrow(/valid GitHub handle/);
    }
    expect(() => validateGitHubSettings(null)).toThrow();
  });

  it('keeps the existing captions as defaults and expands each handle placeholder without trimming', () => {
    expect(formatGitHubCaption(DEFAULT_GITHUB_PREFIX, 'octocat')).toBe('2026 contributions by octocat: ');
    expect(DEFAULT_GITHUB_POSTFIX).toBe('\u{1f389}\u{1f389}');
    expect(formatGitHubCaption(' {handle} / {handle} ', 'A-b')).toBe(' A-b / A-b ');
    expect(formatGitHubCaption('', 'octocat')).toBe('');
  });

  it('validates captions strictly, preserving empty, partial and older handle-only settings', () => {
    expect(validateGitHubSettings({ handle: 'octocat' })).toEqual({ handle: 'octocat' });
    for (const key of ['prefix', 'postfix']) {
      for (const value of ['', ' Hello {handle}: ', DEFAULT_GITHUB_POSTFIX, 'x'.repeat(MAX_GITHUB_CAPTION_LENGTH)]) {
        expect(validateGitHubSettings({ handle: 'octocat', [key]: value })).toEqual({ handle: 'octocat', [key]: value });
      }
      for (const value of [null, undefined, 123, [], {}, 'x'.repeat(MAX_GITHUB_CAPTION_LENGTH + 1), '\n', '\u00e9']) {
        expect(() => validateGitHubSettings({ handle: 'octocat', [key]: value })).toThrow(/GitHub (prefix|postfix)/);
      }
    }
  });

  it('accepts the last-year API calendar, which can include a partial extra week', () => {
    const contributions = Array.from({ length: 372 }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), count: i, level: i % 5,
    }));
    expect(parseContributions({ contributions })).toEqual(contributions);
  });

  it('rejects invalid response shape, dates, duplicate days, counts and intensity levels', () => {
    const day = { date: '2026-10-20', count: 3, level: 2 };
    for (const raw of [null, {}, { contributions: [] }, { contributions: [day, day] },
      ...[{ date: '2026-02-30' }, { date: 'invalid' }, { count: -1 }, { count: 1.5 }, { level: 5 }, { level: '2' }]
        .map((patch) => ({ contributions: [{ ...day, ...patch }] }))]) {
      expect(() => parseContributions(raw)).toThrow(/invalid/i);
    }
  });

  it('fetches only a validated public handle, without credentials, and validates the response', async () => {
    const contributions = [{ date: '2026-10-20', count: 1, level: 1 }];
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ contributions })));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect(await fetchContributions('octocat', signal)).toEqual(contributions);
    expect(fetch).toHaveBeenCalledWith('https://github-contributions-api.jogruber.de/v4/octocat?y=last',
      { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    await expect(fetchContributions('')).rejects.toThrow(/first/);
    await expect(fetchContributions('../token')).rejects.toThrow(/valid GitHub handle/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces missing users, rate limits, server errors, malformed responses and network failure', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const [status, error] of [[404, /not found/], [429, /rate limit/], [503, /HTTP 503/]] as const) {
      fetch.mockResolvedValueOnce(new Response('{}', { status }));
      await expect(fetchContributions('octocat')).rejects.toThrow(error);
    }
    fetch.mockResolvedValueOnce(new Response('{}'));
    await expect(fetchContributions('octocat')).rejects.toThrow(/invalid data/);
    fetch.mockRejectedValueOnce(new TypeError('Network unavailable'));
    await expect(fetchContributions('octocat')).rejects.toThrow(/Network unavailable/);
  });

  it('renders 53 Sunday-aligned weeks in 2x2 cells, with future and missing days black', () => {
    const image = renderContributionStrip([
      { date: '2025-10-19', count: 3, level: 4 }, // first Sunday
      { date: '2026-10-20', count: 1, level: 1 }, // current Tuesday
      { date: '2026-10-21', count: 9, level: 4 }, // future
      { date: '2025-10-18', count: 9, level: 4 }, // outside the 53 weeks
    ], 16, new Date('2026-10-20T18:00:00Z'));
    const pixel = (x: number, y: number) => [...image.pixels.slice((y * 106 + x) * 3, (y * 106 + x) * 3 + 3)];
    expect(image).toMatchObject({ width: 106, height: 16 });
    expect(image.pixels).toHaveLength(106 * 16 * 3);
    for (const [x, y] of [[0, 1], [1, 1], [0, 2], [1, 2]]) expect(pixel(x!, y!)).toEqual([0, 255, 0]);
    expect(pixel(104, 5)).toEqual([0, 48, 0]);
    expect(pixel(105, 6)).toEqual([0, 48, 0]);
    expect(pixel(104, 7)).toEqual([0, 0, 0]);
    expect(pixel(2, 1)).toEqual([0, 0, 0]);
    expect(pixel(0, 0)).toEqual([0, 0, 0]);
    expect(pixel(105, 15)).toEqual([0, 0, 0]);
  });

  it('uses only the green channel so the hat cannot shift levels toward blue', () => {
    const days = [0, 1, 2, 3, 4].map((level, i) => ({ date: `2026-10-${String(14 + i).padStart(2, '0')}`, count: level, level }));
    const { pixels } = renderContributionStrip(days, 16, new Date('2026-10-20T12:00:00Z'));
    for (let i = 0; i < pixels.length; i += 3) { expect(pixels[i]).toBe(0); expect(pixels[i + 2]).toBe(0); }
    const greens = new Set([...pixels].filter((_, i) => i % 3 === 1 && pixels[i]! > 0));
    expect([...greens].sort((a, b) => a - b)).toEqual([8, 48, 100, 170, 255]);
  });

  it('scrolls the whole year from right to left within the hat GIF limits', () => {
    const now = new Date('2026-10-20T18:00:00Z');
    const days = Array.from({ length: 367 }, (_, i) => ({
      date: new Date(Date.UTC(2025, 9, 19 + i)).toISOString().slice(0, 10), count: i % 5, level: i % 5,
    }));
    const strip = renderContributionStrip(days, 16, now);
    const frames = renderContributionMarquee(days, 32, 16, now);
    expect(frames).toHaveLength(69);
    expect(frames.every((f) => f.width === 32 && f.height === 16)).toBe(true);
    expect(frames[0]!.pixels.every((v) => v === 0)).toBe(true);
    const column = (img: RgbImage, x: number) => Array.from({ length: img.height }, (_, y) => [...img.pixels.slice((y * img.width + x) * 3, (y * img.width + x) * 3 + 3)]);
    expect(column(frames[16]!, 0)).toEqual(column(strip, 0)); // oldest week reaches the left edge
    expect(column(frames[68]!, 1)).toEqual(column(strip, 105)); // today's week is last to leave
    const gif = encodeGif(frames, 44, { nonce: gifNonce() });
    expect(buildGifStream(gif, 32, 16).bytes.length).toBeLessThanOrEqual(MAX_STREAM_BYTES);
    expect(frames.length).toBeLessThanOrEqual(MAX_GIF_FRAMES);
  });

  it('handles a year boundary, zero activity, shuffled days and rotated panels', () => {
    const days = [{ date: '2026-01-01', count: 0, level: 0 }, { date: '2025-12-31', count: 2, level: 2 }];
    const now = new Date('2026-01-01T00:00:00Z');
    const normal = renderContributionStrip(days, 16, now);
    expect(normal).toEqual(renderContributionStrip([...days].reverse(), 16, now));
    expect([...normal.pixels.slice((9 * 106 + 104) * 3, (9 * 106 + 104) * 3 + 3)]).toEqual([0, 8, 0]);
    const rotated = renderContributionMarquee(days, 16, 32, now).map((f) => transformImage(f, { rotation: 90, mirrorH: false, mirrorV: false }));
    expect(rotated.every((f) => f.width === 32 && f.height === 16)).toBe(true);
    expect(rotated.some((f) => f.pixels.some((value) => value > 0))).toBe(true);
    expect(() => renderContributionStrip(days, 6, now)).toThrow(/too small/);
  });

  it('scrolls the caption, unchanged graph, then suffix in a single continuous strip', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const days = [{ date: '2026-10-20', count: 4, level: 4 }];
    const before = solid(12, 16, [255, 255, 255]);
    const after = solid(4, 16, [255, 0, 0]);
    const graph = renderContributionStrip(days, 16, now);
    const frames = renderContributionMarquee(days, 32, 16, now, 2, { before, after });
    const totalWidth = before.width + graph.width + after.width;
    expect(frames).toHaveLength(Math.ceil((totalWidth + 32) / 2));
    for (let x = 0; x < totalWidth; x += 2) {
      const frame = frames[(x + 32) / 2]!;
      const part = x < before.width ? before : x < before.width + graph.width ? graph : after;
      const px = x < before.width ? x : x < before.width + graph.width ? x - before.width : x - before.width - graph.width;
      for (let y = 0; y < 16; y++) {
        expect(frame.pixels.slice(y * 32 * 3, y * 32 * 3 + 6))
          .toEqual(part.pixels.slice((y * part.width + px) * 3, (y * part.width + px) * 3 + 6));
      }
    }
    expect(() => renderContributionMarquee(days, 32, 16, now, 2, { before: solid(12, 8, [255, 255, 255]), after }))
      .toThrow(/height must match/);
  });
});
