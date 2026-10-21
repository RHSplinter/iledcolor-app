import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Haptics } from '@capacitor/haptics';
import { vibrateFeedback } from '../src/feedback';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(), isPluginAvailable: vi.fn() },
}));
vi.mock('@capacitor/haptics', () => ({ Haptics: { vibrate: vi.fn() } }));

beforeEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('best-effort completion vibration', () => {
  it('uses native haptics once without also vibrating through the browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(true);
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    await vibrateFeedback();
    expect(Haptics.vibrate).toHaveBeenCalledExactlyOnceWith({ duration: 200 });
    expect(vibrate).not.toHaveBeenCalled();
  });
  it('uses supported web vibration and tolerates unsupported browsers', async () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    await vibrateFeedback();
    expect(vibrate).toHaveBeenCalledExactlyOnceWith(200);
    vi.stubGlobal('navigator', {});
    await expect(vibrateFeedback()).resolves.toBeUndefined();
    expect(Haptics.vibrate).not.toHaveBeenCalled();
  });
  it('does not let missing native support or vibration errors break recognition or scans', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await expect(vibrateFeedback()).resolves.toBeUndefined();
    expect(Haptics.vibrate).not.toHaveBeenCalled();
    vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(true);
    vi.mocked(Haptics.vibrate).mockRejectedValue({ code: 'UNIMPLEMENTED' });
    await expect(vibrateFeedback()).resolves.toBeUndefined();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.stubGlobal('navigator', { vibrate: () => { throw new Error('Blocked'); } });
    await expect(vibrateFeedback()).resolves.toBeUndefined();
  });
});
