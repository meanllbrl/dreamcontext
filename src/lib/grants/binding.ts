/**
 * Who is asking (plan uye-bildirim K3 "Identity"): ONE function for every enforcer, fed only by
 * what the server wrote for a process it spawned itself.
 *
 * No environment marker and no argument is read for identity: a `claude` or a `dreamcontext
 * t3-chat` an agent starts itself, with any forged environment or another session's id, has no
 * binding of its own and gets nothing. A binding counts only when its pid, with the same start
 * time (a reused pid differs), is the caller itself (the bridge) or an ancestor of it (the hook;
 * measured on macOS: the hook's parent IS the spawned `claude`). The project is the binding's own:
 * an enforcer never reads it off the cwd (a child works in a worktree or a linked repo); a caller
 * that names one is held to it.
 * The hook must also report the binding's CURRENT conversation id, so a `claude` an agent starts
 * under a bound process, with its own conversation, is not that process.
 *
 * The cheap look comes first: the conversation id is a file lookup, and the process table is read
 * only on a hit, so an unbound session never pays for `ps`.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { bindingsByConversation, readBinding, type StoreOpts } from './store.js';
import type { Binding } from './types.js';

export interface ProcSys {
  selfPid: number;
  parentOf(pid: number): number | null;
  startTimeOf(pid: number): string | null;
  realpath(p: string): string | null;
}

export type WhoAmIMode = 'hook' | 'bridge';
export interface WhoAmIOpts extends StoreOpts { mode?: WhoAmIMode }

/** How far up the parent chain a hook looks (its parent may be a shell or a runner). */
export const MAX_ANCESTRY = 12;

function sameProject(b: Binding, project: string | undefined, sys: ProcSys): boolean {
  if (project === undefined) return true;
  const mine = sys.realpath(project);
  if (!mine) return false;
  return mine === b.project || sys.realpath(b.project) === mine;
}

function sameProcess(b: Binding, pid: number, sys: ProcSys): boolean {
  const started = sys.startTimeOf(pid);
  return !!started && started === b.startedAt;
}

/**
 * The binding of the process the caller runs under, or null. `mode` defaults to `hook`.
 * Bridge: the caller IS the bound process (its own pid's binding). Hook: the binding is found by
 * the reported conversation id, which must be its current one, and its pid must be an ancestor.
 */
export function whoAmI(call: { conversationId?: string; project?: string }, sys: ProcSys, opts?: WhoAmIOpts): Binding | null {
  try {
    const mode = opts?.mode ?? 'hook';
    if (mode === 'bridge') {
      const b = readBinding(sys.selfPid, opts);
      if (!b) return null;
      if (call.conversationId !== undefined && !b.conversationIds.includes(call.conversationId)) return null;
      if (!sameProject(b, call.project, sys) || !sameProcess(b, sys.selfPid, sys)) return null;
      return b;
    }
    const id = call.conversationId;
    if (!id) return null;
    const candidates = bindingsByConversation(id, opts).filter((b) => b.conversationIds[b.conversationIds.length - 1] === id);
    if (!candidates.length) return null;
    const chain: number[] = [];
    let pid = sys.parentOf(sys.selfPid);
    for (let i = 0; i < MAX_ANCESTRY && pid !== null && pid > 1; i += 1) {
      chain.push(pid);
      pid = sys.parentOf(pid);
    }
    for (const b of candidates) {
      if (!chain.includes(b.pid)) continue;
      if (!sameProject(b, call.project, sys) || !sameProcess(b, b.pid, sys)) continue;
      return b;
    }
    return null;
  } catch {
    return null;
  }
}

function ps(field: 'ppid=' | 'lstart=', pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', field, '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const v = out.trim().replace(/\s+/g, ' ');
    return v || null;
  } catch { return null; }
}

/**
 * The real process table. Measured on macOS only (premise step 4): on another platform every
 * read is null, so whoAmI returns nothing and the owner is asked each time, nothing is allowed.
 */
export function realProcSys(platform: NodeJS.Platform = process.platform): ProcSys {
  if (platform !== 'darwin') {
    return { selfPid: process.pid, parentOf: () => null, startTimeOf: () => null, realpath: () => null };
  }
  return {
    selfPid: process.pid,
    parentOf(pid) {
      const v = ps('ppid=', pid);
      const n = v === null ? NaN : Number(v);
      return Number.isInteger(n) && n > 0 ? n : null;
    },
    startTimeOf: (pid) => ps('lstart=', pid),
    realpath(p) {
      try { return realpathSync.native(p); } catch { return null; }
    },
  };
}

/** Is `cwd` (a real path) the root or inside one of `roots` (grantRoots of the binding's project)?
 *  The one check both enforcers make before a grant is matched: the cwd only resolves the call's
 *  paths, and a session that moved outside every root its project's agents work in is asked. */
export function cwdInRoots(cwd: string, roots: readonly string[]): boolean {
  return roots.some((r) => cwd === r || cwd.startsWith(r.endsWith('/') ? r : `${r}/`));
}
