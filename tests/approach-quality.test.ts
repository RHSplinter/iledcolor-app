import { describe, expect, it } from 'vitest';
import { encodeBeacon, nearMaskFor } from '../src/approach/beaconCodec';
import { calibrate } from '../src/approach/calibration';
import { ApproachEngine } from '../src/approach/engine';
import { DEFAULT_APPROACH, type ApproachSettings } from '../src/approach/tiers';
import { parseTrace, replayTrace, TraceRecorder, type Trace } from '../src/approach/trace';

const settings = (over: Partial<ApproachSettings> = {}): ApproachSettings => ({ ...DEFAULT_APPROACH, settleMs: 0, confirmMs: 0, ...over });

describe('calibration', () => {
  it('derives thresholds between the together and away levels, ignoring outliers', () => {
    const c = calibrate([-50, -52, -51, -49, -90, -50], [-80, -82, -81, -79, -40, -80]);
    expect(c).toEqual({ togetherDbm: -50, awayDbm: -80, leaveDbm: -78, enterDbm: -62 });
  });
  it('keeps at least 2 dB of hysteresis when the levels are close', () => {
    const c = calibrate(Array(5).fill(-60), Array(5).fill(-66));
    expect(c).toMatchObject({ leaveDbm: -64, enterDbm: -62 });
  });
  it('rejects too few samples and indistinguishable distances', () => {
    expect(calibrate([-50, -50], [-80, -80, -80, -80, -80])).toHaveProperty('error');
    expect(calibrate(Array(5).fill(-60), Array(5).fill(-63))).toHaveProperty('error');
  });
});

describe('mutual near plausibility', () => {
  const setup = () => {
    const a = new ApproachEngine(0xa, settings());
    a.setLocalCaps([{ key: 'CA', bleName: 'iledcolor-A', label: 'Ann' }]);
    const claimsNear = encodeBeacon({ phoneId: 0xb, capCount: 1, capHashes: [], nearMask: nearMaskFor([0xa]) });
    const hear = (rssi: number, t: number) => { a.onLocalRssi('CA', -45, t); a.onAdvertisement({ deviceId: 'pb', rssi, uuids: [claimsNear] }, t); };
    return { a, hear };
  };
  it('trusts a peer that lists us as near only while we hear it plausibly', () => {
    const { a, hear } = setup();
    for (let t = 0; t <= 2000; t += 1000) hear(-82, t); // weaker than "away" but within the margin
    expect(a.tick(2000)!.tier).toBe('pair');
    expect(a.heardPhones(2000)[0]).toMatchObject({ near: true, mutual: true });
  });
  it('ignores the claim when the peer is far too weak', () => {
    const { a, hear } = setup();
    for (let t = 0; t <= 4000; t += 1000) hear(-95, t);
    expect(a.tick(4000)!.tier).toBe('solo');
  });
  it('ignores a stale claim from a peer not heard for a while', () => {
    const { a, hear } = setup();
    for (let t = 0; t <= 2000; t += 1000) hear(-82, t);
    expect(a.tick(2000)!.tier).toBe('pair');
    for (let t = 3000; t <= 7000; t += 1000) { a.onLocalRssi('CA', -45, t); a.onScanHeard(t); }
    expect(a.tick(7000)!.tier).toBe('solo');
  });
});

