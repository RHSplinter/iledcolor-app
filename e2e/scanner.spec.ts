import { expect, test } from '@playwright/test';
import { connectHat, waitForServiceWorker } from './hat';

test('scanner settings persist after reload without manual scan entry', async ({ page }) => {
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
  await expect(page.locator('#view-scan')).not.toContainText('Enter scan data manually');
  await expect(page.locator('#qr-raw, #qr-submit')).toHaveCount(0);
});

test('greeting settings persist without saved badge data', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=settings]');
  await page.check('#s-keep-black');
  await page.click('nav [data-tab=scan]');
  await page.fill('#qr-template', 'Welcome {name}!');
  await page.fill('#qr-repetitions', '1');
  await page.locator('#qr-speed').fill('10');
  await page.reload();
  await connectHat(page);
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-pattern')).toHaveCount(0);
  await expect(page.locator('#qr-template')).toHaveValue('Welcome {name}!');
  await expect(page.locator('#qr-raw, #qr-submit')).toHaveCount(0);
});

test('scanner has no saved badge profile controls', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-template')).toBeVisible();
  await expect(page.locator('#qr-profile, #qr-note, #qr-profile-save, #qr-profile-delete, #qr-pattern, #qr-pattern-help')).toHaveCount(0);
  await expect(page.locator('#view-scan > .card')).toHaveCount(2);
  await expect(page.locator('#qr-github-enabled')).toHaveCount(0);
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#view-settings > :last-child')).toHaveAttribute('id', 'settings-scan');
  await expect(page.locator('#settings-scan h2')).toHaveText('Scan log & privacy');
  await expect(page.locator('#view-scan')).not.toContainText('Name regex');
  await expect(page.locator('#view-scan')).not.toContainText('Enter scan data manually');
  await expect(page.locator('#qr-raw, #qr-submit')).toHaveCount(0);
});

test('scan logging is opt-in, persists, and can be disabled', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=settings]');
  await page.getByText('Test patterns (dim, static)', { exact: true }).click();
  await page.click('#btn-test-color');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#qr-log-enabled')).not.toBeChecked();
  await page.click('#qr-log-share');
  await expect(page.locator('#qr-log-error')).toContainText('Could not share scan log');
  await page.check('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toHaveText('Scan logging enabled.');
  await page.reload();
  await connectHat(page);
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#qr-log-enabled')).toBeChecked();
  await page.uncheck('#qr-log-enabled');
  await expect(page.locator('#qr-log-status')).toContainText('Existing log kept');

});

for (const layout of ['single-line name', 'stacked name with handle', 'tightly stacked name with handle', 'public email', 'no public email']) {
test(`Scan is blue and ${layout.includes('email') ? 'automatic email lookup accompanies OCR' : 'offline OCR greets a newly connected cap'} (${layout})`, async ({ page, context }) => {
  const stacked = layout !== 'single-line name';
  const tight = layout === 'tightly stacked name with handle';
  const publicEmail = layout === 'public email';
  const onlineLookup = layout.includes('email');
  test.setTimeout(90000);
  if (onlineLookup) {
    await context.route('https://api.github.com/users/*', (route) => route.fulfill({
      json: { login: 'FokkoVeegens', email: publicEmail ? 'public@example.org' : null },
    }));
  }
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
  await context.setOffline(!onlineLookup);
  await page.reload();
  const scan = page.locator('#qr-text-start');
  await expect(scan).toBeDisabled();
  await expect(page.locator('#qr-start')).toHaveCount(0);
  await expect(scan).toHaveText('Scan');
  await expect(scan).toHaveCSS('background-color', 'rgb(77, 163, 255)');
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-github-result')).toBeHidden();
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
  const email = page.getByRole('textbox', { name: 'Email address', exact: true });
  await expect(email).toHaveValue(publicEmail ? 'public@example.org' : '');
  await expect(email.locator('..').locator('..').locator('select')).toHaveCount(0);
  const firstInput = page.getByRole('textbox', { name: 'Data item 1', exact: true });
  for (const property of ['background-color', 'border-radius', 'border-top-width', 'padding', 'font-size', 'color', 'width', 'height']) {
    await expect(email).toHaveCSS(property, await firstInput.evaluate((input, key) => getComputedStyle(input).getPropertyValue(key), property));
  }
  const emailLabel = page.locator('label[for=qr-data-email]');
  const typeSelect = page.getByRole('combobox', { name: 'Data item 1 type', exact: true });
  for (const property of ['font-size', 'color', 'padding-left', 'height']) {
    await expect(emailLabel).toHaveCSS(property, await typeSelect.evaluate((select, key) => getComputedStyle(select).getPropertyValue(key), property));
  }
  expect((await emailLabel.boundingBox())!.x).toBe((await typeSelect.boundingBox())!.x);
  if (layout === 'no public email') {
    await expect(page.locator('#qr-github-result')).toHaveText('@FokkoVeegens has no public email.');
    await expect(page.locator('#qr-github-result')).toHaveCSS('border-left-width', '3px');
  }
  await email.fill('manual@example.org');
  await expect(email).toHaveValue('manual@example.org');
  await expect(page.locator('#qr-status')).toContainText('Display cleared to black.', { timeout: 30000 });
  await expect(page.locator('#qr-status')).toHaveAttribute('role', 'status');
  await expect(scan).toBeEnabled();
  await page.click('#qr-data-clear');
  await expect(page.locator('#qr-github-result')).toBeHidden();
  await expect(page.locator('#qr-github-result')).toBeEmpty();
  expect(await page.locator('#qr-github-result').boundingBox()).toBeNull();
});
}
