import { dirname } from 'node:path';

// ─── Excalidraw text extraction ───────────────────────────────────────────────
//
// Obsidian Excalidraw boards (`*.excalidraw.md`) store the scene in a
// `## Drawing` fenced block. Memory should index ONLY the human-readable
// ## Text Elements section (labels), never the scene JSON.
//
// Cross-ref: dashboard/src/lib/excalidraw.ts:8 defines DRAWING_BLOCK for
// rendering; the regex below is replicated here (src/ cannot import
// dashboard/src — separate tsconfig, rootDir:src forbids it).

/** Suffix used by all Obsidian Excalidraw boards. */
export const EXCALIDRAW_SUFFIX = '.excalidraw.md';

/**
 * Maximum number of lines to keep from extracted text.
 * Boards can be very large; cap prevents snapshot bloat.
 */
export const EXCALIDRAW_MAX_LINES = 200;

/**
 * Regex that matches the `## Drawing` fenced block (both `json` and
 * `compressed-json` variants). Defense-in-depth: even if the keep-only-
 * Text-Elements pass misses the block, stripping it here prevents scene
 * JSON from leaking into the corpus.
 *
 * Replicated from dashboard/src/lib/excalidraw.ts:8 (cross-ref comment
 * there). Do NOT import dashboard/src from src/ — separate build roots.
 */
const DRAWING_BLOCK =
  /##\s*Drawing\s*```(?:compressed-json|json)[\s\S]*?```/gm;

/**
 * True when `filePath` is an Excalidraw board (ends with `.excalidraw.md`).
 */
export function isExcalidrawPath(filePath: string): boolean {
  return filePath.endsWith(EXCALIDRAW_SUFFIX);
}

/**
 * Extract only the human-readable text from an Excalidraw board body
 * (frontmatter already stripped by readFrontmatter).
 *
 * Strategy:
 * 1. Strip the `## Drawing` fenced block (defense-in-depth).
 * 2. Find the `## Text Elements` section using a JS-valid /m regex with a
 *    lookahead for the next `##` or `%%` section terminator (NO `\Z` —
 *    JavaScript has no `\Z`).
 * 3. If no `## Text Elements` section is found, return '' (frontmatter-only
 *    boards have zero text surface; callers fall back to description).
 * 4. Within the section: remove `## Embedded Files` map lines, the Obsidian
 *    banner `==⚠...==`, and trailing `^blockref` id suffixes per line.
 * 5. Collapse blank runs, trim, slice to EXCALIDRAW_MAX_LINES.
 *
 * Returns '' on any error (try/catch). NEVER returns raw body.
 */
export function extractExcalidrawText(rawBody: string): string {
  try {
    // Step 1: strip the Drawing fenced block (both json + compressed-json).
    // This is defense-in-depth: the keep-only-Text-Elements step below
    // already discards the Drawing section, but a malformed board with an
    // unclosed fence could otherwise leak JSON into the result.
    const noDrawing = rawBody.replace(DRAWING_BLOCK, '');

    // Step 2: isolate the ## Text Elements section using split-on-headings.
    // Approach: split the body into sections at every line that starts with
    // `##` or `%%`. Find the `## Text Elements` section and take its content.
    // This avoids any reliance on `\Z` (JS has no `\Z`) or the `$` anchor
    // under `/m` mode (which matches end-of-line and would stop a lazy `[\s\S]+?`
    // at the first blank line inside the section).
    const sectionLines = noDrawing.split('\n');
    let inTextElements = false;
    const sectionContent: string[] = [];

    for (const line of sectionLines) {
      if (/^##\s/.test(line) || /^%%/.test(line)) {
        if (/^##\s+Text\s+Elements/i.test(line)) {
          // Found the section header — start collecting
          inTextElements = true;
          continue; // skip the header line itself
        } else if (inTextElements) {
          // Hit the next section header — stop collecting
          break;
        }
        // Some other heading before Text Elements — ignore
        continue;
      }
      if (inTextElements) {
        sectionContent.push(line);
      }
    }

    if (!inTextElements) {
      // No ## Text Elements section found — fall back to '' (frontmatter-only).
      return '';
    }

    let text = sectionContent.join('\n');

    // Step 3: strip the Obsidian banner ==⚠...==
    text = text.replace(/==⚠[^=]*==\s*/g, '');

    // Step 4: process line by line — strip ^blockref ids and filter empties.
    const lines = text.split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      // Strip trailing ^blockref suffix (e.g. "Session start ^6GYBW5hX")
      const cleaned = line.replace(/\s*\^[A-Za-z0-9_-]{4,}\s*$/, '').trim();
      if (cleaned.length > 0) {
        kept.push(cleaned);
      }
    }

    // Step 5: collapse consecutive blank runs (shouldn't be any after the
    // filter above, but be defensive), trim, slice to max lines.
    const result = kept.slice(0, EXCALIDRAW_MAX_LINES).join('\n').trim();
    return result;
  } catch {
    return '';
  }
}

// ─── Dark-sibling helpers ─────────────────────────────────────────────────────
//
// Inside `knowledge/diagrams/<title>/`, the board file is the only thing that
// should surface in index/recall/snapshot. All sibling files (generator
// scripts, spec JSON, helper notes.md) are "dark" — they exist for tooling but
// must NOT enter the memory corpus.
//
// Design: O(1) per file after a single O(n) pass over the full file list.
// No fs calls per file — only dirname().

/**
 * Compute the set of directory paths that directly contain at least one
 * `*.excalidraw.md` file. Called ONCE per glob result, O(n) total.
 *
 * `allFiles`: absolute paths from fg.sync('**‌/*.md').
 */
export function diagramFolderDirs(allFiles: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const f of allFiles) {
    if (isExcalidrawPath(f)) {
      dirs.add(dirname(f));
    }
  }
  return dirs;
}

/**
 * Returns true when `filePath` is a tooling sibling inside a diagram folder
 * that should stay OUT of the index / recall / snapshot / dashboard.
 *
 * Role-based, not blind co-location:
 * - Not next to a board (`dirsSet`) → not dark.
 * - The board itself (`*.excalidraw.md`) → not dark (indexed as Text Elements).
 * - A companion `.md` that declares itself as knowledge via `name:` frontmatter
 *   (`isIndexableKnowledge`) → NOT dark. This lets a detailed teardown/notes
 *   file live beside its board and still recall as first-class knowledge.
 * - Everything else beside a board (frontmatter-less helper `.md`, generator
 *   scripts, spec JSON) → dark.
 *
 * `isIndexableKnowledge` defaults to `false`, so callers that don't pass it keep
 * the original "any non-board sibling is dark" behaviour (backward-safe). The
 * predicate stays O(1) with no fs calls — the caller supplies the flag from the
 * frontmatter it already reads. Non-`.md` files never reach here in practice:
 * both consumers glob markdown files only.
 */
export function isDarkDiagramSibling(
  filePath: string,
  dirsSet: Set<string>,
  isIndexableKnowledge = false,
): boolean {
  if (!dirsSet.has(dirname(filePath))) return false;
  if (isExcalidrawPath(filePath)) return false;
  if (isIndexableKnowledge) return false;
  return true;
}
