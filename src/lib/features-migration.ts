import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, writeFrontmatter } from './frontmatter.js';
import { today } from './id.js';
import { FEATURES_TYPE, featuresDir } from './features-path.js';

export const OLD_FEATURES_DIR = join('core', 'features');
export const NEW_FEATURES_DIR = join('knowledge', 'features');

export interface FeatureMigrationResult {
  /** Slugs whose source moved to knowledge/features/ this run (cases N, E, and
   *  already-present S sources that were unlinked). */
  migrated: string[];
  /** Slugs already fully valid at the destination (case S) — source unlinked. */
  skipped: string[];
  /** Slugs that could NOT be moved this run (torn/divergent dest, or a
   *  write/verify/unlink error). Non-empty signals a partial run. */
  failed: Array<{ slug: string; error: string }>;
}

/**
 * Enrich a feature PRD's frontmatter for its new home under knowledge/features/.
 * Pure. Adds the knowledge-index fields (`type: feature`, `name`, `description`,
 * `pinned`, `date`) while preserving every other feature field verbatim
 * (status, progress, released_version, related_tasks, id, created, updated, tags).
 *
 * Contract invariants (source-derived, deterministic):
 *  - `type` is always 'feature'.
 *  - `name`/`description` from existing values, defaulting to slug / '' when absent.
 *  - `pinned` is ALWAYS forced false — a feature is never auto-pinned on migrate.
 *  - `date` from existing date, else created, else today().
 */
export function enrichFeatureFrontmatter(
  data: Record<string, unknown>,
  slug: string,
): Record<string, unknown> {
  return {
    ...data,
    type: FEATURES_TYPE,
    name: data.name ?? slug,
    description: data.description ?? '',
    pinned: false,
    date: data.date ?? data.created ?? today(),
  };
}

/** True when `data` meets the §1.2 knowledge-feature contract (defensive). */
function meetsContract(data: Record<string, unknown>): boolean {
  return (
    data.type === FEATURES_TYPE &&
    typeof data.name === 'string' &&
    data.name.trim() !== '' &&
    data.pinned === false &&
    data.date != null &&
    String(data.date).trim() !== ''
  );
}

/** Atomically write a markdown file: tmp + renameSync (crash-safe, local to
 *  this migration — the shared writeFrontmatter stays non-atomic). */
function atomicWriteFrontmatter(
  dest: string,
  data: Record<string, unknown>,
  content: string,
): void {
  const tmp = dest + '.tmp';
  writeFrontmatter(tmp, data, content);
  renameSync(tmp, dest);
}

/** Re-read a just-written dest and assert it parses, meets the contract, and
 *  its parsed body equals the source's parsed body. Never throws. */
function verifyDest(destPath: string, sourceContent: string): boolean {
  try {
    const { data, content } = readFrontmatter<Record<string, unknown>>(destPath);
    return meetsContract(data) && content === sourceContent;
  } catch {
    return false;
  }
}

/**
 * Migrate `core/features/*.md` → `knowledge/features/*.md` as typed knowledge.
 *
 * Two-phase and crash-safe; NEVER throws (all failures collected into `failed`):
 *  - Phase 1: sweep stray *.tmp, then write+verify EVERY destination (no source
 *    deletion). Each source is classified against the deterministic N/T/D/E/S
 *    branch table below.
 *  - Phase 2: unlink only the sources whose dest verifiably passed this run,
 *    then rmdir the (now-empty) source dir ONLY when nothing failed.
 *
 * Branch table (dest = knowledge/features/<slug>.md):
 *  N  no dest              → atomic write enriched source, verify → migrated
 *  T  dest unparseable     → leave both, never write        → failed (torn)
 *  D  parses, body differs → leave both, never write        → failed (divergent)
 *  E  body matches, under-enriched frontmatter → re-enrich inline (atomic,
 *                            frontmatter only) → migrated
 *  S  fully valid          → no write                       → skipped
 *
 * Body-equality ALWAYS compares parsed bodies (matter().content), never raw
 * bytes — writeFrontmatter cosmetically re-serializes YAML.
 */
