import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplyStore } from '@process/services/workbench/replies/store';

const directories: string[] = [];
const directory = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reply-outbox-'));
  directories.push(dir);
  return dir;
};
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('durable reply outbox', () => {
  it('rejects incomplete source snapshots without replacing the persisted outbox', () => {
    const dir = directory();
    const store = new ReplyStore(dir);
    store.update(() => {});
    const file = path.join(dir, 'comment-replies.json');
    const before = readFileSync(file, 'utf8');

    expect(() =>
      store.update((doc) => {
        Object.assign(doc.sourceSnapshots, { key: { account: 'Incomplete' } });
      })
    ).toThrow('replyStoreInvalid');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('normalizes legacy automation to manual and preserves other durable values', () => {
    const dir = directory();
    const store = new ReplyStore(dir);
    store.update((doc) => {
      doc.enabled = true;
      doc.buttonDispatchMode = 'automatic';
      doc.approvals.push({ id: 'approval', recordId: 'rec' });
    });
    const before = JSON.parse(readFileSync(path.join(dir, 'comment-replies.json'), 'utf8'));
    const restarted = new ReplyStore(dir);
    expect(restarted.read()).toMatchObject({
      enabled: false,
      buttonDispatchMode: 'manual',
      approvals: before.approvals,
    });
    expect(JSON.parse(readFileSync(path.join(dir, 'comment-replies.json'), 'utf8'))).toMatchObject({
      enabled: false,
      buttonDispatchMode: 'manual',
    });
  });
  it('does not replace corrupt state or touch the legacy journal', () => {
    const dir = directory();
    const file = path.join(dir, 'comment-replies.json');
    writeFileSync(file, '{corrupt');
    writeFileSync(path.join(dir, 'comment-sync.json'), 'legacy');
    expect(() => new ReplyStore(dir)).toThrow('replyStoreInvalid');
    expect(readFileSync(file, 'utf8')).toBe('{corrupt');
    expect(readFileSync(path.join(dir, 'comment-sync.json'), 'utf8')).toBe('legacy');
  });
  it('persists approval recovery intents with owner-only permissions', () => {
    const dir = directory();
    const store = new ReplyStore(dir);
    store.update((doc) => {
      doc.approvals.push({ id: 'intent', recordId: 'rec' });
      doc.approvalBlocks.push('rec');
    });
    expect(new ReplyStore(dir).read()).toMatchObject({
      approvals: [{ id: 'intent', recordId: 'rec' }],
      approvalBlocks: ['rec'],
    });
    expect(statSync(path.join(dir, 'comment-replies.json')).mode & 0o777).toBe(0o600);
  });
  it('persists the select status encoding and rejects an unsupported encoding', () => {
    const dir = directory();
    const store = new ReplyStore(dir);
    const table = {
      baseToken: 'base',
      tableId: 'tbl',
      url: 'https://example.com',
      fields: Object.fromEntries(
        [
          'author',
          'time',
          'comment',
          'draft',
          'ready',
          'status',
          'result',
          'platform',
          'account',
          'conversation',
          'parent',
          'key',
        ].map((key) => [key, `fld${key}`])
      ),
      presentation: {
        buttonFieldId: 'fldButton',
        approvalTextFieldId: 'fldApproval',
        workflowId: 'workflow',
        viewId: 'vewReply',
        statusFieldType: 'select',
      },
    } as NonNullable<ReturnType<ReplyStore['read']>['table']>;
    store.update((doc) => {
      doc.table = table;
    });
    expect(new ReplyStore(dir).read().table?.presentation).toMatchObject({ statusFieldType: 'select' });
    const file = path.join(dir, 'comment-replies.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.table.presentation.statusFieldType = 'checkbox';
    writeFileSync(file, JSON.stringify(data));
    expect(() => new ReplyStore(dir)).toThrow('replyStoreInvalid');
  });
  it('retains the complete migration snapshot including empty statuses across restart', () => {
    const dir = directory();
    const store = new ReplyStore(dir);
    const migration = {
      baseToken: 'baseExample',
      tableId: 'tblReply',
      statusFieldId: 'fldStatus',
      workflowId: 'workflowReply',
      workflowEnabled: false,
      records: { recEmpty: '', recHistory: '未发送：旧状态' },
    };
    store.update((doc) => {
      Object.assign(doc, { statusMigration: migration });
    });
    expect(new ReplyStore(dir).read()).toMatchObject({ statusMigration: migration });
  });
  it.each([
    { baseToken: '', tableId: 'tbl', statusFieldId: 'fld', workflowEnabled: true, records: {} },
    { baseToken: 'base', tableId: 'tbl', statusFieldId: 'fld', workflowEnabled: 'true', records: {} },
    { baseToken: 'base', tableId: 'tbl', statusFieldId: 'fld', workflowEnabled: true, records: { rec: null } },
    { baseToken: 'base', tableId: 'tbl', statusFieldId: 'fld', workflowEnabled: true, records: { '': '待处理' } },
    { baseToken: 'base', tableId: 'tbl', statusFieldId: 'fld', workflowEnabled: true, records: {}, extra: 1 },
  ])('rejects malformed migration snapshots on update and restart', (migration) => {
    const dir = directory();
    const store = new ReplyStore(dir);
    expect(() =>
      store.update((doc) => {
        Object.assign(doc, { statusMigration: migration });
      })
    ).toThrow();
    store.update(() => {});
    const file = path.join(dir, 'comment-replies.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.statusMigration = migration;
    writeFileSync(file, JSON.stringify(data));
    expect(() => new ReplyStore(dir)).toThrow('replyStoreInvalid');
  });
  it('does not retain a failed transaction or let callers mutate its snapshot', () => {
    const store = new ReplyStore(directory());
    expect(() =>
      store.update((doc) => {
        doc.enabled = true;
        throw new Error('failed');
      })
    ).toThrow('failed');
    store.read().enabled = true;
    expect(store.read().enabled).toBe(false);
  });
});
