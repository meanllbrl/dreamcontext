#!/usr/bin/env node
/**
 * people-first end-to-end verification (T9).
 *
 * Drives the BUILT CLI (`dist/index.js`) against throwaway vaults under a temp
 * dir with an isolated fake HOME and its own git identity per vault. Nothing
 * here touches the real `~/.dreamcontext`, the real git config, or this repo's
 * own `_dream_context/`.
 *
 *   npm run build && npm run verify:people
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST. Every check prints PASS/FAIL with
 * an evidence line and the run continues, so one invocation tells you everything
 * that is broken rather than only the first thing. A step whose SETUP throws is
 * recorded as a single FAIL for that step and the remaining steps still run
 * (steps that depend on it will then fail with their own evidence, which is the
 * information you want). Exit code is 0 iff every check passed.
 *
 * Step ids match the plan's e2e outline (v1 §"Scratch-vault e2e outline" +
 * the v2/v3 deltas): 1-9, 9b, 10-pre, 10-pre-b, 10, 10b, 11-15.
 */

import { spawnSync, spawn } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The people-first migration ships as 0.23.0 and `runMigrations` is half-open
 * `(setupVersion, dreamcontextVersion()]` — so on a repo still at 0.22.0 the
 * migration can never fire through its real trigger. Rather than fake the
 * trigger, the harness stages a copy of the built CLI whose package.json says
 * 0.23.0 (`readDreamcontextVersionFromDisk` reads `<cliRoot>/package.json`).
 * Once the release bumps the repo to >= 0.23.0 this staging is skipped and the
 * repo's own dist is driven directly.
 */
const MIGRATION_VERSION = '0.23.0';

// ─── Harness ─────────────────────────────────────────────────────────────────

/** Every recorded check, in order. */
const results = [];
let currentStep = null;

