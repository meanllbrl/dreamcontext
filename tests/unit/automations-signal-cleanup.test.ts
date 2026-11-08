import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { signalCleanup } from '../../src/lib/automations/runner.js';

/**
 * The tick runs several projects' routines in one process and each run registers its own
 * SIGTERM handler. A handler that exited on the spot stopped the emit, so every later run's
 * claude group outlived the tick with no timeout and its lock held.
 */
describe('signalCleanup', () => {
  it('every run cleans up before the process exits, whatever order the handlers were added in', async () => {
    const proc = new EventEmitter();
    const cleaned: string[] = [];
    const exits: Array<{ code: number; cleanedSoFar: number }> = [];
    const exit = (code: number): void => {
      exits.push({ code, cleanedSoFar: cleaned.length });
    };
    proc.on('SIGTERM', signalCleanup(() => cleaned.push('a'), 143, exit));
    proc.on('SIGTERM', signalCleanup(() => cleaned.push('b'), 143, exit));
    proc.on('SIGTERM', signalCleanup(() => cleaned.push('c'), 143, exit));

    proc.emit('SIGTERM');
    expect(cleaned).toEqual(['a', 'b', 'c']);
    expect(exits).toHaveLength(0);

    await new Promise((r) => process.nextTick(r));
    expect(exits[0]).toEqual({ code: 143, cleanedSoFar: 3 });
  });
});
