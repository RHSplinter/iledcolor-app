import { ApproachEngine, type LocalCap } from './engine';
import { validateApproach, type ApproachSettings } from './tiers';

/** Engine inputs, recorded so a walk can be replayed with other settings. Times are ms since the epoch. */
export type TraceEvent =
  | { t: number; k: 'caps'; caps: LocalCap[] }
  | { t: number; k: 'rssi'; key: string; rssi: number }
  | { t: number; k: 'adv'; deviceId: string; rssi: number; uuids?: string[]; name?: string; peerName?: string }
  | { t: number; k: 'heard' }
  | { t: number; k: 'motion'; a: number; r: number }
  | { t: number; k: 'settings'; settings: ApproachSettings }
  /** Ground truth tapped by the user while recording: the wearers are together / apart now. */
  | { t: number; k: 'mark'; together: boolean };

export interface Trace { format: 'iledcolor-approach-trace'; version: 1; phoneId: number; settings: ApproachSettings; startedAt: number; truncated: boolean; events: TraceEvent[] }

export const TRACE_MAX_EVENTS = 100_000;

export class TraceRecorder {
  readonly events: TraceEvent[] = [];
  truncated = false;
  private lastHeard = -Infinity;
  constructor(readonly phoneId: number, readonly settings: ApproachSettings, readonly startedAt = Date.now(), private max = TRACE_MAX_EVENTS) {}

  push(e: TraceEvent): void {
    // Untracked advertisements only matter as "the scanner works"; one per second is enough.
    if (e.k === 'heard') { if (e.t - this.lastHeard < 1000) return; this.lastHeard = e.t; }
    if (this.events.length >= this.max) { this.truncated = true; return; }
    this.events.push(e);
  }

