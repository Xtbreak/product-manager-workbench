import { z } from 'zod';
import type { DmMessage, DmSyncAction, DmSyncResult, DmThread } from '@/common/types/platform/workbenchDm';
import type { ReplyTable } from '@/common/types/platform/workbenchReply';
import type { ReplyBrowserAccess, ReplyBrowserLease } from '../replies/contracts';
import type { ReplyDocument } from '../replies/store';
import { dmLinkToken } from '../replies/commentLinks';
import { applyHistory, linkSummary, projectContacts } from './contacts';
import type { DmStore, DmDocument, DmEntry } from './store';

type Config = NonNullable<DmDocument['feishu']>;
type History = { messages: DmMessage[]; complete: boolean; reason?: string };
type Options = {
  store: DmStore;
  readReplies: () => ReplyDocument;
  browsers: ReplyBrowserAccess;
  now?: () => number;
  readHistory: (
    lease: ReplyBrowserLease,
    thread: DmThread,
    signal: AbortSignal,
    mode: 'contact' | 'all'
  ) => Promise<History>;
  configureLinks: (table: ReplyTable, previous?: Config, signal?: AbortSignal) => Promise<Config>;
  syncLinks: (
    config: Config,
    replies: ReplyDocument,
    threads: ReturnType<typeof linkSummary>[],
    signal?: AbortSignal
  ) => Promise<number>;
};
const requestSchema = z.union([
  z.object({ action: z.enum(['status', 'list', 'sync-all', 'cancel', 'configure-feishu']) }).strict(),
  z.object({ action: z.enum(['thread', 'sync-contact']), key: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal('resolve-dm-link'), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const known = new Set([
  'dmBusy',
  'dmLoginRequired',
  'dmAccountMismatch',
  'dmIdentityMismatch',
  'dmStoreInvalid',
  'dmLinkInvalid',
  'dmBrowserClosed',
  'dmFeishuFailed',
  'dmCancelled',
  'dmUnread',
  'dmPartialHistory',
  'dmRestoreFailed',
  'dmUnavailable',
  'dmUnreadSkipped',
  'dmContactNotFound',
  'dmHistoryPartial',
  'dmBrowserUnavailable',
  'dmChallengeRequired',
  'dmExistingDraft',
  'dmPageUnverified',
]);
export function dmErrorCode(e: unknown): string {
  const code = e instanceof Error ? e.message : '';
  if (code === 'replyBrowserBusy') return 'dmBusy';
  if (code === 'replyBrowserClosed') return 'dmBrowserClosed';
  return known.has(code) ? code : 'dmUnavailable';
}
export function createDmService(deps: Options) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  let owner: AbortController | undefined,
    busyAccountId: string | undefined,
    error: string | undefined,
    closing = false;
  // All cloud publications serialize, including explicit comment collection finishing during a DM sync.
  let cloud = Promise.resolve();
  const updateLinks = async (signal?: AbortSignal, onlyKey?: string) => {
    if (!store.read().feishu || closing) return;
    const job = cloud.then(async () => {
      const doc = store.read();
      const config = doc.feishu;
      if (!config || closing || signal?.aborted) return;
      const replies = deps.readReplies();
      if (config.tableId !== replies.table?.tableId || config.baseToken !== replies.table?.baseToken)
        throw new Error('dmFeishuFailed');
      const { entries } = projectContacts(doc, replies);
      const selected = onlyKey ? [entries.get(onlyKey)].filter((e): e is DmEntry => !!e) : [...entries.values()];
      await deps.syncLinks(config, replies, selected.map(linkSummary), signal);
    });
    cloud = job.catch(() => {});
    try {
      await job;
    } catch {
      error = signal?.aborted ? 'dmCancelled' : 'dmFeishuFailed';
      throw new Error(error);
    }
  };
  const view = (key?: string, token?: string): DmSyncResult => {
    const doc = store.read();
    const { entries, comments } = projectContacts(doc, deps.readReplies());
    const threads = [...entries.values()]
      .map((e) => e.thread)
      .sort(
        (a, b) =>
          (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) ||
          a.contactName.localeCompare(b.contactName) ||
          a.key.localeCompare(b.key)
      );
    const status = {
      busy: !!owner,
      busyAccountId,
      partial: threads.some((t) => t.syncState === 'partial'),
      error: error ?? threads.find((t) => t.syncState === 'error')?.lastError,
      feishuConfigured: !!doc.feishu,
      lastSyncedAt: doc.lastSyncedAt,
    };
    const resolved = token ? threads.find((t) => dmLinkToken(t) === token)?.key : key;
    const entry = resolved ? entries.get(resolved) : undefined;
    if ((key || token) && !entry) throw new Error('dmLinkInvalid');
    return {
      status,
      threads,
      ...(token ? { resolvedKey: resolved } : {}),
      ...(entry
        ? {
            detail: {
              ...entry,
              comments: entry.thread.commentKeys.filter((k) => comments.has(k)).map((k) => comments.get(k)!),
            },
          }
        : {}),
    };
  };
  const save = (doc: DmDocument, entry: DmEntry) => {
    const i = doc.entries.findIndex((e) => e.thread.key === entry.thread.key);
    if (i < 0) doc.entries.push(entry);
    else doc.entries[i] = entry;
  };
  const syncOne = async (entry: DmEntry, mode: 'contact' | 'all', signal: AbortSignal) => {
    let lease: ReplyBrowserLease | undefined;
    busyAccountId = entry.thread.accountId;
    try {
      if (!entry.thread.commentKeys.length) throw new Error('dmIdentityMismatch');
      lease = await deps.browsers.acquire(entry.thread.accountId, 'dm-sync');
      if (signal.aborted) throw new Error('dmCancelled');
      const result = await deps.readHistory(lease, entry.thread, signal, mode);
      if (signal.aborted) throw new Error('dmCancelled');
      store.update((doc) =>
        save(doc, applyHistory(entry, result.messages, result.complete, result.reason, doc.enabledAt, now()))
      );
    } catch (e) {
      const failure = dmErrorCode(e);
      const code = signal.aborted && failure !== 'dmRestoreFailed' ? 'dmCancelled' : failure;
      if (code !== 'dmCancelled' && code !== 'dmStoreInvalid')
        store.update((doc) =>
          save(doc, { ...entry, thread: { ...entry.thread, syncState: 'error', lastError: code } })
        );
      throw new Error(code);
    } finally {
      lease?.release();
      busyAccountId = undefined;
    }
  };
  const action = async (raw: DmSyncAction): Promise<DmSyncResult> => {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) throw new Error('dmLinkInvalid');
    const req = parsed.data;
    switch (req.action) {
      case 'status':
      case 'list':
        return view();
      case 'thread':
        return view(req.key);
      case 'resolve-dm-link':
        return view(undefined, req.token);
      case 'cancel':
        owner?.abort();
        return view();
    }
    if (owner || closing) throw new Error('dmBusy');
    const ctl = new AbortController();
    owner = ctl;
    error = undefined;
    try {
      const doc = store.read(),
        replies = deps.readReplies();
      if (req.action === 'configure-feishu') {
        if (!replies.table) throw new Error('dmFeishuFailed');
        try {
          const config = await deps.configureLinks(replies.table, doc.feishu, ctl.signal);
          if (ctl.signal.aborted) throw new Error('dmCancelled');
          store.update((d) => {
            d.feishu = config;
          });
        } catch {
          throw new Error(ctl.signal.aborted ? 'dmCancelled' : 'dmFeishuFailed');
        }
      } else {
        const { entries } = projectContacts(doc, replies);
        let collected = entries.size === 0;
        if (req.action === 'sync-contact') {
          const entry = entries.get(req.key);
          if (!entry) throw new Error('dmLinkInvalid');
          await syncOne(entry, 'contact', ctl.signal);
          collected = true;
        } else {
          for (const entry of entries.values()) {
            if (ctl.signal.aborted) throw new Error('dmCancelled');
            try {
              await syncOne(entry, 'all', ctl.signal);
              collected = true;
            } catch (e) {
              const code = dmErrorCode(e);
              if (
                [
                  'dmCancelled',
                  'dmStoreInvalid',
                  'dmRestoreFailed',
                  'dmAccountMismatch',
                  'dmLoginRequired',
                  'dmIdentityMismatch',
                ].includes(code)
              )
                throw e;
              error = code;
            }
          }
        }
        if (ctl.signal.aborted) throw new Error('dmCancelled');
        if (collected)
          store.update((d) => {
            d.lastSyncedAt = now();
          });
      }
      if (ctl.signal.aborted) throw new Error('dmCancelled');
      await updateLinks(ctl.signal, req.action === 'sync-contact' ? req.key : undefined);
      if (ctl.signal.aborted) throw new Error('dmCancelled');
    } catch (e) {
      error = dmErrorCode(e);
      throw new Error(error);
    } finally {
      owner = undefined;
      busyAccountId = undefined;
    }
    return view(req.action === 'sync-contact' ? req.key : undefined);
  };
  return {
    action,
    updateLinks,
    close: () => {
      closing = true;
      owner?.abort();
    },
  };
}
