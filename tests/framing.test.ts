import { describe, expect, it } from 'vitest';
import { crc32c } from '../src/protocol/crc32c';
import {
  buildConnect, buildContinue, buildContinueFrames, buildDimming, buildDisplayEnable, buildEndStream,
  buildImageMetadata, buildImageStream, buildStartStream, buildTestPass, parseNotification, u16sum,
  wrapStream,
} from '../src/protocol/framing';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

describe('golden frames', () => {
  it('Connect', () => expect(hex(buildConnect())).toBe('540d0003000064'));
  it('TestPass', () => expect(hex(buildTestPass())).toBe('540f0008000000000000006b'));
  it('EndStream', () => expect(hex(buildEndStream())).toBe('54010003010059'));
  it('StartStream', () =>
    expect(hex(buildStartStream(0x2c785733, 1582))).toBe('5406000d2c7857330000062e00000001c9'));
});

describe('primitives', () => {
  it('CRC-32C check value', () => expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283));
  it('u16 sum wraps', () => {
    expect(u16sum([1, 2, 3])).toBe(6);
    expect(u16sum(new Array(1000).fill(0xff))).toBe((1000 * 0xff) & 0xffff);
  });
  it('Continue encodes seq and length', () => {
    const f = buildContinue(3, new Uint8Array(10).fill(0xaa));
    expect(hex(f.subarray(0, 10))).toBe('54000012' + '00000003' + '000a');
    expect(u16sum(f.subarray(0, f.length - 2))).toBe((f[f.length - 2]! << 8) | f[f.length - 1]!);
  });
  it('Dimming / DisplayEnable', () => {
    expect(hex(buildDimming(5).subarray(0, 13))).toBe('5409000b05' + '00'.repeat(8));
    expect(buildDisplayEnable(true)[4]).toBe(1);
    expect(buildDisplayEnable(false)[4]).toBe(0);
  });
});

describe('input limits', () => {
  it('rejects bad brightness', () => {
    for (const l of [-1, 11, 1.5, NaN]) expect(() => buildDimming(l)).toThrow(RangeError);
  });
  it('rejects wrong password size', () => expect(() => buildTestPass(new Uint8Array(5))).toThrow());
  it('rejects wrong pixel count', () =>
    expect(() => buildImageStream({ width: 2, height: 2, pixels: new Uint8Array(11) })).toThrow(/mismatch/));
  it('rejects invalid dimensions', () => {
    expect(() => buildImageStream({ width: 0, height: 2, pixels: new Uint8Array(0) })).toThrow();
    expect(() => buildImageMetadata(70000, 1)).toThrow();
  });
  it('rejects oversized streams', () => {
    // 150x150x3 = 67500 > 65535
    expect(() => buildImageStream({ width: 150, height: 150, pixels: new Uint8Array(67500) })).toThrow(/limit/);
    expect(() => buildStartStream(0, 65536)).toThrow(RangeError);
  });
  it('enforces a hardware-tested smaller limit', () =>
    expect(() => buildImageStream({ width: 16, height: 32, pixels: new Uint8Array(1536) }, 1000)).toThrow(/limit/));
});

describe('stream payload', () => {
  it('metadata is 22 bytes with width/height at fields 3-4', () => {
    const m = buildImageMetadata(16, 32);
    expect(m.length).toBe(22);
    expect(hex(m)).toBe('00000000' + '0010' + '0020' + '0000' + '0001' + '0001' + '0001' + '0032' + '0064' + '0000');
  });
  it('wrapper is 24 bytes', () => {
    const { bytes } = wrapStream(new Uint8Array(100));
    expect(bytes.length).toBe(124);
    expect(bytes[4]).toBe(1);
    expect(bytes.subarray(5, 24).every((b) => b === 0)).toBe(true);
  });
  it('16x32 fixture totals 1582 and CRC covers metadata + pixels', () => {
    const img = { width: 16, height: 32, pixels: new Uint8Array(1536) };
    const { bytes, crc } = buildImageStream(img);
    expect(bytes.length).toBe(1582);
    expect(crc).toBe(crc32c(bytes.subarray(24)));
    expect((bytes[0]! << 24 | bytes[1]! << 16 | bytes[2]! << 8 | bytes[3]!) >>> 0).toBe(crc);
  });
  it('splits into frames of bounded size with sequential numbers', () => {
    const frames = buildContinueFrames(new Uint8Array(1582), 8);
    expect(Math.max(...frames.map((f) => f.length))).toBe(20);
    expect(frames.length).toBe(Math.ceil(1582 / 8));
    expect(frames[5]!.subarray(4, 8)).toEqual(new Uint8Array([0, 0, 0, 5]));
  });
});

describe('notifications', () => {
  it('parses a valid ack', () => {
    const n = parseNotification(fromHex('5406000301005e'));
    expect(n.cmd).toBe(6);
    expect(Array.from(n.body)).toEqual([1]);
  });
  it('parses the real hat Continue ack (length excludes checksum)', () => {
    const n = parseNotification(fromHex('540000050000000001005a'));
    expect(n.cmd).toBe(0);
    expect(Array.from(n.body)).toEqual([0, 0, 0, 0, 1]);
    expect(() => parseNotification(fromHex('540000050000000001005b'))).toThrow(/checksum/);
  });
  it('rejects bad checksum, length, magic', () => {
    expect(() => parseNotification(fromHex('5406000301005f'))).toThrow(/checksum/);
    expect(() => parseNotification(fromHex('5406000401005e'))).toThrow(/length/);
    expect(() => parseNotification(fromHex('5506000301005e'))).toThrow();
    expect(() => parseNotification(fromHex('5406'))).toThrow();
  });
});
