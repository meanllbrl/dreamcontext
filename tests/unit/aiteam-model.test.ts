/**
 * AI Team, wave 2: the pure model behind the page (`dashboard/src/components/aiteam/teamModel.ts`).
 *
 * A2: one row per agent, "Needs you" first then newest activity, a status per row.
 * A3: one agent's runs (two routines and an @mention) merged into ONE conversation, with day
 *     rules, "<routine> ran" event rows, the owner's bubbles, the agent's posts, the
 *     "Routine created" event and a "Working" row for a run in flight.
 * A8: the temporary model: remembered per agent, sent only where it differs from the default.
 */
import { describe, expect, it } from 'vitest';
import {
  buildConversation, buildRoster, conversationSlugs, filterRoster, messagesOf, openingView, openQuestionOf, overrideFor,
  plainLine, readTemporaryModels, routineCountLabel, writeTemporaryModel,
  type TeamAgent, type TeamAutomation,
} from '../../dashboard/src/components/aiteam/teamModel';
import type { FeedMessage, ThreadEntry } from '../../dashboard/src/hooks/useAutomations';

function agent(slug: string, title: string, over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    slug, title, hasPhoto: false, roleLine: `${title} role`, description: '', approvedForChat: true,
    approvedToRun: true, approvalReason: null, model: null, effort: null, ...over,
  };
}

function automation(slug: string, agentSlug: string, over: Partial<TeamAutomation> = {}): TeamAutomation {
  return {
    slug, title: slug, agent: agentSlug, runKind: 'automation', mode: 'sched', enabled: true, approved: true,
    approvalReason: null, pendingQuestion: null, nextFireAt: null, cadenceLabel: 'daily 09:00', ...over,
  };
}

function msg(slug: string, runId: string, at: string, over: Partial<FeedMessage> = {}): FeedMessage {
  return {
    key: `${slug}::${runId}`, slug, title: slug, hasPhoto: false, runId, at, status: 'done', durationMs: 61_000,
    costUsd: null, ask: null, text: `post from ${runId}`, textFrom: 'post', files: [], summary: null, question: null,
    needsYou: false, replyCount: 0, lastReplyAt: null, document: null, sessionRunId: null, sessionOpenable: false,
    unread: false, newestId: null, ...over,
  };
}

const AGENTS = [agent('growth', 'Growth analyst'), agent('brief', 'Morning brief'), agent('scout', 'Scout')];
const AUTOS: TeamAutomation[] = [
  automation('growth-weekly', 'growth', { title: 'Weekly growth report' }),
  automation('growth-alarm', 'growth', { title: 'Revenue alarm' }),
  automation('brief-daily', 'brief', { title: 'Daily brief', enabled: false }),
  // The agent's own call target is not a routine.
  automation('scout', 'scout', { runKind: 'agent', mode: 'call' }),
];

describe('which messages are one agent\'s conversation', () => {
  it('its own slug, every automation that runs as it, and anything it spoke', () => {
    expect([...conversationSlugs('growth', AUTOS)].sort()).toEqual(['growth', 'growth-alarm', 'growth-weekly']);
    const all = [
      msg('growth-weekly', 'r1', '2026-10-19T10:00:00Z'),
      msg('brief-daily', 'r2', '2026-10-19T09:00:00Z'),
      msg('growth', 'r3', '2026-10-19T11:00:00Z', { ask: { text: 'and?', at: '2026-10-19T11:00:00Z' } }),
      msg('other', 'r4', '2026-10-19T12:00:00Z', { agent: 'growth' }),
    ];
    expect(messagesOf('growth', AUTOS, all).map((m) => m.runId)).toEqual(['r1', 'r3', 'r4']);
  });
});

describe('buildRoster (A2)', () => {
  const feed = {
    messages: [
      msg('brief-daily', 'b1', '2026-10-20T09:01:00Z'),
      msg('growth-alarm', 'g1', '2026-10-19T18:00:00Z', { question: { id: 'q1', text: 'iOS checkout may be broken. What now?', choices: ['Look', 'Wait'] }, needsYou: true }),
    ],
    unreadBySlug: { 'brief-daily': 1, 'growth-alarm': 2 },
    runSlots: {},
    working: { scout: { since: 1_000, runId: 's1', queued: [] } },
  };
  const rows = buildRoster(AGENTS, AUTOS, feed);

  it('"Needs you" first, then by newest message, then those never talked to', () => {
    expect(rows.map((r) => [r.slug, r.section])).toEqual([
      ['growth', 'needs'], ['brief', 'team'], ['scout', 'team'],
    ]);
  });

  it('a status per row: needs, working, paused', () => {
    const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
    expect(by.growth.status).toBe('needs');
    expect(by.growth.preview).toBe('iOS checkout may be broken. What now?');
    expect(by.growth.unread).toBe(2);
    expect(by.growth.routines.map((r) => r.slug)).toEqual(['growth-weekly', 'growth-alarm']);
    expect(by.scout.status).toBe('working');
    expect(by.scout.workingSince).toBe(1_000);
    expect(by.scout.routines).toEqual([]);
    expect(by.brief.status).toBe('paused');
    expect(by.brief.unread).toBe(1);
  });

  it('an agent waiting for approval says so, and an empty one is idle', () => {
    const r = buildRoster([agent('a', 'A', { approvedForChat: false }), agent('b', 'B')], [], null);
    expect(r.map((x) => [x.slug, x.status, x.preview])).toEqual([['a', 'approval', null], ['b', 'idle', null]]);
  });

  it('search matches name or role', () => {
    expect(filterRoster(rows, 'brief').map((r) => r.slug)).toEqual(['brief']);
    expect(filterRoster(rows, 'SCOUT role').map((r) => r.slug)).toEqual(['scout']);
    expect(filterRoster(rows, '  ')).toHaveLength(3);
  });
});

