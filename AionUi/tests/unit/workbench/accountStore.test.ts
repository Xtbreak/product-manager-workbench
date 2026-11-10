import { describe, expect, it } from 'vitest';
import { AccountStore } from '@/renderer/pages/Workbench/accountStore';

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};
describe('persistent browser accounts', () => {
  it('preserves the existing login and gives new accounts separate persistent environments', () => {
    const store = new AccountStore(memory());
    const primary = store.read().accounts[0];
    const next = store.add('Second');
    expect(primary.partition).toBe('persist:aionui-browser');
    expect(next.accounts[1].partition).toMatch(/^persist:workbench-account-/);
    expect(new Set(next.accounts.map((a) => a.partition)).size).toBe(2);
  });
  it('keeps the same environment when renamed, closed, restarted and reopened', () => {
    const storage = memory();
    const store = new AccountStore(storage);
    const account = store.add('Second').accounts[1];
    store.update(account.id, { name: 'Renamed', open: false });
    const restored = new AccountStore(storage);
    const reopened = restored.update(account.id, { open: true }).accounts[1];
    expect(reopened).toMatchObject({ id: account.id, name: 'Renamed', partition: account.partition, open: true });
  });
  it('rejects corrupted metadata instead of replacing existing profiles', () => {
    const storage = {
      getItem: () => '{broken',
      setItem: () => {
        throw new Error('must not overwrite');
      },
    };
    expect(() => new AccountStore(storage).read()).toThrow();
  });
  it('does not claim an account was saved when disk storage fails', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(() => new AccountStore(storage).add('Second')).toThrow('full');
  });
  it('rejects blank renames and unknown account updates', () => {
    const store = new AccountStore(memory());
    expect(() => store.update('primary', { name: '  ' })).toThrow();
    expect(() => store.update('missing', { name: 'Wrong' })).toThrow();
  });
});

it('assigns unique default names while preserving custom names', () => {
  const store = new AccountStore(memory());
  store.add('账号 1');
  const state = store.add('', '账号');
  expect(state.accounts[2].name).toBe('账号 2');
  expect(store.add('   ', '账号').accounts[3].name).toBe('账号 3');
});

it('removes a secondary account persistently and restores a valid active account', () => {
  const storage = memory();
  const store = new AccountStore(storage);
  const primary = store.read().accounts[0];
  const added = store.add('Temporary');
  store.remove(added.activeId);
  const restored = new AccountStore(storage).read();
  expect(restored.accounts).toEqual([primary]);
  expect(restored.activeId).toBe(primary.id);
  expect(() => store.remove(primary.id)).toThrow();
  expect(() => store.remove('missing')).toThrow();
});
