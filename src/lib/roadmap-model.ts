import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';
import { today } from './id.js';
import {
  listObjectives,
  type Objective,
  type ObjectiveMetric,
  type ObjectiveStatus,
} from './objectives-store.js';
import { listTheses } from './theses/store.js';
import type { ThesisStatus, ThesisKind } from './theses/types.js';

/**
 * Roadmap model builder — the computed "assist layer" under the PO-authored
 * objectives (task_uO60nZRt). PURE: reads `core/objectives/*.md` + task
 * frontmatter, returns a typed model. No render side effects — renderers
 * (CLI text board, board.md, snapshot section, future dashboard) consume it.
 *
 * Relations are stored ONE-WAY (task → `objectives`, objective → `depends_on`);
 * the reverse directions (objective → member tasks, objective → dependents)
 * are COMPUTED here — never stored — so the two sides cannot drift.
 *
 * Forecast cascade = FULL transitive propagation over the dependency DAG
 * (topo-sorted; diamond shapes included). With dated member tasks (the schedule
 * of record — effort is NOT re-added), the committed window stays an ENVELOPE:
 *   forecast_start = max(min(earliest task start, committed start), max(forecast_end of deps))
 *   forecast_end   = max(committed end, latest member-task due, forecast_start)
 * so start-only tasks never collapse the bar to a point, and a predecessor isn't
 * "done" for its dependents until its own target passes. Slip is still measured
 * on the task-derived finish. Null handling (review-mandated): an objective with
 * NO dated member tasks and no committed window has forecast = null
 * ("unforecastable") and imposes NO constraint on dependents.
 */

export interface RoadmapTaskRef {
  slug: string;
  status: string;
  start_date: string | null;
  due_date: string | null;
  version: string | null;
  updated_at: string | null;
}

export interface RoadmapObjective {
  slug: string;
  title: string;
  /** One-line outcome summary distilled from the objective body (first prose line). */
  description: string | null;
  /** PO-committed start of the objective window (YYYY-MM-DD) or null. */
  start_date: string | null;
  target_date: string | null;
  /** Prioritization 2×2 (echoed from the objective): impact 1–5, effort in weeks. */
  impact: number | null;
  effort: number | null;
  depends_on: string[];
  /** Computed reverse edges: objectives that depend on THIS one. */
  dependents: string[];
  feature: string | null;
  /** Effective status: manual override if set, else computed from metric/tasks. */
  status: ObjectiveStatus;
  status_source: 'computed' | 'override';
  /**
   * Progress. `done`/`total` are always the member-task counts (for reference).
   * `source` says which drives `pct`: 'metric' (Key Result value vs target) or
   * 'tasks' (completed/total). `metric` echoes the KR when source is 'metric'.
   */
  progress: {
    done: number;
    total: number;
    pct: number | null;
    source: 'tasks' | 'metric';
    metric: ObjectiveMetric | null;
  };
  forecast_start: string | null;
  forecast_end: string | null;
  /** true = forecast_end > target_date. null when either side is missing. */
  slipping: boolean | null;
  /** How many days forecast_end runs past target_date (positive). null unless slipping. */
  slip_days: number | null;
  /**
   * Auto-derived cause of a slip: the direct dependency slug(s) whose own
   * (already-cascaded) forecast_end runs past THIS objective's target — i.e. the
   * upstream reason it slips. Empty array = own member tasks overrun the target
   * (no upstream to blame). Always empty when not slipping.
   */
  slip_upstream: string[];
  /** Member tasks (every task whose `objectives` list contains this slug). */
  tasks: RoadmapTaskRef[];
  /** Theses whose `objectives` list contains this slug (computed reverse edges). */
  related_theses: ThesisRef[];
}

/** A thesis linked to an objective — the "what did we try, what did we learn" surface. */
export interface ThesisRef {
  slug: string;
  claim: string;
  status: ThesisStatus;
  confidence: number;
  kind: ThesisKind;
}

export interface RoadmapModel {
  generated_at: string;
  /** Topological order: dependencies before dependents. */
  objectives: RoadmapObjective[];
  warnings: string[];
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' ? null : s;
}

