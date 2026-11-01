/**
 * priorityModel — the PURE geometry and ordering of the Roadmap's priority board
 * (Lanes and Map, at the Objectives and the Tasks level).
 *
 * It never re-derives suggestions or links: the server's one payload
 * (GET /api/roadmap/priority) already carries each card's effective links, dead-link
 * mark, live verdict and effective suggestion. This module only places them.
 */

// ─── Bands (mirror of src/lib/rice.ts PRIORITY_BANDS; drift-tested) ─────────

export const PRIORITY_BANDS = {
  task: { now: 20, next: 8 },
  objective: { now: 5, next: 2 },
} as const;

export type PriorityLevel = keyof typeof PRIORITY_BANDS;
export type Band = 'now' | 'next' | 'later';
export const BANDS: readonly Band[] = ['now', 'next', 'later'];
export const BAND_LABEL: Record<Band, string> = { now: 'Now', next: 'Next', later: 'Later' };

export function priorityBand(level: PriorityLevel, score: number | null | undefined): Band | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  const t = PRIORITY_BANDS[level];
  if (score >= t.now) return 'now';
  if (score >= t.next) return 'next';
  return 'later';
}

/** "20+", "8 to 20", "under 8". */
export function bandRange(level: PriorityLevel, band: Band): string {
  const t = PRIORITY_BANDS[level];
  if (band === 'now') return `${t.now}+`;
  if (band === 'next') return `${t.next} to ${t.now}`;
  return `under ${t.next}`;
}

// ─── Payload types (mirror of src/server/routes/roadmap-priority.ts) ────────

export type RiceKey = 'reach' | 'impact' | 'confidence' | 'effort';
export type RiceValues = Record<RiceKey, number | null>;

export interface EffectiveSuggestion {
  at: string;
  why: string;
  rice: Partial<Record<RiceKey, number>> | null;
  objective: string | null;
}

export interface PriorityTaskRef { slug: string; status: string; start_date: string | null; due_date: string | null }

export interface PriorityObjective {
  slug: string;
  title: string;
  description: string | null;
  start_date: string | null;
  target_date: string | null;
  impact: number | null;
  effort: number | null;
  reach: number | null;
  confidence: number | null;
  score: number | null;
  created_at: string | null;
  depends_on: string[];
  status: 'not_started' | 'active' | 'review' | 'done';
  progress: { done: number; total: number; pct: number | null; source: 'tasks' | 'metric' };
  slipping: boolean | null;
  tasks: PriorityTaskRef[];
  signal: 'late' | 'slipping' | 'on_track' | null;
  late_days: number | null;
  effective_suggestion: EffectiveSuggestion | null;
}

export interface PriorityTask {
  slug: string;
  name: string;
  status: string;
  status_kind: 'active' | 'review' | 'other';
  rice: RiceValues;
  score: number | null;
  links: string[];
  mark: 'objective done' | 'objective missing' | null;
  all_links: string[];
  no_objective: boolean;
  effective_suggestion: EffectiveSuggestion | null;
  subtask_count: number;
  updated_at: string | null;
}

export interface PriorityPayload {
  generated_at: string;
  objectives: PriorityObjective[];
  tasks: PriorityTask[];
  scoring: { count: number; pending: number; running: boolean };
  warnings: string[];
}

// ─── Scores ─────────────────────────────────────────────────────────────────

export function riceScore(r: Partial<RiceValues>): number | null {
  const { reach, impact, confidence, effort } = r;
  if (reach == null || impact == null || confidence == null || effort == null) return null;
  if (!(effort > 0)) return null;
  return Math.round(((reach * impact * (confidence / 100)) / effort) * 100) / 100;
}

/** The values a card is placed by: its own, filled by its effective suggestion. */
export function displayRice(rice: RiceValues, s: EffectiveSuggestion | null): RiceValues {
  if (!s?.rice) return rice;
  const out = { ...rice };
  for (const k of ['reach', 'impact', 'confidence', 'effort'] as const) {
    if (out[k] == null && s.rice[k] != null) out[k] = s.rice[k]!;
  }
  return out;
}

