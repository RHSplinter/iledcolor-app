export const TEXT_FONTS = [
  { id: 'silkscreen', label: 'Silkscreen - compact pixel', family: '"Silkscreen"', size: 8 },
  { id: 'tiny5', label: 'Tiny5 - large pixel', family: '"Tiny5"', size: 16 },
  { id: 'press-start', label: 'Press Start 2P - arcade', family: '"Press Start 2P"', size: 8 },
  { id: 'dotgothic', label: 'DotGothic16 - tall pixel', family: '"DotGothic16"', size: 16 },
  // A 2x scale of an 8-row grid: letters, ascenders and descenders fill all 16 rows.
  { id: 'bitcount', label: 'Bitcount - full height', family: '"Bitcount Prop Single"', size: 20 },
] as const;

export type TextFont = typeof TEXT_FONTS[number]['id'];
export const DEFAULT_TEXT_FONT: TextFont = 'silkscreen';

export function isTextFont(value: unknown): value is TextFont {
  return TEXT_FONTS.some((font) => font.id === value);
}
