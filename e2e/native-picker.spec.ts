import { expect, test } from '@playwright/test';
import { installFakeHat } from './hat';

test.use({ channel: process.env.LED_HAT_CHOOSER_CHANNEL });

test('Connect LED hat opens the real browser chooser before any tab switch', async ({ page, context }) => {
  await installFakeHat(context, true);
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
  await page.getByRole('button', { name: 'Connect LED hat', exact: true }).click();
  await expect.poll(() => Boolean(prompt?.id)).toBe(true);
  await expect(page.locator('#link-error')).toHaveText('');
  expect(context.pages()).toHaveLength(1);
  await cdp.send('DeviceAccess.cancelPrompt', { id: prompt!.id });
  await expect(page.locator('#link-error')).toContainText('selection cancelled');
  await expect(page.locator('#link-connect')).toBeEnabled();
  await emulator.send('BluetoothEmulation.disable');
  await emulator.detach();
});
