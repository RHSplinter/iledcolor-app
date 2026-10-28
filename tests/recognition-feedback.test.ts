// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { SoundUi } from '../src/sound/ui';
import { GreetingUi } from '../src/scanner/ui';
import { connectAsPrimary, initApproach, keepBlackChanged, renderApproach } from '../src/approach/ui';
import { vibrateFeedback } from '../src/feedback';
import { verifyUtterance } from '../src/sound/analysis';
import { defaultPreferences } from '../src/sound/dictionary';
import type { DeviceController } from '../src/controller/deviceController';
import { solid } from '../src/render/matrix';
import { ensureFont } from '../src/render/text';
import { SPIKE_PROFILE } from '../src/transport/types';
import { loadKv, saveKv } from '../src/storage/db';
import { fetchPublicProfile } from '../src/scanner/githubLookup';

vi.mock('../src/scanner/githubLookup', async (original) => ({
  ...await original<typeof import('../src/scanner/githubLookup')>(),
  fetchPublicProfile: vi.fn(),
}));
vi.mock('../src/feedback', () => ({ vibrateFeedback: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/storage/db', () => ({
  loadKv: vi.fn().mockResolvedValue(undefined),
  saveKv: vi.fn().mockResolvedValue(undefined),
  savePreset: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/sound/capture', () => ({ SoundCapture: class { capabilities = async () => ({ speech: true, proximity: false }); } }));
vi.mock('../src/sound/analysis', async (original) => ({
  ...await original<typeof import('../src/sound/analysis')>(), verifyUtterance: vi.fn(),
}));
vi.mock('../src/render/matrix', async (original) => ({
  ...await original<typeof import('../src/render/matrix')>(),
  drawPreview: vi.fn(),
}));
vi.mock('../src/render/text', () => ({
  ensureFont: vi.fn().mockResolvedValue(undefined),
  getTextFont: () => 'silkscreen',
  renderMarquee: () => ({ frames: [solid(8, 8, [0, 0, 0])], unsupported: [] }),
  renderSpanMarquee: () => ({ frames: [solid(8, 8, [0, 0, 0])], unsupported: [], step: 2 }),
}));

const playback = vi.fn();
const target = {
  state: 'Ready', canRestoreContent: true, temporaryActive: false, playTemporary: playback,
} as unknown as DeviceController;
const context = {
  controller: () => target, logicalDims: (): [number, number] => [8, 8],
  physical: (image: ReturnType<typeof solid>) => image, marqueeDelay: () => 60,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchPublicProfile).mockReset().mockResolvedValue(null);
  Object.assign(target, { state: 'Ready', canRestoreContent: true, temporaryActive: false });
  document.body.innerHTML = `
    <header>
      <div id="status-approach" class="pill muted" role="status" aria-live="polite">Approach: off</div>
      <div id="status-listening" class="pill muted" role="status" aria-live="polite">Listening: off</div>
    </header>
    <section id="view-approach"></section>
    <section id="view-sound"></section>
    <section id="view-scan"></section>
    <section id="view-settings"><div id="settings-scan"></div></section>`;
  playback.mockResolvedValue('completed');
  vi.mocked(verifyUtterance).mockReturnValue(true);
});

async function listening() {
  const ui = new SoundUi(context);
  await ui.init();
  ui['mode'] = 'listening';
  ui['profile'] = {} as NonNullable<typeof ui['profile']>;
  ui['preferences'].phrases = true;
  return ui;
}
const phrase = (text = 'Well, nice to meet you, everyone!') => ({ text, from: Date.now() - 1000, to: Date.now() });

it('vibrates once for a verified embedded phrase, suppressing duplicate detections during playback/cooldown', async () => {
  const ui = await listening();
  ui['phrase'](phrase());
  ui['phrase'](phrase());
  await vi.waitFor(() => expect(playback).toHaveBeenCalledOnce());
  expect(vibrateFeedback).toHaveBeenCalledOnce();
  ui['phrase'](phrase('hello'));
  expect(vibrateFeedback).toHaveBeenCalledOnce();
});

it('does not vibrate for unmatched, disabled, unverified, pocket-paused or stale phrases', async () => {
  const ui = await listening();
  ui['phrase'](phrase('shelloworld'));
  ui['preferences'].reactions.greeting.enabled = false;
  ui['phrase'](phrase('hello'));
  ui['preferences'].reactions.greeting.enabled = true;
  vi.mocked(verifyUtterance).mockReturnValue(false);
  ui['phrase'](phrase('hello'));
  vi.mocked(verifyUtterance).mockReturnValue(true);
  ui['near'] = true;
  ui['phrase'](phrase('hello'));
  ui['near'] = false;
  ui['blockedUntil'] = Date.now() + 1;
  ui['phrase'](phrase('hello'));
  expect(vibrateFeedback).not.toHaveBeenCalled();
  expect(playback).not.toHaveBeenCalled();
});

it('does not vibrate for manual tests, room sounds or a busy cap', async () => {
  const ui = await listening();
  await ui['react']('greeting', true);
  ui['lastReaction'] = -Infinity;
  await ui['react']('applause');
  ui['lastReaction'] = -Infinity;
  ui['rendering'] = true;
  ui['phrase'](phrase('hello'));
  expect(vibrateFeedback).not.toHaveBeenCalled();
});

for (const manual of [false, true]) {
  it.each([
    ['upload starts', { state: 'Uploading' }],
    ['cap disconnects', { state: 'Disconnected' }],
    ['temporary playback starts', { temporaryActive: true }],
    ['restorable content disappears', { canRestoreContent: false }],
  ])(`rejects ${manual ? 'manual' : 'detected'} reactions when %s during frame rendering`, async (_reason, change) => {
    const ui = await listening();
    let finish!: () => void;
    vi.mocked(ensureFont).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const reaction = ui['react']('greeting', manual);
    expect(ensureFont).toHaveBeenCalledOnce();
    expect(playback).not.toHaveBeenCalled();
    expect(vibrateFeedback).not.toHaveBeenCalled();
    Object.assign(target, change);
    finish();
    await reaction;
    expect(playback).not.toHaveBeenCalled();
    expect(vibrateFeedback).not.toHaveBeenCalled();
    expect(ui['playing']).toBeUndefined();
    expect(ui['rendering']).toBe(false);
  });
}

it('plays and vibrates once after deferred frame rendering when the cap remains ready', async () => {
  const ui = await listening();
  let finish!: () => void;
  vi.mocked(ensureFont).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const reaction = ui['react']('greeting');
  expect(playback).not.toHaveBeenCalled();
  expect(vibrateFeedback).not.toHaveBeenCalled();
  finish();
  await reaction;
  expect(playback).toHaveBeenCalledOnce();
  expect(vibrateFeedback).toHaveBeenCalledOnce();
});

it.each(['ocr', 'manual'] as const)('shows editable visitor data for a recognized %s scan without changing playback or persisting edits', async (source) => {
  const ui = new GreetingUi(context);
  await ui.init();
  const form = document.getElementById('qr-data') as HTMLFormElement;
  expect(form.hidden).toBe(true);
  expect(form.querySelector('thead')).toBeNull();
  expect(document.getElementById('qr-save-help')).toBeNull();
  expect(form.querySelector('hr')).not.toBeNull();
  expect(document.querySelectorAll('#qr-data-rows tr')).toHaveLength(0);
  await ui['greet']('Rob Bos\nSoftware Engineer\nXebia\n@octocat', target, source);
  expect(form.hidden).toBe(false);
  const inputs = [...form.querySelectorAll('input')];
  const selects = [...form.querySelectorAll('select')];
  expect(inputs.map((input) => input.value)).toEqual(['Rob', 'Bos', '@octocat', 'Software Engineer', 'Xebia', '', '']);
  expect(inputs[5]!.type).toBe('email');
  expect(inputs[5]!.getAttribute('aria-label')).toBe('Email address');
  expect(inputs[5]!.closest('tr')!.querySelector('select')).toBeNull();
  expect(inputs[6]!.type).toBe('tel');
  expect(inputs[6]!.getAttribute('aria-label')).toBe('Phone number');
  expect(document.querySelector('label[for=qr-data-phone]')!.textContent).toBe('Phone number');
  expect(inputs[6]!.closest('tr')!.querySelector('select')).toBeNull();
  expect(selects.map((select) => select.value)).toEqual(['firstname', 'lastname', 'github', 'role', 'company']);
  for (const select of selects) {
    expect([...select.options].map((option) => option.text)).toEqual([
      'First name', 'Last name', 'GitHub Handle', 'Role', 'Company',
    ]);
  }
  inputs[0]!.value = 'Ada';
  inputs[0]!.dispatchEvent(new Event('input'));
  selects[1]!.value = 'company';
  selects[1]!.dispatchEvent(new Event('change'));
  inputs[2]!.value = 'updated';
  inputs[2]!.dispatchEvent(new Event('input'));
  expect(inputs[2]!.value).toBe('@updated');
  inputs[2]!.value = '';
  inputs[2]!.dispatchEvent(new Event('input'));
  expect(inputs[2]!.value).toBe('');
  selects[4]!.value = 'github';
  selects[4]!.dispatchEvent(new Event('change'));
  expect(inputs[4]!.value).toBe('@Xebia');
  const submit = new Event('submit', { cancelable: true });
  const open = vi.spyOn(window, 'open').mockReturnValue({ opener: null } as unknown as Window);
  form.dispatchEvent(submit);
  expect(submit.defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledOnce();
  expect(String(open.mock.calls[0]![0])).toContain('/issues/new?');
  open.mockRestore();
  expect(inputs[0]!.value).toBe('Ada');
  expect(selects[1]!.value).toBe('company');
  expect(playback).toHaveBeenCalledOnce();
  expect(saveKv).toHaveBeenCalledExactlyOnceWith('qrGreeting', {
    template: 'Hi {name}!', repetitions: 3, speed: 3,
  });
  const status = document.getElementById('qr-status')!;
  expect(status.textContent).not.toBe('Ready to scan a badge.');
  document.getElementById('qr-data-clear')!.click();
  expect(form.hidden).toBe(true);
  expect(form.querySelectorAll('input, select')).toHaveLength(0);
  expect(status.textContent).toBe('Ready to scan a badge.');
  expect(status.classList.contains('bad')).toBe(false);
  expect(saveKv).toHaveBeenCalledOnce();
  expect(playback).toHaveBeenCalledOnce();
});

it.each(['ocr', 'manual'] as const)('preserves multiword first and last names in ordered %s badge fields', async (source) => {
  const ui = new GreetingUi(context);
  await ui.init();
  await ui['greet']('Anne Marie\nvan der Meer\n@badge-user\nSRE\nACME R&D 24/7', target, source);
  expect([...document.querySelectorAll<HTMLInputElement>('#qr-data input')].map((input) => input.value))
    .toEqual(['Anne Marie', 'van der Meer', '@badge-user', 'SRE', 'ACME R&D 24/7', '', '']);
  expect(playback).toHaveBeenCalledOnce();
});

it('replaces previous visitor data, leaves optional fields empty and removes stale fields on invalid scans', async () => {
  const ui = new GreetingUi(context);
  await ui.init();
  await ui['greet']('{"name":"Rob van der Bos","company":"<img src=x onerror=alert(1)>"}', target, 'manual');
  expect((document.querySelectorAll('#qr-data input')[1] as HTMLInputElement).value).toBe('van der Bos');
  expect((document.querySelectorAll('#qr-data input')[4] as HTMLInputElement).value).toBe('<img src=x onerror=alert(1)>');
  expect(document.querySelector('#qr-data img')).toBeNull();
  await ui['greet']('Ada', target, 'manual');
  expect([...document.querySelectorAll<HTMLInputElement>('#qr-data input')].map((input) => input.value))
    .toEqual(['Ada', '', '', '', '', '', '']);
  expect(document.querySelectorAll('#qr-data-rows tr')).toHaveLength(7);
  await ui['greet']('{"email":"private@example.org"}', target, 'manual');
  expect(document.getElementById('qr-data')!.hidden).toBe(true);
  expect(document.querySelectorAll('#qr-data-rows tr')).toHaveLength(0);
  expect(document.getElementById('qr-status')!.textContent).toContain('No usable name');
});

it('always looks up public email, ignoring stored and imported legacy opt-outs', async () => {
  vi.mocked(loadKv).mockImplementation(async (key) => key === 'qrGithubLookup' ? false : undefined);
  vi.mocked(fetchPublicProfile).mockResolvedValue({ login: 'octocat', email: 'public@example.org' });
  const ui = new GreetingUi(context);
  await ui.init();
  ui.applyImportedSettings({ qrGithubLookup: false });
  expect(document.getElementById('qr-github-enabled')).toBeNull();
  expect(ui.exportSettings()).not.toHaveProperty('qrGithubLookup');
  await ui['greet']('Rob Bos\n@octocat', target, 'ocr');
  await vi.waitFor(() => expect((document.getElementById('qr-data-email') as HTMLInputElement).value).toBe('public@example.org'));
  expect(fetchPublicProfile).toHaveBeenCalledWith('octocat', expect.any(AbortSignal));
  vi.mocked(loadKv).mockResolvedValue(undefined);
});

it.each([null, { login: 'octocat', email: null }, new Error('Offline')])('keeps email empty and editable when lookup returns %j', async (profile) => {
  if (profile instanceof Error) vi.mocked(fetchPublicProfile).mockRejectedValue(profile);
  else vi.mocked(fetchPublicProfile).mockResolvedValue(profile);
  const ui = new GreetingUi(context);
  await ui.init();
  await ui['greet']('Rob Bos\n@octocat', target, 'ocr');
  await vi.waitFor(() => expect(document.getElementById('qr-github-result')!.textContent).not.toContain('Checking'));
  const email = document.getElementById('qr-data-email') as HTMLInputElement;
  expect(email.value).toBe('');
  expect(email.disabled).toBe(false);
  email.value = 'manual@example.org';
  email.dispatchEvent(new Event('input'));
  expect(email.value).toBe('manual@example.org');
  const result = document.getElementById('qr-github-result')!;
  expect(result.hidden).toBe(false);
  expect(result.classList.contains('scan-status')).toBe(true);
  if (profile && !(profile instanceof Error)) expect(result.textContent).toBe('@octocat has no public email.');
  document.getElementById('qr-data-clear')!.click();
  expect(result.hidden).toBe(true);
  expect(result.textContent).toBe('');
});

it.each(['edit', 'clear', 'rescan'] as const)('does not overwrite visitor data after %s while a lookup is pending', async (action) => {
  let finish!: (value: { login: string; email: string }) => void;
  vi.mocked(fetchPublicProfile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const ui = new GreetingUi(context);
  await ui.init();
  await ui['greet']('Rob Bos\n@octocat', target, 'ocr');
  const email = document.getElementById('qr-data-email') as HTMLInputElement;
  if (action === 'edit') {
    email.value = 'manual@example.org';
    email.dispatchEvent(new Event('input'));
  } else if (action === 'clear') document.getElementById('qr-data-clear')!.click();
  else await ui['greet']('Ada', target, 'ocr');
  finish({ login: 'octocat', email: 'public@example.org' });
  await vi.waitFor(() => {
    if (action === 'edit') expect(document.getElementById('qr-github-result')!.textContent).toContain('public@example.org');
    else expect(document.getElementById('qr-github-result')!.textContent).toBe('');
  });
  expect(email.value).toBe(action === 'edit' ? 'manual@example.org' : '');
  if (action === 'rescan') expect((document.getElementById('qr-data-email') as HTMLInputElement).value).toBe('');
  if (action === 'clear') {
    expect(document.getElementById('qr-data')!.hidden).toBe(true);
    expect(document.getElementById('qr-github-result')!.hidden).toBe(true);
  }
});

it('shows a scanned phone number without looking it up', async () => {
  const ui = new GreetingUi(context);
  await ui.init();
  await ui['greet']('{"name":"Ada Lovelace","phone":"+31 6 1234 5678"}', target, 'manual');
  const phone = document.getElementById('qr-data-phone') as HTMLInputElement;
  expect(phone.value).toBe('+31 6 1234 5678');
  expect(phone.disabled).toBe(false);
  expect(fetchPublicProfile).not.toHaveBeenCalled();
  phone.value = '+1 555 0100';
  phone.dispatchEvent(new Event('input'));
  phone.dispatchEvent(new Event('blur'));
  expect(phone.hasAttribute('aria-invalid')).toBe(false);
  expect((document.getElementById('qr-data-save') as HTMLButtonElement).disabled).toBe(false);
});

it('flags an invalid email on blur and disables saving until it is corrected', async () => {
  const ui = new GreetingUi(context);
  await ui.init();
  await ui['greet']('Ada', target, 'manual');
  const email = document.getElementById('qr-data-email') as HTMLInputElement;
  const save = document.getElementById('qr-data-save') as HTMLButtonElement;
  email.value = 'not-an-email';
  email.dispatchEvent(new Event('input'));
  expect(email.hasAttribute('aria-invalid')).toBe(false);
  expect(save.disabled).toBe(false);
  email.dispatchEvent(new Event('blur'));
  expect(email.getAttribute('aria-invalid')).toBe('true');
  expect(save.disabled).toBe(true);
  email.value = 'ada@example';
  email.dispatchEvent(new Event('input'));
  expect(save.disabled).toBe(true);
  email.value = 'ada@example.org';
  email.dispatchEvent(new Event('input'));
  expect(email.hasAttribute('aria-invalid')).toBe(false);
  expect(save.disabled).toBe(false);
  email.value = 'bad@';
  email.dispatchEvent(new Event('blur'));
  expect(save.disabled).toBe(true);
  email.value = '';
  email.dispatchEvent(new Event('blur'));
  expect(email.hasAttribute('aria-invalid')).toBe(false);
  expect(save.disabled).toBe(false);
  email.value = 'bad@';
  email.dispatchEvent(new Event('blur'));
  await ui['greet']('Grace', target, 'manual');
  expect(save.disabled).toBe(false);
  expect((document.getElementById('qr-data-email') as HTMLInputElement).hasAttribute('aria-invalid')).toBe(false);
});

it('Save opens a pre-filled GitHub issue for the reviewed data and explains the sign-in requirement', async () => {
  vi.mocked(loadKv).mockImplementation(async (key) => key === 'qrIssueAssignee' ? 'booth-staff' : undefined);
  const tab = { opener: {} };
  const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  try {
    const ui = new GreetingUi(context);
    await ui.init();
    expect(document.getElementById('qr-issue-note-text')!.textContent)
      .toContain('signed in to GitHub with access to the xebia organization');
    const scanId = new Date(2026, 9, 28, 14, 7).toISOString();
    await ui['greet']('{"name":"Ada Lovelace","company":"Analytical | Engines"}', target, 'ocr', scanId);
    const role = document.querySelectorAll<HTMLInputElement>('#qr-data input')[3]!;
    role.value = 'Countess';
    (document.getElementById('qr-data-email') as HTMLInputElement).value = 'ada@example.org';
    document.getElementById('qr-data-save')!.click();
    expect(open).toHaveBeenCalledOnce();
    const call = open.mock.calls[0] ?? [];
    const href = call[0];
    const target_ = call[1];
    expect(target_).toBe('_blank');
    const url = new URL(String(href));
    expect(url.origin + url.pathname).toBe('https://github.com/xebia/badge-scanner/issues/new');
    expect(url.searchParams.get('title')).toBe('Badge scan: Ada Lovelace');
    expect(url.searchParams.get('labels')).toBe('GitHubUniverse');
    expect(url.searchParams.get('assignees')).toBe('booth-staff');
    const body = url.searchParams.get('body')!;
    expect(body).toMatch(/^## Badge details\n/);
    expect(body).toContain('| Role | Countess |');
    expect(body).toContain('| Company | Analytical \\| Engines |');
    expect(body).toContain('| Email address | ada@example.org |');
    expect(body).toContain('\n## Notes\n');
    expect(body).toMatch(/\n---\n\nScanned via OCR on: 28-Oct-2026 14:07$/);
    expect(tab.opener).toBeNull();
    expect(document.getElementById('qr-status')!.textContent).toContain('Opened a pre-filled GitHub issue');
    expect(ui.exportSettings()).toEqual(expect.objectContaining({
      qrIssue: { repoUrl: 'https://github.com/xebia/badge-scanner', label: 'GitHubUniverse' },
    }));
    expect(JSON.stringify(ui.exportSettings())).not.toContain('booth-staff');
  } finally { open.mockRestore(); vi.mocked(loadKv).mockResolvedValue(undefined); }
});

it('reports a blocked GitHub tab and refuses to save an invalid email', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  try {
    const ui = new GreetingUi(context);
    await ui.init();
    await ui['greet']('Ada', target, 'manual');
    const email = document.getElementById('qr-data-email') as HTMLInputElement;
    email.value = 'bad@';
    document.getElementById('qr-data')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(open).not.toHaveBeenCalled();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    email.value = '';
    email.dispatchEvent(new Event('input'));
    document.getElementById('qr-data-save')!.click();
    expect(open).toHaveBeenCalledOnce();
    expect(document.getElementById('qr-status')!.textContent).toContain('blocked the new GitHub tab');
  } finally { open.mockRestore(); }
});

it('persists valid issue settings, rejects invalid ones and applies imports immediately', async () => {
  const ui = new GreetingUi(context);
  await ui.init();
  const repo = document.getElementById('qr-issue-repo') as HTMLInputElement;
  const label = document.getElementById('qr-issue-label') as HTMLInputElement;
  const assignee = document.getElementById('qr-issue-assignee') as HTMLInputElement;
  expect(repo.value).toBe('https://github.com/xebia/badge-scanner');
  expect(label.value).toBe('GitHubUniverse');
  repo.value = 'https://github.com/octo-org/leads/';
  label.value = 'Leads';
  repo.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(saveKv).toHaveBeenCalledWith('qrIssue', { repoUrl: 'https://github.com/octo-org/leads', label: 'Leads' }));
  expect(repo.value).toBe('https://github.com/octo-org/leads');
  expect(document.getElementById('qr-issue-note-text')!.textContent).toContain('octo-org organization');
  vi.mocked(saveKv).mockClear();
  repo.value = 'https://example.com/a/b';
  repo.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.getElementById('qr-issue-error')!.textContent).toContain('not saved'));
  expect(saveKv).not.toHaveBeenCalledWith('qrIssue', expect.anything());
  expect(ui.exportSettings().qrIssue).toEqual({ repoUrl: 'https://github.com/octo-org/leads', label: 'Leads' });
  assignee.value = 'not valid';
  assignee.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.getElementById('qr-issue-error')!.textContent).toContain('assignee was not saved'));
  assignee.value = '@octocat';
  assignee.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(saveKv).toHaveBeenCalledWith('qrIssueAssignee', 'octocat'));
  expect(() => ui.prepareImport({ qrIssue: { repoUrl: 'nope', label: '' } })).toThrow();
  ui.applyImportedSettings(ui.prepareImport({ qrIssue: { repoUrl: 'https://github.com/imported/repo', label: '' } }));
  expect(repo.value).toBe('https://github.com/imported/repo');
  expect(label.value).toBe('');
  expect(assignee.value).toBe('octocat');
  expect(document.getElementById('qr-issue-error')!.textContent).toBe('');
});

