#!/usr/bin/env node
/**
 * A Codex chat in the real app, end to end (Track T W1).
 *
 *   npm run build && npm run verify:tool-codex-chat
 *
 * WHAT IT DRIVES — the real dashboard server (dist/index.js), the real `/ws/agent-chat` route with
 * `tool=codex`, the real bridge child (`dreamcontext t3-chat`, T3's CodexAdapterV2 inside) and the
 * real React surface in Chromium.
 *
 * WHAT IT DOES NOT SPEND — tokens. `codex` is scripts/verify/fake-codex.mjs, which answers with
 * T3's RECORDED Codex app-server frames; `claude` is a tiny stand-in, only there to prove a Claude
 * chat in the same window is unchanged. Both live in an isolated fake HOME.
 *
 * Checks: a Codex row in the model menu; a Codex chat streams, names its tab, asks an approval with
 * the command in our card, asks a question in our card, shows a file change, stops on Stop, keeps
 * its history after a reload AND after a server restart (resumes its own thread). Then screenshots at
 * 1440/1024/390 in dark and light, with console errors and failed requests recorded.
 * FAILURE POLICY — collect, don't fail fast; exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-tool-codex');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = process.env.SHOTS_DIR || join(SCRATCH, 'shots');
const FIXTURES = join(REPO, 'src/vendor/t3/apps/server/src/orchestration-v2/testkit/fixtures');

const CLAUDE_STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    out({ type: 'system', subtype: 'init', session_id: 'claude-verify', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CLAUDE SAYS: ' + text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'claude-verify' });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.codex'), join(PROJ, '_dream_context', 'state'), SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), CLAUDE_STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.local', 'bin', 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${join(REPO, 'scripts/verify/fake-codex.mjs')}" "$@"\n`);
  chmodSync(join(HOME, '.local', 'bin', 'codex'), 0o755);
  // A signed-in Codex, as the registry reads it: presence of auth.json, a default model, its model cache.
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{"note":"verify placeholder, not a credential"}');
  writeFileSync(join(HOME, '.codex', 'config.toml'), 'model = "gpt-6-luna"\n');
  writeFileSync(join(HOME, '.codex', 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
    { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] },
  ] }));
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', FAKE_CODEX_FIXTURES: FIXTURES, FAKE_CODEX_LOG: join(SCRATCH, 'fake-codex.log'), DREAMCONTEXT_T3_DEBUG: join(SCRATCH, 'bridge.log'), DREAMCONTEXT_CLI: join(REPO, 'dist', 'index.js') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const report = {
  results: [],
  notes: [],
  check(ctx, label, cond, detail) {
    this.results.push({ ctx, label, ok: !!cond, detail });
    console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `  — ${String(detail).slice(0, 200)}` : ''}`);
  },
  note(s) { this.notes.push(s); },
};

/** Bring the Codex chat on screen: a reload or restart may land on another page with the
 *  restored chats docked bottom-right. */
async function showCodexChat(page) {
  const nav = page.locator('nav, aside').getByText('Chat', { exact: true }).first();
  if (await nav.count() && await nav.isVisible().catch(() => false)) {
    await nav.click({ force: true }).catch(() => {});
  } else {
    // A narrow window: the sidebar is icons only, the restored chats sit in the dock.
    const dock = page.getByText('Codex verify chat', { exact: true }).last();
    if (await dock.count()) await dock.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(2000);
  const tab = page.locator('.agent-tab-title:visible', { hasText: 'Codex verify chat' }).first();
  if (await tab.count()) await tab.click().catch(() => {});
  await page.waitForTimeout(1500);
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

async function openPage(browser, base, { width = 1440, height = 960, theme = 'dark' } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 200)}`); });
  page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ''}`); });
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await expandSurface(page);
  return { page, errors };
}

function helpers(page) {
  const vis = (sel) => page.locator(`${sel}:visible`);
  const pane = () => vis('.chat-pane').first();
  const paneText = async () => ((await pane().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); } return false; };
  const busy = async () => (await vis('.chat-cmp-send.is-stop').count()) > 0;
  const send = async (t) => { const c = vis('.chat-cmp-input').first(); await c.click(); await c.fill(t); await page.waitForTimeout(100); await page.keyboard.press('Enter'); };
  const waitText = (s, ms = 25000) => until(async () => (await paneText()).includes(s), ms);
  /** The turn has ENDED (its result arrived): no Stop button, settled for a moment. */
  const settled = async () => { await until(async () => !(await busy()), 20000); await page.waitForTimeout(1500); return until(async () => !(await busy()), 5000); };
  return { vis, pane, paneText, until, busy, send, waitText, settled };
}

