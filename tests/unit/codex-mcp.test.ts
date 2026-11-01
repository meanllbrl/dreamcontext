import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexLiveRow, codexStorePlan, planArgv, planLaunchArgs, probeCodexMcp, startCodexConnect } from '../../src/lib/codex-mcp.js';
import { computerStorePath, projectStorePath } from '../../src/lib/mcp-store.js';
import { connectStatus, resetMcpLiveForTests } from '../../src/lib/mcp-live.js';
import { bridgeChatScript } from '../../src/lib/t3-bridge/spawn.js';
import { relayTarget, runRelay, takeSseEvents } from '../../src/lib/codex-http-relay.js';

const SECRET = 'fixture-value-not-a-real-secret-123456';
let home: string;
const root = '/tmp/kettle-works';

function store(path: string, mcpServers: Record<string, unknown>): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, mcpServers, ledger: {} }), { mode: 0o600 });
  chmodSync(path, 0o600);
}
const plan = (listed: string[] | null = []) => codexStorePlan({ home, projectRoot: root, node: '/n/node', cli: '/c/cli.js', listed, sync: false });

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'codex-mcp-')); resetMcpLiveForTests(); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('codexStorePlan', () => {
  it('starts a stdio server through lean-exec on the store file, so no value is an argument', () => {
    store(computerStorePath(home), { kettle: { command: 'kettle-mcp', args: [`--token=${SECRET}`], env: { KETTLE_KEY: SECRET } } });
    const p = plan();
    expect(p.reached).toEqual([{ name: 'kettle', transport: 'stdio' }]);
    expect(planLaunchArgs(p)).toContain('lean-exec');
    expect(planLaunchArgs(p)).toContain(computerStorePath(home));
    expect(planLaunchArgs(p)).not.toContain(SECRET);
  });

  it('a server holding a key starts through the relay: the key is in no argument and no env', () => {
    store(computerStorePath(home), {
      teapot: { type: 'http', url: 'https://mcp.teapot.example/mcp', headers: { 'X-Teapot-Key': SECRET } },
      saucer: { type: 'http', url: `https://mcp.saucer.example/mcp?key=${SECRET}` },
    });
    const p = plan();
    expect(p.reached.map((r) => [r.name, r.transport])).toEqual([['saucer', 'http'], ['teapot', 'http']]);
    expect(planArgv(p).join(' ')).not.toContain(SECRET);
    expect(planArgv(p).join(' ')).toContain('http-relay');
    expect(planArgv(p).join(' ')).not.toContain('.url=');
    expect(p).not.toHaveProperty('env');
  });

  it('a plain address goes over as a URL, which is what lets Codex run its own sign-in', () => {
    store(computerStorePath(home), { samovar: { type: 'http', url: 'https://mcp.samovar.example/mcp' } });
    expect(planArgv(plan()).join(' ')).toContain('mcp_servers.samovar.url="https://mcp.samovar.example/mcp"');
  });

  it('leaves out what cannot reach Codex safely, and says why', () => {
    store(computerStorePath(home), {
      'dotted.name': { command: 'x' },
      sseish: { type: 'sse', url: 'https://sse.example/mcp' },
      varish: { type: 'http', url: 'https://v.example/mcp', headers: { Authorization: 'Bearer ${TEAPOT}' } },
    });
    const p = plan();
    expect(p.reached).toEqual([]);
    expect(Object.fromEntries(p.left.map((l) => [l.name, l.why]))).toEqual({ 'dotted.name': 'name', sseish: 'transport', varish: 'variable' });
    expect(planArgv(p)).toEqual([]);
  });

  it("lets Codex's own entry win, skips the brain's name, and the project store wins a clash", () => {
    store(computerStorePath(home), { own: { command: 'a' }, dreamcontext: { command: 'b' }, both: { command: 'computer' } });
    store(projectStorePath(root, home), { both: { command: 'project' } });
    const p = plan(['own']);
    expect(p.reached.map((r) => r.name)).toEqual(['both']);
    expect(planLaunchArgs(p)).toContain(projectStorePath(root, home));
  });

  it('adds nothing when Codex did not list its servers: a clash could stop it starting', () => {
    store(computerStorePath(home), { kettle: { command: 'a' } });
    expect(plan(null).reached).toEqual([]);
  });

  it('never reads a store file that is not 0600', () => {
    store(computerStorePath(home), { kettle: { command: 'a' } });
    chmodSync(computerStorePath(home), 0o644);
    expect(plan().reached).toEqual([]);
  });
});

