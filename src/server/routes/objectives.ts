import { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import {
  listObjectives,
  createObjective,
  updateObjective,
  deleteObjective,
  addDependency,
  removeDependency,
  isSafeObjectiveSlug,
  parseMetric,
  ObjectiveError,
  type CreateObjectiveInput,
  type UpdateObjectiveInput,
  type Objective,
} from '../../lib/objectives-store.js';
import { buildRoadmapModel } from '../../lib/roadmap-model.js';

/**
 * GET /api/roadmap — the computed roadmap model (progress, rollup status,
 * member tasks, computed dependents, task-derived forecast, warnings). Pure
 * read over `buildRoadmapModel`; the dashboard merges it with the flat objective
 * list (which carries start_date/impact/effort) by slug.
 */
export async function handleRoadmapModel(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    sendJson(res, 200, buildRoadmapModel(contextRoot));
  } catch (err) {
    console.error('[roadmap] model build failed:', err);
    sendError(res, 500, 'roadmap_failed', 'Failed to build the roadmap model.');
  }
}

/** The client-facing objective shape (drops the on-disk `path`). */
function toPublicObjective(o: Objective) {
  return {
    slug: o.slug,
    title: o.title,
    start_date: o.start_date,
    target_date: o.target_date,
    depends_on: o.depends_on,
    feature: o.feature,
    impact: o.impact,
    effort: o.effort,
    status: o.status,
    metric: o.metric,
    created_at: o.created_at,
    updated_at: o.updated_at,
  };
}

/**
 * Read a metric object off a request body for create/update. Returns:
 *   { present:false }                          — key absent (leave unchanged)
 *   { present:true, value:null }               — explicit null (clear the metric)
 *   { present:true, value:ObjectiveMetric }    — a parsed metric (store validates it)
 *   { present:true, invalid:true }             — malformed (handler 400s)
 * A present-but-unparseable object is `invalid` so a bad payload is rejected loudly
 * rather than silently clearing the KR the objective is tracked by.
 */
function readMetric(body: Record<string, unknown>): { present: boolean; value?: Objective['metric']; invalid?: boolean } {
  if (!('metric' in body)) return { present: false };
  const raw = body.metric;
  if (raw === null) return { present: true, value: null };
  const parsed = parseMetric(raw);
  return parsed ? { present: true, value: parsed } : { present: true, invalid: true };
}

/** `''`/absent → skip; explicit `null` → clear; string → trimmed value. */
function optionalDate(body: Record<string, unknown>, key: string): { present: boolean; value: string | null; invalid?: boolean } {
  if (!(key in body)) return { present: false, value: null };
  const raw = body[key];
  if (raw === null) return { present: true, value: null };
  // A present-but-non-string date (number/object/bool) is a malformed payload — flag
  // it so the handler 400s, rather than silently coercing it to a "clear the date".
  if (typeof raw !== 'string') return { present: true, value: null, invalid: true };
  const s = raw.trim();
  return { present: true, value: s === '' ? null : s };
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Objectives HTTP API — the dashboard's write path for the PO-authored OKR
 * roadmap (task_uO60nZRt). Thin wrapper over `objectives-store.ts`, which owns
 * all validation (safe slug, calendar target date, dependency existence, and the
 * write-time cycle guard) — this layer just maps request → store call → JSON.
 */

/** Derive a safe kebab-case slug from a title (client sends one, this is fallback). */
export function slugifyObjective(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumerics → hyphen
    .replace(/-+/g, '-') // collapse runs (no `--`)
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

/** GET /api/objectives — list every objective (for pickers, dup-checks, display). */
export async function handleObjectivesList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const objectives = listObjectives(contextRoot).map(toPublicObjective);
    sendJson(res, 200, { objectives });
  } catch (err) {
    console.error('[objectives] list failed:', err);
    sendError(res, 500, 'list_failed', 'Failed to read objectives.');
  }
}

/**
 * POST /api/objectives — create a new objective. Body:
 *   { title (required), slug?, target_date?, depends_on?, why?, feature? }
 * `slug` is derived from `title` when absent. Store-level validation errors
 * (bad slug, duplicate, bad date, unknown/self dependency) surface as 400s.
 */
export async function handleObjectivesCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    sendError(res, 400, 'missing_title', 'An objective title is required.');
    return;
  }

  const rawSlug = typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : slugifyObjective(title);
  if (!isSafeObjectiveSlug(rawSlug)) {
    sendError(res, 400, 'invalid_slug', `Could not derive a valid slug from "${title}". Add a manual slug (kebab-case).`);
    return;
  }

  // Impact/effort (value/effort 2×2) — coerced to number|null; the store validates
  // the scales (impact 1–5, effort weeks in (0,52]) and rejects bad values as 400s.
  const metric = readMetric(body);
  if (metric.invalid) {
    sendError(res, 400, 'invalid_metric', 'metric must be null or { label, target, baseline?, current?, unit? } with a numeric target ≠ baseline.');
    return;
  }

  const input: CreateObjectiveInput = {
    slug: rawSlug,
    title,
    start_date: typeof body.start_date === 'string' && body.start_date.trim() ? body.start_date.trim() : null,
    target_date: typeof body.target_date === 'string' && body.target_date.trim() ? body.target_date.trim() : null,
    depends_on: Array.isArray(body.depends_on) ? (body.depends_on as unknown[]).map((s) => String(s).trim()).filter(Boolean) : [],
    feature: typeof body.feature === 'string' && body.feature.trim() ? body.feature.trim() : null,
    impact: numOrNull(body.impact),
    effort: numOrNull(body.effort),
    metric: metric.present ? (metric.value ?? null) : null,
    why: typeof body.why === 'string' ? body.why : undefined,
  };

  try {
    const objective = createObjective(contextRoot, input);
    sendJson(res, 201, { objective: toPublicObjective(objective) });
  } catch (err) {
    if (err instanceof ObjectiveError) {
      // Validation / conflict from the store — a client-fixable 400, not a crash.
      sendError(res, 400, 'create_rejected', err.message);
      return;
    }
    console.error('[objectives] create failed:', err);
    sendError(res, 500, 'create_failed', 'Failed to create the objective.');
  }
}