export interface Placed {
  /** The score the card is placed by (own, or own + suggestion). */
  score: number | null;
  /** The score comes from (or depends on) the agent's suggestion: drawn dashed with ✦. */
  suggested: boolean;
}

export function placeOf(rice: RiceValues, own: number | null, s: EffectiveSuggestion | null): Placed {
  if (own != null) return { score: own, suggested: false };
  const score = riceScore(displayRice(rice, s));
  return { score, suggested: score != null };
}

function objectiveRice(o: PriorityObjective): RiceValues {
  return { reach: o.reach, impact: o.impact, confidence: o.confidence, effort: o.effort };
}

export function objectivePlace(o: PriorityObjective): Placed {
  return placeOf(objectiveRice(o), o.score, o.effective_suggestion);
}

export function taskPlace(t: PriorityTask): Placed {
  return placeOf(t.rice, t.score, t.effective_suggestion);
}

/** Round to one decimal for display: 6.5625 → "6.6", 112.5 → "112.5", 24 → "24.0". */
export function fmtScore(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

// ─── Objectives level ──────────────────────────────────────────────────────

export interface ObjectiveFilter {
  status: { inc: string[]; exc: string[] };
  signal: { inc: string[]; exc: string[] };
}

function passField(value: string, f: { inc: string[]; exc: string[] }): boolean {
  if (f.exc.includes(value)) return false;
  if (f.inc.length > 0 && !f.inc.includes(value)) return false;
  return true;
}

function matches(q: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(needle));
}

/** Objectives shown on the board: Filter (status, signal) and search; done ones only when filtered in. */
export function visibleObjectives(
  objectives: readonly PriorityObjective[],
  search: string,
  filter?: ObjectiveFilter,
): PriorityObjective[] {
  return objectives.filter((o) => {
    if (o.status === 'done' && !(filter?.status.inc.includes('done'))) return false;
    if (filter && !passField(o.status, filter.status)) return false;
    if (filter && !passField(o.signal ?? 'unforecastable', filter.signal)) return false;
    return matches(search, o.title, o.slug);
  });
}

/** Rank order: scored by score desc (suggested scores count), then unscored by title. */
export function rankObjectives(objectives: readonly PriorityObjective[]): PriorityObjective[] {
  return [...objectives].sort((a, b) => {
    const sa = objectivePlace(a).score;
    const sb = objectivePlace(b).score;
    if (sa != null && sb != null) return sb - sa || a.title.localeCompare(b.title);
    if (sa != null) return -1;
    if (sb != null) return 1;
    return a.title.localeCompare(b.title);
  });
}

export interface LaneCard<T> {
  item: T;
  place: Placed;
  /** Horizontal gap before this card (px), proportional to the score drop from its left neighbour. */
  gapBefore: number;
}

export const LANE_GAP_MIN = 16;
export const LANE_GAP_MAX = 96;

/** Cards left to right by score, the gap growing with the score difference. */
export function laneRow<T>(cards: Array<{ item: T; place: Placed }>): Array<LaneCard<T>> {
  const sorted = [...cards].sort((a, b) => (b.place.score ?? 0) - (a.place.score ?? 0));
  if (sorted.length === 0) return [];
  const hi = sorted[0].place.score ?? 0;
  const lo = sorted[sorted.length - 1].place.score ?? 0;
  const span = hi - lo;
  return sorted.map((c, i) => {
    if (i === 0) return { ...c, gapBefore: 0 };
    const drop = (sorted[i - 1].place.score ?? 0) - (c.place.score ?? 0);
    const frac = span > 0 ? drop / span : 0;
    return { ...c, gapBefore: Math.round(LANE_GAP_MIN + frac * (LANE_GAP_MAX - LANE_GAP_MIN)) };
  });
}

export interface ObjectiveLanesModel {
  bands: Record<Band, Array<LaneCard<PriorityObjective>>>;
  unscored: PriorityObjective[];
}

