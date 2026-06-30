import {
  useEffect, useRef, useState, useReducer, useCallback, useLayoutEffect,
} from 'react';
import './AgentTerminal.css';
import { api, getActiveVault } from '../../api/client';
import {
  createSession, currentZoom,
  type Capabilities, type Session,
} from './agentSession';
import { deriveSessionStatus, type SessionRow } from './agentStatus';
import { PaneFragment } from './PaneFragment';
import { AgentTabs, type PaneVM } from './AgentTabs';
import { AgentDock } from './AgentDock';
import { AgentFab } from './AgentFab';
import {
  BypassToggle, BypassPill, Prereqs, Centered, BotMark,
  titleStyle, subStyle, primaryBtn, secondaryBtn,
} from './AgentSetup';

/**
 * Agent — the REAL interactive Claude Code, in-app, MULTI-SESSION. Each session is
 * a server-side `node-pty` running `claude` in the active vault, bridged to a
 * GPU-rendered xterm. This file is the React ORCHESTRATOR; the imperative session
 * engine lives in `agentSession.ts`, the status taxonomy in `agentStatus.ts`, and the
 * leaf views in `AgentTabs` / `PaneFragment` / `AgentDock` / `AgentSetup`.
 *
 * ── Presentation model: top-bar tabs + side-by-side panes ────────────────────────
 * EXPANDED, the overlay is a TOP-BAR tab strip (every session as a tab, grouped per
 * pane) above a row of side-by-side PANES. Each pane renders ONLY its active session's
 * terminal. `panes: {id, tabs[], active}[]` is the layout: ⌘D spawns a fresh agent into
 * a NEW pane (split); ⌘T/＋ adds a tab to the active pane; dragging a tab onto another
 * pane's centre COMBINES it there, onto an edge SPLITS it into a new pane, onto a tab
 * REORDERS. COLLAPSED, each session is a horizontal chip in the bottom-right dock
 * (`AgentDock`); with zero sessions a lone "Agent" FAB is the entry point.
 *
 * ── Why an imperative session manager ────────────────────────────────────────────
 * A session's xterm + WebSocket + running `claude` must survive (a) becoming the active
 * tab of a different pane, (b) MOVING between panes, (c) collapsing/expanding the
 * overlay, and (d) navigating to another page and back. If panes were plain React
 * children, any of those would reparent the node and remount — destroying scrollback and
 * the live session. So each session owns a DETACHED DOM container (created with
 * `document.createElement`, never React-rendered); the layout effect just `appendChild`s
 * each pane's ACTIVE session container into that pane's slot (matched by `data-pane`) and
 * parks every other session in a hidden garage. Moving a raw DOM node never remounts
 * xterm. The whole surface is mounted ONCE (App.tsx), outside the page router, so nothing
 * tears down on navigation — only on explicit close or app quit.
 *
 * Desktop-only and capability-gated. Bypass-permissions is OFF by default (armed
 * explicitly per session, shown as a ⚡ on that session's tab).
 */

// ── Layout model ─────────────────────────────────────────────────────────────────

interface SessionMeta {
  id: string;          // matches Session.id (or a synthetic `restored-N` while dormant)
  title: string;       // renameable; default "Agent N"
  bypass: boolean;
  claudeId: string;    // the Claude conversation UUID (persisted → `claude --resume` on reopen)
  dormant?: boolean;   // a restored roster entry with NO live Session yet (Resume to spawn)
}

/** A fresh Claude conversation UUID for a new tab. `crypto.randomUUID()` works on the
 *  loopback (secure-context) origin; the manual RFC-4122-shaped fallback only fires if
 *  it's ever unavailable, so a tab always has a resumable id. */