/**
 * PATCH /api/objectives/:slug — update authored fields on one objective. Body may
 * carry any subset of { title, start_date, target_date, impact, effort, status,
 * feature }; a `null` clears an optional field. This is the persistence path for
 * timeline drag-to-reschedule (start_date/target_date) and inline edits. Dependency
 * edges are NOT set here — they go through the dependency endpoints so the store's
 * write-time cycle guard always runs. Store validation errors surface as 400s.
 */
export async function handleObjectivesUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const slug = params.slug;
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }

  const patch: UpdateObjectiveInput = {};
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
  const start = optionalDate(body, 'start_date');
  const target = optionalDate(body, 'target_date');
  if (start.invalid || target.invalid) {
    sendError(res, 400, 'invalid_date', 'start_date/target_date must be a "YYYY-MM-DD" string or null.');
    return;
  }
  if (start.present) patch.start_date = start.value;
  if (target.present) patch.target_date = target.value;
  if ('impact' in body) patch.impact = numOrNull(body.impact);
  if ('effort' in body) patch.effort = numOrNull(body.effort);
  if ('feature' in body) patch.feature = typeof body.feature === 'string' && body.feature.trim() ? body.feature.trim() : null;
  if ('status' in body) patch.status = body.status === null ? null : (String(body.status) as UpdateObjectiveInput['status']);
  const metric = readMetric(body);
  if (metric.invalid) {
    sendError(res, 400, 'invalid_metric', 'metric must be null or { label, target, baseline?, current?, unit? } with a numeric target ≠ baseline.');
    return;
  }
  if (metric.present) patch.metric = metric.value ?? null;

  try {
    const objective = updateObjective(contextRoot, slug, patch);
    sendJson(res, 200, { objective: toPublicObjective(objective) });
  } catch (err) {
    if (err instanceof ObjectiveError) {
      const notFound = /not found/i.test(err.message);
      sendError(res, notFound ? 404 : 400, notFound ? 'not_found' : 'update_rejected', err.message);
      return;
    }
    console.error('[objectives] update failed:', err);
    sendError(res, 500, 'update_failed', 'Failed to update the objective.');
  }
}

/**
 * POST /api/objectives/:slug/dependencies — declare that `:slug` depends on `to`
 * (finish-to-start edge; the roadmap draws an arrow `to → :slug`). The store runs a
 * write-time DFS cycle check and rejects unknown/self/duplicate/cycle-closing edges,
 * all of which surface here as 400s (the client toasts the message).
 */
export async function handleObjectivesAddDependency(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const slug = params.slug;
  const body = await parseJsonBody(req);
  const to = body && typeof body.to === 'string' ? body.to.trim() : '';
  if (!to) {
    sendError(res, 400, 'missing_to', 'A dependency target ("to") is required.');
    return;
  }
  if (to === slug) {
    sendError(res, 400, 'self_dependency', 'An objective cannot depend on itself.');
    return;
  }
  try {
    const objective = addDependency(contextRoot, slug, to);
    sendJson(res, 200, { objective: toPublicObjective(objective) });
  } catch (err) {
    if (err instanceof ObjectiveError) {
      const notFound = /not found/i.test(err.message);
      sendError(res, notFound ? 404 : 400, notFound ? 'not_found' : 'dependency_rejected', err.message);
      return;
    }
    console.error('[objectives] add dependency failed:', err);
    sendError(res, 500, 'dependency_failed', 'Failed to add the dependency.');
  }
}

/**
 * DELETE /api/objectives/:slug — delete an objective. Fully self-healing in the
 * store: strips the slug from every other objective's `depends_on` and from every
 * task's `objectives:` list, so no dangling reference (or orphan warning) survives.
 */
export async function handleObjectivesDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const { unhealedTasks } = deleteObjective(contextRoot, params.slug);
    sendJson(res, 200, { deleted: params.slug, unhealedTasks });
  } catch (err) {
    if (err instanceof ObjectiveError) {
      const notFound = /not found/i.test(err.message);
      sendError(res, notFound ? 404 : 400, notFound ? 'not_found' : 'delete_rejected', err.message);
      return;
    }
    console.error('[objectives] delete failed:', err);
    sendError(res, 500, 'delete_failed', 'Failed to delete the objective.');
  }
}

/** DELETE /api/objectives/:slug/dependencies/:to — remove the `to → :slug` edge. */
export async function handleObjectivesRemoveDependency(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const objective = removeDependency(contextRoot, params.slug, params.to);
    sendJson(res, 200, { objective: toPublicObjective(objective) });
  } catch (err) {
    if (err instanceof ObjectiveError) {
      const notFound = /not found/i.test(err.message);
      sendError(res, notFound ? 404 : 400, notFound ? 'not_found' : 'dependency_rejected', err.message);
      return;
    }
    console.error('[objectives] remove dependency failed:', err);
    sendError(res, 500, 'dependency_failed', 'Failed to remove the dependency.');
  }
}
