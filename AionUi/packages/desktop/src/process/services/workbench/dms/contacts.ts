import type { DmComment, DmMessage, DmThread } from '@/common/types/platform/workbenchDm';
import type { ReplyDocument } from '../replies/store';
import { commentLinkToken } from '../replies/commentLinks';
import type { DmDocument, DmEntry } from './store';

export function projectContacts(doc: DmDocument, replies: ReplyDocument) {
  const entries = new Map<string, DmEntry>();
  for (const { thread, messages } of doc.entries)
    entries.set(thread.key, { messages, thread: { ...thread, commentKeys: [] } });
  const comments = new Map<string, DmComment>();
  const works = new Map(replies.works.map((w) => [w.key, w]));
  if (
    works.size !== replies.works.length ||
    new Set(replies.comments.map((c) => c.key)).size !== replies.comments.length
  )
    throw new Error('dmIdentityMismatch');
  for (const c of replies.comments) {
    const w = works.get(c.workKey);
    if (
      !w ||
      c.authorId === c.actorId ||
      c.key !== w.key + ':' + c.commentId ||
      c.platform !== w.platform ||
      c.accountId !== w.accountId ||
      c.actorId !== w.actorId ||
      c.workId !== w.workId ||
      w.key !== [w.platform, w.accountId, w.actorId, w.workId].join(':') ||
      ![c.authorId, c.actorId, c.accountId].every((v) => /^[a-zA-Z0-9_-]{1,256}$/.test(v))
    )
      continue;
    const key = [c.platform, c.accountId, c.actorId, c.authorId].join(':');
    const entry = entries.get(key) ?? {
      thread: {
        key,
        platform: c.platform,
        accountId: c.accountId,
        actorId: c.actorId,
        contactPlatformId: c.authorId,
        source: 'comment',
        contactName: c.author,
        commentKeys: [],
        lastMessagePreview: '',
        lastMessageAt: null,
        lastSender: null,
        syncState: 'idle',
        watermark: null,
      } as DmThread,
      messages: [],
    };
    entry.thread.commentKeys.push(c.key);
    if (c.author) entry.thread.contactName = c.author;
    comments.set(c.key, {
      key: c.key,
      token: commentLinkToken(c),
      content: c.content,
      workTitle: w.title,
      createdAt: c.createdAt,
    });
    entries.set(key, entry);
  }
  return { entries, comments };
}
export function applyHistory(
  entry: DmEntry,
  incoming: DmMessage[],
  complete: boolean,
  reason: string | undefined,
  enabledAt: number,
  now: number
): DmEntry {
  const byId = new Map(entry.messages.map((m) => [m.id, m]));
  for (const m of incoming) {
    if (m.timestamp < enabledAt) continue;
    const previous = byId.get(m.id);
    if (previous && (previous.sender !== m.sender || previous.timestamp !== m.timestamp))
      throw new Error('dmIdentityMismatch');
    if (previous?.kind === 'recalled') continue;
    if (m.kind === 'recalled') {
      byId.set(m.id, { ...m, text: '' });
      continue;
    }
    if (previous && previous.kind !== 'unknown') {
      if (m.kind === 'unknown') continue;
      if (previous.kind !== m.kind || previous.text !== m.text) throw new Error('dmIdentityMismatch');
    }
    byId.set(m.id, m);
  }
  const messages = [...byId.values()].sort(
    (a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const last = messages.at(-1);
  return {
    messages,
    thread: {
      ...entry.thread,
      lastMessageAt: last?.timestamp ?? null,
      lastSender: last?.sender ?? null,
      lastMessageKind: last?.kind,
      lastMessagePreview: (last?.text || last?.nonTextLabel || '').slice(0, 160),
      lastSyncedAt: now,
      watermark: complete
        ? Math.max(entry.thread.watermark ?? enabledAt, last?.timestamp ?? enabledAt)
        : entry.thread.watermark,
      syncState: complete ? 'idle' : 'partial',
      partialReason: complete ? undefined : (reason ?? 'dmPartialHistory'),
      lastError: undefined,
    },
  };
}

export function linkSummary(entry: DmEntry) {
  const { platform, accountId, actorId, contactPlatformId, lastSender } = entry.thread;
  let count = 0;
  for (let i = entry.messages.length - 1; i >= 0 && entry.messages[i].sender === lastSender; i--) count++;
  const direction =
    lastSender === 'me' ? ('outbound' as const) : lastSender === 'peer' ? ('inbound' as const) : undefined;
  return { platform, accountId, actorId, contactPlatformId, count, direction };
}
