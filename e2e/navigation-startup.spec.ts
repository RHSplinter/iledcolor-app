import { expect, test } from '@playwright/test';

for (const feature of ['scan', 'sound']) {
  test(`tabs respond while ${feature} settings are still loading`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((name) => {
      const open = IDBFactory.prototype.open;
      let stalled = false;
      IDBFactory.prototype.open = function (...args: Parameters<IDBFactory['open']>) {
        const request = open.apply(this, args);
        if (!stalled && document.getElementById(name === 'scan' ? 'qr-template' : 'sound-language')) {
          stalled = true;
          // Withhold one restore result while unrelated storage operations continue.
          request.addEventListener('success', (event) => {
            request.result.close();
            event.stopImmediatePropagation();
          }, { once: true });
        }
        return request;
      };
    }, feature);
    await page.goto('/');
    await expect(page.locator(feature === 'scan' ? '#qr-template' : '#sound-language')).toBeAttached();
    const settings = page.getByRole('tab', { name: 'Settings', exact: true });
    await settings.click();
    await expect(settings).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Presets', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: feature === 'scan' ? 'Sound' : 'Scan', exact: true }).click();
    await expect(page.locator(feature === 'scan' ? '#sound-language' : '#qr-template'))
      .toHaveValue(feature === 'scan' ? 'en-US' : 'Hi {name}!');
    await page.getByRole('tab', { name: 'Connect', exact: true }).click();
    await expect(page.locator('#c-kind')).toBeVisible();
    await page.getByRole('tab', { name: 'Connect', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Scan', exact: true })).toBeFocused();
    expect(errors).toEqual([]);
  });
}
