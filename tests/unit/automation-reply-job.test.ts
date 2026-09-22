import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The reply JOB — what happens after the route has said 202 and let go.
 *
 * Everything here is about completion the client cannot see: the job owns its own
 * ending, so a closed tab, a refused lock and a restarted server each have to leave the
 * thread in an honest state without anyone polling. `resumeWithMessage` is doubled
 * (a real one spawns `claude`), which is also what lets the lock-busy path be driven
 * deterministically instead of raced.
 */

const resumeWithMessage = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/automations/verdict.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/automations/verdict.js')>()),
  resumeWithMessage,
}));
// The bundle is a macOS applet that may not exist; stubbed so a notification attempt is
// observable rather than silently platform-skipped.
const notifyViaBundle = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../src/lib/automations/notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/automations/notifier.js')>()),
  notifyViaBundle,
}));

const {
  startAutomationReplyJob, currentReplyJob, reconcileReplyThreads, PROCESS_STARTED_AT,
} = await import('../../src/server/automation-job.js');
const { createAutomation, writeRunSidecar } = await import('../../src/lib/automations/store.js');
const { appendThreadEntry, readThread, newThreadEntryId, markThreadRead } =
  await import('../../src/lib/automations/threads.js');

let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;

const RUN = '2026-09-22T09:00:00.000Z';

