import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus, homedir, loadavg, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { acquireFileLock, acquireFileLockWithin, releaseFileLock } from './file-lock.js';

/**
 * The pieces behind `dreamcontext builder …`: what a headless `claude -p` builder and the
 * orchestrator that spawned it need so builders stop choking one machine and stop ending
 * their run with a check still in flight.
 *
 * Paid for on 2026-10-04: three builders each ran the full suite and both type-checks at
 * once (load average 50-107 on 8 cores, an integration suite that is green on a quiet
 * machine went red on 29 timeouts). Two of them hit the Bash tool's 600 s ceiling, the tool
 * moved the command to the background, and the builder ended its turn "waiting": in
 * `claude -p` the process exits with the turn, so it looked hung for 39 minutes and closed
 * with no report, leaving the type-checker running as an orphan.
 *
 * Everything here is pure or takes its world as an argument, so the tests never touch a real
 * process table, lock or load average.
 */

/**
 * Set on every builder's `claude -p`: Claude Code then never backgrounds a command, neither
 * on request (`run_in_background`) nor when it hits its timeout. A slow check is killed and
 * reported as timed out, which the builder can see and act on, instead of being moved out of
 * a session that is about to exit. Verified against claude 2.1.285: same 5 s timeout, with the
 * variable "Exit code 143 / Command timed out after 5s", without it "moved to the background".
 */
export const BUILDER_NO_BACKGROUND_ENV = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1';

// ─── load ────────────────────────────────────────────────────────────────────

export interface MachineLoad {
  cores: number;
  load1: number;
  /** The 1-minute load average is above the core count. */
  busy: boolean;
}

/** Read from Node, not `uptime`: no locale (a Turkish `3,41` parsed as `3`), no `nproc`. */
export function machineLoad(read: { loadavg: () => number[]; cores: () => number } = {
  loadavg, cores: () => cpus().length,
}): MachineLoad {
  const cores = Math.max(1, read.cores());
  const load1 = read.loadavg()[0] ?? 0;
  return { cores, load1, busy: load1 > cores };
}

export function formatLoad(l: MachineLoad): string {
  return `cores ${l.cores} load1 ${l.load1.toFixed(2)} ${l.busy ? 'busy' : 'quiet'}`;
}

// ─── orphans ─────────────────────────────────────────────────────────────────

export interface OrphanCheck { pid: number; etime: string; command: string }

/** The checkers a builder runs. A dev server or a watcher the owner started is never one. */
const CHECK_TOOL = /(?:^|[/\s])(?:tsc|vitest|jest)(?:\s|$)/;

/**
 * Type-checkers and test runners of THIS repo whose parent is gone (re-parented to pid 1):
 * what a builder's auto-backgrounded check leaves behind when its session exits. Parses
 * `ps -A -o pid=,ppid=,etime=,command=`. A check with a live parent (a terminal, a running
 * builder, another session) is never listed. On Linux with a sub-reaper an orphan may be
 * re-parented elsewhere and is then simply not found.
 */
export function findOrphanChecks(psText: string, repoRoot: string): OrphanCheck[] {
  const root = resolve(repoRoot).replace(/\/+$/, '');
  const out: OrphanCheck[] = [];
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, etime, command] = m;
    if (ppid !== '1') continue;
    if (!command.includes(`${root}/`) || !command.includes('node_modules')) continue;
    if (!CHECK_TOOL.test(command)) continue;
    out.push({ pid: Number(pid), etime, command: command.trim() });
  }
  return out;
}

/** The working tree's top level (a linked worktree's own root), or the cwd outside git. */
export function repoToplevel(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
  } catch {
    return cwd;
  }
}

export function listProcesses(): string {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,command='], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
}

// ─── heavy lock ──────────────────────────────────────────────────────────────

/** `builder heavy`'s exit code when the lock stayed busy and nothing ran (EX_TEMPFAIL). */
export const HEAVY_LOCK_BUSY_EXIT = 75;
/** Long enough to sit behind one or two type-checks, short of the Bash tool's 600 s cap. */
export const HEAVY_DEFAULT_WAIT_S = 300;

/**
 * One heavy check at a time per repo, shared by every builder and the orchestrator. Lives in
 * the git common dir, so linked worktrees of one repo share it; outside git, a per-path file
 * in the OS temp dir.
 */
