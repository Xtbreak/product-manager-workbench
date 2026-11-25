import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { DmMessage, DmThread } from '@/common/types/platform/workbenchDm';

const component = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const id = z.string().min(1).max(4000);
const time = z.number().int().nonnegative().safe();
const sender = z.enum(['me', 'peer']);
const kind = z.enum(['text', 'image', 'video', 'note_card', 'voice', 'emoji', 'recalled', 'system', 'unknown']);
const message = z
  .object({
    id,
    sender,
    timestamp: time,
    kind,
    text: z.string(),
    nonTextLabel: z.string().optional(),
  })
  .strict();
const thread = z
  .object({
    key: id,
    platform: z.enum(['xiaohongshu', 'douyin']),
    accountId: component,
    actorId: component,
    contactPlatformId: component,
    contactName: z.string(),
    avatarUrl: z.string().url().optional(),
    commentKeys: z.array(id),
    source: z.enum(['comment', 'direct']),
    lastMessagePreview: z.string(),
    lastMessageKind: kind.optional(),
    lastMessageAt: time.nullable(),
    lastSender: sender.nullable(),
    syncState: z.enum(['idle', 'partial', 'error']),
    partialReason: id.optional(),
    lastSyncedAt: time.optional(),
    lastError: id.optional(),
    watermark: time.nullable(),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(1),
    enabledAt: time,
    lastSyncedAt: time.optional(),
    feishu: z.object({ baseToken: id, tableId: id, fieldId: id }).strict().optional(),
    entries: z.array(z.object({ thread, messages: z.array(message) }).strict()),
  })
  .strict()
  .refine((doc) => {
    const keys = new Set<string>();
    return doc.entries.every(({ thread: t, messages }) => {
      if (
        keys.has(t.key) ||
        t.key !== [t.platform, t.accountId, t.actorId, t.contactPlatformId].join(':') ||
        t.actorId === t.contactPlatformId
      )
        return false;
      keys.add(t.key);
      const last = messages.at(-1);
      return (
        new Set(t.commentKeys).size === t.commentKeys.length &&
        new Set(messages.map((m) => m.id)).size === messages.length &&
        messages.every((m, i) => m.timestamp >= doc.enabledAt && (!i || m.timestamp >= messages[i - 1].timestamp)) &&
        t.lastMessageAt === (last?.timestamp ?? null) &&
        t.lastSender === (last?.sender ?? null)
      );
    });
  });
export type DmDocument = {
  version: 1;
  enabledAt: number;
  lastSyncedAt?: number;
  feishu?: { baseToken: string; tableId: string; fieldId: string };
  entries: DmEntry[];
};
export type DmEntry = { thread: DmThread; messages: DmMessage[] };

export class DmStore {
  private value: DmDocument;
  private readonly file: string;
  private bytes: string | undefined;
  constructor(directory: string, now = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'direct-messages.json');
    try {
      this.bytes = readFileSync(this.file, 'utf8');
      this.value = schema.parse(JSON.parse(this.bytes)) as DmDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('dmStoreInvalid');
      this.value = { version: 1, enabledAt: now(), entries: [] };
      this.update(() => {});
    }
  }
  read(): DmDocument {
    return structuredClone(this.value);
  }
  update(mutator: (doc: DmDocument) => void): void {
    const next = this.read();
    mutator(next);
    if (!schema.safeParse(next).success) throw new Error('dmStoreInvalid');
    // Refuse to overwrite a replaced/corrupt file, including an unexpected deletion.
    let disk: string | undefined;
    try {
      disk = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (disk !== this.bytes) throw new Error('dmStoreInvalid');
    const temp = this.file + '.' + randomUUID() + '.tmp';
    const fd = openSync(temp, 'wx', 0o600);
    let renamed = false;
    try {
      const serialized = JSON.stringify(next);
      try {
        writeFileSync(fd, serialized);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.file);
      renamed = true;
      // The rename is already visible to readers even if directory fsync subsequently fails.
      this.bytes = serialized;
      this.value = next;
      const dir = openSync(path.dirname(this.file), 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      if (!renamed) rmSync(temp, { force: true });
    }
  }
}
