import {
  useEffect, useMemo, useRef, useState, useReducer, useCallback, useLayoutEffect,
} from 'react';
import { createPortal } from 'react-dom';
import './AgentTerminal.css';
import { api } from '../../api/client';
import { useVault, useApi, useInstanceEvent, emitInstance } from '../../context/VaultContext';
import { uploadAgentFile } from '../../lib/agentDrop';
import {
  createSession, currentZoom,
  type Capabilities, type Session, type SessionKind,
} from './agentSession';
import { createChatSession, type ChatSession, type ChatUserItem } from './chatSession';
import { ChatPaneHost, type ChatSurfaceActions } from './ChatPaneHost';
import {
  initAgentSettingsFromServer, readAgentSettings, patchAgentSettings, matchesAccel,
  doubleTapToken, createDoubleTapMatcher,
  AGENT_SETTINGS_EVENT, type AgentSettings,
  readChatPermissionMode, writeChatPermissionMode,
  CHAT_PERMISSION_MODE_EVENT, type ChatPermissionMode,
} from '../../lib/agentSettings';
import { deriveSessionStatus, rollupProject, type ProjectRollup, type SessionRow } from './agentStatus';
import { PaneFragment, type PaneActions } from './PaneFragment';
import { AgentTabs, type PaneVM } from './AgentTabs';
import { AgentDock } from './AgentDock';
import { AgentFab } from './AgentFab';
import {
  BypassToggle, Prereqs, Centered, BotMark,
  titleStyle, subStyle, primaryBtn, secondaryBtn,
} from './AgentSetup';
import { RUN_SLEEP_AGENT_EVENT, SLEEP_AGENT_TITLE, SLEEP_AGENT_PROMPT } from '../../lib/sleepAgent';
import { RUN_BRAIN_RESOLVE_EVENT, BRAIN_RESOLVE_TITLE, BRAIN_RESOLVE_PROMPT } from '../../lib/brainResolveAgent';
import { DELEGATE_AGENT_EVENT, type DelegateAgentDetail } from '../../lib/delegateAgent';
import { AutomationAttentionOpener } from './AutomationAttentionOpener';
import {
  AUTOMATION_RUN_CHAT_EVENT, automationRunTabTitle,
  type AutomationRunChatDetail, type AutomationRunRef,
} from '../../lib/automationRunChat';
import {
  AUTOMATION_CREATE_CHAT_EVENT, type AutomationCreateChatDetail,
} from '../../lib/automationCreateChat';
import { PaneComposer } from './PaneComposer';
import { quotePath, FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { CHAT_MODE_ROWS, DEFAULT_CHAT_MODE, type ChatMode } from '../../lib/chatModes';
import { preparePrompt, developKickoffPrompt } from '../../lib/agentPrompt';
import { clearPins } from '../../lib/pinStore';
import { dropScratch } from './chat/composerScratch';
import { CLAUDE_SIGNIN_EVENT } from '../../lib/claudeAuth';
import { useAgentModelConfig, useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import { useServerHealth } from '../../hooks/useServerHealth';
import { pickFiles, pickFolders } from '../../lib/desktop';
import { listenForChecklistSubmits, type ChecklistSubmitPayload } from '../../lib/checklistBridge';
import { ChatHistoryPicker, type PastSession } from './ChatHistoryPicker';

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

/**
 * This project's chip state, published on the INSTANCE bus for the window chrome to draw.
 *
 * On the bus rather than on `window` for the usual reason — with several projects mounted in
 * one window, a `window` event would have every chip repainted from whichever surface emitted
 * last. The detail is a {@link ProjectRollup}; the chrome keys it by the vault of the instance
 * that forwarded it, so the surface never has to name itself.
 */
export const PROJECT_ROLLUP_EVENT = 'dc-project-rollup';

// ── Layout model ─────────────────────────────────────────────────────────────────

interface SessionMeta {
  id: string;          // matches Session.id (or a synthetic `restored-N` while dormant)
  title: string;       // renameable; default "Agent N" / "Terminal N"
  kind: SessionKind;   // Claude agent, or a plain vault-scoped login shell
  bypass: boolean;
  claudeId: string;    // the Claude conversation UUID (persisted → `claude --resume` on reopen)
  dormant?: boolean;   // a restored roster entry with NO live Session yet (Resume to spawn)
  /** Set only on a hydration-time placeholder for a `kind: 'automation'` entry this
   *  machine never bound (see the X2 filter in the hydrate effect below) — `resumeSession`
   *  refuses to spawn for a flagged entry instead of opening a doomed WS connect that would
   *  read, from the client's side, indistinguishable from a crash. */
  unbound?: boolean;
  /** Which automation run this tab resumed, present only for `kind: 'automation'`.
   *  Round-tripped through the server roster (`SavedMeta.automation`) purely so the
   *  provenance survives a relaunch; nothing in THIS file reconstructs the richer
   *  `AutomationRunRef` header from it. */
  automation?: { slug: string; runFiredAt: string };
  /** How this CHAT tab's agent is briefed to work. Absent for every other kind, and absent on
   *  a chat that never left Basic — `undefined` reads as {@link DEFAULT_CHAT_MODE} everywhere,
   *  so a legacy roster needs no migration. Round-tripped through the server roster so a
   *  Develop tab reopens as one after a relaunch. */
  mode?: ChatMode;
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

/** Default title for a fresh session: "Terminal N" for a shell, "Agent N" for an agent,
 *  "Chat N" for a chat (BETA). Terminal sessions (agent + shell) share one `agent-N` id
 *  sequence (agentSession.ts's single `sessionSeq`); chat sessions have their own `chat-N`
 *  sequence (chatSession.ts's `chatSessionSeq`) — strip whichever prefix is present. */
function titleFor(s: Session | ChatSession): string {
  const num = s.id.replace(/^(?:agent|chat)-/, '');
  if (s.kind === 'shell') return `Terminal ${num}`;
  if (s.kind === 'chat') return `Chat ${num}`;
  return `Agent ${num}`;
}

/** X2's placeholder title suffix, appended IDEMPOTENTLY: the tab this labels gets
 *  persisted back to the roster with the suffix already on it (see the hydrate effect), so
 *  a second launch that finds the SAME session still unbound must not pile up a second copy
 *  of the explanation. */
const NOT_AVAILABLE_SUFFIX = ' — not available on this machine';
function withNotAvailableSuffix(title: string): string {
  return title.endsWith(NOT_AVAILABLE_SUFFIX) ? title : `${title}${NOT_AVAILABLE_SUFFIX}`;
}

/** "Is this tab still carrying the name we gave it?" — the auto-title eligibility gate.
 *  Deliberately kind-AGNOSTIC across the two titleable kinds: a tab converted between
 *  terminal and chat (`openAgentInChat` / `resumeChatInTerminal`) keeps the roster title
 *  it had before the swap, so an "Agent 3" that became a chat — or a "Chat 3" that became
 *  a terminal — is still an unnamed tab and must stay eligible. Shells ("Terminal N") are
 *  never auto-titled, so their pattern is intentionally absent. */
const DEFAULT_TAB_TITLE_RE = /^(?:Agent|Chat) \d+$/;

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
  /** Present only alongside `kind: 'automation'` — which automation produced this run, and
   *  when it fired. Mirrors the server's `SavedMeta.automation`. */
  automation?: { slug: string; runFiredAt: string };
  /** GET-response-ONLY (never sent on PUT): can THIS machine actually resume `sessionId`,
   *  per the server's `isAutomationBoundSession` check. Absent from a legacy server that
   *  hasn't been updated is treated as "not bound" by the hydrate filter below — the safe
   *  default for a flag whose whole job is gating a resume attempt. */
  bound?: boolean;
  /** The chat mode this tab was last in. Mirrors the server's `SavedMeta.mode`, which keeps it
   *  only alongside `kind: 'chat'` and only for a known `CHAT_MODES` value. */
  mode?: ChatMode;
}

/**
 * Is this roster value a mode this build can actually SPAWN under? A hand-edited roster, or
 * one written by a build that has a mode this one doesn't, degrades to Basic rather than
 * travelling onward — the same discipline the server's `coerceMeta` applies on the way in.
 *
 * DISABLED rows are excluded, which is why this filters rather than just testing membership.
 * `CHAT_MODE_ROWS` is the MENU's list, and it carries J.A.R.V.I.S so the capability can be
 * announced as "Soon" — but the server's `sanitizeChatMode` coerces `jarvis` straight back to
 * Basic (agent-spawn-shared.ts), so accepting it here would let the client hold a mode the
 * spawn can never honour: the roster would say Develop-or-J.A.R.V.I.S while every process ran
 * Basic. Matching the server's allowlist exactly keeps the two from disagreeing.
 */
function knownChatMode(v: unknown): ChatMode | undefined {
  return CHAT_MODE_ROWS.some((r) => r.id === v && !r.disabled) ? (v as ChatMode) : undefined;
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

/**
 * Carry the half-typed composer draft from a chat session onto the one REPLACING it.
 *
 * A chat pane's identity IS its session object — `ChatPaneHost` is keyed by session id and
 * portaled into that session's own container — so every respawn path below unmounts the pane
 * and mounts a fresh one. The textarea's text is LOCAL React state (Composer.tsx's draft
 * discipline), so without this it died with the outgoing pane: switching mode, or moving
 * permission to Bypass (which CLI 2.1.220 refuses to switch LIVE, making the fallback respawn
 * the NORMAL path there rather than an edge case), silently ate whatever the user was typing.
 * A control that reloads the conversation is allowed to cost a process; it is not allowed to
 * cost a message the user has not sent yet.
 *
 * `syncDraft` mirrors every keystroke into `conv.draft`, so the outgoing session's model is an
 * accurate copy of the textarea — READ IT BEFORE `dispose()`, which is why every caller
 * captures the string first and calls this after the respawn. `sendText` appends it to the
 * incoming session's still-empty draft (the same external-insert path a dropped file uses) and
 * bumps `draftEpoch`; the fresh Composer reads `conv.draft` in its `useState` initializer, so
 * the text is in the box on FIRST paint rather than arriving a frame later.
 *
 * NOT attempted for chat→terminal ("Continue in Terminal"): a draft would have to be typed
 * into the CLI's readline after a boot-settle delay, and a draft containing a newline would
 * submit itself halfway. Losing it there is better than sending half a message.
 */
function carryDraftInto(next: ChatSession, draft: string): void {
  if (draft) next.sendText(draft);
}

// ── The persistent surface ─────────────────────────────────────────────────────

export function AgentSurface() {
  // Which project this surface belongs to. Every session it spawns, every file it uploads and
  // the checklist bridge it registers are bound to THIS vault — one window holds several live
  // projects, so reading an "active vault" module global here would spawn a project's agent
  // against whichever chip the user last touched.
  // `isActive` is whether this project is the chip the user is LOOKING at. It gates two
  // things only — when a terminal grabs focus, and when it is (re)fitted. It must never
  // reach a WebSocket: a hidden instance stays mounted and fully live, its chat still
  // streaming, and the only thing a chip switch changes is what the pixels are measured
  // against (see HARD CONSTRAINT #2 in the project-tabs plan).
  const { vault, isActive, bus } = useVault();
  // A vault-scoped client for the PER-VAULT routes below (session roster, auto-title,
  // open-terminal) — none of these are on the server's `VAULT_AGNOSTIC_PREFIXES` list, so the
  // module `api` singleton would resolve them against whichever vault the server happens to be
  // pinned to. `/agent/capabilities` and `/agent/session-model` stay on the singleton: they are
  // agnostic (machine-level facts / keyed by claudeId), same answer for every instance.
  const scopedApi = useApi();
  // The whole surface is mounted once (App.tsx) and toggled between a hidden state and
  // a fullscreen overlay by this local flag. Sessions live in the detached-DOM garage
  // either way, so toggling `expanded` NEVER remounts xterm/WebSocket/PTY.
  const [expanded, setExpanded] = useState(false);
  // macOS-style zoom: when `expanded` flips false the surface stays rendered with a
  // `closing` class so the shrink-to-dock animation can play; `onAnimationEnd` (plus a
  // safety timeout for reduced-motion, where no animation event fires) then hides it.
  const [closing, setClosing] = useState(false);
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (expanded) { setClosing(false); wasExpanded.current = true; return; }
    if (!wasExpanded.current) return;
    setClosing(true);
    const t = window.setTimeout(() => setClosing(false), 400);
    return () => window.clearTimeout(t);
  }, [expanded]);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [capsError, setCapsError] = useState(false);
  const [bypass, setBypass] = useState(false); // default for NEW sessions
  const [sessionList, setSessionList] = useState<SessionMeta[]>([]);
  // Mirrored so `closeSessionById` can read the roster (to find a DORMANT tab's conversation
  // id) without taking `sessionList` as a dependency — it is passed as `onClose` to memoized
  // tab/dock components, and re-creating it on every roster change would re-render them all.
  const sessionListRef = useRef(sessionList);
  sessionListRef.current = sessionList;
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
  // The "Past chats" picker (⌘⇧O, or the header's ◷ button) — every conversation this
  // project has on disk, searchable, resumable. Rendered OUTSIDE `.agent-surface`; see
  // the note at its render site.
  const [historyOpen, setHistoryOpen] = useState(false);
  // Agents (beta) surface preferences (Settings → Agents): feature on/off, restore
  // past tabs, default agent, in-app toggle hotkey. Seeded synchronously from
  // localStorage, then reconciled with the server file on mount, and kept live via
  // the AGENT_SETTINGS_EVENT the Settings page dispatches on save.
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(() => readAgentSettings());
  // Mirrored into a ref for the SAME reason `chatPermissionModeRef` is: `spawn` reads the
  // remembered chat model/effort default, and a settings change can be followed by a spawn in
  // the same tick (the composer's "Set as default" then a ⌘T). Reading through the ref also
  // keeps `spawn`'s identity off `agentSettings`, so editing an unrelated preference doesn't
  // rebuild every callback that closes over it.
  const agentSettingsRef = useRef(agentSettings);
  agentSettingsRef.current = agentSettings;
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

  // What a session's model/effort ACTUALLY are right now, in the same authority order the
  // pane's own props use (see the `<ChatPaneHost>` render): an explicit picker choice for this
  // tab first, then whatever the CLI reported at `system:init`. `||`, not `??` — both start as
  // EMPTY STRINGS until the init frame lands, and '' must fall through to the next source
  // rather than being passed on as a model name.
  //
  // Extracted because every respawn path needs it: without these, a resume or a mode switch
  // silently dropped the session's model and effort back to the CLI defaults (a pre-existing
  // defect in `resumeChatSession`, fixed by using them).
  const modelForSession = useCallback((s: ChatSession) => sessionModel[s.id] || s.model, [sessionModel]);
  const effortForSession = useCallback((s: ChatSession) => sessionEffort[s.id] || s.effort, [sessionEffort]);

  // ── Agent screen (Settings → Agents): Chat (the default) vs Terminal (legacy) — a SWAP,
  // not a superset. `chatView` picks which surface a Claude session opens as, and the chosen
  // one takes over EVERY entry point (＋ New, ⌘T/⌘D, empty state, tab restore/resume, Sleep /
  // brain-resolve / delegate spawns): chat mode never opens a terminal Claude, terminal
  // mode never opens a chat. Plain shells (⌃`) are orthogonal and stay available in both.
  // Chat additionally needs the claude CLI; already-running sessions keep their surface —
  // the preference applies to sessions opened (or resumed) from then on.
  const chatMode = !!agentSettings.chatView && !!caps?.claudeCli;
  // Typed SessionKind (not the narrower 'agent' | 'chat') so it shares a type with the
  // hydrate/resume/automation-tab call sites that need to fold in the THIRD case —
  // 'automation' is a DISPLAY kind, decoupled from which surface actually resumes the
  // conversation (see agentSession.ts's SessionKind doc), so this computation's VALUE never
  // changes: every consumer below (past-chat resume, Sleep, brain-resolve, ⌘T/⌘D, …) keeps
  // spawning exactly the agent/chat surface it always has.
  const claudeKind: SessionKind = chatMode ? 'chat' : 'agent';
  // Can a Claude session of the CHOSEN surface spawn at all? (Terminal Claude needs
  // node-pty + the CLI; Chat needs only the CLI.)
  const claudeReady = chatMode || !!(caps?.embeddedTerminal && caps?.claudeCli);

  const sessions = useRef<Map<string, Session | ChatSession>>(new Map());

  // Dispose every session when this surface unmounts.
  //
  // Until projects became chips this was unnecessary — the surface was mounted once, at the
  // app root, and outlived everything, so the only way to end a session was to close it
  // explicitly (`closeSessionById` and the chat resume/hand-off paths). A `ProjectInstance`
  // can now be torn down under the user: closing a chip, and the ceiling rule evicting the
  // oldest idle project into a cold chip. Without this, that teardown leaks the PTY, the
  // WebSocket, the xterm, the theme `MutationObserver` and the per-session
  // `AGENT_SETTINGS_EVENT` listener — and leaves an orphaned `claude` process on the machine.
  //
  // This is the cleanup for an unmount somebody ELSE decided on; nothing here ever decides to
  // unmount an instance. Empty deps so it runs on unmount ONLY, never on a re-render.
  // `dispose()` is internally try/caught per teardown step, but wrap per SESSION too so one
  // throw cannot abort the loop and strand the rest.
  useEffect(() => () => {
    sessions.current.forEach((s) => { try { s.dispose(); } catch { /* best-effort */ } });
    sessions.current.clear();
  }, []);
  // ── The remembered chat permission mode — PER VAULT, not part of `agentSettings` ────
  //
  // Everything in `agentSettings` is a surface preference that is genuinely the same in every
  // project. This one decides whether an agent auto-approves everything it is asked to do,
  // against ONE project's files and ONE project's git, so it is stored per vault and its
  // change notification rides this instance's bus (see `lib/agentSettings.ts`'s split note).
  // On `window` — which is where it lived while a project meant a whole OS window — flipping
  // bypass while looking at project A would rewrite the remembered default for every other
  // live project, and every session they spawned afterwards would run auto-approved in a
  // project the user never opted in for.
  //
  // `vault` is fixed for the life of this mount (`ProjectInstance` reads it once and never
  // changes it), so seeding from storage in the initializer is the whole read path.
  const [chatPermissionMode, setChatPermissionMode] = useState<ChatPermissionMode>(
    () => readChatPermissionMode(vault),
  );
  // Mirrored into a ref so `spawn` reads the CURRENT value even when called from a closure
  // captured before the change landed in state — see `changeChatPermissionMode` and spawn's
  // chat arm.
  const chatPermissionModeRef = useRef(chatPermissionMode);
  chatPermissionModeRef.current = chatPermissionMode;
  // A Settings page in THIS project changed it. Same instance, same bus — and a Settings page
  // in another chip cannot reach us, which is the point.
  useInstanceEvent<ChatPermissionMode>(CHAT_PERMISSION_MODE_EVENT, (mode) => {
    if (mode) setChatPermissionMode(mode);
  });
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
  // The SAME fact as render state, for gates that are evaluated during render rather than
  // inside an effect — today the D7 automation-attention opener, which must not put a tab
  // on screen before the saved roster has landed. A ref cannot do that job: flipping it
  // schedules no render, so a gate reading it would stay stale until something unrelated
  // re-rendered the surface. Every write below sets both, always together.
  const [hydrated, setHydrated] = useState(false);
  // Auto-title bookkeeping. `autoTitledRef` holds session ids that are DONE — either
  // successfully named or permanently ineligible (user-renamed / dormant) — so we never
  // ask again. `titleInFlightRef` holds ids with a Haiku call currently outstanding, so a
  // second busy→idle edge doesn't fire a duplicate concurrent request. Crucially, a call
  // that comes back empty (transcript/message not flushed yet, e.g. an INTERRUPTED first
  // turn) does NOT mark the id done — it stays retryable, so the tab you actually worked on
  // still gets named on its next completed turn instead of silently losing the race.
  // `busyPrevRef` is the prior busy state per session, so we fire on the busy→idle edge.
  // ── The Claude account changed underneath us ───────────────────────────────────────
  //
  // `claude` reads its credentials once, at startup, so signing into a different account
  // leaves every already-running session talking to the API as the OLD one. Chat sessions
  // fix themselves (`armAuthRestart` below respawns each one on the same conversation id the
  // moment it is idle); this strip is how the user finds out that happened, and the only
  // thing a TERMINAL session gets — a live TUI cannot be respawned without throwing away its
  // screen and whatever is half-typed in it, so those are named rather than restarted.
  //
  // `resumeChatRef` exists purely for declaration order: `armAuthRestart` has to be defined
  // before `spawn` (which arms every chat it creates), and `resumeChatSession` is defined
  // after it because it IS a spawn caller. Same latest-value ref idiom as
  // `chatPermissionModeRef` above.
  const resumeChatRef = useRef<((cs: ChatSession) => void) | null>(null);
  const [authNotice, setAuthNotice] = useState<{
    identity: string; loggedIn: boolean | null; restarted: number;
  } | null>(null);
  /** Record an account change, folding repeats into the one strip. Keyed by IDENTITY rather
   *  than by a counter, so the two detectors that can report the same switch — the chat
   *  socket (instant) and the capabilities poll (≤30s, and the only one a terminal-only user
   *  has) — collapse into a single notice instead of racing to overwrite each other. */
  const noteAuthChange = useCallback((identity: string, loggedIn: boolean | null, restarted: number) => {
    setAuthNotice((prev) => {
      if (!prev || prev.identity !== identity || prev.loggedIn !== loggedIn) {
        return { identity, loggedIn, restarted };
      }
      return restarted ? { ...prev, restarted: prev.restarted + restarted } : prev;
    });
  }, []);

  /**
   * Watch ONE chat session for the account-changed frame and restart it onto the new
   * credentials — the whole point of the feature, and the reason the frame exists.
   *
   * Three refusals, each deliberate:
   *   • BUSY / a card open — a turn in flight was authorized by the old credentials and will
   *     finish on them. Killing it mid-answer to save one turn's attribution is a bad trade,
   *     so the restart waits for the boundary; `subscribe` fires on every applied event, so
   *     the busy→idle edge is what eventually lets it through.
   *   • ALREADY EXITED — the "Session ended" banner already offers Resume, and that resume
   *     picks up the new account for free. Two restart paths for one dead process is one too
   *     many.
   *   • `restart: false` — the server could not confirm a signed-in account (see
   *     claude-auth-watch.ts's `isRestartable`). The user is told; nothing is killed.
   *
   * And one hard stop: NO LONGER REGISTERED. Closing a tab disposes its session, and the
   * socket teardown that follows still flips `busy` to false — which is exactly the "now it
   * is idle, restart it" edge this is watching for. Respawning there would put a live
   * `claude` behind a tab that no longer exists in the roster or in any pane: an invisible,
   * unclosable process. The registry is the authority on whether this session is still
   * something the surface owns.
   */
  const armAuthRestart = useCallback((cs: ChatSession) => {
    let settled = false;
    let noticed = false;
    const stop = () => { settled = true; off(); };
    const off = cs.subscribe(() => {
      if (settled) return;
      if (sessions.current.get(cs.id) !== cs) { stop(); return; }  // closed/replaced — see above
      const changed = cs.getModel().authChanged;
      if (!changed) return;
      if (!noticed) { noticed = true; noteAuthChange(changed.identity, changed.loggedIn, 0); }
      if (!changed.restart || cs.getModel().exited) { stop(); return; }
      if (cs.busy || cs.asking) return;  // wait for the turn boundary
      stop();
      noteAuthChange(changed.identity, changed.loggedIn, 1);
      resumeChatRef.current?.(cs);
    });
  }, [noteAuthChange]);

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

  // The SLOW, universal half of account-change detection. `caps` above is fetched once at
  // mount, so it can never notice a switch; this is the app-wide 30s query (already mounted
  // by the header's sleep tracker, so it costs no extra request) read purely for its epoch.
  //
  // The chat socket beats it by ~30s and is what actually drives the restarts. This exists
  // for the case the socket cannot cover: a user with no chat session open at all — a
  // terminal-only user, or one sitting on the empty surface — who otherwise would get no
  // signal that their terminals are now running as the wrong account.
  //
  // Compares the EPOCH, not the email: an unknown probe carries no email either, so a
  // string diff would read "probe recovered" as an account switch. The epoch only ever
  // advances on a confirmed change (claude-auth-watch.ts).
  const { data: polledCaps } = useAgentCapabilities();
  const authEpochRef = useRef<number | null>(null);
  useEffect(() => {
    const auth = polledCaps?.claudeAuth;
    if (typeof auth?.epoch !== 'number') return;
    const seen = authEpochRef.current;
    authEpochRef.current = auth.epoch;
    // First reading BASELINES. Without this, simply opening the app after having switched
    // accounts at some point in the server's life would announce a switch that is old news.
    if (seen === null || auth.epoch <= seen) return;
    noteAuthChange([auth.email, auth.subscription].filter(Boolean).join(' · '), auth.loggedIn, 0);
  }, [polledCaps, noteAuthChange]);

  // ── Agent-surface settings: load the server-persisted prefs once, then track
  //    live changes the Settings page broadcasts (no reload needed). ──
  // Deliberately on `window`: what remains in this blob (surface on/off, restore-tabs,
  // renderer, hotkey, Chat-vs-Terminal) is genuinely app-global and mirrored to
  // ~/.dreamcontext/agent-ui.json, so EVERY live project should re-apply a change at once.
  // The one field that was not — `chatPermissionMode` — has left this blob entirely.
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
    // Chat needs only the claude CLI, not node-pty (agent-terminal.ts's `embeddedTerminal`
    // gate) — a saved chat tab must still restore on a node-pty-broken machine, so this gate
    // matches the same loosened predicate the body/menu/empty-state gates below use. Gated on
    // `agentSettings.chatView` too: someone who switched to Terminal (legacy) must mean
    // claudeCli alone can NEVER widen this gate — otherwise a terminal user on a pty-broken
    // machine would get agent tabs auto-restored into doomed WS connections instead of the
    // Prereqs panel.
    if (hydratedRef.current || !(caps?.embeddedTerminal || (caps?.claudeCli && agentSettings.chatView)) || !settingsReady) return;
    if (!agentSettings.restoreTabs) { hydratedRef.current = true; setHydrated(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await scopedApi.get<{ sessions: SavedMeta[] }>('/agent/sessions');
        // Terminals are never remembered — drop any shell entry, plus any legacy roster
        // row still named "Terminal N" (a stale shell saved before we stopped persisting
        // them; auto-title only ever renames AGENTS, so that default name is a reliable
        // shell marker). What's left is agents + chats.
        const saved = Array.isArray(res.sessions)
          ? res.sessions.filter((m) => m.kind !== 'shell' && !/^Terminal \d+$/.test((m.title ?? '').trim()))
          : [];
        // WHAT IS ALREADY ON SCREEN WHEN THE ROSTER LANDS, and why that is not rare.
        // Any tab present at this point was opened between this effect starting and its
        // fetch returning. The D7 automation-attention opener is the case that made this
        // routine: it polls on the SYNCHRONOUS localStorage settings seed, so it needs one
        // round-trip, while this effect waits for `settingsReady` (the server value) and
        // then its own fetch — two, sequentially. It is a genuine race, but a lopsided
        // one, and the restore lost it often enough to cost real users real chats.
        //
        // Such a tab must not be spawned a second time from the roster: two live CLIs
        // `--resume`d onto one conversation interleave their appends and neither sees the
        // other's turns — the dual-attach guard every other resume path in this file
        // enforces. Filtered BEFORE the map, because the map is where `spawn` happens; a
        // dedupe after it would already have started the duplicate process.
        const alreadyOpen = new Set(sessionListRef.current.map((m) => m.claudeId));
        const fresh = saved.filter((m) => !m.sessionId || !alreadyOpen.has(m.sessionId));
        if (!cancelled && fresh.length > 0) {
          // A saved tab WITH a pinned conversation id auto-RESUMES its real Claude session
          // on launch (reopening the app reopens the work via `claude --resume`); a legacy
          // tab without one restores DORMANT (manual Resume). Spawn happens here, once —
          // and only on the non-cancelled invocation, so StrictMode can't double-spawn.
          const restored: SessionMeta[] = fresh.map((m, i) => {
            // Shells restore as shells; an 'automation' entry KEEPS that display kind (see
            // the branch below — C11/C12); every other Claude-backed tab (saved as agent OR
            // chat) reopens as the CURRENTLY chosen Agent screen — the preference is a swap,
            // so a tab saved under the other surface resumes the SAME conversation in this
            // one (both renderers share the transcript + conversation UUID). Before this fix
            // a persisted 'automation' kind fell through to `claudeKind` here and came back
            // as a plain agent — the server-side fix (agent-sessions.ts's `coerceMeta`) was
            // necessary but not sufficient without this read-side counterpart.
            const kind: SessionKind = m.kind === 'shell' ? 'shell' : m.kind === 'automation' ? 'automation' : claudeKind;
            if (kind === 'automation' && m.sessionId) {
              // X2 (blocking): an automation session this MACHINE never bound must not
              // attempt a WS connect at all. T24's server-side gate `rejectUpgrade`s it at
              // the HTTP-upgrade level — below any application frame — so the client's
              // `onclose`/`onerror` would both land in `stopOnClose` with no `lastError`,
              // making a deliberate security refusal indistinguishable from a crash. The
              // server tells us up front (`bound`, computed with `isAutomationBoundSession`
              // — see agent-sessions.ts's `SessionRosterEntry`); a legacy server that hasn't
              // shipped it omits the field, which reads as `false` here — the safe default
              // for a flag whose only job is gating a resume attempt. Render a labelled,
              // non-resumable placeholder INSTEAD of ever calling `spawn`.
              if (!m.bound) {
                return {
                  id: `restored-${i}`,
                  title: withNotAvailableSuffix(m.title),
                  kind,
                  bypass: m.bypass,
                  claudeId: m.sessionId,
                  dormant: true,
                  unbound: true,
                  automation: m.automation,
                };
              }
              // Bound → safe to auto-resume. 'automation' is a DISPLAY kind, not a transport
              // one (see agentSession.ts's SessionKind doc): the conversation is resumed
              // through whichever Claude surface the user has chosen (`claudeKind`), exactly
              // like any other tab, while the roster keeps `kind: 'automation'` so the glyph
              // survives the restore.
              const s = spawn(m.bypass, m.sessionId, true, claudeKind);
              return { id: s.id, title: m.title, kind, bypass: m.bypass, claudeId: m.sessionId, automation: m.automation };
            }
            // An agent OR chat tab with a pinned conversation auto-RESUMES its real Claude
            // session on launch (both spawn a real `claude` against the same conversation
            // UUID). A shell has nothing to resume, and auto-spawning shells on launch is
            // surprising — so shells (and legacy tabs without a conversation id) restore
            // DORMANT, spawning a fresh session only on an explicit Resume click.
            if ((kind === 'agent' || kind === 'chat') && m.sessionId) {
              // A saved CHAT tab reopens under the mode it was last in — a Develop session that
              // survives a relaunch is still a Develop session. `knownChatMode` drops anything
              // this build doesn't recognise, and the mode is only meaningful for the chat
              // surface (a tab saved as chat but restored as a terminal `agent` ignores it,
              // which `spawn`'s non-chat arm does by construction).
              const savedMode = knownChatMode(m.mode) ?? DEFAULT_CHAT_MODE;
              const s = spawn(m.bypass, m.sessionId, true, kind, '', '', true, '', false, '', false, savedMode);
              return {
                id: s.id, title: m.title, kind, bypass: m.bypass, claudeId: m.sessionId,
                ...(kind === 'chat' ? { mode: savedMode } : {}),
              };
            }
            return { id: `restored-${i}`, title: m.title, kind, bypass: m.bypass, claudeId: newClaudeId(), dormant: true };
          });
          // APPEND, NEVER REPLACE — and this is the whole bug fix, not a refinement.
          // These two lines used to read `prev.length > 0 ? prev : restored`, which
          // DISCARDED the entire restore whenever anything had already opened a tab. The
          // damage did not stop at one launch: the `finally` below then flips
          // `hydratedRef`, which unblocks the persist effect, which mirrors the survivor
          // back to the server as THE WHOLE ROSTER. One automation tab opening by itself
          // on launch therefore cost the user every past chat they had, permanently, on
          // the first save after. Restored tabs now join whatever is already here.
          setSessionList((prev) => [...prev, ...restored]);
          setPanes((prev) => {
            if (prev.length === 0) {
              return [{ id: nextPaneId(), tabs: restored.map((m) => m.id), active: restored[0].id }];
            }
            // Restored tabs join the first pane WITHOUT taking its `active` slot: a tab
            // that is already open is one the user — or a run that stopped to ask — is
            // looking at right now. A launch-time restore is background furniture and
            // must not steal the foreground from it.
            return prev.map((p, i) => (i === 0 ? { ...p, tabs: [...p.tabs, ...restored.map((m) => m.id)] } : p));
          });
        }
      } catch { /* no saved roster (or non-desktop 403) — just start fresh */ }
      finally { if (!cancelled) { hydratedRef.current = true; setHydrated(true); } }
    })();
    return () => { cancelled = true; };
  }, [caps, settingsReady, agentSettings.restoreTabs, agentSettings.chatView, scopedApi]);

  // Persist on every roster change (post-hydrate), debounced. AGENTS and CHATS are
  // remembered — plain TERMINALS are session-local and never reopened on launch (the server
  // also can't resume a shell, and a stale `claude --resume` on a shell's id would wrongly
  // reopen it as an agent). Saves both dormant and live metas so a renamed live session is
  // captured too. `minimized`/`size` are inert defaults kept only for persisted-format
  // compatibility. Best-effort: a failed PUT just means this change isn't mirrored.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const handle = setTimeout(() => {
      const payload = {
        sessions: sessionList
          .filter((m) => m.kind !== 'shell')
          .map((m) => ({
            title: m.title, kind: m.kind, bypass: m.bypass, minimized: false, size: 1, sessionId: m.claudeId,
            // Only carried for automation tabs — the server's `coerceMeta` drops it for
            // every other kind anyway, but there's no reason to send it otherwise.
            ...(m.kind === 'automation' && m.automation ? { automation: m.automation } : {}),
            // Same rule for the chat mode: it means nothing on a shell or a terminal agent,
            // and `coerceMeta` keeps it only alongside `kind: 'chat'`. Basic is the absent
            // state on BOTH sides, so a plain chat tab's payload is unchanged.
            ...(m.kind === 'chat' && m.mode && m.mode !== DEFAULT_CHAT_MODE ? { mode: m.mode } : {}),
          })),
      };
      void scopedApi.put('/agent/sessions', payload).catch(() => { /* best-effort mirror */ });
    }, 400);
    return () => clearTimeout(handle);
  }, [sessionList, scopedApi]);

  // ── Session actions ────────────────────────────────────────────────────────
  // claudeId omitted → a fresh conversation (new UUID via `--session-id`); provided with
  // resume=true → reopen that exact conversation (`--resume`) after an app relaunch.
  // `promptToken` carries an initial prompt too large for the upgrade URL — mint it with
  // `preparePrompt` (lib/agentPrompt.ts) BEFORE calling spawn, so spawn itself stays
  // synchronous (the delegate ACK in lib/delegateAgent.ts depends on that).
  // `bp` is every caller's REQUESTED bypass (the surface-wide toggle, a delegate's own
  // per-card choice, …) — for a CHAT session it is overridden here by THIS VAULT's remembered
  // permission-mode default (`chatPermissionMode`, state 6's top-right
  // dropdown) rather than trusted verbatim. Centralizing the resolution HERE (instead of
  // at each call site) means every current and future chat-spawn path — addSession,
  // addSplitSession, openAgentInChat, dormant resume, resumeChatSession, runSleepAgent,
  // runBrainResolveAgent, the skill-insert fallback spawn — inherits the remembered mode
  // automatically, with nothing to individually audit or forget.
  //
  // `explicitBypass` is the one documented exemption, and only the Delegate composer sets it.
  // The remembered default exists for spawns that carry NO permission decision of their own —
  // ⌘T, a resume, a Sleep chip. A delegate carries one: the user looked at a checkbox about
  // THIS hand-off ("let it act without approval prompts, so it can finish while you're away")
  // and answered it seconds ago. Overriding that answer with a global default made the
  // checkbox decorative on the Chat surface — an autonomous overnight delegate would sit
  // waiting on a permission prompt, and a "Discuss" hand-off that must not touch files could
  // run under bypassPermissions.
  //
  // TWELVE POSITIONAL PARAMETERS, and the order below is load-bearing — a call that gets one
  // slot wrong compiles cleanly and misbehaves silently (a `false` landing in `explicitBypass`
  // is exactly how a hand-off could have inherited a remembered `bypass`). Read this before
  // adding or editing a call site:
  //
  //   1 bp             2 claudeId      3 resume        4 kind
  //   5 initialPrompt  6 model         7 submitInitial 8 promptToken
  //   9 deferPrompt   10 effort       11 explicitBypass 12 mode
  const spawn = useCallback((bp: boolean, claudeId?: string, resume = false, kind: SessionKind = 'agent', initialPrompt = '', model = '', submitInitial = true, promptToken = '', deferPrompt = false, effort = '', explicitBypass = false, mode: ChatMode = DEFAULT_CHAT_MODE) => {
    if (kind === 'chat') {
      // Read through the REF, not the state value: `changeChatPermissionMode` below can
      // respawn a conversation in the very same tick it changes the mode, and this closure's
      // `chatPermissionMode` would still be the pre-change render's — spawning the fallback
      // under exactly the mode the user just left.
      const effectiveBypass = explicitBypass ? bp : chatPermissionModeRef.current === 'bypass';
      // The remembered model/effort default (`Set as default` in the composer's model menu)
      // applies ONLY here, in the chat arm, and ONLY as a fallback: a caller that named a
      // model named it for a reason (a resume carrying the session's own, a delegate's pick),
      // and '' means "inherit whatever the CLI's own settings.json says" — which is what a
      // user who never pressed the button still gets. A terminal agent is untouched by this:
      // its defaults come from the CLI directly, and this preference is a Chat-surface one.
      const chatModel = model || agentSettingsRef.current.chatDefaultModel;
      const chatEffort = effort || agentSettingsRef.current.chatDefaultEffort;
      // Chat (BETA) is a headless stream-json engine, not a PTY — createChatSession has its
      // own factory (chatSession.ts), takes `effort` at spawn (the terminal only ever
      // switches it live via `/effort`, so its own createSession has no such param), and has
      // no `submitInitial` concept (an initial prompt is always delivered server-side; see
      // chatSession.ts's header note).
      const cs = createChatSession(vault ?? '', effectiveBypass, bumpStatus, claudeId ?? newClaudeId(), resume, chatModel, chatEffort, initialPrompt, promptToken, deferPrompt, mode);
      cs.applyZoom(currentZoom());
      sessions.current.set(cs.id, cs);
      // Every chat spawned anywhere in this surface follows the signed-in account, for the
      // same reason the permission-mode default is resolved here rather than per call site:
      // one place to arm means no future spawn path can forget to.
      armAuthRestart(cs);
      return cs;
    }
    // A shell has no permission model, so bypass is meaningless for it — force it off.
    const s = createSession(vault ?? '', kind === 'shell' ? false : bp, bumpStatus, claudeId ?? newClaudeId(), resume, kind, initialPrompt, model, submitInitial, promptToken, deferPrompt);
    s.applyZoom(currentZoom());
    sessions.current.set(s.id, s);
    return s;
  }, [chatPermissionMode, vault, armAuthRestart]);

  // Spawn a fresh session AND append its roster entry — the two steps every "new session"
  // path shares. Callers keep only their pane placement, so the roster-entry shape lives in
  // ONE place (adding a field like `kind` can't drift between add-tab and add-split).
  const spawnAndRegister = useCallback((kind: SessionKind) => {
    // A new agent inherits the user's CLI defaults (model/effort from ~/.claude/settings.json);
    // the picker then reflects and can change them per agent. Nothing is forced at launch.
    // A new CHAT starts in Basic — there is deliberately no remembered mode default (the mode
    // menu has no "Set as default"), so `s.mode` is whatever `spawn` defaulted to and the
    // roster records the session's own answer rather than a second copy of the constant.
    const s = spawn(bypass, undefined, false, kind);
    setSessionList((prev) => [...prev, {
      id: s.id, title: titleFor(s), kind: s.kind, bypass: s.bypass, claudeId: s.claudeId,
      ...(s.kind === 'chat' ? { mode: (s as ChatSession).mode } : {}),
    }]);
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
    // THE one path that ends a conversation for good, which is why the pin sweep lives here
    // and nowhere else. Every path that KEEPS the conversation — `resumeChatSession`,
    // `resumeChatInTerminal`, `openAgentInChat`, the mode-switch respawn — disposes and swaps
    // the tab id in place without coming through here, so none of them can lose their pins.
    //
    // The Plan→Develop hand-off DOES close through here, and clearing is still right: pins are
    // keyed by the CLAUDE conversation id, and the Develop session is spawned with a fresh
    // one, so the plan tab's pins were already unreachable from it the moment it was created.
    // Leaving them behind would only leave litter no surface can ever read.
    //
    // Read from the live session when there is one, and fall back to the roster so a DORMANT
    // restored tab (no live session, but a real conversation id from a previous run) also
    // takes its pins with it.
    const live = sessions.current.get(sid);
    const meta = sessionListRef.current.find((m) => m.id === sid);
    const kind = live?.kind ?? meta?.kind;
    const claudeId = live?.claudeId ?? meta?.claudeId;
    if (kind === 'chat' && vault && claudeId) clearPins(vault, claudeId);
    // Same sweep, same reasoning, one line later: the composer's staged chips and reply quote
    // are keyed by the conversation id too (composerScratch.ts), and this is the only path
    // that ends a conversation. It is also where the chips' object URLs are released — the
    // composer deliberately does NOT revoke them on unmount, because a respawn unmounts a pane
    // whose chips are still wanted.
    if (kind === 'chat' && claudeId) dropScratch(claudeId);

    // dispose is hardened, but NEVER let a teardown throw block the actual removal —
    // one click must always make the tab disappear.
    try { sessions.current.get(sid)?.dispose(); } catch { /* best-effort */ }
    sessions.current.delete(sid);
    setSessionList((prev) => prev.filter((s) => s.id !== sid));
    setPanes((prev) => prev.map((p) => removeFromPane(p, sid)).filter((p) => p.tabs.length > 0));
    setMinimizedIds((prev) => (prev.includes(sid) ? prev.filter((x) => x !== sid) : prev));
  }, [vault]);

  // Resume a DORMANT restored tab: spawn a real session for it (using the saved bypass
  // default) and swap the synthetic `restored-N` id for the live `agent-N` one in place
  // (in BOTH the roster and its pane), keeping the title.
  const resumeSession = useCallback((sid: string) => {
    const meta = sessionList.find((m) => m.id === sid);
    if (!meta?.dormant) return;
    if (meta.unbound) {
      // X2's placeholder: this automation session was never bound on THIS machine (see the
      // hydrate filter above) — resuming it would open a doomed WS connect that `rejectUpgrade`s
      // at the HTTP-upgrade level, indistinguishable from a crash. Refuse, and say why, rather
      // than silently doing nothing (the same "a refusal must not look like a crash" principle,
      // one click later).
      alert(`${meta.title}\n\nThis automation's session was recorded on a different machine and was never bound here, so it can't be resumed on this one.`);
      return;
    }
    // Agent/chat → resume the EXACT prior Claude conversation (`--resume <claudeId>`) in the
    // CURRENTLY chosen Agent screen (the surface preference is a swap — a tab dormant since
    // the other mode was active resumes the same conversation in this one). Shell → there is
    // no conversation to resume, so just open a fresh vault-scoped login shell.
    const s = meta.kind === 'shell'
      ? spawn(meta.bypass, undefined, false, 'shell')
      : spawn(meta.bypass, meta.claudeId, true, claudeKind);
    // 'automation' is a DISPLAY kind decoupled from transport (see hydration above and
    // `openAutomationRunChat` below) — preserve it rather than letting the spawned session's
    // actual agent/chat kind overwrite it on a manual resume of a dormant automation tab.
    const kind: SessionKind = meta.kind === 'automation' ? 'automation' : s.kind;
    setSessionList((prev) => prev.map((m) => (m.id === sid ? { ...m, id: s.id, kind, bypass: s.bypass, claudeId: s.claudeId, dormant: false } : m)));
    setPanes((prev) => prev.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t === sid ? s.id : t)),
      active: p.active === sid ? s.id : p.active,
    })));
  }, [spawn, sessionList, claudeKind]);

  // ── Signing in to Claude from inside the surface ──────────────────────────────────
  //
  // Chat CANNOT do this. Its engine is `claude -p --input-format stream-json`, which answers
  // `/login` with "/login isn't available in this environment." and reports an unauthenticated
  // turn as an `authentication_failed` assistant frame (both verified against CLI 2.1.220 in an
  // isolated HOME) — the sign-in flow needs a real terminal. So the chat pane's sign-in banner,
  // and a `/login` typed into its composer, land here instead of in the void.
  //
  // What this opens is a SHELL tab that runs the sign-in command and submits it, so the CLI's
  // own "Select login method" picker is the first thing on screen; the CLI opens the browser
  // itself and prints the URL as a fallback. A shell, not a Claude agent, because the command
  // is a shell command (`claude auth login`) — and because a login-only tab has no business
  // pinning a conversation UUID it will never use.
  //
  // The command comes from the server's probe (`caps.claudeAuth.loginCommand` — claude-auth.ts),
  // never a literal: a CLI too old for the `auth` subcommand reports plain `claude` instead, and
  // typing a command this machine's CLI doesn't have would be worse than showing nothing. The
  // constant below is only the pre-probe default (capabilities still loading), matching that
  // module's CLAUDE_LOGIN_COMMAND.
  const signInCommand = caps?.claudeAuth?.loginCommand || 'claude auth login';
  const signInToClaude = useCallback(() => {
    // `submitInitial` + kind 'shell' → the command is typed into the shell and submitted once
    // its boot output settles (agentSession's armInitialPrompt case b). Bypass is meaningless
    // for a shell and forced off by `spawn` anyway. Titled "Sign in" so the tab says why it
    // exists; that name is outside DEFAULT_TAB_TITLE_RE, so auto-titling leaves it alone.
    const s = spawn(false, undefined, false, 'shell', signInCommand);
    setSessionList((prev) => [...prev, { id: s.id, title: 'Sign in', kind: s.kind, bypass: s.bypass, claudeId: s.claudeId }]);
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
  }, [spawn, panes, activePaneId, signInCommand]);

  // Whether that shell can run at all on this machine — the chat banner prints the command to
  // copy instead of offering a button when it can't (a pane that fails to open is worse than a
  // command you can paste). Needs the embedded terminal for the pane AND the CLI for the
  // command itself.
  const canSignInInApp = !!(caps?.embeddedTerminal && caps?.claudeCli);

  // Settings → here. The System doctor now reports the sign-in state (the server probes it
  // via `claude auth status` — see src/lib/claude-auth.ts) and its "Sign in" button lands on
  // this same flow, because a page below this surface in the tree has no handle on it. Same
  // page-dispatches/surface-listens bridge as the sleep tracker and Delegate — on THIS
  // instance's bus, so the one Settings page that asked gets the one sign-in tab it wanted
  // rather than one per live project.
  useInstanceEvent(CLAUDE_SIGNIN_EVENT, () => { if (canSignInInApp) signInToClaude(); });

  // ── Chat ↔ Terminal conversion (AC7's two directions, BETA) ──────────────────────
  //
  // chat→terminal: "Continue in Terminal view" (the AskUserQuestion degrade escape hatch,
  // and ChatPane's own affordance) — dispose the chat session and resume the SAME
  // conversation UUID as a terminal agent, in place (same id-swap idiom as resumeSession).
  const resumeChatInTerminal = useCallback((cs: ChatSession) => {
    try { cs.dispose(); } catch { /* best-effort */ }
    sessions.current.delete(cs.id);
    const s = spawn(cs.bypass, cs.claudeId, true, 'agent');
    setSessionList((prev) => prev.map((m) => (m.id === cs.id ? { ...m, id: s.id, kind: 'agent', bypass: s.bypass, claudeId: s.claudeId } : m)));
    setPanes((prev) => prev.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t === cs.id ? s.id : t)),
      active: p.active === cs.id ? s.id : p.active,
    })));
  }, [spawn]);

  // State 12's "Session ended" banner Resume — respawn the SAME conversation UUID as a
  // fresh chat session (the process exited; the conversation itself is intact on disk).
  // Mirrors `resumeChatInTerminal`'s dispose-then-respawn idiom but stays in chat.
  //
  // It carries THIS conversation's own settings across, not the project's current defaults —
  // model, effort, permission mode and chat mode all survive the restart. That is a
  // deliberate exemption from `spawn`'s centralized default resolution, on the same reasoning
  // the Delegate composer's is: the remembered default exists for spawns carrying NO
  // permission decision of their own, and resuming a conversation carries the one it is
  // already running under. `cs.bypass` is that answer — `setPermissionMode`'s ack keeps it in
  // lockstep with every accepted live switch (chatSession.ts's control-ack arm) — so
  // `explicitBypass` is set and it is used verbatim. Without that, a session the user moved to
  // `auto` would come back as `bypass` in a project whose remembered default never changed,
  // which is a silent privilege escalation one click deep.
  //
  // `targetBypass` is the deliberate exception, and it is what makes Bypass REACHABLE at all.
  // This function is also `changeChatPermissionMode`'s fallback, and that fallback is the only
  // path that delivers Bypass on a running chat: CLI 2.1.220 refuses every live switch INTO
  // bypass ("the session was not launched with --dangerously-skip-permissions"), so the switch
  // is always a respawn. Carrying `cs.bypass` there would respawn under the mode the user just
  // asked to LEAVE — the click would reconnect the session and land back on `auto`, forever.
  // So that caller passes the requested mode explicitly and this one honours it; every other
  // caller passes nothing and keeps the never-escalate guarantee above. The asymmetry is the
  // point: escalation happens only when a caller names it, never by inheriting a default.
  //
  // CAVEAT, stated rather than hidden: for a session whose socket is already gone (the case
  // this banner exists for), `cs.bypass` is the last value the process ACKNOWLEDGED. A live
  // switch attempted after the process died has no ack, so it is not reflected here. The
  // resumed session's trigger then shows what the new process is genuinely running (ChatPane
  // resolves it from the CLI's own `system:init`), so the indicator stays truthful even when
  // this seed is a beat behind.
  const resumeChatSession = useCallback((cs: ChatSession, targetBypass?: boolean) => {
    // Captured BEFORE dispose, applied after the respawn — see `carryDraftInto`. This path is
    // also the permission-mode fallback, so it is the one a Bypass switch actually takes.
    const carried = cs.getModel().draft;
    try { cs.dispose(); } catch { /* best-effort */ }
    sessions.current.delete(cs.id);
    // `targetBypass` is the ONE thing this path does not carry over when it is passed: the
    // caller is asking for a mode this conversation is NOT running under yet (see the
    // parameter's contract above). Absent — the "Session ended · Resume" case — `cs.bypass`
    // stands, so a resume never escalates.
    const bp = targetBypass ?? cs.bypass;
    const s = spawn(bp, cs.claudeId, true, 'chat', '', modelForSession(cs), true, '', false, effortForSession(cs), true, cs.mode);
    // `spawn` is typed as the Session|ChatSession union; the `'chat'` kind two lines up
    // provably took its chat arm, which is the same narrowing `changeChatMode` does by hand.
    carryDraftInto(s as ChatSession, carried);
    setSessionList((prev) => prev.map((m) => (m.id === cs.id ? { ...m, id: s.id, kind: 'chat', bypass: s.bypass, claudeId: s.claudeId, mode: cs.mode } : m)));
    setPanes((prev) => prev.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t === cs.id ? s.id : t)),
      active: p.active === cs.id ? s.id : p.active,
    })));
  }, [spawn, modelForSession, effortForSession]);
  // The account watcher's restart path calls this through a ref — see `resumeChatRef`'s note
  // for why it can't call it directly. Assigned on every render so the ref never holds a
  // closure over a stale `spawn`.
  resumeChatRef.current = resumeChatSession;

  /**
   * Change how a live chat's agent is BRIEFED, by respawning it under the new brief.
   *
   * A mode is a `--append-system-prompt-file`, fixed when the process starts — there is no
   * live-switch control frame for it the way there is for permission mode. So this reuses the
   * resume path wholesale: same conversation UUID (`--resume`, transcript intact), same model,
   * effort, permission mode and half-typed draft (`carryDraftInto`), new mode. The composer's
   * menu says so out loud rather than letting the reconnect read as a glitch.
   */
  const changeChatMode = useCallback((sid: string, mode: ChatMode) => {
    const cs = sessions.current.get(sid);
    if (!cs || cs.kind !== 'chat') return;
    const chat = cs as ChatSession;
    if (chat.mode === mode) return; // picking the mode you are already in is not a restart
    const carried = chat.getModel().draft;  // BEFORE dispose — see `carryDraftInto`
    try { chat.dispose(); } catch { /* best-effort */ }
    sessions.current.delete(chat.id);
    // Same B3 call shape as `resumeChatSession` above — `explicitBypass` with `bp = cs.bypass`,
    // so switching Basic → Develop can never also switch `auto` → `bypass`.
    const s = spawn(chat.bypass, chat.claudeId, true, 'chat', '', modelForSession(chat), true, '', false, effortForSession(chat), true, mode);
    carryDraftInto(s as ChatSession, carried);  // union → chat arm, as above
    setSessionList((prev) => prev.map((m) => (m.id === chat.id ? { ...m, id: s.id, kind: 'chat', bypass: s.bypass, claudeId: s.claudeId, mode } : m)));
    setPanes((prev) => prev.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t === chat.id ? s.id : t)),
      active: p.active === chat.id ? s.id : p.active,
    })));
  }, [spawn, modelForSession, effortForSession]);

  // The `bypass` dropdown in a chat composer. The mode is ONE setting PER PROJECT (there is a
  // single `chatPermissionMode` for this vault, and every composer's chip in this project
  // shows it), so changing it from any pane must mean three things at once:
  //   1. remembered      — persisted, so every FUTURE chat spawns under it (`spawn`'s chat arm),
  //   2. applied now     — every LIVE chat conversation switches without being restarted
  //                        (`set_permission_mode`), because a chip that reads "bypass" while
  //                        the running process is still on `auto` is simply lying,
  //   3. or else resumed — if a CLI rejects the live switch, that conversation is respawned
  //                        with `--resume` under the new mode, which reaches the same end
  //                        state at the cost of a process restart.
  const changeChatPermissionMode = useCallback((mode: 'auto' | 'bypass') => {
    // Eagerly, so any spawn in THIS tick that resolves the project default (a brand-new chat,
    // a Delegate launch) reads the mode just chosen rather than the one being replaced. The
    // fallback respawn below does NOT rely on this — it is handed the requested mode as an
    // argument, because a session-scoped decision must not be delivered by a project-wide ref.
    chatPermissionModeRef.current = mode;
    // Persist under THIS vault's key and announce on THIS instance's bus, which is also what
    // feeds our own `useInstanceEvent` above and moves the state — one write path, no
    // second `setChatPermissionMode` here that could disagree with what was stored.
    writeChatPermissionMode(bus, vault, mode);
    // A SNAPSHOT of the roster, not `sessions.current.forEach` — and this is load-bearing, not
    // tidiness. `Map.prototype.forEach` visits entries ADDED DURING ITERATION, and the fallback
    // below adds one: `resumeChatSession` deletes the old id and registers the replacement. For
    // a session whose socket is already gone (an ended tab, a server restart, a tab still
    // connecting) `setPermissionMode` fails SYNCHRONOUSLY — `sendControl` returns false on a
    // non-OPEN socket — so the fallback ran inside the loop, the loop then visited the
    // replacement, whose own socket was still CONNECTING, which failed for the same reason and
    // respawned again: an unbounded `claude` spawn storm on one click. Iterating a copy makes a
    // session spawned UNDER the new mode invisible to this pass, which is also the correct
    // semantics — it has nothing left to switch.
    Array.from(sessions.current.values()).forEach((s) => {
      if (s.kind !== 'chat') return;
      const cs = s as ChatSession;
      cs.setPermissionMode(mode, () => resumeChatSession(cs, mode === 'bypass'));
    });
  }, [bus, vault, resumeChatSession]);

  /**
   * Plan → Develop: the hand-off behind a plan agent's "Go to development" button.
   *
   * Opens a NEW chat in Develop mode seeded with the task slug, then closes the plan tab. The
   * owner chose a new session over an in-place `/clear` so the plan transcript stays auditable
   * — this is the code half of that decision.
   *
   * Two orderings are load-bearing:
   *
   *   SPAWN BEFORE CLOSE. `closeSessionById` drops any pane left with zero tabs, so closing
   *   first would delete the pane the new tab is meant to land in whenever the plan tab was
   *   alone in it. The new tab is registered at the plan tab's own index in the plan tab's own
   *   pane, so the work stays where the user was looking.
   *
   *   NEVER ESCALATES. `bp = false` WITH `explicitBypass = true` (params 1 and 11). Without
   *   the explicit flag `spawn`'s chat arm would discard that `false` and adopt the project's
   *   REMEMBERED mode instead — so inside a bypass-remembered project, a button an AGENT wrote
   *   into its own message would have launched a session with every permission pre-granted.
   *   A hand-off carries no permission decision of its own, so it takes the safe one; the user
   *   can still raise it deliberately from the composer.
   */
  const handoffToDevelop = useCallback((cs: ChatSession, taskSlug: string) => {
    void (async () => {
      let prepared: { inline: string; token: string };
      try {
        prepared = await preparePrompt(vault, developKickoffPrompt(taskSlug));
      } catch (err) {
        // `mintPromptToken` rejects rather than degrading to an unseeded session (see its
        // doc). Say so instead of opening a Develop tab that has no idea what it is for.
        console.error('[agent-surface] Plan→Develop hand-off could not prepare its prompt:', err);
        alert(`Could not open the development session for "${taskSlug}".\n\n${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const s = spawn(false, undefined, false, 'chat', prepared.inline, modelForSession(cs), true, prepared.token, false, effortForSession(cs), true, 'develop');
      const meta: SessionMeta = {
        id: s.id, title: taskSlug, kind: 'chat', bypass: s.bypass, claudeId: s.claudeId, mode: 'develop',
      };
      // Land at the plan tab's index in the plan tab's pane. Both lookups run BEFORE the close
      // below, while that tab still exists; `-1`/`undefined` degrade to "append to the focused
      // pane", which is where a new tab goes anyway.
      const planPane = panes.find((p) => p.tabs.includes(cs.id));
      const at = planPane ? planPane.tabs.indexOf(cs.id) : -1;
      setSessionList((prev) => [...prev, meta]);
      setPanes((prev) => prev.map((p) => {
        if (planPane && p.id !== planPane.id) return p;
        if (!planPane && p.id !== activePaneId) return p;
        const tabs = [...p.tabs];
        tabs.splice(at >= 0 ? at : tabs.length, 0, s.id);
        return { ...p, tabs, active: s.id };
      }));
      if (planPane) setActivePaneId(planPane.id);
      closeSessionById(cs.id);
    })();
  }, [spawn, vault, panes, activePaneId, closeSessionById, modelForSession, effortForSession]);

  // ChatPane's "Open in app ↗" (state 3 — a dreamcontext entity referenced from chat).
  // AgentSurface is mounted beside Shell (under `ProjectInstance`) with no direct handle on
  // Shell's navigation state, so this collapses the overlay and fires the event
  // `AgentPageNavBridge` listens for, which does the actual `nav.navigate()`.
  //
  // On the INSTANCE bus. `id` is a task/knowledge slug that means something in exactly one
  // vault: broadcast, every mounted project's bridge would navigate, and all but one would
  // be deep-linking to a slug that does not exist in their brain.
  const onOpenAppPage = useCallback((page: 'tasks' | 'knowledge' | 'core', id: string) => {
    setExpanded(false);
    emitInstance(bus, 'dreamcontext-agent-open-page', { page, id });
  }, [bus]);

  // terminal→chat: the per-tab "Open in Chat (BETA)" action (AgentTabs). CLOSE-FIRST
  // semantics — the chat route keeps its OWN `liveConversations` guard Set (server-side,
  // per-route; it cannot see the terminal route's hold on this conversation), so disposing
  // the terminal session BEFORE spawning the chat resume avoids a live dual-attach on one
  // transcript. Works for both a LIVE and a DORMANT agent tab (dispose is a no-op on a
  // dormant tab; the saved claudeId still resumes as chat either way). Conversation identity
  // (the UUID) is preserved via --resume; if the terminal's transcript hadn't flushed yet at
  // dispose time, the chat resume fresh-pins the same UUID exactly as the terminal's own
  // fresh-fallback (agent-terminal.ts:1234) — continuity of identity, not in-memory
  // scrollback (see the plan's scope call H).
  const openAgentInChat = useCallback((sid: string) => {
    const meta = sessionList.find((m) => m.id === sid);
    if (!meta || meta.kind !== 'agent') return;
    try { sessions.current.get(sid)?.dispose(); } catch { /* best-effort */ }
    sessions.current.delete(sid);
    const cs = spawn(meta.bypass, meta.claudeId, true, 'chat');
    setSessionList((prev) => prev.map((m) => (m.id === sid ? { ...m, id: cs.id, kind: 'chat', bypass: cs.bypass, claudeId: cs.claudeId, dormant: false } : m)));
    setPanes((prev) => prev.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t === sid ? cs.id : t)),
      active: p.active === sid ? cs.id : p.active,
    })));
    setExpanded(true);
  }, [sessionList, spawn]);

  // Focus a session's terminal + clear its attention badge.
  const focusTerm = useCallback((sid: string) => {
    const s = sessions.current.get(sid);
    if (s) { if (s.attention) { s.attention = false; bumpStatus(); } s.focus(); }
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

  // ── Past chats: reopen a conversation that no longer has a tab ────────────────────
  //
  // Claude Code keeps every conversation this project has ever had on disk, and `--resume`
  // reopens any of them — but the surface could only ever reach the ones still holding a
  // roster entry, so closing a tab lost the chat. `ChatHistoryPicker` lists the rest
  // (`GET /api/agent/chat-sessions`); picking one lands here and becomes an ordinary
  // resumed tab — the same path `resumeSession` walks for a dormant roster entry, just
  // sourced from disk instead of from the roster.
  //
  // A conversation that IS already open is brought forward instead of resumed: two live
  // CLIs `--resume`d onto one transcript would interleave their appends, and neither
  // would see the other's turns.
  const resumePastSession = useCallback((past: PastSession) => {
    setHistoryOpen(false);
    setExpanded(true);
    const existing = sessionList.find((m) => m.claudeId === past.id);
    if (existing) {
      if (existing.dormant) resumeSession(existing.id);
      else if (minimizedIds.includes(existing.id)) restoreMinimized(existing.id);
      else focusSession(existing.id);
      return;
    }
    // Resumed in the CURRENTLY chosen Agent screen, like every other resume path — the
    // transcript is the conversation, not the surface it was originally typed into.
    const s = spawn(bypass, past.id, true, claudeKind);
    // Titled with the row's own label (the session's first prompt, clipped) rather than
    // "Chat 7": it is the only thing that tells two resumed tabs apart. The result falls
    // outside DEFAULT_TAB_TITLE_RE, so auto-titling correctly leaves it alone.
    const title = past.title.length > 34 ? `${past.title.slice(0, 33).trimEnd()}…` : past.title;
    setSessionList((prev) => [...prev, {
      id: s.id, title: title || titleFor(s), kind: s.kind, bypass: s.bypass, claudeId: s.claudeId,
    }]);
    if (panes.length === 0) {
      const pid = nextPaneId();
      setPanes([{ id: pid, tabs: [s.id], active: s.id }]);
      setActivePaneId(pid);
    } else {
      const apid = panes.some((p) => p.id === activePaneId) ? activePaneId : panes[0].id;
      setPanes((prev) => prev.map((p) => (p.id === apid ? { ...p, tabs: [...p.tabs, s.id], active: s.id } : p)));
      setActivePaneId(apid);
    }
  }, [
    sessionList, minimizedIds, resumeSession, restoreMinimized, focusSession,
    spawn, bypass, claudeKind, panes, activePaneId,
  ]);

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

  // Re-issue a prompt into an idle EXISTING session, per its surface: a terminal types the
  // prompt then submits with a delayed Enter (the readline needs a beat); a chat submits
  // through its own send() (its sendText only appends to the composer draft — a trailing
  // '\r' would never submit it).
  const resubmitPrompt = useCallback((sid: string, prompt: string) => {
    const live = sessions.current.get(sid);
    if (!live || live.status === 'closed' || live.busy || live.asking) return;
    if (live.kind === 'chat') { (live as ChatSession).send(prompt); return; }
    live.sendText(prompt);
    setTimeout(() => {
      const s2 = sessions.current.get(sid);
      if (s2 && s2.status !== 'closed') s2.sendText('\r');
    }, 200);
  }, []);

  const runSleepAgent = useCallback(() => {
    if (!(caps?.desktop && caps.claudeCli && claudeReady) || !agentSettings.enabled) return;
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
      resubmitPrompt(existing.id, SLEEP_AGENT_PROMPT);
      return;
    }
    const s = spawn(bypass, undefined, false, claudeKind, SLEEP_AGENT_PROMPT, '', serverCurrent);
    setSessionList((prev) => [...prev, { id: s.id, title: SLEEP_AGENT_TITLE, kind: s.kind, bypass: s.bypass, claudeId: s.claudeId }]);
    const pid = nextPaneId();
    setPanes((prev) => [...prev, { id: pid, tabs: [s.id], active: s.id }]);
    setActivePaneId(pid);
  }, [caps, agentSettings.enabled, sessionList, spawn, bypass, focusSession, serverCurrent, claudeKind, claudeReady, resubmitPrompt]);

  // This project's tracker only. A consolidation rewrites one brain; on `window` a single
  // click would start one in every project the chip strip is holding.
  useInstanceEvent(RUN_SLEEP_AGENT_EVENT, () => runSleepAgent());

  // ── Run brain-resolve agent (the sidebar's one-click "Resolve with AI") ──────────
  // Spawn a dedicated "/dream-sync" session that reconciles the deferred team merge,
  // fully autonomously, and EXPAND the overlay so the user can watch progress (a merge
  // resolution is something they'll want to see, unlike a background sleep). Same guards
  // + dedup + version-handshake as runSleepAgent. When it finishes, the sidebar's
  // brain-status poll flips back to "Synced" on its own (pendingAgentMerge → false).
  const runBrainResolveAgent = useCallback(() => {
    if (!(caps?.desktop && caps.claudeCli && claudeReady) || !agentSettings.enabled) return;
    const existing = sessionList.find((m) => !m.dormant && m.title === BRAIN_RESOLVE_TITLE);
    if (existing) {
      setExpanded(true);
      focusSession(existing.id);
      resubmitPrompt(existing.id, BRAIN_RESOLVE_PROMPT);
      return;
    }
    const s = spawn(bypass, undefined, false, claudeKind, BRAIN_RESOLVE_PROMPT, '', serverCurrent);
    setSessionList((prev) => [...prev, { id: s.id, title: BRAIN_RESOLVE_TITLE, kind: s.kind, bypass: s.bypass, claudeId: s.claudeId }]);
    const pid = nextPaneId();
    setPanes((prev) => [...prev, { id: pid, tabs: [s.id], active: s.id }]);
    setActivePaneId(pid);
    setExpanded(true);
  }, [caps, agentSettings.enabled, sessionList, spawn, bypass, focusSession, serverCurrent, claudeKind, claudeReady, resubmitPrompt]);

  useInstanceEvent(RUN_BRAIN_RESOLVE_EVENT, () => runBrainResolveAgent());

  // ── Delegate a task to a background agent (from a board card's context menu) ──────
  // A board task card hands a task to Claude via the DELEGATE_AGENT_EVENT bridge (the
  // decoupled window-event pattern, since the board lives in the page tree and this surface
  // is mounted above the router). Spawn a fresh agent with the composed prompt auto-submitted
  // SERVER-SIDE (race-free — the same positional-arg mechanism as Sleep / brain-resolve;
  // degrades to type-without-submit only against a stale server), titled with
  // the task name, and start it MINIMIZED: it appears immediately as a background corner chip
  // and works without stealing the screen. Clicking the chip restores it as a pane (the dock's
  // onOpen → restoreMinimized, since its id is in minimizedIds). Same guards as the other
  // spawn-from-elsewhere paths (desktop + the chosen Agent screen's prerequisites + surface enabled).
  // Returns whether it actually spawned — the caller (the board's Delegate composer) reports
  // success or a real error from this, never optimistically. See `requestDelegateAgent`.
  const delegateAgent = useCallback((detail: DelegateAgentDetail): boolean => {
    if (!(caps?.desktop && caps.claudeCli && claudeReady) || !agentSettings.enabled) return false;
    const title = detail.title.trim() || 'Delegated task';
    // The caller already routed the prompt to a transport (inline for a short one, a POSTed
    // token for a large one) — see `delegateTaskToAgent`. Exactly one of the two is set.
    // `model` is '' unless the composer's picker was deliberately changed, in which case the
    // agent launches on it; `explicitBypass` honours the composer's own checkbox over the
    // remembered chat default (see `spawn`).
    const model = detail.model ?? '';
    const s = spawn(detail.bypass, undefined, false, claudeKind, detail.prompt, model, serverCurrent, detail.promptToken, false, '', true);
    setSessionList((prev) => [...prev, { id: s.id, title, kind: s.kind, bypass: s.bypass, claudeId: s.claudeId }]);
    // Seed the picker's readout so a delegated pane names the model it was actually launched
    // on from the first frame, instead of showing the global default until the transcript poll
    // catches up.
    if (model) setSessionModel((prev) => ({ ...prev, [s.id]: model }));

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
  }, [caps, agentSettings.enabled, spawn, serverCurrent, panes, activePaneId, claudeKind, claudeReady]);

  // Synchronous ACK: dispatch runs listeners inline, so writing `accepted` back onto the
  // detail is visible to `requestDelegateAgent` the moment it returns.
  //
  // The instance bus is load-bearing HERE above everywhere else. On `window` this listener is
  // one of N, and the first to run sets `accepted` — so the composer in project A is told its
  // task was delegated while the agent doing the work is in project B, reading a task file
  // that does not exist there. See `lib/delegateAgent.ts`'s header.
  useInstanceEvent<DelegateAgentDetail>(DELEGATE_AGENT_EVENT, (detail) => {
    // Either transport counts as "there is a prompt"; a detail carrying neither is a no-op.
    if ((detail?.prompt || detail?.promptToken) && delegateAgent(detail)) detail.accepted = true;
  });

  // ── Open an automation run's conversation (from the Automations run history) ──────
  //
  // The one bridge here that STARTS nothing. A scheduled automation already had this
  // conversation, headless, while nobody was watching; the transcript is on disk exactly
  // like any past chat. So this walks `resumePastSession`'s path — `--resume <sessionId>`
  // in the currently chosen Agent screen — and the only thing that makes it special is the
  // provenance it records, which the pane renders as a header (see `automationRuns`).
  //
  // REVEALED, never backgrounded: unlike a delegate (hand off work, carry on triaging), the
  // user clicked a specific run to LOOK at it. A corner chip would answer the wrong request.
  //
  // Provenance is keyed by the CONVERSATION uuid, not by the tab id, because every resume
  // path in this surface swaps the tab id while preserving `claudeId` (see `resumeSession`
  // and `resumeChatSession`) — keyed by tab, a "Session ended · Resume" would silently drop
  // the header off a conversation that is still exactly the same run.
  const [automationRuns, setAutomationRuns] = useState<Record<string, AutomationRunRef>>({});

  const openAutomationRunChat = useCallback((detail: AutomationRunChatDetail): boolean => {
    if (!(caps?.desktop && caps.claudeCli && claudeReady) || !agentSettings.enabled) return false;
    if (!detail.sessionId) return false;
    const run: AutomationRunRef = {
      slug: detail.slug,
      automationTitle: detail.automationTitle,
      runNumber: detail.runNumber,
      sessionId: detail.sessionId,
      firedAt: detail.firedAt,
      status: detail.status,
      costUsd: detail.costUsd,
      numTurns: detail.numTurns,
      durationMs: detail.durationMs,
      outputPath: detail.outputPath,
    };
    // Recorded BEFORE the spawn so the pane's first render already has its header — and
    // recorded even on the bring-forward path below, so reopening a run whose tab was
    // opened by some other route (a past-chats pick) still gets its provenance.
    setAutomationRuns((prev) => ({ ...prev, [detail.sessionId]: run }));
    setExpanded(true);

    // Already open → bring it forward. Two live CLIs `--resume`d onto one transcript
    // interleave their appends and neither sees the other's turns; the same rule
    // `resumePastSession` enforces, for the same reason.
    const existing = sessionList.find((m) => m.claudeId === detail.sessionId);
    if (existing) {
      if (existing.dormant) resumeSession(existing.id);
      else if (minimizedIds.includes(existing.id)) restoreMinimized(existing.id);
      else focusSession(existing.id);
      return true;
    }

    const s = spawn(bypass, detail.sessionId, true, claudeKind);
    // Titled from the automation, NOT from the conversation's first prompt: that prompt is
    // the approved brief, which is identical across every run of the same job — the past-chat
    // titling rule would produce a row of tabs nobody can tell apart.
    //
    // `kind: 'automation'` — NOT `s.kind` — is the whole C11/C12 fix: `s.kind` is whichever
    // transport `claudeKind` picked ('agent' or 'chat'), so mirroring it here is how this tab
    // silently lost its automation glyph before. 'automation' is a DISPLAY kind decoupled
    // from transport (see agentSession.ts's SessionKind doc); `automation` (slug + fire date)
    // rides along too, so it round-trips through the roster for a future relaunch.
    setSessionList((prev) => [...prev, {
      id: s.id,
      title: automationRunTabTitle(detail.automationTitle, detail.firedAt),
      kind: 'automation',
      bypass: s.bypass,
      claudeId: s.claudeId,
      automation: { slug: detail.slug, runFiredAt: detail.firedAt },
    }]);
    if (panes.length === 0) {
      const pid = nextPaneId();
      setPanes([{ id: pid, tabs: [s.id], active: s.id }]);
      setActivePaneId(pid);
    } else {
      const apid = panes.some((p) => p.id === activePaneId) ? activePaneId : panes[0].id;
      setPanes((prev) => prev.map((p) => (p.id === apid ? { ...p, tabs: [...p.tabs, s.id], active: s.id } : p)));
      setActivePaneId(apid);
    }
    return true;
  }, [
    caps, claudeReady, agentSettings.enabled, sessionList, minimizedIds, resumeSession,
    restoreMinimized, focusSession, spawn, bypass, claudeKind, panes, activePaneId,
  ]);

  // Bus, not `window`, for the same ACK reason as the delegate above — and because N surfaces
  // `--resume`ing one conversation uuid is the dual-attach the bring-forward guard exists to
  // prevent (two live CLIs interleave their appends on one transcript).
  // ── Author a NEW automation by chatting (D3) ──────────────────────────────────────
  //
  // The mirror image of the bridge below: that one RESUMES a conversation this app already
  // had, this one STARTS one that will end with `dreamcontext automations create`. It is a
  // plain delegate underneath — a fresh revealed session carrying the interview brief — so
  // it reuses `delegateAgent` rather than growing a third spawn path, and a chat-authored
  // automation ends up indistinguishable from a hand-authored one.
  //
  // REVEALED, never backgrounded: the user is about to be interviewed, so a corner chip
  // answering questions to itself would be exactly wrong.
  useInstanceEvent<AutomationCreateChatDetail>(AUTOMATION_CREATE_CHAT_EVENT, (detail) => {
    if (!(detail?.prompt || detail?.promptToken)) return;
    const accepted = delegateAgent({
      title: detail.title || 'New automation',
      prompt: detail.prompt,
      promptToken: detail.promptToken,
      bypass,
      reveal: true,
    });
    if (accepted) detail.accepted = true;
  });

  useInstanceEvent<AutomationRunChatDetail>(AUTOMATION_RUN_CHAT_EVENT, (detail) => {
    if (detail?.sessionId && openAutomationRunChat(detail)) detail.accepted = true;
  });

  // ── Checklist submit bridge (T8, plan §1.11/§1.12) ────────────────────────────────
  // The pinned checklist window is a SEPARATE OS window with no WebSocket of its own; its
  // Submit reaches this surface via a targeted Tauri event (`checklistBridge.ts`) rather
  // than the server, which keeps no session registry to route a submit through (a bare
  // `liveConversations: Set<string>`, ids only). `AgentSurface` is the right home because
  // it owns `sessions` for the app's lifetime — a `ChatPane` is per-visible-pane and can be
  // garaged, so it cannot durably hold this listener.
  //
  // `sessionList` is keyed by INTERNAL session id (`chat-N`); `sessions.current` is a
  // `Map<internal id, Session | ChatSession>` keyed the SAME way — NOT by `claudeId`. The
  // submit payload's `conversationId` is a `claudeId`, so it has to be resolved through
  // `sessionList` first (matching on `kind === 'chat'` AND `claudeId`) to get the internal
  // id `sessions.current` actually indexes on. A literal `sessions.current.get(conversationId)`
  // would miss on every single submit.
  //
  // The vault check (payload.vault vs. the window's own vault) lives in the BRIDGE, not
  // here — `listenForChecklistSubmits` takes `vault` for exactly that belt-and-braces
  // comparison, so this handler only ever sees submits already confirmed to belong to this
  // window's vault.
  const handleChecklistSubmit = useCallback((payload: ChecklistSubmitPayload): boolean => {
    const entry = sessionList.find((m) => transportKind(m) === 'chat' && m.claudeId === payload.conversationId);
    const session = entry ? sessions.current.get(entry.id) : undefined;
    if (!session || session.kind !== 'chat') return false;
    const chat = session as ChatSession;
    // `send`, not `sendText` — the owner's "Submit sends the filled-in list back as ONE
    // message" means a real user turn, not a composer-draft append (`sendText` only
    // appends to the draft). Mid-turn it follows the composer's ⏎ exactly (Composer.tsx's
    // `commit`): steer it into the running turn, and fall back to the queue only when that
    // cannot land. A checklist is filled in WHILE the agent works and is answering the thing
    // it is doing right now — making it wait for the turn to end is the whole bug.
    if (chat.busy) { if (!chat.steer(payload.markdown)) chat.enqueue(payload.markdown, { steerWhenPossible: true }); }
    else chat.send(payload.markdown);
    return true;
  }, [sessionList]);

  useEffect(() => {
    if (!vault) return;
    return listenForChecklistSubmits(vault, handleChecklistSubmit);
  }, [vault, handleChecklistSubmit]);

  // ── Bottom strip ─────────────────────────────────────────────────────────────────
  // There is NO separate text field: a skill/file goes straight into the terminal's OWN
  // input line (Claude Code's readline). Model/effort target the FOCUSED agent via the live
  // `/model` and `/effort` slash commands.

  // The live (non-closed) session behind a roster id, if any. No kind filter — this CAN
  // return a live Chat session (its callers, e.g. injectToSession, are shared with chat panes).
  const liveSession = useCallback((sid: string): Session | ChatSession | undefined => {
    const meta = sessionList.find((m) => m.id === sid);
    if (!meta || meta.dormant) return undefined;
    const s = sessions.current.get(sid);
    return s && s.status !== 'closed' ? s : undefined;
  }, [sessionList]);

  /**
   * A tab's TRANSPORT kind — which object actually runs it — as opposed to the display kind
   * `SessionMeta.kind` carries for the tab strip's glyph.
   *
   * `'automation'` is the one place the two diverge, and conflating them is a defect this
   * surface has already paid for: `chatPanes` below filters on `m.kind === 'chat'`, so every
   * automation-run tab spawned a perfectly healthy `ChatSession` — WS open, transcript
   * fetchable — that was then never portaled into a pane. The tab existed, the conversation
   * existed, and the user saw an empty rectangle. `liveChat`/`liveAgent` had the same hole.
   *
   * An automation run rides whichever surface the user has chosen (`claudeKind` at spawn), so
   * the live session is the only authority. `'chat'` is the fallback for a tab whose session
   * is not live yet (dormant/restoring) because that is the transport `openAutomationRunChat`
   * uses whenever the Chat screen is on — and a wrong guess here costs a render, not data:
   * every consumer re-checks the real object before casting.
   */
  const transportKind = useCallback((meta?: SessionMeta): SessionKind | undefined => {
    if (!meta) return undefined;
    if (meta.kind !== 'automation') return meta.kind;
    return sessions.current.get(meta.id)?.kind ?? 'chat';
  }, []);

  // A live CLAUDE AGENT (not a shell, not a chat) — model/effort only apply this way to
  // TERMINAL agents (chat's model/effort pickers go through changeChatModelFor/EffortFor
  // below), so `/model`/`/effort` are never injected into a plain shell or a chat pane.
  // The kind filter guarantees a terminal Session, hence the narrowing cast — its
  // `runCommand` draft-preserving path is what the pickers below need.
  const liveAgent = useCallback((sid: string): Session | undefined => {
    const meta = sessionList.find((m) => m.id === sid);
    return transportKind(meta) === 'agent' ? (liveSession(sid) as Session | undefined) : undefined;
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
    if (target) { target.sendText(text); target.focus(); return; }
    if (!caps?.claudeCli || !claudeReady) return;
    // Fresh spawn in the chosen Agent screen, with the text PRE-TYPED but unsubmitted. A
    // terminal takes it as a client-side initialPrompt (type-without-submit); a chat must
    // NOT (its server path SUBMITS an initial prompt as the first turn) — its sendText
    // appends to the composer draft instead, which is exactly type-without-submit there.
    const s = chatMode
      ? spawn(bypass, undefined, false, 'chat')
      : spawn(bypass, undefined, false, 'agent', text, '', false);
    if (chatMode) s.sendText(text);
    setSessionList((prev) => [...prev, { id: s.id, title: titleFor(s), kind: s.kind, bypass: s.bypass, claudeId: s.claudeId }]);
    const pid = nextPaneId();
    setPanes((prev) => [...prev, { id: pid, tabs: [s.id], active: s.id }]);
    setActivePaneId(pid);
  }, [focusedSessionId, sessionList, liveSession, focusSession, caps, spawn, bypass, chatMode, claudeReady]);

  // Inject into a SPECIFIC session (the pane whose composer fired) so each agent's bar
  // targets its OWN terminal — not the globally-focused one. Falls back to the generic
  // focused/any/spawn path only if that pane's session isn't live (e.g. dormant).
  const injectToSession = useCallback((sid: string, text: string) => {
    if (!text) return;
    const target = liveSession(sid);
    if (target) { setExpanded(true); target.sendText(text); target.focus(); return; }
    injectToTerminal(text);
  }, [liveSession, injectToTerminal]);

  // A skill trigger goes straight into that pane's terminal input.
  const insertSkillInto = useCallback((sid: string, snippet: string) => injectToSession(sid, snippet), [injectToSession]);

  // ── Per-agent model / effort ─────────────────────────────────────────────────────
  // Switch a SPECIFIC agent's model/effort with the live slash command Claude Code exposes
  // (`/model <alias>`, `/effort <level>`), and reflect it immediately. No-op without a live
  // agent behind that pane (the pickers are disabled then). Via `runCommand`, NOT a raw
  // sendText: appending `/model …\r` to a half-typed readline used to submit the user's
  // draft fused with the command — runCommand clears the line, submits the command alone,
  // then restores the draft.
  const changeModelFor = useCallback((sid: string, id: string) => {
    const target = liveAgent(sid);
    if (!target || !id) return;
    target.runCommand(`/model ${id}`);
    target.focus();
    setSessionModel((prev) => ({ ...prev, [sid]: id }));
  }, [liveAgent]);

  const changeEffortFor = useCallback((sid: string, level: string) => {
    const target = liveAgent(sid);
    if (!target || !level) return;
    target.runCommand(`/effort ${level}`);
    target.focus();
    setSessionEffort((prev) => ({ ...prev, [sid]: level }));
  }, [liveAgent]);

  // Chat (BETA) switches model/effort LIVE over the control channel — `set_model` control
  // request for the model, an `/effort <level>` user frame for effort (both empirically
  // verified against CLI 2.1.218; see chatSession.setModel/setEffort). Falls back to
  // picker-state-only (applies on next resume) when the session isn't live.
  const liveChat = useCallback((sid: string): ChatSession | undefined => {
    const meta = sessionList.find((m) => m.id === sid);
    if (transportKind(meta) !== 'chat') return undefined;
    const s = liveSession(sid);
    return s?.kind === 'chat' ? (s as ChatSession) : undefined;
  }, [sessionList, liveSession]);

  const changeChatModelFor = useCallback((sid: string, id: string) => {
    if (!id) return;
    liveChat(sid)?.setModel(id);
    setSessionModel((prev) => ({ ...prev, [sid]: id }));
  }, [liveChat]);
  const changeChatEffortFor = useCallback((sid: string, level: string) => {
    if (!level) return;
    liveChat(sid)?.setEffort(level);
    setSessionEffort((prev) => ({ ...prev, [sid]: level }));
  }, [liveChat]);

  // Read each visible pane's agent CURRENT model from its transcript when the layout or
  // roster changes (a mid-session `/model` switch — ours or the user's own — is reflected
  // on the next layout change). Every pane's bar shows its OWN agent's real model. Fresh
  // sessions have no transcript yet, so a picker falls back to the CLI default until a turn.
  useEffect(() => {
    if (!caps?.desktop) return;
    let cancelled = false;
    const readModel = (sid: string, claudeId: string) => {
      void api.get<{ model: string | null }>(`/agent/session-model?claudeId=${encodeURIComponent(claudeId)}`)
        .then((r) => { if (!cancelled && r?.model) setSessionModel((prev) => ({ ...prev, [sid]: r.model as string })); })
        .catch(() => { /* best-effort: keep the fallback */ });
    };
    const activeSids = Array.from(new Set(panes.map((p) => p.active)));
    activeSids.forEach((sid) => {
      const meta = sessionList.find((m) => m.id === sid);
      if (!meta || meta.dormant || !meta.claudeId) return;
      readModel(meta.id, meta.claudeId);
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
  // ── Stable dispatchers for the memoized children (PaneFragment, ChatPaneHost) ──────
  //
  // `bumpStatus` re-renders this whole component on ANY session's busy/asking/status/
  // attention edge — which is to say constantly, for every session in the roster at once.
  // That is what made a token arriving in one chat re-render its split neighbour's whole
  // transcript (owner report 07-25, partially addressed then by keying ChatPane's scroll
  // writes to its own model; this closes the render itself).
  //
  // `React.memo` on those children only helps if the callbacks they receive KEEP THEIR
  // IDENTITY across such a render, and per-pane inline arrows never can. So each child gets
  // ONE object whose identity never changes, whose methods take their target as an argument,
  // and which reads this render's real closures through a ref the effect below keeps fresh.
  // Actions are only ever invoked from event handlers — which run long after the effect that
  // published them — so the ref can never be read stale.
  const paneActionsImpl: PaneActions = {
    setZoneTarget,
    activate: (paneId) => { if (paneId !== activePaneId) setActivePaneId(paneId); },
    resume: (sid) => resumeSession(sid),
    close: (sid) => closeSessionById(sid),
  };
  const paneActionsRef = useRef(paneActionsImpl);
  useEffect(() => { paneActionsRef.current = paneActionsImpl; });
  const paneActions = useMemo<PaneActions>(() => ({
    setZoneTarget: (paneId, zone) => paneActionsRef.current.setZoneTarget(paneId, zone),
    activate: (paneId) => paneActionsRef.current.activate(paneId),
    resume: (sid) => paneActionsRef.current.resume(sid),
    close: (sid) => paneActionsRef.current.close(sid),
  }), []);

  const chatActionsImpl: ChatSurfaceActions = {
    changeModel: changeChatModelFor,
    changeEffort: changeChatEffortFor,
    continueInTerminal: resumeChatInTerminal,
    resumeChat: resumeChatSession,
    changePermissionMode: changeChatPermissionMode,
    changeMode: changeChatMode,
    handoffToDevelop,
    openAppPage: onOpenAppPage,
    signIn: signInToClaude,
  };
  const chatActionsRef = useRef(chatActionsImpl);
  useEffect(() => { chatActionsRef.current = chatActionsImpl; });
  const chatActions = useMemo<ChatSurfaceActions>(() => ({
    changeModel: (sid, id) => chatActionsRef.current.changeModel(sid, id),
    changeEffort: (sid, level) => chatActionsRef.current.changeEffort(sid, level),
    continueInTerminal: (cs) => chatActionsRef.current.continueInTerminal(cs),
    resumeChat: (cs) => chatActionsRef.current.resumeChat(cs),
    changePermissionMode: (mode) => chatActionsRef.current.changePermissionMode(mode),
    changeMode: (sid, mode) => chatActionsRef.current.changeMode(sid, mode),
    handoffToDevelop: (cs, taskSlug) => chatActionsRef.current.handoffToDevelop(cs, taskSlug),
    openAppPage: (page, id) => chatActionsRef.current.openAppPage(page, id),
    signIn: () => chatActionsRef.current.signIn(),
  }), []);

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

  // Settings → Agents' "auto-name tabs" preference, flipped from a tab's own right-click
  // menu — the setting is edited where its effect shows up, not only three panels away.
  //
  // PATCHED, never written as a whole object: `agentSettings` here may still be the
  // pre-hydrate localStorage seed (or plain defaults, before the server file resolves), and
  // spreading it back would rewrite every OTHER preference from that stale snapshot — the
  // exact failure `patchAgentSettings` exists to prevent. The write dispatches
  // AGENT_SETTINGS_EVENT, so the new value arrives back through the listener above and the
  // menu's switch re-renders from state rather than from a local copy.
  const toggleAutoTitle = useCallback((on: boolean) => { patchAgentSettings({ autoTitle: on }); }, []);

  // ── Place each pane's active session container into its slot ─────────────────────
  // The single source of layout truth: append every pane's ACTIVE session container into
  // that pane's slot (matched by `data-pane`), and park every other session in the hidden
  // garage. Raw-DOM moves, never a remount — a session moved between panes just lands in a
  // different slot. Runs on any layout (panes) or visibility (expanded) change.
  useLayoutEffect(() => {
    // A session has a home when it is some pane's active tab — homed in the overlay's
    // `.agent-pane-slot[data-pane]`. Everything else lives in the garage.
    const homed = new Set(panes.map((p) => p.active));

    // HOMED and FOREGROUND are different questions, and conflating them regresses the
    // persistence invariant. A collapsed overlay's panes are still homed (their slots merely go
    // `display:none`) — garaging them on collapse would thrash the DOM on every expand. But
    // they are NOT foreground, so a session finishing while collapsed still earns its dock
    // attention badge.
    const foreground = new Set(expanded ? homed : []);
    sessions.current.forEach((s) => { s.minimized = !foreground.has(s.id); });

    const slots = new Map<string, HTMLElement>();
    hostRef.current?.querySelectorAll<HTMLElement>('.agent-pane-slot[data-pane]')
      .forEach((el) => { if (el.dataset.pane) slots.set(el.dataset.pane, el); });

    panes.forEach((pane) => {
      const s = sessions.current.get(pane.active);
      const slot = slots.get(pane.id);
      if (s && slot && s.container.parentElement !== slot) { slot.appendChild(s.container); s.ensureOpen({ focus: isActive }); }
    });
    sessions.current.forEach((s) => {
      if (!homed.has(s.id) && garageRef.current && s.container.parentElement !== garageRef.current) {
        garageRef.current.appendChild(s.container);
      }
    });
    // A freshly-shown container only has offsetParent after display, so open/fit next
    // frame. Refits everything ON SCREEN (a split/combine changes every pane's width).
    const raf = requestAnimationFrame(() => {
      foreground.forEach((id) => { const s = sessions.current.get(id); if (s) { s.ensureOpen({ focus: isActive }); s.fitAndResize(); } });
    });
    return () => cancelAnimationFrame(raf);
    // `isActive` is deliberately NOT a dependency: React runs the effect belonging to the
    // render whose deps changed, so the flag read here is always the current one, and
    // re-running the whole placement pass on every chip switch would thrash the DOM for a
    // set of appendChild calls that are all no-ops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // "Visible" now means visible in TWO senses: the overlay is expanded AND this project is
    // the chip on screen. Fitting a hidden instance measures a `display:none` subtree, where
    // `getComputedStyle().height` is the computed `auto` rather than a used pixel value — the
    // FitAddon's NaN guard makes that a no-op today, but "no-op by luck" is not a contract to
    // hand a live PTY (one explicit height on `.agent-pane-term` and it becomes a 2×1 resize).
    // No-op when `isActive` is true, so a single-project window behaves exactly as before.
    if (!isActive) return;
    panes.forEach((p) => { const s = sessions.current.get(p.active); if (s) { s.ensureOpen({ focus: isActive }); s.fitAndResize(); } });
  }, [panes, isActive]);

  useEffect(() => {
    if (!expanded) return;
    const raf = requestAnimationFrame(() => fitVisible());
    return () => cancelAnimationFrame(raf);
  }, [expanded, fitVisible]);

  // ── On ACTIVATION this project's whole subtree goes from hidden (offsetParent null) to
  //    visible, so re-drive open+fit next frame. ──
  // Nothing else fires on "my instance became visible": the placement effect is keyed on
  // [panes, expanded], the effect above on [expanded], and the ResizeObserver below only
  // exists while expanded AND is 150ms-debounced. Without this, a terminal spawned while its
  // project was a background chip never opens (`ensureOpen` bails on a null `offsetParent`)
  // and, because `fitAndResize` no-ops while `!session.opened`, its PTY keeps the server's
  // default grid — the TUI comes back clipped at the wrong width.
  //
  // The rAF is load-bearing: a freshly-shown container only has a non-null `offsetParent`
  // after the browser has laid it out, so measuring in the same commit measures nothing.
  useEffect(() => {
    if (!isActive) return;
    const raf = requestAnimationFrame(() => fitVisible());
    return () => cancelAnimationFrame(raf);
  }, [isActive, fitVisible]);

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
  //
  // Gated on `isActive` as well as `expanded`: a background project's slots keep changing
  // size (the sidebar hoist, a window resize) while nobody is looking at them, and an
  // observer left armed there wakes a debounce timer per frame to fit a hidden grid. The
  // activation effect above re-fits on the way back in, so nothing is lost by not watching.
  useEffect(() => {
    if (!expanded || !isActive) return;
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; fitVisible(); }, 150);
    });
    ro.observe(host);
    // The pane SLOTS must be observed too: a live strip (goal/council panel) mounting
    // above the composer shrinks the slot with NO host resize, and without a refit the
    // xterm keeps its stale row grid — the TUI's bottom rows slide under the strip.
    // Slots are re-queried per effect run; `fitVisible`'s deps include `panes`, so a
    // pane add/remove re-arms the observer over the current slot set.
    host.querySelectorAll<HTMLElement>('.agent-pane-slot[data-pane]').forEach((el) => ro.observe(el));
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [expanded, isActive, fitVisible]);

  // ── Esc collapses the overlay — but ONLY when focus is outside the terminal, so it
  //    never steals Esc from Claude's TUI (which uses Esc to cancel). It also yields to
  //    the ⌘K palette opened on top.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.agent-new-menu')) return;  // the "＋ New" menu owns Esc
      // A tab's right-click menu owns Esc too. Tested by presence rather than by focus: it
      // portals to <body> and never takes focus, so the `activeElement` checks below (which
      // is still the terminal that was focused when the menu opened) would all miss it —
      // and this listener is on `window`, so it runs BEFORE the menu's own document-level
      // one and would otherwise collapse the whole surface out from under it.
      if (document.querySelector('.agent-tab-menu')) return;
      const ae = document.activeElement as Element | null;
      if (ae?.closest('.agent-pane-slot')) return;   // Claude's TUI owns Esc
      // Any centered command surface on top of us owns Esc — ⌘K palette, ⌘P switcher,
      // ⌘⇧O past-chats picker. Matched on the shared <CommandModal> shell class rather
      // than each variant, so a future one is covered without editing this list.
      if (ae?.closest('.cmd-modal')) return;
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
  // Fires on BOTH busy edges of a live AGENT or CHAT session — the chat engine is a
  // different transport (headless stream-json, not a PTY) but the SAME identity: it
  // spawns under `DREAMCONTEXT_TAB_SESSION` too, so its UserPromptSubmit hook records the
  // first prompt into the very same session-map entry `/agent/title` reads. Nothing about
  // the route is terminal-specific, so gating this on `kind === 'agent'` was the only
  // reason chat tabs sat at "Chat N" forever. The idle→busy edge (turn START) is
  // the fast path: a chat tab sends its own copy of the first message with the request
  // (see below), and for terminal tabs the UserPromptSubmit hook has usually already
  // captured the first prompt into the tab's session-map entry — so the server can title
  // the tab seconds after the user types, no waiting for the whole first turn to finish.
  // The busy→idle edge (turn COMPLETE) is the safety net for tabs the hook missed (the
  // transcript exists by then).
  // The title is applied ONLY if the tab still carries its default "Agent N"/"Chat N"
  // name (a tab you renamed is never overwritten). It settles to at most ONE successful
  // Haiku call per tab, but a call that finds nothing yet (an unwritten hook entry or an
  // unflushed transcript) leaves the tab RETRYABLE — so the tab you worked on gets named on
  // its next edge, instead of permanently losing its title to a slower tab's late rename.
  useEffect(() => {
    if (!agentSettings.enabled || !agentSettings.autoTitle) return;
    sessions.current.forEach((s, id) => {
      const wasBusy = busyPrevRef.current.get(id) ?? false;
      busyPrevRef.current.set(id, s.busy);
      if (wasBusy === s.busy) return;             // fire on every busy edge (start + complete)…
      // …but skip if already named, ineligible, or a request is already outstanding.
      if (s.kind === 'shell' || autoTitledRef.current.has(id) || titleInFlightRef.current.has(id)) return;
      const meta = sessionList.find((m) => m.id === id);
      // Permanently ineligible if the tab was renamed by the user or is a dormant restore.
      if (!meta || meta.dormant || !DEFAULT_TAB_TITLE_RE.test(meta.title)) {
        autoTitledRef.current.add(id);
        return;
      }
      // Retry budget spent → keep the default name for good (see titleAttemptsRef).
      const attempts = titleAttemptsRef.current.get(id) ?? 0;
      if (attempts >= 8) { autoTitledRef.current.add(id); return; }
      titleAttemptsRef.current.set(id, attempts + 1);
      titleInFlightRef.current.add(id);           // one outstanding call at a time
      // A chat session already HOLDS its first user message (its composer sent it, or the
      // server echoed a spawn prompt into the model) — pass it along so the idle→busy edge
      // titles on the FIRST attempt even before the hook entry / flushed transcript exists
      // on disk. The server still prefers those on-disk sources; this is its last resort.
      // Terminal tabs have no client-side copy (the PTY stream is raw bytes) and omit it.
      const firstUserText = s.kind === 'chat'
        ? (s as ChatSession).getModel().items.find((it): it is ChatUserItem => it.kind === 'user')?.text.trim()
        : undefined;
      void scopedApi.post<{ title: string | null; reason?: string }>(
        '/agent/title',
        firstUserText ? { claudeId: s.claudeId, message: firstUserText } : { claudeId: s.claudeId },
      )
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
            m.id === id && DEFAULT_TAB_TITLE_RE.test(m.title) ? { ...m, title } : m
          )));
        })
        .catch(() => { /* best-effort: a failed title just leaves the default name */ })
        .finally(() => { titleInFlightRef.current.delete(id); });
    });
  }, [statusTick, agentSettings.enabled, agentSettings.autoTitle, sessionList, scopedApi]);

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
  //
  // This instance's Shell only (it emits on the same bus): navigating in the foreground
  // project must not collapse a backgrounded project's overlay out from under it, so that
  // switching back lands on the agent you left open rather than on its page.
  useInstanceEvent('dreamcontext-navigate', () => setExpanded((cur) => (cur ? false : cur)));

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
  // Stays on `window` ON PURPOSE, unlike the bridges above: zoom is a property of the WINDOW,
  // the control lives in the window chrome above every instance, and every xterm in it —
  // foreground and background alike — must end up at the same size. A backgrounded project
  // that missed a zoom step would repaint at the wrong font the moment you switched to it.
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
      // ⌘⇧O → Past chats. Deliberately ABOVE the composer guard: reaching for an earlier
      // conversation mid-draft is exactly when you want it, and unlike ⌘W it destroys
      // nothing (the draft is still there when the picker closes).
      if (e.metaKey && !e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault(); e.stopPropagation(); setHistoryOpen(true); return;
      }
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
      // ⌘D → new CLAUDE split in the chosen Agent screen (terminal agent or chat) ·
      // ⌘⇧D → new TERMINAL split (same side-by-side action, shell kind).
      if (k === 'd') { e.preventDefault(); e.stopPropagation(); addSplitSession(e.shiftKey ? 'shell' : claudeKind); }
      else if (k === 't') { e.preventDefault(); e.stopPropagation(); addSession(claudeKind); }
      else if (k === 'w') {
        e.preventDefault(); e.stopPropagation();
        if (focusedSessionId) closeSessionById(focusedSessionId);
      }
    };
    host.addEventListener('keydown', onKey, true);
    return () => host.removeEventListener('keydown', onKey, true);
  }, [started, addSession, addSplitSession, closeSessionById, focusedSessionId, claudeKind]);

  const openExternal = async () => {
    try { await scopedApi.post('/agent/open-terminal', { bypass }); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not open Terminal.'); }
  };

  // ── File drag-drop → live Claude session ─────────────────────────────────────
  // An HTML5 file drop hands us a File whose BYTES are readable even though WKWebView
  // hides the OS path. Read the bytes → POST to the loopback server (writes a real file
  // under the vault temp dir) → inject that absolute path into the target PTY so Claude
  // can read the file (image, code, text, PDF, …). Binary can't go through `api.post`
  // (JSON-only), so use raw fetch.
  const deliverDrops = useCallback(async (files: File[], sid: string) => {
    for (const file of files) {
      const path = await uploadAgentFile(vault, file, file.name);
      // Inject the path AND land keyboard focus on this session — a drop is async
      // (read bytes → POST), so the user may start typing before it resolves; grabbing
      // focus here guarantees the follow-up prompt goes to the session that got the file.
      const s = sessions.current.get(sid);
      if (path && s) { s.sendText(quoteIfNeeded(path) + ' '); s.focus(); }
    }
  }, [vault]);

  // NATIVE DOM listeners on the always-mounted surface host — NOT React onDragOver/onDrop
  // props on `.agent-term`. A chat pane's DOM is React-portaled into its detached session
  // container (homed into the pane slot by raw appendChild), so its events bubble through
  // the PORTAL's React tree — rendered OUTSIDE the overlay body — and a React drop handler
  // on `.agent-term` never fires for them (this is exactly why file drops worked on
  // terminal panes, whose xterm DOM is React-foreign and resolves to the pane slot's
  // fiber, but silently did nothing on chat panes). Real DOM bubbling sees both.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onOver = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    // `files.length === 0` is the collision guard: internal tab DnD (and board Kanban/
    // Eisenhower DnD) carry no OS files, so we leave those drops untouched. A dropped file
    // goes to the pane UNDER THE CURSOR (not the last-focused one), resolved from the pane
    // slot's `data-pane` at the drop point; any file type is accepted.
    const onDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      // Matches the body-render gate below — a chat pane also has a live session that can
      // receive an injected file path, but only when the chat screen is actually chosen
      // (claudeCli alone must never widen this while chatView is off).
      if (!(started && (caps?.embeddedTerminal || (caps?.claudeCli && agentSettings.chatView)))) return;
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
    el.addEventListener('dragover', onOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragover', onOver);
      el.removeEventListener('drop', onDrop);
    };
  }, [started, caps, agentSettings.chatView, panes, focusedSessionId, activePaneId, focusTerm, deliverDrops]);

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
      claudeId: s?.claudeId,
    };
  });
  /*
   * ── This project's chip, published to the window chrome ──────────────────────────
   *
   * The dock already knows everything a chip needs — how many conversations are alive, the
   * worst state among them, whether any is blocked on an answer — and it knows it for a
   * project the user may not be looking at. `rollupProject` reduces those rows to the three
   * scalars the strip draws from.
   *
   * NOT PUBLISHED PER RENDER. `dockRows` is rebuilt every render, and this surface re-renders
   * on every status flip the PTY produces — several a second while a turn is streaming. The
   * dependency array below IS the shallow compare: four primitives, so the effect runs only
   * when one of them genuinely changed, and a chip that has nothing new to say never reaches
   * the chrome at all. (The chrome bails out a second time on the same four fields; both ends
   * matter, because this one keeps the event off the bus and that one keeps the re-render out
   * of every other chip.)
   *
   * `alive` rides along even though nothing here renders it — it's the ceiling's eviction
   * signal (a live shell with no chat still has `live: 0`, and reading THAT as idle is what
   * killed a running PTY before T18 split the two apart). Dropping it from the dependency
   * array would let a shell open or close without the chrome ever hearing about it, because
   * `worst`/`live`/`waiting` can all sit unchanged while `alive` moves — the exact staleness
   * the ceiling rule cannot tolerate.
   */
  const rollup: ProjectRollup = rollupProject(dockRows);
  const {
    worst: rollupWorst, live: rollupLive, waiting: rollupWaiting, alive: rollupAlive,
    asking: rollupAsking, working: rollupWorking, idle: rollupIdle, flagged: rollupFlagged,
  } = rollup;
  useEffect(() => {
    emitInstance<ProjectRollup>(bus, PROJECT_ROLLUP_EVENT, {
      worst: rollupWorst, live: rollupLive, waiting: rollupWaiting, alive: rollupAlive,
      asking: rollupAsking, working: rollupWorking, idle: rollupIdle, flagged: rollupFlagged,
    });
  }, [
    bus, rollupWorst, rollupLive, rollupWaiting, rollupAlive,
    // The three bubble counts are in the array for the same reason `alive` is: they can move
    // while every other field holds still. One chat finishing its turn as another starts one
    // leaves worst/live/waiting/alive all unchanged and only shifts a count from `working` to
    // `idle` and back — a chip whose bubbles never updated would be the visible symptom.
    rollupAsking, rollupWorking, rollupIdle,
    // `flagged` moves on its own too — focusing a session clears its attention flag without
    // touching its live status, so every other field here can sit still while the chip's dot
    // needs to go out.
    rollupFlagged,
  ]);

  // Rows for the corner dock that floats over the EXPANDED overlay — only the sessions the
  // user minimized out of the panes (in minimize order). Empty → no corner dock shown.
  const minimizedRows: SessionRow[] = minimizedIds
    .map((id) => dockRows.find((r) => r.id === id))
    .filter((r): r is SessionRow => !!r);

  // Every LIVE chat session — portaled into its own detached container below,
  // unconditionally (not gated on
  // minimized/expanded): the container itself is homed/garaged by the layout effect exactly
  // like a terminal's xterm container, so ChatPane never unmounts while its session lives
  // (see ChatPane.tsx's composer-draft note for why that matters).
  const chatPanes: ChatSession[] = sessionList
    .filter((m) => transportKind(m) === 'chat' && !m.dormant)
    .map((m) => sessions.current.get(m.id))
    .filter((s): s is ChatSession => !!s && s.kind === 'chat');

  // ── Body ──────────────────────────────────────────────────────────────────────
  // The panes (and therefore the header's tab strip) are live only in this exact state —
  // one const so the header and the body branch below can never disagree about it.
  const panesLive = !capsError && !!caps && caps.desktop && started
    && (caps.embeddedTerminal || (caps.claudeCli && agentSettings.chatView));
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
  } else if (panesLive) {
    // Chat needs only the claude CLI — this pane body must render even on a node-pty-broken
    // machine (agent-terminal.ts:37-40's real failure mode), or a spawned chat session would
    // have nowhere to portal into. Gated on chatView too: claudeCli alone must never widen
    // this for someone on Terminal (legacy) (a terminal-only user on a pty-broken machine
    // must still get the Prereqs recovery panel below, not a rendered tabs/panes UI with no
    // working session behind it).
    body = (
      <div className="agent-term">
        {/* The account changed under the running sessions. Chats have already dealt with it
            (or are waiting out a turn); this says so, because an unexplained reconnect reads
            as a glitch — and it is the ONLY thing a terminal agent gets, since respawning a
            live TUI would throw away its screen. */}
        {authNotice && (
          <AuthChangedStrip
            notice={authNotice}
            liveChats={chatPanes.length}
            liveTerminals={sessionList.filter((m) => m.kind === 'agent' && !m.dormant).length}
            onDismiss={() => setAuthNotice(null)}
          />
        )}
        {/* Drop a PNG/JPG/GIF/WebP anywhere on a terminal OR chat pane to hand that
            session the file — its path is written to the vault temp dir and injected
            (readline for a terminal, composer draft for a chat). The listeners live on
            the surface HOST as native DOM handlers — see the drag-drop effect above. */}
        <div className={'agent-panes' + (panes.length > 1 ? ' split' : '')}>
          {panes.length === 0 && (
            <div className="agent-allmin-hint">
              <p className="agent-allmin-title">All agents minimized</p>
              <p className="agent-allmin-sub">Click a chip in the bottom-right corner to bring one back, or start a new one with ＋ New agent.</p>
            </div>
          )}
          {panes.map((pane) => {
            const activeMeta = metaById.get(pane.active);
            const isActive = pane.id === activePane?.id;
            return (
              <PaneFragment
                key={pane.id}
                paneId={pane.id}
                activeSessionId={pane.active}
                actions={paneActions}
                active={isActive}
                dormant={activeMeta?.dormant}
                dragging={draggingTab}
                composer={!activeMeta?.dormant && transportKind(activeMeta) !== 'chat' && (
                  <PaneComposer
                    claudeId={activeMeta?.claudeId}
                    isAgent={transportKind(activeMeta) === 'agent'}
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
          {chatMode ? (
            <>
              A full Claude Code session running right here, scoped to this project, rendered as a
              <strong> native conversation</strong> — boards, media and diffs appear inline, and its
              questions become buttons you click. Or a <strong>plain terminal</strong> in the same
              window when you just need a shell.
            </>
          ) : (
            <>
              A full interactive Claude Code session running right here, scoped to this project —
              or a <strong>plain terminal</strong> in the same window when you just need a shell.
            </>
          )}
          {' '}Open as many as you need — each gets its own <strong>renameable</strong> tab, and you
          can put them <strong>side by side</strong> (⌘D) to watch several at once.
        </p>
        <BypassToggle bypass={bypass} setBypass={setBypass} />
        {(() => {
          // The AGENT needs BOTH its renderer (node-pty) AND the `claude` binary it spawns.
          // A plain TERMINAL needs only the renderer — no `claude` — so it can start even
          // when the CLI is missing. Missing the renderer → show the in-app Setup panel.
          // Chat needs only the claude CLI + the Settings → Agents screen preference — it can
          // start on a node-pty-broken machine where neither of the above can.
          // The Agent screen preference is a SWAP: exactly one Claude start button shows,
          // matching the chosen surface (chatMode folds in the claudeCli requirement).
          const agentReady = caps.embeddedTerminal && caps.claudeCli && !chatMode;
          const terminalReady = caps.embeddedTerminal;
          const chatReady = chatMode;
          return (
            <>
              <div style={{ display: 'flex', gap: '12px', marginTop: '22px', flexWrap: 'wrap', justifyContent: 'center' }}>
                {agentReady && (
                  <button onClick={() => addSession('agent')} style={primaryBtn}>▸ Start agent in app</button>
                )}
                {chatReady && (
                  <button onClick={() => addSession('chat')} style={primaryBtn}>◆ Start chat</button>
                )}
                {terminalReady && (
                  <button onClick={() => addSession('shell')} style={(agentReady || chatReady) ? secondaryBtn : primaryBtn}>&gt;_ Start terminal</button>
                )}
                {caps.openTerminal && (
                  <button onClick={openExternal} style={secondaryBtn}>↗ Open in Terminal</button>
                )}
                {/* Past chats belongs HERE too, not only in the header: `started` is
                    `sessionList.length > 0`, so a launch with no restored tabs shows this
                    screen and the header's ◷ button does not exist yet — which is exactly
                    the moment "reopen what I was working on" is the thing you want. Gated
                    on the CLI alone: resuming spawns `claude --resume`, no node-pty. */}
                {caps.claudeCli && (
                  <button onClick={() => setHistoryOpen(true)} style={secondaryBtn}>◷ Past chats</button>
                )}
              </div>
              {!terminalReady && (
                <>
                  {/* Coexistence: on a node-pty-broken machine with Chat ready, don't let the
                      terminal's install panel read as "the whole surface is unavailable" —
                      chat is already usable above; the terminal needs one more piece. */}
                  {chatReady && (
                    <p style={{ ...subStyle, marginTop: '18px', color: 'var(--color-text-tertiary)' }}>
                      Chat is ready to use above. The embedded terminal needs one more piece:
                    </p>
                  )}
                  <Prereqs caps={caps} onRefresh={refreshCaps} />
                </>
              )}
            </>
          );
        })()}
      </Centered>
    );
  }

  return (
    <>
      {/* D7 — runs that stopped to ask, or crashed, open as tabs by themselves.
          Renders nothing; it polls and calls the same `openAutomationRunChat`
          the Automations panel does, so a run reaching a tab this way and one
          reached by a click are the SAME tab (its bring-forward guard is what
          makes that true). `ready` mirrors that callback's own guards so the
          poll cannot exist on a build where nothing could come of it.

          `hydrated` IS PART OF THAT GATE, and it is not defensive tidiness. This opener
          reads a localStorage settings seed available on the first render and needs one
          round-trip; the roster restore waits on the SERVER settings and then its own
          fetch, so it needs two. Unguarded, this tab lands before the saved roster often
          — not always, which is worse, because it made the resulting data loss look
          random. Nothing may put a tab on screen before the roster it has to coexist with
          has been read. The restore above now merges rather than bails, so this gate is
          the belt and that is the braces; keep both, and see
          `scripts/verify/automation-tab-restore.mjs`, which forces the losing order. */}
      <AutomationAttentionOpener
        ready={!!(caps?.desktop && caps.claudeCli && claudeReady && agentSettings.enabled && hydrated)}
        onOpen={openAutomationRunChat}
      />
      <div
        ref={hostRef}
        className={`agent-surface${expanded ? ' expanded' : closing ? ' closing' : ''}`}
        onAnimationEnd={(e) => { if (e.target === e.currentTarget && closing) setClosing(false); }}
        /* The minimized-sessions dock floats over our bottom-right corner — flag it so the
           corner pane's composer can clear its anchor chip (model/effort stay visible). */
        data-dock-floating={caps?.desktop && expanded && minimizedRows.length > 0 ? 'true' : undefined}
      >
        {/* Overlay chrome — ONE row: collapse, the session TABS themselves (one group per
            pane; the header IS the tab strip, so there's no separate title row and no
            second 38px bar), and the "New" split action. */}
        <div className="agent-overlay-head">
          <button
            className="agent-overlay-collapse"
            title="Collapse (Esc)"
            aria-label="Collapse agent"
            onClick={() => setExpanded(false)}
          >–</button>
          <div className="agent-overlay-tabs" data-split={paneVMs.length > 1 ? 'true' : undefined}>
            {panesLive && paneVMs.map((paneVM) => (
              <AgentTabs
                key={paneVM.id}
                pane={paneVM}
                isActivePane={paneVM.id === activePane?.id}
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
                chatConvertEnabled={!!agentSettings.chatView && !!caps?.claudeCli}
                onOpenInChat={openAgentInChat}
                autoTitle={agentSettings.autoTitle}
                onToggleAutoTitle={toggleAutoTitle}
              />
            ))}
          </div>
          <div className="agent-overlay-controls">
            {/* Chat needs only the claude CLI (+ the Settings → Agents screen preference),
                not node-pty — loosened so the control cluster is reachable on a
                node-pty-broken machine that can still run Chat. */}
            {started && (caps?.embeddedTerminal || (caps?.claudeCli && agentSettings.chatView)) && (
              <>
                {/* Split button: the main face opens a Claude session in the CHOSEN Agent
                    screen (Settings → Agents — terminal agent or chat, never both offered);
                    the caret opens a menu with that one Claude kind + the plain shell.
                    ⌘T / ⌃` shortcut them. */}
                <div className="agent-new-split" ref={newSplitRef}>
                  <button
                    className="agent-add-btn"
                    title={chatMode ? 'New chat (⌘T) · side-by-side: ⌘D chat, ⌘⇧D terminal' : 'New agent (⌘T) · side-by-side: ⌘D agent, ⌘⇧D terminal'}
                    aria-label={chatMode ? 'New chat' : 'New agent'}
                    onClick={() => { setNewMenuOpen(false); addSession(claudeKind); }}
                  >
                    <span className="agent-add-btn-icon" aria-hidden>＋</span>
                    <span>New</span>
                  </button>
                  <button
                    className="agent-add-caret"
                    title="Choose a session type"
                    aria-label="Choose new session type"
                    aria-haspopup="menu"
                    aria-expanded={newMenuOpen}
                    onClick={() => setNewMenuOpen((v) => !v)}
                  >▾</button>
                  {newMenuOpen && (
                    <div className="agent-new-menu" role="menu">
                      {!chatMode && caps?.embeddedTerminal && (
                        <button
                          className="agent-new-menu-item"
                          role="menuitem"
                          onClick={() => { setNewMenuOpen(false); addSession('agent'); }}
                        >
                          <span className="agent-new-menu-glyph" aria-hidden>◇</span>
                          <span className="agent-new-menu-label">New agent</span>
                          <kbd className="agent-new-menu-kbd">⌘T</kbd>
                        </button>
                      )}
                      {chatMode && (
                        <button
                          className="agent-new-menu-item"
                          role="menuitem"
                          onClick={() => { setNewMenuOpen(false); addSession('chat'); }}
                        >
                          <span className="agent-new-menu-glyph" aria-hidden>◆</span>
                          <span className="agent-new-menu-label">New chat</span>
                          <kbd className="agent-new-menu-kbd">⌘T</kbd>
                        </button>
                      )}
                      {caps?.embeddedTerminal && (
                        <button
                          className="agent-new-menu-item"
                          role="menuitem"
                          onClick={() => { setNewMenuOpen(false); addSession('shell'); }}
                        >
                          <span className="agent-new-menu-glyph" aria-hidden>&gt;_</span>
                          <span className="agent-new-menu-label">New terminal</span>
                          <kbd className="agent-new-menu-kbd">⌃`</kbd>
                        </button>
                      )}
                      {/* Past chats lives in THIS menu rather than as its own header button:
                          the header is a tab strip, and a second pill beside ＋ New competes
                          with it for the one action that should read as primary. Separated
                          by a rule because it is the odd one out — everything above starts
                          something new, this one goes back to something that already exists. */}
                      <div className="agent-new-menu-rule" role="separator" />
                      <button
                        className="agent-new-menu-item"
                        role="menuitem"
                        onClick={() => { setNewMenuOpen(false); setHistoryOpen(true); }}
                      >
                        <span className="agent-new-menu-glyph" aria-hidden>◷</span>
                        <span className="agent-new-menu-label">Past chats</span>
                        <kbd className="agent-new-menu-kbd">⌘⇧O</kbd>
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
      {/* Past chats picker. A SIBLING of `.agent-surface`, never a child: the surface
          declares `contain: layout paint`, which would make it the containing block for the
          modal's `position: fixed` scrim and trap the popup inside the pane area (the same
          trap `AgentDock` documents). Mounted only while open — its fetch is scoped to that. */}
      {historyOpen && (
        <ChatHistoryPicker
          open
          onClose={() => setHistoryOpen(false)}
          onPick={resumePastSession}
          openIds={sessionList.map((m) => m.claudeId).filter(Boolean)}
        />
      )}
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
      {/* Chat (BETA) panes — portaled into each live chat session's own detached container
          (see chatPanes above). Model/effort here don't live-switch (chat has no
          `/model`/`/effort` slash path — chatChangeModelFor/EffortFor just update the picker
          state for the NEXT resume; see the plan's scope call C). */}
      {chatPanes.map((cs) => createPortal(
        <ChatPaneHost
          key={cs.id}
          session={cs}
          // ONE stable object instead of six per-session arrows — the memo boundary in
          // ChatPaneHost is what keeps a token in one conversation from re-rendering
          // another one's transcript. See the dispatcher's definition above.
          actions={chatActions}
          modelConfig={modelConfig}
          // `||`, not `??`: a chat session's `model`/`effort` start as EMPTY STRINGS (they
          // are only filled once `system:init` reports what the CLI actually picked), and
          // `??` lets '' through — which is what left the composer's pill reading "—".
          model={sessionModel[cs.id] || cs.model || modelConfig.defaultModel}
          effort={sessionEffort[cs.id] || cs.effort || modelConfig.defaultEffort}
          // Provenance for a conversation this app did not have: set only for a tab opened
          // from an automation's run history. Keyed by conversation uuid so it survives the
          // tab-id swap every resume path performs. Undefined for every ordinary chat, which
          // is what keeps the header absent from all of them.
          automation={automationRuns[cs.claudeId]}
          // Read off the SESSION, not the roster: a mode is fixed when the process starts, so
          // the live object is the only thing that can't be a beat ahead of what the agent was
          // actually briefed with. `changeChatMode` respawns, which replaces this object.
          mode={cs.mode}
          permissionMode={chatPermissionMode}
          canSignInInApp={canSignInInApp}
          signInCommand={signInCommand}
        />,
        cs.container,
        `chat-${cs.id}`,
      ))}
    </>
  );
}

/**
 * "You are on a different Claude account now" — the surface-wide strip.
 *
 * ONE strip, not one per pane, because the event is ONE machine-wide act: the user ran
 * `claude auth login`. N panes announcing the same sign-in would read as N things having
 * gone wrong.
 *
 * It exists to make the automatic restart legible. A chat pane blanking and reconnecting on
 * its own is indistinguishable from a crash, and a user who reads it as a crash learns to
 * distrust the surface — so the restart is stated in the same breath as the account that
 * caused it. The terminal clause is the honest other half: those sessions were NOT fixed,
 * and saying nothing would leave them quietly running as the previous account.
 */
function AuthChangedStrip({ notice, liveChats, liveTerminals, onDismiss }: {
  notice: { identity: string; loggedIn: boolean | null; restarted: number };
  liveChats: number;
  liveTerminals: number;
  onDismiss: () => void;
}) {
  const who = notice.identity || 'a different account';
  const signedOut = notice.loggedIn === false;
  // Signed OUT is deliberately not a restart: a session respawned with no credentials fails
  // its first turn, while the one already running may still hold a valid token and be doing
  // real work. See claude-auth-watch.ts's `isRestartable`.
  const headline = signedOut ? 'Signed out of Claude' : `Claude account changed — now ${who}`;
  const chatClause = signedOut
    ? 'Open sessions keep the sign-in they started with until it expires.'
    : notice.restarted > 0
      ? `${notice.restarted} open ${notice.restarted === 1 ? 'chat' : 'chats'} restarted on it — conversations intact.`
      : liveChats > 0
        ? 'Open chats restart on it as soon as they finish what they are doing.'
        : '';
  const terminalClause = !signedOut && liveTerminals > 0
    ? ` ${liveTerminals === 1 ? 'Your terminal agent keeps' : `Your ${liveTerminals} terminal agents keep`} the old sign-in until restarted.`
    : '';
  return (
    <div className="agent-auth-strip" role="status">
      <span className="agent-auth-strip-mark" aria-hidden>◈</span>
      <span className="agent-auth-strip-text">
        <strong>{headline}.</strong>{chatClause ? ` ${chatClause}` : ''}{terminalClause}
      </span>
      <button
        type="button"
        className="agent-auth-strip-close"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
      >✕</button>
    </div>
  );
}
