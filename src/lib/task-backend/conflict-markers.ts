/**
 * Parse LITERAL git conflict markers baked into committed file bytes.
 *
 * `git-sync/git.ts` `readOursTheirsBase()` reads the three merge-stage blobs via
 * `git show :1/2/3:<path>` — that only works DURING an active `git merge`, off
 * the index. Once a conflict has been committed as-is (e.g. an already-tracked
 * `state/.tasks-map.json` merged by a client that left markers in place, or a
 * legacy brain with markers sitting in history), there is no merge in progress
 * and no index stage to read — the only surviving record is the marker text
 * itself. This module is that fallback: a pure text scan, no git invocation.
 */

const OURS_MARKER = '<<<<<<<';
const BASE_MARKER = '|||||||';
const SPLIT_MARKER = '=======';
const THEIRS_MARKER = '>>>>>>>';

type Zone = 'context' | 'ours' | 'base' | 'theirs';

/**
 * Split conflict-markered text into its `ours`/`theirs` reconstructions.
 * Returns `null` when the text carries no `<<<<<<<` marker (nothing to split).
 *
 * Handles multiple conflict hunks in one file, the optional diff3 `|||||||`
 * base section (discarded — neither side), and arbitrary branch labels
 * trailing `<<<<<<<` / `|||||||` / `>>>>>>>` (matched on the 7-char token
 * prefix only). Shared context outside any hunk is appended to BOTH sides.
 */
export function splitConflictMarkers(text: string): { ours: string; theirs: string } | null {
  if (!text.includes(OURS_MARKER)) return null;

  const lines = text.split('\n');
  const oursLines: string[] = [];
  const theirsLines: string[] = [];
  let zone: Zone = 'context';

  for (const line of lines) {
    if (line.startsWith(OURS_MARKER)) {
      zone = 'ours';
      continue;
    }
    if (line.startsWith(BASE_MARKER)) {
      zone = 'base';
      continue;
    }
    if (line.startsWith(SPLIT_MARKER) && (zone === 'ours' || zone === 'base')) {
      zone = 'theirs';
      continue;
    }
    if (line.startsWith(THEIRS_MARKER)) {
      zone = 'context';
      continue;
    }

    switch (zone) {
      case 'context':
        oursLines.push(line);
        theirsLines.push(line);
        break;
      case 'ours':
        oursLines.push(line);
        break;
      case 'theirs':
        theirsLines.push(line);
        break;
      case 'base':
        // diff3 base section — discarded, belongs to neither side.
        break;
    }
  }

  return { ours: oursLines.join('\n'), theirs: theirsLines.join('\n') };
}
