/**
 * T7 — the dashboard's three additive people routes.
 *
 *   GET  /api/core/people        → { activeSlug, source, people[] }
 *   GET  /api/core/people/:slug  → { slug, name, content }
 *   PUT  /api/core/people/:slug  → { ok: true }
 *
 * Two things are load-bearing here and both are asserted against the REAL
 * router, not a paraphrase of it:
 *
 *  1. ORDER — the people routes are registered before `/api/core/:filename`,
 *     which is a single-segment matcher that would otherwise swallow
 *     `/api/core/people` as a core FILE named "people" (first match wins).
 *  2. SLUG DISCIPLINE — `:slug` is validated against the person charset BEFORE
 *     any filesystem access. The router percent-DECODES params after matching,
 *     so `..%2f..%2f…` arrives at the handler already unescaped; a sentinel file
 *     outside the vault proves nothing is read on the way to the rejection.
 *
 * Plus the D17 read-path rule: a corrupt `people.json` degrades to an empty
 * roster at 200 — on the list route and on `/api/tasks/members` — because the
 * dashboard must render and `doctor` is the loud channel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleCoreGet,
  handleCoreList,
  handlePeopleList,
  handlePersonGet,
  handlePersonUpdate,
} from '../../src/server/routes/core.js';
import { handleTasksMembers } from '../../src/server/routes/tasks.js';
import { buildRouter } from '../../src/server/index.js';
import { PERSON_ENV_VAR } from '../../src/lib/people-resolve.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function getReq(): IncomingMessage {
  return { method: 'GET', headers: {} } as unknown as IncomingMessage;
}

/** A PUT request whose body streams `payload` — matches what parseJsonBody consumes. */
function putReq(payload: unknown): IncomingMessage {
  const chunks = [Buffer.from(JSON.stringify(payload), 'utf-8')];
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const req = {
    method: 'PUT',
    headers: {},
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(cb);
      // Emit on the next tick so both `data` and `end` are subscribed first.
      if (event === 'end') {
        setImmediate(() => {
          for (const chunk of chunks) for (const fn of listeners.data ?? []) fn(chunk);
          for (const fn of listeners.end ?? []) fn();
        });
      }
      return req;
    },
  } as unknown as IncomingMessage;
  return req;
}

const PERSON_MD = (name: string) => [
  '---',
  `name: ${name}`,
  'type: person',
  'updated: "2026-07-01"',
  '---',
  '',
  '## Identity',
  '',
  `- ${name} owns the thing.`,
  '',
].join('\n');

let tmpDir: string;
let contextRoot: string;
/** Lives OUTSIDE the vault — must never be read by a rejected request. */
let sentinelOutside: string;

function seedRoster(json: string): void {
  mkdirSync(join(contextRoot, 'people'), { recursive: true });
  writeFileSync(join(contextRoot, 'people', 'people.json'), json, 'utf-8');
}

