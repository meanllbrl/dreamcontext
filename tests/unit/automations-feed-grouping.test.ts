import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildFeed, buildFeedMessage } from '../../src/lib/automations/feed.js';
import { appendThreadEntry, markThreadRead } from '../../src/lib/automations/threads.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { createQuestion } from '../../src/lib/automations/hitl.js';
import type { RunEvent, ThreadEntry } from '../../src/lib/automations/types.js';

/**
 * The FEED's grouping rules — a flat entry list becoming one message per run.
 *
 * Driven through a fixture rather than a live run: what is under test is the
 * JOIN (which entry becomes the body, what counts as a reply, which status
 * word wins, where duration and cost come from), and a real run can only
 * produce a handful of those shapes.
 */

let projectRoot: string;
let contextRoot: string;
let home: string;
let seq = 0;

const MANIFEST = { slug: 'digest', title: 'Daily digest' };
const RUN = '2026-09-20T18:00:00.000Z';

/** Ids are the sort key, so the fixture mints them in call order. */
function entry(over: Partial<ThreadEntry> & Pick<ThreadEntry, 'kind'>): ThreadEntry {
  seq += 1;
  return {
    id: `00000000${seq}`.slice(-9) + '_aaaaaa',
    runId: RUN,
    at: `2026-09-20T18:0${seq}:00.000Z`,
    text: '',
    via: 'runner',
    ...over,
  } as ThreadEntry;
}

function runEvent(over: Partial<RunEvent> = {}): RunEvent {
  return {
    firedAt: RUN, startedAt: RUN, finishedAt: RUN, status: 'ok',
    durationMs: 252_000, outputPath: null, error: null, exitCode: 0,
    sessionId: 'sess_1', costUsd: 0.31, numTurns: 4, permissionDenials: 0,
    ...over,
  };
}

beforeEach(() => {
  seq = 0;
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-feed-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-feed-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('one run becomes one message', () => {
  it('the first post is the body; later authored entries are replies, system rows are not', () => {
    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'agent', via: 'cli', text: 'WAU is down 4% week-over-week.' }),
      entry({ kind: 'agent', via: 'cli', text: 'Filed a task for the onboarding modal.' }),
      entry({ kind: 'system', event: 'ok', text: 'Finished in 4m 12s.' }),
    ];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, runEvent(), null);

    expect(m.text).toBe('WAU is down 4% week-over-week.');
    expect(m.textFrom).toBe('post');
    // Two system rows and the body itself are NOT replies — only the second
    // post is. "2 replies" on a run nobody spoke in is the failure here.
    expect(m.replyCount).toBe(1);
    expect(m.status).toBe('done');
    expect(m.durationMs).toBe(252_000);
    expect(m.costUsd).toBe(0.31);
    expect(m.key).toBe('digest::2026-09-20T18:00:00.000Z');
  });

  it('a silent run falls back to its own opening result line — never a blank card', () => {
    const outputPath = join(contextRoot, 'automations', 'output', 'digest', '2026-09-20.md');
    mkdirSync(join(contextRoot, 'automations', 'output', 'digest'), { recursive: true });
    writeFileSync(outputPath, 'Flat week: 3 insights synced, nothing moved more than 1%.\n\n## Detail\n\nrows\n', 'utf-8');

    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'system', event: 'ok', text: 'Finished in 3m 40s.' }),
    ];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, runEvent({ outputPath }), null);

    expect(m.text).toBe('Flat week: 3 insights synced, nothing moved more than 1%.');
    expect(m.textFrom).toBe('result');
    expect(m.replyCount).toBe(0);
    // The published document is a file card even though no post attached it,
    // and it is brain-RELATIVE so it opens the same way a posted path does.
    expect(m.files).toEqual([{ path: 'automations/output/digest/2026-09-20.md', name: '2026-09-20.md' }]);
  });

  it('a FAILED run says why — never "nothing to report" over a real failure', () => {
    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'system', event: 'failed', text: 'Failed after 0s — the site returned 403' }),
    ];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, runEvent({
      status: 'failed', error: 'the site returned 403', durationMs: 400,
      // The path a failed run WOULD have published to is still recorded.
      outputPath: join(contextRoot, 'automations', 'output', 'digest', 'never-written.md'),
    }), null);

    expect(m.status).toBe('failed');
    expect(m.text).toBe('the site returned 403');
    expect(m.textFrom).toBe('error');
    // A card is a promise there is something to read. The run never wrote the
    // file, so offering it would open on "not found".
    expect(m.files).toEqual([]);
  });

  it('does NOT offer a ZERO-BYTE document — the runner leaves one behind on failure', () => {
    const dir = join(contextRoot, 'automations', 'output', 'digest');
    mkdirSync(dir, { recursive: true });
    const outputPath = join(dir, 'empty.md');
    writeFileSync(outputPath, '', 'utf-8');
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN,
      [entry({ kind: 'system', event: 'failed', text: 'Failed.' })],
      runEvent({ status: 'failed', error: 'unparseable CLI output', outputPath }), null);
    expect(m.files).toEqual([]);
    expect(m.text).toBe('unparseable CLI output');
  });

  it('offers the published document only when it has something in it', () => {
    const dir = join(contextRoot, 'automations', 'output', 'digest');
    mkdirSync(dir, { recursive: true });
    const outputPath = join(dir, '2026-09-20.md');
    writeFileSync(outputPath, 'It published.\n', 'utf-8');
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN,
      [entry({ kind: 'system', event: 'ok', text: 'Finished.' })], runEvent({ outputPath }), null);
    expect(m.files.map((f) => f.name)).toEqual(['2026-09-20.md']);
  });

  it('reports no text rather than inventing one when a run neither posted nor published', () => {
    const m = buildFeedMessage(
      contextRoot, MANIFEST, false, RUN,
      [entry({ kind: 'system', event: 'started', text: 'Run started.' })],
      null, null,
    );
    expect(m.text).toBe('');
    expect(m.textFrom).toBe('none');
    expect(m.status).toBe('running');
  });
});

