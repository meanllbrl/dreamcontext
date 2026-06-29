/**
 * Board model — pure types + helpers for the redesigned Tasks board.
 *
 * This is the spine of the board: the saved-view config shape, the include/exclude
 * filter model, and the grouping / sorting / due-date logic. It is deliberately
 * free of React and of the persistence transport so it can be unit-tested and
 * reused across the toolbar, the columns, and the persistence hook.
 *
 * Persistence is split across two project files (see src/server/routes/board.ts):
 *   SHARED  (version-controlled `overrides/board.json`)  — "save for all"
 *   LOCAL   (git-ignored `state/board.local.json`)        — "save for yourself"
 * `mergeBoard()` folds them into the runtime view list the UI renders.
 */
import type { Task } from '../../hooks/useTasks';

// ─── Enums ──────────────────────────────────────────────────────────────────────

export type Layout = 'board' | 'list' | 'eisenhower' | 'scatter' | 'timeline' | 'calendar' | 'heatmap';
export type Dim = 'status' | 'priority' | 'urgency' | 'version' | 'assignee';
export type SortKey = 'manual' | 'priority' | 'urgency' | 'due' | 'rice' | 'updated' | 'created' | 'name';
export type SortDir = 'asc' | 'desc';
export type DueFilter = 'all' | 'overdue' | 'today' | 'risk' | 'has' | 'none';
export type SaveScope = 'shared' | 'local';

export const STATUS_ORDER = ['todo', 'in_progress', 'in_review', 'completed'] as const;
export const PRIO_ORDER = ['critical', 'high', 'medium', 'low'] as const;
export const URG_ORDER = ['critical', 'high', 'medium', 'low'] as const;
export const DIMS: Dim[] = ['status', 'priority', 'urgency', 'version', 'assignee'];

export const STATUS_META: Record<string, { label: string; color: string }> = {
  todo: { label: 'To Do', color: 'var(--color-status-todo)' },
  in_progress: { label: 'In Progress', color: 'var(--color-status-in-progress)' },
  in_review: { label: 'In Review', color: 'var(--color-status-in-review)' },
  completed: { label: 'Completed', color: 'var(--color-status-completed)' },
};
const LEVEL_META: Record<string, { label: string; prio: string; urg: string }> = {
  critical: { label: 'Critical', prio: 'var(--color-priority-critical)', urg: 'var(--color-urgency-critical)' },
  high: { label: 'High', prio: 'var(--color-priority-high)', urg: 'var(--color-urgency-high)' },
  medium: { label: 'Medium', prio: 'var(--color-priority-medium)', urg: 'var(--color-urgency-medium)' },
  low: { label: 'Low', prio: 'var(--color-priority-low)', urg: 'var(--color-urgency-low)' },
};

export const DIM_LABEL: Record<Dim, string> = {
  status: 'Status', priority: 'Priority', urgency: 'Urgency', version: 'Version', assignee: 'Assignee',
};
export const SORT_LABEL: Record<SortKey, string> = {
  manual: 'Manual', priority: 'Priority', urgency: 'Urgency', due: 'Due date',
  rice: 'RICE score', updated: 'Last updated', created: 'Created', name: 'Name',
};

// ─── Config shapes ───────────────────────────────────────────────────────────────

export interface FieldFilter { inc: string[]; exc: string[]; }
export interface BoardFilters {
  status: FieldFilter; priority: FieldFilter; urgency: FieldFilter;
  tags: FieldFilter; version: FieldFilter; assignee: FieldFilter;
  due: DueFilter; minRice: number;
}
export interface ViewConfig {
  filters: BoardFilters;
  groupBy: Dim;
  subGroupBy: Dim | 'none';
  layout: Layout;
  sortBy: SortKey;
  sortDir: SortDir;
  search: string;
}
export interface BoardView {
  id: string;
  name: string;
  removable: boolean;
  config: ViewConfig;
  /** Where this view lives. Set by mergeBoard(); not persisted on the view itself. */
  origin?: SaveScope;
  /** True when a shared view carries a private "save for yourself" override. */
  hasLocalOverride?: boolean;
}
export interface CardProps {
  description: boolean; tags: boolean; priority: boolean; urgency: boolean;
  due: boolean; rice: boolean; assignee: boolean; version: boolean;
}

