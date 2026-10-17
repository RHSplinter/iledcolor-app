export const REACTIONS = [
  { id: 'greeting', label: 'Greeting / Begrüßung', text: 'HELLO!', color: '#4da3ff',
    en: ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening', 'welcome'],
    de: ['hallo', 'hi', 'hey', 'guten morgen', 'guten tag', 'guten abend', 'willkommen', 'servus', 'moin'] },
  { id: 'farewell', label: 'Farewell / Abschied', text: 'BYE BYE!', color: '#bb88ff',
    en: ['goodbye', 'bye', 'see you', 'see you later', 'take care', 'ciao'],
    de: ['tschüss', 'tschüs', 'auf wiedersehen', 'bis bald', 'bis später', 'ciao', 'chiao', 'tschau'] },
  { id: 'approval', label: 'Approval / Zustimmung', text: 'AWESOME!', color: '#4cd964',
    en: ['awesome', 'great', 'cool', 'nice', 'amazing', 'well done', 'sounds good'],
    de: ['toll', 'super', 'klasse', 'großartig', 'prima', 'wunderbar', 'gut gemacht', 'klingt gut'] },
  { id: 'food', label: 'Food / Essen', text: 'FOOD TIME!', color: '#ffb020',
    en: ['food', 'meal', 'breakfast', 'lunch', 'dinner', 'hungry', 'enjoy your meal'],
    de: ['essen', 'mahlzeit', 'frühstück', 'mittagessen', 'abendessen', 'hunger', 'guten appetit'] },
  { id: 'thanks', label: 'Thanks / Dank', text: 'THANK YOU!', color: '#ff88aa',
    en: ['thank you', 'thanks', 'much appreciated'],
    de: ['danke', 'dankeschön', 'vielen dank', 'besten dank'] },
  { id: 'question', label: 'Questions / Fragen', text: 'QUESTION?', color: '#4ddddd',
    en: ['i have a question', 'any questions', 'how does it work', 'could you explain'],
    de: ['ich habe eine frage', 'noch fragen', 'wie funktioniert das', 'kannst du das erklären'] },
  { id: 'coffee', label: 'Coffee break / Kaffeepause', text: 'COFFEE?', color: '#ffaa66',
    en: ['coffee', 'coffee break', 'tea break', 'grab a coffee'],
    de: ['kaffee', 'kaffeepause', 'teepause', 'einen kaffee'] },
  { id: 'celebration', label: 'Celebration / Feiern', text: 'HOORAY!', color: '#ffdd44',
    en: ['congratulations', 'hooray', 'we did it', 'cheers', 'happy birthday'],
    de: ['glückwunsch', 'herzlichen glückwunsch', 'hurra', 'geschafft', 'prost', 'alles gute zum geburtstag'] },
  { id: 'applause', label: 'Applause / Applaus', text: 'CLAP CLAP!', color: '#ffdd44', en: [], de: [] },
  { id: 'whistle', label: 'Whistle / Pfeifen', text: 'WOW!', color: '#4ddddd', en: [], de: [] },
] as const;

export type ReactionId = typeof REACTIONS[number]['id'];
export type Language = 'en-US' | 'de-DE';
export const normalizePhrase = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Whole words only; prefer a specific phrase over an overlapping short word. */
export function matchPhrase(text: string, language: Language, enabled: readonly ReactionId[]): ReactionId | undefined {
  const input = ` ${normalizePhrase(text)} `;
  const matches = REACTIONS.filter((r) => enabled.includes(r.id)).flatMap((r) =>
    r[language === 'de-DE' ? 'de' : 'en'].map((phrase) => ({ id: r.id, phrase: normalizePhrase(phrase) })))
    .filter(({ phrase }) => input.includes(` ${phrase} `))
    .sort((a, b) => b.phrase.length - a.phrase.length);
  return matches[0]?.id;
}

export interface SoundPreferences {
  language: Language;
  phrases: boolean;
  sounds: boolean;
  pauseInPocket: boolean;
  allowBrowserSpeech: boolean;
  reactions: Record<ReactionId, { enabled: boolean; text: string }>;
}

export const defaultPreferences = (): SoundPreferences => ({
  language: 'en-US', phrases: false, sounds: true, pauseInPocket: true, allowBrowserSpeech: false,
  reactions: Object.fromEntries(REACTIONS.map((r) => [r.id, { enabled: true, text: r.text }])) as SoundPreferences['reactions'],
});

export function validatePreferences(value: unknown): SoundPreferences {
  if (!value || typeof value !== 'object') throw new Error('Invalid sound settings.');
  const v = value as Record<string, unknown>;
  if (v.language !== 'en-US' && v.language !== 'de-DE') throw new Error('Choose English or German.');
  for (const key of ['phrases', 'sounds', 'pauseInPocket', 'allowBrowserSpeech'])
    if (typeof v[key] !== 'boolean') throw new Error(`Invalid sound setting: ${key}.`);
  if (!v.reactions || typeof v.reactions !== 'object') throw new Error('Invalid reaction settings.');
  const reactions = {} as SoundPreferences['reactions'];
  for (const { id } of REACTIONS) {
    const item = (v.reactions as Record<string, unknown>)[id];
    if (!item || typeof item !== 'object') throw new Error(`Missing reaction: ${id}.`);
    const r = item as Record<string, unknown>;
    if (typeof r.enabled !== 'boolean' || typeof r.text !== 'string' || !r.text.trim()
      || r.text.length > 40 || !/^[\x20-\x7e]+$/.test(r.text))
      throw new Error('Reaction text must contain 1–40 printable ASCII characters supported by the cap.');
    reactions[id] = { enabled: r.enabled, text: r.text.trim() };
  }
  return { language: v.language, phrases: v.phrases as boolean, sounds: v.sounds as boolean,
    pauseInPocket: v.pauseInPocket as boolean, allowBrowserSpeech: v.allowBrowserSpeech as boolean, reactions };
}
