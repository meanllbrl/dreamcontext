// Mac mode's tunnel manager (AC3 binary + URL, AC12 watchdog, AC16 fixed address + env isolation).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  ArchiveRefused, HostnameInUseError, QUICK_DNS_GRACE_MS, TunnelSupervisor, probeReachable, resolveFreshName, zoneServers, cloudflaredEnv, ensureCloudflared, fixedConfigYaml, readCloudflaredFromTgz, setupFixedTunnel,
  startTunnel, startWatchdog, watchdogScript, writeFixedConfig, loadCloudflaredPins, type CloudflaredPins, type CommandRunner, type RunningTunnel,
} from '../../src/lib/handsfree/mac/tunnel.js';
import { DownloadError } from '../../src/lib/onboarding/download.js';

// ─── A tiny ustar writer for the fixtures ───────────────────────────────────

function header(name: string, size: number, type: string, linkname = ''): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000755\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function tgz(entries: Array<{ name: string; body?: Buffer; type?: string; link?: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = e.body ?? Buffer.alloc(0);
    parts.push(header(e.name, body.length, e.type ?? '0', e.link));
    parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const BIN = Buffer.from('#!/bin/sh\necho fake cloudflared\n');

let dir: string;
let home: string;
let server: http.Server;
let base: string;
const served = new Map<string, Buffer>();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mac-tunnel-'));
  home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  served.clear();
  server = http.createServer((q, r) => {
    const body = served.get((q.url ?? '').slice(1));
    if (!body) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Length': body.length });
    r.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function pinsFor(archive: Buffer, opts: { sha?: string } = {}): CloudflaredPins {
  return {
    version: '9.9.9', base: 'https://example.invalid/',
    files: { 'darwin-arm64': { asset: 'cf.tgz', sha256: opts.sha ?? sha(archive), binarySha256: sha(BIN), size: archive.length } },
  };
}

/** No executable may be left in ~/.dreamcontext/bin after a refusal (no temp dir either). */
function binLeftovers(): string[] {
  const b = join(home, '.dreamcontext', 'bin');
  return existsSync(b) ? readdirSync(b) : [];
}

describe('the pinned cloudflared binary (AC3)', () => {
  it('the shipped pins name both darwin archives with a sha256 each', () => {
    const pins = loadCloudflaredPins();
    expect(pins.base).toMatch(/^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\//);
    for (const k of ['darwin-arm64', 'darwin-x64']) {
      expect(pins.files[k].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pins.files[k].binarySha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('downloads, verifies the archive sha256, extracts only `cloudflared` 0700 into ~/.dreamcontext/bin', async () => {
    const archive = tgz([{ name: 'README', body: Buffer.from('x') }, { name: 'cloudflared', body: BIN }]);
    served.set('cf.tgz', archive);
    const p = await ensureCloudflared({ home, pins: pinsFor(archive), arch: 'arm64', baseOverride: base });
    expect(p).toBe(join(home, '.dreamcontext', 'bin', 'cloudflared-9.9.9'));
    expect(readFileSync(p)).toEqual(BIN);
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o700); // Windows has no POSIX mode bits
    if (process.platform !== 'win32') expect(statSync(join(home, '.dreamcontext', 'bin')).mode & 0o777).toBe(0o700); // Windows has no POSIX mode bits
    expect(binLeftovers()).toEqual(['cloudflared-9.9.9']);
    // A second call reuses it (no download: the server has nothing now).
    served.clear();
    expect(await ensureCloudflared({ home, pins: pinsFor(archive), arch: 'arm64', baseOverride: base })).toBe(p);
  });

  it('a wrong sha256 is refused and leaves no executable', async () => {
    const archive = tgz([{ name: 'cloudflared', body: BIN }]);
    served.set('cf.tgz', archive);
    await expect(ensureCloudflared({ home, pins: pinsFor(archive, { sha: 'a'.repeat(64) }), arch: 'arm64', baseOverride: base }))
      .rejects.toBeInstanceOf(DownloadError);
    expect(binLeftovers()).toEqual([]);
  });

  it('a traversal entry refuses the whole archive and leaves no executable', async () => {
    const archive = tgz([{ name: '../../evil', body: Buffer.from('x') }, { name: 'cloudflared', body: BIN }]);
    served.set('cf.tgz', archive);
    await expect(ensureCloudflared({ home, pins: pinsFor(archive), arch: 'arm64', baseOverride: base })).rejects.toBeInstanceOf(ArchiveRefused);
    expect(binLeftovers()).toEqual([]);
    expect(existsSync(join(home, '.dreamcontext', 'evil'))).toBe(false);
  });

  it('a symlink entry refuses the whole archive and leaves no executable', async () => {
    const archive = tgz([{ name: 'cloudflared', type: '2', link: '/bin/sh' }]);
    served.set('cf.tgz', archive);
    await expect(ensureCloudflared({ home, pins: pinsFor(archive), arch: 'arm64', baseOverride: base })).rejects.toBeInstanceOf(ArchiveRefused);
    expect(binLeftovers()).toEqual([]);
  });

  it('hard links, devices, absolute paths and a missing entry are refused too', () => {
    expect(() => readCloudflaredFromTgz(tgz([{ name: 'cloudflared', type: '1', link: 'x' }]))).toThrow(ArchiveRefused);
    expect(() => readCloudflaredFromTgz(tgz([{ name: 'cloudflared', type: '3' }]))).toThrow(ArchiveRefused);
    expect(() => readCloudflaredFromTgz(tgz([{ name: '/etc/cloudflared', body: BIN }]))).toThrow(ArchiveRefused);
    expect(() => readCloudflaredFromTgz(tgz([{ name: 'other', body: BIN }]))).toThrow(/no cloudflared/);
    expect(() => readCloudflaredFromTgz(Buffer.from('not gzip'))).toThrow(ArchiveRefused);
  });

  it('a non-https URL is refused (only the loopback seam may be http)', async () => {
    const archive = tgz([{ name: 'cloudflared', body: BIN }]);
    await expect(ensureCloudflared({ home, pins: { ...pinsFor(archive), base: 'http://example.invalid/' }, arch: 'arm64' })).rejects.toBeInstanceOf(DownloadError);
    expect(binLeftovers()).toEqual([]);
  });
});

/** A fake cloudflared: prints a quick-tunnel URL on stderr and dumps its env and argv. */
function fakeCloudflared(script: string): string {
  const p = join(dir, 'fake-cloudflared.mjs');
  writeFileSync(p, `#!/usr/bin/env node\n${script}`);
  chmodSync(p, 0o755);
  return p;
}

describe('starting a tunnel (AC3 URL, AC16 env isolation)', () => {
  it('a quick tunnel resolves with the first trycloudflare URL, pointed at the phone port, our own config', async () => {
    const out = join(dir, 'argv.json');
    const bin = fakeCloudflared(`require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\\n');
setTimeout(() => process.stderr.write('|  https://quiet-lake-1234.trycloudflare.com  |\\n'), 50);
setInterval(() => {}, 1000);`.replace(/require\(/g, '(await import("node:module")).createRequire(import.meta.url)('));
    const macDir = join(dir, 'mac');
    mkdirSync(macDir, { recursive: true });
    process.env.DREAMCONTEXT_SECRET_PROBE = 'must-not-leak';
    const before = JSON.stringify(process.env);
    let run: RunningTunnel | null = null;
    try {
      run = await startTunnel({ bin: process.execPath, macDir, phonePort: 45678, timeoutMs: 10_000, spawnImpl: (file, args, opts) => spawn(file, [bin, ...args], { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] }) });
      expect(run.url).toBe('https://quiet-lake-1234.trycloudflare.com');
      const seen = JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; env: Record<string, string> };
      expect(seen.argv).toEqual(['tunnel', '--no-autoupdate', '--config', join(macDir, 'cloudflared-quick.yml'), '--url', 'http://127.0.0.1:45678']);
      expect(seen.env.DREAMCONTEXT_SECRET_PROBE).toBeUndefined();
      expect(Object.keys(seen.env).filter((k) => !['HOME', 'PATH', 'LANG', 'NO_AUTOUPDATE', '__CF_USER_TEXT_ENCODING'].includes(k))).toEqual([]);
      expect(seen.env.HOME).toBe(join(macDir, 'cf-home'));
      // process.env itself was never written.
      expect(JSON.stringify(process.env)).toBe(before);
    } finally {
      delete process.env.DREAMCONTEXT_SECRET_PROBE;
      run?.child.kill('SIGKILL');
    }
  });

  it('times out (and kills the child) when no URL appears', async () => {
    const bin = fakeCloudflared('setInterval(() => {}, 1000);');
    const macDir = join(dir, 'mac2');
    mkdirSync(macDir, { recursive: true });
    await expect(startTunnel({ bin: process.execPath, macDir, phonePort: 1, timeoutMs: 400, spawnImpl: (f, a, o) => spawn(f, [bin, ...a], { env: o.env, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] }) }))
      .rejects.toThrow(/in time/);
  });

  it('cloudflaredEnv is built from scratch', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'secret';
    try {
      const env = cloudflaredEnv('/h');
      expect(env).toEqual({ HOME: '/h', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', NO_AUTOUPDATE: 'true' });
    } finally { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
  });
});

describe('fixed address (AC16)', () => {
  const rec = { hostname: 'phone.example.com', tunnelId: '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', name: 'dreamcontext-hf' };
  const free = async () => false;
  /** A cloudflared that logs in, creates, and answers `route dns` with `routeOut`. */
  const fakeCf = (calls: string[][], routeOut = { code: 0, stdout: '', stderr: '' }): CommandRunner => async (_file, args, opts) => {
    calls.push(args);
    if (args[1] === 'login') {
      mkdirSync(join(opts.env.HOME, '.cloudflared'), { recursive: true });
      writeFileSync(join(opts.env.HOME, '.cloudflared', 'cert.pem'), 'ZONE-CERT');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('create')) {
      writeFileSync(args[args.indexOf('--credentials-file') + 1], '{}');
      return { code: 0, stdout: `Created tunnel dreamcontext-hf with id ${rec.tunnelId}`, stderr: '' };
    }
    return routeOut;
  };

  it('start writes the ingress itself: the phone port, then a 404 catch-all; 0600', () => {
    const macDir = join(dir, 'm');
    mkdirSync(macDir);
    writeFileSync(join(macDir, 'tunnel.json'), '{}', { mode: 0o600 });
    const p = writeFixedConfig(macDir, rec, 40123);
    const yaml = readFileSync(p, 'utf8');
    expect(yaml).toContain('  - hostname: phone.example.com\n    service: http://127.0.0.1:40123\n  - service: http_status:404\n');
    expect(yaml.indexOf('http_status:404')).toBeGreaterThan(yaml.indexOf('40123'));
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(() => fixedConfigYaml({ ...rec, hostname: 'bad host' }, '/c', 1)).toThrow();
  });

  it('setup: login under a PRIVATE HOME, create with credentials 0600 in the Mac dir, route DNS, then the cert is gone; ~/.cloudflared untouched', async () => {
    const macDir = join(dir, 'mac');
    mkdirSync(macDir, { recursive: true });
    const calls: Array<{ args: string[]; home: string }> = [];
    const run: CommandRunner = async (_file, args, opts) => {
      calls.push({ args, home: opts.env.HOME });
      if (args[1] === 'login') {
        opts.onLine?.('Please open the following URL: https://dash.cloudflare.com/argotunnel?callback=abc');
        mkdirSync(join(opts.env.HOME, '.cloudflared'), { recursive: true });
        writeFileSync(join(opts.env.HOME, '.cloudflared', 'cert.pem'), 'ZONE-CERT');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args.includes('create')) {
        writeFileSync(args[args.indexOf('--credentials-file') + 1], '{"TunnelSecret":"s3cret"}');
        return { code: 0, stdout: `Created tunnel dreamcontext-hf with id ${rec.tunnelId}`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    let loginUrl = '';
    const out = await setupFixedTunnel({ bin: '/x/cloudflared', macDir, hostname: 'Phone.Example.com', run, hostnameInUse: free, onLoginUrl: (u) => { loginUrl = u; } });
    expect(out).toEqual(rec);
    expect(loginUrl).toBe('https://dash.cloudflare.com/argotunnel?callback=abc');
    expect(calls[0]).toEqual({ args: ['tunnel', 'login'], home: join(macDir, 'cf-login') });
    expect(calls[1].args).toEqual(['tunnel', '--origincert', join(macDir, 'cf-login', '.cloudflared', 'cert.pem'), 'create', '--credentials-file', join(macDir, 'tunnel.json'), 'dreamcontext-hf']);
    expect(calls[2].args).toEqual(['tunnel', '--origincert', join(macDir, 'cf-login', '.cloudflared', 'cert.pem'), 'route', 'dns', 'dreamcontext-hf', 'phone.example.com']);
    if (process.platform !== 'win32') expect(statSync(join(macDir, 'tunnel.json')).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(existsSync(join(macDir, 'cf-login'))).toBe(false);
    const leftovers = readdirSync(macDir, { recursive: true }).map(String);
    expect(leftovers.some((f) => f.endsWith('cert.pem'))).toBe(false);
    expect(existsSync(join(process.env.HOME ?? '/nonexistent', '.cloudflared', 'cert.pem')) && calls.some((c) => c.home === process.env.HOME)).toBe(false);
    expect(calls.every((c) => c.home !== process.env.HOME)).toBe(true);
  });

  it('a failed login still deletes the login home', async () => {
    const macDir = join(dir, 'mac3');
    mkdirSync(macDir, { recursive: true });
    const run: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'nope' });
    await expect(setupFixedTunnel({ bin: '/x', macDir, hostname: 'a.example.com', run, hostnameInUse: free })).rejects.toThrow(/login/);
    expect(existsSync(join(macDir, 'cf-login'))).toBe(false);
  });

  it('a hostname that already resolves is refused BEFORE the login, and nothing runs', async () => {
    const macDir = join(dir, 'mac4');
    mkdirSync(macDir, { recursive: true });
    const calls: string[][] = [];
    const err = await setupFixedTunnel({ bin: '/x', macDir, hostname: 'www.example.com', run: fakeCf(calls), hostnameInUse: async () => true }).catch((e) => e);
    expect(err).toBeInstanceOf(HostnameInUseError);
    expect(err.hostname).toBe('www.example.com');
    expect(calls).toEqual([]);
  });

  it('Cloudflare saying the record already exists is the same refusal (the record is left alone)', async () => {
    const macDir = join(dir, 'mac5');
    mkdirSync(macDir, { recursive: true });
    const calls: string[][] = [];
    const run = fakeCf(calls, { code: 1, stdout: '', stderr: 'Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists.' });
    await expect(setupFixedTunnel({ bin: '/x', macDir, hostname: 'api.example.com', run, hostnameInUse: free })).rejects.toBeInstanceOf(HostnameInUseError);
    expect(calls.find((a) => a.includes('route'))).not.toContain('--overwrite-dns');
  });

  it('after Cloudflare refuses the route, the created tunnel is deleted, so the confirmed retry succeeds', async () => {
    const macDir = join(dir, 'mac7');
    mkdirSync(macDir, { recursive: true });
    const account = new Set<string>(); // the tunnel names on the owner's Cloudflare account
    const calls: string[][] = [];
    const run: CommandRunner = async (_file, args, opts) => {
      calls.push(args);
      const name = args[args.length - 1];
      if (args[1] === 'login') {
        mkdirSync(join(opts.env.HOME, '.cloudflared'), { recursive: true });
        writeFileSync(join(opts.env.HOME, '.cloudflared', 'cert.pem'), 'ZONE-CERT');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args.includes('create')) {
        if (account.has(name)) return { code: 1, stdout: '', stderr: 'tunnel with name already exists' };
        account.add(name);
        writeFileSync(args[args.indexOf('--credentials-file') + 1], '{}');
        return { code: 0, stdout: `Created tunnel ${name} with id ${rec.tunnelId}`, stderr: '' };
      }
      if (args.includes('delete')) { account.delete(name); return { code: 0, stdout: '', stderr: '' }; }
      if (args.includes('route') && !args.includes('--overwrite-dns')) return { code: 1, stdout: '', stderr: 'An A, AAAA, or CNAME record with that host already exists.' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await expect(setupFixedTunnel({ bin: '/x', macDir, hostname: 'api.example.com', run, hostnameInUse: free })).rejects.toBeInstanceOf(HostnameInUseError);
    expect(account.size).toBe(0);
    expect(existsSync(join(macDir, 'tunnel.json'))).toBe(false);
    const out = await setupFixedTunnel({ bin: '/x', macDir, hostname: 'api.example.com', run, overwriteDns: true });
    expect(out.hostname).toBe('api.example.com');
    expect(account.has('dreamcontext-hf')).toBe(true);
  });

  it('only a confirmed overwrite passes --overwrite-dns (and skips the lookup)', async () => {
    const macDir = join(dir, 'mac6');
    mkdirSync(macDir, { recursive: true });
    const calls: string[][] = [];
    let asked = false;
    await setupFixedTunnel({ bin: '/x', macDir, hostname: 'phone.example.com', run: fakeCf(calls), overwriteDns: true, hostnameInUse: async () => { asked = true; return true; } });
    expect(asked).toBe(false);
    expect(calls.find((a) => a.includes('route'))).toContain('--overwrite-dns');
  });
});

describe('watchdog (AC12)', () => {
  const procs: ChildProcess[] = [];
  afterEach(() => { for (const p of procs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('killing the server leaves cloudflared dead within 5 s; a non-matching pid is never killed', async () => {
    const bdir = join(home, '.dreamcontext', 'bin');
    mkdirSync(bdir, { recursive: true });
    const cf = join(bdir, 'cloudflared-test');
    // A copy of a platform binary (/bin/sleep) is SIGKILLed on exec by macOS; a node copy runs.
    copyFileSync(process.execPath, cf, fsConstants.COPYFILE_FICLONE);
    chmodSync(cf, 0o700);
    const tunnel = spawn(cf, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    const bystander = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    const fakeServer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    procs.push(tunnel, bystander, fakeServer);
    const w1 = startWatchdog(fakeServer.pid!, tunnel.pid!, cf);
    const w2 = startWatchdog(fakeServer.pid!, bystander.pid!, cf);
    procs.push(w1, w2);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(tunnel.pid!)).toBe(true);
    fakeServer.kill('SIGKILL');
    const t0 = Date.now();
    while (alive(tunnel.pid!) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
    // The killed child is a zombie until reaped; its exit event proves the signal landed.
    const exited = tunnel.exitCode !== null || tunnel.signalCode !== null || !alive(tunnel.pid!);
    expect(exited).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    await new Promise((r) => setTimeout(r, 2500));
    expect(bystander.exitCode === null && bystander.signalCode === null).toBe(true);
  }, 15_000);

  it('refuses bad pids and odd paths', () => {
    expect(() => watchdogScript(0, 5, '/a')).toThrow();
    expect(() => watchdogScript(5, 5, 'relative')).toThrow();
    expect(() => watchdogScript(5, 6, '/a;rm -rf /')).toThrow();
  });
});

describe('supervisor', () => {
  it('restarts an unexpected exit with a NEW url (onUrl restarted=true), at most 5 per 10 min, never on its own otherwise', async () => {
    const { EventEmitter } = await import('node:events');
    const children: Array<InstanceType<typeof EventEmitter> & { pid: number; exitCode: null; signalCode: null; kill: () => void }> = [];
    let n = 0;
    const startImpl = async () => {
      const c = Object.assign(new EventEmitter(), { pid: 1000 + n, exitCode: null, signalCode: null, kill: () => { c.emit('exit', 0); } });
      children.push(c);
      n++;
      return { child: c as unknown as ChildProcess, url: `https://u${n}.trycloudflare.com`, mode: 'quick' as const };
    };
    const urls: Array<[string, boolean]> = [];
    let gaveUp = '';
    const sup = new TunnelSupervisor(
      { bin: '/x', macDir: dir, phonePort: 1, serverPid: process.pid, startImpl, watchdogImpl: () => ({ kill() {}, pid: 1 }) as unknown as ChildProcess, now: () => 0 },
      { onUrl: (u, r) => urls.push([u, r]), onGiveUp: (why) => { gaveUp = why; } },
    );
    await sup.start();
    for (let i = 0; i < 6; i++) { children[children.length - 1].emit('exit', 1); await new Promise((r) => setTimeout(r, 5)); }
    expect(urls[0]).toEqual(['https://u1.trycloudflare.com', false]);
    expect(urls.slice(1).every(([, r]) => r)).toBe(true);
    expect(urls).toHaveLength(6);
    expect(gaveUp).toBe('restart_budget');
    await sup.stop();
  });
});

describe('reachability probe: never cache the name\'s absence (AC3)', () => {
  it('asks nobody before the grace, then succeeds on the first answer carrying the nonce', async () => {
    vi.useFakeTimers();
    try {
      const asked: number[] = [];
      const t0 = Date.now();
      const get = async () => { asked.push(Date.now() - t0); return { status: 200, value: 'N1' }; };
      const p = probeReachable('https://a-b.trycloudflare.com', 'N1', { header: 'x', get, firstAskAfterMs: QUICK_DNS_GRACE_MS, budgetMs: 85_000 });
      await vi.advanceTimersByTimeAsync(QUICK_DNS_GRACE_MS - 1);
      expect(asked).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe(true);
      expect(asked).toEqual([QUICK_DNS_GRACE_MS]);
    } finally { vi.useRealTimers(); }
  });

  it('a wrong value (another listener) never passes; the budget ends it', async () => {
    const get = async () => ({ status: 200, value: 'OTHER' });
    expect(await probeReachable('https://a.example.com', 'N1', { header: 'x', get, budgetMs: 50, stepMs: 10 })).toBe(false);
  });

  it('finds the zone\'s authoritative servers walking up from the parent, never the bare TLD', async () => {
    const asked: string[] = [];
    const q = {
      ns: async (n: string) => { asked.push(n); return n === 'example.com' ? ['ns1.cf.net', 'ns2.cf.net'] : []; },
      a: async (n: string) => (n === 'ns1.cf.net' ? ['192.0.2.1'] : ['192.0.2.2']),
    };
    expect(await zoneServers('phone.lab.example.com', q)).toEqual(['192.0.2.1', '192.0.2.2']);
    expect(asked).toEqual(['lab.example.com', 'example.com']);
    expect(await zoneServers('x.y.org', { ns: async () => [], a: async () => [] })).toBeNull();
  });
});

describe('fresh-name resolution: each stage on its own timer, the system resolver always reachable', () => {
  const never = <T>() => new Promise<T>(() => {});
  it('authoritative and public unreachable (port 53 dropped) → the system resolver answers within the stage timers', async () => {
    const asked: string[] = [];
    const t0 = Date.now();
    const ip = await resolveFreshName('a-b.trycloudflare.com', {
      stageMs: 30,
      zone: () => never(),
      at: () => { asked.push('at'); return never(); },
      system: async () => { asked.push('system'); return '198.51.100.7'; },
    });
    expect(ip).toBe('198.51.100.7');
    expect(asked).toEqual(['at', 'system']); // public tried once, then the system's
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('an authoritative NXDOMAIN is final (not published yet): no caching resolver is asked', async () => {
    const asked: string[][] = [];
    const err = await resolveFreshName('a-b.trycloudflare.com', {
      stageMs: 30, zone: async () => ['192.0.2.1'],
      at: async (servers) => { asked.push(servers); return 'ENOTFOUND'; },
      system: async () => { throw new Error('the system resolver must not be asked'); },
    }).catch((e) => e);
    expect(err.code).toBe('ENOTFOUND');
    expect(asked).toEqual([['192.0.2.1']]);
  });

  it('ENODATA at the source (a CNAME out of the zone) falls through to the public resolvers', async () => {
    const ip = await resolveFreshName('phone.example.com', {
      stageMs: 30, zone: async () => ['192.0.2.1'],
      at: async (servers) => (servers[0] === '192.0.2.1' ? 'ENODATA' : ['203.0.113.9']),
      system: async () => '0.0.0.0',
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('an authoritative answer is used as is', async () => {
    const ip = await resolveFreshName('a-b.trycloudflare.com', {
      stageMs: 30, zone: async () => ['192.0.2.1'], at: async () => ['104.16.0.1'], system: async () => '0.0.0.0',
    });
    expect(ip).toBe('104.16.0.1');
  });
});
