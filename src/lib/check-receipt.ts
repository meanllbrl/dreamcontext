import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { heavyStep, shellSegments } from './run-budget.js';

/**
 * Check receipts: the same check on the same code does not run twice.
 *
 * Owner, 2026-11-07: "bump my version" took 40 minutes because unit tests that had already passed
 * ran again on the same code. Measured on the 0.41.4 cut: the full suite was started twice on one
 * tree, and a build plus two type checks re-ran after a commit that only touched CHANGELOG.md.
 *
 * When a check (a test run, a type check, a build) exits 0 through `builder heavy` or
 * `builder test`, a receipt is written, keyed by the CONTENT it ran on: the git tree of every
 * tracked and untracked-not-ignored file (a scratch index, never the real one), plus the
 * command, the folder it ran in, the installed dependencies (node_modules/.package-lock.json),
 * the built dist for test runs (tests here run the built CLI), the node version and the
 * DREAMCONTEXT_/CLAUDE env (tests read them). Asked again with the same key, the check does not
 * run: the receipt is printed and the recorded exit (always 0) returned.
 *
 * A receipt must never make a red look green, so everything fails open toward RUNNING: no git,
 * a tree that cannot be written, files that changed while the check ran, a corrupt receipt, a
 * command whose exit code does not belong to the check (a pipe, `;`, `||`, a heredoc, `$(…)`),
 * a `cd` out of the repo, a step that is not a known check, a browser run. Only exit 0 is
 * recorded; a red is never stored, so it always runs again.
 *
 * Reuse across a DIFFERENT tree is narrow and per kind ({@link harmlessFor}): a type check
 * cannot read Markdown or a version string, so a tree that differs from a green one only there
 * reuses it; a test run reuses only across brain files (`_dream_context/`). A version bump is NOT
 * harmless for tests: tests/unit/hook-golden.test.ts compares the built CLI's output, which
 * carries the version, against a fixture. A merge makes a tree nobody tested, so it runs.
 *
 * `--fresh` always runs, and records. tests/unit/check-receipt.test.ts pins it.
 */

export type ReceiptKind = 'tsc' | 'tests' | 'build';

export interface ReceiptPlan {
  kind: ReceiptKind;
  toplevel: string;
  /** The check's folder relative to the toplevel ('.' = the root). */
  cwdRel: string;
  /** The command as keyed: the toplevel spelled `<root>`, report paths dropped. */
  command: string;
}

export type PlanResult = { plan: ReceiptPlan } | { skip: string };

export interface Receipt {
  v: 1;
  key: string;
  family: string;
  tree: string;
  kind: ReceiptKind;
  command: string;
  cwdRel: string;
  exit: 0;
  /** ISO time the check finished. */
  at: string;
  ms: number;
  fresh?: boolean;
  /** Build outputs fingerprint after the run (builds only). */
  outputs?: string;
  /** The stored log / report, absolute paths inside the receipts folder. */
  log?: string;
  report?: string;
}

export interface ReceiptState { tree: string; family: string; key: string }

export interface ReceiptHit { receipt: Receipt; via: 'same' | 'harmless'; paths: string[] }

/** Receipts older than this are pruned: an unreferenced tree object can be gc'd by then. */
export const RECEIPT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** How many earlier green trees of one check a harmless-difference lookup reads. */
const FAMILY_KEEP = 12;
/** Past these, fingerprinting dist costs more than it saves: no receipt (the check runs). */
const DIST_MAX_FILES = 20_000;
const DIST_MAX_BYTES = 600 * 1024 * 1024;

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function gitToplevel(cwd: string): string | null {
  try { return realpathSync(git(cwd, ['rev-parse', '--show-toplevel'])); } catch { return null; }
}

/** Where receipts live: the repo's common git dir, so every worktree of one repo shares them. */
export function receiptsDir(toplevel: string): string | null {
  try { return join(resolve(toplevel, git(toplevel, ['rev-parse', '--git-common-dir'])), 'dc-receipts'); } catch { return null; }
}

// ─── which commands can hold a receipt ───────────────────────────────────────

/**
 * Why this command's exit code is not the check's own, or null when it is. Only a chain of
 * `&&` (subshell parentheses and redirects allowed) passes: `a | tail` exits with tail's code,
 * `a; b` with b's, `a || true` always 0.
 */
