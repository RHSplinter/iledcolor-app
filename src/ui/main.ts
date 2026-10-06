import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { DeviceController, DeviceError } from '../controller/deviceController';
import type { RgbImage } from '../protocol/framing';
import { imageToMatrix, shrinkForStorage, type Fit } from '../render/image';
import { cornerTest, drawPreview, parseHexColor, solid, transformImage } from '../render/matrix';
import { encodeGif } from '../render/gif';
import { gifToFrames, MAX_GIF_STORE_BYTES } from '../render/gifDecode';
import { ensureFont, renderMarquee, renderText } from '../render/text';
import { deletePreset, listPresets, loadSettings, replaceAllPresets, requestPersistence, savePreset, saveSettings } from '../storage/db';
import { DEFAULT_SETTINGS, DEFAULT_SPEED, exportJson, parseImport, type Content, type Preset, type Settings } from '../storage/presets';
import { MockTransport } from '../transport/mock';
import { SPIKE_PROFILE, type TransportProfile } from '../transport/types';
import { bluetoothSupport, connectWebBluetooth } from '../transport/webBluetooth';

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let settings: Settings;
let controller: DeviceController;
let deviceName = '';
let useMock = location.hash === '#mock'; // dev/test only: in-memory hat
let lastImage: RgbImage | null = null; // retained across disconnects
let lastFrames: RgbImage[] | null = null; // set when the content is a marquee
let lastDelays: number[] = [];
let previewTimer: ReturnType<typeof setTimeout> | undefined;
/** Scroll speed 1 (slow) .. 10 (fast) -> per-frame delay at 2 px per frame. */
const marqueeDelay = (speed: number) => Math.round(220 / speed);
let sendNote = '';
let brightnessNote = '';
let displayNote = '';
let imageBlob: Blob | null = null;
let imageDataUrl = '';
let renderSeq = 0;

function profileFor(s: Settings): TransportProfile {
  return { ...SPIKE_PROFILE, chunkSize: s.chunkSize, interWriteDelayMs: s.interWriteDelayMs };
}
const traceLog: string[] = [];
function trace(dir: 'tx' | 'rx' | 'ev', label: string, data?: Uint8Array) {
  const hex = data ? ' ' + [...data].map((b) => b.toString(16).padStart(2, '0')).join('') : '';
  traceLog.push(`${(performance.now() / 1000).toFixed(2)} ${dir} ${label}${hex} (${data?.length ?? 0}B)`);
  if (traceLog.length > 400) traceLog.splice(0, traceLog.length - 400);
  const el = document.getElementById('trace');
  if (el) { el.textContent = traceLog.join('\n'); el.scrollTop = el.scrollHeight; }
}
function newController() {
  controller = new DeviceController({ profile: profileFor(settings), onTrace: trace });
  controller.subscribe(renderStatus);
}

// ---------- status & chrome ----------------------------------------------------

function renderStatus() {
  const s = controller.state;
  const el = $('#status');
  const cls = s === 'Ready' ? 'ok' : s === 'Error' ? 'err' : s === 'Disconnected' ? 'muted' : 'busy';
  el.className = `pill ${cls}`;
  const p = controller.progress;
  el.textContent = s === 'Uploading' && p ? `Uploading ${p.sent}/${p.total}` : s === 'Ready' && deviceName ? `Ready: ${deviceName}` : s;
  const err = controller.error;
  const msg = $('#conn-msg', document);
  if (msg) msg.textContent = err ?? '';
  const prog = document.querySelector<HTMLProgressElement>('#progress');
  if (prog && p) { prog.max = p.total; prog.value = p.sent; }
  updateButtons();
}

function updateButtons() {
  const s = controller.state;
  const ready = s === 'Ready';
  const busy = s === 'Selecting' || s === 'Connecting' || s === 'Handshaking' || s === 'Uploading';
  const set = (id: string, v: boolean) => { const b = document.getElementById(id) as HTMLButtonElement | null; if (b) b.disabled = v; };
  set('btn-connect', busy || ready);
  set('btn-disconnect', s === 'Disconnected');
  set('btn-send', !ready || !lastImage);
  set('btn-test-color', !ready); set('btn-test-corner', !ready);
  set('btn-disp-on', !ready); set('btn-disp-off', !ready);
  set('brightness', !ready);
  const cancel = document.getElementById('btn-cancel');
  if (cancel) cancel.hidden = s !== 'Uploading';
  const prog = document.getElementById('progress');
  if (prog) prog.hidden = s !== 'Uploading';
  const label = document.getElementById('btn-connect');
  if (label) label.textContent = s === 'Error' || controller.error ? 'Reconnect' : 'Connect';
}

