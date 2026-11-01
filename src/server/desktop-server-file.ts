/**
 * `~/.dreamcontext/desktop-server.json`: how a dreamcontext App window (desktop/app-runner)
 * finds the running desktop server when it was opened from the Dock, with no dashboard
 * window and nothing else to ask.
 *
 * Contract (dreamcontext-apps plan r19, "Kontrat"):
 *   { schema: 1, pid, port, launchToken, appBundleId }, mode 0600, written temp+rename.
 * Only the REAL desktop shell's child writes it: DREAMCONTEXT_DESKTOP=1 AND
 * process.ppid === DREAMCONTEXT_PARENT_PID (the same gate as claude-update-job.ts). A
 * builder- or verify-launched `dashboard` inherits DREAMCONTEXT_DESKTOP=1 but not that
 * parent, and must never point the owner's app windows at a scratch server.
 * Removal only when the file's pid is this process: a second server must not delete the
 * live one's record.
 *
 * The launchToken is minted per boot and kept in memory; `POST /api/apps/launch-window`
 * accepts it as a Bearer (timing-safe). The runner reads `appBundleId` from its own
 * bundle, never from this file.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The desktop shell's bundle id (desktop/src-tauri/tauri.conf.json `identifier`; drift-tested). */
export const DESKTOP_BUNDLE_ID = 'com.dreamcontext.beta';

const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

export interface DesktopServerFile {
  schema: 1;
  pid: number;
  port: number;
  launchToken: string;
  appBundleId: string;
}

export function desktopServerFilePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'desktop-server.json');
}

/** The shell's bundle id: the env the shell sets at spawn, else the shipped constant. */
export function shellBundleId(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DREAMCONTEXT_APP_BUNDLE_ID;
  return fromEnv && BUNDLE_ID_RE.test(fromEnv) && fromEnv.includes('.') ? fromEnv : DESKTOP_BUNDLE_ID;
}

/** Why this process must not write the file, or null when it is the app-owned server. */
export function desktopServerFileGate(
  env: NodeJS.ProcessEnv = process.env,
  ppid: number = process.ppid,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (env.DREAMCONTEXT_DESKTOP !== '1') return 'not the desktop app';
  // App windows are a macOS runner; elsewhere nothing reads the file.
  if (platform !== 'darwin') return 'macOS only';
  const parent = Number(env.DREAMCONTEXT_PARENT_PID);
  if (!Number.isInteger(parent) || parent <= 1 || ppid !== parent) {
    return 'ppid is not DREAMCONTEXT_PARENT_PID (not the app-owned server)';
  }
  return null;
}

let currentToken: string | null = null;

/** The launch token of THIS server's file, or null when it wrote none. */
export function currentLaunchToken(): string | null {
  return currentToken;
}

/** Test seam: set or clear the in-memory token. */
export function __setLaunchTokenForTest(token: string | null): void {
  currentToken = token;
}

/** Timing-safe check of an `Authorization: Bearer <launchToken>` header. */
export function launchTokenMatches(authorization: string | undefined | null): boolean {
  if (!currentToken || typeof authorization !== 'string') return false;
  const m = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(currentToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface WriteOptions {
  port: number;
  home?: string;
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  pid?: number;
  platform?: NodeJS.Platform;
}

export type WriteResult = { written: true; path: string; token: string } | { written: false; reason: string };

/**
 * Write the file for this server (temp + rename, 0600). Mints a fresh launch token every
 * time: a token from an earlier boot is worthless the moment this one listens.
 */
export function writeDesktopServerFile(opts: WriteOptions): WriteResult {
  const env = opts.env ?? process.env;
  const reason = desktopServerFileGate(env, opts.ppid ?? process.ppid, opts.platform ?? process.platform);
  if (reason) return { written: false, reason };
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) return { written: false, reason: 'bad port' };
  const home = opts.home ?? homedir();
  const pid = opts.pid ?? process.pid;
  const dir = join(home, '.dreamcontext');
  const path = desktopServerFilePath(home);
  const token = randomBytes(32).toString('base64url');
  const record: DesktopServerFile = { schema: 1, pid, port: opts.port, launchToken: token, appBundleId: shellBundleId(env) };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      if (lstatSync(dir).isSymbolicLink()) return { written: false, reason: '~/.dreamcontext is a symlink' };
    } catch { /* created above */ }
    const tmp = join(dir, `.desktop-server.json.${pid}.${randomBytes(4).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(record) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    return { written: false, reason: (err as Error).message };
  }
  currentToken = token;
  return { written: true, path, token };
}

/** Read the file without trusting it (tests and the CLI client use this). */
export function readDesktopServerFile(home: string = homedir()): DesktopServerFile | null {
  const path = desktopServerFilePath(home);
  try {
    if (!lstatSync(path).isFile()) return null;
    const v = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DesktopServerFile>;
    if (v.schema !== 1 || typeof v.port !== 'number' || typeof v.pid !== 'number' || typeof v.launchToken !== 'string') return null;
    if (typeof v.appBundleId !== 'string') return null;
    return v as DesktopServerFile;
  } catch {
    return null;
  }
}

/** Remove the file, but ONLY when it names this process. Never another server's record. */
export function removeDesktopServerFile(opts: { home?: string; pid?: number } = {}): boolean {
  const home = opts.home ?? homedir();
  const pid = opts.pid ?? process.pid;
  const current = readDesktopServerFile(home);
  if (!current || current.pid !== pid) return false;
  try {
    rmSync(desktopServerFilePath(home), { force: true });
  } catch {
    return false;
  }
  if (pid === process.pid) currentToken = null;
  return true;
}
