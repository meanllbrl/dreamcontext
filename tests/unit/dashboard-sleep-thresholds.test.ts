import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEBT_DROWSY,
  DEBT_SLEEPY,
  DEBT_MUST_SLEEP,
  sleepinessLevel,
  sleepinessRange,
  resolveSleepThresholds,
} from '../../src/lib/sleep-consolidation.js';
import {
  DEFAULT_SLEEP_THRESHOLDS,
  getSleepLevel,
  getSleepLevelKey,
  getSleepMood,
  sleepThresholds,
  sleepRangeLabels,
} from '../../dashboard/src/hooks/sleepLevels.js';

/**
 * The dashboard is a separate Vite package with no import path into the CLI's
 * `src/`, so it hand-copies the debt thresholds. That mirror silently drifted
 * TWICE — through the 2026-06-29 ×2 rescale and again through the 2026-07-29
 * weighted-scorer rescale — each time leaving the app showing a different
 * sleepiness level than the terminal for the same debt (25 read "Must Sleep
 * 25/20" in the header while the CLI called it Drowsy at 25/60).
 *
 * These tests parse the dashboard sources as text (they are TSX/ESM outside
 * this package's tsconfig, so they cannot simply be imported) and fail the
 * build the next time the two sides disagree.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const USE_SLEEP = join(REPO_ROOT, 'dashboard', 'src', 'hooks', 'useSleep.ts');
const ABOUT_SECTION = join(
  REPO_ROOT, 'dashboard', 'src', 'components', 'about', 'SleepFlowSection.tsx',
);
const SLEEP_LEVELS = join(REPO_ROOT, 'dashboard', 'src', 'hooks', 'sleepLevels.ts');

/** Pull `export const NAME = <int>;` out of a TS source file. */
function readExportedConst(source: string, name: string): number {
  const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(source);
  if (!match) throw new Error(`${name} not found (or no longer a plain integer literal)`);
  return Number(match[1]);
}

describe('dashboard sleep thresholds mirror the backend', () => {
  const source = readFileSync(SLEEP_LEVELS, 'utf8');

  it.each([
    ['DEFAULT_DEBT_DROWSY', DEBT_DROWSY],
    ['DEFAULT_DEBT_SLEEPY', DEBT_SLEEPY],
    ['DEFAULT_DEBT_MUST_SLEEP', DEBT_MUST_SLEEP],
  ])('%s matches src/lib/sleep-consolidation.ts', (name, backendValue) => {
    expect(readExportedConst(source, name as string)).toBe(backendValue);
  });

  it('useSleep re-exports the ladder instead of keeping its own copy', () => {
    // The two prior drifts both started as a second copy of these numbers.
    const hook = readFileSync(USE_SLEEP, 'utf8');
    expect(hook).toContain("} from './sleepLevels';");
    expect(/export const DEBT_(DROWSY|SLEEPY|MUST_SLEEP)\s*=/.test(hook)).toBe(false);
  });

  it('the shipped default ladder equals the backend default ladder', () => {
    expect(DEFAULT_SLEEP_THRESHOLDS).toEqual(resolveSleepThresholds(undefined));
  });

  it('the progress bar ceiling is the Must Sleep entry point', () => {
    // The bar must never read "full" before a consolidation is actually required.
    expect(DEFAULT_SLEEP_THRESHOLDS.mustSleep).toBe(DEBT_MUST_SLEEP);
  });

  it('the level boundaries bucket debt exactly like sleepinessLevel()', () => {
    for (const debt of [0, DEBT_DROWSY - 1, DEBT_DROWSY, DEBT_SLEEPY - 1, DEBT_SLEEPY,
      DEBT_MUST_SLEEP - 1, DEBT_MUST_SLEEP, DEBT_MUST_SLEEP + 40]) {
      expect(getSleepLevel(debt)).toBe(sleepinessLevel(debt));
    }
  });

  // The DYNAMIC path — the whole point of making thresholds tunable. A brain
  // that lowers Must Sleep to 30 must see the dashboard agree with the terminal
  // at debt 30, not keep bucketing it as "Sleepy" from the shipped defaults.
  describe('a custom ladder from the /api/sleep payload changes the answer', () => {
    const custom = resolveSleepThresholds({ thresholds: { drowsy: 10, sleepy: 20, mustSleep: 30 } });

    it('sleepThresholds() prefers the payload over the defaults', () => {
      expect(sleepThresholds({ thresholds: custom })).toEqual(custom);
      expect(sleepThresholds(undefined)).toEqual(DEFAULT_SLEEP_THRESHOLDS);
    });

    it('getSleepLevel / LevelKey / Mood all follow the custom ladder', () => {
      expect(getSleepLevel(30)).toBe('Drowsy');             // shipped defaults (24/40/60)
      expect(getSleepLevel(30, custom)).toBe('Must Sleep');  // this brain
      expect(getSleepLevelKey(30, custom)).toBe('must_sleep');
      expect(getSleepMood(30, custom)).toBe('sleeps');
      expect(getSleepMood(15, custom)).toBe('idle');
      expect(getSleepMood(25, custom)).toBe('sleepy');
    });

    it('still buckets exactly like the backend at every boundary', () => {
      for (const debt of [0, 9, 10, 19, 20, 29, 30, 100]) {
        expect(getSleepLevel(debt, custom)).toBe(sleepinessLevel(debt, custom));
      }
    });
  });
});

describe('the About page debt table mirrors the backend ranges', () => {
  const source = readFileSync(ABOUT_SECTION, 'utf8');

  it('renders the ranges from the live payload, never a hand-copied table', () => {
    // The old `range: '24–39'` literals were the drift vector. They are gone;
    // the section now derives its rows from the same hook the header uses.
    expect(/range:\s*'/.test(source)).toBe(false);
    expect(source).toContain('sleepRangeLabels(sleepThresholds(sleep))');
  });

  it('lists every level with the range sleepinessRange() produces', () => {
    const rows = sleepRangeLabels();
    expect(rows.map((r) => r.level)).toEqual(['Alert', 'Drowsy', 'Sleepy', 'Must Sleep']);
    expect(rows[0].range).toBe(sleepinessRange(0));
    expect(rows[1].range).toBe(sleepinessRange(DEBT_DROWSY));
    expect(rows[2].range).toBe(sleepinessRange(DEBT_SLEEPY));
    expect(rows[3].range).toBe(sleepinessRange(DEBT_MUST_SLEEP));
  });

  it('and follows a custom ladder there too', () => {
    const custom = resolveSleepThresholds({ thresholds: { drowsy: 10, sleepy: 20, mustSleep: 30 } });
    const rows = sleepRangeLabels(custom);
    expect(custom).not.toEqual(DEFAULT_SLEEP_THRESHOLDS);
    expect(rows.map((r) => r.range)).toEqual([
      sleepinessRange(0, custom),
      sleepinessRange(custom.drowsy, custom),
      sleepinessRange(custom.sleepy, custom),
      sleepinessRange(custom.mustSleep, custom),
    ]);
  });

  it('no longer describes the retired max(changeScore, toolScore) scorer', () => {
    // Replaced on 2026-07-29 by a log-compressed weighted SUM over novel tokens,
    // file changes, tool calls and substance.
    expect(source).not.toMatch(/max\(changeScore/);
  });
});
