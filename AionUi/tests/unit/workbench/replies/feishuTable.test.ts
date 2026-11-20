import { describe, expect, it, vi } from 'vitest';
import { createReplyTableAdapter } from '@/process/services/workbench/replies/feishuTable';
import {
  isRetryableReplyResult,
  replySourceValues,
  sameReplySource,
} from '@/process/services/workbench/replies/feishuSchema';
import type {
  ReplyComment,
  ReplyField,
  ReplySource,
  ReplyTable,
  ReplyWork,
} from '@/common/types/platform/workbenchReply';

const definitions: Array<[ReplyField, string, string]> = [
  ['author', '用户', 'text'],
  ['time', '时间', 'text'],
  ['comment', '评论', 'text'],
  ['draft', '回复内容', 'text'],
  ['ready', '可发送', 'checkbox'],
  ['status', '发送状态', 'text'],
  ['result', '发送结果', 'text'],
  ['platform', '平台', 'text'],
  ['account', '账号', 'text'],
  ['conversation', '对话编号', 'text'],
  ['parent', '回复对象', 'text'],
  ['key', '消息键', 'text'],
];
const fields = Object.fromEntries(definitions.map(([key]) => [key, `fld${key}`])) as ReplyTable['fields'];
const table: ReplyTable = {
  baseToken: 'baseExample',
  tableId: 'tblReply',
  url: 'https://example.feishu.cn/base/baseExample?table=tblReply',
  fields,
};
const schema = definitions.map(([key, name, type]) => ({ id: fields[key], name, type }));
const work: ReplyWork = {
  key: 'douyin:slot:1632121715433368:7630823226675650277',
  platform: 'douyin',
  accountId: 'slot',
  actorId: '1632121715433368',
  actorName: 'Test',
  workId: '7630823226675650277',
  title: 'Work',
  url: 'https://www.douyin.com/note/7630823226675650277',
};
const comment: ReplyComment = {
  key: 'douyin:slot:1632121715433368:7630823226675650277:7707903681722893094',
  workKey: work.key,
  platform: 'douyin',
  accountId: 'slot',
  actorId: work.actorId,
  workId: work.workId,
  commentId: '7707903681722893094',
  rootCommentId: '7707903681722893094',
  parentCommentId: null,
  authorId: 'author',
  author: 'Reader',
  content: 'Question',
  createdAt: 1794636362000,
};
const ok = (data: unknown) => ({ ok: true, data });
const auth = {
  appId: 'app',
  brand: 'feishu',
  verified: true,
  identities: {
    user: {
      available: true,
      status: 'ready',
      scope:
        'base:record:read base:record:create base:record:update base:field:read wiki:node:read base:table:read base:table:create',
    },
  },
};
function cells(overrides: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(schema.map((f) => [f.id, f.type === 'checkbox' ? false : ''])),
    [fields.key]: comment.key,
    [fields.draft]: 'Approved draft',
    [fields.ready]: true,
    ...overrides,
  };
}
function sourceCells() {
  return cells({
    [fields.author]: comment.author,
    [fields.time]: new Date(comment.createdAt).toISOString(),
    [fields.comment]: comment.content,
    [fields.platform]: work.platform,
    [fields.account]: work.actorName,
    [fields.conversation]: `${work.platform}:${work.workId}:${comment.rootCommentId}`,
    [fields.parent]: '',
  });
}
function matrix(rows: Array<{ id: string; cells: Record<string, unknown> }>, order = schema, rev = 1, extra = {}) {
  return {
    fields: order.map((f) => f.name),
    field_id_list: order.map((f) => f.id),
    field_type_list: order.map((f) => f.type),
    record_id_list: rows.map((r) => r.id),
    data: rows.map((r) => order.map((f) => r.cells[f.id])),
    rev,
    has_more: false,
    ...extra,
  };
}
function harness(initial = [{ id: 'recOne', cells: cells() }]) {
  const state = {
    rows: initial,
    schema,
    tables: [{ id: 'tblLegacy', name: 'Old three columns' }],
    auth,
    revision: 1,
    writeIgnored: false,
  };
  const execute = vi.fn(async (args: string[]) => {
    if (args[0] === 'auth') return state.auth;
    const command = args[1];
    if (command === 'spaces') return ok({ node: { obj_type: 'bitable', obj_token: 'baseExample' } });
    if (command === '+field-list') return ok({ fields: state.schema });
    if (command === '+table-list') return ok({ tables: state.tables });
    if (command === '+table-create') return ok({ table: { id: 'tblReply' } });
    if (command === '+record-list') return ok(matrix(state.rows, state.schema.toReversed(), state.revision));
    if (command === '+record-get')
      return ok(
        matrix(
          state.rows.filter((r) => r.id === args[args.indexOf('--record-id') + 1]),
          state.schema,
          state.revision
        )
      );
    if (command === '+record-batch-create') {
      const payload = JSON.parse(args[args.indexOf('--json') + 1]) as { create_records: Record<string, unknown>[] };
      state.rows.push({
        id: 'recCreated',
        cells: {
          ...(state.schema.some((f) => f.id === 'fldApproval') ? { fldApproval: null } : {}),
          ...payload.create_records[0],
        },
      });
      return ok({ record_id_list: ['recCreated'], rev: ++state.revision });
    }
    if (command === '+record-upsert') {
      const record = state.rows.find((r) => r.id === args[args.indexOf('--record-id') + 1]);
      if (record && !state.writeIgnored) Object.assign(record.cells, JSON.parse(args[args.indexOf('--json') + 1]));
      return ok({ updated: true });
    }
    throw new Error(`Unexpected command ${command}`);
  });
  return { state, execute, adapter: createReplyTableAdapter(execute) };
}
const writes = (execute: ReturnType<typeof harness>['execute']) =>
  execute.mock.calls.filter(([args]) => ['+record-upsert', '+record-batch-create', '+table-create'].includes(args[1]));

const selectTable = {
  ...table,
  presentation: {
    buttonFieldId: 'fldButton',
    approvalTextFieldId: 'fldApproval',
    workflowId: 'workflowReply',
    viewId: 'vewReply',
    statusFieldType: 'select',
  },
} as ReplyTable;
function selectHarness(
  initial = [{ id: 'recOne', cells: cells({ [fields.status]: [], fldApproval: 'Approved draft' }) }]
) {
  const h = harness(initial);
  h.state.schema = [
    ...schema.map((field) => (field.id === fields.status ? { ...field, type: 'select' } : field)),
    { id: 'fldButton', name: '发送', type: 'button' },
    { id: 'fldApproval', name: '本次待发内容', type: 'text' },
  ];
  return h;
}

