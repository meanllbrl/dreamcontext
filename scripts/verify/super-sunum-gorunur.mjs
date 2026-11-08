#!/usr/bin/env node
/**
 * Answer chips read their title, and what the Super presents reaches the owner's eyes (owner
 * 2026-11-08):
 *   1 a turn opens a page, two pictures and a page with a really long title: each chip is as wide
 *     as its title needs (no ellipsis) up to a cap; only the long one ellipsizes, its full title
 *     on hover. Measured at 1440, light and dark.
 *   2 the owner puts a page full screen; the Super presents a NEW picture: the full screen closes
 *     and the picture is presented in front of him.
 *   3 the owner sets the view himself (a chip click: side by side); past the hold (shortened to
 *     3 s here) a Super picture question presents its picture over it. Inside the hold it is
 *     answered `skipped` with a plain NOT-on-screen note.
 *   4 the phone (390): the chips, light and dark.
 *
 *   npm run build && node scripts/verify/super-sunum-gorunur.mjs [outDir]
 *
 * The real dashboard server from dist (scratch HOME) and a stand-in `claude` that plays main Super
 * and runs the REAL `dreamcontext super …` verbs. No tokens. Never empty outDir before a run: the
 * shots are swapped in only once this run took some.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { chatShown, openSuper } from './lib/phone-shell.mjs';
import { applyTheme, cleanEnv, freePort, pageFetch, reporter, sayOnStage, stage, startServer, superStandin, toMainStage, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-sunum-gorunur-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const FINAL = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'super-sunum-gorunur'));
const OUT = `${FINAL}.staging-${process.pid}`;
const LONG_TITLE = 'Checkout funnel teardown with every step, every drop-off and the three fixes we ship next week';
const ASKS = join(SCRATCH, 'asks.ndjson');

function swapShots() {
  let fresh = [];
  try { fresh = readdirSync(OUT).filter((f) => f.endsWith('.png')); } catch { /* never created */ }
  if (fresh.length) {
    mkdirSync(FINAL, { recursive: true });
    for (const f of readdirSync(FINAL)) if (f.endsWith('.png')) rmSync(join(FINAL, f), { force: true });
    for (const f of fresh) renameSync(join(OUT, f), join(FINAL, f));
  }
  rmSync(OUT, { recursive: true, force: true });
  return fresh.length;
}

const env = () => cleanEnv(HOME);
const { ok, summary } = reporter();

/** Main Super: each verb is a real CLI call, streamed and recorded as a Bash tool call. */
const MAIN = `
  const call = async (args) => {
    const id = 'toolu_' + Math.random().toString(36).slice(2);
    const input = { command: 'dreamcontext ' + args.join(' '), description: 'Stage' };
    const use = { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] };
    out({ type: 'assistant', message: use }); row({ type: 'assistant', message: use });
    const r = cli(...args);
    const res = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: r.out, is_error: r.status !== 0 }] };
    out({ type: 'user', message: res }); row({ type: 'user', message: res });
    await sleep(80);
    return r.json;
  };
  if (text.trimStart().startsWith('[super ')) return 'Tamam.';
  const head = text.lastIndexOf('<owner-msg') >= 0 ? text.slice(0, text.lastIndexOf('<owner-msg')) : text;
  const said = head.trim().split('\\n').pop() || '';
  if (/planı göster/i.test(said)) {
    await call(['super', 'open', 'web', 'reports/plan.html']);
    await call(['super', 'open', 'image', 'shots/one.png', 'shots/two.png']);
    await call(['super', 'open', 'web', 'reports/long.html', '--title', ${JSON.stringify(LONG_TITLE)}]);
    return 'Plan hazır: rapor, iki ekran görüntüsü ve uzun inceleme sahnede.';
  }
  if (/yeni resmi göster/i.test(said)) {
    // Later in the turn (as when it acts on an event): the owner opens a full screen meanwhile.
    await sleep(6000);
    await call(['super', 'open', 'image', 'shots/three.png', '--title', 'Yeni ödeme ekranı', '--present', '--no-group']);
    return 'Yeni ödeme ekranını sahneye koydum.';
  }
  if (/planı tekrar göster/i.test(said)) {
    await sleep(15000);
    const st = cli('super', 'state').json;
    const page = st.containers.find((k) => k.kind === 'web' && k.ref.endsWith('plan.html'));
    await call(['super', 'present', page ? page.id : 'web-missing']);
    return 'Planı yeniden sundum.';
  }
  if (/soruyu sor/i.test(said)) {
    const st = cli('super', 'state').json;
    const pic = st.containers.find((k) => k.kind === 'image' && k.ref === 'shots/three.png');
    // An earlier question of its own still open: closed first (one open ask at a time).
    for (const q of st.queue || []) if (q.kind === 'ask' && q.state === 'escalated') await call(['super', 'queue', 'done', q.id]);
    const r = await call(['super', 'ask', 'Bu ekran kalsın mı?', '--title', 'Ödeme ekranı → karar', '--option', 'Kalsın::olduğu gibi', '--option', 'Değişsin::yeniden çizilir', '--show', pic ? pic.id : 'image-missing']);
    appendFileSync(${JSON.stringify(ASKS)}, JSON.stringify(r) + '\\n');
    return 'Kararını soran kart ekranda.';
  }
  return 'Tamam.';
`;

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;margin:0;background:#f7f5ff;color:#1d1640}header{background:#6d4cff;color:#fff;padding:40px 56px}h1{margin:0;font-size:40px}p{padding:0 56px}</style></head>
<body><header><h1>${title}</h1></header><p>${body}</p></body></html>`;

async function pictures(pw) {
  const browser = await pw.chromium.launch();
  const p = await browser.newPage({ viewport: { width: 800, height: 600 } });
  for (const [name, bg, label] of [['one', '#ffb347', 'Checkout before'], ['two', '#4cc9a0', 'Checkout after'], ['three', '#7aa7ff', 'New checkout']]) {
    await p.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:${bg};font:700 56px system-ui;color:#1d1640">${label}</body>`);
    await p.screenshot({ path: join(PROJ, 'shots', `${name}.png`) });
  }
  await browser.close();
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'reports'), join(PROJ, 'shots'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(PROJ, 'reports', 'plan.html'), page('AI routing plan', 'Claude first, OpenRouter as fallback.'));
  writeFileSync(join(PROJ, 'reports', 'long.html'), page('Funnel teardown', 'Every step.'));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, superStandin({ reports: join(SCRATCH, 'reports.ndjson'), cli: CLI, main: MAIN }));
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}

