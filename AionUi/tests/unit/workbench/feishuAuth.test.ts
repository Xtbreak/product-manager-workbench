import { describe, expect, it, vi } from 'vitest';
import {
  createFeishuAuth,
  FEISHU_SCOPES,
  REPLY_FEISHU_SCOPES,
} from '../../../packages/desktop/src/process/services/workbench/feishuAuth';
const ready = {
  appId: 'app',
  brand: 'feishu',
  identities: { user: { available: true, status: 'ready', scope: FEISHU_SCOPES, userName: 'Example' } },
};
describe('local Feishu authorization', () => {
  it('requests only the original export scopes for the default login', async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ device_code: 'private', verification_url: 'https://accounts.feishu.cn/login' });
    await createFeishuAuth(run).login(vi.fn());
    expect(run.mock.calls[0][0]).toEqual([
      'auth',
      'login',
      '--scope',
      'base:record:read base:record:create base:field:read wiki:node:read offline_access',
      '--no-wait',
      '--json',
    ]);
  });
  it('adds update and sibling-table permissions only for an explicit reply login', async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ device_code: 'private', verification_url: 'https://accounts.feishu.cn/login' });
    await createFeishuAuth(run).login(vi.fn(), REPLY_FEISHU_SCOPES);
    const args = run.mock.calls[0][0] as string[];
    expect(args[args.indexOf('--scope') + 1].split(' ')).toEqual([
      ...FEISHU_SCOPES.split(' '),
      'base:record:update',
      'base:table:read',
      'base:table:create',
      'base:field:create',
      'base:field:update',
      'base:view:read',
      'base:view:write_only',
      'base:workflow:read',
      'base:workflow:create',
      'base:workflow:update',
    ]);
  });
  it('continues accepting legacy authorization without reply permissions', async () => {
    const run = vi.fn().mockResolvedValue({
      ...ready,
      identities: {
        user: { ...ready.identities.user, scope: 'base:record:read base:record:create base:field:read wiki:node:read' },
      },
    });
    expect((await createFeishuAuth(run).status()).state).toBe('ready');
  });
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