function seedTwoPeople(): void {
  seedRoster(JSON.stringify({
    version: 1,
    people: {
      'ada-lovelace': { name: 'Ada Lovelace', emails: ['ada@example.com'], role: 'engineer' },
      'grace-hopper': { name: 'Grace Hopper', emails: ['grace@example.com'] },
    },
  }, null, 2));
  writeFileSync(join(contextRoot, 'people', 'ada-lovelace.md'), PERSON_MD('Ada Lovelace'), 'utf-8');
  writeFileSync(join(contextRoot, 'people', 'grace-hopper.md'), PERSON_MD('Grace Hopper'), 'utf-8');
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `dc-people-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'core'), { recursive: true });
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeFileSync(join(contextRoot, 'core', '0.soul.md'), '---\nname: soul\n---\n\n# SOUL\n', 'utf-8');
  sentinelOutside = join(tmpDir, 'sentinel.md');
  writeFileSync(sentinelOutside, '# SENTINEL — must never be served by a people route\n', 'utf-8');
  delete process.env[PERSON_ENV_VAR];
});

afterEach(() => {
  delete process.env[PERSON_ENV_VAR];
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Route registration + order ──────────────────────────────────────────────

describe('people routes are registered before /api/core/:filename', () => {
  const router = buildRouter();

  it('routes GET /api/core/people to the roster handler, not the core-file handler', () => {
    const match = router.match('GET', '/api/core/people');
    expect(match?.handler).toBe(handlePeopleList);
  });

  it('routes GET|PUT /api/core/people/:slug to the person handlers with a decoded slug', () => {
    expect(router.match('GET', '/api/core/people/ada-lovelace')?.handler).toBe(handlePersonGet);
    expect(router.match('GET', '/api/core/people/ada-lovelace')?.params.slug).toBe('ada-lovelace');
    expect(router.match('PUT', '/api/core/people/ada-lovelace')?.handler).toBe(handlePersonUpdate);
  });

  it('leaves the existing core routes matching exactly as before', () => {
    expect(router.match('GET', '/api/core')?.handler).toBe(handleCoreList);
    expect(router.match('GET', '/api/core/0.soul.md')?.handler).toBe(handleCoreGet);
  });
});

// ─── GET /api/core/people ────────────────────────────────────────────────────

describe('GET /api/core/people', () => {
  it('lists the roster, sorted by name, with the active person flagged', async () => {
    seedTwoPeople();
    process.env[PERSON_ENV_VAR] = 'grace-hopper';

    const { res, status, body } = makeRes();
    await handlePeopleList(getReq(), res, {}, contextRoot);

    expect(status()).toBe(200);
    expect(body().activeSlug).toBe('grace-hopper');
    expect(body().source).toBe('env');
    expect(body().people.map((p: { slug: string }) => p.slug)).toEqual(['ada-lovelace', 'grace-hopper']);
    expect(body().people.map((p: { active: boolean }) => p.active)).toEqual([false, true]);
    // `role` rides along only when the roster has one; `chars` is the
    // constitution's String.length, matching auditCoreFileSizes.
    expect(body().people[0].role).toBe('engineer');
    expect(body().people[1].role).toBeUndefined();
    expect(body().people[0].chars).toBe(PERSON_MD('Ada Lovelace').length);
    // No apology field on the happy path.
    expect(body().error).toBeUndefined();
  });

  it('answers an empty roster with source "none" on a vault that has no people/', async () => {
    const { res, status, body } = makeRes();
    await handlePeopleList(getReq(), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toEqual({ activeSlug: null, source: 'none', people: [] });
  });

  it('reports chars 0 for a roster entry whose constitution file is missing', async () => {
    seedRoster(JSON.stringify({ version: 1, people: { solo: { name: 'Solo', emails: [] } } }));
    const { res, status, body } = makeRes();
    await handlePeopleList(getReq(), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().people).toEqual([{ slug: 'solo', name: 'Solo', active: true, chars: 0 }]);
  });

  // D17: a corrupt roster must not crash the dashboard.
  it('degrades a corrupt people.json to an empty roster at 200, with the parse error attached', async () => {
    seedRoster('{ "version": 1, "people": { "ada": ');
    const { res, status, body } = makeRes();
    await handlePeopleList(getReq(), res, {}, contextRoot);

    expect(status()).toBe(200);
    expect(body().people).toEqual([]);
    expect(body().activeSlug).toBeNull();
    expect(body().source).toBe('none');
    expect(typeof body().error).toBe('string');
    expect(body().error).toContain('people/people.json');
  });
});

// ─── GET /api/core/people/:slug ──────────────────────────────────────────────

describe('GET /api/core/people/:slug', () => {
  it('serves the RAW constitution (frontmatter included) plus the roster name', async () => {
    seedTwoPeople();
    const { res, status, body } = makeRes();
    await handlePersonGet(getReq(), res, { slug: 'ada-lovelace' }, contextRoot);

    expect(status()).toBe(200);
    expect(body().slug).toBe('ada-lovelace');
    expect(body().name).toBe('Ada Lovelace');
    expect(body().content).toBe(PERSON_MD('Ada Lovelace'));
    expect(body().content).toContain('type: person'); // whole-file, not the body only
  });

  it('returns 404, not 500, for a slug with no constitution', async () => {
    seedTwoPeople();
    const { res, status, body } = makeRes();
    await handlePersonGet(getReq(), res, { slug: 'no-such-person' }, contextRoot);
    expect(status()).toBe(404);
    expect(body().error).toBe('not_found');
  });

  it('serves a constitution whose roster entry is unreadable, falling back to the slug as name', async () => {
    seedRoster('not json at all');
    mkdirSync(join(contextRoot, 'people'), { recursive: true });
    writeFileSync(join(contextRoot, 'people', 'ada-lovelace.md'), PERSON_MD('Ada Lovelace'), 'utf-8');

    const { res, status, body } = makeRes();
    await handlePersonGet(getReq(), res, { slug: 'ada-lovelace' }, contextRoot);
    expect(status()).toBe(200);
    expect(body().name).toBe('ada-lovelace');
  });
});

// ─── Traversal rejection ─────────────────────────────────────────────────────

describe('person routes reject every path-shaped slug before touching the filesystem', () => {
  const HOSTILE: Array<[label: string, slug: string]> = [
    ['parent-relative', '../0.soul'],
    ['double-dotted core escape', '../../core/0.soul.md'],
    ['nested path', 'people/x'],
    ['absolute path', '/etc/passwd'],
    ['windows absolute path', 'C:\\Windows\\win.ini'],
    ['bare dot', '.'],
    ['null byte', 'ada\0.md'],
    ['uppercase (off-charset)', 'Ada-Lovelace'],
    ['leading dash (off-charset)', '-ada'],
    ['200-char slug', 'a'.repeat(200)],
  ];

  for (const [label, slug] of HOSTILE) {
    it(`GET rejects ${label} with 400 invalid_path`, async () => {
      seedTwoPeople();
      const { res, status, body } = makeRes();
      await handlePersonGet(getReq(), res, { slug }, contextRoot);
      expect(status()).toBe(400);
      expect(body().error).toBe('invalid_path');
      expect(JSON.stringify(body())).not.toContain('SENTINEL');
    });

    it(`PUT rejects ${label} with 400 invalid_path`, async () => {
      seedTwoPeople();
      const before = readFileSync(sentinelOutside, 'utf-8');
      const { res, status, body } = makeRes();
      await handlePersonUpdate(putReq({ content: 'pwned' }), res, { slug }, contextRoot);
      expect(status()).toBe(400);
      expect(body().error).toBe('invalid_path');
      expect(readFileSync(sentinelOutside, 'utf-8')).toBe(before);
    });
  }

  // The router decodes params AFTER matching, so a percent-encoded traversal
  // reaches the handler already unescaped. Drive it through the real router.
  it('rejects ..%2f..%2fcore%2f0.soul.md routed through the real router', async () => {
    seedTwoPeople();
    const router = buildRouter();
    const match = router.match('GET', '/api/core/people/..%2f..%2fcore%2f0.soul.md');
    expect(match?.handler).toBe(handlePersonGet);
    expect(match?.params.slug).toBe('../../core/0.soul.md');

    const { res, status, body } = makeRes();
    await match!.handler(getReq(), res, match!.params, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_path');
    expect(JSON.stringify(body())).not.toContain('SOUL');
  });
});

// ─── PUT /api/core/people/:slug ──────────────────────────────────────────────

describe('PUT /api/core/people/:slug', () => {
  it('writes the body verbatim and answers { ok: true }', async () => {
    seedTwoPeople();
    const next = PERSON_MD('Ada Lovelace').replace('owns the thing', 'owns the compiler');

    const { res, status, body } = makeRes();
    await handlePersonUpdate(putReq({ content: next }), res, { slug: 'ada-lovelace' }, contextRoot);

    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true });
    expect(readFileSync(join(contextRoot, 'people', 'ada-lovelace.md'), 'utf-8')).toBe(next);
  });

  it('records the write for sleep consolidation', async () => {
    seedTwoPeople();
    const { res } = makeRes();
    await handlePersonUpdate(putReq({ content: 'x' }), res, { slug: 'ada-lovelace' }, contextRoot);

    const sleep = JSON.parse(readFileSync(join(contextRoot, 'state', '.sleep.json'), 'utf-8'));
    expect(sleep.dashboard_changes[0].target).toBe('people/ada-lovelace.md');
    expect(sleep.dashboard_changes[0].entity).toBe('core');
  });

  it('returns 404 for a person with no constitution — PUT never creates one', async () => {
    seedTwoPeople();
    const { res, status, body } = makeRes();
    await handlePersonUpdate(putReq({ content: 'x' }), res, { slug: 'no-such-person' }, contextRoot);
    expect(status()).toBe(404);
    expect(body().error).toBe('not_found');
  });

  it('returns 400 when content is missing or not a string', async () => {
    seedTwoPeople();
    const { res, status, body } = makeRes();
    await handlePersonUpdate(putReq({ content: 42 }), res, { slug: 'ada-lovelace' }, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('missing_content');
    // Untouched.
    expect(readFileSync(join(contextRoot, 'people', 'ada-lovelace.md'), 'utf-8'))
      .toBe(PERSON_MD('Ada Lovelace'));
  });
});

// ─── D17 blast radius: /api/tasks/members ────────────────────────────────────

describe('GET /api/tasks/members with a corrupt roster', () => {
  it('answers 200 with no assignees instead of 500', async () => {
    seedRoster('{ broken');
    const { res, status, body } = makeRes();
    await handleTasksMembers(getReq(), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().members).toEqual([]);
  });

  it('offers the people.json roster as assignee candidates on a healthy vault', async () => {
    seedTwoPeople();
    const { res, status, body } = makeRes();
    await handleTasksMembers(getReq(), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().members.map((m: { slug: string }) => m.slug).sort())
      .toEqual(['ada-lovelace', 'grace-hopper']);
    // The DISPLAY name comes from the roster now, not from title-casing a slug.
    expect(body().members.find((m: { slug: string }) => m.slug === 'ada-lovelace').name)
      .toBe('Ada Lovelace');
  });
});
