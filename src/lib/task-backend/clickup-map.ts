/**
 * Pure dreamcontext ↔ ClickUp mapping — issue #11 field mapping table.
 * No I/O, no network: unit-testable in isolation. This is the ONLY module
 * (besides clickup.ts) allowed to know ClickUp wire shapes; nothing here may
 * leak past the backend boundary.
 */
import { foldAscii } from '../fold-ascii.js';
import { parseProjectTag, stripProjectTags } from './provenance.js';
import {
  DEFAULT_STATUSES,
  findStatus,
  isShipped,
  keyFromDcLabel,
  parentOf,
  subStatusMarker,
  type StatusDef,
} from '../task-status.js';

/** ClickUp REST v2 task shape (the subset we read/write). */
export interface ClickUpTask {
  id: string;
  name: string;
  description?: string | null;
  text_content?: string | null;
  status?: { status?: string } | null;
  priority?: { id?: string | number; priority?: string } | null;
  tags?: Array<{ name: string }> | null;
  assignees?: Array<{ id: number | string; username?: string }> | null;
  date_created?: string | null;
  /** Epoch-ms as a string — ClickUp SERVER time. The watermark source. */
  date_updated?: string | null;
  /** Epoch-ms (string or number) — ClickUp's native planned-start field. */
  start_date?: string | number | null;
  due_date?: string | number | null;
  custom_fields?: Array<Record<string, unknown>> | null;
}

export interface ClickUpComment {
  id: string;
  comment_text?: string;
  /** Epoch-ms string, server time. */
  date?: string;
  user?: { id?: number | string; username?: string } | null;
}

// Ascii-fold now lives provider-neutrally in lib/fold-ascii.ts (it is a plain
// string utility, and github-map/member-match need it too). Re-exported here so
// the ClickUp-side modules keep a single import surface.
export { foldAscii } from '../fold-ascii.js';

// ─── Status ────────────────────────────────────────────────────────────────

// Preference chains per dreamcontext status. Lists have CUSTOM status sets
// (observed live: "planning", "at risk", "on hold", …) — pushing a status the
// list doesn't have is a 400, so the mapper picks the first candidate that
// actually EXISTS on the list when the available set is known.
const STATUS_CANDIDATES: Record<string, string[]> = {
  todo: ['to do', 'open', 'todo', 'backlog', 'planning'],
  in_progress: ['in progress', 'in development', 'doing', 'active', 'started'],
  in_review: ['review', 'in review', 'code review', 'qa', 'testing', 'in progress', 'doing'],
  completed: ['complete', 'done', 'closed'],
};

const STATUS_FROM_CLICKUP: Record<string, string> = {
  'to do': 'todo',
  'open': 'todo',
  'in progress': 'in_progress',
  'review': 'in_review',
  'in review': 'in_review',
  'complete': 'completed',
  'closed': 'completed',
  'done': 'completed',
};

/**
 * The ClickUp status-name candidates for a status of the loaded set, in
 * preference order: its declared `clickup:` aliases, its label, its key with
 * spaces, then (for a shipped key) the historical candidate chain.
 */
function candidatesFor(status: string, statuses: readonly StatusDef[]): string[] {
  const def = findStatus(statuses, status);
  const out: string[] = [];
  for (const a of def?.clickup ?? []) out.push(a);
  const shipped = STATUS_CANDIDATES[def?.key ?? status];
  if (shipped) {
    // A shipped key keeps its historical chain FIRST, so a project that declares
    // nothing maps exactly as before; declared aliases still win above it.
    out.push(...shipped);
  } else if (def) {
    out.push(def.label.toLowerCase(), def.key.replace(/_/g, ' '));
  } else {
    out.push(...STATUS_CANDIDATES.todo);
  }
  return [...new Set(out)];
}

/**
 * Map a dreamcontext status to a status the list ACCEPTS.
 * `available` = the list's status set (cached at sync time); when known and
 * no candidate exists on the list, returns null — the caller omits the field
 * rather than triggering a remote 400 (and warns: ClickUp cannot create a
 * status via its API, so the user must add it in the ClickUp UI).
 */
export function statusToClickUp(
  status: string,
  available?: string[] | null,
  statuses: readonly StatusDef[] = DEFAULT_STATUSES,
): string | null {
  // A DECLARED status tries its own names first (so a list that really does
  // carry "Cancelled" gets the honest value), then FALLS BACK to its PARENT's
  // chain — one of the four shipped statuses, which every list can express.
  // That fallback is why a declared status needs nothing created in ClickUp.
  const parent = parentOf(statuses, status);
  const own = candidatesFor(status, statuses);
  const candidates = isShipped(status) ? own : [...new Set([...own, ...candidatesFor(parent, statuses)])];
  if (!available || available.length === 0) return candidates[0];
  const folded = available.map(foldAscii);
  for (const c of candidates) {
    const i = folded.indexOf(foldAscii(c));
    if (i !== -1) return available[i]; // push the list's EXACT spelling
  }
  return null;
}

