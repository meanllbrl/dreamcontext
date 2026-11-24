// Orphaned chat children: a `claude -p` the dashboard server spawned outlived that server.
//
// Every chat child is its own process group on POSIX (agent-chat.ts `chatSpawnCommand`), so a
// signal to the server's group (the desktop shell's SIGTERM, then SIGKILL 1.5 s later) never
// reaches it. When the server died before ending its children (a SIGKILL, a crash, a shutdown
// that ran out of time), they were reparented to launchd (ppid 1) and kept working. The next
// server then resumed the same conversation and two processes wrote the same session and the
// same worktree.
//
// This is the backstop for that case, derived from what the OS says right now, never from a
// record: before a conversation is spawned again, any headless `claude` of this user still
// running it with ppid 1 is ended (whole group, SIGTERM then SIGKILL). An unreadable process
// table fails open (the spawn goes ahead, as it always did); an orphan of ANOTHER conversation
// is never touched (orphan-sweep.ts reaps the tools a GONE claude left, a different job).

import { cutProcessGroups } from '../lib/automations/runner.js';
import { TABLE_ARGS, isOwnerClaude, parseProcTable, runPs, type ProcRow, type RunPs } from '../lib/orphan-processes.js';

/**
 * The orphaned headless chat children running one of `ids`: this user's, ppid 1, a `claude`
 * executable running stream-json (what only a server spawns; a terminal `claude` the owner
 * started has a shell for a parent and no stream-json), with `--resume <id>` or
 * `--session-id <id>` as exact argv tokens. `selfPid` is never returned.
 */
export function orphanCopies(rows: Iterable<ProcRow>, ids: readonly string[], uid: number, selfPid = process.pid): number[] {
  const wanted = new Set(ids.filter((id) => !!id));
  if (wanted.size === 0) return [];
  const out: number[] = [];
  for (const r of rows) {
    if (r.ppid !== 1 || r.pid <= 1 || r.pid === selfPid || r.uid !== uid) continue;
    if (!isOwnerClaude(r)) continue;
    const argv = r.args.trim().split(/\s+/);
    if (!argv.includes('stream-json')) continue;
    for (let i = 0; i < argv.length - 1; i++) {
      if ((argv[i] === '--resume' || argv[i] === '--session-id') && wanted.has(argv[i + 1])) {
        out.push(r.pid);
        break;
      }
    }
  }
  return out;
}

export interface ReapDeps {
  platform?: NodeJS.Platform;
  runPs?: RunPs;
  uid?: number;
  cut?: (pids: number[]) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * End every orphaned copy of these conversations before one is spawned again. Returns the pids
 * it ended. win32 has no reparenting to launchd (its children live in the server's job object),
 * so it is a no-op there. Never throws.
 */
export async function reapOrphanCopies(ids: readonly string[], deps: ReapDeps = {}): Promise<number[]> {
  if ((deps.platform ?? process.platform) === 'win32') return [];
  if (!ids.some((id) => !!id)) return [];
  let rows: Map<number, ProcRow> | null;
  try {
    rows = parseProcTable(await (deps.runPs ?? runPs)(TABLE_ARGS, [0]));
  } catch {
    return []; // fail open: no worse than before this check existed
  }
  if (!rows) return [];
  const pids = orphanCopies(rows.values(), ids, deps.uid ?? process.getuid?.() ?? -1);
  if (pids.length === 0) return [];
  (deps.log ?? ((m: string) => console.warn(m)))(`[agent-chat] ending ${pids.length} orphaned copy(ies) of ${ids.filter(Boolean).join(', ')} (pid ${pids.join(', ')}, ppid 1) before resuming: one conversation never has two writers.`);
  try {
    await (deps.cut ?? ((p: number[]) => cutProcessGroups(p, 3_000)))(pids);
  } catch { /* best effort: the spawn goes ahead either way */ }
  return pids;
}
