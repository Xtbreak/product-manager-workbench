import { describe, expect, it, vi } from 'vitest';
import type { ReplyTable } from '@/common/types/platform/workbenchReply';
import { configureReplyPresentation } from '@/process/services/workbench/replies/feishuPresentation';
import { REPLY_FIELDS } from '@/process/services/workbench/replies/feishuSchema';
import type { ReplyStatusMigration } from '@/process/services/workbench/replies/contracts';

const fields = Object.fromEntries(REPLY_FIELDS.map(({ key }) => [key, `fld${key}`])) as ReplyTable['fields'];
const table: ReplyTable = {
  baseToken: 'baseExample',
  tableId: 'tblReply',
  url: 'https://example.feishu.cn/base/baseExample?table=tblReply',
  fields,
};
type Field = { id: string; name: string; type: string; style?: unknown; button_config?: unknown; expression?: string };
type Workflow = { workflow_id: string; title: string; status: string; steps: unknown[] };
type WorkflowStepData = {
  data: {
    condition: { conditions: Array<{ conditions: Array<{ right_value: unknown[] }> }> };
    field_values: Array<{ value: unknown[] }>;
    ref_info: { step_id: string };
  };
};
const ok = (data: unknown) => ({ ok: true, data });
const scopes = [
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
function harness() {
  const state = {
    scopes: [...scopes],
    fields: REPLY_FIELDS.map(({ key, name, type }) => ({ id: fields[key], name, type })) as Field[],
    views: [{ id: 'vewOriginal', name: '表格', type: 'grid' }],
    workflows: [{ workflow_id: 'wkfUnrelated', title: '工作流', status: 'disabled', steps: [] }] as Workflow[],
    visible: new Map<string, string[]>(),
    sort: new Map<string, Array<{ field: string; desc: boolean }>>(),
    filter: new Map<string, unknown>(),
    binding: undefined as string | undefined,
    failAfterCreate: false,
    failBeforeCreate: false,
    corruptBinding: false,
    normalizeWorkflowRead: false,
    records: { recOne: '待处理', recTwo: '旧状态' } as Record<string, string>,
    migration: undefined as ReplyStatusMigration | undefined,
    failWorkflowUpdate: false,
    corruptConversion: false,
    badRevision: false,
    nullEmptySelect: false,
    reverseOptionsRead: false,
    staleAfterConversion: false,
    staleReadsRemaining: 0,
  };
  const context = {
    get migration() {
      return state.migration;
    },
    saveMigration(snapshot: ReplyStatusMigration) {
      state.migration = structuredClone(snapshot);
    },
  };
  const execute = vi.fn(async (args: string[]) => {
    const arg = (key: string) => args[args.indexOf(key) + 1];
    const body = () => JSON.parse(arg('--json')) as Record<string, unknown>;
    if (args[0] === 'auth')
      return {
        appId: 'app',
        brand: 'feishu',
        identities: { user: { available: true, status: 'ready', scope: state.scopes.join(' ') } },
      };
    switch (args[1]) {
      case '+table-list':
        return ok({ tables: [{ id: table.tableId, name: '评论回复' }], total: 1 });
      case '+field-list':
        return ok({ fields: structuredClone(state.fields) });
      case '+field-get': {
        const field = structuredClone(state.fields.find((entry) => entry.id === arg('--field-id'))) as Field & {
          options?: unknown[];
        };
        if (field.id === fields.status && field.type === 'select' && state.staleReadsRemaining > 0) {
          state.staleReadsRemaining--;
          return ok({ field: { id: field.id, name: field.name, type: 'text' } });
        }
        if (field.id === fields.status && field.options && state.reverseOptionsRead) field.options.reverse();
        return ok({ field });
      }
      case '+field-update': {
        const field = state.fields.find((entry) => entry.id === arg('--field-id'))!;
        if (body().type === 'select' && body().style !== undefined) throw new Error('Unrecognized key(s): style');
        if (body().type === 'select') delete field.style;
        Object.assign(field, body());
        if (field.id === fields.status && field.type === 'select' && state.staleAfterConversion)
          state.staleReadsRemaining = 1;
        if (field.id === fields.status && field.type === 'select' && state.corruptConversion) state.records.recOne = '';
        return ok({ field });
      }
      case '+record-list': {
        const status = state.fields.find((field) => field.id === fields.status)!;
        const offset = Number(arg('--offset'));
        const all = Object.entries(state.records);
        const rows = all.slice(offset, offset + 1);
        return ok({
          field_id_list: [fields.status],
          field_type_list: [status.type],
          record_id_list: rows.map(([id]) => id),
          data: rows.map(([, value]) => [
            status.type === 'select' ? (value ? [value] : state.nullEmptySelect ? null : []) : value,
          ]),
          rev: state.badRevision ? offset + 1 : 1,
          has_more: offset + rows.length < all.length,
          next_offset: offset + rows.length,
        });
      }
      case '+field-create': {
        if (state.failBeforeCreate) throw new Error('access_token=private');
        const field = { ...body(), id: `fldNew${state.fields.length}` } as Field;
        state.fields.push(field);
        if (state.failAfterCreate) {
          state.failAfterCreate = false;
          throw new Error('timed out');
        }
        return ok({ field, created: true });
      }
      case '+view-list':
        return ok({ views: structuredClone(state.views), total: state.views.length });
      case '+view-create': {
        const view = {
          ...body(),
          id: state.views.length === 1 ? 'vewReplies' : `vewManaged${state.views.length}`,
        } as (typeof state.views)[number];
        state.views.push(view);
        return ok({ views: [view] });
      }
      case '+view-get-visible-fields':
        return ok({
          visible_fields: (state.visible.get(arg('--view-id')) ?? []).map(
            (id) => state.fields.find((field) => field.id === id)?.name ?? id
          ),
        });
      case '+view-set-visible-fields':
        state.visible.set(arg('--view-id'), body().visible_fields as string[]);
        return ok({});
      case '+view-get-sort':
        return ok({ sort: state.sort.get(arg('--view-id')) ?? [] });
      case '+view-set-sort':
        state.sort.set(arg('--view-id'), body().sort_config as Array<{ field: string; desc: boolean }>);
        return ok({});
      case '+view-get-filter':
        return ok({ filter: state.filter.get(arg('--view-id')) ?? null });
      case '+view-set-filter':
        state.filter.set(arg('--view-id'), body());
        return ok({});
      case '+workflow-list':
        return ok({ items: structuredClone(state.workflows), total: state.workflows.length });
      case '+workflow-create': {
        const workflow = { ...body(), workflow_id: 'wkfReply', status: 'disabled' } as Workflow;
        state.workflows.push(workflow);
        return ok({ workflow_id: workflow.workflow_id });
      }
      case '+workflow-get': {
        const workflow = structuredClone(state.workflows.find((entry) => entry.workflow_id === arg('--workflow-id')));
        if (!state.normalizeWorkflowRead) return ok(workflow);
        // Real Feishu readback omits unary operands and null terminal edges.
        const normalized: unknown = JSON.parse(
          JSON.stringify(workflow, (key, value: unknown) =>
            (key === 'right_value' && Array.isArray(value) && value.length === 0) || (key === 'next' && value === null)
              ? undefined
              : value
          )
        );
        return ok(normalized);
      }
      case '+workflow-enable':
        state.workflows.find((entry) => entry.workflow_id === arg('--workflow-id'))!.status = 'enabled';
        return ok({});
      case '+workflow-disable':
        state.workflows.find((entry) => entry.workflow_id === arg('--workflow-id'))!.status = 'disabled';
        return ok({});
      case '+workflow-update':
        if (state.failWorkflowUpdate) throw new Error('failed');
        Object.assign(state.workflows.find((entry) => entry.workflow_id === arg('--workflow-id'))!, body());
        return ok({});
      case '+button-rule-get':
        return ok({ bound: !!state.binding, target: state.binding ? { type: 'workflow', id: state.binding } : null });
      case '+button-rule-bind':
        state.binding = state.corruptBinding ? 'wkfForeign' : arg('--workflow-id');
        return ok({});
      default:
        throw new Error(`Unexpected command ${args[1]}`);
    }
  });
  return { state, execute, context };
}
const writes = (execute: ReturnType<typeof harness>['execute']) =>
  execute.mock.calls
    .map(([args]) => args)
    .filter((args) => /create|update|set-visible|set-sort|set-filter|bind$|enable/.test(args[1]));

describe('Feishu reply presentation provisioning', () => {
  it('preserves historical statuses and creates the colored single-select workflow', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const status = h.state.fields.find((field) => field.id === fields.status)!;
    expect(status).toMatchObject({
      type: 'select',
      multiple: false,
      options: expect.arrayContaining([
        { name: '待处理', hue: 'Gray', lightness: 'Lighter' },
        { name: '旧状态' },
        { name: '已发送', hue: 'Green', lightness: 'Lighter' },
      ]),
    });
    expect(h.state.records).toEqual({ recOne: '待处理', recTwo: '旧状态' });
    expect(configured.presentation?.statusFieldType).toBe('select');
    const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
    expect(JSON.stringify(workflow.steps)).toContain('"value_type":"option","value":{"name":"待发送"}');
    const check = workflow.steps.find((step) => (step as { type: string }).type === 'IfElseBranch') as {
      data: { condition: { conditions: Array<{ conditions: Array<{ operator: string; right_value?: unknown[] }> }> } };
    };
    const exclusions = check.data.condition.conditions[0].conditions.filter(
      (condition) => condition.operator === 'isNot'
    );
    expect(exclusions).toHaveLength(7);
    expect(
      exclusions.every((condition) => (condition.right_value![0] as { value_type: string }).value_type === 'option')
    ).toBe(true);
    expect(h.state.migration?.records).toEqual(h.state.records);
  });

  it('accepts an empty select cell returned as null during readback', async () => {
    const h = harness();
    h.state.records.recOne = '';
    h.state.nullEmptySelect = true;
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    expect(configured.presentation?.statusFieldType).toBe('select');
    expect(h.state.migration?.records.recOne).toBe('');
  });

  it('converts the real text field definition without sending text-only style and preserves its default', async () => {
    const h = harness();
    Object.assign(h.state.fields.find((field) => field.id === fields.status)!, {
      style: { type: 'plain' },
      default_value: '旧默认值',
      description: '状态说明',
    });
    await configureReplyPresentation(h.execute, table, h.context);
    const update = h.execute.mock.calls
      .map(([args]) => args)
      .find((args) => args[1] === '+field-update' && JSON.parse(args[args.indexOf('--json') + 1]).type === 'select')!;
    expect(JSON.parse(update[update.indexOf('--json') + 1])).toMatchObject({
      type: 'select',
      description: '状态说明',
      default_value: ['旧默认值'],
      options: expect.arrayContaining([{ name: '旧默认值' }]),
    });
    expect(JSON.parse(update[update.indexOf('--json') + 1])).not.toHaveProperty('style');
  });

  it('keeps a null default when converting the real text field definition', async () => {
    const h = harness();
    Object.assign(h.state.fields.find((field) => field.id === fields.status)!, {
      style: { type: 'plain' },
      default_value: null,
    });
    await configureReplyPresentation(h.execute, table, h.context);
    const update = h.execute.mock.calls
      .map(([args]) => args)
      .find((args) => args[1] === '+field-update' && JSON.parse(args[args.indexOf('--json') + 1]).type === 'select')!;
    expect(JSON.parse(update[update.indexOf('--json') + 1])).toMatchObject({ default_value: null });
  });

  it('accepts reordered options and a transient stale field read after conversion', async () => {
    const h = harness();
    h.state.reverseOptionsRead = true;
    h.state.staleAfterConversion = true;
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    expect(configured.presentation?.statusFieldType).toBe('select');
  });

  it('resumes when field conversion cleared only status operands in the old workflow', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
    const steps = workflow.steps as WorkflowStepData[];
    for (const condition of steps[1].data.condition.conditions[0].conditions.slice(2)) condition.right_value = [];
    steps[2].data.field_values[2].value = [];
    workflow.status = 'disabled';
    const legacy = { ...configured, presentation: { ...configured.presentation!, statusFieldType: undefined } };
    const recovered = await configureReplyPresentation(h.execute, legacy, h.context);
    expect(recovered.presentation?.statusFieldType).toBe('select');
    expect(workflow.status).toBe('disabled');
    expect(JSON.stringify(workflow.steps)).toContain('"value_type":"option","value":{"name":"待发送"}');
  });

  it.each(['missing checkpoint', 'changed target'])(
    'rejects cleared workflow with %s before writes',
    async (change) => {
      const h = harness();
      const configured = await configureReplyPresentation(h.execute, table, h.context);
      const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
      const steps = workflow.steps as WorkflowStepData[];
      for (const condition of steps[1].data.condition.conditions[0].conditions.slice(2)) condition.right_value = [];
      steps[2].data.field_values[2].value = [];
      workflow.status = 'disabled';
      if (change === 'missing checkpoint') h.state.migration = undefined;
      else steps[2].data.ref_info.step_id = 'other';
      h.execute.mockClear();
      await expect(configureReplyPresentation(h.execute, configured, h.context)).rejects.toThrow(/conflict/i);
      expect(writes(h.execute)).toEqual([]);
    }
  );

  it('fails before writes when paginated status records have inconsistent revisions', async () => {
    const h = harness();
    h.state.badRevision = true;
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow(/unverified/i);
    expect(writes(h.execute)).toEqual([]);
    expect(h.state.migration).toBeUndefined();
  });

  it('retains the checkpoint when readback shows conversion lost a value', async () => {
    const h = harness();
    h.state.corruptConversion = true;
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow(/unverified/i);
    expect(h.state.migration?.records).toEqual({ recOne: '待处理', recTwo: '旧状态' });
    expect(h.state.fields.find((field) => field.id === fields.status)?.type).toBe('select');
    h.state.corruptConversion = false;
    h.execute.mockClear();
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow(/conflict/i);
    expect(writes(h.execute)).toEqual([]);
  });

  it.each(['enabled', 'disabled'])(
    'resumes an interrupted old workflow originally %s and leaves it disabled',
    async (originalStatus) => {
      const h = harness();
      const configured = await configureReplyPresentation(h.execute, table, h.context);
      const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
      workflow.steps = JSON.parse(
        JSON.stringify(workflow.steps).replaceAll(
          /\{"value_type":"option","value":\{"name":"([^"]+)"\}\}/g,
          '{"value_type":"text","value":"$1"}'
        )
      );
      workflow.status = originalStatus;
      const status = h.state.fields.find((field) => field.id === fields.status)!;
      status.type = 'text';
      h.state.migration = undefined;
      const legacy = { ...configured, presentation: { ...configured.presentation!, statusFieldType: undefined } };
      h.state.failWorkflowUpdate = true;
      await expect(configureReplyPresentation(h.execute, legacy, h.context)).rejects.toThrow(/failed/i);
      expect(workflow.status).toBe('disabled');
      expect(h.state.migration?.workflowEnabled).toBe(originalStatus === 'enabled');
      const converted = h.state.fields.find((field) => field.id === fields.status)! as Field & {
        options: Array<{ name: string; id?: string }>;
      };
      converted.options.find((option) => option.name === '旧状态')!.id = 'optKeep';
      h.state.failWorkflowUpdate = false;
      const result = await configureReplyPresentation(h.execute, legacy, h.context);
      expect(result.presentation?.statusFieldType).toBe('select');
      expect(workflow.status).toBe('disabled');
      expect(converted.options.find((option) => option.name === '旧状态')?.id).toBe('optKeep');
      expect(JSON.stringify(workflow.steps)).toContain('"value_type":"option","value":{"name":"待发送"}');
    }
  );

  it('rejects a multi-select status field before writing', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    Object.assign(h.state.fields.find((field) => field.id === fields.status)!, { multiple: true });
    h.state.migration = undefined;
    h.execute.mockClear();
    await expect(configureReplyPresentation(h.execute, configured, h.context)).rejects.toThrow(/changed/i);
    expect(writes(h.execute)).toEqual([]);
  });
  it('keeps original IDs and view while exposing only the six human-facing columns', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    expect(configured.fields).toEqual(table.fields);
    expect(h.state.visible.get(configured.presentation!.viewId)).toEqual([
      fields.author,
      configured.presentation!.timeDisplayFieldId,
      fields.comment,
      configured.presentation!.commentLinkFieldId,
      fields.draft,
      fields.status,
    ]);
    expect({ original: h.state.views[0], url: configured.url }).toEqual({
      original: { id: 'vewOriginal', name: '表格', type: 'grid' },
      url: `${table.url}&view=vewReplies`,
    });
  });

  it('retains the row-scoped legacy approval definition and repeat-click guards while disabling its workflow', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
    expect(workflow.steps).toContainEqual(
      expect.objectContaining({
        type: 'SetRecordAction',
        data: {
          table_name: '评论回复',
          ref_info: { step_id: 'clicked' },
          max_set_record_num: 1,
          field_values: [
            { field_name: '本次待发内容', value: [{ value_type: 'ref', value: `$.clicked.${fields.draft}` }] },
            { field_name: '可发送', value: [{ value_type: 'boolean', value: true }] },
            { field_name: '状态', value: [{ value_type: 'option', value: { name: '待发送' } }] },
          ],
        },
      })
    );
    const serialized = JSON.stringify(workflow.steps);
    expect(
      ['isNotEmpty', '已发送', '已回复', '本人评论', '发送中', '待发送', '需核对', '待核对', 'FindRecordAction'].every(
        (value) => serialized.includes(value)
      )
    ).toBe(true);
    expect(writes(h.execute).some((args) => /record-/.test(args[1]))).toBe(false);
  });

  it('shows the newest comments first without modifying the original view or time values', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    expect(h.state.sort.get(configured.presentation!.viewId)).toEqual([{ field: fields.time, desc: true }]);
    expect(h.state.sort.has('vewOriginal')).toBe(false);
    expect(h.state.fields.find((field) => field.id === fields.time)).toEqual({
      id: fields.time,
      name: '时间原值',
      type: 'text',
    });
  });

  it('uses supported BooleanCompare equality to require an unchecked approval', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
    expect(workflow.steps).toContainEqual(
      expect.objectContaining({
        type: 'IfElseBranch',
        data: {
          condition: {
            conjunction: 'or',
            conditions: [
              {
                conjunction: 'and',
                conditions: expect.arrayContaining([
                  {
                    left_value: { value_type: 'ref', value: `$.clicked.${fields.ready}` },
                    operator: 'is',
                    right_value: [{ value_type: 'boolean', value: false }],
                  },
                ]),
              },
            ],
          },
        },
      })
    );
  });

  it('reuses a completed configuration without adding or rewriting resources', async () => {
    const h = harness();
    const first = await configureReplyPresentation(h.execute, table, h.context);
    h.state.migration = undefined;
    h.execute.mockClear();
    expect(await configureReplyPresentation(h.execute, first, h.context)).toEqual(first);
    expect(writes(h.execute)).toEqual([]);
  });

  it('accepts real Feishu normalization of unary conditions without recreating the workflow', async () => {
    const h = harness();
    h.state.normalizeWorkflowRead = true;
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    h.state.migration = undefined;
    h.execute.mockClear();
    expect(await configureReplyPresentation(h.execute, configured, h.context)).toEqual(configured);
    expect(writes(h.execute)).toEqual([]);
  });

  it('uses a read-only Beijing-time formula while keeping source time as text', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const display = h.state.fields.find((field) => field.id === configured.presentation!.timeDisplayFieldId)!;
    expect(display).toMatchObject({
      type: 'formula',
      name: '时间',
      expression: expect.stringContaining('DURATION(0,VALUE(MID([时间原值],12,2))+8,VALUE(MID([时间原值],15,2)),0)'),
    });
    expect(display.expression).toContain('IF(RIGHT([时间原值],1)="Z"');
    expect(
      h.execute.mock.calls.some(
        ([args]) =>
          args[1] === '+field-create' &&
          args.includes('--i-have-read-guide') &&
          args.some((arg) => arg.includes('"type":"formula"'))
      )
    ).toBe(true);
  });

  it('stops rather than replacing an existing managed time formula with a different meaning', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    h.state.fields.find((field) => field.id === configured.presentation!.timeDisplayFieldId)!.expression = 'NOW()';
    h.execute.mockClear();
    await expect(configureReplyPresentation(h.execute, configured, h.context)).rejects.toThrow(/conflict/i);
    expect(writes(h.execute)).toEqual([]);
  });

  it('separates platforms through exact hidden-field filters using the same readable columns', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const xhs = h.state.views.find((view) => view.name === '小红书 · 回复工作台')!;
    const douyin = h.state.views.find((view) => view.name === '抖音 · 回复工作台')!;
    expect([h.state.filter.get(xhs.id), h.state.filter.get(douyin.id)]).toEqual([
      { logic: 'and', conditions: [[fields.platform, '==', 'xiaohongshu']] },
      { logic: 'and', conditions: [[fields.platform, '==', 'douyin']] },
    ]);
    expect([h.state.visible.get(xhs.id), h.state.visible.get(douyin.id)]).toEqual([
      h.state.visible.get(configured.presentation!.viewId),
      h.state.visible.get(configured.presentation!.viewId),
    ]);
    expect(h.state.filter.has('vewOriginal')).toBe(false);
  });

  it('does not overwrite a conflicting existing platform view filter', async () => {
    const h = harness();
    h.state.views.push({ id: 'vewExisting', name: '小红书 · 回复工作台', type: 'grid' });
    const filter = { logic: 'and', conditions: [[fields.platform, '==', 'douyin']] };
    h.state.filter.set('vewExisting', filter);
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow(/conflict/i);
    expect(h.state.filter.get('vewExisting')).toEqual(filter);
    expect(writes(h.execute)).toEqual([]);
  });

  it('rejects a foreign workflow before renaming any fields', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    h.state.workflows.find((workflow) => workflow.workflow_id === configured.presentation!.workflowId)!.steps = [];
    h.state.fields.find((field) => field.id === fields.draft)!.name = '回复内容';
    h.execute.mockClear();
    await expect(configureReplyPresentation(h.execute, configured, h.context)).rejects.toThrow(/conflict/i);
    expect(writes(h.execute)).toEqual([]);
    expect(h.state.fields.find((field) => field.id === fields.draft)!.name).toBe('回复内容');
  });

  it('recovers a successfully created field after a lost response without creating a duplicate', async () => {
    const h = harness();
    h.state.failAfterCreate = true;
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    expect(h.state.fields.filter((field) => field.name === '发送')).toHaveLength(1);
    expect(configured.presentation?.workflowId).toBe('wkfReply');
  });

  it('rejects missing permission before any mutation', async () => {
    const h = harness();
    h.state.scopes = h.state.scopes.filter((scope) => scope !== 'base:workflow:create');
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow(/permission/i);
    expect(writes(h.execute)).toEqual([]);
  });

  it('stops on duplicate resource names instead of silently choosing a target', async () => {
    const h = harness();
    h.state.fields.push({ id: 'fldOne', name: '发送', type: 'button' }, { id: 'fldTwo', name: '发送', type: 'button' });
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow(/conflict/i);
    expect(writes(h.execute)).toEqual([]);
  });

  it('stops when a persisted resource has disappeared instead of recreating it', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    h.state.fields = h.state.fields.filter((field) => field.id !== configured.presentation!.approvalTextFieldId);
    h.execute.mockClear();
    await expect(configureReplyPresentation(h.execute, configured, h.context)).rejects.toThrow(/changed|conflict/i);
    expect(writes(h.execute)).toEqual([]);
  });

  it('does not enable a workflow unless its button binding reads back correctly', async () => {
    const h = harness();
    h.state.corruptBinding = true;
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow(/unverified|conflict/i);
    expect(h.execute.mock.calls.some(([args]) => args[1] === '+workflow-enable')).toBe(false);
  });

  it('keeps all field settings when shortening the draft and status headings', async () => {
    const h = harness();
    h.state.fields.find((field) => field.id === fields.draft)!.style = { type: 'multiline' };
    await configureReplyPresentation(h.execute, table, h.context);
    expect(h.state.fields.find((field) => field.id === fields.draft)).toMatchObject({
      id: fields.draft,
      name: '我的回复',
      type: 'text',
      style: { type: 'multiline' },
    });
  });

  it('sanitizes failures and does not proceed after an unresolved creation error', async () => {
    const h = harness();
    h.state.failBeforeCreate = true;
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow('replyCliFailed');
    expect(h.execute.mock.calls.some(([args]) => args[1] === '+workflow-create')).toBe(false);
  });
});

