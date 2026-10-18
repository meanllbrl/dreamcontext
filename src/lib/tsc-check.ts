/**
 * The PostToolUse type-check, shared by every agent editing one TS project.
 *
 * Before: every Edit/Write of a JS/TS file ran its own `tsc --noEmit --incremental` over the
 * whole project, so ten agents editing at once ran ten whole-project checks at once (and fought
 * over one .tsbuildinfo). Now, per tsconfig:
 *
 * - At most ONE tsc runs at a time: an O_EXCL lock in os.tmpdir() (pid + 60 s stale TTL, a dead
 *   holder's lock reclaimed at once). Every edit first files a `pending` entry; the hook that
 *   wins the lock checks the project once for EVERY pending file, and runs once more (never
 *   more) when edits arrived while it ran. A hook that loses the lock returns at once.
 * - Errors for a file whose check another hook ran are written into that session's results;
 *   the session's next PostToolUse, or its Stop, reads and reports them. The editing agent still
 *   sees its own type errors, in the same turn or at its end.
 * - A project whose last check took over {@link SLOW_TSC_MS} stops checking on every edit: the
 *   files edited in the turn are checked once, at Stop.
 *
 * State lives in `<tmpdir>/dreamcontext-tsc-<uid>/<hash of the tsconfig path>/` (0700, checked to be
 * this user's own real directory before every use; otherwise the edit is checked on its own): `lock`, `meta.json`
 * (the tsconfig and the last check's duration), `pending/`, `results/<session>/`. Everything
 * here is best-effort: a failure in this module must never break an edit.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

/** A project whose last check took longer than this is checked once per turn, at Stop. */
export const SLOW_TSC_MS = 4000;
/** A lock older than this is reclaimed even when its holder still looks alive. */
export const TSC_LOCK_STALE_MS = 60_000;
/** The per-check cap (today's PostToolUse cap). */
export const TSC_TIMEOUT_MS = 30_000;
/** What one PostToolUse may spend on checks: its own hook timeout is 30 s. */
export const EDIT_BUDGET_MS = 25_000;
/** What a Stop waits for a running check, then spends on its own. Its hook timeout is 45 s. */
export const STOP_BUDGET_MS = 35_000;
/** Pending and result entries a session never collected are dropped after a day. */
const ENTRY_MAX_AGE_MS = 24 * 3600 * 1000;

export interface TscRun {
  /** tsc's combined output when it reported errors; null when clean or when tsc could not run. */
  output: string | null;
  ms: number;
  /** Cut off by its timeout: tsc prints its errors only at the end, so the empty output means
   *  nothing, and the check answers nobody. */
  timedOut?: boolean;
}
export type TscRunner = (projectRoot: string, timeoutMs: number) => TscRun;

export interface TscCheckOpts {
  /** The Claude Code session the edit belongs to ('' when the hook got none). */
  sessionId: string;
  runner?: TscRunner;
  /** Root of the shared state (default `<tmpdir>/dreamcontext-tsc-<uid>`). */
  baseDir?: string;
  now?: () => number;
  /** The time this hook may spend, counted from `startedAt`. */
  budgetMs?: number;
  /** When the hook process started (its timeout runs from there, not from this call). */
  startedAt?: number;
  /**
   * What this session's Stop hook can spend on a check (its installed timeout, minus its own
   * work). A slow project is deferred to Stop only when that covers the last check; otherwise
   * every edit is still checked (serialized), so an older install with a 5 s Stop timeout loses
   * nothing. Unset = Stop has room.
   */
  stopBudgetMs?: number;
}

interface PendingEntry {
  name: string;
  sessionId: string;
  file: string;
  at: number;
}

interface Meta {
  tsconfig?: string;
  lastMs?: number;
  /** When a check last ran into the full {@link TSC_TIMEOUT_MS} cap (cleared by one that finishes). */
  capHitAt?: number;
}

/** After a check hit the cap, no check is tried for this long: it would be cut off again. */
const CAP_BACKOFF_MS = 10 * 60 * 1000;

/** The project's check cannot finish within the cap: trying again soon only burns 30 s. */
function overCap(meta: Meta, nowMs: number): boolean {
  return typeof meta.capHitAt === 'number' && nowMs - meta.capHitAt < CAP_BACKOFF_MS;
}

