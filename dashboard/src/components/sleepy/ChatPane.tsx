import { Fragment, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { GoalLivePanel } from './GoalLivePanel';
import { CouncilLivePanel } from './CouncilLivePanel';
import { api, agentFileUrl } from '../../api/client';
import type { ModelConfig } from '../../lib/agentComposer';
import {
  classifyReference, subAgentToolUseIds, isGuardedCommand, turnHasVisibleProgress,
  nextStickToBottom, nextRestoreTop, isAtBottom, wheelIntent, keyIntent, touchIntent,
  nextFirstShown, splitWindow, revealScrollCorrection, WINDOW_REVEAL_PX,
  type SubAgentRun, type ScrollIntent,
} from './chat/chatEntities';
import { ItemView } from './chat/TranscriptItem';
import { SurveyCard } from './chat/SurveyCard';
import { PermissionCard } from './chat/PermissionCard';
import { PlanCard } from './chat/PlanCard';
import { BypassNoticeCard } from './chat/BypassNoticeCard';
import { SubAgentCard, SubAgentRail } from './chat/SubAgentCard';
import { BackgroundShellsTray } from './chat/BackgroundShellsTray';
import { QueuedMessages } from './chat/QueuedMessages';
import { SlideOver } from './chat/SlideOver';
import { Lightbox } from './chat/Lightbox';
import { BoardEmbed, BoardFullscreen } from './chat/BoardEmbed';
import type { ChatAction } from './chat/chatActions';
import { openExternalUrl } from '../../lib/desktop';
import {
  EmptyState, StreamErrorBanner, ReconnectingChip, SessionEndedBanner, SignInBanner, WorkingIndicator,
} from './chat/Banners';
import { Composer } from './chat/Composer';
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

const WATCHDOG_MS = 4000;

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

/** Linked-task chip + objectives data, fetched only when `taskSlug` is supplied. Beta ships
 *  no caller that ever sets `taskSlug` (Task Manager sessions stay `kind:'agent'`), so this
 *  hook is a built-but-dormant mechanism in this release. */
function useTaskLink(taskSlug?: string): TaskLinkInfo | null {
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
  }, [taskSlug]);
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

// ─── Degraded AskUserQuestion card (AC5's capability-detection safety net) ─────────
//
// Not one of the 12 design states — a fallback for a future CLI regression, kept from
// the pre-redesign ChatPane verbatim (the spike PROVED headless routing works on
// 2.1.218; this only ever fires if a later CLI breaks it). Styled locally since it
// isn't one of T5's card components.

/**
 * Watches for an `AskUserQuestion` tool call that never surfaced a matching `question`
 * control_request within {@link WATCHDOG_MS}. Cleared the moment a real pending question
 * arrives, or the tool card itself resolves (answered some other way, or errored).
 */
