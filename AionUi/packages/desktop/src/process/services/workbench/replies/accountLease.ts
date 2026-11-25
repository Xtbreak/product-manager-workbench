import type { AccountTask } from '@/common/types/platform/workbenchDm';
import type { ReplyBrowserLease } from './contracts';

/** Pin a logical account to one guest lifetime and exclude all other CDP clients. */
export function createAccountLeases<T>(options: {
  current: (accountId: string) => { value: T; targetId: string } | undefined;
  isAlive: (value: T) => boolean;
  isBusy: (value: T) => boolean;
  command: (value: T, method: string, params: Record<string, unknown>) => Promise<unknown>;
  lock: (value: T, accountId: string, locked: boolean, task: AccountTask) => void;
  focus?: (value: T) => Promise<void>;
}) {
  const held = new Map<string, T>();
  const assertAvailable = (accountId: string) => {
    if (held.has(accountId)) throw new Error('replyBrowserBusy');
  };
  const acquire = async (accountId: string, task: AccountTask = 'comment-sync'): Promise<ReplyBrowserLease> => {
    assertAvailable(accountId);
    const target = options.current(accountId);
    if (!target || accountId === 'feishu' || !options.isAlive(target.value)) throw new Error('replyBrowserClosed');
    if (options.isBusy(target.value)) throw new Error('replyBrowserBusy');
    const { value, targetId } = target;
    let released = false;
    held.set(accountId, value);
    try {
      options.lock(value, accountId, true, task);
      await options.focus?.(value);
      if (options.current(accountId)?.value !== value || !options.isAlive(value)) throw new Error('replyBrowserClosed');
    } catch (error) {
      held.delete(accountId);
      options.lock(value, accountId, false, task);
      throw error;
    }
    return {
      accountId,
      targetId,
      command: async (method, params = {}) => {
        const current = options.current(accountId);
        if (
          released ||
          held.get(accountId) !== value ||
          current?.value !== value ||
          current.targetId !== targetId ||
          !options.isAlive(value)
        )
          throw new Error('replyBrowserClosed');
        return options.command(value, method, params);
      },
      release: () => {
        if (released) return;
        released = true;
        if (held.get(accountId) === value) held.delete(accountId);
        options.lock(value, accountId, false, task);
      },
    };
  };
  return { acquire, assertAvailable, isHeld: (accountId: string) => held.has(accountId) };
}
