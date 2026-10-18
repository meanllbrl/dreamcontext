import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { today, slugify } from '../../lib/id.js';
import { assertTaskFilingBar, recordCycleTaskFiled, type FilingActor } from '../../lib/task-filing-bar.js';
import { parseJsonBody, requireBrowserOrigin, sendJson, sendError, writeVia } from '../middleware.js';
import { currentSyncJob, startSyncJob } from '../sync-job.js';
import { recordDashboardChange, buildFieldSummary } from '../change-tracker.js';
import type { FieldChange } from '../change-tracker.js';
import { mergeRice, validateRiceInput, type RiceFields, type RiceInput } from '../../lib/rice.js';
import { listObjectives } from '../../lib/objectives-store.js';
import { dueDateAfterStartMove, dateUpdatesForStatus } from '../../lib/task-dates.js';
import { resolveFeature, applyTaskFeatureLink } from '../../lib/feature-links.js';
import { PeopleStoreError, listPeople } from '../../lib/people-store.js';
import { developHandoffGaps } from '../../lib/handoff-readiness.js';
import { getAgent } from '../../lib/agents/store.js';
import { isSafeAutomationSlug } from '../../lib/agents/slot.js';
import { commitAssignment, prepareAssignment, type AssignmentRefusal } from '../../lib/agents/task-assignment.js';
import { currentAutomationJob, startAutomationJob } from '../automation-job.js';
import {
  loadTaskOverride,
  loadStatuses,
  readTaskOverrideRaw,
  writeTaskOverrideDoc,
  upsertCustomField,
  removeCustomField,
  upsertStatus,
  removeStatus,
  fieldKey,
  SYNC_TARGETS,
  type CustomFieldType,
  type SyncTarget,
  type StatusDefInput,
  type TaskOverride,
} from '../../lib/overrides.js';
import {
  DEFAULT_STATUSES,
  SHIPPED_STATUS_KEYS,
  STATUS_KINDS,
  isDone,
  isReview,
  isCancelled,
  normalizeStatusKey,
  statusKeys,
  type StatusKind,
} from '../../lib/task-status.js';
import { criteriaOfBody, describeGate, evidenceKind, gateStatus, parseCriteria, setCriterion } from '../../lib/task-evidence.js';
import { checkParentLink, loadFamily, parentCloseBlock, rollupOf } from '../../lib/task-parent.js';
import { newJournalEntryId, type NewJournalEntry } from '../../lib/task-journal.js';
import { resolveActivePerson } from '../../lib/people-resolve.js';
import { checkCloseGate } from '../../lib/sleep-eval/report.js';
import { ensureLocalStateIgnored, recordAudit } from '../../lib/task-audit.js';
import { listTaskCards } from '../../lib/task-list.js';
import { applyVerdict } from '../../lib/task-verdict.js';
import { planTask, rankTask } from '../../lib/task-plan.js';
import {
  getTaskBackend,
  getTaskSyncStatus,
  isSafeTaskSlug,
  TaskBackendError,
  type TaskBackend,
  type TaskData,
  type TaskDetailResponse,
  type TaskListItem,
  type RemoteMember,
} from '../../lib/task-backend/index.js';

/** API view of a task: TaskData minus the backend-internal raw fields. */
function toApiTask(task: TaskData): Omit<TaskData, 'raw' | 'rawBody'> {
  const { raw: _raw, rawBody: _rawBody, ...api } = task;
  return api;
}

function backendFor(contextRoot: string): TaskBackend {
  return getTaskBackend(contextRoot);
}

/**
 * Validate + coerce a `custom_fields` patch against the project's override
 * schema (`overrides/task.md`). With an override present, an undeclared key is
 * rejected and values are coerced/validated by type (number, select options).
 * With no override, the patch is accepted as-is (string-coerced) so the field
 * surface still works for ad-hoc use. `null`/`''` clears a field.
 */
function validateCustomFields(
  contextRoot: string,
  raw: unknown,
): { ok: true; value: Record<string, string | number | null> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'custom_fields must be an object.' };
  }
  const defs = loadTaskOverride(contextRoot)?.customFields ?? [];
  const byKey = new Map(defs.map((d) => [d.key, d] as const));
  const out: Record<string, string | number | null> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const def = byKey.get(key);
    if (defs.length > 0 && !def) {
      return { ok: false, error: `Unknown custom field "${key}" (declared: ${defs.map((d) => d.key).join(', ') || '(none)'}).` };
    }
    if (val === null || val === '') { out[key] = null; continue; }
    if (def?.type === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n)) return { ok: false, error: `Custom field "${key}" must be a number.` };
      out[key] = n;
    } else if (def?.type === 'select' && def.options && def.options.length > 0) {
      const match = def.options.find((o) => o.toLowerCase() === String(val).toLowerCase());
      if (!match) return { ok: false, error: `Custom field "${key}" must be one of: ${def.options.join(', ')}.` };
      out[key] = match;
    } else {
      out[key] = String(val);
    }
  }
  return { ok: true, value: out };
}

/**
 * The override payload every /api/task-overrides* route answers with: the
 * custom-field defs, the EFFECTIVE status set (the shipped four when no
 * override exists — the dashboard always has a set to render), the keys that
 * are locked (shipped), and the validation warnings.
 */
function overridePayload(ov: TaskOverride | null): Record<string, unknown> {
  return {
    present: ov !== null,
    customFields: ov?.customFields ?? [],
    statuses: ov?.statuses ?? DEFAULT_STATUSES.map((s) => ({ ...s })),
    shippedStatusKeys: SHIPPED_STATUS_KEYS,
    warnings: ov?.warnings ?? [],
  };
}

/**
 * GET /api/task-overrides — the active task override schema (custom-field defs,
 * the status set + presence), so the dashboard can render typed inputs and
 * status-aware columns. Absent → no fields, the shipped four statuses.
 */
export async function handleTaskOverrides(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, overridePayload(loadTaskOverride(contextRoot)));
}

/** GET /api/task-overrides/doc — the RAW override markdown (for the Settings editor). */
export async function handleTaskOverrideDocGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const raw = readTaskOverrideRaw(contextRoot);
  const ov = loadTaskOverride(contextRoot);
  sendJson(res, 200, { ...overridePayload(ov), present: raw !== '', raw });
}

/** PUT /api/task-overrides/doc — write the RAW override markdown verbatim. */
export async function handleTaskOverrideDocSave(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body || typeof body.raw !== 'string') {
    sendError(res, 400, 'invalid_body', 'Body must be { raw: string }.');
    return;
  }
  const MAX = 256 * 1024;
  if (Buffer.byteLength(body.raw, 'utf-8') > MAX) {
    sendError(res, 413, 'too_large', `Override exceeds ${MAX} bytes.`);
    return;
  }
  let ov: ReturnType<typeof writeTaskOverrideDoc>;
  try {
    ov = writeTaskOverrideDoc(contextRoot, body.raw);
  } catch (err) {
    // A filesystem failure must not bubble up as an unhandled 500 with a raw
    // err.message (which would leak the override path). Log + generic body.
    console.error('[task-overrides] write failed:', err);
    sendError(res, 500, 'write_failed', 'Failed to write the task override.');
    return;
  }
  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'update',
    target: 'overrides/task.md',
    summary: 'Edited the task format override',
  });
  sendJson(res, 200, overridePayload(ov));
}

const FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'select', 'date'];

