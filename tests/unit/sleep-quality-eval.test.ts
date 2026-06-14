import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreConsolidation, formatReport, type ScorerInput, type Gold, type FixtureMeta } from '../../eval/sleep-quality/scorer.js';
import type { SleepState } from '../../src/lib/sleep-consolidation.js';
import type { Commit } from '../../src/lib/attribution.js';

const here = dirname(fileURLToPath(import.meta.url));
const evalDir = join(here, '../../eval/sleep-quality');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

/**
 * Frozen BASELINE overall (the BEFORE profile). Derived deterministically from
 * the fixture by reasoning about the pre-refinement behavior. See BASELINE.md.
 * AFTER must be >= this; movers (attribution, substance, depth) must strictly
 * improve; regression guards (epoch, debt, no-double-count, triggers) must not
 * drop.
 */
const BASELINE_OVERALL = 400 / 7; // ≈ 57.14

describe('sleep-quality eval — Layer 1 (deterministic, no LLM)', () => {
  const state = readJson<SleepState>(join(evalDir, 'fixture/state/.sleep.json'));
  const meta = readJson<FixtureMeta>(join(evalDir, 'fixture/fixture-meta.json'));
  const gold = readJson<Gold>(join(evalDir, 'gold.json'));

  const mainConfig = readJson<{ people: string[]; commits: Commit[] }>(join(evalDir, 'fixture/state/.config.json'));
  const controlConfig = readJson<{ people: string[]; commits: Commit[] }>(join(evalDir, 'fixture-control/state/.config.json'));

  const input: ScorerInput = {
    state,
    meta,
    commits: mainConfig.commits,
    roster: mainConfig.people,
    controlCommits: controlConfig.commits,
    controlRoster: controlConfig.people,
  };

  const before = scoreConsolidation(input, gold, 'before');
  const after = scoreConsolidation(input, gold, 'after');

  // Surface the numbers in test output (like recall-eval.test.ts).
  // eslint-disable-next-line no-console
  console.log('\n' + formatReport(before, after) + '\n');

  it('AFTER overall >= BASELINE', () => {
    expect(after.overall).toBeGreaterThanOrEqual(BASELINE_OVERALL);
  });

  it('BASELINE (BEFORE overall) matches the frozen value', () => {
    expect(before.overall).toBeCloseTo(BASELINE_OVERALL, 5);
  });

  it('AFTER overall is a perfect 100 (all sub-scores pass)', () => {
    expect(after.overall).toBe(100);
  });

  const sub = (report: typeof before, key: string): number =>
    report.subScores.find((s) => s.key === key)!.score;

  it.each(['attribution', 'substanceScoring', 'depthGating'])(
    'mover %s strictly improves AFTER vs BEFORE',
    (key) => {
      expect(sub(after, key)).toBeGreaterThan(sub(before, key));
    },
  );

  it.each(['epochSafety', 'debtCorrectness', 'noDoubleCount', 'triggerExpiry'])(
    'regression guard %s does not drop AFTER vs BEFORE',
    (key) => {
      expect(sub(after, key)).toBeGreaterThanOrEqual(sub(before, key));
      expect(sub(after, key)).toBe(100); // and is fully correct
    },
  );

  it('every sub-score is reported with a weight and mover flag', () => {
    for (const s of after.subScores) {
      expect(typeof s.score).toBe('number');
      expect(s.weight).toBeGreaterThan(0);
      expect(typeof s.isMover).toBe('boolean');
    }
  });
});
