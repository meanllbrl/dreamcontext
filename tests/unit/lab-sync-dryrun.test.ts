import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli/program.js';
import { createInsight, readCache, writeCache } from '../../src/lib/lab/store.js';
import { planSyncInsight, syncAll, syncInsight } from '../../src/lib/lab/sync.js';
import { readFrontmatter, writeFrontmatter } from '../../src/lib/frontmatter.js';

/**
 * `lab sync --dry-run` says what a run WOULD fetch, probe or skip, and fires
 * ZERO upstream requests: measured with a counting global fetch and a script
 * whose mere execution leaves a file behind. The plan is also checked against
 * what a real run then does, so the dry run cannot drift from the gate.
 */

const DATA_URL = 'https://api.example.com/v1/metric';
const PROBE_URL = 'https://api.example.com/v1/meta';
const MIN = 60_000;

let projectRoot: string;
let root: string;
let cwd: string;
let calls: string[];

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const countingFetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  calls.push(url);
  if (url.startsWith(PROBE_URL)) return json({ meta: { lastModified: 'm1', note: 'Table refreshed 06:00 UTC' } });
  return json({ data: [{ date: '2026-09-29', value: 7 }] });
}) as typeof fetch;

function httpInsight(slug: string): void {
  createInsight(root, { slug, title: slug, ttl_minutes: 60 });
  const path = join(root, 'lab', 'insights', `${slug}.md`);
  const { data, content } = readFrontmatter<Record<string, unknown>>(path);
  writeFrontmatter(path, {
    ...data,
    source: {
      adapter: 'http',
      http: {
        endpoint: DATA_URL,
        method: 'GET',
        headers: {},
        body: null,
        extract: { seriesPath: 'data', seriesKey: null, x: 'date', y: 'value', agg: 'last' },
      },
    },
    refresh: { ttl_minutes: 60, freshness: { url: PROBE_URL, extract: { marker: 'meta.lastModified', note: 'meta.note' } } },
  }, content);
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const push = (...a: unknown[]): void => { lines.push(a.map(String).join(' ')); };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(push),
    vi.spyOn(console, 'error').mockImplementation(push),
    vi.spyOn(console, 'warn').mockImplementation(push),
  ];
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  // eslint-disable-next-line no-control-regex
  return { code, out: lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '') };
}

const SCRIPT_RAN = (): string => join(projectRoot, 'script-ran.txt');

