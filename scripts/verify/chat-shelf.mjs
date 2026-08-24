#!/usr/bin/env node
/**
 * The chat shelf's two READ routes — end-to-end verification against the real server.
 *
 *   npm run build:cli && npm run verify:chat-shelf
 *
 * WHAT IT DRIVES — the real dashboard server (`dist/index.js dashboard`), the real routes,
 * real task files and a real git repository (plus a real linked worktree) on disk. Nothing
 * is imported and called directly; every check is an HTTP request, exactly as the shelf
 * makes it.
 *
 * WHAT IT PROVES
 *   1-4. the progress number is DERIVED FROM DISK — 7 of 11 ticked reads 64%, ticking an
 *        eighth on disk moves it to 73% on the next poll, and the three degenerate shapes
 *        (no criteria, all ticked, no such task) each degrade LOUDLY with a notice instead
 *        of a NaN or a silent empty row;
 *   5.   a hostile slug is refused with a 400 before the filesystem is consulted;
 *   6-7. the session facts name the branch, and tell a plain checkout apart from a linked
 *        worktree — including the main checkout the worktree belongs to;
 *   8.   with the desktop gate off, both routes answer a renderable shape, never a 500.
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is never spawned: these routes only READ files.
 *
 * WHAT IT NEVER TOUCHES — the developer's real home. The server runs under an isolated
 * scratch `$HOME` (the `past-chats.mjs:34,146` env pattern), so its vault registry and any
 * `~/.claude*` lookup can only ever see this fixture. No verify script reads or writes the
 * real `~/.claude.json`.
 *
 * The BROWSER half of the shelf's verification (resting state, row open/close, the ceiling,
 * scroll-invariance geometry) is `scripts/verify/chat-shelf-ui.mjs` — a separate script, for
 * the UI that renders these numbers.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST (matching verify/past-chats.mjs): every check
 * prints ✓/✗ with evidence and the run continues. Exit 0 iff everything passed.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-shelf');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const WT = join(SCRATCH, 'worktree');

const BRANCH = 'feat/pin-surface';
const WT_BRANCH = 'feat/side-quest';

// ─── fixture ──────────────────────────────────────────────────────────────────────────

/** A task whose Acceptance Criteria hold `total` checkboxes, `done` of them ticked. */
function taskFile(total, done) {
  const criteria = Array.from({ length: total }, (_, i) =>
    `- [${i < done ? 'x' : ' '}] criterion number ${i + 1}`).join('\n');
  return [
    '---',
    'id: task_verify',
    'status: in_progress',
    '---',
    '## Acceptance Criteria',
    '',
    criteria,
    '',
    '## Changelog',
    '<!-- LIFO: newest at top. -->',
    '',
    '### 2026-08-23 - Session Update',
    '- the newest thing that happened',
    '### 2026-08-22 - Created',
    '- Task created.',
    '',
  ].join('\n');
}

function writeTask(root, slug, body) {
  const dir = join(root, '_dream_context', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body, 'utf-8');
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });

  // A REAL repo on a named branch — the branch chip has to come from somewhere true.
  git(PROJ, 'init', '-q', '-b', BRANCH);
  git(PROJ, 'config', 'user.email', 'verify@example.com');
  git(PROJ, 'config', 'user.name', 'Verify');
  writeFileSync(join(PROJ, 'README.md'), '# fixture\n', 'utf-8');
  git(PROJ, 'add', 'README.md');
  git(PROJ, 'commit', '-qm', 'initial');

  // …and a REAL linked worktree of it, which must be told apart from the checkout above.
  git(PROJ, 'worktree', 'add', '-q', '-b', WT_BRANCH, WT);
  mkdirSync(join(WT, '_dream_context', 'state'), { recursive: true });

  writeTask(PROJ, 'seven-of-eleven', taskFile(11, 7));
  writeTask(PROJ, 'no-boxes', '---\nid: task_nb\n---\n## Acceptance Criteria\n\nProse only.\n');
  writeTask(PROJ, 'all-ticked', taskFile(5, 5));

  for (const [name, path] of [['proj', PROJ], ['wt', WT]]) {
    const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', name, path],
      { env: { ...process.env, HOME }, encoding: 'utf-8' });
    if (add.status !== 0) throw new Error(`vaults add ${name} failed: ${add.stderr || add.stdout}`);
  }
}

// ─── harness ──────────────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(port, { desktop = true } = {}) {
  const env = { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' };
  if (!desktop) delete env.DREAMCONTEXT_DESKTOP;
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return srv;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const report = { pass: 0, fails: [] };
function ok(label, cond, evidence = '') {
  if (cond) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fails.push(label); console.log(`  ✗ ${label}${evidence ? `\n      ${evidence}` : ''}`); }
}