/** POST /api/task-overrides/fields — add or replace ONE custom-field definition. */
export async function handleTaskOverrideAddField(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) { sendError(res, 400, 'invalid_body', 'Request body must be JSON.'); return; }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) { sendError(res, 400, 'missing_name', 'Field name is required.'); return; }

  const type = String(body.type ?? 'text').toLowerCase() as CustomFieldType;
  if (!FIELD_TYPES.includes(type)) {
    sendError(res, 400, 'invalid_type', `type must be one of: ${FIELD_TYPES.join(', ')}`);
    return;
  }

  const key = typeof body.key === 'string' && body.key.trim() ? fieldKey(body.key) : fieldKey(name);
  if (!key) { sendError(res, 400, 'invalid_key', 'Field id could not be derived.'); return; }

  const options = Array.isArray(body.options)
    ? body.options.map((o: unknown) => String(o).trim()).filter(Boolean)
    : undefined;
  if (type === 'select' && (!options || options.length === 0)) {
    sendError(res, 400, 'missing_options', 'A select field needs at least one option.');
    return;
  }

  const sync = Array.isArray(body.sync)
    ? body.sync.map((s: unknown) => String(s).toLowerCase()).filter((s: string): s is SyncTarget => (SYNC_TARGETS as string[]).includes(s))
    : undefined;

  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : undefined;
  const required = body.required === true;
  const ask = body.ask === true;

  const ov = upsertCustomField(contextRoot, { name, key, type, required, options, sync, prompt, ask });
  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'update',
    target: 'overrides/task.md',
    summary: `Defined custom field '${name}' (${type})`,
  });
  sendJson(res, 200, overridePayload(ov));
}

/** DELETE /api/task-overrides/fields/:key — remove a custom-field definition. */
export async function handleTaskOverrideRemoveField(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const ov = removeCustomField(contextRoot, params.key ?? '');
  sendJson(res, 200, overridePayload(ov));
}

/**
 * POST /api/task-overrides/statuses — add or replace ONE status definition
 * (matched by key). A shipped key may be relabelled / reordered / recoloured
 * but never re-kinded; a new status needs a kind (never `done`).
 */
export async function handleTaskOverrideAddStatus(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) { sendError(res, 400, 'invalid_body', 'Request body must be JSON.'); return; }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const keyRaw = typeof body.key === 'string' ? body.key.trim() : '';
  if (!name && !keyRaw) { sendError(res, 400, 'missing_name', 'Status name is required.'); return; }
  const kind = body.kind === undefined || body.kind === null || body.kind === '' ? undefined : String(body.kind).toLowerCase();
  if (kind !== undefined && !(STATUS_KINDS as readonly string[]).includes(kind)) {
    sendError(res, 400, 'invalid_kind', `kind must be one of: ${STATUS_KINDS.join(', ')}`);
    return;
  }
  const parent = typeof body.parent === 'string' && body.parent.trim() ? body.parent.trim() : undefined;
  if (parent !== undefined && !SHIPPED_STATUS_KEYS.includes(normalizeStatusKey(parent))) {
    sendError(res, 400, 'invalid_parent', `parent must be one of: ${SHIPPED_STATUS_KEYS.join(', ')}`);
    return;
  }
  const order = body.order === undefined || body.order === null || body.order === '' ? undefined : Number(body.order);
  if (order !== undefined && !Number.isFinite(order)) { sendError(res, 400, 'invalid_order', 'order must be a number.'); return; }
  const color = typeof body.color === 'string' && body.color.trim() ? body.color.trim() : undefined;
  const remoteAliases = Array.isArray(body.remoteAliases) ? body.remoteAliases.map((a: unknown) => String(a).trim()).filter(Boolean) : undefined;
  const input: StatusDefInput = { name: name || keyRaw, key: keyRaw || undefined, kind: kind as StatusKind | undefined, parent, order, color, remoteAliases };
  let ov: TaskOverride;
  try {
    ov = upsertStatus(contextRoot, input);
  } catch (err) {
    sendError(res, 400, 'invalid_status_def', (err as Error).message);
    return;
  }
  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'update',
    target: 'overrides/task.md',
    summary: `Defined task status '${input.name}'${kind ? ` (${kind})` : ''}`,
  });
  sendJson(res, 200, overridePayload(ov));
}

/**
 * DELETE /api/task-overrides/statuses/:key — remove a DECLARED status. 400 for
 * a shipped key (locked), 409 with the in-use count while any task still
 * carries the status (the dashboard has no reassignment flow — the user moves
 * those tasks first, then the delete goes through).
 */
export async function handleTaskOverrideRemoveStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const key = normalizeStatusKey(params.key ?? '');
  if (!key) { sendError(res, 400, 'invalid_key', 'Status key is required.'); return; }
  if (SHIPPED_STATUS_KEYS.includes(key)) {
    sendError(res, 400, 'shipped_status', `Shipped status "${key}" cannot be removed.`);
    return;
  }
  const inUse = (await backendFor(contextRoot).list({ status: key })).length;
  if (inUse > 0) {
    sendError(res, 409, 'status_in_use', `${inUse} task(s) still carry status "${key}" — move them first.`);
    return;
  }
  let ov: TaskOverride | null;
  try {
    ov = removeStatus(contextRoot, key);
  } catch (err) {
    sendError(res, 400, 'invalid_status_def', (err as Error).message);
    return;
  }
  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'update',
    target: 'overrides/task.md',
    summary: `Removed task status '${key}'`,
  });
  sendJson(res, 200, overridePayload(ov));
}

/**
 * GET /api/tasks - List all tasks
 */
export async function handleTasksList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  // Cards only (plan r3 § W4): no body, section or journal. The task page reads
  // GET /api/tasks/:slug; this list is polled by every open window.
  const tasks: TaskListItem[] = listTaskCards(join(contextRoot, 'state'), loadStatuses(contextRoot));
  sendJson(res, 200, { tasks });
}

/**
 * POST /api/tasks - Create a new task
 */
