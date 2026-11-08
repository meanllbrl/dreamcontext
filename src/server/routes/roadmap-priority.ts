import { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { recordDashboardChange } from '../change-tracker.js';
import { today } from '../../lib/id.js';
import { loadStatuses } from '../../lib/overrides.js';
import { isActive, isReview } from '../../lib/task-status.js';
import { buildRoadmapModel, type RoadmapObjective } from '../../lib/roadmap-model.js';
import {
  acceptObjectiveSuggestion,
  dismissObjectiveSuggestion,
  getObjective,
  isSafeObjectiveSlug,
  objectiveSuggestionTarget,
} from '../../lib/objectives-store.js';
import {
  SuggestionError,
  deadLinkMark,
  effectiveSuggestion,
  hasLiveVerdict,
  liveLinks,
  taskSuggestionTarget,
  validateEdits,
  type EffectiveSuggestion,
  type RiceValues,
} from '../../lib/priority-suggestion.js';
import { computeRiceScore } from '../../lib/rice.js';
import {
  isScoringRunning,
  loadOpenTasks,
  objectiveLiveness,
  scoringWork,
  startScoring,
  stopScoring,
  topLevelOf,
} from '../../lib/scoring-work.js';
import { getTaskBackend, isSafeTaskSlug } from '../../lib/task-backend/index.js';

/**
 * The priority board's ONE payload (GET /api/roadmap/priority), so the cards,
 * the counts and the agent button can never disagree: one model build and one
 * resolver per request. Plus the write routes the board drives: accept/dismiss
 * a suggestion, move one objective link, start/stop the scoring marker.
 */

export type ObjectiveSignal = 'late' | 'slipping' | 'on_track' | null;

export interface PriorityObjective extends Omit<RoadmapObjective, 'priority_suggestion'> {
  signal: ObjectiveSignal;
  /** Days past the target date while not done; null otherwise. */
  late_days: number | null;
  effective_suggestion: EffectiveSuggestion | null;
}

export interface PriorityTask {
  slug: string;
  name: string;
  status: string;
  status_kind: 'active' | 'review' | 'other';
  rice: RiceValues;
  score: number | null;
  /** Live links (existing, not-done objectives). Empty = the Unlinked column. */
  links: string[];
  /** Why a task with links has no live one; null otherwise. */
  mark: 'objective done' | 'objective missing' | null;
  /** All stored links, including dead ones (the drag replaces the first dead one). */
  all_links: string[];
  /** A live "no objective fits" verdict from the agent. */
  no_objective: boolean;
  effective_suggestion: EffectiveSuggestion | null;
  subtask_count: number;
  updated_at: string | null;
}

export interface PriorityPayload {
  generated_at: string;
  objectives: PriorityObjective[];
  tasks: PriorityTask[];
  scoring: { count: number; pending: number; running: boolean };
  warnings: string[];
}

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export function buildPriorityPayload(contextRoot: string, now: Date = new Date()): PriorityPayload {
  const model = buildRoadmapModel(contextRoot);
  const liveness = objectiveLiveness(model);
  const statuses = loadStatuses(contextRoot);
  const day = now.toISOString().slice(0, 10);

  const objectives: PriorityObjective[] = model.objectives.map((o) => {
    const { priority_suggestion: _raw, ...rest } = o;
    const lateDays = o.status !== 'done' && o.target_date && o.target_date < day ? daysBetween(o.target_date, day) : null;
    const signal: ObjectiveSignal = o.status === 'done'
      ? null
      : lateDays !== null ? 'late' : o.slipping === true ? 'slipping' : o.slipping === false ? 'on_track' : null;
    const file = getObjective(contextRoot, o.slug);
    return {
      ...rest,
      signal,
      late_days: lateDays,
      effective_suggestion: file ? effectiveSuggestion(objectiveSuggestionTarget(file), liveness) : null,
    };
  });

  const open = loadOpenTasks(contextRoot);
  const top = topLevelOf(open);
  const topSlugs = new Set(top.map((t) => t.slug));
  const childCount = new Map<string, number>();
  for (const t of open) {
    if (t.parent_task && t.parent_task !== t.slug && topSlugs.has(t.parent_task) && !top.includes(t)) {
      childCount.set(t.parent_task, (childCount.get(t.parent_task) ?? 0) + 1);
    }
  }
  const tasks: PriorityTask[] = top.map((t) => {
    const target = taskSuggestionTarget(t.data);
    return {
      slug: t.slug,
      name: t.name,
      status: t.status,
      status_kind: isActive(statuses, t.status) ? 'active' : isReview(statuses, t.status) ? 'review' : 'other',
      rice: target.rice,
      score: computeRiceScore(target.rice),
      links: liveLinks(target.objectives, liveness),
      mark: deadLinkMark(target.objectives, liveness),
      all_links: target.objectives ?? [],
      no_objective: hasLiveVerdict(target.priority_suggestion, liveness),
      effective_suggestion: effectiveSuggestion(target, liveness),
      subtask_count: childCount.get(t.slug) ?? 0,
      updated_at: typeof t.data.updated_at === 'string' ? t.data.updated_at : null,
    };
  });

  const work = scoringWork(contextRoot, { model, tasks: open });
  return {
    generated_at: today(),
    objectives,
    tasks,
    scoring: { count: work.count, pending: work.pending, running: isScoringRunning(contextRoot) },
    warnings: model.warnings,
  };
}

function sendSuggestionError(res: ServerResponse, err: unknown, what: string): void {
  if (err instanceof SuggestionError) {
    sendError(res, err.httpStatus, err.code, err.message);
    return;
  }
  console.error(`[roadmap-priority] ${what} failed:`, err);
  sendError(res, 500, `${what}_failed`, `Failed to ${what.replace(/_/g, ' ')}.`);
}

function bestEffortChange(contextRoot: string, target: string, summary: string): void {
  try {
    recordDashboardChange(contextRoot, { entity: 'task', action: 'update', target, field: 'priority', summary });
  } catch (err) {
    console.error('[roadmap-priority] change journal failed (ignored):', err);
  }
}

/** GET /api/roadmap/priority */
export async function handleRoadmapPriority(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    sendJson(res, 200, buildPriorityPayload(contextRoot));
  } catch (err) {
    console.error('[roadmap-priority] payload failed:', err);
    sendError(res, 500, 'priority_failed', 'Failed to build the priority board.');
  }
}

