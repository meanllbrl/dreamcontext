import { describe, it, expect } from 'vitest';
import {
  partyBatches, partyTitle, partyHeadline, partyOutcome, partyBeat, partyTally, deriveChatQuest, chatLineage,
  runIdentity, runVerdict, runCarries, runDoing, type Party, type QuestEntry,
} from '../../dashboard/src/components/sleepy/chat/questModel';
import type { SubAgentRun } from '../../dashboard/src/components/sleepy/chat/chatEntities';
import { JARGON_RE, questVictoryCopy, type QuestLineageNode } from '../../dashboard/src/lib/quest';
import { LEAD_NAME } from '../../dashboard/src/lib/agentRoles';

/**
 * A Plan or Develop chat read as a quest party. The fixtures are the shapes a real run
 * streams: parallel Agent dispatches in one message, a goal-live call placed first, a
 * headless builder next to the Agent-tool builders, and a resumed chat with no live runs.
 */

let clock = 1_000_000;
const tick = () => (clock += 1000);

const user = (id: string): QuestEntry => ({ kind: 'user', id, text: 'go', ts: tick() });
const text = (id: string, body: string): QuestEntry => ({ kind: 'text', id, text: body, done: true, ts: tick() });
const thinking = (id: string): QuestEntry => ({ kind: 'thinking', id, text: '', done: true, ts: tick() });
const agent = (id: string, subagentType: string, description: string, status = 'done'): QuestEntry => ({
  kind: 'tool', id, toolUseId: `tu-${id}`, name: 'Agent', status, startedAt: tick(),
  input: { subagent_type: subagentType, description, prompt: `${description} brief` },
});
const bash = (id: string, command: string, status = 'done', result?: unknown): QuestEntry => ({
  kind: 'tool', id, toolUseId: `tu-${id}`, name: 'Bash', status, startedAt: tick(), input: { command }, result,
});
const goalLive = (id: string) => bash(id, 'dreamcontext goal-live phase review && dreamcontext goal-live actor critic,pragmatist,edge-cases --kind fresh --round 1');

/** The run an Agent entry started. */
const runFor = (e: QuestEntry, over: Partial<SubAgentRun> = {}): SubAgentRun => {
  const input = e.input as { subagent_type?: string; description?: string; prompt?: string };
  return {
    taskId: `task-${e.id}`, toolUseId: e.toolUseId, name: input.description ?? '', subagentType: input.subagent_type,
    prompt: input.prompt, taskType: 'local_agent', status: 'completed', startedAt: e.startedAt ?? 0, ...over,
  };
};
/** The run a headless `claude -p` Bash entry started. */
const shellFor = (e: QuestEntry, over: Partial<SubAgentRun> = {}): SubAgentRun => ({
  taskId: `task-${e.id}`, toolUseId: e.toolUseId, name: 'T3 verify lane', taskType: 'local_bash',
  command: (e.input as { command: string }).command, status: 'completed', startedAt: e.startedAt ?? 0, ...over,
});

/** One review round: three lenses dispatched in one message, goal-live placed first. */
function reviewRound(n: number, verdicts: [string, string, string], running = false) {
  const gl = goalLive(`gl${n}`);
  const calls = [
    agent(`critic${n}`, 'goal-plan-reviewer', 'critic lens'),
    agent(`prag${n}`, 'goal-plan-reviewer', 'pragmatist lens'),
    agent(`edge${n}`, 'goal-plan-reviewer', 'edge-cases lens'),
  ];
  const runs = calls.map((c, i) => runFor(c, running && i === 2 ? { status: 'running' } : { summary: verdicts[i] }));
  return { entries: [gl, ...calls], runs };
}

function allCopy(parties: readonly Party[]): string[] {
  return parties.flatMap((p) => [partyTitle(p), partyHeadline(p), partyBeat(p)]);
}

