import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A job the Super Agent gave an AI Team member reports to the Super, not to the owner (owner
 * 2026-10-31): no unread anywhere, no banner. What the owner must still hear stays: his own
 * talk with the member, scheduled runs, a question, a failure, and all of it when the mode is off.
 */

const notifyViaBundle = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../src/lib/automations/notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/automations/notifier.js')>()),
  notifyViaBundle,
}));

const { announceTurn, appendThreadEntry, threadUnread, markThreadRead, readThread } = await import('../../src/lib/automations/threads.js');
const { buildFeed } = await import('../../src/lib/automations/feed.js');
const { createAutomation } = await import('../../src/lib/automations/store.js');
const { createQuestion } = await import('../../src/lib/automations/hitl.js');
const { listAgentHistory } = await import('../../src/lib/agents/history.js');
const { superRunQuiet } = await import('../../src/lib/automations/super-quiet.js');
const { SUPER_STATE_REL } = await import('../../src/lib/super/store.js');
const { runAutomation } = await import('../../src/lib/automations/runner.js');
const { approveAutomation } = await import('../../src/lib/automations/registry.js');

const RUN = '2026-10-31T06:30:00.000Z';
const slug = 'desk';
let projectRoot: string;
let contextRoot: string;
let home: string;

function project(name: string, enabled: boolean): string {
  const root = join(projectRoot, name, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ enabled, session: 'sup-1' }));
  createAutomation(root, { slug, title: 'Desk', days: 'daily', at: '09:30', prompt: 'go' });
  return root;
}

const say = (root: string, kind: 'user' | 'agent', via: 'super' | 'dashboard' | 'cli', text: string, runId = RUN) =>
  appendThreadEntry(root, slug, { runId, kind, via, text });
const sys = (root: string, event: 'started' | 'ok' | 'failed' | 'timeout', runId = RUN) =>
  appendThreadEntry(root, slug, { runId, kind: 'system', event, text: event, via: 'runner' });

function superJob(root: string) {
  say(root, 'user', 'super', 'Check the desk');
  sys(root, 'started');
  say(root, 'agent', 'cli', 'Desk is fine');
  sys(root, 'ok');
}

/** Every count the owner's surfaces read, one reading per source. */
function counts(root: string) {
  const feed = buildFeed(root, { home });
  return {
    feed: feed.unreadTotal,
    bySlug: feed.unreadBySlug[slug] ?? 0,
    message: feed.messages.filter((m) => m.unread).length,
    thread: threadUnread(root, slug, home).count,
    history: listAgentHistory(root, slug, { audience: 'owner', home } as Parameters<typeof listAgentHistory>[2]).unreadCount,
  };
}

const ZERO = { feed: 0, bySlug: 0, message: 0, thread: 0, history: 0 };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-quiet-home-'));
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-quiet-')));
  contextRoot = project('acme', true);
  notifyViaBundle.mockReset();
  notifyViaBundle.mockReturnValue(true);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('what a Super job says counts for nobody', () => {
  it('no source counts it, and the answer stays readable in the thread', () => {
    superJob(contextRoot);
    expect(counts(contextRoot)).toEqual(ZERO);
    expect(readThread(contextRoot, slug).some((e) => e.text === 'Desk is fine')).toBe(true);
    expect(buildFeed(contextRoot, { home }).messages[0].newestId).toBeTruthy();
  });

  it('a job already on disk falls out with nothing written (the old pile)', () => {
    superJob(contextRoot);
    const before = readThread(contextRoot, slug).length;
    counts(contextRoot);
    expect(readThread(contextRoot, slug).length).toBe(before);
  });

  it('with the mode off, or no record at all, it counts as before', () => {
    superJob(contextRoot);
    writeFileSync(join(contextRoot, SUPER_STATE_REL), JSON.stringify({ enabled: false }));
    expect(counts(contextRoot).bySlug).toBe(1);
    rmSync(join(contextRoot, SUPER_STATE_REL));
    expect(counts(contextRoot).bySlug).toBe(1);
  });

  it('each project answers for itself', () => {
    const other = project('other', false);
    superJob(contextRoot);
    superJob(other);
    expect(counts(contextRoot).bySlug).toBe(0);
    expect(counts(other).bySlug).toBe(1);
  });
});

