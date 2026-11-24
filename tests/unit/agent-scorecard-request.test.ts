/**
 * W3 of the member scorecard (plan uye-karnesi "Ek dalga (W3)"): which runs ask to be rated and for
 * how long (E1, E2, C9), the count "N to rate", the Super's answer window (C16), its own judged
 * rating (E12) and the corrections it records beside his note (E13).
 *
 * Fictional project and agents only ("Acme", "herodot").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAgent } from '../../src/lib/agents/store.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { newThreadEntryId, threadSlugDir } from '../../src/lib/automations/threads.js';
import { THREAD_ENTRY_MARKER, type ThreadEntry } from '../../src/lib/automations/types.js';
import * as server from '../../src/lib/agents/scorecard.js';
import { readScorecard, ScorecardRefused, normalizeCard } from '../../src/lib/agents/scorecard.js';
import { answerFold, openRequestCount, rateRun, undoLesson, commitLesson } from '../../src/lib/agents/scorecard-ops.js';
import { withScorecard } from '../../src/lib/agents/scorecard.js';
import { requestFacts } from '../../src/lib/agents/history.js';
import * as runKey from '../../src/lib/agents/run-key.js';
import * as client from '../../dashboard/src/lib/scorecardModel.js';
import { SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import type { OwnerTurnLine } from '../../src/lib/owner-words.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;
const NOW = new Date('2026-11-20T12:00:00.000Z');
const H = 3_600_000;

beforeEach(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-screq-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-screq-home-')));
  realHome = process.env.HOME;
  process.env.HOME = home;
  createAgent(contextRoot, { slug: 'herodot', title: 'Herodot', prompt: 'Herodot summarises the fictional Acme channel.', learning: false }, { approve: { now: NOW, home } });
  createAutomation(contextRoot, { slug: 'daily-digest', title: 'Daily digest', agent: 'herodot', days: 'daily', at: '09:00' }, { approve: { now: NOW, home } });
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
/** One thread entry, in this machine's own day file (`<day>.md`), or another machine's. */
function put(slug: string, e: Omit<ThreadEntry, 'id'>, machine?: string): void {
  const dir = threadSlugDir(contextRoot, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${e.at.slice(0, 10)}${machine ? `-${machine}` : ''}.md`);
  const prev = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  writeFileSync(path, `${prev}${THREAD_ENTRY_MARKER}\n\`\`\`json\n${JSON.stringify({ ...e, id: newThreadEntryId(Date.parse(e.at) + (seq++ % 7)) })}\n\`\`\`\n\n`);
}
type End = 'ok' | 'failed' | 'replied';
/** A routine run: started, a post, its end. */
function run(firedAt: string, end: End = 'ok', opts: { slug?: string; machine?: string; started?: boolean } = {}): string {
  const slug = opts.slug ?? 'daily-digest';
  const postAt = new Date(Date.parse(firedAt) + 60_000).toISOString();
  if (opts.started !== false) put(slug, { runId: firedAt, kind: 'system', event: 'started', at: firedAt, text: '', via: 'runner' } as Omit<ThreadEntry, 'id'>, opts.machine);
  put(slug, { runId: firedAt, kind: 'agent', at: postAt, text: `post ${firedAt}`, via: 'cli' } as Omit<ThreadEntry, 'id'>, opts.machine);
  put(slug, { runId: firedAt, kind: 'system', event: end, at: postAt, text: '', via: 'runner' } as Omit<ThreadEntry, 'id'>, opts.machine);
  return `${slug}::${firedAt}`;
}
/** A job the main Super handed herodot: its ask first, via the Super; a post; `ok`. */
function superJob(firedAt: string): string {
  const postAt = new Date(Date.parse(firedAt) + 60_000).toISOString();
  // The ask lands a second before the run starts (ids sort by time).
  put('herodot', { runId: firedAt, kind: 'user', at: new Date(Date.parse(firedAt) - 1000).toISOString(), text: 'Draft this week\'s budget plan\nwith the numbers', via: 'super' } as Omit<ThreadEntry, 'id'>);
  put('herodot', { runId: firedAt, kind: 'system', event: 'started', at: firedAt, text: '', via: 'runner' } as Omit<ThreadEntry, 'id'>);
  put('herodot', { runId: firedAt, kind: 'agent', at: postAt, text: 'Plan drafted.', via: 'cli' } as Omit<ThreadEntry, 'id'>);
  put('herodot', { runId: firedAt, kind: 'system', event: 'ok', at: postAt, text: '', via: 'runner' } as Omit<ThreadEntry, 'id'>);
  return `herodot::${firedAt}`;
}
/** The main Super's record; `asked` jobs carry `rateAsked` told at `toldEndAt`. */
function record(asked: Array<{ runId: string; toldEndAt: number }> = []): void {
  const team = asked.map((a, i) => ({ id: `team-${i}`, member: 'herodot', runId: a.runId, entryId: '', jobKind: 'run', queued: false, brief: 'x', startedAt: a.toldEndAt - 1000, awaited: true, told: 'done', toldEndAt: a.toldEndAt, rateAsked: true }));
  writeFileSync(join(contextRoot, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true, team }));
}
const turn = (own: string, at: string, id: string): OwnerTurnLine => ({ at, turn: id, vault: projectRoot, surface: 'super', via: 'mac', keys: ['sess-1'], session: 'sess-1', own });
const env = { CLAUDE_CODE_SESSION_ID: 'sess-1' } as NodeJS.ProcessEnv;

