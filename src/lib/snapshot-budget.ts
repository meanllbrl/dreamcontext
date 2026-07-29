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
 * ever raw-truncated.
 *
 * ── The two tiers ──────────────────────────────────────────────────────────
 * `neverEvict` is for content that is BINDING no matter the pressure: the H1,
 * the linked-repo paths, an active task-format override, contextual reminders.
 * It is deliberately NOT a dumping ground for "big things nobody wrote a rung
 * for" — that is how the tier grew to ~37KB on a 20,000-char limit and made
 * the ladder unwinnable by construction. Inventory sections (core-file index,
 * releases, connected projects, bookmarks) carry ladders instead, because
 * every rung of theirs still names each item by path.
 *
 * ── Demotion order is independent of render order ──────────────────────────
 * Sections render in array order (that is the document's reading order), but
 * they DEMOTE in `demotionRank` order, cheapest loss first. Without that split
 * a section's position in the document would decide how early it gets gutted —
 * identity renders near the top, so it would be stripped before warm knowledge.
 * A section with no rank falls back to its array index, which is exactly the
 * pre-rank behaviour.
 *
 * ── Byte-aware rungs ───────────────────────────────────────────────────────
 * Rungs cap BYTES, not item counts: a 130-decision brain and a 20-decision
 * brain must land in the same envelope. Rungs may be lazy thunks so that an
 * under-budget snapshot — the common case, and a SessionStart hot path —
 * renders zero of them. Each rung is resolved at most once per run.
 *
 * ── Floors ─────────────────────────────────────────────────────────────────
 * A section may set a `maxDemotionLevel` floor when a deeper rung would
 * technically fit but would strip the very content the section exists to carry
 * (see Lab). Cheaper sections absorb the pressure instead; if none can, the
 * snapshot stays honestly over budget rather than blinding the agent.
 *
 * ── Two bands, two signals ─────────────────────────────────────────────────
 * Over the token budget but still under HARNESS_PERSIST_CHAR_LIMIT, the
 * snapshot is complete and lands inline: the loud `_Budget note:` footer says
 * the ladder is exhausted and makes NO claim about being cut. Only past the
 * harness limit does the caller prepend `renderOverBudgetBanner()` — inside
 * the preview window — because only there is the agent actually reading a
 * positional slice.
 *
 * Everything demoted stays reachable: the file paths are still printed, the
 * docs are still in the recall corpus, and the UserPromptSubmit recall hook
 * re-surfaces them on the exact prompt where they matter.
 */

/**
 * One ladder rung. A thunk defers the render so an under-budget snapshot never
 * pays for rungs it will not use; the result is memoized per (section, level).
 */
export type BudgetRung = string | (() => string);

export interface BudgetSection {
  id: string;
  /** Full render. Used verbatim when the snapshot fits the budget. */
  text: string;
  /**
   * Progressively cheaper renders (level 1, level 2, …). Each must be a
   * complete replacement for `text` — a curated summary, never a slice.
   * A rung may be a thunk; it is resolved lazily and at most once.
   */
  demotions?: BudgetRung[];
  /**
   * Deepest ladder rung this section may be taken to (1-based). Defaults to
   * `demotions.length` — i.e. the whole ladder is fair game.
   *
   * A floor is for a section whose remaining CONTENT is the point, not its
   * size: Lab must always name the metrics it tracks and their latest values,
   * because a bare "N insight(s)" line leaves the agent unable to tell that a
   * metric question is already answered in the brain — and it then goes and
   * fetches the number from outside (SKILL.md Operational Rule 13). Cheaper
   * sections absorb the pressure instead; if none can, the snapshot stays
   * honestly over budget rather than blinding the agent to save ~1KB.
   */
  maxDemotionLevel?: number;
  /** Identity/warning tier — never demoted regardless of budget pressure. */
  neverEvict?: boolean;
  /**
   * Demotion priority — LOWER demotes first. Defaults to the section's array
   * index, so a section that sets nothing behaves exactly as it did before
   * ranks existed. Order sections cheapest-loss first, NOT in reading order.
   */
  demotionRank?: number;
}

/** Deepest rung the ladder may take a section to (floor-aware). */
function deepestLevel(s: BudgetSection): number {
  const available = s.demotions?.length ?? 0;
  return s.maxDemotionLevel === undefined ? available : Math.min(available, Math.max(0, s.maxDemotionLevel));
}

/** ~4 chars per token for mixed EN/markdown — same estimate `snapshot --tokens` uses. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Measured on Claude Code 2.1.216: hook stdout past 20,000 CHARS is persisted
 * to a tool-results file and only the first 2,000 chars reach the agent as a
 * blind positional preview. The budget default targets comfortably below the
 * persist limit (4,500 tok ≈ 18K chars) so the snapshot lands inline in full.
 */
export const HARNESS_PERSIST_CHAR_LIMIT = 20_000;
export const HARNESS_PREVIEW_CHARS = 2_000;

export const DEFAULT_SNAPSHOT_BUDGET_TOKENS = 4_500;

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
  /** Sections that were demoted, with the level applied (1-based). Array order. */
  demoted: Array<{ id: string; level: number }>;
  /** Token estimate of `text` INCLUDING the Budget-note footer. */
  estimatedTokens: number;
  /**
   * Whether the ladder failed to fit. Decided on the PRE-footer text: the
   * footer is a consequence of the verdict, so letting its ~350 chars flip the
   * verdict at the boundary would make the choice of footer circular.
   */
  overBudget: boolean;
  /** Total chars of the never-evict tier — the floor no ladder can lower. */
  neverEvictChars: number;
  /** Demoted sections sitting at their deepest allowed rung (array order). */
  flooredSectionIds: string[];
}

