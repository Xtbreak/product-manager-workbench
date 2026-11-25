import type { DmMessage, DmThread } from '@/common/types/platform/workbenchDm';
import type { ReplyBrowserLease } from '../../replies/contracts';

export type History = { messages: DmMessage[]; complete: boolean; reason?: string };
export type Reader = <T>(source: string, operation?: string) => Promise<T>;
export const XHS_INBOX = 'https://www.xiaohongshu.com/chat';
export const DY_INBOX = 'https://creator.douyin.com/creator-micro/data/following/chat';

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw Error('dmCancelled');
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(Error('dmCancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

// These scripts run only inside the leased webview. No cookie, token or private endpoint is used.
const COMMON = String.raw`
const visible = el => el?.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
const fail = code => { throw Error(code); };
const id = v => typeof v === 'string' && v.length && v.length <= 200 ? v :
  (typeof v === 'bigint' || Number.isSafeInteger(v)) ? String(v) : '';
const byId = new Map();
const append = (idValue, who, timestamp, kind, text = '') => {
  const messageId = id(idValue);
  if (!messageId || !Number.isSafeInteger(timestamp) || timestamp <= 0) fail('dmPageUnverified');
  const sender = id(who);
  if (sender !== A.actor && sender !== A.peer) fail('dmIdentityMismatch');
  const message = { id: messageId, sender: sender === A.actor ? 'me' : 'peer', timestamp, kind, text };
  if (byId.has(messageId) && JSON.stringify(byId.get(messageId)) !== JSON.stringify(message)) fail('dmIdentityMismatch');
  byId.set(messageId, message);
};
const contentObject = raw => {
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};
const challenge = () => {
  if ([...document.querySelectorAll('iframe[src*="captcha"], [class*="captcha-container"], [id*="captcha"], [class*="verify-dialog"]')].some(visible)) fail('dmChallengeRequired');
  const dialogs = [...document.querySelectorAll('[role="dialog"],.login-container,.login-modal,[class*="login-mask"],[class*="verification-dialog"]')].filter(visible);
  if (dialogs.some(e => /安全验证|完成验证|验证码/.test(e.textContent))) fail('dmChallengeRequired');
  if (dialogs.some(e => /扫码登录|登录后|请登录|登录/.test(e.textContent)) || /\/(?:login|passport)(?:\/|$)/.test(location.pathname)) fail('dmLoginRequired');
};
const assertNoDraft = () => {
  const editors = [...document.querySelectorAll('textarea,[contenteditable="true"],input[type="file"]')];
  if (editors.some(e => (e.type === 'file' ? e.files?.length : (e.value || e.textContent || '').trim().length))) fail('dmExistingDraft');
};
`;

export function makeReader(
  lease: ReplyBrowserLease,
  thread: DmThread,
  mode: 'contact' | 'all',
  signal?: AbortSignal
): Reader {
  const binding = JSON.stringify({ actor: thread.actorId, peer: thread.contactPlatformId, mode });
  return async <T>(source: string, operation = '') => {
    checkAbort(signal);
    const response = (await lease.command('Runtime.evaluate', {
      expression: `(() => { const A = ${binding}; const op = ${JSON.stringify(operation)}; ${COMMON}\n${source}\n})()`,
      returnByValue: true,
      awaitPromise: false,
    })) as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } };
    checkAbort(signal);
    if (response?.exceptionDetails) {
      const error = response.exceptionDetails.exception?.description || '';
      const code =
        /\b(dm(?:AccountMismatch|IdentityMismatch|LoginRequired|ChallengeRequired|ExistingDraft|PageUnverified))\b/.exec(
          error
        )?.[1];
      throw Error(code || 'dmPageUnverified');
    }
    if (!response?.result || !Object.hasOwn(response.result, 'value')) throw Error('dmBrowserUnavailable');
    return response.result.value as T;
  };
}

type ScrollState = {
  url: string;
  x: number;
  y: number;
  chatWasOpen: boolean;
  openPeer: string;
  offsets: Array<{ path: number[]; tag: string; id: string; x: number; y: number }>;
};

