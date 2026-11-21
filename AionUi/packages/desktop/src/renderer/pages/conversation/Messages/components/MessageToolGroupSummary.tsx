import type { BadgeProps } from '@arco-design/web-react';
import { Badge, Button, Message, Spin, Tooltip } from '@arco-design/web-react';
import { IconDown, IconRight } from '@arco-design/web-react/icon';
import { Checklist, Download, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { getAcpImageFileName } from '@/common/chat/acpToolCallOutput';
import type { NormalizedToolCall, NormalizedToolStatus, ToolMessage } from '@/common/chat/normalizeToolCall';
import { normalizeToolMessages, hasRunningToolMessages } from '@/common/chat/normalizeToolCall';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import LocalImageView from '@/renderer/components/media/LocalImageView';
import { downloadFileFromPath } from '@/renderer/utils/file/download';
import './MessageToolGroupSummary.css';

const statusToBadge = (status: NormalizedToolStatus): BadgeProps['status'] => {
  switch (status) {
    case 'completed':
      return 'success';
    case 'error':
      return 'error';
    case 'running':
      return 'processing';
    case 'canceled':
      return 'default';
    case 'pending':
    default:
      return 'default';
  }
};

const ToolItemDetail: React.FC<{ item: NormalizedToolCall }> = ({ item }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [fullItem, setFullItem] = useState<NormalizedToolCall | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const displayItem = fullItem ?? item;
  const hasDetail = displayItem.input || displayItem.output || item.truncated || item.imagePath;
  const [messageApi, messageContext] = Message.useMessage();
  const handleDownloadImage = useCallback(
    async (path: string) => {
      try {
        await downloadFileFromPath(path, getAcpImageFileName(path));
        messageApi.success(t('acp.image.download_success'));
      } catch (error) {
        console.error('[MessageToolGroupSummary] Failed to download image:', error);
        messageApi.error(t('acp.image.download_error'));
      }
    },
    [messageApi, t]
  );

  const loadFullItem = async () => {
    if (!item.truncated || fullItem || loadingFull || !item.conversationId || !item.messageId) return;
    setLoadingFull(true);
    setLoadError(false);
    try {
      const message = await ipcBridge.database.getConversationMessage.invoke({
        conversation_id: item.conversationId,
        message_id: item.messageId,
      });
      const next = normalizeToolMessages([message as ToolMessage]).find((candidate) => candidate.key === item.key);
      if (next) setFullItem(next);
    } catch {
      setLoadError(true);
    } finally {
      setLoadingFull(false);
    }
  };

  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded) void loadFullItem();
  };

  return (
    <div className='flex flex-col'>
      {messageContext}
      <div className='flex flex-row color-#86909C gap-12px items-center'>
        <Badge status={statusToBadge(item.status)} className={item.status === 'running' ? 'badge-breathing' : ''} />
        <span
          className={
            'flex-1 min-w-0' +
            (expanded ? ' break-all' : ' truncate') +
            (hasDetail ? ' cursor-pointer hover:color-#4E5969' : '')
          }
          onClick={hasDetail ? toggleExpanded : undefined}
        >
          <span className='font-medium text-13px'>{displayItem.name}</span>
          {displayItem.description && displayItem.description !== displayItem.name && (
            <span className='m-l-4px opacity-80 text-13px'>{displayItem.description}</span>
          )}
        </span>
        {hasDetail && (
          <span className='flex-shrink-0 cursor-pointer hover:color-#4E5969 transition-colors' onClick={toggleExpanded}>
            {expanded ? <IconDown style={{ fontSize: 12 }} /> : <IconRight style={{ fontSize: 12 }} />}
          </span>
        )}
      </div>
      {expanded && hasDetail && (
        <div className='tool-detail-panel m-l-20px m-t-4px'>
          {loadingFull && <div className='tool-detail-label'>Loading...</div>}
          {loadError && <div className='tool-detail-label'>Failed to load full output</div>}
          {displayItem.input && (
            <div className='tool-detail-section'>
              <div className='tool-detail-label'>Input</div>
              <pre className='tool-detail-content'>{displayItem.input}</pre>
            </div>
          )}
          {displayItem.output && (
            <div className='tool-detail-section'>
              <div className='tool-detail-label'>Output</div>
              <pre className='tool-detail-content'>{displayItem.output}</pre>
            </div>
          )}
        </div>
      )}
      {item.imagePath && (
        <div className='group relative m-l-20px m-t-8px overflow-hidden rounded border bg-1 p-2 max-w-280px'>
          <LocalImageView
            src={item.imagePath}
            alt={getAcpImageFileName(item.imagePath)}
            className='max-w-full max-h-320px object-contain rounded'
          />
          <Tooltip content={t('acp.image.download')}>
            <Button
              aria-label={t('acp.image.download_aria')}
              className='!absolute end-10px top-10px !h-28px !w-28px !p-0 opacity-0 shadow-sm transition-opacity group-hover:opacity-90 focus:opacity-100'
              type='secondary'
              size='mini'
              shape='circle'
              icon={<Download theme='outline' size='14' />}
              onClick={() => void handleDownloadImage(item.imagePath)}
            />
          </Tooltip>
        </div>
      )}
    </div>
  );
};

