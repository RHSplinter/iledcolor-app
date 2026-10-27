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
import { builtinPresets } from '../storage/builtinPresets';
import {
  DEFAULT_SETTINGS, DEFAULT_SPEED, DEFAULT_STEP_SECONDS, MAX_SEQUENCE_STEPS, MAX_STEP_SECONDS, isGroupPreset, mergeCustomDrafts, validateContent, validateCustomDrafts, validateSequenceSteps,
  type Content, type CustomDrafts, type Preset, type SequenceStep, type Settings, type SingleContent,
} from '../storage/presets';
import { composeSequence } from '../render/sequence';
import { exportSelectedJson, mergeSharedPresets, parseSharedBackup, type ShareSelection } from '../storage/sharedBackup';
import { MockTransport } from '../transport/mock';
import { SPIKE_PROFILE, type TransportProfile } from '../transport/types';
import { forgetWebHat, saveWebHat } from '../transport/webBluetoothMemory';
import { connectionTabClient } from '../transport/connectionTab';
import { bluetoothSupport } from '../transport/webBluetooth';
import { chooseNativeCap, connectNativeCap, readCapRssi, startNativeScan, stopNativeScan } from '../transport/nativeBle';
import { isNativeApp, platformName } from '../platform';
import { applyGroupContent, applyImportedApproachSettings, getApproachSettings, approachRunning, connectAsPrimary, createContentChanged, disconnectPrimary, initApproach, keepBlackChanged, renderApproach, sharePeers, shareIdentity, textFontChanged, type PrimaryCap } from '../approach/ui';
import { listenForShares, withShareLink } from '../approach/contentExchange';
import { sendPreset, ShareState, type ShareKind, type ShareReceiver } from '../approach/presetShare';
import { shareTextFile } from './shareFile';
import { initTabs } from './tabs';
import { setupInstallPrompt } from './install';
import { initConnectionStatus } from './connectionStatus';
import { openHatTab, CONNECTION_TAB } from './browserTabs';
import { GreetingUi } from '../scanner/ui';
import { SoundUi } from '../sound/ui';
import { UpdateUi } from '../update/ui';
import { contributionFrames, GitHubUi, todayUtc } from '../github/ui';
import { fetchContributions } from '../github/contributions';
import { initPresetSave, presetSaveInlineMarkup, presetSaveNoteMarkup } from './presetSave';

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let settings: Settings;
let controller: DeviceController;
let deviceName = '';
const native = isNativeApp();
let useMock = location.hash === '#mock'; // dev/test only: in-memory hat
const approachAvailable = native || useMock;
let lastImage: RgbImage | null = null; // retained across disconnects
let previewTimer: ReturnType<typeof setTimeout> | undefined;
/** Scroll speed 1 (slow) .. 10 (fast) -> per-frame delay at 2 px per frame. */
const marqueeDelay = (speed: number) => Math.round(220 / speed);
let sendNote = '';
let brightnessNote = '';
let brightnessTimer: ReturnType<typeof setTimeout> | undefined;
let presetSendingBanner = false;
let displayNote = '';
let imageDataUrl = '';
let renderSeq = 0;
let savedCreateContent: Content | undefined;
let savedCustomDrafts: Partial<CustomDrafts> = {};
let activeKind: keyof CustomDrafts = 'text';
let sendingContent = false;
/** Custom tab sequence steps; kept as a draft while `sequenceOn` is false. */
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
  controller = new DeviceController({
    profile: profileFor(settings),
    onTrace: trace,
    keepBlack: Boolean(settings.keepBlack),
    blackImage: physical(solid(...logicalDims(), [0, 0, 0])),
  });
  controller.subscribe(renderStatus);
}
/** In the app (and mock mode) the Custom tab's cap is cap 1 of approach mode: one shared connection. */
const sharedCap = () => native || useMock;
const updateConnectionStatus = initConnectionStatus($('#connection-status'), () => {
  if (sharedCap()) disconnectPrimary();
  else {
    forgetLastHat(); controller.disconnect();
    openHatTab(new URL('?hatConnection=1#connect', location.href).href, CONNECTION_TAB);
  }
});

