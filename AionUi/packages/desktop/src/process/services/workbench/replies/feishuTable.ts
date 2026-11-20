import { z } from 'zod';
import type {
  ReplyComment,
  ReplyResultState,
  ReplySource,
  ReplyTable,
  ReplyTableRow,
  ReplyWork,
} from '@/common/types/platform/workbenchReply';
import { executeFeishu, type Execute } from '../feishuAuth';
import { normalizeTableUrl } from '../syncJournal';
import { configureReplyPresentation } from './feishuPresentation';
import { commentLinkUrl } from './commentLinks';
import type { ReplyTableAdapter } from './contracts';
import {
  baseId,
  bindFields,
  decodeRecords,
  inspectFields,
  parse,
  recordId,
  REPLY_FIELDS,
  REPLY_RESULT_EXPLANATIONS,
  replySourceValues,
  sameReplySource,
  tableId,
  TOOLBAR_APPROVAL_INTERRUPTED,
  validateTable,
  type ReplyRecord,
} from './feishuSchema';

const response = z.object({ ok: z.literal(true), data: z.unknown() });
const authResponse = z.object({
  appId: z.string().optional(),
  brand: z.string().optional(),
  verified: z.boolean().optional(),
  identities: z
    .object({
      user: z.object({ available: z.boolean(), status: z.string(), scope: z.string().optional() }).optional(),
    })
    .optional(),
});
const REQUIRED_SCOPES = ['base:record:read', 'base:record:create', 'base:record:update', 'base:field:read'];
const RESULT_TEXT: Record<ReplyResultState, string> = {
  waiting: '待处理',
  sending: '发送中',
  sent: '已发送',
  replied: '已回复',
  own: '本人评论',
  attention: '需核对',
};
const PAGE_LIMIT = 200;
const MAX_PAGES = 500;

