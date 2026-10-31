import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { detectInstalledPlatforms } from './catalog.js';
import { acquireFileLock, reclaimDeadHolderLock, releaseFileLock } from './file-lock.js';
import { inspectSleepLockLive } from './auto-sleep.js';
import { readDreamcontextVersionFromDisk } from './manifest.js';
import { cliPackageVersion } from './npm-target.js';
import { appendSelfUpdateLog, outputTail } from './self-update.js';
import { readSetupConfig } from './setup-config.js';
import { listTranscriptFiles } from './transcript-sessions.js';
import { listVaults, type Vault } from './vaults.js';
import { compareVersions } from './version-check.js';
import { readSleepState } from '../cli/commands/sleep.js';

/**
 * A project's installed files follow the installed CLI on their own (owner 2026-10-31: the
 * "Update all" button goes, no prompts). `setupVersion` in the project is the truth, so a version
 * change is never an event that can be missed: every check compares each project with the CLI on
 * disk, whichever way that CLI arrived and however long the machine was off. A project already
 * current costs one config read and never a process.
 *
 * Each rule on its own:
 * - runs the plain `dreamcontext update --yes`, so whatever `update` protects stays protected;
 * - one run at a time across processes: an O_EXCL lock that `upgrade`'s own fan-out takes too;
 * - a project mid-turn, in a sleep, or in a half-done git operation waits for the next check;
 * - a failure stays in ~/.dreamcontext/project-updates.json and is retried on the next start of
 *   the process, never on every check, and never stops the projects after it;
 * - a folder that is gone is nobody's error: the launcher already shows it red.
 */

export type ProjectIssueState = 'failed' | 'deferred' | 'skipped';

/** A project still behind, and why. A project that is current has no entry. */
export interface ProjectIssue {
  name: string;
  state: ProjectIssueState;
  /** The version this run aimed at. */
  target: string;
  reason: string;
  at: number;
}

export interface ProjectUpdatesRecord {
  at: number;
  target: string;
  /** Keyed by resolved project path. */
  issues: Record<string, ProjectIssue>;
}

export interface CatchUpResult {
  /** Whether a run held the lock (false: nothing due, or someone else is running). */
  ran: boolean;
  target: string | null;
  updated: string[];
  failed: string[];
  deferred: string[];
  skipped: string[];
  message: string;
}

export interface CatchUpCli {
  /** The CLI entry `update` runs with. */
  entry: string;
  /** That install's version, read from disk now. */
  version: string;
}

export interface CatchUpDeps {
  home?: string;
  now?: () => number;
  vaults?: () => Vault[];
  /** The CLI to bring projects up to, or null when it cannot be read. */
  cli?: () => CatchUpCli | null;
  /** Why this project must wait now, or null when it is free. */
  busy?: (projectRoot: string, name: string) => string | null;
  /** An upgrade is changing the CLI right now: stand back, it brings the new version here. */
  blocked?: () => boolean;
  /** Run `update --yes` in the project; rejects when it fails. */
  runUpdate?: (projectRoot: string, cli: CatchUpCli) => Promise<void>;
  /** The job is stopping: end after the project in hand. */
  stopped?: () => boolean;
}

const UPDATE_TIMEOUT_MS = 5 * 60_000;
/** A live holder is never broken (verifyPidLiveness); this only times out a garbage lock. */
const LOCK_STALE_MS = 20 * 60_000;
/** A transcript touched this recently is a turn in progress. An idle open session is not busy:
 *  it holds nothing half-written, and picks the new files up on its next read. */
export const SESSION_QUIET_MS = 3 * 60_000;
/** A transcript stays silent through a long tool or sub-agent, so a tool call with no result is
 *  still a turn in progress, up to this bound (a crashed session must not hold a project). */
export const OPEN_TOOL_MAX_MS = 60 * 60_000;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

// ─── Paths + record ─────────────────────────────────────────────────────────────

export function projectUpdatesStatePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'project-updates.json');
}

export function projectUpdatesLockPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'project-updates.lock');
}

/** Take the one-run lock, breaking one left by a dead process. False while a live holder has it. */
export function acquireProjectUpdatesLock(home: string = homedir(), now: number = Date.now()): boolean {
  const lock = projectUpdatesLockPath(home);
  reclaimDeadHolderLock(lock);
  return acquireFileLock(lock, now, LOCK_STALE_MS, { verifyPidLiveness: true });
}

export function releaseProjectUpdatesLock(home: string = homedir()): void {
  releaseFileLock(projectUpdatesLockPath(home));
}

export function readProjectUpdatesRecord(home: string = homedir()): ProjectUpdatesRecord | null {
  try {
    const raw = JSON.parse(readFileSync(projectUpdatesStatePath(home), 'utf-8')) as Partial<ProjectUpdatesRecord>;
    if (!raw || typeof raw !== 'object' || !raw.issues || typeof raw.issues !== 'object') return null;
    return { at: Number(raw.at) || 0, target: String(raw.target ?? ''), issues: raw.issues };
  } catch {
    return null;
  }
}

