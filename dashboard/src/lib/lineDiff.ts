/**
 * Line-level diff with unified-style hunks — the engine behind the Task Manager's
 * "changes this session" view. Dependency-free on purpose: the dashboard has no diff
 * library, and this needs exactly one shape of output (git-style hunks over two
 * versions of one markdown document), not a general-purpose patch toolkit.
 *
 * Algorithm: trim the common prefix/suffix, then LCS over the remaining middle via
 * dynamic programming. Task documents are hundreds of lines, and the trim usually
 * shrinks an agent edit to a few dozen — the quadratic DP core stays tiny. A guard
 * caps the DP at MAX_DP_LINES per side and degrades to one whole-block replace hunk
 * (still a correct diff, just without intra-block alignment) rather than freezing
 * the UI on a pathological document.
 */

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
  /** 1-based line number in the old document (absent on additions). */
  oldNo?: number;
  /** 1-based line number in the new document (absent on deletions). */
  newNo?: number;
}

export interface DiffHunk {
  /** Git-style header: `@@ -oldStart,oldCount +newStart,newCount @@` */
  header: string;
  lines: DiffLine[];
}

export interface DiffStats {
  added: number;
  removed: number;
}

const MAX_DP_LINES = 3000;

/** Raw op stream (before hunking): one entry per old/new line in document order. */
interface Op { kind: 'ctx' | 'add' | 'del'; text: string; }

function computeOps(oldLines: string[], newLines: string[]): Op[] {
  // Common prefix / suffix — the cheap 99% of a typical agent edit.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld--; endNew--; }

  const midOld = oldLines.slice(start, endOld);
  const midNew = newLines.slice(start, endNew);

  const ops: Op[] = oldLines.slice(0, start).map((text) => ({ kind: 'ctx', text }));

  if (midOld.length > MAX_DP_LINES || midNew.length > MAX_DP_LINES) {
    // Degenerate middle: represent as one delete-block + add-block.
    ops.push(...midOld.map((text): Op => ({ kind: 'del', text })));
    ops.push(...midNew.map((text): Op => ({ kind: 'add', text })));
  } else if (midOld.length || midNew.length) {
    // LCS lengths table (midOld.length+1 × midNew.length+1), then backtrack.
    const m = midOld.length;
    const n = midNew.length;
    // Uint32 keeps the table compact (m·n ≤ 9M cells at the cap).
    const table = new Uint32Array((m + 1) * (n + 1));
    const idx = (i: number, j: number) => i * (n + 1) + j;
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        table[idx(i, j)] = midOld[i] === midNew[j]
          ? table[idx(i + 1, j + 1)] + 1
          : Math.max(table[idx(i + 1, j)], table[idx(i, j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) { ops.push({ kind: 'ctx', text: midOld[i] }); i++; j++; }
      else if (table[idx(i + 1, j)] >= table[idx(i, j + 1)]) { ops.push({ kind: 'del', text: midOld[i] }); i++; }
      else { ops.push({ kind: 'add', text: midNew[j] }); j++; }
    }
    while (i < m) { ops.push({ kind: 'del', text: midOld[i] }); i++; }
    while (j < n) { ops.push({ kind: 'add', text: midNew[j] }); j++; }
  }

  ops.push(...oldLines.slice(endOld).map((text): Op => ({ kind: 'ctx', text })));
  return ops;
}

/** Group an op stream into unified hunks with `context` lines of surrounding context. */
export function diffLines(oldText: string, newText: string, context = 3): DiffHunk[] {
  if (oldText === newText) return [];
  const ops = computeOps(oldText.split('\n'), newText.split('\n'));

  // Assign running line numbers.
  let oldNo = 1;
  let newNo = 1;
  const numbered: DiffLine[] = ops.map((op) => {
    const line: DiffLine = { kind: op.kind, text: op.text };
    if (op.kind !== 'add') line.oldNo = oldNo++;
    if (op.kind !== 'del') line.newNo = newNo++;
    return line;
  });

  // Which indexes make it into a hunk: every change + `context` lines around it.
  const keep = new Array<boolean>(numbered.length).fill(false);
  numbered.forEach((l, k) => {
    if (l.kind === 'ctx') return;
    for (let d = Math.max(0, k - context); d <= Math.min(numbered.length - 1, k + context); d++) keep[d] = true;
  });

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] | null = null;
  const flush = () => {
    if (!current || current.length === 0) return;
    const oldStart = current.find((l) => l.oldNo)?.oldNo ?? 0;
    const newStart = current.find((l) => l.newNo)?.newNo ?? 0;
    const oldCount = current.filter((l) => l.kind !== 'add').length;
    const newCount = current.filter((l) => l.kind !== 'del').length;
    hunks.push({ header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, lines: current });
    current = null;
  };
  numbered.forEach((l, k) => {
    if (!keep[k]) { flush(); return; }
    if (!current) current = [];
    current.push(l);
  });
  flush();
  return hunks;
}

export function diffStats(hunks: DiffHunk[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add') added++;
      else if (l.kind === 'del') removed++;
    }
  }
  return { added, removed };
}
