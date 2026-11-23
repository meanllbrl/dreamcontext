import { execFile } from 'node:child_process';
import { promises as fsp, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { childCheckout, git, homeContains, listedWorktreesFor, refsAreHome } from './worktrees.js';
import { distDirs, diskUsage, rustTargets } from './disk-leftovers.js';
import { listVaults, vaultsFilePath } from '../vaults.js';
import { MEMBER_SUPER_DIR, okMember, readSuperState, superIdOfMember, superRecordPath, withSuperState } from './store.js';
import { SUPER_BRANCH_RE, validBase } from './types.js';
import type { SuperChild, SuperId, SuperState } from './types.js';

/** Every super record path of a vault: main's, then each member Super's (plan-r10 1). A members
 *  folder that is a link, or unreadable, adds none (never followed). */
function superRecordPaths(root: string): Array<{ id: SuperId; path: string }> {
  const out: Array<{ id: SuperId; path: string }> = [{ id: 'main', path: superRecordPath(root, 'main') }];
  try {
    for (const rel of [join('state', '.super'), MEMBER_SUPER_DIR]) {
      const st = lstatSync(join(root, rel));
      if (st.isSymbolicLink() || !st.isDirectory()) return out;
    }
    for (const name of readdirSync(join(root, MEMBER_SUPER_DIR)).sort()) {
      if (!name.endsWith('.json') || name.endsWith('.read-marks.json')) continue;
      const slug = name.slice(0, -'.json'.length);
      if (!okMember(slug)) continue;
      const id = superIdOfMember(slug);
      out.push({ id, path: superRecordPath(root, id) });
    }
  } catch { /* no members folder: main's only */ }
  return out;
}

/**
 * `super clean`'s sweep of `~/.claude-worktrees/` (CPU RCA K1, 2026-10-29: 122 GB in 211 folders,
 * 9.4 GB free, the Mac in swap). The child-only clean reached a sliver of it: release worktrees
 * (`*-surum-*`, `*-yayin-*`), hand-made worktrees, every `node_modules` and Rust `target/` were
 * out of its scope.
 *
 * DELETING IS IRREVERSIBLE, so the sweep is a PLAN first: every folder lands in exactly one row,
 * either something it would remove (with its size and why) or something it keeps (with the
 * reason). A real run re-checks each row against fresh facts right before it acts.
 *
 * Never touched (each one a keep reason): a worktree a running process uses (its cwd, an open
 * file, or a path on its command line), the target of a global `dreamcontext` link (nvm, brew,
 * the desktop app's CLI path), a worktree of a child that is not ended or still has an open
 * question in any vault's Super Agent record, anything with uncommitted changes, anything whose
 * commits exist on no other branch or remote, a main checkout, a folder git does not know.
 * Removing a worktree goes through `git worktree remove` (never `--force`): the branch stays.
 */

export const SWEEP_CATEGORIES = ['child-worktree', 'release-worktree', 'stale-worktree', 'build-output', 'test-tmp'] as const;
export type SweepCategory = typeof SWEEP_CATEGORIES[number];

export const KEEP_REASONS = [
  'in-use', 'global-cli', 'live-child', 'dirty', 'unmerged', 'recent', 'main-checkout', 'not-a-worktree', 'unreadable',
] as const;
export type KeepReason = typeof KEEP_REASONS[number];

const DAY = 86_400_000;
/** Heavy build outputs of a worktree idle this long go (they come back with one install/build). */
export const BUILD_IDLE_MS = DAY;
/** A release worktree idle this long goes whole: a release is cut once and then only read. */
export const RELEASE_IDLE_MS = 2 * DAY;
/** Any other worktree idle this long goes whole. */
export const STALE_IDLE_MS = 7 * DAY;

export const RELEASE_NAME_RE = /-(surum|yayin|release)-/;

// ─── Facts ──────────────────────────────────────────────────────────────────────

export interface WorktreeFacts {
  path: string;
  /** `worktree`: a linked worktree git knows; `main-checkout`: a repo's own `.git` dir;
   *  `not-a-worktree`: no `.git`; `broken`: a `.git` file whose admin dir is gone. */
  shape: 'worktree' | 'main-checkout' | 'not-a-worktree' | 'broken';
  /** The main checkout of its repo (where `git worktree remove` runs). */
  repo: string | null;
  branch: string | null;
  /** null: git could not say (counts as dirty). */
  dirty: boolean | null;
  /** HEAD is contained in some OTHER branch or remote-tracking branch. null: git could not say. */
  safe: boolean | null;
  /** HEAD is contained in some other LOCAL branch (merged). */
  merged: boolean | null;
  /** Newest of: HEAD/index/reflog in its admin dir, the folder itself (epoch ms). */
  lastActive: number;
  /** Real (not symlinked) `node_modules` dirs and Rust `target/` dirs inside it. */
  heavy: string[];
}

const mtime = async (p: string): Promise<number> => { try { return (await fsp.stat(p)).mtimeMs; } catch { return 0; } };

/** Real `node_modules` dirs a few levels down (never inside another one, never through a link). */
export async function nodeModulesDirs(root: string, depth = 3): Promise<string[]> {
  const found: string[] = [];
  const walk = async (d: string, left: number): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name === 'node_modules') { found.push(join(d, e.name)); continue; }
      if (left <= 0 || e.name === 'target' || e.name.startsWith('.')) continue;
      await walk(join(d, e.name), left - 1);
    }
  };
  await walk(root, depth);
  return found;
}

