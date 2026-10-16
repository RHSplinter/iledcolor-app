import { describe, expect, it, vi } from 'vitest';
import type { PluginListenerHandle } from '@capacitor/core';
import { MotionTracker, type MotionSample } from '../src/approach/motion';
import { MotionSupport } from '../src/approach/motionSupport';
import { ProximityTracker } from '../src/approach/proximity';
import { ApproachEngine } from '../src/approach/engine';
import { encodeBeacon } from '../src/approach/beaconCodec';
import { DEFAULT_APPROACH } from '../src/approach/tiers';

describe('phone motion classification', () => {
  it('uses recent acceleration and rotation without assuming a heading', () => {
    const m = new MotionTracker();
    expect(m.state(0)).toBe('unavailable');
    m.update({ acceleration: 0, rotation: 0 }, 0);
    expect(m.state(0)).toBe('still');
    m.update({ acceleration: 1, rotation: 0 }, 100);
    expect(m.state(100)).toBe('moving');
    m.update({ acceleration: 0, rotation: 1 }, 200);
    expect(m.state(200)).toBe('turning');
    m.update({ acceleration: 0, rotation: 0 }, 1000);
    expect(m.state(1000)).toBe('moving');
    expect(m.state(1600)).toBe('still');
    expect(m.state(2501)).toBe('unavailable');
    m.reset();
    expect(m.state(1000)).toBe('unavailable');
  });

  it('rejects invalid, negative and out-of-order samples', () => {
    const m = new MotionTracker();
    for (const sample of [
      { acceleration: NaN, rotation: 0 }, { acceleration: 0, rotation: Infinity },
      { acceleration: -1, rotation: 0 }, { acceleration: 0, rotation: -1 },
    ]) m.update(sample, 0);
    m.update({ acceleration: 1, rotation: 1 }, NaN);
    expect(m.state(0)).toBe('unavailable');
    m.update({ acceleration: 0, rotation: 0 }, 100);
    m.update({ acceleration: 1, rotation: 1 }, 50);
    expect(m.state(100)).toBe('still');
    expect(m.state(99)).toBe('unavailable');
  });
});

const tracker = (confirmMs = 0) => new ProximityTracker({ enterDbm: -70, leaveDbm: -75, staleMs: 8000, alpha: 0.3, confirmMs });

describe('motion-assisted RSSI', () => {
  it.each(['still', 'unavailable'] as const)('preserves the existing filter when %s', (motion) => {
    const baseline = tracker(), assisted = tracker();
    for (const [t, rssi] of [-90, -80, -60, -55, -65, -90, -95].entries()) {
      baseline.update('a', rssi, t * 1000);
      assisted.update('a', rssi, t * 1000, motion);
      expect(assisted.rssi('a')).toBe(baseline.rssi('a'));
      expect(assisted.isNear('a', t * 1000)).toBe(baseline.isNear('a', t * 1000));
    }
  });

  it.each([
    { initial: -85, target: -65, near: true },
    { initial: -60, target: -80, near: false },
  ])('follows sustained walking evidence faster: $initial to $target', ({ initial, target, near }) => {
    const baseline = tracker(1000), assisted = tracker(1000);
    for (const t of [0, 1000, 2000]) {
      baseline.update('a', initial, t);
      assisted.update('a', initial, t, 'moving');
    }
    for (let t = 2500; t <= 5000; t += 500) {
      baseline.update('a', target, t);
      assisted.update('a', target, t, 'moving');
    }
    expect(assisted.isNear('a', 5000)).toBe(near);
    expect(baseline.isNear('a', 5000)).toBe(!near);
  });

  it('does not treat motion alone as approach or departure', () => {
    const t = tracker();
    t.update('far', -90, 0);
    t.update('near', -60, 0);
    for (let now = 500; now <= 5000; now += 500) {
      t.update('far', -90, now, 'moving');
      t.update('near', -60, now, 'moving');
    }
    expect(t.isNear('far', 5000)).toBe(false);
    expect(t.isNear('near', 5000)).toBe(true);
  });

  it('dampens a brief rotation-related dip, but does not suppress real departure indefinitely', () => {
    const baseline = tracker(1000), assisted = tracker(1000);
    const both = (rssi: number, now: number) => { baseline.update('a', rssi, now); assisted.update('a', rssi, now, 'turning'); };
    for (const now of [0, 1000, 2000]) both(-66, now);
    both(-100, 2500);
    both(-100, 3000);
    both(-66, 3500);
    expect(baseline.rssi('a')!).toBeLessThan(-75);
    expect(assisted.rssi('a')!).toBeGreaterThan(-70);
    expect(assisted.isNear('a', 3500)).toBe(true);
    for (let now = 4000; now <= 9000; now += 500) assisted.update('a', -85, now, 'turning');
    expect(assisted.isNear('a', 9000)).toBe(false);
  });

  it('does not accelerate a burst of advertisements or carry evidence across a radio gap', () => {
    const baseline = tracker(), assisted = tracker();
    for (const t of [baseline, assisted]) t.update('a', -90, 0);
    for (const now of [100, 110, 120]) {
      baseline.update('a', -69, now);
      assisted.update('a', -69, now, 'moving');
      expect(assisted.rssi('a')).toBe(baseline.rssi('a'));
    }
    baseline.update('a', -69, 3000);
    assisted.update('a', -69, 3000, 'moving');
    expect(assisted.rssi('a')).toBe(baseline.rssi('a'));
  });

  it('requires new sustained evidence after an interrupted crossing', () => {
    const baseline = tracker(), assisted = tracker();
    const both = (rssi: number, now: number) => { baseline.update('a', rssi, now); assisted.update('a', rssi, now, 'moving'); };
    for (const now of [0, 500]) both(-90, now);
    both(-69, 1000);
    both(-69, 1500);
    both(-90, 1750); // interrupts the crossing
    both(-69, 2000);
    both(-69, 2500);
    expect(assisted.rssi('a')).toBeCloseTo(baseline.rssi('a')!);
  });

  it('still expires moving/turning participants and starts stale entries afresh', () => {
    const t = tracker();
    t.update('a', -60, 0, 'moving');
    t.heard('local', 16001); // the receiver works, so this is not a radio gap
    expect(t.isNear('a', 16001)).toBe(false);
    t.update('a', -90, 16001, 'turning');
    expect(t.rssi('a')).toBe(-90);
    expect(t.isNear('a', 16001)).toBe(false);
    t.expire(24002);
    expect(t.keys()).toEqual([]);
  });
});

