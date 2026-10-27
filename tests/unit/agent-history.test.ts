/**
 * AI Team history, wave 1: the reader behind an agent's one continuous pane
 * (lib/agents/history.ts, lib/agents/talks.ts, the session index in lib/local-store.ts,
 * `dreamcontext agents history`, and the new conversation's briefing).
 *
 * Fictional project and agents only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const here = vi.hoisted(() => ({ fn: null as null | ((slug: string) => Set<string> | null) }));
vi.mock('../../src/lib/agents/agent-sync.js', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/agents/agent-sync.js')>();
  return {
    ...actual,
    threadEntriesHere: (c: string, s: string, h?: string) => (here.fn ? here.fn(s) : actual.threadEntriesHere(c, s, h)),
  };
});

import { createAgent } from '../../src/lib/agents/store.js';
import { createAutomation, setAutomationShared } from '../../src/lib/automations/store.js';
import { buildFeed } from '../../src/lib/automations/feed.js';
import { markThreadRead, newThreadEntryId, threadSlugDir } from '../../src/lib/automations/threads.js';
import { THREAD_ENTRY_MARKER, type ThreadEntry } from '../../src/lib/automations/types.js';
import {
  agentConversationSlugs, historyStats, listAgentHistory, resetHistoryStats, searchAgentHistory,
  type HistorySession,
} from '../../src/lib/agents/history.js';
import { resetTalkStats, talkStats, TALK_MAX_ROWS } from '../../src/lib/agents/talks.js';
import {
  forgetAgentLocal, listAgentSessions, markSessionHadTurns, recordAgentSession, renameAgentStage,
} from '../../src/lib/local-store.js';
import { buildRecentHistoryBlock } from '../../src/lib/automations/history.js';
import { agentRecentBlock, prepareAgentChat } from '../../src/lib/whiteboards/card-chat.js';
import { createProgram } from '../../src/cli/program.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;
let cwd: string;
const NOW = new Date('2026-10-27T12:00:00.000Z');
const OTHER_MACHINE = 'abcdefabcdef';

beforeEach(() => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hist-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hist-home-')));
  realHome = process.env.HOME;
  process.env.HOME = home;
  here.fn = null;
  resetHistoryStats();
  resetTalkStats();
});

afterEach(() => {
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ─── fixture helpers ──────────────────────────────────────────────────────────────

function makeAgent(slug = 'herodot') {
  createAgent(contextRoot, { slug, title: 'Herodot', prompt: `${slug} summarises the fictional Acme channel.`, learning: false }, { approve: { now: NOW, home } });
}
function routine(slug: string, title: string) {
  createAutomation(contextRoot, { slug, title, agent: 'herodot', days: 'daily', at: '09:00' }, { approve: { now: NOW, home } });
}

let seq = 0;
/** Append one entry to `<day>-<machine>.md` (the day is the WRITER's local date, so a file can
 *  hold an `at` from another UTC day). Returns the entry. */
function put(slug: string, day: string, e: Omit<ThreadEntry, 'id' | 'via'> & { id?: string }, machine = 'aaaaaaaaaaaa'): ThreadEntry {
  const id = e.id ?? newThreadEntryId(Date.parse(e.at) + (seq++ % 7));
  const entry: ThreadEntry = { ...e, id, via: 'runner' } as ThreadEntry;
  const dir = threadSlugDir(contextRoot, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${day}-${machine}.md`);
  const prev = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  writeFileSync(path, `${prev}${THREAD_ENTRY_MARKER}\n\`\`\`json\n${JSON.stringify(entry)}\n\`\`\`\n\n`);
  return entry;
}
const dayOf = (iso: string) => iso.slice(0, 10);
/** A whole run: started, a post, ok. */
function run(slug: string, firedAt: string, postAt: string, text = `post ${slug} ${firedAt}`): ThreadEntry[] {
  return [
    put(slug, dayOf(firedAt), { runId: firedAt, kind: 'system', event: 'started', at: firedAt, text: '' }),
    put(slug, dayOf(postAt), { runId: firedAt, kind: 'agent', at: postAt, text }),
    put(slug, dayOf(postAt), { runId: firedAt, kind: 'system', event: 'ok', at: postAt, text: '' }),
  ];
}