function useAskQuestionWatchdog(items: ChatItem[], hasPendingQuestion: boolean): ChatToolItem | null {
  const [stuck, setStuck] = useState<ChatToolItem | null>(null);
  useEffect(() => {
    const running = [...items].reverse().find(
      (it): it is ChatToolItem => it.kind === 'tool' && it.name === 'AskUserQuestion' && it.status === 'running',
    ) ?? null;
    if (!running || hasPendingQuestion) { setStuck(null); return; }
    const elapsed = Date.now() - running.startedAt;
    if (elapsed >= WATCHDOG_MS) { setStuck(running); return; }
    const t = setTimeout(() => setStuck(running), WATCHDOG_MS - elapsed);
    return () => clearTimeout(t);
  }, [items, hasPendingQuestion]);
  return stuck;
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

// ─── View-only state for the two overlay surfaces (state 3/9's slide-over, state 4's
//    lightbox) + the composer's queued quote (state 11). Every OTHER piece of state
//    this pane renders from lives in `session.getModel()` — this is purely presentation. ──

type SlideOverState =
  | { mode: 'file'; path: string }
  | { mode: 'subagent'; run: SubAgentRun }
  /** A background shell's live output — a separate mode from `subagent` because a shell has
   *  no sidechain transcript to render; it has an output file and a stop action. */
  | { mode: 'shell'; run: SubAgentRun }
  | null;

interface LightboxState { src: string; caption?: string }

// ─── Top level ──────────────────────────────────────────────────────────────────────

export function ChatPane({
  session, modelConfig, model, effort, onModelChange, onEffortChange, taskSlug, onContinueInTerminal,
  permissionMode, onPermissionModeChange, onResume, onOpenAppPage, onSignIn, canSignInInApp,
  signInCommand,
}: {
  session: ChatSession;
  modelConfig: ModelConfig;
  model: string;
  effort: string;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  /** Task Manager sessions are `kind:'agent'` in beta (no caller ever sets this yet — the
   *  ChatLiveRail's task chip is built and dormant). */
  taskSlug?: string;
  onContinueInTerminal: () => void;
  /** The REMEMBERED permission-mode default (`agentSettings.chatPermissionMode`) — the
   *  `bypass` dropdown, which now leads the COMPOSER's toolbar (owner reference 07-25)
   *  rather than floating at the pane's top-right. Changing it applies from the next chat
   *  session (AgentSurface's `spawn()` resolves a chat's actual bypass from this
   *  centrally); this pane only passes the current value down and reports a change. */
  permissionMode: 'auto' | 'bypass';
  onPermissionModeChange: (mode: 'auto' | 'bypass') => void;
  /** Respawn this exact conversation UUID as a fresh chat session (state 12's "Session
   *  ended" banner, which REPLACES the composer). */
  onResume: () => void;
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

  const conv = session.getModel();
  const hasPendingQuestion = conv.pending.some((p) => p.kind === 'question');
  const stuckQuestion = useAskQuestionWatchdog(conv.items, hasPendingQuestion);

  const [slideOver, setSlideOver] = useState<SlideOverState>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  /** A board opened genuinely fullscreen (§1.7) — the ONLY overlay a board ever renders in
   *  now. Owned here, not by `SlideOver`, because a board has four entry points spread
   *  across this file, `BoardEmbed` and `TranscriptItem`, and a single owner is what makes
   *  all four converge on the same overlay instead of drifting back apart. */
  const [boardFull, setBoardFull] = useState<string | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);

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
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
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
  const [firstShownState, setFirstShownState] = useState(0);
  const windowTotal = conv.history.length + conv.items.length;
  const firstShown = nextFirstShown(firstShownState, { total: windowTotal, pinned: stickRef.current });
  if (firstShown !== firstShownState) setFirstShownState(firstShown);
  const { hiddenCount, historyFrom, itemsFrom, showsHistory } = splitWindow(
    conv.history.length, conv.items.length, firstShown,
  );

  /** What a pending reveal captured to measure itself against: the rows it is about to push
   *  down, nearest the reader first, plus a last-resort total height. `null` = the next
   *  window change is not a reveal, so nothing should be compensated for it. */
  const preRevealAnchorRef = useRef<
    { candidates: Array<{ node: Element; top: number }>; scrollHeight: number } | null
  >(null);

  const revealEarlier = useCallback(() => {
    const next = nextFirstShown(firstShown, { total: windowTotal, pinned: false, reveal: true });
    // Nothing left to reveal → don't arm the compensation, or the NEXT window change (a
    // pinned slide) would be handed a stale anchor to correct against.
    if (next === firstShown) return;
    // Asking for older messages is explicit intent to go and read them — so it releases
    // stick-to-bottom. Without this the render below would re-normalize under the pinned
    // rule and slide the window straight back to the tail, making the button do nothing.
    setStick(false);
    const el = scrollRef.current;
    const inner = contentRef.current;
    if (!el || !inner) { preRevealAnchorRef.current = null; setFirstShownState(next); return; }
    // SEVERAL candidate anchors, not one, and only rows the reader can actually see.
    //
    // Visible, because holding still a row that is above the fold is not the same as holding
    // the VIEW still: a block between it and the viewport can grow a line in the same commit
    // while a turn streams, and the reader would drift by that. Whatever a visible row moves
    // by is, by definition, what the reader experiences.
    //
    // Several, because one of these nodes can be REPLACED rather than moved by the very
    // reveal being measured. Ordinary rows are keyed by `item.id` and survive a prepend, but
    // the one combined `SubAgentCard` is keyed by the EARLIEST suppressed tool item in the
    // window — so a reveal that mounts an older fan-out migrates its key, React unmounts the
    // card, and an anchor that happened to BE that card would leave the correction with
    // nothing to measure and the reader jumped by the whole prepend. The spares make that
    // unreachable without this code having to know anything about SubAgentCard.
    const fold = el.getBoundingClientRect().top;
    const candidates: Array<{ node: Element; top: number }> = [];
    for (const node of Array.from(inner.children)) {
      if (node.classList.contains('chat-window-more')) continue;
      if (node.getBoundingClientRect().bottom <= fold) continue;
      candidates.push({ node, top: contentTopOf(node, el) });
      if (candidates.length >= ANCHOR_CANDIDATES) break;
    }
    preRevealAnchorRef.current = { candidates, scrollHeight: el.scrollHeight };
    setFirstShownState(next);
  }, [firstShown, windowTotal, setStick]);

  // Scroll anchoring for a PREPEND. Revealing older entries inserts content ABOVE the
  // reader, which moves everything they were looking at down the scroller by exactly the
  // height of what was inserted — so `scrollTop` is pushed back by the same amount, here, in
  // a LAYOUT effect: after React has mutated the DOM (so the anchor's new position is the
  // real one) and before the browser paints (so no intermediate position is ever seen).
  //
  // Measured off an ANCHOR ROW, not off `scrollHeight`. A reveal is triggered from a scroll
  // handler while a turn may still be streaming, so React can merge the window change and an
  // arriving frame into ONE commit — prepending 40 entries above the reader AND appending a
  // materializing tool card below them. `scrollHeight` grew by both; correcting by that sum
  // would scroll the reader down by the append's height too. See `revealScrollCorrection`.
  // Any of the captured rows will do: they all sit below the prepend, so they all move by
  // the same amount, which is why the spares can stand in for a replaced first choice.
  //
  // `prevTopRef`/`restoreTopRef` are updated in the same breath, and that ordering is the
  // point: the compensating write dispatches its own scroll event, and a handler that saw
  // the OLD `prevScrollTop` would read this as a large downward jump. Writing them here
  // means the handler sees a consistent pair. (It moves the view DOWN, so
  // `nextStickToBottom`'s rule 3 can't misread it as the user leaving either way — but
  // `nextRestoreTop` would happily record the un-compensated offset as the reading position.)
  useLayoutEffect(() => {
    const pending = preRevealAnchorRef.current;
    preRevealAnchorRef.current = null;
    if (!pending) return;
    const el = scrollRef.current;
    if (!el || el.clientHeight === 0) return;
    const anchor = pending.candidates.find((c) => c.node.isConnected);
    const delta = anchor
      ? revealScrollCorrection({
        anchorTopBefore: anchor.top,
        anchorTopAfter: contentTopOf(anchor.node, el),
      })
      // Nothing the reader was looking at survived the commit — a rewind truncating the
      // transcript underneath the reveal. Total height is the WRONG measure (a streamed
      // append lands in it too, which is the whole reason for the anchors) but being off by
      // one card beats being off by the entire prepend, which is what doing nothing costs.
      : revealScrollCorrection({ anchorTopBefore: pending.scrollHeight, anchorTopAfter: el.scrollHeight });
    if (delta <= 0) return;
    el.scrollTop += delta;
    prevTopRef.current = el.scrollTop;
    restoreTopRef.current = el.scrollTop;
  }, [firstShown]);

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
    markIntent(wheelIntent(e.deltaY));
    el.scrollTop += e.deltaY * step;
  }, [markIntent]);

  // Height changes React never rendered: an image or clip finishing its load, a tool card
  // expanding, the composer growing a line (which SHRINKS the scroller), a split or window
  // resize, and the container being re-homed into another pane's slot — a re-parent resets
  // `scrollTop` to 0, which is the "splitting jumped the transcript to the top" symptom.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) scrollToBottom();
      // Content growing ABOVE an unpinned view moves the card without a scroll event of
      // its own — the rail would otherwise still be showing a card that is back in view.
      syncRailRef.current();
    });
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

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
      else if (el && el.clientHeight > 0 && el.scrollTop !== restoreTopRef.current) {
        el.scrollTop = restoreTopRef.current;
        prevTopRef.current = el.scrollTop;
      }
      syncRail();
    });
    return () => session.setTranscriptRepin(null);
  }, [session, scrollToBottom, syncRail]);

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
      setLightbox({ src: agentFileUrl(path, { raw: true }), caption: ref.label });
      return;
    }
    setSlideOver({ mode: 'file', path });
  }, []);
  const handleOpenBoard = useCallback((path: string) => setBoardFull(path), []);
  const handleDrillIn = useCallback((run: SubAgentRun) => setSlideOver({ mode: 'subagent', run }), []);
  const handleOpenShell = useCallback((run: SubAgentRun) => setSlideOver({ mode: 'shell', run }), []);
  const handleStopShell = useCallback((run: SubAgentRun) => session.stopTask(run.taskId), [session]);
  const handleQuote = useCallback((text: string) => setReplyQuote(text), []);
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
        void api.post('/agent/reveal', { path: action.path }).catch(() => { /* not desktop, or gone */ });
        break;
      case 'ask':
        session.sendText(action.text!);
        session.focus();
        break;
      case 'url':
        void openExternalUrl(action.url!);
        break;
    }
  }, [handleNavApp, handleOpenFile, session]);

  // ── Transcript pass: skip the spawning Agent/Task tool's OWN card (state 9 — it's
  //    already represented by ONE combined SubAgentCard, rendered at the position of the
  //    EARLIEST such tool item so it reads in-place rather than always trailing); swap a
  //    board-referencing tool item for the DRAWN board (BoardEmbed, state 4); render everything
  //    else through the shared ItemView dispatcher (state 2/11). ─────────────────────────
  const suppressedToolUseIds = subAgentToolUseIds(conv.subAgents);
  // The mode this conversation is ACTUALLY running in, as the CLI itself reported it
  // (init frame, or a successful mid-session `set_permission_mode`) — NOT the remembered
  // `permissionMode` prop, which is only the default for the NEXT session and would
  // mislabel a session the user switched after it started.
  const inBypass = conv.permissionMode ? conv.permissionMode === 'bypassPermissions' : session.bypass;
  let subAgentCardShown = false;
  const itemNode = (item: ChatItem): React.ReactNode => {
    if (item.kind === 'tool') {
      if (suppressedToolUseIds.has(item.toolUseId)) {
        if (subAgentCardShown) return null; // already represented by the one combined card
        subAgentCardShown = true;
        return <SubAgentCard key={`subagents-${item.id}`} runs={conv.subAgents} onDrillIn={handleDrillIn} rootRef={setSubAgentCardEl} highlightRunId={jumped?.id ?? null} />;
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

  // Only the WINDOW is mapped — see the window section above. Everything older than
  // `firstShown` is not rendered at all (not hidden with CSS: not mounted), which is what
  // bounds this pane's DOM and its memory regardless of how long the conversation runs.
  const historyNodes = conv.history.slice(historyFrom).map(itemNode);
  const liveNodes = conv.items.slice(itemsFrom).map(itemNode);
  // A sub-agent run whose spawning tool call never appeared as its own ChatToolItem (an
  // edge case in raw frame ordering) still needs its card SOMEWHERE — append it once, after
  // the live transcript, rather than silently dropping the whole group. This ALSO covers the
  // case where the spawning tool item is simply older than the window: the group card falls
  // back to trailing the transcript instead of vanishing with the item that anchored it.
  const trailingSubAgentCard = !subAgentCardShown && conv.subAgents.length > 0
    ? <SubAgentCard key="subagents-trailing" runs={conv.subAgents} onDrillIn={handleDrillIn} rootRef={setSubAgentCardEl} highlightRunId={jumped?.id ?? null} />
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
            // Reading upwards past the window's ceiling extends it, so scrolling back
            // through a long conversation feels continuous rather than like hitting a wall.
            //
            // `userDriving()` is not optional here. This pane's `scrollTop` is written by
            // things that are not the user constantly — the re-home restore, a clamp when a
            // block shrinks, the pin's own re-assert — and several of those land at or near
            // 0. Without the gate, one of them would trip a reveal, whose prepend would
            // land near 0 again, and the whole conversation would unspool in a few frames:
            // exactly the unbounded mount this window exists to prevent.
            if (hiddenCount > 0 && el.scrollTop < WINDOW_REVEAL_PX && metrics.userDriven) {
              revealEarlier();
            }
          }}
          onWheel={(e) => markIntent(wheelIntent(e.deltaY))}
          onTouchStart={(e) => { touchYRef.current = e.touches[0]?.clientY ?? 0; }}
          onTouchMove={(e) => {
            const y = e.touches[0]?.clientY ?? touchYRef.current;
            markIntent(touchIntent(y - touchYRef.current));
            touchYRef.current = y;
          }}
          onPointerDown={handlePointerDown}
          onKeyDown={(e) => markIntent(keyIntent(e.key))}
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
            {stuckQuestion && <DegradedQuestionCard item={stuckQuestion} onContinueInTerminal={onContinueInTerminal} />}
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
      {/* Nearest the composer, and OUTSIDE the needsSignIn/ended branch below on purpose: these
          rows are the only copy of text the user has already committed to sending, so they must
          survive the composer being replaced by a banner (see QueuedMessages.tsx). */}
      <QueuedMessages session={session} />
      {needsSignIn ? (
        <SignInBanner
          canSignInInApp={canSignInInApp}
          command={signInCommand}
          onSignIn={onSignIn}
          onRetry={onResume}
        />
      ) : ended ? (
        <SessionEndedBanner onResume={onResume} />
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
          onClearQuote={() => setReplyQuote(null)}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          onSignIn={onSignIn}
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
          run={slideOver.run}
          conversationId={session.claudeId}
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
      {lightbox && <Lightbox src={lightbox.src} caption={lightbox.caption} onClose={() => setLightbox(null)} />}
      {boardFull && <BoardFullscreen path={boardFull} onClose={() => setBoardFull(null)} />}
    </div>
  );
}
