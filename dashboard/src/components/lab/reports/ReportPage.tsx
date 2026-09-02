import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useLabReport,
  useLabReportCommentary,
  useLabSyncJob,
  useStartLabReportCommentary,
  useStartLabSyncJob,
  type InsightSummary,
  type ResolvedReportItem,
} from '../../../hooks/useLab';
import { useLabSearchParams } from '../funnel/labRoute';
import { chartEntry, detailBodyFor } from '../chartRegistry';
import { formatValue } from '../chartBody';
import { resolveKitTokens } from '../labHtmlKit';
import { snapshotToSet } from '../matrixModel';
import { BreakdownBody } from '../BreakdownPivot';
import {
  parseCommentarySections,
  parseInlineMarkdown,
  reportToHtml,
  reportToMarkdown,
  sectionWindowMix,
  windowLabel,
} from './reportModel';
import type { InsightCache, ResolvedReportSection } from '../../../hooks/useLab';
import './ReportPage.css';

/**
 * The My Reports page (`/lab/reports/<slug>` — the F2 pushState contract),
 * drawn as the dreamcontext Reports template: brand masthead, designed
 * sections, stat-grid items, a footer that signs the document.
 *
 * A report composes EXISTING insight caches; this page owns no data either. Its
 * honesty rules:
 * - The date navigator shows "the latest sync AT/BEFORE the end of the chosen
 *   date", stamps every item "as of <sync time>", and renders an explicit empty
 *   state when no snapshot qualifies — never an interpolation (B4).
 * - Every item wears its measurement window next to the as-of stamp — a real
 *   window, "no declared window", or "window unknown" for dated series history
 *   (today's tweak must not relabel history). A section whose items mix
 *   windows says so on its face, not in a footnote.
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

function stepDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(fromISO: string, toISO: string): number {
  const span = Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`);
  return Number.isFinite(span) ? Math.max(0, Math.round(span / DAY_MS)) : 0;
}

function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

/** Minimal inline markdown (bold/code) as React nodes — prose and notes are
 *  written with `**` and backticks; rendering them literally reads as a bug. */
function InlineMd({ text }: { text: string }) {
  return (
    <>
      {parseInlineMarkdown(text).map((seg, i) => {
        if (seg.kind === 'strong') return <strong key={i}>{seg.text}</strong>;
        if (seg.kind === 'code') return <code key={i}>{seg.text}</code>;
        return <span key={i}>{seg.text}</span>;
      })}
    </>
  );
}