describe('askState and its dashboard mirror (E2)', () => {
  it('open for 72 h from the end, then none; a rating is rated at any age; the mirror agrees on every case', () => {
    expect(client.RATE_ASK_TTL_MS).toBe(server.RATE_ASK_TTL_MS);
    expect(server.RATE_ASK_TTL_MS).toBe(72 * H);
    const end = '2026-11-20T00:00:00.000Z';
    const t0 = Date.parse(end);
    const cases: Array<[Parameters<typeof server.askState>[0], unknown, number, string]> = [
      [{ eligible: true, endedAt: end }, null, t0, 'open'],
      [{ eligible: true, endedAt: end }, null, t0 + 70 * H, 'open'],
      [{ eligible: true, endedAt: end }, null, t0 + 72 * H - 1, 'open'],
      [{ eligible: true, endedAt: end }, null, t0 + 72 * H, 'none'],
      [{ eligible: true, endedAt: end }, { stars: 4 }, t0 + 400 * H, 'rated'],
      [{ eligible: false, endedAt: end }, null, t0, 'none'],
      [{ eligible: true, endedAt: 'not a time' }, null, t0, 'none'],
      [null, null, t0, 'none'],
      [undefined, { stars: 2 }, t0, 'rated'],
    ];
    for (const [facts, rating, now, want] of cases) {
      expect(server.askState(facts, rating, now)).toBe(want);
      expect(client.askState(facts, rating, now)).toBe(want);
    }
  });

  it('the run-key check lives in a dependency-free module the record store and the card share', () => {
    const src = readFileSync(join(__dirname, '../../src/lib/agents/run-key.ts'), 'utf-8');
    expect(src).not.toMatch(/^import /m);
    expect(server.isRunKey).toBe(runKey.isRunKey);
    expect(runKey.isRunKey('daily-digest::2026-11-20T09:00:00.000Z')).toBe(true);
    expect(runKey.isRunKey('0123456789abcdef/daily-digest::2026-11-20T09:00:00.000Z')).toBe(true);
    expect(runKey.isRunKey('../x::y')).toBe(false);
    expect(client.ratingKeyOf('daily-digest::r', '0123456789abcdef/')).toBe('0123456789abcdef/daily-digest::r');
    expect(client.ratingKeyOf('daily-digest::r', undefined)).toBe('daily-digest::r');
  });
});

