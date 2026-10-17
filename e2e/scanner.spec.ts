import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { default: QRCodeWriter }: typeof import('@zxing/library/cjs/core/qrcode/QRCodeWriter.js') = require('@zxing/library/cjs/core/qrcode/QRCodeWriter.js');
const { default: BarcodeFormat }: typeof import('@zxing/library/cjs/core/BarcodeFormat.js') = require('@zxing/library/cjs/core/BarcodeFormat.js');

test('camera decodes a QR code offline and greets the primary cap before restoring', async ({ page, context }) => {
  const qr = new QRCodeWriter().encode('Rob', BarcodeFormat.QR_CODE, 256, 256, new Map());
  const pixels: number[] = [];
  for (let y = 0; y < qr.getHeight(); y++)
    for (let x = 0; x < qr.getWidth(); x++) if (qr.get(x, y)) pixels.push(x, y);
  await page.addInitScript(({ pixels }) => {
    const getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d')!;
      const draw = () => {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, 256, 256);
        ctx.fillStyle = '#000';
        for (let i = 0; i < pixels.length; i += 2) ctx.fillRect(pixels[i]!, pixels[i + 1]!, 1, 1);
      };
      draw();
      const stream = canvas.captureStream(10);
      setTimeout(draw, 100);
      return stream;
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: getUserMedia });
  }, { pixels });
  await page.goto('/#mock');
  await expect(page.locator('#offline')).toHaveText('Ready for offline use', { timeout: 20000 });
  await context.setOffline(true);
  await page.reload();
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('nav [data-tab=connect]');
  await page.selectOption('#c-kind', 'solid');
  await page.click('#btn-send');
  await expect(page.locator('#send-note')).toHaveText('Upload confirmed.');
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-repetitions')).toHaveValue('3');
  await page.check('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toHaveText('Scan logging enabled.');
  await page.locator('#qr-speed').fill('10');
  await page.click('#qr-start');
  await expect(page.locator('#qr-status')).toContainText('Hi Rob!', { timeout: 15000 });
  await expect(page.locator('#qr-video')).toBeHidden();
  await expect(page.locator('#qr-status')).toContainText('Previous content restored.', { timeout: 25000 });
  await expect(page.locator('#qr-error')).toBeEmpty();
  await expect(page.locator('#qr-start')).toBeEnabled();
  await expect(page.locator('#qr-log-status')).toHaveText('Scan saved to qr-scan-log.jsonl.');
  const downloadPromise = page.waitForEvent('download');
  await page.click('#qr-log-share');
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Missing scan log download.');
  const entry = JSON.parse((await readFile(path, 'utf8')).trim());
  expect(entry).toMatchObject({ raw: 'Rob', source: 'camera', profile: null });
  expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
});

test('a greeting pauses only the primary cap while approach updates keep reaching other caps', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('#btn-connect');
  await page.click('nav [data-tab=approach]');
  await page.check('input[name=ap-mode][value=hub]');
  await page.click('#ap-add');
  await expect(page.locator('#ap-caps li')).toHaveCount(2);
  await page.fill('#ap-settle', '0');
  await page.locator('#ap-settle').dispatchEvent('change');
  await page.check('#ap-start');
  await expect(page.locator('#ap-caps .cap-note').first()).toContainText('Hi ', { timeout: 15000 });
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-template', 'Hello {name}!');
  await page.fill('#qr-repetitions', '30');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', 'Rob');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-status')).toContainText('Hello Rob!');
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 15000 });
  await page.click('nav [data-tab=approach]');
  await page.click('#ap-sim-peer');
  await expect(page.locator('#ap-caps .cap-note').nth(1)).toContainText('span ', { timeout: 15000 });
  await expect(page.locator('#ap-caps .cap-note').first()).not.toContainText('span ');
  await page.click('nav [data-tab=scan]');
  await page.click('#qr-cancel');
  await expect(page.locator('#qr-status')).toContainText('ended early. Previous content restored.', { timeout: 15000 });
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-caps .cap-note').first()).toContainText('span ', { timeout: 15000 });
});

test('regex errors leave content alone and settings persist without badge data', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('#btn-connect');
  await page.click('nav [data-tab=connect]');
  await page.selectOption('#c-kind', 'solid');
  await page.click('#btn-send');
  await expect(page.locator('#send-note')).toHaveText('Upload confirmed.');
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-pattern', '([^|]+)\\|([^|]+)\\|([^|]+)');
  await page.fill('#qr-template', 'Hello {name} {lastname} from {company}!');
  await page.fill('#qr-repetitions', '1');
  await page.locator('#qr-speed').fill('10');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', 'Rob|Bos|Xebia');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-status')).toContainText('Hello Rob Bos from Xebia!', { timeout: 10000 });
  await expect(page.locator('#qr-status')).toContainText('Previous content restored.', { timeout: 20000 });
  await expect(page.locator('#qr-error')).toBeEmpty();
  await page.fill('#qr-pattern', 'name=(?<name>[^;]+)');
  await page.fill('#qr-template', 'Welcome {name}!');
  await page.fill('#qr-raw', 'id=123;');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-error')).toContainText('did not match');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.fill('#qr-pattern', '(a+)+$');
  await page.fill('#qr-raw', 'a'.repeat(1000) + '!');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-error')).toContainText('took too long');
  await page.fill('#qr-pattern', 'name=(?<name>[^;]+)');
  await page.locator('#qr-pattern').dispatchEvent('change');
  await page.reload();
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-pattern')).toHaveValue('name=(?<name>[^;]+)');
  await expect(page.locator('#qr-template')).toHaveValue('Welcome {name}!');
  await expect(page.locator('#qr-raw')).toHaveValue('');
  await expect(page.locator('#qr-submit')).toBeDisabled();
});

