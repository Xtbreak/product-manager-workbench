import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DmStore } from '@/process/services/workbench/dms/store';
import { dmLinkToken } from '@/process/services/workbench/replies/commentLinks';
import { createDmService } from '@/process/services/workbench/dms/service';
import type { ReplyDocument } from '@/process/services/workbench/replies/store';
import type { DmMessage } from '@/common/types/platform/workbenchDm';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wb-dm-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const work = {
  key: 'douyin:a:me:w',
  platform: 'douyin',
  accountId: 'a',
  actorId: 'me',
  workId: 'w',
  title: 'Work',
  url: 'https://www.douyin.com/video/w',
  actorName: 'Me',
} as const;
const comment = {
  platform: 'douyin',
  accountId: 'a',
  actorId: 'me',
  workId: 'w',
  workKey: work.key,
  commentId: 'c',
  rootCommentId: 'c',
  parentCommentId: null,
  authorId: 'peer',
  author: 'Alex',
  key: work.key + ':c',
  content: 'Question',
  createdAt: 1,
} as const;
const secondWork = { ...work, key: 'douyin:a:me:w2', workId: 'w2' };
const replies = {
  works: [work, secondWork],
  comments: [
    comment,
    { ...comment, key: secondWork.key + ':c', workKey: secondWork.key, workId: 'w2' },
    { ...comment, authorId: 'me', key: work.key + ':self', commentId: 'self' },
    { ...comment, authorId: 'another', key: work.key + ':cc', commentId: 'cc' },
  ],
  records: {},
  sourceSnapshots: {},
} as unknown as ReplyDocument;
const message = (id: string, timestamp: number, sender: 'me' | 'peer' = 'peer'): DmMessage => ({
  id,
  sender,
  timestamp,
  kind: 'text',
  text: 'Hello',
});
const key = 'douyin:a:me:peer';
function fixture(source: ReplyDocument = replies) {
  const release = vi.fn(),
    acquire = vi.fn(async (accountId: string) => ({ accountId, release, targetId: 't', command: vi.fn() }));
  const readHistory = vi.fn(async () => ({
    messages: [message('past', 90), message('1', 101), message('2', 102)],
    complete: true,
    reason: undefined as string | undefined,
  }));
  const syncLinks = vi.fn(async () => 0),
    configureLinks = vi.fn();
  const store = new DmStore(dir, () => 100);
  const service = createDmService({
    store,
    readReplies: () => source,
    browsers: { acquire },
    readHistory,
    syncLinks,
    configureLinks,
    now: () => 150,
  });
  return { service, readHistory, store, acquire, release, syncLinks, configureLinks };
}
it('projects local non-self authors across works without opening a platform or contacting Feishu', async () => {
  const f = fixture();
  const result = await f.service.action({ action: 'thread', key });
  expect(result.threads).toHaveLength(2);
  expect(result.detail?.thread.commentKeys).toHaveLength(2);
  expect(result.detail?.messages).toEqual([]);
  expect(result.detail?.comments).toHaveLength(2);
  expect(f.acquire).not.toHaveBeenCalled();
  expect(f.syncLinks).not.toHaveBeenCalled();
});
it('commits complete history atomically, deduplicates, excludes pre-enablement messages, and preserves a proven watermark for partial history', async () => {
  const f = fixture();
  await f.service.action({ action: 'sync-contact', key });
  f.readHistory.mockResolvedValue({
    messages: [message('2', 102), message('3', 103, 'me')],
    complete: false,
    reason: 'dmPartialHistory',
  });
  const r = await f.service.action({ action: 'sync-contact', key });
  expect(r.detail?.messages.map((m) => m.id)).toEqual(['1', '2', '3']);
  expect(r.detail?.thread).toMatchObject({ lastSender: 'me', watermark: 102, syncState: 'partial' });
  expect(new DmStore(dir).read()).toEqual(f.store.read());
  expect(f.release).toHaveBeenCalledTimes(2);
  expect(f.syncLinks).not.toHaveBeenCalled();
});
it('does not accept a conflicting sender or advance its saved watermark on error', async () => {
  const f = fixture();
  await f.service.action({ action: 'sync-contact', key });
  f.readHistory.mockResolvedValue({ messages: [message('2', 102, 'me')], complete: true, reason: undefined });
  await f.service.action({ action: 'sync-contact', key }).catch(() => undefined);
  const r = await f.service.action({ action: 'thread', key });
  expect(r.detail?.messages.find((m) => m.id === '2')?.sender).toBe('peer');
  expect(r.detail?.thread).toMatchObject({ watermark: 102, syncState: 'error' });
});
it('rejects a damaged local database without modifying its bytes', () => {
  writeFileSync(path.join(dir, 'direct-messages.json'), '{"version":1}');
  expect(() => new DmStore(dir)).toThrow('dmStoreInvalid');
  expect(readFileSync(path.join(dir, 'direct-messages.json'), 'utf8')).toBe('{"version":1}');
});