/** The report's brand line — the mark that says this document is dreamcontext's. */
function Masthead({ meta }: { meta: string }) {
  return (
    <>
      <header className="report-masthead">
        <span className="report-mark" aria-hidden="true" />
        <span className="report-logotype">dreamcontext</span>
        <span className="report-kicker">Reports</span>
        <span className="report-mast-meta">{meta}</span>
      </header>
      <div className="report-rule" aria-hidden="true" />
    </>
  );
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

/** True when the item's body is a single big number (packs into the stat grid). */
function isStatItem(item: ResolvedReportItem, date: string | null): boolean {
  if (item.render === 'number') return true;
  return date !== null && !item.matrixSnapshot && !item.funnelSnapshot;
}

function WindowChip({ item, dated }: { item: ResolvedReportItem; dated: boolean }) {
  const win = windowLabel(item, dated);
  // Inheritance-aware tones: data measuring its target window is quiet accent;
  // an item that keeps its own window (pin, or a manual tile that cannot
  // re-measure) says so out loud instead of blending in.
  if (item.windowStatus === 'aligned' || item.windowStatus === 'window') {
    return <span className="report-chip report-chip--known">{win.text}</span>;
  }
  if (item.windowStatus === 'stale') {
    return <span className="report-chip report-chip--known">{win.text} · refreshing</span>;
  }
  if (item.windowStatus === 'cannot') {
    return (
      <span className="report-chip report-chip--none" title="Manual tile — it has no source to re-measure a window with.">
        own · {win.text}
      </span>
    );
  }
  return <span className={`report-chip report-chip--${win.tone}`}>{win.text}</span>;
}

function ReportItemBlock({ item, date, settling, failure }: {
  item: ResolvedReportItem;
  date: string | null;
  settling: boolean;
  /** The window-sync error for this insight, when its measurement failed. */
  failure: string | null;
}) {
  if (item.missing) {
    return (
      <div className="report-item report-item--missing" role="alert">
        ⚠ Insight <code>{item.insight}</code> no longer exists — remove it from the report manifest.
      </div>
    );
  }
  const stat = isStatItem(item, date);
  const itemClass = `report-item${stat ? ' report-item--stat' : ''}`;
  const needsWindow = item.targetWindow !== null
    && (item.windowStatus === 'missing' || item.windowStatus === 'stale');
  if (item.asOf === null) {
    if (settling) {
      return (
        <div className={itemClass}>
          <div className="report-item-head"><span className="report-item-title">{item.title ?? item.insight}</span></div>
          <div className="report-skeleton" aria-label={`${item.title ?? item.insight} — syncing`} />
        </div>
      );
    }
    if (needsWindow) {
      // The window question is asked but not answered: measuring, or failed —
      // never a silently substituted other window.
      return (
        <div className={itemClass}>
          <div className="report-item-head"><span className="report-item-title">{item.title ?? item.insight}</span></div>
          <div className={failure ? 'report-empty report-window-failed' : 'report-empty'}>
            {failure
              ? `Could not measure ${item.targetWindow!.fromISO} → ${item.targetWindow!.toISO}: ${failure}`
              : `Measuring ${item.targetWindow!.fromISO} → ${item.targetWindow!.toISO}…`}
          </div>
        </div>
      );
    }
    return (
      <div className={itemClass}>
        <div className="report-item-head"><span className="report-item-title">{item.title ?? item.insight}</span></div>
        <div className="report-empty">
          {date
            ? `No snapshot at or before ${date} — this insight had not synced yet (nothing is interpolated).`
            : 'Never synced — no data to show yet.'}
        </div>
      </div>
    );
  }

  let body;
  if (item.cache) {
    // Cache-backed data — the live cache, or a window measurement (which is a
    // full cache shape too, so the real registry bodies draw it). Stat items
    // get the COMPACT card body (big number + spark), not the full detail
    // body — a lone number doesn't earn a panel-sized chart.
    const Body = stat
      ? chartEntry(item.render ?? 'number').CardBody
      : detailBodyFor(item.render ?? 'number');
    body = (
      <Body
        summary={itemSummary(item)}
        cache={item.cache}
        series={item.cache?.series ?? []}
        full={!stat}
        emptyHint="No data yet."
      />
    );
  } else {
    // Dated 'own' data: snapshot-backed, never the live cache.
    body = <DatedItemBody item={item} />;
  }
  return (
    <div className={itemClass}>
      <div className="report-item-head">
        <span className="report-item-title">{item.title ?? item.insight}</span>
        <WindowChip item={item} dated={date !== null} />
      </div>
      <div className="report-item-body">{body}</div>
      <div className="report-asof">as of {fmtWhen(item.asOf)}</div>
    </div>
  );
}

function ReportSectionBlock({ section, date, jobRunning, settledSlugs, failures, aiNote }: {
  section: ResolvedReportSection;
  date: string | null;
  jobRunning: boolean;
  settledSlugs: Set<string>;
  /** slug → error of the latest failed window/live sync. */
  failures: Map<string, string>;
  /** The commentary's note for THIS section (rendered under its items), or null. */
  aiNote: string | null;
}) {
  const mix = sectionWindowMix(section.items);
  return (
    <section className="report-section">
      <h2 className="report-section-title">{section.title}</h2>
      {mix && (
        <div className="report-mix-warn" role="note">
          ⚠ Mixed measurement windows in this section: {mix.join(', ')} — compare with care.
        </div>
      )}
      {section.prose && (
        <p className="report-section-prose"><InlineMd text={section.prose} /></p>
      )}
      <div className="report-items">
        {section.items.map((item) => {
          const needsWindow = item.targetWindow !== null
            && (item.windowStatus === 'missing' || item.windowStatus === 'stale');
          return (
            <ReportItemBlock
              key={item.insight}
              item={item}
              date={date}
              settling={jobRunning && !item.missing && !settledSlugs.has(item.insight)
                && (date === null || needsWindow)}
              failure={failures.get(item.insight) ?? null}
            />
          );
        })}
      </div>
      {aiNote && (
        <div className="report-ai-note">
          <span className="report-ai-chip" title="AI-generated section note">AI</span>
          <span><InlineMd text={aiNote.replace(/\n+/g, ' ')} /></span>
        </div>
      )}
    </section>
  );
}

/**
 * The optional AI-commentary panel — interpretation on top of the data, never
 * a substitute for it. Generated only on an explicit click (headless pure-text
 * claude run server-side), stored dated per view, and always labelled with its
 * model and generation time. Reports with `commentary: false` never mount it —
 * a report without an agent reading is first-class.
 */
function CommentaryPanel({ slug, date, from, summary, hasCommentary, model, generatedAt, job, onToast }: {
  slug: string;
  date: string | null;
  from: string | null;
  /** The parsed OVERALL reading (section notes render inside their sections). */
  summary: string | null;
  hasCommentary: boolean;
  model: string | null;
  generatedAt: string | null;
  job: { status: string; error: string | null } | null;
  onToast: (msg: string) => void;
}) {
  const start = useStartLabReportCommentary();
  const running = job?.status === 'running';

  return (
    <section className="report-commentary" aria-label="AI commentary">
      <div className="report-commentary-head">
        <span className="report-commentary-kicker">AI commentary</span>
        <span className="report-spacer" />
        {running ? (
          <span className="report-sync-status" role="status">writing…</span>
        ) : (
          <button
            className="report-action report-noprint"
            onClick={() => start.mutate({ slug, date, from }, {
              onError: (err) => onToast(`Commentary failed to start: ${(err as Error).message}`),
            })}
            title="Generate an AI reading of this view's numbers (nothing runs without this click)"
          >
            {hasCommentary ? 'Regenerate' : '✦ Analyze'}
          </button>
        )}
      </div>
      {job?.status === 'error' && (
        <div className="report-empty report-window-failed">Generation failed: {job.error}</div>
      )}
      {running && !hasCommentary && <div className="report-skeleton" aria-label="Commentary — generating" />}
      {hasCommentary && (
        <>
          {summary && (
            <div className="report-commentary-body">
              {summary.split(/\n{2,}/).map((para, i) => (
                <p key={i}><InlineMd text={para.replace(/\n/g, ' ')} /></p>
              ))}
            </div>
          )}
          <div className="report-asof">AI-generated · {model} · {generatedAt ? fmtWhen(generatedAt) : ''} — section notes sit inside their sections</div>
        </>
      )}
      {!hasCommentary && !running && job?.status !== 'error' && (
        <div className="report-empty">No commentary for this view yet — Analyze writes one from the numbers on screen.</div>
      )}
    </section>
  );
}

/** Notes → paragraphs with inline markdown; `## Notes` is scaffolding, not content. */
function ReportNotes({ notes }: { notes: string }) {
  const body = notes.replace(/^##\s*Notes\s*\n/, '').trim();
  if (!body) return null;
  return (
    <section className="report-section report-notes">
      <h2 className="report-section-title">Notes</h2>
      <div className="report-notes-body">
        {body.split(/\n{2,}/).map((para, i) => (
          <p key={i}><InlineMd text={para.replace(/\n/g, ' ')} /></p>
        ))}
      </div>
    </section>
  );
}

const NAV_LABEL: Record<string, string> = {
  daily: 'Daily report',
  weekly: 'Weekly report',
  monthly: 'Monthly report',
};

/** The date_nav default window span — mirrors the store's NAV_SPAN_DAYS. */
const NAV_SPAN: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };

/** Quick window presets — sugar over the free from→to range (span in days). */
const WINDOW_PRESETS: { label: string; days: number }[] = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 14 days', days: 14 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 1 year', days: 365 },
];

