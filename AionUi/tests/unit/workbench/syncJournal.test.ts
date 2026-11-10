import { describe, expect, it } from 'vitest';
import { SyncJournal } from '@/process/services/workbench/syncJournal';
const comment = {
  noteId: 'note1',
  commentId: 'c1',
  author: 'Alice',
  time: '3天前',
  text: 'hello',
  noteUrl: 'https://www.xiaohongshu.com/explore/note1',
};
function fixture() {
  let persisted: string | null = null;
  const storage = {
    read: async () => persisted,
    write: async (s: string) => {
      persisted = s;
    },
  };
  return { journal: new SyncJournal(storage), reopen: () => new SyncJournal(storage) };
}
describe('comment sync checkpoints', () => {
  it('deduplicates the same comment across accounts, preserving its sources', async () => {
    const { journal } = fixture();
    await journal.start('run1', ['a', 'b'], 'https://example.feishu.cn/base/test?table=tbl1');
    await journal.collect('run1', 'a', [comment]);
    await journal.collect('run1', 'b', [comment]);
    const state = await journal.status('run1');
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].accounts).toEqual(['a', 'b']);
  });
  it('retains uncertain writes over restart and refuses blind retry', async () => {
    const { journal, reopen } = fixture();
    await journal.start('run1', ['a'], 'https://example.feishu.cn/base/test?table=tbl1');
    await journal.collect('run1', 'a', [comment]);
    await journal.existing('run1', 'https://example.feishu.cn/base/test?table=tbl1', []);
    await journal.prepare('run1');
    await expect(reopen().prepare('run1')).rejects.toThrow(/reconcile/i);
  });
  it('stops new batches and resumes only missing rows after reconciliation', async () => {
    const { journal } = fixture();
    await journal.start('run1', ['a'], 'https://example.feishu.cn/base/test?table=tbl1');
    await journal.collect('run1', 'a', [comment, { ...comment, commentId: 'c2' }]);
    await journal.existing('run1', 'https://example.feishu.cn/base/test?table=tbl1', []);
    const batch = await journal.prepare('run1');
    await journal.stop('run1');
    await expect(journal.prepare('run1')).rejects.toThrow(/stopped/i);
    await journal.reconcile('run1', batch.id, [batch.rows[0].key], [batch.rows[1].key]);
    await journal.resume('run1');
    expect((await journal.prepare('run1')).rows.map((r) => r.commentId)).toEqual(['c2']);
  });
  it('rejects cross-run destinations, unknown sources, and unobserved confirmations', async () => {
    const { journal } = fixture();
    await journal.start('run1', ['a'], 'https://example.feishu.cn/base/test?table=tbl1');
    await expect(journal.start('run1', ['a'], 'https://other.feishu.cn/base/test?table=tbl1')).rejects.toThrow();
    await expect(journal.collect('run1', 'b', [comment])).rejects.toThrow();
    await expect(journal.reconcile('run1', 'missing', ['fake'], [])).rejects.toThrow();
  });
  it('requires a fresh destination check if additional comments are collected', async () => {
    const { journal } = fixture();
    await journal.start('run1', ['a'], 'https://example.feishu.cn/base/test?table=tbl1');
    await journal.existing('run1', 'https://example.feishu.cn/base/test?table=tbl1', ['xhs:note1:c1']);
    await journal.collect('run1', 'a', [comment]);
    await expect(journal.prepare('run1')).rejects.toThrow(/Inspect destination/);
  });
  it('serializes writes to the same destination across runs and reuses confirmed keys', async () => {
    const { journal } = fixture();
    const table = 'https://example.feishu.cn/base/test?table=tbl1';
    for (const run of ['one', 'two']) {
      await journal.start(run, ['a'], table);
      await journal.collect(run, 'a', [comment]);
      await journal.existing(run, table, []);
    }
    const batch = await journal.prepare('one');
    await expect(journal.prepare('two')).rejects.toThrow(/another run/i);
    await journal.reconcile(
      'one',
      batch.id,
      batch.rows.map((r) => r.key),
      []
    );
    expect((await journal.prepare('two')).rows).toEqual([]);
  });
});

it('batches only user, observed time and comment by default, keeping keys local', async () => {
  const { journal } = fixture();
  const table = 'https://example.feishu.cn/base/test?table=compact';
  await journal.start('three', ['a'], table);
  await journal.collect('three', 'a', [comment, { ...comment, commentId: 'c2', text: '=formula\tline' }]);
  await journal.existing('three', table, []);
  const batch = await journal.prepare('three');
  expect(batch.columns).toEqual(['用户', '时间', '评论']);
  expect(batch.tsv).toBe("Alice\t3天前\thello\nAlice\t3天前\t'=formula line");
  expect(batch.rows[0].key).toBe('xhs:note1:c1');
});
it('requires observed time and prevents mixing three and seven column runs', async () => {
  const { journal } = fixture();
  const table = 'https://example.feishu.cn/base/test?table=compact';
  await journal.start('three', ['a'], table);
  await expect(journal.collect('three', 'a', [{ ...comment, time: undefined }])).rejects.toThrow(/time/);
  await expect(journal.start('seven', ['a'], table, 'legacy')).rejects.toThrow(/layout/);
  await expect(journal.start('three', ['a'], table, 'legacy')).rejects.toThrow(/layout/);
});
it('resumes persisted seven-column journals without reinterpreting pending batches', async () => {
  const row = { ...comment, key: 'xhs:note1:c1', accounts: ['a'], written: false };
  let data = JSON.stringify({
    version: 1,
    runs: [
      {
        id: 'old',
        accountIds: ['a'],
        tableUrl: 'https://example.feishu.cn/base/test?table=old',
        stopped: false,
        destinationChecked: true,
        rows: [row],
        pending: null,
      },
    ],
  });
  const journal = new SyncJournal({
    read: async () => data,
    write: async (value) => {
      data = value;
    },
  });
  expect((await journal.start('old', ['a'], 'https://example.feishu.cn/base/test?table=old')).layout).toBe('legacy');
  expect((await journal.prepare('old')).tsv.split('\t')).toHaveLength(7);
});
