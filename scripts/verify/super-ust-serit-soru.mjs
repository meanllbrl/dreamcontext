#!/usr/bin/env node
/**
 * The top band with a REAL child request: a delegated chat asks for a permission (a question is
 * never drawn in the bar any more), the job bar draws it over a presentation. Measures that the bar and the tab row
 * never overlap. DC_DIST=<checkout> runs another build (the before); DC_LABEL names the shot folder.
 *
 *   SUNUM_PICS=<dir of png> node scripts/verify/super-ust-serit-soru.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dc-verify-ust-serit-q-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const DIST = process.env.DC_DIST || REPO;
const CLI = join(DIST, 'dist', 'index.js');
const LABEL = process.env.DC_LABEL || 'after';
const OUT = join(REPO, 'tmp', 'super-ust-serit-soru', LABEL);
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const AWAY = join(SCRATCH, 'away');

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-oq-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let awaiting = null;
let seq = 0;
const ask = (request) => new Promise((resolve) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: request.tool_name, input: request.input }] } });
  out({ type: 'control_request', request_id: 'req-' + process.pid + '-' + seq, request: { subtype: 'can_use_tool', ...request, tool_use_id: id, requires_user_interaction: true } });
  awaiting = (r) => { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'answered' }] }] } }); resolve(r); };
});
// A CLI call the way claude makes it: a Bash tool_use the transcript shows, then its result.
const shq = (a) => /^[A-Za-z0-9_.\/:=-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'";
const bashCall = (...args) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: ['dreamcontext', ...args].map(shq).join(' '), description: 'Ask the owner' } }] } });
  const r = cli(...args);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: r.out.trim() }], is_error: r.status !== 0 }] } });
  return r;
};
async function superTurn(text) {
  if (text.startsWith('[super handover]')) { report({ kind: 'handover', children: Object.keys(cli('super', 'state').json?.children ?? {}) }); return 'arranged'; }
  if (text.startsWith('[super event')) {
    const q = cli('super', 'queue', 'list');
    const items = q.json?.queue ?? [];
    const question = items.find((i) => i.kind === 'question' && i.state !== 'done' && i.state !== 'escalated');
    // The harness says when the owner has gone: it removes the presence first.
    for (let i = 0; i < 50 && !existsSync(${JSON.stringify(AWAY)}); i += 1) await sleep(200);
    const esc = question ? bashCall('super', 'queue', 'ask', question.id, 'The login button: blue or green?') : null;
    report({ kind: 'escalated', esc });
    return 'Which colour for the login button: blue or green?';
  }
  if (text.includes('GO-PRESENT')) {
    const r = bashCall('super', 'open', 'image', 'tmp/a.png', 'tmp/b.png', '--group', 'lina-seviye-karti', '--titles', 'Rozetli: Yetkin|Rozetli: hedef aynı seviye', '--present');
    const q = bashCall('super', 'open', 'image', 'tmp/c.png', 'tmp/d.png', '--group', 'rakip', '--titles', 'Rakip: bir|Rakip: iki');
    let id = ''; try { id = q.json.container.id; } catch {}
    if (id) bashCall('super', 'present', id);
    report({ kind: 'presented', r: r.out.slice(0, 200) });
    return 'sunum hazır';
  }
  if (text.includes('GO-ASKOWNER')) { const r = bashCall('super', 'ask', 'Ship the login fix now?', '--options', 'Ship it|Wait'); report({ kind: 'asked', r }); return 'Ship the login fix now?'; }
  // Asked with no tool row the chat can read (the tail must still draw it).
  if (text.includes('GO-ASKQUIET')) { const r = cli('super', 'ask', 'Rename the app to Acme Go?', '--options', 'Yes|No'); report({ kind: 'askedQuiet', r }); return 'One more question for you.'; }
  let go = /GO-CHILDASK/.test(text) ? [0, ''] : null;
  if (go) { const d = cli('super', 'delegate', '--prompt', 'ASK-Q', '--brief', 'Funnel uzmanı', '--note', 'Seviye kartı'); report({ kind: 'delegated', d }); return 'başlattım'; }
  if (false) { report({ kind: 'sent', child: go[1], r: cli('super', 'send', go[1], 'ASK-Q') }); return 'asked the child'; }
  if (text.startsWith('[super answer]')) { report({ kind: 'answer', text }); return 'noted'; }
  report({ kind: 'owner', text });
  return 'ok';
}
async function childTurn(text) {
  if (text.includes('ASK-Q')) {
    const r = await ask({ tool_name: 'Bash', display_name: 'Bash', input: { command: 'git push origin staging', description: 'Seviye kartını staging a çıkar' } });
    report({ kind: 'answered', response: r });
    return 'got answer';
  }
  return 'ok';
}
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(blocks.join('')); } catch (e) { said = 'error ' + e; }
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
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks, folded: running }) + '\\n');
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  mkdirSync(join(PROJ, 'tmp'), { recursive: true });
  const pics = process.env.SUNUM_PICS || '';
  const files = pics ? readdirSync(pics).filter((f) => f.endsWith('.png')).sort() : [];
  ['a', 'b', 'c', 'd'].forEach((n, k) => writeFileSync(join(PROJ, 'tmp', `${n}.png`), readFileSync(join(pics, files[k % files.length]))));
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const result = (r) => r?.json?.result ?? r?.json ?? {};

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const presence = (vault, sessionId = null) => fetch(`${base}/api/assistant/presence`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'main', vault, sessionId }) });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    console.log('\n── one chat, handed over');
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
    await page.locator('[data-testid="drawer-super-row"]:visible, [data-testid="super-handover-btn"]:visible').first().click();
    ok('the Super stage shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
    ok('the super agent took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
    const child = reports().find((r) => r.kind === 'handover')?.children?.[0];
    
    await until(page, async () => (await page.locator('[data-super-slot="centre"] .chat-cmp-input').count()) > 0, 20000);
    await page.waitForTimeout(1500);

    console.log('\n── two groups, one presented');
    await page.locator('[data-super-slot="centre"] .chat-cmp-input').first().click();
    await page.locator('[data-super-slot="centre"] .chat-cmp-input').first().fill('GO-PRESENT');
    await page.keyboard.press('Enter');
    ok('presented', await until(page, async () => (await page.locator('[data-testid="super-stage-controls"]').count()) > 0, 40000));
    console.log('\n── a child\'s question escalated while the owner is away (no presence, no notifier)');
    await until(page, async () => reports().some((r) => r.kind === 'presented') && reports().filter((r) => r.kind === 'turn-end').length >= 3, 30000);
    await page.waitForTimeout(1000);
    await page.locator('[data-super-slot="centre"] .chat-cmp-input').first().click();
    await page.locator('[data-super-slot="centre"] .chat-cmp-input').first().fill(`GO-CHILDASK ${child}`);
    await page.keyboard.press('Enter');
    ok('the job bar draws the child\'s request', await until(page, async () => (await page.getByTestId('super-queue-head').count()) > 0, 60000));
    await page.waitForTimeout(1500);
    const geom = () => page.evaluate(() => {
      const r = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length).map((e) => { const b = e.getBoundingClientRect(); return { sel, x: b.x, y: b.y, w: b.width, h: b.height }; });
      return [...r('[data-testid="super-queue-head"]'), ...r('.super-present-tab'), ...r('[data-testid="super-stage-controls"]')];
    });
    const clash = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
    for (const width of [1280, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(1200);
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(OUT, `w${width}-${scheme}.png`) });
      }
      const g = await geom();
      const head = g.filter((x) => x.sel.includes('queue-head'));
      const rest = g.filter((x) => !x.sel.includes('queue-head'));
      console.log(width, JSON.stringify(g.map((x) => [x.sel.slice(-18), Math.round(x.x), Math.round(x.y), Math.round(x.w), Math.round(x.h)])));
      ok(`${width}: the bar and the tabs are both drawn`, head.length >= 1 && rest.length >= 3, JSON.stringify(g));
      ok(`${width}: the bar overlaps no tab or icon`, head.every((h) => rest.every((p) => !clash(h, p))), JSON.stringify(g));
    }
  } finally {
    await context.close();
    await browser.close();
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
  }
  console.log(`\n${fails.length ? `✗ ${fails.length} failed` : '✓ all passed'} — screenshots and video in ${OUT}`);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
