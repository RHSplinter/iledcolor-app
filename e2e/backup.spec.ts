import { expect, test, type Page } from '@playwright/test';
import { openBackup, openCustomSection, connectHat } from './hat';
import { readFile } from 'node:fs/promises';

async function shareBackup(page: Page) {
  await openBackup(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const path = await download.path();
  if (!path) throw new Error('Missing backup download.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function importBackup(page: Page, data: unknown) {
  await openBackup(page);
  await page.setInputFiles('#p-import', {
    name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)),
  });
}

test('all categories restore settings from every tab immediately and after reload', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#mock');
  await connectHat(page);
  await openCustomSection(page, 'text');
  await page.fill('#c-str', 'Connect draft');
  await page.locator('#c-speed').fill('7');
  await page.click('nav [data-tab=approach]');
  await page.check('input[name=ap-mode][value=hub]');
  await page.uncheck('#ap-beacon');
  await page.uncheck('#ap-count');
  await page.fill('#ap-enter', '-63');
  await page.locator('#ap-enter').dispatchEvent('change');
  await page.locator('[data-tier=pair][data-field=text]').fill('Imported group');
  await page.locator('[data-tier=pair][data-field=text]').dispatchEvent('change');
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-template', 'Current {name}!');
  await page.fill('#qr-repetitions', '17');
  await page.locator('#qr-speed').fill('8');
  await page.click('nav [data-tab=settings]');
  await page.check('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toHaveText('Scan logging enabled.');
  await page.fill('#qr-issue-repo', 'https://github.com/octo-org/leads/');
  await page.locator('#qr-issue-repo').dispatchEvent('change');
  await page.fill('#qr-issue-label', 'Universe,Leads');
  await page.locator('#qr-issue-label').dispatchEvent('change');
  await page.fill('#qr-issue-assignee', 'booth-staff');
  await page.locator('#qr-issue-assignee').dispatchEvent('change');
  await expect(page.locator('#qr-issue-repo')).toHaveValue('https://github.com/octo-org/leads');
  await page.click('nav [data-tab=sound]');
  await page.selectOption('#sound-language', 'de-DE');
  await page.uncheck('#sound-noises');
  await page.locator('#sound-reactions details').first().locator('summary').click();
  await page.fill('#sound-text-greeting', 'SERVUS 👋');
  await page.locator('#sound-text-greeting').dispatchEvent('change');
  await page.click('nav [data-tab=settings]');
  await page.selectOption('#s-font', 'tiny5');
  await page.selectOption('#s-rot', '90');
  await page.check('#s-mh');
  await page.check('#s-keep-black');
  await page.fill('#s-chunk', '128');
  await page.fill('#s-delay', '8');
  await page.locator('#s-delay').dispatchEvent('change');
  await page.locator('#brightness').fill('2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.click('nav [data-tab=presets]');
  const backup = await shareBackup(page);
  expect(backup.createContent).toMatchObject({ kind: 'text', text: 'Connect draft', speed: 7 });
  expect(backup.approach).toMatchObject({ mode: 'hub', beacon: false, countNearbyCaps: false });
  expect(backup.scan.enterDbm).toBe(-63);
  expect(backup.qrGreeting).toEqual({ template: 'Current {name}!', repetitions: 17, speed: 8 });
  expect(backup).not.toHaveProperty('qrProfiles');
  expect(backup.qrScanLogging).toBe(true);
  expect(backup.qrIssue).toEqual({ repoUrl: 'https://github.com/octo-org/leads', label: 'Universe,Leads' });
  expect(JSON.stringify(backup)).not.toContain('booth-staff');
  expect(backup.settings).toMatchObject({ textFont: 'tiny5', keepBlack: true, brightness: 2, chunkSize: 128, interWriteDelayMs: 8, transform: { rotation: 90, mirrorH: true } });
  expect(backup.sound).toMatchObject({ language: 'de-DE', sounds: false, allowBrowserSpeech: false, reactions: { greeting: { text: 'SERVUS 👋' } } });
  for (const key of ['phoneId', 'userName', 'approachCaps', 'approachEnabled', 'soundVoice']) expect(backup).not.toHaveProperty(key);

  await page.click('nav [data-tab=settings]');
  await page.selectOption('#s-rot', '0');
  await page.selectOption('#s-font', 'dotgothic');
  await page.uncheck('#s-mh');
  await page.uncheck('#s-keep-black');
  await page.locator('#brightness').fill('9');
  await page.fill('#s-chunk', '492');
  await page.locator('#s-chunk').dispatchEvent('change');
  await page.click('nav [data-tab=custom]');
  await openCustomSection(page, 'text');
  await page.fill('#c-str', 'Changed draft');
  await page.click('nav [data-tab=approach]');
  await page.check('input[name=ap-mode][value=p2p]');
  await page.fill('#ap-enter', '-70');
  await page.locator('#ap-enter').dispatchEvent('change');
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-repetitions', '3');
  await page.locator('#qr-speed').fill('5');
  await page.click('nav [data-tab=settings]');
  await page.uncheck('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toContainText('Scan logging disabled.');
  await page.fill('#qr-issue-repo', 'https://github.com/other/repo');
  await page.locator('#qr-issue-repo').dispatchEvent('change');
  await page.fill('#qr-issue-label', 'Changed');
  await page.locator('#qr-issue-label').dispatchEvent('change');
  await page.click('nav [data-tab=sound]');
  await page.selectOption('#sound-language', 'en-US');
  await page.check('#sound-noises');
  await page.fill('#sound-text-greeting', 'CHANGED');
  await page.locator('#sound-text-greeting').dispatchEvent('change');
  await page.click('nav [data-tab=presets]');
  // Old backups may contain an obsolete regex, which must not affect automatic extraction.
  backup.qrGreeting.pattern = '[';
  await importBackup(page, backup);
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories.');

  for (const reload of [false, true]) {
    if (reload) {
      await page.reload();
      await connectHat(page);
    }
    await page.click('nav [data-tab=custom]');
    await expect(page.locator('#c-str')).toHaveValue('Connect draft');
    await expect(page.locator('#c-speed')).toHaveValue('7');
    await page.click('nav [data-tab=approach]');
    await expect(page.locator('input[name=ap-mode][value=hub]')).toBeChecked();
    await expect(page.locator('#ap-beacon')).not.toBeChecked();
    await expect(page.locator('#ap-count')).not.toBeChecked();
    await expect(page.locator('#ap-enter')).toHaveValue('-63');
    await expect(page.locator('[data-tier=pair][data-field=text]')).toHaveValue('Imported group');
    await expect(page.locator('#ap-start')).not.toBeChecked();
    await page.click('nav [data-tab=scan]');
    await expect(page.locator('#qr-pattern')).toHaveCount(0);
    await expect(page.locator('#qr-template')).toHaveValue('Current {name}!');
    await expect(page.locator('#qr-repetitions')).toHaveValue('17');
    await expect(page.locator('#qr-speed')).toHaveValue('8');
    await expect(page.locator('#qr-issue-note-text')).toContainText('octo-org/leads');
    await expect(page.locator('#qr-issue-note-text')).toContainText('octo-org organization');
    await page.click('nav [data-tab=settings]');
    await expect(page.locator('#qr-log-enabled')).toBeChecked();
    await expect(page.locator('#qr-issue-repo')).toHaveValue('https://github.com/octo-org/leads');
    await expect(page.locator('#qr-issue-label')).toHaveValue('Universe,Leads');
    await expect(page.locator('#qr-issue-assignee')).toHaveValue('booth-staff');
    await page.click('nav [data-tab=sound]');
    await expect(page.locator('#sound-language')).toHaveValue('de-DE');
    await expect(page.locator('#sound-noises')).not.toBeChecked();
    await expect(page.locator('#sound-text-greeting')).toHaveValue('SERVUS 👋');
    await page.click('nav [data-tab=presets]');
    await page.click('nav [data-tab=settings]');
    await expect(page.locator('#s-font')).toHaveValue('tiny5');
    await expect(page.locator('#s-rot')).toHaveValue('90');
    await expect(page.locator('#brightness')).toHaveValue('2');
    await expect(page.locator('#s-mh')).toBeChecked();
    await expect(page.locator('#s-keep-black')).toBeChecked();
    await expect(page.locator('#s-chunk')).toHaveValue('128');
    await expect(page.locator('#s-delay')).toHaveValue('8');
  }
});

test('display-only backup ignores invalid excluded scanner inputs and preserves other tabs', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await openCustomSection(page, 'text');
  await page.fill('#c-str', 'Keep this draft');
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-template', 'Keep {name}!');
  await page.fill('#qr-repetitions', '0');
  await page.locator('#qr-repetitions').dispatchEvent('change');
  await page.click('nav [data-tab=sound]');
  await page.uncheck('#sound-noises');
  await openBackup(page);
  for (const key of ['creations', 'approach', 'scan', 'sound']) await page.uncheck(`#p-include-${key}`);
  const backup = await shareBackup(page);
  expect(Object.keys(backup).sort()).toEqual(['app', 'settings', 'version']);
  backup.settings.transform.rotation = 180;
  await importBackup(page, backup);
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories.');
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#s-rot')).toHaveValue('180');
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-template')).toHaveValue('Keep {name}!');
  await expect(page.locator('#qr-repetitions')).toHaveValue('0');
  await page.click('nav [data-tab=sound]');
  await expect(page.locator('#sound-noises')).not.toBeChecked();
  await page.click('nav [data-tab=custom]');
  await expect(page.locator('#c-str')).toHaveValue('Keep this draft');

  // Unchecking Display & transport settings excludes settings; legacy v1/v2 imports without keepBlack preserve local keepBlack.
  await page.click('nav [data-tab=settings]');
  await page.check('#s-keep-black');
  await openBackup(page);
  await page.uncheck('#p-include-settings');
  await page.check('#p-include-creations');
  const creationsOnly = await shareBackup(page);
  expect(creationsOnly).not.toHaveProperty('settings');
  await importBackup(page, creationsOnly);
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#s-keep-black')).toBeChecked();

  const legacyV2 = structuredClone(backup);
  delete legacyV2.settings.keepBlack;
  await page.click('nav [data-tab=presets]');
  await importBackup(page, legacyV2);
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#s-keep-black')).toBeChecked();

  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-repetitions', '3');
  await page.locator('#qr-repetitions').dispatchEvent('change');
  await page.click('nav [data-tab=presets]');
  const legacyV1 = {
    version: 1,
    app: backup.app,
    exportedAt: '2026-01-01T00:00:00.000Z',
    settings: legacyV2.settings,
    presets: [],
  };
  await importBackup(page, legacyV1);
  await expect(page.locator('#p-msg')).toContainText('Imported 0 presets');
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#s-keep-black')).toBeChecked();
  await page.click('nav [data-tab=custom]');
  await expect(page.locator('#c-keep-black')).toHaveCount(0);
});

test('malformed scanner settings reject the entire backup without changing other categories', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await openCustomSection(page, 'text');
  await page.fill('#c-str', 'Keep original');
  await page.click('nav [data-tab=presets]');
  const backup = await shareBackup(page);
  backup.createContent.text = 'Must not apply';
  backup.settings.transform.rotation = 180;
  backup.qrGreeting.repetitions = 0;
  await importBackup(page, backup);
  await expect(page.locator('#p-msg')).toContainText('Import failed: Repetitions');
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#s-rot')).toHaveValue('0');
  await page.click('nav [data-tab=custom]');
  await expect(page.locator('#c-str')).toHaveValue('Keep original');

  await page.click('nav [data-tab=presets]');
  const badKeepBlack = structuredClone(backup);
  badKeepBlack.qrGreeting.repetitions = 3;
  badKeepBlack.settings.keepBlack = 'yes';
  await importBackup(page, badKeepBlack);
  await expect(page.locator('#p-msg')).toContainText('Import failed: invalid keepBlack');
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#s-rot')).toHaveValue('0');
  await expect(page.locator('#s-keep-black')).not.toBeChecked();
  await page.click('nav [data-tab=custom]');
  await expect(page.locator('#c-str')).toHaveValue('Keep original');
  await expect(page.locator('#c-keep-black')).toHaveCount(0);
  await page.reload();
  await connectHat(page);
  await expect(page.locator('#c-str')).toHaveValue('Keep original');
  await page.click('nav [data-tab=presets]');
  await expect(page.locator('#s-keep-black')).not.toBeChecked();
});
