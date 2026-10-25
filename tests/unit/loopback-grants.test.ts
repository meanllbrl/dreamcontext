/**
 * The owner's "Always allow localhost:PORT" (jarvis plan r9, K4, AC3): per vault, on the
 * machine (an injected home), 0600, never a symlink, never an owned port, read or written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_GRANTS, loopbackGrantsPath, readLoopbackGrants, setLoopbackGrant } from '../../src/lib/loopback-grants.js';

let home: string;
let other: string;
const NONE = new Set<number>();
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'grants-')); other = mkdtempSync(join(tmpdir(), 'grants-other-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });

describe('loopback grants', () => {
  it('a grant is per vault, survives a re-read (an app restart), and a revoke removes it', () => {
    setLoopbackGrant('/v/acme', 5173, 'grant', NONE, home, 1);
    expect(readLoopbackGrants('/v/acme', NONE, home)).toEqual([{ port: 5173, grantedAt: 1 }]);
    expect(readLoopbackGrants('/v/beta', NONE, home)).toEqual([]);
    setLoopbackGrant('/v/acme', 5173, 'revoke', NONE, home);
    expect(readLoopbackGrants('/v/acme', NONE, home)).toEqual([]);
  });

  it('the file is 0600 under ~/.dreamcontext, and another home is never touched', () => {
    setLoopbackGrant('/v/acme', 3000, 'grant', NONE, home);
    if (process.platform !== 'win32') expect(lstatSync(loopbackGrantsPath(home)).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(readLoopbackGrants('/v/acme', NONE, other)).toEqual([]);
    expect(() => lstatSync(loopbackGrantsPath(other))).toThrow();
  });

  it('a grant that matches a port this process owns NOW is dropped on read, and refused on write', () => {
    setLoopbackGrant('/v/acme', 4173, 'grant', NONE, home);
    expect(readLoopbackGrants('/v/acme', new Set([4173]), home)).toEqual([]);
    expect(() => setLoopbackGrant('/v/acme', 4174, 'grant', new Set([4174]), home)).toThrow(/owned-port/);
  });

  it('a symlinked file is neither read nor written through', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    const target = join(other, 'evil.json');
    writeFileSync(target, JSON.stringify({ '/v/acme': [{ port: 22, grantedAt: 1 }] }));
    symlinkSync(target, loopbackGrantsPath(home));
    expect(readLoopbackGrants('/v/acme', NONE, home)).toEqual([]);
    expect(() => setLoopbackGrant('/v/acme', 5173, 'grant', NONE, home)).toThrow(/symlink/);
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ '/v/acme': [{ port: 22, grantedAt: 1 }] });
  });

  it('only {port, grantedAt} survive; junk and a non-absolute vault key are dropped; at most MAX_GRANTS', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(loopbackGrantsPath(home), JSON.stringify({
      '/v/acme': [{ port: 5173, grantedAt: 1, extra: 'x' }, { port: 'x' }, { port: 70000, grantedAt: 1 }, { port: 5173, grantedAt: 2 }],
      relative: [{ port: 1, grantedAt: 1 }],
    }));
    expect(readLoopbackGrants('/v/acme', NONE, home)).toEqual([{ port: 5173, grantedAt: 1 }]);
    for (let p = 1; p <= MAX_GRANTS + 5; p++) setLoopbackGrant('/v/many', 10000 + p, 'grant', NONE, home, p);
    expect(readLoopbackGrants('/v/many', NONE, home)).toHaveLength(MAX_GRANTS);
  });
});

describe('the grant routes: the owner\'s own window only', async () => {
  const { PassThrough } = await import('node:stream');
  const { handleLoopbackGrantSet, handleLoopbackGrantsGet } = await import('../../src/server/routes/agent-chat.js');
  const { markPhoneSocket } = await import('../../src/server/phone-origin.js');
  const { claimOwnedPort, resetOwnedPortsForTests } = await import('../../src/server/owned-ports.js');
  const { ROUTE_POLICY } = await import('../../src/lib/handsfree/mac/route-policy.js');
  type Req = import('node:http').IncomingMessage;
  type Res = import('node:http').ServerResponse;
  const saved = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };
  let vault: string;
  beforeEach(() => {
    process.env.HOME = home;
    process.env.DREAMCONTEXT_DESKTOP = '1';
    vault = join(home, 'acme', '_dream_context');
    mkdirSync(vault, { recursive: true });
    resetOwnedPortsForTests();
  });
  afterEach(() => {
    process.env.HOME = saved.HOME;
    if (saved.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved.DESKTOP;
    resetOwnedPortsForTests();
  });
  const call = async (h: (q: Req, r: Res, p: Record<string, string>, root: string) => Promise<void>, o: { headers?: Record<string, string>; body?: unknown; phone?: boolean; method?: string } = {}) => {
    const q = new PassThrough() as unknown as Req & InstanceType<typeof PassThrough>;
    const socket = { remoteAddress: '127.0.0.1' };
    if (o.phone) markPhoneSocket(socket);
    Object.assign(q, { headers: { host: '127.0.0.1:4173', ...(o.headers ?? {}) }, socket, method: o.method ?? 'POST', url: '/' });
    setImmediate(() => (q as unknown as InstanceType<typeof PassThrough>).end(o.body === undefined ? '' : JSON.stringify(o.body)));
    const out = { status: 0, json: {} as Record<string, unknown> };
    const r = { writeHead: (s: number) => { out.status = s; }, end: (b?: string) => { out.json = b ? JSON.parse(b) : {}; }, setHeader: () => {} } as unknown as Res;
    await h(q, r, {}, vault);
    return out;
  };

  it('the app grants, reads back and revokes; owned ports come with the read', async () => {
    claimOwnedPort(4173);
    const own = { origin: 'http://127.0.0.1:4173' };
    expect((await call(handleLoopbackGrantSet, { headers: own, body: { port: 5173, op: 'grant' } })).status).toBe(200);
    const read = await call(handleLoopbackGrantsGet, { method: 'GET', headers: own });
    expect(read.status).toBe(200);
    expect((read.json.grants as { port: number }[]).map((g) => g.port)).toEqual([5173]);
    expect(read.json.ownedPorts).toEqual([4173]);
    expect((await call(handleLoopbackGrantSet, { headers: own, body: { port: 4173, op: 'grant' } })).status).toBe(403);
    await call(handleLoopbackGrantSet, { headers: own, body: { port: 5173, op: 'revoke' } });
    expect((await call(handleLoopbackGrantsGet, { method: 'GET' })).json.grants).toEqual([]);
  });

  it('another loopback port, a rebinding page, the phone, or outside the desktop app → 403 (read and write)', async () => {
    const body = { port: 5173, op: 'grant' };
    expect((await call(handleLoopbackGrantSet, { headers: { origin: 'http://localhost:5173' }, body })).status).toBe(403);
    expect((await call(handleLoopbackGrantsGet, { method: 'GET', headers: { origin: 'http://localhost:5173' } })).status).toBe(403);
    expect((await call(handleLoopbackGrantSet, { headers: { host: 'evil.test:4173', origin: 'http://evil.test:4173' }, body })).status).toBe(403);
    expect((await call(handleLoopbackGrantSet, { phone: true, body })).status).toBe(403);
    delete process.env.DREAMCONTEXT_DESKTOP;
    expect((await call(handleLoopbackGrantSet, { body })).status).toBe(403);
    expect(readLoopbackGrants(vault, NONE, home)).toEqual([]);
  });

  it('both routes are denied on the phone/tunnel surface', () => {
    expect(ROUTE_POLICY['GET /api/agent/loopback-grants']?.allow).toBe(false);
    expect(ROUTE_POLICY['POST /api/agent/loopback-grant']?.allow).toBe(false);
  });
});
