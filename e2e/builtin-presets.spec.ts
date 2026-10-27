import { expect, test } from '@playwright/test';
import { openBackup, openCustomSection, connectHat, installFakeHat, waitForServiceWorker } from './hat';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('animated Copilot head uses a retro palette, preserves proportions and loops without an abrupt cut', async ({ page }) => {
  const gif = await readFile(join('src', 'assets', 'presets', 'copilot-head-animation.gif'));
  await page.goto('/#mock');
  const metrics = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
    try {
      await decoder.tracks.ready;
      const count = decoder.tracks.selectedTrack!.frameCount;
      const frames: Uint8ClampedArray[] = [];
      const colors = new Set<number>();
      let duration = 0, longestFrame = 0;
      const canvas = document.createElement('canvas');
      let left = Infinity, top = Infinity, right = 0, bottom = 0;
      for (let i = 0; i < count; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        try {
          duration += image.duration ?? 0;
          longestFrame = Math.max(longestFrame, image.duration ?? 0);
          canvas.width = image.displayWidth;
          canvas.height = image.displayHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          frames.push(pixels);
          for (let p = 0; p < pixels.length; p += 4) {
            colors.add((pixels[p]! << 16) | (pixels[p + 1]! << 8) | pixels[p + 2]!);
            if (pixels[p]! + pixels[p + 1]! + pixels[p + 2]! <= 45) continue;
            const x = (p / 4) % canvas.width, y = Math.floor(p / 4 / canvas.width);
            left = Math.min(left, x); right = Math.max(right, x + 1);
            top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
          }
        } finally { image.close(); }
      }
      const motion = frames.map((frame, i) => {
        const previous = frames[(i + frames.length - 1) % frames.length]!;
        let difference = 0;
        for (let p = 0; p < frame.length; p += 4) {
          for (let c = 0; c < 3; c++) difference += Math.abs(frame[p + c]! - previous[p + c]!);
        }
        return difference / (canvas.width * canvas.height * 3);
      });
      return {
        count, duration, longestFrame, colors: colors.size, width: canvas.width, height: canvas.height,
        widthCoverage: (right - left) / canvas.width,
        heightCoverage: (bottom - top) / canvas.height,
        minMotion: Math.min(...motion), maxMotion: Math.max(...motion),
        seamDifference: motion[0]!,
        retracesTurn: frames.slice(1, count / 2).every((frame, i) =>
          frame.every((value, pixel) => value === frames[count - i - 1]![pixel])),
      };
    } finally { decoder.close(); }
  }, gif.toString('base64'));
  expect(metrics.count).toBeGreaterThan(1);
  expect(metrics.count).toBeLessThanOrEqual(150);
  expect(metrics.count).toBeGreaterThan(100);
  expect(metrics.duration).toBeGreaterThan(9_000_000);
  expect(metrics.longestFrame).toBeLessThanOrEqual(80_000);
  expect(metrics.colors).toBeGreaterThan(1);
  expect(metrics.colors).toBeLessThanOrEqual(16);
  expect([metrics.width, metrics.height]).toEqual([32, 16]);
  expect(metrics.widthCoverage).toBeGreaterThan(0.5);
  expect(metrics.widthCoverage).toBeLessThanOrEqual(19 / 32);
  expect(metrics.heightCoverage).toBeGreaterThan(0.95);
  expect(metrics.minMotion).toBeGreaterThan(0.4);
  expect(metrics.maxMotion / metrics.minMotion).toBeLessThan(4.5);
  expect(metrics.seamDifference).toBeLessThanOrEqual(metrics.maxMotion);
  expect(metrics.retracesTurn).toBe(true);
});

