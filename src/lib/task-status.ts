/**
 * Task statuses as DATA with a semantic kind (task_adYgpCxk).
 *
 * A status used to be one of four string literals, each consumer carrying its
 * own copy of the list and eight sites reading `status !== 'completed'` as
 * "this task is live". This module is the single model every one of those
 * sites now reads through:
 *
 *  - `StatusDef` — a status is a key + label + semantic `kind` + pipeline
 *    `order`, with an optional colour and ClickUp aliases.
 *  - `DEFAULT_STATUSES` — the four shipped statuses. A project ADDS to them in
 *    `_dream_context/overrides/task.md` (`statuses:` frontmatter, parsed by
 *    overrides.ts); it can relabel / reorder / recolour the shipped four but
 *    never remove or re-kind them.
 *  - The predicates (`isDone`, `isCancelled`, `isTerminal`, `isActive`,
 *    `isKnown`, `statusRank`) — every derived behaviour asks the KIND, never a
 *    literal, so a declared status (PLANNED, CANCELLED, …) behaves correctly
 *    everywhere without a code change.
 *
 * Pure module: no I/O, no imports. Every predicate takes the loaded status set
 * explicitly — a call site that "forgets" the project's set would silently
 * treat a declared status as unknown, so there is deliberately no ambient
 * default. `loadStatuses(contextRoot)` lives in overrides.ts.
 *
 * INVARIANTS (enforced at parse time in overrides.ts):
 *  - exactly ONE `done`-kind status, always keyed `completed`;
 *  - the four shipped keys exist in every set;
 *  - an UNKNOWN key always fails SAFE: not terminal, not active, never
 *    deleted, never reopened, never silently buried by a merge (see
 *    `statusRank` / `compareStatusRank`).
 */

export type StatusKind = 'open' | 'active' | 'review' | 'done' | 'cancelled';

export const STATUS_KINDS: readonly StatusKind[] = ['open', 'active', 'review', 'done', 'cancelled'];

export interface StatusDef {
  /** Frontmatter value — snake_case ascii (the `fieldKey` form). */
  key: string;
  /** Display name. */
  label: string;
  /** Drives ALL derived logic (terminal? active? closes the issue?). */
  kind: StatusKind;
  /**
   * Which of the four SHIPPED statuses this one lives under. THE REMOTE
   * CONTRACT: a cloud backend only ever sees the parent, so a declared status
   * needs nothing created on the remote — GitHub gets the parent's open/closed
   * state, ClickUp gets a list status every list already has. The child's own
   * identity rides beside it as a `dc:<key>` label (GitHub) / tag (ClickUp).
   * Defaults to the natural parent of `kind` (see PARENT_BY_KIND).
   */
  parent?: string;
  /** Pipeline position: board columns, `-g status` grouping, merge "furthest wins". */
  order: number;
  /** 6-hex colour (no `#`) — the GitHub label colour + the dashboard swatch. */
  color?: string;
  /** Explicit ClickUp status-name aliases (folded, exact match first on pull). */
  clickup?: string[];
}

/**
 * The shipped set. Orders are spaced by 10 so a declared status can slot
 * BETWEEN two shipped ones (`planned: 5`) without renumbering anything.
 */
export const DEFAULT_STATUSES: readonly StatusDef[] = [
  { key: 'todo', label: 'To Do', kind: 'open', order: 0 },
  { key: 'in_progress', label: 'In Progress', kind: 'active', order: 10 },
  { key: 'in_review', label: 'In Review', kind: 'review', order: 20 },
  { key: 'completed', label: 'Completed', kind: 'done', order: 30 },
];

/** The four keys every status set carries; cannot be removed or re-kinded. */
export const SHIPPED_STATUS_KEYS: readonly string[] = DEFAULT_STATUSES.map((s) => s.key);

/** The one done-kind key (invariant: exactly one done status, always this key). */
export const DONE_STATUS_KEY = 'completed';

/**
 * Default 6-hex colour per kind — used for a declared status that names no
 * colour (its GitHub label + dashboard swatch), and as the shipped label
 * colours' fallback. Kept in lock-step with github-fields' historical values
 * for in_progress / in_review so an existing repo's labels do not change hue.
 */
export const KIND_COLORS: Readonly<Record<StatusKind, string>> = {
  open: 'c5def5',
  active: 'fbca04',
  review: '0e8a16',
  done: '6f42c1',
  cancelled: 'cfd3d7',
};

/** Normalise a raw frontmatter status value to its key form (`in-progress` → `in_progress`). */
export function normalizeStatusKey(status: unknown): string {
  return String(status ?? '').trim().toLowerCase().replace(/-/g, '_');
}

/** The def for a raw status value, or null when the loaded set does not declare it. */
export function findStatus(defs: readonly StatusDef[], status: unknown): StatusDef | null {
  const key = normalizeStatusKey(status);
  if (!key) return null;
  return defs.find((d) => d.key === key) ?? null;
}

