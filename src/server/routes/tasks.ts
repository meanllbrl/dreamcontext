import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { today } from '../../lib/id.js';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { recordDashboardChange, buildFieldSummary } from '../change-tracker.js';
import type { FieldChange } from '../change-tracker.js';
import { mergeRice, validateRiceInput, type RiceFields, type RiceInput } from '../../lib/rice.js';
import { readSetupConfig } from '../../lib/setup-config.js';
import {
  loadTaskOverride,
  readTaskOverrideRaw,
  writeTaskOverrideDoc,
  upsertCustomField,
  removeCustomField,
  fieldKey,
  SYNC_TARGETS,
  type CustomFieldType,
  type SyncTarget,
} from '../../lib/overrides.js';
import {
  getTaskBackend,
  getTaskSyncStatus,
  isSafeTaskSlug,
  TaskBackendError,
  type TaskBackend,
  type TaskData,
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
 * GET /api/task-overrides — the active task override schema (custom-field defs +
 * presence), so the dashboard can render typed inputs. Empty/absent → no fields.
 */
export async function handleTaskOverrides(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const ov = loadTaskOverride(contextRoot);
  sendJson(res, 200, {
    present: ov !== null,
    customFields: ov?.customFields ?? [],
    warnings: ov?.warnings ?? [],
  });
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
  sendJson(res, 200, {
    present: raw !== '',
    raw,
    customFields: ov?.customFields ?? [],
    warnings: ov?.warnings ?? [],
  });
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
  sendJson(res, 200, {
    present: ov !== null,
    customFields: ov?.customFields ?? [],
    warnings: ov?.warnings ?? [],
  });
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
  sendJson(res, 200, { present: true, customFields: ov.customFields, warnings: ov.warnings });
}

/** DELETE /api/task-overrides/fields/:key — remove a custom-field definition. */
export async function handleTaskOverrideRemoveField(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const ov = removeCustomField(contextRoot, params.key ?? '');
  sendJson(res, 200, {
    present: ov !== null,
    customFields: ov?.customFields ?? [],
    warnings: ov?.warnings ?? [],
  });
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
  const backend = backendFor(contextRoot);
  const summaries = await backend.list();
  const tasks: ReturnType<typeof toApiTask>[] = [];
  for (const s of summaries) {
    const task = await backend.get(s.name);
    if (task) tasks.push(toApiTask(task));
  }
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
  const why = (body.why as string) ?? '';
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

/** Title-case a kebab slug for display: "mehmet-nuraydin" → "Mehmet Nuraydin". */
function slugToName(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * The project roster (`.config.json` `people`) as assignee candidates. This is
 * the source on LOCAL projects (no remote member list), so the dashboard can
 * offer a people dropdown instead of forcing the user to type `person:<slug>`.
 */
function rosterMembers(contextRoot: string): RemoteMember[] {
  const config = readSetupConfig(dirname(contextRoot));
  const people = config?.people ?? [];
  // Roster candidates are keyed by slug — that slug becomes the `person:<slug>`
  // tag. The remote member id (if any) is resolved inside the backend at sync
  // time, so the route stays provider-agnostic and carries no remote id here.
  return people.map((slug) => ({
    slug,
    id: '',
    name: slugToName(slug),
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

  await backend.delete(slug);

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

  sendJson(res, 200, { task: toApiTask(task) });
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

  const allowedFields = ['status', 'priority', 'urgency', 'description', 'tags', 'name', 'related_feature', 'version', 'start_date', 'due_date', 'assignee'];
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
  // Range sanity: the EFFECTIVE start (after this patch) must not be after the
  // effective due. A backlog task clears both in the backend, so only check when
  // both resolve to a real date here.
  {
    const effStart = updates.start_date !== undefined ? updates.start_date : existing.start_date;
    const effDue = updates.due_date !== undefined ? updates.due_date : existing.due_date;
    if (isYmd(effStart) && isYmd(effDue) && effStart > effDue) {
      sendError(res, 400, 'invalid_date_range', `start_date (${effStart}) cannot be after due_date (${effDue}).`);
      return;
    }
  }

  // Validate status
  if (updates.status) {
    const validStatuses = ['todo', 'in_progress', 'in_review', 'completed'];
    if (!validStatuses.includes(updates.status as string)) {
      sendError(res, 400, 'invalid_status', `Status must be one of: ${validStatuses.join(', ')}`);
      return;
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

  updates.updated_at = today();
  const task = await backend.updateFields(
    slug,
    updates,
    bodyChanged && newBody !== null ? { body: newBody } : undefined,
  );

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