describe('single select status encoding', () => {
  it('inspects a select status only when the persisted flag requests it', async () => {
    const h = selectHarness();
    await expect(h.adapter.inspect(selectTable)).resolves.toBeUndefined();
    await expect(h.adapter.inspect(table)).rejects.toThrow('replyFieldSchemaChanged');
    h.state.schema = h.state.schema.map((f) => (f.id === fields.comment ? { ...f, type: 'select' } : f));
    await expect(h.adapter.inspect(selectTable)).rejects.toThrow('replyFieldSchemaChanged');
  });
  it('decodes empty and single select values and rejects malformed or multiple values', async () => {
    const h = selectHarness();
    expect((await h.adapter.list(selectTable))[0].status).toBe('');
    h.state.rows[0].cells[fields.status] = null;
    expect((await h.adapter.list(selectTable))[0].status).toBe('');
    h.state.rows[0].cells[fields.status] = ['待发送'];
    expect((await h.adapter.list(selectTable))[0].status).toBe('待发送');
  });
  it.each([
    { invalid: 42 },
    { invalid: { name: '待发送' } },
    { invalid: '待发送' },
    { invalid: [1] },
    { invalid: ['待发送', '已发送'] },
    { invalid: [''] },
  ])('rejects malformed select value $invalid', async ({ invalid }) => {
    const h = selectHarness();
    h.state.rows[0].cells[fields.status] = invalid;
    await expect(h.adapter.list(selectTable)).rejects.toThrow('replyFieldValueInvalid');
  });
  it('creates and consumes approvals with array status while retaining the approved snapshot', async () => {
    const h = selectHarness([]);
    expect(await h.adapter.create(selectTable, work, comment, '')).toBe('recCreated');
    expect(h.state.rows[0].cells[fields.status]).toEqual(['待处理']);
    Object.assign(h.state.rows[0].cells, {
      [fields.ready]: true,
      [fields.draft]: 'Approved draft',
      fldApproval: 'Approved draft',
    });
    const row = (await h.adapter.list(selectTable))[0];
    expect(await h.adapter.consumeApproval(selectTable, row)).toBe(true);
    expect(h.state.rows[0].cells).toMatchObject({
      [fields.ready]: false,
      [fields.status]: ['发送中'],
      fldApproval: 'Approved draft',
    });
  });
  it('refuses to consume approval if the saved snapshot changes during the write', async () => {
    const h = selectHarness();
    const expected = (await h.adapter.list(selectTable))[0];
    const original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (args) => {
      const result = await original(args);
      if (args[1] === '+record-upsert') h.state.rows[0].cells.fldApproval = 'Changed';
      return result;
    });
    expect(await h.adapter.consumeApproval(selectTable, expected)).toBe(false);
  });
  it('rejects unsupported persisted status encoding before reading records', async () => {
    const h = selectHarness();
    const invalid = {
      ...selectTable,
      presentation: { ...selectTable.presentation!, statusFieldType: 'checkbox' },
    } as unknown as ReplyTable;
    await expect(h.adapter.list(invalid)).rejects.toThrow('replyInvalidResponse');
  });
  it.each([
    ['replyAccountMismatch', '未发送', '当前登录账号与作品账号不一致，请检查后重新发送'],
    ['replyVerificationRequired', '需验证', '请在对应平台完成验证，再点击发送'],
    ['replySendUncertain', '需核对', '发送结果待核对，请勿重复发送'],
  ])('writes compact select status and detailed result for %s', async (code, status, result) => {
    const h = selectHarness();
    await h.adapter.writeResult(selectTable, 'recOne', 'attention', code);
    expect(h.state.rows[0].cells).toMatchObject({ [fields.status]: [status], [fields.result]: result });
  });
});

