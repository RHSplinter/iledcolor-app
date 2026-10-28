import { expect, test } from '@playwright/test';
import { connectHat, installFakeHat } from './hat';

test.describe('web navigation @smoke', () => {
  test.beforeEach(async ({ context }) => { await installFakeHat(context); });

  test('opens Connect hat without a hat and keeps only connection and Scan tabs visible', async ({ page }) => {
    await page.goto('./?controller=1');
    await expect(page.getByRole('tab')).toHaveText(['Connect hat', 'Scan']);
    await expect(page.getByRole('tab', { name: 'Connect hat', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#qr-start')).toBeEnabled();
    for (const name of ['Presets', 'Sound', 'Settings'])
      await expect(page.locator(`[data-tab=${name.toLowerCase()}]`)).toBeHidden();
    await page.getByRole('tab', { name: 'Connect hat', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Scan', exact: true })).toBeFocused();
    await page.getByRole('tab', { name: 'Connect hat', exact: true }).click();
    await expect(page.locator('#btn-connect')).toHaveText('Connect hat');
    await expect(page.locator('#custom-text')).toBeHidden();
  });

  test('pairing selects Presets, refresh reattaches, and reconnect reuses the connection tab', async ({ page, context }) => {
    await page.goto('./?controller=1');
    // Start after navigation is initialized: clicking the Connect hat tab now
    // opens the owner itself, so the helper must not wait for a second popup.
    await expect(page.getByRole('tab', { name: 'Connect hat', exact: true })).toHaveAttribute('aria-selected', 'true');
    await connectHat(page, 'presets');
    expect(context.pages()).toHaveLength(2);
    await expect(page.getByRole('tab', { name: 'Presets', exact: true })).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Presets', 'Sound', 'Settings'])
      await expect(page.getByRole('tab', { name, exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.locator('#status')).toContainText('Ready');
    await page.locator('#status-toggle').click();
    await page.locator('#btn-status-disconnect').click();
    await expect(page.locator('#status')).toContainText('Disconnected');
    await expect(page.getByRole('tab', { name: 'Connect hat', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#qr-start')).toBeEnabled();
    for (const name of ['Presets', 'Sound', 'Settings'])
      await expect(page.locator(`[data-tab=${name.toLowerCase()}]`)).toBeHidden();
    await connectHat(page, 'presets');
    await expect(page.getByRole('tab', { name: 'Presets', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(context.pages()).toHaveLength(2);
  });

  for (const width of [1280, 390]) {
    test(`navigation at ${width}px keeps Presets Custom Sound Settings Scan order`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('./?controller=1');
      await connectHat(page);
      for (const name of ['Presets', 'Custom', 'Sound', 'Settings', 'Scan']) {
        await page.getByRole('tab', { name, exact: true }).click();
        await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
      }
    });
  }

  test('keyboard order is Presets Custom Sound Settings Scan and remains correct after refresh', async ({ page }) => {
    await page.goto('./?controller=1');
    await connectHat(page);
    for (let launch = 0; launch < 2; launch++) {
      await page.getByRole('tab', { name: 'Custom', exact: true }).focus();
      for (const name of ['Sound', 'Settings', 'Scan', 'Presets', 'Custom']) {
        await page.keyboard.press('ArrowRight');
        await expect(page.getByRole('tab', { name, exact: true })).toBeFocused();
      }
      await page.reload();
      await expect(page.locator('#status')).toContainText('Ready');
    }
  });
});
