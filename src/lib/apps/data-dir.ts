/**
 * Where an app's DATA lives (plan-veri r3, K1): `<project>/_dream_context/apps/<slug>/`, the
 * backend's `DC_DATA_DIR`. The folder is ignored twice (the privacy block in
 * `.git/info/exclude` and an anchored `/apps/` line in `_dream_context/.gitignore`) and the
 * general sync stage excludes it; only the exchange layer (data-exchange.ts, app-veri-ortak K5)
 * force-adds the owner-approved shared paths. Wherever that layer does not run (an in-tree brain,
 * cloud sync off), anything staged under it by hand is taken out of the index again before the
 * sync commits (data-stage.ts `dropStagedAppData`). Where it does run (full-repo), the push gate
 * holds a hand-made commit of app data and the pull gate refuses what may not come in. In-tree
 * has no push gate: a commit the owner makes by hand outside the sync is theirs to push. The
 * app's CODE stays beside the project.
 *
 * Every step of `_dream_context → apps → <slug>` must be a real folder, never a symlink: an
 * `lstat` per step, and the real path must equal the lexical one. A recursive mkdir would follow
 * a planted link, so the steps are made one by one.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { applyAgentPrivacy, brainPrefix } from '../agents/agent-sync.js';
import * as git from '../git-sync/git.js';
import { ensureGitignoreEntries, gitignoreCovers } from '../gitignore.js';
import { APP_SLUG_RE } from './bundle.js';
import { appsHome, type AppRecord } from './registry.js';

export const APPS_DATA_FOLDER = 'apps';
/** The tracked ignore line, ANCHORED: a bare `apps/` would also hide `knowledge/apps/`. */
export const APPS_GITIGNORE_LINE = '/apps/';
/**
 * The comment above it. The privacy block stays in both ignore layers: a normal `git add` never
 * takes app data; only the sync's exchange layer force-adds the owner-approved shared paths.
 */
export const APPS_GITIGNORE_COMMENT = 'dreamcontext Apps: app data stays on this Mac; only owner-approved hand-made data (emekle üretilmiş veri) goes to the team, through the sync';

export type AppDataCode = 'app_data_symlink' | 'app_data_conflict' | 'app_data_privacy' | 'app_instruction_file' | 'app_data_no_brain';

export class AppDataError extends Error {
  constructor(readonly code: AppDataCode, message: string, readonly paths: string[] = []) {
    super(`${code}: ${message}`);
    this.name = 'AppDataError';
  }
}

/**
 * Names that are instructions to an agent, not data. Compared lower-cased and NFC everywhere
 * (APFS opens `claude.md` as `CLAUDE.md`). Folders end with `/`.
 */
export const INSTRUCTION_NAMES: readonly string[] = ['claude.md', 'claude.local.md', 'agents.md', 'gemini.md', '.claude/', '.codex/', '.cursor/'];
/** What the app assistant may never write anywhere: the instruction names plus `.gitignore`. */
export const WRITE_REFUSED_NAMES: readonly string[] = [...INSTRUCTION_NAMES, '.gitignore'];

/**
 * Folded the way a case-insensitive file system may match a name, erring wide: compatibility forms
 * (NFKC) and a round trip through upper case, so `ſ` (long s) folds to `s` as APFS opens it
 * (`agentſ.md` is `AGENTS.md` there). An over-match only refuses more.
 */
export function foldName(name: string): string {
  return name.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFC');
}

export function isInstructionName(name: string, isDir: boolean, list: readonly string[] = INSTRUCTION_NAMES): boolean {
  const n = foldName(name);
  return list.includes(n) || (isDir && list.includes(`${n}/`));
}

export function contextRootOf(projectRoot: string): string {
  return join(projectRoot, '_dream_context');
}

export function appsDataRoot(projectRoot: string): string {
  return join(contextRootOf(projectRoot), APPS_DATA_FOLDER);
}

export function appDataDir(projectRoot: string, slug: string): string {
  if (!APP_SLUG_RE.test(slug)) throw new Error(`bad app slug: ${slug}`);
  return join(appsDataRoot(projectRoot), slug);
}

/** The data folder this Mac used before plan-veri: `~/.dreamcontext/apps/data/<hash>/`. */
export function legacyAppDataDir(home: string, hash: string): string {
  return join(appsHome(home), 'data', hash);
}

