import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeFileSync, rmSync, readFileSync, existsSync, statSync, readdirSync, createReadStream,
  realpathSync, openSync, readSync, closeSync,
} from 'node:fs';
import { sendJson, sendError } from '../middleware.js';
import { serveMedia } from '../media.js';
import { isDesktop } from '../desktop.js';
import { trackChild } from '../lifecycle.js';
import { resolveAgentSession } from '../../lib/agent-session-map.js';
import { safeChildPath } from '../safe-path.js';
import { resolveChatReference } from '../chat-reference-path.js';
import { CHAT_SURFACE_BRIEFING } from '../chat-surface.js';
import { claudeAwarePath } from '../../lib/claude-path.js';
import { resolveBoardAssets } from './knowledge.js';
import {
  isLoopback, rejectUpgrade, resolveVaultProjectRoot, projectRootOf,
  sanitizeUuid, sanitizeModel, sanitizeEffort, sanitizePrompt,
  claudeConversationExists, redeemPromptToken, findFirstTranscriptPath,
} from './agent-spawn-shared.js';

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

/** Conversation ids currently attached to a live chat process in THIS server. Prevents
 *  two chat sessions from double-attaching the same conversation (a Claude conversation
 *  must have at most one writer). Does NOT know about the terminal route's own Set —
 *  a chat and a terminal resuming the SAME conversation concurrently is a known beta
 *  limitation (see the task's Constraints), not something this guards against. */
const liveConversations = new Set<string>();

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

// ─── WS upgrade ─────────────────────────────────────────────────────────────────────

/**
 * Attach the agent-chat WebSocket upgrade handler to the shared http server.
 * Path: `/api/agent/chat?vault=<name>&bypass=0|1&(sessionId|resume)=<uuid>&model=<alias>
 * &effort=<lvl>&promptToken=<token>&prompt=<inline>&deferPrompt=0|1`. No-ops (rejects the
 * upgrade) unless the desktop gate is on and the request is loopback.
 */
