import { ipcRenderer } from 'electron';
import { isWorkbenchFeishuOrigin, parseWorkbenchCommentLink, parseWorkbenchDmLink } from '@/common/utils/urlValidation';

// This isolated preload is attached only to the persistent Workbench Feishu guest.
// No API is exposed to the page, whose console can be replaced or disabled.
const forwardWorkbenchLink = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const comment = parseWorkbenchCommentLink(value);
  if (comment) {
    ipcRenderer.sendToHost('workbench-comment-link', comment);
    return true;
  }
  const dm = parseWorkbenchDmLink(value);
  if (!dm || !isWorkbenchFeishuOrigin(window.location.href)) return false;
  ipcRenderer.sendToHost('workbench-dm-link', dm);
  return true;
};

document.addEventListener(
  'click',
  (event) => {
    const anchor = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    if (!anchor || !forwardWorkbenchLink(anchor.href)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true
);

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || !event.data || typeof event.data !== 'object') return;
  const data = event.data as Record<string, unknown>;
  if (data.type === '__WEBVIEW_HOST_NAVIGATE__') forwardWorkbenchLink(data.url);
});

// Main-process fallback for native popups and frame navigations which bypass top-document anchors.
ipcRenderer.on('workbench-dm-navigation', (_event, token: unknown) => {
  if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && isWorkbenchFeishuOrigin(window.location.href))
    ipcRenderer.sendToHost('workbench-dm-link', token);
});
