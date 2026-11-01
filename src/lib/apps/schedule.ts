/**
 * App schedules without an agent (dreamcontext-apps plan r19, W3): a manifest's
 * `schedules: [{id, schedule, call: {method, path, body?}, notify?, catchupHours?}]` fires the
 * app's own backend route on time. No Claude, no usage limit.
 *
 * `tickApps` runs FIRST inside the automations tick, in its own try/catch (the agent runs that
 * follow are sequential and slow). It only reads the registry and the manifests, advances the
 * watermark BEFORE dispatching (at-most-once: a POST that is not idempotent never runs twice),
 * and dispatches `dreamcontext apps run-schedule <slug> <id>` DETACHED, never waiting.
 * An app the owner stopped spawns nothing: its row is written as `skipped / app_stopped`.
 *
 * Stores: `~/.dreamcontext/apps/schedules/<hash>.json` `{id: {lastFireAt, enabled}}` and
 * `~/.dreamcontext/apps/runs/<hash>.jsonl` `{at,id,status,durationMs,code,excerpt}`, both 0600,
 * the runs file size-capped.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDue, nextFire, parseSchedule } from '../automations/schedule.js';
import { DEFAULT_CATCHUP_HOURS } from '../automations/types.js';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { readManifest } from './manifest.js';
import { appsHome, readRegistry, type AppRecord } from './registry.js';

const RUNS_MAX_BYTES = 256 * 1024;

export interface ScheduleState { lastFireAt: string | null; enabled: boolean }
export interface RunRow { at: string; id: string; status: 'ok' | 'failed' | 'skipped' | 'unknown'; durationMs: number; code: string | null; excerpt: string }

const statePath = (home: string, hash: string) => join(appsHome(home), 'schedules', `${hash}.json`);
const runsPath = (home: string, hash: string) => join(appsHome(home), 'runs', `${hash}.jsonl`);

export function readScheduleState(home: string, hash: string): Record<string, ScheduleState> {
  try {
    const p = statePath(home, hash);
    if (lstatSync(p).isSymbolicLink()) return {};
    const v = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, ScheduleState>;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeScheduleState(home: string, hash: string, state: Record<string, ScheduleState>): void {
  mkdirSync(join(appsHome(home), 'schedules'), { recursive: true, mode: 0o700 });
  const p = statePath(home, hash);
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, p);
}

export function setScheduleEnabled(home: string, hash: string, id: string, enabled: boolean): void {
  const st = readScheduleState(home, hash);
  st[id] = { lastFireAt: st[id]?.lastFireAt ?? null, enabled };
  writeScheduleState(home, hash, st);
}

export function appendRun(home: string, hash: string, row: RunRow): void {
  mkdirSync(join(appsHome(home), 'runs'), { recursive: true, mode: 0o700 });
  const p = runsPath(home, hash);
  try {
    if (statSync(p).size > RUNS_MAX_BYTES) {
      const keep = readFileSync(p, 'utf-8').split('\n').filter(Boolean).slice(-200);
      writeFileSync(p, keep.join('\n') + '\n', { mode: 0o600 });
    }
  } catch { /* new file */ }
  appendFileSync(p, JSON.stringify({ ...row, excerpt: row.excerpt.slice(0, 300) }) + '\n', { mode: 0o600 });
}

