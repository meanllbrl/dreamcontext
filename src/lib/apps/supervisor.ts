/**
 * The app supervisor (dreamcontext-apps plan r19, W2): one runtime per app, living in the
 * dreamcontext server process.
 *
 * State: stopped → starting → running ⇄ updating, or error.
 *
 * Backend spawn: its own process group, the owner's LOGIN-shell PATH (a Dock-launched process
 * has none), and an env allow-list (PATH, HOME, USER, LANG, LC_*, TMPDIR, SHELL, TERM: a
 * GH_TOKEN in the login shell never reaches the app), then the app's `.env`, then PORT,
 * HOST=127.0.0.1, DC_URL, DC_TOKEN, DC_GATEWAY_SECRET, DC_DATA_DIR, which the app cannot
 * override. `build` gets neither DC_TOKEN nor DC_GATEWAY_SECRET (a bundler could inline them).
 *
 * After health (and on every rolling restart, and every 60 s):
 *   - binding: `lsof` over the group's pids; a listener on anything but 127.0.0.1/[::1] is an
 *     error ("bind to 127.0.0.1"). lsof failing is a warning, not an error.
 *   - guard: the health path WITHOUT the gateway secret must answer 401/403, else error
 *     "dcGuard missing". `backend.unguarded: true` turns both into warnings, shown on the card.
 *
 * Hot update: a recursive watch (ignoring node_modules, .git, dist, build, .next, .env*, *.log,
 * *.sqlite*, data, tmp and the manifest's own list), 400 ms debounce, events during an update
 * fold into one rerun. The new backend starts on a NEW port; only when its health passes (15 s)
 * does traffic move to it (rev++). A broken version never takes the running one down
 * (lastError). More than 5 updates in 30 s stops the watch ("the app may be writing its own
 * folder").
 *
 * Leases: a `window` lease per runner token (heartbeat, TTL 30 s) and `call` leases
 * (`apps call` / `apps do`, TTL 5 min, held while the request runs). No lease → backend stops.
 * A wall-clock jump (the Mac slept) grants one more TTL before anything is swept.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep, win32 } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { readManifest, type AppManifest, type ManifestProblem } from './manifest.js';
import { missingRequired, publicConfig, readAppConfig } from './app-config.js';
import { type AppRecord } from './registry.js';
import { AppDataError, appDataDir, ensureAppDataDir, migrateAppData, scanAppData } from './data-dir.js';
import { backupAppData } from './data-backup.js';
import { appPullHeld } from './data-conflicts.js';
import { LineLog, makeRedactor, parseDotenv, type Redactor, type SecretValue } from './redact.js';
import { killPortable, win32PowerShell, win32System32 } from '../proc.js';

export type AppState = 'stopped' | 'starting' | 'running' | 'updating' | 'error';

export const WINDOW_LEASE_TTL_MS = 30_000;
export const CALL_LEASE_TTL_MS = 5 * 60_000;
const HEALTH_TIMEOUT_MS = 15_000;
const DEBOUNCE_MS = 400;
const BUILD_QUIET_MS = 1000;
const STORM_WINDOW_MS = 30_000;
const STORM_MAX = 5;
const BIND_RECHECK_MS = 60_000;
export const GATEWAY_SECRET_HEADER = 'x-dc-gateway-secret';

const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'TERM'];
/** win32 only: what cmd.exe and a Node backend need to run at all (no secret among them). */
const ENV_ALLOW_WIN32 = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'ProgramFiles', 'ProgramData'];
const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', 'data', 'tmp'];

export interface SupervisorDeps {
  home?: string;
  /** The owner's login-shell PATH (cached by the server). */
  loginPath?: () => Promise<string>;
  /** Register a child for teardown on server shutdown (src/server/lifecycle.ts trackChild). */
  trackChild?: (kill: () => void) => () => void;
  /** Claim a loopback port as owned by this process (src/server/owned-ports.ts). */
  claimPort?: (port: number) => () => void;
  /** `lsof` listeners for pids: the listening addresses, or null when lsof is unavailable. */
  listeners?: (pids: number[]) => Promise<string[] | null>;
  now?: () => number;
  /** Turn the file watch off (tests). */
  noWatch?: boolean;
  /** Turn the data backup off (tests). */
  noBackup?: boolean;
  /**
   * A team pull holds this app (app-veri-ortak K5): the server retries the pull recovery
   * (`recoverAppPulls`, under the brain lock). Called when a start is refused for it.
   */
  onPullHeld?: (projectRoot: string) => void;
}

/** The refusal a start meets while a team pull lands this app's data (K5 "tek kapı"). */
export const PAUSED_FOR_SYNC = 'paused_for_sync: team data is landing for this app; it starts again when the pull is done';

/** While a backend runs, its data is backed up this often (only when something changed). */
export const BACKUP_INTERVAL_MS = 30 * 60_000;