describe('motion fusion across all detection sources', () => {
  it('uses motion for local caps, phone beacons and unconnected caps, then falls back when stale', () => {
    const e = new ApproachEngine(1, { ...DEFAULT_APPROACH, settleMs: 0, countNearbyCaps: true });
    const report = (rssi: number, now: number) => {
      e.onLocalRssi('local', rssi, now);
      e.onAdvertisement({ deviceId: 'phone', rssi, uuids: [encodeBeacon({ phoneId: 2, capCount: 1, capHashes: [] })] }, now);
      e.onAdvertisement({ deviceId: 'cap', name: 'iledcolor-other', rssi }, now);
    };
    const still = new ApproachEngine(1, { ...DEFAULT_APPROACH, settleMs: 0, countNearbyCaps: true });
    report(-85, 0);
    still.onLocalRssi('local', -85, 0);
    for (let now = 500; now <= 3000; now += 500) {
      e.onMotion({ acceleration: 1, rotation: 0 }, now);
      report(-65, now);
      still.onLocalRssi('local', -65, now);
    }
    for (const key of ['local', 'peer:00000002', 'cap:cap']) expect(e.tracker.isNear(key, 3000)).toBe(true);
    expect(still.tracker.isNear('local', 3000)).toBe(false);
    // Stale motion: back to the plain time-based filter (the median prefilter still holds -65 for one sample).
    expect(e.motion.state(4501)).toBe('unavailable');
    const before = e.tracker.rssi('local')!;
    report(-90, 4600);
    expect(e.tracker.rssi('local')).toBeCloseTo(before + (1 - 0.7 ** 1.6) * (-65 - before));
  });

  it('preserves settle time and manual local marquee order while moving or turning', () => {
    const e = new ApproachEngine(1, DEFAULT_APPROACH);
    e.setLocalCaps(['right', 'left', 'middle'].map((key) => ({ key, label: key, bleName: `iledcolor-${key}` })));
    const report = (now: number) => {
      e.onMotion({ acceleration: 1, rotation: now === 0 ? 1 : 0 }, now);
      for (const key of ['right', 'left', 'middle']) e.onLocalRssi(key, -50, now);
    };
    report(0);
    expect(e.tick(0)).toBeNull();
    report(1000); // near is confirmed with the second sample
    expect(e.tick(1000)).toBeNull();
    report(2000);
    expect(e.tick(2000)).toBeNull(); // settling
    report(3000);
    const plan = e.tick(3000)!;
    expect(plan.members.map((m) => m.key)).toEqual(['right', 'left', 'middle']);
    expect(plan.perCap.get('right')).toMatchObject({ kind: 'span', index: 0, total: 3 });
    expect(plan.perCap.get('middle')).toMatchObject({ kind: 'span', index: 2, total: 3 });
  });
});

