import { slugify } from './id.js';

/**
 * Per-person attribution of git commits to a known roster.
 *
 * Pure, side-effect-free. The orchestrator collects the cycle's commits (from
 * `git log`) and the detected `people` roster, then hands both to this helper so
 * each specialist can report who drove which change. A person is identified by a
 * kebab-case slug (`slugify(name)`), the same slug used in `person:<slug>` task
 * tags and changelog `authors`.
 */

/** A single git commit, as much as attribution needs. */
export interface Commit {
  /** Commit hash (short or full). */
  hash: string;
  /** Git author name (e.g. "Mehmet Nuraydın") or email — matched by slug. */
  author: string;
  /** Commit subject line. */
  subject: string;
}

/**
 * Bot authors whose commits are never attributed to a human. Matched
 * case-insensitively as a substring of the kebab-case author slug, so
 * "github-actions[bot]", "dependabot[bot]", "dependabot-preview" all drop.
 */
const BOT_SLUG_FRAGMENTS = ['github-actions', 'dependabot'] as const;

/** True iff this author slug belongs to a known CI/dependency bot. */
function isBotAuthor(authorSlug: string): boolean {
  return BOT_SLUG_FRAGMENTS.some((frag) => authorSlug.includes(frag));
}

/**
 * Bucket `commits` by the roster person who authored them.
 *
 * - Each roster name maps to its `slugify(name)` slug; a commit is attributed to
 *   a person when the commit's author slug equals that person's slug.
 * - Bot commits (github-actions / dependabot) are filtered out entirely.
 * - Commits whose author is not in the roster are dropped (no phantom buckets).
 * - The returned record always has one (possibly empty) array per roster slug,
 *   so callers can report 0-commit people without special-casing.
 *
 * Returns a fresh record; inputs are not mutated.
 */
export function attributeByPerson(
  commits: Commit[],
  roster: string[],
): Record<string, Commit[]> {
  // Map roster slug -> bucket, seeded empty so every roster member is present.
  const result: Record<string, Commit[]> = {};
  const rosterSlugs = new Set<string>();
  for (const name of roster) {
    const slug = slugify(name);
    if (!slug) continue;
    rosterSlugs.add(slug);
    if (!(slug in result)) result[slug] = [];
  }

  for (const commit of commits) {
    const authorSlug = slugify(commit.author);
    if (!authorSlug) continue;
    if (isBotAuthor(authorSlug)) continue;
    if (!rosterSlugs.has(authorSlug)) continue;
    result[authorSlug].push(commit);
  }

  return result;
}
