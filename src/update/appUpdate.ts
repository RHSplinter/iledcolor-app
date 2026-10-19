import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export const RELEASES_REPO = 'harrybin/iledcolor-app-native-added';
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;
const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=20`;
/** Automatic checks are throttled to stay well inside GitHub's anonymous API rate limit. */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'appUpdateLastCheck';

export type UpdatePlatform = 'android' | 'ios';

export interface ReleaseAsset { name: string; browser_download_url: string }
export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  body?: string | null;
  assets: ReleaseAsset[];
}

export interface AvailableUpdate {
  version: string;
  tag: string;
  pageUrl: string;
  /** Android: signed APK. iOS: OTA manifest for itms-services. */
  installUrl: string;
  fileName: string;
  /** Android only: SHA256SUMS file listing `fileName`. */
  checksumUrl?: string;
}

export type UpdateCheck =
  | { status: 'available'; update: AvailableUpdate }
  | { status: 'current'; latest?: string };

const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(v: string): [number, number, number] | null {
  const m = VERSION.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Positive when `a` is newer than `b`. Unparseable versions sort before every valid one. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/** Picks the newest published release that actually contains an installable asset for this platform. */
export function selectUpdate(releases: unknown, platform: UpdatePlatform, current: string): UpdateCheck {
  if (!Array.isArray(releases)) throw new Error('Unexpected response from GitHub Releases.');
  let best: AvailableUpdate | undefined;
  let latest: string | undefined;
  for (const r of releases as GithubRelease[]) {
    if (!r || typeof r !== 'object' || r.draft || r.prerelease || typeof r.tag_name !== 'string' || !parseVersion(r.tag_name)) continue;
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const url = (name: string) => assets.find((a) => a?.name === name && typeof a.browser_download_url === 'string'
      && a.browser_download_url.startsWith('https://'))?.browser_download_url;
    const tag = r.tag_name;
    const fileName = platform === 'android' ? `led-hat-${tag}-android.apk` : `led-hat-${tag}-ios.plist`;
    const installUrl = url(fileName);
    const checksumUrl = platform === 'android' ? url('SHA256SUMS-android.txt') : undefined;
    if (!installUrl || (platform === 'android' && !checksumUrl)) continue;
    const version = tag.replace(/^v/, '');
    if (!latest || compareVersions(version, latest) > 0) latest = version;
    if (compareVersions(version, current) <= 0 || (best && compareVersions(version, best.version) <= 0)) continue;
    best = {
      version, tag, fileName, installUrl, ...(checksumUrl ? { checksumUrl } : {}),
      pageUrl: typeof r.html_url === 'string' && r.html_url.startsWith('https://') ? r.html_url : RELEASES_PAGE,
    };
  }
  return best ? { status: 'available', update: best } : { status: 'current', latest };
}

export async function checkForUpdate(platform: UpdatePlatform, current: string, fetchFn: typeof fetch = fetch, timeoutMs = 15000): Promise<UpdateCheck> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchFn(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: abort.signal, cache: 'no-store' });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached. Try again later.');
    if (!res.ok) throw new Error(`GitHub Releases returned HTTP ${res.status}.`);
    return selectUpdate(await res.json(), platform, current);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('Update check timed out.');
    throw e;
  } finally { clearTimeout(timer); }
}

export function autoCheckDue(now = Date.now(), storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  const last = Number(storage.getItem(LAST_CHECK_KEY));
  return !Number.isFinite(last) || last <= 0 || last > now || now - last >= AUTO_CHECK_INTERVAL_MS;
}
export function markAutoCheck(now = Date.now(), storage: Pick<Storage, 'setItem'> = localStorage): void {
  try { storage.setItem(LAST_CHECK_KEY, String(now)); } catch { /* storage unavailable: check again next launch */ }
}

/** iOS installs Ad Hoc builds over the air from a manifest served via HTTPS. */
export const itmsServicesUrl = (manifestUrl: string) =>
  `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;

export interface InstallResult { status: 'installing' | 'permission-required' }
interface AppUpdaterPlugin {
  /** Android: downloads the APK, verifies its SHA-256 and package, then opens the system installer. */
  downloadAndInstall(o: { url: string; checksumUrl: string; fileName: string; version: string }): Promise<InstallResult>;
  /** iOS: hands an itms-services URL to the system installer. */
  openInstaller(o: { url: string }): Promise<void>;
  addListener(e: 'downloadProgress', cb: (p: { received: number; total: number }) => void): Promise<PluginListenerHandle>;
}
export const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

export async function installUpdate(platform: UpdatePlatform, update: AvailableUpdate, onProgress?: (received: number, total: number) => void): Promise<InstallResult> {
  if (platform === 'ios') {
    await AppUpdater.openInstaller({ url: itmsServicesUrl(update.installUrl) });
    return { status: 'installing' };
  }
  if (!update.checksumUrl) throw new Error('The release has no Android checksum file.');
  const handle = onProgress ? await AppUpdater.addListener('downloadProgress', (p) => onProgress(p.received, p.total)) : undefined;
  try {
    return await AppUpdater.downloadAndInstall({ url: update.installUrl, checksumUrl: update.checksumUrl, fileName: update.fileName, version: update.version });
  } finally { await handle?.remove(); }
}
