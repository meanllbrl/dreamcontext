/**
 * The breakdown render's PURE math (dashboard/src/components/lab/matrixModel.ts)
 * — pivot axis ordering, cell aggregation, low-sample honesty, the
 * equal-window Δ guard, and copy-as-Markdown. Plus, textually (the chartRegistry
 * drift-guard idiom), that BreakdownPivot routes its one-dim view through the
 * SHARED BarList instead of re-inlining a bar renderer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cellPrev,
  dimLabel,
  dimValues,
  heatFrac,
  isLowSample,
  pickPreviousSnapshot,
  pivotCell,
  pivotToMarkdown,
  snapshotCell,
  LOW_SAMPLE_THRESHOLD,
  type MatrixSet,
  type MatrixSnapshot,
} from '../../dashboard/src/components/lab/matrixModel.js';

function fixture(): MatrixSet {
  return {
    kind: 'matrix/v1',
    dims: [
      { key: 'funnel', label: 'Funnel' },
      { key: 'language', label: 'Language' },
    ],
    rows: [
      { d: { funnel: 'F3000', language: 'TR' }, v: 119000, n: 4200 },
      { d: { funnel: 'F3000', language: 'EN' }, v: 84000, n: 3100 },
      { d: { funnel: 'F4000', language: 'TR' }, v: 52000, n: 1800 },
      { d: { funnel: 'F4000', language: 'EN' }, v: 31000, n: 25 },
    ],
    total: { v: 286000, n: 9125 },
    unit: 'USD',
  };
}

describe('pivot math', () => {
  it('dimValues orders by weight with Other/Unknown last', () => {
    const set: MatrixSet = {
      kind: 'matrix/v1',
      dims: [{ key: 'x' }],
      rows: [
        { d: { x: 'small' }, v: 1 },
        { d: { x: 'big' }, v: 100 },
        { d: { x: 'Other' }, v: 500 },
        { d: { x: 'Unknown' }, v: 50 },
      ],
    };
    expect(dimValues(set, 'x')).toEqual(['big', 'small', 'Unknown', 'Other']);
  });

  it('pivotCell sums matches; an unmatched cell is null, not zero', () => {
    expect(pivotCell(fixture(), { funnel: 'F3000', language: 'TR' })).toEqual({ v: 119000, n: 4200, prev: null });
    expect(pivotCell(fixture(), { funnel: 'F3000' }).v).toBe(203000);
    expect(pivotCell(fixture(), { funnel: 'F9999' })).toEqual({ v: null, n: null, prev: null });
  });

  it('pivotCell only sums prev when EVERY matched row carries one', () => {
    const set: MatrixSet = {
      kind: 'matrix/v1',
      dims: [{ key: 'x' }, { key: 'y' }],
      rows: [
        { d: { x: 'a', y: '1' }, v: 3, prev: 2 },
        { d: { x: 'a', y: '2' }, v: 4, prev: 5 },
        { d: { x: 'b', y: '1' }, v: 9, prev: 1 },
        { d: { x: 'b', y: '2' }, v: 9 },
      ],
    };
    expect(pivotCell(set, { x: 'a' }).prev).toBe(7);
    expect(pivotCell(set, { x: 'b' }).prev).toBeNull(); // partial → no fake Δ
  });

  it('low-sample and heat honesty', () => {
    expect(isLowSample({ n: LOW_SAMPLE_THRESHOLD - 1 })).toBe(true);
    expect(isLowSample({ n: LOW_SAMPLE_THRESHOLD })).toBe(false);
    expect(isLowSample({ n: null })).toBe(false);
    expect(heatFrac(null, 100)).toBe(0);
    expect(heatFrac(50, 100)).toBe(0.5);
    expect(heatFrac(50, 0)).toBe(0);
  });

  it('dimLabel prettifies a bare key', () => {
    expect(dimLabel({ key: 'utm_source' })).toBe('Utm Source');
    expect(dimLabel({ key: 'x', label: 'The X' })).toBe('The X');
  });
});

describe('Δ vs the previous snapshot (equal-window guard)', () => {
  const mk = (at: string, fromISO: string, toISO: string, v = 100): MatrixSnapshot => ({
    at,
    range: { fromISO, toISO },
    rows: [{ d: { funnel: 'F3000', language: 'TR' }, v }],
  });

  it('picks the newest strictly-older comparable snapshot', () => {
    const history = [
      mk('2026-08-01T00:00:00Z', '2026-07-04', '2026-08-01'), // 28d comparable
      mk('2026-08-10T00:00:00Z', '2026-05-12', '2026-08-10'), // 90d NOT comparable
    ];
    const current = { at: '2026-08-25T00:00:00Z', range: { fromISO: '2026-07-28', toISO: '2026-08-25' } };
    expect(pickPreviousSnapshot(current, history)!.at).toBe('2026-08-01T00:00:00Z');
    expect(pickPreviousSnapshot(current, [history[1]])).toBeNull();
    expect(pickPreviousSnapshot(current, [])).toBeNull();
  });

  it('snapshotCell reads a coordinate out of a snapshot; adapter prev wins in cellPrev', () => {
    const snap = mk('2026-08-01T00:00:00Z', '2026-07-04', '2026-08-01', 90000);
    expect(snapshotCell(snap, { funnel: 'F3000', language: 'TR' })).toBe(90000);
    expect(snapshotCell(snap, { funnel: 'F4000' })).toBeNull();
    expect(cellPrev({ v: 1, n: null, prev: 5 }, snap, { funnel: 'F3000', language: 'TR' })).toBe(5);
    expect(cellPrev({ v: 1, n: null, prev: null }, snap, { funnel: 'F3000', language: 'TR' })).toBe(90000);
    expect(cellPrev({ v: 1, n: null, prev: null }, null, { funnel: 'F3000' })).toBeNull();
  });
});

describe('copy as Markdown', () => {
  it('renders the 2-dim pivot as a GFM table with the total', () => {
    const md = pivotToMarkdown(fixture(), { rowDim: 'funnel', colDim: 'language' });
    const lines = md.split('\n');
    expect(lines[0]).toBe('| | TR | EN |');
    expect(lines[1]).toBe('| --- | ---: | ---: |');
    expect(lines[2]).toBe('| F3000 | 119,000 | 84,000 |');
    expect(lines[3]).toBe('| F4000 | 52,000 | 31,000 |');
    expect(md).toContain('**Total:** 286,000 USD');
  });

  it('renders a 1-dim set as a label → value table and carries the filter line', () => {
    const md = pivotToMarkdown(fixture(), { rowDim: 'funnel', filter: { language: 'TR' } });
    expect(md).toContain('_Filter: language=TR_');
    expect(md).toContain('| Funnel | Value |');
    expect(md).toContain('| F3000 | 119,000 |');
  });
});

describe('BreakdownPivot component shape (textual guards)', () => {
  const source = readFileSync(
    join(import.meta.dirname, '../../dashboard/src/components/lab/BreakdownPivot.tsx'),
    'utf-8',
  );

  it('routes the 1-dim view through the SHARED BarList (A5: reuse, not re-implement)', () => {
    expect(source).toMatch(/import \{ BarList \} from '\.\/BarList'/);
    expect(source).toContain('<BarList');
  });

  it('tints heat cells with a --chart token, never a hex', () => {
    expect(source).toContain('var(--chart-1)');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('keeps the detail affordances: dim swap, sort, Δ source line, copy-as-Markdown', () => {
    expect(source).toContain('swap dims');
    expect(source).toContain('copy as Markdown');
    expect(source).toContain('pivotToMarkdown');
    expect(source).toContain('pickPreviousSnapshot');
    expect(source).toContain('toggleSort');
  });
});
