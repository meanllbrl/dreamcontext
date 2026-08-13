/**
 * `flow-text.ts` — the title fitting the automations flow canvas turns on
 * (`FlowDiagramProps.fitTitles`) so a generated node's title, which is user
 * data of unknown length, cannot draw out of its box and through the node
 * beside it. That is the defect this file guards: before it, a manifest whose
 * output node was labelled `automations/output/<slug>/` rendered that label
 * straight across its two neighbours.
 *
 * Pure string math, so it tests in plain node with no DOM — unlike the
 * component that calls it (see `automations-flow-canvas.test.ts`'s note). The
 * one thing here that a type checker cannot catch is the size the wrap math is
 * computed at (`TITLE_SCALE`) drifting from the size CSS actually renders a
 * wrapped title at (`.fd-node-title--fit`), so that coupling is asserted by
 * source scan, the same way that file scans variants against their CSS rules.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fitTitle,
  TITLE_MAX_LINES,
  TITLE_SCALE,
} from '../../dashboard/src/components/about/flow-text.js';
import { NODE_W } from '../../dashboard/src/components/automations/flowLayout.js';

/** The title size `FlowDiagram` renders a full-size (non-`mini`) node at. */
const FULL = 17;

describe('fitTitle', () => {
  it('leaves a title that already fits completely untouched — same string, full size', () => {
    for (const title of ['agent', 'every day at 11:00', 'CalBuddy Funnel Watch']) {
      expect(fitTitle(title, NODE_W, FULL)).toEqual({
        lines: [title],
        scaled: false,
        truncated: false,
      });
    }
  });

  it('wraps an overflowing path at its slashes rather than mid-word, and does not ellipsize what fits', () => {
    const fitted = fitTitle('automations/output/calbuddy-funnel-watch/', NODE_W, FULL);
    expect(fitted.lines).toEqual(['automations/output/', 'calbuddy-funnel-watch/']);
    expect(fitted.scaled).toBe(true);
    expect(fitted.truncated).toBe(false);
  });

  it('wraps an overflowing phrase at spaces', () => {
    const fitted = fitTitle('Weekly funnel and spend reconciliation', NODE_W, FULL);
    expect(fitted.lines.length).toBeGreaterThan(1);
    expect(fitted.lines.join(' ')).toBe('Weekly funnel and spend reconciliation');
  });

  it('caps a title with more content than fits at TITLE_MAX_LINES, ellipsizing the last one', () => {
    const fitted = fitTitle('every single word here overflows the box by a mile indeed truly', NODE_W, FULL);
    expect(fitted.lines).toHaveLength(TITLE_MAX_LINES);
    expect(fitted.truncated).toBe(true);
    expect(fitted.lines.at(-1)?.endsWith('…')).toBe(true);
  });

  it('never exceeds TITLE_MAX_LINES, even for an unbreakable run of characters', () => {
    const fitted = fitTitle('x'.repeat(400), NODE_W, FULL);
    expect(fitted.lines.length).toBeLessThanOrEqual(TITLE_MAX_LINES);
    expect(fitted.truncated).toBe(true);
    expect(fitted.lines.at(-1)?.endsWith('…')).toBe(true);
  });

  it('keeps every produced line within the node width at the size it will be drawn', () => {
    const budget = (NODE_W - 8) / (FULL * TITLE_SCALE * 0.53);
    for (const title of [
      'automations/output/calbuddy-funnel-watch/',
      'Weekly funnel + spend reconciliation sweep',
      'x'.repeat(400),
      'supercalifragilisticexpialidocious-single-token',
    ]) {
      for (const line of fitTitle(title, NODE_W, FULL).lines) {
        expect(line.length).toBeLessThanOrEqual(Math.floor(budget));
      }
    }
  });

  it('does not lose a one-word title that cannot be broken — it is ellipsized, never emptied', () => {
    const fitted = fitTitle('a'.repeat(60), NODE_W, FULL);
    expect(fitted.lines[0].length).toBeGreaterThan(1);
    expect(fitted.truncated).toBe(true);
  });
});

describe('the wrapped-title size CSS renders at', () => {
  it('matches TITLE_SCALE — the size the wrap math was computed at', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../../dashboard/src/components/about/FlowDiagram.css', import.meta.url)),
      'utf8',
    );
    const rule = /\.fd-node-title--fit\s*\{[^}]*font-size:\s*([\d.]+)px/.exec(css);
    expect(rule, '.fd-node-title--fit must set a font-size').not.toBeNull();
    expect(Number(rule![1])).toBeCloseTo(FULL * TITLE_SCALE, 5);
  });
});
