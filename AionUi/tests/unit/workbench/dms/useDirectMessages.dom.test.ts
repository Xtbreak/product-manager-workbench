import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DmSyncAction, DmSyncResult, DmThread } from '@/common/types/platform/workbenchDm';
import { useDirectMessages } from '@/renderer/pages/Workbench/DirectMessages/useDirectMessages';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/common/adapter/ipcBridge', () => ({ application: { dmSync: { invoke } } }));
afterEach(() => {
  cleanup();
  invoke.mockReset();
});
const base: DmSyncResult = { status: { busy: false, partial: false, feishuConfigured: false }, threads: [] };
const ok = (data: DmSyncResult) => ({ success: true, data });
function deferred<T>() {
  let finish!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}
it('retains a user-action failure across an intermediate busy snapshot and refreshes cached state on release', async () => {
  const send = deferred<{ success: boolean; msg: string }>();
  let syncing = false;
  invoke.mockImplementation(async (request: DmSyncAction) => {
    if (request.action === 'sync-all') {
      syncing = true;
      return send.promise;
    }
    return ok({ ...base, status: { ...base.status, busy: syncing } });
  });
  const { result } = renderHook(() => useDirectMessages(true));
  await waitFor(() => expect(result.current.snapshot?.status.busy).toBe(false));
  act(() => {
    void result.current.run({ action: 'sync-all' });
  });
  act(() => {
    result.current.refreshLocal();
  });
  await waitFor(() => expect(result.current.snapshot?.status.busy).toBe(true));
  syncing = false;
  await act(async () => send.finish({ success: false, msg: 'dmChallengeRequired' }));
  await waitFor(() => expect(result.current.snapshot?.status.busy).toBe(false));
  expect(result.current.error).toBe('dmChallengeRequired');
  expect(result.current.pending).toBeUndefined();
  invoke.mockResolvedValue(ok(base));
  await act(async () => {
    await result.current.run({ action: 'sync-all' });
  });
  expect(result.current.error).toBeUndefined();
});
it('cancels the current command without admitting a second batch before it settles', async () => {
  const pending = deferred<ReturnType<typeof ok>>();
  invoke.mockImplementation(async (r: DmSyncAction) => (r.action === 'sync-all' ? pending.promise : ok(base)));
  const { result } = renderHook(() => useDirectMessages(true));
  await waitFor(() => expect(result.current.snapshot).toBeDefined());
  act(() => {
    void result.current.run({ action: 'sync-all' });
    void result.current.run({ action: 'sync-all' });
  });
  await act(async () => {
    await result.current.run({ action: 'cancel' });
  });
  expect(invoke.mock.calls.filter(([r]) => r.action === 'sync-all')).toHaveLength(1);
  expect(result.current.pending).toBe('sync-all');
  await act(async () => pending.finish(ok(base)));
  await waitFor(() => expect(result.current.pending).toBeUndefined());
});
it('ignores older details when the same contact is selected again', async () => {
  const first = deferred<ReturnType<typeof ok>>();
  let loads = 0;
  const thread: DmThread = {
    key: 'k',
    source: 'comment',
    platform: 'douyin',
    actorId: 'me',
    accountId: 'a',
    contactName: 'Peer',
    contactPlatformId: 'p',
    commentKeys: [],
    lastMessagePreview: '',
    lastMessageAt: null,
    lastSender: null,
    syncState: 'idle',
    watermark: null,
  };
  const withDetail = (text: string): DmSyncResult => ({
    ...base,
    threads: [thread],
    detail: { thread, comments: [], messages: [{ id: 'm', timestamp: 1, sender: 'peer', kind: 'text', text }] },
  });
  invoke.mockImplementation(async (r: DmSyncAction) =>
    r.action === 'thread' ? (++loads === 1 ? first.promise : ok(withDetail('new'))) : ok(base)
  );
  const { result } = renderHook(() => useDirectMessages(true));
  await waitFor(() => expect(result.current.snapshot).toBeDefined());
  act(() => {
    void result.current.select('k');
  });
  await act(async () => {
    await result.current.select('k');
  });
  await act(async () => first.finish(ok(withDetail('old'))));
  expect(result.current.detail?.messages[0].text).toBe('new');
});

it('binds a late contact-update failure to the contact that requested it', async () => {
  const outcome = deferred<{ success: boolean; msg: string }>();
  invoke.mockImplementation(async (r: DmSyncAction) => (r.action === 'sync-contact' ? outcome.promise : ok(base)));
  const { result } = renderHook(() => useDirectMessages(true));
  await act(async () => {
    await result.current.select('dy');
  });
  act(() => {
    void result.current.run({ action: 'sync-contact', key: 'dy' });
  });
  await act(async () => {
    await result.current.select('xhs');
  });
  await act(async () => {
    outcome.finish({ success: false, msg: 'dmLoginRequired' });
  });
  await waitFor(() => expect(result.current.pending).toBeUndefined());
  expect(result.current.selected).toBe('xhs');
  expect(result.current.error).toBe('dmLoginRequired');
  expect(result.current.errorThreadKey).toBe('dy');
});
