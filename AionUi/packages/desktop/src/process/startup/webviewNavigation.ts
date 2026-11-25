import { session as electronSession, type App, type Session } from 'electron';
import { isAbsolute } from 'node:path';
import { isEmbeddedBrowserUrl, isWorkbenchFeishuOrigin, parseWorkbenchDmLink } from '@/common/utils/urlValidation';

/** Install before creating any windows so guest pages cannot launch external applications. */
export function installWebviewNavigationGuards(
  app: App,
  defaultSession: Session,
  commentPreloadPath: string,
  feishuSession = () => electronSession.fromPartition('persist:workbench-feishu')
): void {
  if (!isAbsolute(commentPreloadPath)) throw new Error('Comment preload must use an absolute path');
  const protectedSessions = new WeakSet<Session>();
  const protectSession = (session: Session) => {
    if (protectedSessions.has(session)) return;
    protectedSessions.add(session);
    // Preserve existing grants (including Local Font Access), but never let page
    // navigation launch native apps. This also covers programmatic loadURL calls.
    session.setPermissionCheckHandler((_contents, permission) => permission !== 'openExternal');
    session.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission !== 'openExternal');
    });
  };
  protectSession(defaultSession);

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, preferences, params) => {
      if (params.src && !isEmbeddedBrowserUrl(params.src)) event.preventDefault();
      if (params.partition === 'persist:workbench-feishu') preferences.preload = commentPreloadPath;
    });
    if (contents.getType() !== 'webview') return;

    protectSession(contents.session);
    // Canvas links, native popups and frame navigations may bypass the top document's click listener.
    const routeNativeDm = (url: string, initiator?: string) => {
      const token = parseWorkbenchDmLink(url);
      if (!token || contents.session !== feishuSession() || !isWorkbenchFeishuOrigin(contents.getURL())) return false;
      if (!initiator || isWorkbenchFeishuOrigin(initiator)) contents.send('workbench-dm-navigation', token);
      return true;
    };
    const guardNavigation = (event: {
      url: string;
      initiator?: { url: string } | null;
      preventDefault: () => void;
    }) => {
      if (!isEmbeddedBrowserUrl(event.url) || routeNativeDm(event.url, event.initiator?.url)) event.preventDefault();
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-frame-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    // WebviewHost routes ordinary popup links into the existing guest. Never
    // create an unmanaged native window, even before its injected script is ready.
    contents.setWindowOpenHandler(({ url, referrer }) => {
      routeNativeDm(url, referrer?.url);
      return { action: 'deny' };
    });
  });
}
