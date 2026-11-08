#!/usr/bin/env node
/**
 * The cards a Super turn put on the stage stay under its answer as tiles (owner 2026-11-08):
 *   1 a turn that opens a page and two pictures: two tiles under its answer (the page, the group);
 *   2 both go to Others: the tiles stay;
 *   3 a click on the page tile brings it back side by side, a click on the group presents it;
 *   4 a reload: the tiles are still there;
 *   5 the page closed for good: a quiet "closed" line, no button;
 *   6 the phone (390): the tiles, and a click opens the picture full screen.
 * Screenshots at 1440 and 390, light and dark.
 *
 *   npm run build && node scripts/verify/super-sunum-izi.mjs [outDir]
 *
 * Never empty outDir before a run: this script swaps its own shots in once it has taken some.
 *
 * The real dashboard server from dist (scratch HOME) and a stand-in `claude` that plays main Super
 * and runs the REAL `dreamcontext super open|stack|close` (so the stage record is real), streaming
 * each as a Bash tool call and recording it in its transcript as Claude Code does. No tokens.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { chatShown, openSuper } from './lib/phone-shell.mjs';
import { applyTheme, cleanEnv, freePort, pageFetch, reporter, sayOnStage, stage, startServer, superStandin, toMainStage, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-sunum-izi-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const FINAL = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'super-sunum-izi'));
// Shots are taken into a staging folder beside FINAL and swapped in only once this run has
// captured some: a run that is refused, crashes before its first shot or never starts leaves
// the evidence already in FINAL untouched (a pre-run `rm` once emptied it for nothing).
const OUT = `${FINAL}.staging-${process.pid}`;

/** Replace FINAL's screenshots with this run's, if it took any; the staging folder always goes. */
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
  globalThis.ids = globalThis.ids || {};
  const ids = globalThis.ids;
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
  // A server turn (an owed reminder, an event) is answered plainly: it carries earlier words.
  if (text.trimStart().startsWith('[super ')) return 'Tamam.';
  // His newest words only (the line before the last \`<owner-msg/>\` tag, which the server appends
  // after them): a turn may also carry notes about his earlier, still unanswered messages.
  const head = text.lastIndexOf('<owner-msg') >= 0 ? text.slice(0, text.lastIndexOf('<owner-msg')) : text;
  const said = head.trim().split('\\n').pop() || '';
  if (/planı göster/i.test(said)) {
    const page = await call(['super', 'open', 'web', 'reports/plan.html']);
    ids.web = page && page.container && page.container.id;
    const pics = await call(['super', 'open', 'image', 'shots/one.png', 'shots/two.png']);
    ids.group = pics && pics.group && pics.group.id;
    return 'Yapay zekâ yönlendirme planı hazır, rapor sahnede açık. İki ekran görüntüsünü de yanına koydum.';
  }
  if (/kaldır/i.test(said)) {
    await call(['super', 'stack', ids.web]);
    if (ids.group) await call(['super', 'stack', ids.group]);
    return 'Kartları Diğerleri’ne aldım.';
  }
  if (/raporu kapat/i.test(said)) {
    // A resumed stand-in has no memory: the page's id is read from the stage record.
    const st = cli('super', 'state').json;
    const page = st && Array.isArray(st.containers) ? st.containers.find((k) => k.kind === 'web') : null;
    await call(['super', 'close', page ? page.id : 'web-missing']);
    return 'Raporu kapattım.';
  }
  return 'Tamam.';
`;

const REPORT = `<!doctype html><html><head><meta charset="utf-8"><title>Routing plan</title>
<style>body{font-family:system-ui;margin:0;background:#f7f5ff;color:#1d1640}header{background:#6d4cff;color:#fff;padding:40px 56px}
h1{margin:0;font-size:44px}main{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;padding:40px 56px}
.c{background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 8px #0001}.n{font-size:40px;font-weight:700;color:#6d4cff}</style></head>
<body><header><h1>AI routing plan</h1><p>Claude first, OpenRouter as fallback</p></header>
<main><div class="c"><div class="n">$7-9</div>per month</div><div class="c"><div class="n">400 $</div>credit lasts years</div><div class="c"><div class="n">2</div>providers</div></main></body></html>`;

async function pictures(pw) {
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  for (const [name, bg, label] of [['one', '#ffb347', 'Checkout before'], ['two', '#4cc9a0', 'Checkout after']]) {
    await page.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:${bg};font:700 56px system-ui;color:#1d1640">${label}</body>`);
    await page.screenshot({ path: join(PROJ, 'shots', `${name}.png`) });
  }
  await browser.close();
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'reports'), join(PROJ, 'shots'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(PROJ, 'reports', 'plan.html'), REPORT);
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

