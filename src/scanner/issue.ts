export interface IssueSettings {
  repoUrl: string;
  label: string;
}

export const DEFAULT_ISSUE: IssueSettings = {
  repoUrl: 'https://github.com/xebia/badge-scanner',
  label: 'GitHubUniverse',
};

export interface IssueField { label: string; value: string; type?: string }

const OWNER = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const REPO = /^[\w.-]{1,100}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Accepts https://github.com/{owner}/{repo} with an optional trailing slash or .git suffix. */
export function parseRepoUrl(value: string): { owner: string; repo: string; url: string } {
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/i.exec(value.trim());
  const [, owner = '', repo = ''] = match ?? [];
  if (!OWNER.test(owner) || !REPO.test(repo) || /^\.+$/.test(repo))
    throw new Error('Enter a GitHub repository URL like https://github.com/owner/repository.');
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export function isValidAssignee(value: string): boolean {
  return !value || OWNER.test(value.replace(/^@/, ''));
}

export function validateIssueSettings(value: unknown): IssueSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub issue settings.');
  const v = value as Record<string, unknown>;
  if (typeof v.repoUrl !== 'string') throw new Error('Invalid GitHub issue repository.');
  const { url } = parseRepoUrl(v.repoUrl);
  if (typeof v.label !== 'string' || v.label.length > 100 || /[\u0000-\u001f\u007f]/.test(v.label))
    throw new Error('The issue label must be text of at most 100 characters.');
  return { repoUrl: url, label: v.label.trim() };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** dd-MMM-yyyy HH:mm in local time, e.g. 28-Oct-2026 09:05. */
export function formatScanDate(date: Date): string {
  return `${pad(date.getDate())}-${MONTHS[date.getMonth()]}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Escape a value for a Markdown table cell and keep @words from notifying GitHub users. */
function cell(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
    .replace(/[\\`*_[\]<>|~#!]/g, '\\$&')
    .replace(/(^|[^\w@])@([\w-]+)/g, '$1`@$2`');
}

function githubCell(value: string): string {
  const handle = value.trim().replace(/^@+/, '');
  // Link text is not turned into a mention, so the visitor is not notified.
  return OWNER.test(handle) ? `[@${handle}](https://github.com/${handle})` : cell(value);
}

/** The bare LinkedIn handle from "handle", "@handle", "in/handle" or a linkedin.com/in/ profile URL. */
export function parseLinkedinHandle(value: string): string | undefined {
  const handle = value.trim()
    .replace(/^(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\//i, '')
    .replace(/^\/?(?:in|pub)\//i, '')
    .replace(/^@+/, '')
    .replace(/[/?#].*$/, '');
  return /^[\w%-]{3,100}$/.test(handle) ? handle : undefined;
}

function linkedinCell(value: string): string {
  const handle = parseLinkedinHandle(value);
  return handle ? `<https://www.linkedin.com/in/${handle}>` : cell(value);
}

function valueCell(field: IssueField): string {
  if (field.type === 'github') return githubCell(field.value);
  if (field.type === 'linkedin') return linkedinCell(field.value);
  return cell(field.value);
}

export function issueBody(fields: IssueField[], scannedAt: Date): string {
  const rows = fields.filter((f) => f.value.trim())
    .map((f) => `| ${cell(f.label)} | ${valueCell(f)} |`);
  return [
    '## Badge details', '',
    '| Field | Value |', '| --- | --- |', ...rows, '',
    '## Notes', '', '', '',
    '---', '',
    `Scanned via OCR on: ${formatScanDate(scannedAt)}`,
  ].join('\n');
}

export function issueTitle(firstname: string, lastname: string): string {
  return `Badge scan: ${[firstname.trim(), lastname.trim()].filter(Boolean).join(' ')}`.trim();
}

export function newIssueUrl(settings: IssueSettings, title: string, body: string, assignee = ''): string {
  const { url } = parseRepoUrl(settings.repoUrl);
  const params = new URLSearchParams({ title, body });
  if (settings.label) params.set('labels', settings.label);
  const login = assignee.trim().replace(/^@/, '');
  if (login && isValidAssignee(login)) params.set('assignees', login);
  return `${url}/issues/new?${params.toString()}`;
}