describe('the status word', () => {
  it('a run that only started is running', () => {
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN,
      [entry({ kind: 'system', event: 'started', text: 'Run started.' })], null, null);
    expect(m.status).toBe('running');
  });

  it('a run that stopped to ask is needs-you, not running', () => {
    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'system', event: 'asked', text: 'Asked: publish this?' }),
    ];
    expect(buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, null, null).status).toBe('needs-you');
  });

  it('a terminal entry wins over asked — an answered run that finished reads done', () => {
    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'system', event: 'asked', text: 'Asked: publish this?' }),
      entry({ kind: 'system', event: 'ok', text: 'Finished in 6m.' }),
    ];
    expect(buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, null, null).status).toBe('done');
  });

  it('falls back to the CACHE when the thread lost its terminal entry — never "running" forever', () => {
    const entries = [entry({ kind: 'system', event: 'started', text: 'Run started.' })];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, runEvent({ status: 'timeout' }), null);
    expect(m.status).toBe('timeout');
  });

  /**
   * D12 — a reply turn's OWN terminal.
   *
   * An @mention of a scheduled agent opens a run id no dispatcher ever fired,
   * so there is no cache row and the fallback above has nothing to fall back
   * to. Without `replied` in TERMINAL these messages read "running" for ever.
   */
  it('A15a: a reply-turn run with NO cache entry reads done, never running', () => {
    const entries = [
      entry({ kind: 'user', via: 'dashboard', text: '@digest what changed?' }),
      entry({ kind: 'agent', via: 'cli', text: 'Three insights moved.' }),
      entry({ kind: 'system', event: 'replied', text: 'Reply turn finished · 1m 12s · $0.03' }),
    ];
    // `null` run: the whole point — the cache has never heard of this fire.
    expect(buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, null, null).status).toBe('done');
  });

  it('A15b: a REFUSED reply turn on a fresh runId reads failed', () => {
    const entries = [
      entry({ kind: 'user', via: 'dashboard', text: '@digest what changed?' }),
      entry({ kind: 'system', event: 'failed', text: 'Not delivered — a run was in progress.' }),
    ];
    expect(buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, null, null).status).toBe('failed');
  });

  it('A15c: an ok run whose LATER reply turn failed still reads done — and the failure is in the thread', () => {
    // The status word describes THE RUN, and the run finished. Flipping it to
    // `failed` because a later conversation failed would be the lie; the reply
    // turn's own entry is where that failure is legible. Pinned so a future
    // "fix" cannot invert it.
    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'agent', via: 'cli', text: 'Digest published.' }),
      entry({ kind: 'system', event: 'ok', text: 'Finished in 4m 12s.' }),
      entry({ kind: 'user', via: 'dashboard', text: 'can you re-check Tuesday?' }),
      entry({ kind: 'system', event: 'failed', text: 'Not delivered — a run was in progress.' }),
    ];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, runEvent(), null);
    expect(m.status).toBe('done');
    const failure = entries.find((e) => e.event === 'failed');
    expect(failure?.text).toMatch(/Not delivered/);
  });
});