/** What git and the disk say about one folder under the root. */
export async function inspectWorktree(path: string): Promise<WorktreeFacts> {
  const base: WorktreeFacts = { path, shape: 'not-a-worktree', repo: null, branch: null, dirty: null, safe: null, merged: null, lastActive: await mtime(path), heavy: [] };
  const dotGit = join(path, '.git');
  let st: import('node:fs').Stats;
  try { st = await fsp.lstat(dotGit); } catch { return base; }
  if (st.isDirectory()) return { ...base, shape: 'main-checkout', repo: path };
  let admin: string;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(await fsp.readFile(dotGit, 'utf-8'));
    if (!m) return { ...base, shape: 'broken' };
    admin = resolve(path, m[1].trim());
    await fsp.access(join(admin, 'HEAD'));
  } catch { return { ...base, shape: 'broken' }; }
  let common = join(admin, '..', '..');
  try { common = resolve(admin, (await fsp.readFile(join(admin, 'commondir'), 'utf-8')).trim()); } catch { /* the usual layout */ }
  const repo = basename(common) === '.git' ? dirname(common) : common;
  const lastActive = Math.max(base.lastActive, ...(await Promise.all(['HEAD', 'index', join('logs', 'HEAD')].map((f) => mtime(join(admin, f))))));
  // Build output only when git ignores it (D13): a tracked `dist` or `target` is source.
  const heavy = await ignoredOnly(path, [...(await nodeModulesDirs(path)), ...(await rustTargets(path)), ...(await distDirs(path))]);

  const head = await git(path, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = head.code === 0 ? head.stdout.trim() || null : null;
  const status = await git(path, ['--no-optional-locks', 'status', '--porcelain']);
  const dirty = status.code === 0 ? status.stdout.trim().length > 0 : null;
  const refs = await git(path, ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  let safe: boolean | null = null;
  let merged: boolean | null = null;
  if (refs.code === 0) {
    const all = refs.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const others = all.filter((r) => r !== `refs/heads/${branch}` && !/^refs\/remotes\/[^/]+\/HEAD$/.test(r));
    safe = others.length > 0;
    // A label only (D9): HEAD reached home (a remote branch that is not a pushed super/* cut, or a
    // local default branch, dev or beta).
    merged = await refsAreHome(repo, all).catch(() => false);
  }
  return { path, shape: 'worktree', repo, branch, dirty, safe, merged, lastActive, heavy };
}

/** The paths git ignores in `worktree` (`git check-ignore -q`, one call each: exit 0 = ignored). */
async function ignoredOnly(worktree: string, paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    if (!p.startsWith(worktree + sep)) continue;
    const rel = p.slice(worktree.length + 1);
    if ((await git(worktree, ['check-ignore', '-q', '--', rel])).code === 0) out.push(p);
  }
  return out;
}

// ─── Guards ─────────────────────────────────────────────────────────────────────

export interface SweepGuards {
  /** Paths running processes use (cwd, open files, command-line words). null: could not list
   *  processes, so nothing may go (fail toward keeping). */
  inUse: readonly string[] | null;
  /** Command lines, matched by substring (a path on a command line may hold spaces). */
  commands: readonly string[];
  /** Real paths the global `dreamcontext` links point at. */
  cliTargets: readonly string[];
  /** Worktree → why a child still holds it (not ended, or an open question). */
  held: ReadonlyMap<string, string>;
  /** Worktree → the ENDED child of this vault whose record names it. */
  ended: ReadonlyMap<string, EndedRow>;
  /** Set when a child record could not be read: which worktrees children hold is unknown, so
   *  nothing may go (fail toward keeping). */
  unsure?: string;
}

/** An ENDED child of this vault naming a worktree, and the Super record that holds it. */
export interface EndedRow { child: string; branch?: string; endedAt?: number; superId: SuperId }

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

export type Verdict =
  | { action: 'remove'; category: 'child-worktree' | 'release-worktree' | 'stale-worktree'; why: string }
  | { action: 'strip'; why: string }
  | { action: 'keep'; reason: KeepReason; why: string };