beforeEach(async () => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lab-dryrun-')));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  calls = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const now = Date.now();
  // fresh: synced a minute ago (TTL 60) -> skip (ttl)
  httpInsight('fresh');
  await syncInsight(root, 'fresh', { force: 'hard', fetchImpl: countingFetch, now: () => now - MIN });
  // marker: synced 2h ago WITH a marker -> probe; the fetch only if upstream changed
  httpInsight('marker');
  await syncInsight(root, 'marker', { force: 'user', fetchImpl: countingFetch, now: () => now - 120 * MIN });
  // never: no cache -> fetch (probe first to record the marker)
  httpInsight('never');
  // broken: failed 5 min ago -> automatic backs off
  httpInsight('broken');
  writeCache(root, 'broken', {
    slug: 'broken', fetchedAt: new Date(now - 180 * MIN).toISOString(), tweaks: {}, granularity: 'daily', unit: null,
    series: [], latest: 3, error: 'upstream 500', errorAt: new Date(now - 5 * MIN).toISOString(), scriptHash: null,
  });
  // scripted: a script whose execution is observable
  createInsight(root, { slug: 'scripted', title: 'Scripted', ttl_minutes: 60 });
  const path = join(root, 'lab', 'insights', 'scripted.md');
  const { data, content } = readFrontmatter<Record<string, unknown>>(path);
  writeFrontmatter(path, { ...data, source: { adapter: 'script', script: { file: 'scripts/scripted.mjs' } } }, content);
  mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
  writeFileSync(join(root, 'lab', 'scripts', 'scripted.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(SCRIPT_RAN())}, 'ran');\nexport default async () => [{ name: 'd', points: [{ t: '2026-09-29', v: 1 }] }];\n`);

  calls = [];
  vi.stubGlobal('fetch', countingFetch);
  process.chdir(projectRoot);
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('lab sync --dry-run', () => {
  it('plans fetch / probe / skip with reasons and sends ZERO upstream requests', async () => {
    const before = ['fresh', 'marker', 'broken'].map((s) => readFileSync(join(root, 'lab', 'cache', `${s}.json`), 'utf-8'));
    const { code, out } = await run(['lab', 'sync', '--all', '--dry-run', '--json']);
    expect(code).toBe(0);
    const plans = Object.fromEntries(JSON.parse(out).plans.map((p: any) => [p.slug, p]));
    expect(plans.fresh).toMatchObject({ action: 'skip', reason: 'ttl' });
    expect(plans.marker).toMatchObject({ action: 'probe', reason: 'stale', probe: true });
    expect(plans.never).toMatchObject({ action: 'fetch', reason: 'no-cache', probe: true });
    expect(plans.broken).toMatchObject({ action: 'skip', reason: 'error-backoff' });
    expect(plans.scripted).toMatchObject({ action: 'fetch', reason: 'no-cache', probe: false });

    expect(calls).toEqual([]);
    expect(existsSync(SCRIPT_RAN())).toBe(false);
    expect(['fresh', 'marker', 'broken'].map((s) => readFileSync(join(root, 'lab', 'cache', `${s}.json`), 'utf-8'))).toEqual(before);
    expect(existsSync(join(root, 'lab', 'cache', 'never.json'))).toBe(false);
    expect(existsSync(join(root, 'state', '.lab-freshness.json'))).toBe(false);
  });

  it('--force-hard plans a full fetch everywhere, --force skips the TTL but still probes; text output names the actions', async () => {
    const hard = JSON.parse((await run(['lab', 'sync', '--all', '--dry-run', '--force-hard', '--json'])).out);
    expect(hard.force).toBe('hard');
    expect(hard.plans.every((p: any) => p.action === 'fetch' && p.probe === false)).toBe(true);
    const user = JSON.parse((await run(['lab', 'sync', '--all', '--dry-run', '--force', '--json'])).out);
    const byUser = Object.fromEntries(user.plans.map((p: any) => [p.slug, p]));
    expect(byUser.fresh).toMatchObject({ action: 'fetch', reason: 'user' }); // synced hard: no marker, so nothing to skip on
    expect(byUser.marker).toMatchObject({ action: 'probe', reason: 'user' });
    expect(byUser.broken).toMatchObject({ action: 'fetch' });
    const text = await run(['lab', 'sync', '--all', '--dry-run']);
    expect(text.out).toMatch(/skip\s+fresh/);
    expect(text.out).toMatch(/probe\s+marker/);
    expect(text.out).toMatch(/fetch\s+never/);
    expect(text.out).toContain('no request sent');
    expect(calls).toEqual([]);
    expect(existsSync(SCRIPT_RAN())).toBe(false);
  });

  it('the plan is what a real automatic run then does', async () => {
    const plans = Object.fromEntries(['fresh', 'marker', 'never', 'broken'].map((s) => [s, planSyncInsight(root, s)]));
    const results = Object.fromEntries((await syncAll(root, { only: ['fresh', 'marker', 'never', 'broken'], fetchImpl: countingFetch })).results.map((r) => [r.slug, r]));
    expect(results.fresh).toMatchObject({ status: 'fresh', reason: plans.fresh.reason });
    expect(results.broken).toMatchObject({ status: 'skipped', reason: plans.broken.reason });
    // probe: 1 probe, 0 data fetches, upstream unchanged
    expect(results.marker).toMatchObject({ status: 'fresh', reason: 'upstream-unchanged' });
    expect(calls.filter((u) => u.startsWith(PROBE_URL))).toHaveLength(2); // marker + never
    expect(calls.filter((u) => u.startsWith(DATA_URL))).toHaveLength(1); // never only
    expect(results.never.status).toBe('ok');
  });
});

describe('lab sync prints the skip and fresh reasons', () => {
  it('skipped with its reason, fresh with its reason, and the freshnessNote', async () => {
    const skipped = await run(['lab', 'sync', 'broken']);
    expect(skipped.code).toBe(0);
    expect(skipped.out).toMatch(/broken: skipped \(backing off a recent failure: upstream 500\)/);
    const fresh = await run(['lab', 'sync', 'fresh']);
    expect(fresh.out).toMatch(/fresh: fresh \(inside its TTL; skipped\)/);
    const unchanged = await run(['lab', 'sync', 'marker', '--force']);
    expect(unchanged.out).toMatch(/marker: fresh \(upstream unchanged; skipped\) · source: Table refreshed 06:00 UTC/);
    expect(calls.filter((u) => u.startsWith(DATA_URL))).toHaveLength(0);
    expect(readCache(root, 'marker')?.sourceFreshness?.note).toBe('Table refreshed 06:00 UTC');
  });
});
