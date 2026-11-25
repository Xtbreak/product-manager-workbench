import React, { useState } from 'react';
import { Button, Spin, Tooltip } from '@arco-design/web-react';
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ExternalLink,
  LockKeyhole,
  PanelsTopLeft,
  RefreshCw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DmDetail, DmThread } from '@/common/types/platform/workbenchDm';
import { MessageStream } from './MessageStream';
import { dmErrorKey, localTime } from './presentation';
import styles from './DirectMessages.module.css';
type Props = {
  thread: DmThread;
  detail?: DmDetail;
  accountName: string;
  locked: boolean;
  busy: boolean;
  highlight: boolean;
  error?: string;
  onBack: () => void;
  onUpdate: () => void;
  onAccount: () => void;
  onComment: (token: string) => void;
};
export default function ThreadDetail({
  thread,
  detail,
  accountName,
  locked,
  busy,
  highlight,
  error,
  onBack,
  onUpdate,
  onAccount,
  onComment,
}: Props) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const comments = detail?.comments ?? [];
  const updateTitle = t(locked ? 'common.workbench.dm.busy' : 'common.workbench.dm.update');
  const original = (token: string) => (
    <Button
      size='mini'
      type='text'
      className={styles.original}
      aria-label={t('common.workbench.dm.original')}
      onClick={() => onComment(token)}
    >
      {t('common.workbench.dm.original')}
      <ArrowUpRight size={13} strokeWidth={1.8} />
    </Button>
  );
  return (
    <>
      <header className={styles.detailHeader} data-highlight={highlight || undefined}>
        <Button
          data-dm-back=''
          className={styles.back}
          type='text'
          size='mini'
          aria-label={t('common.workbench.dm.back')}
          onClick={onBack}
          icon={<ArrowLeft size={16} strokeWidth={1.8} />}
        />
        <div className={styles.contactHeading}>
          <strong>{thread.contactName || thread.contactPlatformId}</strong>
          <small>
            <span>
              {t(`common.workbench.replySync.${thread.platform}`)} · {accountName}
            </span>
            <time title={thread.lastSyncedAt ? localTime(thread.lastSyncedAt, i18n?.language, true) : undefined}>
              {thread.lastSyncedAt
                ? t('common.workbench.dm.updated', { time: localTime(thread.lastSyncedAt, i18n?.language) })
                : t('common.workbench.dm.never')}
            </time>
          </small>
        </div>
        <Tooltip content={updateTitle}>
          <span title={updateTitle}>
            <Button
              size='mini'
              type='secondary'
              className={styles.update}
              disabled={locked || busy}
              aria-label={t('common.workbench.dm.update')}
              onClick={onUpdate}
              icon={<RefreshCw size={14} strokeWidth={1.8} />}
            >
              <span>{t('common.workbench.dm.update')}</span>
            </Button>
          </span>
        </Tooltip>
        <Button
          type='text'
          size='mini'
          title={t('common.workbench.dm.account')}
          aria-label={t('common.workbench.dm.account')}
          onClick={onAccount}
          icon={<PanelsTopLeft size={16} strokeWidth={1.8} />}
        />
      </header>
      {comments.length > 0 && (
        <section className={styles.linked}>
          <div className={styles.linkSummary}>
            <Button
              size='mini'
              type='text'
              aria-expanded={expanded}
              className={styles.linkToggle}
              onClick={() => setExpanded(!expanded)}
            >
              <span className={styles.linkLabel}>
                {t('common.workbench.dm.comments')} ({comments.length})
              </span>
              <span className={styles.linkExcerpt}>{comments[0].content}</span>
              <ChevronDown size={13} strokeWidth={1.8} data-open={expanded} />
            </Button>
            {original(comments[0].token)}
          </div>
          {expanded && (
            <ul className={styles.linkedList}>
              {comments.map((c) => (
                <li key={c.key}>
                  <div>
                    <small>{c.workTitle}</small>
                    <p>{c.content}</p>
                  </div>
                  {original(c.token)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {detail ? (
        <MessageStream contactKey={thread.key} messages={detail.messages} />
      ) : (
        <div className={styles.empty}>{error ? t(dmErrorKey(error)) : <Spin size={16} />}</div>
      )}
      <footer className={styles.readOnly}>
        <span title={t('common.workbench.dm.readOnly')}>
          <LockKeyhole size={12} strokeWidth={1.8} />
          <span>{t('common.workbench.dm.readOnly')}</span>
        </span>
        <Button size='mini' type='text' onClick={onAccount}>
          {t('common.workbench.dm.replyInBrowser')} <ExternalLink size={12} strokeWidth={1.8} />
        </Button>
      </footer>
    </>
  );
}
