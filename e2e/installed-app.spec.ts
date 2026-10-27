import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { installFakeHat } from './hat';

test('installed web app keeps its connection while opening and refreshing the controller', async ({ baseURL }) => {
  test.setTimeout(90000);
  const parent = resolve(tmpdir());
  const profile = await mkdtemp(join(parent, 'led-hat-pwa-test-'));
  if (dirname(resolve(profile)) !== parent) throw new Error('Unexpected test profile path');
  const appContext = await chromium.launchPersistentContext(profile, { headless: process.env.LED_HAT_PWA_HEADED !== '1', ignoreDefaultArgs: ['--disable-popup-blocking'], channel: process.env.LED_HAT_PWA_CHANNEL || 'chromium' });
  const cdp = await appContext.browser()!.newBrowserCDPSession();
  const manifestId = new URL('./', baseURL!).href;
  try {
    await installFakeHat(appContext);
    const setup = appContext.pages()[0] ?? await appContext.newPage();
    await setup.goto(manifestId);
    await setup.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await cdp.send('PWA.install', { manifestId, installUrlOrBundleUrl: manifestId });
    await cdp.send('PWA.changeAppUserSettings', { manifestId, displayMode: 'standalone' });
    await setup.goto('about:blank');
    await setup.evaluate(() => { window.name = ''; });
    const launched = appContext.waitForEvent('page');
    void launched.catch(() => undefined);
    await cdp.send('PWA.launch', { manifestId });
    const app = await launched;
    await expect(app).toHaveTitle('LED Hat Connection');
    expect(await app.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
    await expect(app.locator('#btn-install')).toBeHidden();
    const opened = app.waitForEvent('popup');
    await app.getByRole('button', { name: 'Connect LED hat', exact: true }).click();
    const controller = await opened;
    await expect(controller.locator('#status')).toContainText('Ready: iledcolor-FAKE');
    await expect(controller.getByRole('tab')).toHaveText(['Presets', 'Custom', 'Sound', '', 'Scan']);
    await controller.reload();
    await expect(controller.locator('#status')).toContainText('Ready: iledcolor-FAKE');
    await app.getByRole('link', { name: 'Return to LED Hat Controller', exact: true }).click();
    await expect.poll(() => controller.evaluate(() => document.hasFocus())).toBe(true);
    await controller.locator('#status-toggle').click();
    await controller.locator('#btn-status-disconnect').click();
    await expect(controller.getByRole('tab', { name: 'Connect hat', exact: true })).toHaveAttribute('aria-selected', 'true');
    const pageCount = appContext.pages().length;
    await controller.getByRole('tab', { name: 'Connect hat', exact: true }).click();
    await controller.locator('#btn-connect').click();
    await expect.poll(() => app.evaluate(() => document.hasFocus())).toBe(true);
    expect(appContext.pages()).toHaveLength(pageCount);
    await app.getByRole('button', { name: 'Connect LED hat', exact: true }).click();
    await expect(controller.locator('#status')).toContainText('Ready: iledcolor-FAKE');
    await expect(controller.getByRole('tab', { name: 'Presets', exact: true })).toHaveAttribute('aria-selected', 'true');
  } finally {
    await cdp.send('PWA.uninstall', { manifestId }).catch(() => undefined);
    await appContext.close();
    if (dirname(resolve(profile)) === parent) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