export function ReportPage({ slug, onBack, onToast }: ReportPageProps) {
  const [params, updateParams] = useLabSearchParams();
  const rawDate = params.get('date');
  const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  // The navigator's free-range start: with (date ?? today) as the end it forms
  // an explicit from→to window for every non-pinned item.
  const rawFrom = params.get('from');
  const from = rawFrom && /^\d{4}-\d{2}-\d{2}$/.test(rawFrom) ? rawFrom : null;

  const detail = useLabReport(slug, date, from);
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

  // The window syncs this view still owes: slug → target window for every
  // missing/stale item (the server computed the statuses; we just collect).
  const windowPlan = useMemo(() => {
    const plan: Record<string, { fromISO: string; toISO: string }> = {};
    for (const section of sections) {
      for (const item of section.items) {
        if (item.missing || !item.targetWindow) continue;
        if (item.windowStatus !== 'missing' && item.windowStatus !== 'stale') continue;
        if (!plan[item.insight]) plan[item.insight] = item.targetWindow;
      }
    }
    return plan;
  }, [sections]);
  const planKey = useMemo(
    () => Object.entries(windowPlan).map(([s, w]) => `${s}:${w.fromISO}_${w.toISO}`).sort().join('|'),
    [windowPlan],
  );

  // ── B8 + window inheritance: one scoped sync job per need, never two engines.
  // Live open → full refresh of the report's slugs, window overrides riding
  // along for the missing/stale ones. A date/window change → a windows-only
  // job. A foreign running job is waited out, then the plan re-runs; attempts
  // are capped per view so a permanently failing source cannot loop forever. ──
  const startedRef = useRef(false);
  /** True once THIS page started any job — the sync-status header keys off it. */
  const startedAnyRef = useRef(false);
  const runKey = `${slug}|${date ?? 'live'}|${from ?? ''}`;
  const attemptsRef = useRef({ key: runKey, count: 0 });
  if (attemptsRef.current.key !== runKey) attemptsRef.current = { key: runKey, count: 0 };
  const jobSettled = syncJob !== undefined && syncJob !== null && syncJob.status !== 'running';
  useEffect(() => {
    if (detail.data === undefined || detail.isFetching) return;
    if (syncJob?.status === 'running') return; // wait — re-runs on settle
    const planSlugs = Object.keys(windowPlan);
    if (date === null && !startedRef.current && reportSlugs.size > 0) {
      // Page open on Live: refresh everything once (the pre-window behavior),
      // with the owed windows riding the same job.
      startedRef.current = true;
      startedAnyRef.current = true;
      attemptsRef.current.count += 1;
      startJob.mutate(
        { force: true, slugs: [...reportSlugs], ...(planSlugs.length > 0 ? { windows: windowPlan } : {}) },
        { onError: (err) => onToast(`Report sync failed to start: ${(err as Error).message}`) },
      );
      return;
    }
    if (planSlugs.length === 0) return;
    if (attemptsRef.current.count >= 3) return; // a broken source must not loop
    attemptsRef.current.count += 1;
    startedAnyRef.current = true;
    startJob.mutate(
      { force: true, slugs: planSlugs, windows: windowPlan },
      { onError: (err) => onToast(`Window sync failed to start: ${(err as Error).message}`) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data, detail.isFetching, syncJob?.status, runKey, planKey]);

  // Progressive fill: as OUR insights settle in the job, refetch the report so
  // each section flips from skeleton to content one insight at a time — and
  // once more when the whole job settles (so the plan re-derives from fresh
  // statuses before the next attempt).
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
  const lastSettledJob = useRef<string | null>(null);
  useEffect(() => {
    if (!jobSettled || !syncJob || lastSettledJob.current === syncJob.id) return;
    lastSettledJob.current = syncJob.id;
    queryClient.invalidateQueries({ queryKey: ['lab-report', slug] });
  }, [jobSettled, syncJob, queryClient, slug]);

  // slug → error message of its latest failed sync (window items surface it).
  const failures = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of syncJob?.results ?? []) {
      if (r.status === 'failed' && reportSlugs.has(r.slug)) out.set(r.slug, r.error ?? 'sync failed');
    }
    return out;
  }, [syncJob?.results, reportSlugs]);

  const jobRunning = syncJob?.status === 'running' && startedAnyRef.current;
  /** A section is ready when every non-missing item has settled or shows data. */
  const readySections = sections.filter((s) =>
    s.items.every((i) => i.missing || i.asOf !== null || settledSlugs.has(i.insight)),
  ).length;

  const dateNav = report?.date_nav ?? 'none';
  const setView = (nextDate: string | null, nextFrom: string | null) => {
    updateParams((p) => {
      if (nextDate) p.set('date', nextDate);
      else p.delete('date');
      if (nextFrom) p.set('from', nextFrom);
      else p.delete('from');
    });
  };
  const setDate = (next: string | null) => {
    // Keep a custom start only while it still precedes the new end.
    setView(next, from && next && from <= next ? from : from && next === null ? from : null);
  };

  // The commentary of this view: the overall reading feeds the top panel and
  // the exports; per-section notes render inside their sections.
  const commentaryQuery = useLabReportCommentary(
    detail.data?.report.commentaryEnabled !== false ? slug : null,
    date,
  );
  const exportCommentary = commentaryQuery.data?.commentary ?? null;
  const commentaryJob = commentaryQuery.data?.job ?? null;
  const parsedCommentary = useMemo(
    () => (exportCommentary
      ? parseCommentarySections(exportCommentary.body, sections.map((s) => s.title))
      : null),
    [exportCommentary, sections],
  );

  const [copied, setCopied] = useState(false);
  const copyMarkdown = async () => {
    if (!detail.data) return;
    try {
      await navigator.clipboard.writeText(reportToMarkdown(detail.data, exportCommentary));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      onToast('Clipboard unavailable — copy failed.');
    }
  };

  const exportHtml = () => {
    if (!detail.data) return;
    const html = reportToHtml(detail.data, resolveKitTokens(), exportCommentary);
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
  const insightCount = reportSlugs.size;

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

      <article className="report-sheet">
        <Masthead meta={NAV_LABEL[dateNav] ?? 'Report'} />

        <h1 className="report-title">{report.title}</h1>
        {report.description && <p className="report-desc">{report.description}</p>}
        <div className="report-metaline">
          <span className="report-chip report-chip--accent">
            {date ? `Window ending ${date}` : from ? 'Custom window' : 'Live data'}
          </span>
          {dateNav !== 'none' && (
            <span className="report-chip">
              {from ? daysBetween(from, shownDate) : NAV_SPAN[dateNav]}-day window
            </span>
          )}
          <span className="report-chip">{sections.length} section{sections.length === 1 ? '' : 's'}</span>
          <span className="report-chip">{insightCount} insight{insightCount === 1 ? '' : 's'}</span>
        </div>

        {dateNav !== 'none' && (() => {
          // The navigator IS the window: [from] → [to]. `from` untouched =
          // the date_nav default trailing span; edited = a free custom range
          // (still losing to per-item pins, which say so on their chips).
          const spanShown = from ? daysBetween(from, shownDate) : NAV_SPAN[dateNav];
          const shownFrom = from ?? stepDays(shownDate, -NAV_SPAN[dateNav]);
          const stepBy = Math.max(1, spanShown);
          const goPrev = () => {
            if (from) setView(stepDays(shownDate, -stepBy), stepDays(from, -stepBy));
            else setDate(stepDate(shownDate, dateNav, -1));
          };
          const goNext = () => {
            if (from) {
              const nextTo = stepDays(shownDate, stepBy);
              if (nextTo >= today) setView(null, null);
              else setView(nextTo, stepDays(from, stepBy));
            } else {
              setDate(stepDate(shownDate, dateNav, 1) >= today ? null : stepDate(shownDate, dateNav, 1));
            }
          };
          const presetValue = from
            ? (WINDOW_PRESETS.find((p) => p.days === spanShown)?.days.toString() ?? 'custom')
            : 'default';
          return (
            <div className="report-datenav report-noprint" aria-label="Report window">
              <select
                className="report-date-input"
                aria-label="Window preset"
                value={presetValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'default') setView(date, null);
                  else if (v !== 'custom') setView(date, stepDays(shownDate, -Number(v)));
                }}
              >
                <option value="default">Default · {NAV_SPAN[dateNav]}-day</option>
                {WINDOW_PRESETS.map((p) => (
                  <option key={p.days} value={p.days}>{p.label}</option>
                ))}
                {presetValue === 'custom' && <option value="custom">Custom · {spanShown}-day</option>}
              </select>
              <button className="report-action" onClick={goPrev} title="Earlier">←</button>
              <input
                type="date"
                className="report-date-input"
                aria-label="Window start"
                value={shownFrom}
                max={shownDate}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) setView(date, null);
                  else if (v <= shownDate) setView(date, v);
                }}
              />
              <span className="report-date-hint">→</span>
              <input
                type="date"
                className="report-date-input"
                aria-label="Window end"
                value={shownDate}
                max={today}
                onChange={(e) => setDate(e.target.value === today ? null : e.target.value || null)}
              />
              <button
                className="report-action"
                onClick={goNext}
                disabled={date === null}
                title="Later"
              >→</button>
              <button
                className="report-action"
                onClick={() => setView(null, null)}
                disabled={date === null && from === null}
              >
                Live
              </button>
              <span className="report-date-hint">
                {from
                  ? `Every item measures ${shownFrom} → ${date ?? 'today'} (custom range) — pinned/own items say so on their chip.`
                  : date
                    ? `Every item measures the ${NAV_SPAN[dateNav]} days ending ${date} — pinned/own items say so on their chip.`
                    : `Live — measuring the ${NAV_SPAN[dateNav]} days ending today.`}
              </span>
            </div>
          );
        })()}

        {report.commentaryEnabled !== false && (
          <CommentaryPanel
            slug={slug}
            date={date}
            from={from}
            summary={parsedCommentary?.summary || null}
            hasCommentary={exportCommentary !== null}
            model={exportCommentary?.model ?? null}
            generatedAt={exportCommentary?.generatedAt ?? null}
            job={commentaryJob}
            onToast={onToast}
          />
        )}

        {sections.map((section) => (
          <ReportSectionBlock
            key={section.title}
            section={section}
            date={date}
            jobRunning={jobRunning}
            settledSlugs={settledSlugs}
            failures={failures}
            aiNote={parsedCommentary?.sections[section.title] ?? null}
          />
        ))}

        {report.notes && <ReportNotes notes={report.notes} />}

        <footer className="report-foot">
          <span className="report-mark" aria-hidden="true" />
          <span>Generated with dreamcontext Reports</span>
          <span className="report-spacer" />
          <span>{new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
        </footer>
      </article>
    </div>
  );
}
