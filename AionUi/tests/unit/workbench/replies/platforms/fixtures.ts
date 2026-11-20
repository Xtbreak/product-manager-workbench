import { JSDOM } from 'jsdom';
import { runInContext } from 'node:vm';
import type { ReplyBrowserLease } from '@/process/services/workbench/replies/contracts';

type FixtureFiber = {
  tag: number;
  stateNode: unknown;
  memoizedProps: Record<string, unknown>;
  memoizedState?: unknown;
  return: FixtureFiber | null;
  child: FixtureFiber | null;
  sibling: FixtureFiber | null;
};

function appendFiber(parent: FixtureFiber, node: FixtureFiber) {
  node.return = parent;
  node.sibling = null;
  if (!parent.child) parent.child = node;
  else {
    let last = parent.child;
    while (last.sibling) last = last.sibling;
    last.sibling = node;
  }
}

export const XHS_WORK = '6af7088e000000002a02d1ca';
export const XHS_ACTOR = '620291b7000000001000bd3e';
export const XHS_ROOT = '6af7fc270000000031035da8';
export const XHS_CHILD = '6af7fc49000000002d02ab60';
export const DY_WORK = '7630823226675650277';
export const DY_ACTOR = '1632121715433368';
export const DY_ROOT = '7707903681722893094';
export const DY_CHILD = '7707903925181727539';

