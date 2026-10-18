/**
 * The owner's tick on the task page: flip one Acceptance Criteria box in the card body and
 * send the whole body through the existing PATCH. The server does the rest (`routes/tasks.ts`):
 * a box ticked without evidence gets an `owner:<je_id>` approval, an unticked box loses its ref.
 *
 * The section and the numbering follow `src/lib/task-evidence.ts` (`criteriaSpan`,
 * `parseCriteria`): criterion `n` is the n-th checkbox line under `## Acceptance Criteria`,
 * fenced blocks skipped. `tests/unit/task-criteria-mirror.test.ts` runs this against the
 * server's parser, so the box the owner clicks is the box the server reads.
 */

const CRIT_RE = /^(\s*[-*+]\s+)\[( |x|X)\](\s+)(.*?)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** The line span (exclusive end) of `## Acceptance Criteria`'s body. */
function criteriaSpan(lines: string[]): { start: number; end: number } | null {
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (!h) continue;
    if (start >= 0) return { start, end: i };
    if (h[1].toLowerCase().replace(/[^a-z]/g, '') === 'acceptancecriteria') start = i + 1;
  }
  return start >= 0 ? { start, end: lines.length } : null;
}

/**
 * Set criterion `n` (1-based) to `checked`, touching only its box. Returns the new body and the
 * mermaid node the line names (`<!-- node:<id> -->`), or null when there is no such criterion.
 */
export function toggleCriterion(body: string, n: number, checked: boolean): { body: string; nodeId: string | null } | null {
  const lines = body.split('\n');
  const span = criteriaSpan(lines);
  if (!span) return null;
  let inFence = false;
  let count = 0;
  for (let i = span.start; i < span.end; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = CRIT_RE.exec(lines[i]);
    if (!m) continue;
    count += 1;
    if (count !== n) continue;
    lines[i] = `${m[1]}[${checked ? 'x' : ' '}]${m[3]}${m[4]}`;
    const node = /<!--\s*node:([A-Za-z0-9_-]+)\s*-->/.exec(m[4]);
    return { body: lines.join('\n'), nodeId: node ? node[1] : null };
  }
  return null;
}

/*
 * Acceptance-criteria ↔ mermaid sync, moved from the old task panel.
 *
 * A criterion line may end with `<!-- node:<id> -->`, naming a node of a ```mermaid block.
 * Ticking it rewrites that node's trailing `:::done|:::todo|:::active|:::blocked` class to
 * `:::done` (unticked → `:::todo`) in the same PATCH.
 */

// Edge-line operators in mermaid flowcharts. A line with any of these is a link statement, not
// a node definition, and must not have its `:::status` rewritten (`a[A] --> b[B]` would become
// malformed and flip the wrong nodes).
const MERMAID_EDGE_RE = /-->|---|==>|==|-\.|~~~|\.->/;

export function updateMermaidNodeStatus(body: string, nodeId: string, checked: boolean): string {
  const status = checked ? 'done' : 'todo';
  const escapedId = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The node id in definition position only: followed by `[label]`, `(label)`, `{label}`,
  // `:::class`, or alone before the end of the line.
  const nodeDefRe = new RegExp(
    `^(\\s*)(${escapedId})((?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\})?)(\\s*:::(?:done|todo|active|blocked)\\b)?\\s*$`,
  );
  const lines = body.split('\n');
  let inMermaid = false;
  let fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inMermaid) {
      const open = /^(\s*)(```|~~~)\s*mermaid\b/i.exec(line);
      if (open) {
        inMermaid = true;
        fenceChar = open[2];
      }
      continue;
    }
    if (line.trim().startsWith(fenceChar)) {
      inMermaid = false;
      fenceChar = '';
      continue;
    }
    if (/^\s*(classDef|class|style|linkStyle|click|subgraph|end)\b/.test(line)) continue;
    if (MERMAID_EDGE_RE.test(line)) continue;
    const m = nodeDefRe.exec(line);
    if (!m) continue;
    const [, indent, id, label] = m;
    lines[i] = `${indent}${id}${label ?? ''}:::${status}`;
  }
  return lines.join('\n');
}
