import { CURRENT_REACT_FIBERS } from '../../replies/platforms/shared';
import { delay, type History, type Reader } from './guest';

// The creator's existing conversation model exposes a synchronous, filtered local cache.
// Reading it does not open a row, focus a composer, call the IM backend, or mark a message read.
const DOUYIN_PAGE = String.raw`
challenge();
if (location.origin !== 'https://creator.douyin.com' || location.pathname !== '/creator-micro/data/following/chat') return null;
${CURRENT_REACT_FIBERS}
const rows = [...document.querySelectorAll('.conversationConversationItemwrapper')];
const actors = new Set();
const header = document.querySelector('header, [class*="header"], [class*="Header"]');
const actorElements = [...rows.slice(0, 1), ...(header ? [header, ...header.querySelectorAll('span, img, [class*="avatar"]')].slice(0, 70) : [])];
for (const el of actorElements) {
  for (let current = currentFiber(el), i = 0; current && i < 65; current = fiberParent(current), i++) {
    const readActor = value => {
      for (const account of [value?.userInfo, value?.fastUserInfo]) {
        if (account?.uid != null) {
          const uid = id(account.uid);
          if (!uid) fail('dmIdentityMismatch');
          actors.add(uid);
        }
      }
    };
    readActor(current.memoizedProps?.value);
    let hook = current.memoizedState;
    for (let j = 0; hook && j < 32; j++, hook = hook.next) readActor(hook.memoizedState);
  }
}
if (!actors.size) return null;
if (actors.size !== 1 || !actors.has(A.actor)) fail('dmAccountMismatch');
const matches = [];
for (const row of rows) {
  const c = fiberProps(row, p => !!p.conversation)?.conversation;
  if (!c || c.type !== 1 || c.isStrangerConversation !== false || c.isBlocked) continue;
  if (id(c.toParticipantUserId) === A.peer) matches.push(c);
}
if (!matches.length) {
  const lists = document.querySelectorAll('.conversationConversationListwrapper');
  if (lists.length > 1) fail('dmPageUnverified');
  const box = lists[0];
  if (!rows.length) {
    if (!box || !/^(?:暂无消息|暂无会话|暂无私信，去找人聊天吧)$/.test(box.textContent.trim())) return null;
  }
  if (box && rows.length) {
    const max = box.scrollHeight - box.clientHeight;
    const next = op === 'start' && box.scrollTop > 0 ? 0 : Math.min(max, box.scrollTop + Math.max(120, Math.floor(box.clientHeight * .8)));
    if (box.clientHeight > 0 && max > 0 && next !== box.scrollTop) {
      box.scrollTop = next;
      box.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { moved: true };
    }
  }
  return { messages: [], complete: false, reason: 'dmContactNotFound' };
}
if (matches.length !== 1) fail('dmIdentityMismatch');
const c = matches[0], conversationId = id(c.id);
if (!conversationId || typeof c.getMessageList !== 'function') fail('dmPageUnverified');
const messages = c.getMessageList();
if (!Array.isArray(messages)) fail('dmPageUnverified');
for (const m of messages) {
  if (!m || id(m.conversationId) !== conversationId || (m.conversationType != null && m.conversationType !== 1)) fail('dmIdentityMismatch');
  const payload = contentObject(m.content);
  let kind = 'unknown', text = '';
  if (m.isRecalled === true) kind = 'recalled';
  else if (m.type === 7 && typeof payload.text === 'string') { kind = 'text'; text = payload.text; }
  else if (m.type === 5 && payload.image_id) kind = 'emoji';
  else if (payload.audio_duration != null) kind = 'voice';
  else if (payload.share_id || payload.aweme_info) kind = 'note_card';
  else if (payload.video_url && !payload.share_id) kind = 'video';
  else if (payload.pic_url || payload.image_url) kind = 'image';
  const ts = typeof m.createdAt === 'number' ? m.createdAt : new Date(m.createdAt).getTime();
  if (ts < 100000000000) fail('dmPageUnverified');
  append(m.serverId, m.sender, ts, kind, text);
}
return { messages: [...byId.values()], complete: false, reason: 'dmHistoryPartial' };
`;

/** Only the loaded Douyin cache is proven. The virtual list exposes no reliable end marker. */
export async function douyinHistory(reader: Reader, signal: AbortSignal): Promise<History> {
  let pages = 0,
    waiting = 0;
  while (pages < 40 && waiting < 45) {
    const result = await reader<History | { moved: true } | null>(DOUYIN_PAGE, pages ? 'next' : 'start');
    if (result && !('moved' in result)) return result;
    if (result) pages++;
    else waiting++;
    await delay(result ? 250 : 180, signal);
  }
  if (pages >= 40) return { messages: [], complete: false, reason: 'dmHistoryPartial' };
  throw Error('dmPageUnverified');
}
