/**
 * `dreamcontext` on PATH with no click, when the desktop app runs on its own Node (plan
 * npmsiz-beta C1; fresh-Mac gaps a and b, 2026-11-15).
 *
 * A Mac with no npm has no `dreamcontext` anywhere until the app writes its launcher
 * (`~/.dreamcontext/bin/cli/dreamcontext`, naming the bundle's node and entry). The setup's
 * "Make it available in Terminal" row did that only when clicked, so a new Terminal, the Claude
 * Code hooks (`command -v dreamcontext … || npx`, and a fresh Mac has no npx) and the Claude the
 * app's own terminal opens all missed it. Now:
 *  - at server start on the app runtime, when the machine has NO global CLI (the shell passes
 *    the one it found as DREAMCONTEXT_GLOBAL_CLI): the launcher is written and its folder put on
 *    the shell's rc PATH (the same writer and marker as that setup row). With a global npm CLI
 *    present (the bundle merely newer) the rc is left alone: a permanent line there would shadow
 *    that CLI in every Terminal and outlive an npm update or the app's removal (review r1);
 *  - every Claude the app spawns on the app runtime gets the launcher folder on its PATH, so
 *    its hooks find the CLI even before the rc is read (or when the rc could not be written).
 * Anywhere else (a global npm CLI, a dev checkout) nothing changes. Never throws.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appCliRecordPath, recordValid, type AppCliRecord } from './cli-precedence.js';
import { dreamcontextVersion } from './manifest.js';
import { isAppRuntimeNode } from './onboarding/platform.js';
import { cliAwarePath, cliShimDir } from './automations/cli-path.js';
import { CLI_RC_MARKER, ensureDirOnShellPath, type ShellPathFix } from './claude-path.js';

export interface AppCliEnv {
  execPath?: string;
  entry?: string | undefined;
  home?: string;
  platform?: NodeJS.Platform;
  /** The global CLI the shell found (DREAMCONTEXT_GLOBAL_CLI); set = not a fresh machine. */
  globalCli?: string;
}

function onAppRuntime(o: AppCliEnv): boolean {
  if ((o.platform ?? process.platform) === 'win32') return false;
  return isAppRuntimeNode(o.execPath ?? process.execPath, o.home ?? homedir());
}

/** `base` with the app's launcher folder on it when this process is the app runtime; else `base`. */
export function appRuntimePath(base: string, o: AppCliEnv = {}): string {
  if (!onAppRuntime(o)) return base;
  return cliAwarePath(base, {
    execPath: o.execPath ?? process.execPath,
    entry: 'entry' in o ? o.entry : process.argv[1],
    ...(o.home ? { home: o.home } : {}),
  });
}

/**
 * At server start: write the launcher and put its folder on the rc PATH. `null` when this is
 * not the app runtime or the launcher could not be written (nothing is added to the rc then).
 */
export function ensureAppCliOnShellPath(
  o: AppCliEnv & { addToShellPath?: (dir: string, marker: string) => ShellPathFix } = {},
): ShellPathFix | null {
  if (!onAppRuntime(o)) return null;
  const globalCli = 'globalCli' in o ? o.globalCli : process.env.DREAMCONTEXT_GLOBAL_CLI;
  if (globalCli && globalCli.trim()) return null;
  try {
    const home = o.home ?? homedir();
    const dir = cliShimDir(home);
    // Base '' so the launcher is always (re)written for THIS node and entry.
    const path = appRuntimePath('', { ...o, home });
    if (!path.split(':').includes(dir)) return null;
    return (o.addToShellPath ?? ensureDirOnShellPath)(dir, CLI_RC_MARKER);
  } catch {
    return null;
  }
}

/**
 * At server start on the Mac app's own runtime: write `~/.dreamcontext/app-cli.json` naming this
 * bundle's node and entry (plan npmsiz-beta C2′, Mac bundle form), so the last npm release (the
 * bridge, src/cli/bridge.ts) hands every `dreamcontext` call over to the app's CLI. Written for
 * a lasting bundle only (recordValid refuses a DMG or translocated copy), as one temp file
 * renamed into place, never through a symlinked `~/.dreamcontext`, and only when it changed.
 * Returns whether the record now names this bundle. Never throws.
 */
export function writeAppCliRecord(o: AppCliEnv & { version?: string | null } = {}): boolean {
  if ((o.platform ?? process.platform) !== 'darwin' || !onAppRuntime(o)) return false;
  try {
    const home = o.home ?? homedir();
    const node = realpathSync(o.execPath ?? process.execPath);
    const entryRaw = 'entry' in o ? o.entry : process.argv[1];
    if (!entryRaw) return false;
    const entry = realpathSync(entryRaw);
    const version = 'version' in o ? o.version : dreamcontextVersion();
    if (!version || version === '0.0.0') return false;
    const app = node.slice(0, -'/Contents/Resources/runtime/bin/node'.length);
    const rec: AppCliRecord = { version, node, entry, appPath: app };
    if (!recordValid(rec, home, false)) return false;
    const dir = join(home, '.dreamcontext');
    mkdirSync(dir, { recursive: true });
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    const file = appCliRecordPath(home);
    const body = `${JSON.stringify(rec, null, 2)}\n`;
    try {
      const f = lstatSync(file);
      if (f.isFile() && readFileSync(file, 'utf-8') === body) return true;
    } catch { /* no record yet */ }
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, body, { mode: 0o644 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
