import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ChatPaneHost, type ChatSurfaceActions } from '../sleepy/ChatPaneHost';
import { createChatSession, type ChatSession } from '../sleepy/chatSession';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { isDesktop } from '../../lib/desktop';
import { executeAssistantCommand, onAssistantNotify } from './commandExecutor';
import { ProposalList, type Proposal } from './ProposalList';
import { EMPTY_ROLLUP, pillBubbles, pillLabel, readRollup, type Rollup } from './notchModel';
import { emitExternalPushToTalk } from '../../lib/voice/externalPushToTalk';
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
const PANEL_W = 460;
const PANEL_H = 400;
/** Popped out: an ordinary window's size, until the owner resizes it. */
const WINDOW_W = 720;
const WINDOW_H = 640;

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
 * THE FRAME THE NOTCH SEAT MUST HAVE, and who is allowed to set it.
 *
 * The owner's recording (2026-09-27): after every Space switch the collapsed notch came back
 * a moment later at the OPEN panel's 460x400 — an empty black box with the pill floating in
 * its middle — and the next switch put it back, with no click and no hotkey. The window's real
 * frame and the notch's state had parted ways. Two rules keep them together:
 * - latest wins: every seat change bumps `seatGen`, and a call that wakes up (every native call
 *   is an await) after a newer one stops, so a collapse can never land under a late expand;
 * - the frame is re-asserted: `wanted` is the notch seat's frame (null when popped out — a
 *   window is the owner's to size), and `healSeat` puts the window back on it whenever it
 *   resized, moved, or simply drifted (see the guard in `Notch`).
 */
let seatGen = 0;
let wanted: ReturnType<typeof notchFrame> | null = null;

async function applyFrame(f: ReturnType<typeof notchFrame>): Promise<void> {
  const { getCurrentWindow, LogicalPosition, LogicalSize } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  await win.setSize(new LogicalSize(f.width, f.height));
  if (f.x !== undefined && f.y !== undefined) await win.setPosition(new LogicalPosition(f.x, f.y));
}

/** Size + seat the window for a state. */
async function seat(expanded: boolean, geo: Geometry | null): Promise<void> {
  if (!isDesktop()) return;
  const gen = ++seatGen;
  const f = notchFrame(expanded, geo);
  wanted = f;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (!(await win.isVisible())) await win.show();
    if (gen !== seatGen) return;
    await applyFrame(f);
    if (expanded && gen === seatGen) await win.setFocus();
  } catch { /* ACL / no runtime — the browser preview just renders */ }
}

/**
 * Put the notch back on `wanted` if the window is not there. Returns true when it had to.
 * A seat change in flight owns the frame, so a heal that sees one steps aside.
 */
async function healSeat(): Promise<boolean> {
  const f = wanted;
  if (!f || !isDesktop()) return false;
  const gen = seatGen;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (!(await win.isVisible())) return false;
    const scale = await win.scaleFactor();
    const size = (await win.innerSize()).toLogical(scale);
    const pos = (await win.outerPosition()).toLogical(scale);
    if (gen !== seatGen || f !== wanted) return false;
    const off = (a: number, b: number) => Math.abs(a - b) > 2;
    const drifted = off(size.width, f.width) || off(size.height, f.height)
      || (f.x !== undefined && f.y !== undefined && (off(pos.x, f.x) || off(pos.y, f.y)));
    if (!drifted) return false;
    await applyFrame(f);
    return true;
  } catch {
    return false;
  }
}

/**
 * Change seats natively (desktop/src-tauri/src/assistant.rs `apply_seat`: level, resizable,
 * min size, shadow). The SAME window and webview move; nothing is rebuilt or reloaded.
 */
async function nativeSeat(to: Seat): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('assistant://seat', { seat: to });
  } catch { /* no runtime */ }
}

/** Float as a window: where it last was, or an ordinary size near the top third of the screen. */
async function seatWindow(geo: Geometry | null, last: Frame | null): Promise<void> {
  if (!isDesktop()) return;
  seatGen++;
  wanted = null;
  try {
    const { getCurrentWindow, LogicalPosition, LogicalSize } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const f = last ?? (geo
      ? { x: geo.x + (geo.width - WINDOW_W) / 2, y: geo.y + Math.max(48, (geo.height - WINDOW_H) / 3), width: WINDOW_W, height: WINDOW_H }
      : null);
    if (!(await win.isVisible())) await win.show();
    await win.setSize(new LogicalSize(f?.width ?? WINDOW_W, f?.height ?? WINDOW_H));
    if (f) await win.setPosition(new LogicalPosition(f.x, f.y));
    await win.setFocus();
  } catch { /* ACL / no runtime */ }
}

/** Where the floating window is now, so docking and popping out again lands it back there. */
async function readFrame(): Promise<Frame | null> {
  if (!isDesktop()) return null;
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
  seatGen++;
  wanted = null;
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
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;

  const startSession = useCallback((conversationId: string | null) => {
    const id = conversationId ?? crypto.randomUUID();
    if (!conversationId) void saveConversationId(id);
    const cs = createChatSession(ASSISTANT_VAULT, false, bump, id, !!conversationId, '', '', '', '', false, 'assistant');
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
        const res = await fetch('/api/assistant/status');
        const st = await res.json() as AssistantStatus;
        if (!alive) return;
        setStatus(st);
        if (st.exists && st.config) startSession(st.config.conversationId);
      } catch { /* server not up yet — the pill stays empty */ }
      const g = await readGeometry();
      if (alive) { setGeo(g); void seat(false, g); }
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
    // Leaving the notch seat: the guard must stop holding the notch frame NOW, not after the
    // native seat change lands.
    seatGen++;
    wanted = null;
    seatRef.current = 'window';
    setSeatMode('window');
    setExpanded(true);
    void nativeSeat('window').then(() => seatWindow(geo, frameRef.current)).then(() => sessionRef.current?.focus());
  }, [geo]);
  const dock = useCallback(() => {
    seatRef.current = 'notch';
    setSeatMode('notch');
    setExpanded(true);
    void readFrame()
      .then((f) => { if (f) frameRef.current = f; return nativeSeat('notch'); })
      .then(() => seat(true, geo))
      .then(() => sessionRef.current?.focus());
  }, [geo]);

  // Popped out, the top row is the title bar: drag the window from anywhere on it.
  const onPillMouseDown = useCallback((e: React.MouseEvent) => {
    if (seatRef.current !== 'window' || e.button !== 0 || !isDesktop()) return;
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

  // The seat guard (see `wanted`): a resize or move the notch did not ask for is undone at once,
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
    const cs = createChatSession(ASSISTANT_VAULT, false, bump, id, false, '', '', '', '', false, 'assistant');
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
    <div className={`dc-notch surface-night${expanded ? ' dc-notch--open' : ''}${popped ? ' dc-notch--window' : ''}${attention || rollup.asking > 0 ? ' dc-notch--attention' : ''}`}>
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