function talk(id: string, startedAt: string, lastAt: string, lines: Array<['user' | 'text' | 'tool', string]>, hadTurns = true) {
  recordAgentSession(projectRoot, 'herodot', id, 'stage', home, new Date(startedAt));
  if (hadTurns) markSessionHadTurns(projectRoot, 'herodot', [id], home);
  const dir = join(home, '.claude', 'projects', '-tmp-fictional-acme');
  mkdirSync(dir, { recursive: true });
  const t0 = Date.parse(startedAt);
  const rows = lines.map(([k, text], i) => {
    const ts = new Date(t0 + i * 1000).toISOString();
    if (k === 'user') return JSON.stringify({ type: 'user', uuid: `${id}-u${i}`, timestamp: ts, message: { content: text } });
    if (k === 'text') return JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });
    return JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: `tu-${id}-${i}`, name: 'Bash', input: { command: text } }] } });
  });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, rows.join('\n') + '\n');
  const m = new Date(lastAt);
  utimesSync(path, m, m);
  return path;
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Every session, walking `nextBefore` to null. */
function walk(opts: Partial<Parameters<typeof listAgentHistory>[2]> = {}): HistorySession[] {
  const out: HistorySession[] = [];
  let before: string | null = null;
  for (let i = 0; i < 200; i++) {
    const page = listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home, before, ...opts });
    out.push(...page.sessions);
    if (!page.nextBefore) return out;
    before = page.nextBefore;
  }
  throw new Error('no end');
}

