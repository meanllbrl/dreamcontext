/**
 * Wave 3 (originally) / T12 (repointed) — where an automation's behaviour
 * actually changes, and only for `review != off`.
 *
 * Five things are under test:
 *   1. THE SERIAL GATE — a slug with an unanswered question does not run again,
 *      and does not advance its watermark, so the fire is owed rather than lost;
 *   2. `review: off` behaves BYTE-FOR-BYTE as before (the whole opt-in promise);
 *   3. `review: output` stops the run BEFORE it publishes and hands the human a
 *      question holding the document, so the notification, sleep's consumption
 *      and autoSync's push all sit behind one answer;
 *   4. the session id gets backfilled, because a question that never learns one
 *      is a proposal nobody can answer;
 *   5. S7 — the runner strips the stale `automations/review/` gitignore line a
 *      pre-T12 project would still carry, while `automations/hitl/` stays covered.
 *
 * T12 migrated this file off the review-card store (`review.ts`, deleted) onto
 * the question store (`hitl.ts`): `createReviewCard`/`pendingReviewCard`/
 * `resolveReviewCard` become `createQuestion`/`pendingQuestion`/`resolveQuestion`,
 * and `runner.ts`'s `review: 'output'` branch now asks a `kind: 'flow-hitl'`
 * question — carrying the document AS the question text, since there is no more
 * staged file to hold it — instead of creating a `kind: 'output'` card.
 *
 * DELIBERATELY NOT re-tested here (behaviour that no longer exists, not
 * softened in place): the old suite's "Publishing on approve" block proved that
 * approving a staged `review: output` card MOVED the staged file into the
 * output directory with NO conversation resumed — a mechanical file move, not
 * an agent action. That mechanism is gone: `resumeWithAnswer` (which answers
 * every question, including this one now) always resumes the asking session
 * with the human's answer text: there is no more staged file for anything to
 * move, because nothing is staged to disk any more. Publishing is therefore
 * left to the resumed agent's own judgement rather than a guaranteed runner-side
 * move — see `automations-verdict.test.ts` for what `resumeWithAnswer` itself
 * still guarantees (kind gate, binding authority, verdict-before-spawn).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { createAutomation, outputDirFor, readAutomationCache } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { createQuestion, listQuestions, pendingQuestion, resolveQuestion } from '../../src/lib/automations/hitl.js';
import { buildAutomationsSnapshot } from '../../src/lib/automations/snapshot.js';
import type { AutomationManifest, ReviewMode } from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = new Date('2026-08-03T18:00:00.000Z');
const SESSION = 'sess-run-1';

function fakeSpawn(stdoutJson: string) {
  const calls: string[][] = [];
  const impl = vi.fn((_cmd: string, args: string[]) => {
    calls.push(args);
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 4321, stdout, stderr, kill: () => {} });
    setImmediate(() => {
      stdout.emit('data', Buffer.from(stdoutJson, 'utf-8'));
      child.emit('close', 0);
    });
    return child;
  }) as unknown as SpawnImpl;
  return { impl, calls };
}

const DOCUMENT = 'Four commits landed today.\n\n# Digest\n\nDetails here.\n';
const OK_JSON = JSON.stringify({
  session_id: SESSION,
  result: DOCUMENT,
  is_error: false,
  permission_denials: [],
});

/** A pending `flow-hitl` question, exactly the shape `runner.ts` writes on both
 *  the `review: agent`-propose path and the `review: output` path. */
function openQuestion(
  slug: string,
  overrides: Partial<Parameters<typeof createQuestion>[1]> = {},
): ReturnType<typeof createQuestion> {
  return createQuestion(contextRoot, {
    slug,
    runFiredAt: NOW.toISOString(),
    kind: 'flow-hitl',
    sessionId: SESSION,
    channel: 'chat',
    question: 'Publish this?',
    choices: [],
    nowISO: NOW.toISOString(),
    ...overrides,
  });
}

