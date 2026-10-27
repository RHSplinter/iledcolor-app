import { expect, test } from '@playwright/test';
import { connectHat, openBackup, openCustomSection } from './hat';

test('preset bars support keyboard sends, busy gating, visible errors and unchanged drafts', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/#mock');
  await connectHat(page);
  await openCustomSection(page, 'text');
  await page.fill('#c-str', 'Keep my draft');
  await openBackup(page);
  await page.setInputFiles('#p-import', {
    name: 'presets.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      app: 'iledcolor-app', version: 2,
      creations: [
        { id: 'color', name: 'A very long personal color preset name that wraps on a phone', updatedAt: 1, content: { kind: 'solid', color: '#123456' } },
        { id: 'graph', name: 'Fresh graph', updatedAt: 1, content: { kind: 'github', handle: 'octocat', prefix: '', postfix: '', speed: 9 } },
        { id: 'broken', name: 'Broken image', updatedAt: 1, content: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA', fit: 'contain', bg: '#000000' } },
      ],
    })),
  });
  await expect(page.locator('#p-msg')).toContainText('Imported');
  await page.getByRole('tab', { name: 'Presets' }).click();
  await expect(page.getByRole('button', { name: 'Load', exact: true })).toHaveCount(0);
  await expect(page.locator('#presets-content > .card h2')).toHaveText(['Built-in presets', 'Personal presets']);
  await expect(page.locator('#presets-content > .card h1')).toHaveCount(0);
  const color = page.locator('[data-id=color] [data-act=send]');
  await expect(color.getByRole('img')).toHaveAttribute('aria-label', 'Preset type: Solid color');
  await expect(page.locator('[data-id=graph] [data-act=send]').getByRole('img')).toHaveAttribute('aria-label', 'Preset type: GitHub contributions');
  expect(await color.evaluate((b) => {
    const icon = b.querySelector('svg')!.getBoundingClientRect();
    const name = b.querySelector('span')!.getBoundingClientRect();
    return icon.right <= name.left && b.getBoundingClientRect().height >= 44;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await color.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#presets-msg')).toContainText('Upload confirmed.');
  await expect(page.locator('#view-presets')).toBeVisible();
  await expect(page.locator('#c-str')).toHaveValue('Keep my draft');

  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('https://github-contributions-api.jogruber.de/**', async (route) => {
    await pending;
    await route.fulfill({ json: { contributions: [{ date: new Date().toISOString().slice(0, 10), count: 1, level: 1 }] } });
  });
  await page.locator('[data-id=graph] [data-act=send]').click();
  await expect(page.locator('#banner')).toContainText('Sending "Fresh graph"');
  for (const button of await page.locator('.preset-list [data-act=send]').all()) await expect(button).toBeDisabled();
  await expect(page.locator('#btn-send')).toBeDisabled();
  release();
  await expect(page.locator('#presets-msg')).toContainText('Animation upload confirmed.');
  await expect(page.locator('#banner')).toBeHidden();
  await expect(color).toBeEnabled();

  await page.unroute('https://github-contributions-api.jogruber.de/**');
  await page.route('https://github-contributions-api.jogruber.de/**', (route) => route.fulfill({ status: 503 }));
  await page.locator('[data-id=graph] [data-act=send]').click();
  await expect(page.locator('#presets-msg')).not.toContainText('Sending');
  await expect(page.locator('#presets-msg')).not.toBeEmpty();
  await expect(page.locator('#presets-msg')).not.toContainText('confirmed');
  await expect(color).toBeEnabled();
  await page.locator('[data-id=broken] [data-act=send]').click();
  await expect(page.locator('#presets-msg')).not.toContainText('Sending');
  await expect(page.locator('#presets-msg')).not.toBeEmpty();
  await expect(page.locator('#presets-msg')).not.toContainText('confirmed');
  await expect(color).toBeEnabled();
  await expect(page.locator('#view-presets')).toBeVisible();
  await expect(page.locator('#c-str')).toHaveValue('Keep my draft');
  await page.locator('[data-id=broken] [data-act=del]').click();
  await expect(page.locator('[data-id=broken]')).toHaveCount(0);
  await expect(page.locator('#presets-msg')).toBeEmpty();
});
