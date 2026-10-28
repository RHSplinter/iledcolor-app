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

type QrFrame = HTMLCanvasElement;
type ZxingReader = typeof import('zxing-wasm/reader');

let zxingReader: Promise<ZxingReader> | undefined;

function loadZxingReader(): Promise<ZxingReader> {
  zxingReader ??= import('zxing-wasm/reader').then((reader) => {
    // Serve the bundled reader from the app so QR fallback works offline and never hits a CDN.
    reader.prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) => path.endsWith('.wasm')
          ? new URL(`qr/${path}`, new URL(import.meta.env.BASE_URL, globalThis.location.href)).href
          : prefix + path,
      },
    });
    return reader;
  });
  return zxingReader;
}

/** Native Shape Detection API: available on Android, macOS and ChromeOS Chromium, not Windows or iOS. */
async function readNativeQrCodes(frame: QrFrame): Promise<string[] | undefined> {
  const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (!Detector) return undefined;
  try {
    return (await new Detector({ formats: ['qr_code'] }).detect(frame)).map((result) => result.rawValue);
  } catch {
    return undefined;
  }
}

async function readWasmQrCodes(frame: QrFrame): Promise<string[] | undefined> {
  try {
    const context = frame.getContext('2d', { willReadFrequently: true });
    if (!context || !frame.width || !frame.height) return undefined;
    const image = context.getImageData(0, 0, frame.width, frame.height);
    const reader = await loadZxingReader();
    const results = await reader.readBarcodes(image, {
      formats: ['QRCode'],
      tryHarder: true,
      tryInvert: true,
      maxNumberOfSymbols: 4,
    });
    return results.filter((result) => result.isValid).map((result) => result.text);
  } catch {
    zxingReader = undefined;
    return undefined;
  }
}

function firstBadge(values: string[] | undefined): UniverseBadge | undefined {
  for (const value of values ?? []) {
    const badge = decodeUniverseBadge(value);
    if (badge) return badge;
  }
  return undefined;
}

export async function detectUniverseBadge(frame: QrFrame): Promise<UniverseBadge | undefined> {
  const native = await readNativeQrCodes(frame);
  const nativeBadge = firstBadge(native);
  if (nativeBadge) return nativeBadge;
  // The native detector is missing on Windows and iOS and can miss small codes elsewhere, so always try ZXing too.
  const wasm = await readWasmQrCodes(frame);
  const wasmBadge = firstBadge(wasm);
  if (wasmBadge) return wasmBadge;
  if (!native && !wasm) {
    console.info('QR detection is unavailable; falling back to OCR.');
    return undefined;
  }
  console.info('No valid Universe badge QR found; falling back to OCR.');
  return undefined;
}

export async function detectBadgeOrOcr<T>(
  image: QrFrame,
  recognize: () => Promise<T>,
): Promise<{ source: 'qr'; badge: UniverseBadge } | { source: 'ocr'; raw: T }> {
  const badge = await detectUniverseBadge(image);
  return badge ? { source: 'qr', badge } : { source: 'ocr', raw: await recognize() };
}
