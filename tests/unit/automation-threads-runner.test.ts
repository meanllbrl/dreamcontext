import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { buildPreamble, runAutomation, type SpawnImpl } from '../../src/lib/automations/runner.js';
import { createAutomation, writeRunSidecar } from '../../src/lib/automations/store.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { readThread } from '../../src/lib/automations/threads.js';
import { writeSleepState } from '../../src/cli/commands/sleep.js';
import type { SleepState } from '../../src/lib/sleep-consolidation.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

/**
 * The runner's half of an agent's channel: which fires open a thread, which
 * stay silent, and the rule that a thread write can never change what a run
 * reports.
 *
 * The silence cases matter more than the noisy ones. A `blocked`/`deferred`/
 * `orphaned` short-circuit happens on EVERY dispatcher tick for as long as the
 * condition holds — a thread entry there would post every five minutes forever,
 * which is the failure mode `params.notify` already exists to prevent for
 * banners.
 */

function makeFakeChild(pid: number | undefined): {
  child: EventEmitter & { pid: number | undefined; stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  emitClose: (code: number | null) => void;
  emitStdout: (data: string) => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { pid, stdout, stderr, kill: () => {} });
  return {
    child,
    emitClose: (code) => child.emit('close', code),
    emitStdout: (data) => stdout.emit('data', Buffer.from(data, 'utf-8')),
  };
}

const CLAUDE_JSON_OK = JSON.stringify({
  session_id: 'sess_thread1',
  result: '# Digest\n\nWAU is down 4%.\n',
  is_error: false,
  permission_denials: [],
  total_cost_usd: 0.02,
  num_turns: 3,
  duration_ms: 5400,
  subtype: 'success',
});

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = new Date('2026-09-20T18:00:00.000Z');

function makeSpawnImpl(child: EventEmitter): SpawnImpl {
  return vi.fn(() => child) as unknown as SpawnImpl;
}

function createApproved(slug: string, overrides?: Partial<Parameters<typeof createAutomation>[1]>): AutomationManifest {
  const manifest = createAutomation(contextRoot, {
    slug, title: `Test — ${slug}`, days: 'daily', at: '18:00', prompt: 'Say hello.', ...overrides,
  });
  approveAutomation(projectRoot, manifest, NOW, home);
  return manifest;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-threads-runner-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-threads-runner-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('a scheduled run opens and closes exactly one thread', () => {
  it('appends exactly one system:started and exactly one system:ok, both bound to the fire time', async () => {
    const manifest = createApproved('digest-ok');
    const { child, emitClose, emitStdout } = makeFakeChild(4242);
    const run = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), killImpl: vi.fn(), notify: () => {},
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    const outcome = await run;
    expect(outcome.status).toBe('ok');

    const entries = readThread(contextRoot, manifest.slug);
    expect(entries.map((e) => e.event)).toEqual(['started', 'ok']);
    // `runId` IS the fire time — there is no other run identity in this
    // codebase, and the feed groups on it.
    expect(new Set(entries.map((e) => e.runId))).toEqual(new Set([NOW.toISOString()]));
    expect(entries.every((e) => e.kind === 'system' && e.via === 'runner')).toBe(true);
    // `started` must sort before `ok` even though both land in the same run —
    // the id, not the clock, is what orders them.
    expect(entries[0].id < entries[1].id).toBe(true);
  });

  it('a failing run closes with system:failed carrying the reason, not with ok', async () => {
    const manifest = createApproved('digest-fails');
    const { child, emitClose } = makeFakeChild(4243);
    const run = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), killImpl: vi.fn(), notify: () => {},
    });
    emitClose(1);
    const outcome = await run;
    expect(outcome.status).toBe('failed');

    const entries = readThread(contextRoot, manifest.slug);
    expect(entries.map((e) => e.event)).toEqual(['started', 'failed']);
    expect(entries[1].text).toMatch(/^Failed after /);
  });

  it('an is_error run leads with its result\'s opening line, never "claude reported is_error"', async () => {
    const manifest = createApproved('digest-is-error');
    const { child, emitClose, emitStdout } = makeFakeChild(4246);
    const run = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), killImpl: vi.fn(), notify: () => {},
    });
    emitStdout(JSON.stringify({
      session_id: 'sess_err', result: 'Could not reach the analytics API: 401 Unauthorized.\n',
      is_error: true, permission_denials: [], total_cost_usd: 0.01, num_turns: 1, duration_ms: 900, subtype: 'success',
    }));
    emitClose(0);
    const outcome = await run;
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('401 Unauthorized');

    const failed = readThread(contextRoot, manifest.slug).find((e) => e.event === 'failed');
    expect(failed?.text).toMatch(/^Failed after .*: Could not reach the analytics API: 401 Unauthorized\./);
    expect(failed?.text).not.toContain('is_error');
    expect(failed?.text).not.toContain('—');
  });
});

