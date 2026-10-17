export interface AudioFrame { samples: number[]; sampleRate: number; at: number }
export interface AudioFeatures {
  at: number; duration: number; rms: number; peak: number; flatness: number;
  dominantHz: number; dominance: number; pitch: number; voice: number[] | null;
}
export interface VoiceProfile { version: 1; mean: number[]; spread: number[]; frames: number }
const N = 1024;
const COEFFICIENTS = 13;

export function analyseFrames(frame: AudioFrame): AudioFeatures[] {
  const size = Math.round(frame.sampleRate * N / 16000);
  if (!Number.isFinite(size) || size < 256 || frame.samples.length < size) return [analyseAudio(frame)];
  const features: AudioFeatures[] = [];
  for (let offset = 0; offset + size <= frame.samples.length; offset += size) {
    features.push(analyseAudio({ sampleRate: frame.sampleRate,
      at: frame.at - (frame.samples.length - offset - size) / frame.sampleRate * 1000,
      samples: frame.samples.slice(offset, offset + size) }));
  }
  return features;
}

/** Shared 16 kHz features, independent of microphone gain. No raw audio is persisted. */
export function analyseAudio(frame: AudioFrame): AudioFeatures {
  if (!Number.isFinite(frame.at) || !Number.isFinite(frame.sampleRate) || frame.sampleRate < 8000
    || frame.sampleRate > 192000 || frame.samples.length < 256 || frame.samples.length > 32768
    || frame.samples.some((s) => !Number.isFinite(s) || Math.abs(s) > 1.01)) throw new Error('Invalid microphone frame.');
  const samples = new Float64Array(N);
  const ratio = frame.sampleRate / 16000;
  for (let i = 0; i < N; i++) {
    const source = i * ratio;
    if (source + 1 >= frame.samples.length) break;
    const k = Math.floor(source), fraction = source - k;
    samples[i] = frame.samples[k]! * (1 - fraction) + frame.samples[k + 1]! * fraction;
  }
  const mean = samples.reduce((a, b) => a + b, 0) / N;
  let energy = 0, peak = 0;
  for (let i = 0; i < N; i++) {
    samples[i] = samples[i]! - mean;
    energy += samples[i]! ** 2; peak = Math.max(peak, Math.abs(samples[i]!));
  }
  const rms = Math.sqrt(energy / N);
  const real = Float64Array.from(samples, (s, i) => s * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1))));
  const imag = new Float64Array(N);
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j]!, real[i]!];
  }
  for (let size = 2; size <= N; size *= 2) {
    for (let start = 0; start < N; start += size) {
      for (let j = 0; j < size / 2; j++) {
        const angle = -2 * Math.PI * j / size, a = start + j, b = a + size / 2;
        const re = real[b]! * Math.cos(angle) - imag[b]! * Math.sin(angle);
        const im = real[b]! * Math.sin(angle) + imag[b]! * Math.cos(angle);
        real[b] = real[a]! - re; imag[b] = imag[a]! - im;
        real[a] = real[a]! + re; imag[a] = imag[a]! + im;
      }
    }
  }
  const power = Array.from({ length: N / 2 }, (_, i) => real[i]! ** 2 + imag[i]! ** 2 + 1e-12);
  let total = 0, logs = 0, highest = 0, bin = 0;
  for (let i = 4; i < power.length; i++) {
    total += power[i]!; logs += Math.log(power[i]!);
    if (power[i]! > highest) { highest = power[i]!; bin = i; }
  }
  let pitch = 0, correlation = 0;
  // Normalized autocorrelation rejects unvoiced noise and most claps.
  let previous = -1, beforePrevious = -1;
  for (let lag = 39; lag <= 201; lag++) {
    let cross = 0, a = 0, b = 0;
    for (let i = 0; i < N - lag; i++) {
      cross += samples[i]! * samples[i + lag]!;
      a += samples[i]! ** 2; b += samples[i + lag]! ** 2;
    }
    const score = cross / Math.sqrt(a * b + 1e-20);
    if (lag >= 40 && lag <= 200 && score > correlation) { correlation = score; pitch = 16000 / lag; }
    if (lag > 40 && previous > 0.85 && previous > beforePrevious && previous >= score) {
      correlation = previous; pitch = 16000 / (lag - 1); break;
    }
    beforePrevious = previous; previous = score;
  }
  let voice: number[] | null = null;
  if (rms >= 0.008 && peak < 0.98 && correlation >= 0.55 && pitch >= 80 && pitch <= 400) {
    const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
    const hz = (m: number) => 700 * (10 ** (m / 2595) - 1);
    const bins = Array.from({ length: 26 }, (_, i) => hz(mel(80) + i * (mel(7600) - mel(80)) / 25) * N / 16000);
    const bands = Array.from({ length: 24 }, (_, band) => {
      let sum = 0;
      for (let i = Math.ceil(bins[band]!); i < bins[band + 2]!; i++) {
        const weight = i < bins[band + 1]! ? (i - bins[band]!) / (bins[band + 1]! - bins[band]!)
          : (bins[band + 2]! - i) / (bins[band + 2]! - bins[band + 1]!);
        sum += weight * power[i]!;
      }
      return Math.log(sum / (total + 1e-12) + 1e-10);
    });
    voice = Array.from({ length: 12 }, (_, k) =>
      bands.reduce((sum, value, i) => sum + value * Math.cos(Math.PI * (k + 1) * (i + 0.5) / 24), 0) / 24);
    voice.push(Math.log(pitch));
  }
  return { at: frame.at, duration: frame.samples.length / frame.sampleRate * 1000, rms, peak,
    flatness: Math.exp(logs / (power.length - 4)) / (total / (power.length - 4) + 1e-20),
    dominantHz: bin * 16000 / N, dominance: highest / (total + 1e-20), pitch, voice };
}

