import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('GitHub graph previews, uploads, persists and round-trips through Creations backup', async ({ page }) => {
  await page.addInitScript(() => {
    const renderedText: string[] = [];
    Object.assign(window, { renderedText });
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      renderedText.push(args[0]);
      return original.apply(this, args);
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  let requests = 0;
  await page.route('https://github-contributions-api.jogruber.de/**', async (route) => {
    requests++;
    const now = new Date();
    await route.fulfill({ json: { contributions: [{ date: now.toISOString().slice(0, 10), count: 4, level: 4 }] } });
  });
  await page.goto('/#mock');
  await page.fill('#github-handle', 'octocat');
  await page.click('#github-load');
  await expect(page.locator('#github-status')).toContainText('Graph ready for octocat');
  await expect(page.locator('#github-preview')).toBeVisible();
  const caption = await page.evaluate(() => {
    const rendered = window as Window & { renderedText: string[] };
    return rendered.renderedText.filter((text) => text === '2026 contributions by octocat: ' || text === '\u{1f389}');
  });
  expect(caption).toEqual(['2026 contributions by octocat: ', '\u{1f389}', '\u{1f389}']);
  await expect.poll(() => page.locator('#github-preview').evaluate((canvas: HTMLCanvasElement) =>
    [...canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data].some((v, i) => i % 4 !== 3 && v > 0))).toBe(true);
  await expect(page.locator('#github-send')).toBeDisabled();
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('#github-send');
  await expect(page.locator('#github-status')).toContainText('octocat is scrolling on the hat');
  await expect(page.locator('#c-str')).toHaveValue('HI');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.click('nav [data-tab=settings]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const path = await download.path();
  if (!path) throw new Error('Missing backup download');
  const backup = JSON.parse(await readFile(path, 'utf8'));
  expect(backup.github).toEqual({ handle: 'octocat', prefix: '2026 contributions by {handle}: ', postfix: '\u{1f389}\u{1f389}' });
  expect(backup).not.toHaveProperty('contributions');
  backup.github.handle = 'FokkoVeegens';
  await page.setInputFiles('#p-import', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#github-handle')).toHaveValue('FokkoVeegens');
  await expect(page.locator('#github-preview')).toBeHidden();
  await expect(page.locator('#github-send')).toBeDisabled();
  expect(requests).toBe(1);
  await page.reload();
  await expect(page.locator('#github-handle')).toHaveValue('FokkoVeegens');
  expect(requests).toBe(1);

  await page.click('nav [data-tab=settings]');
  await page.setInputFiles('#p-import', { name: 'older.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ app: 'iledcolor-app', version: 2, creations: [] })) });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#github-handle')).toHaveValue('FokkoVeegens');
});

test('long handles and coloured emoji fit the animation upload limit in either orientation', async ({ page }) => {
  const handle = 'abcdefghijklmnopqrstuvwxy0123456789-abc';
  expect(handle.length).toBe(39);
  await page.route('https://github-contributions-api.jogruber.de/**', async (route) => {
    const today = new Date();
    const contributions = Array.from({ length: 367 }, (_, i) => ({
      date: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 366 + i)).toISOString().slice(0, 10),
      count: i % 5, level: i % 5,
    }));
    await route.fulfill({ json: { contributions } });
  });
  await page.goto('/#mock');
  await page.fill('#github-handle', handle);
  await page.click('#github-load');
  await expect(page.locator('#github-status')).toContainText(`Graph ready for ${handle}`);
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');
  for (const rotation of ['0', '90']) {
    await page.click('nav [data-tab=settings]');
    await page.selectOption('#s-rot', rotation);
    await page.click('nav [data-tab=connect]');
    await page.click('#github-send');
    await expect(page.locator('#github-status')).toContainText(`${handle} is scrolling on the hat`, { timeout: 15000 });
  }
});

test('invalid handles and failed requests cannot send a stale graph; excluded category is preserved', async ({ page }) => {
  let requests = 0;
  await page.route('https://github-contributions-api.jogruber.de/**', async (route) => {
    requests++;
    await route.fulfill({ status: 404, json: { error: 'Not Found' } });
  });
  await page.goto('/#mock');
  await page.fill('#github-handle', '@bad');
  await page.click('#github-load');
  await expect(page.locator('#github-status')).toContainText('valid GitHub handle');
  expect(requests).toBe(0);
  await page.fill('#github-handle', 'missing-user');
  await page.click('#github-load');
  await expect(page.locator('#github-status')).toContainText('not found');
  await expect(page.locator('#github-send')).toBeDisabled();
  await expect(page.locator('#github-preview')).toBeHidden();
  await page.click('nav [data-tab=settings]');
  await page.uncheck('#p-include-creations');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const path = await download.path();
  if (!path) throw new Error('Missing backup download');
  const backup = JSON.parse(await readFile(path, 'utf8'));
  expect(backup).not.toHaveProperty('github');
  await page.setInputFiles('#p-import', { name: 'excluded.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#github-handle')).toHaveValue('missing-user');
});

test('editable captions refresh without fetching, persist, and preserve fields absent from older imports', async ({ page }) => {
  await page.addInitScript(() => {
    const renderedText: string[] = [];
    Object.assign(window, { renderedText });
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      renderedText.push(args[0]);
      return original.apply(this, args);
    };
  });
  let requests = 0;
  await page.route('https://github-contributions-api.jogruber.de/**', async (route) => {
    requests++;
    await route.fulfill({ json: { contributions: [{ date: new Date().toISOString().slice(0, 10), count: 1, level: 1 }] } });
  });
  await page.goto('/#mock');
  await expect(page.locator('#github-prefix')).toHaveValue('2026 contributions by {handle}: ');
  await expect(page.locator('#github-postfix')).toHaveValue('\u{1f389}\u{1f389}');
  await page.fill('#github-handle', '@invalid');
  await page.fill('#github-prefix', 'Hello {handle}: ');
  await expect(page.locator('#github-status')).toContainText('valid GitHub handle');
  await page.fill('#github-handle', 'octocat');
  await page.click('#github-load');
  await expect(page.locator('#github-status')).toContainText('Graph ready');
  await page.fill('#github-prefix', 'Hello {handle}: ');
  await page.fill('#github-postfix', ' Bye {handle} \u{1f389}');
  await expect(page.locator('#github-preview')).toBeVisible();
  const text = await page.evaluate(() => (window as Window & { renderedText: string[] }).renderedText);
  expect(text).toContain('Hello octocat: ');
  expect(text).toContain(' Bye octocat ');
  expect(requests).toBe(1);
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('#github-send');
  await expect(page.locator('#github-status')).toContainText('is scrolling on the hat');
  await page.fill('#github-postfix', '\u00e9');
  await expect(page.locator('#github-status')).toContainText('printable ASCII text and emoji');
  await expect(page.locator('#github-send')).toBeDisabled();
  await expect(page.locator('#github-preview')).toBeHidden();
  await page.fill('#github-postfix', ' Bye {handle} \u{1f389}');
  await expect(page.locator('#github-preview')).toBeVisible();
  await expect(page.locator('#github-send')).toBeEnabled();
  expect(requests).toBe(1);

  await page.click('nav [data-tab=settings]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const path = await download.path();
  if (!path) throw new Error('Missing backup download');
  const backup = JSON.parse(await readFile(path, 'utf8'));
  expect(backup.github).toEqual({ handle: 'octocat', prefix: 'Hello {handle}: ', postfix: ' Bye {handle} \u{1f389}' });

  await page.click('nav [data-tab=connect]');
  await page.fill('#github-prefix', 'Changed');
  await page.fill('#github-postfix', '');
  await page.click('nav [data-tab=settings]');
  await page.setInputFiles('#p-import', { name: 'captions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#github-prefix')).toHaveValue('Hello {handle}: ');
  await expect(page.locator('#github-postfix')).toHaveValue(' Bye {handle} \u{1f389}');
  await expect(page.locator('#github-preview')).toBeHidden();
  expect(requests).toBe(1);
  await page.reload();
  await expect(page.locator('#github-prefix')).toHaveValue('Hello {handle}: ');
  await expect(page.locator('#github-postfix')).toHaveValue(' Bye {handle} \u{1f389}');

  await page.click('nav [data-tab=settings]');
  await page.setInputFiles('#p-import', { name: 'older.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    app: 'iledcolor-app', version: 2, creations: [], github: { handle: 'new-user' },
  })) });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await page.reload();
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#github-handle')).toHaveValue('new-user');
  await expect(page.locator('#github-prefix')).toHaveValue('Hello {handle}: ');
  await expect(page.locator('#github-postfix')).toHaveValue(' Bye {handle} \u{1f389}');

  await page.click('nav [data-tab=settings]');
  await page.setInputFiles('#p-import', { name: 'partial.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    app: 'iledcolor-app', version: 2, creations: [], github: { handle: 'new-user', prefix: '' },
  })) });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await page.reload();
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#github-prefix')).toHaveValue('');
  await expect(page.locator('#github-postfix')).toHaveValue(' Bye {handle} \u{1f389}');

  await page.click('nav [data-tab=settings]');
  backup.github = { handle: 'bad-change', prefix: 'Not applied', postfix: null };
  await page.setInputFiles('#p-import', { name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator('#p-msg')).toContainText('Import failed: GitHub postfix');
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#github-handle')).toHaveValue('new-user');
  await expect(page.locator('#github-prefix')).toHaveValue('');
  await expect(page.locator('#github-postfix')).toHaveValue(' Bye {handle} \u{1f389}');
  expect(requests).toBe(1);
});
