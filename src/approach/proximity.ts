import type { MotionState } from './motion';

/** RSSI smoothing with enter/leave hysteresis and expiry, so groups do not flicker. */
export interface ProximityOptions {
  /** Smoothed RSSI at or above this marks a participant as near (dBm). */
  enterDbm: number;
  /** A near participant is released only below this (dBm); must be <= enterDbm. */
  leaveDbm: number;
  /** Participants not heard for this long are dropped; near ones get twice as long, so short radio gaps do not split a group. */
  staleMs: number;
  /** EMA weight of each new sample, 0..1. */
  alpha: number;
}

export const DEFAULT_PROXIMITY: ProximityOptions = { enterDbm: -70, leaveDbm: -75, staleMs: 8000, alpha: 0.3 };

interface Entry {
  ema: number; near: boolean; lastSeen: number;
  crossingSince?: number; crossingSamples: number; lastCrossingSample: number;
}

export class ProximityTracker {
  private entries = new Map<string, Entry>();
  constructor(public opts: ProximityOptions = DEFAULT_PROXIMITY) {}

  update(key: string, rssi: number, now: number, motion: MotionState = 'unavailable'): void {
    if (!Number.isFinite(rssi) || rssi >= 0 || rssi < -127) return; // 127/0 mean "unknown" on some stacks
    const previous = this.entries.get(key);
    const e = previous && now - previous.lastSeen <= this.ttl(previous) ? previous : undefined;
    const crossing = e && (e.near ? rssi < Math.min(this.opts.leaveDbm, this.opts.enterDbm) : rssi >= this.opts.enterDbm);
    const continuous = e && now - e.lastSeen <= 1500 && now >= e.lastSeen;
    const crossingSince = crossing ? (continuous ? e.crossingSince : undefined) ?? now : undefined;
    const counted = crossing && (!continuous || e.crossingSince === undefined || now - e.lastCrossingSample >= 250);
    const crossingSamples = crossing ? (continuous ? e.crossingSamples : 0) + (counted ? 1 : 0) : 0;
    const lastCrossingSample = counted ? now : e?.lastCrossingSample ?? now;
    const duration = crossingSince === undefined ? 0 : now - crossingSince;
    // Rotation can change antenna/body shadowing without changing distance. Never freeze RSSI:
    // sustained threshold evidence restores normal filtering even during continuous rotation.
    let alpha = this.opts.alpha;
    if (motion === 'turning' && !(duration >= 2000 && crossingSamples >= 3)) alpha = Math.min(alpha, 0.1);
    else if (motion === 'moving' && duration >= 1000 && crossingSamples >= 3) alpha = Math.max(alpha, 0.6);
    const ema = e ? e.ema + alpha * (rssi - e.ema) : rssi;
    let near = e?.near ?? false;
    if (!near && ema >= this.opts.enterDbm) near = true;
    else if (near && ema < Math.min(this.opts.leaveDbm, this.opts.enterDbm)) near = false;
    this.entries.set(key, { ema, near, lastSeen: now, crossingSince, crossingSamples, lastCrossingSample });
  }

  private ttl(e: Entry): number { return e.near ? 2 * this.opts.staleMs : this.opts.staleMs; }

  expire(now: number): void {
    for (const [k, e] of this.entries) if (now - e.lastSeen > this.ttl(e)) this.entries.delete(k);
  }

  isNear(key: string, now: number): boolean {
    const e = this.entries.get(key);
    return !!e && e.near && now - e.lastSeen <= this.ttl(e);
  }

  /** Heard recently enough not to be stale (near or not). */
  isHeard(key: string, now: number): boolean {
    const e = this.entries.get(key);
    return !!e && now - e.lastSeen <= this.ttl(e);
  }

  rssi(key: string): number | undefined { return this.entries.get(key)?.ema; }
  forget(key: string): void { this.entries.delete(key); }
  keys(): string[] { return [...this.entries.keys()]; }
}
