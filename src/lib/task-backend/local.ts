import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { loadTaskOverride } from '../overrides.js';
import { readFrontmatter, updateFrontmatterFields, writeFrontmatter } from '../frontmatter.js';
import { insertToSection, listSections, readSection } from '../markdown.js';
import { generateId, slugify, today } from '../id.js';
import { normalizeRice } from '../rice.js';
import { filterTasks, toTaskRecord, type TaskFilter } from '../task-query.js';
import {
  TaskBackendError,
  type AddChangelogOptions,
  type CreateTaskInput,
  type InsertSectionOptions,
  type SlugResolution,
  type SyncDirection,
  type SyncReport,
  type TaskBackend,
  type TaskData,
  type TaskSummary,
  type UpdateFieldsOptions,
} from './types.js';

/**
 * Pure path-safety check for task slugs (no fs). Mirrors the semantics of
 * server/safe-path.ts: rejects traversal (`..`), absolute paths, and null
 * bytes. Exported so HTTP routes can keep returning 400 for hostile slugs
 * BEFORE consulting the backend.
 */
export function isSafeTaskSlug(slug: string): boolean {
  if (!slug || slug.includes('\0')) return false;
  const base = resolve(sep, 'dc-slug-check');
  const target = resolve(base, `${slug}.md`);
  return target === join(base, `${slug}.md`) && target.startsWith(base + sep);
}

/**
 * Product rule: a `backlog` tag means "not planned" — backlog tasks carry NO
 * dates (neither a start nor a due date). The invariant is enforced at the
 * backend so every surface (CLI, dashboard, sync) behaves identically:
 *  - adding the backlog tag clears both the start and due date
 *  - explicitly setting EITHER date pulls the task OUT of backlog
 *  - if both arrive in one patch, backlog wins (the stronger statement)
 */
export const BACKLOG_TAG = 'backlog';

function hasBacklogTag(tags: unknown): boolean {
  return Array.isArray(tags) && tags.some((t) => String(t).toLowerCase() === BACKLOG_TAG);
}

function isSet(v: unknown): boolean {
  return v !== null && v !== undefined;
}

export function normalizeBacklogFields(
  prev: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const nextTags = patch.tags !== undefined ? patch.tags : prev.tags;
  const nextDue = patch.due_date !== undefined ? patch.due_date : (prev.due_date ?? null);
  const nextStart = patch.start_date !== undefined ? patch.start_date : (prev.start_date ?? null);
  if (!hasBacklogTag(nextTags) || (!isSet(nextDue) && !isSet(nextStart))) return patch;

  // A date arriving explicitly in THIS patch is the user scheduling the task.
  const dateExplicit =
    (patch.due_date !== undefined && patch.due_date !== null) ||
    (patch.start_date !== undefined && patch.start_date !== null);
  const backlogAdded = patch.tags !== undefined && hasBacklogTag(patch.tags) && !hasBacklogTag(prev.tags);

  if (dateExplicit && !backlogAdded) {
    // Scheduling an existing backlog task → it is planned now, drop the tag.
    const tags = (Array.isArray(nextTags) ? nextTags : []).filter(
      (t) => String(t).toLowerCase() !== BACKLOG_TAG,
    );
    return { ...patch, tags };
  }
  // Backlog (newly added, or both in one patch) → undated: clear BOTH dates.
  return { ...patch, due_date: null, start_date: null };
}

/**
 * Resolve the task template. A project-local `_dream_context/overrides/task.md`
 * (passed in as `overrideTemplate`) shadows the shipped default; absent one,
 * this is byte-identical to the pre-refactor CLI resolution (golden-pinned).
 */
