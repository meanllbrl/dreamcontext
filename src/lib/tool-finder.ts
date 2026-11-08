/**
 * Finding a user-installed command-line tool from a process that has no login-shell PATH.
 *
 * A Finder-started app gets `/usr/bin:/bin:/usr/sbin:/sbin`, so the folder nvm, fnm, volta or an
 * npm prefix put a tool in is invisible to it, while every terminal says the tool is right there.
 * This is the one answer to "where is it": a readiness row, a spawn and an account job must ask
 * here, never `process.env.PATH`, or the screen and the spawn disagree.
 *
 * Order: a dreamcontext-managed install (see `findCodexBin`), the process's own PATH, the login shell's PATH
 * (the only source that knows which of several installs the user actually gets), then the known
 * install folders, newest version first. A found path is kept in memory and re-checked on every
 * read; one that vanished starts a new search.
 */
import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path';

const LOGIN_MARK = '__DC_LOGIN_PATH__';
const LOGIN_TIMEOUT_MS = 5_000;
/** A failed login-shell read is retried this much later, never on every poll. */
const LOGIN_RETRY_MS = 5 * 60_000;
const LOGIN_SCRIPT = `printf '\\n${LOGIN_MARK}%s\\n' "$PATH"`;

export interface ToolSearch {
  readonly home?: string;
  /** The process PATH to read first; `''` = none. Default: `env.PATH`. */
  readonly path?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The login shell's PATH. `null` = do not ask (a test, or a hot path that must not spawn). */
  readonly loginPath?: (() => string | null) | null;
  /** Folders of a dreamcontext-managed install, looked at before anything else. */
  readonly first?: readonly string[];
  /** Folders outside the home (Homebrew, the running Node's). Default {@link systemToolDirs}. */
  readonly system?: readonly string[];
}

export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const versionOf = (name: string): number[] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** `<root>/<version>/<tail>` for every version folder under `root`, newest first. */
function versionDirs(root: string, tail: readonly string[]): Array<{ v: number[]; dir: string }> {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  const out: Array<{ v: number[]; dir: string }> = [];
  for (const name of names) {
    const v = versionOf(name);
    if (v) out.push({ v, dir: join(root, name, ...tail) });
  }
  return out;
}

const newestFirst = (a: { v: number[] }, b: { v: number[] }): number =>
  (b.v[0]! - a.v[0]!) || (b.v[1]! - a.v[1]!) || (b.v[2]! - a.v[2]!);

