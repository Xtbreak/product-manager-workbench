/* eslint-disable no-await-in-loop -- Browser steps depend on the preceding page state. */
import type { ReplyComment, ReplyPlatform, ReplyWork } from '@/common/types/platform/workbenchReply';
import type {
  PreparedReply,
  ReplyAttempt,
  ReplyBrowserLease,
  ReplyCollection,
  ReplyPlatformAdapter,
} from '../contracts';
import { DOUYIN_PAGE } from './douyin';
import { XIAOHONGSHU_PAGE } from './xiaohongshu';
import {
  assertBinding,
  evaluate,
  mapComments,
  mapWork,
  PAGE_COMMON,
  settle,
  throwIfAborted,
  type PageSnapshot,
} from './shared';

type Operation = 'snapshot' | 'advance' | 'choose' | 'focus' | 'draft' | 'send' | 'discard' | 'locate';
type Arguments = { work?: ReplyWork; target?: ReplyComment; text?: string };
type TargetSnapshot = PageSnapshot & { targetReady?: boolean };

function expression(platform: ReplyPlatform, operation: Operation, args: Arguments = {}): string {
  const source = platform === 'xiaohongshu' ? XIAOHONGSHU_PAGE : DOUYIN_PAGE;
  return `(() => { const A = ${JSON.stringify(args)}; ${PAGE_COMMON} ${source}
    const snapshot = readPage(); assertWork(snapshot);
    if (${JSON.stringify(operation)} === 'snapshot') {
      if (A.target) {
        const match = snapshot.comments.filter(row => row.id === A.target.commentId && row.root === A.target.rootCommentId
          && row.parent === A.target.parentCommentId && row.authorId === A.target.authorId && row.content === A.target.content);
        const rows = ${
          platform === 'xiaohongshu'
            ? "Array.from(document.querySelectorAll('[id]')).filter(el => visible(el) && el.id === 'comment-' + A.target.commentId)"
            : 'Array.from(document.querySelectorAll(\'[data-e2e="comment-item"]\')).filter(visible).filter(el => commentInfo(el)?.cid === A.target.commentId)'
        };
        let ready = false;
        if (match.length === 1 && rows.length === 1) {
          const row = rows[0];
          const controls = ${
            platform === 'xiaohongshu'
              ? "Array.from(row.querySelectorAll('.reply')).filter(visible)"
              : "Array.from(row.querySelectorAll('*')).filter(el => el.children.length === 0 && visible(el) && label(el).trim() === '回复' && el.closest('[data-e2e=\"comment-item\"]') === row)"
          };
          ready = controls.length === 1;
          if (!ready && platform === 'douyin') {
            try { assertSelected(); ready = true; } catch (error) {
              if (error?.message === 'REPLY_FIBER_UNVERIFIED') throw error;
            }
          }
        }
        snapshot.targetReady = ready;
      }
      return snapshot;
    }
    if (${JSON.stringify(operation)} === 'advance') return visibleDraft() ? false : advance();
    assertTarget(snapshot);
    if (${JSON.stringify(operation)} === 'locate') return highlightTarget();
    if (['choose', 'focus', 'draft', 'send'].includes(${JSON.stringify(operation)})) {
      if (snapshot.ambiguous !== false) throw Error('REPLY_SNAPSHOT_AMBIGUOUS');
      const existing = snapshot.comments.filter(row => row.authorId === snapshot.actorId && row.parent === A.target.commentId && row.root === A.target.rootCommentId);
      if (existing.length) {
        if (${JSON.stringify(operation)} === 'send') return { kind: 'not-sent-existing-replies', snapshot };
        throw Error('REPLY_EXISTING_REPLY');
      }
      if (!snapshot.completeThreads.includes(A.target.rootCommentId)) throw Error('REPLY_THREAD_INCOMPLETE');
    }
    if (${JSON.stringify(operation)} === 'choose') { assertEmptyDraft(); chooseReply(); return true; }
    const input = editor();
    if (${JSON.stringify(operation)} === 'discard' && !text(input)) return true;
    assertSelected();
    if (${JSON.stringify(operation)} === 'focus') {
      assertEmptyDraft(); input.focus();
      if (document.activeElement !== input) throw Error('REPLY_EDITOR_NOT_FOCUSED');
      return true;
    }
    if (text(input) !== A.text) throw Error('REPLY_DRAFT_CHANGED');
    if (${JSON.stringify(operation)} === 'discard') {
      input.focus();
      if (document.activeElement !== input) throw Error('REPLY_EDITOR_NOT_FOCUSED');
      const selection = window.getSelection();
      const range = document.createRange(); range.selectNodeContents(input);
      selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand('delete', false) || text(input)) throw Error('REPLY_DRAFT_CLEAR_FAILED');
      return true;
    }
    if (${JSON.stringify(operation)} === 'draft') return true;
    const button = sendButton();
    button.click();
    return true;
  })()`;
}

