import { describe, it, expect } from 'vitest';
import {
  THESIS_RULE_PROMOTION_THRESHOLD,
  qualifiesForWorkflowRulePromotion,
  type EvidenceEvent,
  type ThesisManifest,
} from '../../src/lib/theses/types.js';

function evidence(count: number, overrides: Partial<EvidenceEvent> = {}): EvidenceEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    date: '2026-07-19',
    cycle: i + 1,
    source: 'insight',
    ref: null,
    note: '',
    verdict: 'supports',
    quantitative: false,
    ...overrides,
  }));
}

function makeThesis(overrides: Partial<ThesisManifest> = {}): ThesisManifest {
  return {
    slug: 'weekly-digests-improve-retention',
    claim: 'Weekly digests improve 30-day retention',
    status: 'validated',
    kind: 'observational',
    confidence: 0.8,
    created_by: 'sleep-learn',
    predictions: [],
    evidence: evidence(3, { verdict: 'supports', quantitative: true }),
    insights: [],
    objectives: [],
    related_tasks: [],
    related_workflows: ['some-workflow'],
    blocked_on_instrumentation: false,
    blocked_metric: null,
    cycles_checked: 3,
    checked_at: '2026-07-19',
    promoted_to: null,
    created_at: '2026-07-01',
    updated_at: '2026-07-19',
    path: '/tmp/theses/weekly-digests-improve-retention.md',
    body: '',
    changelog: [],
    ...overrides,
  };
}

describe('THESIS_RULE_PROMOTION_THRESHOLD — the pinned constant', () => {
  it('encodes the exact shared thresholds', () => {
    expect(THESIS_RULE_PROMOTION_THRESHOLD).toEqual({
      qualifyingStatuses: ['validated', 'invalidated'],
      minConfidenceDistance: 0.25,
      minEvidenceEvents: 3,
      requiresQuantitativeEvidence: true,
      requiresGovernsProcedure: true,
    });
  });
});

describe('qualifiesForWorkflowRulePromotion', () => {
  it('is true when every bar clears: validated status, far confidence, >=3 evidence, quantitative, governs a procedure', () => {
    expect(qualifiesForWorkflowRulePromotion(makeThesis())).toBe(true);
  });

  it('is true for invalidated status too (not just validated)', () => {
    expect(
      qualifiesForWorkflowRulePromotion(makeThesis({ status: 'invalidated', confidence: 0.1 })),
    ).toBe(true);
  });

  it('is false for a non-qualifying status (draft/open/retired)', () => {
    for (const status of ['draft', 'open', 'retired'] as const) {
      expect(qualifiesForWorkflowRulePromotion(makeThesis({ status }))).toBe(false);
    }
  });

  it('is false when confidence is not far enough from 0.5 (< 0.25 distance)', () => {
    expect(qualifiesForWorkflowRulePromotion(makeThesis({ confidence: 0.6 }))).toBe(false);
    // Exactly at the boundary (0.25 distance) should still qualify (>=).
    expect(qualifiesForWorkflowRulePromotion(makeThesis({ confidence: 0.75 }))).toBe(true);
  });

  it('is false with fewer than 3 supports+contradicts evidence events', () => {
    expect(
      qualifiesForWorkflowRulePromotion(
        makeThesis({ evidence: evidence(2, { verdict: 'supports', quantitative: true }) }),
      ),
    ).toBe(false);
  });

  it('no-signal evidence events do not count toward the >=3 evidence bar', () => {
    const mixed = [
      ...evidence(2, { verdict: 'supports', quantitative: true }),
      ...evidence(5, { verdict: 'no-signal', quantitative: true }),
    ];
    expect(qualifiesForWorkflowRulePromotion(makeThesis({ evidence: mixed }))).toBe(false);
  });

  it('is false without at least one quantitative evidence event', () => {
    expect(
      qualifiesForWorkflowRulePromotion(
        makeThesis({ evidence: evidence(3, { verdict: 'supports', quantitative: false }) }),
      ),
    ).toBe(false);
  });

  it('is false when related_workflows is empty — v1 never populates it, so this always gates promotion to the plain-knowledge path', () => {
    expect(qualifiesForWorkflowRulePromotion(makeThesis({ related_workflows: [] }))).toBe(false);
  });
});
