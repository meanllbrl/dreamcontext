#!/usr/bin/env node
/**
 * The SAME card posted again leaves nothing stuck at the bottom of the Super chat (owner 15 Nov,
 * kart-alta-yapisma-2: "bu da aşağıda takılı kaldı biz bunu çözmüştük"). A child left a run card,
 * then posted the very same card (same id) again in a later turn. The old build kept the Super's
 * item on the OLD copy: under the chat's last message stood "<child> needs you" around a card that
 * said "Replaced", with only Not needed, and the new copy never reached the Super chat.
 *
 *   npm run build && node scripts/verify/super-kart-yeniden.mjs --out <dir> [--dist <checkout>] [--label before|after]
 *
 * Real dashboard server from a built checkout (scratch HOME, DREAMCONTEXT_DESKTOP=1), a scripted
 * stand-in `claude` (no tokens), fictional project "orbit". Measured: one "needs you" card in the
 * Super chat, the run card in it is live (Run, not "Replaced"), the record holds one open owner
 * item. Screenshots at 1440x900 and 390x844. `--label before` runs another checkout's build and
 * the checks then pass when they REPRODUCE the bug.
 *
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const DIST_REPO = resolve(arg('--dist') ?? REPO);
const LABEL = arg('--label') ?? 'after';
/** `before` runs the old build: the placement checks then PASS when they reproduce the bug. */
const BUG = LABEL === 'before';
const placed = (name, cond, detail, drawn) => ok(BUG ? `(old build, bug reproduced) NOT: ${name}` : name, drawn && (BUG ? !cond : cond), detail);
const OUT = resolve(arg('--out') ?? join(REPO, 'tmp', 'verify-super-kart-yeniden'));
const { chromium } = createRequire(join(REPO, 'package.json'))('playwright');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-kart-yeniden-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(DIST_REPO, 'dist', 'index.js');
const LOGS = join(OUT, `logs-${LABEL}`);
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const W = 1440; const H = 900;