function realNative(p: string): string {
  return realpathSync.native(p);
}

/**
 * `_dream_context → apps → <slug>`: every step that exists is a real folder (not a symlink, not
 * a file) and the deepest one's real path is the lexical path. Missing steps are fine (ensure
 * makes them). Never throws.
 */
export function checkAppDataChain(projectRoot: string, slug: string): { ok: true } | { ok: false; code: 'app_data_symlink' | 'app_data_no_brain'; path: string } {
  let base: string;
  try { base = realNative(projectRoot); } catch { return { ok: false, code: 'app_data_no_brain', path: projectRoot }; }
  const steps = ['_dream_context', APPS_DATA_FOLDER, slug];
  let cur = base;
  for (const step of steps) {
    cur = join(cur, step);
    let st;
    try { st = lstatSync(cur); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        if (step === '_dream_context') return { ok: false, code: 'app_data_no_brain', path: cur };
        return { ok: true };
      }
      return { ok: false, code: 'app_data_symlink', path: cur };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, code: 'app_data_symlink', path: cur };
    try {
      if (realNative(cur) !== cur) return { ok: false, code: 'app_data_symlink', path: cur };
    } catch { return { ok: false, code: 'app_data_symlink', path: cur }; }
  }
  return { ok: true };
}

/** The exclude file's privacy line for `apps/`, or null when this brain is not in a git repo. */
function excludeLine(contextRoot: string): { file: string; line: string } | null {
  const gitCwd = join(contextRoot, '..');
  if (!git.isGitRepo(gitCwd)) return null;
  const file = git.gitPathFor(gitCwd, 'info/exclude');
  const prefix = brainPrefix(gitCwd, contextRoot);
  if (!file || prefix === null) return null;
  return { file, line: `/${prefix}${APPS_DATA_FOLDER}/` };
}

/**
 * Both ignore layers, written and READ BACK (applyAgentPrivacy swallows its errors). In a git
 * repo a layer that did not land throws `app_data_privacy`: no data folder without its ignore.
 * A project with no git still starts (nothing to ignore it from).
 */
export function ensureAppsPrivacy(contextRoot: string): void {
  let inGit = false;
  try { inGit = git.isGitRepo(join(contextRoot, '..')); } catch { inGit = false; }
  try { applyAgentPrivacy(contextRoot); } catch { /* read back below */ }
  const ex = inGit ? excludeLine(contextRoot) : null;
  if (inGit) {
    let text = '';
    try { text = ex ? readFileSync(ex.file, 'utf-8') : ''; } catch { text = ''; }
    if (!ex || !text.split('\n').some((l) => l.trim() === ex.line)) {
      throw new AppDataError('app_data_privacy', `the privacy line ${ex?.line ?? '/_dream_context/apps/'} could not be written to .git/info/exclude`);
    }
  }
  try { ensureGitignoreEntries(contextRoot, [APPS_GITIGNORE_LINE], { comment: APPS_GITIGNORE_COMMENT }); } catch (e) {
    if (inGit) throw new AppDataError('app_data_privacy', `_dream_context/.gitignore could not be written (${(e as Error).message})`);
  }
  if (inGit && !gitignoreCovers(contextRoot, [APPS_GITIGNORE_LINE])) {
    throw new AppDataError('app_data_privacy', `_dream_context/.gitignore does not hold ${APPS_GITIGNORE_LINE}`);
  }
}

// ─── the merge attribute line (app-veri-ortak K5) ──────────────────────────────────

/**
 * `/<prefix>apps/** -merge -diff` in `.git/info/attributes` (machine-local, never synced): git
 * never text-merges app data (a JSON file is a unit: one side or the other, never a blend) and
 * never prints its content in a diff. The sync engine writes it and READS IT BACK before every
 * merge; a pull that cannot have it is skipped.
 */
export function appsAttributeLine(prefix: string): string {
  return `/${prefix}${APPS_DATA_FOLDER}/** -merge -diff`;
}

/**
 * Ensure the attribute line. `ok`: present (written now or already there); `none`: the brain is
 * not in a git repo (nothing can merge into it); `failed`: could not be written or read back.
 * Never throws.
 */
