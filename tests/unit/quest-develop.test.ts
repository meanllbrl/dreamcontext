/**
 * A Develop run on the quest map (dashboard/src/lib/quest.ts), end to end through the real
 * writer: every state here is folded by `applyGoalLiveEvent` (src/lib/goal-live.ts) and read
 * back through `normalizeGoalLive`, exactly as the route and the panel see the file.
 *
 * The promises (task: develop-mode-runs-like-goal-skill, AC5 + AC6): Build reads "wave k of M"
 * with the wave's own time, the Boss gate reads "k of M reviewed" and keeps it while the next
 * wave builds, no Draft/Plan review/Task stage ever appears, a wave that passed first time
 * has no round badge, and the receipt tells each wave with its builders, verdict and time.
 */

import { describe, it, expect } from 'vitest';
import { applyGoalLiveEvent, type GoalLiveEvent, type GoalLiveState as WriterState } from '../../src/lib/goal-live.js';
import { normalizeGoalLive, type GoalLiveState } from '../../dashboard/src/lib/goalLive.js';
import { goalLineage, goalQuest, questStageMeta, questVictoryCopy, type QuestView } from '../../dashboard/src/lib/quest.js';
import { chatLineage, deriveChatQuest, partyBatches, type QuestEntry } from '../../dashboard/src/components/sleepy/chat/questModel.js';
import type { SubAgentRun } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

const T0 = Date.parse('2026-09-26T10:00:00Z');
const MIN = 60_000;

/** Fold events one minute apart (so every wave has a whole-minute clock), then read them back. */
function run(events: GoalLiveEvent[], from: WriterState | null = null, t0 = T0): { state: GoalLiveState; end: number } {
  let s = from;
  events.forEach((ev, i) => { s = applyGoalLiveEvent(s, ev, new Date(t0 + i * MIN).toISOString()); });
  return { state: normalizeGoalLive(JSON.parse(JSON.stringify(s)))!, end: t0 + (events.length - 1) * MIN };
}

const START: GoalLiveEvent = { type: 'start', goal: 'notch-assistant', session: null, mode: 'develop', tab: 'tab-a' };

function build(n: number, lanes: string[], waves?: number): GoalLiveEvent[] {
  return [
    { type: 'phase', phase: 'impl', wave: n, ...(waves ? { waves } : {}) },
    ...lanes.map((l): GoalLiveEvent => ({ type: 'actor', id: `w${n}-${l}`, role: 'implementer', kind: 'spawn', wave: n, name: `lane ${l}` })),
  ];
}

function review(n: number, verdict: 'PASS' | 'FAIL', round?: number): GoalLiveEvent[] {
  return [
    { type: 'phase', phase: 'codereview', wave: n },
    { type: 'actor', id: `w${n}-reviewer`, role: 'reviewer', kind: 'fresh', wave: n, ...(round ? { round } : {}) },
    { type: 'state', id: `w${n}-reviewer`, verdict, wave: n },
  ];
}

const stage = (q: QuestView, id: string) => q.stages.find((s) => s.id === id)!;
const meta = (q: QuestView, id: string) => questStageMeta(stage(q, id))?.text ?? '';

