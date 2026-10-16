import { capHash16, decodeBeacon, decodeBeaconName, maskHas, nearMaskFor, type BeaconInfo } from './beaconCodec';
import { ProximityTracker } from './proximity';
import { MotionTracker, type MotionSample } from './motion';
import { tierFor, type ApproachSettings, type TierId, type TierConfig } from './tiers';
import { chooseGroupText, CONTENT_REFRESH_MS, CONTENT_STALE_MS, type TextChoice } from './sharedContent';
import type { TraceEvent } from './trace';

/** A cap connected to (and controlled by) this phone. Order = left-to-right span order. */
export interface LocalCap { key: string; bleName: string; label: string }

export interface Member { key: string; label: string; local: boolean; sortKey: string; source: 'local' | 'peer' | 'cap'; phoneId?: number; indirect?: boolean }

/** The mutual (beacon-mask) rules only use beacons heard this recently. */
export const MUTUAL_FRESH_MS = 4000;
/** The mutual rule also needs our own reception within this many dB of the away threshold. */
export const MUTUAL_MARGIN_DB = 10;

export type Assignment =
  | { kind: 'create' }
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

/**
 * `name` may come from the OS device cache (e.g. a phone's Bluetooth name) and is only used for caps;
 * `localName`/`manufacturerData` are taken from the advertisement itself and carry a peer's user name.
 */
export interface Advertisement {
  deviceId: string; name?: string; rssi?: number; uuids?: string[];
  localName?: string; manufacturerData?: Record<string, DataView>;
}

const ANIMALS = ['Fox', 'Owl', 'Bee', 'Cat', 'Elk', 'Yak', 'Emu', 'Ant', 'Bat', 'Cod', 'Doe', 'Eel', 'Gnu', 'Hen', 'Jay', 'Koi', 'Ram', 'Ape', 'Pig', 'Rat'];
/** Default cap label; the same formula on every phone gives consistent greetings without exchanging names. */
export function defaultLabel(phoneId: number, capIndex: number): string {
  return ANIMALS[phoneId % ANIMALS.length]! + (capIndex > 0 ? String(capIndex + 1) : '');
}

