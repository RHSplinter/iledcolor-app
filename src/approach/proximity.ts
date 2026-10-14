/** RSSI smoothing with enter/leave hysteresis and expiry, so groups do not flicker. */
export interface ProximityOptions {
  /** Smoothed RSSI at or above this marks a participant as near (dBm). */
  enterDbm: number;
  /** A near participant is released only below this (dBm); must be <= enterDbm. */
  leaveDbm: number;
  /** Participants not heard for this long are dropped. */
  staleMs: number;
  /** EMA weight of each new sample, 0..1. */
  alpha: number;
}

export const DEFAULT_PROXIMITY: ProximityOptions = { enterDbm: -70, leaveDbm: -80, staleMs: 8000, alpha: 0.3 };

interface Entry { ema: number; near: boolean; lastSeen: number }

export class ProximityTracker {
  private entries = new Map<string, Entry>();
  constructor(public opts: ProximityOptions = DEFAULT_PROXIMITY) {}

  update(key: string, rssi: number, now: number): void {
    if (!Number.isFinite(rssi) || rssi >= 0 || rssi < -127) return; // 127/0 mean "unknown" on some stacks
    const e = this.entries.get(key);
    const ema = e ? e.ema + this.opts.alpha * (rssi - e.ema) : rssi;
    let near = e?.near ?? false;
    if (!near && ema >= this.opts.enterDbm) near = true;
    else if (near && ema < Math.min(this.opts.leaveDbm, this.opts.enterDbm)) near = false;
    this.entries.set(key, { ema, near, lastSeen: now });
  }

  expire(now: number): void {
    for (const [k, e] of this.entries) if (now - e.lastSeen > this.opts.staleMs) this.entries.delete(k);
  }

  isNear(key: string, now: number): boolean {
    const e = this.entries.get(key);
    return !!e && e.near && now - e.lastSeen <= this.opts.staleMs;
  }

  rssi(key: string): number | undefined { return this.entries.get(key)?.ema; }
  forget(key: string): void { this.entries.delete(key); }
  keys(): string[] { return [...this.entries.keys()]; }
}
