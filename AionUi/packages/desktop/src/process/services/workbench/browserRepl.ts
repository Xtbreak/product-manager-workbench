import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
export type BrowserRpc = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
type Execution = {
  id: string;
  controller: AbortController;
  resolve: (value: { text: string }) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};
export class ReplInterruptedError extends Error {}
/** Persistent agent execution; worker termination bounds even synchronous infinite loops. */
export class BrowserRepl {
  private worker?: Worker;
  private active?: Execution;
  constructor(
    private readonly workerPath: string,
    private readonly dispatch: BrowserRpc
  ) {}
  async execute(code: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ text: string }> {
    if (this.active) throw new Error('REPL is busy. Wait for the current execution.');
    if (options.signal?.aborted) throw new Error('REPL stopped.');
    if (!code.trim() || code.length > 100_000) throw new Error('Provide 1–100000 characters of JavaScript.');
    if (!this.worker) {
      const worker = new Worker(this.workerPath, {
        env: {},
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      this.worker = worker;
      worker.stdout?.resume();
      worker.stderr?.resume();
      worker.on(
        'message',
        (message: {
          type: string;
          executionId: string;
          id?: string;
          args?: Record<string, unknown>;
          text?: string;
          error?: string;
        }) => {
          const active = this.active;
          if (!active || active.id !== message.executionId || active.controller.signal.aborted) {
            if (message.type === 'rpc')
              worker.postMessage({
                type: 'reply',
                id: message.id,
                error: 'Execution expired; no browser actions are allowed.',
              });
            return;
          }
          if (message.type === 'rpc' && message.args) {
            void this.dispatch(message.args, active.controller.signal).then(
              (value) => {
                if (this.active === active) worker.postMessage({ type: 'reply', id: message.id, value });
              },
              (error) => {
                if (this.active === active) worker.postMessage({ type: 'reply', id: message.id, error: String(error) });
              }
            );
          } else if (message.type === 'result') {
            this.active = undefined;
            active.controller.abort();
            active.cleanup();
            if (message.error) active.reject(new Error(message.error));
            else active.resolve({ text: message.text ?? '' });
          }
        }
      );
      worker.on('error', (error) => {
        if (this.worker === worker) void this.close(error.message);
      });
      worker.on('exit', () => {
        if (this.worker === worker) void this.close('REPL worker exited.');
      });
    }
    return new Promise((resolve, reject) => {
      const stop = () => {
        void this.close('REPL stopped; variables reset. Check sync status before retry.');
      };
      const timer = setTimeout(
        () => {
          void this.close('REPL timed out; variables reset. Check sync status before retry.');
        },
        Math.max(100, Math.min(options.timeoutMs ?? 60_000, 120_000))
      );
      options.signal?.addEventListener('abort', stop, { once: true });
      const id = randomUUID();
      this.active = {
        id,
        controller: new AbortController(),
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', stop);
        },
      };
      this.worker!.postMessage({ type: 'execute', executionId: id, code });
    });
  }
  async close(reason = 'REPL stopped.'): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (active) {
      active.controller.abort();
      active.cleanup();
      active.reject(new ReplInterruptedError(reason));
    }
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
}
