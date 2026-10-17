import { expect, test } from '@playwright/test';

test('web navigation skips native-only Approach and retains content, scan and settings', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#offline')).toHaveText('Ready for offline use', { timeout: 20000 });
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.getByRole('tab')).toHaveText(['Connect', 'Scan', '']);
  await expect(page.locator('#tab-approach')).toBeHidden();
  await expect(page.locator('#c-kind')).toBeVisible();
  await page.fill('#c-str', 'Web greeting');
  await page.fill('#c-name', 'Browser creation');
  await page.click('#btn-save');
  await expect(page.locator('#send-note')).toContainText('Saved');
  await page.getByRole('tab', { name: 'Connect' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Scan' })).toBeFocused();
  await expect(page.locator('#qr-start')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Settings' })).toBeFocused();
  await expect(page.locator('#brightness')).toBeVisible();
  await expect(page.locator('#settings-presets')).toContainText('Browser creation');
  await expect(page.locator('#settings-presets')).toContainText('require the Android or iOS app');
  await page.locator('li', { hasText: 'Browser creation' }).getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.locator('#c-str')).toHaveValue('Web greeting');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.locator('#c-str')).toHaveValue('Web greeting');
  expect(errors).toEqual([]);
});

test('web preserves native group presets for backup without opening unsupported controls', async ({ page }) => {
  await page.goto('/#mock');
  await page.getByRole('tab', { name: 'Approach' }).click();
  await page.fill('#ap-preset-name', 'Native group');
  await page.click('#ap-preset-save');
  await expect(page.locator('#ap-preset-msg')).toContainText('Saved');
  await page.goto('/');
  await expect(page.locator('#c-kind')).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();
  const preset = page.locator('.preset-list li', { hasText: 'Native group' });
  await expect(preset.getByRole('button', { name: 'Load', exact: true })).toBeDisabled();
  await expect(preset).toContainText('kept for backup');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const json = JSON.parse(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8'));
  expect(json.approach.presets.some((p: { name: string }) => p.name === 'Native group')).toBe(true);
  await expect(page.locator('#view-approach')).toBeHidden();
  await expect(page.getByRole('tab')).toHaveCount(3);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} shell retains the full four-tab layout`, async ({ page }) => {
    await page.addInitScript((name) => {
      Object.assign(window, name === 'ios'
        ? { webkit: { messageHandlers: { bridge: {} } } }
        : { androidBridge: {} });
    }, platform);
    await page.goto('/');
    await expect(page.locator('#offline')).toHaveText(platform === 'ios' ? 'iOS app' : 'Android app');
    await expect(page.getByRole('tab')).toHaveCount(4);
    await expect(page.locator('#c-kind')).toBeVisible();
    await expect(page.locator('#view-connect')).toContainText(platform === 'ios'
      ? 'iOS will ask for Bluetooth permission' : 'Android will ask for Bluetooth permission');
    await page.getByRole('tab', { name: 'Approach' }).click();
    await expect(page.locator('#view-approach')).toBeVisible();
    for (const option of await page.locator('#view-approach option[value=span]').all())
      await expect(option).toContainText('unstable');
    await page.getByRole('tab', { name: 'Scan', exact: true }).click();
    const action = await page.locator('#qr-start').boundingBox();
    const profile = await page.locator('#qr-profile').boundingBox();
    expect(action!.y).toBeLessThan(profile!.y);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.locator('#brightness')).toBeVisible();
    await expect(page.locator('#settings-presets')).not.toContainText('require the Android or iOS app');
  });
}
