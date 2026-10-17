import { describe, expect, it } from 'vitest';
import {
  analyseAudio, analyseFrames, detectSound, enrollVoice, matchesVoice, validateVoiceProfile, verifyUtterance,
  type AudioFeatures,
} from '../src/sound/analysis';
import { defaultPreferences, matchPhrase, REACTIONS, validatePreferences } from '../src/sound/dictionary';

const ids = REACTIONS.map((r) => r.id);
function tone(pitch: number, at: number, gain = 0.12, sampleRate = 16000) {
  return analyseAudio({ at, sampleRate, samples: Array.from({ length: Math.ceil(1024 * sampleRate / 16000) }, (_, i) =>
    gain * (Math.sin(i * Math.PI * 2 * pitch / sampleRate)
      + 0.4 * Math.sin(i * Math.PI * 4 * pitch / sampleRate) + 0.2 * Math.sin(i * Math.PI * 6 * pitch / sampleRate))) });
}
const voiceFeatures = () => Array.from({ length: 60 }, (_, i) => tone(180 + i % 5, (i + 1) * 64));

describe('bilingual sound dictionary', () => {
  it.each([
    ['Hello there!', 'en-US', 'greeting'], ['Hi!', 'en-US', 'greeting'],
    ['Good morning everyone', 'en-US', 'greeting'], ['See you later.', 'en-US', 'farewell'],
    ['Awesome, great work!', 'en-US', 'approval'], ['Let us get breakfast', 'en-US', 'food'],
    ['Tschüss!', 'de-DE', 'farewell'], ['Chiao', 'de-DE', 'farewell'],
    ['Guten Morgen!', 'de-DE', 'greeting'], ['Ein tolles Frühstück!', 'de-DE', 'food'],
    ['Großartig!', 'de-DE', 'approval'], ['Ich habe eine Frage!', 'de-DE', 'question'],
    ['Vielen Dank!', 'de-DE', 'thanks'], ['Shall we grab a coffee?', 'en-US', 'coffee'],
    ['Herzlichen Glückwunsch!', 'de-DE', 'celebration'],
  ] as const)('matches %s', (text, language, id) => expect(matchPhrase(text, language, ids)).toBe(id));
  it('does not match substrings or disabled categories, and prefers specific phrases', () => {
    expect(matchPhrase('this shipment is high', 'en-US', ids)).toBeUndefined();
    expect(matchPhrase('hello', 'en-US', ['applause'])).toBeUndefined();
    expect(matchPhrase('guten morgen', 'en-US', ids)).toBeUndefined();
    expect(matchPhrase('nice, how does it work', 'en-US', ids)).toBe('question');
  });
  it('validates preferences, cap text and missing categories without silent defaults', () => {
    expect(validatePreferences(defaultPreferences())).toEqual(defaultPreferences());
    expect(defaultPreferences()).toMatchObject({ phrases: false, pauseInPocket: true, allowBrowserSpeech: false });
    const invalid = defaultPreferences();
    invalid.reactions.greeting.text = 'Grüße';
    expect(() => validatePreferences(invalid)).toThrow('ASCII');
    expect(() => validatePreferences({ ...defaultPreferences(), language: 'fr-FR' })).toThrow('English or German');
    expect(() => validatePreferences({ ...defaultPreferences(), reactions: {} })).toThrow('Missing reaction');
  });
});

