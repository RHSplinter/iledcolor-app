import { describe, expect, it } from 'vitest';
import { DeviceController, DEFAULT_TIMEOUTS } from '../src/controller/deviceController';
import { defaultAck, makeAck, makeContinueAck, MockTransport, type MockOptions } from '../src/transport/mock';
import { SelectionCancelledError, SPIKE_PROFILE } from '../src/transport/types';

const fast = { handshakeMs: 30, startMs: 30, chunkMs: 30, endMs: 30, controlMs: 30 };
const img = { width: 4, height: 2, pixels: new Uint8Array(24) };

function setup(opts: MockOptions = {}, profile = SPIKE_PROFILE) {
  const t = new MockTransport(opts);
  const c = new DeviceController({ profile: { ...profile, interWriteDelayMs: 0 }, timeouts: fast });
  return { t, c };
}
const hs = (pass: number) => (ch: 'cmd' | 'data', f: Uint8Array) =>
  [f[1] === 0x0f ? makeAck(0x0f, [pass]) : defaultAck(f)];

describe('connection', () => {
  it('reaches Ready only after validated handshake', async () => {
    const { t, c } = setup();
    await c.connect(async () => t);
    expect(c.state).toBe('Ready');
    expect(t.writes.map((w) => w.channel)).toEqual(['cmd', 'cmd']);
  });
  it('accepts 0x00/0x01/0x03 password status', async () => {
    for (const p of [0, 1, 3]) {
      const { t, c } = setup({ reply: hs(p) });
      await c.connect(async () => t);
      expect(c.state).toBe('Ready');
    }
  });
  it('denied password is an error, not Ready', async () => {
    const { t, c } = setup({ reply: hs(2) });
    await c.connect(async () => t);
    expect(c.state).toBe('Error');
    expect(t.disconnected).toBe(true);
  });
  it('unknown password byte is an error', async () => {
    const { t, c } = setup({ reply: hs(0x7f) });
    await c.connect(async () => t);
    expect(c.state).toBe('Error');
  });
  it('missing ack, bad checksum and wrong command are errors', async () => {
    for (const reply of [
      () => null,
      (_c: string, f: Uint8Array) => { const a = defaultAck(f); a[a.length - 1]! ^= 1; return [a]; },
      () => [makeAck(0x06, [1])],
    ]) {
      const { t, c } = setup({ reply });
      await c.connect(async () => t);
      expect(c.state).toBe('Error');
    }
  });
  it('chooser cancellation is not a fault', async () => {
    const { c } = setup();
    await c.connect(async () => { throw new SelectionCancelledError(); });
    expect(c.state).toBe('Disconnected');
    expect(c.error).toBeNull();
  });
  it('handles replies delivered synchronously inside the write', async () => {
    const { t, c } = setup({ syncReplies: true });
    await c.connect(async () => t);
    expect(c.state).toBe('Ready');
  });
  it('stale notifications are ignored', async () => {
    const { t, c } = setup();
    await c.connect(async () => t);
    t.emit(makeAck(0x06, [1]));
    expect(c.state).toBe('Ready');
  });
});

