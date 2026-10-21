import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { DeviceController, DeviceError } from '../controller/deviceController';
import type { RgbImage } from '../protocol/framing';
import { imageToMatrix, shrinkForStorage, type Fit } from '../render/image';
import { cornerTest, drawPreview, parseHexColor, solid, transformImage } from '../render/matrix';
import { encodeGif, gifNonce } from '../render/gif';
import { gifToFrames, MAX_GIF_STORE_BYTES } from '../render/gifDecode';
import { ensureFont, renderMarquee, renderText, setTextFont } from '../render/text';
import { DEFAULT_TEXT_FONT, TEXT_FONTS, isTextFont } from '../render/fonts';
import { deletePreset, listPresets, loadKv, loadSettings, restoreBackup, requestPersistence, saveKv, savePreset, saveSettings } from '../storage/db';
import {
  DEFAULT_SETTINGS, DEFAULT_SPEED, DEFAULT_STEP_SECONDS, MAX_SEQUENCE_STEPS, MAX_STEP_SECONDS, isGroupPreset, validateContent, validateSequenceSteps,
  type Content, type Preset, type SequenceStep, type Settings, type SingleContent,
} from '../storage/presets';
import { composeSequence } from '../render/sequence';
import { exportSelectedJson, mergeSharedPresets, parseSharedBackup, type ShareSelection } from '../storage/sharedBackup';
import { MockTransport } from '../transport/mock';
import { SPIKE_PROFILE, type TransportProfile } from '../transport/types';
import { bluetoothSupport, connectWebBluetooth } from '../transport/webBluetooth';
import { chooseNativeCap, connectNativeCap, readCapRssi, startNativeScan, stopNativeScan } from '../transport/nativeBle';
import { isNativeApp, platformName } from '../platform';
import { applyGroupContent, applyImportedApproachSettings, getApproachSettings, approachRunning, connectAsPrimary, createContentChanged, disconnectPrimary, initApproach, renderApproach, sharePeers, shareIdentity, textFontChanged, type PrimaryCap } from '../approach/ui';
import { listenForShares, withShareLink } from '../approach/contentExchange';
import { sendPreset, ShareState, type ShareKind, type ShareReceiver } from '../approach/presetShare';
import { shareTextFile } from './shareFile';
import { initTabs } from './tabs';
import { GreetingUi } from '../scanner/ui';
import { SoundUi } from '../sound/ui';
import { UpdateUi } from '../update/ui';
import { GitHubUi } from '../github/ui';

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let settings: Settings;
let controller: DeviceController;
let deviceName = '';
const native = isNativeApp();
let useMock = location.hash === '#mock'; // dev/test only: in-memory hat
const approachAvailable = native || useMock;
let lastImage: RgbImage | null = null; // retained across disconnects
let lastFrames: RgbImage[] | null = null; // set when the content is a marquee
let lastDelays: number[] = [];
let previewTimer: ReturnType<typeof setTimeout> | undefined;
/** Scroll speed 1 (slow) .. 10 (fast) -> per-frame delay at 2 px per frame. */
const marqueeDelay = (speed: number) => Math.round(220 / speed);
let sendNote = '';
let brightnessNote = '';
let brightnessTimer: ReturnType<typeof setTimeout> | undefined;
let displayNote = '';
let imageDataUrl = '';
let renderSeq = 0;
let savedCreateContent: Content | undefined;
/** Connect tab sequence steps; kept as a draft while `sequenceOn` is false. */
let sequence: SequenceStep[] = [];
let sequenceOn = false;
let scanner: GreetingUi | undefined;
let sound: SoundUi | undefined;
let github: GitHubUi | undefined;

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
/** In the app (and mock mode) the Connect tab's cap is cap 1 of approach mode: one shared connection. */
const sharedCap = () => native || useMock;
const watched = new WeakSet<DeviceController>();
function onPrimaryChange(p: PrimaryCap | null) {
  scanner?.stopCamera();
  void sound?.stop();
  if (p) {
    controller = p.controller;
    deviceName = p.name;
    if (!watched.has(controller)) { watched.add(controller); controller.subscribe(renderStatus); }
  } else {
    newController();
    deviceName = '';
  }
  renderStatus();
}

// ---------- status & chrome ----------------------------------------------------

function renderStatus() {
  const s = controller.state;
  const el = $('#status');
  if (!el) return;
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
  scanner?.updateStatus();
  sound?.updateStatus();
  github?.updateStatus();
}

