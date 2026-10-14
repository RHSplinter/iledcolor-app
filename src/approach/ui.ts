import { DeviceController, DeviceError } from '../controller/deviceController';
import type { RgbImage } from '../protocol/framing';
import { encodeGif } from '../render/gif';
import { drawPreview, parseHexColor } from '../render/matrix';
import { ensureFont, renderSpanMarquee } from '../render/text';
import { loadKv, saveKv } from '../storage/db';
import type { Content } from '../storage/presets';
import { MockTransport } from '../transport/mock';
import type { Transport, TransportProfile } from '../transport/types';
import { ApproachBeacon } from './beacon';
import { encodeBeacon } from './beaconCodec';
import { ApproachEngine, defaultLabel, type Assignment, type LocalCap, type Member, type Plan } from './engine';
import { DEFAULT_APPROACH, TEMPLATE_HELP, TIER_IDS, TIER_LABELS, tierFor, validateApproach, type ApproachSettings, type TierId } from './tiers';

/** What the approach tab needs from the rest of the app. */
export interface ApproachContext {
  native: boolean;
  mock: boolean;
  profile(): TransportProfile;
  logicalDims(): [number, number];
  physical(img: RgbImage): RgbImage;
  renderContent(c: Content): Promise<{ image: RgbImage; frames?: RgbImage[]; delays?: number[] }>;
  marqueeDelay(speed: number): number;
  trace(dir: 'tx' | 'rx' | 'ev', label: string, data?: Uint8Array): void;
  chooseCap(): Promise<{ deviceId: string; name: string }>;
  connectCap(deviceId: string): Promise<Transport>;
  readRssi(deviceId: string): Promise<number>;
  startScan(cb: (a: { deviceId: string; name?: string; rssi?: number; uuids?: string[] }) => void): Promise<void>;
  stopScan(): Promise<void>;
  /** Hands over the cap connected on the Connect tab (if it is this device, or any when omitted). */
  releaseConnectTabCap(deviceId?: string): { deviceId: string; name: string; controller: DeviceController } | null;
}

interface CapEntry extends LocalCap {
  deviceId: string;
  controller: DeviceController;
  rssi?: number;
  note: string;
  lastSig?: string;
  lastReconnect: number;
  mock?: MockTransport;
  mockRssi: number;
  preview?: { frames: RgbImage[]; delays: number[] };
}
interface SimPeer { id: number; caps: number; rssi: number }
interface SavedCap { deviceId: string; bleName: string; label: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let ctx: ApproachContext;
let settings: ApproachSettings = DEFAULT_APPROACH;
let engine: ApproachEngine;
let phoneId = 0;
let caps: CapEntry[] = [];
let simPeers: SimPeer[] = [];
let running = false;
let loopTimer: ReturnType<typeof setInterval> | undefined;
let applying: Promise<void> | null = null;
let pendingPlan: Plan | null = null;
let lastPlan: Plan | null = null;
let beaconNote = '';
let scanNote = '';
const nearby = new Map<string, { name: string; rssi: number; seen: number }>();
const log: string[] = [];
let previewTimers: Array<ReturnType<typeof setTimeout>> = [];

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
  } catch { settings = DEFAULT_APPROACH; }
  if (!phoneId) {
    phoneId = (crypto.getRandomValues(new Uint32Array(1))[0]! || 1) >>> 0;
    void saveKv('phoneId', phoneId).catch(() => undefined);
  }
  engine = new ApproachEngine(phoneId, settings);
}

const persist = () => saveKv('approach', settings).catch((e) => note(`could not save settings: ${(e as Error).message}`));
const persistCaps = () => saveKv('approachCaps', caps.filter((c) => !c.mock).map<SavedCap>((c) => ({ deviceId: c.deviceId, bleName: c.bleName, label: c.label }))).catch(() => undefined);

function syncEngineCaps() {
  engine.setLocalCaps(caps.map((c) => ({ key: c.key, bleName: c.bleName, label: c.label })));
  engine.invalidate();
  if (running) void startBeacon();
}

// ---------- cap management ------------------------------------------------------

