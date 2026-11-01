import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from './glob.js';
import { readFrontmatter, writeFrontmatter, updateFrontmatterFields } from './frontmatter.js';
import { today } from './id.js';
import { withLockFileAt, withTaskFileLock } from './task-file-lock.js';
import { computeRiceScore } from './rice.js';
import {
  normalizePrioritySuggestion,
  serializePrioritySuggestion,
  suggestionRefusal,
  suggestionGaps,
  validatePrioritySuggestion,
  buildSuggestionRecord,
  planAccept,
  planDismiss,
  SuggestionError,
  type ObjectiveLiveness,
  type PrioritySuggestion,
  type RicePart,
  type RiceKey,
  type SuggestionInput,
  type SuggestionTarget,
} from './priority-suggestion.js';

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

/**
 * A Key Result metric — the "outcome" progress source for objectives that can't be
 * rolled up from checkbox tasks (e.g. "$2000 MRR", "5 enterprise customers"). When an
 * objective carries a metric, progress is computed from `current` against the
 * `baseline → target` span instead of from member-task completion (see roadmap-model).
 * `baseline` and `target` may run in either direction (target > baseline for a growth
 * goal, target < baseline for a reduce-churn goal); they must differ.
 */
export interface ObjectiveMetric {
  /** What the number measures (e.g. "MRR"). */
  label: string;
  /** Display unit (e.g. "USD", "customers"), or null. */
  unit: string | null;
  /** Starting value progress is measured from. */
  baseline: number;
  /** The value that means 100% done. Must differ from baseline. */
  target: number;
  /** The latest observed value — the field the agent / PO updates over time. */
  current: number;
}

/** Partial metric edit (merged onto the existing metric, or seeds a new one). */
export interface MetricPatch {
  label?: string;
  unit?: string | null;
  baseline?: number;
  target?: number;
  current?: number;
}

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
  /** Full RICE: reach 1–10, confidence 25|50|75|100. Score = computeRiceScore over the four. */
  reach: number | null;
  confidence: number | null;
  /** RICE score over reach, impact, confidence, effort; null unless all four are set. */
  score: number | null;
  /** The agent's pending/dismissed/accepted proposal (local-only, never an owner value). */
  priority_suggestion: PrioritySuggestion | null;
  /** Optional manual PO override; null = status is computed from member tasks. */
  status: ObjectiveStatus | null;
  /** Optional Key Result metric; when set, it drives progress instead of tasks. */
  metric: ObjectiveMetric | null;
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
  reach?: number | null;
  confidence?: number | null;
  metric?: ObjectiveMetric | null;
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
  reach?: number | null;
  confidence?: number | null;
  /** `null` clears the manual override (back to computed). */
  status?: ObjectiveStatus | null;
  /** Full Key Result metric object, or `null` to remove it (back to task-based). */
  metric?: ObjectiveMetric | null;
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
function validateImpactEffort(
  impact: number | null | undefined,
  effort: number | null | undefined,
  reach?: number | null,
  confidence?: number | null,
): void {
  if (reach !== null && reach !== undefined && (!Number.isInteger(reach) || reach < 1 || reach > 10)) {
    throw new ObjectiveError(`Reach must be an integer 1–10, got "${reach}".`);
  }
  if (confidence !== null && confidence !== undefined && ![25, 50, 75, 100].includes(confidence)) {
    throw new ObjectiveError(`Confidence must be one of 25, 50, 75, 100, got "${confidence}".`);
  }
  if (impact !== null && impact !== undefined && (!Number.isInteger(impact) || impact < 1 || impact > 5)) {
    throw new ObjectiveError(`Impact must be an integer 1–5, got "${impact}".`);
  }
  if (effort !== null && effort !== undefined && (!Number.isFinite(effort) || effort <= 0 || effort > 52)) {
    throw new ObjectiveError(`Effort must be a number of weeks in (0, 52], got "${effort}".`);
  }
}

/**
 * Parse a metric object read from frontmatter, defensively. A hand-edited or
 * incomplete metric degrades to `null` (objective falls back to task-based progress)
 * rather than poisoning the roadmap — same philosophy as the date coercion above.
 * Requires a non-empty label and a numeric target that differs from the baseline
 * (equal baseline/target would divide by zero when computing progress).
 */
