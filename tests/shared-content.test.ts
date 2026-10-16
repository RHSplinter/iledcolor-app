import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_APPROACH, type TierConfig, type ApproachSettings, type TierId } from '../src/approach/tiers';
import { ApproachEngine } from '../src/approach/engine';
import { encodeBeacon } from '../src/approach/beaconCodec';
import { chooseGroupText, contentSnapshot, decodeTierContent, encodeTierContent, CONTENT_STALE_MS,
  CONTENT_HEADER, CONTENT_SERVICE, contentCharacteristic, type CapText } from '../src/approach/sharedContent';
import { readPeerContent } from '../src/approach/contentExchange';
import { BleClient } from '@capacitor-community/bluetooth-le';

vi.mock('@capacitor-community/bluetooth-le', () => ({
  BleClient: { connect: vi.fn(), read: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('../src/transport/nativeBle', () => ({ initNativeBle: vi.fn().mockResolvedValue(undefined) }));

const config = (text: string, extra: Partial<TierConfig> = {}): TierConfig =>
  ({ mode: 'span', text, fg: '#ffcc00', bg: '#000001', speed: 5, ...extra });
const row = (key: string, text: string): CapText => ({ key, label: key, local: false, config: config(text) });

describe('shared text wire format', () => {
  it('round trips Unicode, empty and maximum-size texts and Create choice within one GATT attribute', () => {
    for (const text of ['', 'Hi {other} 👋', '帽'.repeat(120), '\0'.repeat(120)]) {
      const c = config(text, { useCreate: true });
      const bytes = encodeTierContent(c);
      expect(bytes.length).toBeLessThanOrEqual(372);
      expect(decodeTierContent(bytes)).toEqual(c);
    }
    expect(decodeTierContent(encodeTierContent(config('x', { mode: 'individual' })))).toEqual(config('x', { mode: 'individual' }));
  });
  it('rejects unsupported versions, modes, speeds, flags, malformed UTF-8 and oversized text', () => {
    for (const [index, value] of [[0, 2], [1, 2], [2, 0], [2, 11], [3, 2], [12, 255]]) {
      const bytes = encodeTierContent(config('x'));
      bytes[index!] = value!;
      expect(() => decodeTierContent(bytes)).toThrow();
    }
    expect(() => decodeTierContent(new Uint8Array(9))).toThrow();
    expect(() => decodeTierContent(encodeTierContent(config('x'.repeat(121))))).toThrow();
    expect(() => decodeTierContent(new Uint8Array(373))).toThrow();
    expect(() => decodeTierContent(encodeTierContent(config('A long text')).subarray(0, 16))).toThrow('Incomplete');
  });
  it('identifies the phone and revisions all five original proposals deterministically', () => {
    const tiers = structuredClone(DEFAULT_APPROACH.tiers);
    const a = contentSnapshot(0xdeadbeef, tiers);
    expect(a).toHaveLength(6);
    expect(new DataView(a[0]!.buffer).getUint32(0)).toBe(0xdeadbeef);
    expect(contentSnapshot(0xdeadbeef, tiers)).toEqual(a);
    tiers.upTo8.text = 'new text';
    expect(contentSnapshot(0xdeadbeef, tiers)[0]).not.toEqual(a[0]);
  });
});

describe('most common marquee proposal', () => {
  it('does not elect automatically for two caps or tied texts', () => {
    expect(chooseGroupText([row('a', 'A'), row('b', 'A')]).winner).toBeUndefined();
    expect(chooseGroupText([row('a', 'A'), row('b', 'B'), row('c', 'C')]).tied).toBe(true);
    expect(chooseGroupText([row('a', 'A'), row('b', 'A'), row('c', 'B'), row('d', 'B')]).winner).toBeUndefined();
  });
  it('does not elect a text without a strict majority, even when it is the unique most common', () => {
    const rows = [row('a', 'A'), row('b', 'B'), row('c', 'A'), row('d', 'C'), row('e', 'D')];
    const choice = chooseGroupText(rows);
    expect(choice.votes).toBe(2);
    expect(choice.tied).toBe(false);
    expect(choice.winner).toBeUndefined();
  });
  it('uses a strict majority; canonical first cap supplies colours and speed', () => {
    const rows = [row('a', 'A'), row('b', 'B'), row('c', 'A'), row('d', 'C'), row('e', 'A')];
    rows[2]!.config!.speed = 9;
    const choice = chooseGroupText(rows);
    expect(choice.votes).toBe(3);
    expect(choice.winner).toBe(rows[0]);
    expect(choice.winner!.config!.speed).toBe(5);
  });
  it('does not invent votes from unavailable content or take over Individual greetings', () => {
    expect(chooseGroupText([row('a', 'A'), row('b', 'A'), { key: 'c', label: 'C', local: false }]).winner).toBeUndefined();
    const rows = [row('a', 'A'), row('b', 'A'), row('c', 'B')];
    rows.forEach((r) => { r.config!.mode = 'individual'; });
    expect(chooseGroupText(rows).winner).toBeUndefined();
  });
});

describe('group content integration', () => {
  const group = (texts: string[], tier: TierId = 'upTo4', capCounts = texts.map(() => 1)) => {
    const settings = texts.map((text): ApproachSettings => {
      const s = structuredClone(DEFAULT_APPROACH);
      s.settleMs = 0;
      s.confirmMs = 0;
      s.tiers[tier] = config(text);
      return s;
    });
    const engines = settings.map((s, i) => {
      const e = new ApproachEngine(i + 1, s);
      e.setLocalCaps(Array.from({ length: capCounts[i]! }, (_, j) => ({ key: `local${j}`, label: `${i + 1}-${j}`, bleName: `${i}-${j}` })));
      return e;
    });
    const hear = (now: number) => engines.forEach((e, i) => {
      e.getLocalCaps().forEach((c) => e.onLocalRssi(c.key, -45, now));
      engines.forEach((peer, j) => {
        if (j === i) return;
        e.onAdvertisement({ deviceId: `phone${j}`, rssi: -50, uuids: [encodeBeacon(peer.beacon(now))] }, now);
        e.receiveContent(j + 1, tier, settings[j]!.tiers[tier], now);
      });
    });
    hear(0);
    return { engines, settings, hear };
  };
  it('selects the same text on all three phones, without changing stored votes', () => {
    const { engines, settings } = group(['A', 'B', 'B']);
    engines.forEach((e) => {
      expect(e.tick(0)!.perCap.get('local0')).toMatchObject({ kind: 'span', text: 'B', total: 3 });
      expect(e.groupTexts(0).votes).toBe(2);
    });
    expect(settings[0]!.tiers.upTo4.text).toBe('A');
    expect(engines[0]!.groupTexts(0).rows.find((r) => r.local)!.config!.text).toBe('A');
  });
  it('counts caps rather than phones in mixed Master/P2P groups', () => {
    const { engines } = group(['A', 'B'], 'upTo4', [1, 2]);
    engines.forEach((e) => expect(e.tick(0)!.perCap.get('local0')).toMatchObject({ text: 'B', total: 3 }));
  });
  it('allows a full serial read round in larger groups but still expires cached proposals', () => {
    const { engines, settings, hear } = group(['A', 'B', 'B', 'B', 'B'], 'upTo8');
    hear(16000);
    const a = engines[0]!;
    engines.slice(1).forEach((_, i) => a.receiveContent(i + 2, 'upTo8', settings[i + 1]!.tiers.upTo8, 0));
    expect(a.groupTexts(16000).winner!.config!.text).toBe('B');
    expect(a.groupTexts(20000).winner).toBeUndefined();
  });
  it('keeps each original text on ties and with only two caps', () => {
    for (const [texts, tier] of [[['A', 'B'], 'pair'], [['A', 'B', 'C'], 'upTo4']] as const) {
      const { engines } = group([...texts], tier);
      engines.forEach((e, i) => expect(e.tick(0)!.perCap.get('local0')).toMatchObject({ text: texts[i] }));
    }
  });
  it('expires content even while a phone is still nearby and excludes departed caps', () => {
    const { engines, hear } = group(['A', 'B', 'B']);
    const a = engines[0]!;
    expect(a.groupTexts(0).winner!.config!.text).toBe('B');
    hear(CONTENT_STALE_MS);
    a.receiveContent(2, 'upTo4', config('B'), 0);
    expect(a.groupTexts(CONTENT_STALE_MS).winner).toBeUndefined();
    a.contentFailed(2, 'Read failed');
    expect(a.groupTexts(CONTENT_STALE_MS).rows.find((r) => r.key.startsWith('peer:00000002'))!.unavailable).toBe('Read failed');
    a.onLocalRssi('local0', -45, 60000);
    expect(a.groupTexts(60000).rows).toHaveLength(1);
    expect(a.tick(60000)!.tier).toBe('solo');
  });
  it('re-evaluates changed votes, does not reuse another tier, and preserves Individual mode', () => {
    const { engines, settings } = group(['A', 'B', 'B']);
    const a = engines[0]!;
    a.receiveContent(2, 'upTo4', config('C'), 1);
    expect(a.tick(1)!.perCap.get('local0')).toMatchObject({ text: 'A' });
    a.receiveContent(2, 'pair', config('B'), 2);
    expect(a.groupTexts(2).winner).toBeUndefined();
    a.receiveContent(2, 'upTo4', config('B'), 3);
    a.setSettings({ ...settings[0]!, tiers: { ...settings[0]!.tiers, upTo4: config('Hi {other}', { mode: 'individual' }) } });
    expect(a.tick(3)!.perCap.get('local0')!.kind).toBe('individual');
  });
});

describe('phone GATT content reader', () => {
  beforeEach(() => vi.resetAllMocks());
  const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  it('checks identity and revision before and after reading; disconnects only the peer', async () => {
    const snapshot = contentSnapshot(123, DEFAULT_APPROACH.tiers);
    const bytes = encodeTierContent(config('帽'.repeat(120)));
    const padded = new Uint8Array(bytes.length + 7);
    padded.set(bytes, 7);
    vi.mocked(BleClient.read).mockResolvedValueOnce(view(snapshot[0]!))
      .mockResolvedValueOnce(view(padded.subarray(7))).mockResolvedValueOnce(view(snapshot[0]!));
    expect(await readPeerContent('phone123', 123, 'pair')).toEqual(config('帽'.repeat(120)));
    expect(BleClient.read).toHaveBeenNthCalledWith(2, 'phone123', CONTENT_SERVICE, contentCharacteristic('pair'), { timeout: 5000 });
    expect(BleClient.disconnect).toHaveBeenCalledExactlyOnceWith('phone123');
  });
  it('rejects foreign identity, changed snapshots and read failures and still disconnects', async () => {
    const snapshot = contentSnapshot(123, DEFAULT_APPROACH.tiers);
    vi.mocked(BleClient.read).mockResolvedValueOnce(view(snapshot[0]!));
    await expect(readPeerContent('peer', 456, 'pair')).rejects.toThrow('different phone');
    expect(BleClient.disconnect).toHaveBeenCalledExactlyOnceWith('peer');
    vi.clearAllMocks();
    const changed = snapshot[0]!.slice();
    changed[7]! ^= 1;
    vi.mocked(BleClient.read).mockResolvedValueOnce(view(snapshot[0]!))
      .mockResolvedValueOnce(view(snapshot[2]!)).mockResolvedValueOnce(view(changed));
    await expect(readPeerContent('peer', 123, 'pair')).rejects.toThrow('changed');
    expect(BleClient.disconnect).toHaveBeenCalledExactlyOnceWith('peer');
    vi.clearAllMocks();
    vi.mocked(BleClient.read).mockRejectedValueOnce(new Error('Read timed out'));
    await expect(readPeerContent('peer', 123, 'pair')).rejects.toThrow('Read timed out');
    expect(BleClient.disconnect).toHaveBeenCalledExactlyOnceWith('peer');
    expect(CONTENT_HEADER).not.toBe(CONTENT_SERVICE);
  });
});
