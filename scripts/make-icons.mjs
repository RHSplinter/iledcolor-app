// Generates web and native icons from local artwork without dependencies.
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

// Native artwork keeps the web icon's six LED colours, framed by a cap silhouette.
// Adaptive foreground exports inset this silhouette into Android's safe zone.
const shapes = [
  { x: 112, y: 120, w: 288, h: 260, r: 76, color: [77, 163, 255] },
  { x: 128, y: 136, w: 256, h: 226, r: 60, color: [24, 43, 61] },
  { x: 144, y: 176, w: 224, h: 156, r: 20, color: [8, 16, 24] },
  ...COLORS.map((color, i) => ({
    x: 164 + (i % 3) * 66, y: 196 + Math.floor(i / 3) * 62,
    w: 52, h: 52, r: 10, color,
  })),
  { x: 96, y: 348, w: 320, h: 40, r: 20, color: [77, 163, 255] },
];
const background = [16, 24, 32];
const hex = (color) => '#' + color.map((v) => v.toString(16).padStart(2, '0')).join('');
const svgRect = ({ x, y, w, h, r, color }) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${hex(color)}"/>`;
mkdirSync('assets', { recursive: true });
writeFileSync('assets/native-icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="${hex(background)}"/>
${shapes.map(svgRect).join('\n')}
</svg>
`);

function contains(shape, x, y) {
  const dx = Math.max(shape.x + shape.r - x, 0, x - (shape.x + shape.w - shape.r));
  const dy = Math.max(shape.y + shape.r - y, 0, y - (shape.y + shape.h - shape.r));
  return dx * dx + dy * dy <= shape.r * shape.r;
}

function nativePng(size, { transparent = false, round = false } = {}) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      // Four samples per pixel keep small launcher sizes crisp without jagged curves.
      for (const sy of [0.25, 0.75]) for (const sx of [0.25, 0.75]) {
        const px = (x + sx) * 512 / size, py = (y + sy) * 512 / size;
        let color = transparent ? null : background;
        const ax = transparent ? (px - 256) / 0.76 + 256 : px;
        const ay = transparent ? (py - 256) / 0.76 + 256 : py;
        for (const shape of shapes) if (contains(shape, ax, ay)) color = shape.color;
        if (round && Math.hypot(px - 256, py - 256) > 256) color = null;
        if (color) {
          for (let c = 0; c < 3; c++) sum[c] += color[c];
          sum[3] += 255;
        }
      }
      const offset = y * stride + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[offset + c] = sum[3] ? Math.round(sum[c] * 255 / sum[3]) : 0;
      raw[offset + 3] = Math.round(sum[3] / 4);
    }
  }
  const opaque = !transparent && !round;
  const encoded = opaque ? Buffer.alloc(size * (size * 3 + 1)) : raw;
  if (opaque) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    raw.copy(encoded, y * (size * 3 + 1) + 1 + x * 3, y * stride + 1 + x * 4, y * stride + 1 + x * 4 + 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(encoded)), chunk('IEND', Buffer.alloc(0))]);
}

function writeNative(path, size, options) {
  const data = nativePng(size, options);
  if (existsSync(path) && readFileSync(path).equals(data)) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}
for (const [density, size, foreground] of [
  ['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432],
]) {
  const directory = `android/app/src/main/res/mipmap-${density}`;
  writeNative(`${directory}/ic_launcher.png`, size);
  writeNative(`${directory}/ic_launcher_round.png`, size, { round: true });
  writeNative(`${directory}/ic_launcher_foreground.png`, foreground, { transparent: true });
}
writeNative('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024);
console.log('Web and native icons written.');
