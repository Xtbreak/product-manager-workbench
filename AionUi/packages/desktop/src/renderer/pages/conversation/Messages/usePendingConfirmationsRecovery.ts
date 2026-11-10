/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IConfirmation, IMessageAsk, IMessagePermission, TMessage } from '@/common/chat/chatLib';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  getConversationRuntimeViewSnapshot,
  subscribeConversationRuntimeView,
} from '../runtime/conversationRuntimeViewStore';
import { useMessageList, useUpdateMessageList } from './hooks';

export const pendingConfirmationMsgId = (confirmationId: string) => `confirmation:${confirmationId}`;

export function buildPendingConfirmationMessage(
  conversation_id: string,
  confirmation: IConfirmation<unknown>
): IMessagePermission | IMessageAsk {
  // A pending AskUserQuestion carries its questions[] payload — rebuild the
  // REAL question card (title/multi-question/multiSelect/Other), answered via
  // the ask confirm contract keyed on call_id = request_id. Without this the
  // recovery degraded to a title-less permission card that could only show
  // flattened labels (user report, 2026-08-05).
  if (Array.isArray(confirmation.questions) && confirmation.questions.length > 0) {
    return {
      id: pendingConfirmationMsgId(confirmation.id),
      msg_id: pendingConfirmationMsgId(confirmation.id),
      type: 'ask',
      position: 'left',
      conversation_id,
      created_at: Date.now(),
      content: {
        session_id: conversation_id,
        request_id: confirmation.call_id,
        questions: confirmation.questions,
      },
    };
  }
  return {
    id: pendingConfirmationMsgId(confirmation.id),
    msg_id: pendingConfirmationMsgId(confirmation.id),
    type: 'permission',
    position: 'left',
    conversation_id,
    created_at: Date.now(),
    content: confirmation,
  };
}

export function hasPermissionMessageForCallId(list: TMessage[], callId: string): boolean {
  return list.some(
    (message) =>
      (message.type === 'permission' && message.content?.call_id === callId) ||
      (message.type === 'acp_permission' && message.content?.tool_call?.tool_call_id === callId) ||
      (message.type === 'ask' && message.content?.request_id === callId)
  );
}

export function removePermissionMessage(list: TMessage[], target: { id?: string; call_id?: string }): TMessage[] {
  return list.filter((message) => {
    if (message.type === 'ask') {
      // A recovered ask is keyed by request_id (== call_id == confirmation id).
      if (target.id && message.content.request_id === target.id) return false;
      if (target.call_id && message.content.request_id === target.call_id) return false;
      return true;
    }
    if (message.type === 'acp_permission')
      return (
        message.content.tool_call?.tool_call_id !== target.call_id &&
        message.content.tool_call?.tool_call_id !== target.id
      );
    if (message.type !== 'permission') return true;
    if (target.id && message.content.id === target.id) return false;
    if (target.call_id && message.content.call_id === target.call_id) return false;
    return true;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reconcile only rows present when the request began; late streamed rows belong to a newer snapshot. */
export function reconcilePendingConfirmationMessages(
  list: TMessage[],
  pending: IConfirmation<unknown>[],
  capturedIds: Set<string>
): TMessage[] {
  const calls = new Set(pending.map((c) => c.call_id));
  const next = list.filter((message) => {
    if (!capturedIds.has(message.id)) return true;
    if (message.type === 'permission') return calls.has(message.content.call_id);
    if (message.type === 'acp_permission') return calls.has(message.content.tool_call?.tool_call_id);
    if (message.type === 'ask') return calls.has(message.content.request_id);
    return true;
  });
  return next.length === list.length ? list : next;
}

export function usePendingConfirmationsRecovery(conversation_id: string) {
  const updateMessageList = useUpdateMessageList();
  const list = useMessageList();
  const listRef = useRef(list);
  listRef.current = list;
  const getSnapshot = useCallback(() => getConversationRuntimeViewSnapshot(conversation_id), [conversation_id]);
  const runtime = useSyncExternalStore(subscribeConversationRuntimeView, getSnapshot, getSnapshot);
  const requestRows = list
    .filter((m) => ['permission', 'acp_permission', 'ask'].includes(m.type))
    .map((m) => m.id)
    .join('|');

  useEffect(() => {
    if (!conversation_id) return;
    let cancelled = false;
    let epoch = 0;
    const refresh = () => {
      const requestEpoch = ++epoch;
      const capturedIds = new Set(listRef.current.map((m) => m.id));
      if (runtime.lastStoppedTurnId && !runtime.isProcessing) {
        updateMessageList((rows) => reconcilePendingConfirmationMessages(rows, [], capturedIds));
        return;
      }
      void ipcBridge.conversation.confirmation.list
        .invoke({ conversation_id })
        .then((confirmations) => {
          if (cancelled || requestEpoch !== epoch) return;
          updateMessageList((rows) => {
            let next = reconcilePendingConfirmationMessages(rows, confirmations ?? [], capturedIds);
            for (const confirmation of confirmations ?? []) {
              if (!hasPermissionMessageForCallId(next, confirmation.call_id))
                next = next.concat(buildPendingConfirmationMessage(conversation_id, confirmation));
            }
            return next;
          });
        })
        .catch((error) => {
          if (!cancelled)
            console.warn('[pending-confirmations] failed to recover pending confirmations', {
              conversation_id,
              error: errorMessage(error),
            });
        });
    };
    refresh();
    const off = ipcBridge.conversation.confirmation.remove.on((event) => {
      if (event.conversation_id !== conversation_id) return;
      updateMessageList((rows) => removePermissionMessage(rows, { id: event.id, call_id: event.id }));
      refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [
    conversation_id,
    updateMessageList,
    requestRows,
    runtime.activeTurnId,
    runtime.isProcessing,
    runtime.lastStoppedTurnId,
  ]);
}
