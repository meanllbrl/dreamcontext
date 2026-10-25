#!/usr/bin/env node
/**
 * AI Team v2, wave C1 (AC-C1-10): task steps on the REAL claude, each under its level's envelope.
 *
 *   npm run build:cli && node scripts/verify/agent-modes-real.mjs
 *
 * SPENDS REAL TOKENS on the cheapest model (haiku): three short runs, a review and a plan. It is
 * a smoke, not a suite: run it once per change to the envelopes or the task host.
 *
 * WHAT IT DRIVES: the BUILT CLI as the scheduler (`automations tick --all`) and the detached task
 * host, the real `claude` on the owner's own accounts. That needs the REAL home: a Claude sign-in
 * is kept per config path, so a scratch HOME (even one linking to the real folders) cannot reach
 * it, and account protection must see every account to pick one under its threshold. So the
 * script ADDS to the real home and takes back exactly what it added, by name, in a `finally`:
 * the scratch project's registry entry (and the approvals under it), the scratch repo's
 * linked-repo key, the project's machine-local folder, its task worktree, and the session files
 * of its three agents (named `smoke-*-c1` so they collide with nobody's). A shim first on PATH
 * makes every `dreamcontext` a run calls this build. Fixtures are fictional (a project called
 * "Lumen Notes", a repo called `greeter`).
 *
 *   §1 an `auto` doer (Balanced) works in its task worktree, commits, and calls
 *      `dreamcontext tasks deliver` from there: the live brain's task reaches In Review;
 *   §2 its reviewer runs `auto` with no edit tools, records a verdict that applies (the workspace
 *      did not change under it);
 *   §3 an Ask agent's `plan` step runs in plan mode and its plan reaches the owner's inbox row.
 *   Each run's `permissionMode` is read from its own transcript. The CLI version is recorded.
 *   Collect, don't fail fast; exit 1 on any FAIL. The scratch folder is kept on a FAIL.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
if (!existsSync(CLI)) { console.error('dist/index.js is missing: run npm run build:cli first'); process.exit(2); }
const REAL_HOME = homedir();
const which = spawnSync('sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
const CLAUDE = existsSync(join(REAL_HOME, '.local', 'bin', 'claude')) ? join(REAL_HOME, '.local', 'bin', 'claude') : which;
if (!CLAUDE) { console.error('no claude binary found'); process.exit(2); }

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'dc-agent-modes-real-')));

const PROJECT = join(SCRATCH, 'lumen-notes');
const CODE = join(SCRATCH, 'greeter-smoke-c1');
const BIN = join(SCRATCH, 'bin');
const MODEL = process.env.SMOKE_MODEL || 'haiku';
const BUDGET_MS = Number(process.env.SMOKE_BUDGET_MS || 10 * 60_000);

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` (${detail})` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── the real home, borrowed ─────────────────────────────────────────────────
const HOME = REAL_HOME;
const DC = join(HOME, '.dreamcontext');
const AGENTS = ['smoke-builder-c1', 'smoke-checker-c1', 'smoke-planner-c1'];
const REPO_URL = 'https://github.com/example/greeter-smoke-c1.git';
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, 'dreamcontext'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
chmodSync(join(BIN, 'dreamcontext'), 0o755);

const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && !k.startsWith('DREAMCONTEXT_') && k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CONFIG_DIR'));
ENV.PATH = `${BIN}:${process.env.PATH ?? ''}`;

/** Read-modify-write one JSON file, touching only `edit`'s keys (another writer may share it). */
function editJson(path, edit) {
  const cur = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
  const next = edit(cur);
  const tmp = `${path}.${process.pid}.smoke.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  spawnSync('mv', ['-f', tmp, path]);
}
function cleanup() {
  try {
    editJson(join(DC, 'automations.json'), (j) => { if (j.projects) delete j.projects[PROJECT]; return j; });
    editJson(join(DC, 'linked-repos.json'), (j) => { if (j.repos) delete j.repos[REPO_URL]; return j; });
    rmSync(M0, { recursive: true, force: true });
    for (const a of AGENTS) rmSync(join(DC, 'automations', `${a}.sessions.json`), { force: true });
    for (const entry of readdirSync(join(HOME, '.claude-worktrees')).filter((n) => n.startsWith('greeter-smoke-c1-super-task-'))) {
      git(CODE, ['worktree', 'remove', '--force', join(HOME, '.claude-worktrees', entry)]);
      rmSync(join(HOME, '.claude-worktrees', entry), { recursive: true, force: true });
    }
  } catch (err) {
    console.log(`  ! cleanup: ${err.message}`);
  }
}

function dc(args, cwd = PROJECT) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Smoke', ...args], { cwd, encoding: 'utf8' });
}

// The code repo the doer works in (a worktree of it), linked to the project.
const CODE_NAME = 'greeter-smoke-c1';
mkdirSync(CODE, { recursive: true });
writeFileSync(join(CODE, 'hello.txt'), 'hello\n');
writeFileSync(join(CODE, 'README.md'), '# greeter\n\nA one-file greeter.\n');
git(CODE, ['init', '-q', '-b', 'main']);
git(CODE, ['add', '-A']);
git(CODE, ['commit', '-q', '-m', 'init']);

mkdirSync(join(PROJECT, '_dream_context', 'state'), { recursive: true });
mkdirSync(join(PROJECT, '_dream_context', 'automations'), { recursive: true });
writeFileSync(join(PROJECT, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '0.34.5', linkedRepos: [{ name: CODE_NAME, gitRemoteUrl: REPO_URL }] }, null, 2));
editJson(join(DC, 'linked-repos.json'), (j) => ({ ...j, repos: { ...(j.repos ?? {}), [REPO_URL]: CODE } }));
editJson(join(DC, 'automations.json'), (j) => ({ ...j, projects: { ...(j.projects ?? {}), [PROJECT]: { approvals: {} } } }));

function task(slug, id, name, criteria) {
  writeFileSync(join(PROJECT, '_dream_context', 'state', `${slug}.md`), [
    '---', `id: ${id}`, `name: ${name}`, 'status: todo', 'created_at: "2026-10-25"', 'updated_at: "2026-10-25"', '---', '',
    '## Why', 'A smoke test of task jobs.', '', '## Acceptance Criteria', ...criteria.map((c) => `- [ ] ${c}`), '', '## Changelog', '',
  ].join('\n'));
}
function taskData(slug) {
  const text = readFileSync(join(PROJECT, '_dream_context', 'state', `${slug}.md`), 'utf-8');
  const fm = text.split('\n---')[0];
  const get = (k) => (new RegExp(`^${k}: (.*)$`, 'm').exec(fm)?.[1] ?? '').replace(/^['"]|['"]$/g, '').trim();
  return { text, status: get('status'), state: get('agent_state'), step: get('agent_step'), passed: get('review_passed') };
}
const projectKey = createHash('sha256').update(realpathSync(PROJECT), 'utf8').digest('hex').slice(0, 16);
const M0 = join(HOME, '.dreamcontext', 'local', projectKey);
const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fb; } };
function sessionsOf(taskId) { return (readJson(join(M0, 'agent-task-jobs.json'), {}).sessions ?? []).filter((s) => s.taskId === taskId); }
function transcriptOf(sid) {
  const base = join(REAL_HOME, '.claude', 'projects');
  for (const dir of readdirSync(base)) {
    const p = join(base, dir, `${sid}.jsonl`);
    if (existsSync(p)) return readFileSync(p, 'utf-8');
  }
  return null;
}
function modesIn(jsonl) { return [...new Set([...(jsonl ?? '').matchAll(/"permissionMode":"([A-Za-z]+)"/g)].map((m) => m[1]))]; }

// Whatever happens next, what was added to the real home goes again.
let cleaned = false;
const cleanupOnce = () => { if (!cleaned) { cleaned = true; cleanup(); } };
process.on('exit', cleanupOnce);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ─── run ──────────────────────────────────────────────────────────────────────
console.log(`\nagent-modes-real: ${SCRATCH}`);
const version = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(`  claude ${version}, model ${MODEL}`);
check('the claude CLI version is recorded', /\d+\.\d+\.\d+/.test(version), version);

for (const [slug, title, prompt] of [
  ['smoke-builder-c1', 'Builder', 'You do small, exact coding tasks in the repository you are given, then hand the work in as your task says.'],
  ['smoke-checker-c1', 'Checker', 'You review deliveries strictly against their acceptance criteria and record a verdict as your task says.'],
  ['smoke-planner-c1', 'Planner', 'You plan small tasks carefully before anything is changed.'],
]) {
  const r = dc(['agents', 'create', slug, '--title', title, '--prompt', prompt, '--model', MODEL]);
  check(`agent ${slug} created and approved`, r.code === 0, r.code === 0 ? '' : r.out.slice(0, 300));
}
const ask = dc(['agents', 'edit', 'smoke-planner-c1', '--autonomy', 'ask']);
check('planner set to Ask', ask.code === 0, ask.code === 0 ? '' : ask.out.slice(0, 300));

task('greet', 'task_smoke_greet', 'Make the greeting say hello world', [
  'hello.txt contains exactly the line "hello world" (and nothing else)',
  'the change is committed on the task branch',
]);
task('plan-notes', 'task_smoke_plan', 'Plan a short "Getting started" note for Lumen Notes', [
  'a plan exists for a three-section getting-started note',
]);

const a1 = dc(['tasks', 'assign-agent', 'greet', 'smoke-builder-c1', '--workspace', 'code', '--repo', CODE_NAME, '--reviewer', 'smoke-checker-c1']);
check('the code task is assigned (doer + reviewer)', a1.code === 0, a1.out.trim().split('\n').pop());
const a2 = dc(['tasks', 'assign-agent', 'plan-notes', 'smoke-planner-c1']);
check('the Ask task is assigned', a2.code === 0, a2.out.trim().split('\n').pop());

const deadline = Date.now() + BUDGET_MS;
let greetDone = false;
let planDone = false;
while (Date.now() < deadline && !(greetDone && planDone)) {
  await sleep(15_000);
  dc(['automations', 'tick', '--all'], tmpdir());
  const g = taskData('greet');
  greetDone = g.status === 'in_review' && (g.state === 'delivered' || g.state === 'stuck' || g.step === 'rework');
  planDone = taskData('plan-notes').state === 'waiting_owner';
  console.log(`  … greet ${g.status}/${g.state}/${g.step}, plan-notes ${taskData('plan-notes').state}`);
}

// §1 the doer
const greet = taskData('greet');
const doerSid = sessionsOf('task_smoke_greet').find((s) => s.role === 'doer')?.sessionId;
const doerModes = modesIn(transcriptOf(doerSid));
check('§1 the doer ran in auto', doerModes.includes('auto') && !doerModes.includes('bypassPermissions'), doerModes.join(','));
check('§1 its delivery from the worktree moved the live task to In Review (by the agent)', /Status → in_review \(by agent:smoke-builder-c1\)/.test(greet.text), greet.status);
const wt = join(HOME, '.claude-worktrees', `${CODE_NAME}-super-task-${createHash('sha256').update('task_smoke_greet').digest('hex').slice(0, 8)}`);
const hello = existsSync(join(wt, 'hello.txt')) ? readFileSync(join(wt, 'hello.txt'), 'utf-8') : '(missing)';
check('§1 the work happened in the task worktree', hello.trim() === 'hello world', JSON.stringify(hello));
check('§1 the main checkout is untouched', readFileSync(join(CODE, 'hello.txt'), 'utf-8') === 'hello\n');

// §2 the reviewer
const reviewerSid = sessionsOf('task_smoke_greet').find((s) => s.role === 'reviewer')?.sessionId;
const reviewModes = modesIn(transcriptOf(reviewerSid));
check('§2 the reviewer ran in auto', reviewModes.includes('auto'), reviewModes.join(','));
check('§2 its verdict applied (the workspace did not change under it)', (greet.passed === 'true' || greet.step === 'rework' || greet.state === 'stuck') && !greet.text.includes('Review refused'), `${greet.state}/${greet.step}/passed=${greet.passed}`);

// §3 the plan
const planSid = sessionsOf('task_smoke_plan').find((s) => s.role === 'doer')?.sessionId;
const planModes = modesIn(transcriptOf(planSid));
check('§3 the Ask plan step ran in plan mode', planModes.includes('plan'), planModes.join(','));
const rows = readJson(join(M0, 'owner-inbox.json'), { rows: [] }).rows ?? [];
const planRow = rows.find((r) => r.kind === 'task-plan');
check('§3 its plan reached the owner\'s inbox row', !!planRow && (planRow.detail ?? '').length > 40, planRow ? `${(planRow.detail ?? '').length} chars` : 'no row');

// Leave no host behind.
for (const c of readJson(join(M0, 'agent-task-jobs.json'), {}).claims ?? []) {
  for (const pid of [c.hostPid, c.childPid]) { if (pid) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
}
cleanupOnce();

console.log(`\nagent-modes-real: ${passed} passed, ${failed} failed`);
if (failed === 0) rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
else console.log(`  scratch kept: ${SCRATCH}`);
process.exit(failed === 0 ? 0 : 1);