describe('partyBatches', () => {
  it('Agent, goal-live, Agent, Agent is ONE party', () => {
    const a = agent('a', 'goal-plan-reviewer', 'critic lens');
    const b = agent('b', 'goal-plan-reviewer', 'pragmatist lens');
    const c = agent('c', 'goal-plan-reviewer', 'edge-cases lens');
    const parties = partyBatches([user('u'), a, goalLive('g'), b, c], [a, b, c].map((e) => runFor(e)));
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({
      stage: 'review', lead: 'critic', round: 1, anchorEntryId: 'a', anchorKind: 'replace', superseded: false, ghost: false,
    });
    expect(parties[0].runs.map((r) => runIdentity(r).role)).toEqual(['critic', 'pragmatist', 'edge-cases']);
  });

  it('thinking and empty text are transparent; visible text splits the batch', () => {
    const a = agent('a', 'Explore', 'Map the code');
    const b = agent('b', 'Explore', 'Map the tests');
    const c = agent('c', 'Explore', 'Map the docs');
    const entries = [user('u'), a, thinking('t'), { ...text('e', ''), text: '' }, b, text('say', 'Revising'), c];
    const parties = partyBatches(entries, [a, b, c].map((e) => runFor(e)));
    expect(parties.map((p) => p.runs.length)).toEqual([2, 1]);
    expect(parties.map((p) => p.stage)).toEqual(['scout', 'scout']);
    expect(parties.map((p) => p.round)).toEqual([0, 0]);
  });

  it('any other tool call closes the batch', () => {
    const a = agent('a', 'Explore', 'Map the code');
    const b = agent('b', 'Explore', 'Map the tests');
    const parties = partyBatches([a, bash('ls', 'ls'), b], [runFor(a), runFor(b)]);
    expect(parties).toHaveLength(2);
  });

  it('implementers and an adjacent headless builder are one build party, anchored at the first implementer', () => {
    const i1 = agent('i1', 'goal-implementer', 'T1 Role registry');
    const i2 = agent('i2', 'goal-implementer', 'T2 Tokens');
    const h = bash('h', 'dreamcontext goal-live actor "T3=Verify lane" --role implementer --kind fork --from planner && claude -p --resume planner-x --fork-session "T3 verify lane"');
    const parties = partyBatches([user('u'), i1, i2, h], [runFor(i1), runFor(i2), shellFor(h)]);
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({ stage: 'build', lead: 'implementer', round: 1, anchorEntryId: 'i1', anchorKind: 'replace' });
    expect(parties[0].runs).toHaveLength(3);
    expect(partyTitle(parties[0])).toBe('Build · wave 1');
  });

  it('a headless-first party renders after the Bash row that started it', () => {
    const h = bash('h', 'claude -p --resume planner-x --fork-session "T3 verify lane"');
    const i1 = agent('i1', 'goal-implementer', 'T1 Role registry');
    const [p] = partyBatches([h, i1], [shellFor(h), runFor(i1)]);
    expect(p).toMatchObject({ anchorEntryId: 'h', anchorKind: 'after', stage: 'build' });
  });

  it('a plain background shell is not a dispatch', () => {
    const s = bash('s', 'npm test');
    const parties = partyBatches([s], [{ ...shellFor(s), command: 'npm test', name: 'npm test' }]);
    expect(parties).toEqual([]);
  });

  it('an Agent call with no live run becomes a ghost party that feeds the quest', () => {
    const a = agent('a', 'dreamcontext-explore', 'Map old notes');
    const [p] = partyBatches([user('u'), a], []);
    expect(p).toMatchObject({ ghost: true, stage: 'scout', anchorEntryId: 'a' });
    expect(p.runs[0].taskId).toBe('ghost:tu-a');
    expect(p.runs[0].status).toBe('completed');
  });

  it('a party with any live run is not a ghost', () => {
    const a = agent('a', 'Explore', 'Map the code');
    const b = agent('b', 'Explore', 'Map the tests', 'running');
    const [p] = partyBatches([a, b], [runFor(a)]);
    expect(p.ghost).toBe(false);
    expect(p.runs[1].status).toBe('running');
  });

  it('a roster-adopted run with no tool id is matched by its description, not doubled', () => {
    const a = agent('a', 'Explore', 'Map the code');
    const parties = partyBatches([a], [{ ...runFor(a), toolUseId: undefined }]);
    expect(parties).toHaveLength(1);
    expect(parties[0].ghost).toBe(false);
  });

  it('runs no call started trail as one last party', () => {
    const a = agent('a', 'Explore', 'Map the code');
    const stray: SubAgentRun = { taskId: 'stray', toolUseId: 'tu-elsewhere', name: 'reviewer', subagentType: 'reviewer', status: 'running', startedAt: 1 };
    const parties = partyBatches([a], [runFor(a), stray]);
    expect(parties.map((p) => p.anchorKind)).toEqual(['replace', 'trailing']);
    expect(parties[1]).toMatchObject({ anchorEntryId: null, stage: 'boss' });
  });

  it('an earlier round of the same judging stage is superseded', () => {
    const r1 = reviewRound(1, ['NEEDS_WORK: premise is shaky', 'SOLID', 'SOLID']);
    const r2 = reviewRound(2, ['SOLID', 'SOLID', 'SOLID']);
    const parties = partyBatches([user('u'), ...r1.entries, text('rev', 'Revising'), ...r2.entries], [...r1.runs, ...r2.runs]);
    expect(parties.map((p) => [p.round, p.superseded])).toEqual([[1, true], [2, false]]);
    expect(parties.map(partyTitle)).toEqual(['Plan review · round 1', 'Plan review · round 2']);
    expect(parties.map(partyOutcome)).toEqual(['sent-back', 'cleared']);
  });
});

