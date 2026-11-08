/**
 * `/api/agent/accounts/codex/*` (Track T W2): every per-tool account route carries its Claude
 * twin's guard and route-policy class. Signing in, adopting and removing are refused from the
 * phone (and from anything that is not the desktop app on loopback); listing is the phone's too.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleCodexAccountsAdopt, handleCodexAccountsList, handleCodexAccountsLogin, handleCodexAccountsRefresh,
  handleCodexAccountsRemove, handleCodexAccountsReorder,
} from '../../src/server/routes/agent-tool-accounts.js';
import { instanceAccountsLogin, setInstanceSignInForTests } from '../../src/server/routes/agent-tool-accounts.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';
import { CODEX_PRIMARY_ID, recordCodexUsage, setCodexAccountDepsForTests } from '../../src/lib/codex-accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-tool-accounts-'));
const REAL_HOME = process.env.HOME;
afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  delete process.env.DREAMCONTEXT_DESKTOP;
  setCodexAccountDepsForTests(null);
  rmSync(HOME, { recursive: true, force: true });
});

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

async function call(h: Handler, body: unknown, o: { phone?: boolean; remote?: string } = {}): Promise<{ status: number; body: any }> {
  const captured = { status: 0, body: null as any };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    setHeader() { /* unused */ },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}), 'utf-8')]) as unknown as IncomingMessage;
  const socket = { remoteAddress: o.remote ?? '127.0.0.1', setTimeout() { /* holdOpen */ } };
  if (o.phone) markPhoneSocket(socket);
  Object.assign(req, { method: 'POST', url: '/api/agent/accounts/codex', headers: { host: '127.0.0.1:1234', 'content-type': 'application/json' }, socket });
  await h(req, res);
  return captured;
}

const SIGN_IN_ROUTES: Array<[string, Handler, string]> = [
  ['POST /api/agent/accounts/codex/login', handleCodexAccountsLogin, 'POST /api/agent/accounts/login'],
  ['POST /api/agent/accounts/codex/adopt', handleCodexAccountsAdopt, 'POST /api/agent/accounts/adopt'],
  ['POST /api/agent/accounts/codex/remove', handleCodexAccountsRemove, 'POST /api/agent/accounts/remove'],
];

beforeEach(() => {
  process.env.HOME = HOME;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  rmSync(join(HOME, '.dreamcontext'), { recursive: true, force: true });
  mkdirSync(join(HOME, '.codex'), { recursive: true });
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{}');
  // No real codex or bridge: anything that would run one fails loudly here.
  setCodexAccountDepsForTests(() => ({ home: HOME, node: null, run: async () => { throw new Error('no process may run in this test'); } }));
});

