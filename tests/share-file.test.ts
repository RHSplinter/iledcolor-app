// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { shareTextFile } from '../src/ui/shareFile';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn() } }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: vi.fn() },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn() } }));

const name = 'preset-ä.json', text = '{"text":"Grüße 👋"}\n', mime = 'application/json', title = 'Export preset';
const share = () => shareTextFile(name, text, mime, title);
const fileText = (file: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsText(file);
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'file:///cache/export.json' });
  vi.mocked(Share.share).mockResolvedValue({});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('shared text file export boundary', () => {
  it('writes native Cache/UTF8 content before sharing the returned URI', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    let finish!: (value: { uri: string }) => void;
    vi.mocked(Filesystem.writeFile).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = share();
    await vi.waitFor(() => expect(Filesystem.writeFile).toHaveBeenCalledOnce());
    expect(Filesystem.writeFile).toHaveBeenCalledWith({
      path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8,
    });
    expect(Share.share).not.toHaveBeenCalled();
    finish({ uri: 'file:///cache/actual-export.json' });
    await expect(pending).resolves.toBe(true);
    expect(Share.share).toHaveBeenCalledExactlyOnceWith({
      title, files: ['file:///cache/actual-export.json'], dialogTitle: title,
    });
  });

  it('returns false only for native share cancellation and propagates other share errors', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Share.share).mockRejectedValueOnce(new Error('User CANCELLED'));
    await expect(share()).resolves.toBe(false);
    const error = new Error('Share unavailable');
    vi.mocked(Share.share).mockRejectedValueOnce(error);
    await expect(share()).rejects.toBe(error);
  });

  it('never opens the native share sheet after a filesystem failure', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const error = new Error('Cache full');
    vi.mocked(Filesystem.writeFile).mockRejectedValue(error);
    await expect(share()).rejects.toBe(error);
    expect(Share.share).not.toHaveBeenCalled();
  });

  it('shares the exact web filename, MIME and Unicode content without invoking native APIs', async () => {
    const canShare = vi.fn().mockReturnValue(true), webShare = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { canShare, share: webShare });
    await expect(share()).resolves.toBe(true);
    const file: File = webShare.mock.calls[0]![0].files[0];
    expect(canShare).toHaveBeenCalledExactlyOnceWith({ files: [file] });
    expect(webShare).toHaveBeenCalledExactlyOnceWith({ title, files: [file] });
    expect(file.name).toBe(name);
    expect(file.type).toBe(mime);
    expect(await fileText(file)).toBe(text);
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
    expect(Share.share).not.toHaveBeenCalled();
  });

  it('treats Web Share AbortError as cancellation without falling back on cancellation or errors', async () => {
    const webShare = vi.fn().mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
    vi.stubGlobal('navigator', { canShare: () => true, share: webShare });
    const create = vi.spyOn(document, 'createElement');
    await expect(share()).resolves.toBe(false);
    const error = new DOMException('Not allowed', 'NotAllowedError');
    webShare.mockRejectedValueOnce(error);
    await expect(share()).rejects.toBe(error);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['absent', 'false'])('downloads when canShare is %s and revokes its object URL after five seconds', async (support) => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', support === 'absent' ? {} : { canShare: () => false });
    const create = vi.fn().mockReturnValue('blob:export'), revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    let clicked: HTMLAnchorElement | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      clicked = this;
    });
    await expect(share()).resolves.toBe(true);
    expect(clicked?.download).toBe(name);
    expect(clicked?.href).toBe('blob:export');
    expect(clicked?.isConnected).toBe(false);
    expect(document.querySelector('a')).toBeNull();
    expect(create).toHaveBeenCalledOnce();
    const file: File = create.mock.calls[0]![0];
    expect(file.name).toBe(name);
    expect(file.type).toBe(mime);
    vi.advanceTimersByTime(4999);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:export');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    expect(await fileText(file)).toBe(text);
  });
});
