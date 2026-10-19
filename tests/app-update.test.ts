import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_CHECK_INTERVAL_MS, autoCheckDue, checkForUpdate, compareVersions, itmsServicesUrl, markAutoCheck, selectUpdate,
  type GithubRelease,
} from '../src/update/appUpdate';

const base = 'https://github.com/harrybin/iledcolor-app-native-added/releases/download';
const release = (tag: string, names: string[], extra: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag, draft: false, prerelease: false,
  html_url: `https://github.com/harrybin/iledcolor-app-native-added/releases/tag/${tag}`,
  assets: names.map((name) => ({ name, browser_download_url: `${base}/${tag}/${name}` })),
  ...extra,
});
const android = (tag: string, extra?: Partial<GithubRelease>) => release(tag, [`led-hat-${tag}-android.apk`, 'SHA256SUMS-android.txt'], extra);
const ios = (tag: string) => release(tag, [`led-hat-${tag}-ios.ipa`, `led-hat-${tag}-ios.plist`, 'SHA256SUMS-ios.txt']);

describe('app updates', () => {
  it('compares semantic versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('garbage', '0.0.1')).toBeLessThan(0);
  });

  it('selects the newest Android release with an APK and checksum', () => {
    const r = selectUpdate([android('v0.2.2'), android('v0.3.0'), release('v0.4.0', ['led-hat-v0.4.0-android.apk'])], 'android', '0.2.2');
    expect(r).toEqual({ status: 'available', update: expect.objectContaining({
      version: '0.3.0', tag: 'v0.3.0', fileName: 'led-hat-v0.3.0-android.apk',
      installUrl: `${base}/v0.3.0/led-hat-v0.3.0-android.apk`, checksumUrl: `${base}/v0.3.0/SHA256SUMS-android.txt`,
    }) });
  });

  it('ignores drafts, prereleases, invalid tags and releases for other platforms', () => {
    const releases = [
      android('v0.5.0', { draft: true }), android('v0.4.0', { prerelease: true }), android('nightly'),
      ios('v0.3.0'), android('v0.2.2'),
    ];
    expect(selectUpdate(releases, 'android', '0.2.2')).toEqual({ status: 'current', latest: '0.2.2' });
    expect(selectUpdate(releases, 'ios', '0.2.2')).toEqual({ status: 'available', update: expect.objectContaining({
      version: '0.3.0', installUrl: `${base}/v0.3.0/led-hat-v0.3.0-ios.plist`,
    }) });
    expect(selectUpdate(releases, 'ios', '0.3.0')).toEqual({ status: 'current', latest: '0.3.0' });
  });

  it('never offers a downgrade and rejects malformed responses', () => {
    expect(selectUpdate([android('v0.1.0')], 'android', '0.2.2')).toEqual({ status: 'current', latest: '0.1.0' });
    expect(selectUpdate([{ ...android('v9.0.0'), assets: [{ name: 'led-hat-v9.0.0-android.apk', browser_download_url: 'http://x/a.apk' }] }], 'android', '0.0.1'))
      .toEqual({ status: 'current', latest: undefined });
    expect(() => selectUpdate({ message: 'Not Found' }, 'android', '0.2.2')).toThrow(/Unexpected response/);
  });

  it('fetches GitHub releases and reports HTTP and rate-limit errors', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify([android('v1.0.0')]), { status: 200 }));
    await expect(checkForUpdate('android', '0.2.2', ok as unknown as typeof fetch)).resolves.toMatchObject({ status: 'available' });
    expect(ok).toHaveBeenCalledWith(expect.stringContaining('api.github.com/repos/harrybin/iledcolor-app-native-added/releases'), expect.anything());
    const limited = async () => new Response('{}', { status: 403 });
    await expect(checkForUpdate('android', '0.2.2', limited as unknown as typeof fetch)).rejects.toThrow(/rate limit/);
    const broken = async () => new Response('{}', { status: 500 });
    await expect(checkForUpdate('android', '0.2.2', broken as unknown as typeof fetch)).rejects.toThrow(/HTTP 500/);
  });

  it('throttles automatic checks', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(autoCheckDue(1_000_000, storage)).toBe(true);
    markAutoCheck(1_000_000, storage);
    expect(autoCheckDue(1_000_000 + AUTO_CHECK_INTERVAL_MS - 1, storage)).toBe(false);
    expect(autoCheckDue(1_000_000 + AUTO_CHECK_INTERVAL_MS, storage)).toBe(true);
    expect(autoCheckDue(500, storage)).toBe(true); // clock moved backwards
  });

  it('builds an encoded itms-services link', () => {
    expect(itmsServicesUrl(`${base}/v1.0.0/led-hat-v1.0.0-ios.plist`))
      .toBe(`itms-services://?action=download-manifest&url=${encodeURIComponent(`${base}/v1.0.0/led-hat-v1.0.0-ios.plist`)}`);
  });

  it('matches the asset names published by the release workflows', async () => {
    const { readFile } = await import('node:fs/promises');
    const androidYml = await readFile('.github/workflows/release-android.yml', 'utf8');
    const iosYml = await readFile('.github/workflows/release-ios.yml', 'utf8');
    expect(androidYml).toContain('led-hat-$RELEASE_TAG-android.apk');
    expect(androidYml).toContain('SHA256SUMS-android.txt');
    expect(iosYml).toContain('MANIFEST="led-hat-$RELEASE_TAG-ios.plist"');
    expect(iosYml).toMatch(/gh release upload .*"\$MANIFEST"/);
  });
});