const PEEK = `(() => { const A = {}; ${PAGE_COMMON} return { url: location.href, draft: visibleDraft(), timeOrigin: performance.timeOrigin, readyState: document.readyState }; })()`;

function platformForUrl(url: string): ReplyPlatform {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('REPLY_PLATFORM_UNSUPPORTED');
  if (parsed.hostname === 'www.xiaohongshu.com') return 'xiaohongshu';
  if (parsed.hostname === 'www.douyin.com') return 'douyin';
  throw new Error('REPLY_PLATFORM_UNSUPPORTED');
}

function sameWorkUrl(url: string, work: Pick<ReplyWork, 'platform' | 'workId'>): boolean {
  try {
    return platformForUrl(url) === work.platform && new URL(url).pathname.split('/').includes(work.workId);
  } catch {
    return false;
  }
}

function validPageId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4000 && /^[a-zA-Z0-9_-]+$/.test(value);
}

function assertSnapshot(snapshot: PageSnapshot, work?: ReplyWork, accountId?: string): void {
  if (
    !snapshot ||
    !snapshot.workId ||
    !snapshot.actorId ||
    snapshot.actorId !== snapshot.ownerId ||
    !Array.isArray(snapshot.comments)
  )
    throw new Error('REPLY_OWNER_IDENTITY_MISMATCH');
  if (
    work &&
    (snapshot.platform !== work.platform || snapshot.workId !== work.workId || snapshot.actorId !== work.actorId)
  )
    throw new Error('REPLY_WORK_IDENTITY_CHANGED');
  const scopedAccountId = work?.accountId ?? accountId;
  if (
    (snapshot.platform !== 'xiaohongshu' && snapshot.platform !== 'douyin') ||
    !validPageId(snapshot.actorId) ||
    !validPageId(snapshot.workId) ||
    typeof scopedAccountId !== 'string' ||
    !scopedAccountId ||
    scopedAccountId.length > 4000 ||
    typeof snapshot.actorName !== 'string' ||
    typeof snapshot.title !== 'string' ||
    typeof snapshot.url !== 'string' ||
    !sameWorkUrl(snapshot.url, snapshot) ||
    typeof snapshot.complete !== 'boolean' ||
    !Array.isArray(snapshot.completeThreads) ||
    snapshot.completeThreads.length > 500 ||
    snapshot.completeThreads.some((id) => !validPageId(id)) ||
    snapshot.comments.length > 500
  )
    throw new Error('REPLY_SNAPSHOT_INVALID');
  const key = `${snapshot.platform}:${scopedAccountId}:${snapshot.actorId}:${snapshot.workId}`;
  if (key.length > 4000) throw new Error('REPLY_SNAPSHOT_INVALID');
  const ids = new Set<string>();
  for (const row of snapshot.comments) {
    if (
      !row ||
      !validPageId(row.id) ||
      ids.has(row.id) ||
      `${key}:${row.id}`.length > 4000 ||
      !validPageId(row.root) ||
      (row.parent !== null && !validPageId(row.parent)) ||
      !validPageId(row.authorId) ||
      typeof row.author !== 'string' ||
      typeof row.content !== 'string' ||
      typeof row.time !== 'number' ||
      !Number.isFinite(row.time) ||
      row.time < 0
    )
      throw new Error('REPLY_SNAPSHOT_INVALID');
    ids.add(row.id);
  }
}

function assertUnambiguous(snapshot: PageSnapshot): void {
  if (snapshot.ambiguous !== false) throw new Error('REPLY_SNAPSHOT_AMBIGUOUS');
}

function existingReplySnapshot(snapshot: PageSnapshot, work: ReplyWork, target: ReplyComment): ReplyComment[] {
  assertSnapshot(snapshot, work);
  assertUnambiguous(snapshot);
  const comments = mapComments(snapshot, work);
  requireTarget(comments, target);
  const replies = existingReplies(comments, work, target);
  if (!replies.length || replies.some((reply) => reply.commentId === target.commentId))
    throw new Error('REPLY_SNAPSHOT_INVALID');
  return replies;
}