function step(id, title, fn) {
  currentStep = { id, title };
  console.log(`\n── Step ${id} — ${title}`);
  try {
    fn();
  } catch (err) {
    record(false, `step ${id} threw before finishing`, err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  currentStep = null;
}

function record(ok, label, evidence) {
  const entry = { step: currentStep?.id ?? '?', title: currentStep?.title ?? '', ok, label, evidence };
  results.push(entry);
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag} [${entry.step}] ${label}`);
  console.log(`       ↳ ${oneLine(evidence)}`);
}

function check(label, ok, evidence) {
  record(!!ok, label, evidence);
}

/** Assert `haystack` contains `needle`; evidence quotes the needle either way. */
function checkContains(label, haystack, needle) {
  const ok = String(haystack).includes(needle);
  check(label, ok, ok ? `found ${JSON.stringify(needle)}` : `missing ${JSON.stringify(needle)} in ${excerpt(haystack)}`);
}

function checkAbsent(label, haystack, needle) {
  const ok = !String(haystack).includes(needle);
  check(label, ok, ok ? `absent: ${JSON.stringify(needle)}` : `unexpectedly present: ${JSON.stringify(needle)}`);
}

function checkEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? `= ${truncate(a, 160)}` : `expected ${truncate(e, 200)}, got ${truncate(a, 200)}`);
}

function oneLine(text) {
  return String(text ?? '').replace(/\s*\n\s*/g, ' ⏎ ').trim();
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function excerpt(text) {
  return truncate(oneLine(text), 260);
}

/** A stack trace escaped into user-facing output — the thing `doctor` must never print. */
function looksLikeStackTrace(text) {
  return /^\s+at\s+\S+.*:\d+:\d+/m.test(text) || text.includes('node:internal/');
}

// ─── Isolated workspace ──────────────────────────────────────────────────────

const WORK = mkdtempSync(join(tmpdir(), 'dc-verify-people-'));
const FAKE_HOME = join(WORK, 'home');
mkdirSync(join(FAKE_HOME, '.dreamcontext'), { recursive: true });

const BASE_ENV = (() => {
  const env = { ...process.env };
  // Machine identity must never leak in from the developer's shell.
  delete env.DREAMCONTEXT_PERSON;
  return {
    ...env,
    HOME: FAKE_HOME,
    USERPROFILE: FAKE_HOME,
    XDG_CONFIG_HOME: join(FAKE_HOME, '.config'),
    // Git: the vault-local `git config user.*` is the ONLY identity in play.
    GIT_CONFIG_GLOBAL: join(FAKE_HOME, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
  };
})();

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** Resolve the CLI entrypoint, staging a version-bumped copy when needed (see MIGRATION_VERSION). */
function resolveCli() {
  const distEntry = join(REPO, 'dist', 'index.js');
  if (!existsSync(distEntry)) {
    console.error('dist/index.js not found — run `npm run build` first.');
    process.exit(2);
  }
  const repoVersion = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')).version;
  if (compareVersions(repoVersion, MIGRATION_VERSION) >= 0) {
    return { entry: distEntry, note: `repo dist (v${repoVersion})` };
  }
  const stage = join(WORK, 'cli');
  mkdirSync(stage, { recursive: true });
  cpSync(join(REPO, 'dist'), join(stage, 'dist'), { recursive: true });
  // `"type": "module"` is load-bearing: dist/index.js is ESM and Node resolves
  // module type from the nearest package.json.
  writeFileSync(
    join(stage, 'package.json'),
    `${JSON.stringify({ name: 'dreamcontext', version: MIGRATION_VERSION, type: 'module', private: true }, null, 2)}\n`,
    'utf-8',
  );
  return {
    entry: join(stage, 'dist', 'index.js'),
    note: `staged copy of repo dist at v${MIGRATION_VERSION} (repo package.json is v${repoVersion}, so the 0.23.0 migration could not otherwise fire)`,
  };
}

const CLI = resolveCli();

/** Run the built CLI. `env` extras are merged on top of the isolated base env. */
function dc(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [CLI.entry, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...BASE_ENV, ...env },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { code: r.status ?? -1, stdout, stderr, out: stdout + stderr };
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 60_000, env: BASE_ENV });
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

// ─── Vault + fs helpers ──────────────────────────────────────────────────────

const ctx = (projectRoot) => join(projectRoot, '_dream_context');
const readText = (p) => readFileSync(p, 'utf-8');
const readJson = (p) => JSON.parse(readText(p));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf-8');

/** A git repo with a pinned identity — never this machine's. */
function newRepo(name, identity) {
  const root = join(WORK, name);
  mkdirSync(root, { recursive: true });
  git(['init', '-q'], root);
  git(['config', 'user.name', identity.name], root);
  git(['config', 'user.email', identity.email], root);
  return root;
}

const INIT_ARGS = (name) => [
  'init', '--yes', '--name', name, '--description', 'people-first verify',
  '--stack', 'TypeScript', '--priority', 'verify', '--platforms', 'claude',
];

/** sha256 of every file under `dir`, keyed by relative path, minus volatile state. */
function hashTree(dir) {
  const out = {};
  const keepInState = new Set(['.config.json', '.migrations.json']);
  const walk = (abs) => {
    for (const entry of readdirSync(abs)) {
      const full = join(abs, entry);
      const rel = relative(dir, full);
      if (entry === '.git' || entry === '.obsidian' || entry.endsWith('.lock')) continue;
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      // `state/` is machine-local runtime churn (sleep epoch, version checks) —
      // only the two files this migration actually owns are compared.
      if (rel.startsWith('state/') && !keepInState.has(entry)) continue;
      out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function diffTrees(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed.sort();
}

/** The six-H2 legacy `core/1.user.md` (the retired template) plus a `## People` roster block. */
const LEGACY_SECTIONS = {
  'User Preferences': '- LEGACY-PREF: ships small, reviews in the morning.',
  'Communication Style': '- LEGACY-COMMS: terse, no preamble.',
  'Project Details': '- LEGACY-DETAILS: monorepo, deploys to fly.io.',
  'Project Rules': '- LEGACY-RULES: never force-push main.',
  'Skills & Capabilities': '- LEGACY-SKILLS: TypeScript, Postgres, Terraform.',
  'Workflow Notes': '- LEGACY-WORKFLOW: two approvals before a release cut.',
};
const RESIDUE_TITLES = ['Project Details', 'Project Rules', 'Skills & Capabilities', 'Workflow Notes'];

function legacyUserFile() {
  const body = Object.entries(LEGACY_SECTIONS).map(([title, text]) => `## ${title}\n\n${text}`);
  body.push('## People\n\n- Ada Test (`person:ada-test`)\n- Bob Builder (`person:bob-builder`)');
  return `---\nname: user-preferences\ntype: user\nupdated: "2026-01-01"\n---\n\n${body.join('\n\n')}\n`;
}

/**
 * Build a pre-0.23 vault: a real `init` rolled back to the retired layout, so
 * everything the migration does NOT own (taxonomy, changelog, state) is exactly
 * what a real vault has.
 */
function makeLegacyVault(name) {
  const root = newRepo(name, { name: 'Ada Test', email: 'ada@test.dev' });
  const initRun = dc(INIT_ARGS('Legacy Vault'), root);
  if (initRun.code !== 0) throw new Error(`init failed in ${name}: ${excerpt(initRun.out)}`);
  const c = ctx(root);
  rmSync(join(c, 'people'), { recursive: true, force: true });
  writeFileSync(join(c, 'core', '1.user.md'), legacyUserFile(), 'utf-8');
  const config = readJson(join(c, 'state', '.config.json'));
  config.setupVersion = '0.22.0';
  config.people = ['Ada Test', 'Bob Builder'];
  config.peopleIdentity = { 'ada-test': { clickupMemberId: '4242' } };
  writeJson(join(c, 'state', '.config.json'), config);
  return root;
}

function countHeading(text, title) {
  return text.split('\n').filter((l) => /^##\s+(.+?)\s*$/.test(l) && l.replace(/^##\s+/, '').trim() === title).length;
}

// ─── Steps ───────────────────────────────────────────────────────────────────

let V1 = null;      // the main scratch vault
let MIGRATED = null; // the migrated legacy vault (steps 10-12)

function step1() {
  V1 = newRepo('v1', { name: 'Ada Test', email: 'ada@test.dev' });
  const name = git(['config', 'user.name'], V1).out.trim();
  const email = git(['config', 'user.email'], V1).out.trim();
  check('scratch vault is a git repo with its own identity', name === 'Ada Test' && email === 'ada@test.dev',
    `${V1} → user.name=${name} user.email=${email}; HOME=${FAKE_HOME}`);
}

function step2() {
  const run = dc(INIT_ARGS('People First Verify'), V1);
  check('`init` exits 0', run.code === 0, `exit=${run.code} ${excerpt(run.stdout).slice(0, 140)}`);
  const roster = readJson(join(ctx(V1), 'people', 'people.json'));
  checkEqual('people.json is exactly the git-config person', roster,
    { version: 1, people: { 'ada-test': { name: 'Ada Test', emails: ['ada@test.dev'] } } });
  check('people/ada-test.md exists', existsSync(join(ctx(V1), 'people', 'ada-test.md')),
    join('_dream_context', 'people', 'ada-test.md'));
  check('core/1.user.md does NOT exist', !existsSync(join(ctx(V1), 'core', '1.user.md')),
    'retired slot 1 is not created by init');
}

function step3() {
  const out = dc(['snapshot'], V1).stdout;
  checkContains('snapshot names the active person', out, '## Person (Active — Ada Test, `person:ada-test`)');
  const body = readText(join(ctx(V1), 'people', 'ada-test.md')).trim();
  check('constitution is rendered VERBATIM (no compression)', out.includes(body),
    `${body.length} chars of people/ada-test.md ${out.includes(body) ? 'found intact' : 'NOT found intact'} in the snapshot`);
  checkAbsent('solo vault renders no roster section', out, '## Other People');
}

function step4() {
  const run = dc(['core', 'changelog', 'add', '--type', 'fix', '--scope', 'verify', '--description', 'step 4 stamp'], V1);
  check('`core changelog add` exits 0', run.code === 0, `exit=${run.code} ${excerpt(run.out).slice(0, 120)}`);
  const entry = readJson(join(ctx(V1), 'core', 'CHANGELOG.json'))[0];
  checkEqual('entry is auto-stamped with the active person', entry.authors, ['ada-test']);
}

function step5() {
  const run = dc(['people', 'add', 'Bob Builder', '--email', 'bob@test.dev'], V1);
  check('`people add` exits 0', run.code === 0, `exit=${run.code} ${excerpt(run.out).slice(0, 140)}`);
  const out = dc(['snapshot'], V1).stdout;
  checkContains('multi-person vault renders the roster', out, '## Other People (this vault)');
  const bullets = out.split('\n').filter((l) => /^- \*\*.+\*\* \(`person:[a-z0-9-]+`\)/.test(l));
  checkEqual('exactly one roster bullet (the non-active person)', bullets, ['- **Bob Builder** (`person:bob-builder`)']);
}

function step6() {
  git(['config', 'user.email', 'bob@test.dev'], V1);
  const snap = dc(['snapshot'], V1).stdout;
  checkContains('snapshot follows the git email to Bob', snap, '## Person (Active — Bob Builder, `person:bob-builder`)');
  const who = dc(['people', 'whoami'], V1).stdout;
  checkContains('`people whoami` reports source=git-email', who, 'Source:  git-email');
}

function step7() {
  git(['config', 'user.email', 'nobody@test.dev'], V1);
  const snap = dc(['snapshot'], V1).stdout;
  checkContains('unknown git email renders the UNRESOLVED notice', snap, '## Person (Active — UNRESOLVED)');
  checkAbsent('no constitution body is rendered for an unresolved machine', snap, '## Communication Style');
  const notice = snap.split('## Person (Active — UNRESOLVED)')[1]?.split('\n## ')[0] ?? '';
  const bullets = notice.split('\n').filter((l) => l.startsWith('- '));
  check('exactly one actionable line', bullets.length === 1, `${bullets.length} bullet(s): ${excerpt(bullets.join(' | ')).slice(0, 180)}`);

  const before = readJson(join(ctx(V1), 'core', 'CHANGELOG.json')).length;
  dc(['core', 'changelog', 'add', '--type', 'chore', '--scope', 'verify', '--description', 'step 7 no-guess'], V1);
  const entries = readJson(join(ctx(V1), 'core', 'CHANGELOG.json'));
  check('a new entry was written', entries.length === before + 1, `${before} → ${entries.length} entries`);
  check('unresolved ⇒ NO authors key (never guesses)', !('authors' in entries[0]),
    `entry keys: ${Object.keys(entries[0]).join(', ')}`);
}

function step7b() {
  const hostile = '../core/0.soul.md';
  const snap = dc(['snapshot'], V1, { DREAMCONTEXT_PERSON: hostile }).stdout;
  checkContains('traversal env var still lands on UNRESOLVED', snap, '## Person (Active — UNRESOLVED)');
  checkContains('the reason names the rejected value verbatim', snap, `DREAMCONTEXT_PERSON="${hostile}" rejected`);
  // Non-vacuous by construction: the probe set is asserted non-empty first, so
  // "no soul line appears" can never pass because there was nothing to look for.
  const soulLines = readText(join(ctx(V1), 'core', '0.soul.md'))
    .split('\n').map((l) => l.trim())
    .filter((l) => l.length > 20 && !l.startsWith('#') && !l.startsWith('---'));
  check('soul probe set is non-empty', soulLines.length > 0, `${soulLines.length} distinctive line(s) from core/0.soul.md`);
  const personBlock = snap.split('## Person (Active — UNRESOLVED)')[1]?.split('\n## ')[0] ?? '';
  const leaked = soulLines.filter((l) => personBlock.includes(l));
  check('no soul content is rendered under the Person header', leaked.length === 0,
    leaked.length === 0
      ? `Person block is ${personBlock.trim().length} chars, none of the ${soulLines.length} soul lines in it`
      : `leaked: ${excerpt(leaked[0])}`);
}

function step7c() {
  const run = dc(['people', 'whoami'], V1, { DREAMCONTEXT_PERSON: '../../../../etc/hosts' });
  check('`people whoami` exits 0 on a hostile env var', run.code === 0, `exit=${run.code}`);
  checkContains('source is none', run.stdout, 'Source:  none');
  // `localhost` is in every /etc/hosts — asserted present in the source first so
  // the "did not leak" check cannot pass because the token never existed.
  const hosts = existsSync('/etc/hosts') ? readText('/etc/hosts') : '';
  check('the traversal target is readable and has a distinctive token', hosts.includes('localhost'),
    `/etc/hosts is ${hosts.length} chars and contains "localhost"`);
  check('nothing outside people/ was read into the output', !run.out.includes('localhost'),
    run.out.includes('localhost') ? `/etc/hosts content leaked: ${excerpt(run.out)}` : 'no /etc/hosts content in the whoami output');
}

function step7d() {
  const pinPath = join(ctx(V1), 'state', '.brain-local.json');
  const before = existsSync(pinPath) ? readText(pinPath) : null;
  const run = dc(['people', 'whoami', '--set', '../evil'], V1);
  check('`people whoami --set ../evil` exits non-zero', run.code !== 0, `exit=${run.code}`);
  checkContains('the rejection is a typed message, not a stack trace', run.out, 'Invalid person slug');
  check('no stack trace escaped', !looksLikeStackTrace(run.out), excerpt(run.out).slice(0, 160));
  const after = existsSync(pinPath) ? readText(pinPath) : null;
  check('.brain-local.json is unchanged', before === after, `before=${before === null ? '(absent)' : truncate(oneLine(before), 80)} after=${after === null ? '(absent)' : truncate(oneLine(after), 80)}`);
}

function step8() {
  const run = dc(['people', 'whoami'], V1, { DREAMCONTEXT_PERSON: 'bob-builder' });
  checkContains('explicit env var wins the ladder', run.stdout, 'Source:  env');
  checkContains('and resolves to that person', run.stdout, 'bob-builder');
}

function step9() {
  const run = dc(['people', 'whoami', '--set', 'ada-test'], V1);
  check('`whoami --set` exits 0', run.code === 0, `exit=${run.code} ${excerpt(run.stdout).slice(0, 120)}`);
  checkContains('the pin resolves', run.stdout, 'Source:  pin');
  const pin = readJson(join(ctx(V1), 'state', '.brain-local.json'));
  checkEqual('.brain-local.json holds the binding', pin.activePersonSlug, 'ada-test');
  const roster = readText(join(ctx(V1), 'people', 'people.json'));
  checkAbsent('machine identity is NOT written into the synced roster', roster, 'activePersonSlug');

  // The machine-local excludes are laid by `brain enable` (the code path that
  // owns them), so enable → assert → disable rather than assume a fresh vault
  // already carries them.
  dc(['brain', 'enable'], V1);
  const ignored = git(['check-ignore', '-v', '_dream_context/state/.brain-local.json'], V1);
  check('git check-ignore covers .brain-local.json once sync is on', ignored.code === 0, oneLine(ignored.out) || `exit=${ignored.code}`);
  dc(['brain', 'disable'], V1);
}

function step9b() {
  const configPath = join(ctx(V1), 'state', '.config.json');
  const peoplePath = join(ctx(V1), 'people', 'people.json');
  for (const args of [['config', 'people', 'A,B'], ['config', 'people', '--clear']]) {
    const beforeConfig = readText(configPath);
    const beforePeople = readText(peoplePath);
    const run = dc(args, V1);
    const label = `\`${args.join(' ')}\``;
    check(`${label} exits 1`, run.code === 1, `exit=${run.code}`);
    checkContains(`${label} prints the redirect`, run.out, 'moved in 0.23.0');
    checkContains(`${label} names the new home`, run.out, 'people/people.json');
    check(`${label} writes NOTHING`, readText(configPath) === beforeConfig && readText(peoplePath) === beforePeople,
      '.config.json and people/people.json are byte-identical before/after');
  }
}

function step10pre() {
  MIGRATED = makeLegacyVault('legacy');
  const run = dc(['doctor'], MIGRATED);
  check('pre-migration `doctor` exits 0 (the CLI-ahead-of-brain window must not hard-fail)', run.code === 0, `exit=${run.code}`);
  checkContains('and warns about the retired layout', run.out, 'retired layout');
  check('no stack trace', !looksLikeStackTrace(run.out), 'doctor output carries no `at …:line:col` frames');
}

function step10preB() {
  const cases = [
    ['zero-people', '{\n  "version": 1,\n  "people": {}\n}\n', 'lists no people'],
    ['truncated', '{\n  "version": 1,\n  "people": {"ada-test": {"name": "Ada Test",\n', 'could not be read'],
  ];
  for (const [label, content, expected] of cases) {
    const root = newRepo(`broken-${label}`, { name: 'Ada Test', email: 'ada@test.dev' });
    const initRun = dc(INIT_ARGS(`Broken ${label}`), root);
    if (initRun.code !== 0) { check(`${label}: init succeeded`, false, excerpt(initRun.out)); continue; }
    writeFileSync(join(ctx(root), 'people', 'people.json'), content, 'utf-8');
    const run = dc(['doctor'], root);
    check(`${label} people.json ⇒ doctor exits non-zero`, run.code !== 0, `exit=${run.code}`);
    checkContains(`${label} people.json ⇒ a message, not silence`, run.out, expected);
    check(`${label} people.json ⇒ NOT a stack trace`, !looksLikeStackTrace(run.out), excerpt(run.out).slice(0, 200));
  }
}

function step10() {
  const c = ctx(MIGRATED);
  const before = dc(['snapshot'], MIGRATED).stdout;
  checkContains('pre-migration snapshot uses the legacy header (D15)', before, '## User (Preferences, Project Details, Rules)');
  checkContains('…with exactly one deprecation line', before, '> ⚠️ Retired layout — run `dreamcontext update` to migrate to `people/`.');

  const sleep = dc(['sleep', 'start'], MIGRATED);
  check('`sleep start` exits 0 and runs the migration', sleep.code === 0, `exit=${sleep.code} ${excerpt(sleep.out).slice(0, 200)}`);
  checkContains('the migration reports itself', sleep.out, 'Migration 0.23.0/split-user-file');

  const roster = readJson(join(c, 'people', 'people.json'));
  checkEqual('roster holds both config names', Object.keys(roster.people).sort(), ['ada-test', 'bob-builder']);

  const constitution = readText(join(c, 'people', 'ada-test.md'));
  checkContains('owner constitution gained Preferences', constitution, '## Preferences');
  checkContains('…with the legacy body', constitution, LEGACY_SECTIONS['User Preferences']);
  checkContains('owner constitution gained Communication Style', constitution, '## Communication Style');
  checkContains('…with the legacy body', constitution, LEGACY_SECTIONS['Communication Style']);

  const residuePath = join(c, 'inbox', '1.user-residue.md');
  check('residue file exists', existsSync(residuePath), relative(MIGRATED, residuePath));
  const residue = existsSync(residuePath) ? readText(residuePath) : '';
  for (const title of RESIDUE_TITLES) {
    checkContains(`residue holds "${title}" verbatim`, residue, `## ${title}\n\n${LEGACY_SECTIONS[title]}`);
  }
  const union = `${residue}\n${constitution}`;
  const lost = Object.values(LEGACY_SECTIONS).filter((body) => !union.includes(body));
  check('nothing was discarded (residue ∪ constitution ⊇ every H2 body)', lost.length === 0,
    lost.length === 0 ? `all ${Object.keys(LEGACY_SECTIONS).length} section bodies accounted for` : `missing: ${lost.join(' | ')}`);

  check('core/1.user.md is gone', !existsSync(join(c, 'core', '1.user.md')), 'core/1.user.md deleted after both writes succeeded');
  const config = readJson(join(c, 'state', '.config.json'));
  check('.config.json has no `people` key', !('people' in config), `config keys: ${Object.keys(config).join(', ')}`);
  checkEqual('…and peopleIdentity is intact', config.peopleIdentity, { 'ada-test': { clickupMemberId: '4242' } });

  const pending = dc(['migrations', 'pending'], MIGRATED);
  checkContains('`migrations pending` lists the agent task', pending.out, 'distribute-user-md-residue');
  checkContains('…with the exact record command', pending.out,
    'dreamcontext migrations record --version 0.23.0 --step distribute-user-md-residue --executor agent --summary');
}

function step10b() {
  // Crash-resume: a run that appended the constitution but died before the
  // unlink. Re-running must append nothing and finish the delete.
  const root = join(WORK, 'legacy-resume');
  cpSync(MIGRATED, root, { recursive: true });
  const c = ctx(root);
  writeFileSync(join(c, 'core', '1.user.md'), legacyUserFile(), 'utf-8');
  const run = dc(['sleep', 'start', '--force'], root);
  check('resumed `sleep start` exits 0', run.code === 0, `exit=${run.code} ${excerpt(run.out).slice(0, 160)}`);

  const constitution = readText(join(c, 'people', 'ada-test.md'));
  checkEqual('constitution has exactly one `## Preferences`', countHeading(constitution, 'Preferences'), 1);
  checkEqual('constitution has exactly one `## Communication Style`', countHeading(constitution, 'Communication Style'), 1);
  const residue = readText(join(c, 'inbox', '1.user-residue.md'));
  checkEqual('residue has exactly one `## Project Rules`', countHeading(residue, 'Project Rules'), 1);
  check('core/1.user.md deleted on the resumed run', !existsSync(join(c, 'core', '1.user.md')), 'the delete completed');
}

function step11() {
  // (a) Re-running the migration changes nothing on disk.
  const before = hashTree(ctx(MIGRATED));
  const run = dc(['sleep', 'start', '--force'], MIGRATED);
  check('re-run `sleep start --force` exits 0', run.code === 0, `exit=${run.code}`);
  const changed = diffTrees(before, hashTree(ctx(MIGRATED)));
  check('the vault tree is byte-identical after a re-run', changed.length === 0,
    changed.length === 0 ? `${Object.keys(before).length} files unchanged (state/ runtime excluded)` : `changed: ${changed.join(', ')}`);

  // (b) Every step self-reports `detected` with zero filesTouched. The ledger
  // de-dups appends, so this is observed on a copy with the ledger removed —
  // the steps themselves are re-run against the already-migrated tree either way.
  const replay = join(WORK, 'legacy-replay');
  cpSync(MIGRATED, replay, { recursive: true });
  rmSync(join(ctx(replay), 'state', '.migrations.json'), { force: true });
  const replayRun = dc(['sleep', 'start', '--force'], replay);
  check('replay `sleep start --force` exits 0', replayRun.code === 0, `exit=${replayRun.code}`);
  const ledger = readJson(join(ctx(replay), 'state', '.migrations.json'));
  const steps = ledger.filter((e) => e.version === '0.23.0');
  checkEqual('all four 0.23.0 steps ran', steps.map((e) => e.step).sort(),
    ['rescale-legacy-sleep-debt', 'retire-config-roster', 'seed-people-from-config', 'split-user-file']);
  const notDetected = steps.filter((e) => e.executor !== 'detected');
  check('every step reports `detected`', notDetected.length === 0,
    notDetected.length === 0 ? 'executor=detected ×4' : `not detected: ${notDetected.map((e) => `${e.step}=${e.executor}`).join(', ')}`);
  const touched = steps.filter((e) => (e.filesTouched ?? []).length > 0);
  check('…with zero filesTouched', touched.length === 0,
    touched.length === 0 ? 'filesTouched=[] ×4' : touched.map((e) => `${e.step}→${e.filesTouched.join(',')}`).join('; '));
}

function step12() {
  const run = dc(['doctor'], MIGRATED);
  check('post-migration `doctor` exits 0', run.code === 0, `exit=${run.code} ${excerpt(run.out).slice(0, 240)}`);
  checkContains('…and reports the people layout', run.out, 'each with a constitution');
  checkAbsent('…with no retired-layout warning left', run.out, 'retired layout');
}

// ─── Step 13: the real dashboard server ──────────────────────────────────────

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function waitForHealth(port, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function step13() {
  const port = await freePort();
  const server = spawn(process.execPath, [CLI.entry, 'dashboard', '--no-open', '-p', String(port), '--host', '127.0.0.1'], {
    cwd: V1, env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    const up = await waitForHealth(port, 20_000);
    check('dashboard server is up', up, up ? `http://127.0.0.1:${port} (cwd=${V1})` : `never answered /api/health: ${excerpt(serverLog)}`);
    if (!up) return;

    const list = await fetch(`http://127.0.0.1:${port}/api/core/people`);
    const listBody = await list.json();
    check('GET /api/core/people → 200', list.status === 200, `status=${list.status}`);
    checkEqual('…lists both people', (listBody.people ?? []).map((p) => p.slug).sort(), ['ada-test', 'bob-builder']);
    checkEqual('…and badges the active one', listBody.activeSlug, 'ada-test');
    check('…with the resolution source', listBody.source === 'pin', `source=${listBody.source}`);

    const personPath = join(ctx(V1), 'people', 'ada-test.md');
    const original = readText(personPath);
    const edited = `${original.trimEnd()}\n\n## Verify Marker\n\n- written by verify:people step 13\n`;
    const put = await fetch(`http://127.0.0.1:${port}/api/core/people/ada-test`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: edited }),
    });
    const putBody = await put.json();
    check('PUT /api/core/people/ada-test → 200 {ok:true}', put.status === 200 && putBody.ok === true, `status=${put.status} body=${JSON.stringify(putBody)}`);
    check('…and the constitution is written verbatim to disk', readText(personPath) === edited, 'people/ada-test.md matches the PUT body byte-for-byte');

    const restore = await fetch(`http://127.0.0.1:${port}/api/core/people/ada-test`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: original }),
    });
    check('…and the original content restores cleanly', restore.status === 200 && readText(personPath) === original, `status=${restore.status}`);

    const probe = await fetch(`http://127.0.0.1:${port}/api/core/people/..%2f..%2fcore%2f0.soul.md`);
    const probeText = await probe.text();
    check('traversal probe ..%2f..%2fcore%2f0.soul.md → 400', probe.status === 400, `status=${probe.status}`);
    checkAbsent('…and leaks no soul content', probeText, '0.soul');
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (!server.killed) server.kill('SIGKILL');
  }
}