export function objectiveLanes(objectives: readonly PriorityObjective[]): ObjectiveLanesModel {
  const groups: Record<Band, Array<{ item: PriorityObjective; place: Placed }>> = { now: [], next: [], later: [] };
  const unscored: PriorityObjective[] = [];
  for (const o of objectives) {
    const place = objectivePlace(o);
    const band = priorityBand('objective', place.score);
    if (!band) unscored.push(o);
    else groups[band].push({ item: o, place });
  }
  return {
    bands: { now: laneRow(groups.now), next: laneRow(groups.next), later: laneRow(groups.later) },
    unscored: unscored.sort((a, b) => a.title.localeCompare(b.title)),
  };
}

/** "Nd late" or the target date, or "no date". */
export function objectiveWhen(o: PriorityObjective): { text: string; late: boolean } {
  if (o.late_days != null && o.late_days > 0) return { text: `${o.late_days}d late`, late: true };
  if (o.target_date) {
    const d = new Date(`${o.target_date}T00:00:00Z`);
    return { text: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), late: false };
  }
  return { text: 'no date', late: false };
}

/** The first dependency that is not done, for "Waits for X". */
export function waitsFor(o: PriorityObjective, all: readonly PriorityObjective[]): PriorityObjective | null {
  for (const slug of o.depends_on) {
    const dep = all.find((x) => x.slug === slug);
    if (dep && dep.status !== 'done') return dep;
  }
  return null;
}

// ─── Tasks level ───────────────────────────────────────────────────────────

export const UNLINKED = '__unlinked__';

export interface TaskCardModel {
  /** Identity on the board: slug + column (a task with two objectives has two cards). */
  key: string;
  task: PriorityTask;
  column: string;
  place: Placed;
  /** A ghost: the agent's suggested link (not draggable). */
  linkGhost: boolean;
  /** Vertical offset inside its band (px). */
  y: number;
}

export interface TaskColumn {
  slug: string;
  title: string;
  objective: PriorityObjective | null;
  bands: Record<Band, TaskCardModel[]>;
  notScored: TaskCardModel[];
  /** A search hit sits in the collapsed Not scored row: open it. */
  notScoredHit: boolean;
  count: number;
}

export interface TaskLanesModel {
  columns: TaskColumn[];
  /** Band heights (px), grown to the fullest column. */
  bandHeight: Record<Band, number>;
}

export const TASK_CARD_H = 72;
export const TASK_CARD_GAP = 12;
export const BAND_MIN_H = 168;
const BAND_PAD = 16;

/**
 * Every open top-level task appears exactly once per effective link, or once in
 * Unlinked, or — when the agent suggests a link for an unlinked task — once as a
 * ghost in the suggested column (and not in Unlinked).
 */
export function taskCardsFor(task: PriorityTask, columns: ReadonlySet<string>): Array<{ column: string; linkGhost: boolean }> {
  const live = task.links.filter((l) => columns.has(l));
  if (live.length > 0) return live.map((column) => ({ column, linkGhost: false }));
  const s = task.effective_suggestion?.objective;
  if (s && columns.has(s)) return [{ column: s, linkGhost: true }];
  return [{ column: UNLINKED, linkGhost: false }];
}

/** Fraction (0 top … 1 bottom) of a score inside a band, on a log scale. */
export function logFrac(score: number, top: number, bottom: number): number {
  const s = Math.max(score, 0.01);
  const lt = Math.log(Math.max(top, 0.02));
  const lb = Math.log(Math.max(bottom, 0.01));
  if (lt <= lb) return 0;
  return Math.min(1, Math.max(0, (lt - Math.log(s)) / (lt - lb)));
}

/**
 * Stack cards inside one band: each wants its log-score height; pushed apart so
 * they never overlap, and never out of the band (pushed back up from the bottom).
 */
