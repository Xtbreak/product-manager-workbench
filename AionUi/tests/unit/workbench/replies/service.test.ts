import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplyComment, ReplyTable, ReplyTableRow, ReplyWork } from '@/common/types/platform/workbenchReply';
import type { ReplyPlatformAdapter, ReplyTableAdapter } from '@process/services/workbench/replies/contracts';
import { createReplyService } from '@process/services/workbench/replies/service';
import { commentLinkToken } from '@process/services/workbench/replies/commentLinks';
import { ReplyStore } from '@process/services/workbench/replies/store';
import { replySourceValues, sameReplySource } from '@process/services/workbench/replies/feishuSchema';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const work: ReplyWork = {
  key: 'xhs:a:w',
  platform: 'xiaohongshu',
  accountId: 'a',
  actorId: 'actor',
  actorName: 'Owner',
  workId: 'w',
  title: 'Own work',
  url: 'https://www.xiaohongshu.com/explore/w',
};
const comment: ReplyComment = {
  key: 'xhs:a:w:c',
  workKey: work.key,
  platform: work.platform,
  accountId: 'a',
  actorId: 'actor',
  workId: 'w',
  commentId: 'c',
  rootCommentId: 'root',
  parentCommentId: 'root',
  authorId: 'customer',
  author: 'Customer',
  content: 'Second round',
  createdAt: 1,
};
const sent: ReplyComment = {
  ...comment,
  authorId: 'actor',
  author: 'Owner',
  key: 'xhs:a:w:new',
  commentId: 'new',
  parentCommentId: 'c',
  content: 'Approved reply',
  createdAt: 2,
};
const table: ReplyTable = {
  baseToken: 'base',
  tableId: 'tblTable',
  url: 'https://my.feishu.cn/base/base?table=tblTable',
  fields: {
    author: 'fldauthor',
    time: 'fldtime',
    comment: 'fldcomment',
    draft: 'flddraft',
    ready: 'fldready',
    status: 'fldstatus',
    result: 'fldresult',
    platform: 'fldplatform',
    account: 'fldaccount',
    conversation: 'fldconversation',
    parent: 'fldparent',
    key: 'fldkey',
  },
};

const presentation = {
  sendMode: 'toolbar' as const,
  buttonFieldId: 'fldButton',
  approvalTextFieldId: 'fldApproval',
  workflowId: 'workflowReply',
  viewId: 'vewReply',
};
async function fixture(buttonMode = true) {
  const directory = mkdtempSync(path.join(tmpdir(), 'reply-service-'));
  directories.push(directory);
  const rows: ReplyTableRow[] = [];
  const feishu: ReplyTableAdapter = {
    provision: vi.fn(async () => (buttonMode ? { ...table, presentation } : table)),
    configurePresentation: vi.fn(async (current) => ({ ...current, presentation })),
    inspect: vi.fn(async () => undefined),
    list: vi.fn(async () => structuredClone(rows)),
    get: vi.fn(async (_table, recordId) => structuredClone(rows.find((row) => row.recordId === recordId) ?? null)),
    create: vi.fn(async (_table, sourceWork, item, parentText) => {
      const id = `rec${rows.length}`;
      rows.push({
        recordId: id,
        messageKey: item.key,
        draft: '',
        ready: false,
        status: '',
        result: '',
        source: replySourceValues(sourceWork, item, parentText),
      });
      return id;
    }),
    claimDraft: vi.fn(async (_table, expected) => {
      const current = rows.find((row) => row.recordId === expected.recordId);
      if (
        !current ||
        !sameReplySource(current.source, expected.source) ||
        !['recordId', 'messageKey', 'draft', 'status', 'result', 'ready', 'approvedDraft'].every(
          (key) => current[key as keyof ReplyTableRow] === expected[key as keyof ReplyTableRow]
        )
      )
        return false;
      Object.assign(current, { ready: false, approvedDraft: expected.draft, status: '发送中' });
      return true;
    }),
    consumeApproval: vi.fn(async (_table, row) => {
      rows.find((r) => r.recordId === row.recordId)!.ready = false;
      return true;
    }),
    writeResult: vi.fn(async (_table, id, state, result) => {
      const row = rows.find((item) => item.recordId === id)!;
      row.status = state;
      row.result = result;
    }),
    writeObservedReply: vi.fn(async (_table, expected, text, result, state) => {
      Object.assign(rows.find((row) => row.recordId === expected.recordId)!, {
        draft: text,
        ready: false,
        approvedDraft: '',
        status: state,
        result,
      });
    }),
    markOwnComment: vi.fn(async (_table, expected) => {
      Object.assign(rows.find((row) => row.recordId === expected.recordId)!, {
        ready: false,
        approvedDraft: '',
        status: 'own',
      });
    }),
    writeCommentLink: vi.fn(async () => undefined),
    recover: vi.fn(async () => null),
  };
  const platform: ReplyPlatformAdapter = {
    inspectCurrent: vi.fn(async () => ({ work, collection: { comments: [comment], complete: true } })),
    collect: vi.fn(async () => ({ comments: [comment], complete: true })),
    discardPrepared: vi.fn(async () => undefined),
    prepare: vi.fn(async () => ({ beforeIds: ['c'], preparedAt: 1 })),
    submit: vi.fn(async () => sent),
    reconcile: vi.fn(async () => null),
  };
  const release = vi.fn();
  const options = {
    directory,
    table: feishu,
    platform,
    browsers: { acquire: vi.fn(async () => ({ accountId: 'a', targetId: 'webview-1', command: vi.fn(), release })) },
    pollMs: 0,
  };
  const service = createReplyService(options);
  await service.action({ action: 'setup', sourceUrl: table.url });
  await service.action({ action: 'bind', accountId: 'a' });
  rows[0].draft = 'Approved reply';
  rows[0].ready = true;
  if (buttonMode) rows[0].approvedDraft = rows[0].draft;
  return { service, rows, platform, feishu, release, options };
}

async function twoManualRows() {
  const f = await fixture(true);
  const second = { ...comment, key: 'xhs:a:w:c2', commentId: 'c2' };
  f.service.close();
  new ReplyStore(f.options.directory).update((doc) => {
    doc.comments.push(second);
    doc.records[second.key] = 'rec2';
  });
  f.rows.push({
    recordId: 'rec2',
    messageKey: second.key,
    source: replySourceValues(work, second, ''),
    draft: 'Approved reply',
    approvedDraft: 'Approved reply',
    ready: true,
    status: '',
    result: '',
  });
  const service = createReplyService(f.options);
  await service.action({ action: 'dispatch-mode', mode: 'manual' });
  return { ...f, service };
}