describe('party copy', () => {
  it('a scout is mapping the code, then mapped it', () => {
    const a = agent('a', 'Explore', 'Map the code', 'running');
    const [running] = partyBatches([a], [runFor(a, { status: 'running' })]);
    expect(partyHeadline(running)).toBe('Scout is mapping the code');
    expect(partyTitle(running)).toBe('Scouting');
    expect(partyBeat(running)).toBe(`${LEAD_NAME} sent the scout`);
    const [done] = partyBatches([a], [runFor(a)]);
    expect(partyHeadline(done)).toBe('Scout mapped the code');
  });

  it('reviewers count as a team, with how many are back', () => {
    const r = reviewRound(1, ['SOLID', 'SOLID', 'SOLID'], true);
    const [p] = partyBatches(r.entries, r.runs.map((run, i) => (i === 0 ? run : { ...run, status: 'running' as const })));
    expect(partyHeadline(p)).toBe('3 reviewers are reading the plan · 1 back');
    expect(partyBeat(p)).toBe(`${LEAD_NAME} called 3 reviewers with fresh eyes`);
    expect(partyTally(p)).toEqual({ running: 2, landed: 1, total: 3, verdicts: { solid: 1, 'needs-work': 0, pass: 0, fail: 0 } });
    const [done] = partyBatches(r.entries, r.runs.map((run) => ({ ...run, status: 'completed' as const, summary: 'SOLID' })));
    expect(partyHeadline(done)).toBe('3 reviewers read the plan');
  });

  it('titles every stage', () => {
    const mk = (type: string, name: string) => { const e = agent(name, type, name); return partyBatches([e], [runFor(e)])[0]; };
    expect(partyTitle(mk('goal-planner', 'draft it'))).toBe('Draft');
    expect(partyTitle(mk('reviewer', 'review the diff'))).toBe('Boss gate · round 1');
    expect(partyTitle(mk('goal-validator', 'final checks'))).toBe('Final trial · round 1');
    expect(partyTitle(mk('general-purpose', 'tidy the readme'))).toBe('Teamwork');
    expect(partyHeadline(mk('general-purpose', 'tidy the readme'))).toBe('Teammate finished');
    expect(partyBeat(mk('goal-planner', 'draft it'))).toBe(`${LEAD_NAME} briefed a Planner`);
    expect(partyBeat(mk('reviewer', 'review the diff'))).toBe(`${LEAD_NAME} called the reviewer with fresh eyes`);
  });

  it('a finished non-judge party is cleared, a failed one ended, a running one running', () => {
    const a = agent('a', 'Explore', 'Map the code');
    expect(partyOutcome(partyBatches([a], [runFor(a)])[0])).toBe('cleared');
    expect(partyOutcome(partyBatches([a], [runFor(a, { status: 'error' })])[0])).toBe('ended');
    expect(partyOutcome(partyBatches([a], [runFor(a, { status: 'running' })])[0])).toBe('running');
  });

  it('a judge party with an unreadable verdict ended rather than claiming it cleared', () => {
    const r = reviewRound(1, ['SOLID', 'Looks fine overall', 'SOLID']);
    expect(partyOutcome(partyBatches(r.entries, r.runs)[0])).toBe('ended');
  });
});

