import React, { useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { IConfirmation, TMessage } from '@/common/chat/chatLib';
import { usePendingConfirmationsRecovery } from '@/renderer/pages/conversation/Messages/usePendingConfirmationsRecovery';
import {
  hydrateSucceeded,
  localStopRequested,
  localStopAcknowledged,
  localSendStarted,
  localSendAccepted,
  resetConversationRuntimeViewStoreForTest,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(() => () => {}),
  rows: [] as TMessage[],
  update: undefined as unknown as React.Dispatch<React.SetStateAction<TMessage[]>>,
}));
vi.mock('@/common', () => ({
  ipcBridge: { conversation: { confirmation: { list: { invoke: mocks.list }, remove: { on: mocks.remove } } } },
}));
vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useMessageList: () => mocks.rows,
  useUpdateMessageList: () => mocks.update,
}));
const confirmation = (id: string): IConfirmation<unknown> => ({
  id,
  call_id: id,
  description: id,
  options: [{ label: 'Allow', value: 'allow' }],
});
const row = (id: string): TMessage => ({ id, conversation_id: 'conv', type: 'permission', content: confirmation(id) });
const runtime = (turn: string | null) => ({
  state: turn ? ('waiting_confirmation' as const) : ('idle' as const),
  is_processing: !!turn,
  can_send_message: !turn,
  turn_id: turn,
  has_task: !!turn,
  pending_confirmations: turn ? 1 : 0,
});
function Harness({ initial }: { initial: TMessage[] }) {
  const [rows, update] = useState(initial);
  mocks.rows = rows;
  mocks.update = update;
  usePendingConfirmationsRecovery('conv');
  return (
    <div>
      {rows.map((r) => (
        <span key={r.id}>{r.id}</span>
      ))}
    </div>
  );
}
afterEach(() => {
  cleanup();
  resetConversationRuntimeViewStoreForTest();
  vi.clearAllMocks();
});
it('does not resurrect a stopped request when an earlier HTTP response arrives after retry', async () => {
  let resolveOld!: (value: IConfirmation<unknown>[]) => void;
  mocks.list
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    )
    .mockResolvedValue([confirmation('new')]);
  hydrateSucceeded('conv', runtime('old-turn'));
  render(<Harness initial={[row('old')]} />);
  act(() => {
    localStopRequested('conv', 'old-turn');
    localStopAcknowledged('conv', 'old-turn', runtime(null));
  });
  await waitFor(() => expect(screen.queryByText('old')).toBeNull());
  act(() => {
    localSendStarted('conv');
    localSendAccepted('conv', 'new-turn', runtime('new-turn'));
  });
  await waitFor(() => expect(screen.getByText('confirmation:new')).toBeTruthy());
  await act(async () => {
    resolveOld([confirmation('old')]);
  });
  expect(screen.queryByText('confirmation:old')).toBeNull();
});
it('prunes historical authorization cards after reload when no request is pending', async () => {
  mocks.list.mockResolvedValue([]);
  hydrateSucceeded('conv', runtime(null));
  render(
    <Harness
      initial={[row('old'), { id: 'reply', conversation_id: 'conv', type: 'text', content: { content: 'reply' } }]}
    />
  );
  await waitFor(() => expect(screen.queryByText('old')).toBeNull());
  expect(screen.getByText('reply')).toBeTruthy();
});
