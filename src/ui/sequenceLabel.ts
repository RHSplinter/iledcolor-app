import type { SingleContent } from '../storage/presets';

export const sequenceStepLabel = (c: SingleContent) => c.kind === 'text' ? `Text "${c.text}"` : c.kind === 'solid' ? `Solid ${c.color}`
  : c.kind === 'github' ? `GitHub ${c.handle}` : c.name ? `Image "${c.name}"` : 'Image';
