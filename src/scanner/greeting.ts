export interface GreetingSettings {
  pattern: string;
  template: string;
  repetitions: number;
  speed: number;
}

export interface ExtractedName {
  name: string;
  lastname?: string;
  company?: string;
}

export interface GreetingProfile {
  id: string;
  note: string;
  pattern: string;
  template: string;
}

export interface GreetingProfileState {
  selectedId: string | null;
  profiles: GreetingProfile[];
}

export const DEFAULT_GREETING: GreetingSettings = {
  pattern: '',
  template: 'Hi {name}!',
  repetitions: 3,
  speed: 5,
};

const PROFILE_IDS = ['1', '2', '3'];

function validatePattern(pattern: unknown): asserts pattern is string {
  if (typeof pattern !== 'string' || pattern.length > 300) throw new Error('Name regex must be at most 300 characters.');
  if (pattern) new RegExp(pattern, 'u');
}

function validateTemplate(template: unknown): asserts template is string {
  if (typeof template !== 'string' || !template.trim() || template.length > 200 || !/\{(?:name|firstname)\}/.test(template))
    throw new Error('Enter a greeting of at most 200 characters containing {name} or {firstname}.');
}

export function validateGreetingProfiles(value: unknown): GreetingProfileState {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved QR profiles.');
  const state = value as Record<string, unknown>;
  if (!Array.isArray(state.profiles) || state.profiles.length > 3) throw new Error('Save up to three QR profiles.');
  const profiles = state.profiles.map((item): GreetingProfile => {
    if (!item || typeof item !== 'object') throw new Error('Invalid saved QR profile.');
    const profile = item as Record<string, unknown>;
    if (typeof profile.id !== 'string' || !PROFILE_IDS.includes(profile.id) ||
      typeof profile.note !== 'string' || !profile.note.trim() || profile.note.length > 60)
      throw new Error('Each QR profile needs a note of at most 60 characters.');
    validatePattern(profile.pattern);
    validateTemplate(profile.template);
    return { id: profile.id, note: profile.note.trim(), pattern: profile.pattern, template: profile.template };
  });
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    throw new Error('Saved QR profile slots must be unique.');
  if (state.selectedId !== null && (typeof state.selectedId !== 'string' || !profiles.some((profile) => profile.id === state.selectedId)))
    throw new Error('The selected QR profile is not saved.');
  return { selectedId: state.selectedId, profiles };
}

export function validateGreeting(value: unknown): GreetingSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid scanner settings.');
  const v = value as Record<string, unknown>;
  validatePattern(v.pattern);
  validateTemplate(v.template);
  if (typeof v.repetitions !== 'number' || !Number.isSafeInteger(v.repetitions) || v.repetitions < 1 || v.repetitions > 65536)
    throw new Error('Repetitions must be a whole number between 1 and 65536 (GIF format limit).');
  if (typeof v.speed !== 'number' || !Number.isInteger(v.speed) || v.speed < 1 || v.speed > 10)
    throw new Error('Scroll speed must be between 1 and 10.');
  return { pattern: v.pattern, template: v.template, repetitions: v.repetitions, speed: v.speed };
}

function cleanField(value: string | undefined, field: string, required = false): string | undefined {
  const cleaned = value?.trim().replace(/\s+/g, ' ');
  if (!cleaned) {
    if (required) throw new Error('No usable name found. Set a regex with a capture group for the name.');
    return undefined;
  }
  if (cleaned.length > 100 || /[\u0000-\u001f\u007f]/.test(cleaned))
    throw new Error(`The extracted ${field} is invalid or too long.`);
  return cleaned;
}

export function extractName(raw: string, pattern: string): ExtractedName {
  if (!raw.trim() || raw.length > 4096) throw new Error('QR data must contain between 1 and 4096 characters.');
  let fields: ExtractedName = { name: '' };
  if (pattern) {
    const match = new RegExp(pattern, 'u').exec(raw);
    if (!match) throw new Error('The name regex did not match this QR code.');
    fields = {
      name: match[1] ?? match[0],
      ...(match[2] !== undefined ? { lastname: match[2] } : {}),
      ...(match[3] !== undefined ? { company: match[3] } : {}),
      ...(match.groups?.name !== undefined ? { name: match.groups.name } : {}),
      ...(match.groups?.firstname !== undefined ? { name: match.groups.firstname } : {}),
      ...(match.groups?.lastname !== undefined ? { lastname: match.groups.lastname } : {}),
      ...(match.groups?.company !== undefined ? { company: match.groups.company } : {}),
    };
  } else {
    const text = raw.trim();
    if (/^BEGIN:VCARD/im.test(text)) {
      const unfolded = text.replace(/\r?\n[ \t]/g, '');
      let name = /^FN(?:;[^:\r\n]*)?:(.+)$/im.exec(unfolded)?.[1]?.trim();
      if (!name) {
        const parts = /^N(?:;[^:\r\n]*)?:(.+)$/im.exec(unfolded)?.[1]?.trim().split(';');
        if (parts) name = [parts[1], parts[2], parts[0]].filter(Boolean).join(' ');
      }
      name = name?.replace(/\\[nN]/g, ' ').replace(/\\([,;\\])/g, '$1');
      fields = { name: name ?? '' };
    } else if (text.startsWith('{')) {
      const data: unknown = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const record = data as Record<string, unknown>;
        const pick = (...keys: string[]) => keys.map((k) => record[k]).find((v): v is string => typeof v === 'string' && !!v.trim());
        const name = pick('name', 'fullName', 'full_name', 'displayName')
          ?? [pick('firstName', 'first_name', 'givenName'), pick('lastName', 'last_name', 'familyName')].filter(Boolean).join(' ');
        const company = pick('company', 'organization', 'org');
        fields = { name: name ?? '', ...(company ? { company } : {}) };
      }
    } else if (!/[\r\n]/.test(text) && !/^[a-z][a-z\d+.-]*:/i.test(text)) fields = { name: text };
  }
  const lastname = cleanField(fields.lastname, 'last name');
  const company = cleanField(fields.company, 'company');
  return {
    name: cleanField(fields.name, 'name', true)!,
    ...(lastname ? { lastname } : {}),
    ...(company ? { company } : {}),
  };
}

export function greetingText(template: string, extracted: ExtractedName | string): string {
  const fields: ExtractedName = typeof extracted === 'string' ? { name: extracted } : extracted;
  const text = template.replace(/\{(name|firstname|lastname|company)\}/g, (_, field: keyof ExtractedName | 'firstname') =>
    field === 'firstname' ? fields.name : fields[field] ?? '');
  if (text.length > 300) throw new Error('The completed greeting is too long (maximum 300 characters).');
  return text;
}

export function greetingDuration(frameCount: number, delayMs: number, repetitions: number): number {
  const duration = frameCount * delayMs * repetitions;
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('The greeting duration is too large.');
  return duration;
}
