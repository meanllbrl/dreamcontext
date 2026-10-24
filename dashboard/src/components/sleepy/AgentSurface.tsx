import {
  useEffect, useMemo, useRef, useState, useReducer, useCallback, useLayoutEffect,
  type CSSProperties,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import './AgentTerminal.css';
import { api, RequestError } from '../../api/client';
import { useVault, useApi, useInstanceEvent, emitInstance } from '../../context/VaultContext';
import { uploadAgentFile } from '../../lib/agentDrop';
import {
  createSession, currentZoom,
  type Capabilities, type Session, type SessionKind,
} from './agentSession';
import { createChatSession, type ChatSession, type ParkVerdict, type SuperSignal } from './chatSession';
import { publishSuperEventContext, publishSuperQuestions } from './super/superJobsStore';
import { openOwnerQuestions, trimOwnerAnswers } from './super/superQuestions';
import { ChatPaneHost, type ChatSurfaceActions } from './ChatPaneHost';
import {
  initAgentSettingsFromServer, readAgentSettings, patchAgentSettings, matchesAccel,
  doubleTapToken, createDoubleTapMatcher,
  onAgentSettings, type AgentSettings,
  readChatPermissionMode, writeChatPermissionMode,
  CHAT_PERMISSION_MODE_EVENT, type ChatPermissionMode, OPEN_AGENT_SURFACE_EVENT, AGENT_SURFACE_EXPANDED_EVENT,
} from '../../lib/agentSettings';
import { deriveSessionStatus, rollupProject, type ProjectRollup, type SessionRow } from './agentStatus';
import { PaneFragment, type PaneActions } from './PaneFragment';
import { usePaneFocusGlide } from './usePaneFocusGlide';
import { superRestorePlan, type SuperHold } from './superRestore';
import { AgentTabs, type PaneVM } from './AgentTabs';
import { createTabDragStore, type TabDropTarget } from './tabDrag';
import { MobileSessionDrawer } from './MobileSessionDrawer';
import { PhoneChatStack } from './PhoneChatStack';
import { PhoneChatList } from './PhoneChatList';
import type { StackTab } from './phoneStack';
import { useIsMobile } from '../../hooks/useIsMobile';
import { AgentDock } from './AgentDock';
import { AgentFab } from './AgentFab';
import {
  BypassToggle, Centered, BotMark,
  titleStyle, subStyle, primaryBtn, secondaryBtn,
} from './AgentSetup';
import { RUN_SLEEP_AGENT_EVENT, SLEEP_AGENT_TITLE, SLEEP_AGENT_PROMPT } from '../../lib/sleepAgent';
import { RUN_BRAIN_RESOLVE_EVENT, BRAIN_RESOLVE_TITLE, BRAIN_RESOLVE_PROMPT } from '../../lib/brainResolveAgent';
import { DELEGATE_AGENT_EVENT, type DelegateAgentDetail } from '../../lib/delegateAgent';
import { OPEN_SESSION_EVENT, type OpenSessionDetail } from '../../lib/openSession';
import { setFocusedChat } from '../../lib/focusedChat';
import { raiseAskAttention } from '../../lib/attention';
import {
  AUTOMATION_RUN_CHAT_EVENT, automationRunTabTitle,
  type AutomationRunChatDetail, type AutomationRunRef,
  TRAIN_CHAT_EVENT, trainTabTitle, type TrainChatDetail,
} from '../../lib/automationRunChat';
import {
  AUTOMATION_CREATE_CHAT_EVENT, type AutomationCreateChatDetail,
} from '../../lib/automationCreateChat';
import { PaneComposer } from './PaneComposer';
import { quotePath, FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { CHAT_MODE_ROWS, DEFAULT_CHAT_MODE, type ChatMode } from '../../lib/chatModes';
import { bindChatAgent } from '../../lib/chatAgentBinding';
import { TALK_TO_AGENT_EVENT, type TalkToAgentDetail } from '../../lib/talkToAgent';
import { useAgents, findAgent } from '../../hooks/useAgents';
import { preparePrompt, promptFitsInline, developKickoffPrompt, trainKickoffPrompt, initializerKickoffPrompt } from '../../lib/agentPrompt';
import { agentCanSpawn } from '../../lib/agentReady';
import {
  START_CHAT_INTENT_EVENT, START_CHAT_REFUSED_EVENT, type StartChatIntentDetail,
} from '../../lib/startChatIntent';
import { useI18n } from '../../context/I18nContext';
import { ReadinessChecklist } from '../../pages/onboarding/ReadinessChecklist';
import { clearPins } from '../../lib/pinStore';
import { traceRespawn, traceOrphan, clearOrphan, installRespawnTraceGlobal } from '../../lib/respawnTrace';
import { addAttachments, dropScratch, nextAttachmentId, setAbout, settleAttachment, trackUpload } from './chat/composerScratch';
import { dataUrlBlob, pickBlock, pickChipName, type WebPick } from '../../lib/webPick';
import { deliverToChat, postToSession } from './chat/postToSession';
import { parseChatActions } from './chat/chatActions';
import { cleanTabTitle } from '../../lib/chatViewSpec';
import { CLAUDE_SIGNIN_EVENT } from '../../lib/claudeAuth';
import { useAgentModelConfig, useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import { useServerHealth } from '../../hooks/useServerHealth';
import { pickFiles, pickFolders, confirmAction } from '../../lib/desktop';
import { listenForChecklistSubmits, type ChecklistSubmitPayload } from '../../lib/checklistBridge';
import { useAssistantDoorbell } from '../assistant/useAssistantDoorbell';
import { runWindowVerb, type WindowVerbDeps } from './windowVerbs';
import { useChrome } from '../layout/WindowChrome';
import { ChatHistoryPicker, type PastSession } from './ChatHistoryPicker';
import { carriedUnrestored, generationOf, mergeStoredRoster, phoneRestorable, putOutcome, withBaseGeneration } from '../handsfree/rosterRehydrate';
import { PhoneChip } from '../handsfree/phone/PhoneChip';
import { takePendingMacAdopt } from '../handsfree/macAdopt';
import { MAC_MODE_ENDED_EVENT, type LiveChatWire, type LiveChatsWire, type SuperChatWire } from '../handsfree/macContract';
import { isSuperMirrorId, rememberSuperMirrorIds } from './superMirrorIds';
import { isMacPhoneSurface } from '../../lib/phoneSurface';
import { recordPhoneEvent } from '../../lib/phoneConnLog';
import { dropSurveyDraftsFor } from './chat/surveyDrafts';
import { isLightMode } from '../../lib/lightMode';
import { onWindowActivity, useWindowActivity } from '../../lib/windowActivity';
import { readSuperStateView, type SuperStateView } from '../../lib/superTypes';
import { holdSidebarCollapsed } from '../../hooks/useSidebarCollapse';
import type { PendingQuestion } from './chatSession';
import { HandoverButton } from './super/HandoverButton';
import { SuperSurface, prefersReducedMotion, runFlights, type FlightRun } from './super/SuperSurface';
import type { TerminalRowItem } from './super/TerminalsRow';
import {
  actionGeneration, adoptionBody, cardReference, headAlarmOnce, childMarks, DELEGATE_MARK_GRACE_MS, delegateArgs, delegateExpired, delegateMarkUntil, endedChildIds, hasOwnKey,
  homedSessions, isSuperSession, markedChildren, needsOwner, ownerQueueCount, placeDelegatedChild, queueHead, shouldRecap, shownChild, superAnswerPicks, superWindowRefusal, terminalTabs,
  SUPER_CHILD_VERBS, windowTabsFor, type HandoverTab, type SuperCaller, type SuperSendTarget,
  linkOpensSuperStage, presenceChatId, leanMcpFor, agendaAboutBlock, agendaAboutChipName, type AgendaRow,
} from './super/superHandover';
import { isVisibleRect, planFlights, relativeTo, type FlightInput, type FlightRole, type FlightStep, type Rect } from './super/handoverMotion';
import { createActivityLease, disableSuper, enableSuper, fetchSuperState, postSuperActivity, postSuperEnd, postSuperFresh, postSuperLayout, postSuperRecap } from './super/superApi';
import { applyLayoutPatch, withPendingPatches, type LayoutPatch, type StagePlan } from './super/superLayout';

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
 * (`AgentDock`); with zero sessions a lone "Chat" FAB is the entry point.
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
  /** The agent this CHAT tab speaks as (the composer's agent picker, or Talk to it); absent for
   *  plain Claude. Round-tripped through the roster so the agent's tab reopens as that agent. */
  agent?: string;
  /** The current title was set by the tab's own agent (a `title` dream-view block), so the
   *  agent may rename it again when the work moves on. Cleared by a user rename — a name the
   *  user typed is theirs for good. Round-tripped through the roster so it survives a relaunch. */
  titleByAgent?: boolean;
  /** Set while the tab is PARKED (src/server/chat-park.ts): its process was ended under machine
   *  load, the tab is dormant with the label "parked", and Resume reopens the same conversation
   *  in the same kind with the model, effort and account it had. Never persisted: a relaunch
   *  resumes a saved chat anyway. */
  parked?: { at: number; transport: 'chat' | 'agent'; model?: string; effort?: string; account?: string };
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
/** The folded dock's chip for the handed-over Super Agent's own open question (no tab of its own). */
const SUPER_ASK_ROW = 'super-asks';

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

/** A parked tab reads "parked" ("park edildi") instead of "saved": its process was ended under
 *  machine load and Resume brings the same conversation back. */
function withParkedLabel<T extends { label: string }>(info: T, meta: SessionMeta | undefined, t: (k: string) => string): T {
  return meta?.dormant && meta.parked ? { ...info, label: t('agent.tab.parked') } : info;
}

/** A chat's still-running agents keep its tab `working` after the turn ends. Only a chat
 *  pane can see them, so a terminal session never reports any. */
function agentsWorkingOf(s: Session | ChatSession | undefined): boolean {
  return !!s && 'agentsWorking' in s && s.agentsWorking;
}

/** X2's placeholder title suffix, appended IDEMPOTENTLY: the tab this labels gets
 *  persisted back to the roster with the suffix already on it (see the hydrate effect), so
 *  a second launch that finds the SAME session still unbound must not pile up a second copy
 *  of the explanation. */
const NOT_AVAILABLE_SUFFIX = ' — not available on this machine';
function withNotAvailableSuffix(title: string): string {
  return title.endsWith(NOT_AVAILABLE_SUFFIX) ? title : `${title}${NOT_AVAILABLE_SUFFIX}`;
}

/** "Is this tab still carrying the name we gave it?" — half of the auto-title eligibility
 *  gate (the other half is `SessionMeta.titleByAgent`: a name the agent itself set).
 *  Deliberately kind-AGNOSTIC across the two titleable kinds: a tab converted between
 *  terminal and chat (`openAgentInChat` / `resumeChatInTerminal`) keeps the roster title
 *  it had before the swap, so an "Agent 3" that became a chat — or a "Chat 3" that became
 *  a terminal — is still an unnamed tab and must stay eligible. Shells ("Terminal N") are
 *  never auto-titled, so their pattern is intentionally absent. */
const DEFAULT_TAB_TITLE_RE = /^(?:Agent|Chat) \d+$/;

/** How long a roster entry may have no session object before the orphan detector believes
 *  it. Comfortably longer than any respawn's dispose→spawn→remap round trip (all synchronous
 *  bar the state flush), so it never fires on the healthy path, and short enough that a real
 *  orphan is reported while the user still remembers what they just did. */
const ORPHAN_GRACE_MS = 1500;

/**
 * The persisted shape of one roster entry (server `/api/agent/sessions`). Metadata only —
 * never a live PTY — so renamed tabs survive a reload as dormant "Resume" tabs (no
 * auto-spawn of claude on launch). `minimized`/`size` are retained for persistence-format
 * compatibility; `pane`/`active` ARE the layout, and carry it across a relaunch.
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
  /** The agent this chat tab speaks as. Mirrors the server's `SavedMeta.agent`. */
  agent?: string;
  /** 0-based index of the pane this tab sat in, left to right. Absent on legacy rosters →
   *  pane 0, which is exactly the single-pane restore this surface used to do unconditionally. */
  pane?: number;
  /** Was this the visible tab of its pane? A pane with none falls back to its first tab. */
  active?: boolean;
  /** Mirrors `SessionMeta.titleByAgent` — the tab's agent named it and may rename it. */
  titleByAgent?: boolean;
  /** GET-response-ONLY: a super child a relaunch must not resume, and why (superRestore.ts). */
  superHold?: SuperHold;
}

/** The whole `GET /api/agent/sessions` body: the roster plus the two surface-level facts that
 *  live in the same per-vault, machine-local file (`src/server/routes/agent-sessions.ts`). */
interface SavedSurface {
  sessions: SavedMeta[];
  activePane?: number;
  chatPermissionMode?: ChatPermissionMode;
  /** Bumped only by a hands-free Return's merge; every PUT names the one it was based on. */
  generation?: number;
}

/**
 * Is this roster value a mode this build can actually SPAWN under? A hand-edited roster, or
 * one written by a build that has a mode this one doesn't, degrades to Basic rather than
 * travelling onward — the same discipline the server's `coerceMeta` applies on the way in.
 *
 * DISABLED rows are excluded, which is why this filters rather than just testing membership.
 * `CHAT_MODE_ROWS` is the MENU's list, and a row in it may be ANNOUNCED without being
 * spawnable — that is what `disabled` means. Accepting such a row here would let the client
 * hold a mode the spawn cannot honour, and the roster would say one thing while every process
 * ran another. The filter's job is to track a mode's real SPAWNABILITY, not its presence in
 * the menu.
 *
 * No row is disabled today. J.A.R.V.I.S was the one — announced as "Soon" while
 * `sanitizeChatMode` coerced it back to Basic — and this comment used to state that as a
 * standing invariant ("the spawn can never honour it"). The voice work made that false, and
 * jarvis has since been retired outright (voice moved to the Assistant). The MECHANISM is kept because
 * the shape recurs; what changed is that it currently gates nothing.
 */
function knownChatMode(v: unknown): ChatMode | undefined {
  // `super` is no picker row, but a roster entry carrying it must stay `super` — never degrade
  // to a Basic tab — so the Super Agent's session is recognised (and kept out of the panes).
  if (v === 'super') return 'super';
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

/**
 * Carry what was WAITING to be sent onto the session replacing it: first the turns the server
 * held for an account switch (`held` — typed before anything the composer queued behind them),
 * then the outgoing session's own queued rows, paused again if the user had paused them.
 * Enqueued, never sent: the new socket is still connecting, and the queue drains on its open
 * edge (see `armAccountSwitch`'s note on why `send` here lost the message every time). The held
 * turns are the owner's SENT messages, so they ride as `resubmit` rows: out of sight while the
 * new session can send them by itself (`chatQueue.visibleQueued`).
 */
function carryQueueInto(next: ChatSession, held: string[], queued: { texts: string[]; paused: boolean }): void {
  for (const text of held) next.enqueue(text, { resubmit: true });
  for (const text of queued.texts) next.enqueue(text);
  if (queued.paused && queued.texts.length > 0) next.pauseQueue();
}

/** How long a chat link waits for the surface's capabilities, settings and saved roster
 *  before acting on what it has, and how often it looks. */
const LINKED_SESSION_WAIT_MS = 8_000;
const LINKED_SESSION_POLL_MS = 150;
/** The onboarding start intent's wait for caps, settings and roster: the plan's 10 s bound. */
const START_INTENT_WAIT_MS = 10_000;

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
  const { vault, instanceId, isActive, bus } = useVault();
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
  // ── The phone branch ───────────────────────────────────────────────────────────────
  // On a phone the chat IS the app: there is no room for the dashboard shell, and the
  // top tab strip is unusable with a thumb. `isMobile` is narrow-viewport AND coarse-
  // pointer (see useIsMobile) so a narrowed desktop window keeps every desktop
  // affordance.
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The phone stack's swap (AC20): two keyframes taken in turn, so every tap restarts the animation.
  const [swapFlip, setSwapFlip] = useState<0 | 1 | 2>(0);
  // Mac mode's phone opens on the Sohbetler list (AC21); a chat opens over it and ‹ comes back.
  const macPhone = isMobile && isMacPhoneSurface();
  const [phoneView, setPhoneView] = useState<'list' | 'chat'>('list');
  // Two screens, so the move between them says which way it went: a chat comes in from the right,
  // the list comes back from the left. Set in the render that changes the view (React's
  // adjust-state-on-change pattern), so the first frame of the new screen already animates.
  const [phoneNavFrom, setPhoneNavFrom] = useState(phoneView);
  const [phoneNav, setPhoneNav] = useState<'push' | 'pop' | null>(null);
  if (phoneNavFrom !== phoneView) {
    setPhoneNavFrom(phoneView);
    setPhoneNav(phoneView === 'chat' ? 'push' : 'pop');
  }
  // The phone's back gesture leaves a chat for the list, never the app: an entry is pushed while
  // a chat is open and unwound when it closes by any other route (the drawer's rule). The entry
  // carries a marker unique to this visit and only THAT entry is unwound: a reload keeps an old
  // entry's state while the view resets to the list, and unwinding that one too stepped back out
  // of the app. A leftover marker from before a reload is cleared on mount.
  const phoneChatMark = useRef<string | null>(null);
  useEffect(() => {
    if (macPhone && window.history.state?.phoneChat) window.history.replaceState(null, '');
  }, [macPhone]);
  useEffect(() => {
    if (!macPhone || phoneView !== 'chat') return undefined;
    const mark = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    phoneChatMark.current = mark;
    window.history.pushState({ phoneChat: mark }, '');
    const onPop = () => setPhoneView('list');
    window.addEventListener('popstate', onPop);
    // The list that was tapped is gone: put focus on the chat's ‹, its first control.
    document.querySelector<HTMLElement>('[data-testid="chat-back"]')?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('popstate', onPop);
      phoneChatMark.current = null;
      if (window.history.state?.phoneChat === mark) window.history.back();
    };
  }, [macPhone, phoneView]);
  // The escape hatch, and the reason auto-expand cannot simply run on every render: once
  // the user asks for the full dashboard, the surface must STAY collapsed. Without this the
  // effect below would re-expand it on the next tick and the phone could never reach
  // Settings — which is exactly where a missing prerequisite gets fixed.
  const [mobileEscaped, setMobileEscaped] = useState(false);
  const autoExpanded = useRef(false);
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

  // ── A pointer-driven pane switch waits for the click it belongs to ───────────────────
  //
  // The action-focused pane is WIDER (a `flex-basis` bonus, animated over ~240ms). Switching
  // on `mousedown` therefore re-lays out the row while the button is still held down: the
  // element under the cursor slides away, `mouseup` lands on something else, and the browser
  // fires the click on the nearest common ancestor of the two — never on the button that was
  // pressed. So anything clicked in a background pane cost TWO clicks, the first one spent
  // only on widening (owner report 09-13). The press now ARMS the switch and `mouseup`
  // commits it one macrotask later: `click` is dispatched in the same task as `mouseup`, so
  // only a timer is guaranteed to land AFTER the pressed element's own handler has run.
  const armedPaneRef = useRef('');
  const activatePane = useCallback((paneId: string) => {
    if (paneId) setActivePaneId((cur) => (cur === paneId ? cur : paneId));
  }, []);
  const armPane = useCallback((paneId: string) => {
    if (paneId) armedPaneRef.current = paneId;
  }, []);
  useEffect(() => {
    const release = (now: boolean) => {
      const pid = armedPaneRef.current;
      armedPaneRef.current = '';
      if (!pid) return;
      if (now) activatePane(pid);
      else window.setTimeout(() => activatePane(pid), 0);
    };
    // Capture + on the window: a child that stops propagation, or a release that happens
    // outside the host (a selection dragged out of the pane), must still commit the switch.
    const onUp = () => release(false);
    // A native drag (a dragged selection) swallows the `mouseup` and has no click to protect —
    // take the switch immediately rather than leaving it armed for later. A TAB drag is a
    // pointer gesture (tabDrag.ts) and never comes through here.
    const onDragStart = () => release(true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('dragstart', onDragStart, true);
    return () => {
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('dragstart', onDragStart, true);
    };
  }, [activatePane]);
  // Sessions the user minimized OUT of the side-by-side panes (to free terminal space)
  // while the overlay stays open — they live on as live progress chips in the corner dock,
  // restorable with a click. Kept alive in the garage exactly like any backgrounded tab.
  const [minimizedIds, setMinimizedIds] = useState<string[]>([]);
  // The tab drag in flight (tabDrag.ts) — one store per surface, read by the tab strip and the
  // panes' drop overlays. Never React state here: a drag re-renders only what its target
  // touches, never this 4k-line surface.
  const [tabDrag] = useState(createTabDragStore);
  const [, bumpStatus] = useReducer((x: number) => x + 1, 0);
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
  // The FULL spawn guard (desktop + CLI + the chosen surface + switched on), shared with the
  // onboarding hand-off through `agentCanSpawn` so "Start with Claude" asks exactly what this
  // surface will. `claudeReady` alone stays where only the surface half is the question.
  const canSpawn = agentCanSpawn({
    desktop: !!caps?.desktop,
    claudeCli: !!caps?.claudeCli,
    chatView: !!agentSettings.chatView,
    embeddedTerminal: !!caps?.embeddedTerminal,
    enabled: !!agentSettings.enabled,
  });

  const sessions = useRef<Map<string, Session | ChatSession>>(new Map());
  // Window control (`dreamcontext window …`, windowVerbs.ts): the deps for one calling chat,
  // rebuilt every render so a verb always acts on the CURRENT layout. Assigned further down,
  // once every action it lends exists; `spawn` hands each chat a handler that reads it.
  const windowDepsRef = useRef<(self: string) => WindowVerbDeps | null>(() => null);

  // ── The project's Super Agent (task chat-gets-a-super-agent-mode…, plan-r7 D5, D9, D16-D18) ──
  //
  // `superState` is the server's record (pushed as `super_state` down the Super Agent's own
  // socket after every write, read once with GET after a reload); `superView` is which screen
  // this window shows. They differ only while a flight runs: the view switches when the DOM
  // does, the record when the server answers. The Super Agent's session is an ordinary chat
  // session in `sessionList` (mode `super`) that is NEVER a tab: no pane holds it, the roster
  // never saves it, the restore never places it, the reconcile never adopts it (D9's one
  // predicate, `isSuperSession`). While handed over it is homed into the centre slot.
  const [superState, setSuperState] = useState<SuperStateView | null>(null);
  const superStateRef = useRef(superState);
  /** Delegated children being opened right now, before the server's record names them: their
   *  lean MCP set (orchestration plan r5 D14). Read by `spawn` with the record. */
  const leanOpeningRef = useRef<Map<string, string[]>>(new Map());
  superStateRef.current = superState;
  /** The project's super record has been read (or there is none to read here): until then a
   *  chat's question alarm waits, since it may be a child's (super/childAlarm.ts). */
  const superKnownRef = useRef(false);
  /** The owner's layout edits not yet echoed by the server (F3): re-applied over every push. */
  const pendingPatchesRef = useRef<LayoutPatch[]>([]);
  const withPendingEdits = (st: SuperStateView): SuperStateView => {
    const { state, keep } = withPendingPatches(st, pendingPatchesRef.current);
    pendingPatchesRef.current = keep;
    return state;
  };
  /** Cards the owner closed whose close has not reached the record yet (an exit names them). */
  const pendingCloses = useCallback(() => pendingPatchesRef.current.flatMap((p) => p.closed ?? []), []);
  const [superView, setSuperView] = useState<'panes' | 'super'>('panes');
  const superViewRef = useRef(superView);
  superViewRef.current = superView;
  const [superMotion, setSuperMotion] = useState<'idle' | 'running'>('idle');
  const [superPending, setSuperPending] = useState<ReadonlySet<string>>(() => new Set());
  const [superBusy, setSuperBusy] = useState(false);
  const superBusyRef = useRef(false);
  const [superWidth, setSuperWidth] = useState(0);
  const [superSlotEpoch, bumpSuperSlots] = useReducer((x: number) => x + 1, 0);
  // Read by every chat `spawn` creates, so a respawned Super Agent (an account switch, a
  // resume) keeps its wiring: the handlers are refs, rebuilt every render below.
  const superCommandRef = useRef<(cmd: { verb: string; args: Record<string, unknown> }) =>
    Promise<{ ok: true; result?: unknown } | { ok: false; error: string }>>(async () => ({ ok: false, error: 'no_window' }));
  const superSignalRef = useRef<(signal: SuperSignal) => void>(() => {});
  const superWindowGuardRef = useRef<(cs: ChatSession, verb: string, args: Record<string, unknown>) => string | null>(() => null);
  const superLeaseRef = useRef<{ typed: () => void; dispose: () => void } | null>(null);
  // Children this window just opened for a `delegate`, by pin id → until when they stay marked
  // without the record naming them (`childMarks`, D16): quiet from the first frame, not only once
  // the server's `super_state` push lands.
  const [superDelegated, setSuperDelegated] = useState<ReadonlyMap<string, number>>(() => new Map());
  // The owner's hand-over actions in order: a result belonging to one already reversed is dropped.
  const superGenRef = useRef(actionGeneration());

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
  // ── Parking under load: what the window knows and the server cannot ────────────────
  /** When the owner last looked at or typed in each tab (by session id). */
  const ownerTouchRef = useRef(new Map<string, number>());
  /** Decides a park request for one tab; replaced every render (see its assignment). */
  const parkVerdictRef = useRef<(sid: string, req: { focusGraceMs: number; end?: boolean; force?: boolean }) => ParkVerdict>(() => ({ ok: false, error: 'refused' }));
  // True once the saved roster has been fetched (or the fetch failed/was empty). Gates
  // the persist effect so a pre-hydrate render can't PUT [] and clobber the saved names.
  const hydratedRef = useRef(false);
  // The roster generation the last GET answered (`baseGeneration` of every PUT). A PUT based on
  // an older one is refused (409 `roster_stale`) and this surface re-hydrates instead.
  const rosterGenRef = useRef<number | undefined>(undefined);
  // Mac mode's phone: the stored tabs the last restore could not judge (the Mac did not answer
  // live-chats), kept on every save so an unreachable Mac never deletes them.
  const unrestoredRef = useRef<SavedMeta[]>([]);
  // Bumped to pull the roster again (a stale PUT, or Mac mode's Return).
  const [rehydrateNonce, setRehydrateNonce] = useState(0);
  const rehydrateRoster = useCallback(() => {
    hydratedRef.current = false;
    setRehydrateNonce((n) => n + 1);
  }, []);
  // Mac mode ended, whoever pressed Return: Return moved the tabs the phone had open into this
  // project's roster, so it is pulled again and they open beside the tabs already here (a chat
  // the Mac still runs is adopted, not spawned again).
  useEffect(() => {
    if (isMacPhoneSurface()) return;
    window.addEventListener(MAC_MODE_ENDED_EVENT, rehydrateRoster);
    return () => window.removeEventListener(MAC_MODE_ENDED_EVENT, rehydrateRoster);
  }, [rehydrateRoster]);
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
  const resumeChatRef = useRef<
    ((cs: ChatSession, targetBypass?: boolean, targetAccountId?: string, heldTexts?: string[]) => ChatSession) | null
  >(null);
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
      // The OTHER watcher that restarts through the same mechanism. Traced for the same
      // reason as `armAccountSwitch`: without it a respawn could appear in the trace with no
      // trigger above it, and the two watchers would be indistinguishable after the fact.
      traceRespawn('armAuthRestart', 'armed', {
        from: cs.id, claudeId: cs.claudeId,
        detail: { identity: changed.identity, loggedIn: changed.loggedIn },
      });
      if (!resumeChatRef.current?.(cs)) {
        traceRespawn('armAuthRestart', 'failed', { from: cs.id, claudeId: cs.claudeId, detail: { error: 'resumeChatRef returned nothing' } });
      }
    });
  }, [noteAuthChange]);

  /**
   * The half of AUTO-SWITCH that restarts — the new caller of an EXISTING restart mechanism.
   *
   * What is genuinely reused is the RESTART MECHANISM: `resumeChatSession` plus the server's
   * upgrade handler and its `awaitResumeHandoff`, the guard that closes the transcript-loss
   * race by waiting for the previous holder to let go. What could NOT be reused is the
   * DETECTION path: `armAuthRestart` above watches `authChanged`, which is produced by the
   * single-HOME watcher's fingerprint over `~/.claude.json` — and a switch between two
   * sandboxes never touches that file, so that signal can never fire for this event. Hence a
   * separate frame and this separate arm.
   *
   * THE THREE REFUSALS ARE KEPT VERBATIM from `armAuthRestart`:
   *   • an in-flight turn waits for the TURN BOUNDARY (it was authorized by the account it
   *     started on and will finish there; killing it would discard work to save nothing);
   *   • an EXITED session is left alone;
   *   • a session no longer in the registry is never respawned — a closed tab's teardown also
   *     flips `busy` to false, and respawning there would leave a live `claude` behind a tab
   *     that exists in no pane and no roster.
   *
   * `switched: false` is drawn and nothing else: the turn already went out on the current
   * account, and there is nothing to restart.
   */
  const armAccountSwitch = useCallback((cs: ChatSession) => {
    let settled = false;
    const stop = () => { settled = true; off(); };
    const off = cs.subscribe(() => {
      if (settled) return;
      if (sessions.current.get(cs.id) !== cs) { stop(); return; }   // closed/replaced
      const move = cs.getModel().accountSwitch;
      if (!move) return;
      // Reported only: nothing to restart — but `return`, never `stop()`. A session told
      // "stayed put" or "every account is full" can be told to MOVE a minute later, once the
      // probe that failed answers or a window reopens. Disarming here (as this line did until
      // 2026-10-04) left that later switch announced and never performed: the server held the
      // message for a restart that never came and sent every one after it into the refused
      // account — "You've hit your weekly limit" for thirteen minutes with three accounts free.
      if (!move.switched || !move.accountId) return;
      // ── THE NOTICE IS ALSO CARRIED ONTO THE SESSION THIS RESTART CREATES ──────────────
      //
      // `next.noteAccountSwitch(move)` at the bottom of this callback copies the notice onto
      // the replacement so the switch stays VISIBLE — and that replacement carries its own
      // copy of this very watcher, reading this very field. Without this line the carried
      // notice is indistinguishable from a fresh instruction: the new session restarts itself
      // onto the account it was just spawned on, copies the notice onto ITS replacement, and
      // recurses — synchronously, because `noteAccountSwitch` flushes subscribers rather than
      // coalescing them — until the stack overflows. `fireSubscribers` wraps every subscriber
      // in a try/catch, so the overflow is SWALLOWED: what the user sees is not an error but
      // a tab whose roster entry outlived the session behind it (each frame deleted its
      // session before spawning the next, and the last spawn never landed). That tab draws,
      // reads `starting` (the amber pulse), renders an empty pane — no ChatPane is portaled
      // for a roster id with no session — and cannot be clicked back to life.
      //
      // The test is the SERVER'S OWN RULE, not a flag: it refuses to announce a switch to the
      // account a session is already running on (`choice.accountId === activeAccountId` →
      // `switched: false`), so a `switched: true` notice naming THIS session's account can
      // only be the carried one. `accountId` is `readonly` and fixed at spawn, which is what
      // makes it a truthful answer to "which account am I".
      //
      // `return`, not `stop()`: the notice is inert, but this session is still a candidate for
      // a LATER, genuine switch (its new account can hit a limit too), and disarming here
      // would silently retire the watcher for the rest of the session's life.
      if (move.accountId === cs.accountId) return;                    // already there — carried, not asked for
      if (cs.getModel().exited) { stop(); return; }
      // THE GATE READS THE SERVER'S ANSWER, NOT `busy`. `chatSession.writeUser` sets `busy`
      // optimistically the instant a user frame reaches the socket, so the very message the
      // server is HOLDING makes this session look busy while nothing is running in the CLI —
      // and a gate on `busy` alone would wait for a boundary that can never arrive, leaving a
      // switch announced and never performed. `turnInFlight` is the server's own view: when a
      // turn genuinely IS running (a steer landed mid-turn) we still wait for it, because it
      // was authorized by the old credentials and is allowed to finish on them.
      if (move.turnInFlight && (cs.busy || cs.asking)) return;
      stop();
      // The watcher's decision to restart, recorded BEFORE the restart runs — so a trace that
      // ends in an orphan shows whether auto-switch was what triggered the respawn at all.
      traceRespawn('armAccountSwitch', 'armed', {
        from: cs.id, claudeId: cs.claudeId,
        detail: { toAccountId: move.accountId, turnInFlight: move.turnInFlight, hasPendingText: !!move.pendingText, reason: move.reason },
      });
      // The held turns go in AHEAD of anything the old session had queued: the server held
      // them, so they were typed first. Handed to the respawn rather than enqueued after it
      // returns, because that is where the old queue is carried and the order is set.
      const held = move.pendingTexts ?? (move.pendingText ? [move.pendingText] : []);
      const next = resumeChatRef.current?.(cs, undefined, move.accountId, held);
      if (!next) {
        // `resumeChatRef` is assigned on every render, so an empty ref here would mean the
        // restart never ran — after the session was already disposed by nobody. Worth seeing.
        traceRespawn('armAccountSwitch', 'failed', { from: cs.id, claudeId: cs.claudeId, detail: { error: 'resumeChatRef returned nothing' } });
        return;
      }
      // The notice is carried onto the NEW session before anything else. The frame landed on
      // the OLD one, which this restart just disposed — without this the switch would be
      // invisible, which is the one thing this feature promises never to be.
      // …and the reader's dismissal travels with it. The restart waits for the turn boundary,
      // which leaves the card on screen long enough to be closed BEFORE the new session
      // exists; without this the copy lands re-opened and the × the reader pressed is undone
      // by the very restart it was pressed during.
      next.noteAccountSwitch(move, cs.getModel().accountSwitchDismissed);
      // The held turns are resubmitted on the NEW process (by `resumeChatSession`, above), so
      // the user's messages are never lost.
      //
      // ENQUEUED, NOT SENT. `next` was constructed microseconds ago and its WebSocket is still
      // CONNECTING — `writeUser` refuses any frame on a socket that is not OPEN and answers
      // `false`, which nothing here could act on. So `send` DROPPED the resubmit every single
      // time: not a race, a certainty, and the one thing this feature promises never to do.
      // The queue is the mechanism that already knows how to hold a message until the wire can
      // carry it (`maybeFlushQueue` drains on the open edge), and it holds it VISIBLY — if the
      // new socket never opens at all, the text is a row the user can still read and resend
      // rather than something that vanished between two processes.
    });
  }, []);

  /**
   * Auto-title: the chat's OWN agent names its tab (Settings → Agents → auto-name tabs).
   *
   * The agent writes a `title` dream-view block (`chatViewSpec.ts`) once it understands what
   * the work is about, and again when the subject genuinely moves — it is the one reader that
   * knows, which is why this replaced the Haiku side-call that guessed from the first message.
   *
   * Only LIVE items are read, never `conv.history`: a resumed chat replays its old answers
   * there, and re-applying a title from yesterday's transcript would fight the roster's own
   * record of it. Each finished text item is read once; the last `title` in it wins.
   *
   * The rename lands only on a tab that still carries its default "Agent N"/"Chat N" name or a
   * name this agent set (`titleByAgent`). A user rename clears that flag, so their choice
   * wins for good; a tab opened under a purpose-given name (a Develop task, Sleep) keeps it.
   * The preference is read at APPLY time, so flipping it off stops renames immediately.
   */
  const armAgentTitle = useCallback((cs: ChatSession) => {
    const read = new Set<string>();
    const off = cs.subscribe(() => {
      if (sessions.current.get(cs.id) !== cs) { off(); return; }  // closed/replaced
      const items = cs.getModel().items;
      let title: string | null = null;
      // Newest first, stopping at the first item already read: text blocks finish in order,
      // so everything before it has been read too — a streamed token costs O(1), not O(n).
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (read.has(it.id)) break;
        if (it.kind !== 'text' || !it.done) continue;
        read.add(it.id);
        if (title !== null || !it.text.includes('dream-view')) continue;
        const views = parseChatActions(it.text).views;
        for (let v = views.length - 1; v >= 0; v--) {
          const view = views[v];
          if (view.type === 'title') { title = view.text; break; }
        }
      }
      if (!title) return;
      const s = agentSettingsRef.current;
      if (!s.enabled || !s.autoTitle) return;
      const next = title;
      setSessionList((prev) => {
        let changed = false;
        const out = prev.map((m) => {
          if (m.id !== cs.id || m.dormant || m.title === next) return m;
          if (!m.titleByAgent && !DEFAULT_TAB_TITLE_RE.test(m.title)) return m;
          changed = true;
          return { ...m, title: next, titleByAgent: true };
        });
        return changed ? out : prev;
      });
    });
  }, []);

  const started = sessionList.length > 0;
  // The action-focused pane (falls back to the first pane when the stored id is stale).
  const activePane = panes.find((p) => p.id === activePaneId) ?? panes[0];
  const panesRowRef = useRef<HTMLDivElement>(null);
  const glideRef = useRef<HTMLDivElement>(null);
  usePaneFocusGlide(panesRowRef, glideRef, activePane?.id, panes.length);
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
    // This window's own writes AND every other window's (see `onAgentSettings`).
    const off = onAgentSettings(setAgentSettings);
    return () => { cancelled = true; off(); };
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
    // setup checklist.
    if (hydratedRef.current || !(caps?.embeddedTerminal || (caps?.claudeCli && agentSettings.chatView)) || !settingsReady) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await scopedApi.get<SavedSurface>('/agent/sessions');
        if (!cancelled) rosterGenRef.current = generationOf(res);
        // The remembered permission mode is restored REGARDLESS of "Reopen past tabs": it is a
        // preference about how the next chat opens, not a tab. localStorage cannot carry it —
        // the desktop app picks a fresh loopback port every launch, so the origin (and the
        // store) is new every time, and a mode chosen yesterday was silently back on `auto`
        // this morning. The ref moves with the state because `spawn` reads the ref.
        if (!cancelled && res.chatPermissionMode === 'bypass') {
          chatPermissionModeRef.current = 'bypass';
          setChatPermissionMode('bypass');
          // Mirror into this origin's store too, so the surfaces that read it directly
          // (and any second mount) agree with what the server just told us. `bus` delivery
          // is harmless here — our own listener sets the same value we just set.
          writeChatPermissionMode(bus, vault, 'bypass');
        }
        // Everything below restores TABS, which the preference does gate.
        if (!agentSettings.restoreTabs) return;
        // Terminals are never remembered — drop any shell entry, plus any legacy roster
        // row still named "Terminal N" (a stale shell saved before we stopped persisting
        // them; auto-title only ever renames AGENTS, so that default name is a reliable
        // shell marker). What's left is agents + chats.
        // An ended super child is not a tab any more (superRestore.ts).
        const stored = Array.isArray(res.sessions)
          ? res.sessions.filter((m) => m.kind !== 'shell' && !/^Terminal \d+$/.test((m.title ?? '').trim()) && superRestorePlan(m.superHold) !== 'drop')
          : [];
        // Mac mode's phone brings back only the chats the Mac is running now, adopted below with
        // no spawn; every other stored tab stays a closed chat (rosterRehydrate.ts `phoneRestorable`).
        // A tunnel's passing 502 gets one more try. Still no answer restores nothing, and the
        // stored tabs ride along on every save until a restore can judge them (`carriedUnrestored`).
        let saved = stored;
        let unrestored: SavedMeta[] = [];
        if (isMacPhoneSurface()) {
          const ask = () => scopedApi.get<LiveChatsWire>('/agent/live-chats');
          const live = await ask().catch(() => ask()).catch((err: unknown) => {
            console.warn('[phone restore] the Mac did not say which chats it runs: restoring none', err);
            return null;
          });
          saved = phoneRestorable(stored, live);
          if (!live) unrestored = stored;
        }
        // Only the run still current writes it: a cancelled run landing late must not wipe the
        // newer run's carry (its next save would then delete the stored tabs after all).
        if (!cancelled) unrestoredRef.current = unrestored;
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
        // A re-hydrate (rosterRehydrate.ts) also adopts the stored titles of tabs already open
        // (renamed on the phone); tabs only here are kept; new ones are restored below.
        const { fresh } = mergeStoredRoster(sessionListRef.current, saved, { adoptTitles: false });
        if (!cancelled && rehydrateNonce > 0) {
          setSessionList((prev) => mergeStoredRoster(prev, saved, { adoptTitles: true }).open ?? prev);
        }
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
              // Mac mode's phone only reaches here for a chat the Mac is running: adopt it
              // passively like the chat branch below, never supersede the Mac's process.
              const s = isMacPhoneSurface()
                ? spawn(m.bypass, m.sessionId, true, claudeKind, '', '', true, '', false, '', false, DEFAULT_CHAT_MODE, '', '', 'passive')
                : spawn(m.bypass, m.sessionId, true, claudeKind);
              return { id: s.id, title: m.title, kind, bypass: m.bypass, claudeId: m.sessionId, automation: m.automation, ...(m.titleByAgent ? { titleByAgent: true } : {}) };
            }
            // An agent OR chat tab with a pinned conversation auto-RESUMES its real Claude
            // session on launch (both spawn a real `claude` against the same conversation
            // UUID). A shell has nothing to resume, and auto-spawning shells on launch is
            // surprising — so shells (and legacy tabs without a conversation id) restore
            // DORMANT, spawning a fresh session only on an explicit Resume click.
            // A card-closed, parked or gone super child comes back DORMANT on its own
            // conversation: Resume reopens it, nothing runs until then (superRestore.ts).
            if ((kind === 'agent' || kind === 'chat') && m.sessionId && superRestorePlan(m.superHold) === 'dormant') {
              return {
                id: `restored-${i}`, title: m.title, kind, bypass: m.bypass, claudeId: m.sessionId, dormant: true,
                ...(kind === 'chat' ? { mode: knownChatMode(m.mode) ?? DEFAULT_CHAT_MODE } : {}),
                ...(m.agent ? { agent: m.agent } : {}),
                // The roster keeps no model, effort or account: Resume uses the defaults for those.
                ...(m.superHold === 'parked' ? { parked: { at: Date.now(), transport: kind === 'chat' ? 'chat' as const : 'agent' as const } } : {}),
                ...(m.titleByAgent ? { titleByAgent: true } : {}),
              };
            }
            if ((kind === 'agent' || kind === 'chat') && m.sessionId) {
              // A saved CHAT tab reopens under the mode it was last in — a Develop session that
              // survives a relaunch is still a Develop session. `knownChatMode` drops anything
              // this build doesn't recognise, and the mode is only meaningful for the chat
              // surface (a tab saved as chat but restored as a terminal `agent` ignores it,
              // which `spawn`'s non-chat arm does by construction).
              const savedMode = knownChatMode(m.mode) ?? DEFAULT_CHAT_MODE;
              // `explicitBypass` (param 11) is TRUE here, so the tab reopens under the mode it
              // was last RUNNING, not under the project's current default. A restored tab is
              // exactly the kind of spawn that carries its own permission answer — the same
              // exemption "Session ended · Resume" takes — and without it a chat the user put
              // on Bypass yesterday came back on Auto, because the project default is resolved
              // from a store that does not survive the relaunch. It cannot escalate anything:
              // the value is whatever this tab's own process was acknowledged to be under.
              // Bound BEFORE the spawn: `createChatSession` reads the agent from the binding.
              const savedAgent = kind === 'chat' && m.agent ? m.agent : '';
              bindChatAgent(m.sessionId, savedAgent);
              // PASSIVE (hands-free Mac mode): a restore is an automatic open, so it adopts a
              // chat left detached by the reload but never takes one another screen holds — that
              // tab comes back showing "Buraya al" instead (4409).
              const s = spawn(m.bypass, m.sessionId, true, kind, '', '', true, '', false, '', true, savedMode, '', '', 'passive');
              return {
                id: s.id, title: m.title, kind, bypass: m.bypass, claudeId: m.sessionId,
                ...(kind === 'chat' ? { mode: savedMode } : {}),
                ...(savedAgent ? { agent: savedAgent } : {}),
                ...(m.titleByAgent ? { titleByAgent: true } : {}),
              };
            }
            return { id: `restored-${i}`, title: m.title, kind, bypass: m.bypass, claudeId: newClaudeId(), dormant: true, ...(m.titleByAgent ? { titleByAgent: true } : {}) };
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
          // THE PLACEMENT, rebuilt — the half this restore used to throw away. Every tab went
          // into ONE pane, so five side-by-side panes reopened as one stack with one chat
          // visible and the other four to be found in a tab strip. The arrangement IS the
          // work on this surface, so it travels in the roster (`SavedMeta.pane`/`active`) and
          // is regrouped here.
          //
          // Grouped by the SAVED index and then re-laid left to right, so gaps close instead
          // of producing empty panes: a roster whose panes read 0, 2, 5 rebuilds as three
          // adjacent panes in that order. `restored[i]` and `fresh[i]` are index-aligned by
          // construction (`restored` is `fresh.map`), which is what lets the placement be read
          // off the saved entry while the id comes from the spawned one.
          const groups = new Map<number, SessionMeta[]>();
          const activeIds = new Set<string>();
          restored.forEach((m, i) => {
            const saved = fresh[i];
            // The Super Agent is never a tab (plan-r7 D9). Checked HERE, inside the
            // index-aligned loop, because an unplaced entry would otherwise land in pane 0
            // through `saved.pane ?? 0`; the hand-over binds the restored session by its id.
            if (isSuperSession({ mode: m.mode ?? saved.mode, claudeId: saved.sessionId }, superStateRef.current?.session)) return;
            const idx = Math.max(0, Math.floor(saved.pane ?? 0));
            const bucket = groups.get(idx);
            if (bucket) bucket.push(m); else groups.set(idx, [m]);
            if (saved.active) activeIds.add(m.id);
          });
          const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]);
          // Which restored pane had focus, as a position in `ordered` — resolved here rather
          // than stored, because the saved index is pre-gap-closing.
          const focusAt = res.activePane === undefined
            ? -1
            : ordered.findIndex(([idx]) => idx === res.activePane);
          const built = ordered.map(([, metas]) => ({
            id: nextPaneId(),
            tabs: metas.map((m) => m.id),
            active: (metas.find((m) => activeIds.has(m.id)) ?? metas[0]).id,
          }));
          // Was anything already on screen when the roster landed? Read from the roster ref
          // rather than from `panes` (which this effect deliberately does not close over, so
          // it can never re-run on a layout change) — a tab and its pane arrive together.
          // The Super Agent's session (re-bound after a reload while handed over) is no tab, so
          // it does not make the restore any less clean.
          const cleanRestore = sessionListRef.current.filter((m) => !isSuperSession(m, superStateRef.current?.session)).length === 0;
          setPanes((prev) => {
            if (prev.length === 0) return built;
            // Something opened a tab while the roster was in flight (the D7 race above). Its
            // pane keeps the foreground — a launch-time restore is background furniture and
            // must not steal it — and the restored panes land beside it rather than all
            // collapsing into it, which is the whole point of persisting the placement.
            return [...prev, ...built];
          });
          // Focus follows the saved pane ONLY on a clean restore, for the same reason the
          // branch above leaves `prev`'s foreground alone.
          if (cleanRestore && focusAt >= 0) setActivePaneId(built[focusAt].id);
        }
      } catch { /* no saved roster (or non-desktop 403) — just start fresh */ }
      finally { if (!cancelled) { hydratedRef.current = true; } }
    })();
    return () => { cancelled = true; };
  }, [caps, settingsReady, agentSettings.restoreTabs, agentSettings.chatView, scopedApi, rehydrateNonce]);

  // Persist on every roster OR LAYOUT change (post-hydrate), debounced. AGENTS and CHATS are
  // remembered — plain TERMINALS are session-local and never reopened on launch (the server
  // also can't resume a shell, and a stale `claude --resume` on a shell's id would wrongly
  // reopen it as an agent). Saves both dormant and live metas so a renamed live session is
  // captured too. `minimized`/`size` are inert defaults kept only for persisted-format
  // compatibility; `pane`/`active`/`activePane` are the live ones that carry the placement.
  // Best-effort: a failed PUT just means this change isn't mirrored.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const handle = setTimeout(() => {
      if (!hydratedRef.current) return; // a re-hydrate started: never send the stale payload
      // The layout, flattened to what survives a relaunch: which pane (by POSITION, since pane
      // ids are minted per page load and mean nothing tomorrow) and which tab was visible in
      // it. A session in no pane — minimized — has no placement and defaults to pane 0 on the
      // way back in, which is where a restored-from-nothing tab has always gone.
      const paneOf = new Map<string, number>();
      const activeTabs = new Set<string>();
      panes.forEach((p, i) => {
        p.tabs.forEach((t) => paneOf.set(t, i));
        if (p.active) activeTabs.add(p.active);
      });
      const activePaneIndex = panes.findIndex((p) => p.id === activePaneId);
      const payload = {
        // The remembered permission mode rides with the roster: same per-vault, machine-local,
        // gitignored file, and the same reason for being server-side at all (localStorage dies
        // with the launch's loopback port). Sent on every roster write, so the value on disk
        // is always the one this surface is actually running under.
        chatPermissionMode,
        ...(activePaneIndex >= 0 ? { activePane: activePaneIndex } : {}),
        sessions: [...sessionList
          .filter((m) => m.kind !== 'shell')
          // The Super Agent is never a tab, so it is never saved as one: a relaunch after
          // take-back shows no super tab, and a reload while handed over rebinds it by id.
          .filter((m) => !isSuperSession(m, superStateRef.current?.session))
          .map((m) => ({
            title: m.title, kind: m.kind, bypass: m.bypass, minimized: false, size: 1, sessionId: m.claudeId,
            ...(paneOf.has(m.id) ? { pane: paneOf.get(m.id) } : {}),
            ...(activeTabs.has(m.id) ? { active: true } : {}),
            ...(m.titleByAgent ? { titleByAgent: true } : {}),
            // Only carried for automation tabs — the server's `coerceMeta` drops it for
            // every other kind anyway, but there's no reason to send it otherwise.
            ...(m.kind === 'automation' && m.automation ? { automation: m.automation } : {}),
            // Same rule for the chat mode: it means nothing on a shell or a terminal agent,
            // and `coerceMeta` keeps it only alongside `kind: 'chat'`. Basic is the absent
            // state on BOTH sides, so a plain chat tab's payload is unchanged.
            ...(m.kind === 'chat' && m.mode && m.mode !== DEFAULT_CHAT_MODE ? { mode: m.mode } : {}),
            ...(m.kind === 'chat' && m.agent ? { agent: m.agent } : {}),
          })),
          ...carriedUnrestored(unrestoredRef.current, new Set(sessionList.map((m) => m.claudeId)))],
      };
      // `baseGeneration` = the last GET's; a 409 roster_stale re-hydrates and never re-sends
      // this body; anything else stays best-effort (rosterRehydrate.ts `putOutcome`).
      const settle = (o: ReturnType<typeof putOutcome>) => {
        if (o.kind === 'adopt' && o.generation !== undefined) rosterGenRef.current = o.generation;
        else if (o.kind === 'rehydrate') rehydrateRoster();
      };
      void scopedApi.put<unknown>('/agent/sessions', withBaseGeneration(payload, rosterGenRef.current)).then(
        (body) => settle(putOutcome({ ok: true, body })),
        (err: unknown) => settle(putOutcome(err instanceof RequestError ? { ok: false, status: err.status, code: err.code } : { ok: false, status: 0, code: '' })),
      );
    }, 400);
    return () => clearTimeout(handle);
    // `panes`/`activePaneId`/`chatPermissionMode` join the roster in the deps because they are
    // now part of what is persisted — a split, a tab drag or a permission change has to reach
    // disk, and the 400ms debounce is what keeps a drag from writing once per frame.
  }, [sessionList, panes, activePaneId, chatPermissionMode, scopedApi, rehydrateRoster]);

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
  //  13 accountId     14 origin
  //
  // `origin` is 'assistant' ONLY from the doorbell's openChat (a chat the Assistant started);
  // every other call site passes nothing. A respawn of that chat needs no client change: the
  // server re-derives the marker from the conversation it resumes.
  const spawn = useCallback((bp: boolean, claudeId?: string, resume = false, kind: SessionKind = 'agent', initialPrompt = '', model = '', submitInitial = true, promptToken = '', deferPrompt = false, effort = '', explicitBypass = false, mode: ChatMode = DEFAULT_CHAT_MODE, accountId = '', origin: '' | 'assistant' = '', reattach: '' | '1' | 'passive' = '') => {
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
      // '' = let the server resolve the default (the preferred account, else account #0).
      // The picker and the auto-switch restart are the only callers that name one.
      // A delegated Super Agent child runs LEAN (plan r5 D14): only the MCP servers its job named,
      // on EVERY spawn of its conversation (Resume, account switch, reconnect), from its record.
      const cid = claudeId ?? newClaudeId();
      const lean = mode === 'super' ? null : leanMcpFor(superStateRef.current, cid, leanOpeningRef.current);
      // The phone's Super conversation is a mirror in an ordinary chat mode: told here, on every
      // spawn of it, that it shows the Super (reply strips, groups, the ↩ chip).
      const mirror = mode !== 'super' && isSuperMirrorId(cid);
      const cs = createChatSession(vault ?? '', effectiveBypass, bumpStatus, cid, resume, chatModel, chatEffort, initialPrompt, promptToken, deferPrompt, mode, accountId, origin, null, reattach, lean, mirror);
      cs.applyZoom(currentZoom());
      sessions.current.set(cs.id, cs);
      // Every chat spawned anywhere in this surface follows the signed-in account, for the
      // same reason the permission-mode default is resolved here rather than per call site:
      // one place to arm means no future spawn path can forget to.
      armAuthRestart(cs);
      armAccountSwitch(cs);
      armAgentTitle(cs);
      cs.setParkHandler((req) => parkVerdictRef.current(cs.id, req));
      cs.setWindowHandler(async ({ verb, args }) => {
        // The browser's re-check of the server's D4b refusals while handed over.
        const refusal = superWindowGuardRef.current(cs, verb, args);
        if (refusal) return { ok: false, error: refusal };
        const deps = windowDepsRef.current(cs.id);
        return deps ? runWindowVerb(deps, verb, args) : { ok: false, error: 'no_window' };
      });
      // A child of the handed-over Super Agent is quiet from its first frame (D16); before the
      // record is read nobody knows, so its alarm waits for it.
      cs.setSuperChild(superKnownRef.current || superStateRef.current
        ? markedChildren(superStateRef.current).has(cs.claudeId)
        : null);
      if (mode === 'super') {
        // The Super Agent's own chat: the window-side verbs, the pushed state, and the
        // owner-activity lease (a keystroke in its composer, never the text).
        cs.setSuperHandler((cmd) => superCommandRef.current(cmd));
        cs.onSuper((signal) => superSignalRef.current(signal));
        cs.setDraftListener(() => { if (superStateRef.current?.enabled) superLeaseRef.current?.typed(); });
      }
      return cs;
    }
    // A shell has no permission model, so bypass is meaningless for it — force it off.
    const s = createSession(vault ?? '', kind === 'shell' ? false : bp, bumpStatus, claudeId ?? newClaudeId(), resume, kind, initialPrompt, model, submitInitial, promptToken, deferPrompt);
    s.applyZoom(currentZoom());
    sessions.current.set(s.id, s);
    if (kind === 'agent') s.setParkHandler((req) => parkVerdictRef.current(s.id, { focusGraceMs: req.focusGraceMs }));
    return s;
  }, [chatPermissionMode, vault, armAuthRestart, armAgentTitle]);

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
    // The super chat's event-line context lives as long as its conversation (superJobsStore).
    if (kind === 'chat' && claudeId) publishSuperEventContext(claudeId, null);
    // A question card's kept picks (chat/surveyDrafts.ts) end with the conversation, not with a
    // respawn's dispose, which is why this lives here and not in `ChatSession.dispose`.
    if (kind === 'chat' && claudeId) dropSurveyDraftsFor(claudeId);
    // A conversation closed here is closed: it no longer rides along as an unjudged stored tab.
    if (claudeId) unrestoredRef.current = unrestoredRef.current.filter((m) => m.sessionId !== claudeId);

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
      void confirmAction({
        title: meta.title,
        body: "This automation's session was recorded on a different machine and was never bound here, so it can't be resumed on this one.",
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
      return;
    }
    // Agent/chat → resume the EXACT prior Claude conversation (`--resume <claudeId>`) in the
    // CURRENTLY chosen Agent screen (the surface preference is a swap — a tab dormant since
    // the other mode was active resumes the same conversation in this one). Shell → there is
    // no conversation to resume, so just open a fresh vault-scoped login shell.
    // A PARKED tab comes back as what it was (a chat stays a chat, in its mode, on its model,
    // effort and account), never as whatever the Agent screen preference says today.
    // Keyed on the TRANSPORT it ran as, so a parked automation tab (display kind) comes back too.
    // A super child the relaunch held dormant (superRestore.ts) carries its saved mode and
    // agent with no `parked`: it too comes back as the chat it was, under its own bypass.
    const parked = meta.parked;
    const asChat = parked ? parked.transport === 'chat' : meta.kind === 'chat' && !!meta.mode;
    if (asChat) bindChatAgent(meta.claudeId, meta.agent ?? '');
    const s = meta.kind === 'shell'
      ? spawn(meta.bypass, undefined, false, 'shell')
      : asChat
        ? spawn(meta.bypass, meta.claudeId, true, 'chat', '', parked?.model ?? '', true, '', false, parked?.effort ?? '', true, meta.mode ?? DEFAULT_CHAT_MODE, parked?.account ?? '')
        : spawn(meta.bypass, meta.claudeId, true, parked ? parked.transport : claudeKind);
    // 'automation' is a DISPLAY kind decoupled from transport (see hydration above and
    // `openAutomationRunChat` below) — preserve it rather than letting the spawned session's
    // actual agent/chat kind overwrite it on a manual resume of a dormant automation tab.
    const kind: SessionKind = meta.kind === 'automation' ? 'automation' : s.kind;
    setSessionList((prev) => prev.map((m) => (m.id === sid ? { ...m, id: s.id, kind, bypass: s.bypass, claudeId: s.claudeId, dormant: false, parked: undefined } : m)));
    setPanes((prev) => prev.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t === sid ? s.id : t)),
      active: p.active === sid ? s.id : p.active,
    })));
  }, [spawn, sessionList, claudeKind]);

  // ── Parking under load (src/server/chat-park.ts) ───────────────────────────────────
  // The server asks on the tab's own socket; the window re-checks what only it knows and
  // either refuses or ends the process the way the owner's close does, keeping the tab as a
  // dormant "parked" entry whose Resume reopens the same conversation.
  const parkSeq = useRef(0);
  const parkTab = useCallback((sid: string) => {
    const s = sessions.current.get(sid);
    if (!s) return;
    const chat = s.kind === 'chat' ? s as ChatSession : null;
    const parked: NonNullable<SessionMeta['parked']> = {
      at: Date.now(),
      transport: chat ? 'chat' : 'agent',
      ...(chat ? { model: modelForSession(chat), effort: effortForSession(chat), account: chat.accountId } : {}),
    };
    try { s.dispose(); } catch { /* best-effort: the server ends the child on its own */ }
    sessions.current.delete(sid);
    ownerTouchRef.current.delete(sid);
    const nid = `parked-${++parkSeq.current}`;
    setSessionList((prev) => prev.map((m) => (m.id === sid ? { ...m, id: nid, dormant: true, parked } : m)));
    setPanes((prev) => prev.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t === sid ? nid : t)),
      active: p.active === sid ? nid : p.active,
    })));
    setMinimizedIds((prev) => prev.map((x) => (x === sid ? nid : x)));
  }, [modelForSession, effortForSession]);

  /** The owner is looking at this surface right now (its project chip, opened, window focused). */
  const ownerLooking = (): boolean => isActive && expanded && document.visibilityState === 'visible' && document.hasFocus();
  parkVerdictRef.current = (sid, { focusGraceMs, end, force }) => {
    const s = sessions.current.get(sid);
    const meta = sessionListRef.current.find((m) => m.id === sid);
    if (!s || !meta || meta.dormant) return { ok: false, error: 'refused' };
    // Mac mode's phone drives this window: never parked out from under it. The Super Agent's
    // own chat receives its children's events, so it never parks either.
    if (isMacPhoneSurface()) return { ok: false, error: 'refused' };
    if (s.kind === 'chat' && (s as ChatSession).mode === 'super') return { ok: false, error: 'refused' };
    // `force` (`super end --force`) is the owner's own word: nothing below keeps the tab.
    if (!force) {
      if (s.hasLiveWork()) return { ok: false, error: s.asking ? 'asking' : s.busy ? 'busy' : 'background' };
      if (Date.now() - (ownerTouchRef.current.get(sid) ?? 0) < focusGraceMs) return { ok: false, error: 'focused' };
      if (ownerLooking() && focusedSessionId === sid) return { ok: false, error: 'focused' };
      // An unsent draft is the owner's half-written message.
      if (s.kind === 'chat' && (s as ChatSession).getModel().draft.trim()) return { ok: false, error: 'focused' };
    }
    // `super end`: the tab CLOSES (gone from the roster, so no relaunch restores it); the
    // transcript stays on disk and `super resume` / Past chats reopen it. A park keeps a
    // dormant tab instead.
    return { ok: true, commit: () => (end ? closeSessionById(sid) : parkTab(sid)) };
  };

  // The owner looked at or typed in a tab: remembered here (the window's own re-check) and
  // told to the server at most once per 30 s (`markFocus`), so the sweep leaves it alone.
  const touchFocusedRef = useRef<() => void>(() => { /* set below */ });
  touchFocusedRef.current = () => {
    if (!ownerLooking() || !focusedSessionId) return;
    ownerTouchRef.current.set(focusedSessionId, Date.now());
    sessions.current.get(focusedSessionId)?.markFocus();
  };
  useEffect(() => {
    const touch = () => touchFocusedRef.current();
    window.addEventListener('focus', touch);
    document.addEventListener('keydown', touch, true);
    document.addEventListener('pointerdown', touch, true);
    return () => {
      window.removeEventListener('focus', touch);
      document.removeEventListener('keydown', touch, true);
      document.removeEventListener('pointerdown', touch, true);
    };
  }, []);
  useEffect(() => { touchFocusedRef.current(); }, [focusedSessionId, expanded, isActive]);

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
  const resumeChatSession = useCallback((cs: ChatSession, targetBypass?: boolean, targetAccountId?: string, heldTexts: string[] = []) => {
    // Captured BEFORE dispose, applied after the respawn — see `carryDraftInto`. This path is
    // also the permission-mode fallback, so it is the one a Bypass switch actually takes.
    const carried = cs.getModel().draft;
    // …and the QUEUE, for the same reason: a message typed while a turn ran sits in
    // `conv.queued`, which is per session and died with it. Every respawn ate it — and an
    // account switch is the respawn most likely to have one waiting, since the composer
    // queues behind the very message the server is holding.
    // A row still held from an EARLIER switch stays held: it rides ahead with this switch's.
    const oldQueued = cs.getModel().queued;
    const carriedQueue = { texts: oldQueued.filter((q) => !q.resubmit).map((q) => q.text), paused: !!cs.getModel().queuePaused };
    const held = [...oldQueued.filter((q) => q.resubmit).map((q) => q.text), ...heldTexts];
    recordPhoneEvent('respawn', cs.claudeId, { reason: targetAccountId ? 'account' : targetBypass !== undefined ? 'mode' : 'resume' });
    traceRespawn('resumeChatSession', 'begin', {
      from: cs.id, claudeId: cs.claudeId,
      detail: { targetBypass, targetAccountId, fromAccountId: cs.accountId, mode: cs.mode, exited: cs.getModel().exited },
    });
    try { cs.dispose(); } catch { /* best-effort */ }
    sessions.current.delete(cs.id);
    // `targetBypass` is the ONE thing this path does not carry over when it is passed: the
    // caller is asking for a mode this conversation is NOT running under yet (see the
    // parameter's contract above). Absent — the "Session ended · Resume" case — `cs.bypass`
    // stands, so a resume never escalates.
    const bp = targetBypass ?? cs.bypass;
    // The account is carried over like the model and the mode. `targetAccountId` is the
    // auto-switch / picker path asking for a DIFFERENT one: an account is `CLAUDE_CONFIG_DIR`,
    // read once at spawn, so moving it is a respawn — there is no live control request for it.
    const acct = targetAccountId ?? cs.accountId;
    let s: ChatSession | Session;
    try {
      s = spawn(bp, cs.claudeId, true, 'chat', '', modelForSession(cs), true, '', false, effortForSession(cs), true, cs.mode, acct);
    } catch (err) {
      // The old session is already disposed and deleted, so a throw here leaves the roster
      // entry pointing at nothing — the orphan this trace exists to catch. Reported rather
      // than swallowed, then rethrown so behaviour is exactly what it was before.
      traceRespawn('resumeChatSession', 'failed', { from: cs.id, claudeId: cs.claudeId, detail: { error: String(err) } });
      throw err;
    }
    // `spawn` is typed as the Session|ChatSession union; the `'chat'` kind two lines up
    // provably took its chat arm, which is the same narrowing `changeChatMode` does by hand.
    // The carry stays ADJACENT to the spawn — `chat-draft-carry.test.ts` reads the proximity
    // as the guarantee, and the trace below is diagnostics that must not come between them.
    carryDraftInto(s as ChatSession, carried);
    carryQueueInto(s as ChatSession, held, carriedQueue);
    traceRespawn('resumeChatSession', 'spawned', { from: cs.id, to: s.id, claudeId: cs.claudeId, detail: { accountId: acct } });
    setSessionList((prev) => {
      const next = prev.map((m) => (m.id === cs.id ? { ...m, id: s.id, kind: 'chat' as const, bypass: s.bypass, claudeId: s.claudeId, mode: cs.mode } : m));
      // `Array.map` cannot report that it matched nothing, and a miss here is silent AND
      // terminal: the roster keeps the id of a session that no longer exists.
      traceRespawn('resumeChatSession', 'roster', { from: cs.id, to: s.id, detail: { matched: prev.some((m) => m.id === cs.id), rosterIds: prev.map((m) => m.id) } });
      return next;
    });
    setPanes((prev) => {
      traceRespawn('resumeChatSession', 'panes', { from: cs.id, to: s.id, detail: { matched: prev.some((p) => p.tabs.includes(cs.id)) } });
      return prev.map((p) => ({
        ...p,
        tabs: p.tabs.map((t) => (t === cs.id ? s.id : t)),
        active: p.active === cs.id ? s.id : p.active,
      }));
    });
    // Returned so the auto-switch arm can resubmit the turn the server held — without it the
    // user's message would be lost at exactly the moment the feature promises not to lose it.
    return s as ChatSession;
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
   *
   * The new append file alone does NOT reach the model: a resume restores the system prompt
   * from the transcript's snapshot. The server sees the mismatch on this respawn and tells the
   * conversation instead (src/server/chat-mode-drift.ts).
   */
  const changeChatMode = useCallback((sid: string, mode: ChatMode) => {
    const cs = sessions.current.get(sid);
    if (!cs || cs.kind !== 'chat') return;
    const chat = cs as ChatSession;
    if (chat.mode === mode) return; // picking the mode you are already in is not a restart
    const carried = chat.getModel().draft;  // BEFORE dispose — see `carryDraftInto`
    traceRespawn('changeChatMode', 'begin', { from: chat.id, claudeId: chat.claudeId, detail: { fromMode: chat.mode, toMode: mode } });
    try { chat.dispose(); } catch { /* best-effort */ }
    sessions.current.delete(chat.id);
    // Same B3 call shape as `resumeChatSession` above — `explicitBypass` with `bp = cs.bypass`,
    // so switching Basic → Develop can never also switch `auto` → `bypass`.
    let s: ChatSession | Session;
    try {
      s = spawn(chat.bypass, chat.claudeId, true, 'chat', '', modelForSession(chat), true, '', false, effortForSession(chat), true, mode);
    } catch (err) {
      traceRespawn('changeChatMode', 'failed', { from: chat.id, claudeId: chat.claudeId, detail: { error: String(err) } });
      throw err;
    }
    carryDraftInto(s as ChatSession, carried);  // union → chat arm, as above (kept adjacent to the spawn)
    traceRespawn('changeChatMode', 'spawned', { from: chat.id, to: s.id, claudeId: chat.claudeId, detail: { mode } });
    setSessionList((prev) => {
      traceRespawn('changeChatMode', 'roster', { from: chat.id, to: s.id, detail: { matched: prev.some((m) => m.id === chat.id), rosterIds: prev.map((m) => m.id) } });
      return prev.map((m) => (m.id === chat.id ? { ...m, id: s.id, kind: 'chat' as const, bypass: s.bypass, claudeId: s.claudeId, mode } : m));
    });
    setPanes((prev) => {
      traceRespawn('changeChatMode', 'panes', { from: chat.id, to: s.id, detail: { matched: prev.some((p) => p.tabs.includes(chat.id)) } });
      return prev.map((p) => ({
        ...p,
        tabs: p.tabs.map((t) => (t === chat.id ? s.id : t)),
        active: p.active === chat.id ? s.id : p.active,
      }));
    });
  }, [spawn, modelForSession, effortForSession]);

  /**
   * The composer's agent picker: talk to one of this project's agents (`/api/agents`) in a Chat tab.
   *
   * A NEW conversation, never a respawn of this one. An agent is a system prompt, and a resumed
   * conversation keeps the system prompt it was born with (see `changeChatMode`'s server note),
   * so "this conversation, now as the Funnel agent" would be a label over plain Claude. So the
   * pick opens a fresh conversation bound to the agent (`chatAgentBinding.ts`): in THIS tab when
   * nothing has been said in it yet, beside it in the same pane otherwise, so a conversation
   * with history is never closed by a menu click. `agent` empty = back to plain Claude, the same
   * way. Mode, permission, model, effort and account carry over; the draft does when the tab is reused.
   */
  const pickChatAgent = useCallback((sid: string, agent: { slug: string; title: string } | null) => {
    const cs = sessions.current.get(sid);
    if (!cs || cs.kind !== 'chat') return;
    const chat = cs as ChatSession;
    const slug = agent?.slug ?? '';
    if (chat.agent === slug) return;
    const fresh = !chat.busy && chat.getModel().items.length === 0;
    const carried = fresh ? chat.getModel().draft : '';
    const claudeId = newClaudeId();
    bindChatAgent(claudeId, slug);
    if (fresh) {
      try { chat.dispose(); } catch { /* best-effort */ }
      sessions.current.delete(chat.id);
    }
    const s = spawn(chat.bypass, claudeId, false, 'chat', '', modelForSession(chat), true, '', false, effortForSession(chat), true, chat.mode, chat.accountId) as ChatSession;
    carryDraftInto(s, carried);
    const meta: SessionMeta = {
      id: s.id, title: agent ? agent.title : titleFor(s), titleByAgent: true, kind: 'chat', bypass: s.bypass, claudeId,
      ...(chat.mode !== DEFAULT_CHAT_MODE ? { mode: chat.mode } : {}),
      ...(slug ? { agent: slug } : {}),
    };
    if (fresh) {
      setSessionList((prev) => prev.map((m) => (m.id === chat.id ? meta : m)));
      setPanes((prev) => prev.map((p) => ({
        ...p,
        tabs: p.tabs.map((t) => (t === chat.id ? s.id : t)),
        active: p.active === chat.id ? s.id : p.active,
      })));
      return;
    }
    setSessionList((prev) => [...prev, meta]);
    setPanes((prev) => prev.map((p) => {
      const at = p.tabs.indexOf(chat.id);
      if (at < 0) return p;
      const tabs = [...p.tabs];
      tabs.splice(at + 1, 0, s.id);
      return { ...p, tabs, active: s.id };
    }));
  }, [spawn, modelForSession, effortForSession]);

  /**
   * The `bypass` segment in ONE chat composer. Switches THAT conversation, and remembers the
   * choice as this project's default for the next one.
   *
   * IT USED TO SWITCH EVERY CHAT IN THE VAULT, and that was the defect, not the design going
   * missing. The mode was modelled as one project-wide setting, so the loop pushed
   * `set_permission_mode` into every live session — and because CLI 2.1.220+ REFUSES every
   * live switch into bypass, "apply to all" meant "respawn all". One click on one composer
   * therefore restarted five panes the user had not touched, and each restart is a real
   * dispose→`--resume` round trip with a real chance of coming back wrong. It also drove the
   * conversation loss: N simultaneous respawns block the event loop on N synchronous
   * `claude` spawns, the server's resume hand-off wait is starved, and a resume that cannot
   * take its conversation silently starts an unpinned new one (see
   * `RESUME_HANDOFF_MIN_POLLS` in `src/server/routes/agent-chat.ts`). A blank pane, for a
   * conversation nobody asked to change.
   *
   * So the write follows the READ, which was already per-session: the composer's indicator
   * has always shown the CLI's own `permissionMode` for that pane (see ChatPane's note on
   * `inBypass`), precisely because a Plan→Develop hand-off can run `auto` inside a
   * bypass-remembered project. One control now reads and writes the same scope.
   *
   * Three things still happen, two of them narrowed to `sid`:
   *   1. remembered      — persisted per vault, so every FUTURE chat spawns under it
   *                        (`spawn`'s chat arm) and it survives a relaunch (the roster file
   *                        carries it; localStorage does not survive the fresh loopback port),
   *   2. applied now     — THIS conversation switches without being restarted
   *                        (`set_permission_mode`), because a chip that reads "bypass" while
   *                        the running process is still on `auto` is simply lying,
   *   3. or else resumed — if the CLI rejects the live switch (always, for →bypass), THIS
   *                        conversation alone is respawned with `--resume` under the new mode.
   */
  const changeChatPermissionMode = useCallback((sid: string, mode: 'auto' | 'bypass') => {
    // Eagerly, so any spawn in THIS tick that resolves the project default (a brand-new chat,
    // a Delegate launch) reads the mode just chosen rather than the one being replaced. The
    // fallback respawn below does NOT rely on this — it is handed the requested mode as an
    // argument, because a session-scoped decision must not be delivered by a project-wide ref.
    chatPermissionModeRef.current = mode;
    // Persist under THIS vault's key and announce on THIS instance's bus, which is also what
    // feeds our own `useInstanceEvent` above and moves the state — one write path, no
    // second `setChatPermissionMode` here that could disagree with what was stored.
    writeChatPermissionMode(bus, vault, mode);
    // The roster entry records the mode this TAB is moving to, so the relaunch restores it
    // under the mode it was actually running (the hydrate spawn passes `explicitBypass`).
    // Optimistic on purpose: both routes below — the live switch and the respawn fallback —
    // land on exactly `mode`, and the respawn's own roster remap re-states it from the new
    // session a beat later.
    setSessionList((prev) => prev.map((m) => (m.id === sid ? { ...m, bypass: mode === 'bypass' } : m)));
    const s = sessions.current.get(sid);
    if (!s || s.kind !== 'chat') return;
    const cs = s as ChatSession;
    cs.setPermissionMode(mode, () => resumeChatSession(cs, mode === 'bypass'));
  }, [bus, vault, resumeChatSession]);

  // The chat banner's "Sign in", for the ACCOUNT this conversation runs on.
  //
  // `signInToClaude` above opens a plain shell, and a plain shell has no `CLAUDE_CONFIG_DIR`:
  // its `claude auth login` signs in the machine's own `~/.claude`. For a chat running on a
  // connected second account that is the wrong credential store, so the banner came straight
  // back however many times the user signed in (Faruk, Slack 2026-09-30). A connected account
  // signs in again through its own sandbox instead (`/agent/accounts/relogin`, browser OAuth,
  // no terminal needed), and the conversation resumes on it. The server answers
  // `primary_account` for the machine's own account, which keeps the terminal flow.
  const signInChatAccount = useCallback(async (cs?: ChatSession) => {
    if (cs) {
      try {
        await api.post('/agent/accounts/relogin', cs.accountId ? { id: cs.accountId } : {});
        resumeChatSession(cs);
        return;
      } catch (err) {
        if (!(err instanceof RequestError) || err.code !== 'primary_account') throw err;
      }
    }
    if (canSignInInApp) signInToClaude();
  }, [resumeChatSession, canSignInInApp, signInToClaude]);

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
      // The Develop session inherits NOTHING but the task file, so a plan that never reached
      // it is lost the moment this tab closes. Refuse while the task is missing a part the
      // Plan briefing requires (lib/handoff-readiness.ts on the server, the same check as
      // `dreamcontext tasks ready`). Fails OPEN on a failed request: the check is a guard on
      // the plan's completeness, and an unreachable guard must not strand a finished plan.
      try {
        const r = await scopedApi.get<{ ready: boolean; gaps: Array<{ field: string; problem: string }>; notes?: string[] }>(
          `/tasks/${encodeURIComponent(taskSlug)}/readiness`,
        );
        if (!r.ready) {
          // Never `alert()`: wry's WKWebView implements none of WebKit's JavaScript panel
          // methods, so in the desktop app an alert shows nothing and this button read as
          // dead (owner report 09-26). `confirmAction` works in every shell — and the refusal
          // gets a next step instead of a dead end: one click asks the planner to fill the gaps.
          const gaps = r.gaps.map((g) => `• ${g.field}: ${g.problem}`).join('\n');
          const askPlanner = await confirmAction({
            title: 'This plan is not ready for development yet',
            body: `The new session would start without:\n\n${gaps}\n\nAsk the planning agent to fill these into the task, then click the button again.`,
            confirmLabel: 'Ask the planner',
            cancelLabel: 'Close',
          });
          if (askPlanner) {
            // Waves are sub-tasks: a plan of two or more waves opens one per wave while it is
            // being fixed anyway (the readiness `notes` say when none exist yet).
            const waveNote = (r.notes ?? []).length > 0
              ? `\n\nAlso: ${(r.notes ?? []).join(' ')} Each wave is a sub-task carrying its own criteria and files, and the WAVE MAP names its slug.`
              : '';
            postToSession(cs, `The "Go to development" hand-off for \`${taskSlug}\` was refused — the task is missing:\n\n${gaps}\n\n`
              + `Fill each into the task with \`dreamcontext tasks insert ${taskSlug} <section> "…"\`, confirm \`dreamcontext tasks ready ${taskSlug}\` passes, then offer the develop button again.${waveNote}`);
          }
          return;
        }
      } catch (err) {
        console.warn('[agent-surface] Plan→Develop readiness check failed; handing off anyway:', err);
      }
      let prepared: { inline: string; token: string };
      try {
        prepared = await preparePrompt(vault, developKickoffPrompt(taskSlug));
      } catch (err) {
        // `mintPromptToken` rejects rather than degrading to an unseeded session (see its
        // doc). Say so instead of opening a Develop tab that has no idea what it is for.
        console.error('[agent-surface] Plan→Develop hand-off could not prepare its prompt:', err);
        void confirmAction({
          title: 'Could not open the development session',
          body: `${taskSlug}\n\n${err instanceof Error ? err.message : String(err)}`,
          confirmLabel: 'OK',
          cancelLabel: 'Close',
        });
        return;
      }
      const s = spawn(false, undefined, false, 'chat', prepared.inline, modelForSession(cs), true, prepared.token, false, effortForSession(cs), true, 'develop');
      const meta: SessionMeta = {
        // Opens under the task's name read as words, and `titleByAgent` lets the Develop agent
        // replace it with a real one — the slug alone (`her-ders-ve-program-…`) is unreadable
        // and, outside DEFAULT_TAB_TITLE_RE, used to be stuck there for good.
        id: s.id, title: cleanTabTitle(taskSlug) ?? taskSlug, titleByAgent: true, kind: 'chat', bypass: s.bypass, claudeId: s.claudeId, mode: 'develop',
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
  }, [spawn, vault, scopedApi, panes, activePaneId, closeSessionById, modelForSession, effortForSession]);

  // ChatPane's "Open in app ↗" (state 3 — a dreamcontext entity referenced from chat).
  // AgentSurface is mounted beside Shell (under `ProjectInstance`) with no direct handle on
  // Shell's navigation state, so this collapses the overlay and fires the event
  // `AgentPageNavBridge` listens for, which does the actual `nav.navigate()`.
  //
  // On the INSTANCE bus. `id` is a task/knowledge slug that means something in exactly one
  // vault: broadcast, every mounted project's bridge would navigate, and all but one would
  // be deep-linking to a slug that does not exist in their brain.
  const onOpenAppPage = useCallback((page: 'tasks' | 'knowledge' | 'core' | 'whiteboards', id: string) => {
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
    traceRespawn('openAgentInChat', 'begin', { from: sid, claudeId: meta.claudeId, detail: { dormant: meta.dormant } });
    try { sessions.current.get(sid)?.dispose(); } catch { /* best-effort */ }
    sessions.current.delete(sid);
    // `ReturnType<typeof spawn>`, deliberately, rather than naming either arm: this path
    // reads only `id`/`bypass`/`claudeId`, which both arms carry, and it converts a TERMINAL
    // session — spelling a chat type here would misfile it as a chat→chat respawn (the
    // bucketing `chat-draft-carry.test.ts` does, and it would then demand a draft carry that
    // a PTY readline cannot supply).
    let cs: ReturnType<typeof spawn>;
    try {
      cs = spawn(meta.bypass, meta.claudeId, true, 'chat');
    } catch (err) {
      traceRespawn('openAgentInChat', 'failed', { from: sid, claudeId: meta.claudeId, detail: { error: String(err) } });
      throw err;
    }
    traceRespawn('openAgentInChat', 'spawned', { from: sid, to: cs.id, claudeId: cs.claudeId });
    setSessionList((prev) => {
      traceRespawn('openAgentInChat', 'roster', { from: sid, to: cs.id, detail: { matched: prev.some((m) => m.id === sid), rosterIds: prev.map((m) => m.id) } });
      return prev.map((m) => (m.id === sid ? { ...m, id: cs.id, kind: 'chat' as const, bypass: cs.bypass, claudeId: cs.claudeId, dormant: false } : m));
    });
    setPanes((prev) => {
      traceRespawn('openAgentInChat', 'panes', { from: sid, to: cs.id, detail: { matched: prev.some((p) => p.tabs.includes(sid)) } });
      return prev.map((p) => ({
        ...p,
        tabs: p.tabs.map((t) => (t === sid ? cs.id : t)),
        active: p.active === sid ? cs.id : p.active,
      }));
    });
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
  const resumePastSession = useCallback((past: PastSession, reattach: '' | '1' | 'passive' = '') => {
    setHistoryOpen(false);
    setExpanded(true);
    // The Super Agent's conversation is never reopened as a tab: the hand-over button is its
    // only way in (plan-r7 D1, D9).
    if (past.id === superStateRef.current?.session) return;
    const existing = sessionList.find((m) => m.claudeId === past.id);
    if (existing) {
      if (existing.dormant) resumeSession(existing.id);
      else if (minimizedIds.includes(existing.id)) restoreMinimized(existing.id);
      else focusSession(existing.id);
      // Mac mode: a tab the other screen took over is taken back by the same tap.
      const live = sessions.current.get(existing.id) as { takenOver?: boolean; takeBack?: () => void } | undefined;
      if (reattach === '1' && live?.takenOver) live.takeBack?.();
      return;
    }
    // Resumed in the CURRENTLY chosen Agent screen, like every other resume path — the
    // transcript is the conversation, not the surface it was originally typed into. `reattach`
    // '1' (Mac mode's drawer): adopt the live chat even from the screen holding it.
    const s = reattach ? spawn(bypass, past.id, true, 'chat', '', '', true, '', false, '', false, DEFAULT_CHAT_MODE, '', '', reattach) : spawn(bypass, past.id, true, claudeKind);
    // Titled with the row's own label rather than "Chat 7": it is the only thing that tells two
    // resumed tabs apart. A remembered tab name (`named`) comes back whole — it was a tab title
    // once, and clipping it would also overwrite the stored name with its stub; a first prompt
    // is clipped. Either falls outside DEFAULT_TAB_TITLE_RE, so auto-titling leaves it alone.
    const title = !past.named && past.title.length > 34 ? `${past.title.slice(0, 33).trimEnd()}…` : past.title;
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

  // ── Mac mode: adopt a chat the Mac runs (the phone drawer's "Mac'te açık") ───────────
  const adoptLiveChat = useCallback((chat: LiveChatWire) => {
    resumePastSession({ id: chat.conversationId, title: chat.title || 'Chat', named: true, updatedAt: Date.now(), preview: '' } as unknown as PastSession, '1');
  }, [resumePastSession]);
  // The phone opens a handed-over Super Agent as an ordinary chat tab on its conversation. The
  // Mac decides it is a MIRROR (agent-chat.ts `phoneSuperOpen`): never `reattach=1`, so not even a
  // Mac that had stopped recognising the session would evict the window that holds it.
  const openSuperOnPhone = useCallback((row: SuperChatWire) => {
    rememberSuperMirrorIds([row.conversationId]);
    // The product's name, the same in every language (`handsfree.super.title`).
    resumePastSession({ id: row.conversationId, title: 'Super Agent', named: true, updatedAt: Date.now(), preview: '' } as unknown as PastSession, 'passive');
  }, [resumePastSession]);
  // A tap in another project's drawer parked the adoption for THIS project (macAdopt.ts):
  // taken once the roster has hydrated, so a restored tab of the same chat is reused.
  useEffect(() => {
    if (!vault || !isMacPhoneSurface()) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (!hydratedRef.current && tries < 25) return;
      clearInterval(timer);
      const pending = takePendingMacAdopt(vault);
      if (pending) adoptLiveChat(pending);
    }, 200);
    return () => clearInterval(timer);
  }, [vault, adoptLiveChat]);

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
    if (!canSpawn) return;
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
    if (!canSpawn) return;
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
    if (!canSpawn) return false;
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
    if (!canSpawn) return false;
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

  // ── Open one chat from a clicked link ("Claude is asking" banner) ─────────────────
  //
  // `dreamcontext://project/<vault>/session/<claudeId>` lands here (`ProjectInstance`'s
  // AppLinkBridge). It walks `resumePastSession`: a tab that holds the conversation comes
  // forward (restored from the dock, resumed if dormant), and only a conversation with no tab
  // is `--resume`d into a new one — never two live CLIs on one transcript.
  //
  // TAKEN AT ONCE, ACTED ON WHEN READY. A window built for this very link mounts the surface a
  // moment before its capabilities, its settings and the saved roster have loaded. Resuming
  // before the roster lands would open the conversation a second time beside the tab the
  // roster is about to restore, so a request that has no live tab yet waits (bounded) for all
  // three. The ACK is set on receipt so the sender stops asking.
  const [linkedSession, setLinkedSession] = useState<{ claudeId: string; since: number } | null>(null);
  const [, bumpLinkWait] = useReducer((x: number) => x + 1, 0);
  useInstanceEvent<OpenSessionDetail>(OPEN_SESSION_EVENT, (detail) => {
    if (!detail?.claudeId) return;
    // A notification tap opens THAT chat, past the phone's list (AC9 + AC21).
    setPhoneView('chat');
    // The handed-over Super Agent on the Mac (its reply's banner, its queue's alarm, a notch
    // row): open its stage. It is never a tab there, so a resume would fork it. The phone has
    // no stage and keeps opening the chat.
    if (!isMobile && !isMacPhoneSurface() && linkOpensSuperStage(detail.claudeId, superStateRef.current)) {
      setSuperView('super');
      setExpanded(true);
      detail.accepted = true;
      return;
    }
    setLinkedSession({ claudeId: detail.claudeId, since: Date.now() });
    detail.accepted = true;
  });
  useEffect(() => {
    if (!linkedSession) return undefined;
    const { claudeId, since } = linkedSession;
    const existing = sessionList.find((m) => m.claudeId === claudeId);
    // The super record too: a link to the handed-over Super Agent opens its stage, and only the
    // record says which session that is (a resume would fork it as a plain tab).
    const ready = caps !== null && settingsReady && hydratedRef.current && superKnownRef.current;
    if (!(existing && !existing.dormant) && !ready && Date.now() - since < LINKED_SESSION_WAIT_MS) {
      const timer = window.setTimeout(bumpLinkWait, LINKED_SESSION_POLL_MS);
      return () => window.clearTimeout(timer);
    }
    setLinkedSession(null);
    if (!isMobile && !isMacPhoneSurface() && linkOpensSuperStage(claudeId, superStateRef.current)) {
      setSuperView('super');
      setExpanded(true);
      return undefined;
    }
    if (!existing && !canSpawn) {
      console.warn('[app-link] cannot open chat', claudeId, 'here: the agent surface is unavailable');
      return undefined;
    }
    const past = { id: claudeId, title: '', preview: '', updatedAt: 0, startedAt: null, sizeBytes: 0, gitBranch: '' };
    // A hands-free phone (a notification tap): a chat still running on the Mac is ADOPTED, as
    // the drawer's "Open on Mac" does; a plain resume would displace the running process.
    if (isMacPhoneSurface() && !existing) {
      void api.get<LiveChatsWire>('/agent/live-chats')
        .then((r) => r.chats.find((c) => c.conversationId === claudeId))
        .catch(() => undefined)
        .then((live) => { if (live) adoptLiveChat(live); else resumePastSession(past); });
      return undefined;
    }
    resumePastSession(past);
    return undefined;
  }, [linkedSession, sessionList, caps, settingsReady, claudeReady, agentSettings.enabled, resumePastSession, adoptLiveChat, api]);

  // ── Start the initializer chat from the onboarding hand-off ("Start with Claude") ──
  //
  // `ProjectInstance`'s StartIntentBridge lands here with an intent that already passed
  // `acceptStartIntent` (only 'initializer', only this project, once per nonce). TAKEN AT ONCE,
  // ACTED ON WHEN READY, like the session link above: a window built for this intent mounts
  // the surface before its capabilities, settings and roster load, so the request waits
  // (bounded) for them, then starts ONE revealed chat through `delegateAgent`. A surface that
  // cannot start Claude here says so on the bus, and the bridge shows the visible notice.
  const { t } = useI18n();
  const [startIntentAt, setStartIntentAt] = useState<number | null>(null);
  // `startWaitTick` is a dependency below on purpose: readiness includes `hydratedRef`, a ref
  // that flips without a render, so only the tick re-runs the wait. Without it the first
  // "not ready yet" leaves the intent parked forever: no chat and no refusal notice.
  const [startWaitTick, bumpStartWait] = useReducer((x: number) => x + 1, 0);
  useInstanceEvent<StartChatIntentDetail>(START_CHAT_INTENT_EVENT, (detail) => {
    if (detail?.intent !== 'initializer') return;
    setStartIntentAt(Date.now());
    detail.accepted = true;
  });
  useEffect(() => {
    if (startIntentAt === null) return undefined;
    const loaded = caps !== null && settingsReady;
    const ready = loaded && hydratedRef.current;
    // Loaded and unable to spawn at all: refuse now rather than make the user wait out the bound.
    if (!ready && !(loaded && !canSpawn) && Date.now() - startIntentAt < START_INTENT_WAIT_MS) {
      const timer = window.setTimeout(bumpStartWait, LINKED_SESSION_POLL_MS);
      return () => window.clearTimeout(timer);
    }
    setStartIntentAt(null);
    const detail: DelegateAgentDetail = {
      title: t('onboarding.handoff.tabTitle'),
      prompt: initializerKickoffPrompt(),
      promptToken: '',
      bypass: false,
      model: '',
      reveal: true,
      accepted: false,
    };
    if (!delegateAgent(detail)) emitInstance(bus, START_CHAT_REFUSED_EVENT);
    return undefined;
  }, [startIntentAt, startWaitTick, caps, settingsReady, canSpawn, delegateAgent, t, bus]);

  // ── Train an automated agent (the Train button on its detail panel) ───────────────
  //
  // A NEW chat in Train Me mode whose first message binds it to the automation, so the
  // confirmed result lands in that automation's own playbook (`automations learn <slug>
  // --playbook-file`) rather than the project's knowledge/patterns. Always a chat: the
  // training rounds are AskUserQuestion cards, which only the chat transport draws.
  //
  // The ACK must be synchronous, and `preparePrompt` is async. The kickoff is a few hundred
  // characters, so it takes `preparePrompt`'s inline branch, and that branch is taken HERE
  // without awaiting: the spawn happens before the ACK is written. The token path is kept
  // for a pathological title only; there the ACK means "the guards passed" and a failed
  // mint is reported by its own dialog, the way the Develop hand-off reports one.
  const openTrainSession = useCallback((detail: TrainChatDetail): boolean => {
    if (!canSpawn) return false;
    const title = trainTabTitle(detail.automationTitle);
    const open = (inline: string, token: string) => {
      const s = spawn(bypass, undefined, false, 'chat', inline, '', true, token, false, '', false, 'train');
      setSessionList((prev) => [...prev, {
        id: s.id, title, kind: 'chat', bypass: s.bypass, claudeId: s.claudeId, mode: 'train',
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
      setExpanded(true);
    };
    const prompt = trainKickoffPrompt(detail.slug, detail.automationTitle);
    if (promptFitsInline(prompt)) {
      open(prompt, '');
      return true;
    }
    void preparePrompt(vault, prompt).then(
      (prepared) => open(prepared.inline, prepared.token),
      (err) => {
        console.error('[agent-surface] Train Me could not prepare its prompt:', err);
        void confirmAction({
          title: 'Could not open the Train Me session',
          body: `${detail.slug}\n\n${err instanceof Error ? err.message : String(err)}`,
          confirmLabel: 'OK',
          cancelLabel: 'Close',
        });
      },
    );
    return true;
  }, [caps, claudeReady, agentSettings.enabled, spawn, bypass, panes, activePaneId, vault]);

  useInstanceEvent<TrainChatDetail>(TRAIN_CHAT_EVENT, (detail) => {
    if (detail?.slug && openTrainSession(detail)) detail.accepted = true;
  });

  // ── Talk to an agent (the Agents page's "Talk to it") ─────────────────────────────
  //
  // `requestTalkToAgent` rings the window; the visible `ProjectInstance` re-emits it on THIS
  // bus (`lib/talkToAgent.ts`), so exactly one surface hears it. The act is the composer's
  // agent pick started from outside the composer: a NEW conversation bound to the agent
  // (`chatAgentBinding.ts`), never a respawn of one that exists, and never a chat mode (an agent
  // is who you talk to, the mode is how it works). The server decides approval and briefing
  // from the slug at spawn (`prepareAgentChat`), exactly as for a pick.
  //
  // TAKEN AT ONCE, ACTED ON WHEN READY, like the session link above: the ACK is written in the
  // listener so the sender stops asking, and the chat opens once caps, settings, the saved
  // roster and the agent list have loaded (bounded). The one refusal is a surface already known
  // unable to start Claude here: it leaves `accepted` false, so the sender says so instead of a
  // silent no-op.
  const [talkRequest, setTalkRequest] = useState<{ slug: string; since: number } | null>(null);
  const [talkWaitTick, bumpTalkWait] = useReducer((x: number) => x + 1, 0);
  const agentRoster = useAgents({ enabled: talkRequest !== null });
  useInstanceEvent<TalkToAgentDetail>(TALK_TO_AGENT_EVENT, (detail) => {
    if (!detail || typeof detail.slug !== 'string' || !detail.slug) return;
    if (caps !== null && settingsReady && !canSpawn) return;
    setTalkRequest({ slug: detail.slug, since: Date.now() });
    detail.accepted = true;
  });

  /** Open a new Chat tab speaking as `slug`, in the focused pane, and show it. */
  const openAgentChat = useCallback((slug: string, title: string): boolean => {
    if (!canSpawn) return false;
    const claudeId = newClaudeId();
    bindChatAgent(claudeId, slug);
    const s = spawn(false, claudeId, false, 'chat') as ChatSession;
    setSessionList((prev) => [...prev, {
      id: s.id, title, titleByAgent: true, kind: 'chat', bypass: s.bypass, claudeId, agent: slug,
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
    setExpanded(true);
    return true;
  }, [canSpawn, spawn, panes, activePaneId]);

  useEffect(() => {
    if (talkRequest === null) return undefined;
    const loaded = caps !== null && settingsReady;
    const ready = loaded && hydratedRef.current && !agentRoster.isLoading;
    if (!ready && !(loaded && !canSpawn) && Date.now() - talkRequest.since < START_INTENT_WAIT_MS) {
      const timer = window.setTimeout(bumpTalkWait, LINKED_SESSION_POLL_MS);
      return () => window.clearTimeout(timer);
    }
    setTalkRequest(null);
    // A name the roster does not know still opens: the chat then says why the server refused.
    const title = findAgent(agentRoster.data, talkRequest.slug)?.title ?? talkRequest.slug;
    if (!openAgentChat(talkRequest.slug, title)) {
      console.warn('[talk-to-agent] cannot open a chat with', talkRequest.slug, 'here: the agent surface is unavailable');
    }
    return undefined;
  }, [talkRequest, talkWaitTick, caps, settingsReady, canSpawn, agentRoster.isLoading, agentRoster.data, openAgentChat]);

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
    // `postToSession`, not `sendText` — the owner's "Submit sends the filled-in list back
    // as ONE message" means a real user turn, not a composer-draft append (`sendText` only
    // appends to the draft). That helper is the composer's ⏎ chain (steer the running turn,
    // queue only when it cannot land), shared with the transcript's secret and run cards.
    // A checklist is filled in WHILE the agent works and is answering the thing it is doing
    // right now — making it wait for the turn to end is the whole bug.
    postToSession(chat, payload.markdown);
    return true;
  }, [sessionList]);

  useEffect(() => {
    if (!vault) return;
    return listenForChecklistSubmits(vault, handleChecklistSubmit);
  }, [vault, handleChecklistSubmit]);

  // ── dreamcontext Assistant doorbell ────────────────────────────────────────────────
  // The notch rings this window when the Assistant acts on THIS project (chat / send /
  // answer / focus). The verbs live in `useAssistantDoorbell`; this surface only lends it
  // what it owns: the live sessions, a spawn that lands revealed, and the reveal itself.
  // Sessions resolve by conversation id through `sessionList`, like the checklist bridge.
  const windowChrome = useChrome();
  /** The Super Agent's own conversation, or (while handed over) one of its children. */
  const claudeIdIsSuperGuarded = (claudeId: string): boolean => {
    const st = superStateRef.current;
    if (!st) return sessionListRef.current.some((m) => m.claudeId === claudeId && m.mode === 'super');
    return claudeId === st.session || (st.enabled && hasOwnKey(st.children, claudeId))
      || sessionListRef.current.some((m) => m.claudeId === claudeId && m.mode === 'super');
  };
  const liveChatByClaudeId = (claudeId: string): ChatSession | null => {
    const entry = sessionList.find((m) => transportKind(m) === 'chat' && m.claudeId === claudeId);
    const session = entry ? sessions.current.get(entry.id) : undefined;
    return session && session.kind === 'chat' ? session as ChatSession : null;
  };
  useAssistantDoorbell({
    vault,
    findChat: (claudeId) => {
      // The Assistant never reaches into the Super Agent or, while handed over, its children
      // (plan-r7 D16: the server refuses too; this is the window's own re-check).
      if (claudeIdIsSuperGuarded(claudeId)) return null;
      return liveChatByClaudeId(claudeId);
    },
    // The owner's own Allow / Deny from the notch: a child's permission is his to give, never
    // the Super Agent's, so the guard above is not his (2026-10-22: "Couldn't reach").
    findOwnerChat: liveChatByClaudeId,
    openChat: (inline, token, mode) => {
      const s = spawn(false, undefined, false, 'chat', inline, '', true, token, false, '', false, mode, '', 'assistant');
      setSessionList((prev) => [...prev, { id: s.id, title: titleFor(s), kind: s.kind, bypass: s.bypass, claudeId: s.claudeId, mode }]);
      // Placement mirrors `delegateAgent`'s reveal branch: a tab of the focused pane.
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
      return s as ChatSession;
    },
    reveal: () => {
      if (vault) windowChrome.activate(vault);
      setExpanded(true);
    },
    openPage: (page, id) => {
      if (vault) windowChrome.activate(vault);
      onOpenAppPage(page, id);
    },
    closeChat: (claudeId) => {
      if (claudeIdIsSuperGuarded(claudeId)) return false;
      const entry = sessionList.find((m) => transportKind(m) === 'chat' && m.claudeId === claudeId);
      if (!entry) return false;
      closeSessionById(entry.id);
      return true;
    },
  });

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

  // The chat the owner is focused on, for the window's presence report (lib/focusedChat.ts):
  // the focused pane's visible tab, only while the surface is open on a desktop. Its id is the
  // conversation the chat was spawned on (`claudeId`), which the server's chat registry keys by.
  // Handed over, the Super Agent's stage is what he sees (`presenceChatId`).
  const focusedLive = liveSession(focusedSessionId);
  const focusedChatId = presenceChatId({
    expanded,
    isMobile,
    handedOver: superView === 'super' && !!superState?.enabled && !isMobile,
    superSession: superState?.session ?? null,
    focusedChat: focusedLive?.kind === 'chat' ? focusedLive.claudeId : null,
  }) ?? '';
  useEffect(() => {
    if (vault) setFocusedChat(vault, focusedChatId || null);
  }, [vault, focusedChatId]);
  useEffect(() => () => { if (vault) setFocusedChat(vault, null); }, [vault]);

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

  /**
   * Move a RUNNING conversation to another account.
   *
   * The picker LOOKS like the model picker beside it; its ACTION deliberately does not.
   * `setModel` is a live, in-process control request ("applies to the NEXT turn"); an account
   * is `CLAUDE_CONFIG_DIR`, read once at spawn, and no `set_account` control message exists.
   * Copying `setModel`'s shape here would have produced either a silent no-op or a respawn
   * hidden under a control that every sibling promises will not restart anything.
   *
   * So this reuses `changeChatMode`'s shape instead — the surface's existing "this change
   * needs a new process" path — and it restarts at the TURN BOUNDARY: a turn in flight was
   * authorized by the account it started on and is allowed to finish there.
   */
  const changeChatAccountFor = useCallback((sid: string, accountId: string) => {
    const cs = sessions.current.get(sid);
    if (!cs || cs.kind !== 'chat') return;
    const chat = cs as ChatSession;
    if ((chat.getModel().activeAccountId || chat.accountId) === accountId) return;  // picking the account you are on is not a restart
    if (chat.busy || chat.asking) {
      // Not silently dropped and not a mid-turn kill: the notice says the move is queued, and
      // `armAccountSwitch` is not involved — this is a deliberate user action, so it waits
      // here for the boundary the same way.
      const off = chat.subscribe(() => {
        if (sessions.current.get(chat.id) !== chat) { off(); return; }
        if (chat.busy || chat.asking) return;
        off();
        resumeChatRef.current?.(chat, undefined, accountId);
      });
      return;
    }
    resumeChatRef.current?.(chat, undefined, accountId);
  }, []);

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

  // ── Window control: the layout and actions a chat's own agent drives ──────────────
  // `dreamcontext window <verb>` from a chat in this surface lands here (windowVerbs.ts).
  // Rebuilt every render on purpose: a verb resolves tabs against the layout as it is NOW.
  const windowPlaceRef = useRef<(sid: string, split: boolean) => void>(() => {});
  windowPlaceRef.current = (sid, split) => {
    const pid = nextPaneId();
    if (panes.length === 0) {
      setPanes([{ id: pid, tabs: [sid], active: sid }]);
      setActivePaneId(pid);
    } else if (split) {
      const idx = panes.findIndex((p) => p.id === activePaneId);
      const at = idx < 0 ? panes.length : idx + 1;
      setPanes((prev) => { const next = [...prev]; next.splice(at, 0, { id: pid, tabs: [sid], active: sid }); return next; });
      setActivePaneId(pid);
    } else {
      const apid = panes.some((p) => p.id === activePaneId) ? activePaneId : panes[0].id;
      setPanes((prev) => prev.map((p) => (p.id === apid ? { ...p, tabs: [...p.tabs, sid], active: sid } : p)));
      setActivePaneId(apid);
    }
    setExpanded(true);
  };
  const changeChatModeRef = useRef(changeChatMode);
  changeChatModeRef.current = changeChatMode;
  windowDepsRef.current = (self: string): WindowVerbDeps => ({
    self,
    panes,
    activePaneId,
    // Never the Super Agent's session, and for a handed-over child never a sibling (D4b, the
    // browser's re-check of what the server already refuses).
    tabs: windowTabsFor(sessionList.map((m) => {
      const live = m.dormant ? undefined : sessions.current.get(m.id);
      const chat = live?.kind === 'chat' ? live as ChatSession : undefined;
      return {
        sid: m.id,
        tab: m.claudeId || m.id,
        title: m.title,
        kind: transportKind(m) === 'chat' ? 'chat' : m.kind,
        mode: chat?.mode ?? m.mode,
        model: sessionModel[m.id] || chat?.model || undefined,
        busy: !!live?.busy,
        asking: !!live?.asking,
        dormant: !live || live.status === 'closed',
      };
    }), {
      caller: superCallerOf(sessions.current.get(self)),
      self: sessions.current.get(self)?.claudeId ?? '',
      superSession: superState?.session ?? null,
      children: markedChildren(superState),
    }),
    openNew: async (o) => {
      let inline = '';
      let token = '';
      if (!o.terminal && o.prompt.trim() && vault) {
        const prepared = await preparePrompt(vault, o.prompt);
        inline = prepared.inline;
        token = prepared.token;
      }
      const s = o.terminal
        ? spawn(false, undefined, false, 'shell')
        : spawn(false, undefined, false, 'chat', inline, o.model, true, token, false, o.effort, false, o.mode);
      setSessionList((prev) => [...prev, {
        id: s.id, title: titleFor(s), kind: s.kind, bypass: s.bypass, claudeId: s.claudeId,
        ...(s.kind === 'chat' ? { mode: o.mode } : {}),
      }]);
      // Placed against the layout as it is when the spawn lands (the prompt prep awaited).
      windowPlaceRef.current(s.id, o.split);
      return s.claudeId;
    },
    split: (sid, paneId) => dropToZone(paneId, 'right', sid),
    join: (sid, paneId) => combineIntoPane(sid, paneId),
    focus: (sid, paneId) => { setExpanded(true); selectTab(paneId, sid); },
    setMode: (sid, mode) => {
      const chat = sessions.current.get(sid) as ChatSession | undefined;
      if (!chat || !(chat.busy || chat.asking)) { changeChatModeRef.current(sid, mode); return 'now'; }
      // Never mid-turn: the agent that asked is usually the one running this turn. The
      // respawn waits for the boundary, the way an account move does.
      const off = chat.subscribe(() => {
        if (sessions.current.get(chat.id) !== chat) { off(); return; }
        if (chat.busy || chat.asking) return;
        off();
        changeChatModeRef.current(chat.id, mode);
      });
      return 'after-turn';
    },
    setModel: (sid, model) => {
      if (!liveChat(sid)) return false;
      changeChatModelFor(sid, model);
      return true;
    },
    setEffort: (sid, level) => {
      if (!liveChat(sid)) return false;
      changeChatEffortFor(sid, level);
      return true;
    },
    send: (sid, text) => {
      const chat = liveChat(sid);
      if (!chat) return false;
      // Busy: into the running turn (the composer's ⏎); only an open question/permission card
      // makes it wait (`deliverToChat`).
      return deliverToChat(chat, text);
    },
    close: (sid) => closeSessionById(sid),
  });

  // ── The Super Agent: who is who ───────────────────────────────────────────────────
  // Which of this window's chats a window verb comes from (D4b's browser re-check).
  function superCallerOf(s: Session | ChatSession | undefined): SuperCaller {
    if (!s || s.kind !== 'chat') return 'other';
    const cs = s as ChatSession;
    if (cs.mode === 'super' || (!!superState?.session && cs.claudeId === superState.session)) return 'super';
    return markedChildren(superState).has(cs.claudeId) ? 'child' : 'other';
  }
  superWindowGuardRef.current = (cs, verb, args) => {
    const caller = superCallerOf(cs);
    // The Super Agent's window verbs into a child (`super send`, `super update`): resolve the
    // tab it names by sid OR pin id, and hand the re-check all three ids (sid, pin, live conversation).
    let target: SuperSendTarget | null = null;
    if (caller === 'super' && (SUPER_CHILD_VERBS as readonly string[]).includes(verb) && typeof args.tab === 'string' && args.tab) {
      const meta = sessionList.find((m) => m.id === args.tab || m.claudeId === args.tab);
      const live = meta && !meta.dormant ? sessions.current.get(meta.id) : undefined;
      if (meta) target = { sid: meta.id, pin: meta.claudeId, conversation: live && live.kind === 'chat' ? live.claudeId : null };
    }
    return superWindowRefusal(caller, verb, !!superState?.enabled, {
      target, superSession: superState?.session ?? null, children: markedChildren(superState),
    });
  };
  // The Super Agent's session in this window (its roster entry carries the recorded id).
  const superMeta = sessionList.find((m) => !!superState?.session && m.claudeId === superState.session)
    ?? sessionList.find((m) => m.mode === 'super');
  const superSid = superMeta?.id ?? null;
  const superChatSession = superSid ? sessions.current.get(superSid) as ChatSession | undefined : undefined;
  // The record's children plus the ones this window just opened for a `delegate` (D16).
  const marked = childMarks(superState, superDelegated, Date.now()).marked;
  const handedOver = superView === 'super' && !!superState && !isMobile;
  // Web containers hold a frame only while the window can be seen (webBudget.ts).
  const windowActivity = useWindowActivity();
  // The tabs a hand-over cannot adopt: terminals, in their own row.
  const superTerminals: TerminalRowItem[] = terminalTabs(sessionList.map((m) => ({
    id: m.id, claudeId: m.claudeId, title: m.title, kind: transportKind(m) ?? m.kind, mode: m.mode, dormant: m.dormant,
  }))).map((tab) => {
    const s = sessions.current.get(tab.id);
    return {
      id: tab.id, title: tab.title, kind: tab.kind,
      status: deriveSessionStatus({ dormant: tab.dormant, status: s?.status, busy: s?.busy, asking: s?.asking }).kind,
    };
  });
  /** A child's live chat by its pin id (the record names children by it). */
  const chatByClaudeId = useCallback((claudeId: string): ChatSession | undefined => {
    const entry = sessionListRef.current.find((m) => m.claudeId === claudeId && !m.dormant);
    const s = entry ? sessions.current.get(entry.id) : undefined;
    return s && s.kind === 'chat' ? s as ChatSession : undefined;
  }, []);
  // The super chat draws the Super Agent's questions to the owner as cards (superQuestions.ts,
  // owner 2026-10-21 "soruyu hep chatta sorsun"). They read the record's open questions from
  // here, where the record lives whether or not the stage is up; no live record = static cards.
  const superQuestionSid = superState?.enabled ? superState.session : null;
  const superQueue = superState?.queue;
  const openSuperQuestions = useMemo(() => openOwnerQuestions(superQueue ?? []), [superQueue]);
  // Keyed on what a card draws, including whether a child's chat is live here (its options
  // come from it): the super chat's pane is memoised, so only a key change re-renders a card.
  const superQuestionKey = openSuperQuestions
    .map((q) => [q.id, q.state, q.requestId ?? '', q.ownerText ?? '', (q.options ?? []).join('\u0002'), q.kind === 'question' ? chatByClaudeId(q.sessionId)?.id ?? '' : ''].join('\u0003'))
    .join('\u0001');
  const publishedQuestionSid = useRef<string | null>(null);
  useEffect(() => {
    const prev = publishedQuestionSid.current;
    if (prev && prev !== superQuestionSid) publishSuperQuestions(prev, null);
    publishedQuestionSid.current = superQuestionSid;
    // Forget the answer latches of items the record no longer asks for (never during a render).
    if (superQueue && superState?.session) trimOwnerAnswers(superState.session, new Set(superQueue.filter(needsOwner).map((q) => q.id)));
    if (!superQuestionSid) return;
    publishSuperQuestions(
      superQuestionSid,
      { open: openSuperQuestions, superSession: superChatSession, sessionFor: chatByClaudeId },
      `${superQuestionKey}\u0004${superChatSession?.id ?? ''}`,
    );
  }, [superQuestionSid, superQuestionKey, superQueue, superState?.session, openSuperQuestions, superChatSession, chatByClaudeId]);
  // Withdrawn with this surface (a project going cold): no card keeps a dead session.
  useEffect(() => () => {
    if (publishedQuestionSid.current) publishSuperQuestions(publishedQuestionSid.current, null);
  }, []);
  // The alarm for what the owner must answer: chime, Dock bounce, banner and the tab's attention,
  // exactly what any agent's question raises (chatSession.ts), once for EVERY item as it arrives
  // (`headAlarmOnce`), never only for the queue's head. Owner 2026-10-22: "normal agent sorusu
  // gibi bildirim MUTLAKA gelir": a normal agent's question rings whatever else is open, while a
  // super question behind an open child question or permission rang nothing until it reached the
  // head. Raised HERE, where the record lives whether or not the Super stage is up.
  const superOwnerItems = useMemo(() => (superState?.enabled ? superState.queue.filter(needsOwner).sort((a, b) => a.createdAt - b.createdAt) : []), [superState]);
  const superBannered = superState?.bannered;
  useEffect(() => {
    if (!vault) return;
    const fresh = superOwnerItems.filter((q) => headAlarmOnce(vault, q));
    if (!fresh.length) return;
    // One ring for what arrived together; the newest item speaks for it.
    const item = fresh[fresh.length - 1];
    raiseAskAttention({
      // A banner the server posted for it (owner-question.ts) is not posted twice.
      banner: !(superBannered ?? []).includes(item.id),
      source: vault,
      detail: item.kind === 'permission' ? t('super.queue.permissionAlarm')
        : item.kind === 'approval' ? t('super.queue.approval').replace('{name}', item.member ?? '')
          : (item.ownerText ?? t('super.queue.escalatedAlarm')),
      sessionId: superChatSession?.claudeId ?? null,
    });
    if (superChatSession && !superChatSession.attention && fresh.some((q) => q.kind !== 'permission')) {
      superChatSession.attention = true;
      bumpStatus();
    }
  }, [superOwnerItems, superBannered, vault, superChatSession, t, bumpStatus]);
  const superTitleFor = useCallback((claudeId: string): string => {
    const st = superStateRef.current;
    const brief = st && hasOwnKey(st.children, claudeId) ? st.children[claudeId].brief : '';
    if (brief) return brief;
    return sessionListRef.current.find((m) => m.claudeId === claudeId)?.title ?? claudeId.slice(0, 8);
  }, []);
  // The agenda names a job by its tab title (the brief, what it does now, is its second line).
  const superNameFor = useCallback((claudeId: string): string => (
    sessionListRef.current.find((m) => m.claudeId === claudeId)?.title ?? ''
  ), []);
  // The owner looked at finished jobs in the agenda: the server's answer is the new record; a
  // refusal rejects and the rows stay new (no optimistic flip).
  // ── First paint after a reload: the record, once. Afterwards only pushes. ──────────
  const capsLoaded = caps !== null;
  useEffect(() => {
    // Known: no record to wait for (no desktop, a phone), or the GET answered (a failed one
    // too: an unread record must not hold a question for ever). Held alarms are released.
    const settle = () => {
      superKnownRef.current = true;
      const marked = markedChildren(superStateRef.current);
      sessions.current.forEach((s) => { if (s.kind === 'chat') (s as ChatSession).setSuperChild(marked.has(s.claudeId)); });
    };
    if (!capsLoaded) return undefined;
    if (!caps?.desktop || isMacPhoneSurface()) { settle(); return undefined; }
    let cancelled = false;
    void fetchSuperState(scopedApi).then((st) => {
      if (cancelled) return;
      // A push that landed first is newer; never overwrite it with the GET.
      if (st) superStateRef.current = superStateRef.current ?? withPendingEdits(st);
      settle();
      if (!st) return;
      setSuperState((prev) => prev ?? withPendingEdits(st));
      if (st.enabled) setSuperView('super');
    });
    return () => { cancelled = true; };
  }, [capsLoaded, caps?.desktop, scopedApi]);

  // ── The Super Agent's own chat: opened (or re-bound) whenever the mode is on ────────
  // Kind chat, mode `super`, pin = the recorded session. Resumed (`--resume`) unless the
  // hand-over that minted it is the one asking, which starts it under that id. It follows the
  // vault's permission switch like any chat (decision 14): `spawn`'s chat arm resolves it.
  const superFreshRef = useRef<string | null>(null);
  const ensureSuperSession = useCallback((session: string): ChatSession | null => {
    const open = sessionListRef.current.find((m) => m.claudeId === session);
    if (open) {
      const live = sessions.current.get(open.id);
      return live && live.kind === 'chat' ? live as ChatSession : null;
    }
    if (!canSpawn) return null;
    const fresh = superFreshRef.current === session;
    superFreshRef.current = null;
    // Its own default model and effort (Settings -> Chat -> Super Agent; Opus at high unless the
    // owner saved another pair), never the chat default. A hand-over's successor opens here too.
    const { superModel, superEffort } = agentSettingsRef.current;
    const s = spawn(false, session, !fresh, 'chat', '', superModel, true, '', false, superEffort, false, 'super') as ChatSession;
    // Registered in the roster (so it is portaled and homed) but NEVER in a pane.
    const meta: SessionMeta = { id: s.id, title: 'Claude', kind: 'chat', bypass: s.bypass, claudeId: session, mode: 'super' };
    sessionListRef.current = [...sessionListRef.current, meta];
    setSessionList((prev) => (prev.some((m) => m.claudeId === session) ? prev : [...prev, meta]));
    return s;
  }, [canSpawn, spawn]);
  useEffect(() => {
    if (superState?.enabled && superState.session && canSpawn) ensureSuperSession(superState.session);
  }, [superState?.enabled, superState?.session, canSpawn, ensureSuperSession]);

  // ── What the server pushes down the Super Agent's socket ───────────────────────────
  superSignalRef.current = (signal) => {
    if (signal.kind !== 'state') return;
    const st = readSuperStateView(signal.state);
    if (st) setSuperState(withPendingEdits(st));
  };

  // ── Mark the children (D16): no alarm, no badge, no project-chip `waiting` ──────────
  // A child just opened for a `delegate` stays marked until the record names it, its mark runs
  // out (the server never recorded it), or the mode goes off — never unmarked in between.
  useEffect(() => {
    const now = Date.now();
    const marks = childMarks(superState, superDelegated, now);
    if (marks.delegated.size !== superDelegated.size) { setSuperDelegated(marks.delegated); return undefined; }
    const set = marks.marked;
    // Before the record is read nobody knows who is a child: the alarm keeps waiting (`settle`
    // in the first-paint GET releases it), never an early "not a child" from an empty record.
    const known = superKnownRef.current || !!superState;
    sessions.current.forEach((s) => {
      if (s.kind === 'chat') (s as ChatSession).setSuperChild(known ? set.has(s.claudeId) : null);
    });
    if (marks.nextExpiry === null) return undefined;
    const timer = setTimeout(() => setSuperDelegated((prev) => {
      const next = childMarks(superStateRef.current, prev, Date.now()).delegated;
      return next.size === prev.size ? prev : next;
    }), Math.max(0, marks.nextExpiry - now) + 50);
    return () => clearTimeout(timer);
  }, [superState, sessionList, superDelegated]);

  // ── Ended children never come back as tabs (`super end`) ──────────────────────────
  // `super end` closes a live child's tab itself (the park frame's `end`). A child ended while
  // no window held it (drained), or restored dormant by a relaunch before the record arrived,
  // still has a DORMANT roster entry: closed here once the record names it ended. A live tab is
  // never touched (the owner reopened it from Past chats: his to keep).
  useEffect(() => {
    const ended = endedChildIds(superState);
    if (!ended.size) return;
    for (const m of sessionList) {
      if (m.dormant && m.claudeId && ended.has(m.claudeId)) closeSessionById(m.id);
    }
  }, [superState, sessionList, closeSessionById]);

  // ── The owner-activity lease: one POST per 5 s at most, and only while typing ─────────
  useEffect(() => {
    // Only while handed over; the pending trailing post dies with take-back or the unmount.
    if (!superState?.enabled) return undefined;
    const lease = createActivityLease(() => { void postSuperActivity(scopedApi).catch(() => undefined); });
    superLeaseRef.current = lease;
    return () => {
      lease.dispose();
      if (superLeaseRef.current === lease) superLeaseRef.current = null;
    };
  }, [scopedApi, superState?.enabled]);

  // ── The return recap (D13): back after ≥ 10 min away, while handed over ────────────
  useEffect(() => {
    if (!superState?.enabled) return undefined;
    return onWindowActivity((next, prev, change) => {
      if (shouldRecap(prev.focused, next.focused, change.unfocusedMs, !!superStateRef.current?.enabled)) {
        void postSuperRecap(scopedApi).catch(() => undefined);
      }
    });
  }, [superState?.enabled, scopedApi]);

  // ── The Super Agent's window-side verbs (`super delegate`, `super answer`) ───────────
  // The server already checked the caller, the cap and (for answer) the child's pending
  // request; the window re-checks what only it can see and does the work the way the owner's
  // own click would.
  superCommandRef.current = async ({ verb, args }) => {
    const st = superStateRef.current;
    if (!st?.enabled) return { ok: false, error: 'not_handed_over' };
    if (verb === 'delegate') {
      // Past the server's deadline: open NO child (the server would never record it).
      if (delegateExpired(args)) return { ok: false, error: 'expired' };
      const d = delegateArgs(args);
      if (!d.ok) return d;
      if (!canSpawn || !vault) return { ok: false, error: 'cannot_spawn' };
      const prepared = await preparePrompt(vault, d.prompt);
      // …checked again after the prompt is prepared: that wait can be what ran past it.
      if (delegateExpired(args)) return { ok: false, error: 'expired' };
      // Follows the vault's permission switch like any chat (decision 13): no explicit bypass.
      const childId = newClaudeId();
      leanOpeningRef.current.set(childId, d.mcp);
      const s = spawn(false, childId, false, 'chat', prepared.inline, d.model, true, prepared.token, false, d.effort, false, d.mode) as ChatSession;
      s.setSuperChild(true);
      // …and it STAYS marked until the server's push names it (the mark effect would otherwise
      // unmark it on the next roster change, before the push lands).
      const markUntil = delegateMarkUntil(args);
      setSuperDelegated((prev) => new Map(prev).set(s.claudeId, markUntil));
      setSessionList((prev) => [...prev, {
        id: s.id, title: d.title || titleFor(s), kind: 'chat', bypass: s.bypass, claudeId: s.claudeId,
        ...(d.mode !== DEFAULT_CHAT_MODE ? { mode: d.mode } : {}),
      }]);
      // A NON-active tab of the active pane (D5): take-back shows the owner's layout + it. With
      // no pane at all it gets one (the "keep activePaneId real" effect then points at it).
      setPanes((prev) => placeDelegatedChild(prev, activePaneId, s.id, nextPaneId).panes);
      return { ok: true, result: { sessionId: s.claudeId } };
    }
    if (verb === 'answer') {
      const child = typeof args.child === 'string' ? args.child : '';
      const requestId = typeof args.requestId === 'string' ? args.requestId : '';
      if (!hasOwnKey(st.children, child)) return { ok: false, error: 'not_a_child' };
      const cs = chatByClaudeId(child);
      if (!cs) return { ok: false, error: 'child_not_open' };
      // Only an AskUserQuestion card — never a permission, never a plan approval.
      const q = cs.getModel().pending.find((p): p is PendingQuestion => p.kind === 'question' && p.requestId === requestId);
      if (!q) return { ok: false, error: 'no_such_question' };
      const choices = Array.isArray(args.choices) ? args.choices.filter((c): c is string => typeof c === 'string') : [];
      const picks = superAnswerPicks(q.questions, choices, typeof args.text === 'string' ? args.text : undefined);
      if (!picks.ok) return picks;
      // Exactly what the child's own card sends (`answerQuestion` builds the load-bearing
      // `{questions, answers}` shape).
      // Not written (the child's socket is down): the card is still pending, and saying so is
      // the honest answer — never report an answer nobody received.
      if (!cs.answerQuestion(requestId, q.questions, picks.picked, picks.notes)) return { ok: false, error: 'not_connected' };
      return { ok: true };
    }
    if (verb === 'resume') {
      // `super resume <child>`: the same conversation (`--resume <id>`), as a child again. A
      // parked tab resumes in place; an ended child (no tab) gets a new one, opened like a
      // delegate's. A child already running is only reported.
      const child = typeof args.child === 'string' ? args.child : '';
      if (!hasOwnKey(st.children, child) || child === st.session) return { ok: false, error: 'not_a_child' };
      const existing = sessionListRef.current.find((m) => m.claudeId === child);
      if (existing && !existing.dormant) return { ok: true, result: { sessionId: child, running: true } };
      if (!canSpawn || !vault) return { ok: false, error: 'cannot_spawn' };
      setSuperDelegated((prev) => new Map(prev).set(child, Date.now() + DELEGATE_MARK_GRACE_MS));
      if (existing) {
        // A parked tab comes back exactly as it was parked (`resumeSession`): say so, so the
        // record holds what runs, not the request.
        const p = existing.parked?.transport === 'chat' ? existing.parked : undefined;
        resumeSession(existing.id);
        return { ok: true, result: { sessionId: child, mode: (p && existing.mode) || DEFAULT_CHAT_MODE, model: p?.model ?? '', effort: p?.effort ?? '' } };
      }
      const r = delegateArgs({ prompt: '-', mode: args.mode, model: args.model, effort: args.effort, title: args.title });
      if (!r.ok) return r;
      const s = spawn(false, child, true, 'chat', '', r.model, true, '', false, r.effort, false, r.mode) as ChatSession;
      s.setSuperChild(true);
      setSessionList((prev) => [...prev, {
        id: s.id, title: r.title || titleFor(s), kind: 'chat', bypass: s.bypass, claudeId: s.claudeId,
        ...(r.mode !== DEFAULT_CHAT_MODE ? { mode: r.mode } : {}),
      }]);
      setPanes((prev) => placeDelegatedChild(prev, activePaneId, s.id, nextPaneId).panes);
      return { ok: true, result: { sessionId: child, mode: r.mode, model: r.model, effort: r.effort } };
    }
    return { ok: false, error: 'unknown_verb' };
  };

  // ── The layout the owner edits: a drop, Others, side by side, minimize, close (F3, §0 C3) ──
  // Applied at once (optimistic) and kept on top of every push until the server's state
  // carries it, so a push that left before the POST landed never snaps the card back.
  const editSuperLayout = useCallback((patch: LayoutPatch) => {
    pendingPatchesRef.current = [...pendingPatchesRef.current, patch];
    setSuperState((prev) => (prev ? applyLayoutPatch(prev, patch) : prev));
    const settle = () => { pendingPatchesRef.current = pendingPatchesRef.current.filter((p) => p !== patch); };
    // A save that did not land never stays on screen as if it had (end review r8): the patch
    // goes and the record is read again, so the card returns to where the server has it. A
    // server that is down pushes the record itself when the socket comes back.
    const notSaved = (why: unknown) => {
      settle();
      console.warn('[super] the layout was not saved:', why);
      void fetchSuperState(scopedApi).then((st) => { if (st) setSuperState(withPendingEdits(st)); });
    };
    // A look changes nothing on the stage: its answer (read before the server's lock, every 30 s
    // while a panel is open) must never paint over a newer push.
    const lookOnly = Object.keys(patch).every((k) => k === 'touch');
    void postSuperLayout(scopedApi, patch).then(
      (st) => { if (!st) { notSaved('no state in the answer'); return; } settle(); if (!lookOnly) setSuperState(withPendingEdits(st)); },
      notSaved,
    );
  }, [scopedApi]);

  // O11: a card dropped on the centre (or its "Ask about this") becomes the subject of the
  // owner's next message: a reference appended to the Super Agent's draft once, focused.
  // Nothing is written to the record; nothing happens while the Super Agent is dormant.
  // ── The owner ends a child from its card (owner 2026-10-21) ─────────────────────────
  // His own click, so the tab closes here the way his close does (an adopted or running chat is
  // his to end) and the server records it ended like `super end`: card gone, no relaunch brings
  // the tab back, the transcript stays. "End when done" waits for the turn to end first.
  const [endPending, setEndPending] = useState<ReadonlySet<string>>(new Set());
  // Children whose end the server did not record: still running, and the card says so.
  const [endFailed, setEndFailed] = useState<ReadonlySet<string>>(new Set());
  const without = (set: ReadonlySet<string>, child: string): ReadonlySet<string> => {
    if (!set.has(child)) return set;
    const next = new Set(set);
    next.delete(child);
    return next;
  };
  // Recorded FIRST, closed after: the record takes the child out of the event index, so its
  // exit raises no `gone` turn, and a record that fails leaves the chat running, never a dead
  // process the record still calls a child.
  const endingRef = useRef<Set<string>>(new Set());
  const endChildNow = useCallback((child: string) => {
    setEndPending((prev) => without(prev, child));
    setEndFailed((prev) => without(prev, child));
    if (endingRef.current.has(child)) return;
    endingRef.current.add(child);
    void postSuperEnd(scopedApi, child).then((st) => {
      if (!st) throw new Error('no state in the answer');
      setSuperState(withPendingEdits(st));
      const meta = sessionListRef.current.find((m) => m.claudeId === child);
      if (meta) closeSessionById(meta.id);
    }).catch((err: unknown) => {
      console.warn('[super] the child was not ended:', err);
      setEndFailed((prev) => new Set(prev).add(child));
    }).finally(() => { endingRef.current.delete(child); });
  }, [closeSessionById, scopedApi]);
  const endChildFromCard = useCallback((child: string, whenDone: boolean) => {
    const s = chatByClaudeId(child);
    if (whenDone && s?.hasLiveWork()) {
      setEndFailed((prev) => without(prev, child));
      setEndPending((prev) => new Set(prev).add(child));
      return;
    }
    endChildNow(child);
  }, [chatByClaudeId, endChildNow]);
  // "Move to Others" after "End when done": the owner's latest word keeps it running.
  const keepChildRunning = useCallback((child: string) => {
    setEndPending((prev) => without(prev, child));
    setEndFailed((prev) => without(prev, child));
  }, []);
  useEffect(() => {
    if (!endPending.size) return undefined;
    const tick = setInterval(() => {
      for (const child of endPending) {
        const s = chatByClaudeId(child);
        if (!s || !s.hasLiveWork()) endChildNow(child);
      }
    }, 1_000);
    return () => clearInterval(tick);
  }, [endPending, chatByClaudeId, endChildNow]);

  const askAboutCard = useCallback((id: string, title: string) => {
    const cs = superChatRef.current;
    if (!cs || cs.status === 'closed') return;
    cs.sendText(cardReference(id, title, cs.getModel().draft));
    requestAnimationFrame(() => cs.focus());
  }, []);

  /**
   * Inspect picked an element in a web card's page (owner 2026-10-22: "the selected component
   * should reach the composer, so I can comment on that spot"): a removable chip in the Super
   * Agent's composer carrying the element's block; its picture is uploaded like a pasted image
   * and joins the block once it lands. Several picks, several chips.
   */
  const pickElementFromCard = useCallback((id: string, pick: WebPick, page: string) => {
    const cs = superChatRef.current;
    if (!cs || cs.status === 'closed') return;
    const convId = cs.scratchId || cs.claudeId;
    if (!convId) return;
    const card = superStateRef.current?.containers.find((c) => c.id === id);
    const att = nextAttachmentId();
    const blob = pick.crop ? dataUrlBlob(pick.crop) : null;
    addAttachments(convId, [{
      id: att, kind: 'element', name: pickChipName(pick), text: pickBlock(pick, { id, title: card?.title || card?.ref || id }, page),
      ...(pick.crop ? { url: pick.crop } : {}), ...(blob ? { uploading: true } : {}),
    }]);
    if (blob) {
      const job = uploadAgentFile(vault, blob, `element-${pick.tag}.${blob.type === 'image/jpeg' ? 'jpg' : 'png'}`).then((path) => settleAttachment(convId, att, path));
      // A send right after the pick waits for the picture (the composer awaits it).
      trackUpload(convId, job);
    }
  }, [vault]);

  /**
   * "Write about this" on an agenda line (owner 2026-10-23): the line drops into the Super
   * Agent's composer as ONE About chip (a second press replaces it), the draft untouched and the
   * caret in the box. The message he sends opens with the line's block (`agendaAboutBlock`).
   */
  const writeAboutRow = useCallback((row: AgendaRow) => {
    const cs = superChatRef.current;
    if (!cs || cs.status === 'closed') return;
    const convId = cs.scratchId || cs.claudeId;
    const text = agendaAboutBlock(row);
    if (!convId || !text) return;
    const words = { about: t('super.agenda.about'), question: t('super.agenda.aboutQuestion'), superQuestion: t('super.agenda.aboutSuperQuestion'), aQuestion: t('super.agenda.aboutAQuestion') };
    setAbout(convId, { id: nextAttachmentId(), kind: 'about', name: agendaAboutChipName(row, words), text });
    requestAnimationFrame(() => cs.focus());
  }, [t]);

  // ── The hand-over and the take-back, with their flights (D17, D18) ─────────────────
  const flightLayerRef = useRef<HTMLDivElement | null>(null);
  const flightRunRef = useRef<{ run: FlightRun; dir: 'in' | 'out'; focusSid?: string } | null>(null);
  const reverseQueuedRef = useRef(false);
  const flightReqRef = useRef<{ dir: 'in' | 'out'; first: Map<string, { role: FlightRole; rect: Rect }>; focusSid?: string } | null>(null);
  const [flightNonce, bumpFlight] = useReducer((x: number) => x + 1, 0);
  const rectOf = (el: Element | null | undefined): Rect | null => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };
  const q$ = (sel: string): HTMLElement | null => hostRef.current?.querySelector<HTMLElement>(sel) ?? null;
  const esc = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, ''));
  /** Where a child's card is on the stage: its card, or the Others stack it is drawn in. */
  const containerElOf = (claudeId: string): HTMLElement | null => {
    const c = superStateRef.current?.containers.find((x) => x.kind === 'chat' && x.ref === claudeId);
    if (!c) return null;
    return q$(`.super-card-frame[data-container-id="${esc(c.id)}"]`) ?? q$('[data-testid="super-others"]');
  };
  /** Where a child sits among the panes: the active pane's slot when it is that pane's visible
   *  tab, else its tab chip. */
  const paneRectOf = (sid: string): { role: FlightRole; rect: Rect | null } => {
    const ap = panes.find((p) => p.id === activePaneId) ?? panes[0];
    if (ap && ap.active === sid) return { role: 'pane', rect: rectOf(q$(`.agent-pane-slot[data-pane="${esc(ap.id)}"]`)) };
    return { role: 'chip', rect: rectOf(q$(`.agent-tab[data-sid="${esc(sid)}"]`)) };
  };
  const sidOfClaude = (claudeId: string) => sessionListRef.current.find((m) => m.claudeId === claudeId)?.id ?? '';

  const handOver = useCallback(async () => {
    const live = flightRunRef.current;
    if (live?.run.active) { live.run.reverse(); return; }
    // Pressed again while the hand-over request is still out: the flight reverses the moment it
    // starts (a slow server must not swallow the owner's "no, back").
    if (superBusyRef.current) { reverseQueuedRef.current = !reverseQueuedRef.current; return; }
    reverseQueuedRef.current = false;
    superBusyRef.current = true;
    setSuperBusy(true);
    try {
      const before = superStateRef.current;
      // Every open chat of the project (minimized ones included), never the Super Agent.
      const tabs: HandoverTab[] = sessionListRef.current.map((m) => {
        const s = sessions.current.get(m.id);
        return {
          id: m.id,
          claudeId: s?.claudeId ?? m.claudeId,
          title: m.title,
          kind: transportKind(m) === 'chat' ? 'chat' : m.kind,
          mode: s?.kind === 'chat' ? (s as ChatSession).mode : m.mode,
          dormant: m.dormant || !s || s.status === 'closed',
        };
      });
      const body = adoptionBody(tabs, before?.session);
      // FIRST rects, in ONE batch, before anything changes.
      const first = new Map<string, { role: FlightRole; rect: Rect }>();
      for (const cid of body.adopt) {
        const at = paneRectOf(sidOfClaude(cid));
        if (isVisibleRect(at.rect)) first.set(`child:${cid}`, { role: at.role, rect: at.rect });
      }
      const strip = rectOf(q$('.agent-overlay-tabs'));
      if (isVisibleRect(strip)) first.set('strip', { role: 'strip', rect: strip });
      const btn = rectOf(q$('[data-testid="super-handover-btn"]'));
      if (isVisibleRect(btn)) first.set('centre', { role: 'centre', rect: btn });
      setSuperWidth(hostRef.current?.clientWidth ?? 0);

      // A late `disable` from an earlier take-back must not land on top of this hand-over.
      const gen = superGenRef.current.begin();
      const { session, state } = await enableSuper(scopedApi, body);
      // Minted by THIS hand-over (the record knew none, or another): start it under that id.
      if (before && before.session !== session) superFreshRef.current = session;
      ensureSuperSession(session);
      const st = state ?? (before ? { ...before, session, enabled: true } : null);
      const landing = new Set<string>(['centre']);
      for (const c of st?.containers ?? []) landing.add(c.id);
      flightReqRef.current = { dir: 'in', first };
      const host = hostRef.current;
      if (host?.classList.contains('expanded') && !host.hasAttribute('data-mobile') && !zoomIn()) coverPage(true);
      // ONE commit (FE4): the sidebar folds to its rail in the same batch as the switch, so the
      // stage measures itself at the folded width; its stage-ready callback starts the flights.
      flushSync(() => {
        holdSidebarCollapsed(instanceId, true);
        if (st && superGenRef.current.isCurrent(gen)) setSuperState(withPendingEdits(st));
        setSuperPending(landing);
        setSuperView('super');
        setSuperMotion('running');
      });
      // The stage reports ready inside that commit; if it never could (no size), nothing flies
      // and nothing is left waiting at opacity 0.
      requestAnimationFrame(() => {
        if (flightReqRef.current?.dir !== 'in') return;
        flightReqRef.current = null;
        setSuperPending(new Set());
        setSuperMotion('idle');
        // A "back" pressed while the request was out, with nothing flying to reverse: go back.
        if (reverseQueuedRef.current) { reverseQueuedRef.current = false; settleReversedRef.current('in'); }
      });
    } catch (err) {
      console.warn('[super] hand-over failed:', err);
      void confirmAction({
        title: t('super.error.handOver'),
        body: err instanceof Error ? err.message : String(err),
        confirmLabel: 'OK',
        cancelLabel: t('super.error.close'),
      });
    } finally {
      superBusyRef.current = false;
      setSuperBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedApi, ensureSuperSession, panes, activePaneId, transportKind, t, instanceId]);

  const takeBack = useCallback(async (focusSid?: string) => {
    const live = flightRunRef.current;
    if (live?.run.active) { live.run.reverse(); return; }
    if (superViewRef.current !== 'super') return;
    // FIRST rects (the containers and the centre), in one batch, before the switch.
    const first = new Map<string, { role: FlightRole; rect: Rect }>();
    for (const c of superStateRef.current?.containers ?? []) {
      if (c.kind !== 'chat' || !hasOwnKey(superStateRef.current?.children, c.ref)) continue;
      const rect = rectOf(containerElOf(c.ref));
      if (isVisibleRect(rect)) first.set(`child:${c.ref}`, { role: 'chip', rect });
    }
    const centre = rectOf(q$('.super-centre'));
    if (isVisibleRect(centre)) first.set('centre', { role: 'centre', rect: centre });
    flightReqRef.current = { dir: 'out', first, focusSid };
    // The rail hold goes in the same batch: the chips' last rects are measured after it.
    flushSync(() => {
      holdSidebarCollapsed(instanceId, false);
      setSuperPending(new Set());
      setSuperView('panes');
      setSuperMotion('running');
      bumpFlight();
    });
    // The owner may reverse this take-back mid-flight (`settleReversed` re-enables): the disable
    // answer that lands after that belongs to an action already undone, and is dropped.
    const gen = superGenRef.current.begin();
    try {
      const st = await disableSuper(scopedApi);
      if (!superGenRef.current.isCurrent(gen)) return;
      setSuperState((prev) => st ?? (prev ? { ...prev, enabled: false } : prev));
    } catch (err) {
      console.warn('[super] take-back was not recorded:', err);
      if (!superGenRef.current.isCurrent(gen)) return;
      setSuperState((prev) => (prev ? { ...prev, enabled: false } : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedApi, instanceId]);

  /** A flight was reversed to its start: the screen goes back to where it came from, and the
   *  server is told (the opposite route). */
  const settleReversedRef = useRef<(dir: 'in' | 'out') => void>(() => {});
  const settleReversed = useCallback((dir: 'in' | 'out') => {
    // A new action: whatever the reversed one still has in flight is stale from here on.
    const gen = superGenRef.current.begin();
    const current = () => superGenRef.current.isCurrent(gen);
    if (dir === 'in') {
      flushSync(() => { holdSidebarCollapsed(instanceId, false); setSuperView('panes'); });
      void disableSuper(scopedApi).then(
        (st) => { if (current()) setSuperState((prev) => st ?? (prev ? { ...prev, enabled: false } : prev)); },
        () => { if (current()) setSuperState((prev) => (prev ? { ...prev, enabled: false } : prev)); },
      );
    } else {
      flushSync(() => { holdSidebarCollapsed(instanceId, true); setSuperView('super'); });
      const tabs: HandoverTab[] = sessionListRef.current.map((m) => ({
        id: m.id, claudeId: m.claudeId, title: m.title, kind: transportKind(m) === 'chat' ? 'chat' : m.kind, mode: m.mode, dormant: m.dormant,
      }));
      void enableSuper(scopedApi, adoptionBody(tabs, superStateRef.current?.session)).then(
        ({ state }) => { if (state && current()) setSuperState(state); },
        (err: unknown) => console.warn('[super] hand-over (after a reversed take-back) failed:', err),
      );
    }
  }, [scopedApi, transportKind, instanceId]);
  settleReversedRef.current = settleReversed;

  // The rail is held folded exactly while this project is handed over (a reload while handed
  // over included); released on take-back and on unmount. The owner's saved preference is
  // never written (F9).
  useLayoutEffect(() => { holdSidebarCollapsed(instanceId, handedOver); }, [instanceId, handedOver]);
  useLayoutEffect(() => () => holdSidebarCollapsed(instanceId, false), [instanceId]);

  // The page behind, covered. The expanded surface is opaque over the whole content area, so
  // while the Super Agent has the screen the page skips style and layout (`data-super-cover`,
  // Shell.css): the rail fold, a whiteboard card restyling the document, a drag never touch it.
  // Measured with a 300-task board behind: a 43-106 ms first frame and a 35-54 ms restyle in
  // mid-flight. Set BEFORE the hand-over's commit (its first layout must not include the page),
  // kept through take-back (the panes still cover it), dropped the moment the surface stops
  // covering it, so the page is laid out once, when it shows again (its scroll comes back).
  const coverPage = useCallback((on: boolean) => {
    const el = hostRef.current?.closest('.project-instance');
    if (!(el instanceof HTMLElement)) return;
    if (on) el.dataset.superCover = 'true';
    else delete el.dataset.superCover;
  }, []);
  // The surface's own zoom-in (AgentTerminal.css) while it runs: the page still shows around it.
  const zoomIn = useCallback(() => hostRef.current?.getAnimations?.()
    .find((a) => (a as CSSAnimation).animationName === 'agent-surface-zoom-in' && a.playState !== 'finished'), []);
  // Opened while handed over (re-open, or a reload: desktop opens it by itself): cover the page
  // once the zoom lands, never under it. No zoom (reduced motion, already open) = at once.
  useLayoutEffect(() => {
    if (!expanded || !handedOver) return;
    const zoom = zoomIn();
    if (!zoom) { coverPage(true); return; }
    let live = true;
    zoom.finished.then(() => { if (live) coverPage(true); }, () => {});
    return () => { live = false; };
  }, [expanded, handedOver, coverPage, zoomIn]);
  useLayoutEffect(() => { if (!expanded) coverPage(false); }, [expanded, coverPage]);
  useLayoutEffect(() => () => coverPage(false), [coverPage]);

  // The flight itself: the LAST rects are taken in one batch after the DOM switched, before the
  // browser paints the new screen, so no frame shows it without its stand-ins. Hand-over: from
  // the stage's own plan, once it measured itself at the folded width (`onStageReady`, FE4) —
  // never from a width guessed at the press. Take-back: measured from the panes (the effect).
  const startFlight = (stage?: { origin: DOMRect; plan: StagePlan }) => {
    const req = flightReqRef.current;
    if (!req || (req.dir === 'in') !== !!stage) return;
    flightReqRef.current = null;
    const layer = flightLayerRef.current;
    const done = () => { setSuperMotion('idle'); setSuperPending(new Set()); };
    if (!layer) { done(); return; }
    const origin = layer.getBoundingClientRect();
    const inputs: FlightInput[] = [];
    if (stage) {
      const onStage = (r: Rect): Rect => ({ x: stage.origin.left + r.x, y: stage.origin.top + r.y, width: r.width, height: r.height });
      for (const [key, f] of req.first) {
        let last: Rect | null = null;
        if (key === 'strip') last = f.rect;
        else if (key === 'centre') last = onStage(stage.plan.centre);
        else {
          const cid = key.slice('child:'.length);
          const c = superStateRef.current?.containers.find((x) => x.kind === 'chat' && x.ref === cid);
          const cp = c ? stage.plan.cards[c.id] : undefined;
          last = cp ? onStage(cp.where === 'others' ? stage.plan.othersRect : cp.rect) : null;
        }
        if (isVisibleRect(last)) inputs.push({ key, role: f.role, first: relativeTo(f.rect, origin), last: relativeTo(last, origin) });
      }
    } else {
      for (const [key, f] of req.first) {
        let last: Rect | null = null;
        let role: FlightRole = f.role;
        if (key === 'centre') last = rectOf(q$('[data-testid="super-handover-btn"]'));
        else {
          const at = paneRectOf(sidOfClaude(key.slice('child:'.length)));
          last = at.rect;
          role = at.role;
        }
        if (isVisibleRect(last)) inputs.push({ key, role, first: relativeTo(f.rect, origin), last: relativeTo(last, origin) });
      }
      const strip = rectOf(q$('.agent-overlay-tabs'));
      if (isVisibleRect(strip)) inputs.push({ key: 'strip', role: 'strip', first: relativeTo(strip, origin), last: relativeTo(strip, origin) });
    }
    const plan = planFlights(inputs, { direction: req.dir, reduced: prefersReducedMotion(), light: isLightMode() });
    // A crossfade fades the whole screen; nothing waits on a landing.
    if (plan.kind === 'crossfade') setSuperPending(new Set());
    const incoming = req.dir === 'in'
      ? [plan.kind === 'crossfade' ? q$('[data-testid="super-surface"]') : null]
      : [panesRowRef.current, q$('.agent-overlay-tabs')];
    const land = (step: FlightStep): Animation | null => {
      if (req.dir !== 'in') return null;
      const target = step.key === 'centre' ? 'centre' : (() => {
        const cid = step.key.slice('child:'.length);
        return superStateRef.current?.containers.find((c) => c.kind === 'chat' && c.ref === cid)?.id ?? '';
      })();
      setSuperPending((prev) => { if (!prev.has(target)) return prev; const next = new Set(prev); next.delete(target); return next; });
      const el = target === 'centre' ? q$('.super-centre') : target ? q$(`.super-card-frame[data-container-id="${esc(target)}"]`) : null;
      // The content fades in as its stand-in fades out (120 ms each, D18).
      return el && typeof el.animate === 'function'
        ? el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'linear', fill: 'both' })
        : null;
    };
    const run = runFlights(layer, plan, { onLand: land, fadeIn: incoming });
    flightRunRef.current = { run, dir: req.dir, focusSid: req.focusSid };
    if (reverseQueuedRef.current) { reverseQueuedRef.current = false; run.reverse(); }
    void run.finished.then((outcome) => {
      const mine = flightRunRef.current?.run === run ? flightRunRef.current : null;
      if (outcome === 'reversed') {
        settleReversed(req.dir);
        // The old screen comes back first; the stand-ins go once it is painted under them.
        requestAnimationFrame(() => requestAnimationFrame(() => run.cleanup()));
      } else {
        setSuperPending(new Set());
        // Cleared a frame later, once React has dropped the pending classes.
        requestAnimationFrame(() => run.cleanup());
        if (req.dir === 'in') {
          requestAnimationFrame(() => superChatRef.current?.focus());
        } else {
          const sid = mine?.focusSid;
          if (sid) focusSessionRef.current(sid);
          else { const ap = panesRef.current.find((p) => p.id === activePaneIdRef.current) ?? panesRef.current[0]; if (ap) requestAnimationFrame(() => sessions.current.get(ap.active)?.focus()); }
        }
      }
      if (flightRunRef.current?.run === run) flightRunRef.current = null;
      setSuperMotion('idle');
    });
  };
  const startFlightRef = useRef(startFlight);
  startFlightRef.current = startFlight;
  useLayoutEffect(() => { startFlightRef.current(); }, [flightNonce]);
  const onStageReady = useCallback((stage: { origin: DOMRect; plan: StagePlan }) => { startFlightRef.current(stage); }, []);
  const superChatRef = useRef<ChatSession | undefined>(undefined);
  superChatRef.current = superChatSession;
  const superSidRef = useRef<string | null>(null);
  superSidRef.current = superSid;
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const activePaneIdRef = useRef(activePaneId);
  activePaneIdRef.current = activePaneId;
  const focusSessionRef = useRef<(sid: string) => void>(() => {});
  focusSessionRef.current = (sid) => {
    if (minimizedIds.includes(sid)) restoreMinimized(sid);
    else focusSession(sid);
  };

  /** The header button: one press, one direction — or, mid-flight, the reverse. */
  const onHandoverButton = useCallback(() => {
    if (superViewRef.current === 'super') void takeBack();
    else void handOver();
  }, [handOver, takeBack]);

  /** A terminal in the Terminals row: take the screen back and focus that terminal. */
  const openTerminalFromSuper = useCallback((sid: string) => { void takeBack(sid); }, [takeBack]);

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

  // ── Drag-to-split, executed on the tab's pointer RELEASE (tabDrag.ts) ─────────────
  // The gesture hit-tests the measured rects and hands over the last target; the executors
  // above do the layout. Read through a ref so the strip's handler keeps one identity while
  // `dropToZone` (which closes over `panes`) is rebuilt.
  const executeTabDrop = (sid: string, t: TabDropTarget) => {
    // The layout moved under the drag (a pane closed): the measured target is stale.
    if (!panes.some((p) => p.id === t.paneId) || !panes.some((p) => p.tabs.includes(sid))) return;
    if (t.kind === 'zone') dropToZone(t.paneId, t.zone, sid);
    else if (t.kind === 'group') combineIntoPane(sid, t.paneId);
    else moveTab(sid, t.paneId, t.beforeSid);
  };
  const executeTabDropRef = useRef(executeTabDrop);
  useEffect(() => { executeTabDropRef.current = executeTabDrop; });
  const handleTabDrop = useCallback((sid: string, t: TabDropTarget) => executeTabDropRef.current(sid, t), []);

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
    // Called from a mousedown-capture, so it ARMS the switch — see `armPane` above.
    activate: (paneId) => armPane(paneId),
    resume: (sid) => resumeSession(sid),
    close: (sid) => closeSessionById(sid),
  };
  const paneActionsRef = useRef(paneActionsImpl);
  useEffect(() => { paneActionsRef.current = paneActionsImpl; });
  const paneActions = useMemo<PaneActions>(() => ({
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
    pickAgent: pickChatAgent,
    changeAccount: changeChatAccountFor,
    handoffToDevelop,
    openAppPage: onOpenAppPage,
    signIn: signInChatAccount,
  };
  const chatActionsRef = useRef(chatActionsImpl);
  useEffect(() => { chatActionsRef.current = chatActionsImpl; });
  const chatActions = useMemo<ChatSurfaceActions>(() => ({
    changeModel: (sid, id) => chatActionsRef.current.changeModel(sid, id),
    changeEffort: (sid, level) => chatActionsRef.current.changeEffort(sid, level),
    continueInTerminal: (cs) => chatActionsRef.current.continueInTerminal(cs),
    resumeChat: (cs) => chatActionsRef.current.resumeChat(cs),
    changePermissionMode: (sid, mode) => chatActionsRef.current.changePermissionMode(sid, mode),
    changeMode: (sid, mode) => chatActionsRef.current.changeMode(sid, mode),
    pickAgent: (sid, agent) => chatActionsRef.current.pickAgent?.(sid, agent),
    changeAccount: (sid, accountId) => chatActionsRef.current.changeAccount(sid, accountId),
    handoffToDevelop: (cs, taskSlug) => chatActionsRef.current.handoffToDevelop(cs, taskSlug),
    openAppPage: (page, id) => chatActionsRef.current.openAppPage(page, id),
    signIn: (cs) => chatActionsRef.current.signIn(cs),
  }), []);

  const commitRename = useCallback((id: string, raw: string) => {
    const title = raw.trim();
    setRenamingId('');
    // A name the user typed is theirs: dropping `titleByAgent` is what stops the tab's agent
    // from renaming it again (see armAgentTitle).
    if (title) setSessionList((prev) => prev.map((m) => (m.id === id ? { ...m, title, titleByAgent: undefined } : m)));
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
  // Handed over (plan-r7 D9), pane homing is SUSPENDED: only the Super Agent (the centre slot)
  // and the shown child (the half card, else the first presented chat: plan-r8 F11) are homed,
  // every other session goes to the garage.
  const superShownSid = (() => {
    const cid = shownChild(superState);
    return cid ? sessionList.find((m) => m.claudeId === cid && !m.dormant)?.id ?? null : null;
  })();
  useLayoutEffect(() => {
    // A session has a home when it is some pane's active tab — homed in the overlay's
    // `.agent-pane-slot[data-pane]`. Everything else lives in the garage.
    const homed = homedSessions({ handedOver, superSid, shownSid: superShownSid, paneActives: panes.map((p) => p.active) });

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

    if (handedOver) {
      const place = (sid: string | null, name: 'centre' | 'shown') => {
        const s = sid ? sessions.current.get(sid) : undefined;
        const slot = hostRef.current?.querySelector<HTMLElement>(`[data-super-slot="${name}"]`);
        if (s && slot && s.container.parentElement !== slot) { slot.appendChild(s.container); s.ensureOpen({ focus: isActive }); }
      };
      place(superSid, 'centre');
      place(superShownSid, 'shown');
    } else {
      panes.forEach((pane) => {
        const s = sessions.current.get(pane.active);
        const slot = slots.get(pane.id);
        if (s && slot && s.container.parentElement !== slot) { slot.appendChild(s.container); s.ensureOpen({ focus: isActive }); }
      });
    }
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
    // `superSlotEpoch` re-runs it when the hand-over screen recreates its slots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes, expanded, handedOver, superSid, superShownSid, superSlotEpoch]);

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
    // not an orphan — exclude it or the reconcile would yank it back into a pane. Neither is
    // the Super Agent: it is never a tab (plan-r7 D9), handed over or parked.
    const orphans = sessionList
      .filter((m) => !placed.has(m.id) && !min.has(m.id) && !isSuperSession(m, superStateRef.current?.session))
      .map((m) => m.id);
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

  // ── Orphan detector: a live roster entry with no session object ───────────────────
  //
  // The reconcile above answers "is every roster id in exactly one pane?", which is a
  // different question from "does every roster id still have something RUNNING behind it?"
  // — and it is the second one that a failed respawn breaks. The end state is a tab that
  // draws, reads as `starting` (an undefined status maps there), renders an empty pane
  // (no portal is built for it, no container is appended to its slot) and cannot be clicked
  // back to life. Nothing in this surface notices it today, which is why it is instrumented
  // rather than merely reasoned about.
  //
  // A DORMANT entry legitimately has no session (that is what dormant means) and a MINIMIZED
  // one still has its session running in the garage, so only non-dormant entries are suspects.
  //
  // Reported after a GRACE PERIOD, not on sight. Every respawn passes through a moment where
  // the old id is deleted and the new one is not yet in the roster; React batches the two
  // state updates so an effect should never observe that gap, but "should never" is exactly
  // the assumption a false positive would be built on. Waiting a beat and re-checking costs
  // nothing and makes a report mean what it says.
  const orphanTimersRef = useRef<Map<string, number>>(new Map());
  useEffect(() => { installRespawnTraceGlobal(); }, []);
  useEffect(() => {
    const timers = orphanTimersRef.current;
    const suspects = sessionList.filter((m) => !m.dormant && !sessions.current.has(m.id));
    const suspect = new Set(suspects.map((m) => m.id));
    // Healed or closed → drop the pending report, and let this id report again if it ever
    // breaks a second time.
    timers.forEach((t, id) => { if (!suspect.has(id)) { clearTimeout(t); timers.delete(id); } });
    sessionList.forEach((m) => { if (!suspect.has(m.id)) clearOrphan(m.id); });
    suspects.forEach((m) => {
      if (timers.has(m.id)) return;
      timers.set(m.id, window.setTimeout(() => {
        timers.delete(m.id);
        if (sessions.current.has(m.id)) return;  // the respawn landed while we waited
        traceOrphan(m.id, {
          title: m.title,
          claudeId: m.claudeId,
          kind: m.kind,
          inPane: panes.some((p) => p.tabs.includes(m.id)),
          isActiveTab: panes.some((p) => p.active === m.id),
          liveSessionIds: [...sessions.current.keys()],
        });
      }, ORPHAN_GRACE_MS));
    });
  }, [sessionList, panes, minimizedIds]);
  // Timers outlive a re-render but must not outlive the surface.
  useEffect(() => {
    const timers = orphanTimersRef.current;
    return () => { timers.forEach((t) => clearTimeout(t)); timers.clear(); };
  }, []);

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
      // A tab drag in flight owns Esc: tabDrag.ts cancels it there. Its own listener is added
      // when the drag starts, AFTER this one (registered when the overlay expanded), so its
      // stopPropagation cannot reach us — capture listeners on one node run in registration
      // order. Without this check one Escape cancelled the drag AND folded the whole surface.
      if (tabDrag.get()) return;
      if (document.querySelector('.agent-new-menu')) return;  // the "＋ New" menu owns Esc
      // A tab's right-click menu owns Esc too. Tested by presence rather than by focus: it
      // portals to <body> and never takes focus, so the `activeElement` checks below (which
      // is still the terminal that was focused when the menu opened) would all miss it —
      // and this listener is on `window`, so it runs BEFORE the menu's own document-level
      // one and would otherwise collapse the whole surface out from under it.
      if (document.querySelector('.agent-tab-menu')) return;
      // A file opened OVER the surface owns Esc too — the image viewer, the PDF viewer, a
      // full-screen board. Each swallows the key itself, but this listener is registered on
      // `window` the moment the overlay expands, which is BEFORE any of them mount: capture
      // listeners on one node run in registration order, so ours fired first and collapsed
      // the whole surface out from under the picture the user was closing (measured 09-06 by
      // scripts/verify/chat-file-preview.mjs). Presence, not focus, for the same reason the
      // two menus above use it: these portal to <body>. The quest receipt ("How this was
      // built") is one of them: it portals its own dialog and closes itself on Esc.
      if (document.querySelector('.image-viewer, .pdf-viewer, .fullscreen-overlay, .quest-receipt-scrim')) return;
      // The phone's session drawer owns Esc while it is open — same presence test, same
      // reason (it portals no focus of its own). Without this the one key closed the drawer
      // AND collapsed the surface behind it, which on a phone means the chat vanishes.
      if (document.querySelector('.mchat-drawer[data-open]')) return;
      // An open group (or Others) on the Super Agent's stage owns Esc: it closes the panel and
      // gives focus back to its tile (GroupPanel). Same presence test, same registration order.
      if (document.querySelector('.super-group-panel')) return;
      // A card's size menu owns Esc the same way: it closes the menu (SuperContainer), never the stage.
      if (document.querySelector('.super-size-menu')) return;
      // A presentation on that stage owns Esc: it goes back to the floating stage (SuperSurface),
      // never folds the whole Agents view.
      if (document.querySelector('.super-surface[data-presenting]')) return;
      // A card held on that stage owns Esc too: the drag's own listener cancels it, but it is
      // added at the press, after this one, so its stopPropagation cannot reach us.
      if (document.querySelector('.super-surface[data-dragging]')) return;
      // A card's corner held for a resize owns Esc the same way (useStageDrag marks the stage).
      if (document.querySelector('[data-resizing]')) return;
      // A web card in Inspect, or asking whether to clear its page, owns Esc: it leaves Inspect
      // (ZoomPane). A pick never focuses the page (its click is swallowed), so Esc lands here.
      if (document.querySelector('.super-zoom[data-inspect], [data-testid="super-zoom-clear-ask"]')) return;
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
  }, [expanded, tabDrag]);

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

  // A phone opens straight INTO chat. The dashboard shell still exists behind the surface
  // (and `Show full dashboard` in the drawer reveals it) — it is just never the landing
  // screen on a device where the only thing that fits is one conversation.
  useEffect(() => {
    if (!isMobile) { autoExpanded.current = false; return; }
    // ONCE per entry into the phone layout, never "whenever collapsed". A standing
    // re-expand would fight every collapse path there is — Esc, the escape hatch, a future
    // one nobody has written yet — and the fight shows up as a surface that flickers
    // open/closed forever rather than as a clean bug. The ref resets when the layout leaves
    // mobile, so a rotation back into it opens chat again.
    if (autoExpanded.current || mobileEscaped || !agentSettings.enabled) return;
    autoExpanded.current = true;
    setExpanded(true);
  }, [isMobile, mobileEscaped, agentSettings.enabled]);

  // Leaving the phone layout (rotation to a wide landscape, or emulation off) must not
  // strand the drawer open over a desktop surface that has a tab strip again.
  useEffect(() => { if (!isMobile) setDrawerOpen(false); }, [isMobile]);

  // The app's own title bar (`.window-chrome-bar`, z-index 40) sits ABOVE the agent overlay
  // by design, so on a phone — where the surface covers the viewport from y=0 — it lands on
  // top of the mobile header and eats every tap on the ☰ button. It is a window chrome for a
  // window that does not exist here, so it goes while chat owns the screen. The flag rides on
  // <body> because the bar is mounted in a different subtree (Shell) than this surface;
  // clearing it on unmount and on collapse is what makes `Show full dashboard` bring it back.
  useEffect(() => {
    if (!isMobile || !expanded) return;
    document.body.dataset.mobileChat = 'true';
    return () => { delete document.body.dataset.mobileChat; };
  }, [isMobile, expanded]);

  // ── The dragged tab vanished mid-drag ───────────────────────────────────────────
  // Its session closed or its pane went away while the pointer was still down: end the
  // drag without acting, so no drop layer outlives the tab it was for (the gesture tears
  // itself down when the store ends — see `armTabDrag`). Any other pane change moved the
  // rects the drag hit-tests against: have it measure again.
  useEffect(() => {
    const s = tabDrag.get();
    if (!s) return;
    const t = s.target;
    if (!panes.some((p) => p.tabs.includes(s.sid)) || (t && !panes.some((p) => p.id === t.paneId))) tabDrag.end();
    else tabDrag.layoutChanged();
  }, [panes, tabDrag]);

  // ── Auto-collapse on navigation ──────────────────────────────────────────────
  // When the user clicks a sidebar item (or jumps via the ⌘K palette) while the agent
  // is fullscreen, collapse it so the page they navigated to is actually visible. The
  // sessions stay alive in the garage — collapsing never tears anything down.
  //
  // This instance's Shell only (it emits on the same bus): navigating in the foreground
  // project must not collapse a backgrounded project's overlay out from under it, so that
  // switching back lands on the agent you left open rather than on its page.
  useInstanceEvent('dreamcontext-navigate', () => setExpanded((cur) => (cur ? false : cur)));

  // The sidebar's Chat row. Same gate as the corner FAB (desktop + enabled in Settings): a
  // rail that shows the row only under those conditions can still be a beat ahead of `caps`,
  // and expanding a surface that renders nothing would leave an invisible overlay eating clicks.
  useInstanceEvent(OPEN_AGENT_SURFACE_EVENT, () => {
    if (caps?.desktop && agentSettings.enabled) setExpanded(true);
    // The phone's way back from "Show full dashboard": chat owns the screen again.
    setMobileEscaped(false);
  });
  // …and tell the rail whether the overlay is up, so Chat reads as the current place (not the
  // page hidden underneath it).
  useEffect(() => { emitInstance<boolean>(bus, AGENT_SURFACE_EXPANDED_EVENT, expanded); }, [bus, expanded]);

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
      // Handed over, the panes are not on screen: no chord may open, split or close one behind
      // the owner's back (the owner writes only to the Super Agent).
      if (superViewRef.current === 'super') return;
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
    catch (e) {
      void confirmAction({
        title: 'Could not open Terminal',
        body: e instanceof Error ? e.message : undefined,
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
    }
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
    // task DnD) carry no OS files, so we leave those drops untouched. A dropped file
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
      // Handed over, a file goes to the Super Agent: the panes it would otherwise reach are
      // not on screen.
      const targetSid = superViewRef.current === 'super' ? (superSidRef.current ?? '') : (targetPane?.active || focusedSessionId);
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

  // Click (or Tab) into a pane → THAT pane becomes the action-focused one.
  //
  // Native and on the host for the SAME reason the drop listeners above are (owner report
  // 09-12, with a recording): `PaneFragment` carries an `onMouseDownCapture`, but that is a
  // REACT handler, and a chat pane's body is portaled out of the overlay body — so a mousedown
  // inside one propagates up the PORTAL's React tree and never passes through the
  // `PaneFragment` that owns the slot it is visibly sitting in. A terminal pane was unaffected
  // (xterm's DOM is React-foreign, so React resolves the path from the slot's own fiber),
  // which is exactly why focus followed clicks in a terminal split and sat frozen on one pane
  // in an all-chat one. Real DOM sees both: the portaled node genuinely IS a descendant of
  // `.agent-pane-slot[data-pane]`.
  //
  // Capture phase, so a child that stops propagation (xterm, an open menu) cannot swallow it.
  // `focusin` rides along for the keyboard path — Tab into another pane's composer moves the
  // focus ring, so it must move the widening too. Safe to listen for: every `.focus()` inside
  // a pane is user-initiated (a caret placed after a menu pick, a dropped file's path, a
  // dream-action button), so nothing streams focus onto a background pane behind the user.
  //
  // `PaneFragment`'s React handler STAYS — it is what covers a terminal pane's own chrome
  // (head, composer strip), which lives outside the slot and so outside this listener's reach.
  useEffect(() => {
    if (!expanded) return;
    const el = hostRef.current;
    if (!el) return;
    // Read live from the DOM rather than from `panes`: the attribute is the pane id, so this
    // needs no state in its closure and the listener never goes stale as panes come and go.
    const paneOf = (e: Event) => {
      const at = e.target as Element | null;
      return (at?.closest?.('.agent-pane-slot[data-pane]') as HTMLElement | null)?.dataset.pane ?? '';
    };
    // The press only ARMS the pane (`armPane` above): widening it here would move the
    // pressed element out from under the cursor and the click would never reach it.
    const onDown = (e: Event) => armPane(paneOf(e));
    // The keyboard path (Tab into another pane's composer) has no click to wait for, so it
    // switches immediately — unless a press is already armed, which means this `focusin` is
    // that press focusing what it landed on, and `mouseup` owns the switch.
    const onFocusIn = (e: Event) => {
      if (armedPaneRef.current) return;
      activatePane(paneOf(e));   // React bails out when it is already the active one
    };
    el.addEventListener('mousedown', onDown, true);
    el.addEventListener('focusin', onFocusIn);
    return () => {
      el.removeEventListener('mousedown', onDown, true);
      el.removeEventListener('focusin', onFocusIn);
    };
  }, [expanded, armPane, activatePane]);

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
        info: withParkedLabel(deriveSessionStatus({ dormant: meta?.dormant, status: s?.status, busy: s?.busy, asking: s?.asking, agentsWorking: agentsWorkingOf(s), takenOver: (s as { takenOver?: boolean } | undefined)?.takenOver }), meta, t),
        sessionKind: meta?.kind ?? 'agent',
        // WHICH AGENT this tab's run belongs to, so the strip can draw its FACE
        // instead of the generic automation glyph. Read straight off the roster
        // entry the hydrate path already round-trips (`SavedMeta.automation`) —
        // nothing new is persisted, and it stays undefined for every other kind,
        // which is what keeps a non-automation tab byte-identical to today.
        automationSlug: meta?.automation?.slug,
        bypass: !!meta?.bypass,
        attention: !meta?.dormant && !!s?.attention,
      };
    }),
  }));

  // The phone's flat session list. It spans EVERY pane, not just the active one: a roster
  // restored from a saved side-by-side layout still has two panes, and a list that showed
  // only one of them would silently hide half the user's sessions on the one device where
  // the panes are not visible to contradict it. Each row remembers its pane so selecting it
  // can activate that pane too.
  const mobileTabs = paneVMs.flatMap((pane) => pane.tabs.map((t) => ({ ...t, paneId: pane.id })));
  const mobileActive = mobileTabs.find((t) => t.id === activePane?.active) ?? mobileTabs[0];
  // Phone (Mac mode): tell each chat whether it is the one on screen, so the server does not
  // push a question or a finished turn for the chat the owner is looking at (D2).
  // On the list no chat is on screen, so every chat may push.
  const onScreenChatId = isMobile && expanded && !mobileEscaped && isMacPhoneSurface() && phoneView === 'chat' ? (mobileActive?.id ?? '') : '';
  useEffect(() => {
    if (!isMacPhoneSurface()) return;
    for (const [id, s] of sessions.current) {
      if (s.kind === 'chat') (s as ChatSession).setOnScreen(id === onScreenChatId);
    }
  }, [onScreenChatId, sessionList]);
  // The phone stack (AC19) and list (AC21): the open tabs with the conversation each holds, the
  // live session's AND the roster's (a dormant tab has only the latter, and the two can differ), so
  // a Mac chat this phone holds is never listed twice.
  const claudeIdOf = new Map(sessionList.map((m) => [m.id, m.claudeId]));
  const stackTabs: StackTab[] = mobileTabs.map((t) => ({
    id: t.id, paneId: t.paneId, title: t.title, info: t.info, attention: t.attention,
    claudeId: sessions.current.get(t.id)?.claudeId || claudeIdOf.get(t.id),
    altClaudeId: claudeIdOf.get(t.id),
  }));
  const stackSessionFor = useCallback((id: string): ChatSession | undefined => {
    const s = sessions.current.get(id);
    return s && s.kind === 'chat' ? (s as ChatSession) : undefined;
  }, []);
  // Collapsed dock rows — one chip per session, in roster order. Never the Super Agent (it is
  // not a tab; its queue speaks through the hand-over button's dot and the queue head).
  const dockRows: SessionRow[] = sessionList.filter((meta) => !isSuperSession(meta, superState?.session)).map((meta) => {
    const s = sessions.current.get(meta.id);
    return {
      id: meta.id,
      title: meta.title,
      kind: meta.kind,
      info: withParkedLabel(deriveSessionStatus({ dormant: meta.dormant, status: s?.status, busy: s?.busy, asking: s?.asking, agentsWorking: agentsWorkingOf(s), takenOver: (s as { takenOver?: boolean } | undefined)?.takenOver }), meta, t),
      attention: !meta.dormant && !!s?.attention,
      claudeId: s?.claudeId,
      // The ROSTER's mode, not the live session's: a mode switch respawns the process and
      // writes the new mode onto the meta (`chatChangeModeFor`), and the meta is also what
      // survives a relaunch — so a dormant Develop tab is still at the anvil when it reopens.
      mode: meta.mode,
      ...(marked.has(meta.claudeId) ? { superChild: true } : {}),
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
  // Handed over, the marked children never bounce the chip; only the queue head the OWNER must
  // answer (a permission, an escalation, the Super Agent's own question) does (plan-r7 D16), and
  // it reads as a question like any chat's: magenta, nudging, until answered (owner, 2026-10-22).
  const superHead = superState?.enabled ? queueHead(superState) : null;
  const rollup: ProjectRollup = rollupProject(dockRows, { superQueueHead: superHead ? { asker: superHead.sessionId } : false });
  // …and in the folded dock: the Super Agent is no tab, so its question gets a chip of its own
  // (a child's question already has the child's chip). Opening it opens the stage.
  const superAskRow: SessionRow | null = superHead && !dockRows.some((r) => r.claudeId === superHead.sessionId)
    ? { id: SUPER_ASK_ROW, title: t('super.centre.name'), kind: 'chat', info: { kind: 'asking', label: 'needs you', mood: 'asking' }, attention: false, mode: 'super', pinned: true }
    : null;
  const dockShown = superAskRow ? [superAskRow, ...dockRows] : dockRows;
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
    // must still get the setup checklist below, not a rendered tabs/panes UI with no
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
        {/* Handed over to the Super Agent (plan-r7 D9): Claude in the cape in the centre, the
            adopted chats as containers around it, the queue strip, the terminals row. The
            panes are NOT unmounted — the row below is only `hidden` — so take-back shows
            exactly the layout the owner left (plus the delegated children as tabs), and the
            row's glide observer keeps its element. Never on a phone (`handedOver` needs a
            desktop layout). */}
        {handedOver && superState && (
          <SuperSurface
            state={superState}
            initialWidth={superWidth || hostRef.current?.clientWidth || 0}
            initialHeight={hostRef.current?.clientHeight || 0}
            visible={expanded && !windowActivity.hidden}
            pending={superPending}
            pendingCloses={pendingCloses}
            motion={superMotion}
            superSession={superChatSession}
            vault={vault ?? ''}
            sessionFor={chatByClaudeId}
            titleFor={superTitleFor}
            nameFor={superNameFor}
            terminals={superTerminals}
            onLayout={editSuperLayout}
            onTerminal={openTerminalFromSuper}
            onReplyToSuper={() => superChatSession?.focus()}
            onNewSession={() => postSuperFresh(scopedApi)}
            onOpenPage={onOpenAppPage}
            onSlotsChanged={bumpSuperSlots}
            onStageReady={onStageReady}
            onAskAbout={askAboutCard}
            onPickElement={pickElementFromCard}
            onWriteAbout={writeAboutRow}
            onEndChild={endChildFromCard}
            onKeepChild={keepChildRunning}
            endPending={endPending}
            endFailed={endFailed}
          />
        )}
        {/* Mac mode's phone has two screens, the Sohbetler list and one chat (owner, 2026-10-17):
            the other open chats live on the list, not in a band above the chat. */}
        {isMobile && !macPhone && (
          <PhoneChatStack
            tabs={stackTabs}
            activeId={mobileActive?.id ?? ''}
            vault={vault ?? ''}
            polling={onScreenChatId !== ''}
            sessionFor={stackSessionFor}
            onSelect={selectTab}
            onAdopt={adoptLiveChat}
            onSwap={() => setSwapFlip((f) => (f === 1 ? 2 : 1))}
          />
        )}
        <div
          ref={panesRowRef}
          className={'agent-panes' + (panes.length > 1 ? ' split' : '')}
          data-swap={isMobile && swapFlip ? String(swapFlip) : undefined}
          hidden={handedOver}
        >
          {/* The focused pane's top bar, ONE element that glides between panes on the
              compositor while the panes land in a single layout (usePaneFocusGlide.ts). */}
          <div ref={glideRef} className="agent-pane-glide" aria-hidden />
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
                parked={!!activeMeta?.dormant && !!activeMeta.parked}
                drag={tabDrag}
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
        <h2 style={titleStyle}>Chat — real Claude Code</h2>
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
                  <ReadinessChecklist scope="agent" onReady={() => { void refreshCaps(); }} />
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
      <div
        ref={hostRef}
        className={`agent-surface${expanded ? ' expanded' : closing ? ' closing' : ''}`}
        onAnimationEnd={(e) => { if (e.target === e.currentTarget && closing) setClosing(false); }}
        /* The minimized-sessions dock floats over our bottom-right corner — flag it so the
           corner pane's composer can clear its anchor chip (model/effort stay visible). */
        data-dock-floating={caps?.desktop && expanded && minimizedRows.length > 0 ? 'true' : undefined}
        /* The phone layer's switch — every rule in `MobileChat.css` hangs off this one
           attribute, so the desktop layout is untouched at any width. */
        data-mobile={isMobile ? 'true' : undefined}
        data-phone-nav={macPhone && phoneNav ? phoneNav : undefined}
        /* The live pane count, for the focus-widening math in CSS — the focused pane's
           extra width is capped at what is left once every OTHER pane keeps `--pane-min`,
           and that cap cannot be computed without N. Read by BOTH the pane row and the tab
           strip above it, which is why it lives on their common ancestor: one number, so
           the two can never disagree and drift a divider off its pane edge. */
        style={{ '--pane-count': panes.length } as CSSProperties}
      >
        {/* Overlay chrome — ONE row: collapse, the session TABS themselves (one group per
            pane; the header IS the tab strip, so there's no separate title row and no
            second 38px bar), and the "New" split action. */}
        <div className="agent-overlay-head">
          {/* The phone header: [☰ sessions] [active session name] [＋ new chat]. It REPLACES
              the desktop trio rather than restyling it — the tab strip's per-tab ✕/minimize
              buttons are 20px affordances that no thumb can hit, and a hidden-but-mounted
              strip would still run its drag handlers over the transcript. */}
          {isMobile && (
            <>
              {macPhone ? (
                // Mac mode: ‹ back to the Sohbetler list, which holds what the drawer did (AC21).
                <button
                  className="mchat-head-btn"
                  onClick={() => {
                    if (phoneChatMark.current && window.history.state?.phoneChat === phoneChatMark.current) window.history.back();
                    else setPhoneView('list');
                  }}
                  aria-label={t('handsfree.list.back')}
                  data-testid="chat-back"
                >
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12.5 4.5 7 10l5.5 5.5" />
                  </svg>
                </button>
              ) : (
              <button
                className="mchat-head-btn"
                onClick={() => setDrawerOpen(true)}
                aria-label="Sessions"
                aria-haspopup="dialog"
                aria-expanded={drawerOpen}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
                  <path d="M3 5.5h14M3 10h14M3 14.5h14" />
                </svg>
              </button>
              )}
              <span className="mchat-head-title">
                {mobileActive && <span className="mchat-dot" data-kind={mobileActive.info.kind} aria-hidden />}
                {mobileActive?.title ?? 'Chat'}
              </span>
              <PhoneChip quiet />
              <button
                className="mchat-head-btn"
                onClick={() => addSession(claudeKind)}
                aria-label={chatMode ? 'New chat' : 'New agent'}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
                  <path d="M10 4v12M4 10h12" />
                </svg>
              </button>
            </>
          )}
          {!isMobile && (
            <>
          <button
            className="agent-overlay-collapse"
            title="Collapse (Esc)"
            aria-label="Collapse agent"
            onClick={() => setExpanded(false)}
          >–</button>
          <div className="agent-overlay-tabs" data-split={paneVMs.length > 1 ? 'true' : undefined}>
            {/* Handed over, the strip has left (D18): the panes are not on screen. */}
            {panesLive && !handedOver && paneVMs.map((paneVM) => (
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
                drag={tabDrag}
                onTabDrop={handleTabDrop}
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
            {/* The Super Agent's ONE button (owner decision 9): hand over every open chat, or
                take it back. Chat screen only (the agent is a chat), desktop only, and only once
                Settings → Chat → Super Agent is on (off by default); Take back never hides. */}
            {panesLive && (handedOver || (chatMode && agentSettings.superAgent && !isMacPhoneSurface())) && (
              <HandoverButton
                handedOver={handedOver}
                busy={superBusy || superMotion === 'running'}
                queueDot={!handedOver && ownerQueueCount(superState) > 0}
                onClick={onHandoverButton}
              />
            )}
            {started && !handedOver && (caps?.embeddedTerminal || (caps?.claudeCli && agentSettings.chatView)) && (
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
            </>
          )}
        </div>
        {body}
        {macPhone && expanded && phoneView === 'list' && (
          <PhoneChatList
            tabs={stackTabs}
            vault={vault ?? ''}
            active={!mobileEscaped}
            sessionFor={stackSessionFor}
            onSelect={(paneId, sid) => { selectTab(paneId, sid); setPhoneView('chat'); }}
            onCloseSession={closeSessionById}
            onAdopt={(chat) => { adoptLiveChat(chat); setPhoneView('chat'); }}
            onResume={(past) => { resumePastSession(past); setPhoneView('chat'); }}
            onNewChat={() => { addSession(claudeKind); setPhoneView('chat'); }}
            onExitToDashboard={() => { setMobileEscaped(true); setExpanded(false); }}
            onOpenSuper={(row) => { openSuperOnPhone(row); setPhoneView('chat'); }}
          />
        )}
        {/* Each pane renders its OWN composer strip (files + skills + that agent's live
            model & effort) pinned to its bottom — see the `composer` prop above. */}
        {/* The hand-over's stand-ins fly here (D18): above everything, never hit-testable. */}
        <div ref={flightLayerRef} className="super-flight-layer" aria-hidden />
      </div>
      {/* The phone's session drawer. A SIBLING for the same reason the picker below is one:
          `.agent-surface` declares `contain: layout paint`, which would make it the containing
          block for the drawer's `position: fixed` scrim and trap it inside the pane area. */}
      {isMobile && !macPhone && (
        <MobileSessionDrawer
          open={drawerOpen}
          sessions={mobileTabs}
          activeId={mobileActive?.id ?? ''}
          onClose={() => setDrawerOpen(false)}
          onSelect={(sid) => {
            const row = mobileTabs.find((t) => t.id === sid);
            if (row) selectTab(row.paneId, sid);
          }}
          onCloseSession={closeSessionById}
          onNewChat={() => addSession(claudeKind)}
          openClaudeIds={sessionList.map((m) => m.claudeId).filter(Boolean) as string[]}
          onResumePast={resumePastSession}
          onAdoptLive={adoptLiveChat}
          onExitToDashboard={() => { setMobileEscaped(true); setExpanded(false); }}
        />
      )}
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
          sessions: a single "Chat" FAB. */}
      {caps?.desktop && agentSettings.enabled && !expanded && (
        // `dockRows`, not the roster: a parked Super Agent alone is no session the dock shows
        // (its open question is: `superAskRow`).
        dockShown.length === 0 ? (
          <AgentFab
            status="idle"
            mood="idle"
            label="Chat"
            sessionCount={0}
            attention={false}
            onClick={() => setExpanded(true)}
          />
        ) : (
          <AgentDock
            rows={dockShown}
            focusedId={focusedSessionId}
            onOpen={(id) => {
              if (id === SUPER_ASK_ROW) { setSuperView('super'); setExpanded(true); return; }
              setExpanded(true); if (minimizedIds.includes(id)) restoreMinimized(id); else focusSession(id);
            }}
            onClose={(id) => { if (id !== SUPER_ASK_ROW) closeSessionById(id); }}
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
          // A handed-over Super Agent's child: the owner looks, and writes only to the Super
          // Agent (owner decision 3). Back to a normal composer the moment it is taken back.
          readOnly={marked.has(cs.claudeId)}
          idlePlaceholder={cs.mode === 'super' ? t('super.centre.placeholder') : undefined}
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
