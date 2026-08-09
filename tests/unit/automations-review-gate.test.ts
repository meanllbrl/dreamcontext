/**
 * Wave 3 — where an automation's behaviour actually changes, and only for
 * `review != off`.
 *
 * Four things are under test, and the first is the one that would hurt most if
 * it broke:
 *   1. THE SERIAL GATE — a slug with an unanswered card does not run again, and
 *      does not advance its watermark, so the fire is owed rather than lost;
 *   2. `review: off` behaves BYTE-FOR-BYTE as before (the whole opt-in promise);
 *   3. a staged document does not reach the output directory, which is what
 *      keeps the notification, sleep's consumption and autoSync's push all
 *      behind the single verdict;
 *   4. the session id gets backfilled, because a card that never learns one is
 *      a proposal nobody can approve.
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
import {
  createReviewCard,
  listReviewCards,
  pendingReviewCard,
  resolveReviewCard,
} from '../../src/lib/automations/review.js';
import { buildAutomationsSnapshot } from '../../src/lib/automations/snapshot.js';
import { resumeWithVerdict } from '../../src/lib/automations/verdict.js';
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

describe('the serial gate: an unanswered card holds the automation', () => {
  it('REFUSES to spawn while a card is open', async () => {
    const m = makeApproved('digest', 'agent');
    createReviewCard(contextRoot, {
      slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: SESSION,
      kind: 'agent', title: 'Publish this', body: 'proposal', nowISO: NOW.toISOString(),
    });
    const { impl } = fakeSpawn(OK_JSON);

    const outcome = await run(m.slug, impl);
    expect(outcome.status).toBe('awaiting-review');
    expect(impl).not.toHaveBeenCalled();
    expect(outcome.error).toMatch(/waiting for your verdict/);
  });

  it('does NOT advance the watermark — the fire is owed, not lost', async () => {
    // The difference between "you were away, so nothing ran" and "you were
    // away, so the run was silently skipped forever".
    const m = makeApproved('digest', 'agent');
    createReviewCard(contextRoot, {
      slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: SESSION,
      kind: 'agent', title: 'x', body: 'y', nowISO: NOW.toISOString(),
    });
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    expect(readAutomationCache(contextRoot, 'digest')?.lastFireAt).toBeNull();
  });

  it('runs again as soon as the card is answered', async () => {
    const m = makeApproved('digest', 'agent');
    const card = createReviewCard(contextRoot, {
      slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: SESSION,
      kind: 'agent', title: 'x', body: 'y', nowISO: NOW.toISOString(),
    });
    const { impl } = fakeSpawn(OK_JSON);

    expect((await run(m.slug, impl)).status).toBe('awaiting-review');
    resolveReviewCard(contextRoot, card, 'discard', 'cli', NOW.toISOString());
    expect((await run(m.slug, impl)).status).toBe('ok');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('an APPROVAL problem still wins over the review gate', async () => {
    // Ordering: `blocked` is a fault and is the more urgent, more actionable
    // thing to report. A card open on an unapproved automation must not mask it.
    const m = createAutomation(contextRoot, {
      slug: 'digest', title: 'T', days: 'daily', at: '18:00', prompt: 'p', review: 'agent',
    });
    createReviewCard(contextRoot, {
      slug: m.slug, runFiredAt: NOW.toISOString(), sessionId: SESSION,
      kind: 'agent', title: 'x', body: 'y', nowISO: NOW.toISOString(),
    });
    const { impl } = fakeSpawn(OK_JSON);
    expect((await run(m.slug, impl)).status).toBe('blocked');
  });

  it('a resolved card never gates anything', async () => {
    const m = makeApproved('digest', 'agent');
    const card = createReviewCard(contextRoot, {
      slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: SESSION,
      kind: 'agent', title: 'x', body: 'y', nowISO: NOW.toISOString(),
    });
    resolveReviewCard(contextRoot, card, 'approve', 'cli', NOW.toISOString());
    const { impl } = fakeSpawn(OK_JSON);
    expect((await run(m.slug, impl)).status).toBe('ok');
  });
});

// ─── The upgrade path: cards must never become committable ──────────────────

describe('the runner re-ensures the review gitignore block', () => {
  it('covers an automation that predates review and only now opts in', async () => {
    // THE REGRESSION THIS PINS: `createAutomation` was the only writer of the
    // review ignore block, so any automation created before this feature — or
    // any project whose .gitignore was committed before it existed — would write
    // a card holding a LIVE RESUMABLE SESSION ID with no ignore coverage, and
    // `sleep done` auto-commits and pushes. That publishes a bypassPermissions
    // capability to every teammate who pulls.
    const m = makeApproved('digest', 'output');

    // Simulate the pre-feature world: strip the review lines back out of both
    // governing .gitignore files, exactly as they would be absent on upgrade.
    for (const p of [join(contextRoot, '.gitignore'), join(projectRoot, '.gitignore')]) {
      if (!existsSync(p)) continue;
      writeFileSync(p, readFileSync(p, 'utf-8').split('\n').filter((l) => !l.includes('automations/review')).join('\n'), 'utf-8');
    }
    expect(readFileSync(join(contextRoot, '.gitignore'), 'utf-8')).not.toContain('automations/review');

    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);

    // the run put them back BEFORE it could write a card
    expect(readFileSync(join(contextRoot, '.gitignore'), 'utf-8')).toContain('automations/review/');
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toContain('_dream_context/automations/review/');
    // and a card really was written, so the ordering actually mattered
    expect(pendingReviewCard(contextRoot, 'digest')).not.toBeNull();
  });

  it('a real `git status` does not offer the card as an addable file', () => {
    // The end-to-end statement of the same property, checked against git itself
    // rather than against our own string matching.
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
    makeApproved('gitcheck', 'agent');
    createReviewCard(contextRoot, {
      slug: 'gitcheck', runFiredAt: NOW.toISOString(), sessionId: SESSION,
      kind: 'agent', title: 'x', body: 'y', nowISO: NOW.toISOString(),
    });
    const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: projectRoot, encoding: 'utf-8',
    });
    expect(untracked).not.toContain('automations/review');
  });
});

// ─── 2. review: off is untouched ─────────────────────────────────────────────

describe('review: off behaves exactly as before', () => {
  it('publishes straight to the output directory and creates no card', async () => {
    const m = makeApproved('digest', 'off');
    const { impl } = fakeSpawn(OK_JSON);
    const outcome = await run(m.slug, impl);

    expect(outcome.status).toBe('ok');
    expect(outcome.reviewCardId).toBeNull();
    expect(outcome.outputPath).not.toBeNull();
    expect(readFileSync(outcome.outputPath as string, 'utf-8')).toBe(DOCUMENT);
    expect(listReviewCards(contextRoot, 'digest')).toEqual([]);
    expect(existsSync(join(contextRoot, 'automations', 'review'))).toBe(false);
  });

  it('is not even gated by a card belonging to another automation', async () => {
    makeApproved('other', 'agent');
    createReviewCard(contextRoot, {
      slug: 'other', runFiredAt: NOW.toISOString(), sessionId: SESSION,
      kind: 'agent', title: 'x', body: 'y', nowISO: NOW.toISOString(),
    });
    const m = makeApproved('digest', 'off');
    const { impl } = fakeSpawn(OK_JSON);
    expect((await run(m.slug, impl)).status).toBe('ok');
  });
});

// ─── 3. review: output stages instead of publishing ─────────────────────────

describe('review: output stages the document behind the verdict', () => {
  it('writes NOTHING to the output directory and opens a card holding the document', async () => {
    // The single move that opens three gates at once: the notification does not
    // point at it, sleep does not scan for it, autoSync has no reason to commit
    // it — all because it is not in the output directory yet.
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    const outcome = await run(m.slug, impl);

    expect(outcome.status).toBe('ok');
    expect(outcome.outputPath).toBeNull();
    expect(outcome.reviewCardId).not.toBeNull();

    const { dir } = outputDirFor(contextRoot, m);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);

    const card = pendingReviewCard(contextRoot, 'digest');
    expect(card?.kind).toBe('output');
    expect(card?.stagedPath).not.toBeNull();
    expect(readFileSync(card?.stagedPath as string, 'utf-8')).toBe(DOCUMENT);
    // the summary is the run's own headline, so the banner can ask about
    // something specific rather than "a document is waiting"
    expect(card?.summary).toBe('Four commits landed today.');
  });

  it('the watermark DOES advance — the child really ran', async () => {
    // The invariant stays "advances iff a child started", with no special case
    // for review: what is pending is the human's verdict, not the run.
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    expect(readAutomationCache(contextRoot, 'digest')?.lastFireAt).toBe(NOW.toISOString());
  });

  it('the notification ASKS instead of reporting, and opens the STAGED proposal', async () => {
    // A macOS banner cannot carry buttons, so reading is the only thing it can
    // offer — and the thing to read is the proposal, not the output document,
    // which does not exist yet and may never.
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    const notify = vi.fn();
    await run(m.slug, impl, { notify });

    expect(notify).toHaveBeenCalledTimes(1);
    const [title, body, , openTarget] = notify.mock.calls[0];
    expect(title).toMatch(/needs your verdict/);
    expect(body).toBe('Four commits landed today.');
    const card = pendingReviewCard(contextRoot, 'digest');
    expect(openTarget).toBe(card?.stagedPath);
    // and it is emphatically NOT in the output directory
    expect(openTarget).toContain(join('automations', 'review'));
  });

  it('an AGENT card has nothing to open — the queue and Telegram answer that one', async () => {
    const m = makeApproved('digest', 'agent');
    const impl = vi.fn(() => {
      createReviewCard(contextRoot, {
        slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: null,
        kind: 'agent', title: 'Send the mail?', body: 'proposal', nowISO: NOW.toISOString(),
      });
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

  it('a FAILED run publishes nothing and stages nothing', async () => {
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(JSON.stringify({ result: 'broke', is_error: true, session_id: SESSION }));
    const outcome = await run(m.slug, impl);
    expect(outcome.status).toBe('failed');
    expect(listReviewCards(contextRoot, 'digest')).toEqual([]);
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
      createReviewCard(contextRoot, {
        slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: null,
        kind: 'agent', title: 'Send the mail?', body: 'I want to send this.', nowISO: NOW.toISOString(),
      });
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
  it('fills the card the run proposed, making it approvable', async () => {
    const m = makeApproved('digest', 'agent');
    const impl = vi.fn(() => {
      createReviewCard(contextRoot, {
        slug: 'digest', runFiredAt: NOW.toISOString(), sessionId: null,
        kind: 'agent', title: 'Send the mail?', body: 'proposal', nowISO: NOW.toISOString(),
      });
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
    expect(pendingReviewCard(contextRoot, 'digest')?.sessionId).toBe(SESSION);
  });

  it('a staged card carries the session too, so a steer can reach the writer', async () => {
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    expect(pendingReviewCard(contextRoot, 'digest')?.sessionId).toBe(SESSION);
  });
});

// ─── Publishing on approve ───────────────────────────────────────────────────

describe('approving a staged document publishes it, without a conversation', () => {
  it('moves the document into the output directory and spawns nothing', async () => {
    // The human read the very text that publishes. Resuming the session to
    // "carry it out" would spend tokens re-deriving a file that exists — and
    // give the agent a chance to produce something OTHER than what was approved.
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    const card = pendingReviewCard(contextRoot, 'digest');

    const resumeSpawn = vi.fn() as unknown as SpawnImpl;
    const outcome = await resumeWithVerdict(contextRoot, card!, 'approve', 'cli', {
      spawnImpl: resumeSpawn, now: () => NOW, home,
    });

    expect(outcome.status).toBe('ok');
    expect(resumeSpawn).not.toHaveBeenCalled();
    const { dir } = outputDirFor(contextRoot, m);
    const published = readdirSync(dir);
    expect(published).toHaveLength(1);
    expect(readFileSync(join(dir, published[0]), 'utf-8')).toBe(DOCUMENT);
    expect(outcome.card.resolutionNote).toMatch(/Published to/);
  });

  it('discarding leaves the output directory empty', async () => {
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    const card = pendingReviewCard(contextRoot, 'digest');

    // discard DOES resume (a rejection is worth telling the agent about)
    const { impl: resumeImpl } = fakeSpawn(JSON.stringify({
      session_id: SESSION, result: 'understood', is_error: false, permission_denials: [],
    }));
    await resumeWithVerdict(contextRoot, card!, 'discard', 'cli', { spawnImpl: resumeImpl, now: () => NOW, home });

    const { dir } = outputDirFor(contextRoot, m);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('refuses when the staged document has vanished', async () => {
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    const card = pendingReviewCard(contextRoot, 'digest');
    rmSync(card?.stagedPath as string);

    const outcome = await resumeWithVerdict(contextRoot, card!, 'approve', 'cli', { now: () => NOW, home });
    expect(outcome.status).toBe('refused');
    expect(outcome.error).toMatch(/missing/);
    // and it stays answerable rather than being silently consumed
    expect(pendingReviewCard(contextRoot, 'digest')?.id).toBe(card?.id);
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
    const line = snap.lines.find((l) => l.includes('waiting for your verdict'));
    expect(line).toBeTruthy();
    expect(line).toMatch(/will not run again until you answer/);
    expect(line).toMatch(/automations review digest/);
  });

  it('does not expire on a clock — an old card still holds the automation', () => {
    // Read from the card store, not the 24h cache window: the run that created
    // the card may be long out of the window while the card is still open.
    makeApproved('digest', 'agent');
    createReviewCard(contextRoot, {
      slug: 'digest', runFiredAt: '2026-07-01T18:00:00.000Z', sessionId: SESSION,
      kind: 'agent', title: 'Ancient proposal', body: 'y', nowISO: '2026-07-01T18:00:00.000Z',
    });
    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasPendingReview).toBe(true);
    expect(snap.lines.some((l) => l.includes('Ancient proposal'))).toBe(true);
  });

  it('says nothing once the card is answered', async () => {
    const m = makeApproved('digest', 'output');
    const { impl } = fakeSpawn(OK_JSON);
    await run(m.slug, impl);
    const card = pendingReviewCard(contextRoot, 'digest');
    resolveReviewCard(contextRoot, card!, 'approve', 'cli', NOW.toISOString());

    const snap = buildAutomationsSnapshot(contextRoot, { now: NOW, home });
    expect(snap.hasPendingReview).toBe(false);
    expect(snap.lines.some((l) => l.includes('waiting for your verdict'))).toBe(false);
  });
});
