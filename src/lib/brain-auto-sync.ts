import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readBrainLocal, readSetupConfig } from './setup-config.js';
import { resolveBrainSyncEnabled, resolveMode } from './git-sync/brain-repo.js';
import { currentBranch, revListCount, statusPorcelainTracked } from './git-sync/git.js';
import { closeInboxRows, raiseInboxRow } from './owner-inbox.js';
import { readLocalJson, updateLocalJson } from './local-store.js';
import { listVaults, type Vault } from './vaults.js';

/**
 * A brain whose sleep does not come still reaches the team (owner 2026-11-13): `sleep done` is
 * the only full sync (fetch, merge, push), so a project that does not sleep for days leaves the
 * other machines stale. The desktop server checks every registered project; one whose last full
 * sync on THIS machine (`lastFullSyncAt`, stamped by the engine) is 24 hours old runs the plain
 * `brain sync --strict` in the background.
 *
 * Each rule on its own:
 * - only when this machine has something to send (owner 2026-11-13): an uncommitted change or a
 *   commit the remote does not have. Nothing to send = skipped quietly, checked again later; no
 *   size threshold, any real change is enough. Team changes still arrive by the session-start pull;
 * - only a project with cloud sync on, mode `full-repo` and `autoSync`, the same gate the
 *   session-start pull uses; `DREAMCONTEXT_BRAIN_SYNC=0` turns it off (the job's gate);
 * - never while an agent works there (a chat or child mid-turn, a sleep, a half-done git
 *   operation): a half-written edit is never committed; the next check tries again;
 * - `--strict --headless`: nobody watches, so a WARN-tier scrub hit stops it too and a team merge
 *   that needs /dream-sync is backed out to a clean tree (pending, `--resume` redoes it), as in the
 *   headless pull: the owner's repo is never left mid-merge;
 * - a stop only the owner settles (a prose conflict, a scrub block, a code conflict, a held
 *   push) is never forced and never retried in a loop: it waits a day, and the owner is told
 *   ONCE in his Waiting on you list with the one step to finish; the row closes by itself once
 *   any sync of that project lands (his `/dream-sync`, a sleep, the button);
 * - a failure (network, auth) waits an hour; nothing here ever throws.
 */

export const AUTO_SYNC_AFTER_MS = 24 * 60 * 60_000;
/** A stop the owner settles is tried again after this (never in a loop). */
export const PAUSED_RETRY_MS = 24 * 60 * 60_000;
/** A failure (network, auth, a skipped check) is tried again after this. */
export const FAILED_RETRY_MS = 60 * 60_000;
const SYNC_TIMEOUT_MS = 10 * 60_000;

export const BRAIN_SYNC_INBOX_KIND = 'brain-sync-paused';
const RECORD = 'brain-auto-sync.json';

/** Why the background sync stopped. Each one has its own line in the owner's language. */
export type PauseReason = 'conflict' | 'code-conflict' | 'scrub' | 'held' | 'failed';

interface Pause {
  reason: PauseReason;
  /** The sync's own action word (`awaiting-agent`, `blocked-scrub`, `error`, …). */
  action: string;
  note: string | null;
  at: number;
  /** The owner was told about THIS reason (a row raised). Never raised twice for one reason. */
  told: boolean;
}

interface AutoSyncRecord {
  pause?: Pause;
}

/** What `brain sync --json` prints. */
export interface AutoSyncOutcome {
  action: string;
  note: string | null;
}

export interface BrainAutoSyncDeps {
  home?: string;
  now?: () => number;
  vaults?: () => Vault[];
  /** Cloud sync on, `full-repo`, `autoSync`: the project syncs at all. */
  eligible?: (projectRoot: string) => boolean;
  /** This machine has a change to send (uncommitted, or a commit the remote lacks). */
  hasLocalChanges?: (projectRoot: string) => boolean;
  /** Why this project must wait now (an agent works there), or null when it is free. */
  busy?: (projectRoot: string, name: string) => string | null;
  runSync?: (projectRoot: string) => Promise<AutoSyncOutcome>;
  /** The job is stopping: end after the project in hand. */
  stopped?: () => boolean;
}

