import { describe, it, expect } from 'vitest';
import {
  anchorsBySession, launchedSessionIds, runHistoryPath, teammateRun, withTeammates, type TeammateWire,
} from '../../dashboard/src/components/sleepy/chat/teammates';
import {
  headlessSessionIdOf, isAgentRun, isDispatchedAgent, isTeammateRun, reportableRuns, runReportText, type SubAgentRun,
} from '../../dashboard/src/components/sleepy/chat/chatEntities';
import { partyBatches, runCarries, runDoing, runIdentity, type QuestEntry } from '../../dashboard/src/components/sleepy/chat/questModel';
import { registeredTeammates } from '../../src/server/routes/agent-teammates';

/**
 * A headless builder as a teammate in Chat: a `claude -p` the conversation registered or
 * launched with an id, folded into the party cards from its own transcript's summary.
 */

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const C = 'cccccccc-1111-2222-3333-444444444444';
const NOW = 5_000_000;

const bash = (id: string, command: string): QuestEntry => ({
  kind: 'tool', id, toolUseId: `tu-${id}`, name: 'Bash', status: 'done', startedAt: 1, input: { command },
});

const wire = (over: Partial<TeammateWire> = {}): TeammateWire => ({
  session: A, status: 'running', steps: [], toolUses: 0, brief: 'You are the planner.\nRead the task first.', ...over,
});

describe('headlessSessionIdOf', () => {
  it('reads the id only off a headless claude segment', () => {
    expect(headlessSessionIdOf(`nohup claude -p --session-id ${A.toUpperCase()} "plan" > /tmp/p.log 2>&1 &`)).toBe(A);
    expect(headlessSessionIdOf(`cd x && claude -p --model opus --session-id=${A} "go"`)).toBe(A);
    expect(headlessSessionIdOf(`echo --session-id ${A}`)).toBeNull();
    expect(headlessSessionIdOf(`claude --session-id ${A}`)).toBeNull(); // interactive, not headless
    expect(headlessSessionIdOf('claude -p "go"')).toBeNull();
  });
});

describe('launched ids and anchors', () => {
  const entries = [
    bash('launch', `nohup claude -p --session-id ${A} "plan" &`),
    bash('reg', `dreamcontext goal-live actor planner --kind spawn --session ${A}`),
    bash('fork', `dreamcontext goal-live actor T1 --kind fork --role implementer --from planner --context-of ${A} --session ${B} && nohup /tmp/run-t1.sh &`),
  ];

  it('launchedSessionIds lists what the conversation started with --session-id', () => {
    expect(launchedSessionIds(entries)).toEqual([A]);
  });

  it('a teammate anchors to the FIRST call naming it, not a later fork measuring it', () => {
    const anchors = anchorsBySession(entries);
    expect(anchors.get(A)).toBe('tu-launch');
    expect(anchors.get(B)).toBe('tu-fork');
  });
});

describe('teammateRun', () => {
  it('is an agent run with a transcript, not a dispatch and not a shell', () => {
    const run = teammateRun(wire({ role: 'planner', kind: 'spawn', actor: 'planner' }), 'tu-launch', NOW);
    expect(isTeammateRun(run)).toBe(true);
    expect(isAgentRun(run)).toBe(true);
    expect(isDispatchedAgent(run)).toBe(false);
    expect(run.name).toBe('You are the planner.');
    expect(run.prompt).toContain('Read the task first.');
    expect(runIdentity(run)).toEqual({ role: 'planner', stage: 'draft' });
  });

  it('says what it is on right now, in the team log\'s words', () => {
    const run = teammateRun(wire({ steps: [{ toolUseId: 't', name: 'Read', input: { file_path: 'src/a.ts' }, status: 'running' }] }), undefined, NOW);
    expect(runDoing(run)).toMatch(/^Reading/);
  });

  it('maps its status and carries its report', () => {
    const done = teammateRun(wire({ status: 'done', result: 'PLAN READY', endedAt: NOW }), undefined, NOW);
    expect(done.status).toBe('completed');
    expect(runReportText(done)).toBe('PLAN READY');
    expect(reportableRuns([done])).toEqual([done]);
    expect(teammateRun(wire({ status: 'failed' }), undefined, NOW).status).toBe('error');
    expect(teammateRun(wire({ status: 'stopped' }), undefined, NOW).status).toBe('stopped');
  });

  it('a fork or a return carries memory; a registered judge arrives fresh', () => {
    expect(runCarries(teammateRun(wire({ role: 'implementer', kind: 'fork' }), undefined, NOW))).toBe('memory');
    expect(runCarries(teammateRun(wire({ role: 'critic', kind: 'fresh' }), undefined, NOW))).toBe('fresh');
  });

  it('drills into its own transcript', () => {
    const run = teammateRun(wire(), undefined, NOW);
    expect(runHistoryPath(run, 'pane-1')).toBe(`/agent/teammate-history?claudeId=pane-1&session=${A}&launched=1`);
  });
});

