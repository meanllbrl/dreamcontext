import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runAutoSleep, cancelAutoSleep, writeAutoSleepSidecar, recordAutoSleepChangelog,
  AUTO_SLEEP_DISALLOWED_TOOLS, AUTO_SLEEP_TIMEOUT_MS,
} from '../../src/lib/auto-sleep-runner.js';
import { readAutoSleepSidecar } from '../../src/lib/auto-sleep.js';
import {
  getConsolidationDirective, userPromptReminder, autoSleepNagLine,
} from '../../src/cli/commands/hook.js';
import type { SleepState } from '../../src/lib/sleep-consolidation.js';

/**
 * C2/C4. The runner is where an unattended `bypassPermissions` process gets
 * spawned, so what it passes and what it records are the whole safety story;
 * and the nag silence is the user-visible point of the feature.
 */

let project = '';
let ctx = '';

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-runner-'));
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  mkdirSync(join(ctx, 'core'), { recursive: true });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function fakeExec(over: Record<string, unknown> = {}) {
  const calls: { args: string[]; opts: any }[] = [];
  const impl = (async (args: string[], opts: any) => {
    calls.push({ args, opts });
    opts.onSpawned?.({ pid: process.pid } as any, new Date());
    return {
      spawned: true, timedOut: false, exitCode: 0, stdout: '', stderrTail: '',
      startedAt: new Date(), finishedAt: new Date(),
      result: { raw: '', parsed: true, result: 'Consolidated 3 tasks.', isError: false, sessionId: 'sess-1', costUsd: null, numTurns: 4, durationMs: 10, permissionDenials: 0, subtype: null },
      ...over,
    };
  }) as any;
  return { impl, calls };
}

