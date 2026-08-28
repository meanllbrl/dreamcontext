import { describe, it, expect } from 'vitest';
import { snapshotOf, diffThesis } from '../../dashboard/src/components/theses/thesis-seen';
import type { ThesisView } from '../../dashboard/src/hooks/useTheses';

/** Minimal valid ThesisView with overridable fields. */
function thesis(over: Partial<ThesisView> = {}): ThesisView {
  return {
    slug: 'test-thesis',
    claim: 'A falsifiable claim',
    status: 'open',
    kind: 'observational',
    confidence: 0.5,
    created_by: 'user',
    predictions: [],
    evidence: [],
    insights: [],
    objectives: [],
    related_tasks: [],
    related_workflows: [],
    blocked_on_instrumentation: false,
    blocked_metric: null,
    cycles_checked: 0,
    checked_at: null,
    promoted_to: null,
    created_at: '2026-08-01',
    updated_at: '2026-08-01',
    changelog: [],
    confidenceBreakdown: { confidence: 0.5, ws: 0, wc: 0, supports: 0, contradicts: 0, noSignal: 0 },
    ...over,
  };
}

const ev = (n: number) => Array.from({ length: n }, (_, i) => ({
  date: `2026-08-0${(i % 7) + 1}`, cycle: 1, source: 'task' as const, ref: null,
  verdict: 'supports' as const, note: 'x', quantitative: false,
}));

describe('snapshotOf', () => {
  it('captures updated_at, status, pct (0-100 int) and evidence count', () => {
    const t = thesis({ updated_at: '2026-08-05', status: 'validated', confidence: 0.876, evidence: ev(3) });
    expect(snapshotOf(t)).toEqual({ u: '2026-08-05', status: 'validated', pct: 88, ev: 3 });
  });

  it('clamps confidence into 0..100', () => {
    expect(snapshotOf(thesis({ confidence: 1.7 })).pct).toBe(100);
    expect(snapshotOf(thesis({ confidence: -0.2 })).pct).toBe(0);
  });
});

describe('diffThesis', () => {
  it('never-seen thesis is unread with the new-thesis summary', () => {
    expect(diffThesis(thesis(), undefined)).toEqual({ unread: true, summary: 'New — not opened yet' });
  });

  it('same updated_at means read, no summary', () => {
    const t = thesis();
    expect(diffThesis(t, snapshotOf(t))).toEqual({ unread: false, summary: null });
  });

  it('a flip to validated/invalidated leads the summary', () => {
    const before = snapshotOf(thesis({ status: 'open', updated_at: '2026-08-01' }));
    const after = thesis({ status: 'validated', updated_at: '2026-08-06' });
    expect(diffThesis(after, before).summary).toContain('Flipped validated');
  });

  it('non-flip status moves read as From → To', () => {
    const before = snapshotOf(thesis({ status: 'draft', updated_at: '2026-08-01' }));
    const after = thesis({ status: 'open', updated_at: '2026-08-02' });
    expect(diffThesis(after, before).summary).toContain('Draft → Open');
  });

  it('confidence movement and evidence delta are both reported, joined by ·', () => {
    const before = snapshotOf(thesis({ confidence: 0.61, evidence: ev(2), updated_at: '2026-08-01' }));
    const after = thesis({ confidence: 0.72, evidence: ev(4), updated_at: '2026-08-05' });
    const d = diffThesis(after, before);
    expect(d.unread).toBe(true);
    expect(d.summary).toBe('↑ confidence 61→72 · +2 evidence');
  });

  it('confidence drop uses the down arrow', () => {
    const before = snapshotOf(thesis({ confidence: 0.72, updated_at: '2026-08-01' }));
    const after = thesis({ confidence: 0.4, updated_at: '2026-08-05' });
    expect(diffThesis(after, before).summary).toBe('↓ confidence 72→40');
  });

  it('an updated_at bump with no visible field change still reads Updated', () => {
    const before = snapshotOf(thesis({ updated_at: '2026-08-01' }));
    const after = thesis({ updated_at: '2026-08-02' });
    expect(diffThesis(after, before)).toEqual({ unread: true, summary: 'Updated' });
  });
});
