import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { IMessageAcpTerminalOutput, IMessageToolCall, TMessage } from '@/common/chat/chatLib';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import { LayoutContext } from '@/renderer/hooks/context/LayoutContext';
import MessageAcpTerminalOutput from '@/renderer/pages/conversation/Messages/acp/MessageAcpTerminalOutput';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';

vi.mock('@/common', () => ({
  ipcBridge: {
    database: {
      getConversationMessage: {
        invoke: vi.fn(),
      },
    },
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function Workbench({ children }: React.PropsWithChildren) {
  return (
    <LayoutContext.Provider
      value={{ isMobile: false, siderCollapsed: true, setSiderCollapsed: () => {}, workbench: true }}
    >
      {children}
    </LayoutContext.Provider>
  );
}

const internalTool = (status: IMessageToolCall['content']['status']): IMessageToolCall => ({
  id: 'internal-call',
  conversation_id: 'conversation-1',
  type: 'tool_call',
  content: {
    call_id: 'internal-call',
    name: 'mcpToolCall',
    status,
    args: { privateArgument: 'INTERNAL_ARGUMENT' },
    output: 'INTERNAL_RESULT',
  },
});

describe('MessageToolGroupSummary', () => {
  it('loads full tool content when expanding a compact history item', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessage.invoke);
    invoke.mockResolvedValue({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          raw_input: { pattern: 'needle', path: '.' },
          content: [{ type: 'content', content: { type: 'text', text: 'full output' } }],
        },
      },
    } as unknown as TMessage);

    render(
      <MessageToolGroupSummary
        messages={[
          {
            id: 'message-1',
            conversation_id: 'conversation-1',
            type: 'acp_tool_call',
            content: {
              _compact: {
                truncated: true,
                original_size: 90000,
                preview_chars: 4096,
              },
              update: {
                session_update: 'tool_call',
                tool_call_id: 'tool-1',
                status: 'completed',
                title: 'rg',
                kind: 'search',
                raw_input: { pattern: 'needle', path: '.' },
                content: [{ type: 'content', content: { type: 'text', text: 'preview' } }],
              },
            },
          } as unknown as ToolMessage,
        ]}
      />
    );

    fireEvent.click(screen.getByText('View Steps · 1'));
    fireEvent.click(screen.getByText('rg'));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({
        conversation_id: 'conversation-1',
        message_id: 'message-1',
      });
    });
    expect(await screen.findByText('full output')).toBeInTheDocument();
  });
});

const replyTool = (
  action: string,
  status: IMessageToolCall['content']['status'] = 'completed',
  enabled?: boolean
): IMessageToolCall => ({
  ...internalTool(status),
  content: {
    ...internalTool(status).content,
    args: {
      tool: 'workbench',
      server: 'aionui-browser',
      arguments: { action: 'reply-sync', request: { action, enabled } },
    },
  },
});