interface Backend {
  child: ChildProcess;
  port: number;
  release: () => void;
  untrack: () => void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = a && typeof a === 'object' ? a.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** The health answer's status and the first 4 KB of its body (where `dc.health()` lists actions). */
function httpGetBody(port: number, path: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number | null; body: string }> {
  return new Promise((resolve) => {
    let status: number | null = null;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (s: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      resolve({ status: s, body: Buffer.concat(chunks).toString('utf-8') });
    };
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers, timeout: timeoutMs, agent: false }, (res) => {
      status = res.statusCode ?? null;
      let n = 0;
      res.on('data', (c: Buffer) => {
        if (n >= HEALTH_BODY_MAX) return;
        chunks.push(c.subarray(0, HEALTH_BODY_MAX - n));
        n += c.length;
        if (n >= HEALTH_BODY_MAX) res.destroy();
      });
      res.on('end', () => finish(status));
      res.on('close', () => finish(status));
      res.on('error', () => finish(status));
    });
    // One wall-clock limit for the whole probe: a trickling body cannot hold it, and a status that
    // arrived counts even when the body never ends (a health route that writes and never ends).
    const hard = setTimeout(() => { req.destroy(); finish(status); }, timeoutMs);
    req.on('error', () => finish(status));
    req.on('timeout', () => { req.destroy(); finish(status); });
    req.end();
  });
}

const HEALTH_BODY_MAX = 4096;

/** What a backend says it serves (`dc.health()`'s `dcActions`) against its manifest's tools. */
export interface ToolsAudit {
  /** `ok`: every tool is served; `drift`: some are not; `unaudited`: the backend does not say (no SDK). */
  state: 'ok' | 'drift' | 'unaudited';
  /** Manifest tools the backend does not list. */
  missing: string[];
}

/** Compare a health body with the manifest's action ids. Pure, for tests. */
export function auditTools(healthBody: string, actionIds: readonly string[]): ToolsAudit {
  let served: unknown;
  try { served = (JSON.parse(healthBody) as { dcActions?: unknown }).dcActions; } catch { served = undefined; }
  if (!Array.isArray(served)) return { state: 'unaudited', missing: [] };
  const set = new Set(served.filter((x): x is string => typeof x === 'string'));
  const missing = actionIds.filter((id) => !set.has(id));
  return { state: missing.length ? 'drift' : 'ok', missing };
}

function httpGet(port: number, path: string, headers: Record<string, string>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers, timeout: timeoutMs, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Where lsof lives: /usr/sbin on macOS, /usr/bin on Linux. Absolute, never a PATH lookup. */
export const LSOF_PATHS = ['/usr/sbin/lsof', '/usr/bin/lsof'] as const;

/** The first lsof that exists, or null (the bind check then degrades to a warning). */
export function lsofPath(exists: (p: string) => boolean = existsSync): string | null {
  return LSOF_PATHS.find((p) => exists(p)) ?? null;
}

/**
 * How a manifest's `command` / `build` line runs: `/bin/sh -c` off Windows; on Windows, where
 * there is no /bin/sh, `cmd.exe /d /s /c "<line>"` from System32 (`/s` strips exactly the outer
 * quotes, so the line reaches cmd as written; never a PATH lookup of the shell).
 */
export function shellInvocation(cmd: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; verbatim: boolean } {
  if (platform === 'win32') return { file: win32.join(win32System32(env), 'cmd.exe'), args: ['/d', '/s', '/c', `"${cmd}"`], verbatim: true };
  return { file: '/bin/sh', args: ['-c', cmd], verbatim: false };
}

/**
 * win32 `netstat -ano` → the local address of every TCP listener owned by one of `pids`. A
 * listener is told by its foreign address (`0.0.0.0:0`, `[::]:0`), not by the state column,
 * which Windows translates (`LISTENING`, `ABHÖREN`, …).
 */
export function parseNetstatListeners(stdout: string, pids: readonly number[]): string[] {
  const want = new Set(pids);
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t.length !== 5 || t[0].toUpperCase() !== 'TCP') continue;
    if (t[2] !== '0.0.0.0:0' && t[2] !== '[::]:0') continue;
    if (want.has(Number(t[4]))) out.push(t[1]);
  }
  return out;
}

/**
 * win32 process table lines `<pid> <ppid> <created>` → `root` and every descendant. Windows never
 * reparents and reuses pids, so a child must be younger than its parent: an old process whose
 * recorded parent id happens to be a recycled `root` is not ours.
 */
export function win32TreePids(stdout: string, root: number): number[] {
  const rows = stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 3 && r.every(Number.isFinite));
  const created = new Map(rows.map(([pid, , c]) => [pid, c]));
  const tree = [root];
  for (let i = 0; i < tree.length; i++) {
    const parent = tree[i];
    const born = created.get(parent) ?? 0;
    for (const [pid, ppid, c] of rows) if (ppid === parent && pid !== parent && c >= born && !tree.includes(pid)) tree.push(pid);
  }
  return tree;
}

function win32Listeners(pids: number[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(win32.join(win32System32(), 'NETSTAT.EXE'), ['-ano'], { timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : parseNetstatListeners(String(stdout), pids));
    });
  });
}

/** `lsof -nP -a -p <pids> -iTCP -sTCP:LISTEN` → the NAME column (`127.0.0.1:5000`, `*:5000`); netstat on Windows. */
export function realListeners(pids: number[]): Promise<string[] | null> {
  if (!pids.length) return Promise.resolve([]);
  if (process.platform === 'win32') return win32Listeners(pids);
  const lsof = lsofPath();
  if (!lsof) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(lsof, ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 5000 }, (err, stdout) => {
      // lsof exits 1 when nothing matched: an empty answer, not a failure.
      if (err && !stdout) { resolve((err as NodeJS.ErrnoException).code === 'ENOENT' ? null : []); return; }
      resolve(String(stdout).split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)));
    });
  });
}