/** Resolve a binary from the project's own node_modules/.bin. */
function localBin(binName: string, projectRoot: string): string | null {
  const p = join(projectRoot, 'node_modules', '.bin', binName);
  return existsSync(p) ? p : null;
}

/** One whole-project `tsc --noEmit --incremental`, exactly as the hook always ran it. */
export const defaultTscRunner: TscRunner = (projectRoot, timeoutMs) => {
  const started = Date.now();
  const args = ['--noEmit', '--pretty', 'false', '--incremental'];
  const bin = localBin('tsc', projectRoot);
  try {
    if (bin) {
      execFileSync(bin, args, { cwd: projectRoot, timeout: timeoutMs, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      execFileSync('npx', ['tsc', ...args], { cwd: projectRoot, timeout: timeoutMs, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    }
    return { output: null, ms: Date.now() - started };
  } catch (err: unknown) {
    const ms = Date.now() - started;
    const e = (err ?? {}) as { stdout?: string; stderr?: string; code?: string; signal?: string | null };
    if (e.code === 'ETIMEDOUT' || e.signal) return { output: null, ms, timedOut: true };
    if ('stdout' in e) {
      const out = String(e.stdout || '') + String(e.stderr || '');
      return { output: out.trim() ? out : null, ms };
    }
    return { output: null, ms }; // tsc not installed or another non-TS failure
  }
};

/** The errors tsc reported for one file, in the message the hook has always printed; null if none. */
export function filterTscErrors(output: string | null, filePath: string, projectRoot: string): string | null {
  if (!output || !output.trim()) return null;
  const resolvedPath = resolve(filePath);
  const relativePath = relative(projectRoot, resolvedPath);
  const relevant: string[] = [];
  for (const line of output.split('\n')) {
    if (line.includes(resolvedPath) || line.includes(relativePath)) relevant.push(line.trim());
  }
  if (relevant.length === 0) return null;
  return `TypeScript errors in ${basename(filePath)}:\n${relevant.join('\n')}`;
}

// ─── State on disk ────────────────────────────────────────────────────────────

const hash = (s: string, n = 16) => createHash('sha1').update(s).digest('hex').slice(0, n);
const safeSession = (id: string) => (id || 'no-session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

export function tscBaseDir(baseDir?: string): string {
  if (baseDir) return baseDir;
  // Per user: on Linux os.tmpdir() is the shared /tmp, and another user must never own (or
  // plant files in) the directory whose results this hook prints into an agent's context.
  const uid = typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
  return join(tmpdir(), `dreamcontext-tsc${uid}`);
}

/**
 * The base dir exists, is a real directory (not a symlink), belongs to this user and nobody else
 * can write to it; created 0700 when missing. False = do not use the shared state at all (the
 * caller checks the edit directly, as the hook always did).
 */
export function ensureSafeBaseDir(baseDir?: string): boolean {
  const base = tscBaseDir(baseDir);
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const st = lstatSync(base);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (typeof process.getuid === 'function') {
      if (st.uid !== process.getuid()) return false;
      if ((st.mode & 0o022) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function tscStateDir(tsconfigPath: string, baseDir?: string): string {
  return join(tscBaseDir(baseDir), hash(resolve(tsconfigPath)));
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Write via a temp file + rename, so a reader never sees half a file. */
function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readMeta(dir: string): Meta {
  return readJson<Meta>(join(dir, 'meta.json')) ?? {};
}

function writeMeta(dir: string, meta: Meta): void {
  writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta));
}

function ensureDir(dir: string, tsconfigPath: string): void {
  mkdirSync(join(dir, 'pending'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'results'), { recursive: true, mode: 0o700 });
  const meta = readMeta(dir);
  if (meta.tsconfig !== resolve(tsconfigPath)) writeMeta(dir, { ...meta, tsconfig: resolve(tsconfigPath) });
}

function addPending(dir: string, sessionId: string, file: string, nowMs: number): void {
  const name = `${hash(`${sessionId}\0${resolve(file)}`)}-${process.pid}-${nowMs}-${Math.random().toString(36).slice(2, 8)}.json`;
  writeAtomic(join(dir, 'pending', name), JSON.stringify({ sessionId, file: resolve(file), at: nowMs }));
  // This edit supersedes any answer about the file's previous content.
  try { rmSync(join(dir, 'results', safeSession(sessionId), `${hash(resolve(file))}.json`), { force: true }); } catch { /* none */ }
}

function listPending(dir: string): PendingEntry[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, 'pending')).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: PendingEntry[] = [];
  for (const name of names) {
    const e = readJson<{ sessionId: string; file: string; at: number }>(join(dir, 'pending', name));
    if (e && typeof e.file === 'string') out.push({ name, sessionId: String(e.sessionId ?? ''), file: e.file, at: Number(e.at) || 0 });
  }
  return out;
}

/** `startedAt`: when the check that produced it started (it saw the file as it was then). */
function writeResult(dir: string, sessionId: string, file: string, errors: string | null, startedAt: number): void {
  writeAtomic(join(dir, 'results', safeSession(sessionId), `${hash(file)}.json`), JSON.stringify({ file, errors, startedAt }));
}

/** Every state dir under the base: the projects this machine's agents have type-checked. */
function stateDirs(baseDir?: string): string[] {
  const base = tscBaseDir(baseDir);
  if (!existsSync(base) || !ensureSafeBaseDir(baseDir)) return [];
  try {
    return readdirSync(base).map((n) => join(base, n)).filter((d) => existsSync(join(d, 'meta.json')));
  } catch {
    return [];
  }
}

/**
 * Collect (and remove) the errors other hooks' checks found in this session's files, across every
 * project. `skipFile`: a file the caller has a fresher answer for (its own check just ran).
 */
export function takeTscResults(sessionId: string, opts: { baseDir?: string; skipFile?: string } = {}): string[] {
  const messages: string[] = [];
  const skip = opts.skipFile ? resolve(opts.skipFile) : null;
  for (const dir of stateDirs(opts.baseDir)) {
    const sdir = join(dir, 'results', safeSession(sessionId));
    let names: string[];
    try {
      names = readdirSync(sdir).filter((n) => n.endsWith('.json'));
    } catch {
      continue;
    }
    // A file this session edited again after a check started: that check's answer may describe
    // code that no longer exists, and a fresh one is coming. Never report it.
    const editedAt = new Map<string, number>();
    for (const p of listPending(dir)) {
      if (p.sessionId === sessionId) editedAt.set(p.file, Math.max(p.at, editedAt.get(p.file) ?? 0));
    }
    for (const name of names) {
      const path = join(sdir, name);
      const r = readJson<{ file: string; errors: string | null; startedAt?: number }>(path);
      try { rmSync(path, { force: true }); } catch { /* another reader took it */ }
      if (!r?.errors || r.file === skip) continue;
      const later = editedAt.get(r.file);
      if (later !== undefined && later >= (r.startedAt ?? 0)) continue;
      messages.push(r.errors);
    }
  }
  return messages;
}

// ─── The lock ─────────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * O_EXCL create. A lock is reclaimed when it is older than the TTL, or when its holder is dead AND
 * the tsc it started could no longer be running (a hook Claude Code killed leaves its tsc running
 * up to the check timeout; reclaiming sooner would start a second one). Reclaiming is itself
 * exclusive: only the process holding `lock.reclaim` may remove a stale lock, so two contenders
 * that both saw it stale can never both end up holding the lock.
 */
function acquire(dir: string, nowMs: number): boolean {
  const lock = join(dir, 'lock');
  const tryCreate = () => {
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: nowMs }), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  };
  if (tryCreate()) return true;
  const stale = (): boolean => {
    const held = readJson<{ pid?: number; at?: number }>(lock);
    let at = typeof held?.at === 'number' ? held.at : null;
    if (at === null) {
      try { at = statSync(lock).mtimeMs; } catch { return false; }
    }
    const age = nowMs - at;
    if (age > TSC_LOCK_STALE_MS) return true;
    const dead = typeof held?.pid === 'number' && held.pid !== process.pid && !pidAlive(held.pid);
    return dead && age > TSC_TIMEOUT_MS + 5000;
  };
  if (!stale()) return false;

  const reclaim = join(dir, 'lock.reclaim');
  try {
    writeFileSync(reclaim, String(nowMs), { flag: 'wx' });
  } catch {
    // Another process is reclaiming. Its own marker can be left by a crash: clear one that old.
    try {
      if (nowMs - statSync(reclaim).mtimeMs > 10_000) rmSync(reclaim, { force: true });
    } catch { /* gone */ }
    return false;
  }
  try {
    if (!stale()) return false; // someone reclaimed it before we got here
    try { rmSync(lock, { force: true }); } catch { /* raced */ }
    return tryCreate();
  } finally {
    try { rmSync(reclaim, { force: true }); } catch { /* gone */ }
  }
}

function release(dir: string): void {
  const lock = join(dir, 'lock');
  const held = readJson<{ pid?: number }>(lock);
  if (held?.pid === process.pid) {
    try { rmSync(lock, { force: true }); } catch { /* already gone */ }
  }
}

/** A synchronous wait that burns no CPU (the Stop hook is synchronous). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

// ─── One check, for every pending file ────────────────────────────────────────

interface RoundCtx {
  dir: string;
  projectRoot: string;
  runner: TscRunner;
  now: () => number;
}

/**
 * Check the project once and answer every edit filed before the check started. Called with the
 * lock held. Returns the errors for `self` (the caller's own edit) when its entry was among them.
 */
function runRound(ctx: RoundCtx, timeoutMs: number, self: { sessionId: string; file: string } | null): string | null | undefined {
  const snapshot = listPending(ctx.dir);
  if (snapshot.length === 0) return undefined;
  const ranAt = ctx.now();
  // An integer: child_process rejects a fractional timeout outright (no check would run).
  const run = ctx.runner(ctx.projectRoot, Math.max(1000, Math.min(TSC_TIMEOUT_MS, Math.floor(timeoutMs))));
  const nowMs = ctx.now();
  if (run.timedOut) {
    // No answer: every edit stays pending for a check that can finish. The cut-off time is a
    // floor on what this project's check takes, so the next one is planned with it; a check
    // that ran into the full cap marks the project so nobody retries it for a while.
    const meta = readMeta(ctx.dir);
    const hitCap = run.ms >= TSC_TIMEOUT_MS - 1000;
    writeMeta(ctx.dir, { ...meta, lastMs: Math.max(run.ms, meta.lastMs ?? 0), ...(hitCap ? { capHitAt: nowMs } : {}) });
    return undefined;
  }
  writeMeta(ctx.dir, { tsconfig: readMeta(ctx.dir).tsconfig, lastMs: run.ms });
  const selfFile = self ? resolve(self.file) : null;
  let own: string | null | undefined;
  const answered = new Set<string>();
  for (const p of snapshot) {
    const errors = filterTscErrors(run.output, p.file, ctx.projectRoot);
    const key = `${p.sessionId}\0${p.file}`;
    if (self && p.sessionId === self.sessionId && p.file === selfFile) {
      own = errors;
    } else if (!answered.has(key)) {
      writeResult(ctx.dir, p.sessionId, p.file, errors, ranAt);
    }
    answered.add(key);
    try { rmSync(join(ctx.dir, 'pending', p.name), { force: true }); } catch { /* gone */ }
  }
  sweepOld(ctx.dir, nowMs);
  return own;
}

/** Drop entries a session never collected (it ended, or crashed) once they are a day old. */
function sweepOld(dir: string, nowMs: number): void {
  try {
    for (const sub of readdirSync(join(dir, 'results'))) {
      const sdir = join(dir, 'results', sub);
      for (const name of readdirSync(sdir)) {
        const p = join(sdir, name);
        if (nowMs - statSync(p).mtimeMs > ENTRY_MAX_AGE_MS) rmSync(p, { force: true });
      }
    }
    for (const name of readdirSync(join(dir, 'pending'))) {
      const p = join(dir, 'pending', name);
      if (nowMs - statSync(p).mtimeMs > ENTRY_MAX_AGE_MS) rmSync(p, { force: true });
    }
  } catch { /* best-effort */ }
}

// ─── The two entry points ─────────────────────────────────────────────────────

/**
 * PostToolUse on a JS/TS file. Returns the messages to print now: the errors in the edited file
 * when this hook ran the check, plus any errors other hooks' checks found in this session's
 * earlier edits. A slow project, or a check another hook is already running, returns at once
 * and the answer follows (next PostToolUse, or Stop).
 */
export function checkEditedFile(tsconfigPath: string, filePath: string, opts: TscCheckOpts): string[] {
  const now = opts.now ?? Date.now;
  const runner = opts.runner ?? defaultTscRunner;
  const budget = opts.budgetMs ?? EDIT_BUDGET_MS;
  if (!ensureSafeBaseDir(opts.baseDir)) {
    // No trustworthy shared state: check this edit on its own, exactly as before.
    const projectRoot = dirname(resolve(tsconfigPath));
    const errors = filterTscErrors(runner(projectRoot, TSC_TIMEOUT_MS).output, filePath, projectRoot);
    return errors ? [errors] : [];
  }
  const dir = tscStateDir(tsconfigPath, opts.baseDir);
  const started = opts.startedAt ?? now();
  ensureDir(dir, tsconfigPath);
  if (overCap(readMeta(dir), now())) {
    // This project's check does not finish within the cap: as before, no answer for this edit.
    return takeTscResults(opts.sessionId, { baseDir: opts.baseDir });
  }
  addPending(dir, opts.sessionId, filePath, now());

  const lastMs = readMeta(dir).lastMs ?? 0;
  const deferToStop = lastMs > SLOW_TSC_MS && (opts.stopBudgetMs ?? Infinity) >= lastMs + 2000;
  let own: string | null | undefined;
  if (!deferToStop) {
    const ctx: RoundCtx = { dir, projectRoot: dirname(resolve(tsconfigPath)), runner, now };
    const self = { sessionId: opts.sessionId, file: filePath };
    // One check, plus at most one more for edits that landed while it ran. The lock is tried a
    // second time after release, so an edit filed in that gap is not left waiting for nobody.
    let rounds = 0;
    for (let attempt = 0; attempt < 2 && rounds < 2; attempt++) {
      if (!acquire(dir, now())) break;
      try {
        while (rounds < 2 && listPending(dir).length > 0) {
          const left = budget - (now() - started);
          if (rounds > 0 && left < (readMeta(dir).lastMs ?? 0)) break;
          const r = runRound(ctx, left, self);
          if (r !== undefined) own = r;
          rounds++;
        }
      } finally {
        release(dir);
      }
      if (listPending(dir).length === 0) break;
    }
  }

  const messages = takeTscResults(opts.sessionId, { baseDir: opts.baseDir, skipFile: own !== undefined ? filePath : undefined });
  if (own) messages.unshift(own);
  return messages;
}

/**
 * Stop: check this session's edits nobody has checked yet (a slow project's whole turn, or an
 * edit filed after the last check), waiting for a check already running, then hand back every
 * error found in the session's files.
 */
export function checkAtStop(sessionId: string, opts: Omit<TscCheckOpts, 'sessionId' | 'stopBudgetMs'> = {}): string[] {
  const now = opts.now ?? Date.now;
  const runner = opts.runner ?? defaultTscRunner;
  const deadline = (opts.startedAt ?? now()) + (opts.budgetMs ?? STOP_BUDGET_MS);
  for (const dir of stateDirs(opts.baseDir)) {
    const mine = () => listPending(dir).some((p) => p.sessionId === sessionId);
    if (!mine()) continue;
    const tsconfig = readMeta(dir).tsconfig;
    if (!tsconfig || !existsSync(tsconfig) || overCap(readMeta(dir), now())) continue;
    const ctx: RoundCtx = { dir, projectRoot: dirname(tsconfig), runner, now };
    // Only what fits before the hook's own timeout: a check cut off by Claude Code answers
    // nobody, and its edits stay pending for the next hook to answer.
    const fits = () => deadline - now() >= (readMeta(dir).lastMs ?? 0) + 500;
    while (fits()) {
      if (acquire(dir, now())) {
        try {
          if (mine() && fits()) runRound(ctx, deadline - now(), null);
        } finally {
          release(dir);
        }
        break;
      }
      // Another hook is checking: its answer covers this session's files when it filed them first.
      sleepMs(100);
      if (!mine()) break;
    }
  }
  return takeTscResults(sessionId, { baseDir: opts.baseDir });
}

/** Cheap: does this session have an edit nobody checked yet, or an answer waiting? (Stop asks first.) */
export function tscWorkFor(sessionId: string, baseDir?: string): boolean {
  for (const dir of stateDirs(baseDir)) {
    if (listPending(dir).some((p) => p.sessionId === sessionId)) return true;
    try {
      if (readdirSync(join(dir, 'results', safeSession(sessionId))).some((n) => n.endsWith('.json'))) return true;
    } catch { /* none */ }
  }
  return false;
}

/** The Stop hook's `reason` when the session's files have type errors. */
export function tscStopReason(messages: readonly string[]): string {
  return [
    'Type-check of the files you edited this turn found errors. Fix them, or say why they are expected:',
    '',
    ...messages,
  ].join('\n');
}
