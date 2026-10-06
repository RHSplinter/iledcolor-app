import type { Fit } from '../render/image';
import type { Transform } from '../render/matrix';

export type Content =
  | { kind: 'solid'; color: string }
  | { kind: 'text'; text: string; fg: string; bg: string; speed?: number }
  | { kind: 'image'; dataUrl: string; fit: Fit; bg: string };

export interface Preset { id: string; name: string; content: Content; updatedAt: number }

export interface Settings {
  width: number; height: number; transform: Transform; brightness: number;
  /** True only after the compatibility spike confirmed these dimensions on the real hat. */
  dimensionsVerified: boolean;
  chunkSize: number; interWriteDelayMs: number;
}
export const DEFAULT_SETTINGS: Settings = {
  width: 32, height: 16, transform: { rotation: 0, mirrorH: false, mirrorV: false }, brightness: 8,
  dimensionsVerified: false, chunkSize: 8, interWriteDelayMs: 10,
};

export const EXPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
export const MAX_PRESETS = 200;
const HEX = /^#[0-9a-f]{6}$/i;

export interface ExportFile { app: 'iledcolor-app'; version: number; settings: Settings; presets: Preset[] }

export function exportJson(settings: Settings, presets: Preset[]): string {
  const f: ExportFile = { app: 'iledcolor-app', version: EXPORT_VERSION, settings, presets };
  return JSON.stringify(f, null, 2);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export const DEFAULT_SPEED = 5;
function speedOf(v: unknown): number { if (!isInt(v, 1, 10)) throw new Error('invalid speed'); return v; }

export function validateContent(c: unknown): Content {
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
export function parseImport(text: string): { settings: Settings; presets: Preset[] } {
  if (text.length > MAX_IMPORT_BYTES) throw new Error('Import file is too large.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('File is not valid JSON.'); }
  if (!isObj(raw) || raw.app !== 'iledcolor-app') throw new Error('Not an iledcolor-app export.');
  if (raw.version !== EXPORT_VERSION) throw new Error(`Unsupported export version ${String(raw.version)}.`);
  if (!Array.isArray(raw.presets) || raw.presets.length > MAX_PRESETS) throw new Error('Invalid preset list.');
  const ids = new Set<string>();
  const presets = raw.presets.map((p: unknown, i: number) => {
    try {
      if (!isObj(p)) throw new Error('not an object');
      if (typeof p.id !== 'string' || !p.id || p.id.length > 64 || ids.has(p.id)) throw new Error('invalid or duplicate id');
      ids.add(p.id);
      if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60) throw new Error('invalid name');
      if (!isInt(p.updatedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error('invalid timestamp');
      return { id: p.id, name: p.name, updatedAt: p.updatedAt, content: validateContent(p.content) };
    } catch (e) {
      throw new Error(`Preset ${i + 1}: ${(e as Error).message}`);
    }
  });
  return { settings: validateSettings(raw.settings), presets };
}
