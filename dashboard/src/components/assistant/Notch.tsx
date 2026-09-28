import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ChatPaneHost, type ChatSurfaceActions } from '../sleepy/ChatPaneHost';
import { createChatSession, type ChatSession } from '../sleepy/chatSession';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { isDesktop } from '../../lib/desktop';
import { frameMotionMs, setFrames, type FrameItem, type MinPreset } from '../../lib/windowFrames';
import { claimSeat, flying, healSeat, isCurrentSeat, setSeatWindow, wantSeat, withFlight, type SeatFrame } from './seatGuard';
import { executeAssistantCommand, onAssistantNotify } from './commandExecutor';
import { ProposalList, type Proposal } from './ProposalList';
import { EMPTY_ROLLUP, pillBubbles, pillLabel, readRollup, type Rollup } from './notchModel';
import { emitExternalPushToTalk } from '../../lib/voice/externalPushToTalk';
import { readAloudEnabled } from '../../lib/voice/readAloud';
import { initAgentSettingsFromServer, readAgentSettings } from '../../lib/agentSettings';
// The pill's right ear draws the tab strip's own status bubbles (`project-tab-bubble*`); the
// rules are global class selectors, so they are shared, not copied.
import '../layout/ProjectTabs.css';
import './notch.css';

/**
 * The dreamcontext Assistant's notch — the window labelled `assistant` (`?assistant=1`), a
 * non-activating panel at the top of the screen (desktop/src-tauri/src/assistant.rs).
 *
 * TWO STATES, ONE MOUNT. Collapsed it is a pill (avatar, name, "2 working · 1 asking",
 * proposals); expanded it is the SAME ChatPane + Composer every project uses, on the hidden
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
/** Popped out ON ITS OWN while it works: a narrower panel standing at the screen's edge. */
const SIDE_W = 480;
const SIDE_H = 620;
const SIDE_MARGIN = 16;
/** After the turn and its speech end, how long it stays before going home to the notch. */
const HOME_AFTER_SPOKEN_MS = 1500;
/** The same, when nothing was read aloud: the answer has to be READ, which takes longer. */
const HOME_AFTER_SILENT_MS = 8000;
/** The leave / arrive animations (notch.css `dc-notch-leave` / `dc-notch-arrive`). */
const LEAVE_MS = 280;

/** Where the assistant sits: grown out of the notch, or floating as its own window. */
type Seat = 'notch' | 'window';
interface Frame { x: number; y: number; width: number; height: number }

interface AssistantStatus {
  exists: boolean;
  config: { name: string; conversationId: string | null; hotkey: { mode: 'hold' | 'toggle' } | null } | null;
  avatar: string | null;
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
 * Size + seat the window for a state. `claimed` is a seat change the caller already claimed
 * (synchronously, at the click) — it is dropped if a newer one came since. The notch seat never
 * has a min size, so it always clears one a popped-out window left behind.
 */
async function seat(expanded: boolean, geo: Geometry | null, ms: number = frameMotionMs(), claimed?: number): Promise<void> {
  if (!isDesktop()) return;
  const f = notchFrame(expanded, geo);
  const gen = claimed ?? claimSeat(f);
  if (!wantSeat(gen, f)) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (!(await win.isVisible())) await win.show();
    if (!isCurrentSeat(gen)) return;
    await Promise.all([applyFrame(f, ms, 'clear'), expanded ? win.setFocus() : undefined]);
  } catch { /* ACL / no runtime — the browser preview just renders */ }
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
  if (!isDesktop()) return;
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

/** The side seat: top-right, under the menu bar — out of the way of what the owner is doing. */
function sideFrame(geo: Geometry | null): Frame | null {
  if (!geo) return null;
  const top = Math.max(geo.notch_height, PILL_H) + SIDE_MARGIN / 2;
  return { x: geo.x + geo.width - SIDE_W - SIDE_MARGIN, y: geo.y + top, width: SIDE_W, height: SIDE_H };
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
  const [attention, setAttention] = useState(false);
  const [geo, setGeo] = useState<Geometry | null>(null);
  // Remembered for the whole app run: the webview is never reloaded, so every hotkey summon
  // after a pop-out opens the window, until the owner docks it.
  const [seatMode, setSeatMode] = useState<Seat>('notch');
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ChatSession | null>(null);
  const expandedRef = useRef(false);
  expandedRef.current = expanded;
  const seatRef = useRef<Seat>('notch');
  seatRef.current = seatMode;
  const frameRef = useRef<Frame | null>(null);
  /** This pop-out was made by the notch itself (a turn started), so it may go home by itself. */
  const autoRef = useRef(false);
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;

  const startSession = useCallback((conversationId: string | null) => {
    const id = conversationId ?? crypto.randomUUID();
    if (!conversationId) void saveConversationId(id);
    // The owner's "Set as default" model and effort, like every other new chat — not the CLI's
    // own default, which is what an empty pair would inherit (Extra High on this machine).
    const { chatDefaultModel, chatDefaultEffort } = readAgentSettings();
    const cs = createChatSession(ASSISTANT_VAULT, false, bump, id, !!conversationId, chatDefaultModel, chatDefaultEffort, '', '', false, 'assistant');
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
      } catch { /* transient */ }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => onAssistantNotify((_text, level) => { if (level === 'attention') setAttention(true); }), []);

  const expand = useCallback(() => {
    setExpanded(true);
    setAttention(false);
    const seated = seatRef.current === 'window' ? seatWindow(geo, frameRef.current) : seat(true, geo);
    void seated.then(() => sessionRef.current?.focus());
  }, [geo]);
  // Popped out, "collapse" hides the window (still mounted, still connected) instead of
  // shrinking it to a pill; the next summon brings the window back.
  const collapse = useCallback(() => {
    setExpanded(false);
    if (seatRef.current === 'window') {
      void readFrame().then((f) => { if (f) frameRef.current = f; return hideWindow(); });
    } else {
      void seat(false, geo);
    }
  }, [geo]);

  // Pop out / dock: the SAME webview changes seats. Never an unmount, never a reload.
  const popOut = useCallback(() => {
    autoRef.current = false;                // the owner's own pop-out stays until they dock
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
    autoRef.current = false;
    const gen = claimSeat(null);
    seatRef.current = 'notch';
    setSeatMode('notch');
    setExpanded(true);
    void readFrame()
      .then((f) => { if (f) frameRef.current = f; return nativeSeat('notch'); })
      .then(() => seat(true, geo, frameMotionMs(), gen))
      .then(() => sessionRef.current?.focus());
  }, [geo]);

  // ── WHILE IT WORKS, IT STEPS OUT (owner, 2026-09-27) ─────────────────────────────────
  // "İsteyim. Yapsın. Yaparken kenarda böyle dursun. Sonra cevabını söylesin ve kapansın."
  // A turn starting pops the panel out to the SIDE seat by itself, wearing the working glow;
  // when the turn is over AND its answer has been spoken, it animates back into the notch.
  // Only a pop-out it made itself goes home on its own: one the owner made, docked or dragged
  // stays where they put it. It never takes focus — the owner may be typing somewhere else.
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => session?.onSpeaking(setSpeaking), [session]);
  const active = !!session?.busy || speaking;
  const [motion, setMotion] = useState<'arrive' | 'leave' | null>(null);
  // Clicked or typed into while it stood out on its own: the owner is using it, so it is
  // theirs now and stays (they dismiss it like any pop-out). A voice follow-up through the
  // hotkey arrives from Rust, not from this DOM, and keeps the automatic round trip.
  const engage = useCallback(() => {
    if (autoRef.current && seatRef.current === 'window') autoRef.current = false;
  }, []);