describe('one run', () => {
  it('reads a verdict from judges only', () => {
    const c = agent('c', 'goal-plan-reviewer', 'critic lens');
    expect(runVerdict(runFor(c, { summary: '**NEEDS_WORK** the premise' }))).toBe('needs-work');
    const i = agent('i', 'goal-implementer', 'T1');
    expect(runVerdict(runFor(i, { summary: 'PASS all green' }))).toBeNull();
  });

  it('gives no fresh badge to an implementer or an explorer; judges are fresh; a headless copy carries memory', () => {
    expect(runCarries(runFor(agent('i', 'goal-implementer', 'T1')))).toBeNull();
    expect(runCarries(runFor(agent('e', 'Explore', 'Map the code')))).toBeNull();
    expect(runCarries(runFor(agent('c', 'goal-plan-reviewer', 'critic lens')))).toBe('fresh');
    expect(runCarries(runFor(agent('v', 'goal-validator', 'final checks')))).toBe('fresh');
    const h = bash('h', 'claude -p --resume planner-x --fork-session "T3 verify lane"');
    expect(runCarries(shellFor(h))).toBe('memory');
    expect(runIdentity(shellFor(h)).role).toBe('implementer');
    const fresh = bash('f', 'claude -p "Draft the notes"');
    expect(runCarries(shellFor(fresh))).toBeNull();
    expect(runIdentity(shellFor(fresh)).role).toBe('headless');
  });

  it('says what a run is doing, and how it ended', () => {
    const e = agent('e', 'Explore', 'Map the code');
    expect(runDoing(runFor(e, { status: 'running', activity: 'Reading ChatPane.tsx' }))).toBe('Reading ChatPane.tsx…');
    expect(runDoing(runFor(e, { status: 'running', lastToolName: 'Grep' }))).toBe('Searching for…');
    expect(runDoing(runFor(e, { status: 'running' }))).toBe('Mapping the code…');
    expect(runDoing(runFor(e))).toBe('Mapped the code');
    expect(runDoing(runFor(e, { status: 'error' }))).toBe('Ran into a problem');
    expect(runDoing(runFor(agent('g', 'general-purpose', 'tidy'), { status: 'running' }))).toBe('Getting started…');
  });
});

