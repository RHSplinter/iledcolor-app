import type { MotionState } from './motion';

/** RSSI smoothing with enter/leave hysteresis, multi-sample confirmation and expiry, so groups do not flicker. */
export interface ProximityOptions {
  /** Smoothed RSSI at or above this marks a participant as near (dBm). */
  enterDbm: number;
  /** A near participant is released only below this (dBm); must be <= enterDbm. */
  leaveDbm: number;
  /** Participants not heard for this long are dropped; strong near ones get twice as long, so short radio gaps do not split a group. */
  staleMs: number;
  /** EMA weight per second (0..1). Scaled by the time between samples, so fast and slow reporters respond alike. */
  alpha: number;
  /** A near/away change needs at least two samples on the new side, spanning this long. */
  confirmMs?: number;
}

export const DEFAULT_PROXIMITY: ProximityOptions = { enterDbm: -70, leaveDbm: -75, staleMs: 8000, alpha: 0.3, confirmMs: 1000 };

/** Reference sample interval for `alpha`. */
const REF_MS = 1000;
/** A sample after a long pause counts at most like this much time. */
const MAX_DT_MS = 3000;
/** Median prefilter: up to this many raw samples, no older than MEDIAN_MS. */
const MEDIAN_N = 3;
const MEDIAN_MS = 2500;
/** Smoothed RSSI falling at least this fast (dB/s) below the enter threshold counts as walking away. */
const FADE_DB_PER_S = 0.5;
/** A silent scanner (nothing at all heard) holds strong participants at most this much longer. */
const OUTAGE_MIN_MS = 2000;
const OUTAGE_MAX_MS = 10000;

interface Entry {
  ema: number; near: boolean; lastSeen: number; group: string;
  raw: { t: number; rssi: number }[];
  slope: number;
  pendingSince?: number; pendingSamples: number;
  crossingSince?: number; crossingSamples: number; lastCrossingSample: number;
}

export function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class ProximityTracker {
  private entries = new Map<string, Entry>();
  /** Last time anything at all was heard per source group (e.g. the BLE scanner). */
  private groupHeard = new Map<string, number>();
  constructor(public opts: ProximityOptions = DEFAULT_PROXIMITY) {}

  /** Something was received on this source group (even if it is not tracked), so the receiver works. */
  heard(group: string, now: number): void {
    if ((this.groupHeard.get(group) ?? -Infinity) < now) this.groupHeard.set(group, now);
  }

  update(key: string, rssi: number, now: number, motion: MotionState = 'unavailable', group = 'local'): void {
    if (!Number.isFinite(rssi) || rssi >= 0 || rssi < -127) return; // 127/0 mean "unknown" on some stacks
    this.heard(group, now);
    const previous = this.entries.get(key);
    const e = previous && now >= previous.lastSeen && now - previous.lastSeen <= this.ttl(previous, now) ? previous : undefined;
    const leaveAt = Math.min(this.opts.leaveDbm, this.opts.enterDbm);
    const raw = [...(e?.raw ?? []).filter((s) => now - s.t <= MEDIAN_MS), { t: now, rssi }].slice(-MEDIAN_N);
    const filtered = median(raw.map((s) => s.rssi));

    const crossing = e && (e.near ? rssi < leaveAt : rssi >= this.opts.enterDbm);
    const continuous = e && now - e.lastSeen <= 1500;
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
    const dt = e ? Math.min(MAX_DT_MS, now - e.lastSeen) : 0;
    const a = alpha >= 1 ? (dt > 0 || !e ? 1 : 0) : 1 - Math.pow(1 - alpha, dt / REF_MS);
    const ema = e ? e.ema + a * (filtered - e.ema) : filtered;
    const slope = e && dt > 0 ? e.slope + Math.max(a, 0.3) * ((ema - e.ema) / (dt / 1000) - e.slope) : e?.slope ?? 0;

    // A change of state needs repeated evidence: one strong (or weak) report never flips it.
    let near = e?.near ?? false;
    let pendingSince: number | undefined;
    let pendingSamples = 0;
    const wants = near ? ema >= leaveAt : ema >= this.opts.enterDbm;
    if (wants !== near) {
      pendingSince = e?.pendingSince ?? now;
      pendingSamples = (e?.pendingSince !== undefined ? e.pendingSamples : 0) + 1;
      const confirm = (this.opts.confirmMs ?? 0) / (motion === 'moving' ? 2 : 1);
      if (pendingSamples >= 2 && now - pendingSince >= confirm || confirm <= 0) {
        near = wants;
        pendingSince = undefined;
        pendingSamples = 0;
      }
    }
    this.entries.set(key, { ema, near, lastSeen: now, group, raw, slope, pendingSince, pendingSamples, crossingSince, crossingSamples, lastCrossingSample });
  }

  /** True when the signal was clearly falling below the enter threshold when last heard: someone walking away. */
  private fading(e: Entry): boolean { return e.ema < this.opts.enterDbm && e.slope <= -FADE_DB_PER_S; }

  /**
   * Silence means different things: a strong participant that vanishes is probably a radio gap (2x staleMs,
   * plus a bounded hold while the whole receiver hears nothing), one that was fading is leaving (staleMs).
   */
  private ttl(e: Entry, now: number): number {
    if (!e.near || this.fading(e)) return this.opts.staleMs;
    const silence = now - (this.groupHeard.get(e.group) ?? e.lastSeen);
    return 2 * this.opts.staleMs + (silence >= OUTAGE_MIN_MS ? Math.min(OUTAGE_MAX_MS, silence) : 0);
  }

  expire(now: number): void {
    for (const [k, e] of this.entries) if (now - e.lastSeen > this.ttl(e, now)) this.entries.delete(k);
  }

  isNear(key: string, now: number): boolean {
    const e = this.entries.get(key);
    return !!e && e.near && now - e.lastSeen <= this.ttl(e, now);
  }

  /** Heard recently enough not to be stale (near or not). */
  isHeard(key: string, now: number): boolean {
    const e = this.entries.get(key);
    return !!e && now - e.lastSeen <= this.ttl(e, now);
  }

  /** Heard within `ms` (independent of the near/stale grace periods). */
  isFresh(key: string, now: number, ms: number): boolean {
    const e = this.entries.get(key);
    return !!e && now - e.lastSeen <= ms;
  }

  rssi(key: string): number | undefined { return this.entries.get(key)?.ema; }
  /** Smoothed RSSI trend in dB/s (negative = getting weaker). */
  trend(key: string): number | undefined { return this.entries.get(key)?.slope; }
  forget(key: string): void { this.entries.delete(key); }
  keys(): string[] { return [...this.entries.keys()]; }
}
