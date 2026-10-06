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
  handleHandsfreeCut, handleHandsfreeGo, handleHandsfreePreflight,
} from '../../src/server/routes/handsfree.js';
import { updateConfig } from '../../src/lib/handsfree/local-store.js';
import { beginGoing, readTripState, setPhase } from '../../src/lib/handsfree/trip-state.js';
import type { TurnControl } from '../../src/lib/handsfree/turns.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { FakeCloudProvider } from '../../src/lib/handsfree/provider.js';
import { NO_TURNS, processTurnControl, under } from '../../src/lib/handsfree/turns.js';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandsfreeEnv } from '../../src/lib/handsfree/orchestrator.js';
import { FAKE_CLOUD_VERSION, fakeRegistry } from '../helpers/handsfree-fake-cloud.js';

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
        templateFiles: () => ({}), localVersion: () => '0.30.0', registryFetch: (async () => { throw new Error('no npm in this test'); }) as unknown as typeof fetch,
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
      ['GET', '/api/handsfree/preflight'], ['POST', '/api/handsfree/jobs/current/cut'],
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

describe('round 3: the process scan fails CLOSED', () => {
  it('an lsof failure or timeout is unknown running work (never "nothing"), and Cut cannot pretend it cut it', async () => {
    const failing = (async (cmd: string) => (cmd === 'lsof'
      ? { code: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: Buffer.from('timed out') }
      : { code: 0, signal: null, stdout: Buffer.from('  10 1 10\n'), stderr: Buffer.alloc(0) })) as never;
    const scan = processTurnControl(failing, { self: 10, kill: () => {} });
    expect(await scan.list(['/home/u/app'])).toEqual([{ kind: 'process', id: 'unknown', busy: true }]);
    expect(await scan.cut(['/home/u/app'], { all: true })).toBe(0);
    const crashed = (async () => { throw new Error('spawn lsof ENOENT'); }) as never;
    expect(await processTurnControl(crashed, { self: 10 }).list(['/x'])).toEqual([{ kind: 'process', id: 'unknown', busy: true }]);
  });
});

