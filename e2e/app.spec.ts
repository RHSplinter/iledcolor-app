import { expect, test } from '@playwright/test';

test('mock hat: connect, preview, send, preset, offline relaunch', async ({ page, context }) => {
  const external: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://localhost:4173')) external.push(r.url()); });

  await page.goto('/#mock');
  await expect(page.locator('#offline')).toHaveText('Ready for offline use', { timeout: 20_000 });

  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');

  await page.click('nav [data-tab=connect]');
  await page.fill('#c-str', 'Hi');
  await expect(page.locator('#btn-send')).toBeEnabled();
  await page.click('#btn-send');
  await expect(page.locator('#send-note')).toHaveText('Upload confirmed.');

  await page.fill('#c-name', 'Greeting');
  await page.click('#btn-save');
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('ul.list li').first()).toContainText('Greeting');

  // Offline relaunch: cached shell loads and presets are still editable.
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#status')).toBeVisible();
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('ul.list li').first()).toContainText('Greeting');
  await page.click('nav [data-tab=connect]');
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');

  expect(external).toEqual([]); // privacy: no off-origin requests
});

test('rejects a corrupt preset import visibly', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('nav [data-tab=settings]');
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

  await page.click('nav [data-tab=settings]');
  const item = page.locator('ul.list li', { hasText: 'Bavarian' });
  await expect(item).toContainText('group content');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const json = JSON.parse(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf-8'));
  expect(json.approach.presets.find((p: { name: string }) => p.name === 'Bavarian').groups.pair.text).toBe('Servus {other}!');
  expect(json.approach.groups.pair.text).toBe('Something else');

  await item.locator('[data-act=load]').click();
  await expect(page.locator('#view-approach')).toBeVisible();
  await expect(pairText).toHaveValue('Servus {other}!');

  // Import restores group presets too.
  await page.click('nav [data-tab=settings]');
  await item.locator('[data-act=del]').click();
  await expect(page.locator('ul.list li', { hasText: 'Bavarian' })).toHaveCount(0);
  await page.setInputFiles('#p-import', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  await expect(page.locator('#p-msg')).toContainText('Imported');
  await expect(page.locator('ul.list li', { hasText: 'Bavarian' })).toContainText('group content');
});

test('share categories: scan-only file excludes creations and approach content, import preserves them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#mock');
  await page.click('nav [data-tab=connect]');
  await page.fill('#c-name', 'Keep this creation');
  await page.click('#btn-save');
  await page.click('nav [data-tab=approach]');
  await page.locator('[data-tier=pair][data-field=text]').fill('Keep my greeting');
  await page.locator('[data-tier=pair][data-field=text]').dispatchEvent('change');
  await page.fill('#ap-enter', '-65');
  await page.locator('#ap-enter').dispatchEvent('change');
  await page.fill('#ap-preset-name', 'Keep this group');
  await page.click('#ap-preset-save');
  await page.click('nav [data-tab=settings]');
  await page.getByLabel('Creations', { exact: false }).uncheck();
  await page.getByLabel('Approach settings', { exact: false }).uncheck();
  await page.getByLabel('Scan settings', { exact: false }).uncheck();
  await expect(page.getByRole('button', { name: 'Share presets' })).toBeDisabled();
  await page.getByLabel('Scan settings', { exact: false }).check();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const json = JSON.parse(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf-8'));
  expect(Object.keys(json).sort()).toEqual(['app', 'qrProfiles', 'scan', 'version']);
  expect(json.scan.enterDbm).toBe(-65);
  json.scan.enterDbm = -60;
  await page.setInputFiles('#p-import', { name: 'scan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await expect(page.locator('ul.list li', { hasText: 'Keep this creation' })).toHaveCount(1);
  await expect(page.locator('ul.list li', { hasText: 'Keep this group' })).toHaveCount(1);
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-enter')).toHaveValue('-60');
  await expect(page.locator('[data-tier=pair][data-field=text]')).toHaveValue('Keep my greeting');
  await page.reload();
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-enter')).toHaveValue('-60');
  await expect(page.locator('[data-tier=pair][data-field=text]')).toHaveValue('Keep my greeting');
});

test('solo uses Connect content, restores it after approaching, and remembers the choice', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('#btn-connect');
  await page.click('nav [data-tab=connect]');
  await page.selectOption('#c-kind', 'solid');
  await page.locator('#c-fg').fill('#ff0000');
  await page.click('nav [data-tab=approach]');
  await page.check('#ap-solo-create');
  await expect(page.locator('[data-tier=solo][data-field=text]')).toBeHidden();
  await page.fill('#ap-settle', '0');
  await page.locator('#ap-settle').dispatchEvent('change');
  await page.check('#ap-start');
  await expect(page.locator('#ap-caps .cap-note')).toHaveText('Connect tab content', { timeout: 15000 });
  const pixel = () => page.locator('#ap-caps canvas').evaluate((cv: HTMLCanvasElement) =>
    Array.from(cv.getContext('2d')!.getImageData(1, 1, 1, 1).data).slice(0, 3));
  await expect.poll(pixel).toEqual([255, 0, 0]);
  await page.click('#ap-sim-peer');
  await expect(page.locator('#ap-caps .cap-note')).toContainText('Hi ', { timeout: 15000 });
  await page.locator('#ap-peers [data-act=rssi]').fill('-100');
  await expect(page.locator('#ap-caps .cap-note')).toHaveText('Connect tab content', { timeout: 15000 });
  await expect.poll(pixel).toEqual([255, 0, 0]);
  await page.click('nav [data-tab=connect]');
  await page.locator('#c-fg').fill('#00ff00');
  await page.click('nav [data-tab=approach]');
  await expect.poll(pixel, { timeout: 15000 }).toEqual([0, 255, 0]);
  await page.locator('#ap-peers [data-act=rssi]').fill('-50');
  await expect(page.locator('#ap-caps .cap-note')).toContainText('Hi ', { timeout: 15000 });
  await page.uncheck('#ap-start');
  await expect(page.locator('#ap-caps .cap-note')).toHaveText('Connect tab content', { timeout: 15000 });
  await expect.poll(pixel).toEqual([0, 255, 0]);
  await page.reload();
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-solo-create')).toBeChecked();
  await page.click('nav [data-tab=connect]');
  await expect(page.locator('#c-kind')).toHaveValue('solid');
  await expect(page.locator('#c-fg')).toHaveValue('#00ff00');
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

test('approach calibration and walk record/replay (mock)', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('nav button[data-tab=approach]');
  await page.click('#ap-add');
  await page.click('#ap-sim-peer');
  await page.click('#ap-start');
  await expect(page.locator('#ap-cal-src')).toContainText('(phone)', { timeout: 15_000 });
  await page.click('#ap-rec');
  await page.click('#ap-mark-together');
  await page.click('#ap-cal-together');
  await expect(page.locator('#ap-cal-msg')).toContainText('Together: median', { timeout: 10_000 });
  await page.click('#ap-mark-apart');
  await page.locator('#ap-peers [data-act=rssi]').fill('-90');
  await page.click('#ap-cal-away');
  await expect(page.locator('#ap-cal-msg')).toContainText('Suggested: near at', { timeout: 10_000 });
  await page.click('#ap-cal-apply');
  await expect(page.locator('#ap-enter')).not.toHaveValue('-70');
  await expect(page.locator('#ap-log')).toContainText('calibrated');
  await page.click('#ap-rec');
  await expect(page.locator('#ap-trace-msg')).toContainText('Recorded');
  await page.click('#ap-replay');
  await expect(page.locator('#ap-replay-out')).toContainText('Current settings');
  await expect(page.locator('#ap-replay-out')).toContainText('join after "Together"');
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
  await expect(page.locator('#view-approach .card').first().evaluate((card) => {
    const toggle = card.querySelector('#ap-start')!;
    const heading = card.querySelector('h2')!;
    return (toggle.compareDocumentPosition(heading) & 4) !== 0;
  })).resolves.toBe(true);
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

test('nearby cap texts: compare two phones and adopt the other text', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('#btn-connect');
  await page.click('nav [data-tab=approach]');
  await page.selectOption('[data-tier=pair][data-field=mode]', 'span');
  await page.locator('[data-tier=pair][data-field=text]').fill('LOCAL');
  await page.locator('[data-tier=pair][data-field=text]').dispatchEvent('change');
  await page.fill('#ap-settle', '0');
  await page.locator('#ap-settle').dispatchEvent('change');
  await page.check('#ap-start');
  await page.click('#ap-sim-peer');
  await expect(page.locator('#ap-texts li[data-text-key]')).toHaveCount(2);
  const peerText = page.locator('#ap-peers [data-act=text]');
  await expect(peerText).toHaveValue('LOCAL');
  await peerText.fill('<REMOTE> & 👋');
  await peerText.dispatchEvent('change');
  await expect(page.locator('#ap-texts')).toContainText('<REMOTE> & 👋');
  await expect(page.locator('#ap-text-choice')).toContainText('choose a text manually');
  await page.locator('#ap-texts [data-use-text]').click();
  await expect(page.locator('[data-tier=pair][data-field=text]')).toHaveValue('<REMOTE> & 👋');
  await expect(page.locator('#ap-texts [data-use-text]')).toBeDisabled();
  await page.reload();
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('[data-tier=pair][data-field=text]')).toHaveValue('<REMOTE> & 👋');
});

test('nearby cap texts: automatic most-common selection is marked, ties preserve the saved text', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#mock');
  await page.click('#btn-connect');
  await page.click('nav [data-tab=approach]');
  await page.fill('#ap-settle', '0');
  await page.locator('#ap-settle').dispatchEvent('change');
  await page.check('#ap-start');
  await page.click('#ap-sim-peer');
  await page.click('#ap-sim-peer');
  await expect(page.locator('#ap-texts li[data-text-key]')).toHaveCount(3);
  await expect(page.locator('#ap-peers [data-act=text]').first()).toHaveValue('{count} caps together!');
  const ownText = page.locator('[data-tier=upTo4][data-field=text]');
  await ownText.fill('MINE');
  await ownText.dispatchEvent('change');
  await expect(page.locator('#ap-text-choice')).toContainText('used automatically (2/3 caps)');
  await expect(page.locator('#ap-texts .text-choice-label')).toHaveCount(2);
  await expect(ownText).toHaveValue('MINE');
  await expect(page.locator('#ap-caps .cap-note')).toContainText('3 caps together!', { timeout: 20000 });
  const peerText = page.locator('#ap-peers [data-act=text]').first();
  await peerText.fill('THIRD');
  await peerText.dispatchEvent('change');
  await expect(page.locator('#ap-text-choice')).toContainText('tied texts');
  await expect(page.locator('#ap-texts .text-choice-label')).toHaveCount(0);
  await expect(page.locator('#ap-caps .cap-note')).toContainText('"MINE"', { timeout: 20000 });
  await expect(ownText).toHaveValue('MINE');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