/** Access the isolated reply table through the local CLI; never mutate the source table. */
export function createReplyTableAdapter(execute: Execute = executeFeishu): ReplyTableAdapter {
  const call = async (args: string[]): Promise<unknown> => {
    let result: unknown;
    try {
      result = await execute(args);
    } catch {
      throw new Error('replyCliFailed');
    }
    return parse(response, result).data;
  };
  // Check per operation so revoked scopes or switched CLI identities cannot remain cached.
  const authorize = async (extra: string[] = []): Promise<void> => {
    let value: unknown;
    try {
      value = await execute(['auth', 'status', '--json']);
    } catch {
      throw new Error('replyCliFailed');
    }
    const auth = parse(authResponse, value);
    const user = auth.identities?.user;
    if (!auth.appId || auth.brand !== 'feishu') throw new Error('replyAuthNotConfigured');
    if (auth.verified === false || !user?.available || !['ready', 'valid', 'needs_refresh'].includes(user.status))
      throw new Error('replyLoginRequired');
    const granted = new Set((user.scope ?? '').split(/\s+/));
    if ([...REQUIRED_SCOPES, ...extra].some((scope) => !granted.has(scope))) throw new Error('replyMissingPermissions');
  };
  const flags = (table: ReplyTable): string[] => {
    validateTable(table);
    return ['--base-token', table.baseToken, '--table-id', table.tableId, '--as', 'user', '--format', 'json'];
  };
  const projection = (table: ReplyTable): string[] => [
    ...REPLY_FIELDS.flatMap(({ key }) => ['--field-id', table.fields[key]]),
    ...(table.presentation ? ['--field-id', table.presentation.approvalTextFieldId] : []),
    ...(table.presentation?.commentLinkFieldId ? ['--field-id', table.presentation.commentLinkFieldId] : []),
  ];
  const getRecord = async (table: ReplyTable, id: string): Promise<ReplyRecord | null> => {
    parse(recordId, id);
    const page = decodeRecords(
      table,
      await call(['base', '+record-get', ...flags(table), ...projection(table), '--record-id', id])
    );
    if (page.hasMore || page.records.length > 1 || (page.records.length === 1 && page.records[0].row.recordId !== id))
      throw new Error('replyRecordIdentityInvalid');
    return page.records[0] ?? null;
  };
  const listRecords = async (table: ReplyTable): Promise<ReplyRecord[]> => {
    const records: ReplyRecord[] = [];
    const ids = new Set<string>();
    let revision: number | undefined;
    let offset = 0;
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const page = decodeRecords(
        table,
        // The next cursor and revision depend on this page; parallel reads can skip changes.
        // eslint-disable-next-line no-await-in-loop
        await call([
          'base',
          '+record-list',
          ...flags(table),
          ...projection(table),
          '--limit',
          String(PAGE_LIMIT),
          '--offset',
          String(offset),
        ])
      );
      if (revision !== undefined && page.revision !== revision) throw new Error('replyTableRevisionChanged');
      revision = page.revision;
      for (const record of page.records) {
        if (ids.has(record.row.recordId)) throw new Error('replyRecordPaginationDuplicate');
        ids.add(record.row.recordId);
        records.push(record);
      }
      if (!page.hasMore) return records;
      const next = page.nextOffset ?? offset + page.records.length;
      if (next <= offset || page.records.length === 0) throw new Error('replyRecordPaginationInvalid');
      offset = next;
    }
    throw new Error('replyRecordPaginationLimit');
  };
  const update = async (
    table: ReplyTable,
    id: string,
    values: Record<string, string | boolean | string[]>
  ): Promise<void> => {
    parse(recordId, id);
    // Explicit record ID is mandatory: record-upsert without it creates a new record.
    await call(['base', '+record-upsert', ...flags(table), '--record-id', id, '--json', JSON.stringify(values)]);
  };
  const recoverRecord = async (
    table: ReplyTable,
    values: ReturnType<typeof replySourceValues>
  ): Promise<string | null> => {
    const matches = (await listRecords(table)).filter((record) => record.row.messageKey === values.key);
    if (matches.length > 1) throw new Error('replyMessageKeyDuplicate');
    if (!matches.length) return null;
    verifySource(matches[0], values);
    return matches[0].row.recordId;
  };
  const getExpectedRecord = async (table: ReplyTable, expected: ReplyTableRow): Promise<ReplyRecord> => {
    const record = await getRecord(table, expected.recordId);
    if (!record) throw new Error('replyRecordMissing');
    if (!expected.messageKey || record.row.messageKey !== expected.messageKey)
      throw new Error('replySourceIdentityChanged');
    if (!sameReplySource(record.row.source, expected.source)) throw new Error('replySourceIdentityChanged');
    return record;
  };
  const verifyUpdatedRecord = async (
    table: ReplyTable,
    expected: ReplyTableRow,
    before: ReplyRecord,
    desired: Partial<ReplyTableRow>
  ): Promise<void> => {
    const changes = Object.entries(desired) as Array<[keyof ReplyTableRow, string | boolean | undefined]>;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Feishu may briefly return pre-write cells; only verification reads are retried.
      // eslint-disable-next-line no-await-in-loop
      const record = await getExpectedRecord(table, expected);
      for (const { key } of REPLY_FIELDS) {
        if (!['draft', 'ready', 'status', 'result'].includes(key) && record.cells[key] !== before.cells[key])
          throw new Error('replySourceIdentityChanged');
      }
      if (changes.every(([key, value]) => record.row[key] === value)) return;
      if (changes.some(([key, value]) => record.row[key] !== value && record.row[key] !== before.row[key]))
        throw new Error('replyResultUnverified');
      if (attempt < 2) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw new Error('replyResultUnverified');
  };

  return {
    async configurePresentation(table, context) {
      await authorize();
      return configureReplyPresentation(execute, table, context);
    },
    async provision(sourceUrl, tableName) {
      const url = new URL(normalizeTableUrl(sourceUrl));
      const path = /^\/(base|wiki)\/([a-zA-Z0-9]+)\/?$/.exec(url.pathname);
      if (!path || !tableName.trim() || tableName.length > 100) throw new Error('replyTableSetupInvalid');
      const sourceTable = parse(tableId, url.searchParams.get('table'));
      let base = parse(baseId, path[2]);
      await authorize(['base:table:read', ...(path[1] === 'wiki' ? ['wiki:node:read'] : [])]);
      if (path[1] === 'wiki') {
        const node = parse(
          z.object({ node: z.object({ obj_type: z.literal('bitable'), obj_token: baseId }) }),
          await call(['wiki', 'spaces', 'get_node', '--token', base, '--as', 'user', '--format', 'json'])
        );
        base = node.node.obj_token;
      }
      const baseFlags = ['--base-token', base, '--as', 'user', '--format', 'json'];
      const tables = parse(
        z.object({ tables: z.array(z.object({ id: tableId, name: z.string() })) }),
        await call(['base', '+table-list', ...baseFlags])
      );
      const matches = tables.tables.filter((item) => item.name === tableName);
      if (matches.length > 1 || matches.some((item) => item.id === sourceTable))
        throw new Error('replyTableSetupAmbiguous');
      let id = matches[0]?.id;
      if (!id) {
        await authorize(['base:table:create']);
        const created = parse(
          z.object({ table: z.object({ id: tableId }) }),
          await call([
            'base',
            '+table-create',
            ...baseFlags,
            '--name',
            tableName,
            '--fields',
            JSON.stringify(REPLY_FIELDS.map(({ name, type }) => ({ name, type }))),
          ])
        );
        id = created.table.id;
      }
      if (id === sourceTable) throw new Error('replyTableSetupAmbiguous');
      const fields = bindFields(await call(['base', '+field-list', ...baseFlags, '--table-id', id]));
      const table: ReplyTable = { baseToken: base, tableId: id, url: `${url.origin}/base/${base}?table=${id}`, fields };
      validateTable(table);
      return table;
    },
    async inspect(table) {
      await authorize();
      inspectFields(table, await call(['base', '+field-list', ...flags(table)]));
    },
    async list(table) {
      await authorize();
      return (await listRecords(table)).map((record) => record.row);
    },
    async get(table, id) {
      await authorize();
      return (await getRecord(table, id))?.row ?? null;
    },
    async create(table, work, comment, parentText, source) {
      await authorize();
      const values = frozenSourceValues(work, comment, parentText, source);
      const existing = await recoverRecord(table, values);
      if (existing) return existing;
      const cells = { ...values, draft: '', ready: false, status: RESULT_TEXT.waiting, result: '' };
      const payload = Object.fromEntries(
        REPLY_FIELDS.map(({ key }) => [
          table.fields[key],
          key === 'status' ? encodeStatus(table, cells.status) : cells[key],
        ])
      );
      const linkId = table.presentation?.commentLinkFieldId;
      const link = linkId ? commentLinkCell(work, comment) : undefined;
      if (linkId && link) payload[linkId] = link;
      const created = parse(
        z.object({ record_id_list: z.array(recordId).length(1) }),
        await call([
          'base',
          '+record-batch-create',
          ...flags(table),
          '--json',
          JSON.stringify({ create_records: [payload] }),
        ])
      );
      const id = created.record_id_list[0];
      const record = await getRecord(table, id);
      if (!record) throw new Error('replyCreateUnverified');
      verifySource(record, values);
      if (linkId && record.row.commentLink !== link) throw new Error('replyCreateUnverified');
      return id;
    },
    async recover(table, work, comment, parentText, source) {
      await authorize();
      return recoverRecord(table, frozenSourceValues(work, comment, parentText, source));
    },
    async writeObservedReply(table, expected, text, result, state) {
      await authorize();
      const before = await getExpectedRecord(table, expected);
      const status = RESULT_TEXT[state];
      if (!status || !text.trim()) throw new Error('replyResultStateInvalid');
      await update(table, expected.recordId, {
        [table.fields.draft]: text,
        [table.fields.ready]: false,
        [table.fields.status]: encodeStatus(table, status),
        [table.fields.result]: result,
        ...(table.presentation ? { [table.presentation.approvalTextFieldId]: '' } : {}),
      });
      await verifyUpdatedRecord(table, expected, before, {
        draft: text,
        ready: false,
        status,
        result,
        ...(table.presentation ? { approvedDraft: '' } : {}),
      });
    },
    async markOwnComment(table, expected) {
      await authorize();
      const before = await getExpectedRecord(table, expected);
      await update(table, expected.recordId, {
        [table.fields.ready]: false,
        [table.fields.status]: encodeStatus(table, RESULT_TEXT.own),
        ...(table.presentation ? { [table.presentation.approvalTextFieldId]: '' } : {}),
      });
      await verifyUpdatedRecord(table, expected, before, {
        draft: before.row.draft,
        ready: false,
        status: RESULT_TEXT.own,
        ...(table.presentation ? { approvedDraft: '' } : {}),
      });
    },
    async writeCommentLink(table, expected, work, comment) {
      const linkId = table.presentation?.commentLinkFieldId;
      if (!linkId) return;
      await authorize();
      const before = await getExpectedRecord(table, expected);
      const values = frozenSourceValues(work, comment, before.cells.parent as string, expected.source);
      verifySource(before, values);
      const link = commentLinkCell(work, comment);
      if (before.row.commentLink === link) return;
      await update(table, expected.recordId, { [linkId]: link });
      await verifyUpdatedRecord(table, expected, before, { commentLink: link });
    },
    async claimDraft(table, expected) {
      if (
        table.presentation?.sendMode !== 'toolbar' ||
        !expected.messageKey ||
        !expected.draft.trim() ||
        !sameReplySource(expected.source, expected.source)
      )
        return false;
      await authorize();
      const before = await getRecord(table, expected.recordId);
      if (
        !before ||
        !sameDraft(before.row, expected) ||
        !sameReplySource(before.row.source, expected.source) ||
        before.row.ready !== expected.ready ||
        before.row.status !== expected.status ||
        before.row.result !== expected.result
      )
        return false;
      await update(table, expected.recordId, {
        [table.fields.ready]: false,
        [table.presentation.approvalTextFieldId]: expected.draft,
        [table.fields.status]: encodeStatus(table, RESULT_TEXT.sending),
      });
      await verifyUpdatedRecord(table, expected, before, {
        draft: expected.draft,
        ready: false,
        approvedDraft: expected.draft,
        status: RESULT_TEXT.sending,
        result: expected.result,
      });
      return true;
    },
    async consumeApproval(table, expected) {
      if (!expected.ready || (!table.presentation && !expected.draft.trim()) || !expected.messageKey) return false;
      await authorize();
      const before = (await getRecord(table, expected.recordId))?.row;
      if (!before?.ready || !sameDraft(before, expected) || !sameReplySource(before.source, expected.source))
        return false;
      await update(table, expected.recordId, {
        [table.fields.ready]: false,
        [table.fields.status]: encodeStatus(table, RESULT_TEXT.sending),
      });
      const after = (await getRecord(table, expected.recordId))?.row;
      return Boolean(
        after &&
        !after.ready &&
        after.status === RESULT_TEXT.sending &&
        sameDraft(after, expected) &&
        sameReplySource(after.source, expected.source)
      );
    },
    async writeResult(table, id, state, result, source) {
      await authorize();
      const shortFailures: Record<string, string> = {
        replyApprovalInterrupted: '未发送：请重新点击发送',
        replyVerificationRequired: '需验证',
        replyAccountMismatch: '未发送：账号不一致',
        replyDraftPresent: '未发送：浏览器有草稿',
        replyTargetUnavailable: '未发送：评论不可用',
        replyThreadIncomplete: '未发送：回复未完全加载',
        replyBrowserUnavailable: '未发送：浏览器不可用',
        replyDraftChanged: '未发送：回复已修改',
        replyDraftEmpty: '未发送：请填写回复',
        replyPaused: '未发送：任务已暂停',
      };
      const status =
        table.presentation && state === 'attention'
          ? table.presentation.statusFieldType === 'select'
            ? result === 'replyVerificationRequired'
              ? '需验证'
              : Object.hasOwn(shortFailures, result)
                ? '未发送'
                : RESULT_TEXT.attention
            : (shortFailures[result] ?? RESULT_TEXT.attention)
          : RESULT_TEXT[state];
      if (!status) throw new Error('replyResultStateInvalid');
      const explanation =
        table.presentation?.sendMode === 'toolbar' && result === 'replyApprovalInterrupted'
          ? TOOLBAR_APPROVAL_INTERRUPTED
          : Object.hasOwn(REPLY_RESULT_EXPLANATIONS, result)
            ? REPLY_RESULT_EXPLANATIONS[result]
            : result;
      const before = await getRecord(table, id);
      if (!before) throw new Error('replyRecordMissing');
      if (source && !sameReplySource(before.row.source, source)) throw new Error('replySourceIdentityChanged');
      await update(table, id, {
        [table.fields.status]: encodeStatus(table, status),
        [table.fields.result]: explanation,
      });
      const record = await getRecord(table, id);
      if (!record || record.row.status !== status || record.row.result !== explanation)
        throw new Error('replyResultUnverified');
      if (source && !sameReplySource(record.row.source, source)) throw new Error('replySourceIdentityChanged');
    },
  };
}

