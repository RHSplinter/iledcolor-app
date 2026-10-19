import { crc32c } from '../protocol/crc32c';
import { validateContent, validateGroups, type Content, type GroupContent, type Preset } from '../storage/presets';

/**
 * Preset sharing between two nearby phones running approach mode, over the approach GATT service.
 *
 *  1. The sender connects to the receiver's phone and writes an OFFER (sender, preset name, kind, size,
 *     CRC; no preset content) to the inbox characteristic.
 *  2. The receiver asks its user. The decision is published in the status characteristic, which the
 *     sender polls.
 *  3. Only after "accepted" does the sender write the preset (DATA). The receiver ignores DATA for any
 *     transfer its user has not accepted, so nothing is transferred or stored without consent.
 *
 * Inbox packets: [type u8][transfer id u32][offset u32][total u32][bytes], or [CANCEL][transfer id u32].
 * Status value:  up to STATUS_ENTRIES × [transfer id u32][state u8] (most recent transfers).
 */
export const SHARE_INBOX = '4c454448-1000-4000-8000-000000000020';
export const SHARE_STATUS = '4c454448-1000-4000-8000-000000000021';

export const ShareState = { None: 0, Pending: 1, Accepted: 2, Declined: 3, Received: 4, Failed: 5, Busy: 6, Cancelled: 7 } as const;
export type ShareStateValue = (typeof ShareState)[keyof typeof ShareState];

const PKT_OFFER = 1;
const PKT_DATA = 2;
const PKT_CANCEL = 3;
const HEADER = 13;
const STATUS_ENTRIES = 8;
export const MAX_OFFER_BYTES = 1024;
export const MAX_SHARE_BYTES = 2 * 1024 * 1024;
/** The receiver declines automatically when its user does not answer in time; the sender waits a bit longer. */
export const ACCEPT_TIMEOUT_MS = 60_000;
/** An accepted transfer fails when no data arrives for this long. */
export const DATA_IDLE_MS = 20_000;

export type ShareKind = Content['kind'] | 'group';
export interface ShareOffer {
  transferId: number;
  fromPhoneId: number;
  /** Sender's display name (may be empty). */
  fromName: string;
  name: string;
  kind: ShareKind;
  size: number;
  crc: number;
}
export type SharedPreset = { name: string; content: Content } | { name: string; groups: GroupContent };

// ---------- codec -----------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isU32 = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;
const KINDS: ShareKind[] = ['solid', 'text', 'image', 'sequence', 'group'];

export function encodeSharedPreset(p: Preset): Uint8Array {
  const body: SharedPreset = 'groups' in p ? { name: p.name, groups: p.groups } : { name: p.name, content: p.content };
  return new TextEncoder().encode(JSON.stringify(body));
}

/** Strictly validates a received preset; never trusts the sender. */
export function decodeSharedPreset(data: Uint8Array): SharedPreset {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); } catch { throw new Error('Shared preset is not valid'); }
  if (!isObj(raw)) throw new Error('Shared preset is not valid');
  const name = validName(raw.name);
  if ('groups' in raw) {
    if ('content' in raw) throw new Error('Shared preset is not valid');
    return { name, groups: validateGroups(raw.groups) };
  }
  return { name, content: validateContent(raw.content) };
}

function validName(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 60) throw new Error('Invalid preset name');
  return v;
}

export const sharedKind = (p: SharedPreset | Preset): ShareKind => ('groups' in p ? 'group' : p.content.kind);

export function encodeOffer(o: ShareOffer): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, from: o.fromPhoneId, sender: o.fromName, name: o.name, kind: o.kind, size: o.size, crc: o.crc }));
}

export function decodeOffer(transferId: number, data: Uint8Array): ShareOffer {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); } catch { throw new Error('Invalid offer'); }
  if (!isObj(raw) || raw.v !== 1 || !isU32(raw.from) || !isU32(raw.crc) || !KINDS.includes(raw.kind as ShareKind)
    || !Number.isInteger(raw.size) || (raw.size as number) < 1 || (raw.size as number) > MAX_SHARE_BYTES
    || typeof raw.sender !== 'string' || raw.sender.length > 40) throw new Error('Invalid offer');
  return { transferId, fromPhoneId: raw.from, fromName: raw.sender.trim(), name: validName(raw.name), kind: raw.kind as ShareKind, size: raw.size as number, crc: raw.crc };
}

