import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInsight, readCache, getInsight } from '../../src/lib/lab/store.js';
import { syncInsight, syncAll } from '../../src/lib/lab/sync.js';
import { createObjective, getObjective } from '../../src/lib/objectives-store.js';
import { writeFrontmatter, readFrontmatter } from '../../src/lib/frontmatter.js';
import { writeCredential } from '../../src/lib/lab/credentials.js';

let root: string;

function scriptPath(slug: string): string {
  return join(root, 'lab', 'scripts', `${slug}.mjs`);
}

function writeScript(slug: string, body: string): void {
  mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
  writeFileSync(scriptPath(slug), body, 'utf-8');
}

/** Point an insight's source at a script (createInsight seeds an http source by default). */
function useScriptSource(slug: string, file: string): void {
  const path = join(root, 'lab', 'insights', `${slug}.md`);
  const { data, content } = readFrontmatter(path);
  writeFrontmatter(path, { ...data, source: { adapter: 'script', script: { file } } }, content);
}

function addBinding(slug: string, objective: string, value = 'latest'): void {
  const path = join(root, 'lab', 'insights', `${slug}.md`);
  const { data, content } = readFrontmatter(path);
  writeFrontmatter(path, { ...data, binding: { objective, value } }, content);
}

/** Point an insight's http source at an endpoint carrying a {{cred:key}} placeholder. */
function useHttpSourceWithCred(slug: string, endpoint: string): void {
  const path = join(root, 'lab', 'insights', `${slug}.md`);
  const { data, content } = readFrontmatter(path);
  writeFrontmatter(path, {
    ...data,
    source: {
      adapter: 'http',
      http: { endpoint, method: 'GET', headers: {}, body: null, extract: { seriesPath: 'data', seriesKey: null, x: 'date', y: 'value', agg: 'last' } },
    },
  }, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-sync-'));
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('syncInsight — TTL staleness + force', () => {
  it('skips a fresh insight within ttl_minutes, reporting the skip (not silent)', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU', ttl_minutes: 1440 });
    useScriptSource('wau', 'scripts/wau.mjs');
    writeScript('wau', 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 1 }] }];\n');

    const first = await syncInsight(root, 'wau');
    expect(first.status).toBe('ok');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const second = await syncInsight(root, 'wau');
    expect(second.status).toBe('fresh');
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('fresh'))).toBe(true);
  });

  it('--force re-fetches even when fresh', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    writeScript('wau', 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 1 }] }];\n');
    await syncInsight(root, 'wau');
    const forced = await syncInsight(root, 'wau', { force: true });
    expect(forced.status).toBe('ok');
  });
});

describe('syncInsight — loud failure, no silent half-sync', () => {
  it('on adapter failure keeps the prior series and sets error+errorAt', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    writeScript('wau', 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 7 }] }];\n');
    await syncInsight(root, 'wau');

    writeScript('wau', 'export default async () => { throw new Error("boom"); };\n');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await syncInsight(root, 'wau', { force: true });
    expect(result.status).toBe('failed');

    const cache = readCache(root, 'wau')!;
    expect(cache.error).toBeTruthy();
    expect(cache.errorAt).toBeTruthy();
    // Prior series preserved.
    expect(cache.series).toEqual([{ name: 'd', points: [{ t: '2026-01-01', v: 7 }] }]);
  });

  it('syncAll returns a non-empty failed[] and aggregates results from every insight', async () => {
    createInsight(root, { slug: 'good', title: 'Good' });
    useScriptSource('good', 'scripts/good.mjs');
    writeScript('good', 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 1 }] }];\n');

    createInsight(root, { slug: 'bad', title: 'Bad' });
    useScriptSource('bad', 'scripts/bad.mjs');
    writeScript('bad', 'export default async () => { throw new Error("nope"); };\n');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { results, failed } = await syncAll(root, { force: true });
    expect(results).toHaveLength(2);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.map((f) => f.slug)).toContain('bad');
  });
});

