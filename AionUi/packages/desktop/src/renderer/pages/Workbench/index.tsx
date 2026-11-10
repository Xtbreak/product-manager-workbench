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
import React, { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Button, Radio, Message } from '@arco-design/web-react';
import { Plus, CalendarDays, SlidersHorizontal, ArrowLeft, Table2, ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { NavigationHistoryProvider } from '@/renderer/hooks/context/NavigationHistoryContext';
import WindowControls from '@/renderer/components/layout/WindowControls';
import { isElectronDesktop, isMacOS } from '@/renderer/utils/platform';
import { setGlobalNavigate } from '@/renderer/utils/navigation';
import { useRestoreConversation } from './useRestoreConversation';
import AccountPanel from './AccountPanel';
import FeishuAuthorization from './FeishuAuthorization';
import BrowserPane from './BrowserPane';
import { type AccountStore, FEISHU_PARTITION, validBrowserUrl, type WorkbenchState } from './accountStore';
import styles from './Workbench.module.css';

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
  const [section, setSection] = useState('chat');
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
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false);
  const [sourcesWidth, setSourcesWidth] = useState<number>();
  const [sourcesResizing, setSourcesResizing] = useState(false);
  const sourcesDrag = useRef<AbortController | null>(null);
  useEffect(() => () => sourcesDrag.current?.abort(), []);
  const feishuPane = useRef<HTMLElement>(null);
  const sourcesPane = useRef<HTMLElement>(null);
  const lastChat = useRef('/guid');
  const auxiliary =
    !location.pathname.startsWith('/conversation/') && location.pathname !== '/guid' && location.pathname !== '/';
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
  const openAccount = (id: string) => {
    setSourcesCollapsed(false);
    void change((s) => s.select(id));
  };
  const addAccount = (name = '') => {
    setSourcesCollapsed(false);
    return change((s) => s.add(name, t('common.workbench.defaultAccountName')));
  };
  const startSourcesResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const divider = event.currentTarget;
    const columns = divider.parentElement;
    if (event.button !== 0 || sourcesDrag.current || !columns || !sourcesPane.current || !feishuPane.current) return;
    const width = sourcesPane.current.getBoundingClientRect().width;
    const layout = getComputedStyle(divider);
    const min = parseFloat(layout.getPropertyValue('--wb-sources-min'));
    const feishuMin = parseFloat(layout.getPropertyValue('--wb-feishu-min'));
    const max = Math.max(min, width + feishuPane.current.getBoundingClientRect().width - feishuMin);
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
      else setSourcesWidth(nextWidth);
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
    divider.addEventListener('lostpointercapture', () => finish(preview), options);
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
          <header className={styles.titlebar}>
            <span>{t('common.workbench.title')}</span>
            {!isMacOS() && <WindowControls />}
          </header>
          <div
            className={`${styles.columns}${sourcesCollapsed ? ` ${styles.sourcesCollapsed}` : ''}`}
            data-resizing-sources={sourcesResizing || undefined}
            style={
              sourcesWidth === undefined
                ? undefined
                : ({ '--wb-sources-width': `${sourcesWidth}px` } as React.CSSProperties)
            }
          >
            <section className={styles.left} aria-label={t('common.workbench.chat')}>
              <div className={styles.switcher}>
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
                  onAdd={addAccount}
                  onRename={(id, name) => change((s) => s.update(id, { name }))}
                  onOpen={openAccount}
                  onRemove={(id) => {
                    void change((s) => s.remove(id));
                  }}
                  onClose={(id) => {
                    void change((s) => s.update(id, { open: false }));
                  }}
                />
              )}
              {auxiliary && section === 'chat' && (
                <div className={styles.accounts}>
                  <Button
                    icon={<ArrowLeft size={16} strokeWidth={1.8} />}
                    onClick={() => void navigate(lastChat.current)}
                  >
                    {t('common.workbench.backToChat')}
                  </Button>
                </div>
              )}
              <footer className={styles.footer}>
                <Button
                  type='text'
                  icon={<CalendarDays size={18} strokeWidth={1.8} />}
                  onClick={() => void navigate('/scheduled')}
                >
                  {t('common.workbench.scheduled')}
                </Button>
                <Button
                  type='text'
                  icon={<SlidersHorizontal size={18} strokeWidth={1.8} />}
                  onClick={() => void navigate('/settings/agent')}
                >
                  {t('common.workbench.settings')}
                </Button>
              </footer>
            </section>
            <section ref={feishuPane} className={styles.center} aria-label={t('common.workbench.feishu')}>
              <div className={styles.paneHeader}>
                <Table2 size={18} strokeWidth={1.8} />
                <strong>{t('common.workbench.feishu')}</strong>
                <span className={styles.muted}>{t('common.workbench.destination')}</span>
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
              {state && isElectronDesktop() && (
                <BrowserPane
                  url={state.feishuUrl}
                  partition={FEISHU_PARTITION}
                  agentControl
                  accountId='feishu'
                  accountName={t('common.workbench.feishu')}
                  onUrlChange={(url) => {
                    if (url !== state.feishuUrl && validBrowserUrl(url)) void change((s) => s.setFeishuUrl(url));
                  }}
                />
              )}
              {!isElectronDesktop() && <p className={styles.accounts}>{t('common.workbench.desktopOnly')}</p>}
            </section>
            <section
              id='workbench-source-browsers'
              ref={sourcesPane}
              className={styles.right}
              aria-label={t('common.workbench.sources')}
              hidden={sourcesCollapsed}
            >
              <div className={styles.tabs} role='tablist' aria-label={t('common.workbench.accounts')}>
                {openAccounts.map((account) => (
                  <div key={account.id} className={styles.browserTab} role='presentation'>
                    <Button
                      role='tab'
                      aria-selected={account.id === activeId}
                      className={account.id === activeId ? styles.activeTab : ''}
                      type='text'
                      onClick={() => openAccount(account.id)}
                    >
                      {account.name || t('common.workbench.mainAccount')}
                    </Button>
                    <Button
                      type='text'
                      size='mini'
                      icon={<X size={16} strokeWidth={1.8} />}
                      title={t('common.workbench.closeBrowser')}
                      aria-label={`${t('common.workbench.closeBrowser')} ${account.name || t('common.workbench.mainAccount')}`}
                      onClick={() => void change((s) => s.update(account.id, { open: false }))}
                    />
                  </div>
                ))}
                <Button
                  type='text'
                  icon={<Plus size={18} strokeWidth={1.8} />}
                  aria-label={t('common.workbench.addAccount')}
                  onClick={() => void addAccount()}
                />
              </div>
              <div className={styles.profileStatus}>
                <span>{t('common.workbench.persistent')}</span>
                <span>{t('common.workbench.aiMultipleTargets')}</span>
              </div>
              <div className={styles.browserStack}>
                {state &&
                  isElectronDesktop() &&
                  openAccounts.map((account) => (
                    <div
                      key={account.id}
                      data-workbench-account-id={account.id}
                      className={styles.browserLayer}
                      hidden={sourcesCollapsed || account.id !== activeId}
                    >
                      <BrowserPane
                        url={account.url}
                        partition={account.partition}
                        agentControl
                        accountId={account.id}
                        accountName={account.name}
                        onUrlChange={(url) => {
                          if (url !== account.url && validBrowserUrl(url))
                            void change((s) => s.update(account.id, { url }));
                        }}
                      />
                    </div>
                  ))}
              </div>
            </section>
            {!sourcesCollapsed && (
              <div
                className={styles.sourcesDivider}
                role='separator'
                aria-orientation='vertical'
                aria-label={t('common.workbench.sources')}
                onPointerDown={startSourcesResize}
              />
            )}
            {auxiliary && (
              <section className={styles.routeOverlay}>
                <div className={styles.overlayHeader}>
                  <Button
                    type='text'
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
              </section>
            )}
          </div>
        </div>
      </NavigationHistoryProvider>
    </LayoutContext.Provider>
  );
}
