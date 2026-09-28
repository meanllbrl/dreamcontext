import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * The Develop-mode lead-edit BACKSTOP (task develop-mode-runs-like-goal-skill-…, R5).
 *
 * In a Develop chat the lead orchestrates and builders write the product code. The server sets
 * `DREAMCONTEXT_DEVELOP_LEAD=1` in the chat child's env only when the chat's mode is develop
 * (and `''` otherwise, so an inherited value can never leak into another mode); builders are
 * spawned with it stripped. The PreToolUse hook asks this predicate on every Edit/Write/
 * MultiEdit: the lead's own tools may only reach `<root>/_dream_context/` and `<root>/tmp/`.
 *
 * A backstop for the TOOL path only: shell writes (`sed -i`, a heredoc) are not blocked here,
 * the per-wave gate's whole-tree snapshot is the second net. Deliberately no marker file: a
 * session-id-keyed marker goes stale on /clear, resume, a crash or a mode switch; the env of
 * the chat child is exactly as long-lived as the lead it describes.
 *
 * Pure in its inputs (the hook passes the env value, the root and its own nested-claude
 * verdict), so every case is a unit test. It reads the filesystem only to realpath: a Write
 * creates a file that does not exist yet, so the DEEPEST EXISTING ancestor is realpath'd and
 * the rest re-appended; the root and the two allowed dirs are realpath'd too (a symlinked
 * checkout, macOS /var vs /private/var, a brain that is itself a symlink).
 */
export interface DevelopLeadWriteInput {
  /** The tool's `file_path`, absolute or relative to the project root. */
  filePath: string;
  /** The project root (the parent of `_dream_context/`), or null when none was found. */
  root: string | null;
  /** `process.env.DREAMCONTEXT_DEVELOP_LEAD`. Only `'1'` arms the guard; empty = unset. */
  envValue: string | undefined;
  /** The hook fired inside a nested claude (a sub-process of the lead), not the lead itself. */
  nested: boolean;
}

/** The two trees the lead's own Edit/Write may reach. */
const LEAD_WRITABLE = ['_dream_context', 'tmp'] as const;

export function developLeadWriteDenied(i: DevelopLeadWriteInput): boolean {
  if (i.envValue !== '1') return false;
  if (i.nested) return false;
  // Armed, but no project to scope against: refuse rather than guess.
  if (!i.root) return true;
  try {
    const realRoot = realpathSync(i.root);
    const target = realpathOfDeepestAncestor(resolve(i.root, i.filePath));
    return !LEAD_WRITABLE.some((dir) => {
      const lexical = join(realRoot, dir);
      const real = existsSync(lexical) ? realpathSync(lexical) : lexical;
      return [lexical, real].some((a) => target === a || target.startsWith(a + sep));
    });
  } catch {
    return true;
  }
}

/** Realpath whatever ancestor of `p` exists, then re-attach the missing tail. Throws when even
 *  that fails, so the caller denies. */
function realpathOfDeepestAncestor(p: string): string {
  let current = p;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`no existing ancestor for ${p}`);
    tail.unshift(basename(current));
    current = parent;
  }
  const real = realpathSync(current);
  return tail.length === 0 ? real : join(real, ...tail);
}

/** What the lead is told when its Edit/Write is denied. */
export const DEVELOP_LEAD_DENY_REASON = [
  'Blocked: in a Develop run the lead writes no product code.',
  'Resume the builder that owns this file with the change (see `dreamcontext goal-live recipe develop`, section 4).',
  'Your own Edit/Write may only reach _dream_context/ and tmp/ (the task file, briefs, logs).',
].join(' ');
