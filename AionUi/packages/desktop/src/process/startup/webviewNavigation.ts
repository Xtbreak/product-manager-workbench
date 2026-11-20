import type { App, Session } from 'electron';
import { isAbsolute } from 'node:path';
import { isEmbeddedBrowserUrl } from '@/common/utils/urlValidation';

/** Install before creating any windows so guest pages cannot launch external applications. */
export function installWebviewNavigationGuards(app: App, defaultSession: Session, commentPreloadPath: string): void {
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
    const guardNavigation = (event: { url: string; preventDefault: () => void }) => {
      if (!isEmbeddedBrowserUrl(event.url)) event.preventDefault();
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-frame-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    // WebviewHost routes ordinary popup links into the existing guest. Never
    // create an unmanaged native window, even before its injected script is ready.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}
