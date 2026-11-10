import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
it.runIf(process.env.WORKBENCH_ELECTRON_TEST === '1')(
  'connects real MCP to three isolated Electron pages, pastes deduped rows and guards stop/retry',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-browser-e2e-'));
    try {
      const fixture = join(root, 'fixture.cjs');
      const mcp = join(root, 'browser.cjs');
      const output = join(root, 'result.json');
      const options = {
        bundle: true,
        platform: 'node' as const,
        format: 'cjs' as const,
        external: ['electron'],
        tsconfig: resolve('tsconfig.json'),
      };
      await build({ ...options, entryPoints: ['tests/integration/workbench/browser-fixture.ts'], outfile: fixture });
      await build({
        ...options,
        entryPoints: ['packages/desktop/src/process/resources/builtinMcp/browserServer.ts'],
        outfile: mcp,
      });
      await build({
        ...options,
        entryPoints: ['packages/desktop/src/process/worker/browserRepl/entry.ts'],
        outfile: join(root, 'builtin-browser-repl.js'),
      });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      // Bundled fixture still resolves Electron from this checkout.
      env.NODE_PATH = resolve('node_modules');
      const electron = createRequire(import.meta.url)('electron') as string;
      const result = spawnSync(electron, [fixture, join(root, 'profile'), mcp, output], {
        env,
        encoding: 'utf8',
        timeout: 75000,
      });
      expect(result.status, result.stderr).toBe(0);
      const data = JSON.parse(readFileSync(output, 'utf8'));
      expect(data.tools).toContain('workbench');
      expect(data.tools).toContain('browser_repl');
      expect(data.accounts.map((a: { accountId: string }) => a.accountId).sort()).toEqual([
        'feishu',
        'primary',
        'second',
      ]);
      expect(data.titles.map((t: { result: { value: string } }) => t.result.value)).toEqual([
        'primary',
        'second',
        'feishu',
      ]);
      expect([data.stopped, data.blindRetryBlocked, data.cancellationIsolated]).toEqual([true, true, true]);
      expect(data.final.rows).toHaveLength(1);
      expect(data.final.rows[0].written).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  90000
);
