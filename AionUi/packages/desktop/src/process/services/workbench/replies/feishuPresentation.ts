import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ReplyTable } from '@/common/types/platform/workbenchReply';
import type { Execute } from '../feishuAuth';
import type { ReplyPresentationContext } from './contracts';
import { inspectFields, parse, validateTable } from './feishuSchema';

const FIELD_ID = z.string().regex(/^fld[a-zA-Z0-9]+$/);
const VIEW_ID = z.string().regex(/^vew[a-zA-Z0-9]+$/);
const WORKFLOW_ID = z.string().regex(/^wkf[a-zA-Z0-9]+$/);
const fieldSchema = z.object({ id: FIELD_ID, name: z.string(), type: z.string() }).passthrough();
const fieldsSchema = z.object({ fields: z.array(fieldSchema) });
const viewsSchema = z.object({
  views: z.array(z.object({ id: VIEW_ID, name: z.string(), type: z.string() })),
  total: z.number().int().nonnegative(),
});
const workflowSchema = z.object({
  workflow_id: WORKFLOW_ID,
  title: z.string(),
  status: z.enum(['enabled', 'disabled']),
});
const workflowsSchema = z.object({ items: z.array(workflowSchema).nullable(), total: z.number().int().nonnegative() });
const workflowDetailSchema = workflowSchema.extend({ steps: z.array(z.record(z.string(), z.unknown())) });
const responseSchema = z.object({ ok: z.literal(true), data: z.unknown() });
const PRESENTATION_SCOPES = [
  'base:table:read',
  'base:field:read',
  'base:field:create',
  'base:field:update',
  'base:view:read',
  'base:view:write_only',
  'base:workflow:read',
  'base:workflow:create',
  'base:workflow:update',
  'base:record:read',
];
const authSchema = z.object({
  appId: z.string(),
  brand: z.literal('feishu'),
  verified: z.boolean().optional(),
  identities: z.object({
    user: z.object({ available: z.boolean(), status: z.string(), scope: z.string().optional() }),
  }),
});
type Field = z.infer<typeof fieldSchema>;
type Workflow = z.infer<typeof workflowSchema>;
type Step = Record<string, unknown>;
const TIME_EXPRESSION =
  'IF(RIGHT([时间原值],1)="Z",IFERROR(TEXT(DATE(VALUE(LEFT([时间原值],4)),VALUE(MID([时间原值],6,2)),VALUE(MID([时间原值],9,2)))+DURATION(0,VALUE(MID([时间原值],12,2))+8,VALUE(MID([时间原值],15,2)),0),"YYYY-MM-DD hh:mm"),[时间原值]),[时间原值])';
const PLATFORM_VIEWS = [
  { name: '小红书 · 回复工作台', platform: 'xiaohongshu' },
  { name: '抖音 · 回复工作台', platform: 'douyin' },
] as const;
const STATUS_OPTIONS = [
  ['待处理', 'Gray'],
  ['待发送', 'Blue'],
  ['发送中', 'Orange'],
  ['已发送', 'Green'],
  ['已回复', 'Green'],
  ['本人评论', 'Gray'],
  ['需核对', 'Red'],
  ['需验证', 'Orange'],
  ['未发送', 'Red'],
].map(([name, hue]) => ({ name, hue, lightness: 'Lighter' }));
const recordPageSchema = z.object({
  field_id_list: z.array(FIELD_ID),
  field_type_list: z.array(z.string()),
  record_id_list: z.array(z.string().regex(/^rec[a-zA-Z0-9]+$/)),
  data: z.array(z.array(z.unknown())),
  rev: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative().optional(),
});

function one<T>(items: T[]): T | undefined {
  if (items.length > 1) throw new Error('replyPresentationConflict');
  return items[0];
}

function matchingField(fields: Field[], name: string, type: string, savedId?: string): Field | undefined {
  const field = one(fields.filter((entry) => (savedId ? entry.id === savedId : entry.name === name)));
  if ((savedId && !field) || (field && field.type !== type)) throw new Error('replyPresentationConflict');
  return field;
}

