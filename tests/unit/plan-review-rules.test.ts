import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PLAN_REVIEW_RULES, PLAN_REVISION_RECIPE, PLAN_STOP_CARD } from '../../src/lib/plan-review-rules.js';

/**
 * PLAN_REVIEW_RULES rides every packet AND lives in the reviewer agent file, so a lens
 * dispatched without a packet answers in the same format the ledger parses. One text, two
 * homes: this drift test holds them equal (pattern mirror-with-drift-test).
 */
const REVIEWER = readFileSync('skill-packs/agents/goal-plan-reviewer.md', 'utf-8');

describe('plan review rules', () => {
  it('the reviewer agent carries PLAN_REVIEW_RULES verbatim under its marker', () => {
    expect(REVIEWER).toContain(`<!-- Verbatim copy of PLAN_REVIEW_RULES (src/lib/plan-review-rules.ts); a drift test holds them equal. -->\n${PLAN_REVIEW_RULES}`);
  });

  it('the rules carry the full-list format, closing lines, classes and the Major calibration', () => {
    expect(PLAN_REVIEW_RULES).toContain('`<k>. [Critical|Major] id: <id|new> | class: <name> | kind: <premise|contract|security|criteria|map> |');
    expect(PLAN_REVIEW_RULES).toContain('`closed: <id> | <why>`');
    expect(PLAN_REVIEW_RULES).toMatch(/Major ONLY when the fix changes a contract, a gate, a criterion, the wave map or the\s+approach/);
    expect(PLAN_REVIEW_RULES).toMatch(/`class` is the invariant violated, not the spot/);
    expect(PLAN_REVIEW_RULES).toMatch(/`closed: <id> \| cut`/);
    expect(PLAN_REVIEW_RULES).toMatch(/`- cut\|defer\|premise:/);
  });

  it('the revision recipe is class-first and asks for a whole rewrite', () => {
    expect(PLAN_REVISION_RECIPE).toMatch(/take its CLASS/);
    expect(PLAN_REVISION_RECIPE).toMatch(/verify it against the code before adopting it/);
    expect(PLAN_REVISION_RECIPE).toMatch(/Rewrite plan\.md WHOLE/);
  });

  it('the stop card names Daralt, Böl and Devam', () => {
    expect([PLAN_STOP_CARD.narrow.label, PLAN_STOP_CARD.split.label, PLAN_STOP_CARD.continue.label]).toEqual(['Daralt', 'Böl', 'Devam']);
  });
});
