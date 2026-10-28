export const UNIVERSE_BADGE_KEY = '1768417809universe26';

export interface UniverseBadge {
  source: 'qr';
  badgeId: string;
  firstName: string;
  lastName: string;
  company: string;
}

interface BarcodeResult {
  rawValue: string;
}

interface BarcodeDetectorInstance {
  detect(image: ImageBitmapSource): Promise<BarcodeResult[]>;
}

interface BarcodeDetectorConstructor {
  new(options?: { formats: string[] }): BarcodeDetectorInstance;
}

const BASE64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/;

export function decodeUniverseBadge(qrText: string): UniverseBadge | undefined {
  try {
    if (typeof qrText !== 'string' || qrText.length > 8192) return undefined;
    const url = new URL(qrText);
    if (url.protocol !== 'https:' || url.host !== 'events.githubuniverse.com' ||
        url.username || url.password || url.pathname !== '/badgeScan') return undefined;

    const badgeIds = url.searchParams.getAll('badgeId');
    const payloads = url.searchParams.getAll('data');
    if (badgeIds.length !== 1 || payloads.length !== 1 || !badgeIds[0] || !payloads[0] ||
        payloads[0].length > 8192 || !BASE64.test(payloads[0])) return undefined;

    const bytes = Uint8Array.from(atob(payloads[0]), (character) => character.charCodeAt(0));
    const cipher = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let plain = '';
    let index = 0;
    for (const character of cipher) {
      const code = character.codePointAt(0)!;
      if (code > 255) return undefined;
      plain += String.fromCharCode((code - UNIVERSE_BADGE_KEY.charCodeAt(index % UNIVERSE_BADGE_KEY.length) + 256) % 256);
      index++;
    }

    const parts = plain.split('^');
    if (plain.length > 4096 || parts.length !== 5 || parts[4] !== '' || parts[0] !== badgeIds[0] ||
        !parts[1]?.trim() || !parts[2]?.trim() || parts[1]!.length > 100 || parts[2]!.length > 100 ||
        parts[3]!.length > 256 || /[\u0000-\u001f\u007f]/.test(plain)) return undefined;
    return {
      source: 'qr',
      badgeId: parts[0]!,
      firstName: parts[1]!,
      lastName: parts[2]!,
      company: parts[3]!,
    };
  } catch {
    return undefined;
  }
}

export async function detectUniverseBadge(image: ImageBitmapSource): Promise<UniverseBadge | undefined> {
  const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (!Detector) {
    console.info('QR detection is unavailable; falling back to OCR.');
    return undefined;
  }
  try {
    const results = await new Detector({ formats: ['qr_code'] }).detect(image);
    for (const result of results) {
      const badge = decodeUniverseBadge(result.rawValue);
      if (badge) return badge;
    }
  } catch {
    console.info('QR detection failed; falling back to OCR.');
    return undefined;
  }
  console.info('No valid Universe badge QR found; falling back to OCR.');
  return undefined;
}

export async function detectBadgeOrOcr<T>(
  image: ImageBitmapSource,
  recognize: () => Promise<T>,
): Promise<{ source: 'qr'; badge: UniverseBadge } | { source: 'ocr'; raw: T }> {
  const badge = await detectUniverseBadge(image);
  return badge ? { source: 'qr', badge } : { source: 'ocr', raw: await recognize() };
}
