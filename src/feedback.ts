import { Capacitor } from '@capacitor/core';
import { Haptics } from '@capacitor/haptics';

/** Optional device feedback must never interrupt recognition, playback or restoration. */
export async function vibrateFeedback(): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      if (Capacitor.isPluginAvailable('Haptics')) await Haptics.vibrate({ duration: 200 });
    } else {
      navigator.vibrate?.(200);
    }
  } catch {
    // Unsupported hardware, denied browser vibration and plugin errors are non-fatal.
  }
}
