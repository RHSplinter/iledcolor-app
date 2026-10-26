import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { connectHat, openCustomSection } from './hat';

async function save(page: Page, section: string, name: string) {
  const root = page.locator(`#custom-${section}`);
  await root.getByRole('button', { name: 'Save as preset', exact: true }).click();
  await expect(root.getByLabel('Preset name')).toBeFocused();
  await root.getByLabel('Preset name').fill(name);
  await root.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(root.getByRole('status').filter({ hasText: `Saved "${name}".` })).toBeVisible();
  await expect(root.getByLabel('Preset name')).toBeHidden();
}

async function backup(page: Page) {
  await page.getByRole('tab', { name: 'Settings' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}

async function restore(page: Page, data: unknown) {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.setInputFiles('#p-import', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
}

test('Custom sections start collapsed and send/save their own content with keyboard and narrow layouts', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/#mock');
  await connectHat(page);
  await expect(page.getByRole('tab', { name: 'Custom', exact: true })).toHaveAttribute('aria-selected', 'true');
  const sections = page.locator('#view-custom .custom-section');
  await expect(sections.locator(':scope > summary')).toHaveText(['Text', 'Solid color', 'Image', 'GitHub Contributions', 'Sequence']);
  await expect(page.locator('#view-custom details[open]')).toHaveCount(0);
  await expect(page.locator('#c-kind')).toHaveCount(0);
  const marker = (id: string) => page.locator(`#custom-${id} > summary`).evaluate((el) => {
    const s = getComputedStyle(el, '::before');
    return { text: s.content, svg: /^url\("data:image\/svg\+xml/.test(s.maskImage || s.webkitMaskImage), transform: s.transform };
  });
  const collapsed = { text: '""', svg: true, transform: 'none' };
  for (const id of ['text', 'solid', 'image', 'github', 'sequence']) expect(await marker(id)).toEqual(collapsed);
  const summary = page.locator('#custom-text > summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#c-str')).toBeVisible();
  // Rotated 90 degrees: the right-pointing chevron points down.
  await expect.poll(async () => (await marker('text')).transform).toMatch(/^matrix\((-?0|[\d.e-]+), 1, -1, (-?0|[\d.e-]+), 0, 0\)$/);
  expect(await marker('solid')).toEqual(collapsed);
  await expect(page.locator('#custom-text > p.section-intro')).toHaveCount(1);
  await expect(page.locator('#custom-text .section-fields > *')).toHaveCount(4);
  await expect(page.locator('#custom-text > :last-child')).toHaveClass('section-actions');
  const send = (await page.locator('#btn-send').boundingBox())!;
  const saveStart = (await page.locator('#c-save-start').boundingBox())!;
  const preview = (await page.locator('#custom-text #preview').boundingBox())!;
  expect(Math.abs(send.y - saveStart.y)).toBeLessThan(2);
  expect(preview.y + preview.height).toBeLessThanOrEqual(send.y);
  await page.fill('#c-str', 'Hi');
  await page.selectOption('#c-font', 'tiny5');
  await page.locator('#c-fg').fill('#ff0000');
  await page.locator('#c-bg').fill('#0000ff');
  await page.locator('#c-speed').fill('8');
  await page.click('#btn-send');
  await expect(page.locator('#send-note')).toHaveText('Upload confirmed.');
  await save(page, 'text', 'My text');

  await openCustomSection(page, 'solid');
  await page.locator('#c-solid').fill('#00ff00');
  await page.click('#btn-send-solid');
  await expect(page.locator('#send-note')).toHaveText('Upload confirmed.');
  await expect.poll(() => page.locator('#preview').evaluate((canvas: HTMLCanvasElement) =>
    Array.from(canvas.getContext('2d')!.getImageData(1, 1, 1, 1).data).slice(0, 3))).toEqual([0, 255, 0]);
  await save(page, 'solid', 'My color');
  await expect(page.locator('#c-fg')).toHaveValue('#ff0000');

  await openCustomSection(page, 'image');
  await expect(page.locator('#btn-send-image')).toBeDisabled();
  await page.setInputFiles('#c-file', 'src/assets/presets/xebia-logo.png');
  await page.selectOption('#c-fit', 'stretch');
  await page.click('#btn-send-image');
  await expect(page.locator('#send-note')).toHaveText('Upload confirmed.');
  await save(page, 'image', 'My image');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const data = await backup(page);
  expect(data.creations.find((p: { name: string }) => p.name === 'My text').content).toMatchObject({
    kind: 'text', text: 'Hi', font: 'tiny5', fg: '#ff0000', bg: '#0000ff', speed: 8,
  });
  expect(data.creations.find((p: { name: string }) => p.name === 'My color').content).toEqual({ kind: 'solid', color: '#00ff00' });
  expect(data.creations.find((p: { name: string }) => p.name === 'My image').content).toMatchObject({ kind: 'image', fit: 'stretch' });
  await page.locator('.preset-list li', { hasText: 'My text' }).getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.locator('#c-font')).toHaveValue('tiny5');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.selectOption('#s-font', 'monaspace');
  await page.getByRole('tab', { name: 'Custom' }).click();
  await expect(page.locator('#c-font')).toHaveValue('tiny5');
  await page.reload();
  await connectHat(page);
  await expect(page.locator('#view-custom details[open]')).toHaveCount(0);
  await expect(page.locator('#c-font')).toHaveValue('tiny5');
  await expect(page.locator('#c-solid')).toHaveValue('#00ff00');
  await expect(page.locator('#c-fit')).toHaveValue('stretch');
  expect(errors).toEqual([]);
});

test('GitHub presets save settings, load fresh graphs, and use their own scroll speed', async ({ page }) => {
  let requests = 0;
  await page.route('https://github-contributions-api.jogruber.de/**', (route) => {
    requests++;
    return route.fulfill({ json: { contributions: [{ date: new Date().toISOString().slice(0, 10), count: requests, level: 4 }] } });
  });
  await page.goto('/#mock');
  await connectHat(page);
  await openCustomSection(page, 'github');
  await page.fill('#github-handle', 'octocat');
  await page.fill('#github-prefix', 'Hi ');
  await page.fill('#github-postfix', '');
  await page.locator('#github-speed').fill('9');
  await save(page, 'github', 'My graph');
  expect(requests).toBe(0);
  await page.click('#github-load');
  await expect(page.locator('#github-status')).toContainText('Graph ready');
  await expect(page.locator('#github-preview')).toBeVisible();
  await page.click('#github-send');
  await expect(page.locator('#github-status')).toContainText('is scrolling on the hat');
  const data = await backup(page);
  expect(data.github.speed).toBe(9);
  expect(data.creations[0].content).toEqual({ kind: 'github', handle: 'octocat', prefix: 'Hi ', postfix: '', speed: 9, font: null });
  await page.getByRole('tab', { name: 'Custom' }).click();
  await page.fill('#github-handle', 'different');
  await page.locator('#github-speed').fill('1');
  for (let i = 0; i < 2; i++) {
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('.preset-list li', { hasText: 'My graph' }).getByRole('button', { name: 'Load', exact: true }).click();
    await expect(page.locator('#github-status')).toContainText('Graph ready for octocat');
    await expect(page.locator('#github-speed')).toHaveValue('9');
    expect(requests).toBe(i + 2);
  }
  await expect(page.locator('#c-speed')).toHaveValue('3');
  await page.reload();
  await connectHat(page);
  await expect(page.locator('#github-speed')).toHaveValue('9');
  expect(requests).toBe(3);
});

test('GitHub presets saved after loading keep the graph and replay it offline', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  let requests = 0;
  await page.route('https://github-contributions-api.jogruber.de/**', (route) => {
    requests++;
    return route.fulfill({ json: { contributions: [{ date: today, count: 5, level: 4 }] } });
  });
  await page.goto('/#mock');
  await connectHat(page);
  await openCustomSection(page, 'github');
  await page.fill('#github-handle', 'octocat');
  await page.click('#github-load');
  await expect(page.locator('#github-status')).toContainText('Graph ready');
  await save(page, 'github', 'Offline graph');
  expect(requests).toBe(1);
  const data = await backup(page);
  expect(data.creations[0].content).toMatchObject({ kind: 'github', handle: 'octocat', asOf: today, days: [{ date: today, count: 5, level: 4 }] });

  await page.unroute('https://github-contributions-api.jogruber.de/**');
  await page.route('https://github-contributions-api.jogruber.de/**', (route) => { requests++; return route.abort(); });
  await page.getByRole('tab', { name: 'Custom' }).click();
  await page.fill('#github-handle', 'someone-else');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('.preset-list li', { hasText: 'Offline graph' }).getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.locator('#github-status')).toContainText(`Saved graph for octocat from ${today}`);
  await expect(page.locator('#github-handle')).toHaveValue('octocat');
  await expect(page.locator('#github-preview')).toBeVisible();
  await page.click('#github-send');
  await expect(page.locator('#github-status')).toContainText('is scrolling on the hat');

  await openCustomSection(page, 'sequence');
  await page.selectOption('#c-seq-preset', { label: 'Offline graph' });
  await page.click('#btn-seq-add-preset');
  await expect(page.locator('#c-seq-list')).toContainText('GitHub octocat');
  await page.check('#c-seq-on');
  await page.click('#btn-send-sequence');
  await expect(page.locator('#send-note')).toHaveText('Animation upload confirmed.');
  expect(requests).toBe(1);
});

