import { afterEach, describe, expect, it } from 'vitest';
import { setCapacityFactsForTests, type CapacityFacts } from '../../src/lib/super/capacity.js';
import { readMachinePressure } from '../../src/lib/voice/whisperPressure.js';

/**
 * Shift+V refused 4 of 5 takes on 2026-10-30 with `stt_pressure`. The reading at the time, on a
 * 16 GB Mac: 2.5 GB available (over the 2 GB line) and swap 7.3 of 8 GB — macOS grows its swap
 * files as they fill, so the share is ~90 % whenever anything is swapped. Synthetic numbers of
 * the same shape.
 */
const busyMac: CapacityFacts = {
  availMemGb: 2.5, diskFreeGb: 100, load1: 3, totalMemGb: 16, swapUsedGb: 7.3, swapTotalGb: 8,
};

function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  return run().finally(() => Object.defineProperty(process, 'platform', real));
}

afterEach(() => setCapacityFactsForTests(null));

describe('dictation pressure: swap share on macOS is not load', () => {
  it('a Mac with room in memory but its swap files full keeps dictation on', async () => {
    setCapacityFactsForTests(busyMac);
    const r = await onPlatform('darwin', () => readMachinePressure());
    expect(r).toEqual({ pressed: false, why: null });
  });

  it('a Mac really short on memory still pauses it', async () => {
    setCapacityFactsForTests({ ...busyMac, availMemGb: 1.2 });
    const r = await onPlatform('darwin', () => readMachinePressure());
    expect(r).toEqual({ pressed: true, why: 'memory' });
  });

  it('our own loaded model is still credited back on macOS', async () => {
    setCapacityFactsForTests({ ...busyMac, availMemGb: 1.2 });
    const r = await onPlatform('darwin', () => readMachinePressure({ loadedMB: 1600 }));
    expect(r).toEqual({ pressed: false, why: null });
  });

  it('on Linux, where the swap size is fixed, a full swap still counts', async () => {
    setCapacityFactsForTests(busyMac);
    const r = await onPlatform('linux', () => readMachinePressure());
    expect(r).toEqual({ pressed: true, why: 'swap' });
  });
});
