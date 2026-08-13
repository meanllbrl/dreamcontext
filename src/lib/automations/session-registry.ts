/**
 * Machine-local automation → session bindings.
 *
 * THE PROBLEM THIS SOLVES. A recorded session id is a CAPABILITY: resuming one
 * runs `claude --resume <id> --permission-mode bypassPermissions`. Every surface
 * that can resume an automation's conversation — the chat answer, the Telegram
 * answer, a restored tab — needs to know WHICH session it may resume, and every
 * value it could read that from lives somewhere an attacker can write:
 *
 *   - `automations/cache/<slug>.json` IS BRAIN-SYNCED, so its
 *     `history[].sessionId` is writable by anyone who can push to the shared
 *     brain. This is a strictly lower bar than the review cards that came
 *     before: no card needs planting, just a synced JSON edit.
 *   - a manifest, a Telegram message body, and a hand-edited tab roster are all
 *     equally unverified assertions.
 *
 * So the capability-bearing field lives at the HOME boundary instead — the same
 * boundary as the approval registry, and the same one `card-registry.ts` moved
 * it to for the same reason. Those other records may still SAY which session
 * they belong to; it is useful to read and it is what the dashboard renders.
 * That value is not trusted. The binding recorded HERE, machine-local and never
 * synced, is the authority, and an id with no binding is not resumable at all.
 *
 * WHAT IS TRUSTED: a binding this machine's RUNNER wrote, under the slug whose
 * file it sits in. WHAT IS NOT: everything else — including the caller's own
 * claim about which session it wants. `readAutomationSession` returning null
 * means "not resumable", NEVER "fall back to what the caller said".
 *
 * PER-SLUG, NOT ONE SHARED FILE — three reasons, none of them cosmetic:
 *   1. The slug-scoped lookup becomes STRUCTURAL. A file is one automation's
 *      bindings, and the slug is cross-checked against the filename on the way
 *      in, so a binding cannot be borrowed by another automation even if the
 *      file itself is moved or renamed.
 *   2. Two writers on one JSON file is a lost-update race (the reason the tick
 *      heartbeat got its own file, and the card bindings after it). Per-slug
 *      removes it by construction for different automations; the same slug is
 *      already serialized by the per-slug run lock.
 *   3. Removing an automation removes one file. No orphan sweep, no shared file
 *      that only grows.
 *
 * THE COST OF THAT CHOICE, STATED PLAINLY: `<slug>` is now a PATH SEGMENT,
 * where the predecessor kept it as a JSON value inside one fixed filename. That
 * is a new attack-surface class, so every path-building entry point here
 * validates through `isSafeAutomationSlug` and REFUSES rather than trusting its
 * caller — even though every current caller already validated upstream.
 *
 * ── WHEN A BINDING IS RETIRED (read this before calling `retireAutomationSession`)
 *
 * `card-registry.ts` dropped a binding the instant its card stopped being
 * pending, because "a resolvable session is a capability, and it should not
 * outlive the decision it existed for". This store cannot do that: it is
 * deliberately PLURAL, because Telegram talks to an automation's latest session
 * and the app reopens past runs as chat tabs. But without any retirement, an
 * automation firing daily reaches a steady state of ~90 simultaneously
 * resumable `bypassPermissions` sessions — a widening of the old model, not a
 * port of it.
 *
 * So retirement is explicit, and the caller decides. Retire a binding only when
 * BOTH hold:
 *   (a) the run reached a terminal status with no further question pending, AND
 *   (b) the session was never persisted into the local tab roster
 *       (`state/.agent-sessions.json`) — the user never opened it as a chat tab.
 *
 * If it WAS opened, its lifetime hands off to the roster, which is
 * machine-local, user-visible, and already what tab restore reads — rather than
 * staying an indefinite standing grant nobody asked for. Retiring on (a) alone
 * would break tab restore; retiring on neither is the widening above.
 *
 * ── TWO DELIBERATE STRENGTHENINGS over `card-registry.ts`
 *
 *   - The TTL is enforced on READ as well as on write. The predecessor pruned
 *     only on write, which makes "90 days" nominal: an automation that stops
 *     running never writes its file again, so its last session stays resumable
 *     forever. Here the bound is real.
 *   - A binding whose `at` will not parse is treated as EXPIRED rather than
 *     kept. `recordAutomationSession` always writes a valid ISO timestamp, so
 *     an unparseable one means the file was edited by something that is not
 *     this code — and inert is the only safe reading of that.
 *
 * Reads NEVER throw. An unreadable or corrupt file degrades to "nothing is
 * resumable", which is recoverable; throwing would take down the runner and the
 * tick with it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isSafeSessionId } from '../transcript-locate.js';
import { isSafeAutomationSlug } from './store.js';
import { AutomationError } from './types.js';

/** Outer bound on how long any binding stays resumable. Generous — a question
 *  can sit unanswered for a long time and must still be answerable, and a run
 *  from months ago should still reopen as a tab — but bounded, because an
 *  unbounded grant is not a grant, it is an oversight. */
