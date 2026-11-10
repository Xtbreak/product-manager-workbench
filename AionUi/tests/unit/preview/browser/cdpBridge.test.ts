import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
const registry = vi.hoisted(() => new Map<number, unknown>());
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/workbench-bridge-test-unused' },
  clipboard: { writeText: vi.fn() },
  webContents: { fromId: (id: number) => registry.get(id) },
}));
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
  });
  registry.set(id, wc);
  return wc;
}
let bridge: CdpBridgeHandle | undefined;
afterEach(async () => {
  await bridge?.close();
  registry.clear();
});
async function connect() {
  bridge = await startCdpBridge();
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
describe('multi-account bridge transport', () => {
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
});