test('all drafts restore atomically, preserve excluded and older fields, and survive reload', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await openCustomSection(page, 'text');
  await page.fill('#c-str', 'Draft text');
  await page.selectOption('#c-font', 'bitcount');
  await openCustomSection(page, 'solid');
  await page.locator('#c-solid').fill('#123456');
  await openCustomSection(page, 'image');
  await page.selectOption('#c-fit', 'cover');
  await page.locator('#c-image-bg').fill('#abcdef');
  await openCustomSection(page, 'github');
  await page.locator('#github-speed').fill('7');
  const data = await backup(page);
  expect(data.customDrafts.text.font).toBe('bitcount');
  expect(data.customDrafts.image).toEqual({ kind: 'image', dataUrl: '', fit: 'cover', bg: '#abcdef' });
  await page.getByRole('tab', { name: 'Custom' }).click();
  await page.fill('#c-str', 'Changed');
  await page.selectOption('#c-font', 'tiny5');
  await page.locator('#c-solid').fill('#ffffff');
  await page.selectOption('#c-fit', 'stretch');
  await restore(page, data);
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await page.getByRole('tab', { name: 'Custom' }).click();
  await expect(page.locator('#c-str')).toHaveValue('Draft text');
  await expect(page.locator('#c-font')).toHaveValue('bitcount');
  await expect(page.locator('#c-solid')).toHaveValue('#123456');
  await expect(page.locator('#c-fit')).toHaveValue('cover');
  await restore(page, { app: 'iledcolor-app', version: 2, creations: [], github: { handle: 'octocat' },
    createContent: { kind: 'text', text: 'Older text', fg: '#ffffff', bg: '#000000' } });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await page.reload();
  await connectHat(page);
  await expect(page.locator('#c-str')).toHaveValue('Older text');
  await expect(page.locator('#c-font')).toHaveValue('bitcount');
  await expect(page.locator('#c-solid')).toHaveValue('#123456');
  await expect(page.locator('#github-speed')).toHaveValue('7');
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (args[1] === 'customDrafts') {
        IDBObjectStore.prototype.put = put;
        throw new DOMException('Simulated storage failure', 'DataCloneError');
      }
      return put.apply(this, args);
    };
  });
  await restore(page, data);
  await expect(page.locator('#p-msg')).toContainText('Import failed: Import could not be saved');
  await expect(page.locator('#c-str')).toHaveValue('Older text');
  await page.reload();
  await connectHat(page);
  await expect(page.locator('#c-str')).toHaveValue('Older text');
  await expect(page.locator('#github-handle')).toHaveValue('octocat');
  await restore(page, { ...data, customDrafts: { ...data.customDrafts, text: { ...data.customDrafts.text, font: 'Arial' } } });
  await expect(page.locator('#p-msg')).toContainText('Import failed');
  await expect(page.locator('#c-str')).toHaveValue('Older text');
  await page.uncheck('#p-include-creations');
  const excluded = await backup(page);
  expect(excluded).not.toHaveProperty('customDrafts');
  expect(excluded).not.toHaveProperty('github');
  await restore(page, excluded);
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await expect(page.locator('#c-font')).toHaveValue('bitcount');
});