describe('deriveChatQuest: Plan', () => {
  const quest = (entries: QuestEntry[], runs: SubAgentRun[] = [], progress: Parameters<typeof deriveChatQuest>[0]['progress'] = null) =>
    deriveChatQuest({ mode: 'plan', entries, parties: partyBatches(entries, runs), progress, now: clock });
  const states = (q: ReturnType<typeof quest>) => q?.stages.map((s) => `${s.id}:${s.state}:${s.rounds}`);

  it('is null until the user has said something', () => {
    expect(quest([text('t', 'hello')])).toBeNull();
  });

  it('progresses Ask, Draft, Plan review, Task, then seals', () => {
    const u = user('u');
    expect(states(quest([u]))).toEqual(['ask:active:1', 'draft:todo:0', 'review:todo:0', 'task:todo:0']);

    const scout = agent('s', 'Explore', 'Map the code');
    const afterScout = [u, scout];
    expect(states(quest(afterScout, [runFor(scout)]))).toEqual(['ask:done:1', 'draft:active:1', 'review:todo:0', 'task:todo:0']);

    const r1 = reviewRound(1, ['NEEDS_WORK', 'SOLID', 'SOLID']);
    const r2 = reviewRound(2, ['SOLID', 'SOLID', 'SOLID'], true);
    const inRound2 = [...afterScout, ...r1.entries, text('rev', 'Revising'), ...r2.entries];
    const runs = [runFor(scout), ...r1.runs, ...r2.runs];
    const q2 = quest(inRound2, runs)!;
    expect(states(q2)).toEqual(['ask:done:1', 'draft:done:1', 'review:active:2', 'task:todo:0']);
    expect(q2.cast.map((m) => [m.role, m.stage])).toEqual([['critic', 'review'], ['pragmatist', 'review'], ['edge-cases', 'review']]);
    expect(q2.cast.every((m) => m.carries === 'fresh')).toBe(true);
    expect(q2.beat?.text).toBe(`${LEAD_NAME} called 3 reviewers with fresh eyes`);
    expect(q2.outcome).toBeNull();

    const created = bash('tc', 'dreamcontext tasks create "Quest demo" -w "demo"', 'done', '✓ Task created: quest-demo.md');
    const withTask = [...inRound2, created];
    const doneRuns = runs.map((r) => ({ ...r, status: 'completed' as const, summary: r.summary ?? 'SOLID' }));
    expect(states(quest(withTask, doneRuns))).toEqual(['ask:done:1', 'draft:done:1', 'review:done:2', 'task:active:1']);

    const handoff = text('h', 'Ready.\n\n```dream-actions\n[{"label":"Develop it","action":"develop","id":"quest-demo"}]\n```');
    const won = quest([...withTask, handoff], doneRuns)!;
    expect(won.activeIndex).toBe(4);
    expect(won.stages.every((s) => s.state === 'done')).toBe(true);
    expect(won.cast).toEqual([]);
    expect(won.outcome).toMatchObject({ kind: 'sealed', taskSlug: 'quest-demo', rounds: 2, agents: 7 });
    expect(questVictoryCopy(won)?.headline).toBe('Plan sealed');
    expect(won.timeline[won.timeline.length - 1].stage).toBe('done');
  });

  it('shows Draft as done when the agent skipped its questions', () => {
    const r = reviewRound(1, ['SOLID', 'SOLID', 'SOLID']);
    const q = quest([user('u'), ...r.entries], r.runs)!;
    expect(states(q)).toEqual(['ask:done:1', 'draft:done:1', 'review:active:1', 'task:todo:0']);
  });

  it('reaches Draft on an answered question or a second user turn', () => {
    const ask: QuestEntry = { kind: 'tool', id: 'q', toolUseId: 'tu-q', name: 'AskUserQuestion', status: 'done', input: { questions: [{}, {}] }, startedAt: tick() };
    expect(quest([user('u'), ask])?.stages[1].state).toBe('active');
    expect(quest([user('u1'), text('t', 'Which one?'), user('u2')])?.stages[1].state).toBe('active');
  });

  it('a failed task create does not reach Task; a progress view does', () => {
    const failed = bash('tc', 'dreamcontext tasks create "Quest demo"', 'done', '✗ Task already exists: quest-demo.md');
    expect(quest([user('u'), failed])?.stages[3].state).toBe('todo');
    const errored = bash('tc2', 'dreamcontext tasks create "Quest demo"', 'error');
    expect(quest([user('u'), errored])?.stages[3].state).toBe('todo');
    expect(quest([user('u')], [], { slug: 'quest-demo', state: 'ok', done: 0, total: 4 })?.stages[3].state).toBe('active');
  });
});