// Browser permission and the active GATT link are separate from our saved hat identity.
function forgetLastHat() { forgetWebHat(); restoreNote = ''; }
let restoreNote = '';
let restoringWebConnection = false;
let wasHatConnected = false;
const watched = new WeakSet<DeviceController>();
function onPrimaryChange(p: PrimaryCap | null) {
  scanner?.stopCamera();
  void sound?.stop();
  if (p) {
    controller = p.controller;
    deviceName = p.name;
    controller.setKeepBlack(Boolean(settings.keepBlack), physical(solid(...logicalDims(), [0, 0, 0])));
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
  const cls = s === 'Ready' ? 'ok' : s === 'Error' || s === 'Disconnected' ? 'err' : 'busy';
  el.className = `pill ${cls}`;
  const connected = s === 'Ready' || s === 'Uploading';
  updateConnectionStatus(connected);
  const p = controller.progress;
  $('#status-label').textContent = s === 'Uploading' && p ? `Uploading ${p.sent}/${p.total}` : s === 'Ready' && deviceName ? `Ready: ${deviceName}` : restoringWebConnection && s === 'Selecting' ? `Reconnecting to ${deviceName || 'your hat'}...` : s;
  const err = controller.error;
  const msg = $('#conn-msg', document);
  if (msg) msg.textContent = [restoreNote, err].filter(Boolean).join(' ');
  const prog = document.querySelector<HTMLProgressElement>('#progress');
  if (prog && p) { prog.max = p.total; prog.value = p.sent; }
  updateButtons();
  applyConnectionGate();
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
  for (const kind of ['text', 'solid', 'image', 'sequence']) {
    set(kind === 'text' ? 'btn-send' : `btn-send-${kind}`,
      !ready || sendingContent || (kind === 'image' && !imageDataUrl) || (kind === 'sequence' && !sequence.length));
  }
  document.querySelectorAll<HTMLButtonElement>('.preset-list [data-act=send]').forEach((b) => {
    b.disabled = !ready || sendingContent;
  });
  const help = document.getElementById('send-help');
  if (help) help.textContent = controller.temporaryActive ? 'Wait for the current cap reaction to finish before sending.'
    : !ready ? 'Wait for the hat to be ready before sending.'
    : !lastImage ? 'Choose valid content to enable sending.' : 'Preview ready. Send it to your connected hat.';
  set('btn-test-color', !ready); set('btn-test-corner', !ready);
  set('btn-disp-on', !ready); set('btn-disp-off', !ready);
  set('brightness', !ready);
  const cancel = document.getElementById('btn-cancel');
  if (cancel) cancel.hidden = s !== 'Uploading';
  const prog = document.getElementById('progress');
  if (prog) prog.hidden = s !== 'Uploading';
  const label = document.getElementById('btn-connect');
  if (label) {
    label.textContent = restoringWebConnection ? 'Reconnecting...' : 'Connect hat';
    label.setAttribute('aria-disabled', String(busy || ready));
    label.tabIndex = busy || ready ? -1 : 0;
  }
}

/** Hat commands need a connection; navigation and badge scanning remain available. */
function applyConnectionGate() {
  const s = controller.state;
  const connected = s === 'Ready' || s === 'Uploading';
  const justConnected = connected && !wasHatConnected;
  document.body.classList.toggle('disconnected', !connected);
  for (const id of ['content-editor', 'github-section']) {
    const el = document.getElementById(id);
    if (el) el.hidden = !connected;
  }
  for (const id of ['tab-bar', 'tab-sound', 'tab-scan', 'tab-settings']) {
    const el = document.getElementById(id);
    if (el) el.hidden = id === 'tab-bar' && !showTab;
  }
  for (const id of ['tab-presets', 'tab-sound', 'tab-settings']) {
    const tab = document.getElementById(id) as HTMLButtonElement | null;
    if (tab) {
      tab.hidden = !connected;
      tab.disabled = !connected;
    }
  }
  const customTab = document.getElementById('tab-custom');
  if (customTab) {
    customTab.querySelector('span')!.textContent = connected ? 'Custom' : 'Connect hat';
    customTab.querySelector('path')!.setAttribute('d', connected
      ? 'm15 3 6 6-12 12H3v-6L15 3zm-3 3 6 6M3 15l6 6'
      : 'm7 7 10 10-5 4V3l5 4L7 17');
  }
  const connectionCard = document.getElementById('connection-card');
  if (connectionCard) connectionCard.hidden = connected;
  const approachTab = document.getElementById('tab-approach');
  if (approachTab) approachTab.hidden = !connected || !approachAvailable;
  if (wasHatConnected && !connected) showTab?.('custom');
  wasHatConnected = connected;
  if (justConnected) showTab?.('presets');
}

function banner(html: string | null) {
  const b = $('#banner');
  b.hidden = !html;
  if (html) b.innerHTML = html;
}

// ---------- Custom view ---------------------------------------------------------

function renderCustom() {
  const sup: ReturnType<typeof bluetoothSupport> = native ? { ok: true } : bluetoothSupport();
  const root = $('#view-custom');
  root.innerHTML = `
    <div class="card" id="connection-card">
      <h2>Hat connection</h2>
      ${sup.ok || useMock ? '' : `<p class="bad">${esc(sup.ok ? '' : sup.reason)}</p>`}
      ${useMock ? '<p class="warn">Mock mode: no real hat is used.</p>' : ''}
      <div class="row">
        ${sharedCap() ? '<button id="btn-connect" class="primary">Connect hat</button>' : '<a id="btn-connect" class="action-link primary" href="?hatConnection=1#connect" target="iledcolor-led-hat-connection" rel="opener">Connect hat</a>'}
        <button id="btn-install" hidden>Install app</button>
      </div>
      <p id="conn-msg" class="small"></p>
      <p class="small">Close other controller apps first. ${native ? `${platformName() === 'ios' ? 'iOS' : 'Android'} will ask for Bluetooth permission the first time you connect.` : 'Connect hat opens the LED Hat Connection tab. Choose your hat there; this controller opens Presets once connected. Badge scanning works without a hat.'}</p>
      <p class="small" id="install-help" hidden>Install app works on desktop and mobile. If no prompt opens here, use the browser menu to choose Install app (or Add to Home Screen on a phone).</p>
    </div>
    <div id="content-editor"></div>`;
  if (sharedCap()) $('#btn-connect').onclick = onConnect;
  else $('#btn-connect').onclick = (event) => {
    const link = $('#btn-connect') as HTMLAnchorElement;
    if (link.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
    restoreNote = 'Opening LED Hat Connection. Choose Connect LED hat in that tab to pair your hat.';
    const message = document.getElementById('conn-msg');
    if (message) message.textContent = restoreNote;
    // Let Chrome activate the named tab through the user's link click. Scripted
    // focus can be ignored, and rerendering here can replace the clicked link.
  };
  renderStatus();
}

function renderDeviceSettings() {
  clearTimeout(brightnessTimer);
  const root = $('#settings-device');
  root.innerHTML = `
    ${approachAvailable ? '' : '<p class="small">Nearby Approach detection and phone-to-phone BLE sharing require the Android or iOS app. Imported group presets remain available for backup and export.</p>'}
    <div class="card">
      <h2>Display</h2>
      <label for="s-font">LED text font</label>
      <select id="s-font" aria-describedby="s-font-help">${TEXT_FONTS.map((f) => `<option value="${f.id}" ${f.id === (settings.textFont ?? DEFAULT_TEXT_FONT) ? 'selected' : ''}>${f.label}</option>`).join('')}</select>
      <p id="s-font-help" class="small">Default for LED text: Custom, sequences, Approach, Scan greetings and Sound reactions. Custom text and presets can choose their own font. Tiny5 and Bitcount use crisp 2x pixel sizes; Bitcount fills all 16 rows. Monaspace Neon is scaled to fill the full display height. The other fonts use their native size. Letters have a one-pixel gap and emoji a two-pixel gap. Send again to update Custom content already on the hat.</p>
      <canvas id="font-preview" width="32" height="16" role="img" aria-label="LED font sample: Hi!"></canvas>
      <label for="brightness">Dimming level: <b id="bval">${settings.brightness}</b> (0 = brightest, 10 = dimmest) <span id="bstate" class="small">${esc(brightnessNote)}</span></label>
      <input id="brightness" type="range" min="0" max="10" step="1" value="${settings.brightness}" />
      <p class="small">Mapping and "dimmest ≠ off" are unverified on this hat. Start dim for the first tests.</p>
      <div class="row"><button id="btn-disp-on">Display on</button><button id="btn-disp-off">Display off</button><span id="dstate" class="small">${esc(displayNote)}</span></div>
      <label><input type="checkbox" id="s-keep-black" ${settings.keepBlack ? 'checked' : ''} /> Keep cap black unless an approach, scan or sound event is active</label>
      <p class="small">Turns the cap display off and keeps a black frame while idle or alone, waking it only for multi-cap approach greetings, QR badge greetings and sound reactions.</p>
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
  $<HTMLInputElement>('#s-keep-black').onchange = (e) => void applyKeepBlack((e.target as HTMLInputElement).checked);
  root.querySelectorAll('#s-font,#s-rot,#s-mh,#s-mv,#s-chunk,#s-delay').forEach((e) => e.addEventListener('change', readSettings));
  renderStatus();
}

function syncKeepBlackControls() {
  const on = Boolean(settings.keepBlack);
  const sBox = document.getElementById('s-keep-black') as HTMLInputElement | null;
  if (sBox) sBox.checked = on;
}

async function applyKeepBlack(on: boolean, persist = true) {
  settings = { ...settings, keepBlack: on };
  syncKeepBlackControls();
  if (persist) persistSettings();
  const black = physical(solid(...logicalDims(), [0, 0, 0]));
  controller.setKeepBlack(on, black);
  await keepBlackChanged();
  if (!sharedCap() && controller.state === 'Ready' && !controller.temporaryActive) {
    if (on) await controller.applyKeepBlackIdle(black).catch(() => undefined);
    else if (controller.displayOff) await controller.setDisplay(true).catch(() => undefined);
  }
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
    if (controller.state === 'Ready') showTab?.('presets');
    renderStatus();
    return;
  }

}

/** Reattach only to a live owner; saved identity alone never triggers pairing. */
async function restoreWebConnection(selectHat = false) {
  if (sharedCap() || restoringWebConnection || !['Disconnected', 'Error'].includes(controller.state)) return;
  const client = connectionTabClient();
  const live = await client.status();
  if (!live || restoringWebConnection || !['Disconnected', 'Error'].includes(controller.state)) return;
  restoringWebConnection = true;
  deviceName = live.deviceName;
  restoreNote = `Reconnecting to ${live.deviceName}...`;
  renderStatus();
  try {
    await controller.connect(async () => (await client.connect(live.deviceId, 10000)).transport);
  } finally {
    restoringWebConnection = false;
    restoreNote = ['Ready'].includes(controller.state) ? '' : 'The connection tab is unavailable. Open Custom and use Connect hat to reconnect.';
  }
  if (controller.state === 'Ready') {
    saveWebHat({ id: live.deviceId, name: live.deviceName });
    if (selectHat) showTab?.('presets');
  } else showTab?.('custom');
  await afterWebConnect();
}

async function afterWebConnect() {
  if (settings.keepBlack && controller.state === 'Ready') {
    await controller.applyKeepBlackIdle(physical(solid(...logicalDims(), [0, 0, 0]))).catch(() => undefined);
  }
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
    <h1>Custom</h1>
    <details class="card custom-section" id="custom-text">
      <summary>Text</summary>
      <p class="section-intro">Shows text and turns into a marquee when it does not fit the cap. Emoji can be used.</p>
      <div class="section-fields">
        <div class="field"><label for="c-str">Text</label><input id="c-str" type="text" maxlength="200" value="HI" /></div>
        <div class="field">
          <label for="c-speed">Scroll speed <b id="c-speed-val" class="field-value">${DEFAULT_SPEED}</b></label>
          <input id="c-speed" type="range" min="1" max="10" step="1" value="${DEFAULT_SPEED}" />
        </div>
        <div class="field-pair">
          <div class="field"><label for="c-fg">Text color</label><input id="c-fg" type="color" value="#ffffff" /></div>
          <div class="field"><label for="c-bg">Background color</label><input id="c-bg" type="color" value="#000000" /></div>
        </div>
        <div class="field">
          <label for="c-font">Font</label>
          <select id="c-font"><option value="">Use Settings default</option>${TEXT_FONTS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}</select>
        </div>
      </div>
      <div class="section-output"></div>
      ${presetSaveNoteMarkup('c')}
      <div class="section-actions"><button id="btn-send" class="primary" disabled>Send to cap</button>${presetSaveInlineMarkup('c')}</div>
    </details>
    <details class="card custom-section" id="custom-solid">
      <summary>Solid color</summary>
      <p class="section-intro">Shows a solid color on the cap.</p>
      <div class="section-fields">
        <div class="field"><label for="c-solid">Color</label><input id="c-solid" type="color" value="#ffffff" /></div>
      </div>
      <div class="section-output"></div>
      ${presetSaveNoteMarkup('solid')}
      <div class="section-actions"><button id="btn-send-solid" class="primary" disabled>Send to cap</button>${presetSaveInlineMarkup('solid')}</div>
    </details>
    <details class="card custom-section" id="custom-image">
      <summary>Image</summary>
      <p class="section-intro">Upload a PNG/JPG/GIF image. Animated GIF is supported.</p>
      <div class="section-fields">
        <div class="field"><label for="c-file">Choose file</label><input id="c-file" type="file" accept="image/png,image/jpeg,image/gif" /></div>
        <div class="field"><label for="c-fit">Fit</label><select id="c-fit"><option>contain</option><option>cover</option><option>stretch</option></select></div>
        <div class="field">
          <label for="c-image-bg">Background color</label><input id="c-image-bg" type="color" value="#000000" aria-describedby="c-image-bg-help" />
          <p id="c-image-bg-help" class="field-hint">Transparent areas are filled with the background color.</p>
        </div>
      </div>
      <div class="section-output"></div>
      ${presetSaveNoteMarkup('image')}
      <div class="section-actions"><button id="btn-send-image" class="primary" disabled>Send to cap</button>${presetSaveInlineMarkup('image')}</div>
    </details>
    <div id="github-section"></div>
    <details class="card custom-section" id="custom-sequence">
      <summary>Sequence</summary>
      <p class="section-intro">Add the last edited Text, Solid color or Image content, or saved presets as steps. The hat plays all steps in order, then loops.</p>
      <div class="section-fields">
        <div class="field">
          <h3 class="field-title" id="c-seq-title">Steps</h3>
          <ol id="c-seq-list" class="seq-list" aria-labelledby="c-seq-title"></ol>
        </div>
        <div class="field">
          <h3 class="field-title">Add steps</h3>
          <div class="row"><button id="btn-seq-add">Add current content</button></div>
          <label for="c-seq-preset" class="field-sublabel">Saved preset</label>
          <div class="row seq-preset-row"><select id="c-seq-preset" aria-label="Saved preset to add"></select><button id="btn-seq-add-preset">Add preset</button></div>
        </div>
        <div class="field">
          <label class="seq-toggle"><input type="checkbox" id="c-seq-on" aria-describedby="c-seq-help" /> Play sequence</label>
          <p id="c-seq-help" class="field-hint"></p>
        </div>
      </div>
      <div class="section-output"></div>
      ${presetSaveNoteMarkup('sequence')}
      <div class="section-actions"><button id="btn-send-sequence" class="primary" disabled>Send to cap</button>${presetSaveInlineMarkup('sequence')}</div>
    </details>
    <div id="content-output" hidden>
      <p id="c-warn" class="warn small"></p>
      <p id="c-err" class="bad small"></p>
      <canvas id="preview" aria-label="Pixel preview"></canvas>
      <button id="btn-cancel" class="danger" hidden>Cancel upload</button>
      <p id="send-help" class="small"></p>
      <progress id="progress" aria-label="Content upload progress" hidden value="0" max="1"></progress>
      <p id="send-note" class="small" role="status">${esc(sendNote)}</p>
    </div>`;
  for (const kind of ['text', 'solid', 'image'] as const) {
    const section = $<HTMLDetailsElement>(`#custom-${kind}`);
    section.ontoggle = () => {
      if (section.open) {
        activeKind = kind;
        if (!sequenceOn) { moveContentOutput(kind); void refreshPreview(); }
      }
    };
    section.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input:not([type=file]), select').forEach((field) => {
      if (field.closest('form')) return;
      field.oninput = () => {
        activeKind = kind;
        $('#c-speed-val').textContent = $<HTMLInputElement>('#c-speed').value;
        persistCustomDrafts();
        if (!sequenceOn) moveContentOutput(kind);
        void refreshPreview();
      };
    });
    const content = () => editorContent(kind);
    $(kind === 'text' ? '#btn-send' : `#btn-send-${kind}`).onclick = () => void sendSection(kind, content);
    initPresetSave(section, kind === 'text' ? 'c' : kind, (name) => saveNamedPreset(name, content()));
  }
  $('#btn-send-sequence').onclick = () => void sendSection('sequence', sequenceContent);
  initPresetSave($('#custom-sequence'), 'sequence', (name) => saveNamedPreset(name, sequenceContent()));
  $<HTMLInputElement>('#c-file').onchange = async (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    $('#c-err').textContent = '';
    try { imageDataUrl = f.type === 'image/gif' ? await gifDataUrl(f) : await shrinkForStorage(f); }
    catch (e) { moveContentOutput('image'); $('#c-err').textContent = (e as Error).message; return; }
    activeKind = 'image';
    persistCustomDrafts();
    if (!sequenceOn) moveContentOutput('image');
    void refreshPreview();
  };
  $('#btn-cancel').onclick = () => controller.cancelUpload();
  $('#btn-seq-add').onclick = () => {
    try { addSequenceSteps([{ content: editorContent(), seconds: DEFAULT_STEP_SECONDS }]); } catch (e) { $('#c-err').textContent = (e as Error).message; }
  };
  $('#btn-seq-add-preset').onclick = async () => {
    const value = $<HTMLSelectElement>('#c-seq-preset').value;
    try {
      const builtIn = value.startsWith('builtin/');
      const id = value.slice(builtIn ? 8 : 6);
      const p = (builtIn ? builtinPresets() : await listPresets()).find((x) => x.id === id);
      if (!p || isGroupPreset(p)) throw new Error('Choose a saved content preset.');
      addSequenceSteps(p.content.kind === 'sequence' ? structuredClone(p.content.steps) : [{ content: p.content, seconds: DEFAULT_STEP_SECONDS }]);
    } catch (e) { $('#c-err').textContent = (e as Error).message; }
  };
  $<HTMLInputElement>('#c-seq-on').onchange = (e) => {
    sequenceOn = (e.target as HTMLInputElement).checked && sequence.length > 0;
    moveContentOutput(sequenceOn ? 'sequence' : activeKind);
    renderSequence();
    void refreshPreview();
  };
  if (savedCreateContent) {
    if (savedCreateContent.kind === 'image') imageDataUrl = savedCreateContent.dataUrl;
    setCreateFrom(savedCreateContent, false);
  }
  applyCustomDrafts(savedCustomDrafts);
  moveContentOutput(sequenceOn ? 'sequence' : activeKind);
  renderSequence();
  void refreshSequencePresets();
  void refreshPreview();
  updateButtons();
}

