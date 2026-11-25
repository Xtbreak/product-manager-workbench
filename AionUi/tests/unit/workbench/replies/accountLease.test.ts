import { describe, expect, it, vi } from 'vitest';
import { createAccountLeases } from '@process/services/workbench/replies/accountLease';

function fixture() {
  const first = { busy: false, alive: true, targetId: 'one' };
  let current: typeof first | undefined = first;
  const lock = vi.fn();
  const command = vi.fn(async () => 'ok');
  const focus = vi.fn(async (_value: typeof first): Promise<void> => undefined);
  const leases = createAccountLeases({
    current: () => (current ? { value: current, targetId: current.targetId } : undefined),
    isAlive: (value: typeof first) => value.alive,
    isBusy: (value: typeof first) => value.busy,
    command,
    lock,
    focus,
  });
  return {
    first,
    leases,
    command,
    lock,
    focus,
    close: () => {
      first.alive = false;
      current = undefined;
    },
    replace: () => {
      current = { busy: false, alive: true, targetId: 'two' };
    },
  };
}
describe('account browser leases', () => {
  it('rejects competing clients until the exclusive lease is released', async () => {
    const f = fixture();
    const lease = await f.leases.acquire('a');
    expect(() => f.leases.assertAvailable('a')).toThrow('replyBrowserBusy');
    await expect(f.leases.acquire('a')).rejects.toThrow('replyBrowserBusy');
    lease.release();
    expect(() => f.leases.assertAvailable('a')).not.toThrow();
  });
  it('never redirects an in-flight operation to a reopened account', async () => {
    const f = fixture();
    const lease = await f.leases.acquire('a');
    f.replace();
    await expect(lease.command('Runtime.evaluate')).rejects.toThrow('replyBrowserClosed');
    expect(f.command).not.toHaveBeenCalled();
    lease.release();
  });
  it('rejects acquisition while an older client command is still in flight', async () => {
    const f = fixture();
    f.first.busy = true;
    await expect(f.leases.acquire('a')).rejects.toThrow('replyBrowserBusy');
    expect(f.lock).not.toHaveBeenCalled();
  });
  it('cannot use a released lease and release is idempotent', async () => {
    const f = fixture();
    const lease = await f.leases.acquire('a');
    lease.release();
    lease.release();
    await expect(lease.command('Runtime.evaluate')).rejects.toThrow('replyBrowserClosed');
    expect(f.lock).toHaveBeenCalledTimes(2);
  });
  it('releases the lock when focusing the account fails, allowing a later acquisition', async () => {
    const f = fixture();
    f.focus.mockRejectedValueOnce(new Error('Focus failed'));
    await expect(f.leases.acquire('a')).rejects.toThrow('Focus failed');
    expect(f.lock.mock.calls.map((call) => call[2])).toEqual([true, false]);
    const retry = await f.leases.acquire('a');
    expect(await retry.command('Runtime.evaluate')).toBe('ok');
    retry.release();
  });
  it('holds the lock until a hidden account is focused before executing commands', async () => {
    const f = fixture();
    let finishFocus!: () => void;
    f.focus.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFocus = resolve;
        })
    );
    const pending = f.leases.acquire('a');
    expect(() => f.leases.assertAvailable('a')).toThrow('replyBrowserBusy');
    await expect(f.leases.acquire('a')).rejects.toThrow('replyBrowserBusy');
    expect(f.command).not.toHaveBeenCalled();
    finishFocus();
    const lease = await pending;
    await lease.command('Runtime.evaluate', { expression: 'document.title' });
    expect(f.focus.mock.invocationCallOrder[0]).toBeLessThan(f.command.mock.invocationCallOrder[0]);
    lease.release();
  });
  it('rejects a browser reopened while focus was pending and unlocks the old guest', async () => {
    const f = fixture();
    let finishFocus!: () => void;
    f.focus.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFocus = resolve;
        })
    );
    const pending = f.leases.acquire('a');
    f.replace();
    finishFocus();
    await expect(pending).rejects.toThrow('replyBrowserClosed');
    expect(f.lock.mock.calls.map((call) => call[2])).toEqual([true, false]);
    const reopened = await f.leases.acquire('a');
    expect(reopened.targetId).toBe('two');
    reopened.release();
  });
  it('rejects a browser destroyed while focus was pending without dispatching a command', async () => {
    const f = fixture();
    let finishFocus!: () => void;
    f.focus.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFocus = resolve;
        })
    );
    const pending = f.leases.acquire('a');
    f.close();
    finishFocus();
    await expect(pending).rejects.toThrow('replyBrowserClosed');
    expect(f.leases.isHeld('a')).toBe(false);
    expect(f.command).not.toHaveBeenCalled();
  });
  it('does not let release of an old lease unlock a new guest lease', async () => {
    const f = fixture();
    const old = await f.leases.acquire('a');
    f.replace();
    old.release();
    const fresh = await f.leases.acquire('a');
    old.release();
    expect(() => f.leases.assertAvailable('a')).toThrow('replyBrowserBusy');
    expect(await fresh.command('Runtime.evaluate')).toBe('ok');
    fresh.release();
  });
  it('rejects a changed target identifier even when the account object is reused', async () => {
    const f = fixture();
    const lease = await f.leases.acquire('a');
    f.first.targetId = 'replacement';
    await expect(lease.command('Runtime.evaluate')).rejects.toThrow('replyBrowserClosed');
    expect(f.command).not.toHaveBeenCalled();
    lease.release();
  });
});

it('exposes the DM task while excluding all other account operations', async () => {
  const f = fixture();
  const held = await f.leases.acquire('a', 'dm-sync');
  await expect(f.leases.acquire('a', 'comment-send')).rejects.toThrow('replyBrowserBusy');
  expect(f.lock).toHaveBeenCalledWith(f.first, 'a', true, 'dm-sync');
  held.release();
  expect(f.lock).toHaveBeenCalledWith(f.first, 'a', false, 'dm-sync');
});
