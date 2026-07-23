import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { listVaults } from '../../lib/vaults.js';
import { UUID_RE } from '../../lib/agent-session-map.js';

/**
 * Shared trust-boundary primitives for the two loopback `claude`-spawning surfaces —
 * the embedded PTY terminal (`agent-terminal.ts`) and the headless chat bridge
 * (`agent-chat.ts`). Both are desktop-gated, loopback-only, vault-scoped, and spawn a
 * real `claude` process from strictly-sanitized request input, so the injection
 * guards, the vault resolver, and the prompt hand-off token store live in ONE place —
 * a diverging copy of an injection guard is exactly the kind of drift that turns into
 * a vulnerability later.
 */

// ─── Gating ─────────────────────────────────────────────────────────────────

/** True when the request arrived over the loopback interface — the hard gate every
 *  `claude`-spawning upgrade/route enforces alongside the desktop check. */
export function isLoopback(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

const UPGRADE_REJECT_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  501: 'Not Implemented',
};

/** Reject a WebSocket upgrade with a real HTTP status line (not just a silent close),
 *  so a misconfigured client sees why. */
export function rejectUpgrade(socket: import('node:stream').Duplex, code: number): void {
  socket.write(`HTTP/1.1 ${code} ${UPGRADE_REJECT_TEXT[code] ?? 'Bad Request'}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// ─── Vault / path helpers ───────────────────────────────────────────────────

/** The project directory `claude` should run in (parent of `_dream_context`). */
export function projectRootOf(contextRoot: string): string {
  return contextRoot.endsWith('_dream_context') ? dirname(contextRoot) : contextRoot;
}

/**
 * Strict name-only vault resolver for WebSocket upgrades. The browser WebSocket API
 * cannot set the `X-Dreamcontext-Vault` header, so the upgrade carries `?vault=<name>`.
 * Mirrors `resolveRequestVault` in index.ts: rejects path-shaped / unknown values, never
 * calls resolve() on raw input (confused-deputy guard). Returns the project ROOT.
 */
export function resolveVaultProjectRoot(name: string | null): string | null {
  if (!name) return null;
  if (/[/\\:.\x00]/.test(name)) return null;
  const v = listVaults().find((x) => x.name === name);
  if (!v || !existsSync(v.path)) return null;
  return v.path;
}

// ─── Injection guards (whitelist-sanitize before ANY shell interpolation) ──────

/** Strict UUID gate. Returns the value only when it is a canonical UUID (hex + hyphens,
 *  no shell metacharacters), else '' — so a resume/session id can be interpolated into the
 *  `claude` shell command with zero injection risk. */
export function sanitizeUuid(v: string | null): string {
  return v && UUID_RE.test(v) ? v : '';
}

/** Strict model-token gate. Claude Code's `--model` takes an alias (`opus`/`sonnet`/
 *  `haiku`) or a full model id — all of which are `[A-Za-z0-9._-]`. Anything with a shell
 *  metacharacter, whitespace, or over 64 chars is rejected to '' (no flag), so the value is
 *  safe to interpolate into the `claude` shell command. Never trusts the client. */
export function sanitizeModel(v: string | null): string {
  return v && v.length <= 64 && /^[A-Za-z0-9._-]+$/.test(v) ? v : '';
}

/** Effort-level gate. `claude --effort` accepts exactly this documented set; anything else
 *  (including empty) → '' (no flag), so the value is safe to interpolate unquoted. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function sanitizeEffort(v: string | null): string {
  return v && EFFORT_LEVELS.includes(v) ? v : '';
}

/** Cap on a stored prompt, in CHARACTERS. Applies to the POST body path too: the token
 *  removes the *transport* limit, not the sanity limit. Claude's own readline is the real
 *  consumer and this is already far more than a useful first message. */
export const MAX_PROMPT_CHARS = 8000;

/**
 * Sanitize an auto-submit initial prompt. It is NEVER interpolated into the shell command
 * string — it is passed as the login shell's `$0` positional and referenced as `"$0"` (see
 * `startPtySession` / `startChatSession`), exactly like the headless title/capture spawns, so
 * shell metacharacters can't inject. We only guard against runaway size and strip control
 * chars (a NUL truncates a C arg; a CR/LF passed to Claude's readline as one arg would submit
 * a partial line). Kept as a single logical line: collapse any newlines/tabs to spaces (a bare
 * strip would FUSE the words around a tab), drop other control bytes, cap length.
 */
export function sanitizePrompt(v: string | null): string {
  if (!v) return '';
  return v
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, MAX_PROMPT_CHARS)
    .trim();
}

// ─── Prompt hand-off tokens (the `?prompt=` escape hatch) ─────────────────────
//
// The initial prompt USED to ride the WS upgrade URL as `&prompt=<encoded>`, which puts it
// in the HTTP REQUEST LINE. Node caps the request line + all headers at
// `--max-http-header-size` (16384 bytes by default), and overflow is silent and total: the
// parser destroys the socket with HPE_HEADER_OVERFLOW *before* the `upgrade` handler ever
// runs. No PTY/process, no `claude`, no error — just a dead session and a lost prompt. The
// client therefore had to pre-truncate every prompt to 6000 encoded bytes, which is a real
// UX ceiling: a task's full spec (description + why + stories + acceptance criteria) does
// not fit, so the agent got a head-sliced copy.
//
// So a prompt of any size is now POSTed to `/api/agent/prompt` (a normal request BODY — no
// header limit) and exchanged for a short opaque token. The client then puts only that
// token in the upgrade URL (`&promptToken=<uuid>`, ~45 bytes), and the upgrade handler
// redeems it back into the full text. `&prompt=` still works for the short fixed-constant
// callers (Sleep, brain-resolve) and as a no-server-change fallback.
//
// Trust model, mirroring `installRuns` (agent-terminal.ts):
//   - Desktop + loopback gated at both ends (the POST route and each upgrade handler).
//   - Vault-scoped: the token records the vault it was minted for and the upgrade REJECTS a
//     token redeemed against a different vault — a confused-deputy guard, so a token minted
//     for vault A can never seed a session rooted in vault B.
//   - Single-use: deleted on redeem, so a token can't be replayed into a second session.
//   - Short TTL: a token is a hand-off between two legs of ONE user action, not a credential.
//   - Sanitized at MINT, not at redeem, so the stored text is already safe to hand the
//     spawned process and the size cap applies exactly once at the boundary where the text
//     enters.

interface PromptToken {
  /** Already-sanitized prompt text — safe to pass straight to the spawned process as `$0`. */
  prompt: string;
  /** The vault this token was minted for. Redeeming against any other vault is rejected. */
  vault: string;
  expiresAt: number;
}

const promptTokens = new Map<string, PromptToken>();
/** Long enough to cover the POST round-trip + the upgrade that immediately follows;
 *  short enough that a leaked token is inert by the time anyone could use it. */
const PROMPT_TOKEN_TTL_MS = 2 * 60 * 1000;
const PROMPT_TOKENS_MAX = 50;

function prunePromptTokens(): void {
  const now = Date.now();
  for (const [id, t] of promptTokens) if (t.expiresAt <= now) promptTokens.delete(id);
  // Map iterates in insertion order, so the first key is the oldest.
  while (promptTokens.size > PROMPT_TOKENS_MAX) {
    const oldest = promptTokens.keys().next().value;
    if (oldest === undefined) break;
    promptTokens.delete(oldest);
  }
}

/**
 * POST /api/agent/prompt  { vault, prompt }  ->  { ok, token, expiresInMs }
 *
 * Mints a single-use, vault-scoped, short-TTL token for an initial prompt of any size, so
 * the caller can hand it to a spawn upgrade without putting the text in the upgrade URL.
 */
export async function handleAgentPromptToken(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'The embedded agent terminal is only available in the desktop app.');
    return;
  }

  let body: { vault?: unknown; prompt?: unknown } = {};
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const c of req) {
      bytes += (c as Buffer).length;
      // Reject a runaway body up front rather than buffering it — the useful ceiling is
      // MAX_PROMPT_CHARS, and 4 bytes/char covers the worst-case UTF-8 + JSON escaping.
      if (bytes > MAX_PROMPT_CHARS * 4) { sendError(res, 413, 'prompt_too_large', 'Prompt is too large.'); return; }
      chunks.push(c as Buffer);
    }
    if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as typeof body;
  } catch {
    sendError(res, 400, 'bad_body', 'Body must be JSON { vault, prompt }.');
    return;
  }

  const { vault, prompt } = body;
  if (typeof vault !== 'string' || !vault) {
    sendError(res, 400, 'bad_vault', 'Body must name a vault.');
    return;
  }
  // Resolve the vault HERE, at mint time, with the same strict resolver the upgrade uses —
  // so an unknown or path-shaped vault is rejected before a token exists for it.
  if (!resolveVaultProjectRoot(vault)) {
    sendError(res, 400, 'unknown_vault', 'Unknown vault.');
    return;
  }
  const clean = sanitizePrompt(typeof prompt === 'string' ? prompt : null);
  if (!clean) {
    sendError(res, 400, 'empty_prompt', 'Prompt is empty after sanitization.');
    return;
  }

  prunePromptTokens();
  const token = randomUUID();
  promptTokens.set(token, { prompt: clean, vault, expiresAt: Date.now() + PROMPT_TOKEN_TTL_MS });
  sendJson(res, 200, { ok: true, token, expiresInMs: PROMPT_TOKEN_TTL_MS });
}

/**
 * Redeem a `promptToken` back into its prompt text. Single-use and vault-scoped.
 *
 * Returns `null` — meaning REJECT THE UPGRADE — when a token was supplied but is unknown,
 * expired, or minted for a different vault. That is deliberate: a caller that asked for a
 * seeded session and silently got an empty one is the exact failure the token exists to
 * prevent, so a bad token must fail loudly rather than degrade to a blank prompt.
 * Returns `''` when no token was supplied at all (the normal un-seeded case).
 */
export function redeemPromptToken(raw: string | null, vault: string | null): string | null {
  if (!raw) return '';
  prunePromptTokens();
  const entry = promptTokens.get(raw);
  if (!entry) return null;
  promptTokens.delete(raw); // single-use: consumed whether or not it validates below
  if (entry.expiresAt <= Date.now()) return null;
  if (entry.vault !== vault) return null;
  return entry.prompt;
}

// ─── Transcript-existence lookup (resume vs fresh-pin decisions) ──────────────

/** One projects-dir listing serving several candidate ids in priority order — callers
 *  with a fallback id (mapped → pinned) pay ONE scan instead of one per candidate.
 *  This sits behind polled per-tab endpoints, so the scan count matters. Returns the
 *  first candidate that has a transcript, else null. */
export function findFirstTranscriptPath(ids: string[]): string | null {
  const wanted = ids.filter(Boolean);
  if (wanted.length === 0) return null;
  try {
    const base = join(homedir(), '.claude', 'projects');
    if (!existsSync(base)) return null;
    const dirs = readdirSync(base);
    for (const id of wanted) {
      for (const dir of dirs) {
        const p = join(base, dir, `${id}.jsonl`);
        if (existsSync(p)) return p;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Does `claude` actually have a stored transcript for this conversation id? Claude Code
 * persists each conversation at `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`, but
 * ONLY after the first turn — a tab/pane that was opened and never used has NO transcript.
 * So `claude --resume <id>` on such an id fails with "No conversation found with session
 * ID". Callers scan for `<id>.jsonl` (the uuid is globally unique, so we needn't reproduce
 * claude's exact cwd-slug encoding) and only `--resume` when it truly exists; otherwise they
 * start fresh PINNED to that id so the session stays resumable going forward.
 */
export function claudeConversationExists(id: string): boolean {
  return findFirstTranscriptPath([id]) !== null;
}
