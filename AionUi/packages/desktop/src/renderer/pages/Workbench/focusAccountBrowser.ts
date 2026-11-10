/** Reveal an account's existing guest before dispatching native input. */
export async function focusAccountBrowser(
  webContentsId: number,
  select: (accountId: string) => Promise<void>
): Promise<boolean> {
  const view = Array.from(document.querySelectorAll<Electron.WebviewTag>('webview')).find((candidate) => {
    try {
      return candidate.getWebContentsId() === webContentsId;
    } catch {
      return false;
    }
  });
  if (!view) return false;
  const layer = view.closest<HTMLElement>('[data-workbench-account-id]');
  if (layer?.hidden && layer.dataset.workbenchAccountId) await select(layer.dataset.workbenchAccountId);
  view.focus();
  return document.activeElement === view;
}