describe('Feishu approved reply service', () => {
  it('manual-only rejects legacy automation requests and sync never sends approved rows', async () => {
    const f = await fixture(true);
    await expect(f.service.action({ action: 'enabled', enabled: true })).rejects.toThrow('replyManualModeRequired');
    await expect(f.service.action({ action: 'dispatch-mode', mode: 'automatic' })).rejects.toThrow(
      'replyManualModeRequired'
    );
    await f.service.action({ action: 'sync' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0].ready).toBe(true);
    f.service.close();
  });
  it('manual-only backfills an owner reply over a queued draft without creating a customer row', async () => {
    const f = await fixture(true);
    const manual = { ...sent, content: 'Replied on the platform' };
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, manual], complete: true });
    await f.service.action({ action: 'collect' });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ draft: manual.content, ready: false, approvedDraft: '', status: 'replied' });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    f.service.close();
  });
  it('manual-only retains owner nodes for the next customer question and deduplicates replies', async () => {
    const f = await fixture(true);
    const followup = {
      ...comment,
      key: 'xhs:a:w:followup',
      commentId: 'followup',
      parentCommentId: sent.commentId,
      content: 'Another question',
    };
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, sent, followup], complete: true });
    await f.service.action({ action: 'collect' });
    await f.service.action({ action: 'collect' });
    expect(f.rows.map((row) => row.messageKey)).toEqual([comment.key, followup.key]);
    expect(new ReplyStore(f.options.directory).read().comments.map((row) => row.key)).toContain(sent.key);
    expect(f.feishu.writeObservedReply).toHaveBeenCalledTimes(1);
    f.service.close();
  });
  it('manual-only durable observed evidence blocks sends even after failed backfill and restart', async () => {
    const f = await fixture(true);
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, sent], complete: true });
    vi.mocked(f.feishu.writeObservedReply!).mockRejectedValue(new Error('replyCliFailed'));
    await f.service.action({ action: 'collect' });
    expect((await f.service.status()).uncertain).toBeGreaterThanOrEqual(1);
    f.service.close();
    const restarted = createReplyService(f.options);
    expect((await restarted.status()).uncertain).toBeGreaterThanOrEqual(1);
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.prepare).not.toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    vi.mocked(f.feishu.writeObservedReply!).mockImplementation(async (_table, expected, text, result, state) => {
      Object.assign(f.rows.find((row) => row.recordId === expected.recordId)!, {
        draft: text,
        ready: false,
        approvedDraft: '',
        status: state,
        result,
      });
    });
    await restarted.action({ action: 'collect' });
    expect(f.rows[0]).toMatchObject({ draft: sent.content, ready: false, status: 'replied' });
    restarted.close();
  });
  it('keeps a failed rewrite of an already backfilled reply pending across restart', async () => {
    const f = await fixture(true);
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, sent], complete: true });
    await f.service.action({ action: 'collect' });
    f.rows[0].draft = 'Edited after the platform reply was backfilled';
    let writtenBeforeRewrite: boolean | undefined;
    vi.mocked(f.feishu.writeObservedReply!).mockImplementation(async () => {
      writtenBeforeRewrite = new ReplyStore(f.options.directory).read().observedReplies[0].written;
      throw new Error('replyCliFailed');
    });

    const result = await f.service.action({ action: 'collect' });
    f.service.close();
    const restarted = createReplyService(f.options);
    const afterRestart = await restarted.status();
    restarted.close();

    expect(writtenBeforeRewrite).toBe(false);
    expect(result).toMatchObject({ error: 'replyResultPending', uncertain: 1 });
    expect(afterRestart).toMatchObject({ uncertain: 1 });
  });
  it('manual-only catches a manual reply discovered by preparation before dispatch', async () => {
    const f = await fixture(true);
    vi.mocked(f.platform.prepare).mockResolvedValue({
      beforeIds: ['c', 'new'],
      preparedAt: 1,
      existingReplies: [sent],
    });
    await f.service.action({ action: 'dispatch-mode', mode: 'manual' });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.platform.discardPrepared).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ draft: sent.content, ready: false, status: 'replied' });
    f.service.close();
  });
  it('collects a different manual reply after an uncertain send without falsely confirming that attempt', async () => {
    const f = await fixture();
    vi.mocked(f.platform.submit).mockRejectedValueOnce(new Error('timeout'));
    await f.service.action({ action: 'send-pending' });
    const manual = {
      ...sent,
      key: 'xhs:a:w:manual',
      commentId: 'manual',
      content: 'Replied separately on the platform',
    };
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, manual], complete: true });
    await f.service.action({ action: 'collect' });
    expect(f.platform.collect).toHaveBeenCalledTimes(1);
    expect(f.rows[0]).toMatchObject({ draft: manual.content, ready: false, approvedDraft: '', status: 'attention' });
    const persisted = new ReplyStore(f.options.directory).read();
    expect(persisted.attempts).toHaveLength(1);
    expect(persisted.attempts[0]).toMatchObject({ phase: 'uncertain', text: 'Approved reply' });
    expect(persisted.attempts[0].result).toBeUndefined();
    expect(await f.service.status()).toMatchObject({ uncertain: 1, sent: 0 });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    f.service.close();
  });
  it('persists button configuration without replacing existing table routing', async () => {
    const f = await fixture(false);
    await expect(f.service.action({ action: 'configure' })).resolves.toMatchObject({ sendButtonConfigured: true });
    f.service.close();
    const restarted = createReplyService(f.options);
    expect(await restarted.status()).toMatchObject({ sendButtonConfigured: true, archived: 1, enabled: false });
    restarted.close();
  });
  it('rejects configuration that attempts to change the table identity', async () => {
    const f = await fixture(false);
    vi.mocked(f.feishu.configurePresentation!).mockResolvedValue({ ...table, tableId: 'tblForeign', presentation });
    await expect(f.service.action({ action: 'configure' })).rejects.toThrow('replyTargetMismatch');
    expect(await f.service.status()).toMatchObject({ sendButtonConfigured: false, archived: 1 });
    f.service.close();
  });
  it('resumes a status migration from durable evidence after an interrupted conversion', async () => {
    const f = await fixture(true);
    await f.service.action({ action: 'dispatch-mode', mode: 'manual' });
    const snapshot = {
      baseToken: table.baseToken,
      tableId: table.tableId,
      statusFieldId: table.fields.status,
      workflowId: presentation.workflowId,
      workflowEnabled: false,
      records: { rec0: '待处理' },
    };
    vi.mocked(f.feishu.configurePresentation!).mockImplementationOnce(async (_current, context) => {
      context!.saveMigration(snapshot);
      throw new Error('replyCliFailed');
    });
    await expect(f.service.action({ action: 'configure' })).rejects.toThrow('replyCliFailed');
    f.service.close();
    const restarted = createReplyService(f.options);
    vi.mocked(f.feishu.configurePresentation!).mockImplementationOnce(async (current, context) => {
      expect(context?.migration).toEqual(snapshot);
      return { ...current, presentation: { ...presentation, statusFieldType: 'select' } };
    });
    await restarted.action({ action: 'configure' });
    const persisted = new ReplyStore(f.options.directory).read();
    expect(persisted).toMatchObject({
      buttonDispatchMode: 'manual',
      presentationConfiguring: false,
      table: { presentation: { statusFieldType: 'select' } },
    });
    expect(persisted.statusMigration).toBeUndefined();
    expect(f.platform.submit).not.toHaveBeenCalled();
    restarted.close();
  });
  it('rejects migration evidence for another table before persisting it', async () => {
    const f = await fixture(true);
    vi.mocked(f.feishu.configurePresentation!).mockImplementationOnce(async (_current, context) => {
      context!.saveMigration({
        baseToken: table.baseToken,
        tableId: 'tblOther',
        statusFieldId: table.fields.status,
        workflowEnabled: true,
        records: {},
      });
      return { ...table, presentation };
    });
    await expect(f.service.action({ action: 'configure' })).rejects.toThrow('replyTargetMismatch');
    expect(new ReplyStore(f.options.directory).read().statusMigration).toBeUndefined();
    f.service.close();
  });
  it('persists a failed presentation configuration lock across restart and only clears it after verified retry', async () => {
    const f = await fixture(false);

    vi.mocked(f.feishu.configurePresentation!).mockRejectedValueOnce(new Error('replyPresentationUnverified'));
    await expect(f.service.action({ action: 'configure' })).rejects.toThrow('replyPresentationUnverified');
    f.service.close();
    const restarted = createReplyService(f.options);
    expect(await restarted.status()).toMatchObject({ enabled: false, error: 'replyPresentationUnverified' });
    await expect(restarted.action({ action: 'collect' })).rejects.toThrow('replyPresentationUnverified');
    await expect(restarted.action({ action: 'sync' })).rejects.toThrow('replyPresentationUnverified');
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0].ready).toBe(true);
    await expect(restarted.action({ action: 'configure' })).resolves.toMatchObject({
      sendButtonConfigured: true,
      enabled: false,
      error: undefined,
    });
    restarted.close();
  });
  it('keeps sends locked when configuration is canceled after the remote button was created', async () => {
    const f = await fixture(false);
    const caller = new AbortController();
    vi.mocked(f.feishu.configurePresentation!).mockImplementation(async (current) => {
      caller.abort();
      return { ...current, presentation };
    });
    await expect(f.service.action({ action: 'configure' }, caller.signal)).rejects.toThrow('replyPaused');
    expect(await f.service.status()).toMatchObject({ enabled: false, error: 'replyPresentationUnverified' });
    await expect(f.service.action({ action: 'collect' })).rejects.toThrow('replyPresentationUnverified');
    f.service.close();
  });
  it('locks an already configured table while a presentation reconfiguration is unresolved', async () => {
    const f = await fixture(true);

    vi.mocked(f.feishu.configurePresentation!).mockRejectedValueOnce(new Error('replyCliFailed'));
    await expect(f.service.action({ action: 'configure' })).rejects.toThrow('replyCliFailed');
    await expect(f.service.action({ action: 'sync' })).rejects.toThrow('replyPresentationUnverified');
    await expect(f.service.action({ action: 'send-pending' })).rejects.toThrow('replyPresentationUnverified');
    expect(f.platform.submit).not.toHaveBeenCalled();
    f.service.close();
  });
  it('authorizes the current draft at toolbar click despite a stale old button snapshot', async () => {
    const f = await fixture(true);
    f.rows[0].draft = 'Changed before batch';
    vi.mocked(f.platform.submit).mockResolvedValue({ ...sent, content: f.rows[0].draft });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    expect(vi.mocked(f.platform.submit).mock.calls[0][3]).toBe('Changed before batch');
    expect(f.rows[0]).toMatchObject({ ready: false, draft: 'Changed before batch', status: 'sent' });
    f.service.close();
  });
  it('rejects a changed claimed snapshot at the final approval checkpoint', async () => {
    const f = await fixture(true);
    vi.mocked(f.feishu.claimDraft!).mockImplementation(async () => {
      f.rows[0].ready = false;
      f.rows[0].approvedDraft = 'Another click';
      return true;
    });

    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0].status).toBe('attention');
    f.service.close();
  });
  it('ignores stale ready flags on sent rows even when their text is edited', async () => {
    const f = await fixture(true);

    await f.service.action({ action: 'send-pending' });
    f.rows[0].ready = true;
    f.rows[0].draft = 'Edited after success';
    f.rows[0].approvedDraft = f.rows[0].draft;
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect(f.rows[0]).toMatchObject({
      ready: true,
      draft: 'Edited after success',
      status: 'sent',
      result: sent.commentId,
    });
    f.service.close();
  });
  it('ignores a repeated old ready flag after restart without sending again', async () => {
    const f = await fixture();

    await f.service.action({ action: 'send-pending' });
    f.service.close();
    f.rows[0].ready = true;
    const restarted = createReplyService(f.options);
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect(f.rows[0]).toMatchObject({ ready: true, status: 'sent' });
    restarted.close();
  });
  it('retains sent state for a completed toolbar row even after its draft is emptied', async () => {
    const f = await fixture(true);

    await f.service.action({ action: 'send-pending' });
    f.rows[0].ready = true;
    f.rows[0].draft = '';
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect(f.rows[0]).toMatchObject({ ready: true, draft: '', status: 'sent', result: sent.commentId });
    f.service.close();
  });
  it('preserves an unresolved later send when upgrading a previously sent legacy row to toolbar sending', async () => {
    const f = await fixture(false);
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      doc.comments.push(sent);
      doc.attempts.push(
        {
          id: 'older-success',
          recordId: 'rec0',
          commentKey: comment.key,
          workKey: work.key,
          text: 'Approved reply',
          beforeIds: ['c'],
          preparedAt: 1,
          phase: 'sent',
          result: sent,
          resultWritten: true,
        },
        {
          id: 'later-uncertain',
          recordId: 'rec0',
          commentKey: comment.key,
          workKey: work.key,
          text: 'A later legacy reply',
          beforeIds: ['c', 'new'],
          preparedAt: 3,
          phase: 'uncertain',
        }
      );
    });
    const restarted = createReplyService(f.options);
    await restarted.action({ action: 'configure' });
    Object.assign(f.rows[0], { ready: true, draft: 'A later legacy reply', approvedDraft: 'A later legacy reply' });
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ draft: 'A later legacy reply', ready: true });
    expect(f.feishu.claimDraft).not.toHaveBeenCalled();
    expect(await restarted.status()).toMatchObject({ sent: 1, uncertain: 1 });
    restarted.close();
  });

  it('reports verification before any claim and permits only a new explicit retry', async () => {
    const f = await fixture(true);
    vi.mocked(f.platform.prepare).mockRejectedValue(new Error('REPLY_CHALLENGE_REQUIRED'));
    const before = structuredClone(f.rows[0]);
    await expect(f.service.action({ action: 'send-pending' })).resolves.toMatchObject({
      error: 'replyVerificationRequired',
    });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.feishu.claimDraft).not.toHaveBeenCalled();
    expect(f.rows[0]).toEqual(before);
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.prepare).toHaveBeenCalledTimes(2);
    f.service.close();
  });
  it('continues the next customer question beneath an owner reply without archiving the owner as a customer', async () => {
    const f = await fixture();
    await f.service.action({ action: 'send-pending' });
    const followup = {
      ...comment,
      key: 'xhs:a:w:followup',
      commentId: 'followup',
      parentCommentId: sent.commentId,
      content: 'Next question',
    };
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, sent, followup], complete: true });
    await f.service.action({ action: 'collect' });
    expect(f.rows.map((row) => row.messageKey)).toEqual([comment.key, followup.key]);
    Object.assign(f.rows[1], { draft: 'Next round', approvedDraft: 'Next round', ready: true });
    const next = {
      ...sent,
      key: 'xhs:a:w:next',
      commentId: 'next',
      parentCommentId: followup.commentId,
      content: 'Next round',
    };
    vi.mocked(f.platform.submit).mockResolvedValue(next);
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenLastCalledWith(
      expect.anything(),
      work,
      followup,
      'Next round',
      expect.anything(),
      expect.anything()
    );
    expect(f.rows[1]).toMatchObject({ ready: false, status: 'sent', result: 'next' });
    expect(new ReplyStore(f.options.directory).read().comments.map((item) => item.key)).toContain(sent.key);
    f.service.close();
  });

  it('ignores an empty draft with a stale ready flag before the explicit batch', async () => {
    const f = await fixture(true);
    f.rows[0].draft = '   ';

    await f.service.action({ action: 'send-pending' });
    expect(f.rows[0]).toMatchObject({ ready: true, status: '', result: '' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    f.service.close();
  });
  it('sends a clicked button row only from the explicit batch without collecting', async () => {
    const f = await fixture(true);
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect(f.platform.collect).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ ready: false, status: 'sent', result: 'new' });
    f.service.close();
  });
  it('sends all trusted clicked rows in the explicit batch and ignores foreign rows', async () => {
    const f = await fixture(true);
    f.rows.unshift({
      recordId: 'foreign',
      messageKey: 'foreign',
      draft: 'bad',
      approvedDraft: 'bad',
      ready: true,
      status: '',
      result: '',
    });
    const second = { ...comment, key: 'xhs:a:w:c2', commentId: 'c2' };
    new ReplyStore(f.options.directory).update((doc) => {
      doc.comments.push(second);
      doc.records[second.key] = 'rec2';
    });
    f.rows.push({
      recordId: 'rec2',
      messageKey: second.key,
      source: replySourceValues(work, second, ''),
      draft: 'Approved reply',
      approvedDraft: 'Approved reply',
      ready: true,
      status: '',
      result: '',
    });
    vi.mocked(f.platform.submit).mockImplementation(async (_lease, _work, target) => ({
      ...sent,
      key: `reply:${target.commentId}`,
      commentId: `reply-${target.commentId}`,
      parentCommentId: target.commentId,
    }));
    f.service.close();
    const restarted = createReplyService(f.options);
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(2);
    expect(f.rows.find((row) => row.recordId === 'foreign')?.ready).toBe(true);
    expect(f.rows.find((row) => row.recordId === 'rec2')).toMatchObject({ ready: false, status: 'sent' });
    restarted.close();
  });
  it('requires a verified toolbar upgrade before an old approved row can join a new batch', async () => {
    const f = await fixture(true);
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      delete doc.table!.presentation!.sendMode;
      delete doc.buttonDispatchVersion;
    });
    const restarted = createReplyService(f.options);
    await expect(restarted.action({ action: 'send-pending' })).rejects.toThrow('replySendButtonRequired');
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ ready: true, draft: 'Approved reply' });
    await restarted.action({ action: 'configure' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    restarted.close();
  });
  it('cancels only the active toolbar row before dispatch', async () => {
    const f = await fixture(true);
    let resume!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.mocked(f.platform.prepare).mockImplementation(async () => {
      started();
      await gate;
      return { beforeIds: ['c'], preparedAt: 1 };
    });
    const operation = f.service.action({ action: 'send-pending' });
    await entered;
    expect(await f.service.status()).toMatchObject({ canCancelSend: true });
    await f.service.action({ action: 'cancel' });
    expect(new ReplyStore(f.options.directory).read().approvalBlocks).toContain(f.rows[0].recordId);
    resume();
    await operation;
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ ready: true, draft: 'Approved reply', status: '' });
    f.service.close();
  });
  it('recovers a legacy approval result write without allowing a public legacy send', async () => {
    const f = await fixture(true);
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      delete doc.table!.presentation!.sendMode;
      doc.approvals.push({ id: 'legacy', recordId: f.rows[0].recordId });
    });
    vi.mocked(f.feishu.writeResult).mockRejectedValueOnce(new Error('failed'));
    const restarted = createReplyService(f.options);
    await expect(restarted.action({ action: 'reconcile' })).resolves.toMatchObject({ error: 'replyResultPending' });
    expect(new ReplyStore(f.options.directory).read().approvals).toHaveLength(1);
    await expect(restarted.action({ action: 'send-pending' })).rejects.toThrow('replySendButtonRequired');
    await restarted.action({ action: 'reconcile' });
    expect(f.rows[0]).toMatchObject({ ready: false, status: 'attention', result: 'replyApprovalInterrupted' });
    expect(new ReplyStore(f.options.directory).read().approvals).toEqual([]);
    expect(f.platform.submit).not.toHaveBeenCalled();
    restarted.close();
  });
  it('collects in button mode without consuming a clicked approval', async () => {
    const f = await fixture(true);
    await f.service.action({ action: 'collect' });
    expect(f.platform.collect).toHaveBeenCalledTimes(1);
    expect(f.rows[0].ready).toBe(true);
    expect(f.platform.submit).not.toHaveBeenCalled();
    f.service.close();
  });
  it('never polls a configured table or consumes clicked approvals after restart', async () => {
    const f = await fixture();
    f.service.close();
    vi.useFakeTimers();
    try {
      vi.mocked(f.feishu.inspect).mockClear();
      vi.mocked(f.feishu.list).mockClear();
      const restarted = createReplyService({ ...f.options, pollMs: 10 });
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.feishu.inspect).not.toHaveBeenCalled();
      expect(f.feishu.list).not.toHaveBeenCalled();
      expect(f.platform.collect).not.toHaveBeenCalled();
      expect(f.platform.submit).not.toHaveBeenCalled();
      expect(f.rows[0].ready).toBe(true);
      restarted.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an interrupted button dispatch uncertain rather than authorizing a retry', async () => {
    const f = await fixture(true);
    let started!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.mocked(f.platform.submit).mockImplementation(async () => {
      started();
      await gate;
      throw new Error('interrupted');
    });
    const operation = f.service.action({ action: 'send-pending' });
    await entered;
    await f.service.action({ action: 'cancel' });
    expect(new ReplyStore(f.options.directory).read().approvalBlocks).toEqual([]);
    resume();
    await operation;
    f.service.close();
    const restarted = createReplyService(f.options);
    f.rows[0].ready = true;
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect((await restarted.status()).uncertain).toBe(1);
    restarted.close();
  });
  it('does not let an unresolved row starve another account button request', async () => {
    const f = await fixture(true);
    const otherWork = { ...work, key: 'xhs:b:w2', accountId: 'b', workId: 'w2' };
    const other = {
      ...comment,
      key: 'xhs:b:w2:c2',
      workKey: otherWork.key,
      accountId: 'b',
      workId: 'w2',
      commentId: 'c2',
    };
    new ReplyStore(f.options.directory).update((doc) => {
      doc.works.push(otherWork);
      doc.comments.push(other);
      doc.records[other.key] = 'rec2';
      doc.attempts.push({
        id: 'uncertain',
        recordId: f.rows[0].recordId,
        commentKey: comment.key,
        workKey: work.key,
        text: 'Approved reply',
        beforeIds: ['c'],
        preparedAt: 1,
        phase: 'uncertain',
      });
    });
    f.rows.push({
      recordId: 'rec2',
      messageKey: other.key,
      source: replySourceValues(otherWork, other, ''),
      draft: 'Approved reply',
      approvedDraft: 'Approved reply',
      ready: true,
      status: '',
      result: '',
    });
    vi.mocked(f.platform.submit).mockResolvedValue({
      ...other,
      authorId: otherWork.actorId,
      author: otherWork.actorName,
      key: 'xhs:b:w2:new',
      commentId: 'new',
      parentCommentId: 'c2',
      content: 'Approved reply',
    });
    f.service.close();
    const restarted = createReplyService(f.options);
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect(f.rows.find((row) => row.recordId === 'rec2')?.status).toBe('sent');
    restarted.close();
  });
  it('does not infer toolbar verification from an older presentation returned by configure', async () => {
    const f = await fixture(true);
    const legacyPresentation = { ...presentation, sendMode: undefined };
    vi.mocked(f.feishu.configurePresentation!).mockResolvedValue({ ...table, presentation: legacyPresentation });
    await f.service.action({ action: 'configure' });
    expect((await f.service.status()).sendMode).toBeUndefined();
    await expect(f.service.action({ action: 'send-pending' })).rejects.toThrow('replySendButtonRequired');
    expect(f.platform.submit).not.toHaveBeenCalled();
    f.service.close();
  });
  it.each(['sent', 'uncertain'] as const)('preserves %s outcomes when migrating an old clicked row', async (phase) => {
    const f = await fixture(true);
    f.service.close();
    const file = path.join(f.options.directory, 'comment-replies.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    delete doc.buttonDispatchVersion;
    doc.attempts.push({
      id: 'old',
      recordId: f.rows[0].recordId,
      commentKey: comment.key,
      workKey: work.key,
      text: 'Approved reply',
      beforeIds: ['c'],
      preparedAt: 1,
      phase,
      ...(phase === 'sent' ? { result: sent, resultWritten: true } : {}),
    });
    writeFileSync(file, JSON.stringify(doc));
    const restarted = createReplyService(f.options);
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(new ReplyStore(f.options.directory).read().attempts[0].phase).toBe(phase);
    expect(f.feishu.claimDraft).not.toHaveBeenCalled();
    expect(f.rows[0].ready).toBe(true);
    restarted.close();
  });
  it('normalizes legacy enabled automatic settings on restart without any polling or sends', async () => {
    const f = await fixture(false);
    f.service.close();
    const file = path.join(f.options.directory, 'comment-replies.json');
    const legacy = JSON.parse(readFileSync(file, 'utf8'));
    legacy.enabled = true;
    legacy.buttonDispatchMode = 'automatic';
    writeFileSync(file, JSON.stringify(legacy));
    vi.useFakeTimers();
    try {
      vi.mocked(f.feishu.inspect).mockClear();
      vi.mocked(f.feishu.list).mockClear();
      const restarted = createReplyService({ ...f.options, pollMs: undefined });
      await vi.advanceTimersByTimeAsync(60000);
      expect(await restarted.status()).toMatchObject({ enabled: false, buttonDispatchMode: 'manual' });
      expect(f.feishu.inspect).not.toHaveBeenCalled();
      expect(f.feishu.list).not.toHaveBeenCalled();
      expect(f.platform.collect).not.toHaveBeenCalled();
      expect(f.platform.submit).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ enabled: false, buttonDispatchMode: 'manual' });
      restarted.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cancelled legacy recovery durable and clears the old approval on explicit reconciliation', async () => {
    const f = await fixture(true);
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      delete doc.table!.presentation!.sendMode;
      doc.approvals.push({ id: 'legacy', recordId: f.rows[0].recordId });
    });
    const caller = new AbortController();
    vi.mocked(f.feishu.consumeApproval).mockImplementationOnce(async () => {
      caller.abort();
      throw new Error('interrupted');
    });
    const recovering = createReplyService(f.options);
    await expect(recovering.action({ action: 'reconcile' }, caller.signal)).rejects.toThrow('replyPaused');
    expect(new ReplyStore(f.options.directory).read().approvals).toHaveLength(1);
    recovering.close();
    const restarted = createReplyService(f.options);
    await restarted.action({ action: 'reconcile' });
    expect(f.rows[0]).toMatchObject({ ready: false, status: 'attention', result: 'replyApprovalInterrupted' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(new ReplyStore(f.options.directory).read().approvals).toEqual([]);
    restarted.close();
  });
  it('recovers a durably cancelled button request after restart without sending', async () => {
    const f = await fixture(true);
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      doc.approvalBlocks.push(f.rows[0].recordId);
    });
    const restarted = createReplyService(f.options);
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({
      ready: false,
      draft: 'Approved reply',
      status: 'attention',
      result: 'replyApprovalInterrupted',
    });
    expect(new ReplyStore(f.options.directory).read().approvalBlocks).toEqual([]);
    restarted.close();
  });
  it('manual mode persists across restart and does no background table reads', async () => {
    const f = await fixture(true);
    await f.service.action({ action: 'dispatch-mode', mode: 'manual' });
    f.service.close();
    const file = path.join(f.options.directory, 'comment-replies.json');
    const old = JSON.parse(readFileSync(file, 'utf8'));
    delete old.buttonDispatchVersion;
    writeFileSync(file, JSON.stringify(old));
    vi.useFakeTimers();
    try {
      vi.mocked(f.feishu.inspect).mockClear();
      vi.mocked(f.feishu.list).mockClear();
      const restarted = createReplyService({ ...f.options, pollMs: 10 });
      await vi.advanceTimersByTimeAsync(100);
      expect(await restarted.status()).toMatchObject({ buttonDispatchMode: 'manual' });
      expect(f.feishu.inspect).not.toHaveBeenCalled();
      expect(f.feishu.list).not.toHaveBeenCalled();
      restarted.close();
    } finally {
      vi.useRealTimers();
    }
  });
  it('manual send handles all trusted rows from the initial snapshot, excluding later approvals', async () => {
    const f = await fixture(true);
    const c2 = { ...comment, key: 'xhs:a:w:c2', commentId: 'c2' };
    const c3 = { ...comment, key: 'xhs:a:w:c3', commentId: 'c3' };
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      doc.comments.push(c2, c3);
      doc.records[c2.key] = 'rec2';
      doc.records[c3.key] = 'rec3';
    });
    f.rows.push(
      {
        recordId: 'rec2',
        messageKey: c2.key,
        source: replySourceValues(work, c2, ''),
        draft: 'Approved reply',
        approvedDraft: 'Approved reply',
        ready: true,
        status: '',
        result: '',
      },
      {
        recordId: 'rec3',
        messageKey: c3.key,
        source: replySourceValues(work, c3, ''),
        draft: 'Approved reply',
        approvedDraft: 'Approved reply',
        ready: false,
        status: '',
        result: '',
      }
    );
    const restarted = createReplyService(f.options);
    await restarted.action({ action: 'dispatch-mode', mode: 'manual' });
    vi.mocked(f.platform.submit).mockImplementation(async (_lease, _work, target) => {
      f.rows.find((row) => row.recordId === 'rec3')!.ready = true;
      return {
        ...sent,
        key: `reply:${target.commentId}`,
        commentId: `reply-${target.commentId}`,
        parentCommentId: target.commentId,
      };
    });
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(2);
    expect(f.rows.find((row) => row.recordId === 'rec2')?.status).toBe('sent');
    expect(f.rows.find((row) => row.recordId === 'rec3')?.ready).toBe(true);
    restarted.close();
  });
  it('manual sync collects without delivering a ready row', async () => {
    const f = await fixture(true);
    await f.service.action({ action: 'dispatch-mode', mode: 'manual' });
    await f.service.action({ action: 'sync' });
    expect(f.platform.collect).toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0].ready).toBe(true);
    f.service.close();
  });
  it('rejects a legacy automatic-mode request without disrupting the explicit manual batch', async () => {
    const f = await twoManualRows();
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.mocked(f.platform.submit).mockImplementation(async (_lease, _work, target) => {
      enter();
      await gate;
      return {
        ...sent,
        key: `reply:${target.commentId}`,
        commentId: `reply-${target.commentId}`,
        parentCommentId: target.commentId,
      };
    });
    const batch = f.service.action({ action: 'send-pending' });
    await entered;
    await expect(f.service.action({ action: 'dispatch-mode', mode: 'automatic' })).rejects.toThrow(
      'replyManualModeRequired'
    );
    await f.service.action({ action: 'dispatch-mode', mode: 'manual' });
    resume();
    await batch;
    expect(f.platform.submit).toHaveBeenCalledTimes(2);
    expect(f.rows.find((row) => row.recordId === 'rec2')).toMatchObject({ ready: false, status: 'sent' });
    f.service.close();
  });
  it('prevents overlapping manual batches and cancels the active row without consuming the rest', async () => {
    const f = await twoManualRows();
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.mocked(f.platform.prepare).mockImplementation(async () => {
      enter();
      await gate;
      return { beforeIds: ['c'], preparedAt: 1 };
    });
    const batch = f.service.action({ action: 'send-pending' });
    await entered;
    await expect(f.service.action({ action: 'send-pending' })).rejects.toThrow('replyBusy');
    await f.service.action({ action: 'cancel' });
    resume();
    await batch;
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows.find((row) => row.recordId === 'rec2')?.ready).toBe(true);
    f.service.close();
  });
  it('skips a later row whose draft changes after the snapshot', async () => {
    const f = await twoManualRows();
    vi.mocked(f.platform.submit).mockImplementationOnce(async () => {
      f.rows.find((row) => row.recordId === 'rec2')!.draft = 'changed';
      return sent;
    });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect(f.rows.find((row) => row.recordId === 'rec2')).toMatchObject({
      draft: 'changed',
      ready: true,
      status: '',
    });
    f.service.close();
  });
  it('requires button configuration for explicit manual sends', async () => {
    const legacy = await fixture(false);
    await expect(legacy.service.action({ action: 'send-pending' })).rejects.toThrow('replySendButtonRequired');
    expect(legacy.platform.submit).not.toHaveBeenCalled();
    legacy.service.close();
  });

  it('refuses an old manual queue before any preparation or remote approval mutation', async () => {
    const f = await fixture(true);
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      delete doc.table!.presentation!.sendMode;
      delete doc.buttonDispatchVersion;
    });
    const service = createReplyService(f.options);
    await expect(service.action({ action: 'send-pending' })).rejects.toThrow('replySendButtonRequired');
    expect(f.platform.prepare).not.toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.feishu.consumeApproval).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ ready: true, status: '' });
    service.close();
  });
  it('does not retry an uncertain row and sends another account in the manual batch', async () => {
    const f = await fixture(true);
    const otherWork = { ...work, key: 'xhs:b:w2', accountId: 'b', workId: 'w2' };
    const other = {
      ...comment,
      key: 'xhs:b:w2:c2',
      workKey: otherWork.key,
      accountId: 'b',
      workId: 'w2',
      commentId: 'c2',
    };
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      doc.works.push(otherWork);
      doc.comments.push(other);
      doc.records[other.key] = 'rec2';
      doc.attempts.push({
        id: 'uncertain',
        recordId: f.rows[0].recordId,
        commentKey: comment.key,
        workKey: work.key,
        text: 'Approved reply',
        beforeIds: ['c'],
        preparedAt: 1,
        phase: 'uncertain',
      });
    });
    f.rows.push({
      recordId: 'rec2',
      messageKey: other.key,
      source: replySourceValues(otherWork, other, ''),
      draft: 'Approved reply',
      approvedDraft: 'Approved reply',
      ready: true,
      status: '',
      result: '',
    });
    vi.mocked(f.platform.submit).mockResolvedValue({
      ...other,
      authorId: otherWork.actorId,
      author: otherWork.actorName,
      key: 'xhs:b:w2:new',
      commentId: 'new',
      parentCommentId: 'c2',
      content: 'Approved reply',
    });
    const service = createReplyService(f.options);
    await service.action({ action: 'dispatch-mode', mode: 'manual' });
    await service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect(f.rows.find((row) => row.recordId === 'rec2')?.status).toBe('sent');
    expect((await service.status()).uncertain).toBe(1);
    service.close();
  });
  it('revokes a button approval recovered after a crash before its remote consumption', async () => {
    const f = await fixture(true);

    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      doc.approvals.push({ id: 'interrupted-approval', recordId: f.rows[0].recordId });
    });
    const restarted = createReplyService(f.options);
    await restarted.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ ready: false, status: 'attention', result: 'replyApprovalInterrupted' });
    expect(new ReplyStore(f.options.directory).read().approvals).toEqual([]);
    restarted.close();
  });
  it.each([false, true])(
    'retains the recovery lock when approval clearing reports %s but leaves ready checked',
    async (consumed) => {
      const f = await fixture(true);

      f.service.close();
      new ReplyStore(f.options.directory).update((doc) => {
        doc.approvals.push({ id: 'interrupted-approval', recordId: f.rows[0].recordId });
      });
      vi.mocked(f.feishu.consumeApproval).mockResolvedValue(consumed);
      const restarted = createReplyService(f.options);
      await restarted.action({ action: 'send-pending' });
      expect(f.platform.submit).not.toHaveBeenCalled();
      expect(f.rows[0].ready).toBe(true);
      expect(new ReplyStore(f.options.directory).read().approvals).toHaveLength(1);
      restarted.close();
    }
  );

  it('completes an already archived collection without an unused full-table read', async () => {
    const f = await fixture();
    vi.mocked(f.feishu.list).mockRejectedValue(new Error('unnecessary remote round trip'));
    await expect(f.service.action({ action: 'collect' })).resolves.toMatchObject({ archived: 1, sent: 0 });
    f.service.close();
  });
  it('reports bounded operation timings without comment or account payloads', async () => {
    const f = await fixture();

    const result = await f.service.action({ action: 'send-pending' });
    expect(result.timing).toMatchObject({
      action: 'send-pending',
      durationMs: expect.any(Number),
      steps: expect.arrayContaining([
        { name: 'feishu.inspect', calls: 1, durationMs: expect.any(Number) },
        { name: 'platform.xiaohongshu.submit', calls: 1, durationMs: expect.any(Number) },
      ]),
    });
    expect(JSON.stringify(result.timing)).not.toMatch(/Approved reply|Owner|baseToken|messageKey/);
    const previous = result.timing;
    await f.service.action({ action: 'enabled', enabled: false });
    expect((await f.service.status()).timing).toEqual(previous);
    f.service.close();
  });
  it('retains failed operation timing and replaces it on the next run', async () => {
    const f = await fixture();
    vi.mocked(f.feishu.inspect).mockRejectedValueOnce(new Error('offline'));
    await expect(f.service.action({ action: 'collect' })).rejects.toThrow();
    expect((await f.service.status()).timing).toMatchObject({
      action: 'collect',
      steps: [{ name: 'feishu.inspect', calls: 1, durationMs: expect.any(Number) }],
    });
    await f.service.action({ action: 'collect' });
    expect((await f.service.status()).timing?.steps.find((step) => step.name === 'feishu.inspect')?.calls).toBe(1);
    f.service.close();
  });

  it('collects and archives without consuming manually approved replies', async () => {
    const f = await fixture();

    const result = await f.service.action({ action: 'collect' });
    expect(result).toMatchObject({ enabled: false, archived: 1, sent: 0 });
    expect(f.platform.collect).toHaveBeenCalled();
    expect(f.feishu.consumeApproval).not.toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    f.service.close();
  });
  it('aborts the active caller before any later approval or send and releases the browser', async () => {
    const f = await fixture();
    const caller = new AbortController();
    vi.mocked(f.platform.collect).mockImplementation(async (_lease, _work, _refresh, signal) => {
      caller.abort();
      signal?.throwIfAborted();
      return { comments: [comment], complete: true };
    });

    await expect(f.service.action({ action: 'sync' }, caller.signal)).rejects.toThrow('replyPaused');
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalled();
    expect(await f.service.status()).toMatchObject({ busy: false, enabled: false });
    f.service.close();
  });
  it('does not let an aborted busy caller cancel the operation that already owns the service', async () => {
    const f = await fixture();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let ownerSignal: AbortSignal | undefined;
    vi.mocked(f.platform.collect).mockImplementation(async (_lease, _work, _refresh, signal) => {
      ownerSignal = signal;
      await waiting;
      signal?.throwIfAborted();
      return { comments: [comment], complete: true };
    });
    const owner = f.service.action({ action: 'sync' }, new AbortController().signal);
    await vi.waitFor(() => expect(ownerSignal).toBeDefined());
    const other = new AbortController();
    await expect(f.service.action({ action: 'sync' }, other.signal)).rejects.toThrow('replyBusy');
    other.abort();
    expect(ownerSignal?.aborted).toBe(false);
    finish();
    await owner;
    f.service.close();
  });
  it('rejects an already cancelled mutation without changing the manual-only settings', async () => {
    const f = await fixture();
    const caller = new AbortController();
    caller.abort();
    await expect(f.service.action({ action: 'enabled', enabled: true }, caller.signal)).rejects.toThrow('replyPaused');
    expect(await f.service.status()).toMatchObject({ enabled: false });
    f.service.close();
  });
  it('removes a completed caller cancellation listener before a later operation starts', async () => {
    const f = await fixture();
    const previous = new AbortController();
    await f.service.action({ action: 'collect' }, previous.signal);
    vi.mocked(f.platform.collect).mockImplementation(async (_lease, _work, _refresh, signal) => {
      previous.abort();
      signal?.throwIfAborted();
      return { comments: [comment], complete: true };
    });
    await expect(f.service.action({ action: 'collect' })).resolves.toMatchObject({ archived: 1, busy: false });
    f.service.close();
  });
  it('keeps an interrupted dispatched reply uncertain and never retries it', async () => {
    const f = await fixture();
    const caller = new AbortController();
    vi.mocked(f.platform.submit).mockImplementation(async () => {
      caller.abort();
      throw new Error('REPLY_CANCELLED');
    });

    await expect(f.service.action({ action: 'send-pending' }, caller.signal)).rejects.toThrow('replyPaused');
    expect(await f.service.status()).toMatchObject({ uncertain: 1, sent: 0 });
    f.rows[0].ready = true;
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    f.service.close();
  });
  it('never retries an uncertain platform send, including after restart', async () => {
    const f = await fixture();
    vi.mocked(f.platform.submit).mockRejectedValue(new Error('timeout'));

    await f.service.action({ action: 'send-pending' });
    f.service.close();
    const restarted = createReplyService(f.options);
    f.rows[0].ready = true;
    await restarted.action({ action: 'send-pending' });
    restarted.close();
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect((await restarted.status()).uncertain).toBe(1);
  });
  it('retries only Feishu result writing after platform success', async () => {
    const f = await fixture();
    vi.mocked(f.feishu.writeResult).mockRejectedValueOnce(new Error('offline'));

    await f.service.action({ action: 'send-pending' });
    f.rows[0].ready = true;
    await f.service.action({ action: 'send-pending' });
    f.service.close();
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect((await f.service.status()).sent).toBe(1);
    expect(f.feishu.writeResult).toHaveBeenLastCalledWith(
      { ...table, presentation },
      'rec0',
      'sent',
      expect.stringContaining('new'),
      expect.objectContaining({ key: comment.key, account: 'Owner' })
    );
  });
  it('skips a captured draft after the draft changes without editing the new text', async () => {
    const f = await fixture();
    vi.mocked(f.platform.prepare).mockImplementation(async () => {
      f.rows[0].draft = 'Edited';
      return { beforeIds: [], preparedAt: 1 };
    });

    await f.service.action({ action: 'send-pending' });
    f.service.close();
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ draft: 'Edited', ready: true });
  });
  it('does not send an edited message key or a forged ready row', async () => {
    const f = await fixture();
    f.rows[0].messageKey = 'forged';
    f.rows.push({ ...f.rows[0], recordId: 'unknown', messageKey: comment.key });

    await f.service.action({ action: 'send-pending' });
    f.service.close();
    expect(f.platform.submit).not.toHaveBeenCalled();
  });
  it('requires a new explicit batch after a draft changes while preparing', async () => {
    const f = await fixture();
    vi.mocked(f.platform.prepare).mockImplementationOnce(async () => {
      f.rows[0].draft = 'Edited';
      return { beforeIds: ['c'], preparedAt: 1 };
    });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    vi.mocked(f.platform.submit).mockResolvedValue({ ...sent, content: 'Edited' });
    await f.service.action({ action: 'send-pending' });
    f.service.close();
    expect(f.platform.submit).toHaveBeenCalledOnce();
    expect((await f.service.status()).sent).toBe(1);
  });
  it('sends to the direct parent and retains its owner reply only in the local comment tree', async () => {
    const f = await fixture();

    await f.service.action({ action: 'send-pending' });
    f.service.close();
    expect(f.platform.submit).toHaveBeenCalledWith(
      expect.anything(),
      work,
      comment,
      'Approved reply',
      expect.anything(),
      expect.anything()
    );
    expect(f.rows.map((row) => row.messageKey)).toEqual([comment.key]);
    expect(new ReplyStore(f.options.directory).read().comments.map((row) => row.key)).toContain(sent.key);
    expect(f.release).toHaveBeenCalled();
  });
  it('does not overwrite a draft or a new approval when writing the result', async () => {
    const f = await fixture();
    vi.mocked(f.platform.submit).mockImplementation(async () => {
      f.rows[0].draft = 'Next draft';
      f.rows[0].ready = true;
      return sent;
    });

    await f.service.action({ action: 'send-pending' });
    f.service.close();
    expect(f.rows[0]).toMatchObject({ draft: 'Next draft', ready: true });
  });
  it('does not recreate a Feishu record after an uncertain create', async () => {
    const f = await fixture();
    vi.mocked(f.feishu.create).mockImplementation(async () => {
      throw new Error('timeout');
    });
    const followup = { ...comment, key: 'xhs:a:w:followup', commentId: 'followup', parentCommentId: sent.commentId };
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, sent, followup], complete: true });
    await f.service.action({ action: 'sync' });
    await f.service.action({ action: 'sync' });
    f.service.close();
    expect(f.feishu.create).toHaveBeenCalledTimes(2); // Initial binding plus the one uncertain create.
  });
  it('canceling after claiming the captured draft reports interruption without clicking send', async () => {
    const f = await fixture();
    vi.mocked(f.feishu.claimDraft!).mockImplementation(async () => {
      f.rows[0].ready = false;
      await f.service.action({ action: 'cancel' });
      return true;
    });

    await f.service.action({ action: 'send-pending' });
    f.service.close();
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.feishu.writeResult).toHaveBeenCalledWith(
      { ...table, presentation },
      'rec0',
      'attention',
      'replyApprovalInterrupted',
      expect.objectContaining({ key: comment.key, account: 'Owner' })
    );
    expect(f.platform.discardPrepared).toHaveBeenCalledWith(expect.anything(), work, comment, 'Approved reply');
  });
  it('recovers a claimed draft after readback and result-write failures across restart', async () => {
    const f = await fixture();
    vi.mocked(f.feishu.get)
      .mockResolvedValueOnce(structuredClone(f.rows[0]))
      .mockResolvedValueOnce(structuredClone(f.rows[0]))
      .mockRejectedValueOnce(new Error('readback unavailable'));
    vi.mocked(f.feishu.writeResult).mockRejectedValue(new Error('result write unavailable'));

    await f.service.action({ action: 'send-pending' });
    f.service.close();
    const restarted = createReplyService(f.options);
    expect(await restarted.status()).toMatchObject({ uncertain: 1 });
    vi.mocked(f.feishu.writeResult).mockResolvedValue(undefined);
    await restarted.action({ action: 'reconcile' });
    restarted.close();
    expect(f.feishu.writeResult).toHaveBeenLastCalledWith(
      { ...table, presentation },
      'rec0',
      'attention',
      'replyApprovalInterrupted',
      expect.objectContaining({ key: comment.key, account: 'Owner' })
    );
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(await restarted.status()).toMatchObject({ uncertain: 0 });
  });
  it('does not resend the same draft when its old ready flag is reset after restart', async () => {
    const f = await fixture();

    await f.service.action({ action: 'send-pending' });
    f.service.close();
    f.rows[0].ready = true;
    const restarted = createReplyService(f.options);
    await restarted.action({ action: 'send-pending' });
    restarted.close();
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect(f.feishu.claimDraft).toHaveBeenCalledOnce();
    expect(f.feishu.consumeApproval).not.toHaveBeenCalled();
    expect(await restarted.status()).toMatchObject({ sent: 1, uncertain: 0 });
  });
  it('reconciles a timed-out click and never posts it again', async () => {
    const f = await fixture();
    vi.mocked(f.platform.submit).mockRejectedValue(new Error('timeout'));

    await f.service.action({ action: 'send-pending' });
    vi.mocked(f.platform.reconcile).mockResolvedValue(sent);
    await f.service.action({ action: 'reconcile' });
    f.service.close();
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect((await f.service.status()).sent).toBe(1);
  });
});

