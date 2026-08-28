import { useState } from 'react';
import type { AutomationSummary, PendingQuestionSummary, RunStatus } from '../../hooks/useAutomations';
import { useAnswerQuestion, useRunAutomation, useSetAutomationEnabled } from '../../hooks/useAutomations';
import { useVault } from '../../context/VaultContext';
import { openAutomationQuestionChat } from '../../lib/automationRunChat';
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
 *
 * The pending-question badge that used to live here is GONE — not dropped, but
 * promoted: a waiting verdict is now the `AskBlock` below, which says what is
 * being asked instead of only that something is. A badge repeating the block's
 * own headline two lines above it is noise.
 */
function Badges({ summary }: { summary: AutomationSummary }) {
  const badges: React.ReactNode[] = [];

  if (!summary.approved) {
    if (summary.approvalReason === 'never-approved') {
      badges.push(
        <span key="blocked" className="auto-badge auto-badge--blocked" title={`dreamcontext automations approve ${summary.slug}`}>
          blocked — needs approval
        </span>,
      );
    } else if (!summary.pendingQuestion) {
      // `manifest-changed` / `payload-format-changed` (D-A path 2): this is NOT a
      // hard block — the next run spawns a restricted, question-only session that
      // asks about the diff and resumes on "yes". Badging it identically to
      // `never-approved` would claim nothing can happen here until a human clicks
      // Approve, which is no longer true. Accent, not warning — it isn't broken,
      // it's about to ask. Suppressed once it HAS asked: the `AskBlock` below is
      // then carrying the same news, with the actual question in it.
      badges.push(
        <span key="pending-approval" className="auto-badge auto-badge--review" title="The next run will ask about this change in its own chat session before doing anything else">
          manifest changed — will ask
        </span>,
      );
    }
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

/** The word for `cache.status` a human reads next to the fire time (D5: "last
 *  status" must be unmistakable at a glance — an 'ok' run previously left NO
 *  trace on the card at all, since only failure/blocked/orphaned get a badge). */
function statusWord(status: RunStatus | null): string {
  if (!status) return 'no runs yet';
  switch (status) {
    case 'ok': return 'ok';
    case 'failed': return 'failed';
    case 'timeout': return 'timed out';
    case 'blocked': return 'blocked';
    case 'deferred': return 'deferred';
    case 'orphaned': return 'orphaned';
    case 'awaiting-review': return 'awaiting verdict';
    default: return status;
  }
}

/**
 * The open question, ON THE CARD, in the run's own words.
 *
 * WHY THIS IS A BLOCK AND NOT A BADGE. It used to be the string "waiting for
 * your verdict" and nothing else, because the list endpoint sent only a
 * question ID. The words being asked lived behind `/automations/questions`,
 * which only `ChatPane` calls — i.e. only once the run's chat is already open.
 * So the card could tell you a verdict was owed but not what it was owed on,
 * and the only screen that could was on the far side of the thing you were
 * trying to reach. A human looking at a board of automations could not tell
 * whether the thing waiting on them was "publish this?" or "which of these
 * three?" without opening a chat per card.
 *
 * The two kinds are answered in DIFFERENT PLACES, and that is not a styling
 * choice:
 *
 *  - `'flow-hitl'` — an approved run stopped mid-flight to ask about its own
 *    work. Its answer resumes that conversation, and the answer card lives in
 *    the chat next to the context that produced the question, so this block
 *    sends you there rather than duplicating the input here. Answering a
 *    mid-flight question from a board, with none of the run's reasoning on
 *    screen, is the reflexive approval the gate exists to prevent.
 *  - `'approval'` — the sha256 tripwire asking whether to trust a changed
 *    manifest. `hitl.ts` forces its `sessionId` to null (that session ran
 *    read-only and is discarded either way), so there IS no chat to send
 *    anyone to. Answered inline, with an explicit decision and never free
 *    text: a human typing "no, this looks wrong" must not read as consent.
 */
function AskBlock({
  summary, question, onToast,
}: {
  summary: AutomationSummary;
  question: PendingQuestionSummary;
  onToast: (msg: string) => void;
}) {
  const { bus } = useVault();
  const answerQuestion = useAnswerQuestion();
  /** What the human decided, kept for the receipt. Cleared on a failed send so
   *  the card reopens for another try rather than stranding them on a receipt
   *  that lied. Mirrors `AutomationHitlCard`'s `picked`. */
  const [decided, setDecided] = useState<string | null>(null);

  const decide = (decision: 'approve' | 'reject', label: string) => {
    if (answerQuestion.isPending || decided) return;
    setDecided(label);
    answerQuestion.mutate({ id: question.id, kind: 'approval', decision }, {
      onError: (err) => {
        setDecided(null);
        onToast(`${summary.title}: could not record that — ${(err as Error).message}`);
      },
    });
  };

  const openChat = () => {
    const accepted = openAutomationQuestionChat(bus, {
      slug: summary.slug,
      automationTitle: summary.title,
      question,
    });
    // The ACK is the whole reason this reports rather than assumes: a button
    // that visibly does nothing is exactly the failure being fixed here.
    if (!accepted) {
      onToast(
        `${summary.title}: could not open the run's chat — this needs the desktop app with the claude CLI, and Agents enabled in Settings.`,
      );
    }
  };

  return (
    // Propagation is stopped on the ACTIONS row, not on the whole block. The
    // block fills the middle of the card, and swallowing clicks across all of
    // it turned the card's largest region into a dead zone — clicking the
    // question text did nothing at all, where every other pixel of the card
    // opens the detail panel. Only the buttons need to not do both.
    <div className="auto-ask">
      <div className="auto-ask-head">
        <span className="auto-ask-glyph" aria-hidden>{question.kind === 'approval' ? '🔐' : '❓'}</span>
        <span className="auto-ask-label">
          {question.kind === 'approval' ? 'Approval needed' : 'Waiting for your verdict'}
        </span>
        <span className="auto-ask-when">{fmtWhen(question.createdAt)}</span>
      </div>

      <p className="auto-ask-question">{question.question}</p>

      {decided ? (
        <div className="auto-ask-receipt"><span aria-hidden>✓</span> {decided}</div>
      ) : question.kind === 'approval' ? (
        <div className="auto-ask-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="auto-ask-btn"
            disabled={answerQuestion.isPending}
            onClick={() => decide('reject', 'Rejected')}
          >
            Reject
          </button>
          <button
            type="button"
            className="auto-ask-btn auto-ask-btn--primary"
            disabled={answerQuestion.isPending}
            onClick={() => decide('approve', 'Approved')}
          >
            Approve
          </button>
        </div>
      ) : question.sessionId ? (
        <div className="auto-ask-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="auto-ask-btn auto-ask-btn--primary" onClick={openChat}>
            Answer in chat <span aria-hidden>→</span>
          </button>
        </div>
      ) : (
        // A `flow-hitl` question whose session this machine never bound — the
        // route withholds the uuid (see its `summarizeQuestion`). That means the
        // question travelled here inside a synced brain: it is a teammate's
        // automation asking a teammate's machine. Showing it is right; offering a
        // button that resumes a conversation this machine never had is not, and
        // saying WHOSE it is beats a button that fails with a wrong reason.
        <div className="auto-ask-foreign">
          This question belongs to a run on another machine — answer it there, or from the
          Telegram chat that automation is connected to.
        </div>
      )}
    </div>
  );
}

export function AutomationCard({
  summary,
  onOpen,
  onOpenRun,
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
  /** D5: one click on THIS automation's last run opens its session as a chat
   *  tab, without the intermediate stop at the history list. The card itself
   *  doesn't know the run's `sessionId` (the list endpoint deliberately trims
   *  history off `AutomationCacheSummary` — see `useAutomations.ts`), so it
   *  can't dispatch `openAutomationRunChat` directly; it asks the board to
   *  open the detail panel already mid-transition into that run's hand-off,
   *  which fetches the one thing needed and reuses the panel's own refusal
   *  handling (no session, no transcript) rather than a second copy of it
   *  living here.
   *
   *  NOT the path a waiting verdict takes: see `AskBlock`, which opens the
   *  ASKING conversation from the question record. The newest run of an
   *  automation holding a question is a session-less refusal by construction. */
  onOpenRun: (slug: string) => void;
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

  // D-A: only `never-approved` (path 3) is a HARD block — a synced manifest with
  // no session and no prior grant, refused short-circuit, no spawn ever. The
  // other two reasons (`manifest-changed`, `payload-format-changed`, path 2) are
  // NOT blocks: the run spawns in a restricted, question-only envelope that asks
  // about the diff in its own chat and resumes on "yes" — that ask IS how this
  // gets resolved, so "Run now" must stay clickable for it, or the automation can
  // never reach the very session that would clear it.
  const hardBlocked = !summary.approved && summary.approvalReason === 'never-approved';
  // Running a blocked/orphaned automation is guaranteed to be refused server-
  // side (approval + the orphan guard are enforced inside the runner) — disable
  // the button rather than let the user click into a predictable no-op. Only
  // ONE run-now job exists per project (any slug), so another automation mid-run
  // also disables this card.
  const runDisabled = runNow.isPending || thisRunning || otherRunning || hardBlocked || summary.cache?.status === 'orphaned';
  const runTitle = thisRunning
    ? 'Running…'
    : otherRunning
      ? `Another automation (${runningSlug}) is running — only one runs at a time`
      : hardBlocked
        ? 'Needs approval first'
        : summary.cache?.status === 'orphaned'
          ? 'An orphaned run must be killed first (CLI)'
          : 'Run now';

  /**
   * What this card should look like from across the grid, in one word.
   *
   * The card carried NO outer signal before — a healthy automation, one holding
   * an unanswered question, and one whose last run crashed were the same
   * rectangle with different small print inside. On a board of a dozen, the one
   * thing a reader wants without reading is "which of these needs me", and
   * `asking` is the only state where the answer is yes.
   *
   * Order is deliberate: a pending question OUTRANKS a failure, because the
   * question is the one a human can act on right now. `blocked` is third — it
   * needs a human too, but on a different screen (the detail panel's review).
   */
  const state = summary.pendingQuestion
    ? 'asking'
    : summary.cache?.status === 'failed' || summary.cache?.status === 'timeout' || summary.cache?.status === 'orphaned'
      ? 'bad'
      : hardBlocked
        ? 'blocked'
        : 'idle';

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

  const handleOpenRun = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenRun(summary.slug);
  };

  return (
    <div
      className={`auto-card auto-card--clickable${dragging ? ' auto-card--dragging' : ''}${dropTarget ? ' auto-card--drop-target' : ''}`}
      data-state={state}
      onClick={() => onOpen(summary.slug)}
      role="button"
      tabIndex={0}
      /* `e.target !== e.currentTarget` is the whole guard, and it is deliberately
         NOT a `stopPropagation` on each nested control. A native <button> fires
         TWO bubbling events on Enter: the synthesized click (which the wrappers
         below do stop) and a keydown (which they do not) — so a keyboard user
         pressing Enter on Approve, Reject, "Answer in chat", the enable toggle
         or "Run now" both performed the action AND opened this modal. Filtering
         on the event's origin fixes every one of them at once, including the
         toggle/Run-now pair that had the bug before this change, and cannot be
         forgotten by whoever adds the next button. Keyboard events only ever
         originate on the focused element, so the card's own Enter still works. */
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(summary.slug); }}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title="Open details, review & run history"
    >
      {/* Title gets its own row and up to two lines. It shared a row with the
          badges before, which meant a card with two badges clipped its own name
          to a few characters — the one string on the card that identifies it. */}
      <div className="auto-card-title" title={summary.title}>{summary.title}</div>

      <div className="auto-card-meta">
        <span className="auto-card-schedule">{summary.scheduleLabel}</span>
        {summary.model && <span className="auto-card-model">{summary.model}</span>}
      </div>

      <div className="auto-card-badges" onClick={(e) => e.stopPropagation()}>
        <Badges summary={summary} />
      </div>

      {summary.pendingQuestion && (
        <AskBlock summary={summary} question={summary.pendingQuestion} onToast={onToast} />
      )}

      <div className="auto-card-foot">
        {/* D5: last fire time + last status, unmistakable even on a healthy run —
            `statusWord('ok')` is the one case that previously left no trace on the
            card at all (only failure/blocked/orphaned earned a badge above). The
            dot mirrors `AutomationDetailPanel.css`'s `.adp-history-dot--*` palette
            so a card and its own detail history read as the same status language. */}
        <div className="auto-card-status-row">
          <span className={`auto-card-status-dot auto-card-status-dot--${summary.cache?.status ?? 'none'}`} aria-hidden="true" />
          <span className="auto-card-status-word">{statusWord(summary.cache?.status ?? null)}</span>
          <span className="auto-card-status-sep">·</span>
          <span className="auto-card-lastfire">{fmtWhen(summary.cache?.lastFireAt ?? summary.cache?.lastRunAt ?? null)}</span>
        </div>

        <div className="auto-card-actions" onClick={(e) => e.stopPropagation()}>
          {/* Only offered once something has actually fired — mirrors
              `HistoryRow`'s own guard in the detail panel (a session id is
              necessary but not sufficient; `RunHandoff` still checks the
              transcript once this opens it). Hidden while a question is open:
              the newest run of a waiting automation is a session-less refusal,
              so this button could only refuse — `AskBlock` above owns the
              route to that conversation. */}
          {summary.cache?.lastRunAt && !summary.pendingQuestion && (
            <button
              type="button"
              className="auto-card-chat-btn"
              onClick={handleOpenRun}
              title="Reopen the last run's conversation as a chat"
            >
              open chat
            </button>
          )}
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
