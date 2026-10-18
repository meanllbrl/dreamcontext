import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { loadStatuses, loadTaskOverride } from '../overrides.js';
import { DEFAULT_STATUSES, normalizeStatusKey, statusKeys, type StatusDef } from '../task-status.js';
import { readFrontmatter, updateFrontmatterFields, writeFrontmatter } from '../frontmatter.js';
import { insertToSection, listSections, readSection } from '../markdown.js';
import { generateId, slugify, today } from '../id.js';
import { fillTemplate } from '../template-fill.js';
import { normalizeRice } from '../rice.js';
import { isSafeAutomationSlug } from '../agents/slot.js';
import { healTaskRemoved, healTaskRename } from '../feature-links.js';
import { appendTombstone } from '../task-tombstones.js';
import { withTaskFileLock } from '../task-file-lock.js';
import {
  JOURNAL_DIR,
  appendJournalEntry,
  moveJournal,
  readJournal,
  readJournalRaw,
  retireJournal,
  type JournalEntry,
  type NewJournalEntry,
  kindOfLabel,
} from '../task-journal.js';
import { CARD_CEILING, foldCardChangelog } from '../task-card.js';
import { dateUpdatesForStatus } from '../task-dates.js';
import { filterTasks, toTaskRecord, type TaskFilter } from '../task-query.js';
import { liveChildren, loadFamily, loadTaskBriefs, normalizeParentRef, rolledUpStatus } from '../task-parent.js';
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
  type TaskListItem,
  type TaskSummary,
  type UpdateFieldsOptions,
} from './types.js';
import { parseCriteria } from '../task-evidence.js';
import type { LocalTaskDescriptor } from './sync-state.js';

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
 * The shipped task template (file on disk, else inline fallback). Byte-identical
 * to the pre-refactor CLI resolution (golden-pinned). Override grafting lives in
 * `resolveScaffoldTemplate`, NOT here — this is always the default.
 */
function getTaskTemplate(): string {
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
status: "{{STATUS}}"
created_at: "{{DATE}}"
updated_at: "{{DATE}}"
tags: {{TAGS}}
parent_task: null
related_feature: null
---

## Why

{{WHY}}
`;
}

/**
 * The canonical frontmatter header (`---…---`) of the shipped task template —
 * the structural contract every surface depends on (id, status, dates, tags,
 * version). Extracted so an override, whose OWN frontmatter is repurposed for
 * the `custom_fields:` schema and whose body carries only the section layout,
 * still scaffolds a task WITH a valid frontmatter rather than a header-less,
 * id-less file.
 */
function shippedFrontmatterBlock(): string {
  const lines = getTaskTemplate().split('\n');
  if (lines[0]?.trim() !== '---') return '';
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return close === -1 ? '' : lines.slice(0, close + 1).join('\n');
}

/**
 * Resolve the full scaffold template for `tasks create`. Absent an override it
 * is the shipped template verbatim (byte-identical — golden-pinned). With an
 * override BODY present, the shipped frontmatter contract is grafted onto the
 * project's custom body sections, so a scaffolded task is BOTH well-formed
 * (carries id/status/…) AND in the project's declared shape. (The override's
 * frontmatter is not a task header — `loadTaskOverride` consumes it as the
 * custom-field schema — so it must never be used as the scaffold's frontmatter.)
 */
function resolveScaffoldTemplate(overrideTemplate?: string | null): string {
  if (!overrideTemplate || !overrideTemplate.trim()) return getTaskTemplate();
  const fm = shippedFrontmatterBlock();
  if (!fm) return overrideTemplate; // defensive: no header to graft onto
  return `${fm}\n\n${overrideTemplate.trim()}\n`;
}

/**
 * The card with its provenance line (`from_proposal: "<id>"`) inside the frontmatter, so the
 * marker lands in the card's FIRST write. No id: the content unchanged (golden-pinned bytes).
 */
function withProvenance(content: string, fromProposal: string | undefined): string {
  if (!fromProposal) return content;
  const close = content.indexOf('\n---', 3);
  if (!content.startsWith('---') || close < 0) return content;
  return `${content.slice(0, close)}\nfrom_proposal: ${JSON.stringify(fromProposal)}${content.slice(close)}`;
}

/**
 * Substitute a task template's `{{TOKEN}}` placeholders. Shared by the CLI and
 * the dashboard create paths so a project override (`overrides/task.md`) renders
 * IDENTICALLY from both surfaces — only the no-override fallback differs per
 * surface. `name`/`status`/`description` are passed explicitly because the two
 * surfaces default them differently (the CLI keeps the requested status and
 * falls back to the name for a blank description; the dashboard always starts a
 * task in `todo`, trims the name, and allows a blank description). Keeping this
 * one function means the CLI override path stays byte-for-byte what it was
 * (golden-pinned) while the dashboard gains the same behavior.
 */
function renderTaskTemplate(
  template: string,
  input: CreateTaskInput,
  opts: { name: string; status: string; description: string },
): string {
  // One pass, every value literal (lib/template-fill.ts): a `$&`, `$'`, `` $` `` or `$$` in a
  // name or a Why reaches the card as typed. The id is drawn once, as before (golden).
  return fillTemplate(template, {
    ID: generateId('task'),
    NAME: opts.name,
    DESCRIPTION: opts.description,
    PRIORITY: input.priority ?? 'medium',
    URGENCY: input.urgency ?? 'medium',
    STATUS: opts.status,
    TAGS: JSON.stringify(input.tags ?? []),
    DATE: today(),
    WHY: input.why || '(To be defined)',
    VERSION: input.version ? JSON.stringify(input.version) : 'null',
  }, ['NAME', 'DESCRIPTION', 'STATUS']);
}

