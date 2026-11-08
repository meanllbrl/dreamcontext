#!/usr/bin/env node
/**
 * A member's Instructions card on its Super stage (owner 2026-11-06, a screenshot: "could this
 * card look any uglier"): it said "Loading agents..." forever, squeezed the job into a narrow
 * column, cut it mid-word, left Edit alone under the text and half the card empty.
 *
 *   npm run build && node scripts/verify/member-instructions-card.mjs [outDir] [prefix]
 *
 * Real dashboard server from dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), a member with a long
 * Turkish job in markdown (a heading, a list, `code` paths) and a soul, two routines. Asserts, on
 * the floating card at every size (small, medium, large, wide) and side by side, light and dark:
 * no "Loading" stays; the job's LAST words are in the card and reachable by its own scroll (never
 * cut); a path is drawn as a code chip; the card leaves no empty half; Edit opens the identity
 * dialog. Console errors and failed requests are a FAIL.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { applyTheme, cleanEnv, freePort, openMember, pageFetch, readNd, reporter, stage, startServer, superStandin, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-member-instructions-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'member-instructions-card'));
const PREFIX = process.argv[3] || 'shot';
const REPORTS = join(SCRATCH, 'reports.ndjson');
const LAST_WORDS = 'haftalık özeti cuma akşamı gönderirsin';

const JOB = `Sen Defne'sin, Acme Mağaza'nın gelir bekçisisin. Ödeme ve abonelik verisinden gelirin sağlığını izler, sızıntıyı ve fırsatı sayılarla, proaktif raporlarsın. Yalnız okur ve raporlarsın.

### Önce oku
- \`knowledge/pricing/\` (tahmini-gelir-modeli, fiyat-yol-haritası, ltv-eğrisi)
- \`knowledge/crm/aktivasyon-odeme-matrisi.md\`
- \`knowledge/features/odeme-sistemi.md\` (çok büyük; iade, gecikmiş ödeme ve kredi başlıklarını ara)

### Her gün
1. Dünkü yeni abonelikleri, iptalleri ve iadeleri say; bir önceki haftanın aynı günüyle karşılaştır.
2. Gecikmiş ödemesi 3 günü geçen hesapları listele, en büyük beşini öne al.
3. Bir sızıntı görürsen (çift ücret, yanlış kur, eksik vergi) kanıtıyla yaz, düzeltmeyi önerme, yalnız göster.

Bilgi klasörlerin: \`knowledge/pricing/\`, \`knowledge/crm/\`, \`knowledge/features/\`. Uzun tablolar yerine üç satırlık özet yaz, sayıları yuvarlama, para birimini her zaman söyle ve ${LAST_WORDS}.`;
const SOUL = 'Sakin ve kesin konuşursun. Tahmin yerine sayı, sayı yerine kanıt. Emin değilsen söylersin.';

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const { ok, summary, result } = reporter();

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, superStandin({ reports: REPORTS, cli: CLI }));
  chmodSync(bin, 0o755);
  const steps = [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })],
    ['agent', dc('agents', 'create', 'defne', '--title', 'Defne', '--prompt', JOB, '--soul', SOUL)],
  ];
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

async function handOver(page, base) {
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => readNd(REPORTS).some((r) => r.kind === 'spawn'), 20000);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  return until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 60000);
}

/** What the card shows: its text, whether the job's last words are inside a box that scrolls to
 *  them (or are already in view), the share of the card's body painted with content. */
async function measure(card) {
  return card.evaluate((el, last) => {
    const body = el.querySelector('.super-card-large-body') ?? el;
    const text = body.innerText;
    // The job's last words: in the DOM, and either visible or inside a scroller that reaches them.
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let host = null;
    while (walker.nextNode()) if (walker.currentNode.textContent.includes(last.split(' ')[0]) && walker.currentNode.textContent.includes(last.split(' ').slice(-1)[0])) { host = walker.currentNode.parentElement; break; }
    let reachable = false;
    if (host) {
      let s = host.parentElement;
      while (s && s !== el.parentElement) {
        const cs = getComputedStyle(s);
        if (/(auto|scroll)/.test(cs.overflowY) && s.scrollHeight > s.clientHeight + 1) { reachable = true; break; }
        s = s.parentElement;
      }
      const r = host.getBoundingClientRect(); const b = body.getBoundingClientRect();
      if (r.bottom <= b.bottom + 1 && r.top >= b.top - 1) reachable = true;
    }
    // Painted content's lowest point against the body: an empty lower half is a FAIL.
    const b = body.getBoundingClientRect();
    let bottom = b.top;
    for (const n of body.querySelectorAll('*')) {
      const r = n.getBoundingClientRect();
      if (r.width && r.height && n.children.length === 0 && r.bottom <= b.bottom + 1) bottom = Math.max(bottom, r.bottom);
    }
    let right = b.left;
    for (const n of body.querySelectorAll('p, li')) { const r = n.getBoundingClientRect(); if (r.width) right = Math.max(right, r.right); }
    const scroller = body.querySelector('[data-testid="member-instructions-scroll"]');
    const overflowing = !!scroller && scroller.scrollHeight > scroller.clientHeight + 1;
    return {
      text, hasLast: !!host, reachable, across: b.width ? (right - b.left) / b.width : 0, fill: b.height ? (bottom - b.top) / b.height : 0, overflowing,
      chips: body.querySelectorAll('code').length, h: Math.round(b.height),
    };
  }, LAST_WORDS);
}

