/**
 * `middleTruncate` (dashboard/src/lib/fileLabel.ts): the #agents file cards and the ask
 * preview's file line shorten a long name in the MIDDLE, because the end of an agent's file name
 * (the date, the version) is what tells two files apart and a CSS ellipsis cuts exactly that.
 */
import { describe, it, expect } from 'vitest';
import { middleTruncate } from '../../dashboard/src/lib/fileLabel.js';

describe('middleTruncate', () => {
  const LONG = 'quarterly_signup_funnel_analysis_for_the_growth_team_with_every_cohort_2026-q3_v02.pdf';

  it('keeps the last 12 characters of an 86-character name, extension included', () => {
    expect(LONG.length).toBe(86);
    const out = middleTruncate(LONG, 40);
    expect(out.length).toBe(40);
    expect(out.endsWith(LONG.slice(-12))).toBe(true);
    expect(out.startsWith('quarterly_')).toBe(true);
    expect(out).toContain('…');
  });

  it('leaves a name that already fits untouched', () => {
    expect(middleTruncate('report.pdf', 40)).toBe('report.pdf');
    expect(middleTruncate('x'.repeat(24), 24)).toBe('x'.repeat(24));
  });

  it('handles a name with no extension by keeping its end', () => {
    const out = middleTruncate('a-very-long-makefile-target-name-without-dots', 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('out-dots')).toBe(true);
  });

  it('never returns more than max, even when max is smaller than the kept tail', () => {
    const out = middleTruncate(LONG, 8);
    expect(out.length).toBe(8);
    expect(out.endsWith('v02.pdf')).toBe(true);
  });
});
