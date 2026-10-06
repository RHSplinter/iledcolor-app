import { OPCODE, u16sum } from '../protocol/framing';
import type { Transport } from './types';

export function makeAck(cmd: number, body: number[]): Uint8Array {
  const out = [OPCODE, cmd, 0, body.length + 2, ...body];
  const s = u16sum(out);
  return Uint8Array.from([...out, s >> 8, s & 0xff]);
}

/** Real-hat Continue ack: length field counts the body only (not the checksum). */
export function makeContinueAck(seq: ArrayLike<number>, status: number): Uint8Array {
  const out = [OPCODE, 0x00, 0, 5, seq[0]!, seq[1]!, seq[2]!, seq[3]!, status];
  const s = u16sum(out);
  return Uint8Array.from([...out, s >> 8, s & 0xff]);
}

export interface MockOptions {
  /** Return the notification(s) to emit for a written frame; default echoes a success ack. */
  reply?: (channel: 'cmd' | 'data', frame: Uint8Array, index: number) => Uint8Array[] | null;
  /** Emit replies synchronously inside the write (tests the pending-before-write rule). */
  syncReplies?: boolean;
}

/** Scriptable in-memory hat for deterministic tests and the Playwright/dev mock mode. */
export class MockTransport implements Transport {
  writes: Array<{ channel: 'cmd' | 'data'; frame: Uint8Array }> = [];
  inFlight = 0;
  maxInFlight = 0;
  disconnected = false;
  private notes = new Set<(d: Uint8Array) => void>();
  private drops = new Set<() => void>();

  constructor(private opts: MockOptions = {}) {}

  private async write(channel: 'cmd' | 'data', frame: Uint8Array) {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const index = this.writes.length;
    this.writes.push({ channel, frame: frame.slice() });
    const replies = this.opts.reply ? this.opts.reply(channel, frame, index) : [defaultAck(frame)];
    const emit = () => replies?.forEach((r) => this.emit(r));
    if (this.opts.syncReplies) emit(); else queueMicrotask(emit);
    await Promise.resolve();
    this.inFlight--;
  }
  writeCommand(d: Uint8Array) { return this.write('cmd', d); }
  writeData(d: Uint8Array) { return this.write('data', d); }
  emit(d: Uint8Array) { this.notes.forEach((cb) => cb(d)); }
  onNotification(cb: (d: Uint8Array) => void) { this.notes.add(cb); return () => this.notes.delete(cb); }
  onDisconnect(cb: () => void) { this.drops.add(cb); return () => this.drops.delete(cb); }
  disconnect() { this.disconnected = true; }
  /** Simulate range loss / hat power-off. */
  drop() { this.drops.forEach((cb) => cb()); }
}

/** Ack that echoes the command byte; Continue acks echo the sequence number. */
export function defaultAck(frame: Uint8Array): Uint8Array {
  const cmd = frame[1]!;
  if (cmd === 0x00) return makeContinueAck(frame.subarray(4, 8), 1);
  return makeAck(cmd, [0x01]);
}
