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
  await expect(page.locator('#view-scan > .card:visible')).toHaveCount(2);
  await expect(page.locator('#qr-github-enabled')).toHaveCount(0);
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#view-settings > :last-child')).toHaveAttribute('id', 'settings-scan');
  await expect(page.locator('#settings-scan h2')).toHaveText(['Save scans as GitHub issues', 'Scan log & privacy']);
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

test('scan-only navigation stops the camera, returns home and preserves greetings and the shared assignee across reload', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const stream = canvas.captureStream(10);
        Object.assign(window, { scanStream: stream });
        return stream;
      },
    });
  });
  await page.goto('/#mock');
  await connectHat(page);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.fill('#qr-issue-assignee', 'booth-staff');
  await page.locator('#qr-issue-assignee').blur();
  await page.getByRole('tab', { name: 'Scan', exact: true }).click();
  await expect(page.locator('#qr-issue-assignee')).toBeHidden();
  await expect(page.locator('#view-scan #qr-issue-assignee')).toHaveCount(0);
  await page.fill('#qr-template', 'Welcome {firstname}!');
  await page.locator('#qr-template').blur();
  await page.reload();
  await page.getByRole('button', { name: 'Scan without hat', exact: true }).click();
  await expect(page.locator('#view-scan')).toBeVisible();
  await expect(page.locator('#tab-bar')).toBeHidden();
  await expect(page.locator('header')).toBeHidden();
  await expect(page.locator('#qr-greeting-settings')).toBeHidden();
  await expect(page.locator('#qr-template')).toHaveValue('Welcome {firstname}!');
  await expect(page.locator('#view-scan #qr-issue-assignee')).toBeVisible();
  const scanBox = (await page.locator('#qr-text-start').boundingBox())!;
  const statusBox = (await page.locator('#qr-status').boundingBox())!;
  const assigneeBox = (await page.locator('#qr-issue-assignee').boundingBox())!;
  expect(scanBox.y).toBeLessThan(statusBox.y);
  expect(statusBox.y).toBeLessThan(assigneeBox.y);
  const scannerCard = (await page.locator('#view-scan > .card').first().boundingBox())!;
  const assigneeCard = (await page.locator('#view-scan > #qr-scan-assignee.card').boundingBox())!;
  expect(assigneeCard.y - scannerCard.y - scannerCard.height).toBeGreaterThanOrEqual(24);
  await expect(page.locator('#qr-issue-assignee')).toHaveValue('booth-staff');
  await page.fill('#qr-issue-assignee', '@octocat');
  await page.locator('#qr-issue-assignee').blur();
  await expect(page.locator('#qr-issue-assignee')).toHaveValue('octocat');
  await page.click('#qr-text-start');
  await expect(page.locator('#qr-video-wrap')).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { scanStream?: MediaStream }).scanStream);
  await page.getByRole('button', { name: 'Return home', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { scanStream: MediaStream }).scanStream.getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#connection-card')).toBeVisible();
  await expect(page.locator('#view-scan')).toBeHidden();
  await expect(page.locator('#tab-bar')).toBeHidden();
  await expect(page.locator('#btn-scan-only')).toBeFocused();
  await connectHat(page);
  await page.getByRole('tab', { name: 'Scan', exact: true }).click();
  await expect(page.locator('#qr-greeting-settings')).toBeVisible();
  await expect(page.locator('#qr-template')).toHaveValue('Welcome {firstname}!');
  await expect(page.locator('#qr-text-start')).toBeEnabled();
  await expect(page.locator('#view-scan #qr-issue-assignee')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#settings-scan #qr-issue-assignee')).toBeVisible();
  await expect(page.locator('#qr-issue-assignee')).toHaveValue('octocat');
  await page.reload();
  await page.click('#btn-scan-only');
  await expect(page.locator('#view-scan #qr-issue-assignee')).toHaveValue('octocat');
  await page.reload();
  await expect(page.locator('#connection-card')).toBeVisible();
  await expect(page.locator('#scan-only-actions')).toBeHidden();
});

