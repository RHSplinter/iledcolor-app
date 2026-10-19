import type { Fit } from '../render/image';
import type { Transform } from '../render/matrix';
import { TIER_IDS, type TierConfig, type TierId } from '../approach/tiers';
import { validateGreetingProfiles, type GreetingProfileState } from '../scanner/greeting';

export type SingleContent =
  | { kind: 'solid'; color: string }
  | { kind: 'text'; text: string; fg: string; bg: string; speed?: number }
  | { kind: 'image'; dataUrl: string; fit: Fit; bg: string };
/** One step of a sequence. Static content is shown for `seconds`; animations play whole cycles for at least `seconds`. */
export interface SequenceStep { content: SingleContent; seconds: number }
export type SequenceContent = { kind: 'sequence'; steps: SequenceStep[] };
export type Content = SingleContent | SequenceContent;

export const MAX_SEQUENCE_STEPS = 20;
export const MAX_STEP_SECONDS = 60;
export const DEFAULT_STEP_SECONDS = 3;
/** Same budget as one stored image, so sequence presets stay shareable and backups stay within the import limit. */
export const MAX_SEQUENCE_IMAGE_CHARS = 1_500_000;

export interface ContentPreset { id: string; name: string; content: Content; updatedAt: number }
/** Approach-mode content for every group size (Approach tab → "Content per group size"). */
export type GroupContent = Record<TierId, TierConfig>;
export interface GroupPreset { id: string; name: string; groups: GroupContent; updatedAt: number }
export type Preset = ContentPreset | GroupPreset;
export const isGroupPreset = (p: Preset): p is GroupPreset => 'groups' in p;

export interface Settings {
  width: number; height: number; transform: Transform; brightness: number;
  /** True only after the compatibility spike confirmed these dimensions on the real hat. */
  dimensionsVerified: boolean;
  chunkSize: number; interWriteDelayMs: number;
}
export const DEFAULT_SETTINGS: Settings = {
  width: 32, height: 16, transform: { rotation: 0, mirrorH: false, mirrorV: false }, brightness: 8,
  dimensionsVerified: true, chunkSize: 492, interWriteDelayMs: 1,
};

export const EXPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
export const MAX_PRESETS = 200;
const HEX = /^#[0-9a-f]{6}$/i;

export interface ExportFile {
  app: 'iledcolor-app';
  version: number;
  settings: Settings;
  presets: Preset[];
  qrProfiles: GreetingProfileState;
}

export function exportJson(settings: Settings, presets: Preset[], qrProfiles: GreetingProfileState = { selectedId: null, profiles: [] }): string {
  const f: ExportFile = { app: 'iledcolor-app', version: EXPORT_VERSION, settings, presets, qrProfiles: validateGreetingProfiles(qrProfiles) };
  return JSON.stringify(f, null, 2);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export const DEFAULT_SPEED = 5;
function speedOf(v: unknown): number { if (!isInt(v, 1, 10)) throw new Error('invalid speed'); return v; }

export function validateContent(c: unknown): Content {
  if (isObj(c) && c.kind === 'sequence') {
    const steps = validateSequenceSteps(c.steps);
    if (!steps.length) throw new Error('sequence needs at least one step');
    return { kind: 'sequence', steps };
  }
  return validateSingleContent(c);
}

/** Validates a (possibly empty) step list, e.g. the Connect tab's sequence draft. */
export function validateSequenceSteps(raw: unknown): SequenceStep[] {
  if (!Array.isArray(raw) || raw.length > MAX_SEQUENCE_STEPS) throw new Error(`a sequence has at most ${MAX_SEQUENCE_STEPS} steps`);
  let imageChars = 0;
  const steps = raw.map((s: unknown, i: number): SequenceStep => {
    if (!isObj(s)) throw new Error(`invalid sequence step ${i + 1}`);
    if (isObj(s.content) && s.content.kind === 'sequence') throw new Error('sequences cannot be nested');
    if (!isInt(s.seconds, 1, MAX_STEP_SECONDS)) throw new Error(`invalid duration in sequence step ${i + 1}`);
    let content: SingleContent;
    try { content = validateSingleContent(s.content); } catch (e) { throw new Error(`sequence step ${i + 1}: ${(e as Error).message}`); }
    if (content.kind === 'image') imageChars += content.dataUrl.length;
    return { content, seconds: s.seconds };
  });
  if (imageChars > MAX_SEQUENCE_IMAGE_CHARS) throw new Error('sequence images are too large; use fewer or smaller images');
  return steps;
}

function validateSingleContent(c: unknown): SingleContent {
  if (!isObj(c)) throw new Error('content must be an object');
  const color = (v: unknown, n: string) => { if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`invalid ${n}`); return v; };
  if (c.kind === 'solid') return { kind: 'solid', color: color(c.color, 'color') };
  if (c.kind === 'text') {
    if (typeof c.text !== 'string' || c.text.length > 200) throw new Error('invalid text');
    return { kind: 'text', text: c.text, fg: color(c.fg, 'fg'), bg: color(c.bg, 'bg'), ...(c.speed === undefined ? {} : { speed: speedOf(c.speed) }) };
  }
  if (c.kind === 'image') {
    if (typeof c.dataUrl !== 'string' || !/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(c.dataUrl)
      || c.dataUrl.length > 1_500_000) throw new Error('invalid image data');
    if (c.fit !== 'contain' && c.fit !== 'cover' && c.fit !== 'stretch') throw new Error('invalid fit');
    return { kind: 'image', dataUrl: c.dataUrl, fit: c.fit, bg: color(c.bg, 'bg') };
  }
  throw new Error('unknown content kind');
}

