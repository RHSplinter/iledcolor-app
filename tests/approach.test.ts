import { dbmForMeters, formatMeters } from '../src/approach/distance';
import { describe, expect, it } from 'vitest';
import { capHash16, decodeBeacon, decodeBeaconName, encodeBeacon, fitBeaconName, maskHas, nearMaskFor, NAME_COMPANY_ID } from '../src/approach/beaconCodec';
import { median, ProximityTracker } from '../src/approach/proximity';
import { DEFAULT_APPROACH, tierFor, validateApproach, type ApproachSettings } from '../src/approach/tiers';
import { ApproachEngine, capLabel, defaultLabel, fillTemplate, joinOthers, planFor, type Member } from '../src/approach/engine';
import { gifDelayMs, msUntilLoopStart, sliceSpan, spanStep, MAX_SPAN_FRAMES } from '../src/render/span';

const settings = (over: Partial<ApproachSettings> = {}): ApproachSettings => ({ ...DEFAULT_APPROACH, settleMs: 0, confirmMs: 0, ...over });

describe('beacon codec', () => {
  it('round-trips phone id, cap count, hashes and near mask', () => {
    const b = { phoneId: 0xdeadbeef, capCount: 3, capHashes: [capHash16('iledcolor-AB12'), capHash16('iledcolor-CD34')], nearMask: 0x8421 };
    const uuid = encodeBeacon(b);
    expect(uuid).toMatch(/^4c454448-02[0-9a-f]{2}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(decodeBeacon(uuid)).toEqual(b);
    expect(decodeBeacon(uuid.toUpperCase())).toEqual(b);
  });
  it('still decodes version 1 beacons', () => {
    expect(decodeBeacon('4c454448-4154-0102-dead-beef12340000')).toEqual({ phoneId: 0xdeadbeef, capCount: 2, capHashes: [0x1234], nearMask: 0 });
  });
  it('near mask lists the near phones', () => {
    const m = nearMaskFor([0xa, 0x1234567]);
    expect(maskHas(m, 0xa)).toBe(true);
    expect(maskHas(m, 0x1234567)).toBe(true);
    expect(maskHas(0, 0xa)).toBe(false);
    expect(maskHas(undefined, 0xa)).toBe(false);
    // Two bits per phone: a single other phone rarely matches by accident.
    let hits = 0;
    for (let id = 1; id <= 1000; id++) if (id !== 0xa && maskHas(nearMaskFor([0xa]), id)) hits++;
    expect(hits).toBeLessThan(30);
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
    const t = new ProximityTracker({ enterDbm: -70, leaveDbm: -80, staleMs: 5000, alpha: 1, confirmMs: 0 });
    t.update('a', -75, 0);
    expect(t.isNear('a', 0)).toBe(false); // between thresholds, not yet entered
    t.update('a', -60, 1000); t.update('a', -60, 2000);
    expect(t.isNear('a', 2000)).toBe(true);
    t.update('a', -75, 3000); t.update('a', -75, 4000);
    expect(t.isNear('a', 4000)).toBe(true); // still inside the hysteresis band
    t.update('a', -85, 5000); t.update('a', -85, 6000);
    expect(t.isNear('a', 6000)).toBe(false);
  });
  it('smooths RSSI over time, ignores single outliers and expires stale entries', () => {
    const t = new ProximityTracker({ enterDbm: -70, leaveDbm: -80, staleMs: 1000, alpha: 0.5 });
    t.update('a', -60, 0);
    t.update('a', -60, 1000);
    t.update('a', -100, 2000); // a single dip is removed by the median prefilter
    expect(t.rssi('a')).toBe(-60);
    t.expire(20000); // beyond the radio-gap grace period, too
    expect(t.isNear('a', 20000)).toBe(false);
    expect(t.keys()).toEqual([]);
  });
  it('weights samples by elapsed time, so fast reporters do not react faster', () => {
    const fast = new ProximityTracker({ enterDbm: -70, leaveDbm: -80, staleMs: 8000, alpha: 0.3 });
    const slow = new ProximityTracker({ enterDbm: -70, leaveDbm: -80, staleMs: 8000, alpha: 0.3 });
    fast.update('a', -90, 0); slow.update('a', -90, 0);
    for (let t = 100; t <= 4000; t += 100) fast.update('a', -60, t);
    for (let t = 1000; t <= 4000; t += 1000) slow.update('a', -60, t);
    expect(Math.abs(fast.rssi('a')! - slow.rssi('a')!)).toBeLessThan(2.5);
  });
  it('needs repeated evidence over confirmMs before flipping near or away', () => {
    const t = new ProximityTracker({ enterDbm: -70, leaveDbm: -80, staleMs: 8000, alpha: 1, confirmMs: 1000 });
    t.update('a', -90, 0);
    t.update('a', -50, 1000);
    expect(t.isNear('a', 1000)).toBe(false); // first strong sample only starts the confirmation
    t.update('a', -50, 1500);
    expect(t.isNear('a', 1500)).toBe(false); // two samples, but only 0.5 s apart
    t.update('a', -50, 2000);
    expect(t.isNear('a', 2000)).toBe(true);
    // A short weak burst that recovers resets the pending change.
    t.update('a', -95, 3000); t.update('a', -95, 3500); t.update('a', -50, 4000); t.update('a', -50, 4500);
    expect(t.isNear('a', 4500)).toBe(true);
  });
  it('computes the median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1])).toBe(2.5);
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
  it('uses Create content only for solo assignments, including separated caps', () => {
    const s = settings({ tiers: { ...DEFAULT_APPROACH.tiers, solo: { ...DEFAULT_APPROACH.tiers.solo, useCreate: true } } });
    const locals = ['a', 'b', 'c'].map((key) => ({ key, bleName: '', label: key }));
    expect(planFor([], locals, s).perCap.get('a')).toEqual({ kind: 'create' });
    expect(planFor([member('a', 'A', true)], locals, s).perCap.get('a')).toEqual({ kind: 'create' });
    const paired = planFor([member('a', 'A', true), member('b', 'B', true)], locals, s);
    expect(paired.perCap.get('a')).toMatchObject({ kind: 'individual', text: 'Hi B!' });
    expect(paired.perCap.get('c')).toEqual({ kind: 'create' });
    expect(validateApproach(s).tiers.solo.useCreate).toBe(true);
  });
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

  it('master mode: puts a cap back to alone once it is estimated beyond ~4 m, before it is out of range', () => {
    expect(DEFAULT_APPROACH.leaveDbm).toBe(-75);
    const e = new ApproachEngine(1, settings());
    e.setLocalCaps([{ key: 'A', bleName: 'iledcolor-A', label: 'Ann' }, { key: 'B', bleName: 'iledcolor-B', label: 'Bob' }]);
    for (let t = 0; t <= 3000; t += 1000) { e.onLocalRssi('A', -50, t); e.onLocalRssi('B', -55, t); }
    expect(e.tick(3000)!.tier).toBe('pair');
    // B walks away to about 3 m (-73 dBm): between near and away, so the group holds.
    for (let t = 4000; t <= 9000; t += 1000) { e.onLocalRssi('A', -50, t); e.onLocalRssi('B', -73, t); }
    expect(formatMeters(-73)).toBe('≈ 3.2 m');
    expect(e.tick(9000)).toBeNull();
    // B reaches about 5 m (-77 dBm), still well within BLE range: both caps fall back to alone.
    for (let t = 10000; t <= 15000; t += 1000) { e.onLocalRssi('A', -50, t); e.onLocalRssi('B', -77, t); }
    expect(formatMeters(-77)).toBe('≈ 4.8 m');
    const p = e.tick(15000)!;
    expect(p.tier).toBe('solo');
    expect(p.members.map((m) => m.label)).toEqual(['Ann']);
    expect(p.perCap.get('A')).toMatchObject({ text: 'Ann' });
    expect(p.perCap.get('B')).toMatchObject({ text: 'Bob' });
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
    // Peer phone goes silent (switched off / out of range) while the scanner still hears other devices:
    // stale expiry falls back to solo. Strong near peers get a 2x staleMs grace period, so short radio gaps do not split the group.
    for (let t = 13000; t <= 29000; t += 1000) a.onScanHeard(t);
    a.onLocalRssi('CA', -45, 20000);
    expect(a.tick(20000)).toBeNull(); // still the same pair, nothing to resend
    a.onLocalRssi('CA', -45, 29000);
    expect(a.tick(29000)!.perCap.get('CA')).toMatchObject({ text: 'Ann' });
  });

  it('holds a strong peer while the whole scanner is silent, but at most 10 s longer', () => {
    const { a, hear } = pair(settings({ staleMs: 8000 }));
    for (let t = 0; t <= 3000; t += 1000) hear(-50, t);
    expect(a.tick(3000)!.tier).toBe('pair');
    // Nothing at all is heard from 3 s on (scanner stalled): the pair is kept past 2x staleMs ...
    a.onLocalRssi('CA', -45, 22000);
    expect(a.tick(22000)).toBeNull();
    // ... but not forever.
    a.onLocalRssi('CA', -45, 30000);
    expect(a.tick(30000)!.tier).toBe('solo');
  });

  it('drops a fading peer after staleMs instead of the radio-gap grace period', () => {
    const { a, hear } = pair(settings({ staleMs: 8000 }));
    for (let t = 0; t <= 3000; t += 1000) hear(-50, t);
    expect(a.tick(3000)!.tier).toBe('pair');
    // Signal falls steadily below the near threshold but stays above "away", then the peer vanishes.
    for (const [i, rssi] of [-60, -66, -71, -73, -74, -74, -74, -74].entries()) hear(rssi, 4000 + i * 1000);
    expect(a.tracker.rssi('peer:0000000b')!).toBeLessThan(-70);
    expect(a.tracker.trend('peer:0000000b')!).toBeLessThan(-0.5);
    expect(a.tracker.isNear('peer:0000000b', 11000)).toBe(true);
    for (let t = 12000; t <= 20000; t += 1000) { a.onScanHeard(t); a.onLocalRssi('CA', -45, t); }
    expect(a.tick(20000)!.tier).toBe('solo'); // 9 s silent: a strong peer would still be held for 16 s
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

  it('keeps both phones in sync when only one of them receives the other strongly', () => {
    const s = settings();
    const a = new ApproachEngine(0xa, s), b = new ApproachEngine(0xb, s);
    a.setLocalCaps([{ key: 'CA', bleName: 'iledcolor-A', label: 'Ann' }]);
    b.setLocalCaps([{ key: 'CB', bleName: 'iledcolor-B', label: 'Bob' }]);
    const hear = (aHearsB: number, bHearsA: number, t: number) => {
      a.onLocalRssi('CA', -45, t); b.onLocalRssi('CB', -45, t);
      a.onAdvertisement({ deviceId: 'pb', rssi: aHearsB, uuids: [encodeBeacon(b.beacon(t))] }, t);
      b.onAdvertisement({ deviceId: 'pa', rssi: bHearsA, uuids: [encodeBeacon(a.beacon(t))] }, t);
    };
    // A hears B strongly, B hears A only weakly (below the near threshold).
    for (let t = 0; t <= 3000; t += 1000) hear(-50, -85, t);
    expect(a.tick(3000)!.tier).toBe('pair');
    expect(b.tick(3000)!.tier).toBe('pair');
    expect(b.heardPhones(3000)[0]).toMatchObject({ near: true, mutual: true });
    // A walks away (its reception drops too): both return to solo together.
    for (let t = 4000; t <= 12000; t += 1000) hear(-95, -95, t);
    expect(a.tick(12000)!.tier).toBe('solo');
    expect(b.tick(12000)!.tier).toBe('solo');
  });

  it('lists heard phones with RSSI and near state, including ones below the near threshold', () => {
    const { a, hear } = pair(settings());
    hear(-82, 0);
    expect(a.heardPhones(0)).toEqual([{ id: '0000000b', label: defaultLabel(0xb, 0), capCount: 1, rssi: -82, near: false, mutual: false }]);
    for (let t = 1000; t <= 6000; t += 1000) hear(-50, t);
    expect(a.heardPhones(6000)[0]).toMatchObject({ near: true });
    expect(a.heardPhones(20000)).toHaveLength(1);
    a.onScanHeard(23000); // the scanner works, so the silent peer is really gone
    expect(a.heardPhones(23000)).toEqual([]);
  });

  it('greets with the user name a peer sends in its scan response, and keeps it when a report lacks it', () => {
    const { a, b } = pair(settings());
    const md = (s: string) => { const bytes = new Uint8Array([0x4c, 0x48, ...new TextEncoder().encode(s)]); return { [String(NAME_COMPANY_ID)]: new DataView(bytes.buffer) }; };
    for (let t = 0; t <= 3000; t += 1000) {
      a.onLocalRssi('CA', -45, t);
      a.onAdvertisement({ deviceId: 'pb', rssi: -50, uuids: [encodeBeacon(b.beacon())], ...(t === 0 ? { manufacturerData: md('Jürgen') } : {}) }, t);
    }
    expect(a.tick(3000)!.perCap.get('CA')).toMatchObject({ text: 'Hi Jürgen!' });
    expect(a.heardPhones(3000)[0]!.label).toBe('Jürgen');
  });
});

describe('beacon name', () => {
  it('fits names into 20 UTF-8 bytes without splitting characters', () => {
    expect(fitBeaconName('  Anna ')).toBe('Anna');
    expect(new TextEncoder().encode(fitBeaconName('ÄÖÜäöüßÄÖÜäöü')).length).toBeLessThanOrEqual(20);
    expect(fitBeaconName('ÄÖÜäöüßÄÖÜäöü')).toBe('ÄÖÜäöüßÄÖÜ');
  });
  it('decodes manufacturer data, falls back to the iOS local name, ignores foreign data', () => {
    const v = new DataView(new Uint8Array([0x4c, 0x48, 0x48, 0x69]).buffer);
    expect(decodeBeaconName({ [String(NAME_COMPANY_ID)]: v })).toBe('Hi');
    expect(decodeBeaconName({ '76': v }, 'Mia')).toBe('Mia');
    expect(decodeBeaconName({ [String(NAME_COMPANY_ID)]: new DataView(new Uint8Array([1, 2, 3]).buffer) })).toBeUndefined();
  });
  it('labels caps with the user name', () => {
    expect(capLabel(7, 0, 'Anna')).toBe('Anna');
    expect(capLabel(7, 1, 'Anna')).toBe('Anna2');
    expect(capLabel(7, 0, ' ')).toBe(defaultLabel(7, 0));
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
  it('starts two caps on the same loop boundary even when their uploads finish at different times', () => {
    const period = 72 * gifDelayMs(44); // 72 frames, 44 ms rounds to the GIF's 40 ms
    expect(gifDelayMs(44)).toBe(40);
    expect(gifDelayMs(3)).toBe(20);
    const capA = 1_700_000_000_123, capB = capA + 2_345; // e.g. different phones / upload sizes
    const startA = capA + msUntilLoopStart(capA, period);
    const startB = capB + msUntilLoopStart(capB, period);
    expect(startA % period).toBe(0);
    expect(startB % period).toBe(0);
    expect(msUntilLoopStart(period * 5, period)).toBe(0);
    expect(msUntilLoopStart(123, 0)).toBe(0);
  });
});

describe('distance estimate', () => {
  it('maps RSSI to rough metres', () => {
    expect(formatMeters(-50)).toBe('< 0.5 m');
    expect(formatMeters(-62)).toBe('≈ 1.0 m');
    expect(formatMeters(-70)).toBe('≈ 2.3 m');
    expect(formatMeters(-85)).toBe('≈ 11 m');
    expect(formatMeters(-110)).toBe('> 50 m');
    expect(formatMeters(undefined)).toBe('');
    expect(dbmForMeters(4)).toBe(-75);
    expect(formatMeters(dbmForMeters(3))).toBe('≈ 2.8 m');
  });

  it('moves the old -80 dBm away default to about 4 m', () => {
    expect(validateApproach({ leaveDbm: -80 }).leaveDbm).toBe(-75);
    expect(validateApproach({ leaveDbm: -85 }).leaveDbm).toBe(-85);
  });
});