  const autoPop = useCallback(() => {
    autoRef.current = true;
    const gen = claimSeat(null);
    seatRef.current = 'window';
    setSeatMode('window');
    setExpanded(true);
    setMotion('arrive');
    // Without the monitor's geometry there is no edge to stand at, but it is still the side size.
    // The CSS arrive animation is what moves; the frame lands under it in one step (0ms).
    void nativeSeat('window').then(() => seatWindow(geo, sideFrame(geo) ?? { width: SIDE_W, height: SIDE_H }, false, 0, gen));
    window.setTimeout(() => setMotion(null), LEAVE_MS + 80);
  }, [geo]);

  const goHome = useCallback(() => {
    setMotion('leave');
    window.setTimeout(() => {
      autoRef.current = false;
      seatRef.current = 'notch';
      setSeatMode('notch');
      setExpanded(false);
      setMotion(null);
      // Faded out by the CSS leave animation: the frame lands in one step (0ms), not behind it.
      const gen = claimSeat(null);
      void nativeSeat('notch').then(() => seat(false, geo, 0, gen));
    }, LEAVE_MS);
  }, [geo]);

  const wasActive = useRef(false);
  useEffect(() => {
    const rose = active && !wasActive.current;
    wasActive.current = active;
    if (rose && seatRef.current === 'notch') autoPop();
  }, [active, autoPop]);

  useEffect(() => {
    if (active || !autoRef.current || seatRef.current !== 'window') return;
    const t = window.setTimeout(() => {
      if (autoRef.current && seatRef.current === 'window') goHome();
    }, readAloudEnabled() ? HOME_AFTER_SPOKEN_MS : HOME_AFTER_SILENT_MS);
    return () => window.clearTimeout(t);
  }, [active, goHome, seatMode]);

