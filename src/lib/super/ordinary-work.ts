/**
 * Ordinary work never waits on a card (owner 2026-11-09: "bu izni istemesin, yapsın işini").
 *
 * A member's Super and every Super child run with nobody watching. At `auto` Claude still stops on
 * a file tool that reaches outside the project's folders (`/tmp/gal/peek.py` → "It works outside
 * this project's folders"), so a member job sat on a card for a scratch file. This decides, for a
 * crew session whose mode is `auto` or `bypassPermissions`, which of those requests are ordinary
 * work the server answers yes to itself:
 *  - a read or a write (Read, Glob, Grep, LS, NotebookRead; Write, Edit, MultiEdit, NotebookEdit)
 *    inside the project, a linked repo or its worktrees, or a temp folder (`/tmp`, the OS temp
 *    folder): never a secret, never dreamcontext's or Claude's own temp files, and a write never
 *    into a dot folder or dot file (`.git`, `.claude`, `.vscode`…), which changes what runs next.
 *  Reads elsewhere (the rest of the home, other projects, app data) keep their card: a list of
 *  secret names can never be complete, so the rule is by place.
 *  - a Bash command that only deletes scratch (owner 2026-11-09, kitup: a child stopped on
 *    removing its own temp files): one or more plain `rm` calls, joined by `&&` or `;`, whose every
 *    target sits strictly inside a temp folder, where children keep their scratch. The project's
 *    `_dream_context/tmp/` is NOT such a place: it also holds dreamcontext's own state (plans,
 *    locks, run ledgers, the only copy of folded journals), so a delete there goes to the Super. See
 *    {@link scratchRmAllows} for the exact shape; anything else in the command keeps its card.
 * Everything else (a write elsewhere, any other Bash, MCP, web, a question) keeps its card: sending,
 * publishing, deleting elsewhere and money are judged by the auto classifier or the owner, never here.
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
  /** Compare paths without case (darwin and win32 file systems ignore it); defaults to the host's. */
  foldCase?: boolean;
  /** The session's project folder. */
  cwd: string;
  /** Linked repos and their worktrees (already real paths). */
  roots?: readonly string[];
  home?: string;
  /** Temp folders; defaults to `/tmp` and the OS temp folder. */
  tmpRoots?: readonly string[];
  /** The session's `$TMPDIR` (a Bash `rm $TMPDIR/…` names it); defaults to the server's. Unset:
   *  a command naming it is not judged here (an empty `$TMPDIR` would delete from the disk root). */
  tmpdirEnv?: string;
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

function targetOf(tool: string, input: Record<string, unknown>): string | null {
  const v = tool === 'NotebookEdit' || tool === 'NotebookRead'
    ? (input.notebook_path ?? input.file_path)
    : tool === 'Glob' || tool === 'Grep' || tool === 'LS' ? (input.path ?? '') : input.file_path;
  return typeof v === 'string' ? v : null;
}

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

const SECRET_NAME = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_[a-z0-9_]+(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keychain(?:-db)?)|credentials(?:\.json)?|service-account.*\.json)$/i;
const SECRET_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.dreamcontext', '.claude', '.codex', '.gemini', '.config', join('Library', 'Keychains')];
/** What dreamcontext and Claude keep in the temp folder: live chat settings, mode notes, askpass
 *  tokens, browser configs, background task output. Never scratch, never read or written here. */
const OWN_TEMP = /^(?:dreamcontext|dc-|claude)/i;

/**
 * True when this permission request is ordinary work the server answers yes to. Never throws:
 * anything it cannot judge stays the owner's card.
 */