/**
 * Priority, urgency and version are retired from the shipped card (the
 * "when?" axis is cycle / queue / rank). A caller that still passes them (the
 * legacy dashboard form, a deprecated `-v`) gets them layered on, additively;
 * `tasks create` passes none, so its card carries none.
 */
function layerLegacyOrderFields(filePath: string, input: CreateTaskInput): void {
  const fields: Record<string, unknown> = {};
  if (input.priority) fields.priority = input.priority;
  if (input.urgency) fields.urgency = input.urgency;
  if (input.version) fields.version = input.version;
  if (input.queue) fields.queue = input.queue;
  if (Object.keys(fields).length > 0) updateFrontmatterFields(filePath, fields);
}

function safeParentRef(raw: unknown): string | null {
  const ref = normalizeParentRef(raw);
  return ref && isSafeTaskSlug(ref) ? ref : null;
}

function readSectionSafe(filePath: string, sectionName: string): string {
  try {
    return readSection(filePath, sectionName) ?? '';
  } catch {
    return '';
  }
}

/**
 * Read a task file into the full TaskData view (moved from server/routes/tasks.ts).
 * `statuses` is the project's loaded status set. A KNOWN status reads as its
 * key (hyphens normalised); an UNKNOWN non-empty status is PRESERVED verbatim
 * rather than coerced to `todo` — the file may carry a status a teammate
 * declared in an `overrides/task.md` this machine has not pulled yet, and
 * coercing it would let the next push reopen a closed issue / strip its label
 * (task-status.ts: unknown always fails SAFE and is named by `doctor`). Only an
 * empty status falls back to `todo`.
 */