/** Splits a stream into inbox packets that each fit one ATT write (`maxWrite` = MTU − 3). */
export function encodeChunks(type: typeof PKT_OFFER | typeof PKT_DATA, transferId: number, bytes: Uint8Array, maxWrite: number): Uint8Array[] {
  const step = Math.max(1, Math.min(512, maxWrite) - HEADER);
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += step) {
    const data = bytes.subarray(offset, offset + step);
    const p = new Uint8Array(HEADER + data.length);
    const v = new DataView(p.buffer);
    p[0] = type;
    v.setUint32(1, transferId);
    v.setUint32(5, offset);
    v.setUint32(9, bytes.length);
    p.set(data, HEADER);
    out.push(p);
  }
  return out;
}

export function encodeCancel(transferId: number): Uint8Array {
  const p = new Uint8Array(5);
  p[0] = PKT_CANCEL;
  new DataView(p.buffer).setUint32(1, transferId);
  return p;
}

type Packet = { type: typeof PKT_OFFER | typeof PKT_DATA; tid: number; offset: number; total: number; data: Uint8Array } | { type: typeof PKT_CANCEL; tid: number };

export function decodePacket(p: Uint8Array): Packet | null {
  if (p.length < 5) return null;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const tid = v.getUint32(1);
  if (p[0] === PKT_CANCEL) return p.length === 5 ? { type: PKT_CANCEL, tid } : null;
  if ((p[0] !== PKT_OFFER && p[0] !== PKT_DATA) || p.length <= HEADER) return null;
  return { type: p[0], tid, offset: v.getUint32(5), total: v.getUint32(9), data: p.subarray(HEADER) };
}

export function encodeStatus(entries: [number, ShareStateValue][]): Uint8Array {
  const recent = entries.slice(-STATUS_ENTRIES);
  const out = new Uint8Array(recent.length * 5);
  const v = new DataView(out.buffer);
  recent.forEach(([tid, state], i) => { v.setUint32(i * 5, tid); out[i * 5 + 4] = state; });
  return out;
}

export function decodeStatus(data: Uint8Array, transferId: number): ShareStateValue {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i + 5 <= data.length; i += 5)
    if (v.getUint32(i) === transferId) return (data[i + 4]! <= ShareState.Cancelled ? data[i + 4]! : ShareState.Failed) as ShareStateValue;
  return ShareState.None;
}

// ---------- receiver --------------------------------------------------------------

export interface ReceiverHooks {
  /** Publishes the status value for senders to read (native GATT characteristic). */
  publishStatus(value: Uint8Array): void;
  /** A complete offer arrived: ask the user (accept/decline). */
  onOffer(offer: ShareOffer): void;
  onProgress?(offer: ShareOffer, received: number): void;
  /** The accepted preset arrived and was validated; store it. Throwing marks the transfer failed. */
  onReceived(offer: ShareOffer, preset: SharedPreset): Promise<void> | void;
  /** The offer ended without a stored preset (cancelled, timed out, failed); `message` explains it. */
  onClosed(offer: ShareOffer, state: ShareStateValue, message: string): void;
}

interface Stream { total: number; buf: Uint8Array; received: number; at: number }

/** Accepts one incoming offer at a time; further offers get "busy" until it is finished. */
export class ShareReceiver {
  private states = new Map<number, ShareStateValue>();
  private offerStreams = new Map<number, Stream>();
  private active?: { offer: ShareOffer; state: ShareStateValue; since: number; data?: Stream };

  constructor(private hooks: ReceiverHooks, private now: () => number = Date.now) {}

  get current(): { offer: ShareOffer; state: ShareStateValue; received: number } | undefined {
    return this.active && { offer: this.active.offer, state: this.active.state, received: this.active.data?.received ?? 0 };
  }

