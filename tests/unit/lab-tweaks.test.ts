import { describe, it, expect } from 'vitest';
import { resolveTweaks, parseRelativeRange } from '../../src/lib/lab/tweaks.js';
import type { InsightManifest } from '../../src/lib/lab/types.js';

function manifest(tweaks: InsightManifest['tweaks']): InsightManifest {
  return {
    slug: 'x',
    title: 'X',
    description: null,
    group: null,
    render: 'number',
    source: null,
    refresh: { ttl_minutes: 1440 },
    tweaks,
    binding: null,
    credentials_used: [],
    unit: null,
    path: '/tmp/x.md',
    body: '',
  };
}

const NOW = new Date('2026-07-05T12:00:00Z');

describe('parseRelativeRange', () => {
  it('parses last_30_days / last_1_year', () => {
    expect(parseRelativeRange('last_30_days')).toBe(30);
    expect(parseRelativeRange('last_1_year')).toBe(365);
  });
  it('returns null for a non-relative value', () => {
    expect(parseRelativeRange('2026-01-01')).toBeNull();
    expect(parseRelativeRange('garbage')).toBeNull();
  });
});

describe('resolveTweaks — relative range maps to a ~N-day window', () => {
  it('last_1_year maps to a ~365-day window', () => {
    const m = manifest([{ key: 'range', type: 'enum', options: ['last_30_days', 'last_1_year'], value: 'last_1_year' }]);
    const resolved = resolveTweaks(m, NOW);
    expect(resolved.spanDays).toBe(365);
    expect(resolved.range.toISO).toBe('2026-07-05');
  });

  it('last_30_days maps to a ~30-day window', () => {
    const m = manifest([{ key: 'range', type: 'enum', options: ['last_30_days'], value: 'last_30_days' }]);
    const resolved = resolveTweaks(m, NOW);
    expect(resolved.spanDays).toBe(30);
  });

  it('explicit from/to date tweaks OVERRIDE the range enum', () => {
    const m = manifest([
      { key: 'range', type: 'enum', options: ['last_30_days'], value: 'last_30_days' },
      { key: 'from', type: 'date', value: '2026-01-01' },
      { key: 'to', type: 'date', value: '2026-02-01' },
    ]);
    const resolved = resolveTweaks(m, NOW);
    expect(resolved.range.fromISO).toBe('2026-01-01');
    expect(resolved.range.toISO).toBe('2026-02-01');
    expect(resolved.spanDays).toBe(31);
  });

  it('falls back to a 30-day trailing window when nothing is declared', () => {
    const m = manifest([]);
    const resolved = resolveTweaks(m, NOW);
    expect(resolved.spanDays).toBe(30);
  });

  it('unknown tweak keys pass through in `values`', () => {
    const m = manifest([{ key: 'region', type: 'string', value: 'eu' }]);
    const resolved = resolveTweaks(m, NOW);
    expect(resolved.values.region).toBe('eu');
  });

  it('uses the declared default when no value is set', () => {
    const m = manifest([{ key: 'range', type: 'enum', options: ['last_30_days'], default: 'last_30_days' }]);
    const resolved = resolveTweaks(m, NOW);
    expect(resolved.spanDays).toBe(30);
  });
});
