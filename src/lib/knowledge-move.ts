import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { rewriteWikilinks, WikilinkRemap } from './wikilink-rewrite.js';
import { EXCALIDRAW_SUFFIX } from './excalidraw-text.js';

export type KnowledgeMoveFailure =
  | 'unsafe-slug'
  | 'unsafe-folder'
  | 'not-found'
  | 'already-there'
  | 'dest-exists'
  | 'not-a-board-dir'
  | 'nested-into-self'
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

// ─── Board / context directory move ─────────────────────────────────────────

export interface KnowledgeDirMoveSuccess {
  ok: true;
  /** Source directory slug (path relative to knowledge/). */
  oldSlug: string;
  /** Destination directory slug (`<folder>/<basename>`). */
  newSlug: string;
  /** Source path relative to contextRoot (e.g. `knowledge/diagrams/recall`). */
  oldPath: string;
  /** Destination path relative to contextRoot (e.g. `knowledge/system/recall`). */
  newPath: string;
  /**
   * Per-file slug remaps applied — one entry for every indexed `.md` file the
   * directory carried (board `.excalidraw.md` + any `name:`-fronted companions).
   * The caller migrates each `knowledge_access` decay key from `from`→`to`.
   */
  slugRemaps: WikilinkRemap[];
  /** Absolute paths of files whose inbound [[wikilinks]] were rewritten. */
  wikilinksRewritten: string[];
}

export type KnowledgeDirMoveResult = KnowledgeDirMoveSuccess | KnowledgeMoveError;

/** True when `dir` contains at least one `*.excalidraw.md` board at any depth. */
function containsBoard(dir: string): boolean {
  return (
    fg.sync(`**/*${EXCALIDRAW_SUFFIX}`, { cwd: dir, absolute: false }).length > 0
  );
}

/**
 * Move a board (or board-bearing context) DIRECTORY into another context folder:
 *   `knowledge/<srcSlug>/…` → `knowledge/<folder>/<basename(srcSlug)>/…`
 *
 * This is the directory counterpart to {@link moveKnowledgeFile}. An Excalidraw
 * board lives in its own `<title>/` wrapper folder alongside dark tooling
 * siblings (`<title>.board.cjs`, spec `.json`, helper `.md`) — a unit that a
 * single-file move splits in half (relocating the rendered `.excalidraw.md` but
 * silently orphaning its generator). This carries the WHOLE directory atomically
 * (one `renameSync` of the folder) and rewrites inbound [[wikilinks]] for every
 * indexed `.md` file it contains, so the board — and any co-located teardown —
 * stays first-class in index/recall/snapshot/dashboard at its new slug.
 *
 * The source is gated on actually being a board directory (contains an
 * `.excalidraw.md`) so an accidental slug collision with a large context folder
 * can never sweep an unrelated tree; move plain-`.md` knowledge with
 * {@link moveKnowledgeFile} instead.
 *
 * Ordering mirrors {@link moveKnowledgeFile}: rewrite links while the directory
 * is still at its old path (non-destructive — a crash before the rename leaves
 * the board where it was, a re-run's rewrite is a no-op, and the move completes).
 */
export function moveKnowledgeDir(
  contextRoot: string,
  rawSource: string,
  rawFolder: string,
): KnowledgeDirMoveResult {
  const knowledgeDir = join(contextRoot, 'knowledge');
  const knowledgeDirResolved = resolve(knowledgeDir);

  const srcSlug = normalizeSlug(rawSource);
  const folder = normalizeFolder(rawFolder);

  // --- validate source slug ---
  if (!srcSlug || hasUnsafeSegment(srcSlug)) {
    return {
      ok: false,
      code: 'unsafe-slug',
      message: `Invalid knowledge directory: "${rawSource}"`,
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

  const base = basename(srcSlug);
  const newSlug = `${folder}/${base}`;

  // No-op guard: already in the target folder.
  if (newSlug === srcSlug) {
    return {
      ok: false,
      code: 'already-there',
      message: `"${srcSlug}/" is already in "${folder}/".`,
    };
  }

  const srcDir = join(knowledgeDir, srcSlug);
  const destParent = join(knowledgeDir, folder);
  const destDir = join(destParent, base);

  // --- source must exist and be a directory ---
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    return {
      ok: false,
      code: 'not-found',
      message: `Knowledge directory not found: ${srcSlug}/`,
    };
  }

  // --- source must actually be a board directory ---
  if (!containsBoard(srcDir)) {
    return {
      ok: false,
      code: 'not-a-board-dir',
      message: `"${srcSlug}/" is not a board directory (no *.excalidraw.md inside). Move plain knowledge files with a file slug instead.`,
    };
  }

  // --- containment: dest must resolve strictly under knowledge/ ---
  const destDirResolved = resolve(destDir);
  if (
    destDirResolved !== join(knowledgeDirResolved, newSlug) ||
    !destDirResolved.startsWith(knowledgeDirResolved + sep)
  ) {
    return {
      ok: false,
      code: 'unsafe-folder',
      message: `Destination escapes knowledge/: "${folder}"`,
    };
  }

  // --- never move a directory into itself or one of its own descendants ---
  const srcDirResolved = resolve(srcDir);
  if (
    destDirResolved === srcDirResolved ||
    destDirResolved.startsWith(srcDirResolved + sep)
  ) {
    return {
      ok: false,
      code: 'nested-into-self',
      message: `Cannot move "${srcSlug}/" into itself ("${newSlug}/").`,
    };
  }

  // --- never clobber an existing directory ---
  if (existsSync(destDir)) {
    return {
      ok: false,
      code: 'dest-exists',
      message: `Destination already exists: ${newSlug}/`,
    };
  }

  // Build one wikilink remap per indexed `.md` file the directory carries.
  // Every such file's slug is `<srcSlug>/<rel-without-.md>` and becomes
  // `<newSlug>/<rel-without-.md>` after the folder rename — a pure prefix swap.
  const mdFiles = fg.sync('**/*.md', { cwd: srcDir, absolute: false });
  const remaps: WikilinkRemap[] = mdFiles.map((rel) => {
    const relSlug = rel.replace(/\.md$/i, '');
    return { from: `${srcSlug}/${relSlug}`, to: `${newSlug}/${relSlug}` };
  });

  // Rewrite inbound [[wikilinks]] BEFORE moving (crash-safe — see doc comment).
  const wikilinksRewritten = rewriteWikilinks(contextRoot, remaps);

  try {
    mkdirSync(destParent, { recursive: true });
    renameSync(srcDir, destDir);
  } catch (e) {
    return {
      ok: false,
      code: 'move-failed',
      message: `Failed to move ${srcSlug}/ → ${newSlug}/: ${(e as Error).message}`,
    };
  }

  return {
    ok: true,
    oldSlug: srcSlug,
    newSlug,
    oldPath: `knowledge/${srcSlug}`,
    newPath: `knowledge/${newSlug}`,
    slugRemaps: remaps,
    wikilinksRewritten,
  };
}