/** Strict: every group size must be present and valid. */
export function validateGroups(g: unknown): GroupContent {
  if (!isObj(g)) throw new Error('groups must be an object');
  const out = {} as GroupContent;
  for (const id of TIER_IDS) {
    const t = g[id];
    if (!isObj(t)) throw new Error(`missing group ${id}`);
    if (t.mode !== 'individual' && t.mode !== 'span') throw new Error(`invalid mode in ${id}`);
    if (typeof t.text !== 'string' || t.text.length > 120) throw new Error(`invalid text in ${id}`);
    for (const k of ['fg', 'bg'] as const) if (typeof t[k] !== 'string' || !HEX.test(t[k] as string)) throw new Error(`invalid ${k} in ${id}`);
    if (t.useCreate !== undefined && (id !== 'solo' || typeof t.useCreate !== 'boolean')) throw new Error(`invalid useCreate in ${id}`);
    out[id] = { mode: t.mode, text: t.text, fg: t.fg as string, bg: t.bg as string, speed: speedOf(t.speed),
      ...(t.useCreate === true ? { useCreate: true } : {}) };
  }
  return out;
}

export function validateSettings(s: unknown): Settings {
  if (!isObj(s) || !isObj(s.transform)) throw new Error('invalid settings');
  const t = s.transform;
  if (![0, 90, 180, 270].includes(t.rotation as number) || typeof t.mirrorH !== 'boolean' || typeof t.mirrorV !== 'boolean')
    throw new Error('invalid transform');
  if (!isInt(s.width, 1, 256) || !isInt(s.height, 1, 256)) throw new Error('invalid dimensions');
  if (!isInt(s.brightness, 0, 10)) throw new Error('invalid brightness');
  if (!isInt(s.chunkSize, 1, 512) || !isInt(s.interWriteDelayMs, 0, 1000)) throw new Error('invalid transport profile');
  return {
    width: s.width, height: s.height, brightness: s.brightness, dimensionsVerified: s.dimensionsVerified === true,
    chunkSize: s.chunkSize, interWriteDelayMs: s.interWriteDelayMs,
    transform: { rotation: t.rotation as 0 | 90 | 180 | 270, mirrorH: t.mirrorH, mirrorV: t.mirrorV },
  };
}

/** Validates everything; throws with a readable message and never returns partial data. */
export function parseImport(text: string): { settings: Settings; presets: Preset[]; qrProfiles: GreetingProfileState } {
  if (text.length > MAX_IMPORT_BYTES) throw new Error('Import file is too large.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('File is not valid JSON.'); }
  if (!isObj(raw) || raw.app !== 'iledcolor-app') throw new Error('Not an iledcolor-app export.');
  if (raw.version !== EXPORT_VERSION) throw new Error(`Unsupported export version ${String(raw.version)}.`);
  if (!Array.isArray(raw.presets) || raw.presets.length > MAX_PRESETS) throw new Error('Invalid preset list.');
  const ids = new Set<string>();
  const presets = raw.presets.map((p: unknown, i: number): Preset => {
    try {
      if (!isObj(p)) throw new Error('not an object');
      if (typeof p.id !== 'string' || !p.id || p.id.length > 64 || ids.has(p.id)) throw new Error('invalid or duplicate id');
      ids.add(p.id);
      if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60) throw new Error('invalid name');
      if (!isInt(p.updatedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error('invalid timestamp');
      if ('groups' in p) {
        if ('content' in p) throw new Error('both content and groups');
        return { id: p.id, name: p.name, updatedAt: p.updatedAt, groups: validateGroups(p.groups) };
      }
      return { id: p.id, name: p.name, updatedAt: p.updatedAt, content: validateContent(p.content) };
    } catch (e) {
      throw new Error(`Preset ${i + 1}: ${(e as Error).message}`);
    }
  });
  const qrProfiles = raw.qrProfiles === undefined
    ? { selectedId: null, profiles: [] }
    : validateGreetingProfiles(raw.qrProfiles);
  return { settings: validateSettings(raw.settings), presets, qrProfiles };
}
