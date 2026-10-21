import type { DeviceController } from '../controller/deviceController';
import type { RgbImage } from '../protocol/framing';
import { encodeGif, gifNonce } from '../render/gif';
import { drawPreview } from '../render/matrix';
import { ensureFont, renderStrip } from '../render/text';
import { loadKv, saveKv } from '../storage/db';
import {
  DEFAULT_GITHUB_POSTFIX, DEFAULT_GITHUB_PREFIX, MAX_GITHUB_CAPTION_LENGTH, fetchContributions, formatGitHubCaption,
  renderContributionMarquee, validateGitHubSettings, type Contribution, type GitHubSettings,
} from './contributions';

export class GitHubUi {
  private days: Contribution[] | undefined;
  private loadedHandle = '';
  private busy = false;
  private captionsValid = true;
  private request: AbortController | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private ctx: {
    root: HTMLElement; controller: () => DeviceController;
    logicalDims: () => [number, number]; physical: (image: RgbImage) => RgbImage; frameDelayMs: number;
  }) {}

  async init() {
    this.ctx.root.innerHTML = `
      <div class="card">
        <h2>GitHub contributions</h2>
        <form id="github-form">
          <label for="github-handle">GitHub handle</label>
          <input id="github-handle" type="text" maxlength="39" placeholder="e.g. octocat" autocapitalize="none" spellcheck="false" />
          <p class="small">The past year (53 weeks) scrolls across the hat from right to left, oldest week first, Sunday at the top. Each day uses 2 x 2 LEDs. Dark to bright green means fewer to more contributions.</p>
          <label for="github-prefix">Prefix text (before the graph)</label>
          <input id="github-prefix" type="text" maxlength="${MAX_GITHUB_CAPTION_LENGTH}" />
          <label for="github-postfix">Postfix text (after the graph)</label>
          <input id="github-postfix" type="text" maxlength="${MAX_GITHUB_CAPTION_LENGTH}" />
          <p class="small">Use {handle} to insert the GitHub handle in either field. Printable ASCII and emoji are supported, up to ${MAX_GITHUB_CAPTION_LENGTH} characters per field. Leave empty for no text. Spaces are preserved. Shorter captions upload faster; very long animations may exceed the hat's upload limit.</p>
          <p class="small">Loading sends this public handle to github-contributions-api.jogruber.de. Internet required; results may be cached for one hour. No GitHub token is needed.</p>
          <div class="row"><button id="github-load" type="submit">Load graph</button><button id="github-send" type="button" class="primary" disabled>Show on hat</button><button id="github-cancel" type="button" hidden>Cancel upload</button></div>
        </form>
        <canvas id="github-preview" aria-label="GitHub contribution LED preview" hidden></canvas>
        <p id="github-status" class="small" role="status"></p>
      </div>`;
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
    for (const field of [this.prefix, this.postfix]) field.oninput = () => {
      try {
        const settings = this.exportSettings();
        this.captionsValid = true;
        this.refreshPreview();
        this.note(this.days ? 'Captions updated. Choose Show on hat to send the new animation.' : 'Captions updated. Load the graph when ready.');
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
    try {
      const saved = await loadKv('github');
      if (saved !== undefined) this.applyImported(validateGitHubSettings(saved));
    } catch (e) { this.note(`Could not restore GitHub settings: ${(e as Error).message}`); }
    this.updateStatus();
  }

  private get input() { return this.ctx.root.querySelector<HTMLInputElement>('#github-handle')!; }
  private get prefix() { return this.ctx.root.querySelector<HTMLInputElement>('#github-prefix')!; }
  private get postfix() { return this.ctx.root.querySelector<HTMLInputElement>('#github-postfix')!; }
  private get canvas() { return this.ctx.root.querySelector<HTMLCanvasElement>('#github-preview')!; }
  private button(id: string) { return this.ctx.root.querySelector<HTMLButtonElement>(`#${id}`)!; }
  private note(message: string) { this.ctx.root.querySelector('#github-status')!.textContent = message; }
  exportSettings(): GitHubSettings {
    return validateGitHubSettings({ handle: this.input.value.trim(), prefix: this.prefix.value, postfix: this.postfix.value });
  }

  prepareImport(settings: GitHubSettings): GitHubSettings {
    return validateGitHubSettings({
      handle: settings.handle,
      prefix: settings.prefix ?? this.prefix.value,
      postfix: settings.postfix ?? this.postfix.value,
    });
  }

  applyImported(settings: GitHubSettings) {
    this.request?.abort();
    this.input.value = settings.handle;
    if (settings.prefix !== undefined) this.prefix.value = settings.prefix;
    if (settings.postfix !== undefined) this.postfix.value = settings.postfix;
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
    this.button('github-load').disabled = this.busy;
    this.button('github-send').disabled = this.busy || !this.days || !this.captionsValid || controller.state !== 'Ready' || controller.temporaryActive;
    this.button('github-cancel').hidden = !this.busy || controller.state !== 'Uploading';
  }

  private frames(): RgbImage[] {
    const [width, height] = this.ctx.logicalDims();
    const settings = this.exportSettings();
    const before = renderStrip(formatGitHubCaption(settings.prefix ?? DEFAULT_GITHUB_PREFIX, this.loadedHandle), height, [255, 255, 255], [0, 0, 0]).strip;
    const after = renderStrip(formatGitHubCaption(settings.postfix ?? DEFAULT_GITHUB_POSTFIX, this.loadedHandle), height, [255, 255, 255], [0, 0, 0]).strip;
    return renderContributionMarquee(this.days!, width, height, new Date(), 2, { before, after }).map(this.ctx.physical);
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
      this.previewTimer = setTimeout(tick, this.ctx.frameDelayMs);
    };
    this.canvas.hidden = false;
    tick();
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
      this.loadedHandle = settings.handle;
      this.refreshPreview();
      this.note(`Graph ready for ${settings.handle}. Connect your hat, then choose Show on hat.`);
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
      const gif = encodeGif(frames, frames.map(() => this.ctx.frameDelayMs), { nonce: gifNonce() });
      const { width, height } = frames[0]!;
      const result = await this.ctx.controller().uploadGif(gif, width, height, frames[0]);
      this.note(result === 'confirmed' ? `Contribution graph for ${this.loadedHandle} is scrolling on the hat.` : 'Sent, not confirmed.');
    } catch (e) { this.note(`Graph upload failed: ${(e as Error).message}`); }
    finally { this.busy = false; this.updateStatus(); }
  }
}
