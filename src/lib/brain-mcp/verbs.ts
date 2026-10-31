/**
 * What the brain MCP server lets a sandboxed tool run (Track T W3, plan r5 §4a). A Codex chat
 * writes to the brain through `dreamcontext mcp serve`; this is its whole surface:
 *
 *   - only the verb paths below (a drift test proves each one still exists in `createProgram`);
 *   - no option that points the CLI at another vault, project or home;
 *   - no argument that names a path outside the vault, or reaches it through a symlink below the
 *     realpath'd root.
 *
 * Deliberately NOT here (never wider than a Claude chat's own reach, and nothing that drives the
 * app or the machine): `window`, `super`, `automations`, `dashboard`, `brain`, `link`, `peer`,
 * `connect`, `upgrade`, `install-*`, `hook`, `sleep` (the sleep flow is the owner's, on Claude).
 */
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Verb paths a call may start with. `tasks handoff` is the Eco record (§4d). Every entry is a LEAF
 * command (no subcommands; the drift test holds it): a group such as top-level `recall` (recall's
 * own on/off/cloud-key controls) would let its first argument pick a subcommand.
 */
export const BRAIN_VERBS: readonly (readonly string[])[] = [
  ['snapshot'],
  ['memory', 'recall'],
  ['memory', 'remember'],
  ['memory', 'list'],
  ['tasks', 'list'],
  ['tasks', 'create'],
  ['tasks', 'insert'],
  ['tasks', 'log'],
  ['tasks', 'handoff'],
  ['tasks', 'status'],
  ['tasks', 'start'],
  ['tasks', 'complete'],
  ['bookmark', 'add'],
  ['bookmark', 'list'],
  ['knowledge', 'index'],
];

/** Options that would move the CLI off this vault. Refused in any spelling (`--x`, `--x=…`). */
const FOREIGN_OPTIONS = /^--?(vault|vaults|peer|peers|all-vaults|all|project|projects|root|cwd|home|context-root|federat\w*|global)(=|$)/i;
/** Options whose value is a file path: checked like a path even when it looks like text. */
const PATH_OPTIONS = /^--(file|from-file|body-file|path|out|output|dir|input)(=|$)/i;

export class BrainVerbError extends Error {}

/** The allowlisted verb `args` starts with, or null. Help flags are not verbs. */
export function matchVerb(args: readonly string[]): readonly string[] | null {
  for (const verb of BRAIN_VERBS) {
    if (verb.every((w, i) => args[i] === w)) return verb;
  }
  return null;
}

function looksLikePath(a: string): boolean {
  return isAbsolute(a) || a.startsWith('~') || a.startsWith('./') || a.startsWith('../') || a === '..' || a.split(/[\\/]/).includes('..');
}

/**
 * `p` (relative to the vault) stays inside the vault and reaches it through no symlink below the
 * root: every existing component from the vault down to `p` is a plain directory or file.
 */
export function confinedToVault(p: string, vault: string): boolean {
  let realVault: string;
  try { realVault = realpathSync(vault); } catch { return false; }
  const abs = resolve(realVault, p.startsWith('~') ? '/nonexistent-home-path' : p);
  const rel = relative(realVault, abs);
  if (rel === '' ) return true;
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  let cur = realVault;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch { return true; } // the rest does not exist yet: nothing to follow
    if (st.isSymbolicLink()) return false;
  }
  return true;
}

/** Throws a BrainVerbError naming the first reason `args` may not run; returns the verb. */
export function checkBrainArgs(args: readonly string[], vault: string): readonly string[] {
  if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== 'string')) throw new BrainVerbError('args must be a non-empty list of strings.');
  if (args.length > 64 || args.some((a) => a.length > 20_000)) throw new BrainVerbError('Too many or too long arguments.');
  const verb = matchVerb(args);
  if (!verb) throw new BrainVerbError(`Not allowed here: dreamcontext ${args.slice(0, 2).join(' ')}. Allowed: ${BRAIN_VERBS.map((v) => v.join(' ')).join(', ')}.`);
  for (let i = verb.length; i < args.length; i++) {
    const a = args[i]!;
    if (a.includes('\0')) throw new BrainVerbError('NUL in an argument.');
    if (FOREIGN_OPTIONS.test(a)) throw new BrainVerbError(`${a.split('=')[0]} is refused: this server works on this vault only.`);
    const pathOpt = PATH_OPTIONS.exec(a);
    if (pathOpt) {
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1] ?? '';
      if (!confinedToVault(value, vault)) throw new BrainVerbError(`${value} is outside the vault (or reached through a link).`);
      if (!a.includes('=')) i++;
      continue;
    }
    if (looksLikePath(a) && !confinedToVault(a, vault)) throw new BrainVerbError(`${a} is outside the vault (or reached through a link).`);
  }
  return verb;
}

/** The project folder of a vault (`<project>/_dream_context`). */
export function projectOfVault(vault: string): string {
  return dirname(vault);
}
