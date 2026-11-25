import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import type { ReplyBrowserLease } from '@/process/services/workbench/replies/contracts';

export const actor = '111111111111111111111111';
export const peer = '222222222222222222222222';
export const dyActor = '1110000000000001';
export const dyPeer = '2220000000000002';
export const xhsInbox = 'https://www.xiaohongshu.com/chat';
export const dyInbox = 'https://creator.douyin.com/creator-micro/data/following/chat';
export function guest(url: string) {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { url, runScripts: 'outside-only' });
  const { document } = dom.window;
  dom.window.scrollTo = () => {};
  const navigation: string[] = [];
  let render = (_url: string) => {};
  let historyUrls = [url];
  const navigate = (next: string) => {
    navigation.push(next);
    dom.reconfigure({ url: next });
    render(next);
  };
  const lease: ReplyBrowserLease = {
    accountId: 'fixture',
    targetId: 'webview-1',
    release() {},
    async command(method, params = {}) {
      if (method === 'Runtime.evaluate') {
        try {
          const value = await runInContext(String(params.expression), dom.getInternalVMContext());
          return { result: { value: structuredClone(value) } };
        } catch (error) {
          return { exceptionDetails: { exception: { description: String(error) } } };
        }
      }
      if (method === 'Page.getNavigationHistory')
        return {
          currentIndex: historyUrls.length - 1,
          entries: historyUrls.map((entry, i) => ({ id: i + 1, url: entry })),
        };
      if (method === 'Page.navigate') {
        historyUrls.push(String(params.url));
        navigate(String(params.url));
        return {};
      }
      if (method === 'Page.navigateToHistoryEntry') {
        historyUrls = historyUrls.slice(0, Number(params.entryId));
        navigate(historyUrls.at(-1)!);
        return {};
      }
      throw new Error('Unexpected CDP method ' + method);
    },
  };
  return {
    lease,
    document,
    dom,
    navigation,
    navigate,
    onNavigation(handler: (next: string) => void) {
      render = handler;
    },
  };
}

export function xhsGuest(
  options: {
    start?: string;
    unread?: number;
    detailPeer?: string;
    sender?: string;
    actorId?: string;
    loading?: boolean;
    noContact?: boolean;
    stall?: boolean;
    failRestore?: boolean;
    overlay?: boolean;
    abortOnOpen?: () => void;
    receiver?: string;
    offscreen?: boolean;
    defaultPeer?: string;
    disjoint?: boolean;
    recalledText?: boolean;
    listPeer?: string | null;
    changedMessage?: 'text' | 'image' | 'unknown';
  } = {}
) {
  const start = options.start || xhsInbox;
  const browser = guest(start);
  const { document } = browser;
  const selected: string[] = [];
  const record = {
    id: peer,
    kind: 'c2c',
    ...(options.listPeer === null ? {} : { peerUserId: options.listPeer ?? actor }),
    rawChat: { userId: actor, chatId: peer, localChatUserId: peer, isStranger: false },
    unreadCount: options.unread || 0,
  };
  const msg = (i: number) => ({
    messageId: 'message-' + i,
    createTime: 1710000000000 + i,
    chatId: peer,
    senderId: options.sender || (i % 3 ? actor : peer),
    receiverId: options.receiver || (i % 3 ? peer : actor),
    contentType: 1,
    content: 'message ' + i,
  });
  const messages = Array.from({ length: 35 }, (_, i) => msg(i));
  let overlay = false;
  function render(next: string) {
    const openDefault = !!options.defaultPeer && next === xhsInbox;
    const detail = overlay || next === xhsInbox + '/' + peer || openDefault;
    document.body.innerHTML = '<div id="app"></div>';
    const app = document.getElementById('app')!;
    if (next !== xhsInbox && !detail) {
      if (options.failRestore && browser.navigation.length) throw Error('restore failed');
      app.innerHTML = '<section id="feed"></section>';
      return;
    }
    app.innerHTML =
      '<div class="xhs-im-page"><div class="xhs-im-conv-list__scroll"><div class="xhs-im-conv-item"></div></div><div class="xhs-im-msg-list"></div></div>';
    const el = app.querySelector<HTMLElement>('.xhs-im-conv-item')!;
    el.dataset.convKind = 'c2c';
    el.dataset.convId = peer;
    el.onclick = () => {
      selected.push(peer);
      if (options.overlay) {
        overlay = true;
        render(xhsInbox);
      } else browser.navigate(xhsInbox + '/' + peer);
      options.abortOnOpen?.();
    };
    if (detail) {
      if (openDefault) {
        const existing = document.createElement('div');
        existing.className = 'xhs-im-conv-item--active';
        existing.dataset.convId = options.defaultPeer;
        app.firstElementChild!.appendChild(existing);
      } else el.classList.add('xhs-im-conv-item--active');
      const win = document.createElement('div');
      win.className = 'xhs-im-chat-window';
      const back = document.createElement('button');
      back.className = 'xhs-im-chat-window__back-btn';
      back.onclick = () => {
        overlay = false;
        render(xhsInbox);
      };
      win.appendChild(back);
      app.firstElementChild!.appendChild(win);
    }
    if (!detail && options.offscreen) el.remove();
    const detailProps = {
      myUid: actor,
      peerUserId: openDefault ? options.defaultPeer : options.detailPeer || peer,
      conv: record,
      messages: messages.slice(-30),
      hasMoreHistory: true,
      isLoadingMessages: false,
      isLoadingHistory: false,
      isPreloadingMessages: false,
    };
    const scroller = app.querySelector<HTMLElement>('.xhs-im-msg-list')!;
    Object.defineProperties(scroller, { scrollHeight: { value: 1200 }, clientHeight: { value: 300 } });
    scroller.addEventListener('scroll', () => {
      if (options.stall || scroller.scrollTop !== 0) return;
      detailProps.messages = options.disjoint
        ? messages.slice(0, 2)
        : messages.map((m, index) => {
            if (index !== 34 || !options.changedMessage) return m;
            if (options.changedMessage === 'text') return { ...m, content: 'different text on the next page' };
            return { ...m, contentType: options.changedMessage === 'image' ? 2 : 99 };
          });
      detailProps.hasMoreHistory = false;
      scroller.scrollTop = 630;
    });
    const component = (name: string, props: object) => ({
      component: { type: { __name: name }, props, vnode: { el: app.firstElementChild }, subTree: {} },
    });
    const hint = document.createElement('div');
    hint.textContent = '对方撤回了一条消息';
    if (options.recalledText && detail) app.firstElementChild!.appendChild(hint);
    const recalledBubble = {
      component: { type: { __name: 'MsgBubbleHint' }, props: { msg: messages[34] }, vnode: { el: hint }, subTree: {} },
    };
    Object.assign(app, {
      _vnode: {
        children: [
          component('IMView', { currentUserId: options.actorId ?? actor }),
          component('ConversationList', {
            convList: options.noContact ? [] : [record],
            strangerList: [],
            isUnreadInitialized: true,
            isLoading: !!options.loading,
          }),
          ...(detail ? [component('ChatWindow', detailProps)] : []),
          ...(options.recalledText && detail ? [recalledBubble] : []),
        ],
      },
    });
  }
  browser.onNavigation(render);
  render(start);
  return { ...browser, selected, messages };
}