describe('wave 3: preflight and the live Cut', () => {
  const okRun = (async () => ({ code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })) as never;
  let home: string;
  let ctx: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'hf-routes-w3-'));
    const vault = join(home, 'projects', 'app');
    ctx = join(vault, '_dream_context');
    mkdirSync(join(ctx, 'core'), { recursive: true });
    writeFileSync(join(ctx, 'core', '0.soul.md'), 'soul '.repeat(200));
    await updateConfig(home, (c) => ({
      ...c, repo: { fullName: 'owner/dreamcontext-handsfree', fileShas: {} },
      codespace: { name: 'fake-hf-1', machine: 'basicLinux32gb', url: 'http://127.0.0.1:9', webUrl: 'https://example.invalid/fake-hf-1', retentionExpiresAt: null },
    }));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function envWith(o: { turns?: TurnControl; provider?: FakeCloudProvider } = {}): () => HandsfreeEnv {
    const provider = o.provider ?? new FakeCloudProvider({ url: 'http://127.0.0.1:9' });
    return () => ({
      home, run: okRun, provider, repo: provider,
      connect: () => { throw new Error('no cloud in this test'); }, turns: o.turns ?? NO_TURNS,
      roster: { read: () => ({ sessions: [], chatPermissionMode: 'auto', generation: 0 }), write: () => 1 },
      // D25: go looks this version up before it locks; the injected registry publishes it (never npm).
      templateFiles: () => ({}), localVersion: () => FAKE_CLOUD_VERSION, registryFetch: fakeRegistry().fetchImpl,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), waitTimeoutMs: 10_000,
    }) as HandsfreeEnv;
  }

  it('preflight: scope + size estimate, machine and quota, running turns; never starts anything or writes', async () => {
    const provider = new FakeCloudProvider({ url: 'http://127.0.0.1:9' });
    const turns: TurnControl = { list: async () => [{ kind: 'chat', id: 'c1', busy: true }], cut: async () => 0 };
    setHandsfreeEnvForTests(envWith({ turns, provider }));
    const r = res();
    await handleHandsfreePreflight(req({ url: '/api/handsfree/preflight' }), r, {}, ctx);
    expect(r.status).toBe(200);
    const body = r.body as { roots: Array<{ kind: string; bytes: number }>; totalBytes: number; machine: Record<string, unknown>; runningTurns: unknown[]; refusal: unknown };
    expect(body.roots).toEqual([expect.objectContaining({ kind: 'files', bytes: 1000 })]);
    expect(body.totalBytes).toBe(1000);
    expect(body.machine).toMatchObject({ name: 'basicLinux32gb', needBytes: 1300, quotaSource: 'laptop', running: false });
    expect(body.runningTurns).toEqual([{ kind: 'chat', id: 'c1', busy: true }]);
    expect(body.refusal).toBeNull();
    expect(provider.calls).toEqual([]); // no create, no start
    expect(readTripState(home).phase).toBe('home');

    const noVault = res();
    await handleHandsfreePreflight(req({ url: '/api/handsfree/preflight' }), noVault, {}, null);
    expect(noVault.status).toBe(400);
    const tailnet = res();
    await handleHandsfreePreflight(req({ url: '/api/handsfree/preflight', remote: '100.64.0.2' }), tailnet, {}, ctx);
    expect(tailnet.status).toBe(403);
  });

  it('preflight: a provider that throws synchronously (not signed in to GitHub) is a warning, never a 500', async () => {
    const provider = new FakeCloudProvider({ url: 'http://127.0.0.1:9' });
    const boom = () => { throw new Error('hands-free mode is not signed in to GitHub'); };
    Object.assign(provider, { get: boom, machineTypes: boom, remainingQuotaCoreMinutes: boom });
    setHandsfreeEnvForTests(envWith({ provider }));
    const r = res();
    await handleHandsfreePreflight(req({ url: '/api/handsfree/preflight' }), r, {}, ctx);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ refusal: null, machine: { freeBytes: null, quotaSource: 'laptop' } });
    expect((r.body as { warnings: string[] }).warnings.join(' ')).toMatch(/not signed in/);
  });

  it('preflight refuses when the trip does not fit the disk (names a bigger machine) and when not set up', async () => {
    const provider = new FakeCloudProvider({ url: 'http://127.0.0.1:9', types: [
      { name: 'basicLinux32gb', cpus: 2, storageBytes: 21 * 2 ** 30 + 100 },
      { name: 'premiumLinux', cpus: 8, storageBytes: 64 * 2 ** 30 },
    ] });
    setHandsfreeEnvForTests(envWith({ provider }));
    const r = res();
    await handleHandsfreePreflight(req({ url: '/api/handsfree/preflight' }), r, {}, ctx);
    expect(r.body).toMatchObject({ refusal: { code: 'disk', detail: { biggerMachine: 'premiumLinux' } } });

    await updateConfig(home, (c) => { const { codespace: _gone, ...rest } = c; return rest as typeof c; });
    const r2 = res();
    await handleHandsfreePreflight(req({ url: '/api/handsfree/preflight' }), r2, {}, ctx);
    expect(r2.body).toMatchObject({ refusal: { code: 'not_setup' }, machine: null });
  });

  it('jobs/current/cut: 409 not_waiting with no waiting job; a go waiting on a running turn cuts it once asked', async () => {
    const idle = res();
    await handleHandsfreeCut(req({ method: 'POST', url: '/api/handsfree/jobs/current/cut' }), idle);
    expect(idle.status).toBe(409);
    expect(idle.body).toMatchObject({ error: 'not_waiting' });

    const cuts: boolean[] = [];
    let busy = true;
    const turns: TurnControl = {
      list: async () => (busy ? [{ kind: 'chat', id: 'c1', busy: true }] : []),
      cut: async (_r, o) => { cuts.push(o.all); if (o.all) busy = false; return o.all ? 1 : 0; },
    };
    setHandsfreeEnvForTests(envWith({ turns }));
    const goReq = req({ method: 'POST', url: '/api/handsfree/go' });
    setImmediate(() => { goReq.push('{}'); goReq.push(null); });
    const started = res();
    await handleHandsfreeGo(goReq, started, {}, ctx);
    expect(started.status).toBe(202);
    const deadline = Date.now() + 10_000;
    while (currentHandsfreeJob()?.step !== 'waiting' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(currentHandsfreeJob()).toMatchObject({ kind: 'go', status: 'running', step: 'waiting', running: [{ id: 'c1' }] });
    expect(cuts).toEqual([]);

    const cut = res();
    await handleHandsfreeCut(req({ method: 'POST', url: '/api/handsfree/jobs/current/cut' }), cut);
    expect(cut.status).toBe(200);
    while (currentHandsfreeJob()?.status === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(cuts).toContain(true);
    // Past the cut the go needs the (absent) cloud: it fails and unlocks, home again.
    expect(currentHandsfreeJob()?.status).toBe('error');
    expect(readTripState(home).phase).toBe('home');

    const after = res();
    await handleHandsfreeCut(req({ method: 'POST', url: '/api/handsfree/jobs/current/cut' }), after);
    expect(after.status).toBe(409);
  });
});

