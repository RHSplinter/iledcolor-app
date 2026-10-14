/**
 * Approach beacon payload, packed into a single 128-bit BLE service UUID so that both
 * Android and iOS phones can advertise it (iOS cannot advertise manufacturer/service data).
 *
 *   bytes 0-5  "LEDHAT" magic      bytes 8-11  phone id (random per install)
 *   byte  6    version (1)          bytes 12-15 two 16-bit hashes of the phone's cap names
 *   byte  7    number of caps on that phone
 *
 * The cap-name hashes let a scanner ignore a cap's own advertisement when it already
 * counts that cap through the owning phone's beacon (no double counting).
 */
export const BEACON_MAGIC = [0x4c, 0x45, 0x44, 0x48, 0x41, 0x54];
export const BEACON_VERSION = 1;

export interface BeaconInfo { phoneId: number; capCount: number; capHashes: number[] }

/** FNV-1a folded to 16 bits; never 0 (0 means "no cap" in the payload). */
export function capHash16(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const f = ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
  return f === 0 ? 1 : f;
}

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

export function encodeBeacon(b: BeaconInfo): string {
  if (!Number.isInteger(b.phoneId) || b.phoneId < 0 || b.phoneId > 0xffffffff) throw new Error('invalid phone id');
  const count = Math.max(0, Math.min(255, Math.floor(b.capCount)));
  const h = [b.capHashes[0] ?? 0, b.capHashes[1] ?? 0];
  const bytes = [
    ...BEACON_MAGIC, BEACON_VERSION, count,
    (b.phoneId >>> 24) & 0xff, (b.phoneId >>> 16) & 0xff, (b.phoneId >>> 8) & 0xff, b.phoneId & 0xff,
    h[0]! >> 8, h[0]! & 0xff, h[1]! >> 8, h[1]! & 0xff,
  ];
  const s = hex(bytes);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function decodeBeacon(uuid: string): BeaconInfo | null {
  const s = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  const bytes = Array.from({ length: 16 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));
  if (BEACON_MAGIC.some((m, i) => bytes[i] !== m) || bytes[6] !== BEACON_VERSION) return null;
  const phoneId = ((bytes[8]! << 24) | (bytes[9]! << 16) | (bytes[10]! << 8) | bytes[11]!) >>> 0;
  const capHashes = [(bytes[12]! << 8) | bytes[13]!, (bytes[14]! << 8) | bytes[15]!].filter((x) => x !== 0);
  return { phoneId, capCount: bytes[7]!, capHashes };
}
