import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PeerTarget, LiveRunResult } from '../../src/lib/peer-delivery.js';
import {
  MeetingOrchestrator,
  buildMeetingPrompt,
  parseMentions,
  routeUserMessage,
  type HeadlessRunner,
} from '../../src/lib/meeting-delivery.js';
import {
  appendMessage,
  createThread,
  mutateThread,
  readThread,
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

  it('agent-to-agent mention: ONE directed run, then ONE follow-up carrying the answer — depth 1', async () => {
    const t = seedThread(['alpha', 'beta', 'gamma'], '@alpha kick off');
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'alpha' && prompt.includes('FOLLOW-UP')) return ok('thanks @beta, noted — and @gamma too');
      if (name === 'alpha') return ok('starting — @beta can you confirm?');
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
      'starting — @beta can you confirm?',
      'confirmed, and @gamma should know',
      'thanks @beta, noted — and @gamma too',
    ]);
    expect(after.mentionRuns).toBe(2); // directed + follow-up
    // The directed prompt fenced ALPHA's reply, not the announcement.
    const directedPrompt = runs[1].prompt;
    expect(directedPrompt).toContain('<<<MEETING-MESSAGE\nstarting — @beta can you confirm?');
    // The follow-up prompt carried beta's answer.
    expect(runs[2].prompt).toContain('FOLLOW-UP');
    expect(runs[2].prompt).toContain('confirmed, and @gamma should know');
  });

  it('a directed run that PASSes spawns no follow-up', async () => {
    const t = seedThread(['alpha', 'beta'], '@alpha go');
    const { orch, runs } = makeOrchestrator((name) =>
      name === 'alpha' ? ok('@beta anything?') : ok('PASS'));
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
      name === 'alpha' ? ok('@beta are you there?') : ok('should not run'));
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

  it('two agents mentioning the SAME third one in a wave wake it ONCE, not twice', async () => {
    const t = seedThread(['alpha', 'beta', 'target']);
    const { orch, runs } = makeOrchestrator((name) => {
      if (name === 'alpha') return ok('@target what do you think?');
      if (name === 'beta') return ok('agreed — @target this is yours');
      return ok('here is my answer');
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    // target ran exactly once, for the announcement — NOT again per mention.
    expect(runs.filter((r) => r.target === 'target')).toHaveLength(1);
    const after = readThread(t.id, home)!;
    expect(after.messages.filter((m) => m.author === 'target' && m.authorKind === 'agent'))
      .toHaveLength(1);
    expect(after.participants.find((p) => p.name === 'target')!.runs).toBe(1);
  });

  it('a coalesced mention is VISIBLE — it names the asker and says no second run started', async () => {
    const t = seedThread(['alpha', 'target']);
    const { orch } = makeOrchestrator((name) =>
      (name === 'alpha' ? ok('@target over to you') : ok('my answer')));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    const sys = readThread(t.id, home)!.messages.filter((m) => m.authorKind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0].body).toContain('@target');
    expect(sys[0].body).toContain('@alpha');
    expect(sys[0].body).toContain('already answering this round');
  });

  it('a mention still WAKES an agent the wave skipped (the chain keeps working)', async () => {
    // Only alpha is routed by the announcement, so beta has not been woken this wave.
    const t = seedThread(['alpha', 'beta'], '@alpha you first');
    const { orch, runs } = makeOrchestrator((name) =>
      (name === 'alpha' ? ok('@beta can you confirm?') : ok('confirmed')));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    // alpha (announcement) → beta (directed) → alpha (follow-up, its OWN budget).
    expect(runs.map((r) => r.target)).toEqual(['alpha', 'beta', 'alpha']);
    expect(readThread(t.id, home)!.messages.filter((m) => m.authorKind === 'system')).toHaveLength(0);
  });

  it('an agent gets at most ONE follow-up per wave, however many it mentioned', async () => {
    const t = seedThread(['alpha', 'beta', 'gamma'], '@alpha open it');
    const { orch, runs } = makeOrchestrator((name, prompt) => {
      if (name === 'alpha' && prompt.includes('FOLLOW-UP')) return ok('noted, thanks both');
      if (name === 'alpha') return ok('@beta and @gamma, both of you please weigh in');
      return ok(`${name} weighing in`);
    });
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    // Both mentions are delivered (neither was woken by the announcement), but the two
    // answers coming back collapse into ONE follow-up rather than two.
    expect(runs.filter((r) => r.target === 'beta')).toHaveLength(1);
    expect(runs.filter((r) => r.target === 'gamma')).toHaveLength(1);
    expect(runs.filter((r) => r.target === 'alpha')).toHaveLength(2); // announcement + 1 follow-up
    const sys = readThread(t.id, home)!.messages.filter((m) => m.authorKind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0].body).toContain('already had its follow-up');
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
    // beta is at its 3-run cap, so the announcement delivery to it is dropped. A mention of
    // beta later in the same wave must hit the cap line too — never the coalescing line,
    // which would claim a run is in flight when none is.
    const t = seedThread(['alpha', 'beta']);
    mutateThread(t.id, (th) => {
      th.participants.find((p) => p.name === 'beta')!.runs = 3;
    }, home);
    const { orch, runs } = makeOrchestrator(() => ok('@beta are you there?'));
    orch.deliverUserMessage(t.id, t.messages[0].id);
    await orch.idle();

    expect(runs.map((r) => r.target)).toEqual(['alpha']);
    const sys = readThread(t.id, home)!.messages.filter((m) => m.authorKind === 'system');
    expect(sys).toHaveLength(2);
    expect(sys.every((m) => m.body.includes('3-run cap'))).toBe(true);
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
