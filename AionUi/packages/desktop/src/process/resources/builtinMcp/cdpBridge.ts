/** @license Copyright 2025 AionUi (aionui.com) SPDX-License-Identifier: Apache-2.0 */
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { app, clipboard, webContents, type WebContents } from 'electron';
import { createWorkbenchRuntime } from '../../services/workbench/runtime';
import { buildVersionPayload, tokensMatch, type CdpRequest, type TargetInfo } from './cdpTargetProtocol';
import { decideMultiTargetCommand, targetSessionId } from './cdpMultiTarget';
import type { ReplySyncAction, ReplySyncStatus } from '@/common/types/platform/workbenchReply';
import { createAccountLeases } from '../../services/workbench/replies/accountLease';
import { createReplyService } from '../../services/workbench/replies/service';
import { createReplyTableAdapter } from '../../services/workbench/replies/feishuTable';
import { createReplyPlatformAdapter } from '../../services/workbench/replies/platforms';

export type BrowserTargetIdentity = { accountId: string; name: string };
export type CdpBridgeHandle = {
  port: number;
  token: string;
  attachedWebContentsId: () => number | null;
  attach: (id: number, identity?: BrowserTargetIdentity) => { ok: true } | { ok: false; reason: string };
  detach: () => void;
  reply: (action: ReplySyncAction) => Promise<ReplySyncStatus>;
  close: () => Promise<void>;
};
type Page = {
  contents: WebContents;
  identity: BrowserTargetIdentity;
  cleanup: () => void;
  operations: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};
type Client = { announced: Set<string>; discover: boolean; autoAttach: boolean };

/** Route text insertion to the guest instead of Chromium's currently focused host widget. */
async function sendPageCommand(contents: WebContents, method: string, params: Record<string, unknown>) {
  if (method === 'Input.insertText') {
    if (typeof params.text !== 'string') throw new Error('Input.insertText requires text.');
    await contents.insertText(params.text);
    return {};
  }
  return contents.debugger.sendCommand(method, params);
}

/** Expose registered webviews only. Each page lifetime has its own CDP target/session.
 * HTTP discovery retains Chrome-compatible local discovery semantics; WS requires its token.
 * No process-wide Chromium debugging port or main-window/preload target is exposed.
 */
