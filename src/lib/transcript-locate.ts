/**
 * transcript-locate — shared resolver for finding a session's transcript on
 * disk under either layout Claude Code has used:
 *
 *   - FLAT (verified 2026-07-18, current): `<projectDir>/<sessionId>.jsonl`
 *   - DIR  (verified 2026-07-18, exists alongside flat TODAY but contains only
 *     `subagents/` + `tool-results/` — no main transcript inside — a future
 *     layout change could start writing the main jsonl there instead)
 *
 * Flat is always probed FIRST. The dir layout is a graceful fallback: when a
 * session dir exists but holds no recognizable main transcript, callers get
 * `{ mainPath: null, sessionDir: <dir>, layout: 'dir' }` instead of a silent
 * zero — the caller can still harvest `subagents/` even with no main file.
 * Never throws; every fs call is guarded.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { resolveAgentSession } from './agent-session-map.js';
import { listVaults } from './vaults.js';
import { canonicalPath } from './paths.js';

export interface TranscriptLocation {
  mainPath: string | null;
  sessionDir: string | null;
  layout: 'flat' | 'dir' | 'none';
}

/**
 * Candidate main-jsonl filenames probed INSIDE a session dir, in order.
 * `<sessionId>.jsonl` is a template substituted with the resolved session id;
 * the other two are fixed names probed as-is.
 */
export const DIR_LAYOUT_MAIN_CANDIDATES: readonly string[] = [
  '<sessionId>.jsonl',
  'transcript.jsonl',
  'main.jsonl',
];

const SESSION_ID_TEMPLATE = '<sessionId>.jsonl';

function candidateFilename(template: string, sessionId: string | null): string | null {
  if (template === SESSION_ID_TEMPLATE) {
    return sessionId ? `${sessionId}.jsonl` : null;
  }
  return template;
}

function defaultExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function defaultIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function probeSessionDir(
  dirPath: string,
  existsImpl: (p: string) => boolean,
  isDirImpl: (p: string) => boolean,
): string | null {
  return existsImpl(dirPath) && isDirImpl(dirPath) ? dirPath : null;
}

function sessionIdFromFlatBasename(p: string): string {
  const b = basename(p);
  return b.endsWith('.jsonl') ? b.slice(0, -'.jsonl'.length) : b;
}

/**
 * Resolve a session's transcript location. Probes FLAT first (recorded path,
 * then the re-derived `<projectDir>/<sessionId>.jsonl` in case the recorded
 * path is stale), then falls back to the DIR layout. Returns
 * `{ null, null, 'none' }` when nothing can be resolved. Never throws.
 */
export function resolveTranscript(
  recordedPath: string | null,
  opts: {
    sessionId?: string;
    existsImpl?: (p: string) => boolean;
    isDirImpl?: (p: string) => boolean;
  } = {},
): TranscriptLocation {
  const existsImpl = opts.existsImpl ?? defaultExists;
  const isDirImpl = opts.isDirImpl ?? defaultIsDir;

  let projectDir: string | null = null;
  let sessionId: string | null = opts.sessionId ?? null;

  if (recordedPath) {
    projectDir = dirname(recordedPath);
    if (!sessionId) sessionId = sessionIdFromFlatBasename(recordedPath);
  }

  // FLAT #1: the recorded path itself, exactly as given.
  if (recordedPath && existsImpl(recordedPath) && !isDirImpl(recordedPath)) {
    const sessionDir = projectDir && sessionId
      ? probeSessionDir(join(projectDir, sessionId), existsImpl, isDirImpl)
      : null;
    return { mainPath: recordedPath, sessionDir, layout: 'flat' };
  }

  // FLAT #2: re-derive `<projectDir>/<sessionId>.jsonl` — covers a stale
  // recordedPath (e.g. an explicit sessionId override) whose derived flat
  // file still exists even though recordedPath itself does not.
  if (projectDir && sessionId) {
    const flatPath = join(projectDir, `${sessionId}.jsonl`);
    if (flatPath !== recordedPath && existsImpl(flatPath) && !isDirImpl(flatPath)) {
      const sessionDir = probeSessionDir(join(projectDir, sessionId), existsImpl, isDirImpl);
      return { mainPath: flatPath, sessionDir, layout: 'flat' };
    }
  }

  // DIR fallback.
  if (projectDir && sessionId) {
    const dirPath = join(projectDir, sessionId);
    if (existsImpl(dirPath) && isDirImpl(dirPath)) {
      for (const template of DIR_LAYOUT_MAIN_CANDIDATES) {
        const filename = candidateFilename(template, sessionId);
        if (!filename) continue;
        const candidate = join(dirPath, filename);
        if (existsImpl(candidate) && !isDirImpl(candidate)) {
          return { mainPath: candidate, sessionDir: dirPath, layout: 'dir' };
        }
      }
      return { mainPath: null, sessionDir: dirPath, layout: 'dir' };
    }
  }

  return { mainPath: null, sessionDir: null, layout: 'none' };
}

