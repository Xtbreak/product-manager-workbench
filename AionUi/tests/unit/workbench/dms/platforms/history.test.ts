import { describe, expect, it } from 'vitest';
import { readDmHistory } from '@/process/services/workbench/dms/platforms';
import type { DmThread } from '@/common/types/platform/workbenchDm';
import { actor, peer, dyActor, dyPeer, douyinGuest, xhsGuest, xhsInbox, dyInbox } from './guest';

function contact(platform: 'xiaohongshu' | 'douyin'): DmThread {
  const actorId = platform === 'douyin' ? dyActor : actor;
  const contactPlatformId = platform === 'douyin' ? dyPeer : peer;
  return {
    platform,
    actorId,
    contactPlatformId,
    accountId: 'fixture',
    key: [platform, 'fixture', actorId, contactPlatformId].join(':'),
  } as DmThread;
}
const sig = () => new AbortController().signal;

describe('an account partition used on both platforms', () => {
  it.each(['https://creator.douyin.com/home', 'https://www.douyin.com/user/self'])(
    'reads the requested XHS inbox, then restores %s',
    async (start) => {
      const browser = xhsGuest({ start });
      browser.document.getElementById('feed')!.scrollTop = 95;
      const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'all');
      expect(result.complete).toBe(true);
      expect(browser.navigation).toEqual([xhsInbox, xhsInbox + '/' + peer, start]);
      expect(browser.document.getElementById('feed')!.scrollTop).toBe(95);
    }
  );
  it.each(['https://creator.xiaohongshu.com/home', 'https://www.xiaohongshu.com/explore'])(
    'reads the requested creator inbox, then restores %s',
    async (start) => {
      const browser = douyinGuest({ start });
      browser.document.getElementById('before')!.scrollTop = 63;
      const result = await readDmHistory(browser.lease, contact('douyin'), sig(), 'all');
      expect(result.messages).toHaveLength(18);
      expect(browser.navigation).toEqual([dyInbox, start]);
      expect(browser.document.getElementById('before')!.scrollTop).toBe(63);
    }
  );
  it('refuses arbitrary or lookalike origins before inspecting their drafts', async () => {
    const start = 'https://www.douyin.com.invalid/studio';
    const browser = xhsGuest({ start });
    const draft = browser.document.createElement('textarea');
    draft.value = 'unrelated';
    browser.document.body.appendChild(draft);
    await expect(readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact')).rejects.toThrow(
      'dmPageUnverified'
    );
    expect(browser.navigation).toEqual([]);
  });
  it('restores the other platform after a mismatching destination identity', async () => {
    const start = 'https://creator.douyin.com/home';
    const browser = xhsGuest({ start, actorId: 'wrong-actor' });
    await expect(readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact')).rejects.toThrow(
      'dmAccountMismatch'
    );
    expect(browser.navigation).toEqual([xhsInbox, start]);
  });
});

