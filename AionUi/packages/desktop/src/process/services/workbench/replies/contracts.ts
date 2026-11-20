import type {
  ReplyComment,
  ReplyResultState,
  ReplySource,
  ReplyTable,
  ReplyTableRow,
  ReplyWork,
} from '@/common/types/platform/workbenchReply';

export type ReplyBrowserLease = {
  accountId: string;
  targetId: string;
  command: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  release: () => void;
};
export type ReplyBrowserAccess = {
  acquire: (accountId: string) => Promise<ReplyBrowserLease>;
};
export type ReplyCollection = { comments: ReplyComment[]; complete: boolean };
export type PreparedReply = { beforeIds: string[]; preparedAt: number; existingReplies?: ReplyComment[] };
export type ReplySubmitResult = ReplyComment | { kind: 'not-sent-existing-replies'; replies: ReplyComment[] };
export type ReplyAttempt = {
  id: string;
  recordId: string;
  commentKey: string;
  workKey: string;
  text: string;
  beforeIds: string[];
  preparedAt: number;
  phase: 'dispatching' | 'uncertain' | 'sent';
  result?: ReplyComment;
  resultWritten?: boolean;
};
export type ReplyPlatformAdapter = {
  locate?: (lease: ReplyBrowserLease, work: ReplyWork, target: ReplyComment, signal?: AbortSignal) => Promise<void>;
  inspectCurrent: (
    lease: ReplyBrowserLease,
    signal?: AbortSignal
  ) => Promise<{ work: ReplyWork; collection: ReplyCollection }>;
  collect: (
    lease: ReplyBrowserLease,
    work: ReplyWork,
    refresh: boolean,
    signal?: AbortSignal
  ) => Promise<ReplyCollection>;
  prepare: (
    lease: ReplyBrowserLease,
    work: ReplyWork,
    target: ReplyComment,
    text: string,
    signal?: AbortSignal
  ) => Promise<PreparedReply>;
  discardPrepared: (lease: ReplyBrowserLease, work: ReplyWork, target: ReplyComment, text: string) => Promise<void>;
  submit: (
    lease: ReplyBrowserLease,
    work: ReplyWork,
    target: ReplyComment,
    text: string,
    prepared: PreparedReply,
    signal?: AbortSignal
  ) => Promise<ReplySubmitResult>;
  reconcile: (
    lease: ReplyBrowserLease,
    work: ReplyWork,
    target: ReplyComment,
    attempt: ReplyAttempt,
    signal?: AbortSignal
  ) => Promise<ReplyComment | null>;
};
/** Durable evidence captured before changing a remote status field or workflow. */
export type ReplyStatusMigration = {
  baseToken: string;
  tableId: string;
  statusFieldId: string;
  workflowId?: string;
  workflowEnabled: boolean;
  records: Record<string, string>;
};
export type ReplyPresentationContext = {
  migration?: ReplyStatusMigration;
  saveMigration: (snapshot: ReplyStatusMigration) => void;
};
export type ReplyTableAdapter = {
  /** tableName is a persisted unique setup name, allowing recovery after an uncertain create. */
  provision: (sourceUrl: string, tableName: string) => Promise<ReplyTable>;
  inspect: (table: ReplyTable) => Promise<void>;
  /** Adds an optional human-facing button/view without replacing routing fields. */
  configurePresentation?: (table: ReplyTable, context?: ReplyPresentationContext) => Promise<ReplyTable>;
  list: (table: ReplyTable) => Promise<ReplyTableRow[]>;
  get: (table: ReplyTable, recordId: string) => Promise<ReplyTableRow | null>;
  create: (
    table: ReplyTable,
    work: ReplyWork,
    comment: ReplyComment,
    parentText: string,
    source?: ReplySource
  ) => Promise<string>;
  /** Read-only recovery validates source fields as well as the locally generated key. */
  recover: (
    table: ReplyTable,
    work: ReplyWork,
    comment: ReplyComment,
    parentText: string,
    source?: ReplySource
  ) => Promise<string | null>;
  /** Consumes the checked approval without touching draft text; verifies by reading back. */
  consumeApproval: (table: ReplyTable, expected: ReplyTableRow) => Promise<boolean>;
  /** Claims the exact draft captured by an explicit toolbar batch, then verifies the sending state. */
  claimDraft?: (table: ReplyTable, expected: ReplyTableRow) => Promise<boolean>;
  writeResult: (
    table: ReplyTable,
    recordId: string,
    state: ReplyResultState,
    result: string,
    source?: ReplySource
  ) => Promise<void>;
  writeObservedReply?: (
    table: ReplyTable,
    row: ReplyTableRow,
    text: string,
    result: string,
    state: 'replied' | 'sent' | 'attention'
  ) => Promise<void>;
  markOwnComment?: (table: ReplyTable, row: ReplyTableRow) => Promise<void>;
  writeCommentLink?: (table: ReplyTable, row: ReplyTableRow, work: ReplyWork, comment: ReplyComment) => Promise<void>;
};
