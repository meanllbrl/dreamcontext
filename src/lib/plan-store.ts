/**
 * plan-store — where a plan's review loop lives on disk, and the only code that touches it.
 *
 *   _dream_context/tmp/plans/<plan>/
 *     plan.md          the one plan, rewritten whole each round
 *     plan.r<N>.md     the snapshot taken when round N opened (reviewers read this)
 *     r<N>-<lens>.md   each lens's raw review, verbatim
 *     r<N>-<lens>.packet.md  the packet that lens was handed
 *     ledger.json      what happened (plan-ledger.ts computes the rest)
 *
 * Machine-local by design (tmp/ never syncs): another machine sees no ledger and its gate
 * falls back to today's checks. Every read and write refuses a symlink (lstat, then realpath
 * contained in the vault): the folder is agent-written, and a link would let a review file or
 * a plan name reach outside the brain. Every mutating verb runs under one pid lockfile per plan
 * and writes tmp-file + rename, so two sessions on one plan never interleave a write.
 */

import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { acquireFileLockWithin, releaseFileLock } from './file-lock.js';
import { ledgerProblem, PLAN_NAME_RE, type Ledger, type LedgerReadResult } from './plan-ledger.js';

export const PLANS_REL = join('tmp', 'plans');

export class PlanStoreError extends Error {}

export function plansDir(root: string): string {
  return join(root, PLANS_REL);
}

export function planDir(root: string, plan: string): string {
  if (!PLAN_NAME_RE.test(plan)) throw new PlanStoreError(`Invalid plan name "${plan}": use [a-z0-9-], 1-80 characters.`);
  return join(plansDir(root), plan);
}

export const ledgerPath = (root: string, plan: string): string => join(planDir(root, plan), 'ledger.json');
export const planFilePath = (root: string, plan: string): string => join(planDir(root, plan), 'plan.md');
export const snapshotPath = (root: string, plan: string, n: number): string => join(planDir(root, plan), `plan.r${n}.md`);
export const reviewPath = (root: string, plan: string, n: number, lens: string): string => join(planDir(root, plan), `r${n}-${lens}.md`);
export const packetPath = (root: string, plan: string, n: number, lens: string): string => join(planDir(root, plan), `r${n}-${lens}.packet.md`);

/**
 * Refuse a symlink anywhere from the vault root down to `p` (each existing component is
 * lstat'ed), then require the real path to sit inside the vault's real path.
 */
export function assertSafePath(root: string, p: string): void {
  const rel = relative(root, p);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new PlanStoreError(`Refused: ${p} is outside the vault.`);
  let cur = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    if (!existsSync(cur) && !isDanglingLink(cur)) return;
    if (lstatSync(cur).isSymbolicLink()) throw new PlanStoreError(`Refused: ${cur} is a symlink.`);
  }
  const realRoot = realpathSync(root);
  const real = realpathSync(p);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new PlanStoreError(`Refused: ${p} resolves outside the vault.`);
}

function isDanglingLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Read a file inside the vault, refusing symlinks. */
export function readSafe(root: string, p: string): string {
  assertSafePath(root, p);
  return readFileSync(p, 'utf-8');
}

/** Read any file the caller names (a review the lead saved anywhere), refusing a symlink. */
export function readExternalNoLink(p: string): string {
  if (!existsSync(p) && !isDanglingLink(p)) throw new PlanStoreError(`No such file: ${p}`);
  if (lstatSync(p).isSymbolicLink()) throw new PlanStoreError(`Refused: ${p} is a symlink.`);
  if (!lstatSync(p).isFile()) throw new PlanStoreError(`Not a file: ${p}`);
  return readFileSync(p, 'utf-8');
}

/** tmp-file + rename inside the vault. */
export function writeSafe(root: string, p: string, content: string): void {
  assertSafePath(root, dirname(p));
  if (existsSync(p) || isDanglingLink(p)) assertSafePath(root, p);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

/** `tmp/plans/` exists with its `.gitignore` written first (nothing in it is ever committed). */
export function ensurePlansDir(root: string): void {
  const dir = plansDir(root);
  assertSafePath(root, dir);
  mkdirSync(dir, { recursive: true });
  assertSafePath(root, dir);
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi)) writeSafe(root, gi, '*\n');
}

export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export type LedgerRead = { ok: true; ledger: Ledger } | { ok: false; missing: boolean; problem: string };

/** One plan's ledger. A plan exists only when its ledger does. */
export function readLedger(root: string, plan: string): LedgerRead {
  const p = ledgerPath(root, plan);
  try {
    if (!existsSync(p) && !isDanglingLink(p)) return { ok: false, missing: true, problem: `no plan "${plan}" (no ledger at ${p})` };
    const raw = JSON.parse(readSafe(root, p));
    const problem = ledgerProblem(raw);
    if (problem) return { ok: false, missing: false, problem: `${p}: ${problem}` };
    return { ok: true, ledger: raw as Ledger };
  } catch (err) {
    return { ok: false, missing: false, problem: `${p}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function writeLedger(root: string, ledger: Ledger): void {
  writeSafe(root, ledgerPath(root, ledger.plan), JSON.stringify(ledger, null, 2) + '\n');
}

/**
 * Every ledger under `tmp/plans/`, for the gate. Never throws: a ledger it cannot read (or a
 * symlinked folder) comes back as a problem the gate reports, never a 500.
 */
export function readPlanLedgers(root: string): LedgerReadResult[] {
  const dir = plansDir(root);
  if (!existsSync(dir)) return [];
  try {
    assertSafePath(root, dir);
  } catch (err) {
    return [{ ok: false, path: dir, problem: (err as Error).message }];
  }
  const out: LedgerReadResult[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch (err) { return [{ ok: false, path: dir, problem: (err as Error).message }]; }
  for (const name of names.sort()) {
    const sub = join(dir, name);
    let st;
    try { st = lstatSync(sub); } catch { continue; }
    if (st.isSymbolicLink()) { out.push({ ok: false, path: sub, problem: 'the plan folder is a symlink' }); continue; }
    if (!st.isDirectory() || !PLAN_NAME_RE.test(name)) continue;
    const lp = join(sub, 'ledger.json');
    if (!existsSync(lp) && !isDanglingLink(lp)) continue; // a folder without a ledger is not a plan
    const r = readLedger(root, name);
    out.push(r.ok ? { ok: true, ledger: r.ledger, dir: sub } : { ok: false, path: lp, problem: r.problem });
  }
  return out;
}

/**
 * Run `fn` holding the plan's lockfile (pattern pid-lockfile-concurrent-json): one writer at a
 * time per plan, across processes. A dead holder's lock is reclaimed.
 */
export async function withPlanLock<T>(root: string, plan: string, fn: () => Promise<T> | T): Promise<T> {
  ensurePlansDir(root);
  const lock = join(plansDir(root), `${planDir(root, plan).split(sep).pop()}.lock`);
  const held = await acquireFileLockWithin(lock, { waitMs: 15_000, staleMs: 120_000, verifyPidLiveness: true });
  if (!held) throw new PlanStoreError(`Busy: another session is writing plan "${plan}" (${lock}). Try again in a moment.`);
  try {
    return await fn();
  } finally {
    releaseFileLock(lock);
  }
}
