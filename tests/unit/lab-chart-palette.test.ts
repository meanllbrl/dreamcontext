/**
 * Chart colour by job (dashboard/src/components/lab/chart/palette.ts + chart.css):
 * categorical hues in a FIXED order, assigned by entity so a filter never repaints a
 * survivor, never cycled past eight; sequential and diverging steps (diverging with a
 * neutral midpoint); and the palette values in chart.css are exactly the ones the
 * dataviz validator passed, light and dark.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CATEGORICAL_SLOTS, OTHER_COLOR, categoricalColor, colorScale, divergingColor, divergingScale, divergingStep,
  sequentialColor, sequentialScale, sequentialStep,
} from '../../dashboard/src/components/lab/chart/palette.js';

const CSS = readFileSync(join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/chart/chart.css'), 'utf8');

/** The `--viz-*` custom properties declared in the block that starts at `selector`. */
function vizVars(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector}`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(CSS.indexOf('{', start) + 1, CSS.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--viz-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

// The palette as validated with validate_palette.js (task chart-api.md records the runs):
// categorical light on #ffffff, dark on #1c1f2a; every adjacent pair clears CVD dE 8 and
// normal-vision dE 15, and so does the slot 8 -> 1 wrap a colour start creates.
const VALIDATED = {
  light: ['#7b68ee', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#2a78d6', '#e34948'],
  dark: ['#9085e9', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#3987e5', '#e66767'],
};

describe('categorical palette', () => {
  it('is eight token slots in a fixed order', () => {
    expect(CATEGORICAL_SLOTS).toBe(8);
    expect(Array.from({ length: 8 }, (_, i) => categoricalColor(i))).toEqual(
      Array.from({ length: 8 }, (_, i) => `var(--viz-cat-${i + 1})`),
    );
  });

  it('never cycles: a ninth slot is the Other grey', () => {
    expect(categoricalColor(8)).toBe(OTHER_COLOR);
    expect(categoricalColor(-1)).toBe(OTHER_COLOR);
    const names = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const c = colorScale(names);
    const hues = names.slice(0, 8).map((n) => c.color(n));
    expect(new Set(hues).size).toBe(8);
    expect(c.color('s8')).toBe(OTHER_COLOR);
    expect(c.color('s9')).toBe(OTHER_COLOR);
    expect(c.slot('s9')).toBeNull();
  });

  it('colour follows the entity: filtering never repaints a survivor', () => {
    const domain = ['web', 'ios', 'android', 'desktop'];
    const full = colorScale(domain);
    const before = Object.fromEntries(domain.map((n) => [n, full.color(n)]));
    // The chart filters to two series; the scale is still built over the full domain.
    const shown = ['android', 'desktop'];
    for (const n of shown) expect(full.color(n)).toBe(before[n]);
    // And the order they are DRAWN in does not matter either.
    const reordered = colorScale(domain);
    expect(['desktop', 'web'].map((n) => reordered.color(n))).toEqual([before.desktop, before.web]);
    // An entity outside the domain reads as Other, never steals a slot.
    expect(full.color('unknown')).toBe(OTHER_COLOR);
  });

  it('a colour start rotates the slots (the block `color` option) and keeps them distinct', () => {
    const c = colorScale(['a', 'b', 'c'], { start: 7 });
    expect(['a', 'b', 'c'].map((n) => c.color(n))).toEqual(['var(--viz-cat-7)', 'var(--viz-cat-8)', 'var(--viz-cat-1)']);
    const eight = colorScale(Array.from({ length: 8 }, (_, i) => `x${i}`), { start: 3 });
    expect(new Set(eight.domain.map((n) => eight.color(n))).size).toBe(8);
    expect(colorScale(['a'], { start: 99 }).color('a')).toBe('var(--viz-cat-8)');
    expect(colorScale(['a'], { start: null }).color('a')).toBe('var(--viz-cat-1)');
  });

  it('a folded Other row wears the grey and does not consume a slot', () => {
    const c = colorScale(['Other', 'a', 'b'], { other: ['Other'] });
    expect(c.color('Other')).toBe(OTHER_COLOR);
    expect(c.color('a')).toBe('var(--viz-cat-1)');
    expect(c.color('b')).toBe('var(--viz-cat-2)');
  });

  it('chart.css carries exactly the validated hexes, light and dark (dark is selected, not flipped)', () => {
    const light = vizVars(':root {');
    const dark = vizVars("[data-theme='dark'],");
    expect(Array.from({ length: 8 }, (_, i) => light[`--viz-cat-${i + 1}`])).toEqual(VALIDATED.light);
    expect(Array.from({ length: 8 }, (_, i) => dark[`--viz-cat-${i + 1}`])).toEqual(VALIDATED.dark);
    // Every scale step is declared in both modes.
    for (const vars of [light, dark]) {
      for (let i = 1; i <= 7; i++) {
        for (const k of [`--viz-seq-${i}`, `--viz-seq-ink-${i}`, `--viz-div-${i}`, `--viz-div-ink-${i}`]) expect(vars[k], k).toBeTruthy();
      }
      expect(vars['--viz-other']).toBeTruthy();
    }
  });
});

describe('sequential and diverging scales', () => {
  it('sequential runs 7 one-hue steps, least to most', () => {
    expect(sequentialStep(0)).toBe(1);
    expect(sequentialStep(1)).toBe(7);
    expect(sequentialStep(0.5)).toBe(4);
    expect(sequentialStep(NaN)).toBe(1);
    expect(sequentialColor(2)).toBe('var(--viz-seq-7)');
    const s = sequentialScale(10, 110);
    expect(s.color(10)).toBe('var(--viz-seq-1)');
    expect(s.color(110)).toBe('var(--viz-seq-7)');
    expect(s.ink(110)).toBe('var(--viz-seq-ink-7)');
    // A flat domain does not divide by zero.
    expect(sequentialScale(5, 5).color(5)).toBe('var(--viz-seq-1)');
  });

  it('diverging has a neutral grey midpoint and symmetric arms', () => {
    expect(divergingStep(0)).toBe(4);
    expect(divergingStep(-1)).toBe(1);
    expect(divergingStep(1)).toBe(7);
    // A small real deviation always leaves the grey.
    expect(divergingStep(0.01)).toBe(5);
    expect(divergingStep(-0.01)).toBe(3);
    expect(divergingColor(0)).toBe('var(--viz-div-4)');
    const d = divergingScale(-50, 200, 0);
    expect(d.color(0)).toBe('var(--viz-div-4)');
    expect(d.color(200)).toBe('var(--viz-div-7)');
    // Equal distance from the midpoint reads as equal intensity on both sides.
    expect(divergingStep(d.t(-50))).toBe(8 - divergingStep(d.t(50)));
    // A custom midpoint (e.g. a target of 100).
    expect(divergingScale(0, 200, 100).color(100)).toBe('var(--viz-div-4)');
  });
});