export async function handleTasksCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  const name = body.name as string;
  if (!name || typeof name !== 'string' || !name.trim()) {
    sendError(res, 400, 'missing_name', 'Task name is required.');
    return;
  }

  const description = (body.description as string) ?? '';
  const priority = (body.priority as string) ?? 'medium';
  const urgency = (body.urgency as string) ?? 'medium';
  const tags = Array.isArray(body.tags) ? body.tags as string[] : [];
  // Every task records why it exists (created_at covers the "when") — reject
  // empty scaffolds from the dashboard the same way the CLI does.
  const why = typeof body.why === 'string' ? body.why.trim() : '';
  if (!why) {
    sendError(res, 400, 'missing_why', 'Every task must say why it exists — provide a non-empty "why".');
    return;
  }
  const version = (body.version as string) ?? null;

  const validPriorities = ['critical', 'high', 'medium', 'low'];
  if (!validPriorities.includes(priority)) {
    sendError(res, 400, 'invalid_priority', `Priority must be one of: ${validPriorities.join(', ')}`);
    return;
  }

  if (!validPriorities.includes(urgency)) {
    sendError(res, 400, 'invalid_urgency', `Urgency must be one of: ${validPriorities.join(', ')}`);
    return;
  }

  let riceBlock: RiceFields | null = null;
  if (body.rice !== undefined && body.rice !== null) {
    const riceInput = body.rice as RiceInput;
    const errs = validateRiceInput(riceInput);
    if (errs.length > 0) {
      sendError(res, 400, 'invalid_rice', errs.map(e => `${e.field}: ${e.message}`).join('; '));
      return;
    }
    riceBlock = mergeRice(null, riceInput);
  }

  // Optional date range — validated YYYY-MM-DD (or absent). Synced to the remote
  // backend like any other field; the backend enforces the backlog-undated rule.
  const isYmdDate = (v: unknown): v is string =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  let startDate: string | null = null;
  let dueDate: string | null = null;
  for (const [key, set] of [['start_date', (v: string) => { startDate = v; }], ['due_date', (v: string) => { dueDate = v; }]] as const) {
    if (body[key] !== undefined && body[key] !== null) {
      if (!isYmdDate(body[key])) {
        sendError(res, 400, `invalid_${key}`, `${key} must be YYYY-MM-DD or null.`);
        return;
      }
      set(body[key] as string);
    }
  }
  if (startDate && dueDate && startDate > dueDate) {
    sendError(res, 400, 'invalid_date_range', `start_date (${startDate}) cannot be after due_date (${dueDate}).`);
    return;
  }

  // Optional override-declared custom fields, validated against the schema.
  let customFields: Record<string, string | number | null> | undefined;
  if (body.custom_fields !== undefined && body.custom_fields !== null) {
    const v = validateCustomFields(contextRoot, body.custom_fields);
    if (!v.ok) { sendError(res, 400, 'invalid_custom_fields', v.error); return; }
    customFields = v.value;
  }

  // The SAME filing bar the CLI enforces — this route creates tasks without
  // going through the CLI at all, so without this call it would be the hole in
  // the gate. The actor defaults to `human`: the dashboard's "Add Task" form is
  // a person, and a person filing during a background cycle is legitimate. An
  // in-app agent action that files during a cycle passes `by: 'sleep'`.
  // The bar's SEMANTIC gates (neighbor + declined) therefore only ever run for
  // `by: 'sleep'`: the `human` default short-circuits inside the bar before any
  // read or embed, so the dashboard's own form never pays a model load. Both of
  // those gates are LIFTABLE by naming what you looked at, so this surface has to
  // forward both proofs — refusing an agent with "re-run with --declined-checked"
  // over an API that cannot carry it would make gate 6 a dead end here.
  const actor: FilingActor = body.by === 'sleep' ? 'sleep' : 'human';
  const verdict = await assertTaskFilingBar({
    contextRoot,
    actor,
    why,
    slug: slugify(name.trim()),
    name: name.trim(),
    description,
    neighborChecked: typeof body.neighborChecked === 'string' ? body.neighborChecked : undefined,
    declinedChecked: typeof body.declinedChecked === 'string' ? body.declinedChecked : undefined,
  });
  if (!verdict.allowed) {
    sendError(res, 400, 'filing_bar', verdict.reason ?? 'Refused by the sleep task-filing bar.');
    return;
  }

  const backend = backendFor(contextRoot);
  let task: TaskData;
  try {
    task = await backend.create({
      name: name.trim(),
      description,
      priority,
      urgency,
      tags,
      why,
      version,
      rice: riceBlock,
      start_date: startDate,
      due_date: dueDate,
      ...(customFields ? { custom_fields: customFields } : {}),
      variant: 'dashboard',
    });
  } catch (err) {
    if (err instanceof TaskBackendError && err.code === 'already_exists') {
      sendError(res, 409, 'already_exists', err.message);
      return;
    }
    throw err;
  }

  if (verdict.underBar) recordCycleTaskFiled(contextRoot, task.slug);

  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'create',
    target: `state/${task.slug}.md`,
    summary: `Created task '${name.trim()}' with priority ${priority}`,
  });

  sendJson(res, 201, { task: toApiTask(task) });
}

/**
 * GET /api/tasks/sync-status — sync badge data (backend, pending, conflicts).
 */
export async function handleTasksSyncStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, { status: getTaskSyncStatus(contextRoot) });
}

/**
 * POST /api/tasks/sync — trigger a sync (manual dashboard action).
 */
export async function handleTasksSync(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = (await parseJsonBody(req)) ?? {};
  const direction = (body.direction as string) ?? 'both';
  if (!['push', 'pull', 'both'].includes(direction)) {
    sendError(res, 400, 'invalid_direction', 'direction must be push, pull, or both.');
    return;
  }
  const report = await getTaskBackend(contextRoot).sync(direction as 'push' | 'pull' | 'both');
  sendJson(res, 200, { report });
}

/**
 * POST /api/tasks/sync-jobs — start a BACKGROUND sync job (body: `direction`,
 * and `hard: true` for a hard refresh: wipe local mirrors + ledger, full
 * re-pull from the remote). Returns the job immediately; a job already running
 * is adopted (`started: false`), never doubled. The job survives navigation —
 * it belongs to the server process and runs until it settles.
 */
export async function handleTasksSyncJobStart(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = (await parseJsonBody(req)) ?? {};
  const direction = (body.direction as string) ?? 'both';
  if (!['push', 'pull', 'both'].includes(direction)) {
    sendError(res, 400, 'invalid_direction', 'direction must be push, pull, or both.');
    return;
  }
  const backend = getTaskBackend(contextRoot);
  if (backend.name === 'local') {
    sendError(res, 400, 'no_remote_backend', 'No remote task backend configured — nothing to sync.');
    return;
  }
  const kind = body.hard === true ? 'hard-refresh' : 'sync';
  const { job, started } = startSyncJob(contextRoot, kind, direction as 'push' | 'pull' | 'both');
  sendJson(res, 200, { job, started });
}

/** GET /api/tasks/sync-jobs/current — poll the latest job's live state. */
export async function handleTasksSyncJobStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  sendJson(res, 200, { job: currentSyncJob(contextRoot) });
}

/**
 * POST /api/tasks/sync-test — remote connection test (Settings page).
 */
export async function handleTasksSyncTest(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const backend = getTaskBackend(contextRoot);
  if (!backend.testConnection) {
    sendJson(res, 200, { ok: true, backend: backend.name, note: 'Local backend — no remote to test.' });
    return;
  }
  const result = await backend.testConnection();
  sendJson(res, 200, { ...result, backend: backend.name });
}