export function attachAgentChat(server: Server): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url || '/', `http://${req.headers.host}`); }
    catch { socket.destroy(); return; }
    if (url.pathname !== '/api/agent/chat') return; // not ours — leave for others

    if (!isDesktop() || !isLoopback(req)) { rejectUpgrade(socket, 403); return; }

    const vault = url.searchParams.get('vault');
    const projectRoot = resolveVaultProjectRoot(vault);
    if (!projectRoot) { rejectUpgrade(socket, 400); return; }

    const bypass = url.searchParams.get('bypass') === '1';
    const sessionId = sanitizeUuid(url.searchParams.get('sessionId'));
    const resumeId = sanitizeUuid(url.searchParams.get('resume'));
    const model = sanitizeModel(url.searchParams.get('model'));
    const effort = sanitizeEffort(url.searchParams.get('effort'));

    // Prompt hand-off (AC3 parity with the terminal — see agent-spawn-shared.ts): a
    // SUPPLIED-BUT-INVALID token rejects the upgrade rather than silently opening an
    // unseeded session (a bad token is exactly the failure the token exists to prevent).
    const redeemed = redeemPromptToken(url.searchParams.get('promptToken'), vault);
    if (redeemed === null) { rejectUpgrade(socket, 401); return; }
    const initialPrompt = redeemed || sanitizePrompt(url.searchParams.get('prompt'));
    const deferPrompt = url.searchParams.get('deferPrompt') === '1';

    void (async () => {
      let WebSocketServer: typeof import('ws').WebSocketServer;
      try { ({ WebSocketServer } = await import('ws')); }
      catch { rejectUpgrade(socket, 501); return; }

      const wss = new WebSocketServer({ noServer: true });
      wss.handleUpgrade(req, socket, head, (ws) => {
        startChatSession(ws, projectRoot, { bypass, sessionId, resumeId, model, effort, initialPrompt, deferPrompt });
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
  initialPrompt: string;
  deferPrompt: boolean;
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

function startChatSession(
  ws: import('ws').WebSocket,
  projectRoot: string,
  opts: ChatSpawnOpts,
): void {
  const { bypass, sessionId, resumeId, model, effort, initialPrompt, deferPrompt } = opts;
  const contextRoot = join(projectRoot, '_dream_context');

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
  const heldConversation = resumeTarget || freshPin;
  if (heldConversation) liveConversations.add(heldConversation);
  let releaseHeld = () => {
    releaseHeld = () => { /* once */ };
    if (heldConversation) liveConversations.delete(heldConversation);
  };

  // Deferred initial prompt (Task Manager contract — "the user speaks first"): mirrors
  // agent-terminal.ts's parking pattern exactly. A non-deferred prompt is instead sent as
  // the first USER stdin frame IMMEDIATELY after spawn — empirically (CLI 2.1.218), in
  // stream-json input mode the CLI emits `system:init` only AFTER the first stdin frame
  // arrives, so gating the prompt on init deadlocks a delegated session forever (stdin
  // frames queue safely pre-init; sleepy-chat.ts has always written first, same as here).
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
  try {
    const brief = join(tmpdir(), `dreamcontext-chat-surface-${randomUUID()}.md`);
    // Our own filename, but `tmpdir()` comes from TMPDIR — the one argv element below that
    // isn't a fixed literal or a whitelist-sanitized token. Hold it to the same standard
    // (see the quoting note on `script`): a tmpdir carrying a shell metacharacter drops the
    // briefing rather than reaching the command line.
    if (!isShellSafePath(brief)) throw new Error('unsafe tmpdir');
    writeFileSync(brief, CHAT_SURFACE_BRIEFING, { encoding: 'utf-8', mode: 0o600 });
    briefingArg = ['--append-system-prompt-file', brief];
    cleanupBriefing = () => { try { rmSync(brief, { force: true }); } catch { /* tmp cleanup */ } };
  } catch { /* no briefing this session — the chat still works, just terminal-flavoured */ }

  const argv = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', permissionModeFor(bypass),
    ...briefingArg,
    ...idArg,
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
  ];
  // Quoted for the login-shell script string exactly like the terminal/title/capture
  // spawns: every element here is either a fixed flag literal or a whitelist-sanitized
  // value (UUID / model alias / effort level), so plain double-quoting is sufficient —
  // none of them can contain a shell metacharacter.
  const script = `exec claude ${argv.map((a) => `"${a}"`).join(' ')}`;

  // An agent-chat process exports its tab's STABLE roster id so the SessionStart/Stop
  // hooks (which inherit this env through `claude`) record roster id → live conversation
  // id on every rotation — the SAME map the embedded terminal writes/reads (AC7: chat and
  // terminal resume interop through one registry). Only when actually pinned/resumed.
  const tabEnv = pinId && idArg.length
    ? { DREAMCONTEXT_TAB_SESSION: pinId, DREAMCONTEXT_SERVER_PID: String(process.pid) }
    : {};

  const shell = process.env.SHELL || '/bin/zsh';
  const child = spawn(shell, ['-ilc', script], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    // claude-aware PATH: `claude` installs into ~/.local/bin, which no default PATH
    // contains — without this the login shell 127s whenever the install's `export
    // PATH` echo never reached the user's rc. See src/lib/claude-path.ts.
    env: { ...process.env, PATH: claudeAwarePath(), ...tabEnv, ...deferredEnv } as Record<string, string>,
  });

  // Liveness guard (mirrors agent-terminal.ts:1408's `if (!alive) return;`): a stale
  // answer/interrupt frame arriving after the child has exited must never throw on a
  // destroyed stdin stream.
  let alive = true;
  let interruptWatchdog: ReturnType<typeof setTimeout> | null = null;
  let interruptKillTimer: ReturnType<typeof setTimeout> | null = null;

  const untrack = trackChild(child);

  // Auto-submit the (non-deferred) initial prompt as the first stdin frame — see the
  // deferred-prompt note above for why this must NOT wait for `system:init`.
  if (submitPrompt) {
    try {
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

  /** Write one NDJSON line to claude's stdin, guarded by `alive` + a try/catch — a write
   *  raced against child exit must never throw and crash the upgrade handler. */
  const writeStdin = (obj: unknown): void => {
    if (!alive) return;
    try { child.stdin.write(JSON.stringify(obj) + '\n'); }
    catch { /* stream torn down between the alive check and the write — best-effort */ }
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

  // Echo the auto-submitted opening prompt back to the client so the chat transcript SHOWS
  // it as the first user message. The terminal surface gets this for free (the prompt is
  // literally typed into the visible readline); chat writes it straight to the child's
  // stdin, so without this echo a spawn-with-prompt (sleep, brain-resolve, delegate) opened
  // a transcript with nothing in it and read as "the message never got sent". The echo is
  // the server's job, not the client's: with `promptToken` the client never sees the text at
  // all, and a deferred prompt (`deferPrompt`, "the user speaks first") must NOT be echoed —
  // `submitPrompt` is already empty in that case, so both fall out of this one condition.
  if (submitPrompt) sendMeta({ subtype: 'prompt_echo', text: submitPrompt });

  const teardown = (): void => {
    if (!alive) return;
    alive = false;
    clearInterruptTimers();
    untrack();
    releaseHeld();
    cleanupDeferred();
    cleanupBriefing();
  };

  // ── claude stdout → ws (verbatim NDJSON relay) ─────────────────────────────────────
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

      // An interrupt resolves either as a `result` frame or the CLI's own control_response
      // acking the interrupt request — either is "the turn is winding down", so disarm the
      // escalation watchdog (the child's own exit is still tracked separately below).
      if (interruptWatchdog && (obj.type === 'result' || obj.type === 'control_response')) {
        clearInterruptTimers();
      }

      // Refresh the project's slash-command cache from the authoritative source every time
      // the CLI reports one, so a NEW session can be handed the list before its first turn
      // (see the cache's header note for why the stream alone can't do that).
      if (obj.type === 'system' && obj.subtype === 'init' && Array.isArray(obj.slash_commands)) {
        const list = obj.slash_commands.filter((c): c is string => typeof c === 'string' && !!c);
        if (list.length) writeSlashCache(contextRoot, list);
      }
    }
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4000); });

  child.on('error', (err) => {
    teardown();
    sendMeta({ subtype: 'error', message: `Couldn't start claude: ${err.message}` });
    try { ws.close(); } catch { /* already closed */ }
  });

  child.on('close', (code) => {
    teardown();
    sendMeta({ subtype: 'exit', code });
    if (code !== 0 && stderrTail.trim()) {
      sendMeta({ subtype: 'error', message: stderrTail.trim() });
    }
    try { ws.close(); } catch { /* already closed */ }
  });

  // ── ws → claude stdin (client control frames) ──────────────────────────────────────
  ws.on('message', (raw: Buffer | string) => {
    if (!alive) return;
    const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
    let msg: {
      type?: string; text?: string; requestId?: string; behavior?: string; updatedInput?: unknown;
      message?: string; model?: string; effort?: string; targetUuid?: string; mode?: string;
      taskId?: string;
    };
    try { msg = JSON.parse(str); } catch { return; } // malformed control frame — ignore

    if (msg.type === 'user' && typeof msg.text === 'string' && msg.text) {
      writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: msg.text }] } });
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
    if (msg.type === 'setPermissionMode' && (msg.mode === 'auto' || msg.mode === 'bypass')) {
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
        writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `/effort ${effort}` }] } });
      }
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
      return;
    }

    if (msg.type === 'interrupt') {
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
  });

  ws.on('close', teardown);
  ws.on('error', teardown);
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
  if (!isDesktop()) { sendJson(res, 200, { items: [] }); return; }
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
    try { subRaw = readFileSync(subPath, 'utf-8'); } catch { sendJson(res, 200, { items: [] }); return; }
    // `sidechain: true` — this file IS the sub-agent's own transcript, so its universal
    // `isSidechain` marker is what we came for, not a foreign turn to filter out.
    sendJson(res, 200, { items: parseTranscriptHistory(subRaw, { sidechain: true }) });
    return;
  }

  let raw = '';
  try { raw = readFileSync(path, 'utf-8'); } catch { sendJson(res, 200, { items: [] }); return; }
  sendJson(res, 200, { items: parseTranscriptHistory(raw) });
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
  if (!isDesktop()) { sendError(res, 403, 'desktop_only', 'Available only in the desktop app.'); return; }
  if (!contextRoot) { sendError(res, 400, 'no_vault', 'No vault resolved for this request.'); return; }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const taskId = sanitizeBackgroundTaskId(url.searchParams.get('taskId'));
  if (!taskId) { sendError(res, 400, 'invalid_task_id', 'Query parameter "taskId" is required.'); return; }
  const claudeId = sanitizeUuid(url.searchParams.get('claudeId'));
  if (!claudeId) { sendError(res, 400, 'invalid_claude_id', 'Query parameter "claudeId" is required.'); return; }

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
  if (!found) { sendJson(res, 200, { taskId, content: '', size: 0, truncated: false, exists: false }); return; }

  let st: ReturnType<typeof statSync>;
  try { st = statSync(found); } catch { sendJson(res, 200, { taskId, content: '', size: 0, truncated: false, exists: false }); return; }

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
    sendJson(res, 200, { taskId, content: '', size: st.size, truncated: false, exists: true });
    return;
  }

  sendJson(res, 200, { taskId, content, size: st.size, truncated: start > 0, exists: true });
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

