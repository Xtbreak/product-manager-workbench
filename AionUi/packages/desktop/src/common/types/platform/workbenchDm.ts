import type { ReplyPlatform } from './workbenchReply';

export type AccountTask = 'comment-sync' | 'comment-send' | 'dm-sync';
export type DmSender = 'me' | 'peer';
export type DmKind = 'text' | 'image' | 'video' | 'note_card' | 'voice' | 'emoji' | 'recalled' | 'system' | 'unknown';
export type DmMessage = {
  id: string;
  sender: DmSender;
  timestamp: number;
  kind: DmKind;
  text: string;
  nonTextLabel?: string;
};
export type DmThread = {
  key: string;
  platform: ReplyPlatform;
  accountId: string;
  actorId: string;
  contactPlatformId: string;
  contactName: string;
  avatarUrl?: string;
  source: 'comment' | 'direct';
  commentKeys: string[];
  lastMessagePreview: string;
  lastMessageKind?: DmKind;
  lastMessageAt: number | null;
  lastSender: DmSender | null;
  syncState: 'idle' | 'partial' | 'error';
  partialReason?: string;
  lastSyncedAt?: number;
  lastError?: string;
  watermark: number | null;
};
export type DmComment = { key: string; token: string; workTitle: string; content: string; createdAt: number };
export type DmDetail = { thread: DmThread; messages: DmMessage[]; comments: DmComment[] };
export type DmStatus = {
  busy: boolean;
  busyAccountId?: string;
  lastSyncedAt?: number;
  partial: boolean;
  error?: string;
  feishuConfigured: boolean;
};
export type DmSyncAction =
  | { action: 'status' | 'list' | 'sync-all' | 'cancel' | 'configure-feishu' }
  | { action: 'thread' | 'sync-contact'; key: string }
  | { action: 'resolve-dm-link'; token: string };
export type DmSyncResult = { status: DmStatus; threads: DmThread[]; detail?: DmDetail; resolvedKey?: string };
