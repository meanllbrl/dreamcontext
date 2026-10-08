import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename, extname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  writeFileSync, rmSync, readFileSync, existsSync, statSync, readdirSync, createReadStream,
  realpathSync, openSync, readSync, closeSync, lstatSync, fstatSync, constants as fsConstants,
} from 'node:fs';
import { sendJson, sendError, isForeignOriginUpgrade } from '../middleware.js';
import { serveMedia } from '../media.js';
import { isAgentHost, isAgentRequest, isDesktop } from '../desktop.js';
import { cloudChatRootRefusal, cloudPhase, cloudWorkDir, isCloud, readFileAsWorker, spawnAsWorker } from '../cloud-mode.js';
import { isCloudOriginAllowed } from '../middleware.js';
import { recordCloudAction } from '../cloud-idle.js';
import { deviceIdHash, handsfreeAuth, onDeviceSessionsChanged } from '../handsfree-auth.js';
import { runWorkerOp } from '../cloud-worker.js';
import { handsfreeSpawnRefusal } from '../../lib/peer-delivery.js';
import { cutProcessGroups } from '../../lib/automations/runner.js';
import { trackChild } from '../lifecycle.js';
import { resolveAgentSession } from '../../lib/agent-session-map.js';
import { readHandoffRecord, stampHandoffRecord, writeTabHandoff, readTabHandoff, resolveTabSeed, resolveHandoffFor, shouldRotateForHandoff, contextTokensFromUsage } from '../../lib/context-watch.js';
import { readSetupConfig, readBrainLocal, writeBrainLocal } from '../../lib/setup-config.js';
import { startHandoffRun, advanceHandoffRun, failHandoffRun, handoffProgressFrame, type HandoffRun } from '../../lib/handoff-progress.js';
import { safeChildPath } from '../safe-path.js';
import { resolveChatReference, isInside } from '../chat-reference-path.js';
import { CHAT_SURFACE_BRIEFING } from '../chat-surface.js';
import { parseCardRef, parseChatAgent, prepareAgentChat, prepareCardChat, type CardRef } from '../../lib/whiteboards/card-chat.js';
import { chatSubagents } from '../../lib/automations/chat-subagents.js';
import { modeBriefing, type ChatMode } from '../chat-modes.js';
import { heldModeFromTranscript, modeNoteHookOutput, modeNoteSettings, modeNoteSources, modeSwitchNote } from '../chat-mode-drift.js';
import { worktreeIsolationAllowed } from '../../lib/worktree-gate.js';
import { autoModeSettings } from '../../lib/auto-mode-rules.js';
import { clearSessionCheckout, enterSessionCheckout, exitSessionCheckout } from '../../lib/session-cwd.js';
import { describeFreshStart, freshSessionOnDefaultBranch } from '../../lib/session-start-branch.js';
import { createWorktreeWatcher } from '../worktree-frames.js';
import {
  describeCheckoutClaim, describeCheckoutReset, readCheckoutDirective, readEditPaths,
} from '../checkout-directive.js';
import { clearSessionEdits, recordSessionEdit } from '../../lib/session-edits.js';
import { forgetSessionFacts, readSessionFacts } from '../../lib/session-facts.js';
import { claudeAwarePath } from '../../lib/claude-path.js';
import { claudeAuthWatcher } from '../../lib/claude-auth-watch.js';
import {
  accountEnvFor, autoSwitchEnabled, isRealHomeConfigDir, listClaudeAccounts, resolveConfigDir,
  switchStrategyFor, switchWeightsFor,
} from '../../lib/claude-accounts.js';
import { ensureSandbox, ensureSharedMcpConfig } from '../../lib/claude-account-sandbox.js';
import { probeAccountForDecision } from '../../lib/claude-usage-probe.js';
import { readUsageLimits, usageReadingIsCurrent } from '../../lib/claude-usage.js';
import {
  SWITCH_THRESHOLD_PERCENT, chooseAccount, shouldProbe, shouldSwitchAway, type AccountReading,
} from '../../lib/claude-account-switch.js';
import { readLimitSignal, type LimitSignal } from '../../lib/claude-limit-signal.js';
import { readAccountRejections, recordAccountRejection } from '../../lib/claude-limit-rejections.js';
import { chatSpawnAccount } from '../../lib/automations/account.js';
import { automationCacheDir, isSafeAutomationSlug, readAutomationCache } from '../../lib/automations/store.js';
import { isAutomationBoundSession } from '../../lib/automations/session-registry.js';
import { resolveBoardAssets } from './knowledge.js';
import { isTrustedRemotePeer } from '../remote-access.js';
import { assistantContextRoot, assistantExists, isAssistantVault, readAssistantConfig, DEFAULT_ASSISTANT_CONFIG, DEFAULT_ASSISTANT_MODEL, type Autonomy } from '../../lib/assistant/home.js';
import { registerChat, isDelegatedConversation, listChats, type ChatHandle } from '../../lib/assistant/chat-registry.js';
import { resolveRecallMode, type RecallMode } from '../../cli/commands/sleep.js';
import { isEmbedModelDownloaded } from '../../lib/embeddings/embedder.js';
import { ensureIndexBuilt } from './embeddings.js';
import { assistantToken, clearTaint, markTainted, setAssistantSurface } from '../../lib/assistant/session-state.js';
import { collectRoster, renderRoster } from '../../lib/assistant/roster.js';
import { deliverResult, failAllCommands } from '../../lib/assistant/relay.js';
import { attachAssistantInbox } from '../../lib/assistant/delegations.js';
import { listNotchEvents, lookingAt, recordAccountSwitch } from '../../lib/assistant/notch-inbox.js';
import { buildLiveContextParts } from '../../lib/assistant/live-context.js';
import { seedForConversation } from '../../lib/assistant/chat-seed.js';
import { ensureComputerMcpConfig } from '../../lib/assistant/computer-mcp.js';
import { runningAutomations, unreadAutomationPosts } from '../assistant-inbox.js';
import {
  CUT_KILL_GRACE_MS, detachBusyCapMs, detachIdleMs, findLiveChat, markLiveChatDraining, markTurnEnded, markTurnStarted, registerLiveChat,
  signalGroup, unregisterLiveChat, wsPingMs, type LiveChatEntry,
} from './agent-chat-live.js';
import {
  isLoopback, rejectUpgrade, resolveVaultProjectRoot, projectRootOf,
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
  // transcript never costs a wait.
  const candidates = [mapped, resumeId].filter((c) => c && claudeConversationExists(c));
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
 * stays the real guard for send/answer/broadcast. `ask` must keep prompting (the CLI prompt
 * IS the approval for the free verbs there); `bypass` needs nothing. Never on any other spawn.
 */
export function assistantAllowedTools(autonomy: Autonomy): string[] {
  return autonomy === 'auto' ? ['--allowedTools', 'Bash(dreamcontext assistant:*)'] : [];
}

/**
 * `--mcp-config` is variadic (`<configs...>`): every file rides in ONE flag, and the flag must
 * stay the LAST argv element or it swallows whatever follows. Null entries drop out.
 */
/** A POSIX single-quoted shell word: the shell takes any content verbatim (' becomes '\''). */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The cloud's mode-note hook command: the hook output itself, base64 (only [A-Za-z0-9+/=], no
 * quote or shell metacharacter), decoded at run time. No file: the hook runs as dcuser, which
 * cannot open a file the server (dcserver) wrote 0600.
 */
