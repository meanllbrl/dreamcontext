/**
 * The hackathon run record (plan C1): where a run lives, its states, its atomic writes and its
 * design hash. No Effect, no model call: the CLI, the server, the conductor and the tests import it.
 *
 * Brain side   `_dream_context/hackathon/<run-id>/`  run.json, result.json (git-tracked);
 *              brief.md, teams/, kept/ (local-only, gitignored).
 * Team side    `~/.dreamcontext-hackathon/<run-id>/<team>/{repo,out}`, plus the conductor-owned
 *              `.conductor/` no team can write.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withFileLockSync } from '../file-lock.js';
import type { Design } from './designer.js';

export const RUN_ID_RE = /^\d{8}-[a-z0-9-]{1,40}$/;
export const TEAM_ID_RE = /^[a-z0-9-]{1,24}$/;

export type RunState = 'draft' | 'awaiting-owner' | 'running' | 'presenting' | 'judging' | 'picked' | 'stopped';
export const RUN_STATES: readonly RunState[] = ['draft', 'awaiting-owner', 'running', 'presenting', 'judging', 'picked', 'stopped'];
/** The states a run may move to from each state. */
const NEXT: Readonly<Record<RunState, readonly RunState[]>> = {
  draft: ['awaiting-owner', 'stopped'],
  'awaiting-owner': ['running', 'stopped'],
  running: ['presenting', 'stopped'],
  presenting: ['judging', 'stopped'],
  judging: ['picked', 'stopped'],
  picked: [],
  stopped: [],
};

export interface RunRecord {
  version: 1;
  id: string;
  problem: string;
  state: RunState;
  createdAt: string;
  design: Design;
  /** Written by `POST …/start` with the design copy; part of the hashed design. */
  startedAt?: string;
  /** The design hash the owner pressed Başlat on. */
  startedHash?: string;
  /** The phase the conductor is in, and its round. */
  phase?: string;
  round?: number;
  /** Why the run is paused (limit), empty when it is not. */
  paused?: string | null;
  /** The owner pressed Devam: the session guard is off for this run. */
  guardOverride?: boolean;
  /** The limit reading at start (C3). */
  usageAtStart?: UsageReading | null;
  /** Lines for the page strip (newest last, capped). */
  moments?: { at: string; text: string }[];
  stopReason?: string;
  /** When a conductor was last launched for this run (Başlat or Sürdür). */
  launchedAt?: string;
  /** The conductor's PID while it runs (cleared when it ends; never signalled). */
  conductorPid?: number;
}

export interface UsageReading {
  weeklyPercent: number | null;
  weeklyResetsAt: number | null;
  sessionPercent: number | null;
  sessionResetsAt: number | null;
  noSessionWindow?: boolean;
  at: number;
}

/**
 * One phase of a run (plan C6), registered in `phases.ts`: the conductor enters each in order
 * (resuming at `run.phase` after a restart) and `run` returns the record it leaves behind.
 */
export interface Phase<C = unknown> {
  readonly name: string;
  run(run: RunRecord, ctx: C): Promise<RunRecord>;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export function hackathonDir(contextRoot: string): string {
  return join(contextRoot, 'hackathon');
}

export function runDir(contextRoot: string, runId: string): string {
  assertRunId(runId);
  return join(hackathonDir(contextRoot), runId);
}

/** Where team workspaces live; outside `~/.dreamcontext` so Codex's writable roots keep it. */
export function workspaceHome(home: string = process.env.DREAMCONTEXT_HACKATHON_HOME || join(homedir(), '.dreamcontext-hackathon')): string {
  return home;
}

export function runWorkspace(runId: string, home?: string): string {
  assertRunId(runId);
  return join(workspaceHome(home), runId);
}

export function teamWorkspace(runId: string, teamId: string, home?: string): { root: string; repo: string; out: string } {
  assertTeamId(teamId);
  const root = join(runWorkspace(runId, home), teamId);
  return { root, repo: join(root, 'repo'), out: join(root, 'out') };
}

/**
 * Where a team's `out/` (thesis cards, decisions, presentation, media) is kept once the pick
 * removes its workspace: beside the team folders, never inside one (`.kept` is no team id).
 */
export function keptOutDir(runId: string, teamId: string, home?: string): string {
  assertTeamId(teamId);
  return join(runWorkspace(runId, home), '.kept', teamId, 'out');
}

/** A team's owner-facing `out/`: its live folder while it exists, the kept one after the pick. */
export function teamOutDir(runId: string, teamId: string, home?: string): string {
  const live = teamWorkspace(runId, teamId, home).out;
  return existsSync(live) ? live : keptOutDir(runId, teamId, home);
}

export function conductorDir(runId: string, home?: string): string {
  return join(runWorkspace(runId, home), '.conductor');
}

export function assertRunId(id: string): void {
  if (!RUN_ID_RE.test(id)) throw new Error(`not a hackathon run id: ${JSON.stringify(id)}`);
}

export function assertTeamId(id: string): void {
  if (!TEAM_ID_RE.test(id)) throw new Error(`not a team id: ${JSON.stringify(id)}`);
}

/** `YYYYMMDD-<slug>` from a problem line, unique among the existing run folders. */
export function newRunId(contextRoot: string, problem: string, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const slug = problem.toLowerCase()
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'run';
  let id = `${day}-${slug}`;
  for (let n = 2; existsSync(join(hackathonDir(contextRoot), id)); n++) id = `${day}-${slug.slice(0, 36)}-${n}`;
  return id;
}

/**
 * `child` resolved inside `root`, or null: no `..`, no symlink anywhere on the way (lstat), and
 * the real path still under the real root. The one containment check every owner-side reader uses.
 */
export function containedPath(root: string, child: string): string | null {
  if (!child || child.includes('\0')) return null;
  const abs = resolve(root, child);
  const rel = relative(root, abs);
  if (rel === '') return abs;
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  let cur = root;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return null;
    } catch {
      break; // not there yet: nothing below it can be a link
    }
  }
  try {
    const realRoot = realpathSync(root);
    if (existsSync(abs)) {
      const real = realpathSync(abs);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    }
  } catch {
    return null;
  }
  return abs;
}