/**
 * Apply the budget. Sections are demoted in WAVES: first every demotable
 * section gets its level-1 render, then level-2, and so on. Within a wave the
 * ladder walks sections by `demotionRank` (cheapest loss first), NOT by the
 * order they render in. After each single demotion the total is re-checked so
 * the ladder stops at the first fitting state.
 *
 * If the snapshot still exceeds the budget after every ladder rung, it is
 * returned as-is (overBudget: true) — this module never raw-truncates.
 */
export function applyBudget(
  sections: BudgetSection[],
  budgetTokens: number | null,
): BudgetResult {
  // Resolved rungs, keyed by `${id}:${level}`. Keying by id alone would serve
  // rung 1's text for every deeper rung and silently freeze the ladder.
  const rungCache = new Map<string, string>();
  const rungText = (s: BudgetSection, level: number): string => {
    const key = `${s.id}:${level}`;
    const cached = rungCache.get(key);
    if (cached !== undefined) return cached;
    const rung = s.demotions![level - 1];
    const resolved = typeof rung === 'function' ? rung() : rung;
    rungCache.set(key, resolved);
    return resolved;
  };

  const render = (levels: Map<string, number>): string =>
    sections
      .map((s) => {
        const lvl = levels.get(s.id) ?? 0;
        return lvl === 0 ? s.text : rungText(s, lvl);
      })
      .filter((t) => t.trim() !== '')
      .join('\n');

  const neverEvictChars = sections
    .filter((s) => s.neverEvict)
    .reduce((total, s) => total + s.text.length, 0);

  const levels = new Map<string, number>();
  let text = render(levels);

  if (budgetTokens === null || estimateTokens(text) <= budgetTokens) {
    return {
      text,
      demoted: [],
      estimatedTokens: estimateTokens(text),
      overBudget: false,
      neverEvictChars,
      flooredSectionIds: [],
    };
  }

  // Demotion order, decoupled from render order. Stable: equal ranks (and the
  // no-rank case, where rank === index) preserve array order exactly.
  const byRank = sections
    .map((s, index) => ({ s, index }))
    .sort((a, b) => ((a.s.demotionRank ?? a.index) - (b.s.demotionRank ?? b.index)) || (a.index - b.index))
    .map((entry) => entry.s);

  const maxLevels = Math.max(0, ...sections.map((s) => deepestLevel(s)));
  outer:
  for (let level = 1; level <= maxLevels; level++) {
    for (const s of byRank) {
      if (s.neverEvict) continue;
      if (deepestLevel(s) < level) continue;
      levels.set(s.id, level);
      text = render(levels);
      if (estimateTokens(text) <= budgetTokens) break outer;
    }
  }

  // Both lists are built in array order so the footer reads top-to-bottom like
  // the document. A section is "floored" only once it has actually been taken
  // to its deepest allowed rung — one nobody touched has spare capacity, not a
  // floor.
  const demoted: Array<{ id: string; level: number }> = [];
  const flooredSectionIds: string[] = [];
  for (const s of sections) {
    const level = levels.get(s.id);
    if (level === undefined) continue;
    demoted.push({ id: s.id, level });
    if (level === deepestLevel(s)) flooredSectionIds.push(s.id);
  }

  // The verdict is taken BEFORE the footer exists, because the footer is chosen
  // from the verdict — measuring after the append would let ~350 chars of
  // footer decide which footer to append.
  const preFooterTokens = estimateTokens(text);
  const overBudget = preFooterTokens > budgetTokens;

  if (overBudget) {
    text += renderExhaustedFooter(demoted, flooredSectionIds, preFooterTokens, budgetTokens);
  } else if (demoted.length > 0) {
    text += renderFittedFooter(demoted);
  }

  return {
    text,
    demoted,
    estimatedTokens: estimateTokens(text),
    overBudget,
    neverEvictChars,
    flooredSectionIds,
  };
}

