/**
 * The live MCP control channel (task mcp-management W1, criteria 5 + 6): a status reply is
 * consumed before anything relays it, whatever its key order or id, and what leaves the server
 * carries no substring of any secret the definition holds.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  McpControl, connectStatus, displayTarget, errorKindOf, isMcpControlLine, isSafeAuthUrl, liveChildArgs, readStatusCache,
  redactStatus, resetMcpLiveForTests, routeChildLine, startConnect, startLiveChild, writeStatusCache,
} from '../../src/lib/mcp-live.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRETS = {
  header: 'hdr-SECRET-7f3a9c',
  env: 'env-SECRET-41b2d8',
  query: 'qry-SECRET-90e1aa',
  arg: '--token=arg-SECRET-55cc01',
  path: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
};

const DEFS = {
  posthog: { type: 'http', url: `https://mcp.example.test/v1/${SECRETS.path}/mcp?key=${SECRETS.query}&x=1`, headers: { Authorization: `Bearer ${SECRETS.header}` } },
  mailer: { type: 'stdio', command: '/usr/local/bin/mail-mcp', args: [SECRETS.arg, '-v'], env: { MAIL_TOKEN: SECRETS.env } },
};

/** A status reply as the CLI writes it: `config` carries every secret, `error` echoes some. */
function statusReply(id: string, keysReversed = false): string {
  const servers = [
    { name: 'posthog', status: 'needs-auth', config: DEFS.posthog, transport: 'http', scope: 'dynamic', source: 'dynamic', tools: [], serverInfo: { name: 'ph' } },
    { name: 'mailer', status: 'failed', error: `spawn failed: ${SECRETS.arg} ${SECRETS.env} ENOENT`, config: DEFS.mailer, transport: 'stdio', scope: 'dynamic', source: 'dynamic' },
    { name: 'claude.ai Gmail', status: 'connected', scope: 'claudeai', source: 'claudeai', transport: 'http', tools: [{}, {}] },
  ];
  const inner = { subtype: 'success', request_id: id, response: { mcpServers: servers } };
  const response = keysReversed ? { response: inner.response, request_id: id, subtype: 'success' } : inner;
  return keysReversed
    ? JSON.stringify({ response, type: 'control_response' })
    : JSON.stringify({ type: 'control_response', response });
}

const ctx = { computer: new Map(Object.entries(DEFS)), project: new Map() };

describe('interception — the head of the chat stdout loop', () => {
  function relay(lines: string[]) {
    const send = vi.fn();
    const mirror = vi.fn();
    const control = vi.fn();
    const rest: unknown[] = [];
    for (const l of lines) {
      const obj = routeChildLine(l, { send, mirror, control });
      // Everything the loop does after the head (registry, browserMirror, superSignals, the
      // interrupt watchdog) runs only on a returned frame.
      if (obj) rest.push(obj);
    }
    return { send, mirror, control, rest };
  }

  it('our reply (nested id, keys in a non-canonical order) and a foreign-id status reply never relay', () => {
    const ours = statusReply('dcmcp-1234', true);
    const foreign = statusReply('someone-else-9');
    const r = relay([ours, foreign]);
    expect(r.send).not.toHaveBeenCalled();
    expect(r.mirror).not.toHaveBeenCalled();
    expect(r.rest).toEqual([]);
    expect(r.control).toHaveBeenCalledTimes(2);
  });

  it('other control_responses, ordinary frames and non-JSON lines still relay', () => {
    const interruptAck = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'int-1', response: {} } });
    const frame = JSON.stringify({ type: 'assistant', message: {} });
    const r = relay([interruptAck, frame, 'not json', '   ']);
    expect(r.send.mock.calls.map((c) => c[0])).toEqual([interruptAck, frame, 'not json']);
    expect(r.mirror).toHaveBeenCalledTimes(3);
    expect(r.rest).toHaveLength(2);
    expect(r.control).not.toHaveBeenCalled();
  });

  it('the predicate: an id we wrote, or any payload carrying mcpServers', () => {
    expect(isMcpControlLine({ type: 'control_response', response: { request_id: 'dcmcp-x', response: {} } })).toBe(true);
    expect(isMcpControlLine({ type: 'control_response', response: { request_id: 'z', response: { mcpServers: [] } } })).toBe(true);
    expect(isMcpControlLine({ type: 'control_response', response: { request_id: 'z', response: {} } })).toBe(false);
    expect(isMcpControlLine({ type: 'control_request', request_id: 'dcmcp-x' })).toBe(false);
  });
});