export function ensureAppsMergeAttributes(gitCwd: string, contextRoot: string): 'ok' | 'none' | 'failed' {
  let prefix: string | null;
  try { prefix = brainPrefix(gitCwd, contextRoot); } catch { return 'failed'; }
  if (prefix === null) return 'none';
  const file = git.gitPathFor(gitCwd, 'info/attributes');
  if (!file) return 'failed';
  const line = appsAttributeLine(prefix);
  const has = (): boolean => {
    try { return readFileSync(file, 'utf-8').split('\n').some((l) => l.trim() === line); } catch { return false; }
  };
  if (has()) return 'ok';
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    let text = '';
    try { text = readFileSync(file, 'utf-8'); } catch { text = ''; }
    const lead = text && !text.endsWith('\n') ? '\n' : '';
    writeFileSync(file, `${text}${lead}# dreamcontext Apps: app data is never text-merged (a file is one side or the other)\n${line}\n`);
  } catch { return 'failed'; }
  return has() ? 'ok' : 'failed';
}

function mkdirStep(p: string): void {
  try { mkdirSync(p, { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new AppDataError('app_data_symlink', `${p} is not a real folder`, [p]);
}

/** `_dream_context/apps/` itself, privacy first, chain checked, made step by step. */
export function ensureAppsDataRoot(projectRoot: string): string {
  const contextRoot = contextRootOf(projectRoot);
  if (!existsSync(contextRoot)) throw new AppDataError('app_data_no_brain', `${contextRoot} does not exist`, [contextRoot]);
  ensureAppsPrivacy(contextRoot);
  const chain = checkAppDataChain(projectRoot, 'x');
  if (!chain.ok) throw new AppDataError(chain.code, `${chain.path} is a symlink or not a folder`, [chain.path]);
  const root = join(realNative(projectRoot), '_dream_context', APPS_DATA_FOLDER);
  mkdirStep(root);
  return root;
}

/** The app's data folder, made if missing. Throws {@link AppDataError}. */
export function ensureAppDataDir(projectRoot: string, slug: string): string {
  if (!APP_SLUG_RE.test(slug)) throw new Error(`bad app slug: ${slug}`);
  const root = ensureAppsDataRoot(projectRoot);
  const chain = checkAppDataChain(projectRoot, slug);
  if (!chain.ok) throw new AppDataError(chain.code, `${chain.path} is a symlink or not a folder`, [chain.path]);
  const dir = join(root, slug);
  mkdirStep(dir);
  const again = checkAppDataChain(projectRoot, slug);
  if (!again.ok) throw new AppDataError(again.code, `${again.path} is a symlink or not a folder`, [again.path]);
  return dir;
}

// ─── what is inside ────────────────────────────────────────────────────────────────

export interface AppDataScan {
  files: number;
  /** First instruction-named entry (CLAUDE.md, .claude/, …), absolute, or null. */
  instruction: string | null;
  /** First symlink, absolute, or null. */
  symlink: string | null;
  truncated: boolean;
}

/** lstat-only walk (never follows a link), depth and entry capped. Never throws. */
export function scanAppData(dir: string, opts: { maxDepth?: number; maxEntries?: number } = {}): AppDataScan {
  const maxDepth = opts.maxDepth ?? 6;
  const maxEntries = opts.maxEntries ?? 2000;
  const out: AppDataScan = { files: 0, instruction: null, symlink: null, truncated: false };
  let seen = 0;
  const walk = (d: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      if (++seen > maxEntries) { out.truncated = true; return; }
      const p = join(d, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { out.symlink ??= p; continue; }
      if (isInstructionName(name, st.isDirectory())) out.instruction ??= p;
      if (st.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1); else out.truncated = true;
      } else if (st.isFile()) out.files++;
      if (out.truncated) return;
    }
  };
  walk(dir, 1);
  return out;
}

export function isEmptyDir(p: string): boolean {
  try { return readdirSync(p).filter((n) => n !== '.DS_Store').length === 0; } catch { return false; }
}

/** True when `abs` (lexical or real) is inside `<contextRoot>/apps/`, letter case folded. */
export function isInsideAppsData(contextRoot: string, abs: string): boolean {
  const inside = (root: string, p: string) => {
    const r = relative(foldName(root), foldName(p));
    return r !== '' && !r.startsWith('..') && !isAbsolute(r);
  };
  const root = join(contextRoot, APPS_DATA_FOLDER);
  if (inside(root, abs) || foldName(root) === foldName(abs)) return true;
  try {
    const realRoot = join(realNative(contextRoot), APPS_DATA_FOLDER);
    let realAbs: string;
    try { realAbs = realNative(abs); } catch { return false; }
    return inside(realRoot, realAbs) || foldName(realRoot) === foldName(realAbs);
  } catch { return false; }
}

// ─── moving the old data in ────────────────────────────────────────────────────────

export type MigrateResult =
  | { status: 'none' }
  | { status: 'skipped'; why: 'no_brain' }
  | { status: 'moved'; via: 'rename' | 'copy'; from: string; to: string; skippedLinks: string[] }
  | { status: 'refused'; code: AppDataCode; message: string; paths: string[] };

/** Copy without following a link: links are left out and reported. */
function copyNoLinks(from: string, to: string, skipped: string[]): void {
  mkdirSync(to, { mode: 0o700 });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    const st = lstatSync(src);
    if (st.isSymbolicLink()) { skipped.push(src); continue; }
    if (st.isDirectory()) copyNoLinks(src, dst, skipped);
    else if (st.isFile()) cpSync(src, dst, { preserveTimestamps: true, errorOnExist: true });
  }
}

/**
 * Move `~/.dreamcontext/apps/data/<hash>/` into `_dream_context/apps/<slug>/`, once. Idempotent:
 * no old folder = nothing to do. Never overwrites: two folders that both hold data are a
 * conflict for the owner. A symlinked old folder is never followed.
 */
export function migrateAppData(
  home: string,
  rec: Pick<AppRecord, 'projectRoot' | 'slug' | 'hash'>,
  /** Tests force the other-volume path with a rename that throws EXDEV. */
  deps: { rename?: (from: string, to: string) => void } = {},
): MigrateResult {
  const old = legacyAppDataDir(home, rec.hash);
  let st;
  try { st = lstatSync(old); } catch { return { status: 'none' }; }
  if (!existsSync(contextRootOf(rec.projectRoot))) return { status: 'skipped', why: 'no_brain' };
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { status: 'refused', code: 'app_data_symlink', message: `the old data folder ${old} is a symlink or not a folder; it was not moved`, paths: [old] };
  }
  let root: string;
  try { root = ensureAppsDataRoot(rec.projectRoot); } catch (e) {
    const err = e instanceof AppDataError ? e : new AppDataError('app_data_privacy', (e as Error).message);
    return { status: 'refused', code: err.code, message: err.message, paths: err.paths };
  }
  const chain = checkAppDataChain(rec.projectRoot, rec.slug);
  if (!chain.ok) return { status: 'refused', code: chain.code, message: `${chain.path} is a symlink or not a folder`, paths: [chain.path] };
  const to = join(root, rec.slug);
  if (isEmptyDir(old)) {
    try { rmSync(old, { recursive: true, force: true }); } catch { /* left for the next start */ }
    return { status: 'none' };
  }
  if (existsSync(to)) {
    if (!isEmptyDir(to)) {
      return {
        status: 'refused', code: 'app_data_conflict',
        message: `both ${old} and ${to} hold data. Keep one: a backend left running by a crashed session may have reopened the old folder.`,
        paths: [old, to],
      };
    }
    try { rmdirSync(to); } catch { /* a .DS_Store: rmSync below */ rmSync(to, { recursive: true, force: true }); }
  }
  try {
    (deps.rename ?? renameSync)(old, to);
    const scan = scanAppData(to);
    return { status: 'moved', via: 'rename', from: old, to, skippedLinks: scan.symlink ? [scan.symlink] : [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') {
      return { status: 'refused', code: 'app_data_conflict', message: `could not move ${old} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, paths: [old, to] };
    }
  }
  // Another volume: copy beside the target under a temporary name, then one rename.
  const tmp = join(root, `.${rec.slug}.migrating-${randomBytes(4).toString('hex')}`);
  const skipped: string[] = [];
  try {
    copyNoLinks(old, tmp, skipped);
    if (existsSync(to)) throw Object.assign(new Error('target appeared'), { code: 'EEXIST' });
    renameSync(tmp, to);
  } catch (e) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return { status: 'refused', code: 'app_data_conflict', message: `could not copy ${old} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, paths: [old, to] };
  }
  try { rmSync(old, { recursive: true, force: true }); } catch { /* the copy is in place; the old one is left */ }
  return { status: 'moved', via: 'copy', from: old, to, skippedLinks: skipped };
}