export function exitNotOwned(command: string): string | null {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&') { i++; continue; }
    if (two === '||') return 'an `||` makes the exit code the fallback\'s';
    if (c === '|') return 'a pipe makes the exit code the last command\'s (use --tail N instead of | tail)';
    if (c === ';' || c === '\n') return 'a `;` or a new line makes the exit code the last command\'s';
    if (c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') return 'a background `&` hides the exit code';
    if (c === '`' || two === '$(') return 'a command substitution';
    if (two === '<<') return 'a heredoc';
  }
  if (quote) return 'an unclosed quote';
  return null;
}

const ENV_WRAP = /^(?:env(?:\s+-u\s+\S+|\s+-i|\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)*/;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p.replace(/^\$HOME(?=\/|$)/, homedir()).replace(/^\$\{HOME\}(?=\/|$)/, homedir());
}

function unquote(w: string): string {
  return /^'.*'$|^".*"$/.test(w) ? w.slice(1, -1) : w;
}

function inside(top: string, p: string): boolean {
  let real: string;
  try { real = realpathSync(p); } catch { real = resolve(p); }
  return real === top || real.startsWith(top + sep);
}

/**
 * The receipt plan for a shell command `builder heavy` runs in `cwd`, or why it gets none.
 * Every segment must be a known check, a `cd` that stays in the repo, or an `echo`.
 */
export function planShellReceipt(cwd: string, command: string, scripts: Record<string, string> = {}): PlanResult {
  const toplevel = gitToplevel(cwd);
  if (!toplevel) return { skip: 'not a git repo' };
  const owned = exitNotOwned(command);
  if (owned) return { skip: owned };
  let dir = realpathSync(cwd);
  let kind: ReceiptKind | null = null;
  const rank: Record<ReceiptKind, number> = { tsc: 0, tests: 1, build: 2 };
  for (const raw of shellSegments(command)) {
    const seg = raw.replace(/^\(+|\)+$/g, '').trim().replace(ENV_WRAP, '').trim();
    if (!seg) continue;
    if (/^!/.test(seg)) return { skip: 'a negated command' };
    if (/^popd\b/.test(seg)) return { skip: 'a popd goes where the shell remembers, not where the command says' };
    const cd = /^(?:cd|pushd)(?:\s+(.+))?$/.exec(seg);
    if (cd) {
      const target = unquote((cd[1] ?? '~').trim());
      if (/[$*?]/.test(target.replace(/^\$\{?HOME\}?/, ''))) return { skip: `a cd to "${target}" that cannot be resolved here` };
      // `cd -` and `pushd +1` go where the shell remembers; CDPATH can send a relative cd anywhere.
      if (/^[-+]/.test(target)) return { skip: `a cd to "${target}" that cannot be resolved here` };
      if (process.env.CDPATH && !isAbsolute(expandHome(target)) && !/^\.\.?(?:\/|$)/.test(target)) return { skip: 'a relative cd while CDPATH is set' };
      dir = resolve(dir, expandHome(target));
      if (!inside(toplevel, dir)) return { skip: `a cd out of the repo (${target})` };
      continue;
    }
    if (/^echo(?:\s|$)/.test(seg)) continue;
    // Every path must stay in the repo: `vitest run /other/a.test.ts`, `tsc -p ../other/tsconfig.json`,
    // `vitest --root ../other`. The key holds this repo's files only.
    for (const w of seg.split(/\s+/).map(unquote)) {
      const p = w.replace(/^--?[\w-]+=/, '');
      const looksPath = isAbsolute(p) || /^~|^\$\{?HOME\}?/.test(p) || /(?:^|\/)\.\.(?:\/|$)/.test(p);
      if (looksPath && !inside(toplevel, resolve(dir, expandHome(p)))) return { skip: `a path out of the repo (${p})` };
    }
    // What these pick depends on git history, which is not in the key.
    if (/(?:^|\s)(?:--changed|--onlyChanged|-o|--lastCommit|--since|--changedSince)(?:[\s=]|$)/.test(seg)) return { skip: 'it picks tests from git history, not only the content' };
    const step = heavyStep(seg, scripts);
    if (!step) return { skip: `"${seg.split(/\s+/).slice(0, 3).join(' ')}" is not a known check` };
    if (step.kind === 'browser') return { skip: 'a browser run looks at a running app, not only the code' };
    const k: ReceiptKind = step.kind === 'build' || step.emits ? 'build' : step.kind === 'suite' || step.target === 'tests' ? 'tests' : 'tsc';
    if (!kind || rank[k] > rank[kind]) kind = k;
  }
  if (!kind) return { skip: 'no check in the command' };
  return { plan: { kind, toplevel, cwdRel: relKey(toplevel, realpathSync(cwd)), command: normalizeCommand(command, toplevel) } };
}

