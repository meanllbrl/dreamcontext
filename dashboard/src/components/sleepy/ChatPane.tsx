import { Fragment, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { GoalLivePanel } from './GoalLivePanel';
import { CouncilLivePanel } from './CouncilLivePanel';
import { agentFileUrl } from '../../api/client';
import { useApi, useVault } from '../../context/VaultContext';
import type { ModelConfig } from '../../lib/agentComposer';
import type { ChatMode } from '../../lib/chatModes';
import {
  classifyReference, subAgentToolUseIds, isGuardedCommand, turnHasVisibleProgress,
  nextStickToBottom, nextRestoreTop, isAtBottom, wheelIntent, keyIntent, touchIntent,
  nextFirstShown, splitWindow, anchorHoldCorrection, WINDOW_REVEAL_PX, shouldAutoReveal, revealPath,
  remainingSettleMs, SCROLL_SETTLE_MS, segmentToolRuns, toolRunKeyItem, MIN_TOOL_RUN,
  countCards, headForCards, WINDOW_TAIL_CARDS, WINDOW_STEP_CARDS, WINDOW_MAX_ENTRIES,
  type SubAgentRun, type ScrollIntent, type RunSegment, type CardWindow,
} from './chat/chatEntities';
import { isDreamcontextCommand } from './chat/dreamCommand';
import { ItemView } from './chat/TranscriptItem';
import { ToolRunCard } from './chat/ToolRunCard';
import { SurveyCard } from './chat/SurveyCard';
import { PermissionCard } from './chat/PermissionCard';
import { PlanCard } from './chat/PlanCard';
import { BypassNoticeCard } from './chat/BypassNoticeCard';
import { SubAgentCard, SubAgentRail } from './chat/SubAgentCard';
import { BackgroundShellsTray } from './chat/BackgroundShellsTray';
import { QueuedMessages } from './chat/QueuedMessages';
import { PeerSessionHolder } from './chat/PeerSessionCard';
import { usePeerMentions } from '../../hooks/usePeerMentions';
import type { PeerMention } from '../../lib/agentComposer';
import { PinShelf } from './chat/PinShelf';
import { useShelf } from './chat/useShelf';
import { SlideOver } from './chat/SlideOver';
import { Lightbox } from './chat/Lightbox';
import { PdfViewer } from './chat/PdfViewer';
import { BoardEmbed, BoardFullscreen } from './chat/BoardEmbed';
import { AutomationRunHeader } from './chat/AutomationRunHeader';
import type { AutomationRunRef } from '../../lib/automationRunChat';
import {
  useAutomationQuestions, useAnswerQuestion,
  type AutomationQuestion, type AnswerQuestionInput,
} from '../../hooks/useAutomations';
import type { ChatAction } from './chat/chatActions';
import { openExternalUrl } from '../../lib/desktop';
import {
  BranchStartBanner, EmptyState, StreamErrorBanner, ReconnectingChip, SessionEndedBanner,
  SignInBanner, WorkingIndicator,
} from './chat/Banners';
import { Composer } from './chat/Composer';
import { readScratch, setQuote, subscribeScratch } from './chat/composerScratch';
import { shouldInterruptChat } from './chat/interruptKey';
import './chat/cards.css';
import './chat/overlays.css';
import type {
  ChatSession, ChatItem, ChatUserItem, ChatToolItem, PendingPermission, PendingQuestion, PendingPlan,
} from './chatSession';
import './ChatPane.css';

/**
 * The native conversation view for a Chat session (beta) — orchestrator over the
 * redesigned `chat/` component tree (task T7, plan rev.3). Portaled into the session's
 * detached `container` by AgentSurface, exactly like a terminal's xterm container.
 * Renders from {@link ChatSession.getModel} (re-subscribing on every applied event —
 * see chatSession.ts's two-channel notification note) instead of scraping any screen
 * buffer. Owns only VIEW state (which slide-over/lightbox is open, the queued quote) —
 * every mutation (send/rewind/retry/answer/alwaysAllow) is a direct `session` call, per
 * the frozen `chat/` component contracts (T5/T6).
 *
 * NOTE on i18n: every sibling component in this directory (AgentTabs, AgentComposerBar,
 * PaneFragment, GoalLivePanel, AgentDock, AgentSetup) hardcodes its English copy — none use
 * `useI18n`/`t()`. `settings.agents.screen*` exist in I18nContext only because
 * SettingsPage.tsx (which DOES use i18n) needed them for its Agent-screen picker row. This
 * file follows the established local convention of its own directory rather than
 * introducing i18n into a component family that has never used it.
 */

/** How long an `AskUserQuestion` may be routing before the pane says so. Short enough that
 *  the wait is never silent, long enough that a question which routes promptly never flashes
 *  a loading pill on its way in. */
const ASK_PREPARING_MS = 600;

/** How long an `AskUserQuestion` may be routing before it is treated as BROKEN rather than
 *  slow. Was 4s, which a healthy-but-slow route (a long questions payload, a busy machine)
 *  overran routinely — so the escape hatch fired on questions that then arrived fine a beat
 *  later, and the user read "Continue in Terminal view" as the answer to a question the pane
 *  was about to render itself. The wait now has a loading state of its own
 *  ({@link ASK_PREPARING_MS}); this threshold only has to catch a genuine CLI regression, so
 *  it is set past any plausible routing delay. */
const WATCHDOG_MS = 30000;

/** How long an UPWARD gesture keeps ownership of the scroller. Covers the frame or two
 *  between the gesture and the scroll it produces, plus the gaps inside trackpad momentum
 *  (which keeps emitting wheel events that refresh it). A DOWNWARD gesture doesn't open a
 *  window at all — it closes any open one; see `markIntent`. */
const GESTURE_MS = 500;

/** How far below the transcript's top edge a rail jump parks its target — the pinned rail's
 *  own height plus its top offset plus a little air, so the row it scrolled to lands just
 *  under the rail instead of behind it. */
const RAIL_CLEARANCE = 64;

/** How long a jumped-to sub-agent row stays flashed. */
const FLASH_MS = 1600;

/** How many candidate anchor rows a reveal captures to measure its own prepend against.
 *  One would do for every row keyed by `item.id`; the spares exist because the combined
 *  `SubAgentCard`'s key can migrate on the very reveal being measured — see `revealEarlier`. */
const ANCHOR_CANDIDATES = 5;

/** An element's offset inside the scroller's CONTENT box. Deliberately not `offsetTop`
 *  (whose `offsetParent` sits outside the scroller, so a growing composer moves it) and
 *  deliberately scroll-invariant: `rect.top` falls by exactly what `scrollTop` rises by, so
 *  the sum is the same number before and after any scroll — including the browser's own
 *  clamp during the commit being measured. */
function contentTopOf(node: Element, scroller: HTMLElement): number {
  return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

function safeStringify(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/** A Bash tool call's command — the text the bypass notice reports as having run. */
function bashCommand(item: ChatToolItem): string | null {
  if (item.name !== 'Bash' || !item.input || typeof item.input !== 'object') return null;
  const cmd = (item.input as Record<string, unknown>).command;
  return typeof cmd === 'string' && cmd ? cmd : null;
}

/** The tool's primary path/file argument, if it has one — mirrors `ToolCard.tsx`'s private
 *  `primaryPath` (not exported; that file is frozen T5 ownership) so this orchestrator can
 *  decide, WITHOUT duplicating ToolCard's own rendering, whether a tool item references an
 *  Excalidraw board and should render as a {@link BoardEmbed} instead. */
function primaryToolPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = obj[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

// ─── Live rail — linked task chip + this conversation's live orchestration bars ─────
//
// The context/cost readout AC9 originally put here now lives in the redesigned
// `Composer` (task T6) — the brief's "implementer picks the cleanest of the two"
// decision landed there, so showing it here too would just duplicate the number. What
// stays is AMBIENT RUN STATE: the linked task, plus the two skill orchestrations that
// report live progress for THIS conversation — goal-skill's phase run and council's
// debate chamber. Both feeds are session-scoped server-side (`?claudeId=`) identically
// for chat and terminal panes, but only the goal one was ever mounted here: a `/council`
// driven from a Chat tab rendered nothing at all, while the same debate from a terminal
// tab showed the chamber strip (owner report 07-25). Both are mounted now.
//
// Each child renders NOTHING while its own state is inactive, so the rail has no element
// children at all in the common case and `:empty` hides it — a plain conversation gets no
// stray bordered strip above its transcript.

interface TaskLinkInfo { name: string; objectiveLabels: string[] }

/** Linked-task chip + objectives data, fetched only when `taskSlug` is supplied. No caller
 *  sets `taskSlug` yet, so this hook is a built-but-dormant mechanism in this release. */
function useTaskLink(taskSlug?: string): TaskLinkInfo | null {
  const api = useApi();
  const [info, setInfo] = useState<TaskLinkInfo | null>(null);
  useEffect(() => {
    if (!taskSlug) { setInfo(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const [taskRes, objRes] = await Promise.all([
          api.get<{ task: { name?: string; objectives?: string[] } }>(`/tasks/${encodeURIComponent(taskSlug)}`),
          api.get<{ objectives: Array<{ slug: string; title: string }> }>('/objectives'),
        ]);
        if (cancelled) return;
        const objMap = new Map((objRes.objectives ?? []).map((o) => [o.slug, o.title] as const));
        const slugs = taskRes.task?.objectives ?? [];
        setInfo({ name: taskRes.task?.name ?? taskSlug, objectiveLabels: slugs.map((s) => objMap.get(s) ?? s) });
      } catch {
        if (!cancelled) setInfo(null);
      }
    })();
    return () => { cancelled = true; };
  }, [api, taskSlug]);
  return info;
}

function ChatLiveRail({ session, taskSlug }: { session: ChatSession; taskSlug?: string }) {
  const link = useTaskLink(taskSlug);
  // Both panels poll regardless of whether a task is linked — a run is a property of the
  // conversation, not of the task chip that may or may not sit beside it.
  const live = session.status === 'open';
  return (
    <div className="chat-live-rail">
      {link && (
        <div className="chat-context-task">
          <span className="chat-context-task-glyph" aria-hidden>📋</span>
          <span className="chat-context-task-name">{link.name}</span>
          {link.objectiveLabels.map((o) => (
            <span key={o} className="chat-context-objective">{o}</span>
          ))}
        </div>
      )}
      <GoalLivePanel claudeId={session.claudeId} enabled={live} />
      <CouncilLivePanel claudeId={session.claudeId} enabled={live} />
    </div>
  );
}

// ─── AskUserQuestion routing state: preparing, then the degraded card ──────────────
//
// An `AskUserQuestion` tool call and the `question` control_request that carries its
// payload are two separate arrivals, and the gap between them is dead air: the tool row
// is running, `turnHasVisibleProgress` is therefore true so the working indicator stays
// down, and nothing on screen says a question is on its way. That gap is what this pair
// of states fills — `preparing` while it is merely slow, the degraded card only once it
// is long enough to mean broken.
//
// The degraded card is not one of the 12 design states — a fallback for a future CLI
// regression, kept from the pre-redesign ChatPane verbatim (the spike PROVED headless
// routing works on 2.1.218). Styled locally since it isn't one of T5's card components.

/** What the pane should show for an `AskUserQuestion` whose payload hasn't landed yet.
 *  `null` = nothing to show (no ask in flight, or the real question has arrived). */
type AskRoutingState = { item: ChatToolItem; phase: 'preparing' | 'degraded' } | null;

/**
 * Watches an `AskUserQuestion` tool call that has not yet surfaced its matching `question`
 * control_request: `preparing` past {@link ASK_PREPARING_MS}, `degraded` past
 * {@link WATCHDOG_MS}. Cleared the moment a real pending question arrives, or the tool card
 * itself resolves (answered some other way, or errored).
 */
function useAskQuestionWatchdog(items: ChatItem[], hasPendingQuestion: boolean): AskRoutingState {
  const [state, setState] = useState<AskRoutingState>(null);
  useEffect(() => {
    const running = [...items].reverse().find(
      (it): it is ChatToolItem => it.kind === 'tool' && it.name === 'AskUserQuestion' && it.status === 'running',
    ) ?? null;
    if (!running || hasPendingQuestion) { setState(null); return; }

    const elapsed = Date.now() - running.startedAt;
    const enter = (phase: 'preparing' | 'degraded') => setState({ item: running, phase });
    // Both thresholds are re-armed from the tool's OWN start time, so an unrelated re-render
    // mid-wait can't restart either clock.
    if (elapsed >= WATCHDOG_MS) { enter('degraded'); return; }

    const timers: ReturnType<typeof setTimeout>[] = [];
    if (elapsed >= ASK_PREPARING_MS) {
      enter('preparing');
    } else {
      setState(null);
      timers.push(setTimeout(() => enter('preparing'), ASK_PREPARING_MS - elapsed));
    }
    timers.push(setTimeout(() => enter('degraded'), WATCHDOG_MS - elapsed));
    return () => timers.forEach(clearTimeout);
  }, [items, hasPendingQuestion]);
  return state;
}

/**
 * The question is on its way — the tool is running, its payload hasn't arrived. Reuses
 * `WorkingIndicator`'s dots-and-clock pill rather than inventing a second waiting shape:
 * this IS the working indicator's job (a live turn with nothing on screen), just for a gap
 * that `turnHasVisibleProgress` reads as covered because the tool row is running.
 */
function PreparingQuestionCard({ item }: { item: ChatToolItem }) {
  return <WorkingIndicator label="Preparing a question…" startedAt={item.startedAt} />;
}

function DegradedQuestionCard({ item, onContinueInTerminal }: { item: ChatToolItem; onContinueInTerminal: () => void }) {
  return (
    <div className="chat-degrade-card">
      <div className="chat-degrade-head">
        <span className="chat-degrade-glyph" aria-hidden>❓</span>
        <span className="chat-degrade-title">Claude is asking a question</span>
      </div>
      <p className="chat-degrade-note">
        This session didn't route the question through Chat — here's the raw request. Continue in Terminal view to answer it.
      </p>
      <pre className="chat-degrade-copy">{safeStringify(item.input)}</pre>
      <div className="chat-card-actions">
        <button type="button" className="chat-btn primary" onClick={onContinueInTerminal}>Continue in Terminal view</button>
      </div>
    </div>
  );
}

// ─── Automation HITL question card (D2 / D-G) ──────────────────────────────────────
//
// A scheduled automation is "ask-and-exit": the headless run writes its question and the
// process EXITS rather than blocking, so nothing lands in `conv.pending` for it (that
// channel is the live CLI's own control-channel asks — a wholly different transport from
// this one, which answers over `useAnswerQuestion`'s HTTP mutation against
// `/api/automations/questions/:id`). Reusing SurveyCard/PermissionCard directly isn't
// possible — both hardcode a `session.answer*` call — so this is styled locally to match
// that family's look, exactly the way `DegradedQuestionCard` above does for the same
// reason: not one of the 12 design states, but must still read as Claude asking a
// question rather than a foreign widget (D2's explicit constraint, and the whole reason
// the old `AutomationsReviewQueue` panel was deleted).

/** One question, rendered per its `kind` (see `AnswerQuestionInput`'s doc comment for why
 *  the two are not interchangeable): explicit approve/reject for `'approval'`, choice
 *  buttons or free text for `'flow-hitl'`. */
function AutomationHitlCard({ question }: { question: AutomationQuestion }) {
  const answerQuestion = useAnswerQuestion();
  const [freeText, setFreeText] = useState('');
  /** What the human picked, kept for the receipt. `null` after a failed send so the card
   *  reopens for another try instead of stranding the human on a receipt that lied. */
  const [picked, setPicked] = useState<string | null>(null);

  const busy = answerQuestion.isPending;
  const locked = picked !== null;

  const submit = (input: AnswerQuestionInput, label: string) => {
    if (busy || locked) return;
    setPicked(label);
    answerQuestion.mutate(input, { onError: () => setPicked(null) });
  };

  const submitFreeText = () => {
    const text = freeText.trim();
    if (!text) return;
    submit({ id: question.id, kind: 'flow-hitl', answer: text }, text);
  };

  return (
    <div className="chat-hitlcard">
      <div className="chat-hitlcard-head">
        <span className="chat-hitlcard-pill">
          <span aria-hidden>{question.kind === 'approval' ? '🔐' : '❓'}</span>
          {question.kind === 'approval' ? 'Approval needed' : 'Question'}
        </span>
      </div>
      <p className="chat-hitlcard-question">{question.question}</p>

      {locked ? (
        <div className="chat-hitlcard-receipt">
          <span className="chat-hitlcard-receipt-check" aria-hidden>✓</span>
          <span>{question.kind === 'approval' ? picked : `You answered: “${picked}”`}</span>
        </div>
      ) : question.kind === 'approval' ? (
        // The sha256 approval tripwire wearing a chat face (D-H): an explicit decision,
        // never free text — typing "no, this looks wrong" must not read as consent.
        <div className="chat-card-actions">
          <button
            type="button"
            className="chat-btn pill"
            disabled={busy}
            onClick={() => submit({ id: question.id, kind: 'approval', decision: 'reject' }, 'Rejected')}
          >Reject</button>
          <button
            type="button"
            className="chat-btn pill primary"
            disabled={busy}
            onClick={() => submit({ id: question.id, kind: 'approval', decision: 'approve' }, 'Approved')}
          >Approve</button>
        </div>
      ) : question.choices.length > 0 ? (
        <div className="chat-hitlcard-choices">
          {question.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className="chat-hitlcard-choice"
              disabled={busy}
              onClick={() => submit({ id: question.id, kind: 'flow-hitl', answer: choice }, choice)}
            >{choice}</button>
          ))}
        </div>
      ) : (
        // The runner creates every `flow-hitl` question with an empty `choices` array today
        // (T18b's brief), so free text is the NORMAL path here, not a fallback.
        <div className="chat-hitlcard-freetext">
          <textarea
            className="chat-hitlcard-input"
            rows={2}
            value={freeText}
            placeholder="Type your answer…"
            disabled={busy}
            aria-label={`Your answer — ${question.question}`}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitFreeText(); }
            }}
          />
          <div className="chat-card-actions">
            <button type="button" className="chat-btn primary" disabled={busy || !freeText.trim()} onClick={submitFreeText}>
              Send <span aria-hidden>→</span>
            </button>
          </div>
        </div>
      )}

      {answerQuestion.isError && (
        <p className="chat-hitlcard-error">Couldn't send that — {(answerQuestion.error as Error).message || 'try again.'}</p>
      )}
    </div>
  );
}

