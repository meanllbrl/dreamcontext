/**
 * The verdict engine — propose guard, and the ONE path a human's answer takes.
 *
 * T12 retired the review-card half of `verdict.ts` (`resumeWithVerdict`,
 * `applySteer`, and the four preamble builders that existed only for them):
 * every surface that could answer a card is gone (the CLI's `review` verb, the
 * dashboard queue, the server routes, Telegram), so a test suite for a path
 * nothing can reach is not coverage, it is ballast. `proposeFromRun` is kept
 * and repointed — it now creates a `kind: 'flow-hitl'` {@link AutomationQuestion}
 * instead of a `ReviewCard`, so a run that stops to propose produces something
 * a human can actually answer.
 *
 * What is actually under test, in order of how badly it fails:
 *   1. the PROPOSE GUARD — an answer resumes the session a question names, so a
 *      question anyone can plant is an arbitrary bypassPermissions conversation
 *      waiting for the operator's tap;
 *   2. the KIND GATE — an `approval` question must never be resumed, whatever a
 *      stale caller-held copy claims;
 *   3. the MACHINE-LOCAL BINDING is the authority a resume trusts, never what a
 *      question file merely names;
 *   4. VERDICT-BEFORE-SPAWN, and the single exception where a settled question
 *      is put back (nothing spawned ⇒ provably nothing happened);
 *   5. the CAPABILITY LIFETIME — a binding retires once its question is settled
 *      and nobody kept a chat tab open on it.
 *
 * DELIBERATELY NOT re-tested here (behaviour that no longer exists, not
 * behaviour softened in place): the review-card verdict engine had a THIRD
 * gesture, `applySteer` — free text that revised a pending card's body without
 * resolving it, so a correction could be handed back and forth before a verdict
 * was ever given. Nothing in the question model has an equivalent: an answer to
 * a question always resumes and always settles it (`resolveQuestion` inside
 * `claimQuestion`); there is no "revise and stay pending" path. Every other
 * property the old suite pinned on `resumeWithVerdict`/`applySteer` — a planted
 * session refuses, a lock held refuses without spending the answer, a spawn
 * failure reopens, a resume that spawned-then-failed does NOT reopen, a sidecar
 * is written so the resume stays killable — has a like-for-like equivalent
 * below, proven against `resumeWithAnswer` instead, so none of that coverage
 * was lost in the migration; only the steer gesture itself was.
 *
 * `claude` is never really spawned: every test injects a fake child, so no test
 * in this file can cost a token or reach the network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { defaultAncestryProbe, proposeFromRun, resumeWithAnswer, resumeWithMessage } from '../../src/lib/automations/verdict.js';
import { createAutomation, lockPathFor, readRunSidecar, writeRunSidecar } from '../../src/lib/automations/store.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { latestBoundSession, readAutomationSession, recordAutomationSession } from '../../src/lib/automations/session-registry.js';
import { createQuestion, listQuestions, pendingQuestion } from '../../src/lib/automations/hitl.js';
import type { SpawnImpl } from '../../src/lib/automations/runner.js';
import type { AutomationManifest, AutomationQuestion } from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = new Date('2026-08-03T18:00:00.000Z');
const SESSION = 'sess-abc123';
const RUN_PGID = 4242;

/** The real process group of `pid`, read the way an operator would. */
function pgidOf(pid: number): number {
  return Number.parseInt(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf-8' }).trim(), 10);
}

// ─── fakes ───────────────────────────────────────────────────────────────────

function makeFakeChild(pid: number | undefined) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { pid, stdout, stderr, kill: () => {} });
  return { child, stdout, stderr };
}

/** A spawn that immediately replies with `stdoutJson` and closes cleanly.
 *  Captures the argv so a test can assert what was actually asked of claude. */
function fakeSpawn(stdoutJson: string, opts: { pid?: number | undefined } = {}) {
  const calls: string[][] = [];
  const impl = vi.fn((_cmd: string, args: string[]) => {
    calls.push(args);
    const { child, stdout } = makeFakeChild('pid' in opts ? opts.pid : 999);
    if (child.pid != null) {
      setImmediate(() => {
        stdout.emit('data', Buffer.from(stdoutJson, 'utf-8'));
        child.emit('close', 0);
      });
    }
    return child;
  }) as unknown as SpawnImpl;
  return { impl, calls };
}

