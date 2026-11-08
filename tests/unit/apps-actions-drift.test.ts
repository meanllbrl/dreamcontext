import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditTools } from '../../src/lib/apps/supervisor.js';

/**
 * Manifest vs backend (app-araclari plan r3 §2, "ask the subject"): the backend's own health
 * answer (`dc.health()`) lists the tools it serves; a manifest tool missing there is drift, and a
 * backend that does not say is "not audited".
 */

describe('auditTools', () => {
  it('every tool served: ok', () => {
    expect(auditTools('{"ok":true,"dcActions":["a","b","extra"]}', ['a', 'b'])).toEqual({ state: 'ok', missing: [] });
  });
  it('a manifest tool the backend does not serve: drift, named', () => {
    expect(auditTools('{"ok":true,"dcActions":["a"]}', ['a', 'b', 'c'])).toEqual({ state: 'drift', missing: ['b', 'c'] });
  });
  it('no list (plain "ok", no SDK, a cut body): not audited', () => {
    for (const body of ['ok', '', '{"ok":true}', '{"ok":true,"dcActions":"a"}', '{"ok":true,"dcActi']) {
      expect(auditTools(body, ['a'])).toEqual({ state: 'unaudited', missing: [] });
    }
  });
});

describe('the SDK says what it serves', () => {
  it('dc.actions + dc.health() answer {ok, dcActions}', async () => {
    const { dc } = await import('../../src/lib/apps/sdk/dc.mjs');
    expect(dc.health()).toEqual({ ok: true });
    dc.actions({ snapshot: () => null, ask: () => null });
    expect(dc.health({ db: 'up' })).toEqual({ db: 'up', ok: true, dcActions: ['snapshot', 'ask'] });
    dc.actions(['hello']);
    expect(auditTools(JSON.stringify(dc.health()), ['hello', 'gone'])).toEqual({ state: 'drift', missing: ['gone'] });
  });

  it('the template answers health with dc.health() and declares its tool', () => {
    const server = readFileSync(join(__dirname, '..', '..', 'skill-apps', 'template', 'server.mjs'), 'utf-8');
    expect(server).toContain("json(res, 200, dc.health())");
    expect(server).toContain("dc.actions(['hello'])");
  });
});