describe('what the owner must still hear', () => {
  it('a scheduled run and his own talk with the member', () => {
    sys(contextRoot, 'started');
    say(contextRoot, 'agent', 'cli', 'Morning digest');
    sys(contextRoot, 'ok');
    expect(counts(contextRoot).bySlug).toBe(1);
    const mine = '2026-10-31T07:00:00.000Z';
    say(contextRoot, 'user', 'dashboard', 'How is it?', mine);
    say(contextRoot, 'agent', 'cli', 'Good', mine);
    expect(counts(contextRoot).bySlug).toBe(2);
  });

  it('the owner writing into a Super job takes what follows back', () => {
    superJob(contextRoot);
    say(contextRoot, 'user', 'dashboard', 'And the rest?');
    say(contextRoot, 'agent', 'cli', 'Here it is');
    expect(counts(contextRoot).bySlug).toBe(1);
  });

  it('a question of a Super job waits on him, whole', () => {
    superJob(contextRoot);
    createQuestion(contextRoot, { slug, runFiredAt: RUN, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Publish?', choices: [] });
    const feed = buildFeed(contextRoot, { home });
    expect(feed.unreadBySlug[slug]).toBe(1);
    expect(feed.messages[0].unread).toBe(true);
    expect(feed.messages[0].needsYou).toBe(true);
    expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
  });

  it.each(['failed', 'timeout'] as const)('a Super job that ended %s never vanishes', (event) => {
    say(contextRoot, 'user', 'super', 'Check the desk');
    sys(contextRoot, 'started');
    sys(contextRoot, event);
    const c = counts(contextRoot);
    expect(c).toMatchObject({ bySlug: 1, message: 1, thread: 1 });
  });

  it('seen once, a loud run stays seen', () => {
    say(contextRoot, 'user', 'super', 'Check');
    const end = sys(contextRoot, 'failed');
    markThreadRead(contextRoot, slug, end.id, home);
    expect(counts(contextRoot).bySlug).toBe(0);
  });
});

describe('banners', () => {
  it('a reply of a Super job posts none, a question it asks does', () => {
    const ask = say(contextRoot, 'user', 'super', 'Check the desk');
    say(contextRoot, 'agent', 'cli', 'Desk is fine');
    expect(announceTurn(contextRoot, slug, ask.id, 'fallback', home)).toBe(false);
    appendThreadEntry(contextRoot, slug, { runId: RUN, kind: 'system', event: 'asked', text: 'Publish?', via: 'runner' });
    expect(announceTurn(contextRoot, slug, ask.id, 'fallback', home)).toBe(true);
  });

  it('a Super job that said nothing posts none from its fallback', () => {
    const ask = say(contextRoot, 'user', 'super', 'Check the desk');
    expect(announceTurn(contextRoot, slug, ask.id, 'fallback', home)).toBe(false);
    expect(notifyViaBundle).not.toHaveBeenCalled();
  });

  it('with the mode off, and for the owner\'s own reply, it posts as before', () => {
    const mine = say(contextRoot, 'user', 'dashboard', 'How is it?');
    say(contextRoot, 'agent', 'cli', 'Good');
    expect(announceTurn(contextRoot, slug, mine.id, null, home)).toBe(true);
    const off = project('off', false);
    const ask = say(off, 'user', 'super', 'Check');
    say(off, 'agent', 'cli', 'Fine');
    expect(announceTurn(off, slug, ask.id, null, home)).toBe(true);
  });

  async function fire(status: 'ok' | 'failed', ask: boolean): Promise<ReturnType<typeof vi.fn>> {
    const NOW = new Date(RUN);
    const manifest = createAutomation(contextRoot, { slug: 'runner-job', title: 'Runner job', days: 'daily', at: '18:00', prompt: 'go' });
    approveAutomation(projectRoot + '/acme', manifest, NOW, home);
    if (ask) appendThreadEntry(contextRoot, 'runner-job', { runId: RUN, kind: 'user', via: 'super', text: 'do it', now: NOW });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 77, stdout, stderr, kill: () => {} });
    const notify = vi.fn();
    const run = runAutomation(contextRoot, 'runner-job', {
      now: () => NOW, home, spawnImpl: vi.fn(() => child) as never, killImpl: vi.fn(), notify,
      ...(ask ? { fireAt: NOW } : {}),
    });
    await new Promise((r) => setImmediate(r));
    stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: status !== 'ok', result: 'done', session_id: 's', total_cost_usd: 0, num_turns: 1 })));
    child.emit('close', status === 'ok' ? 0 : 1);
    await run;
    return notify;
  }

  it('the runner\'s completion banner: silent for a clean Super run', async () => {
    expect(await fire('ok', true)).not.toHaveBeenCalled();
  });
  it('the runner\'s completion banner: a failed Super run rings', async () => {
    expect(await fire('failed', true)).toHaveBeenCalled();
  });
  it('the runner\'s completion banner: a scheduled run rings', async () => {
    expect(await fire('ok', false)).toHaveBeenCalled();
  });
});
