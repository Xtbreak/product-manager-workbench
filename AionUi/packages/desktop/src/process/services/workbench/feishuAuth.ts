import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const FEISHU_SCOPES = 'base:record:read base:record:create base:field:read wiki:node:read offline_access';
export const REPLY_FEISHU_SCOPES = `${FEISHU_SCOPES} base:record:update base:table:read base:table:create base:field:create base:field:update base:view:read base:view:write_only base:workflow:read base:workflow:create base:workflow:update`;
export type FeishuAuthState = {
  state: 'ready' | 'loginRequired' | 'missingPermissions' | 'notInstalled' | 'notConfigured' | 'error';
  userName?: string;
};
export type Execute = (args: string[], timeout?: number, input?: string) => Promise<unknown>;
/** Resolve desktop launches which do not inherit the terminal PATH. */
async function executable(): Promise<string> {
  for (const directory of [
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homedir(), '.local/bin'),
  ]) {
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli');
    try {
      await access(file, constants.X_OK);
      return file;
    } catch {
      /* Try the next installation. */
    }
  }
  throw new Error('notInstalled');
}
export const executeFeishu: Execute = async (args, timeout = 30000, input) => {
  const file = await executable();
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
      },
      (error, stdout) => {
        // Never propagate raw CLI output/errors: they can contain credentials and auth URLs.
        if (error) {
          reject(new Error('cliFailed'));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('invalidResponse'));
        }
      }
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
};
const statusSchema = z.object({
  verified: z.boolean().optional(),
  appId: z.string().optional(),
  brand: z.string().optional(),
  identities: z
    .object({
      user: z
        .object({
          available: z.boolean(),
          status: z.string(),
          userName: z.string().optional(),
          scope: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
/** Credentials and device codes remain inside the main process / official CLI. */
export function createFeishuAuth(run: Execute = executeFeishu) {
  let pending: string | undefined;
  let busy = false;
  const status = async (verify = false): Promise<FeishuAuthState> => {
    try {
      const result = statusSchema.parse(await run(['auth', 'status', '--json', ...(verify ? ['--verify'] : [])]));
      if (!result.appId || result.brand !== 'feishu') return { state: 'notConfigured' };
      if (result.verified === false) return { state: 'loginRequired' };
      const user = result.identities?.user;
      if (!user?.available || !['ready', 'valid', 'needs_refresh'].includes(user.status))
        return { state: 'loginRequired' };
      const scopes = new Set((user.scope ?? '').split(/\s+/));
      const required = FEISHU_SCOPES.split(' ').filter((s) => s !== 'offline_access');
      return { state: required.every((s) => scopes.has(s)) ? 'ready' : 'missingPermissions', userName: user.userName };
    } catch (error) {
      return { state: error instanceof Error && error.message === 'notInstalled' ? 'notInstalled' : 'error' };
    }
  };
  return {
    status,
    async login(open: (url: string) => Promise<void>, scopes: string = FEISHU_SCOPES): Promise<void> {
      if (busy) throw new Error('busy');
      busy = true;
      pending = undefined;
      try {
        const data = z
          .object({ device_code: z.string().min(1), verification_url: z.string().url() })
          .parse(await run(['auth', 'login', '--scope', scopes, '--no-wait', '--json']));
        const url = new URL(data.verification_url);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname)
        )
          throw new Error('invalidAuthUrl');
        pending = data.device_code;
        await open(data.verification_url);
      } catch {
        pending = undefined;
        throw new Error('loginFailed');
      } finally {
        busy = false;
      }
    },
    async finish(): Promise<FeishuAuthState> {
      if (busy) throw new Error('busy');
      if (!pending) return status(true);
      busy = true;
      const code = pending;
      try {
        await run(['auth', 'login', '--device-code', code, '--json'], 120000);
        pending = undefined;
        return await status(true);
      } catch {
        pending = undefined;
        throw new Error('loginFailed');
      } finally {
        busy = false;
      }
    },
  };
}
export const feishuAuth = createFeishuAuth();
