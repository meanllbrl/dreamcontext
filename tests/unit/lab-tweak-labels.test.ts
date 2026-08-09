/**
 * Humanized tweak labels — the dashboard never shows a raw manifest key.
 *
 * The helper's relative-range grammar has to stay in lockstep with the ENGINE's
 * (`parseRelativeRange`): anything the engine accepts as a window must render as
 * a sentence, not fall through to the snake_case fallback. That parity is the
 * point of the last test here.
 */
import { describe, it, expect } from 'vitest';
import { parseRelativeRange } from '../../src/lib/lab/tweaks.js';
import {
  humanizeTweakKey,
  humanizeTweakValue,
} from '../../dashboard/src/components/lab/tweakLabels.js';

describe('humanizeTweakValue', () => {
  it('renders relative ranges as English sentences', () => {
    expect(humanizeTweakValue('last_7_days', 'en')).toBe('Last 7 days');
    expect(humanizeTweakValue('last_28_days', 'en')).toBe('Last 28 days');
    expect(humanizeTweakValue('last_3_months', 'en')).toBe('Last 3 months');
  });

  it('drops the numeral at 1 in English, keeps it in Turkish', () => {
    expect(humanizeTweakValue('last_1_year', 'en')).toBe('Last year');
    expect(humanizeTweakValue('last_1_week', 'en')).toBe('Last week');
    expect(humanizeTweakValue('last_1_year', 'tr')).toBe('Son 1 yıl');
    expect(humanizeTweakValue('last_7_days', 'tr')).toBe('Son 7 gün');
    expect(humanizeTweakValue('last_3_months', 'tr')).toBe('Son 3 ay');
  });

  it('falls back to Title Case for other enum values', () => {
    expect(humanizeTweakValue('new_users', 'en')).toBe('New Users');
    expect(humanizeTweakValue('weekly', 'en')).toBe('Weekly');
  });

  it('leaves data-shaped tokens alone (acronyms, codes, dates)', () => {
    expect(humanizeTweakValue('US', 'en')).toBe('US');
    expect(humanizeTweakValue('2026-01-31', 'en')).toBe('2026-01-31');
  });

  it('translates the known custom-range value', () => {
    expect(humanizeTweakValue('custom', 'en')).toBe('Custom');
    expect(humanizeTweakValue('custom', 'tr')).toBe('Özel');
  });

  it('defaults to English for an unknown or absent locale', () => {
    expect(humanizeTweakValue('last_7_days')).toBe('Last 7 days');
    expect(humanizeTweakValue('last_7_days', 'de')).toBe('Last 7 days');
    expect(humanizeTweakValue('', 'en')).toBe('');
  });
});

describe('humanizeTweakKey', () => {
  it('names the well-known window keys', () => {
    expect(humanizeTweakKey('range', 'en')).toBe('Date range');
    expect(humanizeTweakKey('range', 'tr')).toBe('Tarih aralığı');
    expect(humanizeTweakKey('from', 'en')).toBe('From');
  });

  it('Title Cases anything else', () => {
    expect(humanizeTweakKey('utm_source', 'en')).toBe('Utm Source');
    expect(humanizeTweakKey('', 'en')).toBe('');
  });
});

describe('grammar parity with the engine', () => {
  const ENGINE_ACCEPTS = [
    'last_1_day', 'last_2_days', 'last_1_week', 'last_6_weeks',
    'last_1_month', 'last_12_months', 'last_1_year', 'last_2_years',
  ];

  it('humanizes every range shape the engine resolves', () => {
    for (const value of ENGINE_ACCEPTS) {
      expect(parseRelativeRange(value), `${value} must be a window`).not.toBeNull();
      for (const lang of ['en', 'tr']) {
        const label = humanizeTweakValue(value, lang);
        expect(label, `${value} (${lang}) fell through to Title Case`).not.toMatch(/_/);
        expect(label.toLowerCase()).not.toContain('last_');
      }
    }
  });

  it('leaves a value the engine rejects to the Title Case fallback', () => {
    expect(parseRelativeRange('last_0_days')).toBeNull();
    expect(humanizeTweakValue('last_0_days', 'en')).toBe('Last 0 Days');
  });
});
