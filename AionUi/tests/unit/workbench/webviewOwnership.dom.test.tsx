import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import WebviewHost from '@/renderer/components/media/WebviewHost';
const report = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
vi.mock('@/common', () => ({ ipcBridge: { application: { reportBrowserWebContentsId: { invoke: report } } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  report.mockClear();
});
function ready(view: Element | null) {
  Object.assign(view!, {
    getWebContentsId: () => 42,
    executeJavaScript: () => Promise.resolve(),
    canGoBack: () => false,
    canGoForward: () => false,
  });
  fireEvent(view!, new Event('dom-ready'));
}
it('keeps background account page loads from taking over the AI bridge', () => {
  const { container } = render(
    <WebviewHost url='https://example.com' partition='persist:second' agentControl={false} />
  );
  ready(container.querySelector('webview'));
  expect(report).not.toHaveBeenCalled();
  expect(container.querySelector('webview')?.getAttribute('partition')).toBe('persist:second');
});
it('retains AI access to the designated main account', () => {
  const { container } = render(<WebviewHost url='https://example.com' partition='persist:primary' agentControl />);
  ready(container.querySelector('webview'));
  expect(report).toHaveBeenCalledWith({ webContentsId: 42 });
});
it('does not replace the top-level page when an embedded frame navigates', () => {
  const { container } = render(<WebviewHost url='https://example.com' agentControl={false} />);
  const view = container.querySelector('webview')!;
  ready(view);
  fireEvent(
    view,
    Object.assign(new Event('did-navigate-in-page'), { url: 'https://example.com/frame', isMainFrame: false })
  );
  expect(view.getAttribute('src')).toBe('https://example.com');
});
it('keeps subframe loading failures from reporting the whole page as failed', () => {
  const failed = vi.fn();
  const { container } = render(<WebviewHost url='https://example.com' agentControl={false} onDidFailLoad={failed} />);
  const view = container.querySelector('webview')!;
  fireEvent(
    view,
    Object.assign(new Event('did-fail-load'), { isMainFrame: false, errorCode: -105, errorDescription: 'frame DNS' })
  );
  expect(failed).not.toHaveBeenCalled();
  fireEvent(
    view,
    Object.assign(new Event('did-fail-load'), { isMainFrame: true, errorCode: -105, errorDescription: 'page DNS' })
  );
  expect(failed).toHaveBeenCalledWith(-105, 'page DNS');
});

it('reveals the selected account before focusing its browser without replacing its profile', async () => {
  const { focusAccountBrowser } = await import('@/renderer/pages/Workbench/focusAccountBrowser');
  const layer = document.createElement('div');
  layer.dataset.workbenchAccountId = 'second';
  layer.hidden = true;
  const view = document.createElement('webview');
  view.tabIndex = 0;
  Object.assign(view, { getWebContentsId: () => 91 });
  layer.append(view);
  document.body.append(layer);
  try {
    const selected: string[] = [];
    expect(
      await focusAccountBrowser(91, async (id) => {
        selected.push(id);
        layer.hidden = false;
      })
    ).toBe(true);
    expect(selected).toEqual(['second']);
    expect(document.activeElement).toBe(view);
  } finally {
    layer.remove();
  }
});

it('preserves page login clicks and form submissions', () => {
  const { container } = render(<WebviewHost url='https://example.com' agentControl={false} />);
  const scripts: string[] = [];
  const view = container.querySelector('webview')!;
  Object.assign(view, {
    getWebContentsId: () => 42,
    executeJavaScript: (script: string) => {
      scripts.push(script);
      return Promise.resolve();
    },
    canGoBack: () => false,
    canGoForward: () => false,
  });
  fireEvent(view, new Event('dom-ready'));
  const doc = document.implementation.createHTMLDocument();
  const postMessage = vi.fn();
  const guest = { open: vi.fn(), postMessage };
  const script = scripts.find((value) => value.includes('__webviewHostInjected'))!;
  new Function('window', 'document', script)(guest, doc);
  const link = doc.createElement('a');
  link.href = 'https://example.com/explore';
  doc.body.append(link);
  const login = vi.fn((event: Event) => event.preventDefault());
  link.addEventListener('click', login);
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(login).toHaveBeenCalledOnce();
  expect(postMessage).not.toHaveBeenCalled();
  const form = doc.createElement('form');
  form.action = 'https://example.com/login';
  form.method = 'post';
  doc.body.append(form);
  const submit = new Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(submit);
  expect(submit.defaultPrevented).toBe(false);
  expect(postMessage).not.toHaveBeenCalled();
});
