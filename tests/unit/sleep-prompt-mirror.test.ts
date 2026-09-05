import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SLEEP_AGENT_PROMPT } from '../../src/lib/sleep-prompt.js';

/**
 * The dashboard's Sleep button and the background auto-sleep dispatcher must
 * ask for the SAME consolidation. The dashboard cannot import from `src/`, so
 * it keeps a copy — and a copy that drifts means a background sleep quietly
 * doing something other than what the button does, which is exactly the kind of
 * divergence nobody would notice until it mattered.
 *
 * Same guard, same reason, as `dashboard-sleep-thresholds.test.ts`.
 */

const MIRROR = join(__dirname, '..', '..', 'dashboard', 'src', 'lib', 'sleepAgent.ts');

/** Reconstruct the concatenated string literal the dashboard declares. */
function readMirroredPrompt(source: string): string {
  const start = source.indexOf('export const SLEEP_AGENT_PROMPT =');
  if (start < 0) throw new Error('SLEEP_AGENT_PROMPT not found in the dashboard mirror');
  const end = source.indexOf(';', source.indexOf("consolidated.'", start));
  const body = source.slice(source.indexOf('=', start) + 1, end);
  return [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
    .map((m) => m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
    .join('');
}

describe('the sleep prompt mirror', () => {
  const source = readFileSync(MIRROR, 'utf8');

  it('the dashboard copy is byte-identical to src/lib/sleep-prompt.ts', () => {
    expect(readMirroredPrompt(source)).toBe(SLEEP_AGENT_PROMPT);
  });

  it('and still asks for the sub-agent fan-out explicitly', () => {
    // The standing "don't call the Agent tool unless asked" rule makes this
    // sentence load-bearing, not decorative — without it the cycle runs inline.
    expect(SLEEP_AGENT_PROMPT).toContain('explicitly requesting the sub-agent fan-out');
    expect(SLEEP_AGENT_PROMPT).toContain('sleep start');
    expect(SLEEP_AGENT_PROMPT).toContain('sleep done');
  });

  it('says the mirror is a mirror, so the next editor knows', () => {
    expect(source).toContain('src/lib/sleep-prompt.ts');
  });
});
