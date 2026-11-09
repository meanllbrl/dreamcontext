/**
 * Ordinary work never waits on a card (owner 2026-11-09: "bu izni istemesin, yapsın işini").
 *
 * A member's Super and every Super child run with nobody watching. At `auto` Claude still stops on
 * a file tool that reaches outside the project's folders (`/tmp/gal/peek.py` → "It works outside
 * this project's folders"), so a member job sat on a card for a scratch file. This decides, for a
 * crew session whose mode is `auto` or `bypassPermissions`, which of those requests are ordinary
 * work the server answers yes to itself:
 *  - a read (Read, Glob, Grep, LS, NotebookRead) anywhere, except a secret place;
 *  - a write (Write, Edit, MultiEdit, NotebookEdit) inside the project, a linked repo or its
 *    worktrees, or a temp folder (`/tmp`, the OS temp folder), except a secret or guarded place.
 * Everything else (a write elsewhere, Bash, MCP, web, a question) keeps its card: sending,
 * publishing, deleting and money are judged by the auto classifier or the owner, never here.
 *
 * The target is resolved through its nearest existing folder (`realpath`), so a link planted in
 * `/tmp` that points into the home is judged by where it really lands.
 */
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { bypassNeedsOwner } from '../t3-bridge/policy.js';

const READS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Modes in which the owner already let the agent work on its own. */
export function ordinaryWorkMode(mode: string | null | undefined): boolean {
  return mode === 'auto' || mode === 'bypassPermissions';
}

export interface OrdinaryWorkContext {
  /** The session's project folder. */
  cwd: string;
  /** Linked repos and their worktrees (already real paths). */
  roots?: readonly string[];
  home?: string;
  /** Temp folders; defaults to `/tmp` and the OS temp folder. */
  tmpRoots?: readonly string[];
}

/** The real path of `abs`: its nearest existing folder resolved, the missing rest appended. */
function realOf(abs: string): string {
  let at = abs;
  let rest = '';
  for (;;) {
    try { return join(realpathSync(at), rest); } catch { /* not there yet */ }
    const up = dirname(at);
    if (up === at) return abs;
    rest = rest ? join(basename(at), rest) : basename(at);
    at = up;
  }
}

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

const SECRET_NAME = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_[a-z0-9_]+(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keychain(?:-db)?)|credentials(?:\.json)?|service-account.*\.json)$/i;
const SECRET_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.dreamcontext', '.claude', '.codex', '.gemini', join('.config', 'gcloud'), join('.config', 'gh'), join('Library', 'Keychains')];

/** A place whose content is a credential or the agent's own controls: always the owner's. */
export function isSecretPlace(real: string, home: string = homedir()): boolean {
  if (SECRET_NAME.test(basename(real))) return true;
  const h = realOf(home);
  return SECRET_HOME_DIRS.some((d) => inside(real, join(h, d)));
}

/** A place a write must not reach on its own: hooks and settings that change what runs next. */
function isControlPlace(real: string): boolean {
  return /(?:^|[\\/])\.git[\\/]hooks(?:[\\/]|$)|(?:^|[\\/])\.claude[\\/]settings[^\\/]*$|(?:^|[\\/])\.mcp\.json$/.test(real);
}

function targetOf(tool: string, input: Record<string, unknown>): string | null {
  const v = tool === 'NotebookEdit' || tool === 'NotebookRead'
    ? (input.notebook_path ?? input.file_path)
    : tool === 'Glob' || tool === 'Grep' || tool === 'LS' ? (input.path ?? '') : input.file_path;
  return typeof v === 'string' ? v : null;
}

/**
 * True when this permission request is ordinary work the server answers yes to. Never throws:
 * anything it cannot judge stays the owner's card.
 */
export function ordinaryWorkAllows(tool: string, rawInput: unknown, ctx: OrdinaryWorkContext): boolean {
  try {
    if (!READS.has(tool) && !WRITES.has(tool)) return false;
    const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
    const home = ctx.home ?? homedir();
    const named = targetOf(tool, input);
    if (named === null) return false;
    const raw = named === '' ? ctx.cwd : named.startsWith('~/') ? join(home, named.slice(2)) : named;
    const real = realOf(isAbsolute(raw) ? resolve(raw) : resolve(ctx.cwd, raw));
    if (isSecretPlace(real, home)) return false;
    if (READS.has(tool)) return true;
    if (isControlPlace(real) || bypassNeedsOwner(tool, input, ctx.cwd)) return false;
    const roots = [ctx.cwd, ...(ctx.roots ?? [])].map(realOf);
    const tmps = (ctx.tmpRoots ?? ['/tmp', tmpdir()]).map(realOf);
    // A temp root that is the home or the disk itself is no temp folder.
    const realHome = realOf(home);
    const okTmps = tmps.filter((t) => t !== realHome && t !== parse(t).root && !inside(realHome, t));
    return roots.some((r) => inside(real, r)) || okTmps.some((t) => inside(real, t));
  } catch {
    return false;
  }
}