/**
 * Every pending question that belongs to THIS pane's automation run — scoped to
 * `automation.slug`, never a project-wide list. `useAutomationQuestions` polls across
 * every automation (it also feeds the board's badges), so the filter is what keeps this
 * reading as one conversation asking its own question rather than a foreign inbox pasted
 * into it. Split into its own component (rather than called from `ChatPane` directly) so
 * the 5s poll it needs exists only for a pane that is actually showing an automation run
 * — an ordinary chat pane subscribes to neither automation hook.
 */
function AutomationQuestionSlot({
  automation, onPendingChange,
}: {
  automation: AutomationRunRef;
  /** Reported UP so the pane can replace the composer while a question is open (see the
   *  composer branch near the bottom of `ChatPane`). The hook stays down here rather than
   *  being lifted, so its 5s poll still exists only for a pane actually showing a run. */
  onPendingChange: (pending: boolean) => void;
}) {
  const { data: questions } = useAutomationQuestions();
  const mine = (questions ?? []).filter((q) => q.slug === automation.slug);
  const pending = mine.length > 0;
  // In an effect, not during render: reporting up mid-render would set state on the parent
  // while this child is still rendering.
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  if (!pending) return null;
  return <>{mine.map((q) => <AutomationHitlCard key={q.id} question={q} />)}</>;
}

/**
 * Replaces the composer while this run has an open question.
 *
 * THE HOLE THIS CLOSES — inherited from `runChatUnavailableReason`, which used to close it
 * by refusing to open the chat at all. This session runs with `bypassPermissions`. A user
 * who typed "just go ahead" here would get the run continued with the question still
 * pending: nothing marks it answered, so `retireIfDone` never runs, the session binding is
 * never retired, and every future fire keeps refusing with `awaiting-review`. The run would
 * be permanently stuck AND would have acted. The card above is the only path that routes
 * through `resumeWithAnswer`, so it is the only path offered.
 */
function AutomationQuestionComposerLock() {
  return (
    <div className="chat-hitlcard-lock" role="status">
      This run stopped to ask you something. Answer it in the card above — a message typed
      here would continue the run without recording your answer.
    </div>
  );
}

// ─── View-only state for the two overlay surfaces (state 3/9's slide-over, state 4's
//    lightbox). Every OTHER piece of state this pane renders from lives in
//    `session.getModel()` — or, for the composer's quote (state 11), in `composerScratch`
//    under the conversation id, so a respawn cannot drop it. This is purely presentation. ──

type SlideOverState =
  | { mode: 'file'; path: string }
  | { mode: 'subagent'; run: SubAgentRun }
  /** A background shell's live output — a separate mode from `subagent` because a shell has
   *  no sidechain transcript to render; it has an output file and a stop action. */
  | { mode: 'shell'; run: SubAgentRun }
  | null;

interface LightboxState { src: string; caption?: string; path?: string }

/** A PDF opened at full window (see `PdfViewer`) — the document equivalent of the lightbox,
 *  and the reason a `.pdf` chip no longer lands in the panel's text preview. */
interface PdfState { path: string; label?: string }

// ─── Top level ──────────────────────────────────────────────────────────────────────

