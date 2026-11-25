import { flushSync } from 'react-dom';
import { focusAccountBrowser } from './focusAccountBrowser';
import { configService } from '@/common/config/configService';
import * as ipcBridge from '@/common/adapter/ipcBridge';
import { AccountRepository } from './accountRepository';
import { useDeepLink } from '@/renderer/hooks/system/useDeepLink';
import { useNotificationClick } from '@/renderer/hooks/system/notification/useNotificationClick';
import { useBrowserNotification } from '@/renderer/hooks/system/notification/useBrowserNotification';
import { useDesktopTurnNotification } from '@/renderer/hooks/system/notification/useDesktopTurnNotification';
import SettingsSider from '@/renderer/pages/settings/components/SettingsSider';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Button, Modal, Radio, Message, Tooltip } from '@arco-design/web-react';
import {
  Plus,
  CalendarDays,
  SlidersHorizontal,
  ArrowLeft,
  PanelsTopLeft,
  ChevronsLeft,
  ChevronsRight,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { NavigationHistoryProvider } from '@/renderer/hooks/context/NavigationHistoryContext';
import WindowControls from '@/renderer/components/layout/WindowControls';
import { isElectronDesktop, isMacOS } from '@/renderer/utils/platform';
import { setGlobalNavigate } from '@/renderer/utils/navigation';
import { useRestoreConversation } from './useRestoreConversation';
import AccountPanel from './AccountPanel';
import FeishuAuthorization from './FeishuAuthorization';
import ReplySyncPanel, { ReplyBrowserLock } from './ReplySyncPanel';
import { replyErrorKey } from './ReplySyncPanel/errorMessages';
import BrowserPane from './BrowserPane';
import DirectMessages from './DirectMessages';
import { CenterTabs, DmToolbar, type CenterTab } from './DirectMessages/CenterTabs';
import { useDirectMessages } from './DirectMessages/useDirectMessages';
import { dmErrorKey, isWaiting } from './DirectMessages/presentation';
import type { AccountTask } from '@/common/types/platform/workbenchDm';
import { type AccountStore, FEISHU_PARTITION, validBrowserUrl, type WorkbenchState } from './accountStore';
import styles from './Workbench.module.css';

const focusableSelector = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');
const focusGuardStyle: React.CSSProperties = {
  position: 'fixed',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
};

function overlayFocusableElements(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    if (element.tabIndex < 0 || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let node: HTMLElement | null = element; node && container.contains(node); node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  });
  return candidates
    .filter((element) => {
      if (!(element instanceof HTMLInputElement) || element.type !== 'radio' || !element.name) return true;
      const group = candidates.filter(
        (item): item is HTMLInputElement =>
          item instanceof HTMLInputElement &&
          item.type === 'radio' &&
          item.name === element.name &&
          item.form === element.form
      );
      return element === (group.find((item) => item.checked) ?? group[0]);
    })
    .toSorted((a, b) => (a.tabIndex || Number.POSITIVE_INFINITY) - (b.tabIndex || Number.POSITIVE_INFINITY));
}

function focusOverlayEdge(guard: HTMLElement, first: boolean) {
  const container = guard.parentElement;
  if (!container) return;
  const candidates = overlayFocusableElements(container);
  ((first ? candidates[0] : candidates[candidates.length - 1]) ?? container).focus();
}