export function stackInBand(desired: number[], height: number, cardH = TASK_CARD_H, gap = TASK_CARD_GAP): number[] {
  const ys: number[] = [];
  const maxY = Math.max(0, height - cardH - BAND_PAD);
  for (let i = 0; i < desired.length; i++) {
    const want = Math.min(Math.max(desired[i], BAND_PAD), maxY);
    ys.push(i === 0 ? want : Math.max(want, ys[i - 1] + cardH + gap));
  }
  for (let i = ys.length - 1; i >= 0; i--) {
    const limit = i === ys.length - 1 ? maxY : ys[i + 1] - cardH - gap;
    if (ys[i] > limit) ys[i] = limit;
  }
  return ys.map((y) => Math.max(0, y));
}

export function taskLanes(
  objectives: readonly PriorityObjective[],
  tasks: readonly PriorityTask[],
  search: string,
): TaskLanesModel {
  const ranked = rankObjectives(objectives.filter((o) => o.status !== 'done'));
  const columnSlugs = new Set(ranked.map((o) => o.slug));
  const cols: TaskColumn[] = [
    ...ranked.map((o) => ({ slug: o.slug, title: o.title, objective: o })),
    { slug: UNLINKED, title: 'Unlinked', objective: null },
  ].map((c) => ({ ...c, bands: { now: [], next: [], later: [] }, notScored: [], notScoredHit: false, count: 0 }));
  const bySlug = new Map(cols.map((c) => [c.slug, c]));

  const q = search.trim();
  for (const task of tasks) {
    if (!matches(q, task.name, task.slug)) continue;
    const place = taskPlace(task);
    const band = priorityBand('task', place.score);
    for (const { column, linkGhost } of taskCardsFor(task, columnSlugs)) {
      const col = bySlug.get(column)!;
      const card: TaskCardModel = { key: `${task.slug}::${column}`, task, column, place, linkGhost, y: 0 };
      col.count++;
      if (band) col.bands[band].push(card);
      else {
        col.notScored.push(card);
        if (q) col.notScoredHit = true;
      }
    }
  }

  // Band ranges on the log axis: Now from the highest score down to 20, Later from 8 down to the lowest.
  const all = tasks.map((t) => taskPlace(t).score).filter((s): s is number => s != null && s > 0);
  const t = PRIORITY_BANDS.task;
  const range: Record<Band, [number, number]> = {
    now: [Math.max(t.now * 2, ...all), t.now],
    next: [t.now, t.next],
    later: [t.next, Math.min(t.next / 8, ...all)],
  };

  const bandHeight: Record<Band, number> = { now: BAND_MIN_H, next: BAND_MIN_H, later: BAND_MIN_H };
  for (const b of BANDS) {
    for (const col of cols) {
      col.bands[b].sort((x, y) => (y.place.score ?? 0) - (x.place.score ?? 0) || x.task.slug.localeCompare(y.task.slug));
      const need = BAND_PAD * 2 + col.bands[b].length * (TASK_CARD_H + TASK_CARD_GAP);
      bandHeight[b] = Math.max(bandHeight[b], need);
    }
  }
  for (const b of BANDS) {
    const [top, bottom] = range[b];
    const h = bandHeight[b];
    for (const col of cols) {
      const cards = col.bands[b];
      const desired = cards.map((c) => BAND_PAD + logFrac(c.place.score!, top, bottom) * (h - TASK_CARD_H - BAND_PAD * 2));
      stackInBand(desired, h).forEach((y, i) => { cards[i].y = y; });
    }
  }
  for (const col of cols) col.notScored.sort((a, b) => a.task.name.localeCompare(b.task.name));

  return { columns: cols, bandHeight };
}

// ─── Drag (Lanes, Tasks; horizontal only) ──────────────────────────────────

export interface MoveOp { remove: string | null; add: string | null; index?: number; undo?: boolean }

/**
 * What dropping a card on `target` asks the server. Only THE SOURCE link moves;
 * a card marked "objective done/missing" replaces its first dead link.
 */