const days = (ms: number) => `${Math.floor(ms / DAY)}d`;

/** One folder's verdict. Pure: every fact it weighs is in its arguments. */
export function classify(f: WorktreeFacts, g: SweepGuards, now: number): Verdict {
  if (f.shape === 'not-a-worktree') return { action: 'keep', reason: 'not-a-worktree', why: 'no .git here: not a worktree git knows, report only' };
  if (f.shape === 'main-checkout') return { action: 'keep', reason: 'main-checkout', why: 'a repository\'s own checkout, never removed' };
  if (f.shape === 'broken') return { action: 'keep', reason: 'unreadable', why: 'its git admin dir is gone (`git worktree prune` territory), report only' };
  if (g.unsure) return { action: 'keep', reason: 'unreadable', why: g.unsure };
  if (g.inUse === null) return { action: 'keep', reason: 'in-use', why: 'could not list running processes, so nothing is removed' };
  if (g.inUse.some((p) => under(p, f.path)) || g.commands.some((c) => c.includes(f.path + sep) || c.includes(f.path + ' ') || c.endsWith(f.path))) {
    return { action: 'keep', reason: 'in-use', why: 'a running process works in it' };
  }
  const cli = g.cliTargets.find((t) => under(t, f.path));
  if (cli) return { action: 'keep', reason: 'global-cli', why: `the global dreamcontext link points into it (${cli})` };
  const held = g.held.get(f.path);
  if (held) return { action: 'keep', reason: 'live-child', why: held };
  const ended = g.ended.get(f.path);
  const idle = now - Math.max(f.lastActive, ended?.endedAt ?? 0);
  // D13: a dirty tree stays; only its git-ignored build output goes (an ended child's at once,
  // anyone else's once idle a day).
  if (f.dirty !== false) {
    if (f.dirty === true && f.heavy.length && (ended || idle >= BUILD_IDLE_MS)) {
      return { action: 'strip', why: ended ? `child ${ended.child} ended with uncommitted changes: only its git-ignored build output goes` : `idle ${days(idle)}, uncommitted changes kept: only git-ignored build output goes` };
    }
    return { action: 'keep', reason: 'dirty', why: f.dirty === null ? 'git could not read its status' : 'uncommitted changes' };
  }
  // A clean tree goes only when its commits stay: HEAD on a branch (the branch is kept), or held by
  // another ref. A detached HEAD with commits nowhere else stays.
  if (!f.branch && f.safe !== true) return { action: 'keep', reason: 'unmerged', why: 'detached HEAD with commits on no branch or remote' };
  const label = f.merged ? 'home' : f.branch ? `branch ${f.branch} kept` : 'held by another ref';
  if (ended) return { action: 'remove', category: 'child-worktree', why: `child ${ended.child} ended, clean, ${label}` };
  if (RELEASE_NAME_RE.test(basename(f.path)) && idle >= RELEASE_IDLE_MS) {
    return { action: 'remove', category: 'release-worktree', why: `release worktree idle ${days(idle)}, clean, ${label}` };
  }
  if (idle >= STALE_IDLE_MS) {
    return { action: 'remove', category: 'stale-worktree', why: `idle ${days(idle)}, clean, ${label}` };
  }
  if (f.heavy.length && idle >= BUILD_IDLE_MS) return { action: 'strip', why: `idle ${days(idle)}: node_modules / Rust target come back with an install or build` };
  return { action: 'keep', reason: 'recent', why: `active ${days(idle)} ago` };
}

// ─── Reading the machine ────────────────────────────────────────────────────────

/**
 * Did a listing command give the WHOLE list? A clean exit, or lsof's normal exit 1 (one process
 * it may not read) with output. A timeout, a signal or a full buffer hands over a PARTIAL
 * listing: a failure, never a list (a missing process would make its worktree look unused).
 */
export function listingComplete(cmd: string, err: unknown, out: string): boolean {
  if (!err) return true;
  const e = err as { killed?: boolean; signal?: string | null; code?: unknown };
  const partial = e.killed === true || !!e.signal || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  return cmd === 'lsof' && e.code === 1 && !partial && out.length > 0;
}

const run = (cmd: string, args: readonly string[], timeout = 30_000): Promise<{ ok: boolean; out: string }> => new Promise((done) => {
  execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
    const out = String(stdout ?? '');
    done({ ok: listingComplete(cmd, err, out), out });
  });
});

/** Every path a running process holds under `root` (lsof: cwd, txt, open files) and every
 *  command line naming `root`. `inUse: null` when either listing failed or came back partial. */