describe('Xiaohongshu DM history on the leased guest', () => {
  it.each([1710000000, 1e11 - 1])('rejects a non-millisecond createTime (%s) and restores the work', async (time) => {
    const start = 'https://www.xiaohongshu.com/explore/example';
    const browser = xhsGuest({ start });
    browser.messages[34].createTime = time;
    await expect(readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact')).rejects.toThrow(
      'dmPageUnverified'
    );
    expect(browser.dom.window.location.href).toBe(start);
  });
  it('accepts the inclusive millisecond lower bound', async () => {
    const browser = xhsGuest();
    browser.messages[34].createTime = 1e11;
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
    expect(result.messages.find((m) => m.id === 'message-34')?.timestamp).toBe(1e11);
  });
  it('retains consecutive same-side messages and reads past the first 30 until the platform proves the end', async () => {
    const start = 'https://www.xiaohongshu.com/explore?tab=following';
    const browser = xhsGuest({ start });
    browser.document.getElementById('feed')!.scrollTop = 77;
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
    expect(result.complete).toBe(true);
    expect(result.messages).toHaveLength(35);
    expect(result.messages.slice(0, 3).map((m) => m.sender)).toEqual(['peer', 'me', 'me']);
    expect(browser.dom.window.location.href).toBe(start);
    expect(browser.document.getElementById('feed')!.scrollTop).toBe(77);
  });
  it('uses a verified existing direct chat URL when the matching XHS row is virtualized out', async () => {
    const browser = xhsGuest({ offscreen: true });
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
    expect(result.complete).toBe(true);
    expect(browser.navigation).toContain(xhsInbox + '/' + peer);
    expect(browser.dom.window.location.href).toBe(xhsInbox);
  });
  it('returns to the previously selected same-URL chat after reading a different verified contact', async () => {
    const previous = '333333333333333333333333';
    const browser = xhsGuest({ defaultPeer: previous });
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
    expect(result.complete).toBe(true);
    expect(browser.document.querySelector<HTMLElement>('.xhs-im-conv-item--active')?.dataset.convId).toBe(previous);
  });
  it('does not treat a detached older fragment as proof that there is no gap in the middle', async () => {
    const browser = xhsGuest({ disjoint: true });
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
    expect(result.complete).toBe(false);
    expect(result.messages).toHaveLength(32);
  });
  it('redacts stale text when a mounted system bubble identifies a recalled message', async () => {
    const browser = xhsGuest({ recalledText: true });
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
    expect(result.messages.at(-1)).toMatchObject({ kind: 'recalled', text: '' });
  });
  it.each([null, 'unrelated-list-value'])(
    'uses the verified detail when the list peerUserId is %s',
    async (listPeer) => {
      const browser = xhsGuest({ listPeer });
      const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
      expect(result.complete).toBe(true);
      expect(result.messages.at(-1)?.sender).toBe('me');
    }
  );
  it.each(['text', 'image'] as const)(
    'rejects conflicting known %s for a repeated stable ID across pages',
    async (changedMessage) => {
      const browser = xhsGuest({ changedMessage });
      await expect(readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact')).rejects.toThrow(
        'dmIdentityMismatch'
      );
    }
  );
  it('keeps known content when a paged duplicate loses its type', async () => {
    const browser = xhsGuest({ changedMessage: 'unknown' });
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
    expect(result.messages.at(-1)).toMatchObject({ kind: 'text', text: 'message 34' });
  });
  it('does not open a listed unread conversation in all mode', async () => {
    const browser = xhsGuest({ unread: 2 });
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'all');
    expect(result).toMatchObject({ complete: false, messages: [], reason: 'dmUnreadSkipped' });
    expect(browser.selected).toHaveLength(0);
  });
  it('keeps exhausted reads partial when hasMoreHistory stays true', async () => {
    const browser = xhsGuest({ stall: true });
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'all');
    expect(result).toMatchObject({ complete: false, reason: 'dmHistoryPartial' });
    expect(result.messages).toHaveLength(30);
  });
  it('does not create a conversation for a comment author missing from the inbox', async () => {
    const browser = xhsGuest({ noContact: true });
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
    expect(result).toMatchObject({ complete: false, messages: [], reason: 'dmContactNotFound' });
    expect(browser.selected).toHaveLength(0);
  });
  it('closes only the overlay it opened if a desktop layout keeps the inbox URL', async () => {
    const browser = xhsGuest({ overlay: true });
    const result = await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
    expect(result.complete).toBe(true);
    expect(browser.document.querySelector('.xhs-im-chat-window')).toBeNull();
  });
  it('restores an initial zero offset after pagination repositioned the original open chat', async () => {
    const browser = xhsGuest({ start: xhsInbox + '/' + peer });
    await readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact');
    expect(browser.document.querySelector('.xhs-im-msg-list')?.scrollTop).toBe(0);
    expect(browser.document.querySelector('.xhs-im-chat-window')).not.toBeNull();
  });
  it('restores the original page on cancellation during an open', async () => {
    const controller = new AbortController();
    const start = 'https://www.xiaohongshu.com/explore';
    const browser = xhsGuest({ start, abortOnOpen: () => controller.abort() });
    await expect(readDmHistory(browser.lease, contact('xiaohongshu'), controller.signal, 'contact')).rejects.toThrow(
      'dmCancelled'
    );
    expect(browser.dom.window.location.href).toBe(start);
  });
  it('does not navigate away from an unsent draft', async () => {
    const browser = xhsGuest({ start: 'https://www.xiaohongshu.com/explore' });
    const draft = browser.document.createElement('textarea');
    draft.value = 'unsent';
    browser.document.body.appendChild(draft);
    await expect(readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'all')).rejects.toThrow('dmExistingDraft');
    expect(browser.navigation).toEqual([]);
  });
  it('keeps unsigned empty inboxes separate from verified missing contacts', async () => {
    const browser = xhsGuest({ noContact: true, actorId: '' });
    await expect(readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'all')).rejects.toThrow('dmLoginRequired');
  });
  it.each([{ detailPeer: actor }, { sender: 'unknown' }, { actorId: 'other' }])(
    'rejects conflicting account, detail or sender identity (%o)',
    async (options) => {
      const browser = xhsGuest(options);
      await expect(readDmHistory(browser.lease, contact('xiaohongshu'), sig(), 'contact')).rejects.toThrow(
        'actorId' in options ? /dmAccountMismatch/ : /dmIdentityMismatch/
      );
    }
  );
});
describe('Douyin DM history on the leased guest', () => {
  it('reads the proven existing conversation cache by numeric UID without opening an unread row or treating virtualization as complete', async () => {
    const browser = douyinGuest();
    const result = await readDmHistory(browser.lease, contact('douyin'), sig(), 'all');
    expect(result).toMatchObject({ complete: false, reason: 'dmHistoryPartial' });
    expect(result.messages).toHaveLength(18);
    expect(result.messages.at(-1)?.sender).toBe('peer');
    expect(browser.clicks()).toBe(0);
  });
  it('scans the virtualized conversation list for an offscreen UID and restores its initial scroll', async () => {
    const browser = douyinGuest({ offscreen: true });
    const result = await readDmHistory(browser.lease, contact('douyin'), sig(), 'all');
    expect(result.messages).toHaveLength(18);
    expect(browser.document.querySelector('.conversationConversationListwrapper')!.scrollTop).toBe(0);
    expect(browser.clicks()).toBe(0);
  });
  it('waits for the verified creator inbox to render instead of reporting a contact absent during loading', async () => {
    const browser = douyinGuest({ emptyWhileLoading: true });
    const result = await readDmHistory(browser.lease, contact('douyin'), sig(), 'all');
    expect(result.messages).toHaveLength(18);
  });
  it('keeps the secUid separate from comment UID', async () => {
    const browser = douyinGuest({ peerId: '5550000000001' });
    const result = await readDmHistory(browser.lease, contact('douyin'), sig(), 'contact');
    expect(result).toMatchObject({ complete: false, messages: [], reason: 'dmContactNotFound' });
  });
  it('does not persist recalled text, and preserves long server IDs as exact strings', async () => {
    const browser = douyinGuest({ recalled: true });
    const { messages } = await readDmHistory(browser.lease, contact('douyin'), sig(), 'contact');
    expect(messages[0]).toEqual({
      id: '800000000000000001',
      sender: 'me',
      timestamp: 1710000000000,
      kind: 'recalled',
      text: '',
    });
  });
  it.each([{ collision: true }, { unsafeId: true }])(
    'rejects colliding or unrepresentable message identifiers (%o)',
    async (options) => {
      const browser = douyinGuest(options);
      await expect(readDmHistory(browser.lease, contact('douyin'), sig(), 'contact')).rejects.toThrow(
        /dmIdentityMismatch|dmPageUnverified/
      );
    }
  );
  it.each([{ actorId: '33333' }, { sender: '33333' }, { foreignConv: true }])(
    'rejects cross-conversation identity (%o)',
    async (options) => {
      const browser = douyinGuest(options);
      await expect(readDmHistory(browser.lease, contact('douyin'), sig(), 'contact')).rejects.toThrow(
        'actorId' in options ? /dmAccountMismatch/ : /dmIdentityMismatch/
      );
    }
  );
});
