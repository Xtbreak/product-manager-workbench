import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

test.use({
  deviceScaleFactor: 2,
  viewport: { width: 1361, height: 813 },
  launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
});

test('the browser divider stays centered while resizing and SendBox tools share a neutral baseline', async ({
  page,
}, testInfo) => {
  // Mount the actual renderer and pointer/keyboard handlers without Electron, guests or persistent services.
  const stubs: Record<string, string> = {
    '@/common/config/configService': 'export const configService = { whenReady: async () => {}, get: () => null }',
    '@/common/adapter/ipcBridge':
      'const event = { on: () => () => {}, provider: () => () => {}, invoke: async () => ({success:false}) }; export const sessionMention = {}; export const application = new Proxy({}, {get: () => event});',
    '@/renderer/utils/platform': 'export const isElectronDesktop = () => false, isMacOS = () => true;',
    './ReplySyncPanel': 'export default () => null; export const ReplyBrowserLock = () => null;',
    './DirectMessages': 'export default () => null;',
    './BrowserPane': 'export default () => null;',
    '@/renderer/hooks/chat/useInputFocusRing': 'export const useInputFocusRing = () => ({});',
    '@/common': 'export const ipcBridge = {};',
    '@/renderer/services/FileService': 'export const FileService = {};',
    '@/renderer/pages/conversation/Preview':
      'export const usePreviewContext = () => ({setSendBoxHandler: () => {}, domSnippets: []});',
    '@/renderer/pages/conversation/Messages/hooks': 'export const useMessageList = () => [];',
    '@/renderer/hooks/file/useConversationExport': 'export const useConversationExport = () => ({menuItems:[]});',
    '@/renderer/components/chat/BtwOverlay/useBtwCommand': 'export const useBtwCommand = () => ({});',
    '@/renderer/components/chat/BtwOverlay': 'export default () => null;',
    '@/renderer/components/media/UploadProgressBar': 'export default () => null;',
    '@/renderer/components/chat/SpeechInputButton': 'export default () => null;',
    './AccountPanel': 'export default () => null;',
    './FeishuAuthorization': 'export default () => null;',
    '@/renderer/pages/settings/components/SettingsSider': 'export default () => null;',
    '@/renderer/components/layout/WindowControls': 'export default () => null;',
  };
  for (const hook of [
    './useRestoreConversation',
    '@/renderer/hooks/system/useDeepLink',
    ...['useNotificationClick', 'useBrowserNotification', 'useDesktopTurnNotification'].map(
      (h) => '@/renderer/hooks/system/notification/' + h
    ),
  ]) {
    stubs[hook] = 'export const ' + hook.split('/').at(-1) + ' = () => {};';
  }
  const app = await build({
    stdin: {
      contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {MemoryRouter, Routes, Route} from 'react-router-dom';
      import i18n from 'i18next';
      import {initReactI18next} from 'react-i18next';
      import SendBox from '@/renderer/components/chat/SendBox';
      import FileAttachButton from '@/renderer/components/media/FileAttachButton';
      import ContextUsageIndicator from '@/renderer/components/agent/ContextUsageIndicator';
      i18n.use(initReactI18next).init({lng:'en',resources:{en:{translation:{}}},initImmediate:false});
      import Workbench from '@/renderer/pages/Workbench';
      import '@/renderer/styles/themes/base.css';
      import '@arco-design/web-react/dist/css/arco.css';
      const tools = <FileAttachButton openFileSelector={() => {}} openFolderSelector={() => {}}/>;
      const info = <ContextUsageIndicator tokenUsage={{total_tokens:1}} context_limit={0}/>;
      const box = <SendBox value="" onChange={()=>{}} onSend={()=>{}} onAddToDraft={()=>{}}
        defaultMultiLine lockMultiLine tools={tools} rightTools={info}/>;
      createRoot(document.getElementById('app')).render(<MemoryRouter><Routes><Route element={<Workbench/>}><Route index element={box}/></Route></Routes></MemoryRouter>);
    `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    plugins: [
      {
        name: 'isolated-workbench',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'stub' } : undefined
          );
          builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path] }));
        },
      },
    ],
    outdir: 'out',
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'empty', '.ttf': 'empty', '.woff': 'empty', '.svg': 'dataurl', '.png': 'empty' },
    logLevel: 'silent',
  });
  await page.route('**/*', (route) => {
    const ext = path.extname(new URL(route.request().url()).pathname);
    if (!ext)
      return route.fulfill({
        contentType: 'text/html',
        body: '<meta charset="utf-8"><style>html,body,#app{margin:0;height:100%}.flex{display:flex}.items-center{align-items:center}.justify-between{justify-content:space-between}</style><link rel="stylesheet" href="/app.css"><div id="app"></div><script src="/app.js"></script>',
      });
    const asset = app.outputFiles.find((f) => f.path.endsWith(ext));
    return asset
      ? route.fulfill({ contentType: ext === '.css' ? 'text/css' : 'text/javascript', body: asset.text })
      : route.abort();
  });
  await page.goto('http://workbench.test');
  const divider = page.getByRole('separator');
  await expect(divider).toBeVisible();
  const geometry = () =>
    divider.evaluate((el) => {
      const right = document.getElementById('workbench-source-browsers')!.getBoundingClientRect();
      const center = el.parentElement!.querySelector('[aria-label="common.workbench.feishu"]')!.getBoundingClientRect();
      const gutterCenter = (center.right + right.left) / 2;
      const offset = (pseudo: string) => {
        const style = getComputedStyle(el, pseudo);
        return Math.abs(
          el.getBoundingClientRect().left + parseFloat(style.left) + parseFloat(style.width) / 2 - gutterCenter
        );
      };
      return {
        gap: right.left - center.right,
        handleOffset: offset('::before'),
        lineOffset: offset('::after'),
        centerWidth: center.width,
        rightWidth: right.width,
        hover: getComputedStyle(el, '::after').visibility,
      };
    });
  const samples: Awaited<ReturnType<typeof geometry>>[] = [];
  const verify = async () => {
    const v = await geometry();
    expect(Math.abs(v.gap - 8)).toBeLessThan(0.1);
    expect(v.handleOffset * 2).toBeLessThanOrEqual(1);
    expect(v.lineOffset * 2).toBeLessThanOrEqual(1);
    samples.push(v);
    return v;
  };
  await verify();
  await divider.hover();
  expect((await verify()).hover).toBe('visible');
  const box = (await divider.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + box.height / 2);
  await expect.poll(async () => (await geometry()).centerWidth).toBeLessThan(360);
  await verify();
  await page.mouse.up();
  await verify();
  await divider.focus();
  await page.keyboard.press('End');
  await expect.poll(async () => (await geometry()).centerWidth).toBeCloseTo(16, 0);
  await verify();
  await page.keyboard.press('Home');
  await expect.poll(async () => (await geometry()).rightWidth).toBeCloseTo(260, 0);
  await verify();
  await testInfo.attach('divider-geometry', { contentType: 'application/json', body: JSON.stringify(samples) });
  const info = page.locator('.context-usage-indicator');
  await page.addStyleTag({ content: '*,*::before,*::after{transition-duration:0s!important}' });
  const verifyToolbar = async (theme: 'light' | 'dark') => {
    await page.mouse.move(0, 0);
    await page.evaluate((palette) => {
      document.body.setAttribute('arco-theme', palette);
      document.documentElement.dataset.theme = palette;
    }, theme);
    const values = await page.locator('.sendbox-panel').evaluate((el) => {
      const token = (name: string) => {
        const swatch = document.createElement('span');
        swatch.style.color = 'var(' + name + ')';
        el.append(swatch);
        const color = getComputedStyle(swatch).color;
        swatch.remove();
        return color;
      };
      const buttons = [
        '[data-testid=aionrs-attach-folder-btn]',
        '[data-testid=sendbox-add-to-draft-btn]',
        '.context-usage-indicator',
      ];
      const icons = buttons.map((selector) => {
        const btn = el.querySelector<HTMLElement>(selector)!;
        const svg = btn.querySelector('svg')!;
        const bounds = svg.getBoundingClientRect();
        const control = btn.getBoundingClientRect();
        const stroke = getComputedStyle(svg.querySelector('[stroke]') ?? svg).stroke;
        return {
          width: control.width,
          height: control.height,
          iconWidth: bounds.width,
          center: bounds.y + bounds.height / 2,
          stroke,
        };
      });
      return { icons, muted: token('--wb-muted'), text: token('--wb-text') };
    });
    await testInfo.attach('controls-' + theme, { contentType: 'application/json', body: JSON.stringify(values) });
    for (const icon of values.icons) {
      expect([icon.width, icon.height]).toEqual([28, 28]);
      expect(Math.abs(icon.center - values.icons[0].center) * 2).toBeLessThanOrEqual(1);
      expect(icon.stroke).toBe(values.muted);
    }
    await info.hover();
    await expect(info).toHaveCSS('color', values.text);
  };
  await verifyToolbar('light');
  await verifyToolbar('dark');
});
