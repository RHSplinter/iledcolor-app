import { expect, test } from '@playwright/test';
import { installFakeHat } from './hat';

// Exercise real popup-blocking policy, rather than Playwright's permissive launch default.
test.use({ launchOptions: { ignoreDefaultArgs: ['--disable-popup-blocking'] } });

async function connectThroughTab(owner: import('@playwright/test').Page) {
  await owner.goto('./');
  await expect(owner).toHaveTitle('LED Hat Connection');
  await expect(owner.locator('main').locator('button:visible,a:visible')).toHaveText(['Connect LED hat', 'Go to LED Hat Controller', 'Install app']);
  await expect(owner.getByText('Keep this tab open.', { exact: false })).toBeVisible();
  await expect(owner.getByRole('link', { name: 'Go to LED Hat Controller', exact: true })).toBeEnabled();
  const controllerReady = owner.waitForEvent('popup');
  await owner.getByRole('button', { name: 'Connect LED hat', exact: true }).click();
  const controller = await controllerReady;
  await expect(controller.locator('#status')).toContainText('Ready: iledcolor-FAKE', { timeout: 15_000 });
  await expect.poll(() => controller.evaluate(() => document.hasFocus())).toBe(true);
  return { owner, controller };
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
  const { owner, controller } = await connectThroughTab(page);
  for (let i = 0; i < 3; i++) {
    await controller.reload();
    await expect(controller.locator('#status')).toContainText('Ready: iledcolor-FAKE');
    await expect(owner.locator('#link-status')).toContainText('Connected to LED hat iledcolor-FAKE');
  }
  expect(await controller.evaluate(() => localStorage.getItem('test-picker-count'))).toBe('1');
  expect(await controller.evaluate(() => localStorage.getItem('test-gatt-count'))).toBe('1');
});