function stepsFor(
  tableName: string,
  fields: Field[],
  table: ReplyTable,
  approvalTextFieldId: string,
  select = false,
  clearedStatus = false,
  captureReplies = true
): Step[] {
  const name = (id: string) => {
    const field = one(fields.filter((entry) => entry.id === id));
    if (!field) throw new Error('replyFieldSchemaChanged');
    return field.name;
  };
  const ref = (id: string) => ({ value_type: 'ref', value: `$.clicked.${id}` });
  return [
    {
      id: 'clicked',
      type: 'ButtonTrigger',
      title: '点击发送',
      next: 'check',
      data: { button_type: 'buttonField', table_name: tableName },
    },
    {
      id: 'check',
      type: 'IfElseBranch',
      title: '检查回复是否可发送',
      next: null,
      children: {
        links: [
          { kind: 'if_true', to: 'approve' },
          { kind: 'if_false', to: 'unchanged' },
        ],
      },
      data: {
        condition: {
          conjunction: 'or',
          conditions: [
            {
              conjunction: 'and',
              conditions: [
                { left_value: ref(table.fields.draft), operator: 'isNotEmpty' },
                {
                  left_value: ref(table.fields.ready),
                  operator: 'is',
                  right_value: [{ value_type: 'boolean', value: false }],
                },
                ...[
                  '已发送',
                  '发送中',
                  '待发送',
                  '需核对',
                  '待核对',
                  ...(captureReplies ? ['已回复', '本人评论'] : []),
                ].map((status) => ({
                  left_value: ref(table.fields.status),
                  operator: 'isNot',
                  right_value: clearedStatus
                    ? []
                    : [
                        select
                          ? { value_type: 'option', value: { name: status } }
                          : { value_type: 'text', value: status },
                      ],
                })),
              ],
            },
          ],
        },
      },
    },
    {
      id: 'approve',
      type: 'SetRecordAction',
      title: '提交本次回复',
      next: null,
      data: {
        table_name: tableName,
        ref_info: { step_id: 'clicked' },
        max_set_record_num: 1,
        field_values: [
          { field_name: name(approvalTextFieldId), value: [ref(table.fields.draft)] },
          { field_name: name(table.fields.ready), value: [{ value_type: 'boolean', value: true }] },
          {
            field_name: name(table.fields.status),
            value: clearedStatus
              ? []
              : [
                  select
                    ? { value_type: 'option', value: { name: '待发送' } }
                    : { value_type: 'text', value: '待发送' },
                ],
          },
        ],
      },
    },
    {
      id: 'unchanged',
      type: 'FindRecordAction',
      title: '保持当前回复状态',
      next: null,
      data: {
        table_name: tableName,
        ref_info: { step_id: 'clicked' },
        field_names: [name(table.fields.status)],
        should_proceed_when_no_results: true,
      },
    },
  ];
}

// Server-added metadata is harmless; extra steps or changed targets/conditions are not.
function includesDefinition(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => includesDefinition(actual[index], value))
    );
  if (typeof expected === 'object' && expected !== null) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      includesDefinition((actual as Record<string, unknown>)[key], value)
    );
  }
  return actual === expected;
}