describe('deriveChatQuest: Develop', () => {
  const quest = (entries: QuestEntry[], runs: SubAgentRun[], progress: Parameters<typeof deriveChatQuest>[0]['progress'] = null) =>
    deriveChatQuest({ mode: 'develop', entries, parties: partyBatches(entries, runs), progress, now: clock });

  function developRun() {
    const i1 = agent('i1', 'goal-implementer', 'T1 Role registry');
    const i2 = agent('i2', 'goal-implementer', 'T2 Tokens');
    const h = bash('h', 'claude -p --resume planner-x --fork-session "T3 verify lane"');
    const rv1 = agent('rv1', 'reviewer', 'Review the diff');
    const rv2 = agent('rv2', 'reviewer', 'Review the fix');
    const val = agent('val', 'goal-validator', 'Final checks');
    const entries = [
      user('u'), i1, i2, h, bash('e1', 'x', 'done'), rv1, bash('e2', 'y', 'done'), rv2, text('ok', 'Review passed.'), val,
    ];
    const runs = [
      runFor(i1), runFor(i2), shellFor(h),
      runFor(rv1, { summary: 'FAIL: two regressions' }), runFor(rv2, { summary: 'PASS' }), runFor(val, { summary: 'PASS' }),
    ];
    return { entries, runs };
  }

  it('Build is always reached, with its wave and the criteria meter', () => {
    const q = quest([user('u')], [], { slug: 'quest-demo', state: 'ok', done: 2, total: 4 })!;
    expect(q.stages.map((s) => s.id)).toEqual(['build', 'boss', 'trial']);
    expect(q.stages[0]).toMatchObject({ state: 'active', meter: { done: 2, total: 4 } });
    expect(q.stages[0].wave).toBeUndefined();
    expect(quest([user('u')], [], { slug: 'x', state: 'no-criteria', done: 0, total: 0 })!.stages[0].meter).toBeUndefined();
  });

  it('progresses through the boss gate rounds and the final trial', () => {
    const { entries, runs } = developRun();
    const q = quest(entries, runs)!;
    expect(q.stages.map((s) => `${s.id}:${s.state}:${s.rounds}`)).toEqual(['build:done:1', 'boss:done:2', 'trial:active:1']);
    expect(q.stages[0].wave).toEqual({ at: 1, of: null });
    const parties = partyBatches(entries, runs);
    expect(parties.map(partyTitle)).toEqual(['Build · wave 1', 'Boss gate · round 1', 'Boss gate · round 2', 'Final trial · round 1']);
    expect(parties.map(partyOutcome)).toEqual(['cleared', 'sent-back', 'cleared', 'cleared']);
  });

  it('is cleared by completed and awaits sign-off on in_review', () => {
    const { entries, runs } = developRun();
    const done = quest([...entries, bash('st', 'dreamcontext tasks status quest-demo completed "shipped"')], runs)!;
    expect(done.outcome).toMatchObject({ kind: 'cleared', taskSlug: 'quest-demo', rounds: 3, agents: 6 });
    expect(questVictoryCopy(done)?.headline).toBe('Quest cleared');
    expect(done.activeIndex).toBe(3);
    const review = quest([...entries, bash('st', 'dreamcontext tasks status quest-demo in_review "needs eyes"')], runs)!;
    expect(review.outcome?.kind).toBe('awaiting-signoff');
    expect(questVictoryCopy(review)?.headline).toBe('Ready for your sign-off');
  });

  it('a failed or superseded status call does not win', () => {
    const { entries, runs } = developRun();
    const failed = bash('st', 'dreamcontext tasks status nope completed', 'done', '✗ Task not found: nope');
    expect(quest([...entries, failed], runs)!.outcome).toBeNull();
    const reopened = [bash('st1', 'dreamcontext tasks status quest-demo completed'), bash('st2', 'dreamcontext tasks status quest-demo in_progress')];
    expect(quest([...entries, ...reopened], runs)!.outcome).toBeNull();
  });
});

