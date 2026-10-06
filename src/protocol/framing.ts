// Port of zagi/iledcolor_small src/iledcolor/framing.py (MIT, see third_party/).
// Pinned reference commit: f68cb027c9f196dc4cb81fa8b39c8aaec97e737a
// Pure functions only: no browser APIs.
import { crc32c } from './crc32c';

export const OPCODE = 0x54;

export const Cmd = {
  CONTINUE: 0x00,
  END_STREAM: 0x01,
  START_STREAM: 0x06,
  DIMMING: 0x09,
  DISPLAY_ENABLE: 0x0a,
  CONNECT: 0x0d,
  PASSWORD_OPS: 0x0e,
  TEST_PASS: 0x0f,
} as const;

/** Bytes of protocol overhead around a Continue chunk: 4 header + 4 seq + 2 len + 2 checksum. */
export const CONTINUE_OVERHEAD = 12;
/** Wrapper in front of metadata+payload: crc(4) + 0x01 + 19 zeros. */
export const STREAM_WRAPPER_LEN = 24;
export const METADATA_LEN = 22;
/** StartStream total-length field is u16. */
export const MAX_STREAM_BYTES = 0xffff;
export const MAX_BRIGHTNESS_LEVEL = 10;

export function u16sum(data: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < data.length; i++) s = (s + data[i]!) & 0xffff;
  return s;
}

function u16be(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}
function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function frame(cmd: number, body: ArrayLike<number>): Uint8Array {
  const length = body.length + 2;
  if (length > 0xffff) throw new RangeError('frame too large');
  const out = new Uint8Array(4 + body.length + 2);
  out[0] = OPCODE;
  out[1] = cmd;
  out.set(u16be(length), 2);
  out.set(body, 4);
  out.set(u16be(u16sum(out.subarray(0, 4 + body.length))), 4 + body.length);
  return out;
}

export const buildConnect = () => frame(Cmd.CONNECT, [0]);

export function buildTestPass(password: Uint8Array = new Uint8Array(6)): Uint8Array {
  if (password.length !== 6) throw new RangeError('password must be exactly 6 bytes');
  return frame(Cmd.TEST_PASS, password);
}

export function buildDimming(level: number): Uint8Array {
  if (!Number.isInteger(level) || level < 0 || level > MAX_BRIGHTNESS_LEVEL)
    throw new RangeError(`brightness level must be an integer 0..${MAX_BRIGHTNESS_LEVEL}`);
  return frame(Cmd.DIMMING, [level, 0, 0, 0, 0, 0, 0, 0, 0]);
}

export const buildDisplayEnable = (on: boolean) =>
  frame(Cmd.DISPLAY_ENABLE, [on ? 1 : 0, 0, 0, 0, 0, 0, 0, 0, 0]);

export function buildStartStream(crc: number, totalLen: number): Uint8Array {
  if (!Number.isInteger(totalLen) || totalLen < 0 || totalLen > MAX_STREAM_BYTES)
    throw new RangeError(`stream length ${totalLen} exceeds ${MAX_STREAM_BYTES}`);
  return frame(Cmd.START_STREAM, [...u32be(crc), 0, 0, ...u16be(totalLen), 0, 0, 0]);
}

export function buildContinue(sequence: number, chunk: Uint8Array): Uint8Array {
  if (chunk.length > 0xffff) throw new RangeError('chunk too large');
  return frame(Cmd.CONTINUE, [...u32be(sequence), ...u16be(chunk.length), ...chunk]);
}

export const buildEndStream = () => frame(Cmd.END_STREAM, [1]);

// ---- notifications ------------------------------------------------------------

export interface Notification {
  cmd: number;
  body: Uint8Array;
}

/** Strict parse: throws on bad magic, length mismatch or checksum mismatch. */
export function parseNotification(data: Uint8Array): Notification {
  if (data.length < 6 || data[0] !== OPCODE) throw new Error('not a valid notification');
  const length = (data[2]! << 8) | data[3]!;
  // Observed on the real hat (docs/compatibility-report.md): every ack's length field counts the
  // checksum, EXCEPT Continue (0x00) acks, whose length counts only the body (5 = seq + status).
  const expectedTotal = data[1] === Cmd.CONTINUE ? 4 + length + 2 : 4 + length;
  if (data.length !== expectedTotal) throw new Error('notification length mismatch');
  const cksum = (data[data.length - 2]! << 8) | data[data.length - 1]!;
  if (u16sum(data.subarray(0, data.length - 2)) !== cksum) throw new Error('notification checksum mismatch');
  return { cmd: data[1]!, body: data.slice(4, data.length - 2) };
}

