// The LAPTOP's /api/handsfree/* routes: desktop + loopback + same-site only; a network-token,
// tailnet/forwarded, credentialed or cross-site request is refused (AC4, laptop part); a job
// runs one at a time in the sync-job shape; the routes are registered and never shadow the
// cloud's transfer routes or its login/logout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The dashboard's turn control must drive lane F's PTY / detached-run cuts and list them as
// running work (Go step 3); the real modules stay, only these four are observed.
const laneF = vi.hoisted(() => ({
  ptys: [] as Array<{ id: string; cwd: string }>,
  runs: [] as Array<{ pid: number; cwd: string }>,
  cutPty: [] as string[][],
  cutRuns: [] as string[][],
}));
vi.mock('../../src/server/routes/agent-terminal.js', async (orig) => ({
  ...(await orig<object>()),
  ptySessionsUnder: (roots: string[]) => laneF.ptys.filter((p) => roots.some((r) => p.cwd.startsWith(r))),
  cutPtySessionsUnder: async (roots: string[]) => { laneF.cutPty.push(roots); return laneF.ptys.length; },
}));
vi.mock('../../src/lib/automations/runner.js', async (orig) => ({
  ...(await orig<object>()),
  detachedRunsUnder: (roots: string[]) => laneF.runs.filter((p) => roots.some((r) => p.cwd.startsWith(r))),
  cutDetachedRunsUnder: async (roots: string[]) => { laneF.cutRuns.push(roots); return laneF.runs.length; },
}));
import { Socket } from 'node:net';
import { IncomingMessage, ServerResponse } from 'node:http';
import { buildRouter } from '../../src/server/index.js';
import {
  currentHandsfreeJob, handleHandsfreeAbandon, makeServerTurns, handleHandsfreeStatus, laptopRouteRefusal, setHandsfreeEnvForTests,
} from '../../src/server/routes/handsfree.js';
import { FakeCloudProvider } from '../../src/lib/handsfree/provider.js';
import { NO_TURNS, processTurnControl, under } from '../../src/lib/handsfree/turns.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandsfreeEnv } from '../../src/lib/handsfree/orchestrator.js';

function req(o: { method?: string; url?: string; remote?: string; headers?: Record<string, string> } = {}): IncomingMessage {
  const sock = new Socket();
  Object.defineProperty(sock, 'remoteAddress', { value: o.remote ?? '127.0.0.1' });
  const r = new IncomingMessage(sock);
  r.method = o.method ?? 'GET';
  r.url = o.url ?? '/api/handsfree/status';
  r.headers = { host: 'localhost:4173', ...(o.headers ?? {}) };
  return r;
}

function res(): ServerResponse & { status: number; body: unknown } {
  const r = new ServerResponse(req()) as ServerResponse & { status: number; body: unknown };
  r.writeHead = ((code: number) => { r.status = code; return r; }) as typeof r.writeHead;
  r.end = ((chunk?: unknown) => { r.body = chunk ? JSON.parse(String(chunk)) : null; return r; }) as typeof r.end;
  return r;
}

let saved: { desktop?: string; cloud?: string };
beforeEach(() => {
  saved = { desktop: process.env.DREAMCONTEXT_DESKTOP, cloud: process.env.DREAMCONTEXT_CLOUD };
  process.env.DREAMCONTEXT_DESKTOP = '1';
  delete process.env.DREAMCONTEXT_CLOUD;
});
afterEach(() => {
  if (saved.desktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved.desktop;
  if (saved.cloud === undefined) delete process.env.DREAMCONTEXT_CLOUD; else process.env.DREAMCONTEXT_CLOUD = saved.cloud;
  setHandsfreeEnvForTests(null);
});

describe('laptop route gate', () => {
  it('passes a desktop loopback same-site request', () => {
    expect(laptopRouteRefusal(req())).toBeNull();
    expect(laptopRouteRefusal(req({ method: 'POST', headers: { origin: 'http://127.0.0.1:4173', 'sec-fetch-site': 'same-origin' } }))).toBeNull();
    expect(laptopRouteRefusal(req({ method: 'POST' }))).toBeNull(); // the CLI / curl: no Origin
  });

  it('refuses a non-loopback peer (a tailnet phone)', () => {
    expect(laptopRouteRefusal(req({ remote: '100.101.102.103' }))).toMatchObject({ status: 403 });
  });

  it('refuses a request carrying the network token (cookie or query)', () => {
    expect(laptopRouteRefusal(req({ headers: { cookie: 'dreamcontext_token=abc' } }))).toMatchObject({ status: 403 });
    expect(laptopRouteRefusal(req({ url: '/api/handsfree/status?token=abc' }))).toMatchObject({ status: 403 });
  });

  it('refuses a forwarded (tailnet serve / proxy) request and a credentialed one', () => {
    expect(laptopRouteRefusal(req({ headers: { 'x-forwarded-for': '100.64.0.9' } }))).toMatchObject({ status: 403 });
    expect(laptopRouteRefusal(req({ headers: { forwarded: 'for=100.64.0.9' } }))).toMatchObject({ status: 403 });
    expect(laptopRouteRefusal(req({ headers: { authorization: 'DC-HF-HMAC n m' } }))).toMatchObject({ status: 403 });
  });

  it('refuses cross-site writes and a non-loopback Host (DNS rebinding, a tailnet name)', () => {
    expect(laptopRouteRefusal(req({ method: 'POST', headers: { origin: 'https://evil.example' } }))).toMatchObject({ status: 403, code: 'forbidden' });
    expect(laptopRouteRefusal(req({ method: 'POST', headers: { origin: 'http://100.64.0.1:4173' } }))).toMatchObject({ status: 403 });
    expect(laptopRouteRefusal(req({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }))).toMatchObject({ status: 403 });
    expect(laptopRouteRefusal(req({ headers: { host: 'evil.example:4173' } }))).toMatchObject({ status: 403 });
  });

  it('is desktop-only, and does not exist in the cloud', () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    expect(laptopRouteRefusal(req())).toMatchObject({ status: 403, code: 'desktop_only' });
    process.env.DREAMCONTEXT_DESKTOP = '1';
    process.env.DREAMCONTEXT_CLOUD = '1';
    expect(laptopRouteRefusal(req())).toMatchObject({ status: 404 });
  });
});

