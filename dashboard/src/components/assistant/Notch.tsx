import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ChatPaneHost, type ChatSurfaceActions } from '../sleepy/ChatPaneHost';
import { createChatSession, type ChatSession, type NotchPresentation } from '../sleepy/chatSession';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG, quotePath } from '../../lib/agentComposer';
import { uploadAgentFile } from '../../lib/agentDrop';
import { isDesktop, pickerOpen } from '../../lib/desktop';
import { frameMotionMs, setFrames, type FrameItem, type MinPreset } from '../../lib/windowFrames';
import { claimSeat, flying, guardHeal, isCurrentSeat, setSeatWindow, wantSeat, withFlight, type SeatFrame } from './seatGuard';
import { executeAssistantCommand, onAssistantNotify } from './commandExecutor';
import { ProposalList, decide, type Proposal } from './ProposalList';
import { GlanceList, HandoffList, answerPermission, dismissHandoff } from './GlanceList';
import { ConversationMenu } from './ConversationMenu';
import { NotchPeek, peekItem, type PeekItem } from './NotchPeek';
import { AgentAvatar, InboxList } from './InboxList';
import { ListeningOverlay } from './ListeningOverlay';
import {
  EMPTY_INBOX, EMPTY_ROLLUP, assistantActivityLine, enqueuePeeks, handoffPhase, notchMood, pillBubbles, pillHeadline, pillLabel,
  readGlance, readHandoffs, readInbox, readRollup, recentFinishedVault, runKey,
  type ActivityItem, type GlanceChat, type Handoff, type Inbox, type Rollup,
} from './notchModel';
import { readingTimeMs } from '../../lib/notchCue';
import { playNotchTick } from '../../lib/chime';
import { emitExternalPushToTalk, summonTakeDue } from '../../lib/voice/externalPushToTalk';
import { initAgentSettingsFromServer } from '../../lib/agentSettings';
// The pill's right ear draws the tab strip's own status bubbles (`project-tab-bubble*`); the
// rules are global class selectors, so they are shared, not copied.
import '../layout/ProjectTabs.css';
import './notch.css';

/**
 * The dreamcontext Assistant's notch — the window labelled `assistant` (`?assistant=1`), a
 * non-activating panel at the top of the screen (desktop/src-tauri/src/assistant.rs).
 *
 * TWO STATES, ONE MOUNT. Collapsed it is a pill (left: avatar + who/what; right: how many —
 * the working/asking bubbles, proposals); expanded it is the SAME ChatPane + Composer every project uses, on the hidden
 * `__assistant__` vault. Collapsing is a SIZE and VISIBILITY change and nothing else: the pane
 * stays mounted and its socket stays open, because that socket is the relay's only channel
 * (the server sends every UI verb down it) and a closed one would, after the linger, end the
 * assistant's `claude` process mid-conversation.
 *
 * The session is the ONE long-lived conversation in `config.conversationId`, resumed on every
 * launch; "New conversation" rotates it.
 *
 * TWO SEATS, ONE WINDOW. "Pop out" moves this same webview out of the notch into a floating,
 * resizable, draggable window with all corners rounded; "Dock" puts it back. Same session,
 * same socket, same `claude`: the seat is native geometry (assistant.rs `apply_seat`) plus a
 * class here, never a remount. The choice holds for every summon until the app quits.
 *
 * THE ASSISTANT DECIDES HOW IT IS SHOWN (owner, 2026-10-04). It no longer steps out to a side
 * window while it works. A hotkey take opens the notch, and once the words are sent it folds
 * back to the pill, which says what the Assistant is doing. Each text block carries a cue
 * (`lib/notchCue.ts`): a `progress` line drops a silent peek that folds after a reading time; a
 * `present` block opens the notch and is read aloud, and it folds once the speech ends unless
 * the Assistant said `stay`. The owner touching the open notch makes it theirs: nothing folds
 * it by itself after that.
 *
 * A NOTIFICATION CENTER TOO. Collapsed, it also tells the owner what happened elsewhere (the
 * inbox, `GET /api/assistant/inbox`): a chat that finished off screen, an automation's unread
 * post, an automation that started, an account limit. Each drops a peek; all of them wait under
 * "Now" until seen, and a click lands in the window they are about.
 */

export const ASSISTANT_VAULT = '__assistant__';

/** Collapsed pill without a notch, logical px (assistant.rs seats the first frame at this). */
const PILL_W = 300;
const PILL_H = 38;
/** One "ear" beside the camera housing, logical px. */
const EAR_W = 130;
/** The open notch: a small island grown out of the housing, never a window-sized sheet. */
/** Grown 2026-09-27 (owner: "mesajları görmek çok zor") from 460x400. */
const PANEL_W = 580;
const PANEL_H = 560;
/** Popped out: an ordinary window's size, until the owner resizes it. */
const WINDOW_W = 720;
const WINDOW_H = 640;
/** After a presentation is spoken, how long it stays open before folding. */
const FOLD_AFTER_SPOKEN_MS = 2200;
/** A voice take was sent: this long for the owner to see it land, then the notch folds. */
const FOLD_AFTER_SEND_MS = 450;
/** An event peek (a chat finished, an automation posted, an account notice) stays this long:
 *  long enough to catch from the corner of an eye (owner, 2026-10-04: 6.5 s was too short). */
const EVENT_PEEK_MS = 20_000;
/** "<automation> started" is a shorter peek: it is news, not something to act on. */
const STARTED_PEEK_MS = 4500;
/** How long the island stays green after the last turn across every project ends. */
const DONE_GLOW_MS = 4000;
/** The peek: as wide as a short sentence plus two buttons, never the whole open panel. */
const PEEK_W = 460;
/** Hover must rest this long before the peek drops (a cursor crossing the menu bar is not a hover). */
const HOVER_IN_MS = 220;
/** Leaving a hover peek: this long to come back before it folds. */
const HOVER_OUT_MS = 350;
/** A finished hand-off's reply stays in the peek this long (paused while hovered). */
const FINISHED_PEEK_MS = 7000;

/** Why the peek is down: a hover, a prompt waiting on the owner, a hand-off that just ended, an
 *  inbox event, or the Assistant thinking out loud. */
type PeekReason = 'hover' | 'ask' | 'finished' | 'event' | 'progress';

/** Where the assistant sits: grown out of the notch, or floating as its own window. */
type Seat = 'notch' | 'window';
interface Frame { x: number; y: number; width: number; height: number }

interface AssistantStatus {
  exists: boolean;
  config: {
    name: string; conversationId: string | null; hotkey: { mode: 'hold' | 'toggle' } | null;
    /** The Assistant's own default (sonnet + medium unless the owner picked otherwise). */
    model?: string; effort?: string;
  } | null;
  avatar: string | null;
}

/** The Assistant's own model and effort when the server has not said (src/lib/assistant/home.ts). */
const ASSISTANT_MODEL = 'sonnet';
const ASSISTANT_EFFORT = 'medium';

/** Persist the Assistant's own default model or effort (picked in the notch's composer). */
async function saveProfile(patch: { model?: string; effort?: string }): Promise<void> {
  try {
    await fetch('/api/assistant/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
  } catch { /* the live session already switched; the next launch asks again */ }
}

interface Geometry { x: number; y: number; width: number; height: number; notch_width: number; notch_height: number }

async function readGeometry(): Promise<Geometry | null> {
  if (!isDesktop()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<Geometry>('assistant_geometry');
  } catch {
    return null;
  }
}

/** Two notch ticks closer than this are one: several arrivals in a breath ring once. */
const CUE_FLOOR_MS = 1500;

/** One light Force Touch tap (src/assistant.rs `assistant_haptic`); nothing outside the app. */
/**
 * The notification's tick and trackpad tap, both native (assistant.rs `assistant_haptic`): a
 * WebAudio tick stayed silent until the notch was clicked once (autoplay policy). The browser
 * preview, or an app build without the command, falls back to the WebAudio tick.
 */
async function notchCue(): Promise<void> {
  if (isDesktop()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('assistant_haptic', { sound: true });
      return;
    } catch { /* fall through to the webview's own tick */ }
  }
  playNotchTick();
}

