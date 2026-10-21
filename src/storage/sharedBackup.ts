import type { ApproachSettings } from '../approach/tiers';
import { validateGitHubSettings, type GitHubSettings } from '../github/contributions';
import { DEFAULT_TEXT_FONT } from '../render/fonts';
import { validatePreferences as validateSoundPreferences, type SoundPreferences } from '../sound/dictionary';
import { validateGreeting, validateGreetingProfiles, type GreetingProfileState, type ScannerBackup } from '../scanner/greeting';
import {
  DEFAULT_SETTINGS, MAX_IMPORT_BYTES, MAX_PRESETS, isGroupPreset, parseImport, validateContent, validateGroups, validateSequenceSteps, validateSettings,
  type Content, type ContentPreset, type GroupContent, type GroupPreset, type Preset, type SequenceStep, type Settings,
} from './presets';

export interface ShareSelection { creations: boolean; approach: boolean; scan: boolean; settings?: boolean; sound?: boolean }
export type ScanSettings = Pick<ApproachSettings, 'enterDbm' | 'leaveDbm' | 'settleMs' | 'confirmMs' | 'staleMs'>;
type ApproachOptions = Pick<ApproachSettings, 'mode' | 'beacon' | 'countNearbyCaps'>;
export interface BackupFeatures extends ScannerBackup { settings?: Settings; createContent?: Content; createSequence?: SequenceStep[]; sound?: SoundPreferences; github?: GitHubSettings }
export interface SharedBackup extends BackupFeatures {
  app: 'iledcolor-app';
  version: 2;
  creations?: ContentPreset[];
  approach?: { groups: GroupContent; presets: GroupPreset[] } & Partial<ApproachOptions>;
  scan?: ScanSettings;
}
export type ImportedBackup = SharedBackup | { version: 1; settings: Settings; presets: Preset[]; qrProfiles: GreetingProfileState };

