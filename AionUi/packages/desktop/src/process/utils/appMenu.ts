/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { APP_DISPLAY_NAME, UPSTREAM_UPDATE_ENABLED } from '@/common/branding';
import type { MenuItemConstructorOptions } from 'electron';
import { Menu, MenuItem, app } from 'electron';

export function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    // Keep Electron's native role labels and shortcuts, replacing only the app name.
    const displayLabel = (role: 'about' | 'hide' | 'quit'): string =>
      new MenuItem({ role }).label.replace(app.name, APP_DISPLAY_NAME);

    app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME, applicationVersion: app.getVersion(), version: '' });
    template.push({
      label: APP_DISPLAY_NAME,
      submenu: [
        { role: 'about', label: displayLabel('about') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: displayLabel('hide') },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: displayLabel('quit') },
      ],
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])
        : ([{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  if (UPSTREAM_UPDATE_ENABLED) {
    template.push({
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: () => {
            ipcBridge.update.open.emit({ source: 'menu' });
          },
        },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
