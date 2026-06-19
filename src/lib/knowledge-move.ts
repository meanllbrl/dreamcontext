import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import { rewriteWikilinks, WikilinkRemap } from './wikilink-rewrite.js';

export type KnowledgeMoveFailure =
  | 'unsafe-slug'
  | 'unsafe-folder'
  | 'not-found'
  | 'already-there'
  | 'dest-exists'
  | 'move-failed';

export interface KnowledgeMoveSuccess {
  ok: true;
  /** Source slug (path relative to knowledge/, without .md). */
  oldSlug: string;
  /** Destination slug (`<folder>/<basename>`). */
  newSlug: string;
  /** Source path relative to contextRoot (e.g. `knowledge/fitness-blueprint.md`). */
  oldPath: string;
  /** Destination path relative to contextRoot (e.g. `knowledge/fitness/fitness-blueprint.md`). */
  newPath: string;
  /** Absolute paths of files whose inbound [[wikilinks]] were rewritten. */
  wikilinksRewritten: string[];
}

export interface KnowledgeMoveError {
  ok: false;
  code: KnowledgeMoveFailure;
  message: string;
}

export type KnowledgeMoveResult = KnowledgeMoveSuccess | KnowledgeMoveError;

/** Strip `.md`, normalise separators, trim leading/trailing slashes + whitespace. */
function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

/** Normalise a destination folder: separators, trim slashes + whitespace. */
function normalizeFolder(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** A path is safe when every segment is a real name (no '', '.', or '..'). */
function hasUnsafeSegment(p: string): boolean {
  return p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/**
 * Move a knowledge file into a topical subfolder:
 *   `knowledge/<slug>.md` → `knowledge/<folder>/<basename(slug)>.md`
 *
 * Folder names are free-form topical groupings — nothing is reserved. The slug
 * is the path relative to `knowledge/` without `.md` (per knowledge-index.ts),
 * so a moved file round-trips through the index, recall corpus, and the
 * dashboard's `*slug` GET route as a first-class entry.
 *
 * Steps for a successful move:
 * 1. Validate slug + folder are safe relative paths (no `..`, stay under knowledge/).
 * 2. Rewrite inbound [[wikilinks]] atomically (old slug → new slug) BEFORE the move.
 * 3. Create `knowledge/<folder>/` and rename the file into it.
 *
 * Ordering rationale (mirrors migrateDiagramsToFolders): rewriting links while
 * the file is still at its old path is non-destructive — if the process dies
 * between the rewrite and the move, the file is STILL at the old slug, a re-run
 * finds it, the rewrite is a no-op (links already point to the new slug), and
 * the move completes. Moving first would, on a crash, leave every [[old-slug]]
 * permanently dangling.
 *
 * This function is intentionally decoupled from sleep-state access tracking —
 * the caller migrates the `knowledge_access` key (best-effort) after a success.
 */
export function moveKnowledgeFile(
  contextRoot: string,
  rawSlug: string,
  rawFolder: string,
): KnowledgeMoveResult {
  const knowledgeDir = join(contextRoot, 'knowledge');
  const knowledgeDirResolved = resolve(knowledgeDir);

  const slug = normalizeSlug(rawSlug);
  const folder = normalizeFolder(rawFolder);

  // --- validate slug ---
  if (!slug || hasUnsafeSegment(slug)) {
    return {
      ok: false,
      code: 'unsafe-slug',
      message: `Invalid knowledge slug: "${rawSlug}"`,
    };
  }

  // --- validate folder ---
  if (!folder || hasUnsafeSegment(folder)) {
    return {
      ok: false,
      code: 'unsafe-folder',
      message: `Invalid destination folder: "${rawFolder}". Use a relative path under knowledge/ with no "..".`,
    };
  }

  const base = basename(slug);
  const newSlug = `${folder}/${base}`;

  // No-op guard: already in the target folder.
  if (newSlug === slug) {
    return {
      ok: false,
      code: 'already-there',
      message: `"${slug}" is already in "${folder}/".`,
    };
  }

  const srcPath = join(knowledgeDir, `${slug}.md`);
  const destDir = join(knowledgeDir, folder);
  const destPath = join(destDir, `${base}.md`);

  // --- source must exist ---
  if (!existsSync(srcPath)) {
    return {
      ok: false,
      code: 'not-found',
      message: `Knowledge file not found: ${slug}.md`,
    };
  }

  // --- containment: dest must resolve strictly under knowledge/ ---
  const destDirResolved = resolve(destDir);
  const destPathResolved = resolve(destPath);
  if (
    destDirResolved !== join(knowledgeDirResolved, folder) ||
    !destDirResolved.startsWith(knowledgeDirResolved + sep) ||
    !destPathResolved.startsWith(knowledgeDirResolved + sep)
  ) {
    return {
      ok: false,
      code: 'unsafe-folder',
      message: `Destination escapes knowledge/: "${folder}"`,
    };
  }

  // --- never clobber an existing file ---
  if (existsSync(destPath)) {
    return {
      ok: false,
      code: 'dest-exists',
      message: `Destination already exists: ${folder}/${base}.md`,
    };
  }

  // Rewrite inbound [[wikilinks]] BEFORE moving (crash-safe — see doc comment).
  const remaps: WikilinkRemap[] = [{ from: slug, to: newSlug }];
  const wikilinksRewritten = rewriteWikilinks(contextRoot, remaps);

  try {
    mkdirSync(destDir, { recursive: true });
    renameSync(srcPath, destPath);
  } catch (e) {
    return {
      ok: false,
      code: 'move-failed',
      message: `Failed to move ${slug}.md → ${folder}/${base}.md: ${(e as Error).message}`,
    };
  }

  return {
    ok: true,
    oldSlug: slug,
    newSlug,
    oldPath: `knowledge/${slug}.md`,
    newPath: `knowledge/${newSlug}.md`,
    wikilinksRewritten,
  };
}
