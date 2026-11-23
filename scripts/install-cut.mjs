#!/usr/bin/env node
// `npm run install:cut` (kesim-geri-donus K4): the ONLY way a local cut becomes the installed
// CLI. It accepts `super returns` only as a receipt of exactly what it asked, and stops (exit 1,
// before any `npm pack` / `npm i`) with the reason named when:
//   1. the worktree is dirty (HEAD is pinned to a sha first);
//   2. the build's stamp is not the pinned commit;
//   3. an installed CLI has no readable stamp and no `--installed-from <npm>=<ref>` names it (D7);
//   4. the report is not the receipt (from, the asked set, one row each, no errors), or an
//      installed build would lose work and the owner gave no `--accept-drop "<why>"`.
// Then: the app-open note, `npm pack`, HEAD still pinned, `npm i -g <tarball>` with EVERY npm on
// PATH that had the package (nvm, brew, ...: not Mac-specific), the spawn-helper chmod, the new
// stamp. Never `--force`, never a push.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40,64}$/;

export function parseArgs(argv) {
  const installedFrom = new Map();
  let acceptDrop = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--installed-from' || a.startsWith('--installed-from=')) {
      const v = a.includes('=') && a.startsWith('--installed-from=') ? a.slice('--installed-from='.length) : val();
      const eq = v.lastIndexOf('=');
      if (eq <= 0 || eq === v.length - 1) throw new Error(`--installed-from wants <npm>=<ref>, got "${v}"`);
      installedFrom.set(v.slice(0, eq), v.slice(eq + 1));
    } else if (a === '--accept-drop' || a.startsWith('--accept-drop=')) {
      const v = a.startsWith('--accept-drop=') ? a.slice('--accept-drop='.length) : val();
      if (!v.trim()) throw new Error('--accept-drop needs the owner\'s reason');
      acceptDrop = v.trim();
    } else throw new Error(`unknown argument ${a}`);
  }
  return { installedFrom, acceptDrop };
}

/** Every distinct real `npm` on PATH, plus the npm running this script (`npm_execpath`). */
export function npmCandidates(env = process.env, platform = process.platform, fs = { existsSync, realpathSync }) {
  const names = platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  const seen = new Set();
  const out = [];
  const add = (p) => {
    if (!p || !isAbsolute(p) || !fs.existsSync(p)) return;
    let real;
    try { real = fs.realpathSync(p); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(p);
  };
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const n of names) { if (fs.existsSync(join(dir, n))) { add(join(dir, n)); break; } }
  }
  // npm_execpath is <prefix>/lib/node_modules/npm/bin/npm-cli.js (Windows: <prefix>/node_modules/…):
  // its npm is <prefix>/bin/npm (Windows: <prefix>/npm.cmd).
  const exec = env.npm_execpath;
  if (exec && /npm-cli\.js$/.test(exec)) {
    const mods = dirname(dirname(dirname(exec)));
    add(resolve(platform === 'win32' ? join(mods, '..', names[0]) : join(mods, '..', '..', 'bin', names[0])));
  }
  return out;
}

