import {
  useEffect, useRef, useState, useReducer, useCallback, useLayoutEffect,
} from 'react';
import './AgentTerminal.css';
import { api, getActiveVault } from '../../api/client';
import {
  createSession, currentZoom,
  type Capabilities, type Session, type SessionKind,
} from './agentSession';
import {
  initAgentSettingsFromServer, readAgentSettings, matchesAccel,
  doubleTapToken, createDoubleTapMatcher,
  AGENT_SETTINGS_EVENT, type AgentSettings,
} from '../../lib/agentSettings';
import { deriveSessionStatus, type SessionRow } from './agentStatus';
import { PaneFragment } from './PaneFragment';
import { AgentTabs, type PaneVM } from './AgentTabs';
import { AgentDock } from './AgentDock';
import { AgentFab } from './AgentFab';
import {
  BypassToggle, BypassPill, Prereqs, Centered, BotMark,
  titleStyle, subStyle, primaryBtn, secondaryBtn,
} from './AgentSetup';
import { RUN_SLEEP_AGENT_EVENT, SLEEP_AGENT_TITLE, SLEEP_AGENT_PROMPT } from '../../lib/sleepAgent';
import { AgentComposerBar } from './AgentComposerBar';
import {
  readComposerPrefs, writeComposerPrefs, composePrompt, quotePath,
  type ComposerPrefs,
} from '../../lib/agentComposer';
import { pickFiles } from '../../lib/desktop';

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
  title: string;       // renameable; default "Agent N" / "Terminal N"
  kind: SessionKind;   // Claude agent, or a plain vault-scoped login shell
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

/** Default title for a fresh session: "Terminal N" for a shell, "Agent N" for an agent
 *  (N is the global session counter baked into the session id). */
