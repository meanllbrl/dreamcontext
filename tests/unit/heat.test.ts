import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HEAT_HOT, clampLimit, heavyLimitFor, readBagMode, readHeatLevel } from '../../src/lib/heat.js';

// Heat and the machine's heavy steps (AC1): very hot = one step machine-wide, else two.

describe('heavyLimitFor / clampLimit', () => {
  it('serious and critical are very hot (1); nominal, fair and unread are 2', () => {
    expect(HEAT_HOT).toEqual(['serious', 'critical']);
    expect(heavyLimitFor('serious')).toBe(1);
    expect(heavyLimitFor('critical')).toBe(1);
    expect(heavyLimitFor('fair')).toBe(2);
    expect(heavyLimitFor('nominal')).toBe(2);
    expect(heavyLimitFor(null)).toBe(2);
  });

  it('clamps into [1, 2]; NaN, 0, negatives and non-numbers read as 2', () => {
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(2)).toBe(2);
    expect(clampLimit(5)).toBe(2);
    expect(clampLimit(1.7)).toBe(1);
    for (const junk of [Number.NaN, 0, -1, Infinity, '1', null, undefined]) expect(clampLimit(junk)).toBe(2);
  });
});

describe('readHeatLevel', () => {
  it('off macOS: null, nothing read', async () => {
    const read = vi.fn(async () => 'serious' as const);
    expect(await readHeatLevel({ platform: 'linux', read })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('under vitest with no injected reader: null, no spawn', async () => {
    // A real osascript would answer 0..3 on this Mac; null here means none ran.
    expect(process.env.VITEST).toBeTruthy();
    expect(await readHeatLevel({ platform: 'darwin' })).toBeNull();
  });

  it('an injected reader is used, and a throwing one is null, never a throw', async () => {
    expect(await readHeatLevel({ platform: 'darwin', read: async () => 'critical' })).toBe('critical');
    expect(await readHeatLevel({ platform: 'darwin', read: async () => { throw new Error('osascript'); } })).toBeNull();
  });
});

describe('readBagMode', () => {
  let home: string;
  const write = (s: object) => {
    mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'handsfree-mac', 'state.json'), JSON.stringify(s));
  };
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-heat-bag-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('true only while Mac mode is on in Bag mode with a live server pid > 1', () => {
    expect(readBagMode(home, () => true)).toBe(false); // no state
    write({ on: true, serverPid: 4242, bagMode: true });
    expect(readBagMode(home, () => true)).toBe(true);
    expect(readBagMode(home, () => false)).toBe(false);
    write({ on: true, serverPid: 4242, bagMode: false });
    expect(readBagMode(home, () => true)).toBe(false);
    write({ on: true, serverPid: 1, bagMode: true });
    expect(readBagMode(home, () => true)).toBe(false);
    write({ on: false, serverPid: 4242, bagMode: true });
    expect(readBagMode(home, () => true)).toBe(false);
  });

  it('never throws on a broken file', () => {
    mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'handsfree-mac', 'state.json'), '{nope');
    expect(readBagMode(home, () => { throw new Error('x'); })).toBe(false);
  });
});