const BINDING_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Filename suffix identifying one automation's bindings file. Used both to
 *  build a path and, in reverse, to recover the slug when scanning. */
const SESSIONS_FILE_SUFFIX = '.sessions.json';

interface SessionBinding {
  sessionId: string;
  /** The automation this session belongs to. Cross-checked against the FILE it
   *  was read from, so a moved or renamed file cannot launder a binding. */
  slug: string;
  at: string;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

/** Directory holding every automation's bindings file. A sibling of
 *  `automations.json` (the approval registry), never the same file — see the
 *  module doc on lost updates. */
function automationSessionsDir(home: string): string {
  return join(home, '.dreamcontext', 'automations');
}

/**
 * Path to one automation's bindings file. THROWS on a slug that is not
 * path-safe rather than returning a traversal path — this function's return
 * value is used to write a 0600 file, so a caller that forgot to validate must
 * fail loudly here instead of quietly writing outside the directory.
 */
export function automationSessionsPath(slug: string, home: string = homedir()): string {
  if (!isSafeAutomationSlug(slug)) {
    throw new AutomationError(`Refusing to resolve a session-bindings path for an unsafe slug: "${slug}"`);
  }
  return join(automationSessionsDir(home), `${slug}${SESSIONS_FILE_SUFFIX}`);
}

// ─── Read / write (never-throw reads, atomic 0600 writes) ───────────────────

/** Is this binding still within the TTL? An unparseable timestamp is expired —
 *  see the module doc's second strengthening. */
function isLive(binding: SessionBinding, nowMs: number): boolean {
  const at = Date.parse(binding.at);
  if (!Number.isFinite(at)) return false;
  return nowMs - at <= BINDING_TTL_MS;
}

/**
 * Every LIVE, well-formed binding for one slug, keyed by session id.
 *
 * Sanitization happens HERE, on the way in, not at each use site: these are
 * files on disk, and a planted entry whose session id is `../../something` must
 * be inert from the moment it is read rather than dangerous at whichever call
 * site forgets to check. An entry is dropped — never the whole file — when it
 * is malformed, names an unsafe session id, claims a different slug than the
 * file it sits in, or has aged out.
 */
function readAll(slug: string, home: string, nowMs: number): Record<string, SessionBinding> {
  const path = automationSessionsPath(slug, home);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, SessionBinding> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const b = value as Record<string, unknown>;
      const rawId = typeof b.sessionId === 'string' ? b.sessionId : null;
      if (!isSafeSessionId(rawId)) continue;
      // The key and the record must agree, or a file could offer one id under
      // another's name and a keyed lookup would return the wrong session.
      if (id !== rawId) continue;
      if (b.slug !== slug) continue;
      const binding: SessionBinding = {
        sessionId: rawId,
        slug,
        at: typeof b.at === 'string' ? b.at : '',
      };
      if (!isLive(binding, nowMs)) continue;
      out[id] = binding;
    }
    return out;
  } catch {
    // Never throw: an unreadable bindings file must degrade to "nothing for this
    // automation is resumable", which is safe, rather than taking the whole
    // subsystem down.
    return {};
  }
}

/**
 * Persist one slug's bindings. Atomic (unique temp + rename) and 0600.
 *
 * The temp name carries pid + a nonce rather than a fixed `.tmp`: two writers
 * can then never pick the same scratch path, and because the name is always
 * new, `writeFileSync`'s `mode` always applies (it only takes effect on create,
 * so a reused temp path could leave a rewrite world-readable).
 */
function writeAll(slug: string, home: string, all: Record<string, SessionBinding>, nowMs: number): void {
  const path = automationSessionsPath(slug, home);
  const kept: Record<string, SessionBinding> = {};
  for (const [id, binding] of Object.entries(all)) {
    if (isLive(binding, nowMs)) kept[id] = binding;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file never landed, or is already gone — nothing to clean up.
    }
    throw err;
  }
}

// ─── The writer ──────────────────────────────────────────────────────────────

/**
 * Bind a session this automation actually produced on this machine.
 *
 * RUNNER-ONLY WRITER, exactly as its predecessor was. The runner is the one
 * component that knows first-hand which session belongs to which slug, because
 * it is the process that spawned it. Any other writer would be recording an
 * assertion, which is the thing this file exists to stop trusting.
 *
 * Returns false and writes NOTHING for an unsafe slug or an unusable session id
 * — a refusal here must not leave a partial file behind.
 */
