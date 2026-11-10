import React, { useState } from 'react';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import WebviewHost from '@/renderer/components/media/WebviewHost';
import { resolveAddressBarInput } from '@/renderer/pages/conversation/Preview/browser/constants';
import styles from './Workbench.module.css';

type Props = {
  url: string;
  partition: string;
  agentControl?: boolean;
  accountId?: string;
  accountName?: string;
  onUrlChange: (url: string) => void;
};
/** Browser errors remain actionable without discarding the persistent profile. */
export default function BrowserPane({
  url,
  partition,
  agentControl = false,
  accountId,
  accountName,
  onUrlChange,
}: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState(false);
  const [generation, setGeneration] = useState(0);
  return (
    <div className={styles.browser}>
      {error && (
        <div className={styles.error} role='alert'>
          {t('common.workbench.pageError')}
          <Button
            size='mini'
            onClick={() => {
              setError(false);
              setGeneration((n) => n + 1);
            }}
          >
            {t('common.workbench.retry')}
          </Button>
        </div>
      )}
      <WebviewHost
        key={generation}
        url={url}
        partition={partition}
        agentControl={agentControl}
        agentAccountId={accountId}
        agentAccountName={accountName}
        showNavBar
        resolveUrlInput={resolveAddressBarInput}
        onUrlChange={onUrlChange}
        onDidFinishLoad={() => setError(false)}
        onDidFailLoad={(code) => {
          if (code !== -3) setError(true);
        }}
      />
    </div>
  );
}