describe('local acoustic features and experimental wearer verification', () => {
  it('rejects silence, clipping, corrupt input and noisy/short enrollment', () => {
    const silence = analyseAudio({ samples: new Array(1024).fill(0), sampleRate: 16000, at: 64 });
    expect(silence.voice).toBeNull();
    expect(silence.rms).toBe(0);
    expect(() => enrollVoice(Array(60).fill(silence))).toThrow('Not enough clear speech');
    expect(() => enrollVoice(voiceFeatures().slice(0, 20))).toThrow();
    expect(() => analyseAudio({ samples: Array(1024).fill(NaN), sampleRate: 16000, at: 0 })).toThrow('Invalid');
    expect(() => analyseAudio({ samples: Array(1024).fill(0), sampleRate: 0, at: 0 })).toThrow('Invalid');
    expect(() => validateVoiceProfile({ version: 1, frames: 50, mean: [0], spread: [1] })).toThrow();
  });
  it('uses acoustic cepstra and pitch, tolerates gain and microphone sample rates', () => {
    const frames = voiceFeatures();
    expect(frames.filter((f) => f.voice)).toHaveLength(60);
    const profile = enrollVoice(frames);
    expect(validateVoiceProfile(profile)).toEqual(profile);
    expect(matchesVoice(tone(181, 4000, 0.05), profile)).toBe(true);
    expect(matchesVoice(tone(181, 4000, 0.12, 48000), profile)).toBe(true);
    expect(matchesVoice(tone(300, 4000), profile)).toBe(false);
    expect(JSON.stringify(profile)).not.toContain('samples');
  });
  it('analyses both halves of native audio blocks with aligned timestamps', () => {
    const samples = Array.from({ length: 2048 }, (_, i) => 0.1 * Math.sin(i * 2 * Math.PI * (i < 1024 ? 180 : 300) / 16000));
    const features = analyseFrames({ samples, sampleRate: 16000, at: 128 });
    expect(features).toHaveLength(2);
    expect(features.map((f) => f.at)).toEqual([64, 128]);
    expect(features[0]!.pitch).toBeCloseTo(180, -1);
    expect(features[1]!.pitch).toBeCloseTo(300, -1);
  });
  it('requires matching voiced frames in the actual utterance, not a recent unrelated voice', () => {
    const frames = voiceFeatures(), profile = enrollVoice(frames);
    expect(verifyUtterance(frames, profile, 0, 3840)).toBe(true);
    expect(verifyUtterance(frames, profile, 10000, 12000)).toBe(false);
    expect(verifyUtterance(frames, profile, 0, 20000)).toBe(false);
    expect(verifyUtterance(frames.filter((f) => f.at < 500 || f.at > 2000), profile, 0, 3840)).toBe(false);
    const other = Array.from({ length: 60 }, (_, i) => tone(300, 4000 + i * 64));
    expect(verifyUtterance([...frames, ...other], profile, 4000, 7776)).toBe(false);
    const mixed = frames.map((f, i) => i % 3 === 0 ? tone(300, f.at) : f);
    expect(verifyUtterance(mixed, profile, 0, 3840)).toBe(false);
  });
});

describe('room sound heuristics', () => {
  const silence = (at: number): AudioFeatures => ({ at, duration: 64, rms: 0, peak: 0,
    flatness: 0, dominantHz: 0, dominance: 0, pitch: 0, voice: null });
  it('requires repeated broadband impulses for applause, not one clap or speech', () => {
    const frame = (at: number) => ({ ...silence(at), rms: 0.07, peak: 0.4, flatness: 0.5 });
    const claps = Array.from({ length: 24 }, (_, i) => i % 4 === 0 ? frame(i * 64) : silence(i * 64));
    expect(detectSound(claps)).toBe('applause');
    expect(detectSound([frame(0), ...Array.from({ length: 23 }, (_, i) => silence((i + 1) * 64))])).toBeUndefined();
    expect(detectSound(voiceFeatures())).toBeUndefined();
    expect(detectSound([])).toBeUndefined();
  });
  it('detects a sustained high tone, not an isolated beep', () => {
    const frames = Array.from({ length: 24 }, (_, i) => tone(2500, i * 64));
    expect(detectSound(frames)).toBe('whistle');
    expect(detectSound([...frames.slice(0, 3), ...Array.from({ length: 20 }, (_, i) => silence((i + 3) * 64))])).toBeUndefined();
  });
  it('recognizes repeated simulated PCM claps through the complete feature pipeline', () => {
    let seed = 42;
    const frames = Array.from({ length: 24 }, (_, frame) => analyseAudio({
      at: frame * 64, sampleRate: 16000, samples: Array.from({ length: 1024 }, (_, i) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return frame % 4 === 0 ? (seed / 0xffffffff * 2 - 1) * 0.8 * Math.exp(-i / 100) : 0;
      }),
    }));
    expect(detectSound(frames)).toBe('applause');
  });
});
