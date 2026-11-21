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
  it('--branch finds the newest run and waits on it', async () => {
    const w = fakeWorld(30);
    const r = await ciWait({ branch: 'super/x', sha: 'abcdef1' }, w.deps());
    expect(r.exit).toBe(0);
    expect(w.calls[0]).toEqual(['run', 'list', '--branch', 'super/x', '--commit', 'abcdef1', '--limit', '1', '--json', 'databaseId']);
  });
  it('masks env-shaped values and caps the log tail', () => {
    expect(maskLog('API_KEY=sk_live_x')).toBe('API_KEY=***');
    const block = failedLogBlock('x'.repeat(300 * 1024));
    expect(Buffer.byteLength(block[1])).toBeLessThanOrEqual(200 * 1024);
  });
});