export function ordinaryWorkAllows(tool: string, rawInput: unknown, ctx: OrdinaryWorkContext): boolean {
  try {
    if (tool === 'Bash') {
      const command = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>).command : undefined;
      return typeof command === 'string' && scratchRmAllows(command, ctx);
    }
    if (!READS.has(tool) && !WRITES.has(tool)) return false;
    const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
    const fold = (ctx.foldCase ?? (process.platform === 'darwin' || process.platform === 'win32'))
      ? (x: string): string => x.toLowerCase() : (x: string): string => x;
    const home = ctx.home ?? homedir();
    const named = targetOf(tool, input);
    if (named === null) return false;
    const raw = named === '' ? ctx.cwd : named === '~' ? home : named.startsWith('~/') ? join(home, named.slice(2)) : named;
    const real = fold(realOf(isAbsolute(raw) ? resolve(raw) : resolve(ctx.cwd, raw)));
    const realHome = fold(realOf(home));
    const secretDirs = SECRET_HOME_DIRS.map((d) => fold(join(realHome, d)));
    if (SECRET_NAME.test(basename(real)) || secretDirs.some((d) => inside(real, d))) return false;
    // A temp root that is the home or the disk itself is no temp folder.
    const tmps = (ctx.tmpRoots ?? ['/tmp', tmpdir()]).map((t) => fold(realOf(t)))
      .filter((t) => t !== realHome && t !== parse(t).root && !inside(realHome, t));
    const tmpRel = (p: string): string | null => {
      const t = tmps.find((r) => inside(p, r));
      return t === undefined ? null : p.slice(t.length).replace(/^[\\/]+/, '');
    };
    const ownTemp = (p: string): boolean => OWN_TEMP.test((tmpRel(p) ?? '').split(/[\\/]/)[0] ?? '');
    if (ownTemp(real)) return false;
    // A root that is the home or the disk is no project folder.
    const roots = [ctx.cwd, ...(ctx.roots ?? [])].map((r) => fold(realOf(r)))
      .filter((r) => r !== parse(r).root && !inside(realHome, r));
    const base = roots.find((r) => inside(real, r)) ?? tmps.find((t) => inside(real, t));
    // Reads and writes alike only where the job works: the project, a linked repo, a temp folder.
    // Anywhere else (the rest of the home, other projects, app data) stays the owner's card.
    if (base === undefined) return false;
    if (READS.has(tool)) {
      // A Glob's absolute pattern names its own folder: it must sit there too.
      const pat = tool === 'Glob' && typeof input.pattern === 'string' ? input.pattern : '';
      // A `..` anywhere in a pattern climbs out of the folder it names: the owner's to allow.
      if (pat && pat.split(/[\\/]/).includes('..')) return false;
      if (pat && (isAbsolute(pat) || pat.startsWith('~'))) {
        // The folder before the first wildcard (cut at its last separator: `orbit*` is no folder).
        const lead = pat.replace(/^~(?=\/|$)/, home).split(/[*?[{]/)[0] ?? '';
        const fixed = lead.slice(0, Math.max(lead.lastIndexOf('/'), 0)) || '/';
        const at = fold(realOf(resolve(fixed || '/')));
        if (!roots.some((r) => inside(at, r)) && !tmps.some((t) => inside(at, t))) return false;
        if (ownTemp(at) || secretDirs.some((d) => inside(at, d) || inside(d, at))) return false;
      }
      // A search over a whole temp root also walks dreamcontext's own files there.
      if (tool !== 'Read' && tool !== 'NotebookRead' && tmps.includes(real)) return false;
      return true;
    }
    if (bypassNeedsOwner(tool, input, ctx.cwd)) return false;
    // Inside a root, a write to a dot folder or dot file (.git, .claude, .vscode, .husky, .envrc,
    // .mcp.json…) changes what runs next: those are exactly what Claude still asks about there.
    if (real === base) return false;
    return !real.slice(base.length).split(/[\\/]/).some((seg) => seg.startsWith('.'));
  } catch {
    return false;
  }
}

/** A word of a scratch `rm`: no quote, variable, glob class, redirect, pipe, subshell or escape. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,.\/*-]+$/;
const RM_FLAGS = /^(?:-[rRfdv]+|--recursive|--force|--dir|--verbose)$/;

/**
 * True when `command` only deletes scratch: `rm [flags] <path>…`, one or more joined by `&&` or
 * `;`, every path strictly inside a temp folder (never the folder itself, never dreamcontext's or
 * Claude's own files there). A path may
 * start with `$TMPDIR` or `${TMPDIR}` (optionally in double quotes, nothing else quoted); a `*`
 * only in its last part, never before a trailing `/` (which would follow a link out) and never
 * right under a root (that empties the whole temp folder); no `..`.
 * Each target is resolved through `realpath`, so a link planted in the temp folder that points
 * into the home is judged by where it lands. Anything else (another command, a pipe, a
 * substitution, a redirect, `~`, a relative path) is not judged here and keeps its card.
 */
export function scratchRmAllows(command: string, ctx: OrdinaryWorkContext): boolean {
  try {
    if (command.length > 4000 || /[\n\r`|<>(){}\\'!#?[\]~]/.test(command.replace(/\$\{TMPDIR\}/g, '$TMPDIR'))) return false;
    const fold = (ctx.foldCase ?? (process.platform === 'darwin' || process.platform === 'win32'))
      ? (x: string): string => x.toLowerCase() : (x: string): string => x;
    const home = ctx.home ?? homedir();
    const realHome = fold(realOf(home));
    const tmpEnv = ctx.tmpdirEnv ?? process.env.TMPDIR;
    const tmps = (ctx.tmpRoots ?? ['/tmp', tmpdir()]).map((t) => fold(realOf(t)))
      .filter((t) => t !== realHome && t !== parse(t).root && !inside(realHome, t));
    const roots = tmps;
    const segments = command.split(/&&|;/).map((c) => c.trim());
    if (!segments.length || segments.some((c) => !c)) return false;
    for (const seg of segments) {
      const words = seg.split(/\s+/);
      if (words[0] !== 'rm') return false;
      let operands = 0;
      let flagsDone = false;
      for (const w0 of words.slice(1)) {
        if (!flagsDone && w0 === '--') { flagsDone = true; continue; }
        if (!flagsDone && w0.startsWith('-')) { if (!RM_FLAGS.test(w0)) return false; continue; }
        // One pair of double quotes around the whole word, nothing else quoted.
        const w1 = /^"[^"]*"$/.test(w0) ? w0.slice(1, -1) : w0;
        if (w1.includes('"')) return false;
        let path = w1.replace(/^\$\{TMPDIR\}/, '$TMPDIR');
        if (path.startsWith('$TMPDIR')) {
          if (!tmpEnv || !isAbsolute(tmpEnv)) return false;
          const rest = path.slice('$TMPDIR'.length);
          if (rest && !rest.startsWith('/')) return false;
          path = tmpEnv.replace(/\/+$/, '') + rest;
        }
        if (path.includes('$') || !PLAIN_WORD.test(path) || !isAbsolute(path)) return false;
        const parts = path.split('/');
        if (parts.includes('..') || parts.includes('.')) return false;
        const star = path.indexOf('*');
        if (star >= 0 && path.slice(star).includes('/')) return false;
        const real = fold(realOf(resolve(path)));
        const root = roots.find((r) => real !== r && inside(real, r));
        if (root === undefined) return false;
        // A glob empties a folder: never a whole temp folder or the whole project tmp.
        if (star >= 0 && fold(realOf(dirname(resolve(path)))) === root) return false;
        const rel = real.slice(root.length).replace(/^[\\/]+/, '');
        if (OWN_TEMP.test(rel.split(/[\\/]/)[0] ?? '')) return false;
        if (SECRET_NAME.test(basename(real))) return false;
        operands++;
      }
      if (!operands) return false;
    }
    return true;
  } catch {
    return false;
  }
}
