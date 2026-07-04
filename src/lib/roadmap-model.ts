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
 * (topo-sorted; diamond shapes included):
 *   forecast_start = max(earliest member-task start, max(forecast_end of deps))
 *   forecast_end   = max(latest member-task due, forecast_start)
 * Null handling (review-mandated): an objective with NO dated member tasks has
 * forecast = null ("unforecastable") and imposes NO constraint on dependents.
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
  target_date: string | null;
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
  /** Member tasks (every task whose `objectives` list contains this slug). */
  tasks: RoadmapTaskRef[];
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

    // Null rule: no dated member tasks → unforecastable, non-constraining.
    const hasDates = tasks.some((t) => t.start_date !== null || t.due_date !== null);
    let forecastStart: string | null = null;
    let forecastEnd: string | null = null;
    if (hasDates) {
      const earliestStart = minDate(tasks.map((t) => t.start_date));
      const latestDue = maxDate(tasks.map((t) => t.due_date));
      // Null-forecast dependencies impose no constraint (treated as non-blocking).
      const depEnds = o.depends_on
        .filter((d) => knownSlugs.has(d))
        .map((d) => forecastEndOf.get(d) ?? null);
      forecastStart = maxDate([earliestStart, maxDate(depEnds)]);
      forecastEnd = maxDate([latestDue, forecastStart]);
    }
    forecastEndOf.set(o.slug, forecastEnd);

    const slipping = o.target_date !== null && forecastEnd !== null
      ? forecastEnd > o.target_date
      : null;

    out.push({
      slug: o.slug,
      title: o.title,
      target_date: o.target_date,
      depends_on: [...o.depends_on],
      dependents: (dependentsOf.get(o.slug) ?? []).sort(),
      feature: o.feature,
      status,
      status_source: o.status !== null ? 'override' : 'computed',
      progress: { done, total, pct, source: metric ? 'metric' : 'tasks', metric },
      forecast_start: forecastStart,
      forecast_end: forecastEnd,
      slipping,
      tasks,
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