async function toolbarFixture() {
  const f = await fixture(true);
  f.service.close();
  new ReplyStore(f.options.directory).update((doc) => {
    doc.table!.presentation!.sendMode = 'toolbar';
  });
  Object.assign(f.rows[0], { ready: false, approvedDraft: '', status: '待处理', result: '' });
  f.feishu.claimDraft = vi.fn(async (_table, expected) => {
    const current = f.rows.find((row) => row.recordId === expected.recordId);
    if (
      !current ||
      !['recordId', 'messageKey', 'draft', 'status', 'result', 'ready', 'approvedDraft'].every(
        (key) => current[key as keyof ReplyTableRow] === expected[key as keyof ReplyTableRow]
      )
    )
      return false;
    Object.assign(current, { ready: false, approvedDraft: expected.draft, status: '发送中' });
    return true;
  });
  vi.mocked(f.platform.submit).mockImplementation(async (_lease, _work, target, text) => ({
    ...sent,
    key: `${work.key}:new-${target.commentId}`,
    commentId: `new-${target.commentId}`,
    parentCommentId: target.commentId,
    rootCommentId: target.rootCommentId,
    content: text,
  }));
  return { ...f, service: createReplyService(f.options) };
}
function addToolbarRow(f: Awaited<ReturnType<typeof toolbarFixture>>, id: string, draft = 'Another reply') {
  const target = { ...comment, key: `${work.key}:${id}`, commentId: id };
  new ReplyStore(f.options.directory).update((doc) => {
    doc.comments.push(target);
    doc.records[target.key] = `rec${id}`;
  });
  const row = {
    recordId: `rec${id}`,
    messageKey: target.key,
    source: replySourceValues(work, target, ''),
    draft,
    ready: false,
    approvedDraft: '',
    status: '待处理',
    result: '',
  };
  f.rows.push(row);
  f.service.close();
  f.service = createReplyService(f.options);
  return row;
}

