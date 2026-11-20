import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProductProfileDirectory, APP_DATA_NAMESPACE } from '@/common/branding';
import { NodePlatformServices } from '@/common/platform/NodePlatformServices';
const state = vi.hoisted(() => ({ packaged: false }));
vi.mock('@/common/platform', () => ({ getPlatformServices: () => ({ paths: { isPackaged: () => state.packaged } }) }));
import { getEnvAwareName } from '@/common/config/appEnv';
afterEach(() => {
  vi.unstubAllEnvs();
  state.packaged = false;
});
describe('product data isolation', () => {
  it('gives release, dev and second dev distinct product directories', () => {
    expect([
      getProductProfileDirectory(true),
      getProductProfileDirectory(false),
      getProductProfileDirectory(false, true),
    ]).toEqual(['PMWorkbench', 'PMWorkbench-Dev', 'PMWorkbench-Dev-2']);
  });
  it('does not reuse upstream data or configuration symlinks', () => {
    vi.stubEnv('AIONUI_MULTI_INSTANCE', '0');
    expect(getEnvAwareName('.aionui')).toBe('.pm-workbench-dev');
    expect(getEnvAwareName('.aionui-config')).toBe('.pm-workbench-config-dev');
    state.packaged = true;
    expect(getEnvAwareName('.aionui')).toBe('.pm-workbench');
  });
  it('keeps second-instance links separate without renaming unrelated names', () => {
    vi.stubEnv('AIONUI_MULTI_INSTANCE', '1');
    expect(getEnvAwareName('.aionui')).toBe('.pm-workbench-dev-2');
    expect(getEnvAwareName('unrelated')).toBe('unrelated-dev-2');
  });
  it('isolates standalone node defaults and respects explicitly supplied worker paths', () => {
    vi.stubEnv('DATA_DIR', undefined);
    expect(new NodePlatformServices().paths.getDataDir()).toContain('.' + APP_DATA_NAMESPACE + '-server');
    vi.stubEnv('DATA_DIR', '/temporary/worker-profile');
    expect(new NodePlatformServices().paths.getDataDir()).toBe('/temporary/worker-profile');
  });
});

import { buildSpawnEnv } from '../../../packages/web-host/src/backend-launcher';
describe('Codex session isolation', () => {
  it('uses the profile-local CLI history without changing the parent login', () => {
    vi.stubEnv('CODEX_HOME', '/global/codex');
    expect(buildSpawnEnv(undefined, '/profiles/one').CODEX_HOME).toBe('/profiles/one/codex-home');
    expect(buildSpawnEnv(undefined, '/profiles/two').CODEX_HOME).toBe('/profiles/two/codex-home');
    expect(process.env.CODEX_HOME).toBe('/global/codex');
  });
});
