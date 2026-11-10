import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';

export type BrowserAccount = { id: string; name: string; partition: string; url: string; open: boolean };
export type WorkbenchState = { version: 1; accounts: BrowserAccount[]; activeId: string; feishuUrl: string };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
const KEY = 'workbench.browser-accounts.v1';
export const PRIMARY_ACCOUNT_ID = 'primary';
export const FEISHU_PARTITION = 'persist:workbench-feishu';
export const DEFAULT_SOURCE_URL = 'https://www.xiaohongshu.com/explore';

/** Only web navigation is persisted; credentials remain in Electron's partition. */
export function validBrowserUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Versioned metadata store. Failed reads/writes are surfaced rather than resetting profiles. */
export class AccountStore {
  constructor(private readonly storage: Storage) {}
  read(): WorkbenchState {
    const raw = this.storage.getItem(KEY);
    if (raw === null)
      return {
        version: 1,
        accounts: [
          {
            id: PRIMARY_ACCOUNT_ID,
            name: '',
            partition: BROWSER_SESSION_PARTITION,
            url: DEFAULT_SOURCE_URL,
            open: true,
          },
        ],
        activeId: PRIMARY_ACCOUNT_ID,
        feishuUrl: 'https://www.feishu.cn/',
      };
    const state = JSON.parse(raw) as WorkbenchState;
    if (
      state?.version !== 1 ||
      !Array.isArray(state.accounts) ||
      !state.accounts.length ||
      !validBrowserUrl(state.feishuUrl)
    )
      throw new Error('Invalid browser account data');
    const ids = new Set<string>();
    const partitions = new Set<string>();
    for (const account of state.accounts) {
      if (
        !account ||
        typeof account.id !== 'string' ||
        typeof account.name !== 'string' ||
        typeof account.open !== 'boolean' ||
        !validBrowserUrl(account.url)
      )
        throw new Error('Invalid browser account');
      const expected =
        account.id === PRIMARY_ACCOUNT_ID ? BROWSER_SESSION_PARTITION : `persist:workbench-account-${account.id}`;
      if (
        !/^(primary|[a-f0-9-]{36})$/.test(account.id) ||
        account.partition !== expected ||
        ids.has(account.id) ||
        partitions.has(account.partition)
      )
        throw new Error('Invalid account isolation');
      ids.add(account.id);
      partitions.add(account.partition);
    }
    if (!ids.has(PRIMARY_ACCOUNT_ID) || typeof state.activeId !== 'string' || !ids.has(state.activeId))
      throw new Error('Invalid active account');
    return state;
  }
  private save(state: WorkbenchState): WorkbenchState {
    this.storage.setItem(KEY, JSON.stringify(state));
    return state;
  }
  add(name: string, defaultName = 'Account'): WorkbenchState {
    const state = this.read();
    let accountName = name.trim();
    if (!accountName) {
      let number = 1;
      const names = new Set(state.accounts.map((account) => account.name));
      while (names.has(`${defaultName} ${number}`)) number += 1;
      accountName = `${defaultName} ${number}`;
    }
    const id = crypto.randomUUID();
    return this.save({
      ...state,
      activeId: id,
      accounts: [
        ...state.accounts,
        { id, name: accountName, partition: `persist:workbench-account-${id}`, url: DEFAULT_SOURCE_URL, open: true },
      ],
    });
  }
  update(id: string, patch: Partial<Pick<BrowserAccount, 'name' | 'url' | 'open'>>): WorkbenchState {
    const state = this.read();
    if (!state.accounts.some((a) => a.id === id)) throw new Error('Unknown account');
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('Account name required');
    if (patch.url !== undefined && !validBrowserUrl(patch.url)) throw new Error('Invalid browser URL');
    return this.save({
      ...state,
      accounts: state.accounts.map((a) =>
        a.id === id ? { ...a, ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) } : a
      ),
    });
  }
  /** Remove a secondary account entry; browser session data is left intact. */
  remove(id: string): WorkbenchState {
    const state = this.read();
    if (id === PRIMARY_ACCOUNT_ID) throw new Error('Cannot remove primary account');
    if (!state.accounts.some((account) => account.id === id)) throw new Error('Unknown account');
    const accounts = state.accounts.filter((account) => account.id !== id);
    return this.save({
      ...state,
      accounts,
      activeId:
        state.activeId === id ? (accounts.find((account) => account.open)?.id ?? PRIMARY_ACCOUNT_ID) : state.activeId,
    });
  }
  select(id: string): WorkbenchState {
    const state = this.read();
    if (!state.accounts.some((a) => a.id === id)) throw new Error('Unknown account');
    return this.save({
      ...state,
      activeId: id,
      accounts: state.accounts.map((a) => (a.id === id ? { ...a, open: true } : a)),
    });
  }
  setFeishuUrl(url: string): WorkbenchState {
    if (!validBrowserUrl(url)) throw new Error('Invalid browser URL');
    return this.save({ ...this.read(), feishuUrl: url });
  }
}
