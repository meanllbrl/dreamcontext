/**
 * An automation's fire prompt gets no judged recall in the prompt hook (the runner wrote it, the same
 * text every fire). Drift-locked to the runner: the prefix the hook tests is the one buildPreamble
 * writes, so a reworded preamble cannot quietly turn recall back on (or off for owner text).
 */
import { describe, it, expect } from 'vitest';
import { buildPreamble } from '../../src/lib/automations/runner.js';
import { buildThreadMessagePreamble } from '../../src/lib/automations/verdict.js';
import { AUTOMATION_FIRE_PREFIX, isAutomationFirePrompt } from '../../src/lib/automations/fire-prompt.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

const manifest = (mode: 'call' | 'schedule'): AutomationManifest =>
  ({ slug: 'recipe-weekly', title: 'Recipe weekly', mode, schedule: null, review: 'off' }) as unknown as AutomationManifest;

describe('isAutomationFirePrompt', () => {
  it('recognises what buildPreamble writes, for every mode', () => {
    for (const m of [manifest('call'), manifest('schedule')]) {
      const p = buildPreamble(m, '/tmp/demo-project', new Date('2030-01-02T03:04:05Z'), '/tmp/out.md');
      expect(p.startsWith(AUTOMATION_FIRE_PREFIX)).toBe(true);
      expect(isAutomationFirePrompt(p + '\n--- THIS JOB ---\nSummarise the recipe sales.')).toBe(true);
      expect(isAutomationFirePrompt('\n  ' + p)).toBe(true);
    }
  });

  it('an owner turn, a thread reply or a quote of the preamble is not a fire', () => {
    expect(isAutomationFirePrompt('why did the recipe automation fail last night?')).toBe(false);
    expect(isAutomationFirePrompt(buildThreadMessagePreamble('rerun it with the new prices', manifest('call')))).toBe(false);
    expect(isAutomationFirePrompt(`look at this: ${AUTOMATION_FIRE_PREFIX}Recipe weekly" in /tmp/x`)).toBe(false);
    expect(isAutomationFirePrompt('')).toBe(false);
  });
});
