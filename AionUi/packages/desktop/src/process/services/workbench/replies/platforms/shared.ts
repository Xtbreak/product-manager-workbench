import type { ReplyComment, ReplyPlatform, ReplyWork } from '@/common/types/platform/workbenchReply';
import type { ReplyBrowserLease } from '../contracts';

export type PageComment = {
  id: string;
  root: string;
  parent: string | null;
  authorId: string;
  author: string;
  content: string;
  time: number;
};
export type PageSnapshot = {
  platform: ReplyPlatform;
  url: string;
  actorId: string;
  actorName: string;
  ownerId: string;
  workId: string;
  title: string;
  comments: PageComment[];
  complete: boolean;
  completeThreads: string[];
  ambiguous: boolean;
};

/** Resolve props on the committed React branch inside a leased guest. */
export const CURRENT_REACT_FIBERS = String.raw`
// React's DOM cache can point to either side of a committed fiber pair. Index the
// tree selected by HostRoot.stateNode.current once per root and evaluation.
const fiberRoots = new WeakMap();
const fiberOwners = new WeakMap();
const currentFiber = (el) => {
  const keys = Object.getOwnPropertyNames(el || {}).filter(key => key.startsWith('__reactFiber'));
  if (!keys.length) return null;
  if (keys.length !== 1) throw Error('REPLY_FIBER_UNVERIFIED');
  const attached = el[keys[0]];
  if (!attached || typeof attached !== 'object') throw Error('REPLY_FIBER_UNVERIFIED');
  let root = attached;
  const ancestry = new Set();
  while (root && root.tag !== 3) {
    if (typeof root !== 'object' || ancestry.has(root) || ancestry.size >= 4096) throw Error('REPLY_FIBER_UNVERIFIED');
    ancestry.add(root);
    root = root.return;
  }
  const owner = root?.stateNode;
  const current = owner?.current;
  if (!owner || typeof owner !== 'object' || !current || current.tag !== 3 || current.stateNode !== owner
    || current.return != null || (root !== current && root.alternate !== current)) throw Error('REPLY_FIBER_UNVERIFIED');
  let index = fiberRoots.get(owner);
  if (!index) {
    const parents = new Map(), elements = new Map(), pending = [{ node: current, parent: null }];
    while (pending.length) {
      const { node, parent } = pending.pop();
      if (!node || typeof node !== 'object' || parents.has(node) || parents.size >= 200000) throw Error('REPLY_FIBER_UNVERIFIED');
      parents.set(node, parent);
      const instance = node.stateNode;
      if (instance && typeof instance === 'object' && typeof instance.nodeType === 'number') {
        if (elements.has(instance)) throw Error('REPLY_FIBER_UNVERIFIED');
        elements.set(instance, node);
      }
      if (node.sibling) pending.push({ node: node.sibling, parent });
      if (node.child) pending.push({ node: node.child, parent: node });
    }
    if (owner.current !== current) throw Error('REPLY_FIBER_UNVERIFIED');
    index = { current, parents, elements };
    for (const node of parents.keys()) fiberOwners.set(node, index);
    fiberRoots.set(owner, index);
  }
  if (index.current !== owner.current) throw Error('REPLY_FIBER_UNVERIFIED');
  const active = index.elements.get(el);
  if (!active || (attached !== active && attached.alternate !== active && active.alternate !== attached))
    throw Error('REPLY_FIBER_UNVERIFIED');
  return active;
};
const fiberParent = (node) => fiberOwners.get(node)?.parents.get(node) || null;
const fiberProps = (el, predicate) => {
  let node = currentFiber(el);
  const seen = new Set();
  for (let i = 0; node && i < 35 && !seen.has(node); i++, node = fiberParent(node)) {
    seen.add(node);
    if (node.memoizedProps && predicate(node.memoizedProps)) return node.memoizedProps;
  }
  return null;
};
`;

