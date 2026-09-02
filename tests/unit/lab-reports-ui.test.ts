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
import {
  parseCommentarySections,
  parseInlineMarkdown,
  reportToHtml,
  reportToMarkdown,
  sectionWindowMix,
  windowLabel,
} from '../../dashboard/src/components/lab/reports/reportModel.js';
import { snapshotToSet } from '../../dashboard/src/components/lab/matrixModel.js';
import type { ReportDetail } from '../../dashboard/src/hooks/useLab';

const DASH = join(import.meta.dirname, '../../dashboard/src');

describe('report routing (B3)', () => {
  it('parses /lab/reports/<slug> as a report — never as an insight named "reports"', () => {
    expect(parseLabPath('/lab/reports/daily')).toEqual({ slug: null, funnelId: null, pageId: null, report: 'daily' });
    expect(parseLabPath('/lab/reports/daily/')).toEqual({ slug: null, funnelId: null, pageId: null, report: 'daily' });
    expect(parseLabPath('/lab/reports')).toEqual({ slug: null, funnelId: null, pageId: null, report: null });
    expect(parseLabPath('/lab/wau')).toEqual({ slug: 'wau', funnelId: null, pageId: null, report: null });
    expect(parseLabPath('/lab/wau/f/516')).toEqual({ slug: 'wau', funnelId: '516', pageId: null, report: null });
    expect(parseLabPath('/')).toEqual({ slug: null, funnelId: null, pageId: null, report: null });
  });

  it('parses /lab/<slug>/p/<pageId> as an app/v1 routed page — never as a funnel detail', () => {
    expect(parseLabPath('/lab/onboarding/p/steps')).toEqual({ slug: 'onboarding', funnelId: null, pageId: 'steps', report: null });
    expect(parseLabPath('/lab/onboarding/p/steps/')).toEqual({ slug: 'onboarding', funnelId: null, pageId: 'steps', report: null });
    // funnelId and pageId are mutually exclusive by construction.
    expect(parseLabPath('/lab/wau/f/516').pageId).toBeNull();
    expect(parseLabPath('/lab/onboarding/p/steps').funnelId).toBeNull();
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
            window: { fromISO: '2026-08-18', toISO: '2026-08-25' },
            rangeKey: null,
            targetWindow: { fromISO: '2026-08-18', toISO: '2026-08-25' },
            windowStatus: 'window' as const,
          },
          {
            insight: 'spend',
            missing: false,
            title: 'Ad spend',
            render: 'number',
            unit: 'USD',
            view: null,
            breakdown: null,
            asOf: '2026-08-24T09:00:00Z',
            latest: 1276.75,
            matrixSnapshot: null,
            funnelSnapshot: null,
            cache: null,
            window: { fromISO: '2026-07-25', toISO: '2026-08-24' },
            rangeKey: 'last_30_days',
            targetWindow: { fromISO: '2026-07-25', toISO: '2026-08-24' },
            windowStatus: 'window' as const,
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
            window: null,
            rangeKey: null,
            targetWindow: null,
            windowStatus: 'own' as const,
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
            window: null,
            rangeKey: null,
            targetWindow: null,
            windowStatus: 'own' as const,
          },
        ],
      },
    ],
  };
}