const superState = async (p) => (await pageFetch(p, VAULT, 'GET', '/super/state')).json;
const shot = async (p, name) => { await p.mouse.move(5, 5); await p.waitForTimeout(500); await p.screenshot({ path: join(OUT, name) }); };
const both = async (p, name) => { for (const theme of ['dark', 'light']) { await applyTheme(p, theme); await shot(p, `${name}-${theme}.png`); } };

/** Every chip of the first answer: its title, drawn width, and whether its text is cut. */
const chipFacts = (row) => row.locator('[data-testid="super-turn-chip"]').evaluateAll((els) => els.map((e) => {
  const r = e.getBoundingClientRect();
  return { text: e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), cut: e.scrollWidth > e.clientWidth + 1, title: e.getAttribute('title') || e.getAttribute('aria-label') || '' };
}));

async function checkChips(p, label) {
  const row = stage(p, 'main').locator('[data-testid="super-turn-cards"]').first();
  const facts = await chipFacts(row);
  console.log(`   chips ${label}`, JSON.stringify(facts));
  const normal = facts.filter((f) => !f.text.includes('Checkout funnel'));
  const long = facts.find((f) => f.text.includes('Checkout funnel'));
  ok(`${label}: three chips`, facts.length === 3, String(facts.length));
  ok(`${label}: a normal title reads whole (plan.html, the picture group with its count)`, normal.length === 2 && normal.every((f) => !f.cut), JSON.stringify(normal));
  ok(`${label}: the long title ellipsizes, its full title on hover`, !!long && long.cut && long.title.includes(LONG_TITLE), JSON.stringify(long));
  ok(`${label}: chips stay low (40-48 px)`, facts.every((f) => f.h >= 40 && f.h <= 48), facts.map((f) => f.h).join(','));
  const rowBox = await row.boundingBox();
  ok(`${label}: no chip wider than its row`, facts.every((f) => f.w <= Math.ceil(rowBox.width)), `${facts.map((f) => f.w).join(',')} / ${Math.round(rowBox.width)}`);
}

