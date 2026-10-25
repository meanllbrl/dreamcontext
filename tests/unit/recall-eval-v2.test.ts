import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FROZEN_DIR,
  SNAPSHOT_ID,
  assertNotSpawned,
  assertUnder,
  bootstrapP90,
  evaluateSearch,
  formatLangTable,
  frozenDir,
  loadEngine,
  loadNow,
  pairedR5,
  sealedDir,
  signTest,
  wilson,
  type Engine,
  type GoldQuery,
  type SearchFn,
} from '../../eval/harness.js';
import { parseArgs, run, selfCheck, type RecallEvalArgs } from '../../scripts/recall-eval.js';
import { childEnv, headerLabels, parseArgs as parseHookArgs } from '../../scripts/hook-latency.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'recall-eval-v2-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const q = (id: string, lang: string, expected: string, category = 'paraphrase'): GoldQuery =>
  ({ id, query: `query ${id}`, expected: [expected], category, lang });

/** A fake search: returns the listed keys (as hits with a given raw score) per query text. */
function fakeSearch(table: Record<string, string[]>, score: number | null = 5): SearchFn {
  return async (query) => (table[query] ?? []).map((key) => {
    const [type, slug] = key.split('/');
    const doc = { type, slug } as never;
    return score === null ? doc : ({ doc, score, rankScore: 1, snippet: '' } as never);
  });
}

describe('statistics', () => {
  it('wilson: empty is the full range, bounds contain the point estimate', () => {
    expect(wilson(0, 0)).toEqual([0, 100]);
    const [lo, hi] = wilson(23, 25);
    expect(lo).toBeLessThan(92);
    expect(hi).toBeGreaterThan(92);
    expect(lo).toBeGreaterThan(70);
    expect(wilson(25, 25)[1]).toBeCloseTo(100, 5);
    expect(wilson(0, 25)[0]).toBeCloseTo(0, 5);
  });

  it('signTest: exact two-sided binomial', () => {
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(5, 0)).toBeCloseTo(0.0625, 6);
    expect(signTest(8, 2)).toBeCloseTo(0.109375, 6);
    expect(signTest(3, 3)).toBe(1);
    expect(signTest(10, 0)).toBeCloseTo(2 / 1024, 8);
    expect(signTest(2, 8)).toBeCloseTo(signTest(8, 2), 10);
  });

  it('bootstrapP90: deterministic, inside the data range, empty is [0,0]', () => {
    const ms = Array.from({ length: 50 }, (_, i) => 100 + i * 10);
    const a = bootstrapP90(ms);
    expect(bootstrapP90(ms)).toEqual(a);
    expect(a[0]).toBeGreaterThanOrEqual(100);
    expect(a[1]).toBeLessThanOrEqual(590);
    expect(a[0]).toBeLessThanOrEqual(a[1]);
    expect(bootstrapP90([])).toEqual([0, 0]);
  });
});

