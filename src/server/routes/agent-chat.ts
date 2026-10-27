import type { IncomingMessage, ServerResponse } from 'node:http';
import { bindTake, voiceTakeBlock, type TakeRecord } from '../../lib/voice/voiceLog.js';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename, extname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  writeFileSync, rmSync, readFileSync, existsSync, statSync, readdirSync, createReadStream,
  realpathSync, openSync, readSync, closeSync, lstatSync, fstatSync, constants as fsConstants,
} from 'node:fs';
import { sendJson, sendError, isForeignOriginUpgrade, parseJsonBody } from '../middleware.js';
import { ownedLoopbackPorts } from '../owned-ports.js';
import { openWebSession, UPSTREAM_HOSTS } from '../web-session-proxy.js';
import { createSuperSignalObserver } from '../super-signals.js';
import { readLoopbackGrants, setLoopbackGrant } from '../../lib/loopback-grants.js';
import { serveMedia } from '../media.js';
import { isAgentHost, isAgentRequest, isDesktop } from '../desktop.js';
import { authFor, deviceIdHash, macHandsfreeAuth, onDeviceSessionsChanged } from '../handsfree-auth.js';
import { isMacExposed, isMacOriginAllowed, isPhoneSocket, macExposedEpoch, macExposedVaults, phoneTranscriptRefused } from '../phone-origin.js';
import { phoneMediaRoots, phoneMediaVerdict } from '../../lib/handsfree/mac/phone-media-roots.js';
import { addPhoneFileGrant, hasPhoneFileGrant } from '../phone-file-grants.js';
import { sniffImageType } from '../../lib/image-sniff.js';
import { listVaults } from '../../lib/vaults.js';
import { HOLDER_PROBE_MS, MAC_CLOSE_HANDED_OVER, MAC_CLOSE_TAKEN_OVER, REATTACH_EVICT, REATTACH_PASSIVE, SUPER_STAGE_FRAME, type LiveChatWire } from '../../lib/handsfree/mac/contract.js';
import { cutProcessGroups } from '../../lib/automations/runner.js';
import { trackChild } from '../lifecycle.js';
import { resolveAgentSession } from '../../lib/agent-session-map.js';
import { writeTabHandoff, readTabHandoff, resolveTabSeed, resolveHandoffFor, contextTokensFromUsage } from '../../lib/context-watch.js';
import { handleRotationAtResult, rotationFinished } from './handoff-rotation.js';
import { clearFresh, isRotating, markFreshDelivered, stopRotating } from '../../lib/super/fresh-session.js';
import { readSetupConfig, readBrainLocal, writeBrainLocal } from '../../lib/setup-config.js';
import { advanceHandoffRun, failHandoffRun, handoffProgressFrame, type HandoffRun } from '../../lib/handoff-progress.js';
import { safeChildPath } from '../safe-path.js';
import { sessionWorktreeRoot } from '../session-worktree.js';
import { resolveChatReference, isInside } from '../chat-reference-path.js';
import { CHAT_SURFACE_BRIEFING, SUPER_CHILD_BRIEFING } from '../chat-surface.js';
import { recordAgentSession, recordStageHomeSession } from '../../lib/local-store.js';
import { getRunTarget } from '../../lib/automations/store.js';
import { isGlobalAgentHere, listGlobalAgentSlugs } from '../../lib/agents/scope.js';
import { parseCardRef, parseChatAgent, prepareAgentChat, prepareCardChat, type CardRef } from '../../lib/whiteboards/card-chat.js';
import { chatSubagents } from '../../lib/automations/chat-subagents.js';
import { SUPER_BRIEF_TEXT, modeBriefing, type ChatMode } from '../chat-modes.js';
import { heldModeFromTranscript, modeNoteHookOutput, modeNoteSettings, modeNoteSources, modeSwitchNote, superBriefState } from '../chat-mode-drift.js';
import { worktreeIsolationAllowed } from '../../lib/worktree-gate.js';
import { autoModeSettings } from '../../lib/auto-mode-rules.js';
import { clearSessionCheckout, enterSessionCheckout, exitSessionCheckout } from '../../lib/session-cwd.js';
import { describeFreshStart, freshSessionOnDefaultBranch } from '../../lib/session-start-branch.js';
import { createWorktreeWatcher } from '../worktree-frames.js';
import { createBrowserMirror } from '../browser-mirror.js';
import { prepareBrowserOverride } from '../../lib/browser-override.js';
import {
  describeCheckoutClaim, describeCheckoutReset, readCheckoutDirective, readEditPaths,
} from '../checkout-directive.js';
import { clearSessionEdits, recordSessionEdit } from '../../lib/session-edits.js';
import { forgetSessionFacts, readSessionFacts } from '../../lib/session-facts.js';
import { tabSessionEnv } from '../../lib/session-origin.js';
import { claudeAwarePath, claudeDirectCommand } from '../../lib/claude-path.js';
import { killPortable } from '../../lib/proc.js';
import { claudeAuthWatcher } from '../../lib/claude-auth-watch.js';
import { claudeAuthStatus } from '../../lib/claude-auth.js';
import {
  accountEnvFor, autoSwitchEnabled, isRealHomeConfigDir, listClaudeAccounts, resolveConfigDir, sandboxDirFor,
  switchStrategyFor, switchWeightsFor,
} from '../../lib/claude-accounts.js';
import { ensureSandbox, ensureSharedMcpConfig } from '../../lib/claude-account-sandbox.js';
import { probeAccountForDecision, type ProbeOutcome } from '../../lib/claude-usage-probe.js';
import { readUsageLimits, usageReadingIsCurrent, type UsageLimitsResponse } from '../../lib/claude-usage.js';
import {
  SWITCH_THRESHOLD_PERCENT, chooseAccount, provenPastThreshold, shouldProbe, shouldSwitchAway, type AccountReading, type ChooseResult,
} from '../../lib/claude-account-switch.js';
import { readLimitSignal, type LimitSignal } from '../../lib/claude-limit-signal.js';
import { clearSignedOut, isAuthFailureFrame, recordSignedOut } from '../../lib/claude-signed-out.js';
import { dropFromOutbox } from '../../lib/super/outbox.js';
import { clearAccountRejection, readAccountRejections, recordAccountRejection } from '../../lib/claude-limit-rejections.js';
import { meterEndsRefusal, meterShowsRoomSince, readUsageMeter, readUsageMeterFrame, recordUsageMeter } from '../../lib/claude-usage-meter.js';
import { chatSpawnAccount } from '../../lib/automations/account.js';
import { automationCacheDir, isSafeAutomationSlug, readAutomationCache } from '../../lib/automations/store.js';
import { isAutomationBoundSession } from '../../lib/automations/session-registry.js';
import { taskOfAnySession } from '../../lib/agents/task-starter.js';
import { resolveBoardAssets } from './knowledge.js';
import { isTrustedRemotePeer } from '../remote-access.js';
import { assistantContextRoot, assistantExists, isAssistantVault, readAssistantConfig, DEFAULT_ASSISTANT_CONFIG, DEFAULT_ASSISTANT_MODEL, type Autonomy } from '../../lib/assistant/home.js';
import { getChat, registerChat, isDelegatedConversation, listChats, type ChatEntry, type ChatHandle, type ChatStatus } from '../../lib/assistant/chat-registry.js';
import { resolveRecallMode, type RecallMode } from '../../cli/commands/sleep.js';
import { isEmbedModelDownloaded } from '../../lib/embeddings/embedder.js';
import { ensureIndexBuilt } from './embeddings.js';
import { assistantToken, clearTaint, markTainted, setAssistantSurface } from '../../lib/assistant/session-state.js';
import { collectRoster, renderRoster } from '../../lib/assistant/roster.js';
import { deliverResult, failAllCommands } from '../../lib/assistant/relay.js';
import { attachAssistantInbox } from '../../lib/assistant/delegations.js';
import { clearSuperNote, delegatedChildMcp, handedOverChildRoot, isHandedOverChild, peekSuperNote, readSuperState, setPhoneHoldsProbe, superIndex, superRootOfChild } from '../../lib/super/store.js';
import { remoteViewOf } from './super-remote.js';
import { OWNER_VOICE_TEXT, SUPER_BRIEF_REV, SUPER_FRAME_EVENT, SUPER_NOTE_TEXT, aboutHeads, ownerMsgBlock } from '../../lib/super/types.js';
import { MIRROR_CLOSE_ENDED, MIRROR_CLOSE_REVOKED, MirrorSet, mirrorOwnerText, phoneLiveChats, phoneSuperOpen, stageImageItems, stageMediaFrame, superDigest, superDigestFrame } from '../../lib/super/phone-mirror.js';
import {
  attachSuperInbox, markSuperEventTurn, noteChatStarted, setSuperDigestSink, superAnswerDigest, superOwnerSpoke, superSanitizeOpts, superSocketAttached, superTurnEnded,
} from '../../lib/super/inbox.js';
import { listNotchEvents, lookingAt, recordAccountSwitch } from '../../lib/assistant/notch-inbox.js';
import { buildLiveContextParts } from '../../lib/assistant/live-context.js';
import { seedForConversation } from '../../lib/assistant/chat-seed.js';
import { ensureComputerMcpConfig } from '../../lib/assistant/computer-mcp.js';
import {
  knownMcpServers, parseMcpNames, projectMcpJson, removeLeanMcpConfig, sweepLeanMcpDir, writeLeanMcpConfig,
} from '../../lib/super/lean-mcp.js';
import { deliverSuperResult, deliverWindowResult, mintWindowToken, setWindowControlBase } from '../../lib/window-control.js';
import { runningAutomations, unreadAutomationPosts } from '../assistant-inbox.js';
import {
  CUT_KILL_GRACE_MS, detachBusyCapMs, detachIdleMs, findLiveChat, liveChatsSnapshot, markLiveChatDraining, markTurnEnded, markTurnStarted, registerLiveChat,
  signalGroup, unregisterLiveChat, wsPingMs, type LiveChatEntry,
} from './agent-chat-live.js';
import { registerParkable, parkFocusGraceMs, PARK_ANSWER_MS, type ParkOptions, type ParkOutcome } from '../chat-park.js';
import {
  isLoopback, isSameOriginStrict, isCrossSiteRequest, requireLocalDesktop, rejectUpgrade, resolveVaultProjectRoot, projectRootOf,
  sanitizeUuid, sanitizeModel, sanitizeEffort, sanitizeChatMode, sanitizePrompt, sanitizeAccountId,
  claudeConversationExists, redeemPromptToken, findFirstTranscriptPath,
} from './agent-spawn-shared.js';

/**
 * The AskUserQuestion capabilities the Chat card renders, switched on in the CLI.
 *
 * Both are host opt-ins the CLI keeps OFF unless told (read from 2.1.281; `claude -p` runs
 * as the `sdk-cli` entrypoint, which is on the CLI's allow-list for the extended schema):
 *   • `CLAUDE_CODE_QUESTION_EXTENDED` — a one-line `title` over the card, a per-question
 *     `description`, and `text`/`number` questions. The title and description are what let
 *     a card be answered cold: with several sessions running, the owner reaches a question
 *     from a notification without having read the turn that led to it.
 *   • `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT=html` — tells the model an option may carry an
 *     HTML `preview`, which the card draws as an A/B/C board (and the CLI validates as a
 *     self-contained fragment). Without the variable, `-p` sessions get no preview guidance.
 * Spread AFTER `process.env` on purpose: this is the Chat card's contract, not a
 * preference — an inherited value (say `markdown`) would have the model write previews the
 * card cannot draw.
 */
export const CHAT_QUESTION_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_QUESTION_EXTENDED: '1',
  CLAUDE_CODE_QUESTION_PREVIEW_FORMAT: 'html',
});

/**
 * Agent Chat (beta) — the headless counterpart to the embedded PTY terminal
 * (`agent-terminal.ts`). Instead of a real TUI, this bridges a WebSocket to a
 * `claude -p --input-format stream-json --output-format stream-json` child process:
 * the server relays claude's NDJSON stdout lines to the client VERBATIM (the client owns
 * parsing — see `dashboard/src/lib/chatProtocol.ts`) and translates a small set of
 * simplified client control frames (user message / permission or question answer /
 * interrupt) into the stdin frames claude expects.
 *
 * Same trust model as the PTY bridge: desktop-gated (`DREAMCONTEXT_DESKTOP=1`) +
 * loopback-only + vault-scoped, spawned from strictly-sanitized request input (see
 * `agent-spawn-shared.ts`). Never ships to the browser/npm dashboard build.
 *
 * Same identity registry as the terminal: chat sessions pin/resume through the
 * `agent-session-map` (roster id → live conversation id) via `DREAMCONTEXT_TAB_SESSION`,
 * so a chat and a terminal session both resolve through the SAME map and the
 * SessionStart/Stop hooks fire exactly as they do for a terminal-spawned `claude`.
 */

// ─── Live-conversation guard (chat's OWN set — see agent-chat.ts's dependency-map row:
//    this does NOT share agent-terminal.ts's Set, a documented beta limitation) ────────

// ─── Slash-command list cache (per project) ──────────────────────────────────────────
//
// `claude -p --input-format stream-json` emits `system:init` — the frame carrying
// `slash_commands` — only AFTER its first stdin USER frame, not at process start
// (empirically verified on 2.1.220: a `control_request` gets a `control_response` but no
// init). So a freshly-opened chat has no command list until the user has already sent a
// message — exactly backwards for a `/` autocomplete, which is most wanted on the FIRST
// message.
//
// The fix is a cache, never a hardcoded list: whatever the CLI reported for this project
// last time is replayed to a new session immediately, and every real init overwrites it.
// Worst case it is one session stale (a command added since the last turn); cold start on a
// project that has never run a turn simply has no menu, which is honest.

const SLASH_CACHE_FILE = '.slash-commands.json';

function slashCachePath(contextRoot: string): string {
  return join(contextRoot, 'state', SLASH_CACHE_FILE);
}

function readSlashCache(contextRoot: string): string[] | null {
  try {
    const raw = JSON.parse(readFileSync(slashCachePath(contextRoot), 'utf-8')) as { commands?: unknown };
    const list = Array.isArray(raw.commands) ? raw.commands.filter((c): c is string => typeof c === 'string' && !!c) : [];
    return list.length ? list : null;
  } catch { return null; }
}

function writeSlashCache(contextRoot: string, commands: string[]): void {
  try { writeFileSync(slashCachePath(contextRoot), JSON.stringify({ commands }), 'utf-8'); } catch { /* best-effort */ }
}

/**
 * `GET /api/agent/slash-commands` → `{ commands }`: the same cached list a new chat is
 * handed at connect, for a composer that has NO chat process to be handed it — the
 * `#agents` channel and its thread panel. Their `/` menu offers this project's skills and
 * commands from the same source the chat's does, so the two menus cannot disagree.
 * An empty list on a project that has never run a turn, exactly as a cold chat gets.
 */
export async function handleAgentSlashCommands(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  sendJson(res, 200, { commands: (contextRoot ? readSlashCache(contextRoot) : null) ?? [] });
}

/** Conversation ids currently attached to a live chat process in THIS server. Prevents
 *  two chat sessions from double-attaching the same conversation (a Claude conversation
 *  must have at most one writer). Does NOT know about the terminal route's own Set —
 *  a chat and a terminal resuming the SAME conversation concurrently is a known beta
 *  limitation (see the task's Constraints), not something this guards against. */
const liveConversations = new Set<string>();

/**
 * How long a resuming upgrade will wait for the PREVIOUS holder of that conversation to let
 * go before giving up and taking the old fall-through.
 *
 * ── The race this closes ───────────────────────────────────────────────────────────────
 * Every respawn-in-place path — the account-switch restart, "Session ended → Resume", the
 * Basic/Plan/Develop mode switch — disposes the old session and opens the new socket in the
 * SAME tick. The old session's hold is released promptly (`onSocketGone`, which is exactly
 * why that release does not wait out the drain), but "promptly" is the server noticing a
 * socket close, and the new upgrade is a fresh connection racing it. Either can land first.
 *
 * When the upgrade wins, `startChatSession` reads a conversation that is still marked live
 * and falls all the way through: `resumeTarget` is blocked by the hold, and `freshPin` is
 * blocked because the transcript EXISTS — so `idArg` comes out EMPTY and the spawn silently
 * starts a brand-new, unpinned conversation. The user's transcript is not resumed and the
 * new one is not even resumable. Observed live: two consecutive runs of
 * `verify:claude-auth-switch`, one landing on `--resume <id>` and the next on no id at all.
 *
 * Waiting is the fix rather than weakening the guard, because the guard is right: a
 * conversation must have at most one writer. This only ever delays an upgrade that (a) asked
 * to resume, (b) names a conversation with a real transcript, and (c) finds it still held —
 * so the ordinary case costs one Set lookup and no delay whatsoever. A genuine double-attach
 * (a chat and a terminal on one conversation, the documented beta limitation) still ends in
 * the same fall-through it always did, just 1.5s later.
 */
export const RESUME_HANDOFF_WAIT_MS = 1500;
const RESUME_HANDOFF_POLL_MS = 25;

/**
 * Minimum number of polls that must actually RUN before the wait may give up, regardless of
 * what the clock says.
 *
 * A wall-clock deadline alone is the wrong instrument here, and the case that proves it is
 * the one the owner hit: a permission switch used to respawn EVERY chat in the vault at once,
 * so the event loop went into a burst of synchronous `child_process.spawn` + briefing-file
 * writes. Nothing polls while the loop is blocked, and `Date.now()` keeps moving — so the
 * budget could be spent entirely inside one block, the loop exits on its very first check
 * with the conversation still held, and `startChatSession` takes the silent fall-through:
 * `idArg` empty, a BRAND-NEW unpinned conversation, the transcript orphaned. The tab keeps
 * its pinned id while the live conversation is somewhere else, so the pane comes back blank
 * and stays blank.
 *
 * Counting polls makes the budget mean "we looked this many times", which is what the wait
 * was always trying to say. On an unblocked loop the two agree and the ordinary case still
 * costs one Set lookup and no delay.
 */
const RESUME_HANDOFF_MIN_POLLS = Math.ceil(RESUME_HANDOFF_WAIT_MS / RESUME_HANDOFF_POLL_MS);

/**
 * Give the previous holder of `resumeId`'s conversation a moment to release it.
 *
 * Resolves as soon as nothing holds it (the overwhelmingly common case: immediately), or
 * after {@link RESUME_HANDOFF_WAIT_MS}. Both candidate ids are considered — the tab-session
 * map's answer and the pinned id itself — because `startChatSession` will try both, and a
 * hold on either is what makes it fall through.
 */
async function awaitResumeHandoff(contextRoot: string, resumeId: string): Promise<void> {
  if (!resumeId) return;
  const mapped = resolveAgentSession(contextRoot, resumeId);
  // Only conversations that actually EXIST can produce the bad fall-through, so an id with no
  // transcript never costs a wait, unless a live child still holds it: a respawn of a conversation
  // that has not written its transcript yet (a stage respawned at a new autonomy level before its
  // first answer) would otherwise be refused as held instead of waiting out the hand-off.
  const candidates = [mapped, resumeId].filter((c) => c && (claudeConversationExists(c) || liveConversations.has(c)));
  if (!candidates.length) return;
  const deadline = Date.now() + RESUME_HANDOFF_WAIT_MS;
  let polls = 0;
  while (candidates.some((c) => liveConversations.has(c))
    && (polls < RESUME_HANDOFF_MIN_POLLS || Date.now() < deadline)) {
    polls += 1;
    await new Promise((r) => { setTimeout(r, RESUME_HANDOFF_POLL_MS); });
  }
  // Giving up here is not fatal on its own, but it IS the doorway to the silent fall-through
  // described on RESUME_HANDOFF_MIN_POLLS — and that failure is invisible from the outside
  // (a blank pane, no error). Say so in the log so the next report has something to stand on.
  if (candidates.some((c) => liveConversations.has(c))) {
    console.warn(`[agent-chat] resume hand-off timed out after ${polls} polls — ${resumeId} is still held; this resume may start an unpinned conversation.`);
  }
}

// ─── Permission mode (identical rule to the terminal — agent-terminal.ts:1206) ────────

/** No-bypass chat maps to Auto (`auto`); bypass maps to `bypassPermissions` — the same
 *  two-mode contract the embedded terminal uses (agent-terminal.ts:209/1148).
 *
 *  It must be `auto`, NOT `acceptEdits`. They are different modes on the CLI's list
 *  (2.1.220: acceptEdits | auto | bypassPermissions | manual | dontAsk | plan) and only
 *  `auto` means what the composer's Auto card promises ("edits auto-approved, risky
 *  commands still ask"). Verified against 2.1.220 in a stream-json session with
 *  `--permission-prompt-tool stdio`: under `acceptEdits`, `npm --version` and a `curl`
 *  each raised a `can_use_tool` prompt (only the file-writing command went through
 *  unasked); under `auto` the same four commands ran with no prompt at all. Chat shipped
 *  `acceptEdits` while the terminal had already moved to `auto`, so Auto chats asked for
 *  approval on essentially every non-edit command.
 *
 *  Exported pure so it is unit-testable in isolation (AC11's permission-mode mapping test). */
export function permissionModeFor(bypass: boolean): 'bypassPermissions' | 'auto' {
  return bypass ? 'bypassPermissions' : 'auto';
}

/** The dreamcontext Assistant's OWN claude permission mode follows its autonomy setting, not
 *  the pane's bypass switch: `ask` → `default` (every prompt surfaces in the notch), `auto` →
 *  `auto`, `bypass` → `bypassPermissions`. CLI mutations it runs (`vaults add`, `init`,
 *  `connections …`) are governed by this same mode. */
export function assistantPermissionMode(autonomy: Autonomy): 'default' | 'auto' | 'bypassPermissions' {
  return autonomy === 'bypass' ? 'bypassPermissions' : autonomy === 'auto' ? 'auto' : 'default';
}

/**
 * Pre-approval for the Assistant's own verbs, under `auto` ONLY. Under auto, every
 * `dreamcontext assistant …` Bash call otherwise pays the auto-mode classifier (measured
 * 11-26 s each on Spidey's context). The matcher refuses compound commands (`;`, `&&`, `|`,
 * `$(…)`, a second line — security review 2026-09-27), and the server's gated()/decide()
 * stays the real guard for send/answer/broadcast. `ask` keeps prompting for every other verb
 * (the CLI prompt IS the approval for the free verbs there), but the READS pass: a recall, an
 * index or a file read writes nothing, and asking the owner before each one is the slowness
 * they asked to remove (owner, 2026-10-17). `bypass` needs nothing. Never on any other spawn.
 */
export const ASSISTANT_READ_TOOLS = ['recall', 'index', 'read'].map((v) => `Bash(dreamcontext assistant ${v}:*)`);

export function assistantAllowedTools(autonomy: Autonomy): string[] {
  if (autonomy === 'auto') return ['--allowedTools', 'Bash(dreamcontext assistant:*)'];
  if (autonomy === 'ask') return ['--allowedTools', ASSISTANT_READ_TOOLS.join(',')];
  return [];
}

/**
 * Who may open a chat in `super` mode (plan-r7 D3): exactly the vault's ONE recorded super
 * session (`POST /api/super/enable` mints it), by pin or resume id — a same-id respawn passes,
 * any other id is a second super agent (409), and so is a vault with no session yet. Never from
 * the phone (403: the hand-over is the desktop's). Read from the in-memory index (no disk on the
 * upgrade path).
 */
export function superUpgradeRefusal(o: {
  mode: string; phone: boolean; contextRoot: string; resumeId: string; sessionId: string;
}): 403 | 409 | null {
  if (o.mode !== 'super') return null;
  if (o.phone) return 403;
  const recorded = superIndex(o.contextRoot).session;
  const asked = o.resumeId || o.sessionId;
  return recorded && asked === recorded ? null : 409;
}

/**
 * The Super Agent follows the vault's permission switch like any chat (plan-r7 D15, owner
 * decision 14: no envelope, no gate). In an `auto` vault its OWN verbs are pre-approved so a
 * classifier ask never stalls the queue; ADDITIVE, exactly the Assistant's precedent above.
 * Bypass needs nothing. Never on any other spawn.
 */
export function superAllowedTools(isSuper: boolean, bypass: boolean): string[] {
  return isSuper && !bypass ? ['--allowedTools', 'Bash(dreamcontext super:*)'] : [];
}

/**
 * Claude Code's native plan mode, removed from every chat spawn. 2026-10-17: the owner said
 * "planla" in a Basic tab and the agent opened EnterPlanMode and wrote plans/*.md, where Chat's
 * planning is dreamcontext's Plan mode (it ends by creating the task). Basic adds no brief, so
 * nothing but a deny stops Claude's reflex; the surface briefing says where the request goes.
 * A SCOPED home-board card already brings its own `--disallowedTools` (board-scope.ts,
 * BOARD_AGENT_DISALLOWED_TOOLS) and a second flag would collide, so it gets none. An ATTACHED
 * agent card keeps the pane envelope and is not scoped: it is denied on purpose.
 * The list is constant across chat spawns, so the prompt cache holds; only the first resume of
 * an older conversation after the upgrade misses it once. The Chat ExitPlanMode approval UI
 * (dashboard PlanCard.tsx, chatProtocol.ts, chatSession.ts, ToolCard.tsx) is now idle in Chat
 * and kept deliberately as a fallback for older transcripts, not a bug to fix; a conversation
 * that was inside native plan mode before the upgrade may hit one ExitPlanMode tool error on
 * resume and recover. Cron and RemoteTrigger stay: /loop and /schedule are user-typed skills.
 */
export function chatDeniedToolArgs(scopedCard: boolean): string[] {
  return scopedCard ? [] : ['--disallowedTools', 'EnterPlanMode,ExitPlanMode'];
}

/**
 * The Assistant reads its OWN settings (the hidden vault's hooks, skills and agents) and not the
 * owner's global ones. Owner, 2026-10-14: every notch turn carried the global plugins and user
 * settings — measured ~9.6k tokens of a ~42k context, for a two-sentence answer — and none of
 * them is something the Assistant uses. Dropping the `user` source also drops the user-scope MCP
 * servers, which the owner KEEPS, so those ride by reference instead ({@link sharesUserMcp}).
 * The model and effort are argv already, so the global `model`/`effortLevel` never applied here.
 */
export function assistantSettingArgs(isAssistant: boolean): string[] {
  return isAssistant ? ['--setting-sources', 'project,local'] : [];
}

/**
 * Does this spawn get the user's MCP servers through the shared `--mcp-config` file? A sandboxed
 * account always does (its own config has none). So does the Assistant on the real account,
 * because {@link assistantSettingArgs} cut it off from `~/.claude.json`'s user scope.
 */
export function sharesUserMcp(o: { isAssistant: boolean; isRealHomeAccount: boolean }): boolean {
  return !o.isRealHomeAccount || o.isAssistant;
}

/**
 * `--mcp-config` is variadic (`<configs...>`): every file rides in ONE flag, and the flag must
 * stay the LAST argv element or it swallows whatever follows. Null entries drop out.
 */
/** bash/zsh's own noise when `-i` runs without a terminal: never the error the user needs to see. */
const SHELL_JOB_CONTROL_NOISE = [
  /^(?:\/bin\/)?(?:ba)?sh: cannot set terminal process group \(-?\d+\): Inappropriate ioctl for device\s*$/,
  /^(?:\/bin\/)?(?:ba)?sh: no job control in this shell\s*$/,
];

/** The child's stderr as the error card shows it: without the login shell's job-control lines. */
export function withoutShellJobControlNoise(stderr: string): string {
  return stderr.split('\n').filter((line) => !SHELL_JOB_CONTROL_NOISE.some((re) => re.test(line))).join('\n');
}

export function mcpConfigArgs(paths: Array<string | null>): string[] {
  const files = paths.filter((p): p is string => !!p);
  return files.length ? ['--mcp-config', ...files] : [];
}

/**
 * Is this chat open a LEAN Super Agent child, and with which servers (orchestration plan r5
 * D14)? A child the super record names is lean from its RECORD, whatever the URL says (a window
 * that reloaded before the record arrived asks for nothing); the URL's `lean=1&mcp=` covers a
 * child opened before its record lands. A name the user no longer has is DROPPED: narrower,
 * never wider, never a refusal that locks the conversation out. Never the Assistant or a Super
 * Agent's own session. Null = not lean (every other chat, as before); 'refuse' = a malformed list.
 */
export function leanMcpForUpgrade(o: {
  assistant: boolean; mode: string; conversation: string; lean: string | null; mcp: string | null;
  recorded: (conversation: string) => string[] | null; known: () => ReadonlyMap<string, unknown>;
}): string[] | null | 'refuse' {
  if (o.assistant || o.mode === 'super' || o.mode === 'assistant') return null;
  let asked = o.recorded(o.conversation);
  if (!asked && o.lean === '1') {
    const parsed = parseMcpNames(o.mcp ?? '');
    if ('error' in parsed) return 'refuse';
    asked = parsed.names;
  }
  if (!asked) return null;
  const known = o.known();
  return asked.filter((n) => known.has(n));
}

/**
 * The MCP argv of a spawn: today's ({@link mcpConfigArgs} over `normal`) for every chat, or, for
 * a LEAN Super Agent child (orchestration plan r5 D14), `--strict-mcp-config` and only its
 * subset, the project's `.mcp.json` and the browser override (still last). A lean child with no
 * servers named and no project file gets `--strict-mcp-config` alone: no user MCP process.
 */
export function leanChildMcpArgs(
  lean: { leanMcpPath: string | null; projectMcp: string | null; browser: string | null } | null,
  normal: Array<string | null>,
): string[] {
  if (!lean) return mcpConfigArgs(normal);
  return ['--strict-mcp-config', ...mcpConfigArgs([lean.leanMcpPath, lean.projectMcp, lean.browser])];
}

/**
 * The recall mode a spawn's hooks run under, as an env override — or `{}` to leave the
 * vault's own mode alone. The Assistant, and a chat it delegated into a vault whose mode is
 * `haiku` (a `claude -p` per prompt: 10-27 s measured), get `hybrid` when the embedding model
 * is on disk, else `raw`. NOT gated on index readiness: the env is fixed for the child's
 * life, and the hook re-checks `hybridReady` per prompt and falls back to BM25 until the
 * index lands. NOTE: DREAMCONTEXT_RECALL_MODE overrides the vault's mode for EVERY hook in
 * that child process (sleep.ts resolveRecallMode), not one gate.
 */
export function recallEnvFor(o: {
  isAssistant: boolean; delegated: boolean; vaultRecallMode: RecallMode | null; modelOnDisk: boolean;
}): Record<string, string> {
  if (o.isAssistant || (o.delegated && o.vaultRecallMode === 'haiku')) {
    return { DREAMCONTEXT_RECALL_MODE: o.modelOnDisk ? 'hybrid' : 'raw' };
  }
  return {};
}

/**
 * The `--effort` a spawn runs at ('' = none, the CLI's default). The Assistant runs at its own
 * configured effort (default medium) whatever the URL asked; a delegated `basic` chat with no
 * explicit effort runs at medium (a relay errand, not deep work); plan/develop delegations and
 * every owner chat keep what the URL said.
 */
export function spawnEffortFor(o: {
  isAssistant: boolean; assistantEffort?: string; delegated: boolean; mode: string; urlEffort: string;
}): string {
  if (o.isAssistant) return o.assistantEffort || 'medium';
  if (o.delegated && o.mode === 'basic' && !o.urlEffort) return 'medium';
  return o.urlEffort;
}

/**
 * The `--model` a spawn runs on ('' = none, the CLI's default). The Assistant has its OWN
 * default (owner, 2026-10-04: sonnet, not dreamcontext's chat default), which the URL overrides
 * only when the notch asked for a model explicitly; every other chat keeps what the URL said.
 */
export function spawnModelFor(o: { isAssistant: boolean; assistantModel?: string; urlModel: string }): string {
  if (o.isAssistant) return o.urlModel || o.assistantModel || DEFAULT_ASSISTANT_MODEL;
  return o.urlModel;
}

/**
 * Live `__assistant__` sessions, told when the owner changes autonomy. The permission mode
 * and `--allowedTools` are argv — fixed for a process's life — so a session spawned under
 * `auto` would keep pre-approving its verbs after a switch to `ask`. Each listener respawns
 * its session in place with `--resume` before its next turn.
 */
const assistantAutonomyListeners = new Set<(autonomy: Autonomy) => void>();

/** Called wherever the Assistant's autonomy is written (routes/assistant.ts). */
export function notifyAssistantAutonomy(autonomy: Autonomy): void {
  for (const fn of [...assistantAutonomyListeners]) {
    try { fn(autonomy); } catch { /* one session's failure is its own */ }
  }
}

/** The `<live-context>` block for one owner turn, or '' when it cannot be built (never fatal). */
function assistantLiveContext(): string {
  try {
    let running: ReturnType<typeof runningAutomations> = [];
    let posts = 0;
    try { running = runningAutomations(); } catch { running = []; }
    try { posts = unreadAutomationPosts().length; } catch { posts = 0; }
    const events = listNotchEvents();
    const live = buildLiveContextParts({
      chats: listChats(),
      lookingAt: lookingAt(),
      running: running.map((r) => ({ vault: r.vault, slug: r.slug, since: r.since })),
      waiting: {
        finished: events.filter((e) => e.kind === 'finished').length,
        posts,
        account: events.filter((e) => e.kind === 'account').length,
      },
    });
    // A chat's `topic:` is other agents' words (fenced): the turn it rides in is tainted. The
    // owner's message cleared the taint before this block was built, so the turn ends tainted.
    if (live.carriesProjectText) markTainted();
    return live.text;
  } catch {
    return '';
  }
}

/** The character the owner gave the Assistant — its hidden vault's soul body, frontmatter
 *  stripped and capped (it rides in every turn's system prompt). '' when there is none. */
function readAssistantCharacter(): string {
  try {
    const raw = readFileSync(join(assistantContextRoot(), 'core', '0.soul.md'), 'utf-8');
    return raw.replace(/^---[\s\S]*?\n---\n?/, '').trim().slice(0, 1500);
  } catch { return ''; }
}

/** Whether a path may be interpolated into the login-shell command string the spawn builds
 *  (`exec claude "…" "…"`). Conservative allowlist — letters, digits and the handful of
 *  punctuation a real temp path uses — so nothing a shell would interpret (quote, `$`,
 *  backtick, `\`, `;`, whitespace) can reach the command line. Exported pure for tests. */
export function isShellSafePath(p: string): boolean {
  return /^[A-Za-z0-9/._-]+$/.test(p);
}

/** `isShellSafePath` for win32 (`C:\Users\…\Temp\…` never matches the POSIX allowlist, which
 *  silently dropped every Windows chat's briefing, `--agents` and `--settings` files). On win32
 *  the chat argv never goes through a shell (see `chatSpawnCommand`); the only shell that sees
 *  one of these paths is the mode-note hook's `cat "<path>"` (bash), where the double quotes
 *  cover spaces, `~` (8.3 short names), `'`, `;`, `|` and `&`. Still no `"`, `$`, backtick,
 *  `%`, `!`, line break or NUL. Exported pure for tests. */
