import { expect, test } from '@playwright/test';
import { openCustomSection, connectHat, waitForServiceWorker } from './hat';
import { readFile } from 'node:fs/promises';

test('manual scan greets offline, logs the scan and restores previous content', async ({ page, context }) => {
  await page.addInitScript(() => {
    Object.assign(window, { feedbackVibrations: [] as number[] });
    Object.defineProperty(navigator, 'vibrate', { value: (duration: number) => {
      (window as Window & { feedbackVibrations: number[] }).feedbackVibrations.push(duration);
      return true;
    } });
  });
  await page.goto('/#mock');
  await connectHat(page);
  await waitForServiceWorker(page);
  await context.setOffline(true);
  await page.reload();
  await connectHat(page);
  await page.click('nav [data-tab=custom]');
  await openCustomSection(page, 'solid');
  await page.click('#btn-send-solid');
  await expect(page.locator('#send-note')).toHaveText('Upload confirmed.');
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-repetitions')).toHaveValue('3');
  await page.check('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toHaveText('Scan logging enabled.');
  await page.locator('#qr-speed').fill('10');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', 'Rob');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-status')).toContainText('Hi Rob!', { timeout: 15000 });
  await expect(page.locator('#qr-video')).toBeHidden();
  expect(await page.evaluate(() => (window as Window & { feedbackVibrations: number[] }).feedbackVibrations)).toEqual([200]);
  await expect(page.locator('#qr-status')).toContainText('Previous content restored.', { timeout: 25000 });
  expect(await page.evaluate(() => (window as Window & { feedbackVibrations: number[] }).feedbackVibrations)).toEqual([200]);
  await expect(page.locator('#qr-error')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Scan', exact: true })).toBeEnabled();
  await expect(page.locator('#qr-log-status')).toHaveText('Scan saved to qr-scan-log.jsonl.');
  const downloadPromise = page.waitForEvent('download');
  await page.click('#qr-log-share');
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Missing scan log download.');
  const entry = JSON.parse((await readFile(path, 'utf8')).trim());
  expect(entry).toMatchObject({ raw: 'Rob', source: 'manual' });
  expect(entry).not.toHaveProperty('profile');
  expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
});

test('a greeting pauses only the primary cap while approach updates keep reaching other caps', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { feedbackVibrations: [] as number[] });
    Object.defineProperty(navigator, 'vibrate', { value: (duration: number) => {
      (window as Window & { feedbackVibrations: number[] }).feedbackVibrations.push(duration);
      return true;
    } });
  });
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=approach]');
  await page.check('input[name=ap-mode][value=hub]');
  await page.click('#ap-add');
  await expect(page.locator('#ap-caps li')).toHaveCount(2);
  await page.fill('#ap-settle', '0');
  await page.locator('#ap-settle').dispatchEvent('change');
  await page.check('#ap-start');
  await expect(page.locator('#ap-caps .cap-note').first()).toContainText('Hi ', { timeout: 15000 });
  expect(await page.evaluate(() => (window as Window & { feedbackVibrations: number[] }).feedbackVibrations)).toEqual([200]);
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-template', 'Hello {name}!');
  await page.fill('#qr-repetitions', '30');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', 'Rob');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-status')).toContainText('Hello Rob!');
  expect(await page.evaluate(() => (window as Window & { feedbackVibrations: number[] }).feedbackVibrations)).toEqual([200, 200]);
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 15000 });
  await page.click('nav [data-tab=approach]');
  await page.click('#ap-sim-peer');
  await expect(page.locator('#ap-caps .cap-note').nth(1)).toContainText('span ', { timeout: 15000 });
  await expect(page.locator('#ap-caps .cap-note').first()).not.toContainText('span ');
  expect(await page.evaluate(() => (window as Window & { feedbackVibrations: number[] }).feedbackVibrations)).toEqual([200, 200, 200]);
  await page.click('nav [data-tab=scan]');
  await page.click('#qr-cancel');
  await expect(page.locator('#qr-status')).toContainText('ended early. Previous content restored.', { timeout: 15000 });
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-caps .cap-note').first()).toContainText('span ', { timeout: 15000 });
  // The resumed multi-cap approach greeting emits its own haptic after cancellation.
  expect(await page.evaluate(() => (window as Window & { feedbackVibrations: number[] }).feedbackVibrations)).toEqual([200, 200, 200, 200]);
});

