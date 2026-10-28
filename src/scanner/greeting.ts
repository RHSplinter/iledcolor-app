import { findGithubHandle, findLinkedinHandle } from './githubLookup';
import type { IssueSettings } from './issue';

export interface GreetingSettings {
  template: string;
  repetitions: number;
  speed: number;
}

export interface ExtractedName {
  name: string;
  lastname?: string;
  company?: string;
  title?: string;
  email?: string;
  phone?: string;
  url?: string;
  github?: string;
  linkedin?: string;
  notes?: string;
}

export interface ScannerBackup {
  qrGreeting?: GreetingSettings;
  qrScanLogging?: boolean;
  /** Target repository and label for the scan-tab Save button. */
  qrIssue?: IssueSettings;
  /** Legacy backup field; public email lookup is now always enabled. */
  qrGithubLookup?: boolean;
}

export const DEFAULT_GREETING: GreetingSettings = {
  template: 'Hi {name}!',
  repetitions: 3,
  speed: 3,
};

function validateTemplate(template: unknown): asserts template is string {
  if (typeof template !== 'string' || !template.trim() || template.length > 200 || !/\{(?:name|firstname)\}/.test(template))
    throw new Error('Enter a greeting of at most 200 characters containing {name} or {firstname}.');
}

export function validateGreeting(value: unknown): GreetingSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid scanner settings.');
  const v = value as Record<string, unknown>;
  validateTemplate(v.template);
  if (typeof v.repetitions !== 'number' || !Number.isSafeInteger(v.repetitions) || v.repetitions < 1 || v.repetitions > 65536)
    throw new Error('Repetitions must be a whole number between 1 and 65536 (GIF format limit).');
  if (typeof v.speed !== 'number' || !Number.isInteger(v.speed) || v.speed < 1 || v.speed > 10)
    throw new Error('Scroll speed must be between 1 and 10.');
  return { template: v.template, repetitions: v.repetitions, speed: v.speed };
}

/** Empty is allowed (the field is optional); otherwise requires local@domain.tld without spaces. */
export function isValidEmail(value: string): boolean {
  const email = value.trim();
  return !email || (email.length <= 254 && /^[^\s@<>,;]+@[^\s@<>,;.]+(?:\.[^\s@<>,;.]+)*\.[a-z]{2,}$/i.test(email));
}

function cleanField(value: string | undefined, field: string, required = false): string | undefined {
  const cleaned = value?.replace(/\\[nN]/g, ' ').replace(/\\([,;:\\\\])/g, '$1').trim().replace(/\s+/g, ' ');
  if (!cleaned) {
    if (required) throw new Error('No usable name found in the scanned data.');
    return undefined;
  }
  if ((required && cleaned.length > 100) || /[\u0000-\u001f\u007f]/.test(cleaned))
    throw new Error(`The extracted ${field} is invalid or too long.`);
  return cleaned;
}

function splitEscaped(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let part = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      part += character;
      escaped = false;
    } else if (character === '\\') {
      part += character;
      escaped = true;
    } else if (character === delimiter) {
      parts.push(part);
      part = '';
    } else part += character;
  }
  parts.push(part);
  return parts;
}

