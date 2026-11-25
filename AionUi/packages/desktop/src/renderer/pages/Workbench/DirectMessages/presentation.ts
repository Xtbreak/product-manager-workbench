import type { DmMessage, DmThread } from '@/common/types/platform/workbenchDm';

export const isWaiting = (thread: DmThread) => thread.lastSender === 'peer';
export const hasMessages = (thread: DmThread) => thread.lastMessageAt !== null;
export const groupWindow = 5 * 60 * 1000;
const regular = (kind: DmMessage['kind']) => kind !== 'system' && kind !== 'recalled';
export function joins(previous: DmMessage | undefined, next: DmMessage | undefined): boolean {
  if (!previous || !next) return false;

  return (
    regular(previous.kind) &&
    regular(next.kind) &&
    previous.sender === next.sender &&
    next.timestamp - previous.timestamp < groupWindow
  );
}
export function localTime(timestamp: number, locale: string | undefined, full = false) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const today = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(locale || undefined, {
    ...(full || !today ? { month: full ? 'short' : 'numeric', day: 'numeric' } : {}),
    ...(full || today ? ({ hour: '2-digit', minute: '2-digit' } as const) : {}),
  }).format(date);
}
export function dmErrorKey(code?: string) {
  switch (code) {
    case 'dmBusy':
    case 'dmBrowserBusy':
    case 'replyBrowserBusy':
      return 'common.workbench.dm.busy';
    case 'dmPartialHistory':
    case 'dmHistoryPartial':
      return 'common.workbench.dm.partial';
    case 'dmExistingDraft':
      return 'common.workbench.dm.draft';
    case 'dmContactNotFound':
      return 'common.workbench.dm.contactNotFound';
    case 'dmChallengeRequired':
      return 'common.workbench.dm.challenge';
    case 'dmLoginRequired':
      return 'common.workbench.dm.signIn';
    case 'dmActorMismatch':
    case 'dmAccountMismatch':
      return 'common.workbench.dm.accountMismatch';
    case 'dmIdentityMismatch':
    case 'dmParticipantMismatch':
      return 'common.workbench.dm.identity';
    case 'dmBrowserUnavailable':
    case 'dmBrowserClosed':
    case 'replyBrowserClosed':
      return 'common.workbench.dm.openBrowser';
    case 'dmLinkInvalid':
    case 'dmThreadNotFound':
      return 'common.workbench.dm.invalidLink';
    case 'dmStoreInvalid':
      return 'common.workbench.dm.storeError';
    case 'dmRestoreFailed':
      return 'common.workbench.dm.restore';
    case 'dmUnreadSkipped':
    case 'dmUnread':
      return 'common.workbench.dm.unread';
    case 'dmCancelled':
      return 'common.workbench.dm.cancelled';
    case 'dmFeishuFailed':
      return 'common.workbench.dm.feishuError';
    case 'dmPageUnverified':
    case 'dmUnavailable':
      return 'common.workbench.dm.unavailable';
    default:
      return 'common.workbench.dm.failure';
  }
}
