# Product data isolation

The desktop uses `PMWorkbench` (release), `PMWorkbench-Dev` (development), and
`PMWorkbench-Dev-2` (second development instance) under Electron's appData directory.
On macOS this is `~/Library/Application Support/`.

Managed data/config links use `~/.pm-workbench` and `~/.pm-workbench-config`, with `-dev`
and `-dev-2` suffixes in development. Browser partitions remain inside the product
profile, so matching partition names no longer share cookies or local storage.
The backend passes `<dataDir>/codex-home` as CODEX_HOME to child processes, keeping
CLI thread history separate as well. The global Codex home is not modified.

Standalone WebUI uses `~/.pm-workbench-web` (development: `-dev`); default ports are
26808 (release), 26809 (development), 26810 (second development instance).
Node services default to `~/.pm-workbench-server`. Explicit DATA_DIR and E2E sandbox paths
remain caller-controlled and must not point both apps to the same location.

The legacy Electron development app name is intentionally retained for macOS
Keychain compatibility. The storage directory and packaged app ID are separate.
On macOS, the development config copies Electron into the repo-local ignored
`node_modules/.cache/workbench-electron` directory and launches it using
`ELECTRON_EXEC_PATH`. Only its display name and icon are branded as 工作台; the
original executable, bundle identity, raw `CFBundleName`, and legacy `app.setName`
remain unchanged. `InfoPlist.strings` provides the localized name for macOS's
application menu. Shared Electron installations are never patched or re-signed.
The cache is refreshed when Electron or the icon changes. An explicit
`ELECTRON_EXEC_PATH` takes precedence. This affects development only, not packaged
builds or profile paths.
This isolates application-managed local state; it is not an OS sandbox. Explicitly
selected external folders and remote accounts can still be shared.

## Migrating existing data

Stop both apps before copying data. Back up the complete old profile, including
SQLite sidecars, Chromium partitions, config, and managed work files. Copy it into
each product profile independently (never hard-link mutable databases). Keep the
old profile and verify file hashes before changing paths in the copies.

Remap managed paths in configuration, conversation metadata, folders, skills, and
structured task files. Preserve original message text. Copy relevant Codex rollout
files, authentication/configuration and thread state to each local CLI home; remap
rollout paths and managed working directories. Do not move or delete global history.

The local migration on 2026-11-12 preserved all 12 conversations and 974 messages
in both profiles; initial copies each contained all 103 cookie records. Existing
history is intentionally duplicated because the old database mixed both projects.
New writes now diverge. Eleven existing CLI rollouts were copied; one stored session
ID already lacked a corresponding source rollout, while its app messages survived.

Rollback: stop both apps and preserve any new profile changes first. Restore the
pre-isolation source/configuration and use the untouched original profile. Do not
replace a new profile with an old backup without reconciling post-migration changes.
The machine-local backup contains manifests and migration reports. Never commit it:
it includes private chats and authentication data.
