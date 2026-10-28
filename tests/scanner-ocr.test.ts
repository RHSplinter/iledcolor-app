import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadgeTextRecognizer } from '../src/scanner/ocr';
import { extractName } from '../src/scanner/greeting';

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
    expect(worker.recognize).toHaveBeenCalledWith({}, {}, { text: true, blocks: true });
  });

  it('uses reading order and word gaps to keep distant QR artifacts out of badge fields', async () => {
    const word = (text: string, x0: number, x1: number, y0: number, confidence = 90) => ({
      text, confidence, bbox: { x0, x1, y0, y1: y0 + 30 },
    });
    const line = (words: ReturnType<typeof word>[]) => ({
      words, text: words.map((value) => value.text).join(' '),
      bbox: { x0: words[0]!.bbox.x0, x1: words.at(-1)!.bbox.x1, y0: words[0]!.bbox.y0, y1: words[0]!.bbox.y1 },
    });
    const worker = { recognize: vi.fn().mockResolvedValue({ data: {
      text: 'Xebia Bewiea\nDevOps Consultant\n@FokkoVeegens\nVeegens\nFokko',
      blocks: [{ paragraphs: [{ lines: [
        line([word('Xebia', 40, 140, 350), word('Bewiea', 475, 600, 350, 20)]),
        line([word('DevOps', 40, 180, 300), word('Consultant', 190, 380, 300)]),
        line([word('@FokkoVeegens', 40, 335, 220)]),
        line([word('Veegens', 40, 310, 100, 29)]),
        line([word('Fokko', 40, 225, 25)]),
      ] }] }],
    } }) };
    createWorker.mockResolvedValue(worker);
    const text = await new BadgeTextRecognizer().recognize({} as HTMLCanvasElement);
    expect(text).toBe('Fokko\nVeegens\n@FokkoVeegens\nDevOps Consultant\nXebia\nBewiea');
    expect(extractName(text)).toMatchObject({
      name: 'Fokko Veegens', github: 'FokkoVeegens', title: 'DevOps Consultant', company: 'Xebia',
    });
  });

  it('preserves multiword names and companies at normal spacing', async () => {
    const words = ['Jane', 'van', 'Dijk'].map((text, index) => ({
      text, bbox: { x0: index * 75, x1: index * 75 + 65, y0: 20, y1: 50 },
    }));
    createWorker.mockResolvedValue({ recognize: vi.fn().mockResolvedValue({ data: {
      text: 'Jane van Dijk',
      blocks: [{ paragraphs: [{ lines: [
        { words, bbox: { x0: 0, x1: 215, y0: 20, y1: 50 } },
        { words: [], text: 'Software Engineer', bbox: { x0: 0, x1: 300, y0: 70, y1: 100 } },
        { words: words.map((word, index) => ({
          ...word, text: ['Acme', 'Design', 'Group'][index], bbox: { ...word.bbox, y0: 120, y1: 150 },
        })),
          bbox: { x0: 0, x1: 215, y0: 120, y1: 150 } },
      ] }] }],
    } }) });
    const text = await new BadgeTextRecognizer().recognize({} as HTMLCanvasElement);
    expect(extractName(text)).toMatchObject({ name: 'Jane van Dijk', company: 'Acme Design Group' });
  });

  it('rejects empty or oversized OCR results', async () => {
    const worker = { recognize: vi.fn().mockResolvedValue({ data: { text: ' \n ' } }) };
    createWorker.mockResolvedValue(worker);
    const recognizer = new BadgeTextRecognizer();
    await expect(recognizer.recognize({} as HTMLCanvasElement)).rejects.toThrow(/No text recognized/);
    worker.recognize.mockResolvedValue({ data: { text: 'x'.repeat(4097) } });
    await expect(recognizer.recognize({} as HTMLCanvasElement)).rejects.toThrow(/Too much text/);
  });
  it.each([0, 4, 12])('separates stacked names merged by OCR with a %i pixel gap', async (gap) => {
    const word = (text: string, x0: number, x1: number, y0: number) => ({
      text, bbox: { x0, x1, y0, y1: y0 + 30 },
    });
    const words = [
      word('Meer', 180, 250, 50 + gap), word('Marie', 110, 200, 20),
      word('van', 40, 90, 50 + gap), word('Anne', 40, 100, 20),
      word('der', 100, 170, 50 + gap),
    ];
    createWorker.mockResolvedValue({ recognize: vi.fn().mockResolvedValue({ data: {
      text: 'Anne Marie van der Meer\n@badge-user\nSRE\nACME',
      blocks: [{ paragraphs: [{ lines: [
        { words, text: 'Anne Marie van der Meer', bbox: { x0: 40, x1: 250, y0: 20, y1: 80 + gap } },
        { words: [], text: '@badge-user', bbox: { x0: 40, x1: 250, y0: 130, y1: 160 } },
        { words: [], text: 'SRE', bbox: { x0: 40, x1: 100, y0: 180, y1: 210 } },
        { words: [], text: 'ACME', bbox: { x0: 40, x1: 150, y0: 230, y1: 260 } },
      ] }] }],
    } }) });
    const text = await new BadgeTextRecognizer().recognize({} as HTMLCanvasElement);
    expect(text).toBe('Anne Marie\nvan der Meer\n@badge-user\nSRE\nACME');
    expect(extractName(text)).toEqual({
      name: 'Anne Marie van der Meer', lastname: 'van der Meer',
      github: 'badge-user', title: 'SRE', company: 'ACME',
    });
    expect(words.map((word) => word.text)).toEqual(['Meer', 'Marie', 'van', 'Anne', 'der']);
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
