import React from 'react';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

it('isolates locked navigation while keeping the same guest focusable for native input', async () => {
  const { focusAccountBrowser } = await import('@/renderer/pages/Workbench/focusAccountBrowser');
  const { container, rerender } = render(<WebviewHost url='https://example.com' showNavBar navigationLocked />);
  const toolbar = container.querySelector('.aion-url-viewer-toolbar')!;
  const view = container.querySelector('webview')!;
  Object.assign(view, { getWebContentsId: () => 42 });
  expect(toolbar).toHaveAttribute('inert');
  for (const control of toolbar.querySelectorAll('button, input')) expect(control).toBeDisabled();
  expect(view.closest('[inert]')).toBeNull();
  expect(view).toHaveAttribute('tabindex', '-1');
  expect(await focusAccountBrowser(42, async () => {})).toBe(true);
  expect(document.activeElement).toBe(view);
  rerender(<WebviewHost url='https://example.com' showNavBar navigationLocked={false} />);
  expect(toolbar).not.toHaveAttribute('inert');
  expect(toolbar.querySelector('input')).toBeEnabled();
  expect(toolbar.querySelector('button[title="common.refresh"]')).toBeEnabled();
  expect(view).not.toHaveAttribute('tabindex');
  expect(container.querySelector('webview')).toBe(view);
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

it('does not grant popup windows through a false-valued boolean attribute', () => {
  const { container } = render(<WebviewHost url='https://www.douyin.com' />);
  expect(container.querySelector('webview')?.hasAttribute('allowpopups')).toBe(false);
});

it('ignores repeated external protocol requests from the page navigation bridge', () => {
  const { container } = render(<WebviewHost url='https://www.douyin.com' />);
  const view = container.querySelector('webview')!;
  for (let attempt = 0; attempt < 5; attempt++) {
    fireEvent(
      view,
      Object.assign(new Event('console-message'), {
        message: JSON.stringify({ type: '__WEBVIEW_HOST_NAVIGATE__', url: 'bytedance://dispatch_message/' }),
      })
    );
  }
  expect(view.getAttribute('src')).toBe('https://www.douyin.com');
});

it('keeps ordinary web links inside the account browser', () => {
  const { container } = render(<WebviewHost url='https://www.douyin.com' />);
  const view = container.querySelector('webview')!;
  fireEvent(
    view,
    Object.assign(new Event('console-message'), {
      message: JSON.stringify({ type: '__WEBVIEW_HOST_NAVIGATE__', url: 'https://creator.douyin.com/' }),
    })
  );
  expect(view.getAttribute('src')).toBe('https://creator.douyin.com/');
});

it('does not load external protocols from initial or updated browser props', () => {
  const { container, rerender } = render(<WebviewHost url='bytedance://dispatch_message/' />);
  expect(container.querySelector('webview')?.getAttribute('src')).toBe('about:blank');
  rerender(<WebviewHost url='https://www.douyin.com' />);
  rerender(<WebviewHost url='snssdk1128://test' />);
  expect(container.querySelector('webview')?.getAttribute('src')).toBe('https://www.douyin.com');
});

it('routes opt-in comment popups without replacing the Feishu guest', () => {
  const onCommentLink = vi.fn();
  const { container } = render(<WebviewHost url='https://my.feishu.cn/base/test' onCommentLink={onCommentLink} />);
  const view = container.querySelector('webview')!;
  const token = 'ab'.repeat(32);
  fireEvent(
    view,
    Object.assign(new Event('console-message'), {
      message: JSON.stringify({
        type: '__WEBVIEW_HOST_NAVIGATE__',
        url: `https://www.douyin.com/video/123#workbench-comment=${token}`,
      }),
    })
  );
  expect(onCommentLink).toHaveBeenCalledWith(token);
  expect(view.getAttribute('src')).toBe('https://my.feishu.cn/base/test');
});

it('captures same-window comment anchors before Feishu navigation handlers run', () => {
  const { container } = render(<WebviewHost url='https://my.feishu.cn/base/test' onCommentLink={() => {}} />);
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
  new Function('window', 'document', scripts.find((value) => value.includes('__webviewHostInjected'))!)(guest, doc);
  const link = doc.createElement('a');
  link.href = `https://www.douyin.com/video/123#workbench-comment=${'ab'.repeat(32)}`;
  doc.body.append(link);
  const navigation = vi.fn();
  link.addEventListener('click', navigation);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(navigation).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledOnce();
});

it('leaves comment link behavior unchanged when interception is not enabled', () => {
  const { container } = render(<WebviewHost url='https://example.com' />);
  const view = container.querySelector('webview')!;
  const url = `https://www.douyin.com/video/123#workbench-comment=${'ab'.repeat(32)}`;
  fireEvent(
    view,
    Object.assign(new Event('console-message'), { message: JSON.stringify({ type: '__WEBVIEW_HOST_NAVIGATE__', url }) })
  );
  expect(view.getAttribute('src')).toBe(url);
});

it('reports account readiness only after successful main-process registration', async () => {
  let complete: (value: { success: boolean }) => void;
  report.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  const onAgentReady = vi.fn();
  const { container } = render(<WebviewHost url='https://www.douyin.com' onAgentReady={onAgentReady} />);
  ready(container.querySelector('webview'));
  expect(onAgentReady).not.toHaveBeenCalled();
  complete!({ success: true });
  await waitFor(() => expect(onAgentReady).toHaveBeenCalledWith(true));
});
it('keeps failed browser registration unavailable without an unhandled rejection', async () => {
  report.mockRejectedValueOnce(new Error('Registry unavailable'));
  const onAgentReady = vi.fn();
  const { container } = render(<WebviewHost url='https://www.douyin.com' onAgentReady={onAgentReady} />);
  ready(container.querySelector('webview'));
  await waitFor(() => expect(onAgentReady).toHaveBeenCalledWith(false));
  expect(onAgentReady).not.toHaveBeenCalledWith(true);
});

it('routes comment IPC from the isolated preload without changing the Feishu source', () => {
  const onCommentLink = vi.fn();
  const { container } = render(<WebviewHost url='https://my.feishu.cn/base/test' onCommentLink={onCommentLink} />);
  const view = container.querySelector('webview')!;
  const token = 'ab'.repeat(32);
  fireEvent(view, Object.assign(new Event('ipc-message'), { channel: 'workbench-comment-link', args: [token] }));
  expect(onCommentLink).toHaveBeenCalledWith(token);
  expect(view.getAttribute('src')).toBe('https://my.feishu.cn/base/test');
});
it.each([
  { channel: 'unrelated', args: ['ab'.repeat(32)] },
  { channel: 'workbench-comment-link', args: ['abc'] },
  { channel: 'workbench-comment-link', args: ['ab'.repeat(32), 'foreign'] },
  { channel: 'workbench-comment-link', args: [{ token: 'ab'.repeat(32) }] },
])('ignores malformed or unrelated comment IPC: %j', (message) => {
  const onCommentLink = vi.fn();
  const { container } = render(<WebviewHost url='https://my.feishu.cn/base/test' onCommentLink={onCommentLink} />);
  fireEvent(container.querySelector('webview')!, Object.assign(new Event('ipc-message'), message));
  expect(onCommentLink).not.toHaveBeenCalled();
});
it('does not consume preload comment IPC in a non-opted-in browser', () => {
  const { container } = render(<WebviewHost url='https://example.com' />);
  const view = container.querySelector('webview')!;
  fireEvent(
    view,
    Object.assign(new Event('ipc-message'), { channel: 'workbench-comment-link', args: ['ab'.repeat(32)] })
  );
  expect(view.getAttribute('src')).toBe('https://example.com');
});