function banner(html: string | null) {
  const b = $('#banner');
  b.hidden = !html;
  if (html) b.innerHTML = html;
}

// ---------- Connect view ---------------------------------------------------------

function renderConnect() {
  const sup = bluetoothSupport();
  const root = $('#view-connect');
  root.innerHTML = `
    <div class="card">
      <h2>Hat connection</h2>
      ${sup.ok || useMock ? '' : `<p class="bad">${esc(sup.ok ? '' : sup.reason)}</p>`}
      ${useMock ? '<p class="warn">Mock mode: no real hat is used.</p>' : ''}
      <div class="row">
        <button id="btn-connect" class="primary">Connect</button>
        <button id="btn-disconnect">Disconnect</button>
        <button id="btn-install" hidden>Install app</button>
      </div>
      <p id="conn-msg" class="small"></p>
      <p class="small">Close other controller apps first. Android will ask for Bluetooth permission the first time you connect.</p>
      <p class="small" id="install-help" hidden>To install: Chrome menu → Install app / Add to Home screen.</p>
    </div>
    <div class="card">
      <h2>Display</h2>
      <label for="brightness">Dimming level: <b id="bval">${settings.brightness}</b> (0 = brightest, 10 = dimmest) <span id="bstate" class="small">${esc(brightnessNote)}</span></label>
      <input id="brightness" type="range" min="0" max="10" step="1" value="${settings.brightness}" />
      <p class="small">Mapping and "dimmest ≠ off" are unverified on this hat. Start dim for the first tests.</p>
      <div class="row"><button id="btn-disp-on">Display on</button><button id="btn-disp-off">Display off</button><span id="dstate" class="small">${esc(displayNote)}</span></div>
    </div>
    <div class="card">
      <h2>Test patterns (dim, static)</h2>
      <div class="row"><button id="btn-test-color">Solid red</button><button id="btn-test-corner">Corner test</button></div>
      <p class="small">Corner test: red top-left (double width), green top-right, blue bottom-left, white bottom-right.</p>
    </div>
    <div class="card">
      <h2>Protocol log</h2>
      <div class="row"><button id="btn-copylog">Copy log</button><button id="btn-clearlog">Clear</button></div>
      <pre id="trace" class="small" style="max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all">${esc(traceLog.join('\n'))}</pre>
    </div>
    <div class="card">
      <h2>Device settings</h2>
      ${settings.dimensionsVerified ? '' : '<p class="warn">Dimensions are unverified defaults (this hat: 32×16). Confirm on the hat before trusting them.</p>'}
      <div class="row">
        <div><label for="s-w">Width</label><input id="s-w" type="number" min="1" max="256" value="${settings.width}" /></div>
        <div><label for="s-h">Height</label><input id="s-h" type="number" min="1" max="256" value="${settings.height}" /></div>
      </div>
      <label for="s-rot">Rotation</label>
      <select id="s-rot">${[0, 90, 180, 270].map((r) => `<option ${r === settings.transform.rotation ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <label><input type="checkbox" id="s-mh" ${settings.transform.mirrorH ? 'checked' : ''}/> Mirror horizontally</label>
      <label><input type="checkbox" id="s-mv" ${settings.transform.mirrorV ? 'checked' : ''}/> Mirror vertically</label>
      <label><input type="checkbox" id="s-ver" ${settings.dimensionsVerified ? 'checked' : ''}/> Dimensions verified on my hat</label>
      <div class="row">
        <div><label for="s-chunk">Chunk bytes (spike: 8)</label><input id="s-chunk" type="number" min="1" max="512" value="${settings.chunkSize}" /></div>
        <div><label for="s-delay">Write delay ms</label><input id="s-delay" type="number" min="0" max="1000" value="${settings.interWriteDelayMs}" /></div>
      </div>
      <p class="small">Chunk size and delay apply on the next connection. Only raise them after testing on the hat.</p>
    </div>`;

  $('#btn-connect').onclick = onConnect;
  $('#btn-copylog').onclick = () => navigator.clipboard?.writeText(traceLog.join('\n'));
  $('#btn-clearlog').onclick = () => { traceLog.length = 0; $('#trace').textContent = ''; };
  $('#btn-disconnect').onclick = () => controller.disconnect();
  $('#btn-test-color').onclick = () => sendImage(solid(settings.width, settings.height, [255, 0, 0]));
  $('#btn-test-corner').onclick = () => sendImage(physical(cornerTest(...logicalDims())));
  $('#btn-disp-on').onclick = () => control('display', () => controller.setDisplay(true), (n) => (displayNote = n), 'dstate', 'On');
  $('#btn-disp-off').onclick = () => control('display', () => controller.setDisplay(false), (n) => (displayNote = n), 'dstate', 'Off');
  let timer: ReturnType<typeof setTimeout>;
  const slider = $<HTMLInputElement>('#brightness');
  slider.oninput = () => {
    const level = Number(slider.value);
    $('#bval').textContent = String(level);
    $('#bstate').textContent = 'pending…';
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await control('brightness', () => controller.setBrightness(level), (n) => (brightnessNote = n), 'bstate', 'confirmed');
      settings = { ...settings, brightness: level };
      persistSettings();
    }, 300);
  };
  const readSettings = () => {
    settings = {
      ...settings,
      width: clampInt($<HTMLInputElement>('#s-w').value, 1, 256, settings.width),
      height: clampInt($<HTMLInputElement>('#s-h').value, 1, 256, settings.height),
      chunkSize: clampInt($<HTMLInputElement>('#s-chunk').value, 1, 512, settings.chunkSize),
      interWriteDelayMs: clampInt($<HTMLInputElement>('#s-delay').value, 0, 1000, settings.interWriteDelayMs),
      dimensionsVerified: $<HTMLInputElement>('#s-ver').checked,
      transform: {
        rotation: Number($<HTMLSelectElement>('#s-rot').value) as 0 | 90 | 180 | 270,
        mirrorH: $<HTMLInputElement>('#s-mh').checked, mirrorV: $<HTMLInputElement>('#s-mv').checked,
      },
    };
    persistSettings();
    void refreshPreview();
  };
  root.querySelectorAll('#s-w,#s-h,#s-rot,#s-mh,#s-mv,#s-ver,#s-chunk,#s-delay').forEach((e) => e.addEventListener('change', readSettings));
  renderStatus();
}

const clampInt = (v: string, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

function persistSettings() {
  saveSettings(settings).catch((e) => banner(`<b>Could not save settings:</b> ${esc(String(e.message ?? e))}`));
}

async function onConnect() {
  newController();
  deviceName = '';
  await controller.connect(async () => {
    if (useMock) { deviceName = 'mock'; return new MockTransport(); }
    const sup = bluetoothSupport();
    if (!sup.ok) throw new Error(sup.reason);
    const r = await connectWebBluetooth();
    deviceName = r.deviceName;
    return r.transport;
  });
  renderStatus();
}

async function control(_k: string, op: () => Promise<'confirmed' | 'sent-unconfirmed'>, store: (n: string) => void, id: string, okText: string) {
  const el = document.getElementById(id);
  try {
    const r = await op();
    store(r === 'confirmed' ? okText : 'sent, not confirmed');
  } catch (e) {
    store(e instanceof DeviceError ? e.message : 'failed');
  }
  const t = document.getElementById(id);
  if (t) t.textContent = id === 'bstate' ? brightnessNote : displayNote;
  void el;
}

// ---------- Create view ----------------------------------------------------------

function logicalDims(): [number, number] {
  const swap = settings.transform.rotation === 90 || settings.transform.rotation === 270;
  return swap ? [settings.height, settings.width] : [settings.width, settings.height];
}
/** Apply mirror/rotation so the output is exactly the physical width x height. */
function physical(img: RgbImage): RgbImage { return transformImage(img, settings.transform); }

function renderCreate() {
  $('#view-create').innerHTML = `
    <div class="card">
      <label for="c-kind">Content</label>
      <select id="c-kind"><option value="text">Text</option><option value="solid">Solid color</option><option value="image">Image (PNG/JPEG/GIF)</option></select>
      <div id="c-text">
        <label for="c-str">Text</label><input id="c-str" type="text" maxlength="200" value="HI" />
        <label for="c-speed">Scroll speed (when text is too wide): <b id="c-speed-val">${DEFAULT_SPEED}</b></label>
        <input id="c-speed" type="range" min="1" max="10" step="1" value="${DEFAULT_SPEED}" />
        <p id="c-warn" class="warn small"></p>
      </div>
      <div class="row">
        <div><label for="c-fg">Color</label><input id="c-fg" type="color" value="#ffffff" /></div>
        <div><label for="c-bg">Background</label><input id="c-bg" type="color" value="#000000" /></div>
      </div>
      <div id="c-image" hidden>
        <label for="c-file">Image file</label><input id="c-file" type="file" accept="image/png,image/jpeg,image/gif" />
        <label for="c-fit">Fit</label><select id="c-fit"><option>contain</option><option>cover</option><option>stretch</option></select>
        <p class="small">Transparent areas are filled with the background color.</p>
      </div>
      <p id="c-err" class="bad small"></p>
      <canvas id="preview" aria-label="Pixel preview"></canvas>
      <div class="row"><button id="btn-send" class="primary" disabled>Send to hat</button><button id="btn-cancel" class="danger" hidden>Cancel</button></div>
      <progress id="progress" hidden value="0" max="1"></progress>
      <p id="send-note" class="small">${esc(sendNote)}</p>
      <div class="row"><input id="c-name" type="text" placeholder="Preset name" maxlength="60" style="flex:1" /><button id="btn-save">Save preset</button></div>
    </div>`;
  $('#c-kind').onchange = () => { syncKind(); void refreshPreview(); };
  ['#c-str', '#c-fg', '#c-bg', '#c-fit', '#c-speed'].forEach((s) => ($(s).oninput = () => void refreshPreview()));
  $<HTMLInputElement>('#c-file').onchange = async (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    $('#c-err').textContent = '';
    try { imageDataUrl = f.type === 'image/gif' ? await gifDataUrl(f) : await shrinkForStorage(f); imageBlob = f; } catch (e) { imageBlob = null; imageDataUrl = ''; $('#c-err').textContent = (e as Error).message; }
    void refreshPreview();
  };
  $<HTMLInputElement>('#c-speed').addEventListener('input', (e) => { $('#c-speed-val').textContent = (e.target as HTMLInputElement).value; });
  $('#btn-send').onclick = () => (lastFrames ? sendMarquee(lastFrames, lastDelays) : lastImage && sendImage(lastImage));
  $('#btn-cancel').onclick = () => controller.cancelUpload();
  $('#btn-save').onclick = savePresetClick;
  syncKind();
  void refreshPreview();
  updateButtons();
}

function syncKind() {
  const k = $<HTMLSelectElement>('#c-kind').value;
  $('#c-text').hidden = k !== 'text';
  $('#c-image').hidden = k !== 'image';
}

function currentContent(): Content {
  const k = $<HTMLSelectElement>('#c-kind').value;
  const fg = $<HTMLInputElement>('#c-fg').value, bg = $<HTMLInputElement>('#c-bg').value;
  if (k === 'solid') return { kind: 'solid', color: fg };
  if (k === 'text') return { kind: 'text', text: $<HTMLInputElement>('#c-str').value, fg, bg, speed: Number($<HTMLInputElement>('#c-speed').value) };
  if (!imageDataUrl) throw new Error('Choose an image first.');
  return { kind: 'image', dataUrl: imageDataUrl, fit: $<HTMLSelectElement>('#c-fit').value as Fit, bg };
}

async function renderContent(c: Content): Promise<{ image: RgbImage; frames?: RgbImage[]; delays?: number[]; warnings: string[] }> {
  const [w, h] = logicalDims();
  if (c.kind === 'solid') return { image: physical(solid(w, h, parseHexColor(c.color))), warnings: [] };
  if (c.kind === 'text') {
    await ensureFont();
    const r = renderText(c.text, w, h, parseHexColor(c.fg), parseHexColor(c.bg));
    if (r.clipped) { // too wide for the display: scroll it instead
      const m = renderMarquee(c.text, w, h, parseHexColor(c.fg), parseHexColor(c.bg));
      const frames = m.frames.map(physical);
      const warnings = m.unsupported.length ? [`Unsupported characters skipped: ${m.unsupported.join(' ')}`] : [];
      return { image: frames[0]!, frames, delays: frames.map(() => marqueeDelay(c.speed ?? DEFAULT_SPEED)), warnings };
    }
    const warnings: string[] = [];
    if (r.unsupported.length) warnings.push(`Unsupported characters skipped: ${r.unsupported.join(' ')}`);
    return { image: physical(r.image), warnings };
  }
  const blob = imageBlob ?? (await (await fetch(c.dataUrl)).blob());
  if (blob.type === 'image/gif') {
    const g = await gifToFrames(blob, w, h, c.fit, parseHexColor(c.bg));
    const frames = g.frames.map(physical);
    return frames.length > 1 ? { image: frames[0]!, frames, delays: g.delays, warnings: [] } : { image: frames[0]!, warnings: [] };
  }
  return { image: physical(await imageToMatrix(blob, w, h, c.fit, parseHexColor(c.bg))), warnings: [] };
}

async function refreshPreview(content?: Content) {
  const seq = ++renderSeq;
  const canvas = document.getElementById('preview') as HTMLCanvasElement | null;
  if (!canvas) return;
  try {
    const { image, frames, delays, warnings } = await renderContent(content ?? currentContent());
    if (seq !== renderSeq) return;
    lastImage = image;
    lastFrames = frames ?? null;
    lastDelays = delays ?? [];
    clearTimeout(previewTimer);
    drawPreview(canvas, image);
    if (frames) {
      let i = 0;
      const tick = () => {
        drawPreview(canvas, frames[i % frames.length]!);
        previewTimer = setTimeout(tick, delays?.[i % frames.length] ?? 100);
        i++;
      };
      tick();
    }
    $('#c-warn').textContent = warnings.join(' ');
    $('#c-err').textContent = '';
  } catch (e) {
    if (seq !== renderSeq) return;
    lastImage = null; lastFrames = null;
    clearTimeout(previewTimer);
    $('#c-err').textContent = (e as Error).message;
  }
  updateButtons();
}

async function sendImage(img: RgbImage) {
  if (img.width * img.height !== settings.width * settings.height) { banner('Image does not match the configured display size.'); return; }
  lastImage = img; // retained so an interrupted upload can be resent after reconnect
  sendNote = 'Sending…';
  setNote();
  try {
    const r = await controller.upload(img);
    sendNote = r === 'confirmed' ? 'Upload confirmed.' : 'Sent, not confirmed.';
  } catch (e) {
    sendNote = e instanceof DeviceError && e.kind === 'cancelled' ? 'Upload cancelled.' : `Upload unconfirmed: ${(e as Error).message}`;
  }
  setNote();
}
async function sendMarquee(frames: RgbImage[], delays: number[]) {
  sendNote = 'Sending animation…';
  setNote();
  try {
    const gif = encodeGif(frames, delays);
    const r = await controller.uploadGif(gif, settings.width, settings.height);
    sendNote = r === 'confirmed' ? 'Animation upload confirmed.' : 'Sent, not confirmed.';
  } catch (e) {
    sendNote = e instanceof DeviceError && e.kind === 'cancelled' ? 'Upload cancelled.' : `Upload failed: ${(e as Error).message}`;
  }
  setNote();
}
async function gifDataUrl(f: File): Promise<string> {
  if (f.size > MAX_GIF_STORE_BYTES) throw new Error('GIF is too large (limit 1 MB).');
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/gif;base64,${btoa(bin)}`;
}
function setNote() { const n = document.getElementById('send-note'); if (n) n.textContent = sendNote; }

async function savePresetClick() {
  const name = $<HTMLInputElement>('#c-name').value.trim();
  if (!name) { $('#c-err').textContent = 'Enter a preset name.'; return; }
  try {
    await savePreset({ id: crypto.randomUUID(), name, content: currentContent(), updatedAt: Date.now() });
    $('#c-err').textContent = '';
    $<HTMLInputElement>('#c-name').value = '';
    sendNote = `Saved "${name}".`; setNote();
  } catch (e) { $('#c-err').textContent = (e as Error).message; }
}

// ---------- Presets view ---------------------------------------------------------

async function renderPresets() {
  const root = $('#view-presets');
  let presets: Preset[] = [];
  let err = '';
  try { presets = await listPresets(); } catch (e) { err = (e as Error).message; }
  root.innerHTML = `
    <div class="card">
      <h2>Presets</h2>
      ${err ? `<p class="bad">${esc(err)}</p>` : ''}
      <ul class="list">${presets.map((p) => `<li data-id="${esc(p.id)}"><span>${esc(p.name)} <small class="muted">${p.content.kind}</small></span><button data-act="load">Load</button><button data-act="del" class="danger">Delete</button></li>`).join('') || '<li class="muted">No presets yet.</li>'}</ul>
    </div>
    <div class="card">
      <h2>Backup</h2>
      <div class="row"><button id="btn-export">Export JSON</button><label class="row"><span>Import</span><input id="p-import" type="file" accept="application/json,.json" /></label></div>
      <p id="p-msg" class="small"></p>
      <p id="p-persist" class="small"></p>
    </div>`;
  root.querySelectorAll<HTMLButtonElement>('li button').forEach((b) => b.onclick = async () => {
    const id = b.closest('li')!.dataset.id!;
    const p = presets.find((x) => x.id === id)!;
    if (b.dataset.act === 'del') { await deletePreset(id).catch((e) => ($('#p-msg').textContent = e.message)); void renderPresets(); return; }
    imageBlob = null;
    if (p.content.kind === 'image') imageDataUrl = p.content.dataUrl;
    try {
      const { image } = await renderContent(p.content);
      lastImage = image;
      showTab('create');
      setCreateFrom(p.content);
      await refreshPreview(p.content);
    } catch (e) { $('#p-msg').textContent = (e as Error).message; }
  });
  $('#btn-export').onclick = async () => {
    try {
      const blob = new Blob([exportJson(settings, await listPresets())], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'led-hat-presets.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { $('#p-msg').textContent = (e as Error).message; }
  };
  $<HTMLInputElement>('#p-import').onchange = async (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      if (f.size > 4 * 1024 * 1024) throw new Error('Import file is too large.');
      const data = parseImport(await f.text()); // all-or-nothing validation
      await replaceAllPresets(data.presets);
      settings = data.settings;
      await saveSettings(settings);
      $('#p-msg').textContent = `Imported ${data.presets.length} presets. Restart the connection to apply transport settings.`;
      void renderPresets();
    } catch (e) { $('#p-msg').textContent = `Import failed: ${(e as Error).message}`; }
  };
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $('#p-persist').textContent = persisted ? 'Storage is marked persistent.' : 'Storage may be cleared by the browser. Export a backup regularly.';
}

function setCreateFrom(c: Content) {
  $<HTMLSelectElement>('#c-kind').value = c.kind;
  syncKind();
  if (c.kind === 'solid') $<HTMLInputElement>('#c-fg').value = c.color;
  if (c.kind === 'text') { $<HTMLInputElement>('#c-str').value = c.text; $<HTMLInputElement>('#c-fg').value = c.fg; $<HTMLInputElement>('#c-bg').value = c.bg; $<HTMLInputElement>('#c-speed').value = String(c.speed ?? DEFAULT_SPEED); $('#c-speed-val').textContent = $<HTMLInputElement>('#c-speed').value; }
  if (c.kind === 'image') { $<HTMLInputElement>('#c-bg').value = c.bg; $<HTMLSelectElement>('#c-fit').value = c.fit; }
}

// ---------- tabs, offline, install, updates ---------------------------------------

function showTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('nav button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  for (const v of ['connect', 'create', 'presets']) $(`#view-${v}`).hidden = v !== name;
  if (name === 'presets') void renderPresets();
}

function setupPwa() {
  const offline = $('#offline');
  const updateSW = registerSW({
    onOfflineReady() { offline.textContent = 'Ready for offline use'; offline.className = 'pill ok'; },
    onNeedRefresh() {
      const show = () => {
        if (controller.state === 'Uploading') { setTimeout(show, 2000); return; } // never reload mid-transfer
        banner('A new version is available. <button id="btn-update" class="primary">Update</button>');
        $('#btn-update').onclick = () => { if (controller.state !== 'Uploading') void updateSW(true); };
      };
      show();
    },
    onRegisterError(e) { offline.textContent = 'Offline cache failed'; offline.className = 'pill err'; console.error(e); },
  });
  navigator.serviceWorker?.ready.then(() => {
    if (offline.textContent === 'Checking offline…') offline.textContent = 'Caching for offline…';
  }).catch(() => undefined);

  let deferred: (Event & { prompt: () => Promise<void> }) | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as typeof deferred;
    const b = document.getElementById('btn-install');
    if (b) { b.hidden = false; b.onclick = () => deferred?.prompt(); }
  });
  if (!window.matchMedia('(display-mode: standalone)').matches)
    setTimeout(() => { const h = document.getElementById('install-help'); if (h && !deferred) h.hidden = false; }, 1500);
}

async function main() {
  try { settings = await loadSettings(); } catch (e) { settings = DEFAULT_SETTINGS; banner(`<b>Storage unavailable:</b> ${esc((e as Error).message)}. Presets cannot be saved.`); }
  newController();
  renderConnect();
  renderCreate();
  document.querySelectorAll<HTMLButtonElement>('nav button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab!)));
  setupPwa();
  void requestPersistence();
}
void main();
