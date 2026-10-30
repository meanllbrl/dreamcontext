/**
 * Codex threads on disk: where a thread's rollout is and which project owns it (plan r5 §4c).
 *
 * Claude's owner check (`transcriptOwnerCheck`) answers `'none'` for a path it cannot resolve,
 * and `transcriptLaunchCwd` reads Claude's format, so Codex has its own resolver: the rollout's
 * first line is `session_meta`, whose `cwd` is the folder the thread was started in. A thread is
 * this project's only when that cwd, realpath'd, IS the project (realpath'd). Anything that
 * cannot be resolved is NOT owned: callers refuse it (403), never serve it.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A Codex thread id (a UUID). Anything else is never used to build a path. */
export const CODEX_THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIRST_LINE_MAX = 512 * 1024;

/** The rollout file of a thread under `<codexHome>/sessions/YYYY/MM/DD/`, or null. */
export function findCodexRollout(threadId: string, codexHome: string = join(homedir(), '.codex')): string | null {
  if (!CODEX_THREAD_RE.test(threadId)) return null;
  const root = join(codexHome, 'sessions');
  const suffix = `-${threadId.toLowerCase()}.jsonl`;
  const dirs = (p: string): string[] => {
    try { return readdirSync(p).filter((n) => /^\d{2,4}$/.test(n)).sort().reverse(); } catch { return []; }
  };
  for (const y of dirs(root)) for (const m of dirs(join(root, y))) for (const d of dirs(join(root, y, m))) {
    let names: string[] = [];
    try { names = readdirSync(join(root, y, m, d)); } catch { continue; }
    const hit = names.find((n) => n.startsWith('rollout-') && n.toLowerCase().endsWith(suffix));
    if (hit) return join(root, y, m, d, hit);
  }
  return null;
}

/** The `cwd` a rollout's `session_meta` line records, or null. Reads the first line only. */
export function codexRolloutCwd(rolloutPath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(rolloutPath, 'r');
    const buf = Buffer.alloc(FIRST_LINE_MAX);
    const n = readSync(fd, buf, 0, FIRST_LINE_MAX, 0);
    const text = buf.subarray(0, n).toString('utf-8');
    const nl = text.indexOf('\n');
    if (nl < 0) return null;
    const first = JSON.parse(text.slice(0, nl)) as { type?: unknown; payload?: { cwd?: unknown } };
    return first.type === 'session_meta' && typeof first.payload?.cwd === 'string' ? first.payload.cwd : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
  }
}

const real = (p: string): string | null => {
  try { return realpathSync(p); } catch { return null; }
};

export type CodexOwnership = 'owned' | 'foreign' | 'unresolvable';

/** Does this Codex thread belong to `projectRoot`? */
export function codexThreadOwnership(threadId: string, projectRoot: string, codexHome?: string): CodexOwnership {
  const rollout = findCodexRollout(threadId, codexHome);
  if (!rollout || !existsSync(rollout)) return 'unresolvable';
  const cwd = codexRolloutCwd(rollout);
  if (!cwd) return 'unresolvable';
  const a = real(cwd);
  const b = real(projectRoot);
  if (!a || !b) return 'unresolvable';
  return a === b ? 'owned' : 'foreign';
}