test('pairing after user activation expires still activates the controller tab', async ({ page, context }) => {
  await context.addInitScript(() => {
    const choose = navigator.bluetooth.requestDevice.bind(navigator.bluetooth);
    navigator.bluetooth.requestDevice = async (options) => {
      const device = await choose(options);
      await new Promise((resolve) => setTimeout(resolve, 6000));
      return device;
    };
  });
  const { controller } = await connectThroughTab(page);
  await expect(controller.getByRole('tab', { name: 'Presets', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('main-app Disconnect closes the held link and forgets the hat', async ({ page }) => {
  const { owner, controller } = await connectThroughTab(page);
  await controller.locator('#status-toggle').click();
  await controller.locator('#btn-status-disconnect').click();
  await expect(owner.locator('#link-status')).toContainText('LED hat disconnected');
  expect(await controller.evaluate(() => localStorage.getItem('iledcolor.lastWebBluetoothHat'))).toBeNull();
  await controller.reload();
  await expect(controller.locator('#status')).toContainText('Disconnected');
  await controller.getByRole('tab', { name: 'Connect hat', exact: true }).click();
  await expect(controller.locator('#btn-connect')).toBeEnabled();
});

test('closing the connection tab and refreshing leaves Scan usable without pairing', async ({ page }) => {
  const { owner, controller } = await connectThroughTab(page);
  await owner.close();
  await controller.reload();
  await expect(controller.locator('#status')).toContainText('Disconnected');
  await expect(controller.getByRole('tab', { name: 'Connect hat', exact: true })).toHaveAttribute('aria-selected', 'true');
  await controller.getByRole('tab', { name: 'Scan', exact: true }).click();
  await expect(controller.locator('#qr-start')).toBeEnabled();
  await controller.getByRole('tab', { name: 'Connect hat', exact: true }).click();
  await expect(controller.locator('#btn-connect')).toBeEnabled();
  expect(await controller.evaluate(() => localStorage.getItem('test-picker-count'))).toBe('1');
});

test('Go to controller works before connecting and badge scans do not send anything to a hat', async ({ page }) => {
  await page.goto('./');
  const controllerReady = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Go to LED Hat Controller', exact: true }).click();
  const controller = await controllerReady;
  await expect(controller.locator('#status')).toContainText('Disconnected');
  await expect(controller.getByRole('tab')).toHaveText(['Connect hat', 'Scan']);
  for (const name of ['Presets', 'Sound', 'Settings'])
    await expect(controller.locator(`[data-tab=${name.toLowerCase()}]`)).toBeHidden();
  await expect(controller.locator('#sound-start')).toBeDisabled();
  expect(await controller.locator('#view-sound').locator('input,button,select').evaluateAll((nodes) => nodes.every((node) => (node as HTMLInputElement).disabled))).toBe(true);
  await controller.getByRole('tab', { name: 'Scan', exact: true }).click();
  await expect(controller.locator('#qr-start')).toBeEnabled();
  await controller.locator('#view-scan details').filter({ hasText: 'Enter scan data manually' }).locator('summary').click();
  await controller.locator('#qr-raw').fill('Ada Lovelace');
  await controller.locator('#qr-submit').click();
  await expect(controller.locator('#qr-status')).toContainText('Scanned: Hi Ada Lovelace!');
  await expect(controller.locator('#qr-status')).toContainText('nothing sent to the hat');
  expect(await controller.evaluate(() => localStorage.getItem('test-picker-count'))).toBeNull();
});

test('Return focuses the existing controller and reopens it if closed, without pairing again', async ({ page }) => {
  const { owner, controller } = await connectThroughTab(page);
  await controller.evaluate(() => { (window as unknown as { focusMarker: string }).focusMarker = 'keep-this-page'; });
  await owner.bringToFront();
  await owner.getByRole('link', { name: 'Return to LED Hat Controller', exact: true }).click();
  await expect.poll(() => controller.evaluate(() => document.hasFocus())).toBe(true);
  expect(await controller.evaluate(() => (window as unknown as { focusMarker: string }).focusMarker)).toBe('keep-this-page');
  await controller.close();
  const nextReady = owner.waitForEvent('popup');
  await owner.getByRole('link', { name: 'Return to LED Hat Controller', exact: true }).click();
  const next = await nextReady;
  await expect(next.locator('#status')).toContainText('Ready: iledcolor-FAKE');
  expect(await next.evaluate(() => localStorage.getItem('test-picker-count'))).toBe('1');
});

test('connecting after opening the controller attaches it without reloading or losing scan data', async ({ page }) => {
  await page.goto('./');
  const controllerReady = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Go to LED Hat Controller', exact: true }).click();
  const controller = await controllerReady;
  await controller.getByRole('tab', { name: 'Scan', exact: true }).click();
  await controller.locator('#view-scan details').filter({ hasText: 'Enter scan data manually' }).locator('summary').click();
  await controller.locator('#qr-raw').fill('Ada');
  await page.getByRole('button', { name: 'Connect LED hat', exact: true }).click();
  await expect(controller.locator('#status')).toContainText('Ready: iledcolor-FAKE');
  await expect(controller.locator('#qr-raw')).toHaveValue('Ada');
});

test('going to the controller ignores stale saved Bluetooth identity when no live link exists', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => { localStorage.setItem('iledcolor.lastWebBluetoothHat', 'stale-hat'); localStorage.setItem('iledcolor.lastWebBluetoothHatName', 'Old hat'); });
  const controllerReady = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Go to LED Hat Controller', exact: true }).click();
  const controller = await controllerReady;
  await expect(controller.getByRole('tab', { name: 'Scan', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(controller.locator('#status')).toContainText('Disconnected');
  expect(await controller.evaluate(() => localStorage.getItem('test-picker-count'))).toBeNull();
});

test('Install app is available on the connection screen and invokes the browser install prompt', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#btn-install')).toBeVisible();
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperty(event, 'prompt', { value: async () => sessionStorage.setItem('install-prompt-called', 'yes') });
    window.dispatchEvent(event);
  });
  await page.locator('#btn-install').click();
  expect(await page.evaluate(() => sessionStorage.getItem('install-prompt-called'))).toBe('yes');
});

test('Go selects Scan in an already-open disconnected controller without replacing its document', async ({ page }) => {
  await page.goto('./');
  const opened = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Go to LED Hat Controller', exact: true }).click();
  const controller = await opened;
  await controller.getByRole('tab', { name: 'Connect hat', exact: true }).click();
  await controller.evaluate(() => { (window as unknown as { marker: string }).marker = 'same-document'; });
  await page.getByRole('link', { name: 'Go to LED Hat Controller', exact: true }).click();
  await expect(controller.getByRole('tab', { name: 'Scan', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await controller.evaluate(() => (window as unknown as { marker: string }).marker)).toBe('same-document');
  await expect.poll(() => controller.evaluate(() => document.hasFocus())).toBe(true);
});

test('Return uses a normal named link when scripted tab opening is blocked', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole('button', { name: 'Connect LED hat', exact: true }).click();
  await expect(page.locator('#link-status')).toContainText('Connected to LED hat');
  await expect(page.locator('#link-error')).toContainText('Use Return');
  const opened = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Return to LED Hat Controller', exact: true }).click();
  const controller = await opened;
  await expect(controller.locator('#status')).toContainText('Ready');
  expect(await controller.evaluate(() => localStorage.getItem('test-picker-count'))).toBe('1');
});

test('Connect hat repeatedly focuses the existing idle connection tab without reloading it', async ({ page, context }) => {
  await page.goto('./');
  await page.evaluate(() => { (window as unknown as { marker: string }).marker = 'owner-document'; });
  const opened = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Go to LED Hat Controller', exact: true }).click();
  const controller = await opened;
  for (let cycle = 0; cycle < 3; cycle++) {
    await controller.getByRole('tab', { name: 'Connect hat', exact: true }).click();
    await controller.getByRole('link', { name: 'Connect hat', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await expect(controller.locator('#conn-msg')).toContainText('Opening LED Hat Connection');
    expect(context.pages()).toHaveLength(2);
    expect(await page.evaluate(() => (window as unknown as { marker: string }).marker)).toBe('owner-document');
  }
});

test('Connect hat follows its normal link when scripted opening is blocked', async ({ page }) => {
  await page.goto('./?controller=1');
  await page.evaluate(() => { window.open = () => null; });
  const opened = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Connect hat', exact: true }).click();
  const owner = await opened;
  await expect(owner).toHaveTitle('LED Hat Connection');
  await expect(owner.getByRole('button', { name: 'Connect LED hat', exact: true })).toBeEnabled();
});
