/**
 * Every project's `_dream_context/tmp/` cleans itself (owner 2026-11-09): Super reports, briefs,
 * mockups, sleep evals and test outputs piled up to 2.3 GB in one brain because nothing but the
 * composer drops (agent-drops.ts, its own 7-day rule) was ever removed.
 *
 * THE RULE (owner's brief: mtime). A FILE under tmp whose mtime is older than TMP_TTL_MS goes,
 * unless its folder's mtime is younger (a file moved or `cp -p`'d in keeps its old mtime, but the
 * folder it landed in records the arrival). A folder this pass left empty goes with it. Not
 * ctime: one tree-wide xattr or permission change (field 2026-11-07, 10,588 files in one hour)
 * makes every file look new and the clean frees nothing. A whole folder moved or `cp -Rp`'d in,
 * or an archive extracted with its old dates, has no arrival signal left and ages like the rest. Whatever its age, a file is KEPT when:
 *  1. the brain links it: its tmp path, or a folder above it, is written in a text file of the
 *     brain's own records (REF_ROOTS: tasks and their assets, knowledge, core, bookmarks in
 *     `state/.sleep.json`, the Super handoff and state with its card refs and pending ask
 *     previews, automations, agents, people, whiteboards). Machine copies that only quote
 *     transcripts or old trees (session digests, pre-pull backups, conflict leftovers, search
 *     indexes) are not records: their generic mentions (`tmp/super-prompts/`) would keep
 *     everything. A link is matched as a string PREFIX, so a link to a folder keeps the whole
 *     folder and a link cut short by an odd character keeps more, never less;
 *  2. a live Super child uses it: a child not ended keeps `tmp/super-prompts/<slug>/` and
 *     `tmp/super/<slug>/` (its brief and its reports), whatever their age;
 *  3. it, or the folder it sits in, was touched in the last TMP_TTL_MS;
 *  4. it sits in a git checkout inside tmp (a folder holding `.git`): kept whole, never half-deleted.
 * `agent-drops/` and this module's own stamp and receipt are never walked. When a records root
 * cannot be read whole (unreadable, a symlink, a record too big to read), the vault is skipped:
 * a link we could not read is never taken as no link.
 *
 * SAFETY (soul: every path reading vault content rejects symlinks). A tmp that is itself a
 * symlink is refused whole. The walk uses lstat only: a symlink inside tmp is neither followed
 * nor deleted. Before each unlink the parent's real path must sit inside tmp's real path and the
 * entry must still be a plain file. Nothing outside tmp is ever written: the stamp and the
 * receipt live inside tmp too.
 *
 * A DELETE NAMES WHAT WENT (knowledge/patterns/a-delete-is-never-inferred-from-absence.md): every
 * real pass appends one line per removed file to `tmp/.tmp-clean.log` (time, bytes, path), so the
 * owner can always see what the clean took. A dry run removes and writes nothing.
 *
 * WHEN. `cleanAllVaultTmps` runs from the automations tick (every minute, also while the app is
 * closed) for every vault and registered project on this Mac; `.tmp-clean.json` holds the last
 * run so each vault is cleaned at most once a day. Best effort: errors are logged, never thrown.
 */
import {
  appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync,
  truncateSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { listVaults } from './vaults.js';
import { listRegisteredProjects } from './automations/registry.js';

export const TMP_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const TMP_CLEAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const TMP_CLEAN_STAMP = '.tmp-clean.json';
export const TMP_CLEAN_LOG = '.tmp-clean.log';
/** Never walked: the drop folder keeps its own 7-day rule, the rest are this module's or git's. */
const TOP_LEVEL_SKIP = new Set(['agent-drops', '.gitignore', TMP_CLEAN_STAMP, TMP_CLEAN_LOG]);
/** Brain files never read for links: media and archives (any other file is read as text). */
const REF_BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.ico', '.bmp', '.tif', '.tiff', '.mp4', '.mov', '.webm',
  '.m4v', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.dmg', '.woff', '.woff2', '.ttf', '.otf', '.sqlite', '.db', '.bin', '.onnx', '.npy',
]);
/** A record bigger than this cannot be read for links: the vault is skipped, never cleaned blind. */
const REF_MAX_BYTES = 64 * 1024 * 1024;
/** The brain's records read for links (relative to `_dream_context/`). */
const REF_ROOTS = ['state', 'knowledge', 'core', 'automations', 'agents', 'people', 'whiteboards'];
/** Machine folders under those roots that quote, not link. */
const REF_SKIP_DIR = (name: string): boolean =>
  name === '.git' || name === 'node_modules' || name === '.session-digests' || name === '.conflicts'
  || name === '.locks' || name.startsWith('.pre-pull-');
