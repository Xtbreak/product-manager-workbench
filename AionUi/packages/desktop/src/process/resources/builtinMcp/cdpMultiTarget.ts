import { decideCdpCommand, type CdpDecision, type CdpRequest, type TargetInfo } from './cdpTargetProtocol';

/** A session belongs to exactly one webContents lifetime. */
export const targetSessionId = (targetId: string): string => `session:${targetId}`;
type Decision = Exclude<CdpDecision, { kind: 'forward' }> | { kind: 'forward'; targetId: string };

/** Route only registered page sessions; never fall back to a visible/default account. */
export function decideMultiTargetCommand(req: CdpRequest, targets: TargetInfo[]): Decision {
  const selected = targets.find((t) => targetSessionId(t.targetId) === req.sessionId);
  if (req.sessionId && !selected)
    return { kind: 'error', message: 'Unknown or closed browser session. List pages again.' };
  const reply = (payload: Record<string, unknown> = {}): Decision => ({ kind: 'reply', payload });
  const announce = (pages: TargetInfo[]): Decision => ({
    kind: 'reply-and-emit',
    payload: {},
    emit: pages.map((targetInfo) => ({
      method: 'Target.attachedToTarget',
      params: { sessionId: targetSessionId(targetInfo.targetId), targetInfo, waitingForDebugger: false },
    })),
  });
  switch (req.method) {
    case 'Target.getTargets':
      return reply({ targetInfos: targets });
    case 'Target.getBrowserContexts':
      return reply({ browserContextIds: [...new Set(targets.map((t) => t.browserContextId))] });
    case 'Target.setDiscoverTargets':
      return req.params?.discover === true
        ? {
            kind: 'reply-and-emit',
            payload: {},
            emit: targets.map((targetInfo) => ({ method: 'Target.targetCreated', params: { targetInfo } })),
          }
        : reply();
    case 'Target.setAutoAttach':
      return !req.sessionId && req.params?.autoAttach === true ? announce(targets) : reply();
    case 'Target.getTargetInfo': {
      const target = req.params?.targetId ? targets.find((t) => t.targetId === req.params?.targetId) : selected;
      return target
        ? reply({ targetInfo: target })
        : { kind: 'error', message: 'Select an existing target explicitly.' };
    }
    case 'Target.attachToTarget': {
      const target = targets.find((t) => t.targetId === req.params?.targetId);
      if (!target) return { kind: 'error', message: 'Unknown or closed target. List pages again.' };
      const result = announce([target]);
      if (result.kind === 'reply-and-emit') result.payload = { sessionId: targetSessionId(target.targetId) };
      return result;
    }
    case 'Target.detachFromTarget':
      return reply();
    case 'Target.closeTarget':
      return { kind: 'error', message: 'Close account windows from the workbench.' };
    case 'Browser.getVersion':
      return reply({
        protocolVersion: '1.3',
        product: `Chrome/${process.versions.chrome ?? '0'}`,
        revision: '',
        userAgent: 'Workbench',
        jsVersion: process.versions.v8,
      });
    default: {
      // Retain the existing prohibitions on creating contexts/windows and closing the app.
      const decision = decideCdpCommand(req, () => selected ?? targets[0]);
      if (decision.kind !== 'forward') return decision;
      return selected
        ? { kind: 'forward', targetId: selected.targetId }
        : { kind: 'error', message: 'A registered page session is required.' };
    }
  }
}
