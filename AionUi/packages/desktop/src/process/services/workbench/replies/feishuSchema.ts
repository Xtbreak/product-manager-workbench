import { z } from 'zod';
import type {
  ReplyComment,
  ReplyField,
  ReplySource,
  ReplyTable,
  ReplyTableRow,
  ReplyWork,
} from '@/common/types/platform/workbenchReply';

export const REPLY_FIELDS: ReadonlyArray<{ key: ReplyField; name: string; type: 'text' | 'checkbox' }> = [
  { key: 'author', name: '用户', type: 'text' },
  { key: 'time', name: '时间', type: 'text' },
  { key: 'comment', name: '评论', type: 'text' },
  { key: 'draft', name: '回复内容', type: 'text' },
  { key: 'ready', name: '可发送', type: 'checkbox' },
  { key: 'status', name: '发送状态', type: 'text' },
  { key: 'result', name: '发送结果', type: 'text' },
  { key: 'platform', name: '平台', type: 'text' },
  { key: 'account', name: '账号', type: 'text' },
  { key: 'conversation', name: '对话编号', type: 'text' },
  { key: 'parent', name: '回复对象', type: 'text' },
  { key: 'key', name: '消息键', type: 'text' },
];

const RETRYABLE_RESULT_EXPLANATIONS: Readonly<Record<string, string>> = {
  replyApprovalInterrupted: '尚未发送，请检查回复内容后重新勾选可发送',
  replyVerificationRequired: '请在对应平台完成验证，再点击发送',
  replyAccountMismatch: '当前登录账号与作品账号不一致，请检查后重新发送',
  replyDraftPresent: '浏览器有未发送的草稿，请处理后重新发送',
  replyTargetUnavailable: '未找到对应评论，请检查平台页面',
  replyThreadIncomplete: '评论回复未完全加载，确认后请重新点击发送',
  replyBrowserUnavailable: '浏览器暂时不可用，请检查后重新发送',
  replyDraftChanged: '回复已修改，请确认后重新点击发送',
  replyDraftEmpty: '请先填写回复内容，再点击发送',
  replyPaused: '发送前任务已暂停，请重新点击发送',
};
export const TOOLBAR_APPROVAL_INTERRUPTED = '尚未发送，请检查回复内容后点击上方“发送评论”';
export const REPLY_RESULT_EXPLANATIONS: Readonly<Record<string, string>> = {
  ...RETRYABLE_RESULT_EXPLANATIONS,
  replySendUncertain: '发送结果待核对，请勿重复发送',
};

/** Recognize only absent results or known pre-dispatch failures, including historical display text. */
export function isRetryableReplyResult(result: string): boolean {
  return (
    result === '' ||
    result === TOOLBAR_APPROVAL_INTERRUPTED ||
    Object.hasOwn(RETRYABLE_RESULT_EXPLANATIONS, result) ||
    Object.values(RETRYABLE_RESULT_EXPLANATIONS).includes(result)
  );
}

const SOURCE_FIELDS = ['author', 'time', 'comment', 'platform', 'account', 'conversation', 'parent', 'key'] as const;

/** Match complete source snapshots; missing fields never count as matching evidence. */
export function sameReplySource(actual?: ReplySource, expected?: ReplySource): boolean {
  return Boolean(
    actual &&
    expected &&
    SOURCE_FIELDS.every(
      (key) =>
        Object.hasOwn(actual, key) &&
        Object.hasOwn(expected, key) &&
        typeof actual[key] === 'string' &&
        typeof expected[key] === 'string' &&
        actual[key] === expected[key]
    )
  );
}

/** Construct the immutable Feishu source values from a locally verified work and comment. */
export function replySourceValues(work: ReplyWork, comment: ReplyComment, parentText: string): ReplySource {
  if (
    comment.workKey !== work.key ||
    comment.platform !== work.platform ||
    comment.accountId !== work.accountId ||
    comment.actorId !== work.actorId ||
    comment.workId !== work.workId ||
    !comment.key ||
    !Number.isFinite(comment.createdAt) ||
    !Number.isFinite(new Date(comment.createdAt).getTime())
  )
    throw new Error('replySourceIdentityInvalid');
  return {
    author: comment.author,
    time: new Date(comment.createdAt).toISOString(),
    comment: comment.content,
    platform: work.platform,
    account: work.actorName,
    conversation: `${work.platform}:${work.workId}:${comment.rootCommentId}`,
    parent: parentText,
    key: comment.key,
  };
}

