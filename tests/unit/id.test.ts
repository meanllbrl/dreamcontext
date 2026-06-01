import { describe, it, expect, vi, afterEach } from 'vitest';

import { generateId, slugify, today } from '../../src/lib/id.js';

describe('id', () => {
  describe('generateId', () => {
    it('generates ID with given prefix', () => {
      const id = generateId('feat');
      expect(id).toMatch(/^feat_/);
    });

    it('generates 8-char suffix after prefix', () => {
      const id = generateId('test');
      // The suffix is everything after the first underscore. nanoid's default
      // alphabet is URL-safe (A-Za-z0-9_-), so the suffix itself can contain
      // '_' or '-' — splitting on '_' is wrong (was an intermittent flake).
      const suffix = id.slice('test_'.length);
      expect(suffix).toHaveLength(8);
      expect(suffix).toMatch(/^[A-Za-z0-9_-]{8}$/);
    });

    it('generates unique IDs on successive calls', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId('x')));
      expect(ids.size).toBe(100);
    });

    it('handles empty prefix', () => {
      const id = generateId('');
      expect(id).toMatch(/^_/);
    });

    it('handles prefix with special characters', () => {
      const id = generateId('my-prefix');
      expect(id.startsWith('my-prefix_')).toBe(true);
    });
  });

  describe('slugify', () => {
    it('lowercases and replaces spaces with hyphens', () => {
      expect(slugify('My Feature Name')).toBe('my-feature-name');
    });

    it('replaces special characters with hyphens', () => {
      expect(slugify('Hello World! @#$')).toBe('hello-world');
    });

    it('collapses multiple special chars into single hyphen', () => {
      expect(slugify('a   ---   b')).toBe('a-b');
    });

    it('trims leading/trailing hyphens', () => {
      expect(slugify('  --Hello--  ')).toBe('hello');
    });

    it('handles already-slugified input', () => {
      expect(slugify('already-slug')).toBe('already-slug');
    });

    it('handles empty string', () => {
      expect(slugify('')).toBe('');
    });

    it('handles numbers', () => {
      expect(slugify('Version 2.0')).toBe('version-2-0');
    });

    it('handles unicode characters', () => {
      // Unicode chars are not a-z0-9, so they become hyphens
      expect(slugify('Café Über')).toBe('caf-ber');
    });

    it('handles single word', () => {
      expect(slugify('hello')).toBe('hello');
    });

    it('handles all-special-chars input', () => {
      expect(slugify('!@#$%')).toBe('');
    });
  });

  describe('today', () => {
    it('returns date in YYYY-MM-DD format', () => {
      const result = today();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns correct current date', () => {
      const expected = new Date().toISOString().split('T')[0];
      expect(today()).toBe(expected);
    });
  });
});