export function inlineModeNoteCommand(hookOutput: string): string {
  return `echo ${Buffer.from(hookOutput, 'utf-8').toString('base64')} | base64 -d`;
}

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

// ─── Cloud device sockets follow their device (AC3) ─────────────────────────────────
//
// The cloud checks a device session when a chat socket opens. A socket already open, and the
// child it drives (detached or not), must not outlive its device: revoke-all, a password
// change and a single logout notify handsfree-auth's listener, and every session whose owning
// device is no longer valid is closed with 4401 and cut. Each frame re-checks too (defence in
// depth: a device that expired between notifications). Laptop sockets are never tagged.

/** WS close code for "your device was signed out". */
export const DEVICE_REVOKED_CLOSE = 4401;

/** The sha256 of the device id each cloud chat socket authenticated with (never the cookie). */
const socketDevice = new WeakMap<object, string>();
const cloudDeviceSessions = new Set<{ device: () => string | null; revoke: () => void }>();
let deviceRevocationArmed = false;

export function tagCloudDeviceSocket(ws: object, idSha256: string): void {
  socketDevice.set(ws, idSha256);
}

function armDeviceRevocation(): void {
  if (deviceRevocationArmed) return;
  deviceRevocationArmed = true;
  onDeviceSessionsChanged(() => { revokeStaleDeviceSessions(); });
}

/** Close and cut every cloud chat session whose device is no longer valid. Returns how many. */
export function revokeStaleDeviceSessions(): number {
  const store = handsfreeAuth().store;
  let n = 0;
  for (const s of [...cloudDeviceSessions]) {
    const d = s.device();
    if (d && !store.isValidDeviceHash(d)) { s.revoke(); n++; }
  }
  return n;
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
export function attachAgentChat(server: Server, opts: { networkToken?: string | null } = {}): void {
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
    if (isCloud()) {
      // Hands-free cloud: GitHub's forwarder makes every peer loopback, so only a live device
      // session, our own Origin and phase active open a chat (the cloud gate checked these
      // before the upgrade was emitted; checked again here so this listener never relies on
      // its order). The Assistant never runs in the cloud.
      if (assistant || !isAgentRequest(req) || !isCloudOriginAllowed(req)) { rejectUpgrade(socket, 403); return; }
      if (cloudPhase() !== 'active') { rejectUpgrade(socket, 403); return; }
    } else if (assistant) {
      if (!isDesktop() || !isLoopback(req)) { rejectUpgrade(socket, 403); return; }
      // …and only from the app's own pages: a website the owner visits is loopback too.
      if (isForeignOriginUpgrade(req)) { rejectUpgrade(socket, 403); return; }
      if (!assistantExists()) { rejectUpgrade(socket, 400); return; }
    } else {
      const trusted = isLoopback(req) || isTrustedRemotePeer(req, opts.networkToken ?? null);
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

    // T24 — the automation-bound resume gate (see the block comment on
    // `shouldRejectAutomationResume` above). Evaluated HERE, before `startChatSession` is
    // called at all (and therefore before `resolveAgentSession`, currently agent-chat.ts:250),
    // so a tab-session mapping can never launder an unbound automation session id into a
    // resumable one.
    if (shouldRejectAutomationResume(bypass, resumeId, join(projectRoot, '_dream_context'))) {
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
    const reattach = url.searchParams.get('reattach') === '1' && !!resumeId && !assistant;

    void (async () => {
      let WebSocketServer: typeof import('ws').WebSocketServer;
      try { ({ WebSocketServer } = await import('ws')); }
      catch { rejectUpgrade(socket, 501); return; }

      // A live child for this conversation (see agent-chat-live.ts). A reattach adopts it; any
      // OTHER connection naming it is a respawn (account, mode, Resume) and the child must give
      // the conversation up, exactly as a closed socket made it do before detaching existed.
      const live = findLiveChat(resumeId);
      const adoptable = reattach && live && live.projectRoot === projectRoot ? live : null;
      // PROVISIONAL: a second tab opening the same conversation is refused below while the
      // first one still holds it, and a refused open must not cost the first pane its detach.
      // So the mark is withdrawn unless this open is actually accepted.
      let pendingSupersede = live && !reattach ? live.supersede() : null;
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
      // Cloud: the device this socket proved (its id's hash) owns whatever it opens or adopts.
      const deviceHash = isCloud() ? deviceIdHash(req) : null;
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (deviceHash) tagCloudDeviceSocket(ws, deviceHash);
        if (adoptable && adoptable.adopt(ws)) return;
        // A reattach that found nothing to adopt (the child exited while the client was away)
        // resumes the conversation in a new process — and never re-submits an opening prompt.
        if (reattach) {
          startChatSession(ws, projectRoot, { bypass, sessionId: '', resumeId, model, effort, mode, account, initialPrompt: '', deferPrompt: false, vault: vault ?? undefined, fromAssistant, reattachFallback: true, ...(card ? { card } : {}), ...(chatAgent ? { agent: chatAgent } : {}) });
          return;
        }
        // The Assistant's CLI reaches `/api/assistant/*` with these two — injected into THIS
        // spawn only, never into any other vault's chat.
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        const assistantEnv = assistant
          ? { DREAMCONTEXT_ASSISTANT_URL: `http://127.0.0.1:${port}`, DREAMCONTEXT_ASSISTANT_TOKEN: assistantToken() }
          : undefined;
        let accepted = false;
        startChatSession(ws, projectRoot, { bypass, sessionId, resumeId, model, effort, mode, account, initialPrompt, deferPrompt, vault: vault ?? undefined, assistantEnv, fromAssistant, onAccepted: () => { accepted = true; }, ...(card ? { card } : {}), ...(chatAgent ? { agent: chatAgent } : {}) });
        settleSupersede(accepted);
        // D14: opening a session is a real owner action (a reattach is not: it is a reconnect).
        if (accepted) recordCloudAction();
      });
    })();
  });
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
 * How long an announced account switch may stay unperformed, counted from the turn boundary
 * with a socket attached, before the held messages are sent on the current account instead.
 * The client restarts the instant it reads `turnInFlight: false`, so a minute only elapses when
 * something on the client side is broken — and then a visible limit error beats a message that
 * never runs. Overridable for the verify harness.
 */
