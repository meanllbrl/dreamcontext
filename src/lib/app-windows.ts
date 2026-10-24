import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { win32System32 } from './proc.js';
import { compareVersions } from './version-check.js';

/**
 * The desktop app on Windows: a per-user NSIS installer published on the GitHub release
 * (.github/workflows/desktop-release.yml, job `build-windows`). macOS replaces a .app bundle
 * itself (src/cli/commands/app.ts); Windows hands the verified installer to NSIS, which knows
 * where the app lives, writes its uninstall entry and keeps the Start-menu shortcut.
 *
 * Everything that touches the machine (download, registry, process list, the installer run) is
 * injectable, so the tests drive it on any OS.
 */

/** The release asset `build-windows` publishes, version-less so /releases/latest/download works. */
export const WIN_SETUP_ASSET = 'dreamcontext-beta_x64-setup.exe';
/** Tauri's productName: the NSIS install folder and the uninstall key are named after it. */
export const WIN_PRODUCT_NAME = 'dreamcontext-beta';
/** Where Tauri's per-user NSIS installer records itself (DisplayVersion, DisplayIcon). */
export const WIN_UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${WIN_PRODUCT_NAME}`;
/** NSIS silent mode: no wizard and no prompt. The installer is per-user, so no UAC either. */
export const WIN_SILENT_INSTALL_ARGS: readonly string[] = ['/S'];
/** The installer is given this long before it is reported as hung. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface ReleaseAsset { name: string; browser_download_url: string }
export interface ReleaseLike { tag_name: string; assets: ReleaseAsset[] }

export type RunSync = (file: string, args: readonly string[], opts?: { timeoutMs?: number }) => { status: number | null; stdout: string };

/** spawnSync with no shell: the file is an absolute path (reg.exe, tasklist.exe, the installer). */
export const defaultRunSync: RunSync = (file, args, opts) => {
  const r = spawnSync(file, [...args], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: opts?.timeoutMs ?? 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout ?? '' };
};

/** A release asset URL this CLI will download from: GitHub's own release-download path, https. */
export function isReleaseDownloadUrl(url: string, repo: string): boolean {
  return url.startsWith(`https://github.com/${repo}/releases/download/`);
}

/** The digest in a `.sha256` file (`<hex>  <name>` or a bare hex), or null when it has none. */
export function parseSha256File(text: string): string | null {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[0-9a-f]{64}$/.test(first) ? first : null;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function downloadTo(url: string, dest: string, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'dreamcontext-cli' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * Download the release's installer and its `.sha256` into a fresh temp folder and verify it.
 * Null when the release carries no Windows installer. Throws (and leaves nothing behind) when
 * the checksum asset is missing or does not match: the installer runs silently, often from the
 * background update, so an unverified one is never run. The caller removes `workDir`.
 */
export async function downloadWindowsSetup(
  release: ReleaseLike,
  opts: { repo: string; fetchImpl?: typeof fetch; tmpRoot?: string },
): Promise<{ setupPath: string; version: string; workDir: string } | null> {
  const setup = release.assets.find((a) => a.name === WIN_SETUP_ASSET);
  if (!setup) return null;
  const sum = release.assets.find((a) => a.name === `${WIN_SETUP_ASSET}.sha256`);
  if (!sum) {
    throw new Error(`Release ${release.tag_name} is missing ${WIN_SETUP_ASSET}.sha256 — refusing to install an unverified installer.`);
  }
  for (const asset of [setup, sum]) {
    if (!isReleaseDownloadUrl(asset.browser_download_url, opts.repo)) {
      throw new Error(`Release asset ${asset.name} does not come from github.com/${opts.repo} — refusing to download it.`);
    }
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const workDir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'dc-app-dl-'));
  try {
    const setupPath = join(workDir, WIN_SETUP_ASSET);
    await downloadTo(setup.browser_download_url, setupPath, fetchImpl);
    const sumPath = join(workDir, `${WIN_SETUP_ASSET}.sha256`);
    await downloadTo(sum.browser_download_url, sumPath, fetchImpl);
    const expected = parseSha256File(readFileSync(sumPath, 'utf-8'));
    const actual = sha256File(setupPath);
    if (!expected || expected !== actual) {
      throw new Error(`Checksum mismatch for ${WIN_SETUP_ASSET}: expected ${expected ?? '(none)'}, got ${actual}. Nothing was installed.`);
    }
    return { setupPath, version: release.tag_name.replace(/^v/, ''), workDir };
  } catch (e) {
    rmSync(workDir, { recursive: true, force: true });
    throw e;
  }
}

/** Run a per-user NSIS installer silently and wait for it. Throws on a non-zero exit or a hang. */
export function runWindowsSetup(setupPath: string, run: RunSync = defaultRunSync): void {
  const r = run(setupPath, WIN_SILENT_INSTALL_ARGS, { timeoutMs: INSTALL_TIMEOUT_MS });
  if (r.status !== 0) {
    throw new Error(r.status === null
      ? 'The installer did not finish in time.'
      : `The installer exited with code ${r.status}.`);
  }
}

/** `reg query` output → value name → data (REG_SZ / REG_EXPAND_SZ only). */
export function parseRegQuery(out: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(line);
    if (m) values[m[1]] = m[2].trim();
  }
  return values;
}