function updateButtons() {
  const s = controller.state;
  const ready = s === 'Ready' && !controller.temporaryActive;
  const busy = s === 'Selecting' || s === 'Connecting' || s === 'Handshaking' || s === 'Uploading';
  const set = (id: string, v: boolean) => { const b = document.getElementById(id) as HTMLButtonElement | null; if (b) b.disabled = v; };
  set('btn-connect', busy || ready || controller.temporaryActive);
  set('btn-disconnect', s === 'Disconnected');
  set('btn-send', !ready || !lastImage);
  const help = document.getElementById('send-help');
  if (help) help.textContent = controller.temporaryActive ? 'Wait for the current cap reaction to finish before sending.'
    : !ready ? 'Connect your hat above to send content. You can edit and preview offline.'
    : !lastImage ? 'Choose valid content to enable sending.' : 'Preview ready. Send it to your connected hat.';
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
  const sup: ReturnType<typeof bluetoothSupport> = native ? { ok: true } : bluetoothSupport();
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
      <p class="small">Close other controller apps first. ${native ? `${platformName() === 'ios' ? 'iOS' : 'Android'} will ask for Bluetooth permission the first time you connect.` : 'Choose your hat in the browser Bluetooth picker. Connecting requires Web Bluetooth; editing and presets work offline.'}</p>
      <p class="small" id="install-help" hidden>To install: use your browser's Install app or Add to Home Screen option (in Safari, open the Share menu).</p>
    </div>
    <div id="content-editor"></div>
    <div id="github-section"></div>`;
  $('#btn-connect').onclick = onConnect;
  $('#btn-disconnect').onclick = () => (sharedCap() ? disconnectPrimary() : controller.disconnect());
  renderStatus();
}

function renderDeviceSettings() {
  clearTimeout(brightnessTimer);
  const root = $('#settings-device');
  root.innerHTML = `
    <div class="card">
      <h2>Display</h2>
      <label for="s-font">LED text font</label>
      <select id="s-font" aria-describedby="s-font-help">${TEXT_FONTS.map((f) => `<option value="${f.id}" ${f.id === (settings.textFont ?? DEFAULT_TEXT_FONT) ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
      <p id="s-font-help" class="small">Applies to all LED text: Connect, sequences, Approach, Scan greetings and Sound reactions. Tiny5 and Bitcount use crisp 2x pixel sizes; Bitcount fills all 16 rows. The other fonts use their native size. Letters have a one-pixel gap and emoji a two-pixel gap. Send again to update Connect content already on the hat.</p>
      <canvas id="font-preview" width="32" height="16" role="img" aria-label="LED font sample: Hi!"></canvas>
      <label for="brightness">Dimming level: <b id="bval">${settings.brightness}</b> (0 = brightest, 10 = dimmest) <span id="bstate" class="small">${esc(brightnessNote)}</span></label>
      <input id="brightness" type="range" min="0" max="10" step="1" value="${settings.brightness}" />
      <p class="small">Mapping and "dimmest ≠ off" are unverified on this hat. Start dim for the first tests.</p>
      <div class="row"><button id="btn-disp-on">Display on</button><button id="btn-disp-off">Display off</button><span id="dstate" class="small">${esc(displayNote)}</span></div>
    </div>
    <details class="card">
      <summary>Test patterns (dim, static)</summary>
      <div class="row"><button id="btn-test-color">Solid red</button><button id="btn-test-corner">Corner test</button></div>
      <p class="small">Corner test: red top-left (double width), green top-right, blue bottom-left, white bottom-right.</p>
    </details>
    <details class="card">
      <summary>Protocol log</summary>
      <div class="row"><button id="btn-copylog">Copy log</button><button id="btn-clearlog">Clear</button></div>
      <pre id="trace" class="small" style="max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all">${esc(traceLog.join('\n'))}</pre>
    </details>
    <div class="card">
      <h2>Device settings</h2>
      <label for="s-rot">Rotation</label>
      <select id="s-rot">${[0, 90, 180, 270].map((r) => `<option ${r === settings.transform.rotation ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <label><input type="checkbox" id="s-mh" ${settings.transform.mirrorH ? 'checked' : ''}/> Mirror horizontally</label>
      <label><input type="checkbox" id="s-mv" ${settings.transform.mirrorV ? 'checked' : ''}/> Mirror vertically</label>
      <div class="form-grid">
        <div><label for="s-chunk">Chunk bytes</label><input id="s-chunk" type="number" min="1" max="512" value="${settings.chunkSize}" /></div>
        <div><label for="s-delay">Write delay ms</label><input id="s-delay" type="number" min="0" max="1000" value="${settings.interWriteDelayMs}" /></div>
      </div>
      <p class="small">Chunk size and delay apply on the next connection. Only raise them after testing on the hat.</p>
    </div>`;

  $('#btn-copylog').onclick = () => navigator.clipboard?.writeText(traceLog.join('\n'));
  $('#btn-clearlog').onclick = () => { traceLog.length = 0; $('#trace').textContent = ''; };
  $('#btn-test-color').onclick = () => sendImage(solid(settings.width, settings.height, [255, 0, 0]));
  $('#btn-test-corner').onclick = () => sendImage(physical(cornerTest(...logicalDims())));
  $('#btn-disp-on').onclick = () => control('display', () => controller.setDisplay(true), (n) => (displayNote = n), 'dstate', 'On');
  $('#btn-disp-off').onclick = () => control('display', () => controller.setDisplay(false), (n) => (displayNote = n), 'dstate', 'Off');
  void refreshFontSample().catch((e: unknown) => banner(`<b>Could not preview LED text font:</b> ${esc(String(e))}`));
  const slider = $<HTMLInputElement>('#brightness');
  slider.oninput = () => {
    const level = Number(slider.value);
    settings = { ...settings, brightness: level };
    $('#bval').textContent = String(level);
    $('#bstate').textContent = 'pending…';
    clearTimeout(brightnessTimer);
    brightnessTimer = setTimeout(async () => {
      await control('brightness', () => controller.setBrightness(level), (n) => (brightnessNote = n), 'bstate', 'confirmed');
      persistSettings();
    }, 300);
  };
  const readSettings = () => {
    const font = $<HTMLSelectElement>('#s-font').value;
    if (!isTextFont(font)) { banner('<b>Invalid LED text font.</b>'); return; }
    const fontChanged = font !== (settings.textFont ?? DEFAULT_TEXT_FONT);
    settings = {
      ...settings,
      textFont: font,
      chunkSize: clampInt($<HTMLInputElement>('#s-chunk').value, 1, 512, settings.chunkSize),
      interWriteDelayMs: clampInt($<HTMLInputElement>('#s-delay').value, 0, 1000, settings.interWriteDelayMs),
      transform: {
        rotation: Number($<HTMLSelectElement>('#s-rot').value) as 0 | 90 | 180 | 270,
        mirrorH: $<HTMLInputElement>('#s-mh').checked, mirrorV: $<HTMLInputElement>('#s-mv').checked,
      },
    };
    setTextFont(font);
    persistSettings();
    if (fontChanged) {
      textFontChanged();
      void refreshFontSample().catch((e: unknown) => banner(`<b>Could not preview LED text font:</b> ${esc(String(e))}`));
    }
    void refreshPreview();
    github?.refreshPreview();
  };
  root.querySelectorAll('#s-font,#s-rot,#s-mh,#s-mv,#s-chunk,#s-delay').forEach((e) => e.addEventListener('change', readSettings));
  renderStatus();
}

async function refreshFontSample() {
  await ensureFont();
  const canvas = document.getElementById('font-preview') as HTMLCanvasElement | null;
  if (canvas) drawPreview(canvas, renderText('Hi!', 32, 16, [255, 255, 255], [0, 0, 0]).image);
}

const clampInt = (v: string, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

function persistSettings() {
  saveSettings(settings).catch((e) => banner(`<b>Could not save settings:</b> ${esc(String(e.message ?? e))}`));
}

async function onConnect() {
  if (sharedCap()) {
    try {
      const d = useMock ? { deviceId: `mock-${Date.now().toString(36)}`, name: 'iledcolor-MOCK' } : await chooseNativeCap();
      await connectAsPrimary(d.deviceId, d.name);
    } catch (e) {
      if ((e as Error).name !== 'SelectionCancelledError') { const m = document.getElementById('conn-msg'); if (m) m.textContent = (e as Error).message; }
    }
    renderStatus();
    return;
  }
  newController();
  deviceName = '';
  await controller.connect(async () => {
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
  $('#content-editor').innerHTML = `
    <div class="card">
      <h2>Create content</h2>
      <label for="c-kind">Content</label>
      <select id="c-kind"><option value="text">Text</option><option value="solid">Solid color</option><option value="image">Image (PNG/JPEG/GIF)</option></select>
      <div id="c-text">
        <label for="c-str">Text</label><input id="c-str" type="text" maxlength="200" value="HI" />
        <label for="c-speed">Scroll speed: <b id="c-speed-val">${DEFAULT_SPEED}</b></label>
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
      <section class="sequence" aria-labelledby="c-seq-title">
        <h3 id="c-seq-title">Sequence</h3>
        <p class="small">Add the content above or saved presets as steps. The hat plays all steps in order, then loops.</p>
        <ol id="c-seq-list" class="seq-list"></ol>
        <div class="row"><button id="btn-seq-add">Add current content</button></div>
        <div class="row"><select id="c-seq-preset" aria-label="Saved preset to add"></select><button id="btn-seq-add-preset">Add preset</button></div>
        <label class="seq-toggle"><input type="checkbox" id="c-seq-on" /> Play sequence</label>
        <p id="c-seq-help" class="small"></p>
      </section>
      <p id="c-err" class="bad small"></p>
      <canvas id="preview" aria-label="Pixel preview"></canvas>
      <div class="row"><button id="btn-send" class="primary" disabled>Send to hat</button><button id="btn-cancel" class="danger" hidden>Cancel</button></div>
      <p id="send-help" class="small"></p>
      <progress id="progress" aria-label="Content upload progress" hidden value="0" max="1"></progress>
      <p id="send-note" class="small" role="status">${esc(sendNote)}</p>
      <label for="c-name">Preset name</label>
      <div class="row preset-save"><input id="c-name" type="text" placeholder="e.g. My greeting" maxlength="60" /><button id="btn-save">Save preset</button></div>
    </div>`;
  $('#c-kind').onchange = () => { syncKind(); void refreshPreview(); };
  ['#c-str', '#c-fg', '#c-bg', '#c-fit', '#c-speed'].forEach((s) => ($(s).oninput = () => void refreshPreview()));
  $<HTMLInputElement>('#c-file').onchange = async (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    $('#c-err').textContent = '';
    try { imageDataUrl = f.type === 'image/gif' ? await gifDataUrl(f) : await shrinkForStorage(f); } catch (e) { imageDataUrl = ''; $('#c-err').textContent = (e as Error).message; }
    void refreshPreview();
  };
  $<HTMLInputElement>('#c-speed').addEventListener('input', (e) => { $('#c-speed-val').textContent = (e.target as HTMLInputElement).value; });
  $('#btn-send').onclick = () => (lastFrames ? sendMarquee(lastFrames, lastDelays) : lastImage && sendImage(lastImage));
  $('#btn-cancel').onclick = () => controller.cancelUpload();
  $('#btn-save').onclick = savePresetClick;
  $('#btn-seq-add').onclick = () => {
    try { addSequenceSteps([{ content: editorContent(), seconds: DEFAULT_STEP_SECONDS }]); } catch (e) { $('#c-err').textContent = (e as Error).message; }
  };
  $('#btn-seq-add-preset').onclick = async () => {
    const id = $<HTMLSelectElement>('#c-seq-preset').value;
    try {
      const p = (await listPresets()).find((x) => x.id === id);
      if (!p || isGroupPreset(p)) throw new Error('Choose a saved content preset.');
      addSequenceSteps(p.content.kind === 'sequence' ? structuredClone(p.content.steps) : [{ content: p.content, seconds: DEFAULT_STEP_SECONDS }]);
    } catch (e) { $('#c-err').textContent = (e as Error).message; }
  };
  $<HTMLInputElement>('#c-seq-on').onchange = (e) => { sequenceOn = (e.target as HTMLInputElement).checked && sequence.length > 0; renderSequence(); void refreshPreview(); };
  syncKind();
  if (savedCreateContent) {
    if (savedCreateContent.kind === 'image') imageDataUrl = savedCreateContent.dataUrl;
    setCreateFrom(savedCreateContent);
  }
  renderSequence();
  void refreshSequencePresets();
  void refreshPreview();
  updateButtons();
}

// ---------- Sequence editor ---------------------------------------------------------

const stepLabel = (c: SingleContent) => c.kind === 'text' ? `Text "${c.text}"` : c.kind === 'solid' ? `Solid ${c.color}` : 'Image';

function renderSequence() {
  const list = document.getElementById('c-seq-list');
  if (!list) return;
  const last = sequence.length - 1;
  list.innerHTML = sequence.map((s, i) => `
    <li data-index="${i}">
      <span class="seq-label">${i + 1}. ${esc(stepLabel(s.content))}</span>
      <label class="seq-seconds">Seconds <input type="number" data-act="sec" min="1" max="${MAX_STEP_SECONDS}" value="${s.seconds}" aria-label="Seconds for step ${i + 1}" /></label>
      <button data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move step ${i + 1} up">↑</button>
      <button data-act="down" ${i === last ? 'disabled' : ''} aria-label="Move step ${i + 1} down">↓</button>
      <button data-act="del" class="danger" aria-label="Remove step ${i + 1}">✕</button>
    </li>`).join('') || '<li class="muted">No steps yet.</li>';
  list.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => b.onclick = () => {
    const i = Number(b.closest('li')!.dataset.index);
    const j = b.dataset.act === 'up' ? i - 1 : i + 1;
    if (b.dataset.act === 'del') sequence.splice(i, 1);
    else [sequence[i], sequence[j]] = [sequence[j]!, sequence[i]!];
    sequenceChanged();
  });
  list.querySelectorAll<HTMLInputElement>('input[data-act=sec]').forEach((inp) => inp.onchange = () => {
    const i = Number(inp.closest('li')!.dataset.index);
    sequence[i]!.seconds = clampInt(inp.value, 1, MAX_STEP_SECONDS, sequence[i]!.seconds);
    inp.value = String(sequence[i]!.seconds);
    sequenceChanged();
  });
  const on = $<HTMLInputElement>('#c-seq-on');
  on.checked = sequenceOn;
  on.disabled = !sequence.length;
  $<HTMLButtonElement>('#btn-seq-add').disabled = sequence.length >= MAX_SEQUENCE_STEPS;
  $<HTMLButtonElement>('#btn-seq-add-preset').disabled = sequence.length >= MAX_SEQUENCE_STEPS || !$<HTMLSelectElement>('#c-seq-preset').value;
  $('#c-seq-help').textContent = sequenceOn
    ? `Playing ${sequence.length} step${sequence.length === 1 ? '' : 's'}: preview, send and save use all steps. Edits above compose the next step; add them with "Add current content".`
    : sequence.length ? 'Sequence paused: preview and send use the content above.' : '';
}

function addSequenceSteps(steps: SequenceStep[]) {
  if (sequence.length + steps.length > MAX_SEQUENCE_STEPS) throw new Error(`A sequence has at most ${MAX_SEQUENCE_STEPS} steps.`);
  const next = validateSequenceSteps([...sequence, ...steps]);
  sequence = next;
  sequenceOn = true;
  $('#c-err').textContent = '';
  sequenceChanged();
}

function sequenceChanged() {
  if (!sequence.length) sequenceOn = false;
  void saveKv('createSequence', sequence).catch((e) => { $('#c-err').textContent = `Could not save the sequence: ${(e as Error).message}`; });
  renderSequence();
  void refreshPreview();
}

async function refreshSequencePresets() {
  const select = document.getElementById('c-seq-preset') as HTMLSelectElement | null;
  if (!select) return;
  let presets: Preset[] = [];
  try { presets = (await listPresets()).filter((p) => !isGroupPreset(p)); } catch { /* storage errors are shown elsewhere */ }
  const keep = select.value;
  select.innerHTML = presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') || '<option value="" disabled selected>No saved presets</option>';
  if (presets.some((p) => p.id === keep)) select.value = keep;
  renderSequence();
}

function syncKind() {
  const k = $<HTMLSelectElement>('#c-kind').value;
  $('#c-text').hidden = k !== 'text';
  $('#c-image').hidden = k !== 'image';
}

function currentContent(): Content {
  if (!document.getElementById('c-kind')) {
    if (!savedCreateContent) throw new Error('Choose content on the Connect tab first.');
    return savedCreateContent;
  }
  if (sequenceOn && sequence.length) return { kind: 'sequence', steps: structuredClone(sequence) };
  return editorContent();
}

/** The single content currently in the editor fields, ignoring the sequence. */
function editorContent(): SingleContent {
  const k = $<HTMLSelectElement>('#c-kind').value;
  const fg = $<HTMLInputElement>('#c-fg').value, bg = $<HTMLInputElement>('#c-bg').value;
  if (k === 'solid') return { kind: 'solid', color: fg };
  if (k === 'text') return { kind: 'text', text: $<HTMLInputElement>('#c-str').value, fg, bg, speed: Number($<HTMLInputElement>('#c-speed').value) };
  if (!imageDataUrl) throw new Error('Choose an image first.');
  return { kind: 'image', dataUrl: imageDataUrl, fit: $<HTMLSelectElement>('#c-fit').value as Fit, bg };
}

async function renderContent(c: Content): Promise<{ image: RgbImage; frames?: RgbImage[]; delays?: number[]; warnings: string[] }> {
  const [w, h] = logicalDims();
  if (c.kind === 'sequence') {
    const warnings: string[] = [];
    const steps = [];
    for (const [i, s] of c.steps.entries()) {
      const r = await renderContent(s.content);
      warnings.push(...r.warnings.map((w) => `Step ${i + 1}: ${w}`));
      steps.push({ ...r, seconds: s.seconds });
    }
    const { frames, delays } = composeSequence(steps);
    return frames.length > 1 ? { image: frames[0]!, frames, delays, warnings } : { image: frames[0]!, warnings };
  }
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
  const blob = await (await fetch(c.dataUrl)).blob();
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
    const selected = content ?? currentContent();
    const { image, frames, delays, warnings } = await renderContent(selected);
    if (seq !== renderSeq) return;
    savedCreateContent = selected;
    createContentChanged();
    void saveKv('createContent', selected).catch((e) => { $('#c-err').textContent = `Could not save Connect content: ${(e as Error).message}`; });
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
    const gif = encodeGif(frames, delays, { nonce: gifNonce() });
    const r = await controller.uploadGif(gif, settings.width, settings.height, frames[0]);
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
    void refreshSequencePresets();
  } catch (e) { $('#c-err').textContent = (e as Error).message; }
}

// ---------- Presets view ---------------------------------------------------------

const backupSelection: ShareSelection = { creations: true, approach: true, scan: true, settings: true, sound: true };

async function renderPresets(message = '') {
  const root = $('#settings-presets');
  let presets: Preset[] = [];
  let err = '';
  try { presets = await listPresets(); } catch (e) { err = (e as Error).message; }
  root.innerHTML = `
    <div id="p-share" class="card" hidden></div>
    <div class="card">
      <h2>Presets</h2>
      ${err ? `<p class="bad">${esc(err)}</p>` : ''}
      <ul class="list preset-list">${presets.map((p) => `<li data-id="${esc(p.id)}"><span>${esc(p.name)} <small class="muted">${isGroupPreset(p) ? `group content${approachAvailable ? '' : ' - requires the native app; kept for backup'}` : p.content.kind === 'sequence' ? `sequence (${p.content.steps.length} step${p.content.steps.length === 1 ? '' : 's'})` : p.content.kind}</small></span><button data-act="load" ${isGroupPreset(p) && !approachAvailable ? 'disabled' : ''}>Load</button>${native && !useMock ? '<button data-act="share">Share</button>' : ''}<button data-act="del" class="danger">Delete</button></li>`).join('') || `<li class="muted">No presets yet. Save content on Connect${approachAvailable ? ' or a group preset on Approach' : ''} to find it here.</li>`}</ul>
      ${approachAvailable ? '' : '<p class="small">Nearby Approach detection and phone-to-phone BLE sharing require the Android or iOS app. Imported group presets remain available for backup and export.</p>'}
    </div>
    <div class="card">
      <h2>Backup</h2>
      <fieldset class="share-options">
        <legend>Include in shared file</legend>
        <label><input type="checkbox" id="p-include-creations" ${backupSelection.creations ? 'checked' : ''} /> <span>Creations <small>Saved text, colors, images, GIFs and sequences (${presets.filter((p) => !isGroupPreset(p)).length}), current Connect content and sequence, and GitHub handle, prefix and postfix text</small></span></label>
        <label><input type="checkbox" id="p-include-approach" ${backupSelection.approach ? 'checked' : ''} /> <span>Approach settings <small>Saved group presets (${presets.filter(isGroupPreset).length}), current group content, mode, beacon and nearby-cap detection</small></span></label>
        <label><input type="checkbox" id="p-include-scan" ${backupSelection.scan ? 'checked' : ''} /> <span>Scan settings <small>Proximity thresholds, timing, QR profiles, current greeting, repetitions, speed and logging preference (not log contents)</small></span></label>
        <label><input type="checkbox" id="p-include-settings" ${backupSelection.settings ? 'checked' : ''} /> <span>Display &amp; transport settings <small>LED text font, dimensions, brightness, rotation, mirroring and Bluetooth write settings</small></span></label>
        <label><input type="checkbox" id="p-include-sound" ${backupSelection.sound ? 'checked' : ''} /> <span>Sound settings <small>Room sounds, phrases, language, pocket pause and reaction texts (not your voice sample or browser speech permission)</small></span></label>
      </fieldset>
      <p class="small">Choose at least one category. Importing replaces only the included categories; everything else stays unchanged.</p>
      <p class="small">Importing Scan settings can enable scan logging. Phone identity, cap connections, permissions and running state are not shared.</p>
      <div class="row"><button id="btn-export">Share presets</button><label class="row"><span>Import</span><input id="p-import" type="file" accept="application/json,.json" /></label></div>
      <p id="p-msg" class="small" role="status">${esc(message)}</p>
      <p id="p-persist" class="small"></p>
    </div>`;
  renderShare();
  root.querySelectorAll<HTMLButtonElement>('li button').forEach((b) => b.onclick = async () => {
    const id = b.closest('li')!.dataset.id!;
    const p = presets.find((x) => x.id === id)!;
    if (b.dataset.act === 'share') { openShare(p); return; }
    if (b.dataset.act === 'del') { await deletePreset(id).catch((e) => ($('#p-msg').textContent = e.message)); void renderPresets(); return; }
    if (isGroupPreset(p)) { applyGroupContent(p.groups); showTab('approach'); return; }
    if (p.content.kind === 'image') imageDataUrl = p.content.dataUrl;
    try {
      const { image } = await renderContent(p.content);
      lastImage = image;
      showTab('connect');
      setCreateFrom(p.content);
      await refreshPreview(p.content);
    } catch (e) { $('#p-msg').textContent = (e as Error).message; }
  });
  const exportButton = $<HTMLButtonElement>('#btn-export');
  const shareOptions = $<HTMLFieldSetElement>('.share-options', root);
  let sharingBackup = false;
  const updateSelection = () => {
    for (const key of ['creations', 'approach', 'scan', 'settings', 'sound'] as const) {
      backupSelection[key] = $<HTMLInputElement>(`#p-include-${key}`).checked;
    }
    exportButton.disabled = sharingBackup || !Object.values(backupSelection).some(Boolean);
  };
  for (const key of ['creations', 'approach', 'scan', 'settings', 'sound'] as const) {
    $<HTMLInputElement>(`#p-include-${key}`).onchange = updateSelection;
  }
  updateSelection();
  exportButton.onclick = async () => {
    sharingBackup = true;
    shareOptions.disabled = true;
    updateSelection();
    try {
      const all = await listPresets();
      const json = exportSelectedJson(all, getApproachSettings(), backupSelection,
        backupSelection.scan ? scanner?.exportProfiles() : undefined, {
          settings,
          ...(backupSelection.creations ? { createContent: currentContent(), createSequence: sequence } : {}),
          ...(backupSelection.creations && github ? { github: github.exportSettings() } : {}),
          ...(backupSelection.scan ? scanner?.exportSettings() : {}),
          ...(backupSelection.sound && sound ? { sound: sound.exportPreferences() } : {}),
        });
      const shared = await shareTextFile('led-hat-presets.json', json, 'application/json', 'LED hat presets');
      $('#p-msg').textContent = shared ? 'Selected categories shared.' : '';
    } catch (e) { $('#p-msg').textContent = `Share failed: ${(e as Error).message}`; }
    finally { sharingBackup = false; shareOptions.disabled = false; updateSelection(); }
  };
  $<HTMLInputElement>('#p-import').onchange = async (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      if (f.size > 4 * 1024 * 1024) throw new Error('Import file is too large.');
      const data = parseSharedBackup(await f.text());
      const merged = mergeSharedPresets(await listPresets(), data);
      const currentApproach = getApproachSettings();
      const nextApproach = data.version === 2 && (data.approach || data.scan) ? {
        ...currentApproach, ...data.scan,
        ...(data.approach?.mode !== undefined ? { mode: data.approach.mode } : {}),
        ...(data.approach?.beacon !== undefined ? { beacon: data.approach.beacon } : {}),
        ...(data.approach?.countNearbyCaps !== undefined ? { countNearbyCaps: data.approach.countNearbyCaps } : {}),
        tiers: data.approach?.groups ?? currentApproach.tiers,
      } : undefined;
      const scanSettings = scanner?.prepareImport(data);
      const createContent = data.version === 2 ? data.createContent : undefined;
      const createSequence = data.version === 2 ? data.createSequence : undefined;
      const soundSettings = data.version === 2 && data.sound && sound ? sound.prepareImport(data.sound) : undefined;
      const nextSettings = data.settings ? { ...data.settings, textFont: data.settings.textFont ?? settings.textFont ?? DEFAULT_TEXT_FONT } : undefined;
      const githubSettings = data.version === 2 && data.github ? github?.prepareImport(data.github) ?? data.github : undefined;
      if (soundSettings) await sound?.stop();
      await restoreBackup(merged, nextSettings, nextApproach, { ...scanSettings, createContent, createSequence, sound: soundSettings, github: githubSettings });
      if (nextSettings) {
        settings = nextSettings;
        setTextFont(settings.textFont ?? DEFAULT_TEXT_FONT);
        textFontChanged();
      }
      if (githubSettings) github?.applyImported(githubSettings);
      if (createSequence) { sequence = structuredClone(createSequence); renderSequence(); }
      if (createContent) {
        savedCreateContent = createContent;
        if (createContent.kind === 'image') imageDataUrl = createContent.dataUrl;
        setCreateFrom(createContent);
      }
      if (nextApproach) applyImportedApproachSettings(nextApproach);
      if (scanSettings) scanner?.applyImportedSettings(scanSettings);
      if (soundSettings) sound?.applyImported(soundSettings);
      renderDeviceSettings();
      github?.refreshPreview();
      await refreshPreview();
      await renderPresets(data.version === 1
        ? `Imported ${data.presets.length} presets and ${data.qrProfiles.profiles.length} QR profiles. Restart the connection to apply transport settings.`
        : `Imported shared categories.${data.qrProfiles ? ` Imported ${data.qrProfiles.profiles.length} QR profiles.` : ''} Excluded presets and settings were kept.${data.settings ? ' Restart the connection to apply transport settings.' : ''}`);
    } catch (e) { $('#p-msg').textContent = `Import failed: ${(e as Error).message}`; }
  };
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $('#p-persist').textContent = persisted ? 'Storage is marked persistent.' : 'Storage may be cleared by the browser. Share a backup regularly.';
}