describe('chain groups', () => {
  // A -- B -- C in a row: A and C are too far apart for each other, B is near both.
  const chain = (s: ApproachSettings) => {
    const e = { a: new ApproachEngine(0xa, s), b: new ApproachEngine(0xb, s), c: new ApproachEngine(0xc, s) };
    e.a.setLocalCaps([{ key: 'CA', bleName: 'iledcolor-A', label: 'Ann' }]);
    e.b.setLocalCaps([{ key: 'CB', bleName: 'iledcolor-B', label: 'Bob' }]);
    e.c.setLocalCaps([{ key: 'CC', bleName: 'iledcolor-C', label: 'Cem' }]);
    const rssi: Record<string, number> = { ab: -50, bc: -50, ac: -90 };
    const step = (t: number) => {
      const beacons = { a: encodeBeacon(e.a.beacon(t)), b: encodeBeacon(e.b.beacon(t)), c: encodeBeacon(e.c.beacon(t)) };
      for (const [me, eng] of Object.entries(e)) {
        eng.onLocalRssi(`C${me.toUpperCase()}`, -45, t);
        for (const other of ['a', 'b', 'c'] as const) {
          if (other === me) continue;
          eng.onAdvertisement({ deviceId: `p${other}`, rssi: rssi[[me, other].sort().join('')]!, uuids: [beacons[other]] }, t);
        }
      }
    };
    return { ...e, step };
  };

  it('puts every phone of a chain into the same marquee group', () => {
    const { a, b, c, step } = chain(settings());
    for (let t = 0; t <= 4000; t += 1000) step(t);
    const plans = [a.tick(4000)!, b.tick(4000)!, c.tick(4000)!];
    for (const p of plans) expect(p.count).toBe(3);
    expect(plans[0]!.members.find((m) => m.phoneId === 0xc)).toMatchObject({ indirect: true });
    const indexes = plans.map((p, i) => (p.perCap.get(['CA', 'CB', 'CC'][i]!) as { index: number }).index);
    expect(new Set(indexes)).toEqual(new Set([0, 1, 2]));
  });

  it('keeps greetings with direct neighbours only', () => {
    const base = settings();
    const s = { ...base, tiers: { ...base.tiers, upTo4: { ...base.tiers.upTo4, mode: 'individual' as const, text: 'Hi {others}!' } } };
    const { a, b, step } = chain(s);
    for (let t = 0; t <= 4000; t += 1000) step(t);
    expect(a.tick(4000)!.count).toBe(2);
    expect(b.tick(4000)!.count).toBe(3);
  });
});

describe('trace recording and replay', () => {
  const record = () => {
    const s = settings({ confirmMs: 1000, settleMs: 2000 });
    const a = new ApproachEngine(0xa, s);
    const rec = new TraceRecorder(0xa, s, 0);
    a.recorder = rec;
    a.onScanHeard(0); // sets the engine clock used for the caps event
    a.setLocalCaps([{ key: 'CA', bleName: 'iledcolor-A', label: 'Ann' }]);
    const peer = encodeBeacon({ phoneId: 0xb, capCount: 1, capHashes: [], nearMask: 0 });
    const walk: [number, number][] = [];
    for (let t = 0; t < 10000; t += 1000) walk.push([t, -90]);
    for (let t = 10000; t < 30000; t += 1000) walk.push([t, t === 20000 ? -95 : -55]); // one outlier
    for (let t = 30000; t <= 50000; t += 1000) walk.push([t, -90]);
    for (const [t, rssi] of walk) {
      if (t === 10000) rec.push({ t, k: 'mark', together: true });
      if (t === 30000) rec.push({ t, k: 'mark', together: false });
      a.onLocalRssi('CA', -45, t);
      a.onAdvertisement({ deviceId: 'pb', rssi, uuids: [peer] }, t);
      a.onAdvertisement({ deviceId: 'x', rssi: -70, name: 'headphones' }, t);
    }
    return rec.toTrace();
  };

  it('round-trips through JSON and rejects foreign or broken files', () => {
    const trace = record();
    expect(trace.events.filter((e) => e.k === 'heard').length).toBeLessThanOrEqual(51);
    expect(parseTrace(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
    expect(() => parseTrace({ format: 'other' })).toThrow();
    const broken = JSON.parse(JSON.stringify(trace)) as Trace;
    (broken.events as unknown[]).push({ t: 1, k: 'rssi', key: 'CA' });
    expect(() => parseTrace(broken)).toThrow(/Invalid trace event/);
  });

  it('replays a walk and measures group changes and latencies against the marks', () => {
    const m = replayTrace(record());
    expect(m.applied.map((x) => x.count)).toEqual([1, 2, 1]);
    expect(m.groupChanges).toBe(2);
    expect(m.flaps).toBe(0);
    expect(m.marks!.entryMs[0]).toBeGreaterThan(0);
    expect(m.marks!.entryMs[0]).toBeLessThanOrEqual(6000);
    expect(m.marks!.exitMs[0]).toBeGreaterThan(0);
    expect(m.marks!.exitMs[0]).toBeLessThanOrEqual(10000);
    expect(m.marks!.missedGroupMs).toBe(m.marks!.entryMs[0]);
    expect(m.marks!.falseGroupMs).toBe(m.marks!.exitMs[0]);
  });

  it('evaluates the same walk with other settings', () => {
    const trace = record();
    const strict = replayTrace(trace, settings({ enterDbm: -50, leaveDbm: -60 }));
    expect(strict.applied.map((x) => x.count)).toEqual([1]);
    expect(strict.marks!.entryMs[0]).toBeNull();
  });
});