describe('toolbar draft batch authorization', () => {
  it('rejects public sends from legacy presentation even when an old row was approved', async () => {
    const f = await fixture();
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      delete doc.table!.presentation!.sendMode;
    });
    f.service = createReplyService(f.options);
    await expect(f.service.action({ action: 'send-pending' })).rejects.toThrow('replySendButtonRequired');
    expect(f.platform.prepare).not.toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    f.service.close();
  });
  it.each(['author', 'time', 'comment', 'platform', 'account', 'conversation', 'parent', 'key'] as const)(
    'rejects modified source %s before claiming a captured row',
    async (field) => {
      const f = await toolbarFixture();
      f.rows[0].source![field] = 'Tampered source';
      await f.service.action({ action: 'send-pending' });
      expect(f.platform.prepare).not.toHaveBeenCalled();
      expect(f.feishu.claimDraft).not.toHaveBeenCalled();
      expect(f.platform.submit).not.toHaveBeenCalled();
      f.service.close();
    }
  );
  it.each(['author', 'time', 'comment', 'platform', 'account', 'conversation', 'parent', 'key'] as const)(
    'rejects source %s changed while preparing the captured draft',
    async (field) => {
      const f = await toolbarFixture();
      vi.mocked(f.platform.prepare).mockImplementation(async () => {
        f.rows[0].source![field] = 'Concurrent source change';
        return { beforeIds: ['c'], preparedAt: 1 };
      });
      await f.service.action({ action: 'send-pending' });
      expect(f.platform.prepare).toHaveBeenCalledOnce();
      expect(f.feishu.claimDraft).not.toHaveBeenCalled();
      expect(f.platform.submit).not.toHaveBeenCalled();
      expect(f.rows[0].source![field]).toBe('Concurrent source change');
      f.service.close();
    }
  );
  it('rejects a missing captured source before browser preparation', async () => {
    const f = await toolbarFixture();
    delete f.rows[0].source;
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.prepare).not.toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    f.service.close();
  });
  it('rejects source changed after a successful claim at the final dispatch checkpoint', async () => {
    const f = await toolbarFixture();
    const claim = f.feishu.claimDraft!;
    f.feishu.claimDraft = vi.fn(async (...args) => {
      await claim(...args);
      f.rows[0].source!.account = 'Another account';
      return true;
    });
    f.service.close();
    f.service = createReplyService(f.options);
    await f.service.action({ action: 'send-pending' });
    expect(f.feishu.claimDraft).toHaveBeenCalledOnce();
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0].source!.account).toBe('Another account');
    expect(new ReplyStore(f.options.directory).read().attempts).toEqual([]);
    f.service.close();
  });
  it('exposes only the persisted verified toolbar mode and sends filled drafts without old ready flags', async () => {
    const f = await toolbarFixture();
    addToolbarRow(f, 'second');
    expect((await f.service.status()).sendMode).toBe('toolbar');
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(2);
    expect(f.feishu.consumeApproval).not.toHaveBeenCalled();
    f.service.close();
  });
  it('captures drafts once and leaves newly entered drafts for the next explicit batch', async () => {
    const f = await toolbarFixture();
    const later = addToolbarRow(f, 'later', '');
    vi.mocked(f.platform.prepare).mockImplementation(async () => {
      later.draft = 'Typed after the click';
      return { beforeIds: ['c'], preparedAt: 1 };
    });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(1);
    expect(f.feishu.claimDraft).toHaveBeenCalledTimes(1);
    expect(later.draft).toBe('Typed after the click');
    f.service.close();
  });
  it.each([
    ['messageKey', 'foreign-key'],
    ['draft', 'Edited during prepare'],
    ['status', '已回复'],
    ['result', 'manual-platform-reply'],
    ['ready', true],
    ['approvedDraft', 'Different snapshot'],
  ] as const)('does not claim or dispatch a captured row whose %s changed during preparation', async (field, value) => {
    const f = await toolbarFixture();
    vi.mocked(f.platform.prepare).mockImplementation(async () => {
      Object.assign(f.rows[0], { [field]: value });
      return { beforeIds: ['c'], preparedAt: 1 };
    });
    await f.service.action({ action: 'send-pending' });
    expect(f.feishu.claimDraft).not.toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0][field]).toBe(value);
    f.service.close();
  });
  it.each([
    ['draft', 'New human draft'],
    ['status', '已回复'],
    ['result', 'platform-result'],
    ['ready', true],
    ['approvedDraft', 'New snapshot'],
    ['messageKey', 'foreign-key'],
  ] as const)('does not dispatch after claimed %s changes at the final checkpoint', async (field, value) => {
    const f = await toolbarFixture();
    const claim = f.feishu.claimDraft!;
    f.feishu.claimDraft = vi.fn(async (...args) => {
      await claim(...args);
      Object.assign(f.rows[0], { [field]: value });
      return true;
    });
    f.service.close();
    const service = createReplyService(f.options);
    await service.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.feishu.claimDraft).toHaveBeenCalledOnce();
    if (['draft', 'result', 'status', 'messageKey'].includes(field)) expect(f.rows[0][field]).toBe(value);
    service.close();
  });
  it('drops an unclaimed approval without overwriting a concurrent draft or result', async () => {
    const f = await toolbarFixture();
    vi.mocked(f.feishu.claimDraft!).mockImplementation(async () => {
      Object.assign(f.rows[0], { draft: 'New text', status: '已回复', result: 'manual-result' });
      return false;
    });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ draft: 'New text', status: '已回复', result: 'manual-result' });
    expect(new ReplyStore(f.options.directory).read().approvals).toEqual([]);
    f.service.close();
  });
  it('does not publish own, completed, opaque-result, empty or foreign records', async () => {
    const f = await toolbarFixture();
    Object.assign(f.rows[0], { draft: '' });
    for (const [id, status, result] of [
      ['sent', '已发送', ''],
      ['replied', '已回复', ''],
      ['own', '本人评论', ''],
      ['unknown', '待处理', 'external-result'],
      ['sending', '发送中', ''],
      ['uncertain', '需核对', 'replySendUncertain'],
    ])
      Object.assign(addToolbarRow(f, id), { status, result });
    const own = addToolbarRow(f, 'owner');
    new ReplyStore(f.options.directory).update((doc) => {
      doc.comments.find((row) => row.key === own.messageKey)!.authorId = work.actorId;
    });
    f.service.close();
    f.service = createReplyService(f.options);
    f.rows.push({ ...f.rows[0], recordId: 'recForeign', messageKey: 'foreign', draft: 'Untrusted text' });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.prepare).not.toHaveBeenCalled();
    expect(f.feishu.claimDraft).not.toHaveBeenCalled();
    f.service.close();
  });
  it('persists authorization before claiming and a dispatch intent before submitting', async () => {
    const f = await toolbarFixture();
    const evidence: string[] = [];
    vi.mocked(f.feishu.claimDraft!).mockImplementation(async (_table, expected) => {
      evidence.push(new ReplyStore(f.options.directory).read().approvals.length ? 'approval' : 'missing');
      Object.assign(f.rows[0], { ready: false, approvedDraft: expected.draft, status: '发送中' });
      return true;
    });
    vi.mocked(f.platform.submit).mockImplementation(async () => {
      evidence.push(new ReplyStore(f.options.directory).read().attempts[0]?.phase ?? 'missing');
      return { ...sent };
    });
    await f.service.action({ action: 'send-pending' });
    expect(evidence).toEqual(['approval', 'dispatching']);
    f.service.close();
  });
  it('recovers starting approvals without including that row in the same toolbar batch', async () => {
    const f = await toolbarFixture();
    new ReplyStore(f.options.directory).update((doc) => {
      doc.approvals.push({ id: 'old-authorization', recordId: f.rows[0].recordId });
    });
    f.service.close();
    f.service = createReplyService(f.options);
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });
  it('never resends a local completed or uncertain attempt even if remote fields are reset', async () => {
    const f = await toolbarFixture();
    await f.service.action({ action: 'send-pending' });
    Object.assign(f.rows[0], { draft: 'Changed again', result: '', status: '待处理', ready: false, approvedDraft: '' });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });
  it.each(['approval', 'block'] as const)(
    'preserves a concurrently completed row with an old ready flag during %s recovery',
    async (kind) => {
      const f = await toolbarFixture();
      Object.assign(f.rows[0], { ready: true, status: '已回复', result: '' });
      new ReplyStore(f.options.directory).update((doc) => {
        if (kind === 'approval') doc.approvals.push({ id: 'old', recordId: f.rows[0].recordId });
        else doc.approvalBlocks.push(f.rows[0].recordId);
      });
      f.service.close();
      f.service = createReplyService(f.options);
      vi.mocked(f.feishu.consumeApproval).mockImplementation(async (_table, row) => {
        Object.assign(f.rows.find((item) => item.recordId === row.recordId)!, { ready: false, status: '发送中' });
        return true;
      });
      await f.service.action({ action: 'send-pending' });
      expect(f.rows[0]).toMatchObject({ ready: true, status: '已回复', result: '' });
      expect(f.feishu.consumeApproval).not.toHaveBeenCalled();
      expect(f.platform.submit).not.toHaveBeenCalled();
      expect(new ReplyStore(f.options.directory).read()).toMatchObject({ approvals: [], approvalBlocks: [] });
      f.service.close();
    }
  );
  it.each(['尚未发送，请检查回复内容后重新勾选可发送', '尚未发送，请检查回复内容后点击上方“发送评论”'])(
    'allows a new toolbar authorization after known no-dispatch result: %s',
    async (result) => {
      const f = await toolbarFixture();
      Object.assign(f.rows[0], { status: '未发送', result });
      await f.service.action({ action: 'send-pending' });
      expect(f.feishu.claimDraft).toHaveBeenCalledOnce();
      expect(f.platform.submit).toHaveBeenCalledOnce();
      f.service.close();
    }
  );
  it('does not resume a cancelled batch and recovers its row before a later authorization', async () => {
    const f = await toolbarFixture();
    const later = addToolbarRow(f, 'second');
    vi.mocked(f.feishu.claimDraft!).mockImplementationOnce(async (_table, expected) => {
      Object.assign(f.rows[0], { ready: false, approvedDraft: expected.draft, status: '发送中' });
      await f.service.action({ action: 'cancel' });
      return true;
    });
    await f.service.action({ action: 'send-pending' });
    expect(f.feishu.claimDraft).toHaveBeenCalledOnce();
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(later).toMatchObject({ status: '待处理', ready: false, approvedDraft: '' });
    expect(f.platform.discardPrepared).toHaveBeenCalledOnce();
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    expect(vi.mocked(f.platform.submit).mock.calls[0][2].commentId).toBe('second');
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledTimes(2);
    f.service.close();
  });
  it('keeps a failed claim durable across restart without ever submitting or resuming that row', async () => {
    const f = await toolbarFixture();
    vi.mocked(f.feishu.claimDraft!).mockImplementationOnce(async (_table, expected) => {
      Object.assign(f.rows[0], { ready: false, approvedDraft: expected.draft, status: '发送中' });
      throw new Error('readback timeout');
    });
    vi.mocked(f.feishu.writeResult).mockRejectedValueOnce(new Error('result offline'));
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(new ReplyStore(f.options.directory).read().approvals).toHaveLength(1);
    f.service.close();
    f.service = createReplyService(f.options);
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(new ReplyStore(f.options.directory).read().approvals).toHaveLength(0);
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });
  it('leaves later edited drafts outside the captured authorization', async () => {
    const f = await toolbarFixture();
    const later = addToolbarRow(f, 'later');
    vi.mocked(f.platform.submit).mockImplementationOnce(async () => {
      later.draft = 'Edited during the previous send';
      return sent;
    });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    expect(f.feishu.claimDraft).toHaveBeenCalledOnce();
    expect(later).toMatchObject({ draft: 'Edited during the previous send', status: '待处理', approvedDraft: '' });
    f.service.close();
  });
  it('backfills a newly observed manual reply before claiming a filled toolbar draft', async () => {
    const f = await toolbarFixture();
    vi.mocked(f.platform.prepare).mockResolvedValue({
      beforeIds: ['c', 'new'],
      preparedAt: 1,
      existingReplies: [sent],
    });
    await f.service.action({ action: 'send-pending' });
    expect(f.feishu.claimDraft).not.toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0]).toMatchObject({ draft: sent.content, ready: false, approvedDraft: '', status: 'replied' });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.prepare).toHaveBeenCalledOnce();
    f.service.close();
  });
  it('keeps collect and sync free of publication in toolbar mode', async () => {
    const f = await toolbarFixture();
    await f.service.action({ action: 'collect' });
    await f.service.action({ action: 'sync' });
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.feishu.claimDraft).not.toHaveBeenCalled();
    f.service.close();
  });
});