// ---------- preset sharing with nearby phones ---------------------------------------

const kindLabel = (k: ShareKind) => (k === 'group' ? 'group content' : k);
const sizeLabel = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

let share: { preset: Preset; status: string; busy: boolean; sig?: string; abort?: AbortController; timer?: ReturnType<typeof setInterval> } | undefined;

function openShare(p: Preset) {
  if (share?.busy) { setShareStatus('Finish or cancel the current share first.'); return; }
  closeShare();
  share = { preset: p, status: '', busy: false };
  share.timer = setInterval(() => renderShare(), 2000); // the list of nearby phones changes
  renderShare();
  document.getElementById('p-share')?.scrollIntoView({ block: 'nearest' });
}

function closeShare() {
  if (!share) return;
  clearInterval(share.timer);
  share.abort?.abort();
  share = undefined;
  renderShare();
}

function setShareStatus(msg: string) {
  if (!share) return;
  share.status = msg;
  const el = document.getElementById('p-share-status');
  if (el) el.textContent = msg;
}

function renderShare() {
  const el = document.getElementById('p-share');
  if (!el) return;
  if (!share) { el.hidden = true; el.innerHTML = ''; return; }
  const s = share;
  const peers = s.busy ? [] : sharePeers();
  const running = approachRunning();
  const sig = JSON.stringify([s.busy, running, s.status, peers.map((p) => [p.deviceId, p.label, p.near, Math.round(p.rssi / 5)])]);
  if (sig === s.sig && !el.hidden) return; // keep buttons stable while the list is unchanged
  s.sig = sig;
  el.hidden = false;
  el.innerHTML = `
    <h2>Share "${esc(s.preset.name)}"</h2>
    ${s.busy ? '' : !running
      ? '<p class="small warn">Turn on approach mode (Approach tab) on both phones to find each other. Keep the app open on the other phone.</p>'
      : `<p class="small">Choose a nearby phone. Its user must accept before the preset is transferred.</p>
         <ul class="list">${peers.map((p) => `<li data-device="${esc(p.deviceId)}" data-label="${esc(p.label)}"><span>${esc(p.label)} <small class="muted">${p.near ? 'near' : 'in range'}, ${p.rssi} dBm</small></span><button data-act="send" class="primary">Send</button></li>`).join('') || '<li class="muted">Looking for nearby phones…</li>'}</ul>`}
    <p id="p-share-status" class="small" aria-live="polite">${esc(s.status)}</p>
    <div class="row"><button id="p-share-close">${s.busy ? 'Cancel' : 'Close'}</button></div>`;
  el.querySelectorAll<HTMLButtonElement>('button[data-act=send]').forEach((b) => b.onclick = () => {
    const li = b.closest('li')!;
    void sendShare(li.dataset.device!, li.dataset.label!);
  });
  $('#p-share-close', el).onclick = () => { if (s.busy) s.abort?.abort(); else closeShare(); };
}

