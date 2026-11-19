#!/usr/bin/env node
/**
 * The Super's own question stays where it was asked: the owner's later messages go UNDER it
 * (owner 2026-11-15: "önce soru soruldu sonra ben başka mesaj attım sorular sorunun üstüne gitti
 * neden? Sorunun altına geçmeliydi"). The real dashboard server from a built checkout (scratch
 * HOME, DREAMCONTEXT_DESKTOP=1), a scripted stand-in `claude` (no tokens), fictional project "orbit".
 *
 *   npm run build && node scripts/verify/super-soru-yerinde.mjs --out <dir> [--dist <checkout>] [--label before|after]
 *
 * The owner hands one chat over; on the child's event the Super runs `dreamcontext super ask
 * --json … 2>&1 | tail -3`, exactly as in the owner's case: the tail cuts the server's acceptance
 * out of the tool result, so the transcript cannot tie the card to its call (before the fix such
 * a card fell to the chat's tail, under everything said after it). It says the card waits. The owner then writes about something else.
 * Measured: the question card comes BEFORE his message and the Super's reply to it, at 1440 and
 * 390. Then "Unclear? Ask again": the Super asks again, and the one open card is the new one,
 * after his unclear answer; the first card is no longer open. `--dist` runs another checkout's
 * build (the "before" picture); `--label before` turns the placement checks into "bug reproduced".
 *
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const DIST_REPO = resolve(arg('--dist') ?? REPO);
const LABEL = arg('--label') ?? 'after';
const BUG = LABEL === 'before';
const placed = (name, cond, detail, drawn) => ok(BUG ? `(old build, bug reproduced) NOT: ${name}` : name, drawn && (BUG ? !cond : cond), detail);
const OUT = resolve(arg('--out') ?? join(REPO, 'tmp', 'verify-super-soru-yerinde'));
const { chromium } = createRequire(join(REPO, 'package.json'))('playwright');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-soru-yerinde-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(DIST_REPO, 'dist', 'index.js');
const LOGS = join(OUT, `logs-${LABEL}`);
const REPORTS = join(SCRATCH, 'reports.ndjson');
const W = 1440; const H = 900;

const ASK = {
  title: 'Orbit iadesi → ne olsun',
  questions: [{
    question: 'Orbit musterisinin kalan iade tutari ne olsun?', header: 'Iade', multiSelect: false,
    options: [{ label: 'Kapat, yeniden baslat', description: 'Takilan is kapanir.' }, { label: 'Birak', description: 'Bir sey yapilmaz.' }],
  }],
};
const ASK2 = { ...ASK, questions: [{ ...ASK.questions[0], question: 'Iade tutarini simdi geri odeyelim mi?' }] };

function standin(REPORTS, CLI) {
  return `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\\n');
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: ((r.stdout || '') + (r.stderr || '')).slice(0, 2000) };
};
if (!argv.includes('stream-json')) {
  if (argv.includes('-p')) out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: at('--resume') || randomUUID(), num_turns: 1, total_cost_usd: 0, duration_ms: 5 });
  else out({});
  process.exit(0);
}
let brief = '';
try { brief = (await import('node:fs')).readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = at('--session-id') || at('--resume') || randomUUID();
const tdir = join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
try { mkdirSync(tdir, { recursive: true }); } catch {}
const row = (o) => { try { appendFileSync(join(tdir, sid + '.jsonl'), JSON.stringify({ cwd: process.cwd(), uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: sid, ...o }) + '\\n'); } catch {} };
report({ kind: 'spawn', role, sid, resumed: !!at('--resume') });
process.on('SIGTERM', () => process.exit(0));
let seq = 0;
const shq = (a) => /^[A-Za-z0-9_.\\/:=-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\\\''") + "'";
// tail: the call piped through \`2>&1 | tail -3\`, as the Super did in the owner's case (15 Nov):
// the result keeps only the JSON's last lines, so the chat cannot tie the card to its call.
const bashCall = (opts, ...args) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  const command = ['dreamcontext', ...args].map(shq).join(' ') + (opts.tail ? ' 2>&1 | tail -3' : '');
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Ask the owner' } }] } });
  const r = cli(...args);
  const shown = opts.tail ? r.out.trim().split('\\n').slice(-3).join('\\n') : r.out.trim();
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: shown }], is_error: r.status !== 0 }] } });
  return r;
};
let asked = false;
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const d = cli('super', 'delegate', '--prompt', 'IADE: Orbit musterisinin iadesine bak.', '--brief', 'Orbit iadesi');
    report({ kind: 'delegated', sid: d.json?.sessionId ?? null, status: d.status, out: d.out });
    return 'Orbit iadesi isini devraldim.';
  }
  if (text.startsWith('[super answer]') && /unclear/.test(text)) {
    const r = bashCall({ tail: false }, 'super', 'ask', '--json', ${JSON.stringify(JSON.stringify(ASK2))});
    report({ kind: 'reasked', status: r.status, out: r.out });
    return 'Soruyu daha acik sordum.';
  }
  if (text.startsWith('[super') && !asked) {
    asked = true;
    const r = bashCall({ tail: true }, 'super', 'ask', '--json', ${JSON.stringify(JSON.stringify(ASK))});
    report({ kind: 'asked', status: r.status, out: r.out, event: text.slice(0, 200) });
    return 'Kart Bekleyenler listende duruyor.';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 200) }); return 'Tamam.'; }
  if (text.includes('scroll area')) { report({ kind: 'mine' }); return 'Kaydirma notunu aldim, ayri is olarak bakacagim.'; }
  return 'Not aldim.';
}
async function childTurn() { return 'Iade kaydina baktim; karar sahibin.'; }
let inited = false;
async function turn(blocks, content) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  const text = blocks.join('\\n');
  report({ kind: role + '-turn', sid, text: text.slice(0, 4000) });
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
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH, SHELL: '/bin/sh' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const CARD = '[data-super-slot="centre"] [data-testid="super-question-card"]';

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  log(`server on ${base} (dist of ${DIST_REPO}), scratch ${SCRATCH}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'tr-TR' });
  await context.addInitScript(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
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
    await input.fill('Orbit iadesine bak.');
    await page.keyboard.press('Enter');
    await until(page, async () => reports().some((r) => r.kind === 'child-turn'), 60000);
    await page.waitForTimeout(1500);
    await page.locator('[data-testid="drawer-super-row"]:visible, [data-testid="super-handover-btn"]:visible').first().click();
    await motionIdle(page);
    ok('the Super asked the owner inside an event turn (super ask accepted)', await until(page, async () => reports().some((r) => r.kind === 'asked' && r.status === 0), 90000), JSON.stringify(reports().filter((r) => r.kind === 'asked')));
    ok('the question card is drawn in the Super chat', await until(page, async () => (await page.locator(CARD).count()) >= 1, 30000));
    ok('the Super said the card waits', await until(page, async () => (await page.locator('[data-super-slot="centre"]').innerText()).includes('Kart Bekleyenler listende'), 30000));
    await page.waitForTimeout(1200);

    // He writes about something else while the question is open; the Super replies.
    await sayCentre(page, 'burada scroll area çok dar, kaydırınca üst kısım da kaysın');
    ok('the Super replied to his message', await until(page, async () => (await page.locator('[data-super-slot="centre"]').innerText()).includes('Kaydirma notunu aldim'), 30000));
    await page.waitForTimeout(1500);

    const measure = () => page.evaluate((sel) => {
      const centre = document.querySelector('[data-super-slot="centre"]');
      const cards = [...(centre?.querySelectorAll(sel.replace('[data-super-slot="centre"] ', '')) ?? [])];
      const open = cards.filter((c) => c.getAttribute('data-state') === 'open');
      const cardEl = cards[0];
      const holder = (needle) => {
        if (!centre) return null;
        const walk = document.createTreeWalker(centre, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if ((n.textContent ?? '').includes(needle) && !n.parentElement?.closest('[data-testid="super-question-card"]')) return n.parentElement;
        return null;
      };
      const mine = holder('burada scroll area');
      const reply = holder('Kaydirma notunu aldim');
      const pos = (a, b) => (a && b ? (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after') : 'missing');
      const r = cardEl?.getBoundingClientRect();
      const m = mine?.getBoundingClientRect();
      return {
        cards: cards.length, open: open.length,
        cardBeforeMine: pos(cardEl, mine), cardBeforeReply: pos(cardEl, reply),
        cardY: r ? Math.round(r.top) : null, mineY: m ? Math.round(m.top) : null,
      };
    }, CARD);
    const goLatest = async () => {
      const latest = page.locator('[data-super-slot="centre"]').getByRole('button', { name: /Latest|En yeni|Son/ }).first();
      if (await latest.count()) await latest.click().catch(() => {});
      await page.waitForTimeout(800);
    };
    await goLatest();
    await page.mouse.move(5, 5);
    facts.desktop = await measure();
    log(`  desktop: ${JSON.stringify(facts.desktop)}`);
    // His message in view under the card: scroll it to the middle for the picture.
    await page.evaluate(() => {
      const centre = document.querySelector('[data-super-slot="centre"]');
      const walk = document.createTreeWalker(centre, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if ((n.textContent ?? '').includes('burada scroll area')) { n.parentElement.scrollIntoView({ block: 'center' }); break; }
    });
    await page.waitForTimeout(600);
    await shot(page, 'soru-1440.png');
    const drawn = facts.desktop.cards >= 1 && facts.desktop.cardBeforeMine !== 'missing';
    placed('1440: the question card comes BEFORE his later message', facts.desktop.cardBeforeMine === 'before', JSON.stringify(facts.desktop), drawn);
    placed('1440: …and before the Super\'s reply to it', facts.desktop.cardBeforeReply === 'before', JSON.stringify(facts.desktop), drawn);
    placed('1440: card y < his message y', facts.desktop.cardY !== null && facts.desktop.mineY !== null && facts.desktop.cardY < facts.desktop.mineY, JSON.stringify(facts.desktop), drawn);
    ok('1440: the question is drawn once', facts.desktop.cards === 1, String(facts.desktop.cards));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await goLatest();
    facts.phone = await measure();
    log(`  phone: ${JSON.stringify(facts.phone)}`);
    await shot(page, 'soru-390.png');
    placed('390: the question card comes BEFORE his message and the reply', facts.phone.cardBeforeMine === 'before' && facts.phone.cardBeforeReply === 'before', JSON.stringify(facts.phone), facts.phone.cards >= 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('390 px: no horizontal overflow', overflow <= 1, `scrollWidth over by ${overflow}`);
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(1500);

    if (!BUG) {
      // "Unclear? Ask again": the Super asks again; the one open card is the new one.
      const unclear = page.locator(`${CARD} .chat-surveycard-more-btn`).first();
      if (await unclear.count()) {
        await unclear.scrollIntoViewIfNeeded().catch(() => {});
        await unclear.click().catch(() => {});
        await page.locator(`${CARD} [role="menuitem"]`).first().click().catch(() => {});
        const send = page.locator(`${CARD} button`, { hasText: /Send|Gönder/ }).first();
        if (await send.count()) await send.click().catch(() => {});
        ok('the Super asked again', await until(page, async () => reports().some((r) => r.kind === 'reasked' && r.status === 0), 30000), JSON.stringify(reports().slice(-4)));
        await page.waitForTimeout(2000);
        await goLatest();
        facts.reask = await page.evaluate((sel) => {
          const cards = [...document.querySelectorAll(sel)];
          return { cards: cards.length, open: cards.filter((c) => c.getAttribute('data-state') === 'open').map((c) => c.textContent?.includes('simdi geri odeyelim') ? 'new' : 'old') };
        }, CARD);
        log(`  re-ask: ${JSON.stringify(facts.reask)}`);
        ok('after the re-ask only the new question is open', facts.reask.open.length === 1 && facts.reask.open[0] === 'new', JSON.stringify(facts.reask));
        await page.mouse.move(5, 5);
        await shot(page, 'yeniden-sor-1440.png');
      } else {
        ok('the card offers "Unclear? Ask again"', false, 'no .chat-surveycard-more-btn');
      }
    }
    log(`  failed requests: ${JSON.stringify(failed)}`);
    const errs = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED|status of 403/i.test(e));
    ok('no page errors (403s on owner-key routes are the harness, listed above)', errs.length === 0, errs.slice(0, 3).join(' | '));
    writeFileSync(join(LOGS, 'console-errors.json'), JSON.stringify(errors, null, 2));
    writeFileSync(join(LOGS, 'facts.json'), JSON.stringify(facts, null, 2));
  } catch (e) {
    ok('the run completed', false, String(e).slice(0, 1200));
    await page.screenshot({ path: join(LOGS, 'fail.png') }).catch(() => {});
    log(`  page: ${(await page.locator('body').innerText().catch(() => '')).slice(0, 600).replace(/\n+/g, ' | ')}`);
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
