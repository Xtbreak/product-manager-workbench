import type { DmThread } from '@/common/types/platform/workbenchDm';
import type { ReplyBrowserLease } from '../../replies/contracts';
import { douyinHistory } from './douyin';
import { checkAbort, DY_INBOX, makeReader, originalPage, restore, XHS_INBOX, type History } from './guest';
import { xiaohongshuHistory } from './xiaohongshu';

/** Collect an explicitly requested, identity-bound conversation through its account's leased guest. */
export async function readDmHistory(
  lease: ReplyBrowserLease,
  thread: DmThread,
  signal: AbortSignal,
  mode: 'contact' | 'all'
): Promise<History> {
  checkAbort(signal);
  if (lease.accountId !== thread.accountId) throw Error('dmAccountMismatch');
  const xhs = thread.platform === 'xiaohongshu';
  const identifier = xhs ? /^[0-9a-f]{24}$/i : /^\d{1,30}$/;
  if (
    (!xhs && thread.platform !== 'douyin') ||
    !identifier.test(thread.contactPlatformId) ||
    !identifier.test(thread.actorId) ||
    thread.contactPlatformId === thread.actorId
  )
    throw Error('dmIdentityMismatch');

  const reader = makeReader(lease, thread, mode, signal);
  const original = await originalPage(reader, lease);
  const url = new URL(original.state.url);
  const ready = xhs
    ? url.origin === new URL(XHS_INBOX).origin && /^\/chat(?:\/[^/]+)?\/?$/.test(url.pathname)
    : url.origin + url.pathname === DY_INBOX;
  const navigate = async (destination: string) => {
    checkAbort(signal);
    const nav = (await lease.command('Page.navigate', { url: destination })) as { errorText?: string };
    if (nav?.errorText) throw Error('dmBrowserUnavailable');
  };
  try {
    checkAbort(signal);
    if (!ready) await navigate(xhs ? XHS_INBOX : DY_INBOX);
    const result = xhs
      ? await xiaohongshuHistory(reader, signal, () => navigate(XHS_INBOX + '/' + thread.contactPlatformId))
      : await douyinHistory(reader, signal);
    result.messages.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    return result;
  } finally {
    // Cancellation stops collection, but cleanup still owns the lease and must finish.
    await restore(makeReader(lease, thread, mode), lease, original);
  }
}
