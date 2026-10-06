export type Run = { kind: 'text' | 'emoji'; text: string };

const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
const ASCII = /^[\x20-\x7e]$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Split into pixel-font ASCII runs and colour emoji runs; anything else is reported as unsupported. */
export function splitRuns(text: string): { runs: Run[]; unsupported: string[] } {
  const runs: Run[] = [];
  const unsupported = new Set<string>();
  for (const { segment } of segmenter.segment(text)) {
    const kind = ASCII.test(segment) ? 'text' : EMOJI.test(segment) ? 'emoji' : null;
    if (!kind) { unsupported.add(segment); continue; }
    const last = runs[runs.length - 1];
    if (last && last.kind === kind && kind === 'text') last.text += segment;
    else runs.push({ kind, text: segment });
  }
  return { runs, unsupported: [...unsupported] };
}
