/**
 * Settings → MCP routes (task mcp-management W2): owner window only (a DNS-rebinding page is
 * 403), the overview never carries a value, bad names are refused, a blank field keeps the
 * stored value, a new server lands in the home-side stores and never in the project folder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleMcpCheck, handleMcpConnect, handleMcpImport, handleMcpOverview, handleMcpServerMove, handleMcpServerRemove,
  handleMcpServerSave,
} from '../../src/server/routes/agent-mcp.js';
import { handleAgentMcpProjectAdopt, handleAgentMcpProjectGet } from '../../src/server/routes/agent-mcp-project.js';
import { computerStorePath, projectStorePath, readStore } from '../../src/lib/mcp-store.js';
import { writeStatusCache } from '../../src/lib/mcp-live.js';

type Req = import('node:http').IncomingMessage;
type Res = import('node:http').ServerResponse;
type Handler = (q: Req, r: Res, p: Record<string, string>, root: string | null) => Promise<void>;

const SECRETS = ['hdr-SECRET-77aa21', 'env-SECRET-19bc02', 'qry-SECRET-55dd03', 'arg-SECRET-0042ee99'];

let home: string;
let project: string;
let contextRoot: string;
const saved = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-mcp-routes-home-'));
  project = mkdtempSync(join(tmpdir(), 'dc-mcp-routes-proj-'));
  contextRoot = join(project, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  process.env.HOME = home;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      posthog: { type: 'http', url: `https://mcp.example.test/mcp?key=${SECRETS[2]}`, headers: { Authorization: `Bearer ${SECRETS[0]}` } },
      mailer: { type: 'stdio', command: '/usr/bin/mail-mcp', args: [`--token=${SECRETS[3]}`], env: { MAIL_TOKEN: SECRETS[1] } },
    },
  }));
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  if (saved.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved.DESKTOP;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

async function call(h: Handler, o: { headers?: Record<string, string>; body?: unknown; method?: string; params?: Record<string, string> } = {}) {
  const q = new PassThrough() as unknown as Req & PassThrough;
  Object.assign(q, { headers: { host: '127.0.0.1:4173', ...(o.headers ?? {}) }, socket: { remoteAddress: '127.0.0.1' }, method: o.method ?? 'POST', url: '/' });
  setImmediate(() => (q as unknown as PassThrough).end(o.body === undefined ? '' : JSON.stringify(o.body)));
  const out = { status: 0, raw: '', json: {} as Record<string, unknown> };
  const r = {
    writeHead: (s: number) => { out.status = s; },
    end: (b?: string) => { out.raw = b ?? ''; out.json = b ? JSON.parse(b) : {}; },
    setHeader: () => {},
  } as unknown as Res;
  await h(q, r, o.params ?? {}, contextRoot);
  return out;
}

const REBIND = { host: 'evil.test:4173', origin: 'http://evil.test:4173' };

describe('owner window only', () => {
  it('a DNS-rebinding request (evil Host, matching Origin) gets 403 on every route', async () => {
    const routes: Array<[Handler, unknown]> = [
      [handleMcpOverview, undefined],
      [handleMcpCheck, {}],
      [handleMcpConnect, { account: '', name: 'posthog' }],
      [handleMcpServerSave, { scope: 'computer', name: 'evil', definition: { type: 'stdio', command: 'rm' } }],
      [handleMcpServerRemove, { scope: 'computer', name: 'posthog' }],
      [handleMcpServerMove, { name: 'posthog', from: 'computer', to: 'project' }],
      [handleMcpImport, { name: 'posthog', source: 'user' }],
      [handleAgentMcpProjectGet, undefined],
      [handleAgentMcpProjectAdopt, { name: 'posthog' }],
    ];
    for (const [h, body] of routes) {
      const r = await call(h, { headers: REBIND, body, method: body === undefined ? 'GET' : 'POST' });
      expect(r.status, h.name).toBe(403);
    }
    expect(existsSync(computerStorePath(home))).toBe(false);
  });

  it('another loopback origin (a dev server in a web card) is refused too', async () => {
    const r = await call(handleMcpOverview, { method: 'GET', headers: { origin: 'http://127.0.0.1:5173' } });
    expect(r.status).toBe(403);
  });

  it('outside the desktop app: 403', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    expect((await call(handleMcpOverview, { method: 'GET' })).status).toBe(403);
  });
});

describe('the overview never carries a value', () => {
  it('names, hosts, key names and statuses only', async () => {
    const r = await call(handleMcpOverview, { method: 'GET' });
    expect(r.status).toBe(200);
    for (const s of SECRETS) expect(r.raw).not.toContain(s);
    expect(r.raw).not.toContain('Bearer');
    const servers = r.json.servers as Array<Record<string, unknown>>;
    expect(servers.map((s) => s.name).sort()).toEqual(['mailer', 'posthog']);
    const ph = servers.find((s) => s.name === 'posthog')!;
    expect(ph).toMatchObject({ home: 'computer', transport: 'http', target: 'https://mcp.example.test/mcp', headerKeys: ['Authorization'], imported: true });
    expect(servers.find((s) => s.name === 'mailer')).toMatchObject({ target: 'mail-mcp · 1 arg', envKeys: ['MAIL_TOKEN'] });
    // One column for a machine with no registered account; cells not checked yet.
    expect(r.json.accounts).toEqual([{ id: 'default', label: 'this Mac', email: '' }]);
    expect((r.json.cells as Record<string, Record<string, { status: string }>>)[ph.key as string].default.status).toBe('unchecked');
  });

  it('a probed cell shows its status and time; a claude.ai connector row appears from the cache', async () => {
    await call(handleMcpOverview, { method: 'GET' });
    const store = readStore(computerStorePath(home))!;
    writeStatusCache('default', [
      { name: 'posthog', status: 'needs-auth', home: 'computer', transport: 'http' },
      { name: 'claude.ai Gmail', status: 'connected', home: 'claudeai', transport: 'http' },
    ], { computer: new Map(Object.entries(store.mcpServers)), project: new Map() }, home, 1234);
    const r = await call(handleMcpOverview, { method: 'GET' });
    const cells = r.json.cells as Record<string, Record<string, { status: string; at?: number }>>;
    const ph = (r.json.servers as Array<{ name: string; key: string }>).find((s) => s.name === 'posthog')!;
    expect(cells[ph.key].default).toEqual({ status: 'needs-auth', at: 1234 });
    expect(cells['claude.ai Gmail|claudeai'].default.status).toBe('connected');
    expect((r.json.accounts as Array<{ checkedAt?: number }>)[0].checkedAt).toBe(1234);
  });
});

describe('store edits', () => {
  it('bad names are 422', async () => {
    for (const name of ['__proto__', 'Bad Name', '-x', '', 'x'.repeat(41)]) {
      const r = await call(handleMcpServerSave, { body: { scope: 'computer', name, definition: { type: 'http', url: 'https://a.test/mcp' } } });
      expect(r.status, name).toBe(422);
    }
    expect((await call(handleMcpServerSave, { body: { scope: 'computer', name: 'ok', definition: { type: 'ftp', url: 'x' } } })).status).toBe(422);
    expect((await call(handleMcpServerSave, { body: { scope: 'computer', name: 'ok', definition: { type: 'http', url: 'javascript:alert(1)' } } })).status).toBe(422);
    expect((await call(handleMcpConnect, { body: { account: '', name: '--help' } })).status).toBe(422);
  });

  it('a new server with the default scope writes the computer store 0600; "this project" the home-side store; nothing in the project folder', async () => {
    const a = await call(handleMcpServerSave, { body: { scope: 'computer', name: 'stitch', definition: { type: 'http', url: 'https://stitch.test/mcp', headers: { 'X-Key': 'k-1' } } } });
    expect(a.status).toBe(200);
    expect(statSync(computerStorePath(home)).mode & 0o777).toBe(0o600);
    expect(readStore(computerStorePath(home))!.mcpServers.stitch).toEqual({ type: 'http', url: 'https://stitch.test/mcp', headers: { 'X-Key': 'k-1' } });
    expect(a.raw).not.toContain('k-1');
    const b = await call(handleMcpServerSave, { body: { scope: 'project', name: 'supabase', definition: { type: 'http', url: 'https://db.test/mcp' } } });
    expect(b.status).toBe(200);
    expect(readStore(projectStorePath(project, home))!.mcpServers.supabase).toBeTruthy();
    expect(existsSync(join(project, '.mcp.json'))).toBe(false);
    expect(readFileSync(join(home, '.claude.json'), 'utf-8')).not.toContain('stitch');
  });

  it('a blank field listed in `keep` keeps the stored header; the url can be kept too', async () => {
    await call(handleMcpOverview, { method: 'GET' });
    const r = await call(handleMcpServerSave, { body: {
      scope: 'computer', name: 'posthog', keep: ['url', 'headers.Authorization'],
      definition: { type: 'http', headers: { Authorization: '', 'X-New': 'n-2' } },
    } });
    expect(r.status).toBe(200);
    const def = readStore(computerStorePath(home))!.mcpServers.posthog;
    expect(def.headers).toEqual({ Authorization: `Bearer ${SECRETS[0]}`, 'X-New': 'n-2' });
    expect(String(def.url)).toContain(SECRETS[2]);
    expect(readStore(computerStorePath(home))!.ledger.posthog.editedInApp).toBe(true);
    for (const s of SECRETS) expect(r.raw).not.toContain(s);
  });

  it('move carries the secrets server-side; remove is remembered', async () => {
    await call(handleMcpOverview, { method: 'GET' });
    expect((await call(handleMcpServerMove, { body: { name: 'mailer', from: 'computer', to: 'project' } })).status).toBe(200);
    expect((readStore(projectStorePath(project, home))!.mcpServers.mailer.env as Record<string, string>).MAIL_TOKEN).toBe(SECRETS[1]);
    expect(Object.hasOwn(readStore(computerStorePath(home))!.mcpServers, 'mailer')).toBe(false);
    expect((await call(handleMcpServerRemove, { body: { scope: 'computer', name: 'posthog' } })).status).toBe(200);
    const r = await call(handleMcpOverview, { method: 'GET' });
    expect(r.json.outside).toContainEqual({ name: 'posthog', source: 'user', reason: 'removed-in-app' });
    expect((await call(handleMcpImport, { body: { name: 'posthog', source: 'user' } })).status).toBe(200);
    expect(Object.hasOwn(readStore(computerStorePath(home))!.mcpServers, 'posthog')).toBe(true);
  });

  it('sharing with the team refuses a literal secret in a URL query or a stdio argument', async () => {
    await call(handleMcpOverview, { method: 'GET' });
    const q = await call(handleAgentMcpProjectAdopt, { body: { name: 'posthog' } });
    expect(q.status).toBe(409);
    expect(q.raw).not.toContain(SECRETS[2]);
    const a = await call(handleAgentMcpProjectAdopt, { body: { name: 'mailer' } });
    expect(a.status).toBe(409);
    expect(a.raw).not.toContain(SECRETS[3]);
    expect(existsSync(join(project, '.mcp.json'))).toBe(false);
  });
});