// ---------- Sequence editor ---------------------------------------------------------

const stepLabel = (c: SingleContent) => c.kind === 'text' ? `Text "${c.text}"` : c.kind === 'solid' ? `Solid ${c.color}` : c.kind === 'github' ? `GitHub ${c.handle}` : 'Image';

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
  moveContentOutput(sequenceOn ? 'sequence' : activeKind);
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
  select.innerHTML = `<optgroup label="Built-in presets">${builtinPresets().map((p) => `<option value="builtin/${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>`
    + `<optgroup label="Saved presets">${presets.map((p) => `<option value="saved/${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>`;
  if (Array.from(select.options).some((p) => p.value === keep)) select.value = keep;
  renderSequence();
}

function moveContentOutput(kind: keyof CustomDrafts | 'sequence') {
  const output = $('#content-output');
  const section = $(`#custom-${kind}`);
  (section.querySelector(':scope > .section-output') ?? section).append(output);
  output.hidden = false;
}

function customDrafts(): CustomDrafts {
  const font = $<HTMLSelectElement>('#c-font').value;
  if (font && !isTextFont(font)) throw new Error('Invalid text font.');
  return {
    text: { kind: 'text', text: $<HTMLInputElement>('#c-str').value,
      fg: $<HTMLInputElement>('#c-fg').value, bg: $<HTMLInputElement>('#c-bg').value,
      speed: Number($<HTMLInputElement>('#c-speed').value), font: isTextFont(font) ? font : null },
    solid: { kind: 'solid', color: $<HTMLInputElement>('#c-solid').value },
    image: { kind: 'image', dataUrl: imageDataUrl, fit: $<HTMLSelectElement>('#c-fit').value as Fit,
      bg: $<HTMLInputElement>('#c-image-bg').value },
  };
}

