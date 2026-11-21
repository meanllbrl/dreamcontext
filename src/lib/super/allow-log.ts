/**
 * A child's allow log (plan super-v3 K5): every command its Super allowed, newest last, so the
 * window can say "Claude allowed N commands … · Show" under the Super's message (D8).
 *
 * Only the summary is kept: the command on one line for a shell call, the tool name and its
 * target for anything else (never file content or a diff), secrets redacted, at most
 * MAX_ALLOW_SUMMARY chars. The log is bounded by its stored bytes (`boundAllows`), cleared when
 * the child ends (store.ts) and left out of the remote view.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { oneLine } from './jobs.js';
import { redactSecrets } from '../telegram/format.js';
import { MAX_ALLOW_SUMMARY, boundAllows, type SuperAllowEntry, type SuperChild } from './types.js';

/** The tools whose target is one file path (`file_path`, the permission's own text). */
const PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);

/** `path` lies inside `folder` (both absolute; `..` never escapes). */
function inside(folder: string, path: string): boolean {
  if (!isAbsolute(folder) || !isAbsolute(path)) return false;
  const rel = relative(resolve(folder), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * One entry for the request the Super allowed: `text` is what the permission names (a shell
 * command, a file path, a description). `inFolder` only for a file tool whose path is inside the
 * child's own worktree: a shell command is never proven to stay there.
 */
export function allowEntry(toolName: string, text: string, worktree: string | undefined, at: number): SuperAllowEntry {
  const target = oneLine(text);
  const summary = redactSecrets(toolName === 'Bash' ? target : `${toolName} ${target}`.trim()).slice(0, MAX_ALLOW_SUMMARY);
  const inFolder = !!worktree && PATH_TOOLS.has(toolName) && inside(worktree, target);
  return { at, summary: summary || toolName.slice(0, MAX_ALLOW_SUMMARY), ...(inFolder ? { inFolder: true } : {}) };
}

/** Append `entry` to the child's log, bounded by bytes (oldest dropped). */
export function appendAllow(ch: SuperChild, entry: SuperAllowEntry): void {
  ch.allows = boundAllows([...(ch.allows ?? []), entry]);
}

/** The window's folded line under the Super's message (D8): "inside this job's own folder"
 *  only when EVERY logged command stayed there. Null with nothing logged. */
export function allowsLine(allows: readonly SuperAllowEntry[] | undefined): string | null {
  const n = allows?.length ?? 0;
  if (!n) return null;
  const where = allows!.every((a) => a.inFolder === true) ? ' inside this job\'s own folder' : '';
  return `Claude allowed ${n} command${n === 1 ? '' : 's'}${where}`;
}
