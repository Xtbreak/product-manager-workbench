import React, { useRef } from 'react';
import { Button, Tooltip } from '@arco-design/web-react';
import { CircleAlert, MessageSquare, Pause, RefreshCw, Table2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { dmErrorKey, localTime } from './presentation';
import type { DirectMessagesModel } from './useDirectMessages';
import styles from '../Workbench.module.css';

export type CenterTab = 'feishu' | 'dm';
export function CenterTabs({
  tab,
  onChange,
  count,
}: {
  tab: CenterTab;
  onChange: (tab: CenterTab) => void;
  count: number;
}) {
  const { t } = useTranslation();
  const group = useRef<HTMLDivElement>(null);
  return (
    <div ref={group} className={styles.centerTabs} role='tablist' aria-label={t('common.workbench.dm.centerTabs')}>
      {(['feishu', 'dm'] as const).map((name) => {
        const label = t(name === 'dm' ? 'common.workbench.dm.title' : 'common.workbench.feishu');
        const active = name === tab;
        return (
          <Button
            key={name}
            id={'wb-tab-' + name}
            type='text'
            size='mini'
            role='tab'
            aria-selected={active}
            aria-controls={'wb-center-' + name}
            aria-label={label}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(name)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const next = name === 'dm' ? 'feishu' : 'dm';
              onChange(next);
              group.current?.querySelector<HTMLButtonElement>('#wb-tab-' + next)?.focus();
            }}
          >
            {name === 'dm' ? <MessageSquare size={14} strokeWidth={1.8} /> : <Table2 size={14} strokeWidth={1.8} />}
            <span>{label}</span>
            {name === 'dm' && count > 0 && (
              <small className={styles.pendingCount} title={t('common.workbench.dm.pending')}>
                {count > 99 ? '99+' : count}
              </small>
            )}
          </Button>
        );
      })}
    </div>
  );
}
export function DmToolbar({ model }: { model: DirectMessagesModel }) {
  const { t, i18n } = useTranslation();
  const status = model.snapshot?.status;
  const time = status?.lastSyncedAt
    ? t('common.workbench.dm.updated', { time: localTime(status.lastSyncedAt, i18n?.language, true) })
    : t('common.workbench.dm.never');
  const error = model.error || status?.error;
  const feedback = [
    ...(error ? [t(dmErrorKey(error))] : []),
    ...(status?.partial ? [t('common.workbench.dm.partial')] : []),
  ].join(' · ');
  const sync = t('common.workbench.dm.syncAll');
  const busy = Boolean(model.pending || status?.busy);
  return (
    <div className={styles.dmTools}>
      <time className={styles.lastSync}>{time}</time>
      {feedback && (
        <Tooltip content={feedback}>
          <span className={styles.dmIssue} aria-label={feedback} title={feedback}>
            <CircleAlert size={16} strokeWidth={1.8} />
          </span>
        </Tooltip>
      )}
      {busy && model.pending !== 'configure-feishu' && (
        <Button
          type='text'
          size='mini'
          aria-label={t('common.workbench.dm.cancel')}
          title={t('common.workbench.dm.cancel')}
          icon={<Pause size={16} strokeWidth={1.8} />}
          onClick={() => void model.run({ action: 'cancel' })}
        />
      )}
      <Tooltip content={sync + ' · ' + time}>
        <Button
          size='small'
          className={styles.syncAll}
          aria-label={sync}
          title={sync + ' · ' + time}
          disabled={busy}
          onClick={() => void model.run({ action: 'sync-all' })}
          icon={<RefreshCw size={16} strokeWidth={1.8} />}
        >
          <span>{sync}</span>
        </Button>
      </Tooltip>
    </div>
  );
}
