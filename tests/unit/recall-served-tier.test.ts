import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { handleRecallPromptPost, servedTier } from '../../src/server/routes/recall.js';
import { queryViaServer, toWireQueryHit } from '../../src/cli/commands/memory.js';
import { grantVaultConsent, setRecallCloudKey } from '../../src/lib/recall-cloud-config.js';
import type { CorpusDoc, RecallHit } from '../../src/lib/recall.js';

// The warm-server recall (audit MM-2): the dashboard server answers recall for every tier, but only the
// tier the caller resolved, never one its own env or a stale caller could lift.

const ENV_KEYS = ['DREAMCONTEXT_SPAWNED', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTO_SLEEP', 'DREAMCONTEXT_RECALL_OPENROUTER_KEY', 'DREAMCONTEXT_RECALL_TIER'];
const saved: Record<string, string | undefined> = {};
const servers: Server[] = [];
let tmp: string;
let home: string;
let root: string;

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = mkdtempSync(join(tmpdir(), 'dc-served-tier-'));
  home = join(tmp, 'home');
  root = join(tmp, 'vault', '_dream_context');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('servedTier', () => {
  it('no tier field is local: what every hook before the field sent', () => {
    expect(servedTier(undefined, root, home)).toBe('local');
  });

  it('serves the consented tier the caller asked for', () => {
    setRecallCloudKey('or-test-key-0123456789', 'manual', home);
    grantVaultConsent(root, { tier: 'cloud-index', rerankModel: null, surface: 'cli-tty' }, home);
    expect(servedTier('cloud-index', root, home)).toBe('cloud-index');
    expect(servedTier('local', root, home)).toBe('local');
  });

  it('never lifts a tier above the consent, and never quietly lowers one: null, the caller recalls itself', () => {
    setRecallCloudKey('or-test-key-0123456789', 'manual', home);
    grantVaultConsent(root, { tier: 'cloud-index', rerankModel: null, surface: 'cli-tty' }, home);
    expect(servedTier('cloud', root, home)).toBeNull();
  });

  it('a cloud tier with no consent or no key here is null', () => {
    expect(servedTier('cloud-index', root, home)).toBeNull();
    grantVaultConsent(root, { tier: 'cloud-index', rerankModel: null, surface: 'cli-tty' }, home);
    expect(servedTier('cloud-index', root, home)).toBeNull(); // consent but no key on this side
  });

  it('the server env cannot change the answer (a spawn marker or a tier override on the server)', () => {
    setRecallCloudKey('or-test-key-0123456789', 'manual', home);
    grantVaultConsent(root, { tier: 'cloud-index', rerankModel: null, surface: 'cli-tty' }, home);
    process.env.DREAMCONTEXT_SPAWNED = '1';
    process.env.DREAMCONTEXT_RECALL_TIER = 'local';
    expect(servedTier('cloud-index', root, home)).toBe('cloud-index');
  });

  it('a tier it does not know (a newer or broken caller) is null', () => {
    expect(servedTier('cloud-max', root, home)).toBeNull();
    expect(servedTier(3, root, home)).toBeNull();
    expect(servedTier(null, root, home)).toBeNull();
  });
});

function call(body: unknown, contextRoot: string): Promise<{ status: number; body: string }> {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
  const req = Object.assign(new Readable({ read() {} }), { socket, headers: { 'content-type': 'application/json' }, method: 'POST', url: '/api/recall/prompt' }) as unknown as IncomingMessage;
  (req as unknown as { push: (c: string | null) => void }).push(JSON.stringify(body));
  (req as unknown as { push: (c: string | null) => void }).push(null);
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      statusCode: 0,
      setHeader() {}, getHeader() { return undefined; },
      writeHead(s: number) { status = s; return res; },
      end(b: string) { resolve({ status: status || res.statusCode, body: String(b ?? '') }); },
    };
    void handleRecallPromptPost(req, res as never, {}, contextRoot);
  });
}

describe('POST /api/recall/prompt with a tier', () => {
  it('an unknown tier: 409 not_ready, so the caller recalls itself', async () => {
    const r = await call({ prompt: 'q', root, tier: 'cloud-max' }, root);
    expect(r.status).toBe(409);
    expect(r.body).toContain('not_ready');
  });

  it('a cloud tier the vault does not allow here: 409 not_ready', async () => {
    const r = await call({ prompt: 'q', root, tier: 'cloud', kind: 'query', topK: 5 }, root);
    expect(r.status).toBe(409);
    expect(r.body).toContain('not_ready');
  });
});

