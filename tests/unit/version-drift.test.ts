import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  startVersionDriftWatch,
  registerShutdownHandler,
  requestShutdown,
} from '../../src/server/lifecycle.js';
import { handleHealthGet } from '../../src/server/routes/health.js';
import { handleAdminShutdown } from '../../src/server/routes/admin.js';
import { fetchDashboardHealth, requestDashboardShutdown } from '../../src/cli/commands/hook.js';

/**
 * Root-cause fix for "No route: POST /api/tasks/token": a detached dashboard
 * server outlives an npm upgrade and serves the NEW bundle with an OLD route
 * table. These tests pin the three legs of the fix — the server-side version
 * drift watch (exit when upgraded under), the /api/health version handshake,
 * and the ensure-dashboard heal path (detect stale → ask it to shut down).
 */

describe('startVersionDriftWatch', () => {
  const ORIG = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.DREAMCONTEXT_DESKTOP;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env = { ...ORIG };
  });

  it('fires onDrift once the disk version differs from the startup version', () => {
    let disk = '1.0.0';
    const onDrift = vi.fn();
    const stop = startVersionDriftWatch('1.0.0', () => disk, onDrift, 1000);
    expect(stop).toBeDefined();

    vi.advanceTimersByTime(3000);
    expect(onDrift).not.toHaveBeenCalled();

    disk = '1.1.0'; // npm upgrade landed on disk
    vi.advanceTimersByTime(1000);
    expect(onDrift).toHaveBeenCalledExactlyOnceWith('1.1.0');

    // Fires at most once — the timer is cleared after the first drift.
    vi.advanceTimersByTime(5000);
    expect(onDrift).toHaveBeenCalledTimes(1);
    stop?.();
  });

  it("never fires on '0.0.0' (unreadable / mid-upgrade / uninstalled)", () => {
    let disk = '1.0.0';
    const onDrift = vi.fn();
    startVersionDriftWatch('1.0.0', () => disk, onDrift, 1000);

    disk = '0.0.0'; // transient: npm swapping the package directory
    vi.advanceTimersByTime(3000);
    expect(onDrift).not.toHaveBeenCalled();

    disk = '1.1.0'; // the upgrade completes → NOW it's a real drift
    vi.advanceTimersByTime(1000);
    expect(onDrift).toHaveBeenCalledExactlyOnceWith('1.1.0');
  });

  it('treats a throwing reader as unknown, not as drift', () => {
    let shouldThrow = true;
    const onDrift = vi.fn();
    startVersionDriftWatch(
      '1.0.0',
      () => {
        if (shouldThrow) throw new Error('EACCES');
        return '1.1.0';
      },
      onDrift,
      1000,
    );
    vi.advanceTimersByTime(3000);
    expect(onDrift).not.toHaveBeenCalled();

    shouldThrow = false;
    vi.advanceTimersByTime(1000);
    expect(onDrift).toHaveBeenCalledExactlyOnceWith('1.1.0');
  });

  it('does not start for desktop-spawned servers (Tauri shell owns that lifecycle)', () => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    const onDrift = vi.fn();
    const stop = startVersionDriftWatch('1.0.0', () => '2.0.0', onDrift, 1000);
    expect(stop).toBeUndefined();
    vi.advanceTimersByTime(5000);
    expect(onDrift).not.toHaveBeenCalled();
  });

  it("does not start when the startup version itself is unknown ('0.0.0' or empty)", () => {
    expect(startVersionDriftWatch('0.0.0', () => '1.0.0', vi.fn(), 1000)).toBeUndefined();
    expect(startVersionDriftWatch('', () => '1.0.0', vi.fn(), 1000)).toBeUndefined();
  });
});

describe('shutdown handler registry', () => {
  it('requestShutdown is a no-op (false) before registration, true after', () => {
    // Reset any handler leaked by other tests by registering a known one.
    const fn = vi.fn();
    registerShutdownHandler(fn);
    expect(requestShutdown()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as Record<string, unknown> };
}

const stubReq = { method: 'GET', headers: {} } as unknown as IncomingMessage;

describe('GET /api/health version handshake', () => {
  it('reports the running package version and the token capabilities', async () => {
    const { res, status, body } = makeRes();
    await handleHealthGet(stubReq, res, {}, '/tmp/x');
    expect(status()).toBe(200);

    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    expect(body().version).toBe(pkg.version);

    // Legacy capability list: the entries whose absence caused the original bug.
    const caps = body().capabilities as string[];
    expect(caps).toContain('tasks.token');
    expect(caps).toContain('tasks.token-status');
  });
});

describe('POST /api/admin/shutdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('acknowledges with 200 first, then invokes the registered shutdown', async () => {
    const shutdown = vi.fn();
    registerShutdownHandler(shutdown);

    const { res, status, body } = makeRes();
    await handleAdminShutdown(stubReq, res);

    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true, shuttingDown: true });
    expect(shutdown).not.toHaveBeenCalled(); // response flushes before exit

    vi.advanceTimersByTime(200);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('ensure-dashboard heal probes', () => {
  let server: Server;
  let port: number;
  let shutdownHits = 0;
  let healthPayload: Record<string, unknown>;

  beforeEach(async () => {
    shutdownHits = 0;
    healthPayload = { ok: true };
    server = createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(healthPayload));
        return;
      }
      if (req.url === '/api/admin/shutdown' && req.method === 'POST') {
        shutdownHits++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, shuttingDown: true }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('fetchDashboardHealth reads the version from a handshake-aware server', async () => {
    healthPayload = { ok: true, version: '9.9.9' };
    expect(await fetchDashboardHealth(port)).toEqual({ up: true, version: '9.9.9' });
  });

  it('fetchDashboardHealth reports version null for a pre-handshake server', async () => {
    healthPayload = { ok: true, capabilities: ['tasks.sync'] };
    expect(await fetchDashboardHealth(port)).toEqual({ up: true, version: null });
  });

  it('fetchDashboardHealth reports down when nothing listens', async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const result = await fetchDashboardHealth(port);
    expect(result.up).toBe(false);
    // restart so afterEach close() has a live server
    await new Promise<void>((r) => { server = createServer(() => {}); server.listen(0, '127.0.0.1', r); });
  });

  it('requestDashboardShutdown resolves true when the server acknowledges', async () => {
    expect(await requestDashboardShutdown(port)).toBe(true);
    expect(shutdownHits).toBe(1);
  });

  it('requestDashboardShutdown resolves false against an old server (404)', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => { res.writeHead(404); res.end(); });
    expect(await requestDashboardShutdown(port)).toBe(false);
  });
});