function payloadFields(text: string): Partial<ExtractedName> {
  if (/^BEGIN:VCARD/im.test(text)) {
    const unfolded = text.replace(/\r?\n[ \t]/g, '');
    const fields: Partial<ExtractedName> = {};
    let structuredName: string | undefined;
    for (const line of unfolded.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).split(';')[0]!.replace(/^item\d+\./i, '').toUpperCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'FN') fields.name ??= value;
      else if (key === 'N') structuredName = value;
      else if (key === 'ORG') fields.company ??= value.split(';')[0];
      else if (key === 'TITLE') fields.title ??= value;
      else if (key === 'EMAIL') fields.email ??= value;
      else if (key === 'TEL') fields.phone ??= value;
      else if (key === 'URL') fields.url ??= value;
      else if (key === 'NOTE') fields.notes ??= value;
    }
    if (!fields.name && structuredName) {
      const [last, first, middle] = structuredName.split(';');
      fields.name = [first, middle, last].filter(Boolean).join(' ');
    }
    return fields;
  }

  if (/^MECARD:/i.test(text)) {
    const fields: Partial<ExtractedName> = {};
    for (const part of splitEscaped(text.replace(/^MECARD:/i, ''), ';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const key = part.slice(0, colon).toUpperCase();
      const value = part.slice(colon + 1).trim();
      if (key === 'N') fields.name = splitEscaped(value, ',').reverse().join(' ');
      else if (key === 'ORG') fields.company = value;
      else if (key === 'EMAIL') fields.email = value;
      else if (key === 'TEL') fields.phone = value;
      else if (key === 'URL') fields.url = value;
      else if (key === 'NOTE') fields.notes = value;
    }
    return fields;
  }

  if (text.startsWith('{')) {
    const data: unknown = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      const pick = (...keys: string[]) => keys.map((key) => record[key]).find((value): value is string => typeof value === 'string' && !!value.trim());
      return {
        name: pick('name', 'fullName', 'full_name', 'displayName')
          ?? [pick('firstName', 'first_name', 'givenName'), pick('lastName', 'last_name', 'familyName')].filter(Boolean).join(' '),
        company: pick('company', 'organization', 'org', 'employer'),
        title: pick('title', 'jobTitle', 'job_title', 'role'),
        email: pick('email', 'mail'),
        phone: pick('phone', 'tel', 'mobile'),
        url: pick('url', 'website', 'linkedin'),
        notes: pick('notes', 'note'),
      };
    }
    return {};
  }

  if (/^mailto:/i.test(text)) return { email: text.slice(7).split('?')[0] };
  if (/^tel:/i.test(text)) return { phone: text.slice(4) };
  if (/^https?:\/\//i.test(text)) return { url: text };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { email: text };
  if (!/[\r\n]/.test(text) && !/^[a-z][a-z\d+.-]*:/i.test(text)) return { name: text };
  return parseFreeText(text);
}

