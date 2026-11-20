import type { ReplyComment } from '@/common/types/platform/workbenchReply';
import type { ReplyDocument } from './store';

/** Resolve owner replies through verified direct parents, retaining every conversation node. */
export function observedReplies(document: ReplyDocument): ReplyDocument['observedReplies'] {
  const groups = new Map<string, ReplyComment[]>();
  for (const work of document.works) {
    const comments = document.comments.filter((comment) => comment.workKey === work.key);
    const byId = new Map(comments.map((comment) => [comment.commentId, comment]));
    for (const reply of comments) {
      if (reply.authorId !== work.actorId || !reply.parentCommentId) continue;
      const visited = new Set([reply.commentId]);
      let parent = byId.get(reply.parentCommentId);
      while (parent && !visited.has(parent.commentId)) {
        if (parent.rootCommentId !== reply.rootCommentId) break;
        visited.add(parent.commentId);
        if (parent.authorId !== work.actorId) {
          if (document.records[parent.key]) {
            const values = groups.get(parent.key) ?? [];
            values.push(reply);
            groups.set(parent.key, values);
          }
          break;
        }
        parent = parent.parentCommentId ? byId.get(parent.parentCommentId) : undefined;
      }
    }
  }
  const confirmed = new Set(
    document.attempts.filter((attempt) => attempt.phase === 'sent').map((attempt) => attempt.result?.key)
  );
  return [...groups].flatMap(([commentKey, replies]) => {
    // Workbench delivery already has its own verified writeback and approval lifecycle.
    if (replies.every((reply) => confirmed.has(reply.key))) return [];
    replies.sort(
      (a, b) => a.createdAt - b.createdAt || (a.commentId < b.commentId ? -1 : a.commentId === b.commentId ? 0 : 1)
    );
    const recordId = document.records[commentKey];
    const unresolved = document.attempts.some((attempt) => attempt.recordId === recordId && attempt.phase !== 'sent');
    const next: ReplyDocument['observedReplies'][number] = {
      commentKey,
      recordId,
      replyKeys: replies.map((reply) => reply.key),
      text: replies.map((reply) => reply.content).join('\n\n'),
      state: unresolved ? 'attention' : 'replied',
      result: unresolved ? 'replySendUncertain' : replies.map((reply) => reply.commentId).join(', '),
      written: false,
    };
    const previous = document.observedReplies.find((item) => item.recordId === recordId);
    if (previous && JSON.stringify({ ...previous, written: false }) === JSON.stringify(next))
      next.written = previous.written;
    return [next];
  });
}