describe('unread', () => {
  it('is true for an entry above the watermark and false once it is below', () => {
    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'agent', via: 'cli', text: 'something happened' }),
    ];
    expect(buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, null, null).unread).toBe(true);
    const after = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, null, entries[1].id);
    expect(after.unread).toBe(false);
  });

  it('your own reply never makes a message unread', () => {
    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'user', via: 'dashboard', text: 'try RSS instead' }),
    ];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, null, entries[0].id);
    expect(m.unread).toBe(false);
    expect(m.replyCount).toBe(1);
  });
});

describe('buildFeed — the whole channel', () => {
  beforeEach(() => {
    for (const slug of ['digest', 'watcher']) {
      createAutomation(contextRoot, { slug, title: `T — ${slug}`, days: 'daily', at: '18:00', prompt: 'go' });
    }
  });

  it('interleaves every agent\'s runs in reading order, newest last', () => {
    appendThreadEntry(contextRoot, 'digest', {
      runId: '2026-09-20T09:00:00.000Z', kind: 'system', event: 'started', text: 'Run started.', via: 'runner',
      now: new Date('2026-09-20T09:00:00.000Z'),
    });
    appendThreadEntry(contextRoot, 'watcher', {
      runId: '2026-09-20T10:00:00.000Z', kind: 'system', event: 'started', text: 'Run started.', via: 'runner',
      now: new Date('2026-09-20T10:00:00.000Z'),
    });
    appendThreadEntry(contextRoot, 'digest', {
      runId: '2026-09-20T11:00:00.000Z', kind: 'system', event: 'started', text: 'Run started.', via: 'runner',
      now: new Date('2026-09-20T11:00:00.000Z'),
    });

    const feed = buildFeed(contextRoot, { home });
    expect(feed.messages.map((m) => m.slug)).toEqual(['digest', 'watcher', 'digest']);
    expect(feed.unreadTotal).toBe(3);
    expect(feed.unreadBySlug).toEqual({ digest: 2, watcher: 1 });
  });

  it('lists an agent that has never run, so a new agent is in the channel before its first fire', () => {
    const feed = buildFeed(contextRoot, { home });
    expect(feed.messages).toEqual([]);
    expect(feed.agents.map((a) => a.slug).sort()).toEqual(['digest', 'watcher']);
  });

  it('the chip count and the per-message bar agree — both read one watermark', () => {
    for (const at of ['2026-09-20T09:00:00.000Z', '2026-09-20T10:00:00.000Z']) {
      appendThreadEntry(contextRoot, 'digest', {
        runId: at, kind: 'system', event: 'started', text: 'Run started.', via: 'runner', now: new Date(at),
      });
    }
    const before = buildFeed(contextRoot, { home });
    expect(before.unreadBySlug.digest).toBe(2);
    expect(before.messages.filter((m) => m.unread)).toHaveLength(2);

    markThreadRead(contextRoot, 'digest', before.messages[0].newestId as string, home);
    const after = buildFeed(contextRoot, { home });
    expect(after.unreadBySlug.digest).toBe(1);
    expect(after.messages.filter((m) => m.unread)).toHaveLength(1);
  });

  it('opens a BOUNDED number of day files — the 15s poll must not grow with retention', () => {
    // 40 day files, one run each. The feed may not open all of them: this
    // route is polled every 15 seconds, per tab, for every agent in the vault.
    const dir = join(contextRoot, 'automations', 'threads', 'digest');
    mkdirSync(dir, { recursive: true });
    for (let d = 1; d <= 40; d++) {
      const day = `2026-08-${String(d).padStart(2, '0')}`;
      const stamp = d > 31 ? `2026-09-${String(d - 31).padStart(2, '0')}` : day;
      appendThreadEntry(contextRoot, 'digest', {
        runId: `${stamp}T09:00:00.000Z`, kind: 'system', event: 'started',
        text: stamp, via: 'runner', now: new Date(`${stamp}T09:00:01.000Z`),
      });
    }
    const opened = readdirSync(dir).length;
    expect(opened).toBe(40);

    const feed = buildFeed(contextRoot, { home });
    // The window, not the file count — proof the slice happened BEFORE the
    // reads, not after. A feed that returned all 40 would mean every poll
    // parsed the whole retained history.
    expect(feed.messages.length).toBeLessThanOrEqual(14);
    expect(feed.messages.length).toBeGreaterThan(0);
    // And it kept the NEWEST ones — a window that dropped the recent end
    // would bound the cost and destroy the feature.
    expect(feed.messages[feed.messages.length - 1].runId).toBe('2026-09-09T09:00:00.000Z');
  });

  it('limit keeps the NEWEST messages and restores reading order', () => {
    for (const at of ['2026-09-20T09:00:00.000Z', '2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z']) {
      appendThreadEntry(contextRoot, 'digest', {
        runId: at, kind: 'system', event: 'started', text: at, via: 'runner', now: new Date(at),
      });
    }
    const feed = buildFeed(contextRoot, { home, limit: 2 });
    expect(feed.messages.map((m) => m.runId)).toEqual(['2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z']);
  });
});