async function sendShare(deviceId: string, label: string) {
  const s = share;
  if (!s || s.busy) return;
  s.busy = true;
  s.abort = new AbortController();
  s.status = `Connecting to ${label}…`;
  renderShare();
  const me = shareIdentity();
  try {
    const result = await withShareLink(deviceId, (link) => sendPreset(link, {
      preset: s.preset, fromPhoneId: me.phoneId, fromName: me.name, signal: s.abort!.signal,
      onPhase: (phase, sent = 0, total = 1) => setShareStatus(
        phase === 'connecting' ? `Connecting to ${label}…`
        : phase === 'waiting' ? `Waiting for ${label} to accept…`
        : phase === 'sending' ? `Sending… ${Math.floor((sent / total) * 100)}%`
        : 'Waiting for confirmation…'),
    }));
    s.status = result === 'received' ? `${label} received "${s.preset.name}".`
      : result === 'declined' ? `${label} declined the preset.`
      : `${label} is answering another share; try again shortly.`;
  } catch (e) {
    s.status = s.abort.signal.aborted ? 'Share cancelled.' : `Share failed: ${(e as Error).message}`;
  } finally {
    s.busy = false;
    s.abort = undefined;
    renderShare();
  }
}

let receiver: ShareReceiver | undefined;
let incomingNote = '';

