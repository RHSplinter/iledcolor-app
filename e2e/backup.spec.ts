import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function shareBackup(page: Page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const path = await download.path();
  if (!path) throw new Error('Missing backup download.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function importBackup(page: Page, data: unknown) {
  await page.setInputFiles('#p-import', {
    name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)),
  });
}

test('all categories restore settings from every tab immediately and after reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#mock');
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');
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
  await page.fill('#qr-note', 'Saved badge');
  await page.fill('#qr-pattern', '^(.+)$');
  await page.fill('#qr-template', 'Saved {name}!');
  await page.click('#qr-profile-save');
  await expect(page.locator('#qr-profile')).toHaveValue('1');
  // The active editor may differ from its saved profile and must round-trip exactly.
  await page.fill('#qr-pattern', 'name=(.+)');
  await page.fill('#qr-template', 'Current {name}!');
  await page.fill('#qr-repetitions', '17');
  await page.locator('#qr-speed').fill('8');
  await page.check('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toHaveText('Scan logging enabled.');
  await page.click('nav [data-tab=sound]');
  await page.selectOption('#sound-language', 'de-DE');
  await page.uncheck('#sound-noises');
  await page.locator('#sound-reactions details').first().locator('summary').click();
  await page.fill('#sound-text-greeting', 'SERVUS');
  await page.locator('#sound-text-greeting').dispatchEvent('change');
  await page.click('nav [data-tab=settings]');
  await page.selectOption('#s-font', 'tiny5');
  await page.selectOption('#s-rot', '90');
  await page.check('#s-mh');
  await page.fill('#s-chunk', '128');
  await page.fill('#s-delay', '8');
  await page.locator('#s-delay').dispatchEvent('change');
  await page.locator('#brightness').fill('2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const backup = await shareBackup(page);
  expect(backup.createContent).toMatchObject({ kind: 'text', text: 'Connect draft', speed: 7 });
  expect(backup.approach).toMatchObject({ mode: 'hub', beacon: false, countNearbyCaps: false });
  expect(backup.scan.enterDbm).toBe(-63);
  expect(backup.qrGreeting).toEqual({ pattern: 'name=(.+)', template: 'Current {name}!', repetitions: 17, speed: 8 });
  expect(backup.qrProfiles.profiles[0].template).toBe('Saved {name}!');
  expect(backup.qrScanLogging).toBe(true);
  expect(backup.settings).toMatchObject({ textFont: 'tiny5', brightness: 2, chunkSize: 128, interWriteDelayMs: 8, transform: { rotation: 90, mirrorH: true } });
  expect(backup.sound).toMatchObject({ language: 'de-DE', sounds: false, allowBrowserSpeech: false, reactions: { greeting: { text: 'SERVUS' } } });
  for (const key of ['phoneId', 'userName', 'approachCaps', 'approachEnabled', 'soundVoice']) expect(backup).not.toHaveProperty(key);

  await page.selectOption('#s-rot', '0');
  await page.selectOption('#s-font', 'dotgothic');
  await page.uncheck('#s-mh');
  await page.locator('#brightness').fill('9');
  await page.fill('#s-chunk', '492');
  await page.locator('#s-chunk').dispatchEvent('change');
  await page.click('nav [data-tab=connect]');
  await page.fill('#c-str', 'Changed draft');
  await page.click('nav [data-tab=approach]');
  await page.check('input[name=ap-mode][value=p2p]');
  await page.fill('#ap-enter', '-70');
  await page.locator('#ap-enter').dispatchEvent('change');
  await page.click('nav [data-tab=scan]');
  await page.selectOption('#qr-profile', '');
  await page.fill('#qr-repetitions', '3');
  await page.locator('#qr-speed').fill('5');
  await page.uncheck('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toContainText('Scan logging disabled.');
  await page.click('nav [data-tab=sound]');
  await page.selectOption('#sound-language', 'en-US');
  await page.check('#sound-noises');
  await page.fill('#sound-text-greeting', 'CHANGED');
  await page.locator('#sound-text-greeting').dispatchEvent('change');
  await page.click('nav [data-tab=settings]');
  await importBackup(page, backup);
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories.');

  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await page.click('nav [data-tab=connect]');
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
    await expect(page.locator('#qr-profile')).toHaveValue('1');
    await expect(page.locator('#qr-pattern')).toHaveValue('name=(.+)');
    await expect(page.locator('#qr-template')).toHaveValue('Current {name}!');
    await expect(page.locator('#qr-repetitions')).toHaveValue('17');
    await expect(page.locator('#qr-speed')).toHaveValue('8');
    await expect(page.locator('#qr-log-enabled')).toBeChecked();
    await page.click('nav [data-tab=sound]');
    await expect(page.locator('#sound-language')).toHaveValue('de-DE');
    await expect(page.locator('#sound-noises')).not.toBeChecked();
    await expect(page.locator('#sound-text-greeting')).toHaveValue('SERVUS');
    await page.click('nav [data-tab=settings]');
    await expect(page.locator('#s-font')).toHaveValue('tiny5');
    await expect(page.locator('#s-rot')).toHaveValue('90');
    await expect(page.locator('#brightness')).toHaveValue('2');
    await expect(page.locator('#s-mh')).toBeChecked();
    await expect(page.locator('#s-chunk')).toHaveValue('128');
    await expect(page.locator('#s-delay')).toHaveValue('8');
  }
});

test('display-only backup ignores invalid excluded scanner inputs and preserves other tabs', async ({ page }) => {
  await page.goto('/#mock');
  await page.fill('#c-str', 'Keep this draft');
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-template', 'Keep {name}!');
  await page.fill('#qr-repetitions', '0');
  await page.locator('#qr-repetitions').dispatchEvent('change');
  await page.click('nav [data-tab=sound]');
  await page.uncheck('#sound-noises');
  await page.click('nav [data-tab=settings]');
  for (const key of ['creations', 'approach', 'scan', 'sound']) await page.uncheck(`#p-include-${key}`);
  const backup = await shareBackup(page);
  expect(Object.keys(backup).sort()).toEqual(['app', 'settings', 'version']);
  backup.settings.transform.rotation = 180;
  await importBackup(page, backup);
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories.');
  await expect(page.locator('#s-rot')).toHaveValue('180');
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-template')).toHaveValue('Keep {name}!');
  await expect(page.locator('#qr-repetitions')).toHaveValue('0');
  await page.click('nav [data-tab=sound]');
  await expect(page.locator('#sound-noises')).not.toBeChecked();
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#c-str')).toHaveValue('Keep this draft');
});

test('malformed scanner settings reject the entire backup without changing other categories', async ({ page }) => {
  await page.goto('/#mock');
  await page.fill('#c-str', 'Keep original');
  await page.click('nav [data-tab=settings]');
  const backup = await shareBackup(page);
  backup.createContent.text = 'Must not apply';
  backup.settings.transform.rotation = 180;
  backup.qrGreeting.repetitions = 0;
  await importBackup(page, backup);
  await expect(page.locator('#p-msg')).toContainText('Import failed: Repetitions');
  await expect(page.locator('#s-rot')).toHaveValue('0');
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#c-str')).toHaveValue('Keep original');
  await page.reload();
  await expect(page.locator('#c-str')).toHaveValue('Keep original');
});
