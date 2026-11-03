import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { getAgent, removeAgent, routinesBoundTo } from '../lib/agents/store.js';
import { assertOwned } from '../lib/agents/owner.js';
import { globalAgentHome, isGlobalAgentHere } from '../lib/agents/scope.js';
import { automationPath, getAutomation, removeAutomation, resolveAutomationPhoto } from '../lib/automations/store.js';
import { listRegisteredProjects, revokeApproval } from '../lib/automations/registry.js';
import { listVaults } from '../lib/vaults.js';
import { readSuperState, superIdOfMember, superReadMarksPath, superRecordPath } from '../lib/super/store.js';
import { activityOf, getChat } from '../lib/assistant/chat-registry.js';
import { agentActivity } from './automation-job.js';

/**
 * Deleting an AI Team member from its stage (plan r4 R4, F2-F5): the member, every routine that
 * runs as it (in every project, for a global member), its Super record and read marks, and its
 * approvals on this Mac. All or nothing: every check runs BEFORE anything is removed, and a dry
 * run answers the exact plan the dialog shows. Nothing is lost for good: each removed file is
 * copied first into `state/.trash/members/<YYYY-MM-DD-HHMM>-<slug>/` (local-only, `*` ignored)
 * with a `receipt.json` naming where it came from (pattern a-delete-is-never-inferred-from-absence).
 */

export interface MemberRoutine { project: string; slug: string; title: string }
export interface MemberDeletePlan {
  slug: string;
  title: string;
  global: boolean;
  routines: MemberRoutine[];
  /** Why it may not go now; empty = it may. */
  blockers: Array<'read_only' | 'member_working' | 'routine_running' | 'routine_not_owned'>;
}

interface Project { name: string; root: string }

/** The projects a member lives in: its own, or every registered one for a global member. */
function projectsOf(contextRoot: string, slug: string, global: boolean, home?: string): Project[] {
  const here: Project = { name: basename(dirname(contextRoot)), root: resolve(contextRoot) };
  if (!global) return [here];
  const out = new Map<string, Project>([[here.root, here]]);
  // Every project the global agent's own delete reaches (the automations registry), and every
  // open one (vaults): the same set the final removeGlobalAgent checks, so nothing is missed.
  const candidates = [
    ...listVaults(home).map((v) => ({ name: v.name, path: v.path })),
    ...listRegisteredProjects(home).map((p) => ({ name: basename(p), path: p })),
  ];
  for (const v of candidates) {
    const root = resolve(join(v.path, '_dream_context'));
    if (out.has(root) || !existsSync(root)) continue;
    // A project whose own agent shadows the name is not this member's: its routines stay.
    if (!isGlobalAgentHere(root, slug, home)) continue;
    out.set(root, { name: v.name, root });
  }
  return [...out.values()];
}

const runs = (sid: string): boolean => {
  const e = getChat(sid);
  if (!e) return false;
  const a = activityOf(e);
  return a === 'working' || a === 'starting' || a === 'asking' || a === 'stale';
};

/** Is the member at work in this project: its session on a turn, a child running, main's ask open? */
async function workingIn(root: string, slug: string): Promise<boolean> {
  let s;
  try { s = await readSuperState(root, superIdOfMember(slug)); } catch { return false; }
  if (s.queue.some((q) => q.kind === 'request' && q.state !== 'done')) return true;
  if (s.session && runs(s.session)) return true;
  return Object.entries(s.children).some(([sid, c]) => c.endedAt === undefined && runs(sid));
}

export async function planMemberDelete(contextRoot: string, slug: string, home?: string): Promise<MemberDeletePlan | null> {
  const agent = getAgent(contextRoot, slug, home);
  if (!agent) return null;
  const global = agent.scope === 'global';
  const blockers = new Set<MemberDeletePlan['blockers'][number]>();
  try { assertOwned({ owner: agent.owner }, agent.title || slug); } catch { blockers.add('read_only'); }
  const routines: MemberRoutine[] = [];
  for (const p of projectsOf(contextRoot, slug, global, home)) {
    for (const r of routinesBoundTo(p.root, slug)) {
      if (r === slug) continue; // the agent's own unsplit manifest IS the agent: it goes with it
      const a = getAutomation(p.root, r, home);
      routines.push({ project: p.name, slug: r, title: a?.title || r });
      if (agentActivity(p.root, r)) blockers.add('routine_running');
      // A teammate's routine cannot be removed by this Mac: refused before anything goes.
      try { if (a) assertOwned({ owner: (a as { owner?: unknown }).owner } as never, a.title || r); } catch { blockers.add('routine_not_owned'); }
    }
    if (agentActivity(p.root, slug)) blockers.add('member_working');
    if (await workingIn(p.root, slug)) blockers.add('member_working');
  }
  return { slug, title: agent.title || slug, global, routines, blockers: [...blockers] };
}

/** `2026-11-03-1412` (local time): the trash folder's prefix. */
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** A plain folder (never through a link), its `*` ignore written once. */
function plainDir(path: string): void {
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new Error(`${path} is not a plain folder`);
  mkdirSync(path, { recursive: true });
}

export interface MemberDeleteResult {
  ok: boolean;
  plan: MemberDeletePlan;
  trash: string | null;
  /** What could not be removed (a failure midway), by name; empty on success. */
  left: string[];
}

/**
 * The delete itself. `stopSuper` stops the member's Super in one project and tells main (routes
 * pass `stopMemberSuper`); `retireSuper` drops its in-memory entry for good.
 */
