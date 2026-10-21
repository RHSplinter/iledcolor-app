import { DeviceController, DeviceError } from '../controller/deviceController';
import type { RgbImage } from '../protocol/framing';
import { encodeGif, gifNonce } from '../render/gif';
import { drawPreview, parseHexColor } from '../render/matrix';
import { ensureFont, getTextFont, renderSpanMarquee } from '../render/text';
import { gifDelayMs, msUntilLoopStart } from '../render/span';
import { loadKv, savePreset, saveKv } from '../storage/db';
import type { Content, GroupContent } from '../storage/presets';
import { MockTransport } from '../transport/mock';
import type { Transport, TransportProfile } from '../transport/types';
import { ApproachBeacon } from './beacon';
import { MotionSupport } from './motionSupport';
import { peerBusy, readPeerContent } from './contentExchange';
import { CONTENT_REFRESH_MS, contentSnapshot, encodeTierContent } from './sharedContent';
import { encodeBeacon, fitBeaconName } from './beaconCodec';
import { dbmForMeters, formatMeters } from './distance';
import { ApproachEngine, capLabel, defaultLabel, planFor, type Advertisement, type Assignment, type LocalCap, type Member, type Plan } from './engine';
import { calibrate, CALIBRATION_MIN_SAMPLES } from './calibration';
import { median } from './proximity';
import { parseTrace, replayTrace, TraceRecorder, type ReplayMetrics, type Trace } from './trace';
import { DEFAULT_APPROACH, TEMPLATE_HELP, TIER_IDS, TIER_LABELS, tierFor, validateApproach, type ApproachSettings, type TierId } from './tiers';

/** What the approach tab needs from the rest of the app. */
export interface ApproachContext {
  native: boolean;
  mock: boolean;
  profile(): TransportProfile;
  logicalDims(): [number, number];
  physical(img: RgbImage): RgbImage;
  renderContent(c: Content): Promise<{ image: RgbImage; frames?: RgbImage[]; delays?: number[] }>;
  createContent(): Content;
  marqueeDelay(speed: number): number;
  trace(dir: 'tx' | 'rx' | 'ev', label: string, data?: Uint8Array): void;
  chooseCap(): Promise<{ deviceId: string; name: string }>;
  connectCap(deviceId: string): Promise<Transport>;
  readRssi(deviceId: string): Promise<number>;
  startScan(cb: (a: Advertisement) => void): Promise<void>;
  stopScan(): Promise<void>;
  /** The first cap is also the Connect tab's cap; called whenever it (or its controller) changes. */
  onPrimaryChange(p: PrimaryCap | null): void;
}

export interface PrimaryCap { deviceId: string; name: string; controller: DeviceController }

