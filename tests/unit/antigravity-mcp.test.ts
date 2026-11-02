/**
 * The owner's tool servers on Antigravity. A fictional stdio server and a local HTTP one stand in;
 * what the real agent does with them is in the module header.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antigravityProfileDir } from '../../src/lib/antigravity-accounts.js';
import { checkAcpServers, forgetProbe, refusedServer, sessionServers } from '../../src/lib/antigravity-mcp.js';
import { cmdArg, leanSpawnPlan } from '../../src/lib/super/lean-exec.js';
import { acpLeanMcpServers, acpStoreServers, type AcpMcpServer } from '../../src/lib/t3-bridge/launch.js';
import { probeSession, type ProbeSession } from '../../src/lib/t3-bridge/mcp-probe.js';
import { readAntigravityMcp, setAntigravityMcpProbeForTests } from '../../src/server/routes/agent-mcp.js';

const stdio = (name: string): AcpMcpServer => ({ name, command: '/x', args: [], env: [] });

describe('the servers a chat is given', () => {
  it('names a store file and a server, never a value', () => {
    const out = acpStoreServers([{ name: 'a', via: 'lean-exec', file: '/s/mcp.json' }, { name: 'b', via: 'http-relay', file: '/s/mcp.json' }, { name: 'c', via: 'url', url: 'https://example.test/mcp' }], { node: '/n', cli: '/c' });
    expect(out[0]).toEqual({ name: 'a', command: '/n', args: ['/c', 'mcp', 'lean-exec', '/s/mcp.json', 'a'], env: [] });
    expect(out[1]).toMatchObject({ args: ['/c', 'mcp', 'http-relay', '/s/mcp.json', 'b'] });
    expect(out[2]).toEqual({ type: 'http', name: 'c', url: 'https://example.test/mcp', headers: [] });
  });

  it('a child gets its lean subset through the same child, and a key never rides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-agy-mcp-'));
    const file = join(dir, 'lean.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { fox: { command: 'fox-server', env: { API_KEY: 'FAKE-VALUE' } }, 'bad name': { command: 'x' }, web: { url: 'https://example.test' } } }));
    const out = acpLeanMcpServers(file, { node: '/n', cli: '/c' });
    expect(out).toEqual([{ name: 'fox', command: '/n', args: ['/c', 'mcp', 'lean-exec', file, 'fox'], env: [] }]);
    expect(JSON.stringify(out)).not.toContain('FAKE-VALUE');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('asking a server before a chat is given it', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-agy-mcp-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  // Node + a script, the shape every server the product checks has (acpStoreServers: node, the
  // CLI, `mcp lean-exec`); a shebang file would not start on Windows.
  const script = (body: string): string => {
    const p = join(dir, `s-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(p, body);
    return p;
  };

  it('tells a stdio server that answers from one that dies or hangs', async () => {
    const good = script(`process.stdin.on('data',(d)=>{const m=JSON.parse(String(d));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n')});`);
    const dead = script('process.exit(1);');
    const hung = script('setTimeout(()=>{},60000);');
    const r = await checkAcpServers([good, dead, hung].map((file, i) => ({ name: `s${i}`, command: process.execPath, args: [file], env: [] })), { env: process.env, limitMs: 1500 });
    expect([...r.values()]).toEqual(['connected', 'failed', 'failed']);
  }, 20_000);

  it('tells an HTTP server that wants a sign-in from one that answers or is gone', async () => {
    const srv = createServer((q, s) => {
      if (q.url === '/login') { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<html>Sign in</html>'); return; }
      s.writeHead(q.url === '/open' ? 200 : 401); s.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const url = (p: string): AcpMcpServer => ({ type: 'http', name: p, url: `http://127.0.0.1:${port}/${p}`, headers: [] });
    const r = await checkAcpServers([url('open'), url('closed'), url('login'), { type: 'http', name: 'gone', url: 'http://127.0.0.1:1/x', headers: [] }], { env: process.env, limitMs: 1500 });
    expect(Object.fromEntries(r)).toEqual({ open: 'connected', closed: 'needs-auth', login: 'failed', gone: 'failed' });
    srv.close();
  }, 20_000);
});

describe('the session\'s own report', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-agy-mcp-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('reads the folders it wrote, by name and count, and a probe leaves nothing behind', () => {
    const acp = join(antigravityProfileDir('primary', home), 'antigravity-acp');
    mkdirSync(join(acp, 'brain', 't1', 'mcp', 'fox'), { recursive: true });
    mkdirSync(join(acp, 'conversations'), { recursive: true });
    writeFileSync(join(acp, 'brain', 't1', 'mcp', 'fox', 'a.json'), '{}');
    writeFileSync(join(acp, 'brain', 't1', 'mcp', 'fox', 'instructions.md'), 'x');
    writeFileSync(join(acp, 'conversations', 't1.db'), '');
    writeFileSync(join(acp, 'conversations', 't2.db'), '');
    expect([...sessionServers('t1', 'primary', home)]).toEqual([['fox', 1]]);
    expect(sessionServers('../x', 'primary', home).size).toBe(0);
    forgetProbe('t1', 'primary', home);
    expect(sessionServers('t1', 'primary', home).size).toBe(0);
    expect(() => readFileSync(join(acp, 'conversations', 't2.db'))).not.toThrow();
  });

  it('reads the refusal the agent gives (real text from agent 1.4.1)', () => {
    expect(refusedServer(`The MCP server 'fox' failed to initialize: calling "initialize": sending "initialize": Unauthorized. Fix the MCP server, or remove it from your configuration and start a new session, to continue.`)).toEqual({ name: 'fox', unauthorized: true });
    expect(refusedServer(`The MCP server 'fox' failed to initialize: connection closed: EOF.`)).toEqual({ name: 'fox', unauthorized: false });
    expect(refusedServer('all fine')).toBeNull();
  });
});

describe('probeSession', () => {
  const fake = (turns: Array<{ thread: string; said?: string } | 'signed_out' | null>) => {
    const opened: string[][] = [];
    const session: ProbeSession = {
      open: async (servers) => {
        opened.push(servers.map((s) => s.name));
        const t = turns.shift()!;
        if (!t || t === 'signed_out') return t;
        return { thread: t.thread, said: () => t.said ?? '', done: () => false, close: async () => undefined };
      },
    };
    return { session, opened };
  };

  it('reports what the session connected, tool counts included, and forgets its thread', async () => {
    const { session } = fake([{ thread: 't1' }]);
    const forgot: string[] = [];
    const r = await probeSession([stdio('fox'), stdio('owl')], session, () => new Map([['fox', 2], ['owl', 1]]), (t) => forgot.push(t), 500);
    expect(r).toEqual({ state: 'ok', servers: [{ name: 'fox', status: 'connected', toolCount: 2 }, { name: 'owl', status: 'connected', toolCount: 1 }] });
    expect(forgot).toEqual(['t1']);
  });

  it('a server the session refuses comes out and the session is asked again', async () => {
    const { session, opened } = fake([{ thread: 't1', said: `The MCP server 'fox' failed to initialize: Unauthorized.` }, { thread: 't2' }]);
    const r = await probeSession([stdio('fox'), stdio('owl')], session, (t) => (t === 't2' ? new Map([['owl', 1]]) : new Map()), () => undefined, 500);
    expect(opened).toEqual([['fox', 'owl'], ['owl']]);
    expect(r.servers).toEqual([{ name: 'fox', status: 'needs-auth' }, { name: 'owl', status: 'connected', toolCount: 1 }]);
  });

  it('one that never shows is failed, never a fake green, and a signed-out account says so', async () => {
    const quiet = await probeSession([stdio('fox')], fake([{ thread: 't1' }]).session, () => new Map(), () => undefined, 100);
    expect(quiet.servers).toEqual([{ name: 'fox', status: 'failed' }]);
    expect((await probeSession([stdio('fox')], fake(['signed_out']).session, () => new Map(), () => undefined, 100)).state).toBe('signed_out');
    expect((await probeSession([stdio('fox')], fake([null]).session, () => new Map(), () => undefined, 100)).state).toBe('failed');
  });
});

describe('readAntigravityMcp', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-agy-mcp-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); setAntigravityMcpProbeForTests(null); });
  const install = (): void => {
    const dir = join(home, '.dreamcontext', 't3', 'tools', 'antigravity-acp', `${process.platform}-${process.arch}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'active.json'), '{}');
  };
  const signIn = (): void => {
    const acp = join(antigravityProfileDir('primary', home), 'antigravity-acp');
    mkdirSync(acp, { recursive: true });
    writeFileSync(join(acp, 'acp_token.json'), '{}');
  };

  it('never a dash because nobody asked: each state says what it is', async () => {
    expect((await readAntigravityMcp(home, home)).state).toBe('not_installed');
    install();
    expect((await readAntigravityMcp(home, home)).state).toBe('signed_out');
    signIn();
    setAntigravityMcpProbeForTests(async () => null);
    expect((await readAntigravityMcp(home, home)).state).toBe('failed');
    setAntigravityMcpProbeForTests(async () => ({ state: 'ok', servers: [{ name: 'fox', status: 'connected', toolCount: 3 }] }));
    expect(await readAntigravityMcp(home, home)).toEqual({ state: 'ok', servers: [{ name: 'fox', status: 'connected', toolCount: 3 }], left: [] });
  });
});

describe('an owner\'s stdio server on Windows (mcp lean-exec)', () => {
  const NPX = 'C:\\Program Files\\nodejs\\npx.cmd';
  const onPath = (hit: string) => (p: string): boolean => p === hit;
  const win = { platform: 'win32' as const, path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs', comspec: 'C:\\Windows\\System32\\cmd.exe' };

  it('is spawned as written off Windows', () => {
    expect(leanSpawnPlan({ command: 'npx', args: ['-y', 'fox-mcp'] }, { platform: 'darwin' })).toEqual({ command: 'npx', args: ['-y', 'fox-mcp'], verbatim: false });
  });

  it('a bare npx is found as npx.cmd and runs through cmd.exe, every part escaped', () => {
    const plan = leanSpawnPlan({ command: 'npx', args: ['-y', 'fox-mcp'] }, { ...win, isFile: onPath(NPX) });
    expect(plan.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(plan.verbatim).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.args[3]).toBe('"C:\\Program^ Files\\nodejs\\npx.cmd ^^^"-y^^^" ^^^"fox-mcp^^^""');
  });

  it('no argument reaches cmd as syntax: &, |, %VAR% and a quote stay escaped', () => {
    const a = cmdArg('x" & calc | %PATH% ^');
    for (const ch of ['&', '|', '%', '"']) {
      const bare = [...a.matchAll(new RegExp(`(\\^*)\\${ch}`, 'g'))].filter((m) => m[1]!.length % 2 === 0);
      expect(bare, ch).toEqual([]);
    }
  });

  it('an .exe runs directly, a full path is not looked up, and an unknown command fails as written', () => {
    expect(leanSpawnPlan({ command: 'uvx', args: ['a'] }, { ...win, isFile: onPath('C:\\Windows\\System32\\uvx.exe') })).toEqual({ command: 'C:\\Windows\\System32\\uvx.exe', args: ['a'], verbatim: false });
    expect(leanSpawnPlan({ command: 'D:\\srv\\run.bat', args: [] }, { ...win, isFile: () => false })).toMatchObject({ command: win.comspec, verbatim: true });
    expect(leanSpawnPlan({ command: 'nope', args: [] }, { ...win, isFile: () => false })).toEqual({ command: 'nope', args: [], verbatim: false });
  });
});
