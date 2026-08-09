/**
 * The verdict engine — propose guard, resume preambles, and the two paths a
 * human's answer can take.
 *
 * What is actually under test, in order of how badly it fails:
 *   1. the PROPOSE GUARD — a card's approval resumes the session the card
 *      names, so a card anyone can plant is an arbitrary bypassPermissions
 *      conversation waiting for the operator's tap;
 *   2. VERDICT-BEFORE-SPAWN, and the single exception where a resolved card is
 *      put back (nothing spawned ⇒ provably nothing happened);
 *   3. a STEER leaves the card pending and never emits the human's words;
 *   4. learning fires at steer time and is VERIFIED, not assumed.
 *
 * `claude` is never really spawned: every test injects a fake child, so no test
 * in this file can cost a token or reach the network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  applySteer,
  buildApprovePreamble,
  buildDiscardPreamble,
  buildDropPreamble,
  buildSteerPreamble,
  proposeFromRun,
  resumeWithVerdict,
} from '../../src/lib/automations/verdict.js';
import {
  createReviewCard,
  listReviewCards,
  pendingReviewCard,
  readReviewCard,
  reviewCardPath,
  writeReviewCard,
} from '../../src/lib/automations/review.js';
import {
  createAutomation,
  getAutomation,
  lockPathFor,
  readPattern,
  readRunSidecar,
  recordLesson,
  writeRunSidecar,
} from '../../src/lib/automations/store.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { readCardSession, recordCardSession } from '../../src/lib/automations/card-registry.js';
import type { SpawnImpl } from '../../src/lib/automations/runner.js';
import type { AutomationManifest, ReviewCard } from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = new Date('2026-08-03T18:00:00.000Z');
const SESSION = 'sess-abc123';
const RUN_PGID = 4242;

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

/** Creates the card AND the machine-local binding the runner would have
 *  recorded — a card without one is, by design, unresumable. */
