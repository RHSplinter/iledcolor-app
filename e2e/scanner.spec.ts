import { expect, test } from '@playwright/test';
import { openCustomSection, connectHat, waitForServiceWorker } from './hat';
import { readFile } from 'node:fs/promises';

test('scan greetings respect the first-name template after saving and reloading', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-template-help')).toHaveText(
    'Use {name} or {firstname}, {lastname}, {role}, {company}, or {githubhandle} for captured fields.',
  );
  await page.fill('#qr-template', 'Hi {firstname}!');
  await page.fill('#qr-repetitions', '1');
  await page.locator('#qr-speed').fill('10');
  await page.locator('#qr-speed').blur();
  await page.reload();
  await connectHat(page);
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-template')).toHaveValue('Hi {firstname}!');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', 'Rob\nBos\n@octocat\nEngineer\nXebia');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-status')).toContainText('Hi Rob!');
  await expect(page.locator('#qr-status')).not.toContainText('Bos');
});

test('visitor data can be edited, remapped and cleared without saving or restoring it after reload', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=scan]');
  const form = page.getByRole('form', { name: 'Scanned visitor data' });
  await expect(form).toBeHidden();
  await expect(page.locator('#qr-status')).toHaveText('Ready to scan a badge.');
  await expect(page.locator('#qr-status')).toHaveCSS('border-top-style', 'none');
  await expect(page.locator('#qr-status')).toHaveCSS('border-left-style', 'solid');
  await expect(page.locator('#qr-status')).toHaveCSS('font-size', '13px');
  await expect(form.getByRole('separator')).toBeHidden();
  await expect(page.locator('#qr-ready, #qr-error, #qr-save-help')).toHaveCount(0);
  await page.fill('#qr-repetitions', '1');
  await page.locator('#qr-speed').fill('10');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', 'Rob Bos\nSoftware Engineer\nXebia\n@octocat');
  await page.click('#qr-submit');
  await expect(form).toBeVisible();
  await expect(page.getByRole('table', { name: 'Scanned visitor data' })).toBeVisible();
  await expect(form.locator('tbody tr')).toHaveCount(5);
  await expect(form.getByRole('separator')).toBeVisible();
  await expect(form.getByRole('columnheader')).toHaveCount(0);
  await expect(form).not.toContainText('Save is not available yet.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Data item 1', exact: true })).toHaveValue('Rob');
  await expect(page.getByRole('textbox', { name: 'Data item 2', exact: true })).toHaveValue('Bos');
  await expect(page.getByRole('textbox', { name: 'Data item 3', exact: true })).toHaveValue('@octocat');
  await page.getByRole('textbox', { name: 'Data item 1', exact: true }).fill('Ada');
  await page.getByRole('combobox', { name: 'Data item 2 type', exact: true }).selectOption('company');
  await page.getByRole('textbox', { name: 'Data item 3', exact: true }).fill('newhandle');
  await expect(page.getByRole('textbox', { name: 'Data item 3', exact: true })).toHaveValue('@newhandle');
  await expect(form.getByRole('button')).toHaveText(['Save', 'Clear']);
  const saveBounds = await form.getByRole('button', { name: 'Save', exact: true }).boundingBox();
  const clearBounds = await form.getByRole('button', { name: 'Clear', exact: true }).boundingBox();
  expect(saveBounds).not.toBeNull();
  expect(clearBounds).not.toBeNull();
  expect(saveBounds!.x + saveBounds!.width).toBeLessThan(clearBounds!.x);
  expect(saveBounds!.y).toBe(clearBounds!.y);
  await expect(form.getByRole('button', { name: 'Save', exact: true })).toHaveClass('primary');
  await page.getByRole('textbox', { name: 'Data item 1', exact: true }).press('Enter');
  await expect(form).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Data item 1', exact: true })).toHaveValue('Ada');
  await expect(page.locator('#qr-status')).toContainText('Hi Rob Bos!');
  await form.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(form.locator('input, select')).toHaveCount(0);
  await expect(form.getByRole('separator')).toBeHidden();
  await expect(page.locator('#qr-status')).toHaveText('Greeting finished. Display cleared to black.', { timeout: 20000 });
  await page.click('nav [data-tab=custom]');
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-status')).toHaveText('Greeting finished. Display cleared to black.');
  await page.fill('#qr-raw', 'Ada');
  await page.click('#qr-submit');
  await expect(form).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Data item 1', exact: true })).toHaveValue('Ada');
  await expect(page.getByRole('textbox', { name: 'Data item 3', exact: true })).toHaveValue('');
  await page.reload();
  await connectHat(page);
  await page.click('nav [data-tab=scan]');
  await expect(form).toBeHidden();
  await expect(form.locator('input, select')).toHaveCount(0);
});

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
  await expect(page.locator('#qr-status')).toHaveAttribute('role', 'status');
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
  await expect(page.locator('#qr-status')).toHaveText('Ready to scan a badge.');
  await page.fill('#qr-template', 'Hello {name} from {company}!');
  await page.fill('#qr-repetitions', '1');
  await page.locator('#qr-speed').fill('10');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', '{"name":"Rob Bos","company":"Xebia"}');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-status')).toContainText('Hello Rob Bos from Xebia!', { timeout: 10000 });
  await expect(page.locator('#qr-status')).toContainText('Previous content restored.', { timeout: 20000 });
  await expect(page.locator('#qr-status')).toHaveAttribute('role', 'status');
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-caps .cap-note').first()).toHaveText('keep black (idle)');
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-template', 'Welcome {name}!');
  await page.fill('#qr-raw', '{"email":"private@example.org"}');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-status')).toContainText('No usable name');
  await expect(page.locator('#qr-status')).toHaveAttribute('role', 'alert');
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
  await expect(page.locator('#qr-status')).toContainText('No usable name');
  await page.click('#qr-log-share');
  await expect(page.locator('#qr-log-error')).toContainText('Could not share scan log');

  await page.check('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toHaveText('Scan logging enabled.');
  const raw = '{\n"email":"private@example.org",\n"notes":"private raw data"\n}';
  await page.fill('#qr-raw', raw);
  await page.click('#qr-submit');
  await expect(page.locator('#qr-status')).toContainText('No usable name');
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
  await expect(page.locator('#qr-status')).toContainText('No usable name');
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

for (const layout of ['single-line name', 'stacked name with handle', 'tightly stacked name with handle']) {
test(`Scan is blue and offline OCR greets a newly connected cap (${layout})`, async ({ page, context }) => {
  const stacked = layout !== 'single-line name';
  const tight = layout === 'tightly stacked name with handle';
  test.setTimeout(90000);
  await page.addInitScript(({ stacked, tight }) => {
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
      if (stacked) {
        ctx.font = '56px Arial';
        ctx.fillText('Fokko', 190, 145);
        ctx.fillText('Veegens', 190, tight ? 194 : 210);
        ctx.font = '32px Arial';
        ctx.fillText('@FokkoVeegens', 190, 280);
        ctx.fillText('DevOps Consultant', 190, 350);
        ctx.fillText('Xebia', 190, 410);
        ctx.font = '22px Arial';
        ctx.fillText('Bewiea', 720, 410);
      } else {
        ctx.font = 'bold 62px Arial';
        ctx.fillText('Rob Bos', 190, 175);
        ctx.fillText('Software Engineer', 190, 275);
        ctx.fillText('Xebia', 190, 375);
      }
    };
    drawBadge();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const stream = canvas.captureStream(10);
        setTimeout(drawBadge, 100);
        return stream;
      },
    });
  }, { stacked, tight });
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
  await expect(page.locator('#qr-status')).toContainText(stacked ? 'Hi Fokko Veegens!' : 'Hi Rob Bos!', { timeout: 60000 });
  const expected = stacked
    ? ['Fokko', 'Veegens', '@FokkoVeegens', 'DevOps Consultant', 'Xebia']
    : ['Rob', 'Bos', '', 'Software Engineer', 'Xebia'];
  for (const [index, value] of expected.entries()) {
    await expect(page.getByRole('textbox', { name: `Data item ${index + 1}`, exact: true })).toHaveValue(value);
  }
  await expect(page.locator('#qr-status')).toContainText('Display cleared to black.', { timeout: 30000 });
  await expect(page.locator('#qr-status')).toHaveAttribute('role', 'status');
  await expect(scan).toBeEnabled();
});
}
