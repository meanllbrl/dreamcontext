/**
 * Pure dreamcontext ↔ ClickUp mapping — issue #11 field mapping table.
 * No I/O, no network: unit-testable in isolation. This is the ONLY module
 * (besides clickup.ts) allowed to know ClickUp wire shapes; nothing here may
 * leak past the backend boundary.
 */
import { foldAscii } from '../fold-ascii.js';

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
 * Map a dreamcontext status to a status the list ACCEPTS.
 * `available` = the list's status set (cached at sync time); when known and
 * no candidate exists on the list, returns null — the caller omits the field
 * rather than triggering a remote 400.
 */
export function statusToClickUp(status: string, available?: string[] | null): string | null {
  const candidates = STATUS_CANDIDATES[status] ?? STATUS_CANDIDATES.todo;
  if (!available || available.length === 0) return candidates[0];
  const folded = available.map(foldAscii);
  for (const c of candidates) {
    const i = folded.indexOf(foldAscii(c));
    if (i !== -1) return available[i]; // push the list's EXACT spelling
  }
  return null;
}

export function statusFromClickUp(remote: string | undefined | null): string {
  if (!remote) return 'todo';
  const s = foldAscii(remote);
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

export function tagsToClickUp(tags: string[], version: string | null): string[] {
  const out = [...tags];
  if (version) out.push(`version:${version}`);
  return out;
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
): { tags: string[]; version: string | null } {
  const names = (remote ?? []).map((t) => t.name).filter(Boolean);
  const versionTag = names.find((n) => n.startsWith('version:'));
  return {
    tags: names.filter((n) => !n.startsWith('version:')),
    version: canonicalizeVersion(versionTag ? versionTag.slice('version:'.length) : null, knownVersions),
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
