import React from 'react';
import { createPortal } from 'react-dom';
import { Button, Dropdown, Menu, Message } from '@arco-design/web-react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import Workbench from '@/renderer/pages/Workbench';

const { persisted, save, invoke, dmInvoke, browserCallbacks } = vi.hoisted(() => ({
  persisted: { value: '' },
  save: vi.fn(),
  invoke: vi.fn(),
  dmInvoke: vi.fn(),
  browserCallbacks: new Map<
    string,
    {
      onCommentLink?: (token: string) => void;
      onDmLink?: (token: string) => void;
      onAgentReady?: (ready: boolean) => void;
    }
  >(),
}));
vi.mock('@/common/config/configService', () => ({
  configService: {
    whenReady: async () => undefined,
    get: (key: string) => (key === 'workbench.browserAccounts' ? persisted.value : undefined),
    set: async (key: string, value: string) => {
      save(key, value);
      if (key === 'workbench.browserAccounts') persisted.value = value;
    },
  },
}));
vi.mock('@/common/adapter/ipcBridge', () => ({
  application: {
    focusBrowserWebContents: { provider: () => () => {} },
    browserAccountActivity: { on: () => () => {} },
    browserAccountLock: { on: () => () => {} },
    replySync: { invoke },
    dmSync: { invoke: dmInvoke },
  },
}));
vi.mock('@/renderer/pages/Workbench/BrowserPane', () => ({
  default: ({
    accountId,
    partition,
    url,
    ...callbacks
  }: {
    accountId: string;
    partition: string;
    url: string;
    onCommentLink?: (token: string) => void;
    onDmLink?: (token: string) => void;
    onAgentReady?: (ready: boolean) => void;
  }) => {
    browserCallbacks.set(accountId, callbacks);
    return React.createElement('webview', { 'data-testid': `browser-${accountId}`, partition, src: url });
  },
}));
vi.mock('@/renderer/pages/Workbench/ReplySyncPanel', () => ({
  default: ({ onSettingsVisibilityChange }: { onSettingsVisibilityChange?: (visible: boolean) => void }) => {
    const [visible, setVisible] = React.useState(false);
    return (
      <>
        <button
          onClick={() => {
            onSettingsVisibilityChange?.(true);
            setVisible(true);
          }}
        >
          Mock reply settings
        </button>
        {visible &&
          createPortal(
            <button
              onClick={() => {
                setVisible(false);
                onSettingsVisibilityChange?.(false);
              }}
            >
              Close mock reply settings
            </button>,
            document.body
          )}
      </>
    );
  },
  ReplyBrowserLock: () => null,
}));
vi.mock('@/renderer/pages/Workbench/FeishuAuthorization', () => ({ default: () => null }));
vi.mock('@/renderer/pages/Workbench/useRestoreConversation', () => ({ useRestoreConversation: () => {} }));
vi.mock('@/renderer/hooks/system/useDeepLink', () => ({ useDeepLink: () => {} }));
vi.mock('@/renderer/hooks/system/notification/useNotificationClick', () => ({ useNotificationClick: () => {} }));
vi.mock('@/renderer/hooks/system/notification/useBrowserNotification', () => ({ useBrowserNotification: () => {} }));
vi.mock('@/renderer/hooks/system/notification/useDesktopTurnNotification', () => ({
  useDesktopTurnNotification: () => {},
}));
vi.mock('@/renderer/pages/settings/components/SettingsSider', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/context/NavigationHistoryContext', () => ({
  NavigationHistoryProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/renderer/components/layout/WindowControls', () => ({ default: () => null }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true, isMacOS: () => true }));
vi.mock('@/renderer/utils/navigation', () => ({ setGlobalNavigate: () => {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const secondary = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.spyOn(Message, 'error').mockImplementation(() => ({ close: () => {} }));
  dmInvoke.mockReset().mockResolvedValue({
    success: true,
    data: { status: { busy: false, partial: false, feishuConfigured: false }, threads: [] },
  });
  save.mockClear();
  invoke.mockClear();
  browserCallbacks.clear();
  invoke.mockResolvedValue({ success: true, data: { busy: false } });
  persisted.value = JSON.stringify({
    version: 1,
    feishuUrl: 'https://my.feishu.cn/base/test',
    activeId: secondary,
    accounts: [
      {
        id: 'primary',
        name: 'XHS',
        partition: BROWSER_SESSION_PARTITION,
        url: 'https://www.xiaohongshu.com/explore',
        open: true,
      },
      {
        id: secondary,
        name: 'Douyin',
        partition: `persist:workbench-account-${secondary}`,
        url: 'https://www.douyin.com/note/123',
        open: true,
      },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function SettingsFixture() {
  const [showPopup, setShowPopup] = React.useState(false);
  return (
    <div>
      Settings
      <button onClick={() => setShowPopup(true)}>Settings action</button>
      {showPopup &&
        createPortal(
          <button onKeyDown={(event) => event.key === 'Escape' && setShowPopup(false)}>Nested popup action</button>,
          document.body
        )}
    </div>
  );
}
function DropdownSettingsFixture() {
  return (
    <Dropdown
      trigger='click'
      droplist={
        <Menu>
          <Menu.Item key='item'>Nested menu item</Menu.Item>
        </Menu>
      }
    >
      <Button>Open settings menu</Button>
    </Dropdown>
  );
}
function ScheduledFixture() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate('/guid', { state: { prefillPrompt: 'Create a task' } })}>Create via chat</button>
  );
}
function mount() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Workbench />,
        children: [
          { path: 'guid', element: <div>Chat</div> },
          { path: 'settings/agent', element: <SettingsFixture /> },
          { path: 'settings/dropdown', element: <DropdownSettingsFixture /> },
          { path: 'settings/frame', element: <iframe title='Extension settings' /> },
          { path: 'scheduled', element: <ScheduledFixture /> },
        ],
      },
    ],
    { initialEntries: ['/guid'] }
  );
  render(<RouterProvider router={router} />);
  return router;
}
function pointer(target: EventTarget, type: string, clientX: number, buttons = 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, buttons, clientX });
  Object.assign(event, { pointerId: 7, pointerType: 'mouse' });
  fireEvent(target, event);
}
const rect = (left: number, size: number) => ({
  x: left,
  y: 44,
  left,
  right: left + size,
  top: 44,
  bottom: 813,
  width: size,
  height: 769,
  toJSON: () => ({}),
});
function resizeHarness() {
  const divider = screen.getByRole('separator');
  const columns = divider.parentElement!;
  const browserPane = screen.getByRole('region', { name: 'common.workbench.sources' });
  const feishuPane = screen.getByRole('region', { name: 'common.workbench.feishu' });
  const frames: FrameRequestCallback[] = [];
  const width = () =>
    parseFloat(
      columns.style.getPropertyValue('--wb-sources-live-width') || columns.style.getPropertyValue('--wb-sources-width')
    ) || 465;

  vi.spyOn(columns, 'getBoundingClientRect').mockImplementation(() => rect(80, 1514));
  vi.spyOn(browserPane, 'getBoundingClientRect').mockImplementation(() => rect(1594 - width(), width()));
  vi.spyOn(feishuPane, 'getBoundingClientRect').mockImplementation(() => rect(460, 1134 - width() - 8));
  columns.style.columnGap = '8px';
  divider.style.setProperty('--wb-sources-min', '260px');
  divider.style.setProperty('--wb-feishu-min', '360px');
  divider.style.setProperty('--wb-feishu-peek', '16px');
  let captured = false;
  Object.assign(divider, {
    setPointerCapture: () => {
      captured = true;
    },
    releasePointerCapture: () => {
      captured = false;
    },
    hasPointerCapture: () => captured,
  });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  return {
    divider,
    columns,
    browserPane,
    start: () => pointer(divider, 'pointerdown', 1594 - width()),
    move: (x: number) => {
      pointer(window, 'pointermove', x);
      act(() => {
        frames.splice(0).forEach((frame) => frame(0));
      });
    },
    end: (x: number) => pointer(window, 'pointerup', x, 0),
  };
}
describe('expanded account browser', () => {
  it('isolates background browsers and cycles focus inside the settings overlay', async () => {
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    const opener = screen.getByRole('button', { name: 'common.workbench.settings' });
    opener.focus();
    fireEvent.click(opener);
    const back = await screen.findByRole('button', { name: 'common.workbench.backToWorkbench' });
    const last = screen.getByRole('button', { name: 'Settings action' });
    expect(back).toHaveFocus();
    expect(screen.getByRole('region', { name: 'common.workbench.feishu' })).toHaveAttribute('inert');
    expect(screen.getByRole('region', { name: 'common.workbench.sources' })).toHaveAttribute('inert');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(back).toHaveFocus();
    fireEvent.keyDown(back, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Escape' });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.getByTestId(`browser-${secondary}`)).toBeInTheDocument();
  });

  it('isolates background browsers while reply settings are open', async () => {
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    fireEvent.click(screen.getByRole('button', { name: 'Mock reply settings' }));
    expect(screen.getByRole('region', { name: 'common.workbench.chat' })).toHaveAttribute('inert');
    expect(screen.getByRole('region', { name: 'common.workbench.feishu' })).toHaveAttribute('inert');
    expect(screen.getByRole('region', { name: 'common.workbench.sources' })).toHaveAttribute('inert');
  });

  it('keeps a settings popup portaled to the body interactive', async () => {
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    fireEvent.click(screen.getByRole('button', { name: 'common.workbench.settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Settings action' }));
    const popup = screen.getByRole('button', { name: 'Nested popup action' });
    expect(popup.closest('[inert]')).toBeNull();
    popup.focus();
    expect(popup).toHaveFocus();
    fireEvent.keyDown(popup, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'common.workbench.backToWorkbench' })).toBeInTheDocument();
  });

  it('lets Escape close a settings dropdown without leaving settings', async () => {
    const router = mount();
    await screen.findByTestId(`browser-${secondary}`);
    await act(() => router.navigate('/settings/dropdown'));
    const trigger = screen.getByRole('button', { name: 'Open settings menu' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole('menuitem', { name: 'Nested menu item' })).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: 'Escape', keyCode: 27, which: 27 });
    expect(screen.getByRole('button', { name: 'common.workbench.backToWorkbench' })).toBeInTheDocument();
  });

  it('includes an extension iframe in reverse focus traversal and wraps after it', async () => {
    const router = mount();
    await screen.findByTestId(`browser-${secondary}`);
    await act(() => router.navigate('/settings/frame'));
    const back = screen.getByRole('button', { name: 'common.workbench.backToWorkbench' });
    const frame = screen.getByTitle('Extension settings');
    fireEvent.keyDown(back, { key: 'Tab', shiftKey: true });
    expect(frame).toHaveFocus();
    const guard = document.querySelector<HTMLElement>('[data-workbench-focus-guard="end"]');
    expect(guard).not.toBeNull();
    guard!.focus();
    expect(back).toHaveFocus();
  });

  it('focuses a newly opened settings route after a reply modal closes', async () => {
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options) {
      if (!this.closest('[inert]')) focus.call(this, options);
    });
    const router = mount();
    await screen.findByTestId(`browser-${secondary}`);
    fireEvent.click(screen.getByRole('button', { name: 'Mock reply settings' }));
    await act(() => router.navigate('/settings/agent'));
    fireEvent.click(screen.getByRole('button', { name: 'Close mock reply settings' }));
    expect(screen.getByRole('button', { name: 'common.workbench.backToWorkbench' })).toHaveFocus();
  });

  it('returns to the chat panel when a task is created via chat from accounts', async () => {
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    fireEvent.click(screen.getByRole('radio', { name: 'common.workbench.accounts' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.workbench.scheduled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create via chat' }));
    expect(screen.getByRole('radio', { name: 'common.workbench.chat' })).toBeChecked();
    expect(screen.getByText('Chat')).toBeVisible();
  });

  it('does not delete an account that is bound to a reply work', async () => {
    invoke.mockResolvedValue({ success: true, data: { busy: false, works: [{ accountId: secondary }] } });
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    fireEvent.click(screen.getByRole('radio', { name: 'common.workbench.accounts' }));
    const row = screen.getByRole('group', { name: 'Douyin' });
    fireEvent.click(within(row).getByRole('button', { name: 'common.workbench.closeBrowser' }));
    const remove = await within(row).findByRole('button', { name: 'common.delete' });
    fireEvent.click(remove);
    await waitFor(() => expect(Message.error).toHaveBeenCalledWith('common.workbench.boundAccountCannotDelete'));
    expect(JSON.parse(persisted.value).accounts).toHaveLength(2);
  });

  it('asks before deleting an unused account and keeps it on cancel', async () => {
    invoke.mockResolvedValue({ success: true, data: { busy: false, works: [] } });
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    fireEvent.click(screen.getByRole('radio', { name: 'common.workbench.accounts' }));
    const row = screen.getByRole('group', { name: 'Douyin' });
    fireEvent.click(within(row).getByRole('button', { name: 'common.workbench.closeBrowser' }));
    fireEvent.click(await within(row).findByRole('button', { name: 'common.delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'common.workbench.deleteAccountTitle' });
    expect(within(dialog).getByText('common.workbench.deleteAccountDescription')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.cancel' }));
    expect(JSON.parse(persisted.value).accounts).toHaveLength(2);
  });

  it('removes an unused closed account only after confirmation', async () => {
    invoke.mockResolvedValue({ success: true, data: { busy: false, works: [] } });
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    fireEvent.click(screen.getByRole('radio', { name: 'common.workbench.accounts' }));
    const row = screen.getByRole('group', { name: 'Douyin' });
    fireEvent.click(within(row).getByRole('button', { name: 'common.workbench.closeBrowser' }));
    fireEvent.click(await within(row).findByRole('button', { name: 'common.delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'common.workbench.deleteAccountTitle' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(JSON.parse(persisted.value).accounts).toHaveLength(1));
  });

  it('keeps an account when its binding status cannot be read', async () => {
    invoke.mockResolvedValue({ success: false });
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    fireEvent.click(screen.getByRole('radio', { name: 'common.workbench.accounts' }));
    const row = screen.getByRole('group', { name: 'Douyin' });
    fireEvent.click(within(row).getByRole('button', { name: 'common.workbench.closeBrowser' }));
    fireEvent.click(await within(row).findByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(Message.error).toHaveBeenCalledWith('common.workbench.accountBindingCheckFailed'));
    expect(JSON.parse(persisted.value).accounts).toHaveLength(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rechecks binding before confirming account deletion', async () => {
    invoke.mockResolvedValue({ success: true, data: { busy: false, works: [] } });
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    fireEvent.click(screen.getByRole('radio', { name: 'common.workbench.accounts' }));
    const row = screen.getByRole('group', { name: 'Douyin' });
    fireEvent.click(within(row).getByRole('button', { name: 'common.workbench.closeBrowser' }));
    fireEvent.click(await within(row).findByRole('button', { name: 'common.delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'common.workbench.deleteAccountTitle' });
    invoke.mockResolvedValue({ success: true, data: { busy: false, works: [{ accountId: secondary }] } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(Message.error).toHaveBeenCalledWith('common.workbench.boundAccountCannotDelete'));
    expect(JSON.parse(persisted.value).accounts).toHaveLength(2);
  });

  it('expands and restores without remounting any browser, changing its partition or selecting another account', async () => {
    mount();
    const browser = await screen.findByTestId(`browser-${secondary}`);
    const guests = screen.getAllByTestId(/^browser-/);
    const partitions = guests.map((guest) => guest.getAttribute('partition'));
    fireEvent.click(screen.getByRole('button', { name: 'common.workbench.expandBrowser' }));
    expect(screen.getByRole('button', { name: 'common.workbench.restoreColumns' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.queryByRole('separator')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common.workbench.restoreColumns' }));
    expect(screen.getAllByTestId(/^browser-/).every((guest, index) => guest === guests[index])).toBe(true);
    expect(screen.getAllByTestId(/^browser-/).map((guest) => guest.getAttribute('partition'))).toEqual(partitions);
    expect(screen.getByTestId(`browser-${secondary}`)).toBe(browser);
    expect(screen.getByRole('tab', { name: 'Douyin' })).toHaveAttribute('aria-selected', 'true');
    expect(save).not.toHaveBeenCalled();
  });

  it('returns to the three-column layout when settings opens without destroying browser guests', async () => {
    const router = mount();
    const browser = await screen.findByTestId(`browser-${secondary}`);
    fireEvent.click(screen.getByRole('button', { name: 'common.workbench.expandBrowser' }));
    await act(() => router.navigate('/settings/agent'));
    await act(() => router.navigate('/guid'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'common.workbench.expandBrowser' })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    );
    expect(screen.getByTestId(`browser-${secondary}`)).toBe(browser);
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });
  it('leaves a visible Feishu strip across repeated drags and restores the same guests when narrowed', async () => {
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    const guests = screen.getAllByTestId(/^browser-/);
    const drag = resizeHarness();
    drag.start();
    drag.move(300);
    drag.end(300);
    expect(drag.columns.style.getPropertyValue('--wb-sources-width')).toBe('1110px');
    drag.start();
    drag.move(50);
    drag.end(50);
    expect(drag.columns.style.getPropertyValue('--wb-sources-width')).toBe('1110px');
    drag.start();
    drag.move(994);
    drag.end(994);
    expect(drag.columns.style.getPropertyValue('--wb-sources-width')).toBe('600px');
    fireEvent.click(screen.getByRole('button', { name: 'common.workbench.expandBrowser' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.workbench.restoreColumns' }));
    expect(drag.columns.style.getPropertyValue('--wb-sources-width')).toBe('600px');
    expect(screen.getAllByTestId(/^browser-/).every((guest, index) => guest === guests[index])).toBe(true);
  });

  it('resizes the browser with the keyboard and retains the Feishu edge', async () => {
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    const drag = resizeHarness();
    act(() => drag.divider.focus());
    expect(drag.divider).toHaveFocus();
    fireEvent.keyDown(drag.divider, { key: 'ArrowLeft' });
    expect(drag.columns.style.getPropertyValue('--wb-sources-width')).toBe('485px');
    expect(drag.divider).toHaveAttribute('aria-valuenow', '485');
    fireEvent.keyDown(drag.divider, { key: 'End' });
    expect(drag.columns.style.getPropertyValue('--wb-sources-width')).toBe('1110px');
    fireEvent.keyDown(drag.divider, { key: 'Home' });
    expect(drag.columns.style.getPropertyValue('--wb-sources-width')).toBe('260px');
  });

  it.each(['pointercancel', 'blur', 'lostpointercapture'])(
    'clears drag capture and preview after %s without changing the committed width',
    async (eventType) => {
      mount();
      await screen.findByTestId(`browser-${secondary}`);
      const drag = resizeHarness();
      drag.start();
      drag.move(794);
      drag.end(794);
      drag.start();
      drag.move(600);
      expect(drag.columns.style.getPropertyValue('--wb-sources-live-width')).toBe('994px');
      if (eventType === 'blur') fireEvent(window, new Event('blur'));
      else if (eventType === 'lostpointercapture') fireEvent(drag.divider, new Event('lostpointercapture'));
      else pointer(window, 'pointercancel', 600);
      expect(drag.columns.style.getPropertyValue('--wb-sources-live-width')).toBe('');
      expect(drag.columns).not.toHaveAttribute('data-resizing-sources');
      expect(drag.columns.style.getPropertyValue('--wb-sources-width')).toBe('800px');
    }
  );

  it('snaps closed at the right edge and reopens the same browser guests', async () => {
    mount();
    await screen.findByTestId(`browser-${secondary}`);
    const guests = screen.getAllByTestId(/^browser-/);
    const drag = resizeHarness();
    drag.start();
    drag.move(1500);
    drag.end(1500);
    expect(drag.browserPane).toHaveAttribute('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'common.workbench.sources' }));
    expect(drag.browserPane).not.toHaveAttribute('hidden');
    expect(screen.getAllByTestId(/^browser-/).every((guest, index) => guest === guests[index])).toBe(true);
  });
});

describe('comment link account routing', () => {
  const token = 'ab'.repeat(32);
  it('opens an existing closed matching account and waits for main-process registration', async () => {
    const state = JSON.parse(persisted.value);
    state.accounts[1].open = false;
    persisted.value = JSON.stringify(state);
    invoke.mockImplementation(async ({ action }: { action: string }) =>
      action === 'resolve-comment'
        ? { success: true, data: { commentTarget: { accountId: secondary, token } } }
        : { success: true, data: { busy: false } }
    );
    mount();
    const feishu = await screen.findByTestId('browser-feishu');
    expect(browserCallbacks.get('feishu')?.onCommentLink).toBeTypeOf('function');
    act(() => browserCallbacks.get('feishu')?.onCommentLink?.(token));
    await screen.findByTestId(`browser-${secondary}`);
    expect(invoke.mock.calls.some(([request]) => request.action === 'open-comment')).toBe(false);
    act(() => browserCallbacks.get(secondary)?.onAgentReady?.(true));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'open-comment', token }));
    expect(screen.getByTestId('browser-feishu')).toBe(feishu);
    expect(screen.getByRole('tab', { name: 'Douyin' })).toHaveAttribute('aria-selected', 'true');
  });
  it('does not open a browser when a token cannot be resolved against local records', async () => {
    invoke.mockImplementation(async ({ action }: { action: string }) =>
      action === 'resolve-comment'
        ? { success: false, msg: 'replyCommentLinkInvalid' }
        : { success: true, data: { busy: false } }
    );
    mount();
    await screen.findByTestId('browser-feishu');
    expect(browserCallbacks.get('feishu')?.onCommentLink).toBeTypeOf('function');
    act(() => browserCallbacks.get('feishu')?.onCommentLink?.(token));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith({ action: 'resolve-comment', token }));
    expect(save).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([request]) => request.action === 'open-comment')).toBe(false);
  });
});

describe('private message center', () => {
  it('keeps the Feishu guest mounted, inert and unfocused while browsing local private messages', async () => {
    mount();
    const feishu = await screen.findByTestId('browser-feishu');
    const feishuTab = screen.getByRole('tab', { name: 'common.workbench.feishu' });
    const privateTab = screen.getByRole('tab', { name: 'common.workbench.dm.title' });
    fireEvent.keyDown(feishuTab, { key: 'ArrowRight' });
    expect(privateTab).toHaveAttribute('aria-selected', 'true');
    expect(feishu.closest('[inert][aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByTestId('browser-feishu')).toBe(feishu);
    fireEvent.keyDown(privateTab, { key: 'ArrowLeft' });
    expect(feishuTab).toHaveAttribute('aria-selected', 'true');
    expect(feishu.closest('[inert]')).toBeNull();
    expect(dmInvoke.mock.calls.every(([r]) => ['list', 'status', 'thread'].includes(r.action))).toBe(true);
  });
  it('opens an empty local conversation from Feishu without accessing a platform', async () => {
    const thread = {
      key: 'douyin:local:self:peer',
      source: 'comment',
      platform: 'douyin',
      accountId: secondary,
      actorId: 'self',
      contactPlatformId: 'peer',
      contactName: 'Ren',
      lastSender: null,
      lastMessageAt: null,
      commentKeys: ['w:1'],
      lastMessagePreview: '',
      syncState: 'idle',
      watermark: null,
    };
    const base = { status: { busy: false, partial: false, feishuConfigured: false }, threads: [thread] };
    dmInvoke.mockImplementation(async ({ action }) => ({
      success: true,
      data: {
        ...base,
        ...(action === 'resolve-dm-link' ? { resolvedKey: thread.key } : {}),
        ...(action === 'thread'
          ? {
              detail: {
                thread,
                messages: [],
                comments: [{ key: 'w:1', token: 'tok', content: 'Original message', workTitle: 'Post', createdAt: 1 }],
              },
            }
          : {}),
      },
    }));
    mount();
    const guest = await screen.findByTestId('browser-feishu');
    fireEvent.click(screen.getByRole('button', { name: 'common.workbench.expandBrowser' }));
    await act(async () => browserCallbacks.get('feishu')?.onDmLink?.('opaque-token'));
    expect(await screen.findByRole('button', { name: 'common.workbench.dm.update' })).toBeInTheDocument();
    expect(screen.getByTestId('browser-feishu')).toBe(guest);
    expect(screen.getByRole('tab', { name: 'common.workbench.dm.title' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'common.workbench.expandBrowser' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.workbench.dm.original' })).toBeInTheDocument();
    expect(dmInvoke.mock.calls.some(([r]) => r.action.startsWith('sync-'))).toBe(false);
  });
});