const SWITCH_STALL_MS = Number(process.env.DREAMCONTEXT_SWITCH_STALL_MS) > 0
  ? Number(process.env.DREAMCONTEXT_SWITCH_STALL_MS)
  : 60_000;

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

/** Drop undefined values (the worker env takes strings only). */
function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

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
  /** Cloud: the device whose socket drives this child (updated when another socket adopts it). */
  let ownerDevice: string | null = isCloud() ? socketDevice.get(initialWs) ?? null : null;
  const { bypass, sessionId, resumeId, model, effort, mode, account, initialPrompt, deferPrompt } = opts;

  // Hands-free cloud: only phase active spawns (quiescing = the laptop is taking the project
  // back; sealed = it has). Covers a respawn in place too, not only a new socket.
  if (isCloud() && cloudPhase() !== 'active') {
    try { ws.send(JSON.stringify({ type: 'dc_meta', subtype: 'error', code: 'cloud_quiescing', message: 'Your laptop is taking this project back; no new agent starts now.' })); } catch { /* gone */ }
    try { ws.close(); } catch { /* already closed */ }
    return;
  }
  // Smoke #5 (Critical): in the cloud an agent runs ONLY inside the trip's own roots, never in
  // the codespace's checkout or wherever else a name resolves; anything else is refused here,
  // at the one chokepoint every chat spawn (and respawn) passes.
  const outsideTrip = isCloud() ? cloudChatRootRefusal(projectRoot) : null;
  if (outsideTrip) {
    try { ws.send(JSON.stringify({ type: 'dc_meta', subtype: 'error', code: 'cloud_not_trip', message: outsideTrip })); } catch { /* gone */ }
    try { ws.close(); } catch { /* already closed */ }
    return;
  }
  // Hands-free (AC6): while this project is away in the cloud, the laptop never starts an
  // agent inside it — the cloud copy is the live one, and work here would be lost at Return.
  // One message for every spawn chokepoint (lane F's peer-delivery.ts).
  const refusal = isCloud() ? null : handsfreeSpawnRefusal(projectRoot);
  if (refusal) {
    try { ws.send(JSON.stringify({ type: 'dc_meta', subtype: 'error', code: 'handsfree_away', message: `Refused: ${refusal}.` })); } catch { /* gone */ }
    try { ws.close(); } catch { /* already closed */ }
    return;
  }
  const contextRoot = join(projectRoot, '_dream_context');
  const isAssistant = mode === 'assistant';
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
  const spawnAccount = account || (isCloud() ? '' : (chatSpawnAccount().id ?? ''));
  let accountConfigDir: string;
  try {
    accountConfigDir = resolveConfigDir(spawnAccount || null);
    // In the cloud the sandbox is dcuser's (0700): the entrypoint's `claude-login` built it as
    // dcuser (D13), and dcserver must not write into it.
    if (!isCloud()) ensureSandbox(accountConfigDir);
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
  const mcpConfigPath = isRealHomeAccount || isCloud() ? null : ensureSharedMcpConfig();
  // The Assistant's hands (mouse, keyboard, screen — computer-mcp.ts): its spawn ONLY, macOS
  // only. Each call is an MCP tool call, so under `ask` the owner approves it in the notch.
  const computerMcpPath = isAssistant && process.platform === 'darwin' && !isCloud() ? ensureComputerMcpConfig() : null;
  // Recorded beside `spawnAuthEpoch` so the live panel can be labelled with the account it is
  // really billing, and so the chooser knows which account NOT to move away from on a tie.
  const activeAccountId = spawnAccount
    || listClaudeAccounts().find((a) => (a.configDir ?? homedir()) === accountConfigDir)?.id
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
    const prep = prepareAgentChat(contextRoot, opts.agent);
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
      // The cloud's child runs as dcuser, and its UserPromptSubmit hook must read AND delete this
      // file: it goes into dcuser's own 2770 work dir (group dcwork, a fresh random name, O_EXCL),
      // never dcserver's 0600 /tmp file the hook cannot open.
      const parked = join(isCloud() ? cloudWorkDir() : tmpdir(), `dreamcontext-deferred-${randomUUID()}.txt`);
      try {
        writeFileSync(parked, initialPrompt, isCloud() ? { encoding: 'utf-8', mode: 0o640, flag: 'wx' } : { encoding: 'utf-8', mode: 0o600 });
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
  /** Cloud-only argv values carried INLINE (prose / JSON): single-quoted into the script. */
  const inlineArgs = new Set<string>();
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
      if (isCloud()) {
        agentsArg = ['--agents', json];
        inlineArgs.add(json);
      } else {
        const file = join(tmpdir(), `dreamcontext-chat-agents-${randomUUID()}.json`);
        if (!isShellSafePath(file)) throw new Error('unsafe tmpdir');
        writeFileSync(file, json, { encoding: 'utf-8', mode: 0o600 });
        agentsArg = ['--agents', file];
        cleanupAgents = () => { try { rmSync(file, { force: true }); } catch { /* tmp cleanup */ } };
      }
    } catch { agentsArg = []; subagents = null; }
  }
  try {
    const brief = join(tmpdir(), `dreamcontext-chat-surface-${randomUUID()}.md`);
    // Our own filename, but `tmpdir()` comes from TMPDIR — the one argv element below that
    // isn't a fixed literal or a whitelist-sanitized token. Hold it to the same standard
    // (see the quoting note on `script`): a tmpdir carrying a shell metacharacter drops the
    // briefing rather than reaching the command line.
    if (!isShellSafePath(brief)) throw new Error('unsafe tmpdir');
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
    const briefing = modeBrief ? `${CHAT_SURFACE_BRIEFING}\n${modeBrief}` : CHAT_SURFACE_BRIEFING;
    if (isCloud()) {
      // The cloud's child (dcuser) cannot open dcserver's 0600 file: the text rides inline,
      // single-quoted into the script (see `inlineArgs`), with no file anyone could swap.
      briefingArg = ['--append-system-prompt', briefing];
      inlineArgs.add(briefing);
    } else {
      writeFileSync(brief, briefing, { encoding: 'utf-8', mode: 0o600 });
      briefingArg = ['--append-system-prompt-file', brief];
      cleanupBriefing = () => { try { rmSync(brief, { force: true }); } catch { /* tmp cleanup */ } };
    }
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
  if (resumeTarget && !isAssistant && !card) {
    try {
      const transcript = findFirstTranscriptPath([resumeTarget]);
      const state = transcript ? heldModeFromTranscript(readFileSync(transcript, 'utf-8')) : null;
      const sources = modeNoteSources(state, mode);
      if (state && sources.length) {
        const brief = modeBriefing(mode, { worktreeAllowed: worktreeIsolationAllowed(projectRoot) });
        const note = modeNoteHookOutput(modeSwitchNote(state.held, mode, brief));
        if (isCloud()) {
          // The hook runs as dcuser: no dcserver file to `cat`; the note itself rides in the
          // (inline) settings, base64 so the command holds no quote or shell metacharacter.
          Object.assign(spawnSettings, JSON.parse(modeNoteSettings(inlineModeNoteCommand(note), sources)));
        } else {
          const id = randomUUID();
          const out = join(tmpdir(), `dreamcontext-chat-mode-${id}.json`);
          if (!isShellSafePath(out)) throw new Error('unsafe tmpdir');
          writeFileSync(out, note, { encoding: 'utf-8', mode: 0o600 });
          tmpFiles.push(out);
          Object.assign(spawnSettings, JSON.parse(modeNoteSettings(`cat "${out}"`, sources)));
        }
      }
    } catch { /* the model keeps the mode it was born with — the defect, not a crash */ }
  }
  try {
    if (isCloud()) {
      // `--settings` takes a JSON string too (claude --help: <file-or-json>). Inline in the
      // cloud: the dcuser child could not read dcserver's 0600 file (smoke #4: every phone chat
      // died with EACCES), and a file in a dir dcuser can write could be swapped by another
      // agent to drop these carve-outs. Nothing on disk at all.
      const json = JSON.stringify(spawnSettings);
      modeNoteArg = ['--settings', json];
      inlineArgs.add(json);
    } else {
      const settings = join(tmpdir(), `dreamcontext-chat-settings-${randomUUID()}.json`);
      if (!isShellSafePath(settings)) throw new Error('unsafe tmpdir');
      writeFileSync(settings, JSON.stringify(spawnSettings), { encoding: 'utf-8', mode: 0o600 });
      tmpFiles.push(settings);
      modeNoteArg = ['--settings', settings];
    }
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
    ...(envelope?.permissionArgs ?? ['--permission-mode', assistantConfig ? assistantPermissionMode(assistantConfig.autonomy) : permissionModeFor(bypass)]),
    ...briefingArg,
    ...agentsArg,
    // The `--settings` file is a flag source the scope cannot narrow: a scoped card goes without.
    ...(scopedCard ? [] : modeNoteArg),
    ...idArg,
    ...(spawnModel ? ['--model', spawnModel] : []),
    ...(spawnEffort ? ['--effort', spawnEffort] : []),
    ...(assistantConfig ? assistantAllowedTools(assistantConfig.autonomy) : []),
    // A SANDBOXED session reaches the user's MCP servers BY REFERENCE. Its own config is
    // seeded with no MCP keys at any depth, so without this flag it would silently lose every
    // server the user has; copying them per account would multiply the secrets instead.
    // Account #0 reads the real config directly and needs nothing. `--strict-mcp-config` is
    // deliberately NOT passed, so a project's own `.mcp.json` still applies.
    // No MCP for a scoped card (its allowlist names no MCP tool; out of scope by decision).
    ...(scopedCard ? [] : mcpConfigArgs([mcpConfigPath, computerMcpPath])),
  ];
  // Quoted for the login-shell script string exactly like the terminal/title/capture
  // spawns: every element here is either a fixed flag literal or a whitelist-sanitized
  // value (UUID / model alias / effort level), so plain double-quoting is sufficient —
  // none of them can contain a shell metacharacter. (`Bash(dreamcontext assistant:*)` is a
  // fixed literal whose parens, colon, space and star are all inert inside double quotes.)
  // The cloud's inline prose/JSON (`inlineArgs`) can hold anything: single-quoted, which the
  // shell takes verbatim. Every other element keeps the double quotes above.
  // In the cloud the login shell's own init (`bash -ilc`: /etc/profile, profile.d, bashrc) may
  // change directory; smoke #5's chat ran in the codespace's checkout. The script itself goes to
  // the trip root first, and claude never starts anywhere else.
  const script = `${isCloud() ? `cd -- ${shellSingleQuote(projectRoot)} && ` : ''}exec claude ${argv.map((a) => (inlineArgs.has(a) ? shellSingleQuote(a) : `"${a}"`)).join(' ')}`;

  // An agent-chat process exports its tab's STABLE roster id so the SessionStart/Stop
  // hooks (which inherit this env through `claude`) record roster id → live conversation
  // id on every rotation — the SAME map the embedded terminal writes/reads (AC7: chat and
  // terminal resume interop through one registry). Only when actually pinned/resumed.
  const tabEnv = pinId && idArg.length
    ? { DREAMCONTEXT_TAB_SESSION: pinId, DREAMCONTEXT_SERVER_PID: String(process.pid) }
    : {};

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

  const childEnv = { PATH: claudeAwarePath(), ...CHAT_QUESTION_ENV, ...tabEnv, ...deferredEnv, DREAMCONTEXT_DEVELOP_LEAD: mode === 'develop' ? '1' : '', DREAMCONTEXT_CHAT_TAB: isAssistant || card ? '' : '1', ...(isAssistant ? opts.assistantEnv ?? {} : {}), ...recallEnv, ...(envelope?.env ?? {}) } as Record<string, string | undefined>;
  // The cloud spawns every agent as dcuser through the one worker chokepoint: an allow-listed
  // env (never the server's own, so no DC_HF_*, transfer secret or GitHub token), only THIS
  // account's CLAUDE_CONFIG_DIR, and bash (the image has no zsh). Its own process group either
  // way, so a hands-free cut can end the whole tree (cutLiveChats).
  const child: ChildProcessWithoutNullStreams = isCloud()
    ? spawnAsWorker('/bin/bash', ['-ilc', script], {
      cwd: projectRoot,
      account: { configDir: accountConfigDir },
      env: definedEnv(childEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    }) as ChildProcessWithoutNullStreams
    : spawn(process.env.SHELL || '/bin/zsh', ['-ilc', script], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    // claude-aware PATH: `claude` installs into ~/.local/bin, which no default PATH
    // contains — without this the login shell 127s whenever the install's `export
    // PATH` echo never reached the user's rc. See src/lib/claude-path.ts.
    // DREAMCONTEXT_DEVELOP_LEAD arms the hook's lead-edit backstop (lib/develop-lead-guard.ts)
    // for a Develop chat's lead only. ALWAYS set, to '1' or '', so a value the server itself
    // inherited can never leak into another mode. DREAMCONTEXT_CHAT_TAB (same rule) arms the
    // UserPromptSubmit reminder to name the tab (lib/chat-tab-title-nudge.ts); the Assistant
    // has no tab to name.
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
    sessionId: pinId || randomUUID(),
    conversationId: heldConversation || null,
    vault: opts.vault ?? basename(projectRoot),
    mode,
    ...(delegated ? { origin: 'assistant' as const } : {}),
    seed,
  });
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
   */
  let turnsInFlight = 0;
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

  /** The owning device was signed out: close its socket (4401) and end what it started. */
  let deviceRevoked = false;
  const revokeForDevice = (): void => {
    if (deviceRevoked) return;
    deviceRevoked = true;
    endOnSocketGone = true;
    try { ws.close(DEVICE_REVOKED_CLOSE, 'device signed out'); } catch { /* gone */ }
    void cutChild().catch(() => { /* already gone */ });
  };
  const deviceSession = { device: () => ownerDevice, revoke: revokeForDevice };
  if (ownerDevice) {
    armDeviceRevocation();
    cloudDeviceSessions.add(deviceSession);
  }

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
    adopt: (next) => adoptSocket(next),
    supersede: () => supersedeLive(),
    cut: () => cutChild(),
    pid: child.pid,
  } : null;
  if (live) registerLiveChat(live);
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
  const closeTurn = (): void => {
    turnsInFlight = Math.max(0, turnsInFlight - 1);
    if (turnsInFlight === 0) {
      outstandingAsks.clear();
      if (live) markTurnEnded(live);
      // A restart owed since mid-turn may go now: say so with `turnInFlight: false`.
      reannounceSwitch();
    }
    armDetachReap();
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
  const writeStdin = (obj: unknown): void => {
    if (!alive) return;
    try { child.stdin.write(JSON.stringify(obj) + '\n'); }
    catch { /* stream torn down between the alive check and the write — best-effort */ }
  };

  /** Hand one OWNER message to the CLI as a turn — the socket's user frame, and a held message
   *  released by `releaseStalledSwitch`. */
  const writeOwnerTurn = (text: string): void => {
    openTurn();
    lastSentText = text;
    registry?.userSent(text);
    // The Assistant hears what is happening right now with every owner turn: a second,
    // server-written block whose only project text is each chat's fenced `topic:`
    // (live-context.ts), dropped from the replay because it starts with `<`.
    const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text }];
    if (isAssistant) {
      const live = assistantLiveContext();
      if (live) content.push({ type: 'text', text: live });
    }
    writeStdin({ type: 'user', message: { role: 'user', content } });
  };

  const sendMeta = (frame: Record<string, unknown>): void => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify({ type: '_meta', ...frame })); } catch { /* closing */ }
    }
  };

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
    if (!alive) return;
    alive = false;
    cloudDeviceSessions.delete(deviceSession);
    // A gone child cannot be mid-turn. `armAccountSwitch` checks `exited` too, but leaving a
    // stale count here would be a lie about the one thing only this side can report.
    turnsInFlight = 0;
    clearInterruptTimers();
    clearLingerTimers();
    clearDetachTimers();
    if (switchStallTimer) { clearTimeout(switchStallTimer); switchStallTimer = null; }
    stopPing();
    if (live) unregisterLiveChat(live);
    untrack();
    releaseHeld();
    cleanupDeferred();
    cleanupBriefing();
    cleanupAgents();
    cleanupModeNote();
    envelope?.dispose();
    unwatchAuth();
    registry?.exited();
    // A respawn in place hands the notch's surface to its successor on the same socket.
    if (!handedOff) disposeSurface();
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
      try { child.kill(); } catch { /* already gone */ }
      lingerKillTimer = setTimeout(() => {
        lingerKillTimer = null;
        if (!alive) return;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
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
    ws.on('message', onWsMessage);
    ws.on('close', onSocketGone);
    ws.on('error', onSocketGone);
    startPing();
  }

  /** A client's reattach: bind `next` to this very child. False when the child can no longer
   *  be adopted (exiting, draining, or handing off) — the caller then spawns a resume. */
  function adoptSocket(next: import('ws').WebSocket): boolean {
    if (!alive || lingerTimer || lingerKillTimer || handedOff || deviceRevoked) return false;
    const prev = ws;
    prev.off('message', onWsMessage);
    prev.off('close', onSocketGone);
    prev.off('error', onSocketGone);
    // A late error on the abandoned socket must not throw for want of a listener.
    prev.on('error', () => { /* abandoned socket */ });
    // Still "open" means half-open: the client already moved to `next`.
    if (prev !== next && prev.readyState === prev.OPEN) {
      try { if (typeof prev.terminate === 'function') prev.terminate(); else prev.close(); } catch { /* gone */ }
    }
    stopPing();
    ws = next;
    ownerDevice = socketDevice.get(next) ?? ownerDevice;
    detached = false;
    clearDetachTimers();
    bindSocket();
    // Tells the client it got the SAME process back and whether a turn is still running —
    // what it missed meanwhile it replays from chat-history.
    sendMeta({ subtype: 'reattached', adopted: true, busy: turnsInFlight > 0 });
    if (activeAccountId) sendMeta({ subtype: 'account_active', accountId: activeAccountId });
    for (const line of outstandingAsks.values()) {
      try { ws.send(line); } catch { /* closing */ }
    }
    if (handoffRun) sendMeta(handoffProgressFrame(handoffRun));
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

      // Light local parse (type/subtype only — full typed parsing is the CLIENT's job,
      // chatProtocol.ts) so the server knows when an interrupt has actually resolved.
      // Never throws on non-JSON/partial lines.
      let obj: Record<string, unknown> | null = null;
      try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { /* partial line */ }
      if (!obj) continue;

      registry?.observe(obj);

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
      if (handoffRun) setHandoffRun(advanceHandoffRun(handoffRun, obj, turnsInFlight));
      if (obj.type === 'assistant' && !obj.parent_tool_use_id) {
        const used = contextTokensFromUsage((obj.message as { usage?: Record<string, unknown> } | undefined)?.usage);
        if (used > 0) lastMainContext = used;
      }

      if (obj.type === 'result' && obj.parent_tool_use_id === undefined) {
        closeTurn();
        // An autonomy change waited for this boundary.
        // Through scheduleRespawn, never straight to respawnInPlace: a message may still be
        // deciding in the switch gate (an account probe takes seconds), and ending stdin under
        // it would lose it.
        if (respawnTo !== null && turnsInFlight === 0) setImmediate(scheduleRespawn);

        // ── Context handoff: rotate this pane into a fresh session ────────────
        //
        // The agent ran `dreamcontext tasks handoff <slug>`, which wrote a record
        // keyed by THIS pane. A turn boundary is the only safe place to act on it:
        // `/clear` mid-turn would discard work the agent is still producing.
        //
        // `actedAt` is the idempotency latch and this is the ONLY writer of it (the
        // SessionStart hook owns `consumedAt`, and neither touches the other's
        // field). Without it, every subsequent result frame in the pane would see
        // the same record and clear again — an infinite rotation loop.
        //
        // The STEP 0 spike verified the mechanism on CLI 2.1.261: `/clear` sent as a
        // stream-json USER frame rotates the conversation in-process and fires
        // SessionStart with `source=clear` and a new transcript. So no respawn is
        // needed, and the pane's websocket, pinned id and tab env all survive.
        try {
          const handoffPane = pinId;
          const pending = handoffPane ? readHandoffRecord(contextRoot, handoffPane) : null;
          if (shouldRotateForHandoff(pending) && pending) {
            stampHandoffRecord(contextRoot, handoffPane, { actedAt: new Date().toISOString() });

            // Both are USER frames, so both open turns — counted for the same reason
            // the opening prompt and `/effort` are (see turnsInFlight's header).
            openTurn();
            writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/clear' }] } });

            const continuePrompt = `Handoff: continue task ${pending.title} (${pending.task}). `
              + `Read _dream_context/state/${pending.task}.md first, then carry on from its latest changelog entry.`;
            openTurn();
            writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: continuePrompt }] } });

            // Its own frame, not the branch notice's one-liner: the chat draws the run as it
            // happens (handoff-progress.ts), so "it is happening" is on screen from now on
            // rather than a sentence sent after it was over.
            setHandoffRun(startHandoffRun({
              task: pending.task,
              title: pending.title,
              contextTokens: pending.contextTokens ?? lastMainContext,
              fromSession: observedConversation,
            }));
          }
        } catch (handoffErr) {
          // A failed rotation must leave the pane exactly as it was — still usable,
          // just not rotated. The agent can always hand off again.
          const message = (handoffErr as Error).message;
          const failed = handoffRun ? failHandoffRun(handoffRun, message) : null;
          if (failed) setHandoffRun(failed);
          else sendMeta(handoffProgressFrame({ id: Date.now(), stage: 'failed', task: '', title: '', message }));
        }
      }

      // The API REFUSED this turn. Read before anything else acts on the frame, because this
      // is the only account signal on the whole surface that is an observation rather than a
      // forecast — see `claude-limit-signal.ts` for the frame and why the forecast alone was
      // not enough. `onLimitRejected` writes the refusal down and moves the turn; it does
      // nothing at all when there is nowhere to move it to.
      //
      // A SUB-AGENT's rejection counts too, and deliberately so: it drew on the same account
      // quota, and the main turn it belongs to is about to fail for the same reason.
      const limit = readLimitSignal(obj);
      if (limit) onLimitRejected(limit);
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
    cause: 'limit_near' | 'needs_relogin' | 'limit_hit' | 'limit_known',
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
      const dir = acc.configDir ?? homedir();
      if (dir === accountConfigDir) return { ...activeReading, id: acc.id };
      const outcome = await probeAccountForDecision(dir);
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
    const target = accounts.find((a) => a.id === choice.accountId)!;
    switchPending = true;
    recordAccountSwitch({
      fromAccountId: activeAccountId, toAccountId: target.id,
      vault: isAssistant ? null : (opts.vault ?? basename(projectRoot)),
      sessionId: isAssistant ? null : registry?.sessionId ?? null,
      until: previousResetAt ?? null,
    });
    heldTexts = resubmit && text ? [text] : [];
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

    // The turn that was refused may not be one WE sent: a background task finishing, or a
    // sub-agent, starts a turn inside the CLI with no user frame from us. That turn has nothing
    // to resubmit — but the pane still moves NOW, while it is idle, instead of leaving the next
    // message to walk into the same wall first. (`lastSentText` is cleared at every turn end,
    // so it can no longer hand an hours-old message to a refusal it has nothing to do with.)
    const text = lastSentText;

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
    const activeProbe = await probeAccountForDecision(accountConfigDir);
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
    if (switchStallTimer) { clearTimeout(switchStallTimer); switchStallTimer = null; }
    ws.off('message', onWsMessage);
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
      try { child.kill(); } catch { /* already gone */ }
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
  function onWsMessage(raw: Buffer | string): void {
    if (!alive) return;
    // Defence in depth (AC3): a frame from a device that is no longer signed in acts on nothing.
    if (ownerDevice && !handsfreeAuth().store.isValidDeviceHash(ownerDevice)) { revokeForDevice(); return; }
    const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
    let msg: {
      type?: string; text?: string; requestId?: string; behavior?: string; updatedInput?: unknown;
      message?: string; model?: string; effort?: string; targetUuid?: string; mode?: string;
      taskId?: string; enabled?: boolean;
    };
    try { msg = JSON.parse(str); } catch { return; } // malformed control frame — ignore

    // The client is closing this pane on purpose (a closed tab, a respawn): the socket's close
    // that follows ends the child as it always did, instead of detaching it for a reattach.
    if (msg.type === 'end') { endOnSocketGone = true; return; }

    if (msg.type === 'user' && typeof msg.text === 'string' && msg.text) {
      if (isCloud() && cloudPhase() !== 'active') {
        // Quiescing: no new turn starts (the return snapshot must not move under it).
        try { ws.send(JSON.stringify({ type: 'dc_meta', subtype: 'error', code: 'cloud_quiescing', message: 'Your laptop is taking this project back; this message was not sent.' })); } catch { /* closing */ }
        return;
      }
      recordCloudAction(); // D14: a send or a steer
      // An autonomy respawn is waiting for the running turn to end: the owner's next message
      // is for the successor — it must not run under the old permissions. (Only user frames:
      // an answer or an interrupt belongs to the turn in flight.)
      if (respawnTo !== null) { holdForSuccessor(raw); return; }
      // Auto-switch evaluates BEFORE the turn goes to the CLI — the whole point is that the
      // message does not have to fail first. `maybeSwitchAccount` either sends the turn on
      // this account (the overwhelmingly common answer, and the answer whenever anything is
      // uncertain) or holds it and asks the client to restart on another account.
      const text = msg.text;
      // The OWNER spoke on the Assistant's socket: whatever project text it read before is
      // now behind a human turn, so the taint clears (autonomy.ts).
      if (isAssistant) clearTaint();
      // Appended to the chain, never fired concurrently — see `switchGate`.
      switchGate = switchGate.then(() => maybeSwitchAccount(text)
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
    if (msg.type === 'setPermissionMode' && !isAssistant && !scopedCard && (msg.mode === 'auto' || msg.mode === 'bypass')) {
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
      recordCloudAction(); // D14: answering the agent is the owner acting
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

    if (msg.type === 'interrupt') {
      recordCloudAction(); // D14: a stop is the owner acting
      // Empirically verified against claude 2.1.218 (scratch-dir experiment): a
      // control_request{subtype:'interrupt'} on stdin aborts the in-flight turn — the CLI
      // echoes a control_response, emits a synthetic rejected tool_result + "[Request
      // interrupted by user for tool use]", then a `result` frame with
      // terminal_reason:"aborted_tools", all within ~4.1s API duration. `system:init`
      // advertises this as the `interrupt_receipt_v1` capability.
      writeStdin({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
      clearInterruptTimers();
      interruptWatchdog = setTimeout(() => {
        interruptWatchdog = null;
        if (!alive) return;
        try { child.kill('SIGINT'); } catch { /* already gone */ }
        interruptKillTimer = setTimeout(() => {
          interruptKillTimer = null;
          if (!alive) return;
          try { child.kill(); } catch { /* already gone */ }
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

/** A transcript, read as dcuser in the cloud (the CLI writes them 0600 there). */
async function readTranscript(path: string): Promise<string> {
  if (isCloud()) return (await readFileAsWorker(path)).toString('utf-8');
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

  // In the cloud the CLI writes these files as dcuser under /tmp/claude-<dcuser uid>/: the path
  // is derived from the READER's uid, so the whole read runs in the dcuser worker.
  if (isCloud()) {
    try {
      sendJson(res, 200, await runWorkerOp({ op: 'read', params: { kind: 'bg-output', contextRoot, query: { taskId, claudeId } }, timeoutMs: 30_000 }));
    } catch {
      sendJson(res, 200, { taskId, content: '', size: 0, truncated: false, exists: false });
    }
    return;
  }
  sendJson(res, 200, computeBackgroundOutput(contextRoot, taskId, claudeId));
}

/** The tail of one background shell's output (also run inside the cloud's dcuser worker). */
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
  /** The hands-free cloud passes false: project root only, grants refused (its grants file
   *  lives in dcuser's tree, so an agent could plant one). */
  opts: { grants: boolean } = { grants: true },
): { abs: string } | { deny: 'invalid' | 'needs_grant' | 'outside'; abs?: string } {
  const ref = resolveChatReference(contextRoot ? projectRootOf(contextRoot) : null, contextRoot, rawPath);
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
  let outside = ref.outside;
  if (contextRoot) {
    try {
      outside = !isInside(realpathSync.native(projectRootOf(contextRoot)), realpathSync.native(ref.abs));
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

  if (isCloud()) { await serveAgentFileCloud(req, res, rawPath, contextRoot, url.searchParams.get('raw') === '1'); return; }

  const resolved = resolveServablePath(contextRoot, rawPath);
  if ('deny' in resolved) {
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
  const abs = resolved.abs;
  if (!existsSync(abs)) { sendError(res, 404, 'not_found', `File not found: ${rawPath}`); return; }

  let st: ReturnType<typeof statSync>;
  try { st = statSync(abs); } catch { sendError(res, 404, 'not_found', `File not found: ${rawPath}`); return; }

  // A DIRECTORY answers with its listing — a folder named in the transcript is something to
  // look inside, not an error.
  if (st.isDirectory()) { sendDirListing(res, rawPath, abs); return; }
  if (!st.isFile()) { sendError(res, 404, 'not_found', `Not a file: ${rawPath}`); return; }

  const ext = extname(abs).toLowerCase();
  const rawType = AGENT_FILE_RAW_CONTENT_TYPE[ext];
  const wantsRaw = url.searchParams.get('raw') === '1';

  // AN SVG, AS AN IMAGE — for the Lightbox's `<img>` (Chat and the Agents page both open an
  // `.svg` there). An `<img>` never executes an SVG's script; `sandbox` plus `default-src
  // 'none'` makes the same URL inert if it is navigated to directly (scripts off, opaque
  // origin, nothing fetched); `nosniff` is set above. Capped like a text preview: an SVG is
  // markup, and a huge one is a generated artifact, not a picture.
  if (wantsRaw && ext === '.svg') {
    if (st.size > AGENT_FILE_MAX_BYTES) { sendError(res, 413, 'too_large', 'File exceeds the preview size cap.'); return; }
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    serveMedia(req, res, abs, st.size, 'image/svg+xml');
    return;
  }

  if (wantsRaw && rawType) {
    if (st.size > AGENT_MEDIA_MAX_BYTES) { sendError(res, 413, 'too_large', 'File is too large to stream.'); return; }
    // A document is DISPLAYED, never downloaded: without this an engine that has no built-in
    // viewer for the type falls back to saving it, which from the user's side reads as "the
    // viewer opened and nothing happened, and now there's a file in Downloads". `nosniff` is
    // already set above, and the type is ours (from the extension), not the client's.
    if (AGENT_FILE_DOC_CONTENT_TYPE[ext]) res.setHeader('Content-Disposition', 'inline');
    serveMedia(req, res, abs, st.size, rawType);
    return;
  }

  // Text preview keeps the tight cap: this branch reads the whole file into a JSON body.
  if (st.size > AGENT_FILE_MAX_BYTES) { sendError(res, 413, 'too_large', 'File exceeds the preview size cap.'); return; }
  let content: string;
  try { content = readFileSync(abs, 'utf-8'); } catch { sendError(res, 500, 'read_failed', 'Failed to read file.'); return; }
  sendJson(res, 200, { path: rawPath, type: ext === '.md' ? 'markdown' : 'text', content });
}

/** Raw media the cloud streams through the worker is buffered: capped well below the desktop's. */
const CLOUD_MEDIA_MAX_BYTES = 32 * 1024 * 1024;

export type CloudFileRead =
  | { kind: 'dir'; entries: Array<{ name: string; kind: 'dir' | 'file'; size: number | null }>; total: number; truncated: boolean }
  | { kind: 'file'; size: number; base64?: string }
  | { kind: 'refused'; status: number; code: string; message: string };

/**
 * One read of the hands-free cloud's file route, run INSIDE the dcuser worker (dcuser cannot
 * open dcserver's 0700 files at all). Project root only, grants refused; the final path must
 * not be a symlink, its parent's realpath must be inside the project's realpath, and the file
 * is opened O_NOFOLLOW and checked with fstat on that very fd.
 */
export function cloudFileRead(contextRoot: string, rawPath: string, want: 'meta' | 'read', maxBytes: number): CloudFileRead {
  const resolved = resolveServablePath(contextRoot, rawPath, { grants: false });
  if ('deny' in resolved) {
    if (resolved.abs) {
      try {
        if (lstatSync(resolved.abs).isSymbolicLink()) return { kind: 'refused', status: 403, code: 'symlink_refused', message: 'A symlink is not opened on the cloud machine.' };
      } catch { /* absent: the refusal below */ }
    }
    return resolved.deny === 'outside'
      ? { kind: 'refused', status: 403, code: 'outside_project', message: 'Only files inside the project can be opened on the cloud machine.' }
      : { kind: 'refused', status: 400, code: 'invalid_path', message: 'That path cannot be read.' };
  }
  const abs = resolved.abs;
  const notFound: CloudFileRead = { kind: 'refused', status: 404, code: 'not_found', message: `File not found: ${rawPath}` };
  let lst: ReturnType<typeof lstatSync>;
  try { lst = lstatSync(abs); } catch { return notFound; }
  if (lst.isSymbolicLink()) return { kind: 'refused', status: 403, code: 'symlink_refused', message: 'A symlink is not opened on the cloud machine.' };
  try {
    const root = realpathSync.native(projectRootOf(contextRoot));
    // A folder (never a link here) is checked itself, so the project root folder passes; a
    // file through its parent, so the leaf is never followed.
    const parent = realpathSync.native(lst.isDirectory() ? abs : dirname(abs));
    if (parent !== root && !isInside(root, parent)) return { kind: 'refused', status: 403, code: 'outside_project', message: 'Only files inside the project can be opened on the cloud machine.' };
  } catch { return notFound; }
  if (lst.isDirectory()) {
    const MAX_ENTRIES = 300;
    let names: string[];
    try { names = readdirSync(abs); } catch { return { kind: 'refused', status: 500, code: 'read_failed', message: 'Failed to read the folder.' }; }
    const entries = names.slice(0, MAX_ENTRIES).map((name) => {
      try {
        const st = lstatSync(join(abs, name));
        return { name, kind: st.isDirectory() ? 'dir' as const : 'file' as const, size: st.isDirectory() ? null : st.size };
      } catch {
        return { name, kind: 'file' as const, size: null };
      }
    });
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    return { kind: 'dir', entries, total: names.length, truncated: names.length > MAX_ENTRIES };
  }
  if (!lst.isFile()) return { kind: 'refused', status: 404, code: 'not_found', message: `Not a file: ${rawPath}` };
  let fd: number;
  try { fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { return { kind: 'refused', status: 403, code: 'symlink_refused', message: 'That file cannot be opened.' }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== lst.ino || st.dev !== lst.dev) return { kind: 'refused', status: 409, code: 'changed', message: 'The file changed while it was opened.' };
    if (want === 'meta') return { kind: 'file', size: st.size };
    if (st.size > maxBytes) return { kind: 'refused', status: 413, code: 'too_large', message: 'File exceeds the size cap.' };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    return { kind: 'file', size: got, base64: buf.subarray(0, got).toString('base64') };
  } finally {
    closeSync(fd);
  }
}

/** The cloud's GET /api/agent/file: every byte read as dcuser (cloudFileRead in the worker). */
async function serveAgentFileCloud(req: IncomingMessage, res: ServerResponse, rawPath: string, contextRoot: string, wantsRaw: boolean): Promise<void> {
  const ext = extname(rawPath).toLowerCase();
  const rawType = AGENT_FILE_RAW_CONTENT_TYPE[ext];
  const raw = wantsRaw && (ext === '.svg' || !!rawType);
  const maxBytes = raw && ext !== '.svg' ? CLOUD_MEDIA_MAX_BYTES : AGENT_FILE_MAX_BYTES;
  let r: CloudFileRead;
  try {
    r = await runWorkerOp<CloudFileRead>({ op: 'read', params: { kind: 'agent-file', contextRoot, query: { path: rawPath, want: 'read', maxBytes: String(maxBytes) } }, timeoutMs: 60_000 });
  } catch {
    sendError(res, 500, 'read_failed', 'Failed to read file.');
    return;
  }
  if (r.kind === 'refused') { sendError(res, r.status, r.code, r.message); return; }
  if (r.kind === 'dir') { sendJson(res, 200, { path: rawPath, type: 'dir', entries: r.entries, truncated: r.truncated, total: r.total }); return; }
  const buf = Buffer.from(r.base64 ?? '', 'base64');
  if (raw) {
    if (ext === '.svg') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (ext === '.svg' || AGENT_FILE_DOC_CONTENT_TYPE[ext]) res.setHeader('Content-Disposition', 'inline');
    res.writeHead(200, { 'Content-Type': ext === '.svg' ? 'image/svg+xml' : rawType, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return;
  }
  sendJson(res, 200, { path: rawPath, type: ext === '.md' ? 'markdown' : 'text', content: buf.toString('utf-8') });
}

/** The board-assets read for the cloud's worker: project root only, grants refused. */
export async function computeBoardAssetsCloud(contextRoot: string, rawPath: string): Promise<{ files: unknown }> {
  const r = cloudFileRead(contextRoot, rawPath, 'read', AGENT_FILE_MAX_BYTES * 8);
  if (r.kind === 'refused') throw Object.assign(new Error(r.message), { code: r.code, status: r.status });
  if (r.kind !== 'file') throw Object.assign(new Error(`Board not found: ${rawPath}`), { code: 'not_found', status: 404 });
  const resolved = resolveServablePath(contextRoot, rawPath, { grants: false }) as { abs: string };
  const boardDir = dirname(resolved.abs);
  const files = await resolveBoardAssets(Buffer.from(r.base64 ?? '', 'base64').toString('utf-8'), [
    projectRootOf(contextRoot), contextRoot, boardDir, join(boardDir, 'assets'), join(boardDir, 'Attachments'),
  ], rawPath);
  return { files };
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

  if (isCloud()) {
    // The board and its images are dcuser's files: the whole read runs in the worker, project
    // root only (grants refused).
    try {
      sendJson(res, 200, await runWorkerOp({ op: 'read', params: { kind: 'board-assets', contextRoot, query: { path: rawPath } }, timeoutMs: 60_000 }));
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      sendError(res, e.status && e.status < 500 ? e.status : 404, e.code ?? 'not_found', e.message ?? `Board not found: ${rawPath}`);
    }
    return;
  }
  const resolved = resolveServablePath(contextRoot, rawPath);
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

  if (!target.startsWith('/') || target.includes('\0') || target.includes('/../') || target.endsWith('/..')) {
    sendError(res, 400, 'invalid_path', 'An absolute, literal file path is required.');
    return;
  }
  let st: ReturnType<typeof statSync>;
  try { st = statSync(target); } catch { sendError(res, 404, 'not_found', `File not found: ${target}`); return; }
  if (!st.isFile()) { sendError(res, 400, 'not_a_file', 'Only a file can be granted, not a folder.'); return; }

  addGrant(contextRoot, target);
  sendJson(res, 200, { granted: true, path: target });
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
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { path?: unknown; mode?: unknown };
    if (typeof body.path === 'string') target = body.path;
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
  const ref = resolveChatReference(contextRoot ? projectRootOf(contextRoot) : null, contextRoot, target);
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
    spawn(opener.cmd, opener.args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    sendError(res, 500, 'open_failed', 'The system opener could not be started.');
    return;
  }
  sendJson(res, 200, { opened: true, mode: openDirectly ? 'open' : 'reveal' });
}