it('resolves opaque links to empty conversations without a platform read', async () => {
  const f = fixture();
  const { threads } = await f.service.action({ action: 'list' });
  const thread = threads.find((t) => t.key === key)!;
  const r = await f.service.action({ action: 'resolve-dm-link', token: dmLinkToken(thread) });
  expect(r.resolvedKey).toBe(key);
  expect(r.detail?.messages).toHaveLength(0);
  await expect(f.service.action({ action: 'resolve-dm-link', token: 'a'.repeat(64) })).rejects.toThrow('dmLinkInvalid');
  expect(f.acquire).not.toHaveBeenCalled();
});
it('publishes only after explicit configuration and scopes single-contact changes to that contact', async () => {
  const settings = { baseToken: 'app', tableId: 'tbl', fieldId: 'fldDm' };
  const f = fixture({ ...replies, table: { baseToken: 'app', tableId: 'tbl' } as ReplyDocument['table'] });
  f.configureLinks.mockResolvedValue(settings);
  await f.service.action({ action: 'list' });
  await f.service.updateLinks();
  expect(f.configureLinks).not.toHaveBeenCalled();
  expect(f.syncLinks).not.toHaveBeenCalled();
  await f.service.action({ action: 'configure-feishu' });
  expect(f.configureLinks).toHaveBeenCalledTimes(1);
  expect(f.store.read().feishu).toEqual(settings);
  expect(f.acquire).not.toHaveBeenCalled();
  await f.service.action({ action: 'sync-contact', key });
  expect(f.syncLinks.mock.lastCall?.[2]).toEqual([
    { platform: 'douyin', accountId: 'a', actorId: 'me', contactPlatformId: 'peer', direction: 'inbound', count: 2 },
  ]);
});
it('cancels an active read without saving late messages and always releases the shared lease', async () => {
  const f = fixture();
  let resolve!: () => void;
  f.readHistory.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = () => r({ messages: [message('late', 120)], complete: true, reason: undefined });
      })
  );
  const operation = f.service.action({ action: 'sync-contact', key });
  await vi.waitFor(() => expect(f.readHistory).toHaveBeenCalled());
  expect((await f.service.action({ action: 'status' })).status).toMatchObject({ busy: true, busyAccountId: 'a' });
  await expect(f.service.action({ action: 'sync-all' })).rejects.toThrow('dmBusy');
  await f.service.action({ action: 'cancel' });
  resolve();
  await expect(operation).rejects.toThrow('dmCancelled');
  expect(f.release).toHaveBeenCalledOnce();
  expect((await f.service.action({ action: 'thread', key })).detail?.messages).toEqual([]);
});
it('blocks replacing an externally changed stored version', () => {
  const f = fixture();
  const file = path.join(dir, 'direct-messages.json');
  writeFileSync(file, 'broken');
  expect(() =>
    f.store.update((d) => {
      d.lastSyncedAt = 200;
    })
  ).toThrow('dmStoreInvalid');
  expect(readFileSync(file, 'utf8')).toBe('broken');
});

it('rejects a comment key whose authors conflict, rather than assigning its link to one of them', async () => {
  const source = { ...replies, comments: [comment, { ...comment, authorId: 'different' }] };
  const f = fixture(source);
  await expect(f.service.action({ action: 'list' })).rejects.toThrow('dmIdentityMismatch');
  expect(f.acquire).not.toHaveBeenCalled();
});
it('keeps the same contact ID separate when a browser partition is rebound to a different actor', async () => {
  const otherWork = { ...work, key: 'douyin:a:me2:w', actorId: 'me2' };
  const f = fixture({
    ...replies,
    works: [work, otherWork],
    comments: [comment, { ...comment, actorId: 'me2', workKey: otherWork.key, key: otherWork.key + ':c' }],
  });
  const r = await f.service.action({ action: 'list' });
  expect(r.threads.map((t) => t.key).sort()).toEqual(['douyin:a:me2:peer', 'douyin:a:me:peer'].sort());
});

it('keeps a recall terminal when overlapping pages return older content and deterministically orders equal times', async () => {
  const f = fixture();
  await f.service.action({ action: 'sync-contact', key });
  const recalled = { ...message('1', 101), kind: 'recalled' as const, text: '' };
  f.readHistory.mockResolvedValue({
    messages: [recalled, message('z', 125), message('a', 125)],
    complete: false,
    reason: 'dmHistoryPartial',
  });
  await f.service.action({ action: 'sync-contact', key });
  f.readHistory.mockResolvedValue({ messages: [message('1', 101)], complete: false, reason: 'dmHistoryPartial' });
  const result = await f.service.action({ action: 'sync-contact', key });
  expect(result.detail?.messages.map((m) => m.id)).toEqual(['1', '2', 'a', 'z']);
  expect(result.detail?.messages[0]).toMatchObject({ kind: 'recalled', text: '' });
});
it('blocks config persistence and backfill if cancelled during explicit provisioning', async () => {
  const f = fixture({ ...replies, table: { baseToken: 'app', tableId: 'tbl' } as ReplyDocument['table'] });
  let finish!: () => void;
  f.configureLinks.mockImplementation(
    () =>
      new Promise((r) => {
        finish = () => r({ baseToken: 'app', tableId: 'tbl', fieldId: 'fldDm' });
      })
  );
  const task = f.service.action({ action: 'configure-feishu' });
  await vi.waitFor(() => expect(f.configureLinks).toHaveBeenCalled());
  await f.service.action({ action: 'cancel' });
  finish();
  await expect(task).rejects.toThrow('dmCancelled');
  expect(f.store.read().feishu).toBeUndefined();
  expect(f.syncLinks).not.toHaveBeenCalled();
});

it('stops a batch immediately on a signed-in actor mismatch instead of opening another conversation', async () => {
  const f = fixture();
  f.readHistory.mockRejectedValue(new Error('dmAccountMismatch'));
  await expect(f.service.action({ action: 'sync-all' })).rejects.toThrow('dmAccountMismatch');
  expect(f.acquire).toHaveBeenCalledTimes(1);
  expect(f.store.read().lastSyncedAt).toBeUndefined();
});