/**
 * The parent every kind falls under when a status does not name one. Note
 * `cancelled` parents to `completed`: on a remote, abandoned work is CLOSED —
 * only locally is it distinct from done (it leaves progress counts).
 */
export const PARENT_BY_KIND: Readonly<Record<StatusKind, string>> = {
  open: 'todo',
  active: 'in_progress',
  review: 'in_review',
  done: 'completed',
  cancelled: 'completed',
};

/**
 * The SHIPPED status a status resolves to on a remote backend — itself for one
 * of the four, its declared `parent` for a declared one, else its kind's
 * natural parent. Unknown keys fall back to `todo`: the safest of the four,
 * since it neither closes anything nor claims work is done.
 */
export function parentOf(defs: readonly StatusDef[], status: unknown): string {
  const def = findStatus(defs, status);
  if (!def) return 'todo';
  if (SHIPPED_STATUS_KEYS.includes(def.key)) return def.key;
  if (def.parent && SHIPPED_STATUS_KEYS.includes(def.parent)) return def.parent;
  return PARENT_BY_KIND[def.kind];
}

/** The declared (non-shipped) statuses that live under a given shipped key. */
export function childrenOf(defs: readonly StatusDef[], shippedKey: string): StatusDef[] {
  return sortByOrder(defs).filter((d) => !SHIPPED_STATUS_KEYS.includes(d.key) && parentOf(defs, d.key) === shippedKey);
}

/** Whether a status is one of the four shipped ones. */
export function isShipped(status: unknown): boolean {
  return SHIPPED_STATUS_KEYS.includes(normalizeStatusKey(status));
}

/** The semantic kind of a status, or null when unknown. */
export function statusKind(defs: readonly StatusDef[], status: unknown): StatusKind | null {
  return findStatus(defs, status)?.kind ?? null;
}

/** Does the loaded set recognise this raw frontmatter value? */
export function isKnown(defs: readonly StatusDef[], status: unknown): boolean {
  return findStatus(defs, status) !== null;
}

/** `done`-kind: the work is finished. */
export function isDone(defs: readonly StatusDef[], status: unknown): boolean {
  return statusKind(defs, status) === 'done';
}

/** `cancelled`-kind: the work was abandoned — never finished, never live. */
export function isCancelled(defs: readonly StatusDef[], status: unknown): boolean {
  return statusKind(defs, status) === 'cancelled';
}

/**
 * Terminal = done OR cancelled: the task is no longer live. This is the
 * predicate every "is this task still open?" site reads — a cancelled task is
 * never overdue, never at risk, never offered as the open task a bookmark meant.
 * An UNKNOWN status is NOT terminal (fail safe: keep it visible).
 */
export function isTerminal(defs: readonly StatusDef[], status: unknown): boolean {
  const kind = statusKind(defs, status);
  return kind === 'done' || kind === 'cancelled';
}

/** `active`-kind: work is happening right now (the "in progress" family). */
export function isActive(defs: readonly StatusDef[], status: unknown): boolean {
  return statusKind(defs, status) === 'active';
}

/** `review`-kind: done pending a human's eyes. */
export function isReview(defs: readonly StatusDef[], status: unknown): boolean {
  return statusKind(defs, status) === 'review';
}

/** The single done-kind status of a set (falls back to the shipped `completed`). */
export function doneStatus(defs: readonly StatusDef[]): StatusDef {
  return defs.find((d) => d.kind === 'done') ?? DEFAULT_STATUSES[3];
}

/** Every key of the set, in pipeline order. */
export function statusKeys(defs: readonly StatusDef[]): string[] {
  return sortByOrder(defs).map((d) => d.key);
}

/** The set sorted by `order` (stable: declaration order breaks ties). */
export function sortByOrder(defs: readonly StatusDef[]): StatusDef[] {
  return defs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.order - b.d.order || a.i - b.i)
    .map((x) => x.d);
}

/** Display colour (6-hex, no `#`): the declared colour, else the kind's default. */
export function statusColor(def: StatusDef): string {
  return def.color && /^[0-9a-f]{6}$/i.test(def.color) ? def.color.toLowerCase() : KIND_COLORS[def.kind];
}

/**
 * Merge ordering ("furthest status wins"). Returns a comparable number for a
 * KNOWN status, or null for an unknown one — callers must branch on null (see
 * `compareStatusRank`), never coerce it to -1 the way the old `indexOf` did.
 *
 *  - non-terminal statuses rank by their pipeline `order`;
 *  - any terminal status ranks ABOVE every non-terminal one;
 *  - between two terminals, done beats cancelled.
 */