test('invalid scan data leaves content alone and greeting settings persist without badge data', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=settings]');
  await page.check('#s-keep-black');
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-ready')).toHaveText('Ready to scan a badge.');
  await page.fill('#qr-template', 'Hello {name} from {company}!');
  await page.fill('#qr-repetitions', '1');
  await page.locator('#qr-speed').fill('10');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', '{"name":"Rob Bos","company":"Xebia"}');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-status')).toContainText('Hello Rob Bos from Xebia!', { timeout: 10000 });
  await expect(page.locator('#qr-status')).toContainText('Previous content restored.', { timeout: 20000 });
  await expect(page.locator('#qr-error')).toBeEmpty();
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-caps .cap-note').first()).toHaveText('keep black (idle)');
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-template', 'Welcome {name}!');
  await page.fill('#qr-raw', '{"email":"private@example.org"}');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-error')).toContainText('No usable name');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.reload();
  await connectHat(page);
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-pattern')).toHaveCount(0);
  await expect(page.locator('#qr-template')).toHaveValue('Welcome {name}!');
  await expect(page.locator('#qr-raw')).toHaveValue('');
  await expect(page.locator('#qr-submit')).toBeEnabled();
});

test('scanner has no saved badge profile controls', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-template')).toBeVisible();
  await expect(page.locator('#qr-profile, #qr-note, #qr-profile-save, #qr-profile-delete, #qr-pattern, #qr-pattern-help')).toHaveCount(0);
  await expect(page.locator('#view-scan > .card')).toHaveCount(3);
  await expect(page.locator('#view-scan')).not.toContainText('Name regex');
});

test('scan logging is opt-in, persists, includes failed manual entries, and stops when disabled', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=settings]');
  await page.getByText('Test patterns (dim, static)', { exact: true }).click();
  await page.click('#btn-test-color');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-log-enabled')).not.toBeChecked();
  await page.click('#qr-log-share');
  await expect(page.locator('#qr-log-error')).toContainText('Could not share scan log');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', '{"email":"private@example.org"}');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-error')).toContainText('No usable name');
  await page.click('#qr-log-share');
  await expect(page.locator('#qr-log-error')).toContainText('Could not share scan log');

  await page.check('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toHaveText('Scan logging enabled.');
  const raw = '{\n"email":"private@example.org",\n"notes":"private raw data"\n}';
  await page.fill('#qr-raw', raw);
  await page.click('#qr-submit');
  await expect(page.locator('#qr-error')).toContainText('No usable name');
  await expect(page.locator('#qr-log-status')).toContainText('Scan saved');
  await page.reload();
  await connectHat(page);
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-log-enabled')).toBeChecked();
  await page.uncheck('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toContainText('Existing log kept');

  await page.click('nav [data-tab=custom]');
  await page.click('nav [data-tab=settings]');
  await page.getByText('Test patterns (dim, static)', { exact: true }).click();
  await page.click('#btn-test-color');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('nav [data-tab=scan]');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', '{"company":"Not logged after disabling"}');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-error')).toContainText('No usable name');
  const downloadPromise = page.waitForEvent('download');
  await page.click('#qr-log-share');
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Missing scan log download.');
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ raw, source: 'manual' });
  expect(JSON.parse(lines[0]!)).not.toHaveProperty('profile');
});

test('Scan is blue and offline OCR greets a newly connected cap without sending content first', async ({ page, context }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    Object.assign(window, { feedbackVibrations: [] as number[] });
    Object.defineProperty(navigator, 'vibrate', { value: () => true });
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const ctx = canvas.getContext('2d')!;
    const drawBadge = () => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 62px Arial';
      ctx.fillText('Rob Bos', 190, 175);
      ctx.fillText('Software Engineer', 190, 275);
      ctx.fillText('Xebia', 190, 375);
    };
    drawBadge();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const stream = canvas.captureStream(10);
        setTimeout(drawBadge, 100);
        return stream;
      },
    });
  });
  await page.goto('/#mock');
  await waitForServiceWorker(page);
  await context.setOffline(true);
  await page.reload();
  const scan = page.locator('#qr-text-start');
  await expect(scan).toBeDisabled();
  await expect(page.locator('#qr-start')).toHaveCount(0);
  await expect(scan).toHaveText('Scan');
  await expect(scan).toHaveCSS('background-color', 'rgb(77, 163, 255)');
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('nav [data-tab=scan]');
  await expect(scan).toBeEnabled();
  await scan.click();
  await expect(page.locator('#qr-ocr-controls')).toBeVisible();
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#qr-video');
    return !!video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
  });
  await page.click('#qr-capture');
  await expect(page.locator('#qr-status')).toContainText('Hi Rob Bos!', { timeout: 60000 });
  await expect(page.locator('#qr-status')).toContainText('Display cleared to black.', { timeout: 30000 });
  await expect(page.locator('#qr-error')).toBeEmpty();
  await expect(scan).toBeEnabled();
});