/** tmp + rename so the launcher never reads half a file. Never throws. */
function writeRecord(home: string, record: ProjectUpdatesRecord): void {
  const path = projectUpdatesStatePath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
    renameSync(tmp, path);
  } catch {
    /* unwritable home: the next check works it out again */
  }
}

// ─── What makes a project wait ──────────────────────────────────────────────────

/** The git dir of `root`, following a worktree's `gitdir:` file. Null when it is not a repo. */
function gitDirOf(root: string): string | null {
  const dotGit = join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf-8'));
    if (!m) return null;
    return isAbsolute(m[1].trim()) ? m[1].trim() : resolve(root, m[1].trim());
  } catch {
    return null;
  }
}

const GIT_OPERATIONS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

/**
 * Is a merge, rebase, cherry-pick or revert half done in this repo? A plain dirty tree is NOT a
 * reason to wait: `update` writes only its own paths and never stages or commits, and its own
 * last refresh is what usually makes a brain read dirty, so waiting for clean would wait forever.
 */
export function gitOperationInProgress(root: string): boolean {
  const gitDir = gitDirOf(root);
  return gitDir !== null && GIT_OPERATIONS.some((f) => existsSync(join(gitDir, f)));
}

/** Does this transcript's tail hold a tool call with no result yet? */
export function transcriptHasOpenTool(path: string): boolean {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf-8').split('\n');
    if (length < size) lines.shift(); // the first line is cut
    const open = new Set<string>();
    for (const line of lines) {
      if (!line.includes('"tool_')) continue;
      let content: unknown;
      try {
        content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
      } catch {
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const c of content as { type?: string; id?: string; tool_use_id?: string }[]) {
        if (c?.type === 'tool_use' && c.id) open.add(c.id);
        if (c?.type === 'tool_result' && c.tool_use_id) open.delete(c.tool_use_id);
      }
    }
    return open.size > 0;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Why the project must wait, from what the disk shows. A failed probe reads as free. */
export function diskBusyReason(projectRoot: string, now: number, home: string = homedir()): string | null {
  const context = join(projectRoot, '_dream_context');
  try {
    const sleep = inspectSleepLockLive(context, readSleepState(context), now);
    if (sleep.locked && !sleep.stale) return 'a sleep is running';
  } catch { /* no sleep state */ }
  try {
    const recent = listTranscriptFiles(projectRoot, home).files.filter((f) => now - f.mtimeMs < OPEN_TOOL_MAX_MS);
    if (recent.some((f) => now - f.mtimeMs < SESSION_QUIET_MS || transcriptHasOpenTool(f.path))) {
      return 'an agent session is working';
    }
  } catch { /* no transcripts */ }
  if (gitOperationInProgress(projectRoot) || gitOperationInProgress(context)) return 'a git operation is in progress';
  return null;
}

// ─── Defaults ───────────────────────────────────────────────────────────────────

/**
 * A CLI that is a dev build: a checkout or worktree (`.git` beside its package), a Tauri build's
 * copy (`src-tauri/target`, debug or release), or npm's npx cache. Its version is whatever that
 * branch says, and stamping it on real projects skips the real release's migrations for good.
 */
export function devOrCachedCli(entry: string): boolean {
  let dir = dirname(entry);
  try { dir = dirname(realpathSync(entry)); } catch { /* judged as written */ }
  if (/[/\\](_npx|src-tauri[/\\]target)[/\\]/.test(`${dir}/`)) return true;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, '.git'))) return true;
    if (existsSync(join(dir, 'package.json'))) return false;
    dir = dirname(dir);
  }
  return false;
}

/**
 * The newest CLI this machine has, read from disk NOW and not from this process's memory: the
 * running one, or the global install when that is at least as new. So an `npm i -g` under a
 * running app counts, and the app's bundled copy never pulls projects back to an older global.
 */
export function defaultCatchUpCli(env: NodeJS.ProcessEnv = process.env, argv1: string | undefined = process.argv[1]): CatchUpCli | null {
  const running = env.DREAMCONTEXT_CLI || argv1;
  const global = env.DREAMCONTEXT_GLOBAL_CLI;
  const runningVersion = (running ? cliPackageVersion(running) : null) ?? readDreamcontextVersionFromDisk();
  const globalVersion = global ? cliPackageVersion(global) : null;
  const picked = global && globalVersion && compareVersions(globalVersion, runningVersion) >= 0
    ? { entry: global, version: globalVersion }
    : running ? { entry: running, version: runningVersion } : null;
  // Asked here, on every check: `npm link` under a running app changes what the global points at.
  return picked && !devOrCachedCli(picked.entry) ? picked : null;
}

function defaultRunUpdate(projectRoot: string, cli: CatchUpCli): Promise<void> {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      [cli.entry, 'update', '--yes'],
      {
        cwd: projectRoot,
        timeout: UPDATE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, DREAMCONTEXT_SETUP_INTERNAL: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      },
      (err, stdout, stderr) => {
        if (!err) { done(); return; }
        // The last line is the error; what comes before it is progress.
        const tail = outputTail(`${stdout}\n${stderr}`, 1);
        fail(new Error(tail || err.message));
      },
    );
  });
}

