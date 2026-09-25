/**
 * Types + phase model for the goal-skill live run state
 * (`_dream_context/tmp/.goal-skill-live*.json` — one file per orchestrator session,
 * served by GET /api/agent/goal-live, which picks the run matching the pane).
 * Each orchestrator is the single writer of its own file; the panel above the
 * composer and the dock badge are read-only renderers of this state.
 */

export type GoalForkState = 'run' | 'done' | 'wait' | 'fail';

/** One builder lane or one seated judge. Every field but `s` is v3 and optional: a file written
 *  by an older skill carries anonymous `{s}` entries and still renders. */
export interface GoalLiveFork {
  s: GoalForkState;
  /** v3: dependency-map lane id ("T3") or the judge's role id. */
  id?: string;
  /** v3: what the lane builds, a few words. */
  name?: string;
  /** v3: role id from lib/agentRoles. */
  role?: string;
  /** v3: the judge's first-line verdict word (SOLID | NEEDS_WORK | PASS | FAIL). */
  v?: string;
}

export interface GoalLiveImpl {
  wave?: number;
  waves?: number;
  forks?: GoalLiveFork[];
}

export type GoalLineageKind = 'spawn' | 'fork' | 'resume' | 'fresh';

/** v3: one event in the run's family tree, appended by `dreamcontext goal-live actor`. */
export interface GoalLiveLineage {
  /** Actor id, stable across that actor's returns ("planner", "T3", "critic"). */
  a: string;
  role: string;
  k: GoalLineageKind;
  /** The actor whose memory it started with (fork source). Absent: briefed by the lead. */
  from?: string;
  r?: number;
  name?: string;
  at?: string;
  /** Tokens of context inherited without rebuilding. Fork events only, and only ever measured. */
  ctx?: number;
}

export interface GoalLiveState {
  goal?: string;
  /** Orchestrator's Claude conversation id — scopes the panel to its pane. */
  session?: string;
  started?: string;
  updated?: string;
  phase: string; // plan | review | task | impl | codereview | validate | done
  iters?: Record<string, number>;
  impl?: GoalLiveImpl;
  /** v3: the judges seated for the current review / codereview / validate phase. */
  judges?: GoalLiveFork[];
  /** v3: every phase transition, oldest first. */
  history?: { p: string; at: string }[];
  /** v3: who briefed, copied or brought back whom, oldest first. */
  lineage?: GoalLiveLineage[];
}

export interface GoalLiveResponse {
  active: boolean;
  state?: GoalLiveState;
}

export const GOAL_PHASES = ['plan', 'review', 'task', 'impl', 'codereview', 'validate'] as const;

export const GOAL_PHASE_LABELS: Record<string, string> = {
  plan: 'PLAN',
  review: 'REVIEW',
  task: 'TASK',
  impl: 'IMPL',
  codereview: 'CODE-REV',
  validate: 'VALIDATE',
};

/** Index of the active phase; `done` maps past the last phase (everything ✓). */
export function goalPhaseIndex(phase: string): number {
  if (phase === 'done') return GOAL_PHASES.length;
  const i = GOAL_PHASES.indexOf(phase as (typeof GOAL_PHASES)[number]);
  return i < 0 ? 0 : i;
}