describe('per-tool account routes keep their Claude twin\'s guard and policy class', () => {
  it.each(SIGN_IN_ROUTES)('%s is refused from the phone and from a non-loopback peer, and denied by the phone policy like its twin', async (key, handler, twin) => {
    expect((await call(handler, { id: CODEX_PRIMARY_ID }, { phone: true })).status).toBe(403);
    expect((await call(handler, { id: CODEX_PRIMARY_ID }, { remote: '10.0.0.7' })).status).toBe(403);
    expect(ROUTE_POLICY[key]!.allow).toBe(false);
    expect(ROUTE_POLICY[key]!.why).toBe(ROUTE_POLICY[twin]!.why);
  });

  it('reorder and refresh are desktop + loopback like their twins, and the phone policy classes match', async () => {
    expect((await call(handleCodexAccountsReorder, { ids: [] }, { phone: true })).status).toBe(403);
    expect((await call(handleCodexAccountsRefresh, {}, { phone: true })).status).toBe(403);
    expect(ROUTE_POLICY['POST /api/agent/accounts/codex/reorder']!.allow).toBe(ROUTE_POLICY['POST /api/agent/accounts/reorder']!.allow);
    expect(ROUTE_POLICY['POST /api/agent/accounts/codex/refresh']!.allow).toBe(ROUTE_POLICY['POST /api/agent/accounts/refresh']!.allow);
    expect(ROUTE_POLICY['GET /api/agent/accounts/codex']!.allow).toBe(ROUTE_POLICY['GET /api/agent/accounts']!.allow);
  });

  it('the list is the phone\'s only with a device session (its twin\'s agentGuard)', async () => {
    expect((await call(handleCodexAccountsList, null, { phone: true })).status).toBe(403);
  });

  it('on the desktop the list draws each account with its 5-hour and weekly windows (and T3\'s raw windows for Stats)', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    recordCodexUsage(CODEX_PRIMARY_ID, [
      { id: 'primary', kind: 'session', label: 'Session', usedPercent: 33, resetsAt: soon },
      { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 51, resetsAt: soon },
    ], new Date().toISOString(), 'probe', HOME);
    const r = await call(handleCodexAccountsList, null);
    expect(r.status).toBe(200);
    expect(r.body.tool).toBe('codex');
    expect(r.body.nextSessionAccountId).toBe(CODEX_PRIMARY_ID);
    const [row] = r.body.accounts;
    expect(row).toMatchObject({ id: CODEX_PRIMARY_ID, tool: 'codex', isPrimary: true, preferred: true, state: 'ok' });
    expect(row.limits.map((l: { key: string; percent: number }) => [l.key, l.percent])).toEqual([['session', 33], ['weekly', 51]]);
    expect(row.windows).toHaveLength(2);
    // No credential, ever: identity fields and readings only.
    expect(JSON.stringify(r.body)).not.toMatch(/auth\.json|token|secret/i);
  });

  it('a hidden ~/.codex is offered back: the list says so, and adopt lists it again', async () => {
    expect((await call(handleCodexAccountsList, null)).body.primaryHidden).toBe(false);
    expect((await call(handleCodexAccountsRemove, { id: CODEX_PRIMARY_ID })).status).toBe(200);
    const hidden = await call(handleCodexAccountsList, null);
    expect(hidden.body.accounts).toEqual([]);
    expect(hidden.body.primaryHidden).toBe(true);
    expect((await call(handleCodexAccountsAdopt, {})).status).toBe(200);
    const back = await call(handleCodexAccountsList, null);
    expect(back.body.accounts.map((a: { id: string }) => a.id)).toEqual([CODEX_PRIMARY_ID]);
    expect(back.body.primaryHidden).toBe(false);
  });

  it('remove refuses an id that is not registered, so a stray slug never names a folder', async () => {
    const r = await call(handleCodexAccountsRemove, { id: 'acct-ffffff' });
    expect(r.status).toBe(422);
  });

  it('adding an account with no Node for the bridge says so instead of failing silently', async () => {
    const r = await call(handleCodexAccountsLogin, {});
    expect(r.status).toBe(409);
    expect(r.body.error ?? r.body.code ?? JSON.stringify(r.body)).toMatch(/node_missing|Node/);
  });
});

describe('Antigravity sign-in from Settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'dc-agy-route-'));
  const install = (): void => {
    const dir = join(home, '.dreamcontext', 't3', 'tools', 'antigravity-acp', `${process.platform}-${process.arch}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'active.json'), '{}');
  };
  beforeEach(() => {
    process.env.HOME = home;
    process.env.DREAMCONTEXT_DESKTOP = '1';
    process.env.PATH = process.env.PATH ?? '';
  });
  afterAll(() => { setInstanceSignInForTests(null); rmSync(home, { recursive: true, force: true }); });

  it('sends a first install to the picker, and never starts a sign-in', async () => {
    let started = 0;
    setInstanceSignInForTests(async () => { started += 1; return true; });
    const out = await call(instanceAccountsLogin('antigravity'), {});
    expect(out.status).toBe(409);
    expect(JSON.stringify(out.body)).toContain('Install Antigravity from the model picker');
    expect(started).toBe(0);
  });

  it('runs one sign-in at a time', async () => {
    install();
    let finish: (ok: boolean) => void = () => undefined;
    setInstanceSignInForTests(() => new Promise((r) => { finish = r; }));
    const first = call(instanceAccountsLogin('antigravity'), {});
    await new Promise((r) => setTimeout(r, 30));
    const second = await call(instanceAccountsLogin('antigravity'), {});
    expect(second.status).toBe(409);
    finish(true);
    expect((await first).status).toBe(200);
  });
});
