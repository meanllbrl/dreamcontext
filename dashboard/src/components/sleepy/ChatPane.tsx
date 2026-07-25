import { Fragment, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { GoalLivePanel } from './GoalLivePanel';
import { CouncilLivePanel } from './CouncilLivePanel';
import { api } from '../../api/client';
import type { ModelConfig } from '../../lib/agentComposer';
import {
  classifyReference, subAgentToolUseIds, isGuardedCommand, turnHasVisibleProgress,
  nextStickToBottom, type SubAgentRun,
} from './chat/chatEntities';
import { ItemView } from './chat/TranscriptItem';
import { SurveyCard } from './chat/SurveyCard';
import { PermissionCard } from './chat/PermissionCard';
import { BypassNoticeCard } from './chat/BypassNoticeCard';
import { SubAgentCard, SubAgentRail } from './chat/SubAgentCard';
import { BackgroundShellsTray } from './chat/BackgroundShellsTray';
import { SlideOver } from './chat/SlideOver';
import { Lightbox } from './chat/Lightbox';
import { BoardEmbed } from './chat/BoardEmbed';
import type { ChatAction } from './chat/chatActions';
import {
  EmptyState, StreamErrorBanner, ReconnectingChip, SessionEndedBanner, SignInBanner, WorkingIndicator,
} from './chat/Banners';
import { Composer } from './chat/Composer';
import './chat/cards.css';
import './chat/overlays.css';
import type {
  ChatSession, ChatItem, ChatUserItem, ChatToolItem, PendingPermission, PendingQuestion,
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

/** Keys that scroll the transcript — the keyboard half of "the user is driving" (see the
 *  gesture window in ChatPane). Space is deliberately absent: it only scrolls a focused
 *  scroller, and every Space that reaches this pane is being typed into the composer. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/** How long a gesture keeps ownership of the scroller. Covers the frame or two between the
 *  gesture and the scroll it produces, plus the gaps inside trackpad momentum (which keeps
 *  emitting wheel events that refresh it). */
const GESTURE_MS = 500;

/** How far below the transcript's top edge a rail jump parks its target — the pinned rail's
 *  own height plus its top offset plus a little air, so the row it scrolled to lands just
 *  under the rail instead of behind it. */
const RAIL_CLEARANCE = 64;

/** How long a jumped-to sub-agent row stays flashed. */
const FLASH_MS = 1600;

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
  const [replyQuote, setReplyQuote] = useState<string | null>(null);

  // ── Transcript scroll: one scroller, one session, one stick-to-bottom state ──────────
  //
  // Every mounted ChatPane re-renders whenever AgentSurface re-renders — which happens on
  // ANY session's busy/asking edge — so a scroll write that ran "after every render" meant
  // sending a message in one chat yanked its split neighbour's transcript around (owner
  // report 07-25). The auto-scroll below therefore keys on this session's CONVERSATION MODEL
  // identity: `conv` is a fresh object on every event THIS session applied, and the same
  // object for every render caused by anything else.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  /** `scrollTop` at the last scroll event — the direction signal `nextStickToBottom` reads. */
  const prevTopRef = useRef(0);
  /** When the user last drove this scroller — the other half of that signal. See below. */
  const gestureAtRef = useRef(-Infinity);
  /** A scrollbar drag holds the gesture open: its scroll events span the whole press. */
  const draggingRef = useRef(false);
  /** Render mirror of `stickRef`, for the "jump to latest" affordance only. */
  const [pinned, setPinned] = useState(true);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    // A minimized pane's container is parked in the detached garage: it measures 0 and
    // cannot be scrolled. The observer below re-runs this the moment it is re-homed.
    if (!el || el.clientHeight === 0) return;
    el.scrollTop = el.scrollHeight;
    prevTopRef.current = el.scrollTop;
  }, []);

  const setStick = useCallback((next: boolean) => {
    stickRef.current = next;
    setPinned((prev) => (prev === next ? prev : next));
  }, []);

  // A scroll event carries no hint of what caused it, and the transcript is a surface whose
  // content moves on its own constantly — so `nextStickToBottom` is told, per event, whether
  // the user is at the wheel. Outside a live gesture nothing may unpin the view.
  const markGesture = useCallback(() => { gestureAtRef.current = performance.now(); }, []);
  const userDriving = () => draggingRef.current || performance.now() - gestureAtRef.current < GESTURE_MS;

  // Pressing the scrollbar gutter is a scroll gesture; pressing a card is not — clicking one
  // open changes the content height, and counting that as "the user scrolled" would unpin
  // the view on a click that never touched the scrollbar.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (e.clientX - el.getBoundingClientRect().left <= el.clientWidth) return;
    draggingRef.current = true;
    markGesture();
    const release = () => {
      draggingRef.current = false;
      markGesture();
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  };

  useEffect(() => { if (stickRef.current) scrollToBottom(); }, [conv, scrollToBottom]);

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
    markGesture();
    el.scrollTop += e.deltaY * step;
  }, [markGesture]);

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
      syncRail();
    });
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom, syncRail]);

  // ── State 3/4: a clicked file reference either opens the Lightbox (an image) or the
  //    file SlideOver (everything else, including a board — no rasterizer exists, so a
  //    board's "Open board ↗" degrades to the same numbered text preview; see chatEntities'
  //    Reference/classifyReference and the plan's board-thumbnail resolution). ──────────
  const handleOpenFile = (path: string) => {
    const ref = classifyReference(path);
    if (ref.isImage) {
      setLightbox({ src: `/api/agent/file?path=${encodeURIComponent(path)}&raw=1`, caption: ref.label });
      return;
    }
    setSlideOver({ mode: 'file', path });
  };
  const handleOpenBoard = (path: string) => setSlideOver({ mode: 'file', path });
  const handleDrillIn = (run: SubAgentRun) => setSlideOver({ mode: 'subagent', run });
  const handleOpenShell = (run: SubAgentRun) => setSlideOver({ mode: 'shell', run });
  const handleStopShell = (run: SubAgentRun) => session.stopTask(run.taskId);
  const handleNavApp = (page: 'tasks' | 'knowledge' | 'core', id: string) => {
    setSlideOver(null);
    onOpenAppPage?.(page, id);
  };

  // ── The buttons an answer asked for (`dream-actions`). Every one of them lands on a
  //    surface this pane ALREADY owns — the slide-over, the lightbox, the app's navigation,
  //    the composer — so an answer can never reach further than the user already could by
  //    clicking around this same view. `ask` deliberately LOADS the composer instead of
  //    sending: the agent proposes the follow-up, the user still sends it. ────────────────
  const handleAction = (action: ChatAction) => {
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
    }
  };

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
        onQuote={(text) => setReplyQuote(text)}
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

  const historyNodes = conv.history.map(itemNode);
  const liveNodes = conv.items.map(itemNode);
  // A sub-agent run whose spawning tool call never appeared as its own ChatToolItem (an
  // edge case in raw frame ordering) still needs its card SOMEWHERE — append it once, after
  // the live transcript, rather than silently dropping the whole group.
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
  useEffect(() => {
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
    <div className="chat-pane" data-status={session.status}>
      <ChatLiveRail session={session} taskSlug={taskSlug} />
      {session.status === 'connecting' && <ReconnectingChip />}
      <div className="chat-transcript">
        <div
          className="chat-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setStick(nextStickToBottom(stickRef.current, {
              scrollTop: el.scrollTop,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              prevScrollTop: prevTopRef.current,
              userDriven: userDriving(),
            }));
            prevTopRef.current = el.scrollTop;
            syncRail();
          }}
          onWheel={markGesture}
          onTouchMove={markGesture}
          onPointerDown={handlePointerDown}
          onKeyDown={(e) => { if (SCROLL_KEYS.has(e.key)) markGesture(); }}
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
            {conv.history.length > 0 && (
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
    </div>
  );
}
