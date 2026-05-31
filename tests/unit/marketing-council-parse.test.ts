import { describe, it, expect } from 'vitest';
import { extractDebateIdFromCreateOutput } from '../../src/cli/commands/marketing/council.js';

/**
 * Regression guard for the `mk council` flake: debate IDs are
 * `council_${nanoid(8)}` and nanoid's default alphabet is URL-safe
 * (A-Za-z0-9_-). The extractor regex must accept `_` and `-` in the suffix,
 * otherwise it intermittently fails to parse perfectly-valid IDs (the cause of
 * the non-deterministic marketing-council integration failures).
 */
describe('extractDebateIdFromCreateOutput', () => {
  function createOutput(id: string): string {
    return [
      '  ◆ Marketing council',
      '  ───────────────────',
      'ℹ Personas: strategy-optimizer, risk-officer',
      `✓ Debate created: ${id}`,
      `  dir: _dream_context/council/${id}/`,
      '  rounds: 2  interrupt: no',
      id,
    ].join('\n');
  }

  it('parses an all-lowercase-alnum id', () => {
    expect(extractDebateIdFromCreateOutput(createOutput('council_ab3x9k2p'))).toBe('council_ab3x9k2p');
  });

  it('parses an id containing an underscore (the original flake)', () => {
    expect(extractDebateIdFromCreateOutput(createOutput('council_jatCT_NT'))).toBe('council_jatCT_NT');
  });

  it('parses an id containing a hyphen', () => {
    expect(extractDebateIdFromCreateOutput(createOutput('council_aB-9_xQ1'))).toBe('council_aB-9_xQ1');
  });

  it('parses an id with mixed case and digits', () => {
    expect(extractDebateIdFromCreateOutput(createOutput('council_Xy7Zk0Qp'))).toBe('council_Xy7Zk0Qp');
  });

  // Every character of nanoid's default alphabet must be accepted.
  it('accepts the full nanoid url-safe alphabet in the suffix', () => {
    const id = 'council_aZ09_-Ab'; // contains lower, upper, digits, underscore, hyphen
    expect(extractDebateIdFromCreateOutput(createOutput(id))).toBe(id);
  });

  it('returns null when no bare id line is present', () => {
    // Only decorated lines, no standalone `council_...` line → null.
    const out = ['✓ Debate created: council_abc', '  dir: _dream_context/council/council_abc/'].join('\n');
    expect(extractDebateIdFromCreateOutput(out)).toBeNull();
  });
});
