/* eslint-disable no-await-in-loop -- Approval checkpoints and browser operations must remain ordered. */
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type {
  ReplyComment,
  ReplySource,
  ReplySyncAction,
  ReplySyncStatus,
  ReplySyncTiming,
  ReplyTableRow,
  ReplyWork,
} from '@/common/types/platform/workbenchReply';
import type {
  ReplyAttempt,
  ReplyBrowserAccess,
  ReplyBrowserLease,
  ReplyPlatformAdapter,
  ReplyTableAdapter,
} from './contracts';
import { ReplyStore, type ReplyDocument } from './store';
import { isRetryableReplyResult, replySourceValues, sameReplySource, validateTable } from './feishuSchema';
import { observedReplies } from './observedReplies';
import { commentLinkToken, commentLinkUrl } from './commentLinks';

const fingerprint = (recordId: string, text: string) =>
  createHash('sha256')
    .update(JSON.stringify([recordId, text]))
    .digest('hex');
const failureCode = (cause: unknown): string => {
  const code = cause instanceof Error ? cause.message : '';
  if (/^reply[A-Z][a-zA-Z]+$/.test(code)) return code;
  if (code === 'REPLY_SNAPSHOT_AMBIGUOUS') return 'replyThreadIncomplete';
  if (code.startsWith('REPLY_CHALLENGE')) return 'replyVerificationRequired';
  if (/^REPLY_.*(?:IDENTITY|OWNER|ACCOUNT)/.test(code)) return 'replyAccountMismatch';
  if (code === 'REPLY_EXISTING_DRAFT') return 'replyDraftPresent';
  if (/^REPLY_(?:TARGET|SELECTED|REPLY_CONTROL|EDITOR|SEND_CONTROL)/.test(code)) return 'replyTargetUnavailable';
  return 'replyBrowserUnavailable';
};
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('setup'), sourceUrl: z.string().url().max(4096) }),
  z.object({ action: z.literal('bind'), accountId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }),
  z.object({ action: z.literal('enabled'), enabled: z.boolean() }),
  z.object({ action: z.literal('configure') }),
  z.object({ action: z.literal('dispatch-mode'), mode: z.enum(['automatic', 'manual']) }),
  z.object({ action: z.literal('send-pending') }),
  z.object({ action: z.literal('resolve-comment'), token: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ action: z.literal('open-comment'), token: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('collect') }),
  z.object({ action: z.literal('sync') }),
  z.object({ action: z.literal('reconcile') }),
]);
const matches = (actual: ReplyTableRow | null, expected: ReplyTableRow, ready: boolean) =>
  actual !== null &&
  actual.recordId === expected.recordId &&
  actual.messageKey === expected.messageKey &&
  actual.draft === expected.draft &&
  actual.approvedDraft === expected.approvedDraft &&
  actual.ready === ready;
const exactDraft = (actual: ReplyTableRow | null, expected: ReplyTableRow): boolean =>
  actual !== null &&
  matches(actual, expected, expected.ready) &&
  sameReplySource(actual.source, expected.source) &&
  actual.status === expected.status &&
  actual.result === expected.result;
const draftMismatchCode = (actual: ReplyTableRow | null, expected: ReplyTableRow): string =>
  !actual ||
  actual.recordId !== expected.recordId ||
  actual.messageKey !== expected.messageKey ||
  !sameReplySource(actual.source, expected.source)
    ? 'replySourceIdentityChanged'
    : 'replyDraftChanged';
const completedStatuses = new Set(['sent', 'replied', 'own', '已发送', '已回复', '本人评论']);
const preserveResult = (row: ReplyTableRow): boolean =>
  completedStatuses.has(row.status) || !isRetryableReplyResult(row.result);
const canonicalComment = (comment: ReplyComment): string =>
  JSON.stringify([comment.platform, comment.actorId, comment.workId, comment.commentId]);
const duplicateComment = (state: ReplyDocument, target: ReplyComment): boolean =>
  state.comments.some(
    (comment) => comment.key !== target.key && canonicalComment(comment) === canonicalComment(target)
  );
const validFrozenSource = (source: ReplySource, work: ReplyWork, comment: ReplyComment): boolean => {
  const current = replySourceValues(work, comment, source.parent);
  return (
    sameReplySource(source, source) &&
    (['author', 'time', 'comment', 'platform', 'conversation', 'key'] as const).every(
      (field) => source[field] === current[field]
    )
  );
};
const toolbarCandidate = (row: ReplyTableRow, state: ReplyDocument): boolean => {
  if (!row.draft.trim() || preserveResult(row) || ['sending', '发送中'].includes(row.status)) return false;
  if (['attention', '需核对', '待核对'].includes(row.status) && !row.result.trim()) return false;
  const target = state.comments.find((item) => item.key === row.messageKey && state.records[item.key] === row.recordId);
  const work = target && state.works.find((item) => item.key === target.workKey);
  return Boolean(
    target &&
    work &&
    target.authorId !== work.actorId &&
    target.accountId === work.accountId &&
    target.actorId === work.actorId &&
    target.platform === work.platform &&
    target.workId === work.workId &&
    !duplicateComment(state, target) &&
    sameReplySource(row.source, state.sourceSnapshots[target.key]) &&
    !state.approvalBlocks.includes(row.recordId) &&
    !state.approvals.some((item) => item.recordId === row.recordId) &&
    !state.observedReplies.some((item) => item.recordId === row.recordId) &&
    !state.attempts.some(
      (attempt) =>
        attempt.recordId === row.recordId ||
        (attempt.phase !== 'sent' &&
          state.works.find((item) => item.key === attempt.workKey)?.accountId === work.accountId)
    )
  );
};
const resultMatches = (reply: ReplyComment, target: ReplyComment, work: ReplyWork, attempt: ReplyAttempt) =>
  reply.workKey === work.key &&
  reply.workId === work.workId &&
  reply.platform === work.platform &&
  reply.accountId === work.accountId &&
  reply.actorId === work.actorId &&
  reply.authorId === work.actorId &&
  reply.parentCommentId === target.commentId &&
  reply.rootCommentId === target.rootCommentId &&
  reply.content === attempt.text &&
  !attempt.beforeIds.includes(reply.commentId) &&
  reply.commentId !== target.commentId;