/** Title-case a kebab slug for display: "kerem-yilmaz" → "Kerem Yilmaz". */
function slugToName(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * The vault roster (`people/people.json`) as assignee candidates. This is the
 * source on LOCAL projects (no remote member list), so the dashboard can offer a
 * people dropdown instead of forcing the user to type `person:<slug>`.
 *
 * D17 read-path rule: a corrupt roster degrades to NO candidates, not a 500 —
 * `/api/tasks/members` still answers 200 (the picker falls back to the people
 * already tagged on local tasks) and `doctor` is the loud channel.
 */
function rosterMembers(contextRoot: string): RemoteMember[] {
  let roster: Array<{ slug: string; name: string }>;
  try {
    roster = listPeople(contextRoot);
  } catch (err) {
    if (!(err instanceof PeopleStoreError)) throw err;
    console.warn(`[tasks] people/people.json unreadable (${err.message}) — assignee roster empty. Run \`dreamcontext doctor\`.`);
    return [];
  }
  // Roster candidates are keyed by slug — that slug becomes the `person:<slug>`
  // tag. The remote member id (if any) is resolved inside the backend at sync
  // time, so the route stays provider-agnostic and carries no remote id here.
  return roster.map((person) => ({
    slug: person.slug,
    id: '',
    name: person.name,
  }));
}

/**
 * People already referenced as assignees across local tasks — the distinct set
 * of `person:<slug>` tags (plus any legacy scalar `assignee`). These are the
 * truth of who is actually assigned, so the picker stays populated even when no
 * remote backend and no `.config.json` roster exist (i.e. cloud task management
 * is off). Without this, a local-only project shows an empty assignee dropdown
 * and assigning feels disabled.
 */
async function taskAssigneeMembers(backend: TaskBackend): Promise<RemoteMember[]> {
  const slugs = new Set<string>();
  try {
    for (const summary of await backend.list()) {
      const task = await backend.get(summary.name);
      if (!task) continue;
      for (const tag of task.tags ?? []) {
        if (tag.startsWith('person:')) slugs.add(tag.slice('person:'.length));
      }
      if (task.assignee) slugs.add(task.assignee); // legacy scalar fallback
    }
  } catch {
    return []; // never block the picker on a list/read failure
  }
  return [...slugs].map((slug) => ({ slug, id: '', name: slugToName(slug) }));
}

/**
 * GET /api/tasks/members — assignee candidates. Merges remote members (when a
 * remote backend exposes them) with the local project roster, keyed by slug so
 * a person appears once. Remote entries win (they carry a real member id).
 *
 * On a REMOTE backend whose member roster is known, only member-backed
 * candidates are returned: roster/task-derived stubs (id '') that match no real
 * member are dropped. Offering them is the bug — picking one mints a
 * `person:<slug>` tag that resolves to no member and is silently dropped on
 * push (the remote then defaults the assignee to the API-token owner). On a
 * LOCAL backend (or a remote one whose members are momentarily unavailable) the
 * stubs are kept, because there free-text assignment is harmless and the
 * alternative is an empty, seemingly-broken picker.
 */
export async function handleTasksMembers(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const backend = backendFor(contextRoot);
  let remote: RemoteMember[] = [];
  if (backend.listMembers) {
    try {
      remote = await backend.listMembers();
    } catch {
      remote = []; // offline/unconfigured → fall back to the roster, not an error
    }
  }
  const bySlug = new Map<string, RemoteMember>();
  for (const m of rosterMembers(contextRoot)) bySlug.set(m.slug, m);
  // People already assigned on local tasks — keeps the picker usable when cloud
  // task management is off (no remote members) and the roster is unconfigured.
  for (const m of await taskAssigneeMembers(backend)) {
    if (!bySlug.has(m.slug)) bySlug.set(m.slug, m);
  }
  for (const m of remote) bySlug.set(m.slug, m); // remote wins (real member id)

  let members = [...bySlug.values()];
  // Remote backend WITH a known member roster → assignees must round-trip to a
  // real member, so non-member stubs (id '') are not offered. Gate on a
  // non-empty `remote` so a transient empty fetch doesn't blank the picker.
  if (backend.listMembers && remote.length > 0) {
    members = members.filter((m) => m.id !== '');
  }
  sendJson(res, 200, { members });
}

/**
 * GET /api/tasks/containers — pickable remote lists (Settings onboarding).
 */
export async function handleTasksContainers(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const backend = backendFor(contextRoot);
  if (!backend.discoverContainers) {
    sendJson(res, 200, { containers: [] });
    return;
  }
  try {
    sendJson(res, 200, { containers: await backend.discoverContainers() });
  } catch (err) {
    sendJson(res, 200, { containers: [], error: (err as Error).message });
  }
}

/**
 * POST /api/tasks/provision — create the recommended remote fields.
 *
 * Body `{ dryRun: true }` PREVIEWS the change (reports what would be created vs
 * what already exists) without mutating the remote — the Settings page shows
 * this before the user commits to actually provisioning.
 */
export async function handleTasksProvision(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = (await parseJsonBody(req)) ?? {};
  const dryRun = body.dryRun === true;
  const backend = backendFor(contextRoot);
  if (!backend.provisionRemote) {
    sendError(res, 400, 'not_supported', `Task backend "${backend.name}" has no remote to provision.`);
    return;
  }
  sendJson(res, 200, { result: await backend.provisionRemote({ dryRun }) });
}

/**
 * GET /api/tasks/token-status — report whether an API token is configured for
 * the ACTIVE remote backend (and where it comes from), WITHOUT echoing the
 * secret. Lets the Settings page show "key set ✓ (••••1234)" vs "no key". Stays
 * provider-agnostic: the backend owns the resolve+mask logic.
 */
export async function handleTasksTokenStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const backend = backendFor(contextRoot);
  const status = backend.tokenStatus
    ? backend.tokenStatus()
    : { set: false, source: null, masked: null };
  sendJson(res, 200, { backend: backend.name, ...status });
}

/**
 * POST /api/tasks/token — store the API token for the ACTIVE remote backend into
 * its gitignored secrets store (never `.config.json`). Body `{ token }`. The
 * token is never logged or echoed back; the response only confirms it was
 * written. Provider-agnostic: each backend owns where its own token lives.
 */
export async function handleTasksSetToken(
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
  const token = body.token;
  if (typeof token !== 'string' || !token.trim()) {
    sendError(res, 400, 'invalid_token', 'token must be a non-empty string.');
    return;
  }
  const backend = backendFor(contextRoot);
  if (!backend.setToken) {
    sendError(res, 400, 'not_supported', `Task backend "${backend.name}" has no remote token to set.`);
    return;
  }
  try {
    backend.setToken(token.trim());
  } catch (err) {
    // The secrets writer aborts (writing nothing) if it cannot gitignore the
    // file first — surface that as a server error, never a silent success.
    sendError(res, 500, 'token_write_failed', (err as Error).message ?? String(err));
    return;
  }
  sendJson(res, 200, { ok: true, backend: backend.name });
}

/**
 * DELETE /api/tasks/:slug — delete a task (remote deletion propagates on sync).
 */
export async function handleTasksDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }

  const backend = backendFor(contextRoot);
  if ((await backend.get(slug)) === null) {
    sendError(res, 404, 'not_found', `Task not found: ${slug}`);
    return;
  }

  try {
    await backend.delete(slug);
  } catch (err) {
    // A parent with live sub-tasks is refused by the backend.
    if (err instanceof TaskBackendError && err.code === 'invalid_input') {
      sendError(res, 409, 'subtasks_open', err.message);
      return;
    }
    throw err;
  }

  // Consolidation must see deletions too — recorded into the sleep state's
  // dashboard-changes ledger like every other dashboard mutation.
  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'delete',
    target: `state/${slug}.md`,
    summary: `Deleted task '${slug}'`,
  });

  sendJson(res, 200, { success: true });
}

/**
 * GET /api/tasks/:slug - Get a single task
 */
export async function handleTasksGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }

  const task = await backendFor(contextRoot).get(slug);
  if (!task) {
    sendError(res, 404, 'not_found', `Task not found: ${slug}`);
    return;
  }

  sendJson(res, 200, taskDetail(contextRoot, task));
}

/** The task page's view of one task: the card, its parsed criteria, its parent and children. */
function taskDetail(contextRoot: string, task: TaskData): TaskDetailResponse {
  const stateDir = join(contextRoot, 'state');
  const defs = loadStatuses(contextRoot);
  const family = loadFamily(stateDir);
  const parentSlug = family.parentOf.get(task.slug) ?? null;
  const parent = parentSlug ? family.bySlug.get(parentSlug) ?? null : null;
  const kidSlugs = new Set((family.children.get(task.slug) ?? []).map((c) => c.slug));
  const children = kidSlugs.size > 0 ? listTaskCards(stateDir, defs).filter((c) => kidSlugs.has(c.slug)) : [];
  return {
    task: {
      ...toApiTask(task),
      cycle: task.cycle ?? null,
      queue: task.queue ?? null,
      rank: task.rank ?? null,
      criteria: parseCriteria(task.acceptance_criteria).map((c) => ({
        n: c.n,
        text: c.text,
        checked: c.checked,
        ref: c.evidence,
        kind: evidenceKind(c.evidence),
        observed: c.observed,
      })),
      parent: parent ? { slug: parent.slug, name: parent.name, status: parent.status } : null,
      children,
    },
  };
}