describe('durable reply source and duplicate identity', () => {
  it('rejects an observed pre-dispatch reply from a different account', async () => {
    const f = await toolbarFixture();
    vi.mocked(f.platform.prepare).mockResolvedValue({
      beforeIds: ['c', 'new'],
      preparedAt: 1,
      existingReplies: [{ ...sent, accountId: 'other-account' }],
    });

    const result = await f.service.action({ action: 'send-pending' });
    expect(result.error).toBe('replyTargetMismatch');
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0].draft).toBe('Approved reply');
    expect(new ReplyStore(f.options.directory).read().comments.map((item) => item.key)).not.toContain(sent.key);
    f.service.close();
  });

  it('backfills a verified owner reply found before the platform click without retaining an uncertain attempt', async () => {
    const f = await toolbarFixture();
    const manual = { ...sent, content: 'Replied from another device' };
    vi.mocked(f.platform.submit).mockResolvedValue({ kind: 'not-sent-existing-replies', replies: [manual] } as never);

    const result = await f.service.action({ action: 'send-pending' });
    expect(result.uncertain).toBe(0);
    expect(result.sent).toBe(0);
    expect(f.rows[0]).toMatchObject({ draft: manual.content, ready: false, status: 'replied' });
    expect(new ReplyStore(f.options.directory).read().attempts).toEqual([]);
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('persists the no-click reply and removes the dispatch intent in one durable update', async () => {
    const f = await toolbarFixture();
    const manual = { ...sent, content: 'Replied from another device' };
    vi.mocked(f.platform.submit).mockResolvedValue({ kind: 'not-sent-existing-replies', replies: [manual] });
    const original = ReplyStore.prototype.update;
    const transitionalStates: boolean[] = [];
    const spy = vi.spyOn(ReplyStore.prototype, 'update').mockImplementation(function (change) {
      original.call(this, change);
      const state = this.read();
      if (state.comments.some((item) => item.key === manual.key))
        transitionalStates.push(state.attempts.some((attempt) => attempt.phase === 'dispatching'));
    });
    try {
      await f.service.action({ action: 'send-pending' });
      expect(transitionalStates.length).toBeGreaterThan(0);
      expect(transitionalStates).not.toContain(true);
    } finally {
      spy.mockRestore();
      f.service.close();
    }
  });

  it('backfills every verified no-click owner reply in platform time order', async () => {
    const f = await toolbarFixture();
    const first = { ...sent, content: 'First manual reply', createdAt: 2 };
    const second = {
      ...sent,
      key: `${work.key}:second-manual`,
      commentId: 'second-manual',
      content: 'Second manual reply',
      createdAt: 3,
    };
    vi.mocked(f.platform.submit).mockResolvedValue({ kind: 'not-sent-existing-replies', replies: [second, first] });

    const result = await f.service.action({ action: 'send-pending' });
    expect(result.sent).toBe(0);
    expect(result.uncertain).toBe(0);
    expect(f.rows[0]).toMatchObject({ draft: 'First manual reply\n\nSecond manual reply', status: 'replied' });
    expect(new ReplyStore(f.options.directory).read().attempts).toEqual([]);
    f.service.close();
  });

  it.each(['different parent', 'different account', 'different author', 'empty replies'] as const)(
    'keeps an invalid no-click result uncertain for %s',
    async (kind) => {
      const f = await toolbarFixture();
      const manual = { ...sent, content: 'Replied from another device' };
      if (kind === 'different parent') manual.parentCommentId = 'foreign-parent';
      if (kind === 'different account') manual.accountId = 'foreign-account';
      if (kind === 'different author') manual.authorId = 'foreign-author';
      vi.mocked(f.platform.submit).mockResolvedValue({
        kind: 'not-sent-existing-replies',
        replies: kind === 'empty replies' ? [] : [manual],
      });

      const result = await f.service.action({ action: 'send-pending' });
      expect(result.uncertain).toBe(1);
      expect(f.rows[0].draft).toBe('Approved reply');
      expect(new ReplyStore(f.options.directory).read().attempts[0].phase).toBe('uncertain');
      await f.service.action({ action: 'send-pending' });
      expect(f.platform.submit).toHaveBeenCalledOnce();
      f.service.close();
    }
  );

  it('keeps observed no-click evidence pending if the platform reply backfill fails', async () => {
    const f = await toolbarFixture();
    const manual = { ...sent, content: 'Replied from another device' };
    vi.mocked(f.platform.submit).mockResolvedValue({ kind: 'not-sent-existing-replies', replies: [manual] });
    vi.mocked(f.feishu.writeObservedReply!).mockRejectedValue(new Error('offline'));

    const result = await f.service.action({ action: 'send-pending' });
    const saved = new ReplyStore(f.options.directory).read();
    expect(result).toMatchObject({ error: 'replyResultPending', uncertain: 1 });
    expect(saved.attempts).toEqual([]);
    expect(saved.observedReplies[0]).toMatchObject({ text: manual.content, written: false });
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('keeps an archived row sendable after the platform account display name changes', async () => {
    const f = await toolbarFixture();
    vi.mocked(f.platform.inspectCurrent).mockResolvedValue({
      work: { ...work, actorName: 'Renamed owner' },
      collection: { comments: [comment], complete: true },
    });
    await f.service.action({ action: 'bind', accountId: work.accountId });

    await f.service.action({ action: 'send-pending' });
    expect(f.rows[0].source?.account).toBe('Owner');
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('keeps an archived row sendable when its parent arrives after the original archive', async () => {
    const f = await toolbarFixture();
    const parent: ReplyComment = {
      ...comment,
      key: 'xhs:a:w:root',
      commentId: 'root',
      rootCommentId: 'root',
      parentCommentId: null,
      authorId: work.actorId,
      content: 'Previously unloaded parent',
    };
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, parent], complete: true });
    await f.service.action({ action: 'sync' });

    await f.service.action({ action: 'send-pending' });
    expect(f.rows[0].source?.parent).toBe('');
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('reports a changed message key for a trusted record instead of silently skipping it', async () => {
    const f = await toolbarFixture();
    f.rows[0].messageKey = 'changed-message-key';

    const result = await f.service.action({ action: 'send-pending' });
    expect(result.error).toBe('replySourceIdentityChanged');
    expect(f.platform.prepare).not.toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    f.service.close();
  });

  it('reports a source change during preparation as a source error rather than a draft error', async () => {
    const f = await toolbarFixture();
    vi.mocked(f.platform.prepare).mockImplementation(async () => {
      f.rows[0].source!.comment = 'Changed source during preparation';
      return { beforeIds: ['c'], preparedAt: 1 };
    });

    const result = await f.service.action({ action: 'send-pending' });
    expect(result.error).toBe('replySourceIdentityChanged');
    expect(f.feishu.claimDraft).not.toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    f.service.close();
  });

  it('allows a new explicit batch after a thread-incomplete failure before dispatch', async () => {
    const f = await toolbarFixture();
    vi.mocked(f.platform.prepare).mockRejectedValueOnce(new Error('replyThreadIncomplete'));

    expect((await f.service.action({ action: 'send-pending' })).error).toBe('replyThreadIncomplete');
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(new ReplyStore(f.options.directory).read().attempts).toEqual([]);
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('reports ambiguous platform snapshot evidence as an incomplete thread', async () => {
    const f = await toolbarFixture();
    vi.mocked(f.platform.prepare).mockRejectedValueOnce(new Error('REPLY_SNAPSHOT_AMBIGUOUS'));

    expect((await f.service.action({ action: 'send-pending' })).error).toBe('replyThreadIncomplete');
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(new ReplyStore(f.options.directory).read().attempts).toEqual([]);
    f.service.close();
  });

  it('recognizes a known no-click incomplete-thread result on the next explicit batch', async () => {
    const f = await toolbarFixture();
    Object.assign(f.rows[0], { status: '未发送', result: '评论回复未完全加载，确认后请重新点击发送' });

    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('never retries an uncertain attempt even if its row has an incomplete-thread explanation', async () => {
    const f = await toolbarFixture();
    vi.mocked(f.platform.submit).mockRejectedValueOnce(new Error('Lost response'));
    await f.service.action({ action: 'send-pending' });
    Object.assign(f.rows[0], { status: '未发送', result: '评论回复未完全加载，确认后请重新点击发送' });

    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    expect(new ReplyStore(f.options.directory).read().attempts[0].phase).toBe('uncertain');
    f.service.close();
  });

  it('does not overwrite a draft with a manual reply when its trusted source was changed', async () => {
    const f = await toolbarFixture();
    f.rows[0].source!.comment = 'Changed source';
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, sent], complete: true });

    const result = await f.service.action({ action: 'sync' });
    expect(result.error).toBe('replySourceIdentityChanged');
    expect(f.feishu.writeObservedReply).not.toHaveBeenCalled();
    expect(f.rows[0].draft).toBe('Approved reply');
    expect(new ReplyStore(f.options.directory).read().observedReplies[0].written).toBe(false);
    f.service.close();
  });

  it('upgrades an old mapping only from matching local source evidence', async () => {
    const f = await toolbarFixture();
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      delete doc.sourceSnapshots[comment.key];
    });
    f.service = createReplyService(f.options);

    await f.service.action({ action: 'send-pending' });
    expect(new ReplyStore(f.options.directory).read().sourceSnapshots[comment.key]).toMatchObject({
      key: comment.key,
      account: 'Owner',
      parent: '',
    });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('does not persist source snapshots merely by reading status from a legacy store', async () => {
    const f = await toolbarFixture();
    f.service.close();
    const file = path.join(f.options.directory, 'comment-replies.json');
    const legacy = JSON.parse(readFileSync(file, 'utf8'));
    delete legacy.sourceSnapshots;
    const contents = JSON.stringify(legacy);
    writeFileSync(file, contents);
    f.service = createReplyService(f.options);

    await f.service.action({ action: 'status' });
    expect(readFileSync(file, 'utf8')).toBe(contents);
    f.service.close();
  });

  it('freezes matching legacy evidence before a rebind changes the display name', async () => {
    const f = await toolbarFixture();
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      delete doc.sourceSnapshots[comment.key];
    });
    f.service = createReplyService(f.options);
    vi.mocked(f.platform.inspectCurrent).mockResolvedValue({
      work: { ...work, actorName: 'Renamed owner' },
      collection: { comments: [comment], complete: true },
    });

    await f.service.action({ action: 'bind', accountId: work.accountId });
    await f.service.action({ action: 'send-pending' });
    expect(new ReplyStore(f.options.directory).read().sourceSnapshots[comment.key]?.account).toBe('Owner');
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('keeps old local metadata when a legacy source cannot be verified before rebind', async () => {
    const f = await toolbarFixture();
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      delete doc.sourceSnapshots[comment.key];
    });
    f.rows[0].source!.comment = 'Changed remote source';
    f.service = createReplyService(f.options);
    vi.mocked(f.platform.inspectCurrent).mockResolvedValue({
      work: { ...work, actorName: 'Renamed owner' },
      collection: { comments: [comment], complete: true },
    });

    await expect(f.service.action({ action: 'bind', accountId: work.accountId })).rejects.toThrow(
      'replySourceIdentityChanged'
    );
    const saved = new ReplyStore(f.options.directory).read();
    expect(saved.works[0].actorName).toBe('Owner');
    expect(saved.sourceSnapshots[comment.key]).toBeUndefined();
    expect(f.rows[0].draft).toBe('Approved reply');
    f.service.close();
  });

  it('freezes matching legacy evidence before a previously unseen parent arrives', async () => {
    const f = await toolbarFixture();
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      delete doc.sourceSnapshots[comment.key];
    });
    f.service = createReplyService(f.options);
    const parent: ReplyComment = {
      ...comment,
      key: 'xhs:a:w:root',
      commentId: 'root',
      rootCommentId: 'root',
      parentCommentId: null,
      authorId: work.actorId,
      content: 'Previously unloaded parent',
    };
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, parent], complete: true });

    await f.service.action({ action: 'sync' });
    await f.service.action({ action: 'send-pending' });
    expect(new ReplyStore(f.options.directory).read().sourceSnapshots[comment.key]?.parent).toBe('');
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('does not infer an old source snapshot from a mismatching remote record', async () => {
    const f = await toolbarFixture();
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      delete doc.sourceSnapshots[comment.key];
      doc.works[0].actorName = 'Renamed owner';
    });
    f.service = createReplyService(f.options);

    const result = await f.service.action({ action: 'send-pending' });
    expect(result.error).toBe('replySourceIdentityChanged');
    expect(new ReplyStore(f.options.directory).read().sourceSnapshots[comment.key]).toBeUndefined();
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows[0].source?.account).toBe('Owner');
    f.service.close();
  });

  it('persists the source with a pending create before the remote request', async () => {
    const f = await fixture();
    const followup = { ...comment, key: 'xhs:a:w:followup', commentId: 'followup', content: 'Later question' };
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, followup], complete: true });
    let persisted: Record<string, unknown> | undefined;
    vi.mocked(f.feishu.create).mockImplementation(async () => {
      persisted = JSON.parse(readFileSync(path.join(f.options.directory, 'comment-replies.json'), 'utf8'));
      throw new Error('Lost creation response');
    });

    await f.service.action({ action: 'sync' });
    expect(persisted?.pendingCreates).toContain(followup.key);
    expect((persisted?.sourceSnapshots as Record<string, unknown> | undefined)?.[followup.key]).toMatchObject({
      key: followup.key,
      comment: followup.content,
      account: work.actorName,
      parent: '',
    });
    f.service.close();
  });

  it('recovers a pending create with its original source after display metadata changes', async () => {
    const f = await fixture();
    const followup = { ...comment, key: 'xhs:a:w:followup', commentId: 'followup', content: 'Later question' };
    vi.mocked(f.platform.collect).mockResolvedValue({ comments: [comment, followup], complete: true });
    vi.mocked(f.feishu.create).mockRejectedValue(new Error('Lost creation response'));
    await f.service.action({ action: 'sync' });
    f.service.close();
    const saved = new ReplyStore(f.options.directory).read().sourceSnapshots[followup.key];
    new ReplyStore(f.options.directory).update((doc) => {
      doc.works[0].actorName = 'Renamed owner';
    });
    vi.mocked(f.feishu.recover).mockResolvedValue('recRecovered');
    f.service = createReplyService(f.options);

    await f.service.action({ action: 'sync' });
    expect(f.feishu.recover).toHaveBeenCalledWith(
      { ...table, presentation },
      expect.objectContaining({ actorName: 'Renamed owner' }),
      followup,
      '',
      saved
    );
    expect(new ReplyStore(f.options.directory).read().sourceSnapshots[followup.key]).toEqual(saved);
    f.service.close();
  });

  it('does not recover a historical pending create without saved source evidence', async () => {
    const f = await fixture();
    const followup = { ...comment, key: 'xhs:a:w:followup', commentId: 'followup', content: 'Later question' };
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      doc.comments.push(followup);
      doc.pendingCreates.push(followup.key);
    });
    f.service = createReplyService(f.options);

    const result = await f.service.action({ action: 'sync' });
    expect(result.error).toBe('replySourceIdentityChanged');
    expect(f.feishu.recover).not.toHaveBeenCalled();
    expect(new ReplyStore(f.options.directory).read().pendingCreates).toContain(followup.key);
    f.service.close();
  });

  it('keeps a confirmed platform result locally if source changes before its Feishu writeback', async () => {
    const f = await toolbarFixture();
    vi.mocked(f.platform.submit).mockImplementation(async () => {
      f.rows[0].source!.comment = 'Changed during delivery';
      return sent;
    });

    const result = await f.service.action({ action: 'send-pending' });
    const saved = new ReplyStore(f.options.directory).read();
    expect(result.error).toBe('replySourceIdentityChanged');
    expect(saved.attempts[0].phase).toBe('sent');
    expect(saved.attempts[0].resultWritten).toBeUndefined();
    expect(f.feishu.writeResult).not.toHaveBeenCalled();
    await f.service.action({ action: 'send-pending' });
    expect(f.platform.submit).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('refuses to bind the same platform account and work in a second browser partition', async () => {
    const f = await toolbarFixture();
    const secondWork = { ...work, key: 'xhs:b:w', accountId: 'b' };
    const secondComment = { ...comment, key: 'xhs:b:w:c', workKey: secondWork.key, accountId: 'b' };
    vi.mocked(f.platform.inspectCurrent).mockResolvedValue({
      work: secondWork,
      collection: { comments: [secondComment], complete: true },
    });

    await expect(f.service.action({ action: 'bind', accountId: 'b' })).rejects.toThrow('replyDuplicateWork');
    expect(f.rows).toHaveLength(1);
    f.service.close();
  });

  it('blocks legacy duplicate mappings for the same platform comment across browser partitions', async () => {
    const f = await toolbarFixture();
    const secondWork = { ...work, key: 'xhs:b:w', accountId: 'b' };
    const secondComment = { ...comment, key: 'xhs:b:w:c', workKey: secondWork.key, accountId: 'b' };
    f.service.close();
    new ReplyStore(f.options.directory).update((doc) => {
      doc.works.push(secondWork);
      doc.comments.push(secondComment);
      doc.records[secondComment.key] = 'recSecond';
    });
    f.rows.push({
      ...structuredClone(f.rows[0]),
      recordId: 'recSecond',
      messageKey: secondComment.key,
      source: replySourceValues(secondWork, secondComment, ''),
    });
    f.service = createReplyService(f.options);

    const result = await f.service.action({ action: 'send-pending' });
    expect(result.error).toBe('replyDuplicateComment');
    expect(f.platform.prepare).not.toHaveBeenCalled();
    expect(f.platform.submit).not.toHaveBeenCalled();
    expect(f.rows).toHaveLength(2);
    f.service.close();
  });
});

it('allows a DM detail to locate a locally bound comment before Feishu archiving without changing old link resolution', async () => {
  const f = await fixture();
  f.service.close();
  new ReplyStore(f.options.directory).update((doc) => {
    delete doc.records[comment.key];
  });
  const service = createReplyService(f.options);
  const token = commentLinkToken(comment);
  await expect(service.action({ action: 'resolve-comment', token })).rejects.toThrow('replyCommentLinkInvalid');
  expect((await service.action({ action: 'resolve-comment', token, fromDm: true })).commentTarget?.accountId).toBe('a');
  service.close();
});
