import type { ApproachSettings } from '../approach/tiers';
import { validateGreetingProfiles, type GreetingProfileState } from '../scanner/greeting';
import {
  DEFAULT_SETTINGS, MAX_IMPORT_BYTES, MAX_PRESETS, isGroupPreset, parseImport, validateGroups,
  type ContentPreset, type GroupContent, type GroupPreset, type Preset, type Settings,
} from './presets';

export interface ShareSelection { creations: boolean; approach: boolean; scan: boolean }
export type ScanSettings = Pick<ApproachSettings, 'enterDbm' | 'leaveDbm' | 'settleMs' | 'confirmMs' | 'staleMs'>;
export interface SharedBackup {
  app: 'iledcolor-app';
  version: 2;
  creations?: ContentPreset[];
  approach?: { groups: GroupContent; presets: GroupPreset[] };
  scan?: ScanSettings;
  qrProfiles?: GreetingProfileState;
}
export type ImportedBackup = SharedBackup | { version: 1; settings: Settings; presets: Preset[]; qrProfiles: GreetingProfileState };

export function exportSelectedJson(presets: Preset[], approach: ApproachSettings, selection: ShareSelection, qrProfiles?: GreetingProfileState): string {
  if (!selection.creations && !selection.approach && !selection.scan) throw new Error('Choose at least one category to share.');
  const file: SharedBackup = {
    app: 'iledcolor-app', version: 2,
    ...(selection.creations ? { creations: presets.filter((p): p is ContentPreset => !isGroupPreset(p)) } : {}),
    ...(selection.approach ? { approach: { groups: approach.tiers, presets: presets.filter(isGroupPreset) } } : {}),
    ...(selection.scan ? { scan: {
      enterDbm: approach.enterDbm, leaveDbm: approach.leaveDbm, settleMs: approach.settleMs,
      confirmMs: approach.confirmMs, staleMs: approach.staleMs,
    } } : {}),
    ...(selection.scan && qrProfiles ? { qrProfiles: validateGreetingProfiles(qrProfiles) } : {}),
  };
  if ((file.creations?.length ?? 0) + (file.approach?.presets.length ?? 0) > MAX_PRESETS) {
    throw new Error(`Share at most ${MAX_PRESETS} presets at a time. Choose fewer categories.`);
  }
  const text = JSON.stringify(file, null, 2);
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('Selected data exceeds the 4 MB import limit. Share fewer categories.');
  return text;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validateScan(raw: unknown): ScanSettings {
  if (!isObj(raw)) throw new Error('Invalid scan settings.');
  const number = (key: keyof ScanSettings, min: number, max: number): number => {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid scan setting: ${key}.`);
    return value;
  };
  const scan = {
    enterDbm: number('enterDbm', -110, -20), leaveDbm: number('leaveDbm', -120, -20),
    settleMs: number('settleMs', 0, 30000), confirmMs: number('confirmMs', 0, 10000),
    staleMs: number('staleMs', 2000, 60000),
  };
  if (scan.leaveDbm > scan.enterDbm) throw new Error('Scan away threshold must not exceed the near threshold.');
  return scan;
}

/** Old full backups remain importable; v2 omits categories the sender did not select. */
export function parseSharedBackup(text: string): ImportedBackup {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('Import file is too large.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('File is not valid JSON.'); }
  if (!isObj(raw) || raw.app !== 'iledcolor-app') throw new Error('Not an iledcolor-app export.');
  if (raw.version === 1) return { version: 1, ...parseImport(text) };
  if (raw.version !== 2) throw new Error(`Unsupported export version ${String(raw.version)}.`);
  if (!('creations' in raw) && !('approach' in raw) && !('scan' in raw)) throw new Error('No shared categories in this file.');
  if ('qrProfiles' in raw && !('scan' in raw)) throw new Error('QR profiles must be included with scan settings.');
  // Reuse the strict preset validator, including the combined count and duplicate-ID checks.
  if ('creations' in raw && !Array.isArray(raw.creations)) throw new Error('Invalid creations list.');
  if ('approach' in raw && (!isObj(raw.approach) || !Array.isArray(raw.approach.presets))) throw new Error('Invalid approach settings.');
  const creations = Array.isArray(raw.creations) ? raw.creations : [];
  const approach = isObj(raw.approach) ? raw.approach : undefined;
  const groups = approach ? validateGroups(approach.groups) : undefined;
  const groupPresets = approach && Array.isArray(approach.presets) ? approach.presets : [];
  const validated = parseImport(JSON.stringify({
    app: 'iledcolor-app', version: 1, settings: DEFAULT_SETTINGS, presets: [...creations, ...groupPresets],
  })).presets;
  const contentPresets = validated.slice(0, creations.length);
  const savedGroups = validated.slice(creations.length);
  if (contentPresets.some(isGroupPreset) || savedGroups.some((p) => !isGroupPreset(p))) throw new Error('Preset is in the wrong category.');
  return {
    app: 'iledcolor-app', version: 2,
    ...('creations' in raw ? { creations: contentPresets.filter((p): p is ContentPreset => !isGroupPreset(p)) } : {}),
    ...(groups ? { approach: { groups, presets: savedGroups.filter(isGroupPreset) } } : {}),
    ...('scan' in raw ? { scan: validateScan(raw.scan) } : {}),
    ...('qrProfiles' in raw ? { qrProfiles: validateGreetingProfiles(raw.qrProfiles) } : {}),
  };
}

export function mergeSharedPresets(current: Preset[], data: ImportedBackup): Preset[] {
  if (data.version === 1) return data.presets;
  const retained = current.filter((p) => isGroupPreset(p) ? data.approach === undefined : data.creations === undefined);
  const incoming = [...(data.creations ?? []), ...(data.approach?.presets ?? [])];
  const ids = new Set(retained.map((p) => p.id));
  if (incoming.some((p) => ids.has(p.id))) throw new Error('A shared preset ID conflicts with a preset in an excluded category.');
  return [...retained, ...incoming];
}
