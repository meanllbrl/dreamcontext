import { describe, it, expect } from 'vitest';
import { clearBoardHash, formatBoardHash, parseBoardHash } from '../../dashboard/src/pages/whiteboards/boardHash.js';

describe('the board in the URL hash', () => {
  it('round-trips the board', () => {
    expect(formatBoardHash('b1')).toBe('#wb=b1');
    expect(parseBoardHash(formatBoardHash('control-panel'))).toBe('control-panel');
    expect(parseBoardHash('wb=b1')).toBe('b1');
  });

  it('ignores the old wiki params and drops them on the next write', () => {
    expect(parseBoardHash('#wb=b1&wbmode=wiki&wbpage=features%2Fx')).toBe('b1');
    expect(formatBoardHash('b1', '#wb=b0&wbmode=wiki&wbpage=features%2Fx')).toBe('#wb=b1');
    expect(clearBoardHash('#wb=b1&wbmode=wiki')).toBe('');
  });

  it('keeps other hash params, and clearing removes only the board', () => {
    const h = formatBoardHash('b1', '#other=1');
    expect(new URLSearchParams(h.slice(1)).get('other')).toBe('1');
    expect(parseBoardHash(h)).toBe('b1');
    expect(clearBoardHash(h)).toBe('#other=1');
    expect(clearBoardHash('#other=1&wbpage=x')).toBe('#other=1');
  });

  it('rejects bad slugs', () => {
    expect(parseBoardHash('')).toBeNull();
    expect(parseBoardHash('#other=1')).toBeNull();
    expect(parseBoardHash('#wb=Bad%20Slug')).toBeNull();
    expect(parseBoardHash('#wb=..%2Fsecret')).toBeNull();
    expect(parseBoardHash('#wb=-leading')).toBeNull();
    expect(parseBoardHash(`#wb=${'a'.repeat(65)}`)).toBeNull();
    expect(formatBoardHash('Bad Slug', '#other=1')).toBe('#other=1');
    expect(formatBoardHash(null)).toBe('');
  });
});
