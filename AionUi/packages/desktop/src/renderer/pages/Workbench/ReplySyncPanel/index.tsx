import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Menu, Modal, Spin, Tooltip } from '@arco-design/web-react';
import { Ellipsis, MessageSquareReply, Pause, CloudSync, CircleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { application } from '@/common/adapter/ipcBridge';
import type { ReplySyncAction, ReplySyncStatus } from '@/common/types/platform/workbenchReply';
import styles from './ReplySyncPanel.module.css';
import { replyErrorKey } from './errorMessages';

type Props = {
  sourceUrl: string;
  accounts: { id: string; name: string }[];
  onOpenTable: (url: string) => void;
  onSettingsVisibilityChange?: (visible: boolean) => void;
};

/** Controls for explicit draft batches and their Feishu reply table. */
export default function ReplySyncPanel({ sourceUrl, accounts, onOpenTable, onSettingsVisibilityChange }: Props) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [closingForAction, setClosingForAction] = useState(false);
  const [status, setStatus] = useState<ReplySyncStatus>();
  const [pending, setPending] = useState<ReplySyncAction['action']>();
  const [failed, setFailed] = useState<string>();
  const [sendingPending, setSendingPending] = useState(false);
  const [authStep, setAuthStep] = useState<'idle' | 'pending' | 'ready'>('idle');
  const [authBusy, setAuthBusy] = useState(false);
  const requestId = useRef(0);
  const active = useRef(0);
  const sendingActive = useRef(false);
  const batchGeneration = useRef(0);
  const mounted = useRef(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const failureAction = useRef<string | undefined>(undefined);
  const deferredBrowserAction = useRef<ReplySyncAction | undefined>(undefined);
  const afterCloseTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => onSettingsVisibilityChange?.(false), [onSettingsVisibilityChange]);
  const invoke = useCallback(async (action: ReplySyncAction) => {
    const preserveActionFailure = () =>
      action.action === 'status' && failureAction.current && failureAction.current !== 'status';
    const reportFailure = (code: string) => {
      if (preserveActionFailure()) return;
      failureAction.current = action.action;
      setFailed(code);
    };
    const clearFailure = () => {
      if (preserveActionFailure()) return;
      failureAction.current = undefined;
      setFailed(undefined);
    };
    const sequence = ++requestId.current;
    const observedBatch = batchGeneration.current;
    active.current += 1;
    if (action.action === 'send-pending') {
      sendingActive.current = true;
      setSendingPending(true);
    }
    if (action.action !== 'status' && action.action !== 'send-pending') {
      setPending(action.action);
      setAuthStep('idle');
    }
    try {
      const response = await application.replySync.invoke(action);
      if (!mounted.current) return undefined;
      if (action.action === 'send-pending') batchGeneration.current += 1;
      else if (observedBatch !== batchGeneration.current) return undefined;
      if (!response.success || !response.data) {
        if (sequence === requestId.current || action.action === 'send-pending') {
          reportFailure(response.msg || 'replyOperationFailed');
        }
        return undefined;
      }
      if (action.action === 'send-pending') {
        setStatus(response.data);
        clearFailure();
        return response.data;
      }
      if (sequence !== requestId.current) return undefined;
      setStatus(response.data);
      clearFailure();
      return response.data;
    } catch {
      if (action.action === 'send-pending') batchGeneration.current += 1;
      if (
        mounted.current &&
        (action.action === 'send-pending' ||
          (sequence === requestId.current && observedBatch === batchGeneration.current))
      )
        reportFailure('replyOperationFailed');
      return undefined;
    } finally {
      active.current -= 1;
      if (action.action === 'send-pending') {
        sendingActive.current = false;
        if (mounted.current) setSendingPending(false);
      }
      if (
        mounted.current &&
        action.action !== 'status' &&
        action.action !== 'send-pending' &&
        sequence === requestId.current
      )
        setPending(undefined);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void invoke({ action: 'status' });
    const timer = window.setInterval(() => {
      if (active.current === (sendingActive.current ? 1 : 0)) void invoke({ action: 'status' });
    }, 15_000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.clearTimeout(afterCloseTimer.current);
      deferredBrowserAction.current = undefined;
    };
  }, [invoke]);
  const busy = Boolean(pending || sendingPending || status?.busy || authBusy);
  const currentError = failed || status?.error;
  const authRequired = Boolean(
    currentError && ['replyMissingPermissions', 'replyLoginRequired', 'replyAuthNotConfigured'].includes(currentError)
  );
  const showError = currentError && !(authRequired && authStep === 'ready');
  const feedback = showError
    ? t(replyErrorKey(currentError, status?.sendButtonConfigured))
    : status?.collectionPartial
      ? t('common.workbench.replySync.partial')
      : undefined;
  const authorize = async (action: 'reply-login' | 'finish') => {
    setAuthBusy(true);
    active.current += 1;
    try {
      const response = await application.feishuAuth.invoke({ action });
      if (!mounted.current) return;
      if (response.success && response.data?.state === 'pending') setAuthStep('pending');
      else if (response.success && response.data?.state === 'ready') {
        setAuthStep('ready');
      } else {
        setAuthStep('idle');
        failureAction.current = 'authorization';
        setFailed(response.data?.state === 'missingPermissions' ? 'replyMissingPermissions' : 'replyLoginRequired');
      }
    } catch {
      if (mounted.current) {
        setAuthStep('idle');
        failureAction.current = 'authorization';
        setFailed('replyLoginRequired');
      }
    } finally {
      active.current -= 1;
      if (mounted.current) setAuthBusy(false);
    }
  };
  const setup = async () => {
    const next = await invoke({ action: 'setup', sourceUrl });
    if (next?.tableUrl) onOpenTable(next.tableUrl);
  };
  const configure = async () => {
    const next = await invoke({ action: 'configure' });
    if (next?.sendButtonConfigured && next.tableUrl) onOpenTable(next.tableUrl);
  };
  const closeForBrowserAction = (action: ReplySyncAction) => {
    if (deferredBrowserAction.current) return;
    deferredBrowserAction.current = action;
    setClosingForAction(true);
    setPending(action.action);
    setVisible(false);
  };
  return (
    <>
      {status?.sendButtonConfigured && status.tableUrl && (
        <>
          <Button
            size='small'
            className={styles.sendPending}
            loading={sendingPending}
            disabled={busy || status.sendMode !== 'toolbar' || !status.works.length}
            onClick={() => void invoke({ action: 'send-pending' })}
          >
            {t('common.workbench.replySync.sendPending')}
          </Button>
        </>
      )}
      <Button
        type='text'
        size='small'
        className={styles.trigger}
        icon={<CloudSync size={17} strokeWidth={1.8} />}
        aria-label={t('common.workbench.replySync.collectComments')}
        title={t('common.workbench.replySync.collectComments')}
        loading={pending === 'collect'}
        disabled={busy || !status?.tableUrl || !status.works.length}
        onClick={() => void invoke({ action: 'collect' })}
      />
      <Dropdown
        trigger='click'
        position='br'
        droplist={
          <Menu
            className={styles.menu}
            onClickMenuItem={(action) => {
              if (action === 'settings') {
                onSettingsVisibilityChange?.(true);
                setVisible(true);
              } else if (action === 'reconcile' || action === 'cancel') void invoke({ action });
            }}
          >
            {status?.canCancelSend && (
              <Menu.Item key='cancel' disabled={pending === 'cancel'}>
                {t('common.workbench.replySync.cancelSend')}
              </Menu.Item>
            )}
            <Menu.Item key='reconcile' disabled={busy || !status?.uncertain}>
              {t('common.workbench.replySync.reconcile')}
            </Menu.Item>
            <Menu.Item key='settings' disabled={closingForAction}>
              {t('common.settings')}
            </Menu.Item>
          </Menu>
        }
      >
        <Button
          type='text'
          size='small'
          ref={moreButton}
          className={styles.trigger}
          icon={<Ellipsis size={18} strokeWidth={1.8} />}
          aria-label={t('common.more')}
          title={t('common.more')}
        />
      </Dropdown>
      {!visible && feedback && (
        <Tooltip content={feedback} trigger={['hover', 'focus']}>
          <span
            role={showError ? 'alert' : 'status'}
            className={styles.toolbarFeedback}
            tabIndex={0}
            aria-label={feedback}
          >
            <CircleAlert size={15} strokeWidth={1.8} aria-hidden />
            <span className={styles.feedbackText}>{feedback}</span>
          </span>
        </Tooltip>
      )}
      <Modal
        visible={visible}
        onCancel={() => setVisible(false)}
        afterClose={() => {
          const action = deferredBrowserAction.current;
          deferredBrowserAction.current = undefined;
          onSettingsVisibilityChange?.(false);
          afterCloseTimer.current = window.setTimeout(() => {
            afterCloseTimer.current = undefined;
            if (!mounted.current) return;
            setClosingForAction(false);
            if (!moreButton.current?.closest('[inert]')) moreButton.current?.focus();
            if (action) void invoke(action);
          }, 0);
        }}
        title={t('common.workbench.replySync.title')}
        footer={null}
        className={styles.modal}
        closeIcon={
          <Button
            type='text'
            size='mini'
            className={styles.closeButton}
            aria-label={t('common.close')}
            title={t('common.close')}
            data-autofocus=''
            icon={<X size={16} strokeWidth={1.8} />}
            onClick={(event) => {
              event.stopPropagation();
              setVisible(false);
            }}
          />
        }
        focusLock
        autoFocus
        unmountOnExit
      >
        <div className={styles.content}>
          {showError && (
            <p role='alert' className={styles.notice}>
              {t(replyErrorKey(currentError, status?.sendButtonConfigured))}
            </p>
          )}
          {authRequired && authStep === 'idle' && (
            <Button
              className={styles.primaryAction}
              loading={authBusy}
              disabled={authBusy}
              onClick={() => void authorize('reply-login')}
            >
              {t('common.workbench.replySync.authorizeReplies')}
            </Button>
          )}
          {authStep === 'pending' && (
            <section className={styles.card}>
              <p className={styles.description}>{t('common.workbench.feishuAuth.pending')}</p>
              <Button
                className={styles.primaryAction}
                loading={authBusy}
                disabled={authBusy}
                onClick={() => void authorize('finish')}
              >
                {t('common.workbench.feishuAuth.finish')}
              </Button>
            </section>
          )}
          {authStep === 'ready' && (
            <p role='status' className={styles.notice}>
              {t('common.workbench.replySync.authReadyHint')}
            </p>
          )}
          {!status && !failed && <Spin tip={t('common.workbench.replySync.loading')} />}
          {!status && failed && <Button onClick={() => void invoke({ action: 'status' })}>{t('common.retry')}</Button>}
          {status && !status.tableUrl && (
            <section className={styles.card}>
              <strong>{t('common.workbench.replySync.setupTitle')}</strong>
              <p className={styles.description}>{t('common.workbench.replySync.setupHint')}</p>
              <Button
                className={styles.primaryAction}
                loading={pending === 'setup'}
                disabled={busy || !sourceUrl}
                onClick={() => void setup()}
              >
                {t('common.workbench.replySync.setup')}
              </Button>
            </section>
          )}
          {status?.tableUrl && (
            <>
              <section className={styles.card}>
                <div className={styles.row}>
                  <strong>{t('common.workbench.replySync.manualSending')}</strong>
                  <Button size='small' onClick={() => onOpenTable(status.tableUrl!)}>
                    {t('common.workbench.replySync.openTable')}
                  </Button>
                </div>
                <div className={styles.stats}>
                  <span>
                    {t('common.workbench.replySync.archived')}
                    <strong>{status.archived}</strong>
                  </span>
                  <span>
                    {t('common.workbench.replySync.sent')}
                    <strong>{status.sent}</strong>
                  </span>
                  <span>
                    {t('common.workbench.replySync.uncertain')}
                    <strong>{status.uncertain}</strong>
                  </span>
                </div>
                <div className={styles.actions}>
                  <Button
                    className={styles.primaryAction}
                    icon={<CloudSync size={15} strokeWidth={1.8} />}
                    loading={pending === 'collect'}
                    disabled={busy || !status.works.length}
                    onClick={() => closeForBrowserAction({ action: 'collect' })}
                  >
                    {t('common.workbench.replySync.collectComments')}
                  </Button>
                  {status.sendButtonConfigured && status.canCancelSend && (
                    <Button
                      loading={pending === 'cancel'}
                      disabled={pending === 'cancel'}
                      onClick={() => void invoke({ action: 'cancel' })}
                    >
                      {t('common.workbench.replySync.cancelSend')}
                    </Button>
                  )}
                  <Button
                    disabled={busy || !status.uncertain}
                    onClick={() => closeForBrowserAction({ action: 'reconcile' })}
                  >
                    {t('common.workbench.replySync.reconcile')}
                  </Button>
                </div>
                {status.busy && (
                  <span role='status' className={styles.description}>
                    {t('common.workbench.replySync.syncing')}
                  </span>
                )}
                {status.lastRunAt && (
                  <span className={styles.description}>
                    {t('common.workbench.replySync.lastRun', { time: new Date(status.lastRunAt).toLocaleString() })}
                  </span>
                )}
                <p className={styles.description}>{t('common.workbench.replySync.manualRuntimeHint')}</p>
                {status.collectionPartial && <p className={styles.notice}>{t('common.workbench.replySync.partial')}</p>}
              </section>
              <section className={styles.card}>
                <strong>{t('common.workbench.replySync.bindTitle')}</strong>
                <p className={styles.description}>{t('common.workbench.replySync.bindHint')}</p>
                {!accounts.length && <p className={styles.description}>{t('common.workbench.replySync.noAccounts')}</p>}
                {accounts.map((account) => (
                  <div
                    key={account.id}
                    role='group'
                    aria-label={account.name || t('common.workbench.mainAccount')}
                    className={styles.row}
                  >
                    <span className={styles.accountName}>{account.name || t('common.workbench.mainAccount')}</span>
                    <Button
                      size='small'
                      className={styles.primaryAction}
                      disabled={busy}
                      onClick={() => closeForBrowserAction({ action: 'bind', accountId: account.id })}
                    >
                      {t('common.workbench.replySync.bindCurrent')}
                    </Button>
                  </div>
                ))}
                <ul className={styles.works} aria-label={t('common.workbench.replySync.boundWorks')}>
                  {status.works.map((work) => (
                    <li key={work.key}>
                      <span>{work.title}</span>
                      <small>
                        {t(
                          work.platform === 'xiaohongshu'
                            ? 'common.workbench.replySync.xiaohongshu'
                            : 'common.workbench.replySync.douyin'
                        )}{' '}
                        · {work.actorName}
                      </small>
                    </li>
                  ))}
                </ul>
                {!status.works.length && (
                  <p className={styles.description}>{t('common.workbench.replySync.emptyWorks')}</p>
                )}
              </section>
              <section className={styles.card}>
                {status.sendMode === 'toolbar' && (
                  <strong role='status'>{t('common.workbench.replySync.buttonConfigured')}</strong>
                )}
                {status.sendMode !== 'toolbar' && (
                  <p className={styles.description}>{t('common.workbench.replySync.configureHint')}</p>
                )}
                <Button
                  className={status.sendMode !== 'toolbar' ? styles.primaryAction : undefined}
                  loading={pending === 'configure'}
                  disabled={busy}
                  onClick={() => void configure()}
                >
                  {t('common.workbench.replySync.configureTable')}
                </Button>
              </section>
            </>
          )}
          <details className={styles.guideDetails}>
            <summary>{t('common.workbench.replySync.title')}</summary>
            <div className={styles.guideBody}>
              <p className={styles.description}>{t('common.workbench.replySync.feishuReplyPath')}</p>
              <p className={styles.description}>{t('common.workbench.replySync.platformReplyPath')}</p>
              <p className={styles.description}>{t('common.workbench.replySync.replyBackfillHint')}</p>
              <p className={styles.description}>{t('common.workbench.replySync.commentLinkHint')}</p>
            </div>
          </details>
        </div>
      </Modal>
    </>
  );
}

/** An overlay keeps the guest mounted and its existing profile intact. */
export function ReplyBrowserLock({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReplySyncStatus>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await application.replySync.invoke({ action: 'status' });
        if (!disposed) setStatus(response.success ? response.data : undefined);
      } catch {
        if (!disposed) setStatus(undefined);
      }
    };
    void refresh();
    const timer = window.setInterval((): void => {
      void refresh();
    }, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [accountId]);
  const actionFor = (current?: ReplySyncStatus): ReplySyncAction | undefined => {
    return current?.busy && current.busyAccountId === accountId && current.sendButtonConfigured && current.canCancelSend
      ? { action: 'cancel' }
      : undefined;
  };
  const action = actionFor(status);
  const stop = async () => {
    setPending(true);
    setFailed(false);
    try {
      const latest = await application.replySync.invoke({ action: 'status' });
      const confirmed = latest.success ? actionFor(latest.data) : undefined;
      if (!confirmed || confirmed.action !== action?.action) {
        setStatus(latest.success ? latest.data : undefined);
        return;
      }
      const response = await application.replySync.invoke(confirmed);
      if (!response.success) setFailed(true);
      else setStatus(response.data);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className={styles.browserLock} role='status'>
      <div className={styles.lockCard}>
        <MessageSquareReply size={22} strokeWidth={1.8} />
        <strong>{t('common.workbench.replySync.syncing')}</strong>
        {action && (
          <Button disabled={pending} loading={pending} onClick={() => void stop()} icon={<Pause size={15} />}>
            {t('common.workbench.replySync.cancelSend')}
          </Button>
        )}
        {failed && <p role='alert'>{t('common.workbench.replySync.error')}</p>}
      </div>
    </div>
  );
}
