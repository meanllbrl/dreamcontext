#!/usr/bin/env node
/**
 * verify:super-jarvis — the JARVIS phase of the Super Agent (jarvis plan r9), against the REAL
 * dashboard server (this worktree's `dist/`) in Chromium, with a stand-in `claude` on PATH and a
 * scratch HOME. Nothing here touches the owner's machine state.
 *
 * What it proves, in the window the owner uses:
 *  S1  a delegated child pins its dev server → a small site card opens with NO agent verb (by:auto);
 *  G1  a card arriving while the owner types in the super composer waits until he stops;
 *  T6  the site card asks first: "Open once" / "Always allow localhost:PORT", the buttons asleep
 *      for 600 ms; "Always allow" loads the page, and after a SERVER RESTART it loads without asking;
 *  T1  the dashboard's own port is refused for a web card (`owned-port`);
 *  T0/T3 the dev-server page's own JS cannot open the chat socket nor create an automation;
 *  T1b the dashboard inside the dev server's frame gets 403;
 *  S2  the child's Playwright call opens a live browser card; idle (shortened clock) → Others;
 *  G3  a third automatic card sends the oldest to Others;
 *  AC16 the delegate cue (the card flies out of the centre), the close fade: a filmstrip + video;
 *  AC13-style screenshots at 1280 and 1800, light and dark; console errors recorded.
 *
 * Run: npm run build && npm run verify:super-jarvis. Output: tmp/verify-super-jarvis/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-jarvis-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-jarvis');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-jarvis-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const pin = (port) => say('The dev server runs.\\n\\n\\\`\\\`\\\`dream-view\\n' + JSON.stringify({ type: 'pin', id: 'dev-' + port, weight: 'tag', facts: [{ label: ':' + port, url: 'http://localhost:' + port }] }) + '\\n\\\`\\\`\\\`\\n');
let inited = false;
async function superTurn(text) {
  if (text.startsWith('[super handover]')) { report({ kind: 'handover', text: text.slice(0, 500) }); return 'arranged'; }
  if (text.startsWith('[super')) return 'noted';
  const m = text.match(/GO-(DELEGATE|OPENOWN|CLOSE|OPENWEB|FLOAT)\\s*(\\S*)\\s*(\\S*)/);
  if (!m) return 'ok';
  const [, verb, a, b] = m;
  const steps = [];
  if (verb === 'DELEGATE') steps.push(cli('super', 'delegate', '--prompt', a + ' ' + b, '--brief', 'Site ' + b));
  if (verb === 'OPENOWN') steps.push(cli('super', 'open', 'web', 'http://127.0.0.1:' + a));
  if (verb === 'OPENWEB') steps.push(cli('super', 'open', 'web', a));
  if (verb === 'CLOSE') steps.push(cli('super', 'close', a));
  if (verb === 'FLOAT') steps.push(cli('super', 'half', '--off'));
  report({ kind: 'owner-' + verb.toLowerCase(), steps });
  return 'did ' + verb;
}
async function childTurn(text) {
  const p = text.match(/PIN (\\d+)/);
  if (p) { await sleep(1500); pin(p[1]); report({ kind: 'pinned', port: p[1] }); return 'pinned ' + p[1]; }
  if (text.includes('BROWSE')) {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b_' + process.pid, name: 'mcp__playwright__browser_navigate', input: { url: 'http://localhost:1' } }] } });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b_' + process.pid, content: [{ type: 'text', text: 'navigated' }] }] } });
    report({ kind: 'browsed' });
    return 'browsed';
  }
  return 'ok';
}
async function turn(blocks) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(blocks.join('')); } catch (e) { said = 'error ' + e; }
  say((role === 'super' ? 'SUPER ' : 'CHILD ') + said);
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
}
let buf = '';
let chain = Promise.resolve();
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks }) + '\\n');
    chain = chain.then(() => turn(blocks));
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

// ─── harness ────────────────────────────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_SUPER_BROWSER_IDLE_MS: '3000' });
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], children: {} }; } };

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  // A Playwright MCP server in the project: each chat's spawn overrides it (the live mirror).
  writeFileSync(join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } } }));
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  if (dc('tasks', 'create', 'Ship the signup page', '-w', 'A page for new users.').status !== 0) throw new Error('task create failed');
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(SCRATCH, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

/** A "dev server": a page whose own JS tries what an approved page must never do. */
function startDevServer(port, dashPort) {
  const html = `<!doctype html><meta charset="utf-8"><title>Acme signup</title>
<body style="font:16px system-ui;padding:24px;background:#f6f7fb"><h1 id="h">Acme signup (localhost:${port})</h1>
<p id="ws">ws: pending</p><p id="post">post: pending</p>
<script>
const ws = new WebSocket('ws://127.0.0.1:${dashPort}/api/agent/chat?vault=acme-app&bypass=1');
ws.onopen = () => { document.getElementById('ws').textContent = 'ws: OPENED'; };
ws.onerror = () => { document.getElementById('ws').textContent = 'ws: refused'; };
fetch('http://127.0.0.1:${dashPort}/api/automations', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ name: 'pwn', prompt: 'x' }) })
  .then((r) => { document.getElementById('post').textContent = 'post: ' + r.status; }, () => { document.getElementById('post').textContent = 'post: refused'; });
</script></body>`;
  const srv = createServer((req, res) => {
    if (req.url?.startsWith('/frame')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<iframe id="f" src="http://127.0.0.1:${dashPort}/" width="400" height="300"></iframe>`); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

const results = { pass: 0, fails: [], notes: [] };
const ok = (label, cond, detail) => {
  if (cond) { results.pass++; console.log(`  ✓ ${label}`); }
  else { results.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const note = (m) => { results.notes.push(m); console.log(`  · ${m}`); };
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};

async function openChat(page, base) {
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
}
const surfaceShown = (page) => page.locator('[data-testid="super-surface"]:visible').count().then((n) => n > 0);
const superComposer = (page) => page.locator('[data-testid="super-surface"] .chat-cmp-input:visible').first();
async function sayToSuper(page, text) {
  const input = superComposer(page);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
/** Every data-cue value any card took, recorded from the start (a MutationObserver). */
const watchCues = (page) => page.evaluate(() => {
  window.__cues = [];
  const seen = (el) => { const v = el.getAttribute?.('data-cue'); if (v) window.__cues.push({ v, kind: el.getAttribute('data-kind'), probe: el.dataset?.probe ?? null, t: Math.round(performance.now()) }); };
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'attributes') seen(m.target);
      for (const n of m.addedNodes ?? []) if (n.nodeType === 1) { seen(n); n.querySelectorAll?.('[data-cue]').forEach(seen); }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['data-cue'], subtree: true, childList: true });
});
const cues = (page) => page.evaluate(() => window.__cues ?? []);
const autoCards = () => record().containers.filter((c) => c.by === 'auto');

// ─── the flow ───────────────────────────────────────────────────────────────────────────
async function flow(pw, base, dashPort, devPorts, restart) {
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', recordVideo: { dir: join(OUT, 'video'), size: { width: 1600, height: 1000 } } });
  const page = await context.newPage();
  const errors = [];
  const consoleLog = createWriteStream(join(OUT, 'console.log'));
  page.on('console', (m) => { consoleLog.write(`[${m.type()}] ${m.text()}\n`); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n── hand over');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  const first = page.locator('.chat-cmp-input:visible').first();
  await first.click();
  await first.fill('hello');
  await page.keyboard.press('Enter');
  await until(page, async () => readNd(FRAMES).some((f) => f.role === 'child'), 30000);
  await page.waitForTimeout(1500);
  ok('the hand-over button shows', await until(page, async () => (await page.locator('[data-testid="super-handover-btn"]:visible').count()) > 0, 20000));
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the Super Agent surface shows', await until(page, () => surfaceShown(page)));
  await until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);
  await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000);
  await watchCues(page);

  console.log('\n── S1 + AC16: a delegated child pins its dev server; its card opens by itself');
  const strip = [];
  await sayToSuper(page, `GO-DELEGATE PIN ${devPorts[0]}`);
  ok('super delegate answered', await until(page, async () => reports().some((r) => r.kind === 'owner-delegate' && r.steps[0]?.status === 0), 40000), JSON.stringify(reports().find((r) => r.kind === 'owner-delegate')));
  // The filmstrip: taken from the moment the new chat card starts its flight out of the centre.
  await page.waitForSelector('[data-cue="delegate"]', { timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 8; i++) { const p = join(OUT, `strip-delegate-${i}.png`); await page.screenshot({ path: p, animations: 'allow' }); strip.push(p); await page.waitForTimeout(40); }
  ok('the delegated card played the delegate cue (flies out of the centre)', await until(page, async () => (await cues(page)).some((c) => c.v === 'delegate'), 8000), JSON.stringify(await cues(page)));
  ok('the child pinned its dev server', await until(page, async () => reports().some((r) => r.kind === 'pinned'), 40000));
  const siteRef = `http://localhost:${devPorts[0]}/`;
  ok('a web card for localhost opened with no agent verb (by:auto, of the child)', await until(page, async () => autoCards().some((c) => c.kind === 'web' && c.ref === siteRef && c.of), 15000), JSON.stringify(record().containers));
  ok('…drawn on the stage as a small tile', await until(page, async () => (await page.locator('[data-testid="super-container"][data-kind="web"]').count()) > 0, 8000));
  ok('…with the arrival highlight', await until(page, async () => (await cues(page)).some((c) => c.v === 'arrive' && c.kind === 'web'), 6000), JSON.stringify(await cues(page)));
  await page.screenshot({ path: join(OUT, 'jarvis-01-site-card.png') });

  console.log('\n── T6: the site asks first; Always allow loads it');
  await page.locator('[data-testid="super-container"][data-kind="web"]').first().click({ position: { x: 40, y: 40 } });
  ok('the half view shows the two buttons, no page loaded', await until(page, async () => (await page.getByTestId('web-loopback-prompt').count()) > 0, 10000)
    && (await page.locator('.super-card-frame[data-kind="web"] iframe').count()) === 0);
  const asleep = await page.locator('[data-testid="web-loopback-prompt"] button').first().isDisabled().catch(() => null);
  note(`buttons right after the card drew: disabled=${asleep}`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, 'jarvis-02-ask.png') });
  await page.locator('[data-testid="web-loopback-prompt"] button').nth(1).click();
  ok('"Always allow" loads the page in the card', await until(page, async () => (await page.locator('.super-card-frame[data-kind="web"] iframe').count()) > 0, 8000));
  const grants = (() => { try { return JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'loopback-grants.json'), 'utf-8')); } catch { return {}; } })();
  ok('the grant is on this machine, per vault, the port only', Object.values(grants).some((l) => Array.isArray(l) && l.some((g) => g.port === devPorts[0])), JSON.stringify(grants));
  await page.waitForTimeout(1500);
  const frame = page.frames().find((f) => f.url().startsWith(siteRef));
  const wsText = await frame?.locator('#ws').innerText().catch(() => '');
  const postText = await frame?.locator('#post').innerText().catch(() => '');
  ok('T0: the page\'s own JS cannot open the chat socket', /refused/.test(wsText ?? ''), wsText);
  ok('T3: …nor create an automation', !/post: 2\d\d/.test(postText ?? '') && !existsSync(join(PROJ, '_dream_context', 'automations', 'pwn.md')), postText);
  await page.screenshot({ path: join(OUT, 'jarvis-03-site-loaded.png') });

  console.log('\n── T1: the dashboard\'s own port is refused');
  await sayToSuper(page, `GO-OPENOWN ${dashPort}`);
  ok('super open web <dashboard port> → owned-port', await until(page, async () => /owned-port/.test(JSON.stringify(reports().find((r) => r.kind === 'owner-openown')?.steps ?? '')), 20000), JSON.stringify(reports().find((r) => r.kind === 'owner-openown')));

  console.log('\n── G1: a card arriving while the owner types waits for him');
  // Back to the floating stage (the agent's `super float`), so the next card lands in the orbit.
  await sayToSuper(page, 'GO-FLOAT');
  await until(page, async () => (await page.locator('[data-mode="float"]').count()) > 0, 15000);
  await page.waitForTimeout(800);
  await sayToSuper(page, `GO-DELEGATE PIN ${devPorts[1]}`);
  const input = superComposer(page);
  await input.click();
  const typingEnd = Date.now() + 6000;
  let heldSeen = false;
  const ref2 = `http://localhost:${devPorts[1]}/`;
  while (Date.now() < typingEnd) {
    await page.keyboard.type('a', { delay: 0 });
    await page.waitForTimeout(250);
    if (autoCards().some((c) => c.ref === ref2)) {
      const visible = await page.locator('.super-card-frame[data-kind="web"]:not(.super-card-frame--pending)').count();
      const all = await page.locator('.super-card-frame[data-kind="web"]').count();
      if (all > visible) heldSeen = true;
    }
  }
  ok('while typing, the new card is in the record but not shown', heldSeen);
  await input.fill('');
  ok('…it appears once typing stops', await until(page, async () => (await page.locator('.super-card-frame[data-kind="web"].super-card-frame--pending').count()) === 0, 8000));

  console.log('\n── G3: a third automatic card sends the oldest to Others');
  await sayToSuper(page, `GO-DELEGATE PIN ${devPorts[2]}`);
  await until(page, async () => autoCards().filter((c) => c.kind === 'web').length >= 3, 40000);
  await page.waitForTimeout(800);
  const webs = autoCards().filter((c) => c.kind === 'web');
  ok('at most two automatic cards float; the oldest went to Others', webs.filter((c) => c.place === 'float').length <= 2 && webs[0]?.place === 'others', JSON.stringify(webs.map((c) => [c.ref, c.place, !!c.pos])));

  console.log('\n── S2: the child\'s browser opens a live card; idle sends it to Others');
  await sayToSuper(page, 'GO-DELEGATE BROWSE now');
  ok('a browser card opened with no agent verb', await until(page, async () => autoCards().some((c) => c.kind === 'browser'), 40000), JSON.stringify(record().containers.map((c) => [c.kind, c.place])));
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, 'jarvis-04-browser-card.png') });
  ok('…and after the (shortened) idle clock it rests in Others', await until(page, async () => autoCards().find((c) => c.kind === 'browser')?.place === 'others', 20000), JSON.stringify(autoCards()));

  console.log('\n── AC16: a closed card fades out');
  const toClose = record().containers.find((c) => c.kind === 'web' && c.place === 'float');
  if (toClose) {
    // Mark the card's DOM node: the fade must play on THAT node (no remount of its view).
    await page.evaluate((id) => { const el = document.querySelector(`[data-container-id="${id}"]`); if (el) el.dataset.probe = 'same-node'; }, toClose.id);
    await sayToSuper(page, `GO-CLOSE ${toClose.id}`);
    ok('the closed card played the fade (close cue)', await until(page, async () => (await cues(page)).some((c) => c.v === 'close'), 15000), JSON.stringify(await cues(page)));
    const sameNode = await page.evaluate(() => (window.__cues ?? []).length >= 0 && [...document.querySelectorAll('[data-cue="close"]')].map((e) => e.dataset.probe ?? 'new-node'));
    const closeCues = (await cues(page)).filter((c) => c.v === 'close');
    ok('…on the same DOM node, its view not remounted', closeCues.length > 0 && closeCues.every((c) => c.probe === 'same-node'), JSON.stringify({ closeCues, sameNode }));
  }
  note(`cues seen: ${JSON.stringify([...new Set((await cues(page)).map((c) => c.v))])}`);

  console.log('\n── screenshots: 1280 and 1800, light and dark');
  for (const width of [1280, 1800]) {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(OUT, `jarvis-stage-${width}-${scheme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1600, height: 1000 });

  console.log('\n── T1b: the dashboard in the dev server\'s frame');
  const fp = await context.newPage();
  const frameResp = [];
  fp.on('response', (r) => { if (r.url().startsWith(`http://127.0.0.1:${dashPort}/`) && r.request().resourceType() === 'document') frameResp.push(r.status()); });
  await fp.goto(`http://127.0.0.1:${devPorts[0]}/frame`);
  await fp.waitForTimeout(1500);
  ok('a foreign frame of the dashboard gets 403', frameResp.includes(403), JSON.stringify(frameResp));
  await fp.screenshot({ path: join(OUT, 'jarvis-06-foreign-frame-403.png') });
  await fp.close();

  // An old WebKit sends no Fetch Metadata: the server cannot tell, so the SPA itself must draw
  // nothing in a foreign parent. Simulated by stripping the headers on the way out.
  const old = await context.newPage();
  const oldResp = [];
  old.on('response', (r) => { if (r.url().startsWith(`http://127.0.0.1:${dashPort}/`) && r.request().resourceType() === 'document') oldResp.push(r.status()); });
  await old.route(`http://127.0.0.1:${dashPort}/**`, (route) => {
    const h = { ...route.request().headers() };
    for (const k of Object.keys(h)) if (k.startsWith('sec-fetch-')) delete h[k];
    return route.continue({ headers: h });
  });
  await old.goto(`http://127.0.0.1:${devPorts[0]}/frame`);
  await old.waitForTimeout(4000);
  const inner = old.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${dashPort}/`));
  const drawn = inner ? await inner.evaluate(() => document.getElementById('root')?.childElementCount ?? -1).catch(() => -2) : -3;
  if (oldResp.includes(200)) ok('old WebKit (no Fetch Metadata): the SPA loads in the foreign frame but draws nothing', drawn === 0, JSON.stringify({ oldResp, drawn }));
  else note(`Chromium keeps Fetch Metadata (statuses ${JSON.stringify(oldResp)}): the fallback is shown with an ungated copy of the SPA instead`);
  await old.close();
  // The same SPA build served by a plain static server (no gate at all, as an old WebKit would
  // meet it), framed by the dev page: frameGuard must leave #root empty.
  const spaPort = await freePort();
  const spaDir = join(REPO, 'dist', 'dashboard');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
  const spa = createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = join(spaDir, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(spaDir) || !existsSync(file)) file = join(spaDir, 'index.html');
    res.writeHead(200, { 'content-type': types[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => spa.listen(spaPort, '127.0.0.1', r));
  const fg = await context.newPage();
  await fg.setContent(`<iframe id="f" src="http://127.0.0.1:${spaPort}/" width="600" height="400"></iframe>`);
  await fg.waitForTimeout(5000);
  const spaFrame = fg.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${spaPort}/`));
  const spaDrawn = spaFrame ? await spaFrame.evaluate(() => ({ root: !!document.getElementById('root'), children: document.getElementById('root')?.childElementCount ?? -1 })).catch((e) => ({ err: String(e) })) : null;
  const topDrawn = await (async () => { const t = await context.newPage(); await t.goto(`http://127.0.0.1:${spaPort}/`); await t.waitForTimeout(4000); const n = await t.evaluate(() => document.getElementById('root')?.childElementCount ?? -1); await t.close(); return n; })();
  ok('in a foreign parent the SPA draws nothing (frameGuard); the same build at top level draws', spaDrawn?.root === true && spaDrawn.children === 0 && topDrawn > 0, JSON.stringify({ spaDrawn, topDrawn }));
  await fg.screenshot({ path: join(OUT, 'jarvis-07-spa-in-foreign-parent.png') });
  await fg.close();
  spa.close();

  console.log('\n── T1b: the dashboard\'s own frames still load');
  const ownResp = [];
  const onOwn = (r) => { if (r.request().resourceType() === 'document' && r.frame() !== page.mainFrame() && r.url().startsWith(base)) ownResp.push(r.status()); };
  page.on('response', onOwn);
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.id = 'own-frame-probe'; f.src = '/?vault=acme-app';
    f.style.cssText = 'position:fixed;left:8px;bottom:8px;width:320px;height:220px;z-index:99999;border:2px solid #888';
    document.body.appendChild(f);
  });
  await page.waitForTimeout(4000);
  const ownFrame = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(`${base}/?vault=acme-app`));
  const ownDrawn = ownFrame ? await ownFrame.evaluate(() => document.getElementById('root')?.childElementCount ?? -1).catch(() => -2) : -3;
  ok('a same-origin frame of the dashboard loads (200) and the SPA draws in it', ownResp.includes(200) && ownDrawn > 0, JSON.stringify({ ownResp, ownDrawn }));
  await page.screenshot({ path: join(OUT, 'jarvis-08-own-frame.png') });
  page.off('response', onOwn);
  await page.evaluate(() => document.getElementById('own-frame-probe')?.remove());

  console.log('\n── T6: after a server restart the allowed port loads without asking');
  await restart();
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!(await until(page, () => surfaceShown(page), 15000))) await openChat(page, base);
  await until(page, async () => (await page.locator('[data-testid="super-container"]').count()) > 0, 20000);
  const site = record().containers.find((c) => c.kind === 'web' && c.ref === siteRef);
  if (site && site.place !== 'float') note('the first site card rests in Others; opening it from there');
  await sayToSuper(page, `GO-OPENWEB ${siteRef}`);
  await until(page, async () => reports().some((r) => r.kind === 'owner-openweb'), 20000);
  await page.waitForTimeout(1500);
  const card = page.locator(`[data-testid="super-container"][data-kind="web"]`).first();
  await card.click({ position: { x: 40, y: 40 } }).catch(() => {});
  ok('the allowed port loads without the prompt after a restart', await until(page, async () => (await page.locator('.super-card-frame[data-kind="web"] iframe').count()) > 0
    && (await page.getByTestId('web-loopback-prompt').count()) === 0, 12000));
  await page.screenshot({ path: join(OUT, 'jarvis-05-after-restart.png') });

  await context.close();
  await browser.close();
  return { errors, strip };
}