export const baseId = z.string().regex(/^[a-zA-Z0-9]+$/);
export const tableId = z.string().regex(/^tbl[a-zA-Z0-9]+$/);
export const recordId = z.string().regex(/^rec[a-zA-Z0-9]+$/);
const fieldId = z.string().regex(/^fld[a-zA-Z0-9]+$/);
const fieldsResponse = z.object({ fields: z.array(z.object({ id: fieldId, name: z.string(), type: z.string() })) });
const matrixResponse = z.object({
  field_id_list: z.array(fieldId),
  field_type_list: z.array(z.string()),
  record_id_list: z.array(recordId),
  data: z.array(z.array(z.unknown())),
  rev: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative().optional(),
});

/** Avoid including response values in schema errors, which may contain credentials. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('replyInvalidResponse');
  return result.data;
}

/** Validate the persisted mapping before it can become a CLI write target. */
export function validateTable(table: ReplyTable): void {
  parse(baseId, table.baseToken);
  parse(tableId, table.tableId);
  const ids = REPLY_FIELDS.map(({ key }) => parse(fieldId, table.fields[key]));
  if (table.presentation) {
    ids.push(parse(fieldId, table.presentation.buttonFieldId), parse(fieldId, table.presentation.approvalTextFieldId));
    if (table.presentation.timeDisplayFieldId) ids.push(parse(fieldId, table.presentation.timeDisplayFieldId));
    if (table.presentation.commentLinkFieldId) ids.push(parse(fieldId, table.presentation.commentLinkFieldId));
    if (table.presentation.replyCaptureVersion !== undefined)
      parse(z.literal(1), table.presentation.replyCaptureVersion);
    if (table.presentation.sendMode !== undefined) parse(z.literal('toolbar'), table.presentation.sendMode);
    if (table.presentation.statusFieldType !== undefined)
      parse(z.literal('select'), table.presentation.statusFieldType);
    parse(z.string().min(1).max(200), table.presentation.workflowId);
    parse(z.string().regex(/^vew[a-zA-Z0-9]+$/), table.presentation.viewId);
  }
  if (new Set(ids).size !== ids.length) throw new Error('replyFieldSchemaInvalid');
}

/** Resolve names once at setup; subsequent reads and writes use stable field IDs. */
export function bindFields(value: unknown): ReplyTable['fields'] {
  const { fields } = parse(fieldsResponse, value);
  const entries = REPLY_FIELDS.map(({ key, name, type }) => {
    const matches = fields.filter((field) => field.name === name);
    if (matches.length !== 1 || matches[0].type !== type) throw new Error('replyFieldSchemaInvalid');
    return [key, matches[0].id];
  });
  return Object.fromEntries(entries) as ReplyTable['fields'];
}

/** Permit renamed or reordered columns, but never replaced IDs or changed types. */
export function inspectFields(table: ReplyTable, value: unknown): void {
  validateTable(table);
  const { fields } = parse(fieldsResponse, value);
  if (new Set(fields.map((field) => field.id)).size !== fields.length) throw new Error('replyFieldSchemaInvalid');
  for (const definition of REPLY_FIELDS) {
    const field = fields.find((item) => item.id === table.fields[definition.key]);
    const type =
      definition.key === 'status' && table.presentation?.statusFieldType === 'select' ? 'select' : definition.type;
    if (!field || field.type !== type) throw new Error('replyFieldSchemaChanged');
  }
  if (table.presentation) {
    const snapshot = fields.find((item) => item.id === table.presentation!.approvalTextFieldId);
    const button = fields.find((item) => item.id === table.presentation!.buttonFieldId);
    if (snapshot?.type !== 'text' || button?.type !== 'button') throw new Error('replyFieldSchemaChanged');
    if (
      table.presentation.commentLinkFieldId &&
      fields.find((item) => item.id === table.presentation!.commentLinkFieldId)?.type !== 'text'
    )
      throw new Error('replyFieldSchemaChanged');
  }
}