/** The collapsed pill's height: the camera housing's, or a plain pill's without one. */
function pillHeight(geo: Geometry | null): number {
  return geo && geo.notch_width > 0 ? geo.notch_height : PILL_H;
}

/** The notch seat's frame for a state. The pill spans the camera housing plus two "ears". */
function notchFrame(expanded: boolean, geo: Geometry | null): { width: number; height: number; x?: number; y?: number } {
  const hasNotch = !!geo && geo.notch_width > 0;
  const earsW = hasNotch ? geo!.notch_width + 2 * EAR_W : PILL_W;
  const width = expanded ? Math.max(PANEL_W, earsW) : earsW;
  const height = expanded ? PANEL_H : pillHeight(geo);
  return geo ? { width, height, x: geo.x + (geo.width - width) / 2, y: geo.y } : { width, height };
}

/**
 * The notch window as one `set_frames` item (lib/windowFrames.ts): the whole frame in one
 * step, never size-then-position. A frame without a position (no monitor geometry) keeps the
 * window where it is.
 */
async function frameItem(f: SeatFrame, min?: MinPreset): Promise<FrameItem> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  let at = f.x !== undefined && f.y !== undefined ? { x: f.x, y: f.y } : null;
  if (!at) {
    const pos = (await win.outerPosition()).toLogical(await win.scaleFactor());
    at = { x: pos.x, y: pos.y };
  }
  return { label: win.label, ...at, width: f.width, height: f.height, ...(min ? { min } : {}) };
}

/** Move the notch window to `f` over `ms`, as a flight the seat guard will not mistake for drift. */
async function applyFrame(f: SeatFrame, ms: number, min?: MinPreset): Promise<void> {
  await withFlight(async () => setFrames([await frameItem(f, min)], ms));
}

// The seat guard (seatGuard.ts) reads and heals THIS window. A heal is a correction: it lands
// at once and is not a flight, so a frame macOS refuses cannot loop heal -> flight -> heal.
if (isDesktop()) {
  setSeatWindow({
    isVisible: async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      return getCurrentWindow().isVisible();
    },
    frame: async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const scale = await win.scaleFactor();
      const size = (await win.innerSize()).toLogical(scale);
      const pos = (await win.outerPosition()).toLogical(scale);
      return { x: pos.x, y: pos.y, width: size.width, height: size.height };
    },
    apply: async (f) => setFrames([await frameItem(f)], 0),
  });
}

/**
 * The owner switched the assistant off (the Launcher card → `assistant_set_enabled`, which
 * hides this panel and emits `assistant://enabled`). A hidden panel must STAY hidden, so no
 * seat change shows it again until it is switched back on.
 */
let switchedOff = false;

/**
 * Size + seat the window for a state. `claimed` is a seat change the caller already claimed
 * (synchronously, at the click) — it is dropped if a newer one came since. The notch seat never
 * has a min size, so it always clears one a popped-out window left behind.
 */
async function seat(expanded: boolean, geo: Geometry | null, ms: number = frameMotionMs(), claimed?: number, focus = expanded): Promise<void> {
  if (!isDesktop() || switchedOff) return;
  const f = notchFrame(expanded, geo);
  const gen = claimed ?? claimSeat(f);
  if (!wantSeat(gen, f)) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (!(await win.isVisible())) await win.show();
    if (!isCurrentSeat(gen)) return;
    await Promise.all([applyFrame(f, ms, 'clear'), focus ? win.setFocus() : undefined]);
  } catch { /* ACL / no runtime — the browser preview just renders */ }
}

/**
 * The PEEK seat: the pill grown down by `h` px, centred under the housing. Never focused — a
 * peek is something to glance at, and the owner may be typing in another app.
 */
async function seatPeek(geo: Geometry | null, h: number, ms: number = frameMotionMs()): Promise<void> {
  if (!isDesktop() || switchedOff) return;
  const pill = notchFrame(false, geo);
  const width = Math.max(PEEK_W, pill.width);
  const f: SeatFrame = geo
    ? { width, height: pill.height + h, x: geo.x + (geo.width - width) / 2, y: geo.y }
    : { width, height: pill.height + h };
  const gen = claimSeat(f);
  if (!wantSeat(gen, f)) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (!(await win.isVisible())) await win.show();
    if (!isCurrentSeat(gen)) return;
    await applyFrame(f, ms, 'clear');
  } catch { /* ACL / no runtime */ }
}

/**
 * Is the pointer over the notch window right now? Asked of the OS, not of hover events: the
 * notch is a panel of an app that is usually NOT in front, and such a window gets no
 * mouseenter, so `hoverRef` stays false while the owner reaches for a button. A peek that
 * folded on its timer under the pointer turned the click into a miss (owner, 2026-10-04:
 * "Open the chat" on a finished session did nothing, coming from another app).
 */
async function pointerOverNotch(): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    const { cursorPosition, getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    const [c, p, s] = await Promise.all([cursorPosition(), w.outerPosition(), w.outerSize()]);
    return c.x >= p.x && c.x < p.x + s.width && c.y >= p.y && c.y < p.y + s.height;
  } catch {
    return false;
  }
}

/**
 * Ask the native side to hold Esc while the notch is open, or let it go (assistant.rs
 * `ESCAPE_GRAB_EVENT`). Chained, so a fold and the next open can never land out of order and
 * leave an open notch without its Esc, or a folded one holding every other app's Esc.
 */
let escapeGrab: Promise<void> = Promise.resolve();
function setEscapeGrab(on: boolean): void {
  if (!isDesktop()) return;
  escapeGrab = escapeGrab
    .then(async () => {
      const { emit } = await import('@tauri-apps/api/event');
      await emit('assistant://escape-grab', { on });
    })
    .catch(() => { /* no runtime */ });
}

/** How often a peek whose time ran out under the pointer looks again. */
const FOLD_RECHECK_MS = 800;

/**
 * Fold after `ms`, but never while the pointer rests on the notch (hover, or the OS says so);
 * then keep looking until it leaves. Returns the canceller.
 */
function foldWhenAway(ms: number, hovered: () => boolean, fold: () => void): () => void {
  let alive = true;
  let t = 0;
  const tryFold = async () => {
    if (!alive) return;
    if (hovered() || await pointerOverNotch()) {
      if (alive) t = window.setTimeout(() => void tryFold(), FOLD_RECHECK_MS);
      return;
    }
    if (alive) fold();
  };
  t = window.setTimeout(() => void tryFold(), ms);
  return () => { alive = false; window.clearTimeout(t); };
}

/**
 * Change seats natively (desktop/src-tauri/src/assistant.rs `apply_seat`: level, resizable,
 * shadow; the min size rides the frame, see `seatWindow`). The SAME window and webview move;
 * nothing is rebuilt or reloaded.
 */
async function nativeSeat(to: Seat): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('assistant://seat', { seat: to });
  } catch { /* no runtime */ }
}

/**
 * Float as a window: where it last was, or an ordinary size near the top third of the screen.
 * The window's min size travels with the frame and lands after it — set first, it would grow
 * the pill-sized window on its own, a visible frame of its own.
 */
async function seatWindow(
  geo: Geometry | null,
  last: Frame | Pick<Frame, 'width' | 'height'> | null,
  focus = true,
  ms: number = frameMotionMs(),
  claimed?: number,
): Promise<void> {
  if (!isDesktop() || switchedOff) return;
  const gen = claimed ?? claimSeat(null);
  if (!wantSeat(gen, null)) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const f: SeatFrame = last ?? (geo
      ? { x: geo.x + (geo.width - WINDOW_W) / 2, y: geo.y + Math.max(48, (geo.height - WINDOW_H) / 3), width: WINDOW_W, height: WINDOW_H }
      : { width: WINDOW_W, height: WINDOW_H });
    if (!(await win.isVisible())) await win.show();
    if (!isCurrentSeat(gen)) return;
    await Promise.all([applyFrame(f, ms, 'window-seat'), focus ? win.setFocus() : undefined]);
  } catch { /* ACL / no runtime */ }
}

