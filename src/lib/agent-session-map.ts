import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureGitignoreEntries } from './gitignore.js';

/**
 * Per-vault map from an embedded agent TAB's roster identity to its CURRENT Claude
 * conversation id — the fix for "resumed tabs reopen stale".
 *
 * A dashboard tab is pinned to one conversation UUID at spawn (`--session-id` /
 * `--resume`), and the roster persists that id forever. But Claude Code ROTATES the
 * live conversation id underneath a running TUI: `/clear` starts a brand-new session
 * file (verified on v2.1.201 — the `/clear` stub sits at the TOP of a freshly created
 * transcript), and the in-TUI resume picker switches to another conversation entirely.
 * The new transcript carries NO back-link to the old id, so on the next app launch
 * `claude --resume <pinned>` faithfully reopens the conversation FROZEN at the moment
 * of the last rotation — everything after it lives in a file the roster knows nothing
 * about.
 *
 * The rotation is observable exactly once, at the moment it happens: Claude Code fires
 * the SessionStart hook (source startup|resume|compact|clear) with the NEW session id.
 * The embedded PTY exports `DREAMCONTEXT_TAB_SESSION=<roster id>` into the `claude`
 * process, the hook inherits it (verified empirically), and both `hook session-start`
 * and `hook stop` record `roster id → current id` here. Reopening a tab then resolves
 * through this map first and falls back to the pinned id — so a tab always resumes
 * what was ACTUALLY on screen when the app closed.
 *
 * Storage is ONE FILE PER TAB (`state/.agent-session-map/<tab-uuid>.json`), not a
 * shared JSON blob — two tabs recording concurrently (both `/clear`d in the same
 * window, or the multi-tab hydrate-restore burst) write DIFFERENT files, so there is
 * structurally no read-modify-write race to lose an update to (multi-review Major).
 * Each write also sweeps sibling entries pointing at the same conversation: the
 * in-TUI resume picker lets a user pull ANOTHER tab's conversation into this tab, and
 * without the sweep both roster ids would resolve to one transcript — two concurrent
 * `claude --resume` writers on relaunch (multi-review Major). Latest record wins; the
 * displaced tab falls back to its own pinned chain.
 *
 * Machine-local state (conversation ids only exist in this machine's `~/.claude`),
 * never committed — gitignored the same way as the roster it complements.
 */

/** Canonical UUID gate — both keys and values must be shell-inert conversation ids
 *  (the key also becomes a filename; the value is interpolated into `claude --resume`).
 *  Exported as THE shared session-id gate (roster + terminal routes import it): this
 *  regex is an injection guard, and diverging copies would rot independently. */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Ceiling on remembered tabs — the roster caps at 20, so 40 leaves generous slack
 *  for closed tabs whose entries haven't been reused yet before pruning kicks in. */
const MAX_ENTRIES = 40;

const MAP_DIR_REL = join('state', '.agent-session-map');

export interface AgentSessionEntry {
  /** The tab's CURRENT conversation UUID (what `--resume` should actually target). */
  current: string;
  /** ISO timestamp of the last update — prune order only. */
  updated: string;
}

function mapDir(contextRoot: string): string {
  return join(contextRoot, MAP_DIR_REL);
}

/** Read + validate one tab's entry file. Missing/corrupt/hand-edited → null (never throws). */
function readEntry(path: string): AgentSessionEntry | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { current, updated } = raw as { current?: unknown; updated?: unknown };
    if (typeof current !== 'string' || !UUID_RE.test(current)) return null;
    const entry: AgentSessionEntry = { current, updated: typeof updated === 'string' ? updated : '' };
    return entry;
  } catch {
    return null;
  }
}

/** The entry files currently in the map dir (UUID-named .json only, junk ignored). */
function listEntryFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json') && UUID_RE.test(basename(f, '.json')));
  } catch {
    return [];
  }
}

/**
 * Resolve the map dir for writing, or null when it must not be written through.
 * Symlink guard (same hazard class ensureGitignoreEntries defends with lstat): a
 * malicious cloned vault could COMMIT `state` or the map dir as a symlink (gitignore
 * only stops untracked files), redirecting writes outside the vault. Refuse to write
 * through anything that isn't a real directory. On first creation, ensure the ignore
 * entry BEFORE the first write so a fresh project can never accidentally track it —
 * gated on the dir being new: re-reading .gitignore on EVERY record (every Stop hook
 * = every completed turn) is pure repeated I/O for a line that only needs to exist
 * once. A hand-deleted line isn't re-healed here — brain-repo's buildBrainGitignore
 * and the checked-in template both carry the entry, and the map isn't a secret.
 */
