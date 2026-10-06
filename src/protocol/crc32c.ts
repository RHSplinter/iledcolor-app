// CRC-32C (Castagnoli), reflected polynomial. NOT zlib CRC-32.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) crc = (crc >>> 8) ^ TABLE[(crc ^ b) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}