describe('goalQuest: a Develop run', () => {
  it('draws only Build, Boss gate and Final trial, with kind develop', () => {
    const { state } = run([START, ...build(1, ['A'], 3)]);
    const q = goalQuest(state, T0 + 10 * MIN);
    expect(q.kind).toBe('develop');
    expect(q.stages.map((s) => s.id)).toEqual(['build', 'boss', 'trial']);
  });

  it('before the first wave, Build is still to come and says it is mapping waves', () => {
    const { state } = run([START]);
    const q = goalQuest(state, T0 + MIN);
    expect(stage(q, 'build')).toMatchObject({ state: 'todo', rounds: 0 });
    expect(meta(q, 'build')).toBe('mapping waves');
    expect(q.cast).toEqual([]);
    expect(q.timeline.some((t) => t.stage === 'draft')).toBe(false);
  });

  it('Build reads "wave k of M" with the wave\'s own time; only this wave\'s builders stand on it', () => {
    const { state, end } = run([START, ...build(1, ['A', 'B'], 3), ...review(1, 'PASS'), ...build(2, ['A'])]);
    const q = goalQuest(state, end + 4 * MIN);
    // Wave 2 began at its impl entry; four minutes after the last event is 5 minutes on it.
    expect(meta(q, 'build')).toBe('wave 2 of 3 · 5m');
    expect(stage(q, 'build').state).toBe('active');
    expect(q.cast.map((m) => m.key)).toEqual(['w2-A']);
  });

  it('the Boss gate keeps "1 of 3 reviewed" while wave 2 builds (it does not fall back to not started)', () => {
    const { state, end } = run([START, ...build(1, ['A'], 3), ...review(1, 'PASS'), ...build(2, ['A'])]);
    const q = goalQuest(state, end);
    expect(meta(q, 'boss')).toBe('1 of 3 reviewed');
    expect(stage(q, 'boss')).toMatchObject({ state: 'todo', rounds: 0 });
  });

  it('a wave under review is not a finished Build; the last wave\'s is', () => {
    const mid = run([START, ...build(1, ['A'], 2), { type: 'phase', phase: 'codereview', wave: 1 }]).state;
    expect(stage(goalQuest(mid), 'build').state).not.toBe('done');
    expect(stage(goalQuest(mid), 'boss').state).toBe('active');
    const last = run([START, ...build(1, ['A'], 2), ...review(1, 'PASS'), ...build(2, ['A']), ...review(2, 'PASS'), { type: 'phase', phase: 'validate' }]).state;
    const q = goalQuest(last);
    expect(stage(q, 'build').state).toBe('done');
    expect(stage(q, 'boss').state).toBe('done');
    expect(meta(q, 'boss')).toBe('2 of 2 reviewed');
    expect(stage(q, 'trial').state).toBe('active');
  });

  it('a clean 3-wave run shows no round badge anywhere; a retried wave shows round 2 on that wave only', () => {
    const clean = [START, ...build(1, ['A'], 3), ...review(1, 'PASS'), ...build(2, ['A']), ...review(2, 'PASS'), ...build(3, ['A'])];
    for (let i = 2; i <= clean.length; i += 1) {
      const q = goalQuest(run(clean.slice(0, i)).state);
      for (const s of q.stages) expect(s.rounds, `${s.id} after ${i} events`).toBeLessThan(2);
    }
    const retried = run([
      START, ...build(1, ['A'], 3),
      ...review(1, 'FAIL'),
      { type: 'phase', phase: 'impl', wave: 1 },
      { type: 'actor', id: 'w1-A', role: 'implementer', kind: 'resume', wave: 1, round: 2 },
    ]).state;
    expect(stage(goalQuest(retried), 'build').rounds).toBe(2);
    const next = run([...review(1, 'PASS', 2), ...build(2, ['A'])], retried as WriterState, T0 + 60 * MIN).state;
    const q = goalQuest(next);
    expect(stage(q, 'build').rounds).toBe(1);
    expect(stage(q, 'boss').rounds).toBe(0);
  });

  it('the Build clock does not reset on a retry of the same wave', () => {
    const { state, end } = run([
      START, ...build(1, ['A'], 2), ...review(1, 'FAIL'),
      { type: 'phase', phase: 'impl', wave: 1 },
    ]);
    // First impl entry at +1 min; the last event is at +6 min.
    expect(stage(goalQuest(state, end), 'build').elapsedMs).toBe(end - (T0 + MIN));
  });

  it('a validator FAIL, the fix and its fresh reviewer: no badge on wave M, final-fix-reviewer on the trial', () => {
    const { state } = run([
      START, ...build(1, ['A'], 2), ...review(1, 'PASS'), ...build(2, ['A', 'B']), ...review(2, 'PASS'),
      { type: 'phase', phase: 'validate' },
      { type: 'actor', id: 'validator', role: 'validator', kind: 'fresh' },
      { type: 'state', id: 'validator', verdict: 'FAIL' },
      { type: 'actor', id: 'w2-B', role: 'implementer', kind: 'resume', round: 2 },
      { type: 'actor', id: 'final-fix-reviewer', role: 'reviewer', kind: 'fresh' },
    ]);
    const q = goalQuest(state);
    expect(q.stages.every((s) => s.rounds < 2)).toBe(true);
    expect(meta(q, 'boss')).toBe('2 of 2 reviewed');
    expect(q.cast.map((m) => m.key)).toContain('final-fix-reviewer');
    expect(q.cast.map((m) => m.key)).not.toContain('w2-B');
    const trial = goalLineage(state)!.trial!;
    expect(trial.map((t) => t.key)).toEqual(['validator', 'w2-B', 'final-fix-reviewer']);
    expect(trial[0].verdict).toBe('fail');
  });

  it('a finished clean run: no Draft beat in the timeline, and the win counts no rounds', () => {
    const { state } = run([
      START, ...build(1, ['A'], 2), ...review(1, 'PASS'), ...build(2, ['A']), ...review(2, 'PASS'),
      { type: 'phase', phase: 'validate' }, { type: 'phase', phase: 'done' },
    ]);
    const q = goalQuest(state);
    expect(q.outcome).toMatchObject({ kind: 'cleared', rounds: 0 });
    expect(questVictoryCopy(q)!.stats).not.toMatch(/round/);
    expect(q.timeline.map((t) => t.stage)).toEqual(['build', 'boss', 'build', 'boss', 'trial', 'done']);
  });

  it('a goal-skill file still draws the six-stage goal path', () => {
    const { state } = run([{ type: 'start', goal: 'g', session: null }, { type: 'phase', phase: 'impl', wave: 1, waves: 2 }]);
    const q = goalQuest(state);
    expect(q.kind).toBe('goal');
    expect(q.stages).toHaveLength(6);
    expect(stage(q, 'boss').reviewed).toBeUndefined();
    expect(stage(q, 'build').elapsedMs).toBeUndefined();
    expect(goalLineage({ ...state, lineage: [{ a: 'x', role: 'planner', k: 'spawn' }] })!.waves).toBeUndefined();
  });
});

