import { z } from 'zod';
import { executeFeishu, type Execute } from './feishuAuth';
import { COMMENT_COLUMNS, normalizeTableUrl, type SyncJournal, type SyncRow } from './syncJournal';

const response = z.object({ ok: z.literal(true), data: z.unknown() });
const signature = (values: string[]) => JSON.stringify(values);
const rowSignature = (row: SyncRow) => signature([row.author, row.time!, row.text]);
/** CLI transport keeps writes behind the same durable uncertain-batch journal. */
export function createFeishuSync(journal: SyncJournal, execute: Execute = executeFeishu) {
  let busy = false;
  const call = async (args: string[], input?: string) => response.parse(await execute(args, 30000, input)).data;
  return async (runId: string) => {
    if (busy) throw new Error('A CLI sync is already in progress.');
    busy = true;
    try {
      let run = await journal.status(runId);
      if (run.stopped || run.layout !== 'compact') throw new Error('CLI sync requires an active three-column run.');
      if (new Set(run.rows.map(rowSignature)).size !== run.rows.length)
        throw new Error('Identical comment tuples are ambiguous. No CLI write was attempted.');
      const url = new URL(normalizeTableUrl(run.tableUrl));
      const parts = url.pathname.split('/');
      let base = parts[2];
      const table = url.searchParams.get('table')!;
      if (!/^[a-zA-Z0-9]+$/.test(base) || !/^tbl[a-zA-Z0-9]+$/.test(table))
        throw new Error('Invalid table identifier.');
      if (parts[1] === 'wiki') {
        const node = z
          .object({ node: z.object({ obj_type: z.literal('bitable'), obj_token: z.string().regex(/^[a-zA-Z0-9]+$/) }) })
          .parse(await call(['wiki', 'spaces', 'get_node', '--token', base, '--as', 'user', '--format', 'json']));
        base = node.node.obj_token;
      }
      const flags = ['--base-token', base, '--table-id', table, '--as', 'user', '--format', 'json'];
      const fields = z
        .object({ fields: z.array(z.object({ name: z.string(), type: z.string() })) })
        .parse(await call(['base', '+field-list', ...flags]));
      if (
        fields.fields.length !== 3 ||
        COMMENT_COLUMNS.some(
          (name, index) => fields.fields[index].name !== name || fields.fields[index].type !== 'text'
        )
      )
        throw new Error('Destination must have exactly three text fields: 用户, 时间, 评论.');
      const inspect = async () => {
        const counts = new Map<string, number>();
        let offset = 0;
        for (let page = 0; page < 500; page++) {
          const data = z
            .object({
              fields: z.array(z.string()),
              data: z.array(z.array(z.union([z.string(), z.null()]))),
              has_more: z.boolean(),
              next_offset: z.number().optional(),
            })
            .parse(await call(['base', '+record-list', ...flags, '--limit', '200', '--offset', String(offset)]));
          if (JSON.stringify(data.fields) !== JSON.stringify(COMMENT_COLUMNS))
            throw new Error('Destination fields changed.');
          for (const cells of data.data) {
            if (cells.length !== 3) throw new Error('Unexpected record shape.');
            const key = signature(cells.map((value) => value ?? ''));
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          if (!data.has_more) return counts;
          const next = data.next_offset ?? offset + data.data.length;
          if (next <= offset) throw new Error('Record pagination did not advance.');
          offset = next;
        }
        throw new Error('Destination exceeds the supported inspection limit.');
      };
      const match = (rows: SyncRow[], counts: Map<string, number>) => {
        if (rows.some((row) => (counts.get(rowSignature(row)) ?? 0) > 1))
          throw new Error('Duplicate destination tuples need manual reconciliation.');
        return rows.filter((row) => counts.get(rowSignature(row)) === 1).map((row) => row.key);
      };
      const counts = await inspect();
      if (run.pending) {
        // Do not auto-retry an uncertain request, even if a just-read snapshot is empty.
        const pendingRows = run.rows.filter((row) => run.pending!.keys.includes(row.key));
        const present = match(pendingRows, counts);
        if (present.length !== pendingRows.length)
          throw new Error('Previous CLI write is uncertain. Reconcile the pending batch before retry.');
        run = await journal.reconcile(runId, run.pending.id, present, []);
      }
      await journal.existing(runId, run.tableUrl, match(run.rows, counts));
      const batch = await journal.prepare(runId);
      if (!batch.rows.length) return { state: 'complete', written: 0 };
      if ((await journal.status(runId)).stopped)
        throw new Error('Stopped before CLI write. Pending batch requires reconciliation.');
      await call(
        [
          'api',
          'POST',
          `/open-apis/base/v3/bases/${base}/tables/${table}/records/batch_create`,
          '--as',
          'user',
          '--data',
          '-',
          '--format',
          'json',
        ],
        JSON.stringify({
          create_records: batch.rows.map((row) => ({ 用户: row.author, 时间: row.time!, 评论: row.text })),
        })
      );
      const present = match(batch.rows, await inspect());
      if (present.length !== batch.rows.length)
        throw new Error('CLI write could not be fully verified; the pending batch was preserved.');
      const latest = await journal.reconcile(runId, batch.id, present, []);
      return {
        state: latest.rows.every((row) => row.written) ? 'complete' : 'continue',
        written: present.length,
        batchId: batch.id,
      };
    } finally {
      busy = false;
    }
  };
}