async function main() {
  const { chromium } = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let srv = await startServer(port);
  const browser = await chromium.launch();
  const ok = (label, cond, detail) => report.check('flow', label, cond, detail);
  try {
    // ── The flow, once, in dark at desktop width ──
    const { page, errors } = await openPage(browser, base);
    const h = helpers(page);
    if (!(await h.vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
    ok('a chat opens (Claude, the default)', await h.until(async () => (await h.vis('.chat-cmp-input').count()) > 0));
    await h.send('ping');
    ok('a Claude chat is unchanged: the claude child answers', await h.waitText('CLAUDE SAYS: ping'));

    // The MODEL trigger (the mode menu's trigger shares its class): found by its title.
    await page.locator('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]:visible').first().click();
    await page.waitForTimeout(400);
    const menu = h.vis('.chat-cmp-modelmenu').first();
    ok('the model menu has a Tool group with a Codex row', (await menu.getByRole('menuitemradio', { name: /Codex/ }).count()) === 1);
    await page.screenshot({ path: join(SHOTS, 'menu-tool-row.png') });
    await menu.getByRole('menuitemradio', { name: /Codex/ }).click();
    await page.waitForTimeout(2500);
    ok('picking Codex opens a NEW chat beside the Claude one', (await h.paneText()).includes('CLAUDE SAYS') === false);

    await h.send('hello codex');
    ok('Codex text streams into the chat', await h.waitText('fixture simple ok'));
    ok('the tab is named by the agent', await h.until(async () => ((await h.vis('.agent-tab-title').allInnerTexts()).join('|')).includes('Codex verify chat'), 15000), (await h.vis('.agent-tab-title').allInnerTexts()).join('|'));
    await h.settled();

    await h.send('APPROVE this command');
    ok('an approval card opens', await h.until(async () => (await h.vis('.chat-permcard').count()) > 0, 20000));
    const card = (await h.vis('.chat-permcard').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    ok('the card names the command it approves', card.includes('.codex-probe-write-action.txt'), card);
    await page.screenshot({ path: join(SHOTS, 'approval-card.png') });
    const allow = async () => {
      await page.locator('.chat-permcard:visible .chat-btn.primary').first().click();
      return h.until(async () => (await h.vis('.chat-permcard').count()) === 0, 8000);
    };
    ok('Allow closes the card', await allow());
    ok('after Allow the turn finishes with Codex\'s own answer', await h.waitText('Created or overwrote'));
    await h.settled();

    await h.send('QUESTION for me');
    ok('a question card opens', await h.until(async () => (await h.vis('.chat-surveycard').count()) > 0, 20000));
    await page.screenshot({ path: join(SHOTS, 'question-card.png') });
    await h.vis('.chat-surveycard-opt').first().click();
    await page.waitForTimeout(400);
    for (const name of [/^Submit/, /^Send/, /^Done/, /^Answer/]) {
      const b = page.getByRole('button', { name }).first();
      if (await b.count()) { await b.click().catch(() => {}); break; }
    }
    ok('the answer reaches Codex and the turn completes', await h.waitText('plan questions fixture complete'));
    await h.settled();

    await h.send('DIFF please');
    ok('a file-change approval opens', await h.until(async () => (await h.vis('.chat-permcard').count()) > 0, 20000));
    ok('Allow closes the file-change card', await allow());
    ok('the file change finishes', await h.waitText('with exactly:'));
    ok('the change is drawn as a tool card naming the file', (await h.paneText()).includes('.codex-probe-write-action.txt'));
    await page.screenshot({ path: join(SHOTS, 'diff.png') });
    await h.settled();

    await h.send('INTERRUPT soon');
    ok('a long turn starts', await h.until(h.busy, 15000));
    await page.waitForTimeout(1200);
    await h.vis('.chat-cmp-send.is-stop').first().click();
    ok('Stop ends it', await h.until(async () => !(await h.busy()), 20000));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await showCodexChat(page);
    await page.screenshot({ path: join(SHOTS, 'after-reload.png') });
    ok('after a reload the Codex chat shows its history', await h.waitText('fixture simple ok', 20000), (await h.paneText()).slice(0, 300));
    report.notes.push(...errors);
    await page.close();

    // ── A server restart: the roster restores the tab and the bridge RESUMES its thread ──
    srv.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2500));
    srv = await startServer(port);
    const r2 = await openPage(browser, base);
    const h2 = helpers(r2.page);
    await showCodexChat(r2.page);
    await r2.page.screenshot({ path: join(SHOTS, 'after-restart.png') });
    ok('after a server restart the Codex tab is back with its history', await h2.waitText('fixture simple ok', 25000), (await h2.paneText()).slice(0, 300));
    await h2.send('hello again');
    ok('and it answers on its resumed thread', await h2.until(async () => ((await h2.paneText()).match(/fixture simple ok/g) ?? []).length >= 2, 25000));
    // ── Eco: a handoff record for this pane rotates it into a fresh Codex thread ──
    const state = join(PROJ, '_dream_context', 'state');
    const roster = JSON.parse(readFileSync(join(state, '.agent-sessions.json'), 'utf-8'));
    const pane = roster.sessions.find((x) => x.tool === 'codex')?.sessionId;
    const mapFile = join(state, '.agent-session-map', `${pane}.json`);
    const before = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf-8')).current : '';
    ok('the Codex pane is in the roster with its tool, and its thread is in the tab map', !!pane && !!before, `${pane} ${before}`);
    const tab = JSON.parse(readFileSync(join(state, '.context-watch', `tab-${pane}.json`), 'utf-8').toString() || '{}');
    ok('the Codex pane got its Eco seed (tab-<pane>.json)', typeof tab.enabled === 'boolean', JSON.stringify(tab));
    mkdirSync(join(state, '.handoff-requests'), { recursive: true });
    const recPath = join(state, '.handoff-requests', `${pane}.json`);
    writeFileSync(recPath, JSON.stringify({ task: 'acme-checkout', title: 'Checkout redesign', at: new Date().toISOString(), contextTokens: 190000, fromSession: before, tab: pane }));
    await h2.send('hello rotate');
    const rotated = await h2.until(async () => {
      const rec = existsSync(recPath) ? JSON.parse(readFileSync(recPath, 'utf-8')) : {};
      const now = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf-8')).current : '';
      return !!rec.actedAt && !!rec.consumedAt && now && now !== before;
    }, 30000);
    ok('a handoff record rotates the pane into a fresh Codex thread (record acted on and consumed)', rotated, readFileSync(recPath, 'utf-8'));
    await r2.page.screenshot({ path: join(SHOTS, 'eco-rotation.png') });
    report.notes.push(...r2.errors);
    await r2.page.close();

    // ── The look: 1440 / 1024 / 390, dark and light ──
    for (const theme of ['dark', 'light']) {
      for (const width of [1440, 1024, 390]) {
        const { page: p, errors: errs } = await openPage(browser, base, { width, height: width === 390 ? 844 : 900, theme });
        const hp = helpers(p);
        await showCodexChat(p);
        const shown = await hp.waitText('fixture simple ok', 20000);
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        await p.screenshot({ path: join(SHOTS, `codex-chat-${theme}-${width}.png`) });
        report.check(`${theme}-${width}`, 'the Codex chat renders', shown);
        report.check(`${theme}-${width}`, 'no horizontal overflow', overflow <= 1, `overflow ${overflow}px`);
        const real = errs.filter((e) => !/ResizeObserver loop/.test(e));
        report.check(`${theme}-${width}`, 'no console errors or failed requests', real.length === 0, real.join(' | '));
        await p.close();
      }
    }
  } finally {
    await browser.close();
    srv.kill('SIGTERM');
  }
  const failed = report.results.filter((r) => !r.ok);
  console.log(`\n${report.results.length - failed.length}/${report.results.length} checks passed · screenshots in ${SHOTS}`);
  if (report.notes.length) console.log(`notes:\n  ${report.notes.slice(0, 20).join('\n  ')}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
