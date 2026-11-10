import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { AccountStore, FEISHU_PARTITION } from '@/renderer/pages/Workbench/accountStore';

it.runIf(process.env.WORKBENCH_ELECTRON_TEST === '1')(
  'keeps account cookies isolated across a real Electron restart',
  () => {
    const profile = mkdtempSync(join(tmpdir(), 'workbench-session-test-'));
    const values = new Map<string, string>();
    const store = new AccountStore({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    });
    const partitions = [...store.add('Second').accounts.map((a) => a.partition), FEISHU_PARTITION];
    const electronPath = createRequire(import.meta.url)('electron') as string;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      for (const mode of ['write', 'read']) {
        const output = join(profile, `${mode}.json`);
        const result = spawnSync(
          electronPath,
          [resolve('tests/unit/workbench/session-fixture.cjs'), profile, mode, output, ...partitions],
          { env, timeout: 30000, encoding: 'utf8' }
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual([['account-0'], ['account-1'], ['account-2']]);
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  },
  70000
);
