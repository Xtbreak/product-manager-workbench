import { describe, expect, it } from 'vitest';
import { PAGE_COMMON, type PageSnapshot } from '@/process/services/workbench/replies/platforms/shared';
import { DOUYIN_PAGE } from '@/process/services/workbench/replies/platforms/douyin';
import { XIAOHONGSHU_PAGE } from '@/process/services/workbench/replies/platforms/xiaohongshu';
import { browserFixture, DY_CHILD, DY_ROOT, XHS_CHILD, XHS_ROOT, XHS_WORK } from './fixtures';

async function snapshot(fixture: ReturnType<typeof browserFixture>, platform: 'xiaohongshu' | 'douyin') {
  const root = platform === 'xiaohongshu' ? XHS_ROOT : DY_ROOT;
  const source = platform === 'xiaohongshu' ? XIAOHONGSHU_PAGE : DOUYIN_PAGE;
  const response = (await fixture.lease.command('Runtime.evaluate', {
    expression: `(() => { const A = { target: { rootCommentId: '${root}' } }; ${PAGE_COMMON} ${source} return readPage(); })()`,
  })) as { result?: { value: PageSnapshot }; exceptionDetails?: unknown };
  if (!response.result) throw new Error(`Snapshot failed: ${JSON.stringify(response.exceptionDetails)}`);
  return response.result.value;
}

describe('ambiguous comment snapshots', () => {
  it.each(['xiaohongshu', 'douyin'] as const)('marks a consistent %s snapshot unambiguous', async (platform) => {
    expect((await snapshot(browserFixture(platform), platform)).ambiguous).toBe(false);
  });

  it('marks duplicate Xiaohongshu IDs even when one copy has invalid identity', async () => {
    const f = browserFixture('xiaohongshu');
    const children = f.comments[0].subComments as Array<Record<string, unknown>>;
    children.push({ id: XHS_CHILD, content: 'Duplicate with missing author', targetComment: { id: XHS_ROOT } });
    const page = await snapshot(f, 'xiaohongshu');
    expect(page.ambiguous).toBe(true);
    expect(page.completeThreads).toEqual([]);
  });

  it('rejects a visible Douyin comment whose current fiber cannot be proven', async () => {
    const f = browserFixture('douyin');
    const row = f.document.createElement('div');
    row.setAttribute('data-e2e', 'comment-item');
    f.container.append(row);
    await expect(snapshot(f, 'douyin')).rejects.toThrow(/REPLY_FIBER_UNVERIFIED/);
  });

  it.each(['invalid', 'missing'] as const)('does not choose a Douyin reply with %s editor fiber', async (problem) => {
    const f = browserFixture('douyin');
    if (problem === 'invalid')
      Object.defineProperty(f.editor, '__reactFiber$test', {
        value: { memoizedProps: f.replyProps },
        configurable: true,
      });
    else Reflect.deleteProperty(f.editor, '__reactFiber$test');
    const response = (await f.lease.command('Runtime.evaluate', {
      expression: `(() => { const A = { target: { commentId: '${DY_CHILD}', rootCommentId: '${DY_ROOT}' } }; ${PAGE_COMMON} ${DOUYIN_PAGE} chooseReply(); return true; })()`,
    })) as { exceptionDetails?: { exception?: { description?: string } } };
    expect(response.exceptionDetails?.exception?.description).toMatch(/REPLY_FIBER_UNVERIFIED/);
    expect(f.replyProps.cid).toBe(DY_ROOT);
  });

  it('marks a visible Douyin comment with unparseable identity ambiguous', async () => {
    const f = browserFixture('douyin');
    const row = f.document.createElement('div');
    row.setAttribute('data-e2e', 'comment-item');
    f.attachDouyinFiber(row, { commentInfo: { cid: 12345, text: 'Unknown' } });
    f.container.append(row);
    expect((await snapshot(f, 'douyin')).ambiguous).toBe(true);
  });

  it('marks a Xiaohongshu comment with unparseable identity ambiguous', async () => {
    const f = browserFixture('xiaohongshu');
    const children = f.comments[0].subComments as Array<Record<string, unknown>>;
    children.push({ id: '6af7fc5b000000003103bc30', content: 'Unknown', targetComment: { id: XHS_ROOT } });
    expect((await snapshot(f, 'xiaohongshu')).ambiguous).toBe(true);
  });

  it('marks a Xiaohongshu snapshot ambiguous when more than 500 raw comments are present', async () => {
    const f = browserFixture('xiaohongshu');
    const children = f.comments[0].subComments as Array<Record<string, unknown>>;
    for (let index = 0; index < 498; index++) {
      children.push({
        id: `a${index.toString(16).padStart(23, '0')}`,
        userInfo: { userId: 'other', nickname: 'Other' },
        content: 'Comment',
        targetComment: { id: XHS_ROOT },
      });
    }
    const note = f.state.note as {
      noteDetailMap: Record<string, { comments: { list: Array<Record<string, unknown>> } }>;
    };
    note.noteDetailMap[XHS_WORK].comments.list.push({ id: 'b00000000000000000000001', subComments: [] });
    expect((await snapshot(f, 'xiaohongshu')).ambiguous).toBe(true);
  });

  it.each(['invalid', 'other root', 'root as child', 'duplicate'] as const)(
    'marks invalid Douyin loaded replies ambiguous: %s',
    async (problem) => {
      const f = browserFixture('douyin');
      const original = f.comments[1];
      const invalid: Record<string, unknown> = { ...original };
      if (problem === 'invalid') delete invalid.user;
      if (problem === 'other root') invalid.replyId = '7707903681722893095';
      if (problem === 'root as child') invalid.cid = DY_ROOT;
      if (problem === 'duplicate') invalid.user = { uid: 'other-user', nickname: 'Other' };
      f.setDouyinThreadEvidence([original, invalid], true);
      const page = await snapshot(f, 'douyin');
      expect(page.ambiguous).toBe(true);
      expect(page.completeThreads).toEqual([]);
    }
  );

  it.each(['author', 'parent', 'content', 'time', 'invalid'] as const)(
    'marks conflicting Douyin copies of one ID ambiguous when %s changes',
    async (field) => {
      const f = browserFixture('douyin');
      const original = f.comments[1];
      const duplicate: Record<string, unknown> = { ...original, user: { ...(original.user as object) } };
      if (field === 'author') duplicate.user = { uid: 'other-user', nickname: 'Other' };
      if (field === 'parent') duplicate.replyToUserId = 'other-parent';
      if (field === 'content') duplicate.text = 'Different content';
      if (field === 'time') duplicate.createTime = Number(original.createTime) + 1;
      if (field === 'invalid') delete duplicate.user;
      const row = f.document.createElement('div');
      row.setAttribute('data-e2e', 'comment-item');
      f.attachDouyinFiber(row, { commentInfo: duplicate });
      f.container.append(row);
      const page = await snapshot(f, 'douyin');
      expect(page.ambiguous).toBe(true);
      expect(page.comments.filter((comment) => comment.id === DY_CHILD)).toHaveLength(1);
      expect(page.completeThreads).toEqual([]);
    }
  );
});
