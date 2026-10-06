import {
  Cmd, buildConnect, buildContinueFrames, buildDimming, buildDisplayEnable, buildEndStream,
  buildGifStream, buildImageStream, buildStartStream, buildTestPass, parseNotification, type RgbImage,
} from '../protocol/framing';
import { SelectionCancelledError, SPIKE_PROFILE, type Transport, type TransportProfile } from '../transport/types';

export type DeviceState =
  | 'Disconnected' | 'Selecting' | 'Connecting' | 'Handshaking' | 'Ready' | 'Uploading' | 'Error';

export type UploadResult = 'confirmed' | 'sent-unconfirmed';

export interface Timeouts { handshakeMs: number; startMs: number; chunkMs: number; endMs: number; controlMs: number }
export const DEFAULT_TIMEOUTS: Timeouts = { handshakeMs: 2000, startMs: 2000, chunkMs: 500, endMs: 1000, controlMs: 500 };

export class DeviceError extends Error {
  constructor(message: string, readonly kind: 'timeout' | 'denied' | 'protocol' | 'disconnected' | 'cancelled' | 'busy' | 'invalid') {
    super(message);
    this.name = 'DeviceError';
  }
}

interface Pending {
  cmd: number;
  validate?: (body: Uint8Array) => void;
  resolve: (body: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DeviceControllerOptions {
  profile?: TransportProfile;
  timeouts?: Timeouts;
  sleep?: (ms: number) => Promise<void>;
  /** Raw byte trace for diagnostics: tx = written frame, rx = notification, ev = lifecycle event. */
  onTrace?: (dir: 'tx' | 'rx' | 'ev', label: string, data?: Uint8Array) => void;
}

export class DeviceController {
  private _state: DeviceState = 'Disconnected';
  private _error: string | null = null;
  private transport: Transport | null = null;
  private unsubs: Array<() => void> = [];
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private cancelled = false;
  private listeners = new Set<() => void>();
  /** Bumped on every connect/disconnect so stale async work can detect it. */
  private epoch = 0;
  readonly profile: TransportProfile;
  readonly timeouts: Timeouts;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly trace: NonNullable<DeviceControllerOptions['onTrace']>;
  progress: { sent: number; total: number } | null = null;

  constructor(opts: DeviceControllerOptions = {}) {
    this.profile = opts.profile ?? SPIKE_PROFILE;
    this.timeouts = opts.timeouts ?? DEFAULT_TIMEOUTS;
    this.trace = opts.onTrace ?? (() => {});
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get state() { return this._state; }
  get error() { return this._error; }
  subscribe(cb: () => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  private setState(s: DeviceState, error: string | null = null) {
    this._state = s;
    this._error = error;
    this.listeners.forEach((cb) => cb());
  }

  // ---- connection lifecycle -------------------------------------------------

  /** `connector` runs the chooser (must start in the tap's call stack) and returns a transport. */
  async connect(connector: () => Promise<Transport>): Promise<void> {
    if (this._state !== 'Disconnected' && this._state !== 'Error')
      throw new DeviceError('Already connected or connecting', 'busy');
    const epoch = ++this.epoch;
    this.setState('Selecting');
    let transport: Transport;
    try {
      transport = await connector();
    } catch (e) {
      if (e instanceof SelectionCancelledError) this.setState('Disconnected'); // not a fault
      else this.setState('Error', errMsg(e));
      return;
    }
    if (epoch !== this.epoch) { transport.disconnect(); return; }
    this.setState('Connecting');
    this.transport = transport;
    this.unsubs = [
      transport.onNotification((d) => this.handleNotification(d)),
      transport.onDisconnect(() => this.handleDrop(epoch)),
    ];
    try {
      this.setState('Handshaking');
      await this.exclusive(() => this.handshake());
      if (epoch !== this.epoch) return;
      this.setState('Ready');
    } catch (e) {
      if (epoch !== this.epoch) return;
      this.epoch++;
      this.teardown();
      transport.disconnect();
      this.setState('Error', errMsg(e));
    }
  }

  disconnect(): void {
    this.epoch++;
    const t = this.transport;
    this.teardown();
    t?.disconnect();
    this.setState('Disconnected');
  }

  private handleDrop(epoch: number) {
    if (epoch !== this.epoch) return;
    this.epoch++;
    this.trace('ev', 'GATT disconnected by hat/Android');
    this.teardown();
    this.setState('Disconnected', 'Connection lost. Reconnect to continue.');
  }

  /** Cancel waits/writes and clear notification state. Unsent artwork lives in the UI. */
  private teardown() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.transport = null;
    this.rejectPending(new DeviceError('Disconnected', 'disconnected'));
    this.progress = null;
  }

  private async handshake() {
    await this.request(buildConnect(), 'cmd', Cmd.CONNECT, this.timeouts.handshakeMs);
    const body = await this.request(buildTestPass(), 'cmd', Cmd.TEST_PASS, this.timeouts.handshakeMs);
    // Reference: last body byte is the PassCheck: 0x01 correct, 0x03 unset, 0x00 observed no-password/OK, 0x02 denied.
    const status = body[body.length - 1];
    if (status === 0x02) throw new DeviceError('The hat is password protected and denied access', 'denied');
    if (status !== 0x00 && status !== 0x01 && status !== 0x03)
      throw new DeviceError(`Unrecognized password response 0x${(status ?? 0).toString(16)}`, 'protocol');
  }

  // ---- operations -------------------------------------------------------------

  /** Serializes whole operations; nothing interleaves with an upload's writes. */
  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async upload(img: RgbImage): Promise<UploadResult> {
    return this.uploadStream(buildImageStream(img, this.profile.maxStreamBytes));
  }

  /** Looping GIF (e.g. a scrolling marquee) played by the hat itself. */
  async uploadGif(gif: Uint8Array, width: number, height: number): Promise<UploadResult> {
    return this.uploadStream(buildGifStream(gif, width, height, this.profile.maxStreamBytes));
  }

  private async uploadStream({ bytes, crc }: { bytes: Uint8Array; crc: number }): Promise<UploadResult> {
    // Validate everything before any BLE write.
    const frames = buildContinueFrames(bytes, this.profile.chunkSize);
    const start = buildStartStream(crc, bytes.length);
    const end = buildEndStream();

    return this.exclusive(async () => {
      if (this._state !== 'Ready') throw new DeviceError('Not connected', 'disconnected');
      const epoch = this.epoch;
      this.cancelled = false;
      this.setState('Uploading');
      this.progress = { sent: 0, total: frames.length };
      this.listeners.forEach((cb) => cb());
      let result: UploadResult = 'confirmed';
      try {
        await this.request(start, 'cmd', Cmd.START_STREAM, this.timeouts.startMs);
        for (let seq = 0; seq < frames.length; seq++) {
          this.checkCancel(epoch);
          const frame = frames[seq]!;
          try {
            await this.request(frame, 'data', Cmd.CONTINUE, this.timeouts.chunkMs, (body) => {
              // If the ack echoes a sequence number (first 4 bytes), it must be ours.
              if (body.length >= 4) {
                const got = ((body[0]! << 24) | (body[1]! << 16) | (body[2]! << 8) | body[3]!) >>> 0;
                if (got !== seq) throw new DeviceError(`Ack for chunk ${got}, expected ${seq}`, 'protocol');
              }
              // Observed hat ack: seq(4) + status(1), status 0x01 = accepted.
              if (body.length >= 5 && body[4] !== 0x01)
                throw new DeviceError(`Chunk ${seq} rejected (status 0x${body[4]!.toString(16)})`, 'protocol');
            });
          } catch (e) {
            if (e instanceof DeviceError && e.kind === 'timeout' && this.profile.allowMissingChunkAcks) {
              result = 'sent-unconfirmed';
            } else throw e;
          }
          this.progress = { sent: seq + 1, total: frames.length };
          this.listeners.forEach((cb) => cb());
        }
        this.checkCancel(epoch);
        await this.request(end, 'data', Cmd.END_STREAM, this.timeouts.endMs);
      } catch (e) {
        this.trace('ev', 'upload failed: ' + errMsg(e));
        if (epoch === this.epoch) {
          // Never leave a reusable but ambiguous session after a partial upload.
          const t = this.transport;
          this.epoch++;
          this.teardown();
          t?.disconnect();
          const cancelled = e instanceof DeviceError && e.kind === 'cancelled';
          this.setState('Disconnected', cancelled ? 'Upload cancelled; reconnect to continue.' : `Upload unconfirmed: ${errMsg(e)}. Reconnect and send the full image again.`);
        }
        throw e;
      }
      if (epoch === this.epoch) { this.progress = null; this.setState('Ready'); }
      return result;
    });
  }

  cancelUpload() { this.cancelled = true; }

  private checkCancel(epoch: number) {
    if (epoch !== this.epoch) throw new DeviceError('Disconnected', 'disconnected');
    if (this.cancelled) throw new DeviceError('Upload cancelled', 'cancelled');
  }

  async setBrightness(level: number): Promise<UploadResult> {
    const frame = buildDimming(level);
    return this.control(frame, Cmd.DIMMING);
  }

  async setDisplay(on: boolean): Promise<UploadResult> {
    return this.control(buildDisplayEnable(on), Cmd.DISPLAY_ENABLE);
  }

  /** 'sent-unconfirmed' means written but no ack: the UI must show it as pending, not applied. */
  private control(frame: Uint8Array, cmd: number): Promise<UploadResult> {
    return this.exclusive(async () => {
      if (this._state !== 'Ready') throw new DeviceError('Not connected', 'disconnected');
      try {
        await this.request(frame, 'cmd', cmd, this.timeouts.controlMs);
        return 'confirmed' as const;
      } catch (e) {
        if (e instanceof DeviceError && e.kind === 'timeout') return 'sent-unconfirmed' as const;
        throw e;
      }
    });
  }

  // ---- request/response -----------------------------------------------------

  /** Installs the pending wait BEFORE writing so a fast notification is never lost. */
  private async request(
    frame: Uint8Array, channel: 'cmd' | 'data', expectCmd: number, timeoutMs: number,
    validate?: (body: Uint8Array) => void,
  ): Promise<Uint8Array> {
    const t = this.transport;
    if (!t) throw new DeviceError('Disconnected', 'disconnected');
    if (this.pending) throw new DeviceError('Overlapping request', 'busy');
    const reply = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.timer === timer) this.pending = null;
        reject(new DeviceError(`No reply to command 0x${expectCmd.toString(16)} within ${timeoutMs} ms`, 'timeout'));
      }, timeoutMs);
      this.pending = { cmd: expectCmd, validate, resolve, reject, timer };
    });
    reply.catch(() => undefined); // avoid unhandled rejection if the write itself fails first
    this.trace('tx', channel === 'cmd' ? 'A951' : 'A952', frame);
    try {
      await (channel === 'cmd' ? t.writeCommand(frame) : t.writeData(frame));
      if (this.profile.interWriteDelayMs) await this.sleep(this.profile.interWriteDelayMs);
    } catch (e) {
      this.rejectPending(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    return reply;
  }

  private handleNotification(data: Uint8Array) {
    this.trace('rx', this.pending ? 'A953' : 'A953 (unsolicited/stale)', data);
    const p = this.pending;
    if (!p) return; // stale or unsolicited: ignore, never counts as success
    let body: Uint8Array;
    try {
      const n = parseNotification(data);
      if (n.cmd !== p.cmd) throw new DeviceError(`Unexpected reply 0x${n.cmd.toString(16)}, expected 0x${p.cmd.toString(16)}`, 'protocol');
      p.validate?.(n.body);
      body = n.body;
    } catch (e) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(e instanceof DeviceError ? e : new DeviceError((e as Error).message, 'protocol'));
      return;
    }
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(body);
  }

  private rejectPending(e: Error) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(e);
  }
}

function errMsg(e: unknown) { return e instanceof Error ? e.message : String(e); }
