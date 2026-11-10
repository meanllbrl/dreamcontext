/**
 * A member's Permissions routes (uye-bildirim K3, G2 for rules; plan criterion 5).
 *
 *  - GET  /api/agents/:slug/permissions: the level, this project's saved rules of THAT member
 *    (never another member's, another project's, or a one-shot or job grant), each rule with its
 *    secrets redacted and every hidden or direction-changing character drawn visibly, and where a
 *    level change applies.
 *  - POST /api/agents/:slug/permissions/remove {id}: the owner's own page only (the shell's owner
 *    key): 200 with the key, 403 `owner_page_only` for the right Origin and no key, 404 for an id
 *    that is not this member's rule.
 *
 * Handlers are called directly, under a fake HOME (the grant store is machine-local).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAgent } from '../../src/lib/agents/store.js';
import { listGrants, newGrantId, writeGrant } from '../../src/lib/grants/store.js';
import type { Grant } from '../../src/lib/grants/types.js';
import { MEMBER_NO_EXPIRY } from '../../src/lib/grants/types.js';
import { handleAgentPermissionRemove, handleAgentPermissions, ruleText } from '../../src/server/routes/grants.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import type { PermissionRuleView } from '../../src/lib/super/types.js';

const KEY = 'd6'.repeat(32);
const ORIGIN_ONLY = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const OWNER = { ...ORIGIN_ONLY, [OWNER_KEY_HEADER]: KEY };
const NOW = new Date('2026-11-10T09:00:00.000Z');

let projectRoot: string;
let project: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    end(data: string) { try { body = JSON.parse(data); } catch { body = {}; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}
function req(method: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url: '/', headers, socket: { remoteAddress: '127.0.0.1', setTimeout() {} }, setTimeout() {},
  }) as unknown as IncomingMessage;
}

const rule = (over: Partial<Grant> = {}): Grant => ({
  id: newGrantId(over.scope ?? 'member'), scope: 'member', project, member: 'scout', tool: 'Bash', input: 'node scripts/report.mjs',
  form: 'script', script: { interpreter: 'node', interpreterPath: '/opt/fakebin/node', scriptPath: join(project, 'scripts', 'report.mjs'), sha256: 'a'.repeat(64) },
  createdAt: NOW.getTime(), expiresAt: MEMBER_NO_EXPIRY, ...over,
});

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-agents-routes-'));
  project = realpathSync(projectRoot);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-agents-routes-home-'));
  process.env.HOME = fakeHome;
  setOwnerKey(KEY);
  createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
  createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' }, { approve: { now: NOW } });
});
afterEach(() => {
  setOwnerKey(null);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

async function permissions(slug = 'scout') {
  const r = makeRes();
  await handleAgentPermissions(req('GET', {}), r.res, { slug }, contextRoot);
  return { status: r.status(), body: r.body() };
}

describe('GET permissions: the level and this member\'s saved rules', () => {
  it('lists only this member\'s rules in this project, newest first, and says where a level change holds', async () => {
    const mine = rule({ createdAt: NOW.getTime() + 2 });
    const older = rule({ input: 'python3 tools/sync.py', createdAt: NOW.getTime() + 1 });
    writeGrant(mine, {});
    writeGrant(older, {});
    writeGrant(rule({ member: 'writer' }), {});
    writeGrant(rule({ project: '/elsewhere/project' }), {});
    writeGrant({ ...rule(), id: newGrantId('job'), scope: 'job', pin: 'pin-1', member: undefined, form: 'exact', script: undefined, input: 'touch x', expiresAt: Date.now() + 60_000 }, {});
    const { status, body } = await permissions();
    expect(status).toBe(200);
    expect(body.level).toBe('balanced');
    expect(body.applies).toEqual({ narrowing: 'now', widening: 'next_session' });
    const rules = body.rules as PermissionRuleView[];
    expect(rules.map((r) => r.id)).toEqual([mine.id, older.id]);
    expect(rules[0]).toEqual({ id: mine.id, member: 'scout', form: 'script', rule: 'node scripts/report.mjs', createdAt: mine.createdAt });
  });

  it('an empty list says so (no rule until he taps one)', async () => {
    expect((await permissions()).body.rules).toEqual([]);
  });

  it('a rule\'s secrets are redacted and hidden characters drawn visibly', async () => {
    writeGrant(rule({ input: 'node s.mjs --key=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' }), {});
    const [r] = (await permissions()).body.rules as PermissionRuleView[];
    expect(r.rule).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
    expect(r.rule).toContain('[gizli]');
    expect(ruleText('node a\u202e.mjs')).toBe('node a\\u{202e}.mjs');
    expect(ruleText('node a\u0007.mjs')).toBe('node a\\u{0007}.mjs');
  });

  it('an unknown member is 404', async () => {
    expect((await permissions('nobody')).status).toBe(404);
  });
});

describe('POST permissions/remove: the owner\'s own page only', () => {
  it('200 with the owner key, and the rule is gone', async () => {
    const g = rule();
    writeGrant(g, {});
    const r = makeRes();
    await handleAgentPermissionRemove(req('POST', OWNER, { id: g.id }), r.res, { slug: 'scout' }, contextRoot);
    expect(r.status()).toBe(200);
    expect(r.body()).toEqual({ ok: true });
    expect(listGrants(project)).toEqual([]);
  });

  it('403 owner_page_only for the right Origin with no key, and nothing removed', async () => {
    const g = rule();
    writeGrant(g, {});
    const r = makeRes();
    await handleAgentPermissionRemove(req('POST', ORIGIN_ONLY, { id: g.id }), r.res, { slug: 'scout' }, contextRoot);
    expect(r.status()).toBe(403);
    expect(r.body().error).toBe('owner_page_only');
    expect(listGrants(project).map((x) => x.id)).toEqual([g.id]);
    // No Origin at all (an agent's curl): refused the same way.
    const bare = makeRes();
    await handleAgentPermissionRemove(req('POST', { host: '127.0.0.1:4173', [OWNER_KEY_HEADER]: 'wrong' }, { id: g.id }), bare.res, { slug: 'scout' }, contextRoot);
    expect(bare.status()).toBe(403);
  });

  it('an id that is not this member\'s rule removes nothing (404)', async () => {
    const theirs = rule({ member: 'writer' });
    writeGrant(theirs, {});
    const r = makeRes();
    await handleAgentPermissionRemove(req('POST', OWNER, { id: theirs.id }), r.res, { slug: 'scout' }, contextRoot);
    expect(r.status()).toBe(404);
    expect(listGrants(project).map((x) => x.id)).toEqual([theirs.id]);
  });
});
