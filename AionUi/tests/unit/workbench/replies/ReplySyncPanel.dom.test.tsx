import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplySyncAction, ReplySyncStatus } from '@/common/types/platform/workbenchReply';
import ReplySyncPanel, { ReplyBrowserLock } from '@/renderer/pages/Workbench/ReplySyncPanel';

const { invoke, authInvoke } = vi.hoisted(() => ({ invoke: vi.fn(), authInvoke: vi.fn() }));
vi.mock('@/common/adapter/ipcBridge', () => ({
  application: { replySync: { invoke }, feishuAuth: { invoke: authInvoke } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const initial: ReplySyncStatus = { enabled: false, busy: false, works: [], archived: 0, sent: 0, uncertain: 0 };
const tableUrl = 'https://my.feishu.cn/base/test?table=new';
const setup = { ...initial, tableUrl };
const accounts = [
  { id: 'xhs', name: 'XHS' },
  { id: 'dy', name: 'Douyin' },
];
const key = (name: string) => `common.workbench.replySync.${name}`;
function openSettings() {
  fireEvent.click(screen.getByRole('button', { name: 'common.more' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'common.settings' }));
}
function mount() {
  const onOpenTable = vi.fn();
  render(
    <ReplySyncPanel sourceUrl='https://my.feishu.cn/wiki/original' accounts={accounts} onOpenTable={onOpenTable} />
  );
  openSettings();
  return onOpenTable;
}
beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ success: true, data: initial });
  authInvoke.mockReset().mockResolvedValue({ success: true, data: { state: 'pending' } });
});
afterEach(cleanup);

