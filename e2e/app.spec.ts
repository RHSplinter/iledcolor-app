import { expect, test } from '@playwright/test';
import { openBackup, openCustomSection, connectHat, waitForServiceWorker } from './hat';

test('mock hat: connect, preview, send, preset, offline relaunch', async ({ page, context }) => {
  const external: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://localhost:4173')) external.push(r.url()); });

  await page.goto('/#mock');
  await connectHat(page);
  await waitForServiceWorker(page);


  await page.click('nav [data-tab=custom]');
  await openCustomSection(page, 'text');
  await page.fill('#c-str', 'Hi');
  await expect(page.locator('#btn-send')).toBeEnabled();
  await page.click('#btn-send');
  await expect(page.locator('#send-note')).toHaveText('Upload confirmed.');

  await openCustomSection(page, 'text');
  await page.click('#c-save-start');
  await page.fill('#c-name', 'Greeting');
  await page.locator('#c-save-form').getByRole('button', { name: 'Save preset' }).click();
  await page.click('nav [data-tab=presets]');
  await expect(page.locator('.preset-list:not(#builtin-presets) li')).toContainText('Greeting');

  // Offline relaunch: cached shell loads and presets are still editable.
  await context.setOffline(true);
  await page.reload();
  await connectHat(page);
  await expect(page.locator('#status')).toBeVisible();
  await page.click('nav [data-tab=presets]');
  await expect(page.locator('.preset-list:not(#builtin-presets) li')).toContainText('Greeting');
  await page.click('nav [data-tab=custom]');

  expect(external).toEqual([]); // privacy: no off-origin requests
});

