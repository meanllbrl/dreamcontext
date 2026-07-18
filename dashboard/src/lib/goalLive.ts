/**
 * Types + phase model for the goal-skill live run state
 * (`_dream_context/tmp/.goal-skill-live.json`, served by GET /api/agent/goal-live).
 * Single writer is the goal-skill orchestrator; the panel above the composer and the
 * dock badge are read-only renderers of this state.
 */

export type GoalForkState = 'run' | 'done' | 'wait' | 'fail';

export interface GoalLiveFork {
  s: GoalForkState;
}

export interface GoalLiveImpl {
  wave?: number;
  waves?: number;
  forks?: GoalLiveFork[];
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

/** Loop-heat tier for a phase's iteration count: 0 none · 1 (=2) · 2 (=3) · 3 (≥4). */
export function goalHeatTier(iters: Record<string, number> | undefined, phase: string): number {
  const n = iters?.[phase] ?? 0;
  if (n >= 4) return 3;
  if (n === 3) return 2;
  if (n === 2) return 1;
  return 0;
}