function persistCustomDrafts() {
  try {
    const drafts = customDrafts();
    void saveKv('customDrafts', drafts).catch((e) => { banner(`<b>Could not save Custom drafts:</b> ${esc((e as Error).message)}`); });
  } catch (e) { $('#c-err').textContent = (e as Error).message; }
}

function applyCustomDrafts(drafts: Partial<CustomDrafts>) {
  if (drafts.text) {
    const c = drafts.text;
    $<HTMLInputElement>('#c-str').value = c.text;
    $<HTMLInputElement>('#c-fg').value = c.fg;
    $<HTMLInputElement>('#c-bg').value = c.bg;
    $<HTMLInputElement>('#c-speed').value = String(c.speed ?? DEFAULT_SPEED);
    $('#c-speed-val').textContent = String(c.speed ?? DEFAULT_SPEED);
    $<HTMLSelectElement>('#c-font').value = c.font ?? '';
  }
  if (drafts.solid) $<HTMLInputElement>('#c-solid').value = drafts.solid.color;
  if (drafts.image) {
    imageDataUrl = drafts.image.dataUrl;
    $<HTMLInputElement>('#c-image-bg').value = drafts.image.bg;
    $<HTMLSelectElement>('#c-fit').value = drafts.image.fit;
    $<HTMLInputElement>('#c-file').value = '';
  }
}

