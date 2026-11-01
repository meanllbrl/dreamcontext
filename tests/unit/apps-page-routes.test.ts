import { describe, it, expect } from 'vitest';
import { PAGE_ROUTES, deniedForEveryone, narrowPageBody, pageRouteDecision } from '../../src/lib/apps/page-routes.js';
import { buildRouter } from '../../src/server/index.js';

/**
 * An app PAGE's reach into the dashboard API is a closed list (dreamcontext-apps plan r19).
 * Walk the real router: every listed route exists, everything else is refused, and the routes
 * that run, approve or speak for an agent are never on the list.
 */
const router = buildRouter();
const registered = new Set(router.list().map((r) => `${r.method} ${r.path}`));
const concrete = (path: string) => path.replace(/:[a-zA-Z_]+/g, 'xyz').replace(/\*[a-zA-Z_]+/g, 'a/b');

describe('PAGE_ROUTES', () => {
  it('every entry is a registered route that the router resolves to itself', () => {
    for (const key of PAGE_ROUTES) {
      expect(registered.has(key), key).toBe(true);
      const [method, path] = key.split(' ');
      const d = pageRouteDecision(router, method, concrete(path));
      expect(d.ok && d.key, key).toBe(key);
    }
  });

  it('every other registered route is refused to a page', () => {
    for (const key of registered) {
      if (PAGE_ROUTES.includes(key)) continue;
      const [method, path] = key.split(' ');
      const d = pageRouteDecision(router, method, concrete(path));
      expect(d.ok, key).toBe(false);
    }
  });

  it('nothing that runs, approves, assigns or speaks for an agent is on the list', () => {
    const forbidden = /assign-agent|questions|\/run\b|approve|enable|threads\/say|thread\/reply|agents\/:slug\/update|sleep\/auto|core\/:filename|agent\/file|\/api\/apps/;
    for (const key of PAGE_ROUTES) expect(forbidden.test(key), key).toBe(false);
    expect(deniedForEveryone('/api/automations/threads/say')).toBe(true);
    expect(deniedForEveryone('/api/automations/ua/thread/reply')).toBe(true);
    expect(deniedForEveryone('/api/apps/x/call')).toBe(true);
  });

  it('a malformed escape is a 400, never a throw', () => {
    expect(pageRouteDecision(router, 'GET', '/api/tasks/%zz')).toMatchObject({ ok: false, status: 400 });
  });

  it('page task writes are rebuilt: PATCH body/agent/status refused, POST stamped by agent', () => {
    for (const bad of [{ status: 'completed' }, { body: 'x' }, { agent: 'ua' }]) {
      expect(narrowPageBody('PATCH /api/tasks/:slug', JSON.stringify(bad))).toMatchObject({ ok: false, error: 'backend_only' });
    }
    expect(narrowPageBody('PATCH /api/tasks/:slug', JSON.stringify({ priority: 'high', tags: ['a'] }))).toEqual({ ok: true, body: JSON.stringify({ priority: 'high', tags: ['a'] }) });
    for (const k of ['by', 'basis', 'quote', 'evidence', 'neighborChecked', 'declinedChecked', 'parent_task', 'version', 'rice', 'custom_fields']) {
      expect(narrowPageBody('POST /api/tasks', JSON.stringify({ name: 'n', [k]: 'x' })).ok, k).toBe(false);
    }
    expect(narrowPageBody('POST /api/tasks', JSON.stringify({ name: 'n' }))).toEqual({ ok: true, body: JSON.stringify({ name: 'n', by: 'agent' }) });
  });
});
