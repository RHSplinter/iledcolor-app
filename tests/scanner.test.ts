import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GREETING, extractName, greetingDuration, greetingText, validateGreeting, validateGreetingProfiles,
} from '../src/scanner/greeting';
import { DeviceController } from '../src/controller/deviceController';
import { MockTransport } from '../src/transport/mock';
import { SPIKE_PROFILE } from '../src/transport/types';
import { buildGifStream, buildImageStream, Cmd } from '../src/protocol/framing';
import { encodeGif, renewGif } from '../src/render/gif';
import { gifDelayMs } from '../src/render/span';
import { solid } from '../src/render/matrix';

const img = { width: 4, height: 2, pixels: new Uint8Array(24).fill(12) };
const still = { ...img, pixels: new Uint8Array(24).fill(99) };
const gif = encodeGif([still, img], 40, { plays: 3 });
const setup = async () => {
  const transport = new MockTransport();
  const controller = new DeviceController({ profile: { ...SPIKE_PROFILE, interWriteDelayMs: 0 } });
  await controller.connect(async () => transport);
  return { controller, transport };
};
function streams(t: MockTransport): Uint8Array[] {
  const result: number[][] = [];
  for (const { frame } of t.writes) {
    if (frame[1] === 0x06) result.push([]);
    if (frame[1] === 0x00) result[result.length - 1]!.push(...frame.subarray(10, -2));
  }
  return result.map((s) => Uint8Array.from(s));
}
afterEach(() => vi.useRealTimers());

