import { expect, test } from '@playwright/test';
import { openCustomSection, connectHat, installFakeHat } from './hat';

test.describe('web tab navigation @smoke', () => {
  test('only the connection controls are shown until a hat is connected', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await installFakeHat(page);
    await page.goto('./');
    await expect(page.getByRole('heading', { name: 'Hat connection', exact: true })).toBeVisible();
    await expect(page.locator('#btn-connect')).toBeEnabled();
    await expect(page.locator('#connection-card').getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);
    await expect(page.locator('#status')).toHaveText('Disconnected');
    await expect(page.locator('#status-unlinked')).toBeVisible();
    await expect(page.locator('#status-linked')).toBeHidden();
    await expect(page.locator('#tab-bar')).toBeHidden();
    await expect(page.getByRole('tab')).toHaveCount(0);
    for (const hidden of ['#content-editor', '#github-section', '#custom-text > summary'])
      await expect(page.locator(hidden)).toBeHidden();
    await connectHat(page);
    await expect(page.locator('#status-linked')).toBeVisible();
    await expect(page.locator('#status-unlinked')).toBeHidden();
    await expect(page.locator('#status-linked')).toHaveCSS('color', 'rgb(76, 217, 100)');
    await expect(page.getByRole('tab')).toHaveCount(4);
    await expect(page.locator('#custom-text > summary')).toBeVisible();
    await expect(page.locator('#connection-card')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Hat connection', exact: true })).toBeHidden();
    await expect(page.locator('#view-custom').getByLabel(/Keep cap black/)).toHaveCount(0);
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await expect(page.locator('#s-keep-black')).toBeVisible();
    await page.getByRole('tab', { name: 'Custom', exact: true }).click();
    await expect(page.locator('#btn-status-disconnect')).toBeHidden();
    await page.locator('#status-toggle').click();
    await expect(page.locator('#btn-status-disconnect')).toBeVisible();
    await page.locator('#btn-status-disconnect').click();
    await expect(page.locator('#status')).toHaveText('Disconnected');
    await expect(page.locator('#btn-status-disconnect')).toBeHidden();
    await expect(page.locator('#status-toggle')).toBeDisabled();
    await expect(page.locator('#connection-card')).toBeVisible();
    await expect(page.locator('#connection-card').getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);
    await expect(page.locator('#btn-connect')).toBeVisible();
    await expect(page.locator('#status-unlinked')).toBeVisible();
    await expect(page.locator('#status-linked')).toBeHidden();
    await expect(page.locator('#status-unlinked')).toHaveCSS('color', 'rgb(255, 90, 90)');
    await expect(page.locator('#status-label')).toHaveCSS('color', 'rgb(255, 90, 90)');
    await expect(page.locator('#tab-bar')).toBeHidden();
    await expect(page.locator('#custom-text > summary')).toBeHidden();
    await expect(page.getByRole('tabpanel', { name: 'Custom', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('disconnecting from another tab returns to the connection controls', async ({ page }) => {
    await installFakeHat(page);
    await page.goto('./');
    await connectHat(page);
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await page.evaluate(() => (navigator as unknown as { bluetooth: { getDevices: () => Promise<Array<{ gatt: { disconnect: () => void } }>> } })
      .bluetooth.getDevices().then(([d]) => d!.gatt.disconnect()));
    await expect(page.locator('#status')).toHaveText('Disconnected');
    await expect(page.getByRole('tabpanel', { name: 'Custom', exact: true })).toBeVisible();
    await expect(page.locator('#view-settings')).toBeHidden();
    await expect(page.locator('#tab-bar')).toBeHidden();
  });

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    test(`click every tab at ${viewport.width}px with a connected cap`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      await installFakeHat(page);
      await page.goto('./');
      await connectHat(page);
      await expect(page.locator('#custom-text > summary')).toBeVisible();
      await expect(page.getByRole('tab')).toHaveCount(4);
      await expect(page.locator('#tab-approach')).toBeHidden();
      await openCustomSection(page, 'text');
      await page.getByLabel('Text', { exact: true }).fill('Navigation regression');

      for (const [name, heading] of [
        ['Scan', 'Badge greeting'], ['Sound', 'Sound & voice'],
        ['Settings', 'Settings'], ['Custom', 'Custom'],
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
      await expect(page.locator('#status')).toContainText('Ready');
      expect(errors).toEqual([]);
    });
  }

  test('keyboard wraps, skips Approach, and still works after reload', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await installFakeHat(page);
    await page.goto('./');
    await connectHat(page);
    await expect(page.locator('#custom-text > summary')).toBeVisible();
    for (let launch = 0; launch < 2; launch++) {
      await page.getByRole('tab', { name: 'Custom', exact: true }).focus();
      for (const [key, name] of [
        ['ArrowRight', 'Scan'], ['ArrowRight', 'Sound'], ['ArrowRight', 'Settings'],
        ['ArrowRight', 'Custom'], ['ArrowLeft', 'Settings'], ['Home', 'Custom'],
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
        await connectHat(page);
        await expect(page.locator('#custom-text > summary')).toBeVisible();
      }
    }
    expect(errors).toEqual([]);
  });
});
