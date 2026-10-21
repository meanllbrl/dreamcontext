/**
 * Reviewers that hit their maxTurns used to end with no verdict, and the Develop child waited
 * on nothing (field, 2026-10-21). Each one now has a limit sized from the last ten real reviews
 * and a PARTIAL exit two turns before it, and the recipe treats PARTIAL as a narrowed re-run.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEVELOP_RECIPE, FAN_OUT_RECIPE } from '../../src/lib/develop-recipe.js';

const AGENTS = path.resolve(__dirname, '../../skill-packs/agents');
const read = (f: string) => fs.readFileSync(path.join(AGENTS, `${f}.md`), 'utf8');
const maxTurns = (f: string) => Number(/^maxTurns:\s*(\d+)$/m.exec(read(f))?.[1]);

describe('reviewer turn budgets', () => {
  // Measured 2026-10-21 over the last 10 runs per agent in Tilki and dreamcontext:
  // specialists p50 13-15, max 27; reviewer max 22; router max 6.
  it.each([
    ['review-edge-cases', 24], ['review-frontend', 24], ['review-security', 24],
    ['review-cloud-functions', 24], ['reviewer', 30], ['review-router', 12],
  ])('%s has maxTurns %i', (agent, n) => {
    expect(maxTurns(agent)).toBe(n);
  });

  it.each(['review-edge-cases', 'review-frontend', 'review-security', 'review-cloud-functions'])(
    '%s returns PARTIAL with a Not reviewed list before the limit',
    (agent) => {
      const body = read(agent);
      expect(body).toContain('PARTIAL');
      expect(body).toContain('Not reviewed:');
      expect(body).toContain(`Turn budget (${maxTurns(agent)})`);
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
