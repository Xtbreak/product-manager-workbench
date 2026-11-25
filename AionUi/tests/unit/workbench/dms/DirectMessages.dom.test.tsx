import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DirectMessages from '@/renderer/pages/Workbench/DirectMessages';
import { CenterTabs, DmToolbar } from '@/renderer/pages/Workbench/DirectMessages/CenterTabs';
import { MessageStream } from '@/renderer/pages/Workbench/DirectMessages/MessageStream';
import type { DirectMessagesModel } from '@/renderer/pages/Workbench/DirectMessages/useDirectMessages';
import type { DmThread, DmMessage } from '@/common/types/platform/workbenchDm';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const thread: DmThread = {
  key: 'xhs:a:me:one',
  platform: 'xiaohongshu',
  accountId: 'a',
  actorId: 'me',
  contactPlatformId: 'one',
  contactName: 'Ming',
  source: 'comment',
  commentKeys: ['one', 'two'],
  lastMessagePreview: 'hello',
  lastMessageAt: 125,
  lastSender: 'peer',
  syncState: 'idle',
  watermark: null,
};
const empty: DmThread = {
  ...thread,
  key: 'xhs:a:me:other',
  contactName: 'Jun',
  contactPlatformId: 'other',
  lastMessageAt: null,
  lastSender: null,
  lastMessagePreview: '',
};
function fixture(selected = thread): DirectMessagesModel {
  return {
    snapshot: { threads: [thread, empty], status: { busy: false, partial: false, feishuConfigured: false } },
    detail: {
      thread: selected,
      messages: [],
      comments: [
        { key: 'one', token: 'token1', workTitle: 'first', content: 'first comment', createdAt: 1 },
        { key: 'two', token: 'token2', workTitle: 'second', content: 'second comment', createdAt: 2 },
      ],
    },
    selected: selected.key,
    pending: undefined,
    error: undefined,
    errorThreadKey: undefined,
    refreshLocal: vi.fn(),
    select: vi.fn(),
    request: vi.fn(),
    run: vi.fn(),
  };
}
it('keeps filtering local and reveals a linked author even with no messages or a conflicting search', () => {
  const model = fixture();
  const props = { accounts: [], lockedAccounts: new Set<string>(), onAccount: vi.fn(), onComment: vi.fn() };
  const page = render(<DirectMessages model={model} {...props} />);
  fireEvent.click(
    within(screen.getByRole('group', { name: 'common.workbench.dm.contacts' })).getByRole('button', {
      name: /dm.pending/,
    })
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ming' } });
  expect(screen.queryByText('Jun')).toBeNull();
  page.rerender(
    <DirectMessages
      model={{ ...model, selected: empty.key, detail: { ...model.detail!, thread: empty } }}
      {...props}
      link={{ key: empty.key, sequence: 1 }}
    />
  );
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByText('common.workbench.dm.filterCleared')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /dm.all/ })).toHaveAttribute('aria-pressed', 'true');
  expect(model.run).not.toHaveBeenCalled();
});
it('opens individual original comments and the account locally; a busy account cannot sync', () => {
  const model = fixture(),
    onComment = vi.fn(),
    onAccount = vi.fn();
  render(
    <DirectMessages
      model={model}
      accounts={[]}
      lockedAccounts={new Set(['a'])}
      onAccount={onAccount}
      onComment={onComment}
    />
  );
  const article = screen.getByRole('article');
  expect(within(article).getByRole('button', { name: 'common.workbench.dm.update' })).toBeDisabled();
  fireEvent.click(within(article).getByRole('button', { name: /dm.comments/ }));
  const second = within(article).getByText('second comment').closest('li')!;
  fireEvent.click(within(second).getByRole('button', { name: 'common.workbench.dm.original' }));
  fireEvent.click(within(article).getByRole('button', { name: 'common.workbench.dm.replyInBrowser' }));
  expect(onComment).toHaveBeenCalledWith('token2');
  expect(onAccount).toHaveBeenCalledWith('a');
  expect(within(article).queryByRole('textbox')).not.toBeInTheDocument();
  expect(model.run).not.toHaveBeenCalled();
});
it('marks gaps of five minutes and keeps consecutive messages and nontext types separate', () => {
  const msg: DmMessage = { id: '0', sender: 'me', timestamp: 100, kind: 'text', text: 'repeat' };
  const messages: DmMessage[] = [
    msg,
    { ...msg, id: '1', timestamp: 101 },
    { ...msg, id: '2', timestamp: 300101, kind: 'image', text: '' },
    { ...msg, id: '3', timestamp: 300102, sender: 'peer', kind: 'recalled', text: '' },
  ];
  const view = render(<MessageStream messages={messages} contactKey='a' />);
  expect(screen.getAllByText('repeat')).toHaveLength(2);
  expect(view.container.querySelectorAll('time')).toHaveLength(2);
  expect(screen.getByText('common.workbench.dm.image')).toBeInTheDocument();
  expect(screen.getByText('common.workbench.dm.recalled')).toBeInTheDocument();
  expect(view.container.querySelector('[data-previous="true"]')).not.toBeNull();
});
it('caps the badge count and keeps tab names stable for keyboard navigation', () => {
  const onChange = vi.fn();
  render(<CenterTabs tab='feishu' onChange={onChange} count={130} />);
  expect(screen.getByRole('tab', { name: 'common.workbench.dm.title' })).toHaveTextContent('99+');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'common.workbench.feishu' }), { key: 'ArrowRight' });
  expect(onChange).toHaveBeenCalledWith('dm');
});

