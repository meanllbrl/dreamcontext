import {
  useEffect, useRef, useState, useReducer, useCallback, useLayoutEffect,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import './AgentTerminal.css';
import { api } from '../../api/client';
import { type SleepyMood } from './SleepyMascot';
import {
  createSession, currentZoom,
  type Capabilities, type Session, type TermStatus, type ConfirmRequest,
} from './agentSession';
import {
  AgentSlot, AgentControlsSlot,
  subscribeSlot, subscribeControlsSlot, getSlotEl, getControlsSlotEl,
} from './agentSlots';
import { PaneFragment } from './PaneFragment';
import { DockBubble } from './DockBubble';
import {
  ConfirmDialog, BypassToggle, BypassPill, Prereqs, Centered, BotMark,
  titleStyle, subStyle, primaryBtn, secondaryBtn,
} from './AgentSetup';

// Re-exported so SleepyPage keeps importing the slot anchors from one place.
export { AgentSlot, AgentControlsSlot };

/**
 * Agent — the REAL interactive Claude Code, in-app, MULTI-SESSION. Each session is
 * a server-side `node-pty` running `claude` in the active vault, bridged to a
 * GPU-rendered xterm. This file is the React ORCHESTRATOR; the imperative session
 * engine lives in `agentSession.ts`, the slot registries in `agentSlots.tsx`, and the
 * leaf views in `PaneFragment` / `DockBubble` / `AgentSetup`.
 *
 * ── Flat-session model ───────────────────────────────────────────────────────
 * Every session is its OWN pane with its OWN slim, RENAMEABLE title bar directly
 * above it (no separate tab strip). Sessions sit side by side in a resizable row;
 * a session you're not using can be MINIMIZED to a bubble in the bottom-right dock
 * (it keeps running) and restored with a click. The dock bubble shows, at a glance,
 * whether that agent is still working (Sleepy heads-down) or has finished and is
 * waving for you (plus a notification badge).
 *
 * ── Why an imperative session manager ────────────────────────────────────────
 * A session's xterm + WebSocket + running `claude` must survive (a) being minimized,
 * (b) reflowing as siblings open/close, and (c) navigating to another page and back.
 * If panes were plain React children, any of those would reparent the node and
 * remount — destroying scrollback and the live session. So each session owns a
 * DETACHED DOM container (created with `document.createElement`, never React-
 * rendered); the layout effect just `appendChild`s it into whichever pane slot is
 * visible and parks the rest in a hidden garage. Moving a raw DOM node never
 * remounts xterm. The whole surface is mounted ONCE (App.tsx), outside the page
 * router, so nothing tears down on navigation — only on explicit close or app quit.
 *
 * Desktop-only and capability-gated. Bypass-permissions is OFF by default (armed
 * explicitly per session, shown as a ⚡ on that session's header).
 */

// ── Layout model (flat; one entry per session) ──────────────────────────────────

interface SessionMeta {
  id: string;          // matches Session.id
  title: string;       // renameable; default "Agent N"
  bypass: boolean;
  minimized: boolean;  // docked as a bubble when true
  size: number;        // flex-grow weight in the visible row
}

// ── The persistent surface ─────────────────────────────────────────────────────

export function AgentSurface() {
  const slot = useSyncExternalStore(subscribeSlot, getSlotEl, () => null);
  const controlsSlot = useSyncExternalStore(subscribeControlsSlot, getControlsSlotEl, () => null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [capsError, setCapsError] = useState(false);
  const [bypass, setBypass] = useState(false); // default for NEW sessions
  const [sessionList, setSessionList] = useState<SessionMeta[]>([]);
  const [focusedSid, setFocusedSid] = useState('');
  const [, bumpStatus] = useReducer((x: number) => x + 1, 0);
  // A pending destructive confirmation (close/restart a live session), or null.
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // The session whose title is being edited inline (double-click / pencil), or ''.
  const [renamingId, setRenamingId] = useState('');

  const sessions = useRef<Map<string, Session>>(new Map());
  const slotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const garageRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const started = sessionList.length > 0;
  const visible = sessionList.filter(s => !s.minimized);
  const minimizedList = sessionList.filter(s => s.minimized);

  // ── Capabilities (fetched on mount; re-fetched after an in-app install so a
  //    freshly-installed prerequisite flips to ready without an app relaunch) ────
  const refreshCaps = useCallback(async (): Promise<Capabilities | null> => {
    try { const c = await api.get<Capabilities>('/agent/capabilities'); setCaps(c); return c; }
    catch { setCapsError(true); return null; }
  }, []);
  useEffect(() => { void refreshCaps(); }, [refreshCaps]);

  // ── Session actions ────────────────────────────────────────────────────────
  const spawn = useCallback((bp: boolean) => {
    const s = createSession(bp, bumpStatus);
    s.applyZoom(currentZoom());
    sessions.current.set(s.id, s);
    return s;
  }, []);

  const addSession = useCallback(() => {
    const s = spawn(bypass);
    const num = s.id.replace('agent-', '');
    setSessionList(prev => [...prev, { id: s.id, title: `Agent ${num}`, bypass: s.bypass, minimized: false, size: 1 }]);
    setFocusedSid(s.id);
  }, [spawn, bypass]);

  // All mutations are FUNCTIONAL (read `prev`, never a captured list) and read live
  // sessions from the ref — so a confirm sheet's stored onConfirm can never act on a
  // stale snapshot (the old "confirm, but it re-asks and never closes" bug).
  const closeSessionById = useCallback((sid: string) => {
    sessions.current.get(sid)?.dispose();   // idempotent
    sessions.current.delete(sid);
    setSessionList(prev => prev.filter(s => s.id !== sid));
    setFocusedSid(prev => (prev === sid ? '' : prev));
  }, []);

  const restartSessionById = useCallback((sid: string, bp: boolean) => {
    const old = sessions.current.get(sid);
    // The session may have been removed (e.g. closed directly while this restart
    // confirm was still open). Spawning anyway would create a PTY+WebSocket with no
    // SessionMeta to map it to → an orphan the user can never see or close. Bail.
    if (!old) return;
    const s = spawn(bp);
    setSessionList(prev => prev.map(m => (m.id === sid ? { ...m, id: s.id, bypass: s.bypass, minimized: false } : m)));
    setFocusedSid(s.id);
    old.dispose();
    sessions.current.delete(sid);
  }, [spawn]);

  const minimizeSession = useCallback((sid: string) => {
    const s = sessions.current.get(sid);
    if (s) s.minimized = true;
    setSessionList(prev => prev.map(m => (m.id === sid ? { ...m, minimized: true } : m)));
    setFocusedSid(prev => (prev === sid ? '' : prev));
  }, []);

  const restoreSession = useCallback((sid: string) => {
    const s = sessions.current.get(sid);
    if (s) { s.minimized = false; s.attention = false; }
    setSessionList(prev => prev.map(m => (m.id === sid ? { ...m, minimized: false } : m)));
    setFocusedSid(sid);
    requestAnimationFrame(() => sessions.current.get(sid)?.term.focus());
  }, []);

  const focusSession = useCallback((sid: string) => {
    setFocusedSid(sid);
    const s = sessions.current.get(sid);
    if (s) {
      if (s.attention) { s.attention = false; bumpStatus(); }
      s.term.focus();
    }
  }, []);

  const commitRename = useCallback((id: string, raw: string) => {
    const title = raw.trim();
    setRenamingId('');
    if (title) setSessionList(prev => prev.map(m => (m.id === id ? { ...m, title } : m)));
  }, []);

  // ── Guarded (confirmed) destructive actions ───────────────────────────────────
  // A session is "live" while its PTY is open (claude still running). Closing or
  // restarting a live session would kill an in-flight task, so we ask first — exactly
  // once. An already-ended session is torn down instantly (no nag).
  const isLive = useCallback((sid: string) => sessions.current.get(sid)?.status === 'open', []);

  const askClose = useCallback((sid: string, title: string) => {
    if (!isLive(sid)) { closeSessionById(sid); return; }
    setConfirm({
      title: 'End this session?',
      message: `Claude is still working in “${title}”. Ending it stops the current task — anything mid-flight won’t be finished.`,
      confirmLabel: 'End session',
      tone: 'danger',
      onConfirm: () => closeSessionById(sid),
    });
  }, [isLive, closeSessionById]);

  const askRestart = useCallback((sid: string, title: string, bp: boolean) => {
    if (!isLive(sid)) { restartSessionById(sid, bp); return; }
    setConfirm({
      title: 'Restart this session?',
      message: `The current Claude session in “${title}” will be stopped and a fresh one started in its place.`,
      confirmLabel: 'Restart',
      tone: 'accent',
      onConfirm: () => restartSessionById(sid, bp),
    });
  }, [isLive, restartSessionById]);

  // ── Place detached session containers into the active layout ──────────────────
  const fitVisible = useCallback(() => {
    sessionList.forEach(meta => {
      if (meta.minimized) return;
      const s = sessions.current.get(meta.id);
      if (!s) return;
      s.ensureOpen();
      s.fitAndResize();
    });
  }, [sessionList]);

  useLayoutEffect(() => {
    const visibleSet = new Set(sessionList.filter(s => !s.minimized).map(s => s.id));
    // Mirror visibility onto the Session objects so the idle timer can decide whether
    // a "finished" transition deserves a notification badge.
    sessions.current.forEach(s => { s.minimized = !visibleSet.has(s.id); });
    sessionList.forEach(meta => {
      if (meta.minimized) return;
      const s = sessions.current.get(meta.id);
      const host = slotRefs.current.get(meta.id);
      if (s && host) {
        if (s.container.parentElement !== host) host.appendChild(s.container);
        s.ensureOpen();
      }
    });
    // Park everything not currently visible in the hidden garage (keeps it alive).
    sessions.current.forEach(s => {
      if (!visibleSet.has(s.id) && garageRef.current && s.container.parentElement !== garageRef.current) {
        garageRef.current.appendChild(s.container);
      }
    });
    const raf = requestAnimationFrame(fitVisible);
    return () => cancelAnimationFrame(raf);
  }, [sessionList, fitVisible]);

  // ── Position the fixed surface over the active slot (persistence) ─────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!slot) { host.style.display = 'none'; return; }

    const sync = () => {
      const r = slot.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { host.style.display = 'none'; return; }
      host.style.display = 'flex';
      host.style.top = `${r.top}px`;
      host.style.left = `${r.left}px`;
      host.style.width = `${r.width}px`;
      host.style.height = `${r.height}px`;
      fitVisible();
    };
    sync();
    const raf = requestAnimationFrame(sync);
    const ro = new ResizeObserver(sync);
    ro.observe(slot);
    ro.observe(document.documentElement);
    window.addEventListener('resize', sync);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [slot, fitVisible]);

  // ── App zoom → terminal font size. The window's `- 100% +` control sets `--zoom`
  //    (scaling CSS font tokens) and broadcasts `dreamcontext-zoom`; xterm's size is
  //    imperative, so we resize every session's font to match and refit the grid. ──
  useEffect(() => {
    const onZoom = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const zoom = typeof detail === 'number' && detail > 0 ? detail : currentZoom();
      sessions.current.forEach(s => s.applyZoom(zoom));
    };
    window.addEventListener('dreamcontext-zoom', onZoom);
    return () => window.removeEventListener('dreamcontext-zoom', onZoom);
  }, []);

  // ── Keyboard: Cmd/Ctrl+D / +T new session · Cmd/Ctrl+W close focused ──────────
  // (No minimize hotkey: ⌘M collides with macOS window-minimize. Minimize is the
  //  header's – button.)
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !started) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'd' || k === 't') { e.preventDefault(); e.stopPropagation(); addSession(); }
      else if (k === 'w') {
        e.preventDefault(); e.stopPropagation();
        if (focusedSid) {
          const meta = sessionList.find(m => m.id === focusedSid);
          if (meta) askClose(focusedSid, meta.title);
        }
      }
    };
    host.addEventListener('keydown', onKey, true);
    return () => host.removeEventListener('keydown', onKey, true);
  }, [started, addSession, askClose, focusedSid, sessionList]);

  // ── Divider drag (resize adjacent VISIBLE panes) ──────────────────────────────
  const startResize = (visIndex: number, ev: React.PointerEvent) => {
    ev.preventDefault();
    const vis = sessionList.filter(s => !s.minimized);
    const a = vis[visIndex], b = vis[visIndex + 1];
    const row = (ev.currentTarget as HTMLElement).parentElement;
    if (!a || !b || !row) return;
    const total = row.getBoundingClientRect().width;
    const startX = ev.clientX;
    const sa = a.size, sb = b.size, sum = sa + sb;
    const aId = a.id, bId = b.id;
    const onMove = (m: PointerEvent) => {
      const dx = m.clientX - startX;
      const ratio = Math.max(0.12, Math.min(0.88, (sa + (dx / total) * sum) / sum));
      setSessionList(prev => prev.map(mm =>
        mm.id === aId ? { ...mm, size: ratio * sum }
          : mm.id === bId ? { ...mm, size: (1 - ratio) * sum }
            : mm));
      fitVisible();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      fitVisible();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const openExternal = async () => {
    try { await api.post('/agent/open-terminal', { bypass }); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not open Terminal.'); }
  };

  // ── Body ──────────────────────────────────────────────────────────────────────
  let body: React.ReactNode;
  if (capsError) {
    body = <Centered>
      <h2 style={titleStyle}>Agent unavailable</h2>
      <p style={subStyle}>Couldn't reach the agent service. Try reloading the app.</p>
    </Centered>;
  } else if (!caps) {
    body = <Centered><p style={{ ...subStyle, color: 'var(--color-text-tertiary)' }}>Checking agent capabilities…</p></Centered>;
  } else if (!caps.desktop) {
    body = <Centered>
      <BotMark />
      <h2 style={titleStyle}>Agent runs in the desktop app</h2>
      <p style={subStyle}>The in-app Claude Code agent is a desktop-only feature — it runs a real, interactive Claude Code session scoped to this project. Use <strong>Ask</strong> here for read-only questions.</p>
    </Centered>;
  } else if (started && caps.embeddedTerminal) {
    body = (
      <div className="agent-term">
        {/* The bypass default + new-session controls live in SleepyPage's top bar,
            across from the Search/Ask/Agent tabs — portaled there via AgentControlsSlot. */}

        {/* Visible sessions, side by side; each carries its own renameable header. */}
        <div className="agent-panes">
          {visible.length === 0 ? (
            <div className="agent-allmin">
              <div className="agent-allmin-text">All sessions minimized</div>
              <div className="agent-allmin-sub">Click a bubble to bring one back, or start a new one.</div>
              <button className="agent-allmin-btn" onClick={addSession}>+ New session</button>
            </div>
          ) : visible.map((meta, i) => {
            const s = sessions.current.get(meta.id);
            return (
              <PaneFragment
                key={meta.id}
                sid={meta.id}
                title={meta.title}
                grow={meta.size}
                multi={visible.length > 1}
                last={i === visible.length - 1}
                status={s?.status ?? 'connecting'}
                busy={!!s?.busy}
                bypassOn={meta.bypass}
                focused={focusedSid === meta.id}
                renaming={renamingId === meta.id}
                slotRefs={slotRefs}
                onFocusPane={() => focusSession(meta.id)}
                onStartRename={() => setRenamingId(meta.id)}
                onCommitRename={(v) => commitRename(meta.id, v)}
                onCancelRename={() => setRenamingId('')}
                onMinimize={() => minimizeSession(meta.id)}
                onClose={() => askClose(meta.id, meta.title)}
                onRestart={() => askRestart(meta.id, meta.title, meta.bypass)}
                onResizeStart={(e) => startResize(i, e)}
              />
            );
          })}
        </div>

        {/* Minimized dock — vertical bubbles, bottom-right, with working/done state. */}
        {minimizedList.length > 0 && (
          <div className="agent-dock">
            {minimizedList.map(meta => {
              const s = sessions.current.get(meta.id);
              const status: TermStatus = s?.status ?? 'connecting';
              // One distinct collapsed state per session phase:
              //   closed     → sleeping  (calm indigo, eyes shut)
              //   connecting → thinking  (amber, pondering eyes)
              //   busy        → working  (green, scanning eyes)
              //   idle/open   → waiting  (magenta, waving + notification chip)
              const mood: SleepyMood =
                status === 'closed' ? 'sleeps'
                  : status === 'connecting' ? 'thinking'
                    : s?.busy ? 'working'
                      : 'waving';
              return (
                <DockBubble
                  key={meta.id}
                  title={meta.title}
                  mood={mood}
                  status={status}
                  attention={!!s?.attention}
                  onClick={() => restoreSession(meta.id)}
                  onClose={() => askClose(meta.id, meta.title)}
                />
              );
            })}
          </div>
        )}

        {/* Garage — keeps backgrounded sessions mounted & alive (never visible). */}
        <div ref={garageRef} className="agent-garage" aria-hidden />
      </div>
    );
  } else {
    body = (
      <Centered>
        <BotMark />
        <h2 style={titleStyle}>Agent — real Claude Code</h2>
        <p style={subStyle}>
          A full interactive Claude Code session running right here, scoped to this project.
          Open as many as you need — each gets its own <strong>renameable</strong> pane, and
          you can <strong>minimize</strong> any of them to the dock while they keep running.
        </p>
        <BypassToggle bypass={bypass} setBypass={setBypass} />
        {(() => {
          // The embedded terminal is usable only when BOTH its renderer (node-pty)
          // and the `claude` binary it spawns are present. Missing either → show the
          // in-app Setup panel rather than silently spawning a shell that 404s claude.
          const ready = caps.embeddedTerminal && caps.claudeCli;
          return (
            <>
              <div style={{ display: 'flex', gap: '12px', marginTop: '22px', flexWrap: 'wrap', justifyContent: 'center' }}>
                {ready && (
                  <button onClick={addSession} style={primaryBtn}>▸ Start agent in app</button>
                )}
                {caps.openTerminal && (
                  <button onClick={openExternal} style={ready ? secondaryBtn : primaryBtn}>↗ Open in Terminal</button>
                )}
              </div>
              {!ready && <Prereqs caps={caps} onRefresh={refreshCaps} />}
            </>
          );
        })()}
      </Centered>
    );
  }

  return (
    <div ref={hostRef} className="agent-surface">
      {body}
      {/* Bypass default + new-session controls, portaled into SleepyPage's top bar
          (across from the Search/Ask/Agent tabs) once the terminal is live. */}
      {controlsSlot && started && caps?.embeddedTerminal && createPortal(
        <div className="agent-controls-bar">
          <BypassPill bypass={bypass} setBypass={setBypass} />
          <button className="agent-add-btn" title="New session (⌘T)" aria-label="New session" onClick={addSession}>+</button>
        </div>,
        controlsSlot,
      )}
      {confirm && (
        <ConfirmDialog
          req={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const fn = confirm.onConfirm; setConfirm(null); fn(); }}
        />
      )}
    </div>
  );
}