/** Extensions servable as raw image bytes via `?raw=1`. SVG is deliberately EXCLUDED — an SVG
 *  can embed `<script>`/`foreignObject`, so it is only ever returned as a TEXT preview (falls
 *  through to the text branch below), never as `image/svg+xml`, even with `raw=1`. */
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
): { abs: string } | { deny: 'invalid' | 'needs_grant'; abs?: string } {
  const ref = resolveChatReference(contextRoot ? projectRootOf(contextRoot) : null, contextRoot, rawPath);
  if (!ref) return { deny: 'invalid' };
  if (!ref.outside) return { abs: ref.abs };
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
  if (!isDesktop()) { sendError(res, 403, 'desktop_only', 'Available only in the desktop app.'); return; }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const rawPath = url.searchParams.get('path');
  if (!rawPath) { sendError(res, 400, 'missing_path', 'Query parameter "path" is required.'); return; }

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
  const mediaType = AGENT_FILE_MEDIA_CONTENT_TYPE[ext];
  const wantsRaw = url.searchParams.get('raw') === '1';

  if (wantsRaw && mediaType) {
    if (st.size > AGENT_MEDIA_MAX_BYTES) { sendError(res, 413, 'too_large', 'File is too large to stream.'); return; }
    serveMedia(req, res, abs, st.size, mediaType);
    return;
  }

  // Text preview keeps the tight cap: this branch reads the whole file into a JSON body.
  if (st.size > AGENT_FILE_MAX_BYTES) { sendError(res, 413, 'too_large', 'File exceeds the preview size cap.'); return; }
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
  if (!isDesktop()) { sendError(res, 403, 'desktop_only', 'Available only in the desktop app.'); return; }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const rawPath = url.searchParams.get('path');
  if (!rawPath) { sendError(res, 400, 'missing_path', 'Query parameter "path" is required.'); return; }

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
 */
export async function handleAgentReveal(
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
  const openDirectly = st.isDirectory() || inertToView;

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
  sendJson(res, 200, { opened: true });
}
