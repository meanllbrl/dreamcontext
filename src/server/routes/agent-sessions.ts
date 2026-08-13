import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { ensureGitignoreEntries } from '../../lib/gitignore.js';
import { UUID_RE } from '../../lib/agent-session-map.js';
import { isAutomationBoundSession } from '../../lib/automations/session-registry.js';
import { isSafeAutomationSlug } from '../../lib/automations/store.js';

/**
 * Per-vault persistence of the embedded-agent session ROSTER (titles + layout) so a
 * renamed tab survives an app reload/reopen. The desktop app picks a FRESH loopback
 * port each launch → a new origin → localStorage is empty every launch (the documented
 * "persistence gotcha"), and the in-memory `sessionSeq`/`sessionList` reset to 0/[] on
 * reload — so without a server-side mirror, "Fitness"/"Refactor" become "Agent N" again.
 *
 * We persist ONLY the roster metadata — title, bypass default, minimized flag, and the
 * row size — never a live PTY. On reopen the client restores these as DORMANT "Resume"
 * tabs that spawn a real Claude Code session only when the user clicks resume (no
 * auto-spawn of `claude` on launch). The blob lives at
 * `<contextRoot>/state/.agent-sessions.json` (already gitignored).
 *
 * Desktop-only (mirrors agent-drop / agent-terminal): a browser/npm dashboard never
 * reaches it (403). The loopback CSRF guard already fronts the PUT in the server entry.
 */

/**
 * Mirrors `dashboard/src/components/sleepy/agentSession.ts`'s `SessionKind`. Duplicated
 * rather than imported: that module is browser-only (xterm, DOM globals) and cannot load
 * inside the Node server. Kept in sync by hand — the four members are stable.
 */
type SessionKind = 'agent' | 'shell' | 'chat' | 'automation';
const KNOWN_KINDS: readonly SessionKind[] = ['agent', 'shell', 'chat', 'automation'];

/** One persisted session — the renameable title, its layout flags, and the Claude
 *  conversation UUID it's pinned to (so the next launch can `claude --resume` it). */
export interface SavedMeta {
  title: string;
  bypass: boolean;
  minimized: boolean;
  size: number;
  /** Canonical UUID of this tab's Claude conversation; absent on legacy rosters. */
  sessionId?: string;
  /** Which surface this tab represents. Absent on legacy rosters and on anything outside
   *  {@link KNOWN_KINDS} — the client treats a missing kind as a plain agent (back-compat). */
  kind?: SessionKind;
  /**
   * Present only alongside `kind: 'automation'`: which automation produced this run, and
   * when it fired. Never used to build a path here, but `slug` still travels through
   * `isSafeAutomationSlug` on the way in — it is a path segment everywhere else in the
   * automations subsystem (`session-registry.ts`), and this is the one place it arrives
   * from an untrusted roster rather than from code that already validated it.
   */
  automation?: { slug: string; runFiredAt: string };
}

/** Hard ceiling on rostered sessions (extras are dropped, not rejected). */
export const MAX_SESSIONS = 20;
const MAX_TITLE = 200;
const DEFAULT_TITLE = 'Agent';
const MIN_SIZE = 0.1;
const MAX_SIZE = 10;
const DEFAULT_SIZE = 1;
/** Generous cap on the serialized roster; a runaway client can't write an unbounded file. */
const MAX_BYTES = 64 * 1024;
/** Generous ceiling on `automation.runFiredAt` — an ISO timestamp is well under this; the
 *  cap exists only to bound a hand-edited/malicious string before it reaches `Date.parse`. */
const MAX_RUN_FIRED_AT = 64;

const ROSTER_REL_PATH = join('state', '.agent-sessions.json');

function storePath(contextRoot: string): string {
  return join(contextRoot, ROSTER_REL_PATH);
}

/**
 * Sanitize the `automation` companion object. Kept ONLY when it names a well-formed
 * automation (`isSafeAutomationSlug`) and a `runFiredAt` that actually parses as a date —
 * an unparseable timestamp means the entry wasn't produced by the code that writes this
 * field, and inert is the only safe reading of that (mirrors `session-registry.ts`'s
 * treatment of an unparseable binding `at`).
 */
function coerceAutomation(raw: unknown): SavedMeta['automation'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const slug = typeof o.slug === 'string' ? o.slug.trim() : '';
  if (!isSafeAutomationSlug(slug)) return undefined;
  const runFiredAt = typeof o.runFiredAt === 'string' ? o.runFiredAt.trim().slice(0, MAX_RUN_FIRED_AT) : '';
  if (!runFiredAt || Number.isNaN(Date.parse(runFiredAt))) return undefined;
  return { slug, runFiredAt };
}

/**
 * Coerce one untrusted roster entry into a safe {@link SavedMeta}. Strips every field
 * outside the known set; clamps title length + size; defaults a blank/non-string title
 * to "Agent"; treats anything but `true` as false for the booleans; keeps `kind` only when
 * it's one of {@link KNOWN_KINDS} and `automation` only alongside `kind: 'automation'`.
 * Total function — any input shape yields a valid meta.
 */
