/**
 * The quest view model (dashboard/src/lib/quest.ts) and the goal-live v3 normalizer
 * (dashboard/src/lib/goalLive.ts).
 *
 * The load-bearing promises: a verdict is read only where a judge actually wrote one; a
 * legacy live file still renders; and the "reused" number in the receipt is exactly the sum of
 * measured copies, or absent. Never an estimate.
 */

import { describe, it, expect } from 'vitest';
import {
  JARGON_RE, branchCaption, formatQuestElapsed, formatQuestTokens, freshExplainer, goalLineage, goalQuest,
  lineageNote, questVictoryCopy, verdictOf,
  type QuestLineageNode, type QuestView,
} from '../../dashboard/src/lib/quest.js';
import { GOAL_LIVE_CAPS, normalizeGoalLive, type GoalLiveState } from '../../dashboard/src/lib/goalLive.js';

const T0 = Date.parse('2026-09-25T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

describe('verdictOf', () => {
  it('reads the verdict a judge LEADS with', () => {
    expect(verdictOf('SOLID with one nit — no blocking findings')).toBe('solid');
    expect(verdictOf('NEEDS_WORK — three blocking findings')).toBe('needs-work');
    expect(verdictOf('NEEDS WORK: the retry path is unowned')).toBe('needs-work');
    expect(verdictOf('## Review: FAIL\n\n### Critical')).toBe('fail');
    expect(verdictOf('PASS\nvalidation: npm test, 812 passed')).toBe('pass');
    expect(verdictOf('**Verdict:** SOLID')).toBe('solid');
    expect(verdictOf('## Frontend review\n\nSOLID with one nit.')).toBe('solid');
  });

  it('never reads a verdict the judge did not give', () => {
    expect(verdictOf('Previously SOLID, now the plan changed')).toBeNull();
    expect(verdictOf('## Review: PASS | FAIL')).toBeNull();
    expect(verdictOf('The suite passes on my machine')).toBeNull();
    expect(verdictOf('solid work overall')).toBeNull();
    expect(verdictOf('')).toBeNull();
    expect(verdictOf(null)).toBeNull();
    expect(verdictOf(undefined)).toBeNull();
  });

  it('looks no further than the first three lines', () => {
    expect(verdictOf('one\ntwo\nthree\nSOLID')).toBeNull();
  });
});

describe('normalizeGoalLive', () => {
  it('rejects anything with no phase to render', () => {
    expect(normalizeGoalLive(null)).toBeNull();
    expect(normalizeGoalLive([])).toBeNull();
    expect(normalizeGoalLive('impl')).toBeNull();
    expect(normalizeGoalLive({ goal: 'x' })).toBeNull();
  });

  it('keeps a legacy v1 file intact', () => {
    const legacy = { goal: 'demo', started: at(0), updated: at(60), phase: 'impl', iters: { plan: 2 }, impl: { wave: 1, waves: 3, forks: [{ s: 'run' }, { s: 'done' }] } };
    expect(normalizeGoalLive(legacy)).toEqual(legacy);
  });

  it('folds an unknown fork state to wait, drops junk, caps strings', () => {
    const n = normalizeGoalLive({
      phase: 'impl',
      impl: { forks: [{ s: 'exploded', name: 'x'.repeat(200) }, 'nonsense', { s: 'run', id: 'T1', role: 42 }] },
      iters: { plan: -1, review: 2, impl: 'many' },
    })!;
    expect(n.impl!.forks).toEqual([{ s: 'wait', name: 'x'.repeat(60) }, { s: 'run', id: 'T1' }]);
    expect(n.iters).toEqual({ review: 2 });
  });

  it('caps every list', () => {
    const many = (k: number, f: (i: number) => unknown) => Array.from({ length: k }, (_, i) => f(i));
    const n = normalizeGoalLive({
      phase: 'impl',
      impl: { forks: many(20, () => ({ s: 'run' })) },
      judges: many(20, () => ({ s: 'run' })),
      history: many(50, (i) => ({ p: 'impl', at: at(i) })),
      lineage: many(80, (i) => ({ a: `T${i}`, role: 'implementer', k: 'fork', at: at(i) })),
    })!;
    expect(n.impl!.forks).toHaveLength(GOAL_LIVE_CAPS.forks);
    expect(n.judges).toHaveLength(GOAL_LIVE_CAPS.judges);
    expect(n.history).toHaveLength(GOAL_LIVE_CAPS.history);
    expect(n.history![0].at).toBe(at(10)); // the LAST 40 survive
    expect(n.lineage).toHaveLength(GOAL_LIVE_CAPS.lineage);
    expect(n.lineage![0].a).toBe('T20');
  });

  it('drops unknown lineage kinds and keeps ctx on measured forks only', () => {
    const n = normalizeGoalLive({
      phase: 'impl',
      lineage: [
        { a: 'planner', role: 'planner', k: 'spawn', ctx: 5000 },
        { a: 'x', role: 'agent', k: 'teleport' },
        { a: 'planner', role: 'planner', k: 'resume', r: 2, ctx: 9000 },
        { a: 'T1', role: 'implementer', k: 'fork', from: 'planner', ctx: 182000 },
        { a: 'T2', role: 'implementer', k: 'fork', from: 'planner', ctx: 1.5 },
        { a: 'T3', role: 'implementer', k: 'fork', from: 'planner', ctx: '182000' },
        { role: 'implementer', k: 'fork' },
      ],
    })!;
    expect(n.lineage!.map((e) => e.a)).toEqual(['planner', 'planner', 'T1', 'T2', 'T3']);
    expect(n.lineage!.map((e) => e.ctx)).toEqual([undefined, undefined, 182000, undefined, undefined]);
  });
});

// ─── A full goal-skill run, the fixture the verify script also writes ──────────────

const LENSES = ['critic', 'pragmatist', 'edge-cases'] as const;
const fresh = (r: number, s: number) => LENSES.map((a, i) => ({ a, role: a, k: 'fresh' as const, r, at: at(s + i) }));
const forks = (ctx?: number) => ['T1', 'T2', 'T3'].map((a, i) => ({
  a, role: 'implementer', k: 'fork' as const, from: 'planner', name: ['Role registry', 'Tokens', 'Verify'][i], at: at(400 + i),
  ...(ctx != null ? { ctx } : {}),
}));

function doneRun(ctx?: number): GoalLiveState {
  return normalizeGoalLive({
    goal: 'quest-demo', started: at(0), updated: at(1080), phase: 'done',
    iters: { plan: 2, review: 2, impl: 1, codereview: 1, validate: 1 },
    impl: { wave: 1, waves: 1, forks: [{ s: 'done', id: 'T1', name: 'Role registry', role: 'implementer' }] },
    judges: [{ s: 'done', id: 'validator', role: 'validator', v: 'PASS' }],
    history: [{ p: 'plan', at: at(0) }, { p: 'review', at: at(60) }, { p: 'impl', at: at(400) }, { p: 'done', at: at(1080) }],
    lineage: [
      { a: 'planner', role: 'planner', k: 'spawn', r: 1, at: at(1) },
      ...fresh(1, 60),
      { a: 'planner', role: 'planner', k: 'resume', r: 2, at: at(120) },
      ...fresh(2, 180),
      ...forks(ctx),
      { a: 'reviewer', role: 'reviewer', k: 'fresh', r: 1, at: at(900) },
      { a: 'validator', role: 'validator', k: 'fresh', r: 1, at: at(1000) },
    ],
  })!;
}

describe('goalLineage', () => {
  it('merges an actor into ONE node: first kind, union of rounds, the return in its note', () => {
    const lin = goalLineage(doneRun(182000))!;
    expect(lin.root.label).toBe('Claude');
    const planner = lin.root.children.find((c) => c.key === 'planner')!;
    expect(lin.root.children.filter((c) => c.key === 'planner')).toHaveLength(1);
    expect(planner.kind).toBe('spawn');
    expect(planner.rounds).toEqual([1, 2]);
    expect(planner.note).toBe('Briefed by Claude · picked up where it left off · round 2');
    expect(planner.carries).toBe('memory');
  });

  it('hangs the copies under the actor they came from', () => {
    const planner = goalLineage(doneRun(182000))!.root.children.find((c) => c.key === 'planner')!;
    expect(planner.children.map((c) => c.key)).toEqual(['T1', 'T2', 'T3']);
    const t1 = planner.children[0];
    expect(t1.label).toBe('Builder T1 Role registry');
    expect(t1.note).toBe("Started with the Planner's full memory · 182k tokens not rebuilt");
    expect(t1.carries).toBe('memory');
  });

  it('judges hang under the lead with fresh eyes and their rounds', () => {
    const lin = goalLineage(doneRun(182000))!;
    const critic = lin.root.children.find((c) => c.key === 'critic')!;
    expect(critic.rounds).toEqual([1, 2]);
    expect(critic.carries).toBe('fresh');
    expect(critic.note).toBe('Fresh eyes: sees only the work, never the reasoning');
    const validator = lin.root.children.find((c) => c.key === 'validator')!;
    expect(validator.verdict).toBe('pass');
  });

  it('reusedTokens is the exact sum of measured copies', () => {
    const lin = goalLineage(doneRun(182000))!;
    expect(lin.reusedTokens).toBe(546000);
    expect(formatQuestTokens(lin.reusedTokens!)).toBe('546k');
    expect([lin.copies, lin.returns, lin.fresh]).toEqual([3, 1, 8]);
  });

  it('is null unless EVERY copy was measured, and never counts a return', () => {
    expect(goalLineage(doneRun())!.reusedTokens).toBeNull();
    const partial = doneRun(182000);
    delete partial.lineage![partial.lineage!.findIndex((e) => e.a === 'T2')].ctx;
    expect(goalLineage(partial)!.reusedTokens).toBeNull();
    // A return that claims a number is dropped at the boundary, and never summed.
    const withResumeCtx = normalizeGoalLive({ ...doneRun(182000), lineage: [...doneRun(182000).lineage!, { a: 'T1', role: 'implementer', k: 'resume', r: 2, ctx: 99000 }] })!;
    expect(goalLineage(withResumeCtx)!.reusedTokens).toBe(546000);
  });

  it('without measurements it says nothing about tokens', () => {
    const t1 = goalLineage(doneRun())!.root.children.find((c) => c.key === 'planner')!.children[0];
    expect(t1.ctx).toBeNull();
    expect(t1.note).toBe("Started with the Planner's full memory");
  });

  it('is null for a legacy file, and survives a self-referencing or looping lineage', () => {
    expect(goalLineage({ phase: 'impl' })).toBeNull();
    const loop = goalLineage({ phase: 'impl', lineage: [
      { a: 'A', role: 'implementer', k: 'fork', from: 'B' },
      { a: 'B', role: 'implementer', k: 'fork', from: 'A' },
      { a: 'C', role: 'implementer', k: 'fork', from: 'C' },
    ] })!;
    const count = (n: QuestLineageNode): number => 1 + n.children.reduce((s, c) => s + count(c), 0);
    expect(count(loop.root)).toBe(4);
  });
});

describe('goalQuest', () => {
  it('maps a legacy file onto the six stages', () => {
    const q = goalQuest({ phase: 'impl', iters: { plan: 2, review: 3 }, impl: { wave: 2, waves: 3, forks: [{ s: 'run' }, { s: 'done' }] } }, T0);
    expect(q.kind).toBe('goal');
    expect(q.stages.map((s) => s.id)).toEqual(['draft', 'review', 'task', 'build', 'boss', 'trial']);
    expect(q.stages.map((s) => s.label)).toEqual(['Draft', 'Plan review', 'Task', 'Build', 'Boss gate', 'Final trial']);
    expect(q.stages.map((s) => s.state)).toEqual(['done', 'done', 'done', 'active', 'todo', 'todo']);
    expect(q.stages.map((s) => s.rounds)).toEqual([2, 3, 1, 1, 0, 0]);
    expect(q.stages[3].wave).toEqual({ at: 2, of: 3 });
    expect(q.cast.map((m) => [m.role, m.state, m.carries])).toEqual([['implementer', 'run', null], ['implementer', 'done', null]]);
    expect(q.cast[0].name).toBe('Builder 1');
    expect(q.activeIndex).toBe(3);
    expect(q.branch).toBeNull();
    expect(q.beat).toBeNull();
    expect(q.outcome).toBeNull();
  });

  it('omits the wave label when there is no wave', () => {
    const q = goalQuest({ phase: 'impl', impl: { wave: 0 } }, T0);
    expect(q.stages[3].wave).toBeUndefined();
  });

  it('seats the judges on review, with the beat as news', () => {
    const s = normalizeGoalLive({
      phase: 'review', started: at(0), iters: { plan: 2, review: 2 },
      judges: LENSES.map((id) => ({ s: 'run', id, role: id })),
      lineage: [{ a: 'planner', role: 'planner', k: 'spawn', r: 1, at: at(1) }, ...fresh(1, 60),
        { a: 'planner', role: 'planner', k: 'resume', r: 2, at: at(120) }, ...fresh(2, 180)],
    })!;
    const q = goalQuest(s, T0 + 183_000);
    expect(q.stages[1]).toMatchObject({ id: 'review', state: 'active', rounds: 2 });
    expect(q.cast.map((m) => [m.role, m.stage, m.carries])).toEqual([
      ['critic', 'review', 'fresh'], ['pragmatist', 'review', 'fresh'], ['edge-cases', 'review', 'fresh'],
    ]);
    expect(q.beat).toEqual({ text: 'Claude called 3 reviewers with fresh eyes', stale: false });
    expect(goalQuest(s, T0 + 600_000).beat!.stale).toBe(true);
  });

  it('counts a batch briefed together, and names a lone one by its role', () => {
    const builders = ['T1', 'T2', 'T3'].map((a) => ({ a, role: 'implementer', k: 'spawn' as const, r: 1, at: at(10) }));
    expect(goalQuest(normalizeGoalLive({ phase: 'impl', lineage: builders })!, T0).beat!.text)
      .toBe('Claude briefed 3 builders');
    expect(goalQuest(normalizeGoalLive({ phase: 'plan', lineage: [{ a: 'planner', role: 'planner', k: 'spawn', r: 1 }] })!, T0).beat!.text)
      .toBe('Claude briefed a Planner');
  });

  it('draws the branch from the copies, with the saving only when measured', () => {
    const s = normalizeGoalLive({ phase: 'impl', lineage: [{ a: 'planner', role: 'planner', k: 'spawn' }, ...forks(182000)] })!;
    const q = goalQuest(s, T0 + 403_000);
    expect(q.branch).toEqual({ fromKey: 'planner', fromRole: 'planner', toKeys: ['T1', 'T2', 'T3'], ctxEach: [182000, 182000, 182000], ctxTotal: 546000 });
    expect(branchCaption(q.branch!, 'Planner')).toBe("The Planner's memory was copied into 3 builders: 182k tokens each, not rebuilt");
    expect(q.beat!.text).toBe("The Planner's memory was copied into 3 builders");
    const unmeasured = goalQuest(normalizeGoalLive({ phase: 'impl', lineage: forks() })!, T0);
    expect(unmeasured.branch!.ctxTotal).toBeNull();
    expect(branchCaption(unmeasured.branch!, 'Planner')).toBe("The Planner's memory was copied into 3 builders");
  });

  it('a done run is cleared, with a timeline and its stats', () => {
    const q = goalQuest(doneRun(182000), T0 + 2_000_000);
    expect(q.activeIndex).toBe(6);
    expect(q.stages.every((s) => s.state === 'done')).toBe(true);
    expect(q.cast).toEqual([]);
    expect(q.outcome).toEqual({ kind: 'cleared', taskSlug: 'quest-demo', rounds: 4, agents: 9, elapsedMs: 1_080_000 });
    expect(q.timeline.map((t) => t.stage)).toEqual(['draft', 'review', 'build', 'done']);
    expect(questVictoryCopy(q)).toEqual({ headline: 'Quest cleared', stats: 'quest-demo · 4 rounds · 9 agents · 18m' });
  });
});

describe('copy', () => {
  const view = (kind: 'sealed' | 'cleared' | 'awaiting-signoff'): QuestView => ({
    kind: 'plan', title: null, stages: [], activeIndex: 0, cast: [], branch: null, beat: null, startedAt: null, timeline: [],
    outcome: { kind, taskSlug: 'quest-demo', rounds: 2, agents: 6, elapsedMs: 18 * 60_000 },
  });

  it('names each win honestly', () => {
    expect(questVictoryCopy(view('sealed'))).toEqual({ headline: 'Plan sealed', stats: 'quest-demo · 2 review rounds · 6 agents · 18m' });
    expect(questVictoryCopy(view('awaiting-signoff'))!.headline).toBe('Ready for your sign-off');
    expect(questVictoryCopy({ ...view('cleared'), outcome: null })).toBeNull();
  });

  it('formats tokens and time', () => {
    expect([formatQuestTokens(950), formatQuestTokens(182000), formatQuestTokens(1_500_000), formatQuestTokens(2_000_000)])
      .toEqual(['950', '182k', '1.5M', '2M']);
    expect([formatQuestElapsed(45_000), formatQuestElapsed(18 * 60_000), formatQuestElapsed(64 * 60_000)])
      .toEqual(['45s', '18m', '1h 04m']);
  });

  it('every sentence passes the plain-language rule', () => {
    const lin = goalLineage(doneRun(182000))!;
    const notes: string[] = [];
    const walk = (n: QuestLineageNode) => { notes.push(n.label, n.note); n.children.forEach(walk); };
    walk(lin.root);
    const sentences = [
      ...notes,
      ...(['lead', 'spawn', 'fork', 'resume', 'fresh'] as const).flatMap((k) => [lineageNote(k, 'critic', 'Planner', 1000), lineageNote(k, 'implementer', 'Planner', null)]),
      ...(['review', 'boss', 'trial', 'build', 'none'] as const).map((s) => freshExplainer(s) ?? ''),
      questVictoryCopy(goalQuest(doneRun(182000)))!.stats,
    ];
    for (const s of sentences) {
      expect(JARGON_RE.test(s), s).toBe(false);
      expect(s, s).not.toContain('—');
      expect(s, s).not.toMatch(/sleepy/i);
    }
    expect(freshExplainer('review')).toContain("never Claude's reasoning");
  });

  it('JARGON_RE catches the plumbing words and flags', () => {
    for (const bad of ['fork the planner', 'session id', 'resume it', 'claude --print', 'claude -p "x"']) expect(JARGON_RE.test(bad), bad).toBe(true);
    expect(JARGON_RE.test('Picked up where it left off')).toBe(false);
  });
});
