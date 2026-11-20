import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const directory = mkdtempSync(join(tmpdir(), 'workbench-mcp-tasks-'));
const entry = join(directory, 'browserServer.cjs');
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  await Promise.all([
    build({
      entryPoints: ['packages/desktop/src/process/resources/builtinMcp/browserServer.ts'],
      outfile: entry,
      platform: 'node',
      format: 'cjs',
      bundle: true,
    }),
    build({
      entryPoints: ['packages/desktop/src/process/worker/browserRepl/entry.ts'],
      outfile: join(directory, 'builtin-browser-repl.js'),
      platform: 'node',
      format: 'cjs',
      bundle: true,
    }),
  ]);
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

type Input = Record<string, unknown>;
const status = { enabled: false, busy: false, works: [], archived: 10, sent: 4, uncertain: 0 };
const textResult = (result: CallToolResult) => {
  const content = result.content.find((item) => item.type === 'text');
  if (!content || content.type !== 'text') throw new Error('Missing tool text');
  return JSON.parse(content.text);
};
async function connect(handle: (input: Input, res: ServerResponse) => void) {
  const requests: Input[] = [];
  const server = createServer((req, res) => {
    if (req.url !== '/workbench' || req.headers.authorization !== 'Bearer test-only-token') {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const input = JSON.parse(body) as Input;
      requests.push(input);
      handle(input, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  const client = new Client({ name: 'workbench-task-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { AIONUI_CDP_ACTIVE_PORT: String(address.port), AIONUI_CDP_BRIDGE_TOKEN: 'test-only-token' },
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  cleanups.push(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await client.connect(transport);
  return { client, requests };
}

describe('left-chat reply tasks over MCP', () => {
  it('advertises nested reply actions to the chat tool catalog', async () => {
    const { client } = await connect((_input, res) => res.end(JSON.stringify({ result: status })));
    const tool = (await client.listTools()).tools.find((item) => item.name === 'workbench');
    expect(tool?.inputSchema.properties).toMatchObject({
      action: { enum: expect.arrayContaining(['reply-sync']) },
      request: {
        required: ['action'],
        properties: {
          action: {
            enum: ['status', 'setup', 'configure', 'bind', 'collect', 'sync', 'reconcile', 'cancel', 'send-pending'],
          },
        },
      },
    });
    const request = tool?.inputSchema.properties?.request as { properties: Record<string, unknown> };
    expect(request.properties).not.toHaveProperty('mode');
    expect(request.properties).not.toHaveProperty('enabled');
  });

  it('explicitly dispatches the toolbar draft batch without row approval or an enable request', async () => {
    const { client, requests } = await connect((_input, res) =>
      res.end(JSON.stringify({ result: { ...status, buttonDispatchMode: 'manual', sendMode: 'toolbar' } }))
    );
    const result = textResult(
      (await client.callTool({
        name: 'workbench',
        arguments: { action: 'reply-sync', request: { action: 'send-pending' } },
      })) as CallToolResult
    );
    expect(result).toMatchObject({ enabled: false, buttonDispatchMode: 'manual', sendMode: 'toolbar' });
    expect(requests).toEqual([{ action: 'reply-sync', request: { action: 'send-pending' } }]);
  });

  it('cancels the selected button send without enabling automatic handling', async () => {
    const { client, requests } = await connect((_input, res) =>
      res.end(JSON.stringify({ result: { ...status, canCancelSend: false } }))
    );
    const result = textResult(
      (await client.callTool({
        name: 'workbench',
        arguments: { action: 'reply-sync', request: { action: 'cancel' } },
      })) as CallToolResult
    );
    expect(result).toMatchObject({ enabled: false, canCancelSend: false });
    expect(requests).toEqual([{ action: 'reply-sync', request: { action: 'cancel' } }]);
  });

  it('reports measured bridge duration alongside unchanged reply status', async () => {
    const { client, requests } = await connect((_input, res) => {
      setTimeout(() => res.end(JSON.stringify({ result: status })), 40);
    });
    const result = textResult(
      (await client.callTool({
        name: 'workbench',
        arguments: { action: 'reply-sync', request: { action: 'collect' } },
      })) as CallToolResult
    );
    expect(result).toMatchObject({
      ...status,
      execution: { startedAt: expect.any(String), finishedAt: expect.any(String) },
    });
    expect(result.execution.durationMs).toBeGreaterThanOrEqual(35);
    expect(requests).toEqual([{ action: 'reply-sync', request: { action: 'collect' } }]);
  });

  it('reports failed tasks as errors with their measured duration', async () => {
    const { client } = await connect((_input, res) => res.end(JSON.stringify({ error: 'replyBrowserUnavailable' })));
    const result = (await client.callTool({
      name: 'workbench',
      arguments: { action: 'reply-sync', request: { action: 'sync' } },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textResult(result)).toMatchObject({
      error: 'replyBrowserUnavailable',
      execution: { durationMs: expect.any(Number), startedAt: expect.any(String), finishedAt: expect.any(String) },
    });
  });

  it('returns the same reply status and timing through REPL sync', async () => {
    const { client } = await connect((_input, res) => res.end(JSON.stringify({ result: status })));
    const result = (await client.callTool({
      name: 'browser_repl',
      arguments: {
        code: 'var task = await sync({action:"reply-sync", request:{action:"status"}}); console.log(task.sent === 4 && typeof task.execution?.durationMs === "number")',
      },
    })) as CallToolResult;
    expect(result.content).toEqual([{ type: 'text', text: 'true' }]);
  });

  it.each(['workbench', 'browser_repl'])(
    'cancels %s reply transport without stopping an earlier archive run',
    async (name) => {
      let entered!: () => void;
      let disconnected!: () => void;
      const ready = new Promise<void>((resolve) => (entered = resolve));
      const closed = new Promise<void>((resolve) => (disconnected = resolve));
      const { client, requests } = await connect((input, res) => {
        if (input.action !== 'reply-sync') {
          res.end(JSON.stringify({ result: { state: 'collecting' } }));
          return;
        }
        res.on('close', disconnected);
        entered();
      });
      await client.callTool({ name: 'workbench', arguments: { action: 'start', runId: 'older-run' } });
      const controller = new AbortController();
      const pending = client.callTool(
        {
          name,
          arguments:
            name === 'workbench'
              ? { action: 'reply-sync', request: { action: 'sync' } }
              : { code: 'await sync({action:"reply-sync", request:{action:"sync"}})' },
        },
        undefined,
        { signal: controller.signal }
      );
      const rejected = expect(pending).rejects.toThrow();
      await ready;
      controller.abort();
      await rejected;
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(requests.map((item) => item.action)).toEqual(['start', 'reply-sync']);
    }
  );

  it.each(['workbench', 'browser_repl'])('stops the current %s CLI sync run on cancellation', async (name) => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => (entered = resolve));
    const { client, requests } = await connect((input, res) => {
      if (input.action === 'cli-sync') {
        entered();
        return;
      }
      res.end(JSON.stringify({ result: { state: input.action === 'stop' ? 'stopped' : 'collecting' } }));
    });
    await client.callTool({ name: 'workbench', arguments: { action: 'start', runId: 'older-run' } });
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name,
        arguments:
          name === 'workbench'
            ? { action: 'cli-sync', runId: 'current-cli-run' }
            : { code: 'await sync({action:"cli-sync", runId:"current-cli-run"})' },
      },
      undefined,
      { signal: controller.signal }
    );
    const rejected = expect(pending).rejects.toThrow();
    await ready;
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(requests).toContainEqual({ action: 'stop', runId: 'current-cli-run' }));
    expect(requests).not.toContainEqual({ action: 'stop', runId: 'older-run' });
  });
});
