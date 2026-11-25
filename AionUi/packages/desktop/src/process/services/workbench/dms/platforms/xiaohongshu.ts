import { delay, type History, type Reader } from './guest';

// A candidate comes from a mounted regular conversation. Only the detail identifies its peer.
const XHS_PAGE = String.raw`
challenge();
if (location.origin !== 'https://www.xiaohongshu.com' || !/^\/chat(?:\/[^/]+)?\/?$/.test(location.pathname)) return { status: 'wait' };
const components = [], visited = new Set(), pending = [document.querySelector('#app')?._vnode];
while (pending.length) {
  const node = pending.pop();
  if (!node || typeof node !== 'object' || visited.has(node)) continue;
  if (visited.size >= 100000) fail('dmPageUnverified');
  visited.add(node);
  if (node.component) {
    const c = node.component;
    if (!c.isUnmounted && !c.isDeactivated && c.vnode?.el?.isConnected) components.push(c);
    pending.push(c.subTree);
  }
  if (Array.isArray(node.children)) for (const child of node.children) pending.push(child);
  if (node.ssContent) pending.push(node.ssContent);
}
const name = c => c.type?.__name || c.type?.name;
const props = type => {
  const matches = components.filter(c => name(c) === type);
  if (matches.length > 1) fail('dmPageUnverified');
  return matches[0]?.props;
};
const view = props('IMView'), list = props('ConversationList');
if (!view) return { status: 'wait' };
if (!id(view.currentUserId)) fail('dmLoginRequired');
if (id(view.currentUserId) !== A.actor) fail('dmAccountMismatch');
if (!list || !list.isUnreadInitialized || list.isLoading) return { status: 'wait' };
if (!Array.isArray(list.convList)) fail('dmPageUnverified');
const matches = list.convList.filter(row => row?.kind === 'c2c' && id(row.id) === A.peer);
if (!matches.length) return { status: 'partial', reason: 'dmContactNotFound' };
if (matches.length !== 1) fail('dmIdentityMismatch');
const row = matches[0];
if (id(row.rawChat?.chatId) !== A.peer || id(row.rawChat?.userId) !== A.actor) fail('dmIdentityMismatch');
if (row.rawChat.isStranger !== false || row.isBlocked || row.isOfficial) return { status: 'partial', reason: 'dmContactNotFound' };
if (A.mode === 'all' && row.unreadCount !== 0) return { status: 'partial', reason: 'dmUnreadSkipped' };
const detailPath = '/chat/' + A.peer;
const chat = props('ChatWindow');
const active = [...document.querySelectorAll('.xhs-im-conv-item--active')];
const inListOverlay = location.pathname.replace(/\/$/, '') === '/chat' && chat && active.length === 1 && active[0].dataset.convId === A.peer;
if (location.pathname !== detailPath && !inListOverlay) {
  if (op !== 'open') return { status: 'wait' };
  const elements = [...document.querySelectorAll('.xhs-im-conv-item')].filter(e => e.dataset.convId === A.peer && e.dataset.convKind === 'c2c');
  if (elements.length > 1) fail('dmIdentityMismatch');
  assertNoDraft();
  // The platform deep link is safe only after the mounted regular inbox proved this exact row and actor.
  if (elements.length === 0 || chat) return { status: 'navigate' };
  elements[0].click();
  return { status: 'opening' };
}
if (!chat || chat.isLoadingMessages || chat.isLoadingHistory || chat.isPreloadingMessages) return { status: 'wait' };
if (id(chat.myUid) !== A.actor) fail('dmAccountMismatch');
if (id(chat.peerUserId) !== A.peer || id(chat.conv?.id) !== A.peer || chat.conv?.kind !== 'c2c') fail('dmIdentityMismatch');
if (!Array.isArray(chat.messages)) fail('dmPageUnverified');
const bubbleTypes = new Map();
for (const c of components) {
  if (name(c)?.startsWith('MsgBubble') && c.props?.msg) {
    const key = id(c.props.msg.messageId);
    if (!bubbleTypes.has(key)) bubbleTypes.set(key, new Set());
    const label = name(c);
    const isRecallNotice = label === 'MsgBubbleHint' && /撤回了一条消息|消息已撤回|消息已被撤回/.test(c.vnode.el.textContent || '');
    bubbleTypes.get(key).add(isRecallNotice ? 'MsgBubbleRecall' : label);
  }
}
for (const m of chat.messages) {
  if (!m || m.isGroupChat || id(m.chatId) !== A.peer) fail('dmIdentityMismatch');
  const sender = id(m.senderId), receiver = id(m.receiverId);
  if (receiver !== (sender === A.actor ? A.peer : A.actor)) fail('dmIdentityMismatch');
  const types = bubbleTypes.get(id(m.messageId));
  let kind = 'unknown', text = '';
  if (types?.has('MsgBubbleRevoke') || types?.has('MsgBubbleRecall')) kind = 'recalled';
  else if (types?.has('MsgBubbleHint')) kind = 'system';
  else if (types?.has('MsgBubbleUnsupported')) kind = 'unknown';
  else if (types?.has('MsgBubbleText') || m.contentType === 1) {
    kind = 'text';
    if (typeof m.content !== 'string') fail('dmPageUnverified');
    text = m.content;
  } else if (types?.has('MsgBubbleImage') || m.contentType === 2) kind = 'image';
  else if (types?.has('MsgBubbleEmoji')) kind = 'emoji';
  else if (types?.has('MsgBubbleVoice')) kind = 'voice';
  else if (types?.has('MsgBubbleVideo')) kind = 'video';
  else if (types?.has('MsgBubbleCard') || m.contentType === 3) kind = 'note_card';
  if (m.createTime < 1e11) fail('dmPageUnverified');
  append(m.messageId, sender, m.createTime, kind, text);
}
if (op === 'advance' || op === 'rewind') {
  const scroller = document.querySelector('.xhs-im-msg-list');
  if (scroller && chat.hasMoreHistory === true) {
    scroller.scrollTop = op === 'advance' ? 0 : Math.min(500, scroller.scrollHeight);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
  }
}
return { status: 'ready', messages: [...byId.values()], complete: chat.hasMoreHistory === false, canPage: chat.hasMoreHistory === true };
`;

