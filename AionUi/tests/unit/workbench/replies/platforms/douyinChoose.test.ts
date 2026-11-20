import { describe, expect, it } from 'vitest';
import { PAGE_COMMON } from '@/process/services/workbench/replies/platforms/shared';
import { DOUYIN_PAGE } from '@/process/services/workbench/replies/platforms/douyin';
import { browserFixture, DY_CHILD, DY_ROOT } from './fixtures';

async function choose(fixture: ReturnType<typeof browserFixture>) {
  return (await fixture.lease.command('Runtime.evaluate', {
    expression: `(() => { const A = { target: { commentId: '${DY_CHILD}', rootCommentId: '${DY_ROOT}' } }; ${PAGE_COMMON} ${DOUYIN_PAGE} chooseReply(); return true; })()`,
  })) as { result?: { value?: boolean }; exceptionDetails?: { exception?: { description?: string } } };
}

describe('Douyin reply selection', () => {
  it('chooses the exact reply control when the editor has not mounted yet', async () => {
    const fixture = browserFixture('douyin');
    fixture.editor.remove();
    const response = await choose(fixture);
    expect(response.result?.value).toBe(true);
    expect(fixture.replyProps.cid).toBe(DY_CHILD);
  });

  it('does not choose a reply when more than one editor is visible', async () => {
    const fixture = browserFixture('douyin');
    const other = fixture.document.createElement('div');
    other.setAttribute('contenteditable', 'true');
    fixture.editor.parentElement!.append(other);
    const response = await choose(fixture);
    expect(response.exceptionDetails?.exception?.description).toMatch(/REPLY_EDITOR_NOT_UNIQUE/);
    expect(fixture.replyProps.cid).toBe(DY_ROOT);
  });
});
