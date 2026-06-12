import {
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, basename, extname, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { rewriteWikilinks, WikilinkRemap } from './wikilink-rewrite.js';
import { EXCALIDRAW_SUFFIX } from './excalidraw-text.js';

/** Extensions that unambiguously belong to the same board pipeline. */
const GENERATOR_EXTS = new Set(['.board.cjs', '.board.js', '.board.py', '.json']);

/**
 * Check whether `filename` is a generator/spec file that belongs to the same
 * board as `boardBase` (the base name without `.excalidraw.md`).
 *
 * A file is "unambiguously same-basename" when it is named `<boardBase>.*`
 * and has one of the recognised generator extensions. This avoids moving
 * unrelated `.json` or `.md` files that happen to live in the same directory.
 */
function isSameBasenameSibling(filename: string, boardBase: string): boolean {
  for (const ext of GENERATOR_EXTS) {
    if (filename === `${boardBase}${ext}`) return true;
  }
  return false;
}

export interface DiagramsMoveResult {
  /** Board slugs (relative to knowledge/diagrams/) that were moved. */
  moved: string[];
  /** Board slugs already in a per-title subfolder — left untouched. */
  skipped: string[];
  /** Board slugs where moving was unsafe (ambiguous sibling names). */
  ambiguous: string[];
}

/**
 * Move flat `knowledge/diagrams/*.excalidraw.md` boards into per-title folders:
 *   `knowledge/diagrams/<title>/<title>.excalidraw.md`
 *
 * For each board that is moved:
 * 1. Creates `knowledge/diagrams/<title>/`.
 * 2. Moves `<title>.excalidraw.md` (and any unambiguous same-basename
 *    generator/spec files) into the subfolder.
 * 3. Calls `rewriteWikilinks` atomically (old slug → new slug) so inbound
 *    [[wikilinks]] in any `.md` file under `contextRoot` are updated.
 *
 * A board is skipped when it is already inside a subfolder (not flat).
 *
 * This function is exposed ONLY via the opt-in agentTask on migration 0.7.2.
 * The migration CODE step (see src/migrations/0.7.2.ts) does NOT call this —
 * it only detects flat boards and records `detected` so the user can decide.
 */
export function migrateDiagramsToFolders(
  contextRoot: string,
): DiagramsMoveResult {
  const diagramsDir = join(contextRoot, 'knowledge', 'diagrams');
  const result: DiagramsMoveResult = { moved: [], skipped: [], ambiguous: [] };

  if (!existsSync(diagramsDir)) return result;

  // Find all boards: only look one level deep (flat) — nested boards are skipped.
  const flatFiles = fg.sync('*.excalidraw.md', {
    cwd: diagramsDir,
    absolute: false,
  });

  // Find already-nested boards to populate skipped list.
  const nestedFiles = fg.sync('*/*.excalidraw.md', {
    cwd: diagramsDir,
    absolute: false,
  });

  for (const nested of nestedFiles) {
    result.skipped.push(nested.replace(EXCALIDRAW_SUFFIX, ''));
  }

  const diagramsDirResolved = resolve(diagramsDir);

  for (const filename of flatFiles) {
    const boardBase = filename.slice(0, -EXCALIDRAW_SUFFIX.length);
    const srcBoard = join(diagramsDir, filename);
    const destDir = join(diagramsDir, boardBase);
    const destBoard = join(destDir, filename);

    // Containment guard: boardBase derives from a filename, so it should be a
    // single safe path segment. Reject anything that could escape diagramsDir
    // (path separators, `..`, or a destDir that resolves outside the tree).
    if (
      boardBase === '' ||
      boardBase === '.' ||
      boardBase === '..' ||
      boardBase.includes('/') ||
      boardBase.includes('\\') ||
      resolve(destDir) !== join(diagramsDirResolved, boardBase) ||
      !resolve(destDir).startsWith(diagramsDirResolved + sep)
    ) {
      result.ambiguous.push(boardBase);
      continue;
    }

    // Old slug: `diagrams/<boardBase>.excalidraw` (relative to knowledge/)
    // New slug: `diagrams/<boardBase>/<boardBase>.excalidraw`
    const oldSlug = `diagrams/${boardBase}.excalidraw`;
    const newSlug = `diagrams/${boardBase}/${boardBase}.excalidraw`;

    // Collect sibling files to move alongside the board.
    let siblings: string[] = [];
    try {
      const allInDir = readdirSync(diagramsDir).filter(
        (f) => statSync(join(diagramsDir, f)).isFile(),
      );
      siblings = allInDir.filter(
        (f) => f !== filename && isSameBasenameSibling(f, boardBase),
      );
    } catch {
      // If we can't read the directory, skip this board.
      result.ambiguous.push(boardBase);
      continue;
    }

    // Create the destination folder.
    try {
      mkdirSync(destDir, { recursive: true });
    } catch {
      result.ambiguous.push(boardBase);
      continue;
    }

    // Rewrite inbound [[wikilinks]] BEFORE moving the board. Rewriting is
    // non-destructive (the board is still at its old path), so if the process
    // dies between the rewrite and the move, the board is STILL flat — a re-run
    // detects it, the rewrite is a no-op (links already point to the new slug),
    // and the move completes. Doing the move first would, on a crash, leave the
    // board relocated with every [[old-slug]] permanently dangling (the re-run
    // skips it because it is no longer flat).
    const remaps: WikilinkRemap[] = [{ from: oldSlug, to: newSlug }];
    rewriteWikilinks(contextRoot, remaps);

    // Move the board file.
    try {
      renameSync(srcBoard, destBoard);
    } catch {
      result.ambiguous.push(boardBase);
      continue;
    }

    // Move unambiguous generator/spec siblings.
    for (const sib of siblings) {
      try {
        renameSync(join(diagramsDir, sib), join(destDir, sib));
      } catch {
        // If a sibling fails, we already moved the board — report but continue.
        result.ambiguous.push(`${boardBase} (sibling: ${sib})`);
      }
    }

    result.moved.push(boardBase);
  }

  return result;
}

/**
 * Detect flat `knowledge/diagrams/*.excalidraw.md` boards WITHOUT moving them.
 * Returns the list of flat board slugs found. Used by the migration CODE step
 * to record `detected` state safely.
 */
export function detectFlatDiagramBoards(contextRoot: string): string[] {
  const diagramsDir = join(contextRoot, 'knowledge', 'diagrams');
  if (!existsSync(diagramsDir)) return [];

  const flatFiles = fg.sync('*.excalidraw.md', {
    cwd: diagramsDir,
    absolute: false,
  });

  return flatFiles.map((f) => f.slice(0, -EXCALIDRAW_SUFFIX.length));
}
