import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PLATFORMS,
  ensurePlatformSelection,
  formatSupportedPlatforms,
  normalizePlatforms,
  parsePlatformList,
} from '../../src/lib/platforms.js';

describe('platform helpers', () => {
  it('normalizes and de-duplicates platform ids', () => {
    expect(normalizePlatforms(['Codex', 'claude', 'codex', 'bad'])).toEqual(['codex', 'claude']);
  });

  it('parses comma-separated lists and reports invalid tokens', () => {
    const parsed = parsePlatformList('claude,codex,unknown');
    expect(parsed.platforms).toEqual(['claude', 'codex']);
    expect(parsed.invalid).toEqual(['unknown']);
  });

  it('falls back to default platform when selection is empty', () => {
    expect(ensurePlatformSelection([])).toEqual(DEFAULT_PLATFORMS);
  });

  it('returns a stable supported-platform label', () => {
    expect(formatSupportedPlatforms()).toBe('claude, codex');
  });
});
