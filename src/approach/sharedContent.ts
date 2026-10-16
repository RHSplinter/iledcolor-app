import { TIER_IDS, type TierConfig, type TierId } from './tiers';

export const CONTENT_SERVICE = '4c454448-1000-4000-8000-000000000001';
export const CONTENT_HEADER = '4c454448-1000-4000-8000-000000000002';
export const CONTENT_REFRESH_MS = 5000;
export const CONTENT_STALE_MS = 15000;
export const contentCharacteristic = (tier: TierId) => `4c454448-1000-4000-8000-${String(10 + TIER_IDS.indexOf(tier)).padStart(12, '0')}`;

/** Binary rather than JSON: even 120 non-ASCII characters fit the 512-byte GATT attribute limit. */
export function encodeTierContent(c: TierConfig): Uint8Array {
  const text = new TextEncoder().encode(c.text);
  const data = new Uint8Array(12 + text.length);
  data.set([1, c.mode === 'span' ? 1 : 0, c.speed, c.useCreate ? 1 : 0]);
  for (const [offset, color] of [[4, c.fg], [7, c.bg]] as const)
    data.set(color.slice(1).match(/../g)!.map((v) => parseInt(v, 16)), offset);
  new DataView(data.buffer).setUint16(10, text.length);
  data.set(text, 12);
  return data;
}

export function decodeTierContent(data: Uint8Array): TierConfig {
  if (data.length < 12 || data.length > 372 || data[0] !== 1 || data[1]! > 1
    || data[2]! < 1 || data[2]! > 10 || data[3]! > 1) throw new Error('Invalid shared text');
  if (new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(10) !== data.length - 12)
    throw new Error('Incomplete shared text');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(12));
  if (text.length > 120) throw new Error('Shared text is too long');
  const color = (offset: number) => '#' + [...data.subarray(offset, offset + 3)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { mode: data[1] ? 'span' : 'individual', speed: data[2]!, text, fg: color(4), bg: color(7),
    ...(data[3] ? { useCreate: true } : {}) };
}

export function contentSnapshot(phoneId: number, tiers: Record<TierId, TierConfig>): Uint8Array[] {
  const values = TIER_IDS.map((tier) => encodeTierContent(tiers[tier]));
  let revision = 0x811c9dc5;
  for (const value of values) for (const b of value) revision = Math.imul(revision ^ b, 0x01000193) >>> 0;
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, phoneId);
  view.setUint32(4, revision);
  return [header, ...values];
}

export interface CapText {
  key: string;
  label: string;
  local: boolean;
  config?: TierConfig;
  unavailable?: string;
}

export interface TextChoice {
  rows: CapText[];
  winner?: CapText;
  votes: number;
  tied: boolean;
}

/** Original proposals vote per cap, never the temporarily selected text (which would manufacture votes). */
export function chooseGroupText(rows: CapText[]): TextChoice {
  const votes = new Map<string, CapText[]>();
  for (const row of rows) {
    if (row.config?.mode !== 'span') continue;
    const group = votes.get(row.config.text) ?? [];
    group.push(row);
    votes.set(row.config.text, group);
  }
  const ranked = [...votes.values()].sort((a, b) => b.length - a.length);
  const top = ranked[0];
  const tied = !!top && ranked[1]?.length === top.length;
  // Wait for every participant: a partial view could elect different texts on different phones.
  const complete = rows.every((row) => row.config !== undefined);
  // A majority means more than half of all caps in the group, not just the largest minority.
  const majority = !!top && top.length * 2 > rows.length;
  return { rows, votes: top?.length ?? 0, tied,
    winner: rows.length > 2 && complete && majority ? top[0] : undefined };
}
