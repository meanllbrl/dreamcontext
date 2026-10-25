import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CorpusDoc, RecallHit } from '../../src/lib/recall.js';
import { buildCorpusCached } from '../../src/lib/recall-corpus-cache.js';
import { resolvePromptTier } from '../../src/lib/recall-cloud-config.js';
import { SPAWNED_ENV } from '../../src/lib/session-origin.js';
import type { RecallTiming } from '../../src/lib/embeddings/hybrid.js';
import {
  RECALL_FULL_RENDER_RANKS,
  RECALL_INJECT_TOP_K,
  hybridHeaderLabel,
  recallGatePasses,
  recallTimingLine,
  renderRecallBlock,
  selectPromptRecall,
} from '../../src/cli/commands/hook.js';
import { cloudFallbackNote, hybridNotReadyNote } from '../../src/cli/commands/memory.js';
import { fullHeaderLabels, headerLabels, parseArgs } from '../../scripts/hook-latency.js';
import { FROZEN_DIR } from '../../eval/harness.js';
import {
  consentAndIndex, fakeOpenRouter, setupEnv, teardownEnv, type Env,
} from '../unit/_hybrid-fixture.js';

// The hook command itself is only reachable through a built dist, which this suite must not need. So it
// drives the pieces the command is made of, in process: the hit selection (`selectPromptRecall`, the very
// function the hook calls), the block renderer, the gate and the timing line. A temp home carries the key,
// the consent and the usage files; the real ~/.dreamcontext is never read or written.

vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
  isEmbedModelDownloaded: vi.fn(() => false),
}));

let env: Env;

/** Seven knowledge docs; doc i sits on dense axis i and every doc shares the words "recallshared tiers". */
function writeVault(root: string, count = 7): CorpusDoc[] {
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(root, 'knowledge', `e${i}.md`),
      `---\nname: e${i}\ndescription: doc number ${i}\ntags: []\n---\nzzw${i} recallshared tiers filler words about the number ${i}\nsecond line of body ${i}\n`,
    );
  }
  return buildCorpusCached(root);
}

const PROMPT = 'recallshared tiers zzw3 filler words about the number';

function hitFor(doc: CorpusDoc, score: number, snippet = ''): RecallHit {
  return { doc, score, rankScore: score, snippet };
}

beforeEach(() => { env = setupEnv('dc-hook-tiers'); });
afterEach(() => { vi.unstubAllGlobals(); teardownEnv(env); });

describe('K=5 rendering', () => {
  it('prints ranks 1-3 in full and ranks 4-5 as one line each', () => {
    const corpus = writeVault(env.root);
    const hits = corpus.slice(0, 5).map((d, i) => hitFor(d, 3 - i * 0.1, `why ${i}`));
    const lines = renderRecallBlock(hits, 'BM25');

    expect(lines[1]).toBe('— Memory recall (BM25, top 5) —');
    const body = lines.slice(2);
    // Ranks 1-3: path, Why and the excerpt (three lines each).
    for (let i = 0; i < RECALL_FULL_RENDER_RANKS; i++) {
      expect(body[i * 3]).toBe(`  [knowledge] ${hits[i].doc.relPath}`);
      expect(body[i * 3 + 1]).toBe(`    Why: why ${i}`);
      expect(body[i * 3 + 2]).toMatch(/^ {4}> zzw\d recallshared/);
    }
    // Ranks 4-5: exactly one line each, `[type] relPath — title`, no Why and no excerpt.
    expect(body).toHaveLength(RECALL_FULL_RENDER_RANKS * 3 + 2);
    expect(body[9]).toBe(`  [knowledge] ${hits[3].doc.relPath} — ${hits[3].doc.title}`);
    expect(body[10]).toBe(`  [knowledge] ${hits[4].doc.relPath} — ${hits[4].doc.title}`);
  });

  it('keeps the insight read directive at any rank, including a one-line rank', () => {
    const corpus = writeVault(env.root);
    const asInsight = (d: CorpusDoc): CorpusDoc => ({ ...d, type: 'insight', relPath: `lab/insights/${d.slug}.md` });
    const hits = [
      hitFor(asInsight(corpus[0]), 3), hitFor(corpus[1], 2.9), hitFor(corpus[2], 2.8), hitFor(corpus[3], 2.7), hitFor(asInsight(corpus[4]), 2.6),
    ];
    const text = renderRecallBlock(hits, 'BM25').join('\n');
    expect(text).toContain('→ ALREADY TRACKED as an insight: `dreamcontext lab show e0`');
    expect(text).toContain('→ ALREADY TRACKED as an insight: `dreamcontext lab show e4`');
    // the rank-5 insight is a one-line entry followed by its directive
    const lines = renderRecallBlock(hits, 'BM25');
    const at = lines.indexOf(`  [insight] lab/insights/e4.md — e4`);
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toContain('lab show e4');
  });

  it('a block with fewer hits than K reports the real count', () => {
    const corpus = writeVault(env.root);
    expect(renderRecallBlock([hitFor(corpus[0], 3)], 'Haiku')[1]).toBe('— Memory recall (Haiku, top 1) —');
  });
});

