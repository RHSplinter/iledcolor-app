import { expect, test } from '@playwright/test';
import { installFakeHat } from './hat';

async function connectThroughTab(page: import('@playwright/test').Page) {
  await page.goto('./');
  await page.locator('#use-connection-tab').check();
  const popupReady = page.waitForEvent('popup');
  await page.locator('#btn-connect').click();
  const owner = await popupReady;
  await expect(owner).toHaveTitle('LED Hat Connection');
  await expect(owner.getByText('Keep this tab open.', { exact: false })).toBeVisible();
  await owner.getByRole('button', { name: 'Choose LED hat', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Ready: iledcolor-FAKE');
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  return owner;
}

test.beforeEach(async ({ context }) => {
  await installFakeHat(context);
  await context.addInitScript(() => {
    const bluetooth = navigator.bluetooth;
    Object.defineProperty(bluetooth, 'getDevices', { value: undefined, configurable: true });
    const choose = bluetooth.requestDevice.bind(bluetooth);
    bluetooth.requestDevice = async (options) => {
      localStorage.setItem('test-picker-count', String(Number(localStorage.getItem('test-picker-count') || 0) + 1));
      const device = await choose(options);
      const connect = device.gatt!.connect.bind(device.gatt);
      device.gatt!.connect = async () => {
        localStorage.setItem('test-gatt-count', String(Number(localStorage.getItem('test-gatt-count') || 0) + 1));
        return connect();
      };
      return device;
    };
  });
});

test('connection tab holds the same Bluetooth link across three main-page refreshes without getDevices', async ({ page }) => {
  const owner = await connectThroughTab(page);
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await expect(page.locator('#status')).toContainText('Ready: iledcolor-FAKE');
    await expect(owner.locator('#link-status')).toContainText('Connected to LED hat iledcolor-FAKE');
  }
  expect(await page.evaluate(() => localStorage.getItem('test-picker-count'))).toBe('1');
  expect(await page.evaluate(() => localStorage.getItem('test-gatt-count'))).toBe('1');
});

test('main-app Disconnect closes the held link and forgets the hat', async ({ page }) => {
  const owner = await connectThroughTab(page);
  await page.locator('#status-toggle').click();
  await page.locator('#btn-status-disconnect').click();
  await expect(owner.locator('#link-status')).toContainText('LED hat disconnected');
  expect(await page.evaluate(() => localStorage.getItem('iledcolor.lastWebBluetoothHat'))).toBeNull();
  await page.reload();
  await expect(page.locator('#status')).toContainText('Disconnected');
  await expect(page.locator('#btn-connect')).toBeEnabled();
});

test('closing the connection tab gives a bounded reconnect failure and normal Connect controls', async ({ page }) => {
  const owner = await connectThroughTab(page);
  await owner.close();
  await page.reload();
  await expect(page.locator('#status')).toContainText('Reconnecting to iledcolor-FAKE');
  await expect(page.locator('#btn-connect')).toBeEnabled({ timeout: 12000 });
  await expect(page.locator('#conn-msg')).toContainText('Could not reconnect automatically');
});

test('can switch back to standard Connect after using a connection tab', async ({ page }) => {
  const owner = await connectThroughTab(page);
  await page.locator('#status-toggle').click();
  await page.locator('#btn-status-disconnect').click();
  await expect(owner.locator('#link-status')).toContainText('disconnected');
  await page.locator('#use-connection-tab').uncheck();
  await page.locator('#btn-connect').click();
  await expect(page.locator('#status')).toContainText('Ready: iledcolor-FAKE');
  await page.reload();
  await expect(page.locator('#conn-msg')).toContainText('does not support automatic Bluetooth reconnect');
  await expect(page.locator('#btn-connect')).toBeEnabled();
});