const superState = async (page) => (await pageFetch(page, VAULT, 'GET', '/super/state')).json;
const shot = async (page, name) => { await page.mouse.move(5, 5); await page.waitForTimeout(500); await page.screenshot({ path: join(OUT, name) }); };
const both = async (page, name) => {
  for (const theme of ['dark', 'light']) { await applyTheme(page, theme); await shot(page, `${name}-${theme}.png`); }
};

async function run(base, pw) {
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'desk');
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await applyTheme(page, 'dark');
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  ok('main Super stage opens', await toMainStage(page));
  const s = stage(page, 'main');
  const row = s.locator('[data-testid="super-turn-cards"]').first();
  const tiles = row.locator('[data-testid="super-turn-card"]');

  console.log('── 1 a turn opens a page and two pictures');
  await sayOnStage(page, 'main', 'Yapay zekâ planı göster');
  ok('1 the answer lands', await until(page, async () => (await s.locator('.chat-msg-assistant-row', { hasText: 'rapor sahnede açık' }).count()) === 1, 30000));
  ok('1 two tiles under it: the page and the picture group', await until(page, async () => (await tiles.count()) === 2, 10000), String(await tiles.count()));
  const st1 = await superState(page);
  const web = st1.containers.find((k) => k.kind === 'web');
  const grp = st1.groups[0];
  ok('1 the stage record holds the page and a group of two', !!web && grp?.cards.length === 2);
  ok('1 the page tile draws the page itself', (await row.locator(`[data-card="${web?.id}"] .super-tile-page iframe, [data-card="${web?.id}"] .super-tile-page .doc-reader`).count()) > 0);
  ok('1 the group tile draws its first picture', (await row.locator(`[data-card="${grp?.id}"] .super-tile-picture img`).count()) > 0);
  await page.waitForTimeout(1500);
  await both(page, '1-cevap-kutucuklar-1440');

  console.log('── 2 both go to Others');
  await sayOnStage(page, 'main', 'Kartları kaldır');
  ok('2 the answer lands', await until(page, async () => (await s.locator('.chat-msg-assistant-row', { hasText: 'Diğerleri' }).count()) === 1, 30000));
  const st2 = await superState(page);
  ok('2 both are in Others', st2.containers.find((k) => k.id === web.id)?.place === 'others' && st2.groups.find((g) => g.id === grp.id)?.place === 'others',
    JSON.stringify({ web: st2.containers.find((k) => k.id === web.id)?.place, grp: st2.groups.find((g) => g.id === grp.id)?.place }));
  ok('2 the first answer still has its two tiles', (await tiles.count()) === 2);
  await both(page, '2-digerlerinde-1440');

  console.log('── 3 a click brings them back');
  await row.locator(`[data-card="${web.id}"]`).click();
  ok('3 the page is back, side by side', await until(page, async () => {
    const st = await superState(page);
    return st.view?.mode === 'half' && st.view.card === web.id && st.containers.find((k) => k.id === web.id)?.place === 'float';
  }, 8000));
  await page.waitForTimeout(1200);
  await both(page, '3-tikla-sayfa-geri-1440');
  await row.locator(`[data-card="${grp.id}"]`).click();
  ok('3 the group is presented, out of Others', await until(page, async () => {
    const st = await superState(page);
    return st.view?.mode === 'present' && grp.cards.every((id) => st.view.cards.includes(id)) && st.groups.find((g) => g.id === grp.id)?.place === 'float';
  }, 8000));
  await page.waitForTimeout(1200);
  await both(page, '3-tikla-grup-sunuldu-1440');
  await page.keyboard.press('Escape');

  console.log('── 4 a reload');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  await toMainStage(page);
  await page.waitForTimeout(3000);
  await shot(page, '4-yenilendi-1440-light.png');
  console.log('   probe', JSON.stringify(await stage(page, 'main').evaluate((el) => ({
    answers: el.querySelectorAll('.chat-msg-assistant-row').length,
    text: (el.querySelector('.chat-transcript') || el).innerText.slice(0, 600),
  }))));
  ok('4 the tiles are still under the answer', await until(page, async () => (await stage(page, 'main').locator('[data-testid="super-turn-card"]').count()) === 2, 20000));

  console.log('── 5 the page closed for good');
  await sayOnStage(page, 'main', 'Raporu kapat');
  ok('5 the answer lands', await until(page, async () => (await stage(page, 'main').locator('.chat-msg-assistant-row', { hasText: 'Raporu kapattım' }).count()) === 1, 30000));
  const first = stage(page, 'main').locator('[data-testid="super-turn-cards"]').first();
  ok('5 its tile is a quiet closed line, not a button', await until(page, async () => (await first.locator('[data-testid="super-turn-card-closed"]').count()) === 1
    && (await first.locator('button[data-testid="super-turn-card"]').count()) === 1, 8000));
  await both(page, '5-kapatildi-1440');
  ok('no console errors (desktop)', watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
  ok('no failed requests (desktop)', watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));

  console.log('── 6 the phone (Mac mode over the loopback stand-in tunnel, the real phone surface)');
  const api = async (method, path) => (await fetch(`${base}${path}`, { method, headers: { 'X-Dreamcontext-Vault': VAULT } })).json().catch(() => ({}));
  await api('POST', '/api/handsfree/mac/setup');
  const startRes = await fetch(`${base}/api/handsfree/mac/start`, { method: 'POST', headers: { 'X-Dreamcontext-Vault': VAULT, 'Content-Type': 'application/json' }, body: JSON.stringify({ vaults: [VAULT] }) });
  ok('6 Mac mode starts', startRes.status === 200, String(startRes.status));
  const qr = (await api('POST', '/api/handsfree/mac/qr')).url;
  ok('6 a one-time sign-in link', typeof qr === 'string', String(qr));
  const phoneCtx = await browser.newContext({ ...pw.devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  await markAnnouncementsSeen(phoneCtx, base);
  const phone = await phoneCtx.newPage();
  const pwatch = watchPage(phone, 'phone');
  await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await until(phone, async () => phone.url().includes(`vault=${VAULT}`), 25000);
  for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone.waitForTimeout(300); }
  await applyTheme(phone, 'dark');
  await openSuper(phone, VAULT).catch(() => {});
  ok('6 the Super chat opens on the phone', await until(phone, () => chatShown(phone), 15000));
  const ptiles = phone.locator('[data-testid="super-turn-cards"]:visible').first();
  ok('6 the tiles show on the phone', await until(phone, async () => (await ptiles.locator('[data-testid="super-turn-card"]').count()) >= 1, 20000));
  await ptiles.scrollIntoViewIfNeeded().catch(() => {});
  await phone.waitForTimeout(1500);
  await both(phone, '6-telefon-390');
  const pic = ptiles.locator('button[data-testid="super-turn-card"]').filter({ has: phone.locator('[data-tile="image"]') }).first();
  await pic.click();
  ok('6 a click opens the picture full screen', await until(phone, async () => (await phone.locator('.image-viewer').count()) > 0, 8000));
  await phone.waitForTimeout(600);
  await phone.screenshot({ path: join(OUT, '6-telefon-tam-ekran-390-light.png') });
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
      extraEnv: { DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(SCRATCH, 'power.log') } });
    await run(`http://127.0.0.1:${port}`, pw);
  } catch (e) { ok('ran to the end', false, e?.stack ?? e); }
  finally { srv?.kill(); rmSync(SCRATCH, { recursive: true, force: true }); }
  const taken = swapShots();
  console.log(taken ? `\nscreenshots (${taken}): ${FINAL}` : `\nno screenshots taken; ${FINAL} left as it was`);
  process.exit(summary() ? 0 : 1);
}

main();
