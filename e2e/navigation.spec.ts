import { expect, test } from '@playwright/test';
import { openCustomSection, connectHat, waitForServiceWorker } from './hat';

test('six icon tabs keep presets first and device controls on Settings', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#mock');
  await connectHat(page, 'presets');
  await waitForServiceWorker(page);
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(6);
  expect(await tabs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tab'))))
    .toEqual(['presets', 'custom', 'approach', 'scan', 'sound', 'settings']);
  for (const tab of await tabs.all()) await expect(tab.locator('svg')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Presets' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#view-presets')).toBeVisible();
  await expect(page.locator('#view-create')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Custom' }).click();
  await expect(page.locator('#custom-text > summary')).toBeVisible();
  await expect(page.locator('#brightness')).toBeHidden();
  await openCustomSection(page, 'text');
  await expect(page.locator('#send-help')).toContainText('Send it to your connected hat');
  await expect(page.locator('#btn-send')).toBeEnabled();
  await openCustomSection(page, 'text');
  await page.fill('#c-str', 'Hi');
  await openCustomSection(page, 'text');
  await page.click('#c-save-start');
  await page.fill('#c-name', 'My saved greeting');
  await page.locator('#c-save-form').getByRole('button', { name: 'Save preset' }).click();
  await expect(page.locator('#c-save-note')).toContainText('Saved');
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
  await page.getByRole('tab', { name: 'Presets' }).click();
  await page.locator('.preset-list li', { hasText: 'My saved greeting' }).locator('[data-act=send]').click();
  await expect(page.locator('#presets-msg')).toContainText('Upload confirmed.');
  await expect(page.getByRole('tab', { name: 'Presets' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#c-str')).toHaveValue('Hi');
  await page.reload();
  await connectHat(page);
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
  await connectHat(page);
  await waitForServiceWorker(page);
  const connect = page.getByRole('tab', { name: 'Custom' });
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
  const start = await page.locator('#qr-text-start').boundingBox();
  const greeting = await page.locator('#qr-template').boundingBox();
  expect(start!.y).toBeLessThan(greeting!.y);
  await expect(page.locator('#qr-status')).toHaveText('Ready to scan a badge.');
  await expect(page.getByRole('button', { name: 'Scan', exact: true })).toBeEnabled();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Settings' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Presets' })).toBeFocused();
});

test('all tabs fit narrow, landscape, desktop and enlarged text layouts', async ({ page }) => {
  await page.goto('/#mock');
  await connectHat(page);
  await openCustomSection(page, 'text');
  await page.click('#c-save-start');
  await page.fill('#c-name', 'A'.repeat(60));
  await page.locator('#c-save-form').getByRole('button', { name: 'Save preset' }).click();
  await expect(page.locator('#c-save-note')).toContainText('Saved');
  for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 },
    { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const name of ['Presets', 'Custom', 'Approach', 'Scan', 'Sound', 'Settings']) {
      await page.getByRole('tab', { name, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const tab = await page.getByRole('tab', { name, exact: true }).boundingBox();
      expect(tab!.height).toBeGreaterThanOrEqual(44);
      expect(tab!.width).toBeGreaterThanOrEqual(44);
      if (name === 'Scan') {
        const action = await page.locator('#qr-text-start').boundingBox();
        expect(action!.y + action!.height).toBeLessThan(tab!.y);
      }
    }
  }
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addStyleTag({ content: 'body { font-size:32px; }' });
  for (const name of ['Presets', 'Custom', 'Approach', 'Scan', 'Sound', 'Settings']) {
    await page.getByRole('tab', { name, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
