import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * W4: the first real app, the Meta Ads example, against a FICTIONAL Graph API
 * (scripts/verify/fixtures/fake-graph-api.mjs): list (paging followed server-side), pause,
 * resume, through the same call route `apps do` uses, with the token kept out of every answer
 * and log. And the /apps template: what `apps new` writes runs under the supervisor as is.
 */

const PATH = `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`;
const saved = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP, PATH: process.env.PATH };
const TOKEN = 'EAAB-fixture-token-0123456789';
let home: string;
let project: string;
let server: http.Server;
let port = 0;
let graph: http.Server;
const cleanup: string[] = [];

function call(slug: string, body: unknown): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body);
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/apps/${slug}/call`, agent: false, headers: { host: `127.0.0.1:${port}`, 'x-dreamcontext-vault': 'acme', 'content-type': 'application/json' } }, (resp) => {
      const chunks: Buffer[] = [];
      resp.on('data', (c: Buffer) => chunks.push(c));
      resp.on('end', () => res({ status: resp.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    r.on('error', rej);
    r.end(payload);
  });
}

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-apps-meta-home-')));
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'dc-apps-meta-proj-')));
  cleanup.push(home, parent);
  project = join(parent, 'acme');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
  process.env.HOME = home;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  process.env.PATH = `${PATH}:${saved.PATH ?? ''}`;
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }] }));

  const { startGraph } = await import('../../scripts/verify/fixtures/fake-graph-api.mjs');
  graph = await startGraph(0, TOKEN);
  const graphUrl = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;

  const { registerApp } = await import('../../src/lib/apps/registry.js');
  const meta = join(`${project}-apps`, 'meta-ads');
  mkdirSync(dirname(meta), { recursive: true });
  cpSync(resolve('tests/fixtures/apps/meta-ads'), meta, { recursive: true });
  writeFileSync(join(meta, '.env'), `META_TOKEN=${TOKEN}\nGRAPH_URL=${graphUrl}\nMETA_ACCOUNT=act_1000\n`);
  registerApp(home, { projectRoot: project, vault: 'acme', slug: 'meta-ads', name: 'Meta Ads', root: meta });

  // The /apps template exactly as `apps new` lays it out.
  const { sdkSource } = await import('../../src/server/apps/gateway-w3.js');
  const tpl = join(`${project}-apps`, 'starter');
  cpSync(resolve('skill-apps/template'), tpl, { recursive: true });
  renameSync(join(tpl, 'gitignore.txt'), join(tpl, '.gitignore'));
  writeFileSync(join(tpl, 'dreamcontext-app.json'), readFileSync(join(tpl, 'dreamcontext-app.json'), 'utf-8').replace('__SLUG__', 'starter').replace('__NAME__', 'Starter'));
  cpSync(resolve('assets/notify-icon.icns'), join(tpl, 'icon.icns'));
  mkdirSync(join(tpl, 'lib'), { recursive: true });
  writeFileSync(join(tpl, 'lib', 'dc.mjs'), sdkSource());
  registerApp(home, { projectRoot: project, vault: 'acme', slug: 'starter', name: 'Starter', root: tpl });

  const { buildRouter, makeRequestHandler } = await import('../../src/server/index.js');
  const { setAppsHomeForTests } = await import('../../src/server/routes/apps.js');
  const { configureGateways } = await import('../../src/server/apps/gateway.js');
  setAppsHomeForTests(home);
  const router = buildRouter();
  server = http.createServer(makeRequestHandler({ gate: () => true, router, dashboardDir: home, contextRoot: null }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  configureGateways({ home, dashboardPort: port, router });
}, 60_000);

afterAll(async () => {
  const { stopAllRuntimes } = await import('../../src/lib/apps/supervisor.js');
  const { closeAllGateways } = await import('../../src/server/apps/gateway.js');
  stopAllRuntimes();
  await closeAllGateways();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => graph.close(() => r()));
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  if (saved.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved.DESKTOP;
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

describe('the Meta Ads example app (fictional Graph API)', () => {
  it('lists every campaign, following paging on the server', async () => {
    const r = await call('meta-ads', { method: 'GET', path: '/api/campaigns' });
    expect(r.status).toBe(200);
    const list = JSON.parse(r.json.body).campaigns;
    expect(list.map((c: { id: string }) => c.id)).toEqual(['1201', '1202', '1203']);
    expect(list[0].name).toBe('Kış İndirimi');
  }, 30_000);

  it('pauses and resumes a campaign, the same action an agent runs with `apps do`', async () => {
    expect(JSON.parse((await call('meta-ads', { method: 'POST', path: '/api/campaigns/pause', body: { id: '1202' } })).json.body)).toMatchObject({ ok: true, status: 'PAUSED' });
    let list = JSON.parse((await call('meta-ads', { method: 'GET', path: '/api/campaigns' })).json.body).campaigns;
    expect(list.find((c: { id: string }) => c.id === '1202').status).toBe('PAUSED');
    await call('meta-ads', { method: 'POST', path: '/api/campaigns/resume', body: { id: '1202' } });
    list = JSON.parse((await call('meta-ads', { method: 'GET', path: '/api/campaigns' })).json.body).campaigns;
    expect(list.find((c: { id: string }) => c.id === '1202').status).toBe('ACTIVE');
  }, 30_000);

  it('a raw Graph page with the token in paging.next comes back masked; the logs hold no token', async () => {
    const r = await call('meta-ads', { method: 'GET', path: '/debug/raw' });
    expect(r.json.body).not.toContain(TOKEN);
    expect(r.json.body).toContain('access_token=••••');
    const { listApps } = await import('../../src/lib/apps/registry.js');
    const { existingRuntime } = await import('../../src/lib/apps/supervisor.js');
    const rt = existingRuntime(listApps(home).find((a) => a.slug === 'meta-ads')!.hash)!;
    expect(rt.log.tail().join('\n')).not.toContain(TOKEN);
  }, 30_000);
});

describe('the /apps template', () => {
  it('runs under the supervisor as written: guarded, loopback-bound, data in DC_DATA_DIR', async () => {
    const a = await call('starter', { method: 'GET', path: '/api/hello' });
    expect(a.status).toBe(200);
    expect(JSON.parse(a.json.body)).toEqual({ hello: 'from the backend', visits: 1 });
    const b = await call('starter', { method: 'GET', path: '/api/hello' });
    expect(JSON.parse(b.json.body).visits).toBe(2);
    const { listApps } = await import('../../src/lib/apps/registry.js');
    const { existingRuntime } = await import('../../src/lib/apps/supervisor.js');
    const rt = existingRuntime(listApps(home).find((x) => x.slug === 'starter')!.hash)!;
    expect(rt.state).toBe('running');
    expect(rt.status().warnings).toEqual([]);
  }, 30_000);

  it('carries no look of its own: no stylesheet, no style, no color, a page that still runs', () => {
    expect(existsSync(resolve('skill-apps/template/public/style.css'))).toBe(false);
    const html = readFileSync(resolve('skill-apps/template/public/index.html'), 'utf-8');
    expect(html).not.toMatch(/<style|<link|\bstyle=|class=/);
    const js = readFileSync(resolve('skill-apps/template/public/app.js'), 'utf-8');
    expect(js).toContain("from '/__dc/sdk.js'");
    expect(js).toContain('/api/hello');
    // The fallback page for an install with no template says the same.
    expect(readFileSync(resolve('src/cli/commands/apps.ts'), 'utf-8')).not.toMatch(/#6d4aff|<style>/);
  });

  it("keeps every page script in a file: the template's own CSP refuses inline script", () => {
    const csp = /const CSP = "([^"]+)"/.exec(readFileSync(resolve('skill-apps/template/server.mjs'), 'utf-8'))![1];
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    const html = readFileSync(resolve('skill-apps/template/public/index.html'), 'utf-8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc="\/[^"]+"/);
      expect(body.trim()).toBe('');
    }
  });
});
