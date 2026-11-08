import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FILE_BYTES, MEMBER_SUPER_DIR, acceptableWorktree, okMember, superRecordPath } from './store.js';
import { SUPER_BRANCH_RE } from './types.js';
import { bindingVerdict } from './record-binding.js';
import { superHandoffFileOf, superHandoffTask } from './handoff-file.js';

/**
 * The context handoff in a SUPER session. The Super Agent hands off into its OWN file,
 * `state/.super/handoff.md` (super/handoff-file.ts), through `dreamcontext super handoff` — never
 * into a task (owner 2026-10-22), and never into a child's task (field 2026-10-21: the hook once
 * named a child's task for the super's own handoff).
 *
 * Read synchronously and defensively: this runs inside a hook that must never break a tool call.
 */

export interface SuperHandoffContext {
  /** Its live children, for the handoff's --next. */
  children: string[];
  /** Whose handoff it is (plan-r10 1): `main`, or a member Super's `m:<slug>` (its own file). */
  superId?: 'main' | `m:${string}`;
}

/** One record read synchronously through the store's guards (no link, a file, not oversize). */
/** The record, or null when absent, not a plain file, oversize, unparsable, or another Mac's or
 *  another folder's (record-binding.ts): that one is not this vault's Super. */
function readRecord(contextRoot: string, path: string): { session?: unknown; enabled?: unknown; children?: Record<string, { endedAt?: unknown; task?: unknown; worktree?: unknown; branch?: unknown }> } | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const text = readFileSync(path, 'utf-8');
    const raw = JSON.parse(text);
    return bindingVerdict(raw, text, contextRoot, path) === 'foreign' ? null : raw;
  } catch { return null; }
}

type SuperId = 'main' | `m:${string}`;
type RawRecord = NonNullable<ReturnType<typeof readRecord>>;

/** Every super record of this vault, main's first, then each member Super's (plan-r10 1). */
function superRecords(contextRoot: string): Array<{ superId: SuperId; raw: RawRecord }> {
  const candidates: Array<{ superId: SuperId; path: string }> = [{ superId: 'main', path: superRecordPath(contextRoot, 'main') }];
  try {
    const dir = join(contextRoot, MEMBER_SUPER_DIR);
    if (!lstatSync(join(contextRoot, 'state', '.super')).isSymbolicLink() && !lstatSync(dir).isSymbolicLink()) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json') || name.endsWith('.read-marks.json')) continue;
        const slug = name.slice(0, -'.json'.length);
        if (!okMember(slug)) continue;
        candidates.push({ superId: `m:${slug}`, path: superRecordPath(contextRoot, `m:${slug}`) });
      }
    }
  } catch { /* no members folder */ }
  const out: Array<{ superId: SuperId; raw: RawRecord }> = [];
  for (const c of candidates) {
    const raw = readRecord(contextRoot, c.path);
    if (raw) out.push({ superId: c.superId, raw });
  }
  return out;
}

/**
 * Is this the vault's recorded super session, and is it handed over (`enabled`)? Then its
 * handoff context. A taken-back super is not the Super Agent any more: null.
 */
export function superHandoffContext(contextRoot: string, ids: ReadonlyArray<string | null | undefined>): SuperHandoffContext | null {
  for (const { superId, raw } of superRecords(contextRoot)) {
    const session = typeof raw.session === 'string' ? raw.session : null;
    if (!session || raw.enabled !== true || !ids.some((id) => id === session)) continue;
    const children: string[] = [];
    for (const [sid, ch] of Object.entries(raw.children ?? {})) {
      if (ch?.endedAt === undefined) children.push(sid);
    }
    return superId === 'main' ? { children } : { children, superId };
  }
  return null;
}

/**
 * A Super child's own job, for its handoff (field 2026-11-08: a child at 662k was told to hand off
 * into the brain's newest in-progress task, somebody else's). Every field is what the super record
 * says, checked for shape, since it is printed into a command the child runs.
 */
export interface SuperChildContext {
  /** Its task (`delegate --task`, `super brief --task`), when the record names one that exists. */
  task?: string;
  /** Its worktree and branch, when `delegate --worktree` made them. */
  worktree?: string;
  branch?: string;
}

const TASK_SLUG = /^[a-z0-9][a-z0-9-]{0,239}$/;

/**
 * A child's worktree and branch as the store itself would accept them (`acceptableWorktree`: one
 * folder directly under ~/.claude-worktrees; `SUPER_BRANCH_RE`: super/<slug>), else nothing. The
 * ONE check for both the super record and the handoff record: both reach a prompt as a cd target.
 */
export function childPlaceOf(worktree: unknown, branch: unknown): { worktree?: string; branch?: string } {
  if (!acceptableWorktree(worktree)) return {};
  return typeof branch === 'string' && SUPER_BRANCH_RE.test(branch) ? { worktree, branch } : { worktree };
}

/**
 * Is one of `ids` (the pane, the conversation) a live child of some super of this vault? Then its
 * own job. The child's KEY is its pane id (the conversation a /clear rotation leaves behind keeps
 * the pane), so a fresh session after a handoff is still found. An ended child is not one; a
 * taken-back super's children are still that super's jobs.
 */
export function superChildContext(contextRoot: string, ids: ReadonlyArray<string | null | undefined>): SuperChildContext | null {
  for (const { raw } of superRecords(contextRoot)) {
    const children = raw.children ?? {};
    for (const id of ids) {
      if (!id || !Object.prototype.hasOwnProperty.call(children, id)) continue;
      const ch = children[id] as { endedAt?: unknown; task?: unknown; worktree?: unknown; branch?: unknown } | undefined;
      if (!ch || ch.endedAt !== undefined) continue;
      const out: SuperChildContext = {};
      if (typeof ch.task === 'string' && TASK_SLUG.test(ch.task) && taskExists(contextRoot, ch.task)) out.task = ch.task;
      return { ...out, ...childPlaceOf(ch.worktree, ch.branch) };
    }
  }
  return null;
}

function taskExists(contextRoot: string, slug: string): boolean {
  try { return lstatSync(join(contextRoot, 'state', `${slug}.md`)).isFile(); } catch { return false; }
}

/** The ONE command the super hands off with, every part spelled out. */
export function superHandoffCommand(fields: ReadonlyArray<{ flag: string; hint: string }>): string {
  return `dreamcontext super handoff ${fields.map((f) => `${f.flag} "<${f.hint}>"`).join(' ')}`;
}

/** The line the super's nudge ends with. */
export function superNudgeLine(ctx: SuperHandoffContext): string {
  const kids = ctx.children.length ? ctx.children.join(', ') : 'none';
  return `You are the Super Agent: your handoff goes into YOUR file, ${superHandoffFileOf(superHandoffTask(ctx.superId ?? 'main'))}, never into a task (each child hands off its own). Put your live children in --next with what each one does: ${kids}.`;
}