describe('Workbench task steps', () => {
  it('shows a plain running step without any detail disclosure', () => {
    const { rerender } = render(<MessageToolGroupSummary messages={[internalTool('running')]} />, {
      wrapper: Workbench,
    });
    fireEvent.click(screen.getByRole('list', { name: 'common.workbench.executionSteps' }));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/INTERNAL_ARGUMENT|INTERNAL_RESULT|mcpToolCall/)).not.toBeInTheDocument();
    rerender(<MessageToolGroupSummary messages={[internalTool('completed')]} />);
    expect(screen.getByText('common.workbench.executionEnded')).toBeInTheDocument();
  });

  it.each(['args', 'input'] as const)('uses actual MCP %s to show the current reply step', (field) => {
    const message = replyTool('collect', 'running');
    message.content[field] = message.content.args;
    render(<MessageToolGroupSummary messages={[message]} />, { wrapper: Workbench });
    expect(screen.getByText('common.workbench.steps.syncComments')).toBeInTheDocument();
    expect(screen.getByText('common.workbench.executionRunning')).toBeInTheDocument();
  });

  it('distinguishes historical activation from read-only sync and preserves step order', () => {
    render(
      <MessageToolGroupSummary
        messages={[replyTool('status'), replyTool('enabled', 'completed', true), replyTool('sync', 'running')]}
      />,
      { wrapper: Workbench }
    );
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows).toEqual([
      'common.workbench.steps.checkStatuscommon.workbench.executionEnded',
      'common.workbench.steps.startRepliescommon.workbench.executionEnded',
      'common.workbench.steps.syncCommentscommon.workbench.executionRunning',
    ]);
  });

  it.each([
    ['send-pending', 'processReplies'],
    ['cancel', 'stopReplies'],
    ['open-comment', 'browse'],
  ])('describes the explicit %s action without exposing tool details', (action, label) => {
    render(<MessageToolGroupSummary messages={[replyTool(action, 'running')]} />, { wrapper: Workbench });
    expect(screen.getByText(`common.workbench.steps.${label}`)).toBeInTheDocument();
    expect(screen.queryByText(/INTERNAL_ARGUMENT|INTERNAL_RESULT/)).not.toBeInTheDocument();
  });

  it('combines repeated adjacent steps while keeping a failure visible', () => {
    render(<MessageToolGroupSummary messages={[replyTool('status', 'error'), replyTool('status')]} />, {
      wrapper: Workbench,
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('common.workbench.executionFailed')).toBeInTheDocument();
    expect(screen.queryByText('INTERNAL_RESULT')).not.toBeInTheDocument();
  });

  it.each(['running', 'pending'] as const)('keeps a %s retry visible after a failed step', (status) => {
    render(<MessageToolGroupSummary messages={[replyTool('status', 'error'), replyTool('status', status)]} />, {
      wrapper: Workbench,
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('common.workbench.executionFailed')).toBeInTheDocument();
    expect(
      screen.getByText(`common.workbench.execution${status === 'running' ? 'Running' : 'Pending'}`)
    ).toBeInTheDocument();
  });

  it('does not hide an active step when a matching concurrent step fails', () => {
    render(<MessageToolGroupSummary messages={[replyTool('status', 'running'), replyTool('status', 'error')]} />, {
      wrapper: Workbench,
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('common.workbench.executionRunning')).toBeInTheDocument();
    expect(screen.getByText('common.workbench.executionFailed')).toBeInTheDocument();
  });

  it('does not infer a step from arbitrary code or descriptions', () => {
    const message = internalTool('completed');
    message.content.description = 'readComments sync success';
    message.content.args = { code: 'workbench({action: "reply-sync"})' };
    render(<MessageToolGroupSummary messages={[message]} />, { wrapper: Workbench });
    expect(screen.getByText('common.workbench.steps.process')).toBeInTheDocument();
    expect(screen.queryByText(/readComments sync success|workbench\(/)).not.toBeInTheDocument();
  });

  it('never renders code diffs in Workbench steps', () => {
    const edit = {
      id: 'edit',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          tool_call_id: 'edit',
          title: 'acp-file-edit',
          status: 'completed',
          kind: 'edit',
          content: [
            { type: 'diff', path: '/workspace/file.ts', old_text: 'OLD_CODE_MARKER', new_text: 'NEW_CODE_MARKER' },
          ],
        },
      },
    } as ToolMessage;
    render(<MessageToolGroupSummary messages={[edit]} />, { wrapper: Workbench });
    expect(screen.getByText('common.workbench.steps.edit')).toBeInTheDocument();
    expect(screen.queryByText(/OLD_CODE_MARKER|NEW_CODE_MARKER|file.ts/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('preserves automatic running-tool expansion outside Workbench', () => {
    render(<MessageToolGroupSummary messages={[internalTool('running')]} />);
    expect(screen.getByText('mcpToolCall')).toBeInTheDocument();
  });

  it('cannot carry open details from ordinary chat into Workbench', () => {
    const { rerender } = render(<MessageToolGroupSummary messages={[internalTool('running')]} />);
    fireEvent.click(screen.getByText('mcpToolCall'));
    rerender(
      <Workbench>
        <MessageToolGroupSummary messages={[internalTool('running')]} />
      </Workbench>
    );
    expect(screen.queryByText('INTERNAL_RESULT')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  const terminal: IMessageAcpTerminalOutput = {
    id: 'terminal',
    conversation_id: 'conversation-1',
    type: 'acp_terminal_output',
    content: {
      terminal_id: 'terminal',
      command: 'INTERNAL_COMMAND',
      output: 'INTERNAL_TERMINAL_OUTPUT',
      truncated: false,
    },
  };

  it('hides live terminal commands and output with only the stop action available', () => {
    render(<MessageAcpTerminalOutput message={terminal} />, { wrapper: Workbench });
    expect(
      screen.queryByText(/INTERNAL_COMMAND|INTERNAL_TERMINAL_OUTPUT|common.workbench.executionDetails/)
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toEqual([screen.getByTestId('terminal-card-stop')]);
    expect(screen.getByText('common.workbench.steps.process')).toBeInTheDocument();
  });

  it.each([
    [{ exit_code: 0 }, 'executionEnded'],
    [{ exit_code: 1 }, 'executionFailed'],
    [{ signaled: true }, 'executionStopped'],
  ])('shows a plain terminal outcome without exit codes: %j', (exit, label) => {
    const message = { ...terminal, content: { ...terminal.content, exit_status: exit } } as IMessageAcpTerminalOutput;
    render(<MessageAcpTerminalOutput message={message} />, { wrapper: Workbench });
    expect(screen.getByText(`common.workbench.${label}`)).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-card-output')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