export const startCdpBridge = async (
  options: {
    focus?: (webContentsId: number) => Promise<void>;
    onActivity?: (event: { accountId: string; operating: boolean }) => void;
    onLock?: (event: { accountId: string; locked: boolean }) => void;
  } = {}
): Promise<CdpBridgeHandle> => {
  const token = randomBytes(24).toString('hex');
  const pages = new Map<string, Page>();
  const clients = new Map<WebSocket, Client>();
  const info = (id: string, page: Page): TargetInfo => ({
    targetId: id,
    type: 'page',
    title: `[${page.identity.accountId}] ${page.identity.name} — ${page.contents.getTitle()}`,
    url: page.contents.getURL(),
    attached: true,
    canAccessOpener: false,
    browserContextId: page.identity.accountId,
  });
  const infos = () => [...pages].filter(([, p]) => !p.contents.isDestroyed()).map(([id, p]) => info(id, p));
  const send = (ws: WebSocket, payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };
  const announce = (ws: WebSocket, client: Client, targetInfo: TargetInfo) => {
    const sessionId = targetSessionId(targetInfo.targetId);
    if (client.announced.has(sessionId)) return;
    client.announced.add(sessionId);
    send(ws, { method: 'Target.attachedToTarget', params: { sessionId, targetInfo, waitingForDebugger: false } });
  };
  const trackOperation = async <T>(page: Page, operation: () => Promise<T>): Promise<T> => {
    const emit = options.onActivity;
    const { accountId } = page.identity;
    const wasOperating = page.operations > 0 || page.idleTimer !== undefined;
    clearTimeout(page.idleTimer);
    page.idleTimer = undefined;
    page.operations++;
    try {
      if (!wasOperating) emit?.({ accountId, operating: true });
      return await operation();
    } finally {
      // A detached page has already cleared its status, even if a pending command settles later.
      if (page.operations > 0 && --page.operations === 0) {
        page.idleTimer = setTimeout(() => {
          page.idleTimer = undefined;
          emit?.({ accountId, operating: false });
        }, 450);
      }
    }
  };
  const leases = createAccountLeases<Page>({
    current: (accountId) => {
      const found = [...pages].find(([, page]) => page.identity.accountId === accountId);
      return found ? { targetId: found[0], value: found[1] } : undefined;
    },
    isAlive: (page) => !page.contents.isDestroyed(),
    isBusy: (page) => page.operations > 0,
    command: (page, method, params) =>
      trackOperation(page, async () => {
        if (method.startsWith('Input.')) await options.focus?.(page.contents.id);
        return sendPageCommand(page.contents, method, params);
      }),
    lock: (_page, accountId, locked) => options.onLock?.({ accountId, locked }),
    focus: async (page) => {
      await options.focus?.(page.contents.id);
    },
  });
  const remove = (id: string) => {
    const page = pages.get(id);
    if (!page) return;
    pages.delete(id);
    if (page.operations || page.idleTimer !== undefined) {
      clearTimeout(page.idleTimer);
      page.idleTimer = undefined;
      page.operations = 0;
      options.onActivity?.({ accountId: page.identity.accountId, operating: false });
    }
    page.cleanup();
    for (const [ws, client] of clients) {
      if (client.announced.delete(targetSessionId(id)))
        send(ws, { method: 'Target.detachedFromTarget', params: { sessionId: targetSessionId(id), targetId: id } });
      if (client.discover) send(ws, { method: 'Target.targetDestroyed', params: { targetId: id } });
    }
  };
  const attach: CdpBridgeHandle['attach'] = (id, identity = { accountId: 'primary', name: 'Browser' }) => {
    const contents = webContents.fromId(id);
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview')
      return { ok: false, reason: 'Only a live browser webview may be registered.' };
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(identity.accountId) ||
      typeof identity.name !== 'string' ||
      identity.name.length > 100
    )
      return { ok: false, reason: 'Invalid account identity.' };
    const targetId = `webview-${id}`;
    const existing = pages.get(targetId);
    if (existing) {
      if (existing.identity.accountId !== identity.accountId)
        return { ok: false, reason: 'A live browser cannot change account identity.' };
      existing.identity = identity;
      return { ok: true };
    }
    if ([...pages.values()].some((p) => p.identity.accountId === identity.accountId))
      return { ok: false, reason: 'This account already has a registered browser.' };
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    } catch {
      return { ok: false, reason: 'Could not attach browser debugger. Close DevTools and reload the page.' };
    }
    const onMessage = (_event: unknown, method: string, params: unknown) => {
      for (const [ws, client] of clients)
        if (client.announced.has(targetSessionId(targetId)))
          send(ws, { method, params, sessionId: targetSessionId(targetId) });
    };
    const onDestroyed = () => remove(targetId);
    const onInput = (event: { preventDefault: () => void }) => {
      if (leases.isHeld(identity.accountId)) event.preventDefault();
    };
    const onNavigate = () => {
      for (const [ws, client] of clients)
        if (client.discover)
          send(ws, { method: 'Target.targetInfoChanged', params: { targetInfo: info(targetId, page) } });
    };
    const page: Page = {
      contents,
      identity,
      operations: 0,
      cleanup: () => {
        try {
          contents.debugger.removeListener('message', onMessage);
        } catch {
          /* Destroyed guest has no debugger handle. */
        }
        contents.removeListener('destroyed', onDestroyed);
        contents.removeListener('before-input-event', onInput);
        contents.removeListener('did-navigate', onNavigate);
        contents.removeListener('page-title-updated', onNavigate);
        try {
          if (contents.debugger.isAttached()) contents.debugger.detach();
        } catch {
          /* Already destroyed. */
        }
      },
    };
    pages.set(targetId, page);
    contents.debugger.on('message', onMessage);
    contents.once('destroyed', onDestroyed);
    contents.on('before-input-event', onInput);
    contents.on('did-navigate', onNavigate);
    contents.on('page-title-updated', onNavigate);
    for (const [ws, client] of clients) {
      if (client.discover) send(ws, { method: 'Target.targetCreated', params: { targetInfo: info(targetId, page) } });
      if (client.autoAttach) announce(ws, client, info(targetId, page));
    }
    return { ok: true };
  };
  const handle = async (ws: WebSocket, raw: string, client: Client) => {
    let req: CdpRequest;
    try {
      req = JSON.parse(raw) as CdpRequest;
    } catch {
      return;
    }
    if (!req || typeof req.method !== 'string') return;
    const response = (payload: Record<string, unknown>) =>
      send(ws, { id: req.id, sessionId: req.sessionId, ...payload });
    const decision = decideMultiTargetCommand(req, infos());
    if (decision.kind === 'error') {
      response({ error: { code: -32601, message: decision.message } });
      return;
    }
    if (req.method === 'Target.setDiscoverTargets') client.discover = req.params?.discover === true;
    if (req.method === 'Target.setAutoAttach' && !req.sessionId) client.autoAttach = req.params?.autoAttach === true;
    if (decision.kind === 'reply' || decision.kind === 'reply-and-emit') {
      if (decision.kind === 'reply-and-emit')
        for (const event of decision.emit) {
          if (event.method === 'Target.attachedToTarget') announce(ws, client, event.params.targetInfo as TargetInfo);
          else send(ws, event);
        }
      response({ result: decision.payload });
      return;
    }
    const page = pages.get(decision.targetId);
    if (!page || page.contents.isDestroyed()) {
      response({ error: { code: -32000, message: 'Browser was closed. List pages again.' } });
      return;
    }
    try {
      leases.assertAvailable(page.identity.accountId);
      const result = await trackOperation(page, async () => {
        if (req.method.startsWith('Input.')) await options.focus?.(page.contents.id);
        return sendPageCommand(page.contents, req.method, req.params ?? {});
      });
      response({ result });
    } catch (error) {
      response({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  };
  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const runtime = createWorkbenchRuntime(app.getPath('userData'), {
    list: () =>
      [...pages]
        .filter(([, p]) => !p.contents.isDestroyed())
        .map(([targetId, p]) => ({ ...p.identity, targetId, url: p.contents.getURL() })),
    command: async (accountId, method, params) => {
      leases.assertAvailable(accountId);
      const page = [...pages.values()].find((p) => p.identity.accountId === accountId);
      if (!page || page.contents.isDestroyed()) throw new Error('Account browser is closed.');
      return trackOperation(page, async () => {
        if (method.startsWith('Input.')) await options.focus?.(page.contents.id);
        return sendPageCommand(page.contents, method, params);
      });
    },
    focus: async (accountId) => {
      leases.assertAvailable(accountId);
      const page = [...pages.values()].find((p) => p.identity.accountId === accountId);
      if (!page || page.contents.isDestroyed()) throw new Error('Account browser is closed.');
      await options.focus?.(page.contents.id);
    },
    copy: async (accountId) => {
      leases.assertAvailable(accountId);
      const page = [...pages.values()].find((p) => p.identity.accountId === accountId);
      if (!page || page.contents.isDestroyed()) throw new Error('Account browser is closed.');
      return trackOperation(page, async () => {
        // Clear first so a page that refuses copy cannot expose previous clipboard contents.
        clipboard.clear();
        page.contents.copy();
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const copied = clipboard.readText();
          if (copied) return copied.slice(0, 200000);
        }
        throw new Error('Copy returned no text. Select table cells and retry; this does not verify an empty table.');
      });
    },
    paste: (accountId, text) => {
      leases.assertAvailable(accountId);
      const page = [...pages.values()].find((p) => p.identity.accountId === accountId);
      if (!page || page.contents.isDestroyed()) throw new Error('Account browser is closed.');
      clipboard.writeText(text);
      page.contents.focus();
      page.contents.paste();
    },
  });
  let replies: ReturnType<typeof createReplyService> | undefined;
  try {
    replies = createReplyService({
      directory: path.join(app.getPath('userData'), 'workbench', 'replies'),
      browsers: leases,
      table: createReplyTableAdapter(),
      platform: createReplyPlatformAdapter(),
    });
  } catch {
    /* Preserve a corrupt outbox and disable only replies. */
  }
  const reply = (action: ReplySyncAction, signal?: AbortSignal) =>
    replies ? replies.action(action, signal) : Promise.reject(new Error('replyStoreInvalid'));
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const wsUrl = `ws://127.0.0.1:${port}/aionui-cdp?token=${token}`;
    if (url.pathname === '/workbench' && req.method === 'POST') {
      if (req.headers.origin || !tokensMatch(token, (req.headers.authorization ?? '').replace(/^Bearer /, ''))) {
        res.writeHead(403).end();
        return;
      }
      let body = '';
      let overflow = false;
      req.on('data', (chunk: Buffer) => {
        if (overflow) return;
        body += chunk.toString();
        if (Buffer.byteLength(body) > 2_000_000) {
          overflow = true;
          res.writeHead(413).end();
        }
      });
      req.on('end', () => {
        if (overflow) return;
        void (async () => {
          let controller: AbortController | undefined;
          const abort = () => controller?.abort();
          const close = () => {
            if (!res.writableEnded) abort();
          };
          try {
            const input = JSON.parse(body);
            if (input?.action === 'reply-sync') {
              controller = new AbortController();
              req.once('aborted', abort);
              res.once('close', close);
              if (req.aborted || res.destroyed) abort();
            }
            json(res, {
              result: await (input?.action === 'reply-sync'
                ? reply(input.request, controller?.signal)
                : runtime(input)),
            });
          } catch (error) {
            json(res, { error: error instanceof Error ? error.message : 'Workbench operation failed' });
          } finally {
            req.removeListener('aborted', abort);
            res.removeListener('close', close);
          }
        })();
      });
      return;
    }

    if (url.pathname === '/json/version') {
      json(res, buildVersionPayload(wsUrl, process.versions.chrome ?? '0'));
      return;
    }
    if (url.pathname === '/json/list' || url.pathname === '/json') {
      json(
        res,
        infos().map((t) => ({
          ...t,
          id: t.targetId,
          description: '',
          devtoolsFrontendUrl: '',
          webSocketDebuggerUrl: wsUrl,
        }))
      );
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/aionui-cdp' || !tokensMatch(token, url.searchParams.get('token') ?? '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { announced: new Set(), discover: false, autoAttach: false };
      clients.set(ws, client);
      ws.on('message', (data) => void handle(ws, data.toString(), client));
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      const address = http.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('No bridge port'));
    });
  });
  const detach = () => {
    for (const id of [...pages.keys()]) remove(id);
  };
  return {
    port,
    token,
    attach,
    detach,
    reply,
    attachedWebContentsId: () => [...pages.values()][0]?.contents.id ?? null,
    close: async () => {
      replies?.close();
      detach();
      for (const ws of clients.keys()) ws.terminate();
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve())));
    },
  };
};
