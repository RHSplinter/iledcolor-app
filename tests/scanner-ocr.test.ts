import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadgeTextRecognizer } from '../src/scanner/ocr';

const { createWorker } = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock('tesseract.js', () => ({ createWorker, OEM: { LSTM_ONLY: 1 } }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('window', { location: { href: 'https://example.org/controller/' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('offline badge text recognition', () => {
  it('loads its local English worker assets once and normalizes recognized lines', async () => {
    const worker = { recognize: vi.fn().mockResolvedValue({ data: { text: '  Rob Bos  \n\nSoftware Engineer \n' } }) };
    createWorker.mockResolvedValue(worker);
    const recognizer = new BadgeTextRecognizer();
    const progress = vi.fn();

    await expect(recognizer.recognize({} as HTMLCanvasElement, progress)).resolves.toBe('Rob Bos\nSoftware Engineer');
    await expect(recognizer.recognize({} as HTMLCanvasElement)).resolves.toBe('Rob Bos\nSoftware Engineer');

    expect(createWorker).toHaveBeenCalledOnce();
    const base = new URL(import.meta.env.BASE_URL, 'https://example.org/controller/');
    expect(createWorker).toHaveBeenCalledWith('eng', 1, expect.objectContaining({
      workerPath: new URL('ocr/worker.min.js', base).href,
      corePath: new URL('ocr/tesseract-core-lstm.wasm.js', base).href,
      langPath: new URL('ocr/lang/', base).href,
      gzip: true,
    }));
    expect(worker.recognize).toHaveBeenCalledTimes(2);
  });

  it('rejects empty or oversized OCR results', async () => {
    const worker = { recognize: vi.fn().mockResolvedValue({ data: { text: ' \n ' } }) };
    createWorker.mockResolvedValue(worker);
    const recognizer = new BadgeTextRecognizer();
    await expect(recognizer.recognize({} as HTMLCanvasElement)).rejects.toThrow(/No text recognized/);
    worker.recognize.mockResolvedValue({ data: { text: 'x'.repeat(4097) } });
    await expect(recognizer.recognize({} as HTMLCanvasElement)).rejects.toThrow(/Too much text/);
  });

  it('retries worker creation after a failed load instead of retaining a rejected worker', async () => {
    const worker = { recognize: vi.fn().mockResolvedValue({ data: { text: 'Rob' } }) };
    createWorker.mockRejectedValueOnce(new Error('Local OCR worker failed')).mockResolvedValueOnce(worker);
    const recognizer = new BadgeTextRecognizer();
    await expect(recognizer.recognize({} as HTMLCanvasElement)).rejects.toThrow(/Local OCR worker failed/);
    await expect(recognizer.recognize({} as HTMLCanvasElement)).resolves.toBe('Rob');
    expect(createWorker).toHaveBeenCalledTimes(2);
  });
});