function requireTarget(comments: ReplyComment[], target: ReplyComment): void {
  const found = comments.find((row) => row.key === target.key);
  if (
    !found ||
    found.parentCommentId !== target.parentCommentId ||
    found.rootCommentId !== target.rootCommentId ||
    found.authorId !== target.authorId ||
    found.content !== target.content
  )
    throw new Error('REPLY_TARGET_CHANGED');
}

function existingReplies(comments: ReplyComment[], work: ReplyWork, target: ReplyComment): ReplyComment[] {
  return comments.filter(
    (row) =>
      row.workKey === work.key &&
      row.accountId === work.accountId &&
      row.actorId === work.actorId &&
      row.platform === work.platform &&
      row.workId === work.workId &&
      row.authorId === work.actorId &&
      row.parentCommentId === target.commentId &&
      row.rootCommentId === target.rootCommentId
  );
}

function addObservedComment(found: Map<string, ReplyComment>, row: ReplyComment): void {
  const previous = found.get(row.key);
  if (
    previous &&
    (previous.rootCommentId !== row.rootCommentId ||
      previous.parentCommentId !== row.parentCommentId ||
      previous.authorId !== row.authorId ||
      previous.content !== row.content)
  )
    throw new Error('REPLY_SNAPSHOT_AMBIGUOUS');
  found.set(row.key, row);
}

function findReply(
  comments: ReplyComment[],
  work: ReplyWork,
  target: ReplyComment,
  attempt: Pick<ReplyAttempt, 'text' | 'beforeIds' | 'preparedAt'>
): ReplyComment | null {
  const before = new Set(attempt.beforeIds);
  const matches = comments.filter(
    (row) =>
      !before.has(row.commentId) &&
      row.authorId === work.actorId &&
      row.parentCommentId === target.commentId &&
      row.rootCommentId === target.rootCommentId &&
      row.content === attempt.text &&
      row.createdAt > 0 &&
      row.createdAt >= attempt.preparedAt - 3000
  );
  if (matches.length > 1) throw new Error('REPLY_RESULT_AMBIGUOUS');
  return matches[0] ?? null;
}

