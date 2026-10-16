import { describe, expect, it, vi } from 'vitest';
import {
  ACCEPT_TIMEOUT_MS, decodePacket, decodeSharedPreset, decodeStatus, encodeChunks, encodeOffer, encodeSharedPreset, encodeStatus, makeOffer,
  sendPreset, SHARE_INBOX, SHARE_STATUS, ShareReceiver, ShareState, type ReceiverHooks, type ShareLink, type ShareOffer, type SharedPreset,
} from '../src/approach/presetShare';
import { DEFAULT_APPROACH } from '../src/approach/tiers';
import type { Preset } from '../src/storage/presets';

const textPreset: Preset = { id: 'a', name: 'Hello', updatedAt: 1, content: { kind: 'text', text: 'Hi there ✨', fg: '#ff0000', bg: '#000000', speed: 4 } };
const groupPreset: Preset = { id: 'g', name: 'Crew', updatedAt: 2, groups: structuredClone(DEFAULT_APPROACH.tiers) };

function setup(decide?: (r: ShareReceiver, o: ShareOffer) => void, maxWrite = 20) {
  let status: Uint8Array = new Uint8Array(0);
  const received: SharedPreset[] = [];
  const closed: string[] = [];
  const writes: Uint8Array[] = [];
  const hooks: ReceiverHooks = {
    publishStatus: (v) => { status = v; },
    onOffer: (o) => decide?.(receiver, o),
    onReceived: (_o, p) => { received.push(p); },
    onClosed: (_o, _s, m) => { closed.push(m); },
  };
  const receiver = new ShareReceiver(hooks);
  const link: ShareLink = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    maxWrite: async () => maxWrite,
    write: async (uuid, value) => { expect(uuid).toBe(SHARE_INBOX); expect(value.length).toBeLessThanOrEqual(maxWrite); writes.push(value); receiver.handleWrite(value); },
    read: async (uuid) => { expect(uuid).toBe(SHARE_STATUS); return status; },
  };
  return { receiver, link, received, closed, writes, status: () => status };
}

describe('preset share codec', () => {
  it('round-trips presets and validates them', () => {
    expect(decodeSharedPreset(encodeSharedPreset(textPreset))).toEqual({ name: 'Hello', content: textPreset.content });
    expect(decodeSharedPreset(encodeSharedPreset(groupPreset))).toEqual({ name: 'Crew', groups: groupPreset.groups });
    const bad = new TextEncoder().encode(JSON.stringify({ name: 'x', content: { kind: 'text', text: 'a', fg: 'red', bg: '#000000' } }));
    expect(() => decodeSharedPreset(bad)).toThrow();
    expect(() => decodeSharedPreset(new Uint8Array([0xff]))).toThrow();
  });

  it('chunks fit one write and reassemble', () => {
    const bytes = new Uint8Array(100).map((_, i) => i);
    const chunks = encodeChunks(2, 7, bytes, 23);
    expect(chunks.every((c) => c.length <= 23)).toBe(true);
    const out = new Uint8Array(100);
    for (const c of chunks) {
      const p = decodePacket(c)!;
      if (p.type === 3) throw new Error('unexpected');
      expect(p.tid).toBe(7);
      expect(p.total).toBe(100);
      out.set(p.data, p.offset);
    }
    expect(out).toEqual(bytes);
  });

  it('status lists the most recent transfers', () => {
    const entries = Array.from({ length: 10 }, (_, i) => [i + 1, ShareState.Declined] as [number, 3]);
    const s = encodeStatus(entries);
    expect(decodeStatus(s, 1)).toBe(ShareState.None);
    expect(decodeStatus(s, 10)).toBe(ShareState.Declined);
  });
});

