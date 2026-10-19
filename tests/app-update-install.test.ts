import { beforeEach, describe, expect, it, vi } from 'vitest';
const plugin = vi.hoisted(() => ({
  downloadAndInstall: vi.fn(), openInstaller: vi.fn(), addListener: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ registerPlugin: vi.fn(() => plugin) }));
import { registerPlugin } from '@capacitor/core';
import type { AvailableUpdate } from '../src/update/appUpdate';

const update: AvailableUpdate = {
  version: '1.2.3', tag: 'v1.2.3', pageUrl: 'https://example.org/releases/v1.2.3',
  installUrl: 'https://example.org/led hat.apk?token=a&other=b',
  checksumUrl: 'https://example.org/SHA256SUMS-android.txt', fileName: 'led-hat-v1.2.3-android.apk',
};
const remove = vi.fn();
let installUpdate: typeof import('../src/update/appUpdate').installUpdate;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  remove.mockReset().mockResolvedValue(undefined);
  plugin.addListener.mockResolvedValue({ remove });
  plugin.downloadAndInstall.mockResolvedValue({ status: 'installing' });
  plugin.openInstaller.mockResolvedValue(undefined);
  ({ installUpdate } = await import('../src/update/appUpdate'));
});

describe('shared update install boundary', () => {
  it('registers the actual AppUpdater plugin name', () => {
    expect(registerPlugin).toHaveBeenCalledExactlyOnceWith('AppUpdater');
  });

  it('rejects Android releases without checksums before registering listeners or downloading', async () => {
    await expect(installUpdate('android', { ...update, checksumUrl: undefined }, vi.fn()))
      .rejects.toThrow('The release has no Android checksum file.');
    expect(plugin.addListener).not.toHaveBeenCalled();
    expect(plugin.downloadAndInstall).not.toHaveBeenCalled();
    expect(plugin.openInstaller).not.toHaveBeenCalled();
  });

  it.each(['installing', 'permission-required'] as const)('passes Android arguments, progress and %s result and removes its listener', async (status) => {
    let registered!: (handle: { remove: typeof remove }) => void;
    plugin.addListener.mockReturnValue(new Promise((resolve) => { registered = resolve; }));
    let finish!: (result: { status: typeof status }) => void;
    plugin.downloadAndInstall.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const progress = vi.fn();
    const pending = installUpdate('android', update, progress);
    expect(plugin.addListener).toHaveBeenCalledExactlyOnceWith('downloadProgress', expect.any(Function));
    expect(plugin.downloadAndInstall).not.toHaveBeenCalled();
    registered({ remove });
    await vi.waitFor(() => expect(plugin.downloadAndInstall).toHaveBeenCalledOnce());
    expect(plugin.downloadAndInstall).toHaveBeenCalledWith({
      url: update.installUrl, checksumUrl: update.checksumUrl, fileName: update.fileName, version: update.version,
    });
    const callback = plugin.addListener.mock.calls[0]![1];
    callback({ received: 0, total: 0 });
    callback({ received: 512, total: 1024 });
    expect(progress.mock.calls).toEqual([[0, 0], [512, 1024]]);
    expect(remove).not.toHaveBeenCalled();
    const result = { status };
    finish(result);
    await expect(pending).resolves.toBe(result);
    expect(remove).toHaveBeenCalledExactlyOnceWith();
    expect(plugin.openInstaller).not.toHaveBeenCalled();
  });

  it('cleans up the Android progress listener when downloading rejects', async () => {
    const error = new Error('Checksum mismatch');
    plugin.downloadAndInstall.mockRejectedValue(error);
    await expect(installUpdate('android', update, vi.fn())).rejects.toBe(error);
    expect(remove).toHaveBeenCalledOnce();
    expect(plugin.openInstaller).not.toHaveBeenCalled();
  });

  it('does not download after progress listener registration fails', async () => {
    const error = new Error('Listener unavailable');
    plugin.addListener.mockRejectedValue(error);
    await expect(installUpdate('android', update, vi.fn())).rejects.toBe(error);
    expect(plugin.downloadAndInstall).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('downloads without allocating a listener when progress is not requested', async () => {
    await expect(installUpdate('android', update)).resolves.toEqual({ status: 'installing' });
    expect(plugin.downloadAndInstall).toHaveBeenCalledOnce();
    expect(plugin.addListener).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('awaits Android listener removal before resolving', async () => {
    let removed!: () => void;
    remove.mockReturnValue(new Promise<void>((resolve) => { removed = resolve; }));
    const settled = vi.fn();
    const pending = installUpdate('android', update, vi.fn()).then(settled);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    removed();
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith({ status: 'installing' });
  });

  it('opens an encoded iOS manifest URL without checksum, download or progress listener calls', async () => {
    const manifest = 'https://example.org/LED Hat.plist?token=a&other=b#manifest';
    await expect(installUpdate('ios', { ...update, installUrl: manifest, checksumUrl: undefined }, vi.fn()))
      .resolves.toEqual({ status: 'installing' });
    expect(plugin.openInstaller).toHaveBeenCalledExactlyOnceWith({
      url: 'itms-services://?action=download-manifest&url=https%3A%2F%2Fexample.org%2FLED%20Hat.plist%3Ftoken%3Da%26other%3Db%23manifest',
    });
    expect(plugin.downloadAndInstall).not.toHaveBeenCalled();
    expect(plugin.addListener).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('propagates iOS installer rejection without attempting Android operations', async () => {
    const error = new Error('Installer rejected');
    plugin.openInstaller.mockRejectedValue(error);
    await expect(installUpdate('ios', update, vi.fn())).rejects.toBe(error);
    expect(plugin.downloadAndInstall).not.toHaveBeenCalled();
    expect(plugin.addListener).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