describe('codexLiveRow', () => {
  it.each([
    [{ name: 'a', authStatus: 'unsupported', tools: { x: {}, y: {} } }, 'connected', 2],
    [{ name: 'a', authStatus: 'notLoggedIn', tools: {} }, 'needs-auth', 0],
    // A server reached with an API key header: no OAuth token, and every tool.
    [{ name: 'a', authStatus: 'notLoggedIn', tools: { x: {} } }, 'connected', 1],
    [{ name: 'a', authStatus: 'unsupported', tools: {} }, 'failed', 0],
    [{ name: 'a', authStatus: 'oAuth', tools: {}, runtimeStatus: 'authenticationRequired' }, 'needs-auth', 0],
  ])('%j', (raw, status, toolCount) => {
    expect(codexLiveRow(raw)).toMatchObject({ status, toolCount });
  });

  it('keeps a whitelist: nothing from the row but a name, a status and a count', () => {
    const row = codexLiveRow({ name: 'a', authStatus: 'oAuth', httpOrigin: 'https://x', serverInfo: { secret: SECRET }, tools: { t: { description: SECRET } } });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(Object.keys(row!).sort()).toEqual(['authStatus', 'name', 'status', 'toolCount']);
  });

  it('is null on a shape it does not know', () => {
    expect(codexLiveRow({ tools: {} })).toBeNull();
    expect(codexLiveRow('x')).toBeNull();
  });
});

/** A `codex app-server` on two streams: answers by method. */
function fakeServer(answer: (method: string, params: Record<string, unknown>, emit: (o: unknown) => void) => unknown) {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; pid: number; kill: () => void };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.pid = 0;
  child.kill = () => { child.emit('exit', 0); };
  const seen: string[] = [];
  child.stdin.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      const m = JSON.parse(line) as { id?: number; method: string; params: Record<string, unknown> };
      seen.push(m.method);
      const emit = (o: unknown): void => { child.stdout.write(`${JSON.stringify(o)}\n`); };
      const result = answer(m.method, m.params, emit);
      if (m.id !== undefined && result !== undefined) emit({ id: m.id, result });
    }
  });
  return { spawnImpl: (() => child) as never, seen, argv: [] as string[] };
}
const opts = (f: ReturnType<typeof fakeServer>) => ({ bin: 'codex', argv: [], env: {}, cwd: '/tmp', spawnImpl: f.spawnImpl });

describe('probeCodexMcp', () => {
  it('reads every page', async () => {
    const f = fakeServer((method, params) => {
      if (method === 'initialize') return {};
      if (params.cursor) return { data: [{ name: 'b', authStatus: 'notLoggedIn', tools: {} }] };
      return { data: [{ name: 'a', authStatus: 'unsupported', tools: { x: {} } }], nextCursor: 'more' };
    });
    expect((await probeCodexMcp(opts(f)))?.map((s) => [s.name, s.status])).toEqual([['a', 'connected'], ['b', 'needs-auth']]);
  });

  it('is null when Codex never answers, so nothing is reported as a fact', async () => {
    const f = fakeServer(() => undefined);
    expect(await probeCodexMcp({ ...opts(f), deadlineMs: 20 })).toBeNull();
  });
});

