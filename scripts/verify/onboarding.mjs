#!/usr/bin/env node
/**
 * First-run onboarding, verified end to end against the REAL built server and the REAL
 * dashboard UI.
 *
 *   npm run build && npm run verify:onboarding            # every row
 *   node scripts/verify/onboarding.mjs --rows S1,S10      # a subset
 *
 * WHAT IT DRIVES. For each row of the plan's browser verify matrix (S1-S14, S8b) it builds a
 * fresh fake HOME, boots `dist/index.js dashboard --launcher` on its own port, and drives the
 * Launcher in Chromium. Assertions are made against the UI, the server's own routes, and the
 * files the product writes (shell profile lines, `.git/`, `vaults.json`, `.secrets.json`).
 *
 * WHAT IT NEVER TOUCHES. The developer's ~/.dreamcontext, ~/.claude, credentials and network:
 *  - HOME is a scratch folder and the server gets a CLEAN environment (no inherited tokens).
 *  - SHELL is /bin/bash, whose login profile in the fake HOME sets a PATH made only of
 *    stand-ins (fixtures/onboarding: npm, brew, gh, xcode-select, claude) plus /bin and
 *    /usr/sbin. /usr/bin is left out on purpose: that is where the real git and Apple's
 *    developer-tools shims live, so "git is missing" can be true on a Mac that has it.
 *  - The server runs on a COPY of node in a folder with nothing beside it, so no real npm or
 *    global dreamcontext is found next to the running node.
 *  - The network probe and the Claude installer come from a tiny loopback server through the
 *    product's own test seams (DREAMCONTEXT_ONBOARDING_PROBE_URL,
 *    DREAMCONTEXT_CLAUDE_INSTALLER_URL), which it only honours for http://127.0.0.1.
 *  - npm installs land in a scratch NPM_CONFIG_PREFIX; GitHub sign-in is always the
 *    "import from the signed-in gh stand-in" path, never the device flow.
 *
 * FAILURE POLICY. Collect, don't fail fast: every row runs, prints PASS/FAIL with its
 * evidence, and saves a screenshot to tmp/verify/onboarding/<row>.png. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(REPO, 'scripts', 'verify', 'fixtures', 'onboarding');
const ROOT = join(tmpdir(), 'dreamcontext-verify-onboarding');
const SHOTS = join(REPO, 'tmp', 'verify', 'onboarding');
const DIST = join(REPO, 'dist', 'index.js');
const NODE_RUNTIME = join(ROOT, 'node-runtime', 'bin');
const NODE = join(NODE_RUNTIME, 'node');

/** The kickoff prompt the hand-off must deliver, read from the shared copy so it cannot drift. */
function kickoffPrompt() {
  const src = readFileSync(join(REPO, 'src', 'lib', 'onboarding', 'copy.ts'), 'utf-8');
  const m = /export const INITIALIZER_KICKOFF_PROMPT =\s*([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error('INITIALIZER_KICKOFF_PROMPT not found in copy.ts');
  // The constant is a `+`-joined run of string literals; evaluate only those literals.
  const parts = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((p) => (p[1] ?? p[2]).replace(/\\'/g, "'"));
  return parts.join('');
}

const TITLES = {
  node: 'Node.js',
  cli: 'dreamcontext in Terminal',
  claude: 'Claude',
  'claude-auth': 'Claude sign-in',
  git: 'Git',
  github: 'GitHub',
  gh: 'GitHub tools for Claude',
};

// ─── Small utilities ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitFor(pred, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await pred(); } catch { v = false; }
    if (v) return v;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

function readText(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

function writeExec(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** A node binary with nothing beside it: no real npm, no global dreamcontext next to it. */
function ensureNodeRuntime() {
  mkdirSync(NODE_RUNTIME, { recursive: true });
  const src = process.execPath;
  if (!existsSync(NODE) || statSync(NODE).size !== statSync(src).size) {
    copyFileSync(src, NODE);
    chmodSync(NODE, 0o755);
  }
}

// ─── The loopback seam server (network probe + Claude installer) ──────────────────────

const seam = {
  offline: false,
  installerFetches: 0,
  server: null,
  port: 0,
};

const INSTALLER = `#!/bin/bash
# Stand-in for Anthropic's install.sh, served by scripts/verify/onboarding.mjs.
set -e
mkdir -p "$HOME/.local/bin"
cp "$HOME/.verify/claude-standin" "$HOME/.local/bin/claude"
chmod 755 "$HOME/.local/bin/claude"
printf 'installer\\trun\\n' >> "$HOME/.verify/log"
echo "Claude Code installed to $HOME/.local/bin/claude"
`;

async function startSeamServer() {
  seam.port = await freePort();
  seam.server = createHttpServer((req, res) => {
    if (req.url?.startsWith('/probe')) {
      if (seam.offline) { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url?.startsWith('/claude-install.sh')) {
      seam.installerFetches += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(INSTALLER);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => seam.server.listen(seam.port, '127.0.0.1', r));
}

// ─── A fake machine ───────────────────────────────────────────────────────────────────

/**
 * Build one row's fake HOME. Options describe the machine:
 *   nodeOnPath   the running node is on the login PATH already
 *   cli          `dreamcontext` is on the login PATH
 *   claude       'none' | 'offpath' (in ~/.local/bin, not on PATH) | 'onpath'
 *   claudeAuth   signed in
 *   git          git + developer tools present
 *   gh           'none' | 'authed' | 'unauthed'
 *   githubToken  dreamcontext's own GitHub sign-in is stored
 */
function makeMachine(row, o) {
  const base = join(ROOT, row);
  rmSync(base, { recursive: true, force: true });
  const home = join(base, 'home');
  const v = join(home, '.verify');
  const tools = join(v, 'tools');
  const fixtures = join(v, 'fixtures');
  const npmPrefix = join(base, 'npm-prefix');
  mkdirSync(tools, { recursive: true });
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  mkdirSync(join(npmPrefix, 'bin'), { recursive: true });
  writeFileSync(join(v, 'log'), '');

  for (const f of ['npm', 'brew', 'gh', 'xcode-select']) writeExec(join(fixtures, f), readFileSync(join(FIXTURES, f), 'utf-8'));
  for (const f of ['npm', 'brew', 'xcode-select']) writeExec(join(tools, f), readFileSync(join(FIXTURES, f), 'utf-8'));
  // The facts script asks `uname` whether this is a Mac; it lives in /usr/bin, which is off PATH.
  symlinkSync('/usr/bin/uname', join(tools, 'uname'));

  writeExec(join(v, 'claude-standin'), `#!/bin/sh\nexec '${process.execPath}' '${join(FIXTURES, 'claude.mjs')}' "$@"\n`);
  writeFileSync(join(v, 'claude-auth.json'), JSON.stringify({ loggedIn: !!o.claudeAuth }));
  if (o.claude === 'offpath' || o.claude === 'onpath') {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeExec(join(home, '.local', 'bin', 'claude'), readFileSync(join(v, 'claude-standin'), 'utf-8'));
  }
  if (o.cli) writeExec(join(npmPrefix, 'bin', 'dreamcontext'), '#!/bin/sh\necho 0.0.0-verify\n');
  if (o.git) setGitInstalled(home, true);
  if (o.gh !== 'none' && o.gh) writeExec(join(tools, 'gh'), readFileSync(join(FIXTURES, 'gh'), 'utf-8'));
  if (o.gh === 'authed' || o.ghStateAuthed) writeFileSync(join(v, 'gh-authed'), '');
  if (o.githubToken) {
    writeFileSync(join(home, '.dreamcontext', '.secrets.json'),
      JSON.stringify({ github: { token: 'gho_verifyStoredToken', login: 'verify-user' } }, null, 2), { mode: 0o600 });
  }

  const pathParts = [tools, join(npmPrefix, 'bin')];
  if (o.claude === 'onpath') pathParts.push('$HOME/.local/bin');
  if (o.nodeOnPath) pathParts.push(NODE_RUNTIME);
  pathParts.push('/bin', '/usr/sbin', '/sbin');
  writeFileSync(join(home, '.bash_profile'), [
    '# Fake login profile written by scripts/verify/onboarding.mjs.',
    `export PATH="${pathParts.join(':')}"`,
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
    '',
  ].join('\n'));

  for (const vault of o.vaults ?? []) {
    const dir = join(base, vault);
    mkdirSync(join(dir, '_dream_context'), { recursive: true });
    registerVault(home, vault, dir);
  }
  return { base, home, v, tools, npmPrefix };
}

function setGitInstalled(home, on) {
  const tools = join(home, '.verify', 'tools');
  const link = join(tools, 'git');
  if (on) {
    if (!existsSync(link)) symlinkSync('/usr/bin/git', link);
    writeFileSync(join(home, '.verify', 'clt'), '');
  } else {
    rmSync(link, { force: true });
    rmSync(join(home, '.verify', 'clt'), { force: true });
  }
}

function registerVault(home, name, dir) {
  const r = spawnSync(process.execPath, [DIST, 'vaults', 'add', name, dir], {
    env: { HOME: home, PATH: '/bin:/usr/bin', DREAMCONTEXT_EMBED_AUTO: '0' }, encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`vaults add ${name} failed: ${r.stderr || r.stdout}`);
}

function logLines(m) {
  return readText(join(m.v, 'log')).split('\n').filter(Boolean);
}

function readVaults(home) {
  try {
    const raw = JSON.parse(readFileSync(join(home, '.dreamcontext', 'vaults.json'), 'utf-8'));
    return Array.isArray(raw) ? raw : (raw.vaults ?? []);
  } catch { return []; }
}

/** Every shell-profile line onboarding wrote (each sits under a `# dreamcontext:` marker). */
function markerLines(home) {
  return ['.bash_profile', '.bashrc', '.profile', '.zshrc']
    .flatMap((f) => readText(join(home, f)).split('\n'))
    .filter((l) => l.startsWith('# dreamcontext:'));
}

// ─── The server ───────────────────────────────────────────────────────────────────────

async function startServer(m, { desktop = true } = {}) {
  const port = await freePort();
  const env = {
    HOME: m.home,
    USER: process.env.USER || 'verify',
    LOGNAME: process.env.LOGNAME || 'verify',
    TMPDIR: process.env.TMPDIR || '/tmp',
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/bash',
    PATH: [m.tools, '/bin', '/usr/sbin', '/sbin'].join(':'),
    NPM_CONFIG_PREFIX: m.npmPrefix,
    DREAMCONTEXT_ONBOARDING_PROBE_URL: `http://127.0.0.1:${seam.port}/probe`,
    DREAMCONTEXT_CLAUDE_INSTALLER_URL: `http://127.0.0.1:${seam.port}/claude-install.sh`,
    DREAMCONTEXT_EMBED_AUTO: '0',
    DREAMCONTEXT_INITIALIZER_HOOK: '0',
    ...(desktop ? { DREAMCONTEXT_DESKTOP: '1' } : {}),
  };
  const srv = spawn(NODE, [DIST, 'dashboard', '--no-open', '-p', String(port), '--launcher'], {
    cwd: m.home, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (c) => { log += c.toString(); });
  srv.stderr.on('data', (c) => { log += c.toString(); });
  const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok, 30_000, 300);
  if (!up) {
    srv.kill('SIGKILL');
    throw new Error(`dashboard server did not come up:\n${log.slice(-1500)}`);
  }
  return { port, base: `http://127.0.0.1:${port}`, proc: srv, log: () => log };
}

async function stopServer(s) {
  if (!s) return;
  s.proc.kill('SIGTERM');
  await waitFor(() => s.proc.exitCode !== null || s.proc.signalCode !== null, 5000, 100);
  if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill('SIGKILL');
}

async function readiness(s, fresh = true) {
  const r = await fetch(`${s.base}/api/onboarding/readiness${fresh ? '?fresh=1' : ''}`);
  return r.json();
}

function check(report, id) {
  return report.checks.find((c) => c.id === id);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────────────

function row(page, title) {
  return page.locator('.ob-row').filter({ has: page.locator('.ob-row-title').getByText(title, { exact: true }) });
}

async function rowIsDone(page, title) {
  const cls = (await row(page, title).getAttribute('class').catch(() => '')) ?? '';
  return cls.includes('ob-row--done');
}

/**
 * Open the Launcher. With no projects the takeover opens on the Welcome screen first, so by
 * default this clicks through it and records whether it was there (`page.welcomeShown`). Rows
 * that start WITH a project pass `{ welcome: false }`: no takeover, so no Welcome to wait for.
 */
async function openLauncher(ctx, s, { welcome = true, shotAs = null } = {}) {
  const page = await ctx.newPage();
  await page.goto(`${s.base}/`, { waitUntil: 'domcontentloaded' });
  if (welcome) {
    const start = page.getByRole('button', { name: 'Get started', exact: true });
    page.welcomeShown = await start.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    if (page.welcomeShown) {
      if (shotAs) { await sleep(1500); await shot(page, shotAs); }
      await start.click();
    }
  }
  return page;
}

async function shot(page, rowId) {
  try { await page.screenshot({ path: join(SHOTS, `${rowId}.png`), fullPage: false }); } catch { /* page gone */ }
}

/** Answer the browser-mode folder prompt (`openFolderPicker` falls back to window.prompt). */
function answerPrompts(page, path) {
  page.on('dialog', (d) => { void d.accept(path); });
}

/** A machine where every required and recommended check passes. */
const READY = { nodeOnPath: true, cli: true, claude: 'onpath', claudeAuth: true, git: true, gh: 'authed', githubToken: true };

/** From the takeover's This Mac step to the Project step (auto-advance or Continue). */
async function reachProjectStep(page, { allowContinue = true } = {}) {
  const project = page.getByRole('heading', { name: 'Add your project' });
  const ok = await waitFor(async () => {
    if (await project.isVisible()) return true;
    const cont = page.getByRole('button', { name: 'Continue', exact: true });
    if (allowContinue && await cont.isVisible()) await cont.click();
    return false;
  }, allowContinue ? 30_000 : 90_000, 400);
  return !!ok;
}

async function createProject(page, name) {
  await page.getByRole('button', { name: /Create new/ }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  return page.getByRole('heading', { name: `“${name}” is ready` }).waitFor({ timeout: 60_000 }).then(() => true, () => false);
}

async function openFolder(page, path) {
  answerPrompts(page, path);
  await page.getByRole('button', { name: /Open a folder/ }).click();
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
}

// ─── Rows ─────────────────────────────────────────────────────────────────────────────
//
// Each row returns { pass, evidence: string[] }. `ctx` is a fresh browser context.

const ROWS = {
  /** Fresh machine: "Set everything up" walks the whole plan, git first, and lands on Project. */
  async S1(ctx) {
    const m = makeMachine('S1', { nodeOnPath: false, cli: false, claude: 'none', claudeAuth: false, git: false, gh: 'none' });
    // gh arrives through the brew stand-in already signed in, so the GitHub row takes the
    // import path (no device flow, no network).
    writeFileSync(join(m.v, 'gh-authed'), '');
    const s = await startServer(m);
    const ev = [];
    try {
      const before = await readiness(s);
      const plan = before.plan;
      ev.push(`initial plan: ${plan.join(' > ')}`);
      const missing = ['node', 'cli', 'claude', 'git', 'gh'].filter((id) => check(before, id)?.status !== 'ok');
      const page = await openLauncher(ctx, s, { shotAs: 'S1-welcome' });
      ev.push(`welcome shown first: ${page.welcomeShown}`);
      const setUp = page.getByRole('button', { name: 'Set everything up' });
      await setUp.waitFor({ timeout: 20_000 });
      await setUp.click();
      const gitWait = await waitFor(async () => (await row(page, TITLES.git).textContent())?.includes('Installing in the background'), 20_000);
      ev.push(`git row reads "Installing in the background": ${!!gitWait}`);
      const card = await page.getByText('Finish signing in in your browser').waitFor({ timeout: 90_000 }).then(() => true, () => false);
      ev.push(`sign-in card shown: ${card}`);
      await shot(page, 'S1-signin');
      const signedIn = await waitFor(() => rowIsDone(page, TITLES['claude-auth']), 30_000);
      ev.push(`Claude sign-in row resolved: ${!!signedIn}`);
      // No Continue click: the step must move on by itself once the plan is done.
      const onProject = await reachProjectStep(page, { allowContinue: false });
      ev.push(`auto-advanced to Project: ${onProject}`);
      await shot(page, 'S1');
      const lines = logLines(m);
      const idx = (re) => lines.findIndex((l) => re.test(l));
      const order = {
        xcode: idx(/^xcode-select\t--install/),
        npm: idx(/^npm\t.*install -g dreamcontext/),
        installer: idx(/^installer\trun/),
        login: idx(/^claude\tlogin\t/),
        brew: idx(/^brew\tinstall gh/),
      };
      ev.push(`log order: ${JSON.stringify(order)}`);
      const after = await readiness(s);
      ev.push(`after: ${after.checks.map((c) => `${c.id}=${c.status}`).join(' ')}`);
      const secrets = readText(join(m.home, '.dreamcontext', '.secrets.json'));
      const pass = page.welcomeShown && plan[0] === 'git-install' && missing.length === 5 && !!gitWait && card && !!signedIn && onProject
        && order.xcode >= 0 && order.xcode < order.npm && order.npm < order.installer && order.installer < order.login
        && order.login < order.brew && after.ready === true && /verify-user/.test(secrets);
      return { pass, evidence: ev };
    } finally {
      setGitInstalled(m.home, true);
      await stopServer(s);
    }
  },

  /** Offline: banner, fix buttons disabled; recovers on its own once the probe answers. */
  async S2(ctx) {
    const m = makeMachine('S2', { ...READY, claudeAuth: false });
    seam.offline = true;
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      const banner = page.getByText("You're offline. We'll carry on when you're back.");
      const shown = await banner.waitFor({ timeout: 20_000 }).then(() => true, () => false);
      const setUp = page.getByRole('button', { name: 'Set everything up' });
      // Offline, every fix that needs the network is blocked: "Set everything up" is either
      // not offered or disabled, and no row offers an enabled fix button.
      const enabledActions = () => page.evaluate(() => [...document.querySelectorAll('.ob-checklist button.ob-btn--primary, .ob-row .ob-btn--secondary')]
        .filter((b) => !b.disabled).map((b) => b.textContent));
      const offlineActions = shown ? await enabledActions() : ['(no banner)'];
      const disabled = offlineActions.length === 0;
      ev.push(`offline banner: ${shown}; enabled fix actions while offline: ${JSON.stringify(offlineActions)}`);
      await shot(page, 'S2');
      seam.offline = false;
      const t0 = Date.now();
      const back = await banner.waitFor({ state: 'hidden', timeout: 15_000 }).then(() => true, () => false);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      ev.push(`banner gone after ${secs}s (bound 6s in the plan, 15s allowed here): ${back}`);
      const enabled = back && await setUp.waitFor({ timeout: 10_000 }).then(() => setUp.isEnabled(), () => false);
      ev.push(`Set everything up enabled again: ${enabled}`);
      return { pass: shown && disabled && back && enabled && Number(secs) <= 6, evidence: ev };
    } finally {
      seam.offline = false;
      await stopServer(s);
    }
  },

  /** Claude installed but off PATH: one marker line written; a second run writes nothing. */
  async S3(ctx) {
    const m = makeMachine('S3', { ...READY, claude: 'offpath' });
    const s = await startServer(m);
    const ev = [];
    try {
      const before = check(await readiness(s), 'claude');
      ev.push(`claude before: ${before?.status}/${before?.reason} fix=${before?.fix?.id}`);
      const page = await openLauncher(ctx, s);
      const btn = row(page, TITLES.claude).getByRole('button', { name: 'Make it available in Terminal' });
      await btn.waitFor({ timeout: 20_000 });
      await btn.click();
      const done = await waitFor(() => rowIsDone(page, TITLES.claude), 30_000);
      const linesAfterFirst = markerLines(m.home);
      ev.push(`row resolved: ${!!done}; marker lines: ${JSON.stringify(linesAfterFirst)}`);
      await shot(page, 'S3');
      const second = await page.request.post(`${s.base}/api/onboarding/fix`, { data: { fix: 'claude-path' } });
      const body = await second.json();
      if (body.runId) await waitFor(async () => (await (await fetch(`${s.base}/api/agent/install/status?id=${body.runId}`)).json()).state !== 'running', 15_000);
      const linesAfterSecond = markerLines(m.home);
      ev.push(`second run: ${second.status()} ${JSON.stringify(body)}; marker lines now ${linesAfterSecond.length}`);
      // bash reads two startup files, and the product writes the line into each that exists:
      // one marker per file, and the second run adds none anywhere.
      const perFile = ['.bash_profile', '.bashrc'].map((f) => readText(join(m.home, f)).split('\n').filter((l) => /^# dreamcontext: Claude/.test(l)).length);
      ev.push(`Claude marker lines per file (.bash_profile, .bashrc): ${perFile.join(', ')}`);
      return { pass: before?.reason === 'not-on-path' && !!done && perFile.every((n) => n <= 1) && perFile.some((n) => n === 1) && linesAfterSecond.length === linesAfterFirst.length, evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** Signed out: wait card; Cancel kills the login; retry signs in and the row resolves. */
  async S4(ctx) {
    const m = makeMachine('S4', { ...READY, claudeAuth: false });
    writeFileSync(join(m.v, 'claude-login-mode'), 'hang');
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      const signIn = row(page, TITLES['claude-auth']).getByRole('button', { name: 'Sign in', exact: true });
      await signIn.waitFor({ timeout: 20_000 });
      await signIn.click();
      const card = await page.getByText('Finish signing in in your browser').waitFor({ timeout: 20_000 }).then(() => true, () => false);
      const pidOk = await waitFor(() => existsSync(join(m.v, 'claude-login.pid')), 10_000);
      const pid = Number(readText(join(m.v, 'claude-login.pid')));
      ev.push(`wait card: ${card}; login pid ${pid}`);
      await shot(page, 'S4-waiting');
      await row(page, TITLES['claude-auth']).getByRole('button', { name: 'Cancel', exact: true }).click();
      const killed = await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 10_000);
      ev.push(`login process gone after Cancel: ${!!killed}`);
      writeFileSync(join(m.v, 'claude-login-mode'), 'ok');
      const retry = row(page, TITLES['claude-auth']).getByRole('button', { name: /Sign in|Try again/ });
      await retry.first().waitFor({ timeout: 20_000 });
      await retry.first().click();
      const done = await waitFor(() => rowIsDone(page, TITLES['claude-auth']), 40_000);
      ev.push(`retry resolved the row: ${!!done}`);
      await shot(page, 'S4');
      return { pass: card && !!pidOk && !!killed && !!done, evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** git missing on a Mac: one dialog request, no repeats from polling, resolves on landing. */
  async S5(ctx) {
    const m = makeMachine('S5', { ...READY, git: false });
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      const install = row(page, TITLES.git).getByRole('button', { name: 'Install Git' });
      await install.waitFor({ timeout: 20_000 });
      await install.click();
      const waiting = await page.getByText('A macOS window opened').waitFor({ timeout: 20_000 }).then(() => true, () => false);
      ev.push(`developer-tools wait shown: ${waiting}`);
      await sleep(6000); // a few readiness polls and one dialog poll go by
      await shot(page, 'S5-waiting');
      const installsWhileWaiting = logLines(m).filter((l) => l.startsWith('xcode-select\t--install')).length;
      setGitInstalled(m.home, true);
      // Git was the last open item, so when it lands the Mac step plays its ready moment and
      // moves on: the row resolving and the step advancing are both "resolved".
      const advanced = page.getByRole('heading', { name: /This Mac is ready|Add your project/ });
      const done = await waitFor(async () => (await rowIsDone(page, TITLES.git)) || (await advanced.first().isVisible()), 30_000);
      const gitNow = check(await readiness(s), 'git');
      const installs = logLines(m).filter((l) => l.startsWith('xcode-select\t--install')).length;
      ev.push(`--install calls while waiting: ${installsWhileWaiting}, total: ${installs}; resolved in the UI: ${!!done}; git check: ${gitNow?.status}`);
      await shot(page, 'S5');
      return { pass: waiting && installsWhileWaiting === 1 && installs === 1 && !!done && gitNow?.status === 'ok', evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** gh signed in with importable scopes: GitHub connects in one click, no browser. */
  async S6(ctx) {
    const m = makeMachine('S6', { ...READY, githubToken: false });
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      const connect = row(page, TITLES.github).getByRole('button');
      await connect.first().waitFor({ timeout: 20_000 });
      const label = await connect.first().textContent();
      ev.push(`action label: "${label}"`);
      await connect.first().click();
      const done = await waitFor(() => rowIsDone(page, TITLES.github), 30_000);
      const path = join(m.home, '.dreamcontext', '.secrets.json');
      const secrets = readText(path);
      const mode = existsSync(path) ? (statSync(path).mode & 0o777).toString(8) : 'missing';
      const ghCalls = logLines(m).filter((l) => l.startsWith('gh\t')).map((l) => l.split('\t')[1]);
      const codeCard = await page.locator('.ob-wait-code').count();
      ev.push(`row resolved: ${!!done}; .secrets.json mode ${mode}; login stored: ${/verify-user/.test(secrets)}; gh calls: ${ghCalls.join(' | ')}; device-code cards: ${codeCard}`);
      await shot(page, 'S6');
      return {
        pass: /account you're signed in to/i.test(label ?? '') && !!done && mode === '600' && /gho_verifyFakeToken/.test(secrets)
          && /verify-user/.test(secrets) && ghCalls.some((c) => c.startsWith('api -i user')) && codeCard === 0,
        evidence: ev,
      };
    } finally {
      await stopServer(s);
    }
  },

  /** ~/projects missing: Create new makes the folder and registers the vault. */
  async S7(ctx) {
    const m = makeMachine('S7', READY);
    const s = await startServer(m);
    const ev = [];
    try {
      const parentBefore = existsSync(join(m.home, 'projects'));
      const page = await openLauncher(ctx, s);
      const onProject = await reachProjectStep(page);
      const created = onProject && await createProject(page, 'demo');
      const dir = join(m.home, 'projects', 'demo');
      const vaults = readVaults(m.home).map((x) => x.name);
      ev.push(`~/projects before: ${parentBefore}; project step: ${onProject}; hand-off shown: ${created}; ${dir} has _dream_context: ${existsSync(join(dir, '_dream_context'))}; vaults: ${vaults.join(',')}`);
      await shot(page, 'S7');
      return { pass: !parentBefore && created && existsSync(join(dir, '_dream_context')) && vaults.includes('demo'), evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** A folder with 6 documents and no git: counted, Git pre-checked, both set up. */
  async S8(ctx) {
    const m = makeMachine('S8', READY);
    const folder = join(m.base, 'notes-project');
    mkdirSync(join(folder, 'docs'), { recursive: true });
    for (let i = 1; i <= 6; i++) writeFileSync(join(folder, 'docs', `note-${i}.md`), `# Note ${i}\n\nSome thoughts.\n`);
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      const onProject = await reachProjectStep(page);
      await openFolder(page, folder);
      const docs = await page.getByText('Found 6 documents. Claude will read them in.').waitFor({ timeout: 20_000 }).then(() => true, () => false);
      const gitBox = page.getByRole('checkbox', { name: /Track changes with Git/ });
      const checked = await gitBox.isChecked().catch(() => false);
      ev.push(`project step: ${onProject}; "Found 6 documents": ${docs}; Git checked: ${checked}`);
      await shot(page, 'S8');
      await page.getByRole('button', { name: 'Set up project', exact: true }).click();
      const handoff = await page.getByRole('heading', { name: /is ready$/ }).waitFor({ timeout: 60_000 }).then(() => true, () => false);
      const hasGit = existsSync(join(folder, '.git'));
      const hasBrain = existsSync(join(folder, '_dream_context'));
      ev.push(`hand-off: ${handoff}; .git: ${hasGit}; _dream_context: ${hasBrain}`);
      return { pass: onProject && docs && checked && handoff && hasGit && hasBrain, evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** The same folder while the Git install is still pending: git init lands when Git does. */
  async S8b(ctx) {
    const m = makeMachine('S8b', { ...READY, git: false });
    const folder = join(m.base, 'notes-project');
    mkdirSync(join(folder, 'docs'), { recursive: true });
    for (let i = 1; i <= 6; i++) writeFileSync(join(folder, 'docs', `note-${i}.md`), `# Note ${i}\n`);
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      // The primary path: "Set everything up" starts the Git install and, since that is a
      // background wait, the Mac step moves on while the developer tools download.
      const setUp = page.getByRole('button', { name: 'Set everything up' });
      await setUp.waitFor({ timeout: 20_000 });
      await setUp.click();
      await page.getByText('A macOS window opened').waitFor({ timeout: 20_000 }).catch(() => undefined);
      const onProject = await reachProjectStep(page, { allowContinue: false });
      await openFolder(page, folder);
      const pendingCopy = await page.getByText('Git will be set up when the macOS install finishes').waitFor({ timeout: 20_000 }).then(() => true, () => false);
      const checked = await page.getByRole('checkbox', { name: /Track changes with Git/ }).isChecked().catch(() => false);
      ev.push(`project step: ${onProject}; pending copy: ${pendingCopy}; Git checked: ${checked}`);
      await shot(page, 'S8b');
      await page.getByRole('button', { name: 'Set up project', exact: true }).click();
      const handoff = await page.getByRole('heading', { name: /is ready$/ }).waitFor({ timeout: 60_000 }).then(() => true, () => false);
      const gitRightAfter = existsSync(join(folder, '.git'));
      const pending = readText(join(m.home, '.dreamcontext', 'onboarding.json'));
      ev.push(`hand-off: ${handoff}; .git right after setup: ${gitRightAfter}; onboarding.json: ${pending.replace(/\s+/g, ' ').slice(0, 200)}`);
      setGitInstalled(m.home, true);
      const landed = await waitFor(() => existsSync(join(folder, '.git')), 40_000, 500);
      ev.push(`.git after the developer tools landed: ${!!landed}`);
      return { pass: onProject && pendingCopy && checked && handoff && !gitRightAfter && !!landed, evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** A folder that already has a brain: registered and opened, no questions. */
  async S9(ctx) {
    const m = makeMachine('S9', READY);
    const folder = join(m.base, 'existing-brain');
    mkdirSync(join(folder, '_dream_context', 'core'), { recursive: true });
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      const onProject = await reachProjectStep(page);
      const popupP = ctx.waitForEvent('page', { timeout: 30_000 }).catch(() => null);
      await openFolder(page, folder);
      const popup = await popupP;
      const url = popup?.url() ?? '';
      const vaults = readVaults(m.home).map((x) => x.name);
      const askedQuestions = await page.getByRole('button', { name: 'Set up project', exact: true }).isVisible().catch(() => false);
      ev.push(`project step: ${onProject}; opened: ${url}; vaults: ${vaults.join(',')}; quiz shown: ${askedQuestions}`);
      await shot(page, 'S9');
      return { pass: onProject && /vault=existing-brain/.test(url) && vaults.includes('existing-brain') && !askedQuestions, evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** Ready machine, new project: Start with Claude opens the project and Claude gets the kickoff. */
  async S10(ctx) {
    const m = makeMachine('S10', READY);
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      const onProject = await reachProjectStep(page);
      const created = onProject && await createProject(page, 'demo');
      await shot(page, 'S10-handoff');
      const popupP = ctx.waitForEvent('page', { timeout: 30_000 }).catch(() => null);
      await page.getByRole('button', { name: 'Start with Claude', exact: true }).click();
      const popup = await popupP;
      const url = popup?.url() ?? '';
      ev.push(`hand-off: ${created}; opened: ${url}`);
      const firstPath = join(m.v, 'claude-first-message.txt');
      const got = await waitFor(() => existsSync(firstPath), 60_000, 500);
      const first = readText(firstPath);
      const expected = kickoffPrompt();
      ev.push(`first message received: ${!!got}; equals kickoff prompt: ${first.trim() === expected}${first && first.trim() !== expected ? ` (got "${first.slice(0, 160)}")` : ''}`);
      if (popup) { await popup.waitForTimeout(1500); await shot(popup, 'S10-project'); }
      await shot(page, 'S10');
      const engines = logLines(m).filter((l) => /^claude\tengine/.test(l)).length;
      ev.push(`chat engines started: ${engines}`);
      return { pass: created && /vault=demo/.test(url) && /start=initializer/.test(url) && first.trim() === expected && engines === 1, evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** Reduced motion: nothing animates on the checklist or the hand-off. */
  async S11(ctx) {
    const m = makeMachine('S11', { ...READY, git: false });
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await row(page, TITLES.git).waitFor({ timeout: 20_000 });
      await sleep(800);
      const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.animationName ?? a.constructor.name));
      const onChecklist = await running();
      const status = await row(page, TITLES.git).textContent();
      ev.push(`running animations on the checklist: ${JSON.stringify(onChecklist)}; git row text present: ${!!status}`);
      await shot(page, 'S11-checklist');
      setGitInstalled(m.home, true);
      const onProject = await reachProjectStep(page);
      const created = onProject && await createProject(page, 'calm');
      await sleep(800);
      const onHandoff = await running();
      ev.push(`hand-off reached: ${created}; running animations there: ${JSON.stringify(onHandoff)}`);
      await shot(page, 'S11');
      return { pass: onChecklist.length === 0 && !!status && created && onHandoff.length === 0, evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** No desktop flag: the browser surface shows no fix buttons and the fix route says 403. */
  async S12(ctx) {
    const m = makeMachine('S12', { ...READY, claudeAuth: false, git: false });
    const s = await startServer(m, { desktop: false });
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      await row(page, TITLES.git).waitFor({ timeout: 20_000 });
      const fixButtons = await page.locator('.ob-row .ob-btn--secondary').count();
      const terminalLine = await page.getByText('Run dreamcontext setup in Terminal to fix this.').count();
      const setUp = await page.getByRole('button', { name: 'Set everything up' }).count();
      const post = await page.request.post(`${s.base}/api/onboarding/fix`, { data: { fix: 'claude-signin' } });
      ev.push(`fix buttons: ${fixButtons}; Terminal lines: ${terminalLine}; Set everything up buttons: ${setUp}; POST /fix: ${post.status()}`);
      await shot(page, 'S12');
      return { pass: fixButtons === 0 && terminalLine > 0 && setUp === 0 && post.status() === 403, evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** Ready, with a project: the Launcher shows neither the takeover nor the setup bar. */
  async S13(ctx) {
    const m = makeMachine('S13', { ...READY, vaults: ['alpha'] });
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s, { welcome: false });
      await page.getByRole('button', { name: /Add Project/ }).waitFor({ timeout: 20_000 }).catch(() => undefined);
      await sleep(3000);
      const takeover = await page.locator('section.ob').count();
      const bar = await page.locator('.launcher-finish-bar').count();
      ev.push(`takeover: ${takeover}; finish bar: ${bar}`);
      await shot(page, 'S13');
      return { pass: takeover === 0 && bar === 0, evidence: ev };
    } finally {
      await stopServer(s);
    }
  },

  /** Not ready, with a project: a slim bar, and it opens the checklist. */
  async S14(ctx) {
    const m = makeMachine('S14', { ...READY, claudeAuth: false, vaults: ['alpha'] });
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s, { welcome: false });
      const bar = page.locator('.launcher-finish-bar');
      const shown = await bar.waitFor({ timeout: 20_000 }).then(() => true, () => false);
      const text = shown ? await bar.textContent() : '';
      const takeoverFirst = await page.locator('section.ob').count();
      await shot(page, 'S14-bar');
      if (shown) await bar.click();
      const checklist = await page.locator('.ob-checklist').waitFor({ timeout: 15_000 }).then(() => true, () => false);
      const welcomeAfterClick = await page.getByRole('button', { name: 'Get started', exact: true }).count();
      ev.push(`bar: "${text}"; takeover before click: ${takeoverFirst}; checklist after click: ${checklist}; Welcome after click: ${welcomeAfterClick}`);
      await shot(page, 'S14');
      return { pass: shown && /Finish setting up \(\d+ left\)/.test(text ?? '') && takeoverFirst === 0 && checklist && welcomeAfterClick === 0, evidence: ev };
    } finally {
      await stopServer(s);
    }
  },
};

const ORDER = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S8b', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14'];

// ─── Main ─────────────────────────────────────────────────────────────────────────────

function selectedRows() {
  const i = process.argv.indexOf('--rows');
  if (i === -1) return ORDER;
  const want = new Set(String(process.argv[i + 1] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  const unknown = [...want].filter((r) => !ORDER.includes(r));
  if (unknown.length) throw new Error(`unknown rows: ${unknown.join(', ')} (known: ${ORDER.join(', ')})`);
  return ORDER.filter((r) => want.has(r));
}

async function main() {
  if (!existsSync(DIST) || !existsSync(join(REPO, 'dist', 'dashboard', 'index.html'))) {
    console.error('✗ dist/ is missing or has no dashboard. Run `npm run build` first.');
    process.exit(1);
  }
  const rows = selectedRows();
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  for (const f of readdirSync(SHOTS)) if (f.endsWith('.png')) rmSync(join(SHOTS, f), { force: true });
  ensureNodeRuntime();
  await startSeamServer();
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const id of rows) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      let result;
      const t0 = Date.now();
      try {
        result = await ROWS[id](ctx);
      } catch (err) {
        result = { pass: false, evidence: [`harness error: ${(err && err.stack) || err}`] };
      } finally {
        await ctx.close().catch(() => undefined);
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      results.push({ id, ...result });
      console.log(`${result.pass ? 'PASS' : 'FAIL'} ${id} (${secs}s)`);
      for (const e of result.evidence) console.log(`     ${e}`);
    }
  } finally {
    await browser.close().catch(() => undefined);
    seam.server?.close();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} rows passed. Screenshots: ${SHOTS}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