/**
 * GET /api/tasks/:slug/readiness — may this task be handed to a fresh Develop session?
 *
 * The Plan → Develop button calls this BEFORE it opens the session: the new session
 * inherits nothing but the task file, so a plan that never reached the file is lost.
 * Same check as `dreamcontext tasks ready` (lib/handoff-readiness.ts). Always 200 for a
 * real task — "not ready" is an answer, not an error.
 */
export async function handleTasksReadiness(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }

  const task = await backendFor(contextRoot).get(slug);
  if (!task) {
    sendError(res, 404, 'not_found', `Task not found: ${slug}`);
    return;
  }

  const gaps = developHandoffGaps(task);
  sendJson(res, 200, { ready: gaps.length === 0, gaps });
}

/**
 * PATCH /api/tasks/:slug - Update task fields
 */
export async function handleTasksUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }

  const backend = backendFor(contextRoot);
  // Read old values BEFORE mutation for change tracking
  const existing = await backend.get(slug);
  if (!existing) {
    sendError(res, 404, 'not_found', `Task not found: ${slug}`);
    return;
  }

  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  const oldData = existing.raw;
  const oldContent = existing.rawBody;

  const updates: Record<string, unknown> = {};
  const fieldChanges: FieldChange[] = [];
  let bodyChanged = false;
  let newBody: string | null = null;

  // Body update: replaces the full markdown body (everything after frontmatter).
  // Used by the dashboard for inline edits like acceptance-criteria checkbox
  // toggles + the synced mermaid flowchart node status updates.
  if (body.body !== undefined) {
    if (typeof body.body !== 'string') {
      sendError(res, 400, 'invalid_body_field', 'body must be a string');
      return;
    }
    // Length-bound to prevent runaway / abusive writes. 1 MB is generous for a
    // single task markdown body (typical task is <10 KB).
    const MAX_BODY_BYTES = 1024 * 1024;
    if (Buffer.byteLength(body.body, 'utf-8') > MAX_BODY_BYTES) {
      sendError(res, 413, 'body_too_large', `body exceeds ${MAX_BODY_BYTES} byte limit`);
      return;
    }
    // Sanitize: gray-matter treats a leading `---` (or `...`) as a frontmatter
    // delimiter when round-tripping. If the body's first non-blank line is
    // `---` or `...`, the next read would parse the body's delimiter as a
    // SECOND frontmatter block and truncate the body. Prepend a blank line in
    // that case — markdown renders identically (leading blanks collapse).
    let sanitized = body.body;
    const firstNonBlank = sanitized.split('\n').find(l => l.trim().length > 0);
    if (firstNonBlank !== undefined && /^(-{3,}|\.{3,})\s*$/.test(firstNonBlank.trim())) {
      sanitized = '\n' + sanitized;
    }
    if (sanitized !== oldContent) {
      newBody = sanitized;
      bodyChanged = true;
      fieldChanges.push({
        field: 'body',
        from: null,
        to: null,
      });
    }
  }

  // `objectives` (roadmap many-to-many, local-only) is PATCHable so the dashboard
  // can link tasks to objectives; the sync mappers never read it, so it stays local.
  // `agent` (local-only, never a person and never synced) may be set to an
  // existing agent's slug or cleared with null. Setting it here does NOT run the
  // agent: that is `POST /:slug/assign-agent`.
  if (body.agent !== undefined && body.agent !== null) {
    if (typeof body.agent !== 'string' || !isSafeAutomationSlug(body.agent) || !getAgent(contextRoot, body.agent)) {
      sendError(res, 400, 'invalid_agent', 'agent must be the slug of an agent in this project, or null.');
      return;
    }
  }
  const allowedFields = ['status', 'priority', 'urgency', 'description', 'tags', 'name', 'related_feature', 'version', 'start_date', 'due_date', 'objectives', 'assignee', 'agent', 'parent_task'];
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      const oldVal = (oldData[field] ?? null) as FieldChange['from'];
      const newVal = body[field] as FieldChange['to'];
      // Skip no-ops where value is unchanged
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        updates[field] = body[field];
        fieldChanges.push({ field, from: oldVal, to: newVal });
      }
    }
  }

  // RICE update: either a partial object (merge) or null (clear).
  if (body.rice !== undefined) {
    const existingRice = existing.rice;
    let next: RiceFields | null;
    if (body.rice === null) {
      next = null;
    } else if (typeof body.rice === 'object') {
      const riceInput = body.rice as RiceInput;
      const errs = validateRiceInput(riceInput);
      if (errs.length > 0) {
        sendError(res, 400, 'invalid_rice', errs.map(e => `${e.field}: ${e.message}`).join('; '));
        return;
      }
      next = mergeRice(existingRice, riceInput);
    } else {
      sendError(res, 400, 'invalid_rice', 'rice must be an object or null');
      return;
    }
    if (JSON.stringify(existingRice) !== JSON.stringify(next)) {
      updates.rice = next;
      fieldChanges.push({
        field: 'rice',
        from: existingRice as FieldChange['from'],
        to: next as FieldChange['to'],
      });
    }
  }

  // Custom-field update: a partial patch is validated then MERGED onto the
  // existing map (so other fields survive). `null`/`''` clears one field.
  if (body.custom_fields !== undefined && body.custom_fields !== null) {
    const v = validateCustomFields(contextRoot, body.custom_fields);
    if (!v.ok) { sendError(res, 400, 'invalid_custom_fields', v.error); return; }
    const existingCf = existing.custom_fields ?? {};
    const merged = { ...existingCf, ...v.value };
    if (JSON.stringify(existingCf) !== JSON.stringify(merged)) {
      updates.custom_fields = merged;
      fieldChanges.push({
        field: 'custom_fields',
        from: existingCf as FieldChange['from'],
        to: merged as FieldChange['to'],
      });
    }
  }

  if (fieldChanges.length === 0) {
    sendError(res, 400, 'no_changes', 'No valid fields to update.');
    return;
  }

  // Validate assignee (person slug string or null to clear)
  if (updates.assignee !== undefined && updates.assignee !== null && typeof updates.assignee !== 'string') {
    sendError(res, 400, 'invalid_assignee', 'assignee must be a string or null.');
    return;
  }

  // Validate start_date / due_date (YYYY-MM-DD or null to clear). Both ride the
  // same shape and both sync to the remote backend.
  const isYmd = (v: unknown): v is string =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  for (const dateField of ['start_date', 'due_date'] as const) {
    if (updates[dateField] !== undefined && updates[dateField] !== null && !isYmd(updates[dateField])) {
      sendError(res, 400, `invalid_${dateField}`, `${dateField} must be YYYY-MM-DD or null.`);
      return;
    }
  }
  /**
   * Record a date this handler derived (a status stamp, a reschedule) rather
   * than one the caller sent. REPLACES any earlier entry for the same field so
   * the change tracker never logs an intermediate value that never hit disk.
   */
  const deriveDate = (field: 'start_date' | 'due_date', value: string): void => {
    updates[field] = value;
    const existingChange = fieldChanges.find((c) => c.field === field);
    if (existingChange) existingChange.to = value;
    else fieldChanges.push({ field, from: (existing[field] ?? null) as FieldChange['from'], to: value });
  };

  // Validate status. Stamping runs BEFORE the range check below, so a stamped
  // start is validated like any other — a patch that pairs a status change with
  // an inverted explicit due date is rejected instead of writing start>due.
  if (updates.status) {
    const statuses = loadStatuses(contextRoot);
    const validStatuses = statusKeys(statuses);
    if (!validStatuses.includes(updates.status as string)) {
      sendError(res, 400, 'invalid_status', `Status must be one of: ${validStatuses.join(', ')}`);
      return;
    }
    // The sleep-eval close gate, the same one `tasks status`/`tasks complete` apply.
    if (isDone(statuses, updates.status)) {
      const gate = checkCloseGate(contextRoot, slug, existing.parent_task ?? null);
      if (gate.applies && !gate.ok) {
        sendError(res, 409, 'sleep_eval_gate', gate.message);
        return;
      }
    }
    // Same real-world timing the CLI stamps on a status change, so a task dragged
    // across the board records the same dates as `dreamcontext tasks status`:
    // `in_progress` stamps the actual start (rescheduling a now-impossible due
    // date), `completed` stamps the actual end. A date explicitly named in THIS
    // patch always wins over the stamp.
    const stamped = dateUpdatesForStatus(
      updates.status as string,
      {
        start_date: (updates.start_date !== undefined ? updates.start_date : existing.start_date) as string | null,
        due_date: (updates.due_date !== undefined ? updates.due_date : existing.due_date) as string | null,
      },
      today(),
      statuses,
    );
    for (const field of ['start_date', 'due_date'] as const) {
      const value = stamped[field];
      if (value === undefined || body[field] !== undefined) continue;
      deriveDate(field, value);
    }
  }

  // Range sanity: the EFFECTIVE start (after this patch) must not be after the
  // effective due. A backlog task clears both in the backend, so only check when
  // both resolve to a real date here.
  //
  // A start-only move (the detail panel's start picker, a CLI-equivalent patch)
  // RESCHEDULES the due date rather than failing — pushed just far enough to keep
  // the window's original length, per lib/task-dates.ts. Only a patch that names
  // the due end and still inverts it is the caller contradicting itself, and that
  // is still rejected.
  {
    const duePatched = body.due_date !== undefined;
    const effStart = updates.start_date !== undefined ? updates.start_date : existing.start_date;
    const effDue = updates.due_date !== undefined ? updates.due_date : existing.due_date;
    if (isYmd(effStart) && isYmd(effDue) && effStart > effDue) {
      const shifted = duePatched
        ? null
        : dueDateAfterStartMove(existing.start_date, existing.due_date, effStart);
      // The computed date is validated like any client-supplied one. Past year
      // 9999 `toISOString()` switches to the extended ±YYYYYY form and the
      // slice yields "+019996-01" — a string that fails every `isCalendarDate`
      // downstream. Every OTHER date on this route passes `isYmd`; this is the
      // one that is derived rather than sent, so it has to be checked here or
      // it reaches disk unchecked.
      if (!shifted || !isYmd(shifted)) {
        sendError(res, 400, 'invalid_date_range', `start_date (${effStart}) cannot be after due_date (${effDue}).`);
        return;
      }
      deriveDate('due_date', shifted);
    }
  }

  // Validate priority
  if (updates.priority) {
    const validPriorities = ['critical', 'high', 'medium', 'low'];
    if (!validPriorities.includes(updates.priority as string)) {
      sendError(res, 400, 'invalid_priority', `Priority must be one of: ${validPriorities.join(', ')}`);
      return;
    }
  }

  // Validate urgency
  if (updates.urgency) {
    const validUrgencies = ['critical', 'high', 'medium', 'low'];
    if (!validUrgencies.includes(updates.urgency as string)) {
      sendError(res, 400, 'invalid_urgency', `Urgency must be one of: ${validUrgencies.join(', ')}`);
      return;
    }
  }

  // Validate objectives — write-time integrity, mirroring the CLI: a task can
  // only reference roadmap objectives that exist ([] clears).
  if (updates.objectives !== undefined) {
    if (!Array.isArray(updates.objectives) || updates.objectives.some((s) => typeof s !== 'string')) {
      sendError(res, 400, 'invalid_objectives', 'objectives must be an array of objective slugs.');
      return;
    }
    const known = new Set(listObjectives(contextRoot).map((o) => o.slug));
    const unknown = (updates.objectives as string[]).filter((s) => !known.has(s));
    if (unknown.length > 0) {
      sendError(res, 400, 'invalid_objectives', `Unknown objective(s): ${unknown.join(', ')}`);
      return;
    }
    updates.objectives = Array.from(new Set(updates.objectives as string[]));
  }

  // Validate + canonicalize related_feature (null clears). The bidirectional
  // write-through to the feature's related_tasks happens after the task write.
  let featureLink: { slug: string } | null | undefined;
  if (updates.related_feature !== undefined) {
    if (updates.related_feature === null) {
      featureLink = null;
    } else if (typeof updates.related_feature !== 'string') {
      sendError(res, 400, 'invalid_related_feature', 'related_feature must be a feature slug or null.');
      return;
    } else {
      const resolved = resolveFeature(contextRoot, updates.related_feature);
      if (!resolved.ok) {
        sendError(res, 400, 'invalid_related_feature',
          resolved.reason === 'ambiguous'
            ? `Ambiguous feature "${updates.related_feature}" — candidates: ${resolved.candidates.join(', ')}`
            : `Unknown feature: "${updates.related_feature}"`);
        return;
      }
      updates.related_feature = resolved.slug;
      featureLink = { slug: resolved.slug };
    }
  }

  // ── Evidence (the dashboard is the owner's surface) ──
  // A box the owner ticks here is proven by the owner: the tick names an
  // approval entry (`owner:<je_id>`). An unticked box drops its ref. A move to
  // review/done passes the same evidence gate as the CLI, except that moving a
  // REVIEW task to done is the owner's approval. Order matters: the gate runs
  // on the final body first, the card is written next, and only then do the
  // journal entries land — a refused or failed save leaves no approval behind
  // (approvals are shared to the remote) and no status move that never happened.
  let actor: string | null = null;
  try { actor = resolveActivePerson(contextRoot).slug; } catch { /* nobody resolved */ }
  const pendingJournal: NewJournalEntry[] = [];
  // Every approval this save makes is also a task-audit record (plan r3 E9): an owner
  // tick and a review → done drag. This route does not refuse an Origin-less write
  // (R4-2 item 1); it records it as `via: 'no-origin'`.
  const pendingAudit: Array<{ journalId: string; note: string }> = [];
  if (bodyChanged && newBody !== null) {
    const before = criteriaOfBody(oldContent);
    let nextBody: string = newBody;
    for (const c of criteriaOfBody(newBody)) {
      const prev = before.find((b) => b.n === c.n && b.text === c.text) ?? before.find((b) => b.text === c.text);
      if (c.checked && !c.evidence && !(prev?.checked && prev.evidence)) {
        const id = newJournalEntryId();
        pendingJournal.push({ id, kind: 'approval', actor: actor ?? 'owner', body: `- ticked in the dashboard: ${c.text}` });
        pendingAudit.push({ journalId: id, note: `ticked: ${c.text}` });
        nextBody = setCriterion(nextBody, c.n, true, `owner:${id}`);
      } else if (c.checked && !c.evidence && prev?.checked && prev.evidence) {
        nextBody = setCriterion(nextBody, c.n, true, prev.evidence);
      } else if (!c.checked && c.evidence) {
        nextBody = setCriterion(nextBody, c.n, false, null);
      }
    }
    newBody = nextBody;
  }
  if (updates.parent_task !== undefined && updates.parent_task !== existing.parent_task) {
    if (updates.parent_task !== null) {
      const check = checkParentLink(loadFamily(join(contextRoot, 'state')), loadStatuses(contextRoot), slug, String(updates.parent_task));
      if (!check.ok) { sendError(res, 400, 'invalid_parent', check.reason); return; }
      updates.parent_task = check.parent;
    }
    pendingJournal.push({
      kind: 'log', actor: actor ?? 'owner',
      body: updates.parent_task ? `- placed under ${updates.parent_task} in the dashboard` : '- detached from its parent in the dashboard',
    });
  }
  if (updates.status && updates.status !== existing.status) {
    const statuses = loadStatuses(contextRoot);
    const target = updates.status as string;
    // A parent closes after its sub-tasks, and is cancelled only with a decision
    // per open sub-task (the CLI's --child/--children; the board has no form for it yet).
    const family = loadFamily(join(contextRoot, 'state'));
    const closeBlock = parentCloseBlock(family, statuses, slug, target);
    if (closeBlock) { sendError(res, 409, 'subtasks_open', closeBlock); return; }
    if (isCancelled(statuses, target)) {
      const open = rollupOf(family.children.get(slug) ?? [], statuses).open;
      if (open.length > 0) {
        sendError(res, 409, 'subtasks_decision_required',
          `${slug} has ${open.length} open sub-task(s); decide each before cancelling the parent: `
          + `dreamcontext tasks status ${slug} ${target} --child <sub-task>=cancel|detach|move:<parent> (or --children <decision>).`);
        return;
      }
    }
    if (isDone(statuses, target) && isReview(statuses, existing.status)) {
      const id = newJournalEntryId();
      pendingJournal.push({ id, kind: 'approval', actor: actor ?? 'owner', body: `- approved in the dashboard (${existing.status} → ${target})` });
      pendingAudit.push({ journalId: id, note: `approved (${existing.status} → ${target})` });
    } else if (isDone(statuses, target) || isReview(statuses, target)) {
      const gate = gateStatus(newBody ?? oldContent, isDone(statuses, target) ? 'done' : 'review');
      if (!gate.ok) {
        sendError(res, 409, 'evidence_required', describeGate(slug, target, gate));
        return;
      }
    }
    pendingJournal.push({ kind: 'status', label: target, actor: actor ?? 'owner', body: '- moved in the dashboard' });
  }

  // Preflight: an approval is audited, so the audit's ignore entries must be writable
  // BEFORE anything moves; when they are not, the save is refused and nothing is done.
  if (pendingAudit.length > 0) {
    try {
      ensureLocalStateIgnored(contextRoot);
    } catch (err) {
      sendError(res, 500, 'audit_unavailable', `The task audit cannot be written, so this approval is refused: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  updates.updated_at = today();
  const task = await backend.updateFields(
    slug,
    updates,
    bodyChanged && newBody !== null ? { body: newBody } : undefined,
  );
  for (const entry of pendingJournal) await backend.addJournal(slug, entry);
  const via = writeVia(req);
  for (const a of pendingAudit) {
    recordAudit(contextRoot, { kind: 'approval', slug, actor: actor ?? 'owner', via, note: a.note, journalId: a.journalId });
  }

  // Bidirectional invariant: the feature side (related_tasks membership)
  // follows every task-side related_feature change.
  if (featureLink !== undefined) {
    applyTaskFeatureLink(contextRoot, slug, featureLink);
  }

  const changedFieldNames = fieldChanges.map(f => f.field);
  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'update',
    target: `state/${slug}.md`,
    field: changedFieldNames.join(', '),
    fields: fieldChanges,
    summary: buildFieldSummary('task', `state/${slug}.md`, fieldChanges),
  });

  sendJson(res, 200, { task: toApiTask(task) });
}

/**
 * POST /api/tasks/:slug/changelog - Add changelog entry
 */
export async function handleTasksChangelog(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }

  const backend = backendFor(contextRoot);
  if ((await backend.get(slug)) === null) {
    sendError(res, 404, 'not_found', `Task not found: ${slug}`);
    return;
  }

  const body = await parseJsonBody(req);
  if (!body || !body.content || typeof body.content !== 'string') {
    sendError(res, 400, 'missing_content', 'Changelog content is required.');
    return;
  }

  const logContent = `### ${today()} - Dashboard Update\n- ${(body.content as string).trim()}`;

  try {
    await backend.addChangelog(slug, logContent);
  } catch {
    sendError(res, 500, 'write_error', 'Failed to write changelog entry.');
    return;
  }

  await backend.updateFields(slug, { updated_at: today() });

  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'update',
    target: `state/${slug}.md`,
    field: 'changelog',
    summary: `Added changelog entry to task '${slug}'`,
  });

  sendJson(res, 200, { success: true });
}