describe('startCodexConnect', () => {
  const settle = async (id: string, state: string) => {
    for (let i = 0; i < 50 && connectStatus(id)?.state !== state; i += 1) await new Promise((r) => setTimeout(r, 5));
    return connectStatus(id);
  };

  it('hands back the https URL, then follows Codex to connected', async () => {
    let finish: () => void = () => {};
    const f = fakeServer((method, _p, emit) => {
      if (method === 'initialize') return {};
      if (method === 'mcpServer/oauth/login') {
        finish = () => emit({ method: 'mcpServer/oauthLogin/completed', params: { name: 'teapot', success: true } });
        return { authorizationUrl: 'https://auth.teapot.example/start', loginId: 'l1' };
      }
      return undefined;
    });
    const t = startCodexConnect({ ...opts(f), name: 'teapot' });
    if (!t || t === 'busy') throw new Error('no ticket');
    expect(t.accountId).toBe('codex');
    expect((await settle(t.id, 'waiting'))?.host).toBe('auth.teapot.example');
    finish();
    expect((await settle(t.id, 'connected'))?.state).toBe('connected');
  });

  it('refuses a URL that is not https, and a failed sign-in says so', async () => {
    let finish: () => void = () => {};
    const f = fakeServer((method, _p, emit) => {
      if (method === 'initialize') return {};
      finish = () => emit({ method: 'mcpServer/oauthLogin/completed', params: { name: 'teapot', success: false } });
      return { authorizationUrl: 'javascript:alert(1)' };
    });
    const t = startCodexConnect({ ...opts(f), name: 'teapot' });
    if (!t || t === 'busy') throw new Error('no ticket');
    expect((await settle(t.id, 'waiting'))?.url).toBeUndefined();
    finish();
    expect((await settle(t.id, 'failed'))?.state).toBe('failed');
  });

  it('runs one sign-in at a time', async () => {
    const f = fakeServer((method) => (method === 'initialize' ? {} : { authorizationUrl: 'https://a.example' }));
    const first = startCodexConnect({ ...opts(f), name: 'teapot' });
    expect(first).not.toBe('busy');
    expect(startCodexConnect({ ...opts(fakeServer(() => ({}))), name: 'other' })).toBe('busy');
  });
});

describe('bridgeChatScript', () => {
  const base = { tool: 'codex' as const, model: 'gpt-test', effort: '', mode: 'default', pane: 'p1', resume: '', briefingArg: [] as string[], node: '/n/node', cli: '/c/cli.js' };
  it('a normal chat carries the stores; a strict one never does', () => {
    expect(bridgeChatScript({ ...base, storeMcp: true })).toContain('--store-mcp');
    expect(bridgeChatScript(base)).not.toContain('--store-mcp');
    expect(bridgeChatScript({ ...base, storeMcp: true, strictMcp: true })).not.toContain('--store-mcp');
  });
});