/** The big fixture of AC1. Returns the expected (lastAt desc, key desc) keys. */
function bigFixture(): { expected: string[]; runs: number } {
  makeAgent();
  routine('daily-sum', 'Herodot daily');
  routine('weekly-look', 'Weekly look');
  routine('team-digest', 'Team digest');
  setAutomationShared(contextRoot, 'team-digest', true);
  const last = new Map<string, number>();
  const note = (key: string, at: string) => last.set(key, Math.max(last.get(key) ?? -Infinity, Date.parse(at)));
  let runs = 0;
  // 30 runs over 20 days across the three routines.
  for (let d = 0; d < 20; d++) {
    const day = new Date(Date.UTC(2026, 9, 7 + d, 9, 0, 0));
    const fired = day.toISOString();
    const post = new Date(day.getTime() + 120_000).toISOString();
    run('daily-sum', fired, post); note(`daily-sum::${fired}`, post); runs++;
    if (d % 2 === 0) {
      const f2 = new Date(day.getTime() + 3_600_000).toISOString();
      const p2 = new Date(day.getTime() + 3_660_000).toISOString();
      run(d % 4 === 0 ? 'weekly-look' : 'team-digest', f2, p2);
      note(`${d % 4 === 0 ? 'weekly-look' : 'team-digest'}::${f2}`, p2); runs++;
    }
  }
  // A reply 3 days after its run moves that run down to where the reply happened.
  const oldRun = new Date(Date.UTC(2026, 9, 10, 9, 0, 0)).toISOString();
  const replyAt = new Date(Date.UTC(2026, 9, 13, 15, 0, 0)).toISOString();
  put('daily-sum', dayOf(replyAt), { runId: oldRun, kind: 'user', at: replyAt, text: 'why so short?' });
  const replyPost = new Date(Date.parse(replyAt) + 30_000).toISOString();
  put('daily-sum', dayOf(replyAt), { runId: oldRun, kind: 'agent', at: replyPost, text: 'Quiet day.' });
  note(`daily-sum::${oldRun}`, replyPost);
  // A catch-up run: an old firedAt, entries written today.
  const catchFired = new Date(Date.UTC(2026, 9, 1, 9, 0, 0)).toISOString();
  const catchAt = new Date(Date.UTC(2026, 9, 26, 7, 0, 0)).toISOString();
  run('weekly-look', catchFired, catchAt);
  // its started entry is written at catch-up time too
  note(`weekly-look::${catchFired}`, catchAt); note(`weekly-look::${catchFired}`, catchFired); runs++;
  // Two routines with the SAME firedAt and the same last instant.
  const twin = new Date(Date.UTC(2026, 9, 18, 6, 0, 0)).toISOString();
  const twinPost = new Date(Date.UTC(2026, 9, 18, 6, 1, 0)).toISOString();
  for (const s of ['daily-sum', 'weekly-look']) {
    put(s, dayOf(twin), { runId: twin, kind: 'agent', at: twinPost, text: `twin ${s}` });
    note(`${s}::${twin}`, twinPost); runs++;
  }
  // A run crossing midnight: started in one day file, posted in the next.
  const lateFired = new Date(Date.UTC(2026, 9, 21, 23, 58, 0)).toISOString();
  const latePost = new Date(Date.UTC(2026, 9, 22, 0, 3, 0)).toISOString();
  run('daily-sum', lateFired, latePost); note(`daily-sum::${lateFired}`, latePost); runs++;
  // A day file written by another machine in another timezone: named 2026-10-24 (its local day)
  // with an instant of the 25th UTC.
  const tzFired = new Date(Date.UTC(2026, 9, 25, 2, 0, 0)).toISOString();
  put('daily-sum', '2026-10-24', { runId: tzFired, kind: 'agent', at: tzFired, text: 'from the other mac' }, OTHER_MACHINE);
  note(`daily-sum::${tzFired}`, tzFired); runs++;
  // Three talks.
  talk(uuid(1), '2026-10-20T13:05:00.000Z', '2026-10-20T13:20:00.000Z', [['user', 'Who proposed the leaderboard?'], ['text', 'Deniz, on the 21st.']]);
  talk(uuid(2), '2026-10-12T08:00:00.000Z', '2026-10-12T08:10:00.000Z', [['user', 'Add it to the roadmap'], ['text', 'Done.']]);
  talk(uuid(3), '2026-10-26T18:42:00.000Z', '2026-10-26T18:50:00.000Z', [['user', 'One more thing'], ['text', 'Sure.']]);
  for (const [id, at] of [[uuid(1), '2026-10-20T13:20:00.000Z'], [uuid(2), '2026-10-12T08:10:00.000Z'], [uuid(3), '2026-10-26T18:50:00.000Z']]) {
    note(`talk::${id}`, at);
  }
  const expected = [...last.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([k]) => k);
  return { expected, runs };
}

// ─── AC1: paging walks every session once, in order ─────────────────────────────────

describe('AC1 paging', () => {
  it('walking nextBefore returns every session exactly once, in (lastAt desc, key desc), rows oldest-first', () => {
    const { expected, runs } = bigFixture();
    expect(runs).toBeGreaterThanOrEqual(30);
    for (const maxSessions of [1, 3, 8]) {
      const got = walk({ maxSessions });
      expect(got.map((s) => s.key)).toEqual(expected);
      for (const s of got) {
        const ats = s.rows.map((r) => Date.parse(r.at));
        expect([...ats].sort((a, b) => a - b)).toEqual(ats);
      }
    }
    const replied = walk().find((s) => s.key === `daily-sum::${new Date(Date.UTC(2026, 9, 10, 9, 0, 0)).toISOString()}`)!;
    expect(replied.rows.map((r) => r.text)).toEqual([`post daily-sum ${new Date(Date.UTC(2026, 9, 10, 9, 0, 0)).toISOString()}`, 'why so short?', 'Quiet day.']);
    expect(replied.rows.map((r) => r.kind)).toEqual(['agent', 'user', 'agent']);
    const cross = walk().find((s) => s.key.endsWith('2026-10-21T23:58:00.000Z'))!;
    expect(cross.status).toBe('ok');
    expect(cross.rows).toHaveLength(1);
  });
});