describe('manual reply presentation upgrade', () => {
  it('creates a URL-style original-comment field and marks the complete upgrade', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    expect(h.state.fields.find((field) => field.id === configured.presentation!.commentLinkFieldId)).toMatchObject({
      name: '原评论',
      type: 'text',
      style: { type: 'url' },
    });
    expect(configured.presentation?.replyCaptureVersion).toBe(1);
    expect(h.state.fields.find((field) => field.id === fields.status)).toMatchObject({
      options: expect.arrayContaining([
        { name: '已回复', hue: 'Green', lightness: 'Lighter' },
        { name: '本人评论', hue: 'Gray', lightness: 'Lighter' },
      ]),
    });
  });

  it.each(['enabled', 'disabled'])(
    'upgrades the exact legacy select guards and disables the originally %s workflow',
    async (originalStatus) => {
      const h = harness();
      const configured = await configureReplyPresentation(h.execute, table, h.context);
      const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
      const conditions = (workflow.steps as WorkflowStepData[])[1].data.condition.conditions[0].conditions;
      conditions.splice(7, 2);
      workflow.status = originalStatus;
      h.state.fields = h.state.fields.filter((field) => field.id !== configured.presentation!.commentLinkFieldId);
      const status = h.state.fields.find((field) => field.id === fields.status)! as Field & {
        options: Array<{ name: string }>;
        default_value: string[];
      };
      status.options = status.options.filter((option) => !['已回复', '本人评论'].includes(option.name));
      status.default_value = ['待处理'];
      h.state.migration = undefined;
      const legacy = {
        ...configured,
        presentation: { ...configured.presentation!, commentLinkFieldId: undefined, replyCaptureVersion: undefined },
      };
      const upgraded = await configureReplyPresentation(h.execute, legacy, h.context);
      expect(upgraded.presentation).toMatchObject({ statusFieldType: 'select', replyCaptureVersion: 1 });
      expect({ records: h.state.records, default: status.default_value, enabled: workflow.status }).toEqual({
        records: { recOne: '待处理', recTwo: '旧状态' },
        default: ['待处理'],
        enabled: 'disabled',
      });
      expect((workflow.steps as WorkflowStepData[])[1].data.condition.conditions[0].conditions).toHaveLength(9);
    }
  );

  it('rejects a weakened legacy guard set before modifying any resource', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
    (workflow.steps as WorkflowStepData[])[1].data.condition.conditions[0].conditions.splice(2, 1);
    const legacy = { ...configured, presentation: { ...configured.presentation!, replyCaptureVersion: undefined } };
    h.state.migration = undefined;
    h.execute.mockClear();
    await expect(configureReplyPresentation(h.execute, legacy, h.context)).rejects.toThrow(/conflict/i);
    expect(writes(h.execute)).toEqual([]);
  });
});