describe('QR names and greeting settings', () => {
  it('defaults to three repetitions', () => {
    expect(DEFAULT_GREETING.repetitions).toBe(3);
    expect(DEFAULT_GREETING.speed).toBe(3);
    expect(validateGreeting(DEFAULT_GREETING)).toEqual(DEFAULT_GREETING);
  });
  it.each([
    ['Rob Bos', 'Rob Bos'],
    ['{"firstName":"Rob","lastName":"Bos"}', 'Rob Bos'],
    ['{"name":"Rob Bos","email":"private@example.org"}', 'Rob Bos'],
    ['BEGIN:VCARD\r\nFN:Rob Bos\r\nEND:VCARD', 'Rob Bos'],
    ['BEGIN:VCARD\nN:Bos;Rob;;;\nEND:VCARD', 'Rob Bos'],
    ['BEGIN:VCARD\nFN:Rob\n Bos\nEND:VCARD', 'RobBos'],
    ['MECARD:N:Bos,Rob;ORG:Xebia;EMAIL:rob@example.org;;', 'Rob Bos'],
    ['Xebia Build\n7 Rob\nBos\nSoftware Engineer\nXebia', 'Rob Bos'],
  ])('extracts supported data without a regex: %s', (raw, name) => expect(extractName(raw, '').name).toBe(name));
  it('parses badge contact fields and makes them available to greeting templates', () => {
    const parsed = extractName(
      'BEGIN:VCARD\nFN:Rob Bos\nORG:Xebia\nTITLE:Software Engineer\nEMAIL:rob@example.org\nTEL:+31 20 123 4567\nURL:https://example.org\nNOTE:Speaker\nEND:VCARD',
      '',
    );
    expect(parsed).toEqual({
      name: 'Rob Bos', company: 'Xebia', title: 'Software Engineer', email: 'rob@example.org',
      phone: '+31 20 123 4567', url: 'https://example.org', notes: 'Speaker',
    });
    expect(greetingText('Hi {name}, {title} at {company}: {email}', parsed))
      .toBe('Hi Rob Bos, Software Engineer at Xebia: rob@example.org');
  });
  it('keeps oversized optional vCard notes from blocking a valid name', () => {
    const notes = 'S'.repeat(350);
    const parsed = extractName(`BEGIN:VCARD\nFN:Rob Bos\nNOTE:${notes}\nEND:VCARD`, '');
    expect(parsed).toMatchObject({ name: 'Rob Bos', notes });
    expect(greetingText('Hi {name}!', parsed)).toBe('Hi Rob Bos!');
    expect(() => greetingText('Hi {name}: {notes}', parsed)).toThrow(/too long/);
  });
  it('respects escaped delimiters in MECARD values', () => {
    const parsed = extractName(String.raw`MECARD:N:Doe\, Jr.,John;NOTE:Speaker\;Tier\;ORG:Ignored;ORG:Xebia;;`, '');
    expect(parsed).toEqual({ name: 'John Doe, Jr.', company: 'Xebia', notes: 'Speaker;Tier;ORG:Ignored' });
  });
  it('does not interpret escaped MECARD delimiters as fields or structured-name separators', () => {
    expect(extractName(String.raw`MECARD:N:Bos,Rob;NOTE:Contact\;TEL:12345678;;`, ''))
      .toEqual({ name: 'Rob Bos', notes: 'Contact;TEL:12345678' });
    expect(extractName(String.raw`MECARD:N:Smith\, Jr.,Jane;;`, ''))
      .toEqual({ name: 'Jane Smith, Jr.' });
  });
  it('reconstructs noisy OCR names and extracts contacts from printed text', () => {
    const parsed = extractName('Conference\n7Rob\nBos\nSoftware Engineer\nXebia\nrob@example.org\n+31 20 123 4567', '');
    expect(parsed).toMatchObject({
      name: 'Rob Bos', title: 'Software Engineer', company: 'Xebia',
      email: 'rob@example.org', phone: '+31 20 123 4567',
    });
    expect(extractName('Rob Bos\nSoftware Engineer\nXebia\nSpeaker', '').notes).toBe('Badge tier: Speaker');
  });
  it('preserves Unicode letters in OCR names and reconstructs names without a title', () => {
    expect(extractName('José Nuñez\nSoftware Engineer\nXebia', '').name).toBe('José Nuñez');
    expect(extractName('Zoë\nSoftware Engineer\nXebia', '').name).toBe('Zoë');
    expect(extractName('Rob\nBos\nXebia', '')).toMatchObject({ name: 'Rob Bos', company: 'Xebia' });
  });
  it('supports a named group, first capture group, full match and literal replacement', () => {
    expect(extractName('id=3;name=Rob Bos;', 'name=(?<name>[^;]+)')).toEqual({ name: 'Rob Bos' });
    expect(extractName('id=3;name=Rob;', 'name=([^;]+)')).toEqual({ name: 'Rob' });
    expect(extractName('id=3;name=Rob;', 'Rob')).toEqual({ name: 'Rob' });
    expect(extractName('Rob|Bos|Xebia', '([^|]+)\\|([^|]+)\\|([^|]+)')).toEqual({ name: 'Rob', lastname: 'Bos', company: 'Xebia' });
    expect(extractName('Rob|Bos|Xebia|Engineer|rob@example.org', '(?<name>[^|]+)\\|(?<lastname>[^|]+)\\|(?<company>[^|]+)\\|(?<title>[^|]+)\\|(?<email>[^|]+)'))
      .toMatchObject({ name: 'Rob', lastname: 'Bos', company: 'Xebia', title: 'Engineer', email: 'rob@example.org' });
    expect(extractName('Rob,Bos,Xebia', '(?<name>[^,]+),(?<lastname>[^,]+),(?<company>[^,]+)')).toEqual({
      name: 'Rob', lastname: 'Bos', company: 'Xebia',
    });
    expect(extractName('Rob|Engineer|rob@example.org', '(?<name>[^|]+)\\|(?<title>[^|]+)\\|(?<email>[^|]+)'))
      .toEqual({ name: 'Rob', title: 'Engineer', email: 'rob@example.org' });
    expect(extractName('Rob|Bos|Xebia|Engineer', '(?<name>[^|]+)\\|([^|]+)\\|([^|]+)\\|(?<title>[^|]+)'))
      .toEqual({ name: 'Rob', lastname: 'Bos', company: 'Xebia', title: 'Engineer' });
    expect(greetingText('Hi {name}, {lastname} at {company}!', extractName('Rob|Bos|Xebia', '([^|]+)\\|([^|]+)\\|([^|]+)')))
      .toBe('Hi Rob, Bos at Xebia!');
    expect(greetingText('Hi {name} {lastname} {company}!', { name: 'Rob' })).toBe('Hi Rob  !');
    expect(greetingText('Hi {name}, {name}!', '$&')).toBe('Hi $&, $&!');
  });
  it('extracts the MS AI Tour badge format and accepts firstname as the greeting token', () => {
    const pattern = String.raw`^[^^]*\^(?<firstname>[^^]+)\^(?<lastname>[^^]+)\^(?<company>[^^]+)\^`;
    const fields = extractName('badge^Rob^Bos^MS AI Tour^', pattern);
    expect(fields).toEqual({ name: 'Rob', lastname: 'Bos', company: 'MS AI Tour' });
    expect(greetingText('Hello {firstname} {lastname} from {company}!', fields))
      .toBe('Hello Rob Bos from MS AI Tour!');
  });
  it('validates up to three unique, named scanner profiles and a none selection', () => {
    const profile = (id: string) => ({ id, note: `Badge ${id}`, pattern: '([^|]+)\\|([^|]+)\\|([^|]+)', template: 'Hi {name} {lastname} at {company}!' });
    expect(validateGreetingProfiles({ selectedId: null, profiles: [] })).toEqual({ selectedId: null, profiles: [] });
    expect(validateGreetingProfiles({ selectedId: '3', profiles: [profile('1'), profile('2'), profile('3')] }).selectedId).toBe('3');
    expect(() => validateGreetingProfiles({ selectedId: null, profiles: [profile('1'), profile('2'), profile('3'), profile('1')] })).toThrow(/up to three/);
    expect(() => validateGreetingProfiles({ selectedId: '2', profiles: [profile('1')] })).toThrow(/not saved/);
  });
  it.each(['https://example.org/123', '{"email":"private@example.org"}', '{invalid', '', 'a'.repeat(4097)])('rejects data without a usable name', (raw) => {
    expect(() => extractName(raw, '')).toThrow();
  });
  it('rejects unmatched patterns and invalid settings', () => {
    expect(() => extractName('Rob', 'name=(.+)')).toThrow(/did not match/);
    for (const patch of [{ pattern: '[' }, { template: 'Hi' }, { repetitions: 0 }, { repetitions: 1.5 }, { repetitions: 65537 }, { speed: 11 }])
      expect(() => validateGreeting({ ...DEFAULT_GREETING, ...patch })).toThrow();
  });
  it('uses the encoded GIF delay and exactly X full periods', () => {
    const delay = gifDelayMs(220 / 3);
    expect(delay).toBe(70);
    expect(greetingDuration(120, delay, 3)).toBe(25200);
    expect(() => greetingDuration(120, delay, Number.MAX_SAFE_INTEGER)).toThrow();
  });
});