function titleFor(s: Session): string {
  const num = s.id.replace('agent-', '');
  return s.kind === 'shell' ? `Terminal ${num}` : `Agent ${num}`;
}

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
  /** Absent on legacy rosters → treated as an agent (back-compat). */
  kind?: SessionKind;
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
  const [statusTick, bumpStatus] = useReducer((x: number) => x + 1, 0);
  // The session whose title is being edited inline (double-click on its tab), or ''.
  const [renamingId, setRenamingId] = useState('');
  // The header "＋ New ▾" split-button's dropdown (pick Agent vs Terminal) is open.
  // Click-driven (NOT hover): opening it via the caret keeps it open until you pick an
  // item, click outside, or press Esc — the old mouse-leave close fired the instant the
  // cursor crossed the gap between caret and menu, so the menu was unreachable.
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newSplitRef = useRef<HTMLDivElement>(null);
  // Agents (beta) surface preferences (Settings → Agents): feature on/off, restore
  // past tabs, default agent, in-app toggle hotkey. Seeded synchronously from
  // localStorage, then reconciled with the server file on mount, and kept live via
  // the AGENT_SETTINGS_EVENT the Settings page dispatches on save.
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(() => readAgentSettings());
  // Gates hydration: the restore-past-tabs decision must wait for the server's real
  // value, or a launch could restore tabs the user turned OFF (or skip a restore
  // they left ON) based on a stale localStorage seed.
  const [settingsReady, setSettingsReady] = useState(false);
  // Bottom composer strip: the shared text field the Files / Skills controls write into,
  // plus the model + thinking-effort picks for the NEXT session (localStorage-persisted —
  // see agentComposer.ts for why it needn't survive the per-launch origin reset).
  const [composerValue, setComposerValue] = useState('');
  const [composerPrefs, setComposerPrefs] = useState<ComposerPrefs>(() => readComposerPrefs());

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
  // Auto-title bookkeeping: session ids we've already handled (titled or deliberately
  // skipped) so Haiku is asked at most ONCE per session, and the prior busy state per
  // session so we can fire on the first busy→idle edge (the first turn completing).
  const autoTitledRef = useRef<Set<string>>(new Set());
  const busyPrevRef = useRef<Map<string, boolean>>(new Map());

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

  // ── Agent-surface settings: load the server-persisted prefs once, then track
  //    live changes the Settings page broadcasts (no reload needed). ──
  useEffect(() => {
    let cancelled = false;
    void initAgentSettingsFromServer().then((s) => {
      if (cancelled) return;
      setAgentSettings(s);
      setSettingsReady(true);
    });
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<AgentSettings>).detail;
      if (detail) setAgentSettings(detail);
    };
    window.addEventListener(AGENT_SETTINGS_EVENT, onChange);
    return () => { cancelled = true; window.removeEventListener(AGENT_SETTINGS_EVENT, onChange); };
  }, []);

  // ── Roster persistence (per-vault, server-side) ──────────────────────────────
  // Hydrate ONCE after caps: pull the saved roster and, if the live list is still
  // empty, restore its entries as DORMANT tabs (names only, NO PTY) in a single pane.
  // Spawning a real session is deferred to an explicit Resume click — we never auto-spawn
  // claude on launch. hydratedRef flips true on success, empty, OR failure so the persist
  // effect below can start (and never runs before this completes → never clobbers []).
  // Gated on `settingsReady` so the restore-past-tabs preference is the real server value:
  // if the user turned "Reopen past tabs" OFF, we mark hydrated and skip the restore
  // entirely (a clean start), while still enabling the persist effect below.
  useEffect(() => {
    if (hydratedRef.current || !caps?.embeddedTerminal || !settingsReady) return;
    if (!agentSettings.restoreTabs) { hydratedRef.current = true; return; }
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
            const kind: SessionKind = m.kind === 'shell' ? 'shell' : 'agent';
            // An agent tab with a pinned conversation auto-RESUMES its real Claude session on
            // launch. A shell has nothing to resume, and auto-spawning shells on launch is
            // surprising — so shells (and legacy agent tabs without a conversation id) restore
            // DORMANT, spawning a fresh session only on an explicit Resume click.
            if (kind === 'agent' && m.sessionId) {
              const s = spawn(m.bypass, m.sessionId, true, 'agent');
              return { id: s.id, title: m.title, kind, bypass: m.bypass, claudeId: m.sessionId };
            }
            return { id: `restored-${i}`, title: m.title, kind, bypass: m.bypass, claudeId: newClaudeId(), dormant: true };
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
  }, [caps, settingsReady, agentSettings.restoreTabs]);

  // Persist on every roster change (post-hydrate), debounced. Saves BOTH dormant and
  // live metas so a renamed live session is captured too. `minimized`/`size` are written
  // as inert defaults — kept only for the persisted-format compatibility the server
  // schema still expects. Best-effort: a failed PUT just means this change isn't mirrored.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const handle = setTimeout(() => {
      const payload = {
        sessions: sessionList.map((m) => ({
          title: m.title, kind: m.kind, bypass: m.bypass, minimized: false, size: 1, sessionId: m.claudeId,
        })),
      };
      void api.put('/agent/sessions', payload).catch(() => { /* best-effort mirror */ });
    }, 400);
    return () => clearTimeout(handle);
  }, [sessionList]);

  // ── Session actions ────────────────────────────────────────────────────────
  // claudeId omitted → a fresh conversation (new UUID via `--session-id`); provided with
  // resume=true → reopen that exact conversation (`--resume`) after an app relaunch.
  const spawn = useCallback((bp: boolean, claudeId?: string, resume = false, kind: SessionKind = 'agent', initialPrompt = '', model = '') => {
    // A shell has no permission model, so bypass is meaningless for it — force it off.
    const s = createSession(kind === 'shell' ? false : bp, bumpStatus, claudeId ?? newClaudeId(), resume, kind, initialPrompt, model);
    s.applyZoom(currentZoom());
    sessions.current.set(s.id, s);
    return s;
  }, []);

  // Spawn a fresh session AND append its roster entry — the two steps every "new session"
  // path shares. Callers keep only their pane placement, so the roster-entry shape lives in
  // ONE place (adding a field like `kind` can't drift between add-tab and add-split).
  const spawnAndRegister = useCallback((kind: SessionKind) => {
    const s = spawn(bypass, undefined, false, kind);
    setSessionList((prev) => [...prev, { id: s.id, title: titleFor(s), kind: s.kind, bypass: s.bypass, claudeId: s.claudeId }]);
    return s;
  }, [spawn, bypass]);

  // Add a session as a TAB of the action-focused pane (⌘T / ＋ for an agent, ⌃` / menu for
  // a shell), or as the first pane.
  const addSession = useCallback((kind: SessionKind = 'agent') => {
    const s = spawnAndRegister(kind);
    if (panes.length === 0) {
      const pid = nextPaneId();
      setPanes([{ id: pid, tabs: [s.id], active: s.id }]);
      setActivePaneId(pid);
    } else {
      const apid = panes.some((p) => p.id === activePaneId) ? activePaneId : panes[0].id;
      setPanes((prev) => prev.map((p) => (p.id === apid ? { ...p, tabs: [...p.tabs, s.id], active: s.id } : p)));
      setActivePaneId(apid);
    }
  }, [spawnAndRegister, panes, activePaneId]);

  // Spawn a fresh session into a NEW pane beside the focused one (⌘D) → side-by-side.
  const addSplitSession = useCallback((kind: SessionKind = 'agent') => {
    const s = spawnAndRegister(kind);
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
  }, [spawnAndRegister, panes, activePaneId]);

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
    // Agent → resume the EXACT prior Claude conversation (`--resume <claudeId>`). Shell →
    // there is no conversation to resume, so just open a fresh vault-scoped login shell.
    const s = meta.kind === 'shell'
      ? spawn(meta.bypass, undefined, false, 'shell')
      : spawn(meta.bypass, meta.claudeId, true, 'agent');
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

  // ── Run sleep agent (from the header's Sleep-debt tracker) ────────────────────────
  // Spawn a dedicated "Sleep" agent that auto-runs the project's consolidation flow, and
  // leave the overlay COLLAPSED so it surfaces as a running chip in the bottom-right dock —
  // the user watches it there and can click in to follow along. Guarded on the agent
  // prerequisites (desktop + node-pty + claude CLI) and on the surface being enabled; a
  // second request while a live Sleep session already exists just brings that one forward
  // instead of spawning a duplicate consolidation.
  const runSleepAgent = useCallback(() => {
    if (!(caps?.desktop && caps.embeddedTerminal && caps.claudeCli) || !agentSettings.enabled) return;
    const existing = sessionList.find((m) => !m.dormant && m.title === SLEEP_AGENT_TITLE);
    if (existing) { setExpanded(true); focusSession(existing.id); return; }
    const s = spawn(bypass, undefined, false, 'agent', SLEEP_AGENT_PROMPT);
    setSessionList((prev) => [...prev, { id: s.id, title: SLEEP_AGENT_TITLE, kind: 'agent', bypass: s.bypass, claudeId: s.claudeId }]);
    const pid = nextPaneId();
    setPanes((prev) => [...prev, { id: pid, tabs: [s.id], active: s.id }]);
    setActivePaneId(pid);
  }, [caps, agentSettings.enabled, sessionList, spawn, bypass, focusSession]);

  useEffect(() => {
    const onRun = () => runSleepAgent();
    window.addEventListener(RUN_SLEEP_AGENT_EVENT, onRun);
    return () => window.removeEventListener(RUN_SLEEP_AGENT_EVENT, onRun);
  }, [runSleepAgent]);

  // ── Bottom composer strip ────────────────────────────────────────────────────────
  const updateComposerPrefs = useCallback((p: ComposerPrefs) => {
    setComposerPrefs(p);
    writeComposerPrefs(p);
  }, []);

  // Append a skill trigger / snippet to the field, keeping exactly one space between it and
  // whatever's already there (so "…foo" + "/council " reads cleanly).
  const insertToComposer = useCallback((snippet: string) => {
    setComposerValue((v) => (!v ? snippet : /\s$/.test(v) ? v + snippet : `${v} ${snippet}`));
  }, []);

  // Native multi-file picker → append the chosen absolute paths (quoted) to the field.
  const handlePickFiles = useCallback(async () => {
    const paths = await pickFiles();
    if (!paths.length) return;
    const joined = paths.map(quotePath).join(' ');
    setComposerValue((v) => {
      const base = v.trim() ? (/\s$/.test(v) ? v : `${v} `) : '';
      return `${base}${joined} `;
    });
  }, []);

  // Send the composed field: prefer the focused LIVE session (type it in + submit); with no
  // live target, spawn a fresh agent using the picked model, delivering the prompt via the
  // session's initial-prompt boot mechanism. Effort is folded in by composePrompt.
  const sendComposer = useCallback(() => {
    const composed = composePrompt(composerValue, composerPrefs.effort);
    if (!composed) return;
    const meta = sessionList.find((m) => m.id === focusedSessionId);
    const live = meta && !meta.dormant ? sessions.current.get(focusedSessionId) : undefined;
    if (live) {
      live.sendText(composed);
      // Submit a beat later so the readline registers the whole line before Enter.
      setTimeout(() => live.sendText('\r'), 40);
      live.term.focus();
    } else {
      if (!(caps?.embeddedTerminal && caps.claudeCli)) return;
      const s = spawn(bypass, undefined, false, 'agent', composed, composerPrefs.modelId);
      setSessionList((prev) => [...prev, { id: s.id, title: titleFor(s), kind: 'agent', bypass: s.bypass, claudeId: s.claudeId }]);
      const pid = nextPaneId();
      setPanes((prev) => [...prev, { id: pid, tabs: [s.id], active: s.id }]);
      setActivePaneId(pid);
    }
    setComposerValue('');
  }, [composerValue, composerPrefs, sessionList, focusedSessionId, caps, spawn, bypass]);

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
      if (document.querySelector('.agent-new-menu')) return;  // the "＋ New" menu owns Esc
      const ae = document.activeElement as Element | null;
      if (ae?.closest('.agent-pane-slot')) return;   // Claude's TUI owns Esc
      if (ae?.closest('.command-palette')) return;    // the palette owns Esc
      e.preventDefault();
      setExpanded(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded]);

  // ── Quick-toggle hotkey (Settings → Agents; default ⌃A) ──────────────────────────
  // Opens the Agents overlay from anywhere in the app, and closes it again. Two flavours:
  //  • a chord (e.g. ⌃A): like the Esc handler it YIELDS when focus is inside a terminal —
  //    ⌃A is also readline's "line start", so while typing in a session that keystroke must
  //    reach the PTY, not the toggle (collapsed → always opens; expanded → closes only when
  //    focus is outside the terminal).
  //  • a double-tap of a bare modifier (⌃⌃/⌥⌥/⌘⌘/⇧⇧): a lone modifier never reaches the PTY
  //    as a real keystroke, so this toggles from ANYWHERE — including inside a focused
  //    terminal — which is exactly what a "double-tap to show/hide the terminal" wants.
  // Disabled surface → no binding at all. Rebind or clear it in Settings.
  useEffect(() => {
    if (!caps?.desktop || !agentSettings.enabled || !agentSettings.hotkey.trim()) return;
    const dt = doubleTapToken(agentSettings.hotkey);
    const matchDouble = dt ? createDoubleTapMatcher(dt) : null;
    const onKey = (e: KeyboardEvent) => {
      const hit = matchDouble ? matchDouble(e) : matchesAccel(e, agentSettings.hotkey);
      if (!hit) return;
      const ae = document.activeElement as Element | null;
      // Only a chord defers to the terminal (it may be a real PTY keystroke); a
      // double-tap modifier is safe to toggle even while a terminal owns focus.
      if (!dt && expanded && ae?.closest('.agent-pane-slot')) return;
      if (ae?.closest('.command-palette')) return; // the palette owns its own keys
      e.preventDefault();
      e.stopPropagation();
      setExpanded((cur) => !cur);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [caps, agentSettings.enabled, agentSettings.hotkey, expanded]);

  // Turning the surface OFF in Settings must also collapse an open overlay — otherwise
  // a fullscreen agent view would linger with no entry point to dismiss it.
  useEffect(() => {
    if (!agentSettings.enabled && expanded) setExpanded(false);
  }, [agentSettings.enabled, expanded]);

  // ── Auto-title: name a tab from its first user message (Settings → Agents) ────────
  // Fires when a live AGENT session completes its FIRST turn (a busy→idle edge), which
  // is exactly when Claude Code has written the opening user message to its transcript.
  // The server reads that message and returns a Haiku-generated title; we apply it ONLY
  // if the tab still carries its default "Agent N" name (a tab you renamed is never
  // overwritten). Guarded to run once per session, so it costs one Haiku call per tab.
  useEffect(() => {
    if (!agentSettings.enabled || !agentSettings.autoTitle) return;
    sessions.current.forEach((s, id) => {
      const wasBusy = busyPrevRef.current.get(id) ?? false;
      busyPrevRef.current.set(id, s.busy);
      if (!(wasBusy && !s.busy)) return;          // only on the first-turn-complete edge
      if (s.kind !== 'agent' || autoTitledRef.current.has(id)) return;
      const meta = sessionList.find((m) => m.id === id);
      // Skip (permanently) if the tab was renamed by the user or is a dormant restore.
      if (!meta || meta.dormant || !/^Agent \d+$/.test(meta.title)) {
        autoTitledRef.current.add(id);
        return;
      }
      autoTitledRef.current.add(id);              // once per session, even if it fails
      void api.post<{ title: string | null }>('/agent/title', { claudeId: s.claudeId })
        .then((r) => {
          const title = r?.title?.trim();
          if (!title) return;
          // Re-check the default guard inside the updater: the user may have renamed the
          // tab while Haiku was thinking — their choice wins.
          setSessionList((prev) => prev.map((m) => (
            m.id === id && /^Agent \d+$/.test(m.title) ? { ...m, title } : m
          )));
        })
        .catch(() => { /* best-effort: a failed title just leaves the default name */ });
    });
  }, [statusTick, agentSettings.enabled, agentSettings.autoTitle, sessionList]);

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

  // ── "＋ New ▾" dropdown: close on outside-click or Esc ────────────────────────
  // The menu is opened by clicking the caret and stays open (no hover-close). A
  // pointerdown outside the split wrapper — or Esc — dismisses it, the way a real
  // menu behaves. Bound only while open so it costs nothing otherwise.
  useEffect(() => {
    if (!newMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!newSplitRef.current?.contains(e.target as Node)) setNewMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNewMenuOpen(false); };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [newMenuOpen]);

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
      if (e.altKey) return;
      // ⌃` → new TERMINAL tab (standard "toggle terminal" chord). This is the ONLY Ctrl combo
      // we claim: every OTHER Ctrl chord (⌃C SIGINT, ⌃D EOF, ⌃W delete-word) MUST reach the
      // PTY, or a shell session is unusable — so the ⌘D/⌘T/⌘W app chords below are gated on
      // metaKey WITHOUT ctrlKey (previously `metaKey || ctrlKey` swallowed ⌃D/⌃W/⌃T too).
      if (e.ctrlKey && !e.metaKey && e.key === '`') { e.preventDefault(); e.stopPropagation(); addSession('shell'); return; }
      if (!e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === 'd') { e.preventDefault(); e.stopPropagation(); addSplitSession('agent'); }
      else if (k === 't') { e.preventDefault(); e.stopPropagation(); addSession('agent'); }
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

  // ── File drag-drop → live Claude session ─────────────────────────────────────
  // An HTML5 file drop hands us a File whose BYTES are readable even though WKWebView
  // hides the OS path. Read the bytes → POST to the loopback server (writes a real file
  // under the vault temp dir) → inject that absolute path into the target PTY so Claude
  // can read the file (image, code, text, PDF, …). Binary can't go through `api.post`
  // (JSON-only), so use raw fetch.
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
  // Eisenhower DnD) carry no OS files, so we leave those drops untouched. A dropped file
  // goes to the pane UNDER THE CURSOR (not the last-focused one), resolved from the pane
  // slot's `data-pane` at the drop point; any file type is accepted.
  const onTermDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!(caps?.embeddedTerminal && started)) return;
    // Route by cursor position: the pane slot the drop landed in owns the target session;
    // fall back to the action-focused session if the point isn't over any pane.
    const at = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const slot = (at?.closest('.agent-pane-slot[data-pane]') ?? null) as HTMLElement | null;
    const targetPane = panes.find((p) => p.id === slot?.dataset.pane);
    const targetSid = targetPane?.active || focusedSessionId;
    if (!targetSid) return;
    if (targetPane && targetPane.id !== activePaneId) setActivePaneId(targetPane.id);
    void deliverDrops(files, targetSid);
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
        sessionKind: meta?.kind ?? 'agent',
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
          A full interactive Claude Code session running right here, scoped to this project —
          or a <strong>plain terminal</strong> in the same window when you just need a shell.
          Open as many as you need — each gets its own <strong>renameable</strong> tab, and you
          can put them <strong>side by side</strong> (⌘D) to watch several at once.
        </p>
        <BypassToggle bypass={bypass} setBypass={setBypass} />
        {(() => {
          // The AGENT needs BOTH its renderer (node-pty) AND the `claude` binary it spawns.
          // A plain TERMINAL needs only the renderer — no `claude` — so it can start even
          // when the CLI is missing. Missing the renderer → show the in-app Setup panel.
          const agentReady = caps.embeddedTerminal && caps.claudeCli;
          const terminalReady = caps.embeddedTerminal;
          return (
            <>
              <div style={{ display: 'flex', gap: '12px', marginTop: '22px', flexWrap: 'wrap', justifyContent: 'center' }}>
                {agentReady && (
                  <button onClick={() => addSession('agent')} style={primaryBtn}>▸ Start agent in app</button>
                )}
                {terminalReady && (
                  <button onClick={() => addSession('shell')} style={agentReady ? secondaryBtn : primaryBtn}>&gt;_ Start terminal</button>
                )}
                {caps.openTerminal && (
                  <button onClick={openExternal} style={secondaryBtn}>↗ Open in Terminal</button>
                )}
              </div>
              {!terminalReady && <Prereqs caps={caps} onRefresh={refreshCaps} />}
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
                {/* Split button: the main face opens a Claude agent (the common case); the
                    caret opens a menu to pick Agent vs Terminal. ⌘T / ⌃` shortcut the two. */}
                <div className="agent-new-split" ref={newSplitRef}>
                  <button
                    className="agent-add-btn"
                    title="New agent (⌘T) · ⌘D for side-by-side"
                    aria-label="New agent"
                    onClick={() => { setNewMenuOpen(false); addSession('agent'); }}
                  >
                    <span className="agent-add-btn-icon" aria-hidden>＋</span>
                    <span>New</span>
                  </button>
                  <button
                    className="agent-add-caret"
                    title="Choose agent or terminal"
                    aria-label="Choose new session type"
                    aria-haspopup="menu"
                    aria-expanded={newMenuOpen}
                    onClick={() => setNewMenuOpen((v) => !v)}
                  >▾</button>
                  {newMenuOpen && (
                    <div className="agent-new-menu" role="menu">
                      <button
                        className="agent-new-menu-item"
                        role="menuitem"
                        onClick={() => { setNewMenuOpen(false); addSession('agent'); }}
                      >
                        <span className="agent-new-menu-glyph" aria-hidden>◇</span>
                        <span className="agent-new-menu-label">New agent</span>
                        <kbd className="agent-new-menu-kbd">⌘T</kbd>
                      </button>
                      <button
                        className="agent-new-menu-item"
                        role="menuitem"
                        onClick={() => { setNewMenuOpen(false); addSession('shell'); }}
                      >
                        <span className="agent-new-menu-glyph" aria-hidden>&gt;_</span>
                        <span className="agent-new-menu-label">New terminal</span>
                        <kbd className="agent-new-menu-kbd">⌃`</kbd>
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        {body}
        {/* Thin composer strip: attach files, insert one of our skills, pick the model +
            thinking effort, and send to the focused (or a fresh) session. Shown once a
            terminal is live so it always has something to target. */}
        {started && caps?.embeddedTerminal && (
          <AgentComposerBar
            value={composerValue}
            onChange={setComposerValue}
            onInsert={insertToComposer}
            onPickFiles={handlePickFiles}
            onSend={sendComposer}
            prefs={composerPrefs}
            onPrefsChange={updateComposerPrefs}
            canSend={!!composerValue.trim()}
          />
        )}
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
      {/* Collapsed entry point — desktop only, hidden while the overlay is open, and hidden
          entirely when the Agents surface is disabled in Settings (no FAB, no dock; live
          sessions keep running in the garage but the surface is out of the way). With
          sessions: the bottom-right chip dock (one chip per session, each coloured by its
          OWN state; collapsible to a handle), click a chip to open + focus. With zero
          sessions: a single "Agent" FAB. */}
      {caps?.desktop && agentSettings.enabled && !expanded && (
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
