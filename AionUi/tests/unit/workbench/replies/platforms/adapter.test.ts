import { commentLinkToken, commentLinkUrl } from '@/process/services/workbench/replies/commentLinks';
import { parseWorkbenchCommentLink } from '@/common/utils/urlValidation';
import { describe, expect, it } from 'vitest';
import { createReplyPlatformAdapter } from '@/process/services/workbench/replies/platforms';
import type { ReplyAttempt } from '@/process/services/workbench/replies/contracts';
import { browserFixture, DY_CHILD, DY_ROOT, XHS_CHILD, XHS_ROOT, XHS_WORK } from './fixtures';

function addConflictingCopy(
  f: ReturnType<typeof browserFixture>,
  platform: 'xiaohongshu' | 'douyin',
  row: Record<string, unknown>,
  commentId: string
) {
  if (platform === 'xiaohongshu') {
    const children = f.comments[0].subComments as Array<Record<string, unknown>>;
    children.push({ ...row, userInfo: { userId: 'another-author', nickname: 'Other' } });
    f.comments[0].subCommentCount = String(children.length);
  } else {
    const original = f.document.getElementById(`comment-${commentId}`)!;
    const duplicate = original.cloneNode(true) as HTMLElement;
    f.attachDouyinFiber(duplicate, { commentInfo: { ...row, user: { uid: 'another-author', nickname: 'Other' } } });
    f.container.append(duplicate);
  }
}