export function isWin32SafeTmpPath(p: string): boolean {
  // Any letter, so a profile or project folder like `Öğretmen`, `Masaüstü` or `O'Brien` passes
  // (a stricter list silently dropped every chat file for those users). What stays out is what
  // is live inside bash double quotes (`"`, `$`, backtick), `%` and `!` (cmd expansion, should a
  // cmd ever see one), line breaks and NUL. `'`, `;`, `|`, `&` are literal inside the quotes.
  return /^[A-Za-z]:[\\/][^"$`%!\r\n\0]*$/u.test(p);
}

/** The path guard for this platform's tmp files. */
function tmpPathOk(p: string): boolean {
  return process.platform === 'win32' ? isWin32SafeTmpPath(p) : isShellSafePath(p);
}

/**
 * Stop a chat's claude. Off win32 this is exactly `child.kill()` / `child.kill(signal)`. On win32
 * the child is not a process-group leader, so a plain kill reaches claude alone and leaves the
 * hooks and tools under it running: the tree goes first (`taskkill /T`, via `killPortable`), then
 * the same `child.kill(...)` runs as the backstop (harmless on a dead child).
 */
export function reapChild(
  child: ChildProcessWithoutNullStreams,
  signal?: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  tree: (pid: number, signal: NodeJS.Signals) => void = killPortable,
): void {
  // Only a REAL ChildProcess: a test double carrying a made-up pid must never reach taskkill,
  // which would kill whatever unrelated process owns that pid on the developer's machine.
  if (platform === 'win32' && child instanceof ChildProcess && child.pid) {
    try { tree(-child.pid, signal ?? 'SIGTERM'); } catch { /* gone, or the backstop below */ }
  }
  if (signal) child.kill(signal);
  else child.kill();
}

/**
 * The process the chat spawns. POSIX: the user's interactive login shell running the quoted
 * `exec claude …` script (it supplies nvm/brew PATH), in its own process group. win32: there is
 * no login shell to ask, so `claude` is started directly with the argv array (no quoting layer),
 * NOT detached. Detaching on Windows means DETACHED_PROCESS (no console), so every console
 * program claude's hooks start would open a new visible one; a non-detached child with piped
 * stdio and `windowsHide` gets a hidden console its hooks inherit. libuv's kill-on-close job
 * then ties it to the server, which is the lifetime a chat wants. Exported pure for tests.
 */
export function chatSpawnCommand(o: {
  argv: string[];
  script: string;
  platform?: NodeJS.Platform;
  shell?: string;
}): { file: string; args: string[]; detached: boolean; windowsHide: boolean } {
  if ((o.platform ?? process.platform) === 'win32') {
    return { ...claudeDirectCommand(o.argv), detached: false, windowsHide: true };
  }
  return { file: o.shell ?? (process.env.SHELL || '/bin/zsh'), args: ['-ilc', o.script], detached: true, windowsHide: false };
}

/** Client-generated control-request id gate (setModel/rewind acks are matched client-side
 *  by this id, so it must round-trip verbatim): short token charset only, else '' (the
 *  caller substitutes a server-side randomUUID, losing only the client's ack matching). */
export function sanitizeControlId(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : '';
}

/**
 * Background-shell task id gate. The CLI mints these as a short lowercase-alphanumeric
 * token (`b6jwwtq1n`, observed on 2.1.220). This is the ONLY caller-supplied component of
 * the output path {@link backgroundOutputPath} builds, so the charset is deliberately
 * narrower than a generic slug: no dot, no slash, no dash, which makes `..`, an absolute
 * path, and a nested segment all structurally unrepresentable rather than merely filtered.
 * Exported pure for tests.
 */
export function sanitizeBackgroundTaskId(v: unknown): string {
  return typeof v === 'string' && /^[a-z0-9]{1,32}$/i.test(v) ? v : '';
}

/**
 * Where the CLI streams a backgrounded command's output:
 * `/tmp/claude-<uid>/<realpath(cwd) with '/'→'-'>/<conversationUuid>/tasks/<taskId>.output`.
 *
 * Empirically pinned against CLI 2.1.220 (see the task's spike record), including the two
 * things a reasonable guess gets wrong:
 *   • The base is HARDCODED `/tmp/claude-<uid>` — NOT `os.tmpdir()`/`$TMPDIR`. Verified by
 *     spawning with `TMPDIR` pointed elsewhere: other temp files honoured it, the task
 *     output still landed under `/tmp/claude-<uid>`.
 *   • The directory segment is the slug of the REALPATH of cwd, not of cwd as given (a cwd
 *     of `/tmp/x` produces `-private-tmp-x` on macOS, where `/tmp` → `/private/tmp`).
 *
 * Fully SERVER-DERIVED on purpose. The stream also hands the client an absolute
 * `output_file` on the tool_result and on `task_notification`, and that path is never
 * trusted or consumed — same rule the sub-agent drill-in follows for its sidechain
 * transcript. Everything here comes from the vault (server-resolved), the conversation uuid
 * (uuid-gated) and the task id (gated above), so no request value reaches the filesystem
 * unvalidated.
 */
export function backgroundOutputPath(cwd: string, conversationId: string, taskId: string): string | null {
  const id = sanitizeBackgroundTaskId(taskId);
  const uuid = sanitizeUuid(conversationId);
  if (!id || !uuid) return null;
  let real: string;
  try { real = realpathSync(cwd); } catch { real = cwd; }
  const slug = real.replace(/\//g, '-');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join('/tmp', `claude-${uid}`, slug, uuid, 'tasks', `${id}.output`);
}

// ─── Automation-bound resume gate (T24 — the security-critical check) ─────────────────
//
// THE THREAT: this route IS the resume gate. `bypass=1&resume=<uuid>` becomes a live
// `claude --resume <uuid> --permission-mode bypassPermissions` process (`permissionModeFor`
// above, `idArg`/`argv` in `startChatSession` below) with zero automations-awareness.
// Meanwhile an automation's session ids live in `automations/cache/<slug>.json` →
// `history[].sessionId`, which IS BRAIN-SYNCED — writable by anyone who can push to the
// shared brain. Planting a real session id there and then opening chat with
// `bypass=1&resume=<that-id>` would otherwise hand an attacker a fully-armed, unattended
// resume of a conversation they never ran. A resumable session id is a capability, and the
// synced cache is not an authority on which ones are live — see session-registry.ts's module
// doc for the full trust model this gate enforces.
//
// THE RULE (plan §11 R2, binding, quoted): "If `<uuid>` appears in ANY automation's
// `cache.history[].sessionId` for this project (the brain-synced, teammate-writable side)
// AND `isAutomationBoundSession(uuid)` returns null (the machine-local side), REJECT the
// upgrade. Otherwise proceed as today." Restricted to `bypass=1` connects — see the
// in-function comment on why a non-bypass resume is out of scope.
//
// UNCONDITIONAL: driven entirely by the `resume` uuid the caller must already supply to get
// anything at all — never behind a client-suppliable flag (an early draft proposed gating on
// a `kind:'automation'` tag; killed because an attacker simply omits it, which is not a gate).
//
// Compared on the RAW value `sanitizeUuid` returns: that function only validates against a
// case-preserving UUID regex (`UUID_RE`, agent-session-map.ts) — it does not case-fold or
// otherwise transform the string — so the value that reaches `--resume` is byte-identical to
// whatever a `history[].sessionId` entry recorded, and a plain `===` is the correct compare.
//
// Called from the upgrade handler BEFORE `startChatSession` (and therefore before
// `resolveAgentSession`) is even invoked, so a tab-session mapping can never launder an
// unbound automation session id into a resumable one: a `true` return here rejects the
// upgrade and returns immediately, so `startChatSession` — the ONLY place in this module
// that spawns the resumable `claude` process this gate exists to guard — is never reached.
// (A second, unrelated `spawn` lower in this file opens a file with the OS's default
// app/file-manager for the file-open HTTP route; it is not part of this WS upgrade path.)
/**
 * Will this open run `bypassPermissions`? The pane's flag, or an agent conversation at the Free
 * level (its level decides its mode, agents/permission.ts, whatever the pane says). The T24 gate
 * below guards exactly the resumes this is true for.
 */
export function resumeRunsBypass(bypass: boolean, contextRoot: string, chatAgent: string | null): boolean {
  if (bypass) return true;
  return !!chatAgent && getRunTarget(contextRoot, chatAgent, 'agent')?.autonomy === 'free';
}

/** True when any of `ids` is a task step's session on this machine (registry or binding tag). */
export function refusesTaskSession(contextRoot: string, ids: readonly (string | null | undefined)[], home?: string): boolean {
  return ids.some((id) => !!id && taskOfAnySession(contextRoot, id, home) !== null);
}

export function shouldRejectAutomationResume(
  bypass: boolean,
  resumeId: string,
  contextRoot: string,
  home: string = homedir(),
): boolean {
  // The capability this gate protects is `bypassPermissions` specifically. A non-bypass
  // resume of the very same uuid only ever reaches `auto` mode (permissionModeFor(false)),
  // which still prompts for anything not auto-approved — not the unattended, fully-armed
  // capability a planted synced session id would otherwise buy. Gating bypass=0 too would
  // reject already-safe resumes for no security benefit, so this is a no-op whenever
  // `bypass` is false or there is no resume id to check at all — exactly R2's own framing
  // ("on every bypass=1&resume=<uuid> connect").
  if (!bypass || !resumeId) return false;

  // Brain-synced side: does ANY automation's CACHE FILE on this project claim this uuid?
  //
  // Enumerated from `automations/cache/*.json` DIRECTLY — never derived from
  // `listAutomations` (which enumerates MANIFESTS, `automations/<slug>.md`). A cache and its
  // manifest are two independent files, BOTH teammate-writable over brain sync: an attacker
  // who can plant `automations/cache/evil.json` can just as easily decline to plant
  // `automations/evil.md`, and a manifest-driven scan would silently never look at that
  // file. Whether "every surface that hands out a session id also writes a manifest" holds
  // today is a fact about OTHER code (chat hydration, Telegram) that this gate must not
  // depend on to stay correct — so a cache file with no manifest is scanned exactly like any
  // other.
  //
  // Every filename is put through `isSafeAutomationSlug` before it is used to build a path
  // (via `readAutomationCache`) — the same discipline `session-registry.ts` applies to a
  // slug it reads off disk rather than one it already validated upstream. This also happens
  // to filter out the directory's OTHER dotfiles for free: `.<slug>.run.json` (the sidecar)
  // and `.<slug>.lock` both start with `.`, which `isSafeAutomationSlug` rejects.
  //
  // Scanned defensively at TWO levels, because the source is teammate-writable and this read
  // must never take the whole route down:
  //   - the directory listing itself is wrapped, so an unreadable `automations/cache/`
  //     directory (missing, or a stray file sitting where the directory should be) degrades
  //     rather than throwing;
  //   - each cache file's read is wrapped INDIVIDUALLY, so one malformed cache cannot blind
  //     the scan of every OTHER automation's (well-formed) cache.
  // Either way, a read failure degrades to "not claimed" — i.e. today's unchanged behaviour
  // for that uuid. That is a deliberate choice of the AVAILABLE side over the paranoid one:
  // this check exists to close one specific capability leak (a planted synced session id),
  // and it is not this uuid's fault that some OTHER automation's cache is corrupt. Degrading
  // to "reject" instead would let one bad cache file black out every chat resume on the
  // machine — an availability outage far larger than the leak being closed, and orthogonal
  // to it (a non-automation uuid was never at risk either way).
  const CACHE_FILE_SUFFIX = '.json';
  let cacheFileNames: string[] = [];
  try { cacheFileNames = readdirSync(automationCacheDir(contextRoot)); } catch { cacheFileNames = []; }
  // A global agent's cache lives in its own folder for this project (D1): its runs count too.
  for (const slug of listGlobalAgentSlugs()) {
    if (isGlobalAgentHere(contextRoot, slug)) cacheFileNames.push(`${slug}${CACHE_FILE_SUFFIX}`);
  }

  const claimedByAutomation = cacheFileNames.some((name) => {
    if (!name.endsWith(CACHE_FILE_SUFFIX)) return false;
    const slug = name.slice(0, -CACHE_FILE_SUFFIX.length);
    if (!isSafeAutomationSlug(slug)) return false;
    try {
      const cache = readAutomationCache(contextRoot, slug);
      const history = Array.isArray(cache?.history) ? cache.history : [];
      return history.some((event) => event && event.sessionId === resumeId);
    } catch {
      return false;
    }
  });
  if (!claimedByAutomation) return false;

  // Machine-local side: did THIS machine's runner actually record this session under SOME
  // automation? `isAutomationBoundSession` (session-registry.ts) is the reverse lookup this
  // gate exists to call — it never throws, and returns null for anything it did not itself
  // write. It is DELIBERATELY slug-agnostic (it scans every `.sessions.json` file and
  // returns whichever slug owns the uuid, if any), so a uuid bound under automation A but
  // planted into automation B's synced cache still resolves as bound: the machine-local
  // binding is the authority on whether this uuid is a real, already-granted capability,
  // and slug identity is irrelevant to that question — it only matters to the (unrelated)
  // per-conversation lookup `readAutomationSession(slug, sessionId)` uses elsewhere (e.g.
  // "reply to THIS automation's thread"). See the test file for the worked example.
  return isAutomationBoundSession(resumeId, home) === null;
}

// ─── WS upgrade ─────────────────────────────────────────────────────────────────────

// ─── Phone device sockets follow their device (AC3) ─────────────────────────────────
//
// Mac mode checks a device session when a phone chat socket opens. A socket already open, and the
// child it drives (detached or not), must not outlive its device: revoke-all, a password
// change and a single logout notify handsfree-auth's listener, and every session whose owning
// device is no longer valid is closed with 4401 and cut. Each frame re-checks too (defence in
// depth: a device that expired between notifications). Laptop sockets are never tagged.

/** WS close code for "your device was signed out". */
export const DEVICE_REVOKED_CLOSE = 4401;

/**
 * The device a phone chat socket authenticated with: which store judged it, and the sha256 of
 * its id (never the cookie). OWNERSHIP IS PER SOCKET (Mac mode): a session's owner is the
 * device of the socket bound to it RIGHT NOW (kept across a detach, cleared the moment a
 * desktop socket adopts it), whoever spawned it.
 */
export interface DeviceTag { store: 'mac'; idHash: string }

const socketDevice = new WeakMap<object, DeviceTag>();
/** Whether a phone socket last said its chat is visible on screen (`{type:'visibility'}`). */
const socketVisible = new WeakMap<object, boolean>();

/**
 * The device (id hash) whose phone shows chat `sessionId` (its pin id) on screen right now, or
 * null: the chat's live holder is a phone socket that said it is visible. A chat the laptop
 * holds, or an unpinned one (no live entry), suppresses nothing.
 */
export function phoneDeviceShowing(sessionId: string): string | null {
  const holder = findLiveChat(sessionId)?.holder?.() ?? null;
  if (!holder) return null;
  const tag = socketDevice.get(holder);
  return tag && socketVisible.get(holder) === true ? tag.idHash : null;
}
/** Every live chat session in this process — desktop-spawned ones included, because a phone
 *  may adopt any of them. */
const deviceSessions = new Set<{ device: () => DeviceTag | null; revoke: () => void; releasePhone: () => boolean }>();
/** The remote mirrors of every live chat that has them (lib/super/phone-mirror.ts): a Super
 *  Agent's (read and chat) and a Super child's (watch-only, made on its first watch). Closed by
 *  the same revocation and return as the sessions above, and by the chat's own end. */
const superMirrorSets = new Set<MirrorSet<DeviceTag>>();
/** Owner frames that came from a phone mirror (written at once like every owner frame, or
 *  re-fed to a successor; the mark rides on the frame itself). */
const mirrorFrames = new WeakSet<Buffer>();
/** The agenda digest each Super Agent's phone mirrors were last sent, by session: an unchanged
 *  one is not sent again. Cleared when no mirror is joined and whenever one joins. */
const digestKeys = new Map<string, string>();
/** When each session's last digest went ({@link digestClock}): a join snapshot read before a
 *  newer push is not sent after it. */
const digestSeq = new Map<string, number>();
/** One clock for every session's pushes and joins: only ever goes up, so a successor under the
 *  same session id (a restart in place) never reads an older chat's count as its own. */
let digestClock = 0;
// Every push of a super record tells that vault's live Super Agent's phone mirrors its agenda
// (lib/super/inbox.ts `pushSuperState`), computed only when a mirror of THIS project is joined.
setSuperDigestSink((contextRoot, state) => {
  const sid = state.session;
  const entry = sid ? findLiveChat(sid) : null;
  if (!sid || !entry?.mirrorFrame || !entry.mirrorCount) return;
  if (resolve(join(entry.projectRoot, '_dream_context')) !== resolve(contextRoot)) return;
  if (entry.mirrorCount() === 0) { digestKeys.delete(sid); stageKeys.delete(sid); return; }
  // The remote stage (a computer or tablet on the tunnel draws it), allowlisted: sent when it
  // changed, before the digest so an agenda never names a card the stage has not drawn yet.
  const stage = JSON.stringify({ type: '_meta', subtype: SUPER_STAGE_FRAME, state: remoteViewOf(contextRoot, state) });
  if (stageKeys.get(sid) !== stage) {
    entry.mirrorFrame(stage);
    stageKeys.set(sid, stage);
  }
  const d = superDigest(state);
  if (digestKeys.get(sid) === d.key) return;
  digestSeq.set(sid, ++digestClock);
  entry.mirrorFrame(superDigestFrame(d));
  // Marked sent only once it went: a send that threw is tried again by the next push.
  digestKeys.set(sid, d.key);
});
/** The remote stage frame each Super Agent's mirrors were last sent, by session. */
const stageKeys = new Map<string, string>();

// ─── Phone-held (hands-free sekmeler W1): a phone never holds a Super child ──────

/** Phone opens in flight, by conversation id (lowercased): counted from the open's decision
 *  until it binds, is refused or its socket closes. */
const phoneOpening = new Map<string, number>();

/** Count a phone open of these ids as in flight. Returns its release (idempotent). */
export function notePhoneOpening(ids: readonly string[]): () => void {
  const keys = [...new Set(ids.filter(Boolean).map((id) => id.toLowerCase()))];
  for (const k of keys) phoneOpening.set(k, (phoneOpening.get(k) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const k of keys) {
      const n = (phoneOpening.get(k) ?? 0) - 1;
      if (n > 0) phoneOpening.set(k, n); else phoneOpening.delete(k);
    }
  };
}

/** Tests only: phone opens still counted. */
export function phoneOpeningCountForTests(): number {
  let n = 0;
  for (const v of phoneOpening.values()) n += v;
  return n;
}

/**
 * THE definition of "phone-held": the live chat's holder socket is a phone socket (tagged in
 * `socketDevice`; not `phoneDeviceShowing`, which also asks for a visible screen), or a phone open
 * naming it is in flight. Ids compared case-blind. The store asks it on every record write.
 */
export function phoneHolds(sessionId: string): boolean {
  const id = sessionId.toLowerCase();
  if (!id) return false;
  if ((phoneOpening.get(id) ?? 0) > 0) return true;
  for (const cand of new Set([sessionId, id])) {
    const holder = findLiveChat(cand)?.holder?.() ?? null;
    if (holder && socketDevice.get(holder)) return true;
  }
  return false;
}
setPhoneHoldsProbe(phoneHolds);

let deviceRevocationArmed = false;

export function tagDeviceSocket(ws: object, tag: DeviceTag): void {
  socketDevice.set(ws, tag);
}

function deviceStillValid(tag: DeviceTag): boolean {
  return macHandsfreeAuth().store.isValidDeviceHash(tag.idHash);
}

function armDeviceRevocation(): void {
  if (deviceRevocationArmed) return;
  deviceRevocationArmed = true;
  onDeviceSessionsChanged(() => { revokeStaleDeviceSessions(); });
}

/** Close (and, per the store's rule, cut) every chat session whose owning device is no longer
 *  valid in ITS store. Returns how many. */
export function revokeStaleDeviceSessions(): number {
  let n = 0;
  for (const s of [...deviceSessions]) {
    const d = s.device();
    if (d && !deviceStillValid(d)) { s.revoke(); n++; }
  }
  for (const m of superMirrorSets) n += m.revokeStale();
  return n;
}

/**
 * Mac mode's RETURN (planned, never an incident): every session a phone holds lets go of it —
 * its socket is closed 4401 and the child DETACHES (keeps running, adoptable by the desktop);
 * nothing is cut. Run BEFORE the Mac devices are revoked, so the revocation finds no phone-owned
 * session left to cut. Returns how many sessions a phone held.
 */
export function releasePhoneSessions(): number {
  let n = 0;
  for (const s of [...deviceSessions]) if (s.releasePhone()) n++;
  for (const m of superMirrorSets) n += m.closeAll(MIRROR_CLOSE_REVOKED, 'mac mode ended');
  return n;
}

/** Tests only: how many sessions the device registry tracks. */
export function deviceSessionCountForTests(): number {
  return deviceSessions.size;
}

/**
 * GET /api/agent/live-chats — every chat child running in this process, for the phone drawer's
 * "Mac'te açık" section: the conversation, its project's registered NAME, its tab title and
 * whether a turn runs. Never a path. Gated like its neighbours (`isAgentRequest`): the desktop
 * on loopback, a phone with its device session.
 */
export async function handleAgentLiveChats(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAgentRequest(req)) { sendError(res, 403, 'forbidden', 'Available only in the desktop app.'); return; }
  const byPath = new Map(listVaults().map((v) => [v.path.replace(/\/+$/, ''), v.name]));
  // A phone sees only the chosen projects' chats (AC16), never an unregistered folder's.
  const phone = isPhoneSocket(req);
  const visible = (vault: string | null): boolean => !phone || (vault !== null && isMacExposed(vault));
  const registry = listChats();
  const snapshot = liveChatsSnapshot();
  const chats: LiveChatWire[] = snapshot
    .filter((e) => !e.draining)
    .map((e) => {
      const vault = byPath.get(e.projectRoot.replace(/\/+$/, '')) ?? null;
      const entries = registry.filter((r) => r.conversationId === e.conversationId);
      return {
        conversationId: e.conversationId, vault, title: vault ? liveChatTitle(e.projectRoot, e.conversationId) : null,
        busy: e.busy, state: liveChatState(e.busy, entries.map((r) => r.status)),
        lastLine: vault ? liveChatLastLine(entries) : null,
        updatedAt: liveChatUpdatedAt(e, entries),
      };
    })
    .filter((c) => visible(c.vault));
  // AC18: conversations still finishing after a takeover — never listed as a past chat either.
  const draining = snapshot
    .filter((e) => e.draining && visible(byPath.get(e.projectRoot.replace(/\/+$/, '')) ?? null))
    .map((e) => e.conversationId);
  // A phone talks to a handed-over project's Super Agent only: one row, none of its chats.
  if (!phone) { sendJson(res, 200, { chats, draining }); return; }
  const handedOver = new Map<string, string>();
  for (const [path, name] of byPath) {
    if (!visible(name)) continue;
    const idx = superIndex(join(path, '_dream_context'));
    if (idx.enabled && idx.session) handedOver.set(name, idx.session);
  }
  const view = phoneLiveChats(chats, handedOver);
  sendJson(res, 200, view.supers.length ? { chats: view.chats, draining, supers: view.supers } : { chats, draining });
}

/** AC18: what the drawer says about a live chat. A question waiting wins; then a turn running
 *  (the live entry's own `busy`, or a registry entry working); else idle. A chat that is only
 *  `starting` has been sent nothing (the CLI announces itself on the first message; a sent
 *  message makes it busy), so it is idle: "Working" there would never end. */
export function liveChatState(busy: boolean, statuses: readonly ChatStatus[]): LiveChatWire['state'] {
  const live = statuses.filter((s) => s !== 'gone');
  if (live.includes('asking')) return 'asking';
  if (busy || live.includes('working')) return 'working';
  return 'idle';
}

/** AC21: when a live chat last moved (epoch ms), for the list's age: a turn starting or ending,
 *  or a registry entry changing state (a question, a permission). null when none is known. */
export function liveChatUpdatedAt(
  e: { turnStartedAt: number | null; lastTurnEndedAt: number | null },
  entries: readonly Pick<ChatEntry, 'updatedAt'>[],
): number | null {
  const times = [e.turnStartedAt ?? 0, e.lastTurnEndedAt ?? 0, ...entries.map((r) => Date.parse(r.updatedAt) || 0)];
  const newest = Math.max(...times);
  return newest > 0 ? newest : null;
}

/** AC19: the one line the phone stack shows under a live chat. A waiting question wins (its text);
 *  a permission shows only its TOOL NAME (never the command or path, as the push does); else the
 *  last line of the newest assistant text. Whitespace collapsed, clipped to 140 with `…`. */
export function liveChatLastLine(entries: readonly Pick<ChatEntry, 'status' | 'pendingQuestion' | 'lastAssistantText'>[]): string | null {
  const live = entries.filter((e) => e.status !== 'gone');
  const clip = (t: string): string | null => {
    const one = t.replace(/\s+/g, ' ').trim();
    if (!one) return null;
    return one.length > 140 ? `${one.slice(0, 139)}…` : one;
  };
  const asking = live.find((e) => e.pendingQuestion);
  if (asking?.pendingQuestion) {
    const q = asking.pendingQuestion;
    return q.isPermission ? clip(q.toolName) : clip(q.text.split('\n').find((l) => l.trim()) ?? '');
  }
  for (const e of [...live].reverse()) {
    const newest = e.lastAssistantText[e.lastAssistantText.length - 1];
    if (!newest) continue;
    const lines = newest.split('\n').map((l) => l.trim()).filter(Boolean);
    const line = clip(lines[lines.length - 1] ?? '');
    if (line) return line;
  }
  return null;
}

/** The tab title a live conversation carries in the desktop roster (or the phone's), if any. */
function liveChatTitle(projectRoot: string, conversationId: string): string | null {
  for (const file of ['.agent-sessions.json', '.agent-sessions.phone.json']) {
    try {
      const roster = JSON.parse(readFileSync(join(projectRoot, '_dream_context', 'state', file), 'utf-8')) as { sessions?: Array<{ sessionId?: unknown; title?: unknown }> };
      const hit = roster.sessions?.find((m) => m && m.sessionId === conversationId);
      if (hit && typeof hit.title === 'string' && hit.title.trim()) return hit.title.slice(0, 120);
    } catch { /* absent or unreadable */ }
  }
  return null;
}

/**
 * The passive reattach's liveness probe (Mac mode, contract.ts): ping the holder and wait up to
 * {@link HOLDER_PROBE_MS} for its pong. 'alive' = a live client holds the chat (the new socket
 * must not evict it); 'dead' = no pong (half-open: a dropped phone, the client's own dead
 * connection); 'gone' = the holder closed during the probe. ONE probe per holder at a time: a
 * second passive open shares the first one's result. The pong listener is removed when it ends.
 */
const holderProbes = new WeakMap<object, Promise<'alive' | 'dead' | 'gone'>>();
export function probeHolder(holder: import('ws').WebSocket, ms: number = HOLDER_PROBE_MS): Promise<'alive' | 'dead' | 'gone'> {
  const running = holderProbes.get(holder);
  if (running) return running;
  const p = new Promise<'alive' | 'dead' | 'gone'>((resolveProbe) => {
    let done = false;
    const finish = (v: 'alive' | 'dead' | 'gone'): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      holder.off('pong', onPong);
      holder.off('close', onClose);
      holderProbes.delete(holder);
      resolveProbe(v);
    };
    const onPong = (): void => finish('alive');
    const onClose = (): void => finish('gone');
    const timer = setTimeout(() => finish('dead'), ms);
    holder.on('pong', onPong);
    holder.on('close', onClose);
    if (holder.readyState !== holder.OPEN) { finish('gone'); return; }
    try { holder.ping(); } catch { finish('gone'); }
  });
  holderProbes.set(holder, p);
  return p;
}

/**
 * A passive reattach on an accepted socket: adopt a DETACHED child at once; when a socket still
 * holds it, probe that holder — no pong → adopt (the half-open holder is terminated, as
 * before); a pong → close the NEW socket {@link MAC_CLOSE_TAKEN_OVER}, evicting nobody. Before
 * adopting, the probed socket must still be the holder; else the new holder is probed. Returns
 * false when the child could not be adopted (exiting) — the caller then resumes it fresh.
 */
export async function passiveAdopt(
  entry: LiveChatEntry,
  ws: import('ws').WebSocket,
  /** Re-checked at the moment of binding: true = the chat became a Super child meanwhile, so a
   *  phone must not bind it (the caller makes the socket a watch-only mirror or closes it 4403);
   *  the frames held for the bind are dropped, never replayed into a read-only mirror. */
  handedOver?: () => boolean,
): Promise<'adopted' | 'taken' | 'aborted' | 'unadoptable' | 'handed_over'> {
  // The client sees its socket OPEN the moment the upgrade completes, but the chat binds it only
  // once the probe has decided (up to HOLDER_PROBE_MS). A frame sent in that window (the owner
  // typing right after a reconnect) is held here and replayed into the chat after the adopt —
  // never silently dropped (found by scripts/verify/handsfree-mac.mjs, M8).
  // Until the chat binds it (and for good on a 4409), nothing else listens for 'error' on this
  // socket: one malformed frame would be an unhandled 'error' event and exit the server. ws
  // closes the socket itself on a protocol error, so the probe below ends as 'aborted'.
  ws.on('error', () => { /* the close that follows is what we act on */ });
  const held: Array<Buffer | string> = [];
  const hold = (d: Buffer | string): void => { if (held.length < 64) held.push(d); };
  ws.on('message', hold);
  const adoptNow = (): 'adopted' | 'unadoptable' | 'handed_over' => {
    ws.off('message', hold);
    if (handedOver?.()) { held.length = 0; return 'handed_over'; }
    if (!entry.adopt(ws)) return 'unadoptable';
    for (const d of held.splice(0)) ws.emit('message', d);
    return 'adopted';
  };
  try {
    for (let round = 0; round < 8; round++) {
      if (ws.readyState !== ws.OPEN) return 'aborted';
      const holder = entry.holder ? entry.holder() : null;
      if (!holder || holder === ws) return adoptNow();
      const verdict = await probeHolder(holder);
      if (ws.readyState !== ws.OPEN) return 'aborted';
      const now = entry.holder ? entry.holder() : null;
      if (now !== holder) continue;            // someone else adopted meanwhile: probe the new one
      if (verdict === 'alive') {
        try { ws.close(MAC_CLOSE_TAKEN_OVER, 'taken_over'); } catch { /* gone */ }
        return 'taken';
      }
      return adoptNow();
    }
    try { ws.close(MAC_CLOSE_TAKEN_OVER, 'taken_over'); } catch { /* gone */ }
    return 'taken';
  } finally {
    ws.off('message', hold);
  }
}

/**
 * Attach the agent-chat WebSocket upgrade handler to the shared http server.
 * Path: `/api/agent/chat?vault=<name>&bypass=0|1&(sessionId|resume)=<uuid>&model=<alias>
 * &effort=<lvl>&mode=basic|plan|develop&promptToken=<token>&prompt=<inline>&deferPrompt=0|1`.
 * No-ops (rejects the upgrade) unless the desktop gate is on and the peer is trusted:
 * loopback, or — with remote access explicitly enabled — a token-bearing tailnet device
 * (see `remote-access.ts` for why that gate wants all three facts at once). `networkToken`
 * is the server's per-process credential, null on a loopback bind where none is minted.
 */
/** Lean MCP subsets a killed server left behind are swept once, at the first attach (D14). */
let leanSwept = false;

