import type { AutomationSummary } from '../../hooks/useAutomations';
import { useRunAutomation, useSetAutomationEnabled } from '../../hooks/useAutomations';
import './AutomationCard.css';

/**
 * Status badges — keyed off `status` fields ONLY, never `error != null`.
 * `RunEvent.error`/`AutomationCacheSummary.error` can be non-null on an
 * otherwise-successful ('ok') run (it carries the outputDir-degrade note), so
 * a badge that checked `error` would paint a false failure on a healthy run.
 *
 * "Needs approval" is additionally NOT keyed off `cache.status === 'blocked'`:
 * that field only reflects the last ATTEMPTED run and goes stale the moment a
 * human approves without a new tick having run yet (cache.status would still
 * read 'blocked' from the last attempt). `approved` is live-computed by
 * `checkApproval` on every request, so it is the authoritative signal.
 */
function Badges({ summary }: { summary: AutomationSummary }) {
  const badges: React.ReactNode[] = [];

  if (!summary.approved) {
    badges.push(
      <span key="blocked" className="auto-badge auto-badge--blocked" title={`dreamcontext automations approve ${summary.slug}`}>
        blocked — needs approval
      </span>,
    );
  }
  if (summary.cache?.status === 'orphaned') {
    badges.push(
      <span key="orphaned" className="auto-badge auto-badge--orphaned" title={`dreamcontext automations kill ${summary.slug}`}>
        orphaned run
      </span>,
    );
  }
  if (summary.cache?.status === 'failed' || summary.cache?.status === 'timeout') {
    badges.push(
      <span key="failure" className="auto-badge auto-badge--failure" title={summary.cache?.error ?? undefined}>
        {summary.cache.status === 'timeout' ? 'timed out' : 'failed'}
      </span>,
    );
  }
  if (!summary.enabled) {
    badges.push(<span key="disabled" className="auto-badge auto-badge--muted">disabled</span>);
  }
  return <>{badges}</>;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function AutomationCard({
  summary,
  onOpen,
  onToast,
  /** The slug of the one project-wide "run now" job while it's running, or
   *  null — the server allows exactly one at a time (any slug), so a DIFFERENT
   *  automation running must disable this card's button too, not just its own. */
  runningSlug,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  summary: AutomationSummary;
  onOpen: (slug: string) => void;
  onToast: (msg: string) => void;
  runningSlug: string | null;
  /** Dimmed "ghost" state while this card is the one being dragged. */
  dragging?: boolean;
  /** Highlighted while another card hovers here — drop takes this position. */
  dropTarget?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const runNow = useRunAutomation();
  const setEnabled = useSetAutomationEnabled();
  const thisRunning = runningSlug === summary.slug;
  const otherRunning = runningSlug !== null && !thisRunning;

  // Running a blocked/orphaned automation is guaranteed to be refused server-
  // side (approval + the orphan guard are enforced inside the runner) — disable
  // the button rather than let the user click into a predictable no-op. Only
  // ONE run-now job exists per project (any slug), so another automation mid-run
  // also disables this card.
  const runDisabled = runNow.isPending || thisRunning || otherRunning || !summary.approved || summary.cache?.status === 'orphaned';
  const runTitle = thisRunning
    ? 'Running…'
    : otherRunning
      ? `Another automation (${runningSlug}) is running — only one runs at a time`
      : !summary.approved
        ? 'Needs approval first'
        : summary.cache?.status === 'orphaned'
          ? 'An orphaned run must be killed first (CLI)'
          : 'Run now';

  /**
   * The manifest's own on/off switch (CLI `automations enable|disable`).
   * Deliberately NOT an approval-class action: `enabled` is not a hashed field,
   * so flipping it never re-blocks an approved automation — and turning one ON
   * still cannot make it run, because approval and the installed dispatcher are
   * both still in front of it.
   */
  const handleToggleEnabled = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !summary.enabled;
    setEnabled.mutate({ slug: summary.slug, enabled: next }, {
      onSuccess: () => onToast(`${summary.title}: ${next ? 'enabled' : 'disabled'}.`),
      onError: (err) => onToast(`${summary.title}: could not ${next ? 'enable' : 'disable'} — ${(err as Error).message}`),
    });
  };

  const handleRun = (e: React.MouseEvent) => {
    e.stopPropagation();
    runNow.mutate(summary.slug, {
      onSuccess: (data) => {
        if (!data.started) onToast(`${summary.title}: another run (${data.job.slug}) is already in progress.`);
        else onToast(`${summary.title}: run started.`);
      },
      onError: (err) => onToast(`${summary.title}: could not start — ${(err as Error).message}`),
    });
  };

  return (
    <div
      className={`auto-card auto-card--clickable${dragging ? ' auto-card--dragging' : ''}${dropTarget ? ' auto-card--drop-target' : ''}`}
      onClick={() => onOpen(summary.slug)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(summary.slug); }}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title="Open details, review & run history"
    >
      <div className="auto-card-header">
        <span className="auto-card-title">{summary.title}</span>
        <div className="auto-card-badges" onClick={(e) => e.stopPropagation()}>
          <Badges summary={summary} />
        </div>
      </div>

      <div className="auto-card-meta">
        <span className="auto-card-schedule">{summary.scheduleLabel}</span>
        {summary.model && <span className="auto-card-model">{summary.model}</span>}
      </div>

      <div className="auto-card-run-row">
        <span className="auto-card-lastrun">
          last run: {fmtWhen(summary.cache?.lastRunAt ?? null)}
        </span>
        <div className="auto-card-actions">
          <button
            className={`auto-card-toggle${summary.enabled ? ' auto-card-toggle--on' : ''}`}
            onClick={handleToggleEnabled}
            disabled={setEnabled.isPending}
            role="switch"
            aria-checked={summary.enabled}
            aria-label={`${summary.title} — scheduled`}
            title={summary.enabled
              ? 'Enabled — the scheduler will run this when it is due. Click to disable.'
              : 'Disabled — the scheduler skips this. Click to enable.'}
          >
            <span className="auto-card-toggle-track" aria-hidden="true"><span className="auto-card-toggle-knob" /></span>
            {summary.enabled ? 'on' : 'off'}
          </button>
          <button
            className="auto-card-run-btn"
            onClick={handleRun}
            disabled={runDisabled}
            title={runTitle}
          >
            {thisRunning || runNow.isPending ? 'Running…' : '▶ Run now'}
          </button>
        </div>
      </div>
    </div>
  );
}
