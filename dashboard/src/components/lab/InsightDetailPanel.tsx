import { useEffect } from 'react';
import type { InsightSummary, SyncEvent } from '../../hooks/useLab';
import { useApplyTweaks, useLabInsight, useSyncInsight } from '../../hooks/useLab';
import { pushOverlay, popOverlay, isTopOverlay } from '../../lib/overlayStack';
import { useOverlayId } from '../../lib/useOverlayId';
import { TweakEditor } from './TweakEditor';
import { RangeControl, nonWindowTweaks } from './RangeControl';
import { chartEntry, detailBodyFor } from './chartRegistry';
import { humanizeTweakKey, humanizeTweakValue } from './tweakLabels';
import { useI18n } from '../../context/I18nContext';
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
  const applyTweaks = useApplyTweaks();
  const { locale } = useI18n();
  const overlayId = useOverlayId('insight-detail-panel');

  // Esc closes — but only when this panel is the topmost overlay (overlayStack,
  // same contract as CommandModal) and never while the user is typing in a form
  // field (Esc there dismisses the field, not the panel with their unsaved edits).
  useEffect(() => {
    pushOverlay(overlayId);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopOverlay(overlayId)) return;
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
      popOverlay(overlayId);
    };
  }, [onClose, overlayId]);

  const manifest = detail.data?.insight ?? null;
  const cache = detail.data?.cache ?? null;
  const series = cache?.series ?? [];
  const meaning = (detail.data?.meaning ?? '').replace(/^##\s*Meaning\s*/i, '').trim();
  const resolvedTweaks = detail.data?.resolvedTweaks ?? {};
  // Newest first — the reader wants "what happened last", not the epoch.
  // Array.isArray: the cache file is user-editable JSON; a malformed history
  // must not crash the whole panel render.
  const history = Array.isArray(cache?.history) ? [...cache.history].reverse() : [];

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

  const handleRefresh = () => runSync('refreshed.', 'sync failed');

  /** Same rule as the card and the funnel views (#235): the data follows the
   *  control, so a saved tweak re-fetches rather than leaving the panel on the
   *  pre-tweak window — and the toast names which of the two actually happened. */
  const applyAndReport = (values: Record<string, string>, okMessage: string, failPrefix: string) => {
    applyTweaks.mutate({ slug: summary.slug, tweaks: values }, {
      onSuccess: ({ synced, error }) => onToast(
        synced ? `${summary.title}: ${okMessage}` : `${summary.title}: ${failPrefix} — ${error}`,
      ),
      onError: (err) => onToast(`${summary.title}: could not save tweaks — ${(err as Error).message}`),
    });
  };

  const handleSaveTweaks = (values: Record<string, string>) =>
    applyAndReport(values, 'tweaks saved, refreshed.', 'tweaks saved, but the refresh failed');

  /** Range changes re-fetch too — same chain, and the panel's chart is the surface
   *  most likely to be read as "the current window" (#235). */
  const handleApplyRange = (values: Record<string, string>, label: string) =>
    applyAndReport(values, `${label} applied.`, `${label} saved, but the refresh failed`);

  // The window keys belong to the RangeControl; the editor keeps the rest.
  const editableTweaks = nonWindowTweaks(summary.tweaks);

  // The panel is the same shell for every render: the body comes from the
  // registry (its own detail variant when it has one, else the card's).
  const entry = chartEntry(summary.render);
  const DetailBody = detailBodyFor(summary.render);

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
          {entry.supportsWindow && (
            <div className="idp-rangerow">
              <RangeControl
                tweaks={summary.tweaks}
                disabled={applyTweaks.isPending || sync.isPending}
                onApply={handleApplyRange}
              />
            </div>
          )}
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
                {/* `full`: the panel is the whole story — the registry body
                    draws its large variant (no capped legends, taller canvas). */}
                <div className="idp-chart">
                  <DetailBody
                    summary={summary}
                    cache={cache}
                    series={series}
                    full
                    emptyHint={entry.emptyHint}
                  />
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
                        {tweakEntries.map(([k, v]) => `${humanizeTweakKey(k, locale)}: ${humanizeTweakValue(v, locale)}`).join(' · ')}
                      </span>
                    </div>
                  )}
                </div>

                {editableTweaks.length > 0 && (
                  <div className="idp-tweaks">
                    <div className="idp-section-label">Edit tweaks</div>
                    <TweakEditor tweaks={editableTweaks} saving={applyTweaks.isPending} onSave={handleSaveTweaks} />
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
