import { useCallback, useEffect, useRef, useState } from 'react';
import { application } from '@/common/adapter/ipcBridge';
import type { DmSyncAction, DmSyncResult } from '@/common/types/platform/workbenchDm';

export function useDirectMessages(desktop: boolean) {
  const [snapshot, setSnapshot] = useState<Pick<DmSyncResult, 'threads' | 'status'>>();
  const [detail, setDetail] = useState<DmSyncResult['detail']>();
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState<DmSyncAction['action']>();
  const [failure, setFailure] = useState<{ code: string; threadKey?: string }>();
  const selectedRef = useRef('');
  const mounted = useRef(false);
  const serial = useRef(0);
  const lastSnapshot = useRef(0);
  const operation = useRef(false);
  const commandError = useRef<string | undefined>(undefined);
  const lastDetail = useRef(0);
  const request = useCallback(async (action: DmSyncAction) => {
    const order = ++serial.current;
    const command = ['sync-contact', 'sync-all', 'configure-feishu', 'cancel'].includes(action.action);
    try {
      const reply = await application.dmSync.invoke(action);
      if (!mounted.current) return;
      if (!reply.success || !reply.data) throw new Error(reply.msg || 'dmOperationFailed');
      if (order >= lastSnapshot.current) {
        setSnapshot({ threads: reply.data.threads, status: reply.data.status });
        lastSnapshot.current = order;
      }
      if (reply.data.detail && reply.data.detail.thread.key === selectedRef.current && order >= lastDetail.current) {
        lastDetail.current = order;
        setDetail(reply.data.detail);
      }
      return reply.data;
    } catch (e) {
      const code = e instanceof Error ? e.message : 'dmOperationFailed';
      if (command) commandError.current = code;
      const currentRead = action.action !== 'thread' || action.key === selectedRef.current;
      if (mounted.current && (command || (currentRead && !commandError.current && order >= lastSnapshot.current)))
        setFailure({
          code,
          threadKey: action.action === 'thread' || action.action === 'sync-contact' ? action.key : undefined,
        });
      return undefined;
    }
  }, []);
  const refreshLocal = useCallback(() => {
    if (!desktop) return;
    const key = selectedRef.current;
    void request(key ? { action: 'thread', key } : { action: 'list' });
  }, [desktop, request]);
  useEffect(() => {
    mounted.current = true;
    refreshLocal();
    return () => {
      mounted.current = false;
    };
  }, [refreshLocal]);
  const select = useCallback(
    (key: string) => {
      if (selectedRef.current !== key) setDetail(undefined);
      selectedRef.current = key;
      setSelected(key);
      commandError.current = undefined;
      setFailure(undefined);
      return request({ action: 'thread', key });
    },
    [request]
  );
  const run = useCallback(
    async (action: DmSyncAction) => {
      if (operation.current && action.action !== 'cancel') return;
      commandError.current = undefined;
      setFailure(undefined);
      if (action.action === 'cancel') return request(action);
      operation.current = true;
      setPending(action.action);
      try {
        return await request(action);
      } finally {
        operation.current = false;
        if (mounted.current) {
          setPending(undefined);
          refreshLocal();
        }
      }
    },
    [request, refreshLocal]
  );
  return {
    snapshot,
    detail,
    selected,
    select,
    pending,
    error: failure?.code,
    errorThreadKey: failure?.threadKey,
    request,
    run,
    refreshLocal,
  };
}
export type DirectMessagesModel = ReturnType<typeof useDirectMessages>;
