/**
 * The title bar gives way in order (baslik-cubugu-dar): the sleep tracker shrinks first, the zoom
 * icon goes next, the project name shortens last, and the menu tabs are never touched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BAR_SQUEEZE_MAX, fitBar } from '../../dashboard/src/components/layout/newshell/useBarSqueeze';

/** A bar whose contents get narrower with every level, as the CSS makes them. */
function fakeBar(widthAt: (level: number) => number, available: number) {
  let level = 0;
  return {
    setAttribute: (_k: string, v: string) => { level = Number(v); },
    get scrollWidth() { return widthAt(level); },
    get clientWidth() { return available; },
    get level() { return level; },
  };
}

describe('fitBar', () => {
  const need = [900, 860, 820, 790, 760, 700];
  it('stays at 0 when everything fits', () => {
    const bar = fakeBar((l) => need[l], 1000);
    expect(fitBar(bar)).toBe(0);
    expect(bar.level).toBe(0);
  });
  it('takes the smallest level that fits', () => {
    expect(fitBar(fakeBar((l) => need[l], 830))).toBe(2);
    expect(fitBar(fakeBar((l) => need[l], 790))).toBe(3);
  });
  it('stops at the last level when nothing fits (only the project name then shortens)', () => {
    const bar = fakeBar((l) => need[l], 400);
    expect(fitBar(bar)).toBe(BAR_SQUEEZE_MAX);
    expect(bar.level).toBe(BAR_SQUEEZE_MAX);
  });
});

describe('NewShell.css squeeze levels', () => {
  const css = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'layout', 'newshell', 'NewShell.css'), 'utf-8');
  const squeeze = css.slice(css.indexOf('The bar gives way, in order'));
  it('shrinks the tracker, then drops zoom, then the project name', () => {
    expect(squeeze).toMatch(/\[data-squeeze="1"\] \.sleep-tracker-level/);
    expect(squeeze).toMatch(/\[data-squeeze="2"\] \.sleep-tracker-top/);
    expect(squeeze).toMatch(/\[data-squeeze="3"\] \.ns-zoom/);
    expect(squeeze).toMatch(/\[data-squeeze="4"\] \.ns-tb-picker,\s*\.ns-titlebar\[data-squeeze="5"\] \.ns-tb-picker \{ flex: 0 1 auto; min-width: 0; \}/);
  });
  it('never hides or shrinks a menu tab', () => {
    // Only the last level touches a tab, and only its padding; none is ever hidden or cut.
    expect(squeeze).not.toMatch(/\.ns-tab\b(?!s)[^{]*\{[^}]*(display|overflow|width)/);
    expect(squeeze).toMatch(/\[data-squeeze="5"\] \.sleep-tracker-wrap \{ display: none; \}/);
    expect(squeeze).toMatch(/\.ns-tb-tabs \{ flex: none; \}/);
  });
});