for (const platform of ['xiaohongshu', 'douyin'] as const) {
  describe(`${platform} exact comment replies`, () => {
    it('binds only an owned work and retains root and direct parent IDs', async () => {
      const f = browserFixture(platform);
      const result = await createReplyPlatformAdapter().inspectCurrent(f.lease);
      expect(result.work).toMatchObject({ platform, accountId: 'account-1', title: 'Own work' });
      expect(result.collection.comments[1]).toMatchObject({
        commentId: platform === 'xiaohongshu' ? XHS_CHILD : DY_CHILD,
        rootCommentId: platform === 'xiaohongshu' ? XHS_ROOT : DY_ROOT,
        parentCommentId: platform === 'xiaohongshu' ? XHS_ROOT : DY_ROOT,
      });
    });
    it('does not collect a snapshot containing conflicting copies of a comment', async () => {
      const f = browserFixture(platform);
      addConflictingCopy(f, platform, f.comments[1], platform === 'xiaohongshu' ? XHS_CHILD : DY_CHILD);

      await expect(createReplyPlatformAdapter().inspectCurrent(f.lease)).rejects.toThrow(/AMBIGUOUS/);
      expect(f.clicks).toBe(0);
    });
    it.each(['author', 'actorName', 'title', 'time', 'authorId', 'commentKey'] as const)(
      'rejects an invalid platform %s before it can be stored',
      async (field) => {
        const f = browserFixture(platform);
        const user = (platform === 'xiaohongshu' ? f.comments[1].userInfo : f.comments[1].user) as Record<
          string,
          unknown
        >;
        if (field === 'author') user.nickname = 42;
        if (field === 'authorId') user[platform === 'xiaohongshu' ? 'userId' : 'uid'] = 'a'.repeat(4001);
        if (field === 'time') f.comments[1].createTime = Infinity;
        if (field === 'commentKey') f.comments[1][platform === 'xiaohongshu' ? 'id' : 'cid'] = 'a'.repeat(3990);
        if (field === 'actorName') {
          const actor =
            platform === 'xiaohongshu'
              ? (f.state.user as { userInfo: { value: Record<string, unknown> } }).userInfo.value
              : (f.state.app as { user: { info: Record<string, unknown> } }).user.info;
          actor.nickname = 42;
        }
        if (field === 'title') {
          if (platform === 'xiaohongshu') {
            const state = f.state.note as { noteDetailMap: Record<string, { note: Record<string, unknown> }> };
            state.noteDetailMap[XHS_WORK].note.title = 42;
          } else {
            const player = f.document.querySelector('[data-e2e="video-player"]')!;
            const fiber = Reflect.get(player, '__reactFiber$test') as {
              memoizedProps: { awemeInfo: Record<string, unknown> };
            };
            fiber.memoizedProps.awemeInfo.desc = 42;
          }
        }

        await expect(createReplyPlatformAdapter().inspectCurrent(f.lease)).rejects.toThrow();
        expect(f.clicks).toBe(0);
      }
    );
    it('does not collect the same comment with conflicting content across pages', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work } = await adapter.inspectCurrent(f.lease);
      if (platform === 'xiaohongshu') f.comments[0].subCommentHasMore = true;
      const original = f.lease.command;
      let changed = false;
      f.lease.command = async (method, params) => {
        const result = await original(method, params);
        if (!changed && method === 'Runtime.evaluate' && String(params?.expression).includes("=== 'snapshot'")) {
          changed = true;
          f.comments[1][platform === 'xiaohongshu' ? 'content' : 'text'] = 'Conflicting content';
        }
        return result;
      };

      await expect(adapter.collect(f.lease, work, false)).rejects.toThrow(/AMBIGUOUS/);
      expect(f.clicks).toBe(0);
    });
    it('does not reconcile a conflicting owner reply as sent', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const attempt: ReplyAttempt = {
        id: 'attempt',
        recordId: 'rec1',
        commentKey: target.key,
        workKey: work.key,
        text: 'Maybe sent',
        beforeIds: collection.comments.map((row) => row.commentId),
        preparedAt: Date.now(),
        phase: 'uncertain',
      };
      const id = platform === 'xiaohongshu' ? '6af7fc5b000000003103bc31' : '7707904226752185123';
      const reply = f.addComment(id, attempt.text, target.commentId);
      addConflictingCopy(f, platform, reply, id);

      await expect(adapter.reconcile(f.lease, work, target, attempt)).rejects.toThrow(/AMBIGUOUS/);
      expect(f.clicks).toBe(0);
    });
    it('does not confirm a send when the resulting owner reply has conflicting copies', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const prepared = await adapter.prepare(f.lease, work, target, 'Submitted draft');
      f.send.addEventListener('click', () => {
        const id = platform === 'xiaohongshu' ? '6af7fc5b000000003103bc30' : '7707904226752185122';
        addConflictingCopy(f, platform, f.comments.at(-1)!, id);
      });

      await expect(adapter.submit(f.lease, work, target, 'Submitted draft', prepared)).rejects.toThrow(/AMBIGUOUS/);
      expect(f.clicks).toBe(1);
    });
    it('rejects a logged-in actor different from the work owner', async () => {
      const f = browserFixture(platform);
      if (platform === 'xiaohongshu')
        Reflect.set((f.state.user as { userInfo: { value: object } }).userInfo.value, 'userId', 'another-user');
      else Reflect.set((f.state.app as { user: { info: object } }).user.info, 'uid', 'another-user');
      await expect(createReplyPlatformAdapter().inspectCurrent(f.lease)).rejects.toThrow(/identity|owner/i);
      expect(f.clicks).toBe(0);
    });
    it('locates the exact nested node without selecting an editor or changing a user draft', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      f.editor.textContent = 'Unsent human draft';
      let choices = 0;
      f.container.addEventListener('click', () => choices++);
      await adapter.locate!(f.lease, work, target);
      expect(f.document.querySelector('[data-workbench-comment-target]')?.id).toBe(`comment-${target.commentId}`);
      expect([choices, f.clicks, f.insertions]).toEqual([0, 0, 0]);
      expect(f.editor.textContent).toBe('Unsent human draft');
    });
    it('rejects missing or changed targets without falling back to their root', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      await expect(adapter.locate!(f.lease, work, { ...collection.comments[1], content: 'Changed' })).rejects.toThrow(
        /target/i
      );
      expect(f.document.querySelector('[data-workbench-comment-target]')).toBeNull();
      expect([f.clicks, f.insertions]).toEqual([0, 0]);
    });
    it('returns observed owner children before any editor operation and cannot submit that result', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc30' : '7707904226752185122',
        'Manual reply',
        target.commentId
      );
      f.editor.textContent = 'Keep my other draft';
      const prepared = await adapter.prepare(f.lease, work, target, 'Outdated table draft');
      expect(prepared.existingReplies?.map((row) => row.content)).toEqual(['Manual reply']);
      expect([f.insertions, f.clicks, f.editor.textContent]).toEqual([0, 0, 'Keep my other draft']);
      await expect(adapter.submit(f.lease, work, target, 'Outdated table draft', prepared)).rejects.toThrow(
        /prepared/i
      );
    });
    it('does not mistake a reply to the root or another customer for a reply to the nested target', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc30' : '7707904226752185122',
        'Owner response to root',
        target.rootCommentId
      );
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc31' : '7707904226752185123',
        'Another customer',
        target.commentId,
        'other-customer'
      );
      const prepared = await adapter.prepare(f.lease, work, target, 'Exact nested answer');
      expect(prepared.existingReplies).toBeUndefined();
      expect(f.editor.textContent).toBe('Exact nested answer');
    });
    it('keeps a draft when locating a different work would require navigation', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      f.dom.reconfigure({
        url: platform === 'xiaohongshu' ? 'https://www.xiaohongshu.com/explore' : 'https://www.douyin.com/',
      });
      f.editor.textContent = 'Unsent elsewhere';
      await expect(adapter.locate!(f.lease, work, collection.comments[1])).rejects.toThrow(/draft/i);
      expect(f.navigations).toBe(0);
      expect(f.editor.textContent).toBe('Unsent elsewhere');
    });
    it('refuses a comment bound to a different account before any browser operation', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const before = f.commands.length;
      await expect(adapter.locate!(f.lease, work, { ...collection.comments[1], accountId: 'foreign' })).rejects.toThrow(
        /binding/i
      );
      expect(f.commands.length).toBe(before);
    });
    it('sends once to the nested target and reads back the exact parent relationship', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const prepared = await adapter.prepare(f.lease, work, target, 'Second-round response');
      const result = await adapter.submit(f.lease, work, target, 'Second-round response', prepared);
      expect(result).toMatchObject({
        parentCommentId: target.commentId,
        rootCommentId: target.rootCommentId,
        content: 'Second-round response',
        authorId: work.actorId,
      });
      await expect(adapter.submit(f.lease, work, target, 'Second-round response', prepared)).rejects.toThrow(
        /prepared|consumed/i
      );
      expect(f.clicks).toBe(1);
    });
    it('rejects a different selected reply target after preparation', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const prepared = await adapter.prepare(f.lease, work, target, 'Do not send');
      f.document.querySelector<HTMLElement>(`#comment-${collection.comments[0].commentId} .reply`)!.click();
      await expect(adapter.submit(f.lease, work, target, 'Do not send', prepared)).rejects.toThrow(/target/i);
      expect(f.clicks).toBe(0);
    });
    it('preserves an existing user draft and refuses preparation', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      f.editor.textContent = 'My unsent draft';
      await expect(adapter.prepare(f.lease, work, collection.comments[0], 'Replacement')).rejects.toThrow(/draft/i);
      expect(f.editor.textContent).toBe('My unsent draft');
    });
    it('does not refresh a challenge page or submit through the challenge', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work } = await adapter.inspectCurrent(f.lease);
      f.document.body.insertAdjacentHTML('beforeend', '<div role="dialog">请完成短信验证</div>');
      await expect(adapter.collect(f.lease, work, true)).rejects.toThrow(/challenge/i);
      expect(f.navigations).toBe(0);
    });
    it('reconciles a previously sent response without clicking again', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const attempt: ReplyAttempt = {
        id: 'attempt',
        recordId: 'rec1',
        commentKey: target.key,
        workKey: work.key,
        text: 'Already posted',
        beforeIds: collection.comments.map((c) => c.commentId),
        preparedAt: Date.now(),
        phase: 'uncertain',
      };
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc30' : '7707904226752185122',
        'Already posted',
        target.commentId
      );
      expect(await adapter.reconcile(f.lease, work, target, attempt)).toMatchObject({
        content: 'Already posted',
        parentCommentId: target.commentId,
      });
      expect(f.clicks).toBe(0);
      expect(f.insertions).toBe(0);
    });
    it('does not infer success from an older same-text reply outside the initial loaded window', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const old = f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc30' : '7707904226752185122',
        'Old identical reply',
        target.commentId
      );
      if (platform === 'xiaohongshu') old.createTime = Date.now() - 60_000;
      else old.createTime = Math.floor(Date.now() / 1000) - 60;
      const attempt: ReplyAttempt = {
        id: 'attempt',
        recordId: 'rec1',
        commentKey: target.key,
        workKey: work.key,
        text: 'Old identical reply',
        beforeIds: collection.comments.map((c) => c.commentId),
        preparedAt: Date.now(),
        phase: 'uncertain',
      };
      expect(await adapter.reconcile(f.lease, work, target, attempt)).toBeNull();
    });
    it('fails before any command when the lease belongs to another account', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work } = await adapter.inspectCurrent(f.lease);
      const before = f.commands.length;
      await expect(adapter.collect({ ...f.lease, accountId: 'different' }, work, false)).rejects.toThrow(/account/i);
      expect(f.commands.length).toBe(before);
    });
    it('rejects draft replacement after preparation without sending either version', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const prepared = await adapter.prepare(f.lease, work, collection.comments[1], 'Approved text');
      f.editor.textContent = 'New user draft';
      await expect(adapter.submit(f.lease, work, collection.comments[1], 'Approved text', prepared)).rejects.toThrow(
        /draft/i
      );
      expect(f.clicks).toBe(0);
      expect(f.editor.textContent).toBe('New user draft');
    });
    it('preserves a changed human draft when an owner reply appears before the send', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const prepared = await adapter.prepare(f.lease, work, target, 'Original table draft');
      f.editor.textContent = 'Changed human draft';
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc31' : '7707904226752185123',
        'Manual owner reply',
        target.commentId
      );

      const result = await adapter.submit(f.lease, work, target, 'Original table draft', prepared);
      expect(result).toMatchObject({
        kind: 'not-sent-existing-replies',
        replies: [{ authorId: work.actorId, parentCommentId: target.commentId, content: 'Manual owner reply' }],
      });
      expect(f.clicks).toBe(0);
      expect(f.editor.textContent).toBe('Changed human draft');
    });
    it('returns all direct owner replies observed before a send without including another customer', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const prepared = await adapter.prepare(f.lease, work, target, 'Table draft');
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc30' : '7707904226752185122',
        'First manual answer',
        target.commentId
      );
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc31' : '7707904226752185123',
        'Customer follow-up',
        target.commentId,
        'another-customer'
      );
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc32' : '7707904226752185124',
        'Second manual answer',
        target.commentId
      );

      const result = await adapter.submit(f.lease, work, target, 'Table draft', prepared);
      expect(result).toMatchObject({
        kind: 'not-sent-existing-replies',
        replies: [{ content: 'First manual answer' }, { content: 'Second manual answer' }],
      });
      expect(f.clicks).toBe(0);
      expect(f.editor.textContent).toBe('');
    });
    it('returns a verified direct owner reply even if the thread became incomplete', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const prepared = await adapter.prepare(f.lease, work, target, 'Table draft');
      const reply = f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc31' : '7707904226752185123',
        'Observed owner reply',
        target.commentId
      );
      if (platform === 'xiaohongshu') {
        f.comments[0].subCommentCount = '3';
        f.comments[0].subCommentHasMore = true;
      } else {
        f.comments[0].replyTotal = 3;
        f.setDouyinThreadEvidence([f.comments[1], reply], true);
      }

      const result = await adapter.submit(f.lease, work, target, 'Table draft', prepared);
      expect(result).toMatchObject({
        kind: 'not-sent-existing-replies',
        replies: [{ authorId: work.actorId, rootCommentId: target.rootCommentId, parentCommentId: target.commentId }],
      });
      expect(f.clicks).toBe(0);
    });
    it('does not backfill a reply whose duplicate ID has conflicting authors', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const prepared = await adapter.prepare(f.lease, work, target, 'Table draft');
      const reply = f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc31' : '7707904226752185123',
        'Conflicting author',
        target.commentId
      );
      if (platform === 'xiaohongshu') {
        (f.comments[0].subComments as Array<Record<string, unknown>>).push({
          ...reply,
          userInfo: { userId: 'other-author', nickname: 'Other' },
        });
        f.comments[0].subCommentCount = '3';
      } else {
        f.setDouyinThreadEvidence(
          [f.comments[1], { ...reply, user: { uid: 'other-author', nickname: 'Other' } }],
          false
        );
      }

      await expect(adapter.submit(f.lease, work, target, 'Table draft', prepared)).rejects.toThrow();
      expect(f.clicks).toBe(0);
      expect(f.editor.textContent).toBe('Table draft');
    });
    it('does not prepare or backfill an already ambiguous reply snapshot', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const reply = f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc31' : '7707904226752185123',
        'Conflicting author',
        target.commentId
      );
      if (platform === 'xiaohongshu') {
        (f.comments[0].subComments as Array<Record<string, unknown>>).push({
          ...reply,
          userInfo: { userId: 'other-author', nickname: 'Other' },
        });
        f.comments[0].subCommentCount = '3';
      } else {
        f.setDouyinThreadEvidence(
          [f.comments[1], { ...reply, user: { uid: 'other-author', nickname: 'Other' } }],
          false
        );
      }

      await expect(adapter.prepare(f.lease, work, target, 'Table draft')).rejects.toThrow();
      expect(f.clicks).toBe(0);
      expect(f.insertions).toBe(0);
    });
    it('does not interpret a malformed send response as a confirmed result', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const prepared = await adapter.prepare(f.lease, work, target, 'Table draft');
      const original = f.lease.command;
      let intercepted = false;
      f.lease.command = async (method, params) => {
        if (method === 'Runtime.evaluate' && !intercepted) {
          intercepted = true;
          f.addComment(
            platform === 'xiaohongshu' ? '6af7fc5b000000003103bc31' : '7707904226752185123',
            'Table draft',
            target.commentId
          );
          return { result: { type: 'boolean', value: false } };
        }
        return original(method, params);
      };

      await expect(adapter.submit(f.lease, work, target, 'Table draft', prepared)).rejects.toThrow();
      expect(f.clicks).toBe(0);
      expect(f.editor.textContent).toBe('Table draft');
    });
    it('rejects a malformed not-sent result instead of backfilling or clearing the draft', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const prepared = await adapter.prepare(f.lease, work, target, 'Table draft');
      const original = f.lease.command;
      let intercepted = false;
      f.lease.command = async (method, params) => {
        if (method === 'Runtime.evaluate' && !intercepted) {
          intercepted = true;
          f.addComment(
            platform === 'xiaohongshu' ? '6af7fc5b000000003103bc31' : '7707904226752185123',
            'Table draft',
            target.commentId
          );
          return { result: { type: 'object', value: { kind: 'not-sent-existing-replies', snapshot: {} } } };
        }
        return original(method, params);
      };

      await expect(adapter.submit(f.lease, work, target, 'Table draft', prepared)).rejects.toThrow();
      expect(f.clicks).toBe(0);
      expect(f.editor.textContent).toBe('Table draft');
    });
    it('does not move a prepared send to a reopened browser target', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const prepared = await adapter.prepare(f.lease, work, collection.comments[1], 'Approved text');
      await expect(
        adapter.submit({ ...f.lease, targetId: 'webview-99' }, work, collection.comments[1], 'Approved text', prepared)
      ).rejects.toThrow(/prepared/i);
      expect(f.clicks).toBe(0);
    });
    it('quarantines a challenge raised by the first send and never repeats that click', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const prepared = await adapter.prepare(f.lease, work, target, 'Needs verification');
      f.send.addEventListener('click', () =>
        f.document.body.insertAdjacentHTML('beforeend', '<div role="dialog">请完成短信验证</div>')
      );
      await expect(adapter.submit(f.lease, work, target, 'Needs verification', prepared)).rejects.toThrow(/challenge/i);
      await expect(adapter.submit(f.lease, work, target, 'Needs verification', prepared)).rejects.toThrow(/prepared/i);
      expect(f.clicks).toBe(1);
    });
    it('leaves multiple identical new replies unresolved instead of choosing an arbitrary one', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const attempt: ReplyAttempt = {
        id: 'attempt',
        recordId: 'rec1',
        commentKey: target.key,
        workKey: work.key,
        text: 'Same text',
        beforeIds: collection.comments.map((c) => c.commentId),
        preparedAt: Date.now(),
        phase: 'uncertain',
      };
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc30' : '7707904226752185122',
        'Same text',
        target.commentId
      );
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc31' : '7707904226752185123',
        'Same text',
        target.commentId
      );
      await expect(adapter.reconcile(f.lease, work, target, attempt)).rejects.toThrow(/ambiguous/i);
      expect(f.clicks).toBe(0);
    });
    it('cancels before any browser action when the signal is already aborted', async () => {
      const f = browserFixture(platform);
      const signal = AbortSignal.abort();
      await expect(createReplyPlatformAdapter().inspectCurrent(f.lease, signal)).rejects.toThrow(/cancelled/i);
      expect(f.commands).toEqual([]);
    });
    it('discards only the exact draft owned by a completed preparation', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const prepared = await adapter.prepare(f.lease, work, collection.comments[1], 'Cancelled approval');
      await adapter.discardPrepared(f.lease, work, collection.comments[1], 'Cancelled approval');
      expect(f.editor.textContent).toBe('');
      await expect(
        adapter.submit(f.lease, work, collection.comments[1], 'Cancelled approval', prepared)
      ).rejects.toThrow(/prepared/i);
      expect(f.clicks).toBe(0);
    });
    it('does not discard a draft edited by the user after preparation', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      await adapter.prepare(f.lease, work, collection.comments[1], 'Approved draft');
      f.editor.textContent = 'My changed text';
      await expect(adapter.discardPrepared(f.lease, work, collection.comments[1], 'Approved draft')).rejects.toThrow(
        /draft/i
      );
      expect(f.editor.textContent).toBe('My changed text');
    });
    it('removes a known residual platform editor draft after confirmed sending', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const prepared = await adapter.prepare(f.lease, work, collection.comments[1], 'Confirmed response');
      f.send.addEventListener('click', () => {
        f.editor.textContent = 'Confirmed response';
      });
      await adapter.submit(f.lease, work, collection.comments[1], 'Confirmed response', prepared);
      expect(f.editor.textContent).toBe('');
      expect(f.clicks).toBe(1);
    });
    it('reconciles a sent result while leaving an unrelated current draft untouched', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const target = collection.comments[1];
      const attempt: ReplyAttempt = {
        id: 'attempt',
        recordId: 'rec1',
        commentKey: target.key,
        workKey: work.key,
        text: 'Posted',
        beforeIds: collection.comments.map((c) => c.commentId),
        preparedAt: Date.now(),
        phase: 'uncertain',
      };
      f.addComment(
        platform === 'xiaohongshu' ? '6af7fc5b000000003103bc30' : '7707904226752185122',
        'Posted',
        target.commentId
      );
      f.editor.textContent = 'An unrelated draft';
      const result = await adapter.reconcile(f.lease, work, target, attempt);
      expect(result?.content).toBe('Posted');
      expect(f.editor.textContent).toBe('An unrelated draft');
      expect(f.clicks).toBe(0);
    });
    it('cleans its exact inserted draft when preparation is cancelled before verification', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const controller = new AbortController();
      const originalCommand = f.lease.command;
      f.lease.command = async (method, params) => {
        const result = await originalCommand(method, params);
        if (method === 'Input.insertText') controller.abort();
        return result;
      };
      await expect(
        adapter.prepare(f.lease, work, collection.comments[1], 'Cancelled during insertion', controller.signal)
      ).rejects.toThrow(/cancelled/i);
      expect(f.editor.textContent).toBe('');
      expect(f.clicks).toBe(0);
    });
    it('preserves human edits when an interrupted preparation tries to clean its draft', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const originalCommand = f.lease.command;
      f.lease.command = async (method, params) => {
        const result = await originalCommand(method, params);
        if (method === 'Input.insertText') {
          f.editor.textContent = 'Changed manually';
          throw new Error('Browser command interrupted');
        }
        return result;
      };
      await expect(adapter.prepare(f.lease, work, collection.comments[1], 'Original automated draft')).rejects.toThrow(
        /interrupted/i
      );
      expect(f.editor.textContent).toBe('Changed manually');
      expect(f.clicks).toBe(0);
    });
    it('can prepare again after insertion succeeded but its browser command rejected', async () => {
      const f = browserFixture(platform);
      const adapter = createReplyPlatformAdapter();
      const { work, collection } = await adapter.inspectCurrent(f.lease);
      const originalCommand = f.lease.command;
      f.lease.command = async (method, params) => {
        const result = await originalCommand(method, params);
        if (method === 'Input.insertText') throw new Error('Lost command response');
        return result;
      };
      await expect(adapter.prepare(f.lease, work, collection.comments[1], 'Interrupted draft')).rejects.toThrow(
        /lost command response/i
      );
      f.lease.command = originalCommand;
      const prepared = await adapter.prepare(f.lease, work, collection.comments[1], 'New approved draft');
      expect(prepared.beforeIds).toContain(collection.comments[1].commentId);
      expect(f.editor.textContent).toBe('New approved draft');
    });
  });
}