export function migrateFeaturesToKnowledge(contextRoot: string): FeatureMigrationResult {
  const result: FeatureMigrationResult = { migrated: [], skipped: [], failed: [] };

  const oldDir = join(contextRoot, OLD_FEATURES_DIR);
  if (!existsSync(oldDir)) return result;

  const sources = fg.sync('*.md', { cwd: oldDir, absolute: true });
  if (sources.length === 0) return result;

  const newDir = featuresDir(contextRoot);
  try {
    mkdirSync(newDir, { recursive: true });
  } catch (err) {
    // Cannot even create the destination dir (knowledge/features exists as a
    // regular file, EROFS, EACCES, ...). Report as a clean partial failure —
    // never throw — so the caller sees failedCount > 0 instead of a hard abort
    // that would skip notice queueing upstream. No source has been touched.
    result.failed.push({ slug: '*', error: `cannot create knowledge/features: ${errText(err)}` });
    return result;
  }

  // Phase 1a — sweep stray *.tmp left by a crashed prior run.
  for (const tmp of fg.sync('*.tmp', { cwd: newDir, absolute: true })) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort — a leftover tmp never fails the migration */
    }
  }

  // Phase 1b — write + verify all dests; stage verified sources for unlink.
  const staged: Array<{ slug: string; sourcePath: string; kind: 'migrated' | 'skipped' }> = [];

  for (const sourcePath of sources) {
    const slug = basename(sourcePath, '.md');
    const destPath = join(newDir, `${slug}.md`);

    let sourceData: Record<string, unknown>;
    let sourceContent: string;
    try {
      const parsed = readFrontmatter<Record<string, unknown>>(sourcePath);
      sourceData = parsed.data;
      sourceContent = parsed.content;
    } catch (err) {
      result.failed.push({ slug, error: `unreadable source: ${errText(err)}` });
      continue;
    }

    if (!existsSync(destPath)) {
      // Case N — fresh write of enriched source.
      try {
        atomicWriteFrontmatter(destPath, enrichFeatureFrontmatter(sourceData, slug), sourceContent);
      } catch (err) {
        result.failed.push({ slug, error: `write failed: ${errText(err)}` });
        continue;
      }
      if (verifyDest(destPath, sourceContent)) {
        staged.push({ slug, sourcePath, kind: 'migrated' });
      } else {
        result.failed.push({ slug, error: 'dest failed verification after write' });
      }
      continue;
    }

    // Dest exists — classify T / D / E / S.
    let destData: Record<string, unknown>;
    let destContent: string;
    try {
      const parsed = readFrontmatter<Record<string, unknown>>(destPath);
      destData = parsed.data;
      destContent = parsed.content;
    } catch {
      // Case T — torn/foreign dest.
      result.failed.push({
        slug,
        error: 'torn/foreign dest — inspect & delete dest manually, then re-run',
      });
      continue;
    }

    if (destContent !== sourceContent) {
      // Case D — divergent body. Never clobber either side.
      result.failed.push({
        slug,
        error: 'divergent dest — human must reconcile; migration will never clobber either side',
      });
      continue;
    }

    if (meetsContract(destData)) {
      // Case S — already migrated and valid.
      staged.push({ slug, sourcePath, kind: 'skipped' });
      continue;
    }

    // Case E — body matches, frontmatter under-enriched. Re-enrich inline
    // (frontmatter only; body is the source body, so equality is preserved).
    try {
      atomicWriteFrontmatter(destPath, enrichFeatureFrontmatter(sourceData, slug), sourceContent);
    } catch (err) {
      result.failed.push({ slug, error: `re-enrich write failed: ${errText(err)}` });
      continue;
    }
    if (verifyDest(destPath, sourceContent)) {
      staged.push({ slug, sourcePath, kind: 'migrated' });
    } else {
      result.failed.push({ slug, error: 'dest failed verification after re-enrich' });
    }
  }

  // Phase 2 — unlink verified sources, finalize classification.
  for (const { slug, sourcePath, kind } of staged) {
    try {
      unlinkSync(sourcePath);
    } catch (err) {
      // ENOENT = the source is already gone (a concurrent update/sleep run
      // unlinked it after we verified the same dest). That is the desired end
      // state, not a failure — counting it would spuriously pin setupVersion.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.failed.push({ slug, error: `source unlink failed: ${errText(err)}` });
        continue;
      }
    }
    if (kind === 'migrated') result.migrated.push(slug);
    else result.skipped.push(slug);
  }

  // rmdir the source dir only after a fully clean run.
  if (result.failed.length === 0) {
    try {
      if (existsSync(oldDir) && readdirSync(oldDir).length === 0) {
        rmdirSync(oldDir);
      }
    } catch {
      /* an rmdir failure never fails the migration */
    }
  }

  return result;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
