import { expect, test } from '@playwright/test';

test.describe('web tab navigation @smoke', () => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    test(`click every tab at ${viewport.width}px without a cap or permissions`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      await page.goto('./');
      await expect(page.locator('#c-kind')).toBeVisible();
      await expect(page.getByRole('tab')).toHaveCount(4);
      await expect(page.locator('#tab-approach')).toBeHidden();
      await page.getByLabel('Text', { exact: true }).fill('Navigation regression');

      for (const [name, heading] of [
        ['Scan', 'QR greeting'], ['Sound', 'Sound & voice'],
        ['Settings', 'Settings'], ['Connect', 'Hat connection'],
      ] as const) {
        const tab = page.getByRole('tab', { name, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(tab).toHaveAttribute('tabindex', '0');
        await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
        await expect(page.getByRole('tabpanel')).toHaveCount(1);
        const panel = page.getByRole('tabpanel', { name, exact: true });
        await expect(panel).toBeVisible();
        await expect(panel.getByRole('heading', { name: heading, exact: true })).toBeVisible();
        expect(await tab.getAttribute('aria-controls')).toBe(await panel.getAttribute('id'));
      }
      await expect(page.getByLabel('Text', { exact: true })).toHaveValue('Navigation regression');
      await expect(page.locator('#status')).toHaveText('Disconnected');
      expect(errors).toEqual([]);
    });
  }

  test('keyboard wraps, skips Approach, and still works after reload', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('./');
    await expect(page.locator('#c-kind')).toBeVisible();
    for (let launch = 0; launch < 2; launch++) {
      await page.getByRole('tab', { name: 'Connect', exact: true }).focus();
      for (const [key, name] of [
        ['ArrowRight', 'Scan'], ['ArrowRight', 'Sound'], ['ArrowRight', 'Settings'],
        ['ArrowRight', 'Connect'], ['ArrowLeft', 'Settings'], ['Home', 'Connect'],
        ['End', 'Settings'], ['ArrowLeft', 'Sound'], ['ArrowLeft', 'Scan'],
      ] as const) {
        await page.keyboard.press(key);
        const tab = page.getByRole('tab', { name, exact: true });
        await expect(tab).toBeFocused();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
      }
      if (launch === 0) {
        await page.reload();
        await expect(page.locator('#c-kind')).toBeVisible();
      }
    }
    expect(errors).toEqual([]);
  });
});
