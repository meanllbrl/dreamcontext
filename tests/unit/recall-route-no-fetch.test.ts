import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hybridSearch } from '../../src/lib/embeddings/hybrid.js';
import { embedPassages } from '../../src/lib/embeddings/embedder.js';
import { axisCorpus, consentAndIndex, fakeOpenRouter, setupEnv, teardownEnv, type Env } from './_hybrid-fixture.js';

vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
  isEmbedModelDownloaded: vi.fn(() => false),
}));

/**
 * /api/recall (the per-keystroke dashboard search) calls `hybridSearch(query, corpus, root, topK)`
 * with NO tier, and never resolves one. An undefined tier is local, so a vault that consented to
 * cloud recall still makes zero network calls from the dashboard.
 */
let env: Env;
beforeEach(() => { env = setupEnv('dc-route-nofetch'); });
afterEach(() => { vi.unstubAllGlobals(); teardownEnv(env); });

describe('the dashboard search path', () => {
  it('makes zero fetches for a cloud-consented vault when no tier is passed (the route\'s exact call)', async () => {
    const docs = axisCorpus(env.root);
    await consentAndIndex(env, docs, 'cloud', 'voyageai/rerank-2.5-lite');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    vi.mocked(embedPassages).mockResolvedValue(null);
    await hybridSearch('zzw3', docs, env.root, 12, { home: env.home });
    expect(fake.calls).toHaveLength(0);
  });

  it('the search route source never resolves or passes a tier', () => {
    // The same file holds POST /api/recall/prompt, which serves a CLI's resolved tier on purpose
    // (recall-served-tier.test.ts). The guard is on the per-keystroke GET handler and what it calls.
    const file = readFileSync(join(__dirname, '../../src/server/routes/recall.ts'), 'utf-8');
    const start = file.indexOf('export async function handleRecallGet(');
    const end = file.indexOf('\nexport ', start + 1);
    expect(start).toBeGreaterThan(-1);
    const src = file.slice(start, end);
    const corpusHelper = file.slice(file.indexOf('function corpusFor('), file.indexOf('\n}\n', file.indexOf('function corpusFor(')));
    for (const part of [src, corpusHelper]) expect(part).not.toMatch(/resolvePromptTier|readVaultTier|servedTier|tier\s*:/);
    expect(src).toMatch(/hybridSearch\(query, corpus, contextRoot, topK\)/);
  });
});