  handleWrite(value: Uint8Array): void {
    const p = decodePacket(value);
    if (!p) return;
    if (p.type === PKT_CANCEL) {
      this.offerStreams.delete(p.tid);
      if (this.active?.offer.transferId === p.tid) this.close(ShareState.Cancelled, 'The sender cancelled.');
      return;
    }
    if (p.type === PKT_DATA) {
      // Content is only taken for the offer the user accepted.
      const a = this.active;
      if (!a || a.offer.transferId !== p.tid || a.state !== ShareState.Accepted || p.total !== a.offer.size) return;
      a.data ??= { total: p.total, buf: new Uint8Array(p.total), received: 0, at: this.now() };
      if (!this.append(a.data, p.offset, p.data)) { this.close(ShareState.Failed, 'Transfer was interrupted.'); return; }
      this.hooks.onProgress?.(a.offer, a.data.received);
      if (a.data.received === a.data.total) void this.finish(a.offer, a.data.buf);
      return;
    }
    if (this.states.has(p.tid) && !this.offerStreams.has(p.tid)) return; // retransmitted offer we already answered
    if (p.total > MAX_OFFER_BYTES) { this.setState(p.tid, ShareState.Failed); return; }
    let s = this.offerStreams.get(p.tid);
    if (!s) {
      if (p.offset !== 0) return;
      if (this.offerStreams.size >= 4) this.offerStreams.delete(this.offerStreams.keys().next().value!);
      s = { total: p.total, buf: new Uint8Array(p.total), received: 0, at: this.now() };
      this.offerStreams.set(p.tid, s);
    }
    if (p.total !== s.total || !this.append(s, p.offset, p.data)) { this.offerStreams.delete(p.tid); this.setState(p.tid, ShareState.Failed); return; }
    if (s.received < s.total) return;
    this.offerStreams.delete(p.tid);
    let offer: ShareOffer;
    try { offer = decodeOffer(p.tid, s.buf); } catch { this.setState(p.tid, ShareState.Failed); return; }
    if (this.active) { this.setState(p.tid, ShareState.Busy); return; }
    this.active = { offer, state: ShareState.Pending, since: this.now() };
    this.setState(p.tid, ShareState.Pending);
    this.hooks.onOffer(offer);
  }

  accept(transferId: number): void {
    const a = this.active;
    if (!a || a.offer.transferId !== transferId || a.state !== ShareState.Pending) return;
    a.state = ShareState.Accepted;
    a.since = this.now();
    this.setState(transferId, ShareState.Accepted);
  }

  decline(transferId: number): void {
    if (this.active?.offer.transferId !== transferId || this.active.state !== ShareState.Pending) return;
    this.active = undefined;
    this.setState(transferId, ShareState.Declined);
  }

  /** Expires unanswered offers and stalled transfers; call about once per second. */
  tick(): void {
    const now = this.now();
    for (const [tid, s] of this.offerStreams) if (now - s.at > DATA_IDLE_MS) this.offerStreams.delete(tid);
    const a = this.active;
    if (!a) return;
    if (a.state === ShareState.Pending && now - a.since > ACCEPT_TIMEOUT_MS) this.close(ShareState.Declined, 'Not answered in time; declined.');
    else if (a.state === ShareState.Accepted && now - (a.data?.at ?? a.since) > DATA_IDLE_MS) this.close(ShareState.Failed, 'The sender stopped sending (out of range?).');
  }

  private append(s: Stream, offset: number, data: Uint8Array): boolean {
    if (offset < s.received && offset + data.length <= s.received) return true; // duplicate write
    if (offset !== s.received || offset + data.length > s.total) return false;
    s.buf.set(data, offset);
    s.received += data.length;
    s.at = this.now();
    return true;
  }

  private async finish(offer: ShareOffer, data: Uint8Array) {
    try {
      if (crc32c(data) !== offer.crc) throw new Error('The preset was damaged in transfer.');
      const preset = decodeSharedPreset(data);
      if (sharedKind(preset) !== offer.kind) throw new Error('The preset does not match the offer.');
      await this.hooks.onReceived(offer, preset);
      if (this.active?.offer.transferId === offer.transferId) this.active = undefined;
      this.setState(offer.transferId, ShareState.Received);
    } catch (e) {
      if (this.active?.offer.transferId === offer.transferId) this.close(ShareState.Failed, (e as Error).message);
    }
  }

  private close(state: ShareStateValue, message: string) {
    const offer = this.active!.offer;
    this.active = undefined;
    this.setState(offer.transferId, state);
    this.hooks.onClosed(offer, state, message);
  }