function makeCard(overrides: Partial<Parameters<typeof createReviewCard>[1]> = {}): ReviewCard {
  const card = createReviewCard(contextRoot, {
    slug: 'digest',
    runFiredAt: NOW.toISOString(),
    sessionId: SESSION,
    kind: 'agent',
    title: 'Publish the digest',
    body: 'Four commits landed today.',
    nowISO: NOW.toISOString(),
    ...overrides,
  });
  if (card.sessionId) recordCardSession(card.id, card.slug, card.sessionId, home);
  return card;
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

describe('propose is guarded by the run process group', () => {
  const input = { title: 'Publish this', body: 'the proposal' };

  it('accepts a call from inside the run own process group', () => {
    makeAutomation();
    putSidecar();
    const r = proposeFromRun(contextRoot, 'digest', input, { pgidProbe: () => RUN_PGID });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.state).toBe('pending');
      expect(r.card.runFiredAt).toBe(NOW.toISOString());
    }
  });

  it('REFUSES a caller in a different process group — a human shell, another run', () => {
    // The load-bearing case. A planted card is a request to resume an arbitrary
    // conversation with bypassPermissions on the operator's tap.
    makeAutomation();
    putSidecar();
    const r = proposeFromRun(contextRoot, 'digest', input, { pgidProbe: () => 777 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/own run/);
    expect(listReviewCards(contextRoot, 'digest')).toEqual([]);
  });

  it('REFUSES when no run is in flight at all', () => {
    makeAutomation();
    const r = proposeFromRun(contextRoot, 'digest', input, { pgidProbe: () => RUN_PGID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no run/);
  });

  it('FAILS CLOSED when the process group cannot be determined', () => {
    // "Could not check" must never read as "must be fine" — that would make the
    // guard decorative on any machine where the probe happens to break.
    makeAutomation();
    putSidecar();
    const r = proposeFromRun(contextRoot, 'digest', input, { pgidProbe: () => null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not verify/i);
    expect(listReviewCards(contextRoot, 'digest')).toEqual([]);
  });

  it('refuses a second card while one is still open — the serial gate at the source', () => {
    makeAutomation();
    putSidecar();
    proposeFromRun(contextRoot, 'digest', input, { pgidProbe: () => RUN_PGID });
    const second = proposeFromRun(contextRoot, 'digest', input, { pgidProbe: () => RUN_PGID });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/awaiting review/);
  });

  it('writes sessionId null — a run does not know its own conversation id yet', () => {
    // The value only exists in the JSON envelope the runner parses AFTER the
    // child exits, so the runner backfills it. Accepting it as an argument here
    // would make the card's most sensitive field the one nothing verified.
    makeAutomation();
    putSidecar();
    const r = proposeFromRun(contextRoot, 'digest', input, { pgidProbe: () => RUN_PGID });
    expect(r.ok && r.card.sessionId).toBeNull();
  });
});

// ─── The preambles ───────────────────────────────────────────────────────────

describe('the resume preambles say exactly one thing each', () => {
  it('approve tells the agent to carry it out and not re-propose', () => {
    const p = buildApprovePreamble(makeCardStub('Publish the digest'));
    expect(p).toMatch(/VERDICT: APPROVED/);
    expect(p).toMatch(/Carry it out now/);
    expect(p).toMatch(/Do not re-propose/i);
  });

  it('discard tells it to stop, and not to do a smaller version', () => {
    const p = buildDiscardPreamble(makeCardStub('Publish the digest'));
    expect(p).toMatch(/VERDICT: REJECTED/);
    expect(p).toMatch(/Do NOT carry it out/);
    expect(p).toMatch(/smaller version/);
  });

  it('drop asks for a lesson about the CLASS, not this instance', () => {
    contextRoot = mkdtempSync(join(tmpdir(), 'dc-preamble-'));
    mkdirSync(contextRoot, { recursive: true });
    const m = { ...stubManifest(), learning: true };
    const p = buildDropPreamble(makeCardStub('Publish the digest'), m);
    expect(p).toMatch(/PERMANENTLY/);
    expect(p).toMatch(/automations learn digest --lesson/);
    expect(p).toMatch(/CLASS of proposal/);
  });

  it('drop says plainly that nothing durable can be recorded when learning is off', () => {
    const p = buildDropPreamble(makeCardStub('x'), { ...stubManifest(), learning: false });
    expect(p).not.toMatch(/automations learn/);
    expect(p).toMatch(/learning off/);
  });

  it('steer fences the human words and forbids emitting them', () => {
    // The 2026-07-12 Tilki incident, encoded: the correction is an instruction
    // to revise, never content to send.
    const p = buildSteerPreamble(makeCardStub('x'), { ...stubManifest(), learning: true }, 'drop the emoji');
    expect(p).toMatch(/VERDICT: NOT YET/);
    expect(p).toMatch(/--- THE HUMAN'S CORRECTION \(verbatim\) ---/);
    expect(p).toContain('drop the emoji');
    expect(p).toMatch(/never content to emit/);
    expect(p).toMatch(/Nothing has been approved/);
  });

  it('steer asks for the GENERAL rule, so a correction is not a one-off', () => {
    const p = buildSteerPreamble(makeCardStub('x'), { ...stubManifest(), learning: true }, 'shorter');
    expect(p).toMatch(/not a one-off/);
    expect(p).toMatch(/automations learn digest --lesson/);
  });

  it('steer says nothing about learning when the automation has it off', () => {
    const p = buildSteerPreamble(makeCardStub('x'), { ...stubManifest(), learning: false }, 'shorter');
    expect(p).not.toMatch(/automations learn/);
  });
});

function makeCardStub(title: string): ReviewCard {
  return {
    id: 'rev_1', slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: SESSION, kind: 'agent',
    title, summary: '', body: 'b', stagedPath: null, state: 'pending', steers: [],
    createdAt: NOW.toISOString(), resolvedAt: null, resolvedVia: null,
    resolutionNote: null, resolutionError: null, channelRefs: {},
  };
}
function stubManifest(): AutomationManifest {
  return {
    slug: 'digest', id: 'auto_1', title: 'Daily digest', enabled: true, schedule: null, model: null,
    effort: null, timeoutMinutes: 15, catchupHours: 6, outputDir: null, shared: false, notify: true,
    learning: true, review: 'agent', prompt: 'p', outputInstructions: '', pattern: '', path: '/x', body: '',
  };
}

// ─── Verdicts ────────────────────────────────────────────────────────────────

describe('resumeWithVerdict', () => {
  it('resolves the card BEFORE it spawns — a crash in that window cannot replay the act', async () => {
    makeAutomation();
    const card = makeCard();
    let stateAtSpawn: string | null = null;
    const impl = vi.fn((_cmd: string, _args: string[]) => {
      // read the card off DISK at the moment of spawn
      stateAtSpawn = readReviewCard(reviewCardPath(contextRoot, 'digest', card.id))?.state ?? null;
      const { child, stdout } = makeFakeChild(999);
      setImmediate(() => {
        stdout.emit('data', Buffer.from(claudeJson('did it'), 'utf-8'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnImpl;

    await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(stateAtSpawn).toBe('approved');
  });

  it('resumes the card own session, with the manifest own model and effort', async () => {
    makeAutomation({ slug: 'digest', model: 'claude-opus-5', effort: 'high' });
    const card = makeCard();
    const { impl, calls } = fakeSpawn(claudeJson('done'));
    await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    const args = calls[0];
    expect(args.slice(0, 2)).toEqual(['--resume', SESSION]);
    expect(args).toContain('bypassPermissions');
    // a verdict must not quietly grant a bigger envelope than the hash covers
    expect(args).toContain('claude-opus-5');
    expect(args).toContain('high');
  });

  it('records what the agent said, so a resolved card can answer "what happened?"', async () => {
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn(claudeJson('Wrote the digest to output/2026-08-03.md.'));
    const out = await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.status).toBe('ok');
    expect(out.card.resolutionNote).toMatch(/Wrote the digest/);
    expect(out.card.resolutionError).toBeNull();
    expect(pendingReviewCard(contextRoot, 'digest')).toBeNull();
  });

  it.each(['discard', 'drop'] as const)('%s resolves without carrying anything out', async (verdict) => {
    makeAutomation();
    const card = makeCard();
    const { impl, calls } = fakeSpawn(claudeJson('understood'));
    const out = await resumeWithVerdict(contextRoot, card, verdict, 'telegram', { spawnImpl: impl, now: () => NOW, home });
    expect(out.status).toBe('ok');
    expect(out.card.state).toBe(verdict === 'discard' ? 'discarded' : 'dropped');
    expect(out.card.resolvedVia).toBe('telegram');
    expect(calls[0].join(' ')).toMatch(/REJECTED/);
  });

  it('REOPENS the card when nothing spawned — the human tap is owed a retry', async () => {
    // The one exception to verdict-before-spawn. `pid == null` means the exec
    // itself failed, so provably nothing was carried out.
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn('', { pid: undefined });
    const out = await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.status).toBe('not-spawned');
    expect(out.card.state).toBe('pending');
    expect(out.card.resolutionError).toMatch(/not carried out/);
    expect(pendingReviewCard(contextRoot, 'digest')?.id).toBe(card.id);
  });

  it('does NOT reopen when the resume STARTED and then failed — it may have half-acted', async () => {
    // The distinction that keeps a re-approval from acting twice.
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn(JSON.stringify({ result: 'partial', is_error: true, session_id: SESSION }));
    const out = await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.status).toBe('failed');
    expect(out.card.state).toBe('approved');
    expect(out.card.resolutionError).toBeTruthy();
    expect(pendingReviewCard(contextRoot, 'digest')).toBeNull();
  });

  it('a failure is never mistaken for a clean success', async () => {
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn('not json at all');
    const out = await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.card.resolutionError).toMatch(/unparseable/);
    expect(out.card.resolutionNote).toBeNull();
  });

  it('refuses to approve a card with no resumable session — but lets it be discarded', async () => {
    makeAutomation();
    const orphan = makeCard({ sessionId: null });
    const { impl } = fakeSpawn(claudeJson('x'));

    const approve = await resumeWithVerdict(contextRoot, orphan, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(approve.status).toBe('refused');
    expect(approve.card.state).toBe('pending');

    const discard = await resumeWithVerdict(contextRoot, orphan, 'discard', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(discard.status).toBe('ok');
    expect(discard.card.state).toBe('discarded');
    expect(discard.card.resolutionNote).toMatch(/without resuming/);
    // nothing was spawned for a card there is nobody to reply to
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses a card that was already answered', async () => {
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn(claudeJson('ok'));
    await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    const again = await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(again.status).toBe('refused');
    expect(again.error).toMatch(/already/);
  });
});

// ─── A planted card is inert ─────────────────────────────────────────────────

describe('the session a verdict resumes comes from MACHINE-LOCAL state, not the card', () => {
  it('REFUSES to approve a card this machine never registered', async () => {
    // THE ATTACK: a card is a file in the PROJECT directory, so anything able to
    // write there could drop one naming an arbitrary session and wait for a
    // human to tap approve — the approval tripwire defeated through a door it
    // does not watch, and at a lower bar than the home-directory write the
    // security model already concedes.
    makeAutomation();
    const planted = createReviewCard(contextRoot, {
      slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: 'sess-attacker',
      kind: 'agent', title: 'Looks legitimate', body: 'do something useful',
      nowISO: NOW.toISOString(),
    });
    const { impl } = fakeSpawn(claudeJson('done'));

    const out = await resumeWithVerdict(contextRoot, planted, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });

    expect(out.status).toBe('refused');
    expect(out.error).toMatch(/not registered on this machine/);
    expect(impl).not.toHaveBeenCalled();
    expect(pendingReviewCard(contextRoot, 'digest')?.id).toBe(planted.id);
  });

  it('REFUSES to steer a planted card', async () => {
    makeAutomation();
    const planted = createReviewCard(contextRoot, {
      slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: 'sess-attacker',
      kind: 'agent', title: 'x', body: 'y', nowISO: NOW.toISOString(),
    });
    const { impl } = fakeSpawn(claudeJson('revised'));
    const out = await applySteer(contextRoot, planted, 'change it', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.status).toBe('refused');
    expect(impl).not.toHaveBeenCalled();
  });

  it('a planted card can still be DISCARDED — you must be able to throw away what you did not expect', async () => {
    makeAutomation();
    const planted = createReviewCard(contextRoot, {
      slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: 'sess-attacker',
      kind: 'agent', title: 'x', body: 'y', nowISO: NOW.toISOString(),
    });
    const { impl } = fakeSpawn(claudeJson('ok'));
    const out = await resumeWithVerdict(contextRoot, planted, 'discard', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.status).toBe('ok');
    expect(out.card.state).toBe('discarded');
    expect(impl).not.toHaveBeenCalled();
  });

  it('REFUSES when the card file was edited to name a DIFFERENT session than the binding', async () => {
    // Tampering after the fact: the binding says one thing, the file another.
    // Refuse rather than silently preferring either.
    makeAutomation();
    const card = makeCard();
    writeReviewCard(contextRoot, { ...card, sessionId: 'sess-swapped' });
    const { impl } = fakeSpawn(claudeJson('done'));
    const out = await resumeWithVerdict(
      contextRoot,
      { ...card, sessionId: 'sess-swapped' },
      'approve', 'cli',
      { spawnImpl: impl, now: () => NOW, home },
    );
    expect(out.status).toBe('refused');
    expect(impl).not.toHaveBeenCalled();
  });

  it('resumes the BOUND session, and retires the binding once the card is answered', async () => {
    makeAutomation();
    const card = makeCard();
    expect(readCardSession(card.id, 'digest', home)).toBe(SESSION);

    const { impl, calls } = fakeSpawn(claudeJson('done'));
    await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });

    expect(calls[0].slice(0, 2)).toEqual(['--resume', SESSION]);
    // a resolvable session should not outlive the decision it existed for
    expect(readCardSession(card.id, 'digest', home)).toBeNull();
  });

  it('a binding cannot be borrowed by moving a card under another automation', async () => {
    makeAutomation();
    makeAutomation({ slug: 'other' });
    const card = makeCard();
    // same card id, different slug — the binding records both
    expect(readCardSession(card.id, 'other', home)).toBeNull();
  });
});

// ─── The resume runs under the same guards a scheduled run does ─────────────

describe('a resume is trackable and does not run alongside another claude', () => {
  it('writes a RUN SIDECAR while the resume is in flight, so `automations kill` can find it', async () => {
    // Without this, a detached resume child whose parent dies is an orphan with
    // no record anywhere — unkillable by the documented path.
    makeAutomation();
    const card = makeCard();
    let sidecarDuringRun: ReturnType<typeof readRunSidecar> = null;
    const impl = vi.fn(() => {
      const { child, stdout } = makeFakeChild(999);
      // setImmediate runs AFTER `onSpawned` (which is synchronous), so this
      // observes exactly the window the sidecar exists to cover.
      setImmediate(() => {
        sidecarDuringRun = readRunSidecar(contextRoot, 'digest');
        stdout.emit('data', Buffer.from(claudeJson('done'), 'utf-8'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnImpl;

    await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });

    expect(sidecarDuringRun).not.toBeNull();
    expect(sidecarDuringRun!.slug).toBe('digest');
    expect(sidecarDuringRun!.childPgid).toBe(999);
    expect(sidecarDuringRun!.runnerPid).toBe(process.pid);
    // and the fire it answers for is the CARD's run, not the moment of the tap
    expect(sidecarDuringRun!.fireAt).toBe(card.runFiredAt);
  });

  it('clears the sidecar and releases the lock when the resume finishes', async () => {
    makeAutomation();
    const { impl } = fakeSpawn(claudeJson('done'));
    await resumeWithVerdict(contextRoot, makeCard(), 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(readRunSidecar(contextRoot, 'digest')).toBeNull();
    expect(existsSync(lockPathFor(contextRoot, 'digest'))).toBe(false);
  });

  it('releases the lock even when the resume FAILS', async () => {
    makeAutomation();
    const { impl } = fakeSpawn('not json at all');
    await resumeWithVerdict(contextRoot, makeCard(), 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(existsSync(lockPathFor(contextRoot, 'digest'))).toBe(false);
  });

  it('REFUSES without spending the verdict when a run holds the lock', async () => {
    // The ordering that matters: a card must not be resolved if the resume
    // cannot happen, or the human's tap is burnt on a card that reads
    // `approved` while nothing ran.
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn(claudeJson('done'));
    acquireFileLock(lockPathFor(contextRoot, 'digest'), Date.now(), 60_000);

    const out = await resumeWithVerdict(contextRoot, card, 'approve', 'cli', { spawnImpl: impl, now: () => NOW, home });

    expect(out.status).toBe('refused');
    expect(out.error).toMatch(/still in progress/);
    expect(impl).not.toHaveBeenCalled();
    expect(pendingReviewCard(contextRoot, 'digest')?.id).toBe(card.id);
    releaseFileLock(lockPathFor(contextRoot, 'digest'));
  });

  it('a STEER under a held lock leaves the card completely unchanged', async () => {
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn(claudeJson('revised'));
    acquireFileLock(lockPathFor(contextRoot, 'digest'), Date.now(), 60_000);

    const out = await applySteer(contextRoot, card, 'shorter', 'cli', { spawnImpl: impl, now: () => NOW, home });

    expect(out.status).toBe('refused');
    expect(impl).not.toHaveBeenCalled();
    const onDisk = readReviewCard(reviewCardPath(contextRoot, 'digest', card.id))!;
    expect(onDisk.body).toBe('Four commits landed today.');
    expect(onDisk.steers).toEqual([]);
    releaseFileLock(lockPathFor(contextRoot, 'digest'));
  });

  it('a steer writes and clears its sidecar too', async () => {
    makeAutomation();
    let seen: ReturnType<typeof readRunSidecar> = null;
    const impl = vi.fn(() => {
      const { child, stdout } = makeFakeChild(777);
      setImmediate(() => {
        seen = readRunSidecar(contextRoot, 'digest');
        stdout.emit('data', Buffer.from(claudeJson('revised'), 'utf-8'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnImpl;

    await applySteer(contextRoot, makeCard(), 'shorter', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(seen).not.toBeNull();
    expect(readRunSidecar(contextRoot, 'digest')).toBeNull();
    expect(existsSync(lockPathFor(contextRoot, 'digest'))).toBe(false);
  });
});

// ─── Steering ────────────────────────────────────────────────────────────────

describe('applySteer', () => {
  it('rewrites the body in place and leaves the card PENDING', async () => {
    // A steer revises, it never ships. If this flips, a correction meant for
    // the agent becomes the thing that goes out.
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn(claudeJson('Four commits. No emoji.'));
    const out = await applySteer(contextRoot, card, 'drop the emoji', 'telegram', { spawnImpl: impl, now: () => NOW, home });
    expect(out.status).toBe('ok');
    expect(out.card.state).toBe('pending');
    expect(out.card.body).toBe('Four commits. No emoji.');
    expect(pendingReviewCard(contextRoot, 'digest')?.body).toBe('Four commits. No emoji.');
  });

  it('never writes the human words into the proposal', async () => {
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn(claudeJson('A revised proposal.'));
    const out = await applySteer(contextRoot, card, 'MAKE IT SHOUT', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.card.body).not.toContain('MAKE IT SHOUT');
    expect(out.card.steers.at(-1)?.text).toBe('MAKE IT SHOUT');
  });

  it('records the trail with the lesson attached', async () => {
    makeAutomation({ learning: true });
    const card = makeCard();
    const { impl } = fakeSpawn(claudeJson('revised'));
    const out = await applySteer(contextRoot, card, 'no emoji ever', 'dashboard', { spawnImpl: impl, now: () => NOW, home });
    expect(out.card.steers).toHaveLength(1);
    expect(out.card.steers[0].via).toBe('dashboard');
    expect(out.lesson).toBeTruthy();
  });

  it('takes the agent DISTILLED lesson when it recorded one', async () => {
    makeAutomation({ learning: true });
    const card = makeCard();
    // the fake "agent" records a lesson mid-resume, exactly as the preamble asks
    const impl = vi.fn(() => {
      recordLesson(contextRoot, 'digest', { lesson: 'Never use emoji in any digest.' });
      const { child, stdout } = makeFakeChild(999);
      setImmediate(() => {
        stdout.emit('data', Buffer.from(claudeJson('revised'), 'utf-8'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnImpl;
    const out = await applySteer(contextRoot, card, 'drop the emoji', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.lesson).toBe('Never use emoji in any digest.');
  });

  it('falls back to the human OWN WORDS when the agent recorded nothing', async () => {
    // Verified, not assumed. A correction that silently taught nothing is the
    // exact failure Tilki shipped first and had to fix.
    makeAutomation({ learning: true });
    const card = makeCard();
    const { impl } = fakeSpawn(claudeJson('revised'));
    const out = await applySteer(contextRoot, card, 'always cite the commit sha', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.lesson).toBe('always cite the commit sha');
    const pattern = readPattern(getAutomation(contextRoot, 'digest') as AutomationManifest);
    expect(pattern.lessons[0].text).toBe('always cite the commit sha');
  });

  it('records NO lesson when learning is off — a pattern nothing reads is not learning', async () => {
    makeAutomation({ learning: false });
    const card = makeCard();
    const { impl } = fakeSpawn(claudeJson('revised'));
    const out = await applySteer(contextRoot, card, 'be shorter', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.status).toBe('ok');
    expect(out.lesson).toBeNull();
    expect(out.card.steers[0].lesson).toBeNull();
    expect(readPattern(getAutomation(contextRoot, 'digest') as AutomationManifest).lessons).toEqual([]);
  });

  it('follows the conversation when the resume hands back a new session id', async () => {
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn(claudeJson('revised', { session_id: 'sess-forked' }));
    const out = await applySteer(contextRoot, card, 'again', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(out.card.sessionId).toBe('sess-forked');
    expect(readReviewCard(reviewCardPath(contextRoot, 'digest', card.id))?.sessionId).toBe('sess-forked');
  });

  it.each([
    ['spawn failure', '', { pid: undefined as number | undefined }],
    ['unparseable output', 'garbage', {}],
    ['an empty rewrite', JSON.stringify({ result: '   ', session_id: SESSION }), {}],
  ])('leaves the card completely unchanged on %s', async (_label, out, spawnOpts) => {
    makeAutomation();
    const card = makeCard();
    const { impl } = fakeSpawn(out, spawnOpts);
    const res = await applySteer(contextRoot, card, 'change it', 'cli', { spawnImpl: impl, now: () => NOW, home });
    expect(res.status).not.toBe('ok');
    const onDisk = readReviewCard(reviewCardPath(contextRoot, 'digest', card.id)) as ReviewCard;
    expect(onDisk.state).toBe('pending');
    expect(onDisk.body).toBe('Four commits landed today.');
    expect(onDisk.steers).toEqual([]);
  });

  it('refuses an empty correction, and a card with nobody to correct', async () => {
    makeAutomation();
    const { impl } = fakeSpawn(claudeJson('x'));
    expect((await applySteer(contextRoot, makeCard(), '   ', 'cli', { spawnImpl: impl, home })).status).toBe('refused');
    const orphan = makeCard({ sessionId: null });
    const res = await applySteer(contextRoot, orphan, 'fix it', 'cli', { spawnImpl: impl, home });
    expect(res.status).toBe('refused');
    expect(res.error).toMatch(/nobody to give the correction to/);
  });
});
