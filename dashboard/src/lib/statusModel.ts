/**
 * Task statuses on the dashboard side — the mirror of `src/lib/task-status.ts`.
 *
 * The server's `/api/task-overrides` hands the dashboard the project's EFFECTIVE
 * status set (the shipped four plus anything declared in `overrides/task.md`),
 * each with a semantic `kind`. `buildStatusModel` turns that into what the board
 * needs: the column order, per-status label + colour, and the kind predicates
 * every "is this task still live?" site reads INSTEAD of `status !== 'completed'`
 * — so a cancelled-kind task is never overdue, never at risk, never in the
 * Eisenhower matrix.
 *
 * Pure: no React, no fetch. `DEFAULT_STATUS_MODEL` is the shipped four, used
 * until the override query lands (and forever, for a project that declares
 * nothing — byte-identical to the old constants).
 */

export type StatusKind = 'open' | 'active' | 'review' | 'done' | 'cancelled';

export interface StatusDef {
  key: string;
  label: string;
  kind: StatusKind;
  /** The shipped status this one rides under on every remote. */
  parent?: string;
  order: number;
  /** 6-hex, no `#`. */
  color?: string;
  clickup?: string[];
}

export interface StatusMeta {
  label: string;
  /** A CSS colour value (a `var(--…)` token or `#hex`). */
  color: string;
  kind: StatusKind;
}

export interface StatusModel {
  /** Every status key in pipeline order (board columns, filter chips, legends). */
  order: string[];
  meta: Record<string, StatusMeta>;
  defs: StatusDef[];
  /** Done- or cancelled-kind: the task is no longer live. Unknown → false (kept visible). */
  isTerminal(status: string): boolean;
  isDone(status: string): boolean;
  isCancelled(status: string): boolean;
  isActive(status: string): boolean;
  kindOf(status: string): StatusKind | null;
  /** Label for a status, falling back to the raw key. */
  labelOf(status: string): string;
  /** Colour for a status, falling back to the tertiary text token. */
  colorOf(status: string): string;
}

export const DEFAULT_STATUSES: StatusDef[] = [
  { key: 'todo', label: 'To Do', kind: 'open', order: 0 },
  { key: 'in_progress', label: 'In Progress', kind: 'active', order: 10 },
  { key: 'in_review', label: 'In Review', kind: 'review', order: 20 },
  { key: 'completed', label: 'Completed', kind: 'done', order: 30 },
];

export const SHIPPED_STATUS_KEYS = DEFAULT_STATUSES.map((s) => s.key);

/** The parent a kind falls under when a status names none (mirrors src/lib/task-status.ts). */
export const PARENT_BY_KIND: Record<StatusKind, string> = {
  open: 'todo', active: 'in_progress', review: 'in_review', done: 'completed', cancelled: 'completed',
};

/** The shipped status a status rides under on a remote backend. */
export function parentOf(def: StatusDef): string {
  if (SHIPPED_STATUS_KEYS.includes(def.key)) return def.key;
  if (def.parent && SHIPPED_STATUS_KEYS.includes(def.parent)) return def.parent;
  return PARENT_BY_KIND[def.kind];
}

/** The shipped statuses keep their theme tokens (they follow the palette). */
const SHIPPED_TOKEN: Record<string, string> = {
  todo: 'var(--color-status-todo)',
  in_progress: 'var(--color-status-in-progress)',
  in_review: 'var(--color-status-in-review)',
  completed: 'var(--color-status-completed)',
};

/** A declared status with no colour of its own inherits its kind's token. */
const KIND_TOKEN: Record<StatusKind, string> = {
  open: 'var(--color-status-todo)',
  active: 'var(--color-status-in-progress)',
  review: 'var(--color-status-in-review)',
  done: 'var(--color-status-completed)',
  cancelled: 'var(--color-status-cancelled)',
};

const FALLBACK_COLOR = 'var(--color-text-tertiary)';

/** The CSS colour a status def renders with: declared hex → shipped token → kind token. */
export function statusCssColor(def: StatusDef): string {
  if (def.color && /^[0-9a-f]{6}$/i.test(def.color)) return `#${def.color.toLowerCase()}`;
  return SHIPPED_TOKEN[def.key] ?? KIND_TOKEN[def.kind];
}

export function buildStatusModel(input: readonly StatusDef[] | null | undefined): StatusModel {
  const defs = (input && input.length > 0 ? input : DEFAULT_STATUSES)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.order - b.d.order || a.i - b.i)
    .map((x) => ({ ...x.d }));
  const meta: Record<string, StatusMeta> = {};
  for (const d of defs) meta[d.key] = { label: d.label, color: statusCssColor(d), kind: d.kind };
  const norm = (s: string): string => String(s ?? '').trim().toLowerCase().replace(/-/g, '_');
  const kindOf = (s: string): StatusKind | null => meta[norm(s)]?.kind ?? null;
  return {
    order: defs.map((d) => d.key),
    meta,
    defs,
    kindOf,
    isTerminal: (s) => { const k = kindOf(s); return k === 'done' || k === 'cancelled'; },
    isDone: (s) => kindOf(s) === 'done',
    isCancelled: (s) => kindOf(s) === 'cancelled',
    isActive: (s) => kindOf(s) === 'active',
    labelOf: (s) => meta[norm(s)]?.label ?? s,
    colorOf: (s) => meta[norm(s)]?.color ?? FALLBACK_COLOR,
  };
}

export const DEFAULT_STATUS_MODEL: StatusModel = buildStatusModel(DEFAULT_STATUSES);
