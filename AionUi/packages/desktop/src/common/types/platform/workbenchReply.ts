/** Stable identities are strings; platform IDs may exceed JavaScript's integer range. */
export type ReplyPlatform = 'xiaohongshu' | 'douyin';
export type ReplyWork = {
  key: string;
  platform: ReplyPlatform;
  accountId: string;
  actorId: string;
  actorName: string;
  workId: string;
  title: string;
  url: string;
};
export type ReplyComment = {
  key: string;
  workKey: string;
  platform: ReplyPlatform;
  accountId: string;
  actorId: string;
  workId: string;
  commentId: string;
  rootCommentId: string;
  parentCommentId: string | null;
  authorId: string;
  author: string;
  content: string;
  createdAt: number;
};
export type ReplyField =
  | 'author'
  | 'time'
  | 'comment'
  | 'draft'
  | 'ready'
  | 'status'
  | 'result'
  | 'platform'
  | 'account'
  | 'conversation'
  | 'parent'
  | 'key';
export type ReplyTable = {
  baseToken: string;
  tableId: string;
  url: string;
  fields: Record<ReplyField, string>;
  presentation?: {
    buttonFieldId: string;
    approvalTextFieldId: string;
    workflowId: string;
    viewId: string;
    timeDisplayFieldId?: string;
    statusFieldType?: 'select';
    commentLinkFieldId?: string;
    replyCaptureVersion?: 1;
    sendMode?: 'toolbar';
  };
};
export type ReplySource = Pick<
  Record<ReplyField, string>,
  'author' | 'time' | 'comment' | 'platform' | 'account' | 'conversation' | 'parent' | 'key'
>;
export type ReplyTableRow = {
  recordId: string;
  messageKey: string;
  draft: string;
  ready: boolean;
  status: string;
  result: string;
  approvedDraft?: string;
  commentLink?: string;
  source?: ReplySource;
};
export type ReplyResultState = 'waiting' | 'sending' | 'sent' | 'attention' | 'replied' | 'own';
export type ReplySyncTiming = {
  action: ReplySyncAction['action'] | 'poll';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: Array<{ name: string; calls: number; durationMs: number }>;
};
export type ReplySyncStatus = {
  enabled: boolean;
  busy: boolean;
  canCancelSend?: boolean;
  busyAccountId?: string;
  tableUrl?: string;
  sendButtonConfigured?: boolean;
  sendMode?: 'toolbar';
  buttonDispatchMode?: 'automatic' | 'manual';
  works: ReplyWork[];
  archived: number;
  sent: number;
  uncertain: number;
  lastRunAt?: number;
  error?: string;
  collectionPartial?: boolean;
  timing?: ReplySyncTiming;
  commentTarget?: { accountId: string; token: string };
};
export type ReplySyncAction =
  | { action: 'status' }
  | { action: 'setup'; sourceUrl: string }
  | { action: 'bind'; accountId: string }
  | { action: 'configure' }
  | { action: 'enabled'; enabled: boolean }
  | { action: 'dispatch-mode'; mode: 'automatic' | 'manual' }
  | { action: 'send-pending' }
  | { action: 'resolve-comment'; token: string; fromDm?: boolean }
  | { action: 'open-comment'; token: string; fromDm?: boolean }
  | { action: 'cancel' }
  | { action: 'collect' }
  | { action: 'sync' }
  | { action: 'reconcile' };