export function attachAgentChat(server: Server, opts: { networkToken?: string | null; windowControlPort?: number } = {}): void {
  if (!leanSwept) { leanSwept = true; try { sweepLeanMcpDir(); } catch { /* next start */ } }
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url || '/', `http://${req.headers.host}`); }
    catch { socket.destroy(); return; }
    if (url.pathname !== '/api/agent/chat') return; // not ours — leave for others

    const vault = url.searchParams.get('vault');

    // The dreamcontext Assistant's hidden vault: loopback + desktop, UNCONDITIONALLY. This
    // branch runs BEFORE the tailnet OR below, so a remote peer holding a valid network token
    // never reaches the assistant — its session carries a credential that drives every project.
    const assistant = isAssistantVault(vault);
    const phone = isPhoneSocket(req);
    if (phone) {
      // Mac mode's phone listener: cloudflared dials from 127.0.0.1, so nothing here is trusted
      // for being loopback. Only a MAC device session with the tunnel's own Origin opens a chat
      // (the listener's upgrade gate checked these first; again here so this never relies on
      // its order). The Assistant never runs for a phone.
      if (assistant || !isAgentRequest(req) || !isMacOriginAllowed(req)) { rejectUpgrade(socket, 403); return; }
      // AC16: only the projects chosen at start — a chat of any other project is refused.
      if (!isMacExposed(vault)) { rejectUpgrade(socket, 403); return; }
    } else if (assistant) {
      if (!isDesktop() || !isLoopback(req)) { rejectUpgrade(socket, 403); return; }
      // …and only from the app's own pages: a website the owner visits is loopback too.
      if (isForeignOriginUpgrade(req)) { rejectUpgrade(socket, 403); return; }
      // …and only from THIS origin, port included, under a loopback Host (T0): an approved
      // dev server on another loopback port, or a rebinding page, is not the app.
      if (!isSameOriginStrict(req)) { rejectUpgrade(socket, 403); return; }
      if (!assistantExists()) { rejectUpgrade(socket, 400); return; }
    } else {
      // A loopback peer must be this very origin (T0: a page on another loopback port could
      // otherwise drive a `bypass=1` session); a tailnet peer keeps its own three-fact gate.
      const trusted = isLoopback(req)
        ? isSameOriginStrict(req)
        : isTrustedRemotePeer(req, opts.networkToken ?? null);
      if (!isDesktop() || !trusted) { rejectUpgrade(socket, 403); return; }
    }

    const projectRoot = resolveVaultProjectRoot(vault, { allowAssistant: assistant });
    if (!projectRoot) { rejectUpgrade(socket, 400); return; }

    const bypass = url.searchParams.get('bypass') === '1';
    const sessionId = sanitizeUuid(url.searchParams.get('sessionId'));
    const resumeId = sanitizeUuid(url.searchParams.get('resume'));
    const model = sanitizeModel(url.searchParams.get('model'));
    const effort = sanitizeEffort(url.searchParams.get('effort'));
    // Selects a system-prompt append, not an argv element — an unknown value degrades to
    // plain Claude Code rather than to a half-applied mode. See sanitizeChatMode.
    const mode = sanitizeChatMode(url.searchParams.get('mode'), vault);
    // A Super Agent's delegated child (orchestration plan r5 D14): `lean=1` and the MCP servers
    // its job named (`mcp=a,b`). Lean only ever NARROWS what a chat gets, so a forged `lean=1`
    // costs its sender servers; the names are re-checked here against the servers the user
    // really has (own keys), and again when the subset is written. Never the Assistant or a
    // Super Agent's own session.
    // A child the super record names is lean from its RECORD, whatever the URL says (a window
    // that reloaded before the record arrived asks for nothing); the URL's `lean` covers a child
    // opened before its record lands. A name the user no longer has is DROPPED, never widened,
    // never a refusal that would lock the conversation out.
    const lean = leanMcpForUpgrade({
      assistant, mode, conversation: resumeId || sessionId, lean: url.searchParams.get('lean'), mcp: url.searchParams.get('mcp'),
      recorded: delegatedChildMcp, known: () => knownMcpServers(projectRoot),
    });
    if (lean === 'refuse') { rejectUpgrade(socket, 400); return; }
    const leanMcp = lean ?? undefined;
    // The project's Super Agent (plan-r7 D3): exactly ONE super session per vault, the one the
    // hand-over recorded (`POST /api/super/enable` mints it). A different id is a second super
    // agent and is refused; a same-id respawn (account switch, Resume, reattach) passes. The
    // phone never runs the hand-over (D4), and no session recorded yet means no super chat.
    // A phone and a handed-over Super Agent (lib/super/phone-mirror.ts): the phone joins the
    // live super chat as a MIRROR beside the window that holds it, never adopting, superseding or
    // respawning it; any other phone open naming that session, and `mode=super`, is refused.
    const superCtx = join(projectRoot, '_dream_context');
    const superIdx = superIndex(superCtx);
    const liveSuper = superIdx.session ? findLiveChat(superIdx.session) : null;
    const phoneSuper = phone
      ? phoneSuperOpen({ mode, resumeId, sessionId, index: superIdx, liveSuper: !!liveSuper?.mirror && liveSuper.projectRoot === projectRoot })
      : 'pass';
    if (phoneSuper === 'refuse') { rejectUpgrade(socket, 403); return; }
    if (phoneSuper === 'mirror') {
      const mirrorHash = authFor(req) ? deviceIdHash(req) : null;
      const mirrorTag: DeviceTag | null = mirrorHash ? { store: 'mac', idHash: mirrorHash } : null;
      if (!mirrorTag || !liveSuper?.mirror) { rejectUpgrade(socket, 403); return; }
      // Full of OTHER devices: refused before the handshake, so the client backs off instead of
      // opening and being closed in a loop.
      if (!liveSuper.mirrorRoom?.(mirrorTag)) { rejectUpgrade(socket, 503); return; }
      void (async () => {
        let WebSocketServer: typeof import('ws').WebSocketServer;
        try { ({ WebSocketServer } = await import('ws')); }
        catch { rejectUpgrade(socket, 501); return; }
        new WebSocketServer({ noServer: true }).handleUpgrade(req, socket, head, (ws) => {
          // FIRST: a protocol error on a socket nobody listens to would be an unhandled 'error'
          // and exit the server (a refused mirror below has no other listener).
          ws.on('error', () => { /* the close that follows is what counts */ });
          tagDeviceSocket(ws, mirrorTag);
          // The child may have ended meanwhile: the client reconnects and is decided again.
          if (!liveSuper.mirror?.(ws, mirrorTag)) {
            try { ws.close(MIRROR_CLOSE_ENDED, 'super ended'); } catch { /* gone */ }
            const t = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 1000);
            t.unref?.();
          }
        });
      })();
      return;
    }
    // A Super Agent child while its project is handed over (hands-free sekmeler D6): a remote
    // screen WATCHES it, beside the Mac window that holds it, and never adopts, supersedes,
    // evicts or respawns it — whatever the mode, reattach value or id case. Not live: refused.
    if (phone) {
      const child = [resumeId, sessionId].find((id) => !!id && isHandedOverChild(id));
      if (child) { watchChild(req, socket, head, child, superCtx); return; }
    }
    const superRefused = superUpgradeRefusal({ mode, phone, contextRoot: superCtx, resumeId, sessionId });
    if (superRefused) { rejectUpgrade(socket, superRefused); return; }
    // Which Claude ACCOUNT this session runs on. '' = none requested, which resolves to the
    // preferred account (and, with no preferred account, to account #0 — the real HOME, i.e.
    // exactly today's behaviour). An id that is not in the register is REFUSED below rather
    // than downgraded to HOME: running a prompt on an account the user did not pick is worse
    // than an error.
    const account = sanitizeAccountId(url.searchParams.get('account'));
    // THREE meanings of "assistant" meet in this handler — keep them apart:
    //   • `assistant` above — the HIDDEN VAULT `__assistant__` (the Assistant's own session);
    //   • mode `assistant` — the CHAT MODE that vault runs in (its briefing);
    //   • `origin=assistant` — a DELEGATION: an ordinary project chat the Assistant opened.
    // The origin is read only for project chats. It lowers recall cost and the effort default
    // and grants no capability, so a forged one from a loopback page buys nothing.
    const fromAssistant = !assistant && url.searchParams.get('origin') === 'assistant';
    // A whiteboard agent card's own conversation (lib/whiteboards/card-chat.ts). The client
    // names the card; the server decides the agent's envelope from the slugs. A malformed pair,
    // or one aimed at the Assistant's vault, is refused rather than opened as a plain chat.
    const cardAsked = url.searchParams.has('cardAgent') || url.searchParams.has('cardBoard');
    const card = cardAsked && !assistant
      ? parseCardRef(url.searchParams.get('cardAgent'), url.searchParams.get('cardBoard'))
      : null;
    if (cardAsked && !card) { rejectUpgrade(socket, 400); return; }
    // An agent spoken to in a Chat tab (the composer's agent picker). Same rule: a malformed
    // slug, one aimed at the Assistant's vault, or one beside a card is refused, never opened
    // as a plain chat that only looks like the agent.
    const agentAsked = url.searchParams.has('chatAgent');
    const chatAgent = agentAsked && !assistant && !card ? parseChatAgent(url.searchParams.get('chatAgent')) : null;
    if (agentAsked && !chatAgent) { rejectUpgrade(socket, 400); return; }
    // The agent's STAGE (AI Team page): an agent chat whose first accepted conversation becomes
    // the stage's home session, recorded once in the machine-local store (lib/local-store.ts).
    const stageAgent = chatAgent && url.searchParams.get('stage') === '1' ? chatAgent : null;

    // T24 — the automation-bound resume gate (see the block comment on
    // `shouldRejectAutomationResume` above). Evaluated HERE, before `startChatSession` is
    // called at all (and therefore before `resolveAgentSession`, currently agent-chat.ts:250),
    // so a tab-session mapping can never launder an unbound automation session id into a
    // resumable one.
    if (shouldRejectAutomationResume(resumeRunsBypass(bypass, join(projectRoot, '_dream_context'), chatAgent), resumeId, join(projectRoot, '_dream_context'))) {
      rejectUpgrade(socket, 403);
      return;
    }
    // A task step's session never opens in a chat tab (AI Team v2 C1-14): only its task host
    // resumes it, under its step's envelope and in its worktree. Server-side, so the pane's
    // `bypass` flag changes nothing; the stage shows its transcript read-only instead.
    if (refusesTaskSession(join(projectRoot, '_dream_context'), [resumeId, sessionId])) {
      rejectUpgrade(socket, 403);
      return;
    }

    // Prompt hand-off (AC3 parity with the terminal — see agent-spawn-shared.ts): a
    // SUPPLIED-BUT-INVALID token rejects the upgrade rather than silently opening an
    // unseeded session (a bad token is exactly the failure the token exists to prevent).
    const redeemed = redeemPromptToken(url.searchParams.get('promptToken'), vault);
    if (redeemed === null) { rejectUpgrade(socket, 401); return; }
    const initialPrompt = redeemed || sanitizePrompt(url.searchParams.get('prompt'));
    const deferPrompt = url.searchParams.get('deferPrompt') === '1';
    // The client's own reconnect after a dropped socket (chatSession.ts): adopt the live child
    // for `resume` if one is detached or still bound to a dead socket, never spawn a twin.
    // The Assistant's notch never detaches (its socket is the relay's only channel).
    // `reattach=1` (REATTACH_EVICT) is an explicit tap: it takes the chat even from a live holder,
    // who is closed 4409. `reattach=passive` is every AUTOMATIC open (backoff reconnect, reload
    // restore): it never evicts a live holder (see passiveAdopt).
    const reattachValue = url.searchParams.get('reattach');
    const reattach = (reattachValue === REATTACH_EVICT || reattachValue === REATTACH_PASSIVE) && !!resumeId && !assistant;
    const passive = reattach && reattachValue === REATTACH_PASSIVE;

    // A phone open is in flight from here until it binds, is refused or its socket closes: a
    // hand-over or `super adopt` meanwhile skips this chat (phoneHolds).
    const releaseOpening = phone ? notePhoneOpening([resumeId, sessionId]) : () => { /* not a phone */ };
    socket.once('close', releaseOpening);
    void (async () => {
      let WebSocketServer: typeof import('ws').WebSocketServer;
      try { ({ WebSocketServer } = await import('ws')); }
      catch { releaseOpening(); rejectUpgrade(socket, 501); return; }

      // A live child for this conversation (see agent-chat-live.ts). A reattach adopts it; any
      // OTHER connection naming it is a respawn (account, mode, Resume) and the child must give
      // the conversation up, exactly as a closed socket made it do before detaching existed.
      const live = findLiveChat(resumeId);
      const ctx = join(projectRoot, '_dream_context');
      const open = chatOpenDecision({
        phone, live, projectRoot, reattach,
        foreignTranscript: phone && [resumeId, sessionId].some((cid) => !!cid && phoneTranscriptRefused(req, ctx, liveTranscriptPath(ctx, cid))),
      });
      if (open.refuse) { releaseOpening(); rejectUpgrade(socket, 403); return; }
      const adoptable = open.adopt;
      // PROVISIONAL: a second tab opening the same conversation is refused below while the
      // first one still holds it, and a refused open must not cost the first pane its detach.
      // So the mark is withdrawn unless this open is actually accepted.
      let pendingSupersede = open.supersede ? open.supersede.supersede() : null;
      const settleSupersede = (accepted: boolean): void => {
        pendingSupersede?.(accepted);
        pendingSupersede = null;
      };
      // An upgrade that dies before it is handled (bad headers, a peer gone mid-wait) was never
      // accepted either.
      socket.once('close', () => settleSupersede(false));

      // A respawn-in-place (account switch, Resume, mode switch) opens this socket in the
      // same tick it closed the old one — wait out that hand-off before deciding the resume
      // target, or the conversation reads as still-held and the spawn silently starts a new,
      // unpinned one. No-op unless a resume was asked for and is genuinely still held.
      if (!adoptable) await awaitResumeHandoff(join(projectRoot, '_dream_context'), resumeId);

      const wss = new WebSocketServer({ noServer: true });
      // A Mac-mode phone socket: the device this socket proved (its id's hash) owns whatever it
      // opens or adopts.
      const deviceHash = phone && authFor(req) ? deviceIdHash(req) : null;
      const deviceTag: DeviceTag | null = deviceHash ? { store: 'mac', idHash: deviceHash } : null;
      // The child gate again, synchronously, at every bind point of a phone open: a hand-over
      // or `super adopt` that committed while this open waited makes the socket a watch-only
      // mirror or closes it 4403 — never a bind, never a supersede of the Mac holder.
      const childNow = (): string | null => (phone ? [resumeId, sessionId].find((id) => !!id && isHandedOverChild(id)) ?? null : null);
      const toWatch = (ws: import('ws').WebSocket, child: string | null): void => {
        settleSupersede(false);
        releaseOpening();
        // Taken back meanwhile: the client reconnects and is decided again, as today.
        // A socket closed here has no other listener: a protocol error on it must not be an
        // unhandled 'error' (it would exit the server), and a peer that never answers the close
        // is cut after a second.
        ws.on('error', () => { /* the close is what counts */ });
        const cut = () => { const t = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 1000); t.unref?.(); };
        if (!child) { try { ws.close(MIRROR_CLOSE_ENDED, 'decide again'); } catch { /* gone */ } cut(); return; }
        const lc = findLiveChat(child) ?? findLiveChat(child.toLowerCase());
        if (deviceTag && lc?.watch && lc.watch(ws, deviceTag)) return;
        try { ws.close(MAC_CLOSE_HANDED_OVER, 'handed_over'); } catch { /* gone */ }
        cut();
      };
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (deviceTag) tagDeviceSocket(ws, deviceTag);
        if (adoptable && passive) {
          void passiveAdopt(adoptable, ws, () => childNow() !== null).then((outcome) => {
            if (outcome === 'handed_over') { toWatch(ws, childNow()); return; }
            if (outcome === 'aborted') { settleSupersede(false); releaseOpening(); return; }
            if (outcome !== 'unadoptable') { releaseOpening(); return; }
            const child = childNow();
            if (child) { toWatch(ws, child); return; }
            startChatSession(ws, projectRoot, { bypass, sessionId: '', resumeId, model, effort, mode, account, initialPrompt: '', deferPrompt: false, vault: vault ?? undefined, fromAssistant, reattachFallback: true, ...(card ? { card } : {}), ...(chatAgent ? { agent: chatAgent } : {}), ...(leanMcp ? { leanMcp } : {}) });
            releaseOpening();
          });
          return;
        }
        const child = childNow();
        if (child) { toWatch(ws, child); return; }
        if (adoptable && adoptable.adopt(ws, 'takeover')) { releaseOpening(); return; }
        // A reattach that found nothing to adopt (the child exited while the client was away)
        // resumes the conversation in a new process — and never re-submits an opening prompt.
        if (reattach) {
          startChatSession(ws, projectRoot, { bypass, sessionId: '', resumeId, model, effort, mode, account, initialPrompt: '', deferPrompt: false, vault: vault ?? undefined, fromAssistant, reattachFallback: true, ...(card ? { card } : {}), ...(chatAgent ? { agent: chatAgent } : {}), ...(leanMcp ? { leanMcp } : {}) });
          releaseOpening();
          return;
        }
        // The Assistant's CLI reaches `/api/assistant/*` with these two — injected into THIS
        // spawn only, never into any other vault's chat.
        // Always the MAIN server's port (a phone listener passes it in): that is where the
        // agent's own CLI calls back, never through the tunnel.
        const address = server.address();
        const port = opts.windowControlPort ?? (address && typeof address === 'object' ? address.port : 0);
        if (port) setWindowControlBase(`http://127.0.0.1:${port}`);
        const assistantEnv = assistant
          ? { DREAMCONTEXT_ASSISTANT_URL: `http://127.0.0.1:${port}`, DREAMCONTEXT_ASSISTANT_TOKEN: assistantToken() }
          : undefined;
        let accepted = false;
        const onAccepted = (): void => {
          accepted = true;
          const conversation = sessionId || resumeId;
          if (!chatAgent || !conversation) return;
          // Every accepted conversation with an agent joins its history index (an upsert: a
          // respawn of the same session adds nothing). The stage's also stays its home.
          try { recordAgentSession(projectRoot, chatAgent, conversation, stageAgent ? 'stage' : 'chat'); } catch { /* history misses this talk */ }
          if (!stageAgent) return;
          try { recordStageHomeSession(projectRoot, stageAgent, conversation); } catch { /* the stage opens a fresh one next time */ }
        };
        startChatSession(ws, projectRoot, { bypass, sessionId, resumeId, model, effort, mode, account, initialPrompt, deferPrompt, vault: vault ?? undefined, assistantEnv, fromAssistant, onAccepted, ...(card ? { card } : {}), ...(chatAgent ? { agent: chatAgent } : {}), ...(leanMcp ? { leanMcp } : {}) });
        settleSupersede(accepted);
        releaseOpening();
      });
    })();
  });
}

/**
 * A remote screen's open of a Super child while its project is handed over: a WATCH-ONLY mirror
 * beside the Mac window that holds it (its transcript, live; nothing it sends reaches the
 * child), or 403 — a child not live here, or not of this project's record. Full of other
 * devices: 503 before the handshake, so the client backs off.
 */
function watchChild(req: IncomingMessage, socket: Duplex, head: Buffer, child: string, superCtx: string): void {
  const hash = authFor(req) ? deviceIdHash(req) : null;
  const tag: DeviceTag | null = hash ? { store: 'mac', idHash: hash } : null;
  const lc = findLiveChat(child) ?? findLiveChat(child.toLowerCase());
  const ownRecord = !!lc && handedOverChildRoot(lc.conversationId) === resolve(superCtx);
  if (!tag || !lc?.watch || !ownRecord) { rejectUpgrade(socket, 403); return; }
  if (!lc.watchRoom?.(tag)) { rejectUpgrade(socket, 503); return; }
  void (async () => {
    let WebSocketServer: typeof import('ws').WebSocketServer;
    try { ({ WebSocketServer } = await import('ws')); }
    catch { rejectUpgrade(socket, 501); return; }
    new WebSocketServer({ noServer: true }).handleUpgrade(req, socket, head, (ws) => {
      // FIRST: a protocol error on a socket nobody listens to would exit the server.
      ws.on('error', () => { /* the close that follows is what counts */ });
      tagDeviceSocket(ws, tag);
      // The child ended meanwhile, or the take-back already ran: the client reconnects and is
      // decided again (a watch, a 403, or — after a take-back — an ordinary open).
      if (!lc.watch?.(ws, tag)) {
        try { ws.close(MIRROR_CLOSE_ENDED, 'decide again'); } catch { /* gone */ }
        const t = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 1000);
        t.unref?.();
      }
    });
  })();
}

/**
 * What a chat open does with the live child already holding its conversation (if any).
 * A reattach ADOPTS it; any other open naming it is a respawn and SUPERSEDES it (the child gives
 * the conversation up). Both only within the SAME project: a tab of another project naming the
 * id displaces nothing (it is then refused as held, downstream). A phone (AC16) is refused
 * outright when the conversation runs under another project, or its transcript belongs to a
 * project the owner did not choose; the running chat is left untouched.
 */
export function chatOpenDecision<L extends { projectRoot: string }>(o: {
  phone: boolean; live: L | null | undefined; projectRoot: string; reattach: boolean; foreignTranscript: boolean;
}): { refuse: true } | { refuse: false; adopt: L | null; supersede: L | null } {
  const same = !!o.live && o.live.projectRoot === o.projectRoot;
  if (o.phone && ((o.live && !same) || o.foreignTranscript)) return { refuse: true };
  return { refuse: false, adopt: o.reattach && same ? o.live! : null, supersede: !o.reattach && same ? o.live! : null };
}

/** The credential dir an account's turns run on, for the switch decision: the register's own
 *  `configDir` (account #0 = the real HOME). */
function accountDecisionDir(acc: { id: string; configDir: string | null }): string {
  return acc.configDir ?? homedir();
}

/** One account's reading for the switch decision. */
async function readAccountForDecision(dir: string): Promise<ProbeOutcome> {
  return probeAccountForDecision(dir);
}

// ─── Chat session (child_process ↔ WebSocket bridge) ──────────────────────────────────

interface ChatSpawnOpts {
  bypass: boolean;
  sessionId: string;
  resumeId: string;
  model: string;
  effort: string;
  /** Which way of WORKING this session was opened in — selects the mode brief appended to
   *  the surface briefing. Always a sanitized value; `basic` adds nothing. */
  mode: ChatMode;
  /** Registered account id, or '' for "resolve the default". Shape-gated at the upgrade
   *  boundary and re-validated by `resolveConfigDir`, which owns the real decision. */
  account: string;
  initialPrompt: string;
  deferPrompt: boolean;
  /** Registered vault name — what the Assistant's chat registry lists this chat under.
   *  Optional so the lifecycle tests can drive a session without one. */
  vault?: string;
  /** `DREAMCONTEXT_ASSISTANT_URL` + `_TOKEN`, present ONLY for the `__assistant__` session. */
  assistantEnv?: Record<string, string>;
  /** The Assistant opened this project chat (`origin=assistant`). A respawn of the same
   *  conversation re-derives it from the chat registry, so no client ever re-sends it. */
  fromAssistant?: boolean;
  /** Internal: the notch surface an in-place respawn of the Assistant hands its successor. */
  inheritedSurfaceDispose?: () => void;
  /** Internal: this spawn answers a client's reattach that found no live child to adopt. The
   *  client is told (`reattached`, `adopted:false`) so it settles its turn state. */
  reattachFallback?: boolean;
  /** Called once the open is ACCEPTED (a child was spawned) — never for a refusal (an unknown
   *  account, a conversation still held elsewhere). The upgrade handler withdraws its
   *  provisional supersede when this does not fire. */
  onAccepted?: () => void;
  /** A whiteboard agent card's own conversation: the agent speaks under its approved identity,
   *  and a home-board agent under its board scope (lib/whiteboards/card-chat.ts). Kept out of
   *  the Assistant's chat registry and off the default-branch move; never the Assistant's. */
  card?: CardRef;
  /** An agent spoken to in an ordinary Chat tab (lib/whiteboards/card-chat.ts `prepareAgentChat`):
   *  its identity and envelope as on a card, while the tab stays a Chat tab in every other way. */
  agent?: string;
  /** A LEAN Super Agent child (orchestration plan r5 D14): `--strict-mcp-config` with only these
   *  of the user's MCP servers plus the app's own configs. Absent = every chat as before. */
  leanMcp?: string[];
}

/** Interrupt watchdog: if no result/exit follows an interrupt request within this window,
 *  escalate to SIGINT then SIGKILL rather than leave the session hung. Empirically, a real
 *  `interrupt_receipt_v1` abort completed in ~4.1s API-duration (verified against claude
 *  2.1.218 in a scratch-dir experiment — see the implementer report), so 3s risked firing
 *  the escalation on a SUCCESSFUL native interrupt; 5s gives margin without leaving a truly
 *  wedged session hanging long. */
const INTERRUPT_WATCHDOG_MS = 5000;
/** After escalating to SIGINT, how long to wait before SIGKILL. */
const INTERRUPT_KILL_GRACE_MS = 1500;

/**
 * How often ONE pane may spend a usage probe on a reading it cannot trust — a cache that is
 * absent, or older than the ceiling Claude Code itself applies to its own.
 *
 * The probe is free in money and ~4s in wall clock, and it runs BEFORE the turn is sent, so
 * an ungated version would put those seconds in front of every message a pane sends while its
 * account stays unread. A minute is short enough that the first message after a quiet spell
 * still arms auto-switch, and long enough that a conversation never pays twice.
 */
const BLIND_PROBE_COOLDOWN_MS = 60_000;

/**
 * Below this much context, a conversation may change account WITHOUT being forced to — the
 * point where a move costs little, which in practice is a fresh session or the first turns
 * after a handoff or a compaction (this machine's sessions open at ~40-65k: system prompt,
 * tools and the SessionStart snapshot).
 *
 * The prompt cache belongs to the ORGANIZATION. A conversation moved to an account of another
 * organization re-reads its whole context uncached on the first request there, and that read
 * is billed to the very quota the move was meant to spare. Owner, 2026-10-16: a switch should
 * not be made with a full session, it should happen after a handoff or in a new session. So
 * two rules hang off this number:
 *   • coming HOME (a move nothing forces) happens only under it;
 *   • a FORCED move above it stays inside the conversation's organization when it can
 *     (`keepOrg` in `chooseAccount`), where the cache survives the move.
 */
export const CHEAP_MOVE_MAX_CONTEXT_TOKENS = 80_000;

/**
 * Why a pane is being moved. `come_home` is the one move nothing forces: the account above
 * this one in the owner's list can serve again and the conversation is small enough to move
 * cheaply. The client draws it as its own notice (chatProtocol's `account_switch`).
 */
type SwitchCause = 'limit_near' | 'needs_relogin' | 'limit_hit' | 'limit_known' | 'come_home';

/**
 * Panes whose account the SYSTEM chose, keyed by pinned conversation id → that account.
 *
 * A respawn always names its account on the URL, so the URL alone cannot tell "the owner
 * picked this" from "auto-switch moved us here" — and treating every move as a hand pick is
 * how a session never came home. A pane counts as auto-placed when it opened with no account
 * (the default chose) or reopened on exactly the account the system last moved it to;
 * anything else is a hand pick and stays put.
 *
 * Bounded (oldest dropped past {@link AUTO_PLACED_MAX}): an entry outlives its process on
 * purpose, because the respawn that reads it is a new process. Lost on a server restart,
 * which is harmless — restored tabs open with no account and are auto-placed again.
 */
const autoPlacedAccounts = new Map<string, string>();

/**
 * The account each pane was last FORCED off (by pinned conversation id), and until when it may
 * not come home to it.
 *
 * Coming home decides from DISK (`chatSpawnAccount`); a forced move decides from a live probe
 * whose number is never written down. The two disagree exactly at the threshold — disk 89%,
 * probe 90% — so without this a small chat was forced off, came home on the next message, was
 * forced off again, every message. Kept until the binding window resets (30 min when that is
 * unknown, e.g. a sign-out), or until that account serves a turn somewhere after the move, which
 * puts a fresh reading on disk that the two paths then share.
 */
const forcedOffAccounts = new Map<string, { accountId: string; at: number; until: number }>();
const FORCED_OFF_DEFAULT_MS = 30 * 60_000;
/**
 * How far under the switch threshold an account just forced off must read before a pane goes
 * back to it early (`meterShowsRoomSince`). Two points covers the disk/probe disagreement at the
 * threshold (the meter rounds to a tenth) without waiting for a reset that has plainly come.
 */
const COME_HOME_MARGIN_PERCENT = 2;

/**
 * The account the OWNER picked for each pane, by pinned conversation id.
 *
 * A hand-picked account stays put, and when a limit forces the pane off it, that account is
 * where the pane goes home to — not the top of the list, which the owner chose not to use here.
 * Set when a pane opens on an account the system did not place; cleared when a pane opens with
 * no account at all (a restored tab, where the pick is already gone).
 */
const handPickedAccounts = new Map<string, string>();

