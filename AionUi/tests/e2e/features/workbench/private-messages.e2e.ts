import { expect, test, type Locator, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

test.use({ deviceScaleFactor: 2, launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

const buildFixture = () =>
  build({
    entryPoints: [path.resolve('tests/e2e/features/workbench/private-messages.fixture.tsx')],
    outdir: 'out',
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'empty', '.ttf': 'empty', '.woff': 'empty', '.svg': 'dataurl' },
    logLevel: 'silent',
  });

let app: Awaited<ReturnType<typeof buildFixture>>;
test.beforeAll(async () => {
  app = await buildFixture();
});
test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<html lang="zh"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="app"></div><script src="/fixture.js"></script></html>',
      });
    const file = app.outputFiles.find((f) => f.path.endsWith(path.extname(pathname)));
    return file
      ? route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: file.text })
      : route.abort();
  });
  await page.goto('http://workbench.test');
});

test('private messages adapt to the center width while keeping the Feishu layer sized', async ({ page }) => {
  const center = page.locator('#center'),
    contacts = page.getByRole('complementary'),
    conversation = page.getByRole('article');
  const width = async (w: number) =>
    center.evaluate((el, value) => {
      el.style.width = value + 'px';
    }, w);
  await expect(contacts).toBeVisible();
  const feishuTab = page.getByRole('tab', { name: '飞书' });
  const dmTab = page.getByRole('tab', { name: '私聊' });
  const sync = page.getByRole('button', { name: '同步全部' });
  await expect(feishuTab).toHaveCSS('color', 'rgb(107, 114, 128)');
  await expect(dmTab).toHaveCSS('color', 'rgb(17, 24, 39)');
  await expect(dmTab.locator('svg')).toHaveAttribute('width', '14');
  await expect(sync.locator('svg')).toHaveAttribute('width', '16');
  await expect(sync).toHaveCSS('color', 'rgb(255, 255, 255)');
  await feishuTab.hover();
  await expect(feishuTab).toHaveCSS('color', 'rgb(17, 24, 39)');
  expect((await contacts.boundingBox())?.width).toBe(260);
  await expect(page.getByText('Feishu guest')).toBeHidden();
  await expect(page.getByTestId('feishu')).toHaveCSS('display', 'flex');
  await expect(page.getByTestId('feishu')).toHaveCSS('visibility', 'hidden');
  await contacts.getByRole('button', { name: /小林/ }).click();
  const mine = conversation.getByText('早上好');
  await expect(mine).toBeVisible();
  await expect(mine).toHaveCSS('background-color', 'rgba(37, 99, 235, 0.11)');
  await page.evaluate(() => document.body.setAttribute('arco-theme', 'dark'));
  await expect(feishuTab).toHaveCSS('color', 'rgb(156, 163, 175)');
  await expect(dmTab).toHaveCSS('color', 'rgb(243, 244, 246)');
  await expect(sync).toHaveCSS('color', 'rgb(17, 24, 39)');
  await expect(mine).toHaveCSS('background-color', 'rgba(96, 165, 250, 0.16)');
  await width(560);
  const compactWidth = (await contacts.boundingBox())!.width;
  expect(compactWidth).toBeGreaterThanOrEqual(196);
  expect(compactWidth).toBeLessThanOrEqual(224);
  await expect(conversation).toBeVisible();
  await width(380);
  await expect(contacts).toBeHidden();
  await expect(page.getByRole('button', { name: '返回联系人列表' })).toBeVisible();
  await expect(sync).toHaveCSS('width', '28px');
  await expect(sync).toHaveCSS('height', '28px');
  await conversation.getByRole('button', { name: '返回联系人列表' }).click();
  await contacts.getByRole('button', { name: /小林/ }).focus();
  await page.keyboard.press('Enter');
  await expect(conversation.getByRole('button', { name: '返回联系人列表' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(contacts).toBeVisible();
  await expect(conversation).toBeHidden();
  await width(680);
  await expect(conversation.getByText('早上好')).toBeVisible();
  await page.getByRole('tab', { name: '飞书' }).click();
  await expect(page.getByText('Feishu guest')).toBeVisible();
});

const widths = [540, 720, 465, 400, 380];
async function setCenterWidth(page: Page, width: number) {
  await page.locator('#center').evaluate((el, value) => {
    el.style.width = value + 'px';
  }, width);
}

async function themePalette(page: Page, dark: boolean) {
  return page.evaluate((useDarkTheme) => {
    document.body.setAttribute('arco-theme', useDarkTheme ? 'dark' : 'light');
    const probe = document.createElement('span');
    document.body.append(probe);
    const color = (value: string) => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    const colors = {
      text: color('var(--wb-text)'),
      muted: color('var(--wb-muted)'),
      accent: color('rgb(var(--wb-accent-rgb))'),
      warning: color('var(--wb-warning-text)'),
      danger: color('var(--wb-danger-text)'),
    };
    probe.remove();
    return colors;
  }, dark);
}

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';
  test(`related comment count fits and the contact indicators survive at five center widths in ${theme}`, async ({
    page,
  }, testInfo) => {
    const palette = await themePalette(page, dark);
    const contacts = page.getByRole('complementary');
    const article = page.getByRole('article');
    const dy = contacts.getByRole('button', { name: /小林/ });
    const xhs = contacts.getByRole('button', { name: /周末计划/ });
    await expect(dy.getByLabel('待我回复', { exact: true })).toHaveCSS('background-color', palette.accent);
    await expect(dy.getByLabel('部分记录尚未同步', { exact: true })).toHaveCSS('color', palette.warning);
    const failure = contacts.getByRole('button', { name: /夏天来信/ });
    await expect(failure.locator('svg[aria-label]')).toHaveCSS('color', palette.danger);
    const syncing = contacts.getByRole('button', { name: /更新中的朋友/ });
    await expect(syncing.locator('svg[aria-label]')).toHaveCSS('color', palette.muted);
    await dy.click();
    await expect(article.getByRole('status')).toContainText('部分记录尚未同步');
    const toggle = article.getByRole('button', { name: /关联评论/ });
    const label = toggle.getByText('关联评论 (2)', { exact: true });
    const excerpt = toggle.getByText(/^这个方法我也试过/);
    const sizes = [];
    /* eslint-disable no-await-in-loop -- Each measurement needs the same selected contact at a different viewport width. */
    for (const width of widths) {
      await setCenterWidth(page, width);
      await expect(label).toBeVisible();
      const measured = await label.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const text = range.getBoundingClientRect();
        const bounds = el.getBoundingClientRect();
        return { laidOut: el.clientWidth, needed: el.scrollWidth, glyphs: text.width, box: bounds.width };
      });
      expect(measured.laidOut).toBeGreaterThan(0);
      expect(measured.needed, `label clipped at ${width}px`).toBeLessThanOrEqual(measured.laidOut);
      expect(measured.glyphs).toBeLessThanOrEqual(measured.box + 0.5);
      await expect(excerpt).toHaveCSS('text-overflow', 'ellipsis');
      expect(await excerpt.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      sizes.push({ width, ...measured });
      if (width === 540) {
        await expect(dy.locator('time')).toHaveText('11/24');
        const fitsName = await dy.locator('strong').evaluate((el) => {
          const canvas = document.createElement('canvas').getContext('2d')!;
          canvas.font = getComputedStyle(el).font;
          const firstTwo = Array.from(el.textContent || '')
            .slice(0, 2)
            .join('');
          return el.scrollWidth <= el.clientWidth || canvas.measureText(firstTwo + '…').width <= el.clientWidth;
        });
        expect(fitsName, 'at least two name characters fit before the ellipsis').toBe(true);
      }
      await page.locator('#center').screenshot({ path: testInfo.outputPath(`dm-${theme}-${width}.png`) });
    }
    /* eslint-enable no-await-in-loop */
    const measurements = testInfo.outputPath('related-comment-measurements.json');
    await writeFile(measurements, JSON.stringify(sizes, null, 2));
    await testInfo.attach('related-comment-measurements', {
      path: measurements,
      contentType: 'application/json',
    });
    await setCenterWidth(page, 540);
    await xhs.click();
    await expect(article.locator('header strong')).toHaveText('周末计划');
    await expect(page.getByRole('status').filter({ hasText: '部分记录尚未同步' })).toHaveCount(0);
    await expect(page.locator('#center > div').first().getByLabel('部分记录尚未同步')).toBeVisible();

    await contacts.getByRole('textbox').fill('无匹配的唯一检索词');
    const empty = contacts.getByText('没有匹配的联系人', { exact: true });
    const offset = await empty.evaluate((el) => {
      const text = document.createRange();
      const textNode = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!;
      text.selectNodeContents(textNode);
      const list = el.parentElement!.getBoundingClientRect();
      const icon = el.querySelector('svg')!.getBoundingClientRect();
      return (text.getBoundingClientRect().bottom + icon.top - list.top - list.bottom) / 2;
    });
    expect(Math.abs(offset), 'empty icon and text centered within the list').toBeLessThanOrEqual(6);
  });

  test(`interactive DM controls keep theme colors and a single visible focus ring in ${theme}`, async ({ page }) => {
    const palette = await themePalette(page, dark);
    const contacts = page.getByRole('complementary');
    const article = page.getByRole('article');
    const row = contacts.getByRole('button', { name: /小林/ });
    await row.click();
    const toggle = article.getByRole('button', { name: /关联评论/ });
    await toggle.click();
    const controls = [
      contacts.getByRole('button', { name: /^有私聊/ }),
      row,
      toggle,
      article.getByRole('button', { name: '原评论', exact: true }).first(),
      article.getByRole('listitem').first().getByRole('button', { name: '原评论' }),
      article.getByRole('button', { name: '前往右侧账号' }),
      article.getByRole('button', { name: '去右侧浏览器回复' }),
    ];
    const schemeColors = [palette.text, palette.muted, palette.accent];
    const checkColor = async (control: Locator) => {
      const color = await control.evaluate(async (el) => {
        const transitions = el.getAnimations().filter((a) => a instanceof CSSTransition);
        await Promise.all(transitions.map((transition) => transition.finished));
        return getComputedStyle(el).color;
      });
      expect(schemeColors, (await control.getAttribute('aria-label')) || (await control.innerText())).toContain(color);
    };
    /* eslint-disable no-await-in-loop -- The controls share one pointer and one keyboard focus. */
    for (const control of controls) {
      await control.hover();
      await checkColor(control);
      await page.mouse.down();
      try {
        await checkColor(control);
      } finally {
        await page.mouse.move(1000, 600);
        await page.mouse.up();
      }
      await page.keyboard.press('Tab');
      await control.focus();
      await expect(control).toBeFocused();
      await checkColor(control);
    }
    /* eslint-enable no-await-in-loop */
    const update = article.getByRole('button', { name: '更新', exact: true });
    await update.focus();
    await expect(update).toBeFocused();
    expect(await update.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    await expect(update).toHaveCSS('outline-style', 'solid');
    await expect(update).toHaveCSS('box-shadow', 'none');
  });
}