function coerceMeta(raw: unknown): SavedMeta {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, MAX_TITLE) : '';
  const size = typeof o.size === 'number' && Number.isFinite(o.size)
    ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, o.size))
    : DEFAULT_SIZE;
  // Only a canonical UUID is persisted as a session id — anything else is dropped, so a
  // malformed id can never round-trip into the `claude --resume <id>` shell invocation.
  const sessionId = typeof o.sessionId === 'string' && UUID_RE.test(o.sessionId) ? o.sessionId : undefined;
  // Only a known kind round-trips — a future value this build doesn't recognize, a typo, or
  // a hand-edited file is dropped rather than passed through unchecked, same discipline as
  // every other field here. The client already treats an absent kind as 'agent'.
  const kind = typeof o.kind === 'string' && (KNOWN_KINDS as readonly string[]).includes(o.kind)
    ? (o.kind as SessionKind)
    : undefined;
  const automation = kind === 'automation' ? coerceAutomation(o.automation) : undefined;
  return {
    title: title || DEFAULT_TITLE,
    bypass: o.bypass === true,
    minimized: o.minimized === true,
    size,
    ...(sessionId ? { sessionId } : {}),
    ...(kind ? { kind } : {}),
    ...(automation ? { automation } : {}),
  };
}

/**
 * Validate + sanitize a PUT body. Returns the cleaned roster (capped to
 * {@link MAX_SESSIONS}, each item coerced), or `null` when the body isn't an object or
 * `sessions` isn't an array — the only two shapes the caller treats as a 400. Exported
 * for unit testing.
 */
export function sanitizeRoster(body: unknown): SavedMeta[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const sessions = (body as Record<string, unknown>).sessions;
  if (!Array.isArray(sessions)) return null;
  return sessions.slice(0, MAX_SESSIONS).map(coerceMeta);
}

/** Read + sanitize the persisted roster. Missing/corrupt/hand-edited → `[]` (never throws). */
function readRoster(contextRoot: string): SavedMeta[] {
  try {
    const raw = readFileSync(storePath(contextRoot), 'utf-8');
    return sanitizeRoster(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

/** Atomically persist the roster (temp file + rename) so a crash can't leave a half-written blob. */
function writeRoster(contextRoot: string, sessions: SavedMeta[]): void {
  // The roster is PER-MACHINE state (renamed tabs + Claude resume ids), never committed.
  // User projects track `state/*.md` (task PRDs) but do NOT blanket-ignore state dotfiles,
  // so — mirroring the task-backend secrets pattern — ensure the ignore entry BEFORE
  // writing, so a fresh project can never accidentally track it. Best-effort: the roster
  // isn't a secret, so a gitignore failure must not block persistence. `contextRoot` is
  // `<projectRoot>/_dream_context`, so its parent is the project root.
  try {
    ensureGitignoreEntries(dirname(contextRoot), ['_dream_context/state/.agent-sessions.json'], {
      comment: 'dreamcontext: machine-local agent session roster (Claude resume ids)',
    });
  } catch { /* best-effort — roster is machine-state, not a secret */ }
  const dir = join(contextRoot, 'state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = storePath(contextRoot);
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ sessions }, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/**
 * One roster entry as GET actually returns it: the persisted fields plus a transient
 * `bound` flag. NEVER persisted — recomputed on every request from THIS machine's
 * automation session-registry, because "can this be resumed here" can change between two
 * GETs (a fresh `recordAutomationSession`, a TTL expiry) even when the roster file hasn't.
 */
export interface SessionRosterEntry extends SavedMeta {
  /**
   * Can THIS machine actually resume `sessionId`? Computed with `isAutomationBoundSession`
   * — the same authority a WS resume gate consults (see `session-registry.ts`'s module
   * doc). `false` for every entry with no `sessionId` (nothing to check) and for a session
   * id this machine's runner never recorded, including one that arrived via brain sync
   * from a teammate's machine — that is exactly the case a restored automation tab must
   * not try to connect for (see X2: a rejected upgrade closes before any application
   * frame, so the client cannot tell a refusal from a crash on its own).
   *
   * Deliberately NOT the owning slug: the hydration filter needs "may I resume this", not
   * "which other automation, if any, owns this id" — returning the slug would leak the
   * existence of automations the caller never told us about.
   */
  bound: boolean;
}

/**
 * GET /api/agent/sessions — return the persisted roster for the current vault as
 * `{ sessions: SessionRosterEntry[] }` (`[]` when absent/corrupt). Desktop-only.
 */
export async function handleAgentSessionsGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
  /** Overridable only for tests — every real call resolves this machine's real HOME. */
  home: string = homedir(),
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Agent session roster is only available in the desktop app.');
    return;
  }
  const sessions: SessionRosterEntry[] = readRoster(contextRoot).map((m) => ({
    ...m,
    bound: !!m.sessionId && isAutomationBoundSession(m.sessionId, home) !== null,
  }));
  sendJson(res, 200, { sessions });
}

/**
 * PUT /api/agent/sessions — persist the roster for the current vault. Desktop-only and
 * behind the cross-site CSRF guard. Rejects a non-object body / non-array `sessions`
 * (400); otherwise caps, coerces, and strips before writing.
 */
export async function handleAgentSessionsPut(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Agent session roster is only available in the desktop app.');
    return;
  }
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be valid JSON.');
    return;
  }
  const sessions = sanitizeRoster(body);
  if (sessions === null) {
    sendError(res, 400, 'invalid_sessions', 'sessions must be an array.');
    return;
  }
  const serialized = JSON.stringify({ sessions });
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_BYTES) {
    sendError(res, 400, 'too_large', 'session roster payload is too large.');
    return;
  }
  try {
    writeRoster(contextRoot, sessions);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[agent-sessions] roster write failed:', err);
    sendError(res, 500, 'write_failed', 'Failed to persist the session roster.');
  }
}
