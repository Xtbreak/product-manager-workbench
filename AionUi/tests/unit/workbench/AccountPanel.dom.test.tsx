import React, { useState } from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AccountPanel from '@/renderer/pages/Workbench/AccountPanel';
import { AccountStore } from '@/renderer/pages/Workbench/accountStore';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
function mount() {
  const values = new Map<string, string>();
  const store = new AccountStore({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  });
  function Harness() {
    const [state, setState] = useState(store.read());
    return (
      <AccountPanel
        accounts={state.accounts}
        activeId={state.activeId}
        operatingAccounts={new Set()}
        onAdd={(name) => {
          setState(store.add(name));
          return true;
        }}
        onRename={(id, name) => {
          setState(store.update(id, { name }));
          return true;
        }}
        onRemove={(id) => setState(store.remove(id))}
        onOpen={(id) => setState(store.select(id))}
        onClose={(id) => setState(store.update(id, { open: false }))}
      />
    );
  }
  render(<Harness />);
  return store;
}
it('adds, closes, and reopens a named profile through the account panel', () => {
  const store = mount();
  fireEvent.change(screen.getByLabelText('common.workbench.accountName'), { target: { value: '产品观察' } });
  fireEvent.click(screen.getByLabelText('common.workbench.addAccount'));
  const partition = store.read().accounts[1].partition;
  expect(screen.getByText('产品观察')).toBeTruthy();
  fireEvent.click(
    within(screen.getByRole('group', { name: '产品观察' })).getByRole('button', {
      name: 'common.workbench.closeBrowser',
    })
  );
  expect(store.read().accounts[1].open).toBe(false);
  fireEvent.click(screen.getAllByRole('button', { name: 'common.workbench.openBrowser' })[1]);
  expect(store.read().accounts[1]).toMatchObject({ open: true, partition });
});
it('creates a default profile without entering a name', () => {
  const store = mount();
  expect(screen.getByLabelText('common.workbench.addAccount')).toBeEnabled();
  fireEvent.change(screen.getByLabelText('common.workbench.accountName'), { target: { value: '  ' } });
  fireEvent.click(screen.getByLabelText('common.workbench.addAccount'));
  expect(store.read().accounts[1]).toMatchObject({ name: 'Account 1', open: true });
});

it('selects and reopens the browser by account name and reflects the active account', () => {
  const store = mount();
  fireEvent.change(screen.getByLabelText('common.workbench.accountName'), { target: { value: '产品观察' } });
  fireEvent.click(screen.getByLabelText('common.workbench.addAccount'));
  expect(screen.getByRole('button', { name: '产品观察' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'common.workbench.mainAccount' }));
  expect(store.read().activeId).toBe('primary');
  expect(screen.getByRole('button', { name: '产品观察' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(
    within(screen.getByRole('group', { name: '产品观察' })).getByRole('button', {
      name: 'common.workbench.closeBrowser',
    })
  );
  fireEvent.click(screen.getByRole('button', { name: '产品观察' }));
  expect(store.read().accounts[1].open).toBe(true);
  expect(store.read().activeId).toBe(store.read().accounts[1].id);
});

it('shows browser visibility and allows closing the primary browser', () => {
  const store = mount();
  expect(screen.getByText('common.workbench.browserOpen')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'common.workbench.closeBrowser' }));
  expect(store.read().accounts[0].open).toBe(false);
  expect(screen.getByText('common.workbench.browserClosed')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'common.workbench.mainAccount' })).toHaveAttribute('aria-pressed', 'false');
});

it('offers deletion for a closed secondary account', async () => {
  const store = mount();
  fireEvent.click(screen.getByLabelText('common.workbench.addAccount'));
  const row = await screen.findByRole('group', { name: 'Account 1' });
  fireEvent.click(within(row).getByLabelText('common.workbench.closeBrowser'));
  fireEvent.click(within(row).getByLabelText('common.delete'));
  expect(store.read().accounts).toHaveLength(1);
  expect(screen.queryByRole('group', { name: 'Account 1' })).toBeNull();
});
