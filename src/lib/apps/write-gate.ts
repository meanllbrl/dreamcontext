/**
 * The file gate of an app chat (plan-veri r3, K1): a PreToolUse hook on the file tools, for the
 * app's own assistant AND a bound AI Team member. A write lands only inside the app's own data
 * folder (`_dream_context/apps/<slug>/`); a read never reaches another app's data folder.
 *
 * The permission rules written at spawn are a belt (they enumerate what existed then); this gate
 * decides at every call, so a folder made after the chat started is covered too. It answers `{}`
 * or `deny`, never `allow`: a pass leaves the verdict to the permission rules.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { BashGateContext, BashGateDecision } from './bash-gate.js';
import { appsDataRoot, checkAppDataChain, foldName, isInstructionName, WRITE_REFUSED_NAMES } from './data-dir.js';

export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];
export const FILE_GATE_MATCHER = [...WRITE_TOOLS, ...READ_TOOLS].join('|');

const deny = (reason: string): BashGateDecision => ({ decision: 'deny', reason });

/** realpath of the nearest existing ancestor, the rest appended: a path that does not exist yet. */
function realNear(p: string): string {
  try { return realpathSync.native(p); } catch { /* not there yet */ }
  const parent = dirname(p);
  return parent === p ? p : join(realNear(parent), basename(p));
}

function inside(root: string, p: string, fold = false): boolean {
  const r = fold ? relative(foldName(root), foldName(p)) : relative(root, p);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
}

/** The literal folder a glob pattern starts in, or null when it starts with a wildcard. */
function globBase(pattern: string): string | null {
  const segs = pattern.split('/');
  const lit: string[] = [];
  for (const s of segs) {
    if (/[*?[\]{}]/.test(s)) break;
    lit.push(s);
  }
  const base = lit.join('/');
  return base || null;
}

function decideWrite(path: unknown, ctx: BashGateContext): BashGateDecision {
  const own = ctx.dataDir;
  if (typeof path !== 'string' || !isAbsolute(path)) return deny('Not written: give an absolute path inside this app\'s data folder.');
  if (!ctx.projectRoot) return deny('Not written: this chat has no data folder on record.');
  const chain = checkAppDataChain(ctx.projectRoot, ctx.slug);
  if (!chain.ok) return deny(`Not written: ${chain.path} is a symlink or not a folder.`);
  let realOwn: string;
  try { realOwn = realpathSync.native(own); } catch { return deny('Not written: this app\'s data folder is missing.'); }
  const target = realNear(resolve(path));
  if (!inside(realOwn, target)) return deny(`Not written: this assistant writes only inside its app's data folder, ${own}.`);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return deny('Not written: the target is a symlink.');
    if (st.isFile() && st.nlink > 1) return deny('Not written: the target has a second name (a hard link).');
  } catch { /* a new file */ }
  const segs = relative(realOwn, target).split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    if (isInstructionName(segs[i], !last, WRITE_REFUSED_NAMES) || (last && isInstructionName(segs[i], true, WRITE_REFUSED_NAMES.filter((n) => n.endsWith('/'))))) {
      return deny(`Not written: ${segs[i]} is an instruction or ignore file; app data is data, never instructions.`);
    }
  }
  return { decision: 'pass' };
}

/**
 * A Grep/Glob search root (its `path`, or the cwd when it names none) that holds the apps folder
 * would walk every app's data: refused, the search goes inside a folder that holds none.
 */
function decideSearchRoot(path: unknown, ctx: BashGateContext, cwd: string | undefined): BashGateDecision {
  if (!ctx.projectRoot) return { decision: 'pass' };
  const given = typeof path === 'string' && path ? path : cwd;
  if (!given) return deny('Not searched: name a folder to search in (not one that holds the apps data).');
  const abs = isAbsolute(given) ? given : cwd ? resolve(cwd, given) : null;
  if (!abs) return deny('Not searched: name an absolute folder to search in.');
  const appsRoot = appsDataRoot(ctx.projectRoot);
  let realApps = appsRoot;
  try { realApps = realpathSync.native(appsRoot); } catch { /* not made yet */ }
  const lex = resolve(abs);
  const real = realNear(lex);
  const holds = (p: string, root: string) => foldName(p) === foldName(root) || inside(p, root, true);
  if (holds(lex, appsRoot) || holds(real, realApps)) {
    return deny(`Not searched: ${given} holds every app's data. Search inside this app's data folder (${ctx.dataDir}) or a folder that holds no app data.`);
  }
  return { decision: 'pass' };
}

function decideRead(path: unknown, ctx: BashGateContext, cwd: string | undefined): BashGateDecision {
  if (typeof path !== 'string' || !path) return { decision: 'pass' };
  if (!ctx.projectRoot) return { decision: 'pass' };
  const abs = isAbsolute(path) ? path : cwd ? resolve(cwd, path) : null;
  if (!abs) return { decision: 'pass' };
  const appsRoot = appsDataRoot(ctx.projectRoot);
  let realApps = appsRoot;
  try { realApps = realpathSync.native(appsRoot); } catch { /* not made yet */ }
  const lex = resolve(abs);
  const real = realNear(lex);
  const hits = (p: string, root: string) => inside(root, p, true);
  const inApps = hits(lex, appsRoot) || hits(real, realApps);
  if (!inApps) return { decision: 'pass' };
  const ownLex = join(appsRoot, ctx.slug);
  const ownReal = join(realApps, ctx.slug);
  const isOwn = (p: string, root: string) => foldName(p) === foldName(root) || inside(root, p, true);
  if (isOwn(lex, ownLex) && isOwn(real, ownReal)) return { decision: 'pass' };
  return deny('Not read: another app\'s data folder is not this assistant\'s to read.');
}

/** Decide one file-tool call. Unknown tools pass (the matcher names the ones gated). */
export function classifyFileTool(tool: string, input: Record<string, unknown>, ctx: BashGateContext, cwd?: string): BashGateDecision {
  if (WRITE_TOOLS.includes(tool)) return decideWrite(input.file_path ?? input.notebook_path, ctx);
  if (tool === 'Read') return decideRead(input.file_path, ctx, cwd);
  if (tool === 'Grep' || tool === 'Glob') {
    const root = decideSearchRoot(input.path, ctx, cwd);
    if (root.decision !== 'pass') return root;
    const p = decideRead(input.path, ctx, cwd);
    if (p.decision !== 'pass') return p;
    const pattern = typeof input.pattern === 'string' && tool === 'Glob' ? globBase(input.pattern) : null;
    return pattern ? decideRead(pattern, ctx, typeof input.path === 'string' && isAbsolute(input.path) ? input.path : cwd) : p;
  }
  return { decision: 'pass' };
}
