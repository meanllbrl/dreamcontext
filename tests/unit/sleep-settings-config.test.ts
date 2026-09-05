import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSetupConfig, updateSetupConfig, KNOWN_SLEEP_MODELS, SLEEP_SPECIALISTS } from '../../src/lib/setup-config.js';
import {
  DEBT_DROWSY,
  DEBT_SLEEPY,
  DEBT_MUST_SLEEP,
  DEBT_DEEP_AUTHORITY,
  DEBT_COOLDOWN_OVERRIDE,
  DEFAULT_SLEEP_THRESHOLDS,
  resolveSleepThresholds,
  hasInvalidSleepThresholds,
  sleepinessLevel,
  consolidationDepth,
  inspectSleepCooldown,
  SLEEP_COOLDOWN_MS,
} from '../../src/lib/sleep-consolidation.js';

/**
 * Workstream A of the sleep umbrella: the debt ladder, the specialist model/effort
 * map and the per-cycle task cap became per-brain settings. The invariant these
 * tests exist to hold is the one the owner asked for FIRST — a brain that sets
 * nothing behaves byte-for-byte as it did when these were constants.
 */

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-sleepcfg-'));
  mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeConfig(sleep: unknown): void {
  writeFileSync(
    join(root, '_dream_context', 'state', '.config.json'),
    JSON.stringify({ platforms: [], packs: [], setupVersion: '1.0.0', sleep }, null, 2),
  );
}

describe('resolveSleepThresholds', () => {
  it('a zero-config brain resolves to exactly the shipped constants', () => {
    for (const cfg of [undefined, null, {}, { thresholds: undefined }]) {
      expect(resolveSleepThresholds(cfg as never)).toEqual({
        drowsy: DEBT_DROWSY,
        sleepy: DEBT_SLEEPY,
        mustSleep: DEBT_MUST_SLEEP,
        deepAuthority: DEBT_DEEP_AUTHORITY,
        cooldownOverride: DEBT_COOLDOWN_OVERRIDE,
      });
    }
  });

  it('a partial override keeps the untouched levels at their defaults', () => {
    // 80 stays ABOVE the default Sleepy (40), so the ladder is still monotonic.
    const t = resolveSleepThresholds({ thresholds: { mustSleep: 80 } });
    expect(t.drowsy).toBe(DEBT_DROWSY);
    expect(t.sleepy).toBe(DEBT_SLEEPY);
    expect(t.mustSleep).toBe(80);
  });

  it('a partial override that inverts the ladder against the DEFAULTS is rejected', () => {
    // Lowering only Must Sleep to 30 leaves the default Sleepy (40) above it —
    // an unreadable ladder. Read-side falls back whole; the CLI/UI write paths
    // refuse it loudly so this can only be reached by hand-editing the file.
    expect(resolveSleepThresholds({ thresholds: { mustSleep: 30 } })).toEqual(DEFAULT_SLEEP_THRESHOLDS);
  });

  it('derives deepAuthority (×1.5) and cooldownOverride (×2) from the OVERRIDDEN base', () => {
    const t = resolveSleepThresholds({ thresholds: { drowsy: 10, sleepy: 20, mustSleep: 30 } });
    expect(t.deepAuthority).toBe(45);
    expect(t.cooldownOverride).toBe(60);
    // and never from the shipped constant
    expect(t.deepAuthority).not.toBe(DEBT_DEEP_AUTHORITY);
  });

  it('rounds a derived deepAuthority to a whole debt value', () => {
    const t = resolveSleepThresholds({ thresholds: { drowsy: 8, sleepy: 16, mustSleep: 25 } });
    expect(t.deepAuthority).toBe(38);   // 25 × 1.5 = 37.5
    expect(t.cooldownOverride).toBe(50);
  });

  it.each([
    ['sleepy at drowsy', { drowsy: 40, sleepy: 40, mustSleep: 60 }],
    ['mustSleep below sleepy', { drowsy: 10, sleepy: 50, mustSleep: 30 }],
    ['fully inverted', { drowsy: 60, sleepy: 40, mustSleep: 24 }],
    ['a partial override that inverts the ladder', { mustSleep: 5 }],
  ])('a non-monotonic ladder (%s) falls back to defaults ENTIRELY, never half-applied', (_n, thresholds) => {
    expect(resolveSleepThresholds({ thresholds })).toEqual(DEFAULT_SLEEP_THRESHOLDS);
    expect(hasInvalidSleepThresholds({ thresholds })).toBe(true);
  });

  it('hasInvalidSleepThresholds is false when nothing is overridden', () => {
    expect(hasInvalidSleepThresholds(undefined)).toBe(false);
    expect(hasInvalidSleepThresholds({ maxNewTasksPerCycle: 3 })).toBe(false);
  });
});

describe('the resolved ladder actually drives the derived functions', () => {
  const custom = resolveSleepThresholds({ thresholds: { drowsy: 10, sleepy: 20, mustSleep: 30 } });

  it('sleepinessLevel buckets on the custom ladder', () => {
    expect(sleepinessLevel(30)).toBe('Drowsy');          // defaults
    expect(sleepinessLevel(30, custom)).toBe('Must Sleep');
  });

  it('consolidationDepth authorizes deep at the DERIVED deepAuthority', () => {
    expect(consolidationDepth(45, {}).depth).toBe('standard');        // defaults: 90 needed
    expect(consolidationDepth(45, {}, custom).depth).toBe('deep');    // custom: 45 is the bar
  });

  it('inspectSleepCooldown bypasses at the DERIVED cooldownOverride', () => {
    const state = { last_consolidated_at: new Date(Date.now() - SLEEP_COOLDOWN_MS / 2).toISOString() };
    expect(inspectSleepCooldown(state, Date.now(), 60).active).toBe(true);            // defaults: 120 needed
    expect(inspectSleepCooldown(state, Date.now(), 60, custom).overridden).toBe(true); // custom: 60 is the bar
  });
});

