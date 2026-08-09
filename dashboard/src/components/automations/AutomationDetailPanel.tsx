import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutomationPattern, AutomationRunEvent, AutomationSummary } from '../../hooks/useAutomations';
import {
  useApproveAutomation,
  useAutomation,
  useAutomationSession,
  useRunAutomation,
} from '../../hooks/useAutomations';
import { requestAutomationRunChat, runChatUnavailableReason } from '../../lib/automationRunChat';
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
      {/* Only offered when a session was actually recorded — a blocked, deferred or
          orphaned run never reached one, and a button that opens an empty drawer teaches
          the user to stop pressing it. A recorded session id is necessary but not
          sufficient: whether a transcript actually landed is checked in `RunHandoff`,
          which is the only place that knows. */}
      {event.sessionId && (
        <button
          className="adp-history-session"
          onClick={() => onOpenSession(runNumber)}
          title="Reopen this run's conversation as a chat"
        >
          open chat
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

/**
 * The run hand-off: pressing `session` on a run opens that run's conversation as a real
 * chat tab, and this is the two-second window in between.
 *
 * It used to be a flat, read-only list of turns and tool calls rendered right here, on the
 * reasoning that the question was "what did it do" and a scannable sequence answers that
 * faster than styled bubbles. That reasoning was answering too small a question. The run
 * IS a claude conversation, on disk, resumable — so the useful thing is not to describe it
 * but to REOPEN it, with a composer, where the agent that wrote the report can be asked
 * why. The drill-in could only ever be read; a chat can be continued.
 *
 * What this component still owns is the one check that must happen BEFORE any of that:
 * whether there is a transcript to resume at all. `--resume` against a missing one does not
 * fail loudly — the chat route falls back to `--session-id` and fresh-pins a new, empty
 * conversation under the same uuid — so a run whose transcript never landed (or was pruned)
 * must be refused here, with the reason, rather than opened into a blank chat.
 */
function RunHandoff({
  slug, automationTitle, runNumber, durationMs, pendingReviewCardId, onBack, onOpened,
}: {
  slug: string;
  automationTitle: string;
  runNumber: number;
  /** Open card on this automation, if any — the hand-off refuses while one is
   *  pending, because the chat tab talks to the session directly and would let
   *  it act without the card ever being resolved. */
  pendingReviewCardId: string | null;
  /** From the history row. The session response has no duration of its own — it reports
   *  what the CONVERSATION was, and how long the run took is the runner's measurement. */
  durationMs: number | null;
  onBack: () => void;
  onOpened: () => void;
}) {
  const { data: session, isLoading, isError } = useAutomationSession(slug, runNumber);
  /** One dispatch per hand-off. The query re-delivers its (cached) data on every render of
   *  this panel, and a second dispatch would ask the surface to reopen a tab it just
   *  opened — harmless there (it focuses), but it would also re-close this panel. */
  const sentRef = useRef(false);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    if (!session || sentRef.current) return;
    const reason = runChatUnavailableReason(session, pendingReviewCardId);
    if (reason) { setRefused(reason); return; }
    sentRef.current = true;
    const accepted = requestAutomationRunChat({
      slug,
      automationTitle,
      runNumber,
      sessionId: session.sessionId!,
      firedAt: session.firedAt,
      status: session.status,
      costUsd: session.costUsd,
      numTurns: session.numTurns,
      durationMs,
      outputPath: session.outputPath,
    });
    if (!accepted) {
      // No surface took it: not the desktop app, the CLI is missing, or Agents is switched
      // off in Settings. Say so — the alternative is a button that visibly does nothing.
      sentRef.current = false;
      setRefused('The Agents surface could not take this — it needs the desktop app with the claude CLI, and Agents enabled in Settings.');
      return;
    }
    // The chat overlay is now the screen the user asked for; leaving this modal stacked
    // underneath it would mean closing two things to get back to the board.
    onOpened();
  }, [session, slug, automationTitle, runNumber, durationMs, pendingReviewCardId, onOpened]);

  return (
    <div className="adp-session">
      <div className="adp-session-head">
        <span className="adp-section-label">Run #{runNumber}</span>
        <span className="adp-spacer" />
        <span className="adp-close adp-close--sm" onClick={onBack} title="Back to history">✕</span>
      </div>
      {isLoading && <div className="adp-loading">Opening this run’s conversation…</div>}
      {isError && <div className="adp-session-empty">Could not read this run’s session.</div>}
      {refused && <div className="adp-session-empty">{refused}</div>}
      {session && !refused && !isLoading && (
        <div className="adp-session-meta">
          {session.toolCalls} tool calls
          {session.numTurns !== null && <> · {session.numTurns} turns</>}
          {session.costUsd !== null && <> · ${session.costUsd.toFixed(4)}</>}
        </div>
      )}
    </div>
  );
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

  /** The run's chat tab is open — dismiss this modal so the conversation is the screen.
   *  Stable identity: `RunHandoff` dispatches from an effect that depends on it, and a new
   *  closure per render would re-run that effect on every parent re-render. */
  const handleRunOpened = useCallback(() => {
    setOpenSession(null);
    onClose();
  }, [onClose]);

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
                      {/* Hashed, and spelled out for the same reason as
                          `learning`: "review: off" is a phrase whose weight is
                          invisible unless it is written out. The `off` case is
                          the one that must read loudest — on a manifest that
                          arrived over brain sync, it is a human gate someone
                          else removed. */}
                      <div className="adp-review-row">
                        <span className="adp-review-label">review</span>
                        <span className="adp-review-value">
                          {automation.review === 'off' ? (
                            <em>off — this automation's work takes effect with no human verdict</em>
                          ) : automation.review === 'output' ? (
                            <>output — every run's document waits for your verdict before it lands</>
                          ) : (
                            <>agent — the run decides when to stop and ask you</>
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
                  <RunHandoff
                    slug={summary.slug}
                    automationTitle={automation?.title || summary.title}
                    runNumber={openSession}
                    // `openSession` IS the 1-based newest-first index into `history` — the
                    // same numbering `resolveRunSession` takes, so the row and the run
                    // cannot drift apart.
                    durationMs={history[openSession - 1]?.durationMs ?? null}
                    pendingReviewCardId={summary.pendingReviewCardId}
                    onBack={() => setOpenSession(null)}
                    onOpened={handleRunOpened}
                  />
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