const AUTO_PLACED_MAX = 500;
/** Set one pane's entry, newest last, dropping the oldest past {@link AUTO_PLACED_MAX}. */
function notePane<V>(map: Map<string, V>, conversationId: string, value: V): void {
  if (!conversationId) return;
  map.delete(conversationId);
  map.set(conversationId, value);
  while (map.size > AUTO_PLACED_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
function noteForcedOff(conversationId: string, entry: { accountId: string; at: number; until: number }): void {
  if (entry.accountId) notePane(forcedOffAccounts, conversationId, entry);
}
function noteAutoPlaced(conversationId: string, accountId: string): void {
  if (accountId) notePane(autoPlacedAccounts, conversationId, accountId);
}

/**
 * How long an announced account switch may stay unperformed, counted from the turn boundary
 * with a socket attached, before the held messages are sent on the current account instead.
 * The client restarts the instant it reads `turnInFlight: false`, so a minute only elapses when
 * something on the client side is broken — and then a visible limit error beats a message that
 * never runs. Overridable for the verify harness.
 */
const SWITCH_STALL_MS = Number(process.env.DREAMCONTEXT_SWITCH_STALL_MS) > 0
  ? Number(process.env.DREAMCONTEXT_SWITCH_STALL_MS)
  : 60_000;

/**
 * The turn a post-hoc switch resubmits when the refused turn is not one the owner's text can
 * replay: a turn the CLI started itself (a background task or sub-agent finishing), or an owner
 * turn that had already done work before the wall.
 *
 * Until 2026-10-08 such a refusal moved the pane and resubmitted NOTHING, so the restarted chat
 * sat idle under "You've hit your session limit" with a free account behind it. Observed that
 * day on six panes, goal-skill builds among them: the refusal landed on a builder's
 * task-notification turn or right after a tool result, and each pane waited until the owner
 * typed "devam et", one of them for 46 minutes. Replaying the owner's original text instead
 * would be worse: forty minutes into a run it restarts the whole request.
 */
/** What a pane moved off a SIGNED-OUT account is told after the restart (see onAuthFailed). */
export const AUTH_CONTINUE_TEXT =
  'The previous turn failed because this chat\'s Claude account was signed out, and the chat has moved to a signed-in account. '
  + 'Continue exactly where you stopped; do not redo finished work.';

export const LIMIT_CONTINUE_TEXT =
  'The previous turn was cut off by a Claude usage limit, and this chat has moved to another account. '
  + 'Continue exactly where you stopped; do not redo finished work.';

/** How long a chat's `claude` child may outlive its WebSocket to finish an in-flight turn.
 *
 *  A `claude -p --input-format stream-json` process whose stdin stays open waits for the
 *  next frame FOREVER — so a route that only untracked the child on socket close stranded
 *  a live ~200-400MB process per closed tab (observed: dozens of days-old "2.1.220"
 *  processes in Activity Monitor, ~10GB RSS total). Stdin EOF is the graceful half of the
 *  fix: an idle child exits 0 on its own once its queue drains (empirically verified on
 *  2.1.220 with stdin at EOF), and a mid-turn child gets to finish — and transcript —
 *  its current turn first. This window is the backstop for a wedged or very long turn;
 *  generous on purpose, because the common (idle) case never reaches it. */
export const CLOSE_LINGER_MS = 5 * 60_000;
/** {@link CLOSE_LINGER_MS}, shortened ONLY by a scratch verify run (`DREAMCONTEXT_CHAT_CLOSE_LINGER_MS`)
 *  so a check can outwait it — the Assistant verify proves a collapsed notch keeps its session
 *  past the linger. Read per call; ignored unless it is a positive integer. */
function closeLingerMs(): number {
  const v = Number(process.env.DREAMCONTEXT_CHAT_CLOSE_LINGER_MS);
  return Number.isInteger(v) && v > 0 ? v : CLOSE_LINGER_MS;
}
/** After the linger window's SIGTERM, how long to wait before SIGKILL. */
export const CLOSE_KILL_GRACE_MS = 5000;

/** Exported for tests (agent-chat-close-reap.test.ts drives it with a mocked spawn + a
 *  fake ws to pin the socket-gone → drain → kill lifecycle); production callers reach it
 *  only through `attachAgentChat`'s upgrade handler. */
export function startChatSession(
  initialWs: import('ws').WebSocket,
  projectRoot: string,
  opts: ChatSpawnOpts,
): void {
  // The socket this child is bound to RIGHT NOW. Reassigned only by `adoptSocket` (a client's
  // reattach after a dropped socket); every send below reads it at call time, so output flows
  // to whichever socket currently owns the child.
  let ws = initialWs;
  /** The device whose socket drives this child — per SOCKET: set by whichever phone socket
   *  binds it, cleared when a desktop socket adopts it, kept across a detach. */
  let ownerDevice: DeviceTag | null = socketDevice.get(initialWs) ?? null;
  const { bypass, sessionId, resumeId, model, effort, mode, account, initialPrompt, deferPrompt } = opts;

  const contextRoot = join(projectRoot, '_dream_context');
  const isAssistant = mode === 'assistant';
  /** The project's Super Agent (task chat-gets-a-super-agent-mode…): its inbox, the owner-frame
   *  hold (D8) and its own verbs' pre-approval under `auto` (D15). */
  const isSuper = mode === 'super';
  const assistantConfig = isAssistant ? (readAssistantConfig() ?? DEFAULT_ASSISTANT_CONFIG) : null;

  // Which Claude account this process is about to inherit. Captured BEFORE the spawn (it is
  // a synchronous counter read — no probe, no cost) so the window between "read the epoch"
  // and "the child has its credentials" is as small as it can be. See claude-auth-watch.ts:
  // a switch that lands after this point advances the epoch past it, which is precisely the
  // signal that this process is now running on stale credentials.
  const spawnAuthEpoch = claudeAuthWatcher.epoch();

  // ── Which ACCOUNT this session runs on ──────────────────────────────────────────────
  // Resolved through the single gate, which validates the id's shape, refuses an id that is
  // not registered, and asserts the resulting path is either the real HOME or a sandbox under
  // `~/.dreamcontext/claude-accounts/`. `ensureSandbox` then returns IMMEDIATELY for account
  // #0 (the default, and the only path a single-account machine ever takes) and otherwise
  // repairs the sandbox — every spawn, not only the first, so a symlink broken since the last
  // one does not silently hand this process its own private `projects/`.
  // No account asked for → the default, but not BLINDLY the preferred one: an account the
  // cache already shows as full (or a recorded refusal) is skipped here, so the chat opens on
  // one with room instead of restarting on the first message (`chatSpawnAccount`). An account
  // somebody picked is never second-guessed at spawn.
  const spawnAccount = account || (chatSpawnAccount().id ?? '');
  let accountConfigDir: string;
  try {
    accountConfigDir = resolveConfigDir(spawnAccount || null);
    ensureSandbox(accountConfigDir);
  } catch (err) {
    // A named refusal, not a silent fallback to some other account.
    try {
      ws.send(JSON.stringify({ type: 'dc_meta', subtype: 'error', message: (err as Error).message }));
    } catch { /* the socket is already gone */ }
    try { ws.close(); } catch { /* already closed */ }
    return;
  }
  const accountEnv = accountEnvFor(accountConfigDir);
  const isRealHomeAccount = isRealHomeConfigDir(accountConfigDir);
  const mcpConfigPath = sharesUserMcp({ isAssistant, isRealHomeAccount }) ? ensureSharedMcpConfig() : null;
  // The Assistant's hands (mouse, keyboard, screen — computer-mcp.ts): its spawn ONLY, macOS
  // only. Each call is an MCP tool call, so under `ask` the owner approves it in the notch.
  const computerMcpPath = isAssistant && process.platform === 'darwin' ? ensureComputerMcpConfig() : null;
  // Recorded beside `spawnAuthEpoch` so the live panel can be labelled with the account it is
  // really billing, and so the chooser knows which account NOT to move away from on a tie.
  const activeAccountId = spawnAccount
    || listClaudeAccounts().find((a) => accountDecisionDir(a) === accountConfigDir)?.id
    || '';

  // Resume-target selection — mirrors agent-terminal.ts's startPtySession exactly:
  //  • resume requested → resolve the pinned id through the tab-session map FIRST (the
  //    live conversation may have rotated since the id was pinned), falling back to the
  //    pinned id itself; skip any conversation ANOTHER live chat process already holds.
  //  • resume requested but no resumable transcript → fresh-pin via --session-id so the
  //    session stays resumable going forward instead of erroring.
  const mappedId = resumeId ? resolveAgentSession(contextRoot, resumeId) : '';
  const resumeTarget = [mappedId, resumeId].find(
    (c) => c && !liveConversations.has(c) && claudeConversationExists(c),
  ) ?? '';
  const pinId = resumeId || sessionId;
  // Who chose this pane's account — see `autoPlacedAccounts`. Only an auto-placed pane comes home.
  const accountAutoPlaced = !account || autoPlacedAccounts.get(pinId) === account;
  if (accountAutoPlaced) noteAutoPlaced(pinId, activeAccountId);
  else autoPlacedAccounts.delete(pinId);
  if (!account) handPickedAccounts.delete(pinId);
  else if (!accountAutoPlaced && activeAccountId) notePane(handPickedAccounts, pinId, activeAccountId);
  const freshPin = !resumeTarget && pinId && !liveConversations.has(pinId) && !claudeConversationExists(pinId)
    ? pinId : '';
  const idArg = resumeTarget ? ['--resume', resumeTarget] : freshPin ? ['--session-id', freshPin] : [];

  /**
   * A RESUME THAT CANNOT TAKE ITS CONVERSATION REFUSES — it never quietly forks.
   *
   * The three lines above can all come up empty at once, and until this guard they did so
   * SILENTLY: `resumeTarget` blocked because the conversation is still held, `freshPin`
   * blocked because a transcript for it exists, so `idArg` came out `[]` and the spawn
   * started a brand-new, UNPINNED conversation. The tab kept its pinned id, the live
   * conversation was somewhere else entirely, and `chat-history` — which resolves through the
   * tab-session map the new process's SessionStart hook had just rewritten — replayed the new
   * empty file. That is the owner's report exactly: "session kaybı yaşanıyor, tüm geçmiş text
   * yok oluyor." Not hidden for one launch; the pin was orphaned for good, and the new
   * conversation was not even resumable.
   *
   * `awaitResumeHandoff` makes this rare (and `RESUME_HANDOFF_MIN_POLLS` makes its budget
   * honest under a blocked event loop), but rare is the wrong target for a failure whose cost
   * is a lost conversation. Refusing turns an invisible, permanent loss into a visible,
   * recoverable one: the pane raises its "Session ended" banner carrying this message, and its
   * Resume button succeeds the moment the other holder lets go.
   *
   * SCOPED TO `resumeId`. A brand-new session (`sessionId` only) whose id is somehow held is
   * not covered here — it has no transcript to lose, and `freshPin` already declines to pin it.
   */
  if (resumeId && !resumeTarget && !freshPin) {
    try {
      ws.send(JSON.stringify({
        type: 'dc_meta',
        subtype: 'error',
        message: 'This conversation is still open in another pane or is still shutting down. '
          + 'Nothing was lost — press Resume in a moment to reopen it.',
      }));
    } catch { /* the socket is already gone */ }
    try { ws.close(); } catch { /* already closed */ }
    return;
  }

  // ── A whiteboard agent card's envelope (lib/whiteboards/card-chat.ts) ────────────────
  // Decided HERE, from disk, at every spawn (Resume and account switch included): the agent's
  // approval is checked, its board resolved, and a home-board agent gets the run's own scope.
  // A refusal ends the open with a named reason; nothing is spawned.
  let card: Extract<ReturnType<typeof prepareCardChat>, { ok: true }> | null = null;
  if (opts.card) {
    const prep = prepareCardChat(contextRoot, opts.card);
    // The rules ride the login-shell script in double quotes, so a `$` or backtick in a real
    // path would be expanded there; forbiddenPathReason already refuses `"`, `\` and `!`.
    const unsafe = prep.ok && prep.permissionArgs?.some((a) => /[$`]/.test(a));
    if (!prep.ok || unsafe) {
      if (prep.ok) prep.dispose();
      const reason = prep.ok ? 'its folders contain a character the shell would expand' : prep.reason;
      // `_meta`, not `dc_meta`: the card shows the parser's `lastError`, so the owner reads why.
      try { ws.send(JSON.stringify({ type: '_meta', subtype: 'error', code: 'card_refused', message: `This agent cannot talk here: ${reason}.` })); } catch { /* gone */ }
      try { ws.close(); } catch { /* already closed */ }
      return;
    }
    card = prep;
  }
  // ── An agent in a Chat tab: the same envelope, decided the same way at every spawn ──────
  let agentChat: Extract<ReturnType<typeof prepareAgentChat>, { ok: true }> | null = null;
  if (opts.agent && !opts.card) {
    const prep = prepareAgentChat(contextRoot, opts.agent, undefined, { excludeSession: sessionId || resumeId || null });
    const unsafe = prep.ok && prep.permissionArgs?.some((a) => /[$`]/.test(a));
    if (!prep.ok || unsafe) {
      if (prep.ok) prep.dispose();
      const reason = prep.ok ? 'its folders contain a character the shell would expand' : prep.reason;
      try { ws.send(JSON.stringify({ type: '_meta', subtype: 'error', code: 'agent_refused', message: `This agent cannot talk here: ${reason}.` })); } catch { /* gone */ }
      try { ws.close(); } catch { /* already closed */ }
      return;
    }
    agentChat = prep;
  }
  /** Whose identity and permission envelope this child runs under: a card's or a Chat tab
   *  agent's. Only `card` decides what a card skips (registry, tab env, branch move). */
  const envelope = card ?? agentChat;
  const scopedCard = !!envelope?.permissionArgs;
  // The project's Playwright MCP, re-declared headless with a loopback CDP port so its browser
  // never takes the screen and the pane can show it live (browser-override.ts). Not for a
  // scoped card (no MCP at all).
  // A lean child's own MCP subset (D14): written per spawn, removed when it exits. A name the
  // user no longer has (the config changed since the upgrade) is dropped: narrower, never wider.
  let leanMcpPath: string | null = null;
  // Every lean path rides the double-quoted login-shell script: only a shell-safe one may
  // (security review r1). The project's `.mcp.json` under an odd project folder name is left
  // out (narrower, never a shell expansion); an unsafe subset path refuses the spawn.
  const leanProjectMcp = opts.leanMcp ? projectMcpJson(projectRoot) : null;
  const leanProjectMcpSafe = leanProjectMcp && tmpPathOk(leanProjectMcp) ? leanProjectMcp : null;
  if (opts.leanMcp && !scopedCard) {
    try {
      const known = knownMcpServers(projectRoot);
      leanMcpPath = writeLeanMcpConfig(opts.leanMcp.filter((n) => known.has(n)), known);
      if (leanMcpPath && !tmpPathOk(leanMcpPath)) {
        removeLeanMcpConfig(leanMcpPath);
        leanMcpPath = null;
        throw new Error('its MCP config path is not shell-safe');
      }
    } catch (err) {
      try { ws.send(JSON.stringify({ type: '_meta', subtype: 'error', code: 'mcp_refused', message: `This child cannot start: ${(err as Error).message}.` })); } catch { /* gone */ }
      try { ws.close(); } catch { /* already closed */ }
      return;
    }
  }
  const browserOverride = scopedCard ? null : prepareBrowserOverride(projectRoot);

  const heldConversation = resumeTarget || freshPin;
  if (heldConversation) liveConversations.add(heldConversation);
  /** The hold was handed to a respawn while this child was detached and busy (`supersedeLive`):
   *  the conversation is not ours to release any more, so `releaseHeld` must leave it alone. */
  let holdLent = false;
  let releaseHeld = () => {
    releaseHeld = () => { /* once */ };
    if (heldConversation && !holdLent) liveConversations.delete(heldConversation);
  };

  // ── A FRESH session starts on the default branch ──────────────────────────────────────
  //
  // Nothing else returns the main checkout to its default branch, so a `git checkout -b` a
  // previous session ran there stands forever and every session opened afterwards inherits it
  // (owner, 2026-08-25: shown a chip reading `feat/shelf-pin-drop`, they read "you are in a
  // different worktree"). Run BEFORE the spawn, so the child is born on the right branch
  // rather than being told about a move under its feet.
  //
  // `!resumeTarget` is the guard this module cannot check for itself: a resumed conversation's
  // whole transcript assumes a branch, and moving it out from under that history would be
  // worse than the defect. Every other guard — dirty tree, linked worktree, no resolvable
  // default — lives in `freshSessionOnDefaultBranch`, and the OUTCOME is reported below rather
  // than swallowed. A `git checkout` on the user's tree is not something to do quietly, and
  // the refusal arm matters even more than the success one: in this repo `_dream_context/`
  // rides the working tree, so "staying put, the tree is dirty" is the common answer.
  const freshStart = resumeTarget || card ? null : freshSessionOnDefaultBranch(projectRoot);

  // Deferred initial prompt ("the user speaks first"): mirrors
  // agent-terminal.ts's parking pattern exactly. A non-deferred prompt is instead sent as
  // the first USER stdin frame IMMEDIATELY after spawn — empirically (CLI 2.1.218), in
  // stream-json input mode the CLI emits `system:init` only AFTER the first stdin frame
  // arrives, so gating the prompt on init deadlocks a delegated session forever (stdin
  // frames queue safely pre-init).
  let submitPrompt = initialPrompt;
  let deferredEnv: Record<string, string> = {};
  let cleanupDeferred = () => { /* nothing parked */ };
  if (initialPrompt && deferPrompt) {
    submitPrompt = '';
    if (!resumeTarget) {
      const parked = join(tmpdir(), `dreamcontext-deferred-${randomUUID()}.txt`);
      try {
        writeFileSync(parked, initialPrompt, { encoding: 'utf-8', mode: 0o600 });
        deferredEnv = { DREAMCONTEXT_DEFERRED_PROMPT: parked };
        cleanupDeferred = () => { try { rmSync(parked, { force: true }); } catch { /* tmp cleanup */ } };
      } catch { /* degrade to promptless boot */ }
    }
  }

  // Tell the agent it is rendering into the Chat view. Without this it writes for a TTY —
  // it finishes a board and names the path instead of drawing it — because a chat-spawned
  // `claude` is otherwise byte-identical to a terminal-spawned one. Handed over as a FILE
  // (see chat-surface.ts) so the login-shell argv stays free of prose; a failed write
  // degrades to the un-briefed agent we had before, never to a failed spawn.
  let briefingArg: string[] = [];
  let cleanupBriefing = () => { /* nothing written */ };
  // The project's approved agents, callable as sub-agents from any Chat tab (not the Assistant's,
  // not a card's): an `--agents` definition each, and a roster in the briefing so the model knows
  // it can (lib/automations/chat-subagents.ts). Read at every spawn, so a new or re-approved agent
  // is callable after the next Resume. A failed read costs the roster, never the spawn.
  let subagents: ReturnType<typeof chatSubagents> = null;
  // A scoped agent's allowlist disallows the Agent tool, so a roster there would name a door it lacks.
  if (!isAssistant && !card && !scopedCard) {
    try { subagents = chatSubagents(contextRoot, { exclude: opts.agent }); } catch { subagents = null; }
  }
  let agentsArg: string[] = [];
  let cleanupAgents = () => { /* nothing written */ };
  if (subagents) {
    try {
      const json = JSON.stringify(subagents.agents);
      const file = join(tmpdir(), `dreamcontext-chat-agents-${randomUUID()}.json`);
      if (!tmpPathOk(file)) throw new Error('unsafe tmpdir');
      writeFileSync(file, json, { encoding: 'utf-8', mode: 0o600 });
      agentsArg = ['--agents', file];
      cleanupAgents = () => { try { rmSync(file, { force: true }); } catch { /* tmp cleanup */ } };
      
    } catch { agentsArg = []; subagents = null; }
  }
  try {
    const brief = join(tmpdir(), `dreamcontext-chat-surface-${randomUUID()}.md`);
    // Our own filename, but `tmpdir()` comes from TMPDIR — the one argv element below that
    // isn't a fixed literal or a whitelist-sanitized token. Hold it to the same standard
    // (see the quoting note on `script`): a tmpdir carrying a shell metacharacter drops the
    // briefing rather than reaching the command line.
    if (!tmpPathOk(brief)) throw new Error('unsafe tmpdir');
    // ONE file, two parts: the surface briefing every chat gets, then the selected mode's
    // behaviour brief (empty for `basic`). A second --append-system-prompt-file would be a
    // second argv element and a second cleanup path for no gain — the CLI concatenates
    // either way. `worktreeIsolationAllowed` never throws, and sits inside this try anyway
    // so an unexpected failure degrades to the un-briefed agent rather than a failed spawn.
    let assistantCtx: Parameters<typeof modeBriefing>[1]['assistant'];
    if (assistantConfig) {
      const roster = collectRoster();
      // The roster carries strings other projects' agents wrote — a session born with it
      // starts TAINTED, cleared by the owner's first real message.
      if (roster.carriesProjectText) markTainted();
      assistantCtx = { name: assistantConfig.name, character: readAssistantCharacter(), autonomy: assistantConfig.autonomy, roster: renderRoster(roster) };
    }
    // A card speaks as its agent: the card briefing takes the mode brief's place. An agent in a
    // Chat tab keeps the tab's mode too: who it is first, then how this tab asked it to work.
    const tabBrief = modeBriefing(mode, { worktreeAllowed: worktreeIsolationAllowed(projectRoot), assistant: assistantCtx });
    const ownBrief = card ? card.briefing : agentChat ? [agentChat.briefing, tabBrief].filter(Boolean).join('\n\n') : tabBrief;
    // Named only when the `--agents` definitions really ride this spawn (`subagents` is cleared
    // when their file could not be written), so the model is never told about agents it lacks.
    const modeBrief = [ownBrief, subagents?.roster ?? ''].filter(Boolean).join('\n\n');
    // A Super Agent's delegated child (lean, above) is also told how to reach its Super Agent.
    const surface = opts.leanMcp ? `${CHAT_SURFACE_BRIEFING}\n${SUPER_CHILD_BRIEFING}` : CHAT_SURFACE_BRIEFING;
    const briefing = modeBrief ? `${surface}\n${modeBrief}` : surface;
    writeFileSync(brief, briefing, { encoding: 'utf-8', mode: 0o600 });
    briefingArg = ['--append-system-prompt-file', brief];
    cleanupBriefing = () => { try { rmSync(brief, { force: true }); } catch { /* tmp cleanup */ } };
    
  } catch { /* no briefing this session — the chat still works, just terminal-flavoured */ }

  // ── A RESUMED conversation is told its mode — its system prompt cannot be ───────────
  // A resume restores the system prompt from the transcript's snapshot, so the append file
  // above is read and ignored (chat-mode-drift.ts has the measurement). When the model is
  // holding a different mode than this spawn's, a SessionStart hook scoped to THIS process
  // (`--settings`) adds a note saying the new brief replaces the old; on `compact` too when
  // the snapshot differs, since a compaction drops the note. A failure degrades to today's
  // behaviour, never to a failed spawn.
  // Every spawn also carries dreamcontext's auto-mode carve-outs (auto-mode-rules.ts): the
  // classifier reads them only from flag/user/managed settings, never the repo's own, so one
  // `--settings` file holds both. Written even under bypass — a live switch to auto keeps them.
  const spawnSettings: Record<string, unknown> = autoModeSettings();
  let modeNoteArg: string[] = [];
  let cleanupModeNote = () => { /* nothing written */ };
  const tmpFiles: string[] = [];
  // The Super Agent's briefing revision (K9): a new session carries it in its system prompt; a
  // resumed one learns from its transcript whether this revision still has to reach it.
  const superBrief = { inPrompt: true, due: false };
  if (resumeTarget && !isAssistant && !card) {
    try {
      const transcript = findFirstTranscriptPath([resumeTarget]);
      const jsonl = transcript ? readFileSync(transcript, 'utf-8') : '';
      // No transcript found for a resume: nothing proves the revision arrived, so it rides once.
      if (isSuper) Object.assign(superBrief, transcript ? superBriefState(jsonl, SUPER_BRIEF_REV) : { inPrompt: false, due: true });
      const state = transcript ? heldModeFromTranscript(jsonl) : null;
      const sources = modeNoteSources(state, mode);
      if (state && sources.length) {
        const brief = modeBriefing(mode, { worktreeAllowed: worktreeIsolationAllowed(projectRoot) });
        const note = modeNoteHookOutput(modeSwitchNote(state.held, mode, brief));
        const id = randomUUID();
        const out = join(tmpdir(), `dreamcontext-chat-mode-${id}.json`);
        if (!tmpPathOk(out)) throw new Error('unsafe tmpdir');
        writeFileSync(out, note, { encoding: 'utf-8', mode: 0o600 });
        tmpFiles.push(out);
        // The hook runs in Git Bash on win32, which reads `C:/…` and not `C:\…`.
        const hookPath = process.platform === 'win32' ? out.replace(/\\/g, '/') : out;
        Object.assign(spawnSettings, JSON.parse(modeNoteSettings(`cat "${hookPath}"`, sources)));
        
      }
    } catch { /* the model keeps the mode it was born with — the defect, not a crash */ }
  }
  try {
    const settings = join(tmpdir(), `dreamcontext-chat-settings-${randomUUID()}.json`);
    if (!tmpPathOk(settings)) throw new Error('unsafe tmpdir');
    writeFileSync(settings, JSON.stringify(spawnSettings), { encoding: 'utf-8', mode: 0o600 });
    tmpFiles.push(settings);
    modeNoteArg = ['--settings', settings];
    
  } catch { /* no carve-outs and no mode note this spawn — auto mode keeps its defaults */ }
  if (tmpFiles.length) {
    cleanupModeNote = () => {
      for (const p of tmpFiles) { try { rmSync(p, { force: true }); } catch { /* tmp cleanup */ } }
    };
  }

  // ── Delegation marker, effort, recall mode ──────────────────────────────────────────
  // A chat the Assistant opened is `delegated`, and so is every later spawn of the SAME
  // conversation (close + Resume, account or mode switch): those arrive without the URL
  // flag, so the marker is re-derived from the registry entry the previous spawn left
  // (live, or gone and not yet deleted). Checked before this spawn registers its own entry.
  const delegated = !isAssistant && (!!opts.fromAssistant
    || [resumeTarget, resumeId].some((c) => !!c && isDelegatedConversation(c)));
  const spawnEffort = spawnEffortFor({
    isAssistant, assistantEffort: assistantConfig?.effort, delegated, mode, urlEffort: effort,
  });
  const spawnModel = spawnModelFor({ isAssistant, assistantModel: assistantConfig?.model, urlModel: model });
  let recallEnv: Record<string, string> = {};
  if (isAssistant || delegated) {
    try {
      recallEnv = recallEnvFor({
        isAssistant,
        delegated,
        vaultRecallMode: isAssistant ? null : resolveRecallMode(contextRoot),
        modelOnDisk: isEmbedModelDownloaded(),
      });
    } catch { /* an unreadable sleep state leaves the vault's own mode in charge */ }
  }
  // The Assistant's own index, built in the background without the owner doing anything
  // (every spawn: covers create, a model/version change that invalidated it, and existing
  // installs). Never downloads the model, never blocks, one build per vault.
  if (isAssistant) ensureIndexBuilt(contextRoot);

  const argv = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    // A home-board card runs under its board's rules (dontAsk, project settings only, an exact
    // allowlist), in place of the pane's mode, exactly as its runs do (board-scope.ts).
    // An agent in a Chat tab (its stage included) runs at its autonomy level (agents/permission.ts),
    // decided above from its manifest; the pane's bypass flag never reaches it.
    ...(envelope?.permissionArgs ?? agentChat?.levelArgs ?? ['--permission-mode', assistantConfig ? assistantPermissionMode(assistantConfig.autonomy) : permissionModeFor(bypass)]),
    ...briefingArg,
    ...agentsArg,
    // The `--settings` file is a flag source the scope cannot narrow: a scoped card goes without.
    ...(scopedCard ? [] : modeNoteArg),
    ...idArg,
    ...(spawnModel ? ['--model', spawnModel] : []),
    ...(spawnEffort ? ['--effort', spawnEffort] : []),
    ...(assistantConfig ? assistantAllowedTools(assistantConfig.autonomy) : []),
    ...superAllowedTools(isSuper, bypass),
    // Variadic, but every later element is a `--` flag, so it swallows nothing.
    ...chatDeniedToolArgs(scopedCard),
    ...assistantSettingArgs(isAssistant),
    // A SANDBOXED session reaches the user's MCP servers BY REFERENCE. Its own config is
    // seeded with no MCP keys at any depth, so without this flag it would silently lose every
    // server the user has; copying them per account would multiply the secrets instead.
    // Account #0 reads the real config directly and needs nothing. `--strict-mcp-config` is
    // deliberately NOT passed, so a project's own `.mcp.json` still applies.
    // No MCP for a scoped card (its allowlist names no MCP tool; out of scope by decision).
    // The browser override rides LAST: between two `--mcp-config` files the later one wins,
    // and the shared config may carry the owner's headed `playwright` too.
    // A LEAN child (D14) instead: strict, and only its subset, the project's own `.mcp.json`
    // (strict would drop it) and the browser override, LAST as above. Never the shared config.
    ...(scopedCard ? [] : leanChildMcpArgs(opts.leanMcp ? { leanMcpPath, projectMcp: leanProjectMcpSafe, browser: browserOverride?.configPath ?? null } : null, [mcpConfigPath, computerMcpPath, browserOverride?.configPath ?? null])),
  ];
  // Quoted for the login-shell script string exactly like the terminal/title/capture
  // spawns: every element here is either a fixed flag literal or a whitelist-sanitized
  // value (UUID / model alias / effort level), so plain double-quoting is sufficient —
  // none of them can contain a shell metacharacter. (`Bash(dreamcontext assistant:*)` is a
  // fixed literal whose parens, colon, space and star are all inert inside double quotes.)
  const script = `exec claude ${argv.map((a) => `"${a}"`).join(' ')}`;

  // An agent-chat process exports its tab's STABLE roster id so the SessionStart/Stop
  // hooks (which inherit this env through `claude`) record roster id → live conversation
  // id on every rotation — the SAME map the embedded terminal writes/reads (AC7: chat and
  // terminal resume interop through one registry). Only when actually pinned/resumed.
  const tabEnv = pinId && idArg.length ? tabSessionEnv(pinId) : {};

  // ── Seed this pane's context-handoff toggle BEFORE the child starts ─────────
  //
  // Ordering is load-bearing: the child's very first PostToolUse hook resolves the
  // toggle from this file, so seeding it after the spawn would leave a race in which
  // the first edits of a session silently run under the wrong setting.
  //
  // Precedence — brain-local (what this person last chose, for THIS vault on THIS
  // machine) > `.config.json` (the team default) > off. An EXISTING tab file is left
  // alone: a pane that has been toggled owns its own answer across resumes.
  try {
    if (pinId && idArg.length && !readTabHandoff(contextRoot, pinId)) {
      const seed = resolveTabSeed(
        readBrainLocal(projectRoot).contextHandoffDefault,
        readSetupConfig(projectRoot)?.contextHandoff,
      );
      writeTabHandoff(contextRoot, pinId, seed);
    }
  } catch { /* an unseeded pane falls back to the vault default — never a failed spawn */ }

  // Window control (`dreamcontext window …`): a project chat drives the surface it is drawn in,
  // through a token that names THIS chat's socket only (lib/window-control.ts). Not the
  // Assistant (it has its own relay) and not a whiteboard card (a scoped identity).
  // The token carries WHO it is (vault, pin id, mode) for the Super Agent's checks (plan-r7 D4);
  // the registry entry below is keyed by the same id.
  const chatRegistryId = pinId || randomUUID();
  /** The phone's mirrors of this Super Agent (lib/super/phone-mirror.ts); null for any other
   *  chat. The owner's text from one joins the desktop's own path (`onWsMessage`). */
  let mirrors: MirrorSet<DeviceTag> | null = isSuper
    ? new MirrorSet<DeviceTag>({
      valid: deviceStillValid,
      onOwnerFrame: (raw) => {
        // Never into a stdin that is ending (a drain or respawn closes the mirrors, this is the
        // race before it).
        if (!alive || stdinEnding()) return;
        // The frame carries where it came from (a Buffer the set knows), so the mark survives
        // the switch gate and a successor's replay: see `fromMirror` in the user branch.
        const frame = Buffer.from(raw, 'utf-8');
        mirrorFrames.add(frame);
        onWsMessage(frame);
      },
      holder: () => (alive && !detached && ws.readyState === ws.OPEN ? ws : null),
      key: (d) => d.idHash,
    })
    : null;

  if (mirrors) superMirrorSets.add(mirrors);
  const windowControl = !isAssistant && !card
    ? mintWindowToken({
      send: (frame) => {
        if (ws.readyState !== ws.OPEN) return false;
        try { ws.send(JSON.stringify({ type: '_meta', ...frame })); return true; } catch { return false; }
      },
      vault: opts.vault ?? basename(projectRoot),
      contextRoot,
      sessionId: chatRegistryId,
      mode,
    })
    : null;
  const childEnv = { PATH: claudeAwarePath(), ...CHAT_QUESTION_ENV, ...tabEnv, ...deferredEnv, ...(windowControl?.env ?? {}), DREAMCONTEXT_CHAT_TAB: isAssistant || card ? '' : '1', ...(isAssistant ? opts.assistantEnv ?? {} : {}), ...recallEnv, ...(envelope?.env ?? {}) } as Record<string, string | undefined>;
  // Its own process group on POSIX, so the whole tree can be ended at once (win32: see chatSpawnCommand).
  const spawnCmd = chatSpawnCommand({ argv, script });
  const child: ChildProcessWithoutNullStreams = spawn(spawnCmd.file, spawnCmd.args, {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: spawnCmd.detached,
    ...(process.platform === 'win32' ? { windowsHide: spawnCmd.windowsHide } : {}),
    // claude-aware PATH: `claude` installs into ~/.local/bin, which no default PATH
    // contains — without this the login shell 127s whenever the install's `export
    // PATH` echo never reached the user's rc. See src/lib/claude-path.ts.
    // DREAMCONTEXT_CHAT_TAB arms the UserPromptSubmit reminder to name the tab
    // (lib/chat-tab-title-nudge.ts). ALWAYS set, to '1' or '', so a value the server itself
    // inherited can never leak into another mode; the Assistant has no tab to name.
    env: { ...process.env, ...childEnv, ...accountEnv } as NodeJS.ProcessEnv,
  });

  // Every chat but the Assistant's own is listed in the Assistant's chat registry, its status
  // derived from the frames this bridge already parses (see chat-registry.ts). A resumed
  // conversation replays no history, so its title and last texts are seeded from disk
  // (chat-seed.ts); a failed read registers it unseeded, never fails the spawn.
  let seed: ReturnType<typeof seedForConversation> = {};
  if (!isAssistant && !card && heldConversation) {
    try {
      seed = seedForConversation(contextRoot, [heldConversation, pinId ? resolveAgentSession(contextRoot, pinId) : '']);
    } catch { seed = {}; }
  }
  const registry: ChatHandle | null = isAssistant || card ? null : registerChat({
    sessionId: chatRegistryId,
    conversationId: heldConversation || null,
    vault: opts.vault ?? basename(projectRoot),
    mode,
    ...(delegated ? { origin: 'assistant' as const } : {}),
    seed,
  });
  // An ended Super Agent child running again without `super resume`: the owner reopened it.
  if (registry) void noteChatStarted(chatRegistryId);
  let disposeSurface = opts.inheritedSurfaceDispose ?? (() => { /* not a surface */ });
  // The Assistant's inbox (delegations.ts) — attached once the switch chain it rides exists.
  let detachInbox = () => { /* not the Assistant */ };
  // ── Autonomy respawn (the Assistant only) ──
  // `respawnTo` is set when the owner's autonomy no longer matches what this process was
  // spawned with; the respawn runs at once when idle, else at the turn boundary, and any
  // owner message that arrives meanwhile is held for the successor (never written here).
  // `handedOff` = this process is being replaced in place: its exit must not end the socket.
  let respawnTo: Autonomy | null = null;
  let handedOff = false;
  const heldForSuccessor: Array<Buffer | string> = [];
  let observedConversation = '';
  let unlistenAutonomy = () => { /* not the Assistant */ };

  // Liveness guard (mirrors agent-terminal.ts:1408's `if (!alive) return;`): a stale
  // answer/interrupt frame arriving after the child has exited must never throw on a
  // destroyed stdin stream.
  let alive = true;
  /**
   * How many turns are ACTUALLY running inside the CLI — a COUNTER, not a boolean.
   *
   * Incremented for every user frame written to the child's stdin, decremented on every
   * `result` the CLI answers with. `turnsInFlight > 0` is the honest answer to "is anything
   * running", and it is deliberately NOT the client's `busy` flag: `writeUser` sets that
   * optimistically before the server has decided anything, so a message auto-switch HOLDS
   * leaves the client believing a turn is in flight when none is — and the client's restart
   * gate waits for a turn boundary, so believing it would wait forever.
   *
   * WHY A COUNTER. A boolean cannot track two OVERLAPPING turns, and two are reachable
   * through ordinary UI: `setEffort` is delivered as its own user frame, written straight to
   * stdin OUTSIDE the `switchGate` chain, and the CLI answers it with a quick synthetic turn.
   * With one boolean, that fast `result` cleared the flag while a real message's turn was
   * still running — so a switch decision a moment later read "nothing running" and restarted
   * over live work, which is the exact failure this flag exists to prevent. Counting
   * correlates the number of turns rather than their identities, which is all the question
   * needs.
   *
   * Clamped at zero: a `result` we did not open a turn for must not drive it negative, which
   * would read as "less than nothing running" and mask a genuine turn afterwards.
   *
   * TWO PATHS CHECKED AND DELIBERATELY NOT COUNTED, so the next reader does not re-derive it:
   *   • A DEFERRED opening prompt writes nothing to stdin at all (`submitPrompt` is emptied
   *     when `deferPrompt` is set) — the UserPromptSubmit hook delivers it, so there is no
   *     turn here to count.
   *   • `interrupt` and `rewind`'s `interrupt_if_running` are CONTROL requests, not user
   *     frames: they never open a turn, and an abort that resolves via `control_response`
   *     WITHOUT a `result` leaves the count high. That is the SAFE direction — the client's
   *     gate is `move.turnInFlight && (busy || asking)`, so a high count merely defers to the
   *     client's own flag, i.e. the behaviour that shipped before this feature. The dangerous
   *     direction is a count that is too LOW while a turn runs, and every stdin write of a
   *     user frame increments.
   *
   * A MAIN `result` NOW SETS IT TO ZERO, NOT ONE LESS (measured on claude 2.1.301, 2026-10-16).
   * A user frame written mid-turn (a steer) is FOLDED into the running turn: two frames, one
   * `result`. Counting down left one turn owed forever after every steer, and a count that
   * never reaches zero is not the safe direction after all: the switch gate waits on it with the
   * held message keeping the client busy, the stall release only arms at zero, and an idle
   * interrupt answers with a bare `control_response` — so the pane read "Working…" for 69
   * minutes with Stop doing nothing (owner video, 2026-10-14). A frame the CLI did NOT fold
   * (a slash command, a frame raced against the `result`) runs as its own turn afterwards, and
   * every turn opens with `system:init` — which re-opens the count (see the frame reader). An
   * idle child emits no `init`, so that rule cannot open a turn that is not running.
   */
  let turnsInFlight = 0;
  /** The Super Agent only: a turn its inbox opened is running. An owner frame that arrives
   *  meanwhile is written AT ONCE and folded into it, like a steer in any chat (plan r4 D4). */
  let superEventTurnOpen = false;
  /** Owner texts sent spoken (`voice: true`) not yet written to the CLI. */
  const spokenTexts = new Set<string>();
  /** Owner texts dictated and sent UNCHANGED (the frame's `voiceTake`), bound to this chat and
   *  not yet written to the CLI: text → the stored take. Dies with this handler, so a message
   *  resent after a performed account switch carries no take (a stated scope cut). */
  const voiceTakes = new Map<string, TakeRecord>();
  /** A spoken owner message was written and its turn's `result` has not come yet. */
  let voiceArmed = false;
  /** The last owner text written (`lastSentText`) was spoken: a limit-refused resend keeps it. */
  let lastSentSpoken = false;
  /** The request id of the interrupt last written, so ITS `control_response` can be told apart
   *  from a model or mode switch's. */
  let interruptRequestId: string | null = null;
  /** Armed when the CLI acked an interrupt: if no `result` follows, nothing was running and the
   *  turn is closed here (`settleAfterInterrupt`). */
  let interruptSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The last text WE handed to the CLI, kept so the post-hoc switch can resubmit the exact
   * turn the API refused. Without it a limit landing mid-turn can only be announced, and the
   * user still retypes — which is the friction this whole feature exists to remove.
   *
   * Overwritten per turn rather than queued: a rejection answers the turn in flight, and an
   * older one has already been answered. `/effort` and other synthetic frames deliberately
   * do NOT set it — resubmitting one after a switch would replay a setting, not a message.
   */
  let lastSentText: string | null = null;
  /** Whether the main agent has answered since `lastSentText` went out. A refusal after that
   *  point cuts off WORK, not a request, so the switch resubmits `LIMIT_CONTINUE_TEXT` rather
   *  than replaying the request from the top. */
  let turnProgressed = false;
  /** This turn was refused for sign-in: its `result` must not clear the record. */
  let authFailedTurn = false;
  /** A limit refusal was read in this turn (any frame, a sub-agent's too): its main `result`
   *  must not rotate the pane — the turn did not run, and the pane is about to be switched.
   *  Reset only at the very end of the main result's handling, after that frame's own refusal
   *  was read (task super-agent-devrini-…). */
  let limitHitThisTurn = false;
  let interruptWatchdog: ReturnType<typeof setTimeout> | null = null;
  let interruptKillTimer: ReturnType<typeof setTimeout> | null = null;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  let lingerKillTimer: ReturnType<typeof setTimeout> | null = null;

  const untrack = trackChild(child);
  // A write that loses a race with stdin's end is reported as an asynchronous 'error' event,
  // which `writeStdin`'s try/catch cannot see — and an unheard 'error' takes the whole server
  // down. The close handler already reports the child going away.
  child.stdin.on?.('error', () => { /* stdin ended under a write */ });

  /** Resolves once the child has exited (cutChild waits on it). */
  let markExited: () => void = () => { /* replaced below */ };
  const exited = new Promise<void>((r) => { markExited = r; });
  child.once('close', () => markExited());
  child.once('error', () => markExited());
  /** Hands-free cut: the whole process group, SIGTERM then SIGKILL. The transcript stays, so
   *  the conversation is resumable exactly as after any other exit. */
  const cutChild = async (): Promise<void> => {
    if (!alive) return;
    if (child.pid) {
      // The whole group plus any descendant that left it; SIGKILL after the grace even when
      // the leader already exited; resolves once every one of them is gone (D22).
      await cutProcessGroups([child.pid], CUT_KILL_GRACE_MS);
    } else {
      signalGroup(child, 'SIGKILL');
    }
    await exited;
  };

  /**
   * The owning device was signed out (an incident: revoke-all, logout, a password change).
   *  • Mac: close the phone socket (4401) within the notification; a RUNNING turn is cut (an
   *    attacker cannot keep a turn going by disconnecting first: a detached child keeps its last
   *    holder as owner); an idle child just detaches, adoptable by the desktop.
   */
  let deviceRevoked = false;
  const revokeForDevice = (): void => {
    if (deviceRevoked) return;
    const tag = ownerDevice;
    if (tag?.store === 'mac' && turnsInFlight === 0) {
      ownerDevice = null;
      dropPhoneSocket('device signed out');
      return;
    }
    deviceRevoked = true;
    endOnSocketGone = true;
    try { ws.close(DEVICE_REVOKED_CLOSE, 'device signed out'); } catch { /* gone */ }
    void cutChild().catch(() => { /* already gone */ });
  };
  /** Return (planned): a phone-held session lets go — 4401, detach, nothing cut. */
  const releasePhone = (): boolean => {
    if (ownerDevice?.store !== 'mac') return false;
    ownerDevice = null;
    dropPhoneSocket('mac mode ended');
    return true;
  };
  /**
   * Let a phone socket go NOW: unbound from this child before the close is even sent, so a
   * client that never answers the close frame (a script, not a browser) cannot keep driving the
   * chat through the closing handshake (`ws` delivers frames until its 30 s close timeout).
   * The child detaches as on any dropped socket; the socket is terminated after 1 s.
   */
  function dropPhoneSocket(reason: string): void {
    const sock = ws;
    if (socketDevice.get(sock)?.store !== 'mac') return;
    sock.off('message', onSocketFrame);
    try { sock.close(DEVICE_REVOKED_CLOSE, reason); } catch { /* gone */ }
    onSocketGone();
    const t = setTimeout(() => { try { if (typeof sock.terminate === 'function') sock.terminate(); } catch { /* gone */ } }, 1000);
    t.unref?.();
  }
  const deviceSession = { device: () => ownerDevice, revoke: revokeForDevice, releasePhone };
  armDeviceRevocation();
  deviceSessions.add(deviceSession);

  // ── Detach instead of dying with the socket (agent-chat-live.ts) ───────────────────
  // A pinned project chat survives a dropped socket: the child keeps stdin, and a client's
  // reattach adopts it. The Assistant (its socket is the relay's only channel) and an unpinned
  // session (nothing to reattach by) keep the old drain-on-close lifecycle.
  const live: LiveChatEntry | null = !isAssistant && pinId ? {
    conversationId: pinId,
    projectRoot,
    busy: false,
    turnStartedAt: null,
    lastTurnEndedAt: null,
    adopt: (next, how) => adoptSocket(next, how),
    holder: () => (alive && !detached && ws.readyState === ws.OPEN ? ws : null),
    supersede: () => supersedeLive(),
    cut: () => cutChild(),
    pid: child.pid,
    ...(isSuper ? {
      mirror: (sock: import('ws').WebSocket, device: DeviceTag) => addMirror(sock, device),
      mirrorRoom: (device: DeviceTag) => mirrors?.room(device) ?? false,
      mirrorFrame: (serialised: string) => { mirrors?.frame(serialised); },
      mirrorCount: () => mirrors?.size ?? 0,
    } : {
      watch: (sock: import('ws').WebSocket, device: DeviceTag) => addWatch(sock, device),
      watchRoom: (device: DeviceTag) => mirrors?.room(device) ?? true,
    }),
    closeMirrors: () => { mirrors?.closeAll(MIRROR_CLOSE_ENDED, isSuper ? 'super taken back' : 'child taken back'); },
  } : null;
  if (live) registerLiveChat(live);
  /** A phone joins this Super Agent beside its holder. It reads the turn state like a reattach
   *  (and replays what it missed from chat-history); the window's prompts are not its own. */
  function addMirror(sock: import('ws').WebSocket, device: DeviceTag): boolean {
    if (!mirrors || !alive || handedOff || lingerTimer || lingerKillTimer) return false;
    const set = mirrors;
    if (!set.add(sock, device)) return false;
    try { sock.send(JSON.stringify({ type: '_meta', subtype: 'reattached', adopted: true, busy: turnsInFlight > 0 })); } catch { /* gone */ }
    // The next push tells every mirror in full (this one included), and a digest sent from here
    // on makes the snapshot below stale.
    digestKeys.delete(pinId);
    stageKeys.delete(pinId);
    const joinedAt = ++digestClock;
    // The pictures on the Mac's stage right now, once: the phone has no stage, and an image card
    // opened before it joined would otherwise never reach it (D2). And the agenda as it stands.
    // Best-effort and async — a missing or unreadable super record just means neither.
    void readSuperState(contextRoot, superSanitizeOpts())
      .then((st) => {
        if (!set.has(sock) || sock.readyState !== sock.OPEN) return;
        const frame = stageMediaFrame(stageImageItems(st), true);
        if (frame) sock.send(frame);
        if ((digestSeq.get(pinId) ?? 0) < joinedAt) sock.send(superDigestFrame(superDigest(st)));
      })
      .catch(() => { /* no record, no strip */ });
    return true;
  }
  /**
   * A remote screen WATCHES this chat, a Super child while its project is handed over: a
   * read-only mirror (no inbound handler at all), made on the first watch and joined to the
   * registry Return and revocation walk. It reads the turn state like a reattach and is told it
   * only watches; no stage pictures, no agenda (those are the Super's).
   */
  function addWatch(sock: import('ws').WebSocket, device: DeviceTag): boolean {
    if (isSuper || !alive || handedOff || lingerTimer || lingerKillTimer || !pinId || !isHandedOverChild(pinId)) return false;
    if (!mirrors) {
      mirrors = new MirrorSet<DeviceTag>({
        valid: deviceStillValid,
        readOnly: true,
        holder: () => (alive && !detached && ws.readyState === ws.OPEN ? ws : null),
        key: (d) => d.idHash,
      });
      superMirrorSets.add(mirrors);
    }
    if (!mirrors.add(sock, device)) return false;
    try { sock.send(JSON.stringify({ type: '_meta', subtype: 'reattached', adopted: true, busy: turnsInFlight > 0, watchOnly: true })); } catch { /* gone */ }
    return true;
  }
  /** No socket right now; the reap timers below decide how long that may last. */
  let detached = false;
  let detachedAt = 0;
  /** The next socket-gone ends the child instead of detaching it: the client said goodbye
   *  (`end`, a closed tab). A respawn's supersede is counted apart (`pendingSupersedes`). */
  let endOnSocketGone = false;
  /** Opens of this conversation that superseded it and were not refused. While any is
   *  counted the next socket-gone drains; a refused open withdraws its own (`supersedeLive`). */
  let pendingSupersedes = 0;
  let detachIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let detachCapTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Permission/question prompts the CLI is still waiting on, as the raw lines it printed. A
   *  prompt printed while detached reached no socket, so an adopting socket is handed them
   *  again — otherwise the turn would wait forever on a card nobody can see. */
  const outstandingAsks = new Map<string, string>();

  // ── Parking under load (chat-park.ts) ───────────────────────────────────────────────
  // A pinned project chat (not the Assistant, not a whiteboard card) can be parked by the
  // load sweep or `super end`: a `park` frame down THIS socket, answered by the window.
  const spawnedAt = Date.now();
  /** The CLI's running background roster (`system:background_tasks_changed`): shells and agents
   *  a park would kill. */
  let backgroundTasks = 0;
  /** The window's last `focus` frame: the owner looked at or typed in this tab. */
  let focusedAt = 0;
  let parkAsk: { id: string; settle: (o: ParkOutcome) => void; promise: Promise<ParkOutcome> } | null = null;
  const PARK_REFUSALS: readonly ParkOutcome[] = ['busy', 'asking', 'background', 'focused'];
  const parkThis = (reason: string, opts: ParkOptions = {}): Promise<ParkOutcome> => {
    if (!alive || lingerTimer || lingerKillTimer) return Promise.resolve('already');
    if (parkAsk) return parkAsk.promise;
    // No socket (the window closed, the phone slept): nobody to ask, the process just ends.
    if (detached || ws.readyState !== ws.OPEN) { unregisterPark(); drain(); return Promise.resolve('drained'); }
    const id = randomUUID();
    let settle!: (o: ParkOutcome) => void;
    const promise = new Promise<ParkOutcome>((res) => { settle = res; });
    const timer = setTimeout(() => { if (parkAsk?.id === id) { parkAsk = null; settle('no_answer'); } }, PARK_ANSWER_MS);
    timer.unref?.();
    parkAsk = { id, promise, settle: (o) => { clearTimeout(timer); parkAsk = null; settle(o); } };
    try { ws.send(JSON.stringify({ type: '_meta', subtype: 'park', id, reason, focusGraceMs: parkFocusGraceMs(), ...(opts.end ? { end: true } : {}), ...(opts.force ? { force: true } : {}) })); }
    catch { parkAsk.settle('no_answer'); }
    return promise;
  };
  /** The window answered a park frame. Parked: the tab is dormant and its socket is closing;
   *  that close ends the child (never a detach), and a socket that lingers is drained anyway. */
  const onParkResult = (r: { id?: unknown; ok?: unknown; error?: unknown }): void => {
    if (!parkAsk || r.id !== parkAsk.id) return;
    if (r.ok === true) {
      endOnSocketGone = true;
      unregisterPark();
      const t = setTimeout(() => { if (alive && !detached) drain(); }, 5_000);
      t.unref?.();
      parkAsk.settle('parked');
      return;
    }
    const e = typeof r.error === 'string' ? r.error as ParkOutcome : 'refused';
    parkAsk.settle(PARK_REFUSALS.includes(e) ? e : 'refused');
  };
  const unregisterPark = live && !card ? registerParkable({
    id: live.conversationId,
    kind: 'chat',
    projectRoot,
    pid: child.pid,
    exempt: () => (isSuper ? 'super' : ownerDevice?.store === 'mac' ? 'phone' : null),
    busy: () => turnsInFlight > 0,
    asking: () => outstandingAsks.size > 0 || (registry ? getChat(chatRegistryId)?.status === 'asking' : false),
    backgroundTasks: () => backgroundTasks,
    idleSince: () => Math.max(spawnedAt, live.lastTurnEndedAt ?? 0),
    focusedAt: () => focusedAt,
    transcriptPath: () => liveTranscriptPath(contextRoot, live.conversationId),
    park: parkThis,
  }) : () => { /* never parked */ };
  /** The context handoff in progress (or the last one), drawn live by the chat as a staged
   *  card — see handoff-progress.ts. Replayed to an adopting socket like `outstandingAsks`. */
  let handoffRun: HandoffRun | null = null;
  /** The main chain's context as of its latest assistant frame — the handoff's "before" when
   *  the record itself did not carry one. */
  let lastMainContext = 0;
  const setHandoffRun = (next: HandoffRun | null): void => {
    if (!next) return;
    handoffRun = next;
    sendMeta(handoffProgressFrame(next));
  };

  /** A turn edge — the ONLY place the live entry's activity fields move (see the contract in
   *  agent-chat-live.ts: sockets, pings and replays never touch them). */
  const openTurn = (): void => {
    turnsInFlight += 1;
    if (live) markTurnStarted(live);
    armDetachReap();
  };
  /** A main `result`: the CLI has answered every user frame written before it, folded steers
   *  included (see `turnsInFlight`). */
  const closeTurn = (): void => {
    turnsInFlight = 0;
    outstandingAsks.clear();
    // Every frame written before this result is answered by it (the CLI folds them in one turn).
    if (voiceArmed) { voiceArmed = false; sendMeta({ subtype: 'voice_turn_end' }); }
    if (live) markTurnEnded(live);
    // A restart owed since mid-turn may go now: say so with `turnInFlight: false`.
    reannounceSwitch();
    armDetachReap();
    // The Super Agent's event turn is over (an owner message steered into it was answered in
    // the same `result`); the queue's next batch may go now (D7).
    if (superEventTurnOpen) superEventTurnOpen = false;
    if (isSuper) setImmediate(() => superTurnEnded(chatRegistryId));
  };
  /**
   * The CLI acked an interrupt and no `result` followed: nothing was running, or what was
   * running ended without saying so. Stop must still stop, so the turn is closed HERE and the
   * client is told it is idle — without this an idle ack left a pane "Working…" with a Stop
   * that could no longer reach anything.
   */
  const settleAfterInterrupt = (): void => {
    interruptSettleTimer = null;
    if (!alive) return;
    // Stop with no `result`: a "New session" turn never rotates now, and a rotation that will
    // never see its continue result stops holding the Super Agent's inbox (fresh-session.ts).
    if (isSuper) {
      clearFresh(chatRegistryId);
      if (handoffRun && handoffRun.stage !== 'done' && handoffRun.stage !== 'failed') setHandoffRun(failHandoffRun(handoffRun, 'stopped'));
      stopRotating(chatRegistryId);
    }
    if (turnsInFlight > 0) closeTurn();
    sendMeta({ subtype: 'turn_state', busy: false });
  };

  // Auto-submit the (non-deferred) initial prompt as the first stdin frame — see the
  // deferred-prompt note above for why this must NOT wait for `system:init`.
  if (submitPrompt) {
    try {
      // A server-submitted opening prompt is a REAL turn, so it must set `turnInFlight` like
      // every other user frame — otherwise a switch decision arriving during it would read
      // "nothing running" and restart over live work.
      openTurn();
      // A refused opening prompt is the worst one to lose: the user never typed it into a
      // composer they could scroll back to.
      lastSentText = submitPrompt;
      lastSentSpoken = false;
      turnProgressed = false;
      registry?.userSent(submitPrompt);
      child.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: submitPrompt }] },
      }) + '\n');
    } catch { /* child died at spawn — the close handler reports it */ }
  }

  const clearInterruptTimers = () => {
    if (interruptWatchdog) { clearTimeout(interruptWatchdog); interruptWatchdog = null; }
    if (interruptKillTimer) { clearTimeout(interruptKillTimer); interruptKillTimer = null; }
  };

  const clearLingerTimers = () => {
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
    if (lingerKillTimer) { clearTimeout(lingerKillTimer); lingerKillTimer = null; }
  };

  /** Write one NDJSON line to claude's stdin, guarded by `alive` + a try/catch — a write
   *  raced against child exit must never throw and crash the upgrade handler. */
  const writeStdin = (obj: unknown): boolean => {
    if (!alive) return false;
    try { child.stdin.write(JSON.stringify(obj) + '\n'); return true; }
    catch { return false; /* stream torn down between the alive check and the write — best-effort */ }
  };

  /** Hand one OWNER message to the CLI as a turn — the socket's user frame, and a held message
   *  released by `releaseStalledSwitch`. */
  const writeOwnerTurn = (text: string): void => {
    openTurn();
    lastSentText = text;
    turnProgressed = false;
    registry?.userSent(text);
    // The Assistant hears what is happening right now with every owner turn: a second,
    // server-written block whose only project text is each chat's fenced `topic:`
    // (live-context.ts), dropped from the replay because it starts with `<`.
    const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text }];
    if (isAssistant) {
      const live = assistantLiveContext();
      if (live) content.push({ type: 'text', text: live });
    }
    // Every owner message to the Super Agent carries its reference, so its answer can open with
    // `<!-- re:<ref> -->` and the window draws which message it answers (replyMark.ts). Hashed
    // from the exact text the window sent; a slash command is no message of his.
    if (isSuper && !text.startsWith('/')) content.push({ type: 'text', text: ownerMsgBlock(text) });
    // The Super Agent hand-over / take-back note (plan-r7 D17) rides on a CHILD's next owner
    // message, the same way: a second, fixed, server-written block starting with `<`, so the
    // replay drops it and the owner's bubble and `userSent` keep his text. Read from memory
    // only; a slash command waits for the next real message; cleared only after a write that
    // happened (the note it delivered, nothing written meanwhile).
    const note = registry && !isSuper && !text.startsWith('/') ? peekSuperNote(chatRegistryId) : null;
    if (note) content.push({ type: 'text', text: SUPER_NOTE_TEXT[note] });
    // The Super Agent's briefing changed since its session began (K9): this owner message
    // carries the new sections, once; again only after a compaction drops them.
    const brief = isSuper && superBrief.due && !text.startsWith('/');
    if (brief) content.push({ type: 'text', text: SUPER_BRIEF_TEXT });
    // A spoken message to the Super Agent (K1): its answer is read aloud. The window reads
    // only what streams between `voice_turn` and `voice_turn_end`; an event turn never arms it.
    const voice = isSuper && spokenTexts.delete(text);
    if (voice) content.push({ type: 'text', text: OWNER_VOICE_TEXT });
    // A dictated message (task sesli-giris-bozuk…): its take's ref, language and quality, so
    // the agent can `dreamcontext voice retry <ref>` a transcript that reads as nonsense.
    const take = voiceTakes.get(text);
    if (take) {
      voiceTakes.delete(text);
      const block = text.startsWith('/') ? null : voiceTakeBlock(take);
      if (block) content.push({ type: 'text', text: block });
    }
    // The Super Agent's own question is open: this message answers it, and everything held
    // back while it was open rides in the SAME message (inbox.ts `superAnswerDigest`), a block
    // starting with `<` the replay drops.
    // A message about agenda lines answers the open question only when one of its parts is it;
    // a reply to a message (its ↩) is about that message, never the open question's answer.
    const abouts = isSuper ? aboutHeads(text).map(({ kind, id }) => ({ kind, id })) : [];
    const held = isSuper && !text.startsWith('/') ? superAnswerDigest(chatRegistryId, Date.now(), abouts) : null;
    if (held) content.push({ type: 'text', text: held.text });
    // The owner spoke to the Super Agent: its turn is no inbox bookkeeping any more.
    if (isSuper) markSuperEventTurn(chatRegistryId, false);
    const wrote = writeStdin({ type: 'user', message: { role: 'user', content } });
    // Written, and not a slash command: the owner's lease, the running event turn marked
    // steered, an open `ask` answered, the held events it carried delivered (plan r4 D4, D7, D18).
    if (isSuper && wrote && !text.startsWith('/')) superOwnerSpoke(chatRegistryId, Date.now(), held?.items ?? [], abouts);
    if (note && wrote) {
      void clearSuperNote(superRootOfChild(chatRegistryId) ?? contextRoot, chatRegistryId, note).catch(() => { /* memory already cleared */ });
    }
    if (brief && wrote) superBrief.due = false;
    if (voice && wrote && !voiceArmed) { voiceArmed = true; sendMeta({ subtype: 'voice_turn' }); }
    lastSentSpoken = voice && wrote;
  };

  const sendMeta = (frame: Record<string, unknown>): void => {
    // The inbox's event chip is conversation the phone reads too. Nothing else sent here is the
    // mirror's, and the window's verbs and state (its token's channel) never leave its socket.
    if (mirrors && frame.subtype === SUPER_FRAME_EVENT) mirrors.frame(JSON.stringify({ type: '_meta', ...frame }));
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify({ type: '_meta', ...frame })); } catch { /* closing */ }
    }
  };

  // The live browser view: watches the override's CDP port once the agent calls a browser tool.
  // The Super Agent's stage reads every non-super chat's output for a dev-server pin or a
  // live browser (jarvis S1, S2); a chat that is not a super child returns on the first check.
  const superSignals = isSuper ? null : createSuperSignalObserver(chatRegistryId, browserOverride?.server ?? null);
  const browserMirror = browserOverride
    ? createBrowserMirror({ port: browserOverride.port, server: browserOverride.server, send: (frame) => sendMeta(frame) })
    : null;

  // Hand the client this project's known slash commands right away, so `/` autocompletes on
  // the very FIRST message instead of only after the CLI has emitted its own `system:init`
  // (which it withholds until a turn has started — see the cache's header note). A real init
  // later in this stream carries the same field and simply supersedes this.
  const cachedSlash = readSlashCache(contextRoot);
  if (cachedSlash) sendMeta({ subtype: 'slash_commands', commands: cachedSlash });

  // Which account this process really runs on. The client asked for one (or for the default),
  // and the default may have skipped a full account — so the composer's account chip reads
  // this, not its own request. Said again on every reattach for a client that just arrived.
  if (activeAccountId) sendMeta({ subtype: 'account_active', accountId: activeAccountId });

  // A reattach found no live child (it exited while the client was away), so this is a fresh
  // resume: nothing is running, and the client replays the transcript it missed.
  if (opts.reattachFallback) sendMeta({ subtype: 'reattached', adopted: false, busy: false });

  // The pane's context-handoff toggle, sent the same way and for the same reason: the
  // CLI's own `init` cannot carry a dreamcontext field, so this frame IS the augmented
  // init. A resumed pane must show what is on disk, not what was clicked last time.
  try {
    if (pinId) {
      const state = resolveHandoffFor(contextRoot, projectRoot, pinId);
      sendMeta({ subtype: 'context_handoff', state: { enabled: state.enabled, nudgeAt: state.nudgeAt, hardAt: state.hardAt, remindEvery: state.remindEvery } });
    }
  } catch { /* the switch falls back to its default rendering */ }

  // What the fresh-start branch guard did, in one sentence — sent only for the outcomes that
  // are actually news (`describeFreshStart` returns null for "already on it", for a worktree
  // root, and for a repo with no resolvable default). The kind rides along so the client can
  // tone a refusal differently from a move it did not ask for.
  if (freshStart) {
    const message = describeFreshStart(freshStart);
    if (message) sendMeta({ subtype: 'branch_start', kind: freshStart.kind, message });
  }

  // Echo the auto-submitted opening prompt back to the client so the chat transcript SHOWS
  // it as the first user message. The terminal surface gets this for free (the prompt is
  // literally typed into the visible readline); chat writes it straight to the child's
  // stdin, so without this echo a spawn-with-prompt (sleep, brain-resolve, delegate) opened
  // a transcript with nothing in it and read as "the message never got sent". The echo is
  // the server's job, not the client's: with `promptToken` the client never sees the text at
  // all, and a deferred prompt (`deferPrompt`, "the user speaks first") must NOT be echoed —
  // `submitPrompt` is already empty in that case, so both fall out of this one condition.
  if (submitPrompt) sendMeta({ subtype: 'prompt_echo', text: submitPrompt });

  // ── The account underneath this process changed ───────────────────────────────────────
  //
  // `claude` reads its credentials once, at startup, so a `claude auth login` into another
  // account leaves every already-open session talking to the API as the OLD one. Nothing in
  // the stream says so — the turns keep working, they are just billed to and rate-limited by
  // an account the user thinks they left. The only cure is a restart, and this frame is what
  // tells the client one is due.
  //
  // The epoch guard is what keeps this honest: a session spawned AFTER the switch already
  // holds the new credentials, and telling it to restart would be a pointless reconnect. Only
  // a session that predates the change hears about it.
  const unwatchAuth = claudeAuthWatcher.subscribe((change) => {
    if (change.epoch <= spawnAuthEpoch) return;   // spawned into the new account already
    // ── SCOPED, not global ────────────────────────────────────────────────────────────
    // The watcher deliberately stays a SINGLE-HOME watcher: its job is to notice that THE
    // MACHINE's account changed under us, and a switch WE chose must stay distinguishable
    // from one the user made outside the app. But its broadcast has to be filtered, because
    // this session may be running on a sandbox whose credentials that event says nothing
    // about — forwarding it would kill and respawn a perfectly healthy, unrelated session.
    // So only a session running on the real HOME hears it.
    if (!isRealHomeAccount) return;
    sendMeta({
      subtype: 'auth_changed',
      identity: change.identity,
      // The client restarts on `true` only. A signed-out or unknown result is reported so the
      // user is not left guessing, but never acted on — see `isRestartable`.
      restart: change.restartable,
      loggedIn: change.status.loggedIn,
    });
  });

  /** Full cleanup — runs when the CHILD is gone (exit/spawn-error), never on socket close
   *  alone. Untracking here (and only here) is what lets a tab-less, still-draining child
   *  remain reapable by the server's own shutdown (`killTrackedChildren`). */
  const teardown = (): void => {
    if (voiceArmed) { voiceArmed = false; sendMeta({ subtype: 'voice_turn_end' }); }
    if (!alive) return;
    alive = false;
    deviceSessions.delete(deviceSession);
    // A gone child cannot be mid-turn. `armAccountSwitch` checks `exited` too, but leaving a
    // stale count here would be a lie about the one thing only this side can report.
    turnsInFlight = 0;
    clearInterruptTimers();
    if (interruptSettleTimer) { clearTimeout(interruptSettleTimer); interruptSettleTimer = null; }
    clearLingerTimers();
    clearDetachTimers();
    if (switchStallTimer) { clearTimeout(switchStallTimer); switchStallTimer = null; }
    stopPing();
    if (live) unregisterLiveChat(live);
    if (mirrors) { mirrors.closeAll(MIRROR_CLOSE_ENDED, 'super ended'); superMirrorSets.delete(mirrors); digestKeys.delete(pinId); digestSeq.delete(pinId); stageKeys.delete(pinId); }
    unregisterPark();
    parkAsk?.settle('already');
    untrack();
    releaseHeld();
    cleanupDeferred();
    cleanupBriefing();
    cleanupAgents();
    cleanupModeNote();
    browserMirror?.dispose();
    browserOverride?.dispose();
    removeLeanMcpConfig(leanMcpPath);
    envelope?.dispose();
    unwatchAuth();
    registry?.exited();
    // A respawn in place hands the notch's surface to its successor on the same socket.
    if (!handedOff) disposeSurface();
    windowControl?.release();
    detachInbox();
    unlistenAutonomy();
    // The session's checkout override dies with the session. Left behind it would be answered
    // to a RESUMED conversation of the same id whose agent is back in the project root — and
    // the same holds for its write counts, which would otherwise warn a fresh pane about
    // edits made by a run that has ended.
    if (pinId) { clearSessionCheckout(pinId); clearSessionEdits(pinId); }
  };

  /** End the child: drain and reap. The terminal route kills its PTY the moment the socket
   *  closes (agent-terminal.ts's teardown); chat drains instead of killing so an in-flight turn
   *  can finish and land in the transcript, but the END state is the same: no child lives on
   *  for long. See CLOSE_LINGER_MS for the leak this closes. The conversation hold is released
   *  immediately so a re-opened tab can `--resume` without waiting out the drain (the
   *  drain-vs-resume write race this leaves open is the same documented beta limitation the
   *  terminal/chat double-attach already has). */
  function drain(): void {
    if (!alive || lingerTimer || lingerKillTimer) return;
    // The phone's mirrors leave with the stdin: their reconnect lands on the successor.
    mirrors?.closeAll(MIRROR_CLOSE_ENDED, 'super ended');
    clearDetachTimers();
    if (switchStallTimer) { clearTimeout(switchStallTimer); switchStallTimer = null; }
    stopPing();
    // No longer adoptable (a reattach arriving now resumes in a new process instead), but still
    // listed as running and cuttable until it actually exits (D22; teardown unregisters it).
    if (live) markLiveChatDraining(live);
    releaseHeld();
    // EOF: nothing will ever write another stdin frame, and the CLI exits on its own once
    // its queue drains. An already-dead stream just means the close handler is on its way.
    try { child.stdin.end(); } catch { /* already torn down */ }
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      if (!alive) return;
      try { reapChild(child); } catch { /* already gone */ }
      lingerKillTimer = setTimeout(() => {
        lingerKillTimer = null;
        if (!alive) return;
        try { reapChild(child, 'SIGKILL'); } catch { /* already gone */ }
      }, CLOSE_KILL_GRACE_MS);
    }, closeLingerMs());
  }

  function clearDetachTimers(): void {
    if (detachIdleTimer) { clearTimeout(detachIdleTimer); detachIdleTimer = null; }
    if (detachCapTimer) { clearTimeout(detachCapTimer); detachCapTimer = null; }
  }

  /** (Re)arm the reaping of a DETACHED child for its current state. A no-op while attached.
   *  Idle: ended after `detachIdleMs()` (15 min) of continuous idleness. Busy: never reaped
   *  for lack of a socket, up to `detachBusyCapMs()` (4 h) after it lost its socket. */
  function armDetachReap(): void {
    if (!detached || !alive) return;
    if (turnsInFlight > 0) {
      if (detachIdleTimer) { clearTimeout(detachIdleTimer); detachIdleTimer = null; }
      if (!detachCapTimer) {
        const left = Math.max(0, detachBusyCapMs() - (Date.now() - detachedAt));
        detachCapTimer = setTimeout(() => { detachCapTimer = null; drain(); }, left);
      }
      return;
    }
    if (detachCapTimer) { clearTimeout(detachCapTimer); detachCapTimer = null; }
    if (!detachIdleTimer) {
      detachIdleTimer = setTimeout(() => { detachIdleTimer = null; drain(); }, detachIdleMs());
    }
  }

  /** The pong listener of the socket being pinged, removed with the timer so repeated starts
   *  (every reattach, every Assistant hand-off) never stack listeners on a socket. */
  let pongOff: (() => void) | null = null;

  function stopPing(): void {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (pongOff) { pongOff(); pongOff = null; }
  }

  /** Ping the bound socket every `wsPingMs()` (25 s). A socket that did not answer the previous
   *  ping is terminated, so a half-open connection (the phone vanished without a FIN) becomes a
   *  detach now instead of a socket the server writes into for minutes. Pings are transport
   *  only: they never touch the live entry's activity fields. */
  function startPing(): void {
    stopPing();
    const sock = ws;
    if (typeof sock.ping !== 'function') return;
    let waiting = false;
    const onPong = (): void => { waiting = false; };
    sock.on('pong', onPong);
    pongOff = () => { sock.off('pong', onPong); };
    pingTimer = setInterval(() => {
      if (sock !== ws || sock.readyState !== sock.OPEN) { stopPing(); return; }
      if (waiting) { try { sock.terminate(); } catch { /* already gone */ } return; }
      waiting = true;
      try { sock.ping(); } catch { /* closing */ }
    }, wsPingMs());
    pingTimer.unref?.();
  }

  function bindSocket(): void {
    ws.on('message', onSocketFrame);
    ws.on('close', onSocketGone);
    ws.on('error', onSocketGone);
    startPing();
  }

  /** A client's reattach: bind `next` to this very child. False when the child can no longer
   *  be adopted (exiting, draining, or handing off) — the caller then spawns a resume. */
  function adoptSocket(next: import('ws').WebSocket, how: 'halfopen' | 'takeover' = 'halfopen'): boolean {
    if (!alive || lingerTimer || lingerKillTimer || handedOff || deviceRevoked) return false;
    const prev = ws;
    prev.off('message', onSocketFrame);
    prev.off('close', onSocketGone);
    prev.off('error', onSocketGone);
    // A late error on the abandoned socket must not throw for want of a listener.
    prev.on('error', () => { /* abandoned socket */ });
    if (prev !== next && prev.readyState === prev.OPEN) {
      if (how === 'takeover') {
        // An explicit tap took the chat from a LIVE screen: it is told (4409) and stops its
        // reconnect loop, offering "Buraya al" — never terminated as if it were dead.
        try { prev.close(MAC_CLOSE_TAKEN_OVER, 'taken_over'); } catch { /* gone */ }
      } else {
        // Still "open" means half-open: the client already moved to `next`.
        try { if (typeof prev.terminate === 'function') prev.terminate(); else prev.close(); } catch { /* gone */ }
      }
    }
    stopPing();
    ws = next;
    // Per socket: a phone socket makes its device the owner, a desktop socket clears it.
    ownerDevice = socketDevice.get(next) ?? null;
    detached = false;
    clearDetachTimers();
    bindSocket();
    // The Super Agent's window gets its state again on every reattach (never polled).
    if (isSuper) superSocketAttached(chatRegistryId);
    // Tells the client it got the SAME process back and whether a turn is still running —
    // what it missed meanwhile it replays from chat-history.
    sendMeta({ subtype: 'reattached', adopted: true, busy: turnsInFlight > 0 });
    // A spoken turn still being answered: the new socket reads the rest of it aloud.
    if (isSuper && voiceArmed) sendMeta({ subtype: 'voice_turn' });
    if (activeAccountId) sendMeta({ subtype: 'account_active', accountId: activeAccountId });
    for (const line of outstandingAsks.values()) {
      try { ws.send(line); } catch { /* closing */ }
    }
    if (handoffRun) sendMeta(handoffProgressFrame(handoffRun));
    browserMirror?.replay();
    // A switch announced to the socket that went away is still owed: the client that just
    // arrived never read it, and without it the held messages wait for a restart nobody asks for.
    reannounceSwitch();
    return true;
  }

  /** A respawn wants this conversation. Returns its settlement, called once the open is
   *  decided: `true` = accepted (a child was spawned), `false` = refused.
   *   • Detached and idle: drained now — nothing is running that a refusal could cost.
   *   • Detached and BUSY: the hold is only LENT, so the new open can take the conversation;
   *     the drain waits for acceptance. A refused open hands the hold back and leaves the turn
   *     running and reattachable.
   *   • Attached: the next socket-gone drains instead of detaching — unless the open is refused,
   *     in which case this pane keeps its detach.
   *  A drain already started is never undone. */
  function supersedeLive(): (accepted: boolean) => void {
    let settled = false;
    const settleOnce = (fn: (accepted: boolean) => void) => (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      fn(accepted);
    };
    if (detached && turnsInFlight === 0) { drain(); return () => { /* already given up */ }; }
    if (detached) {
      if (heldConversation && liveConversations.has(heldConversation)) {
        liveConversations.delete(heldConversation);
        holdLent = true;
      }
      return settleOnce((accepted) => {
        // Accepted: the new process holds the conversation now; `holdLent` keeps the drain
        // from releasing its hold.
        if (accepted) { drain(); return; }
        if (!holdLent || !alive || !heldConversation) return;
        // Refused: take the hold back — unless someone else took the conversation meanwhile,
        // in which case it stays theirs and this child must never release it.
        if (!liveConversations.has(heldConversation)) {
          liveConversations.add(heldConversation);
          holdLent = false;
        }
      });
    }
    pendingSupersedes += 1;
    return settleOnce((accepted) => {
      if (!accepted) pendingSupersedes = Math.max(0, pendingSupersedes - 1);
    });
  }

  /** Socket gone (tab closed, app window died, network drop, phone locked). A pinned project
   *  chat DETACHES — the child keeps running, keeps the conversation, and waits to be adopted
   *  by the client's reattach; `armDetachReap` bounds how long. Everything else, and a client
   *  that said goodbye (`end`), drains exactly as before. */
  function onSocketGone(): void {
    // The notch's socket is the relay's only channel: with it gone, nothing can execute.
    disposeSurface();
    if (!alive || lingerTimer || lingerKillTimer) return;
    stopPing();
    if (!live || endOnSocketGone || pendingSupersedes > 0) { drain(); return; }
    if (detached) return;   // close and error both fired
    detached = true;
    detachedAt = Date.now();
    armDetachReap();
  }

  // ── claude stdout → ws (verbatim NDJSON relay) ─────────────────────────────────────
  // One watcher per session: correlating a tool_use id with the tool_result that carries the
  // path is per-conversation state, and two panes must not read each other's moves.
  const observeWorktree = createWorktreeWatcher();
  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf-8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (ws.readyState === ws.OPEN) {
        try { ws.send(line); } catch { /* closing */ }
      }
      mirrors?.line(line);

      // Light local parse (type/subtype only — full typed parsing is the CLIENT's job,
      // chatProtocol.ts) so the server knows when an interrupt has actually resolved.
      // Never throws on non-JSON/partial lines.
      let obj: Record<string, unknown> | null = null;
      try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { /* partial line */ }
      if (!obj) continue;

      registry?.observe(obj);
      browserMirror?.observe(obj);
      superSignals?.observe(obj);
      // A compaction drops the message that carried the briefing update (never the system prompt).
      if (isSuper && obj.type === 'system' && obj.subtype === 'compact_boundary' && !superBrief.inPrompt) superBrief.due = true;
      if (obj.type === 'system' && obj.subtype === 'background_tasks_changed') {
        backgroundTasks = Array.isArray(obj.tasks) ? obj.tasks.length : 0;
      }

      // A prompt the CLI now waits on (or no longer does) — replayed to an adopting socket.
      if (typeof obj.request_id === 'string') {
        const req = obj.request as { subtype?: unknown } | undefined;
        if (obj.type === 'control_request' && req?.subtype === 'can_use_tool') outstandingAsks.set(obj.request_id, line);
        else if (obj.type === 'control_cancel_request') outstandingAsks.delete(obj.request_id);
      }

      // An interrupt resolves either as a `result` frame or the CLI's own control_response
      // acking the interrupt request — either is "the turn is winding down", so disarm the
      // escalation watchdog (the child's own exit is still tracked separately below).
      if (interruptWatchdog && (obj.type === 'result' || obj.type === 'control_response')) {
        clearInterruptTimers();
      }
      // …but an ack is not a turn end: an IDLE CLI acks an interrupt and sends no `result` at
      // all (measured on 2.1.301). Give a real abort the same window to land its `result`.
      if (obj.type === 'control_response' && interruptRequestId
        && (obj.response as { request_id?: unknown } | undefined)?.request_id === interruptRequestId) {
        interruptRequestId = null;
        if (interruptSettleTimer) clearTimeout(interruptSettleTimer);
        interruptSettleTimer = setTimeout(settleAfterInterrupt, INTERRUPT_WATCHDOG_MS);
      }
      if (obj.type === 'result' && obj.parent_tool_use_id === undefined && interruptSettleTimer) {
        clearTimeout(interruptSettleTimer); interruptSettleTimer = null;
      }
      // Every turn opens with `system:init`, ours or not: a frame the CLI queued behind the turn
      // that just closed, or a turn it started itself (a background task finishing). Counted so
      // a switch never restarts over it — an idle child emits no `init`, so this never opens a
      // turn that is not running.
      if (obj.type === 'system' && obj.subtype === 'init' && !obj.parent_tool_use_id && turnsInFlight === 0) {
        openTurn();
      }

      // The turn is over. Tracked HERE, from the CLI's own frame, because the client's `busy`
      // is set OPTIMISTICALLY the moment a user frame is written (chatSession.ts's `writeUser`)
      // — so it says "a turn is running" for a message auto-switch is still holding, when in
      // truth nothing was ever handed to the CLI. Only the server can tell those apart.
      // ONLY the MAIN agent's own `result` closes one of OUR turns.
      //
      // BELT AND BRACES, not a fix for an observed leak — and the distinction is worth
      // recording. A dispatched sub-agent's completion does NOT arrive as a top-level
      // `result`: it comes back as `tool_use_result` on a `user` (tool_result) frame, which
      // `chatProtocol.ts`'s `fromToolUseResult` reads and this parser ignores. So today
      // nothing parented reaches this line at all. The guard is here anyway because a turn is
      // opened only for a user frame WE wrote, and counting somebody else's `result` would
      // over-decrement and read as "nothing running" while the main agent's turn continues —
      // the ONE direction that lets the account switch restart over live work. One property
      // read is the right price for closing that direction against a future CLI change.
      if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
        observedConversation = obj.session_id;
      }

      // A rotation in progress moves through its stages on these same frames. Read BEFORE the
      // result block below, which may START a run: the frame that triggers a rotation must
      // not also advance it, and `turnsInFlight` must be the count before this frame closes one.
      const stageBefore = handoffRun?.stage;
      const turnsBefore = turnsInFlight;
      if (handoffRun) setHandoffRun(advanceHandoffRun(handoffRun, obj, turnsInFlight));
      if (obj.type === 'assistant' && !obj.parent_tool_use_id) {
        const used = contextTokensFromUsage((obj.message as { usage?: Record<string, unknown> } | undefined)?.usage);
        if (used > 0) lastMainContext = used;
      }

      // The API REFUSED this turn. Read ONCE, here, before the result block: the rotation below
      // must see a refusal that arrives on this very `result` frame (the dispatch further down
      // uses the same read).
      const limit = readLimitSignal(obj);
      /** The ONE main-result predicate this frame uses (rotation, and the latch reset below). */
      const mainResult = obj.type === 'result' && obj.parent_tool_use_id === undefined;

      if (mainResult) {
        closeTurn();
        // An autonomy change waited for this boundary.
        // Through scheduleRespawn, never straight to respawnInPlace: a message may still be
        // deciding in the switch gate (an account probe takes seconds), and ending stdin under
        // it would lose it.
        if (respawnTo !== null && turnsInFlight === 0) setImmediate(scheduleRespawn);

        // The rotated Super Agent's fresh session finished its first turn: it has read its
        // handoff, so the inbox may deliver again (handoff-rotation.ts).
        if (isSuper && isRotating(chatRegistryId) && rotationFinished(stageBefore, turnsBefore)) stopRotating(chatRegistryId);

        // ── Context handoff: rotate this pane into a fresh session ────────────
        //
        // The agent ran `dreamcontext tasks handoff <slug>` (or the Super Agent `super handoff`),
        // which wrote a record keyed by THIS pane; or the super's "New session" turn ended with
        // none, and the fallback runs. A turn boundary is the only safe place to act on it:
        // `/clear` mid-turn would discard work the agent is still producing. One decision per
        // frame, in handoff-rotation.ts.
        try {
          handleRotationAtResult({
            contextRoot,
            pane: pinId,
            isSuper,
            frame: obj,
            isLimit: limitHitThisTurn || !!limit,
            observedConversation,
            lastMainContext,
            writeUserTurn: (text) => {
              openTurn();
              writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
            },
            // Its own frame, not the branch notice's one-liner: the chat draws the run as it
            // happens (handoff-progress.ts), so "it is happening" is on screen from now on.
            startRun: (run) => setHandoffRun(run),
          });
        } catch (handoffErr) {
          // A failed rotation must leave the pane exactly as it was — still usable,
          // just not rotated. The agent can always hand off again.
          const message = (handoffErr as Error).message;
          const failed = handoffRun ? failHandoffRun(handoffRun, message) : null;
          if (failed) setHandoffRun(failed);
          else sendMeta(handoffProgressFrame({ id: Date.now(), stage: 'failed', task: '', title: '', message }));
          if (isSuper) stopRotating(chatRegistryId);
        }
      }

      // The API REFUSED this turn. Read before anything else acts on the frame, because this
      // is the only account signal on the whole surface that is an observation rather than a
      // forecast — see `claude-limit-signal.ts` for the frame and why the forecast alone was
      // not enough. `onLimitRejected` writes the refusal down and moves the turn; it does
      // nothing at all when there is nowhere to move it to.
      //
      // A SUB-AGENT's rejection counts too, and deliberately so: it drew on the same account
      // quota, and the main turn it belongs to is about to fail for the same reason. (`limit`
      // was read once, above the result block.)
      // Every turn states this account's usage exactly; kept, so the panel and the chooser read
      // what the account said a moment ago rather than a cache up to an hour old.
      if (obj.type === 'rate_limit_event') noteTurnUsage(obj);
      if (limit) onLimitRejected(limit);
      else if (!obj.parent_tool_use_id && isAuthFailureFrame(obj)) onAuthFailed();
      else if (obj.type === 'assistant' && !obj.parent_tool_use_id) turnProgressed = true;
      // A turn that went through says the account is signed in again (claude-signed-out.ts).
      if (obj.type === 'result' && !obj.parent_tool_use_id) {
        if (!authFailedTurn && obj.is_error !== true && activeAccountId) clearSignedOut(activeAccountId);
        authFailedTurn = false;
      }
      // After this frame's own refusal was dispatched (it may set the latch again): the turn is over.
      if (mainResult) limitHitThisTurn = false;
      // Only AFTER the refusal was read: it can arrive on this very `result` frame. Past the
      // turn's end the text has been answered, so a LATER refusal (a background task's turn,
      // which no user frame of ours opened) must not resubmit it.
      if (obj.type === 'result' && obj.parent_tool_use_id === undefined && turnsInFlight === 0) {
        lastSentText = null;
      }

      // Refresh the project's slash-command cache from the authoritative source every time
      // the CLI reports one, so a NEW session can be handed the list before its first turn
      // (see the cache's header note for why the stream alone can't do that).
      if (obj.type === 'system' && obj.subtype === 'init' && Array.isArray(obj.slash_commands)) {
        const list = obj.slash_commands.filter((c): c is string => typeof c === 'string' && !!c);
        if (list.length) writeSlashCache(contextRoot, list);
      }

      // Which CHECKOUT this session is working in. `EnterWorktree` moves the agent out of the
      // directory it was spawned in, and until this landed the shelf went on reporting the one
      // it had left — see src/lib/session-cwd.ts for the bug, src/server/worktree-frames.ts
      // for the frame shapes. A move the registry refuses simply doesn't happen: the session
      // keeps its previous checkout rather than gaining a wrong one.
      if (pinId) {
        const move = observeWorktree(obj);
        if (move?.kind === 'enter') enterSessionCheckout(pinId, move.dir, projectRoot);
        else if (move?.kind === 'exit') exitSessionCheckout(pinId);

        // WHERE the writes are landing, which is the answer for a session that declares
        // nothing at all. Counted here and never acted on — the shelf reports the
        // disagreement, it does not follow it (src/lib/session-edits.ts).
        for (const path of readEditPaths(obj)) recordSessionEdit(pinId, path, projectRoot);

        // …and the checkout the agent DECLARED, for the work it is doing somewhere its cwd
        // never went — see checkout-directive.ts. Answered on the same banner the fresh-start
        // guard uses, because a refusal the agent cannot see is a claim it will keep making.
        const said = readCheckoutDirective(obj);
        if (said?.kind === 'reset') {
          exitSessionCheckout(pinId);
          sendMeta({ subtype: 'branch_start', kind: 'moved', message: describeCheckoutReset() });
        } else if (said?.kind === 'set') {
          const ok = enterSessionCheckout(pinId, said.dir, projectRoot, { claim: true });
          // Re-read rather than trust the memo: a claim is worth a sentence naming the branch
          // it landed on, and that reading is 12s stale exactly when the agent just moved.
          if (ok) forgetSessionFacts(said.dir);
          sendMeta({
            subtype: 'branch_start',
            kind: ok ? 'moved' : 'failed',
            message: describeCheckoutClaim(
              said.dir,
              ok ? readSessionFacts(said.dir, Date.now(), projectRoot) : null,
            ),
          });
        }
      }
    }
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4000); });

  child.on('error', (err) => {
    teardown();
    if (handedOff) { spawnSuccessor(); return; }
    sendMeta({ subtype: 'error', message: `Couldn't start claude: ${err.message}` });
    try { ws.close(); } catch { /* already closed */ }
  });

  child.on('close', (code) => {
    teardown();
    // Before the respawn's early return too: a successor starts with no handoff run, so nothing
    // would ever end this process's rotation hold but the 120 s cap.
    if (isSuper) { clearFresh(chatRegistryId); stopRotating(chatRegistryId); }
    if (handedOff) { spawnSuccessor(); return; }
    if (handoffRun) setHandoffRun(failHandoffRun(handoffRun, 'The session exited before the fresh one answered.'));
    sendMeta({ subtype: 'exit', code });
    const stderrMessage = withoutShellJobControlNoise(stderrTail).trim();
    if (code !== 0 && stderrMessage) {
      sendMeta({ subtype: 'error', message: stderrMessage });
    }
    try { ws.close(); } catch { /* already closed */ }
  });

  // ── Auto-switch: move the turn to another account BEFORE the limit lands ───────────
  //
  // WHY BEFORE: a threshold that fires AFTER the limit is exceeded switches only once the
  // user has already seen the error, which is the failure this feature exists to remove.
  //
  // WHY TWO THRESHOLDS: the `/usage` probe is FREE (measured: num_turns 0, cost 0, ~1.1s),
  // which is what lets the SWITCH threshold sit high — and a high switch threshold is what
  // stops a session being moved off its own account for no reason.
  //
  // THE MESSAGE IS NEVER SWALLOWED. If no candidate qualifies, the turn goes out on the
  // current account and the honest limit error surfaces with the earliest reset time beside
  // it. Eating a user's turn in order to hide a limit is worse than the limit.
  let switchPending = false;
  /**
   * The switch last announced, kept so it can be SAID AGAIN. A frame said once is a frame that
   * can be missed: a socket that reattached after it, or a client still gated on a turn that
   * has since ended. Re-sent at every turn boundary and on every reattach while the restart is
   * owed (`reannounceSwitch`). Held without its texts — those are `heldTexts`, re-read per send.
   */
  let pendingSwitchFrame: Record<string, unknown> | null = null;
  /**
   * Every owner message held for the restart, in the order typed.
   *
   * Until 2026-10-04 only the FIRST was held: a message arriving while a restart was owed went
   * out on the current account — the account that had just refused. Observed that day on four
   * panes at once: a weekly limit landed, the restart never came, and every "devam" / "alo" for
   * thirteen minutes earned the same "You've hit your weekly limit" while three accounts sat
   * idle. A message typed into a known wall is not "never swallowed"; it is swallowed with a
   * receipt. Each one now joins the restart instead, and the client resubmits all of them.
   */
  let heldTexts: string[] = [];
  /** Fires when an owed restart has not happened long after the turn boundary — see
   *  `releaseStalledSwitch`. */
  let switchStallTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once a restart was owed and never came. From then on this process REPORTS limits and
   *  moves nothing: whatever is broken on the client side will not be fixed by announcing
   *  another restart it cannot perform, and holding messages for it would lose them. */
  let switchAbandoned = false;

  /** stdin is ended or about to be: a draining pane (`drain`) or one handed to its successor
   *  (`respawnInPlace`). Nothing may be written to it, and no restart is owed by it any more. */
  const stdinEnding = (): boolean => !!(lingerTimer || lingerKillTimer || handedOff);

  /** (Re)send the owed switch with the texts held so far and the CLI's REAL turn state. */
  const reannounceSwitch = (): void => {
    if (!switchPending || !pendingSwitchFrame || stdinEnding()) return;
    sendMeta({
      ...pendingSwitchFrame,
      turnInFlight: turnsInFlight > 0,
      ...(heldTexts.length > 0 ? { pendingText: heldTexts[0], pendingTexts: [...heldTexts] } : {}),
      // The spoken ones stay spoken through the restart (the client resubmits them, K1).
      ...(isSuper && heldTexts.some((t) => spokenTexts.has(t)) ? { pendingSpoken: heldTexts.filter((t) => spokenTexts.has(t)) } : {}),
    });
    armSwitchStall();
  };

  /** Start the stall clock — only at a turn boundary, only while a socket is attached (a
   *  detached pane cannot restart, and a reattach re-announces). */
  const armSwitchStall = (): void => {
    if (switchStallTimer) { clearTimeout(switchStallTimer); switchStallTimer = null; }
    if (!switchPending || !alive || detached || stdinEnding() || turnsInFlight > 0) return;
    switchStallTimer = setTimeout(releaseStalledSwitch, SWITCH_STALL_MS);
    switchStallTimer.unref?.();
  };

  /**
   * The owed restart never came. Give the held messages to THIS process rather than keep them
   * from everyone: on an account that refused they earn the honest limit error, which beats a
   * message that silently never ran. Then stop moving this pane at all (`switchAbandoned`).
   */
  const releaseStalledSwitch = (): void => {
    switchStallTimer = null;
    // A pane that restarted is draining this child (its socket ended on purpose), so `detached`
    // is false and `alive` still true: writing now would hit an ended stdin, which Node reports
    // as an asynchronous 'error' event no try/catch can see.
    if (!alive || !switchPending || detached || stdinEnding() || turnsInFlight > 0) return;
    console.warn(`[agent-chat] account switch to ${String(pendingSwitchFrame?.accountId)} was announced but never performed; sending ${heldTexts.length} held message(s) on ${activeAccountId}`);
    const texts = heldTexts;
    heldTexts = [];
    switchPending = false;
    pendingSwitchFrame = null;
    switchAbandoned = true;
    // Retract the notice the client holds: the reducer replaces it wholesale, so a client that
    // missed the boundary frame cannot perform the stale move later and resubmit these texts
    // a second time.
    sendMeta({ subtype: 'account_switch', switched: false, reason: 'switch_stalled', accountId: activeAccountId });
    for (const text of texts) writeOwnerTurn(text);
  };

  /**
   * The tail of the evaluation chain. EVERY user frame is appended to it, so evaluation #2
   * cannot begin until #1 has finished.
   *
   * Without this, two messages typed seconds apart both entered `maybeSwitchAccount`, both
   * passed the `switchPending` check (it is only set at the very END, after a live subprocess
   * probe that can take seconds), and both decided to switch — the first one's held text was
   * then overwritten client-side by the second frame and LOST, having never been written to
   * stdin either. Serialising also preserves the user's own message order, which a race
   * could not promise.
   */
  let switchGate: Promise<unknown> = Promise.resolve();

  /**
   * When this pane last spent a probe on a reading too old to TRUST (as opposed to one that
   * looks near a limit). Per pane on purpose: no module state to reason about, and one pane's
   * blind spell cannot silence another's check.
   */
  let lastBlindProbeAt = 0;

  /**
   * Is this conversation small enough that moving it to ANY account costs little? See
   * `CHEAP_MOVE_MAX_CONTEXT_TOKENS`. Before the first answer the size is unknown: a fresh session
   * is small, but a resumed one carries its whole transcript and is not.
   */
  const contextIsCheapToMove = (): boolean => (lastMainContext > 0
    ? lastMainContext < CHEAP_MOVE_MAX_CONTEXT_TOKENS
    : !resumeTarget);

  /** One `rate_limit_event`: record the reading, and end a refusal the API has just outlived. */
  const noteTurnUsage = (frame: unknown): void => {
    const reading = readUsageMeterFrame(frame);
    if (reading) recordUsageMeter(accountConfigDir, reading);
    // The API just SERVED a turn here with room in the window it once refused, so that refusal
    // is over — an estimated 20-minute exile, or a window that reopened early. Narrow on purpose
    // (`meterEndsRefusal`): a weekly or per-model refusal, or one a few seconds old, stands.
    const refusal = activeAccountId ? readAccountRejections()[activeAccountId] : undefined;
    if (refusal && meterEndsRefusal(frame, refusal)) clearAccountRejection(activeAccountId);
  };

  /**
   * Where this pane should go home to, or null. Home is the account a new chat would open on
   * now (`chatSpawnAccount` — disk only, no probe), and the move is taken only when ALL hold:
   *   • nothing forces it — this is the unforced path, so it is never worth an expensive move;
   *   • it is cheap: the context is small (`contextIsCheapToMove` — a new session, or just
   *     after a handoff or compaction), so the uncached re-read on the new account is small;
   *   • the system placed this pane (`autoPlacedAccounts`): a hand-picked account stays put;
   *   • home is HIGHER in the owner's list than where the pane is. Only ever up, so two
   *     accounts can never trade a pane back and forth.
   * A pane the owner put on an account by hand (`handPickedAccounts`) and a limit later forced
   * off goes home to THAT account, once it has room, wherever it sits in the list.
   */
  const comeHomeTarget = (): string | null => {
    if (isAssistant || !contextIsCheapToMove()) return null;
    if (autoPlacedAccounts.get(pinId) !== activeAccountId) return null;
    const accounts = listClaudeAccounts();
    const picked = handPickedAccounts.get(pinId);
    const pickedAccount = picked ? accounts.find((a) => a.id === picked) : undefined;
    if (picked && !pickedAccount) handPickedAccounts.delete(pinId);   // removed from the register
    let home: string;
    if (pickedAccount) {
      if (pickedAccount.id === activeAccountId || readAccountRejections()[pickedAccount.id]) return null;
      let reading: UsageLimitsResponse = { limits: [], fetchedAtMs: null };
      try { reading = readUsageLimits(accountDecisionDir(pickedAccount)); } catch { /* unread: no proof it is full */ }
      if (provenPastThreshold(reading)) return null;
      home = pickedAccount.id;
    } else {
      const next = chatSpawnAccount().id;
      if (!next || next === activeAccountId) return null;
      home = next;
    }
    // Never straight back onto the account this pane was just forced off (`forcedOffAccounts`),
    // until its window resets or it has served a turn since with clear room.
    const forced = forcedOffAccounts.get(pinId);
    if (forced && Date.now() >= forced.until) forcedOffAccounts.delete(pinId);
    else if (forced && forced.accountId === home) {
      const target = accounts.find((a) => a.id === home);
      const served = target ? readUsageMeter(accountDecisionDir(target)) : null;
      if (!meterShowsRoomSince(served, forced.at, SWITCH_THRESHOLD_PERCENT, COME_HOME_MARGIN_PERCENT)) return null;
    }
    if (pickedAccount) return home;
    const order = accounts.map((a) => a.id);
    const here = order.indexOf(activeAccountId);
    const there = order.indexOf(home);
    return there >= 0 && (here < 0 || there < here) ? home : null;
  };

  /**
   * Ask every account where the next turn should go, and announce the answer.
   *
   * Extracted so the PRE-EMPTIVE path (percent nearing the threshold) and the POST-HOC path
   * (the API refused a turn) reach the same decision through the same code. They differ only
   * in what woke them and in what they tell the user — never in how the winner is picked, so
   * a rule fixed for one is fixed for both.
   *
   * Returns true when a restart was announced and the caller must not send the turn.
   */
  const decideAndAnnounce = async (
    text: string,
    cause: SwitchCause,
    activeReading: AccountReading,
    /** When the account we are LEAVING comes back, when a recorded refusal says so. Carried
     *  so `limit_known` can name the time instead of only the fact. */
    previousResetAt?: number,
    /** False for a text the client must NOT resubmit (an Assistant wake message): the switch
     *  is still announced, but without `pendingText`, so the client never enqueues it as a
     *  turn of its own. The inbox's owner redelivers it to the restarted chat instead. */
    resubmit = true,
  ): Promise<boolean> => {
    const accounts = listClaudeAccounts();
    // Read every candidate. The active account's reading is passed in rather than re-probed.
    const readings = await Promise.all(accounts.map(async (acc): Promise<AccountReading> => {
      const dir = accountDecisionDir(acc);
      if (dir === accountConfigDir) return { ...activeReading, id: acc.id };
      const outcome = await readAccountForDecision(dir);
      return outcome.status === 'ok'
        ? { id: acc.id, limits: outcome.limits }
        : { id: acc.id, problem: outcome.status };
    }));
    if (!alive) return true;

    const choice = chooseAccount(readings, {
      threshold: SWITCH_THRESHOLD_PERCENT,
      currentId: activeAccountId,
      preferredId: accounts.find((a) => a.preferred)?.id ?? null,
      // The register's own order IS the user's priority (Settings → Agents, drag to reorder).
      orderedIds: accounts.map((a) => a.id),
      rejectedUntil: readAccountRejections(),
      // Read at DECISION time, not at spawn time: a mode changed in Settings takes effect on
      // the next turn of every open pane, without a restart.
      strategy: switchStrategyFor(),
      weights: switchWeightsFor(),
      // A conversation carrying a large context moves inside its organization when it can: the
      // prompt cache is the organization's, so there the move costs no re-read
      // (`CHEAP_MOVE_MAX_CONTEXT_TOKENS`).
      ...(contextIsCheapToMove() ? {} : {
        keepOrg: accounts.find((a) => a.id === activeAccountId)?.organizationUuid || null,
        orgOf: Object.fromEntries(accounts.map((a) => [a.id, a.organizationUuid])),
      }),
    });

    // Nothing eligible, or the winner is the account we are already on.
    if (choice.accountId === null || choice.accountId === activeAccountId) {
      // A pre-emptive "stay put" is silent — nothing happened worth a banner. A POST-HOC one
      // is not: the user is looking at a failed turn and is owed the reason plus, when we
      // know it, the time it comes back.
      if (choice.accountId === null || cause === 'limit_hit' || cause === 'limit_known') {
        // The notch says so too: the owner may be nowhere near this pane (notch-inbox.ts).
        if (choice.accountId === null) {
          recordAccountSwitch({
            fromAccountId: activeAccountId, toAccountId: null, exhausted: true,
            vault: isAssistant ? null : (opts.vault ?? basename(projectRoot)),
            sessionId: isAssistant ? null : registry?.sessionId ?? null,
            until: choice.earliestResetAt ?? null,
          });
        }
        sendMeta({
          subtype: 'account_switch',
          switched: false,
          reason: choice.accountId === null ? 'all_exhausted' : 'stayed_put',
          accountId: activeAccountId,
          rejected: choice.rejected,
          ...(choice.earliestResetAt === undefined ? {} : { earliestResetAt: choice.earliestResetAt }),
        });
      }
      return false;
    }

    // A DELIBERATE cross-account switch. Deliberately NOT `auth_changed`: that frame is the
    // single-HOME watcher's "the machine's account changed under us" signal, and this event
    // never touches `~/.claude.json`, so that fingerprint could not move even in principle.
    // The client restarts the conversation on the named account at the TURN BOUNDARY and
    // resubmits the held text.
    // When the window that forces this move reopens, for `forcedOffAccounts`: the latest reset
    // among the active account's windows at or past the threshold.
    const now = Date.now();
    const binding = (activeReading.limits?.limits ?? [])
      .filter((l) => l.resetsAt > now && (l.percent >= SWITCH_THRESHOLD_PERCENT || l.lockedReason))
      .map((l) => l.resetsAt);
    return announceMove(choice, cause, text, resubmit, previousResetAt, binding.length > 0 ? Math.max(...binding) : undefined);
  };

  /**
   * Announce a move to `choice.accountId`: hold the turn, tell the client where it goes, and let
   * the turn boundary perform it. Shared by the chooser's decision above and by coming home,
   * which needs no chooser round (its target is the account a new chat would open on).
   */
  const announceMove = (
    choice: Pick<ChooseResult, 'accountId' | 'sessionPercent' | 'weeklyPercent' | 'unmeasured' | 'rejected'>,
    cause: SwitchCause,
    text: string,
    resubmit: boolean,
    previousResetAt?: number,
    /** When the window forcing this move reopens, if known (see `forcedOffAccounts`). */
    forcedOffResetAt?: number,
  ): boolean => {
    const target = listClaudeAccounts().find((a) => a.id === choice.accountId);
    if (!target) return false;
    switchPending = true;
    recordAccountSwitch({
      fromAccountId: activeAccountId, toAccountId: target.id,
      vault: isAssistant ? null : (opts.vault ?? basename(projectRoot)),
      sessionId: isAssistant ? null : registry?.sessionId ?? null,
      until: previousResetAt ?? null,
    });
    heldTexts = resubmit && text ? [text] : [];
    // The refused message is resent after the restart: if it was spoken, it stays spoken (K1).
    if (isSuper && resubmit && text && lastSentSpoken && text === lastSentText) spokenTexts.add(text);
    // The system chose this account, so the reopened pane is still free to come home later.
    noteAutoPlaced(pinId, target.id);
    if (cause !== 'come_home' && activeAccountId) {
      // Until the window that forced it reopens; unknown (a sign-out, an unread window) → 30 min.
      const now = Date.now();
      const until = previousResetAt && previousResetAt > now ? previousResetAt : forcedOffResetAt ?? now + FORCED_OFF_DEFAULT_MS;
      noteForcedOff(pinId, { accountId: activeAccountId, at: now, until });
    }
    if (observedConversation) noteAutoPlaced(observedConversation, target.id);
    // `turnInFlight` and the held texts are added per send by `reannounceSwitch`:
    //
    // `turnInFlight` is whether a turn is REALLY running in the CLI right now. The client's
    // restart gate reads THIS, not its own optimistic `busy`: the message being held never
    // became a turn, so gating on `busy` would wait for a boundary that can never arrive. When
    // a genuinely in-flight turn IS running — a steer that landed mid-turn, a sub-agent's
    // refusal while the main turn continues — this is true and the client waits for it: that
    // turn was authorized by the old credentials and is allowed to finish on them. The frame
    // is said again with `false` the moment that turn ends, so the client never has to infer
    // the boundary from its own `busy` (which a background sub-agent's frames keep raising).
    pendingSwitchFrame = {
      subtype: 'account_switch',
      switched: true,
      reason: cause,
      accountId: choice.accountId,
      email: target.email,
      organizationName: target.organizationName,
      fromAccountId: activeAccountId,
      ...(choice.sessionPercent === undefined ? {} : { sessionPercent: choice.sessionPercent }),
      // Both windows, so the banner can never announce a fresh 5-hour window on an account
      // whose WEEK is nearly gone — the thing that made the 2026-09-10 switch look arbitrary.
      ...(choice.weeklyPercent === undefined ? {} : { weeklyPercent: choice.weeklyPercent }),
      ...(choice.unmeasured ? { unmeasured: true } : {}),
      ...(previousResetAt === undefined ? {} : { earliestResetAt: previousResetAt }),
      rejected: choice.rejected,
    };
    // The turns the client must resubmit after the restart (`pendingTexts`, oldest first;
    // `pendingText` is the first, for a client that predates the list), so none is lost.
    reannounceSwitch();
    return true;
  };

  /**
   * The POST-HOC path: the API already refused a turn.
   *
   * This exists because the pre-emptive path is a FORECAST and forecasts are wrong. Measured
   * 2026-09-05: the CLI refused a turn with "You've hit your session limit" while that same
   * account's `/usage` probe answered 6% three minutes later — so the threshold never armed,
   * the message landed as an error, and the user's "devam" walked into the identical wall.
   *
   * Two things happen here, and the FIRST matters more than the second: the refusal is
   * written down (`recordAccountRejection`), which is what stops every later turn — in this
   * pane and any other — from trusting the percentage that just lied. The switch is the
   * visible half; the memory is the half that makes it stay fixed.
   */
  const onLimitRejected = (signal: LimitSignal): void => {
    // Before any early return: a refusal anywhere in the turn holds its rotation (only while a
    // turn of ours is open — a background task's late refusal belongs to no turn).
    if (turnsInFlight > 0) limitHitThisTurn = true;
    if (switchPending) return;
    const recorded = recordAccountRejection(activeAccountId, signal);
    // A restart this pane could not perform: the refusal is on screen as the CLI wrote it, and
    // announcing another restart would only hold messages for it again.
    if (switchAbandoned) return;

    if (!autoSwitchEnabled()) {
      // OFF still REPORTS — and reporting a limit that has ALREADY landed is worth more than
      // reporting one that is merely near, because the user is looking at a failed turn.
      sendMeta({
        subtype: 'account_switch',
        switched: false,
        reason: 'auto_switch_disabled',
        accountId: activeAccountId,
        earliestResetAt: recorded.until,
      });
      return;
    }
    if (listClaudeAccounts().length < 2) return;   // nothing to switch to
    // A switch really happens from here on: the refused turn is not a stuck child (plan r4 D6).
    registry?.markLimited();

    // The turn that was refused may not be one WE sent: a background task finishing, or a
    // sub-agent, starts a turn inside the CLI with no user frame from us. Or it was ours but
    // had already worked for a while. Neither is replayed (`lastSentText` is cleared at every
    // turn end, and a request forty minutes in would start over); the restarted pane is told
    // to continue instead (`LIMIT_CONTINUE_TEXT`), so it does not sit idle under the refusal.
    // The Assistant keeps the old rule: its wakes are redelivered by their own owner, and a
    // resubmitted turn would clear a taint only the owner may clear.
    const text = isAssistant
      ? lastSentText
      : lastSentText && !turnProgressed ? lastSentText : LIMIT_CONTINUE_TEXT;

    // Onto the SAME serialisation chain as the pre-emptive path. A rejection frame and a
    // user frame arriving together must not both decide to switch: the gate is what makes
    // "one switch at a time" true across the two entry points rather than within each. The
    // refusal is often read twice (the synthetic reply AND its `result`), so the second one
    // finds the first's restart already owed and stands down.
    switchGate = switchGate.then(() => (switchPending
      ? false
      : decideAndAnnounce(text ?? '', 'limit_hit', { id: activeAccountId, problem: 'unknown' }, undefined, !!text)
        .catch(() => false)));
  };

  /**
   * The CLI says this account is SIGNED OUT (field 2026-10-21: sessions stalled on "/login" on
   * a lapsed account while a signed-in one sat idle). Unlike a usage limit this is no forecast
   * and nothing here can fix it, so the pane moves to a signed-in account whatever auto-switch
   * says, the same way a refused turn does; the record keeps new chats off it too.
   */
  const onAuthFailed = (): void => {
    authFailedTurn = true;
    if (activeAccountId) recordSignedOut(activeAccountId);
    if (switchPending || switchAbandoned) return;
    if (listClaudeAccounts().length < 2) return;   // nowhere to go: the banner says sign in
    const text = isAssistant
      ? lastSentText
      : lastSentText && !turnProgressed ? lastSentText : AUTH_CONTINUE_TEXT;
    switchGate = switchGate.then(() => (switchPending
      ? false
      : decideAndAnnounce(text ?? '', 'needs_relogin', { id: activeAccountId, problem: 'needs-relogin' }, undefined, !!text)
        .catch(() => false)));
  };

  /** True when the turn was HELD (a restart is coming); false when the caller should send it. */
  const maybeSwitchAccount = async (text: string, opts: { resubmit?: boolean } = {}): Promise<boolean> => {
    const resubmit = opts.resubmit ?? true;
    // One switch at a time per conversation. An owner message arriving while a restart is owed
    // JOINS it — held, re-announced, resubmitted after the restart in typing order — instead of
    // going out on the account being left, which is (on the post-hoc path) the account that just
    // refused. A wake message (`resubmit: false`) cannot ride the restart, so it keeps the old
    // rule and goes out now.
    if (switchPending) {
      if (!resubmit) return false;
      heldTexts.push(text);
      reannounceSwitch();
      return true;
    }
    if (switchAbandoned) return false;

    // The API's own refusal, remembered from an earlier turn (this pane or any other). It
    // OUTRANKS the percentages below, which is the point: the account that produced the
    // 2026-09-05 failure reported 6% minutes after being refused, so a threshold check alone
    // would clear it to serve again immediately.
    const standingRefusal = readAccountRejections()[activeAccountId];

    if (!autoSwitchEnabled()) {
      // OFF means REPORT, never change: the user is told the window is nearly gone and the
      // turn goes out unchanged.
      const reading = readUsageLimits(accountConfigDir);
      if (standingRefusal || shouldSwitchAway(reading)) {
        sendMeta({
          subtype: 'account_switch',
          switched: false,
          reason: 'auto_switch_disabled',
          accountId: activeAccountId,
          limits: reading.limits,
          ...(standingRefusal ? { earliestResetAt: standingRefusal.until } : {}),
        });
      }
      return false;
    }

    const accounts = listClaudeAccounts();
    // Nothing to switch TO. A single-account machine takes this branch and does no work.
    if (accounts.length < 2) return false;

    // A standing refusal skips the probe entirely — we already know this account will not
    // serve, and spending 1.2s re-asking a cache that lied is worse than useless.
    // `limit_known`, not `limit_hit`: THIS turn has not failed — an earlier one did, and we
    // are moving before trying. Telling the user their message hit a limit when it did not is
    // the same class of untruth as switching the billed account silently.
    if (standingRefusal) {
      return decideAndAnnounce(
        text, 'limit_known', { id: activeAccountId, problem: 'unknown' }, standingRefusal.until, resubmit);
    }

    // ── `sequential` stops here ───────────────────────────────────────────────────────
    // Everything below this line is the FORECAST: probe the active account, compare it to a
    // threshold, and move before the wall. That is precisely what draining in order refuses
    // to do — the top account is meant to serve until the API itself says no. Bailing here
    // also skips the probe subprocess entirely, so the mode costs nothing per message.
    //
    // The two paths that DO still move a sequential session are both above or elsewhere: the
    // standing refusal just handled, and the post-hoc `onLimitRejected` that records a
    // refusal the moment the API states one.
    //
    // KNOWN, AND THE SAME GAP BOTH MODES HAVE: a session already moved down the list does not
    // jump back the instant the top account's window reopens — nothing re-evaluates until the
    // account it is on is itself refused, and then the chooser picks the top eligible one, so
    // it walks back rather than snapping back. Closing that is the `auto-switch brings the
    // session home` task, which is where it belongs for BOTH strategies.
    // ── Coming home, where it is cheap ──────────────────────────────────────────────
    // Both modes, before either one's forecast: a pane that was moved down the list goes back
    // up when the account above it can serve again AND the conversation is still small enough
    // that the move costs little (`comeHomeTarget`). A long conversation is not moved for this;
    // its next cheap point is a handoff or a new session. Never while a turn is running: this
    // message would be a steer, and a move nothing forces must not hold it back from that turn
    // and replay it on another account after a restart.
    if (resubmit && turnsInFlight === 0) {
      const home = comeHomeTarget();
      if (home) {
        const target = accounts.find((a) => a.id === home);
        let reading: UsageLimitsResponse = { limits: [], fetchedAtMs: null };
        try { if (target) reading = readUsageLimits(accountDecisionDir(target)); } catch { /* no numbers, still a move */ }
        // Only a window still open is reported; a rolled-over one says nothing about the new one.
        const pct = (key: 'session' | 'weekly') => reading.limits.find((l) => l.key === key && l.resetsAt > Date.now())?.percent;
        const sessionPercent = pct('session');
        const weeklyPercent = pct('weekly');
        return announceMove({
          accountId: home,
          ...(sessionPercent === undefined ? {} : { sessionPercent }),
          ...(weeklyPercent === undefined ? {} : { weeklyPercent }),
          rejected: [],
        }, 'come_home', text, resubmit);
      }
    }

    if (switchStrategyFor() === 'sequential') return false;

    // A reading we cannot TRUST is not a reason to skip the check — it is the reason to make
    // it. `shouldProbe` can only answer from percentages, so an account whose cache is absent
    // or past the ceiling Claude Code itself applies (`USAGE_CACHE_MAX_AGE_MS`) took the
    // silent "nothing to see here" path and auto-switch never armed at all — the account most
    // likely to be in that state is a quiet one nobody has read for hours. The probe is free;
    // the cooldown is what stops a pane that keeps reading nothing from paying ~4s a message.
    let active = readUsageLimits(accountConfigDir);
    const blind = !usageReadingIsCurrent(active)
      && Date.now() - lastBlindProbeAt > BLIND_PROBE_COOLDOWN_MS;
    if (!blind && !shouldProbe(active)) return false;
    if (blind) lastBlindProbeAt = Date.now();

    // Past the probe threshold: refresh the ACTIVE account for real before acting on a
    // possibly stale cache.
    const activeProbe = await readAccountForDecision(accountConfigDir);
    if (!alive) return true;                       // the session went away mid-probe
    if (activeProbe.status === 'ok') active = activeProbe.limits;
    if (activeProbe.status !== 'needs-relogin' && !shouldSwitchAway(active)) return false;

    return decideAndAnnounce(
      text,
      activeProbe.status === 'needs-relogin' ? 'needs_relogin' : 'limit_near',
      activeProbe.status === 'ok'
        ? { id: activeAccountId, limits: activeProbe.limits }
        : { id: activeAccountId, problem: activeProbe.status },
      undefined,
      resubmit,
    );
  };

  // A wake message about a delegated session reaches the Assistant's CLI down the SAME chain
  // as an owner message — serialised behind it, account switch evaluated first. It carries
  // another session's text, so it taints and NEVER clears the taint (only the owner does).
  // Its text must never reach the client as `pendingText` — the client resubmits that as the
  // OWNER's turn, which would launder the taint. So a HELD wake is announced without it
  // (`resubmit: false`) and resolves false for delegations.ts to redeliver after the restart,
  // and a sent wake CLEARS `lastSentText`: a refusal of the wake turn then has nothing to
  // resubmit, rather than replaying the previous owner message in its place.
  if (isAssistant) {
    detachInbox = attachAssistantInbox({
      id: randomUUID(),
      deliver: (text) => new Promise<boolean>((resolve) => {
        // A pending autonomy respawn: redelivered to the successor, never to this process.
        if (!alive || respawnTo !== null || handedOff) return resolve(false);
        switchGate = switchGate.then(() => maybeSwitchAccount(text, { resubmit: false })
          .catch(() => false)
          .then((held) => {
            if (!alive || held) return resolve(false);
            openTurn();
            lastSentText = null;
            markTainted();
            writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
            resolve(true);
          }));
      }),
    });
  }

  // The Super Agent's inbox (lib/super/inbox.ts): ONE injected `[super events]` turn at a time,
  // down the same chain as an owner message (account switch evaluated first), only while
  // nothing else runs. The pump decides WHEN (D7); this only writes, and says so with a
  // `super_event` frame first (the batch and its items) so the window draws the turn as one line.
  if (isSuper && pinId) {
    detachInbox = attachSuperInbox({
      id: randomUUID(),
      sessionId: chatRegistryId,
      attached: () => alive && !detached && ws.readyState === ws.OPEN,
      idle: () => turnsInFlight === 0 && !superEventTurnOpen && !stdinEnding(),
      deliver: (text, event, cancelled) => new Promise<boolean>((resolve) => {
        // `cancelled`: the inbox gave up waiting (a slow account switch); the items are still
        // pending there, so this turn must never be written late.
        const blocked = () => !alive || detached || superEventTurnOpen || turnsInFlight > 0 || stdinEnding() || !!cancelled?.();
        if (blocked()) return resolve(false);
        switchGate = switchGate.then(() => maybeSwitchAccount(text, { resubmit: false })
          .catch(() => false)
          .then((held) => {
            // An owner message that went first in the chain wins: this event waits for idle.
            if (held || blocked()) return resolve(false);
            sendMeta({ subtype: SUPER_FRAME_EVENT, ...event });
            openTurn();
            lastSentText = null;
            superEventTurnOpen = true;
            registry?.userSent('');
            const wrote = writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
            if (!wrote) superEventTurnOpen = false;
            // The owner's "New session" turn is out: its result rotates the pane even when the
            // super writes no handoff (handoff-rotation.ts). Only after a write that landed.
            else if (event.kind === 'fresh' && event.batch) markFreshDelivered(chatRegistryId, event.batch);
            resolve(wrote);
          }));
      }),
    });
  }


  // ── Autonomy changed under a live Assistant → respawn in place with --resume ─────────
  //
  // Permission mode and `--allowedTools` are argv, so the only way a running Assistant stops
  // pre-approving its verbs after a switch to `ask` is a new process. The socket, the notch's
  // surface and the conversation all survive: this process's socket listeners are detached,
  // it is drained (stdin EOF, killed after the grace), and a successor is started on the SAME
  // socket resuming the same conversation. Frames the notch sends in between are held and
  // replayed to the successor, so nothing typed is lost and nothing reaches the old process.
  if (isAssistant && assistantConfig) {
    const spawnedAutonomy = assistantConfig.autonomy;
    const listener = (autonomy: Autonomy): void => {
      if (!alive || handedOff) return;
      const wasPending = respawnTo !== null;
      respawnTo = autonomy === spawnedAutonomy ? null : autonomy;
      if (respawnTo !== null) { scheduleRespawn(); return; }
      // Switched back before the turn ended: no respawn is coming, so the messages held for a
      // successor go to THIS process, in arrival order.
      if (wasPending) for (const raw of heldForSuccessor.splice(0)) onWsMessage(raw);
    };
    assistantAutonomyListeners.add(listener);
    unlistenAutonomy = () => { assistantAutonomyListeners.delete(listener); };
  }

  let successorStarted = false;
  let closedDuringHandoff = false;
  const holdFrame = (raw: Buffer | string): void => { heldForSuccessor.push(raw); };
  const holdClose = (): void => { closedDuringHandoff = true; };

  /** Respawn once every message already queued on `switchGate` has been decided: a message
   *  still inside `maybeSwitchAccount` is not yet counted in `turnsInFlight`, and ending stdin
   *  under it would lose it. (Once `respawnTo` is set, the gate's tail holds, never writes.) */
  function scheduleRespawn(): void {
    const gate = switchGate;
    void gate.then(() => {
      // The gate grew while we waited: wait for its new tail too.
      if (gate !== switchGate) { scheduleRespawn(); return; }
      // Both the listener and the turn boundary may schedule; respawnInPlace's `handedOff`
      // guard makes the second a no-op, so it fires exactly once.
      if (turnsInFlight === 0) respawnInPlace();
    });
  }

  /** Hold one owner frame for the successor — or, if the successor already took over the
   *  socket, hand it straight to the successor's handler. */
  function holdForSuccessor(raw: Buffer | string): void {
    if (successorStarted) ws.emit('message', raw);
    else heldForSuccessor.push(raw);
  }

  function respawnInPlace(): void {
    if (!alive || handedOff || respawnTo === null) return;
    // The socket already went (draining): the next summon spawns under the new autonomy anyway.
    if (lingerTimer || lingerKillTimer || ws.readyState !== ws.OPEN) return;
    handedOff = true;
    mirrors?.closeAll(MIRROR_CLOSE_ENDED, 'super restarting');
    if (switchStallTimer) { clearTimeout(switchStallTimer); switchStallTimer = null; }
    ws.off('message', onSocketFrame);
    ws.off('close', onSocketGone);
    ws.off('error', onSocketGone);
    ws.on('message', holdFrame);
    ws.on('close', holdClose);
    ws.on('error', holdClose);
    // An idle stream-json child exits on its own at stdin EOF; the kill is the backstop.
    try { child.stdin.end(); } catch { /* already torn down */ }
    lingerKillTimer = setTimeout(() => {
      lingerKillTimer = null;
      if (!alive) return;
      try { reapChild(child); } catch { /* already gone */ }
    }, CLOSE_KILL_GRACE_MS);
  }

  function spawnSuccessor(): void {
    if (successorStarted) return;
    successorStarted = true;
    ws.off('message', holdFrame);
    ws.off('close', holdClose);
    ws.off('error', holdClose);
    const conversation = pinId || observedConversation;
    startChatSession(ws, projectRoot, {
      ...opts,
      sessionId: conversation ? '' : opts.sessionId,
      resumeId: conversation,
      initialPrompt: '',
      deferPrompt: false,
      inheritedSurfaceDispose: disposeSurface,
    });
    // Replayed through the successor's own handler, in arrival order.
    for (const raw of heldForSuccessor.splice(0)) ws.emit('message', raw);
    if (closedDuringHandoff) ws.emit('close');
  }

  // ── ws → claude stdin (client control frames) ──────────────────────────────────────
  /** A frame from the HOLDER's socket. The owner's words typed there are shown on the Super
   *  Agent's phone mirrors before the chat takes them; re-entries (`onWsMessage` on a held
   *  frame) never echo twice. */
  function onSocketFrame(raw: Buffer | string): void {
    if (mirrors?.size && alive) {
      const text = mirrorOwnerText(raw);
      if (text !== null) mirrors.echo(text, ws);
    }
    onWsMessage(raw);
  }

  function onWsMessage(raw: Buffer | string): void {
    if (!alive) return;
    // Defence in depth (AC3): a frame from a device that is no longer signed in acts on nothing.
    if (ownerDevice && !deviceStillValid(ownerDevice)) { revokeForDevice(); return; }
    const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
    let msg: {
      type?: string; text?: string; requestId?: string; behavior?: string; updatedInput?: unknown;
      message?: string; model?: string; effort?: string; targetUuid?: string; mode?: string;
      taskId?: string; enabled?: boolean; visible?: boolean; voice?: boolean; voiceTake?: unknown;
    };
    try { msg = JSON.parse(str); } catch { return; } // malformed control frame — ignore

    // The client is closing this pane on purpose (a closed tab, a respawn): the socket's close
    // that follows ends the child as it always did, instead of detaching it for a reattach.
    if (msg.type === 'end') { endOnSocketGone = true; return; }

    // The phone says whether this chat is on its screen (D2): a push for it skips that device
    // while it is. Only a phone socket's word counts; the laptop sends none.
    if (msg.type === 'visibility') { socketVisible.set(ws, msg.visible === true); return; }

    if (msg.type === 'user' && typeof msg.text === 'string' && msg.text) {
      // An autonomy respawn is waiting for the running turn to end: the owner's next message
      // is for the successor — it must not run under the old permissions. (Only user frames:
      // an answer or an interrupt belongs to the turn in flight.)
      if (respawnTo !== null) { holdForSuccessor(raw); return; }
      // The Super Agent's owner message is never held behind an event turn: it is written at
      // once and folded into whatever turn runs (plan r4 D4), as Enter does in every chat.
      // A spoken message (the frame's `voice`) stays spoken through the account-switch gate.
      if (isSuper && msg.voice === true) spokenTexts.add(msg.text);
      // A dictated message sent unchanged names its take. Bound HERE, synchronously, before
      // anything awaits: the shape, the take's existence, this chat's vault, unbound, under
      // 10 minutes — anything else and the ref is dropped and the message goes as plain text.
      if (msg.voiceTake !== undefined && contextRoot) {
        const take = bindTake(msg.voiceTake, chatRegistryId, contextRoot, undefined, undefined, msg.text);
        if (take) voiceTakes.set(msg.text, take);
      }
      // Auto-switch evaluates BEFORE the turn goes to the CLI — the whole point is that the
      // message does not have to fail first. `maybeSwitchAccount` either sends the turn on
      // this account (the overwhelmingly common answer, and the answer whenever anything is
      // uncertain) or holds it and asks the client to restart on another account.
      const text = msg.text;
      // The OWNER spoke on the Assistant's socket: whatever project text it read before is
      // now behind a human turn, so the taint clears (autonomy.ts).
      if (isAssistant) clearTaint();
      // Appended to the chain, never fired concurrently — see `switchGate`.
      // A phone's words with no window attached WHEN THE GATE REACHES THEM: nobody could perform
      // an account switch's restart, so a held text would die with the idle reap. They go out on
      // this account instead (decided when the gate reaches them, not when they arrived).
      const fromMirror = typeof raw !== 'string' && mirrorFrames.has(raw);
      switchGate = switchGate.then(() => (fromMirror && detached ? Promise.resolve(false) : maybeSwitchAccount(text))
        // A THROW HERE MUST NOT EAT THE TURN. Without this the guarantee "the message is
        // never swallowed" would hold for every decision the chooser can make and fail for
        // the one case nobody planned: an unexpected error on the way to making it.
        .catch(() => false)
        .then((held) => {
          if (!alive || held) return;
          // Autonomy changed while this message waited in the gate: it belongs to the successor.
          if (respawnTo !== null || handedOff) { holdForSuccessor(raw); return; }
          writeOwnerTurn(text);
        }));
      return;
    }

    // Live model switch → `set_model` control_request (empirically verified on 2.1.218:
    // accepts aliases and full ids, acks with control_response, re-emits system:init with
    // the new model). The CLIENT generates the request id so it can match the ack; it is
    // whitelist-checked here before echoing into the CLI frame.
    if (msg.type === 'setModel' && typeof msg.model === 'string') {
      const model = sanitizeModel(msg.model);
      const requestId = sanitizeControlId(msg.requestId) || randomUUID();
      if (model) {
        writeStdin({ type: 'control_request', request_id: requestId, request: { subtype: 'set_model', model } });
      }
      return;
    }

    // Live permission-mode switch → `set_permission_mode` control_request, so Auto↔Bypass can
    // take effect on the RUNNING conversation instead of only on the next spawn. The two
    // directions are NOT symmetric on 2.1.220, both measured through this route:
    //   • →`auto` LANDS: acks `{subtype:'success', response:{mode:'auto'}}` and the next turn's
    //     `system:init` reports `permissionMode: auto`.
    //   • →`bypassPermissions` is REFUSED: `{subtype:'error', error:"Cannot set permission mode
    //     to bypassPermissions because the session was not launched with
    //     --dangerously-skip-permissions"}` — a process that booted without that flag can never
    //     be talked into bypass, whatever it was launched with.
    // So the client's rejection fallback (respawn this conversation with `--resume` under the
    // new mode) is LOAD-BEARING for every switch INTO bypass, not just a courtesy for an older
    // CLI. Verified end to end: the respawned `--resume` session boots on `bypassPermissions`.
    // The Assistant's permission mode is its AUTONOMY setting — a pane switch must not move it.
    // An agent's mode is its autonomy level, so a pane switch must not move it either.
    if (msg.type === 'setPermissionMode' && !isAssistant && !scopedCard && !agentChat?.levelArgs && (msg.mode === 'auto' || msg.mode === 'bypass')) {
      const requestId = sanitizeControlId(msg.requestId) || randomUUID();
      writeStdin({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'set_permission_mode', mode: permissionModeFor(msg.mode === 'bypass') },
      });
      return;
    }

    // Live effort switch → a `/effort <level>` user frame (no effort control_request exists
    // on 2.1.218; the slash command is handled locally by the CLI, which replies with a
    // synthetic "Set effort level to <level>" assistant frame — also empirically verified).
    if (msg.type === 'setEffort' && typeof msg.effort === 'string') {
      const effort = sanitizeEffort(msg.effort);
      if (effort) {
        // Delivered as a USER frame (there is no effort control request on 2.1.218), so it
        // starts a turn — the CLI answers with a synthetic assistant bubble and a `result`.
        // It must set the flag for the same reason the initial prompt does.
        openTurn();
        writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `/effort ${effort}` }] } });
      }
      return;
    }

    // Per-PANE context-handoff toggle. TWO writes, and the split is the whole design:
    //   • the PANE's tab file is what the hooks read, so this pane changes immediately
    //     and a sibling pane in the same vault is untouched;
    //   • brain-local records the vault's default on THIS machine, so the NEXT new pane
    //     opens the way the person last left it.
    // Never an app-global setting: `agent-ui.json` is one machine-wide file, so a default
    // there would switch the nudge on in every vault on the machine and silently override
    // a team that opted out in `.config.json`.
    //
    // The echo carries what was actually WRITTEN, never what was clicked — if the tab file
    // could not be written, the switch must snap back rather than lie. It is also
    // RE-RESOLVED rather than echoed straight back from the tab file: the switch lives in
    // the tab file but the ladder lives in `.config.json`, and `writeTabHandoff` only ever
    // sees the switch. Echoing its return value would have shown a vault that tuned
    // `--nudge-at` the SHIPPED thresholds while the hook nudged on the tuned ones — the
    // lamp and the behaviour disagreeing is the exact bug this pass exists to remove.
    if (msg.type === 'setContextHandoff' && typeof msg.enabled === 'boolean') {
      if (!pinId) return; // an unpinned pane has no tab file to own a toggle
      try {
        const written = writeTabHandoff(contextRoot, pinId, { enabled: msg.enabled });
        if (written) {
          writeBrainLocal(projectRoot, { contextHandoffDefault: msg.enabled });
          const echo = resolveHandoffFor(contextRoot, projectRoot, pinId);
          sendMeta({ subtype: 'context_handoff', state: { enabled: echo.enabled, nudgeAt: echo.nudgeAt, hardAt: echo.hardAt, remindEvery: echo.remindEvery } });
        }
      } catch { /* a failed toggle simply does not echo — the client keeps server truth */ }
      return;
    }

    // Conversation rewind → `rewind_conversation` control_request (verified on 2.1.218:
    // acks {rewound, prefillText, precedingAssistantUuid}; conversation-only — file state
    // is NOT restored). `interrupt_if_running` lets a rewind land mid-turn.
    if (msg.type === 'rewind' && typeof msg.targetUuid === 'string') {
      const target = sanitizeUuid(msg.targetUuid);
      const requestId = sanitizeControlId(msg.requestId) || randomUUID();
      if (target) {
        writeStdin({
          type: 'control_request',
          request_id: requestId,
          request: { subtype: 'rewind_conversation', target_message_uuid: target, interrupt_if_running: true },
        });
      }
      return;
    }

    // Stop a background shell → `stop_task` control_request. Costs ZERO model tokens: the
    // CLI kills the child itself and reports it on the `system:background_tasks_changed` /
    // `task_updated{status:'killed'}` / `task_notification{status:'stopped'}` frames the
    // client already reduces (all empirically verified on 2.1.220).
    //
    // Deliberately fire-and-forget: the CLI answers `{subtype:'success', response:{}}` even
    // for a task_id that never existed, so echoing an ack back would be reporting a success
    // we did not verify. The frames above are the only honest confirmation, so we forward
    // the request and let the roster speak.
    if (msg.type === 'stopTask' && typeof msg.taskId === 'string') {
      const taskId = sanitizeBackgroundTaskId(msg.taskId);
      if (taskId) {
        writeStdin({
          type: 'control_request',
          request_id: randomUUID(),
          request: { subtype: 'stop_task', task_id: taskId },
        });
      }
      return;
    }

    if (msg.type === 'answer' && typeof msg.requestId === 'string' && msg.requestId && msg.requestId.length <= 200
      && (msg.behavior === 'allow' || msg.behavior === 'deny')) {
      const response = msg.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: msg.updatedInput ?? {} }
        : { behavior: 'deny', message: typeof msg.message === 'string' && msg.message ? msg.message : 'Denied' };
      writeStdin({
        type: 'control_response',
        response: { subtype: 'success', request_id: msg.requestId, response },
      });
      outstandingAsks.delete(msg.requestId);
      registry?.answered(msg.requestId);
      return;
    }

    // ── The dreamcontext Assistant's notch ─────────────────────────────────────────
    // The notch declares itself a SURFACE (it can execute UI verbs), and answers the commands
    // the relay sent down this socket. Only on the Assistant's own session; ignored elsewhere.
    if (isAssistant && msg.type === 'assistant_surface') {
      disposeSurface();
      const surfaceId = randomUUID();
      const dispose = setAssistantSurface({
        id: surfaceId,
        send: (frame) => {
          if (ws.readyState !== ws.OPEN) return false;
          try { ws.send(JSON.stringify({ type: '_meta', ...frame })); return true; } catch { return false; }
        },
      });
      disposeSurface = () => { disposeSurface = () => { /* once */ }; dispose(); failAllCommands(); };
      return;
    }
    if (isAssistant && msg.type === 'assistant_command_result') {
      const r = msg as unknown as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
      if (typeof r.id === 'string') {
        deliverResult(r.id, r.ok === true ? { ok: true, result: r.result ?? null } : { ok: false, error: typeof r.error === 'string' ? r.error.slice(0, 300) : 'failed' });
      }
      return;
    }

    // The window looked at / typed in this tab (at most once per 30 s): it is the owner's.
    if (msg.type === 'focus') { focusedAt = Date.now(); return; }
    // The owner took queued rows back (deleted, edited, held): a super child's outbox copy goes
    // too, so a relaunch cannot bring them back (lib/super/outbox.ts).
    if (msg.type === 'queue_dropped') {
      const texts = Array.isArray((msg as { texts?: unknown }).texts)
        ? ((msg as { texts: unknown[] }).texts).filter((t): t is string => typeof t === 'string').slice(0, 50)
        : [];
      const root = pinId ? superRootOfChild(pinId) : null;
      if (root && texts.length) void dropFromOutbox(root, pinId, texts).catch((err) => console.warn(`[super outbox] drop failed: ${(err as Error).message}`));
      return;
    }
    if (msg.type === 'park_result') { onParkResult(msg as unknown as { id?: unknown; ok?: unknown; error?: unknown }); return; }

    if (windowControl && msg.type === 'window_command_result') {
      const r = msg as unknown as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
      deliverWindowResult(windowControl.token, r.id, r.ok === true
        ? { ok: true, result: r.result ?? null }
        : { ok: false, error: typeof r.error === 'string' ? r.error.slice(0, 300) : 'failed' });
      return;
    }
    // A Super Agent verb the window ran (`delegate`, `answer`): settles only a `super_command`
    // this same chat's token sent (lib/window-control.ts).
    if (windowControl && msg.type === 'super_command_result') {
      const r = msg as unknown as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
      deliverSuperResult(windowControl.token, r.id, r.ok === true
        ? { ok: true, result: r.result ?? null }
        : { ok: false, error: typeof r.error === 'string' ? r.error.slice(0, 300) : 'failed' });
      return;
    }

    if (msg.type === 'interrupt') {
      // Stop holds the window's queue: what the outbox kept for this child is held with it.
      const stopRoot = pinId ? superRootOfChild(pinId) : null;
      if (stopRoot) void dropFromOutbox(stopRoot, pinId).catch((err) => console.warn(`[super outbox] drop failed: ${(err as Error).message}`));
      // Empirically verified against claude 2.1.218 (scratch-dir experiment): a
      // control_request{subtype:'interrupt'} on stdin aborts the in-flight turn — the CLI
      // echoes a control_response, emits a synthetic rejected tool_result + "[Request
      // interrupted by user for tool use]", then a `result` frame with
      // terminal_reason:"aborted_tools", all within ~4.1s API duration. `system:init`
      // advertises this as the `interrupt_receipt_v1` capability.
      interruptRequestId = randomUUID();
      writeStdin({ type: 'control_request', request_id: interruptRequestId, request: { subtype: 'interrupt' } });
      registry?.interrupted();
      clearInterruptTimers();
      interruptWatchdog = setTimeout(() => {
        interruptWatchdog = null;
        if (!alive) return;
        try { child.kill('SIGINT'); } catch { /* already gone */ }
        interruptKillTimer = setTimeout(() => {
          interruptKillTimer = null;
          if (!alive) return;
          try { reapChild(child); } catch { /* already gone */ }
        }, INTERRUPT_KILL_GRACE_MS);
      }, INTERRUPT_WATCHDOG_MS);
      return;
    }
    // Unrecognized frame shape — ignore rather than throw (a forward-compat client field
    // must never crash an established session).
  }

  bindSocket();
  opts.onAccepted?.();
}