test('built-ins send directly, stay separate from backups and remain available offline', async ({ page, context }) => {
  const external: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://localhost:4173')) external.push(r.url()); });
  await page.goto('/#mock');
  await connectHat(page);
  await waitForServiceWorker(page);

  for (const [id, kind] of [['xebia-github', 'text'], ['header', 'text'], ['lgtm', 'text'], ['xebia-logo', 'image'], ['github-copilot-logo', 'image'], ['copilot-head', 'image'], ['copilot-blinking-head', 'gif'], ['party-popper', 'image'], ['copilot-head-animation', 'gif']]) {
    await page.click('nav [data-tab=presets]');
    await expect(page.locator('#builtin-presets li')).toHaveCount(9);
    await expect(page.locator('#builtin-presets [data-act=del]')).toHaveCount(0);
    if (id === 'header') {
      await expect(page.locator('#builtin-presets [data-id=builtin-header]')).toContainText('<header>');
      await expect(page.locator('#builtin-presets header')).toHaveCount(0);
    }
    const preset = page.locator(`#builtin-presets [data-id=builtin-${id}]`);
    await expect(preset.getByRole('img')).toHaveAttribute('aria-label', `Preset type: ${kind === 'gif' || id === 'party-popper' ? 'Animated GIF' : kind === 'text' ? 'Text' : 'Image'}`);
    await expect(preset.locator('button')).toHaveCount(1);
    await preset.locator('[data-act=send]').click();
    await expect(page.locator('#presets-msg')).toHaveText(/upload confirmed\./i, { timeout: 15_000 });
    await expect(page.locator('#view-presets')).toBeVisible();
    await expect(page.locator('#view-custom details[open]')).toHaveCount(0);
  }

  // Direct sends leave the editor intact. Create a separate personal copy for backup.
  await page.click('nav [data-tab=custom]');
  await openCustomSection(page, 'image');
  await page.setInputFiles('#c-file', join('src', 'assets', 'presets', 'party-popper.gif'));
  await expect(page.locator('#btn-send-image')).toBeEnabled();
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

  await openBackup(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const backup = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(backup.creations.map((p: { name: string }) => p.name)).toEqual(['My party']);
  expect(backup.createContent.dataUrl).toMatch(/^data:image\/gif;base64,/);
  const gif = Buffer.from(backup.createContent.dataUrl.split(',')[1], 'base64');
  expect([gif.readUInt16LE(6), gif.readUInt16LE(8)]).toEqual([32, 16]);
  expect(backup.createSequence[0].content).toEqual(backup.createContent);
  await page.click('nav [data-tab=presets]');
  await page.locator('.preset-list:not(#builtin-presets) [data-act=del]').click();
  await expect(page.locator('.preset-list:not(#builtin-presets)')).not.toContainText('My party');
  await openBackup(page);
  await page.setInputFiles('#p-import', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator('#p-msg')).toContainText('Imported shared categories');
  await expect(page.locator('.preset-list:not(#builtin-presets)')).toContainText('My party');

  await context.setOffline(true);
  await page.reload();
  await connectHat(page);
  await expect(page.locator('#custom-image')).not.toHaveAttribute('open');
  await expect(page.locator('#c-seq-list li')).toHaveCount(1);
  await page.click('nav [data-tab=presets]');
  await expect(page.locator('#builtin-presets li')).toHaveCount(9);
  await expect(page.locator('.preset-list:not(#builtin-presets)')).toContainText('My party');
  await page.locator('#builtin-presets [data-id=builtin-party-popper] [data-act=send]').click();
  await expect(page.locator('#presets-msg')).toContainText('Animation upload confirmed.');
  await expect(page.locator('#view-presets')).toBeVisible();
  await page.locator('#builtin-presets [data-id=builtin-copilot-head] [data-act=send]').click();
  await expect(page.locator('#presets-msg')).toContainText('Upload confirmed.');
  await expect(page.locator('#custom-image')).not.toHaveAttribute('open');
  await page.locator('#builtin-presets [data-id=builtin-copilot-blinking-head] [data-act=send]').click();
  await expect(page.locator('#presets-msg')).toContainText('Animation upload confirmed.');
  await expect(page.locator('#view-presets')).toBeVisible();
  await page.locator('#builtin-presets [data-id=builtin-copilot-head-animation] [data-act=send]').click();
  await expect(page.locator('#presets-msg')).toContainText('Animation upload confirmed.');
  await expect(page.locator('#view-presets')).toBeVisible();
  expect(external).toEqual([]);
});

test('animated GIF presets send without WebCodecs ImageDecoder (iOS WebKit)', async ({ page }) => {
  await page.addInitScript(() => { delete (window as { ImageDecoder?: unknown }).ImageDecoder; });
  await page.goto('/#mock');
  await connectHat(page);
  expect(await page.evaluate(() => typeof (window as { ImageDecoder?: unknown }).ImageDecoder)).toBe('undefined');

  for (const id of ['party-popper', 'copilot-blinking-head']) {
    await page.click('nav [data-tab=presets]');
    await page.locator(`#builtin-presets [data-id=builtin-${id}] [data-act=send]`).click();
    await expect(page.locator('#presets-msg')).toContainText('Animation upload confirmed.', { timeout: 15_000 });
  }

  await page.click('nav [data-tab=custom]');
  await openCustomSection(page, 'image');
  await page.setInputFiles('#c-file', join('src', 'assets', 'presets', 'party-popper.gif'));
  await expect(page.locator('#btn-send-image')).toBeEnabled();
  const pixels = () => page.locator('#preview').evaluate((canvas: HTMLCanvasElement) =>
    Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data).join(','));
  const firstFrame = await pixels();
  await expect.poll(pixels).not.toBe(firstFrame);
});

