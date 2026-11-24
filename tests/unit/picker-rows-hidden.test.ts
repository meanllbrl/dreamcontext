import { describe, it, expect } from 'vitest';
import { shortcutFor, splitPickerRows } from '../../dashboard/src/lib/pickerRows.js';

const r = (name: string, o: { hidden?: boolean; active?: boolean } = {}) => ({ name, active: !!o.active, hidden: !!o.hidden });
const rows = [r('a'), r('b', { hidden: true }), r('c'), r('d', { hidden: true, active: true }), r('e'), r('f', { hidden: true })];
const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe('project picker and hidden projects', () => {
  it('hidden projects fold into their own section, in order', () => {
    const s = splitPickerRows(rows, '');
    expect(names(s.shown)).toEqual(['a', 'c', 'd', 'e']);
    expect(names(s.hidden)).toEqual(['b', 'f']);
  });
  it('the project on screen stays in the main list even when hidden', () => {
    expect(names(splitPickerRows(rows, '').hidden)).not.toContain('d');
  });
  it('a typed name finds any project in one flat list, hidden ones too', () => {
    const s = splitPickerRows(rows, ' B ');
    expect(names(s.shown)).toEqual(['b']);
    expect(s.hidden).toEqual([]);
  });
  it('cmd numbers go to shown projects only, in order; hidden ones have none', () => {
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => shortcutFor(rows, n))).toEqual([1, null, 2, null, 3, null]);
  });
  it('no number past nine', () => {
    const many = Array.from({ length: 11 }, (_, i) => r(`p${i}`));
    expect(shortcutFor(many, 'p9')).toBeNull();
    expect(shortcutFor(many, 'p8')).toBe(9);
  });
});
