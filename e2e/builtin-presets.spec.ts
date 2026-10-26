import { expect, test } from '@playwright/test';
import { openCustomSection, connectHat, installFakeHat, waitForServiceWorker } from './hat';
import { readFile } from 'node:fs/promises';

test('built-ins load, send, save, back up and remain available offline', async ({ page, context }) => {
  const external: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://localhost:4173')) external.push(r.url()); });
  await page.goto('/#mock');
  await connectHat(page);
  await waitForServiceWorker(page);

  for (const [id, kind] of [['xebia-github', 'text'], ['header', 'text'], ['lgtm', 'text'], ['xebia-logo', 'image'], ['github-copilot-logo', 'image'], ['party-popper', 'image']]) {
    await page.click('nav [data-tab=settings]');
    await expect(page.locator('#builtin-presets li')).toHaveCount(6);
    await expect(page.locator('#builtin-presets [data-act=del]')).toHaveCount(0);
    if (id === 'header') {
      await expect(page.locator('#builtin-presets [data-id=builtin-header]')).toContainText('<header>');
      await expect(page.locator('#builtin-presets header')).toHaveCount(0);
    }
    await page.locator(`#builtin-presets [data-id=builtin-${id}] [data-act=load]`).click();
    await expect(page.locator('#view-custom')).toBeVisible();
    await expect(page.locator(`#custom-${kind}`)).toHaveAttribute('open', '');
    if (kind === 'text')     await expect(page.locator('#c-str')).toHaveValue(({ header: '<header>', lgtm: 'LGTM 👍' } as Record<string, string>)[id!] ?? 'Xebia 💜 GitHub');
    await expect(page.locator('#c-err')).toBeEmpty();
    const send = kind === 'text' ? '#btn-send' : '#btn-send-image';
    await expect(page.locator(send)).toBeEnabled();
    await page.click(send);
    await expect(page.locator('#send-note')).toHaveText(/upload confirmed\./i, { timeout: 15_000 });
  }

  // The preview magnifies each LED tenfold; party-popper pixels must animate.
  const pixels = () => page.locator('#preview').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(data).join(',');
  });
  const firstFrame = await pixels();
  await expect.poll(pixels).not.toBe(firstFrame);
  await expect(page.locator('#preview')).toHaveAttribute('width', '320');
  await expect(page.locator('#preview')).toHaveAttribute('height', '160');
  await page.click('#image-save-start');
  await page.fill('#image-name', 'My party');
  await page.locator('#image-save-form').getByRole('button', { name: 'Save preset' }).click();
  await openCustomSection(page, 'sequence');
  await page.selectOption('#c-seq-preset', { label: 'Party Popper' });
  await page.click('#btn-seq-add-preset');
  await expect(page.locator('#c-seq-list li')).toHaveCount(1);
  await page.uncheck('#c-seq-on');

  await page.click('nav [data-tab=settings]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const backup = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(backup.creations.map((p: { name: string }) => p.name)).toEqual(['My party']);
  expect(backup.createContent.dataUrl).toMatch(/^data:image\/gif;base64,/);
  const gif = Buffer.from(backup.createContent.dataUrl.split(',')[1], 'base64');
  expect([gif.readUInt16LE(6), gif.readUInt16LE(8)]).toEqual([32, 16]);
  expect(backup.createSequence[0].content).toEqual(backup.createContent);
  await page.locator('.preset-list:not(#builtin-presets) [data-act=del]').click();
  await expect(page.locator('.preset-list:not(#builtin-presets)')).not.toContainText('My party');
  await page.setInputFiles('#p-import', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await expect(page.locator('.preset-list:not(#builtin-presets)')).toContainText('My party');

  await context.setOffline(true);
  await page.reload();
  await connectHat(page);
  await expect(page.locator('#custom-image')).not.toHaveAttribute('open');
  await expect(page.locator('#c-seq-list li')).toHaveCount(1);
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#builtin-presets li')).toHaveCount(6);
  await expect(page.locator('.preset-list:not(#builtin-presets)')).toContainText('My party');
  await page.locator('#builtin-presets [data-id=builtin-party-popper] [data-act=load]').click();
  await expect(page.locator('#view-custom')).toBeVisible();
  await expect(page.locator('#c-err')).toBeEmpty();
  await expect.poll(pixels).not.toBe(firstFrame);
  expect(external).toEqual([]);
});

test('built-ins survive replacement imports on web and cannot shadow personal preset IDs', async ({ page }) => {
  await installFakeHat(page);
  await page.goto('/');
  await connectHat(page);
  await page.click('nav [data-tab=settings]');
  const file = {
    app: 'iledcolor-app', version: 2,
    creations: [{ id: 'builtin-xebia-github', name: 'Personal text', updatedAt: 1,
      content: { kind: 'text', text: 'Keep mine', fg: '#ffffff', bg: '#000000' } }],
  };
  await page.setInputFiles('#p-import', { name: 'personal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator('#p-msg')).toContainText('Imported');
  await expect(page.locator('#builtin-presets li')).toHaveCount(6);
  await page.locator('.preset-list:not(#builtin-presets) [data-act=load]').click();
  await expect(page.locator('#c-str')).toHaveValue('Keep mine');
  await openCustomSection(page, 'sequence');
  await page.selectOption('#c-seq-preset', { label: 'Personal text' });
  await page.click('#btn-seq-add-preset');
  await expect(page.locator('#c-seq-list')).toContainText('Keep mine');
  await page.selectOption('#c-seq-preset', { label: 'Xebia 💜 GitHub' });
  await page.click('#btn-seq-add-preset');
  await expect(page.locator('#c-seq-list')).toContainText('Xebia 💜 GitHub');
  await page.click('nav [data-tab=settings]');
  await page.locator('#builtin-presets [data-id=builtin-xebia-github] [data-act=load]').click();
  await expect(page.locator('#c-str')).toHaveValue('Xebia 💜 GitHub');

  await page.click('nav [data-tab=settings]');
  await page.setInputFiles('#p-import', { name: 'empty.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...file, creations: [] })) });
  await expect(page.locator('#p-msg')).toContainText('Imported');
  await expect(page.locator('#builtin-presets li')).toHaveCount(6);
  await expect(page.locator('.preset-list:not(#builtin-presets)')).not.toContainText('Personal text');
});
