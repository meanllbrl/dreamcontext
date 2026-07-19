/**
 * Pure data layer for the Announcements / What's New feature. Dependency-free
 * (no React, no CSS, no api/client) so root Vitest (tests/unit/*.test.ts) can
 * import it directly, mirroring lineDiff.ts / recallNav.ts.
 *
 * Unread state is a SET of seen announcement ids in localStorage, not a
 * lastSeenId watermark — ids are stable but dates can be backdated, and a
 * watermark would silently mis-count an entry inserted out of order.
 */

export interface Announcement {
  id: string;
  date: string;
  title: string;
  summary: string;
  /**
   * Filename of the git-tracked Excalidraw board that IS this announcement,
   * served as a static asset from `/announcements/<board>`. Announcements are
   * landing-page-style boards (rendered by ExcalidrawPreview), not markdown.
   */
  board: string;
  version?: string;
  tags?: string[];
}

export const ANNOUNCEMENTS_SEEN_STORAGE_KEY = 'dreamcontext.dashboard.announcementsSeen';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Validate one raw entry against the required-field contract. */
function isAnnouncement(v: unknown): v is Announcement {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    isNonEmptyString(r.id) &&
    isNonEmptyString(r.date) &&
    isNonEmptyString(r.title) &&
    isNonEmptyString(r.summary) &&
    isNonEmptyString(r.board)
  );
}

/** Drop optional fields that are present but malformed, rather than the whole entry. */
function sanitizeOptional(a: Announcement): Announcement {
  const out: Announcement = { id: a.id, date: a.date, title: a.title, summary: a.summary, board: a.board };
  if (isNonEmptyString(a.version)) out.version = a.version;
  if (Array.isArray(a.tags) && a.tags.every((t) => typeof t === 'string')) out.tags = a.tags;
  return out;
}

/**
 * Validate + drop malformed entries + dedupe by id (keep first) + sort
 * newest-first. Returns [] for any non-array input (covers the SPA-fallback
 * HTML and 404-as-text cases). Never throws.
 */
export function parseAnnouncements(raw: unknown): Announcement[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const valid: Announcement[] = [];
  for (const entry of raw) {
    if (!isAnnouncement(entry)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    valid.push(sanitizeOptional(entry));
  }

  // Array.prototype.sort is stable (ES2019+), so entries with equal dates
  // keep their source-file order.
  return valid.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Announcements whose id is not in `seen`, preserving the input order. */
export function unreadAnnouncements(all: readonly Announcement[], seen: readonly string[]): Announcement[] {
  const seenSet = new Set(seen);
  return all.filter((a) => !seenSet.has(a.id));
}

/** Read the seen-id set from localStorage. Guarded; never throws. */
export function readSeenIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(ANNOUNCEMENTS_SEEN_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/** Write the seen-id set to localStorage. Guarded; never throws. */
export function writeSeenIds(ids: readonly string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ANNOUNCEMENTS_SEEN_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage unavailable — ignore
  }
}

/** Union of the previously-seen ids and every id in `all`; persists it and returns it. */
export function markAllSeen(all: readonly Announcement[]): string[] {
  const union = new Set(readSeenIds());
  for (const a of all) union.add(a.id);
  const ids = Array.from(union);
  writeSeenIds(ids);
  return ids;
}