// ─── AC2: costs ─────────────────────────────────────────────────────────────────────

describe('AC2 costs', () => {
  it('page 2 parses no unchanged day file; a deleted day file leaves the cache', () => {
    bigFixture();
    const p1 = listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home });
    expect(historyStats.dayParses).toBeGreaterThan(0);
    resetHistoryStats();
    listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home, before: p1.nextBefore });
    expect(historyStats.dayParses).toBe(0);
    // A deleted day file: its entries are gone from the next read (the cache let it go).
    const dir = threadSlugDir(contextRoot, 'daily-sum');
    const victim = readdirSync(dir).find((n) => n.startsWith('2026-10-08'))!;
    rmSync(join(dir, victim));
    const keys = walk().map((s) => s.key);
    expect(keys).not.toContain(`daily-sum::${new Date(Date.UTC(2026, 9, 8, 9, 0, 0)).toISOString()}`);
    expect(historyStats.dayParses).toBe(0);
  });

  it('with 40 talks, page 2 parses at most its own talks and lists the projects dir at most once', () => {
    makeAgent();
    for (let i = 0; i < 40; i++) {
      const at = new Date(Date.UTC(2026, 9, 1, 8, i, 0)).toISOString();
      talk(uuid(100 + i), at, at, [['user', `question ${i}`], ['text', `answer ${i}`]]);
    }
    resetTalkStats();
    const p1 = listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home });
    expect(talkStats.projectListings).toBeLessThanOrEqual(1);
    resetTalkStats();
    const p2 = listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home, before: p1.nextBefore });
    expect(p2.sessions.length).toBeGreaterThan(0);
    expect(talkStats.talkParses).toBeLessThanOrEqual(p2.sessions.length);
    expect(talkStats.projectListings).toBeLessThanOrEqual(1);
  });
});

// ─── AC3: unread equals the roster badge ────────────────────────────────────────────

describe('AC3 unread', () => {
  it('unreadCount = the roster badge; each run session agrees with the feed (sched, call-mode, shared, ok, failed post-less)', () => {
    makeAgent();
    routine('daily-sum', 'Herodot daily');
    routine('team-digest', 'Team digest');
    setAutomationShared(contextRoot, 'team-digest', true);
    const r1 = run('daily-sum', '2026-10-25T09:00:00.000Z', '2026-10-25T09:02:00.000Z');
    run('daily-sum', '2026-10-26T09:00:00.000Z', '2026-10-26T09:02:00.000Z');
    // The agent's own CALL target (an agent you only call): its thread is its own slug.
    run('herodot', '2026-10-26T10:00:00.000Z', '2026-10-26T10:01:00.000Z');
    run('team-digest', '2026-10-26T11:00:00.000Z', '2026-10-26T11:01:00.000Z');
    // A failed run with no post.
    put('daily-sum', '2026-10-27', { runId: '2026-10-27T09:00:00.000Z', kind: 'system', event: 'started', at: '2026-10-27T09:00:00.000Z', text: '' });
    put('daily-sum', '2026-10-27', { runId: '2026-10-27T09:00:00.000Z', kind: 'system', event: 'failed', at: '2026-10-27T09:01:00.000Z', text: 'boom' });
    // An old run outside the feed's 14-day window, never read.
    for (let d = 0; d < 16; d++) run('daily-sum', new Date(Date.UTC(2026, 8, 1 + d, 9)).toISOString(), new Date(Date.UTC(2026, 8, 1 + d, 9, 2)).toISOString());
    markThreadRead(contextRoot, 'daily-sum', r1[2].id, home);

    const feed = buildFeed(contextRoot, { home });
    const slugs = agentConversationSlugs(contextRoot, 'herodot');
    expect(new Set(slugs)).toEqual(new Set(['herodot', 'daily-sum', 'team-digest']));
    const badge = slugs.reduce((n, s) => n + (feed.unreadBySlug[s] ?? 0), 0);
    expect(badge).toBeGreaterThan(0);
    const all = walk();
    const page = listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home });
    expect(page.unreadCount).toBe(badge);
    for (const m of feed.messages.filter((x) => slugs.includes(x.slug))) {
      const s = all.find((x) => x.key === m.key)!;
      expect(s, m.key).toBeTruthy();
      expect(s.unread, m.key).toBe(m.unread);
      expect(s.newestId, m.key).toBe(m.newestId);
    }
    const failed = all.find((s) => s.key === 'daily-sum::2026-10-27T09:00:00.000Z')!;
    expect(failed.status).toBe('failed');
    expect(failed.rows).toEqual([]);
    expect(failed.unread).toBe(true);
  });
});