const validObservedReply = (reply: ReplyComment, target: ReplyComment, work: ReplyWork) =>
  reply.workKey === work.key &&
  reply.workId === work.workId &&
  reply.platform === work.platform &&
  reply.accountId === work.accountId &&
  reply.actorId === work.actorId &&
  reply.authorId === work.actorId &&
  reply.parentCommentId === target.commentId &&
  reply.rootCommentId === target.rootCommentId &&
  Boolean(reply.commentId) &&
  reply.commentId !== target.commentId &&
  reply.key === `${work.key}:${reply.commentId}` &&
  typeof reply.author === 'string' &&
  typeof reply.content === 'string' &&
  Number.isFinite(reply.createdAt);

/** Serialize collection, approval consumption and delivery, with durable no-retry dispatch intents. */
export function createReplyService(options: {
  directory: string;
  browsers: ReplyBrowserAccess;
  table: ReplyTableAdapter;
  platform: ReplyPlatformAdapter;
  pollMs?: number;
}) {
  const store = new ReplyStore(options.directory);
  let busy = false;
  let busyAccountId: string | undefined;
  let activeButtonRow: ReplyTableRow | undefined;
  let error: string | undefined;
  let partial = false;
  let closed = false;
  let controller: AbortController | undefined;
  let lastTiming: ReplySyncTiming | undefined;
  let activeSteps: Map<string, { name: string; calls: number; durationMs: number }> | undefined;
  const measure = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const steps = activeSteps;
    const started = performance.now();
    try {
      return await operation();
    } finally {
      if (steps) {
        const step = steps.get(name) ?? { name, calls: 0, durationMs: 0 };
        step.calls++;
        step.durationMs += performance.now() - started;
        steps.set(name, step);
      }
    }
  };
  // Fixed operation labels keep the profile bounded and exclude IDs, URLs and payloads.
  const tables: ReplyTableAdapter = {
    writeObservedReply: options.table.writeObservedReply
      ? (...args) => measure('feishu.writeObservedReply', () => options.table.writeObservedReply!(...args))
      : undefined,
    markOwnComment: options.table.markOwnComment
      ? (...args) => measure('feishu.markOwnComment', () => options.table.markOwnComment!(...args))
      : undefined,
    writeCommentLink: options.table.writeCommentLink
      ? (...args) => measure('feishu.writeCommentLink', () => options.table.writeCommentLink!(...args))
      : undefined,
    ...(options.table.configurePresentation
      ? {
          configurePresentation: (...args: Parameters<NonNullable<ReplyTableAdapter['configurePresentation']>>) =>
            measure('feishu.configurePresentation', () => options.table.configurePresentation!(...args)),
        }
      : {}),
    provision: (...args) => measure('feishu.provision', () => options.table.provision(...args)),
    inspect: (...args) => measure('feishu.inspect', () => options.table.inspect(...args)),
    list: (...args) => measure('feishu.list', () => options.table.list(...args)),
    get: (...args) => measure('feishu.get', () => options.table.get(...args)),
    create: (...args) => measure('feishu.create', () => options.table.create(...args)),
    recover: (...args) => measure('feishu.recover', () => options.table.recover(...args)),
    claimDraft: options.table.claimDraft
      ? (...args) => measure('feishu.claimDraft', () => options.table.claimDraft!(...args))
      : undefined,
    consumeApproval: (...args) => measure('feishu.consumeApproval', () => options.table.consumeApproval(...args)),
    writeResult: (...args) => measure('feishu.writeResult', () => options.table.writeResult(...args)),
  };
  const platforms: ReplyPlatformAdapter = {
    locate: options.platform.locate
      ? (...args) => measure('platform.locate', () => options.platform.locate!(...args))
      : undefined,
    inspectCurrent: (...args) => measure('platform.inspectCurrent', () => options.platform.inspectCurrent(...args)),
    collect: (...args) => measure(`platform.${args[1].platform}.collect`, () => options.platform.collect(...args)),
    prepare: (...args) => measure(`platform.${args[1].platform}.prepare`, () => options.platform.prepare(...args)),
    submit: (...args) => measure(`platform.${args[1].platform}.submit`, () => options.platform.submit(...args)),
    reconcile: (...args) =>
      measure(`platform.${args[1].platform}.reconcile`, () => options.platform.reconcile(...args)),
    discardPrepared: (...args) => measure('platform.discardPrepared', () => options.platform.discardPrepared(...args)),
  };

  const status = async (): Promise<ReplySyncStatus> => {
    const doc = store.read();
    return {
      enabled: false,
      busy,
      canCancelSend: Boolean(activeButtonRow),
      busyAccountId,
      tableUrl: doc.table?.url,
      sendButtonConfigured: Boolean(doc.table?.presentation),
      buttonDispatchMode: 'manual',
      sendMode: doc.table?.presentation?.sendMode,
      works: doc.works,
      archived: Object.keys(doc.records).length,
      sent: doc.attempts.filter((a) => a.phase === 'sent').length,
      uncertain:
        doc.attempts.filter((a) => a.phase !== 'sent').length +
        doc.pendingCreates.length +
        doc.approvals.length +
        doc.observedReplies.filter((item) => !item.written).length,
      lastRunAt: doc.lastRunAt,
      error: error ?? (doc.presentationConfiguring ? 'replyPresentationUnverified' : undefined),
      collectionPartial: partial,
      timing: lastTiming ? structuredClone(lastTiming) : undefined,
    };
  };
  const check = () => {
    if (closed || controller?.signal.aborted) throw new Error('replyPaused');
  };
  const withBrowser = async <T>(accountId: string, run: (lease: ReplyBrowserLease) => Promise<T>) => {
    check();
    const lease = await options.browsers.acquire(accountId);
    busyAccountId = accountId;
    try {
      check();
      return await run(lease);
    } finally {
      lease.release();
      busyAccountId = undefined;
    }
  };
  const remember = (work: ReplyWork, comments: ReplyComment[], update?: (doc: ReplyDocument) => void) => {
    if (
      comments.some(
        (item) =>
          item.workKey !== work.key ||
          item.accountId !== work.accountId ||
          item.platform !== work.platform ||
          item.workId !== work.workId ||
          item.actorId !== work.actorId ||
          !item.commentId ||
          !item.rootCommentId
      )
    )
      throw new Error('replyTargetMismatch');
    if (new Set(comments.map((item) => item.key)).size !== comments.length) throw new Error('replyTargetMismatch');
    store.update((doc) => {
      for (const item of comments) {
        const previous = doc.comments.find((candidate) => candidate.key === item.key);
        if (previous) {
          if (
            previous.commentId !== item.commentId ||
            previous.workKey !== item.workKey ||
            previous.authorId !== item.authorId ||
            previous.parentCommentId !== item.parentCommentId ||
            previous.rootCommentId !== item.rootCommentId
          )
            throw new Error('replyTargetMismatch');
          if (item.authorId === work.actorId) {
            previous.content = item.content;
            previous.author = item.author;
            previous.createdAt = item.createdAt;
          }
        } else doc.comments.push(item);
      }
      update?.(doc);
    });
  };
  const trustedRow = (row: ReplyTableRow, expectedKey?: string): ReplyTableRow => {
    const doc = store.read();
    const targets = doc.comments.filter((item) => doc.records[item.key] === row.recordId);
    if (targets.length !== 1 || (expectedKey && targets[0].key !== expectedKey))
      throw new Error('replySourceIdentityChanged');
    const target = targets[0];
    if (duplicateComment(doc, target)) throw new Error('replyDuplicateComment');
    const work = doc.works.find((item) => item.key === target.workKey);
    if (!work || row.messageKey !== target.key) throw new Error('replySourceIdentityChanged');
    const saved = doc.sourceSnapshots[target.key];
    let source: ReplySource;
    if (saved) {
      if (!validFrozenSource(saved, work, target) || !sameReplySource(row.source, saved))
        throw new Error('replySourceIdentityChanged');
      source = saved;
    } else {
      const parent = doc.comments.find(
        (item) => item.workKey === target.workKey && item.commentId === target.parentCommentId
      );
      source = replySourceValues(work, target, parent?.content ?? '');
      if (!sameReplySource(row.source, source)) throw new Error('replySourceIdentityChanged');
      // Upgrade an existing mapping only from independently reconstructed local evidence.
      store.update((next) => {
        next.sourceSnapshots[target.key] = source;
      });
    }
    return { ...row, source: structuredClone(source) };
  };
  const freezeLegacyForWork = async (workKey: string) => {
    const doc = store.read();
    const pending = doc.comments.filter(
      (comment) => comment.workKey === workKey && doc.records[comment.key] && !doc.sourceSnapshots[comment.key]
    );
    if (!pending.length) return;
    if (!doc.table) throw new Error('replySetupRequired');
    const rows = await tables.list(doc.table);
    check();
    for (const comment of pending) {
      const candidates = rows.filter((row) => row.recordId === doc.records[comment.key]);
      if (candidates.length !== 1) throw new Error('replySourceIdentityChanged');
      trustedRow(candidates[0], comment.key);
    }
  };
  const writeVerifiedResult = async (
    table: NonNullable<ReplyDocument['table']>,
    recordId: string,
    state: 'waiting' | 'sending' | 'sent' | 'attention' | 'replied' | 'own',
    result: string
  ) => {
    const row = await tables.get(table, recordId);
    if (!row) throw new Error('replySourceIdentityChanged');
    const verified = trustedRow(row);
    await tables.writeResult(table, recordId, state, result, verified.source);
  };
  const reportWriteError = (cause: unknown) => {
    const code = failureCode(cause);
    if (code === 'replySourceIdentityChanged' || code === 'replyDuplicateComment') error = code;
    else if (error !== 'replySourceIdentityChanged' && error !== 'replyDuplicateComment') error = 'replyResultPending';
  };
  const archive = async () => {
    const doc = store.read();
    if (!doc.table) return;
    if (
      !doc.pendingCreates.length &&
      doc.comments.every((comment) => comment.authorId === comment.actorId || doc.records[comment.key])
    )
      return;
    const rows = await tables.list(doc.table);
    check();
    for (const key of doc.pendingCreates) {
      const comment = doc.comments.find((item) => item.key === key)!;
      const work = doc.works.find((item) => item.key === comment.workKey)!;
      try {
        if (duplicateComment(store.read(), comment)) throw new Error('replyDuplicateComment');
        const source = store.read().sourceSnapshots[key];
        if (!source || !validFrozenSource(source, work, comment)) throw new Error('replySourceIdentityChanged');
        const recordId = await tables.recover(doc.table, work, comment, source.parent, source);
        check();
        if (recordId)
          store.update((next) => {
            next.records[key] = recordId;
            next.pendingCreates = next.pendingCreates.filter((item) => item !== key);
          });
        else error = 'replyArchiveUncertain';
      } catch (cause) {
        const code = failureCode(cause);
        error = ['replySourceIdentityChanged', 'replyDuplicateComment'].includes(code) ? code : 'replyArchiveUncertain';
      }
    }
    for (const comment of store.read().comments) {
      check();
      const current = store.read();
      if (
        comment.authorId === comment.actorId ||
        current.records[comment.key] ||
        current.pendingCreates.includes(comment.key)
      )
        continue;
      if (duplicateComment(current, comment)) {
        error = 'replyDuplicateComment';
        continue;
      }
      // Existing foreign rows are never promoted into trusted routing records.
      if (rows.some((row) => row.messageKey === comment.key)) {
        error = 'replyTargetMismatch';
        continue;
      }
      const work = current.works.find((item) => item.key === comment.workKey)!;
      const parent = current.comments.find(
        (item) => item.workKey === work.key && item.commentId === comment.parentCommentId
      );
      const source = replySourceValues(work, comment, parent?.content ?? '');
      store.update((next) => {
        next.sourceSnapshots[comment.key] = source;
        next.pendingCreates.push(comment.key);
      });
      try {
        const recordId = await tables.create(doc.table, work, comment, source.parent, source);
        store.update((next) => {
          next.records[comment.key] = recordId;
          next.pendingCreates = next.pendingCreates.filter((key) => key !== comment.key);
        });
      } catch {
        error = 'replyArchiveUncertain';
      }
    }
  };
  const syncReplyPresentation = async () => {
    const initial = store.read();
    const table = initial.table;
    if (!table || initial.presentationConfiguring) return;
    const observed = observedReplies(initial);
    if (JSON.stringify(observed) !== JSON.stringify(initial.observedReplies))
      store.update((doc) => {
        doc.observedReplies = observed;
      });
    const state = store.read();
    const own = state.comments.filter(
      (comment) =>
        state.records[comment.key] &&
        comment.authorId === comment.actorId &&
        !state.selfCommentRecords.includes(state.records[comment.key]) &&
        !state.observedReplies.some((item) => item.commentKey === comment.key) &&
        !state.attempts.some((attempt) => attempt.commentKey === comment.key)
    );
    const links = table.presentation?.commentLinkFieldId
      ? state.comments.filter((comment) => {
          const work = state.works.find((item) => item.key === comment.workKey);
          return (
            work && state.records[comment.key] && state.linkedRecords[comment.key] !== commentLinkUrl(work, comment)
          );
        })
      : [];
    if (!observed.length && !own.length && !links.length) return;
    const rows = await tables.list(table);
    check();
    const rowFor = (key: string, recordId: string) => {
      const candidates = rows.filter((row) => row.recordId === recordId);
      if (candidates.length !== 1) throw new Error('replySourceIdentityChanged');
      return trustedRow(candidates[0], key);
    };
    for (const observation of observed) {
      check();
      try {
        const row = rowFor(observation.commentKey, observation.recordId);
        const statusMatches =
          observation.state === 'attention'
            ? ['attention', '需核对'].includes(row.status)
            : ['replied', '已回复'].includes(row.status);
        if (observation.written && row.draft === observation.text && !row.ready && !row.approvedDraft && statusMatches)
          continue;
        if (!tables.writeObservedReply) throw new Error('replyConfigurationUnavailable');
        store.update((doc) => {
          doc.observedReplies.find((item) => item.recordId === observation.recordId)!.written = false;
        });
        await tables.writeObservedReply(table, row, observation.text, observation.result, observation.state);
        store.update((doc) => {
          const saved = doc.observedReplies.find((item) => item.recordId === observation.recordId)!;
          saved.written = true;
          doc.approvals = doc.approvals.filter((item) => item.recordId !== observation.recordId);
          doc.approvalBlocks = doc.approvalBlocks.filter((id) => id !== observation.recordId);
        });
      } catch (cause) {
        reportWriteError(cause);
      }
    }
    for (const comment of own) {
      check();
      try {
        if (!tables.markOwnComment) throw new Error('replyConfigurationUnavailable');
        const recordId = state.records[comment.key];
        await tables.markOwnComment(table, rowFor(comment.key, recordId));
        store.update((doc) => {
          if (!doc.selfCommentRecords.includes(recordId)) doc.selfCommentRecords.push(recordId);
        });
      } catch (cause) {
        reportWriteError(cause);
      }
    }
    for (const comment of links) {
      check();
      try {
        if (!tables.writeCommentLink) throw new Error('replyConfigurationUnavailable');
        const work = state.works.find((item) => item.key === comment.workKey)!;
        await tables.writeCommentLink(table, rowFor(comment.key, state.records[comment.key]), work, comment);
        store.update((doc) => {
          doc.linkedRecords[comment.key] = commentLinkUrl(work, comment);
        });
      } catch (cause) {
        reportWriteError(cause);
      }
    }
  };
  const writeSuccess = async (attempt: ReplyAttempt) => {
    const table = store.read().table!;
    try {
      await writeVerifiedResult(table, attempt.recordId, 'sent', attempt.result!.commentId);
      store.update((doc) => {
        doc.attempts.find((a) => a.id === attempt.id)!.resultWritten = true;
      });
    } catch (cause) {
      reportWriteError(cause);
    }
  };
  const recoverApproval = async (approval: { id: string; recordId: string }) => {
    try {
      const table = store.read().table!;
      let preserve = false;
      if (table.presentation) {
        const currentRow = await tables.get(table, approval.recordId);
        const current = currentRow ? trustedRow(currentRow) : null;
        if (
          table.presentation.sendMode === 'toolbar' &&
          (!current ||
            current.recordId !== approval.recordId ||
            !store
              .read()
              .comments.some(
                (item) => item.key === current.messageKey && store.read().records[item.key] === current.recordId
              ))
        )
          throw new Error('replyTargetMismatch');
        if (table.presentation.sendMode === 'toolbar' && current && preserveResult(current)) {
          // Old ready flags are no longer authority and must not replace a newer completed result.
          store.update((doc) => {
            doc.approvals = doc.approvals.filter((item) => item.id !== approval.id);
          });
          return;
        }
        if (!current || (current.ready && !(await tables.consumeApproval(table, current))))
          throw new Error('replyApprovalInterrupted');
        const clearedRow = await tables.get(table, approval.recordId);
        const cleared = clearedRow ? trustedRow(clearedRow, current?.messageKey) : null;
        if (
          !cleared ||
          cleared.ready ||
          (table.presentation.sendMode === 'toolbar' &&
            (cleared.recordId !== approval.recordId || cleared.messageKey !== current!.messageKey))
        )
          throw new Error('replyApprovalInterrupted');
        preserve = table.presentation.sendMode === 'toolbar' && preserveResult(cleared);
      }
      if (!preserve) await writeVerifiedResult(table, approval.recordId, 'attention', 'replyApprovalInterrupted');
      store.update((doc) => {
        doc.approvals = doc.approvals.filter((item) => item.id !== approval.id);
      });
    } catch (cause) {
      reportWriteError(cause);
    }
  };
  const invalidateApproval = async (row: ReplyTableRow, reason = 'replyApprovalInterrupted', toolbar = false) => {
    const table = store.read().table!;
    store.update((doc) => {
      if (!doc.approvalBlocks.includes(row.recordId)) doc.approvalBlocks.push(row.recordId);
    });
    const currentRow = await tables.get(table, row.recordId);
    const current = currentRow ? trustedRow(currentRow, row.messageKey) : null;
    if (
      toolbar &&
      current?.recordId === row.recordId &&
      current.messageKey === row.messageKey &&
      preserveResult(current)
    ) {
      store.update((doc) => {
        doc.approvalBlocks = doc.approvalBlocks.filter((id) => id !== row.recordId);
      });
      return;
    }
    if (current?.messageKey === row.messageKey && current.ready) await tables.consumeApproval(table, current);
    const afterRow = await tables.get(table, row.recordId);
    const after = afterRow ? trustedRow(afterRow, row.messageKey) : null;
    if (!after || after.messageKey !== row.messageKey || after.ready) throw new Error('replyApprovalInterrupted');
    if (!toolbar || !preserveResult(after)) await writeVerifiedResult(table, row.recordId, 'attention', reason);
    // Clear the durable block only after both remote clearing and result write succeed.
    store.update((doc) => {
      doc.approvalBlocks = doc.approvalBlocks.filter((id) => id !== row.recordId);
    });
  };
  const confirm = async (attempt: ReplyAttempt, reply: ReplyComment, target: ReplyComment, work: ReplyWork) => {
    if (!resultMatches(reply, target, work, attempt)) throw new Error('replyResultMismatch');
    store.update((doc) => {
      const item = doc.attempts.find((a) => a.id === attempt.id)!;
      item.phase = 'sent';
      item.result = reply;
    });
    remember(work, [reply]);
    await writeSuccess({ ...attempt, phase: 'sent', result: reply });
  };
  const reconcile = async () => {
    for (const approval of store.read().approvals) {
      check();
      await recoverApproval(approval);
    }
    for (const attempt of store.read().attempts) {
      check();
      if (attempt.phase === 'sent') {
        if (!attempt.resultWritten) await writeSuccess(attempt);
        continue;
      }
      const doc = store.read();
      const target = doc.comments.find((item) => item.key === attempt.commentKey)!;
      const work = doc.works.find((item) => item.key === attempt.workKey)!;
      try {
        await withBrowser(work.accountId, async (lease) => {
          const reply = await platforms.reconcile(lease, work, target, attempt, controller?.signal);
          if (reply) await confirm(attempt, reply, target, work);
          else error = 'replySendUncertain';
        });
      } catch {
        error = 'replySendUncertain';
      }
    }
  };
  const sendRow = async (row: ReplyTableRow, toolbar = false) => {
    const doc = store.read();
    if (toolbar && !toolbarCandidate(row, doc)) return;
    const table = doc.table!;
    const target = doc.comments.find((item) => doc.records[item.key] === row.recordId);
    if (!target || row.messageKey !== target.key) return;
    const observation = doc.observedReplies.find((item) => item.recordId === row.recordId);
    if (observation) {
      if (!tables.writeObservedReply) throw new Error('replyConfigurationUnavailable');
      store.update((next) => {
        next.observedReplies.find((item) => item.recordId === row.recordId)!.written = false;
      });
      await tables.writeObservedReply(table, row, observation.text, observation.result, observation.state);
      store.update((next) => {
        next.observedReplies.find((item) => item.recordId === row.recordId)!.written = true;
      });
      return;
    }
    const id = fingerprint(row.recordId, row.draft);
    if (doc.approvals.some((item) => item.recordId === row.recordId)) return;
    if (
      table.presentation &&
      doc.attempts.some((attempt) => attempt.recordId === row.recordId && attempt.phase !== 'sent')
    ) {
      // A legacy row may have an older confirmed reply and a later unresolved dispatch.
      const current = await tables.get(table, row.recordId);
      if (matches(current, row, true) && (await tables.consumeApproval(table, row)))
        await writeVerifiedResult(table, row.recordId, 'attention', 'replySendUncertain');
      return;
    }
    const previous = doc.attempts.find(
      (attempt) =>
        attempt.phase === 'sent' &&
        attempt.recordId === row.recordId &&
        (Boolean(table.presentation) || attempt.id === id)
    );
    if (previous) {
      // A repeated click is not authorization for a second send on this completed row.
      const current = await tables.get(table, row.recordId);
      if (matches(current, row, true) && (await tables.consumeApproval(table, row))) await writeSuccess(previous);
      return;
    }
    if (target.authorId === target.actorId) {
      if (!tables.markOwnComment) throw new Error('replyConfigurationUnavailable');
      await tables.markOwnComment(table, row);
      return;
    }

    if (!toolbar && table.presentation && (!row.draft.trim() || row.approvedDraft !== row.draft)) {
      error = row.draft.trim() ? 'replyDraftChanged' : 'replyDraftEmpty';
      await invalidateApproval(row, error);
      return;
    }
    if (!row.draft.trim()) return;
    const work = doc.works.find((item) => item.key === target.workKey)!;

    if (
      doc.attempts.some(
        (attempt) =>
          attempt.id === id ||
          (attempt.phase !== 'sent' &&
            doc.works.find((item) => item.key === attempt.workKey)?.accountId === work.accountId)
      )
    )
      return;
    if (toolbar) {
      if (!tables.claimDraft) {
        error = 'replyConfigurationUnavailable';
        return;
      }
      const current = await tables.get(table, row.recordId);
      if (!exactDraft(current, row)) {
        error = draftMismatchCode(current, row);
        return;
      }
    }
    try {
      await withBrowser(work.accountId, async (lease) => {
        const prepared = await platforms.prepare(lease, work, target, row.draft, controller?.signal);
        if (prepared.existingReplies?.length) {
          if (
            prepared.existingReplies.some((reply) => !validObservedReply(reply, target, work)) ||
            new Set(prepared.existingReplies.map((reply) => reply.commentId)).size !== prepared.existingReplies.length
          )
            throw new Error('replyTargetMismatch');
          await freezeLegacyForWork(work.key);
          remember(work, prepared.existingReplies);
          await syncReplyPresentation();
          return;
        }
        let dispatched = false;
        try {
          check();
          // Freeze any legacy rows before a new owner reply can become their parent.
          await freezeLegacyForWork(work.key);
          check();
          const beforeClaim = await tables.get(table, row.recordId);
          if (!(toolbar ? exactDraft(beforeClaim, row) : matches(beforeClaim, row, true))) {
            error = toolbar ? draftMismatchCode(beforeClaim, row) : 'replyDraftChanged';
            if (!toolbar) await invalidateApproval(row);
            return;
          }
          check();
          store.update((next) => {
            next.approvals.push({ id, recordId: row.recordId });
          });
          const claimed = toolbar ? await tables.claimDraft!(table, row) : await tables.consumeApproval(table, row);
          if (!claimed) {
            error = toolbar ? draftMismatchCode(await tables.get(table, row.recordId), row) : 'replyDraftChanged';
            if (toolbar)
              store.update((next) => {
                next.approvals = next.approvals.filter((item) => item.id !== id);
              });
            else await invalidateApproval(row);
            return;
          }
          check();
          const afterClaim = await tables.get(table, row.recordId);
          if (
            !(toolbar
              ? exactDraft(afterClaim, { ...row, ready: false, approvedDraft: row.draft, status: '发送中' })
              : matches(afterClaim, row, false))
          ) {
            error = toolbar ? draftMismatchCode(afterClaim, row) : 'replyDraftChanged';
            if (!toolbar) await invalidateApproval(row);
            return;
          }
          check();
          const attempt: ReplyAttempt = {
            id,
            recordId: row.recordId,
            commentKey: target.key,
            workKey: work.key,
            text: row.draft,
            ...prepared,
            phase: 'dispatching',
          };
          store.update((next) => {
            next.attempts.push(attempt);
            next.approvals = next.approvals.filter((item) => item.id !== id);
          });
          dispatched = true;
          try {
            const result = await platforms.submit(lease, work, target, row.draft, prepared, controller?.signal);
            if ('kind' in result) {
              if (
                result.kind !== 'not-sent-existing-replies' ||
                !Array.isArray(result.replies) ||
                !result.replies.length ||
                result.replies.some((reply) => !validObservedReply(reply, target, work)) ||
                new Set(result.replies.map((reply) => reply.commentId)).size !== result.replies.length
              )
                throw new Error('replyResultMismatch');
              // Persist observed evidence while the dispatch intent still blocks any retry.
              remember(work, result.replies, (next) => {
                next.attempts = next.attempts.filter((item) => item.id !== id);
              });
              await syncReplyPresentation();
            } else await confirm(attempt, result, target, work);
          } catch {
            // Even a rejected click can have reached the site. Only observation may resolve it.
            const pending = store.read().attempts.find((item) => item.id === id);
            if (pending && pending.phase !== 'sent') {
              store.update((next) => {
                next.attempts.find((item) => item.id === id)!.phase = 'uncertain';
              });
              error = 'replySendUncertain';
              try {
                await writeVerifiedResult(table, row.recordId, 'attention', 'replySendUncertain');
              } catch {
                /* Durable intent remains the authority. */
              }
            } else if (!pending) error = 'replyResultPending';
          }
        } finally {
          if (!dispatched) {
            try {
              await platforms.discardPrepared(lease, work, target, row.draft);
            } catch {
              /* Leave any changed user draft intact. */
            }
            const approval = store.read().approvals.find((item) => item.id === id);
            if (approval) await recoverApproval(approval);
          }
        }
      });
    } catch (cause) {
      if (!toolbar && table.presentation && !store.read().attempts.some((attempt) => attempt.id === id)) {
        const reason = controller?.signal.aborted ? 'replyPaused' : failureCode(cause);
        try {
          await invalidateApproval(row, reason);
        } catch {
          error = 'replyResultPending';
        }
      }
      throw cause;
    }
  };
  const run = async (collect: boolean, send: boolean) => {
    const doc = store.read();
    if (!doc.table) throw new Error('replySetupRequired');
    if (doc.presentationConfiguring) throw new Error('replyPresentationUnverified');
    await tables.inspect(doc.table);
    check();
    const toolbar = send && doc.table.presentation?.sendMode === 'toolbar';
    // Capture before recovery or backfill writes; later drafts never join this authorization.
    const toolbarRows = toolbar ? await tables.list(doc.table) : undefined;
    const startingRecovery = new Set([...doc.approvalBlocks, ...doc.approvals.map((item) => item.recordId)]);
    check();
    await reconcile();
    check();
    const buttonMode = Boolean(doc.table.presentation);
    if (send && buttonMode && !toolbar && doc.buttonDispatchVersion !== 1) {
      const rows = await tables.list(doc.table);
      check();
      const trusted = rows.filter(
        (row) =>
          (row.ready || doc.approvalBlocks.includes(row.recordId)) &&
          doc.comments.some((item) => doc.records[item.key] === row.recordId && row.messageKey === item.key)
      );
      store.update((next) => {
        for (const row of trusted)
          if (!next.approvalBlocks.includes(row.recordId)) next.approvalBlocks.push(row.recordId);
      });
      for (const row of trusted) {
        check();
        const current = await tables.get(doc.table, row.recordId);
        if (!current || current.messageKey !== row.messageKey) throw new Error('replyApprovalInterrupted');
        if (current.ready && !(await tables.consumeApproval(doc.table, current)))
          throw new Error('replyApprovalInterrupted');
        const cleared = await tables.get(doc.table, row.recordId);
        if (!cleared || cleared.ready || cleared.messageKey !== row.messageKey)
          throw new Error('replyApprovalInterrupted');
        const attempts = store.read().attempts.filter((attempt) => attempt.recordId === row.recordId);
        const unresolved = attempts.find((attempt) => attempt.phase !== 'sent');
        const sent = attempts.find((attempt) => attempt.phase === 'sent');
        if (unresolved) await writeVerifiedResult(doc.table, row.recordId, 'attention', 'replySendUncertain');
        else if (sent?.result) await writeVerifiedResult(doc.table, row.recordId, 'sent', sent.result.commentId);
        else if (sent) throw new Error('replyResultPending');
        else await writeVerifiedResult(doc.table, row.recordId, 'attention', 'replyApprovalInterrupted');
      }
      store.update((next) => {
        next.approvalBlocks = next.approvalBlocks.filter((id) => !trusted.some((row) => row.recordId === id));
        next.buttonDispatchVersion = 1;
        next.lastRunAt = Date.now();
      });
      return;
    }
    if (collect && (!buttonMode || !send)) {
      partial = false;
      for (const work of store.read().works) {
        try {
          await withBrowser(work.accountId, async (lease) => {
            const collection = await platforms.collect(lease, work, true, controller?.signal);
            check();
            await freezeLegacyForWork(work.key);
            remember(work, collection.comments);
            partial ||= !collection.complete;
          });
        } catch (cause) {
          error = failureCode(cause);
        }
      }
    }
    check();
    if (!send || !buttonMode) await archive();
    check();
    await syncReplyPresentation();
    check();
    if (send && buttonMode) {
      // Read the complete stable candidate set before any approval or status mutations.
      const captured = toolbarRows ?? (await tables.list(doc.table));
      check();
      const blocked = new Set(store.read().approvalBlocks);
      const rows: ReplyTableRow[] = [];
      for (const row of captured) {
        const state = store.read();
        if (!state.comments.some((item) => state.records[item.key] === row.recordId)) continue;
        if (
          toolbar &&
          !blocked.has(row.recordId) &&
          (!row.draft.trim() || preserveResult(row) || ['sending', '发送中'].includes(row.status))
        )
          continue;
        try {
          rows.push(trustedRow(row));
        } catch (cause) {
          reportWriteError(cause);
        }
      }
      for (const row of rows.filter((item) => blocked.has(item.recordId))) {
        check();
        if (doc.comments.some((item) => doc.records[item.key] === row.recordId && row.messageKey === item.key))
          await invalidateApproval(row, 'replyApprovalInterrupted', toolbar);
      }
      const ready = toolbar
        ? rows.filter((row) => !startingRecovery.has(row.recordId) && toolbarCandidate(row, store.read()))
        : rows.filter((item) => item.ready);
      if (buttonMode) {
        const state = store.read();
        const canDispatch = (row: ReplyTableRow) => {
          const target = state.comments.find(
            (item) => state.records[item.key] === row.recordId && item.key === row.messageKey
          );
          const work = target && state.works.find((item) => item.key === target.workKey);
          return Boolean(
            work &&
            !state.approvals.some((item) => item.recordId === row.recordId) &&
            !state.attempts.some(
              (attempt) =>
                attempt.recordId === row.recordId ||
                (attempt.phase !== 'sent' &&
                  state.works.find((item) => item.key === attempt.workKey)?.accountId === work.accountId)
            )
          );
        };
        ready.sort((a, b) => Number(canDispatch(b)) - Number(canDispatch(a)));
      }
      for (const row of ready) {
        check();
        if (blocked.has(row.recordId)) continue;
        if (
          buttonMode &&
          !store
            .read()
            .comments.some((item) => store.read().records[item.key] === row.recordId && row.messageKey === item.key)
        )
          continue;
        if (buttonMode) activeButtonRow = row;
        try {
          await sendRow(row, toolbar);
        } catch (cause) {
          error = failureCode(cause);
        } finally {
          activeButtonRow = undefined;
        }
      }
      check();
      await archive();
    }
    store.update((next) => {
      next.lastRunAt = Date.now();
    });
  };
  const exclusive = async (
    operation: () => Promise<void>,
    signal?: AbortSignal,
    action: ReplySyncTiming['action'] = 'poll'
  ) => {
    if (busy) throw new Error('replyBusy');
    if (closed || signal?.aborted) throw new Error('replyPaused');
    busy = true;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const steps = new Map<string, { name: string; calls: number; durationMs: number }>();
    activeSteps = steps;
    const owner = new AbortController();
    controller = owner;
    // A caller may cancel only the operation it acquired, never a later caller or a poll.
    const abort = () => owner.abort();
    signal?.addEventListener('abort', abort, { once: true });
    error = undefined;
    try {
      await operation();
      check();
    } catch (cause) {
      if (owner.signal.aborted) {
        error = undefined;
        if (signal?.aborted) throw new Error('replyPaused', { cause });
        return;
      }
      error ??= failureCode(cause);
      throw new Error(error, { cause });
    } finally {
      signal?.removeEventListener('abort', abort);
      lastTiming = {
        action,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        steps: [...steps.values()].map((step) => ({
          name: step.name,
          calls: step.calls,
          durationMs: Math.round(step.durationMs * 1000) / 1000,
        })),
      };
      activeSteps = undefined;
      busy = false;
      controller = undefined;
    }
  };
  const resolveComment = (token: string) => {
    const doc = store.read();
    const candidates = doc.comments.filter(
      (comment) => commentLinkToken(comment) === token && doc.records[comment.key]
    );
    if (candidates.length !== 1) throw new Error('replyCommentLinkInvalid');
    const target = candidates[0];
    const work = doc.works.find((item) => item.key === target.workKey);
    if (
      !work ||
      work.accountId !== target.accountId ||
      work.actorId !== target.actorId ||
      work.workId !== target.workId ||
      work.platform !== target.platform
    )
      throw new Error('replyTargetMismatch');
    return { work, target };
  };
  const action = async (raw: ReplySyncAction, signal?: AbortSignal): Promise<ReplySyncStatus> => {
    const input = actionSchema.parse(raw);
    if (input.action === 'status') return status();
    if (signal?.aborted) throw new Error('replyPaused');
    if (input.action === 'resolve-comment') {
      const { work } = resolveComment(input.token);
      return { ...(await status()), commentTarget: { accountId: work.accountId, token: input.token } };
    }
    if (input.action === 'dispatch-mode') {
      if (input.mode !== 'manual') throw new Error('replyManualModeRequired');
      return status();
    }
    if (input.action === 'send-pending') {
      if (store.read().table?.presentation?.sendMode !== 'toolbar') throw new Error('replySendButtonRequired');
      if (store.read().buttonDispatchMode !== 'manual') throw new Error('replyManualModeRequired');
    }
    if (input.action === 'cancel') {
      const row = activeButtonRow;
      if (row) {
        store.update((doc) => {
          if (
            !doc.attempts.some((attempt) => attempt.recordId === row.recordId) &&
            !doc.approvalBlocks.includes(row.recordId)
          )
            doc.approvalBlocks.push(row.recordId);
        });
        controller?.abort();
      }
      return status();
    }
    if (input.action === 'enabled') {
      if (input.enabled) throw new Error('replyManualModeRequired');
      controller?.abort();
      return status();
    }
    await exclusive(
      async () => {
        if (input.action === 'open-comment') {
          const { work, target } = resolveComment(input.token);
          if (!platforms.locate) throw new Error('replyTargetUnavailable');
          await withBrowser(work.accountId, (lease) => platforms.locate!(lease, work, target, controller?.signal));
        } else if (input.action === 'setup') {
          if (store.read().table) {
            await tables.inspect(store.read().table!);
            return;
          }
          if (!store.read().setup)
            store.update((doc) => {
              doc.setup = { sourceUrl: input.sourceUrl, name: `评论回复-${randomUUID().slice(0, 8)}` };
            });
          const setup = store.read().setup!;
          const table = await tables.provision(setup.sourceUrl, setup.name);
          check();
          store.update((doc) => {
            doc.table = table;
            if (table.presentation) doc.buttonDispatchVersion = 1;
          });
        } else if (input.action === 'configure') {
          const previousState = store.read();
          const current = previousState.table;
          if (!current) throw new Error('replySetupRequired');
          if (!tables.configurePresentation) throw new Error('replyConfigurationUnavailable');
          // Remote configuration can expose a live button before this process receives its mapping.
          store.update((doc) => {
            doc.presentationConfiguring = true;
          });
          const configured = await tables.configurePresentation(current, {
            migration: previousState.statusMigration,
            saveMigration: (snapshot) => {
              check();
              if (
                snapshot.baseToken !== current.baseToken ||
                snapshot.tableId !== current.tableId ||
                snapshot.statusFieldId !== current.fields.status ||
                (current.presentation && snapshot.workflowId !== current.presentation.workflowId)
              )
                throw new Error('replyTargetMismatch');
              const existing = store.read().statusMigration;
              if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot))
                throw new Error('replyPresentationUnverified');
              store.update((doc) => {
                doc.statusMigration = structuredClone(snapshot);
              });
            },
          });
          check();
          if (
            configured.baseToken !== current.baseToken ||
            configured.tableId !== current.tableId ||
            Object.entries(current.fields).some(
              ([key, value]) => configured.fields[key as keyof typeof current.fields] !== value
            )
          )
            throw new Error('replyTargetMismatch');
          validateTable(configured);
          if (!configured.presentation) throw new Error('replyFieldSchemaInvalid');
          store.update((doc) => {
            doc.table = configured;
            if (!current.presentation && !previousState.presentationConfiguring) doc.buttonDispatchVersion = 1;
            doc.presentationConfiguring = false;
            delete doc.statusMigration;
          });
          await syncReplyPresentation();
        } else if (input.action === 'bind') {
          if (!store.read().table) throw new Error('replySetupRequired');
          await withBrowser(input.accountId, async (lease) => {
            const { work, collection } = await platforms.inspectCurrent(lease, controller?.signal);
            check();
            if (work.accountId !== input.accountId || work.accountId === 'feishu')
              throw new Error('replyTargetMismatch');
            const existingWork = store.read().works.find((item) => item.key === work.key);
            if (existingWork) await freezeLegacyForWork(existingWork.key);
            store.update((doc) => {
              if (
                doc.works.some(
                  (item) =>
                    item.platform === work.platform &&
                    item.actorId === work.actorId &&
                    item.workId === work.workId &&
                    item.accountId !== work.accountId
                )
              )
                throw new Error('replyDuplicateWork');
              const previous = doc.works.find((item) => item.key === work.key);
              if (
                previous &&
                (previous.actorId !== work.actorId ||
                  previous.workId !== work.workId ||
                  previous.accountId !== work.accountId)
              )
                throw new Error('replyTargetMismatch');
              if (!previous) doc.works.push(work);
              else {
                // Renew the observed signed URL without changing immutable routing identity.
                previous.url = work.url;
                previous.title = work.title;
                previous.actorName = work.actorName;
              }
            });
            remember(work, collection.comments);
            partial ||= !collection.complete;
          });
          await archive();
          await syncReplyPresentation();
        } else if (input.action === 'send-pending') await run(false, true);
        else {
          await run(input.action === 'sync' || input.action === 'collect', false);
        }
      },
      signal,
      input.action
    );
    return status();
  };
  return {
    action,
    status,
    close: () => {
      closed = true;
      controller?.abort();
    },
  };
}