/**
 * The ladder ran and the snapshot FITS. Byte-identical to the pre-rank format —
 * small vaults and any vault whose ladder succeeds must see exactly this.
 */
function renderFittedFooter(demoted: Array<{ id: string }>): string {
  const ids = demoted.map((d) => d.id).join(', ');
  return [
    '\n\n---',
    `_Budget note: sections demoted to fit the snapshot budget (${ids}).`,
    'Nothing is lost — every demoted item keeps its file path above, and',
    '`dreamcontext memory recall "<keywords>"` surfaces the full content on demand._',
  ].join('\n');
}

/**
 * The ladder ran and the snapshot STILL does not fit. The old footer claimed
 * "nothing is lost" here too, which was the single most misleading line in the
 * snapshot: the ladder had stripped every section and lost anyway.
 *
 * Deliberately makes NO claim about being cut off — at this point the snapshot
 * is over the TOKEN budget but may still land inline and complete. Only the
 * caller knows whether the harness limit was crossed, and that is what
 * `renderOverBudgetBanner` is for.
 */
function renderExhaustedFooter(
  demoted: Array<{ id: string }>,
  flooredSectionIds: string[],
  tokens: number,
  budgetTokens: number,
): string {
  const ids = demoted.length > 0 ? demoted.map((d) => d.id).join(', ') : 'none — every section is never-evict';
  const floored = flooredSectionIds.length > 0 ? flooredSectionIds.join(', ') : 'none';
  return [
    '\n\n---',
    `_Budget note: the demotion ladder is EXHAUSTED and the snapshot is still over budget (${tokens} tok vs ${budgetTokens} tok).`,
    `Demoted: ${ids}. At their floor, unable to shrink further: ${floored}.`,
    'Every demoted item keeps its file path above, and `dreamcontext memory recall "<keywords>"` surfaces the full content —',
    'but you are reading a thinner brain than this project has. FIX: trim the oversized core files;',
    '`dreamcontext doctor` names them._',
  ].join('\n');
}

/**
 * The directive that must survive the harness's positional cut, verbatim.
 * Exported so the snapshot's injection site and its tests share one string —
 * this is the only instruction the agent is guaranteed to read when the hook
 * output is persisted to a file.
 */