export function readRuns(home: string, hash: string, n = 20): RunRow[] {
  try {
    return readFileSync(runsPath(home, hash), 'utf-8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l) as RunRow);
  } catch {
    return [];
  }
}

export interface ScheduleView { id: string; enabled: boolean; lastFireAt: string | null; next: string | null; last: RunRow | null }

/** What the card and `dc.schedules.list()` show. */
export function scheduleViews(home: string, rec: AppRecord): ScheduleView[] {
  const m = readManifest(rec.root);
  if (!m.ok) return [];
  const state = readScheduleState(home, rec.hash);
  const runs = readRuns(home, rec.hash, 200);
  return m.manifest.schedules.map((s) => {
    const sched = parseSchedule(s.schedule);
    const next = sched ? nextFire(sched, new Date()) : null;
    return {
      id: s.id,
      enabled: state[s.id]?.enabled !== false,
      lastFireAt: state[s.id]?.lastFireAt ?? null,
      next: next ? next.toISOString() : null,
      last: [...runs].reverse().find((r) => r.id === s.id) ?? null,
    };
  });
}

export type Dispatch = (rec: AppRecord, id: string) => void;

/** The real dispatch: the CLI, detached, in the project (launchd has no cwd). */
export const realDispatch: Dispatch = (rec, id) => {
  const child = spawn(process.execPath, [process.argv[1], 'apps', 'run-schedule', rec.slug, id], {
    cwd: rec.projectRoot, detached: true, stdio: 'ignore', env: process.env,
  });
  child.on('error', () => { /* logged by the next run's absence */ });
  child.unref();
};

/**
 * Fire what is due across every registered app. Never waits for a run and never spawns
 * `claude`. Returns what it dispatched or skipped.
 */
export function tickApps(opts: { home?: string; now?: Date; dispatch?: Dispatch } = {}): Array<{ slug: string; id: string; action: 'dispatched' | 'skipped' }> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? new Date();
  const dispatch = opts.dispatch ?? realDispatch;
  const out: Array<{ slug: string; id: string; action: 'dispatched' | 'skipped' }> = [];
  for (const rec of readRegistry(home)) {
    // One app's bad manifest, full disk or lost lock never stops the others.
    try { tickOneApp(home, rec, now, dispatch, out); } catch { /* the next tick tries again */ }
  }
  return out;
}

function tickOneApp(home: string, rec: AppRecord, now: Date, dispatch: Dispatch, out: Array<{ slug: string; id: string; action: 'dispatched' | 'skipped' }>): void {
  const m = readManifest(rec.root);
  if (!m.ok || !m.manifest.schedules.length) return;
  const lock = join(appsHome(home), 'schedules', `.${rec.hash}.lock`);
  mkdirSync(join(appsHome(home), 'schedules'), { recursive: true, mode: 0o700 });
  if (!acquireFileLock(lock, Date.now(), 60_000, { verifyPidLiveness: true })) return;
  try {
    const state = readScheduleState(home, rec.hash);
    const due: string[] = [];
    for (const s of m.manifest.schedules) {
      const st = state[s.id] ?? { lastFireAt: null, enabled: true };
      if (st.enabled === false) continue;
      const verdict = isDue(parseSchedule(s.schedule), st.lastFireAt, now, s.catchupHours ?? DEFAULT_CATCHUP_HOURS);
      if (!verdict.due) continue;
      state[s.id] = { ...st, lastFireAt: now.toISOString() };
      due.push(s.id);
    }
    if (!due.length) return;
    // The watermark is ON DISK before anything runs: at most once. A write that fails (a full
    // disk) throws here, and nothing is dispatched, so a POST is never repeated every tick.
    writeScheduleState(home, rec.hash, state);
    for (const id of due) {
      if (rec.stoppedByOwner) {
        appendRun(home, rec.hash, { at: now.toISOString(), id, status: 'skipped', durationMs: 0, code: 'app_stopped', excerpt: '' });
        out.push({ slug: rec.slug, id, action: 'skipped' });
        continue;
      }
      out.push({ slug: rec.slug, id, action: 'dispatched' });
      try { dispatch(rec, id); } catch { /* a dispatch that cannot even start is a missing run */ }
    }
  } finally {
    releaseFileLock(lock);
  }
}

/**
 * The lock one schedule's run holds while it runs, so a slow action is never started twice (the
 * next tick fires while the first run is still going). Returns the release, or null when held.
 */
export function acquireScheduleRunLock(home: string, hash: string, id: string): (() => void) | null {
  const dir = join(appsHome(home), 'schedules');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, `.${hash}.${id}.run.lock`);
  // Stale after 7 min: past the 6 min call timeout, a dead holder is reclaimed by its pid anyway.
  if (!acquireFileLock(lock, Date.now(), 7 * 60_000, { verifyPidLiveness: true })) return null;
  return () => releaseFileLock(lock);
}