export async function runningUses(root: string, realRoot: string = root): Promise<{ inUse: string[] | null; commands: string[] }> {
  const [lsof, ps] = await Promise.all([run('lsof', ['-n', '-P', '-w', '-F', 'n']), run('ps', ['-axww', '-o', 'command='])]);
  if (!lsof.ok || !ps.ok) return { inUse: null, commands: [] };
  // Either spelling of the root, always handed on in the real one (what the plan's paths use).
  const real = (l: string) => (root === realRoot ? l : l.split(root + sep).join(realRoot + sep));
  const names = (l: string) => l.includes(root) || l.includes(realRoot);
  const inUse = [...new Set(lsof.out.split('\n').filter((l) => l.startsWith('n') && names(l)).map((l) => real(l.slice(1))))];
  const commands = ps.out.split('\n').filter(names).map(real);
  return { inUse, commands };
}

/** Where the global `dreamcontext` links lead: every `dreamcontext` on PATH, under each nvm
 *  node, brew's and /usr/local's bin, and the desktop app's recorded CLI path. */
export async function globalCliTargets(home: string = homedir(), path = process.env.PATH ?? ''): Promise<string[]> {
  const bins = new Set<string>(path.split(delimiter).filter((d) => isAbsolute(d)).map((d) => join(d, 'dreamcontext')));
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin']) bins.add(join(d, 'dreamcontext'));
  try {
    for (const v of await fsp.readdir(join(home, '.nvm', 'versions', 'node'))) bins.add(join(home, '.nvm', 'versions', 'node', v, 'bin', 'dreamcontext'));
  } catch { /* no nvm */ }
  try {
    const p = readFileSync(join(home, '.dreamcontext', 'desktop-cli-path'), 'utf-8').trim();
    if (isAbsolute(p)) bins.add(p);
  } catch { /* no desktop app */ }
  const out = new Set<string>();
  for (const b of bins) { try { out.add(await fsp.realpath(b)); } catch { /* absent */ } }
  return [...out];
}

interface RawChild { worktree?: unknown; branch?: unknown; endedAt?: unknown }
interface RawState { children?: Record<string, RawChild>; queue?: Array<{ sessionId?: unknown; state?: unknown }> }

/** From Super Agent records: which worktrees a child still holds (not ended, or an open question),
 *  and which an ENDED child of `own` (this vault's record) names. */
export function childHolds(records: ReadonlyArray<{ vault: string; state: RawState; own?: boolean; superId?: SuperId }>): {
  held: Map<string, string>; ended: Map<string, EndedRow>;
} {
  const held = new Map<string, string>();
  const ended = new Map<string, EndedRow>();
  for (const { vault, state, own, superId } of records) {
    const open = new Set((state.queue ?? []).filter((q) => q && q.state !== 'done' && typeof q.sessionId === 'string').map((q) => q.sessionId as string));
    for (const [sid, ch] of Object.entries(state.children ?? {})) {
      if (!ch || typeof ch.worktree !== 'string') continue;
      if (typeof ch.endedAt !== 'number') held.set(ch.worktree, `child ${sid} of ${vault} is not ended`);
      else if (open.has(sid)) held.set(ch.worktree, `child ${sid} of ${vault} has an open question`);
      else if (own) ended.set(ch.worktree, { child: sid, branch: typeof ch.branch === 'string' ? ch.branch : undefined, endedAt: ch.endedAt, superId: superId ?? 'main' });
    }
  }
  // A tree any child still holds is held, whatever an ended one says about it.
  for (const w of held.keys()) ended.delete(w);
  return { held, ended };
}

/** Every registered vault's Super Agent record (raw). `unsure` names any record, or the vault
 *  registry, that exists but cannot be read: then which worktrees children hold is unknown. */