// ─── Sub-status tag (the carrier for a declared status) ──────────────────────
//
// ClickUp only ever sees one of the four shipped statuses (see statusToClickUp),
// so the CHILD identity rides beside it as a `dc:<key>` TAG — the same carrier
// pattern `version:<v>` already uses. Nothing has to be created remotely: tags
// are free-form. Shipped statuses emit NO tag (the list status already says it),
// which is what keeps a project that declares nothing byte-identical.

/** The `dc:<key>` tag a status rides as, or null for the four shipped ones. */
export function subStatusTag(status: string, statuses: readonly StatusDef[] = DEFAULT_STATUSES): string | null {
  return subStatusMarker(statuses, status);
}

/** The status key a `dc:*` tag names, or null for any other tag. */
export function subStatusFromTags(tagNames: readonly string[]): string | null {
  for (const name of tagNames) {
    const key = keyFromDcLabel(name);
    if (key) return key;
  }
  return null;
}

/**
 * Resolve the local status of a pulled task: the `dc:<key>` tag WHEN it still
 * agrees with the remote's own status, else the plain fold.
 *
 * The agreement check is what keeps a human's move authoritative. We wrote the
 * tag when we pushed; if someone then dragged the task from Complete to In
 * Progress in ClickUp, the tag is STALE and the remote status must win. Both
 * sides are compared by PARENT, because the parent is the only thing ClickUp
 * ever carried.
 */
export function resolveStatusFromClickUp(
  remoteStatus: string | undefined | null,
  tagNames: readonly string[],
  statuses: readonly StatusDef[] = DEFAULT_STATUSES,
): string {
  const base = statusFromClickUp(remoteStatus, statuses);
  const tagged = subStatusFromTags(tagNames);
  if (!tagged) return base;
  const child = findStatus(statuses, tagged);
  if (!child || isShipped(child.key)) return base;
  return parentOf(statuses, child.key) === parentOf(statuses, base) ? child.key : base;
}

/**
 * Map a ClickUp status name to a dreamcontext status. ORDER IS THE FIX:
 *  1. an EXACT (folded) match against a declared status's `clickup:` aliases,
 *     its label or its spaced key — FIRST, before anything else;
 *  2. the shipped exact table (`STATUS_FROM_CLICKUP`);
 *  3. the fuzzy fold, UNCHANGED: `/cancel/` still folds to `completed`, so a
 *     project that declares nothing sees no reclassification of its history.
 * A declared cancelled-kind status therefore resolves ONLY through step 1 —
 * the fuzzy chain structurally cannot return it.
 */
export function statusFromClickUp(
  remote: string | undefined | null,
  statuses: readonly StatusDef[] = DEFAULT_STATUSES,
): string {
  if (!remote) return 'todo';
  const s = foldAscii(remote);
  for (const def of statuses) {
    // Declared aliases for any status; label / spaced key only for a DECLARED
    // (non-shipped) status — a shipped key's spellings already live in the
    // exact table + fuzzy fold below, byte-identical to before.
    const aliases = [...(def.clickup ?? [])];
    if (!(def.key in STATUS_CANDIDATES)) aliases.push(def.label, def.key.replace(/_/g, ' '));
    if (aliases.some((a) => foldAscii(a) === s)) return def.key;
  }
  if (STATUS_FROM_CLICKUP[s]) return STATUS_FROM_CLICKUP[s];
  // Custom list statuses fold by intent.
  if (/review|qa|test/.test(s)) return 'in_review';
  if (/progress|doing|active|develop|started/.test(s)) return 'in_progress';
  if (/complete|done|closed|cancel/.test(s)) return 'completed';
  return 'todo';
}

// ─── Priority ──────────────────────────────────────────────────────────────

// ClickUp priorities: 1=urgent, 2=high, 3=normal, 4=low.
const PRIORITY_TO_CLICKUP: Record<string, number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
};

const PRIORITY_FROM_CLICKUP: Record<string, string> = {
  '1': 'critical',
  '2': 'high',
  '3': 'medium',
  '4': 'low',
  urgent: 'critical',
  high: 'high',
  normal: 'medium',
  low: 'low',
};

export function priorityToClickUp(priority: string): number {
  return PRIORITY_TO_CLICKUP[priority] ?? 3;
}

export function priorityFromClickUp(p: ClickUpTask['priority']): string {
  if (!p) return 'medium';
  const key = String(p.id ?? p.priority ?? '').toLowerCase();
  return PRIORITY_FROM_CLICKUP[key] ?? 'medium';
}

// ─── Tags (version rides the tags as `version:<v>`) ───────────────────────

