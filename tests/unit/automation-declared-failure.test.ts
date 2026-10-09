/**
 * A run that cannot do its job ends itself as failed with a `RUN FAILED: <why>`
 * line (the funnel explorer's refresh contract: no KB tools, no snapshot). The
 * pure reader is tested directly; where it sits in the runner is pinned by
 * source shape (this repo runs no headless claude in unit tests), right after
 * the usage-limit gate so a declared failure never publishes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_FAILED_PREFIX, declaredRunFailure } from '../../src/lib/automations/runner.js';

describe('declaredRunFailure', () => {
  it('reads the reason from a first-line declaration', () => {
    expect(RUN_FAILED_PREFIX).toBe('RUN FAILED:');
    expect(declaredRunFailure('RUN FAILED: KB tools missing (kb_chart_query)\n\nDetails follow.')).toBe('KB tools missing (kb_chart_query)');
  });

  it('accepts the declaration among the first five non-empty lines, trimmed', () => {
    const text = '\n\n# Refresh\nPulled nothing.\n\n   RUN FAILED:   snapshot not refreshed   \nmore';
    expect(declaredRunFailure(text)).toBe('snapshot not refreshed');
  });

  it('ignores a declaration after the fifth non-empty line', () => {
    const text = ['one', 'two', 'three', 'four', 'five', 'RUN FAILED: too late'].join('\n');
    expect(declaredRunFailure(text)).toBeNull();
  });

  it('a bare prefix still fails, with a generic reason', () => {
    expect(declaredRunFailure('RUN FAILED:')).toBe('the run declared itself failed');
  });

  it('caps the reason at 300 characters', () => {
    const reason = declaredRunFailure(`RUN FAILED: ${'x'.repeat(500)}`);
    expect(reason).toHaveLength(300);
  });

  it('a normal report, a mid-line mention or an empty result is not a declaration', () => {
    expect(declaredRunFailure('All funnels refreshed.')).toBeNull();
    expect(declaredRunFailure('The prompt says to write RUN FAILED: when tools are missing.')).toBeNull();
    expect(declaredRunFailure('')).toBeNull();
    expect(declaredRunFailure(undefined as unknown as string)).toBeNull();
  });
});

describe('the runner honours a declared failure', () => {
  const src = readFileSync(join(import.meta.dirname, '../../src/lib/automations/runner.ts'), 'utf-8');

  it('the declared-failure arm sits directly after the usage-limit arm and sets status failed', () => {
    const limitArm = src.indexOf('if (claudeResult.limit) {');
    const declaredArm = src.indexOf("} else if (status === 'ok' && declaredRunFailure(claudeResult.result ?? '') !== null) {");
    const hitlArm = src.indexOf("} else if (status === 'ok' && flow.needsHitl");
    expect(limitArm).toBeGreaterThan(-1);
    expect(declaredArm).toBeGreaterThan(limitArm);
    expect(hitlArm).toBeGreaterThan(declaredArm);
    const arm = src.slice(declaredArm, hitlArm);
    expect(arm).toContain("status = 'failed';");
    expect(arm).toContain('error = declaredRunFailure(');
    // Nothing publishes from this arm: the output write lives in the chain's last arm.
    expect(arm).not.toContain('writeFileSync');
  });
});
