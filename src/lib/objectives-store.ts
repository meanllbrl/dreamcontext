import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, writeFrontmatter, updateFrontmatterFields } from './frontmatter.js';
import { today } from './id.js';

/**
 * Objectives store — PO-authored OKR roadmap items (task_uO60nZRt).
 *
 * One markdown file per objective under `_dream_context/core/objectives/<slug>.md`
 * (mirrors how features/tasks are stored: recallable, editable, wikilinkable,
 * dashboard-renderable). The PO owns these files — nothing here is auto-generated;
 * the derived board lives in `knowledge/roadmap/board.md` (see roadmap-model.ts).
 *
 * Dependencies (`depends_on`) form a DAG by construction: `addDependency` runs a
 * write-time DFS cycle check, so `buildRoadmapModel` can always topo-sort.
 */

/** Rollup statuses (mirror the board colors: grey/blue/amber/green). */
export const OBJECTIVE_STATUSES = ['not_started', 'active', 'review', 'done'] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export interface Objective {
  slug: string;
  title: string;
  /** PO-committed start of the objective window (YYYY-MM-DD) or null. */
  start_date: string | null;
  /** PO-committed target/end date (YYYY-MM-DD) or null. Compared vs forecast for slip. */
  target_date: string | null;
  /** Slugs of objectives this one depends on (DAG edges, cycle-guarded on write). */
  depends_on: string[];
  /** Optional link to a backing feature PRD slug. */
  feature: string | null;
  /** Prioritization (value/effort 2×2). Impact 1–5; effort in weeks (>0, ≤52). */
  impact: number | null;
  effort: number | null;
  /** Optional manual PO override; null = status is computed from member tasks. */
  status: ObjectiveStatus | null;
  created_at: string | null;
  updated_at: string | null;
  /** Absolute path of the objective file. */
  path: string;
  /** Markdown body (Why / notes — PO-authored prose). */
  body: string;
}

export interface CreateObjectiveInput {
  slug: string;
  title: string;
  start_date?: string | null;
  target_date?: string | null;
  depends_on?: string[];
  feature?: string | null;
  impact?: number | null;
  effort?: number | null;
  why?: string;
}

export interface UpdateObjectiveInput {
  title?: string;
  /** `null` clears the start. */
  start_date?: string | null;
  /** `null` clears the target. */
  target_date?: string | null;
  feature?: string | null;
  /** `null` clears the prioritization value. */
  impact?: number | null;
  effort?: number | null;
  /** `null` clears the manual override (back to computed). */
  status?: ObjectiveStatus | null;
}

export class ObjectiveError extends Error {}

export function objectivesDir(contextRoot: string): string {
  return join(contextRoot, 'core', 'objectives');
}

export function objectivePath(contextRoot: string, slug: string): string {
  return join(objectivesDir(contextRoot), `${slug}.md`);
}

/** True for a real calendar date in YYYY-MM-DD form (rejects e.g. 2026-13-40). */
export function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Kebab-case, path-safe objective slug (same shape task slugs use). */
export function isSafeObjectiveSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) && !slug.includes('--') && !slug.endsWith('-');
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function toObjectiveStatus(v: unknown): ObjectiveStatus | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return (OBJECTIVE_STATUSES as readonly string[]).includes(s) ? (s as ObjectiveStatus) : null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate the value/effort 2×2 inputs against the same scales the task RICE uses
 * (`rice.ts`): impact is an integer 1–5, effort a number of weeks in (0, 52].
 * `null`/`undefined` clears the field and is always allowed.
 */
function validateImpactEffort(impact: number | null | undefined, effort: number | null | undefined): void {
  if (impact !== null && impact !== undefined && (!Number.isInteger(impact) || impact < 1 || impact > 5)) {
    throw new ObjectiveError(`Impact must be an integer 1–5, got "${impact}".`);
  }
  if (effort !== null && effort !== undefined && (!Number.isFinite(effort) || effort <= 0 || effort > 52)) {
    throw new ObjectiveError(`Effort must be a number of weeks in (0, 52], got "${effort}".`);
  }
}

function readObjectiveFile(filePath: string): Objective {
  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  const slug = basename(filePath, '.md');
  const strOrNull = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === '' || s === 'null' ? null : s;
  };
  // Date fields must be read defensively. A hand-edited UNQUOTED YAML date
  // (`start_date: 2026-07-03`) is parsed by js-yaml as a `Date` OBJECT, not a
  // string; naively stringifying it yields "Fri Jul 03 2026 …", which is not a
  // calendar date and would poison the forecast cascade (NaN → "NaN-NaN-NaN"
  // winning string comparisons and corrupting every dependent). Coerce a Date to
  // its UTC calendar day (js-yaml parses date-only as UTC midnight), and null out
  // any string that isn't a valid YYYY-MM-DD so a bad value degrades to
  // "unforecastable" instead of silently corrupting the board.
  const dateOrNull = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) return null;
      return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
    }
    const s = String(v).trim();
    if (s === '' || s === 'null') return null;
    return isCalendarDate(s) ? s : null;
  };
  return {
    slug,
    title: typeof data.title === 'string' && data.title.trim() ? data.title : slug,
    start_date: dateOrNull(data.start_date),
    target_date: dateOrNull(data.target_date),
    depends_on: toStringArray(data.depends_on),
    feature: strOrNull(data.feature),
    impact: numOrNull(data.impact),
    effort: numOrNull(data.effort),
    status: toObjectiveStatus(data.status),
    created_at: dateOrNull(data.created_at),
    updated_at: dateOrNull(data.updated_at),
    path: filePath,
    body: content.trim(),
  };
}