test('built-ins survive replacement imports on web and cannot shadow personal preset IDs', async ({ page }) => {
  await installFakeHat(page);
  await page.goto('/');
  await connectHat(page);
  await openBackup(page);
  const file = {
    app: 'iledcolor-app', version: 2,
    creations: [{ id: 'builtin-xebia-github', name: 'Personal text', updatedAt: 1,
      content: { kind: 'text', text: 'Keep mine', fg: '#ffffff', bg: '#000000' } }],
  };
  await page.setInputFiles('#p-import', { name: 'personal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator('#p-msg')).toContainText('Imported');
  await expect(page.locator('#builtin-presets li')).toHaveCount(9);
  await page.click('nav [data-tab=presets]');
  await page.locator('.preset-list:not(#builtin-presets) [data-act=send]').click();
  await expect(page.locator('#presets-msg')).toContainText('"Personal text":');
  await expect(page.locator('#presets-msg')).toContainText('upload confirmed.');
  await page.click('nav [data-tab=custom]');
  await openCustomSection(page, 'sequence');
  await page.selectOption('#c-seq-preset', { label: 'Personal text' });
  await page.click('#btn-seq-add-preset');
  await expect(page.locator('#c-seq-list')).toContainText('Keep mine');
  await page.selectOption('#c-seq-preset', { label: 'Xebia 💜 GitHub' });
  await page.click('#btn-seq-add-preset');
  await expect(page.locator('#c-seq-list')).toContainText('Xebia 💜 GitHub');
  await page.click('nav [data-tab=presets]');
  await page.locator('#builtin-presets [data-id=builtin-xebia-github] [data-act=send]').click();
  await expect(page.locator('#presets-msg')).toContainText('"Xebia 💜 GitHub":');
  await expect(page.locator('#presets-msg')).toContainText('upload confirmed.');

  await page.click('nav [data-tab=presets]');
  await openBackup(page);
  await page.setInputFiles('#p-import', { name: 'empty.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...file, creations: [] })) });
  await expect(page.locator('#p-msg')).toContainText('Imported');
  await expect(page.locator('#builtin-presets li')).toHaveCount(9);
  await expect(page.locator('.preset-list:not(#builtin-presets)')).not.toContainText('Personal text');
});
