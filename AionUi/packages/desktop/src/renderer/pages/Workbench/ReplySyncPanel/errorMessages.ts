const ERROR_KEYS = {
  replyDraftChanged: 'common.workbench.replySync.errors.replyDraftChanged',
  replyThreadIncomplete: 'common.workbench.replySync.errors.replyThreadIncomplete',
  replySourceIdentityChanged: 'common.workbench.replySync.errors.replySourceIdentityChanged',
  replyDuplicateWork: 'common.workbench.replySync.errors.replyDuplicateWork',
  replyDuplicateComment: 'common.workbench.replySync.errors.replyDuplicateComment',
  replyOwnComment: 'common.workbench.replySync.errors.replyOwnComment',
  replyCommentLinkInvalid: 'common.workbench.replySync.errors.replyCommentLinkInvalid',
  replyManualModeRequired: 'common.workbench.replySync.errors.replyManualModeRequired',
  replySendButtonRequired: 'common.workbench.replySync.errors.replySendButtonRequired',
  replyPresentationConflict: 'common.workbench.replySync.errors.replyPresentationConflict',
  replyPresentationUnverified: 'common.workbench.replySync.errors.replyPresentationUnverified',
  replyCliFailed: 'common.workbench.replySync.errors.replyCliFailed',
  replyFieldSchemaChanged: 'common.workbench.replySync.errors.replyFieldSchemaChanged',
  replyInvalidResponse: 'common.workbench.replySync.errors.replyInvalidResponse',
  replyPauseRequired: 'common.workbench.replySync.errors.replyPauseRequired',
  replyVerificationRequired: 'common.workbench.replySync.errors.replyVerificationRequired',
  replyAccountMismatch: 'common.workbench.replySync.errors.replyAccountMismatch',
  replyDraftPresent: 'common.workbench.replySync.errors.replyDraftPresent',
  replyTargetUnavailable: 'common.workbench.replySync.errors.replyTargetUnavailable',
  replyBrowserClosed: 'common.workbench.replySync.errors.replyBrowserClosed',
  replyBrowserBusy: 'common.workbench.replySync.errors.replyBrowserBusy',
  replyApprovalInterrupted: 'common.workbench.replySync.errors.replyApprovalInterrupted',
  replyStoreInvalid: 'common.workbench.replySync.errors.replyStoreInvalid',
  replyResultPending: 'common.workbench.replySync.errors.replyResultPending',
  replyArchiveUncertain: 'common.workbench.replySync.errors.replyArchiveUncertain',
  replySendUncertain: 'common.workbench.replySync.errors.replySendUncertain',
  replyLoginRequired: 'common.workbench.feishuAuth.loginRequired',
  replyMissingPermissions: 'common.workbench.feishuAuth.missingPermissions',
  replyAuthNotConfigured: 'common.workbench.feishuAuth.notConfigured',
} as const;

/** Only translate known error codes; provider messages never become visible text. */
export function replyErrorKey(code?: string, sendButtonConfigured = false) {
  if (sendButtonConfigured && code === 'replyVerificationRequired') {
    return 'common.workbench.replySync.errors.replyButtonVerificationRequired';
  }
  if (sendButtonConfigured && code === 'replyApprovalInterrupted') {
    return 'common.workbench.replySync.errors.replyButtonApprovalInterrupted';
  }
  return code && Object.prototype.hasOwnProperty.call(ERROR_KEYS, code)
    ? ERROR_KEYS[code as keyof typeof ERROR_KEYS]
    : 'common.workbench.replySync.error';
}