function commentLinkCell(work: ReplyWork, comment: ReplyComment): string {
  return `[查看评论](${commentLinkUrl(work, comment)})`;
}

function encodeStatus(table: ReplyTable, status: string): string | string[] {
  return table.presentation?.statusFieldType === 'select' ? [status] : status;
}

function sameDraft(actual: ReplyTableRow, expected: ReplyTableRow): boolean {
  return (
    actual.recordId === expected.recordId &&
    actual.messageKey === expected.messageKey &&
    actual.draft === expected.draft &&
    actual.approvedDraft === expected.approvedDraft
  );
}

function frozenSourceValues(
  work: ReplyWork,
  comment: ReplyComment,
  parentText: string,
  source?: ReplySource
): ReplySource {
  const current = replySourceValues(work, comment, source?.parent ?? parentText);
  if (!source) return current;
  if (
    !sameReplySource(source, source) ||
    (['author', 'time', 'comment', 'platform', 'conversation', 'key'] as const).some(
      (field) => source[field] !== current[field]
    )
  )
    throw new Error('replySourceIdentityChanged');
  return source;
}

function verifySource(record: ReplyRecord, expected: ReturnType<typeof replySourceValues>): void {
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (record.cells[key] !== expected[key]) throw new Error('replySourceIdentityChanged');
  }
}
