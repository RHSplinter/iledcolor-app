import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const zxing = vi.hoisted(() => ({
  readBarcodes: vi.fn(),
  prepareZXingModule: vi.fn(),
}));
vi.mock('zxing-wasm/reader', () => zxing);

import { decodeUniverseBadge, detectBadgeOrOcr, detectUniverseBadge, UNIVERSE_BADGE_KEY } from '../src/scanner/universeBadge';

const firstVector = 'https://events.githubuniverse.com/badgeScan?badgeId=1793206736050001KxhX&data=Ym5va2ZhbW9jb8KlwqPCmcKmwpXCo8K%2Bw53CmsKOwo%2FCicKXwrHCocKgwqXCnMKOwozDpcOaw5LDpMOZw5fDpcODworCm8KTwqDCl8KW';
const secondVector = 'https://events.githubuniverse.com/badgeScan?badgeId=1781035756633001oVTD&data=Ym5uaWRkbG9lb8KrwqHCnMKmwpXCo8OiwrvChnrCj3jCosKhwpJ0wp%2FCqsKZwqzDqcOTw5fDqcOKw6DDkcK4wpPCncKawqpWfMKdwpLCnsKmwp%2FCrMOpw5fDjMOpw4M%3D';

function frame(): HTMLCanvasElement {
  const image = { width: 4, height: 2, data: new Uint8ClampedArray(32) };
  return {
    width: 4,
    height: 2,
    getContext: vi.fn(() => ({ getImageData: vi.fn(() => image) })),
  } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  zxing.readBarcodes.mockReset().mockResolvedValue([]);
});

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
    'https://events.githubuniverse.com/badgeScan?badgeId=x&data=//8=',
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

    await expect(detectUniverseBadge(frame())).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('No valid Universe badge QR found; falling back to OCR.');
  });

  it('falls back to OCR when the camera frame contains an invalid QR code', async () => {
    vi.stubGlobal('BarcodeDetector', class {
      detect = vi.fn().mockResolvedValue([{ rawValue: 'https://example.com' }]);
    });
    const recognize = vi.fn().mockResolvedValue('Raymond Splinter\nXebia');
    await expect(detectBadgeOrOcr(frame(), recognize))
      .resolves.toEqual({ source: 'ocr', raw: 'Raymond Splinter\nXebia' });
    expect(recognize).toHaveBeenCalledOnce();
  });

  it('falls back to OCR when browser QR detection is unavailable', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    const recognize = vi.fn().mockResolvedValue('OCR text');
    await expect(detectBadgeOrOcr(frame(), recognize))
      .resolves.toEqual({ source: 'ocr', raw: 'OCR text' });
    expect(recognize).toHaveBeenCalledOnce();
  });

  it('skips OCR when the camera frame contains a valid Universe badge QR code', async () => {
    vi.stubGlobal('BarcodeDetector', class {
      detect = vi.fn().mockResolvedValue([{ rawValue: firstVector }]);
    });
    const recognize = vi.fn();
    await expect(detectBadgeOrOcr(frame(), recognize))
      .resolves.toMatchObject({ source: 'qr', badge: { badgeId: '1793206736050001KxhX' } });
    expect(recognize).not.toHaveBeenCalled();
  });

  it('returns a decoded badge from browser QR detection', async () => {
    class Detector {
      detect = vi.fn().mockResolvedValue([{ rawValue: firstVector }]);
    }
    vi.stubGlobal('BarcodeDetector', Detector);
    await expect(detectUniverseBadge(frame())).resolves.toMatchObject({
      source: 'qr', badgeId: '1793206736050001KxhX', firstName: 'Raymond', lastName: 'Splinter', company: 'Xebia',
    });
  });

  it('decodes the badge with the bundled ZXing reader when BarcodeDetector is missing (iOS, Windows)', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    vi.stubGlobal('location', { href: 'https://app.example/led/index.html' });
    zxing.prepareZXingModule.mockClear();
    zxing.readBarcodes.mockResolvedValue([{ isValid: true, text: 'https://example.com' }, { isValid: true, text: firstVector }]);
    vi.resetModules();
    const fresh = await import('../src/scanner/universeBadge');
    const recognize = vi.fn();
    await expect(fresh.detectBadgeOrOcr(frame(), recognize))
      .resolves.toMatchObject({ source: 'qr', badge: { badgeId: '1793206736050001KxhX', firstName: 'Raymond' } });
    expect(recognize).not.toHaveBeenCalled();
    expect(zxing.readBarcodes).toHaveBeenCalledWith(
      expect.objectContaining({ width: 4, height: 2 }),
      expect.objectContaining({ formats: ['QRCode'], tryHarder: true }),
    );
    const { locateFile } = zxing.prepareZXingModule.mock.calls[0]![0].overrides;
    expect(locateFile('zxing_reader.wasm', 'https://cdn.example/')).toBe(new URL('qr/zxing_reader.wasm', new URL(import.meta.env.BASE_URL, 'https://app.example/led/index.html')).href);
  });

  it('tries the bundled ZXing reader when the native detector finds no badge', async () => {
    vi.stubGlobal('BarcodeDetector', class {
      detect = vi.fn().mockResolvedValue([]);
    });
    zxing.readBarcodes.mockResolvedValue([{ isValid: true, text: secondVector }]);
    await expect(detectUniverseBadge(frame())).resolves.toMatchObject({ badgeId: '1781035756633001oVTD' });
  });

  it('does not run ZXing when the native detector already found a badge', async () => {
    vi.stubGlobal('BarcodeDetector', class {
      detect = vi.fn().mockResolvedValue([{ rawValue: firstVector }]);
    });
    await expect(detectUniverseBadge(frame())).resolves.toMatchObject({ badgeId: '1793206736050001KxhX' });
    expect(zxing.readBarcodes).not.toHaveBeenCalled();
  });

  it('ignores invalid ZXing results and falls back to OCR when ZXing fails to load', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    zxing.readBarcodes.mockResolvedValueOnce([{ isValid: false, text: firstVector }]);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(detectUniverseBadge(frame())).resolves.toBeUndefined();
    expect(log).toHaveBeenLastCalledWith('No valid Universe badge QR found; falling back to OCR.');

    zxing.readBarcodes.mockRejectedValueOnce(new Error('wasm fetch failed'));
    const recognize = vi.fn().mockResolvedValue('OCR text');
    await expect(detectBadgeOrOcr(frame(), recognize)).resolves.toEqual({ source: 'ocr', raw: 'OCR text' });
    expect(log).toHaveBeenLastCalledWith('QR detection is unavailable; falling back to OCR.');
  });

  it('logs a generic fallback when browser QR detection is unavailable', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    zxing.readBarcodes.mockRejectedValue(new Error('unavailable'));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(detectUniverseBadge(frame())).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('QR detection is unavailable; falling back to OCR.');
  });
});
