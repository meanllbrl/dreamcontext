import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMachineIdentity } from '../machine-id.js';
import { MAX_FILE_BYTES, SUPER_STATE_REL } from '../super/store.js';
import { listQuestions } from './hitl.js';
import { parseDayFile, readThread, threadSlugDir } from './threads.js';
import type { AutomationQuestion, ThreadEntry } from './types.js';

/**
 * A job the Super Agent gave an AI Team member (`super team ask`) reports to the Super Agent, not
 * to the owner: it comes back as `team=<job> event=done`. So what it says is no news for him: no
 * unread, no banner, no notch row (owner, 2026-10-31). It stays readable in the member's thread.
 *
 * THE ONE RULE, read by every unread count and every banner. Derived, never stored, so old jobs
 * fall out of the counts with nothing written or deleted. A run is the Super's only when:
 *  - it OPENED with the Super's ask (`via: 'super'`) and nobody else spoke in it. A run the owner
 *    or a schedule opened stays theirs, even with a Super ask queued into it: that ask shares the
 *    turn order of work he is waiting for, and a thread cannot tell the two apart.
 *  - that ask is in this machine's own day file. A thread can be synced from a teammate's: the
 *    merged read alone vouches for nothing. (A file name is no signature: someone with push on a
 *    shared brain could still forge one. What they gain is a hidden badge; the text stays.)
 *  - no question was asked during it. Waiting or answered, a question is between the member and
 *    the owner: his answer is his own conversation, and he hears how it ended.
 *  - it did not fail: a failure must not vanish if the Super says nothing about it.
 *  - the project is handed over, or the record says the Super was told how it ended. A job still
 *    open when the owner takes the stage back has nobody to report to; one already reported does
 *    not come back as unread with every take-back.
 */

const LOUD_EVENTS = new Set(['failed', 'timeout', 'skipped']);
/** A question stamped a moment outside the entries of the run that asked it (one clock). */
const QUESTION_SLACK_MS = 2_000;

interface SuperRecord { enabled: boolean; open: Set<string> }

/** The record's two facts this rule needs, through the store's guards: a symlink, a non-file or an
 *  oversize file is no record, and no record means notify. */
function readRecord(contextRoot: string): SuperRecord | null {
  try {
    const path = join(contextRoot, SUPER_STATE_REL);
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { enabled?: unknown; team?: unknown; queue?: unknown };
    const team = Array.isArray(raw.team) ? raw.team as Array<{ id?: unknown; runId?: unknown; member?: unknown; told?: unknown }> : [];
    const queue = Array.isArray(raw.queue) ? raw.queue as Array<{ team?: unknown; state?: unknown }> : [];
    // The jobs whose ending the Super never heard: not told, or told and still waiting in its queue.
    // A job that fell off the record is long over.
    const unheard = new Set(queue.filter((q) => q.team && q.state === 'pending').map((q) => q.team));
    const open = new Set(team.filter((j) => (j.told !== 'done' && j.told !== 'stuck') || unheard.has(j.id)).map((j) => `${String(j.member)}::${String(j.runId)}`));
    return { enabled: raw.enabled === true, open };
  } catch {
    return null;
  }
}

/** Is `run` a question's run? By its id, or by time: a resumed turn's question carries a fire time
 *  of its own, never the thread's run id. */
function askedDuring(q: AutomationQuestion, ordered: readonly ThreadEntry[]): boolean {
  if (q.runFiredAt === ordered[0]?.runId) return true;
  const at = Date.parse(q.createdAt);
  return at >= Date.parse(ordered[0].at) - QUESTION_SLACK_MS && at <= Date.parse(ordered[ordered.length - 1].at) + QUESTION_SLACK_MS;
}

/** Is this ask in a thread file only this machine writes, saying the same thing? A teammate's file
 *  merges into the read and can copy a real id, so the merged entry alone vouches for nothing. */
function askedHere(contextRoot: string, slug: string, ask: ThreadEntry): boolean {
  try {
    const dir = threadSlugDir(contextRoot, slug);
    const me = readMachineIdentity().id;
    const ms = Date.parse(ask.at);
    // A file is named by the writer's local date: the day either side covers every zone.
    return [-1, 0, 1].some((d) => {
      const day = new Date(ms + d * 86_400_000).toISOString().slice(0, 10);
      // `<day>.md` is what this machine wrote before files carried its id.
      return [`${day}-${me}.md`, `${day}.md`].some((name) => {
        const path = join(dir, name);
        if (!existsSync(path) || !lstatSync(path).isFile()) return false;
        return parseDayFile(readFileSync(path, 'utf-8')).some((e) => e.id === ask.id && e.runId === ask.runId && e.kind === 'user' && e.via === 'super');
      });
    });
  } catch {
    return false;
  }
}

const NOTHING: ReadonlySet<string> = new Set();

export type QuietReader = (slug: string, run: readonly ThreadEntry[]) => ReadonlySet<string>;

/**
 * A reader for one pass over a project: `(slug, run) => the entry ids that count for nobody`. The
 * record, the questions and the ledger are read at most once, and only for a run that opened with
 * the Super's ask, so a project that never used it pays nothing.
 */
export function superQuietReader(contextRoot: string): QuietReader {
  let record: SuperRecord | null | undefined;
  const questions = new Map<string, AutomationQuestion[]>();
  return (slug, run) => {
    const ordered = [...run].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ask = ordered[0];
    if (!ask || ask.kind !== 'user' || ask.via !== 'super') return NOTHING;
    if (ordered.some((e) => e.kind === 'user' && e.via !== 'super')) return NOTHING;
    if (ordered.some((e) => e.kind === 'system' && e.event && LOUD_EVENTS.has(e.event))) return NOTHING;
    if (record === undefined) record = readRecord(contextRoot);
    if (!record) return NOTHING;
    if (!record.enabled && record.open.has(`${slug}::${ask.runId}`)) return NOTHING;
    if (!ordered.every((e) => e.kind !== 'user' || askedHere(contextRoot, slug, e))) return NOTHING;
    if (!questions.has(slug)) {
      let all: AutomationQuestion[] = [];
      try { all = listQuestions(contextRoot, slug); } catch { all = []; }
      questions.set(slug, all);
    }
    if (questions.get(slug)!.some((q) => askedDuring(q, ordered))) return NOTHING;
    return new Set(ordered.filter((e) => e.kind !== 'user').map((e) => e.id));
  };
}

/** Would a banner about this run be noise: a Super job, with the project handed over right now?
 *  A run ending after the take-back rings: nobody else will tell the owner. */
export function superRunQuiet(contextRoot: string, slug: string, runId: string): boolean {
  try {
    if (!readRecord(contextRoot)?.enabled) return false;
    const fired = Date.parse(runId);
    const fromDay = Number.isFinite(fired) ? new Date(fired - 86_400_000).toISOString().slice(0, 10) : undefined;
    const run = readThread(contextRoot, slug, { runId, ...(fromDay ? { fromDay } : {}) });
    return superQuietReader(contextRoot)(slug, run).size > 0
      // Nothing in the run but the ask yet (the moment it starts): quiet too.
      || (run.length === 1 && run[0].kind === 'user' && run[0].via === 'super' && askedHere(contextRoot, slug, run[0]));
  } catch {
    return false;
  }
}
