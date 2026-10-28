import { expect, test } from '@playwright/test';

test.use({
  channel: process.env.LED_HAT_CHOOSER_CHANNEL,
  // Linux Chromium gates Web Bluetooth. Enable only this API in this test's
  // disposable browser; Windows/Edge still exercises its unmodified defaults.
  launchOptions: { args: process.platform === 'linux' ? ['--enable-features=WebBluetooth', '--enable-blink-features=WebBluetooth'] : [] },
});

test('Connect LED hat keeps the real chooser on the active connection tab', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  const emulator = await context.browser()!.newBrowserCDPSession();
  await emulator.send('BluetoothEmulation.enable', { state: 'powered-on', leSupported: true });
  await emulator.send('BluetoothEmulation.simulatePreconnectedPeripheral', {
    address: '01:02:03:04:05:06', name: 'iledcolor-FAKE', manufacturerData: [],
    knownServiceUuids: ['0000a950-0000-1000-8000-00805f9b34fb'],
  });
  await cdp.send('DeviceAccess.enable');
  let prompt: { id: string; devices: Array<{ id: string; name: string }> } | undefined;
  cdp.on('DeviceAccess.deviceRequestPrompted', (event) => { prompt = event; });
  await page.goto('./');
  expect(await page.evaluate(() => typeof navigator.bluetooth?.requestDevice),
    'The real chooser test requires native Web Bluetooth in its browser').toBe('function');
  await page.getByRole('button', { name: 'Connect LED hat', exact: true }).click();
  await expect.poll(() => Boolean(prompt?.id)).toBe(true);
  await expect(page.locator('#link-error')).toHaveText('');
  expect(context.pages()).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
  await cdp.send('DeviceAccess.cancelPrompt', { id: prompt!.id });
  await expect(page.locator('#link-error')).toContainText('selection cancelled');
  await expect(page.locator('#link-connect')).toBeEnabled();
  await expect.poll(() => context.pages().length).toBe(1);
  await emulator.send('BluetoothEmulation.disable');
  await emulator.detach();
});