// ─── AC4: the session index ─────────────────────────────────────────────────────────

describe('AC4 the session index', () => {
  it('upserts, skips turnless entries, marks missing, keeps old entries with transcripts, prunes only not-live glances', () => {
    makeAgent();
    recordAgentSession(projectRoot, 'herodot', uuid(1), 'stage', home);
    recordAgentSession(projectRoot, 'herodot', uuid(2), 'chat', home);
    recordAgentSession(projectRoot, 'herodot', uuid(1), 'stage', home); // a respawn
    expect(listAgentSessions(projectRoot, 'herodot', home).map((e) => [e.id, e.kind])).toEqual([[uuid(1), 'stage'], [uuid(2), 'chat']]);

    // uuid(3): 8 days old, transcript, hadTurns false → appears (and gets marked).
    const old = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    talk(uuid(3), old, old, [['user', 'old talk'], ['text', 'ok']], false);
    // uuid(4): had turns, transcript vanished → missing.
    recordAgentSession(projectRoot, 'herodot', uuid(4), 'stage', home);
    markSessionHadTurns(projectRoot, 'herodot', [uuid(4)], home);

    const live = new Set([uuid(2)]);
    const page = listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home, isLive: (id) => live.has(id), markTurns: true });
    const keys = page.sessions.map((s) => s.key);
    expect(keys).not.toContain(`talk::${uuid(1)}`);
    expect(keys).not.toContain(`talk::${uuid(2)}`);
    expect(keys).toContain(`talk::${uuid(3)}`);
    expect(page.sessions.find((s) => s.key === `talk::${uuid(4)}`)!.missing).toBe(true);
    const after = listAgentSessions(projectRoot, 'herodot', home);
    expect(after.map((e) => e.id)).not.toContain(uuid(1)); // confirmed miss, not live → pruned
    expect(after.map((e) => e.id)).toContain(uuid(2)); // live → survives
    expect(after.find((e) => e.id === uuid(3))!.hadTurns).toBe(true);

    // Without isLive (the CLI) nothing is pruned or written.
    recordAgentSession(projectRoot, 'herodot', uuid(5), 'chat', home);
    listAgentHistory(contextRoot, 'herodot', { audience: 'agent', home });
    expect(listAgentSessions(projectRoot, 'herodot', home).map((e) => e.id)).toContain(uuid(5));

    // Rename moves, delete drops; nothing under _dream_context/.
    renameAgentStage(projectRoot, 'herodot', 'herodot-two', home);
    expect(listAgentSessions(projectRoot, 'herodot', home)).toEqual([]);
    expect(listAgentSessions(projectRoot, 'herodot-two', home).length).toBeGreaterThan(0);
    forgetAgentLocal(projectRoot, 'herodot-two', home);
    expect(listAgentSessions(projectRoot, 'herodot-two', home)).toEqual([]);
    const walkDir = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkDir(join(d, e.name)) : [e.name]));
    expect(walkDir(contextRoot).filter((n) => n.includes('agent-sessions'))).toEqual([]);
  });

  it('a corrupt index reads as empty and is rewritten', () => {
    makeAgent();
    recordAgentSession(projectRoot, 'herodot', uuid(1), 'stage', home);
    const dir = join(home, '.dreamcontext', 'local');
    const key = readdirSync(dir)[0];
    writeFileSync(join(dir, key, 'agent-sessions.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(listAgentSessions(projectRoot, 'herodot', home)).toEqual([]);
    warn.mockRestore();
    recordAgentSession(projectRoot, 'herodot', uuid(2), 'chat', home);
    expect(listAgentSessions(projectRoot, 'herodot', home).map((e) => e.id)).toEqual([uuid(2)]);
  });
});