describe('sanitizeSleep (via readSetupConfig)', () => {
  it('reads a well-formed block back verbatim', () => {
    writeConfig({
      thresholds: { drowsy: 10, sleepy: 20, mustSleep: 30 },
      specialists: { 'sleep-tasks': { model: 'claude-opus-5', effort: 'medium' } },
      maxNewTasksPerCycle: 3,
    });
    expect(readSetupConfig(root)?.sleep).toEqual({
      thresholds: { drowsy: 10, sleepy: 20, mustSleep: 30 },
      specialists: { 'sleep-tasks': { model: 'claude-opus-5', effort: 'medium' } },
      maxNewTasksPerCycle: 3,
    });
  });

  it.each([
    ['a non-object block', 'nonsense'],
    ['an array block', [1, 2]],
    ['null', null],
  ])('drops %s entirely rather than throwing', (_n, sleep) => {
    writeConfig(sleep);
    expect(readSetupConfig(root)?.sleep).toBeUndefined();
  });

  it('drops non-integer, out-of-range and negative thresholds field by field', () => {
    writeConfig({ thresholds: { drowsy: 1.5, sleepy: -4, mustSleep: 30 } });
    expect(readSetupConfig(root)?.sleep?.thresholds).toEqual({ mustSleep: 30 });
  });

  it('drops a threshold above the 1000 ceiling', () => {
    writeConfig({ thresholds: { mustSleep: 1001 } });
    expect(readSetupConfig(root)?.sleep).toBeUndefined();
  });

  it('drops unknown specialist names', () => {
    writeConfig({ specialists: { 'sleep-tasks': { effort: 'low' }, 'sleep-nonsense': { effort: 'low' } } });
    expect(readSetupConfig(root)?.sleep?.specialists).toEqual({ 'sleep-tasks': { effort: 'low' } });
  });

  it('drops a model that would not be shell-safe (the sanitizeModel gate)', () => {
    writeConfig({ specialists: { 'sleep-tasks': { model: 'opus; rm -rf /', effort: 'low' } } });
    expect(readSetupConfig(root)?.sleep?.specialists).toEqual({ 'sleep-tasks': { effort: 'low' } });
  });

  it.each(['xhigh', 'max', 'LOW', ''])('drops effort %s (sleep is scoped to low/medium/high)', (effort) => {
    writeConfig({ specialists: { 'sleep-tasks': { model: 'claude-opus-5', effort } } });
    expect(readSetupConfig(root)?.sleep?.specialists?.['sleep-tasks']).toEqual({ model: 'claude-opus-5' });
  });

  it('keeps a cap of 0 (file no tasks at all) but drops a negative one', () => {
    writeConfig({ maxNewTasksPerCycle: 0 });
    expect(readSetupConfig(root)?.sleep?.maxNewTasksPerCycle).toBe(0);
    writeConfig({ maxNewTasksPerCycle: -1 });
    expect(readSetupConfig(root)?.sleep).toBeUndefined();
  });

  it('a garbage config never throws — the Stop hook reads this on every turn', () => {
    writeConfig({ thresholds: 'nope', specialists: [1], maxNewTasksPerCycle: {} });
    expect(() => readSetupConfig(root)).not.toThrow();
    expect(readSetupConfig(root)?.sleep).toBeUndefined();
  });
});

describe('updateSetupConfig persists the sleep block', () => {
  it('merges sleep like every other section and leaves it alone when absent', () => {
    updateSetupConfig(root, { sleep: { maxNewTasksPerCycle: 2 } });
    expect(readSetupConfig(root)?.sleep).toEqual({ maxNewTasksPerCycle: 2 });
    updateSetupConfig(root, { setupVersion: '9.9.9' });
    expect(readSetupConfig(root)?.sleep).toEqual({ maxNewTasksPerCycle: 2 });
  });

  it('round-trips through the file, not just in memory', () => {
    updateSetupConfig(root, { sleep: { specialists: { 'sleep-state': { model: 'claude-sonnet-5' } } } });
    const raw = JSON.parse(readFileSync(join(root, '_dream_context', 'state', '.config.json'), 'utf8'));
    expect(raw.sleep.specialists['sleep-state'].model).toBe('claude-sonnet-5');
  });
});

describe('the known-model list and specialist roster', () => {
  it('covers the six specialists the sleep flow dispatches', () => {
    expect([...SLEEP_SPECIALISTS]).toEqual([
      'sleep-tasks', 'sleep-state', 'sleep-product', 'sleep-migration', 'sleep-federation', 'sleep-learn',
    ]);
  });

  it('every known model is itself shell-safe, so the UI can offer it unescaped', () => {
    for (const m of KNOWN_SLEEP_MODELS) expect(/^[A-Za-z0-9._-]+$/.test(m)).toBe(true);
  });
});
