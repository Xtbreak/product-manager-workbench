import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplyComment, ReplyWork } from '@/common/types/platform/workbenchReply';
import { observedReplies } from '@process/services/workbench/replies/observedReplies';
import { commentLinkToken } from '@process/services/workbench/replies/commentLinks';
import { ReplyStore } from '@process/services/workbench/replies/store';
import { createReplyService } from '@process/services/workbench/replies/service';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const work: ReplyWork = {
  key: 'xiaohongshu:account:owner:work',
  platform: 'xiaohongshu',
  accountId: 'account',
  actorId: 'owner',
  actorName: 'Owner',
  workId: 'work',
  title: 'Work',
  url: 'https://www.xiaohongshu.com/explore/work',
};
const node = (id: string, authorId: string, parent: string | null, root = 'root'): ReplyComment => ({
  key: `${work.key}:${id}`,
  workKey: work.key,
  platform: work.platform,
  accountId: work.accountId,
  actorId: work.actorId,
  workId: work.workId,
  commentId: id,
  rootCommentId: root,
  parentCommentId: parent,
  authorId,
  author: authorId,
  content: id,
  createdAt: 1,
});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'observed-replies-'));
  directories.push(directory);
  const store = new ReplyStore(directory);
  store.update((doc) => {
    doc.works.push(work);
    doc.comments.push(node('root', 'customer', null));
    doc.records[`${work.key}:root`] = 'record';
  });
  return { directory, store };
}
describe('Platform reply association', () => {
  it('does not turn legacy owner roots into customer reply targets', () => {
    const { store } = fixture();
    store.update((doc) => {
      doc.comments[0].authorId = 'owner';
      doc.comments.push(node('own-followup', 'owner', 'root'));
    });
    expect(observedReplies(store.read())).toEqual([]);
  });
  it('does not attach unknown-parent or other-root replies by text or root alone', () => {
    const { store } = fixture();
    store.update((doc) => {
      doc.comments.push(node('unknown', 'owner', 'missing'), node('wrong', 'owner', 'root', 'other'));
    });
    expect(observedReplies(store.read())).toEqual([]);
  });
  it('keeps multiple replies in time order and associates a followup with its direct customer', () => {
    const { store } = fixture();
    store.update((doc) => {
      doc.comments.push(
        { ...node('a', 'owner', 'root'), createdAt: 2 },
        node('b', 'owner', 'a'),
        node('question', 'customer', 'a'),
        node('answer', 'owner', 'question')
      );
      doc.records[`${work.key}:question`] = 'next';
    });
    expect(observedReplies(store.read()).map(({ recordId, text }) => ({ recordId, text }))).toEqual([
      { recordId: 'record', text: 'b\n\na' },
      { recordId: 'next', text: 'answer' },
    ]);
  });
  it('does not attach cyclic owner-only parents to a customer', () => {
    const { store } = fixture();
    store.update((doc) => {
      doc.comments.push(node('a', 'owner', 'b'), node('b', 'owner', 'a'));
    });
    expect(observedReplies(store.read())).toEqual([]);
  });
  it('keeps an unresolved dispatch uncertain even when a different actual reply exists', () => {
    const { store } = fixture();
    store.update((doc) => {
      doc.comments.push(node('manual', 'owner', 'root'));
      doc.attempts.push({
        id: 'attempt',
        recordId: 'record',
        commentKey: `${work.key}:root`,
        workKey: work.key,
        text: 'uncertain',
        beforeIds: [],
        preparedAt: 1,
        phase: 'uncertain',
      });
    });
    expect(observedReplies(store.read())[0]).toMatchObject({
      state: 'attention',
      result: 'replySendUncertain',
      text: 'manual',
    });
    expect(store.read().attempts[0].phase).toBe('uncertain');
  });
  it('does not reinterpret confirmed Workbench deliveries as manual overrides', () => {
    const { store } = fixture();
    const reply = node('sent', 'owner', 'root');
    store.update((doc) => {
      doc.comments.push(reply);
      doc.attempts.push({
        id: 'attempt',
        recordId: 'record',
        commentKey: `${work.key}:root`,
        workKey: work.key,
        text: reply.content,
        beforeIds: [],
        preparedAt: 1,
        phase: 'sent',
        result: reply,
      });
    });
    expect(observedReplies(store.read())).toEqual([]);
  });
});
describe('Trusted comment link service', () => {
  function serviceFixture() {
    const { directory, store } = fixture();
    const forbidden = vi.fn(async () => {
      throw new Error('forbidden');
    });
    const locate = vi.fn(async () => undefined);
    const release = vi.fn();
    const acquire = vi.fn(async () => ({ accountId: work.accountId, targetId: 'target', command: forbidden, release }));
    const service = createReplyService({
      directory,
      browsers: { acquire },
      table: {
        provision: forbidden,
        inspect: forbidden,
        list: forbidden,
        get: forbidden,
        create: forbidden,
        recover: forbidden,
        consumeApproval: forbidden,
        writeResult: forbidden,
      },
      platform: {
        inspectCurrent: forbidden,
        collect: forbidden,
        prepare: forbidden,
        submit: forbidden,
        reconcile: forbidden,
        discardPrepared: forbidden,
        locate,
      },
      pollMs: 1,
    });
    return { service, store, forbidden, acquire, locate, release };
  }
  it('resolves only the saved account and opens its exact target without writing or preparing', async () => {
    const f = serviceFixture();
    const comment = f.store.read().comments[0];
    const token = commentLinkToken(comment);
    expect(await f.service.action({ action: 'resolve-comment', token })).toMatchObject({
      commentTarget: { accountId: work.accountId, token },
    });
    await f.service.action({ action: 'open-comment', token });
    expect(f.locate).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: work.accountId }),
      work,
      comment,
      expect.any(AbortSignal)
    );
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    f.service.close();
  });
  it('rejects an unknown token before any browser acquisition', async () => {
    const f = serviceFixture();
    await expect(f.service.action({ action: 'open-comment', token: '0'.repeat(64) })).rejects.toThrow(
      'replyCommentLinkInvalid'
    );
    expect(f.acquire).not.toHaveBeenCalled();
    f.service.close();
  });
  it('does not open a second comment while the account operation is running', async () => {
    const f = serviceFixture();
    let finish!: () => void;
    f.locate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const token = commentLinkToken(f.store.read().comments[0]);
    const active = f.service.action({ action: 'open-comment', token });
    await vi.waitFor(() => expect(f.locate).toHaveBeenCalledOnce());
    await expect(f.service.action({ action: 'open-comment', token })).rejects.toThrow('replyBusy');
    finish();
    await active;
    f.service.close();
  });
});
