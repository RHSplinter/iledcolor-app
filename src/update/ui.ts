import {
  RELEASES_PAGE, autoCheckDue, checkForUpdate, installUpdate, markAutoCheck,
  type AvailableUpdate, type UpdatePlatform,
} from './appUpdate';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface UpdateUiOptions {
  root: HTMLElement;
  /** Null in the browser: the PWA service worker handles web updates. */
  platform: UpdatePlatform | null;
  currentVersion: string;
  banner: (html: string | null) => void;
  /** Installing leaves the app, so never start it during an upload or a temporary display. */
  busy: () => boolean;
  fetchFn?: typeof fetch;
}

export class UpdateUi {
  private note = '';
  private update: AvailableUpdate | undefined;
  private checking = false;
  private installing = false;

  constructor(private readonly o: UpdateUiOptions) {}

  render(): void {
    const { root, platform, currentVersion } = this.o;
    const u = this.update;
    root.innerHTML = `
      <div class="card" id="app-update">
        <h2>App updates</h2>
        <p>Installed version: <b id="upd-current">${esc(currentVersion)}</b></p>
        ${platform ? `
          <div class="row">
            <button id="upd-check" ${this.checking || this.installing ? 'disabled' : ''}>Check for updates</button>
            ${u ? `<button id="upd-install" class="primary" ${this.installing ? 'disabled' : ''}>${platform === 'android' ? 'Download &amp; install' : 'Install'} ${esc(u.version)}</button>` : ''}
          </div>
          <p id="upd-note" class="small" role="status">${esc(this.note)}</p>
          ${u ? `<p class="small"><a href="${esc(u.pageUrl)}" target="_blank" rel="noopener">Release notes for ${esc(u.tag)}</a></p>` : ''}
          <p class="small">Checks <a href="${RELEASES_PAGE}" target="_blank" rel="noopener">GitHub Releases</a> at startup (at most every 6 hours). ${platform === 'android'
            ? 'The APK is verified against its published SHA-256 checksum before Android asks you to confirm the installation.'
            : 'iOS installs only on devices registered in the Ad Hoc provisioning profile.'}</p>`
        : '<p class="small">The web app updates itself when a new version is deployed.</p>'}
      </div>`;
    const check = root.querySelector<HTMLButtonElement>('#upd-check');
    if (check) check.onclick = () => void this.check(true);
    const install = root.querySelector<HTMLButtonElement>('#upd-install');
    if (install) install.onclick = () => void this.install();
  }

  /** Startup check: silent on errors and throttled; only an available update is surfaced. */
  async autoCheck(): Promise<void> {
    if (!this.o.platform || !autoCheckDue()) return;
    markAutoCheck();
    await this.check(false);
  }

  async check(manual: boolean): Promise<void> {
    const { platform, currentVersion } = this.o;
    if (!platform || this.checking) return;
    this.checking = true;
    if (manual) { this.note = 'Checking…'; this.render(); }
    try {
      const result = await checkForUpdate(platform, currentVersion, this.o.fetchFn);
      if (result.status === 'available') {
        this.update = result.update;
        this.note = `Version ${result.update.version} is available.`;
        this.offer(result.update);
      } else {
        this.update = undefined;
        this.note = `You have the latest version${result.latest ? ` (${result.latest})` : ''}.`;
      }
      if (manual) markAutoCheck();
    } catch (e) {
      this.note = `Update check failed: ${(e as Error).message}`;
      if (!manual) console.warn('Automatic update check failed', e);
    } finally {
      this.checking = false;
      this.render();
    }
  }

  private offer(u: AvailableUpdate): void {
    this.o.banner(`LED Hat ${esc(u.version)} is available. <button id="btn-app-update" class="primary">Update</button> <button id="btn-app-update-later">Later</button>`);
    const b = document.getElementById('btn-app-update');
    if (b) b.onclick = () => void this.install();
    const later = document.getElementById('btn-app-update-later');
    if (later) later.onclick = () => this.o.banner(null);
  }

  async install(): Promise<void> {
    const { platform } = this.o;
    const u = this.update;
    if (!platform || !u || this.installing) return;
    if (this.o.busy()) { this.note = 'Wait until the current transfer finishes, then try again.'; this.render(); return; }
    this.installing = true;
    this.o.banner(null);
    this.note = platform === 'android' ? 'Downloading…' : 'Opening the iOS installer…';
    this.render();
    try {
      const r = await installUpdate(platform, u, (received, total) => {
        const el = this.o.root.querySelector('#upd-note');
        if (el) el.textContent = total > 0 ? `Downloading… ${Math.round((received / total) * 100)}%` : `Downloading… ${Math.round(received / 1024)} KB`;
      });
      this.note = r.status === 'permission-required'
        ? 'Allow "Install unknown apps" for LED Hat in the settings that just opened, then tap install again.'
        : platform === 'android' ? 'Confirm the installation in the Android dialog.' : 'Confirm the installation in the iOS dialog, then watch the home screen.';
    } catch (e) {
      this.note = `Update failed: ${(e as Error).message}`;
    } finally {
      this.installing = false;
      this.render();
    }
  }
}
