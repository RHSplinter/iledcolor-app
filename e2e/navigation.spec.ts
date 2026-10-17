import { expect, test } from '@playwright/test';

test('five icon tabs keep content on Connect and device controls on Settings', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#mock');
  await expect(page.locator('#offline')).toHaveText('Ready for offline use', { timeout: 20000 });
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(5);
  expect(await tabs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tab'))))
    .toEqual(['connect', 'approach', 'scan', 'sound', 'settings']);
  for (const tab of await tabs.all()) await expect(tab.locator('svg')).toHaveCount(1);
  await expect(page.locator('#view-create, #view-presets')).toHaveCount(0);
  await expect(page.locator('#c-kind')).toBeVisible();
  await expect(page.locator('#brightness')).toBeHidden();
  await expect(page.locator('#send-help')).toContainText('edit and preview offline');
  await page.click('#btn-connect');
  await expect(page.locator('#btn-send')).toBeEnabled();
  await page.fill('#c-str', 'Hi');
  await page.fill('#c-name', 'My saved greeting');
  await page.click('#btn-save');
  await expect(page.locator('#send-note')).toContainText('Saved');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('#brightness')).toBeEnabled();
  await page.click('#btn-disp-off');
  await expect(page.locator('#dstate')).toHaveText('Off');
  await page.click('#btn-disp-on');
  await expect(page.locator('#dstate')).toHaveText('On');
  await page.locator('#brightness').fill('5');
  await expect(page.locator('#bstate')).toHaveText('confirmed');
  await page.getByText('Test patterns (dim, static)', { exact: true }).click();
  await page.click('#btn-test-corner');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.getByText('Protocol log', { exact: true }).click();
  await expect(page.locator('#trace')).not.toBeEmpty();
  await page.click('#btn-clearlog');
  await expect(page.locator('#trace')).toBeEmpty();
  await page.selectOption('#s-rot', '180');
  await page.check('#s-mh');
  await page.fill('#s-chunk', '100');
  await page.locator('#s-chunk').dispatchEvent('change');
  await page.fill('#s-delay', '25');
  await page.locator('#s-delay').dispatchEvent('change');
  await page.locator('.preset-list li', { hasText: 'My saved greeting' }).locator('[data-act=load]').click();
  await expect(page.getByRole('tab', { name: 'Connect' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#c-str')).toHaveValue('Hi');
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#s-rot')).toHaveValue('180');
  await expect(page.locator('#s-mh')).toBeChecked();
  await expect(page.locator('#s-chunk')).toHaveValue('100');
  await expect(page.locator('#s-delay')).toHaveValue('25');
  await expect(page.locator('#brightness')).toHaveValue('5');
  expect(errors).toEqual([]);
});

test('keyboard tabs, scan-first ordering and every marquee choice are accessible', async ({ page }) => {
  await page.goto('/#mock');
  await expect(page.locator('#offline')).toHaveText('Ready for offline use', { timeout: 20000 });
  const connect = page.getByRole('tab', { name: 'Connect' });
  await connect.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Approach' })).toBeFocused();
  const choices = page.locator('#view-approach option[value=span]');
  await expect(choices).toHaveCount(5);
  for (const choice of await choices.all()) await expect(choice).toContainText('unstable');
  await page.selectOption('[data-tier=pair][data-field=mode]', 'span');
  await expect(page.locator('[data-marquee-warning=pair]')).toBeVisible();
  await page.selectOption('[data-tier=pair][data-field=mode]', 'individual');
  await expect(page.locator('[data-marquee-warning=pair]')).toBeHidden();
  await page.getByRole('tab', { name: 'Approach' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Scan' })).toBeFocused();
  const start = await page.locator('#qr-start').boundingBox();
  const profile = await page.locator('#qr-profile').boundingBox();
  expect(start!.y).toBeLessThan(profile!.y);
  await expect(page.locator('#qr-ready')).toContainText('Connect');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Settings' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(connect).toBeFocused();
});

test('all tabs fit narrow, landscape, desktop and enlarged text layouts', async ({ page }) => {
  await page.goto('/#mock');
  await page.fill('#c-name', 'A'.repeat(60));
  await page.click('#btn-save');
  await expect(page.locator('#send-note')).toContainText('Saved');
  for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 },
    { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const name of ['Connect', 'Approach', 'Scan', 'Sound', 'Settings']) {
      await page.getByRole('tab', { name, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const tab = await page.getByRole('tab', { name, exact: true }).boundingBox();
      expect(tab!.height).toBeGreaterThanOrEqual(44);
      expect(tab!.width).toBeGreaterThanOrEqual(44);
      if (name === 'Scan') {
        const action = await page.locator('#qr-start').boundingBox();
        expect(action!.y + action!.height).toBeLessThan(tab!.y);
      }
    }
  }
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addStyleTag({ content: 'body { font-size:32px; }' });
  for (const name of ['Connect', 'Approach', 'Scan', 'Sound', 'Settings']) {
    await page.getByRole('tab', { name, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
