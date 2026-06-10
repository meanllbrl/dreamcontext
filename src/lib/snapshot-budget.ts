/**
 * Snapshot token budget — the demotion ladder.
 *
 * The SessionStart snapshot grows linearly with project age (decisions, tasks,
 * features, knowledge). Past the harness's hook-output limit the ENTIRE
 * snapshot gets persisted to a file with only a ~2KB blind preview injected —
 * the worst possible cut: positional, uncurated, and it silently drops
 * warnings and the whole knowledge index. (Measured live on this repo at
 * 79.2KB / ~20K tokens.)
 *
 * This module enforces a token budget the right way: sections DEMOTE through
 * progressively cheaper curated renders — full body → summaries → one-line
 * references — and never below "referenced by path + recallable". Nothing is
 * ever raw-truncated, and never-evict sections (soul, user, warnings,
 * reminders) are untouchable. Demotion happens in waves, cheapest-loss
 * sections first, and stops the moment the snapshot fits.
 *
 * Everything demoted stays reachable: the file paths are still printed, the
 * docs are still in the recall corpus, and the UserPromptSubmit recall hook
 * re-surfaces them on the exact prompt where they matter.
 */

export interface BudgetSection {
  id: string;
  /** Full render. Used verbatim when the snapshot fits the budget. */
  text: string;
  /**
   * Progressively cheaper renders (level 1, level 2, …). Each must be a
   * complete replacement for `text` — a curated summary, never a slice.
   */
  demotions?: string[];
  /** Identity/warning tier — never demoted regardless of budget pressure. */
  neverEvict?: boolean;
}

/** ~4 chars per token for mixed EN/markdown — same estimate `snapshot --tokens` uses. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export const DEFAULT_SNAPSHOT_BUDGET_TOKENS = 10_000;

/**
 * Resolve the active budget from DREAMCONTEXT_SNAPSHOT_BUDGET:
 *   unset       → DEFAULT_SNAPSHOT_BUDGET_TOKENS
 *   "0" / "off" → null (budget disabled, legacy unbounded behaviour)
 *   "<n>"       → n tokens (clamped to a 2000 floor so the never-evict tier
 *                 plus headers always fit)
 */
export function resolveBudget(env: string | undefined): number | null {
  if (env === undefined || env.trim() === '') return DEFAULT_SNAPSHOT_BUDGET_TOKENS;
  const v = env.trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false') return null;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return DEFAULT_SNAPSHOT_BUDGET_TOKENS;
  return Math.max(2000, n);
}

export interface BudgetResult {
  text: string;
  /** Sections that were demoted, with the level applied (1-based). */
  demoted: Array<{ id: string; level: number }>;
  estimatedTokens: number;
  overBudget: boolean;
}

/**
 * Apply the budget. Sections are demoted in WAVES: first every demotable
 * section gets its level-1 render (in array order — order sections
 * cheapest-loss first), then level-2, and so on. After each single demotion
 * the total is re-checked so the ladder stops at the first fitting state.
 *
 * If the snapshot still exceeds the budget after every ladder rung, it is
 * returned as-is (overBudget: true) — this module never raw-truncates.
 */
export function applyBudget(
  sections: BudgetSection[],
  budgetTokens: number | null,
): BudgetResult {
  const render = (levels: Map<string, number>): string =>
    sections
      .map((s) => {
        const lvl = levels.get(s.id) ?? 0;
        const text = lvl === 0 ? s.text : s.demotions![lvl - 1];
        return text;
      })
      .filter((t) => t.trim() !== '')
      .join('\n');

  const levels = new Map<string, number>();
  let text = render(levels);

  if (budgetTokens === null || estimateTokens(text) <= budgetTokens) {
    return { text, demoted: [], estimatedTokens: estimateTokens(text), overBudget: false };
  }

  const maxLevels = Math.max(0, ...sections.map((s) => s.demotions?.length ?? 0));
  outer:
  for (let level = 1; level <= maxLevels; level++) {
    for (const s of sections) {
      if (s.neverEvict) continue;
      if (!s.demotions || s.demotions.length < level) continue;
      levels.set(s.id, level);
      text = render(levels);
      if (estimateTokens(text) <= budgetTokens) break outer;
    }
  }

  const demoted = [...levels.entries()].map(([id, level]) => ({ id, level }));
  if (demoted.length > 0) {
    const ids = demoted.map((d) => d.id).join(', ');
    text += [
      '\n\n---',
      `_Budget note: sections demoted to fit the snapshot budget (${ids}).`,
      'Nothing is lost — every demoted item keeps its file path above, and',
      '`dreamcontext memory recall "<keywords>"` surfaces the full content on demand._',
    ].join('\n');
  }

  const finalTokens = estimateTokens(text);
  return {
    text,
    demoted,
    estimatedTokens: finalTokens,
    overBudget: finalTokens > budgetTokens,
  };
}

// ─── Section-specific demotion builders ─────────────────────────────────────
// Pure string→string transforms used by generateSnapshot to pre-render the
// ladder rungs. Kept here (not in snapshot.ts) so they are unit-testable.

/**
 * Demote the `## Memory` block: inside the `## Technical Decisions` H2
 * section, keep the newest `keep` top-level bullets in full and collapse the
 * rest to a one-line title list. Other H2 sections (Active Memory, Known
 * Issues) are preserved untouched — they are the never-shrink working set.
 */
export function demoteMemoryBlock(block: string, keep: number): string {
  const marker = /^## Technical Decisions\s*$/m;
  const m = marker.exec(block);
  if (!m) return block;
  const start = m.index + m[0].length;
  const nextH2 = block.slice(start).search(/^## /m);
  const end = nextH2 === -1 ? block.length : start + nextH2;
  const section = block.slice(start, end);

  // Split into top-level bullets (lines starting `- ` at column 0); body lines
  // of a bullet (indented or wrapped) stay attached to it.
  const lines = section.split('\n');
  const preamble: string[] = [];
  const bullets: string[][] = [];
  for (const line of lines) {
    if (/^- /.test(line)) bullets.push([line]);
    else if (bullets.length === 0) preamble.push(line);
    else bullets[bullets.length - 1].push(line);
  }
  if (bullets.length <= keep) return block;

  const kept = bullets.slice(0, keep).map((b) => b.join('\n'));
  const titleOf = (b: string[]): string => {
    const head = b[0];
    const bold = /^- \*\*(.+?)\*\*/.exec(head);
    if (bold) return bold[1];
    const plain = head.replace(/^- /, '');
    return plain.length > 90 ? plain.slice(0, 87) + '...' : plain;
  };
  const titles = bullets.slice(keep).map((b) => `- ${titleOf(b)}`);

  const rebuilt = [
    ...preamble,
    ...kept,
    '',
    `### Older decisions (${titles.length} — titles only, \`dreamcontext memory recall\` for detail):`,
    ...titles,
    '',
  ].join('\n');

  return block.slice(0, start) + '\n' + rebuilt.replace(/^\n+/, '') + block.slice(end);
}

/**
 * Demote a task-entry list: keep the first `keep` entries (caller pre-sorts by
 * activity), collapse the rest to a single count line with the recovery
 * command. Entries are the multi-line strings getActiveTaskEntries renders.
 */
export function demoteTaskList(entries: string[], keep: number): string[] {
  if (entries.length <= keep) return entries;
  const rest = entries.length - keep;
  return [
    ...entries.slice(0, keep),
    `- (+${rest} more active task(s) — \`dreamcontext tasks list\` or memory recall)`,
  ];
}