export function douyinGuest(
  options: {
    actorId?: string;
    peerId?: string;
    sender?: string;
    recalled?: boolean;
    collision?: boolean;
    unsafeId?: boolean;
    offscreen?: boolean;
    emptyWhileLoading?: boolean;
    start?: string;
    foreignConv?: boolean;
  } = {}
) {
  const browser = guest(options.start ?? dyInbox);
  const { document } = browser;
  const row = document.createElement('div');
  row.className = 'conversationConversationItemwrapper';
  const box = document.createElement('div');
  box.className = 'conversationConversationListwrapper';
  box.appendChild(row);
  document.body.appendChild(box);
  Object.defineProperties(box, {
    scrollHeight: { value: options.offscreen ? 1500 : 500 },
    clientHeight: { value: 500 },
  });
  const conversation = {
    id: 'conversation-1',
    type: 1,
    unreadCount: 4,
    toParticipantUserId: options.peerId || dyPeer,
    toParticipantSecUserId: 'MS4w-secret-peer',
    isStrangerConversation: false,
    getMessageList() {
      return Array.from({ length: 18 }, (_, i) => ({
        serverId: options.unsafeId
          ? Number(800000000000000001n)
          : String(800000000000000001n + BigInt(options.collision ? 0 : i)),
        conversationId: options.foreignConv ? 'another-conversation' : 'conversation-1',
        sender: options.sender || (i < 3 ? dyActor : dyPeer),
        createdAt: new Date(1710000000000 + i),
        type: 7,
        content: JSON.stringify({ text: 'DM ' + i }),
        isRecalled: !!options.recalled,
      }));
    },
  };
  const root = { tag: 3, stateNode: {}, return: null, child: {} };
  Object.assign(root.stateNode, { current: root });
  const provider = {
    tag: 10,
    memoizedProps: {
      value: { userInfo: { uid: options.actorId || dyActor }, fastUserInfo: { uid: options.actorId || dyActor } },
    },
    return: root,
    child: {},
  };
  const owner = { tag: 0, memoizedProps: { conversation }, return: provider, child: {} };
  const fiber = { tag: 5, stateNode: row, memoizedProps: {}, return: owner };
  root.child = provider;
  provider.child = owner;
  owner.child = fiber;
  Object.assign(row, { __reactFiber$fixture: fiber });
  if (options.offscreen) {
    conversation.toParticipantUserId = '777777';
    box.addEventListener('scroll', () => {
      conversation.toParticipantUserId = box.scrollTop >= 650 ? dyPeer : '777777';
    });
  }
  if (options.emptyWhileLoading) {
    row.className = 'creator-header';
    setTimeout(() => {
      row.className = 'conversationConversationItemwrapper';
    }, 300);
  }
  let clicks = 0;
  row.onclick = () => {
    clicks++;
  };
  if (options.start) {
    const render = (url: string) => {
      if (url === dyInbox) document.body.replaceChildren(box);
      else document.body.innerHTML = '<section id="before"></section>';
    };
    browser.onNavigation(render);
    render(options.start);
  }
  return { ...browser, clicks: () => clicks };
}