// ─── AC5: talk rows ─────────────────────────────────────────────────────────────────

describe('AC5 talk rows', () => {
  it('a tool-heavy talk returns its words from the start; more than 400 → the last 400 + truncated; exclude drops it', () => {
    makeAgent();
    const lines: Array<['user' | 'text' | 'tool', string]> = [['user', 'first question']];
    for (let i = 0; i < 700; i++) lines.push(['tool', `ls ${i}`]);
    lines.push(['text', 'final answer']);
    talk(uuid(1), '2026-10-26T10:00:00.000Z', '2026-10-26T11:00:00.000Z', lines);
    const s = listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home }).sessions[0];
    expect(s.rows.map((r) => r.text)).toEqual(['first question', 'final answer']);
    expect(s.truncated).toBeUndefined();

    const long: Array<['user' | 'text' | 'tool', string]> = [];
    for (let i = 0; i < 450; i++) long.push([i % 2 ? 'text' : 'user', `line ${i}`]);
    talk(uuid(2), '2026-10-26T12:00:00.000Z', '2026-10-26T13:00:00.000Z', long);
    const t = listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home }).sessions.find((x) => x.key === `talk::${uuid(2)}`)!;
    expect(t.rows).toHaveLength(TALK_MAX_ROWS);
    expect(t.rows[TALK_MAX_ROWS - 1].text).toBe('line 449');
    expect(t.truncated).toBe(true);
    expect(new Set(t.rows.map((r) => r.id)).size).toBe(TALK_MAX_ROWS);

    const ex = listAgentHistory(contextRoot, 'herodot', { audience: 'owner', home, exclude: uuid(2) });
    expect(ex.sessions.map((x) => x.key)).toEqual([`talk::${uuid(1)}`]);
  });
});

// ─── AC7: audiences ─────────────────────────────────────────────────────────────────

describe('AC7 audiences', () => {
  it('owner includes shared-routine posts and other-machine entries; agent excludes both', () => {
    makeAgent();
    routine('daily-sum', 'Herodot daily');
    routine('team-digest', 'Team digest');
    setAutomationShared(contextRoot, 'team-digest', true);
    const mine = run('daily-sum', '2026-10-26T09:00:00.000Z', '2026-10-26T09:02:00.000Z', 'mine');
    const theirs = put('daily-sum', '2026-10-26', { runId: '2026-10-26T10:00:00.000Z', kind: 'agent', at: '2026-10-26T10:00:00.000Z', text: 'theirs' }, OTHER_MACHINE);
    run('team-digest', '2026-10-26T11:00:00.000Z', '2026-10-26T11:01:00.000Z', 'shared digest');
    here.fn = (slug) => (slug === 'daily-sum' ? new Set(mine.map((e) => e.id)) : new Set());
    const owner = walk().flatMap((s) => s.rows.map((r) => r.text));
    expect(owner).toEqual(expect.arrayContaining(['mine', 'theirs', 'shared digest']));
    const agent: string[] = [];
    let before: string | null = null;
    do {
      const p = listAgentHistory(contextRoot, 'herodot', { audience: 'agent', home, before });
      agent.push(...p.sessions.flatMap((s) => s.rows.map((r) => r.text)));
      before = p.nextBefore;
    } while (before);
    expect(agent).toContain('mine');
    expect(agent).not.toContain('theirs');
    expect(agent).not.toContain('shared digest');
    expect(theirs.text).toBe('theirs');
  });
});