/** A listener address that is not loopback-only (`*`, `0.0.0.0`, `::`, a LAN or global address). */
export function exposedListener(addr: string): boolean {
  const host = addr.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return !(host === '127.0.0.1' || host === '::1' || host === 'localhost' || /^127\./.test(host));
}

/**
 * All pids in a process group (the backend may fork its listener). On Windows there are no
 * groups: the backend's process tree from CIM, or null when it cannot be read (the bind check
 * then degrades to a warning, never to a silent pass on cmd.exe's own pid).
 */
function groupPids(pgid: number): Promise<number[] | null> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile(win32PowerShell(), ['-NoProfile', '-NonInteractive', '-Command',
        // No double quotes in the script: they would need a second round of argv escaping.
        "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { [string]$_.ProcessId + ' ' + $_.ParentProcessId + ' ' + $_.CreationDate.ToFileTimeUtc() }",
      ], { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
        // A table is enough even when PowerShell also reported an error on one row.
        resolve(String(stdout ?? '').trim() ? win32TreePids(String(stdout), pgid) : null);
      });
    });
  }
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,pgid='], { timeout: 3000 }, (err, stdout) => {
      if (err) { resolve([pgid]); return; }
      const pids = String(stdout).split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([, g]) => g === pgid).map(([p]) => p);
      resolve(pids.length ? pids : [pgid]);
    });
  });
}