describe('r14: status says whether the WINDOW\'s project is in the trip (AC6: the lock banner is per project)', () => {
  let home: string;
  let trip: string;
  let other: string;
  const TRIP = 't-20261006-aaaaaaaa';
  beforeEach(async () => {
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'hf-routes-here-')));
    trip = join(home, 'projects', 'hf-smoke');
    other = join(home, 'projects', 'dreamcontext');
    for (const v of [trip, other]) mkdirSync(join(v, '_dream_context'), { recursive: true });
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'HF Smoke', path: trip }, { name: 'dreamcontext', path: other }] }));
    const provider = new FakeCloudProvider({ url: 'http://x' });
    setHandsfreeEnvForTests(() => ({
      home, run: async () => ({ code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }), provider, repo: provider,
      connect: () => { throw new Error('no cloud'); }, turns: NO_TURNS, roster: { read: () => ({ sessions: [], chatPermissionMode: 'auto', generation: 0 }), write: () => 1 },
      templateFiles: () => ({}), localVersion: () => '0.30.0', registryFetch: (async () => { throw new Error('no npm'); }) as unknown as typeof fetch,
    }) as HandsfreeEnv);
    await beginGoing(TRIP, [{ rootId: 'r-08890df73f7e84e6', path: trip }], home);
    await setPhase('away', TRIP, home);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const statusFor = async (vault: string | null, vaultRoot: string | null) => {
    const r = res();
    await handleHandsfreeStatus(req({ headers: vault ? { 'x-dreamcontext-vault': vault } : {} }), r, {}, vaultRoot);
    expect(r.status).toBe(200);
    return r.body as { phase: string; here: { vault: string | null; inTrip: boolean; rootId?: string }; away: { name: string; path: string } | null };
  };

  it('the trip\'s project: inTrip with its root id; the away project is named by its registry name', async () => {
    const b = await statusFor('HF Smoke', join(trip, '_dream_context'));
    expect(b.phase).toBe('away');
    expect(b.here).toEqual({ vault: 'HF Smoke', inTrip: true, rootId: 'r-08890df73f7e84e6' });
    expect(b.away).toEqual({ name: 'HF Smoke', path: trip });
  });

  it('another project: not in the trip (the smoke #4 defect: dreamcontext showed the lock banner)', async () => {
    const b = await statusFor('dreamcontext', join(other, '_dream_context'));
    expect(b.here).toEqual({ vault: 'dreamcontext', inTrip: false });
    expect(b.away?.name).toBe('HF Smoke');
  });

  it('no vault named (the launcher, or the server\'s pinned root only): not in the trip; folder name when unregistered', async () => {
    const b = await statusFor(null, join(trip, '_dream_context'));
    expect(b.here).toEqual({ vault: null, inTrip: false });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [] }));
    expect((await statusFor(null, null)).away).toEqual({ name: 'hf-smoke', path: trip });
  });
});