// Only structured operation names choose these labels; never display or interpret tool code/output.
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const workbenchStep = (tool: NormalizedToolCall) => {
  let input: Record<string, unknown> = {};
  try {
    input = asRecord(JSON.parse(tool.input ?? '{}'));
  } catch {
    // Older tool messages may contain plain text instead of structured arguments.
  }
  const name = typeof input.tool === 'string' ? input.tool : tool.name;
  const args = typeof input.tool === 'string' ? asRecord(input.arguments) : input;
  if (name === 'workbench') {
    if (args.action === 'reply-sync') {
      const request = asRecord(args.request);
      switch (request.action) {
        case 'status':
          return 'common.workbench.steps.checkStatus';
        case 'collect':
        case 'sync':
          return 'common.workbench.steps.syncComments';
        case 'send-pending':
          return 'common.workbench.steps.processReplies';
        case 'cancel':
          return 'common.workbench.steps.stopReplies';
        case 'open-comment':
        case 'resolve-comment':
          return 'common.workbench.steps.browse';
        case 'reconcile':
          return 'common.workbench.steps.checkResult';
        case 'enabled':
          if (request.enabled === true) return 'common.workbench.steps.startReplies';
          if (request.enabled === false) return 'common.workbench.steps.pauseReplies';
          break;
        case 'setup':
        case 'configure':
          return 'common.workbench.steps.prepareTable';
        case 'bind':
          return 'common.workbench.steps.bindWork';
      }
    }
    switch (args.action) {
      case 'accounts':
      case 'feishu-status':
      case 'status':
        return 'common.workbench.steps.checkStatus';
      case 'browser':
        return 'common.workbench.steps.browse';
      case 'collect':
        return 'common.workbench.steps.readComments';
      case 'cli-sync':
      case 'paste':
        return 'common.workbench.steps.updateTable';
      case 'reconcile':
        return 'common.workbench.steps.checkResult';
    }
  }
  if (name === 'browser_repl') return 'common.workbench.steps.browse';
  if (['read', 'ReadFile', 'read_file'].includes(name) || tool.description === 'read')
    return 'common.workbench.steps.read';
  if (['search', 'grep', 'glob', 'rg'].includes(name) || ['search', 'grep', 'glob'].includes(tool.description ?? ''))
    return 'common.workbench.steps.search';
  if (
    ['edit', 'write', 'WriteFile', 'write_file', 'apply_patch', 'acp-file-edit'].includes(name) ||
    ['edit', 'write'].includes(tool.description ?? '')
  )
    return 'common.workbench.steps.edit';
  return 'common.workbench.steps.process';
};

const stepStatusPriority: Record<NormalizedToolStatus, number> = {
  error: 5,
  running: 4,
  pending: 3,
  canceled: 2,
  completed: 1,
};
const stepStatusLabel = {
  pending: 'common.workbench.executionPending',
  running: 'common.workbench.executionRunning',
  completed: 'common.workbench.executionEnded',
  error: 'common.workbench.executionFailed',
  canceled: 'common.workbench.executionStopped',
} as const;
const activeStep = (status: NormalizedToolStatus) => status === 'running' || status === 'pending';

const MessageToolGroupSummary: React.FC<{ messages: ToolMessage[] }> = ({ messages }) => {
  const { t } = useTranslation();
  const compact = useLayoutContext()?.workbench === true;
  const hasRunning = hasRunningToolMessages(messages);
  const [showMore, setShowMore] = useState(!compact && hasRunning);

  useEffect(() => {
    if (!compact && hasRunning) setShowMore(true);
  }, [compact, hasRunning]);

  const tools = useMemo(() => normalizeToolMessages(messages), [messages]);
  if (compact) {
    const steps: Array<{ label: ReturnType<typeof workbenchStep>; status: NormalizedToolStatus }> = [];
    for (const tool of tools) {
      if (!activeStep(tool.status)) continue;
      const label = workbenchStep(tool);
      const previous = steps.at(-1);
      if (previous?.label === label) {
        if (stepStatusPriority[tool.status] > stepStatusPriority[previous.status]) previous.status = tool.status;
      } else steps.push({ label, status: tool.status });
    }
    if (!steps.length) return null;
    return (
      <ul
        className='list-none m-0 py-4px px-0 flex flex-col gap-6px text-13px'
        aria-label={t('common.workbench.executionSteps')}
      >
        {steps.map((step, index) => (
          <li key={`${index}-${step.label}`} className='flex items-start gap-8px leading-20px text-t-secondary'>
            <span aria-hidden='true' className='shrink-0 inline-flex items-center justify-center w-14px h-20px'>
              {step.status === 'running' ? (
                <Spin size={12} />
              ) : (
                <span className='w-5px h-5px rounded-full bg-current' />
              )}
            </span>
            <span>{t(step.label)}</span>
            <span className='shrink-0' style={{ color: 'var(--color-text-3)' }}>
              {t(stepStatusLabel[step.status])}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className='tool-group-summary'>
      <div className='tool-group-summary__header' onClick={() => setShowMore(!showMore)}>
        <span className='tool-group-summary__icon'>
          {hasRunning ? <Spin size={12} /> : <Checklist theme='outline' size='14' />}
        </span>
        <span className='tool-group-summary__label'>View Steps {tools.length > 0 ? `· ${tools.length}` : ''}</span>
        <span className={`tool-group-summary__arrow${showMore ? ' tool-group-summary__arrow--open' : ''}`}>
          <Right theme='outline' size='12' />
        </span>
      </div>
      {showMore && (
        <div className='tool-group-summary__body'>
          {tools.map((item) => (
            <ToolItemDetail key={item.key} item={item} />
          ))}
        </div>
      )}
    </div>
  );
};

export default React.memo(MessageToolGroupSummary);
