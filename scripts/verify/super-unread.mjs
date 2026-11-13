#!/usr/bin/env node
/**
 * The Super chat's unread marks (owner 2026-10-30, draft A), on the real dashboard server with a
 * scratch HOME and a scripted `claude`: reports land while the window is in the back, then the
 * rail's count, the dwell, the opening landing on the first unread (its "Okunmamış" line), a
 * reload, the "↓ N yeni" button (owner 2026-11-13: no pill, no dots, no mark-all), 390 px and
 * take-back. The scroll itself is measured by super-kayma.mjs.
 *
 *   npm run build && node scripts/verify/super-unread.mjs
 *   BEFORE=1 CLI_PATH=<a build without it> node scripts/verify/super-unread.mjs   (the "before" shots)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = process.env.CLI_PATH || join(REPO, 'dist', 'index.js');
const SHOTS = process.env.SHOTS_DIR || join(REPO, 'tmp', 'verify-super-unread');
const BEFORE = process.env.BEFORE === '1';

const standin = (FRAMES, REPORTS) => `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const convo = at('--resume') || at('--session-id') || '';
const sid = convo || 'verify-unread-' + process.pid;
const persist = (type, content) => {
  if (!convo) return;
  const dir = join(process.env.HOME, '.claude', 'projects', 'verify-super');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, convo + '.jsonl'), JSON.stringify({ type, sessionId: convo, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: type, content } }) + '\\n');
};
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
  out({ type: 'control_request', request_id: 'req-' + process.pid + '-' + seq, request: { subtype: 'can_use_tool', ...request, tool_use_id: id } });
  awaiting = (r) => { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'done' }] }] } }); resolve(r); };
});
const shq = (a) => /^[A-Za-z0-9_.\\/:=-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\\\''") + "'";
const bashCall = (...args) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: ['dreamcontext', ...args].map(shq).join(' '), description: 'Ask the owner' } }] } });
  const r = cli(...args);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: r.out.trim() }], is_error: r.status !== 0 }] } });
  return r;
};
async function superTurn(text) {
  if (text.startsWith('[super handover]')) { report({ kind: 'handover', children: Object.keys(cli('super', 'state').json?.children ?? {}) }); return 'arranged'; }
  if (text.startsWith('[super event')) return 'noted';
  if (text.includes('GO-REPORTS')) {
    const tag = text.split('GO-REPORTS')[1].trim();
    for (let i = 1; i <= 9; i++) {
      const block = [{ type: 'text', text: 'Rapor ' + tag + ' ' + i + ': checkout adımları ayrıldı, her adım kendi alanlarını doğruluyor ve geri dönünce girilen bilgiler korunuyor. Kalan iş kart hatalarının mesajları; bitince önizlemeyi sahneye koyacağım. Testler yeşil, 14 dosya değişti ve onayın bekleniyor.' }];
      persist('assistant', block);
      out({ type: 'assistant', message: { role: 'assistant', content: block } });
      await sleep(40);
    }
    if (text.includes('ASK')) { const r = bashCall('super', 'ask', 'Yıllık planda indirim yüzde kaç olsun?', '--options', '%15|%20'); report({ kind: 'asked', r }); }
    return 'Son rapor ' + tag + ': hepsi bu kadar.';
  }
  if (text.includes('GO-DRIP')) {
    // Reports landing one by one while the owner is up in the chat.
    await sleep(2500);
    for (let i = 1; i <= 8; i++) {
      const block = [{ type: 'text', text: 'Canlı rapor ' + i + ': bir sonraki adım bitti, sonuç sahnede ve kontrol bekliyor.' }];
      persist('assistant', block);
      out({ type: 'assistant', message: { role: 'assistant', content: block } });
      await sleep(450);
    }
    return 'Canlı raporlar bitti.';
  }
  if (text.includes('GO-EVENT')) {
    // A child finishes while the owner is up in the chat: an event turn lands on the idle Super.
    report({ kind: 'sent', r: cli('super', 'delegate', '--prompt', 'SLOW-Q', '--brief', 'Uzun is') });
    return 'bekliyorum';
  }
  if (text.includes('GO-SLOW')) { await sleep(4000); return 'The release notes are ready.'; }
  const perm = text.match(/GO-CHILDPERM (\\S+)/);
  if (perm) { report({ kind: 'sent', r: cli('super', 'send', perm[1], 'PERM-Q') }); return 'asked the child'; }
  if (text.startsWith('[super answer]')) { report({ kind: 'answer', text }); return 'noted'; }
  report({ kind: 'owner', text });
  return 'ok';
}
async function childTurn(text) {
  if (text.includes('SLOW-Q')) { await sleep(6000); return 'çocuk işi bitti'; }
  if (text.includes('PERM-Q')) {
    const r = await ask({ tool_name: 'Bash', display_name: 'Bash', input: { command: 'npm run build', description: 'Build the app' } });
    report({ kind: 'perm', response: r });
    return 'built';
  }
  return 'ok';
}
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(blocks.join('')); } catch (e) { said = 'error ' + e; }
  // A real Super answers under the owner message's reply mark; without it the server re-sends the
  // turn as owed and the reports land again (30 units instead of 11).
  const ref = role === 'super' ? (/<owner-msg ref="([^"]+)"/.exec(blocks.join('\\n')) || [])[1] : null;
  if (ref && said) said = '<!-- re:' + ref + ' -->\\n' + said;
  persist('assistant', [{ type: 'text', text: said }]);
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
    // Block by block, as the real CLI stores them: the replay drops the owner-msg block by itself.
    persist('user', blocks.map((text) => ({ type: 'text', text })));
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

const wauScript = `export default async function () {
  return [{ name: 'Weekly active users', points: ${JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ t: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), v: 8200 + i * 140 })))} }];
}
`;

const fails = [];
const ok = (label, cond, detail) => { console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `\n      ${String(detail).slice(0, 900)}` : ''}`); if (!cond) fails.push(label); return !!cond; };
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); } return false; };
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };


async function run() {
  const SCRATCH = join(tmpdir(), `dc-verify-super-unread-${process.pid}`);
  const HOME = join(SCRATCH, 'home');
  const PROJ = join(SCRATCH, 'acme-app');
  const OUT = SHOTS;
  const FRAMES = join(SCRATCH, 'frames.ndjson');
  const REPORTS = join(SCRATCH, 'reports.ndjson');
  const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
  const must = (what, r) => { if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`); };
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, standin(FRAMES, REPORTS));
  chmodSync(bin, 0o755);
  must('vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.pipe(createWriteStream(join(OUT, 'server.log'))); srv.stderr.pipe(createWriteStream(join(OUT, 'server.err')));
  for (const end = Date.now() + 60_000; Date.now() < end;) {
    try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const reports = () => readNd(REPORTS);
  const frames = () => readNd(FRAMES);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', locale: 'tr-TR' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const centreInput = page.locator('[data-super-slot="centre"] .chat-cmp-input');
  const nav = async (label) => {
    // Classic sidebar, or the new shell's rail (the default): its rail buttons carry the label.
    const rail = page.locator(label === 'Chat' ? '[data-testid="ns-rail-chat"]' : `.ns-rail-btn[aria-label^="${label}"]`);
    if (await rail.count()) await rail.first().click();
    else await page.locator('nav button').filter({ has: page.locator('.sidebar-label', { hasText: label }) }).first().click();
    await page.waitForTimeout(900);
  };
  const toStage = async () => {
    for (let i = 0; i < 8 && !(await page.locator('[data-testid="super-surface"]:visible').count()); i++) {
      await nav('Chat').catch(() => {});
      await page.waitForTimeout(1200);
    }
    await until(page, async () => (await centreInput.count()) > 0, 30000);
  };
  const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) });
  // No per-row dots any more (owner 2026-11-13).
  const dots = () => page.locator('[data-super-slot="centre"] [data-unread]').count();
  const badge = async () => {
    const b = page.locator('nav [data-testid="super-unread-badge"], [data-testid="drawer-super-row"] [data-testid="super-unread-badge"]');
    if (await b.count()) return Number((await b.first().innerText()).trim() || 0);
    // New shell with its drawer closed: the rail's Chat button names the count in its label.
    const lbl = await page.locator('[data-testid="ns-rail-chat"]').first().getAttribute('aria-label').catch(() => null);
    const m = lbl && /\((\d+) /.exec(lbl);
    return m ? Number(m[1]) : 0;
  };
  const newBtn = page.locator('[data-super-slot="centre"] [data-testid="super-new"], .super-dock [data-testid="super-new"]').filter({ visible: true });
  const firstLineInView = () => page.evaluate(() => {
    const el = document.querySelector('[data-unread-first]'); const box = [...document.querySelectorAll('.chat-scroll')].find((e) => e.getBoundingClientRect().height > 0 && e.closest('[data-super-slot="centre"], .super-dock'))?.getBoundingClientRect();
    if (!el || !box) return false; const r = el.getBoundingClientRect(); return r.top >= box.top && r.top < box.bottom;
  });
  const send = async (text) => {
    await centreInput.first().click();
    await centreInput.first().fill(text);
    await page.keyboard.press('Enter');
  };
  const turnEnds = () => reports().filter((r) => r.kind === 'turn-end').length;
  const blur = (off) => page.evaluate(async (v) => { Document.prototype.hasFocus = () => !v; window.dispatchEvent(new Event(v ? 'blur' : 'focus')); await new Promise((r) => setTimeout(r, 50)); }, off);
  const scroller = () => page.locator('[data-super-slot="centre"] .chat-scroll');
  const toBottom = () => scroller().evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const takeBack = () => page.evaluate(async () => { const r = await fetch('/api/super/disable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return r.status; });
  const takeBackChecks = async () => {
    console.log('── take back: the record dies');
    const marksFile = join(PROJ, '_dream_context', 'state', '.super', 'read-marks.json');
    ok('the record is on disk', existsSync(marksFile));
    await toStage();
    // The new shell's stage has no take-back button: the same call the classic header's button makes.
    await takeBack();
    ok('gone with the hand-over', await until(page, async () => !existsSync(marksFile), 20000));
    ok('the rail count dies with it', await until(page, async () => (await badge()) === 0, 8000), `${await badge()}`);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(1500);
    ok('nothing writes a new record after take-back', !existsSync(marksFile));

    const real = errors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket|Failed to load resource/i.test(e));
    ok('no console errors', real.length === 0, real.join('\n'));
  };
  try {
    await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await nav('Chat');
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat|Sohbet başlat/ }).click().catch(() => {});
    ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 30000));
    await page.locator('.chat-cmp-input:visible').first().fill('hello');
    await page.keyboard.press('Enter');
    await until(page, async () => frames().some((f) => f.role === 'child'), 30000);
    await page.waitForTimeout(1200);
    // The new shell's drawer carries the door; the classic header its button.
    await page.locator('[data-testid="drawer-super-row"]:visible, [data-testid="super-handover-btn"]:visible').first().click();
    ok('the Super stage shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 30000));
    ok('the super agent took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
    await until(page, async () => (await centreInput.count()) > 0, 30000);
    await page.waitForTimeout(2500);

    // The window is in the back while the reports land.
    await blur(true);
    const before = turnEnds();
    await send('GO-REPORTS A ASK');
    await blur(true); // typing puts the window in front again
    ok('the turn ended', await until(page, async () => turnEnds() > before, 60000));
    await page.waitForTimeout(1500);

    if (process.env.ONLY === 'takeback') {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await toStage();
      await page.waitForTimeout(3000);
      ok('a replayed message shows no raw owner-msg tag', !(await page.locator('[data-super-slot="centre"]').innerText()).includes('owner-msg'));
      await blur(false);
      await page.waitForTimeout(1500);
      await takeBackChecks();
      return;
    }

    if (BEFORE) {
      await scroller().evaluate((el) => { el.scrollTop = 200; });
      await page.waitForTimeout(500);
      await shot('kod-once-1440');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(1200);
      await shot('kod-once-390');
      return;
    }

    console.log('── the window in the back reads nothing');
    const n0 = await badge();
    ok('11 units flagged: 10 blocks + the question card', n0 === 11, `badge ${n0}`);
    ok('the rail carries the count', n0 > 0);
    ok('no per-row dots (owner 2026-11-13)', (await dots()) === 0, `${await dots()}`);
    await page.waitForTimeout(1800);
    ok('still all unread after 1.8 s with the window unfocused', (await badge()) === n0, `${await badge()}`);
    await shot('kod-sonra-rail-1440');

    console.log('── another page reads nothing');
    await nav('Tasks');
    await blur(false);
    await page.waitForTimeout(1800);
    ok('on another page the count holds', (await badge()) === n0, `${await badge()}`);
    await blur(true);
    await nav('Chat');
    await blur(false);
    await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 10000);

    console.log('── looking at it');
    await page.waitForTimeout(2200);
    const n1 = await badge();
    ok('what stood on screen ~1 s went read, what lay above did not', n1 > 0 && n1 < n0, `${n1} of ${n0}`);
    // Rule C (owner 2026-11-13): his send was followed until the new answer's start reached the
    // top; the rest waits below the button with its count.
    const rest = (await newBtn.innerText().catch(() => '')).trim();
    ok('stopped at the answer\'s start: "↓ N new" for what waits below', /↓\s*\d+\s+new/.test(rest), JSON.stringify(rest));
    await shot('kod-sonra-1440');
    const server = await page.evaluate(async () => (await fetch('/api/agent/super-read')).json().catch(() => null));
    console.log('   marks', JSON.stringify(server)?.slice(0, 160));

    console.log('── opening the chat lands on the first unread');
    await blur(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await toStage();
    await until(page, async () => (await badge()) > 0, 20000);
    // What was read stays read (never more unread than before); the landing on the first unread
    // may read what it shows, so fewer is fine, none left is not.
    const nReload = await badge();
    ok('a reload keeps what was read and what was not', nReload > 0 && nReload <= n1, `${nReload} after ${n1}`);
    ok('the opening lands with the first unread and its line on screen', await until(page, firstLineInView, 6000));
    await shot('kod-sonra-acilis-1440');
    const below = await newBtn.innerText().catch(() => '');
    console.log('   button after landing:', JSON.stringify(below));
    ok('the way down is on offer, with what is new below', (await newBtn.count()) === 1 && /↓/.test(below), JSON.stringify(below));
    await blur(false);
    await page.waitForTimeout(2200);
    const n2 = await badge();
    ok('reading it counted it down', n2 < n1, `${n2} after ${n1}`);

    console.log('── the button');
    const top = await scroller().evaluate((el) => el.scrollTop);
    await page.waitForTimeout(1500);
    ok('nothing moves the resting view', (await scroller().evaluate((el) => el.scrollTop)) === top);
    await newBtn.first().click();
    ok('the button goes to the bottom and hides', await until(page, async () => (await scroller().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60)) && (await newBtn.count()) === 0, 4000));
    ok('no "Mark as read" anywhere', !(/Mark as read|Okundu say/.test(await page.locator('[data-super-slot="centre"]').innerText())));
    ok('no unread pill', (await page.locator('[data-testid="super-unread-bar"]').count()) === 0);

    console.log('── phone width');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await blur(true);
    await page.locator('[data-testid="super-dock-pill"]:visible').first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    const input390 = page.locator('.chat-cmp-input:visible').first();
    const b4 = turnEnds();
    await input390.click(); await input390.fill('GO-REPORTS B'); await page.keyboard.press('Enter');
    await blur(true);
    await until(page, async () => turnEnds() > b4, 60000);
    await page.waitForTimeout(1500);
    await page.locator('.chat-scroll:visible').first().evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(800);
    const geo = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="super-new"]')?.getBoundingClientRect();
      return { btn: b ? { l: b.left, r: b.right, h: b.height } : null, over: document.documentElement.scrollWidth - innerWidth };
    });
    console.log('   390', JSON.stringify(geo));
    ok('390: the button fits the width', !!geo.btn && geo.btn.l >= 0 && geo.btn.r <= 390, JSON.stringify(geo));
    ok('390: no sideways scroll', geo.over <= 0, String(geo.over));
    await shot('kod-sonra-390');
    await newBtn.first().click();
    ok('390: the button goes to the bottom', await until(page, async () => page.locator('.chat-scroll:visible').first().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60), 4000));
    await page.locator('.chat-scroll:visible').first().evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(600);
    await blur(false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(1000);

    await takeBackChecks();
  } catch (e) {
    ok('run finished', false, e?.stack || String(e));
    await page.screenshot({ path: join(OUT, 'zz-crash.png') }).catch(() => {});
  } finally {
    await context.close();
    await browser.close();
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', bin]);
  }
}
await run();
console.log(`\n${fails.length ? `✗ ${fails.length} failed` : '✓ all passed'} — screenshots in ${SHOTS}`);
process.exit(fails.length ? 1 : 0);
