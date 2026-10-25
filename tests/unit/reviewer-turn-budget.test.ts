/**
 * Reviewers that hit their maxTurns used to end with no verdict (field, 2026-10-21), and the
 * 2026-10-25 timing research found the plan critic at maxTurns 25 in 3 of 4 plans, back with no
 * report. The owner removed the step limit from every reviewer. PARTIAL stays as the exit for a
 * run that truly cannot finish, and the recipe still treats it as a narrowed re-run.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEVELOP_RECIPE, FAN_OUT_RECIPE } from '../../src/lib/develop-recipe.js';

const AGENTS = path.resolve(__dirname, '../../skill-packs/agents');
const read = (f: string) => fs.readFileSync(path.join(AGENTS, `${f}.md`), 'utf8');
const hasMaxTurns = (f: string) => /^maxTurns:/m.test(read(f));

describe('reviewers have no turn limit', () => {
  it.each([
    'goal-plan-reviewer', 'reviewer', 'review-router', 'review-edge-cases', 'review-frontend',
    'review-security', 'review-cloud-functions',
  ])('%s sets no maxTurns', (agent) => {
    expect(hasMaxTurns(agent)).toBe(false);
  });

  it.each(['review-edge-cases', 'review-frontend', 'review-security', 'review-cloud-functions'])(
    '%s returns PARTIAL with a Not reviewed list when it truly cannot finish',
    (agent) => {
      const body = read(agent);
      expect(body).toContain('PARTIAL');
      expect(body).toContain('Not reviewed:');
      expect(body).toContain('No turn limit');
    },
  );

  it('reviewer has a PARTIAL output shape', () => {
    expect(read('reviewer')).toMatch(/## Review: PARTIAL[\s\S]*Not reviewed:/);
  });

  it('router emits a partial plan instead of no JSON', () => {
    expect(read('review-router')).toContain('"partial": true');
  });

  it('the shared rubric defines PARTIAL as a re-run, not a PASS', () => {
    const shared = fs.readFileSync(path.resolve(__dirname, '../../skill-packs/multi-review/REVIEWER_SHARED.md'), 'utf8');
    expect(shared).toContain('PASS | CONCERNS | FAIL | PARTIAL');
    expect(shared).toMatch(/PARTIAL` is never read as `PASS`/);
  });

  it.each([['develop', DEVELOP_RECIPE], ['fan-out', FAN_OUT_RECIPE]])(
    'the %s recipe re-runs a PARTIAL on its unread paths',
    (_n, recipe) => {
      expect(recipe).toContain('A PARTIAL verdict');
      expect(recipe).toContain('`Not reviewed:` paths only');
      expect(recipe).toContain('a PARTIAL is never a PASS');
    },
  );
});