export interface SharedBoard {
  schema: 1;
  views: BoardView[];
  versions: string[];
  cardProps: CardProps;
}
export interface LocalBoard {
  schema: 1;
  activeViewId: string | null;
  theme: 'dark' | 'light' | null;
  localViews: BoardView[];
  overrides: Record<string, ViewConfig>;
  cardProps: CardProps | null;
}

// ─── Defaults ────────────────────────────────────────────────────────────────────

export const FILTER_FIELDS: (keyof BoardFilters)[] = ['status', 'priority', 'urgency', 'tags', 'version', 'assignee'];

export function emptyFieldFilter(): FieldFilter { return { inc: [], exc: [] }; }
export function emptyFilters(): BoardFilters {
  return {
    status: emptyFieldFilter(), priority: emptyFieldFilter(), urgency: emptyFieldFilter(),
    tags: emptyFieldFilter(), version: emptyFieldFilter(), assignee: emptyFieldFilter(),
    due: 'all', minRice: 0,
  };
}
export const DEFAULT_CARD_PROPS: CardProps = {
  description: true, tags: true, priority: true, urgency: true,
  due: true, rice: false, assignee: true, version: false,
};

export function emptyConfig(over: Partial<ViewConfig> = {}): ViewConfig {
  return {
    filters: emptyFilters(), groupBy: 'status', subGroupBy: 'none',
    layout: 'board', sortBy: 'manual', sortDir: 'desc', search: '', ...over,
  };
}

export function defaultViews(): BoardView[] {
  // Only the two "truth" views ship as defaults. "All Tasks" = everything;
  // "At Risk" = due-soon/overdue. Everything else is a user-created view.
  return [
    // Only "All Tasks" is locked (never deletable). "At Risk" is a convenience
    // default the user may delete.
    { id: 'all', name: 'All Tasks', removable: false, config: emptyConfig() },
    {
      id: 'atrisk', name: 'At Risk', removable: true,
      config: emptyConfig({ filters: { ...emptyFilters(), due: 'risk' }, groupBy: 'priority', sortBy: 'due', sortDir: 'asc' }),
    },
  ];
}

export function defaultSharedBoard(): SharedBoard {
  return { schema: 1, views: defaultViews(), versions: [], cardProps: { ...DEFAULT_CARD_PROPS } };
}
export function defaultLocalBoard(): LocalBoard {
  return { schema: 1, activeViewId: 'all', theme: null, localViews: [], overrides: {}, cardProps: null };
}

export function clone<T>(o: T): T { return JSON.parse(JSON.stringify(o)); }

// ─── Normalisation of server blobs (tolerate hand-edits / older schemas) ─────────

function asFieldFilter(v: unknown): FieldFilter {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return { inc: Array.isArray(o.inc) ? o.inc.map(String) : [], exc: Array.isArray(o.exc) ? o.exc.map(String) : [] };
  }
  return emptyFieldFilter();
}
function normFilters(v: unknown): BoardFilters {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    status: asFieldFilter(o.status), priority: asFieldFilter(o.priority), urgency: asFieldFilter(o.urgency),
    tags: asFieldFilter(o.tags), version: asFieldFilter(o.version), assignee: asFieldFilter(o.assignee),
    due: (typeof o.due === 'string' ? o.due : 'all') as DueFilter,
    minRice: typeof o.minRice === 'number' ? o.minRice : 0,
  };
}
function normConfig(v: unknown): ViewConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return emptyConfig({
    filters: normFilters(o.filters),
    groupBy: (DIMS.includes(o.groupBy as Dim) ? o.groupBy : 'status') as Dim,
    subGroupBy: (o.subGroupBy === 'none' || DIMS.includes(o.subGroupBy as Dim) ? o.subGroupBy : 'none') as Dim | 'none',
    layout: (typeof o.layout === 'string' ? o.layout : 'board') as Layout,
    sortBy: (typeof o.sortBy === 'string' ? o.sortBy : 'manual') as SortKey,
    sortDir: (o.sortDir === 'asc' ? 'asc' : 'desc') as SortDir,
    search: typeof o.search === 'string' ? o.search : '',
  });
}
function normView(v: unknown): BoardView | null {
  const o = (v && typeof v === 'object' ? v : null) as Record<string, unknown> | null;
  if (!o || typeof o.id !== 'string' || typeof o.name !== 'string') return null;
  return { id: o.id, name: o.name, removable: o.removable !== false, config: normConfig(o.config) };
}
function normCardProps(v: unknown): CardProps | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out = { ...DEFAULT_CARD_PROPS };
  (Object.keys(out) as (keyof CardProps)[]).forEach((k) => { if (typeof o[k] === 'boolean') out[k] = o[k] as boolean; });
  return out;
}

