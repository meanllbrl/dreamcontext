import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The app's update channel (plan npmsiz-beta C10): Settings → "Beta programı" and
 * `dreamcontext app channel <stable|beta>` both write `~/.dreamcontext/update-channel.json`
 * `{"channel":"stable"|"beta"}` through {@link setUpdateChannel}, the one writer. The desktop
 * app's updater (desktop/src-tauri/src/updater.rs) reads it every round: `beta` → the beta feed
 * compiled into the app; anything else (stable, missing, malformed, extra keys, a symlink) →
 * today's stable feed, unchanged. No URL is ever read from this file: the two feed URLs are
 * compile-time constants, so the record can only pick between them.
 *
 * Leaving Beta never downgrades: the updater installs only a strictly higher version, so the
 * build in place stays until stable passes it.
 */

export type UpdateChannel = 'stable' | 'beta';
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['stable', 'beta'];

export function isUpdateChannel(v: unknown): v is UpdateChannel {
  return v === 'stable' || v === 'beta';
}

export function updateChannelPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'update-channel.json');
}

/** lstat that never throws: null when the path does not exist or cannot be read. */
function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(p); } catch { return null; }
}

/**
 * The channel the record names, read the way the Rust updater reads it: exactly
 * `{"channel":"beta"}` is beta; `{"channel":"stable"}`, no file, an unreadable or malformed one,
 * any other key, a symlinked file or a symlinked `~/.dreamcontext` are stable.
 */
export function readUpdateChannel(home: string = homedir()): UpdateChannel {
  const dir = lstatOrNull(join(home, '.dreamcontext'));
  if (!dir || dir.isSymbolicLink() || !dir.isDirectory()) return 'stable';
  const file = updateChannelPath(home);
  const st = lstatOrNull(file);
  if (!st || !st.isFile()) return 'stable';
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'stable';
    const keys = Object.keys(raw);
    if (keys.length !== 1 || keys[0] !== 'channel') return 'stable';
    return (raw as { channel: unknown }).channel === 'beta' ? 'beta' : 'stable';
  } catch {
    return 'stable';
  }
}

/**
 * Write the channel: temp file + rename in `~/.dreamcontext`, refusing a symlinked folder or a
 * non-file at the record's path. Any value but `stable` / `beta` is refused. Returns the
 * channel now in effect.
 */
export function setUpdateChannel(channel: UpdateChannel, home: string = homedir()): UpdateChannel {
  if (!isUpdateChannel(channel)) throw new Error('The update channel must be "stable" or "beta".');
  const dirPath = join(home, '.dreamcontext');
  const dir = lstatOrNull(dirPath);
  if (dir && (dir.isSymbolicLink() || !dir.isDirectory())) {
    throw new Error(`${dirPath} is not a plain folder; the update channel was not changed.`);
  }
  if (!dir) mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const file = updateChannelPath(home);
  const existing = lstatOrNull(file);
  if (existing && !existing.isFile()) {
    throw new Error(`${file} is not a plain file; the update channel was not changed.`);
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify({ channel }) + '\n', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return readUpdateChannel(home);
}