export function heavyLockPath(cwd: string, gitCommonDir: () => string | null = () => gitCommonDirOf(cwd)): string {
  const common = gitCommonDir();
  if (common) return join(isAbsolute(common) ? common : resolve(cwd, common), 'dc-heavy.lock');
  const key = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  return join(tmpdir(), `dc-heavy-${key}.lock`);
}

// ─── machine-wide heavy slots (orchestration plan r5 D12) ─────────────────────────────────

/** At most this many heavy checks run at once on the WHOLE machine, every repo together (O5). */
export const HEAVY_MACHINE_SLOTS = 2;
/** A slot (or repo lock) past this age whose pid is gone is reclaimed; a live holder never is. */
export const HEAVY_LOCK_STALE_MS = 5_000;

/** Where the machine's slot files live: `~/.dreamcontext/heavy/slot-<n>.lock`. */
export function heavySlotDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'heavy');
}

export function heavySlotPaths(dir: string): string[] {
  return Array.from({ length: HEAVY_MACHINE_SLOTS }, (_, i) => join(dir, `slot-${i}.lock`));
}

/** How many slots a LIVE process holds right now (a dead holder's file does not count). */
export function heavySlotsHeld(dir: string): number {
  let n = 0;
  for (const p of heavySlotPaths(dir)) {
    try {
      const { pid } = JSON.parse(readFileSync(p, 'utf-8')) as { pid?: unknown };
      if (typeof pid !== 'number') { n += 1; continue; }
      try { process.kill(pid, 0); n += 1; } catch (err) { if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') n += 1; }
    } catch { /* no file: free */ }
  }
  return n;
}

export interface HeavyHold {
  /** The machine slot taken (a path under {@link heavySlotDir}). */
  slot: string;
  /** Release the slot, then the repo lock (the reverse of the order they were taken). */
  release: () => void;
}

/** While waiting for a slot, the heat limit is read again at most this often. */
export const HEAT_RECHECK_MS = 20_000;

/**
 * Take this repo's heavy lock, THEN one of the machine's slots, all within `waitMs` together.
 * Always in that order and released in reverse, so two callers never hold each other's half (no
 * deadlock). Slots are tried in a loop, each once per poll, with pid liveness (that is what makes
 * the short stale age safe). Null = nothing is held and nothing may run (the caller's exit 75).
 *
 * How many slots may be busy at once is `limit()` (default: the heat limit, `./heat.ts`: 1 while
 * macOS says very hot, else {@link HEAVY_MACHINE_SLOTS}), read at entry and at most every
 * {@link HEAT_RECHECK_MS} while waiting. A slot is taken only while fewer than L are held, and
 * only among slots [0, L). A held slot is never revoked. Accepted race: a caller that read L=2 up
 * to 20 s earlier can take slot-1 while another runs on slot-0 under L=1; the next read converges.
 */
export async function acquireHeavy(cwd: string, opts: {
  waitMs: number; slotDir: string; pollMs?: number; now?: () => number; repoLock?: string;
  limit?: () => Promise<number>;
  /** Every limit read (after clamping), so the caller can name the heat when the wait runs out. */
  onLimit?: (n: number) => void;
  /** Called once the repo lock is taken (the wait that runs out after it was the slots'). */
  onRepoLock?: () => void;
}): Promise<HeavyHold | null> {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = now() + Math.max(0, opts.waitMs);
  const repoLock = opts.repoLock ?? heavyLockPath(cwd);
  const limitOf = opts.limit ?? (async () => (await import('./heat.js')).currentHeavyLimit());
  const readLimit = async (): Promise<number> => {
    let n: number;
    try { n = clampHeavyLimit(await limitOf()); } catch { n = HEAVY_MACHINE_SLOTS; }
    try { opts.onLimit?.(n); } catch { /* informational */ }
    return n;
  };
  let limit = await readLimit();
  let readAt = now();
  const held = await acquireFileLockWithin(repoLock, { waitMs: Math.max(0, deadline - now()), staleMs: HEAVY_LOCK_STALE_MS, pollMs, now, verifyPidLiveness: true });
  if (!held) return null;
  try { opts.onRepoLock?.(); } catch { /* informational */ }
  for (;;) {
    if (now() - readAt >= HEAT_RECHECK_MS) { limit = await readLimit(); readAt = now(); }
    if (heavySlotsHeld(opts.slotDir) < limit) {
      for (const slot of heavySlotPaths(opts.slotDir).slice(0, limit)) {
        if (acquireFileLock(slot, now(), HEAVY_LOCK_STALE_MS, { verifyPidLiveness: true })) {
          return { slot, release: () => { releaseFileLock(slot); releaseFileLock(repoLock); } };
        }
      }
    }
    if (now() >= deadline) { releaseFileLock(repoLock); return null; }
    await new Promise((r) => { setTimeout(r, pollMs); });
  }
}

/** A limit the lock may use: an integer in [1, HEAVY_MACHINE_SLOTS]; junk reads as the default. */
export function clampHeavyLimit(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return HEAVY_MACHINE_SLOTS;
  return Math.min(HEAVY_MACHINE_SLOTS, Math.max(1, Math.floor(n)));
}

function gitCommonDirOf(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * How the command is spawned: argv as given, or — when a single argument holds the whole
 * line (`builder heavy -- "npx tsc --noEmit"`) — through the shell.
 */
export function heavySpawnPlan(argv: string[]): { file: string; args: string[]; shell: boolean } | null {
  if (argv.length === 0 || !argv[0]) return null;
  if (argv.length === 1 && /\s/.test(argv[0])) return { file: argv[0], args: [], shell: true };
  return { file: argv[0], args: argv.slice(1), shell: false };
}

// ─── report sentinel ─────────────────────────────────────────────────────────

export type BuilderReportVerdict = 'reported' | 'unfinished' | 'stopped' | 'missing';

export interface BuilderReport {
  verdict: BuilderReportVerdict;
  /** One line for the orchestrator: the run's own subtype or the line that decided it. */
  detail: string;
}

export const TASK_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;

/** The last line of a run that ended on a promise instead of a result. */
const UNFINISHED = /\b(?:waiting (?:for|on)|still running|(?:is|are) (?:still )?running|i'?ll (?:pick (?:it )?up|continue|report|check back)|will (?:report|continue|pick up) (?:back )?(?:when|once)|once (?:it|they|that|these) (?:finish|complete|report)|moved to the background)/i;

/**
 * The run's result object out of a `claude -p --output-format json` file. The file may hold
 * one object (goal-skill's `> Tn-r1.json`) or a log a Develop builder appends to across
 * resumes, with stderr mixed in: the LAST result object wins.
 */
export function lastResultObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const whole = JSON.parse(trimmed) as unknown;
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) return whole as Record<string, unknown>;
  } catch { /* not one object: scan the lines */ }
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (o && typeof o === 'object' && (o as { type?: unknown }).type === 'result') return o as Record<string, unknown>;
    } catch { /* a stderr line that happens to start with { */ }
  }
  return null;
}

