import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createFeishuSync } from './feishuSync';
import { feishuAuth } from './feishuAuth';
import { SyncJournal, commentSchema, normalizeTableUrl } from './syncJournal';
export type BrowserAccount = { accountId: string; name: string; targetId: string; url: string };
export type BrowserAccess = {
  list: () => BrowserAccount[];
  command: (accountId: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
  paste: (accountId: string, text: string) => void;
  copy?: (accountId: string) => Promise<string>;
  focus?: (accountId: string) => Promise<void>;
};
const text = z.string().min(1).max(100);
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accounts') }),
  z.object({ action: z.literal('feishu-status') }),
  z.object({ action: z.literal('cli-sync'), runId: text }),
  z.object({ action: z.literal('copy'), accountId: text }),
  z.object({
    action: z.literal('browser'),
    accountId: text,
    method: z.enum([
      'Runtime.evaluate',
      'DOM.resolveNode',
      'Runtime.callFunctionOn',
      'Runtime.releaseObject',
      'Accessibility.getFullAXTree',
      'Page.navigate',
      'Input.dispatchMouseEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText',
      'Page.captureScreenshot',
    ]),
    params: z.record(z.unknown()).default({}),
  }),
  z.object({
    action: z.literal('start'),
    runId: text,
    accountIds: z.array(text).min(1),
    tableUrl: z.string().url(),
    layout: z.enum(['compact', 'legacy']).optional(),
  }),
  z.object({ action: z.literal('collect'), runId: text, accountId: text, comments: z.array(commentSchema).max(1000) }),
  z.object({ action: z.literal('existing'), runId: text, tableUrl: z.string().url(), present: z.array(z.string()) }),
  z.object({ action: z.literal('paste'), runId: text }),
  z.object({
    action: z.literal('reconcile'),
    runId: text,
    batchId: text,
    present: z.array(z.string()),
    absent: z.array(z.string()),
  }),
  z.object({ action: z.literal('status'), runId: text }),
  z.object({ action: z.literal('stop'), runId: text }),
  z.object({ action: z.literal('resume'), runId: text }),
]);
/** Local journal uses atomic replacement; a failed save prevents browser dispatch. */
export function createWorkbenchRuntime(directory: string, browsers: BrowserAccess) {
  const file = path.join(directory, 'workbench', 'comment-sync.json');
  const journal = new SyncJournal({
    read: async () => {
      try {
        return await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    write: async (json) => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, json, { mode: 0o600 });
      await rename(temp, file);
    },
  });
  const cliSync = createFeishuSync(journal);
  const account = (id: string) => {
    const found = browsers.list().find((a) => a.accountId === id);
    if (!found) throw new Error('Account browser is closed. Open it in the account panel.');
    return found;
  };
  return async (input: unknown) => {
    const args = schema.parse(input);
    switch (args.action) {
      case 'feishu-status':
        return feishuAuth.status(true);
      case 'cli-sync':
        return cliSync(args.runId);
      case 'accounts':
        return browsers.list();
      case 'copy':
        account(args.accountId);
        await browsers.focus?.(args.accountId);
        if (!browsers.copy) throw new Error('Selection copying is unavailable');
        return browsers.copy(args.accountId);
      case 'browser':
        account(args.accountId);
        return browsers.command(args.accountId, args.method, args.params);
      case 'start':
        for (const id of args.accountIds) {
          if (id === 'feishu') throw new Error('Feishu is a destination, not a source account.');
          account(id);
        }
        account('feishu');
        return journal.start(args.runId, args.accountIds, args.tableUrl, args.layout);
      case 'collect':
        account(args.accountId);
        return journal.collect(args.runId, args.accountId, args.comments);
      case 'existing':
        return journal.existing(args.runId, args.tableUrl, args.present);
      case 'paste': {
        const run = await journal.status(args.runId);
        if (normalizeTableUrl(account('feishu').url) !== run.tableUrl)
          throw new Error('The Feishu browser is not on this run’s destination table.');
        await browsers.focus?.('feishu');
        const batch = await journal.prepare(args.runId);
        if (!batch.rows.length) return { ...batch, state: 'complete' };
        // Stop may race with the durable prepare. Recheck before the one external side effect.
        const latest = await journal.status(args.runId);
        if (latest.stopped) throw new Error('Run stopped before paste; reconcile this pending batch before retry.');
        if (normalizeTableUrl(account('feishu').url) !== run.tableUrl)
          throw new Error('Destination changed before paste. Reconcile the pending batch.');
        browsers.paste('feishu', batch.tsv);
        return {
          ...batch,
          state: 'awaiting-verification',
          instruction:
            'Paste was dispatched, not confirmed. Read the destination rows and reconcile every key before continuing. Never blindly repeat paste.',
        };
      }
      case 'reconcile':
        return journal.reconcile(args.runId, args.batchId, args.present, args.absent);
      case 'status':
        return journal.status(args.runId);
      case 'stop':
        return journal.stop(args.runId);
      case 'resume':
        return journal.resume(args.runId);
    }
  };
}