function sequenceContent(): Content {
  return validateContent({ kind: 'sequence', steps: structuredClone(sequence) });
}

function currentContent(): Content {
  if (!document.getElementById('c-str')) {
    if (!savedCreateContent) throw new Error('Choose content on the Custom tab first.');
    return savedCreateContent;
  }
  if (sequenceOn && sequence.length) return { kind: 'sequence', steps: structuredClone(sequence) };
  return editorContent();
}

/** The single content currently in the editor fields, ignoring the sequence. */
function editorContent(kind: keyof CustomDrafts = activeKind): SingleContent {
  if (kind === 'image' && !imageDataUrl) throw new Error('Choose an image first.');
  return customDrafts()[kind];
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
  if (c.kind === 'github') {
    const graph = c.days && c.asOf ? { asOf: c.asOf, days: c.days } : { asOf: todayUtc(), days: await fetchContributions(c.handle, AbortSignal.timeout(15000)) };
    await ensureFont();
    const frames = contributionFrames(c, graph, w, h).map(physical);
    return { image: frames[0]!, frames, delays: frames.map(() => marqueeDelay(c.speed ?? DEFAULT_SPEED)), warnings: [] };
  }
  if (c.kind === 'text') {
    await ensureFont();
    const r = renderText(c.text, w, h, parseHexColor(c.fg), parseHexColor(c.bg), c.font ?? undefined);
    if (r.clipped) { // too wide for the display: scroll it instead
      const m = renderMarquee(c.text, w, h, parseHexColor(c.fg), parseHexColor(c.bg), 2, c.font ?? undefined);
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

async function refreshPreview(content?: Content, rendered?: Awaited<ReturnType<typeof renderContent>>) {
  const seq = ++renderSeq;
  const canvas = document.getElementById('preview') as HTMLCanvasElement | null;
  if (!canvas) return;
  try {
    const selected = content ?? currentContent();
    const { image, frames, delays, warnings } = rendered ?? await renderContent(selected);
    if (seq !== renderSeq) return;
    savedCreateContent = selected;
    createContentChanged();
    void saveKv('createContent', selected).catch((e) => { $('#c-err').textContent = `Could not save Custom content: ${(e as Error).message}`; });
    lastImage = image;
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
    lastImage = null;
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

async function saveNamedPreset(name: string, content: Content) {
  await savePreset({ id: crypto.randomUUID(), name, content: validateContent(content), updatedAt: Date.now() });
  await refreshSequencePresets();
}

async function sendSection(kind: keyof CustomDrafts | 'sequence', content: () => Content) {
  if (sendingContent) return;
  sendingContent = true;
  moveContentOutput(kind);
  updateButtons();
  try {
    const selected = content();
    const rendered = await renderContent(selected);
    if (kind !== 'sequence') { activeKind = kind; sequenceOn = false; renderSequence(); }
    else { sequenceOn = true; renderSequence(); }
    await refreshPreview(selected, rendered);
    if (rendered.frames) await sendMarquee(rendered.frames, rendered.delays ?? []);
    else await sendImage(rendered.image);
  } catch (e) { $('#c-err').textContent = (e as Error).message; }
  finally { sendingContent = false; updateButtons(); }
}

// ---------- Presets view ---------------------------------------------------------

const backupSelection: ShareSelection = { creations: true, approach: true, scan: true, settings: true, sound: true };

function presetButton(p: Preset): string {
  const group = isGroupPreset(p);
  const kind = group ? 'group' : p.content.kind === 'image' && p.content.dataUrl.startsWith('data:image/gif;') ? 'gif' : p.content.kind;
  const icons = {
    text: ['Text', 'M4 5h16M12 5v14M8 19h8'],
    solid: ['Solid color', 'm12 3 9 9-9 9-9-9Z'],
    image: ['Image', 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M8 7h1'],
    gif: ['Animated GIF', 'M3 3h18v18H3zM10 8l6 4-6 4Z'],
    sequence: ['Sequence', 'M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1'],
    github: ['GitHub contributions', 'M3 3h18v18H3zM8 3v18M15 3v18M3 9h18M3 15h18'],
    group: ['Group content', 'M9 8a3 3 0 1 0-6 0 3 3 0 0 0 6 0M21 8a3 3 0 1 0-6 0 3 3 0 0 0 6 0M1 21v-3a5 5 0 0 1 10 0v3M13 21v-3a5 5 0 0 1 10 0v3'],
  } satisfies Record<string, [string, string]>;
  const [label, path] = icons[kind];
  const unavailable = group && !approachAvailable;
  const description = unavailable ? `${label} - requires the native app; kept for backup`
    : !group && p.content.kind === 'sequence' ? `${label} (${p.content.steps.length} steps)` : label;
  return `<button class="preset-send" data-act="${group ? 'apply' : 'send'}" aria-label="${esc(`${group ? 'Apply' : 'Send'} ${p.name}${group ? '' : ' to cap'}`)}" title="${esc(description)}" ${unavailable ? 'disabled' : ''}>
    <svg viewBox="0 0 24 24" role="img" aria-label="Preset type: ${esc(label)}"><path d="${path}"/></svg><span>${esc(p.name)}</span>
  </button>${unavailable ? '<small class="muted">Requires the native app; kept for backup</small>' : ''}`;
}

async function renderPresets() {
  const root = $('#presets-content');
  let presets: Preset[] = [];
  let err = '';
  try { presets = await listPresets(); } catch (e) { err = (e as Error).message; }
  root.innerHTML = `
    <div id="p-share" class="card" hidden></div>
    <div class="card">
      <h2>Built-in presets</h2>
      <p class="small">Available to everyone, including offline. Tap a preset to send it immediately to your connected cap.</p>
      <ul class="list preset-list" id="builtin-presets">${builtinPresets().map((p) => `<li data-id="${esc(p.id)}" data-builtin="true">${presetButton(p)}${native && !useMock ? '<button data-act="share">Share</button>' : ''}</li>`).join('')}</ul>
      <p class="small">Built-in logos use artwork supplied for this app. Party Popper and Octocat use bundled animated GIFs.</p>
    </div>
    <div class="card">
      <h2>Personal presets</h2>
      ${err ? `<p class="bad">${esc(err)}</p>` : ''}
      <ul class="list preset-list">${presets.map((p) => `<li data-id="${esc(p.id)}">${presetButton(p)}${native && !useMock ? '<button data-act="share">Share</button>' : ''}<button data-act="del" class="danger">Delete</button></li>`).join('') || `<li class="muted">No presets yet. Save content on Custom${approachAvailable ? ' or a group preset on Approach' : ''} to find it here.</li>`}</ul>
      <p id="presets-msg" class="small" role="status"></p>
    </div>
    `;
  renderShare();
  updateButtons();
  root.querySelectorAll<HTMLButtonElement>('li button').forEach((b) => b.onclick = async () => {
    const item = b.closest('li')!;
    const id = item.dataset.id!;
    const p = (item.dataset.builtin ? builtinPresets() : presets).find((x) => x.id === id)!;
    if (b.dataset.act === 'share') { openShare(p); return; }
    if (b.dataset.act === 'del') { await deletePreset(id).catch((e) => ($('#presets-msg').textContent = e.message)); void renderPresets(); return; }
    if (isGroupPreset(p)) {
      applyGroupContent(p.groups);
      $('#presets-msg').textContent = `Applied "${p.name}".${approachRunning() ? ' Updating caps.' : ' Start Approach to send group content.'}`;
      return;
    }
    if (sendingContent) return;
    sendingContent = true;
    updateButtons();
    presetSendingBanner = true;
    banner(`Sending "${esc(p.name)}"…`);
    try {
      const rendered = await renderContent(p.content);
      if (rendered.frames) await sendMarquee(rendered.frames, rendered.delays ?? []);
      else await sendImage(rendered.image);
      $('#presets-msg').textContent = `"${p.name}": ${sendNote}${rendered.warnings.length ? ` ${rendered.warnings.join(' ')}` : ''}`;
    } catch (e) { $('#presets-msg').textContent = (e as Error).message; }
    finally {
      if (presetSendingBanner) { presetSendingBanner = false; banner(null); }
      sendingContent = false;
      updateButtons();
    }
  });
}

async function renderBackup(message = '') {
  const root = $('#settings-backup');
  let presets: Preset[] = [];
  let presetError = '';
  try { presets = await listPresets(); } catch (e) { presetError = (e as Error).message; }
  root.innerHTML = `
    <div class="card">
      <h2>Backup</h2>
      ${presetError ? `<p class="bad">${esc(presetError)}</p>` : ''}
      <fieldset class="share-options">
        <legend>Include in shared file</legend>
        <label><input type="checkbox" id="p-include-creations" ${backupSelection.creations ? 'checked' : ''} /> <span>Creations <small>Saved text, colors, images, GIFs, GitHub presets and sequences (${presets.filter((p) => !isGroupPreset(p)).length}), all Custom editor drafts and text fonts, current content and sequence, and GitHub handle, captions, font and scroll speed</small></span></label>
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
  const exportButton = $<HTMLButtonElement>('#btn-export', root);
  const shareOptions = $<HTMLFieldSetElement>('.share-options', root);
  let sharingBackup = false;
  const updateSelection = () => {
    for (const key of ['creations', 'approach', 'scan', 'settings', 'sound'] as const) {
      backupSelection[key] = $<HTMLInputElement>(`#p-include-${key}`, root).checked;
    }
    exportButton.disabled = sharingBackup || !Object.values(backupSelection).some(Boolean);
  };
  for (const key of ['creations', 'approach', 'scan', 'settings', 'sound'] as const) {
    $<HTMLInputElement>(`#p-include-${key}`, root).onchange = updateSelection;
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
          settings: { ...settings, keepBlack: Boolean(settings.keepBlack) },
          ...(backupSelection.creations ? { createContent: activeKind === 'image' && !imageDataUrl && !sequenceOn ? undefined : currentContent(), customDrafts: customDrafts(), createSequence: sequence } : {}),
          ...(backupSelection.creations && github ? { github: github.exportSettings() } : {}),
          ...(backupSelection.scan ? scanner?.exportSettings() : {}),
          ...(backupSelection.sound && sound ? { sound: sound.exportPreferences() } : {}),
        });
      const shared = await shareTextFile('led-hat-presets.json', json, 'application/json', 'LED hat presets');
      $('#p-msg', root).textContent = shared ? 'Selected categories shared.' : '';
    } catch (e) { $('#p-msg', root).textContent = `Share failed: ${(e as Error).message}`; }
    finally { sharingBackup = false; shareOptions.disabled = false; updateSelection(); }
  };
  $<HTMLInputElement>('#p-import', root).onchange = async (ev) => {
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
      const drafts = data.version === 2 ? data.customDrafts : undefined;
      const soundSettings = data.version === 2 && data.sound && sound ? sound.prepareImport(data.sound) : undefined;
      const nextSettings = data.settings ? {
        ...data.settings,
        textFont: data.settings.textFont ?? settings.textFont ?? DEFAULT_TEXT_FONT,
        ...(data.settings.keepBlack !== undefined ? { keepBlack: data.settings.keepBlack }
          : settings.keepBlack !== undefined ? { keepBlack: settings.keepBlack } : {}),
      } : undefined;
      const githubSettings = data.version === 2 && data.github ? github?.prepareImport(data.github) ?? data.github : undefined;
      if (soundSettings) await sound?.stop();
      const importedDraft = createContent && createContent.kind !== 'sequence' && createContent.kind !== 'github'
        ? { [createContent.kind]: createContent } : {};
      const nextDrafts = drafts || Object.keys(importedDraft).length
        ? mergeCustomDrafts(mergeCustomDrafts(customDrafts(), importedDraft), drafts ?? {}) : undefined;
      await restoreBackup(merged, nextSettings, nextApproach, { ...scanSettings, createContent, createSequence, customDrafts: nextDrafts, sound: soundSettings, github: githubSettings });
      if (nextSettings) {
        settings = nextSettings;
        setTextFont(settings.textFont ?? DEFAULT_TEXT_FONT);
        textFontChanged();
        await applyKeepBlack(Boolean(settings.keepBlack), false);
      }
      if (githubSettings) github?.applyImported(githubSettings);
      if (createSequence) { sequence = structuredClone(createSequence); renderSequence(); }
      if (createContent) {
        savedCreateContent = createContent;
        if (createContent.kind === 'image') imageDataUrl = createContent.dataUrl;
        setCreateFrom(createContent, false);
      }
      if (nextDrafts) applyCustomDrafts(nextDrafts);
      if (nextApproach) applyImportedApproachSettings(nextApproach);
      if (scanSettings) scanner?.applyImportedSettings(scanSettings);
      if (soundSettings) sound?.applyImported(soundSettings);
      renderDeviceSettings();
      github?.refreshPreview();
      await refreshPreview();
      await renderPresets();
      await renderBackup(data.version === 1
        ? `Imported ${data.presets.length} presets and ${data.qrProfiles.profiles.length} QR profiles. Restart the connection to apply transport settings.`
        : `Imported shared categories.${data.qrProfiles ? ` Imported ${data.qrProfiles.profiles.length} QR profiles.` : ''} Excluded presets and settings were kept.${data.settings ? ' Restart the connection to apply transport settings.' : ''}`);
    } catch (e) { $('#p-msg', root).textContent = `Import failed: ${(e as Error).message}`; }
  };
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $('#p-persist', root).textContent = persisted ? 'Storage is marked persistent.' : 'Storage may be cleared by the browser. Share a backup regularly.';
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
        if (!$('#view-presets').hidden) void renderPresets();
      }, 0);
    },
    onClosed: (o, _state, message) => { incomingNote = `Preset "${o.name}" not received: ${message}`; renderSharePrompt(); },
  }).then((r) => { receiver = r; }, (e) => console.warn('Preset sharing unavailable', e));
}