export function planDrop(card: Pick<TaskCardModel, 'column' | 'linkGhost'> & { task: Pick<PriorityTask, 'links' | 'all_links' | 'mark'> }, target: string): MoveOp | null {
  if (card.linkGhost) return null;
  if (target === card.column) return null;
  if (card.column === UNLINKED) {
    if (target === UNLINKED) return null;
    const dead = card.task.mark ? card.task.all_links.find((l) => !card.task.links.includes(l)) ?? null : null;
    return { remove: dead, add: target };
  }
  if (target === UNLINKED) return { remove: card.column, add: null };
  return { remove: card.column, add: target };
}

/** The same move applied locally (optimistic): effective links only. */
export function applyMoveLocal(tasks: readonly PriorityTask[], slug: string, op: MoveOp): PriorityTask[] {
  return tasks.map((t) => {
    if (t.slug !== slug) return t;
    let links = [...t.links];
    let all = [...t.all_links];
    let idx = -1;
    if (op.remove) {
      idx = all.indexOf(op.remove);
      links = links.filter((l) => l !== op.remove);
      all = all.filter((l) => l !== op.remove);
    }
    if (op.add && !all.includes(op.add)) {
      const at = op.index ?? (idx >= 0 ? idx : all.length);
      all.splice(Math.min(at, all.length), 0, op.add);
      links = [...links, op.add];
    }
    const mark = links.length === 0 && all.length > 0 ? t.mark : null;
    return { ...t, links, all_links: all, mark, effective_suggestion: op.add ? (t.effective_suggestion && { ...t.effective_suggestion, objective: null }) : t.effective_suggestion };
  });
}

// ─── Map ───────────────────────────────────────────────────────────────────

export interface MapPoint<T> {
  item: T;
  key: string;
  x: number;
  y: number;
  score: number;
  suggested: boolean;
  /** Carries a card (top 20 by score at the Tasks level; every objective). */
  labelled: boolean;
}

export interface MapGeometry<T> {
  points: Array<MapPoint<T>>;
  /** Band boundary lines value = threshold × effort, clipped to the box. */
  lines: Array<{ band: 'now' | 'next'; x1: number; y1: number; x2: number; y2: number }>;
  domain: { effort: [number, number]; value: [number, number] };
  unscored: number;
}

export const MAP_LABELS = 20;
const EFFORT_DOMAIN: [number, number] = [0.1, 52];
const VALUE_DOMAIN: [number, number] = [0.1, 50];

function clampLog(v: number, [lo, hi]: [number, number]): number {
  return Math.log(Math.min(hi, Math.max(lo, v > 0 ? v : lo)));
}

/** Y = reach × impact × confidence/100 (value), X = effort; both on log axes. */
export function mapGeometry<T>(
  level: PriorityLevel,
  items: ReadonlyArray<{ item: T; key: string; rice: RiceValues; place: Placed }>,
  width: number,
  height: number,
): MapGeometry<T> {
  const ex = [Math.log(EFFORT_DOMAIN[0]), Math.log(EFFORT_DOMAIN[1])];
  const vy = [Math.log(VALUE_DOMAIN[0]), Math.log(VALUE_DOMAIN[1])];
  const toX = (e: number) => ((clampLog(e, EFFORT_DOMAIN) - ex[0]) / (ex[1] - ex[0])) * width;
  const toY = (v: number) => height - ((clampLog(v, VALUE_DOMAIN) - vy[0]) / (vy[1] - vy[0])) * height;

  const scored = items.filter((i) => i.place.score != null);
  const ranked = [...scored].sort((a, b) => b.place.score! - a.place.score!);
  const labelled = new Set((level === 'task' ? ranked.slice(0, MAP_LABELS) : ranked).map((i) => i.key));
  const points: Array<MapPoint<T>> = scored.map((i) => {
    const r = i.rice;
    const value = (r.reach ?? 0) * (r.impact ?? 0) * ((r.confidence ?? 0) / 100);
    return {
      item: i.item,
      key: i.key,
      x: toX(r.effort ?? EFFORT_DOMAIN[0]),
      y: toY(value),
      score: i.place.score!,
      suggested: i.place.suggested,
      labelled: labelled.has(i.key),
    };
  });

  // value = t × effort is a straight line of slope 1 in log-log space.
  const lines: MapGeometry<T>['lines'] = [];
  for (const band of ['now', 'next'] as const) {
    const t = PRIORITY_BANDS[level][band];
    let e1 = EFFORT_DOMAIN[0];
    let e2 = EFFORT_DOMAIN[1];
    e1 = Math.max(e1, VALUE_DOMAIN[0] / t);
    e2 = Math.min(e2, VALUE_DOMAIN[1] / t);
    if (e1 >= e2) continue;
    lines.push({ band, x1: toX(e1), y1: toY(t * e1), x2: toX(e2), y2: toY(t * e2) });
  }

  return {
    points,
    lines,
    domain: { effort: EFFORT_DOMAIN, value: VALUE_DOMAIN },
    unscored: items.length - scored.length,
  };
}

