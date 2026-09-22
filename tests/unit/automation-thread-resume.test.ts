/**
 * The THREAD half of the verdict engine — what changes when a resume is answering a
 * reply typed into an agent's channel rather than a message sent from a phone.
 *
 * Three properties are under test, and they fail in three different directions:
 *
 *   1. THE SURFACE picks the preamble, and the two preambles make OPPOSITE promises
 *      about delivery. Telegram's says the final message reaches the human; the
 *      thread's says it reaches nobody unless the run POSTs. An agent briefed with the
 *      wrong one answers into the void and believes it replied.
 *   2. THE ENV IS A GUARD, not a convenience. `executeClaudeDetached` merges the
 *      caller's env LAST into a `bypassPermissions` child, so anything that reaches it
 *      wins over the process's own. Only `DREAMCONTEXT_AUTOMATION_*` may pass, and the
 *      account's `CLAUDE_CONFIG_DIR` must be the one the RUN would have used — this
 *      path previously passed no env at all and silently inherited the server's.
 *   3. THE THREAD RECORD is best-effort and kind-scoped. An answered `flow-hitl`
 *      question leaves a `replied` entry in its run's thread; an `approval` question —
 *      the manifest-diff ask raised before an unapproved run ever starts — leaves
 *      NOTHING, because it was never a run of the job. And a thread that cannot be
 *      written must not change what answering reports.
 *
 * Everything is driven through the real `resumeWithMessage` / `resumeWithAnswer` with
 * an injected `spawnImpl`, so what is asserted is what a child would actually receive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildThreadMessagePreamble,
  resumeWithAnswer,
  resumeWithMessage,
} from '../../src/lib/automations/verdict.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { recordAutomationSession } from '../../src/lib/automations/session-registry.js';
import { createQuestion } from '../../src/lib/automations/hitl.js';
import { appendThreadEntry, readThread, threadSlugDir } from '../../src/lib/automations/threads.js';
import { accountEnvFor, resolveConfigDir } from '../../src/lib/claude-accounts.js';
import type { SpawnImpl } from '../../src/lib/automations/runner.js';
import type { AutomationManifest, AutomationQuestion } from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = new Date('2026-09-22T18:00:00.000Z');
const SESSION = 'sess-thread-1';

// ─── fakes ───────────────────────────────────────────────────────────────────

/** A spawn that replies once and closes cleanly, capturing BOTH the argv and the env
 *  the child would have been given — the env is the whole point of this suite.
 *
 *  `opts.envelope` merges extra fields into the JSON the child prints (the real
 *  `--output-format json` shape); `opts.raw` replaces that JSON with arbitrary bytes, for
 *  the case where there is no envelope to read anything out of. */
function fakeSpawn(result = 'done', opts: { envelope?: Record<string, unknown>; raw?: string } = {}) {
  const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
  const impl = vi.fn((_cmd: string, args: string[], spawnOpts: { env?: Record<string, string | undefined> }) => {
    calls.push({ args, env: spawnOpts?.env ?? {} });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 999, stdout, stderr, kill: () => {} });
    const out =
      opts.raw ??
      JSON.stringify({ session_id: SESSION, result, is_error: false, permission_denials: [], ...opts.envelope });
    setImmediate(() => {
      stdout.emit('data', Buffer.from(out, 'utf-8'));
      child.emit('close', 0);
    });
    return child;
  }) as unknown as SpawnImpl;
  return { impl, calls };
}