/** Journal entries the task panel shows under the card (A9). */
export const PANEL_JOURNAL_LIMIT = 5;

/**
 * GET /api/tasks/:slug/journal — the task's newest journal entries (default 5, max 50).
 * History left the card for `state/journal/<slug>.md`; the panel reads it here.
 */
export async function handleTasksJournal(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }
  const backend = backendFor(contextRoot);
  if ((await backend.get(slug)) === null) {
    sendError(res, 404, 'not_found', `Task not found: ${slug}`);
    return;
  }
  const query = new URL(req.url ?? '', 'http://x').searchParams;
  const asked = Number(query.get('limit'));
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 50) : PANEL_JOURNAL_LIMIT;
  const all = await backend.readJournal(slug);
  // `before=<je_id>`: the page of entries older than that one ("Show older").
  const before = query.get('before');
  const from = before ? all.findIndex((e) => e.id === before) + 1 : 0;
  const page = before && from === 0 ? [] : all.slice(from, from + limit);
  sendJson(res, 200, {
    total: all.length,
    entries: page.map(({ id, date, kind, label, actor, body }) => ({ id, date, kind, label, actor, body })),
  });
}

/**
 * POST /api/tasks/:slug/insert - Insert content into a task section
 */
export async function handleTasksInsert(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }

  const backend = backendFor(contextRoot);
  if ((await backend.get(slug)) === null) {
    sendError(res, 404, 'not_found', `Task not found: ${slug}`);
    return;
  }

  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  const section = body.section as string;
  let content = body.content as string;

  if (!section || typeof section !== 'string') {
    sendError(res, 400, 'missing_section', 'Section name is required.');
    return;
  }

  if (!content || typeof content !== 'string' || !content.trim()) {
    sendError(res, 400, 'missing_content', 'Content is required.');
    return;
  }

  const sectionMap: Record<string, string> = {
    changelog: 'Changelog',
    notes: 'Notes',
    technical_details: 'Technical Details',
    constraints: 'Constraints & Decisions',
    user_stories: 'User Stories',
    acceptance_criteria: 'Acceptance Criteria',
    why: 'Why',
  };

  const sectionKey = section.toLowerCase();
  if (!sectionMap[sectionKey]) {
    sendError(res, 400, 'invalid_section', `Unknown section: "${section}". Valid: ${Object.keys(sectionMap).join(', ')}`);
    return;
  }
  const sectionName = sectionMap[sectionKey];

  // Auto-format for changelog and constraints
  if (sectionKey === 'changelog') {
    content = `### ${today()} - Dashboard Update\n- ${content.trim()}`;
  }
  if (sectionKey === 'constraints') {
    content = `- **[${today()}]** ${content.trim()}`;
  }

  const position = ['changelog', 'constraints'].includes(sectionKey) ? 'top' : 'bottom';

  try {
    await backend.insertSection(slug, sectionName, content, { position: position as 'top' | 'bottom' });
  } catch {
    sendError(res, 500, 'write_error', `Failed to insert into ${sectionName}.`);
    return;
  }

  await backend.updateFields(slug, { updated_at: today() });

  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'update',
    target: `state/${slug}.md`,
    field: sectionKey,
    summary: `Inserted into ${sectionName} of task '${slug}'`,
  });

  sendJson(res, 200, { success: true });
}

