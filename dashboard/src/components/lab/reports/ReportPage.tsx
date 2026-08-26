import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useLabReport,
  useLabSyncJob,
  useStartLabSyncJob,
  type InsightSummary,
  type ResolvedReportItem,
} from '../../../hooks/useLab';
import { useLabSearchParams } from '../funnel/labRoute';
import { detailBodyFor } from '../chartRegistry';
import { formatValue } from '../chartBody';
import { resolveKitTokens } from '../labHtmlKit';
import { snapshotToSet } from '../matrixModel';
import { BreakdownBody } from '../BreakdownPivot';
import { reportToHtml, reportToMarkdown } from './reportModel';
import type { InsightCache } from '../../../hooks/useLab';
import './ReportPage.css';

/**
 * The My Reports page (`/lab/reports/<slug>` — the F2 pushState contract).
 *
 * A report composes EXISTING insight caches; this page owns no data either. Its
 * three honesty rules:
 * - The date navigator shows "the latest sync AT/BEFORE the end of the chosen
 *   date", stamps every item "as of <sync time>", and renders an explicit empty
 *   state when no snapshot qualifies — never an interpolation (B4).
 * - A reference to a deleted insight renders a warning strip, not a crash (B6).
 * - Opening the report starts ONE scoped sync job (`slugs[]`) and sections fill
 *   progressively as each insight settles — the header counts n/m ready and
 *   names the insight currently syncing; the job survives navigation via the
 *   same adopt idiom the board uses (B8).
 */

interface ReportPageProps {
  slug: string;
  onBack: () => void;
  onToast: (msg: string) => void;
}

const DAY_MS = 86_400_000;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Step a YYYY-MM-DD date by the report's nav granularity. */
function stepDate(date: string, nav: 'daily' | 'weekly' | 'monthly', dir: 1 | -1): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (nav === 'monthly') {
    d.setUTCMonth(d.getUTCMonth() + dir);
    return d.toISOString().slice(0, 10);
  }
  return new Date(d.getTime() + dir * (nav === 'weekly' ? 7 : 1) * DAY_MS).toISOString().slice(0, 10);
}

function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

/** A minimal InsightSummary for the registry bodies (they read title/unit/slug). */
function itemSummary(item: ResolvedReportItem): InsightSummary {
  return {
    slug: item.insight,
    title: item.title ?? item.insight,
    category: null,
    group: null,
    render: (item.render ?? 'number') as InsightSummary['render'],
    size: null,
    unit: item.unit,
    binding: null,
    latest: item.latest,
    fetchedAt: item.asOf,
    granularity: null,
    error: null,
    errorAt: null,
    ttlMinutes: 1440,
    staleMinutes: null,
    stale: null,
    tweaks: [],
  };
}

