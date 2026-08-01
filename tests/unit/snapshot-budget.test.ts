import { describe, it, expect, vi } from 'vitest';

import {
  applyBudget, resolveBudget, estimateTokens, demoteMemoryBlock, demoteTaskList,
  renderOverBudgetBanner, OVERSIZED_SNAPSHOT_DIRECTIVE,
  DEFAULT_SNAPSHOT_BUDGET_TOKENS, type BudgetSection,
} from '../../src/lib/snapshot-budget.js';

const big = (chars: number): string => 'x'.repeat(chars);

describe('resolveBudget', () => {
  it('defaults when unset, disables on 0/off, clamps to a 2000 floor', () => {
    expect(resolveBudget(undefined)).toBe(DEFAULT_SNAPSHOT_BUDGET_TOKENS);
    expect(resolveBudget('')).toBe(DEFAULT_SNAPSHOT_BUDGET_TOKENS);
    expect(resolveBudget('0')).toBeNull();
    expect(resolveBudget('off')).toBeNull();
    expect(resolveBudget('15000')).toBe(15000);
    expect(resolveBudget('500')).toBe(2000);
    expect(resolveBudget('garbage')).toBe(DEFAULT_SNAPSHOT_BUDGET_TOKENS);
  });
});

describe('applyBudget', () => {
  it('returns the full render byte-identical when under budget', () => {
    const sections: BudgetSection[] = [
      { id: 'a', text: '## A\nfull', demotions: ['## A\nsmall'] },
      { id: 'b', text: '## B\nfull', neverEvict: true },
    ];
    const res = applyBudget(sections, 10_000);
    expect(res.text).toBe('## A\nfull\n## B\nfull');
    expect(res.demoted).toEqual([]);
    expect(res.overBudget).toBe(false);
  });

  it('no budget (null) means legacy unbounded behaviour', () => {
    const sections: BudgetSection[] = [
      { id: 'a', text: big(100_000), demotions: ['tiny'] },
    ];
    const res = applyBudget(sections, null);
    expect(res.text).toBe(big(100_000));
    expect(res.demoted).toEqual([]);
  });

  it('demotes in section order and stops as soon as the snapshot fits', () => {
    const sections: BudgetSection[] = [
      { id: 'cheap', text: big(8000), demotions: [big(100)] },
      { id: 'valuable', text: big(8000), demotions: [big(100)] },
    ];
    // 16000 chars = 4000 tokens. Budget 3000: demoting `cheap` alone (8100
    // chars ≈ 2025 tokens + footer) is enough — `valuable` must stay full.
    const res = applyBudget(sections, 3000);
    expect(res.demoted.map((d) => d.id)).toEqual(['cheap']);
    expect(res.text).toContain(big(8000));
    expect(res.overBudget).toBe(false);
  });

  it('walks deeper ladder rungs in waves when level 1 is not enough', () => {
    const sections: BudgetSection[] = [
      { id: 'a', text: big(20_000), demotions: [big(10_000), big(50)] },
      { id: 'b', text: big(20_000), demotions: [big(10_000), big(50)] },
    ];
    const res = applyBudget(sections, 3000);
    // Wave 1 (a→L1, b→L1) leaves ~5000 tokens; wave 2 demotes further.
    expect(res.demoted.find((d) => d.id === 'a')?.level).toBe(2);
    expect(res.overBudget).toBe(false);
  });

  it('NEVER demotes neverEvict sections, even when that means staying over budget', () => {
    const sections: BudgetSection[] = [
      { id: 'identity', text: big(40_000), neverEvict: true },
      { id: 'a', text: big(4000), demotions: [big(10)] },
    ];
    const res = applyBudget(sections, 3000);
    expect(res.text).toContain(big(40_000));
    expect(res.overBudget).toBe(true); // honest reporting, no raw truncation
  });

  it('appends a recovery footer naming the demoted sections', () => {
    const sections: BudgetSection[] = [
      { id: 'features', text: big(20_000), demotions: ['## Features\n- compact'] },
    ];
    const res = applyBudget(sections, 2000);
    expect(res.text).toContain('Budget note');
    expect(res.text).toContain('features');
    expect(res.text).toContain('memory recall');
  });

  // ── maxDemotionLevel: the floor that keeps Lab's metric names + values in
  //    context under any budget pressure (see snapshot.ts § renderLabSection).
  const rung = (marker: string, chars: number): string => `${marker}\n${big(chars)}`;

  it('stops at maxDemotionLevel and makes another section absorb the pressure', () => {
    const sections: BudgetSection[] = [
      // Floored at rung 1: rung 2 exists but is off-limits.
      { id: 'lab', text: rung('LAB_FULL', 20_000), demotions: [rung('LAB_L1', 9000), rung('LAB_L2', 20)], maxDemotionLevel: 1 },
      { id: 'features', text: rung('FEAT_FULL', 20_000), demotions: [rung('FEAT_L1', 9000), rung('FEAT_L2', 20)] },
    ];
    const res = applyBudget(sections, 3000);
    expect(res.demoted.find((d) => d.id === 'lab')?.level).toBe(1);
    expect(res.demoted.find((d) => d.id === 'features')?.level).toBe(2);
    expect(res.text).toContain('LAB_L1');       // lab kept its rung-1 content…
    expect(res.text).not.toContain('LAB_L2');   // …and never reached the floor-blocked rung
    expect(res.text).toContain('FEAT_L2');      // the unfloored section absorbed the pressure
    expect(res.overBudget).toBe(false);
  });

  it('honours the floor even when that means staying over budget', () => {
    const sections: BudgetSection[] = [
      { id: 'lab', text: rung('LAB_FULL', 40_000), demotions: [rung('LAB_L1', 30_000), rung('LAB_L2', 20)], maxDemotionLevel: 1 },
    ];
    const res = applyBudget(sections, 3000);
    expect(res.demoted).toEqual([{ id: 'lab', level: 1 }]);
    expect(res.text).toContain('LAB_L1');
    expect(res.text).not.toContain('LAB_L2');
    expect(res.overBudget).toBe(true); // honestly over budget, not blinded
  });

  it('maxDemotionLevel 0 pins a section to its full render without neverEvict', () => {
    const sections: BudgetSection[] = [
      { id: 'pinned', text: rung('PIN_FULL', 20_000), demotions: [rung('PIN_L1', 20)], maxDemotionLevel: 0 },
      { id: 'other', text: rung('OTHER_FULL', 20_000), demotions: [rung('OTHER_L1', 20)] },
    ];
    const res = applyBudget(sections, 3000);
    expect(res.demoted.map((d) => d.id)).toEqual(['other']);
    expect(res.text).toContain('PIN_FULL');
    expect(res.text).not.toContain('PIN_L1');
  });

  it('a floor above the available rungs is harmless (clamped to what exists)', () => {
    const sections: BudgetSection[] = [
      { id: 'a', text: rung('A_FULL', 20_000), demotions: [rung('A_L1', 20)], maxDemotionLevel: 9 },
    ];
    const res = applyBudget(sections, 3000);
    expect(res.demoted).toEqual([{ id: 'a', level: 1 }]);
    expect(res.text).toContain('A_L1');
    expect(res.overBudget).toBe(false);
  });

  it('drops empty sections from the render (matches legacy join behaviour)', () => {
    const sections: BudgetSection[] = [
      { id: 'a', text: 'A' },
      { id: 'empty', text: '   ' },
      { id: 'b', text: 'B' },
    ];
    expect(applyBudget(sections, null).text).toBe('A\nB');
  });

  // ── demotionRank: demotion order is decoupled from render order. Identity
  //    renders near the TOP of the snapshot; without ranks it would be the
  //    first thing gutted and warm knowledge the last — exactly backwards.
  describe('demotionRank', () => {
    it('demotes by rank, not by the order sections render in', () => {
      const sections: BudgetSection[] = [
        { id: 'identity', text: rung('IDENTITY_FULL', 8000), demotions: [rung('IDENTITY_L1', 20)], demotionRank: 100 },
        { id: 'warm', text: rung('WARM_FULL', 8000), demotions: [rung('WARM_L1', 20)], demotionRank: 10 },
      ];
      const res = applyBudget(sections, 2100);
      expect(res.demoted.map((d) => d.id)).toEqual(['warm']);
      expect(res.text).toContain('IDENTITY_FULL'); // rendered first, demoted last
      expect(res.text).toContain('WARM_L1');
      // Render order is untouched — identity still precedes warm in the output.
      expect(res.text.indexOf('IDENTITY_FULL')).toBeLessThan(res.text.indexOf('WARM_L1'));
    });

    it('falls back to the array index when a section sets no rank (pre-rank behaviour)', () => {
      const sections: BudgetSection[] = [
        { id: 'first', text: rung('FIRST_FULL', 8000), demotions: [rung('FIRST_L1', 20)] },
        { id: 'second', text: rung('SECOND_FULL', 8000), demotions: [rung('SECOND_L1', 20)] },
      ];
      const res = applyBudget(sections, 2100);
      expect(res.demoted.map((d) => d.id)).toEqual(['first']);
    });

    it('an unranked section outranks the whole 10-160 scale (why every demotable section needs a rank)', () => {
      const sections: BudgetSection[] = [
        { id: 'unranked', text: rung('U_FULL', 8000), demotions: [rung('U_L1', 20)] }, // index 0 → rank 0
        { id: 'ranked', text: rung('R_FULL', 8000), demotions: [rung('R_L1', 20)], demotionRank: 5 },
      ];
      const res = applyBudget(sections, 2100);
      expect(res.demoted.map((d) => d.id)).toEqual(['unranked']);
    });
  });

  // ── Lazy rungs. SessionStart is a hot path and the common case is a snapshot
  //    that already fits, so a rung nobody uses must cost nothing.
  describe('lazy rungs', () => {
    it('resolves ZERO thunks when the snapshot is already under budget', () => {
      const thunk = vi.fn(() => 'tiny');
      const res = applyBudget([{ id: 'a', text: 'small', demotions: [thunk] }], 10_000);
      expect(thunk).not.toHaveBeenCalled();
      expect(res.text).toBe('small');
    });

    it('resolves ZERO thunks when the budget is disabled', () => {
      const thunk = vi.fn(() => 'tiny');
      applyBudget([{ id: 'a', text: big(100_000), demotions: [thunk] }], null);
      expect(thunk).not.toHaveBeenCalled();
    });

    it('resolves a thunk exactly once even though the ladder re-renders after every demotion', () => {
      const thunk = vi.fn(() => big(2000));
      applyBudget([
        { id: 'a', text: big(20_000), demotions: [thunk] },
        { id: 'b', text: big(20_000), demotions: [big(2000)] },
        { id: 'c', text: big(20_000), demotions: [big(10)] },
      ], 1000);
      // Three demotions ⇒ three full re-renders, but `a`'s rung is memoized.
      expect(thunk).toHaveBeenCalledTimes(1);
    });

    it('memoizes per (section, level) — a rung-2 lookup must not serve rung-1 text', () => {
      // Regression: an id-only memo key returns L1 for every deeper rung, so the
      // ladder silently freezes at level 1 and the snapshot never fits.
      const res = applyBudget([{
        id: 'ladder',
        text: big(40_000),
        demotions: [() => `L1${big(9000)}`, () => `L2${big(5000)}`, () => `L3${big(20)}`],
      }], 1000);
      expect(res.demoted).toEqual([{ id: 'ladder', level: 3 }]);
      expect(res.text).toContain('L3');
      expect(res.text).not.toContain('L1');
      expect(res.text).not.toContain('L2');
      expect(res.overBudget).toBe(false);
    });

    it('accepts plain-string rungs unchanged (every current call site passes string[])', () => {
      const res = applyBudget([{ id: 'a', text: big(20_000), demotions: ['compact'] }], 1000);
      expect(res.text.startsWith('compact')).toBe(true);
    });
  });

  // ── neverEvictChars / flooredSectionIds: what `doctor` and the banner need to
  //    tell the user WHY the snapshot lost, not just that it did.
  describe('diagnostics', () => {
    it('reports neverEvictChars on the under-budget early return', () => {
      const res = applyBudget([
        { id: 'pinned', text: big(1000), neverEvict: true },
        { id: 'a', text: big(500) },
      ], 10_000);
      expect(res.overBudget).toBe(false);
      expect(res.neverEvictChars).toBe(1000);
      expect(res.flooredSectionIds).toEqual([]);
    });

    it('reports neverEvictChars when the budget is disabled (doctor runs under BUDGET=off)', () => {
      const res = applyBudget([
        { id: 'pinned', text: big(40_000), neverEvict: true },
        { id: 'a', text: big(500) },
      ], null);
      expect(res.neverEvictChars).toBe(40_000);
      expect(res.flooredSectionIds).toEqual([]);
    });

    it('reports neverEvictChars on the demotion path', () => {
      const res = applyBudget([
        { id: 'identity', text: big(40_000), neverEvict: true },
        { id: 'a', text: big(4000), demotions: [big(10)] },
      ], 3000);
      expect(res.neverEvictChars).toBe(40_000);
    });

    it('floors list every section taken to its deepest ALLOWED rung, floor or not', () => {
      const res = applyBudget([
        { id: 'lab', text: rung('LAB_FULL', 20_000), demotions: [rung('LAB_L1', 9000), rung('LAB_L2', 20)], maxDemotionLevel: 1 },
        { id: 'features', text: rung('FEAT_FULL', 20_000), demotions: [rung('FEAT_L1', 9000), rung('FEAT_L2', 20)] },
      ], 3000);
      expect(res.flooredSectionIds).toEqual(['lab', 'features']);
    });

    it('a section the ladder never reached is not floored — it still has capacity', () => {
      const res = applyBudget([
        { id: 'cheap', text: big(8000), demotions: [big(100)] },
        { id: 'valuable', text: big(8000), demotions: [big(100)] },
      ], 3000);
      expect(res.demoted.map((d) => d.id)).toEqual(['cheap']);
      expect(res.flooredSectionIds).toEqual(['cheap']);
    });
  });

  // ── The two footers.
  describe('budget footers', () => {
    it('the FITTED footer is byte-identical to the pre-rank format', () => {
      const res = applyBudget([{ id: 'features', text: big(20_000), demotions: ['## Features\n- compact'] }], 2000);
      expect(res.overBudget).toBe(false);
      expect(res.text).toBe(
        '## Features\n- compact'
        + '\n\n---'
        + '\n_Budget note: sections demoted to fit the snapshot budget (features).'
        + '\nNothing is lost — every demoted item keeps its file path above, and'
        + '\n`dreamcontext memory recall "<keywords>"` surfaces the full content on demand._',
      );
    });

    it('the EXHAUSTED footer says the ladder lost and drops the old "nothing is lost" claim', () => {
      const res = applyBudget([
        { id: 'identity', text: big(40_000), neverEvict: true },
        { id: 'a', text: big(4000), demotions: [big(10)] },
      ], 3000);
      expect(res.overBudget).toBe(true);
      expect(res.text).toContain('Budget note');   // the token every caller greps for
      expect(res.text).toContain('EXHAUSTED');
      expect(res.text).toContain('a');             // names what was demoted
      expect(res.text).not.toContain('Nothing is lost');
    });

    it('the EXHAUSTED footer makes NO claim about being cut off — that band is the banner\'s job', () => {
      // Over the TOKEN budget is not the same as past the harness limit: the
      // snapshot may still land inline and complete, so claiming a preview here
      // would be false.
      const res = applyBudget([
        { id: 'identity', text: big(40_000), neverEvict: true },
        { id: 'a', text: big(4000), demotions: [big(10)] },
      ], 3000);
      const footer = res.text.slice(res.text.indexOf('_Budget note:'));
      expect(footer).not.toMatch(/preview|truncated/i);
    });

    it('warns even when nothing was demotable at all', () => {
      const res = applyBudget([{ id: 'identity', text: big(40_000), neverEvict: true }], 3000);
      expect(res.overBudget).toBe(true);
      expect(res.demoted).toEqual([]);
      expect(res.text).toContain('Budget note');
      // Not "every section is never-evict" — a compliant memory file is
      // demotable-typed with no rungs, so an empty list doesn't imply that.
      expect(res.text).toContain('nothing the ladder can shrink');
    });

    it('decides overBudget on the PRE-footer text, so the footer cannot flip its own variant', () => {
      // 4,000 chars is exactly 1,000 tokens — a fit. Appending the ~200-char
      // footer pushes the POST-footer estimate over. Deciding after the append
      // would report overBudget and emit the exhausted footer for a snapshot
      // that demonstrably fit.
      const res = applyBudget([{ id: 'big', text: big(20_000), demotions: [big(4000)] }], 1000);
      expect(res.overBudget).toBe(false);
      expect(res.text).toContain('Nothing is lost');
      expect(res.text).not.toContain('EXHAUSTED');
      // estimatedTokens stays the POST-footer count — it describes the string returned.
      expect(res.estimatedTokens).toBe(Math.ceil(res.text.length / 4));
      expect(res.estimatedTokens).toBeGreaterThan(1000);
    });
  });

  // ── The split lemma. Section splitting is how the never-evict tier gets
  //    unbundled (soul/user out of `identity`, bookmarks out of `awareness`), so
  //    the byte-neutrality of a split is load-bearing for the whole rework.
  describe('split lemma', () => {
    it('splitting a section at ANY element boundary is byte-neutral', () => {
      const parts = ['# H1\n', '## Soul\n', 'soul body', '', '## User\n', 'user body', ''];
      const whole: BudgetSection[] = [{ id: 'identity', text: parts.join('\n') }];
      const split: BudgetSection[] = [
        { id: 'header', text: parts.slice(0, 1).join('\n') },
        { id: 'soul', text: parts.slice(1, 4).join('\n') },
        { id: 'user', text: parts.slice(4).join('\n') },
      ];
      expect(applyBudget(split, null).text).toBe(applyBudget(whole, null).text);
    });

    it('…except when a group is whitespace-only: the render drops it AND its newline', () => {
      const whole: BudgetSection[] = [{ id: 'a', text: ['X', '', 'Y'].join('\n') }];
      const split: BudgetSection[] = [
        { id: 'a1', text: 'X' },
        { id: 'blank', text: '' },
        { id: 'a2', text: 'Y' },
      ];
      expect(applyBudget(whole, null).text).toBe('X\n\nY');
      expect(applyBudget(split, null).text).toBe('X\nY');
    });
  });
});

