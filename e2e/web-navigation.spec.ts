import { expect, test } from '@playwright/test';
import { connectHat, installFakeHat } from './hat';

test.describe('web navigation @smoke', () => {
  test.beforeEach(async ({ context }) => { await installFakeHat(context); });

  test('opens Scan without a hat and keeps all five tabs visible', async ({ page }) => {
    await page.goto('./?controller=1');
    await expect(page.getByRole('tab')).toHaveText(['Presets', 'Custom', 'Sound', 'Scan', '']);
    await expect(page.getByRole('tab', { name: 'Scan', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#qr-start')).toBeEnabled();
    for (const name of ['Presets', 'Sound', 'Settings'])
      await expect(page.getByRole('tab', { name, exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: 'Custom', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Scan', exact: true })).toBeFocused();
    await page.getByRole('tab', { name: 'Custom', exact: true }).click();
    await expect(page.locator('#btn-connect')).toHaveText('Connect hat');
    await expect(page.locator('#custom-text')).toBeHidden();
  });

  test('pairing selects Presets, refresh reattaches, and Disconnect returns to Scan', async ({ page }) => {
    await page.goto('./?controller=1');
    await connectHat(page, 'presets');
    await expect(page.getByRole('tab', { name: 'Presets', exact: true })).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Presets', 'Sound', 'Settings'])
      await expect(page.getByRole('tab', { name, exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.locator('#status')).toContainText('Ready');
    await page.locator('#status-toggle').click();
    await page.locator('#btn-status-disconnect').click();
    await expect(page.locator('#status')).toContainText('Disconnected');
    await expect(page.getByRole('tab', { name: 'Scan', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#qr-start')).toBeEnabled();
    for (const name of ['Presets', 'Sound', 'Settings'])
      await expect(page.getByRole('tab', { name, exact: true })).toBeDisabled();
  });

  for (const width of [1280, 390]) {
    test(`navigation at ${width}px keeps Presets Custom Sound Scan Settings order`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('./?controller=1');
      await connectHat(page);
      for (const name of ['Presets', 'Custom', 'Sound', 'Scan', 'Settings']) {
        await page.getByRole('tab', { name, exact: true }).click();
        await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
      }
    });
  }

  test('keyboard order is Presets Custom Sound Scan Settings and remains correct after refresh', async ({ page }) => {
    await page.goto('./?controller=1');
    await connectHat(page);
    for (let launch = 0; launch < 2; launch++) {
      await page.getByRole('tab', { name: 'Custom', exact: true }).focus();
      for (const name of ['Sound', 'Scan', 'Settings', 'Presets', 'Custom']) {
        await page.keyboard.press('ArrowRight');
        await expect(page.getByRole('tab', { name, exact: true })).toBeFocused();
      }
      await page.reload();
      await expect(page.locator('#status')).toContainText('Ready');
    }
  });
});