describe('buildConversation (A3): two routines and an @mention, one stream', () => {
  const weekly = msg('growth-weekly', 'w1', '2026-10-19T10:00:00Z', {
    title: 'Weekly growth report', summary: [{ key: 'Signups', value: '2,814 (+12%)' }], durationMs: 233_000,
  });
  const ask = msg('growth', 'a1', '2026-10-19T10:40:00Z', {
    title: 'Growth analyst', ask: { text: 'What if the location step moved last?', at: '2026-10-19T10:40:00Z' },
    text: 'Activation would recover to about 44%.',
  });
  const alarm = msg('growth-alarm', 'r1', '2026-10-20T18:00:00Z', {
    title: 'Revenue alarm', question: { id: 'q1', text: 'What now?', choices: ['Look', 'Wait'] }, needsYou: true,
  });
  const running = msg('growth-weekly', 'w2', '2026-10-20T19:00:00Z', { status: 'running', text: '', textFrom: 'none' });

  it('day rules, a ran row per routine fire, the ask as a bubble, posts, then Working', () => {
    const items = buildConversation([weekly, ask, alarm, running]);
    expect(items.map((i) => i.kind)).toEqual(['day', 'ran', 'agent', 'you', 'agent', 'day', 'ran', 'agent', 'ran', 'live']);
    const ran = items[1];
    expect(ran.kind === 'ran' && [ran.title, ran.durationMs]).toEqual(['Weekly growth report', 233_000]);
    const post = items[2];
    expect(post.kind === 'agent' && post.summary).toEqual([{ key: 'Signups', value: '2,814 (+12%)' }]);
    const you = items[3];
    expect(you.kind === 'you' && you.text).toBe('What if the location step moved last?');
    const q = items[7];
    expect(q.kind === 'agent' && q.question?.id).toBe('q1');
    const live = items[8];
    expect(live.kind === 'ran' && live.durationMs).toBeNull();
  });

  it('a read thread adds the turns after the first and the "Routine created" event, not its bookkeeping', () => {
    const entries: ThreadEntry[] = [
      { id: 'e1', runId: 'a1', kind: 'user', at: '2026-10-19T10:40:00Z', text: 'What if the location step moved last?', via: 'dashboard' },
      { id: 'e2', runId: 'a1', kind: 'system', event: 'started', at: '2026-10-19T10:40:01Z', text: 'Started', via: 'runner' },
      { id: 'e3', runId: 'a1', kind: 'agent', at: '2026-10-19T10:41:00Z', text: 'Activation would recover to about 44%.', via: 'cli' },
      { id: 'e4', runId: 'a1', kind: 'user', at: '2026-10-19T10:45:00Z', text: 'Check it every Monday at 10.', via: 'dashboard' },
      { id: 'e5', runId: 'a1', kind: 'system', event: 'routine', at: '2026-10-19T10:46:00Z', text: 'Routine created · Price watch · Mondays 10:00', via: 'cli' },
      { id: 'e6', runId: 'a1', kind: 'agent', at: '2026-10-19T10:46:30Z', text: 'Set. First check Monday 10:00.', via: 'cli' },
      { id: 'e7', runId: 'a1', kind: 'system', event: 'ok', at: '2026-10-19T10:47:00Z', text: 'Finished', via: 'runner' },
    ];
    const items = buildConversation([ask], { [ask.key]: { entries, rootId: 'e1' } });
    expect(items.map((i) => i.kind)).toEqual(['day', 'you', 'agent', 'you', 'event', 'agent']);
    const ev = items[4];
    expect(ev.kind === 'event' && ev.text).toBe('Routine created · Price watch · Mondays 10:00');
    const last = items[5];
    expect(last.kind === 'agent' && last.text).toBe('Set. First check Monday 10:00.');
  });

  it('the report is folded under the post, and a skipped fire draws nothing', () => {
    const doc = msg('growth-weekly', 'w3', '2026-10-21T10:00:00Z', { textFrom: 'result', text: 'Lead line' });
    const skipped = msg('growth-weekly', 'w4', '2026-10-21T11:00:00Z', { status: 'skipped', textFrom: 'skipped', text: '' });
    const items = buildConversation([doc, skipped], {
      [doc.key]: { entries: [], answer: { path: 'automations/out/w3.md', text: '# Lead line\n\n## A\nx', truncated: false } },
    });
    expect(items.map((i) => i.kind)).toEqual(['day', 'ran', 'agent']);
    const post = items[2];
    expect(post.kind === 'agent' && [post.text, post.report?.path]).toEqual(['', 'automations/out/w3.md']);
  });

  it('the composer answers the newest open question, and lets go of one answered from here', () => {
    expect(openQuestionOf([weekly, alarm, ask])?.runId).toBe('r1');
    expect(openQuestionOf([weekly, ask])).toBeNull();
    expect(openQuestionOf([weekly, alarm, ask], new Set(['q1']))).toBeNull();
  });

  it('a late reply in an earlier run never repeats a day rule key, and the next run gets its own rule', () => {
    const mon = msg('growth-weekly', 'm1', '2026-10-12T10:00:00Z');
    const tue = msg('growth-alarm', 't1', '2026-10-13T10:00:00Z');
    const wedReply: ThreadEntry = { id: 'x1', runId: 'm1', kind: 'agent', at: '2026-10-14T10:00:00Z', text: 'Late note.', via: 'cli' };
    const items = buildConversation([mon, tue, msg('growth-weekly', 'w9', '2026-10-14T11:00:00Z')], {
      [mon.key]: { entries: [wedReply] },
    });
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(items.filter((i) => i.kind === 'day')).toHaveLength(4);
  });

  it('a repeated owner line in a thread without a root keeps its repeats', () => {
    const asked = msg('growth', 'a9', '2026-10-19T10:40:00Z', { ask: { text: 'status?', at: '2026-10-19T10:40:00Z' }, text: 'Fine.' });
    const entries: ThreadEntry[] = [
      { id: 'u1', runId: 'a9', kind: 'user', at: '2026-10-19T10:40:00Z', text: 'status?', via: 'dashboard' },
      { id: 'u2', runId: 'a9', kind: 'user', at: '2026-10-19T10:50:00Z', text: 'status?', via: 'dashboard' },
    ];
    const you = buildConversation([asked], { [asked.key]: { entries } }).filter((i) => i.kind === 'you');
    expect(you).toHaveLength(2);
  });
});