// ─── Transcript history (GET /api/agent/chat-history) ─────────────────────────────────
//
// `claude --resume` never re-emits past frames over stream-json, so a RESUMED chat session
// would open onto a blank transcript. This route replays the on-disk transcript
// (`~/.claude/projects/<slug>/<uuid>.jsonl`) as a flat item list the chat UI can seed its
// history from — and, because each user entry carries its transcript `uuid`, it doubles as
// the rewind-anchor source (rewind_conversation targets a user message's uuid).

// The parser and its item vocabulary moved to `lib/transcript-history.ts` when a
// third caller appeared (the automations run drill-in, which must work from the
// CLI too and so cannot import a server route). Re-exported here so every
// existing importer — including this file's own handlers and
// `tests/unit/agent-chat-history.test.ts` — keeps its import path.
import { parseTranscriptHistory } from '../../lib/transcript-history.js';
import { liveTranscriptPath } from '../../lib/transcript-locate.js';

export {
  parseTranscriptHistory,
  truncateValue,
  HISTORY_MAX_ITEMS,
  HISTORY_MAX_VALUE_CHARS,
  type ChatHistoryItem,
} from '../../lib/transcript-history.js';

/** Strict sub-agent task-id gate for chat-history's `subagent` query param — same
 *  whitelist-before-filesystem precedent as `sanitizeControlId` above and
 *  agent-spawn-shared.ts's sanitizeUuid/sanitizeModel family. A `task_id` observed on
 *  CLI 2.1.218 is a short hex/hyphen token; anything outside `[a-z0-9-]` (or oversized)
 *  is rejected to '' before it ever reaches a path — `handleAgentChatHistory` additionally
 *  runs the derived path through `safeChildPath` as a second, independent containment
 *  layer (see `[[dashboard-server-security]]`'s defense-in-depth guidance). */