/** Label of a phone's n-th cap: the user name when one is set ("Anna", "Anna2", …), else the animal default. */
export function capLabel(phoneId: number, capIndex: number, userName?: string): string {
  const n = userName?.trim();
  return n ? n + (capIndex > 0 ? String(capIndex + 1) : '') : defaultLabel(phoneId, capIndex);
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
export function planFor(members: Member[], localCaps: LocalCap[], s: ApproachSettings, shared?: TierConfig): Plan {
  const perCap = new Map<string, Assignment>();
  const count = members.length;
  const tier = tierFor(count);
  const own = s.tiers[tier];
  const cfg = own.mode === 'span' && tier !== 'solo' ? shared ?? own : own;
  members.forEach((m, i) => {
    if (!m.local) return;
    if (tier === 'solo' && cfg.useCreate) {
      perCap.set(m.key, { kind: 'create' });
      return;
    }
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
    if (solo.useCreate) {
      perCap.set(c.key, { kind: 'create' });
      continue;
    }
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
  readonly motion = new MotionTracker();
  private localCaps: LocalCap[] = [];
  private peers = new Map<string, BeaconInfo>();
  private peerNames = new Map<string, string>(); // kept across reports: not every report includes the scan response
  private peerDevices = new Map<number, string>();
  private peerContent = new Map<number, { tier: TierId; config: TierConfig; at: number }>();
  private contentErrors = new Map<number, string>();
  private capNames = new Map<string, string>(); // tracker key -> advertised cap name
  private candidateSig = '';
  private candidateSince = 0;
  private appliedSig = '';

  /** Receives every engine input while a walk is being recorded (see trace.ts). */
  recorder?: { push(e: TraceEvent): void };
  /** Called with every raw RSSI report that is tracked (used by calibration). */
  onSample?: (key: string, rssi: number, now: number) => void;
  /** Latest input time, so caps/settings changes are recorded on the same clock as the RSSI reports. */
  private clock?: number;
  private at(now: number) { if (this.clock === undefined || now > this.clock) this.clock = now; return now; }

  constructor(readonly phoneId: number, private settings: ApproachSettings, readonly capPrefix = 'iledcolor') {
    this.tracker = new ProximityTracker({ enterDbm: settings.enterDbm, leaveDbm: settings.leaveDbm, staleMs: settings.staleMs, alpha: 0.3, confirmMs: settings.confirmMs });
  }

  setSettings(s: ApproachSettings) {
    this.settings = s;
    this.tracker.opts = { ...this.tracker.opts, enterDbm: s.enterDbm, leaveDbm: s.leaveDbm, staleMs: s.staleMs, confirmMs: s.confirmMs };
    this.recorder?.push({ t: this.clock ?? Date.now(), k: 'settings', settings: structuredClone(s) });
    this.invalidate();
  }
  setLocalCaps(caps: LocalCap[]) {
    this.localCaps = caps.slice();
    this.recorder?.push({ t: this.clock ?? Date.now(), k: 'caps', caps: caps.map((c) => ({ key: c.key, bleName: c.bleName, label: c.label })) });
  }
  getLocalCaps() { return this.localCaps.slice(); }
  /** Forces the next settled tick to return a plan again (after settings change or a failed upload). */
  invalidate() { this.appliedSig = ''; }

  onMotion(sample: MotionSample, now: number) {
    this.at(now);
    this.motion.update(sample, now);
    this.recorder?.push({ t: now, k: 'motion', a: sample.acceleration, r: sample.rotation });
  }
  onLocalRssi(key: string, rssi: number, now: number) {
    this.at(now);
    this.recorder?.push({ t: now, k: 'rssi', key, rssi });
    this.feed(key, rssi, now, 'local');
  }
  /** The scanner received something (tracked or not): it works, so silence of a participant means something. */
  onScanHeard(now: number) {
    this.at(now);
    this.tracker.heard('scan', now);
    this.recorder?.push({ t: now, k: 'heard' });
  }

  private feed(key: string, rssi: number, now: number, group: string) {
    this.tracker.update(key, rssi, now, this.motion.state(now), group);
    this.onSample?.(key, rssi, now);
  }

  onAdvertisement(a: Advertisement, now: number) {
    if (a.rssi === undefined) return;
    this.at(now);
    this.tracker.heard('scan', now);
    for (const u of a.uuids ?? []) {
      const b = decodeBeacon(u);
      if (!b || b.phoneId === this.phoneId) continue;
      const key = `peer:${hex8(b.phoneId)}`;
      this.peers.set(key, b);
      this.peerDevices.set(b.phoneId, a.deviceId);
      const name = decodeBeaconName(a.manufacturerData, a.localName);
      if (name) this.peerNames.set(key, name);
      this.recorder?.push({ t: now, k: 'adv', deviceId: a.deviceId, rssi: a.rssi, uuids: [u], ...(name ? { peerName: name } : {}) });
      this.feed(key, a.rssi, now, 'scan');
      return;
    }
    const name = a.name ?? '';
    if (!name.toLowerCase().startsWith(this.capPrefix)) { this.recorder?.push({ t: now, k: 'heard' }); return; }
    this.recorder?.push({ t: now, k: 'adv', deviceId: a.deviceId, rssi: a.rssi, name });
    if (this.localCaps.some((c) => c.bleName === name || c.key === a.deviceId)) return;
    const key = `cap:${a.deviceId}`;
    this.capNames.set(key, name);
    this.feed(key, a.rssi, now, 'scan');
  }

  /**
   * The near group, ordered consistently on every phone (by phone id, then cap index).
   * Directly near participants form the group. When the resulting tier runs a marquee across the caps,
   * phones that are near a group member (by both phones' beacons) are included too, so every phone of a
   * chain computes the same marquee group; greetings stay with direct neighbours.
   */
  members(now: number): Member[] {
    this.tracker.expire(now);
    const me = hex8(this.phoneId);
    const out: Member[] = [];
    this.localCaps.forEach((c, i) => {
      if (this.tracker.isNear(c.key, now)) out.push({ key: c.key, label: c.label, local: true, sortKey: `${me}:${String(i).padStart(3, '0')}`, source: 'local' });
    });
    const peerHashes = new Set<number>();
    const direct: [string, BeaconInfo][] = [];
    const others: [string, BeaconInfo][] = [];
    for (const [key, b] of this.peers) {
      if (!this.peerNear(key, b, now)) {
        if (!this.tracker.keys().includes(key)) {
          this.peers.delete(key);
          this.peerNames.delete(key);
          this.peerDevices.delete(b.phoneId);
          this.peerContent.delete(b.phoneId);
          this.contentErrors.delete(b.phoneId);
        } else others.push([key, b]);
        continue;
      }
      direct.push([key, b]);
    }
    const addPeer = (key: string, b: BeaconInfo, indirect: boolean) => {
      b.capHashes.forEach((h) => peerHashes.add(h));
      const id = key.slice(5);
      for (let j = 0; j < b.capCount; j++)
        out.push({ key: `${key}:${j}`, label: capLabel(b.phoneId, j, this.peerNames.get(key)), local: false, sortKey: `${id}:${String(j).padStart(3, '0')}`, source: 'peer', phoneId: b.phoneId, ...(indirect ? { indirect: true } : {}) });
    };
    for (const [key, b] of direct) addPeer(key, b, false);
    if (this.settings.countNearbyCaps) {
      for (const [key, name] of this.capNames) {
        if (!this.tracker.isNear(key, now)) { if (!this.tracker.keys().includes(key)) this.capNames.delete(key); continue; }
        if (peerHashes.has(capHash16(name))) continue; // already counted via its phone's beacon
        out.push({ key, label: name.slice(this.capPrefix.length).replace(/^[-_ ]/, '') || name, local: false, sortKey: `~${name}`, source: 'cap' });
      }
    }
    const chain = this.chainPeers(direct, others, now);
    if (chain.length && out.some((m) => m.local)) {
      const hashes = new Set(chain.flatMap(([, b]) => b.capHashes));
      const dupes = out.filter((m) => m.source === 'cap' && hashes.has(capHash16(this.capNames.get(m.key) ?? '')));
      const extended = out.length - dupes.length + chain.reduce((n, [, b]) => n + b.capCount, 0);
      if (extended > out.length && this.settings.tiers[tierFor(extended)].mode === 'span') {
        for (const d of dupes) out.splice(out.indexOf(d), 1);
        for (const [key, b] of chain) addPeer(key, b, true);
      }
    }
    // A lone local cap with nobody else around is just "solo".
    return out.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  }

  /**
   * Phones that are not near this phone but near a group member: both beacons, heard recently,
   * must list each other. Requiring both directions keeps Bloom-filter false matches rare.
   */
  private chainPeers(direct: [string, BeaconInfo][], others: [string, BeaconInfo][], now: number): [string, BeaconInfo][] {
    const fresh = ([key]: [string, BeaconInfo]) => this.tracker.isFresh(key, now, MUTUAL_FRESH_MS);
    const group = direct.filter(fresh);
    const chain: [string, BeaconInfo][] = [];
    for (let grew = true; grew;) {
      grew = false;
      for (const o of others) {
        if (chain.includes(o) || !fresh(o)) continue;
        if (group.some(([, q]) => maskHas(q.nearMask, o[1].phoneId) && maskHas(o[1].nearMask, q.phoneId))) {
          chain.push(o); group.push(o); grew = true;
        }
      }
    }
    return chain;
  }

  /** Returns a plan only when a changed group has settled; otherwise null. */
  tick(now: number): Plan | null {
    const members = this.members(now);
    const plan = planFor(members, this.localCaps, this.settings, this.groupTexts(now).winner?.config);
    const sig = JSON.stringify([members.map((m) => m.key), [...plan.perCap]]);
    if (sig !== this.candidateSig) { this.candidateSig = sig; this.candidateSince = now; }
    if (now - this.candidateSince < this.settings.settleMs || sig === this.appliedSig) return null;
    this.appliedSig = sig;
    return plan;
  }

  contentPeers(now: number): { phoneId: number; deviceId: string }[] {
    const ids = new Set(this.members(now).filter((m) => m.source === 'peer').map((m) => m.phoneId!));
    return [...this.peers.values()].filter((b) => b.capCount > 0 && ids.has(b.phoneId) && this.peerDevices.has(b.phoneId))
      .map((b) => ({ phoneId: b.phoneId, deviceId: this.peerDevices.get(b.phoneId)! }));
  }

  receiveContent(phoneId: number, tier: TierId, config: TierConfig, now: number) {
    this.peerContent.set(phoneId, { tier, config: { ...config }, at: now });
    this.contentErrors.delete(phoneId);
  }

  contentFailed(phoneId: number, message: string) {
    this.peerContent.delete(phoneId);
    this.contentErrors.set(phoneId, message);
  }

  clearContent() {
    this.peerContent.clear();
    this.contentErrors.clear();
  }

  groupTexts(now: number): TextChoice {
    const members = this.members(now);
    const tier = tierFor(members.length);
    const maxAge = Math.max(CONTENT_STALE_MS, this.contentPeers(now).length * CONTENT_REFRESH_MS);
    return chooseGroupText(members.map((m) => {
      if (m.local) return { ...m, config: this.settings.tiers[tier] };
      const cached = m.phoneId === undefined ? undefined : this.peerContent.get(m.phoneId);
      const config = cached?.tier === tier && now - cached.at < maxAge ? cached.config : undefined;
      return { ...m, config, unavailable: config ? undefined : m.source === 'cap'
        ? 'Text unavailable: no controlling phone'
        : this.contentErrors.get(m.phoneId!) ?? 'Loading text from phone…' };
    }));
  }

  /** Other phones running the app that can receive a shared preset (heard recently, near or not). */
  sharePeers(now: number): { phoneId: number; deviceId: string; label: string; rssi: number; near: boolean }[] {
    this.tracker.expire(now);
    const out = [];
    for (const [key, b] of this.peers) {
      const rssi = this.tracker.rssi(key);
      const deviceId = this.peerDevices.get(b.phoneId);
      if (rssi === undefined || !deviceId) continue;
      out.push({ phoneId: b.phoneId, deviceId, label: capLabel(b.phoneId, 0, this.peerNames.get(key)), rssi: Math.round(rssi), near: this.peerNear(key, b, now) });
    }
    return out.sort((a, b) => b.rssi - a.rssi);
  }

  /** Other phones currently heard (near or not), with smoothed RSSI, for display and threshold tuning. */
  heardPhones(now: number): { id: string; label: string; capCount: number; rssi: number; near: boolean; mutual: boolean }[] {
    this.tracker.expire(now);
    const out = [];
    for (const [key, b] of this.peers) {
      const rssi = this.tracker.rssi(key);
      if (rssi === undefined) continue;
      out.push({ id: key.slice(5), label: capLabel(b.phoneId, 0, this.peerNames.get(key)), capCount: b.capCount, rssi: Math.round(rssi), near: this.peerNear(key, b, now), mutual: !this.tracker.isNear(key, now) && this.peerNear(key, b, now) });
    }
    return out.sort((a, b) => b.rssi - a.rssi);
  }

  /**
   * A peer is near when our own reception says so, or when its beacon lists us as near and we hear it
   * plausibly: recently (MUTUAL_FRESH_MS) and not much weaker than the away threshold. The second rule
   * keeps both phones in sync when one receives the other more weakly (different antennas, body
   * shadowing, a throttled scan); the plausibility checks stop stale beacons and Bloom-filter false
   * matches of the 16-bit near mask from pulling in phones that are far away.
   */
  private peerNear(key: string, b: BeaconInfo, now: number): boolean {
    if (this.tracker.isNear(key, now)) return true;
    const rssi = this.tracker.rssi(key);
    return this.tracker.isFresh(key, now, MUTUAL_FRESH_MS) && rssi !== undefined
      && rssi >= Math.min(this.settings.leaveDbm, this.settings.enterDbm) - MUTUAL_MARGIN_DB && maskHas(b.nearMask, this.phoneId);
  }

  /** Everything currently heard with its smoothed RSSI, strongest first (calibration source picker). */
  sources(now: number): { key: string; label: string; rssi: number; kind: 'local' | 'peer' | 'cap' }[] {
    this.tracker.expire(now);
    const out: { key: string; label: string; rssi: number; kind: 'local' | 'peer' | 'cap' }[] = [];
    for (const c of this.localCaps) { const r = this.tracker.rssi(c.key); if (r !== undefined) out.push({ key: c.key, label: c.label, rssi: r, kind: 'local' }); }
    for (const [key, b] of this.peers) { const r = this.tracker.rssi(key); if (r !== undefined) out.push({ key, label: capLabel(b.phoneId, 0, this.peerNames.get(key)), rssi: r, kind: 'peer' }); }
    for (const [key, name] of this.capNames) { const r = this.tracker.rssi(key); if (r !== undefined) out.push({ key, label: name, rssi: r, kind: 'cap' }); }
    return out.sort((a, b) => b.rssi - a.rssi);
  }

  /** Beacon describing this phone's caps, plus the peers it sees near by its own reception. */
  beacon(now = Date.now()): BeaconInfo {
    const near: number[] = [];
    for (const [key, b] of this.peers) if (this.tracker.isNear(key, now)) near.push(b.phoneId);
    return { phoneId: this.phoneId, capCount: this.localCaps.length, capHashes: this.localCaps.slice(0, 2).map((c) => capHash16(c.bleName)), nearMask: nearMaskFor(near) };
  }
}