export async function deleteMember(
  contextRoot: string, slug: string,
  deps: { stopSuper(root: string, slug: string): Promise<unknown>; retireSuper(root: string, slug: string): void; home?: string; now?: Date },
): Promise<MemberDeleteResult | null> {
  const plan = await planMemberDelete(contextRoot, slug, deps.home);
  if (!plan) return null;
  if (plan.blockers.length) return { ok: false, plan, trash: null, left: [] };
  const agent = getAgent(contextRoot, slug, deps.home)!;
  const projects = projectsOf(contextRoot, slug, plan.global, deps.home);

  // 1. The copy, before anything goes.
  const trashRoot = join(contextRoot, 'state', '.trash');
  plainDir(join(contextRoot, 'state'));
  plainDir(trashRoot);
  // The only thing keeping the copy out of git: never trusted, never written through a link, and
  // always exactly `*` (a planted `!*` would push other projects' data to this repo's remote).
  const ignore = join(trashRoot, '.gitignore');
  const ig = lstatSync(ignore, { throwIfNoEntry: false });
  if (ig && (ig.isSymbolicLink() || !ig.isFile())) throw new Error('state/.trash/.gitignore is not a plain file');
  writeFileSync(ignore, '*\n', 'utf-8');
  plainDir(join(trashRoot, 'members'));
  let trash = join(trashRoot, 'members', `${stamp(deps.now ?? new Date())}-${slug}`);
  for (let i = 2; existsSync(trash); i++) trash = `${trash.replace(/-\d+$/, '')}-${i}`;
  plainDir(trash);
  const files: Array<{ from: string; to: string }> = [];
  const keep = (from: string | null, as: string) => {
    if (!from || !existsSync(from) || lstatSync(from).isSymbolicLink()) return;
    const to = join(trash, as);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
    files.push({ from, to: relative(trash, to) });
  };
  keep(agent.path, join('agent', basename(agent.path)));
  if (plan.global) keep(globalAgentHome(slug, deps.home), join('agent', slug));
  else keep(resolveAutomationPhoto(contextRoot, agent.photo), join('agent', 'photo', basename(agent.photo ?? 'photo')));
  for (const p of projects) {
    for (const r of plan.routines.filter((x) => x.project === p.name)) keep(automationPath(p.root, r.slug), join('routines', p.name, `${r.slug}.md`));
    const sid = superIdOfMember(slug);
    keep(superRecordPath(p.root, sid), join('super', p.name, `${slug}.json`));
    keep(superReadMarksPath(p.root, sid), join('super', p.name, `${slug}.read-marks.json`));
  }

  const left: string[] = [];
  // 2. Its Super stops in every project (main is told), then its record and marks go.
  for (const p of projects) {
    if (left.length) break;
    if (!existsSync(superRecordPath(p.root, superIdOfMember(slug)))) continue;
    try {
      await deps.stopSuper(p.root, slug);
      deps.retireSuper(p.root, slug);
      for (const f of [superRecordPath(p.root, superIdOfMember(slug)), superReadMarksPath(p.root, superIdOfMember(slug))]) {
        try { if (existsSync(f) && !lstatSync(f).isSymbolicLink()) rmSync(f, { force: true }); } catch { left.push(`${p.name}: ${basename(f)}`); }
      }
    } catch { left.push(`${p.name}: stage`); }
  }
  // 3. Every routine (remove + revoke, one helper with the routine route). Not after a failure
  //    above: a member that stays keeps its routines (all or nothing, plan r4 F4).
  for (const p of left.length ? [] : projects) {
    for (const r of plan.routines.filter((x) => x.project === p.name)) {
      if (left.length) break;
      try { deleteRoutine(p.root, r.slug); } catch { left.push(`${p.name}: ${r.title}`); }
    }
  }
  // 4. The member last: a failure above keeps it, so nothing half-deleted still runs.
  if (!left.length) {
    try {
      // Its own unsplit scheduled manifest is the agent itself: removeAgent takes it with every
      // key's death (grant, local entries, task jobs, reports), never a bare manifest delete.
      const r = removeAgent(contextRoot, slug, { home: deps.home, ownSchedule: true });
      if (!r.removed) left.push(...r.usedBy);
      else if (routinesBoundTo(contextRoot, slug).includes(slug)) deleteRoutine(contextRoot, slug);
    } catch { left.push(plan.title); }
  }
  writeFileSync(join(trash, 'receipt.json'), `${JSON.stringify({ member: slug, title: plan.title, global: plan.global, deletedAt: (deps.now ?? new Date()).toISOString(), routines: plan.routines, files, left }, null, 2)}\n`, 'utf-8');
  return { ok: left.length === 0, plan, trash: relative(dirname(contextRoot), trash), left };
}

/**
 * One routine's delete (plan r4 F2): its manifest and machine-local files go, and its approval is
 * revoked, so a routine re-created under the same slug is never approved by the old grant. Shared
 * by the routine route and the member delete. A registry that cannot be rewritten is logged, never
 * an error (the manifest, the part that runs, is already gone).
 */
export function deleteRoutine(contextRoot: string, slug: string, onRevokeError?: (err: unknown) => void): void {
  removeAutomation(contextRoot, slug);
  try {
    revokeApproval(dirname(contextRoot), slug);
  } catch (err) {
    if (onRevokeError) onRevokeError(err);
    else console.error('[automations] delete: could not revoke approval', err);
  }
}
