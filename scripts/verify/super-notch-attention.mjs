#!/usr/bin/env node
/**
 * The owner's attention while a project is handed over to its Super Agent (task
 * super-agent-acikken-…-cocuklar-susar, run 4, owner 2026-10-22).
 *
 *   npm run build && node scripts/verify/super-notch-attention.mjs
 *
 * A. "Notch'taki bildirimi Allow deyince almıyor": a handed-over child asks for a Bash
 *    permission; the notch shows it; the owner's Allow (the button), a typed "allow" and a typed
 *    "reddet" in the notch reach THAT child through the real relay (notch → server → bind →
 *    project window claim → the child's own chat), and the words never reach the Assistant.
 *    The Assistant's own `answer` verb is still refused for the child.
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real notch page and the
 * real project page in Chromium, each on a mocked Tauri bus; the doorbell the notch emits to the
 * project window (`emitTo`) is carried across by this script, the one thing two browser pages
 * cannot do for themselves. `claude` is a scripted stand-in (no tokens).
 *
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dc-verify-super-notch-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-notch-attention');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : process.cwd().includes('/.dreamcontext/assistant') ? 'assistant' : 'child';
const sid = 'verify-sn-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
let awaiting = null;
let seq = 0;
const ask = (request) => new Promise((resolve) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: request.tool_name, input: request.input }] } });
  out({ type: 'control_request', request_id: 'req-' + process.pid + '-' + seq, request: { subtype: 'can_use_tool', ...request, tool_use_id: id } });
  awaiting = (r) => { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'done' }] }] } }); resolve(r); };
});
async function superTurn(text) {
  if (text.startsWith('[super handover]')) { report({ kind: 'handover', children: Object.keys(cli('super', 'state').json?.children ?? {}) }); return 'arranged'; }
  const go = text.match(/GO-CHILDBASH (\\S+) (\\S+)/);
  if (go) { report({ kind: 'sent', r: cli('super', 'send', go[1], 'ASK-BASH ' + go[2]) }); return 'asked the child'; }
  report({ kind: 'owner', text });
  return 'noted';
}
async function childTurn(text) {
  const m = text.match(/ASK-BASH ([A-Za-z0-9]+)/);
  if (m) {
    const r = await ask({ tool_name: 'Bash', display_name: 'Bash', input: { command: 'python3 capture-' + m[1] + '.py', description: 'Capture ' + m[1] } });
    report({ kind: 'answered', tag: m[1], response: r });
    return 'bash ' + m[1] + ' ' + (r && r.behavior);
  }
  return 'ok';
}
// The Assistant tries to answer a handed-over child itself, the way its briefing says to.
function assistantTurn(text) {
  const m = text.match(/GO-ASSISTANT-ANSWER (\\S+) (\\S+)/);
  if (m) { const r = cli('assistant', 'answer', m[1], '--question', m[2], '--choice', 'allow'); report({ kind: 'assistant-answer', r }); return 'tried'; }
  return 'assistant heard: ' + text;
}
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'default', slash_commands: [] });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : role === 'child' ? await childTurn(blocks.join('')) : assistantTurn(blocks.join(' ')); } catch (e) { said = 'error ' + e; }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  report({ kind: 'turn-end', said });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_response') { if (awaiting) { const r = awaiting; awaiting = null; r(o.response && o.response.response); } continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks }) + '\\n');
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

/** A mocked Tauri bus for one page: real listen/unlisten, `emitTo` recorded for the script. */
const tauriStub = (label) => {
  const handlers = new Map();
  let seq = 0;
  window.__emits = [];
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (event, id) => { handlers.get(event)?.delete(id); } };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
    transformCallback: (cb) => { const id = ++seq; window[`_${id}`] = cb; return id; },
    invoke: async (cmd, args) => {
      if (cmd === 'plugin:event|listen') {
        const set = handlers.get(args.event) ?? new Set();
        set.add(args.handler);
        handlers.set(args.event, set);
        return args.handler;
      }
      if (cmd === 'plugin:event|unlisten') { handlers.get(args.event)?.delete(args.eventId); return null; }
      if (cmd === 'plugin:event|emit_to') { window.__emits.push(JSON.parse(JSON.stringify(args))); return null; }
      if (cmd === 'plugin:webview|get_all_windows' || cmd === 'plugin:window|get_all_windows') return [label];
      if (cmd.startsWith('mic_take_')) throw new Error(`Command ${cmd} not found`);
      if (cmd === 'plugin:window|outer_position') return { x: 0, y: 0 };
      if (cmd === 'plugin:window|scale_factor') return 1;
      return null;
    },
  };
  window.__fireTauri = (event, payload) => {
    const ids = [...(handlers.get(event) ?? [])];
    for (const id of ids) window[`_${id}`]?.({ event, id: 0, payload });
    return ids.length;
  };
};

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH, DREAMCONTEXT_CLI: CLI }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(OUT, 'server.log'));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const frames = () => readNd(FRAMES);
const fails = [];
const ok = (label, cond, detail) => { console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `\n      ${String(detail).slice(0, 900)}` : ''}`); if (!cond) fails.push(label); return !!cond; };
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); } return false; };
async function say(page, text) {
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

async function main() {
  if (!existsSync(join(REPO, 'dist', 'dashboard', 'index.html'))) throw new Error('dist/dashboard missing — run npm run build first');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', recordVideo: { dir: join(OUT, 'video'), size: { width: 1600, height: 1000 } } });
  const page = await context.newPage();
  const notchCtx = await browser.newContext({ viewport: { width: 580, height: 560 }, colorScheme: 'dark' });
  const notch = await notchCtx.newPage();
  const errors = [];
  for (const [p, tag] of [[page, 'project'], [notch, 'notch']]) {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`[${tag}] ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`[${tag}] ${String(e)}`));
  }
  // The doorbell: what the notch emits to a project window, delivered to THAT page.
  let carrying = true;
  const carried = [];
  const carry = (async () => {
    while (carrying) {
      const emits = await notch.evaluate(() => window.__emits.splice(0)).catch(() => []);
      for (const e of emits) {
        carried.push(e);
        if (e.target?.label === 'vault-acme-app' || e.target === 'vault-acme-app') await page.evaluate((x) => window.__fireTauri(x.event, x.payload), e).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  })();
  try {
    console.log('\n── setup: an assistant (the notch), one chat handed over');
    const created = await post('/api/assistant/create', { name: 'Nova' });
    ok('the assistant exists (real init + setup)', created.status === 200, await created.text());
    await post('/api/assistant/profile', { autonomy: 'bypass' });
    await page.addInitScript(tauriStub, 'vault-acme-app');
    await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    if (!(await page.locator('.agent-surface.expanded').count())) {
      const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
      if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
    await say(page, 'hello');
    await until(page, async () => frames().some((f) => f.role === 'child'), 30000);
    await page.waitForTimeout(1500);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    ok('the Super stage shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
    ok('the super agent took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
    const child = reports().find((r) => r.kind === 'handover')?.children?.[0];
    ok('one child adopted', !!child, JSON.stringify(reports()));
    await until(page, async () => (await page.locator('[data-super-slot="centre"] .chat-cmp-input').count()) > 0, 20000);
    await page.waitForTimeout(1000);
    const windows = await (await fetch(`${base}/api/assistant/windows?vault=acme-app`)).json().catch(() => ({}));
    ok('the project window registered for the doorbell', JSON.stringify(windows).includes('vault-acme-app'), JSON.stringify(windows));

    await notch.addInitScript(tauriStub, 'assistant');
    await notch.route('**/api/agent/voice/tts', (route) => route.fulfill({ status: 204, body: '' }));
    await notch.route('**/api/agent/voice/focus', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ granted: true, holder: null, ducked: false, gain: 1, paused: [] }) }));
    await notch.goto(`${base}/?assistant=1`);
    await notch.waitForSelector('.dc-notch__pill', { timeout: 20_000 });

    const centre = page.locator('[data-super-slot="centre"]');
    const childAsks = async (tag) => {
      await centre.locator('.chat-cmp-input').first().click();
      await centre.locator('.chat-cmp-input').first().fill(`GO-CHILDBASH ${child} ${tag}`);
      await page.keyboard.press('Enter');
      return until(page, async () => {
        const g = await (await fetch(`${base}/api/assistant/glance`)).json();
        return (g.chats ?? []).some((c) => c.super && c.sessionId === child && c.ask?.kind === 'permission' && /capture-/.test(c.ask.text) && c.ask.text.includes(tag));
      }, 30000);
    };
    const answeredWith = (tag) => reports().find((r) => r.role === 'child' && r.kind === 'answered' && r.tag === tag)?.response?.behavior;
    const openNow = async () => {
      if (await notch.locator('.dc-notch__panel').isHidden()) await notch.click('.dc-notch__pill');
      await notch.waitForSelector('.dc-notch__panel:not([hidden])', { timeout: 10_000 });
      const nowTab = notch.getByRole('tab', { name: /Now/ }).or(notch.locator('button').filter({ hasText: /^\s*Now/ })).first();
      if (await nowTab.count()) await nowTab.click().catch(() => {});
    };

    console.log('\n── A1: the notch\'s Allow button on a handed-over child\'s permission');
    ok('the child asks for a Bash permission; the notch glance lists it as a super row', await childAsks('one'));
    await openNow();
    const allowBtn = notch.locator('.dc-glance__btn--primary:visible').filter({ hasText: /^\s*Allow/ }).first();
    ok('the open notch shows the request with Allow', await until(notch, async () => (await allowBtn.count()) > 0, 15000));
    await notch.screenshot({ path: join(OUT, 'A1-notch-permission.png') });
    await allowBtn.click();
    ok('the CHILD gets allow (its own chat answered it)', await until(page, async () => answeredWith('one') === 'allow', 25000), JSON.stringify(reports().slice(-4)) + ' carried=' + JSON.stringify(carried.slice(-2)));
    ok('…carried to the project window that holds it (the doorbell went to vault-acme-app)', carried.some((e) => e.event === 'dream://assistant-command'));
    ok('…and the notch never says "Couldn\'t reach"', (await notch.locator('.dc-glance__fail').count()) === 0);
    ok('…the request leaves the glance', await until(page, async () => !((await (await fetch(`${base}/api/assistant/glance`)).json()).chats ?? []).some((c) => c.ask?.kind === 'permission'), 15000));
    await notch.screenshot({ path: join(OUT, 'A1-notch-after-allow.png') });

    console.log('\n── A2: "allow" typed (what a voice take sends) in the notch composer');
    ok('the child asks again', await childAsks('two'));
    await notch.waitForTimeout(3500); // one glance tick: the notch knows the request is waiting
    const chatTab = notch.getByRole('tab', { name: /Chat/ }).or(notch.locator('button').filter({ hasText: /^\s*Chat/ })).first();
    if (await chatTab.count()) await chatTab.click().catch(() => {});
    await notch.fill('.dc-notch__chat textarea', 'Allow.');
    await notch.keyboard.press('Enter');
    ok('the CHILD gets allow', await until(page, async () => answeredWith('two') === 'allow', 25000), JSON.stringify(reports().slice(-4)));
    ok('…and the Assistant never heard the word', !frames().some((f) => f.role === 'assistant' && /allow/i.test(f.blocks.join(' '))), JSON.stringify(frames().filter((f) => f.role === 'assistant')));

    console.log('\n── A3: "reddet" typed in the notch denies it; other words still go to the Assistant');
    ok('the child asks a third time', await childAsks('three'));
    await notch.waitForTimeout(3500);
    await notch.fill('.dc-notch__chat textarea', 'reddet');
    await notch.keyboard.press('Enter');
    ok('the CHILD gets deny', await until(page, async () => answeredWith('three') === 'deny', 25000), JSON.stringify(reports().slice(-4)));
    await notch.fill('.dc-notch__chat textarea', 'what is acme doing?');
    await notch.keyboard.press('Enter');
    ok('a sentence with no waiting permission reaches the Assistant as before', await until(notch, async () => frames().some((f) => f.role === 'assistant' && f.blocks.join(' ').includes('what is acme doing?')), 30000), JSON.stringify(frames().slice(-3)));

    console.log('\n── A4: the Assistant itself still cannot answer a handed-over child');
    ok('the child asks a fourth time', await childAsks('four'));
    const g4 = await (await fetch(`${base}/api/assistant/glance`)).json();
    const q4 = (g4.chats ?? []).find((c) => c.super && c.sessionId === child && c.ask?.kind === 'permission')?.ask?.id;
    await notch.fill('.dc-notch__chat textarea', `GO-ASSISTANT-ANSWER ${child} ${q4}`);
    await notch.keyboard.press('Enter');
    ok('the Assistant ran its answer verb', await until(notch, async () => reports().some((r) => r.kind === 'assistant-answer'), 30000));
    const aa = reports().find((r) => r.kind === 'assistant-answer')?.r;
    ok('…and it is refused: super_handed_over', aa?.status !== 0 && /super_handed_over/.test(aa?.out ?? ''), aa?.out);
    ok('…and the child is still waiting', answeredWith('four') === undefined);
    await openNow();
    const allow4 = notch.locator('.dc-glance__btn--primary:visible').filter({ hasText: /^\s*Allow/ }).first();
    if (await until(notch, async () => (await allow4.count()) > 0, 10000)) await allow4.click();
    ok('the owner\'s Allow then lets it go', await until(page, async () => answeredWith('four') === 'allow', 25000));

    const real = errors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket|Failed to load resource/i.test(e));
    ok('no console errors', real.length === 0, real.join('\n'));
  } finally {
    carrying = false;
    await carry.catch(() => {});
    await notchCtx.close();
    await context.close();
    await browser.close();
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
  }
  console.log(`\n${fails.length ? `✗ ${fails.length} failed` : '✓ all passed'} — screenshots and video in ${OUT}`);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