/** The receipt plan for one `builder test` step: `npx <argv>` in `cwd`. */
export function planArgvReceipt(cwd: string, argv: string[]): PlanResult {
  const toplevel = gitToplevel(cwd);
  if (!toplevel) return { skip: 'not a git repo' };
  const kind: ReceiptKind | null = argv[0] === 'tsc' ? (argv.includes('--noEmit') ? 'tsc' : 'build') : argv[0] === 'vitest' || argv[0] === 'jest' ? 'tests' : null;
  if (!kind) return { skip: `${argv[0]} is not a known check` };
  if (argv.some((a) => /^(?:--changed|--onlyChanged|-o|--lastCommit|--since|--changedSince)(?:=|$)/.test(a))) return { skip: 'it picks tests from git history, not only the content' };
  const cwdReal = realpathSync(cwd);
  if (argv.some((a) => { const p = a.replace(/^--?[\w-]+=/, ''); return (isAbsolute(p) || /(?:^|\/)\.\.(?:\/|$)/.test(p)) && !/^--outputFile=/.test(a) && !inside(toplevel, resolve(cwdReal, p)); })) return { skip: 'a path out of the repo' };
  return { plan: { kind, toplevel, cwdRel: relKey(toplevel, realpathSync(cwd)), command: normalizeCommand(argv.join(' '), toplevel) } };
}

const relKey = (top: string, p: string): string => relative(top, p).split(sep).join('/') || '.';

/** The toplevel spelled `<root>` (so worktrees share), and the report path dropped. */
export function normalizeCommand(command: string, toplevel: string): string {
  const home = homedir();
  let c = command.split(toplevel).join('<root>');
  if (toplevel.startsWith(home + sep)) c = c.split(`~${toplevel.slice(home.length)}`).join('<root>');
  return c.replace(/--outputFile[= ]\S+/g, '--outputFile=<report>').replace(/\s+/g, ' ').trim();
}

// ─── the content a check ran on ──────────────────────────────────────────────

/**
 * The git tree of the working tree as it is: tracked files with their uncommitted edits, plus
 * untracked files that are not ignored. Written through a scratch copy of the index, so the real
 * index is never touched. null on any failure.
 */