describe('preset share transfer', () => {
  it('sends the preset only after the receiver accepted', async () => {
    let offered: ShareOffer | undefined;
    const t = setup((r, o) => { offered = o; setTimeout(() => r.accept(o.transferId), 20); });
    const result = await sendPreset(t.link, { preset: textPreset, fromPhoneId: 42, fromName: 'Anna', pollMs: 5, transferId: 9 });
    expect(result).toBe('received');
    expect(offered).toMatchObject({ fromPhoneId: 42, fromName: 'Anna', name: 'Hello', kind: 'text', transferId: 9 });
    expect(t.received).toEqual([{ name: 'Hello', content: textPreset.content }]);
    // The offer packets carry no preset content: the first DATA packet follows the acceptance.
    const firstData = t.writes.findIndex((w) => w[0] === 2);
    const offerText = new TextDecoder().decode(new Uint8Array(t.writes.slice(0, firstData).flatMap((w) => [...w.subarray(13)])));
    expect(offerText).not.toContain('Hi there');
  });

  it('declined offers transfer nothing', async () => {
    const t = setup((r, o) => r.decline(o.transferId));
    expect(await sendPreset(t.link, { preset: groupPreset, fromPhoneId: 1, fromName: '', pollMs: 5 })).toBe('declined');
    expect(t.writes.some((w) => w[0] === 2)).toBe(false);
    expect(t.received).toEqual([]);
  });

  it('ignores data that was never accepted', () => {
    const t = setup();
    const { offer, payload } = makeOffer(textPreset, 1, 'x', 5);
    for (const c of encodeChunks(1, 5, encodeOffer(offer), 100)) t.receiver.handleWrite(c);
    expect(t.receiver.current?.state).toBe(ShareState.Pending);
    for (const c of encodeChunks(2, 5, payload, 100)) t.receiver.handleWrite(c);
    expect(t.received).toEqual([]);
    expect(t.receiver.current?.received).toBe(0);
  });

  it('answers busy while another offer is open', async () => {
    const t = setup();
    const first = sendPreset(t.link, { preset: textPreset, fromPhoneId: 1, fromName: 'A', pollMs: 5, transferId: 1, acceptTimeoutMs: 200 });
    await vi.waitFor(() => expect(t.receiver.current?.offer.transferId).toBe(1));
    expect(await sendPreset(t.link, { preset: textPreset, fromPhoneId: 2, fromName: 'B', pollMs: 5, transferId: 2 })).toBe('busy');
    t.receiver.decline(1);
    expect(await first).toBe('declined');
  });

  it('sender cancel closes the prompt on the receiver', async () => {
    const t = setup();
    const abort = new AbortController();
    const sending = sendPreset(t.link, { preset: textPreset, fromPhoneId: 1, fromName: 'A', pollMs: 5, signal: abort.signal });
    await vi.waitFor(() => expect(t.receiver.current?.state).toBe(ShareState.Pending));
    abort.abort();
    await expect(sending).rejects.toThrow('Cancelled');
    expect(t.receiver.current).toBeUndefined();
    expect(t.closed).toEqual(['The sender cancelled.']);
  });

  it('unanswered offers expire as declined', () => {
    let now = 0;
    const t = setup();
    const r = new ShareReceiver({ publishStatus: () => undefined, onOffer: () => undefined, onReceived: () => undefined, onClosed: (_o, s) => t.closed.push(String(s)) }, () => now);
    const { offer } = makeOffer(textPreset, 1, 'x', 3);
    for (const c of encodeChunks(1, 3, encodeOffer(offer), 100)) r.handleWrite(c);
    now = ACCEPT_TIMEOUT_MS + 1;
    r.tick();
    expect(r.current).toBeUndefined();
    expect(t.closed).toEqual([String(ShareState.Declined)]);
  });

  it('rejects damaged data', async () => {
    const t = setup((r, o) => r.accept(o.transferId));
    const write = t.link.write;
    t.link.write = (uuid, value) => {
      if (value[0] === 2 && value.length > 14) { value = value.slice(); value[14] = value[14]! ^ 1; }
      return write(uuid, value);
    };
    await expect(sendPreset(t.link, { preset: textPreset, fromPhoneId: 1, fromName: 'A', pollMs: 5 })).rejects.toThrow('could not store');
    expect(t.received).toEqual([]);
    expect(t.closed[0]).toContain('damaged');
  });
});
