import type { DeviceController } from '../controller/deviceController';
import type { RgbImage } from '../protocol/framing';
import { encodeGif, gifNonce } from '../render/gif';
import { drawPreview, parseHexColor } from '../render/matrix';
import { ensureFont, renderMarquee } from '../render/text';
import { loadKv, saveKv } from '../storage/db';
import { isNativeApp } from '../platform';
import { analyseFrames, detectSound, enrollVoice, validateVoiceProfile, verifyUtterance, type AudioFeatures, type VoiceProfile } from './analysis';
import { SoundCapture, type Phrase, type SoundCapabilities } from './capture';
import { defaultPreferences, matchPhrase, REACTIONS, validatePreferences, type ReactionId, type SoundPreferences } from './dictionary';

interface SoundContext {
  controller(): DeviceController;
  logicalDims(): [number, number];
  physical(image: RgbImage): RgbImage;
}
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type Mode = 'idle' | 'starting' | 'enrolling' | 'listening' | 'stopping';

export class SoundUi {
  private capture = new SoundCapture();
  private capabilities: SoundCapabilities = { speech: false, proximity: false };
  private preferences = defaultPreferences();
  private profile?: VoiceProfile;
  private mode: Mode = 'idle';
  private generation = 0;
  private features: AudioFeatures[] = [];
  private near = false;
  private blockedUntil = 0;
  private lastReaction = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private proximityTimer?: ReturnType<typeof setTimeout>;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private playing?: DeviceController;
  private rendering = false;
  private saving = false;
  private shutdownFailed = false;
  private stopped: Promise<void> = Promise.resolve();

  constructor(private ctx: SoundContext) {}

