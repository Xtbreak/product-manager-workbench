import { describe, expect, it, vi } from 'vitest';
import { createFeishuAuth, FEISHU_SCOPES } from '../../../packages/desktop/src/process/services/workbench/feishuAuth';
const ready = {
  appId: 'app',
  brand: 'feishu',
  identities: { user: { available: true, status: 'ready', scope: FEISHU_SCOPES, userName: 'Example' } },
};
describe('local Feishu authorization', () => {
  it('returns only display state, never raw credential fields', async () => {
    const auth = createFeishuAuth(vi.fn().mockResolvedValue({ ...ready, accessToken: 'secret' }));
    expect(await auth.status()).toEqual({ state: 'ready', userName: 'Example' });
  });
  it('requires the comment-table scopes even when a user is logged in', async () => {
    const auth = createFeishuAuth(
      vi
        .fn()
        .mockResolvedValue({ ...ready, identities: { user: { ...ready.identities.user, scope: 'wiki:node:read' } } })
    );
    expect((await auth.status()).state).toBe('missingPermissions');
  });
  it('does not mistake bot-only credentials for a user authorization', async () => {
    const auth = createFeishuAuth(vi.fn().mockResolvedValue({ ...ready, identities: {} }));
    expect((await auth.status()).state).toBe('loginRequired');
  });
  it('distinguishes a missing local installation', async () => {
    const auth = createFeishuAuth(vi.fn().mockRejectedValue(new Error('notInstalled')));
    expect((await auth.status()).state).toBe('notInstalled');
  });
  it('rejects untrusted authorization links without opening them', async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ device_code: 'private', verification_url: 'https://accounts.feishu.cn.evil.test/login' });
    const open = vi.fn();
    await expect(createFeishuAuth(run).login(open)).rejects.toThrow('loginFailed');
    expect(open).not.toHaveBeenCalled();
  });
  it('completes the same login inside main without returning the device code', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ device_code: 'private', verification_url: 'https://accounts.feishu.cn/login' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(ready);
    const auth = createFeishuAuth(run);
    await auth.login(vi.fn());
    expect(await auth.finish()).toEqual({ state: 'ready', userName: 'Example' });
    expect(run.mock.calls[1][0]).toEqual(['auth', 'login', '--device-code', 'private', '--json']);
  });
  it('does not expose raw CLI failures', async () => {
    const auth = createFeishuAuth(vi.fn().mockRejectedValue(new Error('access_token=private')));
    expect(await auth.status()).toEqual({ state: 'error' });
  });
});
