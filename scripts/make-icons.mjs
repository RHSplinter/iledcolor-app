// Generates the PWA PNG icons (no dependencies). Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const COLORS = [[255, 51, 51], [51, 255, 51], [51, 136, 255], [255, 204, 51], [255, 51, 255], [51, 255, 255]];

function png(size, scale) {
  // scale < 1 shrinks the artwork into the maskable safe zone.
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const cell = (size * scale) / 5.5;
  const x0 = (size - cell * 5.5) / 2, y0 = (size - cell * 3.5) / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let px = [17, 17, 17];
      const gx = (x - x0) / cell, gy = (y - y0) / cell;
      const ix = Math.floor(gx / 1.75), iy = Math.floor(gy / 1.75);
      if (gx >= 0 && gy >= 0 && ix < 3 && iy < 2 && gx - ix * 1.75 < 1 && gy - iy * 1.75 < 1) px = COLORS[iy * 3 + ix];
      raw.set(px, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync('public/icon-192.png', png(192, 0.8));
writeFileSync('public/icon-512.png', png(512, 0.8));
writeFileSync('public/icon-maskable-512.png', png(512, 0.55));
console.log('icons written');
