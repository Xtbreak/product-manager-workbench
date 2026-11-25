import { z } from 'zod';
import type { ReplySource, ReplyTable } from '@/common/types/platform/workbenchReply';
import { isWorkbenchFeishuOrigin } from '@/common/utils/urlValidation';
import type { Execute } from '../feishuAuth';
import { dmLinkToken, type DmLinkIdentity } from '../replies/commentLinks';
import {
  inspectFields,
  parse,
  recordId,
  replySourceValues,
  sameReplySource,
  validateTable,
} from '../replies/feishuSchema';
import type { ReplyDocument } from '../replies/store';

export type DmFeishuConfig = { baseToken: string; tableId: string; fieldId: string };
export type DmFeishuThread = DmLinkIdentity & { direction?: 'inbound' | 'outbound'; count?: number };
type Replies = Pick<ReplyDocument, 'table' | 'works' | 'comments' | 'records' | 'sourceSnapshots'>;
type Target = { record: string; source: ReplySource; cell: string; url: string };

const fieldId = z.string().regex(/^fld[A-Za-z0-9]+$/);
const field = z.object({ id: fieldId, name: z.string(), type: z.string(), style: z.unknown().optional() });
const fieldList = z.object({
  fields: z.array(field),
  has_more: z.literal(false).optional(),
  total: z.number().optional(),
});
const matrix = z.object({
  field_id_list: z.array(fieldId),
  field_type_list: z.array(z.literal('text')),
  record_id_list: z.array(recordId).length(1),
  data: z.array(z.array(z.string().nullable())).length(1),
  has_more: z.literal(false),
});
const response = z.object({ ok: z.literal(true), data: z.unknown() });
const auth = z.object({
  appId: z.string().min(1),
  brand: z.literal('feishu'),
  verified: z.literal(true).optional(),
  identities: z.object({
    user: z.object({
      available: z.literal(true),
      status: z.enum(['ready', 'valid', 'needs_refresh']),
      scope: z.string(),
    }),
  }),
});
const viewId = z.string().regex(/^vew[A-Za-z0-9]+$/);
const views = z.object({
  views: z.array(z.object({ id: viewId, name: z.string(), type: z.string() })),
  total: z.number().int(),
});
const platformViews = ['小红书 · 回复工作台', '抖音 · 回复工作台'];
const fieldName = '私聊';
const fail = (): never => {
  throw new Error('dmFeishuFailed');
};
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 150));

function validateTarget(table: ReplyTable, config?: DmFeishuConfig) {
  validateTable(table);
  const url = new URL(table.url);
  if (
    !isWorkbenchFeishuOrigin(url.href) ||
    url.pathname !== '/base/' + table.baseToken ||
    url.searchParams.getAll('table').length !== 1 ||
    url.searchParams.get('table') !== table.tableId
  )
    fail();
  if (
    config &&
    (config.baseToken !== table.baseToken ||
      config.tableId !== table.tableId ||
      !fieldId.safeParse(config.fieldId).success)
  )
    fail();
}

async function client(table: ReplyTable, injected: Execute | undefined, scopes: string[], signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('dmCancelled');
  const execute = injected ?? (await import('../feishuAuth')).executeFeishu;
  const raw = async (args: string[]) => {
    if (signal?.aborted) throw new Error('dmCancelled');
    try {
      return await execute(args);
    } catch {
      return fail();
    }
  };
  const granted = new Set(parse(auth, await raw(['auth', 'status', '--json'])).identities.user.scope.split(/\s+/));
  if (scopes.some((scope) => !granted.has(scope))) fail();
  const flags = ['--base-token', table.baseToken, '--table-id', table.tableId, '--as', 'user', '--format', 'json'];
  const call = async (command: string, ...args: string[]) =>
    parse(response, await raw(['base', command, ...flags, ...args])).data;
  const listFields = async () => {
    const list = parse(fieldList, await call('+field-list'));
    if (list.total !== undefined && list.total !== list.fields.length) fail();
    inspectFields(table, list);
    return list.fields;
  };
  const findField = async (config?: DmFeishuConfig) => {
    const fields = await listFields();
    const matches = fields.filter((f) => f.name === fieldName);
    if (matches.length > 1) fail();
    const id = matches[0]?.id;
    if (config && id !== config.fieldId) fail();
    if (!id) return undefined;
    const used = new Set([
      ...Object.values(table.fields),
      table.presentation?.buttonFieldId,
      table.presentation?.timeDisplayFieldId,
      table.presentation?.approvalTextFieldId,
      table.presentation?.commentLinkFieldId,
    ]);
    if (used.has(id) || matches[0].type !== 'text') fail();
    const detail = parse(z.object({ field }), await call('+field-get', '--field-id', id)).field;
    if (
      detail.id !== id ||
      detail.name !== fieldName ||
      detail.type !== 'text' ||
      !z.object({ type: z.literal('url') }).safeParse(detail.style).success
    )
      fail();
    return id;
  };
  return { call, findField, listFields };
}