const oneLine = (s: string, max = 160) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Did this builder finish? `reported`: the final message opens with `## <TaskId> report` and
 * does not end on a promise. `unfinished`: the run ended cleanly without that (it ended its
 * turn with a check in flight, or never wrote the report). `stopped`: the run itself errored
 * (usage limit, max turns, API error). `missing`: no result yet (still running, or it crashed
 * before writing one).
 */
export function classifyBuilderResult(fileText: string | null, taskId: string): BuilderReport {
  const run = fileText == null ? null : lastResultObject(fileText);
  if (!run) return { verdict: 'missing', detail: 'no result object (still running, or it crashed before writing one)' };
  const subtype = typeof run.subtype === 'string' ? run.subtype : 'unknown';
  const result = typeof run.result === 'string' ? run.result : '';
  if (run.is_error === true || subtype !== 'success') {
    return { verdict: 'stopped', detail: `${subtype}${result ? `: ${oneLine(result)}` : ''}` };
  }
  const lines = result.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  const last = lines[lines.length - 1] ?? '';
  const id = taskId.replace(/[.]/g, '\\.');
  const sentinel = new RegExp(`^#{2}\\s+${id}\\s+report\\b`, 'i');
  if (!sentinel.test(first)) return { verdict: 'unfinished', detail: oneLine(last || '(empty final message)') };
  if (UNFINISHED.test(last)) return { verdict: 'unfinished', detail: oneLine(last) };
  return { verdict: 'reported', detail: oneLine(first) };
}
