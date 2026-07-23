import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, rmSync } from 'node:fs';
import { isDesktop } from '../desktop.js';
import { trackChild } from '../lifecycle.js';
import { resolveAgentSession } from '../../lib/agent-session-map.js';
import {
  isLoopback, rejectUpgrade, resolveVaultProjectRoot, projectRootOf,
  sanitizeUuid, sanitizeModel, sanitizeEffort, sanitizePrompt,
  claudeConversationExists, redeemPromptToken,
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

/** Conversation ids currently attached to a live chat process in THIS server. Prevents
 *  two chat sessions from double-attaching the same conversation (a Claude conversation
 *  must have at most one writer). Does NOT know about the terminal route's own Set —
 *  a chat and a terminal resuming the SAME conversation concurrently is a known beta
 *  limitation (see the task's Constraints), not something this guards against. */
const liveConversations = new Set<string>();

// ─── Permission mode (identical rule to the terminal — agent-terminal.ts:1206) ────────

/** No-bypass chat maps to Auto (`acceptEdits`); bypass maps to `bypassPermissions` —
 *  the same two-mode contract the embedded terminal uses. Exported pure so it is
 *  unit-testable in isolation (AC11's permission-mode mapping test). */
export function permissionModeFor(bypass: boolean): 'bypassPermissions' | 'acceptEdits' {
  return bypass ? 'bypassPermissions' : 'acceptEdits';
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
  // the first USER stdin frame once `system:init` is observed (see the stdout handler
  // below) — there is no shell positional/argv equivalent in stream-json input mode, so
  // this is chat's version of the terminal's auto-submit-on-boot.
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

  const argv = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', permissionModeFor(bypass),
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
    env: { ...process.env, ...tabEnv, ...deferredEnv } as Record<string, string>,
  });

  // Liveness guard (mirrors agent-terminal.ts:1408's `if (!alive) return;`): a stale
  // answer/interrupt frame arriving after the child has exited must never throw on a
  // destroyed stdin stream.
  let alive = true;
  let sawInit = false;
  let initPromptSent = false;
  let interruptWatchdog: ReturnType<typeof setTimeout> | null = null;
  let interruptKillTimer: ReturnType<typeof setTimeout> | null = null;

  const untrack = trackChild(child);

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

  const teardown = (): void => {
    if (!alive) return;
    alive = false;
    clearInterruptTimers();
    untrack();
    releaseHeld();
    cleanupDeferred();
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
      // chatProtocol.ts) so the server knows WHEN to send the initial prompt and when an
      // interrupt has actually resolved. Never throws on non-JSON/partial lines.
      let obj: Record<string, unknown> | null = null;
      try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { /* partial line */ }
      if (!obj) continue;

      if (!sawInit && obj.type === 'system' && obj.subtype === 'init') {
        sawInit = true;
        if (submitPrompt && !initPromptSent) {
          initPromptSent = true;
          writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: submitPrompt }] } });
        }
      }

      // An interrupt resolves either as a `result` frame or the CLI's own control_response
      // acking the interrupt request — either is "the turn is winding down", so disarm the
      // escalation watchdog (the child's own exit is still tracked separately below).
      if (interruptWatchdog && (obj.type === 'result' || obj.type === 'control_response')) {
        clearInterruptTimers();
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
    let msg: { type?: string; text?: string; requestId?: string; behavior?: string; updatedInput?: unknown; message?: string };
    try { msg = JSON.parse(str); } catch { return; } // malformed control frame — ignore

    if (msg.type === 'user' && typeof msg.text === 'string' && msg.text) {
      writeStdin({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: msg.text }] } });
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