const MAX_DEPTH = 64;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

export interface TmpCleanEntry { path: string; bytes: number }

export interface TmpCleanResult {
  contextRoot: string;
  dryRun: boolean;
  /** Why nothing was removed: tmp missing, tmp a symlink, cleaned less than a day ago, or the
   *  brain's records could not all be read (their links unknown). */
  skipped?: 'missing' | 'symlink' | 'not-due' | 'unreadable-records';
  /** Removed (or, in a dry run, would be removed), tmp-relative. */
  deleted: TmpCleanEntry[];
  bytes: number;
  kept: { linked: number; live: number; recent: number; symlink: number; repo: number };
  dirsRemoved: string[];
  errors: string[];
}

export interface TmpCleanOptions {
  now?: number;
  dryRun?: boolean;
}

// ─── What the brain links ────────────────────────────────────────────────────

/**
 * `tmp` as a path segment, whatever comes before it: `_dream_context/tmp/x`, `../../../tmp/x`,
 * `**tmp/x**`, `_dream_context\tmp\x`. Reading too much only keeps more (an OS `/tmp/x` mention
 * keeps a tmp file of that name), never less, so the reader leans that way everywhere.
 */
const REF_RE = /(?<![A-Za-z0-9])tmp[\\/]+([^\s"'`()<>|,;]*)(<?)/g;
/** A template's stand-in (`<slug>`, `{slug}`, `$SLUG`, `*`, `[n]`). */
const PLACEHOLDER = /[{}$*[\]]/;

/**
 * Every tmp-relative prefix a text names. A link is cut at the first character a path rarely
 * holds or an escape starts with (`\`, `%`, `#`, `?`, a stand-in): the shorter prefix keeps more.
 * A template whose stand-in is a whole segment (`tmp/super-prompts/<slug>/`) names nothing, or it
 * would keep the whole folder; a stand-in inside a name (`shot[1].png`) keeps its prefix.
 */
export function extractTmpRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    let ref = m[1];
    let template = m[2] === '<';
    const ph = ref.search(PLACEHOLDER);
    if (ph >= 0) { ref = ref.slice(0, ph); template = true; }
    const cut = ref.search(/[\\%#?]/);
    if (cut >= 0) { ref = ref.slice(0, cut); template = false; }
    if (template && (ref === '' || ref.endsWith('/'))) continue;
    ref = ref.replace(/^(\.\/)+/, '');
    if (!template && cut < 0) ref = ref.replace(/[.,:;!]+$/, '');
    if (ref.length > 0) out.push(ref);
  }
  return out;
}

function walkRefFiles(dir: string, depth: number, visit: (abs: string) => void, incomplete: string[]): void {
  if (depth > MAX_DEPTH) { incomplete.push(`too deep: ${dir}`); return; }
  let names: string[];
  try { names = readdirSync(dir); } catch (err) { incomplete.push(`read ${dir}: ${(err as Error).message}`); return; }
  for (const name of names) {
    const abs = join(dir, name);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    // A symlinked record is never read (soul rule); what it would link stays unknown, so a link
    // inside the brain's records must be a real file to count. Inside a records root such a link
    // is not a record of this brain.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (REF_SKIP_DIR(name)) continue;
      walkRefFiles(abs, depth + 1, visit, incomplete);
    } else if (st.isFile() && !REF_BINARY_EXT.has(extname(name).toLowerCase())) {
      if (st.size > REF_MAX_BYTES) { incomplete.push(`too big to read: ${abs}`); continue; }
      visit(abs);
    }
  }
}

/** A Super child that has not ended keeps its brief and report folders (`super/<slug>` branch). */
function liveChildPrefixes(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const children = (parsed as { children?: unknown }).children;
  if (!children || typeof children !== 'object') return [];
  const out: string[] = [];
  for (const ch of Object.values(children as Record<string, unknown>)) {
    if (!ch || typeof ch !== 'object') continue;
    const c = ch as { branch?: unknown; endedAt?: unknown; succeededBy?: unknown };
    if (c.endedAt !== undefined || c.succeededBy) continue;
    const m = typeof c.branch === 'string' ? /^super\/([A-Za-z0-9._-]+)$/.exec(c.branch) : null;
    if (m) out.push(`super-prompts/${m[1]}/`, `super/${m[1]}/`);
  }
  return out;
}

export interface Protection {
  linked: string[];
  live: string[];
  /** Records that could not be read: their links are unknown, so nothing may be removed. */
  incomplete: string[];
}

/** Read the brain once: every tmp path it links, and every live child's folders. */
export function collectProtection(contextRoot: string): Protection {
  const linked = new Set<string>();
  const live = new Set<string>();
  const incomplete: string[] = [];
  const visit = (abs: string): void => {
    let text: string;
    try { text = readFileSync(abs, 'utf-8'); } catch (err) { incomplete.push(`read ${abs}: ${(err as Error).message}`); return; }
    // Binary content that slipped past the extension list holds no links worth reading.
    if (text.slice(0, 8192).includes('\u0000')) return;
    if (/tmp[\\/]/.test(text)) for (const r of extractTmpRefs(text)) linked.add(r);
    if (abs.endsWith('.json') && text.includes('"children"')) {
      try { for (const p of liveChildPrefixes(JSON.parse(text))) live.add(p); } catch { /* not JSON: links already read */ }
    }
  };
  for (const root of REF_ROOTS) {
    const abs = join(contextRoot, root);
    let st;
    try { st = lstatSync(abs); } catch { continue; } // absent: nothing there links anything
    if (st.isSymbolicLink() || !st.isDirectory()) { incomplete.push(`not a plain folder: ${root}`); continue; }
    walkRefFiles(abs, 1, visit, incomplete);
  }
  return { linked: [...linked], live: [...live], incomplete };
}

const startsWithAny = (rel: string, prefixes: readonly string[]): boolean => prefixes.some((p) => rel.startsWith(p));

// ─── The pass ────────────────────────────────────────────────────────────────

function inside(realRoot: string, realPath: string): boolean {
  return realPath === realRoot || realPath.startsWith(realRoot + sep);
}

/** Clean one vault's tmp now (no once-a-day check). Never throws. */
export function cleanTmp(contextRoot: string, opts: TmpCleanOptions = {}): TmpCleanResult {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun === true;
  const result: TmpCleanResult = {
    contextRoot, dryRun, deleted: [], bytes: 0, kept: { linked: 0, live: 0, recent: 0, symlink: 0, repo: 0 }, dirsRemoved: [], errors: [],
  };
  const tmpRoot = join(contextRoot, 'tmp');
  let realTmp: string;
  try {
    const st = lstatSync(tmpRoot);
    if (st.isSymbolicLink()) return { ...result, skipped: 'symlink' };
    if (!st.isDirectory()) return { ...result, skipped: 'missing' };
    realTmp = realpathSync(tmpRoot);
  } catch {
    return { ...result, skipped: 'missing' };
  }
  const protection = collectProtection(contextRoot);
  if (protection.incomplete.length > 0) {
    return { ...result, skipped: 'unreadable-records', errors: protection.incomplete.slice(0, 20) };
  }
  const touchedDirs = new Set<string>();

  const walk = (dir: string, depth: number, dirRecent: boolean): void => {
    if (depth > MAX_DEPTH) return;
    let names: string[];
    try { names = readdirSync(dir); } catch (err) { result.errors.push(`read ${dir}: ${(err as Error).message}`); return; }
    // A git checkout inside tmp is someone's work tree: kept whole, never thinned file by file.
    if (depth > 0 && names.includes('.git')) { result.kept.repo += 1; return; }
    for (const name of names) {
      if (depth === 0 && TOP_LEVEL_SKIP.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) { result.kept.symlink += 1; continue; }
      const rel = relative(tmpRoot, abs).split(sep).join('/');
      if (st.isDirectory()) { walk(abs, depth + 1, now - st.mtimeMs <= TMP_TTL_MS); continue; }
      if (!st.isFile()) continue;
      if (startsWithAny(rel, protection.live)) { result.kept.live += 1; continue; }
      if (startsWithAny(rel, protection.linked)) { result.kept.linked += 1; continue; }
      if (dirRecent || now - st.mtimeMs <= TMP_TTL_MS) { result.kept.recent += 1; continue; }
      if (!dryRun) {
        try {
          // The parent must still resolve inside tmp and the entry still be a plain file: a folder
          // swapped for a link mid-walk never sends an unlink outside tmp.
          if (!inside(realTmp, realpathSync(dirname(abs)))) { result.errors.push(`outside tmp: ${rel}`); continue; }
          const again = lstatSync(abs);
          if (again.isSymbolicLink() || !again.isFile()) continue;
          unlinkSync(abs);
        } catch (err) {
          result.errors.push(`remove ${rel}: ${(err as Error).message}`);
          continue;
        }
        touchedDirs.add(dirname(abs));
      }
      result.deleted.push({ path: rel, bytes: st.size });
      result.bytes += st.size;
    }
  };
  // tmp's own mtime moves whenever anything lands at its top: the top level reads file mtimes only.
  walk(tmpRoot, 0, false);

  if (!dryRun) {
    removeEmptiedDirs(tmpRoot, realTmp, touchedDirs, protection, result);
    writeReceipt(tmpRoot, now, result);
  }
  return result;
}

/** Folders this pass emptied go, deepest first, then their parents if they emptied too. */
function removeEmptiedDirs(tmpRoot: string, realTmp: string, dirs: Set<string>, protection: Protection, result: TmpCleanResult): void {
  const queue = [...dirs];
  const seen = new Set<string>();
  while (queue.length) {
    queue.sort((a, b) => b.length - a.length);
    const dir = queue.shift() as string;
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (resolve(dir) === resolve(tmpRoot) || !resolve(dir).startsWith(resolve(tmpRoot) + sep)) continue;
    const rel = relative(tmpRoot, dir).split(sep).join('/');
    if (rel.split('/')[0] === 'agent-drops') continue;
    // A linked or live folder stays even when empty: its link still points somewhere.
    const asDir = `${rel}/`;
    const named = (p: string): boolean => p === rel || p === asDir || p.startsWith(asDir);
    if (protection.linked.some(named) || protection.live.some(named)) continue;
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (!inside(realTmp, realpathSync(dir))) continue;
      if (readdirSync(dir).length > 0) continue;
      rmdirSync(dir);
      result.dirsRemoved.push(rel);
      queue.push(dirname(dir));
    } catch { /* busy or already gone: kept */ }
  }
}

