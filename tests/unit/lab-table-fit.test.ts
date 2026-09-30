/**
 * A board table fits its cell's width (demo finding 3): `fitTable` walks a
 * ladder of what gives way (the data bar shrinks first, then secondary columns
 * drop, figures go compact, the bar goes) until the columns fit, and never drops
 * the label or the value; `frameLadder` is the table frame's order. A word unit
 * is written once, in the value header, never per cell. The rendered geometry
 * (no sideways scroll, four rows at the demo's card size) is measured by the
 * lab-boards verify run; here the fitting is pure.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { fitTable, frameLadder, FrameTable, MetricTable } = await import('../../dashboard/src/components/lab/MetricTable.js');
type FitSpec = Parameters<typeof fitTable>[0];

/** The demo's Top countries columns, widths in px (header, cell full, cell compact). */
const COLUMNS = ['country', 'v', 'n', 'prev', 'delta'];
const WIDTHS: FitSpec['widths'] = {
  country: { header: 70, cell: 110, compact: 110 },
  v: { header: 100, cell: 60, compact: 50 },
  n: { header: 40, cell: 50, compact: 45 },
  prev: { header: 80, cell: 60, compact: 50 },
  delta: { header: 75, cell: 60, compact: 55 },
};
const spec = (over: Partial<FitSpec> = {}): FitSpec => ({
  columns: COLUMNS,
  widths: WIDTHS,
  bar: { column: 'v', ideal: 128, min: 32 },
  ladder: frameLadder(COLUMNS),
  ...over,
});
// Natural width without the bar: 110 + 100 + 50 + 80 + 75 = 415; the value column
// holds its bar while 60 + bar <= 100, so up to a 40px bar is free.

describe('frameLadder: the order a table frame gives way', () => {
  it('count, compact figures, previous, the bar, the change, then later dims last first', () => {
    expect(frameLadder(['cohort', 'week', 'region', 'v', 'n', 'prev', 'delta'])).toEqual([
      { drop: 'n' }, { compact: true }, { drop: 'prev' }, { noBar: true }, { drop: 'delta' },
      { drop: 'region' }, { drop: 'week' },
    ]);
  });

  it('never names the first dim or the value', () => {
    const steps = frameLadder(['country', 'city', 'v', 'n', 'prev', 'delta']);
    const drops = steps.flatMap((s) => ('drop' in s ? [s.drop] : []));
    expect(drops).not.toContain('country');
    expect(drops).not.toContain('v');
  });
});