function makeController(): DeviceController {
  const ctl = new DeviceController({ profile: ctx.profile(), onTrace: ctx.trace });
  ctl.subscribe(() => renderCapsSoon());
  return ctl;
}

async function addCap(deviceId: string, bleName: string, label?: string, existing?: DeviceController) {
  if (caps.some((c) => c.deviceId === deviceId)) { note(`${bleName} is already in the list`); return; }
  const entry: CapEntry = {
    key: deviceId, deviceId, bleName, label: label || defaultLabel(phoneId, caps.length),
    controller: existing ?? makeController(), note: '', lastReconnect: Date.now(), mockRssi: -55,
  };
  if (existing) existing.subscribe(() => renderCapsSoon());
  caps.push(entry);
  syncEngineCaps();
  persistCaps();
  renderCaps(); renderStatus();
  if (!existing) await connectEntry(entry);
}

async function connectEntry(c: CapEntry) {
  if (c.controller.state !== 'Disconnected' && c.controller.state !== 'Error') return;
  c.controller = makeController();
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
    const handed = ctx.releaseConnectTabCap(d.deviceId);
    await addCap(d.deviceId, d.name, undefined, handed?.controller);
  } catch (e) {
    if ((e as Error).name !== 'SelectionCancelledError') note(`add failed: ${(e as Error).message}`);
  }
}

async function onConnectSaved() {
  const saved = (await loadKv('approachCaps').catch(() => undefined)) as SavedCap[] | undefined;
  if (!Array.isArray(saved) || !saved.length) { note('no saved caps yet'); return; }
  for (const s of saved) {
    if (typeof s?.deviceId !== 'string' || typeof s.bleName !== 'string') continue;
    const handed = ctx.releaseConnectTabCap(s.deviceId);
    await addCap(s.deviceId, s.bleName, typeof s.label === 'string' ? s.label : undefined, handed?.controller);
  }
}

// ---------- detection loop --------------------------------------------------------

async function startBeacon() {
  if (!ctx.native) { beaconNote = settings.beacon ? 'Beacon needs the mobile app.' : ''; return; }
  try {
    if (!settings.beacon) { await ApproachBeacon.stop(); beaconNote = 'Beacon off.'; return; }
    await ApproachBeacon.start({ uuid: encodeBeacon(engine.beacon()) });
    beaconNote = `Beacon on (phone ${phoneId.toString(16).padStart(8, '0')}, ${caps.length} cap${caps.length === 1 ? '' : 's'}).`;
  } catch (e) { beaconNote = `Beacon failed: ${(e as Error).message}`; }
  renderStatusSoon();
}

async function start() {
  if (running) return;
  running = true;
  engine.invalidate();
  caps.forEach((c) => (c.lastSig = undefined));
  note('approach mode started');
  try {
    await ctx.startScan((a) => {
      const now = Date.now();
      engine.onAdvertisement(a, now);
      if (a.name?.toLowerCase().startsWith('iledcolor') && a.rssi !== undefined) nearby.set(a.deviceId, { name: a.name, rssi: a.rssi, seen: now });
    });
    scanNote = 'Scanning.';
  } catch (e) { scanNote = `Scan failed: ${(e as Error).message}`; note(scanNote); }
  if (ctx.native) void ApproachBeacon.setKeepAwake({ on: true }).catch(() => undefined);
  await startBeacon();
  loopTimer = setInterval(() => void loop(), 1000);
  renderApproach();
}

async function stop() {
  running = false;
  clearInterval(loopTimer);
  await ctx.stopScan();
  if (ctx.native) {
    await ApproachBeacon.stop().catch(() => undefined);
    void ApproachBeacon.setKeepAwake({ on: false }).catch(() => undefined);
  }
  beaconNote = ''; scanNote = '';
  note('approach mode stopped');
  renderApproach();
}