  // Popped out, the top row is the title bar: drag the window from anywhere on it.
  const onPillMouseDown = useCallback((e: React.MouseEvent) => {
    if (seatRef.current !== 'window' || e.button !== 0 || !isDesktop()) return;
    // Moved by hand, it is the owner's window now: it no longer goes home by itself.
    autoRef.current = false;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().startDragging()).catch(() => { /* no runtime */ });
  }, []);

  // Hotkey edges from Rust (assistant://hotkey) — the ONE chord that summons the notch AND
  // talks to it. Hold: press summons and opens the mic, release closes it (a tap just opens
  // the panel). Toggle (the fallback when a Released edge cannot be trusted): press summons and
  // opens the mic, the next press sends, a press with nothing recording dismisses.
  //
  // The summoning press un-hides the panel SYNCHRONOUSLY (flushSync) before the edge goes to
  // the composer: `ownsPushToTalk` only answers for a VISIBLE composer, and a hidden one would
  // let the owner's first sentence fall on the floor.
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
          if (edge === 'released') { emitExternalPushToTalk({ edge, mode, summon: false }); return; }
          if (edge !== 'pressed') return;
          if (!expandedRef.current) {
            flushSync(() => setExpanded(true));
            expand();
            emitExternalPushToTalk({ edge, mode, summon: true });
            return;
          }
          const acted = emitExternalPushToTalk({ edge, mode, summon: false });
          if (!acted && mode === 'toggle') collapse();
        });
        if (cancelled) fn(); else unlisten = fn;
      } catch { /* no runtime */ }
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [expand, collapse, status]);

  // Esc and click-outside collapse the notch. Never an unmount. A popped-out window is a
  // window: it stays open when the owner clicks elsewhere or presses Esc in it.
  useEffect(() => {
    if (!expanded || seatMode === 'window') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) collapse(); };
    window.addEventListener('keydown', onKey);
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    if (isDesktop()) {
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const fn = await getCurrentWindow().onFocusChanged(({ payload: focused }) => { if (!focused) collapse(); });
          if (cancelled) fn(); else unlisten = fn;
        } catch { /* no runtime */ }
      })();
    }
    return () => { cancelled = true; window.removeEventListener('keydown', onKey); unlisten?.(); };
  }, [expanded, collapse, seatMode]);

  // The seat guard (seatGuard.ts): a resize or move the notch did not ask for is undone at once,
  // and a slow check catches a frame that changed without telling anyone (a Space switch). A
  // frame macOS keeps refusing is given up on after a few tries instead of fought every second.
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let streak = 0;
    const check = () => {
      if (streak >= 4) return;
      void healSeat().then((healed) => { streak = healed ? streak + 1 : 0; });
    };
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
    const { chatDefaultModel, chatDefaultEffort } = readAgentSettings();
    const cs = createChatSession(ASSISTANT_VAULT, false, bump, id, false, chatDefaultModel, chatDefaultEffort, '', '', false, 'assistant');
    cs.setCommandHandler(executeAssistantCommand);
    sessionRef.current = cs;
    setSession(cs);
  }, []);

  const actions = useMemo<ChatSurfaceActions>(() => ({
    changeModel: (_sid, id) => sessionRef.current?.setModel(id),
    changeEffort: (_sid, level) => sessionRef.current?.setEffort(level),
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
    signIn: () => { /* sign in from a project window */ },
  }), [startSession]);

  const name = status?.config?.name ?? 'Assistant';
  const bubbles = pillBubbles(rollup);
  const label = pillLabel(rollup);
  const popped = seatMode === 'window';
  // Popped out there is no camera housing to straddle: the top row is a plain title bar.
  const hasNotch = !popped && !!geo && geo.notch_width > 0;

  return (
    <div
      className={`dc-notch surface-night${expanded ? ' dc-notch--open' : ''}${popped ? ' dc-notch--window' : ''}${attention || rollup.asking > 0 ? ' dc-notch--attention' : ''}${active && popped ? ' dc-notch--working' : ''}${motion ? ` dc-notch--${motion}` : ''}`}
      onPointerDown={engage}
      onKeyDown={engage}
    >
      {/* The working glow (Apple Intelligence's edge light): drawn only while a turn runs or
          its answer is being spoken, in the popped-out seat. Pure decoration. */}
      {active && popped && <span className="dc-notch__glow" aria-hidden />}
      <button
        type="button"
        className="dc-notch__pill"
        onClick={popped ? undefined : expanded ? collapse : expand}
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
          <span className="dc-notch__name">{name}</span>
        </span>
        {/* Always drawn: it is the grid's middle column (0 wide without a camera housing), so
            the right ear keeps the right column instead of dropping into the middle one. */}
        <span className="dc-notch__housing" aria-hidden />
        {/* The tab strip's own bubbles (ProjectTabs.tsx): green ring = a turn in flight,
            magenta = asking, grey = idle or stale; an empty status draws nothing. The picture
            is colour and a number, so the words ride along as the accessible name. */}
        <span className="dc-notch__ear dc-notch__ear--right" role="img" aria-label={label} title={label}>
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
        </span>
      </button>

      {/* Hidden, never unmounted, while collapsed — see the header. The pill above already
          carries the name, so the bar holds only quiet actions. */}
      <div className="dc-notch__panel" hidden={!expanded}>
        <div className="dc-notch__bar">
          <button type="button" className="dc-notch__action" onClick={newConversation}>New conversation</button>
          {popped
            ? <button type="button" className="dc-notch__action dc-notch__dock" onClick={dock} title="Put it back in the notch">Dock</button>
            : <button type="button" className="dc-notch__action dc-notch__popout" onClick={popOut} title="Open as a window">Pop out</button>}
        </div>
        {proposals.length > 0 && <ProposalList proposals={proposals} onDecided={(id) => setProposals((p) => p.filter((x) => x.id !== id))} />}
        <div className="dc-notch__chat" ref={hostRef} />
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