export function statusRank(defs: readonly StatusDef[], status: unknown): number | null {
  const def = findStatus(defs, status);
  if (!def) return null;
  const maxOrder = defs.reduce((m, d) => Math.max(m, d.order), 0);
  if (def.kind === 'done') return maxOrder + 2000;
  if (def.kind === 'cancelled') return maxOrder + 1000;
  return def.order;
}

/**
 * Pick the winning status of a two-way merge. Deterministic in EVERY case and
 * order-independent (swapping a/b never changes the answer):
 *  - both known: the higher `statusRank`;
 *  - exactly one unknown: the UNKNOWN side wins — it comes from a machine
 *    carrying a newer override, and burying it would silently downgrade work
 *    (the project's preserveLocalOnlyFields doctrine: unknown fails SAFE);
 *  - both unknown and different: later `updated_at` wins; equal → the
 *    lexicographically greater key.
 * Returns the winner plus whether an unknown side was involved (so a report
 * can NAME it).
 */
export function pickMergedStatus(
  defs: readonly StatusDef[],
  a: { status: unknown; updated_at?: unknown },
  b: { status: unknown; updated_at?: unknown },
): { status: string | undefined; unknown: string[] } {
  const as = typeof a.status === 'string' ? a.status : undefined;
  const bs = typeof b.status === 'string' ? b.status : undefined;
  if (as === undefined) return { status: bs, unknown: bs !== undefined && !isKnown(defs, bs) ? [bs] : [] };
  if (bs === undefined) return { status: as, unknown: !isKnown(defs, as) ? [as] : [] };
  const ar = statusRank(defs, as);
  const br = statusRank(defs, bs);
  if (ar !== null && br !== null) {
    if (ar !== br) return { status: br > ar ? bs : as, unknown: [] };
    // EQUAL RANK is a real case, not a theoretical one: two declared statuses of
    // the same kind that name no explicit `order` both take that kind's default
    // (parseStatuses even warns about it), and two cancelled-kind statuses share
    // the terminal offset. Returning `as` here would make the answer depend on
    // which side git handed us as "ours" — i.e. on WHICH MACHINE ran the merge.
    // Fall through to the same symmetric tie-break the both-unknown path uses.
    return { status: symmetricTieBreak(a, b, as, bs), unknown: [] };
  }
  if (ar === null && br !== null) return { status: as, unknown: [as] };
  if (br === null && ar !== null) return { status: bs, unknown: [bs] };
  // Both unknown.
  if (normalizeStatusKey(as) === normalizeStatusKey(bs)) return { status: as, unknown: [as] };
  return { status: symmetricTieBreak(a, b, as, bs), unknown: [as, bs] };
}

/**
 * Break a tie without reference to argument ORDER: later `updated_at` wins, and
 * if those are equal too, the lexicographically greater key. Both rules read the
 * same from either side, which is the whole point — two machines merging the same
 * conflict must reach the same status.
 */
function symmetricTieBreak(
  a: { updated_at?: unknown },
  b: { updated_at?: unknown },
  as: string,
  bs: string,
): string {
  const at = String(a.updated_at ?? '');
  const bt = String(b.updated_at ?? '');
  if (at !== bt) return at > bt ? as : bs;
  return normalizeStatusKey(as) > normalizeStatusKey(bs) ? as : bs;
}

/** The `dc:<key>` GitHub label name for a status key (underscores → dashes). */
export function dcLabelFor(statusKey: string): string {
  return `dc:${normalizeStatusKey(statusKey).replace(/_/g, '-')}`;
}

/** The status key a `dc:<name>` label names (dashes → underscores), or null for a non-dc label. */
export function keyFromDcLabel(label: string): string | null {
  const lower = label.trim().toLowerCase();
  if (!lower.startsWith('dc:')) return null;
  const key = lower.slice(3).replace(/-/g, '_');
  return key || null;
}

/**
 * The `dc:<key>` sub-status marker for a DECLARED status — the carrier that
 * lets the child survive a round trip through a remote that only ever saw the
 * parent. Null for the four shipped keys (the remote's own status says it) and
 * for a key that is not declared here — with one deliberate exception handled
 * by `subStatusLabel` in github-map, which is string-derived so a drifted
 * machine cannot strip another machine's label.
 */
export function subStatusMarker(defs: readonly StatusDef[], status: unknown): string | null {
  const key = normalizeStatusKey(status);
  if (!key || isShipped(key)) return null;
  return dcLabelFor(key);
}

/**
 * A stable fingerprint of a status set (keys + colours + kinds, order-free) —
 * the GitHub backend re-provisions labels when this changes, so a status
 * declared after the hourly provision throttle still gets its label (with its
 * declared colour) before the PATCH that would apply it.
 */
export function statusSetFingerprint(defs: readonly StatusDef[]): number {
  const text = [...defs]
    .map((d) => `${d.key}|${d.kind}|${statusColor(d)}|${d.parent ?? ''}`)
    .sort()
    .join(';');
  // FNV-1a 32-bit — small, deterministic, no dependency.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