/** Obtain the existing managed grids by stable main view ID and verified platform view names. */
async function managedGrids(c: Awaited<ReturnType<typeof client>>, table: ReplyTable) {
  if (!table.presentation) return [];
  const value = parse(views, await c.call('+view-list'));
  if (value.total !== value.views.length || new Set(value.views.map((v) => v.id)).size !== value.views.length)
    return fail();
  const main = value.views.find((v) => v.id === table.presentation!.viewId);
  if (main?.type !== 'grid') return fail();
  const ids = new Set([main.id]);
  for (const name of platformViews) {
    const matches = value.views.filter((v) => v.name === name);
    if (matches.length > 1 || (matches.length && matches[0].type !== 'grid')) return fail();
    if (matches.length) ids.add(matches[0].id);
  }
  return [...ids];
}

async function appendToGrids(c: Awaited<ReturnType<typeof client>>, grids: string[], id: string) {
  if (!grids.length) return;
  const fields = await c.listFields();
  const readVisible = async (view: string) => {
    const { visible_fields } = parse(
      z.object({ visible_fields: z.array(z.string()) }),
      await c.call('+view-get-visible-fields', '--view-id', view)
    );
    const ids = visible_fields.map((ref) => {
      const matches = fields.filter((f) => f.name === ref || f.id === ref);
      return matches.length === 1 ? matches[0].id : fail();
    });
    if (new Set(ids).size !== ids.length) fail();
    return ids;
  };
  for (const view of grids) {
    const before = await readVisible(view);
    if (before.includes(id)) continue;
    const desired = [...before, id];
    await c.call('+view-set-visible-fields', '--view-id', view, '--json', JSON.stringify({ visible_fields: desired }));
    const actual = await readVisible(view);
    if (actual.length !== desired.length || actual.some((item, i) => item !== desired[i])) fail();
  }
}

/** Explicit setup reuses the existing reply table and performs at most one field creation per invocation. */
export async function configureDmFeishu(
  table: ReplyTable,
  previous?: DmFeishuConfig,
  execute?: Execute,
  signal?: AbortSignal
): Promise<DmFeishuConfig> {
  validateTarget(table, previous);
  const c = await client(
    table,
    execute,
    [
      'base:field:read',
      ...(!previous ? ['base:field:create'] : []),
      ...(table.presentation ? ['base:view:read', 'base:view:write_only'] : []),
    ],
    signal
  );
  let id = await c.findField(previous);
  const grids = await managedGrids(c, table);
  if (!id) {
    // A timeout may follow a successful creation. Discover by name and type before allowing any retry.
    try {
      await c.call(
        '+field-create',
        '--json',
        JSON.stringify({ name: fieldName, type: 'text', style: { type: 'url' } })
      );
    } catch {
      /* Reconcile below. */
    }
    for (let attempt = 0; attempt < 3 && !id; attempt++) {
      if (attempt) await pause();
      id = await c.findField();
    }
    if (!id) return fail();
  }
  await appendToGrids(c, grids, id);
  return { baseToken: table.baseToken, tableId: table.tableId, fieldId: id };
}

