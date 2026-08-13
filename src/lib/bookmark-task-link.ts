import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeTaskSlug } from './task-backend/local.js';

/**
 * bookmark-task-link — the `--task` address on a bookmark: how it is defaulted,
 * and what to print when it is missing. Pure/leaf helpers (only `.active-task`
 * touches disk) so the CLI command stays thin and this stays unit-testable.
 *
 * WHY this exists at `bookmark add` time and not at sleep time: a bookmark
 * without `task_slug` is not untracked WORK — it is work whose ADDRESS was
 * never written down. Sleep can still find the task by reading the session
 * transcript, but that path is both expensive AND temporary: `sleep done` GCs
 * stale session digests ("removed 8 stale session digest(s)"), and once the
 * transcript is gone the link cannot be rebuilt at any price. The bookmark is
 * the cheap, permanent pointer. By the time sleep reports `task_slug: null` in
 * bulk, the session that knew the answer is over — so the only moment the link
 * is cheap is the moment the bookmark is written. Reported after two
 * consecutive cycles found 6 of 9 bookmarks unaddressed, every one of them for
 * work a day-old task already covered.
 *
 * The rule the skill already states ("every bookmark during task work MUST
 * include --task") lived only in prose; this module is the tool-side half.
 */

/** How many open tasks the miss-path hint names before it stops. */
export const OPEN_TASK_HINT_LIMIT = 3;

/**
 * Minimal task shape the ranker needs. Satisfied structurally by `TaskRecord`
 * / `TaskSummary` — where `name` is the SLUG (the file basename), which is what
 * `--task` takes.
 */
export interface OpenTaskRow {
  name: string;
  status: string;
  updated_at: string;
}

/**
 * The explicit session→task override: `_dream_context/state/.active-task`,
 * a plain-text file holding one task slug. Same file `snapshot` already honors
 * for active-product resolution — read here so a project that sets it never has
 * to pass `--task` by hand.
 *
 * Returns null unless the file names a path-safe slug whose task file exists:
 * a stale override must degrade to "no link + hint", never to a link pointing
 * at a task that is gone.
 */
export function readActiveTaskSlug(root: string): string | null {
  const stateDir = join(root, 'state');
  const overridePath = join(stateDir, '.active-task');
  if (!existsSync(overridePath)) return null;
  try {
    const slug = readFileSync(overridePath, 'utf-8').trim();
    if (!slug || !isSafeTaskSlug(slug)) return null;
    if (!existsSync(join(stateDir, `${slug}.md`))) return null;
    return slug;
  } catch {
    return null;
  }
}

/**
 * One sortable, readable day. Frontmatter dates arrive quoted (`'2026-08-11'`)
 * from every file the CLI writes, but a hand-written unquoted one is parsed by
 * YAML into a Date and stringifies to `Tue Aug 11 2026 03:00:00 GMT+0300…` —
 * which neither reads in a column nor compares correctly against an ISO string.
 * js-yaml anchors a bare date at UTC midnight, so the day is recovered in UTC —
 * formatting it in local time would shift `2026-08-11` back a day west of
 * Greenwich.
 */
export function shortDate(value: string): string {
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

/**
 * Rank the open tasks a missing `--task` most likely meant: `in_progress`
 * first, then most recently touched. `completed` is dropped — same visibility
 * rule as bare `tasks list`, so what the hint offers is exactly what that
 * command would have shown.
 */
export function rankOpenTasks<T extends OpenTaskRow>(tasks: T[], limit = OPEN_TASK_HINT_LIMIT): T[] {
  const statusRank = (s: string): number => (s.toLowerCase() === 'in_progress' ? 0 : 1);
  return tasks
    .filter((t) => String(t.status).toLowerCase() !== 'completed')
    .sort(
      (a, b) =>
        statusRank(String(a.status)) - statusRank(String(b.status))
        || shortDate(b.updated_at).localeCompare(shortDate(a.updated_at)),
    )
    .slice(0, Math.max(0, limit));
}

export interface UnlinkedHintInput {
  /** Id of the bookmark just written — the `relink` handle for repairing it. */
  bookmarkId: string;
  /** Ranked + capped candidates (see {@link rankOpenTasks}). */
  candidates: OpenTaskRow[];
  /** Total open tasks, which may exceed `candidates.length`. */
  openCount: number;
}

/**
 * The miss-path advisory, as plain lines (the caller colorizes and picks the
 * stream). Empty when there is no open task to point at — with nothing to link
 * to, a missing `--task` is not a mistake and the command stays silent.
 *
 * Never blocks: the bookmark is already written when this prints, and the exit
 * code stays 0. A bookmark that survives with a warning beats a bookmark that
 * a non-zero exit talked the agent out of writing at all.
 */
export function unlinkedBookmarkHint(input: UnlinkedHintInput): string[] {
  const { bookmarkId, candidates, openCount } = input;
  if (candidates.length === 0 || openCount === 0) return [];

  const noun = openCount === 1 ? 'open task' : 'open tasks';
  const lines = [`Bookmark saved with no task link — this project has ${openCount} ${noun}.`];

  const slugWidth = Math.max(...candidates.map((t) => t.name.length));
  const statusWidth = Math.max(...candidates.map((t) => String(t.status).length));
  for (const t of candidates) {
    lines.push(
      `    ${t.name.padEnd(slugWidth)}  ${String(t.status).padEnd(statusWidth)}  ${shortDate(t.updated_at)}`,
    );
  }
  if (openCount > candidates.length) {
    lines.push(`    … ${openCount - candidates.length} more — dreamcontext tasks list`);
  }

  lines.push(`  Link this one:  dreamcontext bookmark relink ${bookmarkId} --task <slug>`);
  lines.push('  Next time:      dreamcontext bookmark add "…" -s 2 --task <slug>');
  return lines;
}

/**
 * Resolve a bookmark id the way a human types it back from `bookmark list`:
 * exact id, else a unique prefix (`bm_ab12` for `bm_ab12cd34`). Ambiguous
 * prefixes resolve to nothing and surface their candidates instead of guessing.
 */
export function resolveBookmarkId(
  ids: string[],
  input: string,
): { kind: 'match'; id: string } | { kind: 'ambiguous'; candidates: string[] } | { kind: 'none' } {
  const raw = input.trim();
  if (!raw) return { kind: 'none' };
  if (ids.includes(raw)) return { kind: 'match', id: raw };

  const prefixed = ids.filter((id) => id.startsWith(raw));
  if (prefixed.length === 1) return { kind: 'match', id: prefixed[0] };
  if (prefixed.length > 1) return { kind: 'ambiguous', candidates: prefixed };
  return { kind: 'none' };
}