describe('McpControl', () => {
  it('matches a reply by its NESTED request id and resolves the inner payload', async () => {
    const written: Array<Record<string, unknown>> = [];
    const c = new McpControl((f) => { written.push(f); return true; }, 1000);
    const p = c.status();
    const id = written[0].request_id as string;
    expect(id.startsWith('dcmcp-')).toBe(true);
    expect(written[0].request).toEqual({ subtype: 'mcp_status' });
    c.handle(JSON.parse(statusReply(id)));
    expect((await p).length).toBe(3);
  });

  it('times out, and rejects at once when the child is gone', async () => {
    const c = new McpControl(() => true, 20);
    await expect(c.status()).rejects.toThrow('timeout');
    const d = new McpControl(() => true, 10_000);
    const p = d.status();
    d.close();
    await expect(p).rejects.toThrow('closed');
    await expect(new McpControl(() => false).status()).rejects.toThrow('unwritable');
  });
});

describe('redaction — no secret substring leaves the server', () => {
  it('redactStatus whitelists fields and scrubs by value', () => {
    const rows = redactStatus(JSON.parse(statusReply('dcmcp-1')).response.response, ctx);
    const out = JSON.stringify(rows);
    for (const s of [...Object.values(SECRETS), 'arg-SECRET-55cc01', 'Bearer']) expect(out).not.toContain(s);
    expect(out).not.toContain('config');
    expect(out).not.toContain('serverInfo');
    expect(out).not.toContain('spawn failed');
    expect(rows).toEqual([
      { name: 'posthog', status: 'needs-auth', home: 'computer', transport: 'http', urlHost: 'https://mcp.example.test', toolCount: 0, errorKind: 'auth' },
      { name: 'mailer', status: 'failed', home: 'computer', transport: 'stdio', errorKind: 'spawn' },
      { name: 'claude.ai Gmail', status: 'connected', home: 'claudeai', transport: 'http', toolCount: 2 },
    ]);
  });

  it('a secret echoed into a name or transport is masked too', () => {
    const rows = redactStatus([{ name: `x-${SECRETS.header}`, status: 'connected', config: DEFS.posthog, transport: SECRETS.env, scope: 'dynamic' }], { computer: new Map([[`x-${SECRETS.header}`, DEFS.mailer]]), project: new Map() });
    expect(JSON.stringify(rows)).not.toContain(SECRETS.header);
    expect(JSON.stringify(rows)).not.toContain(SECRETS.env);
  });

  it('displayTarget: host + masked path, no query; a command basename + arg count', () => {
    expect(displayTarget(DEFS.posthog)).toBe('https://mcp.example.test/v1/••••/mcp');
    expect(displayTarget(DEFS.mailer)).toBe('mail-mcp · 2 args');
    const all = displayTarget(DEFS.posthog) + displayTarget(DEFS.mailer);
    for (const s of Object.values(SECRETS)) expect(all).not.toContain(s);
    expect(displayTarget({ url: 'https://user:pw-SECRET-1@h.test/a' })).toBe('https://h.test/a');
  });

  it('errorKind is an enum, never text', () => {
    expect(errorKindOf('failed', 'HTTP 401 Unauthorized')).toBe('auth');
    expect(errorKindOf('failed', 'Connection timed out')).toBe('timeout');
    expect(errorKindOf('failed', 'spawn ENOENT')).toBe('spawn');
    expect(errorKindOf('failed', 'invalid JSON')).toBe('protocol');
    expect(errorKindOf('failed', 'weird')).toBe('other');
    expect(errorKindOf('connected', 'x')).toBeUndefined();
  });

  it('isSafeAuthUrl: https only', () => {
    expect(isSafeAuthUrl('https://claude.ai/oauth?x=1')).toBe('claude.ai');
    expect(isSafeAuthUrl('http://localhost:1/cb')).toBeNull();
    expect(isSafeAuthUrl('javascript:alert(1)')).toBeNull();
    expect(isSafeAuthUrl(42)).toBeNull();
  });
});