export function readSuperRecords(ownContextRoot: string, home: string = homedir()): {
  records: Array<{ vault: string; state: RawState; own: boolean; superId: SuperId }>; warnings: string[]; unsure?: string;
} {
  const roots = new Map<string, string>([[resolve(ownContextRoot), 'this vault']]);
  const warnings: string[] = [];
  let unsure: string | undefined;
  const doubt = (why: string) => { warnings.push(why); unsure ??= `${why}, so nothing is removed`; };
  try {
    const raw = JSON.parse(readFileSync(vaultsFilePath(home), 'utf-8')) as { vaults?: unknown };
    if (!Array.isArray(raw?.vaults)) doubt('the vault registry (vaults.json) has no vault list');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') doubt('the vault registry (vaults.json) cannot be read');
  }
  for (const v of listVaults(home)) roots.set(resolve(v.path, '_dream_context'), v.name);
  const records: Array<{ vault: string; state: RawState; own: boolean; superId: SuperId }> = [];
  for (const [root, vault] of roots) {
    // Main's record and every member Super's: a member's child holds its worktree as much as main's.
    for (const { id, path } of superRecordPaths(root)) {
      const whose = id === 'main' ? 'its Super Agent record' : `the Super record of ${id.slice(2)}`;
      let raw: string;
      try {
        if (lstatSync(path).isSymbolicLink()) { doubt(`${vault}: ${whose} is a link`); continue; }
        raw = readFileSync(path, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') doubt(`${vault}: ${whose} cannot be read`);
        continue;
      }
      try { records.push({ vault, state: JSON.parse(raw) as RawState, own: root === resolve(ownContextRoot), superId: id }); }
      catch { doubt(`${vault}: ${whose} does not parse`); }
    }
  }
  return { records, warnings, unsure };
}

/** Everything the sweep must not touch, read from the machine. `root` comes back in its REAL
 *  spelling (lsof reports real paths): plan with that one. */
export async function machineGuards(root: string, ownContextRoot: string, home: string = homedir(), extraHeld: ReadonlyMap<string, string> = new Map()): Promise<{ guards: SweepGuards; warnings: string[]; root: string }> {
  const realRoot = await fsp.realpath(root).catch(() => root);
  const [uses, cliTargets] = await Promise.all([runningUses(root, realRoot), globalCliTargets(home)]);
  const { records, warnings, unsure } = readSuperRecords(ownContextRoot, home);
  const { held: rawHeld, ended: rawEnded } = childHolds(records);
  for (const [w, why] of extraHeld) { rawHeld.set(w, why); rawEnded.delete(w); }
  // A record names a tree in the spelling it was made with; the plan's paths are real ones.
  const realKey = (w: string) => (dirname(w) === root || dirname(w) === realRoot ? join(realRoot, basename(w)) : w);
  const held = new Map([...rawHeld].map(([w, why]) => [realKey(w), why] as const));
  const ended = new Map([...rawEnded].map(([w, e]) => [realKey(w), e] as const));
  if (uses.inUse === null) warnings.push('lsof/ps failed: every worktree is kept');
  return { guards: { inUse: uses.inUse, commands: uses.commands, cliTargets, held, ended, ...(unsure ? { unsure } : {}) }, warnings, root: realRoot };
}

// ─── The plan ───────────────────────────────────────────────────────────────────

export interface SweepItem {
  category: SweepCategory;
  path: string;
  bytes: number;
  why: string;
  branch?: string | null;
  repo?: string | null;
  child?: string;
  /** `build-output`: the dirs that go (the worktree itself stays); `test-tmp`: its folders
   *  (left out of {@link publicPlan}: thousands of them). */
  remove?: string[];
  /** `test-tmp`: how many folders the one row stands for. */
  count?: number;
}

export interface KeptItem { reason: KeepReason; path: string; bytes: number; why: string; branch?: string | null; heavyBytes?: number }

export interface SweepPlan {
  root: string;
  items: SweepItem[];
  kept: KeptItem[];
  totals: Record<SweepCategory, { count: number; bytes: number }>;
  bytes: number;
  keptTotals: Partial<Record<KeepReason, { count: number; bytes: number }>>;
  warnings: string[];
}

async function folders(root: string): Promise<string[]> {
  try {
    return (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => join(root, d.name)).sort();
  } catch { return []; }
}

/** Run `fn` over `xs`, `n` at a time, keeping order. */
async function pool<T, R>(xs: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (i < xs.length) { const k = i++; out[k] = await fn(xs[k]); }
  }));
  return out;
}