describe('requestFacts: which runs ask (E1, C9)', () => {
  it('a raw ok run of this Mac asks; failed, a reply job\'s replied, another Mac, a delivery note and a Super job do not', () => {
    record();
    const ok = '2026-11-19T09:00:00.000Z';
    run(ok);
    expect(requestFacts(contextRoot, 'daily-digest', ok, home)).toEqual({ eligible: true, endedAt: '2026-11-19T09:01:00.000Z', status: 'ok' });
    const failed = '2026-11-19T10:00:00.000Z';
    run(failed, 'failed');
    expect(requestFacts(contextRoot, 'daily-digest', failed, home)).toMatchObject({ eligible: false, status: 'failed' });
    const replied = '2026-11-19T11:00:00.000Z';
    run(replied, 'replied');
    expect(requestFacts(contextRoot, 'daily-digest', replied, home)?.eligible ?? false).toBe(false);
    const there = '2026-11-19T12:00:00.000Z';
    run(there, 'ok', { machine: 'bbbbbbbbbbbb' });
    expect(requestFacts(contextRoot, 'daily-digest', there, home)?.eligible).toBe(false);
    const note = '2026-11-19T13:00:00.000Z';
    put('daily-digest', { runId: note, kind: 'system', event: 'ok', at: note, text: 'Delivered.', via: 'runner' } as Omit<ThreadEntry, 'id'>);
    expect(requestFacts(contextRoot, 'daily-digest', note, home)?.eligible).toBe(false);
    const job = '2026-11-19T14:00:00.000Z';
    superJob(job);
    expect(requestFacts(contextRoot, 'herodot', job, home)).toMatchObject({ eligible: false, status: 'ok' });
    // No terminal entry yet: no facts at all.
    const live = '2026-11-19T15:00:00.000Z';
    put('daily-digest', { runId: live, kind: 'system', event: 'started', at: live, text: '', via: 'runner' } as Omit<ThreadEntry, 'id'>);
    expect(requestFacts(contextRoot, 'daily-digest', live, home)).toBeNull();
  });

  it('a later reply on the run never moves its end', () => {
    const ok = '2026-11-19T09:00:00.000Z';
    run(ok);
    put('daily-digest', { runId: ok, kind: 'user', at: '2026-11-21T08:00:00.000Z', text: 'and the weekend?', via: 'dashboard' } as Omit<ThreadEntry, 'id'>);
    put('daily-digest', { runId: ok, kind: 'system', event: 'replied', at: '2026-11-21T08:01:00.000Z', text: '', via: 'runner' } as Omit<ThreadEntry, 'id'>);
    expect(requestFacts(contextRoot, 'daily-digest', ok, home)).toMatchObject({ eligible: true, endedAt: '2026-11-19T09:01:00.000Z' });
  });

  it('a routine with no member (super-rutin) never asks', () => {
    createAutomation(contextRoot, { slug: 'house-rutin', title: 'House', days: 'daily', at: '09:00', prompt: 'go' }, { approve: { now: NOW, home } });
    // A Super automation (`target: super`): the Super's own turn, never a member.
    const file = join(contextRoot, 'automations', 'house-rutin.md');
    writeFileSync(file, readFileSync(file, 'utf-8').replace(/^---\n/, '---\ntarget: super\n'));
    const ok = '2026-11-19T09:00:00.000Z';
    run(ok, 'ok', { slug: 'house-rutin' });
    expect(requestFacts(contextRoot, 'house-rutin', ok, home)?.eligible).toBe(false);
  });
});

describe('openRequestCount ("N to rate", C9)', () => {
  it('an hourly member: every open run counts, no cap; rated and past-window runs do not', () => {
    const now = Date.parse('2026-11-22T12:00:00.000Z');
    const keys: string[] = [];
    // 72 hourly runs ending inside the window, plus older ones.
    for (let i = 1; i <= 72; i++) keys.push(run(new Date(now - i * H).toISOString()));
    for (let i = 0; i < 5; i++) run(new Date(now - (80 + i) * H).toISOString());
    // A run that ended at day -5 with a reply today is not counted.
    const old = new Date(now - 5 * 24 * H).toISOString();
    run(old);
    put('daily-digest', { runId: old, kind: 'user', at: new Date(now - H / 2).toISOString(), text: 'ok?', via: 'dashboard' } as Omit<ThreadEntry, 'id'>);
    // The run that ended exactly 72 h ago is out (its post is a minute after its fire).
    const open = keys.filter((k) => Date.parse(k.split('::')[1]) + 60_000 + 72 * H > now).length;
    expect(openRequestCount(projectRoot, 'herodot', now, home)).toBe(open);
    rateRun(projectRoot, 'herodot', { run: keys[0], stars: 5, by: 'owner', home, now: new Date(now) });
    expect(openRequestCount(projectRoot, 'herodot', now, home)).toBe(open - 1);
  });
});