function writeReceipt(tmpRoot: string, now: number, result: TmpCleanResult): void {
  if (result.deleted.length === 0) return;
  const logPath = join(tmpRoot, TMP_CLEAN_LOG);
  try {
    if (existsSync(logPath)) {
      const st = lstatSync(logPath);
      if (st.isSymbolicLink() || !st.isFile()) return;
      if (st.size > LOG_MAX_BYTES) {
        const tail = readFileSync(logPath, 'utf-8').slice(-Math.floor(LOG_MAX_BYTES / 2));
        truncateSync(logPath, 0);
        appendFileSync(logPath, tail.slice(tail.indexOf('\n') + 1));
      }
    }
    const at = new Date(now).toISOString();
    appendFileSync(logPath, result.deleted.map((d) => `${at}\t${d.bytes}\t${d.path}\n`).join(''));
  } catch (err) {
    result.errors.push(`receipt: ${(err as Error).message}`);
  }
}

// ─── Once a day ──────────────────────────────────────────────────────────────

export function readLastClean(contextRoot: string): number | null {
  const p = join(contextRoot, 'tmp', TMP_CLEAN_STAMP);
  try {
    if (lstatSync(p).isSymbolicLink()) return null;
    const v = (JSON.parse(readFileSync(p, 'utf-8')) as { lastRunAt?: unknown }).lastRunAt;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function writeStamp(contextRoot: string, now: number, result: TmpCleanResult): void {
  const p = join(contextRoot, 'tmp', TMP_CLEAN_STAMP);
  try {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) return;
    writeFileSync(p, `${JSON.stringify({ lastRunAt: now, deleted: result.deleted.length, bytes: result.bytes, errors: result.errors.length })}\n`);
  } catch { /* best effort: the next tick tries again */ }
}

/** Clean when the last real pass is a day old or more; a real pass stamps the vault. */
export function cleanTmpIfDue(contextRoot: string, opts: TmpCleanOptions = {}): TmpCleanResult {
  const now = opts.now ?? Date.now();
  const last = readLastClean(contextRoot);
  if (last !== null && now - last < TMP_CLEAN_INTERVAL_MS && now >= last) {
    return { contextRoot, dryRun: opts.dryRun === true, skipped: 'not-due', deleted: [], bytes: 0, kept: { linked: 0, live: 0, recent: 0, symlink: 0, repo: 0 }, dirsRemoved: [], errors: [] };
  }
  const result = cleanTmp(contextRoot, { ...opts, now });
  if (!result.dryRun && result.skipped === undefined) writeStamp(contextRoot, now, result);
  return result;
}

/** Stamp a manual `tmp clean` too, so the tick does not walk the same tree again that day. */
export function stampTmpClean(contextRoot: string, now: number, result: TmpCleanResult): void {
  if (!result.dryRun && result.skipped === undefined) writeStamp(contextRoot, now, result);
}

/** Every vault and registered project on this Mac, once a day each. Never throws. */
export function cleanAllVaultTmps(opts: { home?: string; now?: number; log?: (line: string) => void } = {}): TmpCleanResult[] {
  const log = opts.log ?? (() => {});
  const roots = new Set<string>();
  try { for (const v of listVaults(opts.home)) roots.add(resolve(v.path)); } catch { /* registry unreadable */ }
  try { for (const p of listRegisteredProjects(opts.home)) roots.add(resolve(p)); } catch { /* registry unreadable */ }
  const out: TmpCleanResult[] = [];
  for (const root of roots) {
    const contextRoot = join(root, '_dream_context');
    try {
      if (!existsSync(contextRoot) || lstatSync(contextRoot).isSymbolicLink()) continue;
      const r = cleanTmpIfDue(contextRoot, { now: opts.now });
      out.push(r);
      if (r.skipped === undefined) {
        log(`[tmp-clean] ${root}: removed ${r.deleted.length} file(s), ${formatBytes(r.bytes)}${r.errors.length ? `, ${r.errors.length} error(s): ${r.errors.slice(0, 3).join('; ')}` : ''}`);
      }
    } catch (err) {
      log(`[tmp-clean] ${root}: ${(err as Error)?.message ?? err}`);
    }
  }
  return out;
}

// ─── Measuring ───────────────────────────────────────────────────────────────

/** tmp's size, symlinks neither followed nor counted. */
export function tmpSize(contextRoot: string): { bytes: number; files: number } | null {
  const tmpRoot = join(contextRoot, 'tmp');
  try {
    const st = lstatSync(tmpRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch {
    return null;
  }
  let bytes = 0;
  let files = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, depth + 1);
      else if (st.isFile()) { bytes += st.size; files += 1; }
    }
  };
  walk(tmpRoot, 0);
  return { bytes, files };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
