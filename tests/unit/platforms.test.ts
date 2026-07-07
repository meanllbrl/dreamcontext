import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PLATFORMS,
  ensurePlatformSelection,
  formatSupportedPlatforms,
  normalizePlatforms,
  parsePlatformList,
} from '../../src/lib/platforms.js';

describe('platform helpers', () => {
  it('normalizes, de-duplicates, and drops unsupported platform ids', () => {
    // 'codex' is no longer a supported platform → treated as invalid and dropped.
    expect(normalizePlatforms(['Claude', 'claude', 'codex', 'bad'])).toEqual(['claude']);
  });

  it('parses comma-separated lists and reports invalid tokens', () => {
    const parsed = parsePlatformList('claude,codex,unknown');
    expect(parsed.platforms).toEqual(['claude']);
    expect(parsed.invalid).toEqual(['codex', 'unknown']);
  });

  it('falls back to default platform when selection is empty', () => {
    expect(ensurePlatformSelection([])).toEqual(DEFAULT_PLATFORMS);
  });

  it('returns a stable supported-platform label', () => {
    expect(formatSupportedPlatforms()).toBe('claude');
  });
});