describe('manual reply upgrade failure recovery', () => {
  it('repairs the known workflow when conversion clears its operands in the same request', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
    const steps = workflow.steps as WorkflowStepData[];
    steps[1].data.condition.conditions[0].conditions.splice(7, 2);
    workflow.steps = JSON.parse(
      JSON.stringify(workflow.steps).replaceAll(
        /\{"value_type":"option","value":\{"name":"([^"]+)"\}\}/g,
        '{"value_type":"text","value":"$1"}'
      )
    );
    h.state.fields.find((field) => field.id === fields.status)!.type = 'text';
    h.state.migration = undefined;
    const legacy = {
      ...configured,
      presentation: { ...configured.presentation!, statusFieldType: undefined, replyCaptureVersion: undefined },
    };
    const original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (args) => {
      const result = await original(args);
      if (args[1] === '+field-update' && args[args.indexOf('--field-id') + 1] === fields.status) {
        const current = workflow.steps as WorkflowStepData[];
        for (const condition of current[1].data.condition.conditions[0].conditions.slice(2)) condition.right_value = [];
        current[2].data.field_values[2].value = [];
      }
      return result;
    });
    const recovered = await configureReplyPresentation(h.execute, legacy, h.context);
    expect(recovered.presentation?.replyCaptureVersion).toBe(1);
    expect((workflow.steps as WorkflowStepData[])[1].data.condition.conditions[0].conditions).toHaveLength(9);
    expect(workflow.status).toBe('disabled');
  });

  it('keeps the upgrade checkpoint and disabled button after a failed workflow update', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
    (workflow.steps as WorkflowStepData[])[1].data.condition.conditions[0].conditions.splice(7, 2);
    const legacy = { ...configured, presentation: { ...configured.presentation!, replyCaptureVersion: undefined } };
    h.state.migration = undefined;
    h.state.failWorkflowUpdate = true;
    await expect(configureReplyPresentation(h.execute, legacy, h.context)).rejects.toThrow(/failed/i);
    expect({ status: workflow.status, records: h.state.migration?.records }).toEqual({
      status: 'disabled',
      records: { recOne: '待处理', recTwo: '旧状态' },
    });
    h.state.failWorkflowUpdate = false;
    const recovered = await configureReplyPresentation(h.execute, legacy, h.context);
    expect({ version: recovered.presentation?.replyCaptureVersion, status: workflow.status }).toEqual({
      version: 1,
      status: 'disabled',
    });
  });

  it('does not reuse an unrelated plain-text original-comment column', async () => {
    const h = harness();
    h.state.fields.push({ id: 'fldForeign', name: '原评论', type: 'text', style: { type: 'plain' } });
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow(/conflict/i);
    expect(writes(h.execute)).toEqual([]);
  });
});