export function ChatPane({
  session, modelConfig, model, effort, onModelChange, onEffortChange, taskSlug, onContinueInTerminal,
  permissionMode, onPermissionModeChange, mode, onModeChange, onHandoffToDevelop,
  onResume, automation, onOpenAppPage, onSignIn,
  canSignInInApp, signInCommand,
}: {
  session: ChatSession;
  modelConfig: ModelConfig;
  model: string;
  effort: string;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  /** No caller sets this yet — the ChatLiveRail's task chip is built and dormant. */
  taskSlug?: string;
  onContinueInTerminal: () => void;
  /**
   * The REMEMBERED permission-mode default for this PROJECT (`agentSettings.chatPermissionMode`).
   *
   * It is the WRITE path's current value — what the composer's Auto/Bypass segment should show
   * as selected when the user goes to change the project default — and NOT what this session
   * is running under. Those two can genuinely disagree: a Plan→Develop hand-off is forced to
   * `auto` inside a project whose remembered default is `bypass`.
   *
   * So this value is deliberately NOT the composer's INDICATOR — `inBypass` below resolves the
   * session's own truth from the CLI's report, and that is what the trigger and the segment
   * render. This one travels alongside it as `projectPermissionMode`, purely so the menu can
   * SAY what a click reaches ("Applies to every chat in this project (project default: …)").
   * Both scopes are named; neither stands in for the other. See the render site.
   */
  permissionMode: 'auto' | 'bypass';
  onPermissionModeChange: (mode: 'auto' | 'bypass') => void;
  /** How this conversation's agent is briefed to work (plain / plan / develop). */
  mode: ChatMode;
  /** Re-brief it. Respawns the session under the new brief — see AgentSurface's
   *  `changeChatMode`; the composer's mode menu says so before the reconnect happens. */
  onModeChange: (mode: ChatMode) => void;
  /** A `develop` action button asked to hand this plan off. Opens a NEW Develop session
   *  carrying the slug and closes this tab (AgentSurface's `handoffToDevelop`). */
  onHandoffToDevelop: (taskSlug: string) => void;
  /** Respawn this exact conversation UUID as a fresh chat session (state 12's "Session
   *  ended" banner, which REPLACES the composer). */
  onResume: () => void;
  /** Set only when this conversation is an automation RUN, reopened from that automation's
   *  run history — the one kind of chat here that nobody typed into. Renders the run header
   *  above the transcript; see `AutomationRunHeader` for why a transcript with a machine's
   *  brief as its first "user" message needs one. */
  automation?: AutomationRunRef;
  /** Ask the wider app to open a dreamcontext entity (task/knowledge/core) referenced from
   *  chat (SlideOver's "Open in app ↗", state 3). AgentSurface is mounted above the router
   *  with no direct page-navigation channel of its own — see its wiring note for what this
   *  does today (collapses the overlay + a forward-compatible event) versus a true deep
   *  link, which needs a Shell-level listener outside this task's file ownership. Omitted
   *  entirely degrades to "Open in app" simply not being offered (SlideOver already gates
   *  the button on `reference.appNav` existing at all). */
  onOpenAppPage?: (page: 'tasks' | 'knowledge' | 'core', id: string) => void;
  /** Open a terminal pane that runs the sign-in command — the only surface the flow exists on
   *  (this engine is headless; it answers `/login` with "isn't available in this environment").
   *  Fires from the SignInBanner and from typing `/login` into the composer. */
  onSignIn: () => void;
  /** Whether that pane can actually open here (node-pty + the CLI). False → the banner prints
   *  the command to copy instead of a button that would open a pane that can't start. */
  canSignInInApp: boolean;
  /** The sign-in command the INSTALLED CLI actually has, server-probed
   *  (`Capabilities.claudeAuth.loginCommand`) — so the banner can never name a command this
   *  machine doesn't have. */
  signInCommand: string;
}) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => session.subscribe(() => force()), [session]);
  const { vault } = useVault();
  const api = useApi();

  const conv = session.getModel();
  // The pinned shelf's whole state. Declared up here with the pane's other session-scoped
  // hooks because BOTH the shelf and the composer read from it: the composer squares its top
  // corners for exactly the states in which the shell grows a border, and asking the same
  // question twice is how those two drift apart.
  const shelf = useShelf(session, vault);
  const hasPendingQuestion = conv.pending.some((p) => p.kind === 'question');
  const askRouting = useAskQuestionWatchdog(conv.items, hasPendingQuestion);

  /**
   * Live sessions in CONNECTED PROJECTS, opened by addressing one (`@acme-payments …`).
   *
   * Owned by the pane rather than the transcript for the same reason the background-shells
   * tray is: a peer session outlives the message that started it, can sit blocked on a
   * permission prompt, and must not scroll away while it does. `key` is monotonic so
   * addressing the same peer twice opens a SECOND session instead of remounting the first —
   * two questions to one project are two conversations, and silently reusing the socket
   * would throw away the first answer mid-stream.
   */
  const [peerSessions, setPeerSessions] = useState<Array<{ key: number; peer: PeerMention; prompt: string }>>([]);
  const peerKeyRef = useRef(0);
  /** Connected peers, fetched once per pane — lets a `peer-<vault>` envoy run wear that
   *  vault's logo and name in the sub-agent card, rail and drill-in. */
  const peers = usePeerMentions();

  const [slideOver, setSlideOver] = useState<SlideOverState>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [pdf, setPdf] = useState<PdfState | null>(null);
  /** A board opened genuinely fullscreen (§1.7) — the ONLY overlay a board ever renders in
   *  now. Owned here, not by `SlideOver`, because a board has four entry points spread
   *  across this file, `BoardEmbed` and `TranscriptItem`, and a single owner is what makes
   *  all four converge on the same overlay instead of drifting back apart. */
  const [boardFull, setBoardFull] = useState<string | null>(null);
  /**
   * The message the next send quotes (state 11's ↩ Quote-reply).
   *
   * Held in `composerScratch` under the CONVERSATION id, not in this pane: a mode switch — or
   * a permission switch into Bypass, which the CLI refuses to apply live — respawns the
   * process, and this pane unmounts with it. "I am replying to THIS message" is a fact about
   * the conversation, not about the process, so it outlives the respawn for the same reason
   * the attachment chips beside it do. Local state mirrors the store so React re-renders.
   */
  const convId = session.claudeId;
  const [replyQuote, setReplyQuote] = useState<string | null>(() => readScratch(convId).quote);
  useEffect(() => {
    setReplyQuote(readScratch(convId).quote);
    return subscribeScratch(convId, (next) => setReplyQuote(next.quote));
  }, [convId]);
  /** Does this automation run have an unanswered question right now? Reported up by
   *  `AutomationQuestionSlot` (which owns the poll) so the composer can be replaced while
   *  it is open — see `AutomationQuestionComposerLock` for why that matters. Always false
   *  for an ordinary chat pane, which never mounts the slot. */
  const [hitlPending, setHitlPending] = useState(false);

  // ── Transcript scroll: one scroller, one session, one stick-to-bottom state ──────────
  //
  // Every mounted ChatPane re-renders whenever AgentSurface re-renders — which happens on
  // ANY session's busy/asking edge — so a scroll write that ran "after every render" meant
  // sending a message in one chat yanked its split neighbour's transcript around (owner
  // report 07-25). The auto-scroll below therefore keys on this session's CONVERSATION MODEL
  // identity: `conv` is a fresh object on every event THIS session applied, and the same
  // object for every render caused by anything else.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  /** `scrollTop` at the last scroll event — the direction signal `nextStickToBottom` reads. */
  const prevTopRef = useRef(0);
  /** When the user last asked to move UP — the other half of that signal. See below. */
  const upIntentAtRef = useRef(-Infinity);
  /** A scrollbar drag holds the gesture open: its scroll events span the whole press. */
  const draggingRef = useRef(false);
  /** The last touch Y, so a touch drag's direction can be read off consecutive moves. */
  const touchYRef = useRef(0);
  /** Where the reader is, for the re-home hook to put back — see `nextRestoreTop`. Held apart
   *  from `prevTopRef`, which is a raw per-event direction sample and is deliberately allowed
   *  to record positions (a clamp, a re-home's 0) that are nobody's reading position. */
  const restoreTopRef = useRef(0);
  /** Render mirror of `stickRef`, for the "jump to latest" affordance only. */
  const [pinned, setPinned] = useState(true);

  /** In-flight re-assert frame, so a burst of pins during a stream schedules ONE. */
  const repinFrameRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    // A minimized pane's container is parked in the detached garage: it measures 0 and
    // cannot be scrolled. The observer below re-runs this the moment it is re-homed.
    if (!el || el.clientHeight === 0) return;
    el.scrollTop = el.scrollHeight;
    prevTopRef.current = el.scrollTop;
    restoreTopRef.current = el.scrollTop;
    // Then RE-MEASURE next frame, because "scrollTop = scrollHeight" is only true at the
    // instant it is written. The pane docks furniture BELOW the scroller — the
    // background-shells tray, the auto-growing composer — and when one of those grows, the
    // scroller shrinks under a view that was at its maximum: `scrollTop` stays valid, the
    // maximum moves away from it, and NO scroll event is dispatched because nothing scrolled
    // (measured: a tray growing by 186px silently left 174px of transcript below the fold).
    // Nothing in the event path can notice that, which is why the transcript could sit a card
    // and a half short of the bottom while still believing it was pinned — no Latest pill to
    // get back with, and the only thing that ever fixed it was the next frame of content
    // arriving (owner report 07-25: "it goes too far down, an update fixes it, then it slides
    // down again"). One frame later every one of those layouts has settled, so a single
    // re-measurement covers the whole class — including the window where the ResizeObserver
    // below is mid-resubscription.
    if (typeof requestAnimationFrame !== 'function' || repinFrameRef.current) return;
    repinFrameRef.current = requestAnimationFrame(() => {
      repinFrameRef.current = 0;
      const now = scrollRef.current;
      if (!now || !stickRef.current || now.clientHeight === 0) return;
      if (isAtBottom({ scrollTop: now.scrollTop, scrollHeight: now.scrollHeight, clientHeight: now.clientHeight })) return;
      now.scrollTop = now.scrollHeight;
      prevTopRef.current = now.scrollTop;
      restoreTopRef.current = now.scrollTop;
    });
  }, []);

  useEffect(() => () => {
    if (repinFrameRef.current) cancelAnimationFrame(repinFrameRef.current);
  }, []);

  const setStick = useCallback((next: boolean) => {
    stickRef.current = next;
    setPinned((prev) => (prev === next ? prev : next));
  }, []);

  // A scroll event carries no hint of what caused it, and the transcript is a surface whose
  // content moves on its own constantly — so `nextStickToBottom` is told, per event, whether
  // the user asked to go UP. Nothing else may unpin the view.
  //
  // DIRECTION is the whole point. Tracking "a gesture happened" was not enough: the browser
  // clamps `scrollTop` when a block shrinks under a pinned view, and that clamp reaches the
  // scroll handler looking exactly like a scroll up (see nextStickToBottom's rule 2). Since
  // flicking DOWN to follow a streaming answer emits trackpad momentum for the rest of the
  // turn, the direction-blind window was open at precisely the moment the turn's cards
  // collapsed — so the view unpinned and stranded mid-transcript. A downward gesture now
  // CLOSES the window instead of refreshing it: following the answer can never license
  // leaving it.
  const markIntent = useCallback((intent: ScrollIntent) => {
    if (intent === 'up') upIntentAtRef.current = performance.now();
    else if (intent === 'down') upIntentAtRef.current = -Infinity;
  }, []);
  const userDriving = () => draggingRef.current || performance.now() - upIntentAtRef.current < GESTURE_MS;

  // ── Settle: when is the scroller OURS to write? ─────────────────────────────────────
  //
  // The scrollbar-drag lesson (see shouldAutoReveal) turned out to be one case of a class:
  // in this app's WKWebView the offset is animated out of process, so ANY gesture still in
  // flight — above all trackpad momentum, which keeps decaying for a second-plus after the
  // fingers lift — can overwrite a `scrollTop` the pane writes, or be killed dead by it.
  // Either one is the owner's "flicker" (report 08-01): the reveal's correction landing
  // mid-momentum either cascades (the drag trace, replayed) or stops the glide with a jerk.
  // Playwright cannot emit momentum, which is why 07-28's re-verification held 7/7 and the
  // report came back anyway.
  //
  // So every window mutation that is paid for by writing `scrollTop` now waits for QUIET:
  // no user input for SCROLL_SETTLE_MS. Tracked off INPUT events only (wheel/touch/key,
  // plus the drag's own flag) — never off scroll events, because our own pin re-asserts
  // dispatch those constantly while a turn streams, and counting them would hold the window
  // frozen forever. macOS momentum keeps emitting wheel events for its whole decay, so the
  // quiet timer genuinely outlives the animator.
  const lastActivityAtRef = useRef(-Infinity);
  const markActivity = useCallback(() => { lastActivityAtRef.current = performance.now(); }, []);
  /** Pending settled-reveal timer, so a burst of scroll events keeps exactly one alive. */
  const settleTimerRef = useRef(0);

  /**
   * Reveal once the scroller has settled. Re-armed by every scroll event that still wants a
   * reveal (so a momentum train that moves the offset keeps pushing it out) and self-re-armed
   * while input activity is fresher than {@link SCROLL_SETTLE_MS} (so a train that is clamped
   * at the ceiling — moving nothing, but still emitting wheel events — pushes it out too).
   * The conditions are re-checked at fire time: the reader may have scrolled back down, or a
   * drag may have started, in which case its release owns the reveal.
   */
  const armSettledReveal = useCallback(() => {
    if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
    const tick = () => {
      settleTimerRef.current = 0;
      const wait = remainingSettleMs(performance.now(), lastActivityAtRef.current);
      if (wait > 0) { settleTimerRef.current = window.setTimeout(tick, wait); return; }
      if (draggingRef.current) return;
      const el = scrollRef.current;
      if (!el || el.clientHeight === 0 || el.scrollTop >= WINDOW_REVEAL_PX) return;
      revealEarlierRef.current();
    };
    settleTimerRef.current = window.setTimeout(tick, SCROLL_SETTLE_MS);
  }, []);

  useEffect(() => () => {
    if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
  }, []);

  // Pressing the scrollbar gutter is a scroll gesture; pressing a card is not — clicking one
  // open changes the content height, and counting that as "the user scrolled" would unpin
  // the view on a click that never touched the scrollbar.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (e.clientX - el.getBoundingClientRect().left <= el.clientWidth) return;
    // A drag is unambiguous — it is the one gesture whose direction the scroll metrics can be
    // trusted for, because the pointer owns the scroller for the whole press.
    draggingRef.current = true;
    const release = () => {
      draggingRef.current = false;
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      // The reveal the drag was not allowed to make (see the scroll handler). The thumb is
      // released, the offset is ours to correct again, so reading up to the ceiling by
      // dragging still extends the window — it just does it once, on release, instead of
      // once per frame while the browser is overwriting every correction.
      const el = scrollRef.current;
      if (el && el.clientHeight > 0 && el.scrollTop < WINDOW_REVEAL_PX) revealEarlierRef.current();
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  };

  /** `revealEarlier` for the pointer-release handler above, which is created before it and
   *  must not close over one render's copy — the press outlives several renders. */
  const revealEarlierRef = useRef<() => void>(() => {});

  // ── What a slice RENDERS AS: the two predicates the window and the transcript share ──
  //
  // Declared here, above the window, rather than beside the transcript pass they were written
  // for. The window used to count entries and entries alone, so it needed to know nothing
  // about what an entry looked like; now it has a card floor (chatEntities' card section) and
  // "how many cards is this slice" is a question only these two can answer.

  const suppressedToolUseIds = subAgentToolUseIds(conv.subAgents);
  // The mode this conversation is ACTUALLY running in, as the CLI itself reported it
  // (init frame, or a successful mid-session `set_permission_mode`) — NOT the remembered
  // `permissionMode` prop, which is only the default for the NEXT session and would
  // mislabel a session the user switched after it started.
  const inBypass = conv.permissionMode ? conv.permissionMode === 'bypassPermissions' : session.bypass;

  // Tool RUNS (owner report 08-01): a contiguous stretch of tool calls renders as ONE
  // collapsing card instead of N. What may join a run is exactly "what renders as a plain tool
  // card" — `itemNode`'s other branches produce something else (the sub-agent group card, a
  // drawn board, a bypass receipt riding along in a Fragment), and those must BREAK a run
  // rather than disappear into one. Hence this mirrors those branches rather than just testing
  // `kind === 'tool'`.
  const isPlainToolCard = (item: ChatItem): boolean => {
    if (item.kind !== 'tool') return false;
    if (suppressedToolUseIds.has(item.toolUseId)) return false;
    const path = primaryToolPath(item.input);
    if (path && classifyReference(path).kind === 'board' && item.status !== 'running') return false;
    if (inBypass) {
      const command = bashCommand(item);
      if (command && isGuardedCommand(command)) return false;
    }
    // A dreamcontext CLI call keeps its own position in the transcript (owner call 08-01:
    // "break the grouping, let it be its own row"). These are the calls that CHANGE the brain
    // — a task created, a status moved, knowledge written — and folding them into a collapsed
    // "12 steps" header hides the one class of row whose object the reader most needs to see.
    // Everything the run card was built for still holds for the reads and greps around them.
    if (isDreamcontextCommand(bashCommand(item) ?? undefined)) return false;
    return true;
  };

  // What renders as NOTHING (owner report 08-02) — the other half of `isPlainToolCard`, and
  // the reason grouping looked broken in the field. A thinking model opens a thinking block
  // before nearly every tool call, and when that block is the encrypted kind the CLI streams it
  // with NO text at all (`thinking: ""`, signature only) — an item that draws zero pixels.
  // Between every pair of calls sat one of these, so a 19-call stretch segmented into runs of
  // one and two, every one of them under MIN_TOOL_RUN, and the reader saw 19 ungrouped rows
  // with visibly nothing between them. A run must break on what the reader can SEE; an item
  // that renders nothing is an absence, not a boundary, so `segmentToolRuns` holds it instead
  // of ending the run — and the card count skips it for the same reason.
  //
  // Each branch mirrors an actual `return null` in the transcript's own components — nothing
  // is guessed invisible. The one null branch deliberately NOT mirrored is the second and
  // later sub-agent tool item (`itemNode`: the combined SubAgentCard is already shown): the
  // FIRST one is visible and breaks the stretch anyway, so the rest can only ever follow a
  // break, never sit interior to a run — mirroring it would buy nothing and would duplicate
  // `subAgentCardShown`'s render-order bookkeeping in a predicate that runs before rendering.
  const rendersNothing = (item: ChatItem): boolean => {
    if (item.kind === 'thinking') return !item.text;          // ThinkingBlock's own null branch
    if (item.kind === 'text') return !item.text && item.done;  // AssistantMessage's null branch
    return false;
  };

  // ── Transcript window: how much of the conversation is actually mounted ─────────────
  //
  // See chatEntities' window section for the rules. Here is the WIRING, and its two
  // load-bearing halves:
  //
  //   • the head is normalized DURING RENDER, because the slice below needs the answer for
  //     THIS paint — deriving it in an effect would mount the wrong window first and then
  //     correct it, i.e. a visible flash on every event. `nextFirstShown` is idempotent
  //     under a repeat application, so the render this schedules converges at once (React
  //     supports exactly this "adjust state while rendering" shape);
  //   • the pin state is read from `stickRef`, NOT from the `pinned` render mirror, because
  //     the ref is updated synchronously inside the scroll handler while the mirror lands a
  //     render later. In that gap an arriving token would otherwise still see "pinned" and
  //     slide the window forward — pulling content out from above a reader who has just
  //     this instant scrolled up, which is the one thing rule 3 exists to prevent.
  //
  // The pin is ALSO gated on the scroller being settled. Re-sticking happens mid-gesture
  // (momentum carries the reader into the bottom and rule 1 pins immediately), and an
  // unsettled "pinned" here would snap the window to the tail in that same instant —
  // unmounting every row the reader had revealed, collapsing `scrollHeight` and forcing a
  // clamp + rewrite while the animator still owns the offset. That snap-under-momentum is
  // the "removing old entries breaks my scroll" half of the 08-01 flicker report. Frozen
  // until quiet, the snap runs at rest, where its pre-paint correction really is invisible.
  // (Read at render time, not reactively: if no event arrives after the quiet elapses, the
  // snap simply waits for the next one — a delay in a memory optimization, not a leak.)
  const [firstShownState, setFirstShownState] = useState(0);
  const windowTotal = conv.history.length + conv.items.length;
  const settledNow = remainingSettleMs(performance.now(), lastActivityAtRef.current) === 0;
  // The conversation as ONE index space for the card walk — the concatenation the window has
  // always been an index into, read without ever building it (a resumed history is thousands
  // of entries and this runs per streamed token).
  const cardWindow: CardWindow<ChatItem> = {
    total: windowTotal,
    entryAt: (i) => (i < conv.history.length ? conv.history[i] : conv.items[i - conv.history.length]),
    isGroupable: isPlainToolCard,
    rendersNothing,
    minRun: MIN_TOOL_RUN,
  };
  // The CARD floor: how far back the following window has to reach for the transcript to hold
  // WINDOW_TAIL_CARDS things the reader can see. In an ordinary conversation this stops after
  // ~20 entries and the entry tail (40) is wider, so it changes nothing at all; it only bites
  // when a window's worth of entries has folded into a card or two and left nothing to scroll.
  const tailHead = headForCards(WINDOW_TAIL_CARDS, WINDOW_MAX_ENTRIES, cardWindow);
  const firstShown = nextFirstShown(firstShownState, {
    total: windowTotal, pinned: stickRef.current && settledNow, tailHead,
  });
  if (firstShown !== firstShownState) setFirstShownState(firstShown);
  const { hiddenCount, historyFrom, itemsFrom, showsHistory } = splitWindow(
    conv.history.length, conv.items.length, firstShown,
  );

  // ── The hold: what keeps an unpinned reader exactly where they are ──────────────────
  //
  // While the view follows the bottom, the bottom IS the anchor and `scrollToBottom` is the
  // whole story. The moment a reader scrolls up, that inverts: their scroll position is only
  // meaningful relative to the CONTENT, and this transcript's content above them changes
  // height constantly and asynchronously — an image or clip in a revealed message finishing
  // its load, a code block growing its copy bar in a post-paint decoration pass, a tool card
  // being expanded, a rewind truncating rows. Every one of those slides them off what they
  // were reading, with no cause they can see.
  //
  // Nothing absorbs that for us. The scroller sets `overflow-anchor: none` (see ChatPane.css)
  // and the app ships in a WKWebView, so the browser's own scroll anchoring is not the safety
  // net it would be on the web. What used to exist here was narrower than the problem: an
  // anchor armed for the duration of ONE reveal commit, released immediately after. It held
  // the prepend and nothing else — so the reveal's own images, arriving a few hundred
  // milliseconds later with nothing left watching, pushed the reader down anyway. That is the
  // 07-28 report ("I scroll up, you suddenly load the history, and my place moves") and it is
  // why the anchor below is HELD for as long as the reader is unpinned rather than armed per
  // reveal.
  //
  /** The rows the view is held against, nearest the fold first, plus a last-resort total
   *  height. `null` whenever the view is pinned (the bottom is its own anchor) or there is
   *  nothing measurable to hold. `prepend` marks a hold armed by a reveal — the one case where
   *  a large block of entries is KNOWN to be landing above the reader, and therefore the only
   *  case where the height fallback in `holdAnchorSteady` is worth taking. */
  const heldAnchorRef = useRef<
    { candidates: Array<{ node: Element; top: number }>; scrollHeight: number; prepend: boolean } | null
  >(null);

  /**
   * Take a fresh hold on what the reader is looking at.
   *
   * SEVERAL candidate rows, not one, and only rows they can actually SEE.
   *
   * Visible, because holding still a row that is above the fold is not the same as holding the
   * VIEW still: a block between it and the viewport can grow a line in the same commit while a
   * turn streams, and the reader would drift by exactly that. Whatever a visible row moves by
   * is, by definition, what the reader experiences.
   *
   * Several, because one of these nodes can be REPLACED rather than moved by the very commit
   * being measured. Ordinary rows are keyed by `item.id` and survive a prepend, but the one
   * combined `SubAgentCard` is keyed by the EARLIEST suppressed tool item in the window — so a
   * reveal that mounts an older fan-out migrates its key, React unmounts the card, and a hold
   * that happened to BE that card would leave the correction with nothing to measure and the
   * reader jumped by the whole prepend. The spares make that unreachable without this code
   * having to know anything about SubAgentCard.
   *
   * An OPEN run card is seen through, not held: its ROWS stand in as candidates. The card
   * groups a whole stretch of tool calls, and a reveal merges older calls into that same
   * group — INSIDE the card, above the reader, without moving the card's own top edge. A
   * hold on the card would measure zero and leave the reader shoved down by the entire
   * prepend (owner report 08-01, second pass: reading back through a folded run only works
   * "if I open the card and scroll" — this is what makes that read hold still). The rows are
   * plain `ToolCard`s keyed by `item.id`, so they survive the merge the card itself is
   * having. A CLOSED card holds as itself: it has no rows, and its header is its top.
   */
  const captureAnchor = useCallback((prepend = false) => {
    const el = scrollRef.current;
    const inner = contentRef.current;
    if (!el || !inner || el.clientHeight === 0) { heldAnchorRef.current = null; return; }
    const fold = el.getBoundingClientRect().top;
    const candidates: Array<{ node: Element; top: number }> = [];
    const rows: Element[] = [];
    for (const child of Array.from(inner.children)) {
      // Never the "show earlier" button: it is the one row a reveal can DELETE rather than
      // move (the last step exhausts the window), so holding against it measures its own
      // disappearance.
      if (child.classList.contains('chat-window-more')) continue;
      const runRows = child.classList.contains('chat-toolrun')
        ? child.querySelectorAll(':scope > .chat-toolrun-rows > *')
        : null;
      if (runRows && runRows.length) rows.push(...Array.from(runRows));
      else rows.push(child);
    }
    for (const node of rows) {
      if (candidates.length >= ANCHOR_CANDIDATES) break;
      if (node.getBoundingClientRect().bottom <= fold) continue;
      candidates.push({ node, top: contentTopOf(node, el) });
    }
    // A reveal keeps its hold even with no visible row to name (an empty or fully-clipped
    // transcript), because the height fallback is better than nothing for a known prepend.
    heldAnchorRef.current = candidates.length || prepend
      ? { candidates, scrollHeight: el.scrollHeight, prepend }
      : null;
  }, []);

  /**
   * Put the reader back on their row if the content above them changed height. Called from
   * everywhere such a change can surface: the layout effect after a reveal's commit (before
   * paint, so no intermediate position is ever shown) and the ResizeObserver below (which is
   * delivered after layout and before paint too, and is what catches every height change
   * React never rendered — a decoded image, a decoration pass, a media element resolving).
   *
   * IDEMPOTENT, deliberately: it re-measures the hold against the layout it just produced, so
   * a second call for the same change — the RO firing for a commit the layout effect already
   * corrected — computes a zero delta instead of applying the correction twice. That is what
   * makes it safe to call from both, and it is the same double-correction hazard that made us
   * turn native `overflow-anchor` off.
   *
   * `prevTopRef`/`restoreTopRef` move in the same breath as `scrollTop`, and that ordering is
   * the point: the compensating write dispatches its own scroll event, and a handler that saw
   * the OLD `prevScrollTop` would read this as a jump the user made. Writing them here means
   * the handler sees a consistent pair — and stops `nextRestoreTop` recording an offset the
   * reader was never at as their reading position.
   */
  const holdAnchorSteady = useCallback(() => {
    if (stickRef.current) return;
    const held = heldAnchorRef.current;
    const el = scrollRef.current;
    if (!held || !el || el.clientHeight === 0) return;
    const anchor = held.candidates.find((c) => c.node.isConnected);
    const delta = anchor
      ? anchorHoldCorrection({
        anchorTopBefore: anchor.top,
        anchorTopAfter: contentTopOf(anchor.node, el),
      })
      // Nothing the reader was looking at survived the commit — a rewind truncating the
      // transcript underneath a reveal. Total height is the WRONG measure (a streamed append
      // lands in it too, which is the whole reason for the anchors) but being off by one card
      // beats being off by the entire prepend, which is what doing nothing costs. Only for a
      // reveal: outside one, "every visible row was replaced" carries no promise about what
      // happened above, and a streaming append would drag the reader down for nothing.
      : held.prepend
        ? anchorHoldCorrection({ anchorTopBefore: held.scrollHeight, anchorTopAfter: el.scrollHeight })
        : 0;
    held.prepend = false;
    if (delta) {
      el.scrollTop += delta;
      prevTopRef.current = el.scrollTop;
      restoreTopRef.current = el.scrollTop;
    }
    // Re-hold against the layout that now exists. `contentTopOf` is scroll-invariant, so a
    // correction the scroller could not absorb (clamped at either end) and one that landed
    // perfectly leave the SAME numbers here — this is the truth either way, and recording it
    // is what makes the next call a no-op rather than a repeat of a correction already made.
    if (anchor) {
      for (const c of held.candidates) if (c.node.isConnected) c.top = contentTopOf(c.node, el);
      held.scrollHeight = el.scrollHeight;
    } else {
      captureAnchor();
    }
  }, [captureAnchor]);

  /** Step the window back. Not a `useCallback`: it closes over this render's window and card
   *  shape, exactly like the JSX handlers that call it, and its only long-lived reference is
   *  `revealEarlierRef` — which is re-pointed every render for that reason. */
  const revealEarlier = () => {
    // A step measured in ENTRIES can land entirely inside the fold the reader is already
    // looking at: 40 more calls merge into the same collapsed run and the transcript gains
    // nothing visible, which is "Show earlier messages" appearing to do nothing (owner report
    // 08-02). So the step is whichever reaches further — WINDOW_STEP entries, or far enough
    // back to add WINDOW_STEP_CARDS things to look at. The reveal's own ceiling is generous
    // and RELATIVE (this is an explicit ask, not the automatic floor): one press may mount a
    // WINDOW_MAX_ENTRIES-sized reach beyond what is already up.
    const revealHead = headForCards(
      countCards(firstShown, cardWindow) + WINDOW_STEP_CARDS,
      (windowTotal - firstShown) + WINDOW_MAX_ENTRIES,
      cardWindow,
    );
    const next = nextFirstShown(firstShown, { total: windowTotal, pinned: false, reveal: true, tailHead, revealHead });
    // Nothing left to reveal → leave the hold as it is, rather than re-arming it as a prepend
    // that is not coming.
    if (next === firstShown) return;
    // Asking for older messages is explicit intent to go and read them — so it releases
    // stick-to-bottom. Without this the render below would re-normalize under the pinned
    // rule and slide the window straight back to the tail, making the button do nothing.
    setStick(false);
    captureAnchor(true);
    setFirstShownState(next);
  };
  revealEarlierRef.current = revealEarlier;

  /** The INPUT-side arm for the settled reveal — the path that works when there is nothing
   *  to scroll. When the whole window folds into one collapsed run card the content can be
   *  SHORTER than the scroller, so no scroll event can ever fire; and at a clamped ceiling
   *  (scrollTop already 0) further wheel-up dispatches none either. Reading upward still has
   *  to extend the window (owner report 08-01, second pass: "scrolling doesn't load older
   *  messages" over a folded run). Same gates as the scroll handler's arm, minus the metrics
   *  only a scroll event has — the settled tick re-checks position and drag before firing.
   *  Not a useCallback: it closes over this render's `hiddenCount`, exactly like the JSX
   *  handlers that call it. */
  const armRevealFromInput = (intent: ScrollIntent) => {
    if (intent !== 'up') return;
    if (hiddenCount <= 0 || draggingRef.current) return;
    const el = scrollRef.current;
    if (!el || el.clientHeight === 0 || el.scrollTop >= WINDOW_REVEAL_PX) return;
    armSettledReveal();
  };

  // The reveal's own commit: React has just prepended the entries, so the hold is settled here,
  // synchronously, before the browser paints a single frame of the un-corrected position.
  useLayoutEffect(() => { holdAnchorSteady(); }, [firstShown, holdAnchorSteady]);

  // A LAYOUT effect, not a passive one, and that is the whole race: React has just mutated
  // the DOM, so the browser is holding a scroll event for whatever `scrollTop` clamp that
  // mutation forced. Re-pinning here — synchronously, before paint — means the handler sees
  // the pinned position instead of the clamped one, so the shrink-then-regrow sequence a
  // finishing turn produces (running cards collapsing, the working indicator unmounting) can
  // no longer read as "the user scrolled up". Post-paint it was always one frame too late:
  // scroll events fire BEFORE ResizeObserver callbacks, so the observer's re-pin can only
  // ever clean up after a wrong decision has been made. It also drops the frame of visible
  // lag behind every streamed token.
  useLayoutEffect(() => { if (stickRef.current) scrollToBottom(); }, [conv, scrollToBottom]);

  // ── Sub-agent rail: the group card, pinned once you have scrolled past it ────────────
  //
  // The card renders WHERE THE FAN-OUT WAS SPAWNED, so a run that takes minutes disappears
  // under the output that keeps arriving above it — the exact moment you most want to see
  // how the agents are doing. Once its top edge crosses the transcript's, the same group
  // reappears as a pinned strip of chips, and clicking one scrolls back to that row.
  //
  // Measured on scroll (two rects, no observer) rather than watched with an
  // IntersectionObserver: the trigger is "the card's HEADER has gone", which for a card
  // taller than the viewport is not an intersection change at all.
  const [subAgentCardEl, setSubAgentCardEl] = useState<HTMLDivElement | null>(null);
  const [railPinned, setRailPinned] = useState(false);
  /** The run a rail chip last jumped to. `n` makes a repeat click on the SAME chip a new
   *  state value, so the flash replays instead of silently doing nothing. */
  const [jumped, setJumped] = useState<{ id: string | null; n: number } | null>(null);

  const syncRail = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || !subAgentCardEl || scroller.clientHeight === 0) { setRailPinned(false); return; }
    setRailPinned(subAgentCardEl.getBoundingClientRect().top < scroller.getBoundingClientRect().top);
  }, [subAgentCardEl]);

  // Re-measure when the card mounts/unmounts (`syncRail` identity follows `subAgentCardEl`)
  // and on every event this session applied — a card whose rows grow, or a group that
  // finishes, both move the edge this reads without any scroll of its own.
  useEffect(() => { syncRail(); }, [syncRail, conv]);

  /** `syncRail` for the ResizeObserver below to call WITHOUT subscribing to its identity.
   *  That identity follows `subAgentCardEl`, which changes whenever a fan-out's card mounts,
   *  unmounts or moves — and an observer that tears down and re-subscribes on every one of
   *  those has a window in each teardown where a height change goes unseen. The pin's own
   *  re-assert covers that window too; this closes it. */
  const syncRailRef = useRef(syncRail);
  useEffect(() => { syncRailRef.current = syncRail; }, [syncRail]);

  /**
   * Scroll the transcript to a sub-agent's row (or, for `null`, the card as a whole) and
   * flash it. Clicking a chip is explicit intent to go LOOK at something above, so it also
   * releases stick-to-bottom — otherwise the next streamed token would yank the view
   * straight back down over the row just asked for. "Latest" is the way back.
   */
  const jumpToSubAgent = useCallback((taskId: string | null) => {
    const scroller = scrollRef.current;
    if (!scroller || !subAgentCardEl) return;
    const rows = Array.from(subAgentCardEl.querySelectorAll<HTMLElement>('[data-subagent-row]'));
    const target = (taskId && rows.find((r) => r.dataset.subagentRow === taskId)) || subAgentCardEl;
    setStick(false);
    // Scrolled by delta against OUR scroller rather than `scrollIntoView`, which would also
    // walk (and scroll) every ancestor — this pane is portaled into a host that has its own.
    const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: scroller.scrollTop + delta - RAIL_CLEARANCE, behavior: 'smooth' });
    setJumped((prev) => ({ id: taskId, n: (prev?.n ?? 0) + 1 }));
  }, [subAgentCardEl, setStick]);

  useEffect(() => {
    if (!jumped) return;
    const t = setTimeout(() => setJumped(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [jumped]);

  /** A wheel gesture that starts over the pinned rail scrolls the transcript, as it would
   *  have if the rail weren't in the way — an overlay is not in the scroller's ancestor
   *  chain, so the browser would otherwise scroll nothing at all. Deltas arrive in three
   *  units depending on the device (pixels, lines, pages); only pixels can be applied raw. */
  const forwardWheelToTranscript = useCallback((e: React.WheelEvent<HTMLElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const step = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
    markActivity();
    markIntent(wheelIntent(e.deltaY));
    el.scrollTop += e.deltaY * step;
  }, [markActivity, markIntent]);

  // Height changes React never rendered: an image or clip finishing its load, a tool card
  // expanding, the composer growing a line (which SHRINKS the scroller), a split or window
  // resize, and the container being re-homed into another pane's slot — a re-parent resets
  // `scrollTop` to 0, which is the "splitting jumped the transcript to the top" symptom.
  //
  // Both branches below are the SAME instruction, told to the two states the view can be in:
  // stay where you were. Pinned, that means the bottom; unpinned, it means the row the reader
  // is on — and an unpinned reader used to get nothing here at all, which is why a revealed
  // block's images could quietly push them off it long after the reveal itself was corrected.
  // RO callbacks are delivered after layout and before paint, so neither correction costs a
  // visibly wrong frame.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) scrollToBottom();
      else holdAnchorSteady();
      // Content growing ABOVE an unpinned view moves the card without a scroll event of
      // its own — the rail would otherwise still be showing a card that is back in view.
      syncRailRef.current();
    });
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom, holdAnchorSteady]);

  // The one height change the observer above CANNOT see: a re-home. `appendChild`-ing the
  // session's container into another slot zeroes `scrollTop` on every scroller inside it
  // without necessarily changing any box — two panes of the same size swapping, a tab
  // switching in place, the overlay re-expanding. AgentSurface calls `fitAndResize` on every
  // foreground session a frame after it re-homes them (its terminals refit their grid there);
  // for a chat, that IS this. Cheap and idempotent, so firing on a move that changed nothing
  // costs one assignment.
  //
  // Being at the bottom is only HALF the state a re-home destroys, and restoring only that
  // half is what the owner hit on 07-25: renaming a tab wrecked the other sessions' scroll.
  // A rename is a double-click, and the click half SELECTS that tab — which garages whatever
  // was on screen. The garaged transcript's `scrollTop` goes to 0 silently (measured: no
  // scroll event is dispatched for it, so nothing here can even notice), and a reader who had
  // scrolled up came back to the TOP of the conversation with nothing to put them back. So an
  // UNSTUCK view is restored to the offset it was last read at, not left where the re-parent
  // dropped it — and never yanked to the bottom, which would lose the same position twice.
  useEffect(() => {
    session.setTranscriptRepin(() => {
      const el = scrollRef.current;
      if (stickRef.current) scrollToBottom();
      // Guarded on the value actually differing so a `fitAndResize` for a move that scrolled
      // nothing (the common case — it fires on every layout change, not just re-homes) writes
      // nothing at all.
      else if (el && el.clientHeight > 0) {
        if (el.scrollTop !== restoreTopRef.current) {
          el.scrollTop = restoreTopRef.current;
          prevTopRef.current = el.scrollTop;
        }
        // Re-take the hold rather than waiting for a scroll event to do it. A garaged scroller
        // measures nothing, so whatever hold it had was dropped on the way out; and the branch
        // above dispatches no scroll event at all when the offset came back unchanged — which
        // is the common case, and would otherwise leave a re-homed reader unheld until they
        // touched the wheel.
        captureAnchor();
      }
      syncRail();
    });
    return () => session.setTranscriptRepin(null);
  }, [session, scrollToBottom, syncRail, captureAnchor]);

  // ── ⌃C stops the turn — the terminal renderer's reflex, on this surface too ─────────
  // The rule itself (chord, "a live selection is a copy", "an idle session keeps ⌃C") lives
  // in chat/interruptKey.ts; this is only where it is bound. Two deliberate choices:
  //
  //  • On the PANE ROOT, not `window`. Two chat panes can be on screen at once (a split), and
  //    a window listener in each would stop BOTH turns from one keypress. Listening on the
  //    root scopes the chord to the pane that actually contains the focused element — which
  //    is normally the composer textarea, kept focusable all through a turn for exactly this
  //    class of chord (see Composer's `disabled` note).
  //  • CAPTURE phase, so the chord is read before any descendant handler can consume it.
  //
  // `session.busy` is read at EVENT time rather than captured as a dep: the session object is
  // mutated in place (chatSession assigns `session.busy` and notifies), so the closure always
  // sees the live value and this listener never needs to be torn down and re-bound mid-turn.
  useEffect(() => {
    const root = paneRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      const hasSelection = !(window.getSelection()?.isCollapsed ?? true);
      if (!shouldInterruptChat(e, { busy: session.busy, hasSelection })) return;
      e.preventDefault();
      e.stopPropagation();
      session.interrupt();
    };
    root.addEventListener('keydown', onKey, true);
    return () => root.removeEventListener('keydown', onKey, true);
  }, [session]);

  // ── State 3/4: a clicked file reference either opens the Lightbox (an image) or the
  //    file SlideOver (everything else, including a board — no rasterizer exists, so a
  //    board's "Open board ↗" degrades to the same numbered text preview; see chatEntities'
  //    Reference/classifyReference and the plan's board-thumbnail resolution). ──────────
  //
  // Every one of these is a `useCallback` because they are the props `ItemView`/`ToolCard`
  // are MEMOIZED on: an inline arrow here is a new function identity on every render, which
  // would defeat the memo for the whole transcript and put us back to re-rendering N items
  // per streamed token. Their dependency sets are all stable (`setState` setters, the
  // session object, one memoized surface callback), so in practice they are created once
  // per mounted pane.
  const handleOpenFile = useCallback((path: string) => {
    const ref = classifyReference(path);
    // A board is DRAWN fullscreen, never in the slide-over — see BoardFullscreen's own
    // doc-comment for why the panel was wrong for a canvas. Checked before the image
    // branch: `classifyReference` never marks a board `isImage`, but this keeps the
    // routing decision in one place rather than relying on that being true forever.
    if (ref.kind === 'board') { setBoardFull(path); return; }
    if (ref.isImage) {
      setLightbox({ src: agentFileUrl(vault, path, { raw: true }), caption: ref.label, path });
      return;
    }
    // A PDF is a document the window can DISPLAY, so it gets the image's treatment rather
    // than the panel's: full window, the engine's own viewer. The panel was actively wrong
    // for it — its text branch asks the JSON endpoint for a binary, which for any real PDF
    // answers "exceeds the preview size cap" and for a small one answers mojibake.
    if (ref.kind === 'pdf') { setPdf({ path, label: ref.label }); return; }
    setSlideOver({ mode: 'file', path });
  }, [vault]);
  const handleOpenBoard = useCallback((path: string) => setBoardFull(path), []);
  // The sub-agent card now also holds headless `claude` runs (see `isHeadlessAgentShell`),
  // and those are `local_bash` tasks: the CLI writes no sidechain transcript for them, so
  // `subagent` mode would open a panel about a file that is never going to exist. Their
  // drill-in is the SAME live-output panel the shells tray opens — which is also the only
  // surface offering them a Stop. Keyed off the task type rather than the headless test on
  // purpose: any `local_bash` run that reaches here belongs in shell mode.
  const handleDrillIn = useCallback((run: SubAgentRun) => (
    setSlideOver({ mode: run.taskType === 'local_bash' ? 'shell' : 'subagent', run })
  ), []);
  const handleOpenShell = useCallback((run: SubAgentRun) => setSlideOver({ mode: 'shell', run }), []);
  const handleStopShell = useCallback((run: SubAgentRun) => session.stopTask(run.taskId), [session]);
  const handleQuote = useCallback((text: string) => setQuote(convId, text), [convId]);
  const handleNavApp = useCallback((page: 'tasks' | 'knowledge' | 'core', id: string) => {
    setSlideOver(null);
    onOpenAppPage?.(page, id);
  }, [onOpenAppPage]);

  // ── The buttons an answer asked for (`dream-actions`). Every one of them lands on a
  //    surface this pane ALREADY owns — the slide-over, the lightbox, the app's navigation,
  //    the composer — so an answer can never reach further than the user already could by
  //    clicking around this same view. `ask` deliberately LOADS the composer instead of
  //    sending: the agent proposes the follow-up, the user still sends it. ────────────────
  const handleAction = useCallback((action: ChatAction) => {
    switch (action.action) {
      case 'task': case 'knowledge': case 'core':
        handleNavApp(action.action === 'task' ? 'tasks' : action.action, action.id!);
        break;
      case 'file': case 'board':
        handleOpenFile(action.path!);
        break;
      case 'reveal':
        // Never a dead button (owner report 07-28): if the OS wouldn't take it — gone, or a
        // path that escapes the project root — fall back to this pane's own file panel,
        // which SAYS why instead of the click going nowhere.
        void revealPath(api, action.path!).then((err) => { if (err) handleOpenFile(action.path!); });
        break;
      case 'ask':
        session.sendText(action.text!);
        session.focus();
        break;
      case 'url':
        void openExternalUrl(action.url!);
        break;
      case 'develop':
        // The Plan→Develop hand-off. The only action here that does not land on a surface
        // THIS pane owns — it closes this pane and opens another — so it is the surface's
        // call, not ours; we only forward the slug the plan agent named.
        onHandoffToDevelop(action.id!);
        break;
    }
  }, [handleNavApp, handleOpenFile, session, api, onHandoffToDevelop]);

  // ── Transcript pass: skip the spawning Agent/Task tool's OWN card (state 9 — it's
  //    already represented by ONE combined SubAgentCard, rendered at the position of the
  //    EARLIEST such tool item so it reads in-place rather than always trailing); swap a
  //    board-referencing tool item for the DRAWN board (BoardEmbed, state 4); render everything
  //    else through the shared ItemView dispatcher (state 2/11). ─────────────────────────
  //
  // `suppressedToolUseIds`, `inBypass` and the two run predicates this pass reads are declared
  // ABOVE the window section — the window measures itself in cards now, and it cannot ask what
  // a slice renders as without them.
  let subAgentCardShown = false;
  const itemNode = (item: ChatItem): React.ReactNode => {
    if (item.kind === 'tool') {
      if (suppressedToolUseIds.has(item.toolUseId)) {
        if (subAgentCardShown) return null; // already represented by the one combined card
        subAgentCardShown = true;
        return <SubAgentCard key={`subagents-${item.id}`} runs={conv.subAgents} peers={peers} onDrillIn={handleDrillIn} rootRef={setSubAgentCardEl} highlightRunId={jumped?.id ?? null} />;
      }
      // A tool that touched a board shows the BOARD, not a card about it — the same live
      // canvas an answer's own `![](x.excalidraw.md)` renders, so "I drew this" and "I
      // edited this" look alike. Only once the call has finished: a board mid-write is
      // half a scene.
      const path = primaryToolPath(item.input);
      if (path && classifyReference(path).kind === 'board' && item.status !== 'running') {
        return <BoardEmbed key={item.id} path={path} onOpenBoard={handleOpenBoard} />;
      }
    }
    const view = (
      <ItemView
        key={item.id}
        item={item}
        session={session}
        onOpenFile={handleOpenFile}
        onOpenBoard={handleOpenBoard}
        onAction={handleAction}
        conversationId={session.claudeId}
        onQuote={handleQuote}
      />
    );
    // Under bypass the CLI never asks — so the guarded commands it ran anyway get the
    // receipt a permission card would have been. Only the guarded ones: a notice on every
    // Bash call is noise, and noise is how a real one gets missed.
    if (item.kind === 'tool' && inBypass) {
      const command = bashCommand(item);
      if (command && isGuardedCommand(command)) {
        return (
          <Fragment key={item.id}>
            {view}
            <BypassNoticeCard command={command} toolName={item.name} />
          </Fragment>
        );
      }
    }
    return view;
  };

  // `stillAccruing` (see `toolRunPhase`) is true only for a run that is the LAST thing in the
  // live transcript while the turn is still going — i.e. the next tool call would join it.
  // The moment the agent emits its answer, that run stops being the tail and collapses.
  //
  // The KEY comes from `toolRunKeyItem` — the run edge the window cannot move — because a
  // reveal merges newly mounted older items into the head run. Keyed on the first item, that
  // merge was a key change: React remounted the card, the open toggle reset to the collapsed
  // first frame, every row node was rebuilt (so the anchor hold had nothing left to measure),
  // and "Show earlier messages" read as doing nothing at all (owner report 08-01, second
  // pass). See the helper's own doc for why the accruing tail keys off its head instead.
  const renderSegment = (seg: RunSegment<ChatItem>, isLastLive: boolean): React.ReactNode => {
    if (seg.kind === 'single') return itemNode(seg.item);
    const accruing = isLastLive && session.busy;
    return (
      <ToolRunCard
        key={`run-${toolRunKeyItem(seg.items, accruing).id}`}
        items={seg.items as ChatToolItem[]}
        stillAccruing={accruing}
        onOpenFile={handleOpenFile}
      />
    );
  };

  // Only the WINDOW is mapped — see the window section above. Everything older than
  // `firstShown` is not rendered at all (not hidden with CSS: not mounted), which is what
  // bounds this pane's DOM and its memory regardless of how long the conversation runs.
  // Segmentation happens INSIDE each windowed slice, so a run can never straddle the window
  // edge (revealing older entries would otherwise re-shape a group the reader is looking at)
  // nor the history/live boundary.
  const historySegments = segmentToolRuns(conv.history.slice(historyFrom), isPlainToolCard, MIN_TOOL_RUN, rendersNothing);
  const liveSegments = segmentToolRuns(conv.items.slice(itemsFrom), isPlainToolCard, MIN_TOOL_RUN, rendersNothing);
  const historyNodes = historySegments.map((seg) => renderSegment(seg, false));
  // The accruing tail is the last segment that SHOWS something, not the last segment. An
  // empty thinking block is re-emitted after the run it sat inside (see `segmentToolRuns`),
  // and by array position alone that invisible single would demote the live run from tail to
  // not-tail — collapsing the group to "N steps" mid-turn, which is exactly the flicker
  // `stillAccruing` exists to prevent.
  let liveTail = liveSegments.length - 1;
  while (liveTail >= 0) {
    const seg = liveSegments[liveTail];
    if (seg.kind === 'run' || !rendersNothing(seg.item)) break;
    liveTail -= 1;
  }
  const liveNodes = liveSegments.map((seg, i) => renderSegment(seg, i === liveTail));
  // A sub-agent run whose spawning tool call never appeared as its own ChatToolItem (an
  // edge case in raw frame ordering) still needs its card SOMEWHERE — append it once, after
  // the live transcript, rather than silently dropping the whole group. This ALSO covers the
  // case where the spawning tool item is simply older than the window: the group card falls
  // back to trailing the transcript instead of vanishing with the item that anchored it.
  const trailingSubAgentCard = !subAgentCardShown && conv.subAgents.length > 0
    ? <SubAgentCard key="subagents-trailing" runs={conv.subAgents} peers={peers} onDrillIn={handleDrillIn} rootRef={setSubAgentCardEl} highlightRunId={jumped?.id ?? null} />
    : null;

  // A real process exit (`meta-exit`) OR the WS having dropped — either way the composer
  // is replaced by the Session-ended banner (state 12); `status==='connecting'` never
  // reaches here (that's the ReconnectingChip's own condition, below).
  const ended = session.status === 'closed' || !!conv.exited;

  // Not signed in (chatProtocol's `auth-required`) — takes precedence over `ended`, because
  // when the CLI exits on a failed-auth turn "Session ended · Resume" would send the user
  // round the same loop forever. The missing credential is the real state to report.
  const needsSignIn = !!conv.authRequired;

  // The turn is in flight but the transcript has nothing to show for it yet — before the
  // CLI's first frame (spawn + SessionStart brain preload), or in a gap between a tool
  // result and the next block. Without this the pane looks idle while it is working.
  const working = !ended && session.busy
    && !turnHasVisibleProgress(conv.items, conv.pending.length);
  const isEmpty = !working
    && conv.history.length === 0 && conv.items.length === 0 && conv.pending.length === 0;

  const lastUserItem = [...conv.items].reverse().find((it): it is ChatUserItem => it.kind === 'user');

  // Sending is unambiguous intent to watch the answer, so it re-arms sticking: a reply that
  // streams in off-screen because you had scrolled up is a bug, not a feature. Keyed on the
  // newest user message instead of plumbed through the composer, so EVERY send path counts —
  // composer submit, retry, a dropped file's re-issue, a delegated prompt.
  const lastUserItemId = lastUserItem?.id;
  useLayoutEffect(() => {
    if (!lastUserItemId) return;
    setStick(true);
    scrollToBottom();
  }, [lastUserItemId, setStick, scrollToBottom]);

  // Stream-interrupted retry (state 12): resend the last user message. There is no
  // reconnect-and-resume machinery in this engine (see the plan's resolved risk) — for a
  // genuine process exit the Session-ended banner's Resume is the real recovery path;
  // this covers a `lastError` that leaves the session itself still open (a failed rewind/
  // model-switch, or a relay error the process survived).
  const retryLastMessage = () => {
    if (lastUserItem) session.send(lastUserItem.text);
  };

  return (
    <div className="chat-pane" ref={paneRef} data-status={session.status}>
      <ChatLiveRail session={session} taskSlug={taskSlug} />
      {session.status === 'connecting' && <ReconnectingChip />}
      <div className="chat-transcript">
        <div
          className="chat-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const metrics = {
              scrollTop: el.scrollTop,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              prevScrollTop: prevTopRef.current,
              userDriven: userDriving(),
            };
            setStick(nextStickToBottom(stickRef.current, metrics));
            restoreTopRef.current = nextRestoreTop(restoreTopRef.current, metrics);
            prevTopRef.current = el.scrollTop;
            syncRail();
            // The hold moves with the reader: wherever they have just come to rest is the new
            // "don't move me from here". A pinned view needs no hold — the bottom is its own
            // anchor, and `scrollToBottom` is what keeps it.
            //
            // SETTLE BEFORE RE-HOLDING, and that order is the entire correctness of this pair.
            // A scroll event is not proof that the reader moved: this pane's `scrollTop` is
            // written by the hold's own correction, by the re-home restore, and by the browser's
            // clamp when a block shrinks. Worse, scroll events are delivered BEFORE
            // ResizeObserver callbacks in the same frame — so a re-hold here always beats the
            // observer to any height change that has landed since the last correction, and
            // re-holding first would BAKE THAT CHANGE IN as though the reader had asked for it.
            // Measured, before this line was split in two: a reveal was corrected exactly, then
            // the post-paint decoration pass grew the entries above the fold by 478px, the
            // correction's own scroll event re-held at the new layout, and the observer that
            // followed found nothing left to fix — 478px of drift with a hold in place the
            // whole time. Settling first makes the re-hold a no-op in that case, which is
            // what it should have been.
            //
            // Cheap enough to do per event: both calls read rects on a scroller nothing has
            // mutated, so they cost no layout, and the settle writes nothing unless something
            // really moved.
            if (stickRef.current) heldAnchorRef.current = null;
            else { holdAnchorSteady(); captureAnchor(); }
            // Reading upwards past the window's ceiling extends it, so scrolling back
            // through a long conversation feels continuous rather than like hitting a wall.
            //
            // `userDriving()` is not optional here. This pane's `scrollTop` is written by
            // things that are not the user constantly — the re-home restore, a clamp when a
            // block shrinks, the pin's own re-assert — and several of those land at or near
            // 0. Without the gate, one of them would trip a reveal, whose prepend would
            // land near 0 again, and the whole conversation would unspool in a few frames:
            // exactly the unbounded mount this window exists to prevent.
            // …and NOT while the scrollbar thumb is held, which is the one gesture where the
            // correction cannot survive. Everything above assumes that writing `scrollTop` is
            // how the reader gets put back. During a drag it isn't: the browser keeps deriving
            // `scrollTop` from the THUMB, so it overwrites the hold's correction on the next
            // drag update and the view returns to where the thumb says — the top.
            //
            // Traced against the real dashboard on a 500-item transcript, thumb hauled slowly
            // upward. Each line is one frame; the arrow is the pane's own write:
            //
            //     rows=202 top=0     h=22569
            //     rows=242 top=6873  h=29720   reveal + correction (write 0->6873) — exact
            //     rows=242 top=6873  h=29720
            //     rows=242 top=0     h=29560   the DRAG puts it back. No JS write at all.
            //
            // and then the next event sees "near the ceiling, user driving" and reveals again:
            // 42 rows became 282 in one gesture, throwing the reader to the top each time.
            // That is the owner's report — the transcript teleporting while it loads history —
            // and it is why `userDriving()` alone was the wrong gate here. A drag is the most
            // unambiguous user gesture there is (which is exactly why it counts for unpinning)
            // and simultaneously the one state where our offset is not ours to set.
            //
            // So the reveal waits for the release, where `handlePointerDown` makes it. And
            // the wheel, keyboard and touch paths wait for QUIET, for the same reason with a
            // different animator: WKWebView trackpad momentum re-derives the offset from its
            // own decay curve exactly as the drag re-derives it from the thumb, so a reveal
            // paid for mid-momentum is a reveal undone — and re-tripped — per compositor
            // frame. A scroll event is never itself settled (it is the motion), so this
            // handler only ever ARMS the quiet timer; the reveal runs from `armSettledReveal`
            // once nothing has moved for SCROLL_SETTLE_MS. At rest the corrections were
            // measured landing exactly.
            //
            // The rule itself lives in `shouldAutoReveal` — this pane cannot be unit-tested
            // without a WebSocket, a document and a vault, and the drag + settle clauses are
            // the two things here that must never regress. `settled: true` below is not a
            // claim about NOW: it asks "would this event deserve a reveal once quiet?", and
            // arming re-checks the live conditions when the quiet actually arrives.
            if (shouldAutoReveal({
              hiddenCount, scrollTop: el.scrollTop,
              userDriven: metrics.userDriven, dragging: draggingRef.current,
              settled: true,
            })) {
              armSettledReveal();
            }
          }}
          onWheel={(e) => {
            const intent = wheelIntent(e.deltaY);
            markActivity();
            markIntent(intent);
            // The scroll handler can only arm a reveal if a scroll EVENT fires, and a window
            // folded into one collapsed run card can be shorter than the scroller — nothing
            // to scroll, no event, ever. Reading upward is the ask either way.
            armRevealFromInput(intent);
          }}
          onTouchStart={(e) => { touchYRef.current = e.touches[0]?.clientY ?? 0; }}
          onTouchMove={(e) => {
            markActivity();
            const y = e.touches[0]?.clientY ?? touchYRef.current;
            const intent = touchIntent(y - touchYRef.current);
            markIntent(intent);
            touchYRef.current = y;
            armRevealFromInput(intent);
          }}
          onPointerDown={handlePointerDown}
          onKeyDown={(e) => {
            const intent = keyIntent(e.key);
            if (intent) markActivity();
            markIntent(intent);
            armRevealFromInput(intent);
          }}
          onClick={(e) => {
            // Click-to-focus, mirroring how clicking anywhere in an xterm focuses its input:
            // without this a click on the transcript parks focus on <body>, killing the
            // surface-level ⌘D/⌘T/⌘W chords (they listen inside the overlay host). Text
            // selection and real controls keep working — only a plain click refocuses.
            if (!window.getSelection()?.isCollapsed) return;
            if ((e.target as Element).closest('button, select, textarea, input, a')) return;
            session.focus();
          }}
        >
          {/* One wrapper the ResizeObserver can watch: the scroller's own box never changes
              when its content grows, so content height needs an element of its own. */}
          <div className="chat-scroll-inner" ref={contentRef}>
            {/* First thing in the scroller, above even the window's ceiling button: it frames
                every item below it, including the replayed history, and a reader who meets
                the automation's brief before meeting this card has already misread it as
                their own message. Inside the scroller (not pinned) because it is read once,
                on arrival — pinning it would spend permanent transcript height on it. */}
            {automation && (
              <AutomationRunHeader
                run={automation}
                permissionMode={permissionMode}
                onOpenFile={handleOpenFile}
              />
            )}
            {isEmpty && <EmptyState />}
            {/* The window's ceiling, made visible and operable. Scrolling to the top does
                this for you (see the scroll handler); the button is what makes the omission
                honest for a reader who hasn't scrolled yet. */}
            {hiddenCount > 0 && (
              <button type="button" className="chat-window-more" onClick={revealEarlier}>
                ↑ Show earlier messages ({hiddenCount})
              </button>
            )}
            {showsHistory && (
              <>
                {historyNodes}
                <div className="chat-history-divider" aria-hidden>earlier conversation ↑ · resumed</div>
              </>
            )}
            {liveNodes}
            {trailingSubAgentCard}
            {conv.pending
              .filter((p): p is PendingPermission => p.kind === 'permission')
              .map((p) => <PermissionCard key={p.requestId} item={p} session={session} permissionMode={permissionMode} />)}
            {conv.pending
              .filter((p): p is PendingQuestion => p.kind === 'question')
              .map((p) => <SurveyCard key={p.requestId} item={p} session={session} />)}
            {conv.pending
              .filter((p): p is PendingPlan => p.kind === 'plan')
              .map((p) => <PlanCard key={p.requestId} item={p} session={session} />)}
            {askRouting?.phase === 'preparing' && <PreparingQuestionCard item={askRouting.item} />}
            {askRouting?.phase === 'degraded' && (
              <DegradedQuestionCard item={askRouting.item} onContinueInTerminal={onContinueInTerminal} />
            )}
            {/* D2's ask-and-exit HITL question, if this run stopped on one — scoped to
                THIS automation only (see AutomationQuestionSlot). Alongside the CLI's own
                pending cards above rather than inside AutomationRunHeader: both are "what
                is this conversation waiting on right now", and a question the run itself
                raised belongs in the same spot as one the CLI's own turn raised. */}
            {automation && <AutomationQuestionSlot automation={automation} onPendingChange={setHitlPending} />}
            {conv.branchNotice && (
              <BranchStartBanner
                tone={conv.branchNotice.tone}
                message={conv.branchNotice.message}
                onDismiss={session.dismissBranchNotice}
              />
            )}
            {conv.lastError && <StreamErrorBanner message={conv.lastError} onRetry={retryLastMessage} />}
            {working && (
              <WorkingIndicator
                label={session.opened ? 'Working…' : 'Starting Claude…'}
                startedAt={conv.turnStartedAt}
              />
            )}
          </div>
        </div>
        {/* Pinned OVER the transcript's top edge (never inside the scroller — see the
            "jump to latest" note above, which holds for the same reasons). It renders
            nothing at all unless a run is still going. */}
        {railPinned && (
          <SubAgentRail
            runs={conv.subAgents}
            peers={peers}
            onJump={jumpToSubAgent}
            onWheel={forwardWheelToTranscript}
          />
        )}
        {!pinned && (
          <button
            type="button"
            className="chat-jump"
            onClick={() => { setStick(true); scrollToBottom(); }}
          >
            <span aria-hidden>↓</span> Latest
          </button>
        )}
      </div>
      {/* Docked above the composer, OUTSIDE the scroller: a background shell outlives the
          turn that started it, so its row must not scroll away while the process runs. Shown
          even when the session has ended — a shell dies with the CLI process, and its last
          output is still what the user wants to read. */}
      <BackgroundShellsTray
        runs={conv.subAgents}
        onOpen={handleOpenShell}
        onStop={handleStopShell}
      />
      {/* Live peer sessions, docked with the rows above for the same reason: a session in
          another project can be sitting blocked on a permission prompt, and a blocking row
          that scrolls out of view is a session that hangs for reasons the user cannot see.
          Each holder renders one clickable line here and owns its own side panel. */}
      {peerSessions.map((p) => (
        <PeerSessionHolder
          key={p.key}
          peer={p.peer}
          prompt={p.prompt}
          // The peer's panel mounts the REAL Composer, so it needs the same model/effort
          // wiring this pane's own composer has. Passed as one object rather than six props
          // because it is one thing: the chrome a chat needs to be a chat.
          chrome={{ modelConfig, model, effort, onModelChange, onEffortChange, onSignIn }}
          onClose={() => setPeerSessions((list) => list.filter((x) => x.key !== p.key))}
        />
      ))}
      {/* Nearest the composer, and OUTSIDE the needsSignIn/ended branch below on purpose: these
          rows are the only copy of text the user has already committed to sending, so they must
          survive the composer being replaced by a banner (see QueuedMessages.tsx). */}
      <QueuedMessages session={session} />
      {/* The pinned shelf, docked to the composer's TOP EDGE — and, like the two rows above
          it, OUTSIDE `.chat-transcript`. That placement is the whole mechanism behind its
          defining property: it is not a child of the scroller, so scrolling to the top of a
          long conversation and back cannot move it, hide it, or resize it. It renders nothing
          at all when it holds nothing (no zero-height strip), and one bare tag line at rest.
          `shelved` is the same question as the shell's own `has-rows`, which is why it comes
          off the shelf handle rather than being computed twice. */}
      <PinShelf shelf={shelf} onOpenUrl={openExternalUrl} />
      {needsSignIn ? (
        <SignInBanner
          canSignInInApp={canSignInInApp}
          command={signInCommand}
          onSignIn={onSignIn}
          onRetry={onResume}
        />
      ) : ended ? (
        <SessionEndedBanner onResume={onResume} />
      ) : hitlPending ? (
        // AFTER `ended` on purpose: an ended session has nothing live to type into, so
        // there is no bypass to close and "Resume" is still the right offer. This branch
        // only fires while the resumed run is actually live.
        <AutomationQuestionComposerLock />
      ) : (
        <Composer
          session={session}
          model={model}
          effort={effort}
          modelConfig={modelConfig}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          busy={session.busy}
          connected={session.status === 'open'}
          quote={replyQuote}
          onClearQuote={() => setQuote(convId, null)}
          // THIS SESSION's permission mode, not the project's remembered default (the
          // `permissionMode` prop). `inBypass` is what the CLI itself reported — the init
          // frame, or a successful mid-session `set_permission_mode` — and the two genuinely
          // diverge: a Plan→Develop hand-off is forced to `auto` inside a project whose
          // remembered default is `bypass`, so passing the prop straight through would print
          // "bypass" over a process running `--permission-mode auto`. A security indicator
          // that can disagree with the running process is worse than no indicator, so the
          // trigger and the mode menu's segment both read the session's own truth.
          // `onPermissionModeChange` is unchanged and still the PROJECT-wide setter: changing
          // it pushes `set_permission_mode` into every live chat, whose ack moves
          // `conv.permissionMode` — so the display follows the write rather than predicting it.
          //
          // Which leaves one control READING per-session and WRITING per-project. That
          // asymmetry is deliberate on both ends — the display must be this session's truth,
          // and the write must stay project-wide because this segment is the vault default's
          // ONLY control — so the fix is to NAME both scopes rather than to merge them or to
          // add a second control (which the menu's no-set-default rule forbids). The remembered
          // value goes down beside the session's, and the menu's note states the scope.
          permissionMode={inBypass ? 'bypass' : 'auto'}
          projectPermissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          mode={mode}
          onModeChange={onModeChange}
          // One object, not two cards: whenever the shelf grows a bordered shell above the
          // composer, the composer squares the corners it would otherwise round against it.
          shelved={shelf.hasRows}
          onSignIn={onSignIn}
          // `@acme-payments …` opens a live session in that project instead of sending here — see
          // the peerSessions note above and PeerSessionCard.
          onPeerMessage={(peer, body) => {
            peerKeyRef.current += 1;
            setPeerSessions((list) => [...list, { key: peerKeyRef.current, peer, prompt: body }]);
          }}
          // No task-picker mechanism exists anywhere in this codebase yet (there is no
          // native "pick a task" dialog — TasksPage has no picker widget to open). The
          // button stays visible (Composer.tsx is frozen T6 ownership; it has no gate to
          // omit it) but is inert until one is built.
          onOpenTaskPicker={() => {}}
        />
      )}
      {slideOver?.mode === 'file' && (
        <SlideOver
          mode="file"
          path={slideOver.path}
          reference={classifyReference(slideOver.path)}
          onClose={() => setSlideOver(null)}
          onNavApp={handleNavApp}
          // A row of a folder's listing goes back through the pane's own routing, so a
          // subfolder re-opens this panel and a picture still lands in the lightbox.
          onOpenPath={handleOpenFile}
        />
      )}
      {slideOver?.mode === 'subagent' && (
        <SlideOver
          mode="subagent"
          // Re-read from the LIVE model (same rule as shell mode below) so the drill-in's
          // status chip, its refetch-on-finish and its follow-the-stream behavior track the
          // run instead of freezing at the click-time snapshot.
          run={conv.subAgents.find((r) => r.taskId === slideOver.run.taskId) ?? slideOver.run}
          conversationId={session.claudeId}
          peers={peers}
          onClose={() => setSlideOver(null)}
          onNavApp={handleNavApp}
        />
      )}
      {slideOver?.mode === 'shell' && (
        <SlideOver
          mode="shell"
          // Re-read from the LIVE model rather than the captured click-time snapshot, so the
          // panel's status/summary (and therefore its polling and its Stop button) follow the
          // run as it finishes instead of freezing at whatever it was when opened.
          run={conv.subAgents.find((r) => r.taskId === slideOver.run.taskId) ?? slideOver.run}
          conversationId={session.claudeId}
          onStop={handleStopShell}
          onClose={() => setSlideOver(null)}
          onNavApp={handleNavApp}
        />
      )}
      {lightbox && (
        <Lightbox
          src={lightbox.src}
          caption={lightbox.caption}
          // Only a picture opened from a REFERENCE carries a path, and only that one can be
          // handed to the OS. An inline `<img>` the transcript built from a URL has no file
          // behind it, and a Finder button for it would open nothing.
          path={lightbox.path}
          onClose={() => setLightbox(null)}
        />
      )}
      {pdf && <PdfViewer path={pdf.path} label={pdf.label} onClose={() => setPdf(null)} />}
      {boardFull && <BoardFullscreen path={boardFull} onClose={() => setBoardFull(null)} />}
    </div>
  );
}
