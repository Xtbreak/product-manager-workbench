import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { ReplyComment, ReplyTable, ReplyWork } from '@/common/types/platform/workbenchReply';
import { REPLY_FIELDS, replySourceValues } from '@/process/services/workbench/replies/feishuSchema';
import * as links from '@/process/services/workbench/replies/commentLinks';

const config = { baseToken: 'baseExample', tableId: 'tblExisting', fieldId: 'fldDm' };
const table: ReplyTable = {
  baseToken: config.baseToken,
  tableId: config.tableId,
  url: 'https://example.feishu.cn/base/baseExample?table=tblExisting&view=vewOriginal',
  fields: Object.fromEntries(REPLY_FIELDS.map(({ key }) => [key, 'fld' + key])) as ReplyTable['fields'],
  presentation: {
    viewId: 'vewOriginal',
    buttonFieldId: 'fldButton',
    approvalTextFieldId: 'fldApproval',
    commentLinkFieldId: 'fldOriginal',
    workflowId: 'wkfOriginal',
  },
};
const work: ReplyWork = {
  key: 'douyin:slot:actor:123',
  platform: 'douyin',
  accountId: 'slot',
  actorId: 'actor',
  actorName: 'Example',
  workId: '123',
  title: 'Work',
  url: 'https://www.douyin.com/video/123',
};
const comment = (id: string, authorId = 'contact'): ReplyComment => ({
  key: work.key + ':' + id,
  workKey: work.key,
  platform: work.platform,
  accountId: work.accountId,
  actorId: work.actorId,
  workId: work.workId,
  commentId: id,
  rootCommentId: id,
  parentCommentId: null,
  authorId,
  author: '同名',
  content: 'example ' + id,
  createdAt: 1000,
});
const comments = [comment('1'), comment('2'), comment('3', 'someoneElse'), comment('4', 'actor')];
const replies = {
  table,
  works: [work],
  comments,
  records: Object.fromEntries(comments.map((c) => [c.key, 'rec' + c.commentId])),
  sourceSnapshots: Object.fromEntries(comments.map((c) => [c.key, replySourceValues(work, c, '')])),
};
const thread = {
  platform: work.platform,
  accountId: work.accountId,
  actorId: work.actorId,
  contactPlatformId: 'contact',
};
const token = createHash('sha256').update('workbench-dm-v1\0douyin:slot:actor:contact').digest('hex');
const url = 'https://www.douyin.com/#workbench-dm=' + token;
const dmField = { id: 'fldDm', name: '私聊', type: 'text', style: { type: 'url' } };
type Field = { id: string; name: string; type: string; style?: { type: string } };
function mockFeishu(hasField = true) {
  const fields: Field[] = [
    ...REPLY_FIELDS.map((f) => ({ id: table.fields[f.key], name: f.name, type: f.type })),
    { id: 'fldButton', name: '发送', type: 'button' },
    { id: 'fldApproval', name: '本次待发内容', type: 'text' },
    { id: 'fldOriginal', name: '原评论', type: 'text', style: { type: 'url' } },
    ...(hasField ? [dmField] : []),
  ];
  const records: Record<string, Record<string, string | boolean>> = {};
  for (const c of comments) {
    const source = replies.sourceSnapshots[c.key];
    records[replies.records[c.key]] = {
      ...Object.fromEntries(Object.entries(source).map(([k, v]) => [table.fields[k as keyof typeof source], v])),
      fldDm: '',
      fldOriginal: '[查看评论](existing)',
      fldready: false,
      fldstatus: '待处理',
      flddraft: 'original draft',
      fldresult: '',
      fldApproval: '',
    };
  }
  const visible: Record<string, string[]> = {
    vewOriginal: ['fldOriginal', 'fldauthor'],
    vewXhs: ['fldkey', 'fldDm'],
    vewCustom: ['fldresult'],
  };
  const writes: string[][] = [];
  const execute = vi.fn(async (args: string[]) => {
    const flag = (f: string) => args[args.indexOf(f) + 1];
    const ok = (data: unknown) => ({ ok: true, data });
    if (args[0] === 'auth')
      return {
        appId: 'mock',
        brand: 'feishu',
        verified: true,
        identities: {
          user: {
            available: true,
            status: 'ready',
            scope:
              'base:field:read base:field:create base:record:update base:record:read base:view:read base:view:write_only',
          },
        },
      };
    expect(flag('--table-id')).toBe(table.tableId);
    expect(flag('--base-token')).toBe(table.baseToken);
    if (args[1] === '+view-list')
      return ok({
        views: [
          { id: 'vewOriginal', name: '回复工作台', type: 'grid' },
          { id: 'vewXhs', name: '小红书 · 回复工作台', type: 'grid' },
          { id: 'vewCustom', name: 'Custom', type: 'grid' },
        ],
        total: 3,
      });
    if (args[1] === '+view-get-visible-fields')
      return ok({
        visible_fields: visible[flag('--view-id')].map((id) => fields.find((f) => f.id === id)?.name ?? id),
      });
    if (args[1] === '+view-set-visible-fields') {
      writes.push(args);
      visible[flag('--view-id')] = JSON.parse(flag('--json')).visible_fields;
      return ok({});
    }
    if (args[1] === '+field-list') return ok({ fields });
    if (args[1] === '+field-get') return ok({ field: fields.find((f) => f.id === flag('--field-id')) });
    if (args[1] === '+field-create') {
      writes.push(args);
      const def = JSON.parse(flag('--json'));
      expect(def).toMatchObject({ name: '私聊', type: 'text', style: { type: 'url' } });
      fields.push({ id: config.fieldId, ...def });
      return ok({ field: fields.at(-1) });
    }
    const record = records[flag('--record-id')];
    if (args[1] === '+record-get') {
      const ids = args.flatMap((v, i) => (v === '--field-id' ? [args[i + 1]] : []));
      return ok({
        field_id_list: ids,
        field_type_list: ids.map((id) => fields.find((f) => f.id === id)?.type),
        record_id_list: record ? [flag('--record-id')] : [],
        data: record ? [ids.map((k) => record[k] ?? null)] : [],
        rev: 1,
        has_more: false,
      });
    }
    if (args[1] === '+record-upsert') {
      writes.push(args);
      expect(record).toBeDefined();
      const payload = JSON.parse(flag('--json'));
      expect(Object.keys(payload)).toEqual([config.fieldId]);
      Object.assign(record, payload);
      return ok({});
    }
    throw Error('Unrecognized operation ' + args[1]);
  });
  return { fields, writes, execute, records, visible };
}