/**
 * THE ASK — a run a human started by typing in `#agents`.
 *
 * The rules under test are all "what is the ask NOT": not the body, not a
 * reply, and not silent when the fire never became a run.
 */
describe('a run the owner asked for', () => {
  it('carries the ask as the question, never as a reply', () => {
    const entries = [
      entry({ kind: 'user', via: 'dashboard', text: 'only the paywall numbers' }),
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'agent', via: 'cli', text: 'Paywall conversion is flat at 3.1%.' }),
      entry({ kind: 'system', event: 'ok', text: 'Finished in 9s.' }),
    ];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, runEvent(), null);

    expect(m.ask?.text).toBe('only the paywall numbers');
    expect(m.text).toBe('Paywall conversion is flat at 3.1%.');
    expect(m.textFrom).toBe('post');
    // THE POINT: an exchange of one question and one answer has no replies.
    // Counting the ask would put "1 reply" on every message the owner started.
    expect(m.replyCount).toBe(0);
    // And the exchange is stamped when the PERSON spoke, not when the runner
    // got around to spawning.
    expect(m.at).toBe(entries[0].at);
  });

  it('a LATER user entry is a reply, not the ask', () => {
    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'agent', via: 'cli', text: 'Done.' }),
      entry({ kind: 'user', via: 'dashboard', text: 'and the refunds?' }),
    ];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, runEvent(), null);

    expect(m.ask).toBeNull();
    expect(m.replyCount).toBe(1);
  });

  it('a fire that never became a run says so, instead of reading "running" for ever', () => {
    const entries = [
      entry({ kind: 'user', via: 'dashboard', text: 'check the competitors' }),
      entry({ kind: 'system', event: 'skipped', text: 'It did not run — a sleep cycle holds the lock right now.' }),
    ];
    // `run: null` on purpose — a blocked/deferred fire leaves no terminal
    // cache status for `statusFor` to fall back to, which is exactly the case
    // that used to hang on "running".
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, null, null);

    expect(m.status).toBe('skipped');
    expect(m.text).toBe('It did not run — a sleep cycle holds the lock right now.');
    expect(m.textFrom).toBe('skipped');
    expect(m.ask?.text).toBe('check the competitors');
    expect(m.replyCount).toBe(0);
  });

  it('your own ask never badges you, but the answer to it does', () => {
    const askOnly = [entry({ kind: 'user', via: 'dashboard', text: 'go' })];
    expect(buildFeedMessage(contextRoot, MANIFEST, false, RUN, askOnly, null, null).unread).toBe(false);

    const answered = [...askOnly, entry({ kind: 'agent', via: 'cli', text: 'Went.' })];
    expect(buildFeedMessage(contextRoot, MANIFEST, false, RUN, answered, null, null).unread).toBe(true);
  });
});

