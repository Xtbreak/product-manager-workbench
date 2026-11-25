import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Input } from '@arco-design/web-react';
import { CircleAlert, Inbox, LoaderCircle, MessageSquare, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DmThread } from '@/common/types/platform/workbenchDm';
import type { BrowserAccount } from '../accountStore';
import ThreadDetail from './ThreadDetail';
import { dmErrorKey, hasMessages, isWaiting, localTime } from './presentation';
import type { DirectMessagesModel } from './useDirectMessages';
import styles from './DirectMessages.module.css';

type Filter = 'all' | 'withMessages' | 'pending';
function matches(t: DmThread, filter: Filter, query: string) {
  return (
    (filter === 'all' || (filter === 'pending' ? isWaiting(t) : hasMessages(t))) &&
    t.contactName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
}
type Props = {
  model: DirectMessagesModel;
  accounts: BrowserAccount[];
  lockedAccounts: ReadonlySet<string>;
  syncingAccounts?: ReadonlySet<string>;
  link?: { key: string; sequence: number };
  onAccount: (id: string) => void;
  onComment: (token: string) => void;
};
export default function DirectMessages({
  model,
  accounts,
  lockedAccounts,
  syncingAccounts,
  link,
  onAccount,
  onComment,
}: Props) {
  const { t, i18n } = useTranslation();
  const shell = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  const [highlight, setHighlight] = useState('');
  const [cleared, setCleared] = useState(false);
  const threads = model.snapshot?.threads ?? [];
  const selected = threads.find((th) => th.key === model.selected);
  const results = threads.filter((th) => matches(th, filter, search));
  const status = model.snapshot?.status;
  const select = (key: string) => {
    setShowDetail(true);
    void model.select(key);
  };
  const linkTarget = link && threads.find((th) => th.key === link.key);
  useLayoutEffect(() => {
    if (!linkTarget) return;
    const target = linkTarget;
    const blocked = !matches(target, filter, search);
    if (blocked) {
      setSearch('');
      setFilter('all');
    }
    setCleared(blocked);
    setHighlight(target.key);
    setShowDetail(true);
    const frame = requestAnimationFrame(() => rows.current.get(target.key)?.scrollIntoView?.({ block: 'nearest' }));
    const timer = window.setTimeout(() => {
      setHighlight('');
      setCleared(false);
    }, 1600);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [link, linkTarget?.key]);
  useEffect(() => {
    if (!selected && showDetail) setShowDetail(false);
  }, [selected, showDetail]);
  useLayoutEffect(() => {
    if (!showDetail || !selected || !shell.current) return;
    const back = shell.current.querySelector<HTMLButtonElement>('[data-dm-back]');
    if (back && back.getClientRects().length) back.focus({ preventScroll: true });
  }, [showDetail, selected?.key, link]);
  const anyBusy = Boolean(model.pending || status?.busy);
  const acct = (id: string) => accounts.find((a) => a.id === id)?.name || t('common.workbench.mainAccount');
  const error =
    (selected && model.errorThreadKey === selected.key ? model.error : undefined) ||
    (selected?.syncState === 'error' ? selected.lastError || 'dmOperationFailed' : undefined);
  const locked = Boolean(selected && lockedAccounts.has(selected.accountId));
  const reason = error
    ? t(dmErrorKey(error))
    : locked
      ? t('common.workbench.dm.busy')
      : selected?.syncState === 'partial'
        ? t(dmErrorKey(selected.partialReason || 'dmPartialHistory'))
        : undefined;
  return (
    <div
      ref={shell}
      className={styles.view}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && showDetail && shell.current && shell.current.clientWidth < 460) {
          e.preventDefault();
          setShowDetail(false);
          requestAnimationFrame(() => rows.current.get(model.selected)?.focus());
        }
      }}
    >
      {cleared && (
        <div className={styles.banner} role='status'>
          <CircleAlert size={14} strokeWidth={1.8} />
          {t('common.workbench.dm.filterCleared')}
        </div>
      )}
      <div className={styles.columns} data-detail={Boolean(showDetail && selected)}>
        <aside className={styles.contacts} aria-label={t('common.workbench.dm.contacts')}>
          <div className={styles.controls}>
            <div className={styles.filters} role='group' aria-label={t('common.workbench.dm.contacts')}>
              {(['all', 'withMessages', 'pending'] as const).map((f) => (
                <Button
                  key={f}
                  type='text'
                  size='mini'
                  aria-pressed={f === filter}
                  title={t(`common.workbench.dm.${f}`)}
                  onClick={() => setFilter(f)}
                >
                  <span className={styles.filterLabel}>{t(`common.workbench.dm.${f}`)}</span>
                  <span className={styles.filterCount}>{threads.filter((th) => matches(th, f, '')).length}</span>
                </Button>
              ))}
            </div>
            <Input
              size='small'
              allowClear
              value={search}
              prefix={<Search size={13} strokeWidth={1.8} />}
              aria-label={t('common.workbench.dm.search')}
              placeholder={t('common.workbench.dm.search')}
              onChange={setSearch}
            />
          </div>
          <div className={styles.list} data-empty={!results.length || undefined}>
            {results.map((th) => {
              const waiting = isWaiting(th);
              const syncing = status?.busyAccountId === th.accountId || syncingAccounts?.has(th.accountId);
              return (
                <Button
                  key={th.key}
                  type='text'
                  className={styles.row}
                  aria-pressed={th.key === model.selected}
                  data-highlight={highlight === th.key || undefined}
                  ref={(el) => {
                    if (el instanceof HTMLButtonElement) rows.current.set(th.key, el);
                    else rows.current.delete(th.key);
                  }}
                  onClick={() => select(th.key)}
                >
                  <span className={styles.avatar} aria-hidden>
                    {th.avatarUrl?.startsWith('https://') ? (
                      <img src={th.avatarUrl} alt='' referrerPolicy='no-referrer' />
                    ) : (
                      Array.from(th.contactName || '·')[0]
                    )}
                  </span>
                  <span className={styles.rowText}>
                    <span className={styles.rowTitle}>
                      <strong>{th.contactName || th.contactPlatformId}</strong>
                      <small className={styles.platform}>{t(`common.workbench.replySync.${th.platform}`)}</small>
                      <time>{th.lastMessageAt ? localTime(th.lastMessageAt, i18n?.language) : ''}</time>
                    </span>
                    <span className={styles.preview}>
                      {hasMessages(th)
                        ? (th.lastSender === 'me' ? t('common.workbench.dm.mePrefix') : '') +
                          (th.lastMessagePreview ||
                            (th.lastMessageKind && th.lastMessageKind !== 'text'
                              ? t(`common.workbench.dm.${th.lastMessageKind}`)
                              : ''))
                        : t('common.workbench.dm.onlyComments')}
                    </span>
                    <small className={styles.meta}>
                      {acct(th.accountId)} · {t('common.workbench.dm.comments')} ({th.commentKeys.length})
                    </small>
                  </span>
                  {(waiting || syncing || th.syncState !== 'idle') && (
                    <span className={styles.rowStatus}>
                      {waiting && <span className={styles.dot} aria-label={t('common.workbench.dm.pending')} />}
                      {syncing ? (
                        <LoaderCircle
                          className={styles.spin}
                          size={14}
                          strokeWidth={1.8}
                          aria-label={t('common.workbench.dm.syncingAccount')}
                        />
                      ) : (
                        th.syncState !== 'idle' && (
                          <CircleAlert
                            className={th.syncState === 'partial' ? styles.partial : styles.error}
                            size={14}
                            strokeWidth={1.8}
                            aria-label={t(
                              th.syncState === 'partial' ? 'common.workbench.dm.partial' : 'common.workbench.dm.failure'
                            )}
                          />
                        )
                      )}
                    </span>
                  )}
                </Button>
              );
            })}
            {!results.length && (
              <div className={styles.empty}>
                <Inbox size={23} strokeWidth={1.8} />
                {t(threads.length ? 'common.workbench.dm.noResults' : 'common.workbench.dm.noContacts')}
              </div>
            )}
          </div>
        </aside>
        <article className={styles.conversation}>
          {reason && (
            <div className={styles.banner} data-error={Boolean(error)} role='status'>
              <CircleAlert size={14} strokeWidth={1.8} />
              {reason}
            </div>
          )}
          {selected ? (
            <ThreadDetail
              key={selected.key}
              thread={selected}
              error={error}
              detail={model.detail?.thread.key === selected.key ? model.detail : undefined}
              locked={locked}
              busy={anyBusy}
              highlight={highlight === selected.key}
              accountName={acct(selected.accountId)}
              onUpdate={() => void model.run({ action: 'sync-contact', key: selected.key })}
              onAccount={() => onAccount(selected.accountId)}
              onComment={onComment}
              onBack={() => {
                setShowDetail(false);
                requestAnimationFrame(() => rows.current.get(selected.key)?.focus());
              }}
            />
          ) : (
            <div className={styles.empty}>
              <MessageSquare size={24} strokeWidth={1.8} />
              {t('common.workbench.dm.choose')}
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
