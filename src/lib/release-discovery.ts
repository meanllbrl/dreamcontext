import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';
import { readJsonArray } from './json-file.js';
import { featuresDir, featureSlug } from './features-path.js';

export interface ChangelogEntry {
  date: string;
  type: string;
  scope: string;
  description: string;
  breaking: boolean;
  /**
   * Optional ≤200-char one-liner used by the snapshot's Recent Changelog
   * section. When absent, the snapshot truncates `description`. Backwards
   * compatible — older entries without `summary` continue to work.
   */
  summary?: string;
  /**
   * Optional references that pin the entry to concrete artifacts. Flat string
   * array with prefix convention: `commit:<sha>`, `file:<path>`, `knowledge:<slug>`,
   * `feature:<slug>`, `task:<slug>`, `url:<href>`. No `note:` escape hatch —
   * free-form text belongs in `description`.
   */
  references?: string[];
  /**
   * Optional roster of people involved in this change (kebab-case display-name
   * slugs, e.g. `kerem`, `ada`). The unified person-attribution carrier — the
   * SAME field used by `memory remember --person`. Backwards compatible: entries
   * without `authors` keep working, and `authors` is DELIBERATELY EXCLUDED from
   * `changelogFingerprint` so adding/removing it never changes dedup identity
   * (no spurious "unreleased" entries).
   */
  authors?: string[];
  /**
   * Optional pointer to a prior entry this one supersedes (e.g.,
   * `<date>|<scope>` or a coarser "{date}-{scope}" key). Used when a later
   * decision reverses or replaces an earlier one and the LIFO chain matters.
   * Captures the meta-annotation semantic the old 2.memory.md LIFO carried.
   */
  supersedes?: string | null;
}

export interface ReleaseEntry {
  id: string;
  version: string;
  date: string;
  summary: string;
  breaking: boolean;
  status: 'planning' | 'released';
  features: string[];
  tasks: string[];
  changelog: ChangelogEntry[];
  /**
   * People who contributed to this release (kebab-case person slugs), derived at
   * record time from the swept changelog `authors` ∪ the swept tasks' `person:`
   * tags — see `deriveContributors` in `attribution.ts`. OMITTED when empty
   * (never `[]`), so a vault with no roster records byte-identical releases to
   * pre-0.23.0. Only `status: 'released'` entries carry it: a planning version
   * has no contributors yet.
   */
  contributors?: string[];
  /**
   * The cycles the swept tasks were planned in (`cy_<id>`), linked at record
   * time. A release is an outcome, not a plan: it is compiled from what closed,
   * and this only says which time boxes the work came from. Omitted when empty.
   */
  cycles?: string[];
}

export interface UnreleasedTask {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** The cycle the task was planned in, when it carries one. */
  cycle?: string | null;
}

export interface UnreleasedFeature {
  id: string;
  slug: string;
  status: string;
}

export interface UnreleasedChangelog {
  index: number;
  entry: ChangelogEntry;
}

function changelogFingerprint(entry: ChangelogEntry): string {
  return `${entry.date}|${entry.type}|${entry.scope}|${entry.description}`;
}

export function getExistingReleases(root: string): ReleaseEntry[] {
  const releasesPath = join(root, 'core', 'RELEASES.json');
  if (!existsSync(releasesPath)) return [];
  try {
    const entries = readJsonArray<ReleaseEntry>(releasesPath);
    // Backward compat: entries without status default to 'released'
    for (const entry of entries) {
      if (!entry.status) entry.status = 'released';
    }
    return entries;
  } catch {
    return [];
  }
}

export function getLastRelease(root: string): ReleaseEntry | null {
  const releases = getExistingReleases(root);
  return releases.length > 0 ? releases[0] : null;
}

/**
 * The date of the most recent published release (status released, not
 * superseded, with a date), or null when nothing has been released yet.
 */
export function previousReleaseDate(root: string): string | null {
  let latest: string | null = null;
  for (const r of getExistingReleases(root)) {
    const status = String(r.status);
    if (status === 'planning' || status === 'superseded') continue;
    if (typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && (latest === null || r.date > latest)) latest = r.date;
  }
  return latest;
}

/**
 * Completed tasks no release has swept yet. With `since`, only those that
 * closed on or after that date (the previous release's): a release is compiled
 * from what closed since the one before it. The closing day is the card's
 * `updated_at` (completion stamps it), else its `due_date`.
 */
export function findUnreleasedTasks(root: string, opts: { since?: string | null } = {}): UnreleasedTask[] {
  const releases = getExistingReleases(root);
  const releasedTaskIds = new Set(releases.flatMap(r => r.tasks ?? []));
  const since = opts.since ?? null;

  const stateDir = join(root, 'state');
  if (!existsSync(stateDir)) return [];

  const files = fg.sync('*.md', { cwd: stateDir, absolute: true });
  const result: UnreleasedTask[] = [];

  for (const file of files) {
    try {
      const { data } = readFrontmatter<Record<string, unknown>>(file);
      if (data.status !== 'completed') continue;
      const id = String(data.id ?? '');
      if (releasedTaskIds.has(id)) continue;
      if (since) {
        const closed = String(data.updated_at ?? data.due_date ?? '');
        if (closed && closed < since) continue;
      }
      const cycle = typeof data.cycle === 'string' && data.cycle.trim() ? data.cycle.trim() : null;
      result.push({
        id,
        slug: basename(file, '.md'),
        name: String(data.name ?? basename(file, '.md')),
        description: String(data.description ?? ''),
        ...(cycle ? { cycle } : {}),
      });
    } catch { /* skip unreadable */ }
  }
  return result;
}

export function findUnreleasedFeatures(root: string): UnreleasedFeature[] {
  const dir = featuresDir(root);
  if (!existsSync(dir)) return [];

  // Recurse so features grouped into topical/product subfolders are covered.
  const files = fg.sync('**/*.md', { cwd: dir, absolute: true });
  const result: UnreleasedFeature[] = [];

  for (const file of files) {
    try {
      const { data } = readFrontmatter<Record<string, unknown>>(file);
      if (data.released_version !== null && data.released_version !== undefined) continue;
      result.push({
        id: String(data.id ?? ''),
        slug: featureSlug(dir, file),
        status: String(data.status ?? 'planning'),
      });
    } catch { /* skip */ }
  }
  return result;
}

export function findUnreleasedChangelog(root: string): UnreleasedChangelog[] {
  const releases = getExistingReleases(root);
  const releasedFingerprints = new Set<string>();
  for (const rel of releases) {
    for (const entry of rel.changelog ?? []) {
      releasedFingerprints.add(changelogFingerprint(entry));
    }
  }

  const changelogPath = join(root, 'core', 'CHANGELOG.json');
  if (!existsSync(changelogPath)) return [];

  try {
    const entries = readJsonArray<ChangelogEntry>(changelogPath);
    const result: UnreleasedChangelog[] = [];
    for (let i = 0; i < entries.length; i++) {
      const fp = changelogFingerprint(entries[i]);
      if (!releasedFingerprints.has(fp)) {
        result.push({ index: i, entry: entries[i] });
      }
    }
    return result;
  } catch {
    return [];
  }
}