describe('goalLineage: the Develop receipt lists each wave', () => {
  it('with its builders, its review verdict, its re-reviews and its duration', () => {
    const { state } = run([
      START,
      ...build(1, ['A', 'B'], 3), ...review(1, 'PASS'),
      ...build(2, ['A']), ...review(2, 'FAIL'),
      { type: 'phase', phase: 'impl', wave: 2 },
      { type: 'actor', id: 'w2-A', role: 'implementer', kind: 'resume', wave: 2, round: 2 },
      ...review(2, 'PASS', 2),
      ...build(3, ['A']), ...review(3, 'PASS'),
      { type: 'phase', phase: 'validate' },
      { type: 'phase', phase: 'done' },
    ]);
    const waves = goalLineage(state)!.waves!;
    expect(waves.map((w) => w.wave)).toEqual([1, 2, 3]);
    expect(waves[0].builders.map((b) => b.key)).toEqual(['w1-A', 'w1-B']);
    expect(waves[0].builders[0].label).toBe('w1-A · lane A');
    expect(waves.map((w) => w.verdict)).toEqual(['pass', 'pass', 'pass']);
    expect(waves.map((w) => w.reReviews)).toEqual([0, 1, 0]);
    // Wave 1: impl at +1, the next wave's impl at +7 → 6 minutes.
    expect(waves[0].durationMs).toBe(6 * MIN);
    expect(waves.every((w) => w.durationMs != null && w.durationMs > 0)).toBe(true);
    expect(questVictoryCopy(goalQuest(state))!.stats).toContain('1 round');
  });

  it('an open wave runs to now; a wave with a FAIL verdict shows it', () => {
    const { state, end } = run([START, ...build(1, ['A'], 2), ...review(1, 'FAIL')]);
    const [w] = goalLineage(state, end + 2 * MIN)!.waves!;
    expect(w.verdict).toBe('fail');
    expect(w.durationMs).toBe(end + 2 * MIN - (T0 + MIN));
  });
});