describe('the HTTP relay', () => {
  const target = { url: 'https://mcp.teapot.example/mcp', headers: { 'X-Teapot-Key': SECRET } };
  const run = async (lines: string[], fetchImpl: typeof fetch) => {
    const input = new PassThrough();
    const out: string[] = [];
    const done = runRelay(target, { input, write: (l) => out.push(l), fetchImpl });
    for (const l of lines) input.write(`${l}\n`);
    input.end();
    await done;
    return out;
  };

  it('adds the headers, keeps the session, and passes JSON and SSE replies on as lines', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_u: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push(init.headers);
      const id = (JSON.parse(init.body) as { id?: number }).id;
      if (id === 1) return new Response(JSON.stringify({ id: 1, result: {} }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' } });
      if (id === undefined) return new Response(null, { status: 202 });
      return new Response(`event: message\ndata: {"id":${id},"result":{}}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const out = await run(['{"id":1,"method":"initialize"}', '{"method":"notifications/initialized"}', '{"id":2,"method":"tools/list"}'], fetchImpl);
    expect(out).toEqual(['{"id":1,"result":{}}\n', '{"id":2,"result":{}}\n']);
    expect(seen[0]['X-Teapot-Key']).toBe(SECRET);
    expect(seen[2]['mcp-session-id']).toBe('s1');
  });

  it('a refused request answers with the status alone, never the body or the key', async () => {
    const fetchImpl = (async () => new Response(`bad key ${SECRET}`, { status: 403 })) as unknown as typeof fetch;
    const out = await run(['{"id":7,"method":"tools/list"}'], fetchImpl);
    expect(out.join('')).toContain('403');
    expect(out.join('')).not.toContain(SECRET);
  });

  it('reads only a regular store file holding that server', () => {
    const path = computerStorePath(home);
    store(path, { teapot: { url: 'https://x.example', headers: { A: 'b' } } });
    expect(relayTarget(path, 'teapot')).toEqual({ url: 'https://x.example', headers: { A: 'b' } });
    expect(relayTarget(path, 'nope')).toBeNull();
    expect(relayTarget(`${path}.none`, 'teapot')).toBeNull();
  });

  it('reads SSE events with several data lines and keeps a partial one', () => {
    expect(takeSseEvents('data: {"a":\ndata: 1}\n\nevent: ping\n\ndata: {"b"')).toEqual({ messages: ['{"a": 1}'], rest: 'data: {"b"' });
  });

  const sse = (chunks: Array<string | Promise<string>>) => new Response(new ReadableStream({
    async start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(await x)); c.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } });

  it('passes a question on mid-call, before the stream ends, and stops at the reply', async () => {
    let answer: (v: string) => void = () => {};
    const later = new Promise<string>((r) => { answer = r; });
    const input = new PassThrough();
    const out: string[] = [];
    const done = runRelay(target, { input, write: (l) => { out.push(l); if (l.includes('elicitation')) answer('data: {"id":3,"result":{"ok":1}}\n\n'); }, fetchImpl: (async () => sse(['data: {"id":90,"method":"elicitation/create"}\n\n', later])) as unknown as typeof fetch });
    input.write('{"id":3,"method":"tools/call"}\n');
    input.end();
    await done;
    expect(out.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([90, 3]);
  });

  it('answers a request the server left without one', async () => {
    const noBody = (async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    expect((await run(['{"id":4,"method":"tools/list"}'], noBody)).join('')).toContain('no answer');
    const ended = (async () => sse(['event: ping\n\n'])) as unknown as typeof fetch;
    expect((await run(['{"id":5,"method":"tools/list"}'], ended)).join('')).toContain('no answer');
  });

  it('never writes a body that is not JSON-RPC', async () => {
    const page = (async () => new Response(`<html>gateway ${SECRET}</html>`, { status: 200 })) as unknown as typeof fetch;
    const out = (await run(['{"id":6,"method":"tools/list"}'], page)).join('');
    expect(out).not.toContain(SECRET);
    expect(out).toContain('no answer');
  });

  it('never writes a JSON body that is not a JSON-RPC message for this exchange', async () => {
    for (const body of ['{"error":"bad gateway"}', '{"result":"ok"}', '[{"id":6,"result":{}}]']) {
      const f = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
      const out = await run(['{"id":6,"method":"tools/list"}'], f);
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('no answer');
    }
  });

  it('a server that sits on a notification does not stop the requests after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const f = (async (_u: string, init: { body: string }) => {
        const m = JSON.parse(init.body) as { id?: number };
        if (m.id === undefined) return new Promise(() => {});
        return new Response(JSON.stringify({ id: m.id, result: {} }), { headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch;
      const pending = run(['{"method":"notifications/cancelled"}', '{"id":9,"method":"tools/list"}'], f);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await pending).toEqual(['{"id":9,"result":{}}\n']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait for the body of a notification', async () => {
    let cancelled = false;
    const f = (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    await run(['{"method":"notifications/progress"}'], f);
    expect(cancelled).toBe(true);
  });

  it('refuses a redirect, so the key cannot follow one', async () => {
    let redirect: unknown;
    const f = (async (_u: string, init: { redirect?: unknown }) => { redirect = init.redirect; throw new TypeError('redirect'); }) as unknown as typeof fetch;
    expect((await run(['{"id":8,"method":"tools/list"}'], f)).join('')).toContain('could not be reached');
    expect(redirect).toBe('error');
  });

  it('a notification goes out before what follows it, and a reply of Codex expects nothing back', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const f = (async (_u: string, init: { body: string }) => {
      const m = JSON.parse(init.body) as { method?: string };
      order.push(`start ${m.method ?? 'reply'}`);
      if (m.method === 'notifications/initialized') { setTimeout(release, 10); await gate; order.push('end initialized'); }
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const out = await run(['{"method":"notifications/initialized"}', '{"id":90,"result":{"ok":1}}'], f);
    expect(order).toEqual(['start notifications/initialized', 'end initialized', 'start reply']);
    expect(out).toEqual([]);
  });
});
