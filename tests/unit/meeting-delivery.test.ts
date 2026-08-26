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
}

/** An orchestrator whose runner answers from a per-vault script and records every run. */
function makeOrchestrator(
  script: (target: string, prompt: string) => LiveRunResult | Promise<LiveRunResult>,
  opts: { concurrency?: number } = {},
) {
  const runs: RecordedRun[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const runner: HeadlessRunner = async (peer, prompt) => {
    runs.push({ target: peer.name, prompt });
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
  const roster = ['alpha', 'beta', 'Tilki', 'Tilki Ogretmen'];

  it('finds plain mentions in first-occurrence order, deduped', () => {
    expect(parseMentions('@beta then @alpha then @beta again', roster)).toEqual(['beta', 'alpha']);
  });

  it('resolves names WITH SPACES via longest-name-first', () => {
    expect(parseMentions('ask @Tilki Ogretmen about payouts', roster)).toEqual(['Tilki Ogretmen']);
    expect(parseMentions('ask @Tilki about payouts', roster)).toEqual(['Tilki']);
  });

  it('a consumed span never re-matches a shorter name inside it', () => {
    const hits = parseMentions('@Tilki Ogretmen and @Tilki', roster);
    expect(hits).toEqual(['Tilki Ogretmen', 'Tilki']);
  });

  it('an email address is not a mention', () => {
    expect(parseMentions('mail me at a@beta.com or x@alpha', roster)).toEqual([]);
  });

  it('a longer unknown token is not a mention (@betamax)', () => {
    expect(parseMentions('use @betamax for tapes', roster)).toEqual([]);
  });

  it('is case-insensitive but returns the registered casing', () => {
    expect(parseMentions('@ALPHA and @tilki ogretmen', roster)).toEqual(['alpha', 'Tilki Ogretmen']);
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
