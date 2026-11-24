// Shared fixture for the live-link tests: a fake cloudflared, fake deps, a fake kind and a request
// helper that talks to a share's real 127.0.0.1 listener as the tunnel would (Host + cf headers).
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Duplex } from 'node:stream';
import '../../src/server/shares/listener.js';
import { AwakeHold } from '../../src/server/shares/awake.js';
import {
  configureSharesForTests, registerShareKind, type Share, type ShareDeps, type ShareKindHandler,
} from '../../src/server/shares/registry.js';

let nextPid = 70_000;

export class FakeChild extends EventEmitter {
  pid = nextPid++;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];
  /** A child that ignores SIGTERM (to prove the SIGKILL fallback). */
  constructor(private readonly stubborn = false) { super(); }
  kill(sig: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(sig);
    if (this.exitCode !== null || this.signalCode !== null) return false;
    if (this.stubborn && sig === 'SIGTERM') return true;
    this.signalCode = sig;
    setImmediate(() => this.emit('exit', null, sig));
    return true;
  }
  /** cloudflared dies on its own. */
  die(code = 1): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
  get alive(): boolean { return this.exitCode === null && this.signalCode === null; }
}

export interface Hang { promise: Promise<void>; release: () => void }
export function hang(): Hang {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

const untilAbort = (signal: AbortSignal | undefined): Promise<never> => new Promise((_, rej) => {
  if (signal?.aborted) { rej(new Error('aborted')); return; }
  signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
});

export interface FakeWorld {
  home: string;
  children: FakeChild[];
  caffeinates: FakeChild[];
  awake: AwakeHold;
  /** Set to make the next start hang in that stage until aborted. */
  hangIn: { download?: boolean; tunnel?: boolean; probe?: boolean };
  probeOk: boolean;
  stubborn: boolean;
  now: number;
  urls: number;
}

export function fakeWorld(patch: Partial<ShareDeps> = {}): FakeWorld {
  const w: FakeWorld = {
    home: mkdtempSync(join(tmpdir(), 'dc-shares-')), children: [], caffeinates: [],
    awake: null as unknown as AwakeHold, hangIn: {}, probeOk: true, stubborn: false, now: Date.now(), urls: 0,
  };
  w.awake = new AwakeHold({ spawnImpl: () => { const c = new FakeChild(); w.caffeinates.push(c); return c as unknown as ChildProcess; } });
  configureSharesForTests({
    home: w.home,
    serverPid: process.pid,
    ensureBinary: async (o) => { if (w.hangIn.download) await untilAbort(o.signal); return '/fake/bin/cloudflared-test'; },
    startTunnel: async (o) => {
      const c = new FakeChild(w.stubborn);
      w.children.push(c);
      o.onSpawn?.(c as unknown as ChildProcess);
      if (w.hangIn.tunnel) {
        try { await untilAbort(o.signal); } catch (e) { c.kill('SIGTERM'); throw e; }
      }
      w.urls++;
      return { child: c as unknown as ChildProcess, url: `https://calm-river-${w.urls}.trycloudflare.com`, mode: 'quick' as const };
    },
    probe: async (_u, _n, o) => { if (w.hangIn.probe) await untilAbort(o.signal); return w.probeOk; },
    watchdog: () => null,
    awake: w.awake,
    graceMs: 200,
    killAfterMs: 150,
    now: () => w.now,
    log: () => {},
    ...patch,
  });
  return w;
}

export interface KindSpy {
  served: string[];
  upgrades: Duplex[];
  holds: number;
  released: number;
}

/** A fake kind: `serve` answers 200 "guest ok", `upgrade` keeps the socket open (a live WebSocket). */
export function fakeKind(kind: 'app' | 'board' = 'board'): KindSpy {
  const spy: KindSpy = { served: [], upgrades: [], holds: 0, released: 0 };
  const handler: ShareKindHandler = {
    resolve: ({ vault, slug }) => {
      if (slug === 'missing') throw Object.assign(new Error('no such'), { status: 404 });
      return { name: `Lansman ${slug}`, key: `${kind}:${vault}:${slug}`, hold: () => { spy.holds++; return () => { spy.released++; }; } };
    },
    serve: (_share, req, res) => {
      spy.served.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('guest ok');
    },
    upgrade: (_share, _req, sock) => {
      spy.upgrades.push(sock);
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    },
  };
  registerShareKind(kind, handler);
  return spy;
}

export async function waitFor(pred: () => boolean, ms = 3000, label = 'condition'): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** A request as the tunnel delivers it: to the share's port, its public Host, Cloudflare's headers. */
export function viaTunnel(share: Share, method: string, path: string, headers: Record<string, string | undefined> = {}, body?: string): Promise<Reply> {
  const h: Record<string, string> = { host: share.host ?? 'unset.invalid', 'cf-connecting-ip': '203.0.113.7', 'cf-ray': 'abc-IST' };
  for (const [k, v] of Object.entries(headers)) { if (v === undefined) delete h[k]; else h[k] = v; }
  if (body !== undefined) h['content-length'] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: share.port, method, path, headers: h, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A raw WebSocket handshake over the share listener; resolves with the socket and the status. */
export function upgradeViaTunnel(share: Share, path: string, headers: Record<string, string> = {}): Promise<{ status: number; sock: net.Socket }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(share.port, '127.0.0.1');
    const h: Record<string, string> = {
      host: share.host ?? 'unset.invalid', 'cf-connecting-ip': '203.0.113.7', origin: share.origin ?? '',
      upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...headers,
    };
    sock.once('connect', () => {
      sock.write(`GET ${path} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    });
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString('utf8');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) { sock.off('data', onData); resolve({ status: Number(m[1]), sock }); }
    };
    sock.on('data', onData);
    sock.once('close', () => { if (!/^HTTP\/1\.1 \d{3}/.test(buf)) resolve({ status: 0, sock }); });
    sock.once('error', reject);
  });
}

/** The session cookie a /k/<token> visit sets (name=value). */
export function sessionCookie(reply: Reply): string {
  const sc = reply.headers['set-cookie'] ?? [];
  const line = sc.find((l) => l.startsWith('__Host-dcs='));
  if (!line) throw new Error('no session cookie');
  return line.split(';')[0];
}

export async function openAndWait(open: () => Share): Promise<Share> {
  const s = open();
  await waitFor(() => s.state === 'open' || s.state === 'broken', 3000, 'share open');
  return s;
}