describe('the Settings child', () => {
  it('carries exactly the stores, the probe env, and discards stderr', () => {
    expect(liveChildArgs(['/h/.dreamcontext/mcp.json', '/h/p.json'])).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', '/h/.dreamcontext/mcp.json', '/h/p.json',
    ]);
    const calls: Array<{ args: string[]; opts: { env?: Record<string, string>; stdio?: unknown } }> = [];
    const spawnImpl = vi.fn((_cmd: string, args: string[], opts: unknown) => {
      calls.push({ args, opts: opts as { env?: Record<string, string>; stdio?: unknown } });
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.pid = 1;
      child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), writable: true, destroyed: false });
      child.stdout = new EventEmitter();
      return child as never;
    });
    const live = startLiveChild({ files: ['/s.json'], cwd: '/p', env: { CLAUDE_CONFIG_DIR: '/sb' }, spawnImpl });
    expect(live).not.toBeNull();
    const { args, opts } = calls[0];
    expect(args.slice(args.indexOf('--mcp-config'))).toContain('/s.json');
    expect(opts.env?.DREAMCONTEXT_MCP_PROBE).toBe('1');
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBe('/sb');
    expect((opts.stdio as unknown[])[2]).toBe('ignore');
  });
});

describe('end-review fixes', () => {
  it('displayTarget never shows a command line written into `command`', () => {
    expect(displayTarget({ type: 'stdio', command: 'sh -c "API_KEY=sk-live-0123456789 npx x"' })).toBe('sh');
  });

  it('a chat reading MERGES into the account row; only a probe moves "checked at"', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-mcp-cache-'));
    try {
      const ctx = { computer: new Map(), project: new Map() };
      writeStatusCache('acc', [{ name: 'a', status: 'connected', home: 'claudeai', transport: 'http' }, { name: 'b', status: 'failed', home: 'claudeai', transport: 'http' }], ctx, home, 100, { full: true });
      writeStatusCache('acc', [{ name: 'a', status: 'needs-auth', home: 'claudeai', transport: 'http' }], ctx, home, 200);
      const row = readStatusCache(home).acc;
      expect(row.at).toBe(100);
      expect(row.cells['a|claudeai']).toMatchObject({ status: 'needs-auth', at: 200 });
      expect(row.cells['b|claudeai']).toMatchObject({ status: 'failed', at: 100 });
      // A chat reading on an account never probed creates its cells but no "checked at".
      writeStatusCache('fresh', [{ name: 'a', status: 'connected', home: 'claudeai', transport: 'http' }], ctx, home, 300);
      expect(readStatusCache(home).fresh.at).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a Settings sign-in whose child died ends as failed instead of holding every later one at busy', async () => {
    resetMcpLiveForTests();
    const children: Array<EventEmitter & Record<string, unknown>> = [];
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.pid = 99999999;
      child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), writable: true, destroyed: false });
      child.stdout = new EventEmitter();
      child.kill = vi.fn();
      children.push(child);
      return child as never;
    });
    const t = startConnect({ files: [], cwd: '/p', env: {}, spawnImpl, accountId: 'a', name: 'posthog', projectRoot: '/p', home: tmpdir(), everyMs: 5, windowMs: 60_000 });
    expect(t).not.toBe('busy');
    const id = (t as { id: string }).id;
    // The child answers nothing and dies.
    children[0].emit('exit', 1);
    for (let i = 0; i < 100 && connectStatus(id)?.state !== 'failed'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(connectStatus(id)?.state).toBe('failed');
    expect(startConnect({ files: [], cwd: '/p', env: {}, spawnImpl, accountId: 'a', name: 'x', projectRoot: '/p', home: tmpdir() })).not.toBe('busy');
    resetMcpLiveForTests();
  });
});
