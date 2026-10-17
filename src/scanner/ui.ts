import type { DeviceController } from '../controller/deviceController';
import type { RgbImage } from '../protocol/framing';
import { encodeGif, gifNonce } from '../render/gif';
import { parseHexColor, solid } from '../render/matrix';
import { ensureFont, renderSpanMarquee } from '../render/text';
import { gifDelayMs } from '../render/span';
import { loadKv, saveKv } from '../storage/db';
import { QrCamera } from './camera';
import { extractNameSafely } from './extract';
import { appendScanLog, shareScanLog } from './log';
import {
  DEFAULT_GREETING, greetingDuration, greetingText, validateGreeting, validateGreetingProfiles,
  type ExtractedName, type GreetingProfile, type GreetingProfileState, type GreetingSettings,
} from './greeting';

interface ScannerContext {
  controller(): DeviceController;
  logicalDims(): [number, number];
  physical(image: RgbImage): RgbImage;
  marqueeDelay(speed: number): number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class GreetingUi {
  private camera = new QrCamera();
  private scanning = false;
  private processing = false;
  private playing?: DeviceController;
  private scanId = 0;
  private profiles: GreetingProfile[] = [];
  private selectedProfileId: string | null = null;
  private loggingEnabled = false;
  private savingLogging = false;
  private sharingLog = false;

  constructor(private ctx: ScannerContext) {}

  async init() {
    $('view-scan').innerHTML = `
      <div class="card">
        <h2>QR greeting</h2>
        <div class="row scan-actions">
          <button id="qr-start" class="primary">Scan QR code</button>
          <button id="qr-stop" hidden>Stop camera</button>
          <button id="qr-cancel" hidden>End greeting</button>
        </div>
        <video id="qr-video" playsinline muted hidden aria-label="QR camera preview"></video>
        <p id="qr-status" role="status" aria-live="polite"></p>
        <p id="qr-error" class="bad" role="alert"></p>
        <p id="qr-ready" class="small" role="status"></p>
        <p class="small">Scan a badge to greet its owner on this phone's primary cap. Other caps keep playing.
        Send content to the cap first so it can be restored afterwards.</p>
        <label for="qr-profile">Saved QR profile</label>
        <select id="qr-profile"><option value="">None — general QR data</option></select>
      </div>
      <div class="card">
        <h2>QR profile</h2>
        <label for="qr-note">Profile note</label>
        <input id="qr-note" type="text" maxlength="60" placeholder="e.g. MS AI Tour" />
        <div class="row">
          <button id="qr-profile-save">Save profile</button>
          <button id="qr-profile-delete" hidden>Delete profile</button>
        </div>
        <p class="small">Save up to three profiles. Select None for the default plain-text, JSON or vCard extraction.</p>
        <label for="qr-pattern">Name regex (optional)</label>
        <input id="qr-pattern" type="text" maxlength="300" spellcheck="false" aria-describedby="qr-pattern-help" />
        <p id="qr-pattern-help" class="small">Without a regex: plain names, JSON names and vCards.
        Regex capture groups 1–3 map to firstname, lastname and company. Named groups may use firstname or name,
        lastname, and company. Example for MS AI Tour badges: ^[^^]*\\^(?&lt;firstname&gt;[^^]+)\\^(?&lt;lastname&gt;[^^]+)\\^(?&lt;company&gt;[^^]+)\\^.
        Enter the pattern without / delimiters.</p>
      </div>
      <div class="card">
        <h2>Greeting settings</h2>
        <label for="qr-template">Greeting</label>
        <input id="qr-template" type="text" maxlength="200" aria-describedby="qr-template-help" />
        <p id="qr-template-help" class="small">Use {name} or {firstname}, {lastname} and {company} for the captured fields.</p>
        <label for="qr-repetitions">Repetitions</label>
        <input id="qr-repetitions" type="number" min="1" max="65536" step="1" />
        <label for="qr-speed">Scroll speed</label>
        <input id="qr-speed" type="range" min="1" max="10" step="1" />
        <details>
          <summary>Enter QR data manually</summary>
          <label for="qr-raw">QR data (not saved)</label>
          <textarea id="qr-raw" rows="3" maxlength="4096"></textarea>
          <button id="qr-submit">Greet from QR data</button>
        </details>
      </div>
      <div class="card">
        <h2>Scan log &amp; privacy</h2>
        <label><input id="qr-log-enabled" type="checkbox" /> Save all scanned data to a local file</label>
        <p class="small">Off by default. When enabled, logs complete QR payloads (including failed greetings and manual entries),
        timestamps and profile notes in qr-scan-log.jsonl. This may include personal data.
        Turning logging off keeps the existing file. Logs are separate from preset backups.
        Share only with trusted recipients.</p>
        <button id="qr-log-share">Share scan log</button>
        <p id="qr-log-status" role="status" aria-live="polite"></p>
        <p id="qr-log-error" class="bad" role="alert"></p>
        <p class="small">QR data is processed locally and is only saved when logging is enabled. Only the greeting is sent to your cap over Bluetooth.
        Camera access requires permission.
        Keep the app open until the previous content is restored.</p>
        <p class="small">Inspired by <a href="https://github.com/xebia/badge-scanner" target="_blank" rel="noopener noreferrer">Rob Bos / Xebia's badge-scanner</a>.
        QR decoding: <a href="https://github.com/zxing-js/browser" target="_blank" rel="noopener noreferrer">ZXing Browser (MIT)</a>,
        <a href="https://github.com/zxing-js/library" target="_blank" rel="noopener noreferrer">ZXing JS (Apache-2.0)</a>.
        Independent integration; no badge-scanner source code copied.
        <a href="${import.meta.env.BASE_URL}licenses/scanner-credits.txt">Credits and licenses</a>.</p>
      </div>`;
    let settings: GreetingSettings = DEFAULT_GREETING;
    try {
      const saved = await loadKv('qrGreeting');
      if (saved !== undefined) settings = validateGreeting(saved);
    } catch (e) { this.error(`Could not restore scanner settings: ${this.message(e)}`); }
    try {
      const savedProfiles = await loadKv('qrGreetingProfiles');
      if (savedProfiles !== undefined) {
        const state = validateGreetingProfiles(savedProfiles);
        this.profiles = state.profiles;
        this.selectedProfileId = state.selectedId;
        const selected = this.profiles.find((profile) => profile.id === this.selectedProfileId);
        if (selected) settings = { ...settings, pattern: selected.pattern, template: selected.template };
      }
    } catch (e) { this.error(`Could not restore saved QR profiles: ${this.message(e)}`); }
    try {
      const enabled = await loadKv('qrScanLogging');
      if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Invalid logging preference.');
      this.loggingEnabled = enabled === true;
    } catch (e) { $('qr-log-error').textContent = `Could not restore scan logging preference: ${this.message(e)}`; }
    $<HTMLInputElement>('qr-log-enabled').checked = this.loggingEnabled;
    this.renderProfiles();
    $<HTMLSelectElement>('qr-profile').value = this.selectedProfileId ?? '';
    const selectedProfile = this.profiles.find((profile) => profile.id === this.selectedProfileId);
    $<HTMLInputElement>('qr-note').value = selectedProfile?.note ?? '';
    $<HTMLInputElement>('qr-pattern').value = settings.pattern;
    $<HTMLInputElement>('qr-template').value = settings.template;
    $<HTMLInputElement>('qr-repetitions').value = String(settings.repetitions);
    $<HTMLInputElement>('qr-speed').value = String(settings.speed);
    for (const id of ['qr-pattern', 'qr-template', 'qr-repetitions', 'qr-speed']) {
      $(id).onchange = () => { void this.persist(); };
    }
    $('qr-profile').onchange = () => { void this.selectProfile($<HTMLSelectElement>('qr-profile').value || null); };
    $('qr-profile-save').onclick = () => { void this.saveProfile(); };
    $('qr-profile-delete').onclick = () => { void this.deleteProfile(); };
    $('qr-start').onclick = () => { void this.scan(); };
    $('qr-stop').onclick = () => this.stopCamera();
    $('qr-submit').onclick = () => { void this.greet($<HTMLTextAreaElement>('qr-raw').value, this.ctx.controller(), 'manual'); };
    $('qr-log-enabled').onchange = () => { void this.setLogging(); };
    $('qr-log-share').onclick = () => { void this.shareLog(); };
    $('qr-cancel').onclick = () => this.playing?.cancelUpload();
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stopCamera(); });
    window.addEventListener('pagehide', () => this.stopCamera());
    this.updateStatus();
  }

  private message(e: unknown) { return e instanceof Error ? e.message : String(e); }
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

  private async shareLog() {
    this.sharingLog = true;
    this.updateStatus();
    $('qr-log-error').textContent = '';
    $('qr-log-status').textContent = '';
    try {
      const result = await shareScanLog();
      $('qr-log-status').textContent = result === 'downloaded' ? 'Scan log downloaded.' : result === 'cancelled' ? 'Sharing cancelled.' : 'Scan log share dialog closed.';
    } catch (e) { $('qr-log-error').textContent = `Could not share scan log: ${this.message(e)}. Enable logging and scan a QR code to create the file.`; }
    finally { this.sharingLog = false; this.updateStatus(); }
  }
  private error(message: string) { $('qr-error').textContent = message; }
  private status(message: string) { $('qr-status').textContent = message; }
  private readSettings() {
    return validateGreeting({
      pattern: $<HTMLInputElement>('qr-pattern').value,
      template: $<HTMLInputElement>('qr-template').value,
      repetitions: Number($<HTMLInputElement>('qr-repetitions').value),
      speed: Number($<HTMLInputElement>('qr-speed').value),
    });
  }

  private async persist() {
    try { await saveKv('qrGreeting', this.readSettings()); this.error(''); }
    catch (e) { this.error(`Could not save scanner settings: ${this.message(e)}`); }
  }

  private renderProfiles() {
    const select = $<HTMLSelectElement>('qr-profile');
    select.replaceChildren(new Option('None — general QR data', ''));
    for (const profile of this.profiles) select.add(new Option(`${profile.id}. ${profile.note}`, profile.id));
    $<HTMLButtonElement>('qr-profile-delete').hidden = !this.selectedProfileId;
  }

  exportProfiles(): GreetingProfileState {
    return validateGreetingProfiles({ profiles: this.profiles, selectedId: this.selectedProfileId });
  }

  async importProfiles(value: GreetingProfileState) {
    const state = validateGreetingProfiles(value);
    const active = state.profiles.find((profile) => profile.id === state.selectedId);
    const settings = validateGreeting({
      ...this.readSettings(),
      pattern: active?.pattern ?? DEFAULT_GREETING.pattern,
      template: active?.template ?? DEFAULT_GREETING.template,
    });
    await Promise.all([
      saveKv('qrGreetingProfiles', state),
      saveKv('qrGreeting', settings),
    ]);
    this.profiles = state.profiles;
    this.selectedProfileId = state.selectedId;
    this.renderProfiles();
    $<HTMLSelectElement>('qr-profile').value = this.selectedProfileId ?? '';
    $<HTMLInputElement>('qr-note').value = active?.note ?? '';
    $<HTMLInputElement>('qr-pattern').value = settings.pattern;
    $<HTMLInputElement>('qr-template').value = settings.template;
  }

  private async persistProfiles(profiles = this.profiles, selectedId = this.selectedProfileId) {
    await saveKv('qrGreetingProfiles', validateGreetingProfiles({ profiles, selectedId }));
  }

  private async selectProfile(id: string | null) {
    const profile = this.profiles.find((item) => item.id === id);
    if (id && !profile) {
      this.error('That QR profile is no longer saved.');
      return;
    }
    this.selectedProfileId = id;
    $<HTMLSelectElement>('qr-profile').value = id ?? '';
    $<HTMLInputElement>('qr-note').value = profile?.note ?? '';
    $<HTMLInputElement>('qr-pattern').value = profile?.pattern ?? DEFAULT_GREETING.pattern;
    $<HTMLInputElement>('qr-template').value = profile?.template ?? DEFAULT_GREETING.template;
    try {
      await Promise.all([saveKv('qrGreeting', this.readSettings()), this.persistProfiles()]);
      this.error('');
    } catch (e) { this.error(`Could not select QR profile: ${this.message(e)}`); }
  }

  private async saveProfile() {
    try {
      const settings = this.readSettings();
      const note = $<HTMLInputElement>('qr-note').value.trim();
      if (!note || note.length > 60) throw new Error('Add a profile note of at most 60 characters.');
      const id = this.selectedProfileId ?? ['1', '2', '3'].find((slot) => !this.profiles.some((profile) => profile.id === slot));
      if (!id) throw new Error('All three profile slots are in use. Select one to replace it.');
      const profile = { id, note, pattern: settings.pattern, template: settings.template };
      const profiles = [...this.profiles.filter((item) => item.id !== id), profile].sort((a, b) => a.id.localeCompare(b.id));
      await this.persistProfiles(profiles, id);
      this.profiles = profiles;
      this.selectedProfileId = id;
      this.renderProfiles();
      $<HTMLSelectElement>('qr-profile').value = id;
      this.error('');
      this.status(`Saved QR profile "${note}".`);
    } catch (e) { this.error(`Could not save QR profile: ${this.message(e)}`); }
  }

  private async deleteProfile() {
    if (!this.selectedProfileId) return;
    const profiles = this.profiles.filter((profile) => profile.id !== this.selectedProfileId);
    try {
      await this.persistProfiles(profiles, null);
      this.profiles = profiles;
      this.selectedProfileId = null;
      this.renderProfiles();
      $<HTMLInputElement>('qr-note').value = '';
      $<HTMLInputElement>('qr-pattern').value = DEFAULT_GREETING.pattern;
      $<HTMLInputElement>('qr-template').value = DEFAULT_GREETING.template;
      await saveKv('qrGreeting', this.readSettings());
      this.error('');
      this.status('Deleted QR profile.');
    } catch (e) { this.error(`Could not delete QR profile: ${this.message(e)}`); }
  }

  updateStatus() {
    if (!document.getElementById('qr-start')) return;
    const ctl = this.ctx.controller();
    const unavailable = ctl.state !== 'Ready' || !ctl.canRestoreContent || ctl.temporaryActive || this.processing || this.sharingLog || this.savingLogging;
    $('qr-ready').textContent = this.scanning ? '' : ctl.state !== 'Ready' ? 'Connect your primary cap on Connect before scanning.'
      : !ctl.canRestoreContent ? 'Send content from Connect first so it can be restored after the greeting.'
      : ctl.temporaryActive || this.processing ? 'Wait for the current greeting to finish, or end it above.'
      : this.sharingLog || this.savingLogging ? 'Wait for the scan log operation to finish.' : 'Ready to scan a badge.';
    $<HTMLButtonElement>('qr-start').disabled = unavailable || this.scanning;
    $<HTMLButtonElement>('qr-submit').disabled = unavailable || this.scanning;
    $('qr-stop').hidden = !this.scanning;
    $('qr-cancel').hidden = !this.playing;
    $<HTMLInputElement>('qr-log-enabled').disabled = this.processing || this.scanning || this.savingLogging || this.sharingLog;
    $<HTMLButtonElement>('qr-log-share').disabled = this.processing || this.scanning || this.sharingLog;
    for (const id of ['qr-profile', 'qr-note', 'qr-pattern', 'qr-template', 'qr-repetitions', 'qr-speed', 'qr-raw', 'qr-profile-save', 'qr-profile-delete']) {
      $<HTMLInputElement>(id).disabled = this.processing || this.scanning;
    }
  }

  stopCamera() {
    this.scanId++;
    const wasScanning = this.scanning;
    this.camera.stop();
    this.scanning = false;
    const video = $<HTMLVideoElement>('qr-video');
    if (video) { video.srcObject = null; video.hidden = true; }
    if (wasScanning) this.status('Camera stopped.');
    this.updateStatus();
  }

  private async scan() {
    const target = this.ctx.controller();
    const attempt = ++this.scanId;
    this.scanning = true;
    this.updateStatus();
    try {
      const settings = this.readSettings();
      await saveKv('qrGreeting', settings);
      if (attempt !== this.scanId) return;
      this.error('');
      const video = $<HTMLVideoElement>('qr-video');
      video.hidden = false;
      this.status('Starting camera. Allow camera access when prompted.');
      await this.camera.start(video, (raw) => {
        this.stopCamera();
        void this.greet(raw, target, 'camera');
      }, (e) => { this.stopCamera(); this.error(`Camera failed: ${this.message(e)}. Retry or enter QR data manually.`); });
      if (this.scanning) this.status('Point the camera at a QR code. The greeting starts immediately after scanning.');
    } catch (e) {
      if (attempt !== this.scanId) return;
      this.stopCamera();
      this.error(`Could not start scanner: ${this.message(e)}. Retry or enter QR data manually.`);
    }
  }

  private async greet(raw: string, target: DeviceController, source: 'camera' | 'manual') {
    if (this.processing) return;
    this.processing = true;
    this.error('');
    this.updateStatus();
    try {
      if (this.loggingEnabled) {
        const profile = this.profiles.find((item) => item.id === this.selectedProfileId);
        try {
          await appendScanLog({
            timestamp: new Date().toISOString(), source, raw,
            profile: profile ? { id: profile.id, note: profile.note } : null,
          });
          $('qr-log-error').textContent = '';
          $('qr-log-status').textContent = 'Scan saved to qr-scan-log.jsonl.';
        } catch (e) { $('qr-log-error').textContent = `Scan was NOT saved: ${this.message(e)}`; }
      }
      const settings = this.readSettings();
      await saveKv('qrGreeting', settings);
      const extracted: ExtractedName = await extractNameSafely(raw, settings.pattern);
      const text = greetingText(settings.template, extracted);
      await ensureFont();
      const [width, height] = this.ctx.logicalDims();
      const marquee = renderSpanMarquee(text, width, height, 1, 0, parseHexColor('#ffffff'), parseHexColor('#000000'));
      if (marquee.unsupported.length) throw new Error(`Unsupported characters: ${marquee.unsupported.join(' ')}. Adjust the regex or greeting.`);
      const frames = marquee.frames.map((frame) => this.ctx.physical(frame));
      frames.push(this.ctx.physical(solid(width, height, [0, 0, 0])));
      const delay = gifDelayMs(this.ctx.marqueeDelay(settings.speed) * marquee.step / 2);
      const duration = greetingDuration(frames.length, delay, settings.repetitions);
      if (target !== this.ctx.controller()) throw new Error('The primary cap changed. Scan again for the current cap.');
      this.playing = target;
      this.updateStatus();
      this.status(`Playing "${text}" ${settings.repetitions} time(s), then restoring the previous content.`);
      const result = await target.playTemporary(encodeGif(frames, delay, { nonce: gifNonce(), plays: settings.repetitions }), frames[0]!, duration);
      this.status(result === 'cancelled' ? 'Greeting ended early. Previous content restored.' : 'Greeting finished. Previous content restored.');
      $<HTMLTextAreaElement>('qr-raw').value = '';
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
