import type { RgbImage } from '../protocol/framing';

export interface RenderedStep { image: RgbImage; frames?: RgbImage[]; delays?: number[]; seconds: number }

/** Keeps the generated GIF (and its BLE upload) within a practical size. */
export const MAX_SEQUENCE_FRAMES = 2000;
const DEFAULT_FRAME_MS = 100;

/**
 * Concatenate rendered steps into one looping animation. A static step becomes one frame held for
 * its duration; an animated step repeats whole cycles until it has played for at least its duration.
 */
export function composeSequence(steps: RenderedStep[], maxFrames = MAX_SEQUENCE_FRAMES): { frames: RgbImage[]; delays: number[] } {
  if (!steps.length) throw new Error('Add at least one step to the sequence.');
  const plan = steps.map((step) => {
    const ms = step.seconds * 1000;
    if (!step.frames || step.frames.length < 2) return { frames: [step.image], delays: [ms], repeats: 1 };
    const delays = step.frames.map((_, i) => step.delays?.[i] ?? DEFAULT_FRAME_MS);
    const cycle = Math.max(1, delays.reduce((a, b) => a + b, 0));
    return { frames: step.frames, delays, repeats: Math.max(1, Math.ceil(ms / cycle)) };
  });
  const total = plan.reduce((n, p) => n + p.frames.length * p.repeats, 0);
  if (total > maxFrames) throw new Error(`Sequence is too long (${total} frames, limit ${maxFrames}). Shorten durations, texts or animations, or remove steps.`);
  const frames: RgbImage[] = [];
  const delays: number[] = [];
  for (const p of plan) for (let r = 0; r < p.repeats; r++) { frames.push(...p.frames); delays.push(...p.delays); }
  return { frames, delays };
}