it('keeps reply and collection status independent and limits the detail notice to the selected contact', () => {
  const partial: DmThread = {
    ...thread,
    key: 'douyin:b:me:peer',
    platform: 'douyin',
    accountId: 'b',
    contactName: 'Bo',
    syncState: 'partial',
    partialReason: 'dmHistoryPartial',
  };
  const model = fixture(),
    props = { accounts: [], lockedAccounts: new Set<string>(), onAccount: vi.fn(), onComment: vi.fn() };
  model.snapshot = { threads: [thread, partial], status: { busy: false, feishuConfigured: false, partial: true } };
  const page = render(
    <>
      <DmToolbar model={model} />
      <DirectMessages model={model} {...props} />
    </>
  );
  const bo = screen.getByRole('button', { name: /Bo/ });
  expect(within(bo).getByLabelText('common.workbench.dm.pending')).toBeVisible();
  expect(within(bo).getByLabelText('common.workbench.dm.partial')).toBeVisible();
  expect(screen.getByTitle('common.workbench.dm.partial')).toBeInTheDocument();
  expect(within(screen.getByRole('article')).queryByRole('status')).toBeNull();
  model.error = 'dmLoginRequired';
  model.errorThreadKey = partial.key;
  page.rerender(
    <>
      <DmToolbar model={model} />
      <DirectMessages model={model} {...props} />
    </>
  );
  expect(within(screen.getByRole('article')).queryByRole('status')).toBeNull();
  expect(screen.getByTitle('common.workbench.dm.signIn · common.workbench.dm.partial')).toBeInTheDocument();
  model.error = undefined;
  model.errorThreadKey = undefined;
  model.selected = partial.key;
  page.rerender(
    <>
      <DmToolbar model={model} />
      <DirectMessages model={model} {...props} />
    </>
  );
  expect(within(screen.getByRole('article')).getByRole('status')).toHaveTextContent('common.workbench.dm.partial');
  page.rerender(
    <>
      <DmToolbar model={model} />
      <DirectMessages model={model} {...props} lockedAccounts={new Set(['b'])} syncingAccounts={new Set(['b'])} />
    </>
  );
  expect(within(bo).getByLabelText('common.workbench.dm.pending')).toBeVisible();
  expect(within(bo).getByLabelText('common.workbench.dm.syncingAccount')).toBeVisible();
  expect(within(screen.getByRole('article')).getByRole('status')).toHaveTextContent('common.workbench.dm.busy');
});