export type ReplyRecord = { row: ReplyTableRow; cells: Record<ReplyField, string | boolean> };

/** Decode the CLI's matrix without relying on column order, names, or numeric IDs. */
export function decodeRecords(table: ReplyTable, value: unknown) {
  validateTable(table);
  const data = parse(matrixResponse, value);
  if (
    data.field_id_list.length !== data.field_type_list.length ||
    new Set(data.field_id_list).size !== data.field_id_list.length ||
    data.record_id_list.length !== data.data.length ||
    new Set(data.record_id_list).size !== data.record_id_list.length
  )
    throw new Error('replyRecordIdentityInvalid');
  const columns = REPLY_FIELDS.map((definition) => {
    const index = data.field_id_list.indexOf(table.fields[definition.key]);
    const type =
      definition.key === 'status' && table.presentation?.statusFieldType === 'select' ? 'select' : definition.type;
    if (index < 0 || data.field_type_list[index] !== type) throw new Error('replyFieldSchemaChanged');
    return { key: definition.key, type, index };
  });
  const approvedColumn = table.presentation ? data.field_id_list.indexOf(table.presentation.approvalTextFieldId) : -1;
  if (table.presentation && (approvedColumn < 0 || data.field_type_list[approvedColumn] !== 'text'))
    throw new Error('replyFieldSchemaChanged');
  const linkId = table.presentation?.commentLinkFieldId;
  const linkColumn = linkId ? data.field_id_list.indexOf(linkId) : -1;
  if (linkId && (linkColumn < 0 || data.field_type_list[linkColumn] !== 'text'))
    throw new Error('replyFieldSchemaChanged');
  const records: ReplyRecord[] = data.data.map((values, index) => {
    if (values.length !== data.field_id_list.length) throw new Error('replyRecordIdentityInvalid');
    const cells = Object.fromEntries(
      columns.map(({ key, type, index: column }) => {
        const cell = values[column];
        if (type === 'select') {
          if (cell === null) return [key, ''];
          if (!Array.isArray(cell) || cell.length > 1 || cell.some((item) => typeof item !== 'string' || !item))
            throw new Error('replyFieldValueInvalid');
          return [key, cell[0] ?? ''];
        }
        if (cell !== null && (type === 'checkbox' ? typeof cell !== 'boolean' : typeof cell !== 'string'))
          throw new Error('replyFieldValueInvalid');
        return [key, cell ?? (type === 'checkbox' ? false : '')];
      })
    ) as ReplyRecord['cells'];
    let approvedDraft: string | undefined;
    if (approvedColumn >= 0) {
      const approvedCell = values[approvedColumn];
      if (approvedCell !== null && typeof approvedCell !== 'string') throw new Error('replyFieldValueInvalid');
      approvedDraft = typeof approvedCell === 'string' ? approvedCell : '';
    }
    let commentLink: string | undefined;
    if (linkColumn >= 0) {
      const linkCell = values[linkColumn];
      if (linkCell !== null && typeof linkCell !== 'string') throw new Error('replyFieldValueInvalid');
      commentLink = typeof linkCell === 'string' ? linkCell : '';
    }
    return {
      cells,
      row: {
        recordId: data.record_id_list[index],
        messageKey: cells.key as string,
        draft: cells.draft as string,
        ready: cells.ready as boolean,
        status: cells.status as string,
        result: cells.result as string,
        source: Object.fromEntries(SOURCE_FIELDS.map((key) => [key, cells[key]])) as ReplySource,
        ...(table.presentation ? { approvedDraft } : {}),
        ...(linkId ? { commentLink } : {}),
      },
    };
  });
  return { records, revision: data.rev, hasMore: data.has_more, nextOffset: data.next_offset };
}