test('rejects a corrupt preset import visibly', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await openBackup(page);
  await page.setInputFiles('#p-import', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{nope') });
  await expect(page.locator('#p-msg')).toContainText('Import failed');
});

test('group content presets: save, export, load', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
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
  await expect(item.getByRole('img', { name: 'Group content' })).toBeVisible();
  await openBackup(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const json = JSON.parse(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf-8'));
  expect(json.approach.presets.find((p: { name: string }) => p.name === 'Bavarian').groups.pair.text).toBe('Servus {other}!');
  expect(json.approach.groups.pair.text).toBe('Something else');

  await page.click('nav [data-tab=presets]');
  await item.locator('[data-act=apply]').click();
  await expect(page.locator('#view-presets')).toBeVisible();
  await expect(page.locator('#presets-msg')).toContainText('Applied "Bavarian".');
  await expect(pairText).toHaveValue('Servus {other}!');

  // Import restores group presets too.
  await page.click('nav [data-tab=presets]');
  await item.locator('[data-act=del]').click();
  await expect(page.locator('ul.list li', { hasText: 'Bavarian' })).toHaveCount(0);
  await openBackup(page);
  await page.setInputFiles('#p-import', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  await expect(page.locator('#p-msg')).toContainText('Imported');
  await page.click('nav [data-tab=presets]');
  await expect(page.locator('ul.list li', { hasText: 'Bavarian' }).getByRole('img', { name: 'Group content' })).toHaveCount(1);
});

test('share categories: scan-only file excludes creations and approach content, import preserves them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=custom]');
  await openCustomSection(page, 'text');
  await page.click('#c-save-start');
  await page.fill('#c-name', 'Keep this creation');
  await page.locator('#c-save-form').getByRole('button', { name: 'Save preset' }).click();
  await page.click('nav [data-tab=approach]');
  await page.locator('[data-tier=pair][data-field=text]').fill('Keep my greeting');
  await page.locator('[data-tier=pair][data-field=text]').dispatchEvent('change');
  await page.fill('#ap-enter', '-65');
  await page.locator('#ap-enter').dispatchEvent('change');
  await page.fill('#ap-preset-name', 'Keep this group');
  await page.click('#ap-preset-save');
  await openBackup(page);
  await page.getByLabel('Creations', { exact: false }).uncheck();
  await page.getByLabel('Approach settings', { exact: false }).uncheck();
  await page.getByLabel('Scan settings', { exact: false }).uncheck();
  await page.locator('#p-include-settings').uncheck();
  await page.locator('#p-include-sound').uncheck();
  await expect(page.getByRole('button', { name: 'Share presets' })).toBeDisabled();
  await page.getByLabel('Scan settings', { exact: false }).check();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const json = JSON.parse(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf-8'));
  expect(Object.keys(json).sort()).toEqual(['app', 'qrGreeting', 'qrProfiles', 'qrScanLogging', 'scan', 'version']);
  expect(json.scan.enterDbm).toBe(-65);
  json.scan.enterDbm = -60;
  await page.setInputFiles('#p-import', { name: 'scan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await page.click('nav [data-tab=presets]');
  await expect(page.locator('ul.list li', { hasText: 'Keep this creation' })).toHaveCount(1);
  await expect(page.locator('ul.list li', { hasText: 'Keep this group' })).toHaveCount(1);
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-enter')).toHaveValue('-60');
  await expect(page.locator('[data-tier=pair][data-field=text]')).toHaveValue('Keep my greeting');
  await page.reload();
  await connectHat(page);
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-enter')).toHaveValue('-60');
  await expect(page.locator('[data-tier=pair][data-field=text]')).toHaveValue('Keep my greeting');
});

test('solo uses Connect content, restores it after approaching, and remembers the choice', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=custom]');
  await openCustomSection(page, 'solid');
  await page.locator('#c-solid').fill('#ff0000');
  await page.click('nav [data-tab=approach]');
  await page.check('#ap-solo-create');
  await expect(page.locator('[data-tier=solo][data-field=text]')).toBeHidden();
  await page.fill('#ap-settle', '0');
  await page.locator('#ap-settle').dispatchEvent('change');
  await page.check('#ap-start');
  await expect(page.locator('#ap-caps .cap-note')).toHaveText('Custom tab content', { timeout: 15000 });
  const pixel = () => page.locator('#ap-caps canvas').evaluate((cv: HTMLCanvasElement) =>
    Array.from(cv.getContext('2d')!.getImageData(1, 1, 1, 1).data).slice(0, 3));
  await expect.poll(pixel).toEqual([255, 0, 0]);
  await page.click('#ap-sim-peer');
  await expect(page.locator('#ap-caps .cap-note')).toContainText('Hi ', { timeout: 15000 });
  await page.locator('#ap-peers [data-act=rssi]').fill('-100');
  await expect(page.locator('#ap-caps .cap-note')).toHaveText('Custom tab content', { timeout: 15000 });
  await expect.poll(pixel).toEqual([255, 0, 0]);
  await page.click('nav [data-tab=custom]');
  await page.locator('#c-solid').fill('#00ff00');
  await page.click('nav [data-tab=approach]');
  await expect.poll(pixel, { timeout: 15000 }).toEqual([0, 255, 0]);
  await page.locator('#ap-peers [data-act=rssi]').fill('-50');
  await expect(page.locator('#ap-caps .cap-note')).toContainText('Hi ', { timeout: 15000 });
  await page.uncheck('#ap-start');
  await expect(page.locator('#ap-caps .cap-note')).toHaveText('Custom tab content', { timeout: 15000 });
  await expect.poll(pixel).toEqual([0, 255, 0]);
  await page.reload();
  await connectHat(page);
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-solo-create')).toBeChecked();
  await page.click('nav [data-tab=custom]');
  await expect(page.locator('#custom-solid')).not.toHaveAttribute('open');
  await expect(page.locator('#c-solid')).toHaveValue('#00ff00');
});

test('approach mode (mock): two caps greet each other, peers grow the group', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { feedbackVibrations: [] as number[] });
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (duration: number) => {
      (window as Window & { feedbackVibrations: number[] }).feedbackVibrations.push(duration);
      return true;
    } });
  });
  await page.goto('/#mock');
  await connectHat(page);
  await expect(page.locator('#status-approach')).toHaveText('Approach: off');
  await expect(page.locator('#status-approach')).toHaveClass('pill muted');
  await page.click('nav button[data-tab=approach]');
  await expect(page.locator('#ap-beacon')).toHaveCount(0); // P2P is the default: multi-cap settings hidden
  await page.check('input[name=ap-mode][value=hub]');
  await page.click('#ap-add'); // the connected primary cap is cap 1
  await expect(page.locator('#ap-caps li[data-key]')).toHaveCount(2);
  await page.locator('input[data-tier=solo][data-field=text]').fill('SOLO');
  await page.locator('input[data-tier=solo][data-field=text]').dispatchEvent('change');
  await page.fill('#ap-settle', '0');
  await page.locator('#ap-settle').dispatchEvent('change');
  await page.click('#ap-start');
  await expect(page.locator('#ap-status')).toContainText('2 caps', { timeout: 15_000 });
  await expect(page.locator('#status-approach')).toHaveText('Approach: on (2)');
  await expect(page.locator('#status-approach')).toHaveClass('pill ok');
  await expect(page.locator('#ap-caps')).toContainText('Hi ', { timeout: 15_000 });
  expect(await page.evaluate(() => (window as Window & { feedbackVibrations: number[] }).feedbackVibrations)).toEqual([200]);
  await page.click('#ap-sim-peer');
  await page.click('#ap-sim-peer');
  await expect(page.locator('#ap-status')).toContainText('4 caps', { timeout: 15_000 });
  await expect(page.locator('#status-approach')).toHaveText('Approach: on (4)');
  await expect(page.locator('#ap-caps')).toContainText('span', { timeout: 15_000 });
  expect(await page.evaluate(() => (window as Window & { feedbackVibrations: number[] }).feedbackVibrations)).toEqual([200, 200]);
  await page.getByRole('switch').click();
  await expect(page.getByRole('switch')).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator('#ap-status')).toContainText('Stopped');
  await expect(page.locator('#status-approach')).toHaveText('Approach: off');
  await expect(page.locator('#status-approach')).toHaveClass('pill muted');
  await expect(page.locator('#ap-caps')).not.toContainText('span');
  await expect(page.locator('#ap-caps')).not.toContainText('Hi ');
  await expect(page.locator('#ap-caps .cap-note')).toHaveText(['"SOLO"', '"SOLO"']);
  await page.waitForTimeout(2500);
  await expect(page.locator('#ap-caps')).not.toContainText('span');
});