describe('the gate', () => {
  it('threshold is unchanged: raw score >= 2.0 over the printed hits', () => {
    const corpus = writeVault(env.root);
    const at = (score: number): RecallHit[] => [hitFor(corpus[0], score)];
    expect(recallGatePasses(at(1.99), false)).toBe(false);
    expect(recallGatePasses(at(2.0), false)).toBe(true);
    expect(recallGatePasses([], false)).toBe(false);
    expect(recallGatePasses([], true)).toBe(false);
  });

  it('the window is the printed hits: a strong raw hit at rank 5 injects, which K=3 never saw', () => {
    const corpus = writeVault(env.root);
    const hits = corpus.slice(0, RECALL_INJECT_TOP_K).map((d, i) => hitFor(d, i === 4 ? 2.4 : 0.4));
    expect(recallGatePasses(hits, false)).toBe(true);
    expect(recallGatePasses(hits.slice(0, 3), false)).toBe(false);
  });

  it('Haiku hits inject regardless of the raw score', () => {
    const corpus = writeVault(env.root);
    expect(recallGatePasses([hitFor(corpus[0], 0)], true)).toBe(true);
  });
});

describe('hit selection by mode', () => {
  it('raw mode asks for the top 5 and labels it BM25', async () => {
    writeVault(env.root);
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await selectPromptRecall(PROMPT, env.root, 'raw', { env: {}, home: env.home });
    expect(r.label).toBe('BM25');
    expect(r.haiku).toBe(false);
    expect(r.timing).toBeNull();
    expect(r.hits).toHaveLength(RECALL_INJECT_TOP_K);
    expect(fake.calls).toHaveLength(0);
  });

  it('Haiku mode stays at 3, and its BM25 fallback stays at 3', async () => {
    const corpus = writeVault(env.root);
    const picked = corpus.slice(0, 3).map((d) => hitFor(d, 0, 'reason'));
    const ok = await selectPromptRecall(PROMPT, env.root, 'haiku', { env: {}, home: env.home, haiku: () => picked });
    expect(ok).toMatchObject({ label: 'Haiku', haiku: true });
    expect(ok.hits).toHaveLength(3);

    const failed = await selectPromptRecall(PROMPT, env.root, 'haiku', { env: {}, home: env.home, haiku: () => null });
    expect(failed.label).toBe('BM25');
    expect(failed.hits).toHaveLength(3);

    const skipped = await selectPromptRecall(PROMPT, env.root, 'haiku', { env: {}, home: env.home, haiku: () => 'skip' });
    expect(skipped.hits).toEqual([]);
  });
});

