import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A job the Super Agent gave an AI Team member reports to the Super, not to the owner (owner
 * 2026-10-31): no unread anywhere, no banner. What the owner must still hear stays: his own
 * talk with the member, scheduled runs, a question, a failure, and all of it when the mode is off.
 */

const notifyViaBundle = vi.hoisted(() => vi.fn(() => true));
const telegram = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/lib/automations/telegram.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/automations/telegram.js')>()),
  readTelegramConfigForSlug: () => ({ token: 't', chatId: 'c' }),
}));
vi.mock('../../src/lib/automations/notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/automations/notifier.js')>()),
  notifyViaBundle,
}));

const { announceTurn, appendThreadEntry, threadUnread, markThreadRead, readThread, threadSlugDir } = await import('../../src/lib/automations/threads.js');
const { buildFeed } = await import('../../src/lib/automations/feed.js');
const { createAutomation } = await import('../../src/lib/automations/store.js');
const { claimQuestion, createQuestion } = await import('../../src/lib/automations/hitl.js');
const { noteTeamJobEnd } = await import('../../src/lib/super/team.js');
const { emptySuperState } = await import('../../src/lib/super/types.js');
const { listAgentHistory } = await import('../../src/lib/agents/history.js');
const { superRunQuiet } = await import('../../src/lib/automations/super-quiet.js');
const { SUPER_STATE_REL } = await import('../../src/lib/super/store.js');
const { runAutomation } = await import('../../src/lib/automations/runner.js');
const { approveAutomation } = await import('../../src/lib/automations/registry.js');