describe('a fire that never ran writes NOTHING', () => {
  it('unapproved ⇒ blocked ⇒ empty channel', async () => {
    const manifest = createAutomation(contextRoot, {
      slug: 'never-approved', title: 'Never approved', days: 'daily', at: '18:00',
    });
    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: vi.fn() as unknown as SpawnImpl, notify: () => {},
    });
    expect(outcome.status).toBe('blocked');
    expect(readThread(contextRoot, manifest.slug)).toEqual([]);
  });

  it('deferred under a sleep lock ⇒ empty channel (this repeats every tick)', async () => {
    const manifest = createApproved('sleep-deferred');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeSleepState(contextRoot, {
      debt: 0, last_sleep: null, last_sleep_summary: null,
      sleep_started_at: NOW.toISOString(), sessions_since_last_sleep: 0,
      sessions: [], bookmarks: [], triggers: [], knowledge_access: {},
      dashboard_changes: [], compaction_log: [], recall_mode: 'haiku',
    } as unknown as SleepState);

    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: vi.fn() as unknown as SpawnImpl, notify: () => {},
    });
    expect(outcome.status).toBe('deferred');
    expect(readThread(contextRoot, manifest.slug)).toEqual([]);
  });

  it('orphaned ⇒ empty channel', async () => {
    const manifest = createApproved('has-orphan');
    writeRunSidecar(contextRoot, manifest.slug, {
      slug: manifest.slug, runnerPid: 999999, childPid: process.pid, childPgid: process.pid,
      fireAt: NOW.toISOString(), startedAt: NOW.toISOString(), timeoutAt: NOW.toISOString(),
    });
    const killImpl = vi.fn((pid: number) => {
      if (pid === 999999) { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; }
    });
    const outcome = await runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: vi.fn() as unknown as SpawnImpl, killImpl, notify: () => {},
    });
    expect(outcome.status).toBe('orphaned');
    expect(readThread(contextRoot, manifest.slug)).toEqual([]);
  });
});

describe('the run carries its own identity into the child', () => {
  it('spawns with DREAMCONTEXT_AUTOMATION_SLUG and _RUN so a post needs no ids', async () => {
    const manifest = createApproved('env-bound');
    const { child, emitClose, emitStdout } = makeFakeChild(4244);
    const spawnFn = vi.fn(() => child) as unknown as SpawnImpl;
    const run = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: spawnFn, killImpl: vi.fn(), notify: () => {},
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    await run;

    const opts = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.DREAMCONTEXT_AUTOMATION_SLUG).toBe(manifest.slug);
    expect(opts.env.DREAMCONTEXT_AUTOMATION_RUN).toBe(NOW.toISOString());
  });

  it('the preamble names the post verb with this automation\'s own slug, and says when NOT to post', () => {
    const manifest = createApproved('preamble-check');
    const preamble = buildPreamble(manifest, projectRoot, NOW, '/tmp/out.md');
    expect(preamble).toContain('dreamcontext automations post preamble-check');
    // The floor is the load-bearing half: without it a run narrates itself and
    // the channel becomes the transcript it exists to spare the reader.
    expect(preamble).toContain('Zero posts is the right number');
  });
});

describe('a thread write never changes a run\'s disposition', () => {
  it('an unwritable threads directory leaves the run ok and the cache intact', async () => {
    const manifest = createApproved('thread-blocked');
    // A FILE where the threads directory must go: every append for this slug
    // now throws ENOTDIR inside the store.
    mkdirSync(join(contextRoot, 'automations'), { recursive: true });
    writeFileSync(join(contextRoot, 'automations', 'threads'), 'not a directory\n', 'utf-8');

    const { child, emitClose, emitStdout } = makeFakeChild(4245);
    const run = runAutomation(contextRoot, manifest.slug, {
      now: () => NOW, home, spawnImpl: makeSpawnImpl(child), killImpl: vi.fn(), notify: () => {}, log: () => {},
    });
    emitStdout(CLAUDE_JSON_OK);
    emitClose(0);
    const outcome = await run;

    expect(outcome.status).toBe('ok');
    expect(outcome.cache?.status).toBe('ok');
    expect(readThread(contextRoot, manifest.slug)).toEqual([]);
  });
});