describe('the Super rates a job it handed the member (C16)', () => {
  const JOB = '2026-11-20T08:00:00.000Z';
  const ASKED = Date.parse('2026-11-20T08:05:00.000Z');

  it('his short answers after the ask record the stars with his turn as the quote and no note', () => {
    const key = superJob(JOB);
    record([{ runId: JOB, toldEndAt: ASKED }]);
    for (const said of ['Dört.', '4 yıldız', '🎙 Dört.']) {
      const id = `t-${said.length}-${seq++}`;
      const turns = [turn(said, '2026-11-20T08:06:00.000Z', id)];
      const stars = said.startsWith('4') || said.includes('Dört') ? 4 : 0;
      const r = rateRun(projectRoot, 'herodot', { run: key, stars, by: 'super', quote: said.replace('🎙 ', ''), home, now: NOW, env, turns });
      expect(r.rating).toMatchObject({ stars: 4, by: 'super', quoteTurn: id, viaSuper: true });
      expect(r.rating?.note).toBeUndefined();
      expect(r.rating?.title).toBe('Draft this week\'s budget plan');
      withScorecard(projectRoot, 'herodot', (c) => { delete c.ratings[r.runKey]; c.usedQuoteTurns = []; }, { home });
    }
    expect(answerFold('🎙 Dört.')).toBe(answerFold('dört'));
  });

  it('"3, CTA eksikti" records 3 stars with the note; a turn before the ask is not his answer', () => {
    const key = superJob(JOB);
    record([{ runId: JOB, toldEndAt: ASKED }]);
    const early = [turn('3, CTA eksikti', '2026-11-20T08:04:00.000Z', 't-early')];
    expect(() => rateRun(projectRoot, 'herodot', { run: key, stars: 3, by: 'super', quote: '3, CTA eksikti', note: 'CTA eksikti', home, now: NOW, env, turns: early }))
      .toThrow(/after you asked/);
    const turns = [turn('3, CTA eksikti', '2026-11-20T08:07:00.000Z', 't-3')];
    // A note cut inside a word is not his words (whole words only).
    expect(() => rateRun(projectRoot, 'herodot', { run: key, stars: 3, by: 'super', quote: '3, CTA eksikti', note: 'CTA eksik', home, now: NOW, env, turns }))
      .toThrow(/his own words/);
    const r = rateRun(projectRoot, 'herodot', { run: key, stars: 3, by: 'super', quote: '3, CTA eksikti', note: 'CTA eksikti', home, now: NOW, env, turns });
    expect(r.rating).toMatchObject({ stars: 3, note: 'CTA eksikti' });
    expect(r.draft).toBe(true);
  });

  it('the same "beş yıldız" said once for each of two asked jobs binds each to its own turn', () => {
    const a = superJob(JOB);
    const JOB2 = '2026-11-20T09:00:00.000Z';
    const b = superJob(JOB2);
    record([{ runId: JOB, toldEndAt: ASKED }, { runId: JOB2, toldEndAt: Date.parse('2026-11-20T09:05:00.000Z') }]);
    const turns = [turn('beş yıldız', '2026-11-20T08:06:00.000Z', 't-a'), turn('beş yıldız', '2026-11-20T09:06:00.000Z', 't-b')];
    const ra = rateRun(projectRoot, 'herodot', { run: a, stars: 5, by: 'super', quote: 'beş yıldız', home, now: NOW, env, turns });
    const rb = rateRun(projectRoot, 'herodot', { run: b, stars: 5, by: 'super', quote: 'beş yıldız', home, now: NOW, env, turns });
    expect(ra.rating?.quoteTurn).toBe('t-a');
    expect(rb.rating?.quoteTurn).toBe('t-b');
  });

  it('a run key that is no run of the member is unknown_run; a Super job with no end yet is run_not_rateable', () => {
    record();
    expect(() => rateRun(projectRoot, 'herodot', { run: 'herodot::2026-11-01T00:00:00.000Z', stars: 4, by: 'owner', home, now: NOW })).toThrow(/No run/);
    const live = '2026-11-20T10:00:00.000Z';
    put('herodot', { runId: live, kind: 'user', at: '2026-11-20T09:59:59.000Z', text: 'go', via: 'super' } as Omit<ThreadEntry, 'id'>);
    put('herodot', { runId: live, kind: 'system', event: 'started', at: live, text: '', via: 'runner' } as Omit<ThreadEntry, 'id'>);
    try {
      rateRun(projectRoot, 'herodot', { run: `herodot::${live}`, stars: 4, by: 'owner', home, now: NOW });
      expect.fail('rated a run with no end');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorecardRefused);
      expect((e as ScorecardRefused).code).toMatch(/run_not_rateable|unknown_run/);
    }
  });

  it('a rated Super job is changed and cleared from its snapshot with the record gone', () => {
    const key = superJob(JOB);
    record();
    rateRun(projectRoot, 'herodot', { run: key, stars: 4, by: 'owner', home, now: NOW });
    rmSync(join(contextRoot, SUPER_STATE_REL));
    const r = rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'owner', home, now: NOW });
    expect(r.rating).toMatchObject({ stars: 2, viaSuper: true, title: 'Draft this week\'s budget plan' });
    expect(rateRun(projectRoot, 'herodot', { run: key, stars: null, by: 'owner', home, now: NOW }).rating).toBeNull();
  });
});

