import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEBT_DROWSY,
  DEBT_SLEEPY,
  DEBT_MUST_SLEEP,
  sleepinessRange,
} from '../../src/lib/sleep-consolidation.js';

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

/** Pull `export const NAME = <int>;` out of a TS source file. */
function readExportedConst(source: string, name: string): number {
  const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(source);
  if (!match) throw new Error(`${name} not found (or no longer a plain integer literal)`);
  return Number(match[1]);
}

describe('dashboard sleep thresholds mirror the backend', () => {
  const source = readFileSync(USE_SLEEP, 'utf8');

  it.each([
    ['DEBT_DROWSY', DEBT_DROWSY],
    ['DEBT_SLEEPY', DEBT_SLEEPY],
    ['DEBT_MUST_SLEEP', DEBT_MUST_SLEEP],
  ])('%s matches src/lib/sleep-consolidation.ts', (name, backendValue) => {
    expect(readExportedConst(source, name as string)).toBe(backendValue);
  });

  it('SLEEP_DEBT_MAX (the progress bar ceiling) is the Must Sleep entry point', () => {
    // Derived in the dashboard as `SLEEP_DEBT_MAX = DEBT_MUST_SLEEP`; assert the
    // derivation still holds so the bar can never fill before Must Sleep.
    expect(/export const SLEEP_DEBT_MAX = DEBT_MUST_SLEEP\b/.test(source)).toBe(true);
  });

  it('the level boundaries bucket debt exactly like sleepinessLevel()', () => {
    const drowsy = readExportedConst(source, 'DEBT_DROWSY');
    const sleepy = readExportedConst(source, 'DEBT_SLEEPY');
    const must = readExportedConst(source, 'DEBT_MUST_SLEEP');
    // Strictly ascending, or the dashboard's `if` ladder shadows a whole level.
    expect(drowsy).toBeLessThan(sleepy);
    expect(sleepy).toBeLessThan(must);
  });
});

describe('the About page debt table mirrors the backend ranges', () => {
  const source = readFileSync(ABOUT_SECTION, 'utf8');

  /** `{ level: 'Drowsy', range: '24–39', ...}` → { Drowsy: '24-39' } (en-dash normalized). */
  function readDebtTable(): Record<string, string> {
    const rows: Record<string, string> = {};
    const re = /level:\s*'([^']+)',\s*range:\s*'([^']+)'/g;
    for (let m = re.exec(source); m; m = re.exec(source)) {
      rows[m[1]] = m[2].replace(/[–—]/g, '-');
    }
    return rows;
  }

  it('lists every level with the range sleepinessRange() produces', () => {
    const table = readDebtTable();
    expect(Object.keys(table)).toEqual(['Alert', 'Drowsy', 'Sleepy', 'Must Sleep']);
    expect(table['Alert']).toBe(sleepinessRange(0));
    expect(table['Drowsy']).toBe(sleepinessRange(DEBT_DROWSY));
    expect(table['Sleepy']).toBe(sleepinessRange(DEBT_SLEEPY));
    expect(table['Must Sleep']).toBe(sleepinessRange(DEBT_MUST_SLEEP));
  });

  it('no longer describes the retired max(changeScore, toolScore) scorer', () => {
    // Replaced on 2026-07-29 by a log-compressed weighted SUM over novel tokens,
    // file changes, tool calls and substance.
    expect(source).not.toMatch(/max\(changeScore/);
  });
});
