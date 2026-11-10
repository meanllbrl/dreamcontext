/**
 * The owner's consent to share an app's hand-made data (emekle üretilmiş veri) with the team
 * (app-veri-ortak plan r6, K3). This Mac's, the owner's:
 * `~/.dreamcontext/apps/share/<hash>.json` = `{approved, excluded, declined, at}`.
 *
 * Its own file, apart from the settings map (app-config.ts): a settings write can never erase
 * it, and it never reaches `DC_CONFIG`. Consent is a SET: when the declaration grows only the
 * new path is asked; a narrowed declaration asks nothing. Only the owner's page changes it (the
 * route's `refuseUnlessOwnerPage`); an agent cannot drop an exclusion.
 *
 * Also home to the small file helpers the per-machine app-data state shares (data-deletes.ts,
 * data-conflicts.ts): hash check, temp+rename 0600 writes, a symlinked file refused.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appsHome } from './registry.js';
import { DATA_MAX_ENTRIES, pendingApprovalOf, validateDeclPath, type DataDecl } from './data-share.js';

export interface Consent {
  approved: string[];
  excluded: string[];
  declined: boolean;
  at: string;
}

export interface ConsentPatch {
  approve?: string[];
  exclude?: string[];
  unexclude?: string[];
  decline?: boolean;
}

// ─── shared file helpers ───────────────────────────────────────────────────────────

/** An app record's `hash` as it may name a file (the backup folder's rule). */
export const APP_HASH_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function assertAppHash(hash: string): void {
  if (typeof hash !== 'string' || !APP_HASH_RE.test(hash)) throw new Error('bad app hash');
}

/** `~/.dreamcontext/apps/<sub>/<hash>.json`, the hash checked first. */
export function appStateFile(home: string, sub: string, hash: string): string {
  assertAppHash(hash);
  return join(appsHome(home), sub, `${hash}.json`);
}

