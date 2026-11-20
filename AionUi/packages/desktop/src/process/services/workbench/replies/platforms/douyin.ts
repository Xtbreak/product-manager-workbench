/** Guest-page operations; every platform identifier remains a string. */
export const DOUYIN_PAGE = String.raw`
const platform = 'douyin';
const currentWorkId = () => location.pathname.match(/^\/(?:note|video)\/(\d+)(?:\/|$)/)?.[1] || '';
const commentInfo = (el) => {
  const props = fiberProps(el, p => !!p.commentInfo);
  if (!props?.commentInfo) throw Error('REPLY_FIBER_UNVERIFIED');
  return props.commentInfo;
};
const workData = () => {
  const workId = currentWorkId();
  const matches = [];
  const visited = new Set();
  const keys = ['awemeInfo', 'awemeDetail', 'aweme', 'data', 'item', 'videoInfo', 'video', 'info'];
  for (const el of Array.from(document.querySelectorAll('[data-e2e], video, [class*="player"], [class*="video-info"], .comment-input-inner-container, [contenteditable="true"]')).filter(visible).slice(0, 500)) {
    fiberProps(el, props => {
      if (visited.has(props)) return false;
      visited.add(props);
      for (const key of keys) {
        const data = props[key];
        if (!data || typeof data !== 'object') continue;
        const candidateId = id(data.aweme_id) || id(data.awemeId);
        if (candidateId === workId) matches.push(data);
      }
      return false;
    });
  }
  const owners = new Set(matches.map(d => id(d.author?.uid) || id(d.authorInfo?.uid) || id(d.author_user_id) || id(d.authorUserId)).filter(Boolean));
  if (owners.size !== 1) return null;
  return matches.find(d => (id(d.author?.uid) || id(d.authorInfo?.uid) || id(d.author_user_id) || id(d.authorUserId)) === Array.from(owners)[0]);
};
const parseComment = (row) => {
  const cid = id(row?.cid), authorId = id(row?.user?.uid);
  const root = id(row?.replyId), direct = id(row?.replyToUserId);
  if (!cid || !authorId || !root || !direct || typeof row.text !== 'string') return null;
  return { id: cid, root: root === '0' ? cid : root, parent: root === '0' ? null : direct === '0' ? root : direct, authorId, author: row.user?.nickname || '', content: row.text, time: Number(row.createTime) || 0 };
};
const replyComponents = (rootElement, rootId, total) => {
  const found = new Set();
  const visited = new Set();
  for (const el of [rootElement, ...rootElement.querySelectorAll('*')]) {
    let node = currentFiber(el);
    for (let depth = 0; node && depth < 35 && !visited.has(node); depth++, node = fiberParent(node)) {
      visited.add(node);
      const props = node.memoizedProps;
      if (props?.levelOneCid === rootId && props.originCommentInfo?.cid === rootId
        && props.replyTotal === total && props.originCommentInfo.replyTotal === total
        && Array.isArray(props.defaultReply) && typeof props.fetchReply === 'function') found.add(node);
    }
  }
  return [...found];
};
const hasReplyExpansion = (rootElement) => Array.from(rootElement.querySelectorAll('*')).some(el =>
  el.children.length === 0 && visible(el) && /^(?:(?:展开|查看更多|加载更多).{0,30}(?:回复|评论)|展开更多)$/.test(label(el).trim()));
const replyHooks = (node) => {
  const hooks = [];
  let hook = node.memoizedState;
  for (let index = 0; hook && index < 8; index++, hook = hook.next) hooks.push(hook.memoizedState);
  return hooks;
};
const readPage = () => {
  const login = window.SSR_RENDER_DATA?.app?.user;
  const own = workData();
  const workId = currentWorkId();
  const comments = [];
  const seen = new Map();
  let complete = false;
  const allVisibleRows = Array.from(document.querySelectorAll('[data-e2e="comment-item"]')).filter(visible);
  const visibleRows = allVisibleRows.slice(0, 500);
  let conflicting = allVisibleRows.length > 500;
  const append = (row) => {
    const rawId = id(row?.cid);
    const parsed = parseComment(row);
    if (!parsed) {
      conflicting = true;
      if (rawId && !seen.has(rawId)) seen.set(rawId, null);
      return null;
    }
    if (seen.has(parsed.id)) {
      const previous = seen.get(parsed.id);
      if (!previous || ['root', 'parent', 'authorId', 'content', 'time'].some(key => previous[key] !== parsed[key])) conflicting = true;
      return parsed;
    }
    if (comments.length >= 500) { conflicting = true; return null; }
    seen.set(parsed.id, parsed);
    comments.push(parsed);
    return parsed;
  };
  for (const el of visibleRows) {
    append(commentInfo(el));
  }
  const completeThreads = [];
  const targetRoot = id(A.target?.rootCommentId);
  if (targetRoot) {
    const rootRows = visibleRows.filter(el => { const row = commentInfo(el); return row?.cid === targetRoot && row.replyId === '0'; });
    if (rootRows.length === 1) {
      const rootElement = rootRows[0];
      const root = commentInfo(rootElement);
      const total = root?.replyTotal;
      const visibleChildren = comments.filter(row => row.root === targetRoot && row.id !== targetRoot);
      const validTotal = Number.isSafeInteger(total) && total >= 0 && total < 500;
      if (validTotal && total === 0) {
        const rootProps = fiberProps(rootElement, props => props.commentInfo?.cid === targetRoot && props.level === 1);
        const components = replyComponents(rootElement, targetRoot, total);
        let emptyComponent = components.length === 0;
        if (components.length === 1) {
          const node = components[0], hooks = replyHooks(node), props = node.memoizedProps;
          emptyComponent = Array.isArray(hooks[2]) && hooks[2].length === 0 && hooks[3]?.current === 0
            && Number.isSafeInteger(hooks[4]?.current) && hooks[4].current >= 0 && hooks[5]?.current === false
            && hooks[7] === false && props.defaultReply.length === 0 && Array.isArray(props.newPublishTopReply)
            && props.newPublishTopReply.length === 0;
        }
        if (rootProps && Array.isArray(root.replyComment) && root.replyComment.length === 0
          && visibleChildren.length === 0 && emptyComponent && !hasReplyExpansion(rootElement) && !conflicting) completeThreads.push(targetRoot);
      } else if (validTotal) {
        const candidates = replyComponents(rootElement, targetRoot, total);
        if (candidates.length === 1) {
          const node = candidates[0];
          const props = node.memoizedProps;
          const hooks = replyHooks(node);
          const loaded = hooks[2], loadedCount = hooks[3]?.current, cursor = hooks[4]?.current, hasMore = hooks[5]?.current;
          if (Array.isArray(loaded)) {
            let valid = true;
            const parents = new Map();
            for (const raw of loaded) {
              const parsed = parseComment(raw);
              if (!parsed || parsed.root !== targetRoot || parsed.id === targetRoot || parents.has(parsed.id)) { valid = false; conflicting = true; continue; }
              parents.set(parsed.id, parsed.parent);
              if (!append(raw)) valid = false;
            }
            for (const [cid, firstParent] of parents) {
              const chain = new Set([cid]);
              let parent = firstParent;
              while (parent !== targetRoot) {
                if (!parent || chain.has(parent) || !parents.has(parent)) { valid = false; break; }
                chain.add(parent);
                parent = parents.get(parent);
              }
            }
            if (visibleChildren.some(row => !parents.has(row.id))) valid = false;
            if (valid && !conflicting && props.defaultReply.length === 0 && Array.isArray(props.newPublishTopReply)
              && props.newPublishTopReply.length === 0 && loaded.length === total && loadedCount === total
              && Number.isSafeInteger(cursor) && cursor >= loadedCount && hasMore === false && hooks[7] === false
              && !hasReplyExpansion(rootElement))
              completeThreads.push(targetRoot);
          }
        }
      }
    }
  }
  // A visible end marker alone does not prove all nested threads were expanded.
  // Until a stable complete pagination contract is verified, report partial.
  return { platform, url: location.href, workId, actorId: login?.isLogin ? id(login.info?.uid) : '', actorName: login?.info?.nickname || '', ownerId: id(own?.author?.uid) || id(own?.authorInfo?.uid) || id(own?.author_user_id) || id(own?.authorUserId), title: own?.desc || '', comments, complete, completeThreads, ambiguous: conflicting };
};
const visibleEditors = () => Array.from(document.querySelectorAll('.comment-input-inner-container [contenteditable="true"]')).filter(visible);
const editor = () => unique(visibleEditors(), 'EDITOR');
const assertSelected = () => {
  const props = fiberProps(editor(), p => Object.hasOwn(p, 'levelOneCid'));
  if (!props) throw Error('REPLY_FIBER_UNVERIFIED');
  if (props.cid !== A.target.commentId) throw Error('REPLY_SELECTED_TARGET_CHANGED');
  if (A.target.commentId !== A.target.rootCommentId && props.levelOneCid !== A.target.rootCommentId) throw Error('REPLY_SELECTED_ROOT_CHANGED');
  if (A.target.commentId === A.target.rootCommentId && props.level !== 1) throw Error('REPLY_SELECTED_ROOT_CHANGED');
};
const highlightTarget = () => highlight(Array.from(document.querySelectorAll('[data-e2e="comment-item"]')).filter(visible).filter(el => commentInfo(el)?.cid === A.target.commentId));
const chooseReply = () => {
  // An already selected row renders "回复中" instead of the ordinary reply control.
  // Reuse only a fully verified editor target; never fall back to its thread root.
  if (visibleEditors().length) {
    try { assertSelected(); return; } catch (error) {
      if (!['REPLY_SELECTED_TARGET_CHANGED', 'REPLY_SELECTED_ROOT_CHANGED'].includes(error?.message)) throw error;
      // Select the exact visible comment below.
    }
  }
  const rows = Array.from(document.querySelectorAll('[data-e2e="comment-item"]')).filter(visible).filter(el => commentInfo(el)?.cid === A.target.commentId);
  const row = unique(rows, 'TARGET');
  const control = unique(Array.from(row.querySelectorAll('*')).filter(el => el.children.length === 0 && label(el).trim() === '回复' && el.closest('[data-e2e="comment-item"]') === row), 'REPLY_CONTROL');
  control.click();
};
const sendButton = () => {
  const scope = editor().closest('.comment-input-inner-container');
  const semantic = Array.from(scope.querySelectorAll('button, [role="button"], [aria-label="发送"]')).filter(el => label(el).trim() === '发送' || el.getAttribute('aria-label') === '发送');
  const candidates = semantic.some(visible) ? semantic : scope.querySelectorAll('.wchsYBpK.jfGCpJo0');
  const button = unique(candidates, 'SEND_CONTROL');
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') throw Error('REPLY_SEND_DISABLED');
  return button;
};
const advance = () => {
  const container = Array.from(document.querySelectorAll('[data-e2e="comment-list"]')).find(visible);
  if (container) return advanceComments(container);
  assertEmptyDraft();
  const tabs = Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && visible(el) && /^评论[（(]\d+[)）]$/.test(label(el).replace(/\s/g, '')));
  if (tabs.length !== 1) return false;
  tabs[0].click();
  return true;
};
`;