export const OVERSIZED_SNAPSHOT_DIRECTIVE =
  '> ⚠️ OVERSIZED SNAPSHOT — if a "Full output saved to:" path appears above, you are ' +
  'reading a truncated 2KB preview. Read that full file NOW before doing anything else: ' +
  'the project brain (memory, decisions, tasks, knowledge index, warnings) is in it.';

/** Core files named in the banner before the rest collapse to a count. */
const DEFAULT_BANNER_MAX_CORE_FILES = 4;

export interface OverBudgetBannerInput {
  /** Rendered length of the snapshot, in chars. */
  chars: number;
  /** The ladder's char target (budget tokens × 4). */
  budgetChars: number;
  /** Chars held by the never-evict tier. */
  neverEvictChars: number;
  /** Ids of the never-evict sections, for the diagnosis. */
  neverEvictSectionIds: string[];
  /** Demotable sections that reached their deepest allowed rung. */
  flooredSectionIds: string[];
  /** Core files over `charCeiling` — the actionable cause, most useful first. */
  oversizedCoreFiles: Array<{ relPath: string; chars: number; lines: number }>;
  /** Per-core-file char ceiling being violated. */
  charCeiling: number;
  /**
   * How many core files to name before collapsing the rest to a count.
   * Defaults to 4 — the banner has to fit inside the preview window, and a
   * vault with a dozen core files would otherwise push the FIX out of it.
   * `snapshot-caps.ts` owns tuning; callers pass its constant here.
   */
  maxCoreFiles?: number;
}

/**
 * The loud banner for the one band that actually loses content: the rendered
 * snapshot is past HARNESS_PERSIST_CHAR_LIMIT, so the harness will persist it
 * and inject a positional slice. Two lines, both blockquotes, meant to be
 * placed immediately after the H1 so they land INSIDE the preview window —
 * a warning at the end of a file the agent never receives is not a warning.
 */
export function renderOverBudgetBanner(input: OverBudgetBannerInput): string {
  const n = (value: number): string => value.toLocaleString('en-US');
  const cap = input.maxCoreFiles ?? DEFAULT_BANNER_MAX_CORE_FILES;

  const neverEvict = input.neverEvictSectionIds.length > 0
    ? `${n(input.neverEvictChars)} chars are never-evict (${input.neverEvictSectionIds.join(', ')}).`
    : `${n(input.neverEvictChars)} chars are never-evict.`;

  const floored = input.flooredSectionIds.length > 0
    ? `At their floor, unable to shrink further: ${input.flooredSectionIds.join(', ')}.`
    : 'No section could be demoted any further.';

  const named = input.oversizedCoreFiles.slice(0, cap)
    .map((f) => `\`${f.relPath}\` (${n(f.chars)} chars / ${n(f.lines)} lines)`);
  const overflow = input.oversizedCoreFiles.length - named.length;
  const fix = named.length > 0
    ? `FIX: trim ${named.join(', ')}${overflow > 0 ? ` (+${overflow} more — \`dreamcontext doctor\`)` : ''} `
      + `— the ceiling is ${n(input.charCeiling)} chars per core file — by extracting detail to \`knowledge/\`.`
    : `FIX: no single core file is over the ${n(input.charCeiling)}-char ceiling, so the bulk is spread across the brain; `
      + 'extract detail from the largest sections into `knowledge/`.';

  const diagnosis =
    `> ⚠️ CONTEXT IS INCOMPLETE — the snapshot is ${n(input.chars)} chars: past the ladder's `
    + `${n(input.budgetChars)}-char target and over the ${n(HARNESS_PERSIST_CHAR_LIMIT)}-char harness limit. `
    + `${neverEvict} ${floored} ${fix} \`dreamcontext doctor\` reports this on every run.`;

  return `${OVERSIZED_SNAPSHOT_DIRECTIVE}\n${diagnosis}`;
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