function linkedTargets(replies: Replies, threads: DmFeishuThread[]): Target[] {
  const cells = new Map<string, { cell: string; url: string }>();
  for (const t of threads) {
    const token = dmLinkToken(t);
    if (
      cells.has(token) ||
      (t.direction === undefined
        ? (t.count ?? 0) !== 0
        : !['inbound', 'outbound'].includes(t.direction) || !Number.isSafeInteger(t.count) || (t.count ?? 0) < 1)
    )
      fail();
    const url = `https://www.${t.platform}.com/#workbench-dm=${token}`;
    const label = t.direction ? `${t.direction === 'inbound' ? '对方已回' : '我已回'}(${t.count})` : '查看私聊';
    cells.set(token, { url, cell: `[${label}](${url})` });
  }
  const owners = new Map<string, string>();
  for (const [key, record] of Object.entries(replies.records)) {
    if (owners.has(record)) fail();
    owners.set(record, key);
  }
  const works = new Map(replies.works.map((w) => [w.key, w]));
  const comments = new Map(replies.comments.map((c) => [c.key, c]));
  if (works.size !== replies.works.length || comments.size !== replies.comments.length) fail();
  const targets: Target[] = [];
  for (const c of replies.comments) {
    const record = replies.records[c.key];
    if (!record || c.actorId === c.authorId) continue;
    // Historical records may contain unsupported account or author identifiers.
    if (![c.accountId, c.actorId, c.authorId].every((id) => /^[a-zA-Z0-9_-]{1,256}$/.test(id))) continue;
    const desired = cells.get(dmLinkToken({ ...c, contactPlatformId: c.authorId }));
    if (!desired) continue;
    const w = works.get(c.workKey);
    if (!w || w.key !== [w.platform, w.accountId, w.actorId, w.workId].join(':') || c.key !== w.key + ':' + c.commentId)
      return fail();
    parse(recordId, record);
    const frozen = replies.sourceSnapshots[c.key];
    const parent = c.parentCommentId ? comments.get(w.key + ':' + c.parentCommentId) : undefined;
    const source = replySourceValues(w, c, frozen?.parent ?? parent?.content ?? '');
    // The recorded account display name may have changed since the comment was archived.
    if (frozen && !sameReplySource({ ...source, account: frozen.account }, frozen)) fail();
    targets.push({ record, source: frozen ?? source, ...desired });
  }
  return targets;
}

function ownedCell(value: string, url: string) {
  const label = /^\[(查看私聊|(?:我已回|对方已回)\([1-9][0-9]*\))\]/.exec(value)?.[0];
  return value === '' || (label !== undefined && value === label + '(' + url + ')');
}

/** Update only mapped comment rows and the dedicated link column. Return the number of changed cells. */
export async function syncDmFeishu(
  config: DmFeishuConfig | undefined,
  replies: Replies,
  threads: DmFeishuThread[],
  execute?: Execute,
  signal?: AbortSignal
): Promise<number> {
  if (!config) return 0;
  const table = replies.table;
  if (!table) return fail();
  validateTarget(table, config);
  const targets = linkedTargets(replies, threads);
  if (!targets.length) return 0;
  const c = await client(table, execute, ['base:field:read', 'base:record:read', 'base:record:update'], signal);
  await c.findField(config);
  const read = async (target: Target) => {
    const keys = Object.keys(target.source) as (keyof ReplySource)[];
    const ids = [...keys.map((k) => table.fields[k]), config.fieldId];
    const page = parse(
      matrix,
      await c.call('+record-get', '--record-id', target.record, ...ids.flatMap((id) => ['--field-id', id]))
    );
    if (
      page.record_id_list[0] !== target.record ||
      page.field_id_list.length !== ids.length ||
      page.field_type_list.length !== ids.length ||
      page.data[0].length !== ids.length ||
      !ids.every((id) => page.field_id_list.includes(id))
    )
      fail();
    const cell = (id: string) => page.data[0][page.field_id_list.indexOf(id)] ?? '';
    if (keys.some((k) => cell(table.fields[k]) !== target.source[k])) fail();
    const value = cell(config.fieldId);
    if (!ownedCell(value, target.url)) fail();
    return value;
  };
  const pending: Array<{ target: Target; before: string }> = [];
  for (const target of targets) {
    const before = await read(target);
    if (before !== target.cell) pending.push({ target, before });
  }
  let changed = 0;
  for (const { target, before } of pending) {
    const current = await read(target);
    if (current === target.cell) continue;
    if (current !== before) fail();
    // An explicit record ID is mandatory. Reconcile an uncertain write via reads, never a blind resend.
    try {
      await c.call(
        '+record-upsert',
        '--record-id',
        target.record,
        '--json',
        JSON.stringify({ [config.fieldId]: target.cell })
      );
    } catch {
      /* Verify below. */
    }
    let verified = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await pause();
      const after = await read(target);
      if (after === target.cell) {
        verified = true;
        break;
      }
      if (after !== before) fail();
    }
    if (!verified) fail();
    changed++;
  }
  return changed;
}