  toTrace(): Trace {
    return { format: 'iledcolor-approach-trace', version: 1, phoneId: this.phoneId, settings: structuredClone(this.settings), startedAt: this.startedAt, truncated: this.truncated, events: this.events.slice().sort((x, y) => x.t - y.t) };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';

function parseEvent(v: unknown): TraceEvent | null {
  if (!isObj(v) || !fin(v.t)) return null;
  const t = v.t;
  switch (v.k) {
    case 'caps':
      return Array.isArray(v.caps) && v.caps.every((c) => isObj(c) && str(c.key) && str(c.bleName) && str(c.label))
        ? { t, k: 'caps', caps: (v.caps as Record<string, string>[]).map((c) => ({ key: c.key!, bleName: c.bleName!, label: c.label! })) } : null;
    case 'rssi': return str(v.key) && fin(v.rssi) ? { t, k: 'rssi', key: v.key, rssi: v.rssi } : null;
    case 'adv':
      if (!str(v.deviceId) || !fin(v.rssi) || (v.uuids !== undefined && !(Array.isArray(v.uuids) && v.uuids.every(str)))) return null;
      return { t, k: 'adv', deviceId: v.deviceId, rssi: v.rssi, ...(v.uuids ? { uuids: v.uuids as string[] } : {}),
        ...(str(v.name) ? { name: v.name } : {}), ...(str(v.peerName) ? { peerName: v.peerName } : {}) };
    case 'heard': return { t, k: 'heard' };
    case 'motion': return fin(v.a) && fin(v.r) ? { t, k: 'motion', a: v.a, r: v.r } : null;
    case 'settings': return { t, k: 'settings', settings: validateApproach(v.settings) };
    case 'mark': return typeof v.together === 'boolean' ? { t, k: 'mark', together: v.together } : null;
    default: return null;
  }
}

/** Strict: a file with any invalid event is rejected as a whole. */
export function parseTrace(raw: unknown): Trace {
  if (!isObj(raw) || raw.format !== 'iledcolor-approach-trace' || raw.version !== 1) throw new Error('Not an approach trace file');
  if (!fin(raw.phoneId) || !fin(raw.startedAt) || !Array.isArray(raw.events)) throw new Error('Incomplete approach trace');
  const events: TraceEvent[] = [];
  for (const [i, e] of raw.events.entries()) {
    const p = parseEvent(e);
    if (!p) throw new Error(`Invalid trace event #${i + 1}`);
    events.push(p);
  }
  events.sort((a, b) => a.t - b.t);
  return { format: 'iledcolor-approach-trace', version: 1, phoneId: raw.phoneId >>> 0, settings: validateApproach(raw.settings), startedAt: raw.startedAt, truncated: raw.truncated === true, events };
}

export interface ReplayMetrics {
  durationMs: number;
  /** Group sizes sent to the caps, in order (the first one is the start state). */
  applied: { t: number; count: number }[];
  groupChanges: number;
  changesPerMinute: number;
  /** Changes undone (back to the previous size) within FLAP_MS. */
  flaps: number;
  /** Ground truth from marks; undefined without marks. */
  marks?: {
    /** Time from "together" until a group was sent, per mark; null if it never came before the next mark. */
    entryMs: (number | null)[];
    /** Time from "apart" until the caps were back alone, per mark; null if never. */
    exitMs: (number | null)[];
    /** Marked apart, but the caps showed group content. */
    falseGroupMs: number;
    /** Marked together, but the caps showed solo content (includes the entry latency). */
    missedGroupMs: number;
  };
}

export const FLAP_MS = 10_000;
export const MAX_REPLAY_MS = 6 * 3600_000;
const TICK_MS = 1000;

/**
 * Feeds a recorded walk into a fresh engine, ticking once per second like the app loop, and measures
 * how often and how fast the group changed. With `settings`, the same walk is evaluated with other thresholds.
 */
export function replayTrace(trace: Trace, settings?: ApproachSettings): ReplayMetrics {
  const fixed = settings !== undefined;
  const engine = new ApproachEngine(trace.phoneId, validateApproach(settings ?? trace.settings));
  const events = trace.events;
  const start = events[0]?.t ?? trace.startedAt;
  const end = events[events.length - 1]?.t ?? start;
  if (end - start > MAX_REPLAY_MS) throw new Error('Trace spans more than 6 hours; timestamps look inconsistent');
  const applied: ReplayMetrics['applied'] = [];
  let i = 0;
  for (let now = start; now <= end + TICK_MS; now += TICK_MS) {
    for (; i < events.length && events[i]!.t <= now; i++) {
      const e = events[i]!;
      if (e.k === 'caps') engine.setLocalCaps(e.caps);
      else if (e.k === 'rssi') engine.onLocalRssi(e.key, e.rssi, e.t);
      else if (e.k === 'adv') engine.onAdvertisement({ deviceId: e.deviceId, rssi: e.rssi, uuids: e.uuids, name: e.name, localName: e.peerName }, e.t);
      else if (e.k === 'heard') engine.onScanHeard(e.t);
      else if (e.k === 'motion') engine.onMotion({ acceleration: e.a, rotation: e.r }, e.t);
      else if (e.k === 'settings' && !fixed) engine.setSettings(e.settings);
    }
    const plan = engine.tick(now);
    if (plan && applied[applied.length - 1]?.count !== plan.count) applied.push({ t: now, count: plan.count });
  }
  const groupChanges = Math.max(0, applied.length - 1);
  let flaps = 0;
  for (let j = 2; j < applied.length; j++)
    if (applied[j]!.count === applied[j - 2]!.count && applied[j]!.t - applied[j - 1]!.t <= FLAP_MS) flaps++;
  const durationMs = end - start;
  return { durationMs, applied, groupChanges, changesPerMinute: durationMs > 0 ? groupChanges / (durationMs / 60000) : 0, flaps, marks: markMetrics(events, applied, end) };
}

function markMetrics(events: TraceEvent[], applied: ReplayMetrics['applied'], end: number): ReplayMetrics['marks'] {
  const marks = events.filter((e): e is Extract<TraceEvent, { k: 'mark' }> => e.k === 'mark');
  if (!marks.length) return undefined;
  const countAt = (t: number) => { let c = 1; for (const a of applied) { if (a.t > t) break; c = a.count; } return c; };
  const entryMs: (number | null)[] = [], exitMs: (number | null)[] = [];
  let falseGroupMs = 0, missedGroupMs = 0;
  marks.forEach((m, j) => {
    const until = marks[j + 1]?.t ?? end;
    const hit = applied.find((a) => a.t >= m.t && a.t <= until && (m.together ? a.count >= 2 : a.count <= 1));
    const already = m.together ? countAt(m.t) >= 2 : countAt(m.t) <= 1;
    (m.together ? entryMs : exitMs).push(already ? 0 : hit ? hit.t - m.t : null);
    // Integrate the wrong state between this mark and the next.
    const points = [m.t, ...applied.filter((a) => a.t > m.t && a.t < until).map((a) => a.t), until];
    for (let k = 0; k + 1 < points.length; k++) {
      const grouped = countAt(points[k]!) >= 2, span = points[k + 1]! - points[k]!;
      if (m.together && !grouped) missedGroupMs += span;
      if (!m.together && grouped) falseGroupMs += span;
    }
  });
  return { entryMs, exitMs, falseGroupMs, missedGroupMs };
}
