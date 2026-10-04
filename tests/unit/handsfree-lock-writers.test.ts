/**
 * Hands-free lock, background writers and the warnings (AC6, AC18): the automations tick,
 * brain sync and task-backend sync skip a locked root; `hook session-start` warns a
 * terminal-launched claude; `dreamcontext upgrade` and the app's upgrade badge refuse while
 * the laptop is not home. Trip state lives in a temp HOME, never the real ~/.dreamcontext.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beginGoing, setPhase } from '../../src/lib/handsfree/trip-state.js';
import { tickProject } from '../../src/lib/automations/tick.js';
import { enqueueFire, queuedFire } from '../../src/lib/automations/queue.js';
import { runBrainSync, type SyncEngineDeps } from '../../src/lib/git-sync/sync-engine.js';
import { taskSyncHandsfreeSkip } from '../../src/cli/commands/tasks.js';
import { handsfreeSessionStartWarning } from '../../src/cli/commands/hook.js';
import { runUpgrade } from '../../src/cli/commands/upgrade.js';
import { handleVersionCheckGet } from '../../src/server/routes/version-check.js';
import type { NotifierState } from '../../src/lib/automations/notifier.js';
import { autoUpdateHandsfreeBlock } from '../../src/cli/commands/app.js';
import { handleLauncherUpgrade } from '../../src/server/routes/launcher.js';

let scratch: string;
let home: string;
let locked: string;
let free: string;

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'hf-lock-w-'));
  home = join(scratch, 'home');
  locked = join(scratch, 'locked');
  free = join(scratch, 'free');
  for (const d of [home, join(locked, '_dream_context', 'state'), join(free, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
  await beginGoing('trip-9', [{ rootId: 'r0', path: locked }], home);
  await setPhase('away', 'trip-9', home);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('automations tickProject', () => {
  it('skips a locked project before the drain: nothing runs, a queued fire stays owed, one log line', async () => {
    const at = new Date('2026-10-04T08:00:00Z');
    enqueueFire(locked, 'digest', at.toISOString(), home, at.getTime());
    const logs: string[] = [];
    let ran = 0;
    const r = await tickProject(locked, { home, now: at, log: (l) => logs.push(l), runImpl: (async () => { ran++; throw new Error('must not run'); }) as never });
    expect(r).toMatchObject({ skipped: 'handsfree', considered: 0, ran: [], verdicts: [] });
    expect(ran).toBe(0);
    expect(queuedFire(locked, 'digest', home)).not.toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/hands-free mode \(trip trip-9\)/);
  });

  it('ticks an unlocked project as before', async () => {
    const r = await tickProject(free, { home, now: new Date() });
    expect(r.skipped).toBeUndefined();
  });
});

describe('runBrainSync', () => {
  function gitSpy(calls: string[]): SyncEngineDeps['git'] {
    return new Proxy({}, { get: (_t, name) => () => { calls.push(String(name)); return false; } }) as SyncEngineDeps['git'];
  }

  it('skips a locked project without touching git, reported like disabled', async () => {
    const calls: string[] = [];
    const r = await runBrainSync({ cwd: join(locked, '_dream_context'), mode: 'auto' }, { git: gitSpy(calls), home });
    expect(calls).toEqual([]);
    expect(r.action).toBe('disabled');
    expect(r.note).toMatch(/hands-free mode .*trip trip-9/);
  });

  it('proceeds outside it', async () => {
    const calls: string[] = [];
    const r = await runBrainSync({ cwd: join(free, '_dream_context'), mode: 'auto' }, { git: gitSpy(calls), home });
    expect(r.note ?? '').not.toMatch(/hands-free/);
  });
});

describe('task-backend sync', () => {
  it('names the trip for a locked project and is null outside', () => {
    expect(taskSyncHandsfreeSkip(join(locked, '_dream_context'), home)).toMatch(/Task sync skipped: .*trip trip-9/);
    expect(taskSyncHandsfreeSkip(join(free, '_dream_context'), home)).toBeNull();
  });
});

describe('hook session-start warning', () => {
  it('warns a claude started inside a locked root (a nested cwd too), silent elsewhere', () => {
    const w = handsfreeSessionStartWarning(join(locked, '_dream_context'), home);
    expect(w).toMatch(/HANDS-FREE MODE: this project is on the cloud machine \(trip trip-9, away\)/);
    expect(w).toMatch(/dreamcontext handsfree return/);
    expect(handsfreeSessionStartWarning(free, home)).toBeNull();
  });
});

describe('dreamcontext upgrade', () => {
  const noNotifier = (): NotifierState => ({ supported: false } as NotifierState);
  const realExit = process.exitCode;
  afterEach(() => { process.exitCode = realExit; });

  it('refuses while away and says why; installs nothing', async () => {
    const installs: string[][] = [];
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      await runUpgrade(false, { home, installer: (a) => installs.push(a), appInstalledCheck: () => false, vaultLister: () => [], notifierState: noNotifier });
    } finally {
      console.log = realLog;
    }
    expect(installs).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(lines.join('\n')).toMatch(/Upgrade refused: hands-free mode is away \(trip trip-9\)/);
  });

  it('installs once the laptop is home', async () => {
    await setPhase('home', 'trip-9', home);
    const installs: string[][] = [];
    const realLog = console.log;
    console.log = () => {};
    try {
      await runUpgrade(false, { home, installer: (a) => installs.push(a), appInstalledCheck: () => false, vaultLister: () => [], notifierState: noNotifier });
    } finally {
      console.log = realLog;
    }
    expect(installs).toEqual([['install', '-g', 'dreamcontext@latest']]);
  });

  it('still answers --check while away (it installs nothing)', async () => {
    const realLog = console.log;
    console.log = () => {};
    try {
      await runUpgrade(true, { home, latestVersion: () => null });
    } finally {
      console.log = realLog;
    }
    expect(process.exitCode).toBe(realExit);
  });
});

describe('GET /api/version-check (the app badge)', () => {
  function call(contextRoot: string, h: string): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    const res = {
      writeHead() {}, setHeader() {},
      end(d: string) { body = JSON.parse(d); },
    } as unknown as ServerResponse;
    return handleVersionCheckGet({ method: 'GET', headers: {} } as IncomingMessage, res, {}, contextRoot, h).then(() => body);
  }

  beforeEach(() => {
    writeFileSync(join(free, '_dream_context', 'state', '.version-check.json'), JSON.stringify({
      checkedAt: Date.now(), latestCli: '99.99.99', availablePacks: [], ttlHours: 24,
    }));
  });

  it('offers no upgrade while away and says why', async () => {
    const b = await call(join(free, '_dream_context'), home);
    expect(b.cliOutdated).toBe(false);
    expect(String(b.upgradeBlocked)).toMatch(/Hands-free mode is away \(trip trip-9\)/);
    expect(String(b.nudge ?? '')).not.toContain('99.99.99');
  });

  it('offers it again at home', async () => {
    await setPhase('home', 'trip-9', home);
    const b = await call(join(free, '_dream_context'), home);
    expect(b.cliOutdated).toBe(true);
    expect(b.upgradeBlocked).toBeUndefined();
  });
});

describe('auto-update (prompt hook tick, `app update`)', () => {
  it('is blocked with one line while away, and free at home', async () => {
    expect(autoUpdateHandsfreeBlock(home)).toMatch(/auto-update skipped: hands-free mode is away \(trip trip-9\)/);
    await setPhase('home', 'trip-9', home);
    expect(autoUpdateHandsfreeBlock(home)).toBeNull();
  });
});

describe('POST /api/launcher/upgrade', () => {
  it('refuses while away with the reason, starting nothing', async () => {
    let code = 0;
    let body: Record<string, unknown> = {};
    const res = {
      writeHead(c: number) { code = c; }, setHeader() {},
      end(d: string) { body = JSON.parse(d); },
    } as unknown as ServerResponse;
    await handleLauncherUpgrade({ method: 'POST', headers: {} } as IncomingMessage, res, {}, null, home);
    expect(code).toBe(409);
    expect(JSON.stringify(body)).toMatch(/handsfree_away/);
    expect(JSON.stringify(body)).toMatch(/hands-free mode is away \(trip trip-9\)/);
  });
});
