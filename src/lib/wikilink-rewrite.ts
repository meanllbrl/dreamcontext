import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import fg from 'fast-glob';

// Wikilink pattern — mirrors recall.ts:202 (do NOT refactor recall.ts).
// Matches [[target]], [[target|alias]], [[target#anchor]].
// The regex captures only the full wikilink text; target extraction happens
// by splitting on '|' and '#' (first token only = the link target slug).
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

export interface WikilinkRemap {
  /** Old slug (path-relative to knowledge/, without .md). */
  from: string;
  /** New slug (path-relative to knowledge/, without .md). */
  to: string;
}

/**
 * Rewrite inbound [[wikilinks]] in all .md files under contextRoot that
 * reference any of the given slug remaps.
 *
 * Safety contract:
 *  - Skips rewriting inside fenced code blocks (``` ... ```).
 *  - Swaps ONLY the link target token; preserves |alias and #anchor verbatim.
 *  - Writes atomically (tmp + renameSync) for each changed file.
 *  - Returns the list of files changed (absolute paths).
 *
 * Slug format: path-relative per knowledge-index.ts:63 (e.g. 'data-structures/default').
 */
export function rewriteWikilinks(
  contextRoot: string,
  remaps: WikilinkRemap[],
): string[] {
  if (remaps.length === 0) return [];

  // Build a fast lookup: oldSlug -> newSlug
  const remapMap = new Map<string, string>(remaps.map((r) => [r.from, r.to]));

  const files = fg.sync('**/*.md', {
    cwd: contextRoot,
    absolute: true,
    ignore: ['node_modules/**'],
  });

  const changed: string[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    const rewritten = rewriteFileContent(content, remapMap);
    if (rewritten === content) continue;

    // Atomic write: write to tmp, then rename
    const tmp = file + '.wl-tmp';
    try {
      mkdirSync(dirname(tmp), { recursive: true });
      writeFileSync(tmp, rewritten, 'utf-8');
      renameSync(tmp, file);
      changed.push(file);
    } catch {
      // Clean up tmp if rename failed
      try {
        if (existsSync(tmp)) {
          writeFileSync(tmp, ''); // truncate
        }
      } catch { /* ignore */ }
    }
  }

  return changed;
}

/**
 * Rewrite wikilink targets in a single file's content string.
 * Exported for testing.
 * Skips content inside fenced code blocks (``` ... ```).
 */
export function rewriteFileContent(
  content: string,
  remapMap: Map<string, string>,
): string {
  // Split the file into fenced-code-block segments and normal text segments.
  // We only rewrite normal text segments.
  const segments = splitOnCodeFences(content);

  const rewrittenSegments = segments.map((seg) => {
    if (seg.isFenced) return seg.text;
    return seg.text.replace(WIKILINK_RE, (match, inner: string) => {
      // inner = target | target|alias | target#anchor | target#anchor|alias
      // The link target is the part before '|' and before '#'
      // Format: [[target]], [[target|alias]], [[target#anchor]], [[target#anchor|alias]]
      const pipeIdx = inner.indexOf('|');
      const hashIdx = inner.indexOf('#');

      let target: string;
      let rest: string; // everything after the target (|alias, #anchor, or both)

      if (pipeIdx !== -1 && hashIdx !== -1 && hashIdx < pipeIdx) {
        // Has anchor before alias: [[target#anchor|alias]]
        target = inner.slice(0, hashIdx);
        rest = inner.slice(hashIdx); // keep '#anchor|alias'
      } else if (pipeIdx !== -1) {
        // Has alias (no anchor before it): [[target|alias]]
        target = inner.slice(0, pipeIdx);
        rest = inner.slice(pipeIdx); // keep '|alias'
      } else if (hashIdx !== -1) {
        // Has anchor but no alias: [[target#anchor]]
        target = inner.slice(0, hashIdx);
        rest = inner.slice(hashIdx); // keep '#anchor'
      } else {
        target = inner;
        rest = '';
      }

      const newTarget = remapMap.get(target.trim());
      if (!newTarget) return match; // not in remaps, leave unchanged
      return `[[${newTarget}${rest}]]`;
    });
  });

  return rewrittenSegments.join('');
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface Segment {
  text: string;
  isFenced: boolean;
}

/**
 * Split content into alternating non-fenced and fenced segments.
 * Fenced blocks start and end on lines whose trimmed content starts with ```.
 */
function splitOnCodeFences(content: string): Segment[] {
  const segments: Segment[] = [];
  // Use a line-by-line approach to detect fence boundaries reliably
  const lines = content.split('\n');
  let inFence = false;
  let current: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!inFence && trimmed.startsWith('```')) {
      // Opening fence (may carry an info string e.g. ```ts): flush non-fenced
      // text, start fenced block.
      if (current.length > 0) {
        segments.push({ text: current.join('\n'), isFenced: false });
        current = [];
      }
      inFence = true;
      current.push(line);
    } else if (inFence && /^`{3,}\s*$/.test(trimmed)) {
      // Closing fence: ONLY a backticks-only line closes (per CommonMark a
      // closing fence carries no info string). A line like ```ts while already
      // inside a fence is content, not a close — so a wikilink after a nested
      // language-tagged line is NOT wrongly un-fenced and rewritten.
      current.push(line);
      segments.push({ text: current.join('\n'), isFenced: true });
      current = [];
      inFence = false;
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    segments.push({ text: current.join('\n'), isFenced: inFence });
  }

  return segments;
}
