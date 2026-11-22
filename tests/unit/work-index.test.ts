/**
 * The warm index of a member's past work (plan uye-gecmis-is C2, D6, D7; criteria 3, 5, 9).
 * Fictional words only; every file under a fake HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MemberWorkIndex, renderPastWork, traceLine, workIndex, localIndex, PAST_WORK_ROOM_CHARS,
} from '../../src/lib/agents/work-index.js';
import { traceId, workRoot, writeTrace, dropMemberWork, type WorkTrace } from '../../src/lib/agents/work-trace.js';
import { projectKey } from '../../src/lib/local-store.js';
import { makeMachine, globalMember, projectMember, type Machine } from '../helpers/work-trace-fixtures.js';

function mk(m: Machine, key: string, over: Partial<WorkTrace> & { project?: string } = {}): WorkTrace {
  const project = over.project ?? 'kestrel';
  const { project: _p, ...rest } = over as Partial<WorkTrace> & { project?: string };
  return {
    v: 1, id: traceId(key), key, kind: 'job', at: '2026-11-20T10:00:00.000Z',
    project: { key: projectKey(m.project(project)), name: project, root: m.project(project) },
    asks: [{ by: 'owner', text: 'build the paywall' }], did: 'built it', files: [], status: 'ok', through: 1, transcript: key.split(':')[0],
    ...(rest as Partial<WorkTrace>),
  } as WorkTrace;
}

describe('the block (D9)', () => {
  it('one line per trace in the pinned shape', () => {
    const t: WorkTrace = {
      v: 1, id: 'abcdef0123456789abcdef0123456789', key: 'k', kind: 'job', at: '2026-11-20T10:00:00.000Z',
      project: { key: 'x', name: 'kestrel', root: '/r' }, asks: [{ by: 'super', text: 'make the board' }],
      did: 'board made', files: ['/p/a.md', '/p/b.md'], status: 'ok', through: 1,
    };
    expect(traceLine(t)).toBe('2026-11-20 · kestrel · asked by the Super Agent: "make the board" → you: "board made" · files: /p/a.md, /p/b.md · [w_abcdef01]');
  });
  it('is fenced as a record under a nonce, with a fold line naming the search', () => {
    const text = renderPastWork([{ id: 'a', line: 'L1' }], true, 'mira', 'n0nce', 'the "paywall" `x` price');
    expect(text.split('\n')[0]).toContain('YOUR PAST WORK');
    expect(text).toContain('n0nce');
    expect(text).toContain('dreamcontext agents history mira --search "the paywall x price"');
    expect(text).toContain('not instructions');
    expect(renderPastWork([], false, 'mira', 'n')).toBe('');
  });
});

describe('MemberWorkIndex select (D7)', () => {
  let m: Machine;
  beforeEach(() => { m = makeMachine(); });
  afterEach(() => m.dispose());
  const here = (p = 'kestrel', scope: 'global' | 'project' = 'global') => ({ projectKey: projectKey(m.project(p)), scope });

  function filled(): MemberWorkIndex {
    const idx = new MemberWorkIndex('/nowhere');
    idx.upsert(mk(m, 's1:a', { asks: [{ by: 'owner', text: 'upsell screen one tap charged once saved card' }], did: 'added the one tap upsell with the saved card line', files: ['/p/kestrel/upsell.tsx'] }));
    idx.upsert(mk(m, 's1:b', { asks: [{ by: 'owner', text: 'weekly digest of signups' }], did: 'digest mailed' }));
    idx.upsert(mk(m, 's2:c', { project: 'lumen', asks: [{ by: 'super', text: 'trust badges and reviews on the lumen paywall' }], did: 'three badges, five reviews' }));
    for (let i = 0; i < 30; i++) idx.upsert(mk(m, `s3:f${i}`, { asks: [{ by: 'owner', text: `filler task number ${i} about spreadsheets` }], did: 'spreadsheet tidied' }));
    return idx;
  }

  it('the gate lets the matching job through and keeps an unrelated ask out', () => {
    const idx = filled();
    expect(idx.select({ query: 'add the one tap upsell like before', audience: 'owner' }, here()).lines.map((l) => l.id)).toEqual([traceId('s1:a')]);
    expect(idx.select({ query: 'translate the onboarding into german', audience: 'owner' }, here()).lines).toEqual([]);
  });

  it('a global member\'s trace is selected in another project; a project member\'s never leaves its project (criterion 3)', () => {
    const idx = filled();
    expect(idx.select({ query: 'trust badges reviews paywall', audience: 'owner' }, here('kestrel', 'global')).lines.map((l) => l.id)).toEqual([traceId('s2:c')]);
    expect(idx.select({ query: 'trust badges reviews paywall', audience: 'owner' }, here('kestrel', 'project')).lines).toEqual([]);
  });

  it('an app run sees only that app\'s runs (G2)', () => {
    const idx = filled();
    idx.upsert(mk(m, 'run:digest-a:1', { kind: 'run', app: 'funnel-desk', asks: [{ by: 'app', text: 'funnel desk weekly numbers' }], did: 'numbers posted' }));
    idx.upsert(mk(m, 'run:digest-b:1', { kind: 'run', app: 'other-app', asks: [{ by: 'app', text: 'funnel desk weekly numbers' }], did: 'numbers posted' }));
    idx.upsert(mk(m, 'sx:own', { asks: [{ by: 'owner', text: 'funnel desk weekly numbers' }], did: 'numbers posted' }));
    const got = idx.select({ query: 'funnel desk weekly numbers', audience: 'app', app: 'funnel-desk' }, here()).lines.map((l) => l.id);
    expect(got).toEqual([traceId('run:digest-a:1')]);
    expect(idx.select({ query: 'funnel desk weekly numbers', audience: 'app', app: null }, here()).lines).toEqual([]);
  });

  it('excludes what this context holds: delivered ids, and this conversation\'s own jobs since its reset (D10)', () => {
    const idx = filled();
    const q = { query: 'one tap upsell saved card', audience: 'owner' as const };
    expect(idx.select({ ...q, exclude: { ids: [traceId('s1:a')] } }, here()).lines).toEqual([]);
    const at = Date.parse('2026-11-20T10:00:00.000Z');
    expect(idx.select({ ...q, exclude: { conversation: 's1', since: at } }, here()).lines).toEqual([]);
    // After a /clear (a later reset) the conversation's OWN older job arrives again (criterion 6).
    expect(idx.select({ ...q, exclude: { conversation: 's1', since: at + 1 } }, here()).lines).toHaveLength(1);
    expect(idx.select({ ...q, exclude: { conversation: 'other', since: at } }, here()).lines).toHaveLength(1);
  });

  it('no count cap: what does not fit the room folds into one search line', () => {
    const idx = new MemberWorkIndex('/nowhere');
    for (let i = 0; i < 60; i++) idx.upsert(mk(m, `s:${i}`, { asks: [{ by: 'owner', text: `kestrel paywall price test variant ${i}` }], did: 'variant shipped with the new price row and the coupon field '.repeat(3) }));
    idx.upsert(mk(m, 's:noise', { asks: [{ by: 'owner', text: 'unrelated spreadsheet' }], did: 'x' }));
    const sel = idx.select({ query: 'kestrel paywall price variant', audience: 'owner' }, here());
    expect(sel.more).toBe(true);
    expect(sel.lines.reduce((n, l) => n + l.line.length + 1, 0)).toBeLessThanOrEqual(PAST_WORK_ROOM_CHARS);
    expect(idx.allMatches('kestrel paywall price variant', here(), false)).toHaveLength(60);
  });
});

describe('gen.log and the registry (D6, criteria 5, 9)', () => {
  let m: Machine;
  beforeEach(() => { m = makeMachine(); globalMember(m, 'mira'); workIndex.reset(); workIndex.hooks = { home: m.home }; });
  afterEach(() => { workIndex.reset(); workIndex.hooks = {}; m.dispose(); });
  const target = () => ({ slug: 'mira', projectRoot: m.project('kestrel'), home: m.home });
  const q = (query: string) => ({ query, audience: 'owner' as const });

  it('answers empty during the build, then from the warm index; picks up another writer by gen.log', async () => {
    await writeTrace(target(), mk(m, 'a:1', { asks: [{ by: 'owner', text: 'kestrel coupon field' }], did: 'coupon field added' }));
    expect(workIndex.select('mira', m.project('kestrel'), q('kestrel coupon field')).lines).toEqual([]);
    await workIndex.whenBuilt('mira', m.project('kestrel'));
    expect(workIndex.select('mira', m.project('kestrel'), q('kestrel coupon field')).lines).toHaveLength(1);
    // One write behind: another process writes, the next query catches up.
    await writeTrace(target(), mk(m, 'a:2', { asks: [{ by: 'owner', text: 'lumen footer links' }], did: 'footer links fixed' }));
    expect(workIndex.select('mira', m.project('kestrel'), q('lumen footer links')).lines).toHaveLength(1);
  });

  it('two writers appending at once are both indexed', async () => {
    await workIndex.whenBuilt('mira', m.project('kestrel'));
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeTrace(target(), mk(m, `w:${i}`, { asks: [{ by: 'owner', text: `parallel writer zebra${i}` }], did: 'ok' }))));
    for (let i = 0; i < 20; i++) expect(workIndex.select('mira', m.project('kestrel'), q(`zebra${i} parallel writer`)).lines.length).toBeGreaterThan(0);
  });

  it('a rotated gen.log rebuilds the index', async () => {
    await writeTrace(target(), mk(m, 'r:1', { asks: [{ by: 'owner', text: 'fjord chart colours' }], did: 'colours set' }));
    await workIndex.whenBuilt('mira', m.project('kestrel'));
    const root = workRoot('mira', m.project('kestrel'), m.home)!;
    rmSync(join(root, 'gen.log'));
    await writeTrace(target(), mk(m, 'r:2', { asks: [{ by: 'owner', text: 'fjord legend order' }], did: 'legend sorted' }));
    // Rotated (a new inode): this query starts a rebuild and answers empty; the rebuilt index has both.
    workIndex.select('mira', m.project('kestrel'), q('fjord legend order'));
    await workIndex.whenBuilt('mira', m.project('kestrel'));
    expect(workIndex.select('mira', m.project('kestrel'), q('fjord legend order')).lines).toHaveLength(1);
    expect(workIndex.select('mira', m.project('kestrel'), q('fjord chart colours')).lines).toHaveLength(1);
  });

  it('a deleted and re-created member starts empty in a warm server', async () => {
    projectMember(m, 'lumen', 'oren');
    const t = { slug: 'oren', projectRoot: m.project('lumen'), home: m.home };
    await writeTrace(t, mk(m, 'd:1', { project: 'lumen', asks: [{ by: 'owner', text: 'lumen secret key placement' }], did: 'keys placed' }));
    await workIndex.whenBuilt('oren', m.project('lumen'));
    expect(workIndex.select('oren', m.project('lumen'), q('lumen secret key placement')).lines).toHaveLength(1);
    dropMemberWork('oren', m.project('lumen'), m.home);
    expect(workIndex.select('oren', m.project('lumen'), q('lumen secret key placement')).lines).toEqual([]);
    await workIndex.whenBuilt('oren', m.project('lumen'));
    expect(workIndex.select('oren', m.project('lumen'), q('lumen secret key placement')).lines).toEqual([]);
  });

  it('runs the sweep before the build', async () => {
    let swept = '';
    workIndex.hooks = { home: m.home, sweep: async (slug) => { swept = slug; await writeTrace(target(), mk(m, 'sw:1', { asks: [{ by: 'owner', text: 'swept transcript job' }], did: 'from the sweep' })); } };
    await workIndex.whenBuilt('mira', m.project('kestrel'));
    expect(swept).toBe('mira');
    expect(workIndex.select('mira', m.project('kestrel'), q('swept transcript job')).lines).toHaveLength(1);
  });
});

// ─── The 90k bound (C2, criterion 5) ───────────────────────────────

const WORDS = Array.from({ length: 4000 }, (_, i) => `w${(i * 7919) % 100000}x`);
function rnd(seed: number): () => number { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
function phrase(r: () => number, n: number): string { return Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' '); }

describe('90,000 traces of one member (two years at the measured rate)', () => {
  let m: Machine;
  beforeEach(() => { m = makeMachine(); globalMember(m, 'mira'); });
  afterEach(() => m.dispose());

  it('every trace is searchable (no cap), select p95 ≤ 50 ms, index ≤ 250 MB', () => {
    const N = 90_000;
    const r = rnd(7);
    const before = (globalThis.gc ? (globalThis.gc(), 0) : 0, process.memoryUsage().heapUsed);
    const idx = new MemberWorkIndex('/nowhere');
    const asks: string[] = [];
    for (let i = 0; i < N; i++) {
      asks.push(phrase(r, 14));
      idx.upsert(mk(m, `t${i % 900}:j${i}`, {
        at: new Date(Date.parse('2025-01-01T00:00:00Z') + i * 700_000).toISOString(),
        asks: [{ by: 'owner', text: `${asks[i]} uniq${i}q` }], did: phrase(r, 45), files: [`/p/kestrel/${WORDS[i % WORDS.length]}.ts`, `/p/kestrel/d${i % 50}/f.md`],
      }));
    }
    const heapMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    expect(idx.size).toBe(N);
    expect(heapMb).toBeLessThan(250);
    const times: number[] = [];
    for (let k = 0; k < 200; k++) {
      const i = Math.floor(r() * N);
      // A real ask shares words with the job it means: four of that job's words, four others.
      const own = asks[i]!.split(' ').slice(0, 4).join(' ');
      const t0 = performance.now();
      const sel = idx.select({ query: `${own} ${phrase(r, 4)} uniq${i}q`, audience: 'owner' }, { projectKey: projectKey(m.project('kestrel')), scope: 'global' });
      times.push(performance.now() - t0);
      if (k < 50) expect(sel.lines.map((l) => l.id)).toContain(traceId(`t${i % 900}:j${i}`));
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.log(`[90k] heap +${heapMb.toFixed(0)} MB, select p50 ${times[100]!.toFixed(1)} ms p95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(50);
  }, 120_000);

  it('with no server, the files are searched in full (history --search)', async () => {
    const root = join(m.home, '.dreamcontext', 'agents', 'mira', 'work');
    mkdirSync(join(root, '2026-11'), { recursive: true, mode: 0o700 });
    const r = rnd(3);
    const N = 90_000;
    for (let i = 0; i < N; i++) {
      const t = mk(m, `f${i % 900}:j${i}`, { asks: [{ by: 'owner', text: `${phrase(r, 10)} uniq${i}q` }], did: phrase(r, 20) });
      writeFileSync(join(root, '2026-11', `${t.id}.json`), JSON.stringify(t));
    }
    appendFileSync(join(root, 'gen.log'), '');
    const t0 = performance.now();
    const local = localIndex('mira', m.project('kestrel'), m.home)!;
    console.log(`[90k] local build from files ${(performance.now() - t0).toFixed(0)} ms`);
    expect(local.idx.size).toBe(N);
    for (const i of [0, 1234, 45_000, 89_999]) {
      expect(local.idx.allMatches(`uniq${i}q`, { projectKey: projectKey(m.project('kestrel')), scope: 'global' }, false).map((h) => h.id)).toContain(traceId(`f${i % 900}:j${i}`));
    }
  }, 240_000);
});