export function browserFixture(platform: 'xiaohongshu' | 'douyin') {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url:
      platform === 'xiaohongshu'
        ? `https://www.xiaohongshu.com/explore/${XHS_WORK}?xsec_token=signed-value&xsec_source=pc_user`
        : `https://www.douyin.com/note/${DY_WORK}`,
    runScripts: 'outside-only',
  });
  const window = dom.window;
  const document = window.document;
  let timeOrigin = Date.now();
  Object.defineProperty(window.performance, 'timeOrigin', { get: () => timeOrigin });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent ?? '';
    },
    set(value) {
      this.textContent = value;
    },
    configurable: true,
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = !!this.closest('[hidden]');
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: hidden ? 0 : 30,
      right: hidden ? 0 : 30,
      width: hidden ? 0 : 30,
      height: hidden ? 0 : 30,
      toJSON: () => ({}),
    };
  };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.scrollTo = function (_x: unknown, y?: number) {
    this.scrollTop = typeof y === 'number' ? y : this.scrollHeight;
  };
  document.execCommand = (command: string) => {
    if (command !== 'delete' || !document.activeElement?.hasAttribute('contenteditable')) return false;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    selection.getRangeAt(0).deleteContents();
    document.activeElement.dispatchEvent(new window.Event('input', { bubbles: true }));
    return true;
  };
  let clicks = 0;
  let navigations = 0;
  let insertions = 0;
  let beforeEvaluate: (() => void) | undefined;
  const commands: string[] = [];
  const state: Record<string, unknown> = {};
  const lease: ReplyBrowserLease = {
    accountId: 'account-1',
    targetId: 'webview-7',
    release: () => {},
    async command(method, params = {}) {
      commands.push(method);
      if (method === 'Runtime.evaluate') {
        beforeEvaluate?.();
        try {
          const value = runInContext(String(params.expression), dom.getInternalVMContext());
          return { result: { type: 'object', value: JSON.parse(JSON.stringify(value)) } };
        } catch (error) {
          return { exceptionDetails: { text: 'Uncaught', exception: { description: String(error) } } };
        }
      }
      if (method === 'Page.navigate') {
        navigations++;
        timeOrigin++;
        dom.reconfigure({ url: String(params.url) });
        return {};
      }
      if (method === 'Input.insertText') {
        insertions++;
        const editor = document.activeElement;
        if (!editor?.hasAttribute('contenteditable')) throw new Error('Editor not focused');
        editor.textContent = (editor.textContent?.trim() ? editor.textContent : '') + String(params.text);
        return {};
      }
      throw new Error(`Unexpected browser command: ${method}`);
    },
  };
  const actor = platform === 'xiaohongshu' ? XHS_ACTOR : DY_ACTOR;
  const root = platform === 'xiaohongshu' ? XHS_ROOT : DY_ROOT;
  const child = platform === 'xiaohongshu' ? XHS_CHILD : DY_CHILD;
  const workId = platform === 'xiaohongshu' ? XHS_WORK : DY_WORK;
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.setAttribute('contenteditable', 'true');
  editor.tabIndex = 0;
  const input = document.createElement('div');
  input.className = 'comment-input-inner-container';
  input.append(editor);
  const send = document.createElement('button');
  send.textContent = '发送';
  send.className = platform === 'xiaohongshu' ? 'btn submit' : 'wchsYBpK jfGCpJo0';
  input.append(send);
  const container = document.createElement('div');
  container.className = 'comments-container';
  container.setAttribute('data-e2e', 'comment-list');
  document.body.append(container, input);
  const comments: Array<Record<string, unknown>> = [];
  const hostRoot: FixtureFiber = {
    tag: 3,
    stateNode: null,
    memoizedProps: {},
    return: null,
    child: null,
    sibling: null,
  };
  hostRoot.stateNode = { current: hostRoot };
  const attachDouyinFiber = (el: Element, props: Record<string, unknown>, parent = hostRoot) => {
    const fiber: FixtureFiber = {
      tag: 5,
      stateNode: el,
      memoizedProps: props,
      return: null,
      child: null,
      sibling: null,
    };
    appendFiber(parent, fiber);
    Object.defineProperty(el, '__reactFiber$test', { value: fiber, configurable: true });
    return fiber;
  };
  const moveDouyinWorkToEditorAncestor = () => {
    const player = document.querySelector('[data-e2e="video-player"]');
    if (!player) throw new Error('Douyin player fixture unavailable');
    const playerFiber = Reflect.get(player, '__reactFiber$test') as FixtureFiber;
    const editorFiber = Reflect.get(editor, '__reactFiber$test') as FixtureFiber;
    const parent = editorFiber.return;
    if (!parent) throw new Error('Douyin editor root unavailable');
    let previous: FixtureFiber | null = null;
    for (let node = parent.child; node; node = node.sibling) {
      if (node === editorFiber) {
        if (previous) previous.sibling = node.sibling;
        else parent.child = node.sibling;
        break;
      }
      previous = node;
    }
    playerFiber.tag = 0;
    playerFiber.stateNode = null;
    appendFiber(playerFiber, editorFiber);
    player.remove();
  };
  let currentTarget = root;
  const replyProps = { cid: root, level: 1, levelOneCid: root, replyText: '' };
  let douyinEvidence:
    | {
        props: Record<string, unknown>;
        hooks: Array<{ memoizedState: unknown; next?: unknown }>;
      }
    | undefined;
  const setDouyinThreadEvidence = (loaded: Array<Record<string, unknown>>, hasMore: boolean) => {
    if (!douyinEvidence) throw new Error('Douyin thread fixture unavailable');
    douyinEvidence.props.replyTotal = comments[0].replyTotal;
    douyinEvidence.hooks[2].memoizedState = loaded;
    douyinEvidence.hooks[3].memoizedState = { current: loaded.length };
    douyinEvidence.hooks[4].memoizedState = { current: loaded.length + 2 };
    douyinEvidence.hooks[5].memoizedState = { current: hasMore };
  };
  const setDouyinThreadLoading = (loading: boolean) => {
    if (!douyinEvidence) throw new Error('Douyin thread fixture unavailable');
    douyinEvidence.hooks[7].memoizedState = loading;
  };
  const addComment = (id: string, content: string, parent: string | null, authorId = actor) => {
    const comment =
      platform === 'xiaohongshu'
        ? {
            id,
            noteId: workId,
            userInfo: { userId: authorId, nickname: 'User' },
            content,
            createTime: Date.now(),
            targetComment: parent ? { id: parent } : undefined,
            subComments: [],
            subCommentCount: '0',
            subCommentHasMore: false,
          }
        : {
            cid: id,
            text: content,
            user: { uid: authorId, nickname: 'User' },
            replyId: parent ? root : '0',
            replyToUserId: parent && parent !== root ? parent : '0',
            createTime: Math.floor(Date.now() / 1000),
            replyTotal: 0,
            replyComment: [],
          };
    comments.push(comment);
    if (platform === 'xiaohongshu' && parent) {
      const r = comments[0];
      (r.subComments as unknown[]).push(comment);
      r.subCommentCount = String((r.subComments as unknown[]).length);
    }
    if (platform === 'douyin' && parent) {
      const children = comments.filter((item) => item.replyId === root);
      comments[0].replyTotal = children.length;
      if (douyinEvidence) setDouyinThreadEvidence(children, false);
    }
    const el = document.createElement('div');
    el.id = `comment-${id}`;
    el.setAttribute('data-e2e', 'comment-item');
    const text = document.createElement('span');
    text.textContent = content;
    const reply = document.createElement('span');
    reply.className = 'reply';
    reply.textContent = '回复';
    reply.addEventListener('click', () => {
      currentTarget = id;
      replyProps.cid = id;
      replyProps.level = id === root ? 1 : 2;
      if (platform === 'xiaohongshu') (state.note as Record<string, unknown>).commentTarget = { ...comment };
    });
    el.append(text, reply);
    if (platform === 'douyin') attachDouyinFiber(el, { commentInfo: comment, level: parent ? 2 : 1 });
    container.append(el);
    return comment;
  };
  addComment(root, 'Root question', null, 'customer-root');
  addComment(child, 'Follow-up question', root, 'customer-child');
  if (platform === 'xiaohongshu') {
    editor.id = 'content-textarea';
    Object.assign(state, {
      user: { userInfo: { value: { userId: actor, nickname: 'Owner' } } },
      note: {
        commentTarget: null,
        noteDetailMap: {
          [workId]: {
            note: { noteId: workId, title: 'Own work', user: { userId: actor } },
            comments: { list: [comments[0]], hasMore: false },
          },
        },
      },
    });
    Object.defineProperty(window, '__INITIAL_STATE__', { value: state });
  } else {
    Object.assign(state, { app: { user: { isLogin: true, info: { uid: actor, nickname: 'Owner' } } } });
    Object.defineProperty(window, 'SSR_RENDER_DATA', { value: state });
    attachDouyinFiber(editor, replyProps);
    const own = document.createElement('div');
    own.setAttribute('data-e2e', 'video-player');
    attachDouyinFiber(own, {
      awemeInfo: { awemeId: workId, desc: 'Own work', author: { uid: actor }, statistics: { commentCount: 2 } },
    });
    document.body.prepend(own);
    const marker = document.createElement('span');
    const rootElement = document.getElementById(`comment-${root}`)!;
    rootElement.append(marker);
    const hookValues: unknown[] = [
      [],
      [[], [[]]],
      [],
      { current: 0 },
      { current: 0 },
      { current: false },
      { current: '' },
      false,
    ];
    const hooks = hookValues.map((memoizedState) => ({ memoizedState, next: undefined as unknown }));
    for (let i = 0; i + 1 < hooks.length; i++) hooks[i].next = hooks[i + 1];
    const props = {
      levelOneCid: root,
      originCommentInfo: comments[0],
      replyTotal: comments[0].replyTotal,
      defaultReply: [],
      newPublishTopReply: [],
      fetchReply: () => {},
    };
    douyinEvidence = { props, hooks };
    const replyComponent: FixtureFiber = {
      tag: 0,
      stateNode: null,
      memoizedProps: props,
      memoizedState: hooks[0],
      return: null,
      child: null,
      sibling: null,
    };
    appendFiber(Reflect.get(rootElement, '__reactFiber$test') as FixtureFiber, replyComponent);
    attachDouyinFiber(marker, {}, replyComponent);
    setDouyinThreadEvidence(
      comments.filter((item) => item.replyId === root),
      false
    );
  }
  send.addEventListener('click', () => {
    clicks++;
    addComment(
      platform === 'xiaohongshu' ? '6af7fc5b000000003103bc30' : '7707904226752185122',
      editor.textContent ?? '',
      currentTarget
    );
    editor.textContent = '';
  });
  return {
    dom,
    window,
    document,
    lease,
    state,
    comments,
    editor,
    send,
    container,
    addComment,
    attachDouyinFiber,
    moveDouyinWorkToEditorAncestor,
    setDouyinThreadEvidence,
    setDouyinThreadLoading,
    replyProps,
    get clicks() {
      return clicks;
    },
    get navigations() {
      return navigations;
    },
    get insertions() {
      return insertions;
    },
    commands,
    set beforeEvaluate(value: (() => void) | undefined) {
      beforeEvaluate = value;
    },
  };
}