/**
 * Find a session's transcript knowing ONLY its id — no recorded path, no cwd.
 *
 * Claude Code files transcripts under `~/.claude/projects/<cwd-slug>/`, and the
 * slug encoding is an implementation detail of a different program. Since the
 * session id is a uuid and therefore globally unique, scanning the project dirs
 * for `<id>.jsonl` gets the answer without reproducing that encoding, and keeps
 * working if the encoding changes.
 *
 * Takes the ids in PRIORITY ORDER and pays for ONE directory listing across all
 * of them — callers with a primary and a fallback id (and callers behind polled
 * endpoints) would otherwise pay per candidate. Returns the first that exists,
 * else null. Never throws.
 */
/**
 * Is this string safe to interpolate into a transcript path?
 *
 * The whitelist runs BEFORE the filesystem, the same ordering as
 * `sanitizeSubagentId` and the sanitizeUuid family. It matters most for the
 * automations callers: a run's `sessionId` is read from
 * `automations/cache/<slug>.json`, which is brain-synced and hand-editable, so
 * a teammate's edit (or a corrupted record) could otherwise put `../../..` into
 * a path we join and read. The charset is deliberately broader than a UUID —
 * claude's id format is its business, not ours — but contains no separator, no
 * dot, and no NUL, so traversal is structurally impossible rather than merely
 * unlikely.
 *
 * Exported so every consumer of a recorded session id shares ONE definition of
 * safe: a second copy of this regex somewhere else is a second thing to keep in
 * sync, and the copy that drifts is the one that lets a path through.
 */
export function isSafeSessionId(id: string | null | undefined): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export function findTranscriptBySessionId(ids: string[], home: string = homedir()): string | null {
  const wanted = ids.filter((id) => isSafeSessionId(id));
  if (wanted.length === 0) return null;
  try {
    const base = join(home, '.claude', 'projects');
    if (!existsSync(base)) return null;
    const dirs = readdirSync(base);
    for (const id of wanted) {
      for (const dir of dirs) {
        const p = join(base, dir, `${id}.jsonl`);
        if (existsSync(p)) return p;
      }
    }
  } catch {
    /* an unreadable projects dir is a "not found", never a throw */
  }
  return null;
}

/**
 * Resolve a tab/pane's roster id to the transcript of its LIVE conversation: prefer
 * the tab-session map's current id (the tab `/clear`d or in-TUI-resumed to a different
 * conversation), fall back to the pinned id's transcript.
 *
 * The single home of the roster-id → live-transcript invariant — title, session-model,
 * session-stats and `tasks handoff`'s partial digest all read through here, so a
 * rotation can never leave one of them tracking a stale file. Lived in
 * `agent-terminal.ts` until the context-handoff work needed it from the CLI too; the
 * CLI cannot import a server route, so it moved here rather than being re-spelled.
 *
 * `contextRoot` may be null, which means "no map — pinned transcript only".
 */
export function liveTranscriptPath(contextRoot: string | null, id: string, home?: string): string | null {
  const liveId = contextRoot ? resolveAgentSession(contextRoot, id) : '';
  return findTranscriptBySessionId([liveId, id], home ?? homedir());
}

/** Cap on subagent transcripts harvested per session. */
export const SUBAGENT_HARVEST_CAP = 20;

const AGENT_JSONL_RE = /^agent-.*\.jsonl$/;

/**
 * List `<sessionDir>/subagents/agent-*.jsonl`, newest-mtime first, capped at
 * `SUBAGENT_HARVEST_CAP` (or `opts.max`). `[]` when `loc.sessionDir` is null
 * or the `subagents/` dir is absent/unreadable. Never throws.
 */
export function listSubagentTranscripts(
  loc: TranscriptLocation,
  opts: {
    max?: number;
    readdirImpl?: (p: string) => string[];
    statImpl?: (p: string) => { mtimeMs: number };
  } = {},
): string[] {
  if (!loc.sessionDir) return [];

  const readdirImpl = opts.readdirImpl ?? ((p: string) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  });
  const statImpl = opts.statImpl ?? ((p: string) => statSync(p));
  const max = opts.max ?? SUBAGENT_HARVEST_CAP;

  const subagentsDir = join(loc.sessionDir, 'subagents');
  const entries = readdirImpl(subagentsDir).filter((f) => AGENT_JSONL_RE.test(f));

  const withMtime = entries.map((f) => {
    const full = join(subagentsDir, f);
    let mtimeMs = 0;
    try {
      mtimeMs = statImpl(full).mtimeMs;
    } catch {
      // unreadable — sorts as oldest (0), still included
    }
    return { full, mtimeMs };
  });

  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime.slice(0, max).map((e) => e.full);
}

