import { expect, test } from '@playwright/test';

test('mock hat: connect, preview, send, preset, offline relaunch', async ({ page, context }) => {
  const external: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://localhost:4173')) external.push(r.url()); });

  await page.goto('/#mock');
  await expect(page.locator('#offline')).toHaveText('Ready for offline use', { timeout: 20_000 });

  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');

  await page.click('nav [data-tab=create]');
  await page.fill('#c-str', 'Hi');
  await expect(page.locator('#btn-send')).toBeEnabled();
  await page.click('#btn-send');
  await expect(page.locator('#send-note')).toHaveText('Upload confirmed.');

  await page.fill('#c-name', 'Greeting');
  await page.click('#btn-save');
  await page.click('nav [data-tab=presets]');
  await expect(page.locator('ul.list li').first()).toContainText('Greeting');

  // Offline relaunch: cached shell loads and presets are still editable.
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#status')).toBeVisible();
  await page.click('nav [data-tab=presets]');
  await expect(page.locator('ul.list li').first()).toContainText('Greeting');
  await page.click('nav [data-tab=connect]');
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');

  expect(external).toEqual([]); // privacy: no off-origin requests
});

test('rejects a corrupt preset import visibly', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('nav [data-tab=presets]');
  await page.setInputFiles('#p-import', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{nope') });
  await expect(page.locator('#p-msg')).toContainText('Import failed');
});
