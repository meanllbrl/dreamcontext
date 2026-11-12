#!/usr/bin/env node
/**
 * The Super chat never scrolls past what the owner has not read (owner 2026-11-12): the real
 * dashboard server, a scratch HOME and a scripted `claude`, real Chromium, light and dark, 1440 and
 * 390 px. The Super writes a report taller than the view and then asks; the first unread message's
 * top must be in view when the turn ends, and stay there; read needs the start; the pill names a
 * waiting question; the band's Answer goes to the information first, the card second (K1 = A); a
 * streamed answer stops at its first line; away, back and a reload land on the first unread; the
 * reader's own choice of the end wins.
 *
 *   npm run build && node scripts/verify/super-unread-follow.mjs
 *   SHOTS_DIR=<dir> keeps the screenshots and the numbers (olcum.json) there.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = process.env.CLI_PATH || join(REPO, 'dist', 'index.js');
const SHOTS = process.env.SHOTS_DIR || join(REPO, 'tmp', 'verify-super-unread-follow');

/** A report about 1100 px tall at 1440: several paragraphs and lists, Turkish on purpose. */
const RAPOR = (tag) => [
  `**Durum ${tag}: bugünkü durum**`,
  'Ödeme sayfasını üç adıma böldüm: sepet, adres, kart. Her adım kendi alanlarını doğruluyor, geri dönünce girilen bilgiler korunuyor. Eski tek sayfalı akış yerinde duruyor, yenisi ayar ile açılıyor.',
  '**Ne bitti**\n\n- Sepet adımı: ürün adedi değişince toplam anında güncelleniyor.\n- Adres adımı: posta kodundan il ve ilçe kendiliğinden doluyor.\n- Kart adımı: hatalı kart numarası alanın altında, sade bir cümleyle söyleniyor.\n- 14 dosya değişti, testlerin hepsi yeşil.',
  '**Ne kaldı**\n\n- Yıllık plan seçilince gösterilecek indirim. Fiyat sayfası ve ödeme özeti bu sayıya bağlı.\n- Kart reddedilince gösterilen mesajların son hali.\n- Telefonda klavye açıkken "Devam" düğmesinin görünür kalması.',
  '**Ölçtüğüm**\n\nGeçen hafta ödeme sayfasına gelen 100 kişiden 31\'i ödemeyi bitirdi. Yeni akışın denemesinde bu sayı 38. Fark en çok adres adımından geliyor: eski sayfada en çok orada bırakılıyordu.',
  '**Yıllık indirim neden şimdi**\n\nAylık plan 12 dolar. Yıllık planda yüzde 15 indirim yıllık 122 dolar, yüzde 20 indirim 115 dolar eder. Rakiplerin çoğu yüzde 16 ile 20 arasında veriyor. Yüzde 20 daha çok kişiyi yıllığa çeker ama kişi başı gelir 7 dolar düşer. Sayıyı sen seçince fiyat sayfasını ve ödeme özetini ona göre bitireceğim.',
].join('\n\n');