function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    // No groups: taskkill /T over the tree, escalating to /F itself. No delayed second kill:
    // Windows reuses pids fast and that one could land on a stranger.
    try { killPortable(-pid, 'SIGTERM'); } catch { /* gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/** Is any process of this child's group still there? Off Windows the group is the child's pid; on Windows only the child. */
function groupAlive(child: ChildProcess): boolean {
  if (child.exitCode === null && child.signalCode === null) return true;
  const pid = child.pid;
  if (!pid || process.platform === 'win32') return false;
  try { process.kill(-pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface AppStatus {
  slug: string;
  name: string;
  state: AppState;
  rev: number;
  lastError: string | null;
  warnings: string[];
  windows: number;
  hasBackend: boolean;
  unguarded: boolean;
  stoppedByOwner: boolean;
  gwPort: number | null;
  portFallback: boolean;
  /** Null until a backend answered health (and for a backend-less app). */
  tools: ToolsAudit | null;
}

export class AppRuntime {
  readonly hash: string;
  rec: AppRecord;
  manifest: AppManifest | null = null;
  state: AppState = 'stopped';
  rev = 1;
  lastError: string | null = null;
  warnings: string[] = [];
  /** The last health answer's tool audit (app-araclari §2). */
  toolsAudit: ToolsAudit | null = null;
  readonly log: LineLog;
  /** The backend's Bearer for the gateway's /__dc/* (minted per runtime). */
  readonly dcToken = randomBytes(32).toString('base64url');
  /** Sent by the gateway on every request to the backend; the backend's dcGuard checks it. */
  readonly gatewaySecret = randomBytes(32).toString('base64url');
  backend: Backend | null = null;
  /** runnerToken → last heartbeat (ms). */
  readonly windows = new Map<string, number>();
  private calls = new Map<number, number>();
  private callSeq = 0;
  private redact: Redactor;
  private secrets: SecretValue[] = [];
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private updating: Promise<void> | null = null;
  private rerun = false;
  private updates: number[] = [];
  private starting: Promise<void> | null = null;
  private bindTimer: NodeJS.Timeout | null = null;
  private backupTimer: NodeJS.Timeout | null = null;
  private lastSweep = 0;
  /** A window being opened (launch-window), before its first heartbeat: holds the backend, is no window. */
  private launchHoldAt = 0;
  /** The build running now, so a stop can end it. */
  private buildChild: ChildProcess | null = null;
  /**
   * Every process group this runtime spawned that is not gone yet (app-veri-ortak K7): added at the
   * one spawn point ({@link spawnChild}) the moment a child exists, removed only when its whole group
   * is gone. A stop kills all of them; {@link stopAndWait} waits for this set to be empty, so a start
   * still in flight (a backend spawned but not adopted, in its health poll) is covered by construction.
   */
  private live = new Set<ChildProcess>();
  private liveWaiters = new Set<() => void>();
  /**
   * Bumped by every stop(). A start or update that awaited across a stop sees a different epoch
   * when it resumes, kills what it brought up and leaves the state alone: an owner's Stop (or a
   * DELETE) during a build or a health wait is never undone by the start finishing.
   */
  private epoch = 0;
  /** File events until this time are the build's own output, not an edit. */
  private quietUntil = 0;
  /** MCP keys per server, redacted for as long as this runtime lives (not only one refresh). */
  private mcpSecrets = new Map<string, SecretValue[]>();
  private readonly home: string;
  /** The gateway port this runtime is served on (set by the gateway). */
  gwPort: number | null = null;
  portFallback = false;

  constructor(rec: AppRecord, private deps: SupervisorDeps = {}) {
    this.rec = rec;
    this.hash = rec.hash;
    this.home = deps.home ?? homedir();
    this.redact = makeRedactor([]);
    this.log = new LineLog(this.redact);
    this.refreshSecrets();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The text sink (every app-derived string goes through it). */
  scrub(text: string): string {
    return this.redact(text);
  }

  /** Re-read `.env` (and any extra values, e.g. resolved MCP env) into the redactor. */
  refreshSecrets(extra: SecretValue[] = []): void {
    let dotenv: SecretValue[] = [];
    try { dotenv = parseDotenv(readFileSync(join(this.rec.root, '.env'), 'utf-8')); } catch { /* no .env */ }
    // Values of the previous set stay until the backend that knew them is gone (a rolling restart).
    const old = this.secrets;
    this.secrets = [
      ...dotenv,
      { key: 'DC_TOKEN', value: this.dcToken },
      { key: 'DC_GATEWAY_SECRET', value: this.gatewaySecret },
      ...extra,
    ];
    const mcp = [...this.mcpSecrets.values()].flat();
    this.redact = makeRedactor([...this.secrets, ...old, ...mcp]);
    this.log.setRedactor(this.redact);
  }

  /** The resolved key values of one MCP server: kept in the redactor from now on. */
  addMcpSecrets(server: string, values: SecretValue[]): void {
    this.mcpSecrets.set(server, values);
    this.refreshSecrets();
  }

  private dotenv(): Record<string, string> {
    const out: Record<string, string> = {};
    try { for (const { key, value } of parseDotenv(readFileSync(join(this.rec.root, '.env'), 'utf-8'))) out[key] = value; } catch { /* none */ }
    return out;
  }

  private async baseEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const k of ENV_ALLOW) if (process.env[k]) env[k] = process.env[k] as string;
    if (process.platform === 'win32') for (const k of ENV_ALLOW_WIN32) if (process.env[k]) env[k] = process.env[k] as string;
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith('LC_') && v) env[k] = v;
    if (this.deps.loginPath) {
      try { env.PATH = await this.deps.loginPath(); } catch { /* keep this process's PATH */ }
    }
    env.HOME = this.home === homedir() ? (process.env.HOME ?? this.home) : this.home;
    // Windows reads the home from USERPROFILE: it follows the same rule.
    if (process.platform === 'win32') env.USERPROFILE = this.home === homedir() ? (process.env.USERPROFILE ?? this.home) : this.home;
    return env;
  }

  status(): AppStatus {
    return {
      slug: this.rec.slug,
      name: this.rec.name,
      state: this.state,
      rev: this.rev,
      lastError: this.lastError ? this.scrub(this.lastError) : null,
      warnings: this.warnings.map((w) => this.scrub(w)),
      windows: this.liveWindows(),
      hasBackend: !!this.manifest?.backend,
      unguarded: !!this.manifest?.backend?.unguarded,
      stoppedByOwner: !!this.rec.stoppedByOwner,
      gwPort: this.gwPort,
      portFallback: this.portFallback,
      tools: this.toolsAudit,
    };
  }

  liveWindows(): number {
    const now = this.now();
    let n = 0;
    for (const t of this.windows.values()) if (now - t < WINDOW_LEASE_TTL_MS) n++;
    return n;
  }

  private setError(msg: string): void {
    this.state = 'error';
    this.lastError = msg;
    this.log.push(`[dreamcontext] error: ${msg}`);
  }

  /** Bring the app up (idempotent): resolves once it is running or in error. */
  ensureRunning(): Promise<void> {
    if (this.state === 'running' || this.state === 'updating') return Promise.resolve();
    // An update in flight (from `error`) brings a backend up itself: a start beside it would leave
    // one of the two running untracked. Wait for it, then look again.
    // A stop during that wait wins: nothing starts on the far side of the owner's Stop.
    if (this.updating) {
      const e = this.epoch;
      return this.updating.then(() => (e === this.epoch ? this.ensureRunning() : undefined));
    }
    if (this.starting) return this.starting;
    const p: Promise<void> = this.start()
      .catch((e: unknown) => {
        // freePort (EMFILE), mkdir (ENOSPC, EACCES): an error on the card, never a crashed server.
        this.setError(`start: ${(e as Error)?.message ?? String(e)}`);
      })
      .finally(() => { if (this.starting === p) this.starting = null; });
    this.starting = p;
    return p;
  }

  /**
   * A team pull holds this app (its record exists, read from disk every time): nothing starts.
   * The state stays `stopped` (not `error`), so the window's next heartbeat asks again and the
   * lease brings the backend back the moment the record goes.
   */
  pullHeld(): boolean {
    if (!appPullHeld(this.home, this.hash)) return false;
    try { this.deps.onPullHeld?.(this.rec.projectRoot); } catch { /* the next ask retries */ }
    return true;
  }

  private async start(): Promise<void> {
    const mine = this.epoch;
    if (this.pullHeld()) { this.state = 'stopped'; this.lastError = PAUSED_FOR_SYNC; return; }
    this.state = 'starting';
    this.lastError = null;
    this.warnings = [];
    // The code folder was moved or deleted (D8): say what to do, not "dreamcontext-app.json not found".
    if (!existsSync(this.rec.root)) {
      this.setError(`The app's folder is missing (${this.rec.root}). Put it back, or ask Claude to remove the app.`);
      return;
    }
    const m = readManifest(this.rec.root);
    if (!m.ok) {
      this.setError(`manifest: ${m.errors.map((e: ManifestProblem) => `${e.field}: ${e.problem}`).join('; ')}`);
      return;
    }
    this.manifest = m.manifest;
    for (const w of m.warnings) if (!w.authoring) this.warnings.push(`${w.field}: ${w.problem}`);
    this.refreshSecrets();
    // A required setting left empty: nothing starts until the owner fills it (plan r2 K2).
    const missing = missingRequired(m.manifest.config, readAppConfig(this.home, this.rec.configId), this.rec.root);
    if (missing.length) {
      this.setError(`settings needed: ${missing.join(', ')} (fill them on the app card or with \`dreamcontext apps config ${this.rec.slug}\`)`);
      return;
    }
    if (!m.manifest.backend) {
      if (!existsSync(join(this.rec.root, 'public'))) this.warnings.push('no backend and no public/ folder: nothing to show');
      this.state = 'running';
      // The watch starts once the app is up: an event during the first start is not an update.
      if (!this.deps.noWatch) this.startWatch();
      return;
    }
    if (!this.prepareData()) return;
    await this.backup('start');
    if (mine !== this.epoch) return;
    const built = await this.runBuild(mine);
    if (mine !== this.epoch || !built) return;
    const b = await this.spawnBackend(mine);
    if (!b) return;
    if (mine !== this.epoch) { killGroup(b.child); return; }
    // Never orphan a backend: whatever else came up meanwhile goes.
    if (this.backend && this.backend !== b) killGroup(this.backend.child);
    this.backend = b;
    this.state = 'running';
    this.scheduleBindRecheck();
    this.scheduleBackup();
    if (!this.deps.noWatch) this.startWatch();
  }

  /**
   * The data folder before a backend may use it (plan-veri K1, K3): the old folder moved in,
   * privacy written, the chain checked, nothing a link or an agent instruction inside. Sets the
   * error and returns false otherwise.
   */
  private prepareData(): boolean {
    const mig = migrateAppData(this.home, this.rec);
    if (mig.status === 'refused') { this.setError(`${mig.code}: ${mig.message}`); return false; }
    if (mig.status === 'moved') this.log.push(`[dreamcontext] data moved from ${mig.from} to ${mig.to}`);
    let dir: string;
    try { dir = ensureAppDataDir(this.rec.projectRoot, this.rec.slug); } catch (e) {
      this.setError(e instanceof AppDataError ? e.message : `data folder: ${(e as Error).message}`);
      return false;
    }
    const scan = scanAppData(dir);
    if (scan.symlink) { this.setError(`app_data_symlink: ${scan.symlink} is a symlink inside the data folder; remove it to start the app`); return false; }
    if (scan.instruction) { this.setError(`app_instruction_file: ${scan.instruction} is an agent instruction file inside the data folder; app data is data, never instructions. Remove it to start the app`); return false; }
    return true;
  }

  /** One backup of the data folder, outside every repo (data-backup.ts). Never throws. */
  async backup(reason: string): Promise<void> {
    if (this.deps.noBackup) return;
    try {
      const r = await backupAppData(this.home, this.hash, appDataDir(this.rec.projectRoot, this.rec.slug), { reason });
      if (!r.ok && 'error' in r) this.log.push(`[dreamcontext] data backup failed: ${r.error}`);
      else if (!r.ok && r.skipped === 'too_big') {
        const w = 'the data folder is over 512 MB (or 20,000 entries): it is not backed up';
        if (!this.warnings.includes(w)) this.warnings.push(w);
      }
    } catch { /* a backup never stops the app */ }
  }

  private scheduleBackup(): void {
    if (this.backupTimer) clearInterval(this.backupTimer);
    if (this.deps.noBackup) return;
    this.backupTimer = setInterval(() => { if (this.state === 'running') void this.backup('interval'); }, BACKUP_INTERVAL_MS);
    this.backupTimer.unref();
  }

  private async runBuild(mine: number): Promise<boolean> {
    const cmd = this.manifest?.build;
    if (!cmd) return true;
    const env = { ...(await this.baseEnv()), ...this.dotenv(), DC_DATA_DIR: this.dataDir() };
    // No DC_TOKEN, no DC_GATEWAY_SECRET: a bundler could inline them into the page.
    delete (env as Record<string, string>).DC_TOKEN;
    delete (env as Record<string, string>).DC_GATEWAY_SECRET;
    const spawned = this.spawnChild(cmd, env, mine);
    if (!spawned) return false;
    const child = spawned;
    this.quietUntil = Number.POSITIVE_INFINITY;
    return new Promise((resolve) => {
      this.buildChild = child;
      const untrack = this.deps.trackChild?.(() => killGroup(child)) ?? (() => {});
      child.stdout?.on('data', (c) => this.log.write(c, '[build] '));
      child.stderr?.on('data', (c) => this.log.write(c, '[build] '));
      const timer = setTimeout(() => killGroup(child), 5 * 60_000);
      child.on('error', (e) => { this.lastError = `build: ${e.message}`; this.quietUntil = 0; });
      child.on('exit', (code) => {
        clearTimeout(timer);
        untrack();
        const cancelled = this.buildChild !== child;
        if (!cancelled) this.buildChild = null;
        // The build's own writes (public/, dist/) land as file events for a moment after it ends.
        this.quietUntil = this.now() + BUILD_QUIET_MS;
        this.log.flush('[build] ');
        if (code === 0) resolve(true);
        else if (cancelled) resolve(false); // a stop ended it: not a failure to report
        else {
          if (this.state === 'starting') this.setError(`build failed (exit ${code})`);
          else this.lastError = `build failed (exit ${code})${this.staysTail()}`;
          resolve(false);
        }
      });
    });
  }

  /** `_dream_context/apps/<slug>/`, made (privacy first) if missing. Throws AppDataError. */
  dataDir(): string {
    return ensureAppDataDir(this.rec.projectRoot, this.rec.slug);
  }

  /**
   * THE one place this runtime starts a process (build or backend). It refuses, returning null, when
   * the start that asked was overtaken by a stop (`mine` is not the epoch any more) or when a team
   * pull holds the app (its record, read NOW, at spawn time). A child it starts is in the live set
   * from this moment until its whole group is gone. Its own process group off Windows; on Windows a
   * hidden child of this server (no groups there).
   */
  private spawnChild(cmd: string, env: Record<string, string>, mine: number): ChildProcess | null {
    if (mine !== this.epoch) return null;
    if (appPullHeld(this.home, this.hash)) {
      if (this.state === 'starting') this.state = 'stopped';
      this.lastError = PAUSED_FOR_SYNC;
      try { this.deps.onPullHeld?.(this.rec.projectRoot); } catch { /* the next ask retries */ }
      return null;
    }
    const sh = shellInvocation(cmd);
    const win = process.platform === 'win32';
    const child = spawn(sh.file, sh.args, { cwd: this.rec.root, env, detached: !win, windowsHide: true, windowsVerbatimArguments: sh.verbatim, stdio: ['ignore', 'pipe', 'pipe'] });
    this.live.add(child);
    const settle = () => {
      if (groupAlive(child)) { setTimeout(settle, 50).unref(); return; }
      this.live.delete(child);
      for (const w of [...this.liveWaiters]) w();
    };
    child.once('exit', settle);
    // A spawn that failed outright (ENOENT) emits 'error' and maybe no 'exit'.
    child.once('error', () => setTimeout(settle, 0).unref());
    return child;
  }

  /** Process groups this runtime started that are not gone yet. */
  liveChildCount(): number {
    return this.live.size;
  }

  /** The pids (group leaders off Windows) of what is still live: server shutdown waits for these. */
  livePids(): number[] {
    return [...this.live].map((c) => c.pid).filter((p): p is number => !!p);
  }

  private async spawnBackend(mine: number): Promise<Backend | null> {
    const be = this.manifest!.backend!;
    const port = await freePort();
    const env: Record<string, string> = {
      ...(await this.baseEnv()),
      ...this.dotenv(),
      PORT: String(port),
      HOST: '127.0.0.1',
      DC_URL: this.gwPort ? `http://127.0.0.1:${this.gwPort}` : '',
      DC_TOKEN: this.dcToken,
      DC_GATEWAY_SECRET: this.gatewaySecret,
      DC_DATA_DIR: this.dataDir(),
      DC_CONFIG: JSON.stringify(publicConfig(this.manifest!.config, readAppConfig(this.home, this.rec.configId))),
    };
    const child = this.spawnChild(be.command, env, mine);
    if (!child) return null;
    const release = this.deps.claimPort?.(port) ?? (() => {});
    const untrack = this.deps.trackChild?.(() => killGroup(child)) ?? (() => {});
    const b: Backend = { child, port, release, untrack };
    let exited: number | null | undefined;
    child.stdout?.on('data', (c) => this.log.write(c));
    child.stderr?.on('data', (c) => this.log.write(c));
    child.on('error', (e) => { this.log.push(`[dreamcontext] spawn: ${e.message}`); exited = -1; });
    child.on('exit', (code) => {
      exited = code;
      this.log.flush();
      untrack();
      release();
      if (this.backend === b) {
        this.backend = null;
        if (this.state === 'running') this.setError(`backend exited (code ${code})`);
      }
    });
    const deadline = this.now() + HEALTH_TIMEOUT_MS;
    let ok = false;
    while (this.now() < deadline && exited === undefined) {
      const h = await httpGetBody(port, be.health, { [GATEWAY_SECRET_HEADER]: this.gatewaySecret, host: `127.0.0.1:${port}` }, 1500);
      if (h.status === 200) {
        ok = true;
        const audit = auditTools(h.body, this.manifest?.actions.map((a) => a.id) ?? []);
        this.toolsAudit = audit;
        if (audit.state === 'drift') {
          const w = `actions_drift: the backend does not serve ${audit.missing.join(', ')} (listed in the manifest)`;
          if (!this.warnings.includes(w)) this.warnings.push(w);
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ok) {
      killGroup(child);
      const why = exited !== undefined ? `the backend exited (code ${exited}) before its health answered` : `health ${be.health} did not answer 200 within ${HEALTH_TIMEOUT_MS / 1000} s`;
      if (mine !== this.epoch) return null; // a stop ended this start: its failure is not the next one's
      if (this.state === 'starting') this.setError(why);
      else this.lastError = `${why}${this.staysTail()}`;
      return null;
    }
    const problem = await this.checkBackend(b);
    if (problem) {
      killGroup(child);
      if (mine !== this.epoch) return null;
      if (this.state === 'starting') this.setError(problem);
      else this.lastError = `${problem}${this.staysTail()}`;
      return null;
    }
    return b;
  }

  /** Binding + guard checks. Returns the error, or null (warnings go to `warnings`). */
  private async checkBackend(b: Backend): Promise<string | null> {
    const be = this.manifest!.backend!;
    const pids = b.child.pid ? await groupPids(b.child.pid) : [];
    const lsof = pids === null ? null : await (this.deps.listeners ?? realListeners)(pids);
    if (lsof === null) {
      this.warnings.push(`could not check what the backend listens on (${process.platform === 'win32' ? 'netstat' : 'lsof'} unavailable)`);
    } else {
      const exposed = lsof.filter(exposedListener);
      if (exposed.length) {
        const msg = `backend is reachable from the network (${exposed.join(', ')}): bind it to 127.0.0.1 (use $HOST)`;
        if (be.unguarded) this.warnings.push(msg);
        else return msg;
      }
    }
    const bare = await httpGet(b.port, be.health, { host: `127.0.0.1:${b.port}` }, 2000);
    if (bare !== 401 && bare !== 403) {
      const msg = `dcGuard missing: ${be.health} answered ${bare ?? 'nothing'} without the gateway secret (it must refuse requests without X-DC-Gateway-Secret)`;
      if (be.unguarded) this.warnings.push(msg);
      else return msg;
    }
    return null;
  }

  private scheduleBindRecheck(): void {
    if (this.bindTimer) clearInterval(this.bindTimer);
    this.bindTimer = setInterval(() => {
      const b = this.backend;
      if (!b || this.state !== 'running') return;
      void this.checkBackend(b).then((problem) => {
        if (problem && this.backend === b) {
          killGroup(b.child);
          this.backend = null;
          this.setError(problem);
        }
      });
    }, BIND_RECHECK_MS);
    this.bindTimer.unref();
  }

  /** Stop the backend (and the watch). `byOwner` marks it (the caller persists the mark). */
  stop(opts: { backup?: boolean } = {}): void {
    this.epoch++;
    // A start or build cut short by this stop is not one a later Start may join.
    this.starting = null;
    if (this.buildChild) { killGroup(this.buildChild); this.buildChild = null; }
    this.stopWatch();
    if (this.bindTimer) { clearInterval(this.bindTimer); this.bindTimer = null; }
    if (this.backupTimer) { clearInterval(this.backupTimer); this.backupTimer = null; }
    const b = this.backend;
    this.backend = null;
    if (b) killGroup(b.child);
    // Every group this runtime started, adopted or not (a start in flight's backend in its health poll).
    for (const c of this.live) if (c !== b?.child) killGroup(c);
    // After the backend has had a moment to write its last state down.
    if (b && !this.deps.noBackup && opts.backup !== false) setTimeout(() => { void this.backup('stop'); }, 2000).unref();
    this.state = 'stopped';
  }

  /**
   * Stop, and resolve only once everything this runtime started is really GONE (app-veri-ortak K7:
   * a team pull must not touch the data folder while a backend still writes its last save in its
   * SIGTERM handler, or boots in a start still in flight). It waits for the live set (every group
   * spawned at {@link spawnChild}, adopted or not) to be empty: gone = the child exited AND, off
   * Windows, its whole group answers ESRCH. The stop moves the epoch, so a start in flight cannot
   * spawn after this. `stop()` escalates to SIGKILL after 2 s; this resolves false at `timeoutMs`.
   * No delayed stop-backup: the pull takes its own before it parks anything.
   */
  async stopAndWait(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    this.stop({ backup: false });
    while (this.live.size) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(t); this.liveWaiters.delete(done); resolve(); };
        const t = setTimeout(done, left);
        this.liveWaiters.add(done);
      });
    }
    return true;
  }


  // ─── leases ───────────────────────────────────────────────────────────────

  heartbeat(token: string): void {
    // One bundle id is one runner process with one connection: a token not seen before means
    // that runner reconnected or was replaced, and every older token is dead, whatever its TTL.
    if (!this.windows.has(token)) this.windows.clear();
    this.windows.set(token, this.now());
  }

  /** The OS says the runner process is gone: no window, whatever the leases still claim. */
  clearWindows(): void {
    this.windows.clear();
  }

  /** launch-window: keep the backend up until the new window's first heartbeat (one lease TTL). */
  holdForLaunch(): void {
    this.launchHoldAt = this.now();
  }

  dropWindow(token: string): void {
    this.windows.delete(token);
  }

  /** Hold a call lease; call the returned function when the request is done. */
  acquireCall(): () => void {
    const id = ++this.callSeq;
    this.calls.set(id, this.now());
    return () => { this.calls.delete(id); };
  }

  /** Stop the backend when no lease is left. Returns true when it stopped it. */
  sweep(): boolean {
    const now = this.now();
    // The Mac slept: the wall clock jumped. Grant every lease one more TTL before judging.
    if (this.lastSweep && now - this.lastSweep > WINDOW_LEASE_TTL_MS) {
      for (const k of this.windows.keys()) this.windows.set(k, now);
      for (const k of this.calls.keys()) this.calls.set(k, now);
    }
    this.lastSweep = now;
    for (const [k, t] of this.windows) if (now - t > WINDOW_LEASE_TTL_MS * 4) this.windows.delete(k);
    // A call lease is never aged out: it lives exactly as long as its request (release() runs in
    // a finally), so a long action is not killed mid-way. The request's own idle timeout bounds it.
    const launching = now - this.launchHoldAt < WINDOW_LEASE_TTL_MS;
    const leased = this.liveWindows() > 0 || this.calls.size > 0 || launching;
    const ownerStopped = !!this.rec.stoppedByOwner && (!!this.backend || this.state === 'running' || this.state === 'updating');
    if (ownerStopped || (!leased && (this.state === 'running' || this.state === 'error') && (this.backend || this.watcher))) {
      this.stop();
      return true;
    }
    return false;
  }

  // ─── hot update ───────────────────────────────────────────────────────────

  private ignored(file: string): boolean {
    const rel = relative(this.rec.root, file);
    if (!rel || rel.startsWith('..')) return true;
    const parts = rel.split(sep);
    if (parts.some((p) => DEFAULT_IGNORE.includes(p))) return true;
    const base = parts[parts.length - 1];
    if (base.startsWith('.env') || base.endsWith('.log') || /\.sqlite/.test(base)) return true;
    for (const pat of this.manifest?.watch.ignore ?? []) {
      if (pat.includes('*')) {
        const re = new RegExp('^' + pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        if (re.test(base) || re.test(rel)) return true;
      } else if (parts.includes(pat) || rel === pat || rel.startsWith(pat + sep)) return true;
    }
    return false;
  }

  startWatch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.rec.root, { recursive: true }, (_ev, name) => {
        if (!name) return;
        if (this.ignored(join(this.rec.root, String(name)))) return;
        this.onChange();
      });
      this.watcher.on('error', () => this.stopWatch());
    } catch (e) {
      this.warnings.push(`file watch unavailable: ${(e as Error).message}`);
    }
  }

  stopWatch(): void {
    try { this.watcher?.close(); } catch { /* closed */ }
    this.watcher = null;
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
  }

  private onChange(): void {
    if (this.now() < this.quietUntil) return;
    if (this.updating) { this.rerun = true; return; }
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; void this.update(); }, DEBOUNCE_MS);
  }

  /** "; the running version stays" only while a backend still runs (D7b): never on a crashed app. */
  private staysTail(): string {
    return this.backend ? '; the running version stays' : '';
  }

  /** A rolling update: the new version replaces the running one only if it is healthy. */
  update(): Promise<void> {
    if (this.updating) { this.rerun = true; return this.updating; }
    // A start brings up the files as they are now; a stopped app is not updated behind the owner.
    if (this.state === 'starting') return this.starting ?? Promise.resolve();
    if (this.state === 'stopped') return Promise.resolve();
    const now = this.now();
    this.updates = this.updates.filter((t) => now - t < STORM_WINDOW_MS);
    this.updates.push(now);
    if (this.updates.length > STORM_MAX) {
      this.stopWatch();
      this.lastError = 'more than 5 updates in 30 s: the file watch stopped (the app may be writing into its own folder; keep data in DC_DATA_DIR)';
      return Promise.resolve();
    }
    const mine = this.epoch;
    this.updating = (async () => {
      const before = this.state;
      const m = readManifest(this.rec.root);
      if (!m.ok) {
        this.lastError = `manifest: ${m.errors.map((e) => `${e.field}: ${e.problem}`).join('; ')}${this.staysTail()}`;
        return;
      }
      this.manifest = m.manifest;
      if (!m.manifest.backend) {
        this.lastError = null;
        this.rev++;
        if (before === 'error' || before === 'stopped') this.state = 'running';
        return;
      }
      if (this.pullHeld()) return;
      if (before === 'running') this.state = 'updating';
      this.refreshSecrets();
      const built = await this.runBuild(mine);
      const fresh = built && mine === this.epoch ? await this.spawnBackend(mine) : null;
      if (mine !== this.epoch) { if (fresh) killGroup(fresh.child); return; }
      if (fresh) {
        const old = this.backend;
        this.backend = fresh;
        this.state = 'running';
        this.lastError = null;
        this.rev++;
        if (old) killGroup(old.child);
        this.scheduleBindRecheck();
      } else if (this.state === 'updating') {
        // The old backend may have exited while the new one failed: then nothing is running.
        if (this.backend) this.state = 'running';
        else this.setError(this.lastError ?? 'the update failed and the backend is not running');
      }
    })().catch((e: unknown) => {
      this.lastError = `update: ${(e as Error)?.message ?? String(e)}`;
      if (this.state === 'updating') this.state = this.backend ? 'running' : 'error';
    }).finally(() => {
      this.updating = null;
      if (this.rerun) { this.rerun = false; this.onChange(); }
    });
    return this.updating;
  }

  /** Mark the runtime's record (after a registry write). */
  setRecord(rec: AppRecord): void {
    this.rec = rec;
  }
}