function getTaskTemplate(overrideTemplate?: string | null): string {
  if (overrideTemplate && overrideTemplate.trim()) return overrideTemplate;
  const candidates = [
    join(new URL('.', import.meta.url).pathname, '..', '..', 'templates', 'task.md'),
    join(new URL('.', import.meta.url).pathname, '..', 'templates', 'task.md'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8');
    }
  }

  // Inline fallback
  return `---
id: "{{ID}}"
name: "{{NAME}}"
description: "{{DESCRIPTION}}"
priority: "{{PRIORITY}}"
urgency: "{{URGENCY}}"
status: "{{STATUS}}"
created_at: "{{DATE}}"
updated_at: "{{DATE}}"
tags: {{TAGS}}
parent_task: null
related_feature: null
version: {{VERSION}}
---

## Workflow
<!-- The shape of this task at a glance. One node per acceptance criterion, grouped under milestone subgraphs. Update node classes as work progresses: \`:::done\` (green), \`:::active\` (amber), \`:::todo\` (gray), \`:::blocked\` (red). Run \`dreamcontext tasks doctor\` to verify sync. -->

\`\`\`mermaid
flowchart TD
  subgraph M1 ["Milestone 1 — rename me"]
    A1[First criterion]:::todo
  end

  classDef done fill:#86efac,stroke:#15803d,color:#052e16
  classDef active fill:#fde68a,stroke:#b45309,color:#451a03
  classDef todo fill:#e5e7eb,stroke:#6b7280,color:#111827
  classDef blocked fill:#fecaca,stroke:#b91c1c,color:#450a0a
\`\`\`

## Why
<!-- What problem does this solve? What breaks if we don't do it? Be concrete — name the user, the friction, the cost. -->

{{WHY}}

## User Stories
<!-- As a <role>, I can <action>, so that <outcome>. Tick when demonstrably true in the running system. -->

- [ ] As a [role], I can [action], so that [outcome]

## Acceptance Criteria
<!-- The contract. Each line is testable and gets a node in the Workflow flowchart above. -->

- [ ] First criterion (matches node A1 in Workflow)

## Constraints & Decisions
<!-- LIFO: newest at top. Capture the why, not just the what. -->

## Technical Details
<!-- Where the work lives. Files, services, key functions to reuse. Body is current truth — update in place; don't append. -->

(Key files, services, dependencies, implementation approach.)

## Notes
<!-- Loose ends, edge cases, open questions. -->

(Working notes, edge cases, open questions.)

## Changelog
<!-- LIFO: newest at top. Auto-prepended by \`dreamcontext tasks log\`. -->

### {{DATE}} - Created
- Task created.
`;
}

function readSectionSafe(filePath: string, sectionName: string): string {
  try {
    return readSection(filePath, sectionName) ?? '';
  } catch {
    return '';
  }
}

/** Read a task file into the full TaskData view (moved from server/routes/tasks.ts). */
export function readTaskFile(filePath: string): TaskData {
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
    rice: normalizeRice(data.rice),
    start_date: (data.start_date as string) ?? null,
    due_date: (data.due_date as string) ?? null,
    assignee: (data.assignee as string) ?? null,
    custom_fields:
      data.custom_fields && typeof data.custom_fields === 'object' && !Array.isArray(data.custom_fields)
        ? (data.custom_fields as Record<string, string | number | null>)
        : {},
    why: readSectionSafe(filePath, 'Why'),
    user_stories: readSectionSafe(filePath, 'User Stories'),
    acceptance_criteria: readSectionSafe(filePath, 'Acceptance Criteria'),
    constraints: readSectionSafe(filePath, 'Constraints & Decisions'),
    technical_details: readSectionSafe(filePath, 'Technical Details'),
    notes: readSectionSafe(filePath, 'Notes'),
    changelog: readSectionSafe(filePath, 'Changelog'),
    sections,
    body: content.trim(),
    rawBody: content,
    raw: data,
  };
}

/**
 * The current file-based task store, behind the TaskBackend interface.
 * Every byte it writes is pinned by tests/unit/task-backend-golden.test.ts —
 * it must stay indistinguishable from the pre-refactor CLI + routes.
 */
export class LocalTaskBackend implements TaskBackend {
  readonly name: string = 'local';

  constructor(protected readonly stateDir: string) {}

  protected taskPath(slug: string): string {
    return join(this.stateDir, `${slug}.md`);
  }

  protected requirePath(slug: string): string {
    if (!isSafeTaskSlug(slug)) {
      throw new TaskBackendError('invalid_input', `Invalid task slug: ${slug}`);
    }
    const path = this.taskPath(slug);
    if (!existsSync(path)) {
      throw new TaskBackendError('not_found', `Task not found: ${slug}`);
    }
    return path;
  }

  protected taskFiles(): string[] {
    if (!existsSync(this.stateDir)) return [];
    return fg.sync('*.md', { cwd: this.stateDir, absolute: true });
  }

  /**
   * The `{ slug, dcId }` join keys for every live task file — what rename
   * reconciliation (#77) needs to map a renamed file's new slug back to its
   * stable dcId. File access lives here (the local backend owns it); the remote
   * backends inherit it and feed it to `reconcileRenamedTasks`.
   */
  protected liveTaskIdentities(): Array<{ slug: string; dcId: string }> {
    const out: Array<{ slug: string; dcId: string }> = [];
    for (const file of this.taskFiles()) {
      try {
        const { data } = readFrontmatter<{ id?: string }>(file);
        if (data.id) out.push({ slug: basename(file, '.md'), dcId: data.id });
      } catch { /* skip unreadable */ }
    }
    return out;
  }

  async list(filter?: TaskFilter): Promise<TaskSummary[]> {
    const all: TaskSummary[] = [];
    for (const file of this.taskFiles()) {
      try {
        const { data } = readFrontmatter<Record<string, unknown>>(file);
        all.push(toTaskRecord(data, basename(file, '.md'), file));
      } catch { /* skip unreadable */ }
    }
    return filter ? filterTasks(all, filter) : all;
  }

