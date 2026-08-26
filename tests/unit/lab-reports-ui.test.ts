/**
 * My Reports UI — the route grammar (B3: `/lab/reports/<slug>` under the F2
 * pushState contract), the export builders (B5: whole-report Markdown + a
 * self-contained single-file HTML), and the page's structural honesty pins
 * (B4 "as of" stamps + no interpolation, B6 missing-insight strip, B8 scoped
 * progressive fill). Pure functions are tested directly; the page's wiring is
 * pinned textually (this repo runs no DOM harness — the chartRegistry idiom).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLabPath, labReportPath } from '../../dashboard/src/components/lab/funnel/labRoute.js';
import { reportToMarkdown, reportToHtml } from '../../dashboard/src/components/lab/reports/reportModel.js';
import { snapshotToSet } from '../../dashboard/src/components/lab/matrixModel.js';
import type { ReportDetail } from '../../dashboard/src/hooks/useLab';

const DASH = join(import.meta.dirname, '../../dashboard/src');

describe('report routing (B3)', () => {
  it('parses /lab/reports/<slug> as a report — never as an insight named "reports"', () => {
    expect(parseLabPath('/lab/reports/daily')).toEqual({ slug: null, funnelId: null, report: 'daily' });
    expect(parseLabPath('/lab/reports/daily/')).toEqual({ slug: null, funnelId: null, report: 'daily' });
    expect(parseLabPath('/lab/reports')).toEqual({ slug: null, funnelId: null, report: null });
    expect(parseLabPath('/lab/wau')).toEqual({ slug: 'wau', funnelId: null, report: null });
    expect(parseLabPath('/lab/wau/f/516')).toEqual({ slug: 'wau', funnelId: '516', report: null });
    expect(parseLabPath('/')).toEqual({ slug: null, funnelId: null, report: null });
  });

  it('labReportPath builds the encoded path', () => {
    expect(labReportPath('daily')).toBe('/lab/reports/daily');
    expect(labReportPath('a b')).toBe('/lab/reports/a%20b');
  });

  it('the LabPage mounts ReportPage for the report route', () => {
    const source = readFileSync(join(DASH, 'pages/LabPage.tsx'), 'utf-8');
    expect(source).toContain('route.report');
    expect(source).toContain('<ReportPage');
  });

  it('the board toolbar lists reports and navigates via pushLabReportPath', () => {
    const source = readFileSync(join(DASH, 'components/lab/LabBoard.tsx'), 'utf-8');
    expect(source).toContain('useLabReports');
    expect(source).toContain('pushLabReportPath(r.slug)');
  });
});

function fixtureDetail(): ReportDetail {
  return {
    report: {
      slug: 'daily',
      title: 'Daily Product Report',
      description: 'The day at a glance',
      date_nav: 'daily',
      notes: '## Notes\n\nWatch the TR funnel.',
    },
    date: '2026-08-24',
    sections: [
      {
        title: 'Funnels',
        prose: 'Upsell by language.',
        items: [
          {
            insight: 'bd',
            missing: false,
            title: 'Upsell breakdown',
            render: 'breakdown',
            unit: null,
            view: null,
            breakdown: null,
            asOf: '2026-08-24T09:00:00Z',
            latest: 150,
            matrixSnapshot: {
              at: '2026-08-24T09:00:00Z',
              range: { fromISO: '2026-08-01', toISO: '2026-08-24' },
              dims: [{ key: 'funnel', label: 'Funnel' }, { key: 'language' }],
              rows: [
                { d: { funnel: 'F3000', language: 'TR' }, v: 100 },
                { d: { funnel: 'F3000', language: 'EN' }, v: 50 },
              ],
              total: { v: 150 },
            },
            funnelSnapshot: null,
            cache: null,
          },
          {
            insight: 'never-synced',
            missing: false,
            title: 'Late starter',
            render: 'number',
            unit: 'users',
            view: null,
            breakdown: null,
            asOf: null,
            latest: null,
            matrixSnapshot: null,
            funnelSnapshot: null,
            cache: null,
          },
          {
            insight: 'ghost',
            missing: true,
            title: null,
            render: null,
            unit: null,
            view: null,
            breakdown: null,
            asOf: null,
            latest: null,
            matrixSnapshot: null,
            funnelSnapshot: null,
            cache: null,
          },
        ],
      },
    ],
  };
}

describe('report exports (B5) — as honest as the page', () => {
  it('Markdown carries the date rule, the as-of stamp, the pivot, and the honest empties', () => {
    const md = reportToMarkdown(fixtureDetail());
    expect(md).toContain('# Daily Product Report');
    expect(md).toContain('_Date: 2026-08-24 (latest sync at/before end of day)_');
    expect(md).toContain('_as of 2026-08-24T09:00:00Z_');
    expect(md).toContain('| | TR | EN |'); // the real pivot, not a series dump
    expect(md).toContain('| F3000 | 100 | 50 |');
    expect(md).toContain('_No snapshot at or before this date._');
    expect(md).toContain('⚠ Insight `ghost` no longer exists.');
    expect(md).toContain('Watch the TR funnel.');
  });

  it('the HTML export is ONE self-contained file: tokens inlined, no external requests', () => {
    const html = reportToHtml(fixtureDetail(), { '--color-text': '#111', '--chart-1': '#4477aa' });
    expect(html).toContain('--color-text: #111;');
    expect(html).toContain('.lk-table'); // kit embedded
    expect(html).toContain('Daily Product Report');
    expect(html).toContain('as of 2026-08-24T09:00:00Z');
    expect(html).toContain('No snapshot at or before this date.');
    // Self-contained: nothing may reach out — no src/href to any URL.
    expect(html).not.toMatch(/\b(src|href)\s*=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('escapes markup coming from data (a series named <script> must not execute)', () => {
    const detail = fixtureDetail();
    detail.report.title = '<script>alert(1)</script>';
    const html = reportToHtml(detail, {});
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('snapshotToSet (the dated pivot re-render)', () => {
  it('uses carried dims, and derives them from row coordinates for pre-dims snapshots', () => {
    const withDims = snapshotToSet({
      at: 'x', range: { fromISO: 'a', toISO: 'b' },
      dims: [{ key: 'funnel', label: 'Funnel' }],
      rows: [{ d: { funnel: 'F1' }, v: 1 }],
    });
    expect(withDims.dims).toEqual([{ key: 'funnel', label: 'Funnel' }]);

    const legacy = snapshotToSet({
      at: 'x', range: { fromISO: 'a', toISO: 'b' },
      rows: [{ d: { funnel: 'F1', language: 'TR' }, v: 1 }],
    });
    expect(legacy.dims.map((d) => d.key)).toEqual(['funnel', 'language']);
  });
});

describe('ReportPage structural pins (B4/B6/B8)', () => {
  const page = readFileSync(join(DASH, 'components/lab/reports/ReportPage.tsx'), 'utf-8');
  const css = readFileSync(join(DASH, 'components/lab/reports/ReportPage.css'), 'utf-8');

  it('B8: starts ONE scoped sync job with the report slugs and counts ready sections', () => {
    expect(page).toContain('slugs: [...reportSlugs]');
    expect(page).toMatch(/startedRef/);
    expect(page).toContain('section(s) ready');
    expect(page).toContain('syncJob.current');
  });

  it('B4: stamps as-of, and the empty state promises no interpolation', () => {
    expect(page).toContain('as of {fmtWhen(item.asOf)}');
    expect(page).toContain('nothing is interpolated');
  });

  it('B6: a missing insight renders an alert strip', () => {
    expect(page).toContain('report-item--missing');
    expect(page).toContain('no longer exists');
  });

  it('B5: print stylesheet hides chrome and the page mounts Print/Export/Copy actions', () => {
    expect(css).toContain('@media print');
    expect(css).toContain('.report-noprint { display: none !important; }');
    expect(page).toContain('window.print()');
    expect(page).toContain('Export HTML');
    expect(page).toContain('Copy as Markdown');
  });
});