export function readTaskFile(filePath: string, statuses: readonly StatusDef[] = DEFAULT_STATUSES): TaskData {
  const slug = basename(filePath, '.md');
  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);

  let sections: string[] = [];
  try {
    sections = listSections(filePath);
  } catch { /* no sections */ }

  // Normalize the status to its key form — hyphens to underscores AND lowercased
  // (`In-Progress` / `COMPLETED` are the same status as `in_progress` / `completed`).
  // Case folding matters beyond tidiness: several surfaces still compare the done
  // status literally (there is exactly one), and an un-lowercased `COMPLETED` would
  // slip past them.
  //
  // An unrecognised key is PRESERVED, not rewritten to `todo`. This is the ONE
  // deliberate divergence from the pre-declarable behaviour, and it is a real
  // behaviour change even for a project that declares nothing (a stray status in
  // an existing task file now surfaces as itself rather than reading as `todo`).
  //
  // It is the safer side of the trade: gating the preservation on the override
  // file existing would coerce a teammate's declared status to `todo` on exactly
  // the machine that has not pulled `overrides/task.md` yet — silently rewriting
  // their data, then pushing the rewrite back. The unknown-fails-safe doctrine
  // covers the fallout: an unknown status is never terminal, never deleted,
  // never reopened, never buried by a merge. See the header of ../overrides.ts.
  //
  // `statuses` is accepted so the signature reads honestly at every call site
  // even though the fallback no longer depends on it.
  void statusKeys;
  const rawStatus = normalizeStatusKey(data.status);
  const status = rawStatus || 'todo';

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
    // A slug (or a legacy id) that is safe to build a path from; anything else reads as none.
    parent_task: safeParentRef(data.parent_task),
    related_feature: (data.related_feature as string) ?? null,
    version: (data.version as string) ?? null,
    rice: normalizeRice(data.rice),
    start_date: (data.start_date as string) ?? null,
    due_date: (data.due_date as string) ?? null,
    objectives: Array.isArray(data.objectives) ? (data.objectives as unknown[]).map(String) : [],
    assignee: (data.assignee as string) ?? null,
    // Only a path-safe agent slug reads as an assignment: the value is a synced,
    // hand-editable string that later names a file. Absent rather than null, so
    // a task with no agent is the exact object it always was.
    ...(typeof data.agent === 'string' && isSafeAutomationSlug(data.agent.trim()) ? { agent: data.agent.trim() } : {}),
    custom_fields:
      data.custom_fields && typeof data.custom_fields === 'object' && !Array.isArray(data.custom_fields)
        ? (data.custom_fields as Record<string, string | number | null>)
        : {},
    // Absent unless set, so a task that came from no proposal is the exact object it always was.
    ...(typeof data.from_proposal === 'string' && data.from_proposal.trim() ? { from_proposal: data.from_proposal.trim() } : {}),
    why: readSectionSafe(filePath, 'Why'),
    user_stories: readSectionSafe(filePath, 'User Stories'),
    acceptance_criteria: readSectionSafe(filePath, 'Acceptance Criteria'),
    constraints: readSectionSafe(filePath, 'Constraints & Decisions'),
    technical_details: readSectionSafe(filePath, 'Technical Details'),
    notes: readSectionSafe(filePath, 'Notes'),
    // History is the journal; a card not folded yet still shows its old section.
    changelog: readSectionSafe(filePath, 'Changelog') || readJournalRaw(dirname(filePath), slug).trim(),
    sections,
    body: content.trim(),
    rawBody: content,
    raw: data,
    ...placementOf(data),
  };
}

/** The card's place on the "when?" axis (C3), read as stored. */
function placementOf(data: Record<string, unknown>): { cycle: string | null; queue: 'next' | 'later' | null; rank: number | null } {
  return {
    cycle: typeof data.cycle === 'string' && data.cycle.trim() ? data.cycle.trim() : null,
    queue: data.queue === 'next' || data.queue === 'later' ? data.queue : null,
    rank: typeof data.rank === 'number' && Number.isFinite(data.rank) ? data.rank : null,
  };
}

/**
 * The list view of one card (`GET /api/tasks`, plan r3 § W4): frontmatter, criteria
 * counts and the file size. Never a body, a section or the journal: the list is
 * polled, the body is the task page's (`GET /api/tasks/:slug`). `children` is filled
 * by the caller, which sees the whole family.
 */
export function readTaskCard(filePath: string): TaskListItem {
  const slug = basename(filePath, '.md');
  const { data } = readFrontmatter<Record<string, unknown>>(filePath);
  const criteria = parseCriteria(readSectionSafe(filePath, 'Acceptance Criteria'));
  let bytes = 0;
  try { bytes = statSync(filePath).size; } catch { /* vanished */ }
  return {
    slug,
    id: (data.id as string) ?? '',
    name: (data.name as string) ?? slug,
    description: (data.description as string) ?? '',
    status: normalizeStatusKey(data.status) || 'todo',
    created_at: (data.created_at as string) ?? '',
    updated_at: (data.updated_at as string) ?? '',
    tags: Array.isArray(data.tags) ? data.tags as string[] : [],
    parent_task: safeParentRef(data.parent_task),
    related_feature: (data.related_feature as string) ?? null,
    version: (data.version as string) ?? null,
    start_date: (data.start_date as string) ?? null,
    due_date: (data.due_date as string) ?? null,
    objectives: Array.isArray(data.objectives) ? (data.objectives as unknown[]).map(String) : [],
    assignee: (data.assignee as string) ?? null,
    ...(typeof data.agent === 'string' && isSafeAutomationSlug(data.agent.trim()) ? { agent: data.agent.trim() } : {}),
    custom_fields:
      data.custom_fields && typeof data.custom_fields === 'object' && !Array.isArray(data.custom_fields)
        ? (data.custom_fields as Record<string, string | number | null>)
        : {},
    created_by: typeof data.created_by === 'string' ? data.created_by : null,
    ...placementOf(data),
    criteria: { total: criteria.length, done: criteria.filter((c) => c.checked).length },
    children: null,
    bytes,
    // Legacy, read-only (decision 11): read as the full card reads them, so the board's
    // legacy views and filters keep their values.
    priority: (data.priority as string) ?? 'medium',
    urgency: (data.urgency as string) ?? 'medium',
    rice: normalizeRice(data.rice),
  };
}

