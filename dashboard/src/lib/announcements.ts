/**
 * Pure data layer for the Announcements / What's New feature. Dependency-free
 * (no React, no CSS, no api/client) so root Vitest (tests/unit/*.test.ts) can
 * import it directly, mirroring recallNav.ts.
 *
 * Unread state is a SET of seen announcement ids in localStorage, not a
 * lastSeenId watermark — ids are stable but dates can be backdated, and a
 * watermark would silently mis-count an entry inserted out of order.
 *
 * ONE ANNOUNCEMENT PER VERSION (since 0.22). The feed is a version history, not
 * a feature stream: `version` is required and unique, so "what did 0.18 give
 * me?" has exactly one answer. A version that shipped three things gets three
 * BLOCKS in one story, not three entries. `parseAnnouncements` enforces it.
 */

export interface Announcement {
  id: string;
  date: string;
  title: string;
  summary: string;
  /**
   * Filename of the git-tracked story document that IS this announcement,
   * served as a static asset from `/announcements/<story>`. A story is a JSON
   * landing page — screenshots plus short copy, rendered by `AnnouncementStory`
   * (see `announcementStory.ts`). It replaced the Excalidraw board format in
   * 0.22: a board had to be panned and zoomed to read and could only ever draw
   * a picture OF the product; a story shows the product.
   */
  story: string;
  /**
   * The release this story announces, e.g. `0.22.0` — REQUIRED, and unique
   * across the feed. It is the announcement's real identity: the UI leads with
   * it, and a second entry claiming the same version is dropped by
   * `parseAnnouncements`. Stored bare (no `v`); render it via `formatVersion`.
   */
  version: string;
  /**
   * Other released versions this story ALSO speaks for, bare like `version`.
   *
   * The feed is a release history, so a version that shipped and is named
   * nowhere is a hole in it — that is how 0.24.1 (npm's `latest` for ten days)
   * came to be announced by nothing at all. But not every patch earns its own
   * page: 0.23.1 carried the never-published 0.22.0, and folding it into one
   * story was the honest call, not a gap.
   *
   * `covers` is what tells those two cases apart. A fold is a CLAIM the story
   * makes and the coverage test checks; silence is a bug. Listing a version here
   * means "read this page to learn what that release gave you" — so the story
   * body has to actually cover it.
   */
  covers?: string[];
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
    isNonEmptyString(r.story) &&
    isNonEmptyString(r.version)
  );
}

/** Drop optional fields that are present but malformed, rather than the whole entry. */
function sanitizeOptional(a: Announcement): Announcement {
  const out: Announcement = {
    id: a.id,
    date: a.date,
    title: a.title,
    summary: a.summary,
    story: a.story,
    version: a.version,
  };
  if (Array.isArray(a.covers) && a.covers.every((c) => typeof c === 'string' && c.length > 0)) {
    out.covers = a.covers;
  }
  if (Array.isArray(a.tags) && a.tags.every((t) => typeof t === 'string')) out.tags = a.tags;
  return out;
}

/** `0.22.0` / `v0.22.0` / `V0.22.0` all render as `v0.22.0`. */
export function formatVersion(version: string): string {
  return /^v/i.test(version) ? `v${version.slice(1)}` : `v${version}`;
}

/**
 * Validate + drop malformed entries + sort newest-first + collapse to ONE entry
 * per version (and per id). Returns [] for any non-array input (covers the
 * SPA-fallback HTML and 404-as-text cases). Never throws.
 *
 * Sorting happens BEFORE deduping so "which duplicate survives" is a property of
 * the content, not of the file: the newest-dated entry for a version wins, and
 * same-date ties fall back to source order (Array.prototype.sort is stable,
 * ES2019+). Versions are compared normalized, so `0.22.0` and `v0.22.0` are the
 * same release rather than two entries for it.
 */
export function parseAnnouncements(raw: unknown): Announcement[] {
  if (!Array.isArray(raw)) return [];

  const valid: Announcement[] = [];
  for (const entry of raw) {
    if (!isAnnouncement(entry)) continue;
    valid.push(sanitizeOptional(entry));
  }

  valid.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const seenIds = new Set<string>();
  const seenVersions = new Set<string>();
  const out: Announcement[] = [];
  for (const entry of valid) {
    const version = formatVersion(entry.version);
    if (seenIds.has(entry.id) || seenVersions.has(version)) continue;
    seenIds.add(entry.id);
    seenVersions.add(version);
    out.push(entry);
  }
  return out;
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