/** Look at every folder under `root` and say what would go and what stays. Removes nothing. */
export async function planSweep(o: {
  root: string; guards: SweepGuards; testTmp?: readonly string[]; now?: number; warnings?: string[];
  inspect?: (p: string) => Promise<WorktreeFacts>;
}): Promise<SweepPlan> {
  const now = o.now ?? Date.now();
  const facts = await pool(await folders(o.root), 6, o.inspect ?? inspectWorktree);
  const verdicts = facts.map((f) => ({ f, v: classify(f, o.guards, now) }));
  const sizes = await diskUsage([...facts.flatMap((f) => [f.path, ...f.heavy]), ...(o.testTmp ?? [])], 600_000);
  const size = (p: string) => sizes.get(p) ?? 0;
  const items: SweepItem[] = [];
  const kept: KeptItem[] = [];
  for (const { f, v } of verdicts) {
    const heavyBytes = f.heavy.reduce((n, h) => n + size(h), 0);
    if (v.action === 'remove') {
      items.push({ category: v.category, path: f.path, bytes: size(f.path), why: v.why, branch: f.branch, repo: f.repo, ...(o.guards.ended.get(f.path) ? { child: o.guards.ended.get(f.path)!.child } : {}) });
    } else if (v.action === 'strip') {
      items.push({ category: 'build-output', path: f.path, bytes: heavyBytes, why: v.why, branch: f.branch, repo: f.repo, remove: f.heavy });
    } else {
      kept.push({ reason: v.reason, path: f.path, bytes: size(f.path), why: v.why, branch: f.branch, ...(heavyBytes ? { heavyBytes } : {}) });
    }
  }
  const tests = o.testTmp ?? [];
  if (tests.length) {
    items.push({
      category: 'test-tmp', path: dirname(tests[0]), bytes: tests.reduce((n, t) => n + size(t), 0), count: tests.length,
      why: 'this repo\'s own test temp folders, older than a day', remove: [...tests],
    });
  }
  items.sort((a, b) => b.bytes - a.bytes);
  kept.sort((a, b) => b.bytes - a.bytes);
  const totals = Object.fromEntries(SWEEP_CATEGORIES.map((c) => [c, { count: 0, bytes: 0 }])) as SweepPlan['totals'];
  for (const i of items) { totals[i.category].count += i.count ?? 1; totals[i.category].bytes += i.bytes; }
  const keptTotals: SweepPlan['keptTotals'] = {};
  for (const k of kept) { const t = (keptTotals[k.reason] ??= { count: 0, bytes: 0 }); t.count++; t.bytes += k.bytes; }
  return { root: o.root, items, kept, totals, bytes: items.reduce((n, i) => n + i.bytes, 0), keptTotals, warnings: o.warnings ?? [] };
}

// ─── Acting on it ───────────────────────────────────────────────────────────────

export interface SweepResult { removed: string[]; failed: Array<{ path: string; message: string }>; bytesFreed: number }

/**
 * Carry out a plan. Each worktree row is re-inspected and re-judged against `guards` (taken
 * fresh by the caller) right before it acts: a row whose verdict changed is skipped, never forced.
 */
export async function applySweep(plan: SweepPlan, guards: SweepGuards, o: {
  now?: number; inspect?: (p: string) => Promise<WorktreeFacts>; onRemoved?: (item: SweepItem) => Promise<void>;
} = {}): Promise<SweepResult> {
  const inspect = o.inspect ?? inspectWorktree;
  const removed: string[] = [];
  const failed: SweepResult['failed'] = [];
  let bytesFreed = 0;
  for (const item of plan.items) {
    try {
      if (item.category === 'test-tmp') {
        for (const t of item.remove ?? []) await fsp.rm(t, { recursive: true, force: true });
      } else {
        const f = await inspect(item.path);
        const v = classify(f, guards, o.now ?? Date.now());
        const same = item.category === 'build-output' ? v.action === 'strip' : v.action === 'remove';
        if (!same) throw new Error(`changed since the plan: ${v.why}`);
        if (item.category === 'build-output') {
          for (const h of item.remove ?? []) {
            const st = await fsp.lstat(h).catch(() => null);
            if (!st || !st.isDirectory() || st.isSymbolicLink() || !h.startsWith(item.path + sep)) continue;
            await fsp.rm(h, { recursive: true, force: true });
          }
        } else {
          if (!f.repo) throw new Error('no repository to remove it from');
          // No --force: git itself refuses a tree with changes or untracked files.
          const r = await git(f.repo, ['worktree', 'remove', item.path]);
          if (r.code !== 0) throw new Error(`git worktree remove: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`);
        }
      }
      if (item.category === 'test-tmp') removed.push(...(item.remove ?? [])); else removed.push(item.path);
      bytesFreed += item.bytes;
      await o.onRemoved?.(item);
    } catch (err) {
      failed.push({ path: item.path, message: (err as Error).message });
    }
  }
  return { removed, failed, bytesFreed };
}

/** The plan as JSON for the CLI: the test temp row without its thousands of paths. */
export function publicPlan(plan: SweepPlan): SweepPlan {
  return { ...plan, items: plan.items.map((i) => (i.category === 'test-tmp' ? { ...i, remove: undefined } : i)) };
}

