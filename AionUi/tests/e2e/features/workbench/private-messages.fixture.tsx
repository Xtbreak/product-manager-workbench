import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import '@arco-design/web-react/dist/css/arco.css';
import '@/renderer/styles/themes/base.css';
import common from '@/renderer/services/i18n/locales/zh-CN/common.json';
import DirectMessages from '@/renderer/pages/Workbench/DirectMessages';
import { CenterTabs, DmToolbar } from '@/renderer/pages/Workbench/DirectMessages/CenterTabs';
import type { CenterTab } from '@/renderer/pages/Workbench/DirectMessages/CenterTabs';
import type { DirectMessagesModel } from '@/renderer/pages/Workbench/DirectMessages/useDirectMessages';
import css from '@/renderer/pages/Workbench/Workbench.module.css';
import type { DmThread, DmSyncResult } from '@/common/types/platform/workbenchDm';

const thread: DmThread = {
  key: 'douyin:test:me:peer',
  platform: 'douyin',
  actorId: 'me',
  accountId: 'test',
  contactPlatformId: 'peer',
  contactName: '小林同学',
  source: 'comment',
  commentKeys: ['comment', 'second-comment'],
  lastMessagePreview: '你好',
  lastMessageAt: Date.UTC(2025, 10, 24, 12),
  lastSender: 'peer',
  syncState: 'partial',
  partialReason: 'dmHistoryPartial',
  watermark: null,
};
const complete: DmThread = {
  ...thread,
  key: 'xiaohongshu:other:me:complete',
  platform: 'xiaohongshu',
  accountId: 'other',
  contactPlatformId: 'complete',
  contactName: '周末计划',
  lastSender: 'me',
  syncState: 'idle',
  partialReason: undefined,
};
const failed: DmThread = {
  ...thread,
  key: 'douyin:third:me:error',
  accountId: 'third',
  contactPlatformId: 'error',
  contactName: '夏天来信',
  syncState: 'error',
  partialReason: undefined,
  lastError: 'dmLoginRequired',
};
const syncing: DmThread = {
  ...thread,
  key: 'douyin:busy:me:syncing',
  accountId: 'busy',
  contactPlatformId: 'syncing',
  contactName: '更新中的朋友',
  syncState: 'idle',
  partialReason: undefined,
};
const result: DmSyncResult = {
  threads: [thread, complete, failed, syncing],
  status: { busy: false, partial: true, feishuConfigured: false },
  detail: {
    thread,
    comments: [
      {
        key: 'comment',
        workTitle: '作品甲',
        content:
          '这个方法我也试过，想请教你在不同平台之间整理多轮评论与来信时如何持续记录这些交流，并且在每次查看的时候迅速找到之前那一条留言？',
        token: 'example',
        createdAt: 10,
      },
      { key: 'second-comment', workTitle: '作品乙', content: '还有个小问题', token: 'second-example', createdAt: 20 },
    ],
    messages: [
      { id: 'first', sender: 'me', timestamp: 1, kind: 'text', text: '早上好' },
      { id: 'second', sender: 'peer', timestamp: 800000, kind: 'text', text: '你好' },
    ],
  },
};
const noop = async () => result;
function Fixture() {
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<CenterTab>('dm');
  const model: DirectMessagesModel = {
    snapshot: result,
    selected,
    detail: selected ? { ...result.detail!, thread: result.threads.find((th) => th.key === selected)! } : undefined,
    error: undefined,
    errorThreadKey: undefined,
    pending: undefined,
    refreshLocal: () => {},
    request: noop,
    run: noop,
    select: async (k) => {
      setSelected(k);
      return result;
    },
  };
  return (
    <section id='center' className={css.center} style={{ width: 700, height: 520 }}>
      <div className={css.paneHeader}>
        <CenterTabs tab={tab} onChange={setTab} count={1} />
        <div className={css.centerTools}>{tab === 'dm' && <DmToolbar model={model} />}</div>
        <span className={css.headerDivider} />
      </div>
      <div className={css.centerBody}>
        <div
          data-testid='feishu'
          className={css.centerBrowserLayer}
          hidden={tab === 'dm'}
          inert={tab === 'dm' || undefined}
        >
          <div>Feishu guest</div>
        </div>
        <div className={css.centerDmLayer} hidden={tab !== 'dm'}>
          <DirectMessages
            model={model}
            accounts={[]}
            lockedAccounts={new Set([syncing.accountId])}
            syncingAccounts={new Set([syncing.accountId])}
            onAccount={() => {}}
            onComment={() => {}}
          />
        </div>
      </div>
    </section>
  );
}
void i18n
  .use(initReactI18next)
  .init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: { common } } }, interpolation: { escapeValue: false } })
  .then(() => createRoot(document.getElementById('app')!).render(<Fixture />));