/** The prompt actually handed to claude — `-p <prompt>` in the resume argv. */
function promptOf(call: { args: string[] }): string {
  const i = call.args.indexOf('-p');
  return i >= 0 ? call.args[i + 1] : '';
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeAutomation(overrides: Partial<Parameters<typeof createAutomation>[1]> = {}): AutomationManifest {
  return createAutomation(contextRoot, {
    slug: 'digest',
    title: 'Daily digest',
    days: 'daily',
    at: '18:00',
    prompt: 'Write the digest.',
    review: 'agent',
    ...overrides,
  });
}

/** A bound session, which is what a resume actually trusts. */
function bindSession(slug = 'digest'): void {
  recordAutomationSession(slug, SESSION, home, NOW.getTime());
}

function makeQuestion(overrides: Partial<Parameters<typeof createQuestion>[1]> = {}): AutomationQuestion {
  const q = createQuestion(contextRoot, {
    slug: 'digest',
    runFiredAt: NOW.toISOString(),
    kind: 'flow-hitl',
    sessionId: SESSION,
    channel: 'chat',
    question: 'Send the digest?',
    choices: ['send', 'skip'],
    nowISO: NOW.toISOString(),
    ...overrides,
  });
  if (q.sessionId) recordAutomationSession(q.slug, q.sessionId, home, NOW.getTime());
  return q;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-thread-resume-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-thread-resume-home-'));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ─── 1. The surface picks the preamble ───────────────────────────────────────

describe('surface selects the preamble, and the two make opposite delivery promises', () => {
  it("defaults to telegram — every caller written before `surface` existed is unchanged", async () => {
    makeAutomation();
    bindSession();
    const { impl, calls } = fakeSpawn();
    const out = await resumeWithMessage(contextRoot, 'digest', 'how did it go?', {
      home, spawnImpl: impl, now: () => NOW,
    });
    expect(out.status).toBe('ok');
    const prompt = promptOf(calls[0]);
    expect(prompt).toContain('delivered');
    expect(prompt).toContain('phone');
    // The Telegram preamble must NOT tell a run to post — nothing is reading that thread.
    expect(prompt).not.toContain('automations post');
  });

  it("surface:'thread' briefs the run to POST, and withdraws the delivery promise", async () => {
    makeAutomation();
    bindSession();
    const { impl, calls } = fakeSpawn();
    const out = await resumeWithMessage(contextRoot, 'digest', 'why is WAU down?', {
      home, spawnImpl: impl, now: () => NOW, surface: 'thread',
    });
    expect(out.status).toBe('ok');
    const prompt = promptOf(calls[0]);
    expect(prompt).toContain('automations post');
    expect(prompt).toContain('replied in its thread');
    // THE LOAD-BEARING HALF: it must not repeat Telegram's promise, because here it
    // is false — a run that answers without posting has answered nobody.
    expect(prompt).not.toContain('phone');
    expect(prompt).toContain('NOT published anywhere');
  });

  it('the builder carries the human message verbatim, fenced', () => {
    const p = buildThreadMessagePreamble('  ship it, but drop the intro  ');
    expect(p).toContain("--- THE HUMAN'S MESSAGE (verbatim) ---");
    expect(p).toContain('ship it, but drop the intro');
    expect(p).toContain('--- END MESSAGE ---');
    expect(p).toContain('it is not a new');
  });
});

// ─── 2. The env allowlist (AC D8) ────────────────────────────────────────────

describe('the resume env is an allowlist, not a passthrough', () => {
  it('carries the two run hints to the child', async () => {
    makeAutomation();
    bindSession();
    const { impl, calls } = fakeSpawn();
    await resumeWithMessage(contextRoot, 'digest', 'hi', {
      home, spawnImpl: impl, now: () => NOW, surface: 'thread',
      env: { DREAMCONTEXT_AUTOMATION_SLUG: 'digest', DREAMCONTEXT_AUTOMATION_RUN: NOW.toISOString() },
    });
    expect(calls[0].env.DREAMCONTEXT_AUTOMATION_SLUG).toBe('digest');
    expect(calls[0].env.DREAMCONTEXT_AUTOMATION_RUN).toBe(NOW.toISOString());
  });

  it('a PATH / CLAUDE_CONFIG_DIR / NODE_OPTIONS / HOME smuggled past the type never reaches spawnImpl', async () => {
    makeAutomation();
    bindSession();
    const { impl, calls } = fakeSpawn();
    const before = { PATH: process.env.PATH, HOME: process.env.HOME };
    await resumeWithMessage(contextRoot, 'digest', 'hi', {
      home, spawnImpl: impl, now: () => NOW, surface: 'thread',
      // The type forbids these. A test that only respected the type would be
      // testing the compiler; the guard under test is the runtime filter.
      env: {
        DREAMCONTEXT_AUTOMATION_SLUG: 'digest',
        PATH: '/tmp/evil',
        CLAUDE_CONFIG_DIR: '/tmp/evil-config',
        NODE_OPTIONS: '--require /tmp/evil.js',
        HOME: '/tmp/evil-home',
      } as unknown as { DREAMCONTEXT_AUTOMATION_SLUG?: string },
    });
    const env = calls[0].env;
    expect(env.DREAMCONTEXT_AUTOMATION_SLUG).toBe('digest');
    expect(env.PATH).not.toBe('/tmp/evil');
    expect(env.NODE_OPTIONS).not.toBe('--require /tmp/evil.js');
    expect(env.HOME).not.toBe('/tmp/evil-home');
    expect(env.CLAUDE_CONFIG_DIR).not.toBe('/tmp/evil-config');
    // and the real process env is untouched either way
    expect(process.env.PATH).toBe(before.PATH);
    expect(process.env.HOME).toBe(before.HOME);
  });

  it("runs on the RUN's account: CLAUDE_CONFIG_DIR is absent, or equals accountEnvFor's value", async () => {
    makeAutomation();
    bindSession();
    const { impl, calls } = fakeSpawn();
    await resumeWithMessage(contextRoot, 'digest', 'hi', { home, spawnImpl: impl, now: () => NOW });
    // ABSENCE IS A PASS, and deliberately so: `accountEnvFor` returns
    // `{ CLAUDE_CONFIG_DIR: undefined }` for the machine's own account, which REMOVES an
    // inherited value rather than setting one. Asserting "present and equal" would fail
    // on exactly the common single-account machine.
    const expected = accountEnvFor(resolveConfigDir(null)).CLAUDE_CONFIG_DIR;
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(expected);
  });
});

// ─── The turn's cost, off the child's own envelope ───────────────────────────

/**
 * The channel's terminal row reads "Reply turn finished · 1m 12s · $0.03", and the reply
 * job can only print what the outcome carries. Duration it measures itself; COST exists
 * nowhere but the resume child's JSON envelope, so `TalkOutcome` has to carry it out.
 */
describe('TalkOutcome carries the turn cost from the resume envelope', () => {
  it('reads total_cost_usd — the same field parseClaudeJson reads for a scheduled run', async () => {
    makeAutomation();
    bindSession();
    const { impl } = fakeSpawn('done', { envelope: { total_cost_usd: 0.03 } });
    const out = await resumeWithMessage(contextRoot, 'digest', 'hi', {
      home, spawnImpl: impl, now: () => NOW, surface: 'thread',
    });
    expect(out.status).toBe('ok');
    expect(out.costUsd).toBe(0.03);
  });

  it('is null when the output does not parse — there is no envelope to read', async () => {
    makeAutomation();
    bindSession();
    const { impl } = fakeSpawn('done', { raw: 'not json at all' });
    const out = await resumeWithMessage(contextRoot, 'digest', 'hi', {
      home, spawnImpl: impl, now: () => NOW, surface: 'thread',
    });
    expect(out.status).toBe('failed');
    expect(out.costUsd).toBeNull();
  });

  it('is null, not undefined, when an envelope simply omits the field', async () => {
    makeAutomation();
    bindSession();
    const { impl } = fakeSpawn('done');
    const out = await resumeWithMessage(contextRoot, 'digest', 'hi', { home, spawnImpl: impl, now: () => NOW });
    expect(out.status).toBe('ok');
    expect(out.costUsd).toBeNull();
  });

  it('a FAILED turn still reports what it burned — is_error is not free', async () => {
    makeAutomation();
    bindSession();
    const { impl } = fakeSpawn('', { envelope: { is_error: true, total_cost_usd: 0.11 } });
    const out = await resumeWithMessage(contextRoot, 'digest', 'hi', { home, spawnImpl: impl, now: () => NOW });
    expect(out.status).toBe('failed');
    expect(out.costUsd).toBe(0.11);
  });

  it('a refusal never spawned anything, so it has no cost to report', async () => {
    makeAutomation();
    // No bound session ⇒ refused before any spawn.
    const { impl } = fakeSpawn();
    const out = await resumeWithMessage(contextRoot, 'digest', 'hi', { home, spawnImpl: impl, now: () => NOW });
    expect(out.status).toBe('refused');
    expect(out.costUsd).toBeNull();
  });
});

// ─── 3. The thread record on an answered question ────────────────────────────

describe('an answered question leaves a record in its run thread', () => {
  it("appends system:replied naming the channel, for a flow-hitl question", async () => {
    makeAutomation();
    const q = makeQuestion();
    const { impl } = fakeSpawn();
    const out = await resumeWithAnswer(contextRoot, q, 'send', 'dashboard', {
      home, spawnImpl: impl, now: () => NOW,
    });
    expect(out.status).toBe('ok');
    const entries = readThread(contextRoot, 'digest', { runId: NOW.toISOString() });
    const replied = entries.filter((e) => e.kind === 'system' && e.event === 'replied');
    expect(replied).toHaveLength(1);
    expect(replied[0].text).toBe('Question answered via dashboard. Session resumed.');
    expect(replied[0].via).toBe('runner');
    expect(replied[0].runId).toBe(NOW.toISOString());
  });

  it('writes NOTHING for an approval question — it was never a run of the job', async () => {
    makeAutomation();
    // An approval question is created with its session forced null, so it is refused
    // before any spawn. The point of the assertion is the THREAD, not the refusal:
    // an entry here would open a thread for a fire that never happened.
    const q = createQuestion(contextRoot, {
      slug: 'digest',
      runFiredAt: NOW.toISOString(),
      kind: 'approval',
      sessionId: SESSION,
      channel: 'chat',
      question: 'The prompt changed. Approve?',
      choices: ['approve', 'reject'],
      nowISO: NOW.toISOString(),
    });
    const { impl } = fakeSpawn();
    const out = await resumeWithAnswer(contextRoot, q, 'approve', 'cli', {
      home, spawnImpl: impl, now: () => NOW,
    });
    expect(out.status).toBe('refused');
    expect(readThread(contextRoot, 'digest')).toHaveLength(0);
  });

  it('a thread that cannot be written does not change what answering reports', async () => {
    makeAutomation();
    const q = makeQuestion();
    // Make the append fail for real rather than mocking the module: a FILE where the
    // slug's thread directory has to go means `mkdirSync` throws ENOTDIR from inside
    // `appendThreadEntry`, which is precisely the best-effort path under test.
    mkdirSync(join(contextRoot, 'automations', 'threads'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(threadSlugDir(contextRoot, 'digest'), 'not a directory', 'utf-8');

    const { impl } = fakeSpawn('Sent to 41 subscribers.');
    const out = await resumeWithAnswer(contextRoot, q, 'send', 'telegram', {
      home, spawnImpl: impl, now: () => NOW,
    });
    // The answer still succeeded and still reports the agent's own words.
    expect(out.status).toBe('ok');
    expect(out.result).toBe('Sent to 41 subscribers.');
    expect(out.question.state).toBe('answered');
  });

  it('the record sits in the ASKING run thread, alongside what the run already posted', async () => {
    makeAutomation();
    const q = makeQuestion();
    appendThreadEntry(contextRoot, 'digest', {
      runId: NOW.toISOString(),
      kind: 'agent',
      via: 'cli',
      text: 'WAU is down 4% week-over-week.',
    });
    const { impl } = fakeSpawn();
    await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
    const entries = readThread(contextRoot, 'digest', { runId: NOW.toISOString() });
    expect(entries.map((e) => e.kind)).toEqual(['agent', 'system']);
    expect(entries[1].event).toBe('replied');
  });
});