/**
 * The same run read off a Develop CHAT's own stream (questModel), where the waves come from
 * each teammate's registration rather than the live file. Fictional project "Lanternfish":
 * a run that starts at wave 6, one builder there (brought back with round 2 while wave 7
 * builds), three wave-7 builders launched with a variable id and registered in one call.
 */
describe('a Develop chat names the waves its builders were registered with', () => {
  let t = T0;
  const at = () => (t += MIN);
  const bash = (id: string, command: string): QuestEntry => ({ kind: 'tool', id, toolUseId: `tu-${id}`, name: 'Bash', status: 'done', startedAt: at(), input: { command } });
  const agentCall = (id: string, description: string, status = 'done'): QuestEntry => ({
    kind: 'tool', id, toolUseId: `tu-${id}`, name: 'Agent', status, startedAt: at(), input: { subagent_type: 'reviewer', description, prompt: description },
  });
  const builder = (session: string, wave: number, startedAt: number, over: Partial<SubAgentRun> = {}): SubAgentRun => ({
    taskId: `teammate:${session}`, name: `lane ${session}`, taskType: 'headless_session', session, role: 'implementer',
    joined: 'spawn', wave, status: 'completed', startedAt, endedAt: startedAt + MIN, ...over,
  });

  function chat() {
    const u: QuestEntry = { kind: 'user', id: 'u', text: 'develop', ts: at() };
    const spawn6 = bash('spawn6', 'SID=$(uuidgen); nohup claude -p --session-id "$SID" "Lanternfish lane A" &');
    const rv6 = agentCall('rv6', 'Review wave 6');
    const spawn7 = bash('spawn7', 'for L in A B C; do SID=$(uuidgen); nohup claude -p --session-id "$SID" "Lanternfish lane $L" & done');
    const reg7 = bash('reg7', 'dreamcontext goal-live actor w7-A --wave 7 --session a7 && dreamcontext goal-live actor w7-B --wave 7 --session b7 && dreamcontext goal-live actor w7-C --wave 7 --session c7');
    const resume6 = bash('resume6', 'claude -p --resume a6 "fix the lint"');
    const rv7 = agentCall('rv7', 'Review wave 7', 'running');
    const entries = [u, spawn6, rv6, spawn7, reg7, resume6, rv7];
    const s = (e: QuestEntry) => (e.startedAt ?? 0) + 1000;
    const runs: SubAgentRun[] = [
      builder('a6', 6, s(spawn6), { toolUseId: resume6.toolUseId, joined: 'resume', round: 2 }),
      ...['a7', 'b7', 'c7'].map((id) => builder(id, 7, s(spawn7), { toolUseId: reg7.toolUseId })),
      { taskId: 'rv6', toolUseId: rv6.toolUseId, name: 'Review wave 6', subagentType: 'reviewer', taskType: 'local_agent', status: 'completed', summary: 'PASS', startedAt: rv6.startedAt! },
      { taskId: 'rv7', toolUseId: rv7.toolUseId, name: 'Review wave 7', subagentType: 'reviewer', taskType: 'local_agent', status: 'running', startedAt: rv7.startedAt! },
    ];
    return { entries, runs };
  }

  it('the Build stage reads the newest registered wave (7), not the count of builds (2)', () => {
    const { entries, runs } = chat();
    const q = deriveChatQuest({ mode: 'develop', entries, parties: partyBatches(entries, runs), progress: null, now: t })!;
    expect(q.stages[0].wave).toEqual({ at: 7, of: null });
    expect(q.stages.map((x) => `${x.id}:${x.state}`)).toEqual(['build:done', 'boss:active', 'trial:todo']);
  });

  it('the receipt keeps the resumed wave-6 builder as one node, first, before wave 7', () => {
    const { entries, runs } = chat();
    const lin = chatLineage(partyBatches(entries, runs), entries);
    const builders = lin.root.children.filter((n) => n.role === 'implementer');
    expect(builders.map((n) => [n.key, n.kind])).toEqual([
      ['teammate:a6', 'resume'], ['teammate:a7', 'spawn'], ['teammate:b7', 'spawn'], ['teammate:c7', 'spawn'],
    ]);
    expect(lin.returns).toBe(1);
  });
});