export function sanitizeSubagentId(v: string | null): string {
  return v && v.length <= 128 && /^[a-z0-9-]+$/i.test(v) ? v : '';
}

/** GET /api/agent/chat-history?claudeId=<uuid>[&subagent=<taskId>] — the replayable
 *  transcript of a chat session's conversation (empty when no transcript exists yet,
 *  exactly like a fresh session). Live-id resolution mirrors agent-terminal.ts's
 *  liveTranscriptPath: prefer the tab-session map's CURRENT conversation, fall back to
 *  the pinned id.
 *
 *  With `subagent` present, replays a SUB-AGENT's own sidechain transcript instead of the
 *  parent conversation's — state 9's drill-in. Claude Code writes each dispatched sub-agent's
 *  turns to `~/.claude/projects/<slug>/<conversationUuid>/subagents/agent-<taskId>.jsonl`
 *  (empirically verified, CLI 2.1.218: `task_notification`'s `output_file` is a symlink to
 *  exactly this path). The path is DERIVED here from the already-resolved parent transcript's
 *  own filename (`<conversationUuid>` = its basename) plus the sanitized `taskId` — the client
 *  never supplies a path, and `output_file` itself is never read or trusted. This is a
 *  read-only extension of the SAME transcript channel the base route already uses; it does
 *  NOT widen `/api/agent/file` (which stays project-root-scoped and cannot reach a path under
 *  `~/.claude/projects/`, outside the project root, at all). Same tail/truncation discipline
 *  (`parseTranscriptHistory`, reused verbatim) and the same empty-array degrade on a transcript
 *  that hasn't flushed yet — the client falls back to a static run summary in that case. */
