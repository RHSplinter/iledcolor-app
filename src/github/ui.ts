import type { DeviceController } from '../controller/deviceController';
import type { RgbImage } from '../protocol/framing';
import { encodeGif, gifNonce } from '../render/gif';
import { drawPreview } from '../render/matrix';
import { ensureFont, renderStrip } from '../render/text';
import { TEXT_FONTS } from '../render/fonts';
import { loadKv, saveKv } from '../storage/db';
import { DEFAULT_SPEED, type Content } from '../storage/presets';
import { initPresetSave, presetSaveInlineMarkup, presetSaveNoteMarkup } from '../ui/presetSave';
import {
  DEFAULT_GITHUB_POSTFIX, DEFAULT_GITHUB_PREFIX, MAX_GITHUB_CAPTION_LENGTH, fetchContributions, formatGitHubCaption,
  graphDate, renderContributionMarquee, validateGitHubSettings, type Contribution, type GitHubGraph, type GitHubSettings,
} from './contributions';

/** Logical marquee frames; a stored graph is drawn as of the day it was loaded. Fonts must be loaded. */
export function contributionFrames(settings: GitHubSettings, graph: GitHubGraph, width: number, height: number): RgbImage[] {
  const font = settings.font ?? undefined;
  const before = renderStrip(formatGitHubCaption(settings.prefix ?? DEFAULT_GITHUB_PREFIX, settings.handle), height, [255, 255, 255], [0, 0, 0], font).strip;
  const after = renderStrip(formatGitHubCaption(settings.postfix ?? DEFAULT_GITHUB_POSTFIX, settings.handle), height, [255, 255, 255], [0, 0, 0], font).strip;
  return renderContributionMarquee(graph.days, width, height, graphDate(graph.asOf), 2, { before, after });
}

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

