import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const LOG_FILE = 'qr-scan-log.jsonl';

export interface ScanLogEntry {
  timestamp: string;
  source: 'camera' | 'manual';
  raw: string;
  profile: { id: string; note: string } | null;
}

function requireFilesystem() {
  if (!Capacitor.isPluginAvailable('Filesystem')) throw new Error('Local file storage is unavailable in this app build.');
}

export async function appendScanLog(entry: ScanLogEntry): Promise<void> {
  requireFilesystem();
  await Filesystem.appendFile({
    path: LOG_FILE, directory: Directory.Data, encoding: Encoding.UTF8,
    data: `${JSON.stringify(entry)}\n`,
  });
}

export async function shareScanLog(): Promise<'shared' | 'downloaded' | 'cancelled'> {
  requireFilesystem();
  const { data } = await Filesystem.readFile({ path: LOG_FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
  const text = typeof data === 'string' ? data : await data.text();
  if (!text) throw new Error('The scan log is empty. Enable logging and scan a QR code first.');
  if (Capacitor.isNativePlatform()) {
    if (!Capacitor.isPluginAvailable('Share')) throw new Error('File sharing is unavailable in this app build.');
    const { uri } = await Filesystem.writeFile({
      path: LOG_FILE, directory: Directory.Cache, encoding: Encoding.UTF8, data: text,
    });
    await Share.share({ title: 'QR scan log', files: [uri], dialogTitle: 'Share scan log' });
    return 'shared';
  }
  const file = new File([text], LOG_FILE, { type: 'application/x-ndjson' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ title: 'QR scan log', files: [file] });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      throw e;
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = LOG_FILE;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}