/** `"C:\…\app.exe",0` / `C:\…\app.exe` → the exe path. */
export function exeFromDisplayIcon(icon: string | undefined): string | null {
  if (!icon) return null;
  const path = icon.trim().replace(/,\s*-?\d+$/, '').replace(/^"(.*)"$/, '$1').trim();
  return /\.exe$/i.test(path) && win32.isAbsolute(path) ? path : null;
}

export interface WindowsInstall { version: string | null; exePath: string | null }

/**
 * What NSIS installed: the version and exe from the uninstall entry, else the default per-user
 * folder (`%LOCALAPPDATA%\dreamcontext-beta\`). Null when neither says the app is installed.
 */
export function readWindowsInstall(deps: {
  run?: RunSync;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (p: string) => boolean;
} = {}): WindowsInstall | null {
  const run = deps.run ?? defaultRunSync;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  let version: string | null = null;
  let exePath: string | null = null;
  const r = run(win32.join(win32System32(env), 'reg.exe'), ['query', WIN_UNINSTALL_KEY]);
  if (r.status === 0) {
    const values = parseRegQuery(r.stdout);
    version = values.DisplayVersion || null;
    const exe = exeFromDisplayIcon(values.DisplayIcon);
    if (exe && exists(exe)) exePath = exe;
  }
  if (!exePath) {
    const local = env.LOCALAPPDATA || win32.join(deps.home ?? env.USERPROFILE ?? homedir(), 'AppData', 'Local');
    for (const name of ['dreamcontext-desktop.exe', `${WIN_PRODUCT_NAME}.exe`]) {
      const candidate = win32.join(local, WIN_PRODUCT_NAME, name);
      if (exists(candidate)) { exePath = candidate; break; }
    }
  }
  return version || exePath ? { version, exePath } : null;
}

/** Is a process with this exe's image name running? (`tasklist`, CSV, no header.) */
export function isWindowsAppRunning(exePath: string, run: RunSync = defaultRunSync, env: NodeJS.ProcessEnv = process.env): boolean {
  const image = win32.basename(exePath);
  const r = run(win32.join(win32System32(env), 'tasklist.exe'), ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
  return r.status === 0 && r.stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
}

// ─── The update offer ────────────────────────────────────────────────────────────
//
// Windows has no in-app updater yet (that needs a signed Windows feed in latest.json). The
// background `app update` the SessionStart hook fires installs a newer release when the app is
// closed; when it is open, running the installer could end it mid-chat, so the newer version is
// recorded instead and offered on the next session and in `app status`.

export function appUpdateAvailablePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'app-update-available.json');
}

export function recordAppUpdateAvailable(version: string, home: string = homedir()): void {
  const p = appUpdateAvailablePath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ version, at: Date.now() }) + '\n', 'utf-8');
}

export function clearAppUpdateAvailable(home: string = homedir()): void {
  rmSync(appUpdateAvailablePath(home), { force: true });
}

/** The recorded newer version, when it is newer than `installed`; else null. Never throws. */
export function pendingAppUpdate(installed: string | null, home: string = homedir()): string | null {
  try {
    const raw = JSON.parse(readFileSync(appUpdateAvailablePath(home), 'utf-8')) as { version?: unknown };
    const v = typeof raw.version === 'string' && /^\d+\.\d+\.\d+$/.test(raw.version) ? raw.version : null;
    if (!v) return null;
    return !installed || compareVersions(installed, v) < 0 ? v : null;
  } catch {
    return null;
  }
}

/** The one line SessionStart prints while a recorded update waits, or null. */
export function appUpdateNotice(installed: string | null, home: string = homedir()): string | null {
  const v = pendingAppUpdate(installed, home);
  return v
    ? `dreamcontext desktop app ${v} is available${installed ? ` (installed: ${installed})` : ''}. Close the app, then run \`dreamcontext app update\`.`
    : null;
}