export function recordAutomationSession(
  slug: string,
  sessionId: string | null,
  home: string = homedir(),
  nowMs: number = Date.now(),
): boolean {
  if (!isSafeAutomationSlug(slug)) return false;
  if (!isSafeSessionId(sessionId)) return false;
  const all = readAll(slug, home, nowMs);
  all[sessionId] = { sessionId, slug, at: new Date(nowMs).toISOString() };
  writeAll(slug, home, all, nowMs);
  return true;
}

// ─── The lookups ─────────────────────────────────────────────────────────────

/**
 * THE AUTHORITY on whether a session may be resumed for this automation.
 *
 * Returns the id only if THIS machine recorded it under THIS slug. Returns null
 * for a session that arrived from a synced cache record, a manifest, a Telegram
 * message, or a hand-edited roster — which is exactly what an unauthorized
 * resume attempt looks like. Callers MUST treat null as "not resumable" and
 * never as "fall back to what was claimed".
 */
export function readAutomationSession(slug: string, sessionId: string, home: string = homedir()): string | null {
  if (!isSafeAutomationSlug(slug)) return null;
  if (!isSafeSessionId(sessionId)) return null;
  return readAll(slug, home, Date.now())[sessionId]?.sessionId ?? null;
}

/**
 * The newest session this automation produced, or null.
 *
 * This is what "talk to the automation's LATEST run" resolves through: an
 * inbound message answers the most recent conversation, and it must be one this
 * machine recorded rather than the newest id appearing in a synced cache.
 */
export function latestBoundSession(slug: string, home: string = homedir()): string | null {
  if (!isSafeAutomationSlug(slug)) return null;
  let newest: SessionBinding | null = null;
  let newestAt = -Infinity;
  for (const binding of Object.values(readAll(slug, home, Date.now()))) {
    // Every binding surviving `readAll` has a parseable `at` (an unparseable one
    // is treated as expired), so this comparison is always meaningful.
    const at = Date.parse(binding.at);
    // `>=` so that when two bindings share a timestamp the later-written one
    // wins — object key order is insertion order for these non-numeric keys.
    if (at >= newestAt) {
      newestAt = at;
      newest = binding;
    }
  }
  return newest?.sessionId ?? null;
}

/**
 * THE REVERSE LOOKUP: which automation owns this session, if any?
 *
 * Exists because the WebSocket resume handler has a uuid off the query string
 * and no slug at all, and must be able to ask "is this an automation session
 * this machine actually recorded?" UNCONDITIONALLY — a gate that only fires
 * when the client volunteers a hint is not a gate, because the client simply
 * omits the hint.
 *
 * Returns the owning slug, or null when no automation on this machine recorded
 * it. A missing directory (nothing has ever run here) is null, not an error.
 * Scans in sorted filename order so that a session somehow claimed by two slugs
 * resolves the same way every time.
 */
export function isAutomationBoundSession(sessionId: string, home: string = homedir()): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const dir = automationSessionsDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const nowMs = Date.now();
  for (const name of names.sort()) {
    if (!name.endsWith(SESSIONS_FILE_SUFFIX)) continue;
    const slug = name.slice(0, -SESSIONS_FILE_SUFFIX.length);
    // A file hand-dropped under an unsafe name yields no slug we would trust,
    // and `automationSessionsPath` would throw on it — skip rather than crash a
    // scan that must stay total.
    if (!isSafeAutomationSlug(slug)) continue;
    if (readAll(slug, home, nowMs)[sessionId]) return slug;
  }
  return null;
}

// ─── Retirement ──────────────────────────────────────────────────────────────

/**
 * Drop ONE binding, leaving the automation's others intact.
 *
 * See the module doc for WHEN: this is called only once a run is terminally
 * done with no question pending AND the session was never opened as a chat tab.
 * Idempotent — retiring an unknown session, an unknown slug, or an automation
 * with no bindings file is a no-op, never a throw, because a cleanup step that
 * can fail a verdict is worse than a binding that lives a little longer.
 */
export function retireAutomationSession(
  slug: string,
  sessionId: string,
  home: string = homedir(),
  nowMs: number = Date.now(),
): void {
  if (!isSafeAutomationSlug(slug)) return;
  if (!isSafeSessionId(sessionId)) return;
  const all = readAll(slug, home, nowMs);
  if (!(sessionId in all)) return;
  delete all[sessionId];
  writeAll(slug, home, all, nowMs);
}
