/** Browser-local identity; never included in exported presets or backups. */
const ID_KEY = 'iledcolor.lastWebBluetoothHat';
const NAME_KEY = 'iledcolor.lastWebBluetoothHatName';
const LEGACY_KEY = 'iledcolor.webBluetoothDeviceId';
export interface SavedWebHat { id: string; name: string }

export function loadWebHat(): SavedWebHat | null {
  try {
    const id = localStorage.getItem(ID_KEY) || localStorage.getItem(LEGACY_KEY);
    return id ? { id, name: localStorage.getItem(NAME_KEY) || 'your last hat' } : null;
  } catch { return null; }
}

export function saveWebHat(hat: SavedWebHat): boolean {
  try {
    localStorage.setItem(ID_KEY, hat.id);
    localStorage.setItem(NAME_KEY, hat.name);
    localStorage.removeItem(LEGACY_KEY);
    return true;
  } catch { return false; }
}

export function forgetWebHat(): void {
  for (const key of [ID_KEY, NAME_KEY, LEGACY_KEY]) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
}
