/**
 * Mağaza D1 criteria 5 and C3: the server refuses a not-installed plugin's writes (409
 * `plugin_not_installed`), never its reads, and `/api/plugins` installs, removes and pins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRouter, makeRequestHandler } from '../../src/server/index.js';
import { PLUGINS } from '../../src/lib/plugins/registry.js';
import { isPluginInstalled } from '../../src/lib/plugins/store.js';
import { readBrainLocal } from '../../src/lib/setup-config.js';

let project: string;
let ctx: string;
let server: http.Server;
let port: number;

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'dc-plugins-routes-'));
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  mkdirSync(join(ctx, 'core'), { recursive: true });
  writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '0.41.22', disableNativeMemory: true }));
  const router = buildRouter();
  server = http.createServer(makeRequestHandler({ gate: () => true, router, dashboardDir: project, contextRoot: ctx }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(project, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, json };
}

const fill = (pattern: string): string => pattern.replace(/:([a-zA-Z_]+)/g, 'x');

describe('the server gate', () => {
  it('every apiWrites route answers 409 plugin_not_installed in a new project', async () => {
    for (const p of PLUGINS) {
      for (const route of p.apiWrites) {
        const [method, pattern] = route.split(' ');
        const r = await call(method, fill(pattern), {});
        expect({ route, status: r.status, error: r.json.error, plugin: r.json.plugin })
          .toEqual({ route, status: 409, error: 'plugin_not_installed', plugin: p.id });
      }
    }
  });

  it('reads answer as today', async () => {
    for (const path of ['/api/lab', '/api/objectives', '/api/theses', '/api/council', '/api/roadmap']) {
      const r = await call('GET', path);
      expect({ path, refused: r.json.error === 'plugin_not_installed' }).toEqual({ path, refused: false });
    }
  });

  it('the always-pass routes pass', async () => {
    const stop = await call('POST', '/api/roadmap/scoring/stop', {});
    expect(stop.json.error).not.toBe('plugin_not_installed');
    const enable = await call('POST', '/api/learning/enable', {});
    expect(enable.status).toBe(200);
    expect(isPluginInstalled(ctx, 'hypotheses')).toBe(true);
    const disable = await call('POST', '/api/learning/disable', {});
    expect(disable.status).toBe(200);
    expect(isPluginInstalled(ctx, 'hypotheses')).toBe(false);
  });

  it('an installed plugin is not refused', async () => {
    const before = await call('PUT', '/api/lab-prefs', {});
    expect(before.json.error).toBe('plugin_not_installed');
    await call('POST', '/api/plugins/lab/install');
    const after = await call('PUT', '/api/lab-prefs', {});
    expect(after.json.error).not.toBe('plugin_not_installed');
  });
});

describe('/api/plugins', () => {
  it('lists every plugin with its state, source and pin', async () => {
    const r = await call('GET', '/api/plugins');
    expect(r.status).toBe(200);
    const plugins = r.json.plugins as Array<Record<string, unknown>>;
    expect(plugins.map((p) => p.id)).toEqual(PLUGINS.map((p) => p.id));
    expect(typeof r.json.version).toBe('string');
    expect(plugins.find((p) => p.id === 'lab')).toMatchObject({ installed: true, source: 'chosen', pinned: true });
    expect(plugins.find((p) => p.id === 'council')).toMatchObject({ installed: false, source: 'none', pinned: false, automations: [] });
  });

  it('install / remove / pins round trip; 404 for an unknown id', async () => {
    expect((await call('POST', '/api/plugins/council/install')).status).toBe(200);
    expect(isPluginInstalled(ctx, 'council')).toBe(true);
    expect((await call('POST', '/api/plugins/council/remove')).status).toBe(200);
    expect(isPluginInstalled(ctx, 'council')).toBe(false);
    expect((await call('POST', '/api/plugins/hackathon/install')).status).toBe(404);
    const pins = await call('PUT', '/api/plugins/pins', { pinned: ['roadmap', 'nope'] });
    expect(pins.status).toBe(200);
    expect(readBrainLocal(project).pluginPins).toEqual(['roadmap']);
    expect((await call('PUT', '/api/plugins/pins', { pinned: 'lab' })).status).toBe(400);
  });

  it('a conflicted entry answers 409 plugin_entry_conflict naming the file', async () => {
    mkdirSync(join(ctx, 'overrides', 'plugins'), { recursive: true });
    writeFileSync(join(ctx, 'overrides', 'plugins', 'roadmap.json'), [
      '<<<<<<< HEAD',
      JSON.stringify({ state: 'installed', at: '2026-11-17T10:00:00Z', by: 'a' }),
      '=======',
      JSON.stringify({ state: 'removed', at: '2026-11-17T11:00:00Z', by: 'b' }),
      '>>>>>>> theirs',
      '',
    ].join('\n'));
    const r = await call('POST', '/api/plugins/roadmap/install');
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'plugin_entry_conflict', file: 'overrides/plugins/roadmap.json' });
    const list = await call('GET', '/api/plugins');
    expect((list.json.plugins as Array<Record<string, unknown>>).find((p) => p.id === 'roadmap'))
      .toMatchObject({ installed: false, conflict: true, file: 'overrides/plugins/roadmap.json' });
  });
});
