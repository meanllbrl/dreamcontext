import { normalizeRice, type RiceFields } from './rice.js';

/**
 * A normalized, display-ready view of a task's frontmatter. Pure data — no I/O.
 * Built once via {@link toTaskRecord}, then filtered/grouped/counted by the
 * functions below so the CLI command stays thin and the logic stays testable.
 */
export interface TaskRecord {
  id: string | null;
  name: string;
  description: string;
  status: string;
  priority: string;
  urgency: string;
  tags: string[];
  version: string | null;
  related_feature: string | null;
  parent_task: string | null;
  /** Objective slugs this task serves (many-to-many, local-only). */
  objectives: string[];
  rice: RiceFields | null;
  /** Project-declared custom field values (overrides/task.md); {} when none. */
  custom_fields: Record<string, string | number | null>;
  created_at: string;
  updated_at: string;
  file: string;
}

export type GroupBy = 'tag' | 'version' | 'priority' | 'status';
export const GROUP_BY_FIELDS: readonly GroupBy[] = ['tag', 'version', 'priority', 'status'];

export interface TaskFilter {
  /** Exact status match. Takes precedence over `all`. */
  status?: string;
  /** Include completed tasks (default: completed are hidden). */
  all?: boolean;
  /** Task must carry ALL of these tags (AND). */
  tags?: string[];
  /** Task must carry AT LEAST ONE of these tags (OR). */
  anyTags?: string[];
  /** Exact version/milestone match. */
  version?: string;
  /** Exact priority match. */
  priority?: string;
  /** Exact related_feature match. */
  feature?: string;
  /** Task must serve this objective (its `objectives` list contains the slug). */
  objective?: string;
}

export interface TaskGroup {
  key: string;
  tasks: TaskRecord[];
}

export interface TagCount {
  tag: string;
  count: number;
}

const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];
const STATUS_ORDER = ['todo', 'in_progress', 'in_review', 'completed'];

export const NONE_KEY: Record<GroupBy, string> = {
  tag: '(untagged)',
  version: '(no version)',
  priority: '(no priority)',
  status: '(unknown)',
};

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' ? null : s;
}

function toTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((t) => String(t).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

/** Case-insensitive, trimmed string equality. */
function ieq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function hasTag(rec: TaskRecord, tag: string): boolean {
  return rec.tags.some((t) => ieq(t, tag));
}

/**
 * Map raw frontmatter (as parsed by gray-matter) into a normalized TaskRecord.
 * `name` is the task slug (file basename); `file` is the absolute path.
 */
export function toTaskRecord(
  data: Record<string, unknown>,
  name: string,
  file = '',
): TaskRecord {
  return {
    id: strOrNull(data.id),
    name,
    description: str(data.description, name),
    status: str(data.status, 'unknown'),
    priority: str(data.priority, '-'),
    urgency: str(data.urgency, '-'),
    tags: toTags(data.tags),
    version: strOrNull(data.version),
    related_feature: strOrNull(data.related_feature),
    parent_task: strOrNull(data.parent_task),
    objectives: Array.isArray(data.objectives)
      ? (data.objectives as unknown[]).map((s) => String(s).trim()).filter(Boolean)
      : [],
    rice: normalizeRice(data.rice),
    custom_fields:
      data.custom_fields && typeof data.custom_fields === 'object' && !Array.isArray(data.custom_fields)
        ? (data.custom_fields as Record<string, string | number | null>)
        : {},
    created_at: str(data.created_at, '-'),
    updated_at: str(data.updated_at ?? data.created_at, '-'),
    file,
  };
}

/**
 * Filter tasks by status visibility + tag/version/priority/feature.
 * All comparisons are case-insensitive. Input order is preserved.
 */
export function filterTasks(tasks: TaskRecord[], filter: TaskFilter = {}): TaskRecord[] {
  return tasks.filter((t) => {
    // Status visibility: explicit --status wins; otherwise hide completed unless --all.
    if (filter.status) {
      if (!ieq(t.status, filter.status)) return false;
    } else if (!filter.all) {
      if (ieq(t.status, 'completed')) return false;
    }

    if (filter.tags && filter.tags.length > 0) {
      if (!filter.tags.every((tag) => hasTag(t, tag))) return false;
    }
    if (filter.anyTags && filter.anyTags.length > 0) {
      if (!filter.anyTags.some((tag) => hasTag(t, tag))) return false;
    }
    if (filter.version) {
      if (!t.version || !ieq(t.version, filter.version)) return false;
    }
    if (filter.priority) {
      if (!ieq(t.priority, filter.priority)) return false;
    }
    if (filter.feature) {
      if (!t.related_feature || !ieq(t.related_feature, filter.feature)) return false;
    }
    if (filter.objective) {
      if (!t.objectives.some((o) => ieq(o, filter.objective!))) return false;
    }
    return true;
  });
}

function groupRank(groupBy: GroupBy, key: string): number {
  if (groupBy === 'priority') {
    const i = PRIORITY_ORDER.indexOf(key.toLowerCase());
    return i === -1 ? 99 : i;
  }
  if (groupBy === 'status') {
    const i = STATUS_ORDER.indexOf(key.toLowerCase());
    return i === -1 ? 99 : i;
  }
  // tag / version: push the "none" bucket last, alphabetical otherwise.
  return key === NONE_KEY[groupBy] ? 99 : 0;
}

/**
 * Group tasks for sectioned output. A task with multiple tags appears under
 * each of its tags when `groupBy === 'tag'`. Groups are ordered by the natural
 * order of the field (priority/status vocab, else alphabetical), with the
 * empty bucket last.
 */
export function groupTasks(tasks: TaskRecord[], groupBy: GroupBy): TaskGroup[] {
  const map = new Map<string, TaskRecord[]>();
  const push = (key: string, t: TaskRecord) => {
    const arr = map.get(key);
    if (arr) arr.push(t);
    else map.set(key, [t]);
  };

  for (const t of tasks) {
    if (groupBy === 'tag') {
      if (t.tags.length === 0) push(NONE_KEY.tag, t);
      else for (const tag of t.tags) push(tag, t);
    } else if (groupBy === 'version') {
      push(t.version ?? NONE_KEY.version, t);
    } else if (groupBy === 'priority') {
      push(t.priority && t.priority !== '-' ? t.priority : NONE_KEY.priority, t);
    } else {
      push(t.status || NONE_KEY.status, t);
    }
  }

  return [...map.keys()]
    .sort((a, b) => groupRank(groupBy, a) - groupRank(groupBy, b) || a.localeCompare(b, 'en', { sensitivity: 'base' }))
    .map((key) => ({ key, tasks: map.get(key)! }));
}

/**
 * Count distinct tags across the given tasks, sorted by count desc then name.
 * Tag casing is preserved as authored.
 */
export function collectTags(tasks: TaskRecord[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    for (const tag of t.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'en', { sensitivity: 'base' }));
}
