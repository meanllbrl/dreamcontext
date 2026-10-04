import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Cloud server mode: the hands-free trip's server inside a GitHub codespace.
 *
 * Its own flag (`DREAMCONTEXT_CLOUD=1`), never `DREAMCONTEXT_DESKTOP`: the desktop flag arms
 * the Tauri parent-death watch (`lifecycle.ts`), which on a VM would kill the server.
 *
 * The cloud runs two uids. The server is `dcserver` with only CAP_SETUID/SETGID/KILL;
 * everything it starts (agents, installs, shells, every git and pack operation, every read
 * of a dcuser-written 0600 transcript) runs as `dcuser:dcwork` through {@link spawnAsWorker},
 * the ONLY way the cloud spawns anything. W0 proved a plain uid switch is not enough: a
 * cap-holding parent leaks its AMBIENT caps to children, so the worker is exec'd through
 * `setpriv` with every capability set cleared and no_new_privs on.
 */
export function isCloud(): boolean {
  return process.env.DREAMCONTEXT_CLOUD === '1';
}

/** The phase the cloud persists in its dcserver dir. Only `active` serves the phone. */
export type CloudPhase = 'sealed' | 'active' | 'quiescing';

let phaseSource: () => CloudPhase = () => 'sealed';

/**
 * Wave 2 (the cloud routes) owns the phase state; it registers its reader here. Until it
 * does, the gate reads `sealed`, so an unwired cloud serves nothing to the phone (fail closed).
 */
export function setCloudPhaseSource(source: () => CloudPhase): void {
  phaseSource = source;
}

export function cloudPhase(): CloudPhase {
  try {
    return phaseSource();
  } catch {
    return 'sealed';
  }
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/** The 0700 dcserver dir on the persistent disk: verifiers, device sessions, limiter, phase. */
export function cloudServerDir(): string {
  return process.env.DC_HF_SERVER_DIR || '/workspaces/dc-server';
}

/**
 * The 0755 dcserver-owned sibling dir. The orchestration git config lives here, not in the
 * 0700 dir, because dcuser runs that git and must read it (W0 item 4 finding d).
 */
export function cloudPublicDir(): string {
  return process.env.DC_HF_PUBLIC_DIR || '/workspaces/dc-server-pub';
}

/** `GIT_CONFIG_GLOBAL` for every cloud git: read-only, safe.directory for the in-scope roots. */
export function cloudGitConfigPath(): string {
  return join(cloudPublicDir(), 'gitconfig');
}

/**
 * The dcuser-owned scratch dir beside the dcserver dir (`/workspaces/dc-work`, 2770
 * dcuser:dcwork): the worker's backups and incoming files live here, never in the 0700 dir.
 */
export function cloudWorkDir(): string {
  return join(dirname(cloudServerDir()), 'dc-work');
}

/** Where the root supervisor writes the fingerprint of the build it installed (root-owned). */
export const CLOUD_FINGERPRINT_FILE = '/opt/dc-hf/fingerprint';

// ─── Test seams (wave 3's round trip runs a cloud server on a Mac) ─────────────
//
// Both are set ONLY by `cloud serve --same-uid-worker` / `--mirror-prefix`, which refuse to
// run inside a codespace or as root. There is no env flag for either.

let sameUidWorker = false;
let mirrorPrefix: string | null = null;

export function setSameUidWorkerForTests(on: boolean): void {
  sameUidWorker = on;
}

export function isSameUidWorker(): boolean {
  return sameUidWorker;
}

export function setCloudMirrorPrefix(prefix: string | null): void {
  mirrorPrefix = prefix ? resolve(prefix) : null;
}

export function cloudMirrorPrefix(): string | null {
  return mirrorPrefix;
}

/** A laptop absolute path → where the cloud keeps it (identical in production). */
export function cloudLocalPath(laptopAbs: string): string {
  const p = resolve(laptopAbs);
  return mirrorPrefix ? join(mirrorPrefix, p) : p;
}

/** The inverse of {@link cloudLocalPath}: null for a path outside the mirror. */
export function cloudLaptopPath(localAbs: string): string | null {
  const p = resolve(localAbs);
  if (!mirrorPrefix) return p;
  if (p === mirrorPrefix) return sep;
  return p.startsWith(mirrorPrefix + sep) ? p.slice(mirrorPrefix.length) : null;
}

// ─── The worker spawn ───────────────────────────────────────────────────────

export const WORKER_USER = 'dcuser';
export const WORKER_GROUP = 'dcwork';
const SETPRIV = '/usr/bin/setpriv';
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Settings git must never take from the caller: they would re-enable hooks, fsmonitor or a
 *  planted config (GIT_CONFIG_COUNT/KEY_n/VALUE_n inject arbitrary config). */
const GIT_CONFIG_ENV_RE = /^GIT_CONFIG/;

/** Keys a caller may never hand a worker. DC_HF_* carry the server's own secrets and paths;
 *  the GitHub tokens are the codespace's; CLAUDE_CONFIG_DIR comes only from `account`, so
 *  one account's child can never be pointed at another's login. */
const FORBIDDEN_ENV_RE = /^(DC_HF_|GITHUB_TOKEN$|GH_TOKEN$|GH_ENTERPRISE_TOKEN$|GITHUB_ENTERPRISE_TOKEN$|CODESPACE|GITHUB_CODESPACE|CLAUDE_CONFIG_DIR$|LD_PRELOAD$|LD_LIBRARY_PATH$|NODE_OPTIONS$)/;

export interface WorkerAccount {
  /** The account's sandbox config dir (D13: its own `claude auth login` lives there). */
  configDir: string;
}

export interface WorkerSpawnOptions {
  cwd: string;
  account?: WorkerAccount;
  /** Extra variables merged onto the allow-listed base env (checked against the deny list). */
  env?: Record<string, string>;
  stdio?: StdioOptions;
  /** Own process group, so a Cut can kill the whole tree with `kill(-pid)`. Default true. */
  detached?: boolean;
}

export interface WorkerSpawnPlan {
  file: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

/** The worker's base env: nothing of the server's own env passes except these, re-derived. */
function baseWorkerEnv(): Record<string, string> {
  const src = process.env;
  return {
    HOME: src.HOME || '/home/' + WORKER_USER,
    USER: WORKER_USER,
    LOGNAME: WORKER_USER,
    SHELL: '/bin/bash',
    LANG: src.LANG || 'C.UTF-8',
    PATH: src.PATH || DEFAULT_PATH,
    TERM: src.TERM || 'xterm-256color',
  };
}

/**
 * Pure: the exact `setpriv` argv and env {@link spawnAsWorker} would run. Throws on a
 * forbidden env key or a relative cwd/config dir, so a wiring mistake fails loudly instead
 * of handing a secret to an agent.
 */
export function workerSpawnPlan(cmd: string, args: string[], opts: WorkerSpawnOptions): WorkerSpawnPlan {
  if (!isAbsolute(opts.cwd)) throw new Error('spawnAsWorker: cwd must be absolute');
  const env = baseWorkerEnv();
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (FORBIDDEN_ENV_RE.test(key) || GIT_CONFIG_ENV_RE.test(key)) {
      throw new Error(`spawnAsWorker: env key ${key} may not be passed to a worker`);
    }
    env[key] = value;
  }
  if (opts.account) {
    if (!isAbsolute(opts.account.configDir)) throw new Error('spawnAsWorker: account configDir must be absolute');
    env.CLAUDE_CONFIG_DIR = opts.account.configDir;
  }

  let argv = args;
  if (basename(cmd) === 'git') {
    // A dcuser-planted hook, fsmonitor or system config never runs, even for the
    // orchestration's own git; the global config is the read-only one dcserver wrote.
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = cloudGitConfigPath();
    env.GIT_TERMINAL_PROMPT = '0';
    argv = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args];
  }

  return {
    file: SETPRIV,
    argv: [
      `--reuid=${WORKER_USER}`,
      `--regid=${WORKER_GROUP}`,
      '--clear-groups',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--no-new-privs',
      '--',
      cmd,
      ...argv,
    ],
    cwd: opts.cwd,
    env,
  };
}