describe('renderOverBudgetBanner', () => {
  const input = (overrides: Partial<Parameters<typeof renderOverBudgetBanner>[0]> = {}) => ({
    chars: 24_010,
    budgetChars: 18_000,
    neverEvictChars: 18_900,
    neverEvictSectionIds: ['header', 'linked-repos', 'awareness'],
    flooredSectionIds: ['memory', 'knowledge-index', 'features'],
    oversizedCoreFiles: [{ relPath: '_dream_context/core/0.soul.md', chars: 32_598, lines: 109 }],
    charCeiling: 4_000,
    ...overrides,
  });

  it('opens with the persist-cut directive, byte-for-byte', () => {
    // This is the only instruction guaranteed to reach the agent when the hook
    // output is persisted, so it is pinned as a literal in both directions.
    expect(OVERSIZED_SNAPSHOT_DIRECTIVE).toBe(
      '> ⚠️ OVERSIZED SNAPSHOT — if a "Full output saved to:" path appears above, you are '
      + 'reading a truncated 2KB preview. Read that full file NOW before doing anything else: '
      + 'the project brain (memory, decisions, tasks, knowledge index, warnings) is in it.',
    );
    expect(renderOverBudgetBanner(input()).split('\n')[0]).toBe(OVERSIZED_SNAPSHOT_DIRECTIVE);
  });

  it('diagnoses the never-evict tier, the floors, and the actionable fix', () => {
    const banner = renderOverBudgetBanner(input());
    expect(banner).toContain('CONTEXT IS INCOMPLETE');
    expect(banner).toContain('24,010 chars');
    expect(banner).toContain("18,000-char target");
    expect(banner).toContain('20,000-char harness limit');
    expect(banner).toContain('18,900 chars are never-evict (header, linked-repos, awareness)');
    expect(banner).toContain('memory, knowledge-index, features');
    expect(banner).toContain('`_dream_context/core/0.soul.md` (32,598 chars / 109 lines)');
    expect(banner).toContain('4,000 chars per core file');
    expect(banner).toContain('`dreamcontext doctor`');
  });

  it('is exactly two blockquote lines, so it survives being spliced after the H1', () => {
    const lines = renderOverBudgetBanner(input()).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.startsWith('> '))).toBe(true);
  });

  it('says "never-evict", never "pinned" — 📌 already means something else in the snapshot', () => {
    expect(renderOverBudgetBanner(input())).toContain('never-evict');
    expect(renderOverBudgetBanner(input())).not.toMatch(/pinned/i);
  });

  it('names at most 4 core files and counts the rest, so the FIX stays in the preview window', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ relPath: `core/${i}.md`, chars: 9000, lines: 200 }));
    const banner = renderOverBudgetBanner(input({ oversizedCoreFiles: files }));
    expect(banner).toContain('core/0.md');
    expect(banner).toContain('core/3.md');
    expect(banner).not.toContain('core/4.md');
    expect(banner).toContain('(+8 more');
  });

  it('honours an explicit cap from the caller', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ relPath: `core/${i}.md`, chars: 9000, lines: 200 }));
    const banner = renderOverBudgetBanner(input({ oversizedCoreFiles: files, maxCoreFiles: 2 }));
    expect(banner).toContain('core/1.md');
    expect(banner).not.toContain('core/2.md');
    expect(banner).toContain('(+3 more');
  });

  it('degrades to a generic fix when no single core file is over the ceiling', () => {
    const banner = renderOverBudgetBanner(input({ oversizedCoreFiles: [] }));
    expect(banner).toContain('no single core file is over the 4,000-char ceiling');
    expect(banner).not.toContain('(+0 more');
  });

  it('degrades cleanly when nothing could be demoted', () => {
    const banner = renderOverBudgetBanner(input({ flooredSectionIds: [], neverEvictSectionIds: [] }));
    expect(banner).toContain('No section could be demoted any further.');
    expect(banner).toContain('18,900 chars are never-evict.');
  });
});