export class GitHubUi {
  private days: Contribution[] | undefined;
  private asOf = '';
  private loadedHandle = '';
  private busy = false;
  private captionsValid = true;
  private request: AbortController | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private ctx: {
    root: HTMLElement; controller: () => DeviceController;
    logicalDims: () => [number, number]; physical: (image: RgbImage) => RgbImage;
    savePreset: (name: string, content: Content) => Promise<void>;
    initialSpeed?: number;
  }) {}

  async init() {
    this.ctx.root.innerHTML = `
      <details class="card custom-section" id="custom-github">
        <summary>GitHub Contributions</summary>
        <div class="section-intro">
          <p>Shows the GitHub contribution graph for the given user, surrounded by optional text.</p>
          <p>The past year (53 weeks) scrolls across the hat from right to left, oldest week first, Sunday at the top. Each day uses 2 x 2 LEDs. Dark to bright green means fewer to more contributions.</p>
        </div>
        <form id="github-form" class="section-fields">
          <div class="field">
            <label for="github-handle">GitHub handle</label>
            <input id="github-handle" type="text" maxlength="39" placeholder="e.g. octocat" autocapitalize="none" spellcheck="false" aria-describedby="github-handle-help" />
            <p id="github-handle-help" class="field-hint">Loading sends this public handle to github-contributions-api.jogruber.de. Internet required; results may be cached for one hour. No GitHub token is needed. Presets saved after loading keep that graph, so they also work offline; load the preset's graph again to refresh it.</p>
          </div>
          <div class="field">
            <label for="github-speed">Scroll speed <b id="github-speed-val" class="field-value">${this.ctx.initialSpeed ?? DEFAULT_SPEED}</b></label>
            <input id="github-speed" type="range" min="1" max="10" step="1" value="${this.ctx.initialSpeed ?? DEFAULT_SPEED}" />
          </div>
          <div class="field">
            <label for="github-prefix">Prefix text (before the graph)</label>
            <input id="github-prefix" type="text" maxlength="${MAX_GITHUB_CAPTION_LENGTH}" aria-describedby="github-caption-help" />
          </div>
          <div class="field">
            <label for="github-postfix">Postfix text (after the graph)</label>
            <input id="github-postfix" type="text" maxlength="${MAX_GITHUB_CAPTION_LENGTH}" aria-describedby="github-caption-help" />
          </div>
          <p id="github-caption-help" class="field-hint">Use {handle} to insert the GitHub handle in either field.</p>
          <div class="field">
            <label for="github-font">Font</label>
            <select id="github-font"><option value="">Use Settings default</option>${TEXT_FONTS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}</select>
          </div>
        </form>
        <div class="section-output">
          <canvas id="github-preview" aria-label="GitHub contribution LED preview" hidden></canvas>
          <p id="github-status" class="small" role="status"></p>
        </div>
        ${presetSaveNoteMarkup('github')}
        <div class="section-actions">
          <button id="github-load" type="submit" form="github-form">Load graph</button>
          <button id="github-send" type="button" class="primary" disabled>Send to cap</button>
          <button id="github-cancel" type="button" hidden>Cancel upload</button>
          ${presetSaveInlineMarkup('github')}
        </div>
      </details>`;
    this.prefix.value = DEFAULT_GITHUB_PREFIX;
    this.postfix.value = DEFAULT_GITHUB_POSTFIX;
    this.input.oninput = () => {
      this.days = undefined;
      this.hidePreview();
      this.note('Load the graph to preview this handle.');
      this.updateStatus();
    };
    this.input.onchange = () => {
      try { void saveKv('github', this.exportSettings()).catch((e: Error) => this.note(`Could not save GitHub settings: ${e.message}`)); }
      catch (e) { this.note((e as Error).message); }
    };
    for (const field of [this.prefix, this.postfix, this.speed, this.font]) field.oninput = () => {
      try {
        const settings = this.exportSettings();
        this.ctx.root.querySelector('#github-speed-val')!.textContent = this.speed.value;
        this.captionsValid = true;
        this.refreshPreview();
        this.note(this.days ? 'Settings updated. Choose Send to cap to send the new animation.' : 'Settings updated. Load the graph when ready.');
        void saveKv('github', settings).catch((e: Error) => this.note(`Could not save GitHub settings: ${e.message}`));
      } catch (e) {
        this.captionsValid = false;
        this.hidePreview();
        this.note((e as Error).message);
      }
      this.updateStatus();
    };
    this.ctx.root.querySelector<HTMLFormElement>('#github-form')!.onsubmit = (event) => { event.preventDefault(); void this.load(); };
    this.button('github-send').onclick = () => void this.send();
    this.button('github-cancel').onclick = () => this.ctx.controller().cancelUpload();
    initPresetSave(this.ctx.root, 'github', async (name) => {
      const settings = this.exportSettings();
      if (!settings.handle) throw new Error('Enter a GitHub handle first.');
      const graph = this.days && this.loadedHandle === settings.handle ? { asOf: this.asOf, days: this.days } : {};
      await this.ctx.savePreset(name, { kind: 'github', ...settings, ...graph });
    });
    try {
      const saved = await loadKv('github');
      if (saved !== undefined) this.applyImported(validateGitHubSettings(saved));
    } catch (e) { this.note(`Could not restore GitHub settings: ${(e as Error).message}`); }
    this.updateStatus();
  }

  private get input() { return this.ctx.root.querySelector<HTMLInputElement>('#github-handle')!; }
  private get prefix() { return this.ctx.root.querySelector<HTMLInputElement>('#github-prefix')!; }
  private get postfix() { return this.ctx.root.querySelector<HTMLInputElement>('#github-postfix')!; }
  private get speed() { return this.ctx.root.querySelector<HTMLInputElement>('#github-speed')!; }
  private get font() { return this.ctx.root.querySelector<HTMLSelectElement>('#github-font')!; }
  private get canvas() { return this.ctx.root.querySelector<HTMLCanvasElement>('#github-preview')!; }
  private button(id: string) { return this.ctx.root.querySelector<HTMLButtonElement>(`#${id}`)!; }
  private note(message: string) { this.ctx.root.querySelector('#github-status')!.textContent = message; }
  exportSettings(): GitHubSettings {
    return validateGitHubSettings({
      handle: this.input.value.trim(), prefix: this.prefix.value, postfix: this.postfix.value, speed: Number(this.speed.value), font: this.font.value || null,
    });
  }

  prepareImport(settings: GitHubSettings): GitHubSettings {
    return validateGitHubSettings({
      handle: settings.handle,
      prefix: settings.prefix ?? this.prefix.value,
      postfix: settings.postfix ?? this.postfix.value,
      speed: settings.speed ?? Number(this.speed.value),
      font: settings.font !== undefined ? settings.font : this.font.value || null,
    });
  }

  applyImported(settings: GitHubSettings) {
    this.request?.abort();
    this.input.value = settings.handle;
    if (settings.prefix !== undefined) this.prefix.value = settings.prefix;
    if (settings.postfix !== undefined) this.postfix.value = settings.postfix;
    if (settings.speed !== undefined) this.speed.value = String(settings.speed);
    if (settings.font !== undefined) this.font.value = settings.font ?? '';
    this.ctx.root.querySelector('#github-speed-val')!.textContent = this.speed.value;
    this.captionsValid = true;
    this.days = undefined;
    this.hidePreview();
    this.note('GitHub settings restored. Load the graph when ready.');
    this.updateStatus();
  }

  updateStatus() {
    if (!this.input) return;
    const controller = this.ctx.controller();
    this.input.disabled = this.busy;
    this.prefix.disabled = this.busy;
    this.postfix.disabled = this.busy;
    this.speed.disabled = this.busy;
    this.font.disabled = this.busy;
    this.button('github-load').disabled = this.busy;
    this.button('github-send').disabled = this.busy || !this.days || !this.captionsValid || controller.state !== 'Ready' || controller.temporaryActive;
    this.button('github-cancel').hidden = !this.busy || controller.state !== 'Uploading';
  }

  private frames(): RgbImage[] {
    const [width, height] = this.ctx.logicalDims();
    const settings = this.exportSettings();
    return contributionFrames(settings, { asOf: this.asOf, days: this.days! }, width, height).map(this.ctx.physical);
  }

  private hidePreview() {
    clearTimeout(this.previewTimer);
    this.canvas.hidden = true;
  }

  refreshPreview() {
    if (!this.days) return;
    if (!this.captionsValid) return;
    clearTimeout(this.previewTimer);
    const frames = this.frames();
    let i = 0;
    const tick = () => {
      // Stop when the section is re-rendered or removed.
      if (!this.canvas.isConnected) return;
      drawPreview(this.canvas, frames[i]!);
      i = (i + 1) % frames.length;
      this.previewTimer = setTimeout(tick, Math.round(220 / Number(this.speed.value)));
    };
    this.canvas.hidden = false;
    tick();
  }

  /** Presets with a stored graph are shown without contacting GitHub; settings-only presets load a fresh graph. */
  async loadPreset(content: GitHubSettings & Partial<GitHubGraph>) {
    this.applyImported(this.prepareImport(content));
    void saveKv('github', this.exportSettings()).catch((e: Error) => this.note(`Could not save GitHub settings: ${e.message}`));
    this.ctx.root.querySelector<HTMLDetailsElement>('details')!.open = true;
    if (!content.days || !content.asOf) { await this.load(); return; }
    await ensureFont();
    this.days = content.days;
    this.asOf = content.asOf;
    this.loadedHandle = content.handle;
    this.refreshPreview();
    this.note(`Saved graph for ${content.handle} from ${content.asOf}. Choose Send to cap, or Load graph to refresh it.`);
    this.updateStatus();
  }

  private async load() {
    if (this.busy) return;
    this.busy = true;
    this.days = undefined;
    this.hidePreview();
    this.updateStatus();
    this.request = new AbortController();
    const timer = setTimeout(() => this.request?.abort(), 15000);
    try {
      const settings = this.exportSettings();
      if (!settings.handle) throw new Error('Enter a GitHub handle first.');
      this.captionsValid = true;
      this.note('Loading contributions...');
      await saveKv('github', settings);
      const days = await fetchContributions(settings.handle, this.request.signal);
      await ensureFont();
      if (this.request.signal.aborted) return;
      this.days = days;
      this.asOf = todayUtc();
      this.loadedHandle = settings.handle;
      this.refreshPreview();
      this.note(`Graph ready for ${settings.handle}. Choose Send to cap.`);
    } catch (e) {
      this.note(this.request.signal.aborted ? 'Loading cancelled or timed out. Try again.' : `Could not load contributions: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      this.busy = false;
      this.updateStatus();
    }
  }

  private async send() {
    if (this.busy || !this.days) return;
    this.busy = true;
    this.updateStatus();
    this.note('Sending contribution animation...');
    try {
      const frames = this.frames();
      const delay = Math.round(220 / Number(this.speed.value));
      const gif = encodeGif(frames, frames.map(() => delay), { nonce: gifNonce() });
      const { width, height } = frames[0]!;
      const result = await this.ctx.controller().uploadGif(gif, width, height, frames[0]);
      this.note(result === 'confirmed' ? `Contribution graph for ${this.loadedHandle} is scrolling on the hat.` : 'Sent, not confirmed.');
    } catch (e) { this.note(`Graph upload failed: ${(e as Error).message}`); }
    finally { this.busy = false; this.updateStatus(); }
  }
}
