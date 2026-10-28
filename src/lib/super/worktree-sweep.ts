import { execFile } from 'node:child_process';
import { promises as fsp, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { git } from './worktrees.js';
import { diskUsage, rustTargets } from './disk-leftovers.js';
import { listVaults } from '../vaults.js';

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
  const heavy = [...(await nodeModulesDirs(path)), ...(await rustTargets(path))];

  const head = await git(path, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = head.code === 0 ? head.stdout.trim() || null : null;
  const status = await git(path, ['--no-optional-locks', 'status', '--porcelain']);
  const dirty = status.code === 0 ? status.stdout.trim().length > 0 : null;
  const refs = await git(path, ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  let safe: boolean | null = null;
  let merged: boolean | null = null;
  if (refs.code === 0) {
    const others = refs.stdout.split('\n').map((s) => s.trim())
      .filter((r) => r && r !== `refs/heads/${branch}` && !/^refs\/remotes\/[^/]+\/HEAD$/.test(r));
    safe = others.length > 0;
    merged = others.some((r) => r.startsWith('refs/heads/'));
  }
  return { path, shape: 'worktree', repo, branch, dirty, safe, merged, lastActive, heavy };
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
  ended: ReadonlyMap<string, { child: string; branch?: string; endedAt?: number }>;
}

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
  if (g.inUse === null) return { action: 'keep', reason: 'in-use', why: 'could not list running processes, so nothing is removed' };
  if (g.inUse.some((p) => under(p, f.path)) || g.commands.some((c) => c.includes(f.path + sep) || c.includes(f.path + ' ') || c.endsWith(f.path))) {
    return { action: 'keep', reason: 'in-use', why: 'a running process works in it' };
  }
  const cli = g.cliTargets.find((t) => under(t, f.path));
  if (cli) return { action: 'keep', reason: 'global-cli', why: `the global dreamcontext link points into it (${cli})` };
  const held = g.held.get(f.path);
  if (held) return { action: 'keep', reason: 'live-child', why: held };
  if (f.dirty !== false) return { action: 'keep', reason: 'dirty', why: f.dirty === null ? 'git could not read its status' : 'uncommitted changes' };
  if (f.safe !== true) return { action: 'keep', reason: 'unmerged', why: `${f.branch ?? 'detached HEAD'} has commits on no other branch or remote` };

  const ended = g.ended.get(f.path);
  const idle = now - Math.max(f.lastActive, ended?.endedAt ?? 0);
  if (ended && f.merged) return { action: 'remove', category: 'child-worktree', why: `child ${ended.child} ended, ${f.branch ?? 'HEAD'} merged and clean` };
  if (RELEASE_NAME_RE.test(basename(f.path)) && idle >= RELEASE_IDLE_MS) {
    return { action: 'remove', category: 'release-worktree', why: `release worktree idle ${days(idle)}, clean, ${f.merged ? 'merged' : 'pushed'}` };
  }
  if (idle >= STALE_IDLE_MS) {
    return { action: 'remove', category: 'stale-worktree', why: `idle ${days(idle)}${ended ? ` (child ${ended.child} ended)` : ''}, clean, ${f.merged ? 'merged' : 'pushed'}` };
  }
  if (f.heavy.length && idle >= BUILD_IDLE_MS) return { action: 'strip', why: `idle ${days(idle)}: node_modules / Rust target come back with an install or build` };
  return { action: 'keep', reason: 'recent', why: `active ${days(idle)} ago` };
}

// ─── Reading the machine ────────────────────────────────────────────────────────

const run = (cmd: string, args: readonly string[], timeout = 30_000): Promise<{ ok: boolean; out: string }> => new Promise((done) => {
  execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
    const out = String(stdout ?? '');
    // lsof exits 1 on a process it may not read but still prints the rest.
    done({ ok: !err || out.length > 0, out });
  });
});

/** Every path a running process holds under `root` (lsof: cwd, txt, open files) and every
 *  command line naming `root`. `inUse: null` when neither listing worked. */
export async function runningUses(root: string): Promise<{ inUse: string[] | null; commands: string[] }> {
  const [lsof, ps] = await Promise.all([run('lsof', ['-n', '-P', '-w', '-F', 'n']), run('ps', ['-axww', '-o', 'command='])]);
  if (!lsof.ok || !ps.ok) return { inUse: null, commands: [] };
  const inUse = [...new Set(lsof.out.split('\n').filter((l) => l.startsWith('n') && l.includes(root)).map((l) => l.slice(1)))];
  const commands = ps.out.split('\n').filter((l) => l.includes(root));
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
export function childHolds(records: ReadonlyArray<{ vault: string; state: RawState; own?: boolean }>): {
  held: Map<string, string>; ended: Map<string, { child: string; branch?: string; endedAt?: number }>;
} {
  const held = new Map<string, string>();
  const ended = new Map<string, { child: string; branch?: string; endedAt?: number }>();
  for (const { vault, state, own } of records) {
    const open = new Set((state.queue ?? []).filter((q) => q && q.state !== 'done' && typeof q.sessionId === 'string').map((q) => q.sessionId as string));
    for (const [sid, ch] of Object.entries(state.children ?? {})) {
      if (!ch || typeof ch.worktree !== 'string') continue;
      if (typeof ch.endedAt !== 'number') held.set(ch.worktree, `child ${sid} of ${vault} is not ended`);
      else if (open.has(sid)) held.set(ch.worktree, `child ${sid} of ${vault} has an open question`);
      else if (own) ended.set(ch.worktree, { child: sid, branch: typeof ch.branch === 'string' ? ch.branch : undefined, endedAt: ch.endedAt });
    }
  }
  // A tree any child still holds is held, whatever an ended one says about it.
  for (const w of held.keys()) ended.delete(w);
  return { held, ended };
}

/** Every registered vault's Super Agent record (raw; an unreadable one is a warning). */
export function readSuperRecords(ownContextRoot: string, home: string = homedir()): { records: Array<{ vault: string; state: RawState; own: boolean }>; warnings: string[] } {
  const roots = new Map<string, string>([[resolve(ownContextRoot), 'this vault']]);
  for (const v of listVaults(home)) roots.set(resolve(v.path, '_dream_context'), v.name);
  const records: Array<{ vault: string; state: RawState; own: boolean }> = [];
  const warnings: string[] = [];
  for (const [root, vault] of roots) {
    let raw: string;
    try { raw = readFileSync(join(root, 'state', '.super-agent.json'), 'utf-8'); } catch { continue; }
    try { records.push({ vault, state: JSON.parse(raw) as RawState, own: root === resolve(ownContextRoot) }); }
    catch { warnings.push(`${vault}: its Super Agent record does not parse, so its children's worktrees are not known`); }
  }
  return { records, warnings };
}

export async function machineGuards(root: string, ownContextRoot: string, home: string = homedir(), extraHeld: ReadonlyMap<string, string> = new Map()): Promise<{ guards: SweepGuards; warnings: string[] }> {
  const [uses, cliTargets] = await Promise.all([runningUses(root), globalCliTargets(home)]);
  const { records, warnings } = readSuperRecords(ownContextRoot, home);
  const { held, ended } = childHolds(records);
  for (const [w, why] of extraHeld) { held.set(w, why); ended.delete(w); }
  if (uses.inUse === null) warnings.push('lsof/ps failed: every worktree is kept');
  return { guards: { inUse: uses.inUse, commands: uses.commands, cliTargets, held, ended }, warnings };
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