// ─── main ───────────────────────────────────────────────────────────────────────────────
let server = null;
const devServers = [];
try {
  if (!existsSync(CLI)) throw new Error('dist/index.js is missing: npm run build first');
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  const devPorts = [await freePort(), await freePort(), await freePort()];
  for (const p of devPorts) devServers.push(await startDevServer(p, port));
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const restart = async () => {
    await new Promise((r) => { server.once('exit', r); server.kill(); });
    server = await startServer(port);
  };
  const r = await flow(pw, base, port, devPorts, restart);
  // The dev page in the card is the attacker here: its refused socket and its CORS-blocked POST
  // are the evidence (T0, T3), not the dashboard's errors.
  const errs = r.errors.filter((e) => !/Failed to load resource|WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/api\/agent\/chat\?vault=acme-app&bypass=1'|from origin 'http:\/\/localhost:\d+' has been blocked by CORS policy/.test(e));
  ok('no console errors in the dashboard (the dev page\'s refused socket aside)', errs.length === 0, errs.slice(0, 5).join('\n'));
  const videos = existsSync(join(OUT, 'video')) ? readdirSync(join(OUT, 'video')) : [];
  note(`video: ${videos.map((v) => join(OUT, 'video', v)).join(', ')}`);
  note(`filmstrip: ${r.strip.length} frames, ${r.strip[0]} …`);
} catch (err) {
  results.fails.push(`crashed: ${err?.stack || err}`);
  console.error(err);
} finally {
  server?.kill();
  for (const s of devServers) s.close();
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.fails.length ? 'FAIL' : 'PASS'}: ${results.pass} passed, ${results.fails.length} failed${results.fails.length ? `\n  - ${results.fails.join('\n  - ')}` : ''}`);
process.exit(results.fails.length ? 1 : 0);