/**
 * The two-sided rule `answerIfSilent` enforces, asserted at the FEED, which is
 * where the owner would see it go wrong. The job-side predicate is "did this
 * run say anything"; these are the two shapes that predicate has to separate.
 */
describe('an ask that stops on a question', () => {
  it('a run that ASKED reads "needs you" and must not also deny that it ran', () => {
    const entries = [
      entry({ kind: 'user', via: 'dashboard', text: 'check the refunds' }),
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'system', event: 'asked', text: 'Publish this?' }),
    ];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, null, null);

    expect(m.status).toBe('needs-you');
    // If the job had answered by STATUS rather than by what the thread holds,
    // `awaiting-review` would have added a `skipped` entry here and this run
    // would claim both "needs you" and "it did not run".
    expect(m.textFrom).not.toBe('skipped');
  });

  it('a run blocked BY an earlier question never started, so it says so', () => {
    // The step-4.5 short-circuit: `awaiting-review` with no `started`, no
    // `asked` and no terminal entry — the shape that read "running" for ever.
    const entries = [
      entry({ kind: 'user', via: 'dashboard', text: 'check the refunds' }),
      entry({
        kind: 'system', event: 'skipped', via: 'dashboard',
        text: 'It did not run — an earlier run of this agent is still waiting on your verdict.',
      }),
    ];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, null, null);

    expect(m.status).toBe('skipped');
    expect(m.status).not.toBe('running');
    expect(m.textFrom).toBe('skipped');
  });
});