  async get(slug: string): Promise<TaskData | null> {
    if (!isSafeTaskSlug(slug)) return null;
    const path = this.taskPath(slug);
    if (!existsSync(path)) return null;
    return readTaskFile(path);
  }

  async create(input: CreateTaskInput): Promise<TaskData> {
    if ((input.due_date || input.start_date) && (input.tags ?? []).some((t) => t.toLowerCase() === BACKLOG_TAG)) {
      input = { ...input, due_date: null, start_date: null }; // backlog tasks are undated by rule
    }
    const slug = slugify(input.name.trim());
    if (!isSafeTaskSlug(slug)) {
      throw new TaskBackendError('invalid_input', `Invalid task name: ${input.name}`);
    }
    const filePath = this.taskPath(slug);
    if (existsSync(filePath)) {
      throw new TaskBackendError('already_exists', `Task already exists: ${slug}`);
    }

    // Project-local format/field override (absent → byte-identical to defaults).
    const override = loadTaskOverride(dirname(this.stateDir));

    if (input.variant === 'cli') {
      // Byte-exact replica of the pre-refactor `tasks create` action: template
      // substitution first, then a SECOND gray-matter rewrite when rice is set
      // (which re-serializes the YAML — that two-write shape is pinned by the
      // golden test, so don't "optimize" it into one write).
      const template = getTaskTemplate(override?.template);
      const content = template
        .replaceAll('{{ID}}', generateId('task'))
        .replaceAll('{{NAME}}', input.name)
        .replaceAll('{{DESCRIPTION}}', input.description ?? input.name)
        .replaceAll('{{PRIORITY}}', input.priority ?? 'medium')
        .replaceAll('{{URGENCY}}', input.urgency ?? 'medium')
        .replaceAll('{{STATUS}}', input.status ?? 'todo')
        .replaceAll('{{TAGS}}', JSON.stringify(input.tags ?? []))
        .replaceAll('{{DATE}}', today())
        .replaceAll('{{WHY}}', input.why || '(To be defined)')
        .replaceAll('{{VERSION}}', input.version ? `"${input.version}"` : 'null');

      writeFileSync(filePath, content, 'utf-8');
      if (input.rice) {
        updateFrontmatterFields(filePath, { rice: input.rice });
      }
      // start_date / due_date are additive: only written when provided, so
      // tasks created without them keep the exact pre-#11 bytes (golden-pinned).
      if (input.start_date) {
        updateFrontmatterFields(filePath, { start_date: input.start_date });
      }
      if (input.due_date) {
        updateFrontmatterFields(filePath, { due_date: input.due_date });
      }
    } else {
      // Byte-exact replica of the pre-refactor POST /api/tasks template
      // (compact skeleton; status is always "todo" regardless of input).
      const name = input.name.trim();
      const dateStr = today();
      const tags = input.tags ?? [];
      const tagsYaml = tags.length > 0 ? `[${tags.map(t => `"${t}"`).join(', ')}]` : '[]';
      const versionYaml = input.version ? `"${input.version}"` : 'null';
      const riceYaml = input.rice
        ? `\nrice:\n  reach: ${input.rice.reach ?? 'null'}\n  impact: ${input.rice.impact ?? 'null'}\n  confidence: ${input.rice.confidence ?? 'null'}\n  effort: ${input.rice.effort ?? 'null'}\n  score: ${input.rice.score ?? 'null'}`
        : '';
      const content = `---
id: "${generateId('task')}"
name: "${name}"
description: "${input.description ?? ''}"
priority: "${input.priority ?? 'medium'}"
urgency: "${input.urgency ?? 'medium'}"
status: "todo"
created_at: "${dateStr}"
updated_at: "${dateStr}"
tags: ${tagsYaml}
parent_task: null
related_feature: null
version: ${versionYaml}${riceYaml}
---

## Why

${input.why || '(To be defined)'}

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
      if (input.start_date) {
        updateFrontmatterFields(filePath, { start_date: input.start_date });
      }
      if (input.due_date) {
        updateFrontmatterFields(filePath, { due_date: input.due_date });
      }
    }

    // Seed override-declared custom fields (additive — only when the project
    // ships an override, so no-override creation stays byte-identical). Declared
    // keys are scaffolded to null so the schema is visible; provided values win.
    const declared = override?.customFields ?? [];
    if (declared.length > 0 || input.custom_fields) {
      const seeded: Record<string, string | number | null> = {};
      for (const def of declared) seeded[def.key] = null;
      Object.assign(seeded, input.custom_fields ?? {});
      if (Object.keys(seeded).length > 0) {
        updateFrontmatterFields(filePath, { custom_fields: seeded });
      }
    }

    return readTaskFile(filePath);
  }

  async updateFields(
    slug: string,
    fields: Record<string, unknown>,
    opts?: UpdateFieldsOptions,
  ): Promise<TaskData> {
    const path = this.requirePath(slug);
    if (fields.tags !== undefined || fields.due_date !== undefined || fields.start_date !== undefined) {
      const { data: prev } = readFrontmatter<Record<string, unknown>>(path);
      fields = normalizeBacklogFields(prev, fields);
    }
    if (opts?.body !== undefined) {
      // Merge frontmatter updates + body in a single write (dashboard body edit).
      const { data } = readFrontmatter<Record<string, unknown>>(path);
      writeFrontmatter(path, { ...data, ...fields }, opts.body);
    } else {
      updateFrontmatterFields(path, fields);
    }
    return readTaskFile(path);
  }

  async insertSection(
    slug: string,
    sectionName: string,
    content: string,
    opts: InsertSectionOptions,
  ): Promise<void> {
    const path = this.requirePath(slug);
    insertToSection(path, sectionName, content, opts.position, true, opts.replacePlaceholders ?? false);
  }

  async addChangelog(slug: string, entry: string, opts?: AddChangelogOptions): Promise<void> {
    const path = this.requirePath(slug);
    try {
      insertToSection(path, 'Changelog', entry, 'top');
    } catch (err) {
      if (!opts?.fallbackAppend) throw err;
      // No Changelog section: append at EOF (pre-refactor CLI fallback).
      const existing = readFileSync(path, 'utf-8');
      writeFileSync(path, existing.trimEnd() + '\n\n' + entry + '\n', 'utf-8');
    }
  }

  async complete(slug: string, summary?: string): Promise<TaskData> {
    await this.addChangelog(
      slug,
      `### ${today()} - Completed\n- ${summary ?? 'Task completed.'}`,
      { fallbackAppend: true },
    );
    return this.updateFields(slug, { status: 'completed', updated_at: today() });
  }