  private setState(tid: number, state: ShareStateValue) {
    this.states.delete(tid);
    this.states.set(tid, state);
    while (this.states.size > STATUS_ENTRIES) this.states.delete(this.states.keys().next().value!);
    this.hooks.publishStatus(encodeStatus([...this.states]));
  }
}

// ---------- sender ----------------------------------------------------------------

/** One connection to the receiving phone's approach GATT service. */
export interface ShareLink {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Largest value of one write (ATT MTU − 3). */
  maxWrite(): Promise<number>;
  write(characteristic: string, value: Uint8Array): Promise<void>;
  read(characteristic: string): Promise<Uint8Array>;
}

export type SendPhase = 'connecting' | 'waiting' | 'sending' | 'confirming';
export type SendResult = 'received' | 'declined' | 'busy';

export interface SendOptions {
  preset: Preset;
  fromPhoneId: number;
  fromName: string;
  signal?: AbortSignal;
  onPhase?(phase: SendPhase, sent?: number, total?: number): void;
  pollMs?: number;
  acceptTimeoutMs?: number;
  transferId?: number;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('Cancelled')); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error('Cancelled')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

export function makeOffer(preset: Preset, fromPhoneId: number, fromName: string, transferId: number): { offer: ShareOffer; payload: Uint8Array } {
  const payload = encodeSharedPreset(preset);
  if (payload.length > MAX_SHARE_BYTES) throw new Error('This preset is too large to share.');
  return { payload, offer: { transferId, fromPhoneId, fromName: fromName.slice(0, 40), name: preset.name, kind: sharedKind(preset), size: payload.length, crc: crc32c(payload) } };
}

/** Offers a preset and sends it only after the receiving user accepted. Throws on failure or abort. */
export async function sendPreset(link: ShareLink, o: SendOptions): Promise<SendResult> {
  const tid = o.transferId ?? ((crypto.getRandomValues(new Uint32Array(1))[0]! || 1) >>> 0);
  const { offer, payload } = makeOffer(o.preset, o.fromPhoneId, o.fromName, tid);
  const poll = o.pollMs ?? 1000;
  const status = async () => decodeStatus(await link.read(SHARE_STATUS), tid);
  const check = () => { if (o.signal?.aborted) throw new Error('Cancelled'); };
  o.onPhase?.('connecting');
  await link.connect();
  let offered = false;
  try {
    check();
    const maxWrite = await link.maxWrite();
    for (const p of encodeChunks(PKT_OFFER, tid, encodeOffer(offer), maxWrite)) { check(); await link.write(SHARE_INBOX, p); }
    offered = true;
    o.onPhase?.('waiting');
    const offeredAt = Date.now();
    const deadline = offeredAt + (o.acceptTimeoutMs ?? ACCEPT_TIMEOUT_MS + 5000);
    for (;;) {
      const s = await status();
      if (s === ShareState.Accepted) break;
      if (s === ShareState.Declined || s === ShareState.Cancelled) return 'declined';
      if (s === ShareState.Busy) return 'busy';
      if (s === ShareState.Failed) throw new Error('The other phone rejected the offer.');
      if (s === ShareState.None && Date.now() - offeredAt > 10_000) throw new Error('The other phone did not receive the offer. Update the app on both phones.');
      if (Date.now() > deadline) throw new Error('No answer from the other phone.');
      await sleep(poll, o.signal);
    }
    const chunks = encodeChunks(PKT_DATA, tid, payload, maxWrite);
    let sent = 0;
    for (const p of chunks) {
      check();
      o.onPhase?.('sending', sent, payload.length);
      await link.write(SHARE_INBOX, p);
      sent += p.length - HEADER;
    }
    o.onPhase?.('confirming', sent, payload.length);
    const until = Date.now() + 15_000;
    for (;;) {
      const s = await status();
      if (s === ShareState.Received) return 'received';
      if (s !== ShareState.Accepted) throw new Error(s === ShareState.Cancelled ? 'Cancelled' : 'The other phone could not store the preset.');
      if (Date.now() > until) throw new Error('The other phone did not confirm the preset.');
      await sleep(poll, o.signal);
    }
  } catch (e) {
    if (offered && o.signal?.aborted) await link.write(SHARE_INBOX, encodeCancel(tid)).catch(() => undefined);
    throw e;
  } finally {
    await link.disconnect().catch(() => undefined);
  }
}