function setCreateFrom(c: Content, expand = true) {
  const isSequence = c.kind === 'sequence';
  if (c.kind === 'sequence') {
    sequence = structuredClone(c.steps);
    sequenceOn = true;
    void saveKv('createSequence', sequence).catch((e) => { $('#c-err').textContent = `Could not save sequence: ${(e as Error).message}`; });
    renderSequence();
    c = c.steps[0]!.content;
    if (c.kind === 'image') imageDataUrl = c.dataUrl;
  } else if (sequenceOn) {
    sequenceOn = false;
    renderSequence();
  }
  if (c.kind !== 'github') {
    activeKind = c.kind;
    applyCustomDrafts({ [c.kind]: c });
  }
  const section = isSequence ? 'sequence' : c.kind;
  if (expand) $<HTMLDetailsElement>(`#custom-${section}`).open = true;
  if (section !== 'github') moveContentOutput(section);
}

// ---------- tabs, offline, install, updates ---------------------------------------

let showTab: ((name: string) => boolean) | undefined;

function onTabSelected(name: string) {
  if (!sharedCap()) {
    const url = new URL(location.href); url.hash = name;
    history.replaceState(null, '', url.href);
  }
  if (name !== 'scan') scanner?.stopCamera();
  if (name !== 'sound') void sound?.stop();
  if (name === 'presets') void renderPresets();
  if (name === 'custom') void refreshSequencePresets();
  if (name === 'approach') renderApproach();
  window.scrollTo(0, 0);
}

