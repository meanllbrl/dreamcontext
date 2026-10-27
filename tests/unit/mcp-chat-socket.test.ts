/**
 * The chat's MCP channel end to end through `startChatSession` (task mcp-management W2): the
 * spawn reads `mcp_status` from its own child, the socket gets the REDACTED frame and never the
 * CLI's reply, a pinned chat writes its health file, and the MCP verbs run only for a socket a
 * desktop window holds — a phone-held or non-loopback socket gets `mcp_desktop_only`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mcp-socket-home-'));
  process.env.HOME = dir;
  return dir;
});

const spawned: FakeChild[] = [];
class FakeChild extends EventEmitter {
  written: string[] = [];
  stdin = { write: vi.fn((s: string) => { this.written.push(s); return true; }), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4243;
  script = '';
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((_cmd: string, args: string[]) => {
      const child = new FakeChild();
      child.script = args[args.length - 1] ?? '';
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

vi.mock('../../src/server/routes/agent-spawn-shared.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/server/routes/agent-spawn-shared.js')>();
  return { ...real, claudeConversationExists: () => false };
});

const { startChatSession, markSocketLoopbackForTests, mcpSocketAllowed, tagDeviceSocket } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { setAutoSwitchEnabled } = await import('../../src/lib/claude-accounts.js');
const { mcpHealthDir } = await import('../../src/lib/mcp-health.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  frames(): Array<Record<string, unknown>> {
    return this.send.mock.calls.map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return {}; } });
  }
  metas(subtype: string) { return this.frames().filter((f) => f.type === '_meta' && f.subtype === subtype); }
}

const SECRET = 'hdr-SECRET-31f00d';
const PIN = '11111111-2222-4333-8444-555555555555';
let projectRoot: string;

function spawnChat(o: { desktop: boolean }): { ws: FakeWs; child: FakeChild } {
  const ws = new FakeWs();
  if (o.desktop) markSocketLoopbackForTests(ws, true);
  startChatSession(ws as unknown as import('ws').WebSocket, projectRoot, {
    bypass: false, sessionId: PIN, resumeId: '', model: '', effort: '', mode: 'develop', account: '',
    initialPrompt: '', deferPrompt: false, vault: 'demo-vault',
  });
  return { ws, child: spawned[spawned.length - 1] };
}

/** Every control request the server wrote to the child, parsed. */
function requests(child: FakeChild): Array<{ request_id: string; request: { subtype: string; serverName?: string } }> {
  return child.written.flatMap((l) => { try { const o = JSON.parse(l); return o.type === 'control_request' ? [o] : []; } catch { return []; } });
}

