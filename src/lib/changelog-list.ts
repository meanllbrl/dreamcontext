/** The fields this module reads — CHANGELOG.json rows are open records. */
export type ChangelogEntry = Record<string, unknown>;

/**
 * Paginated, filterable CHRONOLOGICAL access to `core/CHANGELOG.json`.
 *
 * `memory recall --types changelog` answers "where did we do X?" (relevance-
 * ranked); this answers "what happened, in order?" — the LIFO browse the
 * snapshot's Recent Changelog can only show the head of (owner ask
 * 2026-07-30: the agent must be able to search AND page through the history).
 * Pure function: the CLI command is a thin printer around it.
 */
export interface ChangelogListOptions {
  /** 1-based page. Values < 1 clamp to 1; past the end returns an empty page
   *  with honest totals (never throws). */
  page?: number;
  /** Entries per page. Default 10, clamped to [1, 50]. */
  size?: number;
  /** Exact `type` filter (feat/fix/change/chore/note/…). */
  type?: string;
  /** Exact `scope` filter. */
  scope?: string;
  /** Case-insensitive substring over summary + description + scope. */
  grep?: string;
}

export interface ChangelogPage {
  entries: ChangelogEntry[];
  /** Total entries AFTER filtering. */
  total: number;
  page: number;
  pages: number;
  size: number;
}

export function listChangelogEntries(
  all: ChangelogEntry[],
  opts: ChangelogListOptions = {},
): ChangelogPage {
  const size = Math.min(50, Math.max(1, Math.trunc(opts.size ?? 10)));
  const page = Math.max(1, Math.trunc(opts.page ?? 1));

  const grep = opts.grep?.toLowerCase();
  const filtered = all.filter((e) => {
    if (opts.type && String(e.type ?? '') !== opts.type) return false;
    if (opts.scope && String(e.scope ?? '') !== opts.scope) return false;
    if (grep) {
      const haystack = `${String(e.summary ?? '')}\n${String(e.description ?? '')}\n${String(e.scope ?? '')}`
        .toLowerCase();
      if (!haystack.includes(grep)) return false;
    }
    return true;
  });

  const pages = Math.max(1, Math.ceil(filtered.length / size));
  return {
    entries: filtered.slice((page - 1) * size, page * size),
    total: filtered.length,
    page,
    pages,
    size,
  };
}
