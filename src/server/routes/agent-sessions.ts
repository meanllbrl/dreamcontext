import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { isAgentHost, isAgentRequest, isDesktop } from '../desktop.js';
import { isCloud, workerRunner } from '../cloud-mode.js';
import { ensureGitignoreEntries } from '../../lib/gitignore.js';
import { acquireFileLock, releaseFileLock } from '../../lib/file-lock.js';
import { UUID_RE, resolveAgentSession } from '../../lib/agent-session-map.js';
import {
  recordSessionTitles, recordSessionTitlesViaWorker, workerReadText, workerWriteAtomic, type WorkerRun,
} from '../../lib/session-titles.js';
import { isAutomationBoundSession } from '../../lib/automations/session-registry.js';
import { isSafeAutomationSlug } from '../../lib/automations/store.js';
import { CHAT_MODES, type ChatMode } from '../chat-modes.js';

/**
 * Per-vault persistence of the embedded-agent session ROSTER (titles + layout) so a
 * renamed tab survives an app reload/reopen. The desktop app picks a FRESH loopback
 * port each launch → a new origin → localStorage is empty every launch (the documented
 * "persistence gotcha"), and the in-memory `sessionSeq`/`sessionList` reset to 0/[] on
 * reload — so without a server-side mirror, "Fitness"/"Refactor" become "Agent N" again.
 *
 * We persist ONLY metadata — title, permission mode, the Claude conversation id, and the
 * PLACEMENT (which pane, which tab was visible, which pane had focus) — never a live PTY.
 * On reopen the client restores these as DORMANT "Resume" tabs that spawn a real Claude Code
 * session only when the user clicks resume (no auto-spawn of `claude` on launch). The blob
 * lives at `<contextRoot>/state/.agent-sessions.json` (already gitignored).
 *
 * Placement is here because the same "fresh port every launch" gotcha destroys it: the pane
 * row is React state in a realm that does not survive the relaunch, and localStorage — the
 * usual home for a layout — is empty on the new origin. Without a server-side mirror, five
 * side-by-side panes reopen as one pane with one chat visible.
 *
 * Agent hosts only: the desktop app (loopback) and the hands-free cloud (a device session —
 * the phone reads and writes the roster there). A browser/npm dashboard never reaches it (403).
 * The CSRF guard already fronts the PUT in the server entry.
 *
 * GENERATION. The file carries a top-level `generation` (absent = 0). Only a hands-free Return
 * bumps it ({@link writeMergedRosterSurface}: the cloud's roster merged in); a PUT keeps it. A
 * PUT names the generation it was based on (`baseGeneration`), so a laptop tab left open while
 * away cannot overwrite the merged roster with the one it loaded before the trip: a stale base
 * gets 409 `roster_stale` with the stored surface, and the client re-hydrates from it.
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
  /**
   * Present only alongside `kind: 'chat'` — how that conversation's agent is BRIEFED to work
   * (`src/server/chat-modes.ts`), so a Develop tab reopens as one after a relaunch.
   *
   * Whitelisted to {@link CHAT_MODES} on the way in for the same reason `kind` is: this value
   * chooses which system-prompt append a respawn gets, and a roster is hand-editable and
   * travels in the brain. An unknown value is dropped, which reads as Basic on the client —
   * the mode with no extra brief at all, and therefore the safe direction.
   */
  mode?: ChatMode;
  /**
   * Present only alongside `kind: 'chat'` — the agent this conversation speaks as (the composer's
   * agent picker), so an agent's Chat tab reopens as that agent after a relaunch. Only a slug
   * that passes `isSafeAutomationSlug` is kept: the server reads the manifest by it at every
   * spawn and refuses one that is gone or unapproved, so a hand-edited value can name an agent
   * but never grant one anything its own approval does not.
   */
  agent?: string;
  /**
   * Which PANE this tab sat in, as a 0-based index into the surface's left-to-right pane row.
   *
   * The roster used to persist titles only, and the client's own comment said so out loud:
   * "the pane layout itself is not persisted — restored tabs reopen in a single pane". For
   * one or two tabs that reads as a tidy-up; for the five side-by-side panes this surface
   * exists to support it is data loss, because the arrangement IS the work (a plan pane next
   * to the build pane next to the log). Reopening collapses all five into one stack with one
   * chat visible and the rest to be hunted for in a tab strip.
   *
   * An INDEX, not a pane id: pane ids (`pane-N`) are minted per page load and mean nothing
   * across a relaunch, while "third from the left" survives verbatim. Gaps are harmless — the
   * client sorts the groups and rebuilds them in order — so an entry whose pane no longer has
   * any other member simply becomes its own pane.
   */
  pane?: number;
  /** Was this the ACTIVE (visible) tab of its pane? At most one per pane survives coercion's
   *  caller — the client writes one — and a pane whose flag is missing falls back to its
   *  first tab, which is what a fresh pane does anyway. */
  active?: boolean;
  /** The current title was set by the tab's own agent (a chat `title` block), so the agent may
   *  rename it again when the work moves on; a user rename drops it. Only `true` survives. */
  titleByAgent?: boolean;
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

