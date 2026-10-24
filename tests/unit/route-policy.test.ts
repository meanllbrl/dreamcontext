// AC4: the phone's route policy is EXHAUSTIVE (every registered route has a row with a reason),
// an unclassified route is refused, every row's body kind is known, and every `sandboxed` row's
// handler really sends the sandbox CSP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildRouter, isVaultAgnostic } from '../../src/server/index.js';
import { ROUTE_POLICY, classifyMacRoute, routePolicyFor } from '../../src/lib/handsfree/mac/route-policy.js';
import { MAC_PUBLIC_ROUTES } from '../../src/lib/handsfree/mac/contract.js';
import { addVault } from '../../src/lib/vaults.js';
import { addConnection } from '../../src/lib/connections.js';
import { createWhiteboard } from '../../src/lib/whiteboards/store.js';
import { writeBoardFile } from '../../src/lib/whiteboards/files.js';

const router = buildRouter();
const registered = router.list().map((r) => `${r.method} ${r.path}`);

describe('the route policy is exhaustive', () => {
  it('every registered route has a row, with allow|deny and a reason', () => {
    expect(registered.length).toBeGreaterThan(300);
    const missing = registered.filter((k) => !(k in ROUTE_POLICY));
    expect(missing).toEqual([]);
    for (const k of registered) {
      const row = ROUTE_POLICY[k];
      expect(typeof row.allow, k).toBe('boolean');
      expect(row.why.trim().length, k).toBeGreaterThan(10);
    }
  });

  it('no row names a route that does not exist (a renamed route cannot leave a stale allow behind)', () => {
    expect(Object.keys(ROUTE_POLICY).filter((k) => !registered.includes(k))).toEqual([]);
  });

  it('every row has a known body kind; a deny row sends nothing; an allowed GET says it has no side effect', () => {
    for (const [k, row] of Object.entries(ROUTE_POLICY)) {
      expect(['json', 'media', 'sandboxed', 'none'], k).toContain(row.body);
      if (!row.allow) expect(row.body, k).toBe('none');
      if (row.allow) expect(row.body, k).not.toBe('none');
      if (row.allow && k.startsWith('GET ') && !MAC_PUBLIC_ROUTES.includes(k)) expect(row.why, k).toMatch(/side-effect free|a file inside this project|a file in this project/);
    }
  });

  it('AC16: every allowed row has a project scope; the vault-agnostic ones say none; the cross-project ones are the named few', () => {
    for (const [k, row] of Object.entries(ROUTE_POLICY)) {
      expect(['request', 'none', 'cross:filter', 'cross:deny'], k).toContain(row.scope);
      if (row.allow) expect(row.scope, k).not.toBe('cross:deny');
      // A route on a vault-agnostic prefix gets no project from the gate unless it names one, so
      // it must say none, or be one of the few that do read the request project's root.
      const path = k.slice(k.indexOf(' ') + 1);
      if (row.allow && row.scope === 'request' && isVaultAgnostic(path)) {
        expect(['GET /api/embeddings/index/status', 'POST /api/embeddings/index', 'GET /api/agent/session-model', 'GET /api/agent/session-stats'], k).toContain(k);
      }
    }
    const filtered = Object.entries(ROUTE_POLICY).filter(([, r]) => r.scope === 'cross:filter').map(([k]) => k).sort();
    expect(filtered).toEqual([
      'GET /api/brain/team/updates', 'GET /api/connections', 'GET /api/federation/inbox', 'GET /api/peer/logo',
      'GET /api/peer/peers', 'GET /api/vaults', 'POST /api/agent/prompt',
    ]);
    for (const k of ['POST /api/brain/team/fetch', 'GET /api/launcher/status', 'GET /api/launcher/federation-graph', 'GET /api/launcher/logo']) {
      expect(ROUTE_POLICY[k].allow, k).toBe(false);
    }
    for (const k of ['POST /api/brain/team/fetch', 'GET /api/launcher/status', 'GET /api/launcher/federation-graph', 'GET /api/launcher/logo']) expect(ROUTE_POLICY[k].scope, k).toBe('cross:deny');
  });

  it('every deny category the owner named is denied', () => {
    for (const k of [
      'POST /api/handsfree/mac/start', 'POST /api/window/:verb', 'GET /api/assistant/status', 'POST /api/agent/open-terminal',
      'POST /api/launcher/register', 'POST /api/launcher/unregister', 'POST /api/agent/secret', 'POST /api/recall/cloud/key',
      'POST /api/admin/shutdown', 'POST /api/agent/voice/tts', 'POST /api/notify', 'POST /api/brain/auth/token',
      'GET /api/launcher/status', 'POST /api/peer/send', 'POST /api/agent/grant', 'POST /api/agent/reveal',
    ]) expect(ROUTE_POLICY[k]?.allow, k).toBe(false);
  });

  it('the phone sends a photo and allows one outside picture for itself, never through the desktop\'s grant file', () => {
    // Task hands-free-phone-shows-every-picture… (owner 2026-10-23): the drop takes a phone photo
    // (its caps live in the handler), and the phone's one-tap consent is its own route; the
    // desktop's grant (a file every surface would read) stays laptop-only.
    for (const k of ['POST /api/agent/drop', 'POST /api/agent/phone-grant']) {
      expect(ROUTE_POLICY[k]?.allow, k).toBe(true);
      expect(ROUTE_POLICY[k]?.scope, k).toBe('request');
    }
    expect(ROUTE_POLICY['POST /api/agent/grant'].allow).toBe(false);
  });

  it('an unclassified, unmatched or undecodable route is refused at runtime; a public one is public', () => {
    const match = (m: string, p: string) => router.match(m, p);
    expect(classifyMacRoute('GET', '/api/never-registered', match)).toBe('unavailable');
    expect(classifyMacRoute('GET', '/api/zz', () => ({ method: 'GET', path: '/api/zz' }))).toBe('unavailable');
    expect(classifyMacRoute('GET', '/api/tasks/%E0%A4%A', match)).toBe('unavailable');
    expect(classifyMacRoute('GET', '/api/tasks', match)).toBe('device');
    expect(classifyMacRoute('HEAD', '/api/tasks', match)).toBe('device');
    expect(classifyMacRoute('POST', '/api/window/focus', match)).toBe('unavailable');
    expect(classifyMacRoute('GET', '/login', match)).toBe('public');
    expect(classifyMacRoute('GET', '/somewhere/in/the/spa', match)).toBe('device');
    expect(routePolicyFor('HEAD', '/api/tasks')?.allow).toBe(true);
  });

  it('the router and the gate read the same first match: a static route beats the param route after it', () => {
    expect(router.match('GET', '/api/lab/credentials')?.path).toBe('/api/lab/credentials');
    expect(classifyMacRoute('GET', '/api/lab/credentials', (m, p) => router.match(m, p))).toBe('unavailable');
    expect(classifyMacRoute('GET', '/api/lab/some-insight', (m, p) => router.match(m, p))).toBe('device');
  });
});