export interface BrainAutoSyncResult {
  synced: string[];
  waiting: string[];
  paused: string[];
}

/** The plain `brain sync` result words, sorted into what the job does with them. */
export function classifyOutcome(out: AutoSyncOutcome): 'synced' | 'again' | PauseReason {
  switch (out.action) {
    case 'pushed':
      return 'synced';
    // A noop with a note is a skipped check ("could not check …, retried at the next sync").
    case 'noop':
      return out.note ? 'failed' : 'synced';
    // Another sync holds the lock, or cloud sync was just turned off: nothing to tell.
    case 'locked':
    case 'disabled':
      return 'again';
    case 'awaiting-agent':
    case 'already-awaiting-agent':
      return 'conflict';
    case 'code-conflict':
    case 'user-merge-in-progress':
      return 'code-conflict';
    case 'blocked-scrub':
      return 'scrub';
    case 'error':
      // GitHub refusing a file over 100 MB, or a remote still ahead after a merge and a retry: only
      // the owner settles these, so they wait a day like any other stop.
      return /Push refused by GitHub|non-fast-forward\) twice/.test(out.note ?? '') ? 'held' : 'failed';
    default:
      // app-data-held, session-files-held, detached-head, no-remote, …: the note says what.
      return 'held';
  }
}

/** The row's title (the AI Team page shows it as is; the agenda draws its own line from `detail`). */
const TITLES: Record<PauseReason, string> = {
  conflict: 'Brain sync is paused: a teammate changed the same part of a note as you. Run /dream-sync in this project to finish it.',
  'code-conflict': 'Brain sync is paused: a code file conflicts with a teammate\'s change. Finish the merge in your editor, then run brain sync.',
  scrub: 'Brain sync is paused: something that looks like a key or password would be shared. Open the project and run brain sync to see it.',
  held: 'Brain sync is paused and needs you. Open the project and run brain sync to see why.',
  failed: 'Brain sync has not reached GitHub for a day. Open the project and run brain sync to see why.',
};

function retryAfter(reason: PauseReason): number {
  return reason === 'failed' ? FAILED_RETRY_MS : PAUSED_RETRY_MS;
}

/** Is cloud sync on for this project in the mode that pushes, with `autoSync`? Never throws. */
export function autoSyncEligible(projectRoot: string): boolean {
  try {
    const cfg = readSetupConfig(projectRoot);
    if (!cfg?.brainRepo?.autoSync || resolveMode(cfg) !== 'full-repo') return false;
    return resolveBrainSyncEnabled(projectRoot, cfg).enabled;
  } catch {
    return false;
  }
}

/**
 * Anything to send from here: a changed or new file (ignored ones never show), or a commit ahead of
 * the last fetched `origin/<branch>`. Read from the local repo only, no network.
 */
export function hasLocalChanges(projectRoot: string): boolean {
  if (statusPorcelainTracked(projectRoot).length > 0) return true;
  const branch = currentBranch(projectRoot);
  return !!branch && revListCount(projectRoot, `origin/${branch}..HEAD`) > 0;
}

/** What the job runs, after the CLI entry. A test checks every flag against the real `brain sync`. */
export const AUTO_SYNC_ARGS: readonly string[] = ['brain', 'sync', '--strict', '--headless', '--json'];

/** `brain sync --strict --headless --json` through this process's node (Finder-launched PATH safe). */
export function defaultRunSync(cliEntry: string): (projectRoot: string) => Promise<AutoSyncOutcome> {
  return (projectRoot) => new Promise((done) => {
    execFile(
      process.execPath,
      [cliEntry, ...AUTO_SYNC_ARGS],
      {
        cwd: projectRoot,
        timeout: SYNC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, DREAMCONTEXT_SETUP_INTERNAL: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      },
      (err, stdout) => {
        const parsed = parseOutcome(String(stdout ?? ''));
        if (parsed) { done(parsed); return; }
        done({ action: 'error', note: err?.message ?? 'brain sync printed no result' });
      },
    );
  });
}