/** Read the minimal task fields the roadmap needs from state/*.md frontmatter. */
function loadTaskRefs(contextRoot: string): Array<RoadmapTaskRef & { objectives: string[] }> {
  const stateDir = join(contextRoot, 'state');
  if (!existsSync(stateDir)) return [];
  const files = fg.sync('*.md', { cwd: stateDir, absolute: true }).sort();
  const out: Array<RoadmapTaskRef & { objectives: string[] }> = [];
  for (const file of files) {
    try {
      const { data } = readFrontmatter<Record<string, unknown>>(file);
      const objectives = Array.isArray(data.objectives)
        ? data.objectives.map((s) => String(s).trim()).filter(Boolean)
        : [];
      if (objectives.length === 0) continue;
      out.push({
        slug: basename(file, '.md'),
        objectives,
        status: String(data.status ?? 'todo').replace(/-/g, '_'),
        start_date: strOrNull(data.start_date),
        due_date: strOrNull(data.due_date),
        version: strOrNull(data.version),
        updated_at: strOrNull(data.updated_at ?? data.created_at),
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Topologically sort objectives by depends_on (Kahn): dependencies first.
 * The write-time cycle guard means real corpora are DAGs; if a cycle sneaks in
 * (hand-edited frontmatter), the members are appended in slug order with a
 * warning instead of crashing — their dependency edges just don't cascade.
 */
export function topoSortObjectives(
  objectives: Objective[],
): { sorted: Objective[]; cycleWarning: string | null } {
  const bySlug = new Map(objectives.map((o) => [o.slug, o]));
  const inDegree = new Map<string, number>();
  const dependentsOf = new Map<string, string[]>();
  for (const o of objectives) {
    const validDeps = o.depends_on.filter((d) => bySlug.has(d));
    inDegree.set(o.slug, validDeps.length);
    for (const dep of validDeps) {
      const arr = dependentsOf.get(dep) ?? [];
      arr.push(o.slug);
      dependentsOf.set(dep, arr);
    }
  }
  const queue = objectives.filter((o) => (inDegree.get(o.slug) ?? 0) === 0).map((o) => o.slug);
  queue.sort();
  const sorted: Objective[] = [];
  while (queue.length > 0) {
    const slug = queue.shift()!;
    sorted.push(bySlug.get(slug)!);
    for (const dep of (dependentsOf.get(slug) ?? []).sort()) {
      const d = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, d);
      if (d === 0) queue.push(dep);
    }
  }
  if (sorted.length < objectives.length) {
    const missing = objectives.filter((o) => !sorted.includes(o)).sort((a, b) => a.slug.localeCompare(b.slug));
    sorted.push(...missing);
    return {
      sorted,
      cycleWarning:
        `Circular dependency detected among: ${missing.map((o) => o.slug).join(', ')} — `
        + 'their forecasts do not cascade. Fix depends_on in core/objectives/.',
    };
  }
  return { sorted, cycleWarning: null };
}

/** Rollup status from member task statuses (real enum, spec-fixed). */
export function computeRollupStatus(tasks: RoadmapTaskRef[]): ObjectiveStatus {
  if (tasks.length === 0) return 'not_started';
  if (tasks.every((t) => t.status === 'completed')) return 'done';
  if (tasks.some((t) => t.status === 'in_progress')) return 'active';
  if (tasks.some((t) => t.status === 'in_review')) return 'review';
  return 'not_started';
}

/**
 * Progress % of a Key Result metric — `current` along the `baseline → target` span,
 * clamped to [0, 100]. Works in either direction (growth or reduce goals) because it
 * divides by the signed span. `parseMetric` guarantees target ≠ baseline, so the
 * denominator is never zero for a real metric; the `=== 0` guard is belt-and-braces.
 */
export function metricProgressPct(m: ObjectiveMetric): number {
  const span = m.target - m.baseline;
  if (span === 0) return 0;
  const raw = ((m.current - m.baseline) / span) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Status derived from a metric: done at/over target, active once off the baseline. */
export function computeMetricStatus(m: ObjectiveMetric): ObjectiveStatus {
  const pct = metricProgressPct(m);
  if (pct >= 100) return 'done';
  if (pct > 0) return 'active';
  return 'not_started';
}

function maxDate(dates: Array<string | null>): string | null {
  const real = dates.filter((d): d is string => d !== null);
  return real.length === 0 ? null : real.reduce((a, b) => (a > b ? a : b));
}

function minDate(dates: Array<string | null>): string | null {
  const real = dates.filter((d): d is string => d !== null);
  return real.length === 0 ? null : real.reduce((a, b) => (a < b ? a : b));
}

/** Whole days from `fromISO` to `toISO` (both YYYY-MM-DD, UTC). Negative if to < from. */
function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** `iso` (YYYY-MM-DD, UTC) advanced by `days` (0 → unchanged; malformed → unchanged). */
function addDaysISO(iso: string, days: number): string {
  if (days === 0) return iso;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return iso;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole calendar days of work for an effort estimate (prioritization weeks → days); null/≤0 = 0. */
export function effortToDays(effort: number | null | undefined): number {
  return effort != null && effort > 0 ? Math.round(effort * 7) : 0;
}

/**
 * A one-line outcome summary for the snapshot: the first real prose line of the
 * objective body. Skips headings, HTML comments, and the parenthesised scaffold
 * placeholder that `createObjective` seeds, strips markdown links, and caps length.
 */
function firstBodyLine(body: string): string | null {
  const candidates: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--')) continue;
    if (line.startsWith('(') && line.endsWith(')')) continue; // scaffold placeholder
    candidates.push(line);
  }
  if (candidates.length === 0) return null;
  // Prefer the first real outcome sentence over a fully-bold annotation line
  // (e.g. "**Decision (2026-07-04): …**" that often heads a Why section), falling
  // back to the first candidate if every line is bold.
  const pick = candidates.find((l) => !/^\*\*.*\*\*$/.test(l)) ?? candidates[0];
  const clean = pick
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip markdown links → link text
    .replace(/[*`]/g, '')                    // strip bold/italic-star + code emphasis
    .trim();
  if (!clean) return null;
  return clean.length > 100 ? clean.slice(0, 97) + '...' : clean;
}

export function buildRoadmapModel(contextRoot: string): RoadmapModel {
  const warnings: string[] = [];
  const objectives = listObjectives(contextRoot);
  const taskRefs = loadTaskRefs(contextRoot);
  const knownSlugs = new Set(objectives.map((o) => o.slug));

  // Join: task → objectives (many-to-many). Unknown slugs warn, never fail.
  const membersOf = new Map<string, RoadmapTaskRef[]>();
  const unknownRefs = new Map<string, string[]>();
  for (const t of taskRefs) {
    for (const slug of t.objectives) {
      if (!knownSlugs.has(slug)) {
        const arr = unknownRefs.get(slug) ?? [];
        arr.push(t.slug);
        unknownRefs.set(slug, arr);
        continue;
      }
      const arr = membersOf.get(slug) ?? [];
      const { objectives: _drop, ...ref } = t;
      arr.push(ref);
      membersOf.set(slug, arr);
    }
  }
  for (const [slug, tasks] of [...unknownRefs.entries()].sort()) {
    warnings.push(
      `Task(s) reference unknown objective "${slug}": ${tasks.join(', ')} — `
      + `create it (roadmap objective create ${slug}) or fix the task frontmatter.`,
    );
  }

  const { sorted, cycleWarning } = topoSortObjectives(objectives);
  if (cycleWarning) warnings.push(cycleWarning);

  // Dependents = computed reverse edges.
  const dependentsOf = new Map<string, string[]>();
  for (const o of objectives) {
    for (const dep of o.depends_on) {
      if (!knownSlugs.has(dep)) {
        warnings.push(`Objective "${o.slug}" depends on unknown objective "${dep}".`);
        continue;
      }
      const arr = dependentsOf.get(dep) ?? [];
      arr.push(o.slug);
      dependentsOf.set(dep, arr);
    }
  }

  // Theses linked to objectives (many-to-many, `objectives:` on the thesis) —
  // computed reverse edges, same one-way-storage rule as dependents/tasks
  // above (the thesis owns `objectives:`; this side is never persisted).
  // `listTheses` tolerates a missing `theses/` dir (proactive learning layer
  // disabled/unused) by returning [], so this never throws either way.
  const thesesOf = new Map<string, ThesisRef[]>();
  for (const thesis of listTheses(contextRoot)) {
    for (const slug of thesis.objectives) {
      if (!knownSlugs.has(slug)) {
        warnings.push(`Thesis "${thesis.slug}" references unknown objective "${slug}".`);
        continue;
      }
      const arr = thesesOf.get(slug) ?? [];
      arr.push({ slug: thesis.slug, claim: thesis.claim, status: thesis.status, confidence: thesis.confidence, kind: thesis.kind });
      thesesOf.set(slug, arr);
    }
  }

  // Forecast cascade — topo order guarantees each dependency is resolved first.
  const forecastEndOf = new Map<string, string | null>();
  const out: RoadmapObjective[] = [];
  for (const o of sorted) {
    const tasks = (membersOf.get(o.slug) ?? []).sort((a, b) => a.slug.localeCompare(b.slug));
    const done = tasks.filter((t) => t.status === 'completed').length;
    const total = tasks.length;
    // A Key Result metric, when present, is the progress source — task counts are still
    // surfaced (done/total) but no longer drive pct or the computed status.
    const metric = o.metric;
    const taskPct = total === 0 ? null : Math.round((done / total) * 100);
    const pct = metric ? metricProgressPct(metric) : taskPct;

    const computed = metric ? computeMetricStatus(metric) : computeRollupStatus(tasks);
    const status = o.status ?? computed;

    // Forecast. Dependencies contribute their (already-cascaded) forecast_end;
    // a dependency that is itself unforecastable (null) imposes no constraint.
    // Effort-aware, envelope-clamped finish-to-start — kept in lock-step with the
    // dashboard's `roadmap-forecast.ts` so the timeline and the CLI/snapshot agree.
    const maxDepEnd = maxDate(
      o.depends_on.filter((d) => knownSlugs.has(d)).map((d) => forecastEndOf.get(d) ?? null),
    );
    const effortDays = effortToDays(o.effort);
    const hasDates = tasks.some((t) => t.start_date !== null || t.due_date !== null);
    let forecastStart: string | null = null;
    let forecastEnd: string | null = null;
    if (hasDates) {
      // Linked dated tasks are the schedule of record — their span already encodes
      // the real duration, so effort is not re-added on top (it would double-count).
      // The committed window is still the ENVELOPE (same clamp as the window basis
      // below, lock-step with roadmap-forecast.ts): the bar starts no later than the
      // committed start and never ends before the committed end — start-only tasks
      // must not collapse the forecast to a point, and a predecessor isn't "done"
      // for its dependents until its own target passes. Slip is still measured on
      // the task-derived finish (workEnd), not the envelope end.
      const earliestStart = minDate(tasks.map((t) => t.start_date));
      const latestDue = maxDate(tasks.map((t) => t.due_date));
      const committedEnd = o.target_date ?? o.start_date;
      forecastStart = maxDate([minDate([earliestStart, o.start_date]), maxDepEnd]) ?? latestDue;
      const workEnd = maxDate([latestDue, forecastStart]);
      forecastEnd = maxDate([committedEnd, workEnd]);
    } else if (o.start_date !== null) {
      // PO-committed window (no dated tasks yet): the start→target window is a DEADLINE
      // PLAN, not a rigid block that slides. A dependency pushes only the achievable
      // start; the objective finishes after `effort` weeks of work from there, but the
      // bar never renders shorter than the committed window. It slips only when that
      // work can't fit before the target — never merely for having a wide window.
      const committedStart = o.start_date;
      const committedEnd = o.target_date ?? o.start_date;
      forecastStart = maxDate([committedStart, maxDepEnd]);
      const workEnd = addDaysISO(forecastStart!, effortDays);
      forecastEnd = maxDate([committedEnd, workEnd]);
    } else if (maxDepEnd !== null) {
      // Pure MILESTONE objective (no dated tasks and no committed start of its own, but
      // depends on others): it finishes when its latest dependency does (finish-to-start)
      // plus any own effort, so an upstream slip cascades into it. Only when NO dependency
      // is forecastable does it stay null ("unforecastable") — preserving the rule that a
      // null-forecast objective never drags its dependents to "now".
      forecastStart = maxDepEnd;
      forecastEnd = addDaysISO(maxDepEnd, effortDays);
    }
    forecastEndOf.set(o.slug, forecastEnd);

    const slipping = o.target_date !== null && forecastEnd !== null
      ? forecastEnd > o.target_date
      : null;

    // Slip attribution (auto-derived, no manual field): how many days late, and
    // which direct dependency(ies) caused it. A dep whose own already-cascaded
    // forecast_end runs past THIS target alone forces this objective past target,
    // so it is a sufficient upstream cause; an empty list means the objective's
    // own member tasks overrun the target with no upstream to blame.
    let slipDays: number | null = null;
    let slipUpstream: string[] = [];
    if (slipping === true && o.target_date !== null && forecastEnd !== null) {
      slipDays = daysBetween(o.target_date, forecastEnd);
      slipUpstream = o.depends_on
        .filter((d) => knownSlugs.has(d))
        .filter((d) => {
          const de = forecastEndOf.get(d) ?? null;
          return de !== null && de > o.target_date!;
        })
        .sort();
    }

    out.push({
      slug: o.slug,
      title: o.title,
      description: firstBodyLine(o.body),
      start_date: o.start_date,
      target_date: o.target_date,
      impact: o.impact,
      effort: o.effort,
      depends_on: [...o.depends_on],
      dependents: (dependentsOf.get(o.slug) ?? []).sort(),
      feature: o.feature,
      status,
      status_source: o.status !== null ? 'override' : 'computed',
      progress: { done, total, pct, source: metric ? 'metric' : 'tasks', metric },
      forecast_start: forecastStart,
      forecast_end: forecastEnd,
      slipping,
      slip_days: slipDays,
      slip_upstream: slipUpstream,
      tasks,
      related_theses: (thesesOf.get(o.slug) ?? []).sort((a, b) => a.slug.localeCompare(b.slug)),
    });
  }

  return { generated_at: today(), objectives: out, warnings };
}

/** All transitive dependents of `slug` (the "if this slips, these slip" set). */
export function transitiveDependents(model: RoadmapModel, slug: string): string[] {
  const dependentsOf = new Map(model.objectives.map((o) => [o.slug, o.dependents]));
  const seen = new Set<string>();
  const stack = [...(dependentsOf.get(slug) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(dependentsOf.get(cur) ?? []));
  }
  return [...seen].sort();
}
