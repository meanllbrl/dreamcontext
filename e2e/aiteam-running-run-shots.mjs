#!/usr/bin/env node
/**
 * AI Team: a teammate's routine run IN FLIGHT shows as working in its conversation, the way the
 * team list says "Working · 1m 30s" — not a still prompt above "New conversation · now".
 *
 *   npm run build && node e2e/aiteam-running-run-shots.mjs [out-dir]
 *
 * WHAT IT DRIVES: the BUILT dashboard server (of `DC_REPO`, default this checkout) against an
 * isolated scratch vault (fake HOME, DREAMCONTEXT_DESKTOP=1) and real Chromium at 1440 px.
 * Fictional fixtures: "Herodot", the agent of a project called "Acme Notes". One run finished
 * this morning; one started a minute ago and has only its prompt. Checked:
 *   - the running run's end carries the working indicator, above "New conversation · now";
 *   - once the run posts and ends, the post lands and the indicator leaves (fast re-read).
 *
 * Screenshots: <out-dir>/1440-1-running.png, 1440-2-finished.png. Exit 1 on any FAIL.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, setTheme } from '../scripts/verify/lib/measure.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.DC_REPO ? resolve(process.env.DC_REPO) : HERE;
const SHOTS = resolve(process.argv[2] ?? join(HERE, 'tmp', 'verify-aiteam-running-run'));
mkdirSync(SHOTS, { recursive: true });
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-aiteam-running-run');
rmSync(SCRATCH, { recursive: true, force: true });
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme');
const DC = join(PROJ, '_dream_context');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`);
};
const cli = (...args) => spawnSync(process.execPath, [distIndex(REPO), ...args], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
const must = (label, r) => { if (r.status !== 0) throw new Error(`${label} failed: ${r.stderr || r.stdout}`); return r; };

let seq = 0;
const idAt = (ms) => `${Math.floor(ms).toString(36).padStart(9, '0')}_${(seq++ % 1296).toString(36).padStart(2, '0')}v${String(seq).padStart(3, '0')}`;
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** One thread entry, appended to its day file (the store's own shape). */
function entry(slug, at, e) {
  const d = new Date(at);
  const path = join(DC, 'automations', 'threads', slug, `${localDay(d)}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const full = { id: idAt(e.idAt ?? at), via: 'runner', text: '', ...e, at: d.toISOString() };
  delete full.idAt;
  appendFileSync(path, `<!-- dc-thread-entry -->\n\`\`\`json\n${JSON.stringify(full)}\n\`\`\`\n\n`);
  return full;
}

const SLUG = 'herodot-desk';
let RUNNING = '';
function setupScratch() {
  for (const d of [join(HOME, '.dreamcontext'), join(DC, 'state'), join(DC, 'knowledge')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(DC, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false } }));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true,
    screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  must('vaults add', cli('vaults', 'add', 'acme', PROJ));
  must('agents create', cli('agents', 'create', 'herodot', '--title', 'Herodot', '--prompt', 'Herodot answers the fictional Acme support inbox.'));
  must('routine', cli('automations', 'create', SLUG, '--title', 'Herodot desk', '--agent', 'herodot', '--job', 'Go through the Acme inbox and draft replies.', '--days', 'daily', '--at', '09:00'));
  // This morning's run, finished.
  const m = new Date(); m.setHours(Math.max(0, m.getHours() - 3), 0, 0, 0);
  const done = m.toISOString();
  entry(SLUG, m.getTime(), { runId: done, kind: 'system', event: 'started' });
  entry(SLUG, m.getTime() + 60_000, { runId: done, kind: 'agent', text: 'Morning round: 4 open threads in the Acme inbox, drafts are in the report.' });
  entry(SLUG, m.getTime() + 120_000, { runId: done, kind: 'system', event: 'ok' });
}

/** A run that started a minute ago: its prompt, nothing posted yet, no end. Seeded once the server
 *  is up — its startup sweep closes a reply in flight that no process holds ("server restarted"). */
function seedRunning() {
  const r = Date.now() - 60_000;
  RUNNING = new Date(r).toISOString();
  // Ids from now: written under THIS server process, as a run in flight would be.
  entry(SLUG, r, { runId: RUNNING, kind: 'system', event: 'started', idAt: Date.now() });
  entry(SLUG, r + 1000, { runId: RUNNING, idAt: Date.now() + 1, kind: 'user', via: 'dashboard', text: 'Go through the Acme inbox, list the unanswered threads and draft a reply for each. Send nothing.' });
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
  const srv = spawn(process.execPath, [distIndex(REPO), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
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
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    const wait = (ms) => page.waitForTimeout(ms);
    const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(200); } return false; };
    const shot = async (name) => { await wait(500); await page.screenshot({ path: join(SHOTS, `1440-${name}.png`) }); };

    await page.goto(`${base}/?vault=acme`, { waitUntil: 'domcontentloaded' });
    await wait(2000);
    for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await wait(300); }
    await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^AI Team$/ }) }).first().click();
    await page.locator('.aiteam').waitFor({ timeout: 15000 });
    await page.locator('[data-team-row="herodot"]').click();
    const pane = page.locator('.aiteam-stage .chat-pane');
    const key = `${SLUG}::${RUNNING}`;
    const boundary = page.locator(`.aiteam-stage [data-feed-boundary="${key}"]`);
    check('the running run is in the stage, its boundary says running', await until(async () => /running/.test(await boundary.innerText()), 20000), await boundary.innerText().catch(() => ''));
    await page.locator('.aiteam-stage .chat-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const working = page.locator(`.aiteam-stage [data-feed-working="${key}"]`);
    const order = async () => pane.evaluate((el, k) => {
      const w = el.querySelector(`[data-feed-working="${CSS.escape(k)}"]`);
      const live = el.querySelector('[data-feed-live]');
      return !!w && !!live && (w.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }, key);
    check('…and its end says it is working, above "New conversation · now"', await until(async () => (await working.isVisible()) && await order(), 5000));
    await shot('1-running');

    // The run posts its result and ends: within a fast re-read the post lands, the indicator leaves.
    const t = Date.now();
    entry(SLUG, t, { runId: RUNNING, kind: 'agent', text: '3 unanswered threads in the Acme inbox. Drafts are ready for your approval; nothing was sent.' });
    entry(SLUG, t + 1000, { runId: RUNNING, kind: 'system', event: 'ok' });
    const landed = await until(async () => (await pane.innerText()).includes('Drafts are ready for your approval') && (await working.count()) === 0, 15000);
    check('once the run ends, its post lands and the working row leaves (within 15 s)', landed);
    await page.locator('.aiteam-stage .chat-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await shot('2-finished');
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
  seedRunning();
  await new Promise((r) => setTimeout(r, 1000));
  const hist = await (await fetch(`http://127.0.0.1:${port}/api/agents/herodot/history`)).json();
  const live = hist.sessions?.find((x) => x.key === `${SLUG}::${RUNNING}`);
  check('server: the run in flight is reported running', live?.status === 'running', JSON.stringify({ status: live?.status, durationMs: live?.durationMs }));
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