export async function handleAgentChatHistory(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!isAgentHost()) { sendJson(res, 200, { items: [] }); return; }
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const id = sanitizeUuid(url.searchParams.get('claudeId'));
  if (!id) { sendJson(res, 200, { items: [] }); return; }
  const liveId = contextRoot ? resolveAgentSession(contextRoot, id) : '';
  const path = findFirstTranscriptPath([liveId, id]);
  if (!path) { sendJson(res, 200, { items: [] }); return; }
  // AC16: a phone reads only the chosen projects' conversations (a sub-agent's by its parent's).
  if (phoneTranscriptRefused(req, contextRoot, path)) { sendError(res, 403, 'phone_unavailable', 'Hands-free does not serve that conversation.'); return; }

  const subagent = sanitizeSubagentId(url.searchParams.get('subagent'));
  if (subagent) {
    const subagentsDir = join(dirname(path), basename(path, '.jsonl'), 'subagents');
    const subPath = safeChildPath(subagentsDir, `agent-${subagent}.jsonl`);
    if (!subPath || !existsSync(subPath)) { sendJson(res, 200, { items: [] }); return; }
    let subRaw = '';
    try { subRaw = await readTranscript(subPath); } catch { sendJson(res, 200, { items: [] }); return; }
    // `sidechain: true` — this file IS the sub-agent's own transcript, so its universal
    // `isSidechain` marker is what we came for, not a foreign turn to filter out.
    sendJson(res, 200, { items: parseTranscriptHistory(subRaw, { sidechain: true }) });
    return;
  }

  let raw = '';
  try { raw = await readTranscript(path); } catch { sendJson(res, 200, { items: [] }); return; }
  sendJson(res, 200, { items: parseTranscriptHistory(raw) });
}

/** A transcript's text. */
async function readTranscript(path: string): Promise<string> {
  return readFileSync(path, 'utf-8');
}

// ─── Background-shell output reader (GET /api/agent/bg-output) ──────────────────────
//
// A `run_in_background` Bash streams its output to a live file on disk (see
// `backgroundOutputPath`), which is what lets the Chat view show a background shell's
// output for ZERO model tokens — no `TaskOutput`/`BashOutput` round-trip through the model,
// and readable while the session is mid-turn or idle alike.
//
// Not served by `handleAgentFile`: that route is project-root-scoped by design and must not
// be widened, and this file lives under `/tmp/claude-<uid>/…`. Same posture as the
// sub-agent sidechain transcript — its own route with a fully server-DERIVED path.

/** Tail cap for a background-shell output read, in bytes. A long-running dev server or
 *  build can write megabytes; the tail is what anyone actually reads, and it bounds both the
 *  response and the poll's per-tick cost. */
const BG_OUTPUT_TAIL_BYTES = 256 * 1024;

/**
 * `GET /api/agent/bg-output?claudeId=<uuid>&taskId=<id>` → the tail of a background shell's
 * live output. Desktop-gated. Answers `200` with `running:false`-shaped emptiness rather
 * than a 404 when the file does not exist yet: a shell that has produced no output is a
 * normal state the UI shows as "no output yet", not an error to render.
 */
export async function handleAgentBackgroundOutput(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!isAgentHost()) { sendError(res, 403, 'desktop_only', 'Available only in the desktop app.'); return; }
  if (!contextRoot) { sendError(res, 400, 'no_vault', 'No vault resolved for this request.'); return; }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const taskId = sanitizeBackgroundTaskId(url.searchParams.get('taskId'));
  if (!taskId) { sendError(res, 400, 'invalid_task_id', 'Query parameter "taskId" is required.'); return; }
  const claudeId = sanitizeUuid(url.searchParams.get('claudeId'));
  if (!claudeId) { sendError(res, 400, 'invalid_claude_id', 'Query parameter "claudeId" is required.'); return; }

  sendJson(res, 200, computeBackgroundOutput(contextRoot, taskId, claudeId));
}

/** The tail of one background shell's output. */
export function computeBackgroundOutput(contextRoot: string, taskId: string, claudeId: string): Record<string, unknown> {
  // The output directory is keyed by the LIVE conversation uuid, which is what the CLI was
  // spawned with — the roster id the client holds may be a stale pin, so resolve it the same
  // way the history route does before deriving the path.
  // A resumed conversation keeps writing under the uuid its CLI process was spawned with,
  // which may be either the live id or the roster pin — try both before reporting nothing.
  const liveId = resolveAgentSession(contextRoot, claudeId) || claudeId;
  const cwd = projectRootOf(contextRoot);
  const found = [...new Set([liveId, claudeId])]
    .map((id) => backgroundOutputPath(cwd, id, taskId))
    .find((p): p is string => !!p && existsSync(p));
  if (!found) { return { taskId, content: '', size: 0, truncated: false, exists: false }; }

  let st: ReturnType<typeof statSync>;
  try { st = statSync(found); } catch { return { taskId, content: '', size: 0, truncated: false, exists: false }; }

  const start = Math.max(0, st.size - BG_OUTPUT_TAIL_BYTES);
  let content = '';
  try {
    if (start === 0) {
      content = readFileSync(found, 'utf-8');
    } else {
      // Tail-read only the last window — never load a multi-megabyte log to slice it.
      const fd = openSync(found, 'r');
      try {
        const buf = Buffer.alloc(st.size - start);
        readSync(fd, buf, 0, buf.length, start);
        content = buf.toString('utf-8');
      } finally { closeSync(fd); }
    }
  } catch {
    return { taskId, content: '', size: st.size, truncated: false, exists: true };
  }

  return { taskId, content, size: st.size, truncated: start > 0, exists: true };
}

// ─── Project-root file reader (GET /api/agent/file) ────────────────────────────────
//
// State 3's slide-over / state 4's lightbox need to read arbitrary PROJECT files (not just
// `_dream_context/`, which `GET /api/graph/content` already covers) — e.g. a `src/*.ts` path
// referenced by a Read/Edit tool card. This route is intentionally scoped to the project root
// ONLY and is never widened: a sub-agent's sidechain transcript lives under
// `~/.claude/projects/...`, well outside the project root, and is served instead by the
// `subagent` param on `handleAgentChatHistory` above (a derived path through the existing
// transcript channel, never a client-supplied one) — see that handler's docstring.

/** Text/markdown response size cap, in bytes — matches `graph/content`'s spirit (a preview
 *  surface, not a bulk file transfer) but is stricter since project files can be large
 *  generated artifacts a chat reference should never pull whole into the UI. Also gates raw
 *  image bytes so a huge PNG can't be requested through this endpoint either. */
const AGENT_FILE_MAX_BYTES = 512 * 1024;

/** A web page (`.html`/`.htm`) has its own, larger text cap: a mockup carries its pictures
 *  inline as base64 (one owner file was 596 KB and read as "could not be read", 2026-10-22).
 *  Still read whole into the JSON body, and still drawn only in the strict, network-less
 *  sandbox, so the cap stays a ceiling, not a stream. */
const AGENT_FILE_HTML_MAX_BYTES = 8 * 1024 * 1024;

/** An Excalidraw board (`*.excalidraw.md`) shares that larger cap: its scene JSON grows fast
 *  (a 202-element whiteboard was 827 KB), and over the preview cap every board card — the
 *  Super stage's `whiteboard` and `board` containers, a chat embed — drew "couldn't be read"
 *  (2026-10-23). The whiteboards page reads the same file uncapped. */
const AGENT_FILE_BOARD_MAX_BYTES = AGENT_FILE_HTML_MAX_BYTES;

/** The text-preview cap for one file: a web page and a board get the larger one. */
export function agentFileTextCap(abs: string): number {
  const lower = abs.toLowerCase();
  if (lower.endsWith('.excalidraw.md') || lower.endsWith('.excalidraw')) return AGENT_FILE_BOARD_MAX_BYTES;
  const ext = extname(lower);
  return ext === '.html' || ext === '.htm' ? AGENT_FILE_HTML_MAX_BYTES : AGENT_FILE_MAX_BYTES;
}

/** A file over its branch's cap: the size and the limit ride along, so a card can say how big
 *  it is and what the limit is instead of "could not be read". */
function sendTooLarge(res: ServerResponse, size: number, limit: number, message: string): void {
  sendJson(res, 413, { error: 'too_large', message, size, limit });
}

/** `?probe=1`: everything a read would check has passed and the file fits its branch's cap,
 *  answered without reading a byte (a card asking "will this load?" before it mounts a reader). */
function sendProbe(res: ServerResponse, size: number, limit: number): void {
  sendJson(res, 200, { probe: true, size, limit });
}

/** Extensions servable as raw image bytes via `?raw=1`. SVG is NOT in this map: it can embed
 *  `<script>`/`foreignObject`, so it has its own arm in `handleAgentFile` — raw bytes for an
 *  `<img>` (which never runs an SVG's script) under a `sandbox` CSP that keeps a direct
 *  navigation inert too, and the TEXT preview without `raw=1`. The vault route
 *  (`graph.ts`) never serves an SVG raw at all. */
