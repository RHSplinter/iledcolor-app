import { isNativeApp } from '../platform';

/**
 * Offers a text file through the system share sheet (native app or Web Share),
 * falling back to a download in browsers without file sharing.
 * Resolves false when the user dismissed the share sheet.
 */
export async function shareTextFile(fileName: string, text: string, mimeType: string, title: string): Promise<boolean> {
  if (isNativeApp()) {
    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const { uri } = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    try {
      await Share.share({ title, files: [uri], dialogTitle: title });
    } catch (e) {
      if (/cancel/i.test((e as Error).message)) return false;
      throw e;
    }
    return true;
  }
  const file = new File([text], fileName, { type: mimeType });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ title, files: [file] });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      throw e;
    }
    return true;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return true;
}