describe('greeting GIF metadata', () => {
  const loopCount = (data: Uint8Array) => {
    const i = new TextDecoder().decode(data).indexOf('NETSCAPE2.0');
    return i < 0 ? undefined : data[i + 13]! | (data[i + 14]! << 8);
  };
  it('keeps existing content infinite and makes greetings finite', () => {
    expect(loopCount(encodeGif([img], 40))).toBe(0);
    expect(loopCount(encodeGif([img], 40, { plays: 1 }))).toBeUndefined();
    expect(loopCount(encodeGif([img], 40, { plays: 3 }))).toBe(2);
    expect(() => encodeGif([img], 40, { plays: 0 })).toThrow();
  });
  it('refreshes CRC through a nonvisual GIF comment', () => {
    const refreshed = renewGif(gif);
    expect(refreshed.subarray(0, gif.length - 1)).toEqual(gif.subarray(0, -1));
    expect(refreshed.at(-1)).toBe(0x3b);
    expect(refreshed[gif.length - 1]).toBe(0x21);
    expect(buildGifStream(refreshed, 4, 2).crc).not.toBe(buildGifStream(gif, 4, 2).crc);
  });
});

describe('temporary cap playback', () => {
  it('refuses unknown prior content instead of replacing it irreversibly', async () => {
    const { controller, transport } = await setup();
    await expect(controller.playTemporary(gif, still, 1000)).rejects.toThrow(/Send content/);
    expect(transport.writes).toHaveLength(2);
  });
  it.each([false, true])('clears unknown content to black when opted in (cancelled: %s)', async (cancel) => {
    vi.useFakeTimers();
    const { controller, transport } = await setup();
    expect(controller.canRestoreContent).toBe(false);
    const playback = controller.playTemporary(gif, still, 1000, { clearIfUnknown: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.temporaryActive).toBe(true);
    expect(streams(transport)).toHaveLength(2);
    if (cancel) controller.cancelUpload();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(playback).resolves.toBe(cancel ? 'cancelled' : 'completed');
    const black = solid(still.width, still.height, [0, 0, 0]);
    expect(streams(transport).at(-1)).toEqual(buildImageStream(black).bytes);
    expect(controller.temporaryActive).toBe(false);
    expect(controller.canRestoreContent).toBe(true);
    const next = controller.playTemporary(gif, still, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(next).resolves.toBe('completed');
    expect(streams(transport).at(-1)).toEqual(buildImageStream(black).bytes);
  });
  it('restores the last sent image, not the edited preview, after exactly the requested duration', async () => {
    vi.useFakeTimers();
    const { controller, transport } = await setup();
    const original = structuredClone(img);
    await controller.upload(original);
    original.pixels.fill(0);
    const playback = controller.playTemporary(gif, still, 1000, { clearIfUnknown: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.temporaryActive).toBe(true);
    expect(streams(transport)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(streams(transport)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(playback).resolves.toBe('completed');
    expect(streams(transport).at(-1)).toEqual(buildImageStream(img).bytes);
    expect(controller.temporaryActive).toBe(false);
  });
  it('restores GIF content with a fresh CRC and does not accumulate comments', async () => {
    vi.useFakeTimers();
    const { controller, transport } = await setup();
    const original = encodeGif([img, still], 80);
    await controller.uploadGif(original, 4, 2, img);
    for (let n = 0; n < 2; n++) {
      const playback = controller.playTemporary(gif, still, 100);
      await vi.advanceTimersByTimeAsync(100);
      await playback;
      const restored = streams(transport).at(-1)!;
      expect(restored.length).toBe(buildGifStream(original, 4, 2).bytes.length + 10);
      expect(restored.subarray(46, 46 + original.length - 1)).toEqual(original.subarray(0, -1));
    }
  });
  it('queues other writes and rejects another greeting while playing', async () => {
    vi.useFakeTimers();
    const { controller, transport } = await setup();
    await controller.upload(img);
    const playback = controller.playTemporary(gif, still, 1000);
    await expect(controller.playTemporary(gif, still, 1000)).rejects.toThrow(/already playing/);
    const later = controller.upload(still);
    await vi.advanceTimersByTimeAsync(1000);
    await playback;
    await later;
    const sent = streams(transport);
    expect(sent.at(-2)).toEqual(buildImageStream(img).bytes);
    expect(sent.at(-1)).toEqual(buildImageStream(still).bytes);
    expect(transport.maxInFlight).toBe(1);
  });
  it('ends a greeting early and restores content before resolving', async () => {
    vi.useFakeTimers();
    const { controller, transport } = await setup();
    await controller.upload(img);
    const playback = controller.playTemporary(gif, still, 10000);
    await vi.advanceTimersByTimeAsync(0);
    controller.cancelUpload();
    await vi.advanceTimersByTimeAsync(100);
    await expect(playback).resolves.toBe('cancelled');
    expect(streams(transport).at(-1)).toEqual(buildImageStream(img).bytes);
  });
  it('temporarily enables a display switched off by this app, then switches it off again', async () => {
    vi.useFakeTimers();
    const { controller, transport } = await setup();
    await controller.upload(img);
    await controller.setDisplay(false);
    const start = transport.writes.length;
    const playback = controller.playTemporary(gif, still, 100);
    await vi.advanceTimersByTimeAsync(100);
    await playback;
    const controls = transport.writes.slice(start).filter(({ frame }) => frame[1] === Cmd.DISPLAY_ENABLE);
    expect(controls).toHaveLength(2);
    expect(controls[0]!.frame[4]).toBe(1);
    expect(controls[1]!.frame[4]).toBe(0);
  });
  it.each([false, true])('reports connection loss and never sends stale restoration after reconnect (unknown content: %s)', async (clearIfUnknown) => {
    vi.useFakeTimers();
    const { controller, transport } = await setup();
    if (!clearIfUnknown) await controller.upload(img);
    const playback = controller.playTemporary(gif, still, 1000, { clearIfUnknown });
    const rejected = expect(playback).rejects.toThrow(/could not be restored/);
    await vi.advanceTimersByTimeAsync(0);
    transport.drop();
    const next = new MockTransport();
    const connecting = controller.connect(async () => next);
    await vi.advanceTimersByTimeAsync(1000);
    await connecting;
    await rejected;
    expect(next.writes).toHaveLength(2);
    expect(controller.canRestoreContent).toBe(false);
  });
});