interface CapEntry extends LocalCap {
  deviceId: string;
  /** Set when the user renamed this cap; otherwise the label follows the user name / position. */
  customLabel?: string;
  controller: DeviceController;
  rssi?: number;
  note: string;
  lastSig?: string;
  lastReconnect: number;
  mock?: MockTransport;
  mockRssi: number;
  /** Disconnected by the user: no automatic reconnect until connected again. */
  manualOff?: boolean;
  preview?: { frames: RgbImage[]; delays: number[] };
}
interface SimPeer { id: number; caps: number; rssi: number; tiers: ApproachSettings['tiers'] }
interface SavedCap { deviceId: string; bleName: string; label: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let ctx: ApproachContext;
let settings: ApproachSettings = DEFAULT_APPROACH;
let engine: ApproachEngine;
let phoneId = 0;
let userName = '';
let caps: CapEntry[] = [];
let simPeers: SimPeer[] = [];
let running = false;
let switching = false;
let loopTimer: ReturnType<typeof setInterval> | undefined;
let applying: Promise<void> | null = null;
let pendingPlan: Plan | null = null;
let lastPlan: Plan | null = null;
const greetingDeferred = new Set<DeviceController>();
let beaconNote = '';
let scanNote = '';
let motionNote = '';
let motionSupport: MotionSupport | undefined;
/** What is on air (uuid|name) and when it was (re)started; the loop re-advertises on change and periodically. */
let advertisedSig = '';
let lastAdvertise = 0;
let beaconBusy = false;
let lastScanStart = 0;
let lastHeard = 0;
let scanBusy = false;
let contentEpoch = 0;
let contentRead: Promise<void> | undefined;
const contentAttempts = new Map<number, { tier: TierId; at: number; failed: boolean }>();
/** Some phones (e.g. Xiaomi: 5 min) silently downgrade long unfiltered scans; restart well before that. */
const SCAN_RESTART_MS = 4 * 60_000;
/** Restart the scan when nothing at all was received for this long. */
const SCAN_SILENT_MS = 15_000;
/** Re-advertise periodically: some stacks stop an advertiser without telling the app. */
const BEACON_REFRESH_MS = 10_000;
const nearby = new Map<string, { name: string; rssi: number; seen: number }>();
const log: string[] = [];
let previewTimers: Array<ReturnType<typeof setTimeout>> = [];
/** Calibration: raw RSSI of one source, measured together and at the "away" distance. */
const CALIBRATION_MS = 5000;
let calKey = '';
let calSamples: { together: number[]; away: number[] } = { together: [], away: [] };
let calStep: { step: 'together' | 'away'; until: number } | undefined;
let calMsg = '';
/** Trace recording (engine inputs + ground-truth marks) and replay. */
let recorder: TraceRecorder | undefined;
let trace: Trace | undefined;
let traceMsg = '';

function note(msg: string) {
  log.push(`${new Date().toLocaleTimeString()} ${msg}`);
  if (log.length > 120) log.splice(0, log.length - 120);
  const el = document.getElementById('ap-log');
  if (el) { el.textContent = log.join('\n'); el.scrollTop = el.scrollHeight; }
  ctx?.trace('ev', `approach: ${msg}`);
}

export async function initApproach(c: ApproachContext): Promise<void> {
  ctx = c;
  try {
    settings = validateApproach(await loadKv('approach'));
    const id = await loadKv('phoneId');
    phoneId = typeof id === 'number' && Number.isInteger(id) ? id : 0;
    const n = await loadKv('userName');
    userName = typeof n === 'string' ? fitBeaconName(n) : '';
  } catch { settings = DEFAULT_APPROACH; }
  if (!phoneId) {
    phoneId = (crypto.getRandomValues(new Uint32Array(1))[0]! || 1) >>> 0;
    void saveKv('phoneId', phoneId).catch(() => undefined);
  }
  engine = new ApproachEngine(phoneId, settings);
  engine.onSample = (key, rssi, now) => {
    if (!calStep || key !== calKey) return;
    if (now <= calStep.until) calSamples[calStep.step].push(rssi);
  };
  if (ctx.native && !ctx.mock) {
    motionSupport = new MotionSupport(ApproachBeacon,
      (sample) => { if (running) engine.onMotion(sample, Date.now()); },
      (message) => {
        engine.motion.reset();
        motionNote = `Motion support unavailable: ${message}. Using RSSI only.`;
        note(motionNote);
        renderStatusSoon();
      });
  }
  // The switch is remembered: resume approach mode (with the saved caps) after an app restart.
  if ((ctx.native || ctx.mock) && (await loadKv('approachEnabled').catch(() => false)) === true) {
    note('approach mode was on; resuming');
    void (async () => { if (!ctx.mock) await onConnectSaved(); await start(); })();
  }
}

/** The approach switch: starts/stops scanning, beacon and uploads and remembers the choice. */
async function setEnabled(on: boolean) {
  if (switching) return;
  switching = true;
  renderApproach();
  try {
    await saveKv('approachEnabled', on);
    if (on) await start(); else await stop();
  } catch (e) {
    note(`could not ${on ? 'enable' : 'disable'} approach mode: ${(e as Error).message}`);
  } finally {
    switching = false;
    renderApproach();
  }
}

const persist = () => saveKv('approach', settings).catch((e) => note(`could not save settings: ${(e as Error).message}`));
const persistCaps = () => saveKv('approachCaps', caps.filter((c) => !c.mock).map<SavedCap>((c) => ({ deviceId: c.deviceId, bleName: c.bleName, label: c.customLabel ?? '' }))).catch(() => undefined);

/** True for generated labels ("Bee", "Bee2", "Anna2"), which older versions also saved as cap labels. */
function isAutoLabel(l: string): boolean {
  for (let k = 0; k < 32; k++) if (l === defaultLabel(phoneId, k) || l === capLabel(phoneId, k, userName)) return true;
  return false;
}

function syncEngineCaps() {
  caps.forEach((c, i) => (c.label = c.customLabel || capLabel(phoneId, i, userName)));
  engine.setLocalCaps(caps.map((c) => ({ key: c.key, bleName: c.bleName, label: c.label })));
  engine.invalidate();
  if (running) void startBeacon();
  notifyPrimary();
}

let primaryCtl: DeviceController | null = null;
function notifyPrimary() {
  const c = caps[0];
  const ctl = c?.controller ?? null;
  if (ctl === primaryCtl) return;
  primaryCtl = ctl;
  ctx.onPrimaryChange(c ? { deviceId: c.deviceId, name: c.bleName, controller: c.controller } : null);
}

// ---------- cap management ------------------------------------------------------

function makeController(): DeviceController {
  const ctl = new DeviceController({ profile: ctx.profile(), onTrace: ctx.trace });
  let temporary = false;
  ctl.subscribe(() => {
    if (temporary && !ctl.temporaryActive) {
      engine.invalidate();
      if (running) {
        const cap = caps.find((c) => c.controller === ctl);
        if (cap) cap.lastSig = undefined;
      }
      if (greetingDeferred.delete(ctl) && !running && lastPlan) {
        const key = caps.find((c) => c.controller === ctl)?.key;
        if (key) schedule({ ...lastPlan, perCap: new Map([...lastPlan.perCap].filter(([k]) => k === key)) });
      }
    }
    temporary = ctl.temporaryActive;
    renderCapsSoon();
  });
  return ctl;
}

async function addCap(deviceId: string, bleName: string, label?: string, front = false) {
  if (caps.some((c) => c.deviceId === deviceId)) { note(`${bleName} is already in the list`); return; }
  const entry: CapEntry = {
    key: deviceId, deviceId, bleName, label: '', customLabel: label && !isAutoLabel(label) ? label : undefined,
    controller: makeController(), note: '', lastReconnect: Date.now(), mockRssi: -55,
  };
  if (front) caps.unshift(entry); else caps.push(entry);
  syncEngineCaps();
  persistCaps();
  renderCaps(); renderStatus();
  await connectEntry(entry);
}

/** Connect tab: the chosen cap becomes cap 1 here (added in front, or moved there) and is connected. */
export async function connectAsPrimary(deviceId: string, bleName: string): Promise<void> {
  if (settings.mode === 'p2p') for (const o of caps.filter((x) => x.deviceId !== deviceId)) removeCap(o.key);
  const c = caps.find((x) => x.deviceId === deviceId);
  if (!c) { await addCap(deviceId, bleName, undefined, true); return; }
  if (caps[0] !== c) {
    caps = [c, ...caps.filter((x) => x !== c)];
    syncEngineCaps();
    persistCaps();
    renderCaps(); renderStatus();
  }
  await connectEntry(c);
}

/** Connect tab "Disconnect": disconnects cap 1 and keeps it disconnected (no auto-reconnect). */
export function disconnectPrimary(): void {
  const c = caps[0];
  if (!c) return;
  c.manualOff = true;
  c.controller.disconnect();
  note(`${c.label}: disconnected`);
  renderCaps(); renderStatus();
}

async function connectEntry(c: CapEntry) {
  if (c.controller.state !== 'Disconnected' && c.controller.state !== 'Error') return;
  c.manualOff = false;
  c.controller = makeController();
  notifyPrimary();
  c.lastReconnect = Date.now();
  c.lastSig = undefined;
  await c.controller.connect(async () => {
    if (ctx.mock || c.deviceId.startsWith('mock-')) { c.mock = new MockTransport(); return c.mock; }
    return ctx.connectCap(c.deviceId);
  });
  c.note = c.controller.state === 'Ready' ? '' : c.controller.error ?? '';
  note(`${c.label}: ${c.controller.state}${c.note ? ` (${c.note})` : ''}`);
  if (c.controller.state === 'Ready') engine.invalidate();
  renderCaps(); renderStatus();
}

function removeCap(key: string) {
  const c = caps.find((x) => x.key === key);
  if (!c) return;
  c.controller.disconnect();
  caps = caps.filter((x) => x.key !== key);
  engine.tracker.forget(key);
  syncEngineCaps();
  persistCaps();
  renderCaps(); renderStatus();
}

function moveCap(key: string, dir: -1 | 1) {
  const i = caps.findIndex((c) => c.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= caps.length) return;
  [caps[i], caps[j]] = [caps[j]!, caps[i]!];
  syncEngineCaps();
  persistCaps();
  renderCaps(); renderStatus();
}

async function onAddCap() {
  if (ctx.mock) {
    const n = caps.length + 1;
    await addCap(`mock-${Date.now().toString(36)}`, `iledcolor-MOCK${n}`);
    return;
  }
  try {
    const d = await ctx.chooseCap();
    await addCap(d.deviceId, d.name);
  } catch (e) {
    if ((e as Error).name !== 'SelectionCancelledError') note(`add failed: ${(e as Error).message}`);
  }
}

async function onConnectSaved() {
  const saved = (await loadKv('approachCaps').catch(() => undefined)) as SavedCap[] | undefined;
  if (!Array.isArray(saved) || !saved.length) { note('no saved caps yet'); return; }
  for (const s of saved) {
    if (typeof s?.deviceId !== 'string' || typeof s.bleName !== 'string') continue;
    await addCap(s.deviceId, s.bleName, typeof s.label === 'string' ? s.label : undefined);
    if (settings.mode === 'p2p') break;
  }
}

// ---------- detection loop --------------------------------------------------------

const beaconName = () => fitBeaconName(caps[0]?.customLabel || userName);
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const beaconSig = (now: number) => `${encodeBeacon(engine.beacon(now))}|${beaconName()}|${base64(contentSnapshot(phoneId, settings.tiers)[0]!)}`;

async function startBeacon() {
  if (!ctx.native) { beaconNote = settings.beacon ? 'Beacon needs the mobile app.' : ''; return; }
  if (beaconBusy) { advertisedSig = ''; return; } // the loop re-advertises once the running call is done
  beaconBusy = true;
  try {
    if (!settings.beacon) { await ApproachBeacon.stop(); advertisedSig = ''; beaconNote = 'Beacon off.'; return; }
    const name = beaconName();
    const uuid = encodeBeacon(engine.beacon());
    const values = contentSnapshot(phoneId, settings.tiers).map(base64);
    await ApproachBeacon.publishContent({ values });
    if (!running) { await ApproachBeacon.stop(); return; }
    await ApproachBeacon.start({ uuid, name: name || undefined });
    if (!running) { await ApproachBeacon.stop(); return; } // approach mode was switched off meanwhile
    advertisedSig = `${uuid}|${name}|${values[0]}`;
    lastAdvertise = Date.now();
    beaconNote = `Beacon on${name ? ` as "${name}"` : ''} (phone ${phoneId.toString(16).padStart(8, '0')}, ${caps.length} cap${caps.length === 1 ? '' : 's'}).`;
  } catch (e) {
    advertisedSig = '';
    lastAdvertise = Date.now(); // retry after the refresh interval, not every tick
    beaconNote = `Beacon failed: ${(e as Error).message}`;
  } finally { beaconBusy = false; }
  renderStatusSoon();
}

async function startScanning() {
  lastScanStart = Date.now();
  lastHeard = lastScanStart;
  await ctx.startScan((a) => {
    const now = Date.now();
    lastHeard = now;
    engine.onAdvertisement(a, now);
    if (a.name?.toLowerCase().startsWith('iledcolor') && a.rssi !== undefined) nearby.set(a.deviceId, { name: a.name, rssi: a.rssi, seen: now });
  });
}

/** Keeps scan and beacon alive on phones that silently stop or throttle them. */
async function keepRadiosAlive(now: number) {
  if (!ctx.native || scanBusy) return;
  if (settings.beacon && !beaconBusy && (advertisedSig !== beaconSig(now) || now - lastAdvertise > BEACON_REFRESH_MS)) void startBeacon();
  const silent = now - lastHeard > SCAN_SILENT_MS;
  if (now - lastScanStart < (silent ? SCAN_SILENT_MS : SCAN_RESTART_MS)) return;
  scanBusy = true;
  try {
    if (silent) note('nothing heard for a while; restarting scan');
    await ctx.stopScan();
    if (!running) return;
    await startScanning();
    if (!running) { await ctx.stopScan(); return; }
    scanNote = 'Scanning.';
  } catch (e) { scanNote = `Scan failed: ${(e as Error).message}`; } finally { scanBusy = false; }
}

async function start() {
  if (running) return;
  running = true;
  contentEpoch++;
  contentAttempts.clear();
  engine.clearContent();
  engine.invalidate();
  caps.forEach((c) => (c.lastSig = undefined));
  note('approach mode started');
  motionNote = '';
  engine.motion.reset();
  await motionSupport?.start();
  if (!running) return;
  try {
    await startScanning();
    scanNote = 'Scanning.';
  } catch (e) { scanNote = `Scan failed: ${(e as Error).message}`; note(scanNote); }
  if (ctx.native) void ApproachBeacon.setKeepAwake({ on: true }).catch(() => undefined);
  await startBeacon();
  loopTimer = setInterval(() => void loop(), 1000);
  renderApproach();
}

async function stop() {
  if (!running) return;
  running = false;
  contentEpoch++;
  clearInterval(loopTimer);
  pendingPlan = null;
  await motionSupport?.stop();
  engine.motion.reset();
  await ctx.stopScan();
  await contentRead;
  engine.clearContent();
  if (ctx.native) {
    await ApproachBeacon.stop().catch(() => undefined);
    void ApproachBeacon.setKeepAwake({ on: false }).catch(() => undefined);
  }
  beaconNote = ''; scanNote = ''; advertisedSig = '';
  // Finish any in-flight group upload before restoring solo content, so it cannot overwrite the reset.
  await applying;
  schedule(planFor([], engine.getLocalCaps(), settings));
  await applying;
  note('approach mode stopped');
  renderApproach();
}

async function loop() {
  if (!running) return;
  const now = Date.now();
  await Promise.all(caps.map(async (c) => {
    const st = c.controller.state;
    if (st === 'Ready') {
      try {
        const r = c.mock || c.deviceId.startsWith('mock-') ? c.mockRssi : await ctx.readRssi(c.deviceId);
        c.rssi = r;
        engine.onLocalRssi(c.key, r, now);
      } catch { /* RSSI read can fail during an upload; the next tick retries */ }
    } else if ((st === 'Disconnected' || st === 'Error') && !c.manualOff && now - c.lastReconnect > 8000) {
      note(`${c.label}: reconnecting…`);
      void connectEntry(c);
    }
  }));
  if (!running) return;
  for (const p of simPeers) {
    engine.onAdvertisement({ deviceId: `sim-${p.id}`, rssi: p.rssi + (Math.random() * 4 - 2), uuids: [encodeBeacon({ phoneId: p.id, capCount: p.caps, capHashes: [] })] }, now);
  }
  const tier = tierFor(engine.members(now).length);
  for (const p of simPeers) engine.receiveContent(p.id, tier, p.tiers[tier], now);
  refreshPeerContent(now, tier);
  for (const [id, n] of nearby) if (now - n.seen > 10000) nearby.delete(id);
  const plan = engine.tick(now);
  if (plan) schedule(plan);
  void keepRadiosAlive(now);
  renderStatusSoon();
}

/** One short-lived phone connection at a time, separate from the persistent cap connections. */
function refreshPeerContent(now: number, tier: TierId) {
  if (!ctx.native || ctx.mock || contentRead) return;
  const peers = engine.contentPeers(now);
  for (const id of contentAttempts.keys()) if (!peers.some((p) => p.phoneId === id)) contentAttempts.delete(id);
  const peer = peers.filter((p) => {
    if (peerBusy(p.deviceId)) return false; // a preset transfer is using this phone's connection
    const last = contentAttempts.get(p.phoneId);
    return !last || last.tier !== tier || now - last.at >= (last.failed ? 30000 : CONTENT_REFRESH_MS);
  }).sort((a, b) => (contentAttempts.get(a.phoneId)?.at ?? 0) - (contentAttempts.get(b.phoneId)?.at ?? 0))[0];
  if (!peer) return;
  const epoch = contentEpoch;
  contentAttempts.set(peer.phoneId, { tier, at: now, failed: false });
  contentRead = (async () => {
    try {
      const config = await readPeerContent(peer.deviceId, peer.phoneId, tier);
      if (running && epoch === contentEpoch) engine.receiveContent(peer.phoneId, tier, config, Date.now());
    } catch (e) {
      if (running && epoch === contentEpoch) {
        const message = `Text unavailable: ${(e as Error).message}. Keep both apps open and up to date; retrying.`;
        engine.contentFailed(peer.phoneId, message);
        contentAttempts.set(peer.phoneId, { tier, at: Date.now(), failed: true });
        note(message);
      }
    } finally {
      contentRead = undefined;
      renderStatusSoon();
    }
  })();
}

function schedule(plan: Plan) {
  pendingPlan = plan;
  if (applying) return;
  applying = (async () => {
    while (pendingPlan) {
      const p = pendingPlan;
      pendingPlan = null;
      await applyPlan(p);
    }
  })().finally(() => { applying = null; });
}

/** Uploads changed content to all local caps in parallel, so spanning marquees start together. */
async function applyPlan(plan: Plan) {
  lastPlan = plan;
  note(`group of ${plan.count} → ${TIER_LABELS[plan.tier]} (${plan.members.map((m) => m.label).join(', ') || 'no near caps'})`);
  await ensureFont();
  const jobs = caps.map(async (c) => {
    const a = plan.perCap.get(c.key);
    if (!a) return;
    if (c.controller.temporaryActive) { greetingDeferred.add(c.controller); engine.invalidate(); return; }
    let sig: string;
    let r: { frames: RgbImage[]; delays: number[]; periodMs?: number } | { image: RgbImage };
    try {
      const content = a.kind === 'create' ? ctx.createContent() : undefined;
      sig = JSON.stringify([getTextFont(), content ?? a]);
      if (sig === c.lastSig) return;
      r = await renderAssignment(a, content);
    } catch (e) { c.note = `render failed: ${(e as Error).message}`; return; }
    c.preview = 'frames' in r ? r : { frames: [r.image], delays: [1000] };
    if (c.controller.temporaryActive) { greetingDeferred.add(c.controller); engine.invalidate(); return; }
    if (c.controller.state !== 'Ready') { c.note = 'not connected; will update after reconnect'; return; }
    try {
      c.note = 'updating…'; renderCapsSoon();
      if ('frames' in r) {
        // A slice only reads as one marquee when all caps loop in phase: start playback on a shared clock boundary.
        const period = r.periodMs;
        const beforeEnd = period ? () => new Promise<void>((res) => setTimeout(res, msUntilLoopStart(Date.now(), period))) : undefined;
        await c.controller.uploadGif(encodeGif(r.frames, r.delays, { nonce: gifNonce() }), r.frames[0]!.width, r.frames[0]!.height, r.frames[0], { beforeEnd });
      } else await c.controller.upload(r.image);
      c.lastSig = sig;
      c.note = describe(a);
    } catch (e) {
      c.note = `upload failed: ${e instanceof DeviceError ? e.message : (e as Error).message}`;
      engine.invalidate();
    }
  });
  await Promise.all(jobs);
  renderCaps();
  renderStatus();
}

const describe = (a: Assignment) => (a.kind === 'create' ? 'Connect tab content' : a.kind === 'span' ? `span ${a.index + 1}/${a.total} (unstable): "${a.text}"` : `"${a.text}"`);

async function renderAssignment(a: Assignment, content?: Content): Promise<{ frames: RgbImage[]; delays: number[]; periodMs?: number } | { image: RgbImage }> {
  if (a.kind === 'individual' || a.kind === 'create') {
    const selected: Content | undefined = a.kind === 'individual'
      ? { kind: 'text', text: a.text, fg: a.fg, bg: a.bg, speed: a.speed }
      : content;
    if (!selected) throw new Error('Choose content on the Connect tab first.');
    const r = await ctx.renderContent(selected);
    return r.frames ? { frames: r.frames, delays: r.delays ?? r.frames.map(() => 100) } : { image: r.image };
  }
  const [w, h] = ctx.logicalDims();
  const m = renderSpanMarquee(a.text, w, h, a.total, a.index, parseHexColor(a.fg), parseHexColor(a.bg));
  const frames = m.frames.map((f) => ctx.physical(f));
  // Keep the visual speed of a normal marquee (2 px per frame) despite larger steps; whole centiseconds keep the period exact.
  const delay = gifDelayMs((ctx.marqueeDelay(a.speed) * m.step) / 2);
  return { frames, delays: frames.map(() => delay), periodMs: a.total > 1 ? frames.length * delay : undefined };
}

// ---------- rendering ------------------------------------------------------------

let capsQueued = false;
function renderCapsSoon() { if (!capsQueued) { capsQueued = true; requestAnimationFrame(() => { capsQueued = false; updateLive(); renderStatus(); }); } }
let statusQueued = false;
function renderStatusSoon() { if (!statusQueued) { statusQueued = true; requestAnimationFrame(() => { statusQueued = false; renderStatus(); updateLive(); }); } }

function liveBadges(c: CapEntry): string {
  const now = Date.now();
  const near = running && engine.tracker.isNear(c.key, now);
  const rssi = engine.tracker.rssi(c.key);
  const st = c.controller.state;
  return `<span class="pill ${st === 'Ready' ? 'ok' : st === 'Error' ? 'err' : 'busy'}">${esc(st === 'Uploading' && c.controller.progress ? `Uploading ${c.controller.progress.sent}/${c.controller.progress.total}` : st)}</span>
    ${running ? `<span class="pill ${near ? 'ok' : 'muted'}">${near ? 'near' : 'away'} ${rssi !== undefined ? `${formatMeters(rssi)} · ${Math.round(rssi)} dBm` : ''}</span>` : ''}`;
}

/** Refreshes only the live parts of the cap list so inputs keep focus. */
function updateLive() {
  let structural = false;
  document.querySelectorAll<HTMLLIElement>('#ap-caps li[data-key]').forEach((li) => {
    const c = caps.find((x) => x.key === li.dataset.key);
    if (!c) return;
    li.querySelector('.cap-live')!.innerHTML = liveBadges(c);
    li.querySelector('.cap-note')!.textContent = c.note;
    const down = c.controller.state === 'Disconnected' || c.controller.state === 'Error';
    if (down !== !!li.querySelector('[data-act=connect]')) structural = true;
  });
  if (structural) renderCaps();
}

export function renderApproach() {
  const root = document.getElementById('view-approach');
  if (!root || !ctx) return;
  const available = ctx.native || ctx.mock;
  const hub = settings.mode === 'hub';
  root.innerHTML = `
    <div class="card">
      <label class="switch"><input type="checkbox" role="switch" id="ap-start" ${running ? 'checked' : ''} ${available && !switching ? '' : 'disabled'} /> Approach mode ${running ? 'on' : 'off'}</label>
      <h2>Approach mode</h2>
      ${available ? '' : '<p class="warn">Approach mode needs the Android or iOS app (BLE scanning, several cap connections and a phone beacon are not available to web apps).</p>'}
      ${ctx.mock ? '<p class="warn">Mock mode: caps and nearby phones are simulated; use the RSSI sliders.</p>' : ''}
      <p class="small">Caps that come close are grouped; every cap then shows the content configured for the group size, either a personal greeting or one marquee (unstable) running across all caps.</p>
      <label for="ap-name">Your name</label>
      <input id="ap-name" type="text" maxlength="16" value="${esc(userName)}" placeholder="${esc(defaultLabel(phoneId, 0))}" autocomplete="nickname" />
      <p class="small">Shown on other phones and used in their greetings (e.g. "Hi ${esc(userName || 'Anna')}!"). Your caps are labelled with it unless you rename them below.</p>
      <fieldset class="row" style="border:0;padding:0;margin:.5em 0">
        <legend class="small">Mode</legend>
        <label><input type="radio" name="ap-mode" value="p2p" ${settings.mode === 'p2p' ? 'checked' : ''} ${running ? 'disabled' : ''}/> P2P (one cap per phone)</label>
        <label><input type="radio" name="ap-mode" value="hub" ${settings.mode === 'hub' ? 'checked' : ''} ${running ? 'disabled' : ''}/> Master (several caps on this phone)</label>
      </fieldset>
      <div class="row">
        <button id="ap-resync" ${running ? '' : 'disabled'}>Resend to all</button>
      </div>
      <div id="ap-status" class="small" aria-live="polite"></div>
    </div>
    <div class="card">
      <h2>${hub ? 'Caps on this phone' : 'Your cap'}</h2>
      ${hub
        ? `<p class="small">A cap accepts one Bluetooth connection. Connect all caps this phone controls. Order = left-to-right position for spanning marquees (unstable). Cap 1 is the cap of the Connect tab.</p>
      <div class="row">
        <button id="ap-add" ${available ? '' : 'disabled'}>Add cap</button>
        <button id="ap-saved" ${available && !ctx.mock ? '' : 'disabled'}>Connect saved caps</button>
      </div>`
        : `<p class="small">P2P: this phone controls one cap; other phones with the app are detected nearby. Connect it here or on the Connect tab.</p>
      ${caps.length ? '' : `<div class="row"><button id="ap-add" ${available ? '' : 'disabled'}>Connect cap</button></div>`}`}
      <ul class="list" id="ap-caps"></ul>
      ${ctx.mock ? '<div class="row"><button id="ap-sim-peer">Simulate nearby phone</button></div><ul class="list" id="ap-peers"></ul>' : ''}
    </div>
    <div class="card">
      <h2>Texts of nearby caps</h2>
      <p class="small">Compare texts for the current group size. Use another cap's text with its mode, colours and speed.</p>
      <p class="small">While approach mode is on, nearby app users can read your group text settings over Bluetooth. Connect tab images and animations are not shared.</p>
      <p class="small" id="ap-text-choice" role="status"></p>
      <ul class="list cap-texts" id="ap-texts"></ul>
    </div>
    <div class="card">
      <h2>Content per group size</h2>
      <p class="small">${esc(TEMPLATE_HELP)}</p>
      ${TIER_IDS.map(tierEditor).join('')}
      <label for="ap-preset-name">Group preset name</label>
      <div class="row preset-save"><input id="ap-preset-name" type="text" placeholder="e.g. Festival greetings" maxlength="60" /><button id="ap-preset-save">Save as preset</button></div>
      <p id="ap-preset-msg" class="small" role="status">Saved group presets appear on the Settings tab and are included in share/import.</p>
    </div>
    <div class="card">
      <h2>Detection</h2>
      <div class="form-grid">
        <div><label for="ap-enter">Near at ≥ dBm</label><input id="ap-enter" type="number" min="-110" max="-20" value="${settings.enterDbm}" /><span class="small" id="ap-enter-m">${formatMeters(settings.enterDbm)}</span></div>
        <div><label for="ap-leave">Away below dBm</label><input id="ap-leave" type="number" min="-120" max="-20" value="${settings.leaveDbm}" /><span class="small" id="ap-leave-m">${formatMeters(settings.leaveDbm)}</span></div>
        <div><label for="ap-settle">Settle s</label><input id="ap-settle" type="number" min="0" max="30" step="0.5" value="${settings.settleMs / 1000}" /></div>
        <div><label for="ap-confirm">Confirm s</label><input id="ap-confirm" type="number" min="0" max="10" step="0.5" value="${settings.confirmMs / 1000}" /></div>
      </div>
      <p class="small">"Confirm": a cap or phone counts as near (or away) only after repeated reports over this time, so a single strong or weak report does not change the group. "Settle": the group must then stay unchanged this long before the caps are updated.</p>
      <div class="row small"><span>Away beyond</span>${[3, 4, 5].map((m) => `<button type="button" data-away-m="${m}" class="${dbmForMeters(m) === settings.leaveDbm ? 'primary' : ''}">${m} m</button>`).join('')}</div>
      ${hub ? `<label><input type="checkbox" id="ap-beacon" ${settings.beacon ? 'checked' : ''}/> Advertise this phone to other phones</label>
      <label><input type="checkbox" id="ap-count" ${settings.countNearbyCaps ? 'checked' : ''}/> Count nearby caps that are not connected here</label>` : ''}
      <p class="small">RSSI is a rough distance signal (≈ -55 dBm touching, -70 dBm about 1–2 m); the metres shown are estimates from it and can be off by a factor of two. Raise "Near at" to require closer contact.</p>
      <h3 class="small">Nearby phones (approach beacons)</h3>
      <ul class="list small" id="ap-phones"></ul>
      <h3 class="small">Nearby caps (advertising)</h3>
      <ul class="list small" id="ap-nearby"></ul>
    </div>
    <div class="card">
      <h2>Calibrate</h2>
      <p class="small">Sets "Near at" and "Away below" for this phone, its cap and the other phone's antenna. Pick ${hub ? 'a cap or phone' : 'the other phone (or a cap)'}, measure ${CALIBRATION_MS / 1000} s standing together, then ${CALIBRATION_MS / 1000} s at the distance that should count as away.</p>
      <label for="ap-cal-src">Signal</label>
      <select id="ap-cal-src" ${running ? '' : 'disabled'}></select>
      <div class="row">
        <button type="button" id="ap-cal-together" ${running ? '' : 'disabled'}>Measure together</button>
        <button type="button" id="ap-cal-away" ${running ? '' : 'disabled'}>Measure away</button>
        <button type="button" id="ap-cal-apply" class="primary" disabled>Apply</button>
      </div>
      <p class="small" id="ap-cal-msg" role="status"></p>
    </div>
    <div class="card">
      <h2>Record and replay</h2>
      <p class="small">Records what this phone receives during a walk. Tap "Together"/"Apart" when you meet or part, then replay the walk with the current detection settings to compare: how often the group changed, short flips, and how long the caps took to react.</p>
      <div class="row">
        <button type="button" id="ap-rec" ${running || recorder ? '' : 'disabled'}>${recorder ? 'Stop recording' : 'Start recording'}</button>
        <button type="button" id="ap-mark-together" ${recorder ? '' : 'disabled'}>Together</button>
        <button type="button" id="ap-mark-apart" ${recorder ? '' : 'disabled'}>Apart</button>
      </div>
      <div class="row">
        <button type="button" id="ap-trace-export" ${trace ? '' : 'disabled'}>Export</button>
        <label class="row"><span>Load</span><input id="ap-trace-file" type="file" accept="application/json,.json" /></label>
        <button type="button" id="ap-replay" ${trace ? '' : 'disabled'}>Replay with current settings</button>
      </div>
      <p class="small" id="ap-trace-msg" role="status"></p>
      <pre id="ap-replay-out" class="small" style="white-space:pre-wrap"></pre>
    </div>
    <div class="card">
      <h2>Approach log</h2>
      <pre id="ap-log" class="small" style="max-height:180px;overflow:auto;white-space:pre-wrap">${esc(log.join('\n'))}</pre>
    </div>`;

  $<HTMLInputElement>('#ap-start').onchange = (e) => void setEnabled((e.target as HTMLInputElement).checked);
  $<HTMLInputElement>('#ap-name').addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    userName = fitBeaconName(el.value);
    el.value = userName;
    void saveKv('userName', userName).catch(() => undefined);
    note(userName ? `name set to "${userName}"` : 'name cleared');
    syncEngineCaps();
    renderCaps(); renderStatus();
  });
  $('#ap-resync').onclick = () => { caps.forEach((c) => (c.lastSig = undefined)); engine.invalidate(); note('resending to all caps'); };
  root.querySelectorAll<HTMLInputElement>('input[name=ap-mode]').forEach((el) => (el.onchange = () => setMode(el.value === 'hub' ? 'hub' : 'p2p')));
  const addBtn = document.getElementById('ap-add');
  if (addBtn) addBtn.onclick = () => void onAddCap();
  const savedBtn = document.getElementById('ap-saved');
  if (savedBtn) savedBtn.onclick = () => void onConnectSaved();
  const simBtn = document.getElementById('ap-sim-peer');
  if (simBtn) simBtn.onclick = () => { simPeers.push({ id: (crypto.getRandomValues(new Uint32Array(1))[0]! || 1) >>> 0, caps: 1, rssi: -60, tiers: structuredClone(settings.tiers) }); renderApproach(); };
  $<HTMLInputElement>('#ap-solo-create').onchange = (e) => {
    updateSettings({ ...settings, tiers: { ...settings.tiers, solo: { ...settings.tiers.solo, useCreate: (e.target as HTMLInputElement).checked } } });
    renderApproach();
  };
  for (const id of TIER_IDS) {
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-tier="${id}"]`).forEach((el) => el.addEventListener('change', () => {
      const field = el.dataset.field as 'mode' | 'text' | 'fg' | 'bg' | 'speed';
      const t = { ...settings.tiers[id] };
      if (field === 'speed') t.speed = Number(el.value);
      else if (field === 'mode') t.mode = el.value === 'span' ? 'span' : 'individual';
      else t[field] = el.value;
      updateSettings({ ...settings, tiers: { ...settings.tiers, [id]: t } });
      if (field === 'mode') $(`[data-marquee-warning="${id}"]`).hidden = t.mode !== 'span';
    }));
  }
  $('#ap-preset-save').onclick = async () => {
    const name = $<HTMLInputElement>('#ap-preset-name').value.trim();
    const msg = $('#ap-preset-msg');
    if (!name) { msg.textContent = 'Enter a preset name.'; return; }
    try {
      await savePreset({ id: crypto.randomUUID(), name, groups: getGroupContent(), updatedAt: Date.now() });
      $<HTMLInputElement>('#ap-preset-name').value = '';
      msg.textContent = `Saved "${name}".`;
    } catch (e) { msg.textContent = (e as Error).message; }
  };
  const num = (id: string, d: number) => { const v = Number($<HTMLInputElement>(id).value); return Number.isFinite(v) ? v : d; };
  for (const id of ['#ap-enter', '#ap-leave']) $<HTMLInputElement>(id).addEventListener('input', (e) => {
    $(`${id}-m`).textContent = formatMeters(Number((e.target as HTMLInputElement).value));
  });
  root.querySelectorAll<HTMLButtonElement>('[data-away-m]').forEach((b) => (b.onclick = () => {
    const leaveDbm = dbmForMeters(Number(b.dataset.awayM));
    updateSettings({ ...settings, leaveDbm, enterDbm: Math.max(settings.enterDbm, leaveDbm) });
    note(`caps count as away beyond about ${b.dataset.awayM} m (${leaveDbm} dBm)`);
    renderApproach();
  }));
  bindTools();
  root.querySelectorAll('#ap-enter,#ap-leave,#ap-settle,#ap-confirm,#ap-beacon,#ap-count').forEach((el) => el.addEventListener('change', () => {
    updateSettings({
      ...settings,
      enterDbm: num('#ap-enter', settings.enterDbm),
      leaveDbm: num('#ap-leave', settings.leaveDbm),
      settleMs: num('#ap-settle', settings.settleMs / 1000) * 1000,
      confirmMs: num('#ap-confirm', settings.confirmMs / 1000) * 1000,
      beacon: document.querySelector<HTMLInputElement>('#ap-beacon')?.checked ?? settings.beacon,
      countNearbyCaps: document.querySelector<HTMLInputElement>('#ap-count')?.checked ?? settings.countNearbyCaps,
    });
    if (running) void startBeacon();
  }));
  renderCaps();
  renderStatus();
}

/** P2P keeps only cap 1 on this phone; extra caps are disconnected (still saved for Master mode). */
function setMode(mode: 'p2p' | 'hub') {
  if (running || mode === settings.mode) { renderApproach(); return; }
  updateSettings({ ...settings, mode });
  if (mode === 'p2p' && caps.length > 1) {
    const saved = caps.filter((c) => !c.mock).map<SavedCap>((c) => ({ deviceId: c.deviceId, bleName: c.bleName, label: c.customLabel ?? '' }));
    for (const c of caps.slice(1)) { c.controller.disconnect(); engine.tracker.forget(c.key); }
    caps = caps.slice(0, 1);
    syncEngineCaps();
    void saveKv('approachCaps', saved).catch(() => undefined);
  }
  note(mode === 'p2p' ? 'mode: P2P (one cap per phone)' : 'mode: Master (several caps)');
  renderApproach();
}

export function getGroupContent(): GroupContent { return structuredClone(settings.tiers); }

export function getApproachSettings(): ApproachSettings { return structuredClone(settings); }

/** Refresh runtime state after an imported configuration was saved successfully. */
export function applyImportedApproachSettings(s: ApproachSettings): void {
  updateSettings(s, false);
  engine.invalidate();
  renderApproach();
}

export function createContentChanged(): void {
  if (settings.tiers.solo.useCreate) engine?.invalidate();
}

export function textFontChanged(): void {
  caps.forEach((c) => (c.lastSig = undefined));
  engine?.invalidate();
}

/** Loads a group preset; a running approach mode resends the new content. */
export function applyGroupContent(groups: GroupContent): void {
  updateSettings({ ...settings, tiers: structuredClone(groups) });
  engine.invalidate();
  note('group content loaded from preset');
  renderApproach();
}

function updateSettings(s: ApproachSettings, save = true) {
  settings = validateApproach(s);
  engine.setSettings(settings);
  caps.forEach((c) => (c.lastSig = undefined));
  if (save) void persist();
  if (running) void startBeacon();
  renderGroupTexts();
}

function tierEditor(id: TierId): string {
  const t = settings.tiers[id];
  return `<fieldset class="tier" data-tier-box="${id}"><legend>${esc(TIER_LABELS[id])}</legend>
    ${id === 'solo' ? `<label class="switch"><input type="checkbox" id="ap-solo-create" ${t.useCreate ? 'checked' : ''} /> Use Connect tab content</label>
    <p class="small">Use your text, color, image or animation from Connect when alone, and restore it when approach mode is switched off.</p>` : ''}
    <div ${id === 'solo' && t.useCreate ? 'hidden' : ''}>
    <div class="row">
      <select data-tier="${id}" data-field="mode" aria-label="${esc(TIER_LABELS[id])} mode">
        <option value="individual" ${t.mode === 'individual' ? 'selected' : ''}>Individual (greeting per cap)</option>
        <option value="span" ${t.mode === 'span' ? 'selected' : ''}>Marquee across all caps (unstable)</option>
      </select>
      <input type="color" data-tier="${id}" data-field="fg" value="${t.fg}" aria-label="text color" />
      <input type="color" data-tier="${id}" data-field="bg" value="${t.bg}" aria-label="background" />
    </div>
    <p class="warn small" data-marquee-warning="${id}" ${t.mode === 'span' ? '' : 'hidden'}>Marquee is unstable: physical cap order and playback synchronization may differ. Use Individual for reliable greetings.</p>
    <input type="text" data-tier="${id}" data-field="text" maxlength="120" value="${esc(t.text)}" aria-label="${esc(TIER_LABELS[id])} text" />
    <label class="small">Speed <input type="range" min="1" max="10" data-tier="${id}" data-field="speed" value="${t.speed}" /></label>
    </div>
  </fieldset>`;
}

function renderStatus() {
  const el = document.getElementById('ap-status');
  if (!el) return;
  const now = Date.now();
  const members: Member[] = running ? engine.members(now) : [];
  const count = Math.max(1, members.length);
  el.innerHTML = running
    ? `<p><b>Group: ${members.length}</b> cap${members.length === 1 ? '' : 's'} near → <b>${esc(TIER_LABELS[tierFor(count)])}</b></p>
       <p>${members.map((m) => `<span class="pill ${m.local ? 'ok' : 'busy'}">${esc(m.label)}${m.source === 'peer' ? (m.indirect ? ' (via group)' : ' (phone)') : m.source === 'cap' ? ' (cap)' : ''}</span>`).join(' ') || 'No cap is near yet.'}</p>
       <p>${esc(scanNote)} ${esc(beaconNote)}</p>${lastPlan ? `<p>Last applied: ${lastPlan.count} → ${esc(TIER_LABELS[lastPlan.tier])}</p>` : ''}`
    : '<p>Stopped.</p>';
  if (running && motionSupport) {
    const state = engine.motion.state(now);
    const text = motionNote || (state === 'unavailable'
      ? 'No recent motion samples; using RSSI only.'
      : `Motion support: ${state}. ${state === 'turning' ? 'Filtering brief signal swings.' : state === 'moving' ? 'Following sustained RSSI changes faster.' : 'Standard RSSI filtering.'}`);
    const p = document.createElement('p');
    p.textContent = text;
    el.append(p);
  }
  const nb = document.getElementById('ap-nearby');
  const ph = document.getElementById('ap-phones');
  if (ph) ph.innerHTML = engine.heardPhones(Date.now()).map((p) => `<li><span>${esc(p.label)} · ${p.id} · ${p.capCount} cap${p.capCount === 1 ? '' : 's'}</span><span>${formatMeters(p.rssi)} · ${p.rssi} dBm · ${p.mutual ? 'near (sees you)' : p.near ? 'near' : 'far'}</span></li>`).join('')
    || `<li class="muted">${running ? 'No other phone heard.' : 'Start approach mode to listen.'}</li>`;
  if (nb) nb.innerHTML = [...nearby.values()].sort((a, b) => b.rssi - a.rssi).map((n) => `<li><span>${esc(n.name)}</span><span>${formatMeters(n.rssi)} · ${n.rssi} dBm</span></li>`).join('') || '<li class="muted">None seen (connected caps often stop advertising).</li>';
  renderGroupTexts();
  renderTools();
}

// ---------- calibration and trace replay ------------------------------------------

/** Signals that can be calibrated: in P2P the own cap is worn by this user, so its distance never changes. */
function calSources(now: number) {
  return engine.sources(now).filter((src) => settings.mode === 'hub' || src.kind !== 'local');
}

function renderTools() {
  const sel = document.getElementById('ap-cal-src') as HTMLSelectElement | null;
  if (sel) {
    const sources = running ? calSources(Date.now()) : [];
    if (!calKey && sources[0]) calKey = sources[0].key;
    const markup = sources.map((src) => `<option value="${esc(src.key)}" ${src.key === calKey ? 'selected' : ''}>${esc(src.label)} (${src.kind === 'peer' ? 'phone' : src.kind === 'local' ? 'your cap' : 'cap'}) · ${Math.round(src.rssi)} dBm</option>`).join('')
      || '<option value="">Nothing heard yet</option>';
    if (sel.dataset.markup !== markup && document.activeElement !== sel) { sel.dataset.markup = markup; sel.innerHTML = markup; }
  }
  const now = Date.now();
  if (calStep && now > calStep.until) finishCalibrationStep();
  const msg = document.getElementById('ap-cal-msg');
  if (msg) msg.textContent = calStep ? `Measuring ${calStep.step}… ${Math.max(0, Math.ceil((calStep.until - now) / 1000))} s, ${calSamples[calStep.step].length} reports` : calMsg;
  const busy = !!calStep || !running;
  for (const id of ['#ap-cal-together', '#ap-cal-away']) { const b = document.querySelector<HTMLButtonElement>(id); if (b) b.disabled = busy || !calKey; }
  const apply = document.querySelector<HTMLButtonElement>('#ap-cal-apply');
  if (apply) apply.disabled = busy || !('enterDbm' in calibrate(calSamples.together, calSamples.away));
  const tm = document.getElementById('ap-trace-msg');
  if (tm) tm.textContent = recorder ? `Recording: ${recorder.events.length} events${recorder.truncated ? ' (full, later events dropped)' : ''}.` : traceMsg;
}

function finishCalibrationStep() {
  if (!calStep) return;
  const { step } = calStep;
  calStep = undefined;
  const n = calSamples[step].length;
  if (n < CALIBRATION_MIN_SAMPLES) { calMsg = `Only ${n} reports while measuring ${step}; stay in range and measure again.`; return; }
  calMsg = `${step === 'together' ? 'Together' : 'Away'}: median ${Math.round(median(calSamples[step]))} dBm from ${n} reports.`;
  const r = calibrate(calSamples.together, calSamples.away);
  if ('error' in r) { if (calSamples.together.length && calSamples.away.length) calMsg += ` ${r.error}`; }
  else calMsg += ` Suggested: near at ≥ ${r.enterDbm} dBm (${formatMeters(r.enterDbm)}), away below ${r.leaveDbm} dBm (${formatMeters(r.leaveDbm)}).`;
}

function describeReplay(label: string, m: ReplayMetrics): string {
  const s = (ms: number | null) => (ms === null ? 'never' : `${(ms / 1000).toFixed(1)} s`);
  const lines = [`${label}: ${m.groupChanges} group change${m.groupChanges === 1 ? '' : 's'} in ${(m.durationMs / 60000).toFixed(1)} min (${m.changesPerMinute.toFixed(1)}/min), ${m.flaps} short flip${m.flaps === 1 ? '' : 's'}`,
    `  sizes: ${m.applied.map((a) => a.count).join(' → ') || '–'}`];
  if (m.marks) {
    lines.push(`  join after "Together": ${m.marks.entryMs.map(s).join(', ') || '–'}`);
    lines.push(`  leave after "Apart": ${m.marks.exitMs.map(s).join(', ') || '–'}`);
    lines.push(`  grouped while apart: ${s(m.marks.falseGroupMs)}, alone while together: ${s(m.marks.missedGroupMs)}`);
  }
  return lines.join('\n');
}

function bindTools() {
  const sel = document.getElementById('ap-cal-src') as HTMLSelectElement | null;
  if (sel) sel.onchange = () => { calKey = sel.value; calSamples = { together: [], away: [] }; calMsg = 'Signal changed; measure both steps again.'; renderTools(); };
  const measure = (step: 'together' | 'away') => () => {
    if (!calKey) return;
    calSamples[step] = [];
    calStep = { step, until: Date.now() + CALIBRATION_MS };
    renderTools();
    setTimeout(() => { if (calStep?.step === step) { finishCalibrationStep(); renderTools(); } }, CALIBRATION_MS + 50);
  };
  $('#ap-cal-together').onclick = measure('together');
  $('#ap-cal-away').onclick = measure('away');
  $('#ap-cal-apply').onclick = () => {
    const r = calibrate(calSamples.together, calSamples.away);
    if ('error' in r) { calMsg = r.error; renderTools(); return; }
    updateSettings({ ...settings, enterDbm: r.enterDbm, leaveDbm: r.leaveDbm });
    note(`calibrated: near at ≥ ${r.enterDbm} dBm, away below ${r.leaveDbm} dBm (together ${r.togetherDbm}, away ${r.awayDbm} dBm)`);
    calMsg = 'Applied.';
    renderApproach();
  };
  $('#ap-rec').onclick = () => {
    if (recorder) {
      trace = recorder.toTrace();
      recorder = undefined;
      engine.recorder = undefined;
      traceMsg = `Recorded ${trace.events.length} events over ${(((trace.events.at(-1)?.t ?? trace.startedAt) - trace.startedAt) / 60000).toFixed(1)} min.`;
      note('trace recording stopped');
    } else {
      const now = Date.now();
      recorder = new TraceRecorder(phoneId, structuredClone(settings), now);
      recorder.push({ t: now, k: 'caps', caps: engine.getLocalCaps().map((c) => ({ key: c.key, bleName: c.bleName, label: c.label })) });
      engine.recorder = recorder;
      note('trace recording started');
    }
    renderApproach();
  };
  const mark = (together: boolean) => () => {
    if (!recorder) return;
    recorder.push({ t: Date.now(), k: 'mark', together });
    note(`marked: ${together ? 'together' : 'apart'}`);
    renderTools();
  };
  $('#ap-mark-together').onclick = mark(true);
  $('#ap-mark-apart').onclick = mark(false);
  $('#ap-trace-export').onclick = () => {
    if (!trace) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(trace)], { type: 'application/json' }));
    a.download = `approach-trace-${new Date(trace.startedAt).toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $<HTMLInputElement>('#ap-trace-file').onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      trace = parseTrace(JSON.parse(await file.text()));
      traceMsg = `Loaded ${file.name}: ${trace.events.length} events.`;
    } catch (err) { traceMsg = `Could not load trace: ${(err as Error).message}`; }
    renderApproach();
  };
  $('#ap-replay').onclick = () => {
    const out = $('#ap-replay-out');
    if (!trace) return;
    try {
      out.textContent = `${describeReplay('Recorded settings', replayTrace(trace))}\n${describeReplay('Current settings', replayTrace(trace, settings))}`;
    } catch (err) { out.textContent = (err as Error).message; }
  };
}

