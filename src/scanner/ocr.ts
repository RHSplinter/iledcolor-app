import type { Page, Worker } from 'tesseract.js';

function badgeLines(data: Page): string[] {
  if (!data.blocks?.length) return data.text.split(/\r?\n/);
  return data.blocks.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines))
    .flatMap((line) => {
      if (!line.words.length) return [line];
      const rows: typeof line[] = [];
      // OCR can merge tightly stacked names into one line; recover rows before sorting by x.
      for (const word of [...line.words].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)) {
        const row = rows.find(({ bbox }) =>
          Math.min(bbox.y1, word.bbox.y1) - Math.max(bbox.y0, word.bbox.y0) >=
          0.5 * Math.max(bbox.y1 - bbox.y0, word.bbox.y1 - word.bbox.y0));
        if (row) row.words.push(word);
        else rows.push({ ...line, words: [word], bbox: { ...word.bbox } });
      }
      return rows;
    })
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
    .flatMap((line) => {
      const words = [...line.words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
      if (!words.length) return [line.text];
      const segments: string[] = [];
      let segment = '';
      for (let index = 0; index < words.length; index++) {
        const word = words[index]!;
        const previous = words[index - 1];
        // Distant graphics (notably QR codes) can be recognized as part of a company line.
        if (previous && word.bbox.x0 - previous.bbox.x1 > 3 * Math.max(
          previous.bbox.y1 - previous.bbox.y0, word.bbox.y1 - word.bbox.y0,
        )) {
          segments.push(segment);
          segment = '';
        }
        segment += `${segment ? ' ' : ''}${word.text.trim()}`;
      }
      segments.push(segment);
      return segments;
    });
}

export class BadgeTextRecognizer {
  private worker?: Promise<Worker>;
  private reportProgress?: (status: string, progress: number) => void;

  async recognize(image: HTMLCanvasElement, reportProgress?: (status: string, progress: number) => void): Promise<string> {
    this.reportProgress = reportProgress;
    try {
      const worker = await this.getWorker();
      const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
      const text = badgeLines(data).map((line) => line.trim()).filter(Boolean).join('\n');
      if (!text) throw new Error('No text recognized. Move closer, reduce glare, and try again.');
      if (text.length > 4096) throw new Error('Too much text was recognized. Frame only the badge details and try again.');
      return text;
    } finally {
      this.reportProgress = undefined;
    }
  }

  private async getWorker(): Promise<Worker> {
    if (!this.worker) {
      this.worker = (async () => {
        const { createWorker, OEM } = await import('tesseract.js');
        const base = new URL(import.meta.env.BASE_URL, window.location.href);
        return createWorker('eng', OEM.LSTM_ONLY, {
          workerPath: new URL('ocr/worker.min.js', base).href,
          corePath: new URL('ocr/tesseract-core-lstm.wasm.js', base).href,
          langPath: new URL('ocr/lang/', base).href,
          gzip: true,
          logger: ({ status, progress }) => this.reportProgress?.(status, progress),
        });
      })();
    }
    try {
      return await this.worker;
    } catch (error) {
      this.worker = undefined;
      throw error;
    }
  }
}