describe('evaluateSearch (per-language)', () => {
  const gold: GoldQuery[] = [
    q('a1', 'tr', 'knowledge/a'),
    q('a2', 'tr', 'knowledge/b'),
    q('b1', 'en', 'knowledge/c', 'exact-term'),
    q('c1', 'mixed', 'knowledge/d'),
  ];
  const table: Record<string, string[]> = {
    'query a1': ['knowledge/a'],                                   // rank 1
    'query a2': ['x/1', 'x/2', 'x/3', 'x/4', 'knowledge/b'],       // rank 5
    'query b1': ['x/1', 'knowledge/c'],                            // rank 2
    'query c1': ['x/1', 'x/2', 'x/3', 'x/4', 'x/5', 'knowledge/d'], // rank 6 (miss @5)
  };

  it('aggregates overall, by language and by language × category with ranks and hits', async () => {
    const rep = await evaluateSearch(fakeSearch(table), gold, { warmup: 0 });
    expect(rep.overall.n).toBe(4);
    expect(rep.overall.recall5).toBe(75);
    expect(rep.byLang.tr.recall1).toBe(50);
    expect(rep.byLang.tr.recall5).toBe(100);
    expect(rep.byLang.mixed.recall5).toBe(0);
    expect(rep.byLang.tr.r5ci[0]).toBeLessThan(100);
    expect(rep.byLangCategory.en['exact-term'].recall3).toBe(100);
    expect(rep.perQuery.find((p) => p.id === 'a2')!.rank).toBe(5);
    expect(rep.perQuery.find((p) => p.id === 'a1')!.hits).toEqual(['knowledge/a']);
    expect(rep.latency.p90ci).toHaveLength(2);
  });

  it('warmup queries are untimed and not counted', async () => {
    let calls = 0;
    const counting: SearchFn = async (query) => { calls++; return fakeSearch(table)(query, 10); };
    const rep = await evaluateSearch(counting, gold, { warmup: 2 });
    expect(calls).toBe(gold.length + 2);
    expect(rep.overall.n).toBe(gold.length);
  });

  it('injection follows the hook gate (score ≥ 2.0 within the printed window)', async () => {
    const weak = await evaluateSearch(fakeSearch(table, 1.5), gold, { warmup: 0 });
    expect(weak.overall.injectionRate).toBe(0);
    expect(weak.overall.effective5).toBe(0);
    const strong = await evaluateSearch(fakeSearch(table, 5), gold, { warmup: 0 });
    expect(strong.overall.injectionRate).toBe(100);
    expect(strong.overall.effective5).toBe(75);
    const nonempty = await evaluateSearch(fakeSearch(table, 0), gold, { warmup: 0, injectRule: 'nonempty' });
    expect(nonempty.overall.injectionRate).toBe(100);
    // Hits without a score (dense-only docs) count as injected under the gate.
    const unscored = await evaluateSearch(fakeSearch(table, null), gold, { warmup: 0 });
    expect(unscored.overall.injectionRate).toBe(100);
  });

  it('pairedR5 counts discordant r@5 pairs per language', async () => {
    const a = await evaluateSearch(fakeSearch(table), gold, { warmup: 0 });
    const worse = await evaluateSearch(fakeSearch({ ...table, 'query a1': [] }), gold, { warmup: 0 });
    expect(pairedR5(a, worse)).toMatchObject({ wins: 1, losses: 0 });
    expect(pairedR5(a, worse, 'en')).toMatchObject({ wins: 0, losses: 0, p: 1 });
    expect(pairedR5(worse, a).losses).toBe(1);
  });

  it('formatLangTable prints one row per language plus overall', async () => {
    const rep = await evaluateSearch(fakeSearch(table), gold, { warmup: 0 });
    const text = formatLangTable({ raw: rep });
    for (const lang of ['tr', 'en', 'mixed', 'overall']) expect(text).toContain(`raw | ${lang} |`);
  });
});

