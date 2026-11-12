import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corpusFingerprint, createCorpusMemo } from '../../src/server/corpus-memo.js';
import { createRecallOptionsRoutes } from '../../src/server/routes/recall-options.js';
import { createRecallCloudRoutes } from '../../src/server/routes/recall-cloud.js';
import { CLOUD_META_FILE } from '../../src/lib/recall-cloud-config.js';
import type { buildCloudIndex } from '../../src/lib/embeddings/vector-store.js';
import type { CorpusDoc } from '../../src/lib/recall.js';

/**
 * Settings → Recall's two corpus-derived numbers (the Turkish share, the cloud index plan) are
 * remembered under an exact content key: a second GET on an unchanged corpus skips the work, and
 * any edit, flag flip or index write is seen on the very next GET (never a stale number).
 */

const HOST = '127.0.0.1:4173';
const TURKISH = 'Kullanıcı ayarlarını değiştirdiğinde panel yeniden yüklenir ve işlem sırasında hiçbir veri dışarı gönderilmez. Öğrenciler için güvenli bir çözüm.';
const ENGLISH = 'When the user changes a setting the dashboard reloads and nothing is sent anywhere while it happens. A safe default for everyone involved here.';

function get(url: string): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(stream, { method: 'GET', url, headers: { host: HOST }, socket: { remoteAddress: '127.0.0.1' } });
  return stream;
}

type Handler = (req: IncomingMessage, res: ServerResponse, p: Record<string, string>, root: string) => Promise<void>;
async function call(h: Handler, url: string, root: string): Promise<Record<string, unknown>> {
  const out = { status: 0, text: '' };
  const r = { writeHead(c: number) { out.status = c; return r; }, end(b?: string) { out.text = b ?? ''; } };
  await h(get(url), r as unknown as ServerResponse, {}, root);
  expect(out.status).toBe(200);
  return JSON.parse(out.text) as Record<string, unknown>;
}

/** A doc whose body counts its reads: the fingerprint reads it once, the real work at least once more. */
function countingDoc(root: string, slug: string, text: string): { doc: CorpusDoc; reads: () => number; set: (t: string) => void } {
  const path = join(root, 'knowledge', `${slug}.md`);
  writeFileSync(path, `---\nname: ${slug}\n---\n${text}\n`);
  let body = text;
  let reads = 0;
  const doc = { type: 'knowledge', path, relPath: `knowledge/${slug}.md`, slug, title: slug, description: '', tags: [] } as unknown as CorpusDoc;
  Object.defineProperty(doc, 'body', { enumerable: true, get: () => { reads += 1; return body; } });
  return { doc, reads: () => reads, set: (t) => { body = t; } };
}

let tmp: string;
let home: string;
let root: string;

