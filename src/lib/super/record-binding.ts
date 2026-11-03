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
 *   - an UNSTAMPED record (written before this change) is this Mac's unless git tracks it: a
 *     record in the index or in HEAD came from a commit, and is this Mac's only when its Super
 *     session's transcript is on this Mac (a session id is never shared across machines).
 *
 * Names and paths only; the record's content is never read to decide.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { readMachineIdentity } from '../machine-id.js';
import * as git from '../git-sync/git.js';
import { findTranscriptBySessionId } from '../transcript-locate.js';

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
  const at = repoPath(absPath);
  if (!at) return false;
  return git.blobId(at.top, `:${at.rel}`) !== null || git.blobId(at.top, `HEAD:${at.rel}`) !== null;
}

/** Unstamped records' answer (git, then the transcript), once per path per process. A stamped
 *  record never asks. */
const legacyCache = new Map<string, boolean>();

export type BindingVerdict = 'mine' | 'legacy' | 'foreign';

/**
 * Whose is this parsed record? `mine`: stamped for this Mac and this folder. `legacy`: no stamp,
 * not from git, adopted (the next write stamps it). `foreign`: anything else.
 */
export function bindingVerdict(raw: unknown, contextRoot: string, recordPath: string): BindingVerdict {
  const stamp = readBinding(raw);
  if (stamp) {
    const here = currentBinding(contextRoot);
    return stamp.machine === here.machine && stamp.root === here.root ? 'mine' : 'foreign';
  }
  if (hasBoundKey(raw)) return 'foreign';
  let mine = legacyCache.get(recordPath);
  if (mine === undefined) {
    const session = (raw as { session?: unknown } | null)?.session;
    mine = !trackedInGit(recordPath) || (typeof session === 'string' && findTranscriptBySessionId([session]) !== null);
    legacyCache.set(recordPath, mine);
  }
  return mine ? 'legacy' : 'foreign';
}

/** Tests only: forget the cached git answers. */
export function resetBindingCache(): void {
  legacyCache.clear();
}
