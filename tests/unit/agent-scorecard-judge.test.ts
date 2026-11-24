/**
 * The scorecard's model work (plan uye-karnesi C3, D5, D6, D10-D14) with a stubbed judge: a check
 * lands one verdict per criterion, no text is `no_text`, a failure is kept with "Try again", his
 * flip survives, a stale draft writes nothing, and a lesson never adds a number or a name.
 *
 * Fictional project and agents only ("Acme", "herodot").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAgent } from '../../src/lib/agents/store.js';
import { createAutomation, recordRun } from '../../src/lib/automations/store.js';
import type { RunEvent } from '../../src/lib/automations/types.js';
import { newThreadEntryId, threadSlugDir } from '../../src/lib/automations/threads.js';
import { THREAD_ENTRY_MARKER, type ThreadEntry } from '../../src/lib/automations/types.js';
import { readScorecard, withScorecard } from '../../src/lib/agents/scorecard.js';
import { addCriterion, rateRun, setVerdict } from '../../src/lib/agents/scorecard-ops.js';
import { checkRun, draftLesson, lessonAddsNothing, readRunText, type JudgeFn } from '../../src/lib/agents/scorecard-judge.js';
import { startScorecardCheck } from '../../src/lib/automations/runner.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;
const NOW = new Date('2026-11-20T12:00:00.000Z');
const opts = () => ({ home, now: () => NOW, pid: 4242, startOf: () => 'start-a' });

beforeEach(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-judge-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-judge-home-')));
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
function put(e: Omit<ThreadEntry, 'id' | 'via'>): void {
  const dir = threadSlugDir(contextRoot, 'daily-digest');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${e.at.slice(0, 10)}-aaaaaaaaaaaa.md`);
  const prev = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  writeFileSync(path, `${prev}${THREAD_ENTRY_MARKER}\n\`\`\`json\n${JSON.stringify({ ...e, id: newThreadEntryId(Date.parse(e.at) + (seq++ % 7)), via: 'runner' })}\n\`\`\`\n\n`);
}
function run(firedAt: string, post: string | null): string {
  put({ runId: firedAt, kind: 'system', event: 'started', at: firedAt, text: '' } as Omit<ThreadEntry, 'id' | 'via'>);
  const end = new Date(Date.parse(firedAt) + 60_000).toISOString();
  if (post) put({ runId: firedAt, kind: 'agent', at: end, text: post } as Omit<ThreadEntry, 'id' | 'via'>);
  put({ runId: firedAt, kind: 'system', event: 'ok', at: end, text: '' } as Omit<ThreadEntry, 'id' | 'via'>);
  return `daily-digest::${firedAt}`;
}
const answered = (text: string, usd = 0.004): JudgeFn => async () => ({ outcome: 'answered', text, usd, ms: 10 });

describe('checkRun', () => {
  it('reads the final message from the run\'s own transcript: a check he starts later reads what the runner\'s read (r1 check-input-parity)', async () => {
    const fired = '2026-11-19T09:00:00.000Z';
    const key = run(fired, null);
    // A run that published no document and posted nothing: its words are only in its session.
    const sid = 'sess-acme-1';
    const tdir = join(home, '.claude', 'projects', '-acme');
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, `${sid}.jsonl`), [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'go' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Paused the two tired ads.' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'x', input: {} }] } }),
    ].join('\n') + '\n');
    recordRun(contextRoot, 'daily-digest', {
      firedAt: fired, startedAt: fired, finishedAt: fired, status: 'ok', durationMs: 1, outputPath: null, error: null,
      exitCode: 0, sessionId: sid, costUsd: null, numTurns: null, permissionDenials: 0,
    } as RunEvent);
    expect(readRunText(projectRoot, key, { home }).final).toBe('Paused the two tired ads.');
    const a = addCriterion(projectRoot, 'herodot', 'Says what changed', home);
    let seen = '';
    const judge: JudgeFn = async (p) => { seen = p; return { outcome: 'answered', text: JSON.stringify({ verdicts: [{ id: a, met: true }] }), usd: 0.003, ms: 5 }; };
    // The runner's spawn and the card's "Check" run the same command with the same inputs.
    expect(await checkRun(projectRoot, 'herodot', key, { ...opts(), judge })).toBe('done');
    expect(seen).toContain('Paused the two tired ads.');
  });

  it('an answer that leaves a line unjudged is unusable and ends failed, never "N of M met" (r1 unjudged-counted-as-not-met)', async () => {
    const key = run('2026-11-19T09:00:00.000Z', 'Text.');
    const a = addCriterion(projectRoot, 'herodot', 'Only shipped features are claimed', home);
    addCriterion(projectRoot, 'herodot', 'Under 200 words', home);
    let calls = 0;
    const judge: JudgeFn = async () => { calls++; return { outcome: 'answered', text: JSON.stringify({ verdicts: [{ id: a, met: true }] }), usd: 0.001, ms: 1 }; };
    expect(await checkRun(projectRoot, 'herodot', key, { ...opts(), judge })).toBe('failed');
    expect(calls).toBeGreaterThan(1);
    const c = readScorecard(projectRoot, 'herodot', home).card.checks[key];
    expect(c.state).toBe('failed');
    expect(c.lastError).toMatch(/unusable/);
  });

  it('lands one verdict per criterion with its cost, judged on the run\'s posts', async () => {
    const key = run('2026-11-19T09:00:00.000Z', 'Shipped: the export button. Planned: dark mode.');
    const a = addCriterion(projectRoot, 'herodot', 'Only shipped features are claimed', home);
    const b = addCriterion(projectRoot, 'herodot', 'Under 200 words', home);
    let seen = '';
    const judge: JudgeFn = async (p) => { seen = p; return { outcome: 'answered', text: JSON.stringify({ verdicts: [{ id: a, met: true, why: 'only shipped' }, { id: b, met: false }] }), usd: 0.0045, ms: 5 }; };
    expect(await checkRun(projectRoot, 'herodot', key, { ...opts(), judge })).toBe('done');
    expect(seen).toContain('Shipped: the export button');
    const c = readScorecard(projectRoot, 'herodot', home).card.checks[key];
    expect(c.state).toBe('done');
    expect(c.costUsd).toBe(0.0045);
    expect(c.verdicts.map((v) => [v.id, v.met])).toEqual([[a, true], [b, false]]);
  });

  it('a run with no text is no_text with every verdict null, never "not met"', async () => {
    const key = run('2026-11-19T09:00:00.000Z', null);
    addCriterion(projectRoot, 'herodot', 'Only shipped features are claimed', home);
    let called = false;
    expect(await checkRun(projectRoot, 'herodot', key, { ...opts(), judge: async () => { called = true; return { outcome: 'answered', text: '{}', usd: 0, ms: 1 }; } })).toBe('no_text');
    expect(called).toBe(false);
    const c = readScorecard(projectRoot, 'herodot', home).card.checks[key];
    expect(c.state).toBe('no_text');
    expect(c.verdicts.every((v) => v.met === null)).toBe(true);
  });

  it('a timeout or an unusable answer is failed with its reason; his flip is never overwritten', async () => {
    const key = run('2026-11-19T09:00:00.000Z', 'Some text.');
    const a = addCriterion(projectRoot, 'herodot', 'Only shipped features are claimed', home);
    expect(await checkRun(projectRoot, 'herodot', key, { ...opts(), judge: async () => ({ outcome: 'timeout', text: '', usd: 0, ms: 1 }) })).toBe('failed');
    let c = readScorecard(projectRoot, 'herodot', home).card.checks[key];
    expect(c.state).toBe('failed');
    expect(c.lastError).toMatch(/timed out/);
    expect(await checkRun(projectRoot, 'herodot', key, { ...opts(), judge: answered('no json here') })).toBe('failed');
    expect(readScorecard(projectRoot, 'herodot', home).card.checks[key].lastError).toMatch(/unusable/);
    setVerdict(projectRoot, 'herodot', key, a, true, home);
    await checkRun(projectRoot, 'herodot', key, { ...opts(), judge: answered(JSON.stringify({ verdicts: [{ id: a, met: false }] })) });
    c = readScorecard(projectRoot, 'herodot', home).card.checks[key];
    expect(c.verdicts[0]).toMatchObject({ met: true, by: 'owner' });
    expect(c.attempts).toBe(3);
  });

  it('refuses a second check while one runs live; an agent session may only start the first', async () => {
    const key = run('2026-11-19T09:00:00.000Z', 'Text.');
    addCriterion(projectRoot, 'herodot', 'Only shipped features are claimed', home);
    withScorecard(projectRoot, 'herodot', (card) => {
      card.checks[key] = { state: 'running', attempts: 0, pid: process.pid, pidStart: 'live', at: NOW.toISOString(), criteriaHash: '', verdicts: [], costUsd: 0 };
    }, { home });
    await expect(checkRun(projectRoot, 'herodot', key, { ...opts(), startOf: () => 'live', judge: answered('{}') })).rejects.toMatchObject({ code: 'check_running' });
    withScorecard(projectRoot, 'herodot', (card) => { card.checks[key] = { ...card.checks[key], state: 'failed', attempts: 1 }; }, { home });
    await expect(checkRun(projectRoot, 'herodot', key, { ...opts(), firstOnly: true, judge: answered('{}') })).rejects.toBeTruthy();
  });

  it('the runner starts a check only for a member with criteria, and a failed spawn changes nothing', () => {
    const jobs: unknown[] = [];
    const outcome = { event: { firedAt: '2026-11-19T09:00:00.000Z' }, result: 'final words' } as Parameters<typeof startScorecardCheck>[2];
    expect(startScorecardCheck(contextRoot, 'daily-digest', outcome, (j) => jobs.push(j))).toBe(false);
    addCriterion(projectRoot, 'herodot', 'Only shipped features are claimed', home);
    expect(startScorecardCheck(contextRoot, 'daily-digest', outcome, (j) => jobs.push(j))).toBe(true);
    expect(jobs[0]).toMatchObject({ kind: 'check', member: 'herodot', run: 'daily-digest::2026-11-19T09:00:00.000Z' });
    expect(startScorecardCheck(contextRoot, 'daily-digest', outcome, () => { throw new Error('spawn EACCES'); })).toBe(false);
  });
});

describe('draftLesson', () => {
  it('drafts exactly one lesson; a newer note replaces it; a stale draft writes nothing at all', async () => {
    const key = run('2026-11-19T09:00:00.000Z', 'Text.');
    rateRun(projectRoot, 'herodot', { run: key, stars: 2, note: 'Too long', by: 'owner', home, now: NOW });
    expect(await draftLesson(projectRoot, 'herodot', key, { ...opts(), judge: answered('{"lesson":"Keep it short."}') })).toBe('lesson');
    // The note changes while the second draft is in flight: that draft commits nothing.
    rateRun(projectRoot, 'herodot', { run: key, stars: 2, note: 'Too long and too late', by: 'owner', home, now: NOW });
    const before = readFileSync(readScorecard(projectRoot, 'herodot', home).scope.file, 'utf-8');
    const stale: JudgeFn = async () => {
      rateRun(projectRoot, 'herodot', { run: key, stars: 2, note: 'Too late', by: 'owner', home, now: NOW });
      return { outcome: 'answered', text: '{"lesson":"Keep it short and send it on time."}', usd: 0.004, ms: 1 };
    };
    expect(await draftLesson(projectRoot, 'herodot', key, { ...opts(), judge: stale })).toBe('moved');
    expect(before).not.toBe('');
    let card = readScorecard(projectRoot, 'herodot', home).card;
    expect(card.lessons.filter((l) => l.status === 'active').map((l) => l.text)).toEqual(['Keep it short.']);
    expect(card.ratings[key].draft).toMatchObject({ state: 'running', attempts: 0 });
    expect(await draftLesson(projectRoot, 'herodot', key, { ...opts(), judge: answered('{"lesson":"Send it on time."}') })).toBe('lesson');
    card = readScorecard(projectRoot, 'herodot', home).card;
    expect(card.lessons.filter((l) => l.status === 'active').map((l) => l.text)).toEqual(['Send it on time.']);
  });

  it('never adds a number or a name his note lacks (5 fixture notes)', () => {
    const cases: Array<[string, string, boolean]> = [
      ['Too much budget on an untested audience', 'Keep spend under 50 on an untested audience.', false],
      ['Too much budget on an untested audience', 'Do not put much budget on an untested audience.', true],
      ['Ask before changing the budget', 'Ask Mehmet before changing the budget.', false],
      ['Use the Acme tone, keep 3 bullets', 'Use the Acme tone and keep 3 bullets.', true],
      ['Çok fazla bütçe, test edilmemiş kitleye', 'Test edilmemiş kitleye çok fazla bütçe verme.', true],
    ];
    for (const [note, lesson, ok] of cases) expect([note, lessonAddsNothing(note, lesson)]).toEqual([note, ok]);
  });

  it('a lesson that adds a number is asked again and, when it keeps adding one, fails', async () => {
    const key = run('2026-11-19T09:00:00.000Z', 'Text.');
    rateRun(projectRoot, 'herodot', { run: key, stars: 2, note: 'Too much budget', by: 'owner', home, now: NOW });
    expect(await draftLesson(projectRoot, 'herodot', key, { ...opts(), judge: answered('{"lesson":"Spend at most 20 a day."}') })).toBe('failed');
    const card = readScorecard(projectRoot, 'herodot', home).card;
    expect(card.lessons).toHaveLength(0);
    expect(card.ratings[key].draft).toMatchObject({ state: 'failed', attempts: 1 });
    // A changed note starts again from attempt 0.
    rateRun(projectRoot, 'herodot', { run: key, stars: 2, note: 'Much too much budget', by: 'owner', home, now: NOW });
    expect(readScorecard(projectRoot, 'herodot', home).card.ratings[key].draft).toMatchObject({ attempts: 0 });
  });
});
