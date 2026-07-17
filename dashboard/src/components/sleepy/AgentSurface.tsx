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
import { RUN_BRAIN_RESOLVE_EVENT, BRAIN_RESOLVE_TITLE, BRAIN_RESOLVE_PROMPT } from '../../lib/brainResolveAgent';
import { DELEGATE_AGENT_EVENT, type DelegateAgentDetail } from '../../lib/delegateAgent';
import {
  TASK_MANAGER_EVENT, TASK_MANAGER_DETACH_EVENT, TASK_MANAGER_SEND_EVENT, TASK_MANAGER_STATUS_EVENT,
  taskManagerConversationId,
  type TaskManagerDetail, type TaskManagerSendDetail, type TaskManagerStatusDetail,
} from '../../lib/taskManagerAgent';
import { PaneComposer } from './PaneComposer';
import { quotePath, FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { useServerHealth } from '../../hooks/useServerHealth';
import { pickFiles, pickFolders } from '../../lib/desktop';

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
 * a NEW pane (split) and ⌘⇧D a fresh terminal likewise; ⌘T/＋ adds a tab to the active pane; dragging a tab onto another
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
  // Bottom strip state. Model/effort are PER AGENT and sourced from the Claude CLI:
  //  • modelConfig  — the models the CLI offers + effort levels + the user's defaults.
  //  • sessionModel — a session's CURRENT model alias (read from its transcript, keyed by
  //    session id), so the picker shows what each agent is really running.
  //  • sessionEffort — the effort we last set on a session (the CLI doesn't record it in the
  //    transcript, so we track our own `/effort` changes; defaults to the CLI default).
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const [sessionModel, setSessionModel] = useState<Record<string, string>>({});
  const [sessionEffort, setSessionEffort] = useState<Record<string, string>>({});

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
  // Auto-title bookkeeping. `autoTitledRef` holds session ids that are DONE — either
  // successfully named or permanently ineligible (user-renamed / dormant) — so we never
  // ask again. `titleInFlightRef` holds ids with a Haiku call currently outstanding, so a
  // second busy→idle edge doesn't fire a duplicate concurrent request. Crucially, a call
  // that comes back empty (transcript/message not flushed yet, e.g. an INTERRUPTED first
  // turn) does NOT mark the id done — it stays retryable, so the tab you actually worked on
  // still gets named on its next completed turn instead of silently losing the race.
  // `busyPrevRef` is the prior busy state per session, so we fire on the busy→idle edge.
  const autoTitledRef = useRef<Set<string>>(new Set());
  const titleInFlightRef = useRef<Set<string>>(new Set());
  // Attempts per session id — the retry BUDGET. "Empty response stays retryable" must
  // not mean retry FOREVER: a persistently failing title call (unauthenticated CLI,
  // offline) would otherwise spawn a fresh headless Haiku `claude` on every completed
  // turn of every default-named tab. After the budget, the default name is final.
  const titleAttemptsRef = useRef<Map<string, number>>(new Map());
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
        // Terminals are never remembered — drop any shell entry, plus any legacy roster
        // row still named "Terminal N" (a stale shell saved before we stopped persisting
        // them; auto-title only ever renames AGENTS, so that default name is a reliable
        // shell marker). What's left is agents only.
        const saved = Array.isArray(res.sessions)
          ? res.sessions.filter((m) => m.kind !== 'shell' && !/^Terminal \d+$/.test((m.title ?? '').trim()))
          : [];
        if (!cancelled && saved.length > 0) {
          // A saved tab WITH a pinned conversation id auto-RESUMES its real Claude session
          // on launch (reopening the app reopens the work via `claude --resume`); a legacy
          // tab without one restores DORMANT (manual Resume). Spawn happens here, once —
          // and only on the non-cancelled invocation, so StrictMode can't double-spawn.
          const restored: SessionMeta[] = saved.map((m, i) => {
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

  // Persist on every roster change (post-hydrate), debounced. Only AGENTS are remembered —
  // plain TERMINALS are session-local and never reopened on launch (the server also can't
  // resume a shell, and a stale `claude --resume` on a shell's id would wrongly reopen it as
  // an agent). Saves both dormant and live agent metas so a renamed live agent is captured
  // too. `minimized`/`size` are inert defaults kept only for persisted-format compatibility.
  // Best-effort: a failed PUT just means this change isn't mirrored.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const handle = setTimeout(() => {
      const payload = {
        sessions: sessionList
          .filter((m) => m.kind === 'agent')
          .map((m) => ({
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
  // `promptToken` carries an initial prompt too large for the upgrade URL — mint it with
  // `preparePrompt` (lib/agentPrompt.ts) BEFORE calling spawn, so spawn itself stays
  // synchronous (the delegate ACK in lib/delegateAgent.ts depends on that).
  const spawn = useCallback((bp: boolean, claudeId?: string, resume = false, kind: SessionKind = 'agent', initialPrompt = '', model = '', submitInitial = true, promptToken = '', deferPrompt = false) => {
    // A shell has no permission model, so bypass is meaningless for it — force it off.
    const s = createSession(kind === 'shell' ? false : bp, bumpStatus, claudeId ?? newClaudeId(), resume, kind, initialPrompt, model, submitInitial, promptToken, deferPrompt);
    s.applyZoom(currentZoom());
    sessions.current.set(s.id, s);
    return s;
  }, []);

  // Spawn a fresh session AND append its roster entry — the two steps every "new session"
  // path shares. Callers keep only their pane placement, so the roster-entry shape lives in
  // ONE place (adding a field like `kind` can't drift between add-tab and add-split).
  const spawnAndRegister = useCallback((kind: SessionKind) => {
    // A new agent inherits the user's CLI defaults (model/effort from ~/.claude/settings.json);
    // the picker then reflects and can change them per agent. Nothing is forced at launch.
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

  // Spawn a fresh session into a NEW pane beside the focused one (⌘D agent / ⌘⇧D terminal) → side-by-side.
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
  // Version handshake (the same shared query as App's StaleServerBanner). The auto-submit
  // sleep prompt rides the WS `&prompt=` param, which only THIS server build understands —
  // against a stale server (pre-drift-watch, or the ≤30s upgrade window) neither side
  // would submit it and the sleep would silently no-op. Not-current (including health not
  // loaded yet / errored — the policy lives in useServerHealth) → degrade to the
  // type-without-submit path: the prompt lands visibly in the readline and the user
  // presses Enter. Degrading works against ANY server; assuming "current" against a
  // genuinely stale one drops the prompt with no fallback armed.
  const { serverCurrent } = useServerHealth();

  const runSleepAgent = useCallback(() => {
    if (!(caps?.desktop && caps.embeddedTerminal && caps.claudeCli) || !agentSettings.enabled) return;
    const existing = sessionList.find((m) => !m.dormant && m.title === SLEEP_AGENT_TITLE);
    if (existing) {
      setExpanded(true);
      focusSession(existing.id);
      // The Sleep session is still open from a prior run. If it's idle (a previous
      // consolidation finished and it's sitting at the prompt), re-issue the sleep flow so
      // a fresh "Run sleep agent" actually starts a NEW sleep instead of silently focusing a
      // done session. If it's still busy mid-run — or blocked on a question — just surface
      // it; injecting text would corrupt the active turn (or answer the dialog). (During an
      // in-flight sleep the header button is disabled, so this idle re-issue is the
      // realistic path back in.)
      const live = sessions.current.get(existing.id);
      if (live && live.status !== 'closed' && !live.busy && !live.asking) {
        live.sendText(SLEEP_AGENT_PROMPT);
        setTimeout(() => {
          const s2 = sessions.current.get(existing.id);
          if (s2 && s2.status !== 'closed') s2.sendText('\r');
        }, 200);
      }
      return;
    }
    const s = spawn(bypass, undefined, false, 'agent', SLEEP_AGENT_PROMPT, '', serverCurrent);
    setSessionList((prev) => [...prev, { id: s.id, title: SLEEP_AGENT_TITLE, kind: 'agent', bypass: s.bypass, claudeId: s.claudeId }]);
    const pid = nextPaneId();
    setPanes((prev) => [...prev, { id: pid, tabs: [s.id], active: s.id }]);
    setActivePaneId(pid);
  }, [caps, agentSettings.enabled, sessionList, spawn, bypass, focusSession, serverCurrent]);

  useEffect(() => {
    const onRun = () => runSleepAgent();
    window.addEventListener(RUN_SLEEP_AGENT_EVENT, onRun);
    return () => window.removeEventListener(RUN_SLEEP_AGENT_EVENT, onRun);
  }, [runSleepAgent]);

  // ── Run brain-resolve agent (the sidebar's one-click "Resolve with AI") ──────────
  // Spawn a dedicated "/dream-sync" session that reconciles the deferred team merge,
  // fully autonomously, and EXPAND the overlay so the user can watch progress (a merge
  // resolution is something they'll want to see, unlike a background sleep). Same guards
  // + dedup + version-handshake as runSleepAgent. When it finishes, the sidebar's
  // brain-status poll flips back to "Synced" on its own (pendingAgentMerge → false).
  const runBrainResolveAgent = useCallback(() => {
    if (!(caps?.desktop && caps.embeddedTerminal && caps.claudeCli) || !agentSettings.enabled) return;
    const existing = sessionList.find((m) => !m.dormant && m.title === BRAIN_RESOLVE_TITLE);
    if (existing) {
      setExpanded(true);
      focusSession(existing.id);
      const live = sessions.current.get(existing.id);
      if (live && live.status !== 'closed' && !live.busy && !live.asking) {
        live.sendText(BRAIN_RESOLVE_PROMPT);
        setTimeout(() => {
          const s2 = sessions.current.get(existing.id);
          if (s2 && s2.status !== 'closed') s2.sendText('\r');
        }, 200);
      }
      return;
    }
    const s = spawn(bypass, undefined, false, 'agent', BRAIN_RESOLVE_PROMPT, '', serverCurrent);
    setSessionList((prev) => [...prev, { id: s.id, title: BRAIN_RESOLVE_TITLE, kind: 'agent', bypass: s.bypass, claudeId: s.claudeId }]);
    const pid = nextPaneId();
    setPanes((prev) => [...prev, { id: pid, tabs: [s.id], active: s.id }]);
    setActivePaneId(pid);
    setExpanded(true);
  }, [caps, agentSettings.enabled, sessionList, spawn, bypass, focusSession, serverCurrent]);

  useEffect(() => {
    const onRun = () => runBrainResolveAgent();
    window.addEventListener(RUN_BRAIN_RESOLVE_EVENT, onRun);
    return () => window.removeEventListener(RUN_BRAIN_RESOLVE_EVENT, onRun);
  }, [runBrainResolveAgent]);

  // ── Delegate a task to a background agent (from a board card's context menu) ──────
  // A board task card hands a task to Claude via the DELEGATE_AGENT_EVENT bridge (the
  // decoupled window-event pattern, since the board lives in the page tree and this surface
  // is mounted above the router). Spawn a fresh agent with the composed prompt auto-submitted
  // SERVER-SIDE (race-free — the same positional-arg mechanism as Sleep / brain-resolve;
  // degrades to type-without-submit only against a stale server), titled with
  // the task name, and start it MINIMIZED: it appears immediately as a background corner chip
  // and works without stealing the screen. Clicking the chip restores it as a pane (the dock's
  // onOpen → restoreMinimized, since its id is in minimizedIds). Same guards as the other
  // spawn-from-elsewhere paths (desktop + node-pty + claude CLI + surface enabled).
  // Returns whether it actually spawned — the caller (the board's Delegate composer) reports
  // success or a real error from this, never optimistically. See `requestDelegateAgent`.
  const delegateAgent = useCallback((detail: DelegateAgentDetail): boolean => {
    if (!(caps?.desktop && caps.embeddedTerminal && caps.claudeCli) || !agentSettings.enabled) return false;
    const title = detail.title.trim() || 'Delegated task';
    // The caller already routed the prompt to a transport (inline for a short one, a POSTed
    // token for a large one) — see `delegateTaskToAgent`. Exactly one of the two is set.
    const s = spawn(detail.bypass, undefined, false, 'agent', detail.prompt, '', serverCurrent, detail.promptToken);
    setSessionList((prev) => [...prev, { id: s.id, title, kind: 'agent', bypass: s.bypass, claudeId: s.claudeId }]);

    if (detail.reveal) {
      // Show it: give the session a pane and open the overlay. Mirrors `addSession` — a tab of
      // the focused pane, or the first pane if there is none — so a revealed delegate lands
      // exactly where a ⌘T agent would, rather than inventing a placement of its own.
      if (panes.length === 0) {
        const pid = nextPaneId();
        setPanes([{ id: pid, tabs: [s.id], active: s.id }]);
        setActivePaneId(pid);
      } else {
        const apid = panes.some((p) => p.id === activePaneId) ? activePaneId : panes[0].id;
        setPanes((prev) => prev.map((p) => (p.id === apid ? { ...p, tabs: [...p.tabs, s.id], active: s.id } : p)));
        setActivePaneId(apid);
      }
      setExpanded(true);
      return true;
    }

    // Otherwise begin life as a background (minimized) session: no pane, and the overlay stays
    // as it is. Set the Session's own `minimized` flag NOW — the layout effect won't run
    // (panes/expanded are unchanged by a minimize-only spawn), so without this the idle timer
    // couldn't raise the "finished" attention badge on the corner chip when the run completes.
    s.minimized = true;
    setMinimizedIds((prev) => (prev.includes(s.id) ? prev : [...prev, s.id]));
    return true;
  }, [caps, agentSettings.enabled, spawn, serverCurrent, panes, activePaneId]);

  useEffect(() => {
    // Synchronous ACK: `dispatchEvent` runs listeners inline, so writing `accepted` back onto
    // the detail is visible to `requestDelegateAgent` the moment it returns.
    const onDelegate = (e: Event) => {
      const detail = (e as CustomEvent<DelegateAgentDetail>).detail;
      // Either transport counts as "there is a prompt"; a detail carrying neither is a no-op.
      if ((detail?.prompt || detail?.promptToken) && delegateAgent(detail)) detail.accepted = true;
    };
    window.addEventListener(DELEGATE_AGENT_EVENT, onDelegate);
    return () => window.removeEventListener(DELEGATE_AGENT_EVENT, onDelegate);
  }, [delegateAgent]);

  // ── Task Manager: a task's own agent, hosted by its detail view ──────────────────
  // The task page owns no session: it renders `.agent-task-manager-slot[data-task="<slug>"]` and
  // this surface moves the session's DOM into it (see the layout effect). Curate sessions are
  // deliberately NOT in `sessionList` — that list is the roster + the corner dock, and a
  // task-scoped session should neither restore on launch nor sit as a chip once you've closed
  // the task. They live only here, keyed by slug.
  const tmRef = useRef<Map<string, string>>(new Map()); // slug -> session id
  // Bumped whenever a Task Manager slot appears or leaves. The layout effect reads the DOM for
  // slots, and React can't tell it that a slot in ANOTHER tree just mounted — so the page's
  // attach/detach events poke it.
  const [tmEpoch, bumpTm] = useReducer((n: number) => n + 1, 0);

  const taskManagerAgent = useCallback((detail: TaskManagerDetail): boolean => {
    if (!(caps?.desktop && caps.embeddedTerminal && caps.claudeCli) || !agentSettings.enabled) return false;
    const existing = tmRef.current.get(detail.slug);
    // Reopening a task you already have a live session for: keep the conversation, just let the
    // layout effect re-home it into the freshly-mounted slot. Spawning again would abandon a
    // running agent and (worse) race its own conversation id.
    if (existing && sessions.current.has(existing)) { bumpTm(); return true; }
    // Always ask to resume: the id is stable per task, and the server falls back to
    // `--session-id <same id>` when no transcript exists yet — so a never-curated task and a
    // half-curated one take the same path, and neither errors.
    //
    // deferPrompt=true: the pin prompt must NOT open the conversation — the session boots
    // idle and the prompt rides the USER's first message as hook-injected context (see
    // taskManagerAgent.ts). The server drops it entirely on a real resume, where the
    // context is already in the transcript.
    const s = spawn(detail.bypass, taskManagerConversationId(detail.slug), true, 'agent', detail.prompt, '', serverCurrent, detail.promptToken, true);
    tmRef.current.set(detail.slug, s.id);
    bumpTm();
    return true;
  }, [caps, agentSettings.enabled, spawn, serverCurrent]);

  // Publish each Task Manager session's status to its pane. The pane can't read `sessions.current`
  // (it lives in another tree and must not own session state), and polling would miss the
  // moment that matters most — `asking`, when Claude is blocked on an answer and the user is
  // looking at a task doc rather than the terminal. `bumpStatus` already re-renders this
  // component on every status change, so riding `statusTick` reports at exactly the right rate.
  useEffect(() => {
    tmRef.current.forEach((sid, slug) => {
      const s = sessions.current.get(sid);
      if (!s) return;
      const info = deriveSessionStatus({ status: s.status, busy: s.busy, asking: s.asking });
      window.dispatchEvent(new CustomEvent<TaskManagerStatusDetail>(TASK_MANAGER_STATUS_EVENT, {
        detail: { slug, kind: info.kind, label: info.label },
      }));
    });
  }, [statusTick, tmEpoch]);

  useEffect(() => {
    const onCurate = (e: Event) => {
      const detail = (e as CustomEvent<TaskManagerDetail>).detail;
      if (detail?.slug && taskManagerAgent(detail)) detail.accepted = true;
    };
    // Detach ≠ dispose. The task detail is closing, so the slot is about to vanish — but the
    // agent may be mid-edit, and closing a task must not kill work the user asked for. The
    // session is disposed only when its conversation is explicitly reset, or on unmount below.
    const onDetach = () => bumpTm();
    const onSend = (e: Event) => {
      const { slug, text, submit = true } = (e as CustomEvent<TaskManagerSendDetail>).detail ?? {};
      const sid = slug ? tmRef.current.get(slug) : undefined;
      const s = sid ? sessions.current.get(sid) : undefined;
      if (s && text) s.sendText(submit ? `${text}\r` : text);
    };
    window.addEventListener(TASK_MANAGER_EVENT, onCurate);
    window.addEventListener(TASK_MANAGER_DETACH_EVENT, onDetach);
    window.addEventListener(TASK_MANAGER_SEND_EVENT, onSend);
    return () => {
      window.removeEventListener(TASK_MANAGER_EVENT, onCurate);
      window.removeEventListener(TASK_MANAGER_DETACH_EVENT, onDetach);
      window.removeEventListener(TASK_MANAGER_SEND_EVENT, onSend);
    };
  }, [taskManagerAgent]);

  // ── Bottom strip ─────────────────────────────────────────────────────────────────
  // There is NO separate text field: a skill/file goes straight into the terminal's OWN
  // input line (Claude Code's readline). Model/effort target the FOCUSED agent via the live
  // `/model` and `/effort` slash commands.

  // The live (non-closed) session behind a roster id, if any.
  const liveSession = useCallback((sid: string): Session | undefined => {
    const meta = sessionList.find((m) => m.id === sid);
    if (!meta || meta.dormant) return undefined;
    const s = sessions.current.get(sid);
    return s && s.status !== 'closed' ? s : undefined;
  }, [sessionList]);

  // A live CLAUDE AGENT (not a shell) — model/effort only apply to agents, so `/model`
  // /`/effort` are never injected into a plain shell.
  const liveAgent = useCallback((sid: string): Session | undefined => {
    const meta = sessionList.find((m) => m.id === sid);
    return meta?.kind === 'agent' ? liveSession(sid) : undefined;
  }, [sessionList, liveSession]);

  // Type `text` into a terminal's readline WITHOUT submitting — the user finishes the line
  // (e.g. types the topic after `/council `). Target: the focused live session, else any live
  // session, else spawn a fresh agent (CLI defaults) with the text pre-typed.
  const injectToTerminal = useCallback((text: string) => {
    if (!text) return;
    setExpanded(true);
    let target = liveSession(focusedSessionId);
    if (!target) {
      const liveMeta = sessionList.find((m) => liveSession(m.id));
      if (liveMeta) { target = liveSession(liveMeta.id); focusSession(liveMeta.id); }
    }
    if (target) { target.sendText(text); target.term.focus(); return; }
    if (!(caps?.embeddedTerminal && caps.claudeCli)) return;
    const s = spawn(bypass, undefined, false, 'agent', text, '', false);
    setSessionList((prev) => [...prev, { id: s.id, title: titleFor(s), kind: 'agent', bypass: s.bypass, claudeId: s.claudeId }]);
    const pid = nextPaneId();
    setPanes((prev) => [...prev, { id: pid, tabs: [s.id], active: s.id }]);
    setActivePaneId(pid);
  }, [focusedSessionId, sessionList, liveSession, focusSession, caps, spawn, bypass]);

  // Inject into a SPECIFIC session (the pane whose composer fired) so each agent's bar
  // targets its OWN terminal — not the globally-focused one. Falls back to the generic
  // focused/any/spawn path only if that pane's session isn't live (e.g. dormant).
  const injectToSession = useCallback((sid: string, text: string) => {
    if (!text) return;
    const target = liveSession(sid);
    if (target) { setExpanded(true); target.sendText(text); target.term.focus(); return; }
    injectToTerminal(text);
  }, [liveSession, injectToTerminal]);

  // A skill trigger goes straight into that pane's terminal input.
  const insertSkillInto = useCallback((sid: string, snippet: string) => injectToSession(sid, snippet), [injectToSession]);

  // ── Per-agent model / effort ─────────────────────────────────────────────────────
  // Switch a SPECIFIC agent's model/effort with the live slash command Claude Code exposes
  // (`/model <alias>`, `/effort <level>`), and reflect it immediately. No-op without a live
  // agent behind that pane (the pickers are disabled then).
  const changeModelFor = useCallback((sid: string, id: string) => {
    const target = liveAgent(sid);
    if (!target || !id) return;
    target.sendText(`/model ${id}\r`);
    target.term.focus();
    setSessionModel((prev) => ({ ...prev, [sid]: id }));
  }, [liveAgent]);

  const changeEffortFor = useCallback((sid: string, level: string) => {
    const target = liveAgent(sid);
    if (!target || !level) return;
    target.sendText(`/effort ${level}\r`);
    target.term.focus();
    setSessionEffort((prev) => ({ ...prev, [sid]: level }));
  }, [liveAgent]);

  // Read each visible pane's agent CURRENT model from its transcript when the layout or
  // roster changes (a mid-session `/model` switch — ours or the user's own — is reflected
  // on the next layout change). Every pane's bar shows its OWN agent's real model. Fresh
  // sessions have no transcript yet, so a picker falls back to the CLI default until a turn.
  useEffect(() => {
    if (!caps?.desktop) return;
    let cancelled = false;
    const activeSids = Array.from(new Set(panes.map((p) => p.active)));
    activeSids.forEach((sid) => {
      const meta = sessionList.find((m) => m.id === sid);
      if (!meta || meta.dormant || !meta.claudeId) return;
      void api.get<{ model: string | null }>(`/agent/session-model?claudeId=${encodeURIComponent(meta.claudeId)}`)
        .then((r) => { if (!cancelled && r?.model) setSessionModel((prev) => ({ ...prev, [meta.id]: r.model as string })); })
        .catch(() => { /* best-effort: keep the fallback */ });
    });
    return () => { cancelled = true; };
  }, [panes, sessionList, caps]);

  // Native multi-select picker (files OR folders — the Tauri dialog can't mix the two in
  // one dialog) → drop the chosen absolute paths (quoted) into a pane's terminal.
  const handlePickPathsFor = useCallback(async (sid: string, kind: 'files' | 'folders') => {
    const paths = kind === 'folders' ? await pickFolders() : await pickFiles();
    if (!paths.length) return;
    injectToSession(sid, `${paths.map(quotePath).join(' ')} `);
  }, [injectToSession]);

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
    // Two families of session with a home, homed for INDEPENDENT reasons:
    //  • a pane's active tab — homed in the overlay's `.agent-pane-slot[data-pane]`;
    //  • a task's Task Manager session — homed in the detail's `.agent-task-manager-slot[data-task]`,
    //    which lives in the PAGE tree, so it is found by searching the document rather than
    //    `hostRef` (that only contains the overlay's own panes).
    const paneHomed = new Set(panes.map((p) => p.active));

    const tmSlots = new Map<string, HTMLElement>();
    document.querySelectorAll<HTMLElement>('.agent-task-manager-slot[data-task]')
      .forEach((el) => { if (el.dataset.task) tmSlots.set(el.dataset.task, el); });
    // Only a session whose slot is actually mounted has a home; one whose task was
    // closed goes to the garage and keeps running there.
    const tmHomed = new Map<string, HTMLElement>();
    tmRef.current.forEach((sid, slug) => {
      const slot = tmSlots.get(slug);
      if (slot) tmHomed.set(sid, slot);
    });

    // HOMED and FOREGROUND are different questions, and conflating them regresses the
    // persistence invariant. A collapsed overlay's panes are still homed (their slots merely go
    // `display:none`) — garaging them on collapse would thrash the DOM on every expand. But
    // they are NOT foreground, so a session finishing while collapsed still earns its dock
    // attention badge. A curate session inverts the pane case: it is foreground whenever its
    // task is open, regardless of the overlay.
    const homed = new Set([...paneHomed, ...tmHomed.keys()]);
    const foreground = new Set([...(expanded ? paneHomed : []), ...tmHomed.keys()]);
    sessions.current.forEach((s) => { s.minimized = !foreground.has(s.id); });

    const slots = new Map<string, HTMLElement>();
    hostRef.current?.querySelectorAll<HTMLElement>('.agent-pane-slot[data-pane]')
      .forEach((el) => { if (el.dataset.pane) slots.set(el.dataset.pane, el); });

    panes.forEach((pane) => {
      const s = sessions.current.get(pane.active);
      const slot = slots.get(pane.id);
      if (s && slot && s.container.parentElement !== slot) { slot.appendChild(s.container); s.ensureOpen(); }
    });
    tmHomed.forEach((slot, sid) => {
      const s = sessions.current.get(sid);
      if (s && s.container.parentElement !== slot) { slot.appendChild(s.container); s.ensureOpen(); }
    });
    sessions.current.forEach((s) => {
      if (!homed.has(s.id) && garageRef.current && s.container.parentElement !== garageRef.current) {
        garageRef.current.appendChild(s.container);
      }
    });
    // A freshly-shown container only has offsetParent after display, so open/fit next
    // frame. Refits everything ON SCREEN (a split/combine changes every pane's width, and a
    // Task Manager pane's width depends on the task view's layout mode).
    const raf = requestAnimationFrame(() => {
      foreground.forEach((id) => { const s = sessions.current.get(id); if (s) { s.ensureOpen(); s.fitAndResize(); } });
    });
    return () => cancelAnimationFrame(raf);
    // tmEpoch is the poke from the task page: its slot mounting/unmounting is a DOM event
    // in another tree that React would otherwise never tell us about.
  }, [panes, expanded, tmEpoch]);

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

  // Any container width change → refit every visible pane. A ResizeObserver on the host
  // (not just window `resize`) is required because collapsing/expanding the sidebar is a
  // pure CSS layout change: the surface widens with no window resize event, so a
  // window-only listener would leave the xterm on its stale column count and clip text.
  // Split widths, window resize, and sidebar toggle all funnel through this one observer.
  //
  // Fit only after the size SETTLES, never per event: the sidebar animates width for
  // 240ms (--transition-normal), so the observer fires every frame and a per-frame
  // fit reflows every xterm grid mid-animation — the visible frame-by-frame judder.
  // Each event resets the timer, so a continuous animation (sidebar toggle, window
  // drag) yields exactly one fit after its final frame.
  useEffect(() => {
    if (!expanded) return;
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; fitVisible(); }, 150);
    });
    ro.observe(host);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
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
      if (ae?.closest('.agent-composer')) return;     // the composer field owns Esc (don't discard a draft)
      // The composer's popover menus portal to <body> (outside .agent-composer), so a
      // focused skill chip / model row must also own Esc — close the menu, not the overlay.
      if (ae?.closest('.agent-composer-menu')) return;
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
      // A chord defers to the composer text field too (⌃A there is select-all, not a toggle);
      // a double-tap modifier is still safe to fire from anywhere, including the field.
      if (!dt && ae?.closest('.agent-composer')) return;
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
  // Fires when a live AGENT session completes a turn (a busy→idle edge). The server reads
  // that session's first user message from its transcript and returns a Haiku-generated
  // title; we apply it ONLY if the tab still carries its default "Agent N" name (a tab you
  // renamed is never overwritten). It settles to at most ONE successful Haiku call per tab,
  // but a call that finds nothing yet (an interrupted or not-yet-flushed first turn) leaves
  // the tab RETRYABLE — so the tab you actually worked on gets named on its next completed
  // turn, instead of permanently losing its title to a slower, older tab's late rename.
  useEffect(() => {
    if (!agentSettings.enabled || !agentSettings.autoTitle) return;
    sessions.current.forEach((s, id) => {
      const wasBusy = busyPrevRef.current.get(id) ?? false;
      busyPrevRef.current.set(id, s.busy);
      if (!(wasBusy && !s.busy)) return;          // fire on every turn-complete edge…
      // …but skip if already named, ineligible, or a request is already outstanding.
      if (s.kind !== 'agent' || autoTitledRef.current.has(id) || titleInFlightRef.current.has(id)) return;
      const meta = sessionList.find((m) => m.id === id);
      // Permanently ineligible if the tab was renamed by the user or is a dormant restore.
      if (!meta || meta.dormant || !/^Agent \d+$/.test(meta.title)) {
        autoTitledRef.current.add(id);
        return;
      }
      // Retry budget spent → keep the default name for good (see titleAttemptsRef).
      const attempts = titleAttemptsRef.current.get(id) ?? 0;
      if (attempts >= 8) { autoTitledRef.current.add(id); return; }
      titleAttemptsRef.current.set(id, attempts + 1);
      titleInFlightRef.current.add(id);           // one outstanding call at a time
      void api.post<{ title: string | null; reason?: string }>('/agent/title', { claudeId: s.claudeId })
        .then((r) => {
          const title = r?.title?.trim();
          // No title yet: leave the id retryable so the NEXT completed turn names this
          // exact tab. Cost differs by WHY it failed: a miss WITH a reason is a cheap
          // pre-spawn null (transcript/message not flushed yet — no claude process ran)
          // and costs 1 of the 8-attempt budget; a miss WITHOUT a reason means a real
          // Haiku spawn ran and produced nothing (unauthenticated / broken CLI — likely
          // persistent) and costs 4, so a dead CLI burns at most 2 real spawns per tab
          // instead of 8.
          if (!title) {
            if (!r?.reason) titleAttemptsRef.current.set(id, (titleAttemptsRef.current.get(id) ?? 1) + 3);
            return;
          }
          autoTitledRef.current.add(id);          // got a name — done, never ask again
          // Re-check the default guard inside the updater: the user may have renamed the
          // tab while Haiku was thinking — their choice wins.
          setSessionList((prev) => prev.map((m) => (
            m.id === id && /^Agent \d+$/.test(m.title) ? { ...m, title } : m
          )));
        })
        .catch(() => { /* best-effort: a failed title just leaves the default name */ })
        .finally(() => { titleInFlightRef.current.delete(id); });
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

  // ── Keyboard: ⌘D agent split · ⌘⇧D terminal split · ⌘T new agent tab · ⌘W close focused ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !started) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) return;
      // Typing in the composer field must never trigger the ⌘D/⌘⇧D/⌘T/⌘W/⌃` session chords
      // (⌘W would close the focused session mid-compose).
      if ((document.activeElement as Element | null)?.closest('.agent-composer')) return;
      // ⌃` → new TERMINAL tab (standard "toggle terminal" chord). This is the ONLY Ctrl combo
      // we claim: every OTHER Ctrl chord (⌃C SIGINT, ⌃D EOF, ⌃W delete-word) MUST reach the
      // PTY, or a shell session is unusable — so the ⌘D/⌘T/⌘W app chords below are gated on
      // metaKey WITHOUT ctrlKey (previously `metaKey || ctrlKey` swallowed ⌃D/⌃W/⌃T too).
      if (e.ctrlKey && !e.metaKey && e.key === '`') { e.preventDefault(); e.stopPropagation(); addSession('shell'); return; }
      if (!e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      // ⌘D → new AGENT split · ⌘⇧D → new TERMINAL split (same side-by-side action, shell kind).
      if (k === 'd') { e.preventDefault(); e.stopPropagation(); addSplitSession(e.shiftKey ? 'shell' : 'agent'); }
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
        // Inject the path AND land keyboard focus on this session — a drop is async
        // (read bytes → POST), so the user may start typing before it resolves; grabbing
        // focus here guarantees the follow-up prompt goes to the session that got the file.
        const s = sessions.current.get(sid);
        if (path && s) { s.sendText(quoteIfNeeded(path) + ' '); s.term.focus(); }
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
    // Move keyboard focus to the drop target NOW (its container is already in its slot —
    // it's the pane's active tab — so focus lands synchronously). Without this, the path is
    // injected into the right session but the user's keystrokes still go to whatever
    // terminal held focus before the drop — the "I dropped on A but typed into B" bug.
    focusTerm(targetSid);
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
        info: deriveSessionStatus({ dormant: meta?.dormant, status: s?.status, busy: s?.busy, asking: s?.asking }),
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
      kind: meta.kind,
      info: deriveSessionStatus({ dormant: meta.dormant, status: s?.status, busy: s?.busy, asking: s?.asking }),
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
                composer={!activeMeta?.dormant && (
                  <PaneComposer
                    claudeId={activeMeta?.claudeId}
                    isAgent={activeMeta?.kind === 'agent'}
                    isLiveAgent={!!liveAgent(pane.active)}
                    modelConfig={modelConfig}
                    model={sessionModel[pane.active] ?? modelConfig.defaultModel}
                    effort={sessionEffort[pane.active] ?? modelConfig.defaultEffort}
                    onInsert={(snippet) => insertSkillInto(pane.active, snippet)}
                    onPickFiles={() => handlePickPathsFor(pane.active, 'files')}
                    onPickFolders={() => handlePickPathsFor(pane.active, 'folders')}
                    onModelChange={(id) => changeModelFor(pane.active, id)}
                    onEffortChange={(level) => changeEffortFor(pane.active, level)}
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
      <div
        ref={hostRef}
        className={`agent-surface${expanded ? ' expanded' : ''}`}
        /* The minimized-sessions dock floats over our bottom-right corner — flag it so the
           corner pane's composer can clear its anchor chip (model/effort stay visible). */
        data-dock-floating={caps?.desktop && expanded && minimizedRows.length > 0 ? 'true' : undefined}
      >
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
                    title="New agent (⌘T) · side-by-side: ⌘D agent, ⌘⇧D terminal"
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
        {/* Each pane renders its OWN composer strip (files + skills + that agent's live
            model & effort) pinned to its bottom — see the `composer` prop above. */}
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
