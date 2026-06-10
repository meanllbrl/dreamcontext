import { describe, it, expect } from 'vitest';

import {
  applyBudget, resolveBudget, estimateTokens, demoteMemoryBlock, demoteTaskList,
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

  it('drops empty sections from the render (matches legacy join behaviour)', () => {
    const sections: BudgetSection[] = [
      { id: 'a', text: 'A' },
      { id: 'empty', text: '   ' },
      { id: 'b', text: 'B' },
    ];
    expect(applyBudget(sections, null).text).toBe('A\nB');
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