/** The last JSON line `brain sync --json` printed, or null. */
export function parseOutcome(stdout: string): AutoSyncOutcome | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]) as { action?: unknown; note?: unknown };
      if (typeof v.action === 'string') return { action: v.action, note: typeof v.note === 'string' ? v.note : null };
    } catch { /* not ours */ }
  }
  return null;
}

let inFlight: Promise<BrainAutoSyncResult> | null = null;

/** Test-only. */
export function __resetBrainAutoSync(): void {
  inFlight = null;
}

/** One check over every registered project. One at a time per process; never throws. */
export function runBrainAutoSync(deps: BrainAutoSyncDeps): Promise<BrainAutoSyncResult> {
  if (inFlight) return inFlight;
  const promise = check(deps).finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

async function check(deps: BrainAutoSyncDeps): Promise<BrainAutoSyncResult> {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const eligible = deps.eligible ?? autoSyncEligible;
  const result: BrainAutoSyncResult = { synced: [], waiting: [], paused: [] };
  const seen = new Set<string>();
  let vaults: Vault[] = [];
  try { vaults = (deps.vaults ?? listVaults)(); } catch { return result; }
  for (const v of vaults) {
    if (deps.stopped?.()) break;
    const root = resolve(v.path);
    if (seen.has(root) || !existsSync(root)) continue;
    seen.add(root);
    try {
      await checkProject(root, v.name, deps, home, now, eligible, result);
    } catch {
      /* one project's trouble never stops the next */
    }
  }
  return result;
}

async function checkProject(
  root: string,
  name: string,
  deps: BrainAutoSyncDeps,
  home: string,
  now: () => number,
  eligible: (projectRoot: string) => boolean,
  result: BrainAutoSyncResult,
): Promise<void> {
  if (!eligible(root)) {
    // Cloud sync turned off, or the mode changed: a stop it told about is no longer his to settle.
    if (readLocalJson<AutoSyncRecord>(root, RECORD, {}, home).pause) endPause(root, home);
    return;
  }
  const last = readBrainLocal(root).lastFullSyncAt ?? 0;
  let pause = readLocalJson<AutoSyncRecord>(root, RECORD, {}, home).pause;
  // Any sync that landed since the stop (his /dream-sync, a sleep, the button) ended it.
  if (pause && last > pause.at) {
    endPause(root, home);
    pause = undefined;
  }
  if (now() - last < AUTO_SYNC_AFTER_MS) return;
  if (pause && now() - pause.at < retryAfter(pause.reason)) return;
  // Nothing of this machine's to send: skipped quietly, the next check looks again.
  if (!(deps.hasLocalChanges ?? hasLocalChanges)(root)) return;
  const wait = deps.busy?.(root, name) ?? null;
  if (wait) {
    result.waiting.push(name);
    return;
  }
  if (!deps.runSync) return;
  const out = await deps.runSync(root);
  const kind = classifyOutcome(out);
  if (kind === 'again') return;
  if (kind === 'synced') {
    endPause(root, home);
    result.synced.push(name);
    return;
  }
  const told = !!pause?.told && pause.reason === kind;
  const next: Pause = { reason: kind, action: out.action, note: out.note, at: now(), told: true };
  updateLocalJson<AutoSyncRecord>(root, RECORD, {}, () => ({ pause: next }), home);
  if (!told) {
    // A new reason replaces the old row; the same reason is never raised twice.
    closeInboxRows(root, (r) => r.kind === BRAIN_SYNC_INBOX_KIND, home);
    raiseInboxRow(root, {
      kind: BRAIN_SYNC_INBOX_KIND,
      ref: kind,
      agent: null,
      title: TITLES[kind],
      detail: JSON.stringify({ reason: kind, note: out.note }),
      actions: ['dismiss'],
      dedupeKey: BRAIN_SYNC_INBOX_KIND,
    }, home, new Date(now()));
  }
  result.paused.push(name);
}

function endPause(root: string, home: string): void {
  if (readLocalJson<AutoSyncRecord>(root, RECORD, {}, home).pause) {
    updateLocalJson<AutoSyncRecord>(root, RECORD, {}, () => null, home);
  }
  closeInboxRows(root, (r) => r.kind === BRAIN_SYNC_INBOX_KIND, home);
}