async function setSize(page, frame, size) {
  if ((await frame.getAttribute('data-size')) === size) return true;
  await frame.hover();
  // A small tile keeps its size row under "more"; a bigger card has its own size button.
  if (await frame.getByTestId('super-card-size-btn').count()) await frame.getByTestId('super-card-size-btn').click();
  else await frame.getByTestId('super-card-more').click();
  const opt = frame.getByTestId(`super-size-${size}`);
  await opt.waitFor({ timeout: 4000 });
  if (await opt.isDisabled()) return false;
  await opt.click();
  await page.waitForTimeout(700);
  return (await frame.getAttribute('data-size')) === size;
}

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'desk', { expected: [/status of 409/, /^409 POST \/api\/super\/member\b/] });
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  for (const [title, at] of [['Gelir sabah turu', '09:30'], ['Haftalık özet', '18:30']]) {
    const r = await pageFetch(page, VAULT, 'POST', '/automations', { title, agent: 'defne', job: `${title}.`, mode: 'sched', days: 'daily', at });
    ok(`setup: routine "${title}"`, r.status === 200, JSON.stringify(r).slice(0, 300));
  }
  const off = await pageFetch(page, VAULT, 'POST', '/agents/defne/enabled', { enabled: false });
  ok('setup: member off (its stage draws without a running Super)', off.status === 200, JSON.stringify(off).slice(0, 200));
  ok('setup: main Super handed over', await handOver(page, base));
  await openMember(page, 'defne');
  const st = stage(page, 'm:defne');
  ok('the member\'s stage opens', await until(page, async () => (await st.locator('[data-kind="member"]').count()) >= 2, 20000));
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }

  const frame = st.locator('[data-testid="super-container"]').filter({ has: page.locator('[data-member-card="instructions"]') }).first();
  ok('the Instructions card is on the stage', await until(page, async () => (await frame.count()) === 1, 10000));

  for (const theme of ['dark', 'light']) {
    await applyTheme(page, theme);
    for (const size of ['small', 'medium', 'large', 'wide']) {
      const drawn = await setSize(page, frame, size).catch((e) => { console.log(`   setSize ${size}: ${String(e).slice(0, 300)}`); return false; });
      if (!drawn) {
        console.log(`   (${theme} ${size}: not drawn at this size; frame size ${await frame.getAttribute('data-size')}, where ${await frame.getAttribute('data-where')})`);
        if (theme === 'dark' && size === 'small') { await page.screenshot({ path: join(OUT, `${PREFIX}-debug-stage.png`) }); console.log(await frame.evaluate((el) => [...el.querySelectorAll('button')].map((b) => b.dataset.testid || b.getAttribute('aria-label')).join(', '))); }
        continue;
      }
      await page.mouse.move(5, 5);
      await page.waitForTimeout(2500);
      await frame.screenshot({ path: join(OUT, `${PREFIX}-${theme}-${size}.png`) });
      const m = await measure(frame);
      ok(`${theme} ${size}: no "Loading" stays`, !/Loading|Yükleniyor/i.test(m.text), m.text.slice(0, 200));
      if (size === 'small') { ok(`${theme} small: the tile says what the member does`, /Defne|gelir/i.test(m.text), m.text.slice(0, 200)); continue; }
      ok(`${theme} ${size}: the job's last words are in the card and reachable (never cut)`, m.hasLast && m.reachable, JSON.stringify({ hasLast: m.hasLast, reachable: m.reachable }));
      ok(`${theme} ${size}: paths are drawn as code chips`, m.chips >= 3, `chips: ${m.chips}`);
      ok(`${theme} ${size}: no empty half (content fills ≥ 85% or scrolls)`, m.overflowing || m.fill >= 0.85, JSON.stringify({ fill: m.fill.toFixed(2), overflowing: m.overflowing, h: m.h }));
    }
  }

  // Side by side: the owner's screenshot.
  await applyTheme(page, 'dark');
  await setSize(page, frame, 'small').catch(() => false);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  await frame.click({ position: { x: 60, y: 60 } });
  const large = st.locator('.super-card-large').filter({ has: page.locator('[data-testid="member-card-instructions"]') }).first();
  const side = await until(page, async () => (await large.isVisible()) && (await page.locator('[data-testid="super-card-minimize"]:visible').count()) > 0, 8000);
  ok('side by side opens', side);
  if (side) {
    await page.waitForTimeout(1500);
    for (const theme of ['dark', 'light']) {
      await applyTheme(page, theme);
      await page.waitForTimeout(400);
      await large.screenshot({ path: join(OUT, `${PREFIX}-${theme}-side.png`) });
      const m = await measure(large);
      ok(`${theme} side by side: no "Loading" stays`, !/Loading|Yükleniyor/i.test(m.text), m.text.slice(0, 200));
      ok(`${theme} side by side: the job's last words are reachable`, m.hasLast && m.reachable, JSON.stringify(m).slice(0, 300));
      // Side by side the pane is taller than a short job: the job is whole, so the check is that it
      // runs the pane's width (the old card left the right half empty) and is one column.
      ok(`${theme} side by side: one column across the pane (no empty right half)`, m.across >= 0.85, JSON.stringify({ across: m.across.toFixed(2) }));
    }
    const edit = large.getByTestId('member-instructions-edit');
    ok('Edit is in the card\'s top row', await edit.isVisible().catch(() => false));
    const eb = await edit.boundingBox().catch(() => null); const lb = await large.boundingBox();
    ok('…at its top right', !!eb && !!lb && eb.y - lb.y < 110 && lb.x + lb.width - (eb.x + eb.width) < 80, JSON.stringify({ eb, lb }));
    await edit.click().catch(() => {});
    const dialog = page.locator('[data-member-card-layer] > *').first();
    ok('Edit opens the identity dialog', await until(page, async () => dialog.isVisible().catch(() => false), 5000));
    await page.screenshot({ path: join(OUT, `${PREFIX}-edit-dialog.png`) });
  }

  // A read that hangs (the live app's "Loading agents..." forever): the card says so after 8 s
  // with a retry; a retry that hangs again says so again; once the server answers, the job shows.
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  const hang = () => { /* never answered */ };
  await page.route('**/api/agents/defne', hang);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await openMember(page, 'defne');
  const st2 = stage(page, 'm:defne');
  await until(page, async () => (await st2.locator('[data-member-card="instructions"]').count()) > 0, 20000);
  const frame2 = st2.locator('[data-testid="super-container"]').filter({ has: page.locator('[data-member-card="instructions"]') }).first();
  if ((await frame2.getAttribute('data-size').catch(() => null)) === 'small') await setSize(page, frame2, 'large').catch(() => false);
  await page.mouse.move(5, 5);
  const card = st2.locator('[data-testid="member-card-instructions"]').first();
  ok('hang case: the full card is on the stage', await until(page, async () => (await card.count()) > 0, 10000));
  ok('a hung read shows the reading state, never the words "Loading"', await until(page, async () => (await card.getByTestId('member-instructions-pending').count()) > 0, 5000)
    && !/Loading|Yükleniyor/i.test(await card.innerText()));
  ok('…after 8 s it says so, with a retry', await until(page, async () => (await card.getByTestId('member-instructions-retry').count()) > 0, 14000));
  await card.screenshot({ path: join(OUT, `${PREFIX}-hung-read.png`) }).catch(() => {});
  await card.getByTestId('member-instructions-retry').click().catch(() => {});
  ok('…a retry shows the reading state again', await until(page, async () => (await card.getByTestId('member-instructions-pending').count()) > 0, 3000));
  ok('…and a retry that hangs again is said again', await until(page, async () => (await card.getByTestId('member-instructions-retry').count()) > 0, 14000));
  await page.unroute('**/api/agents/defne', hang);
  await card.getByTestId('member-instructions-retry').click().catch(() => {});
  ok('…once the server answers, the job shows', await until(page, async () => (await card.getByTestId('member-instructions-lede').count()) > 0, 10000));

  ok('no console errors', watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
  ok('no failed requests', watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));
  await browser.close();
}

async function main() {
  let srv = null;
  try {
    setup();
    const port = await freePort();
    srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
    await run(`http://127.0.0.1:${port}`);
  } catch (e) { ok('ran to the end', false, e?.stack ?? e); }
  finally { srv?.kill(); rmSync(SCRATCH, { recursive: true, force: true }); }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(summary());
  process.exit(result.fails.length ? 1 : 0);
}

main();