describe('runAutoSleep — what it actually spawns', () => {
  it('passes -p, bypassPermissions, json output and the tool budget', async () => {
    const { impl, calls } = fakeExec();
    await runAutoSleep(ctx, { execImpl: impl, notifyImpl: () => {} });
    const { args, opts } = calls[0];
    expect(args[0]).toBe('-p');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(AUTO_SLEEP_DISALLOWED_TOOLS);
    expect(opts.timeoutMs).toBe(AUTO_SLEEP_TIMEOUT_MS);
    expect(opts.cwd).toBe(project);
  });

  it('denies web and MCP but KEEPS the Agent tool — the fan-out is the flow', () => {
    expect(AUTO_SLEEP_DISALLOWED_TOOLS).toContain('WebFetch');
    expect(AUTO_SLEEP_DISALLOWED_TOOLS).toContain('WebSearch');
    expect(AUTO_SLEEP_DISALLOWED_TOOLS).toContain('mcp__*');
    expect(AUTO_SLEEP_DISALLOWED_TOOLS).not.toContain('Agent');
    expect(AUTO_SLEEP_DISALLOWED_TOOLS).not.toContain('Bash');
  });

  it('sets DREAMCONTEXT_AUTO_SLEEP=1 — the guard against chaining a second cycle', async () => {
    const { impl, calls } = fakeExec();
    await runAutoSleep(ctx, { execImpl: impl, notifyImpl: () => {} });
    expect(calls[0].opts.env).toMatchObject({ DREAMCONTEXT_AUTO_SLEEP: '1' });
  });

  it('carries the hands-off list into the prompt', async () => {
    writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({
      debt: 0, sessions: [{ session_id: 's', transcript_path: null, stopped_at: null,
        last_assistant_message: null, change_count: null, tool_count: null, score: 1,
        task_slugs: ['a-live-task'] }],
      bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [],
    }));
    const { impl, calls } = fakeExec();
    await runAutoSleep(ctx, { execImpl: impl, notifyImpl: () => {} });
    expect(calls[0].args[1]).toContain('a-live-task');
    expect(calls[0].args[1]).toContain('UNTRUSTED CONTENT');
  });

  it('writes the sidecar SYNCHRONOUSLY at spawn, before any await could lose it', async () => {
    let sidecarAtSpawn: unknown = null;
    const impl = (async (_args: string[], opts: any) => {
      opts.onSpawned?.({ pid: process.pid } as any, new Date());
      sidecarAtSpawn = readAutoSleepSidecar(ctx);
      return { spawned: true, timedOut: false, exitCode: 0, stdout: '', stderrTail: '', startedAt: new Date(), finishedAt: new Date(), result: { raw: '', parsed: true, result: 'ok', isError: false, sessionId: null, costUsd: null, numTurns: 1, durationMs: 1, permissionDenials: 0, subtype: null } };
    }) as any;
    await runAutoSleep(ctx, { execImpl: impl, notifyImpl: () => {} });
    expect(sidecarAtSpawn).toMatchObject({ pid: process.pid, status: 'running' });
  });

  it('closes the sidecar ok and notifies with the summary', async () => {
    const notes: string[] = [];
    const { impl } = fakeExec();
    const res = await runAutoSleep(ctx, { execImpl: impl, notifyImpl: (t, b) => notes.push(`${t}|${b}`) });
    expect(res).toMatchObject({ started: true, status: 'ok', sessionId: 'sess-1' });
    expect(readAutoSleepSidecar(ctx)).toMatchObject({ status: 'ok', summary: 'Consolidated 3 tasks.' });
    expect(notes[0]).toContain('Consolidated 3 tasks.');
  });

  it('records a FAILED run with the stderr tail, and says so', async () => {
    const { impl } = fakeExec({ exitCode: 1, stderrTail: 'boom: the specialist died', result: null });
    const notes: string[] = [];
    const res = await runAutoSleep(ctx, { execImpl: impl, notifyImpl: (t, b) => notes.push(`${t}|${b}`) });
    expect(res.status).toBe('failed');
    expect(readAutoSleepSidecar(ctx)).toMatchObject({ status: 'failed' });
    expect(readAutoSleepSidecar(ctx)?.error).toContain('boom');
    expect(notes[0]).toContain('Auto sleep failed');
  });

  it('records a TIMEOUT distinctly from a failure', async () => {
    const { impl } = fakeExec({ timedOut: true, exitCode: null, result: null });
    const res = await runAutoSleep(ctx, { execImpl: impl, notifyImpl: () => {} });
    expect(res.status).toBe('timeout');
    expect(readAutoSleepSidecar(ctx)).toMatchObject({ status: 'timeout' });
  });

  it('reports a spawn failure rather than pretending it started', async () => {
    const impl = (async () => ({ spawned: false, timedOut: false, exitCode: null, stdout: '', stderrTail: '', startedAt: new Date(), finishedAt: new Date(), result: null })) as any;
    writeAutoSleepSidecar(ctx, { pid: 1234, pgid: 1234, startedAt: new Date().toISOString(), status: 'running', epoch: null });
    const res = await runAutoSleep(ctx, { execImpl: impl, notifyImpl: () => {} });
    expect(res).toMatchObject({ started: false, status: 'failed' });
  });

  it('refuses to start a second run while the lock is held', async () => {
    let inner: any = null;
    const impl = (async (_a: string[], opts: any) => {
      opts.onSpawned?.({ pid: process.pid } as any, new Date());
      inner = await runAutoSleep(ctx, { execImpl: (async () => ({ spawned: true, timedOut: false, exitCode: 0, stdout: '', stderrTail: '', startedAt: new Date(), finishedAt: new Date(), result: null })) as any, notifyImpl: () => {} });
      return { spawned: true, timedOut: false, exitCode: 0, stdout: '', stderrTail: '', startedAt: new Date(), finishedAt: new Date(), result: { raw: '', parsed: true, result: 'ok', isError: false, sessionId: null, costUsd: null, numTurns: 1, durationMs: 1, permissionDenials: 0, subtype: null } };
    }) as any;
    await runAutoSleep(ctx, { execImpl: impl, notifyImpl: () => {} });
    expect(inner).toMatchObject({ started: false, status: 'refused' });
  });

  it('does not overwrite a CANCELLED sidecar with the dead process exit status', async () => {
    const impl = (async (_a: string[], opts: any) => {
      opts.onSpawned?.({ pid: process.pid } as any, new Date());
      // A human cancels mid-run.
      writeAutoSleepSidecar(ctx, { ...readAutoSleepSidecar(ctx)!, status: 'cancelled' });
      return { spawned: true, timedOut: false, exitCode: 143, stdout: '', stderrTail: 'killed', startedAt: new Date(), finishedAt: new Date(), result: null };
    }) as any;
    const res = await runAutoSleep(ctx, { execImpl: impl, notifyImpl: () => {} });
    expect(res.status).toBe('cancelled');
    expect(readAutoSleepSidecar(ctx)?.status).toBe('cancelled');
  });
});