const capturePage = String.raw`
challenge();
assertNoDraft();
const offsets = [];
for (const node of document.querySelectorAll('body *')) {
  const chatScroll = node.matches('.xhs-im-msg-list,.xhs-im-conv-list__scroll,.messageMessageListlist,.conversationConversationListwrapper');
  if ((!chatScroll && !node.scrollTop && !node.scrollLeft) || node === document.scrollingElement) continue;
  const path = [];
  for (let el = node; el !== document.body; el = el.parentElement) {
    if (!el?.parentElement) fail('dmPageUnverified');
    path.unshift(Array.prototype.indexOf.call(el.parentElement.children, el));
  }
  offsets.push({ path, tag: node.tagName, id: node.id, x: node.scrollLeft, y: node.scrollTop });
}
const chatWasOpen = !!document.querySelector('.xhs-im-chat-window');
const openPeer = chatWasOpen ? document.querySelector('.xhs-im-conv-item--active')?.dataset.convId || '' : '';
return { url: location.href, x: window.scrollX, y: window.scrollY, offsets, chatWasOpen, openPeer };
`;

export type OriginalPage = { state: ScrollState; entryId: number };
export async function originalPage(reader: Reader, lease: ReplyBrowserLease): Promise<OriginalPage> {
  const history = (await lease.command('Page.getNavigationHistory')) as {
    currentIndex: number;
    entries: Array<{ id: number; url: string }>;
  };
  const entry = history?.entries?.[history.currentIndex];
  if (!entry || !Number.isInteger(entry.id) || !URL.canParse(entry.url)) throw Error('dmPageUnverified');
  const start = new URL(entry.url);
  const supportedHosts = ['www.xiaohongshu.com', 'creator.xiaohongshu.com', 'www.douyin.com', 'creator.douyin.com'];
  if (start.protocol !== 'https:' || !supportedHosts.includes(start.host) || start.username || start.password)
    throw Error('dmPageUnverified');
  // A partition may visit both platforms. Check the exact current document before inspecting its UI.
  const state = await reader<ScrollState>(`if (location.href !== ${JSON.stringify(entry.url)}) fail('dmPageUnverified');
${capturePage}`);
  return { state, entryId: entry.id };
}

export async function restore(
  reader: Reader,
  lease: ReplyBrowserLease,
  { state, entryId }: OriginalPage
): Promise<void> {
  try {
    if ((await reader<string>('return location.href;')) !== state.url) {
      await lease.command('Page.navigateToHistoryEntry', { entryId });
    }
    const serialized = JSON.stringify(state);
    let closeRequested = false;
    for (let i = 0; i < 35; i++) {
      const done = await reader<boolean | 'closing'>(`
        const before = ${serialized};
        if (location.href !== before.url || document.readyState === 'loading') return false;
        if (before.openPeer && document.querySelector('.xhs-im-conv-item--active')?.dataset.convId !== before.openPeer) return false;
        if (!before.chatWasOpen && location.origin === 'https://www.xiaohongshu.com' && location.pathname.replace(/\\/$/, '') === '/chat' && document.querySelector('.xhs-im-chat-window')) {
          const active = [...document.querySelectorAll('.xhs-im-conv-item--active')];
          const buttons = document.querySelectorAll('.xhs-im-chat-window .xhs-im-chat-window__back-btn');
          if (active.length !== 1 || active[0].dataset.convId !== A.peer || buttons.length !== 1) fail('dmPageUnverified');
          if (!${closeRequested}) buttons[0].click();
          return 'closing';
        }
        if (window.scrollX !== before.x || window.scrollY !== before.y) window.scrollTo(before.x, before.y);
        let restored = window.scrollX === before.x && window.scrollY === before.y;
        for (const item of before.offsets) {
          let node = document.body;
          for (const index of item.path) node = node?.children[index];
          if (!node || node.tagName !== item.tag || node.id !== item.id) { restored = false; continue; }
          if (node.scrollLeft !== item.x) node.scrollLeft = item.x;
          if (node.scrollTop !== item.y) node.scrollTop = item.y;
          if (node.scrollTop !== item.y || node.scrollLeft !== item.x) restored = false;
        }
        return restored;`);
      if (done === true) return;
      if (done === 'closing') closeRequested = true;
      await delay(150);
    }
  } catch {
    /* Report a controlled outcome without exposing page data. */
  }
  throw Error('dmRestoreFailed');
}
