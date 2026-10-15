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

test('group content presets: save, export, load', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('nav button[data-tab=approach]');
  const pairText = page.locator('[data-tier=pair][data-field=text]');
  await pairText.fill('Servus {other}!');
  await pairText.dispatchEvent('change');
  await page.fill('#ap-preset-name', 'Bavarian');
  await page.click('#ap-preset-save');
  await expect(page.locator('#ap-preset-msg')).toHaveText('Saved "Bavarian".');
  await pairText.fill('Something else');
  await pairText.dispatchEvent('change');

  await page.click('nav [data-tab=presets]');
  const item = page.locator('ul.list li', { hasText: 'Bavarian' });
  await expect(item).toContainText('group content');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const json = JSON.parse(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf-8'));
  expect(json.presets.find((p: { name: string }) => p.name === 'Bavarian').groups.pair.text).toBe('Servus {other}!');

  await item.locator('[data-act=load]').click();
  await expect(page.locator('#view-approach')).toBeVisible();
  await expect(pairText).toHaveValue('Servus {other}!');

  // Import restores group presets too.
  await page.click('nav [data-tab=presets]');
  await item.locator('[data-act=del]').click();
  await expect(page.locator('ul.list li', { hasText: 'Bavarian' })).toHaveCount(0);
  await page.setInputFiles('#p-import', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  await expect(page.locator('#p-msg')).toContainText('Imported');
  await expect(page.locator('ul.list li', { hasText: 'Bavarian' })).toContainText('group content');
});

test('approach mode (mock): two caps greet each other, peers grow the group', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('nav button[data-tab=approach]');
  await expect(page.locator('#ap-beacon')).toHaveCount(0); // P2P is the default: multi-cap settings hidden
  await page.check('input[name=ap-mode][value=hub]');
  await page.click('#ap-add');
  await page.click('#ap-add');
  await expect(page.locator('#ap-caps li[data-key]')).toHaveCount(2);
  await page.locator('input[data-tier=solo][data-field=text]').fill('SOLO');
  await page.locator('input[data-tier=solo][data-field=text]').dispatchEvent('change');
  await page.fill('#ap-settle', '0');
  await page.locator('#ap-settle').dispatchEvent('change');
  await page.click('#ap-start');
  await expect(page.locator('#ap-status')).toContainText('2 caps', { timeout: 15_000 });
  await expect(page.locator('#ap-caps')).toContainText('Hi ', { timeout: 15_000 });
  await page.click('#ap-sim-peer');
  await page.click('#ap-sim-peer');
  await expect(page.locator('#ap-status')).toContainText('4 caps', { timeout: 15_000 });
  await expect(page.locator('#ap-caps')).toContainText('span', { timeout: 15_000 });
  await page.getByRole('switch').click();
  await expect(page.getByRole('switch')).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator('#ap-status')).toContainText('Stopped');
  await expect(page.locator('#ap-caps')).not.toContainText('span');
  await expect(page.locator('#ap-caps')).not.toContainText('Hi ');
  await expect(page.locator('#ap-caps .cap-note')).toHaveText(['"SOLO"', '"SOLO"']);
  await page.waitForTimeout(2500);
  await expect(page.locator('#ap-caps')).not.toContainText('span');
});

test('the Connect tab cap is cap 1 of approach mode', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('nav button[data-tab=approach]');
  await expect(page.locator('#ap-caps li[data-key]')).toHaveCount(1);
  await expect(page.locator('#ap-caps li[data-key]').first()).toContainText('Ready');
  await expect(page.locator('#ap-add')).toHaveCount(0);
  await page.check('input[name=ap-mode][value=hub]');
  await page.click('#ap-add');
  await expect(page.locator('#ap-caps li[data-key]')).toHaveCount(2);
  await page.click('nav [data-tab=connect]');
  await page.click('#btn-disconnect');
  await expect(page.locator('#status')).toHaveText('Disconnected');
  await page.click('nav button[data-tab=approach]');
  await expect(page.locator('#ap-caps li[data-key]').first()).toContainText('Disconnected');
  await expect(page.locator('#ap-caps li[data-key]').nth(1)).toContainText('Ready');
  await page.locator('#ap-caps li[data-key]').first().locator('[data-act=connect]').click();
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#status')).toContainText('Ready');
});

test('approach switch is remembered across reloads', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('nav button[data-tab=approach]');
  const sw = page.getByRole('switch');
  await expect(sw).not.toBeChecked();
  await sw.click();
  await expect(sw).toBeChecked();
  await expect(page.locator('#ap-status')).toContainText('Group');
  await page.reload();
  await page.click('nav button[data-tab=approach]');
  await expect(page.getByRole('switch')).toBeChecked();
  await page.getByRole('switch').click();
  await expect(page.locator('#ap-status')).toContainText('Stopped');
  await page.reload();
  await page.click('nav button[data-tab=approach]');
  await expect(page.getByRole('switch')).not.toBeChecked();
});