describe('demoteMemoryBlock', () => {
  const block = [
    '## Memory (Technical Decisions, Known Issues, Session Log)\n',
    '## Active Memory',
    'current focus line',
    '',
    '## Technical Decisions',
    '',
    '- **decision one (2026-06-09)**: newest, with detail',
    '  wrapped continuation line',
    '- **decision two (2026-06-06)**: second',
    '- **decision three (2026-06-05)**: third',
    '- plain bullet without bold title that is quite long and rambles on past ninety characters total length',
    '',
    '## Known Issues',
    '- issue stays',
    '',
  ].join('\n');

  it('keeps the newest N decisions full and collapses the rest to titles', () => {
    const out = demoteMemoryBlock(block, 2);
    expect(out).toContain('- **decision one (2026-06-09)**: newest, with detail');
    expect(out).toContain('wrapped continuation line');
    expect(out).toContain('- **decision two (2026-06-06)**: second');
    expect(out).not.toContain('third');
    expect(out).toContain('- decision three (2026-06-05)');
    expect(out).toContain('Older decisions (2');
    // Long plain bullet gets a capped title:
    expect(out).toMatch(/- plain bullet without bold title.*\.\.\./);
  });

  it('never touches Active Memory or Known Issues', () => {
    const out = demoteMemoryBlock(block, 1);
    expect(out).toContain('current focus line');
    expect(out).toContain('- issue stays');
  });

  it('is a no-op when there are fewer decisions than the keep count', () => {
    expect(demoteMemoryBlock(block, 10)).toBe(block);
  });

  it('is a no-op when the block has no Technical Decisions section', () => {
    const noDecisions = '## Memory\n\n## Known Issues\n- only issues';
    expect(demoteMemoryBlock(noDecisions, 2)).toBe(noDecisions);
  });
});

describe('demoteTaskList', () => {
  it('caps the list and reports the remainder with the recovery command', () => {
    const entries = ['- t1', '- t2', '- t3', '- t4'];
    const out = demoteTaskList(entries, 2);
    expect(out).toHaveLength(3);
    expect(out[2]).toContain('+2 more');
    expect(out[2]).toContain('tasks list');
  });

  it('is a no-op at or under the cap', () => {
    const entries = ['- t1', '- t2'];
    expect(demoteTaskList(entries, 2)).toEqual(entries);
  });
});