describe('tier resolution', () => {
  it('resolves the vault tier and the cloud hybrid answers: header names the effective tier, timing is filled', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud');
    expect(resolvePromptTier(env.root, {}, env.home)).toEqual({ tier: 'cloud', downgraded: null });

    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: {}, home: env.home });

    expect(r.label).toBe('Hybrid · cloud');
    expect(r.timing).toMatchObject({ tier: 'cloud', querySource: 'api' });
    expect(typeof r.timing?.corpusMs).toBe('number');
    expect(r.hits).toHaveLength(RECALL_INJECT_TOP_K);
    expect(fake.calls.filter((c) => c.url.endsWith('/embeddings'))).toHaveLength(1);
    // the injected block carries the effective tier in its header
    expect(renderRecallBlock(r.hits, r.label)[1]).toBe('— Memory recall (Hybrid · cloud, top 5) —');
  });

  it('the header names the EFFECTIVE query source: a cloud call that failed says it fell back, and why', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud');
    const down = fakeOpenRouter({ reject: true });
    vi.stubGlobal('fetch', down.fetch);

    const failed = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: {}, home: env.home });
    expect(down.calls.filter((c) => c.url.endsWith('/embeddings')).length).toBeGreaterThan(0);
    expect(failed.timing).toMatchObject({ tier: 'cloud', querySource: 'none' });
    expect(failed.timing?.fallback).not.toBe('none');
    // No local model on this machine (embedder mocked as not downloaded): BM25 served the prompt.
    expect(failed.label).toBe(`Hybrid · cloud → BM25: ${failed.timing?.fallback.replace(/_/g, ' ')}`);
    expect(failed.hits).toHaveLength(RECALL_INJECT_TOP_K);
    expect(renderRecallBlock(failed.hits, failed.label)[1]).toMatch(/^— Memory recall \(Hybrid · cloud → BM25: [a-z ]+, top 5\) —$/);
    // the latency script still reads it as a Hybrid header, not as the cloud tier
    expect(headerLabels(renderRecallBlock(failed.hits, failed.label).join('\n'))).toEqual(['Hybrid']);
    expect(fullHeaderLabels(renderRecallBlock(failed.hits, failed.label).join('\n'))[0]).not.toBe('Hybrid · cloud');

    // the next prompt: the breaker is open, no cloud call is made, and the header says so
    const second = fakeOpenRouter();
    vi.stubGlobal('fetch', second.fetch);
    const paused = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: {}, home: env.home });
    expect(second.calls).toHaveLength(0);
    expect(paused.label).toBe('Hybrid · cloud → BM25: breaker open');
  });

  it('a consented rerank model reaches the rerank call', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud', 'voyageai/rerank-2.5-lite');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: {}, home: env.home });
    expect(r.label).toBe('Hybrid · cloud');
    const rerank = fake.calls.filter((c) => c.url.endsWith('/rerank'));
    expect(rerank).toHaveLength(1);
    expect(rerank[0].body).toMatchObject({ model: 'voyageai/rerank-2.5-lite', provider: { data_collection: 'deny' } });
  });

  it('DREAMCONTEXT_RECALL_TIER=local forces local: BM25 and zero fetches while local hybrid is not ready', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: { DREAMCONTEXT_RECALL_TIER: 'local' }, home: env.home });
    expect(r.label).toBe('BM25 · hybrid local not ready: not warmed');
    expect(fake.calls).toHaveLength(0);
  });

  it('a spawned session never reaches the cloud', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const spawned = { [SPAWNED_ENV]: 'goal-skill' };
    expect(resolvePromptTier(env.root, spawned, env.home)).toEqual({ tier: 'local', downgraded: 'spawned_session' });
    const r = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: spawned, home: env.home });
    expect(r.label).toBe('BM25 · hybrid local not ready: spawned session');
    expect(fake.calls).toHaveLength(0);
  });

  it('cloud-index without the nano model on disk is not ready: BM25 that names the missing model, zero fetches', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud-index');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: {}, home: env.home });
    expect(r.label).toBe('BM25 · hybrid cloud-index not ready: no local model');
    // still a BM25 header to the latency script, and a parseable one (no commas or parentheses)
    const block = renderRecallBlock(r.hits, r.label).join('\n');
    expect(headerLabels(block)).toEqual(['BM25']);
    expect(fullHeaderLabels(block)).toEqual([r.label]);
    expect(fake.calls).toHaveLength(0);
  });

  it('cloud-index whose dense gate skipped the prompt says so: never a bare "→ BM25"', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud-index');
    const { hybridPromptRecall } = await import('../../src/cli/commands/hook.js');
    const { setNanoLoader } = await import('../../src/lib/embeddings/nano.js');
    const { FUSION_BY_TIER } = await import('../../src/lib/embeddings/fusion-config.js');
    const gate = FUSION_BY_TIER['cloud-index'].denseGate;
    // A gate any hit clears, so the prompt is BM25-sure; the nano loader must never be reached.
    const loader = vi.fn(async () => { throw new Error('nano must not load when the gate skips dense'); });
    setNanoLoader(loader);
    FUSION_BY_TIER['cloud-index'].denseGate = { rawSure: 0, rawLead: 0, leadRatio: 1 };
    try {
      const r = await hybridPromptRecall(PROMPT, env.root, 'cloud-index', env.home);
      expect(r.timing).toMatchObject({ tier: 'cloud-index', querySource: 'none', fallback: 'bm25_confident' });
      expect(r.label).toBe('Hybrid · cloud-index → BM25: bm25 confident');
      expect(loader).not.toHaveBeenCalled();
    } finally {
      FUSION_BY_TIER['cloud-index'].denseGate = gate;
      setNanoLoader(null);
    }
  });
});

