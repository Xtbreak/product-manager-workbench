import { randomUUID } from 'node:crypto';
import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const commentSchema = z.object({
  noteId: id,
  commentId: id,
  author: z.string().max(1000),
  time: z.string().min(1).max(1000).optional(),
  text: z.string().max(20000),
  noteUrl: z.string().url().max(4000),
});
export type Comment = z.infer<typeof commentSchema>;
const rowSchema = commentSchema.extend({ key: z.string(), accounts: z.array(id), written: z.boolean() });
const batchSchema = z.object({ id, keys: z.array(z.string()) });
const runSchema = z.object({
  id,
  accountIds: z.array(id).min(1),
  tableUrl: z.string().url(),
  layout: z.enum(['compact', 'legacy']).default('legacy'),
  stopped: z.boolean(),
  destinationChecked: z.boolean().default(false),
  rows: z.array(rowSchema),
  pending: batchSchema.nullable(),
});
export type SyncRun = z.infer<typeof runSchema>;
export type SyncRow = z.infer<typeof rowSchema>;
export type SyncBatch = { id: string; rows: SyncRow[]; tsv: string; columns: string[] };
const documentSchema = z.object({ version: z.literal(1), runs: z.array(runSchema) });
export type JournalStorage = { read: () => Promise<string | null>; write: (json: string) => Promise<void> };
export const COMMENT_COLUMNS = ['用户', '时间', '评论'];
export const SYNC_COLUMNS = ['采集键', '笔记 ID', '评论 ID', '作者', '评论内容', '来源账号', '笔记链接'];
/** Keep one record per line and neutralize spreadsheet formulas from untrusted comments. */
const cell = (value: string) => {
  const clean = value.replace(/[\t\r\n]+/g, ' ');
  return /^[=+@-]/.test(clean.trimStart()) ? `'${clean}` : clean;
};
/** Validate a Feishu/Lark table destination without storing signed login links. */
export function normalizeTableUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname) ||
    !/^\/(base|wiki)\/[a-zA-Z0-9]+/.test(url.pathname) ||
    !url.searchParams.get('table')
  )
    throw new Error('Open a Feishu multi-dimensional table with a table ID first.');
  return `${url.origin}${url.pathname}?table=${encodeURIComponent(url.searchParams.get('table')!)}`;
}
/** Durable, serialized checkpoints. No browser writes happen inside this journal. */
export class SyncJournal {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: JournalStorage) {}
  private transaction<T>(fn: (runs: SyncRun[]) => T, write = true): Promise<T> {
    const result = this.queue.then(async () => {
      const raw = await this.storage.read();
      const doc = raw === null ? { version: 1 as const, runs: [] as SyncRun[] } : documentSchema.parse(JSON.parse(raw));
      const value = fn(doc.runs);
      if (write) await this.storage.write(JSON.stringify(doc));
      return structuredClone(value);
    });
    this.queue = result.catch((): undefined => undefined);
    return result;
  }
  private run(runs: SyncRun[], runId: string, active = false): SyncRun {
    const run = runs.find((r) => r.id === runId);
    if (!run) throw new Error('Unknown sync run.');
    if (active && run.stopped) throw new Error('Run is stopped. Resume explicitly before continuing.');
    return run;
  }
  /** Reusing a run ID never changes its accounts or destination. */
  start(runId: string, accountIds: string[], tableUrl: string, layout?: 'compact' | 'legacy'): Promise<SyncRun> {
    id.parse(runId);
    z.array(id).min(1).max(30).parse(accountIds);
    const destination = normalizeTableUrl(tableUrl);
    return this.transaction((runs) => {
      const existing = runs.find((r) => r.id === runId);
      if (existing) {
        if (existing.tableUrl !== destination || JSON.stringify(existing.accountIds) !== JSON.stringify(accountIds))
          throw new Error('Run destination/accounts cannot change.');
        if (layout && existing.layout !== layout) throw new Error('Run layout cannot change.');
        return existing;
      }
      const nextLayout = layout ?? 'compact';
      if (runs.some((run) => run.tableUrl === destination && run.layout !== nextLayout))
        throw new Error('Destination already uses a different column layout. Choose a separate table.');
      const run: SyncRun = {
        id: runId,
        accountIds,
        tableUrl: destination,
        layout: nextLayout,
        stopped: false,
        destinationChecked: false,
        rows: [],
        pending: null,
      };
      runs.push(run);
      return run;
    });
  }
  /** Store observed comments and merge source accounts across duplicate reads. */
  collect(runId: string, accountId: string, comments: Comment[]): Promise<SyncRun> {
    z.array(commentSchema).max(1000).parse(comments);
    return this.transaction((runs) => {
      const run = this.run(runs, runId, true);
      if (run.layout === 'compact' && comments.some((comment) => !comment.time?.trim()))
        throw new Error(
          'Three-column sync requires the observed comment time; use 未显示 only when the source shows no time.'
        );
      if (!run.accountIds.includes(accountId)) throw new Error('Account is not part of this run.');
      if (run.pending || run.rows.some((r) => r.written))
        throw new Error('Finish collecting all accounts before writing; start a new run for additional collection.');
      run.destinationChecked = false;
      for (const comment of comments) {
        const key = `xhs:${comment.noteId}:${comment.commentId}`;
        const row = run.rows.find((r) => r.key === key);
        if (row) {
          if (!row.accounts.includes(accountId)) row.accounts.push(accountId);
        } else
          run.rows.push({
            ...comment,
            noteUrl: `https://www.xiaohongshu.com/explore/${comment.noteId}`,
            key,
            accounts: [accountId],
            written: false,
          });
      }
      return run;
    });
  }
  /** Mark keys observed in the destination, including duplicates from earlier runs. */
  existing(runId: string, tableUrl: string, present: string[]): Promise<SyncRun> {
    return this.transaction((runs) => {
      const run = this.run(runs, runId, true);
      if (normalizeTableUrl(tableUrl) !== run.tableUrl || run.pending)
        throw new Error('Wrong destination or unresolved batch.');
      for (const row of run.rows) if (present.includes(row.key)) row.written = true;
      run.destinationChecked = true;
      return run;
    });
  }
  /** Mark the batch uncertain BEFORE dispatch; retries must reconcile against the table. */
  prepare(runId: string): Promise<SyncBatch> {
    return this.transaction((runs) => {
      const run = this.run(runs, runId, true);
      if (!run.destinationChecked) throw new Error('Inspect destination keys before writing.');
      if (run.pending) throw new Error('Reconcile the pending batch against the destination before retry.');
      const siblings = runs.filter((r) => r.id !== run.id && r.tableUrl === run.tableUrl);
      if (siblings.some((r) => r.pending))
        throw new Error('Reconcile another run’s pending batch on this destination first.');
      const confirmed = new Set(siblings.flatMap((r) => r.rows.filter((row) => row.written).map((row) => row.key)));
      for (const row of run.rows) if (confirmed.has(row.key)) row.written = true;
      const rows = run.rows.filter((r) => !r.written).slice(0, 50);
      const columns = run.layout === 'compact' ? COMMENT_COLUMNS : SYNC_COLUMNS;
      if (!rows.length) return { id: 'complete', rows: [] as SyncRow[], columns, tsv: '' };
      const batchId = randomUUID();
      run.pending = { id: batchId, keys: rows.map((r) => r.key) };
      return {
        id: batchId,
        rows,
        columns,
        tsv: rows
          .map((r) =>
            (run.layout === 'compact'
              ? [r.author, r.time!, r.text]
              : [r.key, r.noteId, r.commentId, r.author, r.text, r.accounts.join(', '), r.noteUrl]
            )
              .map(cell)
              .join('\t')
          )
          .join('\n'),
      };
    });
  }
  /** Both present and confirmed-absent keys must account for the whole uncertain batch. */
  reconcile(runId: string, batchId: string, present: string[], absent: string[]): Promise<SyncRun> {
    return this.transaction((runs) => {
      const run = this.run(runs, runId);
      const keys = [...present, ...absent];
      if (
        !run.pending ||
        run.pending.id !== batchId ||
        new Set(keys).size !== keys.length ||
        keys.length !== run.pending.keys.length ||
        keys.some((k) => !run.pending!.keys.includes(k))
      )
        throw new Error('Reconciliation must cover exactly the pending batch, with observed present/absent keys.');
      for (const row of run.rows) if (present.includes(row.key)) row.written = true;
      run.pending = null;
      return run;
    });
  }
  /** Pausing never drops in-flight/uncertain state. */
  stop(runId: string): Promise<SyncRun> {
    return this.transaction((runs) => {
      const run = this.run(runs, runId);
      run.stopped = true;
      return run;
    });
  }
  /** Resume preserves unresolved writes, which still require reconciliation. */
  resume(runId: string): Promise<SyncRun> {
    return this.transaction((runs) => {
      const run = this.run(runs, runId);
      run.stopped = false;
      return run;
    });
  }
  /** Read persisted state, including after a process restart. */
  status(runId: string): Promise<SyncRun> {
    return this.transaction((runs) => this.run(runs, runId), false);
  }
}
