import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixOutcome, RunSink } from '../../src/lib/onboarding/fixes.js';
import type { FixId, ProbeContext } from '../../src/lib/onboarding/types.js';
import { isFixActive, resetReadinessForTests } from '../../src/lib/onboarding/readiness.js';
import {
  activeRunFor, cancelRun, createRun, finishRun, getRun, pruneInstallRuns, resetInstallRunsForTests,
  runStatusView, startFixRun, startTaskRun,
} from '../../src/server/install-runs.js';

/** The run store's contract: one active run per fix, pruning that never drops a live run,
 *  the active-fix registry kept in step, and the git-install completion hook. */

const CTX = { surface: 'desktop', platform: 'darwin', arch: 'arm64', home: '/nonexistent-home', execPath: '/usr/bin/node' } as unknown as ProbeContext;

/** A runFix stand-in the test settles by hand, recording the sink it was handed. */
function controllableFix() {
  let resolve!: (o: FixOutcome) => void;
  let sink!: RunSink;
  let signal!: AbortSignal;
  const runFix = vi.fn((_id: FixId, _ctx: ProbeContext, s: RunSink, sig: AbortSignal) => {
    sink = s;
    signal = sig;
    return new Promise<FixOutcome>((r) => { resolve = r; });
  });
  return { runFix, settle: (o: FixOutcome) => resolve(o), sink: () => sink, signal: () => signal };
}

beforeEach(() => { resetInstallRunsForTests(); resetReadinessForTests(); });
afterEach(() => { resetInstallRunsForTests(); resetReadinessForTests(); vi.restoreAllMocks(); });

describe('pruneInstallRuns', () => {
  it('never evicts a run that is still going, even past the cap', () => {
    const live = createRun('claude');
    for (let i = 0; i < 30; i++) finishRun(createRun(`done-${i}`).run, true);
    pruneInstallRuns();
    expect(getRun(live.id)?.state).toBe('running');
  });

  it('drops ended runs past their TTL but keeps running ones', () => {
    const live = createRun('a');
    const ended = createRun('b');
    finishRun(ended.run, true);
    pruneInstallRuns(Date.now() + 11 * 60 * 1000);
    expect(getRun(ended.id)).toBeUndefined();
    expect(getRun(live.id)).toBeDefined();
  });
});

describe('startFixRun', () => {
  it('keeps the active-fix registry in step and ends as done', async () => {
    const fake = controllableFix();
    const { runId, existing } = startFixRun('cli-install', CTX, { deps: { runFix: fake.runFix, runPendingGitInits: () => [] } });
    expect(existing).toBe(false);
    expect(isFixActive('cli-install')).toBe(true);
    expect(activeRunFor('cli-install')).toBe(runId);
    fake.sink().output('added 1 package\n');
    fake.sink().progress(5, 10);
    expect(runStatusView(getRun(runId)!)).toMatchObject({ state: 'running', progress: { received: 5, total: 10 } });
    fake.settle({ ok: true });
    await vi.waitFor(() => expect(getRun(runId)?.state).toBe('done'));
    expect(isFixActive('cli-install')).toBe(false);
    expect(activeRunFor('cli-install')).toBeNull();
    expect(getRun(runId)?.output).toContain('added 1 package');
  });

  it('returns the same run for a second start of a fix that is still running', () => {
    const fake = controllableFix();
    const deps = { runFix: fake.runFix, runPendingGitInits: () => [] };
    const first = startFixRun('claude-install', CTX, { deps });
    const second = startFixRun('claude-install', CTX, { deps });
    expect(second).toEqual({ runId: first.runId, existing: true });
    expect(fake.runFix).toHaveBeenCalledTimes(1);
  });

  it('cancel aborts the run; it ends as error with outcome canceled', async () => {
    const fake = controllableFix();
    const kill = vi.fn();
    const { runId } = startFixRun('claude-signin', CTX, { deps: { runFix: fake.runFix, runPendingGitInits: () => [] } });
    fake.sink().onCancel(kill);
    fake.sink().awaiting('browser');
    expect(cancelRun(runId)).toBe(true);
    expect(fake.signal().aborted).toBe(true);
    expect(kill).toHaveBeenCalled();
    fake.settle({ ok: false, reason: 'canceled', detail: 'Canceled.' });
    await vi.waitFor(() => expect(getRun(runId)?.state).toBe('error'));
    expect(runStatusView(getRun(runId)!)).toMatchObject({ state: 'error', outcome: 'canceled', awaiting: null });
    expect(cancelRun(runId)).toBe(false);
  });

  it('a git-install that ends ok runs the pending git inits from the completion hook', async () => {
    const fake = controllableFix();
    const pending = vi.fn(() => ['/tmp/x']);
    startFixRun('git-install', CTX, { deps: { runFix: fake.runFix, runPendingGitInits: pending } });
    expect(pending).not.toHaveBeenCalled();
    fake.settle({ ok: true });
    await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
  });

  it('a failed git-install, or any other fix, never runs them', async () => {
    const pending = vi.fn(() => []);
    const a = controllableFix();
    const r1 = startFixRun('git-install', CTX, { deps: { runFix: a.runFix, runPendingGitInits: pending } });
    a.settle({ ok: false, reason: 'timeout' });
    await vi.waitFor(() => expect(getRun(r1.runId)?.state).toBe('error'));
    const b = controllableFix();
    const r2 = startFixRun('gh-install', CTX, { deps: { runFix: b.runFix, runPendingGitInits: pending } });
    b.settle({ ok: true });
    await vi.waitFor(() => expect(getRun(r2.runId)?.state).toBe('done'));
    expect(pending).not.toHaveBeenCalled();
  });

  it('shows a device code only while running, and the status view carries no handles', async () => {
    const fake = controllableFix();
    const { runId } = startFixRun('github-signin', CTX, { deps: { runFix: fake.runFix, runPendingGitInits: () => [] } });
    fake.sink().deviceCode({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 1 });
    const view = runStatusView(getRun(runId)!);
    expect(view.deviceCode?.userCode).toBe('ABCD-1234');
    for (const key of Object.keys(view)) {
      expect(['state', 'target', 'output', 'outcome', 'awaiting', 'progress', 'deviceCode']).toContain(key);
    }
    fake.settle({ ok: true });
    await vi.waitFor(() => expect(getRun(runId)?.state).toBe('done'));
    expect(runStatusView(getRun(runId)!).deviceCode).toBeUndefined();
  });

  it('runs onDone before the run reads as ended, and a throwing runFix still ends the run', async () => {
    const order: string[] = [];
    const runFix = vi.fn(async () => { throw new Error('boom'); });
    const { runId } = startFixRun('pty-install', CTX, {
      target: 'pty',
      deps: { runFix, runPendingGitInits: () => [] },
      onDone: (o, run) => { order.push(`${o.ok}:${run.state}`); },
    });
    await vi.waitFor(() => expect(getRun(runId)?.state).toBe('error'));
    expect(order).toEqual(['false:running']);
    expect(runStatusView(getRun(runId)!)).toMatchObject({ target: 'pty', outcome: 'failed' });
  });
});

describe('startTaskRun', () => {
  it('carries the task message as the output', async () => {
    const id = startTaskRun('claude-update', async () => ({ ok: true, message: 'Up to date.' }), { initialOutput: 'Updating...' });
    expect(getRun(id)?.output).toBe('Updating...');
    await vi.waitFor(() => expect(getRun(id)?.state).toBe('done'));
    expect(getRun(id)?.output).toBe('Up to date.');
  });
});
