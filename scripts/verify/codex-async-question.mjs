#!/usr/bin/env node
/**
 * A Codex chat asks the owner a question (owner 2026-11-03 "codex bana soru soramıyor").
 *
 *   npx tsup && node scripts/verify/codex-async-question.mjs              # fake Codex: its recorded async-question frames, no cost
 *   CODEX=real CODEX_AUTH=<a spare account's auth.json> node scripts/verify/codex-async-question.mjs   # the real Codex CLI (spends quota)
 *   CLI=/path/to/other/dist/index.js node scripts/verify/codex-async-question.mjs   # e.g. a release, to see the bug
 *   CODEX_AUTH is required with CODEX=real and should be a spare account: Codex may refresh the copied
 *   token during the run, and the copy is deleted after, so the source file can hold a spent token.
 *
 * Codex asks with `request_user_input_async`: it ends its turn and reads the answer as the next
 * message. Drives the real dashboard server, the real `/ws/agent-chat` route with the real bridge
 * and `codex` (scripts/verify/fake-codex.mjs ASYNCASK, or the real one with CODEX=real: only its
 * sign-in is copied in, and removed after), on a scratch HOME and a fictional vault. Checks: the question card is on screen after the turn ended, a pick goes back
 * to Codex, and Codex answers with the pick. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-codex-async-question');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = process.env.SHOTS_DIR || join(SCRATCH, 'shots');
const TAG = process.env.TAG || 'after';
const CLI = process.env.CLI || join(REPO, 'dist', 'index.js');
const REAL = process.env.CODEX === 'real';
const REAL_CODEX = REAL ? spawnSync('sh', ['-lc', 'command -v codex'], { encoding: 'utf-8' }).stdout.trim() : '';
const FIXTURES = join(REPO, 'src/vendor/t3/apps/server/src/orchestration-v2/testkit/fixtures');

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  const ctx = join(PROJ, '_dream_context');
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.codex'), join(ctx, 'state'), join(ctx, 'core'), SHOTS]) mkdirSync(d, { recursive: true });
  if (REAL && !REAL_CODEX) throw new Error('codex is not installed');
  writeFileSync(join(HOME, '.local', 'bin', 'codex'), REAL
    ? `#!/bin/sh\nexec "${REAL_CODEX}" "$@"\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${join(REPO, 'scripts/verify/fake-codex.mjs')}" "$@"\n`);
  // The chat surface needs a Claude on PATH to open; this one is never asked anything.
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n`);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'classic' }));
  chmodSync(join(HOME, '.local', 'bin', 'codex'), 0o755);
  // Only the sign-in: never the owner's sessions, config or tool servers.
  if (REAL) {
    if (!process.env.CODEX_AUTH) throw new Error('CODEX=real needs CODEX_AUTH=<a spare account auth.json>');
    copyFileSync(process.env.CODEX_AUTH, join(HOME, '.codex', 'auth.json'));
    chmodSync(join(HOME, '.codex', 'auth.json'), 0o600);
    const cache = join(homedir(), '.codex', 'models_cache.json');
    if (existsSync(cache)) copyFileSync(cache, join(HOME, '.codex', 'models_cache.json'));
  } else {
    writeFileSync(join(HOME, '.codex', 'auth.json'), '{"note":"verify placeholder, not a credential"}');
    writeFileSync(join(HOME, '.codex', 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
    ] }));
  }
  writeFileSync(join(HOME, '.codex', 'config.toml'), 'model = "gpt-6-luna"\n');
  writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: "acme-shop"\ntype: soul\nupdated: "2026-11-03"\n---\n\n## Project Identity\n\nAcme Shop is a fictional storefront.\n');
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const add = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_T3_DEBUG: join(SCRATCH, 'bridge.log'), FAKE_CODEX_FIXTURES: FIXTURES, FAKE_CODEX_LOG: join(SCRATCH, 'fake-codex.log'), DREAMCONTEXT_CLI: CLI, DREAMCONTEXT_RECALL_CLOUD: '0', DREAMCONTEXT_BRAIN_SYNC: '0', DREAMCONTEXT_VERSION_CHECK: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  srv.stdout.on('data', (c) => { said += c; });
  srv.stderr.on('data', (c) => { said += c; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error(`dashboard server did not come up: ${said.slice(-800)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function expandSurface(page) {
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
}

const results = [];
/** The dashboard server, killed with the run however it ends (its Codex could write a sign-in). */
let srv = null;
const ok = (label, cond, detail) => {
  results.push(!!cond);
  console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `  (${String(detail).slice(0, 300)})` : ''}`);
};

async function main() {
  const { chromium } = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  srv = await startServer(port);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.goto(`http://127.0.0.1:${port}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await expandSurface(page);
    const vis = (sel) => page.locator(`${sel}:visible`);
    const paneText = async () => ((await vis('.chat-pane').first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(250); } return false; };
    const busy = async () => (await vis('.chat-cmp-send.is-stop').count()) > 0;
    const send = async (t) => { const c = vis('.chat-cmp-input').first(); await c.click(); await c.fill(t); await page.waitForTimeout(100); await page.keyboard.press('Enter'); };

    if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
    await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000);
    await vis('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]').first().click();
    await page.waitForTimeout(400);
    const picker = () => vis('[data-testid="model-picker"]').first();
    await picker().getByRole('button', { name: 'Codex', exact: true }).click();
    await page.waitForTimeout(400);
    await picker().getByRole('menuitemradio').first().click();
    const sheet = () => page.getByRole('alertdialog').first();
    if (await until(async () => (await sheet().count()) > 0, 4000)) await sheet().getByRole('button', { name: /Open new chat/ }).click();
    ok('the chat runs on Codex', await until(async () => /Message Codex/.test((await vis('.chat-cmp-input').first().getAttribute('placeholder').catch(() => '')) ?? ''), 45000));

    await send('ASYNCASK Ask me exactly one question with your request_user_input_async tool: title "Which color?", options "Red" and "Blue". After my answer arrives, reply with exactly: PICKED <my answer>.');
    const card = () => vis('.chat-surveycard').first();
    const shown = await until(async () => (await vis('.chat-surveycard').count()) > 0 && !(await card().getAttribute('data-state')), 120000);
    // The turn that asked has ended on Codex's side: the card must still be there.
    await page.waitForTimeout(6000);
    const stillShown = (await vis('.chat-surveycard').count()) > 0 && !(await card().getAttribute('data-state'));
    await page.screenshot({ path: join(SHOTS, `codex-question-${TAG}.png`) });
    ok('the question card is on screen', shown, (await paneText()).slice(-400));
    ok('the card stays open after Codex ended the turn that asked', stillShown, (await paneText()).slice(-400));
    if (!shown || !stillShown) return;
    const optionText = (await card().innerText()).replace(/\s+/g, ' ');
    ok('the card carries the question and both options', /Which color/i.test(optionText) && /Red/.test(optionText) && /Blue/.test(optionText), optionText);

    await vis('.chat-surveycard-opt').filter({ hasText: 'Blue' }).first().click();
    await vis('.chat-surveycard .chat-btn.primary').first().click();
    const answered = await until(async () => /PICKED\s*:?\s*Blue/i.test(await paneText()), 120000);
    await until(async () => !(await busy()), 60000);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(SHOTS, `codex-answer-${TAG}.png`) });
    ok('the pick reached Codex and it answered with it', answered, (await paneText()).slice(-400));
    ok('the turn ended (no Stop button)', !(await busy()));
    ok('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    srv.kill();
    srv = null;
  }
}

/** The copied sign-in never outlives the run, however it ends. */
const dropSignIn = () => rmSync(join(HOME, '.codex'), { recursive: true, force: true });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { srv?.kill(); dropSignIn(); process.exit(130); });

main().finally(dropSignIn).then(() => {
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed (screenshots: ${SHOTS})`);
  process.exit(failed || !results.length ? 1 : 0);
}).catch((err) => { console.error(err); process.exit(1); });
