// The dashboard on the hands-free CLOUD never calls a route the cloud refuses (AC4): the server
// flags its index.html, the dashboard mirrors the cloud's API allow-list (drift-tested against
// src/server/cloud-mode.ts), and the shared API client answers a refused route locally without
// sending it.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLOUD_DEVICE_API_ROUTES as SERVER_DEVICE, CLOUD_PUBLIC_ROUTES as SERVER_PUBLIC, classifyCloudRoute,
} from '../../src/server/cloud-mode.js';
import { CLOUD_SURFACE_META, indexHtmlFor } from '../../src/server/static.js';
import {
  CLOUD_DEVICE_API_ROUTES, CLOUD_PUBLIC_ROUTES, cloudAllows, isCloudSurface, setCloudSurfaceForTests,
} from '../../dashboard/src/lib/cloudSurface.js';
import { ApiClient, RequestError } from '../../dashboard/src/api/client.js';

const REPO = join(__dirname, '..', '..');

/** The string literals of `export const <name>: readonly string[] = [ … ];` in a source file. */
function arrayLiteral(file: string, name: string): string[] {
  const text = readFileSync(join(REPO, file), 'utf8');
  const start = text.indexOf(`export const ${name}: readonly string[] = [`);
  expect(start, `${name} in ${file}`).toBeGreaterThan(-1);
  const body = text.slice(text.indexOf('[', start) + 1, text.indexOf('];', start));
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** The 18 routes lane I's round trip saw the mobile chat call on the cloud. */
const LAPTOP_ONLY = [
  'GET /api/agent/goal-live', 'GET /api/agent/council-live', 'GET /api/peer/peers', 'GET /api/tasks', 'GET /api/tasks/members',
  'GET /api/task-overrides', 'GET /api/board', 'GET /api/releases', 'GET /api/releases/active', 'GET /api/sleep', 'GET /api/sleep/auto',
  'GET /api/version-check', 'GET /api/brain/status', 'GET /api/brain/auth/status', 'GET /api/theses', 'GET /api/automations/threads',
  'GET /api/launcher/agent-settings', 'GET /api/launcher/upgrade/status',
];

afterEach(() => {
  setCloudSurfaceForTests(null);
  vi.unstubAllGlobals();
});

describe('mirror drift (src/server/cloud-mode.ts owns the lists)', () => {
  it('the dashboard copies equal the server lists, textually and as values', () => {
    expect(arrayLiteral('dashboard/src/lib/cloudSurface.ts', 'CLOUD_DEVICE_API_ROUTES')).toEqual(arrayLiteral('src/server/cloud-mode.ts', 'CLOUD_DEVICE_API_ROUTES'));
    expect(arrayLiteral('dashboard/src/lib/cloudSurface.ts', 'CLOUD_PUBLIC_ROUTES')).toEqual(arrayLiteral('src/server/cloud-mode.ts', 'CLOUD_PUBLIC_ROUTES'));
    expect([...CLOUD_DEVICE_API_ROUTES]).toEqual([...SERVER_DEVICE]);
    expect([...CLOUD_PUBLIC_ROUTES]).toEqual([...SERVER_PUBLIC]);
  });
});

describe('cloudAllows', () => {
  it('on the cloud it agrees with the server classifier for every listed route, the 18 refused ones and the transfer routes', () => {
    setCloudSurfaceForTests(true);
    const probe = [...SERVER_DEVICE, ...SERVER_PUBLIC, ...LAPTOP_ONLY, 'GET /api/handsfree/status', 'POST /api/handsfree/cloud/seal', 'GET /api/agent/chat-history?id=x'];
    for (const r of probe) {
      const [m, p] = r.split(' ');
      const cls = classifyCloudRoute(m, p.split('?')[0]);
      expect(cloudAllows(m, p), r).toBe(cls === 'public' || cls === 'device');
    }
    for (const r of LAPTOP_ONLY) expect(cloudAllows(...(r.split(' ') as [string, string])), r).toBe(false);
    expect(cloudAllows('GET', '/assets/index.js')).toBe(true);
  });

  it('on the laptop everything is allowed', () => {
    setCloudSurfaceForTests(false);
    for (const r of LAPTOP_ONLY) expect(cloudAllows(...(r.split(' ') as [string, string]))).toBe(true);
  });

  it('isCloudSurface reads the meta flag the cloud server injects', () => {
    vi.stubGlobal('document', { querySelector: (sel: string) => (sel.includes('dreamcontext-surface') ? { getAttribute: () => 'cloud' } : null) });
    expect(isCloudSurface()).toBe(true);
    setCloudSurfaceForTests(null);
    vi.stubGlobal('document', { querySelector: () => null });
    expect(isCloudSurface()).toBe(false);
  });
});

describe('the shared API client guard', () => {
  it('on the cloud a refused route is never sent (403 cloud_unavailable locally); an allowed one is', async () => {
    setCloudSurfaceForTests(true);
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { sent.push(url); return new Response('{}', { status: 200 }); }));
    const api = new ApiClient('proj');
    for (const r of LAPTOP_ONLY) {
      const err = await api.get(r.split(' ')[1].slice('/api'.length)).catch((e: unknown) => e);
      expect(err, r).toBeInstanceOf(RequestError);
      expect(err).toMatchObject({ status: 403, code: 'cloud_unavailable' });
    }
    await api.put('/sleep/auto', {}).catch(() => {});
    expect(sent).toEqual([]);
    await api.get('/agent/sessions');
    expect(sent).toEqual(['/api/agent/sessions']);
  });

  it('on the laptop the client sends every route', async () => {
    setCloudSurfaceForTests(false);
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { sent.push(url); return new Response('{}', { status: 200 }); }));
    await new ApiClient(null).get('/tasks');
    expect(sent).toEqual(['/api/tasks']);
  });
});

describe('the server flag', () => {
  it('index.html carries the meta flag only on the cloud, inside <head>', () => {
    const html = Buffer.from('<!doctype html><html><head>\n<meta charset="UTF-8" /></head><body></body></html>');
    expect(indexHtmlFor(html, false)).toBe(html);
    const cloud = indexHtmlFor(html, true).toString('utf8');
    expect(cloud).toBe(`<!doctype html><html><head>${CLOUD_SURFACE_META}\n<meta charset="UTF-8" /></head><body></body></html>`);
  });
});