const api = () => import('@/process/services/workbench/dms/feishu');
it('derives stable tokens from all four unambiguous identity components', () => {
  expect(links.dmLinkToken(thread)).toBe(token);
  expect(links.commentLinkToken({ ...comments[0], key: 'douyin:slot:actor:contact' })).not.toBe(token);
  expect(links.dmLinkToken({ ...thread, accountId: 'other' })).not.toBe(token);
  expect(() => links.dmLinkToken({ ...thread, accountId: 'bad:slot' })).toThrow();
});
it('configures only one dedicated link field on the existing table and reuses it on retry', async () => {
  const { configureDmFeishu } = await api();
  const h = mockFeishu(false);
  expect(await configureDmFeishu(table, undefined, h.execute)).toEqual(config);
  expect(await configureDmFeishu(table, config, h.execute)).toEqual(config);
  expect(await configureDmFeishu(table, undefined, h.execute)).toEqual(config);
  expect(h.writes.map((a) => a[1])).toEqual(['+field-create', '+view-set-visible-fields']);
  expect(h.visible).toEqual({
    vewOriginal: ['fldOriginal', 'fldauthor', 'fldDm'],
    vewXhs: ['fldkey', 'fldDm'],
    vewCustom: ['fldresult'],
  });
});
it('refuses field aliasing, a changed link style, and duplicate field names before writing', async () => {
  const { configureDmFeishu } = await api();
  for (const mode of ['alias', 'style', 'duplicate', 'removed', 'rebound']) {
    const h = mockFeishu();
    if (mode === 'alias') h.fields.find((f) => f.id === 'fldOriginal')!.name = '私聊';
    if (mode === 'style') h.fields[h.fields.length - 1] = { ...dmField, style: { type: 'text' } };
    if (mode === 'duplicate') h.fields.push({ ...dmField, id: 'fldOther' });
    if (mode === 'removed') h.fields.pop();
    const previous = mode === 'rebound' ? { ...config, tableId: 'tblOther' } : config;
    await expect(configureDmFeishu(table, previous, h.execute)).rejects.toThrow();
    expect(h.writes).toEqual([]);
  }
});
it('unconfigured sync calls no CLI, and table/URL mismatches fail closed', async () => {
  const { syncDmFeishu } = await api();
  const h = mockFeishu();
  expect(await syncDmFeishu(undefined, replies, [thread], h.execute)).toBe(0);
  await expect(syncDmFeishu({ ...config, tableId: 'tblUnknown' }, replies, [thread], h.execute)).rejects.toThrow();
  await expect(
    syncDmFeishu(
      config,
      { ...replies, table: { ...table, url: 'https://fake.test/base/baseExample?table=tblExisting' } },
      [thread],
      h.execute
    )
  ).rejects.toThrow();
  expect(h.execute).not.toHaveBeenCalled();
});
it('updates only 私聊 for all rows of the exact author/account and verifies idempotent status updates', async () => {
  const { syncDmFeishu } = await api();
  const h = mockFeishu();
  const old = structuredClone(h.records);
  for (const [direction, count, label] of [
    [undefined, undefined, '查看私聊'],
    ['outbound', 2, '我已回(2)'],
    ['inbound', 1, '对方已回(1)'],
  ] as const) {
    const threads = [{ ...thread, direction, count }];
    expect(await syncDmFeishu(config, replies, threads, h.execute)).toBe(2);
    expect(await syncDmFeishu(config, replies, threads, h.execute)).toBe(0);
    expect(h.records).toEqual({
      ...old,
      rec1: { ...old.rec1, fldDm: `[${label}](${url})` },
      rec2: { ...old.rec2, fldDm: `[${label}](${url})` },
    });
  }
  expect(h.writes).toHaveLength(6);
});
it('rejects manual cell contents, changed immutable source, and remapped local record IDs before any writes', async () => {
  const { syncDmFeishu } = await api();
  for (const mode of ['manual', 'otherToken', 'source', 'duplicate', 'frozen']) {
    const h = mockFeishu();
    const local = structuredClone(replies);
    if (mode === 'manual') h.records.rec2.fldDm = 'a manually managed cell';
    if (mode === 'otherToken')
      h.records.rec2.fldDm = '[查看私聊](https://www.douyin.com/#workbench-dm=' + 'cd'.repeat(32) + ')';
    if (mode === 'source') h.records.rec2.fldcomment = 'different text';
    if (mode === 'duplicate') local.records[comments[2].key] = 'rec2';
    if (mode === 'frozen') local.sourceSnapshots[comments[1].key].key = 'someoneElse';
    await expect(syncDmFeishu(config, local, [thread], h.execute)).rejects.toThrow();
    expect(h.writes).toHaveLength(0);
  }
});
it('recovers an uncertain field creation without creating twice', async () => {
  const { configureDmFeishu } = await api();
  const h = mockFeishu(false);
  const execute = async (args: string[]) => {
    const value = await h.execute(args);
    if (args[1] === '+field-create') throw Error('request timed out after creation');
    return value;
  };
  expect(await configureDmFeishu(table, undefined, execute)).toEqual(config);
  expect(h.writes.filter((args) => args[1] === '+field-create')).toHaveLength(1);
});

it('cancels before any cloud operation', async () => {
  const { syncDmFeishu } = await api();
  const h = mockFeishu();
  await expect(syncDmFeishu(config, replies, [thread], h.execute, AbortSignal.abort())).rejects.toThrow('dmCancelled');
  expect(h.execute).not.toHaveBeenCalled();
});
it('recovers a partial status update on the next sync without duplicating successful writes', async () => {
  const { syncDmFeishu } = await api();
  const h = mockFeishu();
  const execute = async (args: string[]) => {
    if (args[1] === '+record-upsert' && args[args.indexOf('--record-id') + 1] === 'rec2') throw Error('offline');
    const result = await h.execute(args);
    if (args[1] === '+record-upsert') throw Error('timeout after commit');
    return result;
  };
  await expect(syncDmFeishu(config, replies, [thread], execute)).rejects.toThrow();
  expect(await syncDmFeishu(config, replies, [thread], h.execute)).toBe(1);
  expect(h.writes.map((a) => a[a.indexOf('--record-id') + 1])).toEqual(['rec1', 'rec2']);
});