test('keepBlack keeps cap black when idle while displaying approach, sound and scan events', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav [data-tab=settings]');
  await page.check('#s-keep-black');
  await expect(page.locator('#s-keep-black')).toBeChecked();

  await page.click('nav [data-tab=approach]');
  await page.fill('#ap-settle', '0');
  await page.locator('#ap-settle').dispatchEvent('change');
  await page.check('#ap-start');
  await expect(page.locator('#status-approach')).toHaveText('Approach: on (1)', { timeout: 15_000 });
  await expect(page.locator('#ap-caps .cap-note')).toHaveText('keep black (idle)', { timeout: 15_000 });
  const pixel = () => page.locator('#ap-caps canvas').evaluate((cv: HTMLCanvasElement) =>
    Array.from(cv.getContext('2d')!.getImageData(1, 1, 1, 1).data).slice(0, 3));
  await expect.poll(pixel).toEqual([0, 0, 0]);

  await page.click('#ap-sim-peer');
  await expect(page.locator('#status-approach')).toHaveText('Approach: on (2)', { timeout: 15_000 });
  await expect(page.locator('#ap-caps .cap-note')).toContainText('Hi ', { timeout: 15_000 });
  await page.locator('#ap-peers [data-act=rssi]').fill('-100');
  await expect(page.locator('#status-approach')).toHaveText('Approach: on (1)', { timeout: 15_000 });
  await expect(page.locator('#ap-caps .cap-note')).toHaveText('keep black (idle)', { timeout: 15_000 });
  await expect.poll(pixel).toEqual([0, 0, 0]);

  await page.click('nav [data-tab=sound]');
  await expect(page.locator('#sound-ready')).toHaveText('Primary cap ready. Other caps are not interrupted.');
  await page.click('#sound-test');
  await expect(page.locator('#sound-status')).toContainText('Playing Greeting');
  await page.click('#sound-end');
  await expect(page.locator('#sound-status')).toContainText('Previous content restored', { timeout: 15_000 });

  await page.click('nav [data-tab=scan]');
  await expect(page.locator('#qr-ready')).toHaveText('Ready to scan a badge.');
  await page.locator('#view-scan summary').click();
  await page.fill('#qr-raw', 'Ada');
  await page.click('#qr-submit');
  await expect(page.locator('#qr-status')).toContainText('Hi Ada!', { timeout: 15_000 });
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 15_000 });
  await page.click('#qr-cancel');
  await expect(page.locator('#qr-status')).toContainText('ended early. Previous content restored.', { timeout: 15_000 });

  await page.click('nav [data-tab=approach]');
  await expect(page.locator('#ap-caps .cap-note')).toHaveText('keep black (idle)');
});

test('approach calibration and walk record/replay (mock)', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav button[data-tab=approach]');
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

test('the Custom tab cap is cap 1 of approach mode', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await page.click('nav button[data-tab=approach]');
  await expect(page.locator('#ap-caps li[data-key]')).toHaveCount(1);
  await expect(page.locator('#ap-caps li[data-key]').first()).toContainText('Ready');
  await expect(page.locator('#ap-add')).toHaveCount(0);
  await page.check('input[name=ap-mode][value=hub]');
  await page.click('#ap-add');
  await expect(page.locator('#ap-caps li[data-key]')).toHaveCount(2);
  await page.click('nav [data-tab=custom]');
  await page.locator('#status-toggle').click();
  await page.locator('#btn-status-disconnect').click();
  await expect(page.locator('#status')).toHaveText('Disconnected');
  // Without the primary cap only the connection controls remain, even while another cap is connected.
  await expect(page.locator('#tab-bar')).toBeHidden();
  await expect(page.locator('#view-approach')).toBeHidden();
  await connectHat(page);
  await page.click('nav button[data-tab=approach]');
  await expect(page.locator('#ap-caps li[data-key]').first()).toContainText('Ready');
});

