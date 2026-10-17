/**
 * GET /api/app/machine — the facts Light mode's Auto reads (memory, battery), with injected
 * readers: macOS on battery / on AC, a failing `pmset`, a non-macOS host, and the minute memo.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readMachineFacts, resetMachineFactsForTests, type MachineDeps } from '../../src/server/routes/machine.js';

const GB = 1024 ** 3;
function deps(over: Partial<MachineDeps> = {}): MachineDeps & { reads: { n: number } } {
  const reads = { n: 0 };
  let t = 1_000_000;
  return {
    platform: 'darwin',
    totalMem: () => 8 * GB,
    battery: async () => { reads.n += 1; return { percent: 50, charging: false }; },
    now: () => t,
    ...over,
    reads,
    // advance helper via closure
    ...(over.now ? {} : { now: () => (t += 1) }),
  } as MachineDeps & { reads: { n: number } };
}

beforeEach(() => resetMachineFactsForTests());

describe('readMachineFacts', () => {
  it('reports memory in GB and the battery state', async () => {
    expect(await readMachineFacts(deps())).toEqual({ totalMemGb: 8, onBattery: true });
  });

  it('on AC power → onBattery false', async () => {
    expect(await readMachineFacts(deps({ totalMem: () => 16 * GB, battery: async () => ({ percent: 100, charging: true }) })))
      .toEqual({ totalMemGb: 16, onBattery: false });
  });

  it('a failing pmset → onBattery null (Auto then uses memory alone)', async () => {
    expect((await readMachineFacts(deps({ battery: async () => { throw new Error('no pmset'); } }))).onBattery).toBeNull();
  });

  it('not macOS → onBattery null, no pmset spawned', async () => {
    const d = deps({ platform: 'linux' });
    expect((await readMachineFacts(d)).onBattery).toBeNull();
    expect(d.reads.n).toBe(0);
  });

  it('memoizes the battery read for a minute', async () => {
    const d = deps();
    for (let i = 0; i < 10; i += 1) await readMachineFacts(d);
    expect(d.reads.n).toBe(1);
  });
});