/** {@link readTaskCard} through the read memo (keyed on the card's stat only: no journal in it). */
export function readTaskCardMemo(filePath: string): TaskListItem {
  return memoRead('card', filePath, () => readTaskCard(filePath));
}

// ─── Read memo ───────────────────────────────────────────────────────────────
//
// `GET /api/tasks` (polled every 15 s per window) runs `list()` and then `get()` per task, and
// `/api/tasks/members` does both again — a few hundred task files re-read and re-parsed per
// call, each `get()` reading its file nine times (frontmatter, section list, seven sections).
// Task: the desktop app stays light on an 8GB MacBook Air. The two READ paths go through this
// module-scoped memo (module-scoped and keyed by absolute path, because the route builds a
// backend per request): a file is re-read only when its (inode, size, mtime, ctime), taken
// from a stat BEFORE the read, moved — so a write from outside this process (the CLI, a git
// pull, a sync) is still seen — and every write path below forgets its file explicitly.
// Callers get `structuredClone`s, so nothing they do reaches the cached value. Write paths
// (read-modify-write under the lock) read fresh, never through here.

const READ_MEMO_MAX = 4096;
const readMemo = new Map<string, { sig: string; value: unknown }>();

function fileSig(path: string): string {
  const st = statSync(path);
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

/**
 * A task read also carries its journal (`changelog` falls back to
 * `state/journal/<slug>.md`), and a journal append — `tasks log` from another
 * process, an assignment, a pull — never touches the card's stat. So the `task`
 * memo is keyed on the journal's stat too; a missing journal reads as `none`.
 */
function journalSig(cardPath: string): string {
  try {
    return fileSig(join(dirname(cardPath), JOURNAL_DIR, basename(cardPath)));
  } catch {
    return 'none';
  }
}

function memoRead<T>(kind: 'fm' | 'task' | 'card', path: string, read: () => T): T {
  const abs = resolve(path);
  const key = `${kind}\0${abs}`;
  const sig = kind === 'task' ? `${fileSig(abs)}|${journalSig(abs)}` : fileSig(abs);
  const hit = readMemo.get(key);
  readMemo.delete(key);
  if (hit && hit.sig === sig) {
    readMemo.set(key, hit);
    return structuredClone(hit.value) as T;
  }
  const value = read();
  readMemo.set(key, { sig, value });
  while (readMemo.size > READ_MEMO_MAX) {
    const oldest = readMemo.keys().next();
    if (oldest.done) break;
    readMemo.delete(oldest.value);
  }
  return structuredClone(value);
}

/** Drop the memoized reads of one task file (after this process wrote it). */
export function forgetTaskRead(path: string): void {
  const abs = resolve(path);
  readMemo.delete(`fm\0${abs}`);
  readMemo.delete(`task\0${abs}`);
  readMemo.delete(`card\0${abs}`);
}

/** Tests only: forget every memoized task read. */
export function resetTaskReadMemo(): void {
  readMemo.clear();
}

/**
 * The current file-based task store, behind the TaskBackend interface.
 * Every byte it writes is pinned by tests/unit/task-backend-golden.test.ts —
 * it must stay indistinguishable from the pre-refactor CLI + routes.
 */
export class LocalTaskBackend implements TaskBackend {
  readonly name: string = 'local';

  constructor(protected readonly stateDir: string) {}

  private _statusDefs?: StatusDef[];
  /** The project's status set (overrides/task.md → shipped four), cached per instance. */
  protected statusDefs(): StatusDef[] {
    if (this._statusDefs === undefined) this._statusDefs = loadStatuses(dirname(this.stateDir));
    return this._statusDefs;
  }

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

  /**
   * Like `liveTaskIdentities`, but also carries each task's `name` — what the
   * pull-side fallback matcher (`matchLocalTaskForRemote`, #204) needs to
   * re-link an incoming remote task whose `.tasks-map.json` entry was lost
   * (e.g. to a team-merge conflict), instead of minting a fresh `-N`
   * duplicate mirror.
   */
  protected liveTaskDescriptors(): LocalTaskDescriptor[] {
    const out: LocalTaskDescriptor[] = [];
    for (const file of this.taskFiles()) {
      try {
        const { data } = readFrontmatter<{ id?: string; name?: string }>(file);
        if (data.id && data.name) out.push({ slug: basename(file, '.md'), dcId: data.id, name: data.name });
      } catch { /* skip unreadable */ }
    }
    return out;
  }

  async list(filter?: TaskFilter): Promise<TaskSummary[]> {
    const all: TaskSummary[] = [];
    for (const file of this.taskFiles()) {
      try {
        const { data } = memoRead('fm', file, () => readFrontmatter<Record<string, unknown>>(file));
        all.push(toTaskRecord(data, basename(file, '.md'), file));
      } catch { /* skip unreadable */ }
    }
    return filter ? filterTasks(all, { statuses: this.statusDefs(), ...filter }) : all;
  }

  async get(slug: string): Promise<TaskData | null> {
    if (!isSafeTaskSlug(slug)) return null;
    const path = this.taskPath(slug);
    if (!existsSync(path)) return null;
    const statuses = this.statusDefs();
    return memoRead('task', path, () => readTaskFile(path, statuses));
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
    // Cheap pre-check so the common "already exists" case fails without paying
    // for a lock. It is NOT the guarantee — see the re-check inside the lock.
    if (existsSync(filePath)) {
      throw new TaskBackendError('already_exists', `Task already exists: ${slug}`);
    }
    const created = withTaskFileLock(this.brainRoot(), slug, () => this.writeNewTaskSync(slug, filePath, input));
    if (created.parent_task) await this.syncParentStatus(created.parent_task);
    return created;
  }

  /** The scaffold write itself — always called under {@link withTaskFileLock}. */
  private writeNewTaskSync(slug: string, filePath: string, input: CreateTaskInput): TaskData {
    // THE existence guarantee, re-checked with the lock held. The pre-check in
    // `create` above is a time-of-check/time-of-use window: two processes filing
    // the same name (a person and a background sleep cycle, or a create racing a
    // rename) can BOTH pass it, and whichever takes the lock second would
    // silently overwrite the first task — a lost write in exactly the
    // two-writer case this lock exists to close.
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
      const template = resolveScaffoldTemplate(override?.template);
      const content = renderTaskTemplate(template, input, {
        name: input.name,
        status: input.status ?? 'todo',
        description: input.description ?? input.name,
      });

      writeFileSync(filePath, withProvenance(content, input.from_proposal), 'utf-8');
      layerLegacyOrderFields(filePath, input);
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
    } else if (override?.template && override.template.trim()) {
      // The dashboard ALSO honors the project's custom task shape, so a task
      // created from the UI is indistinguishable from one created via the CLI.
      // Gated on an override being present: absent one, the no-override skeleton
      // below runs unchanged and stays byte-identical (golden-pinned). Dashboard
      // semantics are preserved within the override: always start in `todo`,
      // trim the name, allow a blank description. Schedule/score fields the
      // template has no placeholder for are layered on afterward (as the CLI
      // override path does), so a custom template needn't know about them.
      const content = renderTaskTemplate(resolveScaffoldTemplate(override.template), input, {
        name: input.name.trim(),
        status: 'todo',
        description: input.description ?? '',
      });
      writeFileSync(filePath, withProvenance(content, input.from_proposal), 'utf-8');
      layerLegacyOrderFields(filePath, input);
      if (input.rice) {
        updateFrontmatterFields(filePath, { rice: input.rice });
      }
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
      // Every string scalar through JSON.stringify: a valid YAML double-quoted scalar for any
      // text (a `"` or `\` in a name used to end it early and corrupt the card), and the same
      // bytes as before for a plain or Turkish value (golden-pinned).
      const q = (v: string) => JSON.stringify(v);
      const tagsYaml = tags.length > 0 ? `[${tags.map(t => q(t)).join(', ')}]` : '[]';
      const versionYaml = input.version ? q(input.version) : 'null';
      const riceYaml = input.rice
        ? `\nrice:\n  reach: ${input.rice.reach ?? 'null'}\n  impact: ${input.rice.impact ?? 'null'}\n  confidence: ${input.rice.confidence ?? 'null'}\n  effort: ${input.rice.effort ?? 'null'}\n  score: ${input.rice.score ?? 'null'}`
        : '';
      const content = `---
id: "${generateId('task')}"
name: ${q(name)}
description: ${q(input.description ?? '')}
priority: ${q(input.priority ?? 'medium')}
urgency: ${q(input.urgency ?? 'medium')}
status: "todo"
created_at: "${dateStr}"
updated_at: "${dateStr}"
tags: ${tagsYaml}
parent_task: null
related_feature: null
version: ${versionYaml}${riceYaml}${input.from_proposal ? `\nfrom_proposal: ${q(input.from_proposal)}` : ''}
---

## Why

${input.why || '(To be defined)'}
`;
      writeFileSync(filePath, content, 'utf-8');
      if (input.start_date) {
        updateFrontmatterFields(filePath, { start_date: input.start_date });
      }
      if (input.due_date) {
        updateFrontmatterFields(filePath, { due_date: input.due_date });
      }
    }

    // Objectives are additive like start/due dates: written only when provided,
    // so tasks created without them keep the exact template bytes (golden-pinned).
    if (input.objectives && input.objectives.length > 0) {
      updateFrontmatterFields(filePath, { objectives: input.objectives });
    }
    // Parent and cycle: additive the same way (absent → template bytes unchanged).
    if (input.parent_task) {
      updateFrontmatterFields(filePath, { parent_task: input.parent_task });
    }
    if (input.cycle) {
      updateFrontmatterFields(filePath, { cycle: input.cycle });
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

    // History starts in the journal, never on the card.
    appendJournalEntry(this.stateDir, slug, { kind: 'created', body: '- Task created.' });

    forgetTaskRead(filePath);
    return readTaskFile(filePath, this.statusDefs());
  }

  async updateFields(
    slug: string,
    fields: Record<string, unknown>,
    opts?: UpdateFieldsOptions,
  ): Promise<TaskData> {
    const path = this.requirePath(slug);
    // A status or parent change moves the family's roll-up: remember the parent
    // before the write so a child leaving one parent updates both.
    const familyMove = fields.status !== undefined || fields.parent_task !== undefined;
    let parentBefore: string | null = null;
    // The whole read-modify-write is inside the lock: two writers that both
    // READ before either WRITES silently lose one side's fields.
    const task = withTaskFileLock(this.brainRoot(), slug, () => {
      if (familyMove) parentBefore = safeParentRef(readFrontmatter<Record<string, unknown>>(path).data.parent_task);
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
      // A body that still carries a `## Changelog` (an old client, a pasted
      // card) is folded into the journal on the way in — never kept, never lost.
      foldCardChangelog(path);
      forgetTaskRead(path);
      return readTaskFile(path, this.statusDefs());
    });
    if (familyMove) {
      for (const parent of new Set([parentBefore, task.parent_task])) {
        if (parent && parent !== slug) await this.syncParentStatus(parent);
      }
    }
    return task;
  }

  /**
   * Recompute a parent's status from its children and store it (journaled), so
   * the board, the snapshot and the remote all read a real value. A no-op for
   * a task without live children, a closed parent, or one already in step.
   * Returns the new status when it moved.
   */
  /**
   * Recompute every parent once. A pull writes children's statuses through the
   * mirror, not through {@link updateFields}, so it calls this after its batch:
   * otherwise a parent whose children all closed remotely never moves.
   */
  async syncAllParentStatuses(report?: { errors: string[] }): Promise<void> {
    for (const parent of new Set(loadFamily(this.stateDir).parentOf.values())) {
      try {
        await this.syncParentStatus(parent);
      } catch (err) {
        report?.errors.push(`parent roll-up ${parent}: ${(err as Error).message ?? err}`);
      }
    }
  }

  async syncParentStatus(parentSlug: string): Promise<string | null> {
    if (!isSafeTaskSlug(parentSlug)) return null;
    const family = loadFamily(this.stateDir);
    const resolved = family.bySlug.has(parentSlug)
      ? parentSlug
      : [...family.bySlug.values()].find((b) => b.id === parentSlug)?.slug;
    if (!resolved) return null;
    const parent = await this.get(resolved);
    if (!parent) return null;
    const next = rolledUpStatus(this.statusDefs(), parent.status, parent.rawBody, family.children.get(resolved) ?? []);
    if (!next) return null;
    const now = today();
    await this.addJournal(resolved, {
      kind: 'status',
      label: `Status → ${next}`,
      body: `- computed from its sub-tasks (was ${parent.status})`,
    });
    const dates = dateUpdatesForStatus(next, parent, now, this.statusDefs());
    await this.updateFields(resolved, { status: next, updated_at: now, ...dates });
    return next;
  }

  async insertSection(
    slug: string,
    sectionName: string,
    content: string,
    opts: InsertSectionOptions,
  ): Promise<void> {
    const path = this.requirePath(slug);
    // History is the journal: a `Changelog` insert lands there, not on the card.
    if (sectionName.trim().toLowerCase() === 'changelog') {
      await this.addChangelog(slug, content);
      return;
    }
    try {
      withTaskFileLock(this.brainRoot(), slug, () => {
        foldCardChangelog(path);
        // The card ceiling. Criteria stay insertable past it, so sleep's first
        // choice (a criterion in an existing task) still works on a legacy card.
        if (sectionName.trim().toLowerCase() !== 'acceptance criteria') {
          const size = readFileSync(path, 'utf-8').length;
          if (size + content.length > CARD_CEILING) {
            throw new TaskBackendError(
              'invalid_input',
              `Card ceiling: ${slug} would be ${size + content.length} chars (limit ${CARD_CEILING}). ` +
                'A card holds what the work is and how it is proven; put history in the journal ' +
                '(`dreamcontext tasks log`) and long material in knowledge (`dreamcontext knowledge create`).',
            );
          }
        }
        insertToSection(path, sectionName, content, opts.position, true, opts.replacePlaceholders ?? false);
      });
    } finally {
      forgetTaskRead(path);
    }
  }

  /**
   * Legacy entry point: a formatted `### <date> - <label>\n<body>` block. Its
   * label picks the journal kind (`Completed` → status, `Created` → created,
   * anything else → log) and is kept as the entry's label.
   */
  async addChangelog(slug: string, entry: string, _opts?: AddChangelogOptions): Promise<void> {
    const m = /^###\s+\S+(?:\s+\d{2}:\d{2})?\s+-\s+(.*)\n?([\s\S]*)$/.exec(entry.trim());
    if (!m) {
      await this.addJournal(slug, { kind: 'log', body: entry.trim() });
      return;
    }
    const { kind, rest } = kindOfLabel(m[1]);
    const generic = /^(session update|update|dashboard update)$/i.test(rest) || rest === kind;
    await this.addJournal(slug, { kind, ...(generic || !rest ? {} : { label: rest }), body: m[2].trim() });
  }

  async addJournal(slug: string, entry: NewJournalEntry): Promise<JournalEntry> {
    const path = this.requirePath(slug);
    // `tasks log` is the single most concurrent task write there is — the
    // foreground logs progress while a background cycle reconciles the board —
    // and the journal is a read-modify-write, so it shares the card's lock.
    // The fold rewrites the card, so the read memo forgets it either way.
    try {
      return withTaskFileLock(this.brainRoot(), slug, () => {
        foldCardChangelog(path);
        return appendJournalEntry(this.stateDir, slug, entry);
      });
    } finally {
      forgetTaskRead(path);
    }
  }

  async readJournal(slug: string): Promise<JournalEntry[]> {
    if (!isSafeTaskSlug(slug)) return [];
    return readJournal(this.stateDir, slug);
  }

  async complete(slug: string, summary?: string): Promise<TaskData> {
    const now = today();
    await this.addJournal(slug, { kind: 'status', label: 'Completed', body: `- ${summary ?? 'Task completed.'}` });
    // Completing stamps the REAL end of the window, so the timeline shows what
    // happened rather than what was planned (see lib/task-dates.ts). Lives here
    // rather than in the CLI so every backend and every caller of `complete()`
    // records the same thing.
    const dates = dateUpdatesForStatus('completed', await this.get(slug), now);
    return this.updateFields(slug, { status: 'completed', updated_at: now, ...dates });
  }

  async delete(slug: string, opts: { absorbedBy?: string; reason?: string } = {}): Promise<void> {
    const path = this.requirePath(slug);
    // A parent with live sub-tasks is never deleted: its children would lose
    // the context they exist to carry. Closed children are detached first.
    const family = loadFamily(this.stateDir);
    const live = liveChildren(family, this.statusDefs(), slug);
    if (live.length > 0) {
      throw new TaskBackendError(
        'invalid_input',
        `${slug} has ${live.length} live sub-task(s): ${live.map((c) => c.slug).join(', ')}. ` +
          'Close, move (`tasks parent <child> <other-parent>`) or detach (`tasks parent <child> clear`) them first.',
      );
    }
    for (const child of family.children.get(slug) ?? []) {
      await this.updateFields(child.slug, { parent_task: null });
      await this.addJournal(child.slug, { kind: 'log', body: `- detached: its parent ${slug} was deleted` });
    }
    // Read the id BEFORE unlinking — a tombstone that can name the task id stays
    // traceable through a remote backend's mapping.
    const doomed = await this.get(slug).catch(() => null);
    withTaskFileLock(this.brainRoot(), slug, () => {
      rmSync(path);
      // The journal is history, not litter: it moves beside the tombstone.
      try { retireJournal(this.stateDir, slug); } catch (err) {
        console.error(`Warning: could not retire the journal of ${slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    forgetTaskRead(path);
    // A deleted FILE proves nothing later; this marker does. Without it a sleep
    // cycle re-files a chore somebody deliberately consolidated away.
    appendTombstone(this.brainRoot(), {
      slug,
      ...(doomed?.id ? { id: doomed.id } : {}),
      deletedAt: new Date().toISOString(),
      ...(opts.absorbedBy ? { absorbedBy: opts.absorbedBy } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    // Referential integrity: no feature may keep listing a task that is gone.
    this.healFeatureLinks(() => healTaskRemoved(this.brainRoot(), slug));
    // A deleted child moves its parent's roll-up.
    if (doomed?.parent_task) await this.syncParentStatus(doomed.parent_task);
  }

  /** The brain root (`_dream_context/`) — stateDir is always `<root>/state`. */
  protected brainRoot(): string {
    return dirname(this.stateDir);
  }

  /**
   * Feature-side link healing must never block the primary task operation —
   * but a failure is still reported loudly (a silent skip would reintroduce
   * exactly the dangling refs this exists to prevent).
   */
  protected healFeatureLinks(heal: () => void): void {
    try {
      heal();
    } catch (err) {
      console.error(`Warning: task↔feature link healing failed: ${err instanceof Error ? err.message : String(err)} — run \`dreamcontext doctor\` to audit links.`);
    }
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
    withTaskFileLock(this.brainRoot(), slug, () => {
      renameSync(path, this.taskPath(newSlug));
      moveJournal(this.stateDir, slug, newSlug);
    });
    forgetTaskRead(path);
    forgetTaskRead(this.taskPath(newSlug));
    // A rename retires the OLD slug just as surely as a delete does: anything
    // that remembers it (a sleep cycle's fixed-slug lookup, a wikilink) must be
    // pointed at where the work went rather than concluding it never existed.
    appendTombstone(this.brainRoot(), {
      slug,
      deletedAt: new Date().toISOString(),
      absorbedBy: newSlug,
      reason: 'renamed',
    });
    // Referential integrity: features listing the old slug follow the rename.
    this.healFeatureLinks(() => healTaskRename(this.brainRoot(), slug, newSlug));
    // ...and so do the sub-tasks pointing at it (the old slug, or a legacy id).
    const renamedId = readFrontmatter<{ id?: string }>(this.taskPath(newSlug)).data.id ?? null;
    for (const child of loadTaskBriefs(this.stateDir)) {
      if (child.slug !== newSlug && (child.parent === slug || (renamedId && child.parent === renamedId))) {
        await this.updateFields(child.slug, { parent_task: newSlug });
      }
    }
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
      mirrorRemapped: 0,
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
