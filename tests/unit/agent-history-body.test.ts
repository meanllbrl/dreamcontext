/**
 * Every run has a body: a run that posted nothing never reads as an empty "ran" for the owner
 * (lib/agents/history.ts `bodyRow`), its status is the truth, and a healthy quiet routine raises no
 * "new" while its row stays (K3). Fictional project and agents only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


import { createAgent } from '../../src/lib/agents/store.js';
import { listAgentHistory, type HistorySession } from '../../src/lib/agents/history.js';
import { createAutomation, recordRun, runChildAlive, writeRunSidecar } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { buildFeed, readRunHead } from '../../src/lib/automations/feed.js';
import { createQuestion } from '../../src/lib/automations/hitl.js';
import { runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { ownerQuietReader, superQuietReader } from '../../src/lib/automations/super-quiet.js';
import { appendThreadEntry, parseDayFile, readThread, threadSlugDir, threadUnread } from '../../src/lib/automations/threads.js';
import { THREAD_ENTRY_MARKER, type RunEvent, type ThreadEntry } from '../../src/lib/automations/types.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const RUN = '2026-10-30T09:00:00.000Z';
const LATER = '2026-10-30T09:01:16.000Z';
let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;

beforeEach(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hist-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hist-home-')));
  realHome = process.env.HOME;
  process.env.HOME = home;
  createAgent(contextRoot, { slug: 'herodot', title: 'Herodot', prompt: 'herodot watches the fictional Acme line.', learning: false }, { approve: { now: NOW, home } });
  createAutomation(contextRoot, { slug: 'line-watch', title: 'Line watch', agent: 'herodot', days: 'daily', at: '09:00', timeoutMinutes: 5 }, { approve: { now: NOW, home } });
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const sys = (event: ThreadEntry['event'], text: string, at: string, extra: { result?: string } = {}, runId = RUN) =>
  appendThreadEntry(contextRoot, 'line-watch', { runId, kind: 'system', event, text, via: 'runner', now: new Date(at), ...extra });

function row(over: Partial<RunEvent> = {}): RunEvent {
  return {
    firedAt: RUN, startedAt: RUN, finishedAt: LATER, status: 'ok', exitCode: 0, outputPath: null, error: null,
    sessionId: null, costUsd: null, numTurns: null, permissionDenials: 0, durationMs: 76_000, ...over,
  } as RunEvent;
}

function doc(body: string, name = 'run.md'): string {
  const dir = join(contextRoot, 'automations', 'output', 'line-watch');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const page = (opts: Partial<Parameters<typeof listAgentHistory>[2]> = {}) =>
  listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home, now: NOW, ...opts });
const session = (opts: Partial<Parameters<typeof listAgentHistory>[2]> = {}): HistorySession => {
  const s = page(opts).sessions.find((x) => x.kind === 'run');
  if (!s) throw new Error('no run session');
  return s;
};
const idle = () => false;

describe('the total rule: one row for a run with no post', () => {
  it('ok: the entry\'s synced result, with no document and no cache row', () => {
    sys('started', 'Run started.', RUN);
    sys('ok', 'Finished in 1m 16s.', LATER, { result: 'Acme is healthy: 3 messages sent.' });
    const s = session({ isRunActive: idle });
    expect(s.status).toBe('ok');
    expect(s.hasDocument).toBe(false);
    expect(s.rows).toMatchObject([{ kind: 'agent', origin: 'answer', text: 'Acme is healthy: 3 messages sent.' }]);
  });

  it('ok on an old run: the document\'s head, the line a banner shows, frontmatter skipped', () => {
    sys('started', 'Run started.', RUN);
    sys('ok', 'Finished in 1m 16s.', LATER);
    recordRun(contextRoot, 'line-watch', row({ outputPath: doc('---\ntitle: x\n---\n\n# Report\n\nThe **line** is quiet.\n') }));
    const s = session();
    expect(s.hasDocument).toBe(true);
    // The tile the member's page draws: brain-relative path, name, the opening sentence.
    expect(s.document).toEqual({ path: 'automations/output/line-watch/run.md', name: 'run.md', head: 'The line is quiet.' });
    expect(s.rows).toMatchObject([{ origin: 'answer', text: 'The line is quiet.' }]);
  });

  it('ok with an empty document, or none: the terminal entry\'s own words, as a note', () => {
    sys('started', 'Run started.', RUN);
    sys('ok', 'Finished in 1m 16s.', LATER);
    recordRun(contextRoot, 'line-watch', row({ outputPath: doc('') }));
    const s = session();
    expect(s.hasDocument).toBe(false);
    expect(s.document).toBeUndefined();
    expect(s.rows).toMatchObject([{ origin: 'note', text: 'Finished in 1m 16s.' }]);
  });

  it('failed and timed out: the reason the terminal entry holds, with no cache row', () => {
    sys('started', 'Run started.', RUN);
    sys('failed', 'Failed after 3s: the Acme API said 401.', LATER);
    expect(session().rows).toMatchObject([{ origin: 'failure', text: 'Failed after 3s: the Acme API said 401.' }]);
    expect(session().status).toBe('failed');
  });

  it('a failure only the cache knows: its error', () => {
    sys('started', 'Run started.', RUN);
    recordRun(contextRoot, 'line-watch', row({ status: 'failed', error: 'no quota left' }));
    expect(session({ isRunActive: idle }).rows).toMatchObject([{ origin: 'failure', text: 'no quota left' }]);
  });

  it('skipped: its entry\'s reason', () => {
    sys('skipped', 'Skipped: the laptop was asleep.', RUN);
    const s = session();
    expect(s.status).toBe('skipped');
    expect(s.rows).toMatchObject([{ origin: 'note', text: 'Skipped: the laptop was asleep.' }]);
  });

  it('a post keeps the run as it was: no extra row', () => {
    sys('started', 'Run started.', RUN);
    appendThreadEntry(contextRoot, 'line-watch', { runId: RUN, kind: 'agent', text: 'I posted.', via: 'cli', now: new Date(LATER) });
    sys('ok', 'Finished.', LATER, { result: 'never shown' });
    expect(session().rows.map((r) => r.text)).toEqual(['I posted.']);
  });

  it('a parallel ask: the owner\'s words, then what is known of the turn', () => {
    appendThreadEntry(contextRoot, 'line-watch', { runId: RUN, kind: 'user', text: 'Check Acme?', via: 'dashboard', now: new Date(RUN) });
    const s = session({ isRunActive: () => true });
    expect(s.status).toBe('running');
    expect(s.rows).toMatchObject([{ kind: 'user' }, { origin: 'note', text: 'Working' }]);
  });

  it('the agent\'s own audience reads rows unchanged', () => {
    sys('started', 'Run started.', RUN);
    sys('ok', 'Finished.', LATER, { result: 'a line' });
    expect(listAgentHistory(contextRoot, 'herodot', { audience: 'agent', home, now: NOW }).sessions[0]?.rows ?? []).toEqual([]);
  });
});

describe('a run\'s status is the truth', () => {
  it('no injected check (the CLI): a started run reads running, as before', () => {
    sys('started', 'Run started.', RUN);
    expect(session().status).toBe('running');
  });

  it('active on this machine: running, and its row says Working', () => {
    sys('started', 'Run started.', RUN);
    expect(session({ isRunActive: (src, id) => src === 'line-watch' && id === RUN })).toMatchObject({
      status: 'running', rows: [{ origin: 'note', text: 'Working' }],
    });
  });

  it('killed here: stopped', () => {
    sys('started', 'Run started.', RUN);
    expect(session({ isRunActive: idle })).toMatchObject({ status: 'stopped', rows: [{ origin: 'note', text: 'Stopped, no result' }] });
  });

  it('a pending question record: waiting; an `asked` entry whose record is gone is never waiting or stopped', () => {
    sys('started', 'Run started.', RUN);
    sys('asked', 'Asked: send the note?', LATER);
    expect(session({ isRunActive: idle })).toMatchObject({ status: null, rows: [{ origin: 'note', text: 'Asked: send the note?' }] });
    createQuestion(contextRoot, { slug: 'line-watch', runFiredAt: RUN, kind: 'flow-hitl', question: 'Send the note?', choices: [], sessionId: null, channel: 'chat' });
    expect(session({ isRunActive: idle })).toMatchObject({ status: 'waiting', rows: [{ origin: 'note', text: 'Waiting for your answer' }] });
  });

  it('started on another machine: running until its timeout plus ten minutes, then an honest note', () => {
    const entry = { id: '0mhdzz000_00aaaa', runId: RUN, kind: 'system', event: 'started', at: RUN, text: 'Run started.', via: 'runner' };
    const dir = threadSlugDir(contextRoot, 'line-watch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-10-30-abcdefabcdef.md'), `${THREAD_ENTRY_MARKER}\n\`\`\`json\n${JSON.stringify(entry)}\n\`\`\`\n`);
    const at = (min: number) => new Date(Date.parse(RUN) + min * 60_000);
    expect(session({ isRunActive: idle, now: at(14) })).toMatchObject({ status: 'running', elsewhere: true });
    expect(session({ isRunActive: idle, now: at(16) })).toMatchObject({ status: null, elsewhere: true, rows: [{ origin: 'note', text: 'Run started.' }] });
  });

  it('a run that ended ok and still owes a verdict waits; a failed one stays failed', () => {
    sys('started', 'Run started.', RUN);
    sys('ok', 'Finished.', LATER);
    createQuestion(contextRoot, { slug: 'line-watch', runFiredAt: RUN, kind: 'flow-hitl', channel: 'chat', question: 'Keep it?', choices: [], sessionId: null });
    expect(session({ isRunActive: idle })).toMatchObject({ status: 'waiting', rows: [{ origin: 'note', text: 'Waiting for your answer' }] });
    const other = '2026-10-30T10:00:00.000Z';
    sys('failed', 'Failed: no quota.', '2026-10-30T10:00:01.000Z', {}, other);
    createQuestion(contextRoot, { slug: 'line-watch', runFiredAt: other, kind: 'flow-hitl', channel: 'chat', question: 'Q?', choices: [], sessionId: null });
    expect(session({ isRunActive: idle }).status).toBe('failed');
  });

  it('a reply into a finished silent run: the run\'s line stays above the owner\'s words, and a live turn reads running', () => {
    sys('started', 'Run started.', RUN);
    sys('ok', 'Finished.', LATER, { result: 'Old answer line.' });
    appendThreadEntry(contextRoot, 'line-watch', { runId: RUN, kind: 'user', text: 'Why?', via: 'dashboard', now: new Date('2026-10-30T09:05:00.000Z') });
    const live = session({ isRunActive: () => true });
    expect(live.status).toBe('running');
    expect(live.rows.map((r) => r.text)).toEqual(['Old answer line.', 'Why?']);
    expect(session({ isRunActive: idle }).status).toBe('ok');
  });

  it('a run waiting on a verdict keeps its result on screen', () => {
    sys('started', 'Run started.', RUN);
    sys('ok', 'Finished.', LATER, { result: 'Proposal: drop the night run.' });
    createQuestion(contextRoot, { slug: 'line-watch', runFiredAt: RUN, kind: 'flow-hitl', channel: 'chat', question: 'Keep it?', choices: [], sessionId: null });
    expect(session({ isRunActive: idle })).toMatchObject({ status: 'waiting', rows: [{ origin: 'answer', text: 'Proposal: drop the night run.' }] });
  });

  it('a reply into a failed run works while live, and keeps the reason; a closed turn or a nameless activity does not', () => {
    sys('started', 'Run started.', RUN);
    sys('failed', 'Failed: no quota.', LATER);
    expect(session({ isRunActive: () => true }).status).toBe('failed');
    appendThreadEntry(contextRoot, 'line-watch', { runId: RUN, kind: 'user', text: 'Try again?', via: 'dashboard', now: new Date('2026-10-30T09:05:00.000Z') });
    const live = session({ isRunActive: () => true });
    expect(live.status).toBe('running');
    expect(live.rows.map((r) => r.text)).toEqual(['Failed: no quota.', 'Try again?']);
    expect(session({ isRunActive: idle }).status).toBe('failed');
    sys('replied', 'Replied.', '2026-10-30T09:06:00.000Z');
    expect(session({ isRunActive: () => true }).status).toBe('failed');
  });

  it('a question answered after the end: the resumed turn reads running while a turn names this run, ok after', () => {
    sys('started', 'Run started.', RUN);
    sys('ok', 'Finished.', LATER, { result: 'The line.' });
    const held = session({ isRunActive: () => true, isRunHeld: (_s, id) => id === RUN });
    expect(held).toMatchObject({ status: 'running', rows: [{ origin: 'answer', text: 'The line.' }] });
    expect(session({ isRunActive: () => true, isRunHeld: () => false }).status).toBe('ok');
    sys('replied', 'Question answered via chat. Session resumed.', '2026-10-30T09:05:00.000Z');
    expect(session({ isRunActive: () => true, isRunHeld: () => false }).status).toBe('ok');
  });

  it('a reply answered after the end leaves the run its own sentence, above the reply', () => {
    appendThreadEntry(contextRoot, 'line-watch', { runId: RUN, kind: 'system', event: 'started', text: 'Run started.', via: 'runner' });
    appendThreadEntry(contextRoot, 'line-watch', { runId: RUN, kind: 'system', event: 'ok', text: 'Finished.', via: 'runner', result: 'Acme is healthy.' });
    appendThreadEntry(contextRoot, 'line-watch', { runId: RUN, kind: 'user', text: 'Look again.', via: 'dashboard' });
    appendThreadEntry(contextRoot, 'line-watch', { runId: RUN, kind: 'agent', text: 'Still healthy.', via: 'runner' });
    expect(session().rows.map((r) => r.text)).toEqual(['Acme is healthy.', 'Look again.', 'Still healthy.']);
  });

  it('a routine note after the end reopens nothing, even with a turn that names no run', () => {
    sys('started', 'Run started.', RUN);
    sys('ok', 'Finished.', LATER);
    sys('routine', 'Routine created.', '2026-10-30T09:05:00.000Z');
    expect(session({ isRunActive: () => true, isRunHeld: () => false }).status).toBe('ok');
  });

  it('a fire with two cache rows reads the newest: the first boundary\'s duration is the real one', () => {
    sys('started', 'Run started.', RUN);
    sys('ok', 'Finished.', LATER);
    recordRun(contextRoot, 'line-watch', row({ status: 'deferred' as RunEvent['status'], durationMs: 0 }));
    recordRun(contextRoot, 'line-watch', row({ durationMs: 76_000 }));
    expect(session().durationMs).toBe(76_000);
  });
});

describe('the terminal entry carries the published line', () => {
  it('survives the store, capped on the way in, refused over the cap and on a post', () => {
    const e = sys('ok', 'Finished.', LATER, { result: 'a line' });
    expect(readThread(contextRoot, 'line-watch')[0]).toMatchObject({ id: e.id, result: 'a line' });
    expect(() => sys('ok', 'x', LATER, { result: 'y'.repeat(241) })).toThrow(/at most 240/);
    expect(() => appendThreadEntry(contextRoot, 'line-watch', { runId: RUN, kind: 'agent', text: 'x', via: 'cli', result: 'y' })).toThrow(/system entry/);
    const synced = { id: '000000001_00aaaa', runId: RUN, kind: 'system', event: 'ok', at: RUN, text: '', via: 'runner', result: 'z'.repeat(999) };
    const [back] = parseDayFile(`${THREAD_ENTRY_MARKER}\n\`\`\`json\n${JSON.stringify(synced)}\n\`\`\`\n`);
    expect(back.result).toHaveLength(240);
  });

  it('the runner writes it only for a document that published', async () => {
    const manifest = createAutomation(contextRoot, { slug: 'digest', title: 'Digest', days: 'daily', at: '18:00', prompt: 'Say hello.' });
    approveAutomation(projectRoot, manifest, NOW, home);
    const child = Object.assign(new EventEmitter(), { pid: 7, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => {} });
    const done = runAutomation(contextRoot, 'digest', { now: () => NOW, home, spawnImpl: vi.fn(() => child) as unknown as SpawnImpl, killImpl: vi.fn(), notify: () => {} });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ session_id: 's', result: '# Digest\n\nWAU is down 4%.\n', is_error: false, permission_denials: [], subtype: 'success' })));
    child.emit('close', 0);
    await done;
    expect(readThread(contextRoot, 'digest').find((e) => e.event === 'ok')?.result).toBe('WAU is down 4%.');
  });
});

describe('a run whose runner is gone', () => {
  it('counts as alive while its child lives, and not once it is gone', () => {
    const side = { slug: 'line-watch', runnerPid: 999_999, childPid: process.pid, fireAt: RUN, startedAt: RUN, timeoutAt: LATER };
    writeRunSidecar(contextRoot, 'line-watch', { ...side, childPgid: process.pid } as never);
    expect(runChildAlive(contextRoot, 'line-watch', RUN)).toBe(true);
    expect(runChildAlive(contextRoot, 'line-watch', 'another-run')).toBe(false);
    writeRunSidecar(contextRoot, 'line-watch', { ...side, childPgid: 999_999 } as never);
    expect(runChildAlive(contextRoot, 'line-watch', RUN)).toBe(false);
  });
});

describe('readRunHead', () => {
  it('reads the head only, refuses a symlink, and sees a changed file', () => {
    const path = doc(`Opening line.\n\n${'x'.repeat(40_000)}`);
    expect(readRunHead(contextRoot, row({ outputPath: path }))).toBe('Opening line.');
    writeFileSync(path, 'A new line, longer.\n');
    expect(readRunHead(contextRoot, row({ outputPath: path }))).toBe('A new line, longer.');
    const link = join(contextRoot, 'automations', 'output', 'line-watch', 'link.md');
    symlinkSync(join(home, 'nope.md'), link);
    expect(readRunHead(contextRoot, row({ outputPath: link }))).toBeNull();
    expect(readRunHead(contextRoot, null)).toBeNull();
  });
});

describe('K3: a healthy run of a quiet routine raises no "new"', () => {
  const quietRoutine = () => createAutomation(contextRoot, { slug: 'quiet-watch', title: 'Quiet watch', agent: 'herodot', days: 'daily', at: '10:00', notify: false }, { approve: { now: NOW, home } });
  const put = (slug: string, event: ThreadEntry['event'], text: string, at: string) =>
    appendThreadEntry(contextRoot, slug, { runId: RUN, kind: 'system', event, text, via: 'runner', now: new Date(at) });

  it('counts nothing on all three counters; the row stays', () => {
    quietRoutine();
    put('quiet-watch', 'started', 'Run started.', RUN);
    put('quiet-watch', 'ok', 'Finished.', LATER);
    const p = page();
    expect(p.unreadCount).toBe(0);
    expect(p.sessions[0]).toMatchObject({ unread: false, rows: [{ origin: 'note' }] });
    expect(threadUnread(contextRoot, 'quiet-watch', home).count).toBe(0);
    const feed = buildFeed(contextRoot, { home, now: NOW });
    expect(feed.unreadTotal).toBe(0);
    expect(feed.messages.find((m) => m.slug === 'quiet-watch')?.unread).toBe(false);
  });

  it('a failure, an owner\'s word, a post and a question still count; a routine that notifies counts', () => {
    quietRoutine();
    put('quiet-watch', 'started', 'Run started.', RUN);
    put('quiet-watch', 'failed', 'Failed.', LATER);
    expect(page().unreadCount).toBe(1);

    const quiet = ownerQuietReader(contextRoot);
    const base = { id: 'a', runId: RUN, at: RUN, text: '', via: 'runner' as const };
    const okEntry: ThreadEntry = { ...base, id: 'b', kind: 'system', event: 'ok' };
    const run = (extra: ThreadEntry) => [okEntry, extra];
    expect(quiet('quiet-watch', [okEntry]).size).toBe(1);
    expect(quiet('quiet-watch', run({ ...base, kind: 'user', via: 'dashboard' })).size).toBe(0);
    expect(quiet('quiet-watch', run({ ...base, kind: 'agent' })).size).toBe(0);
    expect(quiet('quiet-watch', run({ ...base, kind: 'system', event: 'asked' })).size).toBe(0);
    expect(quiet('line-watch', [okEntry]).size).toBe(0);
    createQuestion(contextRoot, { slug: 'quiet-watch', runFiredAt: RUN, kind: 'flow-hitl', question: 'Q?', choices: [], sessionId: null, channel: 'chat' });
    expect(ownerQuietReader(contextRoot)('quiet-watch', [okEntry]).size).toBe(0);
  });

  it('never reaches the reader the banner reads', () => {
    quietRoutine();
    const ok: ThreadEntry = { id: 'b', runId: RUN, at: RUN, text: '', via: 'runner', kind: 'system', event: 'ok' };
    expect(superQuietReader(contextRoot)('quiet-watch', [ok]).size).toBe(0);
  });
});