/** The names a tab carries before anyone named it — mirrors the client's
 *  `DEFAULT_TAB_TITLE_RE` (AgentSurface.tsx) plus the coerced {@link DEFAULT_TITLE}. */
const DEFAULT_TAB_TITLE_RE = /^(?:Agent|Chat)(?: \d+)?$/;

/**
 * The tab names worth remembering past the tab's own life, keyed by the conversation each tab
 * is ACTUALLY on (resolved through the tab→session map: a `/clear`ed tab is on a different
 * conversation than the one it was pinned to). A default "Chat N" says nothing the first prompt
 * doesn't, and shells and automation runs are not conversations the history picker offers.
 * Exported for unit testing.
 */
export function rosterTitleUpdates(contextRoot: string | null, sessions: readonly SavedMeta[]): Array<{ sessionId: string; title: string }> {
  const out: Array<{ sessionId: string; title: string }> = [];
  for (const m of sessions) {
    if (!m.sessionId || m.kind === 'shell' || m.kind === 'automation') continue;
    if (DEFAULT_TAB_TITLE_RE.test(m.title)) continue;
    // A tab resumed from Past chats is titled with that row's first prompt, clipped to fit
    // (AgentSurface's `resumePastSession`). That clip is a worse title than the one the listing
    // already derives, and storing it would bury the full prompt under its own stub.
    if (m.title.endsWith('…')) continue;
    // `null` (the cloud) skips the tab→session map: the server must not read dcuser's files.
    out.push({ sessionId: (contextRoot ? resolveAgentSession(contextRoot, m.sessionId) : '') || m.sessionId, title: m.title });
  }
  return out;
}

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
 * it's one of {@link KNOWN_KINDS}, `automation` only alongside `kind: 'automation'`, and
 * `mode` only alongside `kind: 'chat'` and only for a known {@link CHAT_MODES} value.
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
  // Same containment rule as `automation`: a mode means nothing on a shell or a terminal
  // agent, so it is kept only alongside `kind: 'chat'` and only for a mode THIS build knows.
  const mode = kind === 'chat' && typeof o.mode === 'string' && (CHAT_MODES as readonly string[]).includes(o.mode)
    ? (o.mode as ChatMode)
    : undefined;
  const agent = kind === 'chat' && typeof o.agent === 'string' && isSafeAutomationSlug(o.agent) ? o.agent : undefined;
  // A pane index is clamped into range rather than dropped: it is a layout hint, and the
  // worst a clamped value can do is put a tab in the nearest real pane. MAX_SESSIONS is the
  // ceiling because a roster of N tabs can never need more than N panes.
  const pane = typeof o.pane === 'number' && Number.isFinite(o.pane)
    ? Math.min(MAX_SESSIONS - 1, Math.max(0, Math.floor(o.pane)))
    : undefined;
  return {
    title: title || DEFAULT_TITLE,
    bypass: o.bypass === true,
    minimized: o.minimized === true,
    size,
    ...(sessionId ? { sessionId } : {}),
    ...(kind ? { kind } : {}),
    ...(automation ? { automation } : {}),
    ...(mode ? { mode } : {}),
    ...(agent ? { agent } : {}),
    ...(pane !== undefined ? { pane } : {}),
    ...(o.active === true ? { active: true } : {}),
    ...(o.titleByAgent === true ? { titleByAgent: true } : {}),
  };
}