describe('reply table record identity', () => {
  it('decodes button approval snapshots and reads the hidden field explicitly', async () => {
    const configured: ReplyTable = {
      ...table,
      presentation: {
        buttonFieldId: 'fldButton',
        approvalTextFieldId: 'fldApproval',
        workflowId: 'workflowReply',
        viewId: 'vewReply',
      },
    };
    const h = harness([{ id: 'recOne', cells: cells({ fldApproval: 'Approved draft' }) }]);
    h.state.schema = [
      ...schema,
      { id: 'fldButton', name: '发送', type: 'button' },
      { id: 'fldApproval', name: '本次待发内容', type: 'text' },
    ];
    expect((await h.adapter.list(configured))[0].approvedDraft).toBe('Approved draft');
    expect(h.execute.mock.calls.find(([args]) => args[1] === '+record-list')?.[0]).toContain('fldApproval');
  });
  it('shows readable button failure states without displaying internal error codes', async () => {
    const configured: ReplyTable = {
      ...table,
      presentation: {
        buttonFieldId: 'fldButton',
        approvalTextFieldId: 'fldApproval',
        workflowId: 'workflowReply',
        viewId: 'vewReply',
      },
    };
    const h = harness([{ id: 'recOne', cells: cells({ fldApproval: 'Approved draft' }) }]);
    h.state.schema = [
      ...schema,
      { id: 'fldButton', name: '发送', type: 'button' },
      { id: 'fldApproval', name: '本次待发内容', type: 'text' },
    ];
    await h.adapter.writeResult(configured, 'recOne', 'attention', 'replyVerificationRequired');
    expect(h.state.rows[0].cells).toMatchObject({
      [fields.status]: '需验证',
      [fields.result]: '请在对应平台完成验证，再点击发送',
    });
  });
  it('can clear an emptied button draft without changing its visible text or snapshot', async () => {
    const configured: ReplyTable = {
      ...table,
      presentation: {
        buttonFieldId: 'fldButton',
        approvalTextFieldId: 'fldApproval',
        workflowId: 'workflowReply',
        viewId: 'vewReply',
      },
    };
    const h = harness([{ id: 'recOne', cells: cells({ [fields.draft]: '', fldApproval: 'Approved draft' }) }]);
    h.state.schema = [
      ...schema,
      { id: 'fldButton', name: '发送', type: 'button' },
      { id: 'fldApproval', name: '本次待发内容', type: 'text' },
    ];
    expect(await h.adapter.consumeApproval(configured, (await h.adapter.list(configured))[0])).toBe(true);
    expect(h.state.rows[0].cells).toMatchObject({
      [fields.ready]: false,
      [fields.draft]: '',
      fldApproval: 'Approved draft',
    });
  });
  it('rejects a missing button snapshot column instead of treating it as approved', async () => {
    const configured: ReplyTable = {
      ...table,
      presentation: {
        buttonFieldId: 'fldButton',
        approvalTextFieldId: 'fldApproval',
        workflowId: 'workflowReply',
        viewId: 'vewReply',
      },
    };
    await expect(harness().adapter.list(configured)).rejects.toThrow('replyFieldSchemaChanged');
  });
  it('updates sending status in the same write that consumes approval', async () => {
    const h = harness();
    const row = (await h.adapter.list(table))[0];
    await h.adapter.consumeApproval(table, row);
    expect(h.state.rows[0].cells).toMatchObject({ [fields.ready]: false, [fields.status]: '发送中' });
    expect(writes(h.execute)).toHaveLength(1);
  });
  it('rejects approval consumption if the sending status was not applied', async () => {
    const h = harness();
    const base = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (args) => {
      const result = await base(args);
      if (args[1] === '+record-upsert') h.state.rows[0].cells[fields.status] = '待处理';
      return result;
    });
    expect(await h.adapter.consumeApproval(table, (await h.adapter.list(table))[0])).toBe(false);
  });

  it('maps shuffled columns by field ID and aligns each row to its record ID', async () => {
    const { adapter } = harness();
    expect(await adapter.list(table)).toEqual([
      {
        recordId: 'recOne',
        messageKey: comment.key,
        draft: 'Approved draft',
        ready: true,
        status: '',
        result: '',
        source: {
          author: '',
          time: '',
          comment: '',
          platform: '',
          account: '',
          conversation: '',
          parent: '',
          key: comment.key,
        },
      },
    ]);
  });
  it('rejects record ID/data length mismatch instead of guessing identities', async () => {
    const h = harness();
    h.execute.mockImplementation(async (args) =>
      args[0] === 'auth' ? auth : ok({ ...matrix(h.state.rows), record_id_list: [] })
    );
    await expect(h.adapter.list(table)).rejects.toThrow();
  });
  it('rejects non-boolean approval values', async () => {
    const h = harness([{ id: 'recOne', cells: cells({ [fields.ready]: 'true' }) }]);
    await expect(h.adapter.list(table)).rejects.toThrow();
  });
  it('returns null when a specifically requested record was deleted', async () => {
    expect(await harness([]).adapter.get(table, 'recMissing')).toBeNull();
  });
  it('rejects a different record returned for a requested ID', async () => {
    const h = harness();
    h.execute.mockImplementation(async (args) => (args[0] === 'auth' ? auth : ok(matrix(h.state.rows))));
    await expect(h.adapter.get(table, 'recOther')).rejects.toThrow();
  });
  it('reads every page, preserving one stable table revision', async () => {
    const h = harness();
    h.execute.mockImplementation(async (args) => {
      if (args[0] === 'auth') return auth;
      const offset = Number(args[args.indexOf('--offset') + 1]);
      return ok(
        matrix(
          [{ id: offset ? 'recTwo' : 'recOne', cells: cells() }],
          schema,
          7,
          offset ? {} : { has_more: true, next_offset: 1 }
        )
      );
    });
    expect((await h.adapter.list(table)).map((r) => r.recordId)).toEqual(['recOne', 'recTwo']);
  });
  it('fails a scan if table revision changes between pages', async () => {
    const h = harness();
    h.execute.mockImplementation(async (args) => {
      if (args[0] === 'auth') return auth;
      const offset = Number(args[args.indexOf('--offset') + 1]);
      return ok(
        matrix(
          [{ id: offset ? 'recTwo' : 'recOne', cells: cells() }],
          schema,
          offset + 1,
          offset ? {} : { has_more: true, next_offset: 1 }
        )
      );
    });
    await expect(h.adapter.list(table)).rejects.toThrow(/changed|revision/i);
  });
  it('rejects a stuck cursor rather than silently skipping records', async () => {
    const h = harness();
    h.execute.mockImplementation(async (args) =>
      args[0] === 'auth' ? auth : ok(matrix(h.state.rows, schema, 1, { has_more: true, next_offset: 0 }))
    );
    await expect(h.adapter.list(table)).rejects.toThrow(/pagination|cursor/i);
  });
  it('rejects records repeated across pages', async () => {
    const h = harness();
    h.execute.mockImplementation(async (args) =>
      args[0] === 'auth' ? auth : ok(matrix(h.state.rows, schema, 1, { has_more: true }))
    );
    await expect(h.adapter.list(table)).rejects.toThrow(/pagination/i);
  });
  it('stops unbounded pagination without returning a partial list', async () => {
    const h = harness();
    h.execute.mockImplementation(async (args) => {
      if (args[0] === 'auth') return auth;
      const offset = Number(args[args.indexOf('--offset') + 1]);
      return ok(matrix([{ id: `recPage${offset}`, cells: cells() }], schema, 1, { has_more: true }));
    });
    await expect(h.adapter.list(table)).rejects.toThrow(/pagination/i);
    expect(h.execute).toHaveBeenCalledTimes(501);
  });
  it('handles null empty text and checkbox values without approving them', async () => {
    const h = harness([{ id: 'recOne', cells: cells({ [fields.ready]: null, [fields.draft]: null }) }]);
    expect((await h.adapter.list(table))[0]).toMatchObject({ draft: '', ready: false });
  });
  it('rejects replacement field IDs even if display names stay unchanged', async () => {
    const h = harness();
    h.state.schema = schema.map((f) => (f.id === fields.ready ? { ...f, id: 'fldReplacement' } : f));
    await expect(h.adapter.list(table)).rejects.toThrow(/field/i);
  });
  it('projects only mapped columns when reading tables with extra user fields', async () => {
    const h = harness();
    await h.adapter.list(table);
    const args = h.execute.mock.calls.find(([callArgs]) => callArgs[1] === '+record-list')![0];
    expect(args.filter((arg, index) => args[index - 1] === '--field-id')).toEqual(Object.values(fields));
  });
});

