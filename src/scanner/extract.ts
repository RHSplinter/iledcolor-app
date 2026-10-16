import type { ExtractedName } from './greeting';

/** A pathological user regex must not freeze the UI or delay cap restoration. */
export function extractNameSafely(raw: string, pattern: string): Promise<ExtractedName> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./nameWorker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    const timer = setTimeout(() => { finish(); reject(new Error('Name extraction took too long. Simplify the regex.')); }, 1000);
    worker.onmessage = (event: MessageEvent<{ fields?: ExtractedName; error?: string }>) => {
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.fields?.name) resolve(event.data.fields);
      else reject(new Error('Name extraction returned no name.'));
    };
    worker.onerror = (event) => { finish(); reject(new Error(event.message || 'Name extraction failed.')); };
    worker.postMessage({ raw, pattern });
  });
}