for (const layout of ['single-line name', 'stacked name with handle', 'tightly stacked name with handle', 'public email', 'no public email', 'scan without hat']) {
test(`Scan is blue and ${layout.includes('email') ? 'automatic email lookup accompanies OCR' : 'offline OCR greets a newly connected cap'} (${layout})`, async ({ page, context }) => {
  const scanOnly = layout === 'scan without hat';
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
  await page.goto(scanOnly ? '/' : '/#mock');
  await waitForServiceWorker(page);
  await context.setOffline(!onlineLookup);
  await page.reload();
  const scan = page.locator('#qr-text-start');
  await expect(scan).toBeDisabled();
  await expect(page.locator('#qr-start')).toHaveCount(0);
  await expect(scan).toHaveText('Scan');
  await expect(scan).toHaveCSS('background-color', 'rgb(77, 163, 255)');
  if (scanOnly) {
    await page.click('#btn-scan-only');
    await page.fill('#qr-issue-assignee', 'booth-staff');
    await page.locator('#qr-issue-assignee').blur();
    await expect(page.locator('#tab-bar')).toBeHidden();
    await expect(page.locator('#qr-greeting-settings')).toBeHidden();
    await expect(page.locator('#status-label')).not.toContainText('Ready');
  } else {
    await page.click('#btn-connect');
    await expect(page.locator('#status')).toContainText('Ready');
    await page.click('nav [data-tab=scan]');
  }
  await expect(page.locator('#qr-github-result')).toBeHidden();
  await expect(scan).toBeEnabled();
  await scan.click();
  await expect(page.locator('#qr-ocr-controls')).toBeVisible();
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#qr-video');
    return !!video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
  });
  await page.click('#qr-capture');
  await expect(page.locator('#qr-status')).toContainText(scanOnly ? 'Badge scanned.' : stacked ? 'Hi Fokko Veegens!' : 'Hi Rob Bos!', { timeout: 60000 });
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
  const phone = page.getByRole('textbox', { name: 'Phone number', exact: true });
  await expect(phone).toHaveValue('');
  await expect(phone).toHaveAttribute('type', 'tel');
  for (const property of ['background-color', 'border-radius', 'padding', 'width', 'height']) {
    await expect(phone).toHaveCSS(property, await firstInput.evaluate((input, key) => getComputedStyle(input).getPropertyValue(key), property));
  }
  const linkedin = page.getByRole('textbox', { name: 'LinkedIn handle', exact: true });
  await expect(linkedin).toHaveAttribute('type', 'text');
  for (const property of ['background-color', 'border-radius', 'padding', 'width', 'height']) {
    await expect(linkedin).toHaveCSS(property, await firstInput.evaluate((input, key) => getComputedStyle(input).getPropertyValue(key), property));
  }
  const save = page.locator('#qr-data-save');
  await email.fill('not-an-email');
  await expect(save).toBeEnabled();
  await phone.focus();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveCSS('border-top-color', 'rgb(255, 90, 90)');
  await expect(save).toBeDisabled();
  await email.fill('manual@example.org');
  await expect(email).not.toHaveAttribute('aria-invalid');
  await expect(save).toBeEnabled();
  await expect(email).toHaveValue('manual@example.org');
  await expect(page.locator('#qr-status')).toContainText(scanOnly ? 'Badge scanned.' : 'Display cleared to black.', { timeout: 30000 });
  await expect(page.locator('#qr-status')).toHaveAttribute('role', 'status');
  await expect(scan).toBeEnabled();
  const note = page.locator('#qr-issue-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('signed in to GitHub with access to the xebia organization');
  expect((await note.boundingBox())!.y).toBeGreaterThan((await save.boundingBox())!.y);
  await page.evaluate(() => {
    const opened: unknown[][] = [];
    (window as unknown as { opened: unknown[][] }).opened = opened;
    window.open = (...args: unknown[]) => { opened.push(args); return {} as Window; };
  });
  await save.click();
  const [href, target] = await page.evaluate(() => (window as unknown as { opened: string[][] }).opened[0]!);
  expect(target).toBe('_blank');
  const issueUrl = new URL(href!);
  expect(issueUrl.origin + issueUrl.pathname).toBe('https://github.com/xebia/badge-scanner/issues/new');
  expect(issueUrl.searchParams.get('title')).toBe(stacked ? 'Badge scan: Fokko Veegens' : 'Badge scan: Rob Bos');
  expect(issueUrl.searchParams.get('labels')).toBe('GitHubUniverse');
  if (scanOnly) expect(issueUrl.searchParams.get('assignees')).toBe('booth-staff');
  const body = issueUrl.searchParams.get('body')!;
  expect(body).toContain('## Badge details');
  expect(body).toContain('| Email address | manual@example.org |');
  expect(body).toContain(stacked ? '| GitHub Handle | [@FokkoVeegens](https://github.com/FokkoVeegens) |' : '| Company | Xebia |');
  expect(body).toMatch(/\n---\n\nScanned via OCR on: \d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}$/);
  await expect(page.locator('#qr-status')).toContainText('Opened a pre-filled GitHub issue');
  await page.click('#qr-data-clear');
  await expect(page.locator('#qr-github-result')).toBeHidden();
  await expect(page.locator('#qr-github-result')).toBeEmpty();
  expect(await page.locator('#qr-github-result').boundingBox()).toBeNull();
});
}
