import { extractName } from './greeting';

self.onmessage = (event: MessageEvent<{ raw: string; pattern: string }>) => {
  try { self.postMessage({ fields: extractName(event.data.raw, event.data.pattern) }); }
  catch (e) { self.postMessage({ error: e instanceof Error ? e.message : String(e) }); }
};
