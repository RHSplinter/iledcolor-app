import { describe, expect, it } from 'vitest';
import { capHash16, decodeBeacon, encodeBeacon } from '../src/approach/beaconCodec';
import { ProximityTracker } from '../src/approach/proximity';
import { DEFAULT_APPROACH, tierFor, validateApproach, type ApproachSettings } from '../src/approach/tiers';
import { ApproachEngine, defaultLabel, fillTemplate, joinOthers, planFor, type Member } from '../src/approach/engine';
import { sliceSpan, spanStep, MAX_SPAN_FRAMES } from '../src/render/span';

const settings = (over: Partial<ApproachSettings> = {}): ApproachSettings => ({ ...DEFAULT_APPROACH, settleMs: 0, ...over });

describe('beacon codec', () => {
  it('round-trips phone id, cap count and hashes', () => {
    const b = { phoneId: 0xdeadbeef, capCount: 3, capHashes: [capHash16('iledcolor-AB12'), capHash16('iledcolor-CD34')] };
    const uuid = encodeBeacon(b);
    expect(uuid).toMatch(/^4c454448-4154-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(decodeBeacon(uuid)).toEqual(b);
    expect(decodeBeacon(uuid.toUpperCase())).toEqual(b);
  });
  it('rejects foreign UUIDs', () => {
    expect(decodeBeacon('0000a950-0000-1000-8000-00805f9b34fb')).toBeNull();
    expect(decodeBeacon('a950')).toBeNull();
    expect(decodeBeacon('garbage')).toBeNull();
  });
  it('hashes are 16-bit and never zero', () => {
    for (const n of ['', 'a', 'iledcolor-1', 'iledcolor-2']) {
      const h = capHash16(n);
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThan(0x10000);
    }
    expect(capHash16('iledcolor-1')).not.toBe(capHash16('iledcolor-2'));
  });
});

describe('proximity tracker', () => {
  it('uses hysteresis between enter and leave thresholds', () => {
    const t = new ProximityTracker({ enterDbm: -70, leaveDbm: -80, staleMs: 5000, alpha: 1 });
    t.update('a', -75, 0);
    expect(t.isNear('a', 0)).toBe(false); // between thresholds, not yet entered
    t.update('a', -60, 100);
    expect(t.isNear('a', 100)).toBe(true);
    t.update('a', -75, 200);
    expect(t.isNear('a', 200)).toBe(true); // still inside the hysteresis band
    t.update('a', -85, 300);
    expect(t.isNear('a', 300)).toBe(false);
  });
  it('smooths RSSI and expires stale entries', () => {
    const t = new ProximityTracker({ enterDbm: -70, leaveDbm: -80, staleMs: 1000, alpha: 0.5 });
    t.update('a', -60, 0);
    t.update('a', -100, 10); // a single dip does not drop it
    expect(t.rssi('a')).toBe(-80);
    t.expire(5000);
    expect(t.isNear('a', 5000)).toBe(false);
    expect(t.keys()).toEqual([]);
  });
});

describe('tiers', () => {
  it('maps group sizes to the configured tiers', () => {
    expect([0, 1, 2, 3, 4, 5, 8, 9, 15].map(tierFor)).toEqual(['solo', 'solo', 'pair', 'upTo4', 'upTo4', 'upTo8', 'upTo8', 'moreThan8', 'moreThan8']);
  });
  it('validates leniently', () => {
    const v = validateApproach({ enterDbm: -60, leaveDbm: -50, tiers: { pair: { mode: 'span', text: 'x', fg: 'red', speed: 99 } } });
    expect(v.tiers.pair.mode).toBe('span');
    expect(v.tiers.pair.text).toBe('x');
    expect(v.tiers.pair.fg).toBe(DEFAULT_APPROACH.tiers.pair.fg);
    expect(v.tiers.pair.speed).toBe(DEFAULT_APPROACH.tiers.pair.speed);
    expect(v.leaveDbm).toBeLessThanOrEqual(v.enterDbm);
    expect(validateApproach(null)).toEqual(DEFAULT_APPROACH);
  });
});

describe('templates', () => {
  it('fills placeholders and joins names', () => {
    expect(joinOthers(['A'])).toBe('A');
    expect(joinOthers(['A', 'B', 'C'])).toBe('A, B & C');
    expect(joinOthers(['A', 'B', 'C', 'D'])).toBe('4 friends');
    expect(fillTemplate('Hi {other}, I am {me} ({index}/{count})', { me: 'Fox', others: ['Owl'], count: 2, index: 1 })).toBe('Hi Owl, I am Fox (1/2)');
    expect(defaultLabel(0, 0)).toBe('Fox');
    expect(defaultLabel(0, 1)).toBe('Fox2');
  });
});

const member = (key: string, label: string, local: boolean): Member => ({ key, label, local, sortKey: key, source: local ? 'local' : 'peer' });

describe('planFor', () => {
  it('greets the other cap individually for a pair', () => {
    const p = planFor([member('a', 'Ann', true), member('b', 'Bob', true)], [{ key: 'a', bleName: 'x', label: 'Ann' }, { key: 'b', bleName: 'y', label: 'Bob' }], settings());
    expect(p.tier).toBe('pair');
    expect(p.perCap.get('a')).toMatchObject({ kind: 'individual', text: 'Hi Bob!' });
    expect(p.perCap.get('b')).toMatchObject({ kind: 'individual', text: 'Hi Ann!' });
  });
  it('spans one identical text with distinct indices for 3-4 caps', () => {
    const ms = [member('a', 'A', true), member('b', 'B', false), member('c', 'C', true)];
    const p = planFor(ms, [{ key: 'a', bleName: '', label: 'A' }, { key: 'c', bleName: '', label: 'C' }], settings());
    expect(p.tier).toBe('upTo4');
    const a = p.perCap.get('a'), c = p.perCap.get('c');
    expect(a).toMatchObject({ kind: 'span', index: 0, total: 3, text: '3 caps together!' });
    expect(c).toMatchObject({ kind: 'span', index: 2, total: 3, text: '3 caps together!' });
    expect(p.perCap.has('b')).toBe(false);
  });
  it('gives solo content to local caps that are not near', () => {
    const p = planFor([], [{ key: 'a', bleName: '', label: 'Ann' }], settings());
    expect(p.count).toBe(1);
    expect(p.perCap.get('a')).toMatchObject({ kind: 'individual', text: 'Ann' });
  });
});

describe('ApproachEngine', () => {
  it('counts peer phones and their caps, with a consistent order', () => {
    const e1 = new ApproachEngine(1, settings());
    const e2 = new ApproachEngine(2, settings());
    e1.setLocalCaps([{ key: 'L1', bleName: 'iledcolor-1', label: defaultLabel(1, 0) }]);
    e2.setLocalCaps([{ key: 'L2', bleName: 'iledcolor-2', label: defaultLabel(2, 0) }]);
    e1.onLocalRssi('L1', -50, 0);
    e2.onLocalRssi('L2', -50, 0);
    e1.onAdvertisement({ deviceId: 'p2', rssi: -55, uuids: [encodeBeacon(e2.beacon())] }, 0);
    e2.onAdvertisement({ deviceId: 'p1', rssi: -55, uuids: [encodeBeacon(e1.beacon())] }, 0);
    const p1 = e1.tick(0)!, p2 = e2.tick(0)!;
    expect(p1.count).toBe(2);
    expect(p1.members.map((m) => m.label)).toEqual(p2.members.map((m) => m.label));
    expect(p1.perCap.get('L1')).toMatchObject({ text: `Hi ${defaultLabel(2, 0)}!` });
    expect(p2.perCap.get('L2')).toMatchObject({ text: `Hi ${defaultLabel(1, 0)}!` });
  });

  it('scales beyond 8 caps and picks the more-than-8 tier', () => {
    const e = new ApproachEngine(1, settings());
    e.setLocalCaps([{ key: 'L', bleName: 'iledcolor-me', label: 'Me' }]);
    e.onLocalRssi('L', -50, 0);
    for (let i = 0; i < 5; i++) e.onAdvertisement({ deviceId: `p${i}`, rssi: -60, uuids: [encodeBeacon({ phoneId: 100 + i, capCount: 2, capHashes: [] })] }, 0);
    const p = e.tick(0)!;
    expect(p.count).toBe(11);
    expect(p.tier).toBe('moreThan8');
    expect(p.perCap.get('L')).toMatchObject({ kind: 'span', total: 11, text: 'Crowd of 11 caps!' });
  });

  it('does not double count a cap seen directly and through its phone beacon', () => {
    const e = new ApproachEngine(1, settings());
    e.setLocalCaps([{ key: 'L', bleName: 'iledcolor-me', label: 'Me' }]);
    e.onLocalRssi('L', -50, 0);
    e.onAdvertisement({ deviceId: 'phone', rssi: -60, uuids: [encodeBeacon({ phoneId: 7, capCount: 1, capHashes: [capHash16('iledcolor-other')] })] }, 0);
    e.onAdvertisement({ deviceId: 'capdev', name: 'iledcolor-other', rssi: -60 }, 0);
    e.onAdvertisement({ deviceId: 'capdev2', name: 'iledcolor-third', rssi: -60 }, 0);
    expect(e.members(0).map((m) => m.source).sort()).toEqual(['cap', 'local', 'peer']);
  });

  it('waits for the group to settle and applies a plan once', () => {
    const e = new ApproachEngine(1, settings({ settleMs: 2000 }));
    e.setLocalCaps([{ key: 'L', bleName: 'iledcolor-me', label: 'Me' }]);
    e.onLocalRssi('L', -50, 0);
    expect(e.tick(0)).toBeNull();
    expect(e.tick(1999)).toBeNull();
    e.onLocalRssi('L', -50, 2000);
    expect(e.tick(2000)?.count).toBe(1);
    expect(e.tick(2500)).toBeNull();
    e.invalidate();
    expect(e.tick(2600)).not.toBeNull();
  });
});

describe('P2P mode (one cap per phone)', () => {
  const pair = (s: ApproachSettings) => {
    const a = new ApproachEngine(0xa, s), b = new ApproachEngine(0xb, s);
    a.setLocalCaps([{ key: 'CA', bleName: 'iledcolor-A', label: 'Ann' }]);
    b.setLocalCaps([{ key: 'CB', bleName: 'iledcolor-B', label: 'Bob' }]);
    const hear = (rssi: number, now: number) => {
      a.onLocalRssi('CA', -45, now);
      b.onLocalRssi('CB', -45, now);
      a.onAdvertisement({ deviceId: 'pb', rssi, uuids: [encodeBeacon(b.beacon())] }, now);
      b.onAdvertisement({ deviceId: 'pa', rssi, uuids: [encodeBeacon(a.beacon())] }, now);
    };
    return { a, b, hear };
  };

  it('greets while near, returns to solo when apart or silent, and greets again on rejoin', () => {
    const { a, b, hear } = pair(settings({ staleMs: 8000 }));
    hear(-90, 0); // far apart
    expect(a.tick(0)!.perCap.get('CA')).toMatchObject({ text: 'Ann' });
    expect(b.tick(0)!.perCap.get('CB')).toMatchObject({ text: 'Bob' });
    for (let t = 1000; t <= 3000; t += 1000) hear(-55, t); // approach
    const pa = a.tick(3000)!, pb = b.tick(3000)!;
    expect(pa.tier).toBe('pair');
    expect(pa.perCap.get('CA')).toMatchObject({ kind: 'individual', text: `Hi ${defaultLabel(0xb, 0)}!` });
    expect(pb.perCap.get('CB')).toMatchObject({ kind: 'individual', text: `Hi ${defaultLabel(0xa, 0)}!` });
    for (let t = 4000; t <= 8000; t += 1000) hear(-95, t); // walk apart
    expect(a.tick(8000)!.perCap.get('CA')).toMatchObject({ text: 'Ann' });
    expect(b.tick(8000)!.perCap.get('CB')).toMatchObject({ text: 'Bob' });
    for (let t = 9000; t <= 12000; t += 1000) hear(-50, t); // rejoin
    expect(a.tick(12000)!.tier).toBe('pair');
    // Peer phone goes silent (switched off / out of range): stale expiry falls back to solo.
    a.onLocalRssi('CA', -45, 21000);
    expect(a.tick(21000)!.perCap.get('CA')).toMatchObject({ text: 'Ann' });
  });

  it('gives each phone a complementary slice of the same spanned marquee', () => {
    const base = settings();
    const s: ApproachSettings = { ...base, tiers: { ...base.tiers, pair: { ...base.tiers.pair, mode: 'span', text: '{count} caps!' } } };
    const { a, b, hear } = pair(s);
    for (let t = 0; t <= 2000; t += 1000) hear(-50, t);
    const sa = a.tick(2000)!.perCap.get('CA')!, sb = b.tick(2000)!.perCap.get('CB')!;
    expect(sa).toMatchObject({ kind: 'span', total: 2, text: '2 caps!' });
    expect(sb).toMatchObject({ kind: 'span', total: 2, text: '2 caps!' });
    expect(new Set([(sa as { index: number }).index, (sb as { index: number }).index])).toEqual(new Set([0, 1]));
  });
});

describe('span marquee slicing', () => {
  const strip = (w: number) => {
    const pixels = new Uint8Array(w * 2 * 3);
    for (let x = 0; x < w; x++) for (let y = 0; y < 2; y++) pixels[(y * w + x) * 3] = x + 1; // red channel = column + 1
    return { width: w, height: 2, pixels };
  };
  it('gives every cap the same frame count and continues the text across caps', () => {
    const s = strip(10);
    const total = 3, seg = 4, step = 1;
    const parts = [0, 1, 2].map((i) => sliceSpan(s, seg, total, i, [0, 0, 0], step));
    expect(new Set(parts.map((p) => p.length)).size).toBe(1);
    // In any frame, the combined strip [cap0|cap1|cap2] is a contiguous window of the text.
    const f = 15;
    const combined: number[] = [];
    for (const p of parts) for (let x = 0; x < seg; x++) combined.push(p[f]!.pixels[x * 3]!);
    const lit = combined.map((v, i) => [i, v] as const).filter(([, v]) => v > 0);
    for (let k = 1; k < lit.length; k++) {
      expect(lit[k]![0] - lit[k - 1]![0]).toBe(1);
      expect(lit[k]![1] - lit[k - 1]![1]).toBe(1);
    }
    expect(lit.length).toBeGreaterThan(0);
  });
  it('bounds frame count via the step', () => {
    const step = spanStep(400, 32, 12);
    expect(Math.ceil((400 + 32 * 12) / step)).toBeLessThanOrEqual(MAX_SPAN_FRAMES);
    expect(() => sliceSpan(strip(4), 4, 2, 2, [0, 0, 0], 1)).toThrow();
  });
});