describe('the open question a message is stopped on', () => {
  /**
   * A JOIN against hitl.ts, never a thread field. An entry is append-only and
   * never rewritten, so a question stored ON one could not disappear when it is
   * answered — reading it live is what lets the block vanish the moment the
   * human presses a button rather than at the next write.
   */
  beforeEach(() => {
    createAutomation(contextRoot, { slug: 'digest', title: 'Daily digest', days: 'daily', at: '18:00', prompt: 'go' });
  });

  function ask(runFiredAt: string, choices: string[] = ['approve', 'reject']) {
    return createQuestion(contextRoot, {
      slug: 'digest', runFiredAt, kind: 'flow-hitl', sessionId: null, channel: 'chat',
      question: 'Publish the digest?', choices,
    });
  }

  it('attaches the pending question to ITS run, and marks that message needsYou', () => {
    const run = '2026-09-20T18:00:00.000Z';
    appendThreadEntry(contextRoot, 'digest', {
      runId: run, kind: 'system', event: 'asked', text: 'Asked: publish?', via: 'runner', now: new Date(run),
    });
    const q = ask(run);

    const feed = buildFeed(contextRoot, { home });
    const [m] = feed.messages;
    expect(m.question).toEqual({ id: q.id, text: 'Publish the digest?', choices: ['approve', 'reject'] });
    expect(m.needsYou).toBe(true);
    expect(feed.needsYouTotal).toBe(1);
  });

  it('does NOT attach it to a DIFFERENT run of the same agent', () => {
    const asked = '2026-09-20T18:00:00.000Z';
    const other = '2026-09-21T18:00:00.000Z';
    for (const at of [asked, other]) {
      appendThreadEntry(contextRoot, 'digest', {
        runId: at, kind: 'system', event: 'started', text: 'Run started.', via: 'runner', now: new Date(at),
      });
    }
    ask(asked);

    const feed = buildFeed(contextRoot, { home });
    const byRun = new Map(feed.messages.map((m) => [m.runId, m]));
    expect(byRun.get(asked)!.question).not.toBeNull();
    expect(byRun.get(other)!.question).toBeNull();
    expect(byRun.get(other)!.needsYou).toBe(false);
    expect(feed.needsYouTotal).toBe(1);
  });

  it('ignores an APPROVAL question — it belongs to no run in this feed', () => {
    // The manifest-diff ask is raised BEFORE a run, with its session forced
    // null. Answering it is a different screen's job, and attaching it here
    // would put buttons on a message whose run it never belonged to.
    const run = '2026-09-20T18:00:00.000Z';
    appendThreadEntry(contextRoot, 'digest', {
      runId: run, kind: 'system', event: 'started', text: 'Run started.', via: 'runner', now: new Date(run),
    });
    createQuestion(contextRoot, {
      slug: 'digest', runFiredAt: run, kind: 'approval', sessionId: null, channel: 'chat',
      question: 'The manifest changed — re-approve?', choices: ['approve', 'reject'],
    });

    const feed = buildFeed(contextRoot, { home });
    expect(feed.messages[0].question).toBeNull();
    expect(feed.needsYouTotal).toBe(0);
  });

  it('a FINISHED run can still owe an answer — needsYou is not the status word', () => {
    // Two independent ways to be waiting: the run having stopped to ask, and a
    // question nobody has answered. Neither implies the other.
    const run = '2026-09-20T18:00:00.000Z';
    appendThreadEntry(contextRoot, 'digest', {
      runId: run, kind: 'system', event: 'ok', text: 'Finished in 4m.', via: 'runner', now: new Date(run),
    });
    ask(run);

    const [m] = buildFeed(contextRoot, { home }).messages;
    expect(m.status).toBe('done');
    expect(m.needsYou).toBe(true);
  });

  it('needsYou is true for an asked run even with no question record on disk', () => {
    const run = '2026-09-20T18:00:00.000Z';
    appendThreadEntry(contextRoot, 'digest', {
      runId: run, kind: 'system', event: 'asked', text: 'Asked: publish?', via: 'runner', now: new Date(run),
    });
    const [m] = buildFeed(contextRoot, { home }).messages;
    expect(m.question).toBeNull();
    expect(m.status).toBe('needs-you');
    expect(m.needsYou).toBe(true);
  });
});

describe('the summary block on a message', () => {
  it('carries the BODY post\'s rows, not a later post\'s', () => {
    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'agent', via: 'cli', text: 'WAU moved.', summary: [{ key: 'WAU', value: '-4%' }] }),
      entry({ kind: 'agent', via: 'cli', text: 'Also filed a task.', summary: [{ key: 'Tasks', value: '1' }] }),
      entry({ kind: 'system', event: 'ok', text: 'Finished.' }),
    ];
    const m = buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, runEvent(), null);
    // A later post's figures are read WITH that post, in the thread.
    expect(m.summary).toEqual([{ key: 'WAU', value: '-4%' }]);
  });

  it('is null when the body posted no figures', () => {
    const entries = [
      entry({ kind: 'system', event: 'started', text: 'Run started.' }),
      entry({ kind: 'agent', via: 'cli', text: 'nothing numeric' }),
    ];
    expect(buildFeedMessage(contextRoot, MANIFEST, false, RUN, entries, runEvent(), null).summary).toBeNull();
  });
});