describe('a vault without consent', () => {
  it('makes zero fetches in every mode, even with a recall key on the machine', async () => {
    writeVault(env.root);
    const { setRecallCloudKey } = await import('../../src/lib/recall-cloud-config.js');
    setRecallCloudKey('or-test-key-0123456789', 'manual', env.home);
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);

    for (const [mode, label] of [['raw', 'BM25'], ['hybrid', 'BM25 · hybrid local not ready: not warmed']] as const) {
      const r = await selectPromptRecall(PROMPT, env.root, mode, { env: {}, home: env.home });
      expect(r.label).toBe(label);
      expect(r.hits.length).toBeGreaterThan(0);
    }
    const noHaiku = await selectPromptRecall(PROMPT, env.root, 'haiku', { env: {}, home: env.home, haiku: () => null });
    expect(noHaiku.label).toBe('BM25');
    expect(fake.calls).toHaveLength(0);
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});

describe('DREAMCONTEXT_RECALL_TIMING', () => {
  const timing: RecallTiming = { tier: 'cloud', querySource: 'api', fallback: 'none', corpusMs: 12, bm25Ms: 34, queryMs: 56 };

  it('prints the timing object as ONE JSON line when the flag is 1', () => {
    const line = recallTimingLine(timing, { DREAMCONTEXT_RECALL_TIMING: '1' });
    expect(line).not.toBeNull();
    expect(line).not.toContain('\n');
    expect(JSON.parse(line!)).toEqual(timing);
  });

  it('prints nothing without the flag, or without a hybrid timing', () => {
    expect(recallTimingLine(timing, {})).toBeNull();
    expect(recallTimingLine(timing, { DREAMCONTEXT_RECALL_TIMING: '0' })).toBeNull();
    expect(recallTimingLine(null, { DREAMCONTEXT_RECALL_TIMING: '1' })).toBeNull();
  });
});

describe('memory recall notes', () => {
  it('no cloud consent: the local warm-up hint only', () => {
    writeVault(env.root);
    const resolved = resolvePromptTier(env.root, {}, env.home);
    expect(hybridNotReadyNote(env.root, resolved, env.home)).toContain('dreamcontext embed refresh');
    expect(hybridNotReadyNote(env.root, resolved, env.home)).not.toContain('cloud');
  });

  it('a cloud tier with no index says so, and a spawned session says why it went local', async () => {
    const { grantVaultConsent, setRecallCloudKey } = await import('../../src/lib/recall-cloud-config.js');
    writeVault(env.root);
    setRecallCloudKey('or-test-key-0123456789', 'manual', env.home);
    grantVaultConsent(env.root, { tier: 'cloud', rerankModel: null, surface: 'cli-tty' }, env.home);

    const resolved = resolvePromptTier(env.root, {}, env.home);
    expect(resolved.tier).toBe('cloud');
    expect(hybridNotReadyNote(env.root, resolved, env.home)).toContain('index is not built yet');

    const spawned = resolvePromptTier(env.root, { [SPAWNED_ENV]: 'peer' }, env.home);
    expect(hybridNotReadyNote(env.root, spawned, env.home)).toContain('spawned session');
  });

  it('names every fallback that served the query, and stays quiet when the tier answered', () => {
    expect(cloudFallbackNote({ tier: 'cloud', querySource: 'api', fallback: 'none' })).toBeNull();
    expect(cloudFallbackNote({ tier: 'cloud-index', querySource: 'nano', fallback: 'none' })).toBeNull();
    expect(cloudFallbackNote({ tier: 'local', querySource: 'e5', fallback: 'none' })).toBeNull();
    expect(cloudFallbackNote({ tier: 'cloud', querySource: 'e5', fallback: 'breaker_open' })).toBe('cloud recall: breaker open — served by local e5.');
    expect(cloudFallbackNote({ tier: 'local', querySource: 'none', fallback: 'no_local_model' })).toBe('local recall: no local model — served by BM25.');
    expect(cloudFallbackNote({ tier: 'cloud-index', querySource: 'none', fallback: 'bm25_confident' }))
      .toBe('cloud-index recall: BM25 was already confident, so the dense channel was skipped — served by BM25.');
  });

  it('cloud-index with the index but no nano model names the missing query model', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud-index');
    const resolved = resolvePromptTier(env.root, {}, env.home);
    expect(resolved.tier).toBe('cloud-index');
    expect(hybridNotReadyNote(env.root, resolved, env.home)).toContain('voyage-4-nano query model');
  });
});