test('saves three QR profiles with notes, restores them on reload, and supports none', async ({ page }) => {
  const tourPattern = String.raw`^[^^]*\^(?<firstname>[^^]+)\^(?<lastname>[^^]+)\^(?<company>[^^]+)\^`;
  await page.goto('/#mock');
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-note', 'MS AI Tour');
  await page.fill('#qr-pattern', tourPattern);
  await page.fill('#qr-template', 'Hello {firstname} {lastname} from {company}!');
  await page.click('#qr-profile-save');
  await expect(page.locator('#qr-profile')).toHaveValue('1');

  await page.reload();
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-profile')).toHaveValue('1');
  await expect(page.locator('#qr-note')).toHaveValue('MS AI Tour');
  await expect(page.locator('#qr-pattern')).toHaveValue(tourPattern);
  await expect(page.locator('#qr-template')).toHaveValue('Hello {firstname} {lastname} from {company}!');

  for (const [note, expectedId] of [['Badge two', '2'], ['Badge three', '3']]) {
    await page.selectOption('#qr-profile', '');
    await page.fill('#qr-note', note);
    await page.click('#qr-profile-save');
    await expect(page.locator('#qr-profile')).toHaveValue(expectedId);
  }
  await page.selectOption('#qr-profile', '');
  await page.fill('#qr-note', 'Fourth badge');
  await page.click('#qr-profile-save');
  await expect(page.locator('#qr-error')).toContainText('All three profile slots are in use');

  await page.selectOption('#qr-profile', '3');
  await page.click('nav [data-tab=settings]');
  const downloadPromise = page.waitForEvent('download');
  await page.click('#btn-export');
  const download = await downloadPromise;
  const backupPath = await download.path();
  if (!backupPath) throw new Error('QR profile export did not produce a file.');
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(backup.qrProfiles.selectedId).toBe('3');
  expect(backup.qrProfiles.profiles).toHaveLength(3);

  await page.click('nav [data-tab=scan]');
  await page.selectOption('#qr-profile', '2');
  await page.click('#qr-profile-delete');
  await expect(page.locator('#qr-profile option')).toHaveCount(3);
  await expect(page.locator('#qr-profile')).toHaveValue('');

  await page.click('nav [data-tab=settings]');
  await page.locator('#p-import').setInputFiles(backupPath);
  await expect(page.locator('#p-msg')).toContainText('3 QR profiles');
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-profile option')).toHaveCount(4);
  await expect(page.locator('#qr-profile')).toHaveValue('3');
  await expect(page.locator('#qr-note')).toHaveValue('Badge three');
});

test('scan logging is opt-in, persists, includes failed manual entries, and stops when disabled', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('#btn-connect');
  await page.click('nav [data-tab=settings]');
  await page.getByText('Test patterns (dim, static)', { exact: true }).click();
  await page.click('#btn-test-color');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-log-enabled')).not.toBeChecked();
  await page.click('#qr-log-share');
  await expect(page.locator('#qr-log-error')).toContainText('Could not share scan log');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-pattern', '^name=(.+)$');
  await page.fill('#qr-raw', 'not a matching badge');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-error')).toContainText('did not match');
  await page.click('#qr-log-share');
  await expect(page.locator('#qr-log-error')).toContainText('Could not share scan log');

  await page.check('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toHaveText('Scan logging enabled.');
  await page.fill('#qr-note', 'Evaluation');
  await page.click('#qr-profile-save');
  await expect(page.locator('#qr-profile')).toHaveValue('1');
  const raw = 'unknown^person^company^\n"private": raw data';
  await page.fill('#qr-raw', raw);
  await page.click('#qr-submit');
  await expect(page.locator('#qr-error')).toContainText('did not match');
  await expect(page.locator('#qr-log-status')).toContainText('Scan saved');
  await page.reload();
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-log-enabled')).toBeChecked();
  await page.uncheck('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toContainText('Existing log kept');

  await page.click('nav [data-tab=connect]');
  await page.click('#btn-connect');
  await page.click('nav [data-tab=settings]');
  await page.getByText('Test patterns (dim, static)', { exact: true }).click();
  await page.click('#btn-test-color');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('nav [data-tab=scan]');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', 'not logged after disabling');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-error')).toContainText('did not match');
  const downloadPromise = page.waitForEvent('download');
  await page.click('#qr-log-share');
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Missing scan log download.');
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ raw, source: 'manual', profile: { id: '1', note: 'Evaluation' } });
});