// ─── Atomic JSON ────────────────────────────────────────────────────────────

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

// ─── The record ─────────────────────────────────────────────────────────────

export function runPath(contextRoot: string, runId: string): string {
  return join(runDir(contextRoot, runId), 'run.json');
}

export function resultPath(contextRoot: string, runId: string): string {
  return join(runDir(contextRoot, runId), 'result.json');
}

export function readRun(contextRoot: string, runId: string): RunRecord | null {
  const r = readJson<RunRecord>(runPath(contextRoot, runId));
  return r && r.version === 1 && r.id === runId && RUN_STATES.includes(r.state) ? r : null;
}

export function listRuns(contextRoot: string): RunRecord[] {
  let names: string[];
  try { names = readdirSync(hackathonDir(contextRoot)); } catch { return []; }
  return names.filter((n) => RUN_ID_RE.test(n)).map((n) => readRun(contextRoot, n)).filter((r): r is RunRecord => !!r)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function lockPath(contextRoot: string, runId: string): string {
  return join(runDir(contextRoot, runId), '.run.lock');
}

/**
 * Read-modify-write under the run's PID lock: a conductor restart racing an owner route never
 * loses a write. `fn` returns the new record (or null to leave it as it is).
 */
export function updateRun(contextRoot: string, runId: string, fn: (r: RunRecord) => RunRecord | null): RunRecord {
  return withFileLockSync(lockPath(contextRoot, runId), () => {
    const cur = readRun(contextRoot, runId);
    if (!cur) throw new Error(`no hackathon run ${runId}`);
    const next = fn(structuredClone(cur));
    if (!next) return cur;
    if (next.state !== cur.state && !NEXT[cur.state].includes(next.state)) {
      throw new Error(`a run cannot go from ${cur.state} to ${next.state}`);
    }
    writeJsonAtomic(runPath(contextRoot, runId), next);
    return next;
  }, { waitMs: 5000 });
}

export function createRun(contextRoot: string, r: RunRecord): void {
  const p = runPath(contextRoot, r.id);
  if (existsSync(p)) throw new Error(`hackathon run ${r.id} exists`);
  ensureGitignore(contextRoot);
  writeJsonAtomic(p, r);
}

export function canMove(from: RunState, to: RunState): boolean {
  return NEXT[from].includes(to);
}

export const MOMENTS_MAX = 40;

export function addMoment(r: RunRecord, text: string, at: Date = new Date()): RunRecord {
  const moments = [...(r.moments ?? []), { at: at.toISOString(), text: text.slice(0, 200) }];
  return { ...r, moments: moments.slice(-MOMENTS_MAX) };
}

/**
 * The brain-side local-only paths: team folders, kept work and media never reach git or brain
 * sync. Written once into `_dream_context/hackathon/.gitignore`.
 */
export const HACKATHON_GITIGNORE = ['*/brief.md', '*/teams/', '*/kept/', '*/media/', '*/rounds/', '*/.run.lock', '*.tmp'] as const;

export function ensureGitignore(contextRoot: string): void {
  const p = join(hackathonDir(contextRoot), '.gitignore');
  mkdirSync(dirname(p), { recursive: true });
  let have = '';
  try { have = readFileSync(p, 'utf-8'); } catch { /* new */ }
  const missing = HACKATHON_GITIGNORE.filter((l) => !have.split('\n').includes(l));
  if (!missing.length) return;
  const body = `${have}${have && !have.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`;
  const tmp = `${p}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, body); } finally { closeSync(fd); }
  renameSync(tmp, p);
}

// ─── The design hash ────────────────────────────────────────────────────────

/** JSON with every object's keys sorted, arrays in order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** sha256 of the canonical JSON of `run.design`: the ONE function every reader uses. */
export function designHash(run: Pick<RunRecord, 'design'>): string {
  return createHash('sha256').update(canonicalJson(run.design)).digest('hex');
}

/** Remove a file if it is there (never through a link). */
export function removeFileQuiet(p: string): void {
  try {
    if (lstatSync(p).isFile()) unlinkSync(p);
  } catch { /* gone */ }
}
