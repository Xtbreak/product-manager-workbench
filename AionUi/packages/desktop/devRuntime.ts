import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { APP_DISPLAY_NAME } from './src/common/branding';

type DevRuntimeOptions = {
  sourceExecutable: string;
  iconPath: string;
  cacheDir: string;
};

/**
 * Brand the development bundle before macOS displays it. Never patch the shared
 * Electron dependency or change its executable, signature or Keychain identity.
 * app.setName remains the legacy dev name; only the bundle's display name changes.
 */
export function prepareMacDevRuntime({ sourceExecutable, iconPath, cacheDir }: DevRuntimeOptions): string {
  const sourceContents = dirname(dirname(sourceExecutable));
  const sourceBundle = dirname(sourceContents);
  const sourcePlist = join(sourceContents, 'Info.plist');
  const metadata = JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', sourcePlist], { encoding: 'utf8' })
  ) as Record<string, string>;
  if (metadata.CFBundleExecutable !== 'Electron' || metadata.CFBundleIconFile !== 'electron.icns') {
    throw new Error('Unsupported development Electron bundle. Set ELECTRON_EXEC_PATH to use a custom runtime.');
  }

  const fingerprint = createHash('sha256')
    .update('workbench-dev-display-v3')
    .update(APP_DISPLAY_NAME)
    .update(process.arch)
    .update(realpathSync(sourceBundle))
    .update(readFileSync(sourcePlist))
    .update(readFileSync(sourceExecutable))
    .update(readFileSync(iconPath))
    .digest('hex')
    .slice(0, 20);
  const cachedDirectory = join(cacheDir, fingerprint);
  const bundleName = `${APP_DISPLAY_NAME}.app`;
  const executable = join(cachedDirectory, bundleName, 'Contents', 'MacOS', 'Electron');
  if (existsSync(executable)) return executable;

  mkdirSync(cacheDir, { recursive: true });
  const staging = mkdtempSync(join(cacheDir, '.prepare-'));
  try {
    const targetContents = join(staging, bundleName, 'Contents');
    cpSync(sourceBundle, dirname(targetContents), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    execFileSync('/usr/bin/plutil', [
      '-replace',
      'CFBundleDisplayName',
      '-string',
      APP_DISPLAY_NAME,
      join(targetContents, 'Info.plist'),
    ]);
    copyFileSync(iconPath, join(targetContents, 'Resources', 'electron.icns'));
    // AppKit overrides the first menu title using the localized bundle name.
    // Localize presentation without changing the raw CFBundleName used by Electron.
    const resources = join(targetContents, 'Resources');
    const localizations = new Set([
      'en.lproj',
      'zh_CN.lproj',
      'zh_TW.lproj',
      ...readdirSync(resources).filter((name) => name.endsWith('.lproj')),
    ]);
    for (const locale of localizations) {
      const directory = join(resources, locale);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'InfoPlist.strings'),
        `"CFBundleName" = ${JSON.stringify(APP_DISPLAY_NAME)};\n"CFBundleDisplayName" = ${JSON.stringify(APP_DISPLAY_NAME)};\n`
      );
    }
    try {
      renameSync(staging, cachedDirectory);
    } catch (error) {
      // Two dev instances can prepare the identical immutable cache concurrently.
      if (!existsSync(executable)) throw error;
    }
    return executable;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