it.each(['ocr', 'manual'] as const)('vibrates once when a recognized %s scan greeting starts playing, before completion', async (source) => {
  const ui = new GreetingUi(context);
  await ui.init();
  let finish!: (result: string) => void;
  playback.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const greeting = ui['greet']('Rob', target, source);
  await vi.waitFor(() => expect(playback).toHaveBeenCalledOnce());
  expect(vibrateFeedback).toHaveBeenCalledOnce();
  await ui['greet']('Rob', target, source);
  expect(vibrateFeedback).toHaveBeenCalledOnce();
  finish('completed');
  await greeting;
  expect(vibrateFeedback).toHaveBeenCalledOnce();
});

it('uses one status box for readiness, camera progress, errors and recovery', async () => {
  const ui = new GreetingUi(context);
  await ui.init();
  const status = document.getElementById('qr-status')!;
  expect(status.classList.contains('scan-status')).toBe(true);
  expect(status.textContent).toBe('Ready to scan a badge.');
  expect(document.querySelector('#qr-ready, #qr-error')).toBeNull();
  ui['scanning'] = true;
  ui['status']('Recognizing text (50%)...');
  ui.updateStatus();
  expect(status.textContent).toBe('Recognizing text (50%)...');
  ui['error']('Text recognition failed.');
  ui['status']('Adjust the badge position or lighting, then capture again.');
  ui.updateStatus();
  expect(status.textContent).toBe('Text recognition failed. Adjust the badge position or lighting, then capture again.');
  expect(status.getAttribute('role')).toBe('alert');
  expect(status.getAttribute('aria-live')).toBe('assertive');
  expect(status.classList.contains('bad')).toBe(true);
  ui['error']('');
  ui.stopCamera();
  expect(status.textContent).toBe('Camera stopped.');
  expect(status.getAttribute('role')).toBe('status');
  expect(status.classList.contains('bad')).toBe(false);
  Object.assign(target, { state: 'Disconnected' });
  ui.updateStatus();
  expect(status.textContent).toBe('Connect your primary cap before scanning.');
});

