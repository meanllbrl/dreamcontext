#!/usr/bin/env node
/**
 * AI Team: a `run` card a routine run wrote is drawn in the teammate's conversation and reports
 * into THAT run — its exit goes back as a reply in the run's thread, the run's own session is
 * resumed, and its answer lands under the same run. And the conversation does not end with a
 * "New conversation · now" line nobody started: the composer says what writing there does.
 *
 *   npm run build && node e2e/aiteam-run-card-shots.mjs [out-dir]
 *
 * WHAT IT DRIVES: the BUILT dashboard server (of `DC_REPO`, default this checkout) against an
 * isolated scratch vault (fake HOME, DREAMCONTEXT_DESKTOP=1), real Chromium at 1440 px, and a
 * stand-in on PATH instead of `claude` (no model, no tokens). Fictional: "Herodot", "Acme".
 *
 * Screenshots: <out-dir>/1440-1-card.png, 1440-2-reported.png. Exit 1 on any FAIL.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, setTheme } from '../scripts/verify/lib/measure.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.DC_REPO ? resolve(process.env.DC_REPO) : HERE;
const DIST_INDEX = distIndex(REPO);
const SHOTS = resolve(process.argv[2] ?? join(HERE, 'tmp', 'verify-aiteam-run-card'));
mkdirSync(SHOTS, { recursive: true });
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-aiteam-run-card');
rmSync(SCRATCH, { recursive: true, force: true });
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme');
const DC = join(PROJ, '_dream_context');
const SLUG = 'herodot-desk';
const RUN_CMD = 'echo acme-login-ok';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`);
};

/** The parent's own Claude session must not leak into the children. */
function hostEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'DREAMCONTEXT_AGENT_SELF' || k === 'DREAMCONTEXT_AUTOMATION_RUN') delete env[k];
  }
  return env;
}
const BIN_PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
const cli = (...args) => spawnSync(process.execPath, [DIST_INDEX, ...args], { cwd: PROJ, env: { ...hostEnv(), HOME, PATH: BIN_PATH }, encoding: 'utf-8' });
const must = (label, r) => { if (r.status !== 0) throw new Error(`${label} failed: ${r.stderr || r.stdout}`); return r; };

// The stand-in: a fresh run posts a run card; a RESUMED turn (the card's report, a reply) posts
// what it was told, so the page can see the run itself continued.
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const slug = process.env.DREAMCONTEXT_AUTOMATION_SLUG || '';
const DC = ${JSON.stringify(DIST_INDEX)};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const run = (args) => spawnSync(process.execPath, [DC, ...args], { encoding: 'utf-8' });
const prompt = (() => { const i = process.argv.indexOf('-p'); return i === -1 ? '' : (process.argv[i + 1] || ''); })();
if (process.argv.includes('--resume')) {
  // The card's report rides in the resumed prompt: "exit 0 · 1s".
  const code = (prompt.match(/exit (\\d+) ·/) || [])[1] ?? '?';
  run(['automations', 'post', slug, 'Got it: the login finished (exit ' + code + '). Carrying on with the Acme inbox.']);
  out({ session_id: 'standin-' + slug, is_error: false, result: 'Done.', total_cost_usd: 0.01, num_turns: 1, duration_ms: 2000, permission_denials: [] });
  process.exit(0);
}
const tick = String.fromCharCode(96).repeat(3);
run(['automations', 'post', slug, ['I need the Acme inbox login before I can read the threads. Run this, then I carry on:', tick + 'dream-view', JSON.stringify({ type: 'run', id: 'acme-login', command: ${JSON.stringify(RUN_CMD)}, why: 'it signs you in to the Acme inbox' }), tick].join('\\n')]);
out({ session_id: 'standin-' + slug, is_error: false, result: 'Waiting for the login.', total_cost_usd: 0.01, num_turns: 1, duration_ms: 3000, permission_denials: [] });
process.exit(0);
`;

function setupScratch() {
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(DC, 'state'), join(DC, 'knowledge')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(DC, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false } }));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true,
    screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  must('vaults add', cli('vaults', 'add', 'acme', PROJ));
  must('agents create', cli('agents', 'create', 'herodot', '--title', 'Herodot', '--prompt', 'Herodot answers the fictional Acme support inbox.'));
  must('routine', cli('automations', 'create', SLUG, '--title', 'Herodot desk', '--agent', 'herodot', '--job', 'Go through the Acme inbox and draft replies.', '--days', 'daily', '--at', '09:00'));
  must('approve', cli('automations', 'approve', SLUG, '--yes'));
  must('run', cli('automations', 'run', SLUG, '--force'));
}

function freePort() {
  return new Promise((ok, fail) => {
    import('node:net').then(({ createServer }) => {
      const srv = createServer();
      srv.on('error', fail);
      srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ok(port)); });
    });
  });
}

async function startServer(port) {
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...hostEnv(), HOME, PATH: BIN_PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error(`dashboard server did not come up: ${log.slice(-400)}`);
}

async function browserLeg(port, consoleErrors) {
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
    await setTheme(context, 'dark');
    await markAnnouncementsSeen(context, base);
    // The run card's ▶ is desktop-only (`isDesktop()` reads the Tauri bridge): the bridge is
    // injected, as scripts/verify/agent-threads.mjs does, and the server runs desktop-gated.
    await context.addInitScript(() => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    const wait = (ms) => page.waitForTimeout(ms);
    const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(200); } return false; };
    const shot = async (name) => { await wait(500); await page.screenshot({ path: join(SHOTS, `1440-${name}.png`) }); };
    const toEnd = () => page.locator('.aiteam-stage .chat-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });

    await page.goto(`${base}/?vault=acme`, { waitUntil: 'domcontentloaded' });
    await wait(2000);
    for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await wait(300); }
    await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^AI Team$/ }) }).first().click();
    await page.locator('.aiteam').waitFor({ timeout: 15000 });
    await page.locator('[data-team-row="herodot"]').click();
    const pane = page.locator('.aiteam-stage .chat-pane');
    check('the run\'s post is in the stage', await until(async () => (await pane.innerText()).includes('Acme inbox login'), 20000));
    await toEnd();
    const card = page.locator('.aiteam-stage .chat-runcard');
    check('its run card is DRAWN (not the "not drawn" notice)', await until(async () => (await card.count()) === 1, 5000)
      && !(await pane.innerText()).includes('was written here but not drawn'));
    check('no "New conversation · now" line under the finished run', (await page.locator('.aiteam-stage [data-feed-live]').count()) === 0);
    const ph = await page.locator('.aiteam-stage .chat-cmp-input').first().getAttribute('placeholder').catch(() => '');
    check('the composer says writing there starts a new conversation', /new conversation with Herodot/i.test(ph ?? ''), ph ?? '');
    await shot('1-card');

    await card.locator('.chat-runcard-play').click();
    check('▶ runs it in the card and it reports back', await until(async () => /Reported back to the agent/.test(await card.innerText()), 20000), (await card.innerText().catch(() => '')).slice(-120));
    check('the run itself continued: its answer lands under the same run',
      await until(async () => (await pane.innerText()).includes('Got it: the login finished (exit 0)'), 45000));
    await toEnd();
    await shot('2-reported');
    await context.close();
  } finally {
    await browser.close();
  }
}

const consoleErrors = [];
let srv = null;
try {
  setupScratch();
  const port = await freePort();
  srv = await startServer(port);
  await browserLeg(port, consoleErrors);
} catch (err) {
  check('the run completed', false, String(err?.stack ?? err));
} finally {
  srv?.kill();
}
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