async function loop() {
  const now = Date.now();
  await Promise.all(caps.map(async (c) => {
    const st = c.controller.state;
    if (st === 'Ready') {
      try {
        const r = c.mock || c.deviceId.startsWith('mock-') ? c.mockRssi : await ctx.readRssi(c.deviceId);
        c.rssi = r;
        engine.onLocalRssi(c.key, r, now);
      } catch { /* RSSI read can fail during an upload; the next tick retries */ }
    } else if ((st === 'Disconnected' || st === 'Error') && now - c.lastReconnect > 8000) {
      note(`${c.label}: reconnecting…`);
      void connectEntry(c);
    }
  }));
  for (const p of simPeers)
    engine.onAdvertisement({ deviceId: `sim-${p.id}`, rssi: p.rssi + (Math.random() * 4 - 2), uuids: [encodeBeacon({ phoneId: p.id, capCount: p.caps, capHashes: [] })] }, now);
  for (const [id, n] of nearby) if (now - n.seen > 10000) nearby.delete(id);
  const plan = engine.tick(now);
  if (plan) schedule(plan);
  renderStatusSoon();
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
    const sig = JSON.stringify(a);
    if (sig === c.lastSig) return;
    let r: { frames: RgbImage[]; delays: number[] } | { image: RgbImage };
    try { r = await renderAssignment(a); } catch (e) { c.note = `render failed: ${(e as Error).message}`; return; }
    c.preview = 'frames' in r ? r : { frames: [r.image], delays: [1000] };
    if (c.controller.state !== 'Ready') { c.note = 'not connected; will update after reconnect'; return; }
    try {
      c.note = 'updating…'; renderCapsSoon();
      if ('frames' in r) await c.controller.uploadGif(encodeGif(r.frames, r.delays), r.frames[0]!.width, r.frames[0]!.height);
      else await c.controller.upload(r.image);
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

const describe = (a: Assignment) => (a.kind === 'span' ? `span ${a.index + 1}/${a.total}: "${a.text}"` : `"${a.text}"`);

async function renderAssignment(a: Assignment): Promise<{ frames: RgbImage[]; delays: number[] } | { image: RgbImage }> {
  if (a.kind === 'individual') {
    const r = await ctx.renderContent({ kind: 'text', text: a.text, fg: a.fg, bg: a.bg, speed: a.speed });
    return r.frames ? { frames: r.frames, delays: r.delays ?? r.frames.map(() => 100) } : { image: r.image };
  }
  const [w, h] = ctx.logicalDims();
  const m = renderSpanMarquee(a.text, w, h, a.total, a.index, parseHexColor(a.fg), parseHexColor(a.bg));
  const frames = m.frames.map((f) => ctx.physical(f));
  // Keep the visual speed of a normal marquee (2 px per frame) despite larger steps.
  const delay = Math.round((ctx.marqueeDelay(a.speed) * m.step) / 2);
  return { frames, delays: frames.map(() => delay) };
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
    ${running ? `<span class="pill ${near ? 'ok' : 'muted'}">${near ? 'near' : 'away'} ${rssi !== undefined ? Math.round(rssi) + ' dBm' : ''}</span>` : ''}`;
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
  root.innerHTML = `
    <div class="card">
      <h2>Approach mode</h2>
      ${available ? '' : '<p class="warn">Approach mode needs the Android or iOS app (BLE scanning, several cap connections and a phone beacon are not available to web apps).</p>'}
      ${ctx.mock ? '<p class="warn">Mock mode: caps and nearby phones are simulated; use the RSSI sliders.</p>' : ''}
      <p class="small">Caps that come close are grouped; every cap then shows the content configured for the group size, either a personal greeting or one marquee running across all caps.</p>
      <div class="row">
        <button id="ap-start" class="primary" ${available ? '' : 'disabled'}>${running ? 'Stop' : 'Start'}</button>
        <button id="ap-resync" ${running ? '' : 'disabled'}>Resend to all</button>
      </div>
      <div id="ap-status" class="small" aria-live="polite"></div>
    </div>
    <div class="card">
      <h2>Caps on this phone</h2>
      <p class="small">A cap accepts one Bluetooth connection. Connect every cap you carry (or, as a hub, several caps) here. Order = left-to-right position for spanning marquees.</p>
      <div class="row">
        <button id="ap-add" ${available ? '' : 'disabled'}>Add cap</button>
        <button id="ap-saved" ${available && !ctx.mock ? '' : 'disabled'}>Connect saved caps</button>
        <button id="ap-adopt" ${available && !ctx.mock ? '' : 'disabled'}>Take cap from Connect tab</button>
      </div>
      <ul class="list" id="ap-caps"></ul>
      ${ctx.mock ? '<div class="row"><button id="ap-sim-peer">Simulate nearby phone</button></div><ul class="list" id="ap-peers"></ul>' : ''}
    </div>
    <div class="card">
      <h2>Content per group size</h2>
      <p class="small">${esc(TEMPLATE_HELP)}</p>
      ${TIER_IDS.map(tierEditor).join('')}
    </div>
    <div class="card">
      <h2>Detection</h2>
      <div class="row">
        <div><label for="ap-enter">Near at ≥ dBm</label><input id="ap-enter" type="number" min="-110" max="-20" value="${settings.enterDbm}" /></div>
        <div><label for="ap-leave">Away below dBm</label><input id="ap-leave" type="number" min="-120" max="-20" value="${settings.leaveDbm}" /></div>
        <div><label for="ap-settle">Settle s</label><input id="ap-settle" type="number" min="0" max="30" step="0.5" value="${settings.settleMs / 1000}" /></div>
      </div>
      <label><input type="checkbox" id="ap-beacon" ${settings.beacon ? 'checked' : ''}/> Advertise this phone to other phones (peer mode)</label>
      <label><input type="checkbox" id="ap-count" ${settings.countNearbyCaps ? 'checked' : ''}/> Count nearby caps that are not connected here</label>
      <p class="small">RSSI is a rough distance signal (≈ -55 dBm touching, -70 dBm about 1–2 m). Raise "Near at" to require closer contact.</p>
      <h3 class="small">Nearby caps (advertising)</h3>
      <ul class="list small" id="ap-nearby"></ul>
    </div>
    <div class="card">
      <h2>Approach log</h2>
      <pre id="ap-log" class="small" style="max-height:180px;overflow:auto;white-space:pre-wrap">${esc(log.join('\n'))}</pre>
    </div>`;

  $('#ap-start').onclick = () => void (running ? stop() : start());
  $('#ap-resync').onclick = () => { caps.forEach((c) => (c.lastSig = undefined)); engine.invalidate(); note('resending to all caps'); };
  $('#ap-add').onclick = () => void onAddCap();
  $('#ap-saved').onclick = () => void onConnectSaved();
  $('#ap-adopt').onclick = () => {
    const h = ctx.releaseConnectTabCap();
    if (!h) { note('no cap is connected on the Connect tab'); return; }
    void addCap(h.deviceId, h.name, undefined, h.controller);
  };
  const simBtn = document.getElementById('ap-sim-peer');
  if (simBtn) simBtn.onclick = () => { simPeers.push({ id: (crypto.getRandomValues(new Uint32Array(1))[0]! || 1) >>> 0, caps: 1, rssi: -60 }); renderApproach(); };
  for (const id of TIER_IDS) {
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-tier="${id}"]`).forEach((el) => el.addEventListener('change', () => {
      const field = el.dataset.field as 'mode' | 'text' | 'fg' | 'bg' | 'speed';
      const t = { ...settings.tiers[id] };
      if (field === 'speed') t.speed = Number(el.value);
      else if (field === 'mode') t.mode = el.value === 'span' ? 'span' : 'individual';
      else t[field] = el.value;
      updateSettings({ ...settings, tiers: { ...settings.tiers, [id]: t } });
    }));
  }
  const num = (id: string, d: number) => { const v = Number($<HTMLInputElement>(id).value); return Number.isFinite(v) ? v : d; };
  root.querySelectorAll('#ap-enter,#ap-leave,#ap-settle,#ap-beacon,#ap-count').forEach((el) => el.addEventListener('change', () => {
    updateSettings({
      ...settings,
      enterDbm: num('#ap-enter', settings.enterDbm),
      leaveDbm: num('#ap-leave', settings.leaveDbm),
      settleMs: num('#ap-settle', settings.settleMs / 1000) * 1000,
      beacon: $<HTMLInputElement>('#ap-beacon').checked,
      countNearbyCaps: $<HTMLInputElement>('#ap-count').checked,
    });
    if (running) void startBeacon();
  }));
  renderCaps();
  renderStatus();
}