/** Creates browser-only adapters. Sending is pinned to the exact preparation lease. */
export function createReplyPlatformAdapter(): ReplyPlatformAdapter {
  const preparations = new WeakMap<PreparedReply, { lease: ReplyBrowserLease; targetKey: string; text: string }>();
  const ownedDrafts = new WeakMap<ReplyBrowserLease, { prepared: PreparedReply; targetKey: string; text: string }>();

  const snapshot = async (
    lease: ReplyBrowserLease,
    work: ReplyWork,
    signal?: AbortSignal,
    target?: ReplyComment
  ): Promise<TargetSnapshot> => {
    assertBinding(lease, work);
    const result = await evaluate<TargetSnapshot>(
      lease,
      expression(work.platform, 'snapshot', { work, target }),
      signal
    );
    assertSnapshot(result, work);
    assertUnambiguous(result);
    return result;
  };

  const ensurePage = async (
    lease: ReplyBrowserLease,
    work: ReplyWork,
    refresh: boolean,
    signal?: AbortSignal
  ): Promise<void> => {
    assertBinding(lease, work);
    const before = await evaluate<{ url: string; draft: boolean; timeOrigin: number; readyState: string }>(
      lease,
      PEEK,
      signal
    );
    if (!refresh && sameWorkUrl(before.url, work)) return;
    if (before.draft) throw new Error('REPLY_EXISTING_DRAFT');
    if (!Number.isFinite(before.timeOrigin) || before.timeOrigin <= 0) throw new Error('REPLY_NAVIGATION_INCOMPLETE');
    throwIfAborted(signal);
    const navigation = (await lease.command('Page.navigate', { url: work.url })) as { errorText?: string };
    if (navigation?.errorText) throw new Error('REPLY_NAVIGATION_FAILED');
    // The lease owns the target throughout navigation; it must reject destruction/replacement.
    for (let i = 0; i < 12; i++) {
      await settle(signal, 250);
      const page = await evaluate<{ url: string; draft: boolean; timeOrigin: number; readyState: string }>(
        lease,
        PEEK,
        signal
      );
      if (
        !sameWorkUrl(page.url, work) ||
        !Number.isFinite(page.timeOrigin) ||
        page.timeOrigin <= 0 ||
        page.timeOrigin === before.timeOrigin ||
        page.readyState === 'loading'
      )
        continue;
      try {
        await snapshot(lease, work, signal);
        return;
      } catch (error) {
        if (error instanceof Error && /CHALLENGE|CANCELLED/.test(error.message)) throw error;
        if (i === 11) throw error;
      }
    }
    throw new Error('REPLY_NAVIGATION_INCOMPLETE');
  };

  const collect = async (
    lease: ReplyBrowserLease,
    work: ReplyWork,
    refresh: boolean,
    signal?: AbortSignal,
    target?: ReplyComment
  ): Promise<ReplyCollection> => {
    await ensurePage(lease, work, refresh, signal);
    const found = new Map<string, ReplyComment>();
    let noProgress = 0;
    let complete = false;
    for (let i = 0; i < 12; i++) {
      const page = await snapshot(lease, work, signal, target);
      const before = found.size;
      for (const row of mapComments(page, work)) addObservedComment(found, row);
      complete = page.complete;
      if (
        (target ? page.targetReady === true && page.completeThreads.includes(target.rootCommentId) : complete) ||
        found.size >= 500
      )
        break;
      noProgress = found.size === before ? noProgress + 1 : 0;
      if (i === 11) break;
      const advanced =
        noProgress < 2 && (await evaluate<boolean>(lease, expression(work.platform, 'advance', { work }), signal));
      if (!advanced) {
        // An expand control can disappear while its request is still loading.
        // Drain a small read-only window instead of treating that UI state as completion.
        for (let pending = 0; pending < 4; pending++) {
          await settle(signal, 300);
          const late = await snapshot(lease, work, signal, target);
          for (const row of mapComments(late, work)) addObservedComment(found, row);
          complete = late.complete;
          if (
            (target ? late.targetReady === true && late.completeThreads.includes(target.rootCommentId) : complete) ||
            found.size >= 500
          )
            break;
        }
        break;
      }
      await settle(signal);
    }
    return { comments: [...found.values()].slice(0, 500), complete: complete && found.size <= 500 };
  };

  const discardPrepared = async (
    lease: ReplyBrowserLease,
    work: ReplyWork,
    target: ReplyComment,
    text: string
  ): Promise<void> => {
    assertBinding(lease, work, target);
    const owned = ownedDrafts.get(lease);
    if (!owned || owned.targetKey !== target.key || owned.text !== text) throw new Error('REPLY_DRAFT_NOT_OWNED');
    preparations.delete(owned.prepared);
    await evaluate(lease, expression(work.platform, 'discard', { work, target, text }));
    ownedDrafts.delete(lease);
  };

  return {
    async inspectCurrent(lease, signal) {
      const current = await evaluate<{ url: string }>(lease, PEEK, signal);
      const platform = platformForUrl(current.url);
      const page = await evaluate<PageSnapshot>(lease, expression(platform, 'snapshot'), signal);
      assertSnapshot(page, undefined, lease.accountId);
      assertUnambiguous(page);
      const work = mapWork(page, lease.accountId);
      assertBinding(lease, work);
      return { work, collection: await collect(lease, work, false, signal) };
    },
    collect,
    discardPrepared,
    async locate(lease, work, target, signal) {
      assertBinding(lease, work, target);
      await ensurePage(lease, work, false, signal);
      const seen = new Set<string>();
      // Inspect and highlight before advancing: virtual lists may discard the current node.
      for (let pass = 0; pass < 12; pass++) {
        const page = await snapshot(lease, work, signal);
        const rows = mapComments(page, work);
        for (const row of rows) seen.add(row.key);
        if (rows.some((row) => row.key === target.key)) {
          requireTarget(rows, target);
          if (await evaluate<boolean>(lease, expression(work.platform, 'locate', { work, target }), signal)) return;
        }
        if (seen.size >= 500 || pass === 11) break;
        const advanced = await evaluate<boolean>(lease, expression(work.platform, 'advance', { work }), signal);
        if (!advanced) break;
        await settle(signal);
      }
      throw new Error('REPLY_TARGET_UNAVAILABLE');
    },
    async prepare(lease, work, target, text, signal) {
      assertBinding(lease, work, target);
      if (!text.trim() || text.length > 1000) throw new Error('REPLY_DRAFT_INVALID');
      // An already visible reply is positive evidence and needs no navigation or editor changes.
      await ensurePage(lease, work, false, signal);
      const currentPage = await snapshot(lease, work, signal, target);
      const current = mapComments(currentPage, work);
      if (current.some((row) => row.key === target.key)) {
        requireTarget(current, target);
        const observed = existingReplies(current, work, target);
        if (observed.length)
          return { beforeIds: current.map((row) => row.commentId), preparedAt: Date.now(), existingReplies: observed };
      }
      // A complete but stale page cannot prove that another device did not reply later.
      const collection = await collect(lease, work, true, signal, target);
      requireTarget(collection.comments, target);
      let observed = existingReplies(collection.comments, work, target);
      if (observed.length)
        return {
          beforeIds: collection.comments.map((row) => row.commentId),
          preparedAt: Date.now(),
          existingReplies: observed,
        };
      const page = await snapshot(lease, work, signal, target);
      const latest = mapComments(page, work);
      requireTarget(latest, target);
      const seen = new Map(collection.comments.map((row) => [row.key, row]));
      for (const row of latest) addObservedComment(seen, row);
      const before = [...seen.values()];
      observed = existingReplies(before, work, target);
      if (observed.length)
        return { beforeIds: before.map((row) => row.commentId), preparedAt: Date.now(), existingReplies: observed };
      if (!page.completeThreads.includes(target.rootCommentId)) throw new Error('replyThreadIncomplete');
      await evaluate(lease, expression(work.platform, 'choose', { work, target }), signal);
      for (let ready = 0; ready < 12; ready++) {
        try {
          await evaluate(lease, expression(work.platform, 'focus', { work, target }), signal);
          break;
        } catch (error) {
          const transient =
            error instanceof Error &&
            /^REPLY_(EDITOR_NOT_UNIQUE|EDITOR_NOT_FOCUSED|SELECTED_TARGET_CHANGED|SELECTED_ROOT_CHANGED)$/.test(
              error.message
            );
          if (!transient || ready === 11) throw error;
          await settle(signal, 150);
        }
      }
      const prepared: PreparedReply = {
        beforeIds: before.map((row) => row.commentId),
        preparedAt: Date.now(),
      };
      // Record ownership before the insertion can have a side effect or lose its response.
      // The token becomes valid only after the exact draft has been verified.
      ownedDrafts.set(lease, { prepared, targetKey: target.key, text });
      try {
        throwIfAborted(signal);
        await lease.command('Input.insertText', { text });
        await evaluate(lease, expression(work.platform, 'draft', { work, target, text }), signal);
        preparations.set(prepared, { lease, targetKey: target.key, text });
        return prepared;
      } catch (error) {
        preparations.delete(prepared);
        // Cleanup is independent of the cancelled signal, but still enforces all page guards.
        try {
          await discardPrepared(lease, work, target, text);
        } catch {
          /* Never clear changed human text. */
        }
        throw error;
      }
    },
    async submit(lease, work, target, text, prepared, signal) {
      assertBinding(lease, work, target);
      const preparation = preparations.get(prepared);
      if (
        !preparation ||
        preparation.lease !== lease ||
        preparation.targetKey !== target.key ||
        preparation.text !== text ||
        Date.now() - prepared.preparedAt > 60_000
      )
        throw new Error('REPLY_PREPARED_STATE_CONSUMED_OR_CHANGED');
      // Consume before dispatch: no rejected command or uncertain result may lead to another click.
      preparations.delete(prepared);
      const outcome = await evaluate<true | { kind: 'not-sent-existing-replies'; snapshot: PageSnapshot }>(
        lease,
        expression(work.platform, 'send', { work, target, text }),
        signal
      );
      if (outcome !== true) {
        if (!outcome || outcome.kind !== 'not-sent-existing-replies') throw new Error('REPLY_SEND_RESULT_INVALID');
        const replies = existingReplySnapshot(outcome.snapshot, work, target);
        // The page returned before clicking. Clear only the exact draft that this lease still owns.
        try {
          await discardPrepared(lease, work, target, text);
        } catch {
          /* Preserve changed human drafts and the confirmed no-click result. */
        }
        return { kind: 'not-sent-existing-replies', replies };
      }
      for (let i = 0; i < 10; i++) {
        const page = await snapshot(lease, work, signal, target);
        const result = findReply(mapComments(page, work), work, target, { ...prepared, text });
        if (result) {
          // A cleanup failure must not downgrade an already confirmed platform result.
          // Changed human drafts are deliberately left intact and block the next preparation.
          try {
            await discardPrepared(lease, work, target, text);
          } catch {
            /* Preserve the confirmed result. */
          }
          return result;
        }
        await settle(signal, 250);
      }
      throw new Error('REPLY_RESULT_UNCONFIRMED');
    },
    async reconcile(lease, work, target, attempt, signal) {
      assertBinding(lease, work, target);
      if (attempt.workKey !== work.key || attempt.commentKey !== target.key) throw new Error('REPLY_ATTEMPT_MISMATCH');
      // Reconciliation never fills an editor, clicks send, or reloads a pending challenge.
      const collection = await collect(lease, work, false, signal, target);
      return findReply(collection.comments, work, target, attempt);
    },
  };
}
