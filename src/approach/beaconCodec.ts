/**
 * Approach beacon payload, packed into a single 128-bit BLE service UUID so that both
 * Android and iOS phones can advertise it (iOS cannot advertise manufacturer/service data).
 *
 *   bytes 0-3  "LEDH" magic         bytes 6-9   phone id (random per install)
 *   byte  4    version (2)          bytes 10-13 two 16-bit hashes of the phone's cap names
 *   byte  5    number of caps       bytes 14-15 near mask: 16-bit Bloom filter of the phones
 *                                               this phone currently sees near
 *
 * The cap-name hashes let a scanner ignore a cap's own advertisement when it already
 * counts that cap through the owning phone's beacon (no double counting). The near mask
 * makes proximity symmetric: a phone that finds itself in a peer's mask joins that peer
 * even if its own (weaker) reception alone would not count it as near.
 * Version 1 beacons ("LEDHAT", version byte 6, no mask) are still decoded.
 */
export const BEACON_MAGIC = [0x4c, 0x45, 0x44, 0x48];
export const BEACON_VERSION = 2;
const V1_MAGIC = [0x4c, 0x45, 0x44, 0x48, 0x41, 0x54];

export interface BeaconInfo { phoneId: number; capCount: number; capHashes: number[]; nearMask?: number }

/** Two Bloom-filter bits (0..15) for a phone id. */
function maskBits(phoneId: number): number {
  let h = Math.imul(phoneId >>> 0, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  const a = h & 15;
  let b = (h >>> 4) & 15;
  if (b === a) b = (a + 7) & 15;
  return (1 << a) | (1 << b);
}

/** Near mask for a set of phone ids. */
export function nearMaskFor(phoneIds: Iterable<number>): number {
  let m = 0;
  for (const id of phoneIds) m |= maskBits(id);
  return m & 0xffff;
}

/** True if `phoneId` is (probably; Bloom filter) listed in `mask`. */
export function maskHas(mask: number | undefined, phoneId: number): boolean {
  if (!mask) return false;
  const bits = maskBits(phoneId);
  return (mask & bits) === bits;
}

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
    ((b.nearMask ?? 0) >> 8) & 0xff, (b.nearMask ?? 0) & 0xff,
  ];
  const s = hex(bytes);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * The user's display name travels next to the UUID: Android puts it in the scan response as
 * manufacturer data (test company id 0xFFFF, prefix "LH"); iOS can only set the local name.
 */
export const NAME_COMPANY_ID = 0xffff;
export const NAME_PREFIX = [0x4c, 0x48]; // "LH"
export const NAME_MAX_BYTES = 20;

/** Trims and shortens a name so its UTF-8 form fits the scan response (never splits a character). */
export function fitBeaconName(name: string): string {
  const enc = new TextEncoder();
  let out = '';
  for (const ch of name.trim()) {
    if (enc.encode(out + ch).length > NAME_MAX_BYTES) break;
    out += ch;
  }
  return out;
}

/** Peer name from an advertisement that carried a beacon UUID; undefined when none was sent. */
export function decodeBeaconName(manufacturerData?: Record<string, DataView>, localName?: string): string | undefined {
  const v = manufacturerData?.[String(NAME_COMPANY_ID)];
  if (v && v.byteLength > NAME_PREFIX.length && NAME_PREFIX.every((p, i) => v.getUint8(i) === p)) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset + NAME_PREFIX.length, Math.min(v.byteLength - NAME_PREFIX.length, NAME_MAX_BYTES));
    const s = new TextDecoder().decode(bytes).trim();
    if (s) return s;
  }
  const n = localName?.trim();
  return n ? n : undefined;
}

export function decodeBeacon(uuid: string): BeaconInfo | null {
  const s = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  const bytes = Array.from({ length: 16 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));
  const u16 = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!;
  const u32 = (i: number) => ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
  if (V1_MAGIC.every((m, i) => bytes[i] === m) && bytes[6] === 1)
    return { phoneId: u32(8), capCount: bytes[7]!, capHashes: [u16(12), u16(14)].filter((x) => x !== 0), nearMask: 0 };
  if (BEACON_MAGIC.some((m, i) => bytes[i] !== m) || bytes[4] !== BEACON_VERSION) return null;
  return { phoneId: u32(6), capCount: bytes[5]!, capHashes: [u16(10), u16(12)].filter((x) => x !== 0), nearMask: u16(14) };
}