/** Answer the newest request of `subtype` the way the CLI does (nested id). */
function reply(child: FakeChild, subtype: string, response: Record<string, unknown>): void {
  const req = [...requests(child)].reverse().find((r) => r.request.subtype === subtype);
  if (!req) throw new Error(`no ${subtype} request`);
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response } })}\n`));
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  spawned.length = 0;
  _resetChatRegistry();
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-mcp-socket-proj-'));
  mkdirSync(join(projectRoot, '_dream_context'), { recursive: true });
  setAutoSwitchEnabled(false, fakeHome);
  writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({
    mcpServers: { posthog: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: `Bearer ${SECRET}` } } },
  }));
});

afterEach(() => {
  vi.useRealTimers();
  while (spawned.length) spawned.shift()!.emit('close', 0);
  rmSync(projectRoot, { recursive: true, force: true });
});

const STATUS = (status: string) => ({ mcpServers: [{ name: 'posthog', status, scope: 'dynamic', source: 'dynamic', transport: 'http', config: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: `Bearer ${SECRET}` } }, error: `401 for Bearer ${SECRET}` }] });

describe('the chat reads its own MCP status', () => {
  it('at spawn: a redacted mcp_status frame, never the CLI reply; a pinned chat writes its health file', async () => {
    const { ws, child } = spawnChat({ desktop: true });
    await flush();
    reply(child, 'mcp_status', STATUS('needs-auth'));
    await flush(); await flush();
    const [frame] = ws.metas('mcp_status');
    expect(frame.servers).toEqual([{ name: 'posthog', status: 'needs-auth', home: 'computer', transport: 'http', urlHost: 'https://mcp.example.test', errorKind: 'auth' }]);
    const all = ws.send.mock.calls.map((c) => String(c[0])).join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('control_response');
    const health = JSON.parse(readFileSync(join(mcpHealthDir(join(projectRoot, '_dream_context')), `${PIN}.json`), 'utf-8'));
    expect(health.servers).toEqual([{ name: 'posthog', status: 'needs-auth', home: 'computer' }]);
    expect(JSON.stringify(health)).not.toContain(SECRET);
    // The file dies with the child.
    child.emit('close', 0);
    spawned.length = 0;
    expect(existsSync(join(mcpHealthDir(join(projectRoot, '_dream_context')), `${PIN}.json`))).toBe(false);
  });

  it('Connect: mcp_authenticate through the chat\'s own process, the https URL to the desktop window, green when the CLI says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { ws, child } = spawnChat({ desktop: true });
    await flush();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'mcpConnect', name: 'posthog' })));
    await flush();
    const auth = requests(child).find((r) => r.request.subtype === 'mcp_authenticate')!;
    expect(auth.request.serverName).toBe('posthog');
    reply(child, 'mcp_authenticate', { authUrl: 'https://auth.example.test/authorize?state=x' });
    await flush(); await flush();
    expect(ws.metas('mcp_auth_url')).toEqual([{ type: '_meta', subtype: 'mcp_auth_url', name: 'posthog', url: 'https://auth.example.test/authorize?state=x', host: 'auth.example.test' }]);
    await vi.advanceTimersByTimeAsync(3000);
    reply(child, 'mcp_status', STATUS('connected'));
    await flush(); await flush();
    expect(ws.metas('mcp_connect').map((f) => f.state)).toContain('connected');
    expect(ws.metas('mcp_status').at(-1)!.servers).toEqual([{ name: 'posthog', status: 'connected', home: 'computer', transport: 'http', urlHost: 'https://mcp.example.test' }]);
  });

  it('a non-https auth URL is never handed to the window', async () => {
    const { ws, child } = spawnChat({ desktop: true });
    await flush();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'mcpConnect', name: 'posthog' })));
    await flush();
    reply(child, 'mcp_authenticate', { authUrl: 'http://evil.test/x' });
    await flush(); await flush();
    expect(ws.metas('mcp_auth_url')).toEqual([]);
  });

  it('Restart on a failed server is mcp_reconnect, never a sign-in', async () => {
    const { ws, child } = spawnChat({ desktop: true });
    await flush();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'mcpReconnect', name: 'posthog' })));
    await flush();
    expect(requests(child).map((r) => r.request.subtype)).toContain('mcp_reconnect');
    expect(requests(child).map((r) => r.request.subtype)).not.toContain('mcp_authenticate');
  });
});

describe('desktop only', () => {
  it('a socket that was not a desktop loopback peer at its upgrade gets mcp_desktop_only and nothing runs', async () => {
    const { ws, child } = spawnChat({ desktop: false });
    await flush();
    for (const type of ['mcpConnect', 'mcpReconnect', 'mcpRefresh']) {
      ws.emit('message', Buffer.from(JSON.stringify({ type, name: 'posthog' })));
    }
    await flush();
    expect(ws.metas('mcp_error').map((f) => f.code)).toEqual(['mcp_desktop_only', 'mcp_desktop_only', 'mcp_desktop_only']);
    expect(requests(child).map((r) => r.request.subtype)).not.toContain('mcp_authenticate');
    expect(requests(child).map((r) => r.request.subtype)).not.toContain('mcp_reconnect');
  });

  it('a phone-tagged socket is never allowed, even when loopback (a tunnel dials from 127.0.0.1)', () => {
    const phone = {};
    markSocketLoopbackForTests(phone, true);
    tagDeviceSocket(phone, { store: 'mac', idHash: 'abc' });
    expect(mcpSocketAllowed(phone)).toBe(false);
    const desk = {};
    markSocketLoopbackForTests(desk, true);
    expect(mcpSocketAllowed(desk)).toBe(true);
    expect(mcpSocketAllowed({})).toBe(false);
  });

  it('a bad server name is refused', async () => {
    const { ws } = spawnChat({ desktop: true });
    await flush();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'mcpConnect', name: '--help' })));
    await flush();
    expect(ws.metas('mcp_error').map((f) => f.code)).toEqual(['bad_server_name']);
  });
});
