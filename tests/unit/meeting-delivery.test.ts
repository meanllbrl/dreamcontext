import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PeerTarget, LiveRunResult } from '../../src/lib/peer-delivery.js';
import {
  MeetingOrchestrator,
  buildMeetingPrompt,
  parseMentions,
  parseSummons,
  parseWait,
  routeUserMessage,
  type HeadlessRunner,
} from '../../src/lib/meeting-delivery.js';
import {
  activeThread,
  appendMessage,
  createThread,
  mutateThread,
  readThread,
  reopenThread,
  type MeetingThread,
} from '../../src/lib/meeting-room.js';

let home: string;

beforeEach(() => {
  home = join(tmpdir(), `dc-meetdel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const fakeTarget = (name: string): PeerTarget => ({
  name,
  contextRoot: `/fake/${name}/_dream_context`,
  projectRoot: `/fake/${name}`,
});

const ok = (reply: string): LiveRunResult => ({ ok: true, reply, sessionId: null });

/**
 * A reply that lands LATER than its peers. The WAIT tests need one agent to still be
 * `thinking` when another finishes, and every fake run otherwise takes the same 5ms — so
 * without this the winner is a coin toss and the test proves nothing on half its runs.
 */
const slow = (reply: string): Promise<LiveRunResult> =>
  new Promise((r) => setTimeout(() => r(ok(reply)), 40));

interface RecordedRun {
  target: string;
  prompt: string;
  /** The spawn flags the orchestrator chose for this run — `model` / `effort` / `timeoutMs`. */
  opts: { timeoutMs?: number; model?: string; effort?: string };
}

/** An orchestrator whose runner answers from a per-vault script and records every run. */
function makeOrchestrator(
  script: (target: string, prompt: string) => LiveRunResult | Promise<LiveRunResult>,
  opts: { concurrency?: number; chatDefaults?: () => { model: string; effort: string } } = {},
) {
  const runs: RecordedRun[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const runner: HeadlessRunner = async (peer, prompt, runOpts) => {
    runs.push({ target: peer.name, prompt, opts: runOpts });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    try {
      return await script(peer.name, prompt);
    } finally {
      inFlight -= 1;
    }
  };
  const orch = new MeetingOrchestrator({
    home,
    runner,
    resolveTarget: fakeTarget,
    concurrency: opts.concurrency,
    chatDefaults: opts.chatDefaults,
  });
  return { orch, runs, maxInFlight: () => maxInFlight };
}

function seedThread(names: string[], body = 'Hello room'): MeetingThread {
  const t = createThread(
    { body, participants: names.map((n) => ({ name: n, whatItIs: '' })) },
    home,
  );
  if (!t) throw new Error('seed failed');
  return t;
}

// ─── parseMentions ────────────────────────────────────────────────────────────

describe('parseMentions — roster-driven, longest-name-first', () => {
  const roster = ['alpha', 'beta', 'Acme', 'Acme Payments'];

  it('finds plain mentions in first-occurrence order, deduped', () => {
    expect(parseMentions('@beta then @alpha then @beta again', roster)).toEqual(['beta', 'alpha']);
  });

  it('resolves names WITH SPACES via longest-name-first', () => {
    expect(parseMentions('ask @Acme Payments about payouts', roster)).toEqual(['Acme Payments']);
    expect(parseMentions('ask @Acme about payouts', roster)).toEqual(['Acme']);
  });

  it('a consumed span never re-matches a shorter name inside it', () => {
    const hits = parseMentions('@Acme Payments and @Acme', roster);
    expect(hits).toEqual(['Acme Payments', 'Acme']);
  });

  it('an email address is not a mention', () => {
    expect(parseMentions('mail me at a@beta.com or x@alpha', roster)).toEqual([]);
  });

  it('a longer unknown token is not a mention (@betamax)', () => {
    expect(parseMentions('use @betamax for tapes', roster)).toEqual([]);
  });

  it('is case-insensitive but returns the registered casing', () => {
    expect(parseMentions('@ALPHA and @acme payments', roster)).toEqual(['alpha', 'Acme Payments']);
  });

  it('empty roster or no @ yields nothing', () => {
    expect(parseMentions('@alpha', [])).toEqual([]);
    expect(parseMentions('no mentions here', roster)).toEqual([]);
  });
});

// ─── routeUserMessage ─────────────────────────────────────────────────────────

describe('routeUserMessage', () => {
  it('root announcement without mentions → ALL participants', () => {
    const t = seedThread(['alpha', 'beta', 'gamma']);
    expect(routeUserMessage(t, 'hello everyone', true)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('root announcement with @mentions → ONLY the mentioned', () => {
    const t = seedThread(['alpha', 'beta', 'gamma']);
    expect(routeUserMessage(t, '@beta please check this', true)).toEqual(['beta']);
  });

  it('user thread-reply without mentions → only the ENGAGED set', () => {
    const t = seedThread(['alpha', 'beta', 'gamma']);
    appendMessage(t.id, { author: 'beta', authorKind: 'agent', body: 'I looked into it' }, home);
    const fresh = readThread(t.id, home)!;
    expect(routeUserMessage(fresh, 'thanks, and then?', false)).toEqual(['beta']);
  });

  it('user thread-reply with mentions → the mentioned, engaged or not', () => {
    const t = seedThread(['alpha', 'beta', 'gamma']);
    expect(routeUserMessage(t, '@gamma what about you?', false)).toEqual(['gamma']);
  });

  it('a system cap line does not put an agent in the engaged set', () => {
    const t = seedThread(['alpha', 'beta']);
    mutateThread(t.id, (th) => {
      th.messages.push({
        id: '1-abcdef12', author: 'room', authorKind: 'system',
        body: '@alpha has reached its cap', createdAt: new Date().toISOString(),
      });
    }, home);
    expect(routeUserMessage(readThread(t.id, home)!, 'anyone?', false)).toEqual([]);
  });
});

// ─── buildMeetingPrompt ───────────────────────────────────────────────────────

describe('buildMeetingPrompt', () => {
  it('carries identity, roster, fenced trigger, and the PASS contract', () => {
    const t = seedThread(['alpha', 'beta']);
    mutateThread(t.id, (th) => { th.participants[0].whatItIs = 'The alpha project.'; }, home);
    const fresh = readThread(t.id, home)!;
    const prompt = buildMeetingPrompt({ self: 'alpha', thread: fresh, trigger: fresh.messages[0] });
    expect(prompt).toContain('You are "alpha"');
    expect(prompt).toContain('- alpha (you): The alpha project.');
    expect(prompt).toContain('- beta'); // name-only degrade, no colon droppings
    expect(prompt).toContain('<<<MEETING-MESSAGE\nHello room\nMEETING-MESSAGE');
    expect(prompt).toContain('ENTIRE final message must be exactly PASS');
    expect(prompt).toContain('@beta');
    expect(prompt).toContain('costs a real run');
    // The two rules the 08-28 report needed: naming someone is free, summoning is a verb.
    expect(prompt).toContain('ADDRESSING IS FREE');
    expect(prompt).toContain('ASK @beta');
    expect(prompt).toContain('WAIT @name');
  });

  it('names who is ALREADY ANSWERING this round, so addressing can be told from summoning', () => {
    const t = seedThread(['alpha', 'beta', 'gamma']);
    mutateThread(t.id, (th) => {
      th.participants.find((p) => p.name === 'beta')!.state = 'thinking';
      th.participants.find((p) => p.name === 'gamma')!.state = 'idle';
    }, home);
    const fresh = readThread(t.id, home)!;
    const prompt = buildMeetingPrompt({ self: 'alpha', thread: fresh, trigger: fresh.messages[0] });

    expect(prompt).toContain('ALREADY ANSWERING THIS ROUND (awake, and they will read what you post): @beta');
    // Only the agent NOT already answering is offered as a summons target.
    expect(prompt).toContain('ASK @gamma');
    expect(prompt).not.toContain('ASK @beta');
    expect(prompt).toContain('Never ASK someone already answering this round');
  });

  it('with nobody else woken, the round line says so instead of listing an empty set', () => {
    const t = seedThread(['alpha', 'beta']);
    const fresh = readThread(t.id, home)!;
    const prompt = buildMeetingPrompt({ self: 'alpha', thread: fresh, trigger: fresh.messages[0] });
    expect(prompt).toContain('ALREADY ANSWERING THIS ROUND: nobody');
  });

  it('a catch-up prompt fences what arrived late and asks only for what it CHANGES', () => {
    const t = seedThread(['alpha', 'beta']);
    const late = appendMessage(t.id, { author: 'beta', authorKind: 'agent', body: 'ASK @alpha one more thing' }, home)!;
    const fresh = readThread(t.id, home)!;
    const prompt = buildMeetingPrompt({
      self: 'alpha', thread: fresh, trigger: late, caughtUp: ['[beta] ASK @alpha one more thing'],
    });
    expect(prompt).toContain('CATCH-UP');
    expect(prompt).toContain('ASK @alpha one more thing');
    expect(prompt).toContain('what these CHANGE');
    // A second run may not spawn a third: no summon rule, no wait rule.
    expect(prompt).not.toContain('SUMMONING IS NOT FREE');
    expect(prompt).not.toContain('DO NOT GUESS');
  });

  it('a wait-resume prompt names who it waited for and re-fences the original ask', () => {
    const t = seedThread(['alpha', 'beta']);
    const fresh = readThread(t.id, home)!;
    const prompt = buildMeetingPrompt({
      self: 'alpha', thread: fresh, trigger: fresh.messages[0], resumedFrom: ['beta'],
    });
    expect(prompt).toContain('You asked to wait for @beta');
    expect(prompt).toContain('<<<MEETING-MESSAGE\nHello room');
  });

  it('a follow-up prompt frames the mentioned agent answer and drops the mention rule', () => {
    const t = seedThread(['alpha', 'beta']);
    const answer = appendMessage(t.id, { author: 'beta', authorKind: 'agent', body: 'my answer' }, home)!;
    const fresh = readThread(t.id, home)!;
    const prompt = buildMeetingPrompt({
      self: 'alpha', thread: fresh, trigger: answer,
      followUp: { mentioned: 'beta', answer: 'my answer' },
    });
    expect(prompt).toContain('FOLLOW-UP');
    expect(prompt).toContain('@beta');
    expect(prompt).not.toContain('costs a real run');
  });
});

// ─── the two new verbs ────────────────────────────────────────────────────────

describe('parseSummons — only an ASK line spends a run', () => {
  const roster = ['alpha', 'beta', 'kitUP dreamcontext'];

  it('a bare @name in prose summons NOBODY — this is the whole 08-28 fix', () => {
    expect(parseSummons('@alpha @beta — here is the lesson, read it', roster)).toEqual([]);
    expect(parseSummons('I agree with @alpha, and @beta said the same', roster)).toEqual([]);
  });

  it('an ASK line summons exactly the names on it', () => {
    expect(parseSummons('my answer\nASK @beta — can you confirm?', roster)).toEqual(['beta']);
  });

  it('collects several ASK lines, deduped, in order', () => {
    const body = 'ASK @beta first\nsome prose about @alpha\nASK @alpha and @beta again';
    expect(parseSummons(body, roster)).toEqual(['beta', 'alpha']);
  });

  it('ASK must OPEN the line — the word inside a sentence is prose', () => {
    expect(parseSummons('I would ASK @beta about this, but later', roster)).toEqual([]);
  });

  it('leading whitespace is allowed; names with spaces still resolve', () => {
    expect(parseSummons('  ASK @kitUP dreamcontext what changed', roster)).toEqual(['kitUP dreamcontext']);
  });
});

describe('parseWait — a sentinel, not a word', () => {
  const roster = ['alpha', 'beta'];

  it('names the agents to wait for', () => {
    expect(parseWait('WAIT @alpha', roster)).toEqual(['alpha']);
    expect(parseWait('WAIT @alpha @beta', roster)).toEqual(['alpha', 'beta']);
    expect(parseWait('  WAIT @alpha, @beta.  ', roster)).toEqual(['alpha', 'beta']);
  });

  it('a BARE WAIT is the everyone-still-working reading', () => {
    expect(parseWait('WAIT', roster)).toEqual([]);
  });

  it('prose that merely opens with the word is NOT a sentinel', () => {
    expect(parseWait('WAIT — actually I have an answer for you', roster)).toBeNull();
    expect(parseWait('Waiting on the funnel data before I can say', roster)).toBeNull();
    expect(parseWait('WAIT @alpha, but here is my interim take', roster)).toBeNull();
  });

  it('an ordinary message is not a sentinel', () => {
    expect(parseWait('here is my answer', roster)).toBeNull();
  });
});

// ─── the orchestrator ─────────────────────────────────────────────────────────

describe('MeetingOrchestrator', () => {
  it('fans an unmentioned announcement out to ALL, capped at 3 parallel runs', async () => {
    const t = seedThread(['a1', 'a2', 'a3', 'a4', 'a5']);
    const { orch, runs, maxInFlight } = makeOrchestrator((name) => ok(`reply from ${name}`));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.map((r) => r.target).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(maxInFlight()).toBeLessThanOrEqual(3);
    const after = readThread(t.id, home)!;
    expect(after.participants.every((p) => p.state === 'replied')).toBe(true);
    expect(after.messages.filter((m) => m.authorKind === 'agent')).toHaveLength(5);
  });

  it('a mentioned announcement wakes ONLY the mentioned agent', async () => {
    const t = seedThread(['alpha', 'beta', 'gamma'], '@beta your turn');
    const { orch, runs } = makeOrchestrator((name) => ok(`reply from ${name}`));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.map((r) => r.target)).toEqual(['beta']);
    const after = readThread(t.id, home)!;
    expect(after.participants.find((p) => p.name === 'alpha')!.state).toBe('idle');
    expect(after.participants.find((p) => p.name === 'gamma')!.state).toBe('idle');
  });

  it('PASS sets state=passed and NEVER appears as a thread message', async () => {
    const t = seedThread(['alpha', 'beta']);
    const { orch } = makeOrchestrator((name) => (name === 'beta' ? ok('PASS') : ok('real reply')));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    const after = readThread(t.id, home)!;
    expect(after.participants.find((p) => p.name === 'beta')!.state).toBe('passed');
    const bodies = after.messages.map((m) => m.body);
    expect(bodies).not.toContain('PASS');
    expect(after.messages.filter((m) => m.author === 'beta')).toHaveLength(0);
    expect(after.messages.filter((m) => m.author === 'alpha')).toHaveLength(1);
  });

  it('a failed run sets state=error with the reason, and posts no message', async () => {
    const t = seedThread(['alpha']);
    const { orch } = makeOrchestrator(() => ({ ok: false, reply: '', sessionId: null, error: 'timed out after 600s' }));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    const after = readThread(t.id, home)!;
    const p = after.participants[0];
    expect(p.state).toBe('error');
    expect(p.error).toBe('timed out after 600s');
    expect(after.messages.filter((m) => m.authorKind === 'agent')).toHaveLength(0);
  });

  it('agent-to-agent ASK: ONE directed run, then ONE follow-up carrying the answer — depth 1', async () => {
    const t = seedThread(['alpha', 'beta', 'gamma'], '@alpha kick off');
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'alpha' && prompt.includes('FOLLOW-UP')) return ok('thanks @beta, noted — and @gamma too');
      if (name === 'alpha') return ok('starting\nASK @beta can you confirm?');
      if (name === 'beta') return ok('confirmed, and @gamma should know');
      return ok('gamma should never run');
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    // Exactly three runs: alpha (announcement), beta (directed), alpha (follow-up).
    expect(runs.map((r) => r.target)).toEqual(['alpha', 'beta', 'alpha']);
    // gamma was mentioned only inside a directed answer and a follow-up — depth 1
    // means those render as text and deliver NOTHING.
    expect(runs.some((r) => r.target === 'gamma')).toBe(false);

    const after = readThread(t.id, home)!;
    const agentBodies = after.messages.filter((m) => m.authorKind === 'agent').map((m) => m.body);
    expect(agentBodies).toEqual([
      'starting\nASK @beta can you confirm?',
      'confirmed, and @gamma should know',
      'thanks @beta, noted — and @gamma too',
    ]);
    expect(after.mentionRuns).toBe(2); // directed + follow-up
    // The directed prompt fenced ALPHA's reply, not the announcement.
    const directedPrompt = runs[1].prompt;
    expect(directedPrompt).toContain('<<<MEETING-MESSAGE\nstarting\nASK @beta can you confirm?');
    // The follow-up prompt carried beta's answer.
    expect(runs[2].prompt).toContain('FOLLOW-UP');
    expect(runs[2].prompt).toContain('confirmed, and @gamma should know');
  });

  it('a directed run that PASSes spawns no follow-up', async () => {
    const t = seedThread(['alpha', 'beta'], '@alpha go');
    const { orch, runs } = makeOrchestrator((name) =>
      name === 'alpha' ? ok('ASK @beta anything?') : ok('PASS'));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.map((r) => r.target)).toEqual(['alpha', 'beta']);
    expect(readThread(t.id, home)!.participants.find((p) => p.name === 'beta')!.state).toBe('passed');
  });

  it('the per-agent 3-run cap drops the 4th delivery with a VISIBLE system line', async () => {
    const t = seedThread(['alpha']);
    const { orch, runs } = makeOrchestrator(() => ok('a substantive reply'));

    orch.deliverUserMessage(t.id, t.messages[0].id); // run 1
    await orch.idle();
    for (let i = 0; i < 3; i++) {
      const reply = appendMessage(t.id, { author: 'user', authorKind: 'user', body: `again ${i}` }, home)!;
      orch.deliverUserMessage(t.id, reply.id); // runs 2, 3, then capped
      await orch.idle();
    }

    expect(runs).toHaveLength(3);
    const after = readThread(t.id, home)!;
    const sys = after.messages.filter((m) => m.authorKind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0].body).toContain('@alpha');
    expect(sys[0].body).toContain('3-run cap');
  });

  it('the 8-mention-run thread cap drops the delivery with a VISIBLE system line', async () => {
    const t = seedThread(['alpha', 'beta'], '@alpha go');
    mutateThread(t.id, (th) => { th.mentionRuns = 8; }, home);
    const { orch, runs } = makeOrchestrator((name) =>
      name === 'alpha' ? ok('ASK @beta are you there?') : ok('should not run'));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.map((r) => r.target)).toEqual(['alpha']);
    const after = readThread(t.id, home)!;
    const sys = after.messages.filter((m) => m.authorKind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0].body).toContain('Mention cap reached');
    expect(sys[0].body).toContain('@beta');
    expect(after.participants.find((p) => p.name === 'beta')!.state).toBe('idle');
  });

  // ── One run per agent per wave (owner report 08-27) ─────────────────────────
  //
  // The bug: one announcement, and `dreamcontext` posted three answers — two of them
  // re-answering the same cross-project question, because two different agents had each
  // written `@dreamcontext` into their own reply and each mention spawned its own directed
  // run on top of the announcement run it had already done.

  it('agents ADDRESSING each other by name spawn nothing at all — no runs, no system lines', async () => {
    // The owner's 08-28 thread in miniature: three agents woken together, each opening its
    // reply with the others' names. Before the ASK split this produced six "folded into that
    // run" system lines and zero extra answers.
    const t = seedThread(['alpha', 'beta', 'gamma']);
    const { orch, runs } = makeOrchestrator((name) =>
      ok(`@alpha @beta @gamma — ${name} here, this is my take`));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs).toHaveLength(3); // one per agent, and that is all
    const after = readThread(t.id, home)!;
    expect(after.messages.filter((m) => m.authorKind === 'system')).toHaveLength(0);
    expect(after.participants.every((p) => p.runs === 1)).toBe(true);
    expect(after.mentionRuns).toBe(0);
  });

  it('two agents ASKing the SAME third one in a wave wake it ONCE more, not twice', async () => {
    const t = seedThread(['alpha', 'beta', 'target']);
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'alpha') return ok('ASK @target what do you think?');
      if (name === 'beta') return ok('agreed\nASK @target this is yours');
      if (prompt.includes('CATCH-UP')) return ok('catching up on both');
      return ok('here is my answer');
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    // target answered once, then got ONE catch-up carrying BOTH asks — not one run each.
    expect(runs.filter((r) => r.target === 'target')).toHaveLength(2);
    const catchUp = runs.find((r) => r.target === 'target' && r.prompt.includes('CATCH-UP'))!;
    expect(catchUp.prompt).toContain('what do you think?');
    expect(catchUp.prompt).toContain('this is yours');
    expect(readThread(t.id, home)!.participants.find((p) => p.name === 'target')!.runs).toBe(2);
  });

  it('an ASK that reaches an agent still QUEUED is silent — its prompt will carry it', async () => {
    // concurrency 1: target is queued behind alpha, so alpha's ASK is in the thread before
    // target's prompt is ever built. Nothing is lost, so the room says nothing.
    const t = seedThread(['alpha', 'target']);
    const { orch, runs } = makeOrchestrator(
      (name) => (name === 'alpha' ? ok('ASK @target over to you') : ok('my answer')),
      { concurrency: 1 },
    );
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.filter((r) => r.target === 'target')).toHaveLength(1);
    expect(readThread(t.id, home)!.messages.filter((m) => m.authorKind === 'system')).toHaveLength(0);
    // It really did read the ask, rather than being spared a run by losing it.
    expect(runs.find((r) => r.target === 'target')!.prompt).toContain('ASK @target over to you');
  });

  it('an ASK that lands after its target already answered is NOT dropped — it is caught up, and said', async () => {
    // The 08-28 bug: the room printed "folded into that run" when nothing had been folded, and
    // the user had to ask the room to repeat itself.
    const t = seedThread(['alpha', 'target']);
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'alpha') return ok('ASK @target over to you');
      if (prompt.includes('CATCH-UP')) return ok('right, here is the part you asked for');
      return ok('my answer');
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    const after = readThread(t.id, home)!;
    expect(runs.filter((r) => r.target === 'target')).toHaveLength(2);
    const sys = after.messages.filter((m) => m.authorKind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0].body).toContain('@target');
    expect(sys[0].body).toContain('catch-up run');
    expect(after.messages.some((m) => m.body === 'right, here is the part you asked for')).toBe(true);
  });

  it('an ASK still WAKES an agent the wave skipped (the chain keeps working)', async () => {
    // Only alpha is routed by the announcement, so beta has not been woken this wave.
    const t = seedThread(['alpha', 'beta'], '@alpha you first');
    const { orch, runs } = makeOrchestrator((name) =>
      (name === 'alpha' ? ok('ASK @beta can you confirm?') : ok('confirmed')));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    // alpha (announcement) → beta (directed) → alpha (follow-up, its OWN budget).
    expect(runs.map((r) => r.target)).toEqual(['alpha', 'beta', 'alpha']);
    expect(readThread(t.id, home)!.messages.filter((m) => m.authorKind === 'system')).toHaveLength(0);
  });

  it('an agent gets at most ONE second run per wave, however many it asked', async () => {
    const t = seedThread(['alpha', 'beta', 'gamma'], '@alpha open it');
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'alpha' && prompt.includes('FOLLOW-UP')) return ok('noted, thanks both');
      if (name === 'alpha') return ok('ASK @beta and @gamma, both of you please weigh in');
      return ok(`${name} weighing in`);
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    // Both asks are delivered (neither was woken by the announcement), but the two answers
    // coming back collapse into ONE follow-up rather than two.
    expect(runs.filter((r) => r.target === 'beta')).toHaveLength(1);
    expect(runs.filter((r) => r.target === 'gamma')).toHaveLength(1);
    expect(runs.filter((r) => r.target === 'alpha')).toHaveLength(2); // announcement + 1 follow-up
    const sys = readThread(t.id, home)!.messages.filter((m) => m.authorKind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0].body).toContain('already had its second run');
  });

  it('a NEW user message opens a new wave, so the same agent answers again', async () => {
    const t = seedThread(['alpha', 'target']);
    const { orch, runs } = makeOrchestrator((name) =>
      (name === 'alpha' ? ok('@target thoughts?') : ok('my answer')));

    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();
    expect(runs.filter((r) => r.target === 'target')).toHaveLength(1);

    const reply = appendMessage(t.id, { author: 'user', authorKind: 'user', body: 'and now?' }, home)!;
    orch.deliverUserMessage(t.id, reply.id);
    await orch.idle();

    // The ledger is per WAVE, not per thread: a second question is a second answer.
    expect(runs.filter((r) => r.target === 'target')).toHaveLength(2);
  });

  it('a delivery the CAPS refused does not consume the wave slot', async () => {
    // beta is at its 3-run cap, so the announcement delivery to it is dropped. An ASK of beta
    // later in the same wave must hit the cap line too — never the coalescing path, which
    // would claim a run is in flight when none is.
    const t = seedThread(['alpha', 'beta']);
    mutateThread(t.id, (th) => {
      th.participants.find((p) => p.name === 'beta')!.runs = 3;
    }, home);
    const { orch, runs } = makeOrchestrator(() => ok('ASK @beta are you there?'));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.map((r) => r.target)).toEqual(['alpha']);
    const sys = readThread(t.id, home)!.messages.filter((m) => m.authorKind === 'system');
    expect(sys).toHaveLength(2);
    expect(sys.every((m) => m.body.includes('3-run cap'))).toBe(true);
  });

  // ── WAIT: an agent may hold instead of guessing (owner report 08-28) ────────
  //
  // The bug: the owner tagged three projects meaning "dreamcontext teaches, the other two
  // learn". All three woke at once, so both learners answered before the lesson existed —
  // and said so in the thread ("dreamcontext'in dersleri bana daha ulasmadi").

  it('WAIT holds an agent until the one it named has answered, then wakes it WITH that answer', async () => {
    const t = seedThread(['teacher', 'learner']);
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'teacher') return slow('here is the lesson: theses are optimization claims');
      if (prompt.includes('You asked to wait for @teacher')) return ok('lesson applied to my board');
      return ok('WAIT @teacher');
    }, { concurrency: 3 });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.map((r) => r.target)).toEqual(['teacher', 'learner', 'learner']);
    const after = readThread(t.id, home)!;
    // The WAIT itself is never posted as a message — only the answer it made possible.
    const agentBodies = after.messages.filter((m) => m.authorKind === 'agent').map((m) => m.body);
    expect(agentBodies).toEqual([
      'here is the lesson: theses are optimization claims',
      'lesson applied to my board',
    ]);
    // And the resumed run really did carry the lesson.
    expect(runs[2].prompt).toContain('theses are optimization claims');
    expect(after.participants.find((p) => p.name === 'learner')!.state).toBe('replied');
    const sys = after.messages.filter((m) => m.authorKind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0].body).toContain('@learner is waiting for @teacher');
  });

  it('a bare WAIT waits for everyone still working', async () => {
    const t = seedThread(['a', 'b', 'c']);
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'c' && !prompt.includes('You asked to wait')) return ok('WAIT');
      if (name === 'c') return ok('c speaks last');
      return slow(`${name} speaks`);
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    const bodies = readThread(t.id, home)!.messages
      .filter((m) => m.authorKind === 'agent').map((m) => m.body);
    expect(bodies[bodies.length - 1]).toBe('c speaks last');
    expect(runs.filter((r) => r.target === 'c')).toHaveLength(2);
  });

  it('waiting on someone who PASSES still releases the waiter', async () => {
    const t = seedThread(['quiet', 'waiter']);
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'quiet') return slow('PASS');
      if (prompt.includes('You asked to wait')) return ok('nothing came, here is mine');
      return ok('WAIT @quiet');
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.filter((r) => r.target === 'waiter')).toHaveLength(2);
    expect(readThread(t.id, home)!.messages.some((m) => m.body === 'nothing came, here is mine'))
      .toBe(true);
  });

  it('two agents waiting on EACH OTHER both get released instead of deadlocking', async () => {
    const t = seedThread(['a', 'b']);
    const { orch, runs } = makeOrchestrator((name, prompt) =>
      (prompt.includes('You asked to wait') ? ok(`${name} answered anyway`) : ok(`WAIT @${name === 'a' ? 'b' : 'a'}`)));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs).toHaveLength(4); // two waits, two releases — and it terminated
    const after = readThread(t.id, home)!;
    expect(after.messages.filter((m) => m.authorKind === 'agent').map((m) => m.body).sort())
      .toEqual(['a answered anyway', 'b answered anyway']);
    expect(after.messages.some((m) => m.authorKind === 'system' && m.body.includes('did not answer this round')))
      .toBe(true);
  });

  it('waiting for someone who was never woken releases at once, without a wasted round trip', async () => {
    // Only alpha is routed, so gamma is idle and can never settle.
    const t = seedThread(['alpha', 'gamma'], '@alpha only you');
    const { orch, runs } = makeOrchestrator((_n, prompt) =>
      (prompt.includes('You asked to wait') ? ok('fine, here is my answer') : ok('WAIT @gamma')));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.map((r) => r.target)).toEqual(['alpha', 'alpha']);
    expect(runs[1].prompt).toContain('You asked to wait');
    expect(readThread(t.id, home)!.messages.filter((m) => m.authorKind === 'system')).toHaveLength(0);
  });

  it('ONE wait per agent per round — a second is refused rather than looping', async () => {
    const t = seedThread(['teacher', 'learner']);
    const { orch, runs } = makeOrchestrator((name) =>
      (name === 'teacher' ? ok('the lesson') : ok('WAIT @teacher')));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.filter((r) => r.target === 'learner')).toHaveLength(2); // wait, resume — not 3
    const after = readThread(t.id, home)!;
    expect(after.participants.find((p) => p.name === 'learner')!.state).toBe('passed');
    expect(after.messages.some((m) => m.authorKind === 'system' && m.body.includes('a second time')))
      .toBe(true);
  });

  it('an agent that WAITED and then answered still spends only ONE answer slot', async () => {
    const t = seedThread(['teacher', 'learner']);
    const { orch } = makeOrchestrator((name, prompt) =>
      (name === 'teacher'
        ? ok('the lesson')
        : prompt.includes('You asked to wait') ? ok('my answer') : ok('WAIT @teacher')));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    // Two real runs were spent (the WAIT is not free), and the 3-run cap still has headroom.
    expect(readThread(t.id, home)!.participants.find((p) => p.name === 'learner')!.runs).toBe(2);
  });

  it('an ASK aimed at a WAITING agent coalesces into its resume — no run beside it', async () => {
    // The parked agent keeps its answer slot precisely so this cannot spawn a second run.
    // Its resumed prompt is built from the whole thread, so the ask reaches it anyway.
    const t = seedThread(['teacher', 'learner', 'asker']);
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'teacher') return slow('the lesson');
      if (name === 'asker') return ok('over to the learner\nASK @learner what do you make of it?');
      if (prompt.includes('You asked to wait')) return ok('learner answers once, having read both');
      return ok('WAIT @teacher');
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    // wait + resume, and nothing else — not a third run for the ask.
    expect(runs.filter((r) => r.target === 'learner')).toHaveLength(2);
    const after = readThread(t.id, home)!;
    expect(after.participants.find((p) => p.name === 'learner')!.runs).toBe(2);
    expect(after.messages.filter((m) => m.author === 'learner' && m.authorKind === 'agent'))
      .toHaveLength(1);
    // The ask was not lost: the resumed prompt carried it, and no drop was reported.
    expect(runs.find((r) => r.target === 'learner' && r.prompt.includes('You asked to wait'))!.prompt)
      .toContain('what do you make of it?');
    expect(after.messages.some((m) => m.authorKind === 'system' && m.body.includes('catch-up')))
      .toBe(false);
  });

  it('a new user message never leaves an agent frozen mid-WAIT', async () => {
    // The park belongs to a round. When the user moves on, holding it would freeze a chip
    // that claims the agent is about to speak on a question nobody is asking any more.
    const t = seedThread(['teacher', 'learner']);
    let released = false;
    const { orch } = makeOrchestrator((name) => {
      if (name === 'teacher') return released ? ok('teacher again') : slow('the lesson');
      return ok('WAIT @teacher');
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    // Interrupt while the learner is parked and the teacher is still thinking.
    await new Promise((r) => setTimeout(r, 20));
    expect(readThread(t.id, home)!.participants.find((p) => p.name === 'learner')!.state)
      .toBe('waiting');
    released = true;
    const next = appendMessage(t.id, { author: 'user', authorKind: 'user', body: 'never mind, new question' }, home)!;
    orch.deliverUserMessage(t.id, next.id);
    await orch.idle();

    const after = readThread(t.id, home)!;
    expect(after.participants.find((p) => p.name === 'learner')!.state).not.toBe('waiting');
    expect(after.messages.some((m) => m.authorKind === 'system' && m.body.includes('when the conversation moved on')))
      .toBe(true);
  });

  it('a WAIT-then-answer still closes the loop for whoever ASKed', async () => {
    const t = seedThread(['alpha', 'beta', 'slow'], '@alpha you first');
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'alpha' && prompt.includes('FOLLOW-UP')) return ok('thanks, noted');
      if (name === 'alpha') return ok('ASK @beta what do you know?');
      if (name === 'beta' && prompt.includes('You asked to wait')) return ok('beta answers at last');
      if (name === 'beta') return ok('WAIT @slow');
      return ok('slow speaks');
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    // beta waited on an agent that was never woken, was released, answered — and alpha still
    // got the follow-up carrying that answer.
    const follow = runs.find((r) => r.prompt.includes('FOLLOW-UP'));
    expect(follow?.target).toBe('alpha');
    expect(follow?.prompt).toContain('beta answers at last');
  });

  // ── Global model/effort ────────────────────────────────────────────────────

  it('every run is spawned with the app-global model/effort, read PER RUN', async () => {
    const t = seedThread(['alpha', 'beta']);
    let picked = { model: 'opus', effort: 'xhigh' };
    const { orch, runs } = makeOrchestrator(() => ok('done'), {
      concurrency: 1,
      chatDefaults: () => picked,
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    // Changed while the fan-out is in flight: the agents that have not woken yet get the
    // new pick, which is what "global, applied from now on" has to mean.
    await new Promise((r) => setTimeout(r, 1));
    picked = { model: 'sonnet', effort: 'low' };
    await orch.idle();

    expect(runs).toHaveLength(2);
    expect(runs[runs.length - 1].opts.model).toBe('sonnet');
    expect(runs[runs.length - 1].opts.effort).toBe('low');
  });

  it('with nothing pinned, no model/effort flag is chosen — the CLI keeps its own default', async () => {
    const t = seedThread(['alpha']);
    const { orch, runs } = makeOrchestrator(() => ok('done'));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs[0].opts.model).toBe('');
    expect(runs[0].opts.effort).toBe('');
  });

  it('in-flight runs of an ARCHIVED thread still land their answers there', async () => {
    const t = seedThread(['alpha']);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const { orch } = makeOrchestrator(async () => { await gate; return ok('late but honest'); });

    orch.deliverUserMessage(t.id, t.messages[0].id);
    // Archive the thread WHILE alpha is still thinking (a new post does this).
    const second = createThread(
      { body: 'the next thing', participants: [{ name: 'alpha', whatItIs: '' }] },
      home, new Date(Date.now() + 10),
    );
    expect(second).not.toBeNull();
    release!();
    await orch.idle();

    const archived = readThread(t.id, home)!;
    expect(archived.closedAt).not.toBeNull();
    expect(archived.messages.map((m) => m.body)).toContain('late but honest');
  });
});