const standin = (FRAMES, REPORTS, RAPOR_SRC) => `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const RAPOR = ${RAPOR_SRC};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const convo = at('--resume') || at('--session-id') || '';
const sid = convo || 'follow-' + process.pid;
const persist = (type, content) => {
  if (!convo) return;
  const dir = join(process.env.HOME, '.claude', 'projects', 'verify-super');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, convo + '.jsonl'), JSON.stringify({ type, sessionId: convo, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: type, content } }) + '\\n');
};
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const shq = (a) => /^[A-Za-z0-9_.\\/:=-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\\\''") + "'";
const bashCall = (...args) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: ['dreamcontext', ...args].map(shq).join(' '), description: 'Ask the owner' } }] } });
  const r = cli(...args);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: r.out.trim() }], is_error: r.status !== 0 }] } });
  return r;
};
const say = (text) => { const block = [{ type: 'text', text }]; persist('assistant', block); out({ type: 'assistant', message: { role: 'assistant', content: block } }); };
const askOwner = (tag) => bashCall('super', 'ask', 'Yıllık planda indirim yüzde kaç olsun? (' + tag + ')',
  '--title', 'Ödeme akışı → yıllık plan indirimi',
  '--description', 'Fiyat sayfası ve ödeme özeti bu sayıya bağlı; seçince ikisini de bitiririm.',
  '--option', '%15::Yıllık 122 dolar, kişi başı gelir yüksek kalır',
  '--option', '%20::Yıllık 115 dolar, daha çok kişi yıllığa geçer',
  '--option', 'İndirim yok::Yıllık plan aylığın 12 katı');
/** Token by token, as the real CLI streams with --include-partial-messages. */
async function stream(text) {
  out({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const step = Math.ceil(text.length / 60);
  for (let i = 0; i < text.length; i += step) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + step) } } });
    await sleep(70);
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  say(text);
  out({ type: 'stream_event', event: { type: 'message_stop' } });
}
async function superTurn(text, all) {
  const ref = (/<owner-msg ref="([^"]+)"/.exec(all) || [])[1];
  const head = ref ? '<!-- re:' + ref + ' -->\\n' : '';
  if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'Devraldım.'; }
  if (text.startsWith('[super answer]')) { report({ kind: 'answer', text }); return ''; }
  if (text.startsWith('[super')) return '';
  const m = /^(RAPOR|IKI|AKIS|KISA) ?(\\S*)/.exec(text.trim());
  if (!m) { report({ kind: 'owner', text }); return 'ok'; }
  const [, what, tag] = m;
  if (what === 'KISA') { await sleep(400); say(head + 'Not aldım (' + tag + '): yarın sabah ilk iş kart hata mesajlarına bakacağım.'); return ''; }
  await sleep(700);
  if (what === 'AKIS') { await stream(head + RAPOR(tag)); return ''; }
  say(head + RAPOR(tag));
  await sleep(500);
  if (what === 'IKI') { say('Bir de not (' + tag + '): kart hata mesajlarının metnini yarın sana ayrıca göstereceğim.'); await sleep(400); }
  report({ kind: 'asked', r: askOwner(tag) });
  return '';
}
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '', blocks.join('\\n')) : 'ok'; } catch (e) { said = 'error ' + e; }
  if (said) say(said);
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
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks, folded: running }) + '\\n');
    persist('user', blocks.map((text) => ({ type: 'text', text })));
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

const fails = [];
const ok = (label, cond, detail) => { console.log(`  ${cond ? '✓' : '✗'} ${label}${detail !== undefined ? `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 900) : ''}`); if (!cond) fails.push(label); return !!cond; };
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); } return false; };
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** In the page: the visible chat scroller and where a tagged report and the newest card stand. */
const MEASURE = `(() => {
  window.__dcFollow = (tag) => {
    const shown = (sel) => [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().height > 0);
    const sc = shown('[data-super-slot="centre"] .chat-scroll') || shown('.super-dock .chat-scroll') || shown('.chat-scroll');
    if (!sc) return null;
    const view = sc.getBoundingClientRect();
    const rows = [...sc.querySelectorAll('[data-item-id]')];
    const rep = tag ? rows.find((r) => r.textContent.includes('Durum ' + tag + ':')) : null;
    const host = rep && rep.previousElementSibling && rep.previousElementSibling.hasAttribute('data-reply-strip') ? rep.previousElementSibling : rep;
    const cards = sc.querySelectorAll('[data-testid="super-question-card"]');
    const card = cards[cards.length - 1];
    const r = host ? host.getBoundingClientRect() : null;
    const c = card ? card.getBoundingClientRect() : null;
    const bar = document.querySelector('[data-testid="super-unread-bar"]');
    return {
      viewH: Math.round(view.height),
      reportTop: r ? Math.round(r.top - view.top) : null,
      reportH: rep ? Math.round(rep.getBoundingClientRect().height) : null,
      reportUnread: rep ? rep.hasAttribute('data-unread') : null,
      lineOnReport: host ? host.hasAttribute('data-unread-first') : null,
      cardTop: c ? Math.round(c.top - view.top) : null,
      cardBottom: c ? Math.round(c.bottom - view.top) : null,
      cardH: c ? Math.round(c.height) : null,
      scrollTop: Math.round(sc.scrollTop),
      distToBottom: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
      dots: sc.querySelectorAll('[data-unread]').length,
      bar: bar ? bar.querySelector('[data-testid="super-unread-jump"]').textContent : null,
      latest: !!document.querySelector('.chat-jump'),
      rowTops: rows.slice(-12).map((e) => Math.round(e.getBoundingClientRect().top - view.top)),
    };
  };
  /** A per-frame trace of one report's top on screen (and scrollTop, a diagnostic). */
  window.__dcTrace = { on: false, frames: [] };
  const tick = () => {
    if (window.__dcTrace.on) { const m = window.__dcFollow(window.__dcTrace.tag); if (m) window.__dcTrace.frames.push({ t: Math.round(performance.now()), top: m.reportTop, st: m.scrollTop, d: m.distToBottom }); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

async function run() {
  const SCRATCH = join(tmpdir(), `dc-verify-super-follow-${process.pid}`);
  const HOME = join(SCRATCH, 'home');
  const PROJ = join(SCRATCH, 'acme-app');
  const FRAMES = join(SCRATCH, 'frames.ndjson');
  const REPORTS = join(SCRATCH, 'reports.ndjson');
  const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, standin(FRAMES, REPORTS, RAPOR.toString()));
  chmodSync(bin, 0o755);
  const added = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (added.status !== 0) throw new Error(`vaults add failed: ${added.stderr || added.stdout}`);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.pipe(createWriteStream(join(SCRATCH, 'server.log'))); srv.stderr.pipe(createWriteStream(join(SCRATCH, 'server.err')));
  for (const end = Date.now() + 60_000; Date.now() < end;) {
    try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const reports = () => readNd(REPORTS);
  const frames = () => readNd(FRAMES);
  const turnEnds = () => reports().filter((r) => r.kind === 'turn-end').length;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', locale: 'tr-TR' });
  await context.addInitScript(MEASURE);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const log = {};
  const note = (k, v) => { log[k] = v; };
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const m = (tag) => page.evaluate((t) => window.__dcFollow(t), tag);
  const blur = (off) => page.evaluate(async (v) => { Document.prototype.hasFocus = () => !v; window.dispatchEvent(new Event(v ? 'blur' : 'focus')); await new Promise((r) => setTimeout(r, 50)); }, off);
  const input = () => page.locator('[data-super-slot="centre"] .chat-cmp-input, .super-dock .chat-cmp-input').filter({ visible: true }).first();
  const send = async (text) => { const i = input(); await i.click(); await i.fill(text); await page.keyboard.press('Enter'); };
  const round = async (text, { away = false } = {}) => {
    const before = turnEnds();
    if (away) await blur(true);
    await send(text);
    if (away) await blur(true);
    if (!(await until(page, async () => turnEnds() > before, 60000))) throw new Error(`no turn end for ${text}`);
  };
  const trace = {
    start: (tag) => page.evaluate((t) => { window.__dcTrace = { on: true, tag: t, frames: [] }; }, tag),
    stop: () => page.evaluate(() => { window.__dcTrace.on = false; return window.__dcTrace.frames; }),
  };
  const answer = async () => {
    const card = page.locator('[data-testid="super-question-card"]').filter({ visible: true }).last();
    const n = reports().filter((r) => r.kind === 'answer').length;
    await card.getByText('%20', { exact: true }).first().click();
    await page.waitForTimeout(250);
    await card.getByRole('button', { name: /Submit|Gönder/ }).click();
    await until(page, async () => reports().filter((r) => r.kind === 'answer').length > n, 15000);
    await page.waitForTimeout(1200);
  };
  const toLatest = async () => {
    const b = page.locator('[data-testid="super-unread-bottom"], .chat-jump').filter({ visible: true }).first();
    if (await b.count()) { await b.click(); await page.waitForTimeout(700); }
  };
  /** Where the report sits on screen, the landing band: 0 … landing (64) + start slack (8). */
  const inBand = (top) => top !== null && top >= 0 && top <= 72;
  const maxJump = (fs) => fs.reduce((mx, f, i) => (i && f.top !== null && fs[i - 1].top !== null ? Math.max(mx, Math.abs(f.top - fs[i - 1].top)) : mx), 0);

  /** Criterion 1 + 2 at one size and theme: at the screen, pinned, report then question. */
  const atScreen = async (tag, label) => {
    await blur(false);
    await toLatest();
    await trace.start(tag);
    await round(`RAPOR ${tag}`);
    await page.waitForTimeout(400);
    const end = await m(tag);
    const mark = (await page.evaluate(() => window.__dcTrace.frames.length));
    await page.waitForTimeout(4000);
    const all = await trace.stop();
    const after = all.slice(mark);
    note(`${label}-turn-end`, end);
    note(`${label}-trace`, { frames: after.length, maxJump: maxJump(after), first: after[0], last: after[after.length - 1] });
    ok(`[${label}] AC1: the report's top is in view when the turn ends (0..72 px; today −1201 / −1639)`, inBand(end?.reportTop), end);
    ok(`[${label}] AC2: for 4 s after, with no input, the report does not move on screen (max frame Δ ≤ 1 px)`, after.length > 30 && maxJump(after) <= 1, { frames: after.length, maxJump: maxJump(after) });
    await page.mouse.move(5, 5);
    await shot(`sonra-${label}-1-rapor-basinda`);
    return end;
  };

  try {
    await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    const rail = page.locator('[data-testid="ns-rail-chat"]');
    if (await rail.count()) await rail.first().click();
    await page.waitForTimeout(900);
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat|Sohbet başlat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 30000);
    await page.locator('.chat-cmp-input:visible').first().fill('merhaba');
    await page.keyboard.press('Enter');
    await until(page, async () => frames().some((f) => f.role === 'child'), 30000);
    await page.waitForTimeout(1200);
    await page.locator('[data-testid="drawer-super-row"]:visible, [data-testid="super-handover-btn"]:visible').first().click();
    await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 30000);
    await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000);
    await until(page, async () => (await input().count()) > 0, 30000);
    await page.waitForTimeout(2500);

    console.log('\n── 1440 light: at the screen');
    const a = await atScreen('A', '1440-acik');
    // The report is read once its start has been on screen a second: then the question is next.
    await page.waitForTimeout(600);
    const aRead = await m('A');
    note('A-read', aRead);
    ok('[1440-acik] AC3b: once its first line has been in view 1 s it is read, and no row moved (layout shift 0)', aRead?.reportUnread === false && JSON.stringify(aRead.rowTops) === JSON.stringify((await m('A')).rowTops) && aRead.reportTop === a?.reportTop, { before: a?.reportTop, after: aRead?.reportTop, unread: aRead?.reportUnread });
    ok('[1440-acik] AC4a: the question below the fold: the pill reads "Question waiting"', /Question waiting|Soru bekliyor/.test(aRead?.bar ?? ''), aRead?.bar);
    await page.locator('[data-testid="super-unread-jump"]').filter({ visible: true }).first().click();
    await page.waitForTimeout(900);
    const aCard = await m('A');
    note('A-card', aCard);
    const fits = aCard.cardH <= aCard.viewH;
    ok('[1440-acik] AC4b: one click brings the card whole into view', fits ? aCard.cardTop >= 0 && aCard.cardBottom <= aCard.viewH : aCard.cardTop >= 0 && aCard.cardTop <= 16, aCard);
    await page.mouse.move(5, 5);
    await shot('sonra-1440-acik-2-soru');
    await answer();

    console.log('\n── 1440 light: read needs the start; the band\'s Answer goes to the information first (K1 = A)');
    await round('IKI B', { away: true });
    await page.waitForTimeout(800);
    // His own wheel puts the report's END at the view's bottom, its start above: the old rule read it.
    const b0 = await m('B');
    const sc = page.locator('.chat-scroll').filter({ visible: true }).first();
    const box = await sc.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const wantTop = b0.viewH - b0.reportH;
    await page.mouse.wheel(0, b0.reportTop - wantTop);
    await page.waitForTimeout(700);
    await blur(false);
    await page.waitForTimeout(3200);
    const b1 = await m('B');
    note('B-end-in-view', b1);
    ok('[1440-acik] AC3a: a report whose first line never entered the view is still unread after 3 s', b1.reportTop < 0 && b1.reportUnread === true, b1);
    await shot('sonra-1440-acik-3-sonu-gorunur-okunmadi');
    const answerBtn = page.locator('[data-testid="super-queue-answer"]').filter({ visible: true }).first();
    await answerBtn.click();
    await page.waitForTimeout(900);
    const b2 = await m('B');
    note('B-answer-1', b2);
    ok('[1440-acik] AC10a: Answer with unread above the card lands on that unread\'s start', inBand(b2.reportTop), b2);
    await page.mouse.move(5, 5);
    await shot('sonra-1440-acik-4-yanitla-once-bilgi');
    await answerBtn.click();
    await page.waitForTimeout(900);
    const b3 = await m('B');
    note('B-answer-2', b3);
    ok('[1440-acik] AC10b: pressed again (two unread above) it lands on the card', b3.cardTop !== null && b3.cardTop >= 0 && (b3.cardH <= b3.viewH ? b3.cardBottom <= b3.viewH : b3.cardTop <= 16), b3);
    await page.mouse.move(5, 5);
    await shot('sonra-1440-acik-5-yanitla-sonra-soru');
    await answer();

    console.log('\n── 1440 light: a short reply that fits');
    await toLatest();
    await round('KISA C');
    await page.waitForTimeout(1500);
    const c = await m(null);
    note('C-short', c);
    ok('[1440-acik] AC5: a short reply that fits: at the bottom, pinned, no pill (distance ≤ 48)', c.distToBottom <= 48 && !c.latest && c.bar === null, c);

    console.log('\n── 1440 light: a streamed long answer');
    await toLatest();
    await trace.start('D');
    await round('AKIS D');
    await page.waitForTimeout(1600);
    const dFrames = await trace.stop();
    const d = await m('D');
    note('D-stream', { end: d, frames: dFrames.length });
    const seen = dFrames.filter((f) => f.top !== null);
    const capAt = seen.findIndex((f) => f.top <= 72);
    const afterCap = capAt >= 0 ? seen.slice(capAt) : [];
    ok('[1440-acik] AC6: a streamed answer stops at its first line; it stays in view until the end; the plain Latest pill shows', capAt >= 0 && afterCap.every((f) => f.top >= 0 && f.top <= 72) && d.latest && d.bar === null, { capAt, afterCap: afterCap.length, minTop: Math.min(...afterCap.map((f) => f.top)), maxTop: Math.max(...afterCap.map((f) => f.top)), latest: d.latest, bar: d.bar });
    await shot('sonra-1440-acik-6-akis');

    console.log('\n── 1440 light: away, then back; a reload');
    await toLatest();
    await round('RAPOR E', { away: true });
    await page.waitForTimeout(1500);
    await blur(false);
    await page.waitForTimeout(300);
    const e = await m('E');
    note('E-back', e);
    ok('[1440-acik] AC7a: back at the window: already on the first unread\'s start, the "Unread" line above it', inBand(e.reportTop) && e.lineOnReport === true && e.reportUnread === true, e);
    await shot('sonra-1440-acik-7-donunce');
    // The reload: before the marks are read, nothing; the landing must not show the bottom first.
    await blur(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__dcTrace = { on: true, tag: 'E', frames: [] }; });
    await until(page, async () => (await input().count()) > 0, 30000);
    await page.waitForTimeout(2500);
    const reloadFrames = await trace.stop();
    await blur(false);
    await page.waitForTimeout(300);
    const e2 = await m('E');
    const shownAtBottom = reloadFrames.filter((f) => f.top !== null && f.top < 0 && f.d <= 48).length;
    note('E-reload', { at: e2, framesAtBottomFirst: shownAtBottom, frames: reloadFrames.length });
    ok('[1440-acik] AC7b: after a reload the view is on the first unread\'s start', inBand(e2.reportTop), { at: e2.reportTop, framesAtBottomFirst: shownAtBottom });

    console.log('\n── 1440 light: the reader\'s choice of the end wins');
    await answer();
    await toLatest();
    const f0 = await m('E');
    await round('KISA F');
    await page.waitForTimeout(1500);
    const f1 = await m('E');
    note('F-after-latest', { before: f0, after: f1 });
    ok('[1440-acik] AC8: after Latest, the older unread above no longer pulls the view up; the new reply is followed', f1.distToBottom <= 48 && !f1.latest, { distToBottom: f1.distToBottom, reportTop: f1.reportTop, unread: f1.reportUnread });

    console.log('\n── 1440 dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(400);
    await atScreen('H', '1440-koyu');
    await page.waitForTimeout(1500);
    await page.locator('[data-testid="super-unread-jump"]').filter({ visible: true }).first().click().catch(() => {});
    await page.waitForTimeout(900);
    await page.mouse.move(5, 5);
    await shot('sonra-1440-koyu-2-soru');
    await answer();

    for (const scheme of ['dark', 'light']) {
      const label = `390-${scheme === 'dark' ? 'koyu' : 'acik'}`;
      console.log(`\n── ${label}`);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(1500);
      await page.locator('[data-testid="super-dock-pill"]').filter({ visible: true }).first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const tag = scheme === 'dark' ? 'G' : 'I';
      await atScreen(tag, label);
      const folded = await page.evaluate(() => !!document.querySelector('.chat-pane[data-composer-folded], .chat-cmp[data-folded], .chat-composer-folded'));
      note(`${label}-composer-folded`, folded);
      await page.waitForTimeout(1500);
      await page.locator('[data-testid="super-unread-jump"]').filter({ visible: true }).first().click().catch(() => {});
      await page.waitForTimeout(900);
      const card = await m(tag);
      note(`${label}-card`, card);
      ok(`[${label}] AC4b/D5: a card taller than the view shows its top (0..16 px), or the whole card when it fits`, card.cardTop !== null && (card.cardH <= card.viewH ? card.cardTop >= 0 && card.cardBottom <= card.viewH : card.cardTop >= 0 && card.cardTop <= 16), card);
      await page.mouse.move(5, 5);
      await shot(`sonra-${label}-2-soru`);
      await answer();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(1200);
    }

    const real = errors.filter((x) => !/favicon|ERR_CONNECTION|WebSocket|Failed to load resource/i.test(x));
    note('console-errors', real);
    ok('AC12: no console errors', real.length === 0, real);
  } catch (err) {
    fails.push(`crash: ${err?.message ?? err}`);
    console.log('CRASH', err?.stack || String(err));
    await page.screenshot({ path: join(SHOTS, 'zz-crash.png') }).catch(() => {});
  } finally {
    writeFileSync(join(SHOTS, 'olcum.json'), `${JSON.stringify(log, null, 2)}\n`);
    await context.close();
    await browser.close();
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', bin]);
    rmSync(SCRATCH, { recursive: true, force: true });
  }
}

await run();
console.log(fails.length ? `\n${fails.length} check(s) failed:\n  - ${fails.join('\n  - ')}` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