function renderGroupTexts() {
  const list = document.getElementById('ap-texts');
  const status = document.getElementById('ap-text-choice');
  if (!list || !status) return;
  const choice = engine.groupTexts(Date.now());
  const tier = tierFor(choice.rows.length);
  const own = settings.tiers[tier];
  const automatic = choice.winner && own.mode === 'span';
  status.textContent = !running ? 'Start approach mode to compare nearby caps.'
    : choice.rows.length === 0 ? 'No near caps yet.'
    : automatic ? `${TIER_LABELS[tier]}: majority text used automatically (${choice.votes}/${choice.rows.length} caps). Your saved text is unchanged.`
    : choice.rows.some((r) => !r.config) ? `${TIER_LABELS[tier]}: waiting for all cap texts. No automatic selection.`
    : choice.rows.length <= 2 ? `${TIER_LABELS[tier]}: choose a text manually; automatic selection starts at 3 caps.`
    : choice.tied ? `${TIER_LABELS[tier]}: tied texts. Choose a text manually.`
    : own.mode === 'span' ? `${TIER_LABELS[tier]}: no text has a majority (more than half of the caps). Choose a text manually.`
    : `${TIER_LABELS[tier]}: Individual mode keeps your own greeting. Automatic selection applies to marquee mode (unstable).`;
  const rows = running ? choice.rows : [];
  const markup = rows.map((row) => {
    const c = row.config;
    const winner = automatic && c?.mode === 'span' && c.text === choice.winner?.config?.text;
    const same = c && base64(encodeTierContent(c)) === base64(encodeTierContent(own));
    return `<li data-text-key="${esc(row.key)}"${winner ? ' class="text-selected"' : ''}>
      <div class="cap-text-detail">
        <b>${esc(row.label)}</b> <small class="muted">${row.local ? '(this phone)' : '(nearby)'}</small>
        ${c ? `<p class="cap-text-value">${esc(c.text) || '<em>Empty text</em>'}</p>
        <small class="muted">${c.mode === 'span' ? 'Marquee (unstable)' : c.useCreate ? 'Connect tab content; template not active' : 'Individual'} · ${esc(c.fg)} / ${esc(c.bg)} · speed ${c.speed}</small>`
        : `<p class="small">${esc(row.unavailable ?? 'Text unavailable')}</p>`}
        ${winner ? '<p class="text-choice-label">Majority · used automatically</p>' : ''}
      </div>
      ${c && !row.local ? `<button type="button" data-use-text="${esc(row.key)}" ${same ? 'disabled' : ''} aria-label="Use text from ${esc(row.label)}">${same ? 'Same settings' : 'Use text'}</button>` : ''}
    </li>`;
  }).join('') || '<li class="muted">No cap texts to compare.</li>';
  // Do not replace focused buttons on every RSSI tick.
  if (list.dataset.markup === markup) return;
  list.dataset.markup = markup;
  list.innerHTML = markup;
  list.querySelectorAll<HTMLButtonElement>('[data-use-text]').forEach((button) => {
    button.onclick = () => {
      const current = engine.groupTexts(Date.now());
      const row = current.rows.find((r) => r.key === button.dataset.useText);
      if (!row?.config) { note('text no longer available; wait for the peer to reconnect'); renderGroupTexts(); return; }
      const id = tierFor(current.rows.length);
      const displayed = rows.find((r) => r.key === row.key)?.config;
      if (id !== tier || !displayed || base64(encodeTierContent(displayed)) !== base64(encodeTierContent(row.config))) {
        note('group or peer text changed; select the updated text');
        renderGroupTexts();
        return;
      }
      updateSettings({ ...settings, tiers: { ...settings.tiers, [id]: { ...row.config } } });
      note(`adopted ${row.label}'s ${TIER_LABELS[id]} text`);
      renderApproach();
    };
  });
}

