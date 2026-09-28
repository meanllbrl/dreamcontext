import { describe, it, expect } from 'vitest';
import {
  partyBatches, partyTitle, partyHeadline, partyOutcome, partyBeat, partyTally, deriveChatQuest, chatLineage,
  runIdentity, runVerdict, runCarries, runDoing, type Party, type QuestEntry,
} from '../../dashboard/src/components/sleepy/chat/questModel';
import type { SubAgentRun } from '../../dashboard/src/components/sleepy/chat/chatEntities';
import { anchorsBySession, withTeammates, type TeammateWire } from '../../dashboard/src/components/sleepy/chat/teammates';
import { historyChatItem } from '../../dashboard/src/components/sleepy/chatSession';
import { parseTranscriptHistory } from '../../src/lib/transcript-history';
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

  it('a run no call started sits after the call nearest before it began; an undated one after the last call', () => {
    const a = agent('a', 'Explore', 'Map the code');
    const b = bash('b', 'ls');
    const c = bash('c', 'ls -la');
    const stray: SubAgentRun = {
      taskId: 'stray', toolUseId: 'tu-elsewhere', name: 'reviewer', subagentType: 'reviewer', status: 'running', startedAt: (b.startedAt ?? 0) + 10,
    };
    // A finished run nothing dates is still drawn (ChatPane trails only running parties).
    const timeless: SubAgentRun = { ...stray, taskId: 'timeless', status: 'completed', startedAt: 0 };
    const parties = partyBatches([a, b, c], [runFor(a), stray, timeless]);
    expect(parties.map((p) => [p.anchorKind, p.anchorEntryId])).toEqual([['replace', 'a'], ['after', 'b'], ['after', 'c']]);
    expect(parties[1]).toMatchObject({ id: 'party-at-stray', stage: 'boss' });
    expect(parties[2]).toMatchObject({ id: 'party-at-timeless' });
    // Only a chat with no tool call at all has nowhere to put it.
    expect(partyBatches([user('u')], [timeless]).map((p) => p.anchorKind)).toEqual(['trailing']);
  });

  it('every run one call names is placed in that call\'s party, not only the first', () => {
    // Three unregistered teammates named by one call (their ids in one command line).
    const reg = bash('reg', 'dreamcontext goal-live actor lane-a --session a && dreamcontext goal-live actor lane-b --session b');
    const mates = ['a', 'b', 'c'].map((s, i): SubAgentRun => ({
      taskId: `teammate:${s}`, toolUseId: reg.toolUseId, name: `lane ${s}`, taskType: 'headless_session', session: s,
      role: 'implementer', status: 'completed', startedAt: (reg.startedAt ?? 0) + 5000 * (i + 1),
    }));
    const parties = partyBatches([user('u'), reg, bash('later', 'ls')], mates);
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({ anchorEntryId: 'reg', anchorKind: 'after' });
    expect(parties[0].runs.map((r) => r.taskId)).toEqual(['teammate:a', 'teammate:b', 'teammate:c']);
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

/**
 * A Develop run as the lead actually streams it (fictional project: a "Lanternfish" field
 * guide). Builders are launched with `--session-id "$SID"`, so no launch names an id; wave 7's
 * three builders are registered in ONE call that names all three; wave 6's builder is brought
 * back with `--round 2` during wave 7, the first call naming its id literally. A reviewer
 * follows each wave. Runs go through the real teammate fold, as ChatPane feeds the model.
 */
function lanternfishRun(o: { fourth?: boolean } = {}) {
  const ID = {
    w6a: '6a6a6a6a-0000-4000-8000-000000000006',
    w7a: '7a7a7a7a-0000-4000-8000-000000000007',
    w7b: '7b7b7b7b-0000-4000-8000-000000000007',
    w7c: '7c7c7c7c-0000-4000-8000-000000000007',
    w7d: '7d7d7d7d-0000-4000-8000-000000000007',
  };
  const spawn6 = bash('spawn6', 'SID=$(uuidgen); nohup claude -p --session-id "$SID" "Lanternfish: lane A, glossary" >/dev/null 2>&1 &');
  const reg6 = bash('reg6', 'dreamcontext goal-live actor w6-A --role implementer --kind spawn --wave 6 --session "$SID"');
  const rv6 = agent('rv6', 'reviewer', 'Review wave 6');
  const spawn7 = bash('spawn7', 'for L in A B C; do SID=$(uuidgen); nohup claude -p --session-id "$SID" "Lanternfish lane $L" & done');
  const reg7 = bash('reg7', [ID.w7a, ID.w7b, ID.w7c].map((id, i) => `dreamcontext goal-live actor w7-${'ABC'[i]} --role implementer --wave 7 --session ${id}`).join(' && '));
  const resume6 = bash('resume6', `claude -p --resume ${ID.w6a} "fix the glossary lint" && dreamcontext goal-live actor w6-A --kind resume --wave 6 --round 2 --session ${ID.w6a}`);
  const spawn7d = bash('spawn7d', 'SID=$(uuidgen); nohup claude -p --session-id "$SID" "Lanternfish lane D, docs" &');
  const rv7 = agent('rv7', 'reviewer', 'Review wave 7', 'running');
  const entries: QuestEntry[] = [
    user('u'), text('t6', 'Wave 6: one builder.'), spawn6, reg6, text('wait6', 'Waiting on wave 6.'),
    rv6, text('t7', 'Wave 6 passed. Wave 7: three builders.'), spawn7, reg7, resume6,
    ...(o.fourth ? [spawn7d] : []), text('built7', 'Wave 7 built.'), rv7,
  ];
  const after = (e: QuestEntry, ms: number) => (e.startedAt ?? 0) + ms;
  const mate = (session: string, name: string, wave: number, startedAt: number, extra: Partial<TeammateWire> = {}): TeammateWire => ({
    session, status: 'done', steps: [], toolUses: 4, role: 'implementer', kind: 'spawn', name, wave, startedAt, endedAt: startedAt + 300, ...extra,
  });
  const wire: TeammateWire[] = [
    mate(ID.w6a, 'lane A, glossary', 6, after(spawn6, 200), { kind: 'resume', round: 2, endedAt: after(resume6, 400) }),
    mate(ID.w7a, 'lane A', 7, after(spawn7, 200)),
    mate(ID.w7b, 'lane B', 7, after(spawn7, 250)),
    mate(ID.w7c, 'lane C', 7, after(spawn7, 300)),
    ...(o.fourth ? [mate(ID.w7d, 'lane D, docs', 7, after(spawn7d, 200))] : []),
  ];
  const tracked = [runFor(rv6, { summary: 'PASS' }), runFor(rv7, { status: 'running' })];
  const runs = withTeammates(tracked, wire, anchorsBySession(entries), clock);
  return { entries, runs, ID };
}

describe('partyBatches: a Develop run with registered waves', () => {
  const sessions = (p: Party) => p.runs.map((r) => r.session ?? r.taskId);

  it('groups builders by their registered wave: all of wave 7 in its card, wave 6 never in it', () => {
    const { entries, runs, ID } = lanternfishRun();
    const builds = partyBatches(entries, runs).filter((p) => p.stage === 'build');
    expect(builds.map(sessions)).toEqual([[ID.w6a], [ID.w7a, ID.w7b, ID.w7c]]);
    expect(builds.map((p) => p.wave)).toEqual([6, 7]);
  });

  it('names each build card by its registered wave, not by how many builds came before', () => {
    const { entries, runs } = lanternfishRun();
    const parties = partyBatches(entries, runs);
    expect(parties.map(partyTitle)).toEqual(['Build · wave 6', 'Boss gate · round 1', 'Build · wave 7', 'Boss gate · round 2']);
  });

  it('sits each build where it began, before the review that followed it, and trails nothing that has a time', () => {
    const { entries, runs } = lanternfishRun();
    const parties = partyBatches(entries, runs);
    // Wave 6 sits at its launch, not at the resume that first named its id during wave 7.
    expect(parties.map((p) => [p.stage, p.anchorEntryId, p.anchorKind])).toEqual([
      ['build', 'spawn6', 'after'], ['boss', 'rv6', 'replace'], ['build', 'spawn7', 'after'], ['boss', 'rv7', 'replace'],
    ]);
    expect(parties.filter((p) => partyOutcome(p) !== 'running').every((p) => p.anchorKind !== 'trailing')).toBe(true);
  });

  it('the resumed wave-6 builder, started at its spawn, sits before wave 6\'s first review', () => {
    const { entries, runs, ID } = lanternfishRun();
    const parties = partyBatches(entries, runs);
    const w6 = parties.findIndex((p) => p.wave === 6);
    const spawn6 = entries.find((e) => e.id === 'spawn6')!;
    // The server reports a resumed run's start as its FIRST enqueue (headless-teammate.ts).
    expect(parties[w6].runs[0]).toMatchObject({ session: ID.w6a, round: 2, joined: 'resume' });
    expect(parties[w6].runs[0].startedAt).toBeLessThan(entries.find((e) => e.id === 'rv6')!.startedAt!);
    expect(parties[w6].runs[0].startedAt).toBeGreaterThan(spawn6.startedAt!);
    expect(w6).toBeLessThan(parties.findIndex((p) => p.anchorEntryId === 'rv6'));
  });

  it('parties that share one anchor call keep distinct ids', () => {
    const rv = agent('rv', 'reviewer', 'Review wave 3');
    const late = bash('late', 'ls');
    const mate: SubAgentRun = {
      taskId: 'teammate:w3', name: 'lane A', taskType: 'headless_session', session: 'w3', role: 'implementer',
      wave: 3, status: 'completed', startedAt: (rv.startedAt ?? 0) + 100,
    };
    const stray: SubAgentRun = { taskId: 'stray', toolUseId: 'tu-gone', name: 'Map it', subagentType: 'Explore', status: 'completed', startedAt: (rv.startedAt ?? 0) + 200 };
    const parties = partyBatches([user('u'), rv, late], [runFor(rv), mate, stray]);
    expect(parties.map((p) => p.anchorEntryId)).toEqual(['rv', 'rv', 'rv']);
    expect(parties.map((p) => p.id)).toEqual(['party-rv', 'party-build-w3', 'party-at-stray']);
    expect(new Set(parties.map((p) => p.id)).size).toBe(parties.length);
  });

  it('a fourth builder joining wave 7 moves no card: ids and kickers hold', () => {
    const before = (() => { const { entries, runs } = lanternfishRun(); return partyBatches(entries, runs); })();
    const { entries, runs, ID } = lanternfishRun({ fourth: true });
    const after = partyBatches(entries, runs);
    expect(after.map((p) => [p.id, partyTitle(p)])).toEqual(before.map((p) => [p.id, partyTitle(p)]));
    expect(after.map((p) => p.id)).toEqual(['party-build-w6', 'party-rv6', 'party-build-w7', 'party-rv7']);
    // The docs lane was launched with a variable and never named: it joins its wave by registration.
    expect(sessions(after[2])).toEqual([ID.w7a, ID.w7b, ID.w7c, ID.w7d]);
  });
});

/**
 * The same Lanternfish run, REOPENED: the lead's past turns come back from its transcript
 * (`parseTranscriptHistory` -> `historyChatItem`, as a resumed chat replays them), then one
 * live turn. The reviewers' Agent calls have no live run any more (ghosts); the builders come
 * from the teammate fold, their start being their spawn.
 */
function reopenedLanternfish(o: { dated: boolean }) {
  const ID = { w6a: '6a6a6a6a-0000-4000-8000-000000000006', w7a: '7a7a7a7a-0000-4000-8000-000000000007', w7b: '7b7b7b7b-0000-4000-8000-000000000007' };
  const T0 = Date.UTC(2026, 8, 27, 9, 0, 0);
  const at = (min: number) => T0 + min * 60_000;
  const stamp = (min: number) => (o.dated ? { timestamp: new Date(at(min)).toISOString() } : {});
  let n = 0;
  const call = (min: number, name: string, input: unknown) => {
    const id = `toolu_${++n}`;
    return [
      { type: 'assistant', ...stamp(min), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
      { type: 'user', ...stamp(min + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
    ];
  };
  const raw = [
    { type: 'user', ...stamp(0), message: { role: 'user', content: 'Develop the Lanternfish field guide' } },
    ...call(1, 'Bash', { command: 'SID=$(uuidgen); nohup claude -p --session-id "$SID" "Lanternfish lane A" &' }),
    ...call(10, 'Agent', { subagent_type: 'reviewer', description: 'Review wave 6', prompt: 'Review wave 6' }),
    ...call(20, 'Bash', { command: 'for L in A B; do SID=$(uuidgen); nohup claude -p --session-id "$SID" "Lanternfish lane $L" & done' }),
    ...call(21, 'Bash', { command: `dreamcontext goal-live actor w7-A --wave 7 --session ${ID.w7a} && dreamcontext goal-live actor w7-B --wave 7 --session ${ID.w7b}` }),
    ...call(30, 'Bash', { command: `claude -p --resume ${ID.w6a} "fix the glossary lint"` }),
    ...call(40, 'Agent', { subagent_type: 'reviewer', description: 'Review wave 7', prompt: 'Review wave 7' }),
  ].map((r) => JSON.stringify(r)).join('\n');
  const history = parseTranscriptHistory(raw)
    .map((h, i) => historyChatItem(h, `hist-${i}`))
    .filter((x): x is NonNullable<typeof x> => x != null) as QuestEntry[];
  const live: QuestEntry[] = [
    { kind: 'user', id: 'live-u', text: 'how is it going?', ts: at(50) },
    { kind: 'tool', id: 'live-ls', toolUseId: 'tu-live-ls', name: 'Bash', status: 'done', startedAt: at(51), input: { command: 'git status' } },
  ];
  const entries = [...history, ...live];
  const mate = (session: string, wave: number, startMin: number, extra: Partial<TeammateWire> = {}): TeammateWire => ({
    session, status: 'done', steps: [], toolUses: 3, role: 'implementer', kind: 'spawn', name: session.slice(0, 4), wave,
    startedAt: at(startMin), endedAt: at(startMin + 5), ...extra,
  });
  const wire = [mate(ID.w6a, 6, 2, { kind: 'resume', round: 2, endedAt: at(32) }), mate(ID.w7a, 7, 20.5), mate(ID.w7b, 7, 20.6)];
  const runs = withTeammates([], wire, anchorsBySession(entries), at(60));
  const idOf = (i: number) => history[i].id;
  return { entries, runs, history, idOf, at };
}

describe('partyBatches: a reopened Develop chat', () => {
  it('replayed rows carry their transcript time, so each build sits before its wave\'s review', () => {
    const { entries, runs, history } = reopenedLanternfish({ dated: true });
    expect(history.every((e) => (e.startedAt ?? e.ts ?? 0) > 0)).toBe(true);
    const parties = partyBatches(entries, runs);
    const toolIds = history.filter((e) => e.kind === 'tool').map((e) => e.id);
    expect(parties.map((p) => [partyTitle(p), p.anchorEntryId])).toEqual([
      ['Build · wave 6', toolIds[0]],
      ['Boss gate · round 1', toolIds[1]],
      ['Build · wave 7', toolIds[2]],
      ['Boss gate · round 2', toolIds[5]],
    ]);
  });

  it('a transcript with no times replays rows at 0, which the quest reads as no time, not the epoch', () => {
    const { entries, runs, history } = reopenedLanternfish({ dated: false });
    expect(history.every((e) => (e.startedAt ?? e.ts) === 0)).toBe(true);
    const q = deriveChatQuest({ mode: 'develop', entries, parties: partyBatches(entries, runs), progress: null, now: Date.UTC(2026, 8, 27, 10) })!;
    expect(q.startedAt).toBeNull();
    expect(q.timeline.every((x) => x.at > 0)).toBe(true);
    // A ghost reviewer rebuilt from an undated row has no start either.
    const ghosts = partyBatches(entries, runs).flatMap((p) => p.runs).filter((r) => r.taskId.startsWith('ghost:'));
    expect(ghosts.map((r) => r.startedAt)).toEqual([0, 0]);
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

    // The seal stamps once: the same chat keeps talking after the win, and a scout it sends
    // then (a ghost, no live run) or a fresh review round must not move "2 rounds · 7 agents".
    const ghost = agent('g', 'Explore', 'Map the chat components');
    const r3 = reviewRound(3, ['SOLID', 'SOLID', 'SOLID']);
    const later = quest([...withTask, handoff, text('go', 'Filing it.'), ghost, ...r3.entries], [...doneRuns, ...r3.runs])!;
    expect(later.outcome).toMatchObject({ kind: 'sealed', rounds: 2, agents: 7 });
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