/**
 * Where the floating window is now, so docking and popping out again lands it back there.
 * Mid-animation there is no "where": the frame is one the owner never chose, so it is not read.
 */
async function readFrame(): Promise<Frame | null> {
  if (!isDesktop() || flying()) return null;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    const pos = (await win.outerPosition()).toLogical(scale);
    const size = (await win.innerSize()).toLogical(scale);
    return { x: pos.x, y: pos.y, width: size.width, height: size.height };
  } catch {
    return null;
  }
}

/** Hide the floating window (the webview and its socket live on; the hotkey brings it back). */
async function hideWindow(): Promise<void> {
  if (!isDesktop()) return;
  claimSeat(null);
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().hide();
  } catch { /* no runtime */ }
}

/** The inbox row an event peek is about, so acting on the row folds its peek too. */
function peekId(p: PeekItem): string | null {
  if (p.kind === 'notice') return p.notice.id;
  if (p.kind === 'post') return p.post.key;
  return null;
}

async function saveConversationId(conversationId: string): Promise<void> {
  try {
    await fetch('/api/assistant/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }),
    });
  } catch { /* next launch starts a fresh one */ }
}

export function Notch() {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [rollup, setRollup] = useState<Rollup>(EMPTY_ROLLUP);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [glance, setGlance] = useState<GlanceChat[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [inbox, setInbox] = useState<Inbox>(EMPTY_INBOX);
  /** Rows the owner just acted on, hidden until the server stops listing them (id → when). */
  const [gone, setGone] = useState<Map<string, number>>(() => new Map());
  /** The peek an inbox event or a progress line asked for (see `PeekReason`). */
  const [eventPeek, setEventPeek] = useState<PeekItem | null>(null);
  /** The open panel's two faces: what is happening everywhere, and the conversation. */
  const [tab, setTab] = useState<'now' | 'chat'>('chat');
  const [convosOpen, setConvosOpen] = useState(false);
  const [peek, setPeek] = useState<PeekReason | null>(null);
  const [finishedId, setFinishedId] = useState<string | null>(null);
  const peekRef = useRef<HTMLDivElement>(null);
  /** Something waits on the owner (a prompt or a proposal) — opening lands on "Now". */
  const waitingRef = useRef(false);
  const [justFinished, setJustFinished] = useState(false);
  const [attention, setAttention] = useState(false);
  const [geo, setGeo] = useState<Geometry | null>(null);
  // Remembered for the whole app run: the webview is never reloaded, so every hotkey summon
  // after a pop-out opens the window, until the owner docks it.
  const [seatMode, setSeatMode] = useState<Seat>('notch');
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ChatSession | null>(null);
  const expandedRef = useRef(false);
  expandedRef.current = expanded;
  const seatRef = useRef<Seat>('notch');
  seatRef.current = seatMode;
  const frameRef = useRef<Frame | null>(null);
  /** The Assistant's own model and effort (owner, 2026-10-04: sonnet + medium by default, and
   *  NOT the owner's chat default; a pick in this composer becomes its new default). */
  const profileRef = useRef<{ model: string; effort: string }>({ model: ASSISTANT_MODEL, effort: ASSISTANT_EFFORT });
  /** The open panel was opened BY a presentation (not by the owner): it may fold by itself. */
  const autoOpenRef = useRef<{ stay: boolean } | null>(null);
  /** The owner touched the open panel (clicked, typed): it is theirs, nothing folds it. */
  const engagedRef = useRef(false);
  /** The panel was summoned by the hotkey for a voice take: it folds once the words are sent. */
  const voiceSummonRef = useRef(false);
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;

  const startSession = useCallback((conversationId: string | null) => {
    const id = conversationId ?? crypto.randomUUID();
    if (!conversationId) void saveConversationId(id);
    const { model, effort } = profileRef.current;
    const cs = createChatSession(ASSISTANT_VAULT, false, bump, id, !!conversationId, model, effort, '', '', false, 'assistant');
    cs.setCommandHandler(executeAssistantCommand);
    sessionRef.current?.setCommandHandler(null);
    sessionRef.current = cs;
    setSession(cs);
  }, []);

  // Boot: who am I, and resume my conversation.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // The remembered chat defaults live server-side; a fresh notch window has an empty
        // localStorage until this lands, and the session below reads them.
        await initAgentSettingsFromServer();
        const res = await fetch('/api/assistant/status');
        const st = await res.json() as AssistantStatus;
        if (!alive) return;
        setStatus(st);
        profileRef.current = {
          model: st.config?.model || ASSISTANT_MODEL,
          effort: st.config?.effort || ASSISTANT_EFFORT,
        };
        if (st.exists && st.config) startSession(st.config.conversationId);
      } catch { /* server not up yet — the pill stays empty */ }
      const g = await readGeometry();
      // The first placement is not a motion: it lands in one frame.
      if (alive) { setGeo(g); void seat(false, g, 0); }
    })();
    return () => { alive = false; };
  }, [startSession]);

  // The session outlives every collapse; only the window going away ends it.
  useEffect(() => () => { sessionRef.current?.dispose(); }, []);

  // This window IS the notch, so the whole document wears its palette: menus and popovers the
  // composer portals to <body> must be notch black too, never the light theme's white.
  useEffect(() => {
    document.body.classList.add('surface-night', 'dc-notch-doc');
    return () => { document.body.classList.remove('surface-night', 'dc-notch-doc'); };
  }, []);

  // Home the session's detached container in the panel (ChatPane is portaled into it).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (session && host && session.container.parentElement !== host) host.appendChild(session.container);
  }, [session]);

  // The pill's glance: counts every few seconds, proposals when any wait.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = readRollup(await (await fetch('/api/assistant/rollup')).json());
        if (!alive) return;
        setRollup(r);
        if (r.proposals > 0 || expandedRef.current) {
          const p = await (await fetch('/api/assistant/proposals')).json() as { proposals: Proposal[] };
          if (alive) setProposals(p.proposals ?? []);
        } else {
          setProposals([]);
        }
        // The rows and the hand-offs, every tick: the collapsed pill and its peek speak from
        // them too (who asks, which hand-off just finished), not only the open panel.
        const raw = await (await fetch('/api/assistant/glance')).json();
        if (alive) { setGlance(readGlance(raw)); setHandoffs(readHandoffs(raw)); }
      } catch { /* transient */ }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => onAssistantNotify((_text, level) => { if (level === 'attention') setAttention(true); }), []);

  // The inbox: what happened elsewhere (finished chats, automation posts and runs, account
  // notices). Polled a little slower than the glance; the server caches the per-project reads.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const raw = await (await fetch('/api/assistant/inbox')).json();
        if (alive) setInbox(readInbox(raw));
      } catch { /* transient */ }
    };
    void tick();
    const t = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  /** Hide a row the owner acted on at once; the server's next answer confirms it. */
  const hide = useCallback((id: string) => {
    setGone((g) => new Map(g).set(id, Date.now()));
    setEventPeek((p) => (p && peekId(p) === id ? null : p));
  }, []);
  // The event peek went away (acted on): its reason goes with it, so a later hover is a hover.
  useEffect(() => {
    if (!eventPeek) setPeek((r) => (r === 'event' || r === 'progress' ? null : r));
  }, [eventPeek]);
  // A hidden id is forgotten once the server stops listing it, or after half a minute.
  useEffect(() => {
    setGone((g) => {
      if (!g.size) return g;
      const listed = new Set([...inbox.notices.map((n) => n.id), ...inbox.posts.map((p) => p.key)]);
      const now = Date.now();
      const next = new Map([...g].filter(([id, at]) => listed.has(id) && now - at < 30_000));
      return next.size === g.size ? g : next;
    });
  }, [inbox]);
  const notices = inbox.notices.filter((n) => !gone.has(n.id));
  const posts = inbox.posts.filter((p) => !gone.has(p.key));
  const inboxCount = notices.length + posts.length;

  // The last turn across every project just ended: green for a moment, then idle.
  const busyCount = rollup.working + rollup.starting;
  const wasBusy = useRef(0);
  useEffect(() => {
    const ended = wasBusy.current > 0 && busyCount === 0;
    wasBusy.current = busyCount;
    if (busyCount > 0) { setJustFinished(false); return; }
    if (!ended) return;
    setJustFinished(true);
    const t = window.setTimeout(() => setJustFinished(false), DONE_GLOW_MS);
    return () => window.clearTimeout(t);
  }, [busyCount]);
  const mood = notchMood(rollup, justFinished);
  const dropRow = useCallback((sessionId: string) => {
    setGlance((g) => g.filter((c) => c.sessionId !== sessionId));
    setHandoffs((hs) => hs.map((h) => (h.sessionId === sessionId ? { ...h, ask: null, activity: 'working' } : h)));
  }, []);
  const clearHandoff = useCallback((sessionId: string) => {
    dismissHandoff(sessionId);
    setHandoffs((hs) => hs.filter((h) => h.sessionId !== sessionId));
  }, []);
  // Only what needs an ANSWER opens on "Now"; notifications are counted on its tab instead (a
  // finished-chat notice can wait for hours, and a click usually means "let me talk").
  waitingRef.current = glance.some((c) => !!c.ask) || proposals.length > 0;

  // ── THE PEEK: the collapsed notch says one thing without being opened ──────────────────
  // Only from the notch seat: popped out, the window IS the surface and a hidden one stays hidden.
  const canPeek = !expanded && seatMode === 'notch';
  const canPeekRef = useRef(canPeek);
  canPeekRef.current = canPeek;
  const hoverRef = useRef(false);

  // A prompt the owner has not seen yet drops the peek by itself; it stays until it is
  // answered or waved away. One already seen (answered, dismissed) never drops it again.
  const askKeys = glance.filter((c) => c.ask).map((c) => `${c.sessionId}:${c.ask!.id}`).join('|');
  const seenAsks = useRef<Set<string>>(new Set());
  useEffect(() => {
    const keys = askKeys ? askKeys.split('|') : [];
    const fresh = keys.some((k) => !seenAsks.current.has(k));
    for (const k of keys) seenAsks.current.add(k);
    if (fresh && canPeekRef.current) setPeek('ask');
    if (!keys.length) setPeek((p) => (p === 'ask' ? null : p));
  }, [askKeys]);

  // A hand-off that was running and is now done or closed: say so, with its reply.
  const phases = useRef(new Map<string, string>());
  useEffect(() => {
    let ended: string | null = null;
    const next = new Map<string, string>();
    for (const h of handoffs) {
      const ph = handoffPhase(h);
      const was = phases.current.get(h.sessionId);
      if ((was === 'running' || was === 'waiting') && (ph === 'done' || ph === 'closed')) ended = h.sessionId;
      next.set(h.sessionId, ph);
    }
    phases.current = next;
    if (!ended) return;
    setFinishedId(ended);
    if (canPeekRef.current) setPeek((p) => p ?? 'finished');
  }, [handoffs]);
  // The pill says "<project> finished" for a while after; the peek folds sooner (not while hovered).
  useEffect(() => {
    if (!finishedId) return;
    const t = window.setTimeout(() => setFinishedId(null), 30_000);
    return () => window.clearTimeout(t);
  }, [finishedId]);
  useEffect(() => {
    if (peek !== 'finished') return;
    return foldWhenAway(FINISHED_PEEK_MS, () => hoverRef.current, () => setPeek((p) => (p === 'finished' ? null : p)));
  }, [peek, finishedId]);

  // ── INBOX PEEKS: something happened elsewhere ─────────────────────────────────────────
  // A new arrival (never one already listed at boot) drops a peek that folds by itself; it
  // stays listed under "Now" either way. A waiting prompt or the Assistant thinking out loud
  // outranks it: the event is then only listed.
  /** The event/progress peek's time ran out while the pointer rested on it: fold on leave. */
  const peekExpiredRef = useRef(false);
  const peekReasonRef = useRef<PeekReason | null>(peek);
  peekReasonRef.current = peek;
  // Arrivals wait in a queue until the peek is free, then speak one at a time: an arrival that
  // lands under a waiting prompt, a progress line, the open notch or another announcement used
  // to be listed silently, and the owner never heard about the finish (2026-10-04).
  const [peekQueue, setPeekQueue] = useState<Array<{ id: string; item: PeekItem }>>([]);
  const seenInbox = useRef<{ booted: boolean; ids: Set<string>; runs: Set<string> }>({ booted: false, ids: new Set(), runs: new Set() });
  useEffect(() => {
    const seen = seenInbox.current;
    const fresh: Array<{ id: string; item: PeekItem }> = [];
    for (const n of inbox.notices) if (!seen.ids.has(n.id)) { seen.ids.add(n.id); fresh.push({ id: n.id, item: { kind: 'notice', notice: n } }); }
    for (const p of inbox.posts) if (!seen.ids.has(p.key)) { seen.ids.add(p.key); fresh.push({ id: p.key, item: { kind: 'post', post: p } }); }
    const liveRuns = new Set(inbox.running.map(runKey));
    const starts: Array<{ id: string; item: PeekItem }> = [];
    for (const r of inbox.running) if (!seen.runs.has(runKey(r))) { seen.runs.add(runKey(r)); starts.push({ id: `run:${runKey(r)}`, item: { kind: 'started', run: r } }); }
    for (const k of [...seen.runs]) if (!liveRuns.has(k)) seen.runs.delete(k);
    if (!seen.booted) { seen.booted = true; return; }   // what was already there at launch is listed, not announced
    // Server order is newest first; the queue speaks oldest first. A start is news only when
    // nothing else is: it never waits in the queue behind (or ahead of) a finish or a post.
    const arrivals = fresh.reverse();
    if (arrivals.length) setPeekQueue((q) => enqueuePeeks(q, arrivals));
    else if (starts.length && canPeekRef.current && !peekReasonRef.current) { setEventPeek(starts[0].item); setPeek('event'); }
  }, [inbox]);
  // Drain: the next waiting arrival speaks once the peek is free. One the owner already acted on
  // (opened, dismissed, gone from the server) is dropped instead of announced late.
  useEffect(() => {
    if (!peekQueue.length || !canPeek) return;
    if (peek === 'ask' || peek === 'progress' || peek === 'event') return;
    const listed = new Set([...notices.map((n) => n.id), ...posts.map((p) => p.key)]);
    const [next, ...rest] = peekQueue;
    setPeekQueue(rest);
    if (!listed.has(next.id)) return;
    setEventPeek(next.item);
    setPeek('event');
  }, [peekQueue, peek, canPeek, notices, posts]);

  // The event / progress peek folds by itself — never while the pointer rests on it.
  useEffect(() => {
    if ((peek !== 'event' && peek !== 'progress') || !eventPeek) return;
    peekExpiredRef.current = false;
    const ms = eventPeek.kind === 'progress' ? readingTimeMs(eventPeek.text)
      : eventPeek.kind === 'started' ? STARTED_PEEK_MS : EVENT_PEEK_MS;
    // A hover the webview DID see folds on leave (onHoverOut); otherwise the OS is asked.
    return foldWhenAway(ms, () => {
      if (hoverRef.current) peekExpiredRef.current = true;
      return hoverRef.current;
    }, () => setPeek((p) => (p === 'event' || p === 'progress' ? null : p)));
  }, [peek, eventPeek]);

  // Hover: rest on the pill and it drops; leave and it folds (an event peek for a prompt stays).
  const hoverTimer = useRef<number | null>(null);
  const onHoverIn = useCallback(() => {
    hoverRef.current = true;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (!canPeekRef.current) return;
    hoverTimer.current = window.setTimeout(() => setPeek((p) => p ?? 'hover'), HOVER_IN_MS);
  }, []);
  const onHoverOut = useCallback(() => {
    hoverRef.current = false;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setPeek((p) => (p === 'hover' || p === 'finished' ? null : p)), HOVER_OUT_MS);
    // An event or progress peek that ran out while hovered folds now.
    if (peekExpiredRef.current) {
      peekExpiredRef.current = false;
      setPeek((p) => (p === 'event' || p === 'progress' ? null : p));
    }
  }, []);
  useEffect(() => () => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); }, []);
  // The OS says when the pointer crosses the notch (assistant.rs `watch_hover`): the webview's
  // own pointerenter only comes while the panel is key, which it almost never is, so a hover
  // from another app (or under a dragged file) used to drop the peek only sometimes.
  useEffect(() => {
    if (!isDesktop()) return;
    let off: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const fn = await listen<{ inside?: boolean }>('assistant://hover', ({ payload }) => {
          if (payload?.inside) onHoverIn(); else onHoverOut();
        });
        if (cancelled) fn(); else off = fn;
      } catch { /* no runtime */ }
    })();
    return () => { cancelled = true; off?.(); };
  }, [onHoverIn, onHoverOut]);

  // Seat the peek to its content (re-measured as rows change), and fold back to the pill.
  // An event or progress peek with nothing left to say (its row was acted on) is no peek.
  const peekShown = !!peek && canPeek && ((peek !== 'event' && peek !== 'progress') || !!eventPeek);
  // A peek that dropped BY ITSELF (a prompt, a finished hand-off, an inbox event) also ticks:
  // one soft note and one trackpad tap. A hover is the owner's own doing and a progress line is
  // the Assistant thinking out loud, so both stay silent. A new event replacing the one on
  // screen ticks again; a flurry inside the floor ticks once.
  const lastCue = useRef<{ peek: PeekReason | null; item: PeekItem | null; at: number }>({ peek: null, item: null, at: 0 });
  useEffect(() => {
    const cue = lastCue.current;
    const loud = peekShown && (peek === 'ask' || peek === 'finished' || peek === 'event');
    const item = peek === 'event' ? eventPeek : null;
    const isNew = loud && (cue.peek !== peek || cue.item !== item);
    cue.peek = peekShown ? peek : null;
    cue.item = item;
    if (!isNew || Date.now() - cue.at < CUE_FLOOR_MS) return;
    cue.at = Date.now();
    void notchCue();
  }, [peekShown, peek, eventPeek]);
  const wasPeek = useRef(false);
  useEffect(() => {
    if (!peekShown) {
      if (wasPeek.current && !expandedRef.current && seatRef.current === 'notch') void seat(false, geo);
      wasPeek.current = false;
      return;
    }
    wasPeek.current = true;
    const el = peekRef.current;
    if (!el) return;
    const fit = () => void seatPeek(geo, Math.ceil(el.getBoundingClientRect().height));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [peekShown, geo]);

  // Y / N answer the first thing waiting on the owner — a project's permission prompt, else the
  // first proposal — while the island is open and the owner is not typing.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const key = e.key.toLowerCase();
      if (key !== 'y' && key !== 'n') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const ask = glance.find((c) => c.ask?.kind === 'permission');
      if (ask) {
        e.preventDefault();
        void answerPermission(ask, key === 'y' ? 'allow' : 'deny').then((ok) => { if (ok) dropRow(ask.sessionId); });
        return;
      }
      const p = proposals[0];
      if (p) {
        e.preventDefault();
        void decide(p.id, key === 'y' ? 'approve' : 'reject').then((ok) => {
          if (ok) setProposals((ps) => ps.filter((x) => x.id !== p.id));
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, glance, proposals, dropRow]);

  // Opening lands on what matters: "Now" when something waits on the owner, else the chat.
  // The OWNER opened it (a click, the hotkey): it never folds by itself.
  const expand = useCallback((to?: 'now' | 'chat') => {
    setTab(to ?? (waitingRef.current ? 'now' : 'chat'));
    setPeek(null);
    setExpanded(true);
    setAttention(false);
    autoOpenRef.current = null;
    const seated = seatRef.current === 'window' ? seatWindow(geo, frameRef.current) : seat(true, geo);
    return seated.then(() => sessionRef.current?.focus());
  }, [geo]);
  // Popped out, "collapse" hides the window (still mounted, still connected) instead of
  // shrinking it to a pill; the next summon brings the window back.
  const collapse = useCallback(() => {
    setExpanded(false);
    setPeek(null);
    setConvosOpen(false);
    autoOpenRef.current = null;
    engagedRef.current = false;
    voiceSummonRef.current = false;
    if (seatRef.current === 'window') {
      void readFrame().then((f) => { if (f) frameRef.current = f; return hideWindow(); });
    } else {
      void seat(false, geo);
    }
  }, [geo]);
  /** For timers armed before a re-render: always the current `collapse`. */
  const collapseRef = useRef(collapse);
  collapseRef.current = collapse;

  // Pop out / dock: the SAME webview changes seats. Never an unmount, never a reload.
  const popOut = useCallback(() => {
    autoOpenRef.current = null;             // the owner's own pop-out stays until they dock
    // Leaving the notch seat: the guard must stop holding the notch frame NOW, not after the
    // native seat change lands. Claimed here, at the click, so a dock that follows before this
    // one lands supersedes it instead of racing it.
    const gen = claimSeat(null);
    seatRef.current = 'window';
    setSeatMode('window');
    setExpanded(true);
    void nativeSeat('window')
      .then(() => seatWindow(geo, frameRef.current, true, frameMotionMs(), gen))
      .then(() => sessionRef.current?.focus());
  }, [geo]);
  const dock = useCallback(() => {
    autoOpenRef.current = null;
    const gen = claimSeat(null);
    seatRef.current = 'notch';
    setSeatMode('notch');
    setExpanded(true);
    void readFrame()
      .then((f) => { if (f) frameRef.current = f; return nativeSeat('notch'); })
      .then(() => seat(true, geo, frameMotionMs(), gen))
      .then(() => sessionRef.current?.focus());
  }, [geo]);

  // ── THE ASSISTANT DECIDES HOW IT IS SHOWN (owner, 2026-10-04) ─────────────────────────
  // "Auto pop out is not needed; it opens and closes by itself." Nothing here moves the notch
  // to another seat any more: a hotkey take opens it and folds it once sent, a `present` block
  // opens it and folds it after speaking (unless `stay`), a `progress` line only peeks. The
  // owner's own Pop out / Dock is untouched.
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => session?.onSpeaking(setSpeaking), [session]);
  const busy = !!session?.busy;
  const active = busy || speaking;
  /** The newest progress line of this turn — the pill says it while the Assistant works. */
  const [progressLine, setProgressLine] = useState<string | null>(null);
  /** The text of the newest presentation, for how long an unspoken one stays up. */
  const presentTextRef = useRef('');
  /** Something was read aloud since the panel opened by itself. */
  const spokeRef = useRef(false);
  /** A voice take was sent: the pending fold back to the pill. */
  const foldTimer = useRef<number | null>(null);
  useEffect(() => { if (speaking) spokeRef.current = true; }, [speaking]);

  // The owner touched the open panel: it is theirs now, nothing folds it by itself.
  const engage = useCallback(() => {
    if (!expandedRef.current) return;
    engagedRef.current = true;
    voiceSummonRef.current = false;
    if (foldTimer.current) { window.clearTimeout(foldTimer.current); foldTimer.current = null; }
  }, []);

  // A presentation opens the notch WITHOUT taking focus: the owner may be typing elsewhere.
  const openForPresentation = useCallback((stay: boolean) => {
    if (switchedOff) return;
    if (foldTimer.current && expandedRef.current) {
      // The answer beat the fold-after-send: stay open, as if the answer had opened it.
      window.clearTimeout(foldTimer.current);
      foldTimer.current = null;
      autoOpenRef.current = { stay };
      engagedRef.current = false;
      spokeRef.current = false;
      return;
    }
    if (expandedRef.current) {
      // Already open: only a panel the notch opened itself may fold, and `stay` sticks.
      if (autoOpenRef.current) autoOpenRef.current = { stay: autoOpenRef.current.stay || stay };
      return;
    }
    autoOpenRef.current = { stay };
    engagedRef.current = false;
    spokeRef.current = false;
    setTab('chat');
    setPeek(null);
    setExpanded(true);
    if (seatRef.current === 'window') void seatWindow(geo, frameRef.current, false);
    else void seat(true, geo, frameMotionMs(), undefined, false);
  }, [geo]);

  useEffect(() => session?.onPresent((p: NotchPresentation) => {
    if (p.kind === 'progress') {
      setProgressLine(p.text);
      // Only the collapsed notch peeks: open, the line is right there in the chat.
      if (expandedRef.current || seatRef.current !== 'notch') return;
      if (peekReasonRef.current === 'ask') return;
      setEventPeek({ kind: 'progress', text: p.text, name: status?.config?.name ?? 'Assistant', avatar: status?.avatar ?? null });
      setPeek('progress');
      return;
    }
    presentTextRef.current = p.text;
    setPeek((r) => (r === 'progress' ? null : r));
    openForPresentation(p.stay);
  }), [session, openForPresentation, status]);

  // A new turn starts: its progress line is new too.
  const wasBusy2 = useRef(false);
  useEffect(() => {
    const rose = busy && !wasBusy2.current;
    wasBusy2.current = busy;
    if (!rose) return;
    setProgressLine(null);
    // A voice take was just sent from a panel the hotkey opened: fold to the pill, which now
    // says what the Assistant is doing (owner: "we send the request, then it collapses").
    // Not cancelled by the turn ending: a reply quicker than the fold still folds the take.
    if (voiceSummonRef.current && !engagedRef.current && expandedRef.current && seatRef.current === 'notch') {
      voiceSummonRef.current = false;
      if (foldTimer.current) window.clearTimeout(foldTimer.current);
      foldTimer.current = window.setTimeout(() => {
        foldTimer.current = null;
        if (!engagedRef.current && expandedRef.current) collapseRef.current();
      }, FOLD_AFTER_SEND_MS);
    }
  }, [busy]);
  useEffect(() => () => { if (foldTimer.current) window.clearTimeout(foldTimer.current); }, []);

  // The turn and its speech are over: a panel a presentation opened folds, unless it said
  // `stay` or the owner took it over. Unspoken, it stays long enough to be read.
  useEffect(() => {
    if (active || !expanded || !autoOpenRef.current || autoOpenRef.current.stay || engagedRef.current) return;
    if (seatRef.current === 'window') return;     // a popped-out window is the owner's: never hidden for them
    const ms = spokeRef.current ? FOLD_AFTER_SPOKEN_MS : readingTimeMs(presentTextRef.current, { min: 5000, max: 20000 });
    let t = 0;
    const fold = () => {
      if (hoverRef.current) { t = window.setTimeout(fold, 1500); return; }
      if (autoOpenRef.current && !autoOpenRef.current.stay && !engagedRef.current) collapseRef.current();
    };
    t = window.setTimeout(fold, ms);
    return () => window.clearTimeout(t);
  }, [active, expanded]);

  // Popped out, the top row is the title bar: drag the window from anywhere on it.
  const onPillMouseDown = useCallback((e: React.MouseEvent) => {
    if (seatRef.current !== 'window' || e.button !== 0 || !isDesktop()) return;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().startDragging()).catch(() => { /* no runtime */ });
  }, []);

  // The off switch from Rust (assistant://enabled). Off: stop re-seating (see `switchedOff`).
  useEffect(() => {
    if (!isDesktop()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const fn = await listen<{ enabled: boolean }>('assistant://enabled', (e) => {
          switchedOff = e.payload?.enabled === false;
          if (switchedOff) setExpanded(false);
        });
        if (cancelled) fn(); else unlisten = fn;
      } catch { /* no runtime */ }
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Hotkey edges from Rust (assistant://hotkey) — the ONE chord that summons the notch AND
  // talks to it. Hold: press summons and opens the mic, release closes it (a tap just opens
  // the panel). Toggle (the fallback when a Released edge cannot be trusted): press summons and
  // opens the mic, the next press sends, a press with nothing recording dismisses.
  //
  // The summoning press un-hides the panel SYNCHRONOUSLY (flushSync) before the edge goes to
  // the composer: `ownsPushToTalk` only answers for a VISIBLE composer, and a hidden one would
  // let the owner's first sentence fall on the floor. The edge itself waits for the panel to
  // land (`summonTakeDue`): opening the mic in the same tick froze the resize for seconds.
  const heldRef = useRef(false);
  const pressRef = useRef(0);
  useEffect(() => {
    if (!isDesktop()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const mode = status?.config?.hotkey?.mode === 'toggle' ? 'toggle' : 'hold';
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const fn = await listen<{ state: 'pressed' | 'released' }>('assistant://hotkey', (e) => {
          const edge = e.payload?.state;
          if (edge === 'released') {
            heldRef.current = false;
            emitExternalPushToTalk({ edge, mode, summon: false });
            return;
          }
          if (edge !== 'pressed') return;
          heldRef.current = true;
          const press = ++pressRef.current;
          if (!expandedRef.current) {
            flushSync(() => setExpanded(true));
            // Summoned to talk: once the words are sent the notch folds to the pill.
            voiceSummonRef.current = true;
            engagedRef.current = false;
            void expand('chat').then(() => {
              if (!summonTakeDue(mode, heldRef.current, expandedRef.current, press === pressRef.current)) return;
              emitExternalPushToTalk({ edge, mode, summon: true });
            });
            return;
          }
          const acted = emitExternalPushToTalk({ edge, mode, summon: false });
          // A voice follow-up in the open notch folds it once sent, like a summon does — unless
          // the owner has been clicking or typing in it.
          if (acted && !engagedRef.current && seatRef.current === 'notch') {
            voiceSummonRef.current = true;
            autoOpenRef.current = null;
          }
          if (!acted && mode === 'toggle') collapse();
        });
        if (cancelled) fn(); else unlisten = fn;
      } catch { /* no runtime */ }
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [expand, collapse, status]);

  // Esc and click-outside collapse the notch. Never an unmount. A popped-out window is a
  // window: it stays open when the owner clicks elsewhere or presses Esc in it.
  // Click-outside is NATIVE (`assistant://outside-click`, assistant.rs `watch_outside_clicks`):
  // summoned over another app the non-activating panel never becomes key, so a focus loss never
  // comes. The focus loss stays as the second way out (⌘-Tab away from a panel that had focus).
  useEffect(() => {
    if (!expanded || seatMode === 'window') return;
    // An open file picker is a sheet on this panel: it takes the focus, and its clicks land
    // outside the notch's frame. Neither is the owner leaving, so nothing folds under it.
    const fold = () => { if (!pickerOpen()) collapse(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) fold(); };
    window.addEventListener('keydown', onKey);
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    setEscapeGrab(true);
    if (isDesktop()) {
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const { listen } = await import('@tauri-apps/api/event');
          const fns = [
            await getCurrentWindow().onFocusChanged(({ payload: focused }) => { if (!focused) fold(); }),
            await listen('assistant://outside-click', () => fold()),
            // Esc held natively while open (assistant.rs `ESCAPE_GRAB_EVENT`): summoned over
            // another app the panel is never key, so the keydown would go to that app. The
            // native Esc is replayed here as a keydown on whatever has focus, so an open menu
            // (slash, mention, find) still takes it first and only a free Esc folds the notch.
            await listen('assistant://escape', () => {
              const target = document.activeElement ?? document.body;
              target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
            }),
          ];
          for (const fn of fns) { if (cancelled) fn(); else unlisteners.push(fn); }
        } catch { /* no runtime */ }
      })();
    }
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
      unlisteners.forEach((fn) => fn());
      setEscapeGrab(false);
    };
  }, [expanded, collapse, seatMode]);

  // ── A FILE DRAGGED ONTO THE NOTCH ───────────────────────────────────────────────────────
  // A file dragged over the folded notch opens it on the chat, and dropping it anywhere on
  // the notch hands it to the Assistant the way a drop on a project chat does (AgentSurface):
  // the bytes go to the vault temp dir and the path lands in the composer. NATIVE listeners on
  // the root, because the chat pane is portaled in and React drop props would miss it. A drag
  // that opened the notch and then leaves without dropping folds it again: `dragover` fires
  // continuously while a drag is over the page, so its silence means the drag went elsewhere.
  const dragOpenedRef = useRef(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let leaveTimer = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const openForDrag = () => {
      if (expandedRef.current) {
        setTab('chat');
        setConvosOpen(false);
        return;
      }
      if (seatRef.current !== 'notch') return;
      dragOpenedRef.current = true;
      void expand('chat');
    };
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      window.clearTimeout(leaveTimer);
      openForDrag();
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      window.clearTimeout(leaveTimer);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      window.clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(() => {
        if (!dragOpenedRef.current) return;
        dragOpenedRef.current = false;
        collapseRef.current();
      }, 400);
    };
    const onDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      window.clearTimeout(leaveTimer);
      dragOpenedRef.current = false;
      openForDrag();
      void (async () => {
        for (const file of files) {
          const path = await uploadAgentFile(ASSISTANT_VAULT, file, file.name);
          const s = sessionRef.current;
          if (path && s) { s.sendText(quotePath(path) + ' '); s.focus(); }
        }
      })();
    };
    el.addEventListener('dragenter', onEnter);
    el.addEventListener('dragover', onOver);
    el.addEventListener('dragleave', onLeave);
    el.addEventListener('drop', onDrop);
    return () => {
      window.clearTimeout(leaveTimer);
      el.removeEventListener('dragenter', onEnter);
      el.removeEventListener('dragover', onOver);
      el.removeEventListener('dragleave', onLeave);
      el.removeEventListener('drop', onDrop);
    };
  }, [expand]);

  // The seat guard (seatGuard.ts): a resize or move the notch did not ask for is undone at once,
  // and a slow check catches a frame that changed without telling anyone (a Space switch). A
  // frame macOS keeps refusing is given up on for a while instead of fought every second
  // (`guardHeal`: the next seat change, or a cooldown, re-arms it).
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => { void guardHeal(); };
    const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(check, 150); };
    const tick = setInterval(check, 1000);
    const unlisteners: Array<() => void> = [];
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        for (const fn of [await win.onResized(soon), await win.onMoved(soon)]) {
          if (cancelled) fn(); else unlisteners.push(fn);
        }
      } catch { /* no runtime */ }
    })();
    return () => {
      cancelled = true;
      clearInterval(tick);
      if (timer) clearTimeout(timer);
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const newConversation = useCallback(() => {
    const old = sessionRef.current;
    const id = crypto.randomUUID();
    void saveConversationId(id);
    if (old) {
      old.setCommandHandler(null);
      old.dispose();
    }
    const { model, effort } = profileRef.current;
    const cs = createChatSession(ASSISTANT_VAULT, false, bump, id, false, model, effort, '', '', false, 'assistant');
    cs.setCommandHandler(executeAssistantCommand);
    sessionRef.current = cs;
    setSession(cs);
    setConvosOpen(false);
    setTab('chat');
  }, []);

  // Back to an earlier conversation: the live one is closed (its transcript stays, listed in the
  // menu), the picked one is resumed in its place and becomes the one every launch resumes.
  const switchConversation = useCallback((id: string) => {
    const old = sessionRef.current;
    if (old) { old.setCommandHandler(null); old.dispose(); }
    void saveConversationId(id);
    startSession(id);
    setConvosOpen(false);
    setTab('chat');
    window.setTimeout(() => sessionRef.current?.focus(), 0);
  }, [startSession]);

  const actions = useMemo<ChatSurfaceActions>(() => ({
    // A pick here is the Assistant's new default, kept in its own config (never the owner's chat default).
    changeModel: (_sid, id) => {
      sessionRef.current?.setModel(id);
      profileRef.current = { ...profileRef.current, model: id };
      void saveProfile({ model: id });
    },
    changeEffort: (_sid, level) => {
      sessionRef.current?.setEffort(level);
      profileRef.current = { ...profileRef.current, effort: level };
      void saveProfile({ effort: level });
    },
    continueInTerminal: () => { /* the assistant has no terminal */ },
    resumeChat: (cs) => {
      cs.setCommandHandler(null);
      cs.dispose();
      startSession(cs.claudeId);
    },
    changePermissionMode: () => { /* governed by the autonomy setting */ },
    changeMode: () => { /* the assistant is always in assistant mode */ },
    changeAccount: () => { /* follows the default account */ },
    handoffToDevelop: () => { /* projects hand off, the assistant does not */ },
    // A detail button in an answer: open THAT project's window on the page. The click rides
    // the relay like any verb (the server mints the command; the project claims it).
    openAppPage: (page, id, vault) => {
      if (!vault) return;
      void fetch('/api/assistant/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vault, page: `${page}/${id}` }),
      }).catch(() => { /* the button stays; the next click retries */ });
    },
    signIn: async () => { /* sign in from a project window */ },
  }), [startSession]);

  const name = status?.config?.name ?? 'Assistant';
  const bubbles = pillBubbles(rollup);
  const label = pillLabel(rollup);
  // Asking, the pill says WHO in place of the assistant's own name: "acme needs you".
  const asker = glance.find((c) => c.activity === 'asking');
  const finishedVault = (finishedId ? handoffs.find((h) => h.sessionId === finishedId)?.vault ?? null : null)
    ?? recentFinishedVault(notices);
  // Folded while it works on the owner's request, the pill says WHAT it is doing.
  const self = session && busy && !expanded
    ? assistantActivityLine(session.getModel().items as unknown as ActivityItem[], progressLine)
    : null;
  const pillText = pillHeadline({ name, asker: asker?.vault ?? null, proposals: rollup.proposals, finished: finishedVault, handoffs, self, running: inbox.running });
  // The "Now" tab's count: everything that waits on the owner or is still running for them.
  const nowCount = glance.filter((c) => c.ask).length + proposals.length + inboxCount
    + handoffs.filter((h) => handoffPhase(h) === 'running').length;
  // "Now" lists a handed-off chat once, under Handed off — unless it is asking, which goes on top.
  const handedOff = new Set(handoffs.map((h) => h.sessionId));
  const liveRows = glance.filter((c) => c.ask || !handedOff.has(c.sessionId));
  const peekNow: PeekItem | null = !peekShown ? null
    : (peek === 'event' || peek === 'progress') ? eventPeek
      : (() => {
        const it = peekItem(glance, handoffs, peek === 'finished' ? finishedId : null);
        return it.kind === 'summary' ? { ...it, inbox: inboxCount, running: inbox.running } : it;
      })();
  const popped = seatMode === 'window';
  // Popped out there is no camera housing to straddle: the top row is a plain title bar.
  const hasNotch = !popped && !!geo && geo.notch_width > 0;
  const hotkeyMode = status?.config?.hotkey?.mode === 'toggle' ? 'toggle' : 'hold';

  return (
    <div
      ref={rootRef}
      data-mood={mood}
      className={`dc-notch surface-night${expanded ? ' dc-notch--open' : ''}${popped ? ' dc-notch--window' : ''}${attention || rollup.asking > 0 ? ' dc-notch--attention' : ''}${active && (popped || expanded) ? ' dc-notch--working' : ''}${peekShown ? ' dc-notch--peek' : ''}${(busyCount > 0 || busy) && !expanded ? ' dc-notch--busy' : ''}`}
      onPointerEnter={onHoverIn}
      onPointerLeave={onHoverOut}
      onPointerDown={engage}
      onKeyDown={engage}
    >
      {/* The working glow (Apple Intelligence's edge light): drawn while a turn runs or its
          answer is being spoken and the panel is open (folded, the pill's hairline says it).
          Pure decoration. */}
      {active && (popped || expanded) && <span className="dc-notch__glow" aria-hidden />}
      <button
        type="button"
        className="dc-notch__pill"
        onClick={popped ? undefined : expanded ? collapse : () => void expand()}
        onMouseDown={onPillMouseDown}
        style={{
          ['--notch-pill-h' as string]: `${pillHeight(geo)}px`,
          ...(hasNotch ? { ['--notch-gap' as string]: `${geo!.notch_width}px` } : {}),
        }}
        aria-expanded={expanded}
      >
        <span className="dc-notch__ear dc-notch__ear--left">
          {status?.avatar
            ? <img className="dc-notch__avatar" src={status.avatar} alt="" />
            : <span className="dc-notch__avatar dc-notch__avatar--initial">{name.slice(0, 1)}</span>}
          <span className="dc-notch__name">{pillText}</span>
        </span>
        {/* Always drawn: it is the grid's middle column (0 wide without a camera housing), so
            the right ear keeps the right column instead of dropping into the middle one. */}
        <span className="dc-notch__housing" aria-hidden />
        {/* The tab strip's own bubbles (ProjectTabs.tsx): green ring = a turn in flight,
            magenta = asking; idle and stale draw nothing, nor does an empty status. The picture
            is colour and a number, so the words ride along as the accessible name. */}
        <span
          className="dc-notch__ear dc-notch__ear--right"
          role="img"
          aria-label={`${label}${inbox.running.length ? `, ${inbox.running.length} automation${inbox.running.length === 1 ? '' : 's'} running` : ''}${inboxCount ? `, ${inboxCount} notification${inboxCount === 1 ? '' : 's'}` : ''}`}
          title={label}
        >
          {bubbles.length > 0 && (
            <span className="project-tab-bubbles dc-notch__bubbles" aria-hidden="true">
              {bubbles.map(({ state, count }) => (
                <span key={state} className="project-tab-bubble" data-state={state}>
                  {state === 'working' && <span className="project-tab-bubble-ring" aria-hidden="true" />}
                  <span className="project-tab-bubble-n">{count}</span>
                </span>
              ))}
            </span>
          )}
          {rollup.proposals > 0 && <span className="dc-notch__badge" aria-hidden="true">{rollup.proposals}</span>}
          {/* Automations at work, by face: their photos (an initial when none), up to three. */}
          {inbox.running.length > 0 && (
            <span className="dc-notch__agents" aria-hidden="true">
              {inbox.running.slice(0, 3).map((r) => (
                <AgentAvatar key={`${r.vault}::${r.slug}`} vault={r.vault} slug={r.slug} title={r.title} hasPhoto={r.hasPhoto} size={18} working />
              ))}
            </span>
          )}
          {inboxCount > 0 && <span className="dc-notch__inbox" aria-hidden="true">{inboxCount}</span>}
        </span>
      </button>

      {/* Hidden, never unmounted, while collapsed — see the header. The pill above already
          carries the name, so the bar holds only quiet actions. */}
      {/* The peek: one thing, said from the collapsed notch (see NotchPeek.tsx). */}
      {peekNow && (
        <NotchPeek
          ref={peekRef}
          item={peekNow}
          onOpenChat={() => void expand(peekNow.kind === 'summary' ? undefined : 'chat')}
          onDone={() => {
            const id = peekId(peekNow);
            if (id) hide(id);
            setPeek(null);
          }}
        />
      )}

      {/* Hidden, never unmounted, while collapsed — see the header. Two faces: "Now" (what
          every project is doing and what waits on the owner) and the conversation. */}
      <div className="dc-notch__panel" hidden={!expanded}>
        <div className="dc-notch__bar">
          <div className="dc-notch__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'now'} className="dc-notch__tab" onClick={() => { setTab('now'); setConvosOpen(false); }}>
              Now{nowCount > 0 && <span className="dc-notch__count">{nowCount}</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'chat'} className="dc-notch__tab" onClick={() => { setTab('chat'); window.setTimeout(() => sessionRef.current?.focus(), 0); }}>
              Chat
            </button>
          </div>
          <span className="dc-notch__spacer" />
          <button type="button" className="dc-notch__action" aria-expanded={convosOpen} onClick={() => setConvosOpen((v) => !v)} title="Earlier conversations">
            Conversations ▾
          </button>
          <button type="button" className="dc-notch__action" onClick={newConversation} title="Start fresh — this one stays in Conversations">＋</button>
          {popped
            ? <button type="button" className="dc-notch__action dc-notch__dock" onClick={dock} title="Put it back in the notch">Dock</button>
            : <button type="button" className="dc-notch__action dc-notch__popout" onClick={popOut} title="Open as a window">Pop out</button>}
        </div>
        {convosOpen && (
          <ConversationMenu
            vault={ASSISTANT_VAULT}
            currentId={session?.claudeId ?? null}
            onPick={switchConversation}
            onNew={newConversation}
            onClose={() => setConvosOpen(false)}
          />
        )}
        <div className="dc-notch__now" hidden={tab !== 'now' || convosOpen}>
          {liveRows.length > 0 && <GlanceList chats={liveRows} onAnswered={dropRow} />}
          {proposals.length > 0 && (
            <ProposalList
              proposals={proposals}
              keyed={!glance.some((c) => c.ask?.kind === 'permission')}
              onDecided={(id) => setProposals((p) => p.filter((x) => x.id !== id))}
            />
          )}
          <InboxList
            notices={notices}
            posts={posts}
            running={inbox.running}
            muted={inbox.muted}
            onNoticeGone={hide}
            onPostGone={hide}
          />
          {handoffs.length > 0 && <HandoffList handoffs={handoffs} onAnswered={dropRow} onDismiss={clearHandoff} />}
          {glance.length === 0 && proposals.length === 0 && handoffs.length === 0 && inboxCount === 0 && inbox.running.length === 0 && (
            <p className="dc-notch__empty">Nothing running and nothing waiting on you. Ask {name} to start something.</p>
          )}
        </div>
        <div className="dc-notch__chat" ref={hostRef} hidden={tab !== 'chat' || convosOpen} />
        {/* While the mic is open the notch says so, unmistakably (owner, 2026-10-04). */}
        <ListeningOverlay vault={ASSISTANT_VAULT} avatar={status?.avatar ?? null} name={name} mode={hotkeyMode} />
        {!status?.exists && status && (
          <p className="dc-notch__empty">Create the Assistant from the Launcher first.</p>
        )}
      </div>

      {session && createPortal(
        <ChatPaneHost
          session={session}
          actions={actions}
          modelConfig={modelConfig}
          model={session.model || modelConfig.defaultModel}
          effort={session.effort || modelConfig.defaultEffort}
          mode="assistant"
          permissionMode="auto"
          canSignInInApp={false}
          signInCommand="claude /login"
        />,
        session.container,
      )}
    </div>
  );
}