it.each([
  ['upload starts', { state: 'Uploading' }],
  ['cap disconnects', { state: 'Disconnected' }],
  ['temporary playback starts', { temporaryActive: true }],
])('does not vibrate for a scan greeting when %s before playback or on camera stop', async (_reason, change) => {
  const ui = new GreetingUi(context);
  await ui.init();
  Object.assign(target, change);
  await ui['greet']('Rob', target, 'ocr');
  ui.stopCamera();
  expect(playback).not.toHaveBeenCalled();
  expect(vibrateFeedback).not.toHaveBeenCalled();
});

it.each(['completed', 'cancelled'])('enables Scan and clears unknown content after a %s greeting', async (result) => {
  Object.assign(target, { canRestoreContent: false });
  playback.mockResolvedValueOnce(result);
  const ui = new GreetingUi(context);
  await ui.init();
  const scan = document.getElementById('qr-text-start') as HTMLButtonElement;
  expect(scan.textContent).toBe('Scan');
  expect(scan.classList.contains('primary')).toBe(true);
  expect(scan.disabled).toBe(false);
  expect(document.getElementById('qr-start')).toBeNull();
  await ui['greet']('Rob', target, 'ocr');
  expect(playback).toHaveBeenCalledWith(expect.any(Uint8Array), expect.any(Object), expect.any(Number), { clearIfUnknown: true });
  expect(vibrateFeedback).toHaveBeenCalledOnce();
  expect(document.getElementById('qr-status')!.textContent)
    .toBe(`${result === 'cancelled' ? 'Greeting ended early.' : 'Greeting finished.'} Display cleared to black.`);
  ui.updateStatus();
  ui.stopCamera();
  expect(document.getElementById('qr-status')!.textContent)
    .toBe(`${result === 'cancelled' ? 'Greeting ended early.' : 'Greeting finished.'} Display cleared to black.`);
  expect(scan.disabled).toBe(false);
});