export function parseMetric(v: unknown): ObjectiveMetric | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) return null;
  const target = numOrNull(raw.target);
  if (target === null) return null;
  const baseline = numOrNull(raw.baseline) ?? 0;
  if (target === baseline) return null;
  const current = numOrNull(raw.current) ?? baseline;
  const unit = typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : null;
  return { label, unit, baseline, target, current };
}

/** Validate a metric for WRITES (throws). Reads use the lenient `parseMetric`. */
export function validateMetric(m: ObjectiveMetric): void {
  if (!m.label || !m.label.trim()) {
    throw new ObjectiveError('Metric label is required (e.g. "MRR").');
  }
  for (const [field, val] of [['baseline', m.baseline], ['target', m.target], ['current', m.current]] as const) {
    if (!Number.isFinite(val)) {
      throw new ObjectiveError(`Metric ${field} must be a finite number, got "${val}".`);
    }
  }
  if (m.target === m.baseline) {
    throw new ObjectiveError('Metric target must differ from the baseline (otherwise progress is undefined).');
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
    reach: numOrNull(data.reach),
    confidence: numOrNull(data.confidence),
    score: computeRiceScore({
      reach: numOrNull(data.reach),
      impact: numOrNull(data.impact),
      confidence: numOrNull(data.confidence),
      effort: numOrNull(data.effort),
    }),
    priority_suggestion: normalizePrioritySuggestion(data.priority_suggestion),
    status: toObjectiveStatus(data.status),
    metric: parseMetric(data.metric),
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
  validateImpactEffort(input.impact, input.effort, input.reach, input.confidence);
  if (input.metric) validateMetric(input.metric);

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
    // reach/confidence are written only when given, so an objective created
    // without them keeps the exact pre-RICE frontmatter shape.
    ...(input.reach != null ? { reach: input.reach } : {}),
    ...(input.confidence != null ? { confidence: input.confidence } : {}),
    status: null,
    metric: input.metric ?? null,
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
  return withObjectiveLock(contextRoot, slug, () => {
  const existing = getObjective(contextRoot, slug);
  if (!existing) throw new ObjectiveError(`Objective not found: ${slug}`);
  if ('start_date' in patch || 'target_date' in patch) {
    validateDateRange(
      'start_date' in patch ? patch.start_date : existing.start_date,
      'target_date' in patch ? patch.target_date : existing.target_date,
    );
  }
  if ('impact' in patch || 'effort' in patch || 'reach' in patch || 'confidence' in patch) {
    validateImpactEffort(
      'impact' in patch ? patch.impact : existing.impact,
      'effort' in patch ? patch.effort : existing.effort,
      'reach' in patch ? patch.reach : existing.reach,
      'confidence' in patch ? patch.confidence : existing.confidence,
    );
  }
  if ('status' in patch && patch.status !== null && patch.status !== undefined
      && !(OBJECTIVE_STATUSES as readonly string[]).includes(patch.status)) {
    throw new ObjectiveError(`Status must be one of: ${OBJECTIVE_STATUSES.join(', ')} (or cleared).`);
  }
  if ('metric' in patch && patch.metric !== null && patch.metric !== undefined) {
    validateMetric(patch.metric);
  }
  const updates: Record<string, unknown> = { updated_at: today() };
  if (patch.title !== undefined) updates.title = patch.title;
  if ('start_date' in patch) updates.start_date = patch.start_date ?? null;
  if ('impact' in patch) updates.impact = patch.impact ?? null;
  if ('effort' in patch) updates.effort = patch.effort ?? null;
  if ('reach' in patch) updates.reach = patch.reach ?? null;
  if ('confidence' in patch) updates.confidence = patch.confidence ?? null;
  if ('target_date' in patch) updates.target_date = patch.target_date ?? null;
  if ('feature' in patch) updates.feature = patch.feature ?? null;
  if ('status' in patch) updates.status = patch.status ?? null;
  if ('metric' in patch) updates.metric = patch.metric ?? null;
  updateFrontmatterFields(existing.path, updates);
  return readObjectiveFile(existing.path);
  });
}

/**
 * Update the Key Result metric by MERGING a partial patch onto the existing metric
 * (or seeding a fresh one). This is the ergonomic path for the common case — an agent
 * or the PO nudging just `current` as the real number moves — without having to resend
 * the whole object. A brand-new metric defaults `current` to its `baseline` when the
 * caller doesn't set it. Pass a `metric: null` through `updateObjective` to REMOVE it.
 */
export function updateObjectiveMetric(
  contextRoot: string,
  slug: string,
  patch: MetricPatch,
): Objective {
  return withObjectiveLock(contextRoot, slug, () => {
  const existing = getObjective(contextRoot, slug);
  if (!existing) throw new ObjectiveError(`Objective not found: ${slug}`);
  const base = existing.metric;
  const label = patch.label !== undefined ? patch.label.trim() : (base?.label ?? '');
  const unit = patch.unit !== undefined
    ? (patch.unit && patch.unit.trim() ? patch.unit.trim() : null)
    : (base?.unit ?? null);
  const baseline = patch.baseline !== undefined ? patch.baseline : (base?.baseline ?? 0);
  const target = patch.target !== undefined ? patch.target : (base?.target ?? NaN);
  const current = patch.current !== undefined
    ? patch.current
    : (base ? base.current : baseline);
  const merged: ObjectiveMetric = { label, unit, baseline, target, current };
  validateMetric(merged);
  updateFrontmatterFields(existing.path, { metric: merged, updated_at: today() });
  return readObjectiveFile(existing.path);
  });
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
  // Heal other objectives' depends_on edges (each under its own lock, re-read fresh).
  for (const other of listObjectives(contextRoot)) {
    if (other.slug !== slug && other.depends_on.includes(slug)) {
      withObjectiveLock(contextRoot, other.slug, () => {
        const fresh = getObjective(contextRoot, other.slug);
        if (!fresh || !fresh.depends_on.includes(slug)) return;
        updateFrontmatterFields(fresh.path, {
          depends_on: fresh.depends_on.filter((d) => d !== slug),
          updated_at: today(),
        });
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
          // Under the task's own lock, re-read fresh: a concurrent link move must not be lost.
          withTaskFileLock(contextRoot, basename(file, '.md'), () => {
            const { data } = readFrontmatter<Record<string, unknown>>(file);
            const now = Array.isArray(data.objectives)
              ? data.objectives.map((s) => String(s).trim()).filter(Boolean)
              : [];
            if (now.includes(slug)) updateFrontmatterFields(file, { objectives: now.filter((o) => o !== slug) });
          });
        } catch (err) {
          unhealedTasks.push(basename(file));
          console.error(`[objectives] delete "${slug}": could not rewrite task ${basename(file)} to drop the reference:`, err);
        }
      }
    }
  }
  withObjectiveLock(contextRoot, slug, () => {
    if (existsSync(existing.path)) unlinkSync(existing.path);
  });
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
  return withObjectiveLock(contextRoot, from, () => {
    const fresh = getObjective(contextRoot, from);
    if (!fresh) throw new ObjectiveError(`Objective not found: ${from}`);
    if (fresh.depends_on.includes(to)) throw new ObjectiveError(`${from} already depends on ${to}.`);
    updateFrontmatterFields(fresh.path, {
      depends_on: [...fresh.depends_on, to],
      updated_at: today(),
    });
    return readObjectiveFile(fresh.path);
  });
}

export function removeDependency(contextRoot: string, from: string, to: string): Objective {
  return withObjectiveLock(contextRoot, from, () => {
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
  });
}

// ─── Lock ────────────────────────────────────────────────────────────────────

/** Machine-local lock file for one objective (tmp/ is gitignored). */
export function objectiveLockPath(contextRoot: string, slug: string): string {
  return join(contextRoot, 'tmp', 'locks', 'objectives', `${slug}.lock`);
}

/**
 * Every objective writer runs inside this per-objective lock, re-reading the file
 * inside it, so a compare-and-write (an accept checking `at`) and a plain edit can
 * never interleave and drop one side. Not reentrant: never nest two writers.
 */
export function withObjectiveLock<T>(contextRoot: string, slug: string, fn: () => T): T {
  // The slug names a lock FILE: validate before the first filesystem effect, or a crafted
  // `../../x` slug would create and delete `*.lock` files outside the vault.
  if (!isSafeObjectiveSlug(slug)) throw new ObjectiveError(`Objective not found: ${slug}`);
  return withLockFileAt(
    objectiveLockPath(contextRoot, slug),
    () => new ObjectiveError(`Objective file busy: another process is writing "${slug}". Retry in a moment.`),
    fn,
  );
}

// ─── Priority suggestion (agent proposal) ───────────────────────────────────

export function objectiveSuggestionTarget(o: Objective): SuggestionTarget {
  return {
    kind: 'objective',
    rice: { reach: o.reach, impact: o.impact, confidence: o.confidence, effort: o.effort },
    priority_suggestion: o.priority_suggestion,
  };
}

/**
 * Store an agent's RICE suggestion on an objective. Refused per field when the
 * owner already set that field (owner_scored), when the stored one was dismissed
 * and `again` is not given, or when it would not close the objective's score.
 * The refusal check and the write run in ONE lock against a fresh read. Does not
 * bump `updated_at`: a suggestion is not an edit.
 */
export function suggestObjective(
  contextRoot: string,
  slug: string,
  input: SuggestionInput,
  liveness: readonly ObjectiveLiveness[],
  opts: { again?: boolean } = {},
): Objective {
  const invalid = validatePrioritySuggestion(input, 'objective');
  if (invalid.length > 0) throw new SuggestionError('invalid', invalid.join('; '));
  return withObjectiveLock(contextRoot, slug, () => {
    const o = getObjective(contextRoot, slug);
    if (!o) throw new SuggestionError('not_found', `Objective not found: ${slug}`);
    const target = objectiveSuggestionTarget(o);
    const refusal = suggestionRefusal(target, input, liveness, opts);
    if (refusal) throw SuggestionError.refusal(refusal, slug);
    const gaps = suggestionGaps(target, input, liveness);
    if (gaps.length > 0) throw new SuggestionError('incomplete', gaps.join('; '));
    updateFrontmatterFields(o.path, { priority_suggestion: serializePrioritySuggestion(buildSuggestionRecord(input)) });
    return readObjectiveFile(o.path);
  });
}

export interface ObjectiveAcceptResult {
  outcome: 'applied' | 'already_applied' | 'nothing_to_apply';
  objective: Objective;
  filled: RiceKey[];
}

/** Accept an objective's suggestion (see planAccept). One lock, one write. */
export function acceptObjectiveSuggestion(
  contextRoot: string,
  slug: string,
  at: string,
  edits: RicePart,
  liveness: readonly ObjectiveLiveness[],
): ObjectiveAcceptResult {
  return withObjectiveLock(contextRoot, slug, () => {
    const o = getObjective(contextRoot, slug);
    if (!o) throw new SuggestionError('not_found', `Objective not found: ${slug}`);
    const plan = planAccept(objectiveSuggestionTarget(o), at, edits, liveness);
    if (typeof plan === 'string') {
      throw new SuggestionError(plan, plan === 'suggestion_changed'
        ? 'The suggestion changed since it was shown. Reload it.'
        : 'This suggestion was dismissed.');
    }
    if (plan.outcome === 'already_applied') return { outcome: plan.outcome, objective: o, filled: [] };
    const updates: Record<string, unknown> = {};
    if (plan.rice) {
      updates.reach = plan.rice.reach;
      updates.impact = plan.rice.impact;
      updates.confidence = plan.rice.confidence;
      updates.effort = plan.rice.effort;
      updates.updated_at = today();
    }
    if (plan.record) updates.priority_suggestion = serializePrioritySuggestion(plan.record);
    updateFrontmatterFields(o.path, updates);
    return { outcome: plan.outcome, objective: readObjectiveFile(o.path), filled: plan.filled };
  });
}

/** Dismiss an objective's suggestion. A repeat dismiss of the same `at` is a no-op. */
export function dismissObjectiveSuggestion(contextRoot: string, slug: string, at: string): Objective {
  return withObjectiveLock(contextRoot, slug, () => {
    const o = getObjective(contextRoot, slug);
    if (!o) throw new SuggestionError('not_found', `Objective not found: ${slug}`);
    const next = planDismiss(objectiveSuggestionTarget(o), at);
    if (next === 'already_dismissed') return o;
    if (next === 'suggestion_changed') {
      throw new SuggestionError('suggestion_changed', 'The suggestion changed since it was shown. Reload it.');
    }
    updateFrontmatterFields(o.path, { priority_suggestion: serializePrioritySuggestion(next) });
    return readObjectiveFile(o.path);
  });
}
