import { IncomingMessage, ServerResponse } from 'node:http';
import { today } from '../../lib/id.js';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { recordDashboardChange, buildFieldSummary } from '../change-tracker.js';
import type { FieldChange } from '../change-tracker.js';
import { mergeRice, validateRiceInput, type RiceFields, type RiceInput } from '../../lib/rice.js';
import {
  getTaskBackend,
  isSafeTaskSlug,
  TaskBackendError,
  type TaskBackend,
  type TaskData,
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

  const allowedFields = ['status', 'priority', 'urgency', 'description', 'tags', 'name', 'related_feature', 'version'];
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

  if (fieldChanges.length === 0) {
    sendError(res, 400, 'no_changes', 'No valid fields to update.');
    return;
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