/** The plan as a few readable lines (the dry-run report). */
export function renderPlan(plan: SweepPlan): string {
  const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  const lines = [`super clean (dry run) of ${plan.root}`, `reclaimable: ${gb(plan.bytes)}`, ''];
  for (const c of SWEEP_CATEGORIES) lines.push(`  ${c.padEnd(17)} ${String(plan.totals[c].count).padStart(4)}  ${gb(plan.totals[c].bytes)}`);
  lines.push('', 'kept:');
  for (const r of KEEP_REASONS) { const t = plan.keptTotals[r]; if (t) lines.push(`  ${r.padEnd(17)} ${String(t.count).padStart(4)}  ${gb(t.bytes)}`); }
  if (plan.warnings.length) lines.push('', 'warnings:', ...plan.warnings.map((w) => `  ${w}`));
  lines.push('', 'would remove:');
  for (const i of plan.items) lines.push(`  ${gb(i.bytes).padStart(8)}  ${i.category.padEnd(16)} ${i.path}${i.count ? ` (${i.count} folders)` : ''}  (${i.why})`);
  lines.push('', 'kept, with reasons:');
  for (const k of plan.kept) lines.push(`  ${gb(k.bytes).padStart(8)}  ${k.reason.padEnd(14)} ${k.path}  (${k.why}${k.heavyBytes ? `; ${gb(k.heavyBytes)} of it build output` : ''})`);
  return lines.join('\n');
}

// ─── The ended-child janitor (K5, D14, D15, D17) ────────────────────────────────

/** Worktrees the janitor is removing right now (D15): `childCheckout` reads them as gone, so a
 *  merge or a resume racing the removal goes through the branch. In-process only. */
const removing = new Set<string>();
export function removingWorktrees(): ReadonlySet<string> { return removing; }

let sweeping = false;
const retryOnly = new Set<string>();

export interface JanitorResult {
  removed: string[];
  stripped: string[];
  failed: Array<{ path: string; message: string }>;
  bytesFreed: number;
  released: string[];
  warnings: string[];
}

/** The janitor's last round in this process, for `super state` (D14's one line). */
let lastRound: (JanitorResult & { at: number; trigger: string }) | null = null;
export function lastJanitorRound(): typeof lastRound { return lastRound; }

export function janitorLine(r: JanitorResult): string {
  const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  return `worktree janitor: ${r.removed.length} removed, ${r.stripped.length} stripped, ${gb(r.bytesFreed)} freed`
    + `${r.released.length ? `, ${r.released.length} ended children released (branch home)` : ''}${r.failed.length ? `, ${r.failed.length} failed` : ''}`;
}

export interface SweepEndedDeps {
  home?: string;
  /** Tests inject the facts and the guards; the server reads the machine. */
  inspect?: (p: string) => Promise<WorktreeFacts>;
  guards?: () => Promise<{ guards: SweepGuards; warnings: string[]; root: string }>;
  now?: number;
  trigger?: string;
}

/**
 * The ended-child janitor (D14): every ended child of every Super record of this vault (main and
 * members) whose worktree the sweep's one rule (D13) lets go: a clean one is removed (its branch
 * stays, in git and in the record), a dirty one loses only its git-ignored build output. Then the
 * release pass (D17): a worktree-less ended child whose branch reached home, or is gone from a
 * readable repo, gives its branch up and trims as any ended child. Never throws; a second round
 * while one runs is skipped and its `only` path retried once after the round.
 */
export async function sweepEnded(o: { root: string; contextRoot: string; only?: string } & SweepEndedDeps): Promise<JanitorResult | null> {
  if (sweeping) { if (o.only) retryOnly.add(o.only); return null; }
  sweeping = true;
  try {
    const result = await sweepEndedRound(o);
    const again = [...retryOnly];
    retryOnly.clear();
    for (const only of again) {
      const r = await sweepEndedRound({ ...o, only }).catch(() => null);
      if (r) { result.removed.push(...r.removed); result.stripped.push(...r.stripped); result.failed.push(...r.failed); result.bytesFreed += r.bytesFreed; }
    }
    lastRound = { ...result, at: Date.now(), trigger: o.trigger ?? (o.only ? 'end' : 'round') };
    if (result.removed.length || result.stripped.length || result.released.length || result.failed.length) console.log(`[super] ${janitorLine(result)}`);
    return result;
  } catch (err) {
    console.warn(`[super] worktree janitor failed: ${(err as Error)?.message ?? err}`);
    return null;
  } finally {
    sweeping = false;
  }
}

