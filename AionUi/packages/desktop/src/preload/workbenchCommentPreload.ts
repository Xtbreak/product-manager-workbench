import { ipcRenderer } from 'electron';
import { parseWorkbenchCommentLink } from '@/common/utils/urlValidation';

// This isolated preload is attached only to the persistent Workbench Feishu guest.
// No API is exposed to the page, whose console can be replaced or disabled.
const forwardCommentLink = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const token = parseWorkbenchCommentLink(value);
  if (!token) return false;
  ipcRenderer.sendToHost('workbench-comment-link', token);
  return true;
};

document.addEventListener(
  'click',
  (event) => {
    const anchor = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    if (!anchor || !forwardCommentLink(anchor.href)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true
);

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || !event.data || typeof event.data !== 'object') return;
  const data = event.data as Record<string, unknown>;
  if (data.type === '__WEBVIEW_HOST_NAVIGATE__') forwardCommentLink(data.url);
});