/** The ONLY way the cloud spawns a process: as dcuser:dcwork, no caps, allow-listed env. */
export function spawnAsWorker(cmd: string, args: string[], opts: WorkerSpawnOptions): ChildProcess {
  if (!isCloud()) throw new Error('spawnAsWorker is cloud-only');
  const plan = workerSpawnPlan(cmd, args, opts);
  if (sameUidWorker) {
    // Test seam: the same env allow-list and git hardening, without the uid switch.
    const at = plan.argv.indexOf('--');
    return spawn(plan.argv[at + 1], plan.argv.slice(at + 2), {
      cwd: plan.cwd,
      env: plan.env,
      stdio: opts.stdio ?? ['pipe', 'pipe', 'pipe'],
      detached: opts.detached ?? true,
    });
  }
  return spawn(plan.file, plan.argv, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: opts.stdio ?? ['pipe', 'pipe', 'pipe'],
    detached: opts.detached ?? true,
  });
}

// ─── The pinned runner contract (shared structurally with src/lib/handsfree/) ─

export interface RunResult { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }
export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;          // merged onto the runner's own allow-listed base env
  input?: Buffer | NodeJS.ReadableStream; // piped to stdin
  stdoutTo?: NodeJS.WritableStream;       // stream stdout here instead of buffering (bundles, packs)
  timeoutMs?: number;
}
export type ProcessRunner = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;

/**
 * Run one process to completion through a spawner. `stdoutTo` is not ended by the runner:
 * the caller owns that stream. A timeout kills the whole process group.
 */
