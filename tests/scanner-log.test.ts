import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { appendScanLog, shareScanLog, type ScanLogEntry } from '../src/scanner/log';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(), isPluginAvailable: vi.fn() },
}));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
  Filesystem: { appendFile: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn() } }));

const entry: ScanLogEntry = {
  timestamp: '2026-10-17T00:00:00.000Z', source: 'camera',
  raw: 'badge^Rob^Bos^Xebia^\n"email": privé@example.org',
  profile: { id: '1', note: 'MS AI Tour' },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('local scan log', () => {
  it('appends one JSON line with the entire original payload, timestamp, source and profile', async () => {
    await appendScanLog(entry);
    const options = vi.mocked(Filesystem.appendFile).mock.calls[0]![0];
    expect(options).toEqual({
      path: 'qr-scan-log.jsonl', directory: Directory.Data, encoding: Encoding.UTF8,
      data: `${JSON.stringify(entry)}\n`,
    });
    expect(options.data.split('\n')).toHaveLength(2);
    expect(JSON.parse(options.data)).toEqual(entry);
  });

  it('does not hide write failures or missing native support', async () => {
    vi.mocked(Filesystem.appendFile).mockRejectedValue(new Error('Disk full'));
    await expect(appendScanLog(entry)).rejects.toThrow('Disk full');
    vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(false);
    await expect(appendScanLog(entry)).rejects.toThrow('Local file storage is unavailable');
  });

  it('shares a cache snapshot on native platforms without replacing the persistent log', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Filesystem.readFile).mockResolvedValue({ data: JSON.stringify(entry) + '\n' });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'file:///cache/qr-scan-log.jsonl' });
    await expect(shareScanLog()).resolves.toBe('shared');
    expect(Filesystem.writeFile).toHaveBeenCalledWith({
      path: 'qr-scan-log.jsonl', directory: Directory.Cache, encoding: Encoding.UTF8,
      data: JSON.stringify(entry) + '\n',
    });
    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ files: ['file:///cache/qr-scan-log.jsonl'] }));
    expect(Filesystem.appendFile).not.toHaveBeenCalled();
  });

  it('surfaces missing files and share errors', async () => {
    vi.mocked(Filesystem.readFile).mockRejectedValue(new Error('File does not exist'));
    await expect(shareScanLog()).rejects.toThrow('File does not exist');
    vi.mocked(Filesystem.readFile).mockResolvedValue({ data: 'record\n' });
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'file:///cache/log' });
    vi.mocked(Share.share).mockRejectedValue(new Error('Share unavailable'));
    await expect(shareScanLog()).rejects.toThrow('Share unavailable');
  });

  it('uses browser file sharing and treats cancellation separately from errors', async () => {
    vi.mocked(Filesystem.readFile).mockResolvedValue({ data: 'record\n' });
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { canShare: () => true, share });
    await expect(shareScanLog()).resolves.toBe('shared');
    const file: File = share.mock.calls[0]![0].files[0];
    expect(file.name).toBe('qr-scan-log.jsonl');
    expect(await file.text()).toBe('record\n');
    share.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    await expect(shareScanLog()).resolves.toBe('cancelled');
    share.mockRejectedValue(new Error('Not allowed'));
    await expect(shareScanLog()).rejects.toThrow('Not allowed');
  });

  it('downloads a file when browser file sharing is unsupported and revokes the URL', async () => {
    vi.useFakeTimers();
    vi.mocked(Filesystem.readFile).mockResolvedValue({ data: 'record\n' });
    vi.stubGlobal('navigator', {});
    const link = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { createElement: () => link });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:scan-log');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await expect(shareScanLog()).resolves.toBe('downloaded');
    expect(link.download).toBe('qr-scan-log.jsonl');
    expect(link.click).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.any(File));
    vi.advanceTimersByTime(5000);
    expect(revoke).toHaveBeenCalledWith('blob:scan-log');
    create.mockRestore();
    revoke.mockRestore();
  });
});