beforeEach(() => {
  vi.stubEnv('DREAMCONTEXT_RECALL_OPENROUTER_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  tmp = mkdtempSync(join(tmpdir(), 'dc-recall-memo-'));
  home = join(tmp, 'home');
  root = join(tmp, 'vault', '_dream_context');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('corpusFingerprint', () => {
  const base = { type: 'knowledge', path: '/v/a.md', relPath: 'a.md', title: 'a', description: 'd', body: 'b' } as unknown as CorpusDoc;
  const fp = (...docs: CorpusDoc[]) => corpusFingerprint(docs);

  it('is stable for the same content and changes with every field the readers look at', () => {
    expect(fp(base)).toBe(fp({ ...base }));
    for (const change of [{ body: 'c' }, { title: 'x' }, { description: 'x' }, { path: '/v/b.md' }, { relPath: 'b.md' }, { type: 'feature' }, { capture: true }, { cloudOptOut: true }, { federated: true }]) {
      expect(fp({ ...base, ...change } as CorpusDoc)).not.toBe(fp(base));
    }
  });

  it('does not confuse text moved across a field boundary, nor a doc added or dropped', () => {
    expect(fp({ ...base, title: 'ab', description: '' } as CorpusDoc)).not.toBe(fp({ ...base, title: 'a', description: 'b' } as CorpusDoc));
    expect(fp(base, base)).not.toBe(fp(base));
    expect(fp()).not.toBe(fp(base));
  });
});

describe('createCorpusMemo', () => {
  it('computes once per key, again on a new key, and holds at most `limit` vaults', () => {
    const memo = createCorpusMemo<number>(2);
    const compute = vi.fn(() => 7);
    memo.get('/a', 'k1', compute);
    memo.get('/a', 'k1', compute);
    expect(compute).toHaveBeenCalledTimes(1);
    memo.get('/a', 'k2', compute);
    expect(compute).toHaveBeenCalledTimes(2);
    memo.get('/b', 'k', compute);
    memo.get('/c', 'k', compute); // evicts /a, the oldest
    memo.get('/a', 'k2', compute);
    expect(compute).toHaveBeenCalledTimes(5);
  });

  it('remembers nothing when the computation throws', () => {
    const memo = createCorpusMemo<number>();
    expect(() => memo.get('/a', 'k', () => { throw new Error('boom'); })).toThrow('boom');
    expect(memo.get('/a', 'k', () => 3)).toBe(3);
  });
});

describe('GET /api/recall/options remembers the Turkish share', () => {
  it('skips the share on an unchanged corpus and follows an edit on the next GET', async () => {
    const d = countingDoc(root, 'a', ENGLISH);
    const routes = createRecallOptionsRoutes({ home, loadCorpus: () => [d.doc], loadPrompts: () => [], hardware: () => ({ totalMemBytes: 32 * 1024 ** 3, cpuCount: 10, modelName: null }) });
    const first = await call(routes.options, '/api/recall/options', root);
    expect((first.signals as Record<string, unknown>).turkishSharePct).toBe(0);
    const afterFirst = d.reads();
    await call(routes.options, '/api/recall/options', root);
    expect(d.reads() - afterFirst).toBe(1); // the fingerprint only
    d.set(TURKISH);
    const third = await call(routes.options, '/api/recall/options', root);
    expect((third.signals as Record<string, unknown>).turkishSharePct).toBe(100);
  });
});

describe('GET /api/recall/cloud/status remembers the index plan', () => {
  const routesWith = (docs: () => CorpusDoc[]) =>
    createRecallCloudRoutes({ home, loadCorpus: docs, build: vi.fn() as unknown as typeof buildCloudIndex });
  const planOf = (r: Record<string, unknown>) => r.plan as { toEmbed: number; total: number; byType: Record<string, number> };

  it('skips the plan on an unchanged corpus, and follows a doc added or edited', async () => {
    const a = countingDoc(root, 'a', ENGLISH);
    const docs = [a.doc];
    const routes = routesWith(() => docs);
    const first = planOf(await call(routes.status, '/api/recall/cloud/status', root));
    expect(first.byType.knowledge).toBe(1);
    const afterFirst = a.reads();
    await call(routes.status, '/api/recall/cloud/status', root);
    expect(a.reads() - afterFirst).toBe(1); // the fingerprint only
    docs.push(countingDoc(root, 'b', TURKISH).doc);
    expect(planOf(await call(routes.status, '/api/recall/cloud/status', root)).byType.knowledge).toBe(2);
    const beforeEdit = a.reads();
    a.set(`${ENGLISH} ${ENGLISH}`);
    await call(routes.status, '/api/recall/cloud/status', root);
    expect(a.reads() - beforeEdit).toBeGreaterThan(1); // fingerprint + a fresh plan
  });

  it('plans again when the built index changes under an unchanged corpus', async () => {
    const a = countingDoc(root, 'a', ENGLISH);
    const routes = routesWith(() => [a.doc]);
    await call(routes.status, '/api/recall/cloud/status', root);
    const before = a.reads();
    mkdirSync(join(root, '.embeddings'), { recursive: true });
    writeFileSync(join(root, '.embeddings', CLOUD_META_FILE), JSON.stringify({ version: 1, profile: 'voyage-4', model: 'm', dims: 1, disclosureVersion: 0, eligibleTypesHash: '', eligibleTotal: 1, coveredDocs: 0, spentUsd: 0, updatedAt: '2026-11-12T00:00:00.000Z', lastAutoStartAt: null, churnStrikes: 0 }));
    await call(routes.status, '/api/recall/cloud/status', root);
    expect(a.reads() - before).toBeGreaterThan(1); // fingerprint + a fresh plan
  });
});
