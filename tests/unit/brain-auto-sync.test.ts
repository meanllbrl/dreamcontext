import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgram } from '../../src/cli/program.js';
import {
  __resetBrainAutoSync,
  AUTO_SYNC_ARGS,
  AUTO_SYNC_AFTER_MS,
  classifyOutcome,
  FAILED_RETRY_MS,
  parseOutcome,
  runBrainAutoSync,
  type AutoSyncOutcome,
  type BrainAutoSyncDeps,
} from '../../src/lib/brain-auto-sync.js';
import { readBrainLocal, writeBrainLocal } from '../../src/lib/setup-config.js';
import { listInboxRows } from '../../src/lib/owner-inbox.js';
import { brainAutoSyncDisabledReason, startBrainAutoSyncJob } from '../../src/server/brain-auto-sync-job.js';
import type { Vault } from '../../src/lib/vaults.js';

const H = 60 * 60_000;
const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);

let home: string;
let clock: number;
let root: string;
let outcome: AutoSyncOutcome;
const runSync = vi.fn(async (path: string) => {
  // The real `brain sync` stamps the engine's record when it lands.
  if (outcome.action === 'pushed' || (outcome.action === 'noop' && !outcome.note)) writeBrainLocal(path, { lastFullSyncAt: clock });
  return outcome;
});

function project(name: string): string {
  const path = join(home, name);
  mkdirSync(join(path, '_dream_context', 'state'), { recursive: true });
  return path;
}

const deps = (extra: BrainAutoSyncDeps = {}): BrainAutoSyncDeps => ({
  home,
  now: () => clock,
  vaults: () => [{ name: 'alpha', path: root } as Vault],
  eligible: () => true,
  busy: () => null,
  hasLocalChanges: () => true,
  runSync,
  ...extra,
});