function step14() {
  const peer = newRepo('peer', { name: 'Cleo Peer', email: 'cleo@peer.dev' });
  const initRun = dc(INIT_ARGS('Peer Vault'), peer);
  check('peer vault initialized', initRun.code === 0, `exit=${initRun.code}`);
  dc(['people', 'add', 'Dana Peer', '--email', 'dana@peer.dev'], peer);

  const local = dc(['snapshot'], peer).stdout;
  check('the peer vault DOES render a person block locally', local.includes('## Person (Active'),
    'sanity: suppression below is the --vault branch, not an empty vault');

  const run = dc(['snapshot', '--vault', peer], V1);
  check('`snapshot --vault <peer>` exits 0', run.code === 0, `exit=${run.code}`);
  check('…and renders something', run.stdout.includes('# Agent Context'), `${run.stdout.length} chars`);
  checkAbsent('…with NO person block (D14)', run.stdout, '## Person (Active');
  checkAbsent('…and NO roster block (D14)', run.stdout, '## Other People');
}

function step15() {
  const run = dc(['memory', 'recall', 'ada-test', '--types', 'changelog', '--json'], V1);
  check('`memory recall … --types changelog` exits 0', run.code === 0, `exit=${run.code}`);
  let hits = [];
  try { hits = JSON.parse(run.stdout).hits ?? []; } catch { /* reported below */ }
  check('the stamped slug is recallable (≥1 changelog hit)', hits.length >= 1,
    hits.length >= 1 ? `${hits.length} hit(s), top=${hits[0].slug} score=${hits[0].score}` : `no hits — stdout: ${excerpt(run.stdout).slice(0, 200)}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('people-first e2e verification');
  console.log(`  CLI:  ${CLI.entry}`);
  console.log(`        ${CLI.note}`);
  console.log(`  HOME: ${FAKE_HOME} (isolated)`);
  console.log(`  work: ${WORK}`);

  step('1', 'scratch vault + pinned git identity', step1);
  step('2', 'init produces people/, not core/1.user.md', step2);
  step('3', 'snapshot renders the constitution verbatim', step3);
  step('4', 'changelog add auto-stamps the active person', step4);
  step('5', 'a second person turns on the roster block', step5);
  step('6', 'git email switches the active person', step6);
  step('7', 'an unknown git email resolves to nothing — and guesses nothing', step7);
  step('7b', 'a traversal DREAMCONTEXT_PERSON is rejected, and says so', step7b);
  step('7c', 'a traversal env var never reads outside people/', step7c);
  step('7d', 'whoami --set rejects a hostile slug before writing', step7d);
  step('8', 'DREAMCONTEXT_PERSON is rung 1', step8);
  step('9', 'the machine pin lives in .brain-local.json only', step9);
  step('9b', 'config people is a redirect with no write path', step9b);
  step('10-pre', 'a legacy vault passes doctor (migration window)', step10pre);
  step('10-pre-b', 'an empty or corrupt roster fails doctor with a message', step10preB);
  step('10', 'sleep start migrates a legacy vault', step10);
  step('10b', 'the split resumes safely after a crash', step10b);
  step('11', 'the migration is idempotent', step11);
  step('12', 'the migrated vault passes doctor', step12);
  currentStep = { id: '13', title: 'dashboard people routes' };
  console.log('\n── Step 13 — dashboard people routes');
  try { await step13(); } catch (err) { record(false, 'step 13 threw before finishing', err instanceof Error ? (err.stack ?? err.message) : String(err)); }
  currentStep = null;
  step('14', 'a peer render suppresses person + roster', step14);
  step('15', 'the stamped slug is recallable', step15);

  const byStep = new Map();
  for (const r of results) {
    const agg = byStep.get(r.step) ?? { title: r.title, pass: 0, fail: 0 };
    agg[r.ok ? 'pass' : 'fail']++;
    byStep.set(r.step, agg);
  }
  const failed = results.filter((r) => !r.ok);

  console.log('\n─── Summary ─────────────────────────────────────────────────');
  for (const [id, agg] of byStep) {
    const verdict = agg.fail === 0 ? 'PASS' : 'FAIL';
    console.log(`  ${verdict}  step ${id.padEnd(9)} ${String(agg.pass).padStart(2)} ok / ${agg.fail} failed  — ${agg.title}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed across ${byStep.size} steps.`);
  if (failed.length > 0) {
    console.log('\n  Failures:');
    for (const f of failed) console.log(`   • [${f.step}] ${f.label} — ${oneLine(f.evidence)}`);
  }

  // The workspace is kept on failure — the vaults ARE the evidence.
  if (failed.length === 0) {
    rmSync(WORK, { recursive: true, force: true });
  } else {
    console.log(`\n  Scratch vaults kept for inspection: ${WORK}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify:people crashed:', err);
  console.error(`Scratch vaults kept for inspection: ${WORK}`);
  process.exit(2);
});