function renderSharePrompt() {
  const el = $('#share-prompt');
  const cur = receiver?.current;
  if (!cur && !incomingNote) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  if (!cur) {
    el.innerHTML = `<p>${esc(incomingNote)}</p><div class="row"><button id="sp-ok">OK</button></div>`;
    $('#sp-ok', el).onclick = () => { incomingNote = ''; renderSharePrompt(); };
    return;
  }
  const o = cur.offer;
  const from = o.fromName || `Phone ${o.fromPhoneId.toString(16).padStart(8, '0')}`;
  if (cur.state === ShareState.Pending) {
    el.innerHTML = `
      <p><b>${esc(from)}</b> wants to send you the preset <b>"${esc(o.name)}"</b> (${esc(kindLabel(o.kind))}, ${sizeLabel(o.size)}).</p>
      <div class="row"><button id="sp-accept" class="primary">Accept</button><button id="sp-decline">Decline</button></div>`;
    $('#sp-accept', el).onclick = () => { receiver?.accept(o.transferId); renderSharePrompt(); };
    $('#sp-decline', el).onclick = () => { receiver?.decline(o.transferId); renderSharePrompt(); };
  } else {
    el.innerHTML = `<p>Receiving "${esc(o.name)}" from ${esc(from)}…</p><progress id="sp-progress" max="${o.size}" value="${cur.received}"></progress>`;
  }
}