export function normSharedBoard(raw: unknown): SharedBoard {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const views = Array.isArray(o.views) ? o.views.map(normView).filter((v): v is BoardView => !!v) : [];
  return {
    schema: 1,
    views: views.length ? views : defaultViews(),
    versions: Array.isArray(o.versions) ? o.versions.map(String) : [],
    cardProps: normCardProps(o.cardProps) ?? { ...DEFAULT_CARD_PROPS },
  };
}
export function normLocalBoard(raw: unknown): LocalBoard {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const overrides: Record<string, ViewConfig> = {};
  if (o.overrides && typeof o.overrides === 'object') {
    for (const [k, val] of Object.entries(o.overrides as Record<string, unknown>)) overrides[k] = normConfig(val);
  }
  return {
    schema: 1,
    activeViewId: typeof o.activeViewId === 'string' ? o.activeViewId : null,
    theme: o.theme === 'dark' || o.theme === 'light' ? o.theme : null,
    localViews: Array.isArray(o.localViews)
      ? o.localViews.map(normView).filter((v): v is BoardView => !!v).map((v) => ({ ...v, removable: true }))
      : [],
    overrides,
    cardProps: normCardProps(o.cardProps),
  };
}

/** Fold shared + local into the runtime view list (local overrides win, local views append). */
export function mergeBoard(shared: SharedBoard, local: LocalBoard): BoardView[] {
  const base = shared.views.map((v) => {
    const ov = local.overrides[v.id];
    return ov
      ? { ...v, config: clone(ov), origin: 'shared' as SaveScope, hasLocalOverride: true }
      : { ...v, origin: 'shared' as SaveScope };
  });
  const locals = local.localViews.map((v) => ({ ...v, removable: true, origin: 'local' as SaveScope }));
  return [...base, ...locals];
}

/** Stable identity key for a view config, used to detect "unsaved changes". */
export function cfgKey(c: ViewConfig): string {
  return JSON.stringify({
    filters: c.filters, groupBy: c.groupBy, subGroupBy: c.subGroupBy,
    layout: c.layout, sortBy: c.sortBy, sortDir: c.sortDir, search: c.search,
  });
}

// ─── Task accessors (bridge the design's mock fields to the real Task shape) ─────

export function taskName(t: Task): string {
  return t.name && t.name.trim() ? t.name : t.slug.replace(/-/g, ' ');
}
export function taskDue(t: Task): string | null { return t.due_date ?? null; }
export function taskRice(t: Task): number | null {
  return t.rice && typeof t.rice.score === 'number' ? t.rice.score : null;
}
const PERSON_TAG = 'person:';
/**
 * Every assignee on a task, as person-slugs. Assignment lives in `person:<slug>`
 * tags — the canonical store the detail panel and CLI write — with the legacy
 * scalar `assignee` field folded in as a fallback so old tasks still resolve.
 * Deduped, person-tag order first. An empty array means unassigned.
 *
 * The board (filter, group-by, card avatar) must read assignees the SAME way the
 * detail panel writes them, or person-tag-assigned tasks read as "Unassigned"
 * everywhere except the detail panel.
 */
export function taskAssignees(t: Task): string[] {
  const out: string[] = [];
  for (const tag of t.tags) {
    if (tag.startsWith(PERSON_TAG)) {
      const slug = tag.slice(PERSON_TAG.length).trim();
      if (slug && !out.includes(slug)) out.push(slug);
    }
  }
  const legacy = t.assignee?.trim();
  if (legacy && !out.includes(legacy)) out.push(legacy);
  return out;
}
/** The task's primary assignee (first of {@link taskAssignees}) or `'none'`. */
export function taskAssignee(t: Task): string {
  const a = taskAssignees(t);
  return a.length ? a[0] : 'none';
}
export function taskVersion(t: Task): string { return t.version && t.version.trim() ? t.version : 'none'; }

