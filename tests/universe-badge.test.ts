import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeUniverseBadge, detectUniverseBadge, UNIVERSE_BADGE_KEY } from '../src/scanner/universeBadge';

const firstVector = 'https://events.githubuniverse.com/badgeScan?badgeId=1793206736050001KxhX&data=Ym5va2ZhbW9jb8KlwqPCmcKmwpXCo8K%2Bw53CmsKOwo%2FCicKXwrHCocKgwqXCnMKOwozDpcOaw5LDpMOZw5fDpcODworCm8KTwqDCl8KW';
const secondVector = 'https://events.githubuniverse.com/badgeScan?badgeId=1781035756633001oVTD&data=Ym5uaWRkbG9lb8KrwqHCnMKmwpXCo8OiwrvChnrCj3jCosKhwpJ0wp%2FCqsKZwqzDqcOTw5fDqcOKw6DDkcK4wpPCncKawqpWfMKdwpLCnsKmwp%2FCrMOpw5fDjMOpw4M%3D';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GitHub Universe badge QR decoding', () => {
  it('uses the named fixed event key', () => {
    expect(UNIVERSE_BADGE_KEY).toBe('1768417809universe26');
  });

  it.each([
    [firstVector, {
      source: 'qr', badgeId: '1793206736050001KxhX', firstName: 'Raymond', lastName: 'Splinter', company: 'Xebia',
    }],
    [secondVector, {
      source: 'qr', badgeId: '1781035756633001oVTD', firstName: 'Ali', lastName: 'Christensen', company: 'Sagis Diagnostics',
    }],
  ])('decodes the supplied badge vector', (qrText, expected) => {
    expect(decodeUniverseBadge(qrText)).toEqual(expected);
  });

  it.each([
    'https://example.com',
    firstVector.replace('1793206736050001KxhX', 'different-badge-id'),
    firstVector.replace(/data=[^&]+/, 'data=not-base64!'),
    'not a URL',
    'https://events.githubuniverse.com:444/badgeScan?badgeId=x&data=YWJj',
  ])('rejects invalid badge QR input %s without throwing', (qrText) => {
    expect(() => decodeUniverseBadge(qrText)).not.toThrow();
    expect(decodeUniverseBadge(qrText)).toBeUndefined();
  });

  it('uses browser QR detection when available and returns to OCR for invalid codes', async () => {
    const detect = vi.fn().mockResolvedValue([{ rawValue: 'https://example.com' }]);
    class Detector {
      constructor(options?: { formats: string[] }) {
        expect(options).toEqual({ formats: ['qr_code'] });
      }
      detect = detect;
    }
    vi.stubGlobal('BarcodeDetector', Detector);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(detectUniverseBadge({} as HTMLCanvasElement)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('No valid Universe badge QR found; falling back to OCR.');
  });

  it('returns a decoded badge from browser QR detection', async () => {
    class Detector {
      detect = vi.fn().mockResolvedValue([{ rawValue: firstVector }]);
    }
    vi.stubGlobal('BarcodeDetector', Detector);
    await expect(detectUniverseBadge({} as HTMLCanvasElement)).resolves.toMatchObject({
      source: 'qr', badgeId: '1793206736050001KxhX', firstName: 'Raymond', lastName: 'Splinter', company: 'Xebia',
    });
  });

  it('logs a generic fallback when browser QR detection is unavailable', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(detectUniverseBadge({} as HTMLCanvasElement)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('QR detection is unavailable; falling back to OCR.');
  });
});