class FakeMotionSource {
  samples?: (sample: MotionSample) => void;
  errors?: (error: { message: string }) => void;
  removeSample = vi.fn(async () => { this.samples = undefined; });
  removeError = vi.fn(async () => { this.errors = undefined; });
  startMotion = vi.fn(async () => {});
  stopMotion = vi.fn(async () => {});
  addListener(event: 'motion', listener: (sample: MotionSample) => void): Promise<PluginListenerHandle>;
  addListener(event: 'motionError', listener: (error: { message: string }) => void): Promise<PluginListenerHandle>;
  async addListener(...[event, listener]:
    ['motion', (sample: MotionSample) => void] | ['motionError', (error: { message: string }) => void]) {
    if (event === 'motion') {
      this.samples = listener;
      return { remove: this.removeSample };
    }
    this.errors = listener;
    return { remove: this.removeError };
  }
}

describe('native motion lifecycle', () => {
  it('subscribes before starting, forwards samples/errors, and removes only its own listeners', async () => {
    const source = new FakeMotionSource(), sample = vi.fn(), error = vi.fn();
    const support = new MotionSupport(source, sample, error);
    source.startMotion.mockImplementation(async () => { expect(source.samples).toBeDefined(); });
    await support.start();
    source.samples?.({ acceleration: 1, rotation: 0 });
    source.errors?.({ message: 'Permission denied' });
    expect(sample).toHaveBeenCalledWith({ acceleration: 1, rotation: 0 });
    expect(error).toHaveBeenCalledWith('Permission denied');
    await support.stop();
    expect(source.removeSample).toHaveBeenCalledOnce();
    expect(source.removeError).toHaveBeenCalledOnce();
    expect(source.stopMotion).toHaveBeenCalledOnce();
    await support.stop();
    expect(source.stopMotion).toHaveBeenCalledOnce();
  });

  it('cleans up a failed start and can restart', async () => {
    const source = new FakeMotionSource(), error = vi.fn();
    const support = new MotionSupport(source, vi.fn(), error);
    source.startMotion.mockRejectedValueOnce(new Error('Sensors unavailable'));
    await support.start();
    expect(error).toHaveBeenCalledWith('Sensors unavailable');
    expect(source.samples).toBeUndefined();
    expect(source.errors).toBeUndefined();
    expect(source.stopMotion).toHaveBeenCalledOnce();
    await support.start();
    expect(source.samples).toBeDefined();
    await support.stop();
  });

  it('cleans up partial listener registration when setup fails', async () => {
    const source = new FakeMotionSource(), error = vi.fn();
    vi.spyOn(source, 'addListener').mockResolvedValueOnce({ remove: source.removeSample })
      .mockRejectedValueOnce(new Error('Bridge unavailable'));
    const support = new MotionSupport(source, vi.fn(), error);
    await support.start();
    expect(source.removeSample).toHaveBeenCalledOnce();
    expect(source.startMotion).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Bridge unavailable');
  });

  it('reports cleanup failures without preventing other resources from being released', async () => {
    const source = new FakeMotionSource(), error = vi.fn();
    const support = new MotionSupport(source, vi.fn(), error);
    await support.start();
    source.removeSample.mockRejectedValueOnce(new Error('Listener removal failed'));
    await support.stop();
    expect(source.removeError).toHaveBeenCalledOnce();
    expect(source.stopMotion).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Listener removal failed'));
  });

  it('serializes stop with pending startup', async () => {
    const source = new FakeMotionSource();
    let release!: () => void;
    source.startMotion.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const support = new MotionSupport(source, vi.fn(), vi.fn());
    const started = support.start();
    await vi.waitFor(() => expect(source.startMotion).toHaveBeenCalledOnce());
    const stopped = support.stop();
    release();
    await Promise.all([started, stopped]);
    expect(source.samples).toBeUndefined();
    expect(source.errors).toBeUndefined();
    expect(source.stopMotion).toHaveBeenCalledOnce();
  });
});
