/**
 * The language context that replaced the sticky pin (task sesli-giris-bozuk…, AC1/AC9).
 */

import { describe, it, expect } from 'vitest';
import { contextFor, normalizeLanguage, type ContextTake } from '../../src/lib/voice/languageContext.js';

const NOW = 1_800_000_000_000;
const take = (language: string | null, over: Partial<ContextTake> = {}): ContextTake => ({
  language, quality: 'clean', createdAt: NOW - 60_000, chars: 20, ...over,
});

describe('normalizeLanguage', () => {
  it('maps codes, whisper names and locales to a code from the table', () => {
    expect(normalizeLanguage('tr')).toBe('tr');
    expect(normalizeLanguage('Turkish')).toBe('tr');
    expect(normalizeLanguage(' icelandic ')).toBe('is');
    expect(normalizeLanguage('tr-TR')).toBe('tr');
    expect(normalizeLanguage('en_US')).toBe('en');
  });

  it('refuses anything else: auto, a path, an injection, an unknown name, a non-string', () => {
    for (const bad of ['auto', '../x', 'tr;x', 'klingon', '', 'tr tr', 42, null, undefined, {}]) {
      expect(normalizeLanguage(bad), String(bad)).toBeNull();
    }
  });
});

describe('contextFor', () => {
  it('AC1: an Icelandic misdetection (not clean) never becomes the next take\'s language', () => {
    const ctx = contextFor({
      cfg: {}, now: NOW, conv: 'c1',
      takes: [take('is', { quality: 'garbled', conv: 'c1' }), take('is', { quality: 'suspect', conv: 'c1' }), take('tr', { conv: 'c1' })],
    });
    expect(ctx.primary).toBeNull();
    expect(ctx.set).not.toContain('is');
  });

  it('AC1: a NEW conversation where 2 of the last 3 clean takes (global, < 24 h) are tr pins pass 1 to tr', () => {
    const ctx = contextFor({ cfg: {}, now: NOW, conv: 'fresh', takes: [take('tr', { conv: 'a' }), take('en', { conv: 'b' }), take('tr', { conv: 'c' })] });
    expect(ctx.primary).toBe('tr');
  });

  it('this conversation\'s takes come before the global ones', () => {
    const ctx = contextFor({
      cfg: {}, now: NOW, conv: 'c1',
      takes: [take('en', { conv: 'c1' }), take('tr', { conv: 'x' }), take('en', { conv: 'c1' }), take('tr', { conv: 'y' })],
    });
    expect(ctx.primary).toBe('en');
    expect(ctx.set[0]).toBe('en');
  });

  it('takes older than 24 h do not count', () => {
    const old = { createdAt: NOW - 25 * 3600_000 };
    expect(contextFor({ cfg: {}, now: NOW, takes: [take('tr', old), take('tr', old)] }).primary).toBeNull();
  });

  it('a hard pin wins; exactly one Settings language pins too; the UI language only joins the set', () => {
    expect(contextFor({ cfg: { sttLanguage: 'en' }, now: NOW, takes: [take('tr'), take('tr')] }).primary).toBe('en');
    expect(contextFor({ cfg: { sttLanguages: ['de'] }, now: NOW, takes: [] }).primary).toBe('de');
    expect(contextFor({ cfg: { sttLanguages: ['de', 'tr'] }, now: NOW, takes: [] }).primary).toBeNull();
    const ui = contextFor({ cfg: {}, uiLang: 'tr-TR', now: NOW, takes: [] });
    expect(ui).toEqual({ primary: null, set: ['tr'] });
  });

  it('`auto` is no pin', () => {
    expect(contextFor({ cfg: { sttLanguage: 'auto' }, now: NOW, takes: [] }).primary).toBeNull();
  });

  it('stored values are re-validated on read: a forged language in a sidecar is dropped', () => {
    const ctx = contextFor({ cfg: { sttLanguages: ['../etc'] }, now: NOW, takes: [take('../x'), take('tr;x'), take('tr')] });
    expect(ctx.set).toEqual(['tr']);
  });
});