async function run(base, pw) {
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, base);
  const p = await context.newPage();
  const watch = watchPage(p, 'desk');
  await p.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await applyTheme(p, 'light');
  await p.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(100); }
  ok('main Super stage opens', await toMainStage(p));
  const s = stage(p, 'main');

  console.log('── 1 the chips read their title');
  await sayOnStage(p, 'main', 'Yapay zekâ planı göster');
  ok('1 the answer lands', await until(p, async () => (await s.locator('.chat-msg-assistant-row', { hasText: 'uzun inceleme' }).count()) === 1, 30000));
  const row = s.locator('[data-testid="super-turn-cards"]').first();
  ok('1 three chips under it', await until(p, async () => (await row.locator('[data-testid="super-turn-card"]').count()) === 3, 10000));
  await p.waitForTimeout(1500);
  await checkChips(p, '1 (1440)');
  await both(p, '1-cipler-1440');

  console.log('── 2 a page full screen, then the Super presents a new picture');
  const st1 = await superState(p);
  const web = st1.containers.find((k) => k.kind === 'web' && k.ref.endsWith('plan.html'));
  // He asks for it, then opens the page (side by side) full screen while the Super works.
  await sayOnStage(p, 'main', 'Birazdan yeni resmi göster');
  const webCard = s.locator('[data-testid="super-card-fullscreen"]').first();
  await webCard.click({ force: true }).catch(() => {});
  ok('2 the owner has a page full screen', await until(p, async () => {
    if ((await p.locator('.frame-viewer-stage').count()) > 0) return true;
    await webCard.click({ force: true }).catch(() => {});
    return (await p.locator('.frame-viewer-stage').count()) > 0;
  }, 5500));
  await shot(p, '2a-tam-ekran-acik-1440-light.png');
  const presentedNow = await until(p, async () => {
    const st = await superState(p);
    return st.view?.mode === 'present' && st.view.cards.some((id) => st.containers.find((k) => k.id === id)?.ref === 'shots/three.png');
  }, 30000);
  ok('2 the record presents the new picture', presentedNow, JSON.stringify((await superState(p)).view));
  ok('2 the full screen closed: the presentation is in front', await until(p, async () => (await p.locator('.frame-viewer-stage').count()) === 0, 8000));
  const st2 = await superState(p);
  const pic = st2.containers.find((k) => k.ref === 'shots/three.png');
  ok('2 the picture card is drawn on the stage', await until(p, async () => (await s.locator(`[data-card-id="${pic?.id}"], [data-container-id="${pic?.id}"], [data-id="${pic?.id}"]`).count()) > 0
    || (await s.locator('img[src*="three.png"]').count()) > 0, 8000));
  await p.waitForTimeout(1200);
  // The chat is the presentation's narrow column now: every chip stays inside its answer.
  const spill = await s.locator('[data-testid="super-turn-cards"]').first().evaluate((el) => {
    const host = el.closest('.chat-msg-assistant-row').getBoundingClientRect();
    return [...el.querySelectorAll('[data-testid="super-turn-chip"]')].map((c) => Math.round(c.getBoundingClientRect().right - host.right));
  });
  ok('2 in the narrow chat column no chip runs past its answer', spill.every((d) => d <= 1), spill.join(','));
  await both(p, '2b-yeni-sunum-onde-1440');

  console.log('── 2c the Others panel open, then the Super presents');
  await p.keyboard.press('Escape').catch(() => {});
  // He asks, then opens Others while the Super works (a click outside the panel would close it).
  await sayOnStage(p, 'main', 'Birazdan planı tekrar göster');
  await p.locator('[data-testid="super-others"]:visible, [data-testid="super-others-open"]:visible').first().click({ force: true }).catch(() => {});
  ok('2c the owner opened the Others panel', await until(p, async () => (await p.locator('.super-group-panel:visible').count()) > 0, 5000));
  const before = await superState(p);
  ok('2c ... before the Super presented (the step is valid)', !(before.view?.mode === 'present' && before.view.cards.includes(web.id)), JSON.stringify(before.view));
  await shot(p, '2c-panel-acik-1440-light.png');
  ok('2c the Super presented the plan', await until(p, async () => { const st = await superState(p); return st.view?.mode === 'present' && st.view.cards.includes(web.id); }, 30000));
  ok('2c the Others panel closed: the presentation is in front', await until(p, async () => (await p.locator('.super-group-panel:visible').count()) === 0, 8000));
  await p.waitForTimeout(1000);
  await shot(p, '2c-panel-kapandi-1440-light.png');

  console.log('── 3 his own view: kept inside the hold, a question presents over it past the hold');
  await p.keyboard.press('Escape').catch(() => {});
  await row.locator(`[data-card="${web.id}"] [data-testid="super-turn-chip"]`).click();
  ok('3 his side by side, marked his', await until(p, async () => { const st = await superState(p); return st.view?.mode === 'half' && st.view.card === web.id && st.view.by === 'owner' && typeof st.view.ownerAt === 'number'; }, 8000));
  await sayOnStage(p, 'main', 'Hemen soruyu sor');
  ok('3a the ask lands', await until(p, async () => { try { return readFileSync(ASKS, 'utf-8').trim().split('\n').length >= 1; } catch { return false; } }, 30000));
  const a1 = JSON.parse(readFileSync(ASKS, 'utf-8').trim().split('\n')[0]);
  ok('3a inside the hold: skipped, with a plain NOT-on-screen note', a1?.show?.state === 'skipped' && /NOT on his screen/.test(a1?.show?.note ?? ''), JSON.stringify(a1?.show));
  await row.locator(`[data-card="${web.id}"] [data-testid="super-turn-chip"]`).click();
  await until(p, async () => { const st = await superState(p); return st.view?.mode === 'half' && st.view.by === 'owner'; }, 8000);
  await p.waitForTimeout(4000); // past the 3 s hold
  await sayOnStage(p, 'main', 'Şimdi soruyu sor');
  ok('3b the second ask lands', await until(p, async () => { try { return readFileSync(ASKS, 'utf-8').trim().split('\n').length >= 2; } catch { return false; } }, 30000));
  const a2 = JSON.parse(readFileSync(ASKS, 'utf-8').trim().split('\n')[1]);
  ok('3b past the hold: presented over his old view', a2?.show?.state === 'presented', JSON.stringify(a2?.show));
  ok('3b the record presents the question\'s picture', await until(p, async () => { const st = await superState(p); return st.view?.mode === 'present' && st.view.ask === a2.item; }, 8000));
  await p.waitForTimeout(1200);
  await both(p, '3-soru-resmi-onde-1440');
  ok('no console errors (desktop)', watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
  ok('no failed requests (desktop)', watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));

  console.log('── 4 the phone (390): the chips');
  const api = async (method, path) => (await fetch(`${base}${path}`, { method, headers: { 'X-Dreamcontext-Vault': VAULT } })).json().catch(() => ({}));
  await api('POST', '/api/handsfree/mac/setup');
  const startRes = await fetch(`${base}/api/handsfree/mac/start`, { method: 'POST', headers: { 'X-Dreamcontext-Vault': VAULT, 'Content-Type': 'application/json' }, body: JSON.stringify({ vaults: [VAULT] }) });
  ok('4 Mac mode starts', startRes.status === 200, String(startRes.status));
  const qr = (await api('POST', '/api/handsfree/mac/qr')).url;
  const phoneCtx = await browser.newContext({ ...pw.devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  await markAnnouncementsSeen(phoneCtx, base);
  const phone = await phoneCtx.newPage();
  const pwatch = watchPage(phone, 'phone');
  await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await until(phone, async () => phone.url().includes(`vault=${VAULT}`), 25000);
  for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone.waitForTimeout(300); }
  await applyTheme(phone, 'light');
  await openSuper(phone, VAULT).catch(() => {});
  ok('4 the Super chat opens on the phone', await until(phone, () => chatShown(phone), 15000));
  const prow = phone.locator('[data-testid="super-turn-cards"]:visible').first();
  // The phone has no groups: the two pictures are two chips there.
  ok('4 the chips show on the phone', await until(phone, async () => (await prow.locator('[data-testid="super-turn-card"]').count()) >= 3, 20000));
  await prow.scrollIntoViewIfNeeded().catch(() => {});
  await phone.waitForTimeout(1500);
  const pf = await chipFacts(prow);
  console.log('   chips 390', JSON.stringify(pf));
  const pbox = await prow.boundingBox();
  ok('4 (390): a normal title reads whole', pf.filter((f) => !f.text.includes('Checkout funnel')).every((f) => !f.cut), JSON.stringify(pf));
  ok('4 (390): the long one ellipsizes inside the row', pf.some((f) => f.text.includes('Checkout funnel') && f.cut && f.w <= Math.ceil(pbox.width)), JSON.stringify(pf));
  await both(phone, '4-cipler-390');
  ok('no console errors (phone)', pwatch.errors.length === 0, pwatch.errors.slice(0, 6).join('\n'));
  ok('no failed requests (phone)', pwatch.failed.length === 0, pwatch.failed.slice(0, 8).join('\n'));
  await browser.close();
}

async function main() {
  let srv = null;
  try {
    setup();
    const pw = await import('playwright');
    await pictures(pw);
    const port = await freePort();
    srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log'),
      extraEnv: { DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(SCRATCH, 'power.log'), DREAMCONTEXT_SUPER_OWNER_HOLD_MS: '3000' } });
    await run(`http://127.0.0.1:${port}`, pw);
  } catch (e) { console.log('CRASH', String(e?.stack ?? e).slice(0, 600)); ok('ran to the end', false, e?.stack ?? e); }
  finally {
    srv?.kill();
    // The server may still be writing as it stops: retry instead of failing the run on cleanup.
    try { rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* left in tmp */ }
  }
  const taken = swapShots();
  console.log(taken ? `\nscreenshots (${taken}): ${FINAL}` : `\nno screenshots taken; ${FINAL} left as it was`);
  process.exit(summary() ? 0 : 1);
}

main();