/** Whole minutes since the run started, or null when unknown. */
export function goalElapsedMinutes(state: GoalLiveState): number | null {
  const t = Date.parse(state.started ?? '');
  if (!t) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

// ─── Normalizing the file (it is written by an agent, so it is untrusted) ─────────

export const GOAL_LIVE_CAPS = { forks: 12, judges: 8, history: 40, lineage: 60 } as const;

/** Mirrors the writer's `ACTOR_ID_MAX` (src/cli/commands/goal-live.ts). Every id is capped at
 *  exactly this, never shorter: seats join lineage by id, so a cut id stops matching. */
export const GOAL_LIVE_ID_MAX = 40;

const FORK_STATES: ReadonlySet<string> = new Set(['run', 'done', 'wait', 'fail']);
const LINEAGE_KINDS: ReadonlySet<string> = new Set(['spawn', 'fork', 'resume', 'fresh']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A trimmed, capped string, or undefined for anything else (so no field ever renders "[object Object]"). */
function str(v: unknown, cap: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, cap) : undefined;
}

function nonNegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function normFork(v: unknown): GoalLiveFork | null {
  if (!isRecord(v)) return null;
  const fork: GoalLiveFork = { s: typeof v.s === 'string' && FORK_STATES.has(v.s) ? (v.s as GoalForkState) : 'wait' };
  const id = str(v.id, GOAL_LIVE_ID_MAX); if (id) fork.id = id;
  const name = str(v.name, 60); if (name) fork.name = name;
  const role = str(v.role, GOAL_LIVE_ID_MAX); if (role) fork.role = role;
  const verdict = str(v.v, 16); if (verdict) fork.v = verdict;
  return fork;
}

function normForks(v: unknown, cap: number): GoalLiveFork[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(normFork).filter((f): f is GoalLiveFork => f !== null).slice(0, cap);
}

function normLineage(v: unknown): GoalLiveLineage | null {
  if (!isRecord(v) || typeof v.k !== 'string' || !LINEAGE_KINDS.has(v.k)) return null;
  const a = str(v.a, GOAL_LIVE_ID_MAX);
  if (!a) return null;
  const ev: GoalLiveLineage = { a, role: str(v.role, GOAL_LIVE_ID_MAX) ?? 'agent', k: v.k as GoalLineageKind };
  const from = str(v.from, GOAL_LIVE_ID_MAX); if (from) ev.from = from;
  const r = nonNegInt(v.r); if (r != null) ev.r = r;
  const name = str(v.name, 60); if (name) ev.name = name;
  const at = str(v.at, 40); if (at) ev.at = at;
  // A reuse number is only ever a measurement, and only a copied memory has one.
  if (ev.k === 'fork' && typeof v.ctx === 'number' && Number.isInteger(v.ctx) && v.ctx > 0) ev.ctx = v.ctx;
  return ev;
}

/**
 * The live file as the renderers may trust it: known shapes only, every list capped, every
 * unknown state folded to `wait`, every unknown lineage kind dropped. `null` when there is no
 * `phase` to render at all. Additive over v1: a legacy `{phase, iters, impl:{forks:[{s}]}}` file
 * comes back unchanged in meaning.
 */
export function normalizeGoalLive(raw: unknown): GoalLiveState | null {
  if (!isRecord(raw) || typeof raw.phase !== 'string') return null;
  const out: GoalLiveState = { phase: raw.phase.trim() };
  for (const key of ['goal', 'session', 'started', 'updated'] as const) {
    const v = str(raw[key], 200);
    if (v) out[key] = v;
  }
  if (isRecord(raw.iters)) {
    const iters: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.iters)) {
      const n = nonNegInt(v);
      if (n != null) iters[k] = n;
    }
    out.iters = iters;
  }
  if (isRecord(raw.impl)) {
    const impl: GoalLiveImpl = {};
    const wave = nonNegInt(raw.impl.wave); if (wave != null) impl.wave = wave;
    const waves = nonNegInt(raw.impl.waves); if (waves != null) impl.waves = waves;
    const forks = normForks(raw.impl.forks, GOAL_LIVE_CAPS.forks); if (forks) impl.forks = forks;
    out.impl = impl;
  }
  const judges = normForks(raw.judges, GOAL_LIVE_CAPS.judges);
  if (judges) out.judges = judges;
  if (Array.isArray(raw.history)) {
    out.history = raw.history
      .filter((h): h is { p: string; at: string } => isRecord(h) && typeof h.p === 'string' && typeof h.at === 'string')
      .map((h) => ({ p: h.p, at: h.at }))
      .slice(-GOAL_LIVE_CAPS.history);
  }
  if (Array.isArray(raw.lineage)) {
    out.lineage = raw.lineage
      .map(normLineage)
      .filter((e): e is GoalLiveLineage => e !== null)
      .slice(-GOAL_LIVE_CAPS.lineage);
  }
  return out;
}

/** Loop-heat tier for a phase's iteration count: 0 none · 1 (=2) · 2 (=3) · 3 (≥4). */
export function goalHeatTier(iters: Record<string, number> | undefined, phase: string): number {
  const n = iters?.[phase] ?? 0;
  if (n >= 4) return 3;
  if (n === 3) return 2;
  if (n === 2) return 1;
  return 0;
}