async function getJson(base, path, vault) {
  const res = await fetch(`${base}${path}`, { headers: { 'X-Dreamcontext-Vault': vault } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const progress = (base, slug, vault = 'proj') =>
  getJson(base, `/api/agent/task-progress?slug=${encodeURIComponent(slug)}`, vault);
const facts = (base, vault = 'proj') => getJson(base, '/api/agent/session-facts', vault);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── run ──────────────────────────────────────────────────────────────────────────────

let server = null;
try {
  console.log('· building the fixture (isolated HOME, real repo + worktree, real task files)…');
  setup();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);

  console.log('\nPROGRESS — the number is read off the task file, not asserted');
  const seven = await progress(base, 'seven-of-eleven');
  ok('7 of 11 ticked reads 64%', seven.status === 200 && seven.body?.percent === 64,
    JSON.stringify(seven.body));
  ok('…and reports the raw count behind it', seven.body?.done === 7 && seven.body?.total === 11,
    JSON.stringify({ done: seven.body?.done, total: seven.body?.total }));
  ok('…names the criterion in flight', seven.body?.now === 'criterion number 8', String(seven.body?.now));
  ok('…and what was just done, from the changelog',
    seven.body?.last === 'the newest thing that happened', String(seven.body?.last));
  ok('a healthy reading carries no notice', seven.body?.notice === null, String(seven.body?.notice));

  console.log('\nREFRESH — it follows the file, it is not frozen at first read');
  await sleep(50); // so the mtime is measurably later, not merely equal
  writeTask(PROJ, 'seven-of-eleven', taskFile(11, 8));
  const eight = await progress(base, 'seven-of-eleven');
  ok('ticking an eighth criterion on disk moves the reading to 73%', eight.body?.percent === 73,
    JSON.stringify({ before: seven.body?.percent, after: eight.body?.percent }));
  ok('…the in-flight criterion moves with it', eight.body?.now === 'criterion number 9', String(eight.body?.now));
  ok('…and updatedAt advanced', eight.body?.updatedAt > seven.body?.updatedAt,
    JSON.stringify({ before: seven.body?.updatedAt, after: eight.body?.updatedAt }));

  console.log('\nDEGRADATION — loudly, never a NaN and never a silent empty row');
  const none = await progress(base, 'no-boxes');
  ok('zero criteria → percent null (not NaN, not 0)', none.body?.percent === null, JSON.stringify(none.body));
  ok('…and says why', none.body?.state === 'no-criteria' && !!none.body?.notice, JSON.stringify(none.body));

  const all = await progress(base, 'all-ticked');
  ok('an all-ticked task reads 100%', all.body?.percent === 100, JSON.stringify(all.body));
  ok('…is flagged all-done with nothing in flight',
    all.body?.state === 'all-done' && all.body?.now === null, JSON.stringify(all.body));
  ok('…and still carries a notice — a full bar is not self-explanatory', !!all.body?.notice,
    String(all.body?.notice));

  const missing = await progress(base, 'no-such-task-here');
  ok('a well-formed slug with no file is a 200 STATE, not a failed request',
    missing.status === 200 && missing.body?.state === 'unknown-slug', JSON.stringify(missing));
  ok('…with a notice naming the slug', String(missing.body?.notice).includes('no-such-task-here'),
    String(missing.body?.notice));

  console.log('\nSLUG SAFETY — refused before the filesystem is consulted');
  for (const slug of ['../../etc/passwd', '../secrets', '/etc/passwd', '']) {
    const bad = await progress(base, slug);
    ok(`a hostile slug is 400 (${JSON.stringify(slug)})`,
      bad.status === 400 && bad.body?.error === 'invalid_slug', JSON.stringify(bad));
  }

  console.log('\nSESSION FACTS — which checkout is this session acting on?');
  const main = await facts(base, 'proj');
  ok('the branch is reported', main.body?.branch === BRANCH, JSON.stringify(main.body));
  ok('…a plain checkout is NOT called a worktree',
    main.body?.worktree === false && main.body?.mainRoot === null, JSON.stringify(main.body));
  ok('…and it is recognised as a repo', main.body?.isRepo === true, JSON.stringify(main.body));

  const linked = await facts(base, 'wt');
  ok('a linked worktree reports its own branch', linked.body?.branch === WT_BRANCH, JSON.stringify(linked.body));
  ok('…is marked as a worktree', linked.body?.worktree === true, JSON.stringify(linked.body));
  ok('…and names the main checkout it belongs to',
    linked.body?.mainRoot === realpathSync(PROJ),
    JSON.stringify({ got: linked.body?.mainRoot, want: realpathSync(PROJ) }));

  console.log('\nTHE DESKTOP GATE — an unavailable reading is empty, never a 500');
  server.kill();
  server = await startServer(port, { desktop: false });
  const gatedProgress = await progress(base, 'seven-of-eleven');
  ok('task-progress answers 200 with a renderable shape',
    gatedProgress.status === 200 && gatedProgress.body?.percent === null && !!gatedProgress.body?.notice,
    JSON.stringify(gatedProgress));
  const gatedFacts = await facts(base, 'proj');
  ok('session-facts answers 200 with the unknown shape',
    gatedFacts.status === 200 && gatedFacts.body?.isRepo === false && gatedFacts.body?.branch === null,
    JSON.stringify(gatedFacts));
  const gatedBad = await progress(base, '../../etc/passwd');
  ok('…and a hostile slug is STILL a 400, gate or no gate',
    gatedBad.status === 400, JSON.stringify(gatedBad));
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
