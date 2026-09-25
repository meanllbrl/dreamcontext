import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lastMainChainContext } from './context-watch.js';
import { findTranscriptBySessionId, isSafeSessionId } from './transcript-locate.js';

/**
 * The goal-skill live run file — WRITER side.
 *
 * One JSON file per orchestrator session under `_dream_context/tmp/`, read by
 * `GET /api/agent/goal-live` (agent-terminal.ts) and rendered by the dashboard's quest map.
 * The orchestrator used to hand-write this file through a shell heredoc, which meant an LLM
 * carrying append-only arrays (`history`, `lineage`) forward by hand on every write. This
 * module owns that bookkeeping instead: the CLI (`dreamcontext goal-live …`) applies one
 * event at a time through {@link applyGoalLiveEvent} and writes the result atomically.
 *
 * MIRRORED in `dashboard/src/lib/goalLive.ts` (the reader types): the dashboard cannot import
 * from `src/`, so the field names, phases and lineage kinds are duplicated there, and
 * `tests/unit/goal-live-schema-lockstep.test.ts` fails the moment the two drift.
 */

export type GoalForkState = 'run' | 'done' | 'wait' | 'fail';
export type GoalLineageKind = 'spawn' | 'fork' | 'resume' | 'fresh';
export type GoalVerdict = 'SOLID' | 'NEEDS_WORK' | 'PASS' | 'FAIL';

export const GOAL_LIVE_PHASES = ['plan', 'review', 'task', 'impl', 'codereview', 'validate', 'done'] as const;
export type GoalLivePhase = typeof GOAL_LIVE_PHASES[number];

export const GOAL_LINEAGE_KINDS: readonly GoalLineageKind[] = ['spawn', 'fork', 'resume', 'fresh'];
export const GOAL_FORK_STATES: readonly GoalForkState[] = ['run', 'done', 'wait', 'fail'];
export const GOAL_VERDICTS: readonly GoalVerdict[] = ['SOLID', 'NEEDS_WORK', 'PASS', 'FAIL'];

export interface GoalLiveFork { s: GoalForkState; id?: string; name?: string; role?: string; v?: string }

export interface GoalLiveLineage {
  a: string;
  role: string;
  k: GoalLineageKind;
  from?: string;
  r?: number;
  name?: string;
  at?: string;
  /** Tokens of context the actor inherited without rebuilding it. `fork` events only, and
   *  only ever a MEASURED value (see {@link measureInheritedContext}) — never an estimate. */
  ctx?: number;
}

export interface GoalLiveState {
  goal?: string;
  /** The orchestrator's conversation id. Absent when the CLI ran with no session id. */
  session?: string;
  started?: string;
  updated?: string;
  phase: string;
  iters?: Record<string, number>;
  impl?: { wave?: number; waves?: number; forks?: GoalLiveFork[] };
  judges?: GoalLiveFork[];
  history?: { p: string; at: string }[];
  lineage?: GoalLiveLineage[];
}

export type GoalLiveEvent =
  | { type: 'start'; goal: string; session: string | null }
  | { type: 'phase'; phase: GoalLivePhase; wave?: number; waves?: number }
  | { type: 'actor'; id: string; role: string; kind: GoalLineageKind; from?: string; round?: number; name?: string; ctx?: number }
  | { type: 'state'; id: string; state?: GoalForkState; verdict?: GoalVerdict };

/**
 * Every role id the dashboard's registry knows (`dashboard/src/lib/agentRoles.ts`). The CLI
 * uses it for one thing: an actor id that IS a role (`critic`, `reviewer`) needs no `--role`.
 */
export const AGENT_ROLE_IDS: readonly string[] = [
  'lead', 'planner', 'critic', 'pragmatist', 'edge-cases', 'security', 'plan-reviewer',
  'implementer', 'reviewer', 'validator', 'explorer', 'peer', 'headless', 'agent',
];

/** Roles seated as `judges` — the registry's `judge` hue. Mirrors `isJudgeRole` in
 *  `dashboard/src/lib/agentRoles.ts`; the lockstep test pins the two equal. */
export const JUDGE_ROLES: readonly string[] = [
  'critic', 'pragmatist', 'edge-cases', 'security', 'plan-reviewer', 'reviewer', 'validator',
];

