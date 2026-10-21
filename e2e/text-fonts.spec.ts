import { expect, test, type Page } from '@playwright/test';

const fonts = ['silkscreen', 'tiny5', 'press-start', 'dotgothic', 'bitcount'];

async function pixels(page: Page, selector: string) {
  return page.locator(selector).evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const scale = canvas.width / 32;
    return Array.from({ length: 32 * 16 }, (_, i) => {
      const offset = (Math.floor(i / 32) * scale * canvas.width + (i % 32) * scale) * 4;
      return Array.from(data.slice(offset, offset + 3)).join(',');
    });
  });
}

test('five distinct, crisp fonts have one-pixel spacing and match preview and mock uploads offline', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#mock');
  await expect(page.locator('#offline')).toHaveText('Ready for offline use', { timeout: 20_000 });
  await page.fill('#c-str', 'Hi!');
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#s-font option')).toHaveCount(5);
  await expect.poll(async () => (await pixels(page, '#font-preview')).includes('255,255,255')).toBe(true);
  const samples: string[][] = [];
  for (const font of fonts) {
    await page.selectOption('#s-font', font);
    if (samples.length) await expect.poll(() => pixels(page, '#font-preview')).not.toEqual(samples.at(-1));
    const sample = await pixels(page, '#font-preview');
    expect(new Set(sample)).toEqual(new Set(['0,0,0', '255,255,255']));
    const columns = Array.from({ length: 32 }, (_, x) => sample.some((p, i) => i % 32 === x && p === '255,255,255'));
    const gaps: number[] = [];
    let gap = 0;
    for (let x = 1; x <= columns.lastIndexOf(true); x++) {
      if (!columns[x]) gap++;
      else if (gap) { gaps.push(gap); gap = 0; }
    }
    expect(columns[0]).toBe(true);
    expect(gaps).toEqual([1, 1]);
    const rows = Array.from({ length: 16 }, (_, y) => sample.slice(y * 32, (y + 1) * 32).includes('255,255,255'));
    expect(rows.indexOf(true)).toBeGreaterThanOrEqual(0);
    expect(rows.lastIndexOf(true)).toBeLessThan(15);
    if (font === 'tiny5') expect(rows.lastIndexOf(true) - rows.indexOf(true) + 1).toBeGreaterThanOrEqual(10);
    samples.push(sample);
    await page.click('nav [data-tab=connect]');
    await expect.poll(() => pixels(page, '#preview')).toEqual(sample);
    if (font === fonts[0]) await page.click('#btn-connect');
    await expect(page.locator('#status')).toContainText('Ready');
    await page.click('#btn-send');
    await expect(page.locator('#send-note')).toHaveText('Upload confirmed.');
    await page.click('nav [data-tab=settings]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(new Set(samples.map((sample) => JSON.stringify(sample))).size).toBe(5);

  // Ascenders and descenders of the full-height font reach the top and bottom LED rows.
  await page.click('nav [data-tab=connect]');
  await page.fill('#c-str', 'bjg');
  await expect.poll(async () => {
    const image = await pixels(page, '#preview');
    return Array.from({ length: 16 }, (_, y) => image.slice(y * 32, (y + 1) * 32).includes('255,255,255')).every(Boolean);
  }).toBe(true);
  await page.click('nav [data-tab=settings]');

  await context.setOffline(true);
  await page.reload();
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#s-font')).toHaveValue('bitcount');
  for (const [index, font] of fonts.entries()) {
    await page.selectOption('#s-font', font);
    await expect.poll(() => pixels(page, '#font-preview')).toEqual(samples[index]);
  }
});

test('emoji keep their full bitmap and two blank columns on both sides in every font', async ({ page }) => {
  await page.goto('/#mock');
  const background = '0,0,0';
  const readText = async (text: string) => {
    const previous = await pixels(page, '#preview');
    await page.fill('#c-str', text);
    await expect.poll(() => pixels(page, '#preview')).not.toEqual(previous);
    return pixels(page, '#preview');
  };
  const widthOf = (image: string[]) => Math.max(...image.flatMap((pixel, index) => pixel === background ? [] : [index % 32])) + 1;
  for (const font of fonts) {
    await page.click('nav [data-tab=settings]');
    await page.selectOption('#s-font', font);
    await page.click('nav [data-tab=connect]');
    const letter = await readText('i');
    const letterWidth = widthOf(letter);
    for (const emoji of ['💜', '👩‍💻']) {
      const image = await readText(emoji);
      const emojiWidth = widthOf(image);
      expect(emojiWidth).toBeGreaterThan(0);
      const fullWidth = letterWidth * 2 + emojiWidth + 4;
      expect(fullWidth).toBeLessThanOrEqual(32);
      const expected = Array<string>(32 * 16).fill(background);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < letterWidth; x++) {
          expected[y * 32 + x] = letter[y * 32 + x]!;
          expected[y * 32 + letterWidth + emojiWidth + 4 + x] = letter[y * 32 + x]!;
        }
        for (let x = 0; x < emojiWidth; x++) expected[y * 32 + letterWidth + 2 + x] = image[y * 32 + x]!;
      }
      await page.fill('#c-str', `i${emoji}i`);
      await expect.poll(() => pixels(page, '#preview')).toEqual(expected);
      await expect(page.locator('#c-warn')).toBeEmpty();
    }
  }
});

