/**
 * Project provenance for synced tasks — #177.
 *
 * A shared remote container (a ClickUp list two projects both sync, a GitHub
 * repo two brains both track) pulls EVERY row into EVERY project's mirror,
 * indistinguishable from native tasks. A `completed` row describing work done
 * in a SIBLING repo then reads as "already done here" and can silently drop a
 * whole local work group.
 *
 * The fix is a provenance stamp that rides the sync round-trip:
 *   - Each project has a stable, lowercase, slug-safe {@link projectScopeId}.
 *   - On PUSH the backend stamps its rows with `dcproject:<id>` (a tag, exactly
 *     like `version:` and `person:` ride the tags).
 *   - On PULL a row whose stamp names ANOTHER project is recorded with a
 *     `source_project` frontmatter field, so it is visibly foreign in the
 *     snapshot and `tasks list`. An optional per-project SCOPE filter skips
 *     importing those foreign rows at all.
 *
 * Rows with no stamp (created directly in the provider UI, or pushed before
 * this shipped) are treated as native — the stamp only ever ADDS a foreign
 * marker, never removes trust from an unstamped row, so this is a strict
 * improvement with no false positives on legacy data.
 *
 * Pure module — no I/O, no network. Unit-testable in isolation.
 */
import { slugify } from '../id.js';
import type { SetupConfig } from '../setup-config.js';

/** Synthetic tag prefix carrying the owning project's {@link projectScopeId}. */
export const PROJECT_TAG_PREFIX = 'dcproject:';

/**
 * Parse `owner/repo` out of a canonical GitHub remote so a project's identity
 * can key off the code repo it governs. Inlined (not imported from git-sync) to
 * keep this module pure and dependency-light.
 */
function repoSlugFromUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const httpsMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (httpsMatch) return `${httpsMatch[1]}-${httpsMatch[2]}`;
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) return `${shortMatch[1]}-${shortMatch[2]}`;
  return null;
}

/**
 * The stable identity for THIS project's synced rows. Resolution order:
 *   1. An explicit `projectId` in `.config.json` (the escape hatch — a team can
 *      pin a value so it survives a folder rename or a repo move).
 *   2. The first `linkedRepos` canonical GitHub URL → `owner-repo` (shared
 *      across the team via `.config.json`, so every teammate derives the same
 *      id without extra config).
 *   3. The project directory basename (always present, machine-local — a last
 *      resort so provenance still works with zero configuration).
 *
 * Slugified so the value is lowercase and slug-safe: ClickUp LOWERCASES every
 * tag name, so a stamp that isn't already lowercase would not round-trip and
 * two runs would disagree on their own identity.
 */
export function projectScopeId(config: SetupConfig | null, projectRoot: string): string | null {
  const explicit = config?.projectId?.trim();
  if (explicit) return slugify(explicit) || null;

  const repoUrl = config?.linkedRepos?.[0]?.gitRemoteUrl;
  if (repoUrl) {
    const slug = repoSlugFromUrl(repoUrl);
    if (slug) return slugify(slug) || null;
  }

  const base = projectRoot.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  return slugify(base) || null;
}

/** The stamp tag for a project id (e.g. `dcproject:acme-api`). */
export function projectTag(id: string): string {
  return `${PROJECT_TAG_PREFIX}${id}`;
}

/**
 * Extract the owning project id from a task's remote tags, or null when the row
 * carries no stamp. Case-insensitive on the prefix, and the value is folded to
 * lowercase so a comparison against {@link projectScopeId} is round-trip-safe.
 */
export function parseProjectTag(tagNames: readonly string[]): string | null {
  const tag = tagNames.find((n) => n.toLowerCase().startsWith(PROJECT_TAG_PREFIX));
  if (!tag) return null;
  const value = tag.slice(PROJECT_TAG_PREFIX.length).trim().toLowerCase();
  return value || null;
}

/** Drop every `dcproject:` stamp from a tag list (they never live as plain local tags). */
export function stripProjectTags(tagNames: readonly string[]): string[] {
  return tagNames.filter((n) => !n.toLowerCase().startsWith(PROJECT_TAG_PREFIX));
}

/**
 * The provenance a pulled row should carry: null when the row is native to THIS
 * project (unstamped, or stamped with our own id) and the foreign id when it
 * belongs to another project. Comparison folds case because both sides are
 * already lowercase slugs — belt-and-braces against a hand-edited config.
 */
export function foreignProjectOf(
  remoteTags: readonly string[],
  myId: string | null,
): string | null {
  const stamp = parseProjectTag(remoteTags);
  if (!stamp) return null;
  if (myId && stamp === myId.toLowerCase()) return null;
  return stamp;
}