function renderCaps() {
  const ul = document.getElementById('ap-caps');
  if (!ul) return;
  previewTimers.forEach(clearTimeout);
  previewTimers = [];
  ul.innerHTML = caps.map((c, i) => {
    return `<li data-key="${esc(c.key)}" style="flex-wrap:wrap">
      <span style="flex:1 1 100%"><b>${i + 1}.</b> <input type="text" data-act="label" value="${esc(c.label)}" maxlength="16" style="width:8em" aria-label="cap label" />
        <small class="muted">${esc(c.bleName)}</small>
        <span class="cap-live">${liveBadges(c)}</span>
      </span>
      <canvas class="ap-prev" width="64" height="32" style="background:#000;border:1px solid #333;image-rendering:pixelated;height:32px"></canvas>
      <small class="cap-note" style="flex:1">${esc(c.note)}</small>
      ${ctx.mock || c.deviceId.startsWith('mock-') ? `<label class="small">RSSI <input type="range" data-act="rssi" min="-100" max="-40" value="${c.mockRssi}" /></label>` : ''}
      ${settings.mode === 'hub' ? `<button data-act="up" aria-label="move left" ${i === 0 ? 'disabled' : ''}>◀</button>
      <button data-act="down" aria-label="move right" ${i === caps.length - 1 ? 'disabled' : ''}>▶</button>` : ''}
      ${c.controller.state === 'Disconnected' || c.controller.state === 'Error' ? '<button data-act="connect">Reconnect</button>' : ''}
      <button data-act="remove" class="danger">Remove</button>
    </li>`;
  }).join('') || '<li class="muted">No caps yet. Tap "Add cap".</li>';
  ul.querySelectorAll<HTMLLIElement>('li[data-key]').forEach((li) => {
    const c = caps.find((x) => x.key === li.dataset.key);
    if (!c) return;
    li.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
      const act = el.dataset.act;
      if (act === 'label') el.addEventListener('change', () => { const v = (el as HTMLInputElement).value.trim(); c.customLabel = v && !isAutoLabel(v) ? v : undefined; syncEngineCaps(); persistCaps(); renderCaps(); });
      else if (act === 'rssi') el.addEventListener('input', () => { c.mockRssi = Number((el as HTMLInputElement).value); });
      else if (act === 'up') el.onclick = () => moveCap(c.key, -1);
      else if (act === 'down') el.onclick = () => moveCap(c.key, 1);
      else if (act === 'connect') el.onclick = () => void connectEntry(c);
      else if (act === 'remove') el.onclick = () => removeCap(c.key);
    });
    const cv = li.querySelector<HTMLCanvasElement>('canvas.ap-prev');
    if (cv && c.preview) animate(cv, c.preview.frames, c.preview.delays);
  });
  const pl = document.getElementById('ap-peers');
  if (pl) {
    const tier = tierFor(engine.members(Date.now()).length);
    pl.innerHTML = simPeers.map((p, i) => `<li data-i="${i}" class="sim-peer"><span>Phone ${defaultLabel(p.id, 0)} with <input type="number" data-act="caps" min="1" max="20" value="${p.caps}" style="width:4em" /> caps</span>
      <label>Shared text (${esc(TIER_LABELS[tier])})<input type="text" data-act="text" maxlength="120" value="${esc(p.tiers[tier].text)}" /></label>
      <label>Text mode<select data-act="mode"><option value="individual" ${p.tiers[tier].mode === 'individual' ? 'selected' : ''}>Individual</option><option value="span" ${p.tiers[tier].mode === 'span' ? 'selected' : ''}>Marquee (unstable)</option></select></label>
      <label class="small">RSSI <input type="range" data-act="rssi" min="-100" max="-40" value="${p.rssi}" /></label><button data-act="del" class="danger">✕</button></li>`).join('');
    pl.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
      const p = simPeers[Number(li.dataset.i)]!;
      li.querySelector<HTMLInputElement>('[data-act=caps]')!.onchange = (e) => { p.caps = Math.max(1, Math.min(20, Number((e.target as HTMLInputElement).value) || 1)); };
      li.querySelector<HTMLInputElement>('[data-act=rssi]')!.oninput = (e) => { p.rssi = Number((e.target as HTMLInputElement).value); };
      li.querySelector<HTMLInputElement>('[data-act=text]')!.onchange = (e) => { p.tiers[tier].text = (e.target as HTMLInputElement).value; };
      li.querySelector<HTMLSelectElement>('[data-act=mode]')!.onchange = (e) => { p.tiers[tier].mode = (e.target as HTMLSelectElement).value === 'span' ? 'span' : 'individual'; };
      li.querySelector<HTMLButtonElement>('[data-act=del]')!.onclick = () => { simPeers = simPeers.filter((x) => x !== p); renderApproach(); };
    });
  }
}

function animate(cv: HTMLCanvasElement, frames: RgbImage[], delays: number[]) {
  let i = 0;
  const tick = () => {
    if (!cv.isConnected) return;
    drawPreview(cv, frames[i % frames.length]!);
    if (frames.length > 1) previewTimers.push(setTimeout(tick, delays[i % frames.length] ?? 100));
    i++;
  };
  tick();
}

/** True while approach mode owns caps; the Connect tab warns instead of fighting over them. */
export const approachOwnsCaps = () => caps.length > 0;
export const approachCapIds = () => caps.map((c) => c.deviceId);

/** Nearby phones (with approach mode on) that can receive a shared preset; empty while approach mode is off. */
export function sharePeers(): { phoneId: number; deviceId: string; label: string; rssi: number; near: boolean }[] {
  return running && ctx.native && !ctx.mock ? engine.sharePeers(Date.now()) : [];
}
export const approachRunning = () => running;
/** Identity sent with a preset offer. */
export const shareIdentity = () => ({ phoneId, name: beaconName() || defaultLabel(phoneId, 0) });