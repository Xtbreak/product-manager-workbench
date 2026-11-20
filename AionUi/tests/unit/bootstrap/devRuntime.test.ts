import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareMacDevRuntime } from '../../../packages/desktop/devRuntime';

const temporaryDirectories: string[] = [];
afterEach(() => temporaryDirectories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workbench-runtime-test-'));
  temporaryDirectories.push(root);
  const contents = join(root, 'upstream', 'Electron.app', 'Contents');
  const sourceExecutable = join(contents, 'MacOS', 'Electron');
  mkdirSync(dirname(sourceExecutable), { recursive: true });
  mkdirSync(join(contents, 'Resources'));
  writeFileSync(sourceExecutable, 'original-signed-binary', { mode: 0o755 });
  writeFileSync(join(contents, 'Resources', 'electron.icns'), 'upstream-icon');
  const metadata = {
    CFBundleName: 'Electron',
    CFBundleDisplayName: 'Electron',
    CFBundleIdentifier: 'com.github.Electron',
    CFBundleExecutable: 'Electron',
    CFBundleIconFile: 'electron.icns',
    CFBundleShortVersionString: '37.10.3',
  };
  writeFileSync(join(contents, 'Info.plist'), JSON.stringify(metadata));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', join(contents, 'Info.plist')]);
  const iconPath = join(root, 'workbench.icns');
  writeFileSync(iconPath, 'approved-W-icon');
  return { sourceExecutable, iconPath, cacheDir: join(root, 'cache'), contents, metadata };
}

describe.skipIf(process.platform !== 'darwin')('macOS development branding', () => {
  it('brands a private copy while preserving the original executable and encryption identity', () => {
    const input = fixture();
    const originalPlist = readFileSync(join(input.contents, 'Info.plist'));
    const executable = prepareMacDevRuntime(input);
    const contents = dirname(dirname(executable));
    const metadata = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(contents, 'Info.plist')], {
        encoding: 'utf8',
      })
    );

    expect(executable).not.toBe(input.sourceExecutable);
    expect(executable).toContain('工作台.app/Contents/MacOS/Electron');
    expect(metadata).toEqual({ ...input.metadata, CFBundleDisplayName: '工作台' });
    // AppKit takes the first menu title from the localized bundle name, even
    // when Electron supplies an explicit menu label. Keep the raw name intact.
    expect(readFileSync(join(contents, 'Resources', 'en.lproj', 'InfoPlist.strings'), 'utf8')).toContain(
      '"CFBundleName" = "工作台";'
    );
    expect(readFileSync(executable)).toEqual(readFileSync(input.sourceExecutable));
    expect(statSync(executable).ino).not.toBe(statSync(input.sourceExecutable).ino);
    expect(readFileSync(join(contents, 'Resources', 'electron.icns'), 'utf8')).toBe('approved-W-icon');
    expect(readFileSync(join(input.contents, 'Resources', 'electron.icns'), 'utf8')).toBe('upstream-icon');
    expect(readFileSync(join(input.contents, 'Info.plist'))).toEqual(originalPlist);
  });

  it('reuses the same runtime, and creates a new copy when the icon or Electron changes', () => {
    const input = fixture();
    const first = prepareMacDevRuntime(input);
    const inode = statSync(first).ino;
    expect(prepareMacDevRuntime(input)).toBe(first);
    expect(statSync(first).ino).toBe(inode);
    writeFileSync(input.iconPath, 'updated-approved-icon');
    const second = prepareMacDevRuntime(input);
    expect(second).not.toBe(first);
    writeFileSync(input.sourceExecutable, 'updated-electron-binary');
    expect(prepareMacDevRuntime(input)).not.toBe(second);
    expect(readFileSync(first, 'utf8')).toBe('original-signed-binary');
  });
});