function makeApproved(slug: string, review: ReviewMode): AutomationManifest {
  const m = createAutomation(contextRoot, {
    slug,
    title: `Test — ${slug}`,
    days: 'daily',
    at: '18:00',
    prompt: 'Write the digest.',
    review,
  });
  approveAutomation(projectRoot, m, NOW, home);
  return m;
}

/** Every run in this file injects both spawn and notify, so nothing here can
 *  reach a real claude, a real notification, or the developer's own home. */
function run(slug: string, impl: SpawnImpl, opts: Record<string, unknown> = {}) {
  return runAutomation(contextRoot, slug, {
    spawnImpl: impl,
    now: () => NOW,
    fireAt: NOW,
    home,
    notify: () => {},
    force: true,
    ...opts,
  });
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-review-gate-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-review-gate-home-'));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ─── 1. The serial gate ──────────────────────────────────────────────────────

describe('the serial gate: an unanswered question holds the automation', () => {
  it('REFUSES to spawn while a question is open', async () => {
    const m = makeApproved('digest', 'agent');
    openQuestion('digest');
    const { impl } = fakeSpawn(OK_JSON);

    const outcome = await run(m.slug, impl);
    expect(outcome.status).toBe('awaiting-review');
    expect(impl).not.toHaveBeenCalled();
    expect(outcome.error).toMatch(/waiting for your answer/);
  });

  it('does NOT advance the watermark — the fire is owed, not lost', async () => {
    // The difference between "you were away, so nothing ran" and "you were
    // away, so the run was silently skipped forever".
    const m = makeApproved('digest', 'agent');
    openQuestion('digest');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    expect(readAutomationCache(contextRoot, 'digest')?.lastFireAt).toBeNull();
  });

  it('runs again as soon as the question is answered', async () => {
    const m = makeApproved('digest', 'agent');
    const q = openQuestion('digest');
    const { impl } = fakeSpawn(OK_JSON);

    expect((await run(m.slug, impl)).status).toBe('awaiting-review');
    resolveQuestion(contextRoot, q, 'not now', 'cli', NOW.toISOString());
    expect((await run(m.slug, impl)).status).toBe('ok');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('an APPROVAL problem still wins over the review gate', async () => {
    // Ordering: `blocked` is a fault and is the more urgent, more actionable
    // thing to report. An open question on an unapproved automation must not
    // mask it.
    const m = createAutomation(contextRoot, {
      slug: 'digest', title: 'T', days: 'daily', at: '18:00', prompt: 'p', review: 'agent',
    });
    openQuestion(m.slug);
    const { impl } = fakeSpawn(OK_JSON);
    expect((await run(m.slug, impl)).status).toBe('blocked');
  });

  it('a resolved question never gates anything', async () => {
    const m = makeApproved('digest', 'agent');
    const q = openQuestion('digest');
    resolveQuestion(contextRoot, q, 'approve', 'cli', NOW.toISOString());
    const { impl } = fakeSpawn(OK_JSON);
    expect((await run(m.slug, impl)).status).toBe('ok');
  });
});

// ─── The upgrade path: questions must never become committable ──────────────

describe('the runner re-ensures the hitl gitignore block', () => {
  it('covers an automation that predates HITL and only now opts in', async () => {
    // THE REGRESSION THIS PINS: `createAutomation` was the only OTHER writer of
    // the question ignore block, so any automation created before this feature
    // — or any project whose `.gitignore` was committed before it existed —
    // would write a question holding a LIVE RESUMABLE SESSION ID with no ignore
    // coverage the first time its owner turns review on. That file holds a
    // live, resumable session id, and `sleep done` auto-commits and pushes.
    // That publishes a bypassPermissions capability to every teammate who pulls.
    const m = makeApproved('digest', 'output');

    // Simulate the pre-feature world: strip the hitl lines back out of both
    // governing .gitignore files, exactly as they would be absent on upgrade.
    for (const p of [join(contextRoot, '.gitignore'), join(projectRoot, '.gitignore')]) {
      if (!existsSync(p)) continue;
      writeFileSync(p, readFileSync(p, 'utf-8').split('\n').filter((l) => !l.includes('automations/hitl')).join('\n'), 'utf-8');
    }
    expect(readFileSync(join(contextRoot, '.gitignore'), 'utf-8')).not.toContain('automations/hitl');

    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);

    // the run put it back BEFORE it could write a question
    expect(readFileSync(join(contextRoot, '.gitignore'), 'utf-8')).toContain('automations/hitl/');
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toContain('_dream_context/automations/hitl/');
    // and a question really was written, so the ordering actually mattered
    expect(pendingQuestion(contextRoot, 'digest')).not.toBeNull();
  });

  it('S7 — strips the stale automations/review/ line a pre-T12 project still carries, and touches nothing else', async () => {
    const m = makeApproved('digest', 'output');
    // Seed BOTH governing files with exactly the line a project written before
    // T12 would still have — `ensureGitignoreEntries` only ever appends, so
    // nothing short of an explicit strip would ever remove it. Strip nothing
    // ourselves here; the run is what has to do it.
    for (const [path, line] of [
      [join(contextRoot, '.gitignore'), 'automations/review/'],
      [join(projectRoot, '.gitignore'), '_dream_context/automations/review/'],
    ] as const) {
      const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
      writeFileSync(path, `${existing}\n${line}\n`, 'utf-8');
    }
    expect(readFileSync(join(contextRoot, '.gitignore'), 'utf-8')).toContain('automations/review/');
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toContain('_dream_context/automations/review/');

    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);

    const contextGitignore = readFileSync(join(contextRoot, '.gitignore'), 'utf-8');
    const rootGitignore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    // the stale line is gone...
    expect(contextGitignore).not.toContain('automations/review/');
    expect(rootGitignore).not.toContain('automations/review/');
    // ...while automations/hitl/ — where T6 actually writes — is present
    expect(contextGitignore).toContain('automations/hitl/');
    expect(rootGitignore).toContain('_dream_context/automations/hitl/');
  });

  it('a real `git status` does not offer the question as an addable file', () => {
    // The end-to-end statement of the same property, checked against git itself
    // rather than against our own string matching.
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
    makeApproved('gitcheck', 'agent');
    openQuestion('gitcheck');
    const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: projectRoot, encoding: 'utf-8',
    });
    expect(untracked).not.toContain('automations/hitl');
  });
});