/** Wait for the job to leave `running` — it settles on a microtask, not a timer. */
async function settled(id: string, tries = 50): Promise<ReturnType<typeof currentReplyJob>> {
  for (let i = 0; i < tries; i++) {
    const job = currentReplyJob(id);
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  return currentReplyJob(id);
}

function seedUserEntry(slug: string, runId = RUN, now?: Date): string {
  return appendThreadEntry(contextRoot, slug, {
    runId, kind: 'user', text: 'what changed?', via: 'dashboard', ...(now ? { now } : {}),
  }).id;
}

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'dc-replyjob-home-'));
  process.env.HOME = home;
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-replyjob-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  createAutomation(contextRoot, { slug: 'digest', title: 'Daily digest', days: 'daily', at: '18:00', prompt: 'go' });
  createAutomation(contextRoot, { slug: 'watcher', title: 'Watcher', days: 'daily', at: '19:00', prompt: 'go' });
  resumeWithMessage.mockReset();
  notifyViaBundle.mockReset();
  notifyViaBundle.mockReturnValue(true);
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('the reply job owns its own completion', () => {
  it('settles ok, writes ONE terminal entry with the turn length AND cost, and mirrors a silent answer', async () => {
    resumeWithMessage.mockResolvedValue({ status: 'ok', error: null, result: 'WAU is down 4%.', costUsd: 0.0312 });
    const entryId = seedUserEntry('digest');

    const job = startAutomationReplyJob(contextRoot, 'digest', {
      runId: RUN, text: 'what changed?', entryId, home,
    });
    expect(job.status).toBe('running');
    const done = await settled(job.id);
    expect(done?.status).toBe('ok');

    const entries = readThread(contextRoot, 'digest', { runId: RUN });
    const terminal = entries.filter((e) => e.kind === 'system');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toBe('replied');
    // A6's shape: what it took and what it cost, to the cent — the channel's own precision.
    expect(terminal[0].text).toMatch(/^Reply turn finished · \d+s · \$0\.03\.$/);

    // The child posted nothing, so the turn's own answer is mirrored rather than lost.
    const mirrored = entries.filter((e) => e.kind === 'agent');
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0].text).toBe('WAU is down 4%.');
    expect(mirrored[0].via).toBe('runner');
  });

  it('omits the cost entirely when the envelope reported none — never "$0.00"', async () => {
    // A turn whose cost is UNKNOWN (nothing spawned, force-killed on the timeout, output
    // did not parse) and a turn that was FREE are different claims. `costUsd` is optional
    // on TalkOutcome, so absent and explicitly-null both have to read the same way.
    for (const outcome of [
      { status: 'ok', error: null, result: 'done' },                    // field absent
      { status: 'ok', error: null, result: 'done', costUsd: null },     // field null
    ]) {
      rmSync(join(contextRoot, 'automations', 'threads'), { recursive: true, force: true });
      resumeWithMessage.mockResolvedValue(outcome);
      const entryId = seedUserEntry('digest');
      await settled(startAutomationReplyJob(contextRoot, 'digest', {
        runId: RUN, text: 'x', entryId, home,
      }).id);

      const terminal = readThread(contextRoot, 'digest', { runId: RUN }).filter((e) => e.kind === 'system');
      expect(terminal).toHaveLength(1);
      expect(terminal[0].text).toMatch(/^Reply turn finished · \d+s\.$/);
      expect(terminal[0].text).not.toContain('$');
    }
  });

  it('reports the cost of a turn that FAILED too — a failed turn still burned tokens', async () => {
    resumeWithMessage.mockResolvedValue({
      status: 'failed', error: 'claude reported is_error: true', result: null, costUsd: 0.07,
    });
    const entryId = seedUserEntry('digest');
    await settled(startAutomationReplyJob(contextRoot, 'digest', { runId: RUN, text: 'x', entryId, home }).id);

    const terminal = readThread(contextRoot, 'digest', { runId: RUN }).filter((e) => e.kind === 'system');
    expect(terminal[0].event).toBe('failed');
    expect(terminal[0].text).toMatch(/^Reply not delivered · \d+s · \$0\.07 — claude reported is_error: true$/);
  });

  it('does NOT mirror when the resumed child posted for itself', async () => {
    resumeWithMessage.mockImplementation(async () => {
      // The child's own post lands DURING the turn — after the user entry, before settle.
      appendThreadEntry(contextRoot, 'digest', {
        runId: RUN, kind: 'agent', text: 'I posted this myself.', via: 'cli',
      });
      return { status: 'ok', error: null, result: 'I posted this myself.' };
    });
    const entryId = seedUserEntry('digest');
    const job = startAutomationReplyJob(contextRoot, 'digest', { runId: RUN, text: 'x', entryId, home });
    await settled(job.id);

    const posts = readThread(contextRoot, 'digest', { runId: RUN }).filter((e) => e.kind === 'agent');
    expect(posts).toHaveLength(1);
    expect(posts[0].via).toBe('cli');
  });

  it('runs to completion with NOBODY polling — a closed tab changes nothing', async () => {
    resumeWithMessage.mockResolvedValue({ status: 'ok', error: null, result: 'done' });
    const entryId = seedUserEntry('digest');
    const job = startAutomationReplyJob(contextRoot, 'digest', { runId: RUN, text: 'x', entryId, home });
    // Deliberately never call currentReplyJob until the very end.
    await new Promise((r) => setTimeout(r, 60));
    expect(readThread(contextRoot, 'digest', { runId: RUN }).some((e) => e.event === 'replied')).toBe(true);
    expect(currentReplyJob(job.id)?.status).toBe('ok');
  });

  it('notifies once when unread, and stays silent once the watermark has passed it', async () => {
    resumeWithMessage.mockResolvedValue({ status: 'ok', error: null, result: 'WAU is down 4%.' });
    const first = seedUserEntry('digest');
    await settled(startAutomationReplyJob(contextRoot, 'digest', { runId: RUN, text: 'x', entryId: first, home }).id);
    expect(notifyViaBundle).toHaveBeenCalledTimes(1);
    expect(notifyViaBundle.mock.calls[0][1]).toBe('WAU is down 4%.');

    notifyViaBundle.mockClear();
    const second = seedUserEntry('digest');
    markThreadRead(contextRoot, 'digest', second, home);
    await settled(startAutomationReplyJob(contextRoot, 'digest', { runId: RUN, text: 'x', entryId: second, home }).id);
    expect(notifyViaBundle).not.toHaveBeenCalled();
  });
});

