/**
 * The scorecard's HTTP routes (plan uye-karnesi C5, C6): the owner's page only, the run list joined
 * with ratings, Try again refused while a check runs, and a phone narrowed to the projects it may
 * reach (a global member's project A ratings never reach a phone that may see only project B).
 *
 * Fictional projects and agents only ("acme", "orbit", "herodot", "atlas").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createAgent, createGlobalAgent } from '../../src/lib/agents/store.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { newThreadEntryId, threadSlugDir } from '../../src/lib/automations/threads.js';
import { THREAD_ENTRY_MARKER, type ThreadEntry } from '../../src/lib/automations/types.js';
import { addVault } from '../../src/lib/vaults.js';
import { markPhoneSocket, setMacExposedVaults } from '../../src/server/phone-origin.js';
import { readScorecard, withScorecard } from '../../src/lib/agents/scorecard.js';
import { addCriterion, rateRun } from '../../src/lib/agents/scorecard-ops.js';
import {
  handleScorecardCheck, handleScorecardCriteria, handleScorecardGet, handleScorecardLessonUndo, handleScorecardRate, setScorecardSpawnForTests,
} from '../../src/server/routes/agent-scorecard.js';

let home: string;
let realHome: string | undefined;
let a: string;
let b: string;
const NOW = new Date('2026-11-20T12:00:00.000Z');
const jobs: unknown[] = [];

function project(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `dc-scr-${name}-`)));
  mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
  addVault(name, root, home);
  return root;
}
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-scr-home-')));
  realHome = process.env.HOME;
  process.env.HOME = home;
  a = project('acme');
  b = project('orbit');
  jobs.length = 0;
  setScorecardSpawnForTests((j) => { jobs.push(j); });
  createAgent(join(a, '_dream_context'), { slug: 'herodot', title: 'Herodot', prompt: 'Herodot summarises the fictional Acme channel.', learning: false }, { approve: { now: NOW, home } });
  createAutomation(join(a, '_dream_context'), { slug: 'daily-digest', title: 'Daily digest', agent: 'herodot', days: 'daily', at: '09:00' }, { approve: { now: NOW, home } });
});
afterEach(() => {
  setScorecardSpawnForTests(null);
  setMacExposedVaults([]);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  for (const d of [a, b, home]) rmSync(d, { recursive: true, force: true });
});

let seq = 0;
function run(root: string, slug: string, firedAt: string): string {
  const cr = join(root, '_dream_context');
  const end = new Date(Date.parse(firedAt) + 60_000).toISOString();
  for (const e of [
    { runId: firedAt, kind: 'system', event: 'started', at: firedAt, text: '' },
    { runId: firedAt, kind: 'agent', at: end, text: 'post' },
    { runId: firedAt, kind: 'system', event: 'ok', at: end, text: '' },
  ] as Array<Omit<ThreadEntry, 'id' | 'via'>>) {
    const dir = threadSlugDir(cr, slug);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${e.at.slice(0, 10)}-aaaaaaaaaaaa.md`);
    const prev = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    writeFileSync(path, `${prev}${THREAD_ENTRY_MARKER}\n\`\`\`json\n${JSON.stringify({ ...e, id: newThreadEntryId(Date.parse(e.at) + (seq++ % 7)), via: 'runner' })}\n\`\`\`\n\n`);
  }
  return `${slug}::${firedAt}`;
}

function req(body: unknown, opts: { phone?: boolean; foreign?: boolean; url?: string } = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  const socket = { remoteAddress: '127.0.0.1' };
  if (opts.phone) markPhoneSocket(socket);
  Object.assign(r, {
    headers: opts.foreign ? { host: '127.0.0.1:4173' } : { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' },
    socket, method: body === undefined ? 'GET' : 'POST', url: opts.url ?? '/',
  });
  setImmediate(() => { (r as unknown as PassThrough).end(body === undefined ? '' : JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { setHeader: () => void }).setHeader = () => { /* ignored */ };
  (out as unknown as { end: (b?: string) => void }).end = (body?: string) => { out.json = body ? JSON.parse(body) : {}; };
  return out;
}
type H = (q: IncomingMessage, s: ServerResponse, p: Record<string, string>, c: string) => Promise<void>;
async function call(h: H, root: string, params: Record<string, string>, body?: unknown, opts: Parameters<typeof req>[1] = {}) {
  const r = res();
  await h(req(body, opts), r, params, join(root, '_dream_context'));
  return r;
}

