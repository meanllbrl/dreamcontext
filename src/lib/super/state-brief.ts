/**
 * `dreamcontext super state --brief` (audit OR-9): the full `state` answer carries the stage
 * (cards, groups, layout), the machine facts, the AI Team roster, the MCP list and the agenda,
 * most of which a successor session never needs to look at before it acts. 43 of 46 Super
 * sessions are successors and ran `super state` 3.1 times with a hand-written JSON parser in
 * their first ten calls. The brief is the same answer cut to what decides the next move:
 * every child (id, status, task, place, fenced brief and last line), the open queue items, the
 * jobs kept in the pool, the live team jobs and the warnings. Pure: the CLI projects the
 * server's reply, so nothing about the server contract changes.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The child fields a successor decides on; everything else stays in the full `state`. */
const CHILD_KEYS = [
  'status', 'tool', 'task', 'worktree', 'branch', 'mode', 'model', 'brief', 'lastLine', 'lastLineCut', 'limit',
  'asking', 'startError', 'elapsedMs', 'endedAt', 'adopted', 'testsToday',
] as const;

/** A queue item still owed (anything not closed). */
const stillOpen = (q: unknown): boolean => isObj(q) && q.state !== 'done';

export function briefState(full: Obj): Obj {
  const children: Obj = {};
  if (isObj(full.children)) {
    for (const [sid, ch] of Object.entries(full.children)) {
      if (!isObj(ch)) continue;
      const row: Obj = {};
      for (const k of CHILD_KEYS) if (ch[k] !== undefined && ch[k] !== '') row[k] = ch[k];
      children[sid] = row;
    }
  }
  const queue = Array.isArray(full.queue) ? full.queue.filter(stillOpen) : [];
  const out: Obj = { brief: true, children, queue };
  if (full.head) out.head = full.head;
  if (Array.isArray(full.pool) && full.pool.length) out.pool = full.pool;
  if (Array.isArray(full.team)) {
    const live = full.team.filter((j) => isObj(j) && j.status !== 'done' && j.state !== 'done');
    if (live.length) out.team = live;
  }
  if (Array.isArray(full.warnings) && full.warnings.length) out.warnings = full.warnings;
  // The owner's agenda and what is owed him: a fresh Super reports "I am back and this runs"
  // from them, and padStale asks it to keep or drop lines it must be able to read.
  if (Array.isArray(full.pad) && full.pad.length) out.pad = full.pad;
  if (full.padStale) out.padStale = full.padStale;
  for (const k of ['owed', 'held', 'blocked', 'rotating'] as const) {
    const v = full[k];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  }
  if (full.limits) out.limits = full.limits;
  out.more = 'Cards and groups, the stage layout, machine facts, the AI Team roster, the MCP list and dismissed items are left out: `dreamcontext super state` prints all of it.';
  return out;
}
