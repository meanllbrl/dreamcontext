import { describe, it, expect } from 'vitest';
import { computeRiceScore, validateRiceInput, normalizeRice, mergeRice } from '../../src/lib/rice.js';

describe('computeRiceScore', () => {
  it('returns null when any input is missing', () => {
    expect(computeRiceScore({ reach: null, impact: 3, confidence: 75, effort: 2 })).toBeNull();
    expect(computeRiceScore({ reach: 5, impact: null, confidence: 75, effort: 2 })).toBeNull();
    expect(computeRiceScore({ reach: 5, impact: 3, confidence: null, effort: 2 })).toBeNull();
    expect(computeRiceScore({ reach: 5, impact: 3, confidence: 75, effort: null })).toBeNull();
  });

  it('computes score for typical values', () => {
    // (5 * 3 * 1.00) / 2 = 7.5
    expect(computeRiceScore({ reach: 5, impact: 3, confidence: 100, effort: 2 })).toBe(7.5);
  });

  it('rounds score to 2 decimals', () => {
    // (7 * 4 * 0.75) / 3 = 7
    expect(computeRiceScore({ reach: 7, impact: 4, confidence: 75, effort: 3 })).toBe(7);
    // (1 * 1 * 0.25) / 0.5 = 0.5
    expect(computeRiceScore({ reach: 1, impact: 1, confidence: 25, effort: 0.5 })).toBe(0.5);
    // (3 * 2 * 0.5) / 7 ≈ 0.4285... -> 0.43
    expect(computeRiceScore({ reach: 3, impact: 2, confidence: 50, effort: 7 })).toBe(0.43);
  });

  it('guards against effort = 0 (returns null, not Infinity)', () => {
    expect(computeRiceScore({ reach: 5, impact: 3, confidence: 75, effort: 0 })).toBeNull();
  });

  it('guards against negative effort', () => {
    expect(computeRiceScore({ reach: 5, impact: 3, confidence: 75, effort: -1 })).toBeNull();
  });

  it('handles fractional effort (0.5 weeks)', () => {
    // (10 * 5 * 1.0) / 0.5 = 100
    expect(computeRiceScore({ reach: 10, impact: 5, confidence: 100, effort: 0.5 })).toBe(100);
  });
});

describe('validateRiceInput', () => {
  it('accepts a fully valid input', () => {
    expect(validateRiceInput({ reach: 5, impact: 3, confidence: 75, effort: 2 })).toEqual([]);
  });

  it('accepts boundary values', () => {
    expect(validateRiceInput({ reach: 1, impact: 1, confidence: 25, effort: 0.5 })).toEqual([]);
    expect(validateRiceInput({ reach: 10, impact: 5, confidence: 100, effort: 52 })).toEqual([]);
  });

  it('rejects out-of-range reach', () => {
    expect(validateRiceInput({ reach: 0 }).length).toBeGreaterThan(0);
    expect(validateRiceInput({ reach: 11 }).length).toBeGreaterThan(0);
    expect(validateRiceInput({ reach: 1.5 }).length).toBeGreaterThan(0);
  });

  it('rejects out-of-range impact', () => {
    expect(validateRiceInput({ impact: 0 }).length).toBeGreaterThan(0);
    expect(validateRiceInput({ impact: 6 }).length).toBeGreaterThan(0);
  });

  it('rejects confidence not in {25,50,75,100}', () => {
    expect(validateRiceInput({ confidence: 0 }).length).toBeGreaterThan(0);
    expect(validateRiceInput({ confidence: 60 }).length).toBeGreaterThan(0);
    expect(validateRiceInput({ confidence: 80 }).length).toBeGreaterThan(0);
    expect(validateRiceInput({ confidence: 101 }).length).toBeGreaterThan(0);
  });

  it('rejects effort outside (0, 52]', () => {
    expect(validateRiceInput({ effort: 0 }).length).toBeGreaterThan(0);
    expect(validateRiceInput({ effort: -1 }).length).toBeGreaterThan(0);
    expect(validateRiceInput({ effort: 53 }).length).toBeGreaterThan(0);
  });

  it('rejects NaN', () => {
    expect(validateRiceInput({ reach: NaN }).length).toBeGreaterThan(0);
    expect(validateRiceInput({ effort: NaN }).length).toBeGreaterThan(0);
  });

  it('allows null (clear)', () => {
    expect(validateRiceInput({ reach: null, impact: null, confidence: null, effort: null })).toEqual([]);
  });
});

describe('normalizeRice', () => {
  it('returns null for empty/missing input', () => {
    expect(normalizeRice(undefined)).toBeNull();
    expect(normalizeRice(null)).toBeNull();
    expect(normalizeRice({})).toBeNull();
  });

  it('returns block with score when complete', () => {
    const result = normalizeRice({ reach: 5, impact: 3, confidence: 100, effort: 2 });
    expect(result).toEqual({ reach: 5, impact: 3, confidence: 100, effort: 2, score: 7.5 });
  });

  it('returns block with null score when partial', () => {
    const result = normalizeRice({ reach: 5, impact: 3 });
    expect(result).toEqual({ reach: 5, impact: 3, confidence: null, effort: null, score: null });
  });
});

describe('mergeRice', () => {
  it('creates a new block from empty', () => {
    const result = mergeRice(null, { reach: 5, impact: 3, confidence: 100, effort: 2 });
    expect(result?.score).toBe(7.5);
  });

  it('updates a single field, recomputes score', () => {
    const existing = { reach: 5, impact: 3, confidence: 100, effort: 2, score: 7.5 };
    const result = mergeRice(existing, { effort: 4 });
    expect(result?.effort).toBe(4);
    expect(result?.score).toBe(3.75); // (5*3*1.0)/4 = 3.75
  });

  it('clears one field at a time via null', () => {
    const existing = { reach: 5, impact: 3, confidence: 100, effort: 2, score: 7.5 };
    const result = mergeRice(existing, { effort: null });
    expect(result?.effort).toBeNull();
    expect(result?.score).toBeNull();
    expect(result?.reach).toBe(5);
  });

  it('returns null when all 4 inputs end up null', () => {
    const existing = { reach: 5, impact: null, confidence: null, effort: null, score: null };
    expect(mergeRice(existing, { reach: null })).toBeNull();
  });
});