test('approach switch is remembered across reloads', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
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
  await connectHat(page);
  await page.click('nav button[data-tab=approach]');
  await expect(page.getByRole('switch')).toBeChecked();
  await page.getByRole('switch').click();
  await expect(page.locator('#ap-status')).toContainText('Stopped');
  await page.reload();
  await connectHat(page);
  await page.click('nav button[data-tab=approach]');
  await expect(page.getByRole('switch')).not.toBeChecked();
});

test('nearby cap texts: compare two phones and adopt the other text', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
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
  await connectHat(page);
  await page.click('nav [data-tab=approach]');
  await expect(page.locator('[data-tier=pair][data-field=text]')).toHaveValue('<REMOTE> & 👋');
});

test('nearby cap texts: automatic most-common selection is marked, ties preserve the saved text', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#mock');
  await connectHat(page);
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

test('sequence: compose, send, save, reload, add preset and back up', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  const steps = page.locator('#c-seq-list li[data-index]');
  await expect(page.locator('#c-seq-on')).toBeDisabled();

  await openCustomSection(page, 'text');
  await page.fill('#c-str', 'A');
  await openCustomSection(page, 'sequence');
  await page.click('#btn-seq-add');
  await openCustomSection(page, 'solid');
  await page.click('#btn-seq-add');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText('Text "A"');
  await expect(steps.nth(1)).toContainText('Solid #ffffff');
  await expect(page.locator('#c-seq-on')).toBeChecked();

  await page.getByLabel('Seconds for step 2').fill('5');
  await page.getByLabel('Seconds for step 2').dispatchEvent('change');
  await page.getByLabel('Move step 2 up').click();
  await expect(steps.nth(0)).toContainText('Solid');
  await expect(page.getByLabel('Seconds for step 1')).toHaveValue('5');

  await page.click('#btn-send-sequence');
  await expect(page.locator('#send-note')).toHaveText('Animation upload confirmed.');

  await page.click('#sequence-save-start');
  await page.fill('#sequence-name', 'Show');
  await page.locator('#sequence-save-form').getByRole('button', { name: 'Save preset' }).click();
  await expect(page.locator('#sequence-save-note')).toHaveText('Saved "Show".');
  await page.reload();
  await connectHat(page);
  await expect(steps).toHaveCount(2);
  await openCustomSection(page, 'sequence');
  await expect(page.locator('#c-seq-on')).toBeChecked();
  await expect(page.getByLabel('Seconds for step 1')).toHaveValue('5');

  // Adding a sequence preset appends its steps.
  await page.selectOption('#c-seq-preset', { label: 'Show' });
  await page.click('#btn-seq-add-preset');
  await expect(steps).toHaveCount(4);
  await page.getByLabel('Remove step 4').click();
  await page.getByLabel('Remove step 3').click();
  await expect(steps).toHaveCount(2);

  await page.click('nav [data-tab=presets]');
  const item = page.locator('ul.list li', { hasText: 'Show' });
  await expect(item.locator('[data-act=send]')).toHaveAttribute('title', 'Sequence (2 steps)');
  const fs = await import('node:fs/promises');
  await openBackup(page);
  const [playing] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const json = JSON.parse(await fs.readFile((await playing.path())!, 'utf-8'));
  expect(json.createContent.kind).toBe('sequence');
  expect(json.createContent.steps).toHaveLength(2);
  expect(json.createSequence).toBeUndefined();
  expect(json.creations.find((p: { name: string }) => p.name === 'Show').content.steps[0].seconds).toBe(5);

  // Pausing keeps the draft; single content is sent and the draft is backed up separately.
  await page.click('nav [data-tab=custom]');
  await page.uncheck('#c-seq-on');
  await expect(page.locator('#c-seq-help')).toContainText('paused');
  await openBackup(page);
  const [paused] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const pausedJson = JSON.parse(await fs.readFile((await paused.path())!, 'utf-8'));
  expect(pausedJson.createContent.kind).not.toBe('sequence');
  expect(pausedJson.createSequence).toHaveLength(2);

  // Importing restores the shared sequence and plays it.
  await page.setInputFiles('#p-import', { name: 's.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  await expect(page.locator('#p-msg')).toContainText('Imported');
  await page.click('nav [data-tab=custom]');
  await expect(page.locator('#c-seq-on')).toBeChecked();
  await expect(steps).toHaveCount(2);

  // Sending a sequence preset does not alter the paused editor draft.
  await page.uncheck('#c-seq-on');
  await page.click('nav [data-tab=presets]');
  await page.locator('ul.list li', { hasText: 'Show' }).locator('[data-act=send]').click();
  await expect(page.locator('#presets-msg')).toContainText('Animation upload confirmed.');
  await expect(page.locator('#view-presets')).toBeVisible();
  await expect(page.locator('#c-seq-on')).not.toBeChecked();
});
