#!/usr/bin/env node
/** @license Copyright 2025 AionUi (aionui.com) SPDX-License-Identifier: Apache-2.0 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { resolveBridgeToken, resolveBrowserUrl } from './browserServerPort';
import { workbenchTool, browserReplTool } from './workbenchTools';
import { BrowserRepl, ReplInterruptedError } from '../../services/workbench/browserRepl';
/** Account-bound tools execute through the workbench bridge; stdout is MCP only. */
async function main() {
  const browserUrl = resolveBrowserUrl({ env: process.env });
  const token = resolveBridgeToken({ env: process.env });
  if (!browserUrl || !token) throw new Error('In-app browser bridge is unavailable.');
  const server = new Server({ name: 'aionui-browser', version: '3.0.0' }, { capabilities: { tools: {} } });
  let activeRun: string | undefined;
  const action = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    // Capture the run before dispatch so cancellation during start also stops it.
    if (typeof args.runId === 'string' && ['start', 'resume', 'collect', 'paste'].includes(String(args.action)))
      activeRun = args.runId;
    const response = await fetch(`${browserUrl}/workbench`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal,
    });
    if (!response.ok) throw new Error(`Workbench bridge returned ${response.status}`);
    const payload = (await response.json()) as { result?: unknown; error?: string };
    if (payload.error) throw new Error(payload.error);
    return payload.result;
  };
  type Execution = { runId?: string; images: Array<{ type: 'image'; data: string; mimeType: string }> };
  let execution: Execution | undefined;
  const repl = new BrowserRepl(resolve(__dirname, 'builtin-browser-repl.js'), async (args, signal) => {
    const owner = execution;
    if (!owner) throw new Error('Execution expired');
    if (typeof args.runId === 'string' && ['start', 'resume', 'collect', 'paste'].includes(String(args.action)))
      owner.runId = args.runId;
    const result = await action(args, signal);
    signal?.throwIfAborted();
    if (execution !== owner) throw new Error('Execution expired');
    if (args.action === 'browser' && args.method === 'Page.captureScreenshot') {
      const screenshot = result as { data: string };
      if (owner.images.length >= 3) throw new Error('At most three screenshots per execution.');
      owner.images.push({ type: 'image', data: screenshot.data, mimeType: 'image/png' });
      return { screenshot: 'Attached to this tool response.' };
    }
    return result;
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [browserReplTool, workbenchTool] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    const requestRun = typeof args.runId === 'string' ? args.runId : activeRun;
    let owner: Execution | undefined;
    const stopRun = async () => {
      const runId = owner?.runId ?? requestRun;
      if (runId) await action({ action: 'stop', runId }).catch((): undefined => undefined);
    };
    const abort = () => {
      void stopRun();
    };
    extra.signal.addEventListener('abort', abort, { once: true });
    try {
      extra.signal.throwIfAborted();
      if (request.params.name === 'browser_repl') {
        if (typeof args.code !== 'string') throw new Error('code must be JavaScript text.');
        if (execution) throw new Error('REPL is busy. Wait for the current execution.');
        owner = { runId: requestRun, images: [] };
        execution = owner;
        const result = await repl.execute(args.code, {
          signal: extra.signal,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        });
        return { content: [{ type: 'text', text: result.text || 'Completed.' }, ...owner.images] };
      }
      if (request.params.name !== 'workbench') throw new Error('Unknown tool. Use browser_repl or workbench.');
      if (args.action === 'stop' && execution?.runId === args.runId) await repl.close();
      const result = await action(args, extra.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      if (owner && (extra.signal.aborted || error instanceof ReplInterruptedError)) await stopRun();
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    } finally {
      extra.signal.removeEventListener('abort', abort);
      if (owner && execution === owner) execution = undefined;
    }
  });
  const close = async () => {
    await repl.close();
    if (activeRun) await action({ action: 'stop', runId: activeRun }).catch((): undefined => undefined);
  };
  server.onclose = () => {
    void close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void close().finally(() => process.exit(0));
    });
  await server.connect(new StdioServerTransport());
}
main().catch((error) => {
  process.stderr.write(`[workbench-browser] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