describe('withTeammates', () => {
  const tracked: SubAgentRun = {
    taskId: 'bg1', toolUseId: 'tu-launch', name: 'Planner', taskType: 'local_bash', status: 'running', startedAt: 1,
    command: `claude -p --session-id ${A} "plan"`,
  };

  it('enriches a tracked headless run in place rather than drawing it twice', () => {
    const runs = withTeammates([tracked], [wire({ role: 'planner', result: undefined })], new Map(), NOW);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ taskId: 'bg1', session: A, role: 'planner', status: 'running' });
  });

  it('adds an untracked teammate as its own run, anchored where it was started', () => {
    const runs = withTeammates([], [wire({ session: B })], new Map([[B, 'tu-fork']]), NOW);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ taskId: `teammate:${B}`, toolUseId: 'tu-fork' });
  });

  it('an untracked teammate joins a party at its anchor, as a card after the row', () => {
    const entries = [bash('launch', `nohup /tmp/run-planner.sh &`), bash('reg', `dreamcontext goal-live actor planner --kind spawn --session ${A}`)];
    const runs = withTeammates([], [wire({ role: 'planner' })], anchorsBySession(entries), NOW);
    const parties = partyBatches(entries, runs);
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({ anchorEntryId: 'reg', anchorKind: 'after', lead: 'planner', stage: 'draft' });
  });
});

describe('registered wave and round', () => {
  const lineage = (...entries: Record<string, unknown>[]) => ({ lineage: entries });

  it('the server keeps a registration\'s wave and round on the wire', () => {
    const [t] = registeredTeammates(lineage({ a: 'w6-lamp', role: 'implementer', k: 'spawn', sid: A, w: 6, r: 1 }));
    expect(t).toMatchObject({ sid: A, actor: 'w6-lamp', wave: 6, round: 1 });
  });

  it('a wave or round that is not a positive integer is dropped', () => {
    const got = registeredTeammates(lineage(
      { a: 'x', role: 'implementer', k: 'spawn', sid: A, w: 0, r: -1 },
      { a: 'y', role: 'implementer', k: 'spawn', sid: B, w: 2.5, r: '2' },
      { a: 'z', role: 'implementer', k: 'spawn', sid: C },
    ));
    for (const t of got) {
      expect(t).not.toHaveProperty('wave');
      expect(t).not.toHaveProperty('round');
    }
  });

  it('the newest registration wins: a resume registered with --round 2 reports round 2', () => {
    const got = registeredTeammates(lineage(
      { a: 'w7-kite', role: 'implementer', k: 'spawn', sid: A, w: 7, r: 1 },
      { a: 'w7-kite', role: 'implementer', k: 'resume', sid: A, w: 7, r: 2 },
    ));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'resume', wave: 7, round: 2 });
  });

  it('a new teammate run carries its wave and round', () => {
    expect(teammateRun(wire({ wave: 6, round: 1 }), undefined, NOW)).toMatchObject({ wave: 6, round: 1 });
    const bare = teammateRun(wire(), undefined, NOW);
    expect(bare).not.toHaveProperty('wave');
    expect(bare).not.toHaveProperty('round');
  });

  it('a run already present from the transcript is enriched with them too', () => {
    const tracked: SubAgentRun = {
      taskId: 'bg7', toolUseId: 'tu-spawn', name: 'Builder', taskType: 'local_bash', status: 'running', startedAt: 1,
      command: `claude -p --session-id ${A} "build"`,
    };
    const [run] = withTeammates([tracked], [wire({ wave: 7, round: 2 })], new Map(), NOW);
    expect(run).toMatchObject({ taskId: 'bg7', wave: 7, round: 2 });
  });
});

describe('anchors for builders spawned with a shell variable', () => {
  it('the goal-live registration naming the literal ids anchors each one; the first such call wins', () => {
    const entries = [
      bash('spawn', 'SID=$(uuidgen); nohup claude -p --session-id "$SID" "build" &'),
      bash('reg', `dreamcontext goal-live actor w7-A --role implementer --wave 7 --session ${A} && dreamcontext goal-live actor w7-B --role implementer --wave 7 --session ${B}`),
      bash('resume', `dreamcontext goal-live actor w7-A --kind resume --round 2 --session ${A}`),
    ];
    const anchors = anchorsBySession(entries);
    expect(anchors.get(A)).toBe('tu-reg');
    expect(anchors.get(B)).toBe('tu-reg');
  });
});
