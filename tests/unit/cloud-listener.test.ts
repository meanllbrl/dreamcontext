// The root listener (AC19, smoke #4). The supervisor used to `listen()` its own net.Server on
// 8080 and hand `_handle.fd` to every `cloud serve --listen-fd 3` child: two processes then
// accepted from one socket, and every connection the supervisor won was never answered
// (forwarder 504s). Now the entrypoint binds the socket in python, outside libuv, and exec's the
// supervisor with it as fd 3; the supervisor only HOLDS it. These tests run that exact python
// (extracted from cloud/entrypoint.sh) and the real `holdListener`, and the old shape beside it.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error: a plain .mjs script (copied verbatim into the private repo), no types.
import { holdListener } from '../../cloud/supervisor.mjs';

const REPO = resolve(__dirname, '..', '..');
const SUPERVISOR = join(REPO, 'cloud', 'supervisor.mjs');
const N = 60;

function holdPy(): string {
  const src = readFileSync(join(REPO, 'cloud', 'entrypoint.sh'), 'utf8');
  const m = /HOLD_PY=\$\(cat <<'PY'\n([\s\S]*?)\nPY\n\)/.exec(src);
  if (!m) throw new Error('HOLD_PY not found in cloud/entrypoint.sh');
  return m[1];
}

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

const procs: ChildProcess[] = [];
let dir = '';
afterEach(() => {
  for (const p of procs.splice(0)) { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** The `cloud serve --listen-fd 3` stand-in: an http server on the inherited fd 3. */
const CHILD = `import http from 'node:http';\nhttp.createServer((q, r) => r.end('ok')).listen({ fd: 3 });\n`;

function scripts(): { child: string; newParent: string; oldParent: string } {
  dir = mkdtempSync(join(tmpdir(), 'cloud-listener-'));
  const child = join(dir, 'child.mjs');
  writeFileSync(child, CHILD);
  // Supervisor-shaped, the NEW way: hold the inherited fd 3 (holdListener) and pass it on.
  const newParent = join(dir, 'new-parent.mjs');
  writeFileSync(newParent, `import { spawn } from 'node:child_process';
import { holdListener } from ${JSON.stringify(SUPERVISOR)};
const fd = holdListener(3);
spawn(process.execPath, [${JSON.stringify(child)}], { stdio: ['ignore', 'inherit', 'inherit', fd] });
setInterval(() => {}, 1 << 30);
`);
  // The OLD supervisor shape: its own LISTENING net.Server, _handle.fd passed on.
  const oldParent = join(dir, 'old-parent.mjs');
  writeFileSync(oldParent, `import net from 'node:net';
import { spawn } from 'node:child_process';
const l = net.createServer();
l.listen({ host: '127.0.0.1', port: Number(process.argv[2]), backlog: 511 }, () => {
  spawn(process.execPath, [${JSON.stringify(child)}], { stdio: ['ignore', 'inherit', 'inherit', l._handle.fd] });
});
`);
  return { child, newParent, oldParent };
}

function get(port: number, timeoutMs: number): Promise<'ok' | 'hung' | 'err'> {
  return new Promise((res) => {
    const q = http.get({ host: '127.0.0.1', port, path: '/', agent: false, timeout: timeoutMs }, (s) => { s.resume(); s.on('end', () => res('ok')); });
    q.on('timeout', () => { q.destroy(); res('hung'); });
    q.on('error', () => res('err'));
  });
}

/** Wait until the child answers, then N sequential FRESH connections (agent: false). */
async function probe(port: number): Promise<{ ok: number; hung: number; err: number }> {
  const until = Date.now() + 15_000;
  while (Date.now() < until && (await get(port, 1000)) !== 'ok') await new Promise((r) => setTimeout(r, 100));
  const out = { ok: 0, hung: 0, err: 0 };
  for (let i = 0; i < N; i++) out[await get(port, 800)]++;
  return out;
}

describe('root listener: the supervisor holds the socket and never accepts on it (smoke #4)', () => {
  it(`the entrypoint's python bind + holdListener + a child on fd 3 answer ${N}/${N} fresh connections; the old listening-parent shape hangs`, async () => {
    const s = scripts();
    const port = await freePort();
    const held = spawn('python3', ['-c', holdPy(), '127.0.0.1', String(port), '', process.execPath, s.newParent], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    procs.push(held);
    const now = await probe(port);
    expect(now).toEqual({ ok: N, hung: 0, err: 0 });

    const port2 = await freePort();
    const old = spawn(process.execPath, [s.oldParent, String(port2)], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    procs.push(old);
    const before = await probe(port2);
    // Two processes accept from one socket: the parent's wins are never answered.
    expect(before.hung).toBeGreaterThan(0);
  }, 60_000);

  it('a failed bind (EADDRINUSE) exits before the exec: logged, no supervisor started', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cloud-listener-'));
    const busy = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => busy.once('listening', r));
    const port = (busy.address() as net.AddressInfo).port;
    const pub = join(dir, 'pub.log');
    const marker = join(dir, 'started');
    const r = spawnSync('python3', ['-c', holdPy(), '127.0.0.1', String(port), pub, process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { encoding: 'utf8' });
    busy.close();
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/listener: bind 127\.0\.0\.1:\d+ failed: .*supervisor NOT started/);
    expect(readFileSync(pub, 'utf8')).toMatch(/listener: bind 127\.0\.0\.1:\d+ failed/);
    expect(() => readFileSync(marker)).toThrow(); // the exec never happened
  });

  it('the supervisor refuses to start when fd 3 is not a listening socket (a wrong boot is loud)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cloud-listener-'));
    const file = join(dir, 'not-a-socket');
    writeFileSync(file, '');
    const fileFd = openSync(file, 'r');
    try {
      const r = spawnSync(process.execPath, [SUPERVISOR], { stdio: ['ignore', 'pipe', 'pipe', fileFd], encoding: 'utf8', timeout: 20_000 });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/no listening socket from the entrypoint: fd 3 is not a socket; supervisor NOT started/);
    } finally { closeSync(fileFd); }
    const none = spawnSync(process.execPath, [SUPERVISOR], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20_000 });
    expect(none.status).toBe(2);
    // A bare node has its own internal fd 3 (libuv), never our socket: refused all the same.
    expect(none.stderr).toMatch(/fd 3 is not (open|a socket|a listening TCP socket)/);
    // A connected (not listening) TCP socket is refused too.
    const srv = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const sock = net.connect((srv.address() as net.AddressInfo).port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    try {
      const fd = (sock as unknown as { _handle: { fd: number } })._handle.fd;
      expect(() => holdListener(fd)).toThrow(/is not a listening TCP socket/);
    } finally { sock.destroy(); srv.close(); }
  });
});

describe('the shared-accept shape cannot come back unnoticed (r11 review residual)', () => {
  it('cloud/supervisor.mjs never imports net and never creates a server', () => {
    const src = readFileSync(SUPERVISOR, 'utf8');
    // Any way of reaching node's net module from the root supervisor.
    expect(src).not.toMatch(/from\s+['"](node:)?net['"]/);
    expect(src).not.toMatch(/import\(\s*['"](node:)?net['"]\s*\)/);
    expect(src).not.toMatch(/require\(\s*['"](node:)?net['"]\s*\)/);
    expect(src).not.toMatch(/getBuiltinModule\(\s*['"](node:)?net['"]\s*\)/);
    // No listening server of any kind (net, http, https): it would accept on the held fd.
    expect(src).not.toMatch(/\bcreateServer\s*\(/);
    expect(src).not.toMatch(/\.listen\s*\(/);
  });
});