// This source executes only in the leased guest via CDP, never in the main process.
export const PAGE_COMMON = String.raw`
const visible = (el) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
const text = (el) => typeof el?.innerText === 'string' ? el.innerText : el?.textContent || '';
const label = (el) => text(el) || el?.textContent || '';
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value) ? value : '';
const unwrap = (value) => value?.value ?? value;
const unique = (list, label) => { const found = Array.from(list).filter(visible); if (found.length !== 1) throw Error('REPLY_' + label + '_NOT_UNIQUE'); return found[0]; };
${CURRENT_REACT_FIBERS}
const checkChallenge = () => {
  const captcha = Array.from(document.querySelectorAll('[id*="captcha"], [class*="captcha-container"], [class*="captcha_container"], iframe[src*="captcha"]')).some(visible);
  const dialog = Array.from(document.querySelectorAll('[role="dialog"], .login-container, .login-modal, [class*="verify-dialog"], [class*="verification-dialog"]')).filter(visible).some(el => /短信验证|手机验证|安全验证|完成验证|扫码登录|登录后|验证码/.test(label(el)));
  const leafLabels = Array.from(document.querySelectorAll('span, div, p, h1, h2, h3, button, label')).filter(el => el.children.length === 0 && visible(el)).map(el => label(el).replace(/\s/g, ''));
  const sms = leafLabels.some(value => value.startsWith('为确保是本人操作抖音账号') && value.includes('收到的短信验证码'))
    || (leafLabels.includes('接收短信验证码') && leafLabels.includes('获取验证码') && leafLabels.includes('验证'));
  if (captcha || dialog || sms) throw Error('REPLY_CHALLENGE_REQUIRED');
};
const visibleDraft = () => Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).filter(visible).some(el => [el.value, text(el), el.textContent].some(value => typeof value === 'string' && value.trim().length > 0));
const assertEmptyDraft = () => { if (visibleDraft()) throw Error('REPLY_EXISTING_DRAFT'); };
const assertWork = (snapshot) => {
  if (!snapshot.actorId || snapshot.actorId !== snapshot.ownerId) throw Error('REPLY_OWNER_IDENTITY_MISMATCH');
  if (!snapshot.workId) throw Error('REPLY_WORK_ID_MISSING');
  if (A.work && (snapshot.platform !== A.work.platform || snapshot.workId !== A.work.workId || snapshot.actorId !== A.work.actorId)) throw Error('REPLY_WORK_IDENTITY_CHANGED');
};
const assertTarget = (snapshot) => {
  const row = snapshot.comments.find(c => c.id === A.target.commentId);
  if (!row || row.root !== A.target.rootCommentId || row.parent !== A.target.parentCommentId || row.authorId !== A.target.authorId || row.content !== A.target.content) throw Error('REPLY_TARGET_CHANGED');
};
const highlight = (rows) => {
  const candidates = Array.from(rows).filter(visible);
  if (!candidates.length) return false;
  const row = unique(candidates, 'TARGET');
  document.querySelectorAll('[data-workbench-comment-target]').forEach(el => el.removeAttribute('data-workbench-comment-target'));
  let style = document.getElementById('__workbench-comment-highlight');
  if (!style) {
    style = document.createElement('style'); style.id = '__workbench-comment-highlight';
    style.textContent = '[data-workbench-comment-target] { outline: 3px solid Highlight !important; outline-offset: 3px !important; }';
    document.head.append(style);
  }
  row.setAttribute('data-workbench-comment-target', A.target.commentId);
  row.scrollIntoView({ block: 'center', behavior: 'instant' });
  return true;
};
const advanceComments = (container) => {
  assertEmptyDraft();
  if (!container) return false;
  const expand = Array.from(container.querySelectorAll('*')).filter(el => el.children.length === 0 && visible(el) && /^(?:(展开|查看更多|加载更多).{0,30}(回复|评论)|展开更多)$/.test(label(el).trim()));
  if (expand.length) { expand[0].click(); return true; }
  let scroll = container;
  for (let i = 0; scroll && i < 8; i++, scroll = scroll.parentElement) {
    if (scroll.scrollHeight > scroll.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(scroll).overflowY)) {
      const before = scroll.scrollTop;
      scroll.scrollTop = Math.min(scroll.scrollHeight, before + Math.max(300, scroll.clientHeight * 0.8));
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      return scroll.scrollTop !== before;
    }
  }
  return false;
};
checkChallenge();
`;

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('REPLY_CANCELLED');
}

export async function settle(signal?: AbortSignal, ms = 200): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error('REPLY_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  throwIfAborted(signal);
}

export async function evaluate<T>(lease: ReplyBrowserLease, expression: string, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  const result = (await lease.command('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  })) as {
    exceptionDetails?: { text?: string; exception?: { description?: string } };
    result?: { value?: T };
  };
  throwIfAborted(signal);
  if (result?.exceptionDetails) {
    const code = result.exceptionDetails.exception?.description?.match(/REPLY_[A-Z_]+/)?.[0];
    if (code === 'REPLY_THREAD_INCOMPLETE') throw new Error('replyThreadIncomplete');
    throw new Error(code || 'REPLY_PAGE_EVALUATION_FAILED');
  }
  if (!result?.result || !Object.hasOwn(result.result, 'value')) throw new Error('REPLY_PAGE_VALUE_MISSING');
  return result.result.value as T;
}

export function workKey(platform: ReplyPlatform, accountId: string, actorId: string, workId: string): string {
  return [platform, accountId, actorId, workId].join(':');
}

export function mapWork(snapshot: PageSnapshot, accountId: string): ReplyWork {
  return {
    key: workKey(snapshot.platform, accountId, snapshot.actorId, snapshot.workId),
    platform: snapshot.platform,
    accountId,
    actorId: snapshot.actorId,
    actorName: snapshot.actorName,
    workId: snapshot.workId,
    title: snapshot.title,
    url: snapshot.url,
  };
}

export function mapComments(snapshot: PageSnapshot, work: ReplyWork): ReplyComment[] {
  return snapshot.comments.map((row) => ({
    key: `${work.key}:${row.id}`,
    workKey: work.key,
    platform: work.platform,
    accountId: work.accountId,
    actorId: work.actorId,
    workId: work.workId,
    commentId: row.id,
    rootCommentId: row.root,
    parentCommentId: row.parent,
    authorId: row.authorId,
    author: row.author,
    content: row.content,
    createdAt: row.time > 0 && row.time < 1e12 ? row.time * 1000 : row.time,
  }));
}

export function assertBinding(lease: ReplyBrowserLease, work: ReplyWork, target?: ReplyComment): void {
  if (lease.accountId !== work.accountId) throw new Error('REPLY_ACCOUNT_MISMATCH');
  if (work.key !== workKey(work.platform, work.accountId, work.actorId, work.workId))
    throw new Error('REPLY_WORK_KEY_MISMATCH');
  const url = new URL(work.url);
  const expectedHost = work.platform === 'xiaohongshu' ? 'www.xiaohongshu.com' : 'www.douyin.com';
  if (
    url.protocol !== 'https:' ||
    url.hostname !== expectedHost ||
    url.username ||
    url.password ||
    !url.pathname.split('/').includes(work.workId)
  )
    throw new Error('REPLY_WORK_URL_MISMATCH');
  if (
    target &&
    (target.workKey !== work.key ||
      target.accountId !== work.accountId ||
      target.actorId !== work.actorId ||
      target.platform !== work.platform ||
      target.workId !== work.workId ||
      target.key !== `${work.key}:${target.commentId}`)
  )
    throw new Error('REPLY_TARGET_BINDING_MISMATCH');
}
