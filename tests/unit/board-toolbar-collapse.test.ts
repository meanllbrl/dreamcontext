import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fitOnLayout,
  fitOnResize,
  fitRetest,
  initialFit,
  menusToClose,
  type BarFit,
} from '../../dashboard/src/components/tasks/toolbarCollapse';

/**
 * The Tasks toolbar's overflow collapse must settle.
 *
 * A 720px to 1500px resize could loop BoardToolbar into React's "Maximum update depth
 * exceeded" and the app-level error boundary replaced the whole app. The collapse re-tested
 * from all controls on every ResizeObserver callback, and closed the parent's menu on every
 * count change whether or not one was open. These pin the two decisions that stop that:
 * within one bar width the count only goes down, and a menu setter runs only for an open menu.
 *
 * Root vitest has no DOM, so the layout is modelled: a bar of a fixed width whose row
 * overflows while more than `fits` controls are shown, and a ResizeObserver that reports the
 * bar again after every commit, at the SAME width (the callbacks the collapse sets off itself).
 */

const TOTAL = 4;
const NESTED_UPDATE_LIMIT = 50; // React's cap on chained commits

/** Drive commits until nothing changes; returns the settled fit and the commit count. */
function settle(width: number, fits: number): { fit: BarFit; commits: number } {
  let fit = fitOnResize(initialFit(TOTAL), width, TOTAL);
  let commits = 1;
  for (;;) {
    const afterLayout = fitOnLayout(fit, fit.visible > fits);
    const afterObserve = fitOnResize(afterLayout, width, TOTAL);
    if (afterObserve === fit) return { fit, commits };
    fit = afterObserve;
    commits++;
    if (commits > NESTED_UPDATE_LIMIT) throw new Error('Maximum update depth exceeded');
  }
}

describe('toolbar collapse: one width', () => {
  it('shrinks to what fits and settles, even with the observer firing after every commit', () => {
    for (let fits = 0; fits <= TOTAL; fits++) {
      const { fit, commits } = settle(600, fits);
      expect(fit.visible).toBe(fits);
      expect(commits).toBeLessThanOrEqual(TOTAL + 1);
    }
  });

  it('ignores a callback at the width it already fitted: same state, so React bails out', () => {
    const fitted: BarFit = { visible: 1, width: 600 };
    expect(fitOnResize(fitted, 600, TOTAL)).toBe(fitted);
  });

  it('never grows on a layout pass, and stops at zero', () => {
    const one: BarFit = { visible: 1, width: 600 };
    expect(fitOnLayout(one, true)).toEqual({ visible: 0, width: 600 });
    const none: BarFit = { visible: 0, width: 600 };
    expect(fitOnLayout(none, true)).toBe(none);
    expect(fitOnLayout(one, false)).toBe(one);
  });
});

describe('toolbar collapse: a new width', () => {
  it('re-tests from all controls when the bar is wider or narrower', () => {
    const fitted: BarFit = { visible: 1, width: 600 };
    expect(fitOnResize(fitted, 1214, TOTAL)).toEqual({ visible: TOTAL, width: 1214 });
    expect(fitOnResize(fitted, 434, TOTAL)).toEqual({ visible: TOTAL, width: 434 });
  });

  it('re-tests when the controls change, but not when every control already shows', () => {
    const fitted: BarFit = { visible: 2, width: 600 };
    expect(fitRetest(fitted, TOTAL)).toEqual({ visible: TOTAL, width: 600 });
    const all: BarFit = { visible: TOTAL, width: 600 };
    expect(fitRetest(all, TOTAL)).toBe(all);
  });
});

describe('toolbar collapse: closing menus', () => {
  it('calls no setter when no menu is open', () => {
    expect(menusToClose(null, false)).toEqual({ menu: false, more: false });
  });

  it('closes the menu that is open, and only that one', () => {
    expect(menusToClose('filter', false)).toEqual({ menu: true, more: false });
    expect(menusToClose(null, true)).toEqual({ menu: false, more: true });
  });
});

describe('toolbar collapse: BoardToolbar wiring', () => {
  const src = readFileSync(
    join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/tasks/BoardToolbar.tsx'),
    'utf-8',
  );

  it('routes the observer through the width check, not a bare reset', () => {
    expect(src).toContain('new ResizeObserver(() => setFit((ft) => fitOnResize(ft, el.clientWidth, COLLAPSIBLE.length)))');
    expect(src).not.toMatch(/new ResizeObserver\(\(\) => setVisibleCount\(/);
  });

  it('calls the parent menu setter only for an open menu', () => {
    expect(src).toContain('if (close.menu) setOpenMenu(null);');
    expect(src).not.toMatch(/useEffect\(\(\) => \{ setOpenMenu\(null\); setMoreOpen\(false\); \}/);
  });
});