  async init() {
    $('view-sound').innerHTML = `
      <div class="card">
        <h2>Sound &amp; voice</h2>
        <p>React to the room on your cap: applause, whistles and your own English or German phrases.</p>
        <div class="row scan-actions">
          <button id="sound-start" class="primary">Start listening</button>
          <button id="sound-stop" hidden>Stop listening</button>
          <button id="sound-end" hidden>End reaction</button>
        </div>
        <p id="sound-status" role="status" aria-live="polite">Not listening. Microphone is off.</p>
        <p id="sound-error" class="bad" role="alert"></p>
        <label for="sound-level">Microphone level</label>
        <meter id="sound-level" min="0" max="1" value="0" aria-label="Microphone level"></meter>
        <p id="sound-ready" class="small"></p>
        <p id="sound-support" class="small"></p>
        <p id="sound-pocket" class="small" role="status"></p>
      </div>
      <div class="card">
        <h2>Recognition</h2>
        <label><input id="sound-noises" type="checkbox" /> Detect applause and whistles</label>
        <label><input id="sound-phrases" type="checkbox" /> Recognize the wearer's phrases</label>
        <label for="sound-language">Conversation language / Gesprächssprache</label>
        <select id="sound-language"><option value="en-US">English</option><option value="de-DE">Deutsch</option></select>
        <p class="small">The dictionary supports both languages. Select the language of this conversation; automatic language switching is not available.</p>
        <label><input id="sound-pause-pocket" type="checkbox" /> Pause recognition while the phone is in a pocket</label>
        <p class="small">A covered proximity sensor suggests a pocket, not proof of one. Audio may be muffled when covered.
        When paused, reactions and analysis stop; microphone capture stays active so recognition can resume when uncovered.</p>
        <label id="sound-browser-consent"><input id="sound-cloud" type="checkbox" /> Allow browser speech recognition, which may send audio to the browser provider</label>
        <p class="small">Native speech uses on-device recognition only. Browser speech is optional and may require an internet connection.
        Without this permission, browser sound detection and voice sampling still work locally.</p>
      </div>
      <div class="card">
        <h2>Your voice sample</h2>
        <p id="sound-profile" role="status"></p>
        <p>In a quiet place, hold the phone as you will use it and speak naturally for 12 seconds.
        Say: “Hello, good morning. Awesome, thank you! Shall we grab some food or coffee? Goodbye, see you later.”</p>
        <p>Deutsch: „Hallo, guten Morgen. Das ist toll, vielen Dank! Gehen wir etwas essen oder einen Kaffee trinken? Tschüss, bis später.“</p>
        <div class="row">
          <button id="sound-enroll">Record voice sample</button>
          <button id="sound-forget">Delete voice sample</button>
        </div>
        <p class="warn small">Experimental speaker filter, not biometric authentication: similar voices, recordings and noisy rooms can cause false accepts or rejections.
        We cannot guarantee that only the wearer triggers phrases. Room sounds intentionally do not require a voice match.</p>
      </div>
      <div class="card">
        <h2>Reactions &amp; dictionary</h2>
        <p class="small">Choose active categories and edit the scrolling cap animation text (up to 40 ASCII characters).
        Reactions play once, then restore the previous cap content. A 10-second cooldown prevents repeated interruptions.
        Applause and whistle detection uses experimental acoustic rules; music and other sounds can trigger them.</p>
        <div id="sound-reactions"></div>
        <label for="sound-preview-choice">Animation preview</label>
        <select id="sound-preview-choice"></select>
        <canvas id="sound-preview" aria-label="Sound reaction animation preview"></canvas>
        <div class="row">
          <button id="sound-preview-button">Preview animation</button>
          <button id="sound-test">Test on cap</button>
        </div>
      </div>
      <div class="card">
        <h2>Privacy &amp; listening limits</h2>
        <p class="small">Listening starts only when you tap a button and stops when you leave this tab, hide or lock the app, or stop it.
        Microphone permission is required. Audio and recognized phrases are not saved by this app.
        Only a local acoustic voice template and your sound settings are saved. Backups can include sound settings, but never the voice template or the browser speech permission.
        Delete the voice sample here to remove the template. Respect other people's privacy when using speech services.</p>
      </div>`;
    const reactions = $('sound-reactions');
    for (const reaction of REACTIONS) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = reaction.label;
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.id = `sound-enable-${reaction.id}`;
      label.append(checkbox, ' Enable this reaction');
      const textLabel = document.createElement('label');
      textLabel.htmlFor = `sound-text-${reaction.id}`; textLabel.textContent = 'Cap animation text';
      const input = document.createElement('input');
      input.id = textLabel.htmlFor; input.type = 'text'; input.maxLength = 40;
      const dictionary = document.createElement('p');
      dictionary.className = 'small';
      dictionary.textContent = reaction.en.length ? `EN: ${reaction.en.join(', ')}. DE: ${reaction.de.join(', ')}.`
        : 'Room sound: no speaker verification.';
      details.append(summary, label, textLabel, input, dictionary);
      reactions.append(details);
      $<HTMLSelectElement>('sound-preview-choice').add(new Option(reaction.label, reaction.id));
    }
    try {
      const saved = await loadKv('soundPreferences');
      if (saved !== undefined) this.preferences = validatePreferences(saved);
      const voice = await loadKv('soundVoice');
      if (voice !== undefined && voice !== null) this.profile = validateVoiceProfile(voice);
    } catch (error) { this.error(`Could not restore sound settings: ${message(error)}`); }
    this.writeControls();
    try { this.capabilities = await this.capture.capabilities(); }
    catch (error) { this.error(message(error)); }
    $('sound-support').textContent = `${this.capabilities.speech ? 'Speech recognition available.' : 'Speech unavailable on this device; use room sounds.'} ${
      this.capabilities.proximity ? 'Proximity sensor available.' : 'No proximity sensor available: pocket detection and automatic pocket pause are unavailable.'}`;
    $('sound-browser-consent').hidden = isNativeApp();
    for (const input of $('view-sound').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
      if (input.id !== 'sound-preview-choice') input.onchange = () => { void this.persist(); };
    }
    $('sound-start').onclick = () => { void this.start(false); };
    $('sound-enroll').onclick = () => { void this.start(true); };
    $('sound-stop').onclick = () => { void this.stop(); };
    $('sound-forget').onclick = () => { void this.forget(); };
    $('sound-end').onclick = () => this.playing?.cancelUpload();
    $('sound-preview-button').onclick = () => { void this.preview(); };
    $('sound-test').onclick = () => { void this.react($<HTMLSelectElement>('sound-preview-choice').value as ReactionId, true); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) void this.stop(); });
    window.addEventListener('pagehide', () => { void this.stop(); });
    this.updateStatus();
  }

  private error(text: string) { $('sound-error').textContent = text; }
  private status(text: string) { $('sound-status').textContent = text; }
  private writeControls() {
    const p = this.preferences;
    $<HTMLInputElement>('sound-noises').checked = p.sounds;
    $<HTMLInputElement>('sound-phrases').checked = p.phrases;
    $<HTMLInputElement>('sound-pause-pocket').checked = p.pauseInPocket;
    $<HTMLInputElement>('sound-cloud').checked = p.allowBrowserSpeech;
    $<HTMLSelectElement>('sound-language').value = p.language;
    for (const { id } of REACTIONS) {
      $<HTMLInputElement>(`sound-enable-${id}`).checked = p.reactions[id].enabled;
      $<HTMLInputElement>(`sound-text-${id}`).value = p.reactions[id].text;
    }
  }
  private readControls(): SoundPreferences {
    return validatePreferences({
      language: $<HTMLSelectElement>('sound-language').value,
      sounds: $<HTMLInputElement>('sound-noises').checked,
      phrases: $<HTMLInputElement>('sound-phrases').checked,
      pauseInPocket: $<HTMLInputElement>('sound-pause-pocket').checked,
      allowBrowserSpeech: $<HTMLInputElement>('sound-cloud').checked,
      reactions: Object.fromEntries(REACTIONS.map(({ id }) => [id, {
        enabled: $<HTMLInputElement>(`sound-enable-${id}`).checked, text: $<HTMLInputElement>(`sound-text-${id}`).value,
      }])),
    });
  }
  private async persist() {
    this.saving = true; this.updateStatus();
    try {
      const preferences = this.readControls();
      await saveKv('soundPreferences', preferences);
      this.preferences = preferences; this.error('');
    } catch (error) { this.error(`Could not save sound settings: ${message(error)}`); }
    finally { this.saving = false; this.updateStatus(); }
  }
  /** Last saved settings, for backups. */
  exportPreferences(): SoundPreferences { return validatePreferences(this.preferences); }
  /** Keep this device's browser speech consent; imported files never grant it. */
  prepareImport(imported: SoundPreferences): SoundPreferences {
    return { ...validatePreferences(imported), allowBrowserSpeech: this.preferences.allowBrowserSpeech };
  }
  /** Call after the import is committed to storage. */
  applyImported(preferences: SoundPreferences) {
    this.preferences = validatePreferences(preferences);
    this.error('');
    this.writeControls();
    this.updateStatus();
  }
  private async forget() {
    this.saving = true; this.updateStatus();
    try { await saveKv('soundVoice', null); this.profile = undefined; this.error(''); }
    catch (error) { this.error(`Could not delete voice sample: ${message(error)}`); }
    finally { this.saving = false; this.updateStatus(); }
  }

  updateStatus() {
    if (!document.getElementById('sound-start')) return;
    const busy = this.mode !== 'idle' || this.saving;
    const target = this.ctx.controller();
    const ready = target.state === 'Ready' && target.canRestoreContent && !target.temporaryActive && !this.rendering;
    $<HTMLButtonElement>('sound-start').disabled = busy || !ready || this.shutdownFailed;
    $('sound-stop').hidden = this.mode === 'idle';
    $<HTMLButtonElement>('sound-stop').disabled = this.mode === 'stopping';
    $('sound-end').hidden = !this.playing;
    $<HTMLButtonElement>('sound-end').disabled = target.state !== 'Ready';
    $('sound-ready').textContent = target.state !== 'Ready' ? 'Connect your primary cap on Connect first.'
      : !target.canRestoreContent ? 'Send content from Connect first so it can be restored after each reaction.'
      : target.temporaryActive ? 'Cap reaction or QR greeting in progress; other detections are ignored.' : 'Primary cap ready. Other caps are not interrupted.';
    $('sound-profile').textContent = this.profile ? 'Voice sample saved on this device.' : 'No voice sample. Record one before enabling phrases.';
    for (const element of $('view-sound').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'))
      element.disabled = busy || this.rendering;
    $<HTMLInputElement>('sound-pause-pocket').disabled ||= !this.capabilities.proximity;
    $<HTMLInputElement>('sound-phrases').disabled ||= !this.capabilities.speech;
    $<HTMLButtonElement>('sound-enroll').disabled = busy || this.rendering || this.shutdownFailed;
    $<HTMLButtonElement>('sound-forget').disabled = busy || !this.profile;
    $<HTMLButtonElement>('sound-preview-button').disabled = busy || this.rendering;
    $<HTMLButtonElement>('sound-test').disabled = busy || !ready;
  }

  private async start(enrolling: boolean) {
    if (this.mode !== 'idle' || this.saving || this.shutdownFailed) return;
    const token = ++this.generation;
    this.mode = 'starting'; this.error(''); this.updateStatus();
    this.status('Starting microphone. Allow microphone access when prompted.');
    try {
      this.preferences = this.readControls();
      if (!enrolling) {
        if (!this.preferences.sounds && !this.preferences.phrases) throw new Error('Enable room sounds or phrases first.');
        if (this.preferences.phrases && !this.profile) throw new Error('Record a voice sample before listening for phrases.');
        if (this.preferences.phrases && !this.capabilities.speech) throw new Error('Speech recognition is not available. Turn off phrases to use room sounds.');
        if (this.preferences.phrases && !isNativeApp() && !this.preferences.allowBrowserSpeech)
          throw new Error('Browser speech may send audio to its provider. Enable that permission explicitly or turn off phrases.');
      }
      await saveKv('soundPreferences', this.preferences);
      if (token !== this.generation) return;
      this.features = []; this.near = false; this.blockedUntil = Date.now(); this.lastReaction = -Infinity;
      await this.capture.start(this.preferences.language, !enrolling && this.preferences.phrases, {
        audio: (frame) => {
          if (token !== this.generation || (this.mode !== 'enrolling' && this.mode !== 'listening')) return;
          try {
            if (this.near && this.preferences.pauseInPocket) return;
            const features = analyseFrames(frame);
            $<HTMLMeterElement>('sound-level').value = Math.min(1, features.at(-1)!.rms * 5);
            this.features.push(...features);
            this.features = this.features.filter((item) => frame.at - item.at < (enrolling ? 15000 : 16000));
            if (!enrolling && this.preferences.sounds && frame.at > this.blockedUntil) {
              const sound = detectSound(this.features);
              if (sound && this.preferences.reactions[sound].enabled) void this.react(sound);
            }
          } catch (error) { this.error(message(error)); void this.stop(); }
        },
        phrase: (phrase) => {
          // Give the last audio block time to arrive before checking utterance coverage.
          setTimeout(() => { if (token === this.generation) this.phrase(phrase); }, 200);
        },
        proximity: (near) => {
          clearTimeout(this.proximityTimer);
          if (!near) { this.setPocket(false); return; }
          this.proximityTimer = setTimeout(() => { if (token === this.generation) this.setPocket(true); }, 500);
        },
        error: (error) => { if (token === this.generation) { this.error(message(error)); void this.stop(); } },
        ended: () => { if (token === this.generation) { void this.stop(); } },
      });
      if (token !== this.generation) return;
      this.mode = enrolling ? 'enrolling' : 'listening'; this.updateStatus();
      if (enrolling) {
        this.status('Recording voice sample for 12 seconds. Speak naturally throughout.');
        this.timer = setTimeout(() => { void this.finishEnrollment(token); }, 12000);
      } else this.status('Listening. Keep this tab open; hiding or locking the app stops listening.');
    } catch (error) {
      if (token === this.generation) { this.error(message(error)); await this.stop(); }
    }
  }

  private setPocket(near: boolean) {
    if (this.near === near) return;
    this.near = near; this.features = []; this.blockedUntil = Date.now();
    $<HTMLMeterElement>('sound-level').value = 0;
    $('sound-pocket').textContent = near
      ? this.preferences.pauseInPocket ? 'Sensor covered: recognition paused. Microphone remains active.' : 'Sensor covered: possible pocket. Audio recognition may be less reliable.'
      : 'Sensor uncovered. Recognition can resume.';
    if (near && this.preferences.pauseInPocket && this.mode === 'enrolling') {
      this.error('Voice sample cancelled: proximity sensor is covered. Uncover the phone and record again.');
      void this.stop();
    }
  }
  private phrase(event: Phrase) {
    if (this.mode !== 'listening' || !this.preferences.phrases || !this.profile
      || event.from < this.blockedUntil || (this.near && this.preferences.pauseInPocket)) return;
    const enabled = REACTIONS.filter((r) => this.preferences.reactions[r.id].enabled).map((r) => r.id);
    const reaction = matchPhrase(event.text, this.preferences.language, enabled);
    if (!reaction) return;
    if (!verifyUtterance(this.features, this.profile, event.from, event.to)) {
      this.status('Phrase ignored: voice did not match the sample, or there was not enough clear speech.'); return;
    }
    void this.react(reaction);
  }
  private async finishEnrollment(token: number) {
    if (token !== this.generation || this.mode !== 'enrolling') return;
    const features = this.features;
    try {
      const profile = enrollVoice(features);
      // Keep controls locked until microphone shutdown and template persistence both finish.
      this.saving = true;
      await this.stop();
      await saveKv('soundVoice', profile);
      this.profile = profile; this.status('Voice sample saved. Enable phrases to recognize your voice.');
    } catch (error) { this.error(message(error)); await this.stop(); }
    finally { this.saving = false; this.updateStatus(); }
  }

  stop(): Promise<void> {
    clearTimeout(this.previewTimer);
    if (this.mode === 'stopping') return this.stopped;
    if (this.mode === 'idle') return this.stopped;
    ++this.generation; this.mode = 'stopping';
    clearTimeout(this.timer); clearTimeout(this.proximityTimer);
    this.features = []; this.updateStatus();
    this.stopped = this.capture.stop().then(() => {
      this.status('Not listening. Microphone is off.');
    }, (error) => {
      this.shutdownFailed = true;
      this.error(`Audio shutdown failed: ${message(error)}. Close the app to ensure microphone access ends.`);
      this.status('Listening stopped; microphone shutdown could not be confirmed.');
    }).finally(() => {
      this.mode = 'idle'; $<HTMLMeterElement>('sound-level').value = 0;
      $('sound-pocket').textContent = ''; this.updateStatus();
    });
    return this.stopped;
  }

  private async frames(id: ReactionId) {
    const reaction = REACTIONS.find((r) => r.id === id)!;
    const preferences = this.readControls();
    await ensureFont();
    const [width, height] = this.ctx.logicalDims();
    return renderMarquee(preferences.reactions[id].text, width, height, parseHexColor(reaction.color), [0, 0, 0]).frames;
  }
  private async preview() {
    this.rendering = true; this.updateStatus(); this.error('');
    try {
      const frames = await this.frames($<HTMLSelectElement>('sound-preview-choice').value as ReactionId);
      if ($('view-sound').hidden || document.hidden) return;
      clearTimeout(this.previewTimer);
      let index = 0;
      const draw = () => {
        drawPreview($<HTMLCanvasElement>('sound-preview'), frames[index++]!);
        if (index < frames.length) this.previewTimer = setTimeout(draw, 60);
      };
      draw();
    } catch (error) { this.error(`Preview failed: ${message(error)}`); }
    finally { this.rendering = false; this.updateStatus(); }
  }
  private async react(id: ReactionId, manual = false) {
    const target = this.ctx.controller();
    const now = Date.now();
    if (this.rendering || this.playing || target.state !== 'Ready' || target.temporaryActive || !target.canRestoreContent) return;
    if (!manual && (this.mode !== 'listening' || now - this.lastReaction < 10000)) return;
    this.lastReaction = now;
    this.rendering = true; this.updateStatus();
    const token = this.generation;
    try {
      const frames = (await this.frames(id)).map((frame) => this.ctx.physical(frame));
      if (target !== this.ctx.controller() || (!manual && (token !== this.generation
        || this.mode !== 'listening' || (this.near && this.preferences.pauseInPocket)))) return;
      this.playing = target; this.updateStatus(); this.error('');
      this.status(`Playing ${REACTIONS.find((r) => r.id === id)!.label}. Previous content will be restored.`);
      await target.playTemporary(encodeGif(frames, 60, { nonce: gifNonce(), plays: 1 }), frames[0]!, frames.length * 60);
      this.status(this.mode === 'listening' ? 'Previous content restored. Listening.'
        : this.shutdownFailed ? 'Previous content restored. Close the app: microphone shutdown was not confirmed.'
        : 'Previous content restored. Microphone is off.');
    } catch (error) { this.error(`Cap reaction failed: ${message(error)}`); }
    finally {
      this.playing = undefined; this.rendering = false;
      this.features = []; this.blockedUntil = Date.now(); this.updateStatus();
    }
  }
}