/** The HTTP status each assignment refusal answers with. */
const ASSIGN_REFUSAL_STATUS: Record<AssignmentRefusal, 400 | 404 | 409> = {
  unknown_task: 404,
  unknown_agent: 404,
  agent_not_approved_to_run: 409,
  agent_disabled: 409,
  note_too_long: 400,
};

/**
 * POST /api/tasks/:slug/assign-agent {agent, note?} — "Assign to agent".
 *
 * The shared steps (`prepareAssignment` → `commitAssignment`), then the EXISTING
 * ask run on the agent's call target with the task as data. A note typed here is
 * the owner speaking, so it rides as the run's ask under the task wording. The
 * run's result is logged on the task by the job itself (`logAssignmentResult`).
 *
 * 409 `agent_not_approved_to_run` names the Agents page and no command. 409
 * `agent_busy` when the agent is already running: an adopted job would carry
 * neither this task nor this note.
 */
export async function handleTasksAssignAgent(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }
  const body = await parseJsonBody(req);
  if (!body || typeof body.agent !== 'string' || !body.agent.trim()) {
    sendError(res, 400, 'missing_agent', 'Name the agent to assign.');
    return;
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    sendError(res, 400, 'invalid_note', 'note must be text.');
    return;
  }
  const prep = prepareAssignment(contextRoot, slug, body.agent.trim(), {
    source: 'dashboard',
    ...(typeof body.note === 'string' ? { note: body.note } : {}),
  });
  if (!prep.ok) {
    sendError(res, ASSIGN_REFUSAL_STATUS[prep.code], prep.code, prep.message);
    return;
  }
  if (currentAutomationJob(contextRoot, prep.target.slug)?.status === 'running') {
    sendError(res, 409, 'agent_busy', `${prep.target.agentTitle || prep.target.title} is running right now. Assign the task when it finishes.`);
    return;
  }
  try {
    const fireAt = new Date();
    const { statusMoved } = commitAssignment(contextRoot, prep, fireAt);
    const { job } = startAutomationJob(contextRoot, prep.target.slug, {
      text: prep.ownerNote ?? '',
      fireAt,
      task: { slug: prep.task.slug, name: prep.task.name },
      target: 'agent',
    });
    recordDashboardChange(contextRoot, {
      entity: 'task',
      action: 'update',
      target: `state/${slug}.md`,
      field: 'agent',
      summary: `Assigned task '${slug}' to the agent '${prep.target.slug}'`,
    });
    sendJson(res, 202, { jobId: job.id, runId: fireAt.toISOString(), statusMoved });
  } catch (err) {
    console.error('[tasks] assign-agent failed', err);
    sendError(res, 500, 'assign_failed', 'Failed to assign the task.');
  }
}