// ─── Every `sandboxed` row's handler sends the sandbox CSP ──────────────────

interface Captured { status: number; headers: Record<string, string> }
function capture(): { res: ServerResponse; out: Captured } {
  const out: Captured = { status: 0, headers: {} };
  const res = {
    setHeader(n: string, v: string) { out.headers[n.toLowerCase()] = String(v); },
    writeHead(code: number, h?: Record<string, string | number>) { out.status = code; for (const [k, v] of Object.entries(h ?? {})) out.headers[k.toLowerCase()] = String(v); return res; },
    end() {},
  } as unknown as ServerResponse;
  return { res, out };
}

describe('sandboxed rows really send the sandbox CSP', () => {
  let home: string;
  const savedHome = process.env.HOME;
  let root: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'route-policy-'));
    process.env.HOME = home;
    for (const name of ['proj', 'peer']) {
      mkdirSync(join(home, name, '_dream_context', 'assets'), { recursive: true });
      addVault(name, join(home, name));
    }
    root = join(home, 'proj', '_dream_context');
    writeFileSync(join(home, 'peer', '_dream_context', 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    addConnection(root, 'proj', 'peer', 'both', null, home);
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const SETUP: Record<string, () => Promise<{ url: string; params: Record<string, string> }>> = {
    'GET /api/peer/logo': async () => ({ url: '/api/peer/logo?peer=peer', params: {} }),
    'GET /api/whiteboards/:slug/files/:id': async () => {
      const { slug } = createWhiteboard(root, 'Board');
      const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
      const { id } = writeBoardFile(root, slug, 'picture-0001', png);
      return { url: `/api/whiteboards/${slug}/files/${id}`, params: { slug, id } };
    },
  };

  it('every sandboxed row has a probe here, and its handler answers with default-src none + sandbox', async () => {
    const rows = Object.entries(ROUTE_POLICY).filter(([, r]) => r.body === 'sandboxed').map(([k]) => k);
    expect(rows.sort()).toEqual(Object.keys(SETUP).sort());
    for (const k of rows) {
      const [method, path] = k.split(' ');
      const { url, params } = await SETUP[k]();
      const hit = router.match(method, url.split('?')[0]);
      expect(hit?.path, k).toBe(path);
      const { res, out } = capture();
      await hit!.handler({ method, url, headers: { host: 'localhost' }, socket: {} } as unknown as IncomingMessage, res, { ...hit!.params, ...params }, root);
      expect(out.status, k).toBe(200);
      expect(out.headers['content-security-policy'], k).toMatch(/default-src 'none'; sandbox/);
      expect(out.headers['x-content-type-options'], k).toBe('nosniff');
    }
  });

  it('the peer logo is an SVG here, and still inert', async () => {
    const hit = router.match('GET', '/api/peer/logo')!;
    const { res, out } = capture();
    await hit.handler({ method: 'GET', url: '/api/peer/logo?peer=peer', headers: {}, socket: {} } as unknown as IncomingMessage, res, {}, root);
    expect(out.headers['content-type']).toBe('image/svg+xml');
    expect(out.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });
});