describe('--judged: the Super\'s own reading of his words (E12)', () => {
  it('stores judged by super; his tap replaces it keeping firstAt and the note; refused without --quote, with --last or from the owner', () => {
    const key = run('2026-11-19T09:00:00.000Z');
    const said = 'Hayır, bu yanlış; bütçeyi bana sormadan artırmamalıydı.';
    const turns = [turn(said, '2026-11-19T12:00:00.000Z', 't-j')];
    expect(() => rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'super', judged: true, home, now: NOW, env, turns })).toThrow(/--quote/);
    expect(() => rateRun(projectRoot, 'herodot', { last: true, stars: 2, by: 'super', judged: true, quote: said, home, now: NOW, env, turns })).toThrow(/--run/);
    expect(() => rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'owner', judged: true, quote: said, home, now: NOW })).toThrow(/agent session/);
    const j = rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'super', judged: true, quote: said, note: 'bütçeyi bana sormadan artırmamalıydı', home, now: NOW, env, turns });
    expect(j.rating).toMatchObject({ stars: 2, by: 'super', judged: true, via: 'super' });
    const later = new Date(NOW.getTime() + H);
    const mine = rateRun(projectRoot, 'herodot', { run: key, stars: 3, by: 'owner', home, now: later });
    expect(mine.rating?.judged).toBeUndefined();
    expect(mine.rating).toMatchObject({ stars: 3, by: 'owner', firstAt: NOW.toISOString(), note: 'bütçeyi bana sormadan artırmamalıydı' });
  });

  it('on a run he rated himself, --judged keeps his stars and says so', () => {
    const key = run('2026-11-19T09:00:00.000Z');
    rateRun(projectRoot, 'herodot', { run: key, stars: 5, by: 'owner', home, now: NOW });
    const said = 'aslında pek iyi değildi';
    const turns = [turn(said, '2026-11-19T12:00:00.000Z', 't-k')];
    const r = rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'super', judged: true, quote: said, home, now: NOW, env, turns });
    expect(r.keptOwnerStars).toBe(true);
    expect(r.rating).toMatchObject({ stars: 5, by: 'owner' });
    expect(r.rating?.judged).toBeUndefined();
  });
});

