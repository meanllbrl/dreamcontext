import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFields, type CorpusDoc, type CorpusType } from '../../src/lib/recall.js';
import {
  AUTO_THROTTLE_MS, buildCloudIndex, cloudIndexReady, loadVectorIndex, planCloudIndex, readVectorMeta,
} from '../../src/lib/embeddings/vector-store.js';
import { VOYAGE_DIMS } from '../../src/lib/embeddings/nano.js';
import { acquireFileLock } from '../../src/lib/file-lock.js';
import { grantVaultConsent, recallCloudStatus, recordCloudUsage, revokeVaultConsent, setRecallCloudKey } from '../../src/lib/recall-cloud-config.js';
import { readIndexStop, rearmIndexStop } from '../../src/lib/embeddings/index-stop.js';
import { closeInboxRows, listInboxRows } from '../../src/lib/owner-inbox.js';

const KEY = 'or-test-key-0123456789';
let tmp: string;
let home: string;
let root: string;
const ENV_KEYS = ['DREAMCONTEXT_SPAWNED', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTO_SLEEP', 'DREAMCONTEXT_RECALL_OPENROUTER_KEY', 'DREAMCONTEXT_EVAL_MAX_USD'];
const saved: Record<string, string | undefined> = {};
const fetchSpy = vi.fn();
const FAKE_AWS = `AKIA${'ABCDEFGHIJKLMNOP'}`;

function mkDoc(slug: string, body: string, type: CorpusType = 'knowledge', dir = root): CorpusDoc {
  const path = join(dir, type, `${slug}.md`);
  mkdirSync(join(dir, type), { recursive: true });
  writeFileSync(path, body);
  const f = buildFields({ slug, title: slug, description: 'd', tags: [], body });
  return { type, path, relPath: `${type}/${slug}.md`, slug, title: slug, description: 'd', tags: [], body,
    tokens: f.tokens, tokenSet: new Set(f.tokens), termFreq: f.termFreq, fieldFreq: f.fieldFreq, fieldLen: f.fieldLen,
    links: f.links, identityTokens: f.identityTokens };
}
const corpus = (n = 4): CorpusDoc[] => Array.from({ length: n }, (_, i) => mkDoc(`doc${i}`, `unique body number ${i} about topic ${i * 7}`));

/** An OpenRouter stand-in: one distinct unit-ish vector per input; records how many inputs were sent. */
function okFetch(cost = 0.0001) {
  return async (_u: unknown, init?: RequestInit): Promise<Response> => {
    const n = (JSON.parse(String(init!.body)).input as string[]).length;
    fetchSpy(n);
    const data = Array.from({ length: n }, (_, i) => ({ index: i, embedding: Array.from({ length: VOYAGE_DIMS }, (_x, k) => (k === (fetchSpy.mock.calls.length * 31 + i) % VOYAGE_DIMS ? 1 : 0)) }));
    return new Response(JSON.stringify({ data, usage: { cost, prompt_tokens: n } }), { status: 200 });
  };
}
const sentInputs = (): number => fetchSpy.mock.calls.reduce((a, c) => a + (c[0] as number), 0);
const base: { trigger: 'explicit'; retryDelayMs: number; home?: string } = { trigger: 'explicit', retryDelayMs: 0 };

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = mkdtempSync(join(tmpdir(), 'dc-vecstore-'));
  home = join(tmp, 'home');
  root = join(tmp, 'vault', '_dream_context');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  fetchSpy.mockReset();
  base.home = home;
  setRecallCloudKey(KEY, 'manual', home);
  grantVaultConsent(root, { tier: 'cloud-index', rerankModel: null, surface: 'cli-tty' }, home);
  vi.stubGlobal('fetch', vi.fn(okFetch()));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('building', () => {
  it('embeds a consented cloud-index root through egress and reports ready', async () => {
    const docs = corpus();
    const r = await buildCloudIndex(root, 'voyage-4', docs, base);
    expect(r).toMatchObject({ embedded: 4, reused: 0, aborted: null });
    expect(cloudIndexReady(root, 'voyage-4')).toBe(true);
    const idx = loadVectorIndex(root, 'voyage-4')!;
    expect(idx.dims).toBe(VOYAGE_DIMS);
    expect(idx.chunks).toHaveLength(4);
    expect(new Set(idx.chunks.map((c) => c.docKey))).toEqual(new Set(docs.map((d) => `knowledge/${d.slug}`)));
    expect(readVectorMeta(root, 'voyage-4')).toMatchObject({ eligibleTotal: 4, coveredDocs: 4, churnStrikes: 0 });
    // a second build has nothing to do and sends nothing
    fetchSpy.mockClear();
    expect(await buildCloudIndex(root, 'voyage-4', docs, base)).toMatchObject({ embedded: 0, reused: 4 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps its files in a self-ignored directory that git really ignores', async () => {
    await buildCloudIndex(root, 'voyage-4', corpus(2), base);
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    for (const f of ['voyage-4.f32', 'voyage-4.json', 'voyage-4.meta.json', '.vault-id']) {
      expect(() => execFileSync('git', ['check-ignore', '-q', join(root, '.embeddings', f)], { cwd: tmp })).not.toThrow();
    }
  });

  it('withholds ineligible docs and chunks (they never reach a fetch body)', async () => {
    const docs = [...corpus(2), mkDoc('leaky', `task body with ${FAKE_AWS} inside`, 'task'), mkDoc('ptr', 'pointer entry', 'changelog')];
    const r = await buildCloudIndex(root, 'voyage-4', docs, base);
    expect(r.embedded).toBe(2);
    const bodies = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String((c[1] as RequestInit).body)).join('\n');
    expect(bodies).not.toContain('AKIA');
    expect(bodies).not.toContain('pointer entry');
  });

  it('resumes after a failure: what landed is checkpointed and never re-sent', async () => {
    const docs = corpus(5);
    let calls = 0;
    const flaky = okFetch();
    vi.stubGlobal('fetch', vi.fn(async (u: unknown, init?: RequestInit) => {
      if (++calls > 2) throw new TypeError('fetch failed');
      return flaky(u, init);
    }));
    await expect(buildCloudIndex(root, 'voyage-4', docs, { ...base, batchSize: 1 })).rejects.toMatchObject({ kind: 'network' });
    expect(readVectorMeta(root, 'voyage-4')).not.toBeNull();
    expect(loadVectorIndex(root, 'voyage-4')!.chunks).toHaveLength(2);
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', vi.fn(okFetch()));
    const r = await buildCloudIndex(root, 'voyage-4', docs, { ...base, batchSize: 1 });
    expect(r).toMatchObject({ embedded: 3, reused: 2, aborted: null });
    expect(sentInputs()).toBe(3);
    expect(loadVectorIndex(root, 'voyage-4')!.chunks).toHaveLength(5);
  });

  it('a long-lived process loads the index once and follows a rebuild', async () => {
    await buildCloudIndex(root, 'voyage-4', corpus(2), base);
    const first = loadVectorIndex(root, 'voyage-4')!;
    expect(loadVectorIndex(root, 'voyage-4')).toBe(first);
    await buildCloudIndex(root, 'voyage-4', corpus(4), base);
    const next = loadVectorIndex(root, 'voyage-4')!;
    expect(next).not.toBe(first);
    expect(next.chunks).toHaveLength(4);
  });

  it('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const ok = okFetch();
    vi.stubGlobal('fetch', vi.fn(async (u: unknown, init?: RequestInit) => (++calls === 1 ? new Response('{}', { status: 429 }) : ok(u, init))));
    expect(await buildCloudIndex(root, 'voyage-4', corpus(2), base)).toMatchObject({ embedded: 2, aborted: null });
    expect(calls).toBe(2);
  });

  it('prunes removed docs only when asked', async () => {
    const docs = corpus(4);
    await buildCloudIndex(root, 'voyage-4', docs, base);
    const additive = await buildCloudIndex(root, 'voyage-4', docs.slice(0, 2), base);
    expect(additive.evicted).toBe(0);
    expect(loadVectorIndex(root, 'voyage-4')!.chunks).toHaveLength(4);
    const pruned = await buildCloudIndex(root, 'voyage-4', docs.slice(0, 2), { ...base, prune: true });
    expect(pruned.evicted).toBe(2);
    expect(loadVectorIndex(root, 'voyage-4')!.chunks).toHaveLength(2);
  });
});

describe('caps and guards', () => {
  it('refuses before spending when the estimate exceeds the per-build cap', async () => {
    const r = await buildCloudIndex(root, 'voyage-4', corpus(3), { ...base, maxUsd: 1e-12 });
    expect(r.aborted).toBe('max_usd');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('aborts once spend reaches the cap mid-build', async () => {
    vi.stubGlobal('fetch', vi.fn(okFetch(10)));
    const r = await buildCloudIndex(root, 'voyage-4', corpus(4), { ...base, batchSize: 1, maxUsd: 1 });
    expect(r.aborted).toBe('max_usd');
    expect(r.embedded).toBe(1);
    expect(loadVectorIndex(root, 'voyage-4')!.chunks).toHaveLength(1);
  });

  it('holds automatic builds to the rolling 24 h cap but not explicit ones', async () => {
    recordCloudUsage(root, 'index', 2.5, {}, home);
    const auto = await buildCloudIndex(root, 'voyage-4', corpus(2), { ...base, trigger: 'auto' });
    expect(auto.aborted).toBe('daily_index_cap');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await buildCloudIndex(root, 'voyage-4', corpus(2), base)).aborted).toBeNull();
  });

  it('throttles a second automatic start inside 30 minutes', async () => {
    const docs = corpus(2);
    expect((await buildCloudIndex(root, 'voyage-4', docs, { ...base, trigger: 'auto' })).aborted).toBeNull();
    expect((await buildCloudIndex(root, 'voyage-4', docs, { ...base, trigger: 'auto' })).aborted).toBe('throttled');
    const meta = readVectorMeta(root, 'voyage-4')!;
    meta.lastAutoStartAt = new Date(Date.now() - AUTO_THROTTLE_MS - 1000).toISOString();
    writeFileSync(join(root, '.embeddings', 'voyage-4.meta.json'), JSON.stringify(meta));
    expect((await buildCloudIndex(root, 'voyage-4', docs, { ...base, trigger: 'auto' })).aborted).toBeNull();
  });

  const unthrottle = (): void => {
    const m = readVectorMeta(root, 'voyage-4')!;
    m.lastAutoStartAt = null;
    writeFileSync(join(root, '.embeddings', 'voyage-4.meta.json'), JSON.stringify(m));
  };

  it('reports repeated re-embedding but never pauses an automatic build; an explicit build resets the count', async () => {
    const docs = corpus(3);
    await buildCloudIndex(root, 'voyage-4', docs, base);
    for (let i = 0; i < 4; i++) {
      rmSync(join(root, '.embeddings', 'voyage-4.json'));
      rmSync(join(root, '.embeddings', 'voyage-4.f32'));
      fetchSpy.mockClear();
      const r = await buildCloudIndex(root, 'voyage-4', docs, { ...base, trigger: 'auto' });
      // owner 2026-11-12: the index never stops on its own judgement, the spend caps hold money
      expect(r.aborted).toBeNull();
      expect(sentInputs()).toBe(3);
      unthrottle();
    }
    const m = readVectorMeta(root, 'voyage-4')!;
    expect(m.churnStrikes).toBe(4);
    expect(m.lastChurn).toMatchObject({ embedded: 3, reembedded: 3 });
    expect(recallCloudStatus(root, home).churn).toEqual({ strikes: 4, embedded: 3, reembedded: 3 });
    expect((await buildCloudIndex(root, 'voyage-4', docs, base)).aborted).toBeNull();
    expect(readVectorMeta(root, 'voyage-4')!.churnStrikes).toBe(0);
  });

  it('migrates strikes counted before unique doc keys: a vault paused at 3 builds on the next automatic run, as a baseline', async () => {
    const docs = corpus(3);
    await buildCloudIndex(root, 'voyage-4', docs, base);
    const m = readVectorMeta(root, 'voyage-4')! as unknown as Record<string, unknown>;
    m.churnStrikes = 3;
    delete m.churnRule;
    delete m.lastChurn;
    writeFileSync(join(root, '.embeddings', 'voyage-4.meta.json'), JSON.stringify(m));
    expect(recallCloudStatus(root, home).churn).toBeNull();
    // the collision's evicted rows come back: all re-embedded, yet the baseline build is no strike
    rmSync(join(root, '.embeddings', 'voyage-4.json'));
    rmSync(join(root, '.embeddings', 'voyage-4.f32'));
    expect((await buildCloudIndex(root, 'voyage-4', docs, { ...base, trigger: 'auto' })).aborted).toBeNull();
    expect(readVectorMeta(root, 'voyage-4')).toMatchObject({ churnStrikes: 0, churnRule: 2 });
  });

  it('keeps two tasks\' same-named side files indexed: a second automatic build embeds nothing', async () => {
    const side = (task: string, body: string): CorpusDoc => {
      const d = mkDoc('plan-r1', body, 'task', join(root, 'state', 'assets', task));
      return { ...d, relPath: `state/assets/${task}/plan-r1.md` };
    };
    const docs = [side('alpha-task', 'alpha plan round one body'), side('beta-task', 'beta plan round one body'), ...corpus(2)];
    expect((await buildCloudIndex(root, 'voyage-4', docs, { ...base, trigger: 'auto' })).embedded).toBe(4);
    const keys = new Set(loadVectorIndex(root, 'voyage-4')!.chunks.map((c) => c.docKey));
    expect(keys).toContain('task/assets/alpha-task/plan-r1');
    expect(keys).toContain('task/assets/beta-task/plan-r1');
    unthrottle();
    fetchSpy.mockClear();
    expect(await buildCloudIndex(root, 'voyage-4', docs, { ...base, trigger: 'auto' })).toMatchObject({ embedded: 0, reused: 4, aborted: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readVectorMeta(root, 'voyage-4')!.churnStrikes).toBe(0);
  });

  it('a capped automatic build marks the index stale and tells the owner once; the next landed build clears both', async () => {
    const docs = corpus(2);
    await buildCloudIndex(root, 'voyage-4', docs, base);
    recordCloudUsage(root, 'index', 5, { auto: true }, home);
    const project = join(root, '..');
    const rows = () => listInboxRows(project, home).filter((r) => r.kind === 'recall-index-stopped');
    for (let i = 0; i < 2; i++) {
      expect((await buildCloudIndex(root, 'voyage-4', docs, { ...base, trigger: 'auto' })).aborted).toBe('daily_index_cap');
    }
    expect(readIndexStop(root)).toMatchObject({ reason: 'daily_index_cap', asOf: readVectorMeta(root, 'voyage-4')!.updatedAt });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].actions).toEqual(['update-index', 'dismiss']);
    // dismissed: a further stopped build of the same run raises nothing again
    closeInboxRows(project, () => true, home);
    await buildCloudIndex(root, 'voyage-4', docs, { ...base, trigger: 'auto' });
    expect(rows()).toHaveLength(0);
    expect(recallCloudStatus(root, home).indexStop).toMatchObject({ reason: 'daily_index_cap' });
    // the owner's Update is an explicit build: past the rolling cap, it lands and clears the stale state
    expect((await buildCloudIndex(root, 'voyage-4', docs, base)).aborted).toBeNull();
    expect(readIndexStop(root)).toBeNull();
    expect(recallCloudStatus(root, home).indexStop).toBeNull();
  });

  it('a failing automatic build keeps the stale date at the last landing, and a failed Update raises the row again', async () => {
    const docs = corpus(2);
    await buildCloudIndex(root, 'voyage-4', docs, base);
    const landed = readVectorMeta(root, 'voyage-4')!.updatedAt;
    const project = join(root, '..');
    const rows = () => listInboxRows(project, home).filter((r) => r.kind === 'recall-index-stopped');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })));
    const more = [...docs, mkDoc('fresh', 'a new doc that needs embedding')];
    for (let i = 0; i < 2; i++) {
      await expect(buildCloudIndex(root, 'voyage-4', more, { ...base, trigger: 'auto' })).rejects.toMatchObject({ kind: 'auth' });
      unthrottle();
    }
    // persist() stamped a fresh updatedAt on each failed build; the stop stays as of the real landing
    expect(readVectorMeta(root, 'voyage-4')!.updatedAt).not.toBe(landed);
    expect(readIndexStop(root)).toMatchObject({ reason: 'failed', error: 'auth', asOf: landed });
    expect(rows()).toHaveLength(1);
    // his Update (re-armed, row kept open) fails again: the row is raised, never silent
    rearmIndexStop(root);
    closeInboxRows(project, () => true, home);
    await expect(buildCloudIndex(root, 'voyage-4', more, base)).rejects.toMatchObject({ kind: 'auth' });
    expect(rows()).toHaveLength(1);
    expect(readIndexStop(root)!.asOf).toBe(landed);
  });

  it('allows one build per vault (lock_busy)', async () => {
    mkdirSync(join(root, '.embeddings'), { recursive: true });
    expect(acquireFileLock(join(root, '.embeddings', 'voyage-4.build.lock'), Date.now(), 60_000)).toBe(true);
    const r = await buildCloudIndex(root, 'voyage-4', corpus(2), base);
    expect(r.aborted).toBe('lock_busy');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('aborts at the next batch when consent is revoked mid-build', async () => {
    const ok = okFetch();
    vi.stubGlobal('fetch', vi.fn(async (u: unknown, init?: RequestInit) => { revokeVaultConsent(root, home); return ok(u, init); }));
    const r = await buildCloudIndex(root, 'voyage-4', corpus(4), { ...base, batchSize: 1 });
    expect(r.aborted).toBe('tier_local');
    expect(r.embedded).toBe(1);
  });
});