// ─── 2. review: off is untouched ─────────────────────────────────────────────

describe('review: off behaves exactly as before', () => {
  it('publishes straight to the output directory and creates no question', async () => {
    const m = makeApproved('digest', 'off');
    const { impl } = fakeSpawn(OK_JSON);
    const outcome = await run(m.slug, impl);

    expect(outcome.status).toBe('ok');
    expect(outcome.reviewCardId).toBeNull();
    expect(outcome.outputPath).not.toBeNull();
    expect(readFileSync(outcome.outputPath as string, 'utf-8')).toBe(DOCUMENT);
    expect(listQuestions(contextRoot, 'digest')).toEqual([]);
    expect(existsSync(join(contextRoot, 'automations', 'hitl'))).toBe(false);
  });

  it('is not even gated by a question belonging to another automation', async () => {
    makeApproved('other', 'agent');
    openQuestion('other');
    const m = makeApproved('digest', 'off');
    const { impl } = fakeSpawn(OK_JSON);
    expect((await run(m.slug, impl)).status).toBe('ok');
  });
});

// ─── 3. review: output asks instead of publishing ────────────────────────────

describe('review: output asks the human before publishing', () => {
  it('writes NOTHING to the output directory and opens a question holding the document', async () => {
    // The single gate that keeps three things behind one answer: the
    // notification does not point at a published file, sleep does not scan for
    // one, autoSync has no reason to commit one — all because nothing reached
    // the output directory yet.
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    const outcome = await run(m.slug, impl);

    expect(outcome.status).toBe('awaiting-review');
    expect(outcome.outputPath).toBeNull();
    expect(outcome.reviewCardId).not.toBeNull();

    const { dir } = outputDirFor(contextRoot, m);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);

    const question = pendingQuestion(contextRoot, 'digest');
    expect(question?.kind).toBe('flow-hitl');
    // No staged file any more: the document lives IN the question text, the
    // way a `kind: 'output'` card used to carry it as its body.
    expect(question?.question).toContain('Four commits landed today.');
    expect(question?.question).toContain('Details here.');
  });

  it('the watermark DOES advance — the child really ran', async () => {
    // The invariant stays "advances iff a child started", with no special case
    // for review: what is pending is the human's verdict, not the run.
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    expect(readAutomationCache(contextRoot, 'digest')?.lastFireAt).toBe(NOW.toISOString());
  });

  it('the notification says a verdict is owed, and has nothing to open', async () => {
    // `status` becomes `awaiting-review` here — the SAME value the flow's own
    // HITL gate produces — so the banner follows that already-established
    // shape too: title carries the status, body carries the reason, sound is
    // the FAILED one (nothing published — the "ok, here's your digest" chime
    // would be the wrong signal for something that still needs an answer).
    // Nothing is staged to disk any more, so — unlike the retired review-card
    // model — a banner click has no specific file to open either way; the
    // document is only in the question and the resumable session, both
    // answered in-app.
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    const notify = vi.fn();
    await run(m.slug, impl, { notify });

    expect(notify).toHaveBeenCalledTimes(1);
    const [title, body, , openTarget] = notify.mock.calls[0];
    expect(title).toMatch(/awaiting-review/);
    expect(body).toMatch(/waiting for your verdict/);
    expect(openTarget).toBeNull();
  });

  it('an AGENT question has nothing to open either — the app and Telegram answer that one', async () => {
    const m = makeApproved('digest', 'agent');
    const impl = vi.fn(() => {
      openQuestion('digest', { sessionId: null, question: 'Send the mail?', runFiredAt: NOW.toISOString() });
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = Object.assign(new EventEmitter(), { pid: 4321, stdout, stderr, kill: () => {} });
      setImmediate(() => {
        stdout.emit('data', Buffer.from(OK_JSON, 'utf-8'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnImpl;
    const notify = vi.fn();
    await run(m.slug, impl, { notify });
    expect(notify.mock.calls[0][0]).toMatch(/needs your verdict/);
    expect(notify.mock.calls[0][3]).toBeNull();
  });

  it('a FAILED run publishes nothing and asks nothing', async () => {
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(JSON.stringify({ result: 'broke', is_error: true, session_id: SESSION }));
    const outcome = await run(m.slug, impl);
    expect(outcome.status).toBe('failed');
    expect(listQuestions(contextRoot, 'digest')).toEqual([]);
  });
});

// ─── review: agent — the run decides ─────────────────────────────────────────

describe('review: agent leaves it to the run', () => {
  it('publishes normally when the run never proposes', async () => {
    // The promise that makes `agent` safe to turn on: a run that does not stop
    // and ask behaves exactly as it did before review existed.
    const m = makeApproved('digest', 'agent');
    const { impl } = fakeSpawn(OK_JSON);
    const outcome = await run(m.slug, impl);
    expect(outcome.status).toBe('ok');
    expect(outcome.reviewCardId).toBeNull();
    expect(readFileSync(outcome.outputPath as string, 'utf-8')).toBe(DOCUMENT);
  });

  it('does NOT publish the run own words when it proposed', async () => {
    // A run under `agent` ends with "I proposed X", not a document. Publishing
    // that would put a note to the operator into the output archive and hand it
    // to sleep as though it were the job's result.
    const m = makeApproved('digest', 'agent');
    const impl = vi.fn(() => {
      // the "agent" proposes mid-run, exactly as `automations propose` would
      openQuestion('digest', { sessionId: null, question: 'Send the mail?', runFiredAt: NOW.toISOString() });
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = Object.assign(new EventEmitter(), { pid: 4321, stdout, stderr, kill: () => {} });
      setImmediate(() => {
        stdout.emit('data', Buffer.from(JSON.stringify({
          session_id: SESSION, result: 'I proposed it and stopped.', is_error: false, permission_denials: [],
        }), 'utf-8'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnImpl;

    const outcome = await run(m.slug, impl);
    expect(outcome.status).toBe('ok');
    expect(outcome.outputPath).toBeNull();
    expect(outcome.reviewCardId).not.toBeNull();
    const { dir } = outputDirFor(contextRoot, m);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});

// ─── 4. Backfilling the session ──────────────────────────────────────────────

describe('the runner backfills the session id a run could not know', () => {
  it('fills the question the run proposed, making it answerable', async () => {
    const m = makeApproved('digest', 'agent');
    const impl = vi.fn(() => {
      openQuestion('digest', { sessionId: null, question: 'Send the mail?', runFiredAt: NOW.toISOString() });
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = Object.assign(new EventEmitter(), { pid: 4321, stdout, stderr, kill: () => {} });
      setImmediate(() => {
        stdout.emit('data', Buffer.from(OK_JSON, 'utf-8'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnImpl;

    await run(m.slug, impl);
    expect(pendingQuestion(contextRoot, 'digest')?.sessionId).toBe(SESSION);
  });

  it('an output question carries the session too, once the run finishes', async () => {
    // Unlike `propose`, `review: output` already knows the session id at the
    // moment it asks (the runner has just parsed the JSON envelope), so this
    // is not a backfill in the same sense — pinned anyway, since a caller
    // reading `pendingQuestion` should never see a session-less output question.
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    expect(pendingQuestion(contextRoot, 'digest')?.sessionId).toBe(SESSION);
  });
});

// ─── Reporting ───────────────────────────────────────────────────────────────

describe('the snapshot says what is owed', () => {
  it('names the waiting proposal and says the automation is held', async () => {
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasPendingReview).toBe(true);
    // Two lines can legitimately mention "waiting for your verdict" now: the
    // cache-history recap of THIS fire's `awaiting-review` RunEvent (its error
    // text happens to say so too) and the review-specific bullet below, read
    // from the question store rather than the 24h cache window. Find the
    // latter by its distinguishing CLI hint.
    const line = snap.lines.find((l) => l.includes('automations questions digest'));
    expect(line).toBeTruthy();
    expect(line).toMatch(/waiting for your verdict/);
    expect(line).toMatch(/will not run again until you answer/);
  });

  it('does not expire on a clock — an old question still holds the automation', () => {
    // Read from the question store, not the 24h cache window: the run that
    // asked may be long out of the window while the question is still open.
    makeApproved('digest', 'agent');
    openQuestion('digest', { runFiredAt: '2026-07-01T18:00:00.000Z', question: 'Ancient proposal', nowISO: '2026-07-01T18:00:00.000Z' });
    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasPendingReview).toBe(true);
    expect(snap.lines.some((l) => l.includes('Ancient proposal'))).toBe(true);
  });

  it('says nothing once the question is answered', async () => {
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    const question = pendingQuestion(contextRoot, 'digest');
    resolveQuestion(contextRoot, question!, 'approve', 'cli', NOW.toISOString());

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasPendingReview).toBe(false);
    // The review-specific bullet is gone (that is what `hasPendingReview`
    // reports); the fire's own historical recap in `recentLines` is a SEPARATE
    // signal keyed off the RunEvent this run recorded, and it does not expire
    // just because the question that RunEvent mentions was later answered —
    // pin on the review bullet's distinguishing CLI hint, not the phrase alone.
    expect(snap.lines.some((l) => l.includes('automations questions digest'))).toBe(false);
  });
});
