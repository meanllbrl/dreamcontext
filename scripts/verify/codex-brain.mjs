#!/usr/bin/env node
/**
 * The brain in a Codex chat, end to end (Track T W3).
 *
 *   npm run build && node scripts/verify/codex-brain.mjs
 *
 * Drives the real dashboard server, the real `/ws/agent-chat` route with `tool=codex`, the real
 * bridge child and the real React surface in Chromium, on a scratch HOME and a fictional vault.
 * `codex` is scripts/verify/fake-codex.mjs: a `BRAIN` prompt makes it answer with the lines of its
 * app context that mention the checkout, so the screen shows what the brain handed it.
 *
 * Checks: the Codex chat answers "what are we working on?" from the brain; the turn carried the
 * snapshot and the prompt hook as UNTRUSTED app context; the developer instructions carry no brain;
 * the brain MCP server is configured for this pane and works as a process (a task log lands);
 * the session lands in `.sleep.json` with its rollout and distills without the injected context;
 * nothing of the brain is drawn as chat text; a Claude chat is unchanged. Then 1440/1024/390 in
 * dark and light with no console errors. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-codex-brain');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = process.env.SHOTS_DIR || join(SCRATCH, 'shots');
const FIXTURES = join(REPO, 'src/vendor/t3/apps/server/src/orchestration-v2/testkit/fixtures');
const CLI = join(REPO, 'dist', 'index.js');
const LOG = join(SCRATCH, 'fake-codex.log');

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

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  const ctx = join(PROJ, '_dream_context');
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.codex'), join(ctx, 'state'), join(ctx, 'core'), join(ctx, 'knowledge'), SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), CLAUDE_STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.local', 'bin', 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${join(REPO, 'scripts/verify/fake-codex.mjs')}" "$@"\n`);
  chmodSync(join(HOME, '.local', 'bin', 'codex'), 0o755);
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{"note":"verify placeholder, not a credential"}');
  writeFileSync(join(HOME, '.codex', 'config.toml'), 'model = "gpt-6-luna"\n');
  writeFileSync(join(HOME, '.codex', 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
  ] }));
  writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: "acme-shop"\ntype: soul\nupdated: "2026-10-31"\n---\n\n## Project Identity\n\nAcme Shop is a fictional storefront. Current focus: the checkout redesign, three steps (cart, address, payment).\n');
  writeFileSync(join(ctx, 'knowledge', 'checkout.md'), '---\nname: Checkout flow\ndescription: How the checkout works\ntags: [checkout]\nupdated: "2026-10-31"\n---\n\nThe checkout has three steps: cart, address, payment. Payment needs the address first.\n');
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const env = { ...process.env, HOME };
  const add = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'proj', PROJ], { env, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
  const task = spawnSync(process.execPath, [CLI, 'tasks', 'create', 'Checkout redesign', '--why', 'A fictional fixture task for the Codex brain checks'], { cwd: PROJ, env, encoding: 'utf-8' });
  if (task.status !== 0) throw new Error(`tasks create failed: ${task.stderr || task.stdout}`);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', FAKE_CODEX_FIXTURES: FIXTURES, FAKE_CODEX_LOG: LOG, DREAMCONTEXT_T3_DEBUG: join(SCRATCH, 'bridge.log'), DREAMCONTEXT_CLI: CLI, DREAMCONTEXT_RECALL_CLOUD: '0', DREAMCONTEXT_BRAIN_SYNC: '0', DREAMCONTEXT_VERSION_CHECK: '0' },
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

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
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


/** One JSON-RPC exchange with `dreamcontext mcp serve`, as Codex would start it. */
function mcpCall(env, calls) {
  const lines = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ...calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: c }))];
  const r = spawnSync(process.execPath, [CLI, 'mcp', 'serve', '--root', PROJ], { env, input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', encoding: 'utf-8', timeout: 60_000 });
  return (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function main() {
  const { chromium } = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const browser = await chromium.launch();
  const ok = (label, cond, detail) => report.check('flow', label, cond, detail);
  const log = () => (existsSync(LOG) ? readFileSync(LOG, 'utf-8') : '');
  try {
    const { page, errors } = await openPage(browser, base);
    const h = helpers(page);
    if (!(await h.vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
    await h.until(async () => (await h.vis('.chat-cmp-input').count()) > 0);
    await h.send('ping');
    ok('a Claude chat is unchanged: the claude child answers', await h.waitText('CLAUDE SAYS: ping'));

    await page.locator('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]:visible').first().click();
    await page.waitForTimeout(400);
    await h.vis('.chat-cmp-modelmenu').first().getByRole('menuitemradio', { name: /Codex/ }).click();
    await page.waitForTimeout(2500);

    await h.send('BRAIN what are we working on, how does the checkout work?');
    ok('the Codex chat answers from the brain (the snapshot names the checkout redesign)', await h.waitText('From the brain:', 30000) && /From the brain: [^·]*checkout/i.test(await h.paneText()), (await h.paneText()).slice(-400));
    ok('…and recall arrived on the same turn', /Recall: [^·]*checkout/i.test(await h.paneText()), (await h.paneText()).slice(-300));
    await h.settled();
    await page.screenshot({ path: join(SHOTS, 'codex-answers-from-brain.png') });

    const text = await h.paneText();
    ok('no brain text is drawn as chat text (only the answer quoting it)', !text.includes('Agent Context') && !text.includes('external_dreamcontext'), text.slice(0, 300));
    const l = log();
    const first = l.split('\n').find((x) => x.includes('turn/start additionalContext dreamcontext') && x.includes('dreamcontext-brain:')) ?? l.split('\n').find((x) => x.includes('turn/start additionalContext')) ?? '';
    ok('the turn carried the snapshot and the prompt hook as untrusted app context', /dreamcontext-brain:untrusted:\d+/.test(first) && /dreamcontext-prompt:untrusted:\d+/.test(first), first);
    ok('developer instructions carry no brain content', /devHasBrain=false/.test(l) && !/devHasBrain=true/.test(l), l.split('\n').find((x) => x.includes('config keys')) ?? '');
    ok('a project\'s own Codex hooks are told the bridge injects (DREAMCONTEXT_CONTEXT_BY=bridge)', /context_by=bridge/.test(l));
    const mcpArgs = l.split('\n').find((x) => x.includes('mcp args=')) ?? '';
    ok('the brain MCP server is configured for this project', mcpArgs.includes('"mcp", "serve", "--root"') && mcpArgs.includes(PROJ), mcpArgs);
    const mcpEnv = l.split('\n').find((x) => x.includes('mcp env=')) ?? '';
    const roster = JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), 'utf-8'));
    const pane = roster.sessions.find((x) => x.tool === 'codex')?.sessionId ?? '';
    ok('…keyed by this pane (DREAMCONTEXT_TAB_SESSION)', !!pane && mcpEnv.includes(pane), `${pane} ${mcpEnv}`);

    // Sleep sees the chat: its Stop hook ran with the rollout.
    const sleepFile = join(PROJ, '_dream_context', 'state', '.sleep.json');
    let session = null;
    await h.until(async () => {
      if (!existsSync(sleepFile)) return false;
      const st = JSON.parse(readFileSync(sleepFile, 'utf-8'));
      session = (st.sessions ?? []).find((s) => typeof s.transcript_path === 'string' && /rollout-.*\.jsonl$/.test(s.transcript_path)) ?? null;
      return !!session;
    }, 20000);
    ok('the Codex session is recorded for sleep with its rollout', !!session, existsSync(sleepFile) ? readFileSync(sleepFile, 'utf-8').slice(0, 300) : 'no .sleep.json');
    if (session) {
      const env = { ...process.env, HOME, DREAMCONTEXT_RECALL_CLOUD: '0', DREAMCONTEXT_VERSION_CHECK: '0' };
      const d = spawnSync(process.execPath, [CLI, 'transcript', 'distill', session.session_id, '--full'], { cwd: PROJ, env, encoding: 'utf-8' });
      ok('distill shows the owner\'s words and the answer, not the injected brain', d.stdout.includes('how does the checkout work') && d.stdout.includes('From the brain') && !d.stdout.includes('Agent Context') && !d.stdout.includes('external_dreamcontext'), (d.stdout || d.stderr).slice(0, 400));
      writeFileSync(join(SHOTS, 'distill.txt'), d.stdout);
    }

    // The brain MCP server as Codex starts it: a task log lands, a foreign verb is refused.
    const env = { ...process.env, HOME, DREAMCONTEXT_TAB_SESSION: pane, DREAMCONTEXT_RECALL_CLOUD: '0', DREAMCONTEXT_VERSION_CHECK: '0' };
    const replies = mcpCall(env, [
      { name: 'dreamcontext', arguments: { args: ['tasks', 'log', 'checkout-redesign', 'Decided from a Codex chat: payment stays last.'] } },
      { name: 'dreamcontext', arguments: { args: ['window', 'new'] } },
      { name: 'dreamcontext', arguments: { args: ['tasks', 'insert', 'checkout-redesign', 'notes', '--file', '/etc/hosts'] } },
    ]);
    const taskText = readFileSync(join(PROJ, '_dream_context', 'state', 'checkout-redesign.md'), 'utf-8');
    ok('the brain MCP server writes a task log', taskText.includes('payment stays last'), JSON.stringify(replies[1] ?? {}).slice(0, 300));
    ok('…and refuses a verb off its list and a path outside the vault', replies[2]?.result?.isError === true && replies[3]?.result?.isError === true, JSON.stringify(replies.slice(2)).slice(0, 300));
    report.notes.push(...errors);
    await page.close();

    for (const theme of ['dark', 'light']) {
      for (const width of [1440, 1024, 390]) {
        const { page: p, errors: errs } = await openPage(browser, base, { width, height: width === 390 ? 844 : 900, theme });
        const hp = helpers(p);
        const nav = p.locator('nav, aside').getByText('Chat', { exact: true }).first();
        if (await nav.count() && await nav.isVisible().catch(() => false)) await nav.click({ force: true }).catch(() => {});
        await p.waitForTimeout(1500);
        const tabs = p.locator('.agent-tab-title:visible');
        for (let i = 0; i < await tabs.count(); i++) {
          await tabs.nth(i).click().catch(() => {});
          await p.waitForTimeout(800);
          if ((await hp.paneText()).includes('From the brain')) break;
        }
        const shown = await hp.waitText('From the brain', 15000);
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        await p.screenshot({ path: join(SHOTS, `codex-brain-${theme}-${width}.png`) });
        report.check(`${theme}-${width}`, 'the Codex chat with its brain answer renders', shown);
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
