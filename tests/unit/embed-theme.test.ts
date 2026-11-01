import { describe, it, expect } from 'vitest';
import { contrast, embedTokens } from '../../dashboard/src/components/embed/embedTheme';

describe('the frame in the app\'s colours', () => {
  it('derives a readable set from a dark background', () => {
    const t = embedTokens({ bg: '#101214' });
    expect(t['--color-bg']).toBe('#101214');
    for (const k of ['--color-text', '--color-text-secondary', '--color-text-tertiary', '--color-text-placeholder']) {
      expect(contrast(t[k], '#101214'), k).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('a light background stays light', () => {
    const t = embedTokens({ bg: '#fafaf7' });
    expect(contrast(t['--color-text'], '#fafaf7')).toBeGreaterThanOrEqual(4.5);
    expect(parseInt(t['--color-text'].slice(1, 3), 16)).toBeLessThan(80);
  });
  it('drops a pair under 4.5:1', () => {
    const t = embedTokens({ bg: '#101214', text: '#202224', accent: '#15171a', surface: '#f0f0f0' });
    expect(t['--color-text']).not.toBe('#202224');
    expect(t['--color-accent']).toBeUndefined();
    expect(t['--color-bg-secondary']).not.toBe('#f0f0f0');
  });
  it('keeps a good pair', () => {
    const t = embedTokens({ bg: '#101214', text: '#e8e8e8', accent: '#7ad7a8' });
    expect(t['--color-text']).toBe('#e8e8e8');
    expect(t['--color-accent']).toBe('#7ad7a8');
  });
  it('names no usable background, sets nothing', () => {
    expect(embedTokens({})).toEqual({});
    expect(embedTokens({ bg: 'red' })).toEqual({});
  });
});