export function enrollVoice(features: AudioFeatures[]): VoiceProfile {
  const voiced = features.filter((f) => f.voice !== null);
  if (voiced.length < 35 || voiced.reduce((sum, f) => sum + f.duration, 0) < 2500)
    throw new Error('Not enough clear speech. Record again in a quiet place and speak throughout the sample.');
  const mean = Array.from({ length: COEFFICIENTS }, (_, i) => voiced.reduce((s, f) => s + f.voice![i]!, 0) / voiced.length);
  const spread = mean.map((m, i) => Math.max(i === 12 ? 0.08 : 0.16,
    Math.sqrt(voiced.reduce((s, f) => s + (f.voice![i]! - m) ** 2, 0) / voiced.length)));
  return { version: 1, mean, spread, frames: voiced.length };
}

export function validateVoiceProfile(value: unknown): VoiceProfile {
  if (!value || typeof value !== 'object') throw new Error('Invalid voice sample. Record a new sample.');
  const v = value as VoiceProfile;
  if (v.version !== 1 || !Number.isSafeInteger(v.frames) || v.frames < 35
    || !Array.isArray(v.mean) || !Array.isArray(v.spread) || v.mean.length !== COEFFICIENTS || v.spread.length !== COEFFICIENTS
    || v.mean.some((n) => !Number.isFinite(n)) || v.spread.some((n) => !Number.isFinite(n) || n <= 0))
    throw new Error('Invalid voice sample. Record a new sample.');
  return { version: 1, mean: [...v.mean], spread: [...v.spread], frames: v.frames };
}

export function matchesVoice(feature: AudioFeatures, profile: VoiceProfile): boolean {
  if (!feature.voice) return false;
  const distance = feature.voice.reduce((sum, v, i) => sum + Math.min(25, ((v - profile.mean[i]!) / profile.spread[i]!) ** 2), 0) / COEFFICIENTS;
  return distance < 2.3 && Math.abs(feature.voice[12]! - profile.mean[12]!) < Math.max(0.20, profile.spread[12]! * 2);
}

/** Fail closed: an unrelated recent voice match cannot authorize another utterance. */
export function verifyUtterance(features: AudioFeatures[], profile: VoiceProfile, from: number, to: number): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 14000) return false;
  const frames = features.filter((f) => f.at >= from && f.at <= to + 100);
  if (!frames.length || frames[0]!.at - frames[0]!.duration > from + 350 || frames.at(-1)!.at < to - 350) return false;
  if (frames.some((f, i) => i > 0 && f.at - frames[i - 1]!.at > 350)) return false;
  const voiced = frames.filter((f) => f.voice !== null);
  return voiced.length >= 4 && voiced.filter((f) => matchesVoice(f, profile)).length / voiced.length >= 0.85;
}

/** Conservative acoustic heuristics, not a trained environmental-sound classifier. */
export function detectSound(features: AudioFeatures[]): 'applause' | 'whistle' | undefined {
  const last = features.at(-1);
  if (!last) return undefined;
  const recent = features.filter((f) => last.at - f.at < 1800);
  if (recent.length < 12) return undefined;
  const whistles = recent.filter((f) => f.rms > 0.012 && f.dominantHz >= 1400 && f.dominantHz <= 4200 && f.dominance > 0.35);
  if (whistles.length >= 7 && whistles.at(-1)!.at - whistles[0]!.at >= 400
    && Math.max(...whistles.map((f) => f.dominantHz)) - Math.min(...whistles.map((f) => f.dominantHz)) < 500) return 'whistle';
  let bursts = 0, previous = false;
  for (const f of recent) {
    const impulse = f.rms > 0.025 && f.peak > f.rms * 2.8 && f.flatness > 0.16 && f.voice === null;
    if (impulse && !previous) bursts++;
    previous = impulse;
  }
  if (bursts >= 4) return 'applause';
  return undefined;
}
