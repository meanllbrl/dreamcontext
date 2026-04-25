import { describe, it, expect } from 'vitest';
import {
  parseDailyBudget,
  parseScalePct,
  applyScale,
  formatBudget,
  BudgetMissingError,
  BudgetInvalidError,
} from '../../src/lib/marketing/budget.js';

describe('marketing/budget', () => {
  describe('parseDailyBudget', () => {
    it('parses a numeric string and returns minor units', () => {
      expect(parseDailyBudget('30', 'TRY')).toBe(3000);
      expect(parseDailyBudget('30.50', 'USD')).toBe(3050);
    });

    it('strips whitespace and commas', () => {
      expect(parseDailyBudget(' 1,000 ', 'TRY')).toBe(100000);
    });

    it('throws BudgetMissingError on missing input', () => {
      expect(() => parseDailyBudget(undefined, 'TRY')).toThrow(BudgetMissingError);
      expect(() => parseDailyBudget('', 'TRY')).toThrow(BudgetMissingError);
      expect(() => parseDailyBudget('   ', 'TRY')).toThrow(BudgetMissingError);
    });

    it('throws BudgetInvalidError on non-number', () => {
      expect(() => parseDailyBudget('abc', 'TRY')).toThrow(BudgetInvalidError);
    });

    it('throws BudgetInvalidError on zero or negative', () => {
      expect(() => parseDailyBudget('0', 'TRY')).toThrow(BudgetInvalidError);
      expect(() => parseDailyBudget('-5', 'TRY')).toThrow(BudgetInvalidError);
    });
  });

  describe('parseScalePct', () => {
    it('parses positive and negative percents', () => {
      expect(parseScalePct('+20')).toBeCloseTo(1.2);
      expect(parseScalePct('20')).toBeCloseTo(1.2);
      expect(parseScalePct('-15')).toBeCloseTo(0.85);
    });

    it('rejects out-of-range values (snow-globe rule)', () => {
      expect(() => parseScalePct('+501')).toThrow(BudgetInvalidError);
      expect(() => parseScalePct('-51')).toThrow(BudgetInvalidError);
    });

    it('rejects non-numeric input', () => {
      expect(() => parseScalePct('hot')).toThrow(BudgetInvalidError);
    });
  });

  describe('applyScale', () => {
    it('scales a budget by percent', () => {
      expect(applyScale(1000, 20)).toBe(1200);
      expect(applyScale(1000, -15)).toBe(850);
    });

    it('rounds to integer minor units', () => {
      expect(applyScale(1000, 33.33)).toBe(1333);
    });

    it('throws on non-positive current budget', () => {
      expect(() => applyScale(0, 20)).toThrow(BudgetInvalidError);
      expect(() => applyScale(-100, 20)).toThrow(BudgetInvalidError);
    });
  });

  describe('formatBudget', () => {
    it('formats minor units back to a display string', () => {
      expect(formatBudget(3000, 'TRY')).toBe('30.00 TRY');
      expect(formatBudget(99, 'USD')).toBe('0.99 USD');
    });
  });
});