describe('handlers and registration', () => {
  it('status answers through the gate; abandon needs an explicit confirm; nothing runs for a refused request', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-routes-'));
    try {
      const provider = new FakeCloudProvider({ url: 'http://x' });
      setHandsfreeEnvForTests(() => ({
        home, run: async () => ({ code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }), provider, repo: provider,
        connect: () => { throw new Error('no cloud'); }, turns: NO_TURNS, roster: { read: () => ({ sessions: [], chatPermissionMode: 'auto', generation: 0 }), write: () => 1 },
        templateFiles: () => ({}), localFingerprint: () => null, packRuntime: async () => '',
      }) as HandsfreeEnv);
      const r = res();
      await handleHandsfreeStatus(req(), r);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ phase: 'home', setUp: false, offers: ['setup'], job: null });

      const refused = res();
      await handleHandsfreeStatus(req({ remote: '100.64.0.2' }), refused);
      expect(refused.status).toBe(403);

      const noConfirm = res();
      const body = req({ method: 'POST', url: '/api/handsfree/abandon' });
      setImmediate(() => { body.push('{}'); body.push(null); });
      await handleHandsfreeAbandon(body, noConfirm);
      expect(noConfirm.status).toBe(400);
      expect(currentHandsfreeJob()).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('buildRouter registers the laptop routes, the cloud transfer routes and the cloud login/logout without collisions', () => {
    const router = buildRouter();
    for (const [m, p] of [
      ['GET', '/api/handsfree/status'], ['GET', '/api/handsfree/jobs/current'], ['GET', '/api/handsfree/receipt'], ['POST', '/api/handsfree/go'],
      ['POST', '/api/handsfree/return'], ['POST', '/api/handsfree/resume'], ['POST', '/api/handsfree/rollback'], ['POST', '/api/handsfree/abandon'],
      ['POST', '/api/handsfree/devices/revoke-all'], ['POST', '/api/handsfree/login'], ['POST', '/api/handsfree/logout'],
      ['POST', '/api/handsfree/cloud/seal'], ['GET', '/api/handsfree/cloud/state'],
    ] as const) {
      expect(router.match(m, p), `${m} ${p}`).not.toBeNull();
    }
  });

  it('login/logout answer 404 off the cloud (the laptop has no phone login)', async () => {
    const router = buildRouter();
    const r = res();
    await router.match('POST', '/api/handsfree/login')!.handler(req({ method: 'POST', url: '/api/handsfree/login' }), r, {}, '');
    expect(r.status).toBe(404);
  });
});

describe('dashboard turn control (Go step 3)', () => {
  it('lists PTYs and detached runs under the roots as running work, and Cut calls lane F\'s cutPtySessionsUnder + cutDetachedRunsUnder', async () => {
    laneF.ptys = [{ id: 'pty-1', cwd: '/home/u/app/src' }, { id: 'pty-2', cwd: '/home/u/other' }];
    laneF.runs = [{ pid: 4242, cwd: '/home/u/app' }];
    const serverTurns = makeServerTurns(NO_TURNS);
    const work = await serverTurns.list(['/home/u/app']);
    expect(work).toEqual([
      { kind: 'pty', id: 'pty-1', cwd: '/home/u/app/src', busy: true },
      { kind: 'detached', id: '4242', cwd: '/home/u/app', busy: true },
    ]);
    // Idle-only cut (no owner choice) leaves PTYs and detached runs alone.
    await serverTurns.cut(['/home/u/app'], { all: false });
    expect(laneF.cutPty).toEqual([]);
    expect(laneF.cutRuns).toEqual([]);
    await serverTurns.cut(['/home/u/app'], { all: true });
    expect(laneF.cutPty).toEqual([['/home/u/app']]);
    expect(laneF.cutRuns).toEqual([['/home/u/app']]);
  });
});

