import { describe, it, expect } from 'vitest';
import { amendmentDiff } from '../../dashboard/src/components/aiteam/teamModel.js';

/** The owner judges a change from this, so a change must never read as nothing. */
describe('amendmentDiff', () => {
  it('shows an added line and a removed one', () => {
    expect(amendmentDiff('a\nb', 'a\nc')).toEqual([{ added: true, text: 'c' }, { added: false, text: 'b' }]);
  });
  it('shows a move: the natural fix for "it buried the failing lesson"', () => {
    expect(amendmentDiff('a\nb\nc', 'c\na\nb').length).toBeGreaterThan(0);
  });
  it('shows a dropped duplicate and a blank line', () => {
    expect(amendmentDiff('a\na', 'a')).toEqual([{ added: false, text: 'a' }]);
    expect(amendmentDiff('a\nb', 'a\n\nb')).toEqual([{ added: true, text: '' }]);
  });
  it('has nothing to say about the same text, and stays cheap on a huge one', () => {
    expect(amendmentDiff('a\nb', 'a\nb')).toEqual([]);
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    expect(amendmentDiff(big, `${big}\nmore`)).toEqual([{ added: true, text: 'more' }]);
  });
});
