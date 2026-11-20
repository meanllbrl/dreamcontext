#!/usr/bin/env node
/**
 * First open (plan ilk-acilis, Jakob's law), verified end to end against the REAL built server
 * and the REAL dashboard UI.
 *
 *   npm run build && npm run verify:onboarding               # every row
 *   node scripts/verify/onboarding.mjs --rows screen1,s3      # a subset
 *
 * WHAT IT DRIVES. Each row builds a fresh fake HOME, boots `dist/index.js dashboard --launcher`
 * on its own port and drives it in Chromium: screen 1 (welcome + the agent gate), screen 2
 * (Open a project: Open folder, New project, + Add Project), the GitHub clone screens, and
 * screen 3 (the project's Super stage with the first-read offer). Every row saves a light and a
 * dark screenshot to tmp/verify/onboarding/<row>-<theme>.png.
 *
 * WHAT IT NEVER TOUCHES. The developer's ~/.dreamcontext, ~/.claude, credentials and network:
 *  - HOME is a scratch folder and the server gets a CLEAN environment (no inherited tokens).
 *  - SHELL is /bin/bash, whose login profile in the fake HOME sets a PATH made only of
 *    stand-ins (fixtures/onboarding: npm, brew, gh, xcode-select, claude) plus /bin and
 *    /usr/sbin. /usr/bin is left out on purpose (the real git and Apple's shims live there).
 *  - The server runs on a COPY of node in a folder with nothing beside it.
 *  - The network probe and the Claude installer come from a loopback server through the
 *    product's own test seams (DREAMCONTEXT_ONBOARDING_PROBE_URL,
 *    DREAMCONTEXT_CLAUDE_INSTALLER_URL), honoured only for http://127.0.0.1.
 *  - The owner key: the server takes a scratch key on stdin (DREAMCONTEXT_OWNER_KEY_STDIN, as
 *    the Mac shell does) and the browser context sends it on every request, so the owner-only
 *    routes (register, scaffold, clone, first-read) answer this page as they answer the app.
 *  - GitHub never: the GitHub rows answer the page's own requests (`page.route`) with each
 *    state's server reply (sign-in code, expired, denied, the repo list, a clone's status). The
 *    real clone is proven in the installed app's observed check.
 *
 * FAILURE POLICY. Collect, don't fail fast: every row runs and prints PASS/FAIL with its
 * evidence. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTheme } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(REPO, 'scripts', 'verify', 'fixtures', 'onboarding');
const ROOT = join(tmpdir(), 'dreamcontext-verify-onboarding');
const SHOTS = join(REPO, 'tmp', 'verify', 'onboarding');
const DIST = join(REPO, 'dist', 'index.js');
const NODE_RUNTIME = join(ROOT, 'node-runtime', 'bin');
const NODE = join(NODE_RUNTIME, 'node');
const OWNER_KEY = randomBytes(24).toString('hex');

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

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
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

const seam = { offline: false, installerFail: false, installerFetches: 0, server: null, port: 0 };

const INSTALLER = `#!/bin/bash
# Stand-in for Anthropic's install.sh, served by scripts/verify/onboarding.mjs.
set -e
mkdir -p "$HOME/.local/bin"
cp "$HOME/.verify/claude-standin" "$HOME/.local/bin/claude"
chmod 755 "$HOME/.local/bin/claude"
printf 'installer\\trun\\n' >> "$HOME/.verify/log"
echo "Claude Code installed to $HOME/.local/bin/claude"
`;

const INSTALLER_FAILS = `#!/bin/bash
printf 'installer\\tfail\\n' >> "$HOME/.verify/log"
echo "curl: (56) Recv failure: Connection reset by peer" >&2
exit 1
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
      if (seam.offline) { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(seam.installerFail ? INSTALLER_FAILS : INSTALLER);
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
 *   claude       'none' | 'onpath'
 *   claudeAuth   signed in
 *   git          git + developer tools present
 *   gh           'none' | 'authed' | 'unauthed'
 *   vaults       projects registered before the row (a later project, not the first install)
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
  symlinkSync('/usr/bin/uname', join(tools, 'uname'));

  writeExec(join(v, 'claude-standin'), `#!/bin/sh\nexec '${process.execPath}' '${join(FIXTURES, 'claude.mjs')}' "$@"\n`);
  writeFileSync(join(v, 'claude-auth.json'), JSON.stringify({ loggedIn: !!o.claudeAuth }));
  if (o.claude === 'onpath') {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeExec(join(home, '.local', 'bin', 'claude'), readFileSync(join(v, 'claude-standin'), 'utf-8'));
  }
  // The CLI and node are on PATH on every row: the first open no longer sets them up.
  writeExec(join(npmPrefix, 'bin', 'dreamcontext'), '#!/bin/sh\necho 0.0.0-verify\n');
  if (o.git) {
    symlinkSync('/usr/bin/git', join(tools, 'git'));
    writeFileSync(join(v, 'clt'), '');
  }
  if (o.gh && o.gh !== 'none') writeExec(join(tools, 'gh'), readFileSync(join(FIXTURES, 'gh'), 'utf-8'));
  if (o.gh === 'authed') writeFileSync(join(v, 'gh-authed'), '');
  if (o.claudeLogin) writeFileSync(join(v, 'claude-login-mode'), o.claudeLogin);
  // The Super Agent on, chat view on (a fresh install's defaults on the Mac).
  writeFileSync(join(home, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', superAgent: true,
  }, null, 2)}\n`);

  const pathParts = [tools, join(npmPrefix, 'bin')];
  if (o.claude === 'onpath') pathParts.push('$HOME/.local/bin');
  pathParts.push(NODE_RUNTIME, '/bin', '/usr/sbin', '/sbin');
  writeFileSync(join(home, '.bash_profile'), [
    '# Fake login profile written by scripts/verify/onboarding.mjs.',
    `export PATH="${pathParts.join(':')}"`,
    '',
  ].join('\n'));
  const m = { base, home, v, tools, npmPrefix };
  for (const vault of o.vaults ?? []) {
    const dir = join(base, vault);
    mkdirSync(join(dir, '_dream_context'), { recursive: true });
    const r = spawnSync(process.execPath, [DIST, 'vaults', 'add', vault, dir], {
      env: { HOME: home, PATH: '/bin:/usr/bin', DREAMCONTEXT_EMBED_AUTO: '0' }, encoding: 'utf-8',
    });
    if (r.status !== 0) throw new Error(`vaults add ${vault} failed: ${r.stderr || r.stdout}`);
  }
  return m;
}

/** A folder with a project in it (README, code), the way a first Open folder finds one. */
function projectFolder(m, name) {
  const dir = join(m.base, 'work', name);
  mkdirSync(join(dir, 'src', 'api'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), `# ${name}\n\nA habit tracker for small teams.\n`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: name.toLowerCase(), version: '0.3.0' }, null, 2));
  writeFileSync(join(dir, 'src', 'api', 'habits.ts'), 'export const habits = [];\n');
  return dir;
}

