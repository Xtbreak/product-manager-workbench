import { parentPort } from 'node:worker_threads';
import { start } from 'node:repl';
import { PassThrough } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';
import { createBrowserApi } from './pageApi';
const port = parentPort!;
const scope = new AsyncLocalStorage<{ id: string; logs: string[] }>();
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let sequence = 0;
const rpc = (args: Record<string, unknown>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const execution = scope.getStore();
    if (!execution) {
      reject(new Error('No active execution'));
      return;
    }
    const id = String(++sequence);
    pending.set(id, { resolve, reject });
    port.postMessage({ type: 'rpc', executionId: execution.id, id, args });
  });
const output = new PassThrough();
output.resume();
const repl = start({
  input: new PassThrough(),
  output,
  terminal: false,
  useColors: false,
  ignoreUndefined: true,
  writer: (value: unknown) => {
    // Rejected top-level await is reported through Node REPL's writer.
    const execution = scope.getStore();
    if (execution)
      port.postMessage({
        type: 'result',
        executionId: execution.id,
        error: value instanceof Error ? value.message : String(value),
      });
    return '';
  },
});
repl.context.browser = createBrowserApi(rpc);
repl.context.sync = rpc;
repl.context.console = {
  log: (...args: unknown[]) => {
    const logs = scope.getStore()?.logs;
    if (logs && logs.join('').length < 24000)
      logs.push(args.map((v) => inspect(v, { depth: 6, maxArrayLength: 100, maxStringLength: 12000 })).join(' '));
  },
};
port.on(
  'message',
  (message: { type: string; id: string; value: unknown; error?: string; code: string; executionId: string }) => {
    if (message.type === 'reply') {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(message.error));
      else call?.resolve(message.value);
    } else if (message.type === 'execute') {
      const execution = { id: message.executionId, logs: [] as string[] };
      scope.run(execution, () => {
        repl.eval(message.code + '\n', repl.context, 'workbench-repl', (error: Error | null, value: unknown) => {
          const text = [
            ...execution.logs,
            value === undefined ? '' : inspect(value, { depth: 8, maxArrayLength: 100, maxStringLength: 20000 }),
          ]
            .filter(Boolean)
            .join('\n')
            .slice(0, 32000);
          port.postMessage({ type: 'result', executionId: execution.id, text, error: error?.message });
        });
      });
    }
  }
);