const TITLE_WORDS = /\b(consultant|engineer|manager|director|developer|trainer|lead|architect|founder|ceo|cto|specialist|designer|analyst|owner|partner)\b/i;
const NAME_FRAGMENT = /^\p{Lu}[\p{L}'-]{1,24}$/u;
const BADGE_TIER = /^(expert|speaker|mvp|attendee|sponsor|organizer|organiser|volunteer|staff|vip|exhibitor|press|media|guest|keynote)$/i;
const BADGE_NOISE = /[\\=~^`©®™•§¤¶_]/;

function parseFreeText(text: string): Partial<ExtractedName> {
  const fields: Partial<ExtractedName> = {};
  const email = text.match(/[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}/i)?.[0];
  const url = text.match(/\b(?:https?:\/\/|www\.)[^\s<>,;]+/i)?.[0];
  const phoneCandidate = text.match(/\+?\(?\d[\d\s().-]{6,}\d/)?.[0]?.trim();
  const phone = phoneCandidate && phoneCandidate.replace(/\D/g, '').length >= 8 ? phoneCandidate : undefined;
  if (email) fields.email = email;
  if (url) fields.url = url;
  if (phone) fields.phone = phone;
  const github = findGithubHandle(text);
  const linkedin = findLinkedinHandle(text);
  if (github) fields.github = github;
  if (linkedin) fields.linkedin = linkedin;
  const badgeRows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const handleIndex = badgeRows.findIndex((line) => !!findGithubHandle(line));
  const nameRows = badgeRows.slice(0, handleIndex);
  const role = badgeRows[handleIndex + 1];
  const company = badgeRows[handleIndex + 2];
  if ((handleIndex === 1 || handleIndex === 2) && role && company &&
      nameRows.every((name) => /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(name))) {
    return {
      ...fields, name: nameRows.join(' '),
      ...(handleIndex === 2 ? { lastname: nameRows[1] } : {}),
      title: role, company,
    };
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => !/^(?:@|git\s?hub\b|linked\s?in\b|\/?in\/)/i.test(line) &&
      ![email, url, phone].some((contact) => contact && line.includes(contact)))
    .map((line) => line.split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')).filter(Boolean).join(' '))
    .filter((line) => line && line.length <= 40 && line.split(/\s+/).length <= 6 &&
      /\p{L}/u.test(line) && !/\d/.test(line) && !BADGE_NOISE.test(line) &&
      line.replace(/\s/g, '').length > 0);
  const usableLines = lines.filter((line) => {
    const letters = line.match(/\p{L}/gu)?.length ?? 0;
    const compact = line.replace(/\s/g, '');
    return compact.length > 0 && letters / compact.length >= 0.7 &&
      line.split(/\s+/).some((word) => word.length >= 3 && /[aeiou]/i.test(word));
  });
  const used = new Set<number>();
  const titleIndex = usableLines.findIndex((line) => TITLE_WORDS.test(line) || (line.includes('|') && line.split(/\s+/).length > 2));

  if (titleIndex >= 0) {
    fields.title = usableLines[titleIndex];
    used.add(titleIndex);
    const fragments: string[] = [];
    let cursor = titleIndex - 1;
    while (cursor >= 0 && fragments.length < 2 && NAME_FRAGMENT.test(usableLines[cursor]!)) {
      fragments.unshift(usableLines[cursor]!);
      cursor--;
    }
    if (fragments.length === 2) {
      fields.name = fragments.join(' ');
      used.add(titleIndex - 2);
      used.add(titleIndex - 1);
    } else if (titleIndex > 0) {
      fields.name = usableLines[titleIndex - 1];
      used.add(titleIndex - 1);
    }
    if (titleIndex + 1 < usableLines.length) {
      fields.company = usableLines[titleIndex + 1];
      used.add(titleIndex + 1);
    }
  } else {
    const candidate = usableLines.findIndex((_, index) => !used.has(index));
    if (candidate >= 0) {
      let nameEnd = candidate;
      if (NAME_FRAGMENT.test(usableLines[candidate]!) && NAME_FRAGMENT.test(usableLines[candidate + 1] ?? '')) {
        fields.name = `${usableLines[candidate]} ${usableLines[candidate + 1]}`;
        used.add(candidate + 1);
        nameEnd++;
      } else fields.name = usableLines[candidate];
      used.add(candidate);
      const companyIndex = usableLines.findIndex((_, index) => !used.has(index) && index > nameEnd);
      if (companyIndex >= 0) {
        fields.company = usableLines[companyIndex];
        used.add(companyIndex);
      }
    }
  }

  const notes = usableLines.flatMap((line, index) => {
    if (used.has(index)) return [];
    if (BADGE_TIER.test(line)) return [`Badge tier: ${line}`];
    if (/^[a-z][a-z0-9_-]{2,20}$/i.test(line)) return [`Handle: ${line}`];
    return [];
  });
  if (notes.length) fields.notes = notes.join('\n');
  return fields;
}

export function extractName(raw: string): ExtractedName {
  if (!raw.trim() || raw.length > 4096) throw new Error('Scan data must contain between 1 and 4096 characters.');
  const fields = payloadFields(raw.trim());

  const name = cleanField(fields.name, 'name', true)!;
  const lastname = cleanField(fields.lastname, 'last name');
  const company = cleanField(fields.company, 'company');
  const title = cleanField(fields.title, 'title');
  const email = cleanField(fields.email, 'email');
  const phone = cleanField(fields.phone, 'phone');
  const url = cleanField(fields.url, 'URL');
  const github = cleanField(fields.github, 'GitHub handle');
  const linkedin = cleanField(fields.linkedin, 'LinkedIn handle');
  const notes = cleanField(fields.notes, 'notes');
  return {
    name,
    ...(lastname ? { lastname } : {}),
    ...(company ? { company } : {}),
    ...(title ? { title } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(url ? { url } : {}),
    ...(github ? { github } : {}),
    ...(linkedin ? { linkedin } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function greetingNameFields(extracted: ExtractedName): { firstname: string; lastname: string } {
  const [first = '', ...last] = extracted.name.split(/\s+/);
  return {
    firstname: extracted.lastname && extracted.name.endsWith(` ${extracted.lastname}`)
      ? extracted.name.slice(0, -extracted.lastname.length - 1) : first,
    lastname: extracted.lastname ?? last.join(' '),
  };
}

export function greetingText(template: string, extracted: ExtractedName | string): string {
  const captured: ExtractedName = typeof extracted === 'string' ? { name: extracted } : extracted;
  const fields = {
    ...captured, ...greetingNameFields(captured),
    role: captured.title, githubhandle: captured.github,
  };
  const text = template.replace(/\{(name|firstname|lastname|role|company|githubhandle|title|email|phone|url|github|linkedin|notes)\}/g,
    (_, field: keyof typeof fields) => fields[field] ?? '');
  if (text.length > 300) throw new Error('The completed greeting is too long (maximum 300 characters).');
  return text;
}

export function greetingDuration(frameCount: number, delayMs: number, repetitions: number): number {
  const duration = frameCount * delayMs * repetitions;
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('The greeting duration is too large.');
  return duration;
}
