import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { App, Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { installWebviewNavigationGuards } from '@/process/startup/webviewNavigation';

function makeSession() {
  return { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() };
}

function setup() {
  const app = new EventEmitter();
  const defaultSession = makeSession();
  const feishuSession = makeSession();
  installWebviewNavigationGuards(
    app as App,
    defaultSession as unknown as Session,
    resolve('out/preload/workbenchCommentPreload.js'),
    () => feishuSession as unknown as Session
  );
  const create = (type = 'webview', session = makeSession()) => {
    const contents = Object.assign(new EventEmitter(), {
      getType: () => type,
      session,
      setWindowOpenHandler: vi.fn(),
      getURL: vi.fn(() => 'https://example.feishu.cn/base/fixture'),
      send: vi.fn(),
    });
    app.emit('web-contents-created', {}, contents as unknown as WebContents);
    return contents;
  };
  return { create, defaultSession, feishuSession };
}

describe('embedded browser external protocol handling', () => {
  it.each(['will-navigate', 'will-frame-navigate', 'will-redirect'])(
    'silently cancels repeated application links at %s',
    (eventName) => {
      const contents = setup().create();
      const preventDefault = vi.fn();
      for (const url of ['bytedance://dispatch_message/', 'snssdk1128://test', 'mailto:test@example.com']) {
        for (let attempt = 0; attempt < 5; attempt++) {
          contents.emit(eventName, { url, isMainFrame: false, preventDefault }, url);
        }
      }
      expect(preventDefault).toHaveBeenCalledTimes(15);
    }
  );

  it.each([
    'https://creator.douyin.com/',
    'http://localhost:8080/',
    'about:blank',
    'about:srcdoc',
    'blob:https://example.com/test',
    'data:text/html,test',
    'file:///tmp/preview.html',
  ])('allows browser-managed navigation to %s', (url) => {
    const contents = setup().create();
    const preventDefault = vi.fn();
    for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      contents.emit(eventName, { url, preventDefault }, url);
    }
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('denies native popup creation before any page script runs', () => {
    const contents = setup().create();
    const handler = contents.setWindowOpenHandler.mock.calls[0][0];
    expect(handler({ url: 'bytedance://dispatch_message/' })).toEqual({ action: 'deny' });
  });

  it('denies OS handoff in every account session and the default session', () => {
    const { create, defaultSession } = setup();
    const sessions = [defaultSession, create().session, create().session];
    for (const session of sessions) {
      const check = session.setPermissionCheckHandler.mock.calls[0][0];
      const request = session.setPermissionRequestHandler.mock.calls[0][0];
      const callback = vi.fn();
      expect(check(null, 'openExternal', '', {})).toBe(false);
      request(null, 'openExternal', callback, { externalURL: 'bytedance://dispatch_message/' });
      expect(callback).toHaveBeenCalledWith(false);
    }
  });

  it('preserves existing permissions and installs each session policy once', () => {
    const { create } = setup();
    const session = makeSession();
    create('webview', session);
    create('webview', session);
    const callback = vi.fn();
    session.setPermissionRequestHandler.mock.calls[0][0](null, 'unknown', callback, {});
    expect(callback).toHaveBeenCalledWith(true);
    expect(session.setPermissionCheckHandler.mock.calls[0][0](null, 'media', '', {})).toBe(true);
    expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce();
  });

  it('rejects a guest with an external-protocol initial source', () => {
    const contents = setup().create('window');
    const preventDefault = vi.fn();
    contents.emit('will-attach-webview', { preventDefault }, {}, { src: 'bytedance://dispatch_message/' });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(contents.setWindowOpenHandler).not.toHaveBeenCalled();
  });
});

describe('Feishu comment preload isolation', () => {
  it('attaches only the dedicated preload to the persistent Feishu guest', () => {
    const contents = setup().create('window');
    const preferences = { contextIsolation: true, nodeIntegration: false };
    contents.emit('will-attach-webview', { preventDefault: vi.fn() }, preferences, {
      partition: 'persist:workbench-feishu',
      src: 'https://my.feishu.cn/base/test',
    });
    expect(preferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolve('out/preload/workbenchCommentPreload.js'),
    });
  });
  it.each(['persist:workbench-account-other', 'persist:browser', undefined])(
    'leaves other guest preload settings unchanged: %s',
    (partition) => {
      const contents = setup().create('window');
      const preferences = { contextIsolation: true, nodeIntegration: false };
      contents.emit('will-attach-webview', { preventDefault: vi.fn() }, preferences, {
        partition,
        src: 'https://www.douyin.com/',
      });
      expect(preferences).not.toHaveProperty('preload');
    }
  );
});

describe('isolated native navigation fallback for DM links', () => {
  const token = 'ab'.repeat(32);
  const url = `https://www.douyin.com/#workbench-dm=${token}`;
  it.each(['will-navigate', 'will-frame-navigate', 'will-redirect'])(
    'keeps the Feishu guest in place on %s',
    (name) => {
      const { create, feishuSession } = setup();
      const guest = create('webview', feishuSession);
      const preventDefault = vi.fn();
      guest.emit(name, { url, preventDefault, initiator: { url: 'https://example.feishu.cn/frame' } });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(guest.send).toHaveBeenCalledExactlyOnceWith('workbench-dm-navigation', token);
    }
  );
  it('routes a trusted native popup to the preload, still denying native window creation', () => {
    const { create, feishuSession } = setup();
    const guest = create('webview', feishuSession);
    const open = guest.setWindowOpenHandler.mock.calls[0][0];
    expect(open({ url, referrer: { url: 'https://example.feishu.cn/frame' } })).toEqual({ action: 'deny' });
    expect(guest.send).toHaveBeenCalledExactlyOnceWith('workbench-dm-navigation', token);
  });
  it('ignores other sessions, untrusted top-level guests, and foreign frame initiators', () => {
    const { create, feishuSession } = setup();
    const other = create();
    other.emit('will-navigate', { url, preventDefault: vi.fn() });
    expect(other.send).not.toHaveBeenCalled();
    const guest = create('webview', feishuSession);
    guest.emit('will-frame-navigate', { url, preventDefault: vi.fn(), initiator: { url: 'https://foreign.example/' } });
    guest.setWindowOpenHandler.mock.calls[0][0]({ url, referrer: { url: 'https://foreign.example/' } });
    guest.getURL.mockReturnValue('https://foreign.example/');
    guest.emit('will-navigate', { url, preventDefault: vi.fn() });
    expect(guest.send).not.toHaveBeenCalled();
  });
});
