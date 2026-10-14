import { capHash16, decodeBeacon, type BeaconInfo } from './beaconCodec';
import { ProximityTracker } from './proximity';
import { tierFor, type ApproachSettings, type TierId } from './tiers';

/** A cap connected to (and controlled by) this phone. Order = left-to-right span order. */
export interface LocalCap { key: string; bleName: string; label: string }

export interface Member { key: string; label: string; local: boolean; sortKey: string; source: 'local' | 'peer' | 'cap' }

export type Assignment =
  | { kind: 'individual'; text: string; fg: string; bg: string; speed: number }
  | { kind: 'span'; text: string; index: number; total: number; fg: string; bg: string; speed: number };

export interface Plan {
  /** Size and tier of the group this phone's near caps belong to. */
  count: number;
  tier: TierId;
  members: Member[];
  /** Content for every local cap; caps that are not near get the solo content. */
  perCap: Map<string, Assignment>;
}

export interface Advertisement { deviceId: string; name?: string; rssi?: number; uuids?: string[] }

const ANIMALS = ['Fox', 'Owl', 'Bee', 'Cat', 'Elk', 'Yak', 'Emu', 'Ant', 'Bat', 'Cod', 'Doe', 'Eel', 'Gnu', 'Hen', 'Jay', 'Koi', 'Ram', 'Ape', 'Pig', 'Rat'];
/** Default cap label; the same formula on every phone gives consistent greetings without exchanging names. */
export function defaultLabel(phoneId: number, capIndex: number): string {
  return ANIMALS[phoneId % ANIMALS.length]! + (capIndex > 0 ? String(capIndex + 1) : '');
}
const hex8 = (n: number) => n.toString(16).padStart(8, '0');