describe('an agent never takes his words away (E13, review w3 r1)', () => {
  it('the same correction sent twice, judged or not, keeps his note and drafts once', () => {
    for (const judged of [false, true]) {
      const key = run(judged ? '2026-11-19T10:00:00.000Z' : '2026-11-19T09:00:00.000Z');
      rateRun(projectRoot, 'herodot', { run: key, stars: 3, note: 'CTA eksikti', by: 'owner', home, now: NOW });
      const said = 'bütçeyi sormadan artırmamalıydı';
      const turns = [turn(said, '2026-11-19T12:00:00.000Z', `t-r${judged ? 'j' : 'p'}`)];
      const call = () => rateRun(projectRoot, 'herodot', { run: key, stars: 4, by: 'super', ...(judged ? { judged: true } : {}), quote: said, note: said, home, now: NOW, env, turns });
      const one = call();
      expect(one.rating).toMatchObject({ note: 'CTA eksikti' });
      expect(one.rating?.corrections).toHaveLength(1);
      expect(one.draft).toBe(true);
      const two = call();
      expect(two.rating).toMatchObject({ note: 'CTA eksikti' });
      expect(two.rating?.corrections).toHaveLength(1);
      expect(two.draft).toBe(false);
      expect(two.slot).toBeUndefined();
    }
  });

  it('his note stays whole beside a correction: its failed lesson draft keeps its Try again (review w3 r2)', () => {
    const key = run('2026-11-19T09:00:00.000Z');
    const first = rateRun(projectRoot, 'herodot', { run: key, stars: 3, note: 'CTA eksikti', by: 'owner', home, now: NOW });
    withScorecard(projectRoot, 'herodot', (c) => { c.ratings[first.runKey].draft = { state: 'failed', attempts: 1, at: NOW.toISOString(), noteFold: first.rating!.noteFold! }; }, { home });
    const said = 'bütçeyi sormadan artırmamalıydı';
    const turns = [turn(said, '2026-11-19T12:00:00.000Z', 't-dr')];
    for (const judged of [false, true]) {
      for (let i = 0; i < 2; i++) {
        const r = rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'super', ...(judged ? { judged: true } : {}), quote: said, note: said, home, now: NOW, env, turns });
        expect(r.rating).toMatchObject({ note: 'CTA eksikti', draft: { state: 'failed', attempts: 1 } });
        expect(r.rating?.corrections).toHaveLength(1);
      }
    }
  });

  it('a judged correction on a judged rating keeps the first words too', () => {
    const key = run('2026-11-19T09:00:00.000Z');
    const a = 'Hayır, bütçeyi bana sormadan artırmamalıydı.';
    const b = 'kitleyi de daraltmamalıydı';
    const turns = [turn(a, '2026-11-19T12:00:00.000Z', 't-ja'), turn(b, '2026-11-19T12:10:00.000Z', 't-jb')];
    rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'super', judged: true, quote: a, note: 'bütçeyi bana sormadan artırmamalıydı', home, now: NOW, env, turns });
    for (let i = 0; i < 2; i++) {
      const r = rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'super', judged: true, quote: b, note: b, home, now: NOW, env, turns });
      expect(r.rating).toMatchObject({ note: 'bütçeyi bana sormadan artırmamalıydı', quote: a, judged: true });
      expect(r.rating?.corrections?.map((c) => c.note)).toEqual([b]);
    }
  });

  it('an agent cannot clear a rating, judged or not; he can', () => {
    const key = run('2026-11-19T09:00:00.000Z');
    rateRun(projectRoot, 'herodot', { run: key, stars: 5, note: 'CTA eksikti', by: 'owner', home, now: NOW });
    const said = 'sil bunu';
    const turns = [turn(said, '2026-11-19T12:00:00.000Z', 't-x')];
    for (const judged of [false, true]) {
      expect(() => rateRun(projectRoot, 'herodot', { run: key, stars: null, by: 'super', ...(judged ? { judged: true } : {}), quote: said, home, now: NOW, env, turns })).toThrow(/Only the owner clears/);
    }
    expect(readScorecard(projectRoot, 'herodot', home).card.ratings[Object.keys(readScorecard(projectRoot, 'herodot', home).card.ratings)[0]]).toMatchObject({ stars: 5, note: 'CTA eksikti' });
    expect(rateRun(projectRoot, 'herodot', { run: key, stars: null, by: 'owner', home, now: NOW }).rating).toBeNull();
  });
});

