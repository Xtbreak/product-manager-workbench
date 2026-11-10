import React, { useEffect, useState } from 'react';
import { Button, Space, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { application } from '@/common/adapter/ipcBridge';
import styles from './Workbench.module.css';

type State =
  | 'ready'
  | 'loginRequired'
  | 'missingPermissions'
  | 'notInstalled'
  | 'notConfigured'
  | 'error'
  | 'pending'
  | 'checking';
/** Reuse the local CLI login without copying tokens into renderer state. */
export default function FeishuAuthorization() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>('checking');
  const [userName, setUserName] = useState('');
  const [busy, setBusy] = useState(false);
  const perform = async (action: 'status' | 'login' | 'finish') => {
    setBusy(true);
    try {
      const response = await application.feishuAuth.invoke({ action });
      if (!response.success || !response.data) {
        setState('error');
        return;
      }
      setState(response.data.state);
      setUserName(response.data.userName ?? '');
    } catch {
      setState('error');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void perform('status');
  }, []);
  const messages = {
    ready: t('common.workbench.feishuAuth.ready'),
    loginRequired: t('common.workbench.feishuAuth.loginRequired'),
    missingPermissions: t('common.workbench.feishuAuth.missingPermissions'),
    notInstalled: t('common.workbench.feishuAuth.notInstalled'),
    notConfigured: t('common.workbench.feishuAuth.notConfigured'),
    error: t('common.workbench.feishuAuth.error'),
    pending: t('common.workbench.feishuAuth.pending'),
    checking: t('common.workbench.feishuAuth.checking'),
  };
  return (
    <section className={styles.feishuAuthorization}>
      <strong>{t('common.workbench.feishuAuth.title')}</strong>
      <Typography.Text>
        {messages[state]}
        {userName ? ` · ${userName}` : ''}
      </Typography.Text>
      <Typography.Text type='secondary'>{t('common.workbench.feishuAuth.description')}</Typography.Text>
      <Space>
        <Button loading={busy} onClick={() => void perform(state === 'pending' ? 'finish' : 'status')}>
          {t(state === 'pending' ? 'common.workbench.feishuAuth.finish' : 'common.workbench.feishuAuth.refresh')}
        </Button>
        <Button
          disabled={busy || ['notInstalled', 'notConfigured', 'checking', 'pending'].includes(state)}
          onClick={() => void perform('login')}
        >
          {t('common.workbench.feishuAuth.authorize')}
        </Button>
      </Space>
    </section>
  );
}
