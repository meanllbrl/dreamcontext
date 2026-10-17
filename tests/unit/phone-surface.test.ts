// The dashboard on a Mac-mode phone never calls a route the phone listener refuses: the server
// flags its index.html, the dashboard mirrors the policy's denied rows (drift-tested against
// src/lib/handsfree/mac/route-policy.ts), and the shared API client answers a refused route
// locally without sending it.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAC_PUBLIC_ROUTES as SERVER_PUBLIC } from '../../src/lib/handsfree/mac/contract.js';
import { ROUTE_POLICY, classifyMacRoute } from '../../src/lib/handsfree/mac/route-policy.js';
import { buildRouter } from '../../src/server/index.js';
import { MAC_SURFACE_META, indexHtmlFor } from '../../src/server/static.js';
import {
  MAC_DENIED_API_ROUTES, MAC_PUBLIC_ROUTES, isMacPhoneSurface, isPhoneSurface, phoneAllows, setPhoneSurfaceForTests,
} from '../../dashboard/src/lib/phoneSurface.js';
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

/** Laptop-only routes the dashboard calls. */
const LAPTOP_ONLY = [
  'GET /api/launcher/status', 'POST /api/launcher/register', 'GET /api/recall/options', 'POST /api/brain/sync',
  'POST /api/handsfree/mac/start', 'GET /api/assistant/status', 'GET /api/notifications', 'GET /api/lab/credentials',
];

const router = buildRouter();
const concrete = (path: string) => path.replace(/\*[a-zA-Z_]+/g, 'a/b').replace(/:[a-zA-Z_]+/g, 'xyz');

afterEach(() => {
  setPhoneSurfaceForTests(null);
  vi.unstubAllGlobals();
});

describe('the mirror', () => {
  it('equals the server lists, in order (regenerate the deny list from ROUTE_POLICY when this fails)', () => {
    expect([...MAC_PUBLIC_ROUTES]).toEqual([...SERVER_PUBLIC]);
    const denied = Object.entries(ROUTE_POLICY).filter(([, r]) => !r.allow).map(([k]) => k);
    expect([...MAC_DENIED_API_ROUTES]).toEqual(denied);
    expect(arrayLiteral('dashboard/src/lib/phoneSurface.ts', 'MAC_PUBLIC_ROUTES')).toEqual(arrayLiteral('src/lib/handsfree/mac/contract.ts', 'MAC_PUBLIC_ROUTES'));
  });

  it('on the phone, phoneAllows agrees with the server gate on EVERY registered route', () => {
    setPhoneSurfaceForTests('mac');
    expect(isMacPhoneSurface()).toBe(true);
    expect(isPhoneSurface()).toBe(true);
    const disagree: string[] = [];
    for (const r of router.list()) {
      const path = concrete(r.path);
      const cls = classifyMacRoute(r.method, path, (m, p) => router.match(m, p));
      if (phoneAllows(r.method, path) !== (cls !== 'unavailable')) disagree.push(`${r.method} ${r.path}`);
    }
    expect(disagree).toEqual([]);
    for (const r of LAPTOP_ONLY) expect(phoneAllows(...(r.split(' ') as [string, string])), r).toBe(false);
    expect(phoneAllows('GET', '/assets/index.js')).toBe(true);
    expect(phoneAllows('GET', '/api/tasks?vault=proj')).toBe(true);
  });

  it('off the phone every route is allowed', () => {
    setPhoneSurfaceForTests(null);
    expect(isPhoneSurface()).toBe(false);
    for (const r of LAPTOP_ONLY) expect(phoneAllows(...(r.split(' ') as [string, string]))).toBe(true);
  });
});

describe('the shared API client guard', () => {
  it('on the phone a refused route is never sent (403 phone_unavailable locally); an allowed one is', async () => {
    setPhoneSurfaceForTests('mac');
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { sent.push(url); return new Response('{}', { status: 200 }); }));
    const api = new ApiClient('proj');
    for (const r of LAPTOP_ONLY.filter((x) => x.startsWith('GET '))) {
      const err = await api.get(r.split(' ')[1].slice('/api'.length)).catch((e: unknown) => e);
      expect(err, r).toBeInstanceOf(RequestError);
      expect(err).toMatchObject({ status: 403, code: 'phone_unavailable' });
    }
    expect(sent).toEqual([]);
    await api.get('/tasks');
    expect(sent).toEqual(['/api/tasks']);
  });

  it('on the laptop the client sends every route', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { sent.push(url); return new Response('{}', { status: 200 }); }));
    await new ApiClient(null).get('/tasks');
    expect(sent).toEqual(['/api/tasks']);
  });
});

describe('the server flag', () => {
  it('index.html carries content="mac" for a phone socket only, inside <head>', () => {
    const html = Buffer.from('<!doctype html><html><head>\n<meta charset="UTF-8" /></head><body></body></html>');
    expect(indexHtmlFor(html, null)).toBe(html);
    expect(indexHtmlFor(html, 'mac').toString('utf8')).toBe(`<!doctype html><html><head>${MAC_SURFACE_META}\n<meta charset="UTF-8" /></head><body></body></html>`);
  });
});