export function levelLabel(k: string): string { return LEVEL_META[k]?.label ?? k; }
export function prioColor(k: string): string { return LEVEL_META[k]?.prio ?? 'var(--color-text-tertiary)'; }
export function urgColor(k: string): string { return LEVEL_META[k]?.urg ?? 'var(--color-text-tertiary)'; }

export function assigneeInitials(slug: string, name?: string): string {
  if (slug === 'none') return '–';
  const src = (name || slug).replace(/[-_.]/g, ' ').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

// Deterministic tag hue (0..9) → maps to .task-tag[data-hue] in CSS.
export function tagHue(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 10;
  return h;
}

// ─── Due-date logic ──────────────────────────────────────────────────────────────

export interface DueInfo {
  label: string; glyph: string;
  kind: 'overdue' | 'today' | 'soon' | 'week' | 'far';
  color: string; bg: string;
}
function startOfToday(): number {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
}
function fmtShort(s: string): string {
  const d = new Date(s + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
export function dueInfo(t: Task): DueInfo | null {
  const due = taskDue(t);
  if (t.status === 'completed' || !due) return null;
  const d = new Date(due + 'T00:00:00').getTime();
  const diff = Math.round((d - startOfToday()) / 86_400_000);
  if (diff < 0) return { label: `Overdue ${-diff}d`, glyph: '⚑', kind: 'overdue', color: 'var(--color-error)', bg: 'var(--color-error-subtle)' };
  if (diff === 0) return { label: 'Due today', glyph: '●', kind: 'today', color: 'var(--color-warning)', bg: 'var(--color-warning-subtle)' };
  if (diff <= 2) return { label: `${diff}d left`, glyph: '●', kind: 'soon', color: 'var(--color-warning)', bg: 'var(--color-warning-subtle)' };
  if (diff <= 7) return { label: `${diff}d left`, glyph: '○', kind: 'week', color: 'var(--color-accent)', bg: 'var(--color-accent-soft)' };
  return { label: fmtShort(due), glyph: '', kind: 'far', color: 'var(--color-text-tertiary)', bg: 'var(--color-bg-tertiary)' };
}
export function isAtRisk(t: Task): boolean {
  const di = dueInfo(t);
  return !!di && (di.kind === 'overdue' || di.kind === 'today' || di.kind === 'soon' || di.kind === 'week');
}
export function fmtUpdated(s: string | undefined): string {
  if (!s) return '—';
  const iso = s.slice(0, 10);
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ─── Dim accessor + filtering + sorting + grouping ───────────────────────────────

export function dimGet(t: Task, dim: Dim): string {
  if (dim === 'status') return t.status;
  if (dim === 'version') return taskVersion(t);
  if (dim === 'assignee') return taskAssignee(t);
  return t[dim] as string;
}

function matchField(val: string, fld: FieldFilter | undefined): boolean {
  if (!fld) return true;
  if (fld.inc.length && !fld.inc.includes(val)) return false;
  if (fld.exc.length && fld.exc.includes(val)) return false;
  return true;
}

/**
 * Multi-assignee-aware filter: a task matches `inc` if ANY of its assignees is
 * included, and fails `exc` if ANY of its assignees is excluded. A task with no
 * assignees tests as the single value `'none'`.
 */
function matchAssignee(t: Task, fld: FieldFilter | undefined): boolean {
  if (!fld) return true;
  const vals = taskAssignees(t);
  const eff = vals.length ? vals : ['none'];
  if (fld.inc.length && !eff.some((v) => fld.inc.includes(v))) return false;
  if (fld.exc.length && eff.some((v) => fld.exc.includes(v))) return false;
  return true;
}

export function filterTasks(tasks: Task[], f: BoardFilters, search: string): Task[] {
  const q = (search || '').trim().toLowerCase();
  return tasks.filter((t) => {
    if (!matchField(t.status, f.status)) return false;
    if (!matchField(t.priority, f.priority)) return false;
    if (!matchField(t.urgency, f.urgency)) return false;
    if (!matchAssignee(t, f.assignee)) return false;
    if (!matchField(taskVersion(t), f.version)) return false;
    if (f.tags.inc.length && !f.tags.inc.some((tg) => t.tags.includes(tg))) return false;
    if (f.tags.exc.length && f.tags.exc.some((tg) => t.tags.includes(tg))) return false;
    if (f.minRice) { const r = taskRice(t); if (!(r != null && r >= f.minRice)) return false; }
    if (f.due !== 'all') {
      const di = dueInfo(t);
      if (f.due === 'overdue' && !(di && di.kind === 'overdue')) return false;
      if (f.due === 'today' && !(di && di.kind === 'today')) return false;
      if (f.due === 'risk' && !isAtRisk(t)) return false;
      if (f.due === 'has' && !taskDue(t)) return false;
      if (f.due === 'none' && taskDue(t)) return false;
    }
    if (q) {
      const hay = `${taskName(t)} ${t.slug} ${t.description} ${t.tags.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function sortTasks(tasks: Task[], by: SortKey, dir: SortDir): Task[] {
  if (by === 'manual') return tasks;
  const d = dir === 'asc' ? 1 : -1;
  const pIdx = (k: string) => PRIO_ORDER.indexOf(k as typeof PRIO_ORDER[number]);
  const uIdx = (k: string) => URG_ORDER.indexOf(k as typeof URG_ORDER[number]);
  const key = (t: Task): number | string => {
    if (by === 'priority') return -pIdx(t.priority);
    if (by === 'urgency') return -uIdx(t.urgency);
    if (by === 'rice') return taskRice(t) ?? 0;
    if (by === 'due') { const due = taskDue(t); return due ? new Date(due + 'T00:00:00').getTime() : 8.64e15; }
    if (by === 'updated') return new Date((t.updated_at || '').slice(0, 10) + 'T00:00:00').getTime() || 0;
    if (by === 'created') return new Date((t.created_at || '').slice(0, 10) + 'T00:00:00').getTime() || 0;
    if (by === 'name') return taskName(t).toLowerCase();
    return 0;
  };
  return tasks.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka < kb) return -1 * d;
    if (ka > kb) return 1 * d;
    return 0;
  });
}

export interface DimGroup { key: string; label: string; color: string; tasks: Task[]; }

/**
 * Partition `tasks` by `dim`. `versionOrder` / `assignees` supply the dynamic
 * column ordering the design hard-coded for its mock data.
 */
export function dimGroups(
  dim: Dim,
  tasks: Task[],
  opts: { versionOrder: string[]; assignees: { value: string; label: string; color: string }[] },
): DimGroup[] {
  if (dim === 'status') {
    return STATUS_ORDER.map((k) => ({ key: k, label: STATUS_META[k].label, color: STATUS_META[k].color, tasks: tasks.filter((t) => t.status === k) }));
  }
  if (dim === 'priority') {
    return PRIO_ORDER.map((k) => ({ key: k, label: levelLabel(k), color: prioColor(k), tasks: tasks.filter((t) => t.priority === k) }));
  }
  if (dim === 'urgency') {
    return URG_ORDER.map((k) => ({ key: k, label: levelLabel(k), color: urgColor(k), tasks: tasks.filter((t) => t.urgency === k) }));
  }
  if (dim === 'version') {
    const order = [...opts.versionOrder.filter((v) => v !== 'none'), 'none'];
    return order.map((k) => ({ key: k, label: k === 'none' ? 'No version' : k, color: 'var(--color-accent)', tasks: tasks.filter((t) => taskVersion(t) === k) }));
  }
  // assignee — a task lands under EACH of its assignees (multi-assignee swimlanes);
  // tasks with no assignee fall under the 'none' column.
  return opts.assignees.map((a) => ({
    key: a.value, label: a.label, color: a.color,
    tasks: tasks.filter((t) => {
      const vals = taskAssignees(t);
      return a.value === 'none' ? vals.length === 0 : vals.includes(a.value);
    }),
  }));
}