/** Keep legacy approval resources for recovery and expose toolbar-only sending without changing records. */
export async function configureReplyPresentation(
  execute: Execute,
  table: ReplyTable,
  context?: ReplyPresentationContext
): Promise<ReplyTable> {
  validateTable(table);
  const saved = table.presentation;
  if (saved) {
    parse(FIELD_ID, saved.buttonFieldId);
    parse(FIELD_ID, saved.approvalTextFieldId);
    parse(WORKFLOW_ID, saved.workflowId);
    parse(VIEW_ID, saved.viewId);
    if (saved.timeDisplayFieldId) parse(FIELD_ID, saved.timeDisplayFieldId);
    if (saved.commentLinkFieldId) parse(FIELD_ID, saved.commentLinkFieldId);
    if (
      new Set([
        ...Object.values(table.fields),
        saved.buttonFieldId,
        saved.approvalTextFieldId,
        ...(saved.timeDisplayFieldId ? [saved.timeDisplayFieldId] : []),
        ...(saved.commentLinkFieldId ? [saved.commentLinkFieldId] : []),
      ]).size !==
      Object.keys(table.fields).length + 2 + (saved.timeDisplayFieldId ? 1 : 0) + (saved.commentLinkFieldId ? 1 : 0)
    )
      throw new Error('replyPresentationConflict');
  }
  const call = async (args: string[]): Promise<unknown> => {
    let result: unknown;
    try {
      result = await execute(args);
    } catch {
      throw new Error('replyCliFailed');
    }
    return parse(responseSchema, result).data;
  };
  let authValue: unknown;
  try {
    authValue = await execute(['auth', 'status', '--json']);
  } catch {
    throw new Error('replyCliFailed');
  }
  const auth = parse(authSchema, authValue);
  if (
    auth.verified === false ||
    !auth.identities.user.available ||
    !['ready', 'valid', 'needs_refresh'].includes(auth.identities.user.status)
  )
    throw new Error('replyLoginRequired');
  const granted = new Set((auth.identities.user.scope ?? '').split(/\s+/));
  if (PRESENTATION_SCOPES.some((scope) => !granted.has(scope))) throw new Error('replyMissingPermissions');

  const base = ['--base-token', table.baseToken, '--as', 'user'];
  const target = [...base, '--table-id', table.tableId];
  const listFields = async () => parse(fieldsSchema, await call(['base', '+field-list', ...target])).fields;
  const listViews = async () => {
    const result = parse(viewsSchema, await call(['base', '+view-list', ...target]));
    if (result.views.length !== result.total) throw new Error('replyPresentationUnverified');
    return result.views;
  };
  const listWorkflows = async () => {
    const result = parse(workflowsSchema, await call(['base', '+workflow-list', ...base]));
    const workflows = result.items ?? [];
    if (workflows.length !== result.total) throw new Error('replyPresentationUnverified');
    return workflows;
  };
  // Discover every resource before any write, including retries after uncertain creation responses.
  const [initialFields, initialViews, initialWorkflows, tables] = await Promise.all([
    listFields(),
    listViews(),
    listWorkflows(),
    call(['base', '+table-list', ...base]).then(
      (value) => parse(z.object({ tables: z.array(z.object({ id: z.string(), name: z.string() })) }), value).tables
    ),
  ]);
  const statusField = one(initialFields.filter((field) => field.id === table.fields.status));
  if (!statusField || !['text', 'select'].includes(statusField.type)) throw new Error('replyFieldSchemaChanged');
  if (statusField.type === 'select' && !saved?.statusFieldType && !context?.migration)
    throw new Error('replyPresentationConflict');
  if (statusField.type === 'text' && saved?.statusFieldType) throw new Error('replyFieldSchemaChanged');
  inspectFields(table, {
    fields: initialFields.map((field) =>
      field.id === table.fields.status && statusField.type === 'select' && !saved?.statusFieldType
        ? { ...field, type: 'text' }
        : field
    ),
  });
  const actualTable = one(tables.filter((entry) => entry.id === table.tableId));
  if (!actualTable || tables.filter((entry) => entry.name === actualTable.name).length !== 1)
    throw new Error('replyPresentationConflict');
  if (new Set(initialFields.map((field) => field.name)).size !== initialFields.length)
    throw new Error('replyPresentationConflict');
  let fields = initialFields;
  let button = matchingField(fields, '发送', 'button', saved?.buttonFieldId);
  let approved = matchingField(fields, '本次待发内容', 'text', saved?.approvalTextFieldId);
  let commentLink = matchingField(fields, '原评论', 'text', saved?.commentLinkFieldId);
  const verifyCommentLink = async (id: string) => {
    const { field } = parse(
      z.object({ field: fieldSchema }),
      await call(['base', '+field-get', ...target, '--field-id', id])
    );
    if (field.id !== id || field.type !== 'text' || !includesDefinition(field.style, { type: 'url' }))
      throw new Error('replyPresentationConflict');
  };
  if (commentLink) await verifyCommentLink(commentLink.id);
  let displayTime = matchingField(
    fields.filter((field) => field.id !== table.fields.time),
    '时间',
    'formula',
    saved?.timeDisplayFieldId
  );
  const verifyTimeFormula = async (id: string) => {
    const { field } = parse(
      z.object({ field: fieldSchema }),
      await call(['base', '+field-get', ...target, '--field-id', id])
    );
    if (field.id !== id || field.type !== 'formula' || field.expression !== TIME_EXPRESSION)
      throw new Error('replyPresentationConflict');
  };
  if (displayTime) await verifyTimeFormula(displayTime.id);
  let view = one(initialViews.filter((entry) => (saved ? entry.id === saved.viewId : entry.name === '回复工作台')));
  if ((saved && !view) || (view && view.type !== 'grid')) throw new Error('replyPresentationConflict');
  const platformViews = PLATFORM_VIEWS.map((definition) => {
    const existing = one(initialViews.filter((entry) => entry.name === definition.name));
    if (existing && existing.type !== 'grid') throw new Error('replyPresentationConflict');
    return { ...definition, view: existing };
  });
  const platformFilter = (platform: string) => ({
    logic: 'and',
    conditions: [[table.fields.platform, '==', platform]],
  });
  const readFilter = async (viewId: string) => {
    const value = parse(
      z.object({
        filter: z
          .object({ logic: z.enum(['and', 'or']).optional(), conditions: z.array(z.array(z.unknown())).optional() })
          .nullable(),
      }),
      await call(['base', '+view-get-filter', ...target, '--view-id', viewId])
    );
    return {
      logic: value.filter?.logic ?? 'and',
      conditions: (value.filter?.conditions ?? []).map((condition) => {
        const field = one(fields.filter((entry) => entry.id === condition[0] || entry.name === condition[0]));
        if (!field) throw new Error('replyPresentationUnverified');
        return [field.id, ...condition.slice(1)];
      }),
    };
  };
  await Promise.all(
    platformViews.map(async (entry) => {
      if (!entry.view) return;
      const filter = await readFilter(entry.view.id);
      if (filter.conditions.length && !includesDefinition(filter, platformFilter(entry.platform)))
        throw new Error('replyPresentationConflict');
    })
  );
  const workflowTitle = `工作台评论发送 · ${table.tableId}`;
  let workflow: Workflow | undefined = one(
    initialWorkflows.filter((entry) => (saved ? entry.workflow_id === saved.workflowId : entry.title === workflowTitle))
  );
  if (saved && !workflow) throw new Error('replyPresentationConflict');
  for (const [id, label] of [
    [table.fields.draft, '我的回复'],
    [table.fields.status, '状态'],
    [table.fields.time, '时间原值'],
  ]) {
    if (fields.some((field) => field.name === label && field.id !== id)) throw new Error('replyPresentationConflict');
  }
  const binding = async (fieldId: string) => {
    const value = parse(
      z.object({
        bound: z.boolean(),
        target: z.object({ type: z.string(), id: z.string() }).nullable().optional(),
        workflow_id: z.string().optional(),
      }),
      await call(['base', '+button-rule-get', ...target, '--field-id', fieldId])
    );
    if (!value.bound) return undefined;
    if (value.target?.type === 'workflow') return parse(WORKFLOW_ID, value.target.id);
    if (!value.target && value.workflow_id) return parse(WORKFLOW_ID, value.workflow_id);
    throw new Error('replyPresentationConflict');
  };
  const previousBinding = button ? await binding(button.id) : undefined;
  if (previousBinding && previousBinding !== workflow?.workflow_id) throw new Error('replyPresentationConflict');

  let preflightDetail: z.infer<typeof workflowDetailSchema> | undefined;
  if (workflow) {
    if (!approved) throw new Error('replyPresentationConflict');
    const detail = parse(
      workflowDetailSchema,
      await call(['base', '+workflow-get', ...base, '--workflow-id', workflow.workflow_id])
    );
    preflightDetail = detail;
    const expectedFields = fields.map((field) =>
      field.id === table.fields.status ? { ...field, name: '状态' } : field
    );
    const captureVersions =
      saved?.replyCaptureVersion === 1 && saved.statusFieldType && !context?.migration ? [true] : [false, true];
    const valid = captureVersions.some(
      (captureReplies) =>
        (saved?.statusFieldType && !context?.migration ? [true] : [false, true]).some((select) =>
          includesDefinition(
            detail.steps,
            stepsFor(actualTable.name, expectedFields, table, approved!.id, select, false, captureReplies)
          )
        ) ||
        (!!context?.migration &&
          statusField.type === 'select' &&
          includesDefinition(
            detail.steps,
            stepsFor(actualTable.name, expectedFields, table, approved!.id, false, true, captureReplies)
          ))
    );
    if (
      detail.workflow_id !== workflow.workflow_id ||
      detail.title !== workflowTitle ||
      !valid ||
      detail.steps.some((step) => {
        const data = step.data as Record<string, unknown> | undefined;
        return data?.ref_info && data.filter_info;
      })
    )
      throw new Error('replyPresentationConflict');
  }

  const readStatuses = async (type: string): Promise<Record<string, string>> => {
    const records: Record<string, string> = {};
    let offset = 0;
    let revision: number | undefined;
    for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
      // Pagination must use a consistent revision and follow the returned offset.
      // eslint-disable-next-line no-await-in-loop
      const page = parse(
        recordPageSchema,
        await call([
          'base',
          '+record-list',
          ...target,
          '--field-id',
          table.fields.status,
          '--limit',
          '200',
          '--offset',
          String(offset),
          '--json',
        ])
      );
      if (
        page.field_id_list.length !== 1 ||
        page.field_id_list[0] !== table.fields.status ||
        page.field_type_list.length !== 1 ||
        page.field_type_list[0] !== type ||
        page.data.length !== page.record_id_list.length ||
        (revision !== undefined && revision !== page.rev)
      )
        throw new Error('replyPresentationUnverified');
      revision = page.rev;
      page.record_id_list.forEach((id, index) => {
        if (Object.hasOwn(records, id) || page.data[index].length !== 1) throw new Error('replyPresentationUnverified');
        const value = page.data[index][0];
        if (type === 'text') {
          if (value !== null && typeof value !== 'string') throw new Error('replyFieldValueInvalid');
          records[id] = typeof value === 'string' ? value : '';
        } else {
          if (
            value !== null &&
            (!Array.isArray(value) || value.length > 1 || value.some((item) => typeof item !== 'string' || !item))
          )
            throw new Error('replyFieldValueInvalid');
          records[id] = Array.isArray(value) && value.length ? (value[0] as string) : '';
        }
      });
      if (!page.has_more) return records;
      const next = page.next_offset ?? offset + page.data.length;
      if (page.data.length === 0 || next <= offset) throw new Error('replyPresentationUnverified');
      offset = next;
    }
    throw new Error('replyPresentationUnverified');
  };
  const sameRecords = (left: Record<string, string>, right: Record<string, string>) => {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((id) => Object.hasOwn(right, id) && right[id] === left[id])
    );
  };
  const getStatusField = async () =>
    parse(
      z.object({ field: fieldSchema }),
      await call(['base', '+field-get', ...target, '--field-id', table.fields.status])
    ).field;
  const statusDefinition = await getStatusField();
  if (statusDefinition.id !== table.fields.status || statusDefinition.type !== statusField.type)
    throw new Error('replyFieldSchemaChanged');
  const optionSchema = z.object({ name: z.string().min(1) }).passthrough();
  const existingOptions =
    statusDefinition.type === 'select' ? parse(z.array(optionSchema), statusDefinition.options) : [];
  const textDefault = statusDefinition.type === 'text' ? statusDefinition.default_value : undefined;
  if (textDefault !== undefined && textDefault !== null && typeof textDefault !== 'string')
    throw new Error('replyFieldSchemaChanged');
  if (statusDefinition.type === 'select' && statusDefinition.multiple !== false)
    throw new Error('replyFieldSchemaChanged');
  if (new Set(existingOptions.map((option) => option.name)).size !== existingOptions.length)
    throw new Error('replyFieldSchemaChanged');
  let migration = context?.migration;
  const upgradingStatus = !saved?.statusFieldType || saved.replyCaptureVersion !== 1;
  const migrating =
    !!migration || upgradingStatus || saved?.sendMode !== 'toolbar' || preflightDetail?.status === 'enabled';
  if (migrating) {
    if (!context) throw new Error('replyPresentationUnverified');
    const records = await readStatuses(statusField.type);
    if (migration) {
      if (
        migration.baseToken !== table.baseToken ||
        migration.tableId !== table.tableId ||
        migration.statusFieldId !== table.fields.status ||
        (migration.workflowId && migration.workflowId !== workflow?.workflow_id) ||
        !sameRecords(records, migration.records)
      )
        throw new Error('replyPresentationConflict');
    } else {
      migration = {
        baseToken: table.baseToken,
        tableId: table.tableId,
        statusFieldId: table.fields.status,
        ...(workflow ? { workflowId: workflow.workflow_id } : {}),
        workflowEnabled: preflightDetail ? preflightDetail.status === 'enabled' : true,
        records,
      };
      context.saveMigration(migration);
    }
    if (workflow && preflightDetail?.status === 'enabled') {
      await call(['base', '+workflow-disable', ...base, '--workflow-id', workflow.workflow_id]);
      const detail = parse(
        workflowDetailSchema,
        await call(['base', '+workflow-get', ...base, '--workflow-id', workflow.workflow_id])
      );
      if (detail.status !== 'disabled') throw new Error('replyPresentationUnverified');
    }
    if (!sameRecords(await readStatuses(statusField.type), migration.records))
      throw new Error('replyPresentationConflict');
  }
  const options = [
    ...existingOptions.filter((option) => !STATUS_OPTIONS.some((canonical) => canonical.name === option.name)),
    ...STATUS_OPTIONS.map((canonical) => ({
      ...existingOptions.find((option) => option.name === canonical.name),
      ...canonical,
    })),
  ];
  if (!options.some((option) => option.name === '待核对')) options.push({ name: '待核对' } as (typeof options)[number]);
  for (const value of Object.values(migration?.records ?? {}))
    if (value && !options.some((option) => option.name === value))
      options.push({ name: value } as (typeof options)[number]);
  if (typeof textDefault === 'string' && textDefault && !options.some((option) => option.name === textDefault))
    options.push({ name: textDefault } as (typeof options)[number]);
  if (migrating && upgradingStatus) {
    const definition = Object.fromEntries(
      Object.entries(statusDefinition).filter(
        ([key]) => !['id', 'field_id', '_meta'].includes(key) && !(statusDefinition.type === 'text' && key === 'style')
      )
    );
    if (typeof textDefault === 'string') definition.default_value = textDefault ? [textDefault] : [];
    await call([
      'base',
      '+field-update',
      ...target,
      '--field-id',
      table.fields.status,
      '--yes',
      '--json',
      JSON.stringify({ ...definition, type: 'select', multiple: false, options }),
    ]);
    const optionsMatch = (value: unknown) => {
      const parsed = z.array(optionSchema).safeParse(value);
      if (
        !parsed.success ||
        parsed.data.length !== options.length ||
        new Set(parsed.data.map((option) => option.name)).size !== parsed.data.length
      )
        return false;
      return options.every((option) => {
        const actual = parsed.data.find((item) => item.name === option.name);
        return !!actual && includesDefinition(actual, option);
      });
    };
    let verified = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      // A field update can become visible after the write response; retry reads only.
      // eslint-disable-next-line no-await-in-loop
      const updated = await getStatusField();
      if (
        updated.id === table.fields.status &&
        updated.type === 'select' &&
        updated.multiple === false &&
        optionsMatch(updated.options)
      ) {
        verified = true;
        break;
      }
      if (attempt < 2) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    if (!verified) throw new Error('replyPresentationUnverified');
    if (!sameRecords(await readStatuses('select'), migration!.records)) throw new Error('replyPresentationUnverified');
  } else if (
    !STATUS_OPTIONS.every((option) => existingOptions.some((existing) => includesDefinition(existing, option)))
  ) {
    throw new Error('replyPresentationConflict');
  }

  const ensureField = async (
    name: string,
    type: 'text' | 'button' | 'formula',
    style?: { type: 'url' }
  ): Promise<Field> => {
    let failure: unknown;
    try {
      await call([
        'base',
        '+field-create',
        ...target,
        ...(type === 'formula' ? ['--i-have-read-guide'] : []),
        '--json',
        JSON.stringify({
          name,
          type,
          ...(style ? { style } : {}),
          ...(type === 'button' ? { button_config: { title: '发送' } } : {}),
          ...(type === 'formula'
            ? { expression: TIME_EXPRESSION, description: '北京时间（UTC+8），原始时间保留在隐藏列。' }
            : {}),
        }),
      ]);
    } catch (error) {
      failure = error;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      // Creation can reach Feishu before field-list reflects it; retry reads, never creation.
      // eslint-disable-next-line no-await-in-loop
      fields = await listFields();
      const result = matchingField(fields, name, type);
      if (result) return result;
      if (attempt < 2) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw failure ?? new Error('replyPresentationUnverified');
  };
  for (const [id, name] of [
    [table.fields.draft, '我的回复'],
    [table.fields.status, '状态'],
    [table.fields.time, '时间原值'],
  ]) {
    if (fields.find((field) => field.id === id)?.name === name) continue;
    const { field } = parse(
      z.object({ field: fieldSchema }),
      await call(['base', '+field-get', ...target, '--field-id', id])
    );
    if (field.id !== id || field.type !== (id === table.fields.status ? 'select' : 'text'))
      throw new Error('replyFieldSchemaChanged');
    const definition = Object.fromEntries(
      Object.entries(field).filter(([key]) => !['id', 'field_id', '_meta'].includes(key))
    );
    await call([
      'base',
      '+field-update',
      ...target,
      '--field-id',
      id,
      '--yes',
      '--json',
      JSON.stringify({ ...definition, name }),
    ]);
  }
  fields = await listFields();
  inspectFields(table, {
    fields: fields.map((field) =>
      field.id === table.fields.status && !saved?.statusFieldType ? { ...field, type: 'text' } : field
    ),
  });
  if (
    fields.find((field) => field.id === table.fields.draft)?.name !== '我的回复' ||
    fields.find((field) => field.id === table.fields.status)?.name !== '状态' ||
    fields.find((field) => field.id === table.fields.time)?.name !== '时间原值'
  )
    throw new Error('replyPresentationUnverified');
  button ??= await ensureField('发送', 'button');
  approved ??= await ensureField('本次待发内容', 'text');
  displayTime ??= await ensureField('时间', 'formula');
  await verifyTimeFormula(displayTime.id);
  commentLink ??= await ensureField('原评论', 'text', { type: 'url' });
  await verifyCommentLink(commentLink.id);

  const ensureView = async (name: string) => {
    let failure: unknown;
    try {
      await call(['base', '+view-create', ...target, '--json', JSON.stringify({ name, type: 'grid' })]);
    } catch (error) {
      failure = error;
    }
    const created = one((await listViews()).filter((entry) => entry.name === name));
    if (!created || created.type !== 'grid') throw failure ?? new Error('replyPresentationUnverified');
    return created;
  };
  view ??= await ensureView('回复工作台');
  const visibleFields = [
    table.fields.author,
    displayTime.id,
    table.fields.comment,
    commentLink.id,
    table.fields.draft,
    table.fields.status,
  ];
  const readVisible = async (viewId: string) => {
    const value = parse(
      z.object({ visible_fields: z.array(z.string()) }),
      await call(['base', '+view-get-visible-fields', ...target, '--view-id', viewId])
    );
    return value.visible_fields.map((reference) => {
      const field = one(fields.filter((entry) => entry.id === reference || entry.name === reference));
      if (!field) throw new Error('replyPresentationUnverified');
      return field.id;
    });
  };
  const configureVisible = async (viewId: string, desired: string[]) => {
    if (!includesDefinition(await readVisible(viewId), desired)) {
      await call([
        'base',
        '+view-set-visible-fields',
        ...target,
        '--view-id',
        viewId,
        '--json',
        JSON.stringify({ visible_fields: desired }),
      ]);
      if (!includesDefinition(await readVisible(viewId), desired)) throw new Error('replyPresentationUnverified');
    }
  };
  const configureView = async (viewId: string) => {
    await configureVisible(viewId, visibleFields);
    const desiredSort = [{ field: table.fields.time, desc: true }];
    const readSort = async () => {
      const value = parse(
        z.object({ sort: z.array(z.object({ field: z.string(), desc: z.boolean() })) }),
        await call(['base', '+view-get-sort', ...target, '--view-id', viewId])
      );
      return value.sort.map((sort) => {
        const field = one(fields.filter((entry) => entry.id === sort.field || entry.name === sort.field));
        if (!field) throw new Error('replyPresentationUnverified');
        return { field: field.id, desc: sort.desc };
      });
    };
    if (!includesDefinition(await readSort(), desiredSort)) {
      await call([
        'base',
        '+view-set-sort',
        ...target,
        '--view-id',
        viewId,
        '--json',
        JSON.stringify({ sort_config: desiredSort }),
      ]);
      if (!includesDefinition(await readSort(), desiredSort)) throw new Error('replyPresentationUnverified');
    }
  };
  await configureView(view.id);
  const managedViewIds = new Set([view.id]);
  for (const entry of platformViews) {
    const platformView = entry.view ?? (await ensureView(entry.name));
    managedViewIds.add(platformView.id);
    const desiredFilter = platformFilter(entry.platform);
    const currentFilter = await readFilter(platformView.id);
    if (!includesDefinition(currentFilter, desiredFilter)) {
      if (currentFilter.conditions.length) throw new Error('replyPresentationConflict');
      await call([
        'base',
        '+view-set-filter',
        ...target,
        '--view-id',
        platformView.id,
        '--json',
        JSON.stringify(desiredFilter),
      ]);
      if (!includesDefinition(await readFilter(platformView.id), desiredFilter))
        throw new Error('replyPresentationUnverified');
    }
    await configureView(platformView.id);
  }
  for (const otherView of initialViews.filter((entry) => entry.type === 'grid' && !managedViewIds.has(entry.id))) {
    // Keep each view's read-modify-verify sequence ordered without replacing unrelated settings.
    // eslint-disable-next-line no-await-in-loop
    const current = await readVisible(otherView.id);
    if (current.includes(button.id))
      // eslint-disable-next-line no-await-in-loop
      await configureVisible(
        otherView.id,
        current.filter((id) => id !== button.id)
      );
  }

  const steps = stepsFor(actualTable.name, fields, table, approved.id, true);
  if (!workflow) {
    let failure: unknown;
    try {
      await call([
        'base',
        '+workflow-create',
        ...base,
        '--json',
        JSON.stringify({
          client_token: createHash('sha256')
            .update(`${table.baseToken}:${table.tableId}:reply-button-v1`)
            .digest('hex')
            .slice(0, 32),
          title: workflowTitle,
          steps,
        }),
      ]);
    } catch (error) {
      failure = error;
    }
    workflow = one((await listWorkflows()).filter((entry) => entry.title === workflowTitle));
    if (!workflow) throw failure ?? new Error('replyPresentationUnverified');
  }
  const workflowId = workflow.workflow_id;
  const getWorkflow = async () =>
    parse(workflowDetailSchema, await call(['base', '+workflow-get', ...base, '--workflow-id', workflowId]));
  let detail = await getWorkflow();
  const recognizedOldSteps = [false, true].some(
    (captureReplies) =>
      [false, true].some((select) =>
        includesDefinition(
          detail.steps,
          stepsFor(actualTable.name, fields, table, approved!.id, select, false, captureReplies)
        )
      ) ||
      (!!migration &&
        includesDefinition(
          detail.steps,
          stepsFor(actualTable.name, fields, table, approved!.id, false, true, captureReplies)
        ))
  );
  if (!includesDefinition(detail.steps, steps) && migrating && recognizedOldSteps) {
    await call([
      'base',
      '+workflow-update',
      ...base,
      '--workflow-id',
      workflowId,
      '--json',
      JSON.stringify({ title: detail.title, steps }),
    ]);
    detail = await getWorkflow();
  }
  if (
    detail.workflow_id !== workflowId ||
    !includesDefinition(detail.steps, steps) ||
    detail.steps.some((step) => {
      const data = step.data as Record<string, unknown> | undefined;
      return data?.ref_info && data.filter_info;
    })
  )
    throw new Error('replyPresentationConflict');
  if (previousBinding !== workflowId) {
    await call(['base', '+button-rule-bind', ...target, '--field-id', button.id, '--workflow-id', workflowId]);
    if ((await binding(button.id)) !== workflowId) throw new Error('replyPresentationUnverified');
  }
  if (migrating && !sameRecords(await readStatuses('select'), migration!.records))
    throw new Error('replyPresentationConflict');
  if (detail.status !== 'disabled') {
    await call(['base', '+workflow-disable', ...base, '--workflow-id', workflowId]);
  }
  const finalWorkflow = await getWorkflow();
  if (
    finalWorkflow.workflow_id !== workflowId ||
    finalWorkflow.status !== 'disabled' ||
    !includesDefinition(finalWorkflow.steps, steps)
  )
    throw new Error('replyPresentationUnverified');
  const url = new URL(table.url);
  url.searchParams.set('view', view.id);
  return {
    ...table,
    url: url.toString(),
    presentation: {
      buttonFieldId: button.id,
      approvalTextFieldId: approved.id,
      workflowId,
      viewId: view.id,
      timeDisplayFieldId: displayTime.id,
      statusFieldType: 'select',
      commentLinkFieldId: commentLink.id,
      replyCaptureVersion: 1,
      sendMode: 'toolbar',
    },
  };
}