function logLines(m) {
  return readText(join(m.v, 'log')).split('\n').filter(Boolean);
}

function readVaults(home) {
  const raw = readJson(join(home, '.dreamcontext', 'vaults.json'), []);
  return Array.isArray(raw) ? raw : (raw.vaults ?? []);
}

const marker = (m) => readJson(join(m.home, '.dreamcontext', 'first-run.json'));
const turns = (m, role) => logLines(m).filter((l) => l.startsWith(`claude\tturn-${role}`));

// ─── The server ───────────────────────────────────────────────────────────────────────

async function startServer(m) {
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
    DREAMCONTEXT_DESKTOP: '1',
    DREAMCONTEXT_OWNER_KEY_STDIN: '1',
  };
  const srv = spawn(NODE, [DIST, 'dashboard', '--no-open', '-p', String(port), '--launcher'], {
    cwd: m.home, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  srv.stdin.write(`${OWNER_KEY}\n`);
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

// ─── UI helpers ───────────────────────────────────────────────────────────────────────

/** Console errors of every page of the row (a red console fails the row). */
function watch(ctx) {
  const errors = [];
  ctx.on('page', (p) => {
    p.on('console', (msg) => {
      if (process.env.VERIFY_DEBUG) console.log(`      [page ${msg.type()}] ${msg.text().slice(0, 300)}`);
      if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text().slice(0, 200));
    });
    p.on('pageerror', (e) => errors.push(`crash: ${String(e).slice(0, 200)}`));
  });
  return errors;
}

async function openLauncher(ctx, s) {
  const page = await ctx.newPage();
  await page.goto(`${s.base}/`, { waitUntil: 'domcontentloaded' });
  return page;
}

/** A light and a dark screenshot of the page as it is. */
async function shots(page, id) {
  for (const theme of ['light', 'dark']) {
    await applyTheme(page, theme);
    await sleep(500);
    try { await page.screenshot({ path: join(SHOTS, `${id}-${theme}.png`), fullPage: false }); } catch { /* page gone */ }
  }
  await applyTheme(page, 'light');
}

const openHeading = (page) => page.getByRole('heading', { name: 'Open a project' });

/** Screen 1 to screen 2 on a ready machine: one click. */
async function continueWithClaude(page) {
  const btn = page.getByTestId('ob-continue-claude');
  await btn.waitFor({ timeout: 20_000 });
  await btn.click();
  return openHeading(page).waitFor({ timeout: 30_000 }).then(() => true, () => false);
}

/**
 * A landing in the new shell happens in THIS window (the launcher becomes the project's window).
 * Anything that still asks for a browser popup is recorded, not opened (Chromium blocks a popup
 * after a long await; the app opens a real window there), so a row can see it was asked for.
 */
const CAPTURE_OPEN = () => { window.open = (u) => { (window.__opened ||= []).push(String(u)); return null; }; };

async function openFolderNamed(page, path) {
  page.once('dialog', (d) => { void d.accept(path); });
  await page.getByTestId('ob-open-folder').click();
}

/** The Super stage's empty state with this title (the landing reached that project's stage). */
function heroTitled(page, title) {
  return page.locator('.chat-banner-empty--hero .chat-banner-empty-title').filter({ hasText: title })
    .first().waitFor({ timeout: 60_000 }).then(() => true, () => false);
}

function registerVault(home, name, dir) {
  const r = spawnSync(process.execPath, [DIST, 'vaults', 'add', name, dir], {
    env: { HOME: home, PATH: '/bin:/usr/bin', DREAMCONTEXT_EMBED_AUTO: '0' }, encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`vaults add ${name} failed: ${r.stderr || r.stdout}`);
}

/** The project's Super stage, its empty state up. */
async function superStage(page) {
  await page.waitForLoadState('domcontentloaded');
  const hero = page.locator('.chat-banner-empty--hero');
  const ok = await hero.first().waitFor({ timeout: 45_000 }).then(() => true, () => false);
  return { ok, hero: hero.first() };
}

const ROW_TIMEOUT = 240_000;

// ─── Rows ─────────────────────────────────────────────────────────────────────────────
//
// Each row returns { pass, evidence: string[] }. `ctx` is a fresh browser context.

const READY = { claude: 'onpath', claudeAuth: true, git: true, gh: 'authed' };

function verdict(ev, checks) {
  for (const [label, ok, detail] of checks) ev.push(`${ok ? '✓' : '✗'} ${label}${!ok && detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ''}`);
  return checks.every(([, ok]) => !!ok);
}

const ROWS = {
  /** C1, C2, C5: screen 1, one click to screen 2, no checklist, no Git, no browser. */
  async screen1(ctx) {
    const m = makeMachine('screen1', READY);
    const s = await startServer(m);
    const ev = [];
    const errors = watch(ctx);
    try {
      const page = await openLauncher(ctx, s);
      const title = page.getByRole('heading', { name: 'The Agentic OS for your projects.' });
      const titled = await title.waitFor({ timeout: 20_000 }).then(() => true, () => false);
      const other = await page.getByRole('button', { name: 'Use Codex or Antigravity instead' }).isVisible().catch(() => false);
      await shots(page, 'screen1');
      const t0 = Date.now();
      const reached = await continueWithClaude(page);
      const ms = Date.now() - t0;
      const checklist = await page.locator('.ob-checklist').count();
      const signed = (await page.getByTestId('ob-signed-in').textContent().catch(() => '')) ?? '';
      await shots(page, 'screen2');
      const ran = logLines(m);
      return {
        pass: verdict(ev, [
          ['welcome headline', titled],
          ['"Use Codex or Antigravity instead" offered', other],
          [`Continue with Claude reaches Open a project in one click (${ms} ms)`, reached],
          ['no setup checklist', checklist === 0, checklist],
          ['signed-in line names the account', signed.includes('verify@example.com'), signed],
          ['no Apple Git window (xcode-select --install never ran)', !ran.some((l) => /xcode-select.*--install/.test(l)), ran.join(' | ')],
          ['no browser sign-in ran', !ran.some((l) => l.startsWith('claude\tlogin')), ran.join(' | ')],
          ['screen 2 shows drop zone, Open folder, New project, Clone', (await Promise.all(['ob-drop', 'ob-open-folder', 'ob-new-project', 'ob-clone'].map((id) => page.getByTestId(id).isVisible()))).every(Boolean)],
          ['no console errors', errors.length === 0, errors.join(' | ')],
        ]),
        evidence: ev,
      };
    } finally { await stopServer(s); }
  },

  /** C3: Claude missing: preparing, then browser sign-in; no git-install on this path. */
  async 'gate-install'(ctx) {
    const m = makeMachine('gate-install', { claude: 'none', claudeAuth: false, git: false, gh: 'none' });
    const s = await startServer(m);
    const ev = [];
    try {
      seam.installerFetches = 0;
      const page = await openLauncher(ctx, s);
      await page.getByTestId('ob-continue-claude').waitFor({ timeout: 20_000 });
      await page.getByTestId('ob-continue-claude').click();
      const preparing = await page.getByTestId('ob-gate-preparing').waitFor({ timeout: 15_000 }).then(() => true, () => false);
      if (preparing) await shots(page, 'gate-preparing');
      const browser = await page.getByTestId('ob-gate-browser').waitFor({ timeout: 60_000 }).then(() => true, () => false);
      if (browser) await shots(page, 'gate-browser');
      const reached = await openHeading(page).waitFor({ timeout: 30_000 }).then(() => true, () => false);
      const ran = logLines(m);
      return {
        pass: verdict(ev, [
          ['preparing card while Claude installs', preparing],
          ['the installer was fetched', seam.installerFetches >= 1, seam.installerFetches],
          ['browser sign-in card', browser],
          ['sign-in done lands on Open a project', reached],
          ['no git-install run', !ran.some((l) => /xcode-select/.test(l)), ran.join(' | ')],
        ]),
        evidence: ev,
      };
    } finally { await stopServer(s); }
  },

  /** C3: offline, sign-in not finished, could not install. */
  async 'gate-states'(ctx) {
    const ev = [];
    const checks = [];
    // Offline: Claude missing, no network.
    {
      const m = makeMachine('gate-offline', { claude: 'none', claudeAuth: false });
      const s = await startServer(m);
      try {
        seam.offline = true;
        const page = await openLauncher(ctx, s);
        await page.getByTestId('ob-continue-claude').click({ timeout: 20_000 });
        const off = await page.getByTestId('ob-gate-offline').waitFor({ timeout: 30_000 }).then(() => true, () => false);
        if (off) await shots(page, 'gate-offline');
        checks.push(['offline card', off]);
        await page.close();
      } finally { seam.offline = false; await stopServer(s); }
    }
    // Could not install: the installer fails.
    {
      const m = makeMachine('gate-install-failed', { claude: 'none', claudeAuth: false });
      const s = await startServer(m);
      try {
        seam.installerFail = true;
        const page = await openLauncher(ctx, s);
        await page.getByTestId('ob-continue-claude').click({ timeout: 20_000 });
        const failed = await page.getByTestId('ob-gate-install-failed').waitFor({ timeout: 45_000 }).then(() => true, () => false);
        if (failed) await shots(page, 'gate-install-failed');
        checks.push(['could-not-install card', failed]);
        await page.close();
      } finally { seam.installerFail = false; await stopServer(s); }
    }
    // Not finished: the browser sign-in ends without access.
    {
      const m = makeMachine('gate-not-finished', { claude: 'onpath', claudeAuth: false, claudeLogin: 'fail' });
      const s = await startServer(m);
      try {
        const page = await openLauncher(ctx, s);
        // The stand-in's `auth login` in `fail` mode exits without signing in.
        await page.getByTestId('ob-continue-claude').click({ timeout: 20_000 });
        const nf = await page.getByTestId('ob-gate-not-finished').waitFor({ timeout: 45_000 }).then(() => true, () => false);
        if (nf) await shots(page, 'gate-not-finished');
        checks.push(['not-finished card', nf]);
        await page.close();
      } finally { await stopServer(s); }
    }
    return { pass: verdict(ev, checks), evidence: ev };
  },

  /** C4: Use Codex or Antigravity instead: the pick is written through the owner route. */
  async 'gate-other'(ctx) {
    const m = makeMachine('gate-other', READY);
    const s = await startServer(m);
    const ev = [];
    try {
      const page = await openLauncher(ctx, s);
      await page.getByRole('button', { name: 'Use Codex or Antigravity instead' }).click({ timeout: 20_000 });
      const panel = await page.getByRole('heading', { name: 'Run your whole project through your agents.' }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
      await shots(page, 'gate-other');
      await page.getByRole('button', { name: 'Continue with Antigravity' }).click();
      // Antigravity is not on this Mac: its gate starts (a card), and the pick waits for it.
      const gate = await page.locator('.ob-gate').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await shots(page, 'gate-other-started');
      // The pick itself, through the one writer, as the gate sends it once the agent is ready.
      const res = await page.evaluate(async () => (await fetch('/api/onboarding/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ picked: ['antigravity'] }) })).status);
      const written = await waitFor(() => JSON.stringify(readJson(join(m.home, '.dreamcontext', 'agents.json'), {})).includes('antigravity'), 15_000);
      return {
        pass: verdict(ev, [
          ['the other-agents panel', panel],
          ['Continue with Antigravity starts its gate', gate],
          ['the pick route answers the owner page', res === 200, res],
          ['agents.json names the pick', !!written, readText(join(m.home, '.dreamcontext', 'agents.json'))],
        ]),
        evidence: ev,
      };
    } finally { await stopServer(s); }
  },

  /** C5, C7, C12, C10: New project makes ~/Projects/<name>, lands on the Super stage; an empty folder gets no offer; the chips send and vanish. */
  async 'new-project'(ctx) {
    const m = makeMachine('new-project', READY);
    const s = await startServer(m);
    const ev = [];
    const errors = watch(ctx);
    try {
      const page = await openLauncher(ctx, s);
      await continueWithClaude(page);
      await page.getByTestId('ob-new-project').click();
      await page.getByTestId('ob-new-name').fill('Nova');
      await shots(page, 'new-project-form');
      // The new shell lands in THIS window (the launcher becomes the project's window).
      await page.getByTestId('ob-new-name').press('Enter');
      const win = page;
      const heroTitle = await heroTitled(win, 'What should we do in Nova?');
      const dir = join(m.home, 'Projects', 'Nova');
      const st = win ? await superStage(win) : { ok: false };
      const offer = win ? await win.getByTestId('first-read-offer').isVisible().catch(() => false) : true;
      if (win) await shots(win, 'new-project-landed');
      let chipsGone = false;
      let chipSent = false;
      if (win && st.ok) {
        await win.locator('.chat-banner-chip').filter({ hasText: 'What should I work on first?' }).click();
        chipSent = !!(await waitFor(() => turns(m, 'super').some((l) => l.includes('What should I work on first?')), 30_000));
        chipsGone = !!(await waitFor(async () => (await win.getByTestId('chat-empty-chips').count()) === 0, 15_000));
      }
      return {
        pass: verdict(ev, [
          ['lands in this window on Nova\'s Super stage (the super-landing intent)', heroTitle],
          [`~/Projects/Nova made`, existsSync(join(dir, '_dream_context')), dir],
          ['no "is ready" screen', (await page.getByText(/is ready/).count()) === 0],
          ['lands on the Super stage empty state', st.ok],
          ['an empty new folder gets no first-read offer', !offer],
          ['a chip sends its text as the Super\'s first turn', chipSent, turns(m, 'super').join(' | ')],
          ['the chips vanish after the first message', chipsGone],
          ['no console errors', errors.length === 0, errors.join(' | ')],
        ]),
        evidence: ev,
      };
    } finally { await stopServer(s); }
  },

  /**
   * Screen 3 on the first install's first project (C10-C15, S6): Open folder lands on the Super
   * stage with the offer; nothing runs before the click (past the 30 s starting grace); a
   * refused start keeps the button and names the reason; Start reading starts the reading line;
   * on done the Super writes once; the claim holds the job and the marker's pending clears.
   */
  async s3(ctx) {
    const m = makeMachine('s3', READY);
    writeFileSync(join(m.v, 'child-ms'), '8000');
    const folder = projectFolder(m, 'Orbit');
    const s = await startServer(m);
    const ev = [];
    const errors = watch(ctx);
    try {
      const page = await openLauncher(ctx, s);
      await continueWithClaude(page);
      await openFolderNamed(page, folder);
      const win = page;
      const landedOrbit = await heroTitled(win, 'What should we do in Orbit?');
      const st = await superStage(win);
      if (!win || !st.ok) {
        await shots(page, 's3-not-landed');
        return { pass: verdict(ev, [['lands on the Super stage', false]]), evidence: ev };
      }
      const pending = marker(m)?.pending ?? null;
      const title = (await st.hero.locator('.chat-banner-empty-title').textContent().catch(() => '')) ?? '';
      const gem = await st.hero.locator('.chat-banner-empty-mark').count();
      const offer = await win.getByTestId('first-read-offer').waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await shots(win, 's3-offer');

      // S6: no click, no turn. Past the 30 s starting grace plus a pump tick.
      await sleep(36_000);
      const quietSuper = turns(m, 'super').length;
      const quietRead = turns(m, 'firstread').length;
      const offerStill = await win.getByTestId('first-read-offer').isVisible().catch(() => false);

      // A refused start: the limit (the server's 409 for it, answered here).
      await win.route('**/api/super/first-read', (route) => (route.request().method() === 'POST'
        ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'limited', message: 'limit' }) })
        : route.continue()));
      await win.getByTestId('first-read-start').click();
      const refused = await win.getByTestId('first-read-refused').waitFor({ timeout: 10_000 }).then(() => true, () => false);
      const refusedText = (await win.getByTestId('first-read-refused').textContent().catch(() => '')) ?? '';
      const buttonStays = await win.getByTestId('first-read-start').isVisible().catch(() => false);
      await shots(win, 's3-refused');
      await win.unroute('**/api/super/first-read');

      // Start reading, the limit cleared. A Super still connecting answers super_off: try again.
      let started = false;
      for (let i = 0; i < 6 && !started; i++) {
        await win.getByTestId('first-read-start').click().catch(() => undefined);
        started = !!(await waitFor(async () => (await win.getByTestId('first-read-started').count()) > 0, 5_000));
        if (!started) await sleep(3_000);
      }
      if (started) await shots(win, 's3-reading');
      const readTurn = !!(await waitFor(() => turns(m, 'firstread').length === 1, 30_000));
      const claim = readJson(join(folder, '_dream_context', 'state', '.config.json'), {})?.firstRead ?? null;
      const markerNow = marker(m);
      const markerAfter = markerNow === null ? 'absent' : markerNow.pending;
      // Done: the reading line goes, the Super writes once.
      const ended = !!(await waitFor(async () => (await win.getByTestId('first-read-started').count()) === 0, 60_000));
      const superAfter = !!(await waitFor(() => turns(m, 'super').some((l) => l.includes('[super')), 60_000));
      await sleep(3_000);
      await shots(win, 's3-done');
      const offerAgain = await win.getByTestId('first-read-offer').isVisible().catch(() => false);
      return {
        pass: verdict(ev, [
          ['lands in this window on Orbit\'s Super stage (the super-landing intent)', landedOrbit],
          ['first registration with files: marker pending is this folder', pending === realpathSync(folder), pending],
          ['title "What should we do in Orbit?"', title.trim() === 'What should we do in Orbit?', title],
          ['the gem in place of ">_"', gem === 1, gem],
          ['the first-read offer shows', offer],
          ['36 s after landing, before any click: no Super turn', quietSuper === 0, turns(m, 'super').join(' | ')],
          ['…and no reading started', quietRead === 0],
          ['…and the offer still shows', offerStill],
          ['a refused start names its reason', refused && /usage limit/i.test(refusedText), refusedText],
          ['…and keeps the Start reading button', buttonStays],
          ['Start reading shows "Reading started. You can write now."', started],
          ['exactly one reading job ran', readTurn, turns(m, 'firstread').join(' | ')],
          ['the claim holds a job id', typeof claim?.job === 'string' && claim.job.length > 0, JSON.stringify(claim)],
          ['the marker\'s pending cleared', markerAfter === null, markerAfter],
          ['on done the reading line goes', ended],
          ['on done the Super gets the result and writes', superAfter, turns(m, 'super').join(' | ')],
          ['the offer never comes back', !offerAgain],
          ['no console errors', errors.length === 0, errors.join(' | ')],
        ]),
        evidence: ev,
      };
    } finally { await stopServer(s); }
  },

  /** C5, C12: + Add Project on a Mac that has a project lands the same way, with no offer. */
  async 'add-later'(ctx) {
    const m = makeMachine('add-later', { ...READY, vaults: ['Older'] });
    const folder = projectFolder(m, 'Later');
    const s = await startServer(m);
    const ev = [];
    try {
      // The new shell's + Add Project: the drawer's New project, in an already-open window.
      const page = await ctx.newPage();
      await page.goto(`${s.base}/?vault=Older`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('drawer-new-project').click({ timeout: 30_000 });
      const step = await openHeading(page).waitFor({ timeout: 20_000 }).then(() => true, () => false);
      await shots(page, 'add-later-step');
      await openFolderNamed(page, folder);
      const landed = await page.locator('.chat-banner-empty--hero .chat-banner-empty-title').filter({ hasText: 'What should we do in Later?' })
        .waitFor({ timeout: 45_000 }).then(() => true, () => false);
      await sleep(3_000);
      const offer = await page.getByTestId('first-read-offer').isVisible().catch(() => false);
      await shots(page, 'add-later-landed');
      return {
        pass: verdict(ev, [
          ['+ Add Project opens the one project screen', step],
          ['lands in this window on Later\'s Super stage', landed],
          ['a later project gets no first-read offer', !offer],
          ['the marker names no pending project', (marker(m)?.pending ?? null) === null, JSON.stringify(marker(m))],
        ]),
        evidence: ev,
      };
    } finally { await stopServer(s); }
  },

  /** C8, C9, C11, C12: every GitHub state, from the server replies each state gives. */
  async github(ctx) {
    const m = makeMachine('github', { ...READY, git: false });
    const s = await startServer(m);
    const ev = [];
    const checks = [];
    const now = Date.now();
    const stub = { connected: false, probe: { login: 'verify-user', scopes: ['repo', 'read:org', 'gist'] }, signin: null, git: null, repos: [], clone: null };
    const REPOS = [
      { fullName: 'verify-user/orbit', private: true, description: 'Habit tracker', pushedAt: new Date(now - 3_600_000).toISOString(), sizeKb: 2400, onThisMac: false },
      { fullName: 'verify-user/atlas', private: false, description: 'Docs site', pushedAt: new Date(now - 86_400_000).toISOString(), sizeKb: 1_600_000, onThisMac: false },
      { fullName: 'acme/storefront', private: true, description: 'Shop', pushedAt: new Date(now - 7 * 86_400_000).toISOString(), sizeKb: 900, onThisMac: true },
    ];
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await ctx.route('**/api/**', (route) => {
      const u = new URL(route.request().url());
      const p = u.pathname;
      const method = route.request().method();
      if (p === '/api/brain/auth/status') return json(route, stub.connected ? { connected: true, login: 'verify-user', source: 'global' } : { connected: false, source: null });
      if (p === '/api/onboarding/github-probe') return json(route, stub.probe);
      if (p === '/api/onboarding/fix' && method === 'POST') {
        const fix = JSON.parse(route.request().postData() || '{}').fix;
        if (fix === 'github-signin' || fix === 'git-install') return json(route, { ok: true, runId: `${fix}-run` });
      }
      if (p === '/api/agent/install/status') {
        const id = u.searchParams.get('id');
        if (id === 'github-signin-run' && stub.signin) return json(route, stub.signin);
        if (id === 'git-install-run' && stub.git) return json(route, stub.git);
      }
      if (p === '/api/launcher/github/repos') return json(route, { repos: stub.repos });
      if (p === '/api/launcher/clone' && method === 'POST' && stub.clone) return json(route, { ok: true, cloneId: 'clone-1' });
      if (p === '/api/launcher/clone/status' && stub.clone) return json(route, stub.clone);
      if (p === '/api/launcher/clone/cancel') return json(route, { ok: true, canceled: true });
      return route.continue();
    });
    const toClone = async (page) => {
      await page.goto(`${s.base}/`, { waitUntil: 'domcontentloaded' });
      await continueWithClaude(page);
      await page.getByTestId('ob-clone').click();
    };
    const see = async (page, label, locator, id, timeout = 15_000) => {
      const ok = await locator.waitFor({ timeout }).then(() => true, () => false);
      if (ok) await shots(page, id);
      checks.push([label, ok]);
      return ok;
    };
    try {
      const page = await ctx.newPage();
      // 1. Not signed in, a GitHub CLI login on this Mac: Continue as <login>, permission = scopes.
      await toClone(page);
      await see(page, 'sign-in offers "Continue as verify-user"', page.getByTestId('clone-signin-btn').filter({ hasText: 'verify-user' }), 'gh-continue-as');
      // 2. No CLI login: Sign in with GitHub, the narrower permission line.
      stub.probe = { login: null, scopes: ['repo'] };
      await toClone(page);
      await see(page, 'sign-in offers "Sign in with GitHub"', page.getByTestId('clone-signin-btn').filter({ hasNotText: 'verify-user' }), 'gh-signin');
      // 3. The device code while waiting.
      stub.signin = { state: 'running', output: '', awaiting: 'browser', deviceCode: { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: now + 900_000 } };
      await page.getByTestId('clone-signin-btn').click();
      await see(page, 'the device code shows', page.getByText('WDJB-MJHT'), 'gh-code');
      // 4. Expired. 5. Denied.
      stub.signin = { state: 'error', output: '', outcome: 'timeout' };
      await toClone(page);
      await page.getByTestId('clone-signin-btn').click();
      await see(page, 'expired code', page.getByTestId('clone-signin').getByRole('button', { name: 'Try again' }), 'gh-expired');
      stub.signin = { state: 'error', output: '', outcome: 'refused' };
      await toClone(page);
      await page.getByTestId('clone-signin-btn').click();
      await see(page, 'access denied', page.getByTestId('clone-signin').getByRole('button', { name: 'Try again' }), 'gh-denied');
      // 6. Signed in: the repo list (private and On this Mac badges); Git starts installing.
      stub.signin = null;
      stub.connected = true;
      stub.repos = REPOS;
      stub.git = { state: 'running', output: '', awaiting: 'system-dialog' };
      await toClone(page);
      await see(page, 'the repo list with badges', page.getByTestId('clone-repos').getByText('On this Mac'), 'gh-pick');
      // 7. A folder already taken: the pick clones into <name>-2.
      await page.getByTestId('clone-repos').getByText('orbit').click();
      await shots(page, 'gh-selected');
      // 8. Git still installing: the clone waits for it.
      stub.clone = { state: 'running', progress: { phase: 'waiting-git' } };
      await page.getByTestId('clone-go').click();
      await see(page, 'clone waits for Git', page.getByTestId('clone-waiting-git'), 'clone-git-wait');
      // 9-10. The installer closed / could not download.
      stub.git = { state: 'error', output: '', gitMissing: 'closed' };
      stub.clone = { state: 'error', progress: { phase: 'waiting-git' }, reason: 'git-missing' };
      await see(page, 'installer closed: Install Git offered', page.getByTestId('clone-failed-git-missing'), 'clone-installer-closed', 20_000);
      const states = [
        ['cloning with a percent', { state: 'running', progress: { phase: 'receiving', percent: 42, receivedBytes: 3_400_000 }, sizeKb: 2400 }, page.getByText('42'), 'clone-percent'],
        ['a big repo note', { state: 'running', progress: { phase: 'receiving', percent: 3 }, sizeKb: 1_600_000, offerShallow: true }, page.getByTestId('clone-running'), 'clone-big'],
        ['no space', { state: 'error', progress: { phase: 'receiving' }, reason: 'no-space', space: { neededBytes: 2e9, freeBytes: 5e8 } }, page.getByTestId('clone-failed-no-space'), 'clone-no-space'],
        ['the connection dropped', { state: 'error', progress: { phase: 'receiving', percent: 30 }, reason: 'network' }, page.getByTestId('clone-failed-network'), 'clone-network'],
        ['timed out: latest version only offered', { state: 'error', progress: { phase: 'receiving', percent: 60 }, reason: 'timeout', offerShallow: true }, page.getByTestId('clone-failed-timeout'), 'clone-timeout'],
      ];
      for (const [label, status, locator, id] of states) {
        stub.git = { state: 'done', output: '' };
        stub.clone = status;
        await toClone(page);
        await page.getByTestId('clone-repos').getByText('atlas').click();
        await page.getByTestId('clone-go').click();
        await see(page, label, locator, id, 20_000);
      }
      // A repo that already has a brain: it lands like any project.
      const brainDir = join(m.base, 'Projects', 'storefront');
      stub.clone = { state: 'done', progress: { phase: 'done' }, result: { path: brainDir, name: 'storefront', vaultName: 'storefront', hasContext: true } };
      await toClone(page);
      await page.getByTestId('clone-repos').getByText('orbit').click();
      mkdirSync(join(brainDir, '_dream_context'), { recursive: true });
      registerVault(m.home, 'storefront', brainDir);
      await page.getByTestId('clone-go').click();
      const landedBrain = await heroTitled(page, 'What should we do in storefront?');
      await shots(page, landedBrain ? 'clone-brain-landed' : 'clone-brain-FAILED');
      checks.push(['a repo with a brain lands on its Super stage', landedBrain]);
      return { pass: verdict(ev, checks), evidence: ev };
    } finally { await stopServer(s); }
  },
};

const ORDER = Object.keys(ROWS);

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
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Dreamcontext-Owner-Key': OWNER_KEY } });
      await ctx.addInitScript(CAPTURE_OPEN);
      let result;
      const t0 = Date.now();
      try {
        result = await Promise.race([
          ROWS[id](ctx),
          sleep(ROW_TIMEOUT).then(() => ({ pass: false, evidence: [`row timed out after ${ROW_TIMEOUT / 1000}s`] })),
        ]);
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