describe('hybridHeaderLabel', () => {
  it('names where a prompt was really served', () => {
    expect(hybridHeaderLabel({ tier: 'cloud', querySource: 'api', fallback: 'none' })).toBe('Hybrid · cloud');
    // the cloud answered; only the optional rerank was withheld
    expect(hybridHeaderLabel({ tier: 'cloud', querySource: 'api', fallback: 'rerank_not_consented' })).toBe('Hybrid · cloud');
    expect(hybridHeaderLabel({ tier: 'cloud-index', querySource: 'nano', fallback: 'none' })).toBe('Hybrid · cloud-index');
    expect(hybridHeaderLabel({ tier: 'local', querySource: 'e5', fallback: 'none' })).toBe('Hybrid · local');
    expect(hybridHeaderLabel({ tier: 'local', querySource: 'none', fallback: 'no_local_model' })).toBe('Hybrid · local → BM25: no local model');
    expect(hybridHeaderLabel({ tier: 'cloud', querySource: 'e5', fallback: 'breaker_open' })).toBe('Hybrid · cloud → local: breaker open');
    expect(hybridHeaderLabel({ tier: 'cloud', querySource: 'none', fallback: 'no_index' })).toBe('Hybrid · cloud → BM25: no index');
    expect(hybridHeaderLabel({ tier: 'cloud-index', querySource: 'none', fallback: 'bm25_confident' })).toBe('Hybrid · cloud-index → BM25: bm25 confident');
  });

  it('never ends a fallback arrow without a reason, for any tier × source × fallback', () => {
    const tiers = ['local', 'cloud-index', 'cloud'] as const;
    const sources = ['api', 'nano', 'e5', 'none'] as const;
    const fallbacks = ['none', 'breaker_open', 'withheld', 'not_consented', 'spawned_session', 'daily_cap', 'no_index',
      'no_local_model', 'rerank_not_consented', 'bm25_confident', 'timeout', 'network', 'auth'] as const;
    for (const tier of tiers) for (const querySource of sources) for (const fallback of fallbacks) {
      const label = hybridHeaderLabel({ tier, querySource, fallback } as RecallTiming);
      if (label.includes('→')) expect(label).toMatch(/→ (local|BM25): [a-z0-9]/);
      expect(label).not.toMatch(/[,()]/);
    }
    // a path that forgot to record its reason is still named, not silent
    expect(hybridHeaderLabel({ tier: 'cloud-index', querySource: 'none', fallback: 'none' })).toBe('Hybrid · cloud-index → BM25: reason not recorded');
  });
});

describe('hook-latency --tier', () => {
  const root = join(FROZEN_DIR, 'dc-test-snapshot', '_dream_context');
  const base = ['--root', root, '--prompts', 'g.jsonl'];

  it('defaults to local and accepts the three tiers in hybrid mode', () => {
    expect(parseArgs([...base]).tier).toBe('local');
    expect(parseArgs([...base, '--mode', 'hybrid', '--tier', 'cloud-index']).tier).toBe('cloud-index');
    expect(parseArgs([...base, '--mode', 'hybrid', '--tier', 'cloud']).tier).toBe('cloud');
  });

  it('refuses a bad tier, a cloud tier outside hybrid mode, and a cloud tier with an empty HOME', () => {
    expect(() => parseArgs([...base, '--mode', 'hybrid', '--tier', 'galaxy'])).toThrow(/--tier/);
    expect(() => parseArgs([...base, '--mode', 'raw', '--tier', 'cloud'])).toThrow(/--mode hybrid/);
    expect(() => parseArgs([...base, '--tier', 'cloud', '--no-model'])).toThrow(/--no-model/);
  });

  it('reads the full tiered header label as well as the short one', () => {
    const out = '— Memory recall (Hybrid · cloud-index, top 5) —\nx';
    expect(fullHeaderLabels(out)).toEqual(['Hybrid · cloud-index']);
    expect(headerLabels(out)).toEqual(['Hybrid']);
  });
});