function hit(slug: string, score: number): RecallHit {
  const doc = {
    type: 'knowledge', path: `/v/_dream_context/knowledge/${slug}.md`, relPath: `knowledge/${slug}.md`, slug, title: `Title ${slug}`,
    description: `about ${slug}`, tags: ['t'], body: 'the body never travels', level: 3, product: 'acme', federated: true,
    tokens: ['x'], tokenSet: new Set(['x']), termFreq: new Map([['x', 1]]),
  } as unknown as CorpusDoc;
  return { doc, score, rankScore: score * 2, snippet: `why ${slug}` };
}

function fakeServer(reply: (body: string) => { status: number; json?: unknown; delayMs?: number }): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push(body);
        const r = reply(body);
        setTimeout(() => {
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r.json ?? {}));
        }, r.delayMs ?? 0);
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, seen }));
  });
}

describe('queryViaServer (memory recall through the app)', () => {
  const timing = { tier: 'cloud-index', querySource: 'nano', fallback: 'none' };

  it('sends the query shape with the resolved tier and returns what the CLI prints', async () => {
    const hits = [hit('alpha', 3.5), hit('beta', 2.1)];
    const { port, seen } = await fakeServer(() => ({ status: 200, json: { kind: 'query', corpusSize: 42, timing, hits: hits.map(toWireQueryHit) } }));
    const r = await queryViaServer('/v/_dream_context', 'alpha things', 7, ['knowledge'], 2, 'cloud-index', { port, home });
    expect(JSON.parse(seen[0])).toEqual({ kind: 'query', prompt: 'alpha things', root: '/v/_dream_context', tier: 'cloud-index', topK: 7, types: ['knowledge'], minLevel: 2 });
    expect(r).not.toBeNull();
    expect(r!.corpusSize).toBe(42);
    expect(r!.timing).toEqual(timing);
    expect(r!.hits.map((h) => [h.doc.slug, h.doc.relPath, h.doc.level, h.doc.product, h.doc.federated, h.score, h.snippet]))
      .toEqual([['alpha', 'knowledge/alpha.md', 3, 'acme', true, 3.5, 'why alpha'], ['beta', 'knowledge/beta.md', 3, 'acme', true, 2.1, 'why beta']]);
    expect(seen[0]).not.toContain('the body never travels');
  });

  it('an older server answering with a prompt-recall body is a miss', async () => {
    const { port } = await fakeServer(() => ({ status: 200, json: { label: 'Hybrid · local', timing, hits: [] } }));
    expect(await queryViaServer('/v/_dream_context', 'q', 5, undefined, undefined, 'local', { port, home })).toBeNull();
  });

  it('any other miss is null: refusal, garbage, too slow, no server', async () => {
    const refused = await fakeServer(() => ({ status: 409 }));
    expect(await queryViaServer('/v/_dream_context', 'q', 5, undefined, undefined, 'local', { port: refused.port, home })).toBeNull();
    const garbage = await fakeServer(() => ({ status: 200, json: { kind: 'query', hits: 'no' } }));
    expect(await queryViaServer('/v/_dream_context', 'q', 5, undefined, undefined, 'local', { port: garbage.port, home })).toBeNull();
    const slow = await fakeServer(() => ({ status: 200, json: { kind: 'query', corpusSize: 1, timing, hits: [] }, delayMs: 800 }));
    const t0 = Date.now();
    expect(await queryViaServer('/v/_dream_context', 'q', 5, undefined, undefined, 'local', { port: slow.port, timeoutMs: 200, home })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(700);
    const closed = await fakeServer(() => ({ status: 200 }));
    servers.pop()!.close();
    expect(await queryViaServer('/v/_dream_context', 'q', 5, undefined, undefined, 'local', { port: closed.port, timeoutMs: 1000, home })).toBeNull();
  });

  it('names the vault when the project is registered', async () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: '/v' }] }));
    let header: string | undefined;
    const server = createServer((req, res) => { header = req.headers['x-dreamcontext-vault'] as string; res.writeHead(409); res.end('{}'); });
    servers.push(server);
    const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
    await queryViaServer('/v/_dream_context', 'q', 5, undefined, undefined, 'local', { port, home });
    expect(header).toBe('acme');
  });
});