/** Missing = null; a symlink, unreadable or bad JSON throws. */
export function readJsonStrict(p: string): unknown {
  let st;
  try { st = lstatSync(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${p} is a symlink or not a file`);
  return JSON.parse(readFileSync(p, 'utf-8')) as unknown;
}

/** temp + rename, 0600, the folder 0700, a symlink at the target refused. */
export function writeJsonAtomic(p: string, value: unknown): void {
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 });
  try { if (lstatSync(p).isSymbolicLink()) throw new Error(`${p} is a symlink; refusing it`); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, p);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
}

// ─── the consent file ──────────────────────────────────────────────────────────────

export function consentPath(home: string, hash: string): string {
  return appStateFile(home, 'share', hash);
}

function cleanPaths(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const p of v) {
    if (validateDeclPath(p) !== null) return null;
    if (!out.includes(p as string)) out.push(p as string);
  }
  return out.length > DATA_MAX_ENTRIES ? null : out;
}

/** The stored consent, or null (missing or corrupt). Never throws. */
export function readConsent(home: string, hash: string): Consent | null {
  try {
    const raw = readJsonStrict(consentPath(home, hash));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const approved = cleanPaths(r.approved);
    const excluded = cleanPaths(r.excluded);
    if (!approved || !excluded || typeof r.declined !== 'boolean') return null;
    return { approved, excluded, declined: r.declined, at: typeof r.at === 'string' ? r.at.slice(0, 40) : '' };
  } catch {
    return null;
  }
}

/**
 * Apply the owner's choice (the body of `POST /api/apps/:slug/data-share`, unchecked input):
 * every path checked with {@link validateDeclPath}, at most {@link DATA_MAX_ENTRIES} per array,
 * `approve` only of declared `shared` paths. `approve` also clears a decline; `decline: true`
 * keeps everything on this Mac until the owner approves again.
 */
export function applyConsentPatch(home: string, hash: string, decl: DataDecl | null, patch: unknown, opts: { now?: Date } = {}): { ok: true; consent: Consent } | { ok: false; error: string } {
  try { assertAppHash(hash); } catch { return { ok: false, error: 'bad_app' }; }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'bad_body' };
  const p = patch as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!['approve', 'exclude', 'unexclude', 'decline'].includes(k)) return { ok: false, error: `bad_body: unknown field ${k.slice(0, 40)}` };
  const lists: Record<'approve' | 'exclude' | 'unexclude', string[]> = { approve: [], exclude: [], unexclude: [] };
  for (const k of ['approve', 'exclude', 'unexclude'] as const) {
    if (p[k] === undefined) continue;
    if (!Array.isArray(p[k])) return { ok: false, error: `bad_body: ${k} is not a list` };
    const arr = p[k] as unknown[];
    if (arr.length > DATA_MAX_ENTRIES) return { ok: false, error: `bad_body: more than ${DATA_MAX_ENTRIES} paths in ${k}` };
    for (const x of arr) {
      const bad = validateDeclPath(x);
      if (bad) return { ok: false, error: `bad_path: ${bad}` };
      lists[k].push(x as string);
    }
  }
  if (p.decline !== undefined && typeof p.decline !== 'boolean') return { ok: false, error: 'bad_body: decline is not true or false' };
  if (!lists.approve.length && !lists.exclude.length && !lists.unexclude.length && p.decline === undefined) return { ok: false, error: 'bad_body: nothing to change' };
  if (lists.approve.length) {
    if (!decl) return { ok: false, error: 'undecided: the app declares no shared data yet' };
    const declared = new Set(decl.shared.map((e) => e.path));
    const stray = lists.approve.find((x) => !declared.has(x));
    if (stray) return { ok: false, error: `not_declared: ${stray}` };
  }
  const cur = readConsent(home, hash) ?? { approved: [], excluded: [], declined: false, at: '' };
  const declared = new Set((decl?.shared ?? []).map((e) => e.path));
  // Approvals of paths no longer declared do not count anyway; they are pruned here.
  let approved = cur.approved.filter((x) => declared.has(x));
  for (const x of lists.approve) if (!approved.includes(x)) approved.push(x);
  let excluded = cur.excluded.slice();
  for (const x of lists.exclude) if (!excluded.includes(x)) excluded.push(x);
  excluded = excluded.filter((x) => !lists.unexclude.includes(x));
  approved = approved.slice(0, DATA_MAX_ENTRIES);
  if (excluded.length > DATA_MAX_ENTRIES) return { ok: false, error: `bad_body: more than ${DATA_MAX_ENTRIES} excluded paths` };
  let declined = cur.declined;
  if (lists.approve.length) declined = false;
  if (p.decline !== undefined) declined = p.decline as boolean;
  const consent: Consent = { approved, excluded, declined, at: (opts.now ?? new Date()).toISOString() };
  try { writeJsonAtomic(consentPath(home, hash), consent); } catch (e) {
    return { ok: false, error: `write_failed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
  return { ok: true, consent };
}

/** Declared shared paths neither approved nor excluded: what the notice asks. */
export function pendingApproval(decl: DataDecl | null, consent: Consent | null): string[] {
  return pendingApprovalOf(decl, consent);
}

const TRASH_NAME = 'data-share-consent.json';

/** Move the consent file into the app's trash entry (removal). False when there was none. */
export function moveConsent(home: string, hash: string, toDir: string): boolean {
  const from = consentPath(home, hash);
  if (!existsSync(from)) return false;
  mkdirSync(toDir, { recursive: true, mode: 0o700 });
  renameSync(from, join(toDir, TRASH_NAME));
  return true;
}

/** Bring it back from the trash entry (restore). Never overwrites a newer consent. */
export function restoreConsent(home: string, hash: string, fromDir: string): boolean {
  const src = join(fromDir, TRASH_NAME);
  const to = consentPath(home, hash);
  try { if (lstatSync(src).isSymbolicLink()) return false; } catch { return false; }
  if (existsSync(to)) return false;
  mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 });
  renameSync(src, to);
  return true;
}
