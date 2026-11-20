import {
  mkdirSync,
  readFileSync,
  renameSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ReplyAttempt, ReplyStatusMigration } from './contracts';
import type { ReplyComment, ReplySource, ReplyTable, ReplyWork } from '@/common/types/platform/workbenchReply';

const id = z.string().min(1).max(4000);
const platform = z.enum(['xiaohongshu', 'douyin']);
const workSchema = z.object({
  key: id,
  platform,
  accountId: id,
  actorId: id,
  actorName: z.string(),
  workId: id,
  title: z.string(),
  url: z.string().url(),
});
const commentSchema = z.object({
  key: id,
  workKey: id,
  platform,
  accountId: id,
  actorId: id,
  workId: id,
  commentId: id,
  rootCommentId: id,
  parentCommentId: id.nullable(),
  authorId: id,
  author: z.string(),
  content: z.string(),
  createdAt: z.number().finite(),
});
const tableSchema = z.object({
  baseToken: id,
  tableId: id,
  url: z.string().url(),
  presentation: z
    .object({
      buttonFieldId: id,
      approvalTextFieldId: id,
      workflowId: id,
      viewId: id,
      timeDisplayFieldId: id.optional(),
      statusFieldType: z.literal('select').optional(),
      commentLinkFieldId: id.optional(),
      replyCaptureVersion: z.literal(1).optional(),
      sendMode: z.literal('toolbar').optional(),
    })
    .optional(),
  fields: z.object({
    author: id,
    time: id,
    comment: id,
    draft: id,
    ready: id,
    status: id,
    result: id,
    platform: id,
    account: id,
    conversation: id,
    parent: id,
    key: id,
  }),
});
const attemptSchema = z.object({
  id,
  recordId: id,
  commentKey: id,
  workKey: id,
  text: z.string(),
  beforeIds: z.array(id),
  preparedAt: z.number(),
  phase: z.enum(['dispatching', 'uncertain', 'sent']),
  result: commentSchema.optional(),
  resultWritten: z.boolean().optional(),
});
const statusMigrationSchema = z
  .object({
    baseToken: id,
    tableId: id,
    statusFieldId: id,
    workflowId: id.optional(),
    workflowEnabled: z.boolean(),
    records: z.record(id, z.string()),
  })
  .strict();
const sourceSnapshotsSchema = z.record(
  z.string(),
  z
    .object({
      author: z.string(),
      time: z.string(),
      comment: z.string(),
      platform: z.string(),
      account: z.string(),
      conversation: z.string(),
      parent: z.string(),
      key: z.string(),
    })
    .strict()
);
const schema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  buttonDispatchMode: z.enum(['automatic', 'manual']).default('manual'),
  buttonDispatchVersion: z.union([z.literal(0), z.literal(1)]).default(0),
  presentationConfiguring: z.boolean().default(false),
  statusMigration: statusMigrationSchema.optional(),
  setup: z.object({ sourceUrl: z.string().url(), name: id }).optional(),
  table: tableSchema.optional(),
  works: z.array(workSchema),
  comments: z.array(commentSchema),
  records: z.record(z.string(), z.string()),
  sourceSnapshots: sourceSnapshotsSchema.default({}),
  pendingCreates: z.array(id),
  attempts: z.array(attemptSchema),
  approvals: z.array(z.object({ id, recordId: id })).default([]),
  approvalBlocks: z.array(id).default([]),
  observedReplies: z
    .array(
      z.object({
        commentKey: id,
        recordId: id,
        replyKeys: z.array(id).min(1),
        text: z.string(),
        result: z.string(),
        state: z.enum(['replied', 'attention']),
        written: z.boolean(),
      })
    )
    .default([]),
  selfCommentRecords: z.array(id).default([]),
  linkedRecords: z.record(z.string(), z.string()).default({}),
  lastRunAt: z.number().optional(),
});
export type ReplyDocument = {
  version: 1;
  enabled: boolean;
  buttonDispatchMode: 'automatic' | 'manual';
  buttonDispatchVersion: 0 | 1;
  presentationConfiguring: boolean;
  statusMigration?: ReplyStatusMigration;
  setup?: { sourceUrl: string; name: string };
  table?: ReplyTable;
  works: ReplyWork[];
  comments: ReplyComment[];
  records: Record<string, string>;
  sourceSnapshots: Record<string, ReplySource>;
  pendingCreates: string[];
  attempts: ReplyAttempt[];
  approvals: { id: string; recordId: string }[];
  approvalBlocks: string[];
  observedReplies: {
    commentKey: string;
    recordId: string;
    replyKeys: string[];
    text: string;
    result: string;
    state: 'replied' | 'attention';
    written: boolean;
  }[];
  selfCommentRecords: string[];
  linkedRecords: Record<string, string>;
  lastRunAt?: number;
};

/** Separate durable outbox. Corrupt state fails closed; it is never silently replaced. */
export class ReplyStore {
  private value: ReplyDocument;
  private readonly file: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'comment-replies.json');
    try {
      this.value = schema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) as ReplyDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('replyStoreInvalid');
      this.value = {
        version: 1,
        enabled: false,
        buttonDispatchMode: 'manual',
        buttonDispatchVersion: 0,
        presentationConfiguring: false,
        works: [],
        comments: [],
        records: {},
        sourceSnapshots: {},
        pendingCreates: [],
        attempts: [],
        approvals: [],
        approvalBlocks: [],
        observedReplies: [],
        selfCommentRecords: [],
        linkedRecords: {},
      };
    }
    if (this.value.enabled || this.value.buttonDispatchMode !== 'manual')
      this.update((doc) => {
        doc.enabled = false;
        doc.buttonDispatchMode = 'manual';
      });
  }
  read(): ReplyDocument {
    return structuredClone(this.value);
  }
  update(change: (document: ReplyDocument) => void): void {
    const next = this.read();
    change(next);
    if (
      !statusMigrationSchema.optional().safeParse(next.statusMigration).success ||
      !sourceSnapshotsSchema.safeParse(next.sourceSnapshots).success
    )
      throw new Error('replyStoreInvalid');
    // Persist and fsync the intent before a caller can perform an irreversible action.
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.file);
      const directory = openSync(path.dirname(this.file), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.value = next;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        /* Atomic rename already removed the temporary file. */
      }
    }
  }
}
