// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetWebHat, loadWebHat, saveWebHat } from '../src/transport/webBluetoothMemory';

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('remembered browser hat', () => {
  it('stores the exact ID and display name for a fresh page to read', () => {
    expect(saveWebHat({ id: 'hat-231B', name: 'iledcolor-231B' })).toBe(true);
    expect(loadWebHat()).toEqual({ id: 'hat-231B', name: 'iledcolor-231B' });
  });
  it('reads device IDs saved by either previous reconnect PR', () => {
    localStorage.setItem('iledcolor.webBluetoothDeviceId', 'old-hat');
    expect(loadWebHat()?.id).toBe('old-hat');
    localStorage.setItem('iledcolor.lastWebBluetoothHat', 'new-hat');
    expect(loadWebHat()?.id).toBe('new-hat');
  });
  it('explicit disconnect removes every saved identity, including old keys', () => {
    localStorage.setItem('iledcolor.webBluetoothDeviceId', 'old-hat');
    saveWebHat({ id: 'new-hat', name: 'My hat' });
    forgetWebHat();
    expect(loadWebHat()).toBeNull();
    expect(localStorage.length).toBe(0);
  });
  it('reports storage failure instead of claiming the hat is remembered', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(saveWebHat({ id: 'hat', name: 'My hat' })).toBe(false);
    expect(loadWebHat()).toBeNull();
  });
});
