/**
 * What a small tile can say about a task without opening it (owner 2026-10-20: "kart küçük olsa
 * bile kartlar gösterilmeli"): how far its acceptance criteria are, how many are open, and the
 * next one. Pure: read from the task's own `acceptance_criteria` markdown, the list the task page
 * already has in the window (0 requests of its own).
 */

const BOX = /^\s*[-*+]\s+\[( |x|X)\]\s+(.+)$/;

export interface CriteriaProgress {
  done: number;
  total: number;
  /** The first open criterion, as plain text (markdown marks dropped); null when none is open. */
  next: string | null;
}

/** A criterion's text for one line: no bold/italic/code marks, links read as their text. */
export function plainCriterion(md: string): string {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function criteriaProgress(md: string | null | undefined): CriteriaProgress {
  let done = 0;
  let total = 0;
  let next: string | null = null;
  for (const line of (md ?? '').split('\n')) {
    const m = BOX.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1] !== ' ') done += 1;
    else if (next === null) next = plainCriterion(m[2]) || null;
  }
  return { done, total, next };
}