const AGENT_FILE_IMAGE_CONTENT_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Everything the transcript can play or draw in place: the images above plus video and
 *  audio. Served STREAMED with byte-range support (see `serveMedia`) — a 40MB screen capture
 *  must never be buffered into memory, and `<video>` seeking is range requests, so without
 *  them a clip either refuses to play or can only be watched from the start. */
const AGENT_FILE_MEDIA_CONTENT_TYPE: Record<string, string> = {
  ...AGENT_FILE_IMAGE_CONTENT_TYPE,
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

/** Documents the browser engine can DISPLAY itself, served raw through the same streamed,
 *  range-aware path as media rather than as a text preview.
 *
 *  A PDF is the whole reason this map is separate from the media one. It is neither playable
 *  nor drawable, so it never belonged with `<video>`/`<img>`, but it is also the opposite of a
 *  text preview: asking the JSON branch for one reads a binary as UTF-8 and — for anything of
 *  a normal size — answers "File exceeds the preview size cap", which is exactly the dead end
 *  a 44-second video hit before it was streamed (owner report 07-25). Ranges are load-bearing
 *  here too: WebKit's built-in viewer pages a large PDF in by issuing range requests, so a
 *  200-with-everything either stalls the first page or refuses outright. */
const AGENT_FILE_DOC_CONTENT_TYPE: Record<string, string> = {
  '.pdf': 'application/pdf',
};

/** Everything `?raw=1` will hand over as bytes: media to play or draw, documents to display. */
const AGENT_FILE_RAW_CONTENT_TYPE: Record<string, string> = {
  ...AGENT_FILE_MEDIA_CONTENT_TYPE,
  ...AGENT_FILE_DOC_CONTENT_TYPE,
};

/** Media is STREAMED, so the 512KB preview cap (which exists to stop a huge generated file
 *  being pulled whole into the UI as text) doesn't apply — but a ceiling still does, so a
 *  mistyped path at a 40GB disk image can't tie up a socket indefinitely. */
const AGENT_MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Non-media types `/agent/reveal` may hand to the DEFAULT app rather than merely revealing
 *  in the file manager: documents and plain text, which viewers display rather than execute.
 *  Deliberately a small allowlist, not a denylist of dangerous extensions — a denylist is one
 *  unknown installer format away from launching something. */
const REVEAL_SAFE_DOC_EXT = new Set([
  '.pdf', '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.log',
  '.rtf', '.html', '.htm', '.xml', '.svg',
]);

// ─── Access grants (paths OUTSIDE the project root) ──────────────────────────────────
//
// `/agent/file` is deliberately confined to the project root, so a transcript that names a
// file elsewhere — a screen recording in a temp dir, a design in another repo — cannot be
// shown. Refusing outright is safe but useless: the user can SEE the file exists and is
// simply told no.
//
// So: outside paths are refused with `needs_grant` until the user explicitly allows THAT
// EXACT path from the card in the transcript. A grant is one absolute file path, recorded
// per vault, never a directory and never a pattern — clicking "Allow" on one video cannot
// hand the page a folder. The consent is a real click on a named file; nothing here grants
// itself, and the agent cannot grant on the user's behalf.

const FILE_GRANTS_FILE = '.file-grants.json';
const MAX_FILE_GRANTS = 500;

function grantsPath(contextRoot: string): string {
  return join(contextRoot, 'state', FILE_GRANTS_FILE);
}

function readGrants(contextRoot: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(grantsPath(contextRoot), 'utf-8')) as { paths?: unknown };
    return Array.isArray(raw.paths) ? raw.paths.filter((p): p is string => typeof p === 'string' && !!p) : [];
  } catch { return []; }
}

function addGrant(contextRoot: string, abs: string): void {
  const list = readGrants(contextRoot).filter((p) => p !== abs);
  list.push(abs);
  try {
    writeFileSync(grantsPath(contextRoot), JSON.stringify({ paths: list.slice(-MAX_FILE_GRANTS) }), 'utf-8');
  } catch { /* best-effort */ }
}

/**
 * Where `rawPath` really lives, and whether we may serve it.
 *   • inside the project root → allowed
 *   • outside + explicitly granted by the user → allowed
 *   • outside, not granted → `needs_grant`, which the UI turns into an "Allow access" card
 *     naming the RESOLVED file (returned as `abs`, so the grant records exactly what will
 *     then be served — the notation the answer happened to use never enters the record)
 *   • unresolvable (empty, null byte) → `invalid`
 *
 * WHICH file a reference names is `resolveChatReference`'s job, and it deliberately reads a
 * transcript path as a name rather than as an argument — see that module. WHETHER we may
 * serve it is decided here, and the rule is unchanged: nothing outside the project root
 * reaches the page without a real click on a card naming that file.
 *
 * Existence is deliberately NOT checked for an outside path before answering `needs_grant`:
 * a 404-vs-403 split there would let a page probe for arbitrary files it may not read.
 */
function resolveServablePath(
  contextRoot: string,
  rawPath: string,
  /** A phone socket passes false: project root only, grants refused. */
  opts: { grants: boolean; /** The session's own registered worktree (session-worktree.ts), or null. */ worktree?: string | null } = { grants: true },
): { abs: string } | { deny: 'invalid' | 'needs_grant' | 'outside'; abs?: string } {
  // A session working in its own worktree names files relative to THAT tree, so a reference
  // is tried there first; only a hit that really is inside it counts (an absolute path or a
  // tail match elsewhere falls through to the project-root reading below).
  let ref: ReturnType<typeof resolveChatReference> = null;
  if (opts.worktree) {
    const w = resolveChatReference(opts.worktree, contextRoot, rawPath);
    if (w && !w.missing && !w.outside) ref = w;
  }
  ref ??= resolveChatReference(contextRoot ? projectRootOf(contextRoot) : null, contextRoot, rawPath);
  if (!ref) return { deny: 'invalid' };

  // `ref.outside` is LEXICAL — it compares resolved strings, so a symlink that lives
  // inside the project and points out of it is "inside" by that test and outside in fact.
  // That gap is reachable: an agent's thread `files[]` paths are read back off disk, and
  // for a SHARED agent those files are written by whoever syncs the brain. So the decision
  // is re-taken over the REAL paths, which also catches a symlinked DIRECTORY above the
  // leaf — the case an `lstat` on the file itself would miss.
  //
  // A MISSING path is not a containment answer at all — `realpathSync` throws ENOENT for
  // one, and treating that as "outside" turned every 404 into a needs_grant card offering
  // access to a file that does not exist. So ENOENT keeps the lexical verdict and lets the
  // caller's own not-found branch answer; a dangling symlink lands there too, which is
  // correct — it resolves to nothing, so there is nothing to disclose.
  //
  // Any OTHER realpath failure (a permission error, a race, a loop) still fails CLOSED to
  // `needs_grant`: an answer we could not verify must ask rather than serve.
  let outside = ref.outside && !(opts.worktree && isInside(resolve(opts.worktree), ref.abs));
  if (contextRoot) {
    try {
      const realAbs = realpathSync.native(ref.abs);
      outside = !isInside(realpathSync.native(projectRootOf(contextRoot)), realAbs)
        && !(opts.worktree && isInside(realpathSync.native(opts.worktree), realAbs));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') outside = true;
    }
  }
  if (!outside) return { abs: ref.abs };
  if (!opts.grants) return { deny: 'outside', abs: ref.abs };
  // The grant is keyed on the LEXICAL path the card named and the user approved. Prior
  // consent to a named file stands; re-deriving it per read would make grants meaningless.
  return readGrants(contextRoot).includes(ref.abs)
    ? { abs: ref.abs }
    : { deny: 'needs_grant', abs: ref.abs };
}

/** GET /api/agent/file?path=<relative>[&raw=1] — read one file under the ACTIVE vault's
 *  PROJECT root (parent of `_dream_context`, via `projectRootOf` — never `_dream_context/`-
 *  scoped like `graph/content`). Desktop-gated; `contextRoot` arrives already resolved from
 *  the request's `X-Dreamcontext-Vault` header by the router (same per-request resolution
 *  every other non-vault-agnostic GET route gets — see index.ts's dispatch), so this needs no
 *  separate `?vault=` param the way the chat WS UPGRADE does (which can't send headers).
 *  `path` is contained under the project root via `safeChildPath` — anything that escapes
 *  (`..`, an absolute path, a null byte) is rejected with 400, per
 *  `[[dashboard-server-security]]`'s "any new route that builds a filesystem path from
 *  request input MUST use safeChildPath" rule. Every response — success or error — carries
 *  `X-Content-Type-Options: nosniff` (set once, up front, so every exit path inherits it via
 *  Node's setHeader/writeHead merge). Never widened for sub-agent transcripts — see this
 *  section's header comment. */
export async function handleAgentFile(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!isAgentHost()) { sendError(res, 403, 'desktop_only', 'Available only in the desktop app.'); return; }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const rawPath = url.searchParams.get('path');
  if (!rawPath) { sendError(res, 400, 'missing_path', 'Query parameter "path" is required.'); return; }


  // A Mac-mode phone: the desktop's grants never count — they are the owner's consent for the
  // Mac's own screen. Outside the project the phone sees MEDIA only, by its own rules
  // (`phoneOutsideMedia`): its own linked repos and worktrees without asking, anything else after
  // a one-tap phone grant, a project not chosen at start never.
  const phone = isPhoneSocket(req);
  // Desktop only: the phone keeps project-root rules, and reaches a worktree solely through
  // `phoneOutsideMedia` (media only, bytes sniffed) — never the text/folder/SVG paths below.
  const worktree = phone ? null : await sessionWorktreeRoot(contextRoot, projectRootOf(contextRoot), sanitizeUuid(url.searchParams.get('session')) || null);
  const resolved = resolveServablePath(contextRoot, rawPath, { grants: !phone, worktree });
  let phoneMedia: { abs: string; type: string } | null = null;
  if ('deny' in resolved && phone && resolved.deny === 'outside' && resolved.abs) {
    const v = await phoneOutsideMedia(req, contextRoot, resolved.abs, { granted: true });
    if ('deny' in v) { sendPhoneOutsideRefusal(res, v, rawPath); return; }
    phoneMedia = v;
  } else if ('deny' in resolved) {
    if (resolved.deny === 'needs_grant') {
      // NOT a refusal the UI should render as an error: it is the prompt to ask the user.
      // `path` is the RESOLVED file, so the card can name it and grant exactly it — the
      // notation the answer used ('../../tmp/x.png') never has to round-trip.
      sendJson(res, 403, {
        error: 'needs_grant',
        message: 'Outside the project — allow access to view this file.',
        path: resolved.abs,
      });
    } else {
      sendError(res, 400, 'invalid_path', 'That path cannot be read.');
    }
    return;
  }
  const abs = phoneMedia ? phoneMedia.abs : (resolved as { abs: string }).abs;
  if (!existsSync(abs)) { sendError(res, 404, 'not_found', `File not found: ${rawPath}`); return; }

  let st: ReturnType<typeof statSync>;
  try { st = statSync(abs); } catch { sendError(res, 404, 'not_found', `File not found: ${rawPath}`); return; }

  // The phone, outside the project: the media stream and nothing else — never a folder listing,
  // a text preview or a probe of anything but the media it may see.
  if (phoneMedia) {
    if (!st.isFile()) { sendError(res, 404, 'not_found', `Not a file: ${rawPath}`); return; }
    const url0 = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url0.searchParams.get('raw') !== '1') { sendError(res, 403, 'phone_media_only', 'Outside the project the phone shows pictures, audio and video only.'); return; }
    if (st.size > AGENT_MEDIA_MAX_BYTES) { sendTooLarge(res, st.size, AGENT_MEDIA_MAX_BYTES, 'File is too large to stream.'); return; }
    if (url0.searchParams.get('probe') === '1') { sendProbe(res, st.size, AGENT_MEDIA_MAX_BYTES); return; }
    serveMedia(req, res, abs, st.size, phoneMedia.type);
    return;
  }

  // A DIRECTORY answers with its listing — a folder named in the transcript is something to
  // look inside, not an error.
  if (st.isDirectory()) { sendDirListing(res, rawPath, abs); return; }
  if (!st.isFile()) { sendError(res, 404, 'not_found', `Not a file: ${rawPath}`); return; }

  const ext = extname(abs).toLowerCase();
  const rawType = AGENT_FILE_RAW_CONTENT_TYPE[ext];
  const wantsRaw = url.searchParams.get('raw') === '1';
  const probe = url.searchParams.get('probe') === '1';

  // AN SVG, AS AN IMAGE — for the Lightbox's `<img>` (Chat and the Agents page both open an
  // `.svg` there). An `<img>` never executes an SVG's script; `sandbox` plus `default-src
  // 'none'` makes the same URL inert if it is navigated to directly (scripts off, opaque
  // origin, nothing fetched); `nosniff` is set above. Capped like a text preview: an SVG is
  // markup, and a huge one is a generated artifact, not a picture.
  if (wantsRaw && ext === '.svg') {
    if (st.size > AGENT_FILE_MAX_BYTES) { sendTooLarge(res, st.size, AGENT_FILE_MAX_BYTES, 'File exceeds the preview size cap.'); return; }
    if (probe) { sendProbe(res, st.size, AGENT_FILE_MAX_BYTES); return; }
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    serveMedia(req, res, abs, st.size, 'image/svg+xml');
    return;
  }

  if (wantsRaw && rawType) {
    if (st.size > AGENT_MEDIA_MAX_BYTES) { sendTooLarge(res, st.size, AGENT_MEDIA_MAX_BYTES, 'File is too large to stream.'); return; }
    if (probe) { sendProbe(res, st.size, AGENT_MEDIA_MAX_BYTES); return; }
    // A document is DISPLAYED, never downloaded: without this an engine that has no built-in
    // viewer for the type falls back to saving it, which from the user's side reads as "the
    // viewer opened and nothing happened, and now there's a file in Downloads". `nosniff` is
    // already set above, and the type is ours (from the extension), not the client's.
    if (AGENT_FILE_DOC_CONTENT_TYPE[ext]) res.setHeader('Content-Disposition', 'inline');
    serveMedia(req, res, abs, st.size, rawType);
    return;
  }

  // Text preview keeps the tight cap: this branch reads the whole file into a JSON body. A web
  // page (its pictures ride inline) and an Excalidraw board (its scene JSON) get the larger one.
  const textCap = agentFileTextCap(abs);
  if (st.size > textCap) { sendTooLarge(res, st.size, textCap, 'File exceeds the preview size cap.'); return; }
  if (probe) { sendProbe(res, st.size, textCap); return; }
  let content: string;
  try { content = readFileSync(abs, 'utf-8'); } catch { sendError(res, 500, 'read_failed', 'Failed to read file.'); return; }
  sendJson(res, 200, { path: rawPath, type: ext === '.md' ? 'markdown' : 'text', content });
}

/** One directory's entries (capped), newest-looking first: folders, then files by name. */
function sendDirListing(res: ServerResponse, rawPath: string, abs: string): void {
  const MAX_ENTRIES = 300;
  let names: string[];
  try { names = readdirSync(abs); } catch { sendError(res, 500, 'read_failed', 'Failed to read the folder.'); return; }
  const entries = names.slice(0, MAX_ENTRIES).map((name) => {
    try {
      const s = statSync(join(abs, name));
      return { name, kind: s.isDirectory() ? 'dir' as const : 'file' as const, size: s.isDirectory() ? null : s.size };
    } catch {
      return { name, kind: 'file' as const, size: null };  // a broken symlink still deserves a row
    }
  });
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  sendJson(res, 200, { path: rawPath, type: 'dir', entries, truncated: names.length > MAX_ENTRIES, total: names.length });
}


/**
 * GET /api/agent/board-assets?path=<board> — the images an Excalidraw board named in the
 * transcript embeds, so the Chat view can DRAW the board instead of linking to it.
 *
 * The board itself already comes down through `GET /agent/file` (markdown), but an Obsidian
 * board stores its screenshots as wikilinks in `## Embedded Files` rather than base64 in the
 * scene — so without this the board renders with every image blank. `/api/knowledge-assets`
 * does exactly this job already, but only for boards under `knowledge/`; a board can live
 * anywhere in the project (`dashboard/public/announcements/*.excalidraw.md`, a board beside
 * its generator), which is what this covers.
 *
 * Two independent containment layers, same as everything else that builds a path from
 * request input: `resolveServablePath` decides whether we may read the BOARD at all (project
 * root, or a path the user explicitly granted), and the roots handed to `resolveBoardAssets`
 * decide where its wikilinks may resolve — the project root plus the board's own folder and
 * the two conventional image subfolders, never a parent of either. Images only, by
 * extension, and the same payload cap the knowledge route uses.
 */
export async function handleAgentBoardAssets(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isAgentHost()) { sendError(res, 403, 'desktop_only', 'Available only in the desktop app.'); return; }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const rawPath = url.searchParams.get('path');
  if (!rawPath) { sendError(res, 400, 'missing_path', 'Query parameter "path" is required.'); return; }

  const resolved = isPhoneSocket(req) ? resolveServablePath(contextRoot, rawPath, { grants: false }) : resolveServablePath(contextRoot, rawPath);
  if ('deny' in resolved) {
    if (resolved.deny === 'needs_grant') {
      sendError(res, 403, 'needs_grant', 'Outside the project — allow access to view this board.');
    } else {
      sendError(res, 400, 'invalid_path', 'Path escapes the project root.');
    }
    return;
  }
  const abs = resolved.abs;
  let content: string;
  try {
    if (!statSync(abs).isFile()) throw new Error('not a file');
    content = readFileSync(abs, 'utf-8');
  } catch { sendError(res, 404, 'not_found', `Board not found: ${rawPath}`); return; }

  const projectRoot = projectRootOf(contextRoot);
  const boardDir = dirname(abs);
  const files = await resolveBoardAssets(content, [
    projectRoot,
    contextRoot,
    boardDir,
    join(boardDir, 'assets'),
    join(boardDir, 'Attachments'),
  ], rawPath);

  sendJson(res, 200, { files });
}

/**
 * POST /api/agent/grant — the user allowing ONE named file outside the project root.
 *
 * The consent half of `resolveServablePath`'s `needs_grant`: reached only from an explicit
 * click on a card naming the file, and it records that exact absolute path, never its
 * directory and never a pattern. Files only — a granted directory would quietly widen into
 * everything beneath it, and nothing in the transcript needs that.
 */
export async function handleAgentGrant(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isDesktop()) { sendError(res, 403, 'desktop_only', 'Available only in the desktop app.'); return; }

  let target = '';
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { path?: unknown };
    if (typeof body.path === 'string') target = body.path;
  } catch { /* invalid body → the guard below */ }

  // win32: a `//host/share` spelling passes the `/` test, and the stat below would send the user's
  // NTLM hash to that host (see resolveChatReference).
  // Absolute, literal, local: `/…` on POSIX; a drive path (`C:\…`, `C:/…`) on Windows, where a
  // `//host/share` spelling would make the stat below send the user's NTLM hash to that host
  // (see resolveChatReference). No climb segment in either separator.
  const win = process.platform === 'win32';
  const absolute = win ? /^[A-Za-z]:[\\/]/.test(target) : target.startsWith('/');
  const climb = win ? /(^|[\\/])\.\.([\\/]|$)/ : /(^|\/)\.\.(\/|$)/;
  if (!absolute || target.includes('\0') || climb.test(target)) {
    sendError(res, 400, 'invalid_path', 'An absolute, literal file path is required.');
    return;
  }
  let st: ReturnType<typeof statSync>;
  try { st = statSync(target); } catch { sendError(res, 404, 'not_found', `File not found: ${target}`); return; }
  if (!st.isFile()) { sendError(res, 400, 'not_a_file', 'Only a file can be granted, not a folder.'); return; }

  addGrant(contextRoot, target);
  sendJson(res, 200, { granted: true, path: target });
}

// ─── The hands-free phone, outside the project ──────────────────────────────────────
//
// Task hands-free-phone-shows-every-picture… (owner 2026-10-23). The Super Agent's pictures live
// in its children's worktrees, the linked repo and /tmp — all outside the brain project — and the
// phone used to refuse every one with a 400. Now, decided on the REAL path, media only:
//   • a file inside a project the owner did not choose at start → refused (`other_project`), first;
//   • under the request project's own worktrees, linked repos or theirs → shown;
//   • anywhere else → shown after the phone's one-tap grant for that file (`needs_phone_grant`).
// Raster images must also SAY so in their bytes; a symlink named `.mp4` that points at a text
// file is judged by what it points at.

type PhoneOutside =
  | { abs: string; type: string }
  | { deny: 'other_project' | 'needs_phone_grant' | 'phone_media_only' | 'not_found'; abs: string };

async function phoneOutsideMedia(
  req: IncomingMessage,
  contextRoot: string,
  abs: string,
  /** `granted`: honour this device's phone grants (the file route). The grant route passes false. */
  opts: { granted: boolean },
): Promise<PhoneOutside> {
  let realAbs = abs;
  let missing = false;
  // Any path that cannot be resolved (missing, not a directory, unreadable) answers the same,
  // so the phone cannot tell those apart by probing.
  try { realAbs = realpathSync.native(abs); } catch { missing = true; }
  // The boundary first: nothing below may serve a file inside an unchosen project.
  const roots = await phoneMediaRoots(projectRootOf(contextRoot), macExposedVaults());
  const verdict = phoneMediaVerdict(realAbs, roots);
  if (verdict === 'other') return { deny: 'other_project', abs };
  const type = AGENT_FILE_MEDIA_CONTENT_TYPE[extname(realAbs).toLowerCase()];
  if (!type) return { deny: 'phone_media_only', abs };
  // The card names the path as REQUESTED (resolved, not followed): where a symlink points is not
  // the phone's to learn before it is allowed. The grant route resolves it again.
  // A file that is not there is not found, whatever its verdict: a "Show" that can only answer
  // 404 is a button that does nothing (a merged child's worktree, a rebooted /tmp).
  if (missing) return { deny: 'not_found', abs };
  if (verdict === 'ask' && opts.granted && !hasPhoneFileGrant(authFor(req) ? deviceIdHash(req) : null, realAbs)) {
    return { deny: 'needs_phone_grant', abs };
  }
  // A regular file only: opening a FIFO named `x.png` would block the event loop.
  let regular = false;
  try { regular = statSync(realAbs).isFile(); } catch { /* raced away */ }
  if (!regular) return { deny: 'not_found', abs };
  if (type.startsWith('image/')) {
    let head: Buffer | null = null;
    try {
      const fd = openSync(realAbs, 'r');
      try { head = Buffer.alloc(16); readSync(fd, head, 0, 16, 0); } finally { closeSync(fd); }
    } catch { head = null; }
    if (!head || sniffImageType(head) !== type) return { deny: 'phone_media_only', abs };
  }
  return { abs: realAbs, type };
}

function sendPhoneOutsideRefusal(res: ServerResponse, v: { deny: string; abs: string }, rawPath: string): void {
  if (v.deny === 'needs_phone_grant') {
    // The prompt to ask, not an error: `path` is the REAL file, which is what a grant records.
    sendJson(res, 403, { error: 'needs_phone_grant', message: 'Outside the project — tap Show to see it on this phone.', path: v.abs });
  } else if (v.deny === 'other_project') {
    // No path, no card button: this file is never the phone's to see.
    sendJson(res, 403, { error: 'other_project', message: 'This file is inside a project this phone cannot open.' });
  } else if (v.deny === 'not_found') {
    sendError(res, 404, 'not_found', `File not found: ${rawPath}`);
  } else {
    sendJson(res, 403, { error: 'phone_media_only', message: 'Outside the project the phone shows pictures, audio and video only.' });
  }
}

/**
 * POST /api/agent/phone-grant — the hands-free phone allowing ONE media file outside the project,
 * for that device only (phone-file-grants.ts: memory, ends with the device's session or the run).
 * Re-runs every rule of the file route — the boundary, media only, the bytes — so a grant can
 * never reach what the route itself would refuse. Body: `{ path }`, the absolute path the file
 * route answered `needs_phone_grant` with.
 */
export async function handleAgentPhoneGrant(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isPhoneSocket(req)) { sendError(res, 403, 'phone_only', 'Only the hands-free phone grants itself a file.'); return; }
  const device = authFor(req) ? deviceIdHash(req) : null;
  if (!device) { sendError(res, 401, 'unauthenticated', 'Sign in first.'); return; }
  // The run and the device this grant is for, taken BEFORE the awaits: a Mac-mode restart or a
  // revoke landing meanwhile must not leave a grant behind in the next run.
  const epoch = macExposedEpoch();
  const body = await parseJsonBody(req);
  const target = typeof body?.path === 'string' ? body.path : '';
  if (!target.startsWith('/') || target.length > 4096 || target.includes('\0')) {
    sendError(res, 400, 'invalid_path', 'An absolute file path is required.');
    return;
  }
  const resolved = resolveServablePath(contextRoot, target, { grants: false });
  // Inside the project there is nothing to grant: the file route already serves it.
  if (!('deny' in resolved)) { sendJson(res, 200, { granted: true, inside: true }); return; }
  if (resolved.deny !== 'outside' || !resolved.abs) { sendError(res, 400, 'invalid_path', 'That path cannot be read.'); return; }
  const v = await phoneOutsideMedia(req, contextRoot, resolved.abs, { granted: false });
  if ('deny' in v) { sendPhoneOutsideRefusal(res, v, target); return; }
  let isFile = false;
  try { isFile = statSync(v.abs).isFile(); } catch { /* gone */ }
  if (!isFile) { sendError(res, 404, 'not_found', `File not found: ${target}`); return; }
  let stillSignedIn = false;
  try { stillSignedIn = macHandsfreeAuth().store.isValidDeviceHash(device); } catch { /* unknown: refuse */ }
  if (epoch !== macExposedEpoch() || !stillSignedIn) { sendError(res, 409, 'stale', 'Hands-free changed meanwhile; try again.'); return; }
  addPhoneFileGrant(device, v.abs);
  sendJson(res, 200, { granted: true, path: v.abs });
}

/** The owner's own window: desktop app, this machine, a loopback Host, and this very origin
 *  (port included). A page on another loopback port (an approved dev server in a web card)
 *  can neither read nor write a grant (T0, AC3). Sends the 403. */
function requireGrantOwner(req: IncomingMessage, res: ServerResponse): boolean {
  if (!requireLocalDesktop(req, res)) return false;
  if (!isSameOriginStrict(req) || isCrossSiteRequest(req)) {
    sendError(res, 403, 'forbidden', 'Only this app\'s own window can change what a web card may load.');
    return false;
  }
  return true;
}

function vaultRealPath(contextRoot: string): string {
  try { return realpathSync(contextRoot); } catch { return resolve(contextRoot); }
}

/**
 * GET /api/agent/loopback-grants — the loopback ports this vault's web cards may load without
 * asking (`~/.dreamcontext/loopback-grants.json`), and the ports this process owns right now,
 * which no card may ever load (the window refuses them too: they change every launch).
 */
export async function handleLoopbackGrantsGet(
  req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, contextRoot: string,
): Promise<void> {
  if (!requireGrantOwner(req, res)) return;
  const owned = ownedLoopbackPorts();
  sendJson(res, 200, { grants: readLoopbackGrants(vaultRealPath(contextRoot), owned), ownedPorts: [...owned].sort((a, b) => a - b) });
}

/** POST /api/agent/loopback-grant `{port, op:'grant'|'revoke'}` — the owner's "Always allow
 *  localhost:PORT" in a web card, or its removal in Settings. Never an owned port. */
export async function handleLoopbackGrantSet(
  req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, contextRoot: string,
): Promise<void> {
  if (!requireGrantOwner(req, res)) return;
  const body = (await parseJsonBody(req)) ?? {};
  const port = body.port;
  const op = body.op === 'revoke' ? 'revoke' : body.op === 'grant' ? 'grant' : null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || !op) {
    sendError(res, 400, 'invalid_body', 'Send {port, op: "grant" | "revoke"}.');
    return;
  }
  const owned = ownedLoopbackPorts();
  if (op === 'grant' && owned.has(port)) {
    sendError(res, 403, 'owned_port', `localhost:${port} is this app's own port; it is never shown in a card.`);
    return;
  }
  try {
    const grants = setLoopbackGrant(vaultRealPath(contextRoot), port, op, owned);
    sendJson(res, 200, { grants, ownedPorts: [...owned].sort((a, b) => a - b) });
  } catch (err) {
    sendError(res, 500, 'grant_unwritable', `The grant could not be saved: ${(err as Error).message}`);
  }
}

/**
 * POST /api/agent/web-session `{port, host, once?}` — the session proxy for a web card's dev
 * server (`web-session-proxy.ts`): its origin (`http://127.0.0.1:<proxy>`, same site as this
 * window, so the page's cookies stick) and the token its Clear button uses. The owner's window
 * only (`requireGrantOwner`), never an owned port, and only for a port this vault always allows
 * or one the owner just opened once (the card's own gate already asked him).
 */
export async function handleWebSessionOpen(
  req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, contextRoot: string,
): Promise<void> {
  if (!requireGrantOwner(req, res)) return;
  const body = (await parseJsonBody(req)) ?? {};
  const port = body.port;
  const host = typeof body.host === 'string' ? body.host.toLowerCase() : 'localhost';
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || !(UPSTREAM_HOSTS as readonly string[]).includes(host)) {
    sendError(res, 400, 'invalid_body', 'Send {port, host: "localhost" | "127.0.0.1" | "[::1]"}.');
    return;
  }
  const owned = ownedLoopbackPorts();
  if (owned.has(port)) {
    sendError(res, 403, 'owned_port', `localhost:${port} is this app's own port; it is never shown in a card.`);
    return;
  }
  const granted = readLoopbackGrants(vaultRealPath(contextRoot), owned).some((g) => g.port === port);
  if (!granted && body.once !== true) {
    sendError(res, 403, 'not_allowed', `localhost:${port} is not allowed in this project.`);
    return;
  }
  try {
    // One session per project and port: two projects on :3000 never share a login or storage.
    const s = await openWebSession(port, { scope: vaultRealPath(contextRoot), host, parent: `http://${String(req.headers.host ?? '').toLowerCase()}` });
    sendJson(res, 200, { origin: s.origin, clearToken: s.clearToken });
  } catch (err) {
    sendError(res, 500, 'proxy_failed', `The page's session could not be opened: ${(err as Error).message}`);
  }
}

/**
 * POST /api/agent/reveal — hand a path to the OS: open it, or show the user where it sits.
 *
 * The escape hatch for something the chat transcript cannot draw itself: `GET /agent/file`
 * serves nothing outside the project root without an explicit grant, so a file living
 * elsewhere (a system temp dir, a sibling repo) may never reach the page as bytes. Rather
 * than leaving the user with a dead chip, this reaches it the way double-clicking in Finder
 * would.
 *
 * "Run the OS opener on a path" is a real capability, so the two modes ARE the safety story:
 *   • desktop-only, like every other agent route;
 *   • a FOLDER, or a type that viewers DISPLAY rather than execute (media + the small
 *     `REVEAL_SAFE_DOC_EXT` document allowlist) → handed to the default app, which is what
 *     "just open it" means;
 *   • anything else → REVEALED in the file manager instead. A `.sh`, `.command`, `.pkg` or
 *     `.app` named in a transcript must never be launched by a click in a chat bubble;
 *     showing the user where it sits gives the same reach with none of the risk;
 *   • the file must already exist;
 *   • argv form (no shell), so nothing in the path can be interpreted as a command.
 * It is also only ever reached from an explicit user click on a named file.
 *
 * `mode` lets the caller ask for the file manager EXPLICITLY (`'reveal'`) rather than take
 * the decision above, because "show me where this is" and "open this" are two different
 * things a person wants and the UI now offers both as separate buttons. It only ever
 * NARROWS what happens: `'reveal'` can turn an open into a reveal, never a reveal into an
 * open, so the executable rule holds whatever the client asks for. The answer reports which
 * of the two actually happened (`mode: 'open' | 'reveal'`), so a click on "Open on computer"
 * for a `.sh` can say it was shown in the file manager instead of silently doing something
 * else than the button said.
 */
export async function handleAgentReveal(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isDesktop()) { sendError(res, 403, 'desktop_only', 'Available only in the desktop app.'); return; }

  let target = '';
  let forceReveal = false;
  let revealSession = '';
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { path?: unknown; mode?: unknown; session?: unknown };
    if (typeof body.path === 'string') target = body.path;
    if (typeof body.session === 'string') revealSession = sanitizeUuid(body.session);
    // Anything other than the one recognised narrowing word means "decide for me" — an
    // unknown mode must not be able to widen this route, and defaulting to `open` is the
    // behaviour every existing caller already has.
    forceReveal = body.mode === 'reveal';
  } catch { /* invalid body → the empty-path guard below */ }

  if (!target) { sendError(res, 400, 'missing_path', 'A "path" is required.'); return; }

  // A transcript names files the way the AGENT writes them, which is not the same thing as
  // a path that resolves: project-relative, absolute, or — the 07-28 report — a `../..`
  // climb that lands nowhere. `resolveChatReference` reads it as a name and finds the file
  // it actually means, which is what makes this button open something rather than nothing.
  // Reaching a file outside the project is this route's whole purpose (that is the escape
  // hatch for what `/agent/file` may never serve), so `outside` is not a refusal here — the
  // open-vs-reveal split below is, and it is unchanged.
  const wt = contextRoot ? await sessionWorktreeRoot(contextRoot, projectRootOf(contextRoot), revealSession || null) : null;
  const inWt = wt ? resolveChatReference(wt, contextRoot, target) : null;
  const ref = inWt && !inWt.missing && !inWt.outside
    ? inWt
    : resolveChatReference(contextRoot ? projectRootOf(contextRoot) : null, contextRoot, target);
  if (!ref || ref.missing) {
    sendError(res, 404, 'not_found', `Not found: ${ref?.abs ?? target}`);
    return;
  }
  target = ref.abs;
  let st: ReturnType<typeof statSync>;
  try { st = statSync(target); } catch { sendError(res, 404, 'not_found', `Not found: ${target}`); return; }

  // Two modes, and the distinction is the whole safety story:
  //   • a FOLDER, or a file type we know is inert to view (media + plain text/docs) → hand it
  //     to the default app, which is what the user means by "just open it";
  //   • anything else → REVEAL it in the file manager instead of opening it. A `.sh`,
  //     `.command`, `.pkg` or `.app` named in a transcript must never be launched by a click
  //     in a chat bubble; showing the user where it sits gives them the same reach with none
  //     of the risk.
  const ext = extname(target).toLowerCase();
  const inertToView = !!AGENT_FILE_MEDIA_CONTENT_TYPE[ext] || REVEAL_SAFE_DOC_EXT.has(ext);
  const openDirectly = !forceReveal && (st.isDirectory() || inertToView);

  const opener = process.platform === 'darwin'
    ? { cmd: 'open', args: openDirectly ? [target] : ['-R', target] }
    : process.platform === 'win32'
      ? { cmd: 'explorer', args: openDirectly ? [target] : [`/select,${target}`] }
      : { cmd: 'xdg-open', args: [openDirectly ? target : dirname(target)] };
  try {
    spawn(opener.cmd, opener.args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } catch {
    sendError(res, 500, 'open_failed', 'The system opener could not be started.');
    return;
  }
  sendJson(res, 200, { opened: true, mode: openDirectly ? 'open' : 'reveal' });
}