describe('consent', () => {
  it('embeds nothing for an unconsented root, including with evalConsent on a non-frozen root', async () => {
    revokeVaultConsent(root, home);
    for (const evalConsent of [false, true]) {
      const r = await buildCloudIndex(root, 'voyage-4', corpus(2), { ...base, evalConsent });
      expect(r).toMatchObject({ aborted: 'not_consented', embedded: 0 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.embeddings', 'voyage-4.meta.json'))).toBe(false);
  });

  it('builds a frozen eval snapshot with evalConsent, seeds from spike vectors, and charges the eval ledger', async () => {
    const snap = join(home, '.dreamcontext', 'eval-frozen', 'dc-t');
    const fr = join(snap, '_dream_context');
    mkdirSync(fr, { recursive: true });
    writeFileSync(join(snap, 'FINGERPRINT.json'), '{}');
    writeFileSync(join(snap, 'now.txt'), 'x');
    const docs = [mkDoc('a', 'frozen doc a body', 'knowledge', fr), mkDoc('b', 'frozen doc b body', 'knowledge', fr)];
    const seed = new Map<string, Float32Array>();
    const { chunkDoc } = await import('../../src/lib/embeddings/chunker.js');
    seed.set(chunkDoc(docs[0].title, docs[0].body, docs[0].description)[0].hash, new Float32Array(VOYAGE_DIMS).fill(0.03));
    const r = await buildCloudIndex(fr, 'voyage-4', docs, { ...base, trigger: 'eval', evalConsent: true, seedVectors: seed });
    expect(r).toMatchObject({ embedded: 1, reused: 1, aborted: null });
    // seeds are ignored without evalConsent
    const real = await buildCloudIndex(root, 'voyage-4', corpus(1), { ...base, seedVectors: seed });
    expect(real.reused).toBe(0);
  });

  it('stops with eval_cap when the eval ceiling is hit', async () => {
    const snap = join(home, '.dreamcontext', 'eval-frozen', 'dc-t');
    const fr = join(snap, '_dream_context');
    mkdirSync(fr, { recursive: true });
    writeFileSync(join(snap, 'FINGERPRINT.json'), '{}');
    writeFileSync(join(snap, 'now.txt'), 'x');
    process.env.DREAMCONTEXT_EVAL_MAX_USD = '0';
    const r = await buildCloudIndex(fr, 'voyage-4', [mkDoc('a', 'frozen doc a body', 'knowledge', fr)], { ...base, trigger: 'eval', evalConsent: true });
    expect(r.aborted).toBe('eval_cap');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('readiness and planning', () => {
  it('is not ready without a build, with stale rules, or with thin coverage', async () => {
    expect(cloudIndexReady(root, 'voyage-4')).toBe(false);
    await buildCloudIndex(root, 'voyage-4', corpus(4), base);
    expect(cloudIndexReady(root, 'voyage-4')).toBe(true);
    const p = join(root, '.embeddings', 'voyage-4.meta.json');
    const meta = JSON.parse(readFileSync(p, 'utf-8'));
    writeFileSync(p, JSON.stringify({ ...meta, eligibleTypesHash: 'old' }));
    expect(cloudIndexReady(root, 'voyage-4')).toBe(false);
    writeFileSync(p, JSON.stringify({ ...meta, coveredDocs: 1, eligibleTotal: 4 }));
    expect(cloudIndexReady(root, 'voyage-4')).toBe(false);
    writeFileSync(p, JSON.stringify({ ...meta, disclosureVersion: meta.disclosureVersion + 1 }));
    expect(cloudIndexReady(root, 'voyage-4')).toBe(false);
  });

  it('plans counts by type and withheld rule without any network call', () => {
    const docs = [...corpus(2), mkDoc('t', 'task text here', 'task'), mkDoc('c', 'pointer', 'changelog'), mkDoc('s', `leak ${FAKE_AWS} here`, 'task')];
    const plan = planCloudIndex(root, 'voyage-4', docs);
    expect(plan.byType).toEqual({ knowledge: 2, task: 1 });
    expect(plan.withheld).toMatchObject({ type_not_allowed: 1, secret_aws: 1 });
    expect(plan.toEmbed).toBe(3);
    expect(plan.estUsd).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