/** The role whose actors are tracked as implementer `forks`. */
const BUILDER_ROLE = 'implementer';

/** Array caps. The file is re-read by the route every 2s, so it must stay small. */
export const GOAL_LIVE_CAPS = { forks: 12, judges: 8, history: 40, lineage: 60 } as const;

/** A live file older than this is an abandoned run — same threshold the route reads by. */
export const GOAL_LIVE_MAX_AGE_MS = 3 * 3600 * 1000;

/** Every live file the route scans. The unsuffixed legacy name included. */
const GOAL_LIVE_FILE_RE = /^\.goal-skill-live(?:\..+)?\.json$/;

// ─── The reducer ─────────────────────────────────────────────────────────────────

/** Keep the newest `cap` entries — every capped array here is oldest-first. */
function lastN<T>(list: T[], cap: number): T[] {
  return list.length > cap ? list.slice(list.length - cap) : list;
}

/** Insert or patch by `id`, keeping order of first appearance. */
function upsertById(list: GoalLiveFork[], id: string, patch: Partial<GoalLiveFork>): GoalLiveFork[] {
  const idx = list.findIndex((f) => f.id === id);
  if (idx === -1) return [...list, { s: 'run', id, ...patch }];
  const next = list.slice();
  next[idx] = { ...next[idx], ...patch };
  return next;
}

function applyPhase(prev: GoalLiveState, ev: Extract<GoalLiveEvent, { type: 'phase' }>, now: string): GoalLiveState {
  const history = prev.history ?? [];
  // An ENTRY is the first transition into a phase, or a return to it after another one.
  // Repeating the current phase (a chain that restates it) only updates the wave numbers,
  // so it can never inflate the round counter the UI reads off `iters`.
  const entering = history.length === 0 || history[history.length - 1].p !== ev.phase;
  const next: GoalLiveState = { ...prev, phase: ev.phase };
  if (entering) {
    const iters = { ...(prev.iters ?? {}) };
    iters[ev.phase] = (iters[ev.phase] ?? 0) + 1;
    next.iters = iters;
    next.history = lastN([...history, { p: ev.phase, at: now }], GOAL_LIVE_CAPS.history);
    // Judges are seated per phase: a code review's reviewer is not still "running" once the
    // run moves on to validation.
    delete next.judges;
  }
  if (ev.wave != null || ev.waves != null) {
    next.impl = {
      ...(prev.impl ?? {}),
      ...(ev.wave != null ? { wave: ev.wave } : {}),
      ...(ev.waves != null ? { waves: ev.waves } : {}),
    };
  }
  return next;
}

function applyActor(prev: GoalLiveState, ev: Extract<GoalLiveEvent, { type: 'actor' }>, now: string): GoalLiveState {
  const event: GoalLiveLineage = { a: ev.id, role: ev.role, k: ev.kind, at: now };
  if (ev.from) event.from = ev.from;
  if (ev.round != null) event.r = ev.round;
  if (ev.name) event.name = ev.name;
  // Only a copy of someone's memory inherits context; a resume keeps its own and a fresh
  // judge has none. Anything else carrying a number would be a number about nothing.
  if (ev.kind === 'fork' && ev.ctx != null) event.ctx = ev.ctx;
  const next: GoalLiveState = {
    ...prev,
    lineage: lastN([...(prev.lineage ?? []), event], GOAL_LIVE_CAPS.lineage),
  };
  const seat: Partial<GoalLiveFork> = { s: 'run', role: ev.role, ...(ev.name ? { name: ev.name } : {}) };
  if (ev.role === BUILDER_ROLE) {
    const forks = upsertById(prev.impl?.forks ?? [], ev.id, seat);
    next.impl = { ...(prev.impl ?? {}), forks: lastN(forks, GOAL_LIVE_CAPS.forks) };
  } else if (JUDGE_ROLES.includes(ev.role)) {
    next.judges = lastN(upsertById(prev.judges ?? [], ev.id, seat), GOAL_LIVE_CAPS.judges);
  }
  // Every other role (planner, explorer, …) is a lineage entry only.
  return next;
}

