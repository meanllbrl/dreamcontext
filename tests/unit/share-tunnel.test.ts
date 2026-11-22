// Live links, the tunnel (plan C8, C5's download rules): a share's quick tunnel points at the
// share's port only, from its own dir, with an env built per spawn; the caller sees the child at
// spawn (its watchdog starts there); an abort kills it. One cloudflared download at a time: a
// caller's abort detaches only that caller, the last one's abort (or the deadline) ends it.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { ensureCloudflared, probeReachable, startQuickTunnel, startTunnel, type CloudflaredPins } from '../../src/lib/handsfree/mac/tunnel.js';

class Proc extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(sig = 'SIGTERM'): boolean { this.signals.push(sig); this.signalCode = sig; setImmediate(() => this.emit('exit', null, sig)); return true; }
}

function spawnRecorder() {
  const calls: Array<{ file: string; args: string[]; env: Record<string, string>; cwd: string; proc: Proc }> = [];
  const spawnImpl = (file: string, args: string[], opts: { env: Record<string, string>; cwd: string }) => {
    const proc = new Proc();
    calls.push({ file, args, env: opts.env, cwd: opts.cwd, proc });
    return proc as unknown as ChildProcess;
  };
  return { calls, spawnImpl };
}

describe('startQuickTunnel', () => {
  it('points at the share port only, from its own dir, with a per-spawn env, and reports the spawn before the URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-tun-'));
    const { calls, spawnImpl } = spawnRecorder();
    let spawned: ChildProcess | null = null;
    process.env.DREAMCONTEXT_SECRET_FIXTURE = 'must-not-leak';
    const p = startQuickTunnel({ bin: '/x/cloudflared-2026.10.1', dir, port: 51234, spawnImpl, onSpawn: (c) => { spawned = c; } });
    expect(spawned).not.toBeNull();
    const c = calls[0];
    expect(c.args).toEqual(['tunnel', '--no-autoupdate', '--config', join(dir, 'cloudflared-quick.yml'), '--url', 'http://127.0.0.1:51234']);
    expect(c.cwd).toBe(dir);
    expect(c.env).toEqual({ HOME: join(dir, 'cf-home'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', NO_AUTOUPDATE: 'true' });
    expect(readFileSync(join(dir, 'cloudflared-quick.yml'), 'utf8')).toBe('no-autoupdate: true\n');
    c.proc.stderr.write('INF |  https://brave-otter-lamp-sun.trycloudflare.com  |\n');
    await expect(p).resolves.toMatchObject({ url: 'https://brave-otter-lamp-sun.trycloudflare.com', mode: 'quick' });
    delete process.env.DREAMCONTEXT_SECRET_FIXTURE;
  });

  it('an abort before the URL kills the child and rejects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-tun-'));
    const { calls, spawnImpl } = spawnRecorder();
    const ac = new AbortController();
    const p = startQuickTunnel({ bin: '/x/cf', dir, port: 5000, spawnImpl, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(calls[0].proc.signals).toContain('SIGTERM');
  });

  it('refuses a bad port and spawns nothing', async () => {
    const { calls, spawnImpl } = spawnRecorder();
    await expect(startQuickTunnel({ bin: '/x/cf', dir: tmpdir(), port: 0, spawnImpl })).rejects.toThrow('invalid port');
    expect(calls).toHaveLength(0);
  });

  it('Mac mode\'s quick branch is the same spawn (behaviour unchanged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mac-tun-'));
    const { calls, spawnImpl } = spawnRecorder();
    const p = startTunnel({ bin: '/x/cf', macDir: dir, phonePort: 6001, spawnImpl });
    expect(calls[0].args).toEqual(['tunnel', '--no-autoupdate', '--config', join(dir, 'cloudflared-quick.yml'), '--url', 'http://127.0.0.1:6001']);
    calls[0].proc.stdout.write('https://quiet-lake.trycloudflare.com\n');
    await expect(p).resolves.toMatchObject({ url: 'https://quiet-lake.trycloudflare.com' });
  });
});

describe('ensureCloudflared single-flight', () => {
  const pins: CloudflaredPins = {
    version: 'test-sf', base: 'https://example.invalid/',
    files: { 'darwin-arm64': { asset: 'cf.tgz', sha256: '0'.repeat(64), binarySha256: '1'.repeat(64), size: 10 }, 'darwin-x64': { asset: 'cf.tgz', sha256: '0'.repeat(64), binarySha256: '1'.repeat(64), size: 10 } },
  };
  /** A fetch that never answers until its signal aborts. */
  function stalled() {
    const seen: AbortSignal[] = [];
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) => new Promise((_, rej) => {
      if (init?.signal) { seen.push(init.signal); init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); }
    })) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  it('downloads once for two callers; one caller\'s abort leaves the other waiting', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cf-sf-'));
    const { seen, fetchImpl } = stalled();
    const ac = new AbortController();
    const a = ensureCloudflared({ home, pins, fetchImpl, signal: ac.signal, deadlineMs: 400 });
    const b = ensureCloudflared({ home, pins, fetchImpl });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toHaveLength(1);
    ac.abort();
    await expect(a).rejects.toThrow(/Canceled/);
    expect(seen[0].aborted).toBe(false);
    // The download keeps its own deadline: b fails by it, not by a's abort.
    await expect(b).rejects.toThrow();
    expect(seen[0].aborted).toBe(true);
    // Dropped when it failed: the next caller starts a new download.
    const { seen: seen2, fetchImpl: f2 } = stalled();
    const c = ensureCloudflared({ home, pins, fetchImpl: f2, deadlineMs: 50 });
    await expect(c).rejects.toThrow();
    expect(seen2).toHaveLength(1);
  });

  it('the last waiter\'s abort ends the download', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cf-sf-'));
    const { seen, fetchImpl } = stalled();
    const ac = new AbortController();
    const a = ensureCloudflared({ home, pins, fetchImpl, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await expect(a).rejects.toThrow(/Canceled/);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[0].aborted).toBe(true);
  });
});

describe('probeReachable for a share', () => {
  it('asks the given path, never /api/health', async () => {
    const asked: string[] = [];
    const ok = await probeReachable('https://x.trycloudflare.com', 'n1', { header: 'X-P', path: '/__share/probe', budgetMs: 1000, get: async (u) => { asked.push(u); return { status: 204, value: 'n1' }; } });
    expect(ok).toBe(true);
    expect(asked).toEqual(['https://x.trycloudflare.com/__share/probe']);
  });

  it('an abort ends the wait at once (in the first-ask grace too)', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = probeReachable('https://x.trycloudflare.com', 'n1', { header: 'X-P', path: '/__share/probe', firstAskAfterMs: 10_000, budgetMs: 85_000, signal: ac.signal, get: async () => ({ status: 0, value: null }) });
    setTimeout(() => ac.abort(), 30);
    await expect(p).resolves.toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
