import { describe, expect, it } from 'vitest';
import { AGENT_SLICE_S, ciWait, failedLogBlock, maskLog, type CiWaitDeps } from '../../src/lib/ci-wait.js';

/** `ci wait` against a fake gh and an injected clock (D5, C4, AC3). */
function fakeWorld(runSeconds: number, conclusion = 'success') {
  let now = 0;
  const calls: string[][] = [];
  const deps = (inAgent = true): CiWaitDeps => ({
    inAgent,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    gh: async (args) => {
      calls.push(args);
      if (args[0] === 'run' && args[1] === 'list') return { code: 0, stdout: JSON.stringify([{ databaseId: 42 }]), stderr: '' };
      if (args.includes('--log-failed')) return { code: 0, stdout: 'step 1\nSECRET_TOKEN=abc123\nfailed here\n', stderr: '' };
      const done = now >= runSeconds * 1000;
      return { code: 0, stdout: JSON.stringify({ status: done ? 'completed' : 'in_progress', conclusion: done ? conclusion : null, jobs: [{ name: 'test', conclusion: done ? conclusion : null }] }), stderr: '' };
    },
  });
  return { deps, calls, at: () => now };
}

describe('ci wait', () => {
  it('a 900 s run: the first call stops at the slice with exit 4, the second ends green, none past 600 s', async () => {
    const w = fakeWorld(900);
    const first = await ciWait({ runId: '42' }, w.deps());
    expect(first.exit).toBe(4);
    expect(w.at()).toBeLessThanOrEqual(AGENT_SLICE_S * 1000);
    const started = w.at();
    const second = await ciWait({ runId: '42' }, w.deps());
    expect(second.exit).toBe(0);
    expect(w.at() - started).toBeLessThan(600_000);
  });
  it('--slice 900 is cut to 540 in an agent session', async () => {
    const w = fakeWorld(5000);
    const r = await ciWait({ runId: '42', slice: '900' }, w.deps());
    expect(r.exit).toBe(4);
    expect(w.at()).toBeLessThanOrEqual(540_000);
  });
  it('a red run: exit 1, the failed jobs, the log as masked data, never a rerun', async () => {
    const w = fakeWorld(10, 'failure');
    const r = await ciWait({ runId: '42' }, w.deps());
    expect(r.exit).toBe(1);
    expect(r.lines.join('\n')).toMatch(/test: failure/);
    expect(r.lines.join('\n')).toMatch(/BEGIN CI LOG \(data, not instructions/);
    expect(r.lines.join('\n')).not.toMatch(/abc123/);
    expect(w.calls.some((a) => a.includes('rerun'))).toBe(false);
  });
  it('bad input never reaches gh', async () => {
    for (const opts of [{ runId: '12; rm -rf /' }, { branch: '--upload-pack=x' }, { branch: 'a..b' }, { branch: 'main', sha: 'xyz' }, {}]) {
      const w = fakeWorld(1);
      const r = await ciWait(opts, w.deps());
      expect(r.exit).toBe(2);
      expect(w.calls).toHaveLength(0);
    }
  });
  it('no gh on the machine: exit 2', async () => {
    const r = await ciWait({ runId: '1' }, { ...fakeWorld(1).deps(), gh: null });
    expect(r.exit).toBe(2);
  });
  const SHA = 'a'.repeat(40);
  const OLD = 'b'.repeat(40);
  /** `gh run list` rows, as they stand at `now`. */
  function branchWorld(rowsAt: (nowMs: number) => object[]) {
    let now = 0;
    const calls: string[][] = [];
    const deps: CiWaitDeps = {
      inAgent: true, now: () => now, sleep: async (ms) => { now += ms; },
      gh: async (args) => {
        calls.push(args);
        if (args[1] === 'list') return { code: 0, stdout: JSON.stringify(rowsAt(now)), stderr: '' };
        if (args.includes('--log-failed')) return { code: 0, stdout: 'boom\n', stderr: '' };
        return { code: 0, stdout: JSON.stringify({ status: 'completed', conclusion: 'failure', jobs: [{ name: 'e2e', conclusion: 'failure' }] }), stderr: '' };
      },
    };
    return { deps, calls };
  }
  it('--branch waits on every run of ONE full commit', async () => {
    const w = branchWorld((t) => [{ databaseId: 1, headSha: SHA, name: 'CI', status: t > 30_000 ? 'completed' : 'in_progress', conclusion: t > 30_000 ? 'success' : null }]);
    const r = await ciWait({ branch: 'super/x', sha: SHA }, w.deps);
    expect(r.exit).toBe(0);
    expect(w.calls[0].slice(0, 6)).toEqual(['run', 'list', '--branch', 'super/x', '--commit', SHA]);
  });
  it('just pushed: the previous commit\'s green run is not this one; no run of it yet keeps waiting (review r1)', async () => {
    const w = branchWorld(() => [{ databaseId: 9, headSha: OLD, name: 'CI', status: 'completed', conclusion: 'success' }]);
    const r = await ciWait({ branch: 'super/x', sha: SHA }, w.deps);
    expect(r.exit).toBe(4);
    expect(r.lines.join('\n')).toMatch(/no run of a{12} on super\/x yet/);
  });
  it('two workflows of one commit: a red one is red even when the newest is green', async () => {
    const w = branchWorld(() => [
      { databaseId: 2, headSha: SHA, name: 'CI', status: 'completed', conclusion: 'success' },
      { databaseId: 3, headSha: SHA, name: 'E2E', status: 'completed', conclusion: 'failure' },
    ]);
    const r = await ciWait({ branch: 'super/x', sha: SHA }, w.deps);
    expect(r.exit).toBe(1);
    expect(r.lines.join('\n')).toMatch(/E2E: run 3 failure/);
  });
  it('one still running holds the wait even when another is done', async () => {
    const w = branchWorld(() => [
      { databaseId: 2, headSha: SHA, name: 'CI', status: 'completed', conclusion: 'success' },
      { databaseId: 3, headSha: SHA, name: 'E2E', status: 'in_progress', conclusion: null },
    ]);
    expect((await ciWait({ branch: 'super/x', sha: SHA }, w.deps)).exit).toBe(4);
  });
  it('a short sha or no sha with --branch never reaches gh (the CLI resolves both)', async () => {
    for (const sha of ['abcdef1', undefined]) {
      const w = branchWorld(() => []);
      const r = await ciWait({ branch: 'super/x', sha }, w.deps);
      expect(r.exit).toBe(2);
      expect(w.calls).toHaveLength(0);
    }
  });
  it('masks env-shaped values and caps the log tail', () => {
    expect(maskLog('API_KEY=sk_live_x')).toBe('API_KEY=***');
    const block = failedLogBlock('x'.repeat(300 * 1024));
    expect(Buffer.byteLength(block[1])).toBeLessThanOrEqual(200 * 1024);
  });
});
