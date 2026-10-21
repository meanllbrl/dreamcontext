/**
 * The chat and terminal upgrades open a Claude session (code execution), so a page on another
 * loopback port must not reach them (jarvis plan r9, T0, AC4): an approved dev server in a web
 * card, or any localhost tab. Nor may a DNS-rebinding page (Origin = Host = evil.test:PORT).
 * The app's own origin and a client with no Origin get past the gate (here: a 400 for an
 * unknown vault, the next check, instead of the gate's 403).
 *
 * The listener is on a random port, never `:80`: `new URL(origin).host` drops a default port.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachAgentChat } from '../../src/server/routes/agent-chat.js';
import { attachAgentTerminal } from '../../src/server/routes/agent-terminal.js';

let server: http.Server;
let port = 0;
let dir = '';
const saved = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-origin-'));
  process.env.HOME = join(dir, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
  server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  attachAgentTerminal(server);
  attachAgentChat(server, { networkToken: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as net.AddressInfo).port;
  expect(port).not.toBe(80);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  process.env.HOME = saved.HOME;
  if (saved.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved.DESKTOP;
  rmSync(dir, { recursive: true, force: true });
});

function upgrade(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const host = headers.host ?? `127.0.0.1:${port}`;
      const rest = Object.entries(headers).filter(([k]) => k !== 'host');
      sock.write([
        `GET ${path} HTTP/1.1`, `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...rest.map(([k, v]) => `${k}: ${v}`), '', '',
      ].join('\r\n'));
    });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); resolve(0); }, 4000);
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) { clearTimeout(timer); sock.destroy(); resolve(Number(m[1])); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('close', () => { clearTimeout(timer); if (!/^HTTP/.test(buf)) resolve(0); });
  });
}

const DOORS = [
  ['chat, project branch', '/api/agent/chat?vault=no-such-vault&bypass=1'],
  ['chat, assistant branch', '/api/agent/chat?vault=__assistant__'],
  ['terminal', '/api/agent/terminal?vault=no-such-vault&bypass=1'],
] as const;

describe.each(DOORS)('%s', (_name, path) => {
  it('another loopback port → 403', async () => {
    expect(await upgrade(path, { origin: 'http://localhost:5173' })).toBe(403);
    expect(await upgrade(path, { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-site' })).toBe(403);
  });

  it('DNS rebinding (Origin and Host both evil.test:PORT) → 403', async () => {
    expect(await upgrade(path, { host: `evil.test:${port}`, origin: `http://evil.test:${port}` })).toBe(403);
  });

  it('a loopback TLS proxy Host (tailscale serve) → 403', async () => {
    expect(await upgrade(path, { host: 'mac.tail1234.ts.net' })).toBe(403);
  });

  it('the app\'s own origin and an Origin-less client get past the gate', async () => {
    expect(await upgrade(path, { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' })).toBe(400);
    expect(await upgrade(path)).toBe(400);
  });
});
