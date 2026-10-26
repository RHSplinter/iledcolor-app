import type { Worker } from 'tesseract.js';

export class BadgeTextRecognizer {
  private worker?: Promise<Worker>;
  private reportProgress?: (status: string, progress: number) => void;

  async recognize(image: HTMLCanvasElement, reportProgress?: (status: string, progress: number) => void): Promise<string> {
    this.reportProgress = reportProgress;
    try {
      const worker = await this.getWorker();
      const { data } = await worker.recognize(image);
      const text = data.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');
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