describe('fitTable: the columns a width holds', () => {
  it('unmeasured (server render, first paint): every column at the bar\'s ideal width', () => {
    expect(fitTable(spec(), 0)).toEqual({ columns: COLUMNS, dropped: [], compact: false, bar: 128, fits: true });
  });

  it('a wide table is unchanged: every column, full figures, the bar at its ideal', () => {
    const fit = fitTable(spec(), 1100);
    expect(fit).toEqual({ columns: COLUMNS, dropped: [], compact: false, bar: 128, fits: true });
  });

  it('the data bar shrinks first, down to its minimum, before any column drops', () => {
    // 415 fits a 40px bar inside the value header's width; 20px more of room is a 60px bar.
    const roomy = fitTable(spec(), 435);
    expect(roomy.dropped).toEqual([]);
    expect(roomy.bar).toBe(60);
    const tight = fitTable(spec(), 415);
    expect(tight.dropped).toEqual([]);
    expect(tight.bar).toBe(40);
  });

  it('then the count drops, then figures go compact, then the previous value', () => {
    // Without n: 365 (bar 40 free). Width 380 keeps everything else.
    expect(fitTable(spec(), 380)).toMatchObject({ dropped: ['n'], compact: false });
    // Compact: country 110 + v 100 + prev 80 + delta 75 = 365 still (headers rule); 360 needs prev gone.
    expect(fitTable(spec(), 360)).toMatchObject({ columns: ['country', 'v', 'delta'], dropped: ['n', 'prev'], compact: true });
  });

  it('then the bar goes, then the change; the label and the value stay to the end', () => {
    // country + v + delta = 285, the compact 50px figure leaves a 50px bar inside the 100px header.
    expect(fitTable(spec(), 285)).toMatchObject({ columns: ['country', 'v', 'delta'], bar: 50 });
    const noDelta = fitTable(spec(), 220);
    expect(noDelta).toMatchObject({ columns: ['country', 'v'], dropped: ['n', 'prev', 'delta'], bar: 0, fits: true });
    const none = fitTable(spec(), 120);
    expect(none.columns).toEqual(['country', 'v']);
    expect(none.fits).toBe(false);
    expect(none.bar).toBe(0);
  });

  it('the bar goes before the change when the bar is what does not fit', () => {
    const wideBar = spec({
      widths: { ...WIDTHS, v: { header: 60, cell: 60, compact: 50 } },
      bar: { column: 'v', ideal: 128, min: 32 },
    });
    // country 110 + v(compact 50 + 32 bar = 82) + delta 75 = 267 > 250; without the bar 110 + 60 + 75 = 245.
    expect(fitTable(wideBar, 250)).toMatchObject({ columns: ['country', 'v', 'delta'], bar: 0, fits: true });
  });

  it('a rung naming a column that is not shown is skipped', () => {
    const picked = ['country', 'v', 'delta'];
    const fit = fitTable(spec({ columns: picked, ladder: frameLadder(picked) }), 240);
    expect(fit.dropped).toEqual(['delta']);
  });

  it('no bar asked for: bar 0 at every width', () => {
    expect(fitTable(spec({ bar: null }), 1100).bar).toBe(0);
    expect(fitTable(spec({ bar: null }), 0).bar).toBe(0);
  });
});

describe('units: written once, in the header', () => {
  const DIMS = [{ key: 'country', label: 'Country' }];
  const ROWS = [
    { d: { country: 'Atlantis' }, v: 12400, n: 88100, prev: 11800 },
    { d: { country: 'Lemuria' }, v: 5200, n: 35600, prev: 4900 },
  ];

  it('a word unit heads the value column and leaves every cell bare', () => {
    const out = renderToStaticMarkup(createElement(FrameTable, { dims: DIMS, rows: ROWS, unit: 'users', total: { count: 2, v: 17600, n: 123700 } }));
    expect(out).toContain('lab.blocks.table.value (users)');
    expect(out.match(/users/g)).toHaveLength(1);
    expect(out).toContain('>12.4K<');
    // One number style per column: the largest (12,400) makes the whole column compact.
    expect(out).toContain('>5.2K<');
  });

  it('a symbol unit (%) stays on the figure', () => {
    const out = renderToStaticMarkup(createElement(FrameTable, { dims: DIMS, rows: [{ d: { country: 'Mu' }, v: 47.3 }], unit: '%' }));
    expect(out).toContain('>47.3%<');
    expect(out).not.toContain('(%)');
  });

  it('the series table heads its latest column with the unit', () => {
    const series = [{ name: 'web', points: [{ t: '2026-09-01', v: 1200 }, { t: '2026-09-02', v: 1400 }] }];
    const out = renderToStaticMarkup(createElement(MetricTable, { series, unit: 'users', full: true }));
    expect(out).toContain('lab.blocks.table.latest (users)');
    expect(out.match(/users/g)).toHaveLength(1);
  });

  it('nothing is dropped before the width is known, so no row carries a tooltip yet', () => {
    const out = renderToStaticMarkup(createElement(FrameTable, { dims: DIMS, rows: ROWS, unit: 'users' }));
    expect(out).toContain('data-columns="country,v,n,prev,delta"');
    expect(out).not.toContain('data-dropped');
    expect(out).not.toMatch(/<tr [^>]*title=/);
  });
});