// ─── Agent button ──────────────────────────────────────────────────────────

export type AgentButtonState =
  | { kind: 'hidden' }
  | { kind: 'suggestions'; label: string; count: number }
  | { kind: 'running'; label: string }
  | { kind: 'score'; label: string; count: number };

/**
 * "✦ N suggestions" while any are pending (reachable while the agent runs);
 * hidden at N = 0 with none pending, even if running; "Scoring…" (disabled)
 * while running; else "✦ Score N".
 */
export function agentButtonState(scoring: PriorityPayload['scoring']): AgentButtonState {
  if (scoring.pending > 0) {
    return { kind: 'suggestions', label: `✦ ${scoring.pending} suggestion${scoring.pending === 1 ? '' : 's'}`, count: scoring.pending };
  }
  if (scoring.count === 0) return { kind: 'hidden' };
  if (scoring.running) return { kind: 'running', label: 'Scoring…' };
  return { kind: 'score', label: `✦ Score ${scoring.count}`, count: scoring.count };
}

export type PendingItem =
  | { kind: 'objective'; slug: string; title: string; suggestion: EffectiveSuggestion }
  | { kind: 'task'; slug: string; title: string; suggestion: EffectiveSuggestion };

/** The suggestions the panel walks, one per item (a task with two objectives is one item). */
export function pendingItems(p: Pick<PriorityPayload, 'objectives' | 'tasks'>): PendingItem[] {
  const out: PendingItem[] = [];
  for (const o of rankObjectives(p.objectives.filter((x) => x.status !== 'done'))) {
    if (o.effective_suggestion) out.push({ kind: 'objective', slug: o.slug, title: o.title, suggestion: o.effective_suggestion });
  }
  const tasks = [...p.tasks].sort((a, b) => (taskPlace(b).score ?? -1) - (taskPlace(a).score ?? -1));
  for (const t of tasks) {
    if (t.effective_suggestion) out.push({ kind: 'task', slug: t.slug, title: t.name, suggestion: t.effective_suggestion });
  }
  return out;
}

/** The five values a RICE segment shows: the scale's steps, always including the stored value. */
export function segmentValues(key: RiceKey, stored: number | null | undefined): number[] {
  const base: Record<RiceKey, number[]> = {
    reach: [2, 4, 6, 8, 10],
    impact: [1, 2, 3, 4, 5],
    confidence: [25, 50, 75, 100],
    effort: [0.5, 1, 2, 4, 8],
  };
  const vals = base[key];
  if (stored == null || vals.includes(stored)) return vals;
  // Replace the nearest step with the stored value (e.g. Tilki's 0.2 weeks), keeping order.
  let nearest = 0;
  for (let i = 1; i < vals.length; i++) if (Math.abs(vals[i] - stored) < Math.abs(vals[nearest] - stored)) nearest = i;
  const out = [...vals];
  out[nearest] = stored;
  return out.sort((a, b) => a - b);
}