/** POST /api/roadmap/scoring/start — compare-and-set; `started: false` = already running, do not dispatch. */
export async function handleRoadmapScoringStart(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const started = startScoring(contextRoot);
  if (!started) {
    sendJson(res, 409, { started: false, error: 'already_running', message: 'An agent is already scoring.' });
    return;
  }
  sendJson(res, 200, { started: true });
}

/** POST /api/roadmap/scoring/stop — the dispatch was not acknowledged: release the button. */
export async function handleRoadmapScoringStop(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  stopScoring(contextRoot);
  sendJson(res, 200, { stopped: true });
}

async function readAt(req: IncomingMessage, res: ServerResponse): Promise<{ at: string; body: Record<string, unknown> } | null> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return null;
  }
  if (typeof body.at !== 'string' || !body.at.trim()) {
    sendError(res, 400, 'missing_at', 'The suggestion identity "at" is required.');
    return null;
  }
  return { at: body.at, body };
}

/** POST /api/tasks/:slug/suggestion/accept  { at, rice? } */
export async function handleTaskSuggestionAccept(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }
  const read = await readAt(req, res);
  if (!read) return;
  const edits = validateEdits(read.body.rice);
  if ('error' in edits) { sendError(res, 400, 'invalid_rice', edits.error); return; }
  const backend = getTaskBackend(contextRoot);
  if (!(await backend.get(slug))) { sendError(res, 404, 'not_found', `Task not found: ${slug}`); return; }
  try {
    const liveness = objectiveLiveness(buildRoadmapModel(contextRoot));
    const out = await backend.acceptSuggestion(slug, read.at, edits.edits, liveness);
    if (out.outcome === 'applied') bestEffortChange(contextRoot, `state/${slug}.md`, `Task '${slug}': accepted the priority suggestion`);
    sendJson(res, 200, {
      outcome: out.outcome,
      link_dropped: out.linkDropped,
      filled: out.filled,
      rice: out.task.rice,
      objectives: out.task.objectives,
    });
  } catch (err) {
    sendSuggestionError(res, err, 'accept_suggestion');
  }
}