// ─── AC8: the CLI ───────────────────────────────────────────────────────────────────

async function runCli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); }));
  process.exitCode = undefined;
  process.chdir(projectRoot);
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

describe('AC8 agents history --search', () => {
  it('finds a word in a run post and in a talk, newest first; --json works', async () => {
    makeAgent();
    routine('daily-sum', 'Herodot daily');
    run('daily-sum', '2026-10-21T09:00:00.000Z', '2026-10-21T09:02:00.000Z', 'Deniz pitched a Leaderboard in #acme.');
    talk(uuid(1), '2026-10-26T13:05:00.000Z', '2026-10-26T13:06:00.000Z', [['user', 'Who proposed the leaderboard?'], ['text', 'Deniz did.']]);
    const json = await runCli(['agents', 'history', 'herodot', '--search', 'LEADERBOARD', '--json']);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as { hits: Array<{ kind: string; text: string; at: string }> };
    expect(parsed.hits.map((h) => h.kind)).toEqual(['talk', 'run']);
    expect(Date.parse(parsed.hits[0].at)).toBeGreaterThan(Date.parse(parsed.hits[1].at));
    const text = await runCli(['agents', 'history', 'herodot', '--search', 'leaderboard']);
    expect(text.out).toContain('Who proposed the leaderboard?');
    expect(text.out).toContain('Deniz pitched a Leaderboard');
    const none = searchAgentHistory(contextRoot, 'herodot', 'zebra', { audience: 'agent', home });
    expect(none.hits).toEqual([]);
    const unknown = await runCli(['agents', 'history', 'nobody']);
    expect(unknown.code).toBe(1);
  });
});

// ─── AC9: the briefing ──────────────────────────────────────────────────────────────

describe('AC9 the briefing', () => {
  it('a new agent chat carries recent runs AND talks (≤ 4096 bytes, never its own session) plus the search line', () => {
    makeAgent();
    routine('daily-sum', 'Herodot daily');
    const recent = new Date(Date.now() - 3_600_000);
    run('daily-sum', recent.toISOString(), new Date(recent.getTime() + 60_000).toISOString(), 'Run news.');
    const t1 = new Date(Date.now() - 1_800_000).toISOString();
    talk(uuid(1), t1, t1, [['user', 'Earlier talk question'], ['text', 'Earlier talk answer']]);
    talk(uuid(2), t1, t1, [['user', 'THIS session words'], ['text', 'x']]);
    const block = agentRecentBlock(contextRoot, 'herodot', uuid(2));
    expect(block).toContain('Run news.');
    expect(block).toContain('Earlier talk question');
    expect(block).not.toContain('THIS session words');
    expect(block).toContain('dreamcontext agents history herodot --search <words>');
    const history = block.slice(0, block.lastIndexOf('\n\nYour earlier runs'));
    expect(Buffer.byteLength(history, 'utf-8')).toBeLessThanOrEqual(4096);
    const prep = prepareAgentChat(contextRoot, 'herodot', home, { excludeSession: uuid(2) });
    expect(prep.ok).toBe(true);
    if (prep.ok) {
      expect(prep.briefing).toContain('Earlier talk question');
      prep.dispose();
    }
  });

  it('a scheduled run\'s history block is unchanged: no talks', () => {
    makeAgent();
    routine('daily-sum', 'Herodot daily');
    const recent = new Date(Date.now() - 3_600_000);
    run('daily-sum', recent.toISOString(), new Date(recent.getTime() + 60_000).toISOString(), 'Run news.');
    const t1 = new Date(Date.now() - 1_800_000).toISOString();
    talk(uuid(1), t1, t1, [['user', 'Earlier talk question'], ['text', 'Earlier talk answer']]);
    const block = buildRecentHistoryBlock(contextRoot, 'herodot', { nonce: 'n0nce' });
    expect(block).toContain('Run news.');
    expect(block).not.toContain('Earlier talk');
  });
});

void statSync;