describe('frozen-dir plumbing', () => {
  it('frozenDir(home) sits under <home>/.dreamcontext and the constant is the default', () => {
    expect(frozenDir('/h')).toBe('/h/.dreamcontext/eval-frozen');
    expect(FROZEN_DIR).toBe(frozenDir());
    expect(sealedDir('/h')).toBe(`/h/.dreamcontext/eval-frozen/${SNAPSHOT_ID}/sealed`);
  });

  it('assertUnder follows symlinks, rejects siblings and the dir itself, accepts not-yet-created paths', () => {
    const base = join(tmp, 'eval-frozen');
    const evil = join(tmp, 'eval-frozen-evil');
    const live = join(tmp, 'live');
    for (const d of [base, evil, live]) mkdirSync(d, { recursive: true });
    symlinkSync(live, join(base, 'link'));
    expect(assertUnder(base, join(base, 'a', 'b'), 'x')).toBe(join(base, 'a', 'b'));
    expect(() => assertUnder(base, base, 'x')).toThrow(/must be under/);
    expect(() => assertUnder(base, evil, 'x')).toThrow(/must be under/);
    expect(() => assertUnder(base, join(base, '..', 'live'), 'x')).toThrow(/must be under/);
    expect(() => assertUnder(base, join(base, 'link', 'doc'), 'x')).toThrow(/must be under/);
  });

  it('loadNow reads @<dir>/now.txt, ISO, and rejects garbage', () => {
    writeFileSync(join(tmp, 'now.txt'), '2026-10-10T12:00:00.000Z\n');
    expect(loadNow(`@${tmp}`).toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(loadNow('2026-01-01T00:00:00Z').getUTCFullYear()).toBe(2026);
    expect(() => loadNow('not a date')).toThrow(/ISO/);
  });
});

describe('spawn guard', () => {
  it('refuses with a spawn marker, passes without', () => {
    expect(() => assertNotSpawned('recall-eval', { DREAMCONTEXT_SPAWNED: 'develop' })).toThrow(/spawned session/);
    expect(() => assertNotSpawned('recall-eval', { DREAMCONTEXT_AUTOMATION_RUN: 'daily' })).toThrow(/spawned session/);
    expect(() => assertNotSpawned('recall-eval', {})).not.toThrow();
  });

  it('hook-latency child env carries no spawn marker', () => {
    const env = childEnv({ DREAMCONTEXT_SPAWNED: 'develop', DREAMCONTEXT_AUTO_SLEEP: '1', PATH: '/bin' }, { X: '1' });
    expect(env.DREAMCONTEXT_SPAWNED).toBeUndefined();
    expect(env.DREAMCONTEXT_AUTO_SLEEP).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(env.X).toBe('1');
  });
});

describe('recall-eval CLI', () => {
  it('parseArgs requires exactly one of --mode/--tier/--dense-only', () => {
    expect(() => parseArgs(['--split', 'train'])).toThrow(/exactly one/);
    expect(() => parseArgs(['--mode', 'raw', '--tier', 'local'])).toThrow(/exactly one/);
    expect(parseArgs(['--split', 'train', '--mode', 'raw']).mode).toBe('raw');
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('parseArgs validates rerank-model, split and inject-k', () => {
    expect(() => parseArgs(['--tier', 'local', '--rerank-model', 'rerank-2.5'])).toThrow(/tier cloud only/);
    expect(parseArgs(['--tier', 'cloud', '--rerank-model', 'rerank-2.5-lite']).rerankModel).toBe('voyageai/rerank-2.5-lite');
    expect(parseArgs(['--tier', 'cloud', '--rerank-model', 'none']).rerankModel).toBeNull();
    expect(() => parseArgs(['--split', 'nope', '--mode', 'raw'])).toThrow(/--split/);
    expect(() => parseArgs(['--mode', 'raw', '--inject-k', '0'])).toThrow(/inject-k/);
    expect(() => parseArgs(['--split', 'train', '--gold', 'a.jsonl', '--mode', 'raw'])).toThrow(/not both/);
  });

  it('the loader reproduces the in-tree ranking (self-check) and detects a divergent engine', async () => {
    const root = join(tmp, '_dream_context');
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    for (const [slug, body] of [['alpha', 'recall ranking bm25 fusion'], ['beta', 'sleep consolidation debt scoring'], ['gamma', 'dashboard security origin check']]) {
      writeFileSync(join(root, 'knowledge', `${slug}.md`), `---\nname: ${slug}\ndescription: ${slug} doc\n---\n${body}\n`);
    }
    const engine = await loadEngine('.');
    const corpus = engine.stableCorpus(root);
    expect(corpus).toHaveLength(3);
    const gold = [q('s1', 'en', 'knowledge/beta'), { ...q('s2', 'en', 'knowledge/alpha'), query: 'bm25 fusion ranking' }];
    const now = new Date('2026-10-10T12:00:00Z');
    expect(() => selfCheck(engine, corpus, gold, now)).not.toThrow();
    const broken: Engine = { ...engine, bm25Search: (query, c, k, o) => engine.bm25Search(query, c, k, o).reverse() };
    expect(() => selfCheck(broken, corpus, [{ ...gold[1], query: 'alpha beta gamma doc' }], now)).toThrow(/self-check failed/);
  });

  describe('sealed runs', () => {
    const argsFor = (over: Partial<RecallEvalArgs>): RecallEvalArgs => ({
      ...parseArgs(['--split', 'heldout', '--mode', 'raw']),
      ...over,
    });
    let home: string;
    let repo: string;
    beforeEach(() => {
      home = join(tmp, 'home');
      repo = join(tmp, 'repo');
      const snapshot = join(frozenDir(home), SNAPSHOT_ID);
      const root = join(snapshot, '_dream_context');
      mkdirSync(join(root, 'knowledge'), { recursive: true });
      mkdirSync(sealedDir(home), { recursive: true });
      mkdirSync(join(repo, 'eval', 'gold-v2'), { recursive: true });
      writeFileSync(join(snapshot, 'now.txt'), '2026-10-10T12:00:00.000Z\n');
      writeFileSync(join(snapshot, 'FINGERPRINT.json'), JSON.stringify({ fingerprint: 'abc123' }));
      writeFileSync(join(root, 'knowledge', 'alpha.md'), '---\nname: alpha\ndescription: d\n---\nrecall ranking bm25 fusion\n');
      writeFileSync(join(sealedDir(home), 'heldout.jsonl'),
        `${JSON.stringify({ id: 'g2h-en-001', query: 'bm25 fusion', expected: ['knowledge/alpha'], category: 'paraphrase', lang: 'en' })}\n`);
    });

    it('needs --ledger, then writes only under the sealed dir, appends the ledger and prints nothing sensitive', async () => {
      await expect(run(argsFor({ ledger: null }), { home, repoRoot: repo })).rejects.toThrow(/--ledger/);
      const res = await run(argsFor({ ledger: 'B0 raw | held-out\nonce' }), { home, repoRoot: repo, today: () => '2026-10-10' });
      expect(res.sealed).toBe(true);
      expect(res.outFile!.startsWith(sealedDir(home))).toBe(true);
      expect(existsSync(res.outFile!)).toBe(true);
      expect(res.json.corpusFingerprint).toBe('abc123');
      const ledger = readFileSync(join(repo, 'eval', 'gold-v2', 'HELDOUT-LEDGER.md'), 'utf-8');
      expect(ledger.trim().split('\n')).toHaveLength(1);
      expect(ledger).toContain('| 2026-10-10 | heldout | raw |');
      expect(ledger).toContain('B0 raw held-out once');
    });

    describe('cloud tiers refuse a run that fell back', () => {
      type Timing = { querySource: string; fallback: string };
      const fakeEngine = async (script: (i: number) => Timing): Promise<Engine> => {
        const real = await loadEngine('.');
        let i = 0;
        const hybridSearch = async (_q: string, _c: unknown, _r: string, _k: number, o: { timing?: Timing }) => {
          Object.assign(o.timing!, script(i++));
          return [];
        };
        return { ...real, hybrid: async () => ({ hybridSearch }) as never };
      };
      const tierArgs = (tier: 'cloud' | 'cloud-index', over: Partial<RecallEvalArgs> = {}): RecallEvalArgs =>
        ({ ...parseArgs(['--split', 'heldout', '--tier', tier]), ledger: 'tier run', ...over });
      const deps = (engine: Engine) => ({ home, repoRoot: repo, today: () => '2026-10-11', engineOverride: async () => engine });
      const ledgerFile = (): string => join(repo, 'eval', 'gold-v2', 'HELDOUT-LEDGER.md');

      it('fails on the first fallback with the count, and records no ledger line and no result file', async () => {
        const engine = await fakeEngine((i) => (i === 1 ? { querySource: 'e5', fallback: 'timeout' } : { querySource: 'api', fallback: 'none' }));
        await expect(run(tierArgs('cloud'), deps(engine))).rejects.toThrow(/1 of \d+ queries did not run the tier.*timeout/);
        expect(existsSync(ledgerFile())).toBe(false);
        expect(existsSync(join(sealedDir(home), 'heldout-tier-cloud.json'))).toBe(false);
      });

      it('a silent switch to e5 is an offence even when fallback says none', async () => {
        const engine = await fakeEngine(() => ({ querySource: 'e5', fallback: 'none' }));
        await expect(run(tierArgs('cloud-index'), deps(engine))).rejects.toThrow(/did not run the tier.*source=e5/);
        expect(existsSync(ledgerFile())).toBe(false);
      });

      it('passes when every query ran its tier (api for cloud, nano for cloud-index, none for a gate skip)', async () => {
        const cloud = await fakeEngine((i) => (i % 2 ? { querySource: 'none', fallback: 'bm25_confident' } : { querySource: 'api', fallback: 'none' }));
        const a = await run(tierArgs('cloud', { label: 'ok-cloud' }), deps(cloud));
        expect(a.outFile).not.toBeNull();
        const idx = await fakeEngine(() => ({ querySource: 'nano', fallback: 'none' }));
        const b = await run(tierArgs('cloud-index', { label: 'ok-index' }), deps(idx));
        expect(existsSync(b.outFile!)).toBe(true);
        expect(readFileSync(ledgerFile(), 'utf-8').trim().split('\n')).toHaveLength(2);
      });

      it('rerank_not_consented is fine only when no rerank model was requested', async () => {
        const engine = await fakeEngine(() => ({ querySource: 'api', fallback: 'rerank_not_consented' }));
        await expect(run(tierArgs('cloud', { rerankModel: 'voyageai/rerank-2.5-lite' }), deps(engine))).rejects.toThrow(/rerank_not_consented/);
        expect((await run(tierArgs('cloud', { rerankModel: null }), deps(engine))).sealed).toBe(true);
      });
    });

    it('refuses an --out outside the sealed dir', async () => {
      await expect(run(argsFor({ ledger: 'x', out: join(tmp, 'leak.json') }), { home, repoRoot: repo }))
        .rejects.toThrow(/must be under/);
      expect(existsSync(join(tmp, 'leak.json'))).toBe(false);
    });
  });
});

describe('hook-latency CLI', () => {
  it('parseArgs requires a frozen _dream_context root and a valid mode', () => {
    expect(() => parseHookArgs(['--prompts', 'g.jsonl'])).toThrow(/--root/);
    expect(() => parseHookArgs(['--root', join(tmp, '_dream_context'), '--prompts', 'g.jsonl'])).toThrow(/must be under/);
    const ok = parseHookArgs(['--root', join(FROZEN_DIR, SNAPSHOT_ID, '_dream_context'), '--prompts', 'g.jsonl', '--mode', 'floor', '--n', '50']);
    expect(ok.mode).toBe('floor');
    expect(ok.n).toBe(50);
    expect(() => parseHookArgs(['--root', join(FROZEN_DIR, 'x', '_dream_context'), '--prompts', 'g', '--mode', 'bogus'])).toThrow(/--mode/);
    expect(() => parseHookArgs(['--root', join(FROZEN_DIR, 'x', 'other'), '--prompts', 'g'])).toThrow(/_dream_context/);
  });

  it('headerLabels reads the label, including a tiered label', () => {
    const out = '— Memory recall (BM25, top 3) —\nx\n— Memory recall (Hybrid · cloud, top 5) —';
    expect(headerLabels(out)).toEqual(['BM25', 'Hybrid']);
    expect(headerLabels('nothing')).toEqual([]);
  });
});
