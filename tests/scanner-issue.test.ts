import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ISSUE, formatScanDate, isValidAssignee, issueBody, issueTitle, newIssueUrl, parseRepoUrl, validateIssueSettings,
} from '../src/scanner/issue';

describe('GitHub issue settings', () => {
  it('defaults to the xebia/badge-scanner repository with the GitHubUniverse label', () => {
    expect(DEFAULT_ISSUE).toEqual({ repoUrl: 'https://github.com/xebia/badge-scanner', label: 'GitHubUniverse' });
    expect(validateIssueSettings(DEFAULT_ISSUE)).toEqual(DEFAULT_ISSUE);
  });

  it('normalizes repository URLs and derives the organization', () => {
    for (const url of ['https://github.com/xebia/badge-scanner', ' https://github.com/xebia/badge-scanner/ ', 'https://github.com/xebia/badge-scanner.git']) {
      expect(parseRepoUrl(url)).toEqual({ owner: 'xebia', repo: 'badge-scanner', url: 'https://github.com/xebia/badge-scanner' });
    }
  });

  it.each([
    '', 'github.com/xebia/badge-scanner', 'http://github.com/xebia/badge-scanner', 'https://gitlab.com/xebia/repo',
    'https://github.com/xebia', 'https://github.com/xebia/badge-scanner/issues', 'https://github.com/-bad/repo',
    'https://github.com/xebia/..', 'https://github.com/xebia/repo?x=1', 'https://evil.example/github.com/a/b',
  ])('rejects %j', (url) => {
    expect(() => parseRepoUrl(url)).toThrow(/repository URL/);
  });

  it('validates labels and assignees strictly', () => {
    expect(validateIssueSettings({ ...DEFAULT_ISSUE, label: '  ' })).toEqual({ ...DEFAULT_ISSUE, label: '' });
    for (const label of [undefined, 3, 'x'.repeat(101), 'a\nb']) {
      expect(() => validateIssueSettings({ ...DEFAULT_ISSUE, label })).toThrow(/label/);
    }
    expect(() => validateIssueSettings(null)).toThrow();
    expect(isValidAssignee('')).toBe(true);
    expect(isValidAssignee('@octo-cat')).toBe(true);
    for (const name of ['-bad', 'a b', 'x'.repeat(40), 'a--b']) expect(isValidAssignee(name)).toBe(false);
  });
});

describe('GitHub issue content', () => {
  const scannedAt = new Date(2026, 9, 8, 9, 5);

  it('formats the scan date as dd-MMM-yyyy HH:mm', () => {
    expect(formatScanDate(scannedAt)).toBe('08-Oct-2026 09:05');
    expect(formatScanDate(new Date(2026, 0, 31, 23, 59))).toBe('31-Jan-2026 23:59');
  });

  it('builds the title from first and last name', () => {
    expect(issueTitle('Ada', 'Lovelace')).toBe('Badge scan: Ada Lovelace');
    expect(issueTitle(' Ada ', '')).toBe('Badge scan: Ada');
  });

  it('builds the body with details, empty notes and the scan date', () => {
    const body = issueBody([
      { label: 'First name', value: 'Ada', type: 'firstname' },
      { label: 'Last name', value: 'Lovelace', type: 'lastname' },
      { label: 'GitHub Handle', value: '@ada', type: 'github' },
      { label: 'Role', value: '', type: 'role' },
      { label: 'Company', value: 'A|B *Co* @xebia', type: 'company' },
      { label: 'Email address', value: 'ada@example.org' },
    ], scannedAt);
    expect(body).toBe([
      '## Badge details', '',
      '| Field | Value |', '| --- | --- |',
      '| First name | Ada |',
      '| Last name | Lovelace |',
      '| GitHub Handle | [@ada](https://github.com/ada) |',
      '| Company | A\\|B \\*Co\\* `@xebia` |',
      '| Email address | ada@example.org |',
      '',
      '## Notes', '', '', '',
      '---', '',
      'Scanned via OCR on: 08-Oct-2026 09:05',
    ].join('\n'));
  });

  it('pre-fills title, body, label and optional assignee in the new-issue URL', () => {
    const url = new URL(newIssueUrl(DEFAULT_ISSUE, 'Badge scan: Ada Lovelace', 'body & more', '@booth-staff'));
    expect(url.origin + url.pathname).toBe('https://github.com/xebia/badge-scanner/issues/new');
    expect(url.searchParams.get('title')).toBe('Badge scan: Ada Lovelace');
    expect(url.searchParams.get('body')).toBe('body & more');
    expect(url.searchParams.get('labels')).toBe('GitHubUniverse');
    expect(url.searchParams.get('assignees')).toBe('booth-staff');
    const bare = new URL(newIssueUrl({ ...DEFAULT_ISSUE, label: '' }, 't', 'b'));
    expect(bare.searchParams.has('labels')).toBe(false);
    expect(bare.searchParams.has('assignees')).toBe(false);
  });
});