/**
 * This vault's remembered chat permission mode, riding in the SAME file as the roster.
 *
 * WHY IT IS HERE and not in `/launcher/agent-settings` with the other chat defaults: that
 * blob is global, and a permission gate must never cross projects (`agentSettings.ts` spells
 * out the reasoning — flipping bypass while looking at project A must not arm project B).
 * This file is already the per-vault, machine-local, gitignored home for exactly that class
 * of state, so the mode travels with the roster rather than earning a second endpoint.
 *
 * WHY IT NEEDS A SERVER HOME AT ALL: the client stores it in `localStorage`, and the desktop
 * app picks a FRESH loopback port every launch — a new origin, an empty store. So a mode the
 * user chose yesterday was gone this morning, every morning.
 *
 * Only an exact `'bypass'` opts in; anything else reads as `'auto'`, the same fail-safe
 * direction `readChatPermissionMode` takes on the client.
 */
export type ChatPermissionMode = 'auto' | 'bypass';

function coercePermissionMode(raw: unknown): ChatPermissionMode {
  return raw === 'bypass' ? 'bypass' : 'auto';
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

/**
 * The whole persisted blob: the roster plus the two surface-level facts that belong to the
 * same per-vault, machine-local scope — which pane had focus, and the remembered permission
 * mode. Separate from {@link sanitizeRoster} so that function keeps its exact contract (and
 * its unit tests), and so a body with a valid `sessions` but junk beside it still stores the
 * sessions.
 */
export interface SavedSurface {
  sessions: SavedMeta[];
  /** 0-based index of the pane that had focus, clamped like {@link SavedMeta.pane}. */
  activePane?: number;
  chatPermissionMode: ChatPermissionMode;
}

function coerceActivePane(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(MAX_SESSIONS - 1, Math.max(0, Math.floor(raw)))
    : undefined;
}

/** The stored surface plus its generation, as {@link readRosterSurface} returns it. */
export interface StoredSurface extends SavedSurface {
  generation: number;
}

/** A generation is a non-negative integer; anything else (absent, hand-edited) reads as 0. */
function coerceGeneration(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

/** Sanitize a parsed blob. Missing/corrupt/hand-edited → empty + `'auto'` + generation 0
 *  (never throws), which is the fail-safe direction for the permission mode. */
function parseSurface(text: string | null): StoredSurface {
  try {
    if (text === null) throw new Error('absent');
    const raw = JSON.parse(text) as Record<string, unknown>;
    const activePane = coerceActivePane(raw?.activePane);
    return {
      sessions: sanitizeRoster(raw) ?? [],
      ...(activePane !== undefined ? { activePane } : {}),
      chatPermissionMode: coercePermissionMode(raw?.chatPermissionMode),
      generation: coerceGeneration(raw?.generation),
    };
  } catch {
    return { sessions: [], chatPermissionMode: 'auto', generation: 0 };
  }
}

function readSurface(contextRoot: string): StoredSurface {
  let text: string | null = null;
  try { text = readFileSync(storePath(contextRoot), 'utf-8'); } catch { /* absent → empty */ }
  return parseSurface(text);
}

/** The persisted file: the surface plus its generation (written only when non-zero, so a
 *  roster that never went through a Return stays byte-identical to the legacy shape). */
function serializeSurface(surface: SavedSurface, generation: number): string {
  const sessionsFirst = { sessions: surface.sessions, ...(surface.activePane !== undefined ? { activePane: surface.activePane } : {}), chatPermissionMode: surface.chatPermissionMode };
  return JSON.stringify(generation > 0 ? { ...sessionsFirst, generation } : sessionsFirst, null, 2) + '\n';
}

/** Atomically persist the surface (temp file + rename) so a crash can't leave a half-written blob. */
function writeSurface(contextRoot: string, surface: SavedSurface, generation: number): void {
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
  writeFileSync(tmp, serializeSurface(surface, generation), 'utf-8');
  renameSync(tmp, path);
}

// ─── Roster I/O in the hands-free cloud: as the worker (dcuser) ───────────────
//
// Chosen over "lstat + realpath-contain every parent, open with O_NOFOLLOW": a parent can be
// swapped for a link between the check and the open (Node has no openat), and a planted FIFO
// would hang the server. Run as dcuser, a planted link only reaches what dcuser could reach
// anyway. There is one cloud server, so an in-process queue serializes read-check-write.

let rosterWorkerRun: WorkerRun = workerRunner;

/** Tests only: a local runner instead of the cloud's `workerRunner`. */
export function setRosterWorkerRunForTests(run: WorkerRun | null): void {
  rosterWorkerRun = run ?? workerRunner;
}

const cloudQueues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier roster operation on `contextRoot` has settled. The entry is
 *  dropped once the queue drains, so the map holds only vaults with work in flight. */
function serializeCloud<T>(contextRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = cloudQueues.get(contextRoot) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  cloudQueues.set(contextRoot, tail);
  void tail.then(() => { if (cloudQueues.get(contextRoot) === tail) cloudQueues.delete(contextRoot); });
  return next;
}

async function readSurfaceAsWorker(contextRoot: string): Promise<StoredSurface> {
  return parseSurface(await workerReadText(rosterWorkerRun, storePath(contextRoot), MAX_BYTES * 2));
}

// ─── Laptop lock + the pinned surface API (hands-free Return, lane E) ──────────

const ROSTER_LOCK_STALE_MS = 10_000;

function rosterLockPath(contextRoot: string): string {
  return `${storePath(contextRoot)}.lock`;
}

/**
 * The stored roster surface and its generation (absent file = empty, `'auto'`, 0). Laptop-side,
 * synchronous. Pinned for the hands-free Return merge.
 */
export function readRosterSurface(contextRoot: string): StoredSurface {
  return readSurface(contextRoot);
}

/** The roster lock is held by another writer (a PUT in another process, or a CLI merge). */
export class RosterBusyError extends Error {
  readonly code = 'roster_busy';
  constructor() {
    super('session roster is locked by another writer; try again');
    this.name = 'RosterBusyError';
  }
}

type MergedSurface = { sessions: SavedMeta[]; activePane?: number; chatPermissionMode: ChatPermissionMode };

/** The pid recorded in a lock file, or null (unreadable, no pid). */
function lockOwnerPid(lock: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(lock, 'utf-8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * One attempt at the roster lock, shared by the PUT and both merge writers. Besides the
 * age-based reclaim (`acquireFileLock` with pid liveness), a lock whose recorded owner pid is
 * DEAD is reclaimed at once rather than after {@link ROSTER_LOCK_STALE_MS}: a writer that crashed
 * inside the lock must not leave every PUT answering 503 for 10 s. Re-read just before removal
 * so a lock a live writer has since taken over is left alone.
 */
function tryAcquireRosterLockAt(lock: string): boolean {
  if (acquireFileLock(lock, Date.now(), ROSTER_LOCK_STALE_MS, { verifyPidLiveness: true })) return true;
  const owner = lockOwnerPid(lock);
  if (owner === null || owner === process.pid || !pidIsDead(owner)) return false;
  if (lockOwnerPid(lock) !== owner) return false;
  try { rmSync(lock, { force: true }); } catch { return false; }
  return acquireFileLock(lock, Date.now(), ROSTER_LOCK_STALE_MS, { verifyPidLiveness: true });
}

function tryAcquireRosterLock(contextRoot: string): string | null {
  const lock = rosterLockPath(contextRoot);
  return tryAcquireRosterLockAt(lock) ? lock : null;
}

/** Wait (awaited, never blocking) up to `waitMs` for the roster lock; the lock path, or null. */
async function acquireRosterLockWithin(contextRoot: string, waitMs: number): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = tryAcquireRosterLock(contextRoot);
    if (lock) return lock;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

/** The locked read-bump-write. The caller holds the lock; synchronous, so nothing interleaves. */
function writeMergedLocked(contextRoot: string, surface: MergedSurface): number {
  const generation = readSurface(contextRoot).generation + 1;
  const activePane = coerceActivePane(surface.activePane);
  writeSurface(contextRoot, {
    sessions: sanitizeRoster({ sessions: surface.sessions }) ?? [],
    ...(activePane !== undefined ? { activePane } : {}),
    chatPermissionMode: coercePermissionMode(surface.chatPermissionMode),
  }, generation);
  return generation;
}

/**
 * Write a merged roster surface with generation = stored + 1 (atomic, under the roster lock so a
 * concurrent PUT cannot interleave), and return the new generation. Every field is coerced like
 * a PUT body; `chatPermissionMode` is exactly what the caller passes (the merge keeps the
 * laptop's). Pinned for the hands-free Return merge.
 *
 * NEVER WAITS: one lock attempt, and {@link RosterBusyError} when another process holds it, so a
 * caller inside the server never freezes the event loop. Within the server itself a PUT holds
 * the lock only across synchronous code, so a busy lock there means another process (rare, and
 * sub-millisecond). Callers that should ride it out use {@link writeMergedRosterSurfaceAsync}.
 */
export function writeMergedRosterSurface(contextRoot: string, surface: MergedSurface): number {
  const lock = tryAcquireRosterLock(contextRoot);
  if (!lock) throw new RosterBusyError();
  try {
    return writeMergedLocked(contextRoot, surface);
  } finally {
    releaseFileLock(lock);
  }
}

/**
 * {@link writeMergedRosterSurface} that waits for a busy lock without blocking: retries every
 * 25 ms (awaited) for up to `waitMs` (5 s), then throws {@link RosterBusyError}.
 */
export async function writeMergedRosterSurfaceAsync(
  contextRoot: string,
  surface: MergedSurface,
  opts: { waitMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + (opts.waitMs ?? 5_000);
  for (;;) {
    const lock = tryAcquireRosterLock(contextRoot);
    if (lock) {
      try {
        return writeMergedLocked(contextRoot, surface);
      } finally {
        releaseFileLock(lock);
      }
    }
    if (Date.now() >= deadline) throw new RosterBusyError();
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

/**
 * May a PUT based on `base` replace a roster stored at `stored`? A named base must equal the
 * stored generation; a missing one (a client from before generations) only while nothing was
 * ever merged (stored 0) — after a Return it would silently drop the phone's sessions.
 */
export function rosterBaseAccepted(base: unknown, stored: number): boolean {
  if (base === undefined || base === null) return stored === 0;
  return typeof base === 'number' && base === stored;
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
 * The roster gate: an agent host, and in the hands-free cloud a device session. On the desktop
 * it stays `isDesktop()` alone, as before: a non-loopback peer (the tailnet phone with remote
 * access on) is already fronted by the server's network-auth gate, and requiring loopback here
 * would cut that phone off its own roster.
 */
function rosterAllowed(req: IncomingMessage): boolean {
  return isAgentHost() && (isDesktop() || isAgentRequest(req));
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
  if (!rosterAllowed(_req)) {
    sendError(res, 403, 'desktop_only', 'Agent session roster is only available in the desktop app.');
    return;
  }
  const cloud = isCloud();
  const saved = cloud ? await serializeCloud(contextRoot, () => readSurfaceAsWorker(contextRoot)) : readSurface(contextRoot);
  sendJson(res, 200, surfaceBody(saved, (id) => !cloud && isAutomationBoundSession(id, home) !== null));
}

/** The GET body (also the 409 body): the surface, each entry with its `bound` flag, and the
 *  generation. The cloud runs no automations, so nothing is bound there. */
function surfaceBody(saved: StoredSurface, isBound: (sessionId: string) => boolean): Record<string, unknown> {
  const sessions: SessionRosterEntry[] = saved.sessions.map((m) => ({
    ...m,
    bound: !!m.sessionId && isBound(m.sessionId),
  }));
  return {
    sessions,
    ...(saved.activePane !== undefined ? { activePane: saved.activePane } : {}),
    chatPermissionMode: saved.chatPermissionMode,
    generation: saved.generation,
  };
}

/**
 * PUT /api/agent/sessions — persist the roster for the current vault. Agent hosts only and
 * behind the cross-site CSRF guard. Rejects a non-object body / non-array `sessions`
 * (400); a stale or (after a merge) missing `baseGeneration` gets 409 `roster_stale` with the
 * stored surface; otherwise caps, coerces, and strips before writing, keeping the generation.
 */
export async function handleAgentSessionsPut(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
  /** Overridable only for tests — every real call resolves this machine's real HOME. */
  home: string = homedir(),
): Promise<void> {
  if (!rosterAllowed(req)) {
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
  const raw = body as Record<string, unknown>;
  const activePane = coerceActivePane(raw.activePane);
  const surface: SavedSurface = {
    sessions,
    ...(activePane !== undefined ? { activePane } : {}),
    // Absent reads as `'auto'`, so a legacy client that only ever sends `{ sessions }` cannot
    // silently leave a stored `'bypass'` in place — a permission gate has to be re-asserted by
    // whoever writes the file, never inherited from what happened to be there.
    chatPermissionMode: coercePermissionMode(raw.chatPermissionMode),
  };
  const serialized = JSON.stringify(surface);
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_BYTES) {
    sendError(res, 400, 'too_large', 'session roster payload is too large.');
    return;
  }
  const base = raw.baseGeneration;
  const stale = (stored: StoredSurface): void => {
    sendJson(res, 409, {
      error: 'roster_stale',
      message: 'The session roster changed since this tab loaded it (a hands-free Return merged it); reload it.',
      surface: surfaceBody(stored, (id) => !isCloud() && isAutomationBoundSession(id, home) !== null),
    });
  };
  try {
    if (isCloud()) {
      await serializeCloud(contextRoot, async () => {
        const stored = await readSurfaceAsWorker(contextRoot);
        if (!rosterBaseAccepted(base, stored.generation)) { stale(stored); return; }
        await workerWriteAtomic(rosterWorkerRun, storePath(contextRoot), serializeSurface(surface, stored.generation));
        // The tab→session map is dcuser-writable, so the cloud titles the PINNED conversation.
        await recordSessionTitlesViaWorker(rosterWorkerRun, contextRoot, rosterTitleUpdates(null, sessions), { home });
        sendJson(res, 200, { ok: true, generation: stored.generation });
      });
      return;
    }
    const lock = await acquireRosterLockWithin(contextRoot, 5_000);
    if (!lock) {
      sendError(res, 503, 'roster_locked', 'The session roster is being written; try again.');
      return;
    }
    let generation: number;
    try {
      const stored = readSurface(contextRoot);
      if (!rosterBaseAccepted(base, stored.generation)) { stale(stored); return; }
      generation = stored.generation;
      writeSurface(contextRoot, surface, generation);
    } finally {
      releaseFileLock(lock);
    }
    // The roster forgets a tab the moment it closes; this is what keeps its name for Past chats.
    recordSessionTitles(contextRoot, rosterTitleUpdates(contextRoot, sessions));
    sendJson(res, 200, { ok: true, generation });
  } catch (err) {
    console.error('[agent-sessions] roster write failed:', err);
    sendError(res, 500, 'write_failed', 'Failed to persist the session roster.');
  }
}
