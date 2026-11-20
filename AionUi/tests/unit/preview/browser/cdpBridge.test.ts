import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplyBrowserAccess } from '@/process/services/workbench/replies/contracts';
import type { BrowserAccess } from '@/process/services/workbench/runtime';
const registry = vi.hoisted(() => new Map<number, unknown>());
const captured = vi.hoisted(() => ({
  leases: undefined as ReplyBrowserAccess | undefined,
  runtime: undefined as BrowserAccess | undefined,
  clipboardText: '',
  replyAction: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/workbench-bridge-test-unused' },
  clipboard: {
    writeText: vi.fn((text: string) => {
      captured.clipboardText = text;
    }),
    clear: vi.fn(() => {
      captured.clipboardText = '';
    }),
    readText: vi.fn(() => captured.clipboardText),
  },
  webContents: { fromId: (id: number) => registry.get(id) },
}));
vi.mock('@/process/services/workbench/replies/service', () => ({
  createReplyService: (options: { browsers: ReplyBrowserAccess }) => {
    captured.leases = options.browsers;
    return { action: captured.replyAction, close: vi.fn() };
  },
}));
vi.mock('@/process/services/workbench/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/process/services/workbench/runtime')>();
  return {
    ...actual,
    createWorkbenchRuntime: (directory: string, browsers: BrowserAccess) => {
      captured.runtime = browsers;
      return actual.createWorkbenchRuntime(directory, browsers);
    },
  };
});
import { startCdpBridge, type CdpBridgeHandle } from '@/process/resources/builtinMcp/cdpBridge';
function page(id: number, type = 'webview') {
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async () => ({ owner: id })),
  });
  const wc = Object.assign(new EventEmitter(), {
    id,
    debugger: dbg,
    getType: () => type,
    isDestroyed: () => false,
    getTitle: () => 'same title',
    getURL: () => 'https://example.com/',
    focus: vi.fn(),
    copy: vi.fn(() => {
      captured.clipboardText = `selection-${id}`;
    }),
    paste: vi.fn(),
    insertText: vi.fn(async (_text: string) => undefined),
  });
  registry.set(id, wc);
  return wc;
}
let bridge: CdpBridgeHandle | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  registry.clear();
  captured.leases = undefined;
  captured.runtime = undefined;
  captured.clipboardText = '';
  captured.replyAction.mockReset();
});
async function connect(options: Parameters<typeof startCdpBridge>[0] = {}) {
  bridge = await startCdpBridge(options);
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/aionui-cdp?token=${bridge.token}`);
  await new Promise<void>((resolve) => ws.once('open', resolve));
  let id = 0;
  return (method: string, params = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => reject(new Error('CDP reply timeout')), 1500);
      const onMessage = (data: Buffer) => {
        const reply = JSON.parse(data.toString());
        if (reply.id === requestId) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(reply);
        }
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ id: requestId, method, params, sessionId }));
    });
}
async function httpRequest(input: Record<string, unknown>): Promise<{ result?: unknown; error?: string }> {
  const response = await fetch(`http://127.0.0.1:${bridge!.port}/workbench`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bridge!.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return response.json();
}
describe('multi-account bridge transport', () => {
  it('forwards reply tasks with a live per-request cancellation signal', async () => {
    captured.replyAction.mockResolvedValue({ archived: 1 });
    bridge = await startCdpBridge();
    expect(await httpRequest({ action: 'reply-sync', request: { action: 'collect' } })).toEqual({
      result: { archived: 1 },
    });
    const [request, signal] = captured.replyAction.mock.calls[0];
    expect(request).toEqual({ action: 'collect' });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });
  it('cancels only the interrupted reply HTTP request when its response connection closes', async () => {
    let signal: AbortSignal | undefined;
    captured.replyAction.mockImplementation(async (_request, callerSignal: AbortSignal) => {
      signal = callerSignal;
      await new Promise<void>((resolve) => callerSignal?.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('replyPaused');
    });
    bridge = await startCdpBridge();
    const caller = new AbortController();
    const response = fetch(`http://127.0.0.1:${bridge.port}/workbench`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reply-sync', request: { action: 'sync' } }),
      signal: caller.signal,
    });
    const rejected = expect(response).rejects.toThrow();
    await vi.waitFor(() => expect(captured.replyAction).toHaveBeenCalled());
    caller.abort();
    await rejected;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });
  it('reports activity only for the target account and clears it after a failed command', async () => {
    page(1);
    const second = page(2);
    second.debugger.sendCommand.mockRejectedValueOnce(new Error('Page unavailable'));
    const activity = vi.fn();
    bridge = await startCdpBridge({ onActivity: activity });
    bridge.attach(1);
    bridge.attach(2, { accountId: 'secondary', name: 'Second' });
    const response = await fetch(`http://127.0.0.1:${bridge.port}/workbench`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'browser', accountId: 'secondary', method: 'Runtime.evaluate' }),
    });
    expect(await response.json()).toEqual({ error: 'Page unavailable' });
    expect(activity.mock.calls).toEqual([[{ accountId: 'secondary', operating: true }]]);
    await vi.waitFor(() =>
      expect(activity.mock.calls).toEqual([
        [{ accountId: 'secondary', operating: true }],
        [{ accountId: 'secondary', operating: false }],
      ])
    );
  });
  it('routes identical URLs to separate browser objects and refuses stale sessions', async () => {
    const a = page(1);
    const b = page(2);
    const request = await connect();
    bridge!.attach(1, { accountId: 'primary', name: 'Main' });
    bridge!.attach(2, { accountId: 'secondary', name: 'Second' });
    expect(await request('Runtime.evaluate', {}, 'session:webview-2')).toMatchObject({ result: { owner: 2 } });
    expect(a.debugger.sendCommand).not.toHaveBeenCalled();
    b.emit('destroyed');
    expect(await request('Runtime.evaluate', {}, 'session:webview-2')).toHaveProperty('error');
  });
  it('rejects main renderers and account reassignment of a live browser', async () => {
    page(1, 'window');
    page(2);
    await connect();
    expect(bridge!.attach(1).ok).toBe(false);
    bridge!.attach(2, { accountId: 'primary', name: 'Main' });
    expect(bridge!.attach(2, { accountId: 'secondary', name: 'Second' }).ok).toBe(false);
  });
  it('enumerates newly registered pages without reconnecting', async () => {
    page(1);
    page(2);
    const request = await connect();
    bridge!.attach(1);
    await request('Target.setAutoAttach', { autoAttach: true });
    bridge!.attach(2, { accountId: 'feishu', name: 'Feishu' });
    const result = await request('Target.getTargets');
    expect(result).toMatchObject({
      result: {
        targetInfos: [
          { targetId: 'webview-1', browserContextId: 'primary' },
          { targetId: 'webview-2', browserContextId: 'feishu' },
        ],
      },
    });
  });
  it('blocks HTTP and WebSocket commands for a leased account and restores both after release', async () => {
    const first = page(1);
    page(2);
    const request = await connect();
    bridge!.attach(1, { accountId: 'primary', name: 'Main' });
    bridge!.attach(2, { accountId: 'secondary', name: 'Second' });
    const lease = await captured.leases!.acquire('primary');
    expect(await httpRequest({ action: 'browser', accountId: 'primary', method: 'Runtime.evaluate' })).toEqual({
      error: 'replyBrowserBusy',
    });
    expect(await request('Runtime.evaluate', {}, 'session:webview-1')).toMatchObject({
      error: { message: 'replyBrowserBusy' },
    });
    expect(first.debugger.sendCommand).not.toHaveBeenCalled();
    expect(await request('Runtime.evaluate', {}, 'session:webview-2')).toMatchObject({ result: { owner: 2 } });
    lease.release();
    expect(await httpRequest({ action: 'browser', accountId: 'primary', method: 'Runtime.evaluate' })).toEqual({
      result: { owner: 1 },
    });
    expect(await request('Runtime.evaluate', {}, 'session:webview-1')).toMatchObject({ result: { owner: 1 } });
  });
  it('lets the lease use its pinned guest while external input remains blocked', async () => {
    const first = page(1);
    const focus = vi.fn(async (_id: number) => undefined);
    const request = await connect({ focus });
    bridge!.attach(1);
    const lease = await captured.leases!.acquire('primary');
    expect(await lease.command('Input.insertText', { text: 'approved text' })).toEqual({});
    expect(first.insertText).toHaveBeenCalledWith('approved text');
    expect(await request('Input.insertText', { text: 'competing text' }, 'session:webview-1')).toMatchObject({
      error: { message: 'replyBrowserBusy' },
    });
    expect(first.insertText).toHaveBeenCalledTimes(1);
    lease.release();
  });
  it('blocks focus, copy and paste side effects under the same account lease', async () => {
    const first = page(1);
    const focus = vi.fn(async (_id: number) => undefined);
    await connect({ focus });
    bridge!.attach(1);
    const lease = await captured.leases!.acquire('primary');
    focus.mockClear();
    expect(await httpRequest({ action: 'copy', accountId: 'primary' })).toEqual({ error: 'replyBrowserBusy' });
    await expect(captured.runtime!.copy!('primary')).rejects.toThrow('replyBrowserBusy');
    expect(() => captured.runtime!.paste('primary', 'unapproved text')).toThrow('replyBrowserBusy');
    expect(focus).not.toHaveBeenCalled();
    expect(first.copy).not.toHaveBeenCalled();
    expect(first.paste).not.toHaveBeenCalled();
    lease.release();
    expect(await httpRequest({ action: 'copy', accountId: 'primary' })).toEqual({ result: 'selection-1' });
    captured.runtime!.paste('primary', 'approved paste');
    expect(first.paste).toHaveBeenCalledTimes(1);
  });
  it.each(['http', 'websocket'] as const)(
    'cannot acquire a lease while a %s command is in flight',
    async (transport) => {
      const first = page(1);
      let complete!: (value: { owner: number }) => void;
      first.debugger.sendCommand.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          })
      );
      const request = await connect();
      bridge!.attach(1);
      const pending =
        transport === 'http'
          ? httpRequest({ action: 'browser', accountId: 'primary', method: 'Runtime.evaluate' })
          : request('Runtime.evaluate', {}, 'session:webview-1');
      await vi.waitFor(() => expect(first.debugger.sendCommand).toHaveBeenCalledTimes(1));
      await expect(captured.leases!.acquire('primary')).rejects.toThrow('replyBrowserBusy');
      complete({ owner: 1 });
      await pending;
      const lease = await captured.leases!.acquire('primary');
      lease.release();
    }
  );
  it('does not route stale leases or WebSocket sessions into a reopened account', async () => {
    const oldPage = page(1);
    const newPage = page(3);
    const other = page(2);
    const request = await connect();
    bridge!.attach(1);
    bridge!.attach(2, { accountId: 'secondary', name: 'Second' });
    const oldLease = await captured.leases!.acquire('primary');
    oldPage.emit('destroyed');
    bridge!.attach(3);
    await expect(oldLease.command('Runtime.evaluate')).rejects.toThrow('replyBrowserClosed');
    expect(await request('Runtime.evaluate', {}, 'session:webview-1')).toHaveProperty('error');
    expect(await request('Runtime.evaluate', {}, 'session:webview-3')).toMatchObject({
      error: { message: 'replyBrowserBusy' },
    });
    expect(newPage.debugger.sendCommand).not.toHaveBeenCalled();
    expect(other.debugger.sendCommand).not.toHaveBeenCalled();
    oldLease.release();
    const fresh = await captured.leases!.acquire('primary');
    expect(fresh.targetId).toBe('webview-3');
    expect(await fresh.command('Runtime.evaluate')).toEqual({ owner: 3 });
    fresh.release();
  });
  it('blocks native user input only during the lease and releases it afterward', async () => {
    const first = page(1);
    await connect();
    bridge!.attach(1);
    const lease = await captured.leases!.acquire('primary');
    const blocked = { preventDefault: vi.fn() };
    first.emit('before-input-event', blocked);
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    lease.release();
    const available = { preventDefault: vi.fn() };
    first.emit('before-input-event', available);
    expect(available.preventDefault).not.toHaveBeenCalled();
  });
  it('releases the real bridge lock after focus fails and allows the next client command', async () => {
    const first = page(1);
    const focus = vi.fn(async (_id: number) => undefined).mockRejectedValueOnce(new Error('Focus failed'));
    const onLock = vi.fn();
    await connect({ focus, onLock });
    bridge!.attach(1);
    await expect(captured.leases!.acquire('primary')).rejects.toThrow('Focus failed');
    expect(onLock.mock.calls).toEqual([
      [{ accountId: 'primary', locked: true }],
      [{ accountId: 'primary', locked: false }],
    ]);
    expect(await httpRequest({ action: 'browser', accountId: 'primary', method: 'Runtime.evaluate' })).toEqual({
      result: { owner: 1 },
    });
    expect(first.debugger.sendCommand).toHaveBeenCalledTimes(1);
  });
});