// ─── The owner's verdict, planning and ranking (plan r3 § W4) ────────────────

const VERDICT_STATUS: Record<string, number> = { not_found: 404, note_required: 400, not_in_review: 409, subtasks_open: 409, sleep_eval_gate: 409 };

/**
 * POST /api/tasks/:slug/verdict — `{ verdict: 'approve' | 'send_back', note? }`.
 * The owner's verdict on a task in review, through the same lib/task-verdict.ts as
 * `tasks approve` / `tasks send-back`. Owner-only: refused (403) without a browser
 * Origin; the audit records `via`. Not `refuseSelfApproval` (E9: the server may itself
 * run inside a Claude session).
 */
export async function handleTaskVerdict(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!requireBrowserOrigin(req, res)) return;
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }
  const body = await parseJsonBody(req);
  const verdict = body?.verdict;
  if (verdict !== 'approve' && verdict !== 'send_back') {
    sendError(res, 400, 'invalid_verdict', 'verdict must be "approve" or "send_back".');
    return;
  }
  const note = body?.note;
  if (note !== undefined && typeof note !== 'string') {
    sendError(res, 400, 'invalid_note', 'note must be a string.');
    return;
  }
  const backend = backendFor(contextRoot);
  let actor: string | null = null;
  try { actor = resolveActivePerson(contextRoot).slug; } catch { /* nobody resolved */ }
  let r;
  try {
    r = await applyVerdict(backend, contextRoot, loadStatuses(contextRoot), slug, {
      verdict, note: note as string | undefined, actor, via: writeVia(req),
    });
  } catch (err) {
    sendError(res, 500, 'audit_unavailable', `The task audit cannot be written, so this verdict is refused: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!r.ok) { sendError(res, VERDICT_STATUS[r.code] ?? 409, r.code, r.message); return; }
  const task = await backend.get(slug);
  if (!task) { sendError(res, 404, 'not_found', `Task not found: ${slug}`); return; }
  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'update',
    target: `state/${slug}.md`,
    field: 'status',
    summary: verdict === 'approve' ? `Approved task '${slug}'` : `Sent task '${slug}' back`,
  });
  sendJson(res, 200, taskDetail(contextRoot, task));
}

/** POST /api/tasks/:slug/plan — `{ target: 'now' | 'next' | 'later' | <cycle id or number> }`. */
export async function handleTaskPlan(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }
  const body = await parseJsonBody(req);
  const target = body?.target;
  if (typeof target !== 'string' || !target.trim()) {
    sendError(res, 400, 'unknown_target', 'target must be now, next, later or a cycle id or number.');
    return;
  }
  const r = await planTask(contextRoot, backendFor(contextRoot), slug, target);
  if (!r.ok) {
    const code = r.code === 'not_found' ? 404 : r.code === 'not_open' ? 409 : 400;
    sendError(res, code, r.code === 'closed_cycle' ? 'unknown_target' : r.code, r.message);
    return;
  }
  if (r.moved.length > 0) {
    recordDashboardChange(contextRoot, {
      entity: 'task', action: 'update', target: `state/${slug}.md`, field: 'cycle, queue',
      summary: `Planned task '${slug}' into ${r.where}`,
    });
  }
  sendJson(res, 200, { placement: r.placement, moved: r.moved });
}

/** POST /api/tasks/:slug/rank — `{ before: <slug> }` or `{ after: <slug> }`, exactly one. */
export async function handleTaskRank(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  if (!isSafeTaskSlug(slug)) { sendError(res, 400, 'invalid_path', `Invalid task slug: ${slug}`); return; }
  const body = await parseJsonBody(req);
  const before = body?.before;
  const after = body?.after;
  const anchor = typeof before === 'string' && after === undefined ? { before }
    : typeof after === 'string' && before === undefined ? { after }
      : null;
  const other = anchor ? ('before' in anchor ? anchor.before : anchor.after) : null;
  if (!anchor || !other || !isSafeTaskSlug(other)) {
    sendError(res, 400, 'bad_anchor', 'Give exactly one of before or after: the slug of a task in the same cycle or queue.');
    return;
  }
  const r = await rankTask(contextRoot, backendFor(contextRoot), slug, anchor);
  if (!r.ok) { sendError(res, r.code === 'not_found' ? 404 : 400, r.code, r.message); return; }
  sendJson(res, 200, { rank: r.rank });
}