function ensureMapDir(contextRoot: string): string | null {
  const stateDir = join(contextRoot, 'state');
  if (existsSync(stateDir) && !lstatSync(stateDir).isDirectory()) return null;
  const dir = mapDir(contextRoot);
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) return null;
  if (!existsSync(dir)) {
    try {
      ensureGitignoreEntries(dirname(contextRoot), ['_dream_context/state/.agent-session-map/'], {
        comment: 'dreamcontext: machine-local agent tab → live Claude session map',
      });
    } catch { /* best-effort: a gitignore failure must not block persistence */ }
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Atomic temp-file + rename so a crash / concurrent reader can't see a half write. */
function writeEntryAtomic(path: string, entry: AgentSessionEntry): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/**
 * Record that tab `tabId` is now running conversation `sessionId`. Called from the
 * SessionStart hook on every startup/resume/compact/clear AND from the Stop hook after
 * every completed turn (belt-and-suspenders: a `/clear` followed by an instant app
 * quit could lose the SessionStart record to the hook timeout — the next finished turn
 * re-records it). Silently ignores non-UUID input (defense in depth — both ids are
 * later interpolated into a shell command / used as a filename by the terminal route).
 * Best-effort: any fs error is swallowed; the map is an optimization, never a gate.
 */
export function recordAgentSession(contextRoot: string, tabId: string, sessionId: string): void {
  if (!UUID_RE.test(tabId) || !UUID_RE.test(sessionId)) return;
  try {
    const dir = ensureMapDir(contextRoot);
    if (!dir) return;

    const path = join(dir, `${tabId}.json`);
    if (existsSync(path) && !lstatSync(path).isFile()) return;
    writeEntryAtomic(path, { current: sessionId, updated: new Date().toISOString() });
    resolveCache.delete(`${contextRoot}\0${tabId}`); // same-process read coherence

    // ONE directory pass feeds both the uniqueness sweep and the prune — this runs on
    // every completed turn, so no per-phase re-listing / re-parsing.
    //
    // Uniqueness sweep: a conversation can be LIVE in only one tab. If another tab's
    // entry points at this same conversation (the user pulled it over via the in-TUI
    // resume picker), drop that entry — latest record wins; the displaced tab falls
    // back to its own pinned chain on relaunch instead of double-attaching.
    const survivors: { f: string; updated: string }[] = [];
    for (const f of listEntryFiles(dir)) {
      if (basename(f, '.json') === tabId) continue;
      const p = join(dir, f);
      const other = readEntry(p);
      if (other?.current === sessionId) {
        try { unlinkSync(p); } catch { /* concurrent unlink — fine */ }
      } else {
        survivors.push({ f, updated: other?.updated ?? '' });
      }
    }

    // Prune the oldest entries beyond the ceiling so a long-lived vault can't grow an
    // unbounded pile of closed-tab files. Ties break on filename → deterministic.
    // (+1 counts this tab's fresh entry, which is excluded above and never pruned.)
    if (survivors.length + 1 > MAX_ENTRIES) {
      survivors
        .sort((a, b) => (a.updated === b.updated ? (a.f < b.f ? -1 : 1) : a.updated < b.updated ? -1 : 1))
        .slice(0, survivors.length + 1 - MAX_ENTRIES)
        .forEach(({ f }) => { try { unlinkSync(join(dir, f)); } catch { /* gone */ } });
    }
  } catch { /* best-effort — resume falls back to the pinned id */ }
}

/** Mtime-keyed memo for `resolveAgentSession` — the server calls it behind
 *  /agent/session-stats (polled every 5s per live tab), so steady-state polls should
 *  cost one `stat` instead of a read+JSON.parse. Entries are invalidated by mtime
 *  change (hook processes rewrite the file) or a same-process record. Bounded: hook
 *  processes are one-shot, and a server holds ≤ MAX_ENTRIES tabs per vault; the cap
 *  is a safety net against pathological many-vault servers. */
const resolveCache = new Map<string, { mtimeMs: number; current: string }>();
const RESOLVE_CACHE_MAX = 512;

/**
 * Resolve a tab's roster id to its CURRENT conversation id, or `''` when unmapped.
 * The returned value is UUID-validated (it goes into a `claude --resume` shell string),
 * and identity mappings are collapsed to `''` so callers can treat "mapped" as
 * "actually rotated".
 */
export function resolveAgentSession(contextRoot: string, tabId: string): string {
  if (!UUID_RE.test(tabId)) return '';
  const path = join(mapDir(contextRoot), `${tabId}.json`);
  const key = `${contextRoot}\0${tabId}`;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    resolveCache.delete(key);
    return ''; // no entry file → unmapped
  }
  const hit = resolveCache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) return hit.current;
  const raw = readEntry(path)?.current ?? '';
  const current = raw && raw !== tabId ? raw : '';
  if (resolveCache.size >= RESOLVE_CACHE_MAX) resolveCache.clear();
  resolveCache.set(key, { mtimeMs, current });
  return current;
}