describe('syncInsight — KR binding write', () => {
  it('writes metric.current via updateObjectiveMetric when the binding resolves to a finite latest', async () => {
    createObjective(root, { slug: 'mrr', title: 'MRR', metric: { label: 'MRR', unit: 'USD', baseline: 0, target: 2000, current: 0 } });
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    addBinding('wau', 'mrr');
    writeScript('wau', 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 1234 }] }];\n');

    await syncInsight(root, 'wau');
    expect(getObjective(root, 'mrr')!.metric!.current).toBe(1234);
  });

  it('warns loudly and writes NOTHING when the objective has no metric', async () => {
    createObjective(root, { slug: 'no-metric', title: 'No metric' });
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    addBinding('wau', 'no-metric');
    writeScript('wau', 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 1234 }] }];\n');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await syncInsight(root, 'wau');
    expect(getObjective(root, 'no-metric')!.metric).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('warns loudly and writes NOTHING when the bound series is empty (non-finite latest)', async () => {
    createObjective(root, { slug: 'mrr', title: 'MRR', metric: { label: 'MRR', unit: 'USD', baseline: 0, target: 2000, current: 500 } });
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    addBinding('wau', 'mrr');
    writeScript('wau', 'export default async () => [{ name: "d", points: [] }];\n');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await syncInsight(root, 'wau');
    expect(getObjective(root, 'mrr')!.metric!.current).toBe(500); // untouched
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('syncInsight — script-hash tripwire', () => {
  it('records scriptHash on success; a subsequent change prints the loud notice BEFORE executing', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    writeScript('wau', 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 1 }] }];\n');
    await syncInsight(root, 'wau');
    const firstHash = readCache(root, 'wau')!.scriptHash;
    expect(firstHash).toBeTruthy();

    // Change the script content.
    writeScript('wau', 'export default async () => [{ name: "d", points: [{ t: "2026-01-02", v: 2 }] }];\n');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await syncInsight(root, 'wau', { force: true });
    expect(result.status).toBe('ok');
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('script changed since last run'))).toBe(true);

    const secondHash = readCache(root, 'wau')!.scriptHash;
    expect(secondHash).not.toBe(firstHash);
  });

  it('does NOT fire the notice when the script is unchanged', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    useScriptSource('wau', 'scripts/wau.mjs');
    writeScript('wau', 'export default async () => [{ name: "d", points: [{ t: "2026-01-01", v: 1 }] }];\n');
    await syncInsight(root, 'wau');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await syncInsight(root, 'wau', { force: true });
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('script changed since last run'))).toBe(false);
  });
});

describe('syncInsight — end-to-end secret redaction (AC10)', () => {
  // These two tests use their OWN isolated projectRoot/contextRoot pair (rather
  // than the shared `root` from the outer beforeEach) because writeCredential
  // needs a real project root distinct from contextRoot to write the root
  // .gitignore into — reusing `root`'s parent would write into the shared OS
  // temp directory itself.
  let credProjectRoot: string;
  let credContextRoot: string;

  beforeEach(() => {
    credProjectRoot = mkdtempSync(join(tmpdir(), 'dc-lab-sync-cred-project-'));
    credContextRoot = join(credProjectRoot, '_dream_context');
    mkdirSync(join(credContextRoot, 'core'), { recursive: true });
  });

  afterEach(() => {
    rmSync(credProjectRoot, { recursive: true, force: true });
  });

  it('a non-2xx HTTP response against a {{cred:key}}-templated manifest writes a redacted cache.error and console.error line — never the real credential nor the raw response body', async () => {
    writeCredential(credProjectRoot, credContextRoot, 'apiKey', 'sk-super-secret-value');
    createInsight(credContextRoot, { slug: 'wau', title: 'WAU' });
    root = credContextRoot; // useHttpSourceWithCred/useScriptSource close over `root`
    useHttpSourceWithCred('wau', 'https://api.example.test/v1/metric?key={{cred:apiKey}}');

    // 404 (not 5xx/429) so the underlying ApiAdapter throws immediately with no
    // retry/backoff delay — keeps this test fast without touching production timing.
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => 'raw-echoed-response-body-snippet',
    })) as unknown as typeof fetch;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await syncInsight(credContextRoot, 'wau', { fetchImpl });
    expect(result.status).toBe('failed');

    const cache = readCache(credContextRoot, 'wau')!;
    expect(cache.error).toBeTruthy();
    expect(cache.error).not.toContain('sk-super-secret-value');
    expect(cache.error).not.toContain('raw-echoed-response-body-snippet');
    expect(cache.error).toContain('***');

    const loggedText = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(loggedText).not.toContain('sk-super-secret-value');
    expect(loggedText).not.toContain('raw-echoed-response-body-snippet');
  });

  it('a thrown custom-script against a credentialed insight writes a redacted cache.error and console.error line — never the real credential value', async () => {
    writeCredential(credProjectRoot, credContextRoot, 'apiKey', 'sk-another-secret');
    createInsight(credContextRoot, { slug: 'wau', title: 'WAU' });
    root = credContextRoot;
    useScriptSource('wau', 'scripts/wau.mjs');
    writeScript('wau', 'export default async (ctx) => { throw new Error(`auth failed for key ${ctx.credentials.apiKey}`); };\n');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await syncInsight(credContextRoot, 'wau');
    expect(result.status).toBe('failed');

    const cache = readCache(credContextRoot, 'wau')!;
    expect(cache.error).not.toContain('sk-another-secret');
    expect(cache.error).toContain('***');

    const loggedText = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(loggedText).not.toContain('sk-another-secret');
  });
});
