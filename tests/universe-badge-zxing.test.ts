import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const readerWasm = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));

// Use the real ZXing reader, but load its wasm from disk instead of the app's qr/ asset URL.
vi.mock('zxing-wasm/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zxing-wasm/reader')>();
  return {
    ...actual,
    prepareZXingModule: () => actual.prepareZXingModule({
      overrides: { wasmBinary: readerWasm.buffer.slice(readerWasm.byteOffset, readerWasm.byteOffset + readerWasm.byteLength) as ArrayBuffer },
    }),
  };
});

import { detectBadgeOrOcr } from '../src/scanner/universeBadge';

const badgeQr = 'https://events.githubuniverse.com/badgeScan?badgeId=1793206736050001KxhX&data=Ym5va2ZhbW9jb8KlwqPCmcKmwpXCo8K%2Bw53CmsKOwo%2FCicKXwrHCocKgwqXCnMKOwozDpcOaw5LDpMOZw5fDpcODworCm8KTwqDCl8KW';

async function badgeFrame(): Promise<HTMLCanvasElement> {
  const { prepareZXingModule, writeBarcode } = await import('zxing-wasm/full');
  const fullWasm = readFileSync(require.resolve('zxing-wasm/full/zxing_full.wasm'));
  prepareZXingModule({ overrides: { wasmBinary: fullWasm.buffer.slice(fullWasm.byteOffset, fullWasm.byteOffset + fullWasm.byteLength) as ArrayBuffer } });
  const { symbol, error } = await writeBarcode(badgeQr, { format: 'QRCode' });
  expect(error).toBe('');

  // A 1280x720 frame with the QR in the lower-right quarter and "text-like" stripes elsewhere,
  // so the code is a small part of the frame as on a real badge.
  const width = 1280, height = 720, module = 4, left = 900, top = 380;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x: number, y: number, value: number) => {
    const index = (y * width + x) * 4;
    data[index] = data[index + 1] = data[index + 2] = value;
  };
  for (let y = 80; y < 300; y += 40) for (let x = 100; x < 800; x++) for (let row = 0; row < 18; row++) if (x % 23 < 15) paint(x, y + row, 30);
  for (let y = 0; y < symbol.height; y++) {
    for (let x = 0; x < symbol.width; x++) {
      const value = symbol.data[y * symbol.width + x]! < 128 ? 0 : 255;
      for (let dy = 0; dy < module; dy++) for (let dx = 0; dx < module; dx++) paint(left + x * module + dx, top + y * module + dy, value);
    }
  }
  return {
    width, height,
    getContext: () => ({ getImageData: () => ({ width, height, data }) }),
  } as unknown as HTMLCanvasElement;
}

describe('Universe badge QR decoding without BarcodeDetector', () => {
  it('reads a small badge QR among printed text with the bundled ZXing reader', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    const recognize = vi.fn();
    await expect(detectBadgeOrOcr(await badgeFrame(), recognize)).resolves.toMatchObject({
      source: 'qr', badge: { badgeId: '1793206736050001KxhX', firstName: 'Raymond', lastName: 'Splinter', company: 'Xebia' },
    });
    expect(recognize).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
