import { useState } from 'react';
import type { InsightSummary } from '../../hooks/useLab';
import { useLabInsight, useSyncInsight, useUpdateTweaks } from '../../hooks/useLab';
import { TweakEditor } from './TweakEditor';
import { RangeControl, nonWindowTweaks } from './RangeControl';
import { cardSpan, chartEntry } from './chartRegistry';
import { HtmlInsightBody } from './HtmlInsightBody';
import './InsightCard.css';

/** Staleness badge: fresh / stale(Nh) / never synced / error. */
function StalenessBadge({ summary }: { summary: InsightSummary }) {
  if (summary.error) {
    return <span className="lab-badge lab-badge--error" title={summary.error}>⚠ error</span>;
  }
  if (!summary.fetchedAt) {
    return <span className="lab-badge lab-badge--muted">never synced</span>;
  }
  if (summary.stale) {
    const hours = summary.staleMinutes !== null ? Math.round(summary.staleMinutes / 60) : null;
    return <span className="lab-badge lab-badge--stale">stale{hours !== null ? ` (${hours}h)` : ''}</span>;
  }
  return <span className="lab-badge lab-badge--fresh">fresh</span>;
}

export function InsightCard({
  summary,
  onToast,
  onOpen,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  summary: InsightSummary;
  onToast: (msg: string) => void;
  onOpen: (slug: string) => void;
  /** Dimmed "ghost" state while this card is the one being dragged. */
  dragging?: boolean;
  /** Highlighted while another card hovers here — drop takes this position. */
  dropTarget?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const [showTweaks, setShowTweaks] = useState(false);
  const detail = useLabInsight(summary.slug);
  const sync = useSyncInsight();
  const updateTweaks = useUpdateTweaks();

  const cache = detail.data?.cache;
  const series = cache?.series ?? [];

  /** Re-fetch this insight and report the outcome, including a per-insight `failed[]` row
   *  (a sync can answer 200 and still have failed for THIS slug). */
  const runSync = (okMessage: string, failPrefix: string) => {
    sync.mutate(summary.slug, {
      onSuccess: (data) => {
        const result = data.results[0];
        if (result?.status === 'failed') onToast(`${summary.title}: ${failPrefix} — ${result.error ?? 'unknown error'}`);
        else onToast(`${summary.title}: ${okMessage}`);
      },
      onError: (err) => onToast(`${summary.title}: ${failPrefix} — ${(err as Error).message}`),
    });
  };

  const handleRefresh = () => runSync('refreshed.', 'refresh failed');

  const handleSaveTweaks = (values: Record<string, string>) => {
    updateTweaks.mutate({ slug: summary.slug, tweaks: values }, {
      // Data follows the control (#235). A tweak can change the WINDOW the number is
      // computed over, so saving it and leaving the tile on the pre-tweak cache shows a
      // number that no longer answers the question the card is now asking — and nothing on
      // the tile says so. The funnel views have always chained PATCH → sync for this reason;
      // the generic card only PATCHed and toasted "saved".
      onSuccess: () => runSync('tweaks saved, refreshed.', 'tweaks saved, but the refresh failed'),
      onError: (err) => onToast(`${summary.title}: could not save tweaks — ${(err as Error).message}`),
    });
  };

  /** The RangeControl changes the WINDOW the number is computed over — the same
   *  PATCH → sync chain the tweak editor uses (#235). */
  const handleApplyRange = (values: Record<string, string>, label: string) => {
    updateTweaks.mutate({ slug: summary.slug, tweaks: values }, {
      onSuccess: () => runSync(`${label} applied.`, `${label} saved, but the refresh failed`),
      onError: (err) => onToast(`${summary.title}: ${label} failed — ${(err as Error).message}`),
    });
  };

  const editableTweaks = nonWindowTweaks(summary.tweaks);

  // Shell/body split: everything below is chrome (title, badges, staleness,
  // refresh, range, tweaks). What the card DRAWS comes from the registry.
  const entry = chartEntry(summary.render);
  const CardBody = entry.CardBody;

  return (
    <div
      // Some renders need ~2 board columns (a funnel or metric table is a table);
      // a manifest `size` can override that. The grid grants the span only where
      // it is actually wide enough (LabBoard.css).
      className={[
        'lab-card lab-card--clickable',
        cardSpan(summary.render, summary.size) === 2 ? 'lab-card--wide' : '',
        dragging ? 'lab-card--dragging' : '',
        dropTarget ? 'lab-card--drop-target' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onOpen(summary.slug)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(summary.slug); }}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title={entry.openHint}
    >
      <div className="lab-card-header">
        <div className="lab-card-title-row">
          <span className="lab-card-title">{summary.title}</span>
          {summary.binding && (
            <span className="lab-badge lab-badge--binding" title={`Feeds objective: ${summary.binding.objective}`}>
              feeds {summary.binding.objective}
            </span>
          )}
        </div>
        <div className="lab-card-actions" onClick={(e) => e.stopPropagation()}>
          <StalenessBadge summary={summary} />
          <button
            className="lab-card-refresh"
            onClick={handleRefresh}
            disabled={sync.isPending}
            title="Refresh this insight"
          >{sync.isPending ? '…' : '↻'}</button>
        </div>
      </div>

      {/* Every insight the registry marks windowed gets the range chip — and
          resolveTweaks derives a window for all of today's renders, so it is in
          practice unconditional. Clicks and Enter are trapped here; the card
          itself opens the detail panel on both. */}
      {entry.supportsWindow && (
        <div
          className="lab-card-toolbar"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <RangeControl
            tweaks={summary.tweaks}
            compact
            disabled={updateTweaks.isPending || sync.isPending}
            onApply={handleApplyRange}
          />
        </div>
      )}

      {/* The card body keeps its own hover layer (chart tooltips) — clicks
          still bubble to the card and open the panel. A script-authored html
          body (html/v1 hybrid) replaces the typed CARD body only; the detail
          panel always shows the typed twin next to it (a11y). */}
      <div className="lab-card-body">
        {cache?.html ? (
          <HtmlInsightBody html={cache.html} title={summary.title} />
        ) : (
          <CardBody
            summary={summary}
            cache={cache ?? null}
            series={series}
            emptyHint={entry.emptyHint}
          />
        )}
      </div>

      {editableTweaks.length > 0 && (
        <div className="lab-card-tweaks" onClick={(e) => e.stopPropagation()}>
          <button className="lab-card-tweaks-toggle" onClick={() => setShowTweaks((v) => !v)}>
            {showTweaks ? 'Hide tweaks' : 'Edit tweaks'}
          </button>
          {showTweaks && (
            <TweakEditor
              tweaks={editableTweaks}
              saving={updateTweaks.isPending}
              onSave={handleSaveTweaks}
            />
          )}
        </div>
      )}
    </div>
  );
}