describe('owner page and runs', () => {
  it('GET lists the rateable runs joined with ratings; rate spawns the draft; a foreign origin is refused', async () => {
    const key = run(a, 'daily-digest', '2026-11-19T09:00:00.000Z');
    const rated = await call(handleScorecardRate, a, { slug: 'herodot' }, { run: key, stars: 5, note: 'Great, keep it' });
    expect(rated.status).toBe(200);
    expect(jobs).toEqual([expect.objectContaining({ kind: 'draft', member: 'herodot' })]);
    const got = await call(handleScorecardGet, a, { slug: 'herodot' });
    expect(got.status).toBe(200);
    const runs = got.json.runs as Array<{ key: string; rating: { stars: number } | null }>;
    expect(runs.map((x) => [x.key, x.rating?.stars])).toEqual([[key, 5]]);
    expect((got.json.trend as { average: number }).average).toBe(5);
    const foreign = await call(handleScorecardCriteria, a, { slug: 'herodot' }, { op: 'add', text: 'x' }, { foreign: true });
    expect(foreign.status).toBe(403);
    expect(readScorecard(a, 'herodot', home).card.criteria).toHaveLength(0);
  });

  it('Try again is refused while a check runs live, before any spawn', async () => {
    const key = run(a, 'daily-digest', '2026-11-19T09:00:00.000Z');
    addCriterion(a, 'herodot', 'Only shipped features are claimed', home);
    const first = await call(handleScorecardCheck, a, { slug: 'herodot' }, { run: key });
    expect(first.status).toBe(200);
    expect(jobs).toHaveLength(1);
    // The route's own "starting" mark (no pid yet) holds a second tap off.
    const second = await call(handleScorecardCheck, a, { slug: 'herodot' }, { run: key });
    expect(second.status).toBe(409);
    expect(second.json.error ?? second.json.code).toBe('check_running');
    expect(jobs).toHaveLength(1);
  });

  it('clearing a rating with stars null removes it', async () => {
    const key = run(a, 'daily-digest', '2026-11-19T09:00:00.000Z');
    await call(handleScorecardRate, a, { slug: 'herodot' }, { run: key, stars: 3 });
    await call(handleScorecardRate, a, { slug: 'herodot' }, { run: key, stars: null });
    expect(readScorecard(a, 'herodot', home).card.ratings[key]).toBeUndefined();
  });
});

describe('the phone (C6)', () => {
  it('a global member\'s project A ratings, checks, lessons and goal never reach a phone that may see only B', async () => {
    createGlobalAgent({ slug: 'atlas', title: 'Atlas', prompt: 'Atlas plans the fictional roadmap.', learning: false }, { approve: { now: NOW, home } } as never);
    createAutomation(join(a, '_dream_context'), { slug: 'atlas-weekly', title: 'Weekly plan', agent: 'atlas', days: 'daily', at: '09:00' }, { approve: { now: NOW, home } });
    createAutomation(join(b, '_dream_context'), { slug: 'atlas-orbit', title: 'Orbit plan', agent: 'atlas', days: 'daily', at: '09:00' }, { approve: { now: NOW, home } });
    const ka = run(a, 'atlas-weekly', '2026-11-18T09:00:00.000Z');
    const kb = run(b, 'atlas-orbit', '2026-11-19T09:00:00.000Z');
    const ra = rateRun(a, 'atlas', { run: ka, stars: 2, note: 'from acme', by: 'owner', home, now: NOW });
    rateRun(b, 'atlas', { run: kb, stars: 5, by: 'owner', home, now: NOW });
    withScorecard(a, 'atlas', (card) => {
      card.lessons.push({ id: 'le_aaaaaaaa', text: 'Acme lesson', run: ra.runKey, noteFold: 'f', at: NOW.toISOString(), status: 'active' });
      card.goal = { insight: 'acme-mrr', project: { key: ra.rating!.project.key, vault: 'acme', name: 'acme' }, baseline: 1, target: 2, linkedAt: NOW.toISOString() };
    }, { home });
    // The laptop in B sees A's rating with A's name.
    const laptop = await call(handleScorecardGet, b, { slug: 'atlas' });
    const all = (laptop.json.card as { ratings: Record<string, { project: { name: string } }> }).ratings;
    expect(Object.values(all).map((r) => r.project.name).sort()).toEqual(['acme', 'orbit']);
    // A phone that may reach only B.
    setMacExposedVaults(['orbit']);
    const phone = await call(handleScorecardGet, b, { slug: 'atlas' }, undefined, { phone: true });
    const card = phone.json.card as { ratings: Record<string, unknown>; lessons: unknown[] };
    expect(Object.keys(card.ratings)).toHaveLength(1);
    expect(Object.keys(card.ratings)[0]).toContain('atlas-orbit');
    expect(card.lessons).toHaveLength(0);
    expect(phone.json.goal).toBeNull();
    // It cannot rate a project A run, nor undo A's lesson.
    const rate = await call(handleScorecardRate, b, { slug: 'atlas' }, { run: ka, stars: 1 }, { phone: true });
    expect(rate.status).toBe(404);
    const undo = await call(handleScorecardLessonUndo, b, { slug: 'atlas', id: 'le_aaaaaaaa' }, {}, { phone: true });
    expect(undo.status).toBe(404);
    expect(readScorecard(a, 'atlas', home).card.lessons[0].status).toBe('active');
  });
});
