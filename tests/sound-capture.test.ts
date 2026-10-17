import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false }, registerPlugin: () => ({}),
}));
import { SoundCapture, type CaptureCallbacks } from '../src/sound/capture';

const track = { stop: vi.fn(), onended: null };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
const getUserMedia = vi.fn(async () => stream);
class FakeContext {
  static instances: FakeContext[] = [];
  state = 'running';
  destination = {};
  onstatechange: (() => void) | null = null;
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  constructor() { FakeContext.instances.push(this); }
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn(async () => { this.state = 'closed'; this.onstatechange?.(); });
  createMediaStreamSource() { return { connect: (node: unknown) => node }; }
  createGain() { return { gain: { value: 1 }, connect: vi.fn() }; }
}
class FakeWorklet {
  port = { onmessage: null };
  connect(node: unknown) { return node; }
  disconnect = vi.fn();
}
const callbacks = (): CaptureCallbacks => ({ audio: vi.fn(), phrase: vi.fn(), proximity: vi.fn(), error: vi.fn(), ended: vi.fn() });

describe('web microphone lifecycle', () => {
  beforeEach(() => {
    FakeContext.instances = [];
    vi.stubGlobal('window', { AudioContext: FakeContext });
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('AudioWorkletNode', FakeWorklet);
    getUserMedia.mockReset().mockResolvedValue(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    track.stop.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());
  it('does not request permission for capabilities and closes tracks/context on stop', async () => {
    const capture = new SoundCapture();
    expect(await capture.capabilities()).toEqual({ speech: false, proximity: false });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    const cb = callbacks();
    await capture.start('en-US', false, cb);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    await capture.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(FakeContext.instances[0]!.close).toHaveBeenCalledOnce();
    expect(cb.error).not.toHaveBeenCalled();
  });
  it('disposes a late permission result instead of resurrecting capture after stop', async () => {
    let grant!: (value: typeof stream) => void;
    getUserMedia.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
    const capture = new SoundCapture();
    const starting = capture.start('en-US', false, callbacks());
    await vi.waitFor(() => expect(grant).toBeTypeOf('function'));
    await capture.stop();
    grant(stream);
    await starting;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(FakeContext.instances[0]!.state).toBe('closed');
  });
  it('surfaces suspension and device revocation instead of pretending to listen', async () => {
    const capture = new SoundCapture(), cb = callbacks();
    await capture.start('de-DE', false, cb);
    const context = FakeContext.instances[0]!;
    context.state = 'suspended'; context.onstatechange?.();
    expect(cb.error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('suspended') }));
    await capture.stop();
  });
  it('reports permission failure and allows cleanup', async () => {
    getUserMedia.mockRejectedValue(new Error('permission denied'));
    const capture = new SoundCapture();
    await expect(capture.start('de-DE', false, callbacks())).rejects.toThrow('permission denied');
    await capture.stop();
    expect(FakeContext.instances[0]!.state).toBe('closed');
  });
});