export function runWith(
  spawner: (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => ChildProcess,
): ProcessRunner {
  return (cmd, args, opts) => new Promise<RunResult>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawner(cmd, args, opts.cwd, opts.env);
    } catch (err) {
      reject(err);
      return;
    }
    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timer: NodeJS.Timeout | null = null;

    if (opts.stdoutTo) child.stdout?.pipe(opts.stdoutTo, { end: false });
    else child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c));

    if (child.stdin) {
      child.stdin.on('error', () => { /* the child closed stdin early; its exit code says why */ });
      if (opts.input === undefined) child.stdin.end();
      else if (Buffer.isBuffer(opts.input)) child.stdin.end(opts.input);
      else opts.input.pipe(child.stdin);
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, opts.timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(errChunks) });
    });
  });
}

/** The cloud's runner for git and pack work (lane B's functions take it injected). */
export const workerRunner: ProcessRunner = runWith((cmd, args, cwd, env) =>
  spawnAsWorker(cmd, args, { cwd, env }));

/**
 * Read a file dcuser wrote (the CLI writes transcripts 0600, so dcserver cannot open them
 * through group dcwork). Refuses anything over `maxBytes` rather than truncating silently.
 */
export async function readFileAsWorker(path: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error('readFileAsWorker: path must be absolute');
  const res = await workerRunner('/usr/bin/head', ['-c', String(maxBytes + 1), '--', path], { cwd: '/', timeoutMs: 60_000 });
  if (res.code !== 0) throw new Error(`readFileAsWorker: read failed (exit ${res.code ?? res.signal})`);
  if (res.stdout.length > maxBytes) throw new Error('readFileAsWorker: file exceeds the size cap');
  return res.stdout;
}

// ─── The public listener's route classes ────────────────────────────────────

/** Every request reaches the cloud through GitHub's forwarder, which rewrites a browser
 *  Origin equal to its own public origin to this (W0, 2026-10-03). */
export const CLOUD_FORWARDED_ORIGIN = 'http://localhost:8080';

/** The only WebSocket the phone opens. */
export const CLOUD_WS_PATHS: readonly string[] = ['/api/agent/chat'];

/** Reachable with no credential at all. The service worker and its offline page must load
 *  while signed out (W0 item 10); the manifest is fetched without cookies by browsers. */
export const CLOUD_PUBLIC_ROUTES: readonly string[] = [
  'GET /login',
  'POST /api/handsfree/login',
  'GET /api/health',
  'GET /handsfree-sw.js',
  'GET /handsfree-offline.html',
  'GET /manifest.webmanifest',
];

/**
 * The cloud API allow-list: the agent routes opened to the phone plus the read-only GETs the
 * mobile chat surface calls. STATIC on purpose (a unit test pins it): every other `/api/*`
 * request, lab sync and whiteboard writes included, is 403 `cloud_unavailable`.
 */
export const CLOUD_DEVICE_API_ROUTES: readonly string[] = [
  // Chat, history and the session roster
  'GET /api/agent/chat-history',
  'GET /api/agent/chat-sessions',
  'GET /api/agent/sessions',
  'PUT /api/agent/sessions',
  'GET /api/agent/slash-commands',
  'GET /api/agent/bg-output',
  'POST /api/agent/prompt',
  // Shelf
  'GET /api/agent/task-progress',
  'GET /api/agent/session-facts',
  // Usage and accounts (list, switch, preferred)
  'GET /api/agent/usage-limits',
  'GET /api/agent/accounts',
  'POST /api/agent/accounts/preferred',
  'POST /api/agent/accounts/auto-switch',
  // Files the chat renders (project root only; grants stay refused)
  'GET /api/agent/file',
  'GET /api/agent/board-assets',
  // Teammates
  'GET /api/agent/teammates',
  'GET /api/agent/teammate-history',
  // Read-only GETs of the mobile chat surface
  'GET /api/agent/capabilities',
  'GET /api/agent/model-config',
  'GET /api/agent/session-model',
  'GET /api/agent/session-stats',
  'GET /api/vaults',
  'GET /api/config',
  'GET /api/chat/html-kit',
  // The phone signs itself out
  'POST /api/handsfree/logout',
];

/** Transfer routes: the laptop's bearer channel, proven by HMAC, never a device cookie. */
export const CLOUD_TRANSFER_PREFIX = '/api/handsfree/';

export type CloudRouteClass = 'public' | 'device' | 'transfer' | 'unavailable';

const PUBLIC_SET = new Set(CLOUD_PUBLIC_ROUTES);
const DEVICE_SET = new Set(CLOUD_DEVICE_API_ROUTES);

/** Classify one request. HEAD rides on its GET entry; any non-API path is the SPA (device). */
export function classifyCloudRoute(method: string, pathname: string): CloudRouteClass {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const key = `${m} ${pathname}`;
  if (PUBLIC_SET.has(key)) return 'public';
  if (DEVICE_SET.has(key)) return 'device';
  if (pathname.startsWith(CLOUD_TRANSFER_PREFIX)) return 'transfer';
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'unavailable';
  return 'device';
}