const rows = () => listInboxRows(root, home, new Date(clock)).filter((r) => r.kind === 'brain-sync-paused');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'brain-auto-sync-'));
  root = project('alpha');
  clock = T0;
  outcome = { action: 'pushed', note: null };
  runSync.mockClear();
  __resetBrainAutoSync();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('runBrainAutoSync: the 24-hour rule', () => {
  it('23 hours since the last full sync: nothing runs', async () => {
    writeBrainLocal(root, { lastFullSyncAt: T0 - 23 * H });
    const r = await runBrainAutoSync(deps());
    expect(runSync).not.toHaveBeenCalled();
    expect(r.synced).toEqual([]);
  });

  it('25 hours: the full sync runs and its time is recorded', async () => {
    writeBrainLocal(root, { lastFullSyncAt: T0 - 25 * H });
    const r = await runBrainAutoSync(deps());
    expect(runSync).toHaveBeenCalledTimes(1);
    expect(r.synced).toEqual(['alpha']);
    expect(readBrainLocal(root).lastFullSyncAt).toBe(T0);
    // The next check, ten minutes on, has nothing to do.
    clock += 10 * 60_000;
    await runBrainAutoSync(deps());
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('never synced on this machine: it is due', async () => {
    await runBrainAutoSync(deps());
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('a busy project waits for the next check, then runs once it is free', async () => {
    writeBrainLocal(root, { lastFullSyncAt: T0 - 25 * H });
    let busy: string | null = 'an agent session is working';
    const r = await runBrainAutoSync(deps({ busy: () => busy }));
    expect(runSync).not.toHaveBeenCalled();
    expect(r.waiting).toEqual(['alpha']);
    busy = null;
    clock += 10 * 60_000;
    await runBrainAutoSync(deps({ busy: () => busy }));
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('due but nothing to send: skipped quietly, and it runs once a change appears', async () => {
    writeBrainLocal(root, { lastFullSyncAt: T0 - 30 * H });
    let changed = false;
    const r = await runBrainAutoSync(deps({ hasLocalChanges: () => changed }));
    expect(runSync).not.toHaveBeenCalled();
    expect(r).toEqual({ synced: [], waiting: [], paused: [] });
    expect(rows()).toEqual([]);
    changed = true;
    clock += 10 * 60_000;
    await runBrainAutoSync(deps({ hasLocalChanges: () => changed }));
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('a project without cloud sync, full-repo and autoSync is never touched', async () => {
    await runBrainAutoSync(deps({ eligible: () => false }));
    expect(runSync).not.toHaveBeenCalled();
  });
});

describe('runBrainAutoSync: a stop only the owner settles', () => {
  it('a prose conflict: told once, never retried in a loop, closed by the sync that lands', async () => {
    writeBrainLocal(root, { lastFullSyncAt: T0 - 25 * H });
    outcome = { action: 'awaiting-agent', note: null };
    const r = await runBrainAutoSync(deps());
    expect(r.paused).toEqual(['alpha']);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].title).toContain('/dream-sync');
    const id = rows()[0].id;

    // Every check in the next day leaves it alone.
    for (let i = 0; i < 6; i++) {
      clock += 3 * H;
      await runBrainAutoSync(deps());
    }
    expect(runSync).toHaveBeenCalledTimes(1);

    // A day on, one more try: the same stop is not told again.
    clock = T0 + 24 * H + 60_000;
    outcome = { action: 'already-awaiting-agent', note: null };
    await runBrainAutoSync(deps());
    expect(runSync).toHaveBeenCalledTimes(2);
    expect(rows().map((x) => x.id)).toEqual([id]);

    // His /dream-sync lands (any sync stamps the record): the row closes on the next check.
    clock += H;
    writeBrainLocal(root, { lastFullSyncAt: clock });
    await runBrainAutoSync(deps());
    expect(rows()).toEqual([]);
  });

  it('a scrub block is told with its own line and not forced', async () => {
    writeBrainLocal(root, { lastFullSyncAt: T0 - 25 * H });
    outcome = { action: 'blocked-scrub', note: null };
    await runBrainAutoSync(deps());
    expect(rows()[0].title).toContain('key or password');
    expect(JSON.parse(rows()[0].detail ?? '{}').reason).toBe('scrub');
    // The row is not a one-day info row: it is still there two days on.
    clock += 47 * H;
    expect(rows()).toHaveLength(1);
  });

  it('a failure waits an hour, not a day; a later success closes its row', async () => {
    writeBrainLocal(root, { lastFullSyncAt: T0 - 25 * H });
    outcome = { action: 'error', note: 'network down' };
    await runBrainAutoSync(deps());
    clock += FAILED_RETRY_MS - 60_000;
    await runBrainAutoSync(deps());
    expect(runSync).toHaveBeenCalledTimes(1);
    clock += 2 * 60_000;
    outcome = { action: 'pushed', note: null };
    const r = await runBrainAutoSync(deps());
    expect(runSync).toHaveBeenCalledTimes(2);
    expect(r.synced).toEqual(['alpha']);
    expect(rows()).toEqual([]);
  });

  it('a project that stops qualifying (cloud sync off) drops its row', async () => {
    writeBrainLocal(root, { lastFullSyncAt: T0 - 25 * H });
    outcome = { action: 'blocked-scrub', note: null };
    await runBrainAutoSync(deps());
    expect(rows()).toHaveLength(1);
    clock += H;
    await runBrainAutoSync(deps({ eligible: () => false }));
    expect(rows()).toEqual([]);
  });

  it('a locked brain (another sync running) is neither a pause nor a row', async () => {
    writeBrainLocal(root, { lastFullSyncAt: T0 - 25 * H });
    outcome = { action: 'locked', note: null };
    await runBrainAutoSync(deps());
    expect(rows()).toEqual([]);
    clock += 10 * 60_000;
    await runBrainAutoSync(deps());
    expect(runSync).toHaveBeenCalledTimes(2);
  });

  it('one project throwing never stops the next', async () => {
    const beta = project('beta');
    const r = await runBrainAutoSync(deps({
      vaults: () => [{ name: 'alpha', path: root } as Vault, { name: 'beta', path: beta } as Vault],
      runSync: async (p) => { if (p === root) throw new Error('boom'); return runSync(p); },
    }));
    expect(r.synced).toEqual(['beta']);
  });
});

describe('outcome reading', () => {
  it('classifies every sync word', () => {
    expect(classifyOutcome({ action: 'pushed', note: null })).toBe('synced');
    expect(classifyOutcome({ action: 'noop', note: null })).toBe('synced');
    expect(classifyOutcome({ action: 'noop', note: 'Skipped the pull' })).toBe('failed');
    expect(classifyOutcome({ action: 'code-conflict', note: null })).toBe('code-conflict');
    expect(classifyOutcome({ action: 'session-files-held', note: 'x' })).toBe('held');
    expect(classifyOutcome({ action: 'disabled', note: null })).toBe('again');
    expect(classifyOutcome({ action: 'error', note: 'Push refused by GitHub: x is over 100 MB' })).toBe('held');
    expect(classifyOutcome({ action: 'error', note: 'Push rejected (non-fast-forward) twice — x' })).toBe('held');
    expect(classifyOutcome({ action: 'error', note: 'network down' })).toBe('failed');
  });

  it('parses the last JSON line and ignores the rest', () => {
    expect(parseOutcome('progress\n{"action":"pushed","note":null}\n')).toEqual({ action: 'pushed', note: null });
    expect(parseOutcome('no json here')).toBeNull();
  });
});

describe('the command the job runs', () => {
  it('is a real `brain sync` and every flag is one it accepts', () => {
    const brain = createProgram().commands.find((c) => c.name() === AUTO_SYNC_ARGS[0]);
    const sync = brain?.commands.find((c) => c.name() === AUTO_SYNC_ARGS[1]);
    expect(sync).toBeTruthy();
    const longs = new Set(sync!.options.map((o) => o.long));
    for (const flag of AUTO_SYNC_ARGS.slice(2)) expect(longs.has(flag), flag).toBe(true);
  });
});

describe('the job gate', () => {
  const app = { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_PARENT_PID: '42', DREAMCONTEXT_CLI: '/x/cli.js' };
  it('runs only in the app-owned desktop server, and DREAMCONTEXT_BRAIN_SYNC=0 turns it off', () => {
    expect(brainAutoSyncDisabledReason({ ...app }, 42)).toBeNull();
    expect(brainAutoSyncDisabledReason({ ...app, DREAMCONTEXT_BRAIN_SYNC: '0' }, 42)).toBe('DREAMCONTEXT_BRAIN_SYNC=0');
    expect(brainAutoSyncDisabledReason({ ...app }, 7)).toBe('not the app-owned server');
    expect(brainAutoSyncDisabledReason({ DREAMCONTEXT_CLI: '/x/cli.js' }, 42)).toBe('not the desktop app');
    expect(brainAutoSyncDisabledReason({ ...app, VITEST: 'true' }, 42)).toBe('test run');
  });

  it('a gated-off server starts nothing', () => {
    expect(startBrainAutoSyncJob({ env: { VITEST: 'true' } })).toBeUndefined();
  });
});
