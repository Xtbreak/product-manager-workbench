import { describe, expect, it } from 'vitest';
import { decideMultiTargetCommand, targetSessionId } from '@/process/resources/builtinMcp/cdpMultiTarget';
import type { TargetInfo } from '@/process/resources/builtinMcp/cdpTargetProtocol';
const targets: TargetInfo[] = ['account-a', 'account-b', 'feishu'].map((id) => ({
  targetId: id,
  title: id,
  url: 'https://example.com/',
  type: 'page',
  attached: true,
  canAccessOpener: false,
  browserContextId: id,
}));
describe('registered browser targets', () => {
  it('enumerates all independent pages and auto-attaches each session', () => {
    expect(decideMultiTargetCommand({ method: 'Target.getTargets' }, targets)).toMatchObject({
      payload: { targetInfos: targets },
    });
    const result = decideMultiTargetCommand({ method: 'Target.setAutoAttach', params: { autoAttach: true } }, targets);
    expect(result).toMatchObject({
      kind: 'reply-and-emit',
      emit: targets.map((t) => ({
        method: 'Target.attachedToTarget',
        params: { sessionId: targetSessionId(t.targetId), targetInfo: t },
      })),
    });
  });
  it('routes commands by session, never by the foreground page', () => {
    expect(
      decideMultiTargetCommand({ method: 'Runtime.evaluate', sessionId: targetSessionId('account-b') }, targets)
    ).toEqual({ kind: 'forward', targetId: 'account-b' });
    expect(decideMultiTargetCommand({ method: 'Runtime.evaluate' }, targets)).toMatchObject({ kind: 'error' });
  });
  it('rejects stale targets and sessions instead of using another account', () => {
    expect(
      decideMultiTargetCommand({ method: 'Runtime.evaluate', sessionId: targetSessionId('closed') }, targets)
    ).toMatchObject({ kind: 'error' });
    expect(
      decideMultiTargetCommand({ method: 'Target.attachToTarget', params: { targetId: 'closed' } }, targets)
    ).toMatchObject({ kind: 'error' });
  });
  it('does not recursively announce sessions or close app/profile', () => {
    expect(
      decideMultiTargetCommand(
        { method: 'Target.setAutoAttach', sessionId: targetSessionId('account-a'), params: { autoAttach: true } },
        targets
      )
    ).toEqual({ kind: 'reply', payload: {} });
    expect(decideMultiTargetCommand({ method: 'Browser.close' }, targets)).toMatchObject({ kind: 'error' });
    expect(
      decideMultiTargetCommand({ method: 'Target.closeTarget', params: { targetId: 'account-a' } }, targets)
    ).toMatchObject({ kind: 'error' });
  });
});
