import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchRuntime } from '@/process/services/workbench/runtime';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup(layout: 'compact' | 'legacy' = 'legacy') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workbench-sync-'));
  dirs.push(dir);
  const destination = 'https://test.feishu.cn/base/base1?table=tbl1';
  const accounts = ['a', 'b', 'feishu'].map((accountId) => ({
    accountId,
    name: accountId,
    targetId: accountId,
    url: accountId === 'feishu' ? destination : 'https://www.xiaohongshu.com/explore',
  }));
  const paste = vi.fn();
  const browsers = { list: () => accounts, command: vi.fn(), paste };
  const run = createWorkbenchRuntime(dir, browsers);
  await run({ action: 'start', runId: 'test', accountIds: ['a', 'b'], tableUrl: destination, layout });
  const comments = [
    {
      noteId: 'note1',
      commentId: 'comment1',
      author: 'A',
      time: '3天前',
      text: '=1+1\tsecond\nline',
      noteUrl: 'https://www.xiaohongshu.com/explore/note1',
    },
  ];
  for (const accountId of ['a', 'b']) await run({ action: 'collect', runId: 'test', accountId, comments });
  await run({ action: 'existing', runId: 'test', tableUrl: destination, present: [] });
  return { run, paste, accounts, reopen: () => createWorkbenchRuntime(dir, browsers), destination };
}
describe('browser paste with durable recovery', () => {
  it('pastes exactly one deduped safe row and prevents duplicate paste after restart', async () => {
    const f = await setup();
    await f.run({ action: 'paste', runId: 'test' });
    expect(f.paste).toHaveBeenCalledOnce();
    expect(f.paste.mock.calls[0][1]).toContain("'=1+1 second line\ta, b");
    await expect(f.reopen()({ action: 'paste', runId: 'test' })).rejects.toThrow(/reconcile/i);
  });
  it('does not paste into a different table or after stop', async () => {
    const f = await setup();
    f.accounts[2].url = 'https://test.feishu.cn/base/other?table=tbl2';
    await expect(f.run({ action: 'paste', runId: 'test' })).rejects.toThrow(/destination/i);
    f.accounts[2].url = f.destination;
    await f.run({ action: 'stop', runId: 'test' });
    await expect(f.run({ action: 'paste', runId: 'test' })).rejects.toThrow(/stopped/i);
    expect(f.paste).not.toHaveBeenCalled();
  });
  it('retains uncertain state if the external paste fails', async () => {
    const f = await setup();
    f.paste.mockImplementation(() => {
      throw new Error('browser closed');
    });
    await expect(f.run({ action: 'paste', runId: 'test' })).rejects.toThrow('browser closed');
    await expect(f.reopen()({ action: 'paste', runId: 'test' })).rejects.toThrow(/reconcile/i);
  });
  it('skips a comment already present from an earlier run', async () => {
    const f = await setup();
    await f.run({ action: 'existing', runId: 'test', tableUrl: f.destination, present: ['xhs:note1:comment1'] });
    expect(await f.run({ action: 'paste', runId: 'test' })).toMatchObject({ state: 'complete', rows: [] });
    expect(f.paste).not.toHaveBeenCalled();
  });
});

it('dispatches compact rows in one paste with only three visible columns', async () => {
  const f = await setup('compact');
  const result = await f.run({ action: 'paste', runId: 'test' });
  expect(result).toMatchObject({ columns: ['用户', '时间', '评论'], state: 'awaiting-verification' });
  expect(f.paste).toHaveBeenCalledExactlyOnceWith('feishu', "A\t3天前\t'=1+1 second line");
  await expect(f.reopen()({ action: 'paste', runId: 'test' })).rejects.toThrow(/reconcile/i);
});

describe('local CLI sync transport', () => {
  const setupCli = async () => {
    const { SyncJournal } = await import('../../../packages/desktop/src/process/services/workbench/syncJournal');
    const { createFeishuSync } = await import('../../../packages/desktop/src/process/services/workbench/feishuSync');
    let saved: string | null = null;
    const journal = new SyncJournal({
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
    });
    await journal.start('cli-run', ['source'], 'https://my.feishu.cn/base/Base123?table=tbl123');
    await journal.collect('cli-run', 'source', [
      {
        noteId: 'note1',
        commentId: 'comment1',
        author: 'User',
        time: 'Today',
        text: 'Real comment',
        noteUrl: 'https://www.xiaohongshu.com/explore/note1',
      },
    ]);
    let records: (string | null)[][] = [];
    const execute = vi.fn(async (args: string[], _timeout?: number, input?: string): Promise<unknown> => {
      if (args[1] === '+field-list')
        return { ok: true, data: { fields: ['用户', '时间', '评论'].map((name) => ({ name, type: 'text' })) } };
      if (args[1] === '+record-list')
        return { ok: true, data: { fields: ['用户', '时间', '评论'], data: records, has_more: false } };
      if (args[0] === 'api') {
        const row = JSON.parse(input!).create_records[0];
        records = [[row.用户, row.时间, row.评论]];
        return { ok: true, data: { record_id_list: ['record1'] } };
      }
      throw new Error('Unexpected command');
    });
    return { journal, execute, sync: createFeishuSync(journal, execute) };
  };
  it('writes three fields through CLI and durably verifies the batch', async () => {
    const { sync, journal } = await setupCli();
    expect(await sync('cli-run')).toMatchObject({ state: 'complete', written: 1 });
    expect((await journal.status('cli-run')).rows[0].written).toBe(true);
    expect(await sync('cli-run')).toMatchObject({ state: 'complete', written: 0 });
  });
  it('preserves an uncertain batch and refuses to resend after transport failure', async () => {
    const { sync, execute, journal } = await setupCli();
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (args, timeout, input) => {
      if (args[0] === 'api') throw new Error('Transport failed');
      return original(args, timeout, input);
    });
    await expect(sync('cli-run')).rejects.toThrow('Transport failed');
    expect((await journal.status('cli-run')).pending).not.toBeNull();
    await expect(sync('cli-run')).rejects.toThrow('uncertain');
  });
  it('rejects a mismatched schema before dispatching any write', async () => {
    const { sync, execute } = await setupCli();
    execute.mockResolvedValueOnce({ ok: true, data: { fields: [{ name: 'Old field', type: 'text' }] } });
    await expect(sync('cli-run')).rejects.toThrow('exactly three');
    expect(execute.mock.calls.some(([args]) => args[0] === 'api')).toBe(false);
  });
  it('does not write a stopped run', async () => {
    const { sync, journal, execute } = await setupCli();
    await journal.stop('cli-run');
    await expect(sync('cli-run')).rejects.toThrow('active');
    expect(execute).not.toHaveBeenCalled();
  });
});