it.each([
  { state: 'Disconnected' }, { state: 'Connecting' }, { state: 'Uploading' },
  { state: 'Error' }, { temporaryActive: true },
])('disables Scan when the cap is unavailable: %j', async (change) => {
  Object.assign(target, change);
  const ui = new GreetingUi(context);
  await ui.init();
  expect((document.getElementById('qr-text-start') as HTMLButtonElement).disabled).toBe(true);
});

it('updates the #status-listening header pill across idle, starting, enrolling, active, paused, and stopping states', async () => {
  const ui = new SoundUi(context);
  await ui.init();
  const pill = document.getElementById('status-listening')!;
  expect(pill.textContent).toBe('Listening: off');
  expect(pill.className).toBe('pill muted');
  ui['mode'] = 'starting';
  ui.updateStatus();
  expect(pill.textContent).toBe('Listening: starting…');
  expect(pill.className).toBe('pill busy');
  ui['mode'] = 'enrolling';
  ui.updateStatus();
  expect(pill.textContent).toBe('Listening: voice sample');
  expect(pill.className).toBe('pill busy');
  ui['mode'] = 'listening';
  ui.updateStatus();
  expect(pill.textContent).toBe('Listening: on');
  expect(pill.className).toBe('pill ok');
  ui['preferences'].pauseInPocket = true;
  ui['setPocket'](true);
  expect(pill.textContent).toBe('Listening: paused');
  expect(pill.className).toBe('pill busy');
  ui['setPocket'](false);
  expect(pill.textContent).toBe('Listening: on');
  expect(pill.className).toBe('pill ok');
  ui['mode'] = 'stopping';
  ui.updateStatus();
  expect(pill.textContent).toBe('Listening: stopping…');
  expect(pill.className).toBe('pill busy');
});

