import { createHash } from 'node:crypto';
import type { ReplyComment, ReplyWork } from '@/common/types/platform/workbenchReply';
import { parseWorkbenchCommentLink } from '@/common/utils/urlValidation';

/** Stable local lookup token; links never carry account IDs or arbitrary navigation instructions. */
export function commentLinkToken(comment: ReplyComment): string {
  return createHash('sha256').update('workbench-comment-v1\0').update(comment.key).digest('hex');
}

/** Preserve the platform's signed work URL; only Workbench interprets the fragment. */
export function commentLinkUrl(work: ReplyWork, comment: ReplyComment): string {
  if (
    comment.workKey !== work.key ||
    comment.accountId !== work.accountId ||
    comment.actorId !== work.actorId ||
    comment.platform !== work.platform ||
    comment.workId !== work.workId ||
    comment.key !== `${work.key}:${comment.commentId}` ||
    work.key !== [work.platform, work.accountId, work.actorId, work.workId].join(':')
  )
    throw new Error('REPLY_TARGET_BINDING_MISMATCH');
  const url = new URL(work.url);
  url.hash = `workbench-comment=${commentLinkToken(comment)}`;
  const result = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  const expectedHost = work.platform === 'xiaohongshu' ? 'www.xiaohongshu.com' : 'www.douyin.com';
  if (
    !parseWorkbenchCommentLink(result) ||
    url.hostname !== expectedHost ||
    url.pathname.replace(/\/$/, '').split('/').at(-1) !== work.workId
  )
    throw new Error('REPLY_WORK_URL_MISMATCH');
  return result;
}

export type DmLinkIdentity = Pick<ReplyComment, 'platform' | 'accountId' | 'actorId'> & { contactPlatformId: string };

/** Resolve a private conversation inside the owning account without putting identities into its URL. */
export function dmLinkToken(thread: DmLinkIdentity): string {
  const { platform, accountId, actorId, contactPlatformId } = thread;
  if (
    !['douyin', 'xiaohongshu'].includes(platform) ||
    actorId === contactPlatformId ||
    ![accountId, actorId, contactPlatformId].every(
      (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
    )
  )
    throw new Error('dmIdentityMismatch');
  return createHash('sha256')
    .update('workbench-dm-v1\0')
    .update([platform, accountId, actorId, contactPlatformId].join(':'))
    .digest('hex');
}