/** The dated-view body for one item — snapshot-backed, never the live cache. */
function DatedItemBody({ item }: { item: ResolvedReportItem }) {
  if (item.matrixSnapshot) {
    // Re-render the dated snapshot through the real pivot: a synthetic cache
    // carrying ONLY the snapshot's set (no history → no Δ chips, honestly).
    const set = snapshotToSet(item.matrixSnapshot);
    const cache = {
      slug: item.insight,
      fetchedAt: item.matrixSnapshot.at,
      tweaks: {},
      granularity: 'daily',
      unit: item.unit,
      series: [],
      latest: item.matrixSnapshot.total?.v ?? null,
      error: null,
      errorAt: null,
      scriptHash: null,
      matrix: { set, notices: [], range: item.matrixSnapshot.range },
    } as unknown as InsightCache;
    return <BreakdownBody summary={itemSummary(item)} cache={cache} series={[]} full />;
  }
  if (item.funnelSnapshot) {
    return (
      <div className="report-funnel-snap">
        {item.funnelSnapshot.funnels.map((funnel) => (
          <table className="report-mini-table" key={funnel.id}>
            <thead>
              <tr><th>{funnel.id}</th><th className="report-num">Users</th></tr>
            </thead>
            <tbody>
              {funnel.steps.map((step) => (
                <tr key={step.key}>
                  <td>{step.key}</td>
                  <td className="report-num">{step.users.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    );
  }
  return <div className="report-big-number">{formatValue(item.latest, item.unit)}</div>;
}

function ReportItemBlock({ item, date, settling }: {
  item: ResolvedReportItem;
  date: string | null;
  settling: boolean;
}) {
  if (item.missing) {
    return (
      <div className="report-item report-item--missing" role="alert">
        ⚠ Insight <code>{item.insight}</code> no longer exists — remove it from the report manifest.
      </div>
    );
  }
  if (item.asOf === null) {
    if (settling) {
      return (
        <div className="report-item">
          <div className="report-item-title">{item.title ?? item.insight}</div>
          <div className="report-skeleton" aria-label={`${item.title ?? item.insight} — syncing`} />
        </div>
      );
    }
    return (
      <div className="report-item">
        <div className="report-item-title">{item.title ?? item.insight}</div>
        <div className="report-empty">
          {date
            ? `No snapshot at or before ${date} — this insight had not synced yet (nothing is interpolated).`
            : 'Never synced — no data to show yet.'}
        </div>
      </div>
    );
  }

  let body;
  if (date !== null) {
    body = <DatedItemBody item={item} />;
  } else {
    const Body = detailBodyFor(item.render ?? 'number');
    body = (
      <Body
        summary={itemSummary(item)}
        cache={item.cache}
        series={item.cache?.series ?? []}
        full
        emptyHint="No data yet."
      />
    );
  }
  return (
    <div className="report-item">
      <div className="report-item-title">{item.title ?? item.insight}</div>
      {body}
      <div className="report-asof">as of {fmtWhen(item.asOf)}</div>
    </div>
  );
}

export function ReportPage({ slug, onBack, onToast }: ReportPageProps) {
  const [params, updateParams] = useLabSearchParams();
  const rawDate = params.get('date');
  const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;

  const detail = useLabReport(slug, date);
  const queryClient = useQueryClient();
  const { data: syncJob } = useLabSyncJob();
  const startJob = useStartLabSyncJob();

  const report = detail.data?.report ?? null;
  const sections = detail.data?.sections ?? [];
  const reportSlugs = useMemo(() => {
    const out = new Set<string>();
    for (const section of sections) for (const item of section.items) if (!item.missing) out.add(item.insight);
    return out;
  }, [sections]);

  // ── B8: one scoped sync job per page open (the server adopts a running job
  // rather than double-syncing). Started once we know the report's slugs. ──
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || detail.data === undefined || reportSlugs.size === 0) return;
    startedRef.current = true;
    startJob.mutate({ force: true, slugs: [...reportSlugs] }, {
      onError: (err) => onToast(`Report sync failed to start: ${(err as Error).message}`),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data, reportSlugs]);

  // Progressive fill: as OUR insights settle in the job, refetch the report so
  // each section flips from skeleton to content one insight at a time.
  const settledSlugs = useMemo(() => {
    const settled = new Set<string>();
    for (const r of syncJob?.results ?? []) {
      if (reportSlugs.has(r.slug)) settled.add(r.slug);
    }
    return settled;
  }, [syncJob?.results, reportSlugs]);
  const settledCount = settledSlugs.size;
  const lastSettledCount = useRef(0);
  useEffect(() => {
    if (settledCount === lastSettledCount.current) return;
    lastSettledCount.current = settledCount;
    queryClient.invalidateQueries({ queryKey: ['lab-report', slug] });
  }, [settledCount, queryClient, slug]);

  const jobRunning = syncJob?.status === 'running' && startedRef.current;
  /** A section is ready when every non-missing item has settled or shows data. */
  const readySections = sections.filter((s) =>
    s.items.every((i) => i.missing || i.asOf !== null || settledSlugs.has(i.insight)),
  ).length;

  const dateNav = report?.date_nav ?? 'none';
  const setDate = (next: string | null) => {
    updateParams((p) => {
      if (next) p.set('date', next);
      else p.delete('date');
    });
  };

  const [copied, setCopied] = useState(false);
  const copyMarkdown = async () => {
    if (!detail.data) return;
    try {
      await navigator.clipboard.writeText(reportToMarkdown(detail.data));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      onToast('Clipboard unavailable — copy failed.');
    }
  };

  const exportHtml = () => {
    if (!detail.data) return;
    const html = reportToHtml(detail.data, resolveKitTokens());
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}${date ? `-${date}` : ''}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (detail.isLoading) {
    return <div className="report-page"><div className="report-loading">Loading report…</div></div>;
  }
  if (detail.isError || !report) {
    return (
      <div className="report-page">
        <button className="report-back" onClick={onBack}>← Insights</button>
        <div className="report-empty">Report not found: {slug}</div>
      </div>
    );
  }

  const today = todayISO();
  const shownDate = date ?? today;

  return (
    <div className="report-page">
      <div className="report-head report-noprint">
        <button className="report-back" onClick={onBack}>← Insights</button>
        <span className="report-spacer" />
        {jobRunning && (
          <span className="report-sync-status" role="status">
            {readySections}/{sections.length} section(s) ready
            {syncJob?.current && reportSlugs.has(syncJob.current) ? ` · syncing ${syncJob.current}` : ''}
          </span>
        )}
        <button className="report-action" onClick={copyMarkdown}>{copied ? '✓ copied' : 'Copy as Markdown'}</button>
        <button className="report-action" onClick={exportHtml} title="Download the report as one self-contained HTML file">Export HTML</button>
        <button className="report-action" onClick={() => window.print()} title="Print (or save as PDF)">Print</button>
      </div>

      <h1 className="report-title">{report.title}</h1>
      {report.description && <div className="report-desc">{report.description}</div>}

      {dateNav !== 'none' && (
        <div className="report-datenav report-noprint" aria-label="Report date">
          <button
            className="report-action"
            onClick={() => setDate(stepDate(shownDate, dateNav, -1))}
            title="Earlier"
          >←</button>
          <input
            type="date"
            className="report-date-input"
            value={shownDate}
            max={today}
            onChange={(e) => setDate(e.target.value === today ? null : e.target.value || null)}
          />
          <button
            className="report-action"
            onClick={() => setDate(stepDate(shownDate, dateNav, 1) >= today ? null : stepDate(shownDate, dateNav, 1))}
            disabled={date === null}
            title="Later"
          >→</button>
          <button className="report-action" onClick={() => setDate(null)} disabled={date === null}>
            Live
          </button>
          <span className="report-date-hint">
            {date
              ? `Showing the latest sync at/before end of ${date} — nothing is interpolated.`
              : 'Live data'}
          </span>
        </div>
      )}

      {sections.map((section) => (
        <section className="report-section" key={section.title}>
          <h2 className="report-section-title">{section.title}</h2>
          {section.prose && <p className="report-section-prose">{section.prose}</p>}
          {section.items.map((item) => (
            <ReportItemBlock
              key={item.insight}
              item={item}
              date={date}
              settling={jobRunning && !item.missing && !settledSlugs.has(item.insight) && date === null}
            />
          ))}
        </section>
      ))}

      {report.notes && (
        <section className="report-section report-notes">
          <div className="report-notes-body">{report.notes}</div>
        </section>
      )}
    </div>
  );
}
