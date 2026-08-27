import { join } from 'node:path';
import { existsSync } from 'node:fs';
import fg from 'fast-glob';
import { slugify } from './id.js';
import { readFrontmatter } from './frontmatter.js';

/**
 * Per-person attribution — commits to a roster, and a release to its people.
 *
 * A person is identified by a kebab-case slug (`slugify(name)`), the same slug
 * used in `person:<slug>` task tags, changelog `authors`, and the
 * `people/people.json` roster.
 *
 * `attributeByPerson` is pure. `deriveContributors` reads the vault's task files
 * (it needs the `person:` tags behind a release's task ids) — the one impure
 * export, and it never writes.
 */

/** A single git commit, as much as attribution needs. */
export interface Commit {
  /** Commit hash (short or full). */
  hash: string;
  /** Git author name (e.g. "Kerem Yılmaz") or email — matched by slug. */
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

/** The `person:<slug>` tag prefix — the single carrier of task assignment. */
const PERSON_TAG_PREFIX = 'person:';

/**
 * Collect the `person:<slug>` tags of the tasks named by `taskIds`.
 *
 * Tasks are addressed by frontmatter `id` (that is what a release records), so
 * this scans `state/*.md` once and keeps the ones whose id was asked for.
 * Unreadable files are skipped — a release must never fail to record because one
 * task file is malformed.
 */
function personTagsForTasks(contextRoot: string, taskIds: string[]): string[] {
  const wanted = new Set(taskIds.filter(Boolean));
  if (wanted.size === 0) return [];
  const stateDir = join(contextRoot, 'state');
  if (!existsSync(stateDir)) return [];

  const out: string[] = [];
  for (const file of fg.sync('*.md', { cwd: stateDir, absolute: true })) {
    try {
      const { data } = readFrontmatter<Record<string, unknown>>(file);
      if (!wanted.has(String(data.id ?? ''))) continue;
      const tags = Array.isArray(data.tags) ? data.tags : [];
      for (const tag of tags) {
        const value = String(tag).trim();
        if (value.startsWith(PERSON_TAG_PREFIX)) out.push(value.slice(PERSON_TAG_PREFIX.length).trim());
      }
    } catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * The people behind a release: the union of its changelog entries' `authors`
 * and its tasks' `person:<slug>` tags (D11).
 *
 * Bots are dropped (`github-actions`, `dependabot` — the same filter
 * `attributeByPerson` uses: a CI account is not a contributor), blanks are
 * dropped, the result is deduped and sorted so two machines recording the same
 * release produce the same list.
 *
 * Returns `[]` when there is nothing to attribute — callers OMIT the
 * `contributors` key entirely rather than writing an empty array, which is what
 * keeps a rosterless vault's releases byte-identical to pre-0.23.0 (D18).
 */
export function deriveContributors(
  contextRoot: string,
  input: { changelogEntries: Array<{ authors?: string[] }>; taskIds: string[] },
): string[] {
  const candidates: string[] = [];
  for (const entry of input.changelogEntries) {
    for (const author of entry.authors ?? []) candidates.push(String(author));
  }
  candidates.push(...personTagsForTasks(contextRoot, input.taskIds));

  const seen = new Set<string>();
  for (const raw of candidates) {
    const slug = raw.trim();
    if (!slug) continue;
    if (isBotAuthor(slug.toLowerCase())) continue;
    seen.add(slug);
  }
  return [...seen].sort();
}