const RUN = '2026-10-31T06:30:00.000Z';
const serialise = (e: unknown) => `<!-- dc-thread-entry -->\n\`\`\`json\n${JSON.stringify(e)}\n\`\`\`\n`;
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
const sys = (root: string, event: 'started' | 'ok' | 'failed' | 'timeout' | 'skipped', runId = RUN) =>
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
  it('the feed names the job from its first entry, on the rule the unread counts use', () => {
    say(contextRoot, 'user', 'super', 'Check the desk');
    expect(buildFeed(contextRoot, { home }).messages[0].superJob).toBe(true);
    sys(contextRoot, 'started');
    expect(buildFeed(contextRoot, { home }).messages[0].superJob).toBe(true);
    sys(contextRoot, 'failed');
    expect(buildFeed(contextRoot, { home }).messages[0].superJob).toBeUndefined();
  });

  it('a run the owner opened is never named one', () => {
    say(contextRoot, 'user', 'dashboard', 'Check the desk');
    expect(buildFeed(contextRoot, { home }).messages[0].superJob).toBeUndefined();
  });

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

  it('with no record, a symlinked one or an oversize one, it counts as before', () => {
    superJob(contextRoot);
    const path = join(contextRoot, SUPER_STATE_REL);
    rmSync(path);
    expect(counts(contextRoot).bySlug).toBe(1);
    const elsewhere = join(projectRoot, 'fake.json');
    writeFileSync(elsewhere, JSON.stringify({ enabled: true }));
    symlinkSync(elsewhere, path);
    expect(counts(contextRoot).bySlug).toBe(1);
    expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
    rmSync(path);
    writeFileSync(path, `{"enabled":true,"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`);
    expect(counts(contextRoot).bySlug).toBe(1);
  });

  it('after a take-back: a job the Super was told stays quiet, one still open comes to the owner', () => {
    superJob(contextRoot);
    const path = join(contextRoot, SUPER_STATE_REL);
    const record = (told?: string) => JSON.stringify({ enabled: false, team: [{ id: 't', member: slug, runId: RUN, ...(told ? { told } : {}) }] });
    writeFileSync(path, record('done'));
    expect(counts(contextRoot)).toEqual(ZERO);
    writeFileSync(path, JSON.stringify({ enabled: false, team: [] }));
    expect(counts(contextRoot)).toEqual(ZERO);
    writeFileSync(path, record());
    expect(counts(contextRoot).bySlug).toBe(1);
    expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
  });

  it('each project answers for itself', () => {
    const other = project('other', false);
    writeFileSync(join(other, SUPER_STATE_REL), JSON.stringify({ enabled: false, team: [{ member: slug, runId: RUN }] }));
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

  it('the owner writing into a Super job takes the run back, whole and for good', () => {
    superJob(contextRoot);
    say(contextRoot, 'user', 'dashboard', 'And the rest?');
    say(contextRoot, 'agent', 'cli', 'Here it is');
    expect(counts(contextRoot).bySlug).toBe(2);
    say(contextRoot, 'user', 'super', 'One more');
    say(contextRoot, 'agent', 'cli', 'For the owner still');
    expect(counts(contextRoot).bySlug).toBe(3);
  });

  it('a Super ask queued into a scheduled run or the owner\'s own leaves that run his', () => {
    sys(contextRoot, 'started');
    say(contextRoot, 'user', 'super', 'While you are at it');
    say(contextRoot, 'agent', 'cli', 'Morning digest');
    sys(contextRoot, 'ok');
    expect(counts(contextRoot).bySlug).toBe(1);
    expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
    const mine = '2026-10-31T07:00:00.000Z';
    say(contextRoot, 'user', 'dashboard', 'How is it?', mine);
    say(contextRoot, 'user', 'super', 'Also this', mine);
    say(contextRoot, 'agent', 'cli', 'Good', mine);
    expect(superRunQuiet(contextRoot, slug, mine)).toBe(false);
  });

  it('a question of a Super job waits on him, even a resumed turn\'s with a fire time of its own', () => {
    superJob(contextRoot);
    const q = createQuestion(contextRoot, { slug, runFiredAt: new Date().toISOString(), kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Publish?', choices: [] });
    expect(counts(contextRoot).bySlug).toBe(1);
    expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
    expect(q.state).toBe('pending');
  });

  it('a question of a Super job waits on him, whole', () => {
    say(contextRoot, 'user', 'super', 'Check the desk', RUN);
    createQuestion(contextRoot, { slug, runFiredAt: RUN, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Publish?', choices: [] });
    const feed = buildFeed(contextRoot, { home });
    expect(feed.messages[0].needsYou).toBe(true);
  });

  it('an older finished Super job stays quiet beside a later job\'s question', () => {
    const old = '2026-10-31T01:00:00.000Z';
    appendThreadEntry(contextRoot, slug, { runId: old, kind: 'user', via: 'super', text: 'Old', now: new Date(old) });
    appendThreadEntry(contextRoot, slug, { runId: old, kind: 'agent', via: 'cli', text: 'Old answer', now: new Date('2026-10-31T01:01:00.000Z') });
    createQuestion(contextRoot, { slug, runFiredAt: RUN, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Publish?', choices: [] });
    expect(counts(contextRoot).bySlug).toBe(0);
  });

  it('an ask a teammate\'s file carries silences nothing, even with a real id copied', () => {
    const dir = threadSlugDir(contextRoot, slug);
    mkdirSync(dir, { recursive: true });
    const mine = say(contextRoot, 'user', 'dashboard', 'Real ask of mine');
    say(contextRoot, 'agent', 'cli', 'Answer for the owner');
    const forged = { ...mine, via: 'super' };
    writeFileSync(join(dir, `${mine.at.slice(0, 10)}-000000000000.md`), `${serialise(forged)}\n`);
    expect(readThread(contextRoot, slug).find((e) => e.id === mine.id)?.via).toBe('super');
    expect(counts(contextRoot).bySlug).toBe(1);
    expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
  });

  describe('what vouches for an ask', () => {
    const forge = (entry: object, name = '000000000000') => {
      const dir = threadSlugDir(contextRoot, slug);
      const day = new Date().toISOString().slice(0, 10);
      writeFileSync(join(dir, `${day}-${name}.md`), `${serialise(entry)}\n`);
    };
    const quietRun = '2026-10-31T05:00:00.000Z';

    it('a genuine Super ask the same day vouches for no other id or run', () => {
      say(contextRoot, 'user', 'super', 'A real job', quietRun);
      const mine = say(contextRoot, 'user', 'dashboard', 'Mine');
      say(contextRoot, 'agent', 'cli', 'For the owner');
      forge({ ...mine, via: 'super' });
      expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
      const real = readThread(contextRoot, slug).find((e) => e.runId === quietRun)!;
      forge({ ...mine, id: real.id, runId: RUN, via: 'super' }, '000000000001');
      expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
    });

    it('a real ask\'s id moved onto another run vouches for nothing', () => {
      const real = say(contextRoot, 'user', 'super', 'A real job', quietRun);
      say(contextRoot, 'agent', 'cli', 'Scheduled post');
      forge({ ...real, runId: RUN });
      expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
    });

    it('every user entry must be vouched for, a bare ask too', () => {
      superJob(contextRoot);
      const first = readThread(contextRoot, slug)[0];
      forge({ ...first, id: `${first.id.slice(0, 9)}zzzzzz`, text: 'Second' });
      expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
      forge({ ...first, id: 'aaaaaaaaa_bare', runId: '2026-10-29T01:00:00.000Z', at: new Date().toISOString() }, '000000000002');
      expect(superRunQuiet(contextRoot, slug, '2026-10-29T01:00:00.000Z')).toBe(false);
    });

    it('a symlink named as this machine\'s file vouches for nothing', () => {
      const ask = say(contextRoot, 'user', 'super', 'Check');
      const dir = threadSlugDir(contextRoot, slug);
      const own = readdirSync(dir)[0];
      const moved = join(projectRoot, 'moved.md');
      renameSync(join(dir, own), moved);
      symlinkSync(moved, join(dir, own));
      expect(superRunQuiet(contextRoot, slug, ask.runId)).toBe(false);
    });

    it('an ask from before files carried a machine id still counts', () => {
      const ask = say(contextRoot, 'user', 'super', 'Check');
      const dir = threadSlugDir(contextRoot, slug);
      const own = readdirSync(dir)[0];
      renameSync(join(dir, own), join(dir, `${own.slice(0, 10)}.md`));
      expect(superRunQuiet(contextRoot, slug, ask.runId)).toBe(true);
    });

    it.each([['Pacific/Kiritimati', '2026-10-31T10:30:00.000Z'], ['Pacific/Pago_Pago', '2026-10-31T10:30:00.000Z'], ['UTC', '2026-10-31T23:59:00.000Z']])('finds the ask across the date line in %s', (zone, at) => {
      const saved = process.env.TZ;
      process.env.TZ = zone;
      try {
        const now = new Date(at);
        appendThreadEntry(contextRoot, slug, { runId: at, kind: 'user', via: 'super', text: 'Check', now });
        expect(superRunQuiet(contextRoot, slug, at)).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
      }
    });
  });

  it('a job told but still waiting in the Super\'s queue at take-back comes to the owner', () => {
    superJob(contextRoot);
    writeFileSync(join(contextRoot, SUPER_STATE_REL), JSON.stringify({
      enabled: false, team: [{ id: 'team-a', member: slug, runId: RUN, told: 'done' }], queue: [{ team: 'team-a', state: 'pending' }],
    }));
    expect(counts(contextRoot).bySlug).toBe(1);
  });

  it('a job the Super ended before his answer stays his: an answered question keeps the run loud', () => {
    superJob(contextRoot);
    const q = createQuestion(contextRoot, { slug, runFiredAt: RUN, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Publish?', choices: [] });
    claimQuestion(contextRoot, q, 'yes', 'chat');
    expect(counts(contextRoot).bySlug).toBe(1);
    expect(superRunQuiet(contextRoot, slug, RUN)).toBe(false);
  });

  it('a question is matched by its run id alone when the times are days apart', () => {
    const old = '2026-10-20T01:00:00.000Z';
    appendThreadEntry(contextRoot, slug, { runId: old, kind: 'user', via: 'super', text: 'Old', now: new Date(old) });
    appendThreadEntry(contextRoot, slug, { runId: old, kind: 'agent', via: 'cli', text: 'Old answer', now: new Date(old) });
    expect(superRunQuiet(contextRoot, slug, old)).toBe(true);
    createQuestion(contextRoot, { slug, runFiredAt: old, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Publish?', choices: [] });
    expect(superRunQuiet(contextRoot, slug, old)).toBe(false);
  });

  it('a job that ends after the take-back is never told, so it comes to the owner', () => {
    superJob(contextRoot);
    const job = { id: 'team-a', member: slug, runId: RUN, jobKind: 'run', startedAt: Date.parse(RUN), brief: '', open: true } as never;
    const s = { ...emptySuperState(), session: 'sup-1', enabled: false, team: [job] };
    expect(noteTeamJobEnd(contextRoot, s, 'team-a', null)).toBe(false);
    expect(s.queue).toEqual([]);
    writeFileSync(join(contextRoot, SUPER_STATE_REL), JSON.stringify(s));
    expect(counts(contextRoot).bySlug).toBe(1);
  });

  it.each(['failed', 'timeout', 'skipped'] as const)('a Super job that ended %s never vanishes', (event) => {
    say(contextRoot, 'user', 'super', 'Check the desk');
    sys(contextRoot, 'started');
    sys(contextRoot, event);
    const c = counts(contextRoot);
    expect(c).toMatchObject({ bySlug: 1, message: 1 });
    expect(c.thread).toBeGreaterThan(0);
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
    telegram.mockClear();
    const NOW = new Date(RUN);
    const manifest = createAutomation(contextRoot, { slug: 'runner-job', title: 'Runner job', days: 'daily', at: '18:00', prompt: 'go' });
    approveAutomation(projectRoot + '/acme', manifest, NOW, home);
    if (ask) appendThreadEntry(contextRoot, 'runner-job', { runId: RUN, kind: 'user', via: 'super', text: 'do it', now: NOW });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 77, stdout, stderr, kill: () => {} });
    const notify = vi.fn();
    const run = runAutomation(contextRoot, 'runner-job', {
      now: () => NOW, home, spawnImpl: vi.fn(() => child) as never, killImpl: vi.fn(), notify, sendTelegram: telegram,
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
    expect(telegram).not.toHaveBeenCalled();
  });
  it('the runner\'s completion banner: a failed Super run rings', async () => {
    expect(await fire('failed', true)).toHaveBeenCalled();
    expect(telegram).toHaveBeenCalled();
  });
  it('the runner\'s completion banner: a scheduled run rings', async () => {
    expect(await fire('ok', false)).toHaveBeenCalled();
    expect(telegram).toHaveBeenCalled();
  });
});