async function sweepEndedRound(o: { root: string; contextRoot: string; only?: string } & SweepEndedDeps): Promise<JanitorResult> {
  const home = o.home ?? homedir();
  const out: JanitorResult = { removed: [], stripped: [], failed: [], bytesFreed: 0, released: [], warnings: [] };
  const { guards, warnings, root } = o.guards ? await o.guards() : await machineGuards(o.root, o.contextRoot, home);
  out.warnings.push(...warnings);
  const inspect = o.inspect ?? inspectWorktree;
  const realOnly = o.only ? await fsp.realpath(o.only).catch(() => o.only!) : undefined;
  const onlyKey = realOnly && (dirname(realOnly) === root ? realOnly : join(root, basename(realOnly)));
  for (const [path, row] of guards.ended) {
    if (o.only && path !== o.only && path !== realOnly && path !== onlyKey) continue;
    const f = await inspect(path);
    const v = classify(f, guards, o.now ?? Date.now());
    if (v.action === 'keep') continue;
    if (v.action === 'remove' && v.category !== 'child-worktree') continue;
    const bytes = (await diskUsage(v.action === 'strip' ? f.heavy : [path], 600_000));
    const size = [...bytes.values()].reduce((n, b) => n + b, 0);
    if (v.action === 'strip') {
      try {
        for (const h of f.heavy) {
          const st = await fsp.lstat(h).catch(() => null);
          if (!st || !st.isDirectory() || st.isSymbolicLink() || !h.startsWith(path + sep)) continue;
          await fsp.rm(h, { recursive: true, force: true });
        }
        out.stripped.push(path); out.bytesFreed += size;
      } catch (err) { out.failed.push({ path, message: (err as Error).message }); }
      continue;
    }
    if (!f.repo) { out.failed.push({ path, message: 'no repository to remove it from' }); continue; }
    // Before (D15): the record learns where the work is, so a merge or resume racing the removal
    // reaches the branch. `branch` itself never changes.
    const key = { contextRoot: o.contextRoot, superId: row.superId };
    const writeChild = (fn: (c: SuperChild) => void) => withSuperState(key.contextRoot, key.superId, (s) => {
      const c = s.children[row.child];
      if (c) fn(c);
    }, { home });
    removing.add(path);
    try {
      await writeChild((c) => {
        if (f.branch && SUPER_BRANCH_RE.test(f.branch)) { if (f.branch !== c.branch) c.lastBranch = f.branch; else delete c.lastBranch; }
        else if (f.branch && validBase(f.branch)) c.movedTo = f.branch;
      });
      // No --force: git itself refuses a tree with changes or untracked files.
      const r = await git(f.repo, ['worktree', 'remove', path]);
      if (r.code !== 0) throw new Error(`git worktree remove: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`);
      // After: only the worktree goes from the record.
      await writeChild((c) => { if (c.worktree && (c.worktree === path || c.worktree === o.only || join(root, basename(c.worktree)) === path)) delete c.worktree; });
      out.removed.push(path); out.bytesFreed += size;
    } catch (err) {
      out.failed.push({ path, message: (err as Error).message });
    } finally {
      removing.delete(path);
    }
  }
  if (!o.only) out.released.push(...await releasePass(o.contextRoot, home));
  return out;
}

/**
 * D17: every record's ended children without a live worktree. A worktree hint git does not list
 * (readable repo) is dropped; a child whose every named branch is home or gone (readable repo)
 * gives up `branch`, `lastBranch` and `movedTo`, re-checked inside the record's lock (a resume in
 * between wins). An unreadable repo is "unknown": nothing dropped.
 */
async function releasePass(contextRoot: string, home: string): Promise<string[]> {
  const projectRoot = dirname(contextRoot);
  const released: string[] = [];
  for (const { id } of superRecordPaths(contextRoot)) {
    let s: SuperState;
    try { s = await readSuperState(contextRoot, id, { home }); } catch { continue; }
    for (const c of Object.values(s.children)) {
      if (c.endedAt === undefined || !c.branch) continue;
      const co = await childCheckout(projectRoot, c, { removing, home });
      if (!co.repo || co.worktree) continue;
      if (!(await isReadableRepo(co.repo.path))) continue;
      const staleHint = c.worktree ?? null;
      if (staleHint) {
        const listed = await listedWorktreesFor([co.repo.path], [staleHint]).catch(() => null);
        if (!listed || listed.has(staleHint) || removing.has(staleHint)) continue;
      }
      let release = true;
      for (const b of [...new Set([c.lastBranch, c.branch].filter((x): x is string => !!x))]) {
        const exists = await git(co.repo.path, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`]);
        if (exists.code === 1) continue; // gone from a readable repo
        if (exists.code !== 0) { release = false; break; }
        if ((await homeContains(co.repo.path, `refs/heads/${b}`)) !== true) { release = false; break; }
      }
      await withSuperState(contextRoot, id, (d) => {
        const x = d.children[c.sessionId];
        if (!x || x.endedAt === undefined) return;
        // Re-checked inside the lock: a resume re-attached a worktree, or another hint came.
        if (x.worktree && x.worktree !== staleHint) return;
        if (staleHint && x.worktree === staleHint) delete x.worktree;
        if (release && x.branch === c.branch) { delete x.branch; delete x.lastBranch; delete x.movedTo; released.push(c.sessionId); }
      }, { home }).catch(() => undefined);
    }
  }
  return released;
}

async function isReadableRepo(path: string): Promise<boolean> {
  try { await fsp.access(path); } catch { return false; }
  const r = await git(path, ['rev-parse', '--git-dir']);
  return r.code === 0;
}