function claudeJson(result: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: SESSION, result, is_error: false, permission_denials: [], ...extra });
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeAutomation(overrides: Partial<Parameters<typeof createAutomation>[1]> = {}): AutomationManifest {
  const m = createAutomation(contextRoot, {
    slug: 'digest',
    title: 'Daily digest',
    days: 'daily',
    at: '18:00',
    prompt: 'Write the digest.',
    review: 'agent',
    ...overrides,
  });
  // Approved, as every real resumable agent is: a resume re-checks approval under the lock.
  approveAutomation(projectRoot, m, NOW, home);
  return m;
}

function putSidecar(slug = 'digest', childPgid = RUN_PGID): void {
  writeRunSidecar(contextRoot, slug, {
    slug,
    runnerPid: 1000,
    childPid: childPgid,
    childPgid,
    fireAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    timeoutAt: new Date(NOW.getTime() + 900_000).toISOString(),
  });
}

/** A question AND the machine-local binding the runner would have recorded —
 *  one without a binding is, by design, unresumable. */
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
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-verdict-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-verdict-home-'));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ─── The propose guard ───────────────────────────────────────────────────────

describe('propose is guarded by the run\'s ancestry', () => {
  const input = { title: 'Publish this', body: 'the proposal' };

  it('accepts a call from below the run child, and produces a flow-hitl question', () => {
    makeAutomation();
    putSidecar();
    const r = proposeFromRun(contextRoot, 'digest', input, { ancestryProbe: () => [5000, RUN_PGID, 1000] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.state).toBe('pending');
      expect(r.card.runFiredAt).toBe(NOW.toISOString());
      // A proposal made from inside an already-approved, already-running
      // session is legitimately resumable — never the `approval` kind, which
      // is reserved for the manifest-diff ask on an UNAPPROVED manifest.
      expect(r.card.kind).toBe('flow-hitl');
    }
  });

  it('REFUSES a caller the run child is not an ancestor of — a human shell, another run', () => {
    // The load-bearing case. A planted question is a request to resume an
    // arbitrary conversation with bypassPermissions on the operator's tap.
    makeAutomation();
    putSidecar();
    const r = proposeFromRun(contextRoot, 'digest', input, { ancestryProbe: () => [900, 800] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/own run/);
    expect(listQuestions(contextRoot, 'digest')).toEqual([]);
  });

  it('REFUSES a process reparented away from the run, whatever group it kept', () => {
    // A double-forked daemon keeps the run's pgid but its parent is launchd:
    // the chain no longer reaches the run child, so it is not the run any more.
    makeAutomation();
    putSidecar();
    const r = proposeFromRun(contextRoot, 'digest', input, { ancestryProbe: () => [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/own run/);
  });

  it('REAL processes: a descendant in its own process group is admitted by the default probes; an outsider is not', async () => {
    // No mocks — a pgid mock is what hid the bug. The run child is a
    // detached shell (its own group, like the runner's spawn); with job control
    // on, its background job gets a FRESH group, the shape Claude Code's Bash
    // tool gives every command. That job is the caller.
    const run = spawn('/bin/sh', ['-c', 'set -m; sleep 30 & echo $!; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      const caller = await new Promise<number>((resolve, reject) => {
        run.stdout!.once('data', (d: Buffer) => resolve(Number.parseInt(d.toString().trim(), 10)));
        run.once('error', reject);
      });
      makeAutomation();
      putSidecar('digest', run.pid as number);
      expect(pgidOf(caller)).not.toBe(run.pid);
      expect(defaultAncestryProbe(caller)).toContain(run.pid);
      const r = proposeFromRun(contextRoot, 'digest', input, { callerPid: caller });
      expect(r.ok).toBe(true);
      // The test process is neither in the run's group nor below it (the guard
      // refuses before the open-question gate is ever reached).
      const outsider = proposeFromRun(contextRoot, 'digest', input);
      expect(outsider.ok).toBe(false);
      if (!outsider.ok) expect(outsider.reason).toMatch(/own run/);
    } finally {
      try { process.kill(-(run.pid as number), 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('REAL processes: a daemon that double-forked out of the run keeps its pgid and is still refused', async () => {
    // The looseness the group check had: `( … & )` reparents the grandchild to
    // launchd while it keeps the run's process group. It is not the run's any more.
    const run = spawn('/bin/sh', ['-c', 'sleep 30 & (sleep 30 & echo $!) ; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      const daemon = await new Promise<number>((resolve, reject) => {
        run.stdout!.once('data', (d: Buffer) => resolve(Number.parseInt(d.toString().trim(), 10)));
        run.once('error', reject);
      });
      makeAutomation();
      putSidecar('digest', run.pid as number);
      await new Promise((r) => setTimeout(r, 100));
      expect(pgidOf(daemon)).toBe(run.pid);
      expect(defaultAncestryProbe(daemon)).not.toContain(run.pid);
      const r = proposeFromRun(contextRoot, 'digest', input, { callerPid: daemon });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/own run/);
    } finally {
      try { process.kill(-(run.pid as number), 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('REFUSES when no run is in flight at all', () => {
    makeAutomation();
    const r = proposeFromRun(contextRoot, 'digest', input, { ancestryProbe: () => [5000, RUN_PGID, 1000] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no run/);
  });

  it('FAILS CLOSED when the caller\'s ancestry cannot be determined', () => {
    // "Could not check" must never read as "must be fine" — that would make the
    // guard decorative on any machine where the probe happens to break.
    makeAutomation();
    putSidecar();
    const r = proposeFromRun(contextRoot, 'digest', input, { ancestryProbe: () => null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not verify/i);
    expect(listQuestions(contextRoot, 'digest')).toEqual([]);
  });

  it('refuses a second question while one is still open — the serial gate at the source', () => {
    makeAutomation();
    putSidecar();
    proposeFromRun(contextRoot, 'digest', input, { ancestryProbe: () => [5000, RUN_PGID, 1000] });
    const second = proposeFromRun(contextRoot, 'digest', input, { ancestryProbe: () => [5000, RUN_PGID, 1000] });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/already has a question awaiting an answer/);
  });

  it('writes sessionId null — a run does not know its own conversation id yet', () => {
    // The value only exists in the JSON envelope the runner parses AFTER the
    // child exits, so the runner backfills it via `backfillQuestionSession`.
    // Accepting it as an argument here would make the question's most
    // sensitive field the one nothing verified.
    makeAutomation();
    putSidecar();
    const r = proposeFromRun(contextRoot, 'digest', input, { ancestryProbe: () => [5000, RUN_PGID, 1000] });
    expect(r.ok && r.card.sessionId).toBeNull();
  });
});

// ─── resumeWithAnswer — the question surface ────────────────────────────────
//
// One path for every channel. The HTTP route, the CLI verb and the Telegram
// handler all land here, which is why the kind gate lives INSIDE this function
// rather than in any one of their handlers: the CLI imports this module
// directly and Telegram arrives by a third route, so a gate in the HTTP layer
// would guard one door of three.

describe('resumeWithAnswer — the kind gate', () => {
  it('REFUSES an approval question, spawning nothing', async () => {
    // The whole of R1. `buildResumeArgs` hardcodes bypassPermissions, and an
    // approval question exists precisely because the manifest is unapproved —
    // resuming it would let an unapproved manifest bootstrap its own elevated
    // execution, which is the attack the tripwire exists to prevent.
    makeAutomation();
    const q = makeQuestion({ kind: 'approval' });
    const { impl, calls } = fakeSpawn(claudeJson('done'));
    const outcome = await resumeWithAnswer(contextRoot, q, 'yes', 'dashboard', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('refused');
    expect(outcome.error).toMatch(/approving the manifest, not by resuming/);
    expect(calls).toHaveLength(0);
  });

  it('refuses it even when the caller\'s in-memory copy claims flow-hitl', async () => {
    // Disk is the authority. A stale or forged in-memory object must not be the
    // thing the gate trusts, so the kind is re-checked after the fresh read.
    makeAutomation();
    const q = makeQuestion({ kind: 'approval' });
    const lying = { ...q, kind: 'flow-hitl' as const, sessionId: SESSION };
    const { impl, calls } = fakeSpawn(claudeJson('done'));
    const outcome = await resumeWithAnswer(contextRoot, lying, 'yes', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('answers a flow-hitl question — the kind that IS allowed to resume', async () => {
    makeAutomation();
    const q = makeQuestion();
    const { impl, calls } = fakeSpawn(claudeJson('Sent to 41 subscribers.'));
    const outcome = await resumeWithAnswer(contextRoot, q, 'send', 'dashboard', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('ok');
    expect(outcome.result).toBe('Sent to 41 subscribers.');
    expect(calls[0]).toContain('--resume');
    expect(calls[0]).toContain('bypassPermissions');
  });
});

describe('resumeWithAnswer — the binding is the authority', () => {
  it('refuses a session this machine never recorded', async () => {
    // The synced-cache case: an id lifted from a brain-synced record, or typed
    // into a Telegram message, resolves to nothing here.
    makeAutomation();
    const q = createQuestion(contextRoot, {
      slug: 'digest', runFiredAt: NOW.toISOString(), kind: 'flow-hitl',
      sessionId: SESSION, channel: 'chat', question: 'Send it?', nowISO: NOW.toISOString(),
    });
    const { impl, calls } = fakeSpawn(claudeJson('done'));
    const outcome = await resumeWithAnswer(contextRoot, q, 'send', 'telegram', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('refused');
    expect(outcome.error).toMatch(/not registered on this machine/);
    expect(calls).toHaveLength(0);
  });

  it('refuses when the asking run left no session at all', async () => {
    makeAutomation();
    const q = makeQuestion({ sessionId: null });
    const { impl } = fakeSpawn(claudeJson('done'));
    const outcome = await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('refused');
    expect(outcome.error).toMatch(/no session to reply to/);
  });

  it('refuses an empty answer rather than resuming with nothing to say', async () => {
    makeAutomation();
    const q = makeQuestion();
    const { impl, calls } = fakeSpawn(claudeJson('done'));
    const outcome = await resumeWithAnswer(contextRoot, q, '   ', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('keeps the human\'s spaces and newlines — only NULs are stripped', async () => {
    makeAutomation();
    const q = makeQuestion();
    const { impl, calls } = fakeSpawn(claudeJson('ok'));
    await resumeWithAnswer(contextRoot, q, 'send it\nbut shorten the intro', 'cli', { home, spawnImpl: impl, now: () => NOW });
    const prompt = calls[0][calls[0].indexOf('-p') + 1];
    expect(prompt).toContain('send it\nbut shorten the intro');
  });
});

describe('resumeWithAnswer — ordering and double-answer', () => {
  it('a second surface holding a stale copy is refused, never a second resume', async () => {
    makeAutomation();
    const q = makeQuestion();
    const first = fakeSpawn(claudeJson('done'));
    await resumeWithAnswer(contextRoot, q, 'send', 'dashboard', { home, spawnImpl: first.impl, now: () => NOW });
    const second = fakeSpawn(claudeJson('done'));
    const outcome = await resumeWithAnswer(contextRoot, q, 'send', 'telegram', { home, spawnImpl: second.impl, now: () => NOW });
    expect(outcome.status).toBe('refused');
    expect(second.calls).toHaveLength(0);
  });

  it('reopens the question when the resume never SPAWNED — nothing ran, so the answer is owed a retry', async () => {
    makeAutomation();
    const q = makeQuestion();
    const { impl } = fakeSpawn('', { pid: undefined });
    const outcome = await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('not-spawned');
    expect(outcome.question.state).toBe('pending');
    expect(pendingQuestion(contextRoot, 'digest')!.id).toBe(q.id);
  });

  it('does NOT reopen when the resume spawned and then failed — it may have done half the work', async () => {
    makeAutomation();
    const q = makeQuestion();
    const { impl } = fakeSpawn(JSON.stringify({ session_id: SESSION, result: 'x', is_error: true }));
    const outcome = await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('failed');
    expect(outcome.question.state).toBe('answered');
    expect(outcome.question.resolutionError).toBeTruthy();
    expect(pendingQuestion(contextRoot, 'digest')).toBeNull();
  });

  it('refuses without consuming the answer when the run lock is held', async () => {
    // Resolving something we then cannot act on would burn the answer: the
    // question would read `answered` while nothing ran and nothing could retry.
    makeAutomation();
    const q = makeQuestion();
    const lockPath = lockPathFor(contextRoot, 'digest');
    expect(acquireFileLock(lockPath, NOW.getTime(), 60_000)).toBe(true);
    try {
      const { impl, calls } = fakeSpawn(claudeJson('done'));
      const outcome = await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
      expect(outcome.status).toBe('refused');
      expect(calls).toHaveLength(0);
      expect(pendingQuestion(contextRoot, 'digest')!.state).toBe('pending');
    } finally {
      releaseFileLock(lockPath);
    }
  });

  it('writes a sidecar so the resumed child stays killable', async () => {
    makeAutomation();
    const q = makeQuestion();
    let sidecarDuringResume: ReturnType<typeof readRunSidecar> = null;
    const impl = vi.fn(() => {
      const { child, stdout } = makeFakeChild(999);
      // setImmediate runs AFTER `onSpawned` (which is synchronous), so this
      // observes exactly the window the sidecar exists to cover.
      setImmediate(() => {
        sidecarDuringResume = readRunSidecar(contextRoot, 'digest');
        stdout.emit('data', Buffer.from(claudeJson('ok'), 'utf-8'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnImpl;
    await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(sidecarDuringResume).not.toBeNull();
    expect(sidecarDuringResume!.childPgid).toBe(999);
    // The fire it answers for is the ASKING run's, not the moment a human replied.
    expect(sidecarDuringResume!.fireAt).toBe(NOW.toISOString());
    // Cleared on the way out, so it can never be mistaken for a live orphan.
    expect(readRunSidecar(contextRoot, 'digest')).toBeNull();
  });
});

describe('resumeWithAnswer — capability lifetime', () => {
  it('retires an OLDER binding once its question is settled and no tab was opened', async () => {
    // A resolvable session is a capability. The store is plural so Telegram and
    // tab-restore work, which means retirement has to be explicit or an
    // automation firing daily accumulates ~90 live grants.
    makeAutomation();
    const q = makeQuestion();
    // A later run bound its own session, so this one is no longer the conversation.
    recordAutomationSession('digest', 'sess-newer00', home, NOW.getTime() + 60_000);
    const { impl } = fakeSpawn(claudeJson('done'));
    await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(readAutomationSession('digest', SESSION, home)).toBeNull();
    expect(readAutomationSession('digest', 'sess-newer00', home)).toBe('sess-newer00');
  });

  it('KEEPS the agent\'s LATEST binding, so the thread can still be replied to after the answer', async () => {
    // The owner answered Front Desk's question, then asked "who are the other 7?" and got
    // "has no session to talk to yet": the answer had retired the only session there was.
    makeAutomation();
    const q = makeQuestion();
    const { impl } = fakeSpawn(claudeJson('done'));
    await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(readAutomationSession('digest', SESSION, home)).toBe(SESSION);
    expect(latestBoundSession('digest', home)).toBe(SESSION);
  });

  it('KEEPS the binding when the user opened it as a chat tab', async () => {
    // Its lifetime hands off to the roster — machine-local, user-visible, and
    // already what tab restore reads — rather than being revoked under them.
    makeAutomation();
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(
      join(contextRoot, 'state', '.agent-sessions.json'),
      JSON.stringify([{ title: 'Digest · run #1', bypass: true, minimized: false, size: 1, sessionId: SESSION }]),
      'utf-8',
    );
    const q = makeQuestion();
    const { impl } = fakeSpawn(claudeJson('done'));
    await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(readAutomationSession('digest', SESSION, home)).toBe(SESSION);
  });

  it('KEEPS the binding while another question for the same automation is still open', async () => {
    makeAutomation();
    const q = makeQuestion();
    makeQuestion({ nowISO: '2026-08-03T19:00:00.000Z' });
    const { impl } = fakeSpawn(claudeJson('done'));
    await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(readAutomationSession('digest', SESSION, home)).toBe(SESSION);
  });

  it('KEEPS the binding when the resume never spawned — the question is pending again', async () => {
    makeAutomation();
    const q = makeQuestion();
    const { impl } = fakeSpawn('', { pid: undefined });
    await resumeWithAnswer(contextRoot, q, 'send', 'cli', { home, spawnImpl: impl, now: () => NOW });
    expect(readAutomationSession('digest', SESSION, home)).toBe(SESSION);
  });
});

// ─── Talking to the latest run ───────────────────────────────────────────────

describe('resumeWithMessage — talking to the latest run', () => {
  it('resumes the LATEST bound session with the message and returns the reply', async () => {
    makeAutomation({ review: 'off' });
    recordAutomationSession('digest', 'sess-older00', home, NOW.getTime() - 60_000);
    recordAutomationSession('digest', SESSION, home, NOW.getTime());
    const { impl, calls } = fakeSpawn(claudeJson('Here is the summary you asked for.'));
    const outcome = await resumeWithMessage(contextRoot, 'digest', 'summarize it?', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('ok');
    expect(outcome.result).toBe('Here is the summary you asked for.');
    const args = calls[0];
    expect(args[args.indexOf('--resume') + 1]).toBe(SESSION); // newest binding, not the older one
    expect(args[args.indexOf('-p') + 1]).toContain('summarize it?');
    expect(args).toContain('bypassPermissions');
  });

  it('refuses when no run on this machine ever bound a session — and never spawns', async () => {
    // The machine-local binding is the authority: a synced cache full of other
    // machines' session ids must not make this machine resume anything.
    makeAutomation();
    const { impl } = fakeSpawn(claudeJson('x'));
    const outcome = await resumeWithMessage(contextRoot, 'digest', 'hello', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('refused');
    expect(outcome.error).toContain('no session to talk to yet');
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses while a question is pending — the answer path owns that conversation', async () => {
    makeAutomation();
    makeQuestion();
    const { impl } = fakeSpawn(claudeJson('x'));
    const outcome = await resumeWithMessage(contextRoot, 'digest', 'hello', { home, spawnImpl: impl, now: () => NOW });
    expect(outcome.status).toBe('refused');
    expect(outcome.error).toContain('waiting for your answer');
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses while the run lock is held — never two claude children on one automation', async () => {
    makeAutomation();
    recordAutomationSession('digest', SESSION, home, NOW.getTime());
    const lockPath = lockPathFor(contextRoot, 'digest');
    expect(acquireFileLock(lockPath, NOW.getTime(), 999_999)).toBe(true);
    const { impl } = fakeSpawn(claudeJson('x'));
    const outcome = await resumeWithMessage(contextRoot, 'digest', 'hello', { home, spawnImpl: impl, now: () => NOW });
    releaseFileLock(lockPath);
    expect(outcome.status).toBe('refused');
    expect(impl).not.toHaveBeenCalled();
  });
  it('WAITS for the lock when told to, and delivers the moment the turn ahead of it ends', async () => {
    // The owner's follow-up, typed seconds after answering a question: the answer's resume
    // holds the lock, and the follow-up used to fail in 0s with "still in progress".
    makeAutomation();
    recordAutomationSession('digest', SESSION, home, NOW.getTime());
    const lockPath = lockPathFor(contextRoot, 'digest');
    expect(acquireFileLock(lockPath, NOW.getTime(), 999_999)).toBe(true);
    let polls = 0;
    const sleep = async () => { polls += 1; if (polls === 3) releaseFileLock(lockPath); };
    const { impl, calls } = fakeSpawn(claudeJson('Checked: five answered.'));
    const outcome = await resumeWithMessage(contextRoot, 'digest', 'did you check?', {
      home, spawnImpl: impl, now: () => NOW, lockWaitMs: 60_000, lockPollMs: 1_000, sleep,
    });
    expect(polls).toBe(3);
    expect(outcome.status).toBe('ok');
    expect(outcome.result).toBe('Checked: five answered.');
    expect(calls).toHaveLength(1);
  });

  it('gives up with the lock reason once the wait is spent, and never spawns', async () => {
    makeAutomation();
    recordAutomationSession('digest', SESSION, home, NOW.getTime());
    const lockPath = lockPathFor(contextRoot, 'digest');
    expect(acquireFileLock(lockPath, NOW.getTime(), 999_999)).toBe(true);
    let polls = 0;
    const { impl } = fakeSpawn(claudeJson('x'));
    const outcome = await resumeWithMessage(contextRoot, 'digest', 'hello', {
      home, spawnImpl: impl, now: () => NOW, lockWaitMs: 3_000, lockPollMs: 1_000, sleep: async () => { polls += 1; },
    });
    releaseFileLock(lockPath);
    expect(polls).toBe(3);
    expect(outcome.status).toBe('refused');
    expect(outcome.error).toContain('still in progress');
    expect(impl).not.toHaveBeenCalled();
  });

  it('a queued message resumes the session bound WHILE it waited, not the one it saw first', async () => {
    makeAutomation();
    recordAutomationSession('digest', 'sess-older00', home, NOW.getTime() - 60_000);
    const lockPath = lockPathFor(contextRoot, 'digest');
    expect(acquireFileLock(lockPath, NOW.getTime(), 999_999)).toBe(true);
    const sleep = async () => {
      // The run ahead finishes: it binds its own session and lets go of the lock.
      recordAutomationSession('digest', SESSION, home, NOW.getTime());
      releaseFileLock(lockPath);
    };
    const { impl, calls } = fakeSpawn(claudeJson('ok'));
    await resumeWithMessage(contextRoot, 'digest', 'and now?', {
      home, spawnImpl: impl, now: () => NOW, lockWaitMs: 10_000, lockPollMs: 1_000, sleep,
    });
    const args = calls[0];
    expect(args[args.indexOf('--resume') + 1]).toBe(SESSION);
  });
});
