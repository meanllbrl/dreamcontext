#!/usr/bin/env node
/**
 * A child's card for the owner is a MESSAGE of the Super chat: it sits where it arrived and scrolls
 * with the conversation, never pinned above the composer (owner 2026-11-14, a tall secret card stuck
 * at the bottom: "şu kartlar da kaymıyor altta kalıyor"). The real dashboard server from a built
 * checkout (scratch HOME, DREAMCONTEXT_DESKTOP=1), a scripted stand-in `claude` (no tokens),
 * fictional project "orbit".
 *
 *   npm run build && node scripts/verify/super-kart-yerinde.mjs --out <dir> [--dist <checkout>] [--label before|after]
 *
 * The owner hands one chat over; the Super steers it; the child leaves a 4-field secret card. The
 * owner writes "benden neden key istiyorsun anlamadım", the Super answers. Measured: the card's top
 * is ABOVE his message and the answer, nothing the transcript drew sits under the card, and the
 * card is not the last thing above the composer. Screenshots of the chat at its latest at 1440x900
 * and 390x844, then the bar's "Enter secret" brings the card into view. `--dist` runs another
 * checkout's build (the "before" picture); `--label` prefixes the screenshots.
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
const OUT = resolve(arg('--out') ?? join(REPO, 'tmp', 'verify-super-kart-yerinde'));
const { chromium } = createRequire(join(REPO, 'package.json'))('playwright');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-kart-yerinde-${process.pid}`);
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
    const d = cli('super', 'delegate', '--prompt', 'SECRETCARD: prod anahtarlarini sahibinden iste.', '--brief', 'Orbit canliya');
    report({ kind: 'delegated', sid: d.json?.sessionId ?? null, status: d.status, out: d.out });
    return 'Orbit canliya isini devraldim.';
  }
  if (!text.startsWith('[super') && text.includes('neden key')) {
    report({ kind: 'why' });
    return 'Anahtarlari ben istemiyorum, Orbit isi istiyor: canli KV ve odeme verisini okumadan duman testini kosamiyor.\\n\\n'
      + 'Kart yalniz .env.golive dosyasina yazar; degerleri ne ben ne de is gorur, yalniz adlariyla kullanilir.\\n\\n'
      + 'Istemezsen Not needed de; is anahtarsiz kismi bitirip durur.';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', owner: /event=owner/.test(text), text: text.slice(0, 300) }); return /event=owner/.test(text) ? 'Orbit seni bekliyor: prod anahtarlari gerekiyor.' : 'Tamam.'; }
  return 'Not aldim.';
}
async function childTurn(text) {
  if (text.includes('SECRETCARD')) {
    report({ kind: 'secret', sid });
    return 'Canliya cikis icin prod KV ve odeme okuma anahtarlari gerekiyor; bunlar sende.' + fence({ type: 'secret', id: 'golive', title: 'Asama 1: prod KV + odeme okuma', file: '.env.golive', fields: [
      { key: 'CONFIG_API_URL', label: 'KV worker URL', hint: 'GitHub production env secret CONFIG_API_URL' },
      { key: 'CONFIG_API_KEY', label: 'KV okuma anahtari', hint: 'production env CONFIG_API_KEY' },
      { key: 'CONFIG_API_ADMIN_KEY', label: 'KV admin (yazma) anahtari', hint: 'kv-push anahtari' },
      { key: 'PAY_READ_KEY', label: 'Odeme live restricted key', hint: 'yalniz okuma izni' },
    ] });
  }
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
    ok('the child left a secret card for the owner', await until(page, async () => reports().some((r) => r.kind === 'secret'), 90000));
    const card = page.locator('[data-super-slot="centre"] [data-testid="super-owner-card"]');
    ok('the card is drawn in the Super chat', await until(page, async () => (await card.count()) === 1, 30000));
    ok('the Super heard the owner wait (event=owner)', await until(page, async () => reports().some((r) => r.kind === 'event' && r.owner), 30000));
    await page.waitForTimeout(1000);

    // He writes, the Super answers.
    await sayCentre(page, 'benden neden key istiyorsun anlamadım');
    ok('the Super answered his question', await until(page, async () => (await page.locator('[data-super-slot="centre"]').innerText()).includes('Kart yalniz .env.golive'), 30000));
    await page.waitForTimeout(1500);

    const measure = () => page.evaluate(() => {
      const centre = document.querySelector('[data-super-slot="centre"]');
      const cardEl = centre?.querySelector('[data-testid="super-owner-card"]');
      // The element holding a text, outside the card (the deepest one: its text node's parent).
      const holder = (needle) => {
        if (!centre) return null;
        const walk = document.createTreeWalker(centre, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if ((n.textContent ?? '').includes(needle)) return n.parentElement;
        return null;
      };
      const mine = holder('benden neden key istiyorsun');
      const answer = holder('Kart yalniz .env.golive');
      const pos = (a, b) => (a && b ? (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after') : 'missing');
      const composer = centre?.querySelector('.chat-cmp-input')?.getBoundingClientRect();
      const r = cardEl?.getBoundingClientRect();
      return {
        cardBeforeMine: pos(cardEl, mine), cardBeforeAnswer: pos(cardEl, answer),
        place: cardEl?.getAttribute('data-place') ?? null,
        cardTop: r ? Math.round(r.top) : null, cardBottom: r ? Math.round(r.bottom) : null, cardHeight: r ? Math.round(r.height) : null,
        composerTop: composer ? Math.round(composer.top) : null,
      };
    });
    const goLatest = async () => {
      const latest = page.locator('[data-super-slot="centre"]').getByRole('button', { name: /Latest|En yeni|Son/ }).first();
      if (await latest.count()) await latest.click().catch(() => {});
      await page.waitForTimeout(800);
    };
    await goLatest();
    await page.mouse.move(5, 5);
    facts.desktop = await measure();
    log(`  desktop: ${JSON.stringify(facts.desktop)}`);
    await shot(page, 'kart-1440.png');
    placed('1440: the card comes BEFORE his later message in the chat', facts.desktop.cardBeforeMine === 'before', JSON.stringify(facts.desktop), facts.desktop.cardTop !== null);
    placed('1440: …and before the Super\'s answer', facts.desktop.cardBeforeAnswer === 'before', JSON.stringify(facts.desktop), facts.desktop.cardTop !== null);
    placed('1440: the card is in its place in the transcript, not the tail', facts.desktop.place === 'history', String(facts.desktop.place), facts.desktop.cardTop !== null);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await goLatest();
    facts.phone = await measure();
    log(`  phone: ${JSON.stringify(facts.phone)}`);
    await shot(page, 'kart-390.png');
    placed('390: the card comes BEFORE his later message and the answer', facts.phone.cardBeforeMine === 'before' && facts.phone.cardBeforeAnswer === 'before', JSON.stringify(facts.phone), facts.phone.cardTop !== null);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('390 px: no horizontal overflow', overflow <= 1, `scrollWidth over by ${overflow}`);
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(1500);

    // The bar's "Enter secret" brings the card into view, wherever it is in the chat.
    await goLatest();
    const verb = page.getByTestId('super-queue-card-secret').first();
    if (await verb.count()) {
      await verb.click();
      ok('the bar\'s "Enter secret" brings the card into view', await until(page, async () => page.evaluate(() => {
        const el = document.querySelector('[data-super-slot="centre"] [data-testid="super-owner-card"]');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.top >= 0 && r.top < innerHeight - 120;
      }), 5000));
      await page.waitForTimeout(800);
      await page.mouse.move(5, 5);
      await shot(page, 'enter-secret-1440.png');
    } else {
      ok('the bar offers "Enter secret"', false, 'no super-queue-card-secret');
    }
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