/** POST /api/tasks/:slug/suggestion/dismiss  { at } */
export async function handleTaskSuggestionDismiss(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }
  const read = await readAt(req, res);
  if (!read) return;
  const backend = getTaskBackend(contextRoot);
  if (!(await backend.get(slug))) { sendError(res, 404, 'not_found', `Task not found: ${slug}`); return; }
  try {
    await backend.dismissSuggestion(slug, read.at);
    sendJson(res, 200, { dismissed: true });
  } catch (err) {
    sendSuggestionError(res, err, 'dismiss_suggestion');
  }
}

/** POST /api/tasks/:slug/objectives/move  { remove?, add?, index?, undo? } → { undo } */
export async function handleTaskObjectivesMove(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }
  const body = await parseJsonBody(req);
  if (!body) { sendError(res, 400, 'invalid_body', 'Request body must be JSON.'); return; }
  const strOrNull = (v: unknown): string | null | 'bad' =>
    v === undefined || v === null ? null : typeof v === 'string' && v.trim() ? v.trim() : 'bad';
  const remove = strOrNull(body.remove);
  const add = strOrNull(body.add);
  if (remove === 'bad' || add === 'bad') {
    sendError(res, 400, 'invalid_move', 'remove/add must be objective slugs or null.');
    return;
  }
  if (remove === null && add === null) {
    sendError(res, 400, 'invalid_move', 'A move needs remove, add, or both.');
    return;
  }
  const index = typeof body.index === 'number' && Number.isInteger(body.index) && body.index >= 0 ? body.index : undefined;
  const backend = getTaskBackend(contextRoot);
  if (!(await backend.get(slug))) { sendError(res, 404, 'not_found', `Task not found: ${slug}`); return; }
  try {
    const liveness = objectiveLiveness(buildRoadmapModel(contextRoot));
    const out = await backend.moveObjectiveLink(slug, { remove, add, index, undo: body.undo === true }, liveness);
    if (out.changed) bestEffortChange(contextRoot, `state/${slug}.md`, `Task '${slug}': objective link moved`);
    sendJson(res, 200, { changed: out.changed, note: out.note, undo: out.undo, objectives: out.task.objectives });
  } catch (err) {
    sendSuggestionError(res, err, 'move_link');
  }
}

/** POST /api/objectives/:slug/suggestion/accept  { at, rice? } */
export async function handleObjectiveSuggestionAccept(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isSafeObjectiveSlug(params.slug)) { sendError(res, 400, 'invalid_path', `Invalid objective slug: ${params.slug}`); return; }
  const read = await readAt(req, res);
  if (!read) return;
  const edits = validateEdits(read.body.rice);
  if ('error' in edits) { sendError(res, 400, 'invalid_rice', edits.error); return; }
  try {
    const liveness = objectiveLiveness(buildRoadmapModel(contextRoot));
    const out = acceptObjectiveSuggestion(contextRoot, params.slug, read.at, edits.edits, liveness);
    if (out.outcome === 'applied') bestEffortChange(contextRoot, `core/objectives/${params.slug}.md`, `Objective '${params.slug}': accepted the priority suggestion`);
    sendJson(res, 200, {
      outcome: out.outcome,
      link_dropped: null,
      filled: out.filled,
      score: out.objective.score,
    });
  } catch (err) {
    sendSuggestionError(res, err, 'accept_suggestion');
  }
}

/** POST /api/objectives/:slug/suggestion/dismiss  { at } */
export async function handleObjectiveSuggestionDismiss(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isSafeObjectiveSlug(params.slug)) { sendError(res, 400, 'invalid_path', `Invalid objective slug: ${params.slug}`); return; }
  const read = await readAt(req, res);
  if (!read) return;
  try {
    dismissObjectiveSuggestion(contextRoot, params.slug, read.at);
    sendJson(res, 200, { dismissed: true });
  } catch (err) {
    sendSuggestionError(res, err, 'dismiss_suggestion');
  }
}