describe('upload', () => {
  it('sends start, ordered chunks on A952, end; confirmed', async () => {
    const { t, c } = setup();
    await c.connect(async () => t);
    expect(await c.upload(img)).toBe('confirmed');
    const w = t.writes.slice(2);
    expect(w[0]).toMatchObject({ channel: 'cmd' });
    expect(w[0]!.frame[1]).toBe(0x06);
    expect(w.slice(1, -1).every((x) => x.channel === 'data' && x.frame.length <= 20)).toBe(true);
    expect(w[w.length - 1]!.frame[1]).toBe(0x01);
    expect(t.maxInFlight).toBe(1);
    expect(c.state).toBe('Ready');
  });
  it('rejects invalid input before any write', async () => {
    const { t, c } = setup();
    await c.connect(async () => t);
    const before = t.writes.length;
    await expect(c.upload({ width: 4, height: 2, pixels: new Uint8Array(5) })).rejects.toThrow();
    expect(t.writes.length).toBe(before);
    expect(c.state).toBe('Ready');
  });
  it('missing chunk ack => unconfirmed and disconnect', async () => {
    const { t, c } = setup({ reply: (_ch, f) => (f[1] === 0x00 ? null : [defaultAck(f)]) });
    await c.connect(async () => t);
    await expect(c.upload(img)).rejects.toThrow(/No reply/);
    expect(c.state).toBe('Disconnected');
    expect(c.error).toMatch(/unconfirmed/i);
    expect(t.disconnected).toBe(true);
  });
  it('tolerates missing chunk acks only with the tested profile flag, reporting sent-unconfirmed', async () => {
    const { t, c } = setup({ reply: (_ch, f) => (f[1] === 0x00 ? null : [defaultAck(f)]) },
      { ...SPIKE_PROFILE, allowMissingChunkAcks: true });
    await c.connect(async () => t);
    expect(await c.upload(img)).toBe('sent-unconfirmed');
  });
  it('wrong chunk sequence in ack fails', async () => {
    const { t, c } = setup({ reply: (_ch, f) => (f[1] === 0x00 ? [makeContinueAck([0, 0, 0, 9], 1)] : [defaultAck(f)]) });
    await c.connect(async () => t);
    await expect(c.upload(img)).rejects.toThrow(/expected/);
  });
  it('non-success chunk status fails', async () => {
    const { t, c } = setup({ reply: (_ch, f) => (f[1] === 0x00 ? [makeContinueAck(f.subarray(4, 8), 2)] : [defaultAck(f)]) });
    await c.connect(async () => t);
    await expect(c.upload(img)).rejects.toThrow(/rejected/);
  });
  it('cancel mid-upload disconnects', async () => {
    let cancel = () => {};
    const { t, c } = setup({ reply: (_ch, f, i) => { if (i === 5) cancel(); return [defaultAck(f)]; } });
    cancel = () => c.cancelUpload();
    await c.connect(async () => t);
    const p = c.upload(img);
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    expect(c.state).toBe('Disconnected');
    expect(t.disconnected).toBe(true);
  });
  it('disconnect mid-stream rejects and reports Disconnected', async () => {
    let n = 0;
    const { t, c } = setup({ reply: (_ch, f) => (f[1] === 0x00 && ++n === 3 ? null : [defaultAck(f)]) });
    await c.connect(async () => t);
    const p = c.upload(img);
    p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    t.drop();
    await expect(p).rejects.toThrow();
    expect(c.state).toBe('Disconnected');
    // explicit reconnect works and redoes the handshake
    const t2 = new MockTransport();
    await c.connect(async () => t2);
    expect(c.state).toBe('Ready');
    expect(t2.writes.length).toBe(2);
  });
  it('serializes concurrent operations', async () => {
    const { t, c } = setup();
    await c.connect(async () => t);
    const ps = [c.upload(img), c.setBrightness(3), c.setDisplay(false)];
    await Promise.all(ps);
    expect(t.maxInFlight).toBe(1);
    const cmds = t.writes.slice(2).map((w) => w.frame[1]);
    expect(cmds[cmds.length - 2]).toBe(0x09);
    expect(cmds[cmds.length - 1]).toBe(0x0a);
  });
});

describe('controls', () => {
  it('confirmed and unconfirmed brightness', async () => {
    const a = setup();
    await a.c.connect(async () => a.t);
    expect(await a.c.setBrightness(4)).toBe('confirmed');
    const b = setup({ reply: (_ch, f) => (f[1] === 0x09 ? null : [defaultAck(f)]) });
    await b.c.connect(async () => b.t);
    expect(await b.c.setBrightness(4)).toBe('sent-unconfirmed');
    expect(b.c.state).toBe('Ready');
  });
  it('rejects bad brightness without writing', async () => {
    const { t, c } = setup();
    await c.connect(async () => t);
    await expect(c.setBrightness(11)).rejects.toThrow(RangeError);
    expect(t.writes.length).toBe(2);
  });
  it('defaults match the documented timeouts', () => {
    expect(DEFAULT_TIMEOUTS).toEqual({ handshakeMs: 2000, startMs: 2000, chunkMs: 500, endMs: 1000, controlMs: 500 });
  });
});