describe('new field visibility delay', () => {
  it('creates the original-comment field once and accepts it on the third read', async () => {
    const h = harness();
    const original = h.execute.getMockImplementation()!;
    let readsAfterCreation = 0;
    h.execute.mockImplementation(async (args) => {
      const result = await original(args);
      if (args[1] === '+field-list' && h.state.fields.some((field) => field.name === '原评论')) {
        readsAfterCreation++;
        if (readsAfterCreation < 3) return ok({ fields: h.state.fields.filter((field) => field.name !== '原评论') });
      }
      return result;
    });
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    expect(configured.presentation?.commentLinkFieldId).toBe(
      h.state.fields.find((field) => field.name === '原评论')!.id
    );
    expect(readsAfterCreation).toBe(3);
    expect(
      h.execute.mock.calls.filter(
        ([args]) => args[1] === '+field-create' && JSON.parse(args[args.indexOf('--json') + 1]).name === '原评论'
      )
    ).toHaveLength(1);
  });

  it('stops after three missing-field reads while retaining the checkpoint and never recreating the field', async () => {
    const h = harness();
    const original = h.execute.getMockImplementation()!;
    let readsAfterCreation = 0;
    h.execute.mockImplementation(async (args) => {
      const result = await original(args);
      if (args[1] === '+field-list' && h.state.fields.some((field) => field.name === '原评论')) {
        readsAfterCreation++;
        return ok({ fields: h.state.fields.filter((field) => field.name !== '原评论') });
      }
      return result;
    });
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow(
      'replyPresentationUnverified'
    );
    expect(readsAfterCreation).toBe(3);
    expect(h.state.fields.filter((field) => field.name === '原评论')).toHaveLength(1);
    expect(h.state.migration?.records).toEqual({ recOne: '待处理', recTwo: '旧状态' });
  });

  it.each(['type conflict', 'read failure'])('does not retry field visibility after a %s', async (failure) => {
    const h = harness();
    const original = h.execute.getMockImplementation()!;
    let readsAfterCreation = 0;
    h.execute.mockImplementation(async (args) => {
      const result = await original(args);
      if (args[1] === '+field-list' && h.state.fields.some((field) => field.name === '原评论')) {
        readsAfterCreation++;
        if (failure === 'read failure') throw new Error('offline');
        return ok({
          fields: h.state.fields.map((field) => (field.name === '原评论' ? { ...field, type: 'button' } : field)),
        });
      }
      return result;
    });
    await expect(configureReplyPresentation(h.execute, table, h.context)).rejects.toThrow(
      failure === 'read failure' ? 'replyCliFailed' : 'replyPresentationConflict'
    );
    expect(readsAfterCreation).toBe(1);
    expect(h.state.fields.filter((field) => field.name === '原评论')).toHaveLength(1);
  });
});