describe('D22: running work by the process tree', () => {
  // self = 10 (the dashboard; group 10; parent 300, a claude that launched it).
  //  100 auto-sleep claude (group 100, not ours)        cwd in scope
  //  200 a DRAINING chat child of the dashboard (group 200) — its tab closed, no registry entry
  //  210 a hook child of 200 in ITS OWN group 210          cwd in scope
  //  220 a helper in the dashboard's OWN group 10          cwd in scope (never signalled)
  //  300 the ancestor claude                               cwd in scope (never listed)
  //  400 a claude in another project                       cwd outside (untouched)
  const lsof = ['p100', 'n/home/u/app', 'p200', 'n/home/u/app/src', 'p210', 'n/home/u/app/.git/hooks', 'p220', 'n/home/u/app', 'p300', 'n/home/u/app', 'p400', 'n/home/u/other', ''].join('\n');
  const ps = ['  10   300   10', ' 100     1  100', ' 200    10  200', ' 210   200  210', ' 220    10   10', ' 300     1  300', ' 400     1  400', ''].join('\n');
  const calls: string[][] = [];
  const run = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { code: 0, signal: null, stdout: Buffer.from(cmd === 'lsof' ? lsof : ps), stderr: Buffer.alloc(0) };
  }) as never;

  it('finds every process in scope, the dashboard\'s own descendants and hook children included; never itself, its own group or its ancestor; any command name', async () => {
    const scan = processTurnControl(run, { self: 10, kill: () => {} });
    const work = await scan.list(['/home/u/app']);
    expect(work.map((w) => [w.id, w.fromSelf])).toEqual([['100', false], ['200', true], ['210', true]]);
    // Every command, not only `claude` (a hook is `sh`/`node`).
    expect(calls.find((c) => c[0] === 'lsof')).toEqual(['lsof', '-a', '-d', 'cwd', '-F', 'pn']);
  });

  it('Cut: SIGTERM to each found group, SIGKILL to each group after the grace even when its leader exited, waits until every pid is gone; the own group and outside processes untouched', async () => {
    const sent: Array<[number, string]> = [];
    const live = new Set([100, 200, 210]);
    const kill = (pid: number, sig: NodeJS.Signals | 0) => {
      if (sig === 0) { if (!live.has(pid)) throw new Error('ESRCH'); return; }
      sent.push([pid, sig]);
      // The leaders exit on SIGTERM; the hook child 210 only dies to its group's SIGKILL.
      if (sig === 'SIGTERM') { live.delete(100); live.delete(200); }
      if (sig === 'SIGKILL' && pid === -210) live.delete(210);
    };
    const scan = processTurnControl(run, { self: 10, kill, sleep: async () => {}, graceMs: 300 });
    expect(await scan.cut(['/home/u/app'], { all: true })).toBe(3);
    expect(sent).toEqual([
      [-100, 'SIGTERM'], [-200, 'SIGTERM'], [-210, 'SIGTERM'],
      [-100, 'SIGKILL'], [-200, 'SIGKILL'], [-210, 'SIGKILL'],
    ]);
    expect(sent.some(([p]) => p === -10 || p === 10 || p === 220 || p === 300 || p === -300 || Math.abs(p) === 400)).toBe(false);
    expect(live.size).toBe(0);
    expect(await scan.cut(['/home/u/app'], { all: false })).toBe(0);
  });

  it('the dashboard: the scan decides, the registries label (a busy registry entry covers its own child tree; a detached run is named once)', async () => {
    laneF.ptys = [];
    laneF.runs = [{ pid: 100, cwd: '/home/u/app' }];
    const turns = makeServerTurns(processTurnControl(run, { self: 10, kill: () => {} }));
    // No running registry entry: the draining chat (200) and its hook (210) are running work.
    expect((await turns.list(['/home/u/app'])).map((w) => `${w.kind}:${w.id}`)).toEqual(['detached:100', 'process:200', 'process:210']);
    laneF.ptys = [{ id: 'pty-1', cwd: '/home/u/app' }];
    expect((await turns.list(['/home/u/app'])).map((w) => `${w.kind}:${w.id}`)).toEqual(['pty:pty-1', 'detached:100']);
  });

  it('under() is realpath + case-insensitive on darwin/win32 (lane F pathUnderAny)', () => {
    const ci = process.platform === 'darwin' || process.platform === 'win32';
    expect(under(['/Users/X/App'], '/users/x/app/src')).toBe(ci);
    expect(under(['/home/u/app'], '/home/u/app2')).toBe(false);
  });
});