describe('chatLineage', () => {
  it('hangs everyone under the lead, merges a returning judge, and never claims a token count', () => {
    const i1 = agent('i1', 'goal-implementer', 'T1 Role registry');
    const h = bash('h', 'claude -p --resume planner-x --fork-session "T3 verify lane"');
    const rv1 = agent('rv1', 'reviewer', 'Review the diff');
    const rv2 = agent('rv2', 'reviewer', 'Review the fix');
    const entries = [user('u'), i1, h, bash('e', 'x'), rv1, bash('e2', 'y'), rv2];
    const runs = [runFor(i1), shellFor(h, { name: 'claude -p --resume planner-x --fork-session "T3"' }), runFor(rv1, { summary: 'FAIL' }), runFor(rv2, { summary: 'PASS' })];
    const lin = chatLineage(partyBatches(entries, runs), entries);
    expect(lin.root).toMatchObject({ key: 'lead', label: LEAD_NAME, kind: 'lead', state: 'done' });
    const kids = lin.root.children;
    expect(kids.map((n) => [n.role, n.kind, n.carries])).toEqual([
      ['implementer', 'spawn', null], ['implementer', 'fork', 'memory'], ['reviewer', 'fresh', 'fresh'],
    ]);
    expect(kids[0].label).toBe('Builder · T1 Role registry');
    // The headless builder's name is its command line: the receipt must not print it.
    expect(kids[1].label).toBe('Builder');
    expect(kids[1].note).toBe("Started with the Planner's full memory");
    expect(kids[2]).toMatchObject({ rounds: [1, 2], verdict: 'pass' });
    expect(lin).toMatchObject({ copies: 1, returns: 0, fresh: 1, reusedTokens: null });
    const text = (n: QuestLineageNode): string[] => [n.label, n.note, ...n.children.flatMap(text)];
    expect(text(lin.root).join(' ')).not.toMatch(/\d+(\.\d+)?k tokens/);
  });

  it('the lead is still running while a party runs and the task is not closed', () => {
    const a = agent('a', 'goal-implementer', 'T1', 'running');
    const lin = chatLineage(partyBatches([a], [runFor(a, { status: 'running' })]), [a]);
    expect(lin.root.state).toBe('run');
  });
});

describe('plain language', () => {
  it('no party, quest or lineage copy names the plumbing, uses an em dash, or says Sleepy', () => {
    const r1 = reviewRound(1, ['NEEDS_WORK', 'SOLID', 'SOLID']);
    const r2 = reviewRound(2, ['SOLID', 'SOLID', 'SOLID'], true);
    const i1 = agent('i1', 'goal-implementer', 'T1');
    const h = bash('h', 'claude -p --resume planner-x --fork-session "T3"');
    const s = agent('s', 'Explore', 'Map the code');
    const g = agent('g', 'general-purpose', 'tidy');
    const hl = bash('hl', 'claude -p "Draft notes"');
    const entries = [user('u'), s, text('a', 'a'), ...r1.entries, text('b', 'b'), ...r2.entries, text('c', 'c'), i1, h, text('d', 'd'), g, text('e', 'e'), hl];
    const runs = [runFor(s), ...r1.runs, ...r2.runs, runFor(i1), shellFor(h, { name: 'claude -p --resume planner-x --fork-session "T3"' }), runFor(g), shellFor(hl, { name: 'claude -p "Draft notes"' })];
    const parties = partyBatches(entries, runs);
    const plan = deriveChatQuest({ mode: 'plan', entries, parties, progress: null, now: clock })!;
    const lin = chatLineage(parties, entries);
    const text2 = (n: QuestLineageNode): string[] => [n.label, n.note, ...n.children.flatMap(text2)];
    const copy = [
      ...allCopy(parties),
      ...parties.flatMap((p) => p.runs.map((r) => runDoing({ ...r, activity: undefined }))),
      ...plan.stages.map((st) => st.label), plan.beat?.text ?? '',
      ...text2(lin.root),
    ];
    for (const line of copy) {
      expect(line, line).not.toMatch(JARGON_RE);
      expect(line, line).not.toMatch(/—/);
      expect(line, line).not.toMatch(/sleepy/i);
    }
    expect(copy.some((l) => l.startsWith(LEAD_NAME))).toBe(true);
  });
});