function setupPwa() {
  if (native) return;
  const updateSW = registerSW({
    onNeedRefresh() {
      const show = () => {
        if (controller.state === 'Uploading' || controller.temporaryActive) { setTimeout(show, 2000); return; } // never reload mid-transfer
        banner('A new version is available. <button id="btn-update" class="primary">Update</button>');
        $('#btn-update').onclick = () => { if (controller.state !== 'Uploading' && !controller.temporaryActive) void updateSW(true); };
      };
      show();
    },
    onRegisterError(e) { console.error(e); },
  });

  setupInstallPrompt();
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
    keepBlack: () => Boolean(settings.keepBlack),
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
  } catch (e) { banner(`<b>Could not restore Custom content:</b> ${esc((e as Error).message)}`); }
  try {
    const drafts = await loadKv('customDrafts');
    if (drafts !== undefined) savedCustomDrafts = validateCustomDrafts(drafts);
  } catch (e) { banner(`<b>Could not restore Custom drafts:</b> ${esc((e as Error).message)}`); }
  try {
    const draft = await loadKv('createSequence');
    if (draft !== undefined) sequence = validateSequenceSteps(draft);
  } catch (e) { banner(`<b>Could not restore the Custom sequence:</b> ${esc((e as Error).message)}`); }
  await initApproach(approachContext());
  initShareReceiver();
  renderCustom();
  renderDeviceSettings();
  // Navigation must not wait for optional features to restore storage or query native capabilities.
  showTab = initTabs($('#tab-bar'), onTabSelected);
  $('#tab-custom').addEventListener('click', () => {
    if (!sharedCap() && !restoringWebConnection && ['Disconnected', 'Error'].includes(controller.state)) {
      $('#btn-connect')?.click();
    }
  });
  void renderPresets();
  void renderBackup();
  applyConnectionGate();
  showTab(location.hash === '#scan' ? 'scan' : 'custom');
  if (!sharedCap()) {
    window.addEventListener('hashchange', () => {
      const requested = location.hash.slice(1);
      if (requested === 'hat') showTab?.(controller.state === 'Ready' ? 'custom' : 'scan');
      else if (['presets', 'custom', 'sound', 'scan', 'settings'].includes(requested)) showTab?.(requested);
    });
    connectionTabClient().onAvailable(() => { void restoreWebConnection(true).catch(() => renderStatus()); });
    void restoreWebConnection(true).catch((error: unknown) => {
      restoreNote = `Could not reach the connection tab: ${error instanceof Error ? error.message : String(error)}`;
      renderStatus();
    });
  }
  renderCreate();
  setupPwa();
  setupAppUpdates();
  void requestPersistence();
  scanner = new GreetingUi({ controller: () => controller, logicalDims, physical, marqueeDelay });
  const scannerReady = scanner.init();
  sound = new SoundUi({ controller: () => controller, logicalDims, physical });
  github = new GitHubUi({ root: $('#github-section'), controller: () => controller, logicalDims, physical, savePreset: saveNamedPreset,
    initialSpeed: Number($<HTMLInputElement>('#c-speed').value) || DEFAULT_SPEED });
  await Promise.all([scannerReady, sound.init(), github.init()]);
}
void main().catch((error: unknown) => {
  console.error('App initialization failed', error);
  banner(`<b>App initialization failed:</b> ${esc(error instanceof Error ? error.message : String(error))}. Reload the app to try again.`);
});
