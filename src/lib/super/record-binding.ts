/**
 * A Super record belongs to ONE Mac and ONE project folder (2026-11-03).
 *
 * The owner shared a repo whose brain lived inside it; the record (`state/.super-agent.json`) had
 * been committed by an install whose `.gitignore` lacked the line, and his friend's app opened
 * the owner's last spoken question and its card. Ignoring the file stops the next commit; this
 * stops a record that arrives anyway (an old commit, a copied folder, a zip) from being read as
 * this Mac's Super:
 *
 *   - every write stamps `bound: { machine, root }`: this Mac's id (`~/.dreamcontext/machine.json`,
 *     random, never synced) and the vault's real path;
 *   - a read whose stamp names another machine or another folder gets an empty record, and the
 *     next write sets the foreign file aside (`<file>.foreign-<time>`, ignored) before replacing it;
 *   - a stamp is not a secret (the machine id names synced thread files), so a record whose bytes
 *     are exactly what HEAD holds for it came from a commit (a pull overwrites an ignored file)
 *     and is foreign, stamp or not. HEAD, not the index: the owner's own `git add -A` stages his
 *     live record a moment before the sync's stage pass drops it again. This process's own last
 *     write is recognised without asking git;
 *   - an UNSTAMPED record (written before this change) is this Mac's unless git tracks it: a
 *     record in the index or in HEAD came from a commit, and is this Mac's only when its Super
 *     session's transcript is on this Mac, under any Claude account or Codex (a session id is
 *     never shared across machines).
 *
 * The decision reads the stamp, the session id and the bytes' git object id; nothing else.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { readMachineIdentity } from '../machine-id.js';
import * as git from '../git-sync/git.js';
import { findTranscriptBySessionId, isSafeSessionId } from '../transcript-locate.js';
import { listClaudeAccounts } from '../claude-accounts.js';
import { findCodexRollout } from '../t3-bridge/codex-threads.js';

export interface SuperBinding {
  machine: string;
  root: string;
}

const MACHINE_RE = /^[0-9a-f]{12}$/;

/** This Mac and this vault's real path: what a write stamps and a read compares. */
export function currentBinding(contextRoot: string): SuperBinding {
  let root = contextRoot;
  try { root = realpathSync.native(contextRoot); } catch { /* a vault that cannot be resolved compares as given */ }
  return { machine: readMachineIdentity().id, root };
}

/** The stamp in a parsed record, or null when it has none (or a malformed one). */
export function readBinding(raw: unknown): SuperBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = (raw as { bound?: unknown }).bound;
  if (!b || typeof b !== 'object') return null;
  const { machine, root } = b as { machine?: unknown; root?: unknown };
  if (typeof machine !== 'string' || !MACHINE_RE.test(machine)) return null;
  if (typeof root !== 'string' || root.length === 0 || root.length > 4096) return null;
  return { machine, root };
}

/** Whether a malformed `bound` is present (a present-but-unreadable stamp is never adopted). */
function hasBoundKey(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && 'bound' in (raw as object);
}

/** Repo-relative path of `absPath` in the git work tree around it, or null outside one. */
function repoPath(absPath: string): { top: string; rel: string } | null {
  let dir: string;
  try { dir = realpathSync.native(dirname(absPath)); } catch { return null; }
  const top = git.topLevel(dir);
  if (!top) return null;
  let realTop: string;
  try { realTop = realpathSync.native(top); } catch { return null; }
  let rel = relative(realTop, join(dir, basename(absPath)));
  if (rel.startsWith('..')) return null;
  if (process.platform === 'darwin') rel = rel.normalize('NFC');
  return { top: realTop, rel: rel.split(sep).join('/') };
}

/** Git holds `absPath` in its index or in HEAD. False outside a repo or when git cannot answer. */
export function trackedInGit(absPath: string): boolean {
  return gitBlobs(absPath).length > 0;
}

/** The object ids git holds for `absPath` (index, HEAD); empty outside a repo or untracked. */
function gitBlobs(absPath: string, which: 'index-and-head' | 'head' = 'index-and-head'): string[] {
  const at = repoPath(absPath);
  if (!at) return [];
  const specs = which === 'head' ? [`HEAD:${at.rel}`] : [`:${at.rel}`, `HEAD:${at.rel}`];
  return specs.map((spec) => git.blobId(at.top, spec)).filter((b): b is string => b !== null);
}

/** The git (SHA-1) object id of `text` as a blob. */
export function blobIdOf(text: string): string {
  const body = Buffer.from(text, 'utf-8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

/** A Super session's transcript is on this Mac: HOME's Claude projects, every registered Claude
 *  account's sandbox, Antigravity, or a Codex rollout. */
export function sessionIsHere(session: unknown, home: string = homedir()): boolean {
  if (typeof session !== 'string' || !isSafeSessionId(session)) return false;
  if (findTranscriptBySessionId([session], home) !== null) return true;
  let accounts: ReturnType<typeof listClaudeAccounts> = [];
  try { accounts = listClaudeAccounts(home); } catch { /* no register */ }
  for (const a of accounts) {
    if (!a.configDir) continue;
    const base = join(a.configDir, 'projects');
    let dirs: string[] = [];
    try { dirs = readdirSync(base); } catch { continue; }
    if (dirs.some((d) => existsSync(join(base, d, `${session}.jsonl`)))) return true;
  }
  try { return findCodexRollout(session, join(home, '.codex')) !== null; } catch { return false; }
}

/** The blob id of this process's last write of each record: its own bytes need no git. */
const ownWrites = new Map<string, string>();

/** The record store calls this after every write of `recordPath`. */
export function noteOwnWrite(recordPath: string, text: string): void {
  ownWrites.set(recordPath, blobIdOf(text));
}

/** Answers that cost git or a transcript search, per path and content, once per process. */
const verdictCache = new Map<string, boolean>();

export type BindingVerdict = 'mine' | 'legacy' | 'foreign';

/**
 * Whose is this record (`raw` parsed from `text`, read from `recordPath`)? `mine`: stamped for
 * this Mac and this folder, and not a copy of what git holds. `legacy`: no stamp, not from git (or
 * its session is here), adopted; the next write stamps it. `foreign`: anything else.
 */
export function bindingVerdict(raw: unknown, text: string, contextRoot: string, recordPath: string): BindingVerdict {
  const stamp = readBinding(raw);
  if (stamp) {
    const here = currentBinding(contextRoot);
    if (stamp.machine !== here.machine || stamp.root !== here.root) return 'foreign';
    const blob = blobIdOf(text);
    if (ownWrites.get(recordPath) === blob) return 'mine';
    const key = `${recordPath}\0${blob}`;
    let fromGit = verdictCache.get(key);
    if (fromGit === undefined) {
      fromGit = gitBlobs(recordPath, 'head').includes(blob);
      verdictCache.set(key, fromGit);
    }
    return fromGit ? 'foreign' : 'mine';
  }
  if (hasBoundKey(raw)) return 'foreign';
  const key = `${recordPath}\0legacy`;
  let mine = verdictCache.get(key);
  if (mine === undefined) {
    mine = !trackedInGit(recordPath) || sessionIsHere((raw as { session?: unknown } | null)?.session);
    verdictCache.set(key, mine);
  }
  return mine ? 'legacy' : 'foreign';
}

/** Tests only: forget the cached answers. */
export function resetBindingCache(): void {
  verdictCache.clear();
  ownWrites.clear();
}