export function joinOthers(labels: string[]): string {
  if (labels.length === 0) return '';
  if (labels.length <= 3) return labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(', ')} & ${labels[labels.length - 1]}`;
  return `${labels.length} friends`;
}

export function fillTemplate(tpl: string, v: { me: string; others: string[]; count: number; index: number }): string {
  return tpl
    .replace(/\{me\}/g, v.me)
    .replace(/\{other\}/g, joinOthers(v.others) || 'friend')
    .replace(/\{count\}/g, String(v.count))
    .replace(/\{index\}/g, String(v.index));
}

/** Pure: content for each local cap given the (ordered) near group. */
export function planFor(members: Member[], localCaps: LocalCap[], s: ApproachSettings): Plan {
  const perCap = new Map<string, Assignment>();
  const count = members.length;
  const tier = tierFor(count);
  const cfg = s.tiers[tier];
  members.forEach((m, i) => {
    if (!m.local) return;
    const others = members.filter((o) => o.key !== m.key).map((o) => o.label);
    if (cfg.mode === 'span') {
      // Identical text on every cap (and phone) so the segments line up into one marquee.
      const text = fillTemplate(cfg.text, { me: members[0]!.label, others: members.map((o) => o.label), count, index: 1 });
      perCap.set(m.key, { kind: 'span', text, index: i, total: count, fg: cfg.fg, bg: cfg.bg, speed: cfg.speed });
    } else {
      perCap.set(m.key, { kind: 'individual', text: fillTemplate(cfg.text, { me: m.label, others, count, index: i + 1 }), fg: cfg.fg, bg: cfg.bg, speed: cfg.speed });
    }
  });
  const solo = s.tiers.solo;
  for (const c of localCaps) {
    if (perCap.has(c.key)) continue;
    const text = fillTemplate(solo.text, { me: c.label, others: [], count: 1, index: 1 });
    perCap.set(c.key, solo.mode === 'span'
      ? { kind: 'span', text, index: 0, total: 1, fg: solo.fg, bg: solo.bg, speed: solo.speed }
      : { kind: 'individual', text, fg: solo.fg, bg: solo.bg, speed: solo.speed });
  }
  return { count: Math.max(1, count), tier: count ? tier : 'solo', members, perCap };
}

/**
 * Fuses three proximity sources into one group:
 *  - local caps: RSSI of caps connected to this phone (hub mode: one phone, many caps)
 *  - peers: beacons of other phones running the app (one phone per wearer)
 *  - nearby caps: advertisements of caps that are not connected to this phone
 * A group change is applied only after it stayed unchanged for `settleMs`.
 */
export class ApproachEngine {
  readonly tracker: ProximityTracker;
  private localCaps: LocalCap[] = [];
  private peers = new Map<string, BeaconInfo>();
  private capNames = new Map<string, string>(); // tracker key -> advertised cap name
  private candidateSig = '';
  private candidateSince = 0;
  private appliedSig = '';

  constructor(readonly phoneId: number, private settings: ApproachSettings, readonly capPrefix = 'iledcolor') {
    this.tracker = new ProximityTracker({ enterDbm: settings.enterDbm, leaveDbm: settings.leaveDbm, staleMs: settings.staleMs, alpha: 0.3 });
  }

  setSettings(s: ApproachSettings) {
    this.settings = s;
    this.tracker.opts = { ...this.tracker.opts, enterDbm: s.enterDbm, leaveDbm: s.leaveDbm, staleMs: s.staleMs };
    this.invalidate();
  }
  setLocalCaps(caps: LocalCap[]) { this.localCaps = caps.slice(); }
  getLocalCaps() { return this.localCaps.slice(); }
  /** Forces the next settled tick to return a plan again (after settings change or a failed upload). */
  invalidate() { this.appliedSig = ''; }

  onLocalRssi(key: string, rssi: number, now: number) { this.tracker.update(key, rssi, now); }

  onAdvertisement(a: Advertisement, now: number) {
    if (a.rssi === undefined) return;
    for (const u of a.uuids ?? []) {
      const b = decodeBeacon(u);
      if (!b || b.phoneId === this.phoneId) continue;
      const key = `peer:${hex8(b.phoneId)}`;
      this.peers.set(key, b);
      this.tracker.update(key, a.rssi, now);
      return;
    }
    const name = a.name ?? '';
    if (!name.toLowerCase().startsWith(this.capPrefix)) return;
    if (this.localCaps.some((c) => c.bleName === name || c.key === a.deviceId)) return;
    const key = `cap:${a.deviceId}`;
    this.capNames.set(key, name);
    this.tracker.update(key, a.rssi, now);
  }

  /** The near group, ordered consistently on every phone (by phone id, then cap index). */
  members(now: number): Member[] {
    this.tracker.expire(now);
    const me = hex8(this.phoneId);
    const out: Member[] = [];
    this.localCaps.forEach((c, i) => {
      if (this.tracker.isNear(c.key, now)) out.push({ key: c.key, label: c.label, local: true, sortKey: `${me}:${String(i).padStart(3, '0')}`, source: 'local' });
    });
    const peerHashes = new Set<number>();
    for (const [key, b] of this.peers) {
      if (!this.tracker.isNear(key, now)) { if (!this.tracker.keys().includes(key)) this.peers.delete(key); continue; }
      b.capHashes.forEach((h) => peerHashes.add(h));
      const id = key.slice(5);
      for (let j = 0; j < b.capCount; j++)
        out.push({ key: `${key}:${j}`, label: defaultLabel(b.phoneId, j), local: false, sortKey: `${id}:${String(j).padStart(3, '0')}`, source: 'peer' });
    }
    if (this.settings.countNearbyCaps) {
      for (const [key, name] of this.capNames) {
        if (!this.tracker.isNear(key, now)) { if (!this.tracker.keys().includes(key)) this.capNames.delete(key); continue; }
        if (peerHashes.has(capHash16(name))) continue; // already counted via its phone's beacon
        out.push({ key, label: name.slice(this.capPrefix.length).replace(/^[-_ ]/, '') || name, local: false, sortKey: `~${name}`, source: 'cap' });
      }
    }
    // A lone local cap with nobody else around is just "solo".
    return out.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  }

  /** Returns a plan only when a changed group has settled; otherwise null. */
  tick(now: number): Plan | null {
    const members = this.members(now);
    const plan = planFor(members, this.localCaps, this.settings);
    const sig = JSON.stringify([members.map((m) => m.key), [...plan.perCap]]);
    if (sig !== this.candidateSig) { this.candidateSig = sig; this.candidateSince = now; }
    if (now - this.candidateSince < this.settings.settleMs || sig === this.appliedSig) return null;
    this.appliedSig = sig;
    return plan;
  }

  /** Beacon describing this phone's caps for other phones. */
  beacon(): BeaconInfo {
    return { phoneId: this.phoneId, capCount: this.localCaps.length, capHashes: this.localCaps.slice(0, 2).map((c) => capHash16(c.bleName)) };
  }
}
