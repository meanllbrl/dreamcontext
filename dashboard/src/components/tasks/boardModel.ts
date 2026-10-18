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
import type { Task, TaskBase } from '../../hooks/useTasks';
import { DEFAULT_STATUS_MODEL, type StatusModel } from '../../lib/statusModel';
import { orderOf, type Order } from './taskOrder';

// ─── Enums ──────────────────────────────────────────────────────────────────────

/**
 * Board, List and Timeline. Eisenhower, RICE, Calendar and Heatmap were retired (plan r3 § 5c,
 * decisions 3 and 10): a saved view that named one opens on the Board.
 */
export type Layout = 'board' | 'list' | 'timeline';
export const LAYOUTS: readonly Layout[] = ['board', 'list', 'timeline'];
/** `order` is the "when?" axis (Now / Next / Later); importance is the rank inside it. */
export type Dim = 'order' | 'status' | 'version' | 'assignee';
export type SortKey = 'manual' | 'rank' | 'due' | 'updated' | 'created' | 'name';
export type SortDir = 'asc' | 'desc';
export type DueFilter = 'all' | 'overdue' | 'today' | 'risk' | 'has' | 'none';
export type SaveScope = 'shared' | 'local';

/**
 * The SHIPPED status order/meta — the defaults `DEFAULT_STATUS_MODEL` is built
 * from. Live views read the project's model via `useStatusModel()` (which adds
 * any status declared in overrides/task.md); these constants stay for the
 * pure helpers' defaults and for callers outside React.
 */
export const STATUS_ORDER = ['todo', 'in_progress', 'in_review', 'completed'] as const;
/** The priority levels a new task may be authored with (the field stays readable on old cards). */
export const PRIO_ORDER = ['critical', 'high', 'medium', 'low'] as const;
export const DIMS: Dim[] = ['order', 'status', 'version', 'assignee'];
export const SORT_KEYS: readonly SortKey[] = ['manual', 'rank', 'due', 'updated', 'created', 'name'];

export const STATUS_META: Record<string, { label: string; color: string }> = {
  todo: { label: 'To Do', color: 'var(--color-status-todo)' },
  in_progress: { label: 'In Progress', color: 'var(--color-status-in-progress)' },
  in_review: { label: 'In Review', color: 'var(--color-status-in-review)' },
  completed: { label: 'Completed', color: 'var(--color-status-completed)' },
};
const LEVEL_LABEL: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

// ─── Config shapes ───────────────────────────────────────────────────────────────

