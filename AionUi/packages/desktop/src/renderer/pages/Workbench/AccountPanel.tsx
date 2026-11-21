import React, { useState } from 'react';
import { Button, Input } from '@arco-design/web-react';
import { Plus, ArrowUpRight, X, Trash2, PencilLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type BrowserAccount, PRIMARY_ACCOUNT_ID } from './accountStore';
import styles from './Workbench.module.css';

type Props = {
  accounts: BrowserAccount[];
  activeId?: string;
  operatingAccounts: ReadonlySet<string>;
  lockedAccounts: ReadonlySet<string>;
  onAdd: (name: string) => boolean | Promise<boolean>;
  onRename: (id: string, name: string) => boolean | Promise<boolean>;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  onRemove?: (id: string, origin: HTMLElement | null) => void;
};
/** Account names are labels; renaming never changes the underlying profile. */
export default function AccountPanel({
  accounts,
  activeId,
  operatingAccounts,
  lockedAccounts,
  onAdd,
  onRename,
  onOpen,
  onClose,
  onRemove,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  return (
    <section className={styles.accountPanel} aria-label={t('common.workbench.accounts')}>
      <div className={styles.addRow}>
        <Input
          aria-label={t('common.workbench.accountName')}
          placeholder={t('common.workbench.accountName')}
          value={name}
          maxLength={60}
          onChange={setName}
          onPressEnter={async () => {
            if (await onAdd(name)) setName('');
          }}
        />
        <Button
          type='secondary'
          aria-label={t('common.workbench.addAccount')}
          title={t('common.workbench.addAccount')}
          icon={<Plus size={18} strokeWidth={1.8} />}
          onClick={async () => {
            if (await onAdd(name)) setName('');
          }}
        />
      </div>
      <div className={styles.accountList}>
        {accounts.map((account) => {
          const accountName = account.name || t('common.workbench.mainAccount');
          const operating = operatingAccounts.has(account.id);
          const locked = lockedAccounts.has(account.id);
          const isActive = account.open && account.id === activeId;
          return (
            <div
              className={styles.accountRow}
              data-active={isActive}
              key={account.id}
              role='group'
              aria-label={accountName}
            >
              {editing === account.id ? (
                <>
                  <Input
                    autoFocus
                    aria-label={t('common.workbench.accountName')}
                    value={draft}
                    maxLength={60}
                    onChange={setDraft}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditing(null);
                    }}
                    onPressEnter={async () => {
                      if (draft.trim() && (await onRename(account.id, draft))) setEditing(null);
                    }}
                  />
                  <Button
                    type='primary'
                    size='mini'
                    disabled={!draft.trim()}
                    onClick={async () => {
                      if (await onRename(account.id, draft)) setEditing(null);
                    }}
                  >
                    {t('common.workbench.save')}
                  </Button>
                </>
              ) : (
                <>
                  <span className={styles.accountBadge} aria-hidden='true'>
                    {Array.from(accountName.trim())[0] || 'A'}
                  </span>
                  <Button
                    type='text'
                    className={styles.accountName}
                    title={accountName}
                    aria-label={accountName}
                    aria-pressed={account.open && account.id === activeId}
                    onClick={() => onOpen(account.id)}
                  >
                    {accountName}
                    <small className={styles.browserVisibility}>
                      {t(account.open ? 'common.workbench.browserOpen' : 'common.workbench.browserClosed')}
                    </small>
                  </Button>
                  <span className={styles.accountStatus} data-operating={operating}>
                    {t(operating ? 'common.workbench.aiOperating' : 'common.workbench.aiIdle')}
                  </span>
                  <div className={styles.accountActions}>
                    <Button
                      type='text'
                      size='mini'
                      icon={<ArrowUpRight size={16} strokeWidth={1.8} />}
                      aria-label={t('common.workbench.openBrowser')}
                      title={t('common.workbench.openBrowser')}
                      onClick={() => onOpen(account.id)}
                    />
                    <Button
                      type='text'
                      size='mini'
                      icon={<PencilLine size={16} strokeWidth={1.8} />}
                      aria-label={t('common.workbench.rename')}
                      title={t('common.workbench.rename')}
                      onClick={() => {
                        setEditing(account.id);
                        setDraft(accountName);
                      }}
                    />
                    {!account.open && account.id !== PRIMARY_ACCOUNT_ID && onRemove && (
                      <Button
                        type='text'
                        size='mini'
                        icon={<Trash2 size={16} strokeWidth={1.8} />}
                        aria-label={t('common.delete')}
                        title={t('common.delete')}
                        onClick={(event) =>
                          onRemove(account.id, event.currentTarget instanceof HTMLElement ? event.currentTarget : null)
                        }
                      />
                    )}
                    {account.open && (
                      <Button
                        type='text'
                        size='mini'
                        icon={<X size={16} strokeWidth={1.8} />}
                        aria-label={t('common.workbench.closeBrowser')}
                        title={t(
                          locked
                            ? 'common.workbench.replySync.errors.replyBrowserBusy'
                            : 'common.workbench.closeBrowser'
                        )}
                        disabled={locked}
                        onClick={() => onClose(account.id)}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
