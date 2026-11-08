import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { getAgent } from '../agents/store.js';
import { readLocalJson, updateLocalJson } from '../local-store.js';
import { retireMemberSuper } from './inbox.js';
import { superIdOfMember, superReadMarksPath, superRecordPath } from './store.js';

/**
 * A MEMBER'S STATE BELONGS TO THE MEMBER, NOT TO ITS NAME (owner 2026-11-08). The member's Super
 * record (`state/.super/members/<slug>.json`, its session, queue and children) and its read marks
 * are keyed by slug. A member deleted any way but its own Delete button (a removed file, a wiped AI
 * Team, the CLI) left them behind, and a NEW member made with the same name inherited the old
 * conversation, queue and failed delegations.
 *
 * The fix asks the subject, not its name: every member file carries a unique `id`. This Mac keeps
 * which id each slug's state was made for (`member-identities.json`, machine-local). When the slug
 * comes back with another id, the old state is MOVED into `state/.trash/members/` (git-ignored,
 * with a receipt), so nothing is lost and nothing sticks to the new member, whatever deleted the
 * old one. A slug this Mac has not seen yet is recorded as it is (no way to tell an older record).
 */

const LEDGER = 'member-identities.json';
type Ledger = Record<string, string>;

export interface MemberIdentitySettled {
  /** Where the earlier member's state went (project-relative), or null when nothing moved. */
  archived: string | null;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function plainDir(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`${path} is not a plain folder`);
  mkdirSync(path, { recursive: true });
}

/** A plain file, never through a link. */
function plainFile(path: string): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return !!st && st.isFile() && !st.isSymbolicLink();
}

/**
 * Make sure the state under `slug` is this member's. Call before anything reads or births the
 * member's Super. `stopSuper` stops a still-live earlier session first (the server passes its own
 * stop); a failed stop does not keep the old state on the new member.
 */
/** One settle per member at a time in this process: two opens racing must not both move state
 *  (the second would trash the record the first just made). */
const settling = new Map<string, Promise<MemberIdentitySettled>>();

export function settleMemberIdentity(
  contextRoot: string,
  slug: string,
  deps: { stopSuper?: (root: string, slug: string) => Promise<unknown>; home?: string; now?: Date } = {},
): Promise<MemberIdentitySettled> {
  const key = `${contextRoot}\u0000${slug}`;
  const prior = settling.get(key) ?? Promise.resolve({ archived: null });
  const next = prior.catch(() => ({ archived: null })).then(() => settleOnce(contextRoot, slug, deps));
  settling.set(key, next);
  void next.finally(() => { if (settling.get(key) === next) settling.delete(key); }).catch(() => {});
  return next;
}

async function settleOnce(
  contextRoot: string,
  slug: string,
  deps: { stopSuper?: (root: string, slug: string) => Promise<unknown>; home?: string; now?: Date },
): Promise<MemberIdentitySettled> {
  let id: string | undefined;
  try { id = getAgent(contextRoot, slug, deps.home)?.id; } catch { id = undefined; }
  if (!id) return { archived: null };
  const projectRoot = dirname(contextRoot);
  const prev = readLocalJson<Ledger>(projectRoot, LEDGER, {}, deps.home)[slug];
  let archived: string | null = null;
  if (prev && prev !== id) {
    const sid = superIdOfMember(slug);
    const files = [superRecordPath(contextRoot, sid), superReadMarksPath(contextRoot, sid)].filter(plainFile);
    if (files.length > 0) {
      try { await deps.stopSuper?.(contextRoot, slug); } catch { /* the old state still leaves the new member */ }
      retireMemberSuper(contextRoot, slug);
      // Re-read after the stop: only what is still there moves.
      files.splice(0, files.length, ...files.filter(plainFile));
      const trashRoot = join(contextRoot, 'state', '.trash');
      plainDir(trashRoot);
      const ignore = join(trashRoot, '.gitignore');
      const ig = lstatSync(ignore, { throwIfNoEntry: false });
      if (ig && (ig.isSymbolicLink() || !ig.isFile())) throw new Error('state/.trash/.gitignore is not a plain file');
      writeFileSync(ignore, '*\n', 'utf-8');
      plainDir(join(trashRoot, 'members'));
      let dir = join(trashRoot, 'members', `${stamp(deps.now ?? new Date())}-${slug}-earlier`);
      for (let i = 2; existsSync(dir); i++) dir = `${dir.replace(/-\d+$/, '')}-${i}`;
      plainDir(dir);
      const moved: Array<{ from: string; to: string }> = [];
      for (const f of files) {
        const to = join(dir, basename(f));
        renameSync(f, to);
        moved.push({ from: relative(projectRoot, f), to: relative(dir, to) });
      }
      writeFileSync(join(dir, 'receipt.json'), `${JSON.stringify({
        member: slug, earlierId: prev, newId: id, archivedAt: (deps.now ?? new Date()).toISOString(),
        why: 'a new member took this name; the earlier member\'s conversation and queue are kept here', files: moved,
      }, null, 2)}\n`, 'utf-8');
      archived = relative(projectRoot, dir);
    }
  }
  if (prev !== id) updateLocalJson<Ledger>(projectRoot, LEDGER, {}, (cur) => ({ ...cur, [slug]: id! }), deps.home);
  return { archived };
}