function initShareReceiver() {
  if (!native || useMock) return;
  listenForShares({
    onOffer: (o) => { incomingNote = ''; renderSharePrompt(); navigator.vibrate?.(200); },
    onProgress: (_o, received) => {
      const p = document.getElementById('sp-progress') as HTMLProgressElement | null;
      if (p) p.value = received; else renderSharePrompt();
    },
    onReceived: async (o, p) => {
      const base = { id: crypto.randomUUID(), name: p.name, updatedAt: Date.now() };
      await savePreset('groups' in p ? { ...base, groups: p.groups } : { ...base, content: p.content });
      incomingNote = `Saved preset "${p.name}"${o.fromName ? ` from ${o.fromName}` : ''}.`;
      setTimeout(() => {
        renderSharePrompt();
        if (!$('#view-settings').hidden) void renderPresets();
      }, 0);
    },
    onClosed: (o, _state, message) => { incomingNote = `Preset "${o.name}" not received: ${message}`; renderSharePrompt(); },
  }).then((r) => { receiver = r; }, (e) => console.warn('Preset sharing unavailable', e));
}

function setCreateFrom(c: Content) {
  if (c.kind === 'sequence') {
    sequence = structuredClone(c.steps);
    sequenceOn = true;
    void saveKv('createSequence', sequence).catch(() => undefined);
    renderSequence();
    c = c.steps[0]!.content;
    if (c.kind === 'image') imageDataUrl = c.dataUrl;
  } else if (sequenceOn) {
    sequenceOn = false;
    renderSequence();
  }
  $<HTMLSelectElement>('#c-kind').value = c.kind;
  syncKind();
  if (c.kind === 'solid') $<HTMLInputElement>('#c-fg').value = c.color;
  if (c.kind === 'text') { $<HTMLInputElement>('#c-str').value = c.text; $<HTMLInputElement>('#c-fg').value = c.fg; $<HTMLInputElement>('#c-bg').value = c.bg; $<HTMLInputElement>('#c-speed').value = String(c.speed ?? DEFAULT_SPEED); $('#c-speed-val').textContent = $<HTMLInputElement>('#c-speed').value; }
  if (c.kind === 'image') { $<HTMLInputElement>('#c-bg').value = c.bg; $<HTMLSelectElement>('#c-fit').value = c.fit; }
}

