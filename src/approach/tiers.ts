/** Group-size tiers and their content configuration. */
export type TierId = 'solo' | 'pair' | 'upTo4' | 'upTo8' | 'moreThan8';
export const TIER_IDS: TierId[] = ['solo', 'pair', 'upTo4', 'upTo8', 'moreThan8'];
export const TIER_LABELS: Record<TierId, string> = {
  solo: '1 cap (alone)', pair: '2 caps', upTo4: '3–4 caps', upTo8: '5–8 caps', moreThan8: 'More than 8 caps',
};

export function tierFor(count: number): TierId {
  if (count <= 1) return 'solo';
  if (count === 2) return 'pair';
  if (count <= 4) return 'upTo4';
  if (count <= 8) return 'upTo8';
  return 'moreThan8';
}

/**
 * individual: every cap shows its own text (templates can greet the others).
 * span: one marquee runs across all caps of the group, left to right in group order.
 */
export type TierMode = 'individual' | 'span';
export interface TierConfig { mode: TierMode; text: string; fg: string; bg: string; speed: number; useCreate?: boolean }

export type ApproachMode = 'p2p' | 'hub';

export interface ApproachSettings {
  /** p2p: one cap on this phone, phones find each other via beacons. hub: this phone controls several caps. */
  mode: ApproachMode;
  tiers: Record<TierId, TierConfig>;
  enterDbm: number;
  leaveDbm: number;
  /** A changed group must stay unchanged this long before caps are updated. */
  settleMs: number;
  /** A participant becomes near/away only after repeated reports on the new side spanning this long. */
  confirmMs: number;
  staleMs: number;
  /** Advertise this phone so other phones running the app can count our caps. */
  beacon: boolean;
  /** Count caps seen advertising nearby that are not connected to this phone. */
  countNearbyCaps: boolean;
}

export const TEMPLATE_HELP = '{me} = this cap, {other} = the other cap(s), {count} = caps together, {index} = position in the group';

export const DEFAULT_APPROACH: ApproachSettings = {
  mode: 'p2p',
  tiers: {
    solo: { mode: 'individual', text: '{me}', fg: '#00c8ff', bg: '#000000', speed: 5 },
    pair: { mode: 'individual', text: 'Hi {other}!', fg: '#ffd000', bg: '#000000', speed: 5 },
    upTo4: { mode: 'span', text: '{count} caps together!', fg: '#ff40c0', bg: '#000000', speed: 5 },
    upTo8: { mode: 'span', text: 'Party of {count}!', fg: '#40ff60', bg: '#000000', speed: 5 },
    moreThan8: { mode: 'span', text: 'Crowd of {count} caps!', fg: '#ff6020', bg: '#000000', speed: 6 },
  },
  enterDbm: -70,
  leaveDbm: -75, // ≈ 4 m: caps count as away before they are really out of range
  settleMs: 2000,
  confirmMs: 1000,
  staleMs: 8000,
  beacon: true,
  countNearbyCaps: true,
};

const HEX = /^#[0-9a-f]{6}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d);

/** Lenient: invalid fields fall back to defaults instead of discarding the whole config. */
export function validateApproach(raw: unknown): ApproachSettings {
  const r = isObj(raw) ? raw : {};
  const tiersRaw = isObj(r.tiers) ? r.tiers : {};
  const tiers = {} as Record<TierId, TierConfig>;
  for (const id of TIER_IDS) {
    const d = DEFAULT_APPROACH.tiers[id];
    const t = isObj(tiersRaw[id]) ? (tiersRaw[id] as Record<string, unknown>) : {};
    tiers[id] = {
      mode: t.mode === 'span' || t.mode === 'individual' ? t.mode : d.mode,
      text: typeof t.text === 'string' && t.text.length <= 120 ? t.text : d.text,
      fg: typeof t.fg === 'string' && HEX.test(t.fg) ? t.fg : d.fg,
      bg: typeof t.bg === 'string' && HEX.test(t.bg) ? t.bg : d.bg,
      speed: Math.round(num(t.speed, 1, 10, d.speed)),
      ...(id === 'solo' && t.useCreate === true ? { useCreate: true } : {}),
    };
  }
  const enterDbm = num(r.enterDbm, -110, -20, DEFAULT_APPROACH.enterDbm);
  const mode = r.mode === 'hub' ? 'hub' : 'p2p';
  // -80 was the old default (≈ 7 m); move it to the closer 4 m default.
  const leave = r.leaveDbm === -80 ? DEFAULT_APPROACH.leaveDbm : r.leaveDbm;
  return {
    mode,
    tiers,
    enterDbm,
    leaveDbm: Math.min(enterDbm, num(leave, -120, -20, DEFAULT_APPROACH.leaveDbm)),
    settleMs: num(r.settleMs, 0, 30000, DEFAULT_APPROACH.settleMs),
    confirmMs: num(r.confirmMs, 0, 10000, DEFAULT_APPROACH.confirmMs),
    staleMs: num(r.staleMs, 2000, 60000, DEFAULT_APPROACH.staleMs),
    // P2P only works when phones advertise themselves.
    beacon: mode === 'p2p' || (typeof r.beacon === 'boolean' ? r.beacon : DEFAULT_APPROACH.beacon),
    countNearbyCaps: typeof r.countNearbyCaps === 'boolean' ? r.countNearbyCaps : DEFAULT_APPROACH.countNearbyCaps,
  };
}