/** `'…/agent-a80407b614ff89f5e.jsonl'` → `'a80407b614ff89f5e'`. */
export function subagentIdFromPath(p: string): string {
  const b = basename(p);
  const m = b.match(/^agent-(.+)\.jsonl$/);
  return m ? m[1] : b;
}

// ─── Whose conversation is this? (hands-free: the projects chosen at start) ──────────────

/** How far into a transcript the launch dir is looked for. Measured over 3399 real
 *  transcripts: lines 0-1 never carry `cwd`; the first one appears by line 9 / 23 KB. */
export const OWNER_SCAN_BYTES = 64 * 1024;
export const OWNER_SCAN_LINES = 50;

/** `mine`: the transcript's launch dir belongs to one of the asked projects. `other`: it exists
 *  and belongs elsewhere — or names no launch dir within the bound, or cannot be read: FAIL
 *  CLOSED. `none`: there is no transcript (a new tab, or a live chat Claude has not flushed). */
export type TranscriptOwner = 'mine' | 'other' | 'none';

/** One place a conversation can belong: a registered project root, or one of its git
 *  worktrees (owned by that project). Realpaths. */
export interface OwnerCandidate { path: string; owner: string }

/** The first record's `cwd` (the launch dir; a later `cd` is ignored), or null. Never throws. */
export function transcriptLaunchCwd(path: string): string | null {
  let buf: Buffer;
  try {
    const fd = openSync(path, 'r');
    try {
      buf = Buffer.alloc(OWNER_SCAN_BYTES);
      buf = buf.subarray(0, readSync(fd, buf, 0, OWNER_SCAN_BYTES, 0));
    } finally { closeSync(fd); }
  } catch { return null; }
  const lines = buf.toString('utf-8').split('\n').slice(0, OWNER_SCAN_LINES);
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    const cwd = (rec as { cwd?: unknown } | null)?.cwd;
    if (typeof cwd === 'string' && cwd) return cwd;
  }
  return null;
}

function real(p: string): string | null {
  try { return canonicalPath(p); } catch { return null; }
}

/** Is `p` the dir `root` or inside it (realpaths; never a bare string prefix)? */
function within(p: string, root: string): boolean {
  // The platform separator: both sides are canonical native paths (`C:\…` on Windows).
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Every registered project root plus its git worktrees, each owned by its project. A project's
 * worktrees count only when the project IS its repo's top level (`git rev-parse
 * --show-toplevel` equals the root): a project inside a parent repo never inherits the
 * parent's worktrees. A linked code repo's worktree is nobody's here (`other`), intended.
 */
export function buildOwnerCandidates(roots: readonly string[], git: (cwd: string, args: string[]) => string = runGit): OwnerCandidate[] {
  const out: OwnerCandidate[] = [];
  for (const root of roots) {
    const r = real(root);
    if (!r) continue;
    out.push({ path: r, owner: r });
    let top: string | null = null;
    try { top = real(git(r, ['rev-parse', '--show-toplevel']).trim()); } catch { /* not a repo */ }
    if (top !== r) continue;
    let list = '';
    try { list = git(r, ['worktree', 'list', '--porcelain']); } catch { continue; }
    for (const line of list.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const wt = real(line.slice('worktree '.length).trim());
      if (wt && wt !== r) out.push({ path: wt, owner: r });
    }
  }
  return out;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
}

let candidateCache: { key: string; list: OwnerCandidate[] } | null = null;

/** {@link buildOwnerCandidates} over the registry, rebuilt only when the registry changes. */
export function registeredOwnerCandidates(home?: string): OwnerCandidate[] {
  const roots = listVaults(home).map((v) => v.path);
  const key = JSON.stringify(roots);
  if (candidateCache?.key !== key) candidateCache = { key, list: buildOwnerCandidates(roots) };
  return candidateCache.list;
}

/** Drop the cached candidate set (each Mac-mode start, and tests). */
export function resetOwnerCandidates(): void { candidateCache = null; }

/**
 * THE chokepoint every id-taking phone route calls on the exact transcript it resolved (a
 * sub-agent's by its parent's). `projectRoots`: the projects the request may see. The CLOSEST
 * candidate owning the launch dir decides (the longest match), so a chosen /p/foo does not own
 * a registered /p/foo/sub's chats, and /p/foo never owns /p/foo-bar.
 */
export function transcriptOwnerCheck(path: string | null, projectRoots: readonly string[], candidates: readonly OwnerCandidate[]): TranscriptOwner {
  if (!path) return 'none';
  if (!existsSync(path)) return 'none';
  const cwd = transcriptLaunchCwd(path);
  if (!cwd) return 'other';
  const at = real(cwd);
  if (!at) return 'other';
  let best: OwnerCandidate | null = null;
  for (const c of candidates) {
    if (within(at, c.path) && (!best || c.path.length > best.path.length)) best = c;
  }
  if (!best) return 'other';
  const mine = projectRoots.map(real).filter((r): r is string => !!r);
  return mine.includes(best.owner) ? 'mine' : 'other';
}