describe('THE LOCK SEAM — two refusal paths, and they are not the same path', () => {
  /**
   * A9a is the ROUTE's pre-check: `currentAutomationJob` reports a run in flight, the
   * route answers 409 and writes nothing, and no job is ever created. It is tested in
   * `automation-threads-routes.test.ts`, because nothing reaches this file on that path.
   *
   * A9b is what remains after the pre-check passes: the per-slug run lock can still be
   * taken between the check and the resume. There is no job to see it — `resumeWithMessage`
   * refuses, the job settles `refused`, and the entry the human already wrote is marked
   * undelivered by the job's own `finally`. THAT is what this block covers.
   */
  it('settles refused and marks the human\'s entry undelivered, with the lock\'s own sentence', async () => {
    const LOCK_REASON = 'a run for this automation is still in progress — nothing was changed, try again in a moment';
    resumeWithMessage.mockResolvedValue({ status: 'refused', error: LOCK_REASON, result: null });
    const entryId = seedUserEntry('digest');

    const job = startAutomationReplyJob(contextRoot, 'digest', { runId: RUN, text: 'x', entryId, home });
    const done = await settled(job.id);
    expect(done?.status).toBe('refused');
    expect(done?.reason).toBe(LOCK_REASON);

    const terminal = readThread(contextRoot, 'digest', { runId: RUN }).filter((e) => e.kind === 'system');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].event).toBe('failed');
    expect(terminal[0].text).toContain('Reply not delivered');
    expect(terminal[0].text).toContain(LOCK_REASON);
    // A refused turn has no answer, so nothing is mirrored.
    expect(readThread(contextRoot, 'digest', { runId: RUN }).some((e) => e.kind === 'agent')).toBe(false);
  });

  it('runs two DIFFERENT slugs in parallel — the channel model holds', async () => {
    const release: Record<string, () => void> = {};
    resumeWithMessage.mockImplementation((_root: string, slug: string) =>
      new Promise((resolve) => {
        release[slug] = () => resolve({ status: 'ok', error: null, result: `${slug} answered` });
      }));

    const a = startAutomationReplyJob(contextRoot, 'digest', {
      runId: RUN, text: 'x', entryId: seedUserEntry('digest'), home,
    });
    const b = startAutomationReplyJob(contextRoot, 'watcher', {
      runId: RUN, text: 'y', entryId: seedUserEntry('watcher'), home,
    });
    await new Promise((r) => setTimeout(r, 20));
    // Both in flight at once: the registry is keyed by job id, not by project.
    expect(currentReplyJob(a.id)?.status).toBe('running');
    expect(currentReplyJob(b.id)?.status).toBe('running');

    release.watcher();
    expect((await settled(b.id))?.status).toBe('ok');
    expect(currentReplyJob(a.id)?.status).toBe('running');
    release.digest();
    expect((await settled(a.id))?.status).toBe('ok');
  });
});

describe('prune is settlement-based, never age-based', () => {
  it('keeps a RUNNING job of any age and drops a settled one past the TTL', async () => {
    let releaseSlow: (() => void) | null = null;
    resumeWithMessage.mockImplementation(() => new Promise((resolve) => {
      releaseSlow = () => resolve({ status: 'ok', error: null, result: null });
    }));
    const slow = startAutomationReplyJob(contextRoot, 'digest', {
      runId: RUN, text: 'x', entryId: seedUserEntry('digest'), home,
    });
    // Three hours old and still running — a reply resume may legitimately approach the
    // automation's whole timeout, so age alone must never evict it.
    slow.startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

    resumeWithMessage.mockResolvedValue({ status: 'ok', error: null, result: null });
    const quick = startAutomationReplyJob(contextRoot, 'watcher', {
      runId: RUN, text: 'y', entryId: seedUserEntry('watcher'), home,
    });
    await settled(quick.id);
    // Settle it two hours ago, then trigger a prune by starting another job.
    const settledJob = currentReplyJob(quick.id)!;
    settledJob.finishedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    startAutomationReplyJob(contextRoot, 'watcher', {
      runId: RUN, text: 'z', entryId: seedUserEntry('watcher'), home,
    });
    expect(currentReplyJob(slow.id)?.status).toBe('running');
    expect(currentReplyJob(quick.id)).toBeNull();
    releaseSlow?.();
  });
});