/** All objectives, sorted by slug (stable). Missing directory → empty list. */
export function listObjectives(contextRoot: string): Objective[] {
  const dir = objectivesDir(contextRoot);
  if (!existsSync(dir)) return [];
  const files = fg.sync('*.md', { cwd: dir, absolute: true }).sort();
  const out: Objective[] = [];
  for (const file of files) {
    try {
      out.push(readObjectiveFile(file));
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function getObjective(contextRoot: string, slug: string): Objective | null {
  const path = objectivePath(contextRoot, slug);
  if (!isSafeObjectiveSlug(slug) || !existsSync(path)) return null;
  try {
    return readObjectiveFile(path);
  } catch {
    return null;
  }
}

/**
 * Would adding edge `from depends_on to` create a cycle?
 * True iff `to` can already reach `from` by following depends_on edges.
 * Exported for tests; `addDependency`/`createObjective` enforce it on write.
 */
export function wouldCreateCycle(objectives: Objective[], from: string, to: string): boolean {
  if (from === to) return true;
  const bySlug = new Map(objectives.map((o) => [o.slug, o]));
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const dep of bySlug.get(cur)?.depends_on ?? []) stack.push(dep);
  }
  return false;
}

function validateTargetDate(target: string | null | undefined): void {
  if (target !== null && target !== undefined && !isCalendarDate(target)) {
    throw new ObjectiveError(`Target date must be a valid YYYY-MM-DD, got "${target}".`);
  }
}

/**
 * Validate the committed window: each of start/target (when present) is a real
 * calendar date, and start is not after target. Either may be null (open-ended).
 */
function validateDateRange(start: string | null | undefined, target: string | null | undefined): void {
  if (start !== null && start !== undefined && !isCalendarDate(start)) {
    throw new ObjectiveError(`Start date must be a valid YYYY-MM-DD, got "${start}".`);
  }
  validateTargetDate(target);
  if (start && target && start > target) {
    throw new ObjectiveError(`Start date (${start}) cannot be after the target date (${target}).`);
  }
}

export function createObjective(contextRoot: string, input: CreateObjectiveInput): Objective {
  const slug = input.slug.trim();
  if (!isSafeObjectiveSlug(slug)) {
    throw new ObjectiveError(
      `Invalid objective slug "${slug}" — use kebab-case (e.g. increase-retention-20).`,
    );
  }
  const path = objectivePath(contextRoot, slug);
  if (existsSync(path)) {
    throw new ObjectiveError(`Objective already exists: ${slug}`);
  }
  validateDateRange(input.start_date, input.target_date);
  validateImpactEffort(input.impact, input.effort);

  const existing = listObjectives(contextRoot);
  const depends = Array.from(new Set((input.depends_on ?? []).map((s) => s.trim()).filter(Boolean)));
  for (const dep of depends) {
    if (dep === slug) throw new ObjectiveError('An objective cannot depend on itself.');
    if (!existing.some((o) => o.slug === dep)) {
      throw new ObjectiveError(
        `Unknown dependency "${dep}". Create it first: dreamcontext roadmap objective create ${dep} --title "..."`,
      );
    }
  }

  mkdirSync(objectivesDir(contextRoot), { recursive: true });
  const date = today();
  const frontmatter: Record<string, unknown> = {
    title: input.title,
    start_date: input.start_date ?? null,
    target_date: input.target_date ?? null,
    depends_on: depends,
    feature: input.feature ?? null,
    impact: input.impact ?? null,
    effort: input.effort ?? null,
    status: null,
    created_at: date,
    updated_at: date,
  };
  const body = [
    '## Why',
    '',
    input.why?.trim() || '(What outcome is this objective driving, and why does it matter?)',
    '',
    '## Notes',
    '',
    '(PO notes — key results, context, links. Member tasks and rollups are computed:',
    'run `dreamcontext roadmap` for the live board.)',
    '',
  ].join('\n');
  writeFrontmatter(path, frontmatter, body);
  return readObjectiveFile(path);
}

export function updateObjective(
  contextRoot: string,
  slug: string,
  patch: UpdateObjectiveInput,
): Objective {
  const existing = getObjective(contextRoot, slug);
  if (!existing) throw new ObjectiveError(`Objective not found: ${slug}`);
  if ('start_date' in patch || 'target_date' in patch) {
    validateDateRange(
      'start_date' in patch ? patch.start_date : existing.start_date,
      'target_date' in patch ? patch.target_date : existing.target_date,
    );
  }
  if ('impact' in patch || 'effort' in patch) {
    validateImpactEffort(
      'impact' in patch ? patch.impact : existing.impact,
      'effort' in patch ? patch.effort : existing.effort,
    );
  }
  if ('status' in patch && patch.status !== null && patch.status !== undefined
      && !(OBJECTIVE_STATUSES as readonly string[]).includes(patch.status)) {
    throw new ObjectiveError(`Status must be one of: ${OBJECTIVE_STATUSES.join(', ')} (or cleared).`);
  }
  const updates: Record<string, unknown> = { updated_at: today() };
  if (patch.title !== undefined) updates.title = patch.title;
  if ('start_date' in patch) updates.start_date = patch.start_date ?? null;
  if ('impact' in patch) updates.impact = patch.impact ?? null;
  if ('effort' in patch) updates.effort = patch.effort ?? null;
  if ('target_date' in patch) updates.target_date = patch.target_date ?? null;
  if ('feature' in patch) updates.feature = patch.feature ?? null;
  if ('status' in patch) updates.status = patch.status ?? null;
  updateFrontmatterFields(existing.path, updates);
  return readObjectiveFile(existing.path);
}

/**
 * Delete an objective. Fully self-healing: the slug is removed from every other
 * objective's `depends_on` AND from every task's `objectives:` list, so no dangling
 * dependency edge or membership reference survives (no orphan warnings after a
 * delete). Task edits touch only the local-only `objectives` field — updated_at is
 * left untouched so the change never masquerades as a syncable task edit.
 *
 * Returns the basenames of any task files that reference this objective but could
 * NOT be healed (unparseable frontmatter). This is normally empty; a non-empty list
 * means those tasks keep a dangling reference and the caller should surface a warning
 * rather than silently claim a clean delete.
 */
export function deleteObjective(contextRoot: string, slug: string): { unhealedTasks: string[] } {
  const existing = getObjective(contextRoot, slug);
  if (!existing) throw new ObjectiveError(`Objective not found: ${slug}`);
  // Heal other objectives' depends_on edges.
  for (const other of listObjectives(contextRoot)) {
    if (other.slug !== slug && other.depends_on.includes(slug)) {
      updateFrontmatterFields(other.path, {
        depends_on: other.depends_on.filter((d) => d !== slug),
        updated_at: today(),
      });
    }
  }
  // Heal task membership: strip the slug from any task's `objectives:` list.
  const unhealedTasks: string[] = [];
  const stateDir = join(contextRoot, 'state');
  if (existsSync(stateDir)) {
    for (const file of fg.sync('*.md', { cwd: stateDir, absolute: true })) {
      let objectives: string[];
      try {
        const { data } = readFrontmatter<Record<string, unknown>>(file);
        objectives = Array.isArray(data.objectives)
          ? data.objectives.map((s) => String(s).trim()).filter(Boolean)
          : [];
      } catch (err) {
        // A file that won't parse MIGHT reference this objective — we can't tell,
        // so we can't heal it. Record + log instead of silently dropping it, so a
        // dangling reference never hides behind a "clean delete".
        unhealedTasks.push(basename(file));
        console.error(`[objectives] delete "${slug}": could not read task ${basename(file)} to heal its objectives list:`, err);
        continue;
      }
      if (objectives.includes(slug)) {
        try {
          updateFrontmatterFields(file, { objectives: objectives.filter((o) => o !== slug) });
        } catch (err) {
          unhealedTasks.push(basename(file));
          console.error(`[objectives] delete "${slug}": could not rewrite task ${basename(file)} to drop the reference:`, err);
        }
      }
    }
  }
  unlinkSync(existing.path);
  return { unhealedTasks };
}

/**
 * Add `from depends_on to`. Rejects unknown slugs, self-deps, duplicates, and —
 * the write-time guard the review demanded — any edge that would close a cycle.
 */
export function addDependency(contextRoot: string, from: string, to: string): Objective {
  const objectives = listObjectives(contextRoot);
  const a = objectives.find((o) => o.slug === from);
  const b = objectives.find((o) => o.slug === to);
  if (!a) throw new ObjectiveError(`Objective not found: ${from}`);
  if (!b) throw new ObjectiveError(`Objective not found: ${to}`);
  if (a.depends_on.includes(to)) {
    throw new ObjectiveError(`${from} already depends on ${to}.`);
  }
  if (wouldCreateCycle(objectives, from, to)) {
    throw new ObjectiveError(
      `Refusing: "${from} depends on ${to}" would create a circular dependency `
      + `(${to} already reaches ${from} through the dependency chain).`,
    );
  }
  updateFrontmatterFields(a.path, {
    depends_on: [...a.depends_on, to],
    updated_at: today(),
  });
  return readObjectiveFile(a.path);
}

export function removeDependency(contextRoot: string, from: string, to: string): Objective {
  const a = getObjective(contextRoot, from);
  if (!a) throw new ObjectiveError(`Objective not found: ${from}`);
  if (!a.depends_on.includes(to)) {
    throw new ObjectiveError(`${from} does not depend on ${to}.`);
  }
  updateFrontmatterFields(a.path, {
    depends_on: a.depends_on.filter((d) => d !== to),
    updated_at: today(),
  });
  return readObjectiveFile(a.path);
}