/** A package dir's stamp, refusing a symlinked stamp or a dir that resolves elsewhere (K6). */
export function readStamp(pkgDir) {
  try {
    const file = join(pkgDir, 'dist', 'build-commit.json');
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const real = realpathSync(file);
    if (!real.startsWith(realpathSync(pkgDir))) return null;
    const j = JSON.parse(readFileSync(file, 'utf-8'));
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

/**
 * The receipt check (K4 step 4): proceed ONLY if stdout parses, `from.sha` is the pinned sha,
 * `drops.asked` is exactly the asked set, no `drops.errors`, one row per asked entry.
 */
export function checkReceipt(stdout, { pinned, asked }) {
  let r;
  try { r = JSON.parse(stdout); } catch { return { ok: false, reason: 'super returns did not answer JSON' }; }
  if (!r || typeof r !== 'object' || !r.from || !r.drops) return { ok: false, reason: 'super returns answered no report' };
  if (r.from.sha !== pinned) return { ok: false, reason: `the report is of ${String(r.from.sha).slice(0, 12)}, not the pinned ${pinned.slice(0, 12)}` };
  const key = (e) => `${e.npm}\u0000${e.installed ?? e.sha}`;
  const want = new Set(asked.map(key));
  const got = new Set((r.drops.asked ?? []).map(key));
  if (asked.length > 0 && (want.size !== got.size || [...want].some((k) => !got.has(k)))) return { ok: false, reason: 'the report answered another set of installed builds than the one asked' };
  if ((r.drops.errors ?? []).length) return { ok: false, reason: `the drops could not be read: ${r.drops.errors.map((e) => `${e.npm}: ${e.error}`).join('; ')}` };
  if (asked.length > 0) {
    for (const a of asked) {
      const rows = (r.drops.rows ?? []).filter((x) => x.npm === a.npm && x.installed === a.sha);
      if (rows.length !== 1) return { ok: false, reason: `no single drops row for ${a.npm}` };
    }
  }
  return { ok: true, report: r };
}

const defaultRun = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: o.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'], cwd: o.cwd, env: o.env, timeout: o.timeout ?? 30 * 60_000, shell: process.platform === 'win32' && /\.cmd$/i.test(cmd) });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error?.message ?? '') };
};

export async function installCut({ cwd = process.cwd(), argv = process.argv.slice(2), env = process.env, run = defaultRun, log = console.log, warn = console.error, npms } = {}) {
  const stop = (why) => { warn(`install:cut STOPPED: ${why}`); return 1; };
  let args;
  try { args = parseArgs(argv); } catch (err) { return stop(err.message); }
  const git = (a) => run('git', a, { cwd });

  // 1. Pin HEAD; a dirty worktree is refused.
  const head = git(['rev-parse', '--verify', 'HEAD']).stdout.trim();
  if (!SHA_RE.test(head)) return stop('HEAD is not a commit');
  const pinned = head;
  if (git(['status', '--porcelain']).stdout.trim()) return stop('the worktree has uncommitted changes: commit them first (the install must be exactly one commit)');
  log(`install:cut: pinned ${pinned.slice(0, 12)}`);

  // 2. Build; its stamp must be the pinned commit.
  if (run('npm', ['run', 'build'], { cwd, inherit: true }).code !== 0) return stop('npm run build failed');
  const built = readStamp(cwd);
  if (!built || built.sha !== pinned) return stop(`dist/build-commit.json is ${built?.sha ? built.sha.slice(0, 12) : 'missing'}, not the pinned ${pinned.slice(0, 12)}`);

  // 3. Every npm on PATH and the stamp of the dreamcontext each holds.
  const found = [];
  for (const npm of npms ?? npmCandidates(env)) {
    const root = run(npm, ['root', '-g']).stdout.trim();
    const pkg = root ? join(root, 'dreamcontext') : '';
    if (!pkg || !existsSync(join(pkg, 'package.json'))) { log(`  ${npm}: dreamcontext not installed, skipped`); continue; }
    const named = args.installedFrom.get(npm);
    let sha = null;
    if (named) {
      const r = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${named}^{commit}`]).stdout.trim();
      if (!SHA_RE.test(r)) return stop(`--installed-from ${npm}=${named}: not a commit here`);
      sha = r;
    } else {
      const st = readStamp(pkg);
      if (st?.sha && SHA_RE.test(st.sha) && git(['cat-file', '-e', `${st.sha}^{commit}`]).code === 0) {
        sha = st.sha;
        if (st.dirty) warn(`  ${npm}: its installed build was made from a dirty worktree; its uncommitted part is not checked`);
      } else {
        return stop(`${npm} holds a dreamcontext with ${st?.sha ? `stamp ${st.sha.slice(0, 12)}, not a commit of this repo` : 'no build stamp'}: name what it holds with --installed-from ${npm}=<ref>`);
      }
    }
    found.push({ npm, pkg, sha });
    log(`  ${npm}: installed ${sha.slice(0, 12)}`);
  }
  const asked = found.map((f) => ({ npm: f.npm, sha: f.sha }));

  // 4. The receipt.
  const q = ['dist/index.js', 'super', 'returns', '--from', pinned, '--json', ...asked.flatMap((a) => ['--installed-from', `${a.npm}=${a.sha}`])];
  const rr = run(process.execPath, q, { cwd, timeout: 10 * 60_000 });
  const receipt = checkReceipt(rr.stdout, { pinned, asked });
  if (!receipt.ok) return stop(`${receipt.reason}${rr.stderr.trim() ? ` (${rr.stderr.trim().slice(0, 300)})` : ''}`);
  const report = receipt.report;
  if (report.error) warn(`  dev side: ${report.error} (not blocking)`);
  const dropping = (report.drops.rows ?? []).filter((x) => (x.groups ?? []).length > 0);
  if (dropping.length) {
    for (const row of dropping) {
      warn(`  ${row.npm} @ ${String(row.installed).slice(0, 12)} would LOSE:`);
      for (const g of row.groups) { warn(`    ${g.name}`); for (const c of g.commits ?? []) warn(`      ${String(c.sha).slice(0, 9)} ${c.subject}`); }
    }
    if (!args.acceptDrop) return stop('installing this cut would drop the work above from an installed build: bring it into the cut, or the owner says why it may go with --accept-drop "<why>"');
    warn(`  dropped on the owner's word: ${args.acceptDrop}`);
    const stampFile = join(cwd, 'dist', 'build-commit.json');
    const st = JSON.parse(readFileSync(stampFile, 'utf-8'));
    st.acceptedDrops = { why: args.acceptDrop, at: new Date().toISOString(), rows: dropping.map((x) => ({ npm: x.npm, installed: x.installed, groups: x.groups.map((g) => g.name) })) };
    writeFileSync(stampFile, JSON.stringify(st, null, 2) + '\n');
  }

  // 5. Install the tarball with each npm that had the package.
  const appOpen = process.platform === 'win32'
    ? /dreamcontext-desktop/i.test(run('tasklist', []).stdout)
    : run('pgrep', ['-f', 'dreamcontext-desktop']).code === 0;
  if (appOpen) log('install:cut: the app is open; its run cards and terminal keep working, the new version starts after Cmd-Q and reopen.');
  const pack = run('npm', ['pack', '--silent'], { cwd });
  const tarball = pack.stdout.trim().split('\n').filter(Boolean).pop();
  if (pack.code !== 0 || !tarball) return stop(`npm pack failed: ${pack.stderr.trim().slice(0, 300)}`);
  if (git(['rev-parse', '--verify', 'HEAD']).stdout.trim() !== pinned) return stop('HEAD moved during the build: run install:cut again');
  const tgz = join(cwd, tarball);
  const done = [];
  for (const f of found) {
    const r = run(f.npm, ['i', '-g', tgz], { inherit: true });
    if (r.code !== 0) {
      warn(`install:cut FAILED with ${f.npm}. Now: ${done.map((d) => `${d.npm} holds ${pinned.slice(0, 12)}`).concat(found.filter((x) => x !== f && !done.includes(x)).map((x) => `${x.npm} still holds ${x.sha.slice(0, 12)}`)).concat([`${f.npm} still holds ${f.sha.slice(0, 12)} (or a partial install)`]).join('; ')}`);
      return 1;
    }
    done.push(f);
    // npm i -g writes node-pty's spawn-helper without its execute bit (build pattern, 2026-11-14).
    try {
      const pre = join(f.pkg, 'node_modules', 'node-pty', 'prebuilds');
      for (const d of readdirSync(pre)) { const h = join(pre, d, 'spawn-helper'); if (existsSync(h)) chmodSync(h, 0o755); }
    } catch { /* no node-pty prebuilds on this platform */ }
  }
  if (!found.length) log('install:cut: no npm on PATH had dreamcontext installed; built and packed only.');
  const awaiting = (report.awaiting ?? []).length;
  log(`install:cut: installed ${pinned.slice(0, 12)} with ${done.length} npm(s); stamp ${JSON.stringify(readStamp(cwd))}`);
  log(`install:cut: ${awaiting} branch(es) of this cut are not back in dev yet${awaiting ? ': `dreamcontext super returns` lists them' : ''}.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installCut().then((code) => { process.exitCode = code; });
}
