import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { AudioFrame } from './analysis';
import type { Language } from './dictionary';

export interface Phrase { text: string; from: number; to: number }
export interface SoundCapabilities { speech: boolean; proximity: boolean }
interface NativeSound {
  capabilities(): Promise<SoundCapabilities>;
  start(options: { language: Language; speech: boolean }): Promise<void>;
  stop(): Promise<void>;
  addListener(name: string, cb: (event: never) => void): Promise<PluginListenerHandle>;
}
const Native = registerPlugin<NativeSound>('SoundDetection');
interface SpeechResult { isFinal: boolean; 0: { transcript: string } }
interface BrowserSpeech {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; abort(): void;
}
type SpeechConstructor = new () => BrowserSpeech;
const speechConstructor = () => {
  const scope = window as Window & { SpeechRecognition?: SpeechConstructor; webkitSpeechRecognition?: SpeechConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
};
export interface CaptureCallbacks {
  audio(frame: AudioFrame): void;
  phrase(event: Phrase): void;
  proximity(near: boolean): void;
  error(error: Error): void;
  ended(): void;
}

export class SoundCapture {
  private generation = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private worklet?: AudioWorkletNode;
  private speech?: BrowserSpeech;
  private listeners: PluginListenerHandle[] = [];
  private native = Capacitor.isNativePlatform();
  async capabilities(): Promise<SoundCapabilities> {
    if (this.native) {
      if (!Capacitor.isPluginAvailable('SoundDetection')) throw new Error('Native audio plugin missing. Rebuild and synchronize the app.');
      return Native.capabilities();
    }
    return { speech: !!speechConstructor(), proximity: false };
  }

  async start(language: Language, phrases: boolean, callbacks: CaptureCallbacks): Promise<void> {
    const generation = ++this.generation;
    if (this.native) {
      const add = async (name: string, cb: (event: never) => void) => {
        const handle = await Native.addListener(name, (event) => { if (generation === this.generation) cb(event); });
        if (generation !== this.generation) await handle.remove();
        else this.listeners.push(handle);
      };
      await add('audio', callbacks.audio);
      await add('phrase', callbacks.phrase);
      await add('proximity', (event: { near: boolean }) => callbacks.proximity(event.near));
      await add('error', (event: { message: string }) => callbacks.error(new Error(event.message)));
      await add('ended', callbacks.ended);
      if (generation !== this.generation) return;
      await Native.start({ language, speech: phrases });
      if (generation !== this.generation) await Native.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error('Microphone capture requires HTTPS and a supported browser.');
    const context = new AudioContext({ sampleRate: 16000 });
    this.context = context;
    await context.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    stream.getAudioTracks().forEach((track) => { track.onended = () => {
      if (generation === this.generation) callbacks.error(new Error('Microphone access ended. Start listening again.'));
    }; });
    await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}sound-worklet.js`);
    if (generation !== this.generation) return;
    const node = new AudioWorkletNode(context, 'sound-capture');
    this.worklet = node;
    node.port.onmessage = (event: MessageEvent<Omit<AudioFrame, 'at'>>) => {
      if (generation === this.generation) callbacks.audio({ ...event.data, at: Date.now() });
    };
    const source = context.createMediaStreamSource(stream);
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(node).connect(silent).connect(context.destination);
    context.onstatechange = () => {
      if (generation === this.generation && context.state !== 'running')
        callbacks.error(new Error('Audio capture was suspended. Keep the app in the foreground and restart listening.'));
    };
    if (phrases) {
      const Constructor = speechConstructor();
      if (!Constructor) throw new Error('Speech recognition is unavailable in this browser. Use sound detection only.');
      const recognition = new Constructor();
      this.speech = recognition;
      recognition.lang = language; recognition.continuous = true; recognition.interimResults = false;
      let from = Date.now();
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]!;
          if (result.isFinal && generation === this.generation) {
            const to = Date.now();
            callbacks.phrase({ text: result[0].transcript, from, to });
            from = to;
          }
        }
      };
      recognition.onerror = (event) => {
        if (generation === this.generation) callbacks.error(new Error(`Browser speech recognition: ${event.error}. Restart or use sounds only.`));
      };
      recognition.onend = () => { if (generation === this.generation) callbacks.ended(); };
      recognition.start();
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    this.speech?.abort(); this.speech = undefined;
    this.worklet?.disconnect(); this.worklet = undefined;
    this.stream?.getTracks().forEach((track) => track.stop()); this.stream = undefined;
    const context = this.context; this.context = undefined;
    if (context && context.state !== 'closed') await context.close();
    const listeners = this.listeners.splice(0);
    try { if (this.native) await Native.stop(); }
    finally { await Promise.all(listeners.map((listener) => listener.remove())); }
  }
}