describe('corrections: his words never overwritten by an agent (E13)', () => {
  it('a correction is added beside his note with its own lesson slot; a second adds another; the same one twice stores one; read back intact', () => {
    const key = run('2026-11-19T09:00:00.000Z');
    const first = rateRun(projectRoot, 'herodot', { run: key, stars: 3, note: 'CTA eksikti', by: 'owner', home, now: NOW });
    withScorecard(projectRoot, 'herodot', (c) => { commitLesson(c, first.runKey, 'Always end with a clear CTA.', first.rating!.noteFold!, NOW); }, { home });
    const said = 'bütçeyi sormadan artırmamalıydı';
    const turns = [turn(said, '2026-11-19T12:00:00.000Z', 't-c1'), turn('ve kitleyi de daraltmamalıydı', '2026-11-19T12:10:00.000Z', 't-c2')];
    const c1 = rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'super', judged: true, quote: said, note: said, home, now: NOW, env, turns });
    expect(c1.keptOwnerStars).toBe(true);
    expect(c1.rating).toMatchObject({ stars: 3, note: 'CTA eksikti' });
    expect(c1.rating?.corrections).toHaveLength(1);
    expect(c1.draft).toBe(true);
    expect(c1.slot).toBe(`c:${c1.rating!.corrections![0].id}`);
    // Resent: no second correction, no second draft.
    const again = rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'super', judged: true, quote: said, note: said, home, now: NOW, env, turns });
    expect(again.rating?.corrections).toHaveLength(1);
    expect(again.draft).toBe(false);
    const c2 = rateRun(projectRoot, 'herodot', { run: key, stars: 2, by: 'super', judged: true, quote: 've kitleyi de daraltmamalıydı', note: 've kitleyi de daraltmamalıydı', home, now: NOW, env, turns });
    expect(c2.rating?.corrections).toHaveLength(2);
    // Each correction's lesson in its own slot; the note's lesson stays active.
    withScorecard(projectRoot, 'herodot', (c) => {
      const r = c.ratings[first.runKey];
      commitLesson(c, first.runKey, 'Ask before raising the budget.', r.corrections![0].noteFold, NOW, `c:${r.corrections![0].id}`);
      commitLesson(c, first.runKey, 'Keep the audience as briefed.', r.corrections![1].noteFold, NOW, `c:${r.corrections![1].id}`);
    }, { home });
    const raw = JSON.parse(readFileSync(readScorecard(projectRoot, 'herodot', home).scope.file, 'utf-8'));
    const back = normalizeCard(raw.members.herodot);
    expect(back.ratings[first.runKey].corrections?.map((c) => c.note)).toEqual([said, 've kitleyi de daraltmamalıydı']);
    const active = () => readScorecard(projectRoot, 'herodot', home).card.lessons.filter((l) => l.status === 'active');
    expect(active().map((l) => l.slot ?? '')).toEqual(['', `c:${back.ratings[first.runKey].corrections![0].id}`, `c:${back.ratings[first.runKey].corrections![1].id}`]);
    // Undo one correction's lesson: the others stay.
    undoLesson(projectRoot, 'herodot', active()[1].id, home, NOW);
    expect(active()).toHaveLength(2);
    // His own edit of the note replaces only the note's lesson slot (the new draft waits; corrections stay).
    const edit = rateRun(projectRoot, 'herodot', { run: key, stars: 3, note: 'CTA en sonda olmalı', by: 'owner', home, now: NOW });
    expect(edit.rating?.corrections).toHaveLength(2);
    expect(edit.slot).toBeUndefined();
    // Clearing retires them all.
    rateRun(projectRoot, 'herodot', { run: key, stars: null, by: 'owner', home, now: NOW });
    expect(active()).toHaveLength(0);
  });
});
