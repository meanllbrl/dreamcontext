import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import {
  recallViaDashboard, renderRecallBlock, toWirePromptHit,
} from '../../src/cli/commands/hook.js';
import { handleRecallPromptPost } from '../../src/server/routes/recall.js';
import type { RecallHit, CorpusDoc } from '../../src/lib/recall.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function hit(slug: string, type: CorpusDoc['type'], score: number): RecallHit {
  const doc = {
    type, path: `/v/_dream_context/knowledge/${slug}.md`, relPath: `knowledge/${slug}.md`, slug, title: `Title ${slug}`,
    description: `about ${slug}`, tags: ['t'], body: `# ${slug}\n\nfirst line of ${slug}\nsecond line\n| table |\nthird line`,
    tokens: ['x'], tokenSet: new Set(['x']), termFreq: new Map([['x', 1]]),
  } as unknown as CorpusDoc;
  return { doc, score, rankScore: score * 2, snippet: `why ${slug}` };
}

/** A fake dashboard answering POST /api/recall/prompt; resolves its port. */
function fakeDashboard(handler: (req: IncomingMessage, body: string) => { status: number; json?: unknown; delayMs?: number }): Promise<{ port: number; seen: Array<{ headers: IncomingMessage['headers']; body: string }> }> {
  const seen: Array<{ headers: IncomingMessage['headers']; body: string }> = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ headers: req.headers, body });
        const r = handler(req, body);
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

describe('recallViaDashboard', () => {
  const hits = [hit('alpha', 'knowledge', 3.5), hit('beta', 'task', 2.1), hit('gamma', 'insight', 1.2), hit('delta', 'knowledge', 0.9)];

  it("prints exactly the block the in-process recall would print", async () => {
    const { port, seen } = await fakeDashboard(() => ({ status: 200, json: { label: 'Hybrid · local', timing: null, hits: hits.map(toWirePromptHit) } }));
    const r = await recallViaDashboard('what about alpha', '/v/_dream_context', { port, home: mkdtempSync(join(tmpdir(), 'dc-home-')) });
    expect(r).not.toBeNull();
    expect(r!.label).toBe('Hybrid · local');
    expect(renderRecallBlock(r!.hits, r!.label)).toEqual(renderRecallBlock(hits, 'Hybrid · local'));
    expect(r!.hits.map((h) => [h.doc.type, h.doc.slug, h.score])).toEqual(hits.map((h) => [h.doc.type, h.doc.slug, h.score]));
    expect(JSON.parse(seen[0].body)).toEqual({ prompt: 'what about alpha', root: '/v/_dream_context' });
  });

  it('names the vault when the project is registered', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-home-'));
    dirs.push(home);
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: '/v' }] }));
    const { port, seen } = await fakeDashboard(() => ({ status: 200, json: { label: 'Hybrid · local', hits: [] } }));
    await recallViaDashboard('q', '/v/_dream_context', { port, home });
    expect(seen[0].headers['x-dreamcontext-vault']).toBe('acme');
  });

  it('any miss is null, so the hook recalls in-process: refusal, no server, too slow, garbage', async () => {
    const refused = await fakeDashboard(() => ({ status: 409 }));
    expect(await recallViaDashboard('q', '/v/_dream_context', { port: refused.port })).toBeNull();

    const garbage = await fakeDashboard(() => ({ status: 200, json: { nope: true } }));
    expect(await recallViaDashboard('q', '/v/_dream_context', { port: garbage.port })).toBeNull();

    const slow = await fakeDashboard(() => ({ status: 200, json: { label: 'x', hits: [] }, delayMs: 800 }));
    const t0 = Date.now();
    expect(await recallViaDashboard('q', '/v/_dream_context', { port: slow.port, timeoutMs: 200 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(700);

    const closed = await fakeDashboard(() => ({ status: 200 }));
    servers.pop()!.close();
    expect(await recallViaDashboard('q', '/v/_dream_context', { port: closed.port, timeoutMs: 1000 })).toBeNull();
  });
});

describe('POST /api/recall/prompt refuses what it must not serve', () => {
  function call(remoteAddress: string, body: unknown, contextRoot: string): Promise<{ status: number; body: string }> {
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
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

  it('not from this machine: 403', async () => {
    const r = await call('192.168.1.20', { prompt: 'q', root: '/x' }, '/x');
    expect(r.status).toBe(403);
  });

  it('another vault than the one the request resolved: 409, never a read of that path', async () => {
    const a = mkdtempSync(join(tmpdir(), 'dc-va-'));
    const b = mkdtempSync(join(tmpdir(), 'dc-vb-'));
    dirs.push(a, b);
    const r = await call('127.0.0.1', { prompt: 'q', root: b }, a);
    expect(r.status).toBe(409);
    expect(r.body).toContain('other_vault');
  });

  it('its own vault but no warm local model here: 409 not_ready', async () => {
    const a = mkdtempSync(join(tmpdir(), 'dc-va-'));
    dirs.push(a);
    const r = await call('127.0.0.1', { prompt: 'q', root: a }, a);
    expect(r.status).toBe(409);
    expect(r.body).toContain('not_ready');
  });
});