  async delete(slug: string): Promise<void> {
    const path = this.requirePath(slug);
    rmSync(path);
  }

  async rename(slug: string, newName: string): Promise<string> {
    const path = this.requirePath(slug);
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new TaskBackendError('invalid_input', 'New task name cannot be empty.');
    }
    const newSlug = slugify(trimmed);
    if (!newSlug || !isSafeTaskSlug(newSlug)) {
      throw new TaskBackendError('invalid_input', `Invalid task name: ${newName}`);
    }
    // Slug unchanged (a casing/punctuation tweak) → update the name field only.
    if (newSlug === slug) {
      await this.updateFields(slug, { name: trimmed, updated_at: today() });
      return slug;
    }
    if (existsSync(this.taskPath(newSlug))) {
      throw new TaskBackendError('already_exists', `A task already exists at slug "${newSlug}".`);
    }
    // Rewrite the name on the OLD file first (so remote backends enqueue a push
    // for the rename), then move the file to the new slug. The id-map migration
    // is layered on by the remote backends' override.
    await this.updateFields(slug, { name: trimmed, updated_at: today() });
    renameSync(path, this.taskPath(newSlug));
    return newSlug;
  }

  async resolveSlug(name: string): Promise<SlugResolution> {
    const slug = slugify(name);

    if (existsSync(this.taskPath(slug))) return { kind: 'match', slug };

    // Prefer exact match, then prefix, then substring (pre-refactor findTaskFile).
    const slugs = this.taskFiles().map((f) => basename(f, '.md'));

    const exact = slugs.find((s) => s === slug);
    if (exact) return { kind: 'match', slug: exact };

    const prefixMatches = slugs.filter((s) => s.startsWith(slug));
    if (prefixMatches.length === 1) return { kind: 'match', slug: prefixMatches[0] };
    if (prefixMatches.length > 1) return { kind: 'ambiguous', candidates: prefixMatches };

    const substringMatches = slugs.filter((s) => s.includes(slug));
    if (substringMatches.length === 1) return { kind: 'match', slug: substringMatches[0] };
    if (substringMatches.length > 1) return { kind: 'ambiguous', candidates: substringMatches };

    return { kind: 'none' };
  }

  async sync(direction: SyncDirection = 'both'): Promise<SyncReport> {
    // Local backend has no remote — sync is a structured no-op. (The `opts`
    // param in the interface, including `reconcile`, is irrelevant here.)
    return {
      backend: this.name,
      direction,
      pushed: 0,
      pulled: 0,
      created: 0,
      deleted: 0,
      mirrorDeleted: 0,
      commentsAdded: 0,
      conflicts: [],
      pendingQueue: 0,
      errors: [],
      failedPushes: [],
      warnings: [],
      reconciled: 0,
      watermark: null,
      noop: true,
    };
  }
}