describe('window honesty helpers (W2/W3)', () => {
  it('windowLabel: a real window reads as span + dates; the two null states stay distinct', () => {
    const known = windowLabel(
      { window: { fromISO: '2026-08-24', toISO: '2026-08-31' }, matrixSnapshot: null, funnelSnapshot: null },
      false,
    );
    expect(known).toEqual({ text: '7-day · Aug 24 – Aug 31', tone: 'known' });
    // Live with no declaration: an unlabelled number must not pass as windowed.
    expect(windowLabel({ window: null, matrixSnapshot: null, funnelSnapshot: null }, false).text)
      .toBe('no declared window');
    // Dated series history recorded no window: unknown, never relabeled.
    expect(windowLabel({ window: null, matrixSnapshot: null, funnelSnapshot: null }, true).text)
      .toBe('window unknown');
  });

  it('sectionWindowMix flags 7d-next-to-30d and windowless-next-to-windowed; uniform sections stay quiet', () => {
    const items = fixtureDetail().sections[0].items;
    expect(sectionWindowMix(items)).toEqual(['7-day', '30-day']); // empty + missing items excluded
    const uniform = items.filter((i) => i.insight === 'bd');
    expect(sectionWindowMix(uniform)).toBeNull();
    expect(sectionWindowMix([])).toBeNull();
  });

  it('parseCommentarySections splits summary + per-section notes; unknown headings fold into the summary', () => {
    const body = [
      'Genel okuma: hafta iyi.',
      '',
      '## Funnels',
      'TR tarafı taşıyor.',
      '',
      '## Hayali Bölüm',
      'Bu başlık yok.',
    ].join('\n');
    const parsed = parseCommentarySections(body, ['Funnels', 'Payments']);
    expect(parsed.sections).toEqual({ Funnels: 'TR tarafı taşıyor.' });
    expect(parsed.summary).toContain('Genel okuma: hafta iyi.');
    expect(parsed.summary).toContain('Hayali Bölüm — Bu başlık yok.'); // never silently dropped
    // No headings at all → everything is summary.
    const flat = parseCommentarySections('Sadece özet.', ['Funnels']);
    expect(flat.summary).toBe('Sadece özet.');
    expect(flat.sections).toEqual({});
  });

  it('exports place the parsed commentary: summary on top, section notes inside their sections', () => {
    const commentary = {
      body: 'Özet paragraf.\n\n## Funnels\nTR güçlü.',
      model: 'sonnet',
      generatedAt: '2026-09-01T10:00:00Z',
    };
    const html = reportToHtml(fixtureDetail(), {}, commentary);
    expect(html).toContain('Özet paragraf.');
    expect(html).toContain('rp-ai-note');
    expect(html).toContain('TR güçlü.');
    expect(html.indexOf('TR güçlü.')).toBeGreaterThan(html.indexOf('rp-section-title')); // inside the section, not the top block
    const md = reportToMarkdown(fixtureDetail(), commentary);
    expect(md).toContain('> Özet paragraf.');
    expect(md).toContain('> 🤖 AI: TR güçlü.');
  });

  it('parseInlineMarkdown tokenizes **bold** and `code`, leaving the rest literal', () => {
    expect(parseInlineMarkdown('Pencere: **7 GÜN** — tek istisna `pROAS`.')).toEqual([
      { kind: 'text', text: 'Pencere: ' },
      { kind: 'strong', text: '7 GÜN' },
      { kind: 'text', text: ' — tek istisna ' },
      { kind: 'code', text: 'pROAS' },
      { kind: 'text', text: '.' },
    ]);
    expect(parseInlineMarkdown('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
  });
});

describe('report exports (B5) — as honest as the page', () => {
  it('Markdown carries the date rule, the as-of stamp, windows, the pivot, and the honest empties', () => {
    const md = reportToMarkdown(fixtureDetail());
    expect(md).toContain('# Daily Product Report');
    expect(md).toContain('_Date: 2026-08-24 (latest sync at/before end of day)_');
    expect(md).toContain('_as of 2026-08-24T09:00:00Z_');
    expect(md).toContain('_7-day · Aug 18 – Aug 25_'); // the item's own window
    expect(md).toContain('> ⚠ Mixed measurement windows in this section: 7-day, 30-day.');
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

  it('the HTML export wears the dreamcontext Reports identity and the window honesty', () => {
    const html = reportToHtml(fixtureDetail(), {});
    // The brand line: mark + logotype + kicker + signing footer.
    expect(html).toContain('class="rp-logotype">dreamcontext<');
    expect(html).toContain('class="rp-kicker">Reports<');
    expect(html).toContain('Generated with dreamcontext Reports');
    // Window chips + the mixed-window strip.
    expect(html).toContain('7-day · Aug 18 – Aug 25');
    expect(html).toContain('Mixed measurement windows in this section: 7-day, 30-day.');
    // Prose/notes inline markdown renders as tags, escaped-first.
    expect(html).not.toContain('&lt;strong&gt;');
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

  it('AI commentary: opt-in panel, explicit Analyze click, labelled output, export carries it', () => {
    // Panel gated on the manifest flag — non-AI reports are first-class.
    expect(page).toContain("report.commentaryEnabled !== false");
    expect(page).toContain('<CommentaryPanel');
    expect(page).toContain('✦ Analyze');
    expect(page).toContain('AI-generated · {model}');
    // Exports: labelled commentary block, escaped, still self-contained.
    const withCommentary = reportToHtml(fixtureDetail(), {}, {
      body: '**Okuma:** spend <script>x</script> sabit.',
      model: 'sonnet',
      generatedAt: '2026-09-01T10:00:00Z',
    });
    expect(withCommentary).toContain('AI commentary');
    expect(withCommentary).toContain('AI-generated · sonnet');
    expect(withCommentary).not.toContain('<script>x');
    expect(withCommentary).not.toMatch(/\b(src|href)\s*=/i);
    const md = reportToMarkdown(fixtureDetail(), {
      body: 'Okuma paragrafı.', model: 'sonnet', generatedAt: '2026-09-01T10:00:00Z',
    });
    expect(md).toContain('> **AI commentary** (sonnet · 2026-09-01T10:00:00Z):');
    expect(md).toContain('> Okuma paragrafı.');
  });

  it('the page wears the dreamcontext Reports template: masthead, window chips, mixed-window strip', () => {
    expect(page).toContain('report-logotype');
    expect(page).toContain('dreamcontext');
    expect(page).toContain('Generated with dreamcontext Reports');
    expect(page).toContain('<WindowChip');
    expect(page).toContain('sectionWindowMix');
    expect(page).toContain('report-mix-warn');
    // The navigator offers quick window presets on top of the free from→to range.
    expect(page).toContain('WINDOW_PRESETS');
    expect(page).toContain('Last 30 days');
    expect(page).toContain('Last 1 year');
    // The template is token-clean: no hex colors in the stylesheet.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