it('retains the signed Xiaohongshu work URL when refreshing', async () => {
  const f = browserFixture('xiaohongshu');
  const adapter = createReplyPlatformAdapter();
  const { work } = await adapter.inspectCurrent(f.lease);
  await adapter.collect(f.lease, work, true);
  expect(f.window.location.search).toBe('?xsec_token=signed-value&xsec_source=pc_user');
});

it('deduplicates hidden Douyin rows without converting long IDs to numbers', async () => {
  const f = browserFixture('douyin');
  const hidden = f.document.querySelector<HTMLElement>(`#comment-${DY_CHILD}`)!.cloneNode(true) as HTMLElement;
  hidden.hidden = true;
  f.attachDouyinFiber(hidden, { commentInfo: f.comments[1] });
  f.container.append(hidden);
  const { collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  expect(collection.comments.map((c) => c.commentId)).toEqual([DY_ROOT, DY_CHILD]);
});

it('marks unexpanded Xiaohongshu replies as partial instead of claiming absence', async () => {
  const f = browserFixture('xiaohongshu');
  f.comments[0].subCommentCount = '20';
  f.comments[0].subCommentHasMore = true;
  const { collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  expect(collection.complete).toBe(false);
});

describe('Xiaohongshu thread safety before a reply', () => {
  it('reveals a hidden target even when the overall collection is already complete', async () => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    expect(collection.complete).toBe(true);
    const target = collection.comments[1];
    const row = f.document.getElementById(`comment-${target.commentId}`)!;
    row.hidden = true;
    let expansions = 0;
    const expand = f.document.createElement('span');
    expand.textContent = '展开更多';
    expand.addEventListener('click', () => {
      expansions++;
      row.hidden = false;
      expand.remove();
    });
    f.container.append(expand);

    await adapter.prepare(f.lease, work, target, 'Approved draft');
    expect(expansions).toBe(1);
    expect(f.editor.textContent).toBe('Approved draft');
    expect(f.clicks).toBe(0);
  });

  it.each([
    ['missing pagination flag', (f: ReturnType<typeof browserFixture>) => delete f.comments[0].subCommentHasMore],
    [
      'reply count below the loaded list',
      (f: ReturnType<typeof browserFixture>) => (f.comments[0].subCommentCount = '0'),
    ],
    [
      'missing ancestor',
      (f: ReturnType<typeof browserFixture>) => (f.comments[1].targetComment = { id: 'missing-parent' }),
    ],
    ['cyclic parent', (f: ReturnType<typeof browserFixture>) => (f.comments[1].targetComment = { id: XHS_CHILD })],
  ] as const)('marks collection partial for %s', async (_label, mutate) => {
    const f = browserFixture('xiaohongshu');
    mutate(f);

    const { collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
    expect(collection.complete).toBe(false);
  });

  it('does not prepare a draft when the target thread has unloaded replies', async () => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    f.comments[0].subCommentCount = '2';
    f.comments[0].subCommentHasMore = true;

    await expect(adapter.prepare(f.lease, work, collection.comments[1], 'Do not duplicate')).rejects.toThrow(
      'replyThreadIncomplete'
    );
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
    expect(f.editor.textContent).toBe('');
  });

  it('returns an observed owner reply even if the rest of the thread is incomplete', async () => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    f.addComment('6af7fc5b000000003103bc31', 'Observed manual reply', target.commentId);
    f.comments[0].subCommentCount = '3';
    f.comments[0].subCommentHasMore = true;
    f.editor.textContent = 'Existing human draft';

    const prepared = await adapter.prepare(f.lease, work, target, 'Old table draft');
    expect(prepared.existingReplies?.map((item) => item.content)).toEqual(['Observed manual reply']);
    expect(f.editor.textContent).toBe('Existing human draft');
    expect(f.navigations).toBe(0);
    expect(f.insertions).toBe(0);
  });

  it('can prepare a complete target thread when another thread is incomplete', async () => {
    const f = browserFixture('xiaohongshu');
    const other = f.addComment('6af7fc5b000000003103bc32', 'Another thread', null, 'other-customer');
    other.subCommentCount = '1';
    other.subCommentHasMore = true;
    const note = f.state.note as {
      noteDetailMap: Record<string, { comments: { list: Array<Record<string, unknown>> } }>;
    };
    note.noteDetailMap[XHS_WORK].comments.list.push(other);
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    expect(collection.complete).toBe(false);

    await adapter.prepare(f.lease, work, collection.comments.find((item) => item.commentId === XHS_CHILD)!, 'Reply');
    expect(f.editor.textContent).toBe('Reply');
    expect(f.clicks).toBe(0);
  });

  it.each([
    ['missing count', (root: Record<string, unknown>) => delete root.subCommentCount],
    ['empty count', (root: Record<string, unknown>) => (root.subCommentCount = '')],
    ['missing pagination state', (root: Record<string, unknown>) => delete root.subCommentHasMore],
    [
      'duplicate child ID',
      (root: Record<string, unknown>) => {
        const children = root.subComments as Array<Record<string, unknown>>;
        children.push(children[0]);
        root.subCommentCount = '2';
      },
    ],
  ] as const)('does not prepare with %s', async (label, mutate) => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    mutate(f.comments[0]);

    await expect(adapter.prepare(f.lease, work, collection.comments[1], 'Do not send')).rejects.toThrow(
      label === 'duplicate child ID' ? 'REPLY_SNAPSHOT_AMBIGUOUS' : 'replyThreadIncomplete'
    );
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('does not prepare a child whose direct parent is missing from the loaded thread', async () => {
    const f = browserFixture('xiaohongshu');
    f.comments[1].targetComment = { id: 'missing-parent' };
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);

    await expect(adapter.prepare(f.lease, work, collection.comments[1], 'Do not send')).rejects.toThrow(
      'replyThreadIncomplete'
    );
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('rechecks a freshly navigated work and returns an existing platform reply without inserting a draft', async () => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    const original = f.lease.command;
    f.lease.command = async (method, params) => {
      const result = await original(method, params);
      if (method === 'Page.navigate')
        f.addComment('6af7fc5b000000003103bc31', 'Already replied from another device', target.commentId);
      return result;
    };

    const prepared = await adapter.prepare(f.lease, work, target, 'Stale table draft');
    expect(prepared.existingReplies?.map((item) => item.content)).toEqual(['Already replied from another device']);
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('does not backfill a comment that changes content between collection pages', async () => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    const original = f.lease.command;
    let navigated = false;
    let snapshots = 0;
    let reply: Record<string, unknown>;
    f.lease.command = async (method, params) => {
      const result = await original(method, params);
      if (method === 'Page.navigate') {
        navigated = true;
        reply = f.addComment('6af7fc5b000000003103bc31', 'First version', target.commentId);
        f.comments[0].subCommentHasMore = true;
      } else if (navigated && method === 'Runtime.evaluate' && String(params?.expression).includes("=== 'snapshot'")) {
        snapshots++;
        if (snapshots === 2) reply.content = 'Conflicting version';
      }
      return result;
    };

    await expect(adapter.prepare(f.lease, work, target, 'Table draft')).rejects.toThrow();
    expect(f.clicks).toBe(0);
    expect(f.insertions).toBe(0);
  });

  it('does not use the old document when navigation does not commit', async () => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const original = f.lease.command;
    f.lease.command = async (method, params) => (method === 'Page.navigate' ? {} : original(method, params));

    await expect(adapter.prepare(f.lease, work, collection.comments[1], 'Do not send')).rejects.toThrow(
      'REPLY_NAVIGATION_INCOMPLETE'
    );
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('can cancel while waiting for a fresh document', async () => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const original = f.lease.command;
    const controller = new AbortController();
    f.lease.command = async (method, params) => {
      if (method === 'Page.navigate') {
        setTimeout(() => controller.abort(), 10);
        return {};
      }
      return original(method, params);
    };

    await expect(
      adapter.prepare(f.lease, work, collection.comments[1], 'Do not send', controller.signal)
    ).rejects.toThrow(/cancelled/i);
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('does not refresh or replace an unrelated human browser draft', async () => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    f.editor.textContent = 'Human draft';

    await expect(adapter.prepare(f.lease, work, collection.comments[1], 'Do not replace')).rejects.toThrow(
      'REPLY_EXISTING_DRAFT'
    );
    expect(f.navigations).toBe(0);
    expect(f.editor.textContent).toBe('Human draft');
  });

  it('returns the platform reply without clicking send when it appears after preparation', async () => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    const prepared = await adapter.prepare(f.lease, work, target, 'Draft from the table');
    f.addComment('6af7fc5b000000003103bc31', 'Manual reply during preparation', target.commentId);

    const result = await adapter.submit(f.lease, work, target, 'Draft from the table', prepared);
    expect(result).toMatchObject({
      kind: 'not-sent-existing-replies',
      replies: [
        {
          commentId: '6af7fc5b000000003103bc31',
          authorId: work.actorId,
          parentCommentId: target.commentId,
          rootCommentId: target.rootCommentId,
          content: 'Manual reply during preparation',
        },
      ],
    });
    expect(f.clicks).toBe(0);
    expect(f.editor.textContent).toBe('');
  });

  it('does not click send if the target thread becomes incomplete after preparation', async () => {
    const f = browserFixture('xiaohongshu');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    const prepared = await adapter.prepare(f.lease, work, target, 'Draft from the table');
    f.comments[0].subCommentCount = '2';
    f.comments[0].subCommentHasMore = true;

    await expect(adapter.submit(f.lease, work, target, 'Draft from the table', prepared)).rejects.toThrow(/thread/i);
    expect(f.clicks).toBe(0);
  });
});

it('does not prepare a Douyin draft when an existing reply is outside the loaded thread', async () => {
  const f = browserFixture('douyin');
  const adapter = createReplyPlatformAdapter();
  const { work, collection } = await adapter.inspectCurrent(f.lease);
  const target = collection.comments[1];
  f.addComment('7707904226752185123', 'Previously replied', target.commentId);
  f.comments[0].replyTotal = 2;
  f.setDouyinThreadEvidence([f.comments[1]], true);
  f.document.getElementById('comment-7707904226752185123')!.remove();

  await expect(adapter.prepare(f.lease, work, target, 'Duplicate')).rejects.toThrow('replyThreadIncomplete');
  expect(f.insertions).toBe(0);
  expect(f.clicks).toBe(0);
});

describe('Douyin target thread completion', () => {
  it('keeps a visible complete target before scrolling can unload its virtual row', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    expect(collection.complete).toBe(false);
    const target = collection.comments[1];
    const row = f.document.getElementById(`comment-${target.commentId}`)!;
    Object.defineProperty(f.container, 'scrollHeight', { value: 2000 });
    Object.defineProperty(f.container, 'clientHeight', { value: 300 });
    f.container.style.overflowY = 'auto';
    let scrolls = 0;
    f.container.addEventListener('scroll', () => {
      scrolls++;
      row.hidden = true;
    });

    await adapter.prepare(f.lease, work, target, 'Approved draft');
    expect(scrolls).toBe(0);
    expect(f.editor.textContent).toBe('Approved draft');
    expect(f.clicks).toBe(0);
  });

  it('continues scrolling when the complete target is loaded but its row is not visible', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    const row = f.document.getElementById(`comment-${target.commentId}`)!;
    row.hidden = true;
    Object.defineProperty(f.container, 'scrollHeight', { value: 2000 });
    Object.defineProperty(f.container, 'clientHeight', { value: 300 });
    f.container.style.overflowY = 'auto';
    let scrolls = 0;
    f.container.addEventListener('scroll', () => {
      scrolls++;
      row.hidden = false;
    });

    await adapter.prepare(f.lease, work, target, 'Approved draft');
    expect(scrolls).toBe(1);
    expect(f.editor.textContent).toBe('Approved draft');
    expect(f.clicks).toBe(0);
  });

  it('does not reconcile when an unrendered loaded copy conflicts with a visible reply', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    const attempt: ReplyAttempt = {
      id: 'attempt',
      recordId: 'rec1',
      commentKey: target.key,
      workKey: work.key,
      text: 'Maybe sent',
      beforeIds: collection.comments.map((row) => row.commentId),
      preparedAt: Date.now(),
      phase: 'uncertain',
    };
    const reply = f.addComment('7707904226752185123', attempt.text, target.commentId);
    f.comments[0].replyTotal = 3;
    f.setDouyinThreadEvidence(
      [f.comments[1], reply, { ...reply, user: { uid: 'another-author', nickname: 'Other' } }],
      false
    );

    await expect(adapter.reconcile(f.lease, work, target, attempt)).rejects.toThrow(/AMBIGUOUS/);
    expect(f.clicks).toBe(0);
  });

  it('does not confirm a send when its unrendered loaded copy has a conflicting author', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    const prepared = await adapter.prepare(f.lease, work, target, 'Submitted draft');
    f.send.addEventListener('click', () => {
      const reply = f.comments.at(-1)!;
      f.comments[0].replyTotal = 3;
      f.setDouyinThreadEvidence(
        [f.comments[1], reply, { ...reply, user: { uid: 'another-author', nickname: 'Other' } }],
        false
      );
    });

    await expect(adapter.submit(f.lease, work, target, 'Submitted draft', prepared)).rejects.toThrow(/AMBIGUOUS/);
    expect(f.clicks).toBe(1);
  });

  it('does not backfill a visible owner reply when the loaded list repeats its ID with another author', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    const prepared = await adapter.prepare(f.lease, work, target, 'Table draft');
    const reply = f.addComment('7707904226752185123', 'Owner reply', target.commentId);
    f.comments[0].replyTotal = 3;
    f.setDouyinThreadEvidence(
      [f.comments[1], reply, { ...reply, user: { uid: 'other-author', nickname: 'Other' } }],
      false
    );

    await expect(adapter.submit(f.lease, work, target, 'Table draft', prepared)).rejects.toThrow();
    expect(f.clicks).toBe(0);
    expect(f.editor.textContent).toBe('Table draft');
  });

  it('prepares when the target reply list and pagination state prove the thread complete', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    expect(collection.complete).toBe(false);

    await adapter.prepare(f.lease, work, collection.comments[1], 'Reply to customer');
    expect(f.editor.textContent).toBe('Reply to customer');
    expect(f.clicks).toBe(0);
  });

  it('returns a loaded owner reply even when its DOM row is not visible', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    f.addComment('7707904226752185123', 'Already replied', target.commentId);
    f.document.getElementById('comment-7707904226752185123')!.remove();

    const prepared = await adapter.prepare(f.lease, work, target, 'Old draft');
    expect(prepared.existingReplies?.map((item) => item.content)).toEqual(['Already replied']);
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('prepares a root with an explicit zero reply total and no reply controls', async () => {
    const f = browserFixture('douyin');
    f.document.getElementById(`comment-${DY_CHILD}`)!.remove();
    f.comments.splice(1, 1);
    f.comments[0].replyTotal = 0;
    f.setDouyinThreadEvidence([], false);
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);

    await adapter.prepare(f.lease, work, collection.comments[0], 'First reply');
    expect(f.editor.textContent).toBe('First reply');
    expect(f.clicks).toBe(0);
  });

  it('does not trust a thread while the reply list is loading', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    f.setDouyinThreadLoading(true);

    await expect(adapter.prepare(f.lease, work, collection.comments[0], 'Do not send')).rejects.toThrow(
      'replyThreadIncomplete'
    );
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('does not trust a zero-total thread while its reply component is loading', async () => {
    const f = browserFixture('douyin');
    f.document.getElementById(`comment-${DY_CHILD}`)!.remove();
    f.comments.splice(1, 1);
    f.comments[0].replyTotal = 0;
    f.setDouyinThreadEvidence([], false);
    f.setDouyinThreadLoading(true);
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);

    await expect(adapter.prepare(f.lease, work, collection.comments[0], 'Do not send')).rejects.toThrow(
      'replyThreadIncomplete'
    );
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('does not trust a thread when its total exceeds its loaded reply list', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    f.comments[0].replyTotal = 2;
    f.setDouyinThreadEvidence([f.comments[1]], false);

    await expect(adapter.prepare(f.lease, work, collection.comments[0], 'Do not send')).rejects.toThrow(
      'replyThreadIncomplete'
    );
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('does not trust duplicate reply IDs in the loaded thread', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    f.comments[0].replyTotal = 2;
    f.setDouyinThreadEvidence([f.comments[1], f.comments[1]], false);

    await expect(adapter.prepare(f.lease, work, collection.comments[0], 'Do not send')).rejects.toThrow(
      'REPLY_SNAPSHOT_AMBIGUOUS'
    );
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it.each(['user', 'text'] as const)('does not trust a loaded reply without %s', async (field) => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    delete f.comments[1][field];

    await expect(adapter.prepare(f.lease, work, collection.comments[0], 'Do not send')).rejects.toThrow(
      'REPLY_SNAPSHOT_AMBIGUOUS'
    );
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('expands the observed more-replies control and returns a newly loaded owner reply', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    f.comments[0].replyTotal = 2;
    f.setDouyinThreadEvidence([f.comments[1]], true);
    const more = f.document.createElement('span');
    more.textContent = '展开更多';
    more.addEventListener('click', () => {
      f.addComment('7707904226752185123', 'Loaded owner reply', target.commentId);
      more.remove();
    });
    f.container.append(more);

    const prepared = await adapter.prepare(f.lease, work, target, 'Stale draft');
    expect(prepared.existingReplies?.map((item) => item.content)).toEqual(['Loaded owner reply']);
    expect(f.insertions).toBe(0);
    expect(f.clicks).toBe(0);
  });

  it('returns the owner reply without clicking send when it appears after preparation', async () => {
    const f = browserFixture('douyin');
    const adapter = createReplyPlatformAdapter();
    const { work, collection } = await adapter.inspectCurrent(f.lease);
    const target = collection.comments[1];
    const prepared = await adapter.prepare(f.lease, work, target, 'Old draft');
    f.addComment('7707904226752185123', 'New owner reply', target.commentId);

    const result = await adapter.submit(f.lease, work, target, 'Old draft', prepared);
    expect(result).toMatchObject({
      kind: 'not-sent-existing-replies',
      replies: [
        {
          commentId: '7707904226752185123',
          authorId: work.actorId,
          parentCommentId: target.commentId,
          rootCommentId: target.rootCommentId,
          content: 'New owner reply',
        },
      ],
    });
    expect(f.clicks).toBe(0);
    expect(f.editor.textContent).toBe('');
  });
});

it('expands a loaded Xiaohongshu thread and preserves the direct parent of a nested follow-up', async () => {
  const f = browserFixture('xiaohongshu');
  f.comments[0].subCommentCount = '2';
  f.comments[0].subCommentHasMore = true;
  const expand = f.document.createElement('span');
  expand.textContent = '展开 1 条回复';
  expand.addEventListener('click', () => {
    f.addComment('6af7fc5b000000003103bc30', 'Nested follow-up', XHS_CHILD);
    f.comments[0].subCommentHasMore = false;
    expand.remove();
  });
  f.container.append(expand);
  const { collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  expect(collection.comments.at(-1)).toMatchObject({
    rootCommentId: XHS_ROOT,
    parentCommentId: XHS_CHILD,
    content: 'Nested follow-up',
  });
  expect(collection.complete).toBe(true);
});

it('bounds a non-progressing expand control and leaves the collection partial', async () => {
  const f = browserFixture('xiaohongshu');
  f.comments[0].subCommentCount = '50';
  f.comments[0].subCommentHasMore = true;
  const expand = f.document.createElement('span');
  expand.textContent = '展开 48 条回复';
  let expansions = 0;
  expand.addEventListener('click', () => {
    expansions++;
  });
  f.container.append(expand);
  const { collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  expect(collection.complete).toBe(false);
  expect(expansions).toBeLessThanOrEqual(3);
});

it('collects a delayed Xiaohongshu reply after the expand control disappears', async () => {
  const f = browserFixture('xiaohongshu');
  f.comments[0].subCommentCount = '2';
  f.comments[0].subCommentHasMore = true;
  const expand = f.document.createElement('span');
  expand.textContent = '展开 1 条回复';
  let delivered: Promise<void> | undefined;
  expand.addEventListener('click', () => {
    expand.remove();
    delivered = new Promise((resolve) => {
      setTimeout(() => {
        f.addComment('6af7fc5b000000003103bc30', 'Delayed nested follow-up', XHS_CHILD);
        resolve();
      }, 550);
    });
  });
  f.container.append(expand);
  const { collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  await delivered;
  expect(collection.comments.at(-1)).toMatchObject({ content: 'Delayed nested follow-up', parentCommentId: XHS_CHILD });
  expect(collection.complete).toBe(false);
});

it('does not guess a Xiaohongshu parent when targetComment is absent', async () => {
  const f = browserFixture('xiaohongshu');
  delete f.comments[1].targetComment;
  await expect(createReplyPlatformAdapter().inspectCurrent(f.lease)).rejects.toThrow('REPLY_SNAPSHOT_AMBIGUOUS');
});

it('refuses to select between two visible copies of the same Douyin target', async () => {
  const f = browserFixture('douyin');
  const adapter = createReplyPlatformAdapter();
  const { work, collection } = await adapter.inspectCurrent(f.lease);
  const duplicate = f.document.querySelector<HTMLElement>(`#comment-${DY_CHILD}`)!.cloneNode(true) as HTMLElement;
  f.attachDouyinFiber(duplicate, { commentInfo: f.comments[1] });
  f.container.append(duplicate);
  await expect(adapter.prepare(f.lease, work, collection.comments[1], 'Not sent')).rejects.toThrow(/unique/i);
  expect(f.clicks).toBe(0);
});

it('rejects a work binding containing a foreign navigation host', async () => {
  const f = browserFixture('xiaohongshu');
  const adapter = createReplyPlatformAdapter();
  const { work } = await adapter.inspectCurrent(f.lease);
  await expect(
    adapter.collect(f.lease, { ...work, url: work.url.replace('www.xiaohongshu.com', 'evil.test') }, true)
  ).rejects.toThrow(/url/i);
  expect(f.navigations).toBe(0);
});

it('opens the unique Douyin comment tab before collecting comments after navigation', async () => {
  const f = browserFixture('douyin');
  f.container.remove();
  const tab = f.document.createElement('span');
  tab.textContent = '评论(2)';
  tab.addEventListener('click', () => {
    f.document.body.append(f.container);
  });
  f.document.body.append(tab);
  const { collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  expect(collection.comments.map((c) => c.commentId)).toEqual([DY_ROOT, DY_CHILD]);
});

it('waits for delayed initial Douyin comments after opening a closed comment tab', async () => {
  const f = browserFixture('douyin');
  const rows = [...f.container.children];
  f.container.replaceChildren();
  f.container.remove();
  const tab = f.document.createElement('span');
  tab.textContent = '评论(2)';
  let delivered: Promise<void> | undefined;
  tab.addEventListener('click', () => {
    f.document.body.append(f.container);
    delivered = new Promise((resolve) => {
      setTimeout(() => {
        f.container.append(...rows);
        resolve();
      }, 550);
    });
  });
  f.document.body.append(tab);
  const { collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  await delivered;
  expect(collection.comments.map((c) => c.commentId)).toEqual([DY_ROOT, DY_CHILD]);
  expect(collection.complete).toBe(false);
});

it('leaves an ambiguous pair of Douyin comment tabs untouched', async () => {
  const f = browserFixture('douyin');
  f.container.remove();
  for (let i = 0; i < 2; i++) {
    const tab = f.document.createElement('span');
    tab.textContent = '评论(2)';
    tab.addEventListener('click', () => {
      f.document.body.append(f.container);
    });
    f.document.body.append(tab);
  }
  const { collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  expect(collection.comments).toEqual([]);
  expect(collection.complete).toBe(false);
});

it('verifies Douyin ownership from the observed editor fiber ancestor path', async () => {
  const f = browserFixture('douyin');
  f.moveDouyinWorkToEditorAncestor();
  const { work } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  expect(work).toMatchObject({ actorId: '1632121715433368', workId: '7630823226675650277' });
});

it('uses the verified string authorInfo uid without converting the numeric authorUserId', async () => {
  const f = browserFixture('douyin');
  const player = f.document.querySelector('[data-e2e="video-player"]')!;
  const fiber = Reflect.get(player, '__reactFiber$test');
  fiber.memoizedProps.awemeInfo = {
    awemeId: '7630823226675650277',
    desc: 'Own work',
    authorInfo: { uid: '1632121715433368', nickname: '快乐我来了啊！' },
    authorUserId: 1632121715433368,
  };
  const { work } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  expect(work.actorId).toBe('1632121715433368');
});

it('does not accept a numeric-only Douyin author identity', async () => {
  const f = browserFixture('douyin');
  const player = f.document.querySelector('[data-e2e="video-player"]')!;
  const fiber = Reflect.get(player, '__reactFiber$test');
  fiber.memoizedProps.awemeInfo = { awemeId: '7630823226675650277', authorUserId: 1632121715433368 };
  await expect(createReplyPlatformAdapter().inspectCurrent(f.lease)).rejects.toThrow(/owner|identity/i);
});

it('reuses the exact selected Douyin reply when its visible control reads replying', async () => {
  const f = browserFixture('douyin');
  const adapter = createReplyPlatformAdapter();
  const { work, collection } = await adapter.inspectCurrent(f.lease);
  const target = collection.comments[1];
  const reply = f.document.querySelector<HTMLElement>(`#comment-${DY_CHILD} .reply`)!;
  reply.click();
  reply.textContent = '回复中';
  f.editor.textContent = '\n';
  const duplicate = f.document.querySelector<HTMLElement>(`#comment-${DY_CHILD}`)!.cloneNode(true) as HTMLElement;
  duplicate.hidden = true;
  duplicate.querySelector('.reply')!.textContent = '回复';
  f.attachDouyinFiber(duplicate, { commentInfo: f.comments[1] });
  f.container.append(duplicate);
  await adapter.prepare(f.lease, work, target, 'Continue selected conversation');
  expect(f.replyProps.cid).toBe(DY_CHILD);
  expect(f.editor.textContent?.trim()).toBe('Continue selected conversation');
});

it('waits for the exact Douyin reply editor to mount after choosing its target', async () => {
  const f = browserFixture('douyin');
  const adapter = createReplyPlatformAdapter();
  const { work, collection } = await adapter.inspectCurrent(f.lease);
  const target = collection.comments[1];
  const input = f.editor.parentElement!;
  f.editor.remove();
  const reply = f.document.querySelector<HTMLElement>(`#comment-${DY_CHILD} .reply`)!;
  let mounted: Promise<void> | undefined;
  reply.addEventListener('click', () => {
    reply.textContent = '回复中';
    mounted = new Promise((resolve) => {
      setTimeout(() => {
        input.prepend(f.editor);
        resolve();
      }, 450);
    });
  });
  const preparation = adapter.prepare(f.lease, work, target, 'After editor mount');
  await expect(preparation).resolves.toMatchObject({ beforeIds: [DY_ROOT, DY_CHILD] });
  await mounted;
  expect(f.editor.textContent).toBe('After editor mount');
});

it('recognizes the visible Douyin reply label when innerText is empty but textContent is present', async () => {
  const f = browserFixture('douyin');
  const adapter = createReplyPlatformAdapter();
  const { work, collection } = await adapter.inspectCurrent(f.lease);
  const target = collection.comments[1];
  const row = f.document.querySelector<HTMLElement>(`#comment-${DY_CHILD}`)!;
  const reply = row.querySelector<HTMLElement>('.reply')!;
  Object.defineProperty(row, 'innerText', { get: () => '', configurable: true });
  Object.defineProperty(reply, 'innerText', { get: () => '', configurable: true });
  await adapter.prepare(f.lease, work, target, 'Reply through visible label');
  expect(f.replyProps.cid).toBe(DY_CHILD);
  expect(f.editor.textContent).toBe('Reply through visible label');
});

it('does not use label fallback to relax exact Douyin draft verification', async () => {
  const f = browserFixture('douyin');
  const adapter = createReplyPlatformAdapter();
  const { work, collection } = await adapter.inspectCurrent(f.lease);
  const target = collection.comments[1];
  const prepared = await adapter.prepare(f.lease, work, target, 'Exact approved text');
  Object.defineProperty(f.editor, 'innerText', { get: () => '', configurable: true });
  await expect(adapter.submit(f.lease, work, target, 'Exact approved text', prepared)).rejects.toThrow(/draft/i);
  expect(f.clicks).toBe(0);
});

it('detects the Douyin SMS challenge from its specific visible texts without dialog attributes', async () => {
  const f = browserFixture('douyin');
  const adapter = createReplyPlatformAdapter();
  const { work } = await adapter.inspectCurrent(f.lease);
  f.document.body.insertAdjacentHTML(
    'beforeend',
    '<section><h3>接收短信验证码</h3><p>为确保是本人操作抖音账号，请输入当前手机号收到的短信验证码</p><button>获取验证码</button><button>验证</button></section>'
  );
  await expect(adapter.collect(f.lease, work, true)).rejects.toThrow(/challenge/i);
  expect(f.navigations).toBe(0);
  expect(f.clicks).toBe(0);
});

it('does not treat a hidden Douyin verification dialog or isolated comment text as an active challenge', async () => {
  const f = browserFixture('douyin');
  f.document.body.insertAdjacentHTML(
    'beforeend',
    '<section hidden><h3>接收短信验证码</h3><p>为确保是本人操作抖音账号，请输入当前手机号收到的短信验证码</p><button>获取验证码</button><button>验证</button></section><p>接收短信验证码</p>'
  );
  const { work } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  expect(work.platform).toBe('douyin');
});

it('preserves a human draft when its innerText is empty but textContent is nonempty', async () => {
  const f = browserFixture('douyin');
  const adapter = createReplyPlatformAdapter();
  const { work, collection } = await adapter.inspectCurrent(f.lease);
  f.editor.textContent = 'Existing human draft';
  Object.defineProperty(f.editor, 'innerText', { get: () => '', configurable: true });
  await expect(adapter.prepare(f.lease, work, collection.comments[1], 'Automated reply')).rejects.toThrow(
    'REPLY_EXISTING_DRAFT'
  );
  expect(f.insertions).toBe(0);
  expect(f.editor.textContent).toBe('Existing human draft');
});

it('locates a Douyin virtual row before the next scroll unloads it', async () => {
  const f = browserFixture('douyin');
  const adapter = createReplyPlatformAdapter();
  const { work, collection } = await adapter.inspectCurrent(f.lease);
  const target = collection.comments[1];
  const row = f.document.getElementById(`comment-${target.commentId}`)!;
  row.hidden = true;
  Object.defineProperty(f.container, 'scrollHeight', { value: 2000 });
  Object.defineProperty(f.container, 'clientHeight', { value: 300 });
  f.container.style.overflowY = 'auto';
  let scrolls = 0;
  f.container.addEventListener('scroll', () => {
    scrolls++;
    row.hidden = scrolls !== 1;
  });
  await adapter.locate!(f.lease, work, target);
  expect(scrolls).toBe(1);
  expect(row.getAttribute('data-workbench-comment-target')).toBe(target.commentId);
});

it('creates a stable account-bound opaque link while preserving signed work parameters', async () => {
  const f = browserFixture('xiaohongshu');
  const { work, collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  const target = collection.comments[1];
  const url = commentLinkUrl(work, target);
  expect(parseWorkbenchCommentLink(url)).toBe(commentLinkToken(target));
  expect(new URL(url).search).toBe(new URL(work.url).search);
  expect(commentLinkToken({ ...target, key: `other:${target.key}` })).not.toBe(commentLinkToken(target));
});
it('rejects links whose work and comment bindings disagree', async () => {
  const f = browserFixture('xiaohongshu');
  const { work, collection } = await createReplyPlatformAdapter().inspectCurrent(f.lease);
  expect(() => commentLinkUrl(work, { ...collection.comments[1], accountId: 'foreign' })).toThrow(/binding/i);
  expect(() =>
    commentLinkUrl({ ...work, url: 'https://www.xiaohongshu.com/user/' + work.workId }, collection.comments[1])
  ).toThrow(/url/i);
});
