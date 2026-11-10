import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRepl } from '../../../packages/desktop/src/process/services/workbench/browserRepl';
const directory = mkdtempSync(join(tmpdir(), 'browser-repl-'));
const workerPath = join(directory, 'worker.cjs');
beforeAll(async () => {
  await build({
    entryPoints: ['packages/desktop/src/process/worker/browserRepl/entry.ts'],
    outfile: workerPath,
    platform: 'node',
    format: 'cjs',
    bundle: true,
  });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
describe('account browser REPL', () => {
  it('rejects page-side delayed work before it can outlive Stop', async () => {
    const calls: unknown[] = [];
    const host = new BrowserRepl(workerPath, async (args) => {
      calls.push(args);
      return {};
    });
    try {
      await expect(
        host.execute(
          'await browser.page("primary").evaluate(async () => { await new Promise(r => setTimeout(r, 5)); document.title = "late"; })'
        )
      ).rejects.toThrow(/synchronous/);
      expect(calls).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it('retains bindings and routes page actions to the explicitly selected account', async () => {
    const host = new BrowserRepl(workerPath, async (args) => {
      if (args.accountId !== 'second') throw new Error('Wrong account');
      return { result: { value: 'second account page' } };
    });
    try {
      await host.execute('var page = browser.page("second"); var title = await page.evaluate(() => document.title)');
      expect((await host.execute('title')).text).toContain('second account page');
    } finally {
      await host.close();
    }
  });
  it('interrupts infinite JavaScript and starts a clean REPL after timeout', async () => {
    const host = new BrowserRepl(workerPath, async () => null);
    try {
      await expect(host.execute('while(true) {}', { timeoutMs: 500 })).rejects.toThrow(/timed out/);
      expect((await host.execute('1 + 2')).text).toContain('3');
    } finally {
      await host.close();
    }
  });
  it('revokes an aborted evaluation so its remaining browser operations never dispatch', async () => {
    const calls: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const host = new BrowserRepl(workerPath, async (args) => {
      calls.push(String(args.action));
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      return [];
    });
    try {
      const controller = new AbortController();
      const result = host.execute('await browser.accounts(); await browser.accounts()', { signal: controller.signal });
      const rejection = expect(result).rejects.toThrow(/stopped/);
      await ready;
      controller.abort();
      release();
      await rejection;
      expect(calls).toEqual(['accounts']);
    } finally {
      await host.close();
    }
  });
  it('rejects detached actions after the originating evaluation has finished', async () => {
    const calls: string[] = [];
    const host = new BrowserRepl(workerPath, async (args) => {
      calls.push(String(args.action));
      return [];
    });
    try {
      await host.execute('setTimeout(() => browser.accounts().catch(() => {}), 50); "scheduled"');
      await new Promise((r) => setTimeout(r, 150));
      expect(calls).toEqual([]);
    } finally {
      await host.close();
    }
  });
});