/** `prefix=` in `~/.npmrc`, the folder a plain `npm install -g` writes to. */
function npmrcPrefix(home: string, platform: NodeJS.Platform = process.platform): string | null {
  try {
    const m = /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(readFileSync(join(home, '.npmrc'), 'utf-8'));
    if (!m) return null;
    const raw = m[1]!.replace(/^["']|["']$/g, '').replace(/^~(?=[\\/])/, home).replace(/\$\{?HOME\}?/g, home);
    // `C:\Users\…\npm` is as absolute as `/opt/npm`: the POSIX-only test dropped every Windows prefix.
    return (platform === 'win32' ? win32.isAbsolute(raw) : raw.startsWith('/')) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Where `npm install -g` leaves a launcher under `prefix`: `<prefix>/bin` on macOS and Linux,
 * the prefix itself on Windows (`%APPDATA%\npm\codex.cmd`).
 */
export const npmPrefixBin = (prefix: string, platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? prefix : join(prefix, 'bin');

export const systemToolDirs = (): string[] => [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin'];

/** Every folder a tool's install can land in, most specific first. Reads folders, starts nothing. */
export function knownToolDirs(home: string, env: NodeJS.ProcessEnv = process.env, system: readonly string[] = systemToolDirs(), platform: NodeJS.Platform = process.platform): string[] {
  const managers = [
    ...versionDirs(join(env.NVM_DIR || join(home, '.nvm'), 'versions', 'node'), ['bin']),
    ...versionDirs(join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin']),
    ...versionDirs(join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), ['installation', 'bin']),
    ...versionDirs(join(home, '.fnm', 'node-versions'), ['installation', 'bin']),
    ...versionDirs(join(home, '.asdf', 'installs', 'nodejs'), ['bin']),
    ...versionDirs(join(home, '.local', 'share', 'mise', 'installs', 'node'), ['bin']),
  ].sort(newestFirst).map((e) => e.dir);
  const prefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix || npmrcPrefix(home, platform);
  // Windows' default global prefix, when nothing names another one.
  const winDefault = platform === 'win32' ? [win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'npm')] : [];
  const dirs = [
    ...managers,
    join(env.VOLTA_HOME || join(home, '.volta'), 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
    ...(prefix ? [npmPrefixBin(prefix, platform)] : winDefault),
    join(home, '.dreamcontext', 'npm-global', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.npm-packages', 'bin'),
    ...system,
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
  ];
  return [...new Set(dirs)].filter((d) => d && d !== '/' && d !== '.');
}

// ─── The login shell's PATH ─────────────────────────────────────────────────────

let login: { key: string; value: string | null; at: number } | null = null;
let warming: Promise<void> | null = null;
/** A long-lived server asked in the background: from then on nothing here may block its loop. */
let background = false;

const shellOf = (env: NodeJS.ProcessEnv): string => env.SHELL || '/bin/zsh';
const loginKey = (env: NodeJS.ProcessEnv): string => `${env.HOME ?? ''}\0${shellOf(env)}`;

/** The PATH line out of a login shell's stdout, which an rc file may have written to as well. */
export function parseLoginPath(stdout: string): string | null {
  const hit = stdout.split('\n').reverse().find((l) => l.startsWith(LOGIN_MARK));
  const value = hit?.slice(LOGIN_MARK.length).trim() ?? '';
  return value.includes('/') ? value : null;
}

function remember(env: NodeJS.ProcessEnv, value: string | null): void {
  login = { key: loginKey(env), value, at: Date.now() };
}

/**
 * Ask the login shell once and in the background, so the first lookup a request makes does not
 * have to block on it. A server calls this at start.
 */
export function warmLoginPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  background = true;
  warming ??= new Promise<void>((resolve) => {
    execFile(shellOf(env), ['-ilc', LOGIN_SCRIPT], { env, timeout: LOGIN_TIMEOUT_MS * 2 }, (err, stdout) => {
      remember(env, err ? null : parseLoginPath(String(stdout ?? '')));
      warming = null;
      resolve();
    });
  });
  return warming;
}

/** The login shell's PATH: remembered, else asked once, bounded. Null when it did not answer. */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform === 'win32') return null;
  const key = loginKey(env);
  if (login?.key === key && (login.value !== null || Date.now() - login.at < LOGIN_RETRY_MS)) return login.value;
  if (background) { void warmLoginPath(env); return login?.key === key ? login.value : null; }
  const r = spawnSync(shellOf(env), ['-ilc', LOGIN_SCRIPT], { env, encoding: 'utf-8', timeout: LOGIN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  remember(env, r.status === 0 ? parseLoginPath(r.stdout ?? '') : null);
  return login!.value;
}

export function resetToolFinderForTests(): void {
  login = null;
  warming = null;
  background = false;
  found.clear();
}

// ─── The search ─────────────────────────────────────────────────────────────────

const found = new Map<string, string>();

const pathDirs = (path: string): string[] => path.split(delimiter).filter(Boolean);

function firstIn(dirs: readonly string[], names: readonly string[]): string | null {
  for (const dir of dirs) {
    // A relative entry would resolve against the working folder: a cloned repo could plant a tool.
    if (!isAbsolute(dir)) continue;
    for (const name of names) {
      const p = join(dir, name);
      if (isExecutableFile(p)) return p;
    }
  }
  return null;
}

/**
 * Absolute path of the first `names` entry that can run, or null. See the file header for the
 * order. The memory only spares the search: a managed install still wins over it the moment it
 * lands, and a path that stopped being there is searched for again.
 */
export function findTool(names: readonly string[], o: ToolSearch = {}): string | null {
  const home = o.home ?? homedir();
  const env = o.env ?? process.env;
  const inManaged = firstIn(o.first ?? [], names);
  if (inManaged) return inManaged;
  const key = `${home}\0${names.join(',')}\0${o.path ?? env.PATH ?? ''}`;
  const known = found.get(key);
  if (known && isExecutableFile(known)) return known;
  found.delete(key);

  const hit = firstIn(pathDirs(o.path ?? env.PATH ?? ''), names)
    ?? firstIn(pathDirs(lookLogin(o, env, home)), names)
    ?? firstIn(knownToolDirs(home, env, o.system), names);
  if (hit) found.set(key, hit);
  return hit;
}

function lookLogin(o: ToolSearch, env: NodeJS.ProcessEnv, home: string): string {
  if (o.loginPath === null) return '';
  if (o.loginPath) return o.loginPath() ?? '';
  // A caller that named another home is looking at a scratch folder, not at this user's shell.
  return home === homedir() ? loginShellPath(env) ?? '' : '';
}

/** `base` with `dirs` APPENDED where missing: whatever already resolves keeps winning. */
export function pathWithDirs(base: string, dirs: readonly (string | null | undefined)[]): string {
  const entries = pathDirs(base);
  for (const d of dirs) if (d && !entries.includes(d)) entries.push(d);
  return entries.join(delimiter);
}