test('old backups preserve the current font, excluded settings stay intact, invalid fonts fail atomically', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('nav [data-tab=settings]');
  await page.selectOption('#s-font', 'tiny5');
  const settings = {
    width: 32, height: 16, brightness: 4, dimensionsVerified: true,
    chunkSize: 492, interWriteDelayMs: 1, transform: { rotation: 0, mirrorH: false, mirrorV: false },
  };
  const importFile = async (data: unknown) => {
    await page.setInputFiles('#p-import', {
      name: 'fonts.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)),
    });
  };
  for (const version of [1, 2]) {
    await importFile({ app: 'iledcolor-app', version, settings, ...(version === 1 ? { presets: [] } : {}) });
    await expect(page.locator('#p-msg')).toContainText('Imported');
    await expect(page.locator('#s-font')).toHaveValue('tiny5');
  }
  await importFile({ app: 'iledcolor-app', version: 2, creations: [] });
  await expect(page.locator('#p-msg')).toContainText('Imported');
  await expect(page.locator('#s-font')).toHaveValue('tiny5');
  await importFile({ app: 'iledcolor-app', version: 2, settings: { ...settings, brightness: 9, textFont: 'Arial' } });
  await expect(page.locator('#p-msg')).toContainText('Import failed');
  await expect(page.locator('#s-font')).toHaveValue('tiny5');
  await expect(page.locator('#brightness')).toHaveValue('4');
  await page.reload();
  await page.click('nav [data-tab=settings]');
  await expect(page.locator('#s-font')).toHaveValue('tiny5');
  await expect(page.locator('#brightness')).toHaveValue('4');
});

test('changing the global font refreshes running Approach content without restarting', async ({ page }) => {
  await page.goto('/#mock');
  await page.click('#btn-connect');
  await expect(page.locator('#status')).toContainText('Ready');
  await page.click('nav [data-tab=approach]');
  await page.locator('[data-tier=solo][data-field=text]').fill('Hi!');
  await page.locator('[data-tier=solo][data-field=text]').dispatchEvent('change');
  await page.locator('[data-tier=solo][data-field=fg]').fill('#ffffff');
  await page.locator('[data-tier=solo][data-field=fg]').dispatchEvent('change');
  await page.fill('#ap-settle', '0');
  await page.locator('#ap-settle').dispatchEvent('change');
  await page.check('#ap-start');
  await expect(page.locator('#ap-caps .cap-note')).toHaveText('"Hi!"', { timeout: 15_000 });
  const previous = await pixels(page, '#ap-caps canvas');
  await page.click('nav [data-tab=settings]');
  await page.selectOption('#s-font', 'dotgothic');
  await expect.poll(() => pixels(page, '#font-preview')).not.toEqual(previous);
  const expected = await pixels(page, '#font-preview');
  await page.click('nav [data-tab=approach]');
  await expect.poll(() => pixels(page, '#ap-caps canvas'), { timeout: 15_000 }).toEqual(expected);
  await expect(page.locator('#ap-start')).toBeChecked();
  await page.uncheck('#ap-start');
});