export function contentTree(toplevel: string): string | null {
  const dir = receiptsDir(toplevel);
  if (!dir) return null;
  const idx = join(dir, `idx-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    mkdirSync(dir, { recursive: true });
    const real = git(toplevel, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    if (existsSync(real)) {
      copyFileSync(real, idx);
      // Keep the index's own time: git re-reads every entry not older than the index ("racy"
      // entries), so a same-size edit in the second the index was written is still seen. A copy
      // stamped now would trust those entries by their stat alone.
      const st = statSync(real);
      utimesSync(idx, st.atime, st.mtime);
    }
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    git(toplevel, ['add', '-A'], env);
    const tree = git(toplevel, ['write-tree'], env);
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  } catch {
    return null;
  } finally {
    rmSync(idx, { force: true });
  }
}

/** What the package managers write into node_modules about what they installed. */
const DEPS_RECORDS = ['.package-lock.json', '.modules.yaml', '.yarn-state.yml', '.yarn-integrity'];

/**
 * Installed dependencies: the package manager's record of node_modules, at the root and one level
 * down. null when a node_modules holds none of the known records (bun, an unknown manager, a
 * copy): what is installed cannot be told, so there is no receipt.
 */
function depsFingerprint(toplevel: string, cwdRel: string): string | null {
  const dirs = new Set(['.', cwdRel]);
  try { for (const e of readdirSync(toplevel, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') dirs.add(e.name); } catch { /* root only */ }
  const parts: string[] = [];
  for (const d of [...dirs].sort()) {
    const nm = join(toplevel, d, 'node_modules');
    if (!existsSync(nm)) continue;
    const found = DEPS_RECORDS.filter((r) => existsSync(join(nm, r)));
    if (found.length === 0) return null;
    for (const r of found) parts.push(`${d}/${r}:${sha(readFileSync(join(nm, r)))}`);
  }
  return sha(parts.join('\n'));
}

/**
 * The built output (`dist/` at the root and one level down): path + bytes of every file.
 * '' when there is none; null when it is too big to read cheaply (no receipt).
 */
export function distFingerprint(toplevel: string): string | null {
  const roots = ['dist'];
  try { for (const e of readdirSync(toplevel, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist') roots.push(`${e.name}/dist`); } catch { return null; }
  return filesFingerprint(toplevel, roots);
}

/**
 * Ignored files a test run reads besides dist: the installed Claude mirror (`.claude/`, whose
 * skills and agents drift tests compare; its `worktrees/` left out) and the root `.env*` files.
 */
export function testInputsFingerprint(toplevel: string): string | null {
  const roots = ['.claude'];
  try { for (const e of readdirSync(toplevel)) if (/^\.env(?:\..*)?$/.test(e)) roots.push(e); } catch { return null; }
  return filesFingerprint(toplevel, roots, new Set(['.claude/worktrees']));
}

function filesFingerprint(toplevel: string, roots: string[], skip: Set<string> = new Set()): string | null {
  const h = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const walk = (rel: string): boolean => {
    const abs = join(toplevel, rel);
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return true; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.name === 'node_modules' || skip.has(r)) continue;
      if (e.isDirectory()) { if (!walk(r)) return false; continue; }
      if (e.isSymbolicLink()) { h.update(`L ${r}\n`); continue; }
      if (!e.isFile()) continue;
      const st = statSync(join(toplevel, r));
      files += 1;
      bytes += st.size;
      if (files > DIST_MAX_FILES || bytes > DIST_MAX_BYTES) return false;
      h.update(`F ${r} ${st.mode & 0o111 ? 'x' : '-'}\n`);
      h.update(readFileSync(join(toplevel, r)));
    }
    return true;
  };
  for (const r of roots) {
    let st;
    try { st = lstatSync(join(toplevel, r)); } catch { continue; }
    if (st.isFile()) { files += 1; h.update(`F ${r}\n`); h.update(readFileSync(join(toplevel, r))); continue; }
    if (!st.isDirectory()) continue;
    if (!walk(r)) return null;
  }
  return files === 0 ? '' : h.digest('hex');
}

/** Env a test reads that the command line does not show. Ids of a session or a tab included. */
function envFingerprint(env: NodeJS.ProcessEnv): string {
  const keys = Object.keys(env).filter((k) => /^(?:DREAMCONTEXT_|CLAUDE|NODE_|VITEST|JEST|CI$|TZ$|LANG$|LC_ALL$|HOME$)/.test(k)).sort();
  return sha(keys.map((k) => `${k}=${env[k]}`).join('\n'));
}

/** The receipt key for this plan on the code as it is now, or null (then the check just runs). */
export function receiptState(plan: ReceiptPlan, env: NodeJS.ProcessEnv = process.env): ReceiptState | null {
  try {
    const tree = contentTree(plan.toplevel);
    if (!tree) return null;
    let dist = '';
    if (plan.kind === 'tests') {
      const d = distFingerprint(plan.toplevel);
      const t = testInputsFingerprint(plan.toplevel);
      if (d === null || t === null) return null;
      dist = `${d} ${t}`;
    }
    const deps = depsFingerprint(plan.toplevel, plan.cwdRel);
    if (deps === null) return null;
    const family = sha(JSON.stringify({
      v: 1, kind: plan.kind, cwd: plan.cwdRel, command: plan.command, node: process.version,
      platform: process.platform, arch: process.arch, env: envFingerprint(env), deps, dist,
    }));
    return { tree, family, key: sha(`${family}\n${tree}`) };
  } catch {
    return null;
  }
}

// ─── reading and writing receipts ────────────────────────────────────────────

const ownFile = (dir: string, p: unknown, name: string): boolean => {
  if (p === undefined) return true;
  if (p !== join(dir, name)) return false;
  try { return lstatSync(p).isFile(); } catch { return false; }
};

function readReceipt(dir: string, key: string): Receipt | null {
  try {
    if (existsSync(join(dir, `${key}.red`))) return null;
    const file = join(dir, `${key}.json`);
    if (!lstatSync(file).isFile()) return null;
    const r = JSON.parse(readFileSync(file, 'utf-8')) as Receipt;
    // A receipt is believed only whole: its own key, a green exit, a tree, a known kind, and
    // only its own log and report beside it (never a link, never a path elsewhere).
    if (r?.v !== 1 || r.key !== key || r.exit !== 0 || typeof r.tree !== 'string' || !/^[0-9a-f]{40,64}$/.test(r.tree) || typeof r.family !== 'string') return null;
    if (!ownFile(dir, r.log, `${key}.log`) || !ownFile(dir, r.report, `${key}.report.json`)) return null;
    if (!['tsc', 'tests', 'build'].includes(r.kind) || typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return null;
    if (Date.now() - Date.parse(r.at) > RECEIPT_MAX_AGE_MS) return null;
    return r;
  } catch {
    return null;
  }
}

/**
 * Paths that cannot change this kind of check's result. Anything not listed means the check runs.
 *   every kind: the brain at the repo root (`_dream_context/`, `_agent_context/`).
 *   tsc: also Markdown, and package.json / package-lock.json whose only change is the version.
 */
export function harmlessFor(kind: ReceiptKind, path: string, versionOnly: (path: string) => boolean): boolean {
  // The root brain only: a nested `_dream_context/` is a test fixture (tests/fixtures/*/vault).
  if (/^_(?:dream|agent)_context\//.test(path)) return true;
  if (kind !== 'tsc') return false;
  if (/\.md$/i.test(path)) return true;
  if (/(?:^|\/)package(?:-lock)?\.json$/.test(path)) return versionOnly(path);
  return false;
}

/** Two JSON blobs equal once their version fields are set aside (package.json / lock). */
export function sameButVersion(a: string, b: string): boolean {
  try {
    const strip = (s: string) => {
      const o = JSON.parse(s) as Record<string, unknown>;
      if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
      delete o.version;
      const pk = o.packages as Record<string, Record<string, unknown>> | undefined;
      if (pk && typeof pk === 'object' && pk[''] && typeof pk[''] === 'object') { pk[''] = { ...pk[''] }; delete pk[''].version; }
      return JSON.stringify(o);
    };
    const x = strip(a);
    return x !== null && x === strip(b);
  } catch {
    return false;
  }
}

function changedPaths(toplevel: string, from: string, to: string): string[] | null {
  try {
    const out = execFileSync('git', ['-c', 'core.quotePath=false', 'diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to], { cwd: toplevel, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function blob(toplevel: string, tree: string, path: string): string | null {
  try { return git(toplevel, ['cat-file', 'blob', `${tree}:${path}`]); } catch { return null; }
}

/** The green receipt this check may reuse now, or null. Never throws. */
export function findReceipt(plan: ReceiptPlan, state: ReceiptState): ReceiptHit | null {
  try {
    const dir = receiptsDir(plan.toplevel);
    if (!dir) return null;
    // This exact check went red on this exact content after its last green: nothing stands in.
    if (existsSync(join(dir, `${state.key}.red`))) return null;
    const same = readReceipt(dir, state.key);
    if (same && same.tree === state.tree && same.family === state.family && outputsStill(plan, same)) return { receipt: same, via: 'same', paths: [] };
    let fam: { key: string }[] = [];
    try { fam = (JSON.parse(readFileSync(join(dir, `family-${state.family}.json`), 'utf-8')) as { key: string }[]).filter((e) => typeof e?.key === 'string'); } catch { return null; }
    for (const e of fam.slice(-FAMILY_KEEP).reverse()) {
      if (!/^[0-9a-f]{64}$/.test(e.key)) continue;
      const r = readReceipt(dir, e.key);
      if (!r || r.family !== state.family || r.tree === state.tree || !outputsStill(plan, r)) continue;
      const paths = changedPaths(plan.toplevel, r.tree, state.tree);
      if (!paths || paths.length === 0) continue;
      const versionOnly = (p: string) => {
        const a = blob(plan.toplevel, r.tree, p);
        const b = blob(plan.toplevel, state.tree, p);
        return a !== null && b !== null && sameButVersion(a, b);
      };
      if (paths.every((p) => harmlessFor(plan.kind, p, versionOnly))) return { receipt: r, via: 'harmless', paths };
    }
    return null;
  } catch {
    return null;
  }
}

/** A build's receipt holds only while what it built is still there, byte for byte. */
function outputsStill(plan: ReceiptPlan, r: Receipt): boolean {
  if (plan.kind !== 'build') return true;
  if (!r.outputs) return false;
  return distFingerprint(plan.toplevel) === r.outputs;
}

/**
 * Record a green check. `after` is the content once it finished: a tree that moved while it ran
 * (an edit, a checkout) is not the tree it proved, so nothing is written. Never throws.
 */
export function writeReceipt(plan: ReceiptPlan, before: ReceiptState, o: { exit: number; ms: number; fresh?: boolean; log?: string; report?: string }): Receipt | null {
  try {
    if (o.exit !== 0) return null;
    const after = receiptState(plan);
    if (!after || after.key !== before.key) return null;
    const dir = receiptsDir(plan.toplevel);
    if (!dir) return null;
    mkdirSync(dir, { recursive: true });
    let outputs: string | undefined;
    if (plan.kind === 'build') {
      const d = distFingerprint(plan.toplevel);
      if (!d) return null; // nothing built that a later run could find again
      outputs = d;
    }
    const keep = (src: string | undefined, ext: string): string | undefined => {
      if (!src || !existsSync(src)) return undefined;
      const dst = join(dir, `${before.key}.${ext}`);
      copyFileSync(src, `${dst}.tmp`);
      renameSync(`${dst}.tmp`, dst);
      return dst;
    };
    const r: Receipt = {
      v: 1, key: before.key, family: before.family, tree: before.tree, kind: plan.kind, command: plan.command, cwdRel: plan.cwdRel,
      exit: 0, at: new Date().toISOString(), ms: Math.round(o.ms), ...(o.fresh ? { fresh: true } : {}), ...(outputs ? { outputs } : {}),
      log: keep(o.log, 'log'), report: keep(o.report, 'report.json'),
    };
    atomicWrite(join(dir, `${before.key}.json`), `${JSON.stringify(r, null, 1)}\n`);
    rmSync(join(dir, `${before.key}.red`), { force: true });
    const famPath = join(dir, `family-${before.family}.json`);
    let fam: { key: string; at: string }[] = [];
    try { fam = JSON.parse(readFileSync(famPath, 'utf-8')) as { key: string; at: string }[]; if (!Array.isArray(fam)) fam = []; } catch { fam = []; }
    fam = [...fam.filter((e) => e?.key !== before.key), { key: before.key, at: r.at }].slice(-FAMILY_KEEP);
    atomicWrite(famPath, `${JSON.stringify(fam)}\n`);
    prune(dir);
    return r;
  } catch {
    return null;
  }
}

/**
 * A red run on this content: its green receipt goes, and a mark stays so a receipt of a nearby
 * tree cannot stand in for it either, until a green run replaces it. The newest run is the
 * truth, so a red `--fresh` can never leave an old green behind. Never throws.
 */
export function dropReceipt(plan: ReceiptPlan, state: ReceiptState): void {
  try {
    const dir = receiptsDir(plan.toplevel);
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const ext of ['json', 'log', 'report.json']) rmSync(join(dir, `${state.key}.${ext}`), { force: true });
    atomicWrite(join(dir, `${state.key}.red`), `${new Date().toISOString()}\n`);
  } catch { /* the check already ran and reported red */ }
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function prune(dir: string): void {
  const now = Date.now();
  for (const f of readdirSync(dir)) {
    try {
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs > RECEIPT_MAX_AGE_MS) rmSync(p, { force: true });
    } catch { /* another session pruned it */ }
  }
}

/** A scratch log path in the receipts folder for one run, or null outside git. */
export function scratchLog(toplevel: string): string | null {
  const dir = receiptsDir(toplevel);
  if (!dir) return null;
  try { mkdirSync(dir, { recursive: true }); } catch { return null; }
  return join(dir, `run-${process.pid}-${Date.now()}.log`);
}

const ago = (ms: number): string => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);
const took = (ms: number): string => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);

/** The receipt as one line: what proved it, when, and why it holds for this code. */
export function describeHit(hit: ReceiptHit, nowMs: number = Date.now()): string {
  const r = hit.receipt;
  const when = `${r.at.slice(0, 16).replace('T', ' ')} UTC (${ago(nowMs - Date.parse(r.at))} ago)`;
  const why = hit.via === 'same'
    ? 'on this exact code'
    : `on code that differs from this only in ${hit.paths.length <= 3 ? hit.paths.join(', ') : `${hit.paths.slice(0, 3).join(', ')} and ${hit.paths.length - 3} more`}, which a ${r.kind === 'tsc' ? 'type check' : 'test run'} cannot read`;
  return `RECEIPT, not re-run: "${r.command}" passed ${why}, ${when}, took ${took(r.ms)}${r.fresh ? ' (a --fresh run)' : ''}${r.log ? `; log ${r.log}` : ''}. Same code, same result; --fresh runs it again.`;
}

/** The last `n` lines of a stored log, '' when unreadable. */
export function logTail(path: string | undefined, n: number): string {
  if (!path) return '';
  try {
    const lines = readFileSync(path, 'utf-8').replace(/\s+$/, '').split('\n');
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}
