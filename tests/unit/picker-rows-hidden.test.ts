import { describe, it, expect } from 'vitest';
import { shortcutFor, visiblePickerRows } from '../../dashboard/src/lib/pickerRows.js';

const r = (name: string, o: { hidden?: boolean; active?: boolean } = {}) => ({ name, active: !!o.active, hidden: !!o.hidden });
const rows = [r('a'), r('b', { hidden: true }), r('c'), r('d', { hidden: true, active: true }), r('e')];

describe('project picker and hidden projects', () => {
  it('lists only shown projects plus the one on screen', () => {
    expect(visiblePickerRows(rows, '').map((x) => x.name)).toEqual(['a', 'c', 'd', 'e']);
  });
  it('a typed name still finds a hidden project', () => {
    expect(visiblePickerRows(rows, ' B ').map((x) => x.name)).toEqual(['b']);
  });
  it('cmd numbers go to shown projects only, in order; hidden ones have none', () => {
    expect(['a', 'b', 'c', 'd', 'e'].map((n) => shortcutFor(rows, n))).toEqual([1, null, 2, null, 3]);
  });
  it('no number past nine', () => {
    const many = Array.from({ length: 11 }, (_, i) => r(`p${i}`));
    expect(shortcutFor(many, 'p9')).toBeNull();
    expect(shortcutFor(many, 'p8')).toBe(9);
  });
});