// ---------- tabs, offline, install, updates ---------------------------------------

let showTab: (name: string) => boolean;

function onTabSelected(name: string) {
  if (name !== 'scan') scanner?.stopCamera();
  if (name !== 'sound') void sound?.stop();
  if (name === 'settings') void renderPresets();
  if (name === 'connect') void refreshSequencePresets();
  if (name === 'approach') renderApproach();
  window.scrollTo(0, 0);
}

function setupPwa() {
  const offline = $('#offline');
  if (native) { offline.textContent = platformName() === 'ios' ? 'iOS app' : 'Android app'; offline.className = 'pill ok'; return; }
  const updateSW = registerSW({
    onOfflineReady() { offline.textContent = 'Ready for offline use'; offline.className = 'pill ok'; },
    onNeedRefresh() {
      const show = () => {
        if (controller.state === 'Uploading' || controller.temporaryActive) { setTimeout(show, 2000); return; } // never reload mid-transfer
        banner('A new version is available. <button id="btn-update" class="primary">Update</button>');
        $('#btn-update').onclick = () => { if (controller.state !== 'Uploading' && !controller.temporaryActive) void updateSW(true); };
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

function setupAppUpdates() {
  const platform = platformName();
  const updates = new UpdateUi({
    root: $('#settings-update'),
    platform: native && !useMock && (platform === 'android' || platform === 'ios') ? platform : null,
    currentVersion: __APP_VERSION__,
    banner,
    busy: () => controller.state === 'Uploading' || controller.temporaryActive,
  });
  updates.render();
  // Let startup restore state first; the check is optional and must never delay the UI.
  setTimeout(() => void updates.autoCheck(), 3000);
}

function approachContext(): Parameters<typeof initApproach>[0] {
  return {
    native, mock: useMock,
    profile: () => profileFor(settings),
    logicalDims, physical, marqueeDelay, trace,
    renderContent: (c) => renderContent(c),
    createContent: currentContent,
    chooseCap: () => chooseNativeCap(),
    connectCap: (id) => connectNativeCap(id),
    readRssi: (id) => readCapRssi(id),
    startScan: (cb) => (native ? startNativeScan((r) => cb({ deviceId: r.device.deviceId, name: r.localName ?? r.device.name, rssi: r.rssi, uuids: r.uuids, localName: r.localName, manufacturerData: r.manufacturerData })) : Promise.resolve()),
    stopScan: () => (native ? stopNativeScan() : Promise.resolve()),
    onPrimaryChange,
  };
}

async function main() {
  try { settings = await loadSettings(); } catch (e) { settings = DEFAULT_SETTINGS; banner(`<b>Storage unavailable:</b> ${esc((e as Error).message)}. Presets cannot be saved.`); }
  settings = { ...settings, width: DEFAULT_SETTINGS.width, height: DEFAULT_SETTINGS.height }; // fixed 32x16 panel
  setTextFont(settings.textFont ?? DEFAULT_TEXT_FONT);
  newController();
  try {
    const saved = await loadKv('createContent');
    if (saved !== undefined) savedCreateContent = validateContent(saved);
  } catch (e) { banner(`<b>Could not restore Connect content:</b> ${esc((e as Error).message)}`); }
  try {
    const draft = await loadKv('createSequence');
    if (draft !== undefined) sequence = validateSequenceSteps(draft);
  } catch (e) { banner(`<b>Could not restore the Connect sequence:</b> ${esc((e as Error).message)}`); }
  await initApproach(approachContext());
  initShareReceiver();
  renderConnect();
  renderDeviceSettings();
  // Navigation must not wait for optional features to restore storage or query native capabilities.
  $('#tab-approach').hidden = !approachAvailable;
  showTab = initTabs($('#tab-bar'), onTabSelected);
  renderCreate();
  setupPwa();
  setupAppUpdates();
  void requestPersistence();
  scanner = new GreetingUi({ controller: () => controller, logicalDims, physical, marqueeDelay });
  const scannerReady = scanner.init();
  sound = new SoundUi({ controller: () => controller, logicalDims, physical });
  github = new GitHubUi({ root: $('#github-section'), controller: () => controller, logicalDims, physical, frameDelayMs: marqueeDelay(DEFAULT_SPEED) });
  await Promise.all([scannerReady, sound.init(), github.init()]);
}
void main().catch((error: unknown) => {
  console.error('App initialization failed', error);
  banner(`<b>App initialization failed:</b> ${esc(error instanceof Error ? error.message : String(error))}. Reload the app to try again.`);
});