function standin(REPORTS, CLI) {
  const fence = "(o) => '\\n\\n```dream-view\\n' + JSON.stringify(o) + '\\n```'";
  return `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\\n');
const fence = ${fence};
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: ((r.stdout || '') + (r.stderr || '')).slice(0, 600) };
};
if (!argv.includes('stream-json')) {
  if (argv.includes('-p')) out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: at('--resume') || randomUUID(), num_turns: 1, total_cost_usd: 0, duration_ms: 5 });
  else out({});
  process.exit(0);
}
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = at('--session-id') || at('--resume') || randomUUID();
const tdir = join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
try { mkdirSync(tdir, { recursive: true }); } catch {}
const row = (o) => { try { appendFileSync(join(tdir, sid + '.jsonl'), JSON.stringify({ cwd: process.cwd(), uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: sid, ...o }) + '\\n'); } catch {} };
report({ kind: 'spawn', role, sid, resumed: !!at('--resume') });
process.on('exit', () => { try { report({ kind: 'exit', role, sid }); } catch {} });
process.on('SIGTERM', () => process.exit(0));
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const d = cli('super', 'delegate', '--prompt', 'RUNCARD: noter profilini sahibine kaydettir.', '--brief', 'Orbit canliya');
    report({ kind: 'delegated', sid: d.json?.sessionId ?? null, status: d.status, out: d.out });
    return 'Orbit canliya isini devraldim.';
  }
  if (!text.startsWith('[super') && text.includes('baska oturumda bitti')) {
    let kid = '';
    try { for (const l of readFileSync(${JSON.stringify(REPORTS)}, 'utf-8').trim().split('\\n')) { const o = JSON.parse(l); if (o.kind === 'delegated' && o.sid) kid = o.sid; } } catch {}
    const r = kid ? cli('super', 'send', kid, 'EXITNOW: is bitti, kapan.') : null;
    report({ kind: 'exit-sent', kid, status: r?.status ?? null });
    return 'Tamam, isi kapattim.';
  }
  if (!text.startsWith('[super') && text.includes('kart nerede')) {
    let kid = '';
    try { for (const l of readFileSync(${JSON.stringify(REPORTS)}, 'utf-8').trim().split('\\n')) { const o = JSON.parse(l); if (o.kind === 'delegated' && o.sid) kid = o.sid; } } catch {}
    const r = kid ? cli('super', 'send', kid, 'RUNAGAIN: karti tekrar goster.') : null;
    report({ kind: 'resend', kid, status: r?.status ?? null, out: r?.out ?? '' });
    return 'Isten karti yeniden gostermesini istedim.';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', owner: /event=owner/.test(text), text: text.slice(0, 300) }); return /event=owner/.test(text) ? 'Orbit seni bekliyor: noter profili.' : 'Tamam.'; }
  return 'Not aldim.';
}
async function childTurn(text) {
  const card = fence({ type: 'run', id: 'orbit-notary', command: 'xcrun notarytool store-credentials orbit-notary --team-id ORBIT12345', why: 'Apple sifreni yalniz sen girebilirsin' });
  if (text.includes('RUNCARD')) { report({ kind: 'card', n: 1, sid }); return 'Noter profili sende kaydedilmeli.' + card; }
  if (text.includes('EXITNOW')) { report({ kind: 'child-exit', sid }); setTimeout(() => process.exit(0), 400); return 'Kapaniyorum.'; }
  if (text.includes('RUNAGAIN')) { report({ kind: 'card', n: 2, sid }); return 'Hala bunu bekliyorum.' + card; }
  return 'Hazirim.';
}
let inited = false;
async function turn(blocks, content) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  const text = blocks.join('\\n');
  report({ kind: role + '-turn', sid, text: text.slice(0, 8000) });
  row({ type: 'user', message: { role: 'user', content } });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(text) : await childTurn(text); } catch (e) { said = 'error ' + e; }
  const uuid = randomUUID();
  const message = { role: 'assistant', content: [{ type: 'text', text: said }] };
  row({ type: 'assistant', uuid, message });
  out({ type: 'assistant', uuid, session_id: sid, message });
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
    chain = chain.then(() => turn(blocks, content));
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;
}
const STANDIN = standin(REPORTS, CLI);

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT, LOGS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'orbit', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH, SHELL: '/bin/sh', }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(LOGS, 'server.log'));
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
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], children: {}, queue: [] }; } };
const log = (...a) => console.log(...a);
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); } return false; };

let failures = 0;
const ok = (name, pass, detail = '') => { if (!pass) failures += 1; log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `  (${detail})` : ''}`); };
async function clean(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove());
    if (!document.getElementById('cap-kill')) {
      const s = document.createElement('style'); s.id = 'cap-kill';
      s.textContent = '.announcements-modal-scrim,.sleep-tracker-wrap{display:none!important}';
      document.head.appendChild(s);
    }
  });
}
async function shot(page, name) { await clean(page); await page.screenshot({ path: join(OUT, `${LABEL}-${name}`) }); log(`  saved ${LABEL}-${name}`); }
async function sayCentre(page, text) {
  const input = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
const motionIdle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);
const rowsOf = (page, sec) => page.locator(`[data-testid="super-agenda-section-${sec}"] [data-testid="super-agenda-row"]`);
const ownerItems = () => (record().queue ?? []).filter((q) => q.kind === 'owner');

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  log(`server on ${base} (dist of ${DIST_REPO}), scratch ${SCRATCH}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'tr-TR' });
  await context.addInitScript(() => {
    try { if (!localStorage.getItem('dreamcontext-theme')) localStorage.setItem('dreamcontext-theme', 'light'); } catch {}
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  /** Failed requests by URL: a 403 on an owner-key route is this harness's (no owner key is
   *  handed to the scratch page, verify-owner-card.mjs does that), listed, never hidden. */
  const failed = [];
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const facts = {};
  try {
    await page.goto(`${base}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await clean(page);
    const rail = page.locator('[data-testid="ns-rail-chat"]');
    if (await rail.count()) await rail.first().click();
    await page.waitForTimeout(900);
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat|Sohbet başlat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 60000);
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill('Orbit işini canlıya al.');
    await page.keyboard.press('Enter');
    await until(page, async () => reports().some((r) => r.kind === 'child-turn'), 60000);
    await page.waitForTimeout(1500);
    await page.locator('[data-testid="drawer-super-row"]:visible, [data-testid="super-handover-btn"]:visible').first().click();
    await motionIdle(page);
    ok('the child left a run card for the owner', await until(page, async () => reports().some((r) => r.kind === 'card' && r.n === 1), 90000));
    const centre = page.locator('[data-super-slot="centre"]');
    const slots = centre.locator('[data-testid="super-owner-card"]');
    ok('the card is drawn in the Super chat', await until(page, async () => (await slots.count()) === 1, 30000));
    await until(page, async () => reports().some((r) => r.kind === 'event' && r.owner), 30000);
    await page.waitForTimeout(1000);

    // He asks; the Super has the child show the card again (same id, a new message).
    await sayCentre(page, 'kart nerede, tekrar goster');
    ok('the child posted the same card again', await until(page, async () => reports().some((r) => r.kind === 'card' && r.n === 2), 60000), JSON.stringify(reports().filter((r) => r.kind === 'resend')));
    await page.waitForTimeout(4000);

    const measure = () => page.evaluate(() => {
      const c = document.querySelector('[data-super-slot="centre"]');
      const cards = [...(c?.querySelectorAll('[data-testid="super-owner-card"]') ?? [])];
      const texts = cards.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200));
      const last = cards[cards.length - 1];
      return {
        count: cards.length,
        texts,
        lastReplaced: last ? /Replaced|Yerine yenisi|newer copy|yenisini/.test(last.textContent ?? '') : null,
        lastNeedsYou: last ? /needs you|seni bekliyor|bekliyor/i.test(last.querySelector('.chat-viewcard-head, header')?.textContent ?? last.textContent ?? '') : null,
        replacedNeedingYou: cards.filter((el) => /Replaced|Yerine yenisi|newer copy|yenisini/.test(el.textContent ?? '') && el.querySelector('[data-testid="super-owner-notneeded"], button')).length,
        places: cards.map((el) => el.getAttribute('data-place')),
      };
    });
    const goLatest = async () => {
      const latest = centre.getByRole('button', { name: /Latest|En yeni|Son/ }).first();
      if (await latest.count()) await latest.click().catch(() => {});
      await page.waitForTimeout(800);
    };
    await goLatest();
    await page.mouse.move(5, 5);
    facts.desktop = await measure();
    const owners = ownerItems();
    facts.record = owners.map((q) => ({ id: q.id, state: q.state, ref: q.card?.cardRef?.slice(-12) ?? null, at: q.createdAt }));
    log(`  desktop: ${JSON.stringify(facts.desktop)}`);
    log(`  record: ${JSON.stringify(facts.record)}`);
    await shot(page, 'yeniden-1440.png');
    // The card itself, centred: what it says and which buttons it offers.
    await page.evaluate(() => { const c = [...document.querySelectorAll('[data-super-slot="centre"] [data-testid="super-owner-card"]')].pop(); c?.scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(700);
    await shot(page, 'kart-1440.png');
    const drawn = facts.desktop.count > 0;
    placed('1440: the last card in the Super chat is the live copy, not "Replaced"', facts.desktop.lastReplaced === false, JSON.stringify(facts.desktop), drawn);
    placed('the record holds ONE open owner item, on the newest copy', owners.filter((q) => q.state !== 'done').length === 1 && new Set(owners.map((q) => q.card?.cardRef)).size === 2, JSON.stringify(facts.record), owners.length > 0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await goLatest();
    facts.phone = await measure();
    log(`  phone: ${JSON.stringify(facts.phone)}`);
    await shot(page, 'yeniden-390.png');
    await page.evaluate(() => { const c = [...document.querySelectorAll('[data-super-slot="centre"] [data-testid="super-owner-card"]')].pop(); c?.scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(700);
    await shot(page, 'kart-390.png');
    placed('390: the last card is the live copy', facts.phone.lastReplaced === false, JSON.stringify(facts.phone), facts.phone.count > 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('390 px: no horizontal overflow', overflow <= 1, `scrollWidth over by ${overflow}`);
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(1000);

    // Case 2 (owner 15 Nov, ekran-2): the child really exits (no park) with its card still open.
    // Nothing may still say it needs him: the record closes the item, the card says it is withdrawn.
    await sayCentre(page, 'noter isi baska oturumda bitti');
    ok('the child process exited', await until(page, async () => reports().some((r) => r.kind === 'exit' && r.role === 'child'), 60000));
    const withdrawn = await until(page, async () => ownerItems().every((q) => q.state === 'done'), 120000);
    facts.afterExit = ownerItems().map((q) => ({ state: q.state, delivery: q.delivery ?? null }));
    if (!BUG) ok('after a real exit no owner item of the child stays open', withdrawn, JSON.stringify(facts.afterExit));
    else ok('(old build, bug reproduced) NOT: after a real exit no owner item stays open', !withdrawn, JSON.stringify(facts.afterExit));
    await page.waitForTimeout(2500);
    await goLatest();
    const needs = await page.evaluate(() => [...document.querySelectorAll('[data-super-slot="centre"] [data-testid="super-owner-card"]')]
      .filter((el) => /needs you|seni bekliyor/i.test(el.textContent ?? '')).length);
    facts.needsAfterExit = needs;
    log(`  after exit: record ${JSON.stringify(facts.afterExit)}, cards saying needs you: ${needs}`);
    await page.evaluate(() => { const c = [...document.querySelectorAll('[data-super-slot="centre"] [data-testid="super-owner-card"]')].pop(); c?.scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(700);
    await shot(page, 'cikis-1440.png');
    placed('after the exit no card in the Super chat says "needs you"', needs === 0, String(needs), true);
    const ownerKey403 = failed.filter((f) => /^403 \/api\/(agent\/card|owner|cards?\b)/.test(f));
    log(`  failed requests: ${JSON.stringify(failed)}`);
    const errs = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED/i.test(e))
      .filter((e) => !(/status of 403/.test(e) && ownerKey403.length > 0 && failed.every((f) => !f.startsWith('403') || ownerKey403.includes(f))));
    ok('no page errors (a 403 on an owner-key route is the harness, listed above)', errs.length === 0, errs.slice(0, 3).join(' | '));
    facts.failed = failed;
    writeFileSync(join(LOGS, 'console-errors.json'), JSON.stringify(errors, null, 2));
    writeFileSync(join(LOGS, 'facts.json'), JSON.stringify(facts, null, 2));
  } catch (e) {
    ok('the run completed', false, String(e).slice(0, 1200));
    await page.screenshot({ path: join(LOGS, 'fail.png') }).catch(() => {});
    log(`  page: ${(await page.locator('body').innerText().catch(() => '')).slice(0, 600).replace(/\n+/g, ' | ')}`);
    log(`  errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    try { writeFileSync(join(LOGS, 'reports.ndjson'), readFileSync(REPORTS, 'utf-8')); } catch {}
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
    await new Promise((r) => setTimeout(r, 800));
    if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  }
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — screenshots in ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
