import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

function readPng(path) {
  const file = readFileSync(path);
  assert.equal(file.subarray(1, 4).toString(), 'PNG');
  const size = file.readUInt32BE(16);
  assert.equal(file.readUInt32BE(20), size);
  assert.equal(file[24], 8);
  assert.ok(file[25] === 2 || file[25] === 6);
  const channels = file[25] === 2 ? 3 : 4;
  const chunks = [];
  for (let offset = 8; offset < file.length;) {
    const length = file.readUInt32BE(offset);
    if (file.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      chunks.push(file.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return { size, channels, pixels: inflateSync(Buffer.concat(chunks)) };
}

test('native icons are reproducible; PWA identity is unchanged', () => {
  const paths = [
    'public/icon-192.png', 'public/icon-512.png', 'public/icon-maskable-512.png',
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',
    'android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png',
    'assets/native-icon.svg',
  ];
  const before = paths.map((path) => readFileSync(path));
  execFileSync(process.execPath, ['scripts/make-icons.mjs']);
  paths.forEach((path, i) => assert.deepEqual(readFileSync(path), before[i], path));
  assert.notEqual(readFileSync('assets/native-icon.svg', 'utf8'), readFileSync('public/icon.svg', 'utf8'));
});

test('iOS icon is opaque 1024px artwork with all six original LED colours', () => {
  const { size, channels, pixels } = readPng('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
  assert.equal(size, 1024);
  assert.equal(channels, 3, 'Apple icon must have no alpha channel');
  const colors = new Set();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = y * (size * 3 + 1) + 1 + x * 3;
    colors.add(pixels.subarray(offset, offset + 3).toString('hex'));
  }
  for (const color of ['ff3333', '33ff33', '3388ff', 'ffcc33', 'ff33ff', '33ffff'])
    assert.ok(colors.has(color), color);
});

test('Android density variants have correct sizes and adaptive artwork stays inside the safe circle', () => {
  for (const [density, size, foreground] of [
    ['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216],
    ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432],
  ]) {
    const base = `android/app/src/main/res/mipmap-${density}`;
    assert.equal(readPng(`${base}/ic_launcher.png`).size, size);
    const round = readPng(`${base}/ic_launcher_round.png`);
    assert.equal(round.size, size);
    assert.equal(round.pixels[4], 0);
    const adaptive = readPng(`${base}/ic_launcher_foreground.png`);
    assert.equal(adaptive.size, foreground);
    for (let y = 0; y < foreground; y++) for (let x = 0; x < foreground; x++) {
      const alpha = adaptive.pixels[y * (foreground * 4 + 1) + 1 + x * 4 + 3];
      if (alpha) assert.ok(Math.hypot(x + 0.5 - foreground / 2, y + 0.5 - foreground / 2) <= foreground * 33 / 108,
        `${density}: artwork outside safe zone at ${x}, ${y}`);
    }
  }
});
