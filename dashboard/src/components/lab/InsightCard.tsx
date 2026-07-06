import { useState } from 'react';
import type { InsightSummary } from '../../hooks/useLab';
import { useLabInsight, useSyncInsight, useUpdateTweaks } from '../../hooks/useLab';
import { NumberCard } from './NumberCard';
import { LineChart } from './LineChart';
import { PieChart } from './PieChart';
import { RawDataView } from './RawDataView';
import { TweakEditor } from './TweakEditor';
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
}: {
  summary: InsightSummary;
  onToast: (msg: string) => void;
  onOpen: (slug: string) => void;
}) {
  const [showTweaks, setShowTweaks] = useState(false);
  const detail = useLabInsight(summary.slug);
  const sync = useSyncInsight();
  const updateTweaks = useUpdateTweaks();

  const cache = detail.data?.cache;
  const series = cache?.series ?? [];

  const handleRefresh = () => {
    sync.mutate(summary.slug, {
      onSuccess: (data) => {
        const result = data.results[0];
        if (result?.status === 'failed') onToast(`${summary.title}: sync failed — ${result.error ?? 'unknown error'}`);
        else onToast(`${summary.title}: refreshed.`);
      },
      onError: (err) => onToast(`${summary.title}: refresh failed — ${(err as Error).message}`),
    });
  };

  const handleSaveTweaks = (values: Record<string, string>) => {
    updateTweaks.mutate({ slug: summary.slug, tweaks: values }, {
      onSuccess: () => onToast(`${summary.title}: tweaks saved.`),
      onError: (err) => onToast(`${summary.title}: could not save tweaks — ${(err as Error).message}`),
    });
  };

  return (
    <div
      className="lab-card lab-card--clickable"
      onClick={() => onOpen(summary.slug)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(summary.slug); }}
      title="Open details, history & interactive chart"
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

      {/* The card body keeps its own hover layer (chart tooltips) — clicks
          still bubble to the card and open the panel. */}
      <div className="lab-card-body">
        {summary.render === 'number' && <NumberCard latest={summary.latest} unit={summary.unit} series={series} />}
        {summary.render === 'line' && <LineChart series={series} unit={summary.unit} />}
        {summary.render === 'pie' && <PieChart series={series} unit={summary.unit} />}
        {summary.render === 'raw' && (
          <div onClick={(e) => e.stopPropagation()}>
            <RawDataView series={series} />
          </div>
        )}
      </div>

      {summary.tweaks.length > 0 && (
        <div className="lab-card-tweaks" onClick={(e) => e.stopPropagation()}>
          <button className="lab-card-tweaks-toggle" onClick={() => setShowTweaks((v) => !v)}>
            {showTweaks ? 'Hide tweaks' : 'Edit tweaks'}
          </button>
          {showTweaks && (
            <TweakEditor
              tweaks={summary.tweaks}
              saving={updateTweaks.isPending}
              onSave={handleSaveTweaks}
            />
          )}
        </div>
      )}
    </div>
  );
}
