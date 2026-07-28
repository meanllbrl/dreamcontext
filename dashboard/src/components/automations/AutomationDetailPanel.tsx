import { useEffect, useState } from 'react';
import type { AutomationPattern, AutomationRunEvent, AutomationSummary } from '../../hooks/useAutomations';
import {
  useApproveAutomation,
  useAutomation,
  useAutomationSession,
  useRunAutomation,
} from '../../hooks/useAutomations';
import { pushOverlay, popOverlay, isTopOverlay } from '../../lib/overlayStack';
import './AutomationDetailPanel.css';

/**
 * AutomationDetailPanel — the modal that opens when you click an automation
 * card. Three things live here that don't fit on a dense card: the full
 * full-field approval review (mirrors the CLI's `approve` — see its comment:
 * the registry stores only a sha256, never prior field values, so this is a
 * complete review every time, not an old-vs-new diff), the orphaned-run
 * warning with the exact `kill` command, and the bounded run history.
 */

interface Props {
  summary: AutomationSummary;
  runningSlug: string | null;
  onClose: () => void;
  onToast: (msg: string) => void;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function HistoryRow({
  event,
  runNumber,
  onOpenSession,
}: {
  event: AutomationRunEvent;
  runNumber: number;
  onOpenSession: (runNumber: number) => void;
}) {
  return (
    <div className="adp-history-row">
      <span className={`adp-history-dot adp-history-dot--${event.status}`} />
      <span className="adp-history-when">{fmtWhen(event.firedAt)}</span>
      <span className="adp-history-status">{event.status}</span>
      <span className="adp-history-duration">{fmtDuration(event.durationMs)}</span>
      {event.costUsd !== null && <span className="adp-history-cost">${event.costUsd.toFixed(3)}</span>}
      {event.permissionDenials > 0 && (
        <span className="adp-history-denials" title="Permission denials during this run">
          ⚠ {event.permissionDenials}
        </span>
      )}
      {/* Only offered when a session was actually recorded — a blocked or
          deferred run never reached one, and a button that opens an empty
          drawer teaches the user to stop pressing it. */}
      {event.sessionId && (
        <button
          className="adp-history-session"
          onClick={() => onOpenSession(runNumber)}
          title="What this run's claude session actually did"
        >
          session
        </button>
      )}
      {event.error && (
        <span className="adp-history-error" title={event.error}>{event.error}</span>
      )}
    </div>
  );
}

/** What the automation has learned, newest lesson first. Shown read-only: the
 *  pattern is written by the runs themselves (`automations learn`), and a
 *  hand-edit here would silently diverge from what the next run reads. */
function PatternBlock({ pattern }: { pattern: AutomationPattern }) {
  const empty = !pattern.playbook && pattern.lessons.length === 0;
  if (empty) {
    return (
      <div className="adp-pattern-empty">
        Nothing learned yet. After a run finds something worth remembering, it records a line here
        and reads it back on every later run.
      </div>
    );
  }
  return (
    <div className="adp-pattern">
      {pattern.playbook && <pre className="adp-review-block adp-review-block--static">{pattern.playbook}</pre>}
      {pattern.lessons.length > 0 && (
        <ul className="adp-lessons">
          {pattern.lessons.map((l, i) => (
            <li key={`${l.date}-${i}`} className="adp-lesson">
              <span className="adp-lesson-date">{l.date}</span>
              <span className="adp-lesson-text">{l.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The run drill-in: the turns, tool calls and failures of one headless
 *  session. Renders as a flat list rather than a chat replay on purpose — the
 *  question this answers is "what did it do", and a scannable sequence answers
 *  it faster than styled bubbles. */
function SessionView({ slug, runNumber, onClose }: { slug: string; runNumber: number; onClose: () => void }) {
  const { data: session, isLoading, isError } = useAutomationSession(slug, runNumber);

  return (
    <div className="adp-session">
      <div className="adp-session-head">
        <span className="adp-section-label">Run #{runNumber} session</span>
        <span className="adp-spacer" />
        <span className="adp-close adp-close--sm" onClick={onClose} title="Back to history">✕</span>
      </div>
      {isLoading && <div className="adp-loading">Loading…</div>}
      {isError && <div className="adp-session-empty">Could not read this run's session.</div>}
      {session && (
        <>
          <div className="adp-session-meta">
            {session.toolCalls} tool calls
            {session.toolErrors > 0 && <span className="adp-session-failed"> · {session.toolErrors} failed</span>}
            {session.numTurns !== null && <> · {session.numTurns} turns</>}
            {session.costUsd !== null && <> · ${session.costUsd.toFixed(4)}</>}
          </div>
          {!session.transcriptPath && (
            <div className="adp-session-empty">
              No transcript on disk. Claude writes one only once a session has produced a turn, and
              nothing here owns that file's lifetime.
            </div>
          )}
          {session.items.length > 0 && (
            <div className="adp-session-items">
              {session.items.map((item, i) => (
                <div key={i} className={`adp-session-item adp-session-item--${item.kind}`}>
                  {item.kind === 'tool' ? (
                    <>
                      <span className={`adp-session-tool${item.status === 'error' ? ' adp-session-tool--error' : ''}`}>
                        {item.name}
                      </span>
                      <span className="adp-session-tool-arg">{describeToolInput(item.input)}</span>
                    </>
                  ) : (
                    <span className="adp-session-text">{item.text}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The one argument worth showing next to a tool name. Mirrors the CLI's
 *  `toolCallLabel` — same handful of argument names, same degrade to nothing
 *  rather than dumping raw JSON at the reader. */
function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) {
      const flat = v.replace(/\s+/g, ' ').trim();
      return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
    }
  }
  return '';
}

export function AutomationDetailPanel({ summary, runningSlug, onClose, onToast }: Props) {
  const detail = useAutomation(summary.slug);
  const runNow = useRunAutomation();
  const approve = useApproveAutomation();
  /** Which run's session is open, 1-based newest-first. Null = the history list. */
  const [openSession, setOpenSession] = useState<number | null>(null);

  useEffect(() => {
    const id = 'automation-detail-panel';
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

  const automation = detail.data?.automation ?? null;
  const approved = detail.data?.approved ?? summary.approved;
  const approvalReason = detail.data?.approvalReason ?? summary.approvalReason;
  const cache = detail.data?.cache ?? null;
  // Already newest-first as stored: `recordRun` PREPENDS each event. The
  // `.reverse()` that used to be here was inverting it, so the panel showed the
  // oldest run at the top while its own comment claimed newest-first. The cache
  // is brain-synced (user/agent-editable JSON), so a malformed history must
  // degrade to empty rather than crash the panel.
  const history = Array.isArray(cache?.history) ? cache.history : [];

  const thisRunning = runningSlug === summary.slug;
  const otherRunning = runningSlug !== null && !thisRunning;
  const runDisabled = runNow.isPending || thisRunning || otherRunning || !approved || cache?.status === 'orphaned';

  const handleRun = () => {
    runNow.mutate(summary.slug, {
      onSuccess: (data) => {
        if (!data.started) onToast(`Another run (${data.job.slug}) is already in progress.`);
        else onToast('Run started.');
      },
      onError: (err) => onToast(`Could not start — ${(err as Error).message}`),
    });
  };

  const handleApprove = () => {
    approve.mutate(summary.slug, {
      onSuccess: () => onToast(`"${summary.slug}" approved — it will run on this machine.`),
      onError: (err) => onToast(`Approval failed — ${(err as Error).message}`),
    });
  };

  const reasonCopy: Record<NonNullable<typeof approvalReason>, string> = {
    'never-approved': 'This automation has never been approved on this machine. Nothing will run until it is reviewed and approved.',
    'manifest-changed': 'This automation was edited since it was last approved — review every field below before approving.',
    'payload-format-changed': 'The approval format itself changed — this is not a normal manifest edit. Re-review in full.',
  };

  return (
    <>
      <div className="adp-overlay" onClick={onClose} />
      <div className="adp-panel" role="dialog" aria-modal="true" aria-label={summary.title}>
        <div className="adp-head">
          <div className="adp-head-row">
            {approved ? (
              <span className="auto-badge auto-badge--approved">approved</span>
            ) : (
              <span className="auto-badge auto-badge--blocked">blocked — needs approval</span>
            )}
            {cache?.status === 'orphaned' && <span className="auto-badge auto-badge--orphaned">orphaned run</span>}
            {!summary.enabled && <span className="auto-badge auto-badge--muted">disabled</span>}
            <span className="adp-spacer" />
            <button className="adp-run" onClick={handleRun} disabled={runDisabled} title={thisRunning ? 'Running…' : 'Run now'}>
              {thisRunning || runNow.isPending ? 'Running…' : '▶ Run now'}
            </button>
            <span className="adp-close" onClick={onClose} title="Close (Esc)">✕</span>
          </div>
          <div className="adp-title">{summary.title}</div>
          <div className="adp-slug">{summary.slug} · {summary.scheduleLabel}</div>
        </div>

        <div className="adp-body">
          {cache?.status === 'orphaned' && (
            <div className="adp-danger-banner">
              <span className="adp-danger-glyph">⚠</span>
              <div>
                <div className="adp-danger-title">A previous run's process group may still be alive</div>
                <div className="adp-danger-sub">
                  The tick that started it died before cleanup — this automation refuses to run again until the
                  orphan is cleared. There is no automatic reaper. From a terminal:
                </div>
                <code className="adp-danger-cmd">dreamcontext automations kill {summary.slug}</code>
              </div>
            </div>
          )}

          {!approved && approvalReason && (
            <div className="adp-warn-banner">
              <span className="adp-warn-glyph">⚠</span>
              <div className="adp-warn-sub">{reasonCopy[approvalReason]}</div>
            </div>
          )}

          {detail.isLoading ? (
            <div className="adp-loading">Loading…</div>
          ) : (
            <div className="adp-columns">
              <div className="adp-col-main">
                {!approved && automation && (
                  <>
                    <div className="adp-section-label">Review before approving</div>
                    <div className="adp-review">
                      <div className="adp-review-row">
                        <span className="adp-review-label">model</span>
                        <span className="adp-review-value">{automation.model ?? <em>(default)</em>}</span>
                      </div>
                      <div className="adp-review-row">
                        <span className="adp-review-label">timeoutMinutes</span>
                        <span className="adp-review-value">{automation.timeoutMinutes}</span>
                      </div>
                      <div className="adp-review-row">
                        <span className="adp-review-label">outputDir</span>
                        <span className="adp-review-value">{automation.outputDir ?? <em>(default)</em>}</span>
                      </div>
                      {/* Hashed, and the one on this list whose meaning is not
                          self-evident from its name — so it is spelled out
                          rather than printed as a bare boolean. */}
                      <div className="adp-review-row">
                        <span className="adp-review-label">learning</span>
                        <span className="adp-review-value">
                          {automation.learning ? (
                            <>on — every run reads the pattern below and may add to it</>
                          ) : (
                            <em>off</em>
                          )}
                        </span>
                      </div>
                      {/* The pattern belongs IN the review, not after it. This
                          is the moment a human decides whether to admit a
                          self-written notes file into a bypassPermissions run;
                          approving that blind is the one thing this screen
                          exists to prevent. It is shown with its own caveat
                          because, unlike everything else here, it is NOT frozen
                          by the approval. */}
                      {automation.learning && (
                        <div className="adp-review-row adp-review-row--block">
                          <span className="adp-review-label">pattern</span>
                          <div className="adp-review-pattern">
                            <div className="adp-review-pattern-note">
                              Read by every run. NOT covered by the approval hash — it changes as runs
                              record lessons, so what you see here is today's, not a frozen copy.
                            </div>
                            <PatternBlock pattern={automation.pattern} />
                          </div>
                        </div>
                      )}
                      <div className="adp-review-row adp-review-row--block">
                        <span className="adp-review-label">prompt</span>
                        <pre className="adp-review-block">{automation.prompt}</pre>
                      </div>
                      <div className="adp-review-row adp-review-row--block">
                        <span className="adp-review-label">outputInstructions</span>
                        <pre className="adp-review-block">{automation.outputInstructions || <em>(none)</em>}</pre>
                      </div>
                    </div>
                    <button className="adp-approve-btn" onClick={handleApprove} disabled={approve.isPending}>
                      {approve.isPending ? 'Approving…' : `Approve — this will run on this machine`}
                    </button>
                  </>
                )}

                {approved && automation && (
                  <>
                    <div className="adp-section-label">Prompt</div>
                    <pre className="adp-review-block adp-review-block--static">{automation.prompt}</pre>
                    {automation.outputInstructions && (
                      <>
                        <div className="adp-section-label">Output instructions</div>
                        <pre className="adp-review-block adp-review-block--static">{automation.outputInstructions}</pre>
                      </>
                    )}
                    {automation.learning && (
                      <>
                        <div className="adp-section-label">
                          Pattern
                          {automation.pattern.lessons.length > 0 && (
                            <span className="adp-history-count">{automation.pattern.lessons.length}</span>
                          )}
                        </div>
                        <PatternBlock pattern={automation.pattern} />
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="adp-col-rail">
                <div className="adp-section-label">Details</div>
                <div className="adp-details">
                  <div className="adp-detail-row">
                    <span className="adp-detail-label">Model</span>
                    <span className="adp-detail-value">{automation?.model ?? 'default'}</span>
                  </div>
                  {/* Effort is approval-hashed just like Model, so it MUST be visible
                      here — this table IS the full-field review the human approves
                      from, and a hashed field they cannot see changes the hash
                      invisibly. Same `?? 'default'` shape as Model: null means
                      `claude` picks, not "unset". */}
                  <div className="adp-detail-row">
                    <span className="adp-detail-label">Effort</span>
                    <span className="adp-detail-value">{automation?.effort ?? 'default'}</span>
                  </div>
                  <div className="adp-detail-row">
                    <span className="adp-detail-label">Timeout</span>
                    <span className="adp-detail-value">{summary.timeoutMinutes}m</span>
                  </div>
                  <div className="adp-detail-row">
                    <span className="adp-detail-label">Catch-up</span>
                    <span className="adp-detail-value">{summary.catchupHours}h</span>
                  </div>
                  <div className="adp-detail-row">
                    <span className="adp-detail-label">Output dir</span>
                    <span className="adp-detail-value">{automation?.outputDir ?? `automations/output/${summary.slug}/`}</span>
                  </div>
                  {cache?.lastRunAt && (
                    <div className="adp-detail-row">
                      <span className="adp-detail-label">Last run</span>
                      <span className="adp-detail-value">{fmtWhen(cache.lastRunAt)}</span>
                    </div>
                  )}
                  {cache?.outputPath && (
                    <div className="adp-detail-row">
                      <span className="adp-detail-label">Last output</span>
                      <span className="adp-detail-value adp-detail-value--mono">{cache.outputPath}</span>
                    </div>
                  )}
                </div>

                {openSession !== null ? (
                  <SessionView slug={summary.slug} runNumber={openSession} onClose={() => setOpenSession(null)} />
                ) : (
                  <>
                    <div className="adp-section-label">
                      Run history
                      {history.length > 0 && <span className="adp-history-count">{history.length}</span>}
                    </div>
                    {history.length === 0 ? (
                      <div className="adp-history-empty">No runs recorded yet.</div>
                    ) : (
                      <div className="adp-history">
                        {history.map((event, i) => (
                          // `i + 1` IS the run number: `history` was reversed to
                          // newest-first above, which is the same 1-based
                          // newest-first index `resolveRunSession` takes.
                          <HistoryRow
                            key={`${event.firedAt}-${i}`}
                            event={event}
                            runNumber={i + 1}
                            onOpenSession={setOpenSession}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