describe('Feishu manual delivery toolbar', () => {
  function renderToolbar() {
    render(<ReplySyncPanel sourceUrl={tableUrl} accounts={accounts} onOpenTable={vi.fn()} />);
  }

  it.each(['bind', 'collect', 'reconcile'] as const)(
    'closes settings and releases background isolation before %s starts',
    async (action) => {
      const observations: Array<{ inert: boolean; dialog: boolean }> = [];
      invoke.mockImplementation(async (request: ReplySyncAction) => {
        if (request.action === action) {
          observations.push({
            inert: Boolean(document.querySelector('[data-testid="browser-background"]')?.hasAttribute('inert')),
            dialog: Boolean(screen.queryByRole('dialog')),
          });
        }
        return { success: true, data: { ...setup, works: [{ key: 'w' }], uncertain: 1 } };
      });
      function Harness() {
        const [modalOpen, setModalOpen] = useState(false);
        return (
          <section data-testid='browser-background' inert={modalOpen || undefined}>
            <ReplySyncPanel
              sourceUrl={tableUrl}
              accounts={accounts}
              onOpenTable={vi.fn()}
              onSettingsVisibilityChange={setModalOpen}
            />
            <webview />
          </section>
        );
      }
      render(<Harness />);
      await screen.findByRole('button', { name: key('collectComments') });
      openSettings();
      const dialog = await screen.findByRole('dialog');
      if (action === 'bind') {
        const row = within(dialog).getByRole('group', { name: 'Douyin' });
        fireEvent.click(within(row).getByRole('button', { name: key('bindCurrent') }));
      } else
        fireEvent.click(
          within(dialog).getByRole('button', { name: key(action === 'collect' ? 'collectComments' : 'reconcile') })
        );
      await waitFor(() => expect(observations).toHaveLength(1));
      expect(observations).toEqual([{ inert: false, dialog: false }]);
    }
  );

  it('drops a deferred browser action when the panel unmounts before the modal closes', async () => {
    invoke.mockResolvedValue({ success: true, data: { ...setup, works: [{ key: 'w' }] } });
    const view = render(<ReplySyncPanel sourceUrl={tableUrl} accounts={accounts} onOpenTable={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: key('collectComments') })).toBeEnabled());
    openSettings();
    const row = await screen.findByRole('group', { name: 'Douyin' });
    const bind = within(row).getByRole('button', { name: key('bindCurrent') });
    fireEvent.click(bind);
    fireEvent.click(bind);
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(invoke.mock.calls.some(([action]: [ReplySyncAction]) => action.action === 'bind')).toBe(false);
  });

  it('shows a deferred binding failure on the toolbar after settings closes', async () => {
    invoke.mockImplementation(async (action: ReplySyncAction) =>
      action.action === 'bind'
        ? { success: false, msg: 'replyBrowserClosed' }
        : { success: true, data: { ...setup, works: [{ key: 'w' }] } }
    );
    renderToolbar();
    await waitFor(() => expect(screen.getByRole('button', { name: key('collectComments') })).toBeEnabled());
    openSettings();
    const row = await screen.findByRole('group', { name: 'Douyin' });
    fireEvent.click(within(row).getByRole('button', { name: key('bindCurrent') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(key('errors.replyBrowserClosed'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(invoke.mock.calls.filter(([action]: [ReplySyncAction]) => action.action === 'bind')).toHaveLength(1);
  });

  it('focuses reply settings and restores the More button after Escape', async () => {
    const visibility = vi.fn();
    render(
      <ReplySyncPanel
        sourceUrl={tableUrl}
        accounts={accounts}
        onOpenTable={vi.fn()}
        onSettingsVisibilityChange={visibility}
      />
    );
    const more = screen.getByRole('button', { name: 'common.more' });
    more.focus();
    openSettings();
    const dialog = await screen.findByRole('dialog');
    const close = within(dialog).getByRole('button', { name: 'common.close' });
    await waitFor(() => expect(close).toHaveFocus());
    expect(visibility).toHaveBeenCalledWith(true);
    const user = userEvent.setup();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(visibility).toHaveBeenCalledWith(false));
    await waitFor(() => expect(more).toHaveFocus());
    expect(invoke.mock.calls.some(([action]: [ReplySyncAction]) => action.action === 'send-pending')).toBe(false);
  });

  it('restores More when reply settings are closed by its close control', async () => {
    const visibility = vi.fn();
    render(
      <ReplySyncPanel
        sourceUrl={tableUrl}
        accounts={accounts}
        onOpenTable={vi.fn()}
        onSettingsVisibilityChange={visibility}
      />
    );
    const more = screen.getByRole('button', { name: 'common.more' });
    openSettings();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.close' }));
    await waitFor(() => expect(visibility).toHaveBeenCalledWith(false));
    await waitFor(() => expect(more).toHaveFocus());
  });

  it.each([false, true])(
    'syncs from the toolbar shortcut and retains feedback (button configured=%s)',
    async (sendButtonConfigured) => {
      let finish!: (result: unknown) => void;
      const idle = { ...setup, sendButtonConfigured, works: [{ key: 'w' }] };
      invoke.mockImplementation((action: ReplySyncAction) =>
        action.action === 'collect'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve({ success: true, data: idle })
      );
      renderToolbar();
      const shortcut = await screen.findByRole('button', { name: key('collectComments') });
      await waitFor(() => expect(shortcut).toBeEnabled());
      fireEvent.click(shortcut);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(shortcut).toBeDisabled();
      await act(async () => finish({ success: false, msg: 'replyBrowserClosed' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(key('errors.replyBrowserClosed'));
      expect(invoke.mock.calls.map(([action]: [ReplySyncAction]) => action.action)).toEqual(['status', 'collect']);
    }
  );

  it('keeps an action failure through background status refresh until a successful retry', async () => {
    const idle = { ...setup, works: [{ key: 'w' }] };
    let failCollection = true;
    invoke.mockImplementation(async (action: ReplySyncAction) => {
      if (action.action === 'collect' && failCollection) throw new Error('temporary IPC failure');
      return { success: true, data: idle };
    });
    vi.useFakeTimers();
    try {
      await act(async () => renderToolbar());
      await act(async () => fireEvent.click(screen.getByRole('button', { name: key('collectComments') })));
      expect(screen.getByRole('alert')).toHaveTextContent(key('error'));
      await act(async () => vi.advanceTimersByTime(15_000));
      expect(screen.getByRole('alert')).toHaveTextContent(key('error'));
      failCollection = false;
      await act(async () => fireEvent.click(screen.getByRole('button', { name: key('collectComments') })));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows incomplete collection feedback without opening reply settings', async () => {
    invoke.mockResolvedValue({ success: true, data: { ...setup, collectionPartial: true } });
    renderToolbar();
    expect(await screen.findByRole('status')).toHaveTextContent(key('partial'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(invoke.mock.calls.map(([action]: [ReplySyncAction]) => action.action)).toEqual(['status']);
  });

  it.each([
    'replyDraftChanged',
    'replyThreadIncomplete',
    'replySourceIdentityChanged',
    'replyDuplicateWork',
    'replyDuplicateComment',
  ])('explains %s at the toolbar without suggesting unrelated authorization', async (error) => {
    invoke.mockResolvedValue({ success: true, data: { ...setup, error } });
    renderToolbar();
    expect(await screen.findByRole('alert')).toHaveTextContent(key(`errors.${error}`));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([initial, setup, { ...setup, busy: true, works: [{ key: 'w' }] }])(
    'disables the sync shortcut without a table, bound works, or while busy',
    async (status) => {
      invoke.mockResolvedValue({ success: true, data: status });
      renderToolbar();
      expect(await screen.findByRole('button', { name: key('collectComments') })).toBeDisabled();
    }
  );

  it.each(['reconcile', 'cancel'] as const)('keeps %s in More without opening settings', async (action) => {
    invoke.mockResolvedValue({
      success: true,
      data: { ...setup, sendButtonConfigured: true, sendMode: 'toolbar', canCancelSend: true, uncertain: 1 },
    });
    renderToolbar();
    await screen.findByRole('button', { name: key('sendPending') });
    fireEvent.click(screen.getByRole('button', { name: 'common.more' }));
    expect(screen.queryByRole('menuitem', { name: key('collectComments') })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'common.settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: key(action === 'cancel' ? 'cancelSend' : 'reconcile') }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires arranging a legacy reply table before toolbar draft sending', async () => {
    const legacy = { ...setup, sendButtonConfigured: true, works: [{ key: 'w' }] };
    invoke.mockImplementation(async (action: ReplySyncAction) => ({
      success: true,
      data: action.action === 'configure' ? { ...legacy, sendMode: 'toolbar' } : legacy,
    }));
    renderToolbar();
    const send = await screen.findByRole('button', { name: key('sendPending') });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    openSettings();
    expect(screen.getByText(key('configureHint'))).toBeInTheDocument();
    expect(screen.queryByText(key('buttonConfigured'))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: key('configureTable') }));
    await waitFor(() => expect(send).toBeEnabled());
    expect(invoke.mock.calls.map(([action]: [ReplySyncAction]) => action.action)).toEqual(['status', 'configure']);
  });

  it.each(['automatic', 'manual', undefined])(
    'offers explicit batch sending without a mode selector for saved mode %s',
    async (buttonDispatchMode) => {
      invoke.mockResolvedValue({
        success: true,
        data: { ...setup, sendButtonConfigured: true, sendMode: 'toolbar', buttonDispatchMode, works: [{ key: 'w' }] },
      });
      renderToolbar();
      fireEvent.click(await screen.findByRole('button', { name: key('sendPending') }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'send-pending' }));
      expect(screen.queryByRole('group', { name: key('modeLabel') })).not.toBeInTheDocument();
      expect(invoke.mock.calls.map(([action]: [ReplySyncAction]) => action.action)).toEqual(['status', 'send-pending']);
    }
  );

  it.each([
    { busy: true, works: [{ key: 'w' }] },
    { busy: false, works: [] },
  ])('disables manual sending while busy or without bound works', async (state) => {
    invoke.mockResolvedValue({
      success: true,
      data: { ...setup, ...state, sendButtonConfigured: true, sendMode: 'toolbar' },
    });
    renderToolbar();
    expect(await screen.findByRole('button', { name: key('sendPending') })).toBeDisabled();
  });

  it('prevents overlapping clicks and reports a batch failure', async () => {
    let finish!: (result: unknown) => void;
    const idle = { ...setup, sendButtonConfigured: true, sendMode: 'toolbar', works: [{ key: 'w' }] };
    invoke.mockImplementation((action: ReplySyncAction) =>
      action.action === 'send-pending'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ success: true, data: idle })
    );
    renderToolbar();
    fireEvent.click(await screen.findByRole('button', { name: key('sendPending') }));
    expect(screen.getByRole('button', { name: key('sendPending') })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: key('sendPending') }));
    await act(async () => finish({ success: false, msg: 'replySendButtonRequired' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(key('errors.replySendButtonRequired'));
    expect(invoke.mock.calls.filter(([action]: [ReplySyncAction]) => action.action === 'send-pending')).toHaveLength(1);
  });

  it('refreshes local status during a pending batch to expose cancellation', async () => {
    const idle = {
      ...setup,
      sendButtonConfigured: true,
      sendMode: 'toolbar',
      buttonDispatchMode: 'manual',
      works: [{ key: 'w' }],
    };
    let selected = false;
    invoke.mockImplementation((action: { action: string }) => {
      if (action.action === 'send-pending') {
        selected = true;
        return new Promise(() => {});
      }
      return Promise.resolve({ success: true, data: selected ? { ...idle, busy: true, canCancelSend: true } : idle });
    });
    vi.useFakeTimers();
    try {
      await act(async () => {
        renderToolbar();
      });
      fireEvent.click(screen.getByRole('button', { name: key('sendPending') }));
      openSettings();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(screen.getByRole('button', { name: key('cancelSend') })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a delayed status response after the batch completes', async () => {
    let finishBatch!: (result: unknown) => void;
    let finishStatus!: (result: unknown) => void;
    let selected = false;
    const idle = { ...setup, sendButtonConfigured: true, sendMode: 'toolbar', works: [{ key: 'w' }] };
    invoke.mockImplementation((action: ReplySyncAction) => {
      if (action.action === 'send-pending') {
        selected = true;
        return new Promise((resolve) => {
          finishBatch = resolve;
        });
      }
      return selected
        ? new Promise((resolve) => {
            finishStatus = resolve;
          })
        : Promise.resolve({ success: true, data: idle });
    });
    vi.useFakeTimers();
    try {
      await act(async () => {
        renderToolbar();
      });
      fireEvent.click(screen.getByRole('button', { name: key('sendPending') }));
      openSettings();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      await act(async () => finishBatch({ success: true, data: { ...idle, sent: 2, error: 'replySendUncertain' } }));
      await act(async () => finishStatus({ success: true, data: { ...idle, busy: true, canCancelSend: true } }));
      expect(screen.getByRole('alert')).toHaveTextContent(key('errors.replySendUncertain'));
      expect(screen.getByText(key('sent')).parentElement).toHaveTextContent('2');
      expect(screen.queryByRole('button', { name: key('cancelSend') })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a batch failure when an earlier status check resolves afterward', async () => {
    let finishBatch!: (result: unknown) => void;
    let finishStatus!: (result: unknown) => void;
    let selected = false;
    const idle = {
      ...setup,
      sendButtonConfigured: true,
      sendMode: 'toolbar',
      buttonDispatchMode: 'manual',
      works: [{ key: 'w' }],
    };
    invoke.mockImplementation((action: ReplySyncAction) => {
      if (action.action === 'send-pending') {
        selected = true;
        return new Promise((resolve) => {
          finishBatch = resolve;
        });
      }
      return selected
        ? new Promise((resolve) => {
            finishStatus = resolve;
          })
        : Promise.resolve({ success: true, data: idle });
    });
    vi.useFakeTimers();
    try {
      await act(async () => {
        renderToolbar();
      });
      fireEvent.click(screen.getByRole('button', { name: key('sendPending') }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      await act(async () => finishBatch({ success: false, msg: 'replySendUncertain' }));
      await act(async () => finishStatus({ success: true, data: idle }));
      expect(screen.getByRole('alert')).toHaveTextContent(key('errors.replySendUncertain'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps completed batch results when a delayed cancel returns an older busy status', async () => {
    let finishBatch!: (result: unknown) => void;
    let finishCancel!: (result: unknown) => void;
    let selected = false;
    const idle = {
      ...setup,
      sendButtonConfigured: true,
      sendMode: 'toolbar',
      buttonDispatchMode: 'manual',
      works: [{ key: 'w' }],
    };
    const running = { ...idle, busy: true, canCancelSend: true };
    invoke.mockImplementation((action: { action: string }) => {
      if (action.action === 'send-pending') {
        selected = true;
        return new Promise((resolve) => {
          finishBatch = resolve;
        });
      }
      if (action.action === 'cancel')
        return new Promise((resolve) => {
          finishCancel = resolve;
        });
      return Promise.resolve({ success: true, data: selected ? running : idle });
    });
    vi.useFakeTimers();
    try {
      await act(async () => {
        renderToolbar();
      });
      fireEvent.click(screen.getByRole('button', { name: key('sendPending') }));
      openSettings();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      fireEvent.click(screen.getByRole('button', { name: key('cancelSend') }));
      await act(async () => finishBatch({ success: true, data: { ...idle, sent: 2, error: 'replySendUncertain' } }));
      await act(async () => finishCancel({ success: true, data: running }));
      expect(screen.getByRole('alert')).toHaveTextContent(key('errors.replySendUncertain'));
      expect(screen.getByText(key('sent')).parentElement).toHaveTextContent('2');
      expect(screen.queryByText(key('syncing'))).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: key('cancelSend') })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([initial, setup])('hides delivery controls without a configured table', async (status) => {
    invoke.mockResolvedValue({ success: true, data: status });
    renderToolbar();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'status' }));
    expect(screen.queryByRole('button', { name: key('automaticMode') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: key('sendPending') })).not.toBeInTheDocument();
  });
});

describe('Feishu reply controls', () => {
  it('creates a dedicated reply table without enabling automatic sends', async () => {
    invoke.mockImplementation(async (action: ReplySyncAction) => ({
      success: true,
      data: action.action === 'setup' ? setup : initial,
    }));
    const open = mount();
    fireEvent.click(await screen.findByRole('button', { name: key('setup') }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(tableUrl));
    expect(invoke).toHaveBeenCalledWith({ action: 'setup', sourceUrl: 'https://my.feishu.cn/wiki/original' });
    expect(invoke.mock.calls.some(([action]: [ReplySyncAction]) => action.action === 'enabled')).toBe(false);
  });

  it('explains both manual paths before the table send button is configured', async () => {
    invoke.mockResolvedValue({ success: true, data: setup });
    mount();
    expect(await screen.findByRole('button', { name: key('configureTable') })).toBeInTheDocument();
    expect(screen.getByText(key('feishuReplyPath'))).toBeInTheDocument();
    expect(screen.getByText(key('platformReplyPath'))).toBeInTheDocument();
    expect(screen.getByText(key('replyBackfillHint'))).toBeInTheDocument();
  });

  it('configures the existing table and opens the returned six-column view without enabling sends', async () => {
    const configuredUrl = `${tableUrl}&view=reply-view`;
    invoke.mockImplementation(async (action: ReplySyncAction) => ({
      success: true,
      data:
        action.action === 'configure'
          ? { ...setup, tableUrl: configuredUrl, sendButtonConfigured: true, sendMode: 'toolbar' }
          : setup,
    }));
    const open = mount();
    fireEvent.click(await screen.findByRole('button', { name: key('configureTable') }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(configuredUrl));
    expect(screen.getByText(key('buttonConfigured'))).toBeInTheDocument();
    expect(invoke.mock.calls.some(([action]: [ReplySyncAction]) => action.action === 'enabled')).toBe(false);
  });

  it('explains explicit batch sending and the Workbench comment link for configured tables', async () => {
    invoke.mockResolvedValue({ success: true, data: { ...setup, sendButtonConfigured: true, sendMode: 'toolbar' } });
    mount();
    expect(await screen.findByText(key('feishuReplyPath'))).toBeInTheDocument();
    expect(screen.getByText(key('commentLinkHint'))).toBeInTheDocument();
    expect(screen.getByText(key('manualRuntimeHint'))).toBeInTheDocument();
  });

  it.each([false, true])('uses manual sending controls for configured tables (enabled=%s)', async (enabled) => {
    invoke.mockResolvedValue({
      success: true,
      data: {
        ...setup,
        enabled,
        buttonDispatchMode: 'manual',
        sendButtonConfigured: true,
        sendMode: 'toolbar',
        works: [{ key: 'w' }],
      },
    });
    mount();
    expect(await screen.findByText(key('manualSending'))).toBeInTheDocument();
    expect(screen.queryByText(key('running'))).not.toBeInTheDocument();
    expect(screen.queryByText(key('paused'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: key('enable') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: key('pause') })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: key('collectComments') }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'collect' }));
  });

  it('offers cancellation only for the selected send, even while busy', async () => {
    invoke.mockResolvedValue({
      success: true,
      data: { ...setup, busy: true, sendButtonConfigured: true, sendMode: 'toolbar', canCancelSend: true },
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: key('cancelSend') }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'cancel' }));
  });

  it('does not offer cancellation when no send is selected', async () => {
    invoke.mockResolvedValue({
      success: true,
      data: { ...setup, sendButtonConfigured: true, sendMode: 'toolbar', buttonDispatchMode: 'manual' },
    });
    mount();
    await screen.findByText(key('manualSending'));
    expect(screen.queryByRole('button', { name: key('cancelSend') })).not.toBeInTheDocument();
  });

  it('preserves the existing table and offers authorization when configuration lacks permission', async () => {
    invoke.mockImplementation(async (action: ReplySyncAction) =>
      action.action === 'configure'
        ? { success: false, msg: 'replyMissingPermissions' }
        : { success: true, data: setup }
    );
    const open = mount();
    fireEvent.click(await screen.findByRole('button', { name: key('configureTable') }));
    expect(await screen.findByRole('alert')).toHaveTextContent('common.workbench.feishuAuth.missingPermissions');
    expect(screen.getByRole('button', { name: key('authorizeReplies') })).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps configuration available for retry after an unknown configuration failure', async () => {
    invoke.mockImplementation(async (action: ReplySyncAction) =>
      action.action === 'configure'
        ? { success: false, msg: 'SENSITIVE_CONFIG_OUTPUT' }
        : { success: true, data: setup }
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: key('configureTable') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(key('error'));
    expect(screen.queryByText('SENSITIVE_CONFIG_OUTPUT')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: key('configureTable') })).not.toBeDisabled();
  });

  it.each([
    'replyPresentationConflict',
    'replyPresentationUnverified',
    'replyCliFailed',
    'replyFieldSchemaChanged',
    'replyInvalidResponse',
    'replyPauseRequired',
  ])('explains how to recover from table configuration error %s', async (error) => {
    invoke.mockResolvedValue({ success: true, data: { ...setup, error } });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(key(`errors.${error}`));
  });

  it('uses toolbar retry guidance after a configured draft send is interrupted', async () => {
    invoke.mockResolvedValue({
      success: true,
      data: { ...setup, sendButtonConfigured: true, sendMode: 'toolbar', error: 'replyApprovalInterrupted' },
    });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(key('errors.replyButtonApprovalInterrupted'));
  });

  it('shows manual verification recovery without asking to pause automatic replies', async () => {
    invoke.mockResolvedValue({
      success: true,
      data: { ...setup, sendButtonConfigured: true, sendMode: 'toolbar', error: 'replyVerificationRequired' },
    });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(key('errors.replyButtonVerificationRequired'));
  });

  it('binds the explicitly selected account to its current work', async () => {
    invoke.mockResolvedValue({ success: true, data: setup });
    mount();
    const row = await screen.findByRole('group', { name: 'Douyin' });
    fireEvent.click(within(row).getByRole('button', { name: key('bindCurrent') }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'bind', accountId: 'dy' }));
  });

  it.each([false, true])('only offers collection for an unconfigured legacy table (enabled=%s)', async (enabled) => {
    invoke.mockResolvedValue({ success: true, data: { ...setup, enabled, works: [{ key: 'w' }] } });
    mount();
    fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: key('collectComments') }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'collect' }));
    expect(screen.queryByRole('button', { name: key('enable') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: key('pause') })).not.toBeInTheDocument();
  });

  it('shows a safe actionable error and does not navigate when setup fails', async () => {
    invoke.mockImplementation(async (action: ReplySyncAction) =>
      action.action === 'setup' ? { success: false, msg: 'sensitive CLI response' } : { success: true, data: initial }
    );
    const open = mount();
    fireEvent.click(await screen.findByRole('button', { name: key('setup') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(key('error'));
    expect(screen.queryByText('sensitive CLI response')).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
  it.each([
    'replyVerificationRequired',
    'replyOwnComment',
    'replyCommentLinkInvalid',
    'replyAccountMismatch',
    'replyDraftPresent',
    'replyTargetUnavailable',
    'replyBrowserClosed',
    'replyBrowserBusy',
    'replyApprovalInterrupted',
    'replyStoreInvalid',
    'replyResultPending',
    'replyArchiveUncertain',
    'replySendUncertain',
  ])('renders a translated recovery hint for %s from status', async (error) => {
    invoke.mockResolvedValue({ success: true, data: { ...setup, error } });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(key(`errors.${error}`));
  });

  it('translates a known failed-action code without exposing arbitrary provider text', async () => {
    invoke.mockImplementation(async (action: ReplySyncAction) =>
      action.action === 'setup' ? { success: false, msg: 'replyBrowserClosed' } : { success: true, data: initial }
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: key('setup') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(key('errors.replyBrowserClosed'));
  });

  it.each(['replyMissingPermissions', 'replyLoginRequired', 'replyAuthNotConfigured'])(
    'offers authorization for %s',
    async (error) => {
      invoke.mockResolvedValue({ success: true, data: { ...setup, error } });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: key('authorizeReplies') }));
      await waitFor(() => expect(authInvoke).toHaveBeenCalledWith({ action: 'reply-login' }));
      expect(await screen.findByText('common.workbench.feishuAuth.pending')).toBeInTheDocument();
    }
  );

  it('finishes browser authorization without starting synchronization or sending', async () => {
    invoke.mockResolvedValue({ success: true, data: { ...setup, error: 'replyMissingPermissions' } });
    authInvoke.mockImplementation(async (action: { action: string }) => ({
      success: true,
      data: { state: action.action === 'finish' ? 'ready' : 'pending' },
    }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: key('authorizeReplies') }));
    fireEvent.click(await screen.findByRole('button', { name: 'common.workbench.feishuAuth.finish' }));
    expect(await screen.findByText(key('authReadyHint'))).toBeInTheDocument();
    expect(invoke.mock.calls.every(([action]: [ReplySyncAction]) => action.action === 'status')).toBe(true);
  });
});

describe('locked account browser controls', () => {
  it('cancels the selected button send for the locked account', async () => {
    invoke.mockResolvedValue({
      success: true,
      data: {
        ...setup,
        busy: true,
        busyAccountId: 'xhs',
        sendButtonConfigured: true,
        sendMode: 'toolbar',
        canCancelSend: true,
      },
    });
    render(<ReplyBrowserLock accountId='xhs' />);
    fireEvent.click(await screen.findByRole('button', { name: key('cancelSend') }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'cancel' }));
  });

  it('offers no legacy automation controls for old saved state', async () => {
    invoke.mockResolvedValue({
      success: true,
      data: { ...setup, enabled: true, busy: true, busyAccountId: 'xhs', sendButtonConfigured: false },
    });
    render(<ReplyBrowserLock accountId='xhs' />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'status' }));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each([
    { success: false },
    { success: true, data: { ...setup, busy: true, enabled: true, busyAccountId: 'xhs' } },
    {
      success: true,
      data: {
        ...setup,
        busy: true,
        busyAccountId: 'other',
        sendButtonConfigured: true,
        sendMode: 'toolbar',
        canCancelSend: true,
      },
    },
    {
      success: true,
      data: {
        ...setup,
        busy: true,
        busyAccountId: 'xhs',
        sendButtonConfigured: true,
        sendMode: 'toolbar',
        canCancelSend: false,
      },
    },
  ])('does not offer an action when the status does not authorize it', async (response) => {
    invoke.mockResolvedValue(response);
    render(<ReplyBrowserLock accountId='xhs' />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'status' }));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

it('configures the DM column only after the user activates its menu item', async () => {
  invoke.mockResolvedValue({ success: true, data: setup });
  const configure = vi.fn();
  render(<ReplySyncPanel sourceUrl={tableUrl} accounts={accounts} onOpenTable={vi.fn()} onConfigureDm={configure} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'status' }));
  fireEvent.click(screen.getByRole('button', { name: 'common.more' }));
  const action = await screen.findByRole('menuitem', { name: 'common.workbench.dm.configure' });
  expect(configure).not.toHaveBeenCalled();
  fireEvent.click(action);
  expect(configure).toHaveBeenCalledOnce();
});
it('uses the private-message lock and cancellation path without consulting the reply sender', () => {
  const cancel = vi.fn();
  render(<ReplyBrowserLock task='dm-sync' accountId='xhs' onCancelDm={cancel} />);
  expect(screen.getByText('common.workbench.dm.syncing')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.workbench.dm.cancel' }));
  expect(cancel).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
});