// ─── The run ────────────────────────────────────────────────────────────────────

/** Failures already tried in THIS process: path → target. The retry is the next process start. */
const triedThisStart = new Map<string, string>();
let inFlight: Promise<CatchUpResult> | null = null;

/** Test-only. */
export function __resetProjectCatchUp(): void {
  triedThisStart.clear();
  inFlight = null;
}

/** Bring every registered project up to the CLI on disk. One per process; never throws. */
export function runProjectCatchUp(deps: CatchUpDeps = {}): Promise<CatchUpResult> {
  if (inFlight) return inFlight;
  const promise = catchUp(deps).finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

interface Project { name: string; path: string }

function projectVersion(path: string): string {
  try {
    return readSetupConfig(path)?.setupVersion || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function catchUp(deps: CatchUpDeps): Promise<CatchUpResult> {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const result: CatchUpResult = { ran: false, target: null, updated: [], failed: [], deferred: [], skipped: [], message: '' };
  const end = (message: string): CatchUpResult => { result.message = message; return result; };
  const log = (line: string) => appendSelfUpdateLog(home, `projects: ${line}`, now());

  try {
    const cli = (deps.cli ?? defaultCatchUpCli)();
    if (!cli || cli.version === '0.0.0') return end('The installed version could not be read.');
    const target = cli.version;
    result.target = target;

    // A folder that is gone never enters the list, so it costs nothing and reports nothing.
    const seen = new Set<string>();
    const behind: Project[] = [];
    for (const v of (deps.vaults ?? listVaults)()) {
      const path = resolve(v.path);
      if (seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      if (compareVersions(projectVersion(path), target) < 0) behind.push({ name: v.name, path });
    }

    // An issue lives only while its project is behind: this is what ends a failure a person
    // fixed by hand, a project removed from the list, a folder deleted.
    const prior = readProjectUpdatesRecord(home);
    const issues: Record<string, ProjectIssue> = {};
    for (const p of behind) {
      if (prior?.issues[p.path]) issues[p.path] = prior.issues[p.path];
    }
    const due = behind.filter((p) => triedThisStart.get(p.path) !== target);
    const staleRecord = Object.keys(prior?.issues ?? {}).length !== Object.keys(issues).length;
    if (due.length === 0 && !staleRecord) return end('Nothing to update.');
    if (deps.blocked?.()) return end('An upgrade is running.');

    if (!acquireProjectUpdatesLock(home, now())) return end('Another run is updating projects.');
    try {
      result.ran = true;
      const save = () => writeRecord(home, { at: now(), target, issues });
      const note = (p: Project, state: ProjectIssueState, reason: string) => {
        const before = issues[p.path];
        issues[p.path] = { name: p.name, state, target, reason, at: now() };
        save();
        if (before?.state !== state || before.reason !== reason || before.target !== target) {
          log(`${state}: ${p.name}: ${reason.split('\n')[0]}`);
        }
      };

      if (staleRecord) save();
      const busy = deps.busy ?? ((path: string) => diskBusyReason(path, now(), home));
      const runUpdate = deps.runUpdate ?? defaultRunUpdate;

      for (const p of due) {
        // An `npm i -g` can land mid-run: nothing is started from a package being replaced.
        if (deps.stopped?.() || deps.blocked?.()) break;
        const wait = busy(p.path, p.name);
        if (wait) {
          result.deferred.push(p.name);
          note(p, 'deferred', wait);
          continue;
        }
        // `update` would refuse: nothing a retry could change until someone installs a platform.
        if (detectInstalledPlatforms(p.path).length === 0) {
          triedThisStart.set(p.path, target);
          result.skipped.push(p.name);
          note(p, 'skipped', 'no agent platform is installed in this project');
          continue;
        }

        let error: string | null = null;
        try {
          await runUpdate(p.path, cli);
        } catch (err) {
          error = err instanceof Error ? err.message : 'update failed';
        }
        // `setupVersion` only advances on a clean run, so it is the evidence, not the exit code.
        if (compareVersions(projectVersion(p.path), target) >= 0) {
          delete issues[p.path];
          triedThisStart.delete(p.path);
          result.updated.push(p.name);
          save();
          log(`updated: ${p.name} to ${target}${error ? ` (the run still reported: ${error.split('\n')[0]})` : ''}`);
          continue;
        }
        triedThisStart.set(p.path, target);
        result.failed.push(p.name);
        note(p, 'failed', error ?? `update ran but the project is still behind ${target}: a migration did not finish`);
      }
    } finally {
      releaseProjectUpdatesLock(home);
    }
    return end(`updated ${result.updated.length}, failed ${result.failed.length}, waiting ${result.deferred.length}, skipped ${result.skipped.length}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'project catch-up failed';
    log(`error: ${message}`);
    return end(message);
  }
}
