import type { IConfirmation, TMessage } from '@/common/chat/chatLib';
import { describe, expect, it } from 'vitest';
import {
  buildPendingConfirmationMessage,
  hasPermissionMessageForCallId,
  removePermissionMessage,
  reconcilePendingConfirmationMessages,
} from '@/renderer/pages/conversation/Messages/usePendingConfirmationsRecovery';

const confirmation: IConfirmation<string> = {
  id: 'tool-1',
  call_id: 'tool-1',
  title: 'Write file',
  description: 'Write /tmp/current_time.txt',
  command_type: 'edit',
  options: [{ label: 'Allow', value: 'allow_once' }],
};

describe('pending confirmations recovery', () => {
  it('builds a permission message with stable msg_id from confirmation id', () => {
    const message = buildPendingConfirmationMessage('conv-1', confirmation);

    expect(message.type).toBe('permission');
    expect(message.conversation_id).toBe('conv-1');
    expect(message.msg_id).toBe('confirmation:tool-1');
    expect(message.content.call_id).toBe('tool-1');
  });

  it('detects existing permission messages by call_id', () => {
    const list = [buildPendingConfirmationMessage('conv-1', confirmation)];

    expect(hasPermissionMessageForCallId(list, 'tool-1')).toBe(true);
    expect(hasPermissionMessageForCallId(list, 'tool-2')).toBe(false);
  });

  it('removes recovered permission messages by confirmation id or call_id', () => {
    const list = [
      buildPendingConfirmationMessage('conv-1', confirmation),
      { id: 'text-1', type: 'text', conversation_id: 'conv-1', content: { content: 'hello' } },
    ] as TMessage[];

    const result = removePermissionMessage(list, { id: 'tool-1', call_id: 'tool-1' });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
  });
});

describe('authorization lifecycle', () => {
  const acp = {
    id: 'acp-old',
    type: 'acp_permission',
    conversation_id: 'conv-1',
    content: { tool_call: { tool_call_id: 'tool-1' }, options: [] },
  } as TMessage;
  it('recognizes and removes ACP authorization cards as well as recovery cards', () => {
    expect(hasPermissionMessageForCallId([acp], 'tool-1')).toBe(true);
    expect(removePermissionMessage([acp], { call_id: 'tool-1' })).toEqual([]);
  });
  it('removes inactive history requests but preserves messages received after the snapshot', () => {
    const old = buildPendingConfirmationMessage('conv-1', confirmation);
    const fresh = buildPendingConfirmationMessage('conv-1', { ...confirmation, id: 'new', call_id: 'new' });
    expect(reconcilePendingConfirmationMessages([old, acp, fresh], [], new Set([old.id, acp.id]))).toEqual([fresh]);
  });
  it('keeps only the pending request when retry begins', () => {
    const old = buildPendingConfirmationMessage('conv-1', confirmation);
    const fresh = buildPendingConfirmationMessage('conv-1', { ...confirmation, id: 'new', call_id: 'new' });
    expect(
      reconcilePendingConfirmationMessages(
        [old, fresh],
        [{ ...confirmation, id: 'new', call_id: 'new' }],
        new Set([old.id, fresh.id])
      )
    ).toEqual([fresh]);
  });
});
