import { AGENT_TASK_STATES, TASK_STEPS, type AgentTaskState, type TaskStep } from './task-jobs.js';
import type { InboxRow } from '../owner-inbox.js';

/**
 * The task's agent job as the dashboard reads it (AI Team v2 C2): a read-only projection of the
 * synced display fields C1 writes (`agent_state`, `agent_step`, `review_*`, `deliveries`, …).
 * Display only: every start or refusal reads the machine-local M0 records, never these.
 */

export interface AgentJobDeliveryRef { kind: 'doc' | 'board' | 'file' | 'branch'; path: string }

export interface AgentJobDelivery {
  round: number;
  at: string;
  by: string;
  note: string;
  refs: AgentJobDeliveryRef[];
  branch: string | null;
  commits: string[];
}

export interface AgentJob {
  state: AgentTaskState | null;
  step: TaskStep | null;
  round: number;
  cap: number;
  reviewer: string | null;
  workspace: 'code' | 'doc' | null;
  repo: string | null;
  startAt: string | null;
  queuedAt: string | null;
  reviewPassed: boolean;
  claimedMachine: string | null;
  /** Why it is blocked or stopped, as the host wrote it. */
  reason: string | null;
}

export interface AgentJobDetail extends AgentJob {
  deliveries: AgentJobDelivery[];
  /** The live step's session on this machine (M0 claim), so a question it asked can be answered
   *  from the task. Null when no step of it runs here. */
  sessionId: string | null;
  /** This machine's owner-inbox rows about the task (M1): their actions answer the job. */
  rows: InboxRow[];
}

const REF_KINDS = new Set(['doc', 'board', 'file', 'branch']);
const DEFAULT_CAP = 5;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function deliveriesOf(raw: unknown): AgentJobDelivery[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentJobDelivery[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    const round = Number(r.round);
    const refs = Array.isArray(r.refs)
      ? (r.refs as unknown[]).flatMap((x) => {
        const ref = x as Record<string, unknown> | null;
        return ref && typeof ref.kind === 'string' && REF_KINDS.has(ref.kind) && typeof ref.path === 'string'
          ? [{ kind: ref.kind as AgentJobDeliveryRef['kind'], path: ref.path }]
          : [];
      })
      : [];
    out.push({
      round: Number.isFinite(round) ? Math.max(0, Math.floor(round)) : 0,
      at: str(r.at) ?? '',
      by: str(r.by) ?? '',
      note: typeof r.note === 'string' ? r.note : '',
      refs,
      branch: str(r.branch),
      commits: Array.isArray(r.commits) ? (r.commits as unknown[]).filter((c): c is string => typeof c === 'string') : [],
    });
  }
  return out;
}

/** The job of a task's raw frontmatter, or null when no agent was ever given it. */
export function agentJobOf(raw: Record<string, unknown>): AgentJob | null {
  const state = str(raw.agent_state);
  const step = str(raw.agent_step);
  if (!str(raw.agent) && !state) return null;
  const round = Number(raw.review_round);
  const cap = Number(raw.review_cap);
  const ws = str(raw.agent_workspace);
  return {
    state: state && (AGENT_TASK_STATES as readonly string[]).includes(state) ? (state as AgentTaskState) : null,
    step: step && (TASK_STEPS as readonly string[]).includes(step) ? (step as TaskStep) : null,
    round: Number.isFinite(round) && round >= 0 ? Math.floor(round) : 0,
    cap: Number.isFinite(cap) && cap >= 1 ? Math.min(10, Math.floor(cap)) : DEFAULT_CAP,
    reviewer: str(raw.reviewer),
    workspace: ws === 'code' || ws === 'doc' ? ws : null,
    repo: str(raw.agent_repo),
    startAt: str(raw.agent_start_at),
    queuedAt: str(raw.agent_queued_at),
    reviewPassed: raw.review_passed === true,
    claimedMachine: str(raw.agent_claimed_machine),
    reason: state === 'blocked' ? str(raw.agent_blocked) : state === 'stopped' ? str(raw.agent_stopped) : null,
  };
}

/** The drawer's view: the job plus its deliveries and this machine's rows about it. */
export function agentJobDetailOf(
  raw: Record<string, unknown>, taskId: string, rows: readonly InboxRow[], sessionId: string | null = null,
): AgentJobDetail | null {
  const job = agentJobOf(raw);
  if (!job) return null;
  return {
    ...job,
    deliveries: deliveriesOf(raw.deliveries),
    sessionId,
    // By the task's id (the row's dedupe key is `<kind>:<id>`): its ref is the slug it was raised with.
    rows: rows.filter((r) => r.kind.startsWith('task-') && r.dedupeKey === `${r.kind}:${taskId}`),
  };
}