export function exportSelectedJson(presets: Preset[], approach: ApproachSettings, selection: ShareSelection, qrProfiles?: GreetingProfileState, features: BackupFeatures = {}): string {
  if (!selection.creations && !selection.approach && !selection.scan && !selection.settings && !selection.sound) throw new Error('Choose at least one category to share.');
  if (selection.settings && !features.settings) throw new Error('Display and transport settings are unavailable.');
  if (selection.sound && !features.sound) throw new Error('Sound settings are unavailable.');
  const file: SharedBackup = {
    app: 'iledcolor-app', version: 2,
    ...(selection.creations ? { creations: presets.filter((p): p is ContentPreset => !isGroupPreset(p)) } : {}),
    ...(selection.creations && features.createContent ? { createContent: validateContent(features.createContent) } : {}),
    ...(selection.creations && features.github ? { github: validateGitHubSettings(features.github) } : {}),
    // A playing sequence already carries its steps in createContent; only a paused draft is stored separately.
    ...(selection.creations && features.createSequence && features.createContent?.kind !== 'sequence'
      ? { createSequence: validateSequenceSteps(features.createSequence) } : {}),
    ...(selection.approach ? { approach: {
      groups: approach.tiers, presets: presets.filter(isGroupPreset),
      mode: approach.mode, beacon: approach.beacon, countNearbyCaps: approach.countNearbyCaps,
    } } : {}),
    ...(selection.scan ? { scan: {
      enterDbm: approach.enterDbm, leaveDbm: approach.leaveDbm, settleMs: approach.settleMs,
      confirmMs: approach.confirmMs, staleMs: approach.staleMs,
    } } : {}),
    ...(selection.scan && qrProfiles ? { qrProfiles: validateGreetingProfiles(qrProfiles) } : {}),
    ...(selection.scan && features.qrGreeting ? { qrGreeting: validateGreeting(features.qrGreeting) } : {}),
    ...(selection.scan && features.qrScanLogging !== undefined ? { qrScanLogging: validateLogging(features.qrScanLogging) } : {}),
    ...(selection.settings && features.settings ? {
      settings: validateSettings({ ...features.settings, textFont: features.settings.textFont ?? DEFAULT_TEXT_FONT }),
    } : {}),
    // Browser speech consent is a per-device privacy decision and is never shared.
    ...(selection.sound && features.sound ? { sound: { ...validateSoundPreferences(features.sound), allowBrowserSpeech: false } } : {}),
  };
  if ((file.creations?.length ?? 0) + (file.approach?.presets.length ?? 0) > MAX_PRESETS) {
    throw new Error(`Share at most ${MAX_PRESETS} presets at a time. Choose fewer categories.`);
  }
  const text = JSON.stringify(file, null, 2);
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('Selected data exceeds the 4 MB import limit. Share fewer categories.');
  return text;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validateLogging(raw: unknown): boolean {
  if (typeof raw !== 'boolean') throw new Error('Invalid scan logging preference.');
  return raw;
}

function validateCreateSequence(raw: unknown): SequenceStep[] {
  try { return validateSequenceSteps(raw); } catch (e) { throw new Error(`Invalid Connect sequence: ${(e as Error).message}.`); }
}

function validateApproachOptions(raw: Record<string, unknown>): Partial<ApproachOptions> {
  if ('mode' in raw && raw.mode !== 'p2p' && raw.mode !== 'hub') throw new Error('Invalid approach mode.');
  for (const key of ['beacon', 'countNearbyCaps'] as const) {
    if (key in raw && typeof raw[key] !== 'boolean') throw new Error(`Invalid approach setting: ${key}.`);
  }
  if (raw.mode === 'p2p' && raw.beacon === false) throw new Error('Phone-to-phone approach mode requires the beacon.');
  return {
    ...(raw.mode === 'p2p' || raw.mode === 'hub' ? { mode: raw.mode } : {}),
    ...(typeof raw.beacon === 'boolean' ? { beacon: raw.beacon } : {}),
    ...(typeof raw.countNearbyCaps === 'boolean' ? { countNearbyCaps: raw.countNearbyCaps } : {}),
  };
}

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
  if (!('creations' in raw) && !('approach' in raw) && !('scan' in raw) && !('settings' in raw) && !('sound' in raw)) throw new Error('No shared categories in this file.');
  if (['qrProfiles', 'qrGreeting', 'qrScanLogging'].some((key) => key in raw) && !('scan' in raw))
    throw new Error('QR profiles and greeting preferences must be included with scan settings.');
  if ('createContent' in raw && !('creations' in raw)) throw new Error('Connect content must be included with creations.');
  if ('github' in raw && !('creations' in raw)) throw new Error('GitHub settings must be included with creations.');
  if ('createSequence' in raw && !('creations' in raw)) throw new Error('The Connect sequence must be included with creations.');
  if ('createSequence' in raw && isObj(raw.createContent) && raw.createContent.kind === 'sequence')
    throw new Error('The Connect sequence is stored twice.');
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
    ...(groups && approach ? { approach: { groups, presets: savedGroups.filter(isGroupPreset), ...validateApproachOptions(approach) } } : {}),
    ...('scan' in raw ? { scan: validateScan(raw.scan) } : {}),
    ...('qrProfiles' in raw ? { qrProfiles: validateGreetingProfiles(raw.qrProfiles) } : {}),
    ...('qrGreeting' in raw ? { qrGreeting: validateGreeting(raw.qrGreeting) } : {}),
    ...('qrScanLogging' in raw ? { qrScanLogging: validateLogging(raw.qrScanLogging) } : {}),
    ...('createContent' in raw ? { createContent: validateContent(raw.createContent) } : {}),
    ...('github' in raw ? { github: validateGitHubSettings(raw.github) } : {}),
    ...('createSequence' in raw ? { createSequence: validateCreateSequence(raw.createSequence) } : {}),
    ...('settings' in raw ? { settings: validateSettings(raw.settings) } : {}),
    ...('sound' in raw ? { sound: validateSoundPreferences(raw.sound) } : {}),
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