// ---- stream payload -----------------------------------------------------------

export interface ImageMetadataFields {
  unknown1: number; unknown2: number; unknown3: number; unknown4: number; unknown5: number;
  unknown6: number; unknown7: number; unknown8: number; unknown9: number;
}

export const RGB_METADATA_DEFAULTS: ImageMetadataFields = {
  unknown1: 0, unknown2: 0, unknown3: 0, unknown4: 1, unknown5: 1,
  unknown6: 1, unknown7: 0x32, unknown8: 0x64, unknown9: 0,
};
export const GIF_METADATA_DEFAULTS: ImageMetadataFields = {
  unknown1: 0, unknown2: 0, unknown3: 0, unknown4: 6, unknown5: 1,
  unknown6: 0x64, unknown7: 0x400, unknown8: 0x64, unknown9: 0,
};

export function buildImageMetadata(
  width: number, height: number, f: ImageMetadataFields = RGB_METADATA_DEFAULTS,
): Uint8Array {
  for (const [name, v] of [['width', width], ['height', height]] as const)
    if (!Number.isInteger(v) || v < 1 || v > 0xffff) throw new RangeError(`invalid ${name}`);
  // Field order mirrors ImageMetadata.to_bytes() in the reference.
  const fields = [f.unknown1, f.unknown2, width, height, f.unknown3, f.unknown4, f.unknown5,
    f.unknown6, f.unknown7, f.unknown8, f.unknown9];
  return Uint8Array.from(fields.flatMap(u16be));
}

/** crc(4) | 0x01 | 19 zeros | payload, with the CRC-32C over `payload`. */
export function wrapStream(payload: Uint8Array): { bytes: Uint8Array; crc: number } {
  const crc = crc32c(payload);
  const out = new Uint8Array(STREAM_WRAPPER_LEN + payload.length);
  out.set(u32be(crc), 0);
  out[4] = 1;
  out.set(payload, STREAM_WRAPPER_LEN);
  return { bytes: out, crc };
}

export interface RgbImage { width: number; height: number; pixels: Uint8Array }

export function validateRgbImage(img: RgbImage): void {
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height) || img.width < 1 || img.height < 1)
    throw new RangeError('invalid image dimensions');
  if (img.pixels.length !== img.width * img.height * 3)
    throw new RangeError(`pixel buffer size mismatch: got ${img.pixels.length}, expected ${img.width * img.height * 3}`);
}

/** Complete stream (wrapper+metadata+pixels) for a static image. Throws before any I/O. */
export function buildImageStream(img: RgbImage, maxBytes = MAX_STREAM_BYTES) {
  validateRgbImage(img);
  const limit = Math.min(maxBytes, MAX_STREAM_BYTES);
  const payload = new Uint8Array(METADATA_LEN + img.pixels.length);
  payload.set(buildImageMetadata(img.width, img.height), 0);
  payload.set(img.pixels, METADATA_LEN);
  const { bytes, crc } = wrapStream(payload);
  if (bytes.length > limit) throw new RangeError(`encoded stream is ${bytes.length} bytes; limit is ${limit}`);
  return { bytes, crc };
}

/** Complete stream for a looping GIF using the reference's GIF metadata profile. */
export function buildGifStream(gif: Uint8Array, width: number, height: number, maxBytes = MAX_STREAM_BYTES) {
  const limit = Math.min(maxBytes, MAX_STREAM_BYTES);
  const payload = new Uint8Array(METADATA_LEN + gif.length);
  payload.set(buildImageMetadata(width, height, GIF_METADATA_DEFAULTS), 0);
  payload.set(gif, METADATA_LEN);
  const { bytes, crc } = wrapStream(payload);
  if (bytes.length > limit) throw new RangeError(`encoded stream is ${bytes.length} bytes; limit is ${limit}`);
  return { bytes, crc };
}

/** Split a stream into Continue frames. Frames are never split across writes. */
export function buildContinueFrames(stream: Uint8Array, chunkSize: number): Uint8Array[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError('invalid chunk size');
  const frames: Uint8Array[] = [];
  for (let off = 0, seq = 0; off < stream.length; off += chunkSize, seq++)
    frames.push(buildContinue(seq, stream.subarray(off, off + chunkSize)));
  return frames;
}