describe('toolbar-only presentation', () => {
  it('disables the existing send workflow while preserving its IDs, definition, fields and records', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const legacy = { ...configured, presentation: { ...configured.presentation!, sendMode: undefined } };
    const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
    workflow.status = 'enabled';
    const oldSteps = structuredClone(workflow.steps);
    const oldFields = structuredClone(h.state.fields);
    const oldRecords = structuredClone(h.state.records);
    h.state.migration = undefined;
    h.execute.mockClear();
    const upgraded = await configureReplyPresentation(h.execute, legacy, h.context);
    expect(upgraded.presentation).toMatchObject({ ...configured.presentation, sendMode: 'toolbar' });
    expect({
      steps: workflow.steps,
      fields: h.state.fields,
      records: h.state.records,
      status: workflow.status,
    }).toEqual({
      steps: oldSteps,
      fields: oldFields,
      records: oldRecords,
      status: 'disabled',
    });
    expect(
      h.execute.mock.calls.some(([args]) =>
        ['+workflow-create', '+workflow-update', '+workflow-enable', '+field-update', '+record-upsert'].includes(
          args[1]
        )
      )
    ).toBe(false);
  });

  it('removes only the button from other grid views while retaining their order, filters and sorts', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    h.state.views.push(
      { id: 'vewCustom', name: 'Custom', type: 'grid' },
      { id: 'vewBoard', name: 'Board', type: 'kanban' }
    );
    h.state.visible.set('vewOriginal', [fields.author, configured.presentation!.buttonFieldId, fields.result]);
    h.state.visible.set('vewCustom', [fields.comment, configured.presentation!.buttonFieldId, fields.author]);
    h.state.visible.set('vewBoard', [configured.presentation!.buttonFieldId]);
    h.state.filter.set('vewCustom', { logic: 'and', conditions: [[fields.author, '==', 'Reader']] });
    h.state.sort.set('vewCustom', [{ field: fields.author, desc: false }]);
    const filter = structuredClone(h.state.filter.get('vewCustom'));
    const sort = structuredClone(h.state.sort.get('vewCustom'));
    h.state.migration = undefined;
    await configureReplyPresentation(h.execute, configured, h.context);
    expect([h.state.visible.get('vewOriginal'), h.state.visible.get('vewCustom')]).toEqual([
      [fields.author, fields.result],
      [fields.comment, fields.author],
    ]);
    expect([h.state.filter.get('vewCustom'), h.state.sort.get('vewCustom')]).toEqual([filter, sort]);
    expect(h.state.visible.get('vewBoard')).toEqual([configured.presentation!.buttonFieldId]);
  });

  it('never enables the workflow during initial setup or repeated configuration', async () => {
    const h = harness();
    const first = await configureReplyPresentation(h.execute, table, h.context);
    h.state.migration = undefined;
    const next = await configureReplyPresentation(h.execute, first, h.context);
    expect(next.presentation?.sendMode).toBe('toolbar');
    expect(h.state.workflows.find((item) => item.workflow_id === first.presentation!.workflowId)?.status).toBe(
      'disabled'
    );
    expect(h.execute.mock.calls.some(([args]) => args[1] === '+workflow-enable')).toBe(false);
  });

  it('retains the migration checkpoint when disabling the old workflow cannot be verified', async () => {
    const h = harness();
    const configured = await configureReplyPresentation(h.execute, table, h.context);
    const workflow = h.state.workflows.find((item) => item.workflow_id === configured.presentation!.workflowId)!;
    workflow.status = 'enabled';
    h.state.migration = undefined;
    const original = h.execute.getMockImplementation()!;
    h.execute.mockImplementation(async (args) => (args[1] === '+workflow-disable' ? ok({}) : original(args)));
    const legacy = { ...configured, presentation: { ...configured.presentation!, sendMode: undefined } };
    await expect(configureReplyPresentation(h.execute, legacy, h.context)).rejects.toThrow(
      'replyPresentationUnverified'
    );
    expect(h.state.migration).toMatchObject({
      workflowId: workflow.workflow_id,
      workflowEnabled: true,
      records: h.state.records,
    });
    expect(workflow.status).toBe('enabled');
  });
});

it('keeps the already-visible private conversation column when reconfiguring managed reply views', async () => {
  const h = harness();
  const first = await configureReplyPresentation(h.execute, table, h.context);
  const id = first.presentation!.viewId;
  const before = [...h.state.visible.get(id)!, 'fldDm'];
  h.state.fields.push({ id: 'fldDm', name: '私聊', type: 'text', style: { type: 'url' } });
  h.state.visible.set(id, before);
  await configureReplyPresentation(h.execute, first, h.context);
  expect(h.state.visible.get(id)).toEqual(before);
});
