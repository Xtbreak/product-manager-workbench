/** Guest-page operations based on the verified Xiaohongshu note/comment state. */
export const XIAOHONGSHU_PAGE = String.raw`
const platform = 'xiaohongshu';
const currentWorkId = () => {
  const path = location.pathname;
  return path.match(/^\/(?:explore|discovery\/item)\/([0-9a-f]{24})(?:\/|$)/)?.[1] || path.match(/^\/user\/profile\/[^/]+\/([0-9a-f]{24})(?:\/|$)/)?.[1] || '';
};
const noteState = () => {
  const state = window.__INITIAL_STATE__;
  const workId = currentWorkId();
  const detail = unwrap(state?.note?.noteDetailMap)?.[workId];
  return { state, workId, detail, actor: unwrap(state?.user?.userInfo) };
};
const readPage = () => {
  const { workId, detail, actor } = noteState();
  const note = detail?.note;
  const comments = [];
  const roots = detail?.comments?.list;
  let complete = Array.isArray(roots) && detail.comments.hasMore === false;
  const seen = new Set();
  const completeThreads = [];
  const rootIds = (Array.isArray(roots) ? roots : []).map(root => id(root.id));
  let duplicateComment = false;
  let ambiguous = Array.isArray(roots) && roots.length > 500;
  let rawCount = 0;
  for (const root of Array.isArray(roots) ? roots : []) {
    rawCount += 1 + (Array.isArray(root.subComments) ? root.subComments.length : 0);
    if (rawCount > 500) { ambiguous = true; break; }
  }
  for (const root of Array.isArray(roots) ? roots.slice(0, 500) : []) {
    const children = Array.isArray(root.subComments) ? root.subComments : [];
    if (children.length + comments.length + 1 > 500) ambiguous = true;
    const rawCount = root.subCommentCount;
    const count = typeof rawCount === 'number' || (typeof rawCount === 'string' && /^\d+$/.test(rawCount)) ? Number(rawCount) : NaN;
    const rootId = id(root.id);
    let threadComplete = !!rootId && rootIds.filter(value => value === rootId).length === 1
      && Array.isArray(root.subComments) && Number.isSafeInteger(count) && count >= 0 && count === children.length
      && root.subCommentHasMore === false && comments.length + 1 + children.length <= 500;
    const parents = new Map();
    if (!Number.isSafeInteger(count) || count < 0 || count > children.length || root.subCommentHasMore === true) complete = false;
    for (const row of [root, ...children].slice(0, 500)) {
      const cid = id(row.id), authorId = id(row.userInfo?.userId);
      const parent = row === root ? null : id(row.targetComment?.id);
      if (cid && seen.has(cid)) { duplicateComment = true; ambiguous = true; complete = false; threadComplete = false; continue; }
      if (cid) seen.add(cid);
      if (!cid || !rootId || !authorId || (row !== root && !parent) || (row.noteId && row.noteId !== workId) || typeof row.content !== 'string') { ambiguous = true; complete = false; threadComplete = false; continue; }
      if (row !== root) parents.set(cid, parent);
      comments.push({ id: cid, root: rootId, parent, authorId, author: row.userInfo.nickname || '', content: row.content, time: Number(row.createTime) || 0 });
      if (comments.length >= 500) { complete = false; break; }
    }
    if (threadComplete) {
      for (const [cid, firstParent] of parents) {
        const chain = new Set([cid]);
        let parent = firstParent;
        while (parent !== rootId) {
          if (!parent || chain.has(parent) || !parents.has(parent)) { threadComplete = false; break; }
          chain.add(parent);
          parent = parents.get(parent);
        }
        if (!threadComplete) break;
      }
    }
    if (threadComplete && parents.size === children.length) completeThreads.push(rootId);
    else complete = false;
    if (comments.length >= 500) break;
  }
  if (roots?.length > 500) complete = false;
  return { platform, url: location.href, workId: note?.noteId === workId ? workId : '', actorId: id(actor?.userId), actorName: actor?.nickname || '', ownerId: id(note?.user?.userId), title: note?.title || '', comments, complete, completeThreads: duplicateComment ? [] : completeThreads, ambiguous };
};
const editor = () => unique(document.querySelectorAll('#content-textarea[contenteditable="true"]'), 'EDITOR');
const assertSelected = () => {
  const { state, workId } = noteState();
  const target = unwrap(state?.note?.commentTarget);
  if (target?.id !== A.target.commentId || (target.noteId && target.noteId !== workId)) throw Error('REPLY_SELECTED_TARGET_CHANGED');
};
const highlightTarget = () => highlight(Array.from(document.querySelectorAll('[id]')).filter(el => el.id === 'comment-' + A.target.commentId));
const chooseReply = () => {
  const row = unique(Array.from(document.querySelectorAll('[id]')).filter(el => el.id === 'comment-' + A.target.commentId), 'TARGET');
  const control = unique(row.querySelectorAll('.reply'), 'REPLY_CONTROL');
  control.click();
};
const sendButton = () => {
  const button = unique(document.querySelectorAll('button.btn.submit'), 'SEND_CONTROL');
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') throw Error('REPLY_SEND_DISABLED');
  return button;
};
const advance = () => advanceComments(Array.from(document.querySelectorAll('.comments-container')).find(visible));
`;