function applyState(prev: GoalLiveState, ev: Extract<GoalLiveEvent, { type: 'state' }>): GoalLiveState {
  // A verdict word means the judge has finished; a plain state word is taken as given.
  const patch: Partial<GoalLiveFork> = ev.verdict ? { s: 'done', v: ev.verdict } : ev.state ? { s: ev.state } : {};
  if (!patch.s) return prev;
  const forks = prev.impl?.forks ?? [];
  if (forks.some((f) => f.id === ev.id)) {
    return { ...prev, impl: { ...(prev.impl ?? {}), forks: upsertById(forks, ev.id, patch) } };
  }
  const judges = prev.judges ?? [];
  if (judges.some((f) => f.id === ev.id)) {
    return { ...prev, judges: upsertById(judges, ev.id, patch) };
  }
  // An id nobody seated — e.g. the planner — has no state to carry. Dropped, not invented.
  return prev;
}

/**
 * Fold one event into the live state. Pure: `nowIso` is passed in, so every sequence is
 * reproducible in a test. `prev` null (no file yet, or an unreadable one) starts from a
 * blank plan-phase run, so a chain that skipped `start` still produces a valid file.
 */
export function applyGoalLiveEvent(prev: GoalLiveState | null, ev: GoalLiveEvent, nowIso: string): GoalLiveState {
  if (ev.type === 'start') {
    const fresh: GoalLiveState = { goal: ev.goal, started: nowIso, updated: nowIso, phase: 'plan' };
    if (ev.session) fresh.session = ev.session;
    return fresh;
  }
  const base: GoalLiveState = prev ?? { phase: 'plan', started: nowIso };
  const next = ev.type === 'phase' ? applyPhase(base, ev, nowIso)
    : ev.type === 'actor' ? applyActor(base, ev, nowIso)
      : applyState(base, ev);
  return { ...next, updated: nowIso };
}

// ─── Where the file lives ───────────────────────────────────────────────────────

/**
 * This run's session id, from `CLAUDE_CODE_SESSION_ID`, or null. The id becomes part of a
 * file name, so anything that is not a plain id (a `/`, a `..`) is refused and the run falls
 * back to the `solo` file rather than writing outside `tmp/`.
 */
export function goalLiveSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  return isSafeSessionId(raw) ? raw : null;
}

export function goalLivePath(contextRoot: string, sessionId: string | null): string {
  return join(contextRoot, 'tmp', `.goal-skill-live.${sessionId ?? 'solo'}.json`);
}

/**
 * Read the current live state, or null. A symlink is refused (a shared brain repo must not
 * be able to point this read at an arbitrary file), and a malformed file reads as "no file"
 * so the next write replaces it instead of the whole command failing on it.
 */
export function readGoalLive(path: string): GoalLiveState | null {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const state = parsed as GoalLiveState;
    return typeof state.phase === 'string' ? state : null;
  } catch {
    return null;
  }
}

/**
 * Write the whole state atomically: a temp file in the same directory, then a rename. The
 * route polls this file every 2s; a half-written file would read as malformed and blank the
 * quest map for a beat. The temp name ends in `.tmp`, so the route's scan never matches it.
 */
export function writeGoalLiveAtomic(path: string, state: GoalLiveState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), 'utf-8');
  renameSync(tmp, path);
}

/**
 * Delete live files abandoned for longer than `maxAgeMs` (by mtime). Replaces the
 * `find … -mmin +180 -delete` the skill used to run by hand. Best effort per file: a file
 * that vanished or cannot be removed is skipped, and the count says how many went.
 */
export function sweepAbandonedGoalLive(contextRoot: string, nowMs: number, maxAgeMs: number = GOAL_LIVE_MAX_AGE_MS): number {
  const dir = join(contextRoot, 'tmp');
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!GOAL_LIVE_FILE_RE.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || nowMs - st.mtimeMs <= maxAgeMs) continue;
      unlinkSync(path);
      removed += 1;
    } catch { /* raced with another session's own sweep; nothing left to do */ }
  }
  return removed;
}

/**
 * The context a fork INHERITS: the source session's last main-chain context, measured off
 * its own transcript (`lastMainChainContext`, the same formula the composer ring and the
 * handoff nudge use). Null when the transcript cannot be found or carries no usage — the
 * caller then records no number at all, which is the point.
 */
export function measureInheritedContext(sessionId: string, home?: string): number | null {
  const path = findTranscriptBySessionId([sessionId], home);
  if (!path) return null;
  const tokens = lastMainChainContext(path);
  return tokens != null && Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : null;
}