describe('reconciliation closes what a previous process left open', () => {
  /** An entry id whose ms prefix is older than this process — i.e. a previous boot's. */
  function oldUserEntry(slug: string, runId = RUN): string {
    return seedUserEntry(slug, runId, new Date(PROCESS_STARTED_AT - 60_000));
  }

  it('appends exactly one derived-id entry, and is idempotent on a second pass', async () => {
    const entryId = oldUserEntry('digest');
    await reconcileReplyThreads(contextRoot, { processStartedAt: PROCESS_STARTED_AT });

    const closers = readThread(contextRoot, 'digest').filter((e) => e.id === `${entryId}~r`);
    expect(closers).toHaveLength(1);
    expect(closers[0].text).toContain('Outcome unknown');
    expect(closers[0].event).toBe('replied');

    // A second process reconciling the same orphan writes the SAME id, and readThread's
    // dedupe collapses it — no lock, no coordination.
    appendThreadEntry(contextRoot, 'digest', {
      id: `${entryId}~r`, runId: RUN, kind: 'system', event: 'replied', via: 'runner',
      text: 'Outcome unknown — the server restarted during this reply.',
    });
    expect(readThread(contextRoot, 'digest').filter((e) => e.id === `${entryId}~r`)).toHaveLength(1);
  });

  it('two concurrent calls in one process share one reconcile', async () => {
    const entryId = oldUserEntry('digest');
    await Promise.all([
      reconcileReplyThreads(contextRoot, { processStartedAt: PROCESS_STARTED_AT }),
      reconcileReplyThreads(contextRoot, { processStartedAt: PROCESS_STARTED_AT }),
    ]);
    expect(readThread(contextRoot, 'digest').filter((e) => e.id === `${entryId}~r`)).toHaveLength(1);
  });

  it('IGNORES a user entry newer than the process start — that reply is still ours to finish', async () => {
    const entryId = seedUserEntry('digest'); // written now, i.e. by THIS process
    await reconcileReplyThreads(contextRoot, { processStartedAt: PROCESS_STARTED_AT });
    expect(readThread(contextRoot, 'digest').some((e) => e.id === `${entryId}~r`)).toBe(false);
  });

  it('leaves an ANSWERED reply alone — something spoke after it', async () => {
    const entryId = oldUserEntry('digest');
    appendThreadEntry(contextRoot, 'digest', {
      runId: RUN, kind: 'system', event: 'replied', via: 'runner', text: 'Reply turn finished · 4s.',
    });
    await reconcileReplyThreads(contextRoot, { processStartedAt: PROCESS_STARTED_AT });
    expect(readThread(contextRoot, 'digest').some((e) => e.id === `${entryId}~r`)).toBe(false);
  });

  it('skips a slug whose child is still running — a live sidecar means it may yet report', async () => {
    const entryId = oldUserEntry('digest');
    // Written through the real writer, so the fixture is a sidecar the real reader
    // accepts rather than a file that merely looks like one.
    writeRunSidecar(contextRoot, 'digest', {
      slug: 'digest', runnerPid: process.pid, childPid: process.pid, childPgid: process.pid,
      fireAt: RUN, startedAt: RUN, timeoutAt: new Date(Date.now() + 600_000).toISOString(),
    });

    await reconcileReplyThreads(contextRoot, { processStartedAt: PROCESS_STARTED_AT });
    expect(readThread(contextRoot, 'digest').some((e) => e.id === `${entryId}~r`)).toBe(false);
  });
});