const runtimes = new Map<string, AppRuntime>();

export function runtimeFor(rec: AppRecord, deps: SupervisorDeps = {}): AppRuntime {
  let r = runtimes.get(rec.hash);
  if (!r) {
    r = new AppRuntime(rec, deps);
    runtimes.set(rec.hash, r);
  } else {
    r.setRecord(rec);
  }
  return r;
}

export function existingRuntime(hash: string): AppRuntime | null {
  return runtimes.get(hash) ?? null;
}

export function allRuntimes(): AppRuntime[] {
  return [...runtimes.values()];
}

export function forgetRuntime(hash: string): void {
  const r = runtimes.get(hash);
  r?.stop();
  runtimes.delete(hash);
}

/**
 * Stop every backend (server shutdown, tests). Backends run in their own process groups, so the
 * shell's kill of this process does not reach them, and an unref'd SIGKILL timer never fires once
 * Node exits: SIGTERM every group, wait up to 1.5 s for them to go, then SIGKILL what is left,
 * all before returning.
 */
export function stopAllRuntimes(): void {
  const groups: number[] = [];
  for (const r of runtimes.values()) {
    // Every group it started, a start in flight's unadopted backend and a build included.
    groups.push(...r.livePids());
    r.stop();
  }
  runtimes.clear();
  const alive = (g: number) => { try { process.kill(-g, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 1500;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (groups.some(alive) && Date.now() < deadline) Atomics.wait(nap, 0, 0, 50);
  for (const g of groups) if (alive(g)) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } }
}