describe('the changelog is keyed on the epoch the run OWNED, not the one at spawn', () => {
  /**
   * The bug a real cycle found: `runAutoSleep` read the epoch BEFORE spawning,
   * but the cycle stamps its own epoch via `sleep start` seconds LATER — so the
   * key was always null and the entry was silently never written. A real run on
   * a real brain closed `ok` with a full summary and left no changelog line.
   */
  it('writes the entry even though the epoch did not exist at spawn time', async () => {
    writeFileSync(join(ctx, 'core', 'CHANGELOG.json'), JSON.stringify([]));
    writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({ debt: 0, sessions: [], bookmarks: [] }));

    const impl = (async (_a: string[], opts: any) => {
      opts.onSpawned?.({ pid: process.pid } as any, new Date());
      // The cycle stamps its epoch AFTER we spawned — exactly like `sleep start`.
      writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({
        debt: 0, sessions: [], bookmarks: [], sleep_started_at: '2026-09-05T22:49:43.586Z',
      }));
      // Let one heartbeat observe it.
      await new Promise((r) => setTimeout(r, 60));
      return { spawned: true, timedOut: false, exitCode: 0, stdout: '', stderrTail: '', startedAt: new Date(), finishedAt: new Date(), result: { raw: '', parsed: true, result: 'consolidated', isError: false, sessionId: 's', costUsd: null, numTurns: 1, durationMs: 1, permissionDenials: 0, subtype: null } };
    }) as any;

    await runAutoSleep(ctx, { execImpl: impl, notifyImpl: () => {}, heartbeatMs: 20 });

    const entries = JSON.parse(readFileSync(join(ctx, 'core', 'CHANGELOG.json'), 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toContain('Auto sleep: consolidated');
    expect(entries[0].auto_sleep_epoch).toBe('2026-09-05T22:49:43.586Z');
    // …and the sidecar learned it too, so `sleep auto status` can show it.
    expect(readAutoSleepSidecar(ctx)?.epoch).toBe('2026-09-05T22:49:43.586Z');
  });

  it('still writes one when the cycle is too short for a heartbeat, keyed by startedAt', async () => {
    writeFileSync(join(ctx, 'core', 'CHANGELOG.json'), JSON.stringify([]));
    const { impl } = fakeExec();
    await runAutoSleep(ctx, { execImpl: impl, notifyImpl: () => {} });
    const entries = JSON.parse(readFileSync(join(ctx, 'core', 'CHANGELOG.json'), 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0].auto_sleep_epoch).toBe(readAutoSleepSidecar(ctx)?.startedAt);
  });
});

describe('the idempotent changelog close', () => {
  const write = (data: unknown) => writeFileSync(join(ctx, 'core', 'CHANGELOG.json'), JSON.stringify(data));

  it('appends one entry keyed by the epoch', () => {
    write([]);
    expect(recordAutoSleepChangelog(ctx, 'epoch-1', 'did things')).toBe(true);
    const entries = JSON.parse(readFileSync(join(ctx, 'core', 'CHANGELOG.json'), 'utf8'));
    expect(entries[0].summary).toContain('Auto sleep: did things');
    expect(entries[0].auto_sleep_epoch).toBe('epoch-1');
  });

  it('never appends TWICE for the same epoch', () => {
    write([]);
    recordAutoSleepChangelog(ctx, 'epoch-1', 'did things');
    expect(recordAutoSleepChangelog(ctx, 'epoch-1', 'did things again')).toBe(false);
    expect(JSON.parse(readFileSync(join(ctx, 'core', 'CHANGELOG.json'), 'utf8'))).toHaveLength(1);
  });

  it('does append for a DIFFERENT epoch', () => {
    write([]);
    recordAutoSleepChangelog(ctx, 'epoch-1', 'first');
    recordAutoSleepChangelog(ctx, 'epoch-2', 'second');
    expect(JSON.parse(readFileSync(join(ctx, 'core', 'CHANGELOG.json'), 'utf8'))).toHaveLength(2);
  });

  it('does nothing without an epoch, and never throws on a missing/corrupt file', () => {
    write([]);
    expect(recordAutoSleepChangelog(ctx, null, 'x')).toBe(false);
    writeFileSync(join(ctx, 'core', 'CHANGELOG.json'), '{not json');
    expect(() => recordAutoSleepChangelog(ctx, 'e', 'x')).not.toThrow();
  });
});

