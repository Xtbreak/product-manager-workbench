// @vitest-environment-options {"url":"https://example.feishu.cn/base/test"}
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
const sendToHost = vi.hoisted(() => vi.fn());
const receive = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcRenderer: { sendToHost, on: receive } }));
beforeAll(async () => {
  await import('@/preload/workbenchCommentPreload');
});
afterEach(() => {
  document.body.innerHTML = '';
  sendToHost.mockClear();
  vi.restoreAllMocks();
});
const token = 'ab'.repeat(32);
const url = `https://www.douyin.com/video/123#workbench-comment=${token}`;

describe('isolated comment bridge', () => {
  it('captures same-window anchors when the page console is disabled', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.textContent = '查看评论';
    document.body.append(anchor);
    const pageNavigation = vi.fn();
    anchor.addEventListener('click', pageNavigation);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);
    expect({ prevented: event.defaultPrevented, navigations: pageNavigation.mock.calls.length }).toEqual({
      prevented: true,
      navigations: 0,
    });
    expect(sendToHost).toHaveBeenCalledExactlyOnceWith('workbench-comment-link', token);
  });
  it('relays a same-window popup message without console output', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    window.dispatchEvent(
      new MessageEvent('message', { source: window, data: { type: '__WEBVIEW_HOST_NAVIGATE__', url } })
    );
    expect(sendToHost).toHaveBeenCalledExactlyOnceWith('workbench-comment-link', token);
  });
  it.each([
    { source: null, data: { type: '__WEBVIEW_HOST_NAVIGATE__', url } },
    { source: window, data: { type: 'other', url } },
    {
      source: window,
      data: { type: '__WEBVIEW_HOST_NAVIGATE__', url: `https://evil.example/video/123#workbench-comment=${token}` },
    },
    {
      source: window,
      data: { type: '__WEBVIEW_HOST_NAVIGATE__', url: 'https://www.douyin.com/video/123#workbench-comment=bad' },
    },
  ])('rejects untrusted popup messages', (message) => {
    window.dispatchEvent(new MessageEvent('message', message));
    expect(sendToHost).not.toHaveBeenCalled();
  });
  it('preserves ordinary anchor clicks', () => {
    const anchor = document.createElement('a');
    anchor.href = '#ordinary';
    document.body.append(anchor);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(sendToHost).not.toHaveBeenCalled();
  });
});

it('captures a DM anchor and forwards only its token on a separate channel', () => {
  const anchor = document.createElement('a');
  anchor.href = `https://www.xiaohongshu.com/#workbench-dm=${token}`;
  document.body.append(anchor);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  anchor.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(sendToHost).toHaveBeenCalledExactlyOnceWith('workbench-dm-link', token);
});
it('forwards a same-window DM popup independently of page logging', () => {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      data: { type: '__WEBVIEW_HOST_NAVIGATE__', url: `https://www.douyin.com/#workbench-dm=${token}` },
    })
  );
  expect(sendToHost).toHaveBeenCalledExactlyOnceWith('workbench-dm-link', token);
});

it('relays trusted native navigation tokens through the same isolated host channel', () => {
  const handler = receive.mock.calls.find(([channel]) => channel === 'workbench-dm-navigation')?.[1];
  expect(handler).toBeTypeOf('function');
  handler({}, 'invalid');
  handler({}, token);
  expect(sendToHost).toHaveBeenCalledExactlyOnceWith('workbench-dm-link', token);
});