function updateSettings(s: ApproachSettings) {
  settings = validateApproach(s);
  engine.setSettings(settings);
  caps.forEach((c) => (c.lastSig = undefined));
  void persist();
}

function tierEditor(id: TierId): string {
  const t = settings.tiers[id];
  return `<fieldset class="tier" data-tier-box="${id}"><legend>${esc(TIER_LABELS[id])}</legend>
    <div class="row">
      <select data-tier="${id}" data-field="mode" aria-label="${esc(TIER_LABELS[id])} mode">
        <option value="individual" ${t.mode === 'individual' ? 'selected' : ''}>Individual (greeting per cap)</option>
        <option value="span" ${t.mode === 'span' ? 'selected' : ''}>Marquee across all caps</option>
      </select>
      <input type="color" data-tier="${id}" data-field="fg" value="${t.fg}" aria-label="text color" />
      <input type="color" data-tier="${id}" data-field="bg" value="${t.bg}" aria-label="background" />
    </div>
    <input type="text" data-tier="${id}" data-field="text" maxlength="120" value="${esc(t.text)}" aria-label="${esc(TIER_LABELS[id])} text" />
    <label class="small">Speed <input type="range" min="1" max="10" data-tier="${id}" data-field="speed" value="${t.speed}" /></label>
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
       <p>${members.map((m) => `<span class="pill ${m.local ? 'ok' : 'busy'}">${esc(m.label)}${m.source === 'peer' ? ' (phone)' : m.source === 'cap' ? ' (cap)' : ''}</span>`).join(' ') || 'No cap is near yet.'}</p>
       <p>${esc(scanNote)} ${esc(beaconNote)}</p>${lastPlan ? `<p>Last applied: ${lastPlan.count} → ${esc(TIER_LABELS[lastPlan.tier])}</p>` : ''}`
    : '<p>Stopped.</p>';
  const nb = document.getElementById('ap-nearby');
  if (nb) nb.innerHTML = [...nearby.values()].sort((a, b) => b.rssi - a.rssi).map((n) => `<li><span>${esc(n.name)}</span><span>${n.rssi} dBm</span></li>`).join('') || '<li class="muted">None seen (connected caps often stop advertising).</li>';
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
      <button data-act="up" aria-label="move left" ${i === 0 ? 'disabled' : ''}>◀</button>
      <button data-act="down" aria-label="move right" ${i === caps.length - 1 ? 'disabled' : ''}>▶</button>
      ${c.controller.state === 'Disconnected' || c.controller.state === 'Error' ? '<button data-act="connect">Reconnect</button>' : ''}
      <button data-act="remove" class="danger">Remove</button>
    </li>`;
  }).join('') || '<li class="muted">No caps yet. Tap "Add cap".</li>';
  ul.querySelectorAll<HTMLLIElement>('li[data-key]').forEach((li) => {
    const c = caps.find((x) => x.key === li.dataset.key);
    if (!c) return;
    li.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
      const act = el.dataset.act;
      if (act === 'label') el.addEventListener('change', () => { c.label = (el as HTMLInputElement).value.trim() || defaultLabel(phoneId, caps.indexOf(c)); syncEngineCaps(); persistCaps(); });
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
    pl.innerHTML = simPeers.map((p, i) => `<li data-i="${i}"><span>Phone ${defaultLabel(p.id, 0)} with <input type="number" data-act="caps" min="1" max="20" value="${p.caps}" style="width:4em" /> caps</span>
      <label class="small">RSSI <input type="range" data-act="rssi" min="-100" max="-40" value="${p.rssi}" /></label><button data-act="del" class="danger">✕</button></li>`).join('');
    pl.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
      const p = simPeers[Number(li.dataset.i)]!;
      li.querySelector<HTMLInputElement>('[data-act=caps]')!.onchange = (e) => { p.caps = Math.max(1, Math.min(20, Number((e.target as HTMLInputElement).value) || 1)); };
      li.querySelector<HTMLInputElement>('[data-act=rssi]')!.oninput = (e) => { p.rssi = Number((e.target as HTMLInputElement).value); };
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