export interface FieldFilter { inc: string[]; exc: string[]; }
export interface BoardFilters {
  status: FieldFilter; tags: FieldFilter; version: FieldFilter; assignee: FieldFilter;
  due: DueFilter;
}
/** The saved-view shape this build writes. A stored view without it is migrated on read. */
export const CONFIG_VERSION = 2;
export interface ViewConfig {
  configVersion: typeof CONFIG_VERSION;
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
  description: boolean; tags: boolean; due: boolean; assignee: boolean; version: boolean;
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

export const FILTER_FIELDS: (keyof BoardFilters)[] = ['status', 'tags', 'version', 'assignee'];

export function emptyFieldFilter(): FieldFilter { return { inc: [], exc: [] }; }
export function emptyFilters(): BoardFilters {
  return {
    status: emptyFieldFilter(), tags: emptyFieldFilter(), version: emptyFieldFilter(), assignee: emptyFieldFilter(),
    due: 'all',
  };
}
export const DEFAULT_CARD_PROPS: CardProps = {
  description: true, tags: true, due: true, assignee: true, version: false,
};

export function emptyConfig(over: Partial<ViewConfig> = {}): ViewConfig {
  return {
    configVersion: CONFIG_VERSION,
    filters: emptyFilters(), groupBy: 'order', subGroupBy: 'none',
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
      config: emptyConfig({ filters: { ...emptyFilters(), due: 'risk' }, groupBy: 'order', sortBy: 'due', sortDir: 'asc' }),
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
/**
 * Migrate a persisted version filter to the virtual-bucket vocabulary. Saved views
 * created before the "Backlog" smart bucket stored the literal `backlog` string in
 * inc/exc; that row no longer renders on its own (it folds into the @backlog bucket),
 * so without this an old literal token would be an un-dismissable ghost — the bucket
 * would show as off while the filter is silently active. Rewrites any backlog-matching
 * token to VV_BACKLOG, case-insensitively, de-duping if both forms are present.
 */
function normVersionFilter(fld: FieldFilter): FieldFilter {
  const migrate = (xs: string[]): string[] => {
    const out: string[] = [];
    for (const x of xs) {
      const tok = BACKLOG_RE.test(x) ? VV_BACKLOG : x;
      if (!out.includes(tok)) out.push(tok);
    }
    return out;
  };
  return { inc: migrate(fld.inc), exc: migrate(fld.exc) };
}
/** Priority, urgency and the RICE floor are no longer filters (decision 3): a stored one is dropped. */
function normFilters(v: unknown): BoardFilters {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    status: asFieldFilter(o.status),
    tags: asFieldFilter(o.tags), version: normVersionFilter(asFieldFilter(o.version)), assignee: asFieldFilter(o.assignee),
    due: (typeof o.due === 'string' ? o.due : 'all') as DueFilter,
  };
}

/** The built-in views, whose shipped grouping changed with configVersion 2. */
const BUILT_IN_REGROUP: Record<string, string> = { all: 'status', atrisk: 'priority' };
/** Dims and sorts that left the board, and where a stored view that used one goes. */
const RETIRED_DIM: Record<string, Dim> = { priority: 'order', urgency: 'order' };
const RETIRED_SORT: Record<string, SortKey> = { priority: 'rank', urgency: 'rank', rice: 'rank' };

/**
 * One stored view config, normalised to configVersion 2 (plan r3 § 5b):
 *  - a retired layout (eisenhower, scatter, calendar, heatmap) opens on the Board;
 *  - the built-in `all` view's `status` grouping and `atrisk`'s `priority` grouping become `order`;
 *  - any view grouped or sorted by priority or urgency (or sorted by RICE) moves to order / rank;
 *  - priority, urgency and RICE filters are dropped.
 * A user view grouped by status keeps it. A config already at version 2 is only validated.
 */
export function normConfig(v: unknown, viewId?: string): ViewConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const migrate = o.configVersion !== CONFIG_VERSION;
  let groupBy = typeof o.groupBy === 'string' ? o.groupBy : migrate ? 'status' : 'order';
  if (RETIRED_DIM[groupBy]) groupBy = RETIRED_DIM[groupBy];
  if (migrate && viewId && BUILT_IN_REGROUP[viewId] !== undefined && (o.groupBy === undefined || o.groupBy === BUILT_IN_REGROUP[viewId])) groupBy = 'order';
  let subGroupBy = typeof o.subGroupBy === 'string' ? o.subGroupBy : 'none';
  if (RETIRED_DIM[subGroupBy] || subGroupBy === 'order' || subGroupBy === groupBy) subGroupBy = 'none';
  let sortBy = typeof o.sortBy === 'string' ? o.sortBy : 'manual';
  if (RETIRED_SORT[sortBy]) sortBy = RETIRED_SORT[sortBy];
  const layout = typeof o.layout === 'string' && (LAYOUTS as readonly string[]).includes(o.layout) ? o.layout as Layout : 'board';
  return emptyConfig({
    filters: normFilters(o.filters),
    groupBy: (DIMS.includes(groupBy as Dim) ? groupBy : 'order') as Dim,
    subGroupBy: (subGroupBy === 'none' || DIMS.includes(subGroupBy as Dim) ? subGroupBy : 'none') as Dim | 'none',
    layout,
    sortBy: (SORT_KEYS.includes(sortBy as SortKey) ? sortBy : 'manual') as SortKey,
    sortDir: (o.sortDir === 'asc' ? 'asc' : 'desc') as SortDir,
    search: typeof o.search === 'string' ? o.search : '',
  });
}
function normView(v: unknown): BoardView | null {
  const o = (v && typeof v === 'object' ? v : null) as Record<string, unknown> | null;
  if (!o || typeof o.id !== 'string' || typeof o.name !== 'string') return null;
  return { id: o.id, name: o.name, removable: o.removable !== false, config: normConfig(o.config, o.id) };
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
    for (const [k, val] of Object.entries(o.overrides as Record<string, unknown>)) overrides[k] = normConfig(val, k);
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

export function taskName(t: TaskBase): string {
  return t.name && t.name.trim() ? t.name : t.slug.replace(/-/g, ' ');
}
export function taskDue(t: Task): string | null { return t.due_date ?? null; }
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
/**
 * The AGENT the task is assigned to (its slug), or null. Separate from {@link taskAssignees} on
 * purpose: an agent is never a person, so it is not part of the assignee filter or grouping; the
 * card shows it as its own face.
 */
export function taskAgent(t: TaskBase): string | null {
  const slug = typeof t.agent === 'string' ? t.agent.trim() : '';
  return slug || null;
}
export function taskVersion(t: Task): string { return t.version && t.version.trim() ? t.version : 'none'; }

export function levelLabel(k: string): string { return LEVEL_LABEL[k] ?? k; }

export function assigneeInitials(slug: string, name?: string): string {
  if (slug === 'none') return '–';
  const src = (name || slug).replace(/[-_.]/g, ' ').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/**
 * Deterministic avatar hue (0..359) for a person slug, so co-assignees on the
 * same card are told apart by colour rather than initials alone. Same idiom as
 * {@link tagHue} / council `modelHue`.
 */
export function assigneeHue(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) % 360;
  return h;
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
export function dueInfo(t: Task, sm: StatusModel = DEFAULT_STATUS_MODEL): DueInfo | null {
  const due = taskDue(t);
  // Terminal by KIND — a cancelled-kind task is never overdue.
  if (sm.isTerminal(t.status) || !due) return null;
  const d = new Date(due + 'T00:00:00').getTime();
  const diff = Math.round((d - startOfToday()) / 86_400_000);
  if (diff < 0) return { label: `Overdue ${-diff}d`, glyph: '⚑', kind: 'overdue', color: 'var(--color-error)', bg: 'var(--color-error-subtle)' };
  if (diff === 0) return { label: 'Due today', glyph: '●', kind: 'today', color: 'var(--color-warning)', bg: 'var(--color-warning-subtle)' };
  if (diff <= 2) return { label: `${diff}d left`, glyph: '●', kind: 'soon', color: 'var(--color-warning)', bg: 'var(--color-warning-subtle)' };
  if (diff <= 7) return { label: `${diff}d left`, glyph: '○', kind: 'week', color: 'var(--color-accent)', bg: 'var(--color-accent-soft)' };
  return { label: fmtShort(due), glyph: '', kind: 'far', color: 'var(--color-text-tertiary)', bg: 'var(--color-bg-tertiary)' };
}
export function isAtRisk(t: Task, sm: StatusModel = DEFAULT_STATUS_MODEL): boolean {
  const di = dueInfo(t, sm);
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

export function dimGet(t: Task, dim: Dim, activeCycleId: string | null = null): string {
  if (dim === 'status') return t.status;
  if (dim === 'version') return taskVersion(t);
  if (dim === 'assignee') return taskAssignee(t);
  return orderOf(t, activeCycleId);
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

// ─── Virtual ("smart") version buckets ───────────────────────────────────────────
// Pseudo-version filter tokens that resolve dynamically against the active sprint
// and the released-version set, rather than equalling a literal task `version:`
// string. They give the version filter higher-level selections — the current
// sprint, the backlog, and anything completed — and, because they resolve at
// filter time, a saved view that filters by "Current" always tracks whatever sprint
// is active. The "@" prefix keeps them from ever colliding with a real version name.
export const VV_CURRENT = '@current';
export const VV_BACKLOG = '@backlog';
export const VV_COMPLETED = '@completed';
export const VIRTUAL_VERSIONS: readonly string[] = [VV_CURRENT, VV_BACKLOG, VV_COMPLETED];
export const BACKLOG_RE = /^backlog$/i;

/** Runtime metadata the version filter needs to resolve the virtual buckets. */
export interface VersionMeta {
  /** The active planning version ("current sprint"), or null if none is set. */
  active: string | null;
  /** Version names whose RELEASES.json status is 'released' (completed sprints). */
  released: readonly string[];
}
export const EMPTY_VERSION_META: VersionMeta = { active: null, released: [] };

/**
 * Case/diacritic fold for version comparison — the second line of defence for
 * versions that round-tripped through a cloud backend (#184).
 *
 * ClickUp lowercases tag names, so a sprint pushed as `S5 (Jul 13 - Jul 17)` can
 * come back as `s5 (jul 13 - jul 17)`. The sync now restores the canonical
 * spelling on pull, but the board must not go blind on data that was already
 * written before that fix, or on a version no RELEASES.json entry can canonicalize.
 * An exact-match filter here means the task silently vanishes from its own sprint —
 * the failure mode is invisible scope-loss, so matching leniently is the safe side.
 *
 * Code points are written escaped so the compiled bundle stays ASCII (see the
 * matching fold in SearchableSelect.tsx).
 */
function foldVersion(s: string): string {
  return s
    .replace(/\u0131/g, 'i').replace(/\u0130/g, 'i') // dotless i / dotted I
    .replace(/\u015f/g, 's').replace(/\u015e/g, 's') // s-cedilla
    .replace(/\u011f/g, 'g').replace(/\u011e/g, 'g') // g-breve
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks
    .toLowerCase()
    .trim();
}

/** Does a task's version value satisfy a single filter token (literal or virtual)? */
export function versionTokenMatches(version: string, token: string, meta: VersionMeta): boolean {
  if (token === VV_CURRENT) return meta.active != null && foldVersion(version) === foldVersion(meta.active);
  if (token === VV_COMPLETED) return meta.released.some((r) => foldVersion(r) === foldVersion(version));
  if (token === VV_BACKLOG) return BACKLOG_RE.test(version);
  return foldVersion(version) === foldVersion(token);
}

/** Version-aware include/exclude match — like matchField, but understands the virtual buckets. */
function matchVersionField(version: string, fld: FieldFilter | undefined, meta: VersionMeta): boolean {
  if (!fld) return true;
  if (fld.inc.length && !fld.inc.some((tok) => versionTokenMatches(version, tok, meta))) return false;
  if (fld.exc.length && fld.exc.some((tok) => versionTokenMatches(version, tok, meta))) return false;
  return true;
}

export function filterTasks(tasks: Task[], f: BoardFilters, search: string, versionMeta: VersionMeta = EMPTY_VERSION_META, sm: StatusModel = DEFAULT_STATUS_MODEL): Task[] {
  const q = (search || '').trim().toLowerCase();
  return tasks.filter((t) => {
    if (!matchField(t.status, f.status)) return false;
    if (!matchAssignee(t, f.assignee)) return false;
    if (!matchVersionField(taskVersion(t), f.version, versionMeta)) return false;
    if (f.tags.inc.length && !f.tags.inc.some((tg) => t.tags.includes(tg))) return false;
    if (f.tags.exc.length && f.tags.exc.some((tg) => t.tags.includes(tg))) return false;
    if (f.due !== 'all') {
      const di = dueInfo(t, sm);
      if (f.due === 'overdue' && !(di && di.kind === 'overdue')) return false;
      if (f.due === 'today' && !(di && di.kind === 'today')) return false;
      if (f.due === 'risk' && !isAtRisk(t, sm)) return false;
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
  if (by === 'rank') return byRank(tasks);
  const d = dir === 'asc' ? 1 : -1;
  const key = (t: Task): number | string => {
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

/** Rank order inside one bucket: ranked cards first by rank, then the unranked by name. */
export function byRank(tasks: Task[]): Task[] {
  return tasks.slice().sort((a, b) => {
    const ra = typeof a.rank === 'number' ? a.rank : null;
    const rb = typeof b.rank === 'number' ? b.rank : null;
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
    if (ra !== null && rb === null) return -1;
    if (ra === null && rb !== null) return 1;
    return taskName(a).localeCompare(taskName(b));
  });
}

export type OrderLane = Order | 'done';
export const ORDER_LANES: readonly OrderLane[] = ['now', 'next', 'later', 'done'];
const ORDER_LABEL: Record<OrderLane, string> = { now: 'Now', next: 'Next', later: 'Later', done: 'Done' };
const ORDER_COLOR: Record<OrderLane, string> = {
  now: 'var(--color-status-in-progress)', next: 'var(--color-status-todo)',
  later: 'var(--color-text-tertiary)', done: 'var(--color-status-completed)',
};

/** Cancelled by KIND, or by the conventional key on a machine that has not declared it. */
function isCancelledStatus(status: string, sm: StatusModel): boolean {
  return sm.isCancelled(status) || status === 'cancelled';
}

/**
 * The board's Now / Next / Later columns (plan r3 § 5b, with the C4 critic fix):
 *  - a cancelled-kind card is not on the board;
 *  - a done-kind card shows in Now only while it is in the ACTIVE cycle (the cycle strip counts
 *    it); every other done card goes to the Done lane, which the board keeps closed by default;
 *  - every open card goes to Now / Next / Later by `orderOf` (the server's axis), by rank.
 * So a finished or cancelled card that was never planned can never sit in Next or Later.
 */
export function groupByOrder(
  tasks: Task[],
  activeCycleId: string | null,
  sm: StatusModel = DEFAULT_STATUS_MODEL,
  labels: Partial<Record<OrderLane, string>> = {},
): DimGroup[] {
  const lanes: Record<OrderLane, Task[]> = { now: [], next: [], later: [], done: [] };
  for (const t of tasks) {
    if (isCancelledStatus(t.status, sm)) continue;
    const order = orderOf(t, activeCycleId);
    if (sm.isDone(t.status)) lanes[order === 'now' ? 'now' : 'done'].push(t);
    else lanes[order].push(t);
  }
  return ORDER_LANES.map((k) => ({ key: k, label: labels[k] ?? ORDER_LABEL[k], color: ORDER_COLOR[k], tasks: byRank(lanes[k]) }));
}

/** One card on a column, with the sub-tasks that sit in the same column nested under it. */
export interface CardNode { task: Task; children: Task[] }
/** A column's items: a card (with its nested children), or sub-tasks whose parent is elsewhere. */
export type ColumnItem =
  | { kind: 'card'; node: CardNode }
  | { kind: 'orphans'; parent: { slug: string; name: string }; nodes: CardNode[] };

/**
 * Nest sub-tasks under their parent when both are in the same column (the parent's card
 * expands to show them). Sub-tasks whose parent is not in the column are grouped under a header
 * that names the parent. Order follows the column's own order.
 */
export function nestByParent(cards: Task[], all: Task[]): ColumnItem[] {
  const here = new Set(cards.map((t) => t.slug));
  const byParent = new Map<string, Task[]>();
  for (const t of cards) {
    const p = t.parent_task;
    if (p && here.has(p)) byParent.set(p, [...(byParent.get(p) ?? []), t]);
  }
  const items: ColumnItem[] = [];
  const orphanGroups = new Map<string, Extract<ColumnItem, { kind: 'orphans' }>>();
  for (const t of cards) {
    const p = t.parent_task;
    if (p && here.has(p)) continue;
    const node: CardNode = { task: t, children: byParent.get(t.slug) ?? [] };
    if (p) {
      let group = orphanGroups.get(p);
      if (!group) {
        const parent = all.find((x) => x.slug === p);
        group = { kind: 'orphans', parent: { slug: p, name: parent ? taskName(parent) : p }, nodes: [] };
        orphanGroups.set(p, group);
        items.push(group);
      }
      group.nodes.push(node);
    } else {
      items.push({ kind: 'card', node });
    }
  }
  return items;
}

/**
 * Partition `tasks` by `dim`. `versionOrder` / `assignees` supply the dynamic
 * column ordering the design hard-coded for its mock data.
 */
export function dimGroups(
  dim: Dim,
  tasks: Task[],
  opts: {
    versionOrder: string[];
    assignees: { value: string; label: string; color: string }[];
    statuses?: StatusModel;
    activeCycleId?: string | null;
    orderLabels?: Partial<Record<OrderLane, string>>;
  },
): DimGroup[] {
  if (dim === 'order') return groupByOrder(tasks, opts.activeCycleId ?? null, opts.statuses ?? DEFAULT_STATUS_MODEL, opts.orderLabels);
  if (dim === 'status') {
    const sm = opts.statuses ?? DEFAULT_STATUS_MODEL;
    const cols = sm.order.map((k) => ({ key: k, label: sm.labelOf(k), color: sm.colorOf(k), tasks: tasks.filter((t) => t.status === k) }));
    // A status outside the loaded set (declared on a machine whose override this
    // one has not pulled) still gets a column — unknown fails SAFE, never hidden.
    const known = new Set(sm.order);
    for (const t of tasks) {
      if (known.has(t.status)) continue;
      known.add(t.status);
      cols.push({ key: t.status, label: t.status, color: 'var(--color-text-tertiary)', tasks: tasks.filter((x) => x.status === t.status) });
    }
    return cols;
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