describe('cancelAutoSleep', () => {
  const running = (over = {}) => writeAutoSleepSidecar(ctx, {
    pid: process.pid, pgid: process.pid, startedAt: new Date().toISOString(), status: 'running', epoch: null, ...over,
  });

  it('reports nothing to cancel when no job was ever recorded', () => {
    expect(cancelAutoSleep(ctx)).toMatchObject({ found: false, killed: false });
  });

  it('refuses a job that already ended', () => {
    running({ status: 'ok' });
    expect(cancelAutoSleep(ctx).refusedReason).toContain('already ended');
  });

  it('REFUSES an implausible process group rather than signalling it', () => {
    running({ pgid: 1 });
    expect(cancelAutoSleep(ctx).refusedReason).toContain('refusing to kill');
  });

  it('REFUSES to kill the caller itself', () => {
    // pid alive (it is us) but the pgid names our own process.
    running({ pgid: process.pid, pid: process.pid });
    const res = cancelAutoSleep(ctx, { killImpl: () => {} });
    expect(res.refusedReason).toContain('matches the caller itself');
    expect(res.killed).toBe(false);
  });

  it('closes out a sidecar whose process is already gone', () => {
    running({ pid: 2 ** 30, pgid: 2 ** 30 });
    expect(cancelAutoSleep(ctx).refusedReason).toContain('already gone');
    expect(readAutoSleepSidecar(ctx)?.status).toBe('failed');
  });

  it('kills the GROUP (negative pgid) with SIGTERM then SIGKILL, and records cancelled', () => {
    running({ pid: process.pid, pgid: 999_999 });
    const signals: [number, unknown][] = [];
    const res = cancelAutoSleep(ctx, { killImpl: (pid, sig) => { signals.push([pid, sig]); } });
    expect(res.killed).toBe(true);
    expect(signals).toEqual([[-999_999, 'SIGTERM'], [-999_999, 'SIGKILL']]);
    expect(readAutoSleepSidecar(ctx)?.status).toBe('cancelled');
  });
});

describe('every sleep-state lock site RE-READS inside the lock', () => {
  /**
   * The bug this guards: locking the WRITE while holding a stale snapshot from
   * minutes earlier is not protection at all — the stale object is written back
   * whole and silently erases whatever landed in between. It happened once, in
   * the knowledge-access bump, where an awaited Haiku recall sits between the
   * read and the write. A source check is the right shape here: the property is
   * "no lock closure writes an object read outside it", which is structural.
   */
  const hookSource = readFileSync(join(__dirname, '..', '..', 'src', 'cli', 'commands', 'hook.ts'), 'utf8');

  it('the knowledge-access bump reads fresh state inside its lock', () => {
    const start = hookSource.indexOf('const bumpLock = withSleepStateLock');
    expect(start).toBeGreaterThan(-1);
    const body = hookSource.slice(start, hookSource.indexOf('});', start));
    expect(body).toContain('readSleepState(root)');
    // …and writes the object it just read, not the handler's older one.
    expect(body).toContain('writeSleepState(root, fresh)');
    expect(body).not.toContain('writeSleepState(root, state)');
  });

  it('every withSleepStateLock closure in the hook contains its own read', () => {
    const sites = [...hookSource.matchAll(/withSleepStateLock\(root, \(\) => \{/g)].map((m) => m.index ?? 0);
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const at of sites) {
      // Look at a generous window — these closures are long.
      const window = hookSource.slice(at, at + 12_000);
      expect(window, `the lock at offset ${at} must read state inside itself`)
        .toContain('readSleepState(root)');
    }
  });
});

describe('C4 — the nag silence', () => {
  const noisy = { debt: 200, bookmarks: [{ id: 'b', message: 'critical thing', salience: 3, created_at: '', session_id: null, task_slug: null }], sessions: [], sleep_started_at: null, last_consolidated_at: null, sessions_since_last_sleep: 0, triggers: [], knowledge_access: {}, dashboard_changes: [], compaction_log: [], pendingMigrationNotices: [], last_sleep: null, last_sleep_summary: null, recall_mode: 'haiku', consolidation_depth: null } as unknown as SleepState;

  it('normally shouts at 200 debt with a ★★★ bookmark', () => {
    expect(getConsolidationDirective(noisy)).toContain('CONSOLIDATION REQUIRED');
    expect(userPromptReminder(noisy)).toContain('CONSOLIDATION REQUIRED');
  });

  it('says ONE line instead when auto sleep is on — including for ★★★ bookmarks', () => {
    const on = { enabled: true, consentStale: false };
    const d = getConsolidationDirective(noisy, undefined, on);
    expect(d).not.toContain('CONSOLIDATION REQUIRED');
    expect(d).toContain('Auto sleep is ON');
    expect(d).toContain('--by human');
    expect(userPromptReminder(noisy, undefined, on)).toContain('Auto sleep is ON');
  });

  it('BREAKS the silence when consent is stale — a paused brain must never be quiet', () => {
    const stale = { enabled: true, consentStale: true };
    const d = getConsolidationDirective(noisy, undefined, stale);
    expect(d).toContain('PAUSED');
    expect(d).toContain('Re-enable');
    expect(userPromptReminder(noisy, undefined, stale)).toContain('PAUSED');
  });

  it('the line tells the agent both things it must do differently', () => {
    const line = autoSleepNagLine({ enabled: true, consentStale: false });
    expect(line).toContain('never run, offer, or recommend a sleep');
    expect(line).toContain('--by human');
  });
});
