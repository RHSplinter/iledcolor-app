import type { DeviceController } from '../controller/deviceController';
import type { RgbImage } from '../protocol/framing';
import { encodeGif, gifNonce } from '../render/gif';
import { parseHexColor, solid } from '../render/matrix';
import { ensureFont, renderSpanMarquee } from '../render/text';
import { gifDelayMs } from '../render/span';
import { loadKv, saveKv } from '../storage/db';
import { vibrateFeedback } from '../feedback';
import { BadgeCamera } from './camera';
import { appendScanLog, shareScanLog } from './log';
import { BadgeTextRecognizer } from './ocr';
import { differingGithubHandles, fetchPublicProfile, findGithubHandle, findGithubHandles } from './githubLookup';
import {
  DEFAULT_GREETING, extractName, greetingDuration, greetingNameFields, greetingText, isValidEmail, validateGreeting,
  type ExtractedName, type GreetingSettings, type ScannerBackup,
} from './greeting';

interface ScannerContext {
  controller(): DeviceController;
  logicalDims(): [number, number];
  physical(image: RgbImage): RgbImage;
  marqueeDelay(speed: number): number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class GreetingUi {
  private camera = new BadgeCamera();
  private recognizer = new BadgeTextRecognizer();
  private scanning = false;
  private recognizing = false;
  private processing = false;
  private playing?: DeviceController;
  private scanId = 0;
  private loggingEnabled = false;
  private lookupId = 0;
  private savingLogging = false;
  private sharingLog = false;
  private statusMessage = '';
  private errorMessage = '';

  constructor(private ctx: ScannerContext) {}

  async init() {
    $('view-scan').innerHTML = `
      <div class="card">
        <h2>Visitor scanning</h2>
        <div class="row scan-actions">
          <button id="qr-text-start" class="primary">Scan</button>
          <button id="qr-stop" hidden>Stop camera</button>
          <button id="qr-cancel" hidden>End greeting</button>
        </div>
        <div id="qr-video-wrap" hidden>
          <video id="qr-video" playsinline muted aria-label="Badge camera preview"></video>
          <div id="qr-reticle" hidden aria-hidden="true"></div>
        </div>
        <div id="qr-ocr-controls" hidden>
          <p class="small">Frame the printed name and company, then capture. Text is recognized on this device.</p>
          <button id="qr-capture" class="primary">Capture text</button>
        </div>
        <p id="qr-status" class="scan-status" role="status" aria-live="polite" aria-atomic="true"></p>
        <p id="qr-github-result" class="scan-status" role="status" aria-live="polite" hidden></p>
        <form id="qr-data" hidden aria-label="Scanned visitor data">
          <hr class="scan-data-divider" />
          <table class="scan-data-table">
            <caption>Scanned visitor data</caption>
            <tbody id="qr-data-rows"></tbody>
          </table>
          <div class="row scan-data-actions">
            <button id="qr-data-save" type="submit" class="primary">Save</button>
            <button id="qr-data-clear" type="button">Clear</button>
          </div>
        </form>
      </div>
      <div class="card">
        <h2>Greeting settings</h2>
        <label for="qr-template">Greeting</label>
        <input id="qr-template" type="text" maxlength="200" aria-describedby="qr-template-help" />
        <p id="qr-template-help" class="small">Use {name} or {firstname}, {lastname}, {role}, {company}, or {githubhandle} for captured fields.</p>
        <label for="qr-repetitions">Repetitions</label>
        <input id="qr-repetitions" type="number" min="1" max="65536" step="1" />
        <label for="qr-speed">Scroll speed</label>
        <input id="qr-speed" type="range" min="1" max="10" step="1" />
      </div>`;
    $('settings-scan').innerHTML = `
      <div class="card">
        <h2>Scan log &amp; privacy</h2>
        <label><input id="qr-log-enabled" type="checkbox" /> Save all scanned data to a local file</label>
        <p class="small">Off by default. When enabled, logs complete camera and OCR scan data (including failed greetings),
        timestamps and extracted fields in qr-scan-log.jsonl. This may include personal data.
        Turning logging off keeps the existing file. Logs are separate from preset backups.
        Share only with trusted recipients.</p>
        <button id="qr-log-share">Share scan log</button>
        <p id="qr-log-status" role="status" aria-live="polite"></p>
        <p id="qr-log-error" class="bad" role="alert"></p>
        <p class="small">Scan data and OCR are processed locally and are only saved when logging is enabled. Only the greeting is sent to your cap over Bluetooth
        (plus recognized GitHub handles to api.github.com to find public email addresses).
        Public emails are shown in the scan fields and included in the log when logging is enabled.
        Camera access requires permission. The English text-recognition model is bundled for offline use.
        Keep the app open until the previous content is restored.</p>
        <p class="small">Inspired by <a href="https://github.com/xebia/badge-scanner" target="_blank" rel="noopener noreferrer">Rob Bos / Xebia's badge-scanner</a>.
        Independent integration; no badge-scanner source code copied.
        <a href="${import.meta.env.BASE_URL}licenses/scanner-credits.txt">Credits and licenses</a>.</p>
      </div>`;
    let settings: GreetingSettings = DEFAULT_GREETING;
    try {
      const saved = await loadKv('qrGreeting');
      if (saved !== undefined) settings = validateGreeting(saved);
    } catch (e) { this.error(`Could not restore scanner settings: ${this.message(e)}`); }
    try {
      const enabled = await loadKv('qrScanLogging');
      if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Invalid logging preference.');
      this.loggingEnabled = enabled === true;
    } catch (e) { $('qr-log-error').textContent = `Could not restore scan logging preference: ${this.message(e)}`; }
    $<HTMLInputElement>('qr-log-enabled').checked = this.loggingEnabled;
    $<HTMLInputElement>('qr-template').value = settings.template;
    $<HTMLInputElement>('qr-repetitions').value = String(settings.repetitions);
    $<HTMLInputElement>('qr-speed').value = String(settings.speed);
    for (const id of ['qr-template', 'qr-repetitions', 'qr-speed']) {
      $(id).onchange = () => { void this.persist(); };
    }
    $('qr-text-start').onclick = () => { void this.scanText(); };
    $('qr-capture').onclick = () => { void this.captureText(); };
    $('qr-stop').onclick = () => this.stopCamera();
    $('qr-log-enabled').onchange = () => { void this.setLogging(); };
    $('qr-log-share').onclick = () => { void this.shareLog(); };
    $('qr-cancel').onclick = () => this.playing?.cancelUpload();
    $('qr-data').onsubmit = (event) => event.preventDefault();
    $('qr-data-clear').onclick = () => {
      this.clearScanData();
      this.statusMessage = '';
      this.errorMessage = '';
      this.updateStatus();
      $('qr-text-start').focus();
    };
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stopCamera(); });
    window.addEventListener('pagehide', () => this.stopCamera());
    this.updateStatus();
  }

  private message(e: unknown) { return e instanceof Error ? e.message : String(e); }

  private clearScanData() {
    this.lookupId++;
    $('qr-github-result').textContent = '';
    $('qr-github-result').hidden = true;
    $('qr-data-rows').replaceChildren();
    $('qr-data').hidden = true;
  }

  private showScanData(extracted: ExtractedName, raw: string) {
    const { firstname, lastname } = greetingNameFields(extracted);
    const fields = [
      { type: 'firstname', label: 'First name', value: firstname },
      { type: 'lastname', label: 'Last name', value: lastname },
      { type: 'github', label: 'GitHub Handle', value: extracted.github ?? findGithubHandle(raw) ?? '' },
      { type: 'role', label: 'Role', value: extracted.title ?? '' },
      { type: 'company', label: 'Company', value: extracted.company ?? '' },
    ];
    const rows = fields.map((field, index) => {
      const row = document.createElement('tr');
      const valueCell = row.insertCell();
      const typeCell = row.insertCell();
      const input = document.createElement('input');
      input.type = 'text';
      input.value = field.value;
      input.setAttribute('aria-label', `Data item ${index + 1}`);
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Data item ${index + 1} type`);
      for (const option of fields) select.add(new Option(option.label, option.type));
      select.value = field.type;
      const normalizeHandle = () => {
        if (select.value === 'github' && input.value) input.value = `@${input.value.replace(/^@+/, '')}`;
      };
      input.oninput = normalizeHandle;
      select.onchange = normalizeHandle;
      normalizeHandle();
      valueCell.append(input);
      typeCell.append(select);
      return row;
    });
    const labelledRow = (id: string, type: string, label: string, value = '') => {
      const row = document.createElement('tr');
      const input = document.createElement('input');
      input.id = id;
      input.type = type;
      input.value = value;
      input.setAttribute('aria-label', label);
      row.insertCell().append(input);
      const labelElement = document.createElement('label');
      labelElement.htmlFor = input.id;
      labelElement.textContent = label;
      row.insertCell().append(labelElement);
      return { row, input };
    };
    const { row: emailRow, input: email } = labelledRow('qr-data-email', 'email', 'Email address');
    const { row: phoneRow, input: phone } = labelledRow('qr-data-phone', 'tel', 'Phone number', extracted.phone ?? '');
    phone.autocomplete = 'off';
    const save = $<HTMLButtonElement>('qr-data-save');
    const validateEmail = () => {
      const valid = isValidEmail(email.value);
      if (valid) email.removeAttribute('aria-invalid');
      else email.setAttribute('aria-invalid', 'true');
      save.disabled = !valid;
    };
    email.addEventListener('blur', validateEmail);
    // Once flagged, re-check while typing so the error clears as soon as the address is fixed.
    email.addEventListener('input', () => { if (email.hasAttribute('aria-invalid')) validateEmail(); });
    save.disabled = false;
    $('qr-data-rows').replaceChildren(...rows, emailRow, phoneRow);
    $('qr-data').hidden = false;
  }

  private async setLogging() {
    const input = $<HTMLInputElement>('qr-log-enabled');
    this.savingLogging = true;
    this.updateStatus();
    try {
      await saveKv('qrScanLogging', input.checked);
      this.loggingEnabled = input.checked;
      $('qr-log-error').textContent = '';
      $('qr-log-status').textContent = this.loggingEnabled ? 'Scan logging enabled.' : 'Scan logging disabled. Existing log kept.';
    } catch (e) {
      input.checked = this.loggingEnabled;
      $('qr-log-error').textContent = `Could not save logging preference: ${this.message(e)}`;
    } finally { this.savingLogging = false; this.updateStatus(); }
  }

  private async lookupGithub(raw: string, scanId: string) {
    const result = $('qr-github-result');
    const email = $<HTMLInputElement>('qr-data-email');
    let edited = false;
    email.addEventListener('input', () => { edited = true; }, { once: true });
    const id = ++this.lookupId;
    result.textContent = '';
    result.hidden = true;
    const { printed, configured } = findGithubHandles(raw);
    const handles = [...new Map([printed, configured].flatMap((h) => h ? [[h.toLowerCase(), h] as const] : [])).values()];
    if (!handles.length) return;
    result.hidden = false;
    result.textContent = `Checking GitHub for ${handles.map((h) => `@${h}`).join(' and ')}…`;
    try {
      const results = await Promise.all(handles.map(async (handle) => ({
        handle, origin: handle === printed ? 'printed' as const : 'configured' as const,
        profile: await fetchPublicProfile(handle, AbortSignal.timeout(8000)),
      })));
      if (id !== this.lookupId) return;
      const publicEmail = results.find(({ profile }) => profile?.email)?.profile?.email;
      if (publicEmail && !edited && !email.value) email.value = publicEmail;
      result.textContent = results.map(({ handle, origin, profile }) => {
        const label = results.length > 1 ? (origin === 'printed' ? 'printed ' : 'badge screen ') : '';
        return !profile ? `${label}@${handle} was not found on GitHub. Check the OCR text.`
          : profile.email ? `${label}@${profile.login} public email: ${profile.email}`
          : `${label}@${profile.login} has no public email.`;
      }).join(' ');
      if (this.loggingEnabled) {
        try {
          await appendScanLog({
            timestamp: new Date().toISOString(), scanId, source: 'ocr', raw,
            githubLookup: results.map(({ handle, origin, profile }) => ({
              handle, origin, found: !!profile, ...(profile ? { login: profile.login, email: profile.email } : {}),
            })),
          });
        } catch (e) { $('qr-log-error').textContent = `GitHub lookup results were NOT saved: ${this.message(e)}`; }
      }
    } catch (e) {
      if (id === this.lookupId) result.textContent = `GitHub lookup failed: ${this.message(e)}`;
    }
  }

  private async shareLog() {
    this.sharingLog = true;
    this.updateStatus();
    $('qr-log-error').textContent = '';
    $('qr-log-status').textContent = '';
    try {
      const result = await shareScanLog();
      $('qr-log-status').textContent = result === 'downloaded' ? 'Scan log downloaded.' : result === 'cancelled' ? 'Sharing cancelled.' : 'Scan log share dialog closed.';
    } catch (e) { $('qr-log-error').textContent = `Could not share scan log: ${this.message(e)}. Enable logging and scan a badge to create the file.`; }
    finally { this.sharingLog = false; this.updateStatus(); }
  }
  private error(message: string) {
    this.errorMessage = message;
    if (message) this.statusMessage = '';
    this.updateStatus();
  }
  private status(message: string) {
    this.statusMessage = message;
    this.updateStatus();
  }
  private readSettings() {
    return validateGreeting({
      template: $<HTMLInputElement>('qr-template').value,
      repetitions: Number($<HTMLInputElement>('qr-repetitions').value),
      speed: Number($<HTMLInputElement>('qr-speed').value),
    });
  }

  private async persist() {
    try { await saveKv('qrGreeting', this.readSettings()); this.error(''); }
    catch (e) { this.error(`Could not save scanner settings: ${this.message(e)}`); }
  }

  exportSettings(): ScannerBackup {
    return { qrGreeting: this.readSettings(), qrScanLogging: this.loggingEnabled };
  }

  prepareImport(value: ScannerBackup): ScannerBackup {
    return {
      ...(value.qrGreeting !== undefined ? { qrGreeting: validateGreeting(value.qrGreeting) } : {}),
      ...(value.qrScanLogging !== undefined ? { qrScanLogging: value.qrScanLogging } : {}),
      ...(value.qrGithubLookup !== undefined ? { qrGithubLookup: value.qrGithubLookup } : {}),
    };
  }

  applyImportedSettings(value: ScannerBackup) {
    if (value.qrGreeting) {
      const settings = value.qrGreeting;
      $<HTMLInputElement>('qr-template').value = settings.template;
      $<HTMLInputElement>('qr-repetitions').value = String(settings.repetitions);
      $<HTMLInputElement>('qr-speed').value = String(settings.speed);
    }
    if (value.qrScanLogging !== undefined) {
      this.loggingEnabled = value.qrScanLogging;
      $<HTMLInputElement>('qr-log-enabled').checked = this.loggingEnabled;
      $('qr-log-status').textContent = this.loggingEnabled ? 'Scan logging enabled by imported settings.' : 'Scan logging disabled. Existing log kept.';
    }
  }

  updateStatus() {
    if (!document.getElementById('qr-text-start')) return;
    const ctl = this.ctx.controller();
    const unavailable = ctl.state !== 'Ready' || ctl.temporaryActive || this.processing || this.sharingLog || this.savingLogging;
    const readiness = this.scanning ? 'Starting camera. Allow camera access when prompted.' : ctl.state !== 'Ready' ? 'Connect your primary cap before scanning.'
      : ctl.temporaryActive || this.processing ? 'Wait for the current greeting to finish, or end it above.'
      : this.sharingLog || this.savingLogging ? 'Wait for the scan log operation to finish.' : 'Ready to scan a badge.';
    const status = $('qr-status');
    status.textContent = this.errorMessage ? [this.errorMessage, this.statusMessage].filter(Boolean).join(' ')
      : (ctl.state !== 'Ready' && !this.processing && !this.scanning) || this.sharingLog || this.savingLogging
        ? readiness : this.statusMessage || readiness;
    status.classList.toggle('bad', !!this.errorMessage);
    status.setAttribute('role', this.errorMessage ? 'alert' : 'status');
    status.setAttribute('aria-live', this.errorMessage ? 'assertive' : 'polite');
    $<HTMLButtonElement>('qr-text-start').disabled = unavailable || this.scanning;
    const video = $<HTMLVideoElement>('qr-video');
    const videoReady = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
    $<HTMLButtonElement>('qr-capture').disabled = !this.scanning || this.recognizing || !videoReady;
    $('qr-video-wrap').hidden = !this.scanning;
    $('qr-ocr-controls').hidden = !this.scanning;
    $('qr-reticle').hidden = !this.scanning;
    $('qr-stop').hidden = !this.scanning;
    $('qr-cancel').hidden = !this.playing;
    $<HTMLInputElement>('qr-log-enabled').disabled = this.processing || this.scanning || this.savingLogging || this.sharingLog;
    $<HTMLButtonElement>('qr-log-share').disabled = this.processing || this.scanning || this.sharingLog;
    for (const id of ['qr-template', 'qr-repetitions', 'qr-speed']) {
      $<HTMLInputElement>(id).disabled = this.processing || this.scanning;
    }
  }

  stopCamera() {
    this.scanId++;
    const wasScanning = this.scanning;
    this.camera.stop();
    this.scanning = false;
    const video = $<HTMLVideoElement>('qr-video');
    if (video) { video.onloadeddata = null; video.srcObject = null; }
    if (wasScanning) this.status('Camera stopped.');
    this.updateStatus();
  }

  private async scanText() {
    const attempt = ++this.scanId;
    this.scanning = true;
    this.error('');
    this.status('Starting camera. Allow camera access when prompted.');
    try {
      const settings = this.readSettings();
      await saveKv('qrGreeting', settings);
      if (attempt !== this.scanId) return;
      this.error('');
      const video = $<HTMLVideoElement>('qr-video');
      video.onloadeddata = () => this.updateStatus();
      this.status('Starting camera. Allow camera access when prompted.');
      await this.camera.preview(video);
      if (this.scanning) this.status('Frame the printed name and company, then capture the text.');
    } catch (e) {
      if (attempt !== this.scanId) return;
      this.stopCamera();
      this.error(`Could not start scanner: ${this.message(e)}. Retry or check camera permissions.`);
    }
  }

  private async captureText() {
    if (!this.scanning || this.recognizing) return;
    const video = $<HTMLVideoElement>('qr-video');
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
      this.error('Camera is not ready yet. Wait for the preview, then capture again.');
      return;
    }
    const canvas = document.createElement('canvas');
    const inset = 0.15;
    const bounds = video.getBoundingClientRect();
    const scale = Math.max(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
    const visibleWidth = bounds.width / scale;
    const visibleHeight = bounds.height / scale;
    const sx = Math.round((video.videoWidth - visibleWidth) / 2 + visibleWidth * inset);
    const sy = Math.round((video.videoHeight - visibleHeight) / 2 + visibleHeight * inset);
    canvas.width = Math.round(visibleWidth * (1 - inset * 2));
    canvas.height = Math.round(visibleHeight * (1 - inset * 2));
    const context = canvas.getContext('2d');
    if (!context) {
      this.error('Text recognition is unavailable because canvas rendering failed.');
      return;
    }
    context.drawImage(video, sx, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);

    const attempt = this.scanId;
    const target = this.ctx.controller();
    this.recognizing = true;
    this.updateStatus();
    this.error('');
    this.status('Loading the offline text recognizer…');
    try {
      const raw = await this.recognizer.recognize(canvas, (status, progress) => {
        if (attempt === this.scanId) this.status(`${status} (${Math.round(progress * 100)}%)…`);
      });
      if (attempt !== this.scanId) return;
      this.stopCamera();
      const scanId = new Date().toISOString();
      void this.greet(raw, target, 'ocr', scanId);
    } catch (e) {
      if (attempt === this.scanId) {
        this.error(`Text recognition failed: ${this.message(e)}`);
        this.status('Adjust the badge position or lighting, then capture again.');
      }
    } finally {
      this.recognizing = false;
      this.updateStatus();
    }
  }

  private async greet(raw: string, target: DeviceController, source: 'ocr' | 'manual', scanId = new Date().toISOString()) {
    if (this.processing) return;
    this.processing = true;
    this.clearScanData();
    this.error('');
    this.status('Preparing greeting…');
    try {
      if (this.loggingEnabled) {
        let loggedFields: ExtractedName | undefined;
        try { loggedFields = extractName(raw); } catch { /* raw text is still logged */ }
        try {
          await appendScanLog({
            timestamp: scanId, scanId, source, raw,
            ...(loggedFields ? { extracted: loggedFields } : {}),
            ...(source === 'ocr' ? (() => { const githubHandles = differingGithubHandles(raw); return githubHandles ? { githubHandles } : {}; })() : {}),
          });
          $('qr-log-error').textContent = '';
          $('qr-log-status').textContent = 'Scan saved to qr-scan-log.jsonl.';
        } catch (e) { $('qr-log-error').textContent = `Scan was NOT saved: ${this.message(e)}`; }
      }
      const extracted = extractName(raw);
      this.showScanData(extracted, raw);
      if (source === 'ocr') void this.lookupGithub(raw, scanId);
      const settings = this.readSettings();
      await saveKv('qrGreeting', settings);
      const text = greetingText(settings.template, extracted);
      await ensureFont();
      const [width, height] = this.ctx.logicalDims();
      const marquee = renderSpanMarquee(text, width, height, 1, 0, parseHexColor('#ffffff'), parseHexColor('#000000'));
      if (marquee.unsupported.length) throw new Error(`Unsupported characters: ${marquee.unsupported.join(' ')}. Adjust the scan data or greeting.`);
      const frames = marquee.frames.map((frame) => this.ctx.physical(frame));
      frames.push(this.ctx.physical(solid(width, height, [0, 0, 0])));
      const delay = gifDelayMs(this.ctx.marqueeDelay(settings.speed) * marquee.step / 2);
      const duration = greetingDuration(frames.length, delay, settings.repetitions);
      if (target !== this.ctx.controller()) throw new Error('The primary cap changed. Scan again for the current cap.');
      if (target.state !== 'Ready' || target.temporaryActive) {
        throw new Error(target.temporaryActive ? 'A greeting is already playing'
          : 'Connect the primary cap first');
      }
      const gif = encodeGif(frames, delay, { nonce: gifNonce(), plays: settings.repetitions });
      this.playing = target;
      this.updateStatus();
      const restoreMessage = target.canRestoreContent ? 'Previous content restored.' : 'Display cleared to black.';
      this.status(`Playing "${text}" ${settings.repetitions} time(s), then ${target.canRestoreContent ? 'restoring the previous content' : 'clearing the display to black'}.`);
      void vibrateFeedback();
      const result = await target.playTemporary(gif, frames[0]!, duration, { clearIfUnknown: true });
      this.status(`${result === 'cancelled' ? 'Greeting ended early.' : 'Greeting finished.'} ${restoreMessage}`);
    } catch (e) {
      this.status('');
      this.error(`Greeting failed: ${this.message(e)}`);
    } finally {
      this.processing = false;
      this.playing = undefined;
      this.updateStatus();
    }
  }
}
