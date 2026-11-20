import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const electron = vi.hoisted(() => ({
  app: { name: 'AionUi-Dev', getVersion: () => '2.2.2', setAboutPanelOptions: vi.fn() },
  buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => template),
  setApplicationMenu: vi.fn(),
}));

vi.mock('electron', () => ({
  app: electron.app,
  Menu: {
    buildFromTemplate: electron.buildFromTemplate,
    setApplicationMenu: electron.setApplicationMenu,
  },
  MenuItem: class {
    label: string;
    constructor({ role }: MenuItemConstructorOptions) {
      const defaults = { about: 'About', hide: 'Hide', quit: 'Quit' };
      this.label = `${defaults[role as keyof typeof defaults]} ${electron.app.name}`;
    }
  },
}));

vi.mock('@/common', () => ({ ipcBridge: { update: { open: { emit: vi.fn() } } } }));

import { setupApplicationMenu } from '@/process/utils/appMenu';

const realPlatform = process.platform;

describe('application menu branding', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('displays the Workbench name while retaining native app actions and shortcuts', () => {
    setupApplicationMenu();

    const menu = electron.setApplicationMenu.mock.calls[0][0] as MenuItemConstructorOptions[];
    expect(menu[0].label).toBe('工作台');
    const items = menu[0].submenu as MenuItemConstructorOptions[];
    expect(items.filter((item) => ['about', 'hide', 'quit'].includes(item.role ?? ''))).toEqual([
      { role: 'about', label: 'About 工作台' },
      { role: 'hide', label: 'Hide 工作台' },
      { role: 'quit', label: 'Quit 工作台' },
    ]);
    expect(electron.app.name).toBe('AionUi-Dev');
  });

  it('uses the Workbench name and product version in the native about panel', () => {
    setupApplicationMenu();
    expect(electron.app.setAboutPanelOptions).toHaveBeenCalledWith({
      applicationName: '工作台',
      applicationVersion: '2.2.2',
      version: '',
    });
  });

  it('does not add a macOS app menu or about panel configuration on other platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    setupApplicationMenu();
    const menu = electron.setApplicationMenu.mock.calls[0][0] as MenuItemConstructorOptions[];
    expect(menu[0].label).toBe('Edit');
    expect(electron.app.setAboutPanelOptions).not.toHaveBeenCalled();
  });
});