type Snapshot =
  | { status: 'wait' }
  | { status: 'opening' }
  | { status: 'navigate' }
  | { status: 'partial'; reason: string }
  | ({ status: 'ready'; canPage: boolean } & History);

/** Read only an existing one-to-one conversation and require an explicit platform end-of-history. */
export async function xiaohongshuHistory(
  reader: Reader,
  signal: AbortSignal,
  navigateKnown: () => Promise<void>
): Promise<History> {
  const seen = new Map<string, History['messages'][number]>();
  let pages = 0;
  let pendingOpen = true;
  let continuous = true;
  let idle = 0;
  for (let step = 0; step < 240; step++) {
    const page = await reader<Snapshot>(XHS_PAGE, pendingOpen ? 'open' : 'read');
    if (page.status === 'navigate') {
      pendingOpen = false;
      await navigateKnown();
      continue;
    }
    if (page.status === 'opening' || page.status === 'wait') {
      if (page.status === 'opening') pendingOpen = false;
      if (++idle > 40) {
        if (!seen.size) throw Error('dmPageUnverified');
        break;
      }
      await delay(180, signal);
      continue;
    }
    pendingOpen = false;
    if (page.status === 'partial') return { messages: [...seen.values()], complete: false, reason: page.reason };
    const before = seen.size;
    if (before > 0 && !page.messages.some((row) => seen.has(row.id))) continuous = false;
    for (const row of page.messages) {
      const prior = seen.get(row.id);
      if (prior && (prior.sender !== row.sender || prior.timestamp !== row.timestamp))
        throw Error('dmIdentityMismatch');
      if (prior?.kind === 'recalled') continue;
      if (prior && prior.kind !== 'unknown' && row.kind !== 'recalled') {
        if (row.kind === 'unknown') continue;
        if (row.kind !== prior.kind || row.text !== prior.text) throw Error('dmIdentityMismatch');
      }
      seen.set(row.id, row);
    }
    if (page.complete && continuous) return { messages: [...seen.values()], complete: true };
    if (!continuous) break;
    if (!page.canPage || ++pages > 40 || (before > 0 && seen.size === before && ++idle >= 3)) break;
    if (seen.size > before) idle = 0;
    await reader(XHS_PAGE, 'rewind');
    await delay(180, signal);
    await reader(XHS_PAGE, 'advance');
    await delay(450, signal);
  }
  return { messages: [...seen.values()], complete: false, reason: 'dmHistoryPartial' };
}