describe('checked approval and result updates', () => {
  it('consumes the checked flag and shows sending, preserving the exact draft', async () => {
    const h = harness();
    const expected = (await h.adapter.list(table))[0];
    expect(await h.adapter.consumeApproval(table, expected)).toBe(true);
    expect(JSON.parse(writes(h.execute)[0][0][writes(h.execute)[0][0].indexOf('--json') + 1])).toEqual({
      [fields.ready]: false,
      [fields.status]: '发送中',
    });
    expect(h.state.rows[0].cells[fields.draft]).toBe(expected.draft);
  });
  it('does not consume approval after a draft was edited', async () => {
    const h = harness();
    const expected = (await h.adapter.list(table))[0];
    h.state.rows[0].cells[fields.draft] = 'Changed';
    expect(await h.adapter.consumeApproval(table, expected)).toBe(false);
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('does not consume an unchecked or blank draft', async () => {
    const h = harness([{ id: 'recOne', cells: cells({ [fields.draft]: '   ' }) }]);
    expect(await h.adapter.consumeApproval(table, (await h.adapter.list(table))[0])).toBe(false);
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('refuses to report consumed when the server did not apply the checkbox update', async () => {
    const h = harness();
    const expected = (await h.adapter.list(table))[0];
    h.state.writeIgnored = true;
    expect(await h.adapter.consumeApproval(table, expected)).toBe(false);
  });
  it('does not approve a draft changed while the checkbox write was in flight', async () => {
    const h = harness();
    const expected = (await h.adapter.list(table))[0];
    const original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (args) => {
      const result = await original(args);
      if (args[1] === '+record-upsert') h.state.rows[0].cells[fields.draft] = 'Edited during request';
      return result;
    });
    expect(await h.adapter.consumeApproval(table, expected)).toBe(false);
  });
  it('writes only system result fields and confirms them by readback', async () => {
    const h = harness();
    await h.adapter.writeResult(table, 'recOne', 'sent', 'Reply recorded');
    const args = writes(h.execute)[0][0];
    expect(JSON.parse(args[args.indexOf('--json') + 1])).toEqual({
      [fields.status]: '已发送',
      [fields.result]: 'Reply recorded',
    });
    expect(h.state.rows[0].cells[fields.ready]).toBe(true);
  });
  it.each([
    ['replyApprovalInterrupted', '尚未发送，请检查回复内容后重新勾选可发送'],
    ['replySendUncertain', '发送结果待核对，请勿重复发送'],
  ])('writes a readable explanation for %s and verifies the translated value', async (code, explanation) => {
    const h = harness();
    await h.adapter.writeResult(table, 'recOne', 'attention', code);
    expect(h.state.rows[0].cells[fields.result]).toBe(explanation);
  });
  it('does not treat a successful update response as confirmation', async () => {
    const h = harness();
    h.state.writeIgnored = true;
    await expect(h.adapter.writeResult(table, 'recOne', 'sent', 'Reply recorded')).rejects.toThrow();
  });
  it('does not write result fields when the record was deleted', async () => {
    const h = harness([]);
    await expect(h.adapter.writeResult(table, 'recOne', 'sent', 'Reply recorded')).rejects.toThrow();
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('does not write result fields after the bound schema changed', async () => {
    const h = harness();
    h.state.schema = schema.filter((f) => f.id !== fields.status);
    await expect(h.adapter.writeResult(table, 'recOne', 'sent', 'Reply recorded')).rejects.toThrow(/field/i);
    expect(writes(h.execute)).toHaveLength(0);
  });
});

describe('separate reply table provisioning and recovery', () => {
  it('creates a sibling table without editing or deleting the legacy table', async () => {
    const h = harness();
    const provisioned = await h.adapter.provision(
      'https://example.feishu.cn/wiki/wikiExample?table=tblLegacy',
      'Reply-unique-1'
    );
    expect(provisioned.tableId).toBe('tblReply');
    expect(writes(h.execute).map(([a]) => a[1])).toEqual(['+table-create']);
    expect(h.execute.mock.calls.flatMap(([a]) => a)).not.toContain('+field-update');
  });
  it('recovers an uncertain table creation by the persisted unique name', async () => {
    const h = harness();
    h.state.tables.push({ id: 'tblReply', name: 'Reply-unique-1' });
    expect(
      (await h.adapter.provision('https://example.feishu.cn/base/baseExample?table=tblLegacy', 'Reply-unique-1'))
        .tableId
    ).toBe('tblReply');
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('does not reuse the original source table even if its name matches', async () => {
    const h = harness();
    await expect(
      h.adapter.provision('https://example.feishu.cn/base/baseExample?table=tblLegacy', 'Old three columns')
    ).rejects.toThrow(/ambiguous/i);
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('fails on an old three-column schema without changing it', async () => {
    const h = harness();
    h.state.schema = schema.slice(0, 3);
    await expect(h.adapter.inspect(table)).rejects.toThrow(/schema|field/i);
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('keeps stored field IDs valid even after display names or order change', async () => {
    const h = harness();
    h.state.schema = schema.toReversed().map((f) => ({ id: f.id, type: f.type, name: 'Renamed ' + f.name }));
    await expect(h.adapter.inspect(table)).resolves.toBeUndefined();
  });
  it('saves a returned record ID and verifies the new message without touching old rows', async () => {
    const h = harness([]);
    expect(await h.adapter.create(table, work, comment, '')).toBe('recCreated');
    expect(h.state.rows[0].cells[fields.ready]).toBe(false);
    expect(h.state.rows[0].cells[fields.comment]).toBe(comment.content);
  });
  it('recovers a pre-existing matching message key without creating a duplicate', async () => {
    const h = harness([{ id: 'recOne', cells: sourceCells() }]);
    expect(await h.adapter.create(table, work, comment, '')).toBe('recOne');
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('does not bind a matching editable key to different source content', async () => {
    const h = harness();
    await expect(h.adapter.create(table, work, comment, '')).rejects.toThrow(/identity/i);
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('only reads while recovering an uncertain creation that is still absent', async () => {
    const h = harness([]);
    expect(await h.adapter.recover(table, work, comment, '')).toBeNull();
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('recovers an uncertain creation only when the complete source matches', async () => {
    const h = harness([{ id: 'recOne', cells: sourceCells() }]);
    expect(await h.adapter.recover(table, work, comment, '')).toBe('recOne');
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('leaves an unverified create uncertain after a missing readback', async () => {
    const h = harness([]);
    const original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (args) => (args[1] === '+record-get' ? ok(matrix([])) : original(args)));
    await expect(h.adapter.create(table, work, comment, '')).rejects.toThrow(/unverified/i);
    expect(writes(h.execute)).toHaveLength(1);
  });
  it('fails closed when a message key is duplicated', async () => {
    const h = harness([
      { id: 'recOne', cells: cells() },
      { id: 'recTwo', cells: cells() },
    ]);
    await expect(h.adapter.create(table, work, comment, '')).rejects.toThrow(/duplicate|ambiguous/i);
    expect(writes(h.execute)).toHaveLength(0);
  });
});

describe('reply permissions and sanitized failures', () => {
  it('requires record update permission even if the old export scopes are present', async () => {
    const h = harness();
    h.state.auth = {
      ...auth,
      identities: {
        user: { ...auth.identities.user, scope: auth.identities.user.scope.replace('base:record:update', '') },
      },
    };
    await expect(h.adapter.inspect(table)).rejects.toThrow(/permission/i);
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('does not expose CLI output or credential-looking errors', async () => {
    const h = harness();
    h.execute.mockRejectedValue(new Error('access_token=private'));
    await expect(h.adapter.list(table)).rejects.not.toThrow(/private|access_token/);
  });
  it('checks revoked permissions again before a later write', async () => {
    const h = harness();
    await h.adapter.inspect(table);
    h.state.auth = { ...auth, identities: { user: { ...auth.identities.user, scope: '' } } };
    await expect(h.adapter.writeResult(table, 'recOne', 'sent', 'Done')).rejects.toThrow(/permission/i);
    expect(writes(h.execute)).toHaveLength(0);
  });
  it('sanitizes malformed API responses without including their contents', async () => {
    const h = harness();
    h.execute.mockImplementation(async (args) => (args[0] === 'auth' ? auth : { ok: false, access_token: 'private' }));
    await expect(h.adapter.list(table)).rejects.toThrow('replyInvalidResponse');
  });
});

describe('observed platform replies and comment links', () => {
  it.each([
    ['replied', '已回复'],
    ['sent', '已发送'],
    ['attention', '需核对'],
  ] as const)('replaces the draft and cancels approval for %s with verified reply IDs', async (state, status) => {
    const h = selectHarness();
    const row = (await h.adapter.list(selectTable))[0];
    await h.adapter.writeObservedReply!(selectTable, row, 'Actual platform reply', 'reply-id-1,reply-id-2', state);
    expect(h.state.rows[0].cells).toMatchObject({
      [fields.draft]: 'Actual platform reply',
      [fields.ready]: false,
      [fields.status]: [status],
      [fields.result]: 'reply-id-1,reply-id-2',
      fldApproval: '',
    });
    expect(writes(h.execute)).toHaveLength(1);
  });

  it('preserves an owner row and its draft while removing its approval', async () => {
    const h = selectHarness();
    const row = (await h.adapter.list(selectTable))[0];
    await h.adapter.markOwnComment!(selectTable, row);
    expect(h.state.rows).toHaveLength(1);
    expect(h.state.rows[0].cells).toMatchObject({
      [fields.draft]: 'Approved draft',
      [fields.ready]: false,
      [fields.status]: ['本人评论'],
      fldApproval: '',
    });
  });

  it.each(['observed', 'own'] as const)(
    'does not touch a replaced message identity during %s write',
    async (operation) => {
      const h = selectHarness();
      const row = (await h.adapter.list(selectTable))[0];
      h.state.rows[0].cells[fields.key] = 'foreign';
      await expect(
        operation === 'observed'
          ? h.adapter.writeObservedReply!(selectTable, row, 'Reply', 'reply-id', 'replied')
          : h.adapter.markOwnComment!(selectTable, row)
      ).rejects.toThrow(/identity/i);
      expect(writes(h.execute)).toHaveLength(0);
    }
  );

  it.each(['observed', 'own'] as const)(
    'rejects an unverified %s update and never assumes successful persistence',
    async (operation) => {
      const h = selectHarness();
      const row = (await h.adapter.list(selectTable))[0];
      h.state.writeIgnored = true;
      await expect(
        operation === 'observed'
          ? h.adapter.writeObservedReply!(selectTable, row, 'Reply', 'reply-id', 'replied')
          : h.adapter.markOwnComment!(selectTable, row)
      ).rejects.toThrow(/unverified/i);
    }
  );

  const linkedTable: ReplyTable = {
    ...selectTable,
    presentation: { ...selectTable.presentation!, commentLinkFieldId: 'fldLink', replyCaptureVersion: 1 },
  };
  const linkedHarness = (initial?: Array<{ id: string; cells: Record<string, unknown> }>) => {
    const h = selectHarness(initial);
    h.state.schema.push({ id: 'fldLink', name: '原评论', type: 'text' });
    h.state.rows.forEach((row) => {
      row.cells.fldLink = '';
    });
    return h;
  };
  it('writes the original-comment URL and verifies it without changing raw comment content', async () => {
    const h = linkedHarness([{ id: 'recOne', cells: { ...sourceCells(), [fields.status]: [], fldApproval: '' } }]);
    const row = (await h.adapter.list(linkedTable))[0];
    await h.adapter.writeCommentLink!(linkedTable, row, work, comment);
    const updated = (await h.adapter.list(linkedTable))[0];
    expect(updated.commentLink).toMatch(
      /^\[查看评论\]\(https:\/\/www\.douyin\.com\/note\/7630823226675650277#[^)]+\)$/
    );
    expect(h.state.rows[0].cells[fields.comment]).toBe('Question');
    expect(h.execute.mock.calls.find(([args]) => args[1] === '+record-list')![0]).toContain('fldLink');
  });
  it('creates rows with the link and retains raw source text for recovery', async () => {
    const h = linkedHarness([]);
    await h.adapter.create(linkedTable, work, comment, '');
    expect(h.state.rows[0].cells.fldLink).toMatch(/^\[查看评论\]\(https:/);
    expect(await h.adapter.recover(linkedTable, work, comment, '')).toBe('recCreated');
  });
  it('rejects a replaced link field and malformed link cell', async () => {
    const h = linkedHarness();
    h.state.rows[0].cells.fldLink = { url: 'https://example.com' };
    await expect(h.adapter.list(linkedTable)).rejects.toThrow(/value/i);
    h.state.schema = h.state.schema.filter((field) => field.id !== 'fldLink');
    await expect(h.adapter.inspect(linkedTable)).rejects.toThrow(/schema/i);
  });
  it('rejects a link write when source content changed or the server ignored the write', async () => {
    const h = linkedHarness([{ id: 'recOne', cells: { ...sourceCells(), [fields.status]: [], fldApproval: '' } }]);
    const row = (await h.adapter.list(linkedTable))[0];
    h.state.rows[0].cells[fields.comment] = 'Different';
    await expect(h.adapter.writeCommentLink!(linkedTable, row, work, comment)).rejects.toThrow(/identity/i);
    expect(writes(h.execute)).toHaveLength(0);
    h.state.rows[0].cells[fields.comment] = 'Question';
    h.state.writeIgnored = true;
    await expect(h.adapter.writeCommentLink!(linkedTable, row, work, comment)).rejects.toThrow(/unverified/i);
  });
});

describe('bounded readback for observed replies and links', () => {
  const linkedTable: ReplyTable = {
    ...selectTable,
    presentation: { ...selectTable.presentation!, commentLinkFieldId: 'fldLink', replyCaptureVersion: 1 },
  };
  const fixture = async (operation: 'observed' | 'own' | 'link') => {
    const h = selectHarness([
      {
        id: 'recOne',
        cells: { ...sourceCells(), [fields.status]: ['待发送'], fldApproval: 'Approved draft', fldLink: '' },
      },
    ]);
    h.state.schema.push({ id: 'fldLink', name: '原评论', type: 'text' });
    const row = (await h.adapter.list(linkedTable))[0];
    const run = () =>
      operation === 'observed'
        ? h.adapter.writeObservedReply!(linkedTable, row, 'Actual reply', 'reply-id', 'replied')
        : operation === 'own'
          ? h.adapter.markOwnComment!(linkedTable, row)
          : h.adapter.writeCommentLink!(linkedTable, row, work, comment);
    return { ...h, run };
  };

  it.each(['observed', 'own', 'link'] as const)(
    'accepts %s changes on the third read without repeating the write',
    async (operation) => {
      const h = await fixture(operation);
      const before = structuredClone(h.state.rows);
      const original = h.execute.getMockImplementation()!;
      let written = false;
      let readbacks = 0;
      h.execute.mockImplementation(async (args) => {
        if (args[1] === '+record-get' && written) {
          readbacks++;
          if (readbacks < 3) return ok(matrix(before, h.state.schema));
        }
        const result = await original(args);
        if (args[1] === '+record-upsert') written = true;
        return result;
      });
      await expect(h.run()).resolves.toBeUndefined();
      expect(readbacks).toBe(3);
      expect(writes(h.execute)).toHaveLength(1);
    }
  );

  it.each(['observed', 'own', 'link'] as const)(
    'stops after three stale %s readbacks with exactly one write',
    async (operation) => {
      const h = await fixture(operation);
      h.state.writeIgnored = true;
      const original = h.execute.getMockImplementation()!;
      let written = false;
      let readbacks = 0;
      h.execute.mockImplementation(async (args) => {
        if (args[1] === '+record-get' && written) readbacks++;
        const result = await original(args);
        if (args[1] === '+record-upsert') written = true;
        return result;
      });
      await expect(h.run()).rejects.toThrow('replyResultUnverified');
      expect(readbacks).toBe(3);
      expect(writes(h.execute)).toHaveLength(1);
    }
  );

  it.each([
    ['observed', 'identity'],
    ['own', 'identity'],
    ['link', 'identity'],
    ['observed', 'source'],
    ['own', 'source'],
    ['link', 'source'],
    ['observed', 'changed value'],
    ['own', 'changed value'],
    ['link', 'changed value'],
    ['observed', 'read failure'],
    ['own', 'read failure'],
    ['link', 'read failure'],
  ] as const)(
    'fails immediately for %s readback with %s instead of treating it as stale',
    async (operation, failure) => {
      const h = await fixture(operation);
      const original = h.execute.getMockImplementation()!;
      let written = false;
      let readbacks = 0;
      h.execute.mockImplementation(async (args) => {
        if (args[1] === '+record-get' && written) {
          readbacks++;
          if (failure === 'read failure') throw new Error('offline');
        }
        const result = await original(args);
        if (args[1] === '+record-upsert') {
          written = true;
          const key =
            failure === 'identity'
              ? fields.key
              : failure === 'source'
                ? fields.comment
                : operation === 'link'
                  ? 'fldLink'
                  : fields.draft;
          if (failure !== 'read failure') h.state.rows[0].cells[key] = 'Unexpected concurrent edit';
        }
        return result;
      });
      await expect(h.run()).rejects.toThrow(
        failure === 'read failure'
          ? 'replyCliFailed'
          : failure === 'changed value'
            ? 'replyResultUnverified'
            : 'replySourceIdentityChanged'
      );
      expect(readbacks).toBe(1);
      expect(writes(h.execute)).toHaveLength(1);
    }
  );
});

describe('toolbar batch draft claims', () => {
  const toolbarTable: ReplyTable = {
    ...selectTable,
    presentation: { ...selectTable.presentation!, sendMode: 'toolbar' },
  };

  it.each([false, true])(
    'claims an exact captured draft with old ready=%s without requiring a matching row-button snapshot',
    async (ready) => {
      const h = selectHarness([
        {
          id: 'recOne',
          cells: cells({ [fields.ready]: ready, [fields.status]: ['待处理'], fldApproval: 'Old button snapshot' }),
        },
      ]);
      const expected = (await h.adapter.list(toolbarTable))[0];
      await expect(h.adapter.claimDraft!(toolbarTable, expected)).resolves.toBe(true);
      expect(h.state.rows[0].cells).toMatchObject({
        [fields.draft]: 'Approved draft',
        [fields.ready]: false,
        [fields.status]: ['发送中'],
        fldApproval: 'Approved draft',
      });
      expect(writes(h.execute)).toHaveLength(1);
    }
  );

  it.each([
    ['key', 'foreign'],
    ['draft', 'Edited'],
    ['status', ['已回复']],
    ['result', 'reply-id'],
    ['ready', false],
    ['approval', 'Another snapshot'],
  ] as const)('does not claim a row whose captured %s changed before the write', async (field, replacement) => {
    const h = selectHarness();
    const expected = (await h.adapter.list(toolbarTable))[0];
    h.state.rows[0].cells[field === 'approval' ? 'fldApproval' : fields[field]] = replacement;
    await expect(h.adapter.claimDraft!(toolbarTable, expected)).resolves.toBe(false);
    expect(writes(h.execute)).toHaveLength(0);
  });

  it('does not claim a missing row, blank draft or non-toolbar configuration', async () => {
    const h = selectHarness();
    const expected = (await h.adapter.list(toolbarTable))[0];
    await expect(h.adapter.claimDraft!(selectTable, expected)).resolves.toBe(false);
    await expect(h.adapter.claimDraft!(toolbarTable, { ...expected, draft: '  ' })).resolves.toBe(false);
    h.state.rows = [];
    await expect(h.adapter.claimDraft!(toolbarTable, expected)).resolves.toBe(false);
    expect(writes(h.execute)).toHaveLength(0);
  });

  it('accepts a delayed claim readback only after the exact captured draft and snapshot are visible', async () => {
    const h = selectHarness();
    const expected = (await h.adapter.list(toolbarTable))[0];
    const before = structuredClone(h.state.rows);
    const original = h.execute.getMockImplementation()!;
    let written = false;
    let readbacks = 0;
    h.execute.mockImplementation(async (args) => {
      if (args[1] === '+record-get' && written && ++readbacks < 3) return ok(matrix(before, h.state.schema));
      const result = await original(args);
      if (args[1] === '+record-upsert') written = true;
      return result;
    });
    await expect(h.adapter.claimDraft!(toolbarTable, expected)).resolves.toBe(true);
    expect(readbacks).toBe(3);
    expect(writes(h.execute)).toHaveLength(1);
  });

  it('rejects a claim after three unchanged reads without issuing another write', async () => {
    const h = selectHarness();
    const expected = (await h.adapter.list(toolbarTable))[0];
    h.state.writeIgnored = true;
    await expect(h.adapter.claimDraft!(toolbarTable, expected)).rejects.toThrow('replyResultUnverified');
    expect(h.execute.mock.calls.filter(([args]) => args[1] === '+record-get')).toHaveLength(4);
    expect(writes(h.execute)).toHaveLength(1);
  });

  it.each([
    ['key', 'foreign'],
    ['draft', 'Edited'],
    ['status', ['已回复']],
    ['result', 'reply-id'],
    ['approval', 'Another snapshot'],
    ['comment', 'Different source'],
  ] as const)('rejects a conflicting %s on the first post-claim read', async (field, replacement) => {
    const h = selectHarness();
    const expected = (await h.adapter.list(toolbarTable))[0];
    const original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (args) => {
      const result = await original(args);
      if (args[1] === '+record-upsert')
        h.state.rows[0].cells[field === 'approval' ? 'fldApproval' : fields[field]] = replacement;
      return result;
    });
    await expect(h.adapter.claimDraft!(toolbarTable, expected)).rejects.toThrow(
      field === 'key' || field === 'comment' ? 'replySourceIdentityChanged' : 'replyResultUnverified'
    );
    expect(h.execute.mock.calls.filter(([args]) => args[1] === '+record-get')).toHaveLength(2);
    expect(writes(h.execute)).toHaveLength(1);
  });

  it('rejects unsupported persisted sending modes before reading the table', async () => {
    const h = selectHarness();
    const invalid = {
      ...toolbarTable,
      presentation: { ...toolbarTable.presentation!, sendMode: 'automatic' },
    } as unknown as ReplyTable;
    await expect(h.adapter.list(invalid)).rejects.toThrow('replyInvalidResponse');
  });
});

describe('retryable failure results', () => {
  const toolbarTable: ReplyTable = {
    ...selectTable,
    presentation: { ...selectTable.presentation!, sendMode: 'toolbar' },
  };

  it.each([
    'replyApprovalInterrupted',
    'replyVerificationRequired',
    'replyAccountMismatch',
    'replyDraftPresent',
    'replyTargetUnavailable',
    'replyBrowserUnavailable',
    'replyDraftChanged',
    'replyDraftEmpty',
    'replyPaused',
  ])('recognizes the actual persisted Chinese explanation and internal code for %s', async (code) => {
    const h = selectHarness();
    await h.adapter.writeResult(toolbarTable, 'recOne', 'attention', code);
    const result = h.state.rows[0].cells[fields.result] as string;
    expect(result).not.toBe(code);
    expect(isRetryableReplyResult(result)).toBe(true);
    expect(isRetryableReplyResult(code)).toBe(true);
  });

  it('uses the toolbar retry instruction while accepting the preserved legacy explanation', async () => {
    const h = selectHarness();
    await h.adapter.writeResult(toolbarTable, 'recOne', 'attention', 'replyApprovalInterrupted');
    expect(h.state.rows[0].cells[fields.result]).toBe('尚未发送，请检查回复内容后点击上方“发送评论”');
    await h.adapter.writeResult(selectTable, 'recOne', 'attention', 'replyApprovalInterrupted');
    expect(h.state.rows[0].cells[fields.result]).toBe('尚未发送，请检查回复内容后重新勾选可发送');
    expect(isRetryableReplyResult('尚未发送，请检查回复内容后重新勾选可发送')).toBe(true);
  });

  it('recognizes an empty result without classifying opaque or uncertain evidence as retryable', async () => {
    const h = selectHarness();
    await h.adapter.writeResult(toolbarTable, 'recOne', 'attention', 'replySendUncertain');
    expect(isRetryableReplyResult('')).toBe(true);
    expect(isRetryableReplyResult(h.state.rows[0].cells[fields.result] as string)).toBe(false);
  });

  it.each([
    'replySendUncertain',
    '7707903681722893094',
    'reply-id-1,reply-id-2',
    'replyResultPending',
    'Unknown failure',
    'toString',
    '__proto__',
    ' ',
  ])('does not authorize a retry from %s', (result) => {
    expect(isRetryableReplyResult(result)).toBe(false);
  });
});

describe('toolbar source identity snapshots', () => {
  const toolbarTable: ReplyTable = {
    ...selectTable,
    presentation: { ...selectTable.presentation!, sendMode: 'toolbar' },
  };
  const source: ReplySource = {
    author: 'Reader',
    time: '2026-11-14T06:06:02.000Z',
    comment: 'Question',
    platform: 'douyin',
    account: 'Test',
    conversation: 'douyin:7630823226675650277:7707903681722893094',
    parent: '',
    key: 'douyin:slot:1632121715433368:7630823226675650277:7707903681722893094',
  };

  it('decodes every original source field independently of column order', async () => {
    const h = selectHarness([{ id: 'recOne', cells: { ...sourceCells(), [fields.status]: [], fldApproval: '' } }]);
    expect((await h.adapter.list(toolbarTable))[0].source).toEqual(source);
    expect(replySourceValues(work, comment, '')).toEqual(source);
  });

  it.each(['author', 'time', 'comment', 'platform', 'account', 'conversation', 'parent', 'key'] as const)(
    'does not claim a draft when its %s source value changes after the batch snapshot',
    async (field) => {
      const h = selectHarness([{ id: 'recOne', cells: { ...sourceCells(), [fields.status]: [], fldApproval: '' } }]);
      const expected = (await h.adapter.list(toolbarTable))[0];
      h.state.rows[0].cells[fields[field]] = 'Changed source';
      await expect(h.adapter.claimDraft!(toolbarTable, expected)).resolves.toBe(false);
      expect(writes(h.execute)).toHaveLength(0);
    }
  );

  it('does not claim when the captured source is absent or incomplete', async () => {
    const h = selectHarness();
    const expected = (await h.adapter.list(toolbarTable))[0];
    await expect(h.adapter.claimDraft!(toolbarTable, { ...expected, source: undefined })).resolves.toBe(false);
    const partial = { ...source } as Partial<ReplySource>;
    delete partial.parent;
    await expect(h.adapter.claimDraft!(toolbarTable, { ...expected, source: partial as ReplySource })).resolves.toBe(
      false
    );
    expect(writes(h.execute)).toHaveLength(0);
  });

  it('requires two complete source objects even when both operands are the same missing value', () => {
    expect(sameReplySource(source, { ...source })).toBe(true);
    expect(sameReplySource(undefined, undefined)).toBe(false);
    expect(sameReplySource(source, undefined)).toBe(false);
  });

  it.each(['author', 'time', 'comment', 'platform', 'account', 'conversation', 'parent', 'key'] as const)(
    'rejects a different or missing %s when comparing source evidence',
    (field) => {
      const partial = { ...source } as Partial<ReplySource>;
      delete partial[field];
      expect(sameReplySource(source, { ...source, [field]: 'Changed' })).toBe(false);
      expect(sameReplySource(partial as ReplySource, partial as ReplySource)).toBe(false);
    }
  );

  it('retains work and timestamp validation when constructing source evidence', () => {
    expect(() => replySourceValues({ ...work, actorId: 'other-owner' }, comment, '')).toThrow(
      'replySourceIdentityInvalid'
    );
    expect(() => replySourceValues(work, { ...comment, createdAt: Number.NaN }, '')).toThrow(
      'replySourceIdentityInvalid'
    );
    expect(() => replySourceValues(work, { ...comment, createdAt: 9e15 }, '')).toThrow('replySourceIdentityInvalid');
  });
});

describe('frozen source evidence', () => {
  it('writes a retryable human-readable result for a known incomplete thread', async () => {
    const h = selectHarness();
    await h.adapter.writeResult(selectTable, 'recOne', 'attention', 'replyThreadIncomplete');
    expect(h.state.rows[0].cells[fields.status]).toEqual(['未发送']);
    expect(h.state.rows[0].cells[fields.result]).toBe('评论回复未完全加载，确认后请重新点击发送');
    expect(isRetryableReplyResult(h.state.rows[0].cells[fields.result] as string)).toBe(true);
  });

  it('uses the saved source for creation and recovery after display metadata changes', async () => {
    const h = harness([]);
    const saved = replySourceValues(work, comment, 'Earlier parent');
    const changed = { ...work, actorName: 'Renamed owner' };

    expect(await h.adapter.create(table, changed, comment, 'New parent', saved)).toBe('recCreated');
    expect(h.state.rows[0].cells).toMatchObject({
      [fields.account]: 'Test',
      [fields.parent]: 'Earlier parent',
    });
    expect(await h.adapter.recover(table, changed, comment, 'New parent', saved)).toBe('recCreated');
  });

  it.each(['observed', 'own'] as const)(
    'does not write %s when source fields change after capture',
    async (operation) => {
      const h = selectHarness();
      const row = (await h.adapter.list(selectTable))[0];
      h.state.rows[0].cells[fields.account] = 'Different account';

      await expect(
        operation === 'observed'
          ? h.adapter.writeObservedReply!(selectTable, row, 'Manual reply', 'reply-id', 'replied')
          : h.adapter.markOwnComment!(selectTable, row)
      ).rejects.toThrow('replySourceIdentityChanged');
      expect(writes(h.execute)).toHaveLength(0);
    }
  );

  it('allows a comment-link update against the frozen source after the account display name changes', async () => {
    const linkedTable: ReplyTable = {
      ...selectTable,
      presentation: { ...selectTable.presentation!, commentLinkFieldId: 'fldLink', replyCaptureVersion: 1 },
    };
    const h = selectHarness([
      { id: 'recOne', cells: { ...sourceCells(), [fields.status]: [], fldApproval: '', fldLink: '' } },
    ]);
    h.state.schema.push({ id: 'fldLink', name: '原评论', type: 'text' });
    const row = (await h.adapter.list(linkedTable))[0];

    await h.adapter.writeCommentLink!(linkedTable, row, { ...work, actorName: 'New display name' }, comment);
    expect(h.state.rows[0].cells.fldLink).toMatch(/^\[查看评论\]/);
    expect(h.state.rows[0].cells[fields.account]).toBe('Test');
  });

  it('does not link a record whose frozen source disagrees with the trusted comment', async () => {
    const linkedTable: ReplyTable = {
      ...selectTable,
      presentation: { ...selectTable.presentation!, commentLinkFieldId: 'fldLink', replyCaptureVersion: 1 },
    };
    const h = selectHarness([
      { id: 'recOne', cells: { ...sourceCells(), [fields.status]: [], fldApproval: '', fldLink: '' } },
    ]);
    h.state.schema.push({ id: 'fldLink', name: '原评论', type: 'text' });
    const row = (await h.adapter.list(linkedTable))[0];

    await expect(
      h.adapter.writeCommentLink!(linkedTable, row, work, { ...comment, content: 'Different trusted comment' })
    ).rejects.toThrow('replySourceIdentityChanged');
    expect(writes(h.execute)).toHaveLength(0);
  });

  it('does not write a result when the captured source no longer matches the record', async () => {
    const h = harness([{ id: 'recOne', cells: sourceCells() }]);
    const source = replySourceValues(work, comment, '');
    h.state.rows[0].cells[fields.comment] = 'Different comment';

    await expect(h.adapter.writeResult(table, 'recOne', 'sent', 'reply-id', source)).rejects.toThrow(
      'replySourceIdentityChanged'
    );
    expect(writes(h.execute)).toHaveLength(0);
  });
});