it('updates #status-approach, vibrates when a group approach tier starts uploading, and keeps solo cap black when keepBlack is enabled', async () => {
  vi.useFakeTimers();
  try {
    let keepBlack = true;
    await initApproach({
      native: false, mock: true,
      profile: () => ({ ...SPIKE_PROFILE, interWriteDelayMs: 0 }),
      logicalDims: () => [8, 8],
      physical: (img) => img,
      renderContent: async () => ({ image: solid(8, 8, [255, 255, 255]) }),
      createContent: () => ({ kind: 'solid', color: '#ffffff' }),
      keepBlack: () => keepBlack,
      marqueeDelay: () => 60,
      trace: () => {},
      chooseCap: async () => ({ deviceId: 'mock-1', name: 'iledcolor-1' }),
      connectCap: async () => { throw new Error('unused'); },
      readRssi: async () => -55,
      startScan: async () => {},
      stopScan: async () => {},
      onPrimaryChange: () => {},
    });
    renderApproach();
    const pill = document.getElementById('status-approach')!;
    expect(pill.textContent).toBe('Approach: off');
    expect(pill.className).toBe('pill muted');
    await connectAsPrimary('mock-1', 'iledcolor-1');
    expect(vibrateFeedback).not.toHaveBeenCalled();
    expect(document.querySelector('#ap-caps .cap-note')?.textContent).toBe('keep black (idle)');
    (document.getElementById('ap-sim-peer') as HTMLButtonElement).click();
    const toggle = document.getElementById('ap-start') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(pill.className).toBe('pill ok');
    expect(pill.textContent).toMatch(/^Approach: on/);
    expect(vibrateFeedback).toHaveBeenCalledOnce();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(100);
    expect(pill.textContent).toBe('Approach: off');
    expect(pill.className).toBe('pill muted');
    keepBlack = false;
    await keepBlackChanged();
  } finally {
    vi.useRealTimers();
  }
});

it('refreshes imported emoji reaction text immediately without replacing device speech consent', async () => {
  const ui = await listening();
  ui['preferences'].allowBrowserSpeech = true;
  const imported = defaultPreferences();
  imported.reactions.greeting.text = 'WELCOME 👋';
  const prepared = ui.prepareImport(imported);
  ui.applyImported(prepared);
  expect((document.getElementById('sound-text-greeting') as HTMLInputElement).value).toBe('WELCOME 👋');
  expect(ui.exportPreferences().allowBrowserSpeech).toBe(true);
});