function newClaudeId(): string {
  try { return crypto.randomUUID(); } catch { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16); const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** One pane of the side-by-side layout: an ordered tab group with one active session. */
interface PaneState {
  id: string;
  tabs: string[];      // session ids, in tab order
  active: string;      // which tab's terminal this pane shows
}

let paneSeq = 0;
const nextPaneId = () => `pane-${++paneSeq}`;

/** Where a tab will land when the drag ends, recorded during dragover (the `drop` event
 *  is unreliable in WKWebView, so we act on the source tab's reliable `dragend`). */
type DropTarget =
  | { kind: 'zone'; paneId: string; zone: 'left' | 'center' | 'right' }
  | { kind: 'group'; paneId: string }
  | { kind: 'reorder'; paneId: string; beforeSid: string };

/**
 * The persisted shape of one roster entry (server `/api/agent/sessions`). Titles only —
 * never a live PTY — so renamed tabs survive a reload as dormant "Resume" tabs (no
 * auto-spawn of claude on launch). `minimized`/`size` are retained for persistence-format
 * compatibility but the pane layout itself is not persisted — restored tabs reopen in a
 * single pane.
 */
interface SavedMeta {
  title: string;
  bypass: boolean;
  minimized: boolean;
  size: number;
  sessionId?: string;
}

/**
 * POSIX-safe rendering of a dropped image's absolute path for injection into the PTY:
 * always strip control chars (a newline would submit / inject an extra command), then
 * leave a simple path bare (best chance Claude reads it as a path) or single-quote-escape
 * one with spaces/special chars (mirrors `agent-terminal.ts:192`).
 */
function quoteIfNeeded(p: string): string {
  const clean = [...p].filter((ch) => { const c = ch.codePointAt(0) ?? 0; return c >= 0x20 && c !== 0x7f; }).join('');
  if (/^[\w@%+=:,./-]+$/.test(clean)) return clean;
  return `'${clean.replace(/'/g, "'\\''")}'`;
}

/** Remove a session id from a pane, keeping `active` pointing at a surviving tab. */
function removeFromPane(p: PaneState, sid: string): PaneState {
  if (!p.tabs.includes(sid)) return p;
  const tabs = p.tabs.filter((t) => t !== sid);
  return { ...p, tabs, active: p.active === sid ? (tabs[0] ?? '') : p.active };
}

// ── The persistent surface ─────────────────────────────────────────────────────

export function AgentSurface() {
  // The whole surface is mounted once (App.tsx) and toggled between a hidden state and
  // a fullscreen overlay by this local flag. Sessions live in the detached-DOM garage
  // either way, so toggling `expanded` NEVER remounts xterm/WebSocket/PTY.
  const [expanded, setExpanded] = useState(false);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [capsError, setCapsError] = useState(false);
  const [bypass, setBypass] = useState(false); // default for NEW sessions
  const [sessionList, setSessionList] = useState<SessionMeta[]>([]);
  const [panes, setPanes] = useState<PaneState[]>([]);
  const [activePaneId, setActivePaneId] = useState('');
  // Sessions the user minimized OUT of the side-by-side panes (to free terminal space)
  // while the overlay stays open — they live on as live progress chips in the corner dock,
  // restorable with a click. Kept alive in the garage exactly like any backgrounded tab.
  const [minimizedIds, setMinimizedIds] = useState<string[]>([]);
  // A tab drag is in flight → render the per-pane split/combine drop overlays.
  const [draggingTab, setDraggingTab] = useState(false);
  const [, bumpStatus] = useReducer((x: number) => x + 1, 0);
  // The session whose title is being edited inline (double-click on its tab), or ''.
  const [renamingId, setRenamingId] = useState('');

  const sessions = useRef<Map<string, Session>>(new Map());
  const garageRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // The session id of the tab currently being dragged. The DnD payload is ALSO written to
  // `dataTransfer` (for the `types`-based drop gating), but WKWebView returns '' from
  // `getData()` of a CUSTOM mime on the drop event — so the actual id must travel through
  // this ref, set on dragstart, or the drop silently no-ops in the packaged app.
  const draggedSidRef = useRef('');
  // Where the dragged tab will land, updated on every dragover. We execute on `dragend`
  // (reliable on the source) rather than `drop` (unreliable in WKWebView for these zones).
  const dropTargetRef = useRef<DropTarget | null>(null);
  // True once the saved roster has been fetched (or the fetch failed/was empty). Gates
  // the persist effect so a pre-hydrate render can't PUT [] and clobber the saved names.
  const hydratedRef = useRef(false);

  const started = sessionList.length > 0;
  // The action-focused pane (falls back to the first pane when the stored id is stale).
  const activePane = panes.find((p) => p.id === activePaneId) ?? panes[0];
  const focusedSessionId = activePane?.active ?? '';

  // ── Capabilities (fetched on mount; re-fetched after an in-app install so a
  //    freshly-installed prerequisite flips to ready without an app relaunch) ────
  const refreshCaps = useCallback(async (): Promise<Capabilities | null> => {
    try { const c = await api.get<Capabilities>('/agent/capabilities'); setCaps(c); return c; }
    catch { setCapsError(true); return null; }
  }, []);
  useEffect(() => { void refreshCaps(); }, [refreshCaps]);

  // ── Roster persistence (per-vault, server-side) ──────────────────────────────
  // Hydrate ONCE after caps: pull the saved roster and, if the live list is still
  // empty, restore its entries as DORMANT tabs (names only, NO PTY) in a single pane.
  // Spawning a real session is deferred to an explicit Resume click — we never auto-spawn
  // claude on launch. hydratedRef flips true on success, empty, OR failure so the persist
  // effect below can start (and never runs before this completes → never clobbers []).
  useEffect(() => {
    if (hydratedRef.current || !caps?.embeddedTerminal) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ sessions: SavedMeta[] }>('/agent/sessions');
        if (!cancelled && Array.isArray(res.sessions) && res.sessions.length > 0) {
          // A saved tab WITH a pinned conversation id auto-RESUMES its real Claude session
          // on launch (reopening the app reopens the work via `claude --resume`); a legacy
          // tab without one restores DORMANT (manual Resume). Spawn happens here, once —
          // and only on the non-cancelled invocation, so StrictMode can't double-spawn.
          const restored: SessionMeta[] = res.sessions.map((m, i) => {
            if (m.sessionId) {
              const s = spawn(m.bypass, m.sessionId, true);
              return { id: s.id, title: m.title, bypass: m.bypass, claudeId: m.sessionId };
            }
            return { id: `restored-${i}`, title: m.title, bypass: m.bypass, claudeId: newClaudeId(), dormant: true };
          });
          setSessionList((prev) => (prev.length > 0 ? prev : restored));
          setPanes((prev) => (prev.length > 0 ? prev : [{
            id: nextPaneId(), tabs: restored.map((m) => m.id), active: restored[0].id,
          }]));
        }
      } catch { /* no saved roster (or non-desktop 403) — just start fresh */ }
      finally { if (!cancelled) hydratedRef.current = true; }
    })();
    return () => { cancelled = true; };
  }, [caps]);

  // Persist on every roster change (post-hydrate), debounced. Saves BOTH dormant and
  // live metas so a renamed live session is captured too. `minimized`/`size` are written
  // as inert defaults — kept only for the persisted-format compatibility the server
  // schema still expects. Best-effort: a failed PUT just means this change isn't mirrored.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const handle = setTimeout(() => {
      const payload = {
        sessions: sessionList.map((m) => ({
          title: m.title, bypass: m.bypass, minimized: false, size: 1, sessionId: m.claudeId,
        })),
      };
      void api.put('/agent/sessions', payload).catch(() => { /* best-effort mirror */ });
    }, 400);
    return () => clearTimeout(handle);
  }, [sessionList]);

  // ── Session actions ────────────────────────────────────────────────────────
  // claudeId omitted → a fresh conversation (new UUID via `--session-id`); provided with
  // resume=true → reopen that exact conversation (`--resume`) after an app relaunch.
  const spawn = useCallback((bp: boolean, claudeId?: string, resume = false) => {
    const s = createSession(bp, bumpStatus, claudeId ?? newClaudeId(), resume);
    s.applyZoom(currentZoom());
    sessions.current.set(s.id, s);
    return s;
  }, []);

  // Add a session as a TAB of the action-focused pane (⌘T / ＋), or as the first pane.
  const addSession = useCallback(() => {
    const s = spawn(bypass);
    const num = s.id.replace('agent-', '');
    setSessionList((prev) => [...prev, { id: s.id, title: `Agent ${num}`, bypass: s.bypass, claudeId: s.claudeId }]);
    if (panes.length === 0) {
      const pid = nextPaneId();
      setPanes([{ id: pid, tabs: [s.id], active: s.id }]);
      setActivePaneId(pid);
    } else {
      const apid = panes.some((p) => p.id === activePaneId) ? activePaneId : panes[0].id;
      setPanes((prev) => prev.map((p) => (p.id === apid ? { ...p, tabs: [...p.tabs, s.id], active: s.id } : p)));
      setActivePaneId(apid);
    }
  }, [spawn, bypass, panes, activePaneId]);

  // Spawn a fresh agent into a NEW pane beside the focused one (⌘D) → side-by-side.
  const addSplitSession = useCallback(() => {
    const s = spawn(bypass);
    const num = s.id.replace('agent-', '');
    setSessionList((prev) => [...prev, { id: s.id, title: `Agent ${num}`, bypass: s.bypass, claudeId: s.claudeId }]);
    const pid = nextPaneId();
    if (panes.length === 0) {
      setPanes([{ id: pid, tabs: [s.id], active: s.id }]);
    } else {
      const idx = panes.findIndex((p) => p.id === activePaneId);
      const at = idx < 0 ? panes.length : idx + 1;
      setPanes((prev) => {
        const next = [...prev];
        next.splice(at, 0, { id: pid, tabs: [s.id], active: s.id });
        return next;
      });
    }
    setActivePaneId(pid);
  }, [spawn, bypass, panes, activePaneId]);

  // All mutations are FUNCTIONAL (read `prev`, never a captured list) and read live
  // sessions from the ref — so a stale snapshot can never act on the wrong session.
  const closeSessionById = useCallback((sid: string) => {
    // dispose is hardened, but NEVER let a teardown throw block the actual removal —
    // one click must always make the tab disappear.
    try { sessions.current.get(sid)?.dispose(); } catch { /* best-effort */ }
    sessions.current.delete(sid);
    setSessionList((prev) => prev.filter((s) => s.id !== sid));
    setPanes((prev) => prev.map((p) => removeFromPane(p, sid)).filter((p) => p.tabs.length > 0));
    setMinimizedIds((prev) => (prev.includes(sid) ? prev.filter((x) => x !== sid) : prev));
  }, []);

  // Resume a DORMANT restored tab: spawn a real session for it (using the saved bypass
  // default) and swap the synthetic `restored-N` id for the live `agent-N` one in place
  // (in BOTH the roster and its pane), keeping the title.
  const resumeSession = useCallback((sid: string) => {
    const meta = sessionList.find((m) => m.id === sid);
    if (!meta?.dormant) return;
    // Resume the EXACT prior Claude conversation (`--resume <claudeId>`), not a fresh one.
    const s = spawn(meta.bypass, meta.claudeId, true);
    setSessionList((prev) => prev.map((m) => (m.id === sid ? { ...m, id: s.id, bypass: s.bypass, claudeId: s.claudeId, dormant: false } : m)));
    setPanes((prev) => prev.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t === sid ? s.id : t)),
      active: p.active === sid ? s.id : p.active,
    })));
  }, [spawn, sessionList]);

  // Focus a session's terminal + clear its attention badge.
  const focusTerm = useCallback((sid: string) => {
    const s = sessions.current.get(sid);
    if (s) { if (s.attention) { s.attention = false; bumpStatus(); } s.term.focus(); }
  }, []);

  // Focus AFTER the layout effect has (re)appended the container into its new slot.
  // A drop mutates `panes` → the move/append happens in the post-render layout effect,
  // so an immediate `focusTerm` would fire while the container is still parked in the
  // garage (offsetParent null → focus no-ops). Deferring a frame lands focus on the
  // freshly-split/combined pane so it's typable without a stray click.
  const focusTermSoon = useCallback((sid: string) => {
    requestAnimationFrame(() => focusTerm(sid));
  }, [focusTerm]);

  // Minimize a session OUT of the panes (frees its terminal space) → it becomes a corner
  // progress chip while the overlay stays open. The session keeps running in the garage;
  // nothing is torn down. The reconcile effect skips minimized ids so it isn't re-placed.
  const minimizeSession = useCallback((sid: string) => {
    setMinimizedIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
    setPanes((prev) => prev.map((p) => removeFromPane(p, sid)).filter((p) => p.tabs.length > 0));
  }, []);

  // Restore a minimized session back into the layout as its OWN pane (reappears
  // side-by-side) and focus it.
  const restoreMinimized = useCallback((sid: string) => {
    setMinimizedIds((prev) => prev.filter((x) => x !== sid));
    const pid = nextPaneId();
    setPanes((prev) => (prev.some((p) => p.tabs.includes(sid))
      ? prev
      : [...prev, { id: pid, tabs: [sid], active: sid }]));
    setActivePaneId(pid);
    focusTermSoon(sid);
  }, [focusTermSoon]);

  // Click a tab → make it that pane's active session + action-focus the pane.
  const selectTab = useCallback((paneId: string, sid: string) => {
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, active: sid } : p)));
    setActivePaneId(paneId);
    focusTerm(sid);
  }, [focusTerm]);

  // Click a collapsed dock chip → expand + bring its session forward in its pane.
  const focusSession = useCallback((sid: string) => {
    setPanes((prev) => prev.map((p) => (p.tabs.includes(sid) ? { ...p, active: sid } : p)));
    const owner = panes.find((p) => p.tabs.includes(sid));
    if (owner) setActivePaneId(owner.id);
    focusTerm(sid);
  }, [panes, focusTerm]);

  // Drag a tab ONTO another tab → move it into that tab's pane, inserted before it.
  const moveTab = useCallback((sid: string, targetPaneId: string, beforeSid: string) => {
    if (sid === beforeSid) return;
    setPanes((prev) => {
      const next = prev.map((p) => removeFromPane(p, sid)).map((p) => {
        if (p.id !== targetPaneId) return p;
        const tabs = p.tabs.slice();
        const idx = beforeSid ? tabs.indexOf(beforeSid) : tabs.length;
        tabs.splice(idx < 0 ? tabs.length : idx, 0, sid);
        return { ...p, tabs, active: sid };
      });
      return next.filter((p) => p.tabs.length > 0);
    });
    setActivePaneId(targetPaneId);
    focusTermSoon(sid);
  }, [focusTermSoon]);

  // Drag a tab onto a pane's tab-group padding → combine it into that pane (append).
  const combineIntoPane = useCallback((sid: string, targetPaneId: string) => {
    setPanes((prev) => {
      if (prev.find((p) => p.id === targetPaneId)?.tabs.includes(sid)) {
        return prev.map((p) => (p.id === targetPaneId ? { ...p, active: sid } : p));
      }
      const next = prev.map((p) => removeFromPane(p, sid))
        .map((p) => (p.id === targetPaneId ? { ...p, tabs: [...p.tabs, sid], active: sid } : p));
      return next.filter((p) => p.tabs.length > 0);
    });
    setActivePaneId(targetPaneId);
    focusTermSoon(sid);
  }, [focusTermSoon]);

  // Drop a tab onto a pane's CENTRE (combine) or LEFT/RIGHT edge (split into a new pane).
  const dropToZone = useCallback((targetPaneId: string, zone: 'left' | 'center' | 'right', sid: string) => {
    if (zone === 'center') { combineIntoPane(sid, targetPaneId); return; }
    // Decide whether a split actually happens BEFORE calling setPanes, from the closure
    // `panes` — NOT from inside the updater. A functional updater runs later (during
    // render), so a flag mutated there is still false when read synchronously here, and
    // `setActivePaneId` would never fire. Splitting a pane's LONE tab onto its own edge is
    // a no-op, so only then do we skip.
    const target = panes.find((p) => p.id === targetPaneId);
    if (!target) return;
    if (target.tabs.length === 1 && target.tabs[0] === sid) { focusTermSoon(sid); return; }
    const pid = nextPaneId();
    setPanes((prev) => {
      if (!prev.some((p) => p.id === targetPaneId)) return prev;
      const next = prev.map((p) => removeFromPane(p, sid)).filter((p) => p.tabs.length > 0);
      const tidx = next.findIndex((p) => p.id === targetPaneId);
      const at = zone === 'left' ? tidx : tidx + 1;
      next.splice(at < 0 ? next.length : at, 0, { id: pid, tabs: [sid], active: sid });
      return next;
    });
    setActivePaneId(pid);
    focusTermSoon(sid);
  }, [panes, combineIntoPane, focusTermSoon]);

  // ── Drag-to-split, executed on `dragend` ─────────────────────────────────────────
  // WKWebView does not reliably deliver the HTML5 `drop` event to these nested,
  // conditionally-mounted drop zones — but `dragover` fires fine (the highlight proves
  // it) and `dragend` always fires on the source tab. So every dragover records the
  // hovered target in `dropTargetRef`, and the tab's `dragend` performs the action. The
  // dragged session id + target both travel through refs, never `dataTransfer`.
  const setZoneTarget = useCallback((paneId: string, zone: 'left' | 'center' | 'right' | null) => {
    if (zone) dropTargetRef.current = { kind: 'zone', paneId, zone };
    // Only clear if WE own the current target (leaving pane A mustn't wipe pane B's set).
    else if (dropTargetRef.current?.kind === 'zone' && dropTargetRef.current.paneId === paneId) dropTargetRef.current = null;
  }, []);
  const setReorderTarget = useCallback((paneId: string, beforeSid: string) => {
    dropTargetRef.current = { kind: 'reorder', paneId, beforeSid };
  }, []);
  const setGroupTarget = useCallback((paneId: string) => {
    dropTargetRef.current = { kind: 'group', paneId };
  }, []);
  const handleTabDragStart = useCallback((sid: string) => {
    draggedSidRef.current = sid;
    dropTargetRef.current = null;
    setDraggingTab(true);
  }, []);
  const handleTabDragEnd = useCallback(() => {
    const sid = draggedSidRef.current;
    const t = dropTargetRef.current;
    draggedSidRef.current = '';
    dropTargetRef.current = null;
    setDraggingTab(false);
    if (!sid || !t) return; // released over empty space → no-op
    if (t.kind === 'zone') dropToZone(t.paneId, t.zone, sid);
    else if (t.kind === 'group') combineIntoPane(sid, t.paneId);
    else moveTab(sid, t.paneId, t.beforeSid);
  }, [dropToZone, combineIntoPane, moveTab]);

  const commitRename = useCallback((id: string, raw: string) => {
    const title = raw.trim();
    setRenamingId('');
    if (title) setSessionList((prev) => prev.map((m) => (m.id === id ? { ...m, title } : m)));
  }, []);

  // ── Place each pane's active session container into its slot ─────────────────────
  // The single source of layout truth: append every pane's ACTIVE session container into
  // that pane's slot (matched by `data-pane`), and park every other session in the hidden
  // garage. Raw-DOM moves, never a remount — a session moved between panes just lands in a
  // different slot. Runs on any layout (panes) or visibility (expanded) change.
  useLayoutEffect(() => {
    const visible = new Set(panes.map((p) => p.active));
    // Mirror "foreground" onto the Session objects so the idle timer knows whether a
    // finishing session deserves an attention badge: foreground ONLY when the overlay is
    // open AND the session is some pane's active tab.
    sessions.current.forEach((s) => { s.minimized = !(expanded && visible.has(s.id)); });

    const slots = new Map<string, HTMLElement>();
    hostRef.current?.querySelectorAll<HTMLElement>('.agent-pane-slot[data-pane]')
      .forEach((el) => { if (el.dataset.pane) slots.set(el.dataset.pane, el); });

    panes.forEach((pane) => {
      const s = sessions.current.get(pane.active);
      const slot = slots.get(pane.id);
      if (s && slot && s.container.parentElement !== slot) { slot.appendChild(s.container); s.ensureOpen(); }
    });
    sessions.current.forEach((s) => {
      if (!visible.has(s.id) && garageRef.current && s.container.parentElement !== garageRef.current) {
        garageRef.current.appendChild(s.container);
      }
    });
    // A freshly-shown container only has offsetParent after display, so open/fit next
    // frame. Refits ALL visible panes (a split/combine changes every pane's width).
    const raf = requestAnimationFrame(() => {
      visible.forEach((id) => { const s = sessions.current.get(id); if (s) { s.ensureOpen(); s.fitAndResize(); } });
    });
    return () => cancelAnimationFrame(raf);
  }, [panes, expanded]);

  // Keep activePaneId pointing at a real pane (panes shrink as tabs close/move).
  useEffect(() => {
    if (panes.length === 0) { if (activePaneId) setActivePaneId(''); return; }
    if (!panes.some((p) => p.id === activePaneId)) setActivePaneId(panes[0].id);
  }, [panes, activePaneId]);

  // Defensive reconcile: every roster session must live in exactly one pane. Explicit
  // placement (add/split/move/close) keeps this true; this only self-heals a dangling id
  // (a tab whose session was removed) or an orphan (a session in no pane) so a session can
  // never become invisible. No-ops once consistent, so it never loops.
  useEffect(() => {
    const known = new Set(sessionList.map((m) => m.id));
    const placed = new Set(panes.flatMap((p) => p.tabs));
    const min = new Set(minimizedIds);
    // A minimized session intentionally lives in NO pane (it's a corner chip), so it is
    // not an orphan — exclude it or the reconcile would yank it back into a pane.
    const orphans = sessionList.filter((m) => !placed.has(m.id) && !min.has(m.id)).map((m) => m.id);
    const hasDangling = panes.some((p) => p.tabs.some((id) => !known.has(id)));
    if (orphans.length === 0 && !hasDangling) return;
    setPanes((prev) => {
      let next = prev
        .map((p) => ({ ...p, tabs: p.tabs.filter((id) => known.has(id)) }))
        .map((p) => (p.tabs.includes(p.active) ? p : { ...p, active: p.tabs[0] ?? '' }))
        .filter((p) => p.tabs.length > 0);
      if (orphans.length > 0) {
        if (next.length === 0) {
          next = [{ id: nextPaneId(), tabs: orphans, active: orphans[orphans.length - 1] }];
        } else {
          next = next.map((p, i) => (i === next.length - 1
            ? { ...p, tabs: [...p.tabs, ...orphans], active: orphans[orphans.length - 1] }
            : p));
        }
      }
      return next;
    });
  }, [sessionList, panes, minimizedIds]);

  // ── On EXPAND the panes go from display:none (offsetParent null) to visible, so
  //    refit every visible session next frame. ──
  const fitVisible = useCallback(() => {
    panes.forEach((p) => { const s = sessions.current.get(p.active); if (s) { s.ensureOpen(); s.fitAndResize(); } });
  }, [panes]);

  useEffect(() => {
    if (!expanded) return;
    const raf = requestAnimationFrame(() => fitVisible());
    return () => cancelAnimationFrame(raf);
  }, [expanded, fitVisible]);

  // Window/sidebar resize → refit every visible pane (split widths track the window).
  useEffect(() => {
    if (!expanded) return;
    let raf = 0;
    const onResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => fitVisible()); };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); cancelAnimationFrame(raf); };
  }, [expanded, fitVisible]);

  // ── Esc collapses the overlay — but ONLY when focus is outside the terminal, so it
  //    never steals Esc from Claude's TUI (which uses Esc to cancel). It also yields to
  //    the ⌘K palette opened on top.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const ae = document.activeElement as Element | null;
      if (ae?.closest('.agent-pane-slot')) return;   // Claude's TUI owns Esc
      if (ae?.closest('.command-palette')) return;    // the palette owns Esc
      e.preventDefault();
      setExpanded(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded]);

  // ── Drop-overlay leak guard (the "terminal unreachable after a split" fix) ───────
  // While a tab is dragged, each pane mounts a full-bleed `.agent-pane-droplayer`
  // (z-index 6) for the split/combine zones. It's normally torn down by the tab's
  // `onDragEnd`. But a drop that SPLITS/MOVES the dragged tab reconciles its source
  // <div> out of the DOM before the browser fires `dragend` on it — so `onDragEnd`
  // never runs, the overlay stays mounted over every terminal, and all clicks/focus
  // (and ⌘D, which needs host focus) are swallowed until an app restart. A
  // window-level capture listener fires for EVERY drop and dragend regardless of the
  // handlers' stopPropagation (capture precedes bubble) or a vanished source node, so
  // the flag always clears the instant the drag ends.
  useEffect(() => {
    if (!draggingTab) return;
    // BUBBLE phase (not capture) so this runs AFTER the dragged tab's own `dragend`
    // executor — it's pure insurance that the overlay never stays stuck if that handler
    // somehow doesn't fire. It clears state only; it never performs the drop action.
    const clear = () => { setDraggingTab(false); draggedSidRef.current = ''; dropTargetRef.current = null; };
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, [draggingTab]);

  // ── Auto-collapse on navigation ──────────────────────────────────────────────
  // When the user clicks a sidebar item (or jumps via the ⌘K palette) while the agent
  // is fullscreen, collapse it so the page they navigated to is actually visible. The
  // sessions stay alive in the garage — collapsing never tears anything down.
  useEffect(() => {
    const onNavigate = () => setExpanded((cur) => (cur ? false : cur));
    window.addEventListener('dreamcontext-navigate', onNavigate);
    return () => window.removeEventListener('dreamcontext-navigate', onNavigate);
  }, []);

  // ── App zoom → terminal font size. The window's `- 100% +` control sets `--zoom`
  //    (scaling CSS font tokens) and broadcasts `dreamcontext-zoom`; xterm's size is
  //    imperative, so we resize every session's font to match and refit the grid. ──
  useEffect(() => {
    const onZoom = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const zoom = typeof detail === 'number' && detail > 0 ? detail : currentZoom();
      sessions.current.forEach((s) => s.applyZoom(zoom));
    };
    window.addEventListener('dreamcontext-zoom', onZoom);
    return () => window.removeEventListener('dreamcontext-zoom', onZoom);
  }, []);

  // ── Keyboard: ⌘D split-new · ⌘T new tab · ⌘W close focused ────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !started) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'd') { e.preventDefault(); e.stopPropagation(); addSplitSession(); }
      else if (k === 't') { e.preventDefault(); e.stopPropagation(); addSession(); }
      else if (k === 'w') {
        e.preventDefault(); e.stopPropagation();
        if (focusedSessionId) closeSessionById(focusedSessionId);
      }
    };
    host.addEventListener('keydown', onKey, true);
    return () => host.removeEventListener('keydown', onKey, true);
  }, [started, addSession, addSplitSession, closeSessionById, focusedSessionId]);

  const openExternal = async () => {
    try { await api.post('/agent/open-terminal', { bypass }); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not open Terminal.'); }
  };

  // ── Image drag-drop → live Claude session ────────────────────────────────────
  // An HTML5 file drop hands us a File whose BYTES are readable even though WKWebView
  // hides the OS path. Read the bytes → POST to the loopback server (writes a real file
  // under the vault temp dir) → inject that absolute path into the focused PTY so Claude
  // can read the image. Binary can't go through `api.post` (JSON-only), so use raw fetch.
  const deliverDrops = useCallback(async (files: File[], sid: string) => {
    const vault = getActiveVault();
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const res = await fetch('/api/agent/drop', {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Dreamcontext-Filename': encodeURIComponent(file.name),
            ...(vault ? { 'X-Dreamcontext-Vault': vault } : {}),
          },
          body: buf,
        });
        if (!res.ok) continue;
        const { path } = await res.json() as { path?: string };
        if (path) sessions.current.get(sid)?.sendText(quoteIfNeeded(path) + ' ');
      } catch { /* best-effort: a failed drop just doesn't inject */ }
    }
  }, []);

  const onTermDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  // `files.length === 0` is the collision guard: internal tab DnD (and board Kanban/
  // Eisenhower DnD) carry no OS files, so we leave those drops untouched. A dropped image
  // goes to the action-focused pane's session.
  const onTermDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!(caps?.embeddedTerminal && started)) return;
    if (focusedSessionId) void deliverDrops(files, focusedSessionId);
  };

  // ── Per-session view-models (recomputed every render; bumpStatus re-renders on a
  //    live status change so the tabs + dock chips always track the real PTY state). ──
  const metaById = new Map(sessionList.map((m) => [m.id, m] as const));
  const paneVMs: PaneVM[] = panes.map((pane) => ({
    id: pane.id,
    active: pane.active,
    tabs: pane.tabs.map((id) => {
      const meta = metaById.get(id);
      const s = sessions.current.get(id);
      return {
        id,
        title: meta?.title ?? id,
        info: deriveSessionStatus({ dormant: meta?.dormant, status: s?.status, busy: s?.busy }),
        bypass: !!meta?.bypass,
        attention: !meta?.dormant && !!s?.attention,
      };
    }),
  }));
  // Collapsed dock rows — one chip per session, in roster order.
  const dockRows: SessionRow[] = sessionList.map((meta) => {
    const s = sessions.current.get(meta.id);
    return {
      id: meta.id,
      title: meta.title,
      info: deriveSessionStatus({ dormant: meta.dormant, status: s?.status, busy: s?.busy }),
      attention: !meta.dormant && !!s?.attention,
    };
  });
  // Rows for the corner dock that floats over the EXPANDED overlay — only the sessions the
  // user minimized out of the panes (in minimize order). Empty → no corner dock shown.
  const minimizedRows: SessionRow[] = minimizedIds
    .map((id) => dockRows.find((r) => r.id === id))
    .filter((r): r is SessionRow => !!r);

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
      <div className="agent-term" onDragOver={onTermDragOver} onDrop={onTermDrop}>
        {/* Drop a PNG/JPG/GIF/WebP anywhere on a terminal to hand the focused Claude
            session that image — its path is written to the vault temp dir and injected. */}
        <div className={'agent-panes' + (panes.length > 1 ? ' split' : '')}>
          {panes.length === 0 && (
            <div className="agent-allmin-hint">
              <p className="agent-allmin-title">All agents minimized</p>
              <p className="agent-allmin-sub">Click a chip in the bottom-right corner to bring one back, or start a new one with ＋ New agent.</p>
            </div>
          )}
          {panes.map((pane) => {
            const activeMeta = metaById.get(pane.active);
            const paneVM = paneVMs.find((pv) => pv.id === pane.id);
            const isActive = pane.id === activePane?.id;
            return (
              <PaneFragment
                key={pane.id}
                paneId={pane.id}
                active={isActive}
                dormant={activeMeta?.dormant}
                dragging={draggingTab}
                tabbar={paneVM && (
                  <AgentTabs
                    pane={paneVM}
                    isActivePane={isActive}
                    renamingId={renamingId}
                    onSelect={selectTab}
                    onClose={closeSessionById}
                    onMinimize={minimizeSession}
                    onStartRename={setRenamingId}
                    onCommitRename={commitRename}
                    onCancelRename={() => setRenamingId('')}
                    onTabDragStart={handleTabDragStart}
                    onTabDragEnd={handleTabDragEnd}
                    onReorderHover={setReorderTarget}
                    onGroupHover={setGroupTarget}
                  />
                )}
                onZoneTarget={(zone) => setZoneTarget(pane.id, zone)}
                onActivate={() => { if (pane.id !== activePaneId) setActivePaneId(pane.id); }}
                onResume={() => resumeSession(pane.active)}
                onClose={() => closeSessionById(pane.active)}
              />
            );
          })}
        </div>

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
          Open as many as you need — each gets its own <strong>renameable</strong> tab in the
          top bar, and you can put them <strong>side by side</strong> (⌘D) to watch several
          agents work at once.
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
    <>
      <div ref={hostRef} className={`agent-surface${expanded ? ' expanded' : ''}`}>
        {/* Overlay chrome: collapse + title, the per-pane session TABS, and (once a
            terminal is live) the bypass default + the prominent "New agent" action. */}
        <div className="agent-overlay-head">
          <button
            className="agent-overlay-collapse"
            title="Collapse (Esc)"
            aria-label="Collapse agent"
            onClick={() => setExpanded(false)}
          >–</button>
          <span className="agent-overlay-title">Agent</span>
          <div className="agent-overlay-controls">
            {started && caps?.embeddedTerminal && (
              <>
                <BypassPill bypass={bypass} setBypass={setBypass} />
                <button className="agent-add-btn" title="New agent (⌘T) · ⌘D for side-by-side" aria-label="New agent" onClick={addSession}>
                  <span className="agent-add-btn-icon" aria-hidden>＋</span>
                  <span>New agent</span>
                </button>
              </>
            )}
          </div>
        </div>
        {body}
      </div>
      {/* Minimized sessions — a live progress dock floating ABOVE the expanded overlay, so
          you can free terminal space yet still watch them. Click a chip to restore it to a
          pane. Rendered OUTSIDE the overlay (its `contain`/`>*` rules would deform a child
          dock) with a higher z-index. */}
      {caps?.desktop && expanded && minimizedRows.length > 0 && (
        <AgentDock
          rows={minimizedRows}
          focusedId=""
          onOpen={restoreMinimized}
          onClose={closeSessionById}
          className="agent-dock--floating"
        />
      )}
      {/* Collapsed entry point — desktop only, hidden while the overlay is open. With
          sessions: the bottom-right chip dock (one chip per session, each coloured by its
          OWN state; collapsible to a handle), click a chip to open + focus. With zero
          sessions: a single "Agent" FAB. */}
      {caps?.desktop && !expanded && (
        sessionList.length === 0 ? (
          <AgentFab
            status="idle"
            mood="idle"
            label="Agent"
            sessionCount={0}
            attention={false}
            onClick={() => setExpanded(true)}
          />
        ) : (
          <AgentDock
            rows={dockRows}
            focusedId={focusedSessionId}
            onOpen={(id) => { setExpanded(true); if (minimizedIds.includes(id)) restoreMinimized(id); else focusSession(id); }}
            onClose={closeSessionById}
          />
        )
      )}
    </>
  );
}