export function tagsToClickUp(
  tags: string[],
  version: string | null,
  status?: string | null,
  statuses: readonly StatusDef[] = DEFAULT_STATUSES,
): string[] {
  const out = [...tags];
  if (version) out.push(`version:${version}`);
  // The declared sub-status rides here; shipped statuses add nothing.
  const sub = status ? subStatusTag(status, statuses) : null;
  if (sub) out.push(sub);
  return [...new Set(out)];
}

/**
 * Restore the canonical spelling of a version that round-tripped through ClickUp.
 *
 * ClickUp LOWERCASES tag names, so a version pushed as `version:S5 (Jul 13 - Jul 17)`
 * comes back as `s5 (jul 13 - jul 17)`. Every consumer compares versions exactly —
 * the sprint board's filter does `version === active` — so the round-tripped value
 * silently stops matching its own sprint and the task vanishes from the board with
 * no warning (#184/#179). Fold it back against the versions this project actually
 * knows (RELEASES.json + the active sprint); an unrecognised version is returned
 * as-is rather than guessed at.
 */
export function canonicalizeVersion(version: string | null, known: readonly string[]): string | null {
  if (!version) return null;
  const folded = foldAscii(version);
  return known.find((k) => foldAscii(k) === folded) ?? version;
}

export function tagsFromClickUp(
  remote: ClickUpTask['tags'],
  knownVersions: readonly string[] = [],
): { tags: string[]; version: string | null; project: string | null; subStatus: string | null } {
  const names = (remote ?? []).map((t) => t.name).filter(Boolean);
  const versionTag = names.find((n) => n.startsWith('version:'));
  // `version:`, `dcproject:` and `dc:` are synthetic — they ride the remote tags
  // but never live as plain local tags (version has its own field; the project
  // stamp becomes `source_project` provenance; `dc:` is the sub-status carrier).
  const plainTags = stripProjectTags(
    names.filter((n) => !n.startsWith('version:') && keyFromDcLabel(n) === null),
  );
  return {
    tags: plainTags,
    version: canonicalizeVersion(versionTag ? versionTag.slice('version:'.length) : null, knownVersions),
    project: parseProjectTag(names),
    subStatus: subStatusFromTags(names),
  };
}

// ─── Calendar dates (start_date / due_date) ──────────────────────────────────
// ClickUp's start_date and due_date are both native epoch-ms fields, so a
// single calendar-date codec serves both. The `dueDate*`/`startDate*` names
// below are thin, self-documenting aliases over the shared codec.

/** YYYY-MM-DD → ClickUp epoch-ms. UTC noon keeps the calendar day stable in any timezone. */
export function calendarDateToClickUp(date: string | null | undefined): number | null {
  if (!date) return null;
  const ms = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** ClickUp epoch-ms (string or number) → YYYY-MM-DD (UTC date part). */
export function calendarDateFromClickUp(value: string | number | null | undefined): string | null {
  const ms = serverTimeMs(value ?? null);
  return ms === null ? null : new Date(ms).toISOString().split('T')[0];
}

/** YYYY-MM-DD → ClickUp due_date epoch-ms. */
export const dueDateToClickUp = calendarDateToClickUp;
/** ClickUp due_date (epoch-ms) → YYYY-MM-DD. */
export const dueDateFromClickUp = calendarDateFromClickUp;
/** YYYY-MM-DD → ClickUp start_date epoch-ms. */
export const startDateToClickUp = calendarDateToClickUp;
/** ClickUp start_date (epoch-ms) → YYYY-MM-DD. */
export const startDateFromClickUp = calendarDateFromClickUp;

// ─── Server time ───────────────────────────────────────────────────────────

/** Parse ClickUp's epoch-ms string timestamps. Null/garbage → null. */
export function serverTimeMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── Body ↔ description ────────────────────────────────────────────────────

/**
 * The remote description is the task body WITHOUT the `## Changelog` section
 * (changelog entries live as comments — union-merged, conflict-free).
 */
export function bodyToDescription(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let inChangelog = false;
  for (const line of lines) {
    const h = line.match(/^(#{2})\s+(.+)$/);
    if (h) inChangelog = h[2].trim().toLowerCase() === 'changelog';
    if (!inChangelog) out.push(line);
  }
  return out.join('\n').trimEnd() + '\n';
}

/**
 * Split a changelog section body into its `### …` entries (top-down order).
 * Used for comment-union merging: each entry is one ClickUp comment.
 */
export function splitChangelogEntries(changelogSection: string): string[] {
  const entries: string[] = [];
  let current: string[] | null = null;
  for (const line of changelogSection.split('\n')) {
    if (/^###\s+/.test(line)) {
      if (current) entries.push(current.join('\n').trim());
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) entries.push(current.join('\n').trim());
  return entries.filter((e) => e.length > 0);
}

/** Normalize an entry for duplicate detection across comment round-trips. */
export function normalizeEntry(entry: string): string {
  return entry.replace(/\s+/g, ' ').trim();
}