/** Keep keyboard traversal in the route overlay while allowing its portaled popups to manage their own focus. */
function handleOverlayKeyDown(event: React.KeyboardEvent<HTMLElement>, close: () => void) {
  const container = event.currentTarget;
  if (event.defaultPrevented || !(event.target instanceof Node) || !container.contains(event.target)) return;
  if (event.key === 'Escape') {
    const popupOpen = Array.from(document.querySelectorAll<HTMLElement>('.arco-trigger')).some((popup) => {
      const style = getComputedStyle(popup);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (popupOpen) return;
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const candidates = overlayFocusableElements(container);
  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  if (!first || !last) {
    event.preventDefault();
    container.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Persistent browser shell: route changes never own account or browser lifetimes. */
export default function Workbench() {
  useEffect(
    () =>
      ipcBridge.application.focusBrowserWebContents.provider(({ webContentsId }) =>
        focusAccountBrowser(webContentsId, async (accountId) => {
          if (!store.current) throw new Error('Account store unavailable');
          const next = await store.current.change((s) => s.select(accountId));
          flushSync(() => {
            setState(next);
            setSourcesCollapsed(false);
          });
        })
      ),
    []
  );
  const { t } = useTranslation();
  useRestoreConversation();
  useDeepLink();
  useNotificationClick();
  useBrowserNotification();
  useDesktopTurnNotification();
  const navigate = useNavigate();
  const location = useLocation();
  const store = useRef<AccountRepository | null>(null);
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [storageError, setStorageError] = useState(false);
  const readyAccounts = useRef(new Set<string>());
  const browserReadyWaiters = useRef(new Map<string, () => void>());
  const openingComment = useRef(false);
  const [section, setSection] = useState('chat');
  const [replySettingsOpen, setReplySettingsOpen] = useState(false);
  const [accountToRemove, setAccountToRemove] = useState<{ id: string; origin: HTMLElement | null } | null>(null);
  const [removeVisible, setRemoveVisible] = useState(false);
  const [removePending, setRemovePending] = useState(false);
  const checkingRemoval = useRef(false);
  const sectionSwitcher = useRef<HTMLDivElement>(null);
  const [operatingAccounts, setOperatingAccounts] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(
    () =>
      ipcBridge.application.browserAccountActivity.on(({ accountId, operating }) => {
        setOperatingAccounts((previous) => {
          if (previous.has(accountId) === operating) return previous;
          const next = new Set(previous);
          if (operating) next.add(accountId);
          else next.delete(accountId);
          return next;
        });
      }),
    []
  );
  const dm = useDirectMessages(isElectronDesktop());
  const { refreshLocal } = dm;
  const [lockTasks, setLockTasks] = useState<ReadonlyMap<string, AccountTask>>(() => new Map());
  useEffect(() => {
    let disposed = false;
    const observed = new Set<string>();
    const record = (id: string, task?: AccountTask) => {
      setLockTasks((previous) => {
        const next = new Map(previous);
        if (task) next.set(id, task);
        else next.delete(id);
        return next;
      });
    };
    const unsubscribe = ipcBridge.application.browserAccountLock.on(({ accountId, locked, task }) => {
      observed.add(accountId);
      record(accountId, locked ? task || 'comment-sync' : undefined);
      if (!locked && isElectronDesktop()) refreshLocal();
    });
    // Recover leases on renderer reload; newer per-account events always win.
    const recover = (id: string | undefined, task: AccountTask) => {
      if (!disposed && id && !observed.has(id)) record(id, task);
    };
    void ipcBridge.application.replySync
      .invoke({ action: 'status' })
      .then((res) => {
        if (res.success) recover(res.data?.busyAccountId, res.data?.canCancelSend ? 'comment-send' : 'comment-sync');
      })
      .catch(() => {});
    if (isElectronDesktop()) {
      void ipcBridge.application.dmSync
        .invoke({ action: 'status' })
        .then((res) => {
          if (res.success) recover(res.data?.status.busyAccountId, 'dm-sync');
        })
        .catch(() => {});
    }
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [refreshLocal]);
  const lockedAccounts = new Set(lockTasks.keys());
  const [centerTab, setCenterTab] = useState<CenterTab>('feishu');
  const [dmLink, setDmLink] = useState<{ key: string; sequence: number }>();
  const [dmVisited, setDmVisited] = useState(false);
  const linkSequence = useRef(0);
  const feishuLayer = useRef<HTMLDivElement>(null);
  const dmLayer = useRef<HTMLDivElement>(null);
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [sourcesWidth, setSourcesWidth] = useState<number>();
  const [sourcesResizing, setSourcesResizing] = useState(false);
  const [sourceRange, setSourceRange] = useState<{ min: number; max: number; width: number }>();
  const sourcesDrag = useRef<AbortController | null>(null);
  useEffect(() => () => sourcesDrag.current?.abort(), []);
  const feishuPane = useRef<HTMLElement>(null);
  const sourcesPane = useRef<HTMLElement>(null);
  const lastChat = useRef('/guid');
  const lastWorkbenchFocus = useRef<HTMLElement | null>(null);
  const overlayBack = useRef<HTMLButtonElement | null>(null);
  const previousAuxiliary = useRef(false);
  const previousOverlayInteractive = useRef(false);
  const auxiliary =
    !location.pathname.startsWith('/conversation/') && location.pathname !== '/guid' && location.pathname !== '/';
  const backgroundInert = auxiliary || replySettingsOpen || Boolean(accountToRemove);
  useLayoutEffect(() => {
    const overlayInteractive = auxiliary && !replySettingsOpen && !accountToRemove;
    if (overlayInteractive && !previousOverlayInteractive.current) overlayBack.current?.focus();
    if (!auxiliary && previousAuxiliary.current && !replySettingsOpen && !accountToRemove) {
      const target = lastWorkbenchFocus.current;
      if (target?.isConnected && !target.closest('[inert], [hidden]')) target.focus();
    }
    previousAuxiliary.current = auxiliary;
    previousOverlayInteractive.current = overlayInteractive;
  }, [auxiliary, replySettingsOpen, accountToRemove]);
  useEffect(() => {
    if (auxiliary || sourcesCollapsed) setSourcesExpanded(false);
  }, [auxiliary, sourcesCollapsed]);
  const load = async () => {
    try {
      await configService.whenReady();
      store.current = new AccountRepository({
        load: async () =>
          configService.get('workbench.browserAccounts') ?? localStorage.getItem('workbench.browser-accounts.v1'),
        save: async (value) => {
          const previous = configService.get('workbench.browserAccounts');
          try {
            await configService.set('workbench.browserAccounts', value);
          } catch (error) {
            configService.setLocal('workbench.browserAccounts', previous);
            throw error;
          }
        },
      });
      const restored = await store.current.read();
      if (!configService.get('workbench.browserAccounts') && localStorage.getItem('workbench.browser-accounts.v1')) {
        await store.current.change((s) => s.read());
      }
      setState(restored);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    setGlobalNavigate(navigate);
    return () => setGlobalNavigate(null);
  }, [navigate]);
  useEffect(() => {
    if (location.pathname.startsWith('/conversation/')) {
      lastChat.current = location.pathname;
      void configService
        .set('workbench.lastConversation', location.pathname.slice('/conversation/'.length))
        .catch(() => {
          Message.error(t('common.workbench.saveError'));
        });
    }
  }, [location.pathname]);
  useEffect(() => {
    const navigation = location.state as { prefillPrompt?: unknown } | null;
    if (location.pathname === '/guid' && typeof navigation?.prefillPrompt === 'string') setSection('chat');
  }, [location.key, location.pathname, location.state]);
  const change = async (operation: (s: AccountStore) => WorkbenchState): Promise<boolean> => {
    try {
      if (!store.current) return false;
      setState(await store.current.change(operation));
      return true;
    } catch {
      Message.error(t('common.workbench.saveError'));
      return false;
    }
  };
  const canRemoveAccount = async (id: string): Promise<boolean> => {
    try {
      const response = await ipcBridge.application.replySync.invoke({ action: 'status' });
      if (!response.success || !response.data) throw new Error('status unavailable');
      if (response.data.works.some((work) => work.accountId === id)) {
        Message.error(t('common.workbench.boundAccountCannotDelete'));
        return false;
      }
      if (response.data.busyAccountId === id || lockedAccounts.has(id)) {
        Message.error(t('common.workbench.replySync.errors.replyBrowserBusy'));
        return false;
      }
      return true;
    } catch {
      Message.error(t('common.workbench.accountBindingCheckFailed'));
      return false;
    }
  };
  const requestRemoveAccount = async (id: string, origin: HTMLElement | null) => {
    if (checkingRemoval.current || accountToRemove) return;
    checkingRemoval.current = true;
    try {
      if (!(await canRemoveAccount(id))) return;
      setAccountToRemove({ id, origin });
      setRemoveVisible(true);
    } finally {
      checkingRemoval.current = false;
    }
  };
  const confirmRemoveAccount = async () => {
    if (!accountToRemove || removePending) return;
    setRemovePending(true);
    try {
      if (await canRemoveAccount(accountToRemove.id)) {
        await change((accounts) => {
          const account = accounts.read().accounts.find((item) => item.id === accountToRemove.id);
          if (!account || account.open) throw new Error('Account must be closed');
          return accounts.remove(accountToRemove.id);
        });
      }
    } finally {
      setRemovePending(false);
      setRemoveVisible(false);
    }
  };
  const openAccount = (id: string) => {
    setSourcesCollapsed(false);
    void change((s) => s.select(id));
  };
  const openCommentLink = async (token: string, fromDm = false) => {
    if (openingComment.current) return;
    openingComment.current = true;
    try {
      const resolved = await ipcBridge.application.replySync.invoke({
        action: 'resolve-comment',
        token,
        ...(fromDm ? { fromDm: true } : {}),
      });
      if (!resolved.success) throw new Error(resolved.msg || 'replyCommentLinkInvalid');
      const target = resolved.data?.commentTarget;
      if (!target || target.token !== token || !store.current) throw new Error('replyCommentLinkInvalid');
      const current = await store.current.read();
      if (!current.accounts.some((account) => account.id === target.accountId)) throw new Error('replyBrowserClosed');
      const selected = await store.current.change((accounts) => accounts.select(target.accountId));
      flushSync(() => {
        setState(selected);
        setSourcesCollapsed(false);
      });
      if (!readyAccounts.current.has(target.accountId)) {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            browserReadyWaiters.current.delete(target.accountId);
            reject(new Error('replyBrowserClosed'));
          }, 15_000);
          browserReadyWaiters.current.set(target.accountId, () => {
            window.clearTimeout(timer);
            browserReadyWaiters.current.delete(target.accountId);
            resolve();
          });
        });
      }
      const located = await ipcBridge.application.replySync.invoke({
        action: 'open-comment',
        token,
        ...(fromDm ? { fromDm: true } : {}),
      });
      if (!located.success) throw new Error(located.msg || 'replyTargetUnavailable');
    } catch (error) {
      Message.error(t(replyErrorKey(error instanceof Error ? error.message : undefined)));
    } finally {
      openingComment.current = false;
    }
  };
  const focusDmPanel = () => {
    const back = dmLayer.current?.querySelector<HTMLButtonElement>('[data-dm-back]');
    if (back?.getClientRects().length) back.focus({ preventScroll: true });
    else dmLayer.current?.focus({ preventScroll: true });
  };
  const switchCenterTab = (tab: CenterTab) => {
    if (tab === 'dm') {
      const previous = document.activeElement;
      const transferFocus = previous instanceof HTMLElement && feishuLayer.current?.contains(previous);
      if (transferFocus) previous.blur();
      setDmVisited(true);
      if (centerTab !== 'dm') dm.refreshLocal();
      if (transferFocus) requestAnimationFrame(focusDmPanel);
    }
    setCenterTab(tab);
  };
  const openDmLink = async (token: string) => {
    const sequence = ++linkSequence.current;
    const response = await dm.request({ action: 'resolve-dm-link', token });
    if (sequence !== linkSequence.current) return;
    if (!response?.resolvedKey) {
      Message.error(t(dmErrorKey('dmLinkInvalid')));
      return;
    }
    const center = feishuPane.current,
      right = sourcesPane.current;
    const available =
      center?.parentElement &&
      center.parentElement.getBoundingClientRect().right - center.getBoundingClientRect().left - 8;
    const visibleCenter =
      center && right
        ? Math.min(
            center.getBoundingClientRect().width,
            right.getBoundingClientRect().left - center.getBoundingClientRect().left - 8
          )
        : undefined;
    if (
      available &&
      available > 0 &&
      (sourcesExpanded || (visibleCenter !== undefined && visibleCenter < 460)) &&
      !sourcesCollapsed
    ) {
      const leaveForCenter = Math.floor(available - 500 - 8);
      const min = parseFloat(getComputedStyle(right!).getPropertyValue('--wb-sources-min')) || 260;
      if (leaveForCenter < min) setSourcesCollapsed(true);
      else setSourcesWidth(leaveForCenter);
    }
    setSourcesExpanded(false);
    switchCenterTab('dm');
    void dm.select(response.resolvedKey);
    setDmLink({ key: response.resolvedKey, sequence });
    requestAnimationFrame(focusDmPanel);
  };
  const addAccount = (name = '') => {
    setSourcesCollapsed(false);
    return change((s) => s.add(name, t('common.workbench.defaultAccountName')));
  };
  const getSourceRange = (divider: HTMLDivElement) => {
    const columns = divider.parentElement;
    if (!columns || !sourcesPane.current || !feishuPane.current) return undefined;
    const layout = getComputedStyle(divider);
    const min = parseFloat(layout.getPropertyValue('--wb-sources-min'));
    const peek = parseFloat(layout.getPropertyValue('--wb-feishu-peek'));
    const gap = parseFloat(getComputedStyle(columns).columnGap);
    if (![min, peek, gap].every(Number.isFinite)) return undefined;
    const right = sourcesPane.current.getBoundingClientRect();
    return {
      min,
      max: Math.max(min, right.right - feishuPane.current.getBoundingClientRect().left - gap - peek),
      width: right.width,
    };
  };
  const resizeSourcesWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const range = getSourceRange(event.currentTarget);
    if (!range) return;
    event.preventDefault();
    const step = event.shiftKey ? 100 : 20;
    const requested =
      event.key === 'Home'
        ? range.min
        : event.key === 'End'
          ? range.max
          : range.width + (event.key === 'ArrowLeft' ? step : -step);
    const width = Math.max(range.min, Math.min(range.max, requested));
    setSourcesWidth(width);
    setSourceRange({ ...range, width });
  };
  const startSourcesResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const divider = event.currentTarget;
    const columns = divider.parentElement;
    if (event.button !== 0 || sourcesDrag.current || !columns || !sourcesPane.current || !feishuPane.current) return;
    const range = getSourceRange(divider);
    if (!range) return;
    const { min, max, width } = range;
    event.preventDefault();
    const { pointerId, clientX: startX } = event;
    const drag = new AbortController();
    const options = { capture: true, signal: drag.signal };
    const widthAt = (clientX: number) => Math.min(max, width + startX - clientX);
    let preview = width;
    let frame: number | undefined;
    drag.signal.addEventListener('abort', () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      columns.style.removeProperty('--wb-sources-live-width');
      delete columns.dataset.sourcesSnap;
    });
    const finish = (nextWidth?: number) => {
      drag.abort();
      sourcesDrag.current = null;
      if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId);
      setSourcesResizing(false);
      if (nextWidth === undefined) return;
      if (nextWidth < min) setSourcesCollapsed(true);
      else {
        setSourcesWidth(nextWidth);
        setSourceRange({ min, max, width: nextWidth });
      }
    };
    sourcesDrag.current = drag;
    divider.setPointerCapture(pointerId);
    setSourcesResizing(true);
    // Electron guests can consume the final event. Recover on mouseup or the next unpressed move.
    window.addEventListener(
      'pointermove',
      (move) => {
        if (move.pointerId !== pointerId) return;
        if (move.pointerType === 'mouse' && move.buttons === 0) {
          finish(widthAt(move.clientX));
          return;
        }
        preview = widthAt(move.clientX);
        if (frame !== undefined) return;
        // Move the columns at most once per frame without rerendering the workbench.
        frame = requestAnimationFrame(() => {
          frame = undefined;
          columns.toggleAttribute('data-sources-snap', preview < min);
          columns.style.setProperty('--wb-sources-live-width', `${Math.max(min, preview)}px`);
        });
      },
      options
    );
    window.addEventListener(
      'pointerup',
      (up) => {
        if (up.pointerId === pointerId) finish(widthAt(up.clientX));
      },
      options
    );
    window.addEventListener(
      'mouseup',
      (up) => {
        if (up.button === 0) finish(widthAt(up.clientX));
      },
      options
    );
    window.addEventListener(
      'pointercancel',
      (cancel) => {
        if (cancel.pointerId === pointerId) finish();
      },
      options
    );
    divider.addEventListener('lostpointercapture', () => finish(), options);
    window.addEventListener('blur', () => finish(), options);
  };
  const openAccounts = state?.accounts.filter((a) => a.open) ?? [];
  const activeId = openAccounts.some((a) => a.id === state?.activeId) ? state?.activeId : openAccounts[0]?.id;
  return (
    <LayoutContext.Provider
      value={{ isMobile: false, siderCollapsed: true, setSiderCollapsed: () => {}, workbench: true }}
    >
      <NavigationHistoryProvider>
        <div className={styles.shell}>
          <header className={styles.titlebar} inert={backgroundInert || undefined}>
            <span>{t('common.workbench.title')}</span>
            {!isMacOS() && <WindowControls />}
          </header>
          <div
            className={`${styles.columns}${sourcesCollapsed ? ` ${styles.sourcesCollapsed}` : ''}${sourcesExpanded ? ` ${styles.sourcesExpanded}` : ''}`}
            data-sources-expanded={sourcesExpanded || undefined}
            data-resizing-sources={sourcesResizing || undefined}
            onFocusCapture={(event) => {
              if (!backgroundInert && event.target instanceof HTMLElement && event.currentTarget.contains(event.target))
                lastWorkbenchFocus.current = event.target;
            }}
            style={
              sourcesWidth === undefined
                ? undefined
                : ({ '--wb-sources-width': `${sourcesWidth}px` } as React.CSSProperties)
            }
          >
            <section
              className={styles.left}
              aria-label={t('common.workbench.chat')}
              aria-hidden={sourcesExpanded || undefined}
              inert={backgroundInert || sourcesExpanded || undefined}
            >
              <div className={styles.switcher} ref={sectionSwitcher}>
                <Radio.Group
                  type='button'
                  value={section}
                  onChange={setSection}
                  options={[
                    { label: t('common.workbench.chat'), value: 'chat' },
                    { label: t('common.workbench.accounts'), value: 'accounts' },
                  ]}
                />
              </div>
              {storageError && (
                <div className={styles.error} role='alert'>
                  {t('common.workbench.storageError')}
                  <Button onClick={load}>{t('common.workbench.retry')}</Button>
                </div>
              )}
              <div className={styles.leftBody} hidden={section !== 'chat' || auxiliary}>
                {!auxiliary && <Outlet />}
              </div>
              {section === 'accounts' && state && (
                <AccountPanel
                  accounts={state.accounts}
                  activeId={activeId}
                  operatingAccounts={operatingAccounts}
                  lockedAccounts={lockedAccounts}
                  onAdd={addAccount}
                  onRename={(id, name) => change((s) => s.update(id, { name }))}
                  onOpen={openAccount}
                  onRemove={(id, origin) => void requestRemoveAccount(id, origin)}
                  onClose={(id) => {
                    void change((s) => s.update(id, { open: false }));
                  }}
                />
              )}
              <footer className={styles.footer}>
                <Button
                  type='text'
                  icon={<CalendarDays size={18} strokeWidth={1.8} />}
                  onClick={(event) => {
                    if (event.currentTarget instanceof HTMLElement) lastWorkbenchFocus.current = event.currentTarget;
                    void navigate('/scheduled');
                  }}
                >
                  {t('common.workbench.scheduled')}
                </Button>
                <Button
                  type='text'
                  icon={<SlidersHorizontal size={18} strokeWidth={1.8} />}
                  onClick={(event) => {
                    if (event.currentTarget instanceof HTMLElement) lastWorkbenchFocus.current = event.currentTarget;
                    void navigate('/settings/agent');
                  }}
                >
                  {t('common.workbench.settings')}
                </Button>
              </footer>
            </section>
            <section
              ref={feishuPane}
              className={styles.center}
              aria-label={t('common.workbench.feishu')}
              aria-hidden={sourcesExpanded || undefined}
              inert={backgroundInert || sourcesExpanded || undefined}
            >
              <div className={styles.paneHeader}>
                <CenterTabs
                  tab={centerTab}
                  onChange={switchCenterTab}
                  count={dm.snapshot?.threads.filter(isWaiting).length ?? 0}
                />
                <div className={styles.centerTools}>
                  <div className={styles.feishuTools} hidden={centerTab !== 'feishu'}>
                    {state && isElectronDesktop() && (
                      <ReplySyncPanel
                        sourceUrl={state.feishuUrl}
                        accounts={openAccounts}
                        onSettingsVisibilityChange={setReplySettingsOpen}
                        onConfigureDm={async () => {
                          const result = await dm.run({ action: 'configure-feishu' });
                          if (result?.status.feishuConfigured && !result.status.error)
                            Message.success(t('common.workbench.dm.configured'));
                          else Message.error(t(dmErrorKey(result?.status.error || 'dmFeishuFailed')));
                        }}
                        dmBusy={Boolean(dm.pending || dm.snapshot?.status.busy)}
                        onOpenTable={(url) => {
                          void change((s) => s.setFeishuUrl(url));
                        }}
                      />
                    )}
                  </div>
                  {centerTab === 'dm' && <DmToolbar model={dm} />}
                </div>
                <span className={styles.headerDivider} aria-hidden />
                <Button
                  type='text'
                  size='small'
                  icon={
                    sourcesCollapsed ? (
                      <ChevronsLeft size={16} strokeWidth={1.8} />
                    ) : (
                      <ChevronsRight size={16} strokeWidth={1.8} />
                    )
                  }
                  aria-label={t('common.workbench.sources')}
                  aria-controls='workbench-source-browsers'
                  aria-expanded={!sourcesCollapsed}
                  title={t(sourcesCollapsed ? 'common.expand' : 'common.collapse')}
                  onClick={() => setSourcesCollapsed((collapsed) => !collapsed)}
                />
              </div>
              <div className={styles.centerBody}>
                <div
                  id='wb-center-feishu'
                  role='tabpanel'
                  aria-labelledby='wb-tab-feishu'
                  ref={feishuLayer}
                  className={styles.centerBrowserLayer}
                  hidden={centerTab !== 'feishu'}
                  inert={centerTab !== 'feishu' || undefined}
                  aria-hidden={centerTab !== 'feishu' || undefined}
                >
                  {state && isElectronDesktop() && (
                    <BrowserPane
                      url={state.feishuUrl}
                      partition={FEISHU_PARTITION}
                      agentControl
                      accountId='feishu'
                      onDmLink={(token) => void openDmLink(token)}
                      onCommentLink={(token) => void openCommentLink(token)}
                      accountName={t('common.workbench.feishu')}
                      onUrlChange={(url) => {
                        if (url !== state.feishuUrl && validBrowserUrl(url)) void change((s) => s.setFeishuUrl(url));
                      }}
                    />
                  )}
                  {!isElectronDesktop() && <p className={styles.accounts}>{t('common.workbench.desktopOnly')}</p>}
                </div>
                <div
                  id='wb-center-dm'
                  role='tabpanel'
                  aria-labelledby='wb-tab-dm'
                  ref={dmLayer}
                  tabIndex={-1}
                  className={styles.centerDmLayer}
                  hidden={centerTab !== 'dm'}
                  inert={centerTab !== 'dm' || undefined}
                >
                  {dmVisited &&
                    (isElectronDesktop() ? (
                      <DirectMessages
                        model={dm}
                        accounts={state?.accounts ?? []}
                        lockedAccounts={lockedAccounts}
                        syncingAccounts={
                          new Set([...lockTasks].filter(([, task]) => task === 'dm-sync').map(([id]) => id))
                        }
                        link={dmLink}
                        onAccount={openAccount}
                        onComment={(token) => void openCommentLink(token, true)}
                      />
                    ) : (
                      <p className={styles.accounts}>{t('common.workbench.desktopOnly')}</p>
                    ))}
                </div>
              </div>
            </section>
            <section
              id='workbench-source-browsers'
              ref={sourcesPane}
              className={styles.right}
              aria-label={t('common.workbench.sources')}
              hidden={sourcesCollapsed}
              inert={backgroundInert || undefined}
            >
              <div className={styles.tabs}>
                <div className={styles.tabList} role='tablist' aria-label={t('common.workbench.accounts')}>
                  {openAccounts.map((account) => (
                    <div
                      key={account.id}
                      className={styles.browserTab}
                      data-active={account.id === activeId}
                      data-operating={operatingAccounts.has(account.id)}
                      role='presentation'
                    >
                      <Button
                        role='tab'
                        aria-selected={account.id === activeId}
                        className={account.id === activeId ? styles.activeTab : ''}
                        type='text'
                        onClick={() => openAccount(account.id)}
                      >
                        {account.name || t('common.workbench.mainAccount')}
                      </Button>
                      <Tooltip disabled={!lockedAccounts.has(account.id)} content={t('common.workbench.dm.busy')}>
                        <span
                          className={styles.closeTab}
                          title={lockedAccounts.has(account.id) ? t('common.workbench.dm.busy') : undefined}
                        >
                          <Button
                            type='text'
                            size='mini'
                            icon={<X size={14} strokeWidth={1.8} />}
                            title={t('common.workbench.closeBrowser')}
                            aria-label={`${t('common.workbench.closeBrowser')} ${account.name || t('common.workbench.mainAccount')}`}
                            disabled={lockedAccounts.has(account.id)}
                            onClick={() => void change((s) => s.update(account.id, { open: false }))}
                          />
                        </span>
                      </Tooltip>
                    </div>
                  ))}
                </div>
                <div className={styles.tabActions}>
                  <Button
                    type='text'
                    icon={<Plus size={16} strokeWidth={1.8} />}
                    aria-label={t('common.workbench.addAccount')}
                    onClick={() => void addAccount()}
                  />
                  <Button
                    type='text'
                    className={styles.expandBrowser}
                    icon={
                      sourcesExpanded ? (
                        <Minimize2 size={16} strokeWidth={1.8} />
                      ) : (
                        <Maximize2 size={16} strokeWidth={1.8} />
                      )
                    }
                    title={t(sourcesExpanded ? 'common.workbench.restoreColumns' : 'common.workbench.expandBrowser')}
                    aria-label={t(
                      sourcesExpanded ? 'common.workbench.restoreColumns' : 'common.workbench.expandBrowser'
                    )}
                    aria-pressed={sourcesExpanded}
                    aria-controls='workbench-source-browsers'
                    onClick={() => setSourcesExpanded((expanded) => !expanded)}
                  />
                </div>
              </div>
              <div className={styles.browserStack}>
                {state && openAccounts.length === 0 && (
                  <div className={styles.noBrowsers}>
                    <PanelsTopLeft size={24} strokeWidth={1.8} />
                    <strong>{t('common.workbench.dm.emptyBrowsers')}</strong>
                    <small>{t('common.workbench.dm.emptyBrowserHint')}</small>
                  </div>
                )}
                {state &&
                  isElectronDesktop() &&
                  openAccounts.map((account) => (
                    <div
                      key={account.id}
                      data-workbench-account-id={account.id}
                      className={styles.browserLayer}
                      inert={sourcesCollapsed || account.id !== activeId || undefined}
                      hidden={sourcesCollapsed || account.id !== activeId}
                    >
                      <BrowserPane
                        url={account.url}
                        partition={account.partition}
                        agentControl
                        accountId={account.id}
                        locked={lockedAccounts.has(account.id)}
                        onAgentReady={(ready) => {
                          if (ready) {
                            readyAccounts.current.add(account.id);
                            browserReadyWaiters.current.get(account.id)?.();
                          } else readyAccounts.current.delete(account.id);
                        }}
                        accountName={account.name}
                        onUrlChange={(url) => {
                          if (url !== account.url && validBrowserUrl(url))
                            void change((s) => s.update(account.id, { url }));
                        }}
                      />
                      {lockedAccounts.has(account.id) && (
                        <ReplyBrowserLock
                          accountId={account.id}
                          task={
                            lockTasks.get(account.id) ??
                            (dm.snapshot?.status.busyAccountId === account.id ? 'dm-sync' : undefined)
                          }
                          onCancelDm={() => void dm.run({ action: 'cancel' })}
                        />
                      )}
                    </div>
                  ))}
              </div>
            </section>
            {!sourcesCollapsed && !sourcesExpanded && (
              <div
                className={styles.sourcesDivider}
                role='separator'
                aria-orientation='vertical'
                aria-label={t('common.workbench.sources')}
                aria-controls='workbench-source-browsers'
                aria-valuemin={sourceRange?.min}
                aria-valuemax={sourceRange?.max}
                aria-valuenow={sourceRange?.width}
                tabIndex={0}
                inert={backgroundInert || undefined}
                onFocus={(event) => setSourceRange(getSourceRange(event.currentTarget))}
                onKeyDown={resizeSourcesWithKeyboard}
                onPointerDown={startSourcesResize}
              />
            )}
            {auxiliary && (
              <section
                className={styles.routeOverlay}
                inert={replySettingsOpen || Boolean(accountToRemove) || undefined}
                tabIndex={-1}
                onKeyDown={(event) => handleOverlayKeyDown(event, () => void navigate(lastChat.current))}
              >
                <span
                  aria-hidden='true'
                  data-workbench-focus-guard='start'
                  tabIndex={0}
                  style={focusGuardStyle}
                  onFocus={(event) => focusOverlayEdge(event.currentTarget, false)}
                />
                <div className={styles.overlayHeader}>
                  <Button
                    type='text'
                    ref={overlayBack}
                    icon={<ArrowLeft size={16} strokeWidth={1.8} />}
                    onClick={() => void navigate(lastChat.current)}
                  >
                    {t('common.workbench.backToWorkbench')}
                  </Button>
                </div>
                <div className={styles.routeBody}>
                  {location.pathname.startsWith('/settings') && (
                    <aside className={styles.settingsNav}>
                      <SettingsSider collapsed={false} tooltipEnabled={false} />
                    </aside>
                  )}
                  <div className={styles.routeContent}>
                    {location.pathname.startsWith('/settings') && <FeishuAuthorization />}
                    <Outlet />
                  </div>
                </div>
                <span
                  aria-hidden='true'
                  data-workbench-focus-guard='end'
                  tabIndex={0}
                  style={focusGuardStyle}
                  onFocus={(event) => focusOverlayEdge(event.currentTarget, true)}
                />
              </section>
            )}
          </div>
          <Modal
            visible={removeVisible}
            title={t('common.workbench.deleteAccountTitle')}
            okText={t('common.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ status: 'danger' }}
            cancelButtonProps={{ disabled: removePending }}
            confirmLoading={removePending}
            maskClosable={!removePending}
            escToExit={!removePending}
            focusLock
            autoFocus
            unmountOnExit
            onOk={() => void confirmRemoveAccount()}
            onCancel={() => {
              if (!removePending) setRemoveVisible(false);
            }}
            afterClose={() => {
              const origin = accountToRemove?.origin;
              setAccountToRemove(null);
              window.setTimeout(() => {
                const target = origin?.isConnected
                  ? origin
                  : sectionSwitcher.current?.querySelector<HTMLInputElement>('input:checked');
                if (!target?.closest('[inert], [hidden]')) target?.focus();
              }, 0);
            }}
          >
            {t('common.workbench.deleteAccountDescription')}
          </Modal>
        </div>
      </NavigationHistoryProvider>
    </LayoutContext.Provider>
  );
}
