import { useEffect } from 'react';
import type { InsightSummary, SyncEvent } from '../../hooks/useLab';
import { useLabInsight, useSyncInsight, useUpdateTweaks } from '../../hooks/useLab';
import { pushOverlay, popOverlay, isTopOverlay } from '../../lib/overlayStack';
import { NumberCard } from './NumberCard';
import { LineChart } from './LineChart';
import { PieChart } from './PieChart';
import { RawDataView } from './RawDataView';
import { TweakEditor } from './TweakEditor';
import './InsightDetailPanel.css';

/**
 * InsightDetailPanel — the slide-over that opens when you click an insight card.
 * The card is the thumbnail; this is the full story: a large interactive chart,
 * the `## Meaning` prose, source/config details, tweak editing, and the bounded
 * sync history (recorded by the sync engine from each real run).
 */

interface Props {
  summary: InsightSummary;
  onClose: () => void;
  onToast: (msg: string) => void;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtTtl(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

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

function HistoryRow({ event, unit }: { event: SyncEvent; unit: string | null }) {
  return (
    <div className="idp-history-row">
      <span className={`idp-history-dot idp-history-dot--${event.status}`} />
      <span className="idp-history-when">{fmtWhen(event.at)}</span>
      {event.status === 'ok' ? (
        <span className="idp-history-value">
          {event.latest !== null ? event.latest.toLocaleString() : '—'}
          {event.latest !== null && unit ? ` ${unit}` : ''}
          {event.granularity && <span className="idp-history-gran">{event.granularity}</span>}
        </span>
      ) : (
        <span className="idp-history-error" title={event.error ?? undefined}>{event.error ?? 'failed'}</span>
      )}
    </div>
  );
}

export function InsightDetailPanel({ summary, onClose, onToast }: Props) {
  const detail = useLabInsight(summary.slug);
  const sync = useSyncInsight();
  const updateTweaks = useUpdateTweaks();

  // Esc closes — but only when this panel is the topmost overlay (overlayStack,
  // same contract as CommandModal) and never while the user is typing in a form
  // field (Esc there dismisses the field, not the panel with their unsaved edits).
  useEffect(() => {
    const id = 'insight-detail-panel';
    pushOverlay(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopOverlay(id)) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        target.blur();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      popOverlay(id);
    };
  }, [onClose]);

  const manifest = detail.data?.insight ?? null;
  const cache = detail.data?.cache ?? null;
  const series = cache?.series ?? [];
  const meaning = (detail.data?.meaning ?? '').replace(/^##\s*Meaning\s*/i, '').trim();
  const resolvedTweaks = detail.data?.resolvedTweaks ?? {};
  // Newest first — the reader wants "what happened last", not the epoch.
  // Array.isArray: the cache file is user-editable JSON; a malformed history
  // must not crash the whole panel render.
  const history = Array.isArray(cache?.history) ? [...cache.history].reverse() : [];

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

  const detailRows: [string, string][] = [];
  if (summary.group) detailRows.push(['Group', summary.group]);
  if (manifest?.adapter) detailRows.push(['Source', manifest.adapter === 'http' ? `HTTP ${manifest.method ?? 'GET'}` : 'custom script']);
  detailRows.push(['Render', summary.render]);
  if (summary.unit) detailRows.push(['Unit', summary.unit]);
  detailRows.push(['Refresh TTL', fmtTtl(summary.ttlMinutes)]);
  if (cache?.granularity) detailRows.push(['Granularity', cache.granularity]);
  if (summary.fetchedAt) detailRows.push(['Last synced', fmtWhen(summary.fetchedAt)]);
  if (manifest && manifest.credentials_used.length > 0) detailRows.push(['Credentials', manifest.credentials_used.join(', ')]);
  const tweakEntries = Object.entries(resolvedTweaks);

  return (
    <>
      <div className="idp-overlay" onClick={onClose} />
      <div className="idp-panel" role="dialog" aria-modal="true" aria-label={summary.title}>
        <div className="idp-head">
          <div className="idp-head-row">
            <StalenessBadge summary={summary} />
            {summary.binding && (
              <span className="lab-badge lab-badge--binding" title={`Feeds objective: ${summary.binding.objective}`}>
                feeds {summary.binding.objective}
              </span>
            )}
            <span className="idp-spacer" />
            <button className="idp-refresh" onClick={handleRefresh} disabled={sync.isPending} title="Refresh this insight">
              {sync.isPending ? 'Refreshing…' : '↻ Refresh'}
            </button>
            <span className="idp-close" onClick={onClose} title="Close (Esc)">✕</span>
          </div>
          <div className="idp-title">{summary.title}</div>
          <div className="idp-slug">{summary.slug}</div>
          {manifest?.description && <div className="idp-desc">{manifest.description}</div>}
        </div>

        <div className="idp-body">
          {summary.error && (
            <div className="idp-error-banner">
              <span className="idp-error-glyph">⚠</span>
              <div>
                <div className="idp-error-title">Last sync failed{summary.errorAt ? ` · ${fmtWhen(summary.errorAt)}` : ''}</div>
                <div className="idp-error-sub">{summary.error}</div>
              </div>
            </div>
          )}

          {detail.isLoading ? (
            <div className="idp-loading">Loading…</div>
          ) : (
            <div className="idp-columns">
              <div className="idp-col-main">
                <div className="idp-chart">
                  {summary.render === 'number' && (
                    <>
                      <NumberCard latest={summary.latest} unit={summary.unit} series={series} />
                      {series.some((s) => s.points.length > 1) && (
                        <div className="idp-chart-trend">
                          <LineChart series={series} unit={summary.unit} height={280} />
                        </div>
                      )}
                    </>
                  )}
                  {summary.render === 'line' && <LineChart series={series} unit={summary.unit} height={340} />}
                  {summary.render === 'pie' && <PieChart series={series} size={240} unit={summary.unit} />}
                  {summary.render === 'raw' && <RawDataView series={series} />}
                </div>

                {meaning && (
                  <>
                    <div className="idp-section-label">Meaning</div>
                    <div className="idp-meaning">{meaning}</div>
                  </>
                )}
              </div>

              <div className="idp-col-rail">
                <div className="idp-section-label">Details</div>
                <div className="idp-details">
                  {detailRows.map(([label, value]) => (
                    <div key={label} className="idp-detail-row">
                      <span className="idp-detail-label">{label}</span>
                      <span className="idp-detail-value">{value}</span>
                    </div>
                  ))}
                  {tweakEntries.length > 0 && (
                    <div className="idp-detail-row">
                      <span className="idp-detail-label">Tweaks</span>
                      <span className="idp-detail-value">
                        {tweakEntries.map(([k, v]) => `${k}=${v}`).join(' · ')}
                      </span>
                    </div>
                  )}
                </div>

                {summary.tweaks.length > 0 && (
                  <div className="idp-tweaks">
                    <div className="idp-section-label">Edit tweaks</div>
                    <TweakEditor tweaks={summary.tweaks} saving={updateTweaks.isPending} onSave={handleSaveTweaks} />
                  </div>
                )}

                <div className="idp-section-label">
                  Update history
                  {history.length > 0 && <span className="idp-history-count">{history.length}</span>}
                </div>
                {history.length === 0 ? (
                  <div className="idp-history-empty">
                    No sync history yet — each refresh from now on is recorded here.
                  </div>
                ) : (
                  <div className="idp-history">
                    {history.map((event, i) => (
                      <HistoryRow key={`${event.at}-${i}`} event={event} unit={summary.unit} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