describe('the temporary model (A8)', () => {
  function memory(): Pick<Storage, 'getItem' | 'setItem'> {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
  }

  it('is per agent, survives a re-read, and clears back to the default', () => {
    const s = memory();
    writeTemporaryModel(s, 'growth', { model: 'sonnet', effort: 'low' });
    writeTemporaryModel(s, 'brief', { model: 'haiku', effort: 'high' });
    expect(readTemporaryModels(s)).toEqual({ growth: { model: 'sonnet', effort: 'low' }, brief: { model: 'haiku', effort: 'high' } });
    expect(writeTemporaryModel(s, 'growth', null)).toEqual({ brief: { model: 'haiku', effort: 'high' } });
  });

  it('a broken store reads as no picks', () => {
    expect(readTemporaryModels({ getItem: () => '{not json' })).toEqual({});
    expect(readTemporaryModels(null)).toEqual({});
  });

  it('a send carries only the fields that differ from the agent default', () => {
    expect(overrideFor({ model: 'sonnet', effort: 'low' }, { model: 'opus', effort: 'high' })).toEqual({ model: 'sonnet', effort: 'low' });
    expect(overrideFor({ model: 'opus', effort: 'low' }, { model: 'opus', effort: 'high' })).toEqual({ effort: 'low' });
    expect(overrideFor({ model: 'opus', effort: 'high' }, { model: 'opus', effort: 'high' })).toEqual({});
    expect(overrideFor(null, { model: 'opus', effort: null })).toEqual({});
  });
});

describe('small words', () => {
  it('routine counts and plain previews', () => {
    const t = (k: string) => ({ 'aiteam.routines.none': 'No routines', 'aiteam.routines.one': '1 routine', 'aiteam.routines.many': '{n} routines' }[k] ?? k);
    expect([0, 1, 2].map((n) => routineCountLabel(n, t))).toEqual(['No routines', '1 routine', '2 routines']);
    expect(plainLine('**Signups** up [12%](x.md)\n`code`')).toBe('Signups up 12% code');
  });
});

describe('openingView: a picked teammate opens on its stage (its whole history above the composer)', () => {
  it('opens the stage, whatever it has said or left unread', () => {
    for (const status of ['working', 'approval', 'paused', 'idle'] as const) expect(openingView({ status })).toBe('stage');
  });
  it('only an open routine question opens the activity, where its answer block lives', () => {
    expect(openingView({ status: 'needs' })).toBe('activity');
  });
  it('homeHasTurns is gone from the stage view type', async () => {
    const src = (await import('node:fs')).readFileSync('dashboard/src/hooks/useAgents.ts', 'utf-8');
    expect(src).not.toContain('homeHasTurns');
  });
});
