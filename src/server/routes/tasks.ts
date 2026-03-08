import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, updateFrontmatterFields } from '../../lib/frontmatter.js';
import { readSection, listSections, insertToSection } from '../../lib/markdown.js';
import { generateId, slugify, today } from '../../lib/id.js';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { recordDashboardChange, buildFieldSummary } from '../change-tracker.js';
import type { FieldChange } from '../change-tracker.js';

interface TaskData {
  slug: string;
  id: string;
  name: string;
  description: string;
  priority: string;
  urgency: string;
  status: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  parent_task: string | null;
  related_feature: string | null;
  version: string | null;
  why: string;
  user_stories: string;
  acceptance_criteria: string;
  constraints: string;
  technical_details: string;
  notes: string;
  changelog: string;
  sections: string[];
  body: string;
}

function readSectionSafe(filePath: string, sectionName: string): string {
  try {
    return readSection(filePath, sectionName) ?? '';
  } catch {
    return '';
  }
}

function readTask(filePath: string): TaskData {
  const slug = basename(filePath, '.md');
  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);

  let sections: string[] = [];
  try {
    sections = listSections(filePath);
  } catch { /* no sections */ }

  // Normalize status: accept both hyphens and underscores (e.g. "in-progress" → "in_progress")
  const rawStatus = ((data.status as string) ?? 'todo').replace(/-/g, '_');
  const validStatuses = ['todo', 'in_progress', 'in_review', 'completed'];
  const status = validStatuses.includes(rawStatus) ? rawStatus : 'todo';

  return {
    slug,
    id: (data.id as string) ?? '',
    name: (data.name as string) ?? slug,
    description: (data.description as string) ?? '',
    priority: (data.priority as string) ?? 'medium',
    urgency: (data.urgency as string) ?? 'medium',
    status,
    created_at: (data.created_at as string) ?? '',
    updated_at: (data.updated_at as string) ?? '',
    tags: Array.isArray(data.tags) ? data.tags as string[] : [],
    parent_task: (data.parent_task as string) ?? null,
    related_feature: (data.related_feature as string) ?? null,
    version: (data.version as string) ?? null,
    why: readSectionSafe(filePath, 'Why'),
    user_stories: readSectionSafe(filePath, 'User Stories'),
    acceptance_criteria: readSectionSafe(filePath, 'Acceptance Criteria'),
    constraints: readSectionSafe(filePath, 'Constraints & Decisions'),
    technical_details: readSectionSafe(filePath, 'Technical Details'),
    notes: readSectionSafe(filePath, 'Notes'),
    changelog: readSectionSafe(filePath, 'Changelog'),
    sections,
    body: content.trim(),
  };
}

function getStateDir(contextRoot: string): string {
  return join(contextRoot, 'state');
}

function getTaskFiles(contextRoot: string): string[] {
  const stateDir = getStateDir(contextRoot);
  if (!existsSync(stateDir)) return [];
  return fg.sync('*.md', { cwd: stateDir, absolute: true });
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
  const files = getTaskFiles(contextRoot);
  const tasks = files.map(readTask);
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

  const slug = slugify(name.trim());
  const stateDir = getStateDir(contextRoot);
  const filePath = join(stateDir, `${slug}.md`);

  if (existsSync(filePath)) {
    sendError(res, 409, 'already_exists', `Task already exists: ${slug}`);
    return;
  }

  const dateStr = today();
  const tagsYaml = tags.length > 0 ? `[${tags.map(t => `"${t}"`).join(', ')}]` : '[]';
  const versionYaml = version ? `"${version}"` : 'null';
  const content = `---
id: "${generateId('task')}"
name: "${name.trim()}"
description: "${description}"
priority: "${priority}"
urgency: "${urgency}"
status: "todo"
created_at: "${dateStr}"
updated_at: "${dateStr}"
tags: ${tagsYaml}
parent_task: null
related_feature: null
version: ${versionYaml}
---

## Why

${why || '(To be defined)'}

## User Stories

- [ ] As a [user], I want [action] so that [outcome]

## Acceptance Criteria

- (Specific, testable conditions for this task to be complete)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

## Technical Details

(Key files, services, dependencies, implementation approach.)

## Notes

(Working notes, edge cases, open questions.)

## Changelog
<!-- LIFO: newest entry at top -->

### ${dateStr} - Created
- Task created.
`;

  writeFileSync(filePath, content, 'utf-8');

  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'create',
    target: `state/${slug}.md`,
    summary: `Created task '${name.trim()}' with priority ${priority}`,
  });

  const task = readTask(filePath);
  sendJson(res, 201, { task });
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
  const filePath = join(getStateDir(contextRoot), `${slug}.md`);

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Task not found: ${slug}`);
    return;
  }

  const task = readTask(filePath);
  sendJson(res, 200, { task });
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
  const filePath = join(getStateDir(contextRoot), `${slug}.md`);

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Task not found: ${slug}`);
    return;
  }

  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  // Read old values BEFORE mutation for change tracking
  const { data: oldData } = readFrontmatter<Record<string, unknown>>(filePath);

  const updates: Record<string, unknown> = {};
  const fieldChanges: FieldChange[] = [];

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
  updateFrontmatterFields(filePath, updates);

  const changedFieldNames = fieldChanges.map(f => f.field);
  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'update',
    target: `state/${slug}.md`,
    field: changedFieldNames.join(', '),
    fields: fieldChanges,
    summary: buildFieldSummary('task', `state/${slug}.md`, fieldChanges),
  });

  const task = readTask(filePath);
  sendJson(res, 200, { task });
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
  const filePath = join(getStateDir(contextRoot), `${slug}.md`);

  if (!existsSync(filePath)) {
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
    insertToSection(filePath, 'Changelog', logContent, 'top');
  } catch {
    sendError(res, 500, 'write_error', 'Failed to write changelog entry.');
    return;
  }

  updateFrontmatterFields(filePath, { updated_at: today() });

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
  const filePath = join(getStateDir(contextRoot), `${slug}.md`);

  if (!existsSync(filePath)) {
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
    insertToSection(filePath, sectionName, content, position as 'top' | 'bottom', true);
  } catch {
    sendError(res, 500, 'write_error', `Failed to insert into ${sectionName}.`);
    return;
  }

  updateFrontmatterFields(filePath, { updated_at: today() });

  recordDashboardChange(contextRoot, {
    entity: 'task',
    action: 'update',
    target: `state/${slug}.md`,
    field: sectionKey,
    summary: `Inserted into ${sectionName} of task '${slug}'`,
  });

  sendJson(res, 200, { success: true });
}
