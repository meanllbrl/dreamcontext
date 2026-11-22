#!/usr/bin/env node
/**
 * A member's Scorecard on its stage (task "AI Team üye karnesi", criteria 15-16).
 *
 *   npm run build && node scripts/verify/member-scorecard.mjs [outDir]
 *
 * Real dashboard server from dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), main Super handed over, a
 * member (off, so its stage draws without a live Super) with one routine run three times. The
 * stand-in `claude` answers the routine's runs and the lesson drafter (it echoes his note back as
 * the lesson, so a byte change anywhere on the way shows). Light theme. Asserts:
 *   (a) EMPTY, right after the build: the tile says "No ratings yet" with the latest run and five
 *       outline stars; the full card has no "0.0" and no filled bars; its first run row asks for a rating;
 *   (b) rating the lead run 4 stars from the full card and adding the Turkish note stores both, the
 *       lesson lands under "Learned from your ratings" with Undo; the tile shows the average and bars;
 *   (c) the note "Çok fazla bütçe, test edilmemiş kitleye" is byte-identical on disk, in the lesson
 *       and in the next run's prompt;
 *   (d) the phone at 390 (Mac mode sign-in): the member's Scorecard sheet rates a run and undoes a
 *       lesson; the criteria add row, the goal button and "Use it" are absent.
 * Console errors and failed requests are a FAIL. Screenshots: <outDir>/<nn>-<what>.png.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { drawerShown, openDrawer } from './lib/phone-shell.mjs';
import { applyTheme, cleanEnv, freePort, openMember, pageFetch, readNd, reporter, stage, startServer, superStandin, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-member-scorecard-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'member-scorecard'));
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SLUG = 'desk-helper';
const RUN = 'front-desk-news';
const NOTE = 'Çok fazla bütçe, test edilmemiş kitleye';

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: "if (text.startsWith('[super handover]')) return 'arranged'; return 'ok';",
  member: "return 'Hello, I keep the desk.';",
  // The judge sends its prompt on stdin; a routine run sends it after -p.
  headless: `
    let p = prompt;
    if (!p || p.startsWith('--')) { try { p = readFileSync(0, 'utf-8'); } catch { p = ''; } }
    report({ kind: 'judge-or-run', prompt: p.slice(0, 20000) });
    if (p.includes('Turn the note into ONE instruction')) {
      const m = p.match(/--- HIS NOTE \\(verbatim\\) [0-9a-f]+ ---\\n([\\s\\S]*?)\\n--- END HIS NOTE/);
      return JSON.stringify({ lesson: m ? m[1] : null });
    }
    if (p.includes('You check one finished run')) return JSON.stringify({ verdicts: [] });
    return 'Desk is tidy: three parcels filed, one return logged.';
  `,
});

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: { ...env(), PATH: `${join(HOME, '.local', 'bin')}:/usr/bin:/bin:${dirname(process.execPath)}` }, encoding: 'utf-8', timeout: 120000 });
const { ok, summary, result } = reporter();
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });

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
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const steps = [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })],
    ['agent', dc('agents', 'create', SLUG, '--title', 'Desk Helper', '--prompt', 'Keeps the front desk tidy and reports twice a day.')],
    ['routine', dc('automations', 'create', RUN, '--title', 'Front desk news', '--agent', SLUG, '--job', 'Front desk news round.', '--days', 'daily', '--at', '03:00')],
    ['approve', dc('automations', 'approve', RUN, '-y')],
    ['run 1', dc('automations', 'run', RUN, '--force')],
    ['run 2', dc('automations', 'run', RUN, '--force')],
    ['run 3', dc('automations', 'run', RUN, '--force')],
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

const scorecard = async (page) => (await pageFetch(page, VAULT, 'GET', `/agents/${SLUG}/scorecard`)).json;

/** What a card shows: its text, filled bars, stars by shape, sideways overflow. */
const look = (loc) => loc.evaluate((el) => ({
  text: el.innerText,
  bars: [...el.querySelectorAll('.sc-bar')].filter((b) => b.getBoundingClientRect().height > 5).length,
  on: [...el.querySelectorAll('.sc-glyph')].filter((g) => g.textContent === '★').length,
  off: [...el.querySelectorAll('.sc-glyph')].filter((g) => g.textContent === '☆').length,
  overflow: el.scrollWidth > el.clientWidth + 1,
}));

async function desk(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const watch = watchPage(page, 'desk', { expected: [/status of 409/, /^409 POST \/api\/super\/member\b/] });
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const off = await pageFetch(page, VAULT, 'POST', `/agents/${SLUG}/enabled`, { enabled: false });
  ok('setup: member off (its stage draws without a running Super)', off.status === 200, JSON.stringify(off).slice(0, 200));
  ok('setup: main Super handed over', await handOver(page, base));
  await applyTheme(page, 'light');
  await openMember(page, SLUG);
  const st = stage(page, `m:${SLUG}`);
  ok('the member\'s stage opens', await until(page, async () => (await st.locator('[data-kind="member"]').count()) >= 2, 20000));
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }

  // (a) EMPTY
  const frame = st.locator('[data-testid="super-container"]').filter({ has: page.locator('[data-member-card="scorecard"]') }).first();
  const tile = st.locator('[data-testid="member-card-tile"][data-ref="scorecard"]').first();
  ok('(a) the Scorecard card is on the stage after the build', await until(page, async () => (await frame.count()) === 1 || (await tile.count()) === 1, 15000));
  await until(page, async () => (await tile.count()) === 1 && /No ratings yet/.test(await tile.innerText()), 10000);
  await page.mouse.move(5, 5); await page.waitForTimeout(800);
  await shot(page, '01-empty-stage-1440');
  const t0 = await look(tile).catch(() => ({ text: '' }));
  ok('(a) empty tile: "No ratings yet", the latest run, five outline stars, "Rate it"', /No ratings yet/.test(t0.text) && /Front desk news/.test(t0.text) && /Rate it/.test(t0.text) && t0.off === 5 && t0.on === 0, JSON.stringify(t0));
  ok('(a) empty tile: no "0.0", no bars', !/0\.0/.test(t0.text) && t0.bars === 0, JSON.stringify(t0));
  const rateIt = await tile.evaluate((el) => { const a = el.querySelector('.sc-tile-rate .sc-accent'); const r = a?.getBoundingClientRect(); const b = el.closest('[data-testid="super-container"]')?.getBoundingClientRect() ?? el.getBoundingClientRect(); return a ? { oneLine: a.getClientRects().length === 1, inside: r.right <= b.right + 0.5 } : null; });
  ok('(a) "Rate it" is whole and inside the card', !!rateIt && rateIt.oneLine && rateIt.inside, JSON.stringify(rateIt));

  // The full card: side by side.
  // A small card opens side by side when its head is clicked (not its stars).
  await frame.click({ position: { x: 60, y: 18 } }).catch(() => {});
  const full = st.locator('[data-testid="sc-full"]:visible').first();
  ok('(a) the full card opens', await until(page, async () => (await full.count()) === 1, 10000));
  await page.mouse.move(5, 5); await page.waitForTimeout(1000);
  await shot(page, '02-empty-full-1440');
  await full.screenshot({ path: join(OUT, '02b-empty-full-card-1440.png') }).catch(() => {});
  const f0 = await look(full);
  ok('(a) empty full card: no "0.0", no filled bars', !/\b0\.0\b/.test(f0.text) && f0.bars === 0, JSON.stringify({ bars: f0.bars, text: f0.text.slice(0, 300) }));
  const lead = full.locator('[data-testid="sc-run"].is-lead').first();
  ok('(a) the first Recent runs row asks for a rating', (await lead.count()) === 1 && /Rate this run/.test(await lead.innerText()), (await lead.innerText().catch(() => '')).slice(0, 200));
  ok('(a) "Learned from your ratings" shows its empty line', /Learned from your ratings/i.test(f0.text), f0.text.slice(0, 400));
  ok('(a) no sideways overflow', !f0.overflow);

  // (b) rate the lead run 4 and add the note from the card
  await lead.getByTestId('sc-star-4').click();
  ok('(b) 4 stars stored', await until(page, async () => Object.values((await scorecard(page))?.card?.ratings ?? {}).some((r) => r.stars === 4), 8000));
  const lead2 = full.locator('[data-testid="sc-run"][data-rated="true"]').first();
  ok('(b) the rated row offers "add a note" without a reload', await until(page, async () => (await lead2.getByTestId('sc-add-note').count()) === 1, 8000));
  await shot(page, '02c-rated-one-1440');
  await lead2.getByTestId('sc-add-note').click();
  await lead2.getByTestId('sc-note-input').fill(NOTE);
  await lead2.getByTestId('sc-note-save').click();
  ok('(b) the note is stored', await until(page, async () => Object.values((await scorecard(page))?.card?.ratings ?? {}).some((r) => r.note === NOTE), 8000));
  const lessonOk = await until(page, async () => ((await scorecard(page))?.card?.lessons ?? []).some((l) => l.status === 'active'), 45000);
  ok('(b) the note drafts exactly one active lesson', lessonOk && ((await scorecard(page)).card.lessons.filter((l) => l.status === 'active').length === 1), JSON.stringify((await scorecard(page))?.card?.lessons ?? []).slice(0, 500));
  // Two more ratings by the owner's page, so the trend has bars.
  const runs = (await scorecard(page)).runs.filter((r) => !r.rating);
  for (const [i, r] of runs.slice(0, 2).entries()) await pageFetch(page, VAULT, 'POST', `/agents/${SLUG}/scorecard/rate`, { run: r.key, stars: i ? 5 : 3 });
  ok('(b) the lesson shows under "Learned from your ratings" with Undo', await until(page, async () => (await full.locator('[data-testid="sc-learned"] [data-testid="sc-lesson-undo"]').count()) >= 1, 10000));
  await page.mouse.move(5, 5); await page.waitForTimeout(1200);
  await shot(page, '03-rated-full-1440');
  await full.screenshot({ path: join(OUT, '03b-rated-full-card-1440.png') }).catch(() => {});
  const f1 = await look(full);
  ok('(b) rated full card: the average and filled bars, stars by shape', /\d\.\d ★/.test(f1.text) && f1.bars >= 3 && f1.on >= 4, JSON.stringify({ bars: f1.bars, on: f1.on, off: f1.off }));
  ok('(b) the card shows his note', f1.text.includes(NOTE));
  // Back to the stage: the tile updates with no reload.
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  const minimize = page.locator('[data-testid="super-card-minimize"]:visible').first();
  if (await minimize.count()) await minimize.click().catch(() => {});
  await page.mouse.move(5, 5); await page.waitForTimeout(800);
  const t1 = await look(tile).catch(() => ({ text: '' }));
  await shot(page, '04-rated-stage-1440');
  const avgBox = await tile.evaluate((el) => { const a = el.querySelector('[data-testid="sc-tile-avg"]'); const c = el.closest('[data-testid="super-container"]')?.getBoundingClientRect() ?? el.getBoundingClientRect(); const bars = el.querySelector('.sc-bars')?.getBoundingClientRect(); return { oneLine: a.getClientRects().length === 1 && a.getBoundingClientRect().height < 40, barsInside: !!bars && bars.right <= c.right + 0.5 }; });
  ok('(b) the tile\'s average stays on one line and its bars inside the card', avgBox.oneLine && avgBox.barsInside, JSON.stringify(avgBox));
  ok('(b) the tile shows the average and bars without a reload', /4\.0 ★/.test(t1.text) && t1.bars >= 3, JSON.stringify(t1).slice(0, 300));

  // (c) the Turkish note byte for byte: disk, lesson, the next run's prompt.
  const local = join(HOME, '.dreamcontext', 'local');
  const files = readdirSync(local, { recursive: true }).filter((f) => String(f).endsWith('agent-scorecards.json'));
  const disk = files.map((f) => readFileSync(join(local, String(f)), 'utf-8')).join('\n');
  ok('(c) on disk, byte for byte', disk.includes(NOTE) && Buffer.from(disk).includes(Buffer.from(NOTE, 'utf-8')), files.join(','));
  const lesson = (await scorecard(page)).card.lessons.find((l) => l.status === 'active');
  ok('(c) in the lesson, byte for byte', lesson?.text === NOTE, JSON.stringify(lesson));
  const r4 = dc('automations', 'run', RUN, '--force');
  const runPrompts = readNd(REPORTS).filter((r) => r.kind === 'judge-or-run' && r.prompt.includes('Front desk news round'));
  ok('(c) in the next run\'s prompt, byte for byte', r4.status === 0 && runPrompts.at(-1)?.prompt.includes(NOTE), (runPrompts.at(-1)?.prompt ?? r4.stderr).slice(-800));

  ok('desk: no console errors', watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
  ok('desk: no failed requests', watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));
  return context;
}

/**
 * W3 (criterion 26): his chat row open and rated from Telegram (note, Learned, Undo), a run past its
 * window (no row; "Not rated" on the card), a Super's job rated from his words, the Super's judged
 * rating (violet stars, "Super's rating from your words", Change) and a correction row.
 */
async function w3(context, base) {
  const fx = spawnSync('npx', ['vite-node', join(REPO, 'scripts', 'verify', 'lib', 'scorecard-w3-fixtures.ts'), PROJ, SLUG, RUN], { cwd: REPO, env: { ...process.env, HOME }, encoding: 'utf-8', timeout: 180000 });
  ok('W3 setup: fixtures written', fx.status === 0, (fx.stderr || fx.stdout).slice(-800));
  if (fx.status !== 0) return;
  const keys = JSON.parse(fx.stdout.trim().split('\n').at(-1));
  const page = await context.newPage();
  const watch = watchPage(page, 'w3', { expected: [/status of 409/, /^409 POST \/api\/super\/member\b/] });
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await applyTheme(page, 'light');
  await openMember(page, SLUG);
  const st = stage(page, `m:${SLUG}`);
  await until(page, async () => (await st.locator('[data-kind="member"]').count()) >= 2, 20000);
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }

  // The member's chat: rows by run key.
  const row = (k) => page.locator(`[data-testid="run-stars"][data-run="${k}"]`);
  const anyRow = page.locator('[data-testid="run-stars"]');
  const seen = await until(page, async () => (await anyRow.count()) > 0, 15000);
  if (!seen) { await shot(page, '10-debug-w3-no-chat-rows'); console.log('   w3 page text:', (await page.locator('body').innerText()).slice(0, 800).replace(/\n/g, ' | ')); }
  ok('W3 (26) the member chat draws run rows', seen);
  const tgRow = row(keys.tg);
  await tgRow.scrollIntoViewIfNeeded().catch(() => {});
  await page.mouse.move(5, 5); await page.waitForTimeout(800);
  const tgText = (await tgRow.innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('W3 (26) chat row rated: four stars, "from Telegram", his note, Learned with Undo', /You rated 4 · from Telegram/.test(tgText) && tgText.includes(keys.note) && /Learned/.test(tgText) && /Undo/.test(tgText), tgText.slice(0, 300));
  await shot(page, '11-w3-chat-rated-telegram-1440');
  await tgRow.screenshot({ path: join(OUT, '11b-w3-chat-row-rated.png') }).catch(() => {});
  const openRow = page.locator('[data-testid="run-stars"][data-ask="open"]').first();
  ok('W3 (26) an open unrated run asks: "Rate this run" with grey stars', (await openRow.count()) === 1 && /Rate this run/.test(await openRow.innerText()), (await openRow.innerText().catch(() => '')).slice(0, 200));
  if (await openRow.count()) { await openRow.scrollIntoViewIfNeeded(); await page.mouse.move(5, 5); await page.waitForTimeout(500); await openRow.screenshot({ path: join(OUT, '12-w3-chat-row-open.png') }).catch(() => {}); }
  ok('W3 (26) the run past its window has no row in the chat', (await row(keys.old).count()) === 0);
  const jRow = row(keys.judged);
  const jText = (await jRow.innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('W3 (26) the judged run in the chat reads as the Super\'s, never "You rated"', /Super's rating 2, from your words/.test(jText) && !/You rated/.test(jText), jText.slice(0, 300));

  // The full card.
  const frame = st.locator('[data-testid="super-container"]').filter({ has: page.locator('[data-member-card="scorecard"]') }).first();
  await frame.click({ position: { x: 60, y: 18 } }).catch(() => {});
  const full = st.locator('[data-testid="sc-full"]:visible').first();
  ok('W3 (26) the full card opens', await until(page, async () => (await full.count()) === 1, 10000));
  await page.mouse.move(5, 5); await page.waitForTimeout(1200);
  await shot(page, '13-w3-full-1440');
  await full.screenshot({ path: join(OUT, '13b-w3-full-card-1440.png') }).catch(() => {});
  const ftext = (await full.innerText()).replace(/\s+/g, ' ');
  ok('W3 (26) card: the past-window run reads "Not rated"', (await full.getByTestId('sc-not-rated').count()) >= 1, ftext.slice(0, 300));
  ok('W3 (26) card: a "Super\'s job" row rated from his words', (await full.getByTestId('sc-run-super').count()) >= 1 && /From your words: «Üç, yeni kitleye fazla para ayırmış\.»/.test(ftext), ftext.slice(0, 500));
  const judgedStars = await full.locator('.sc-stars--judged').first().evaluate((el) => [...el.querySelectorAll('.sc-star')].map((b) => getComputedStyle(b).color)).catch(() => []);
  ok('W3 (26) card: judged stars in violet (on and off), "Super\'s rating from your words", Change', judgedStars.length === 5 && (await full.getByTestId('sc-judged').count()) >= 1 && /Super's rating from your words: «Hayır, bütçeyi bana sormadan artırmamalıydı\.»/.test(ftext) && (await full.getByTestId('sc-judged-change').count()) >= 1, JSON.stringify(judgedStars));
  ok('W3 (26) card: a correction row "Super noted from your words" keeping the Super\'s stars', /Super noted from your words: «kuryeyi de bana sormalıydı»/.test(ftext) && /Super's 2★ kept/.test(ftext), ftext.slice(0, 600));
  ok('W3 (26) card: no sideways overflow', !(await look(full)).overflow);
  const judgedRow = full.locator('[data-testid="sc-run"]').filter({ has: page.getByTestId('sc-judged') }).first();
  if (await judgedRow.count()) { await judgedRow.scrollIntoViewIfNeeded(); await page.mouse.move(5, 5); await page.waitForTimeout(400); await judgedRow.screenshot({ path: join(OUT, '14-w3-judged-row.png') }).catch(() => {}); }
  ok('W3: no console errors', watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
  ok('W3: no failed requests', watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));
  await page.close();
}

async function phone(browser, base, pw) {
  const head = { 'X-Dreamcontext-Vault': VAULT, 'Content-Type': 'application/json' };
  const setup = await fetch(`${base}/api/handsfree/mac/setup`, { method: 'POST', headers: head, body: '{}' });
  const start = await fetch(`${base}/api/handsfree/mac/start`, { method: 'POST', headers: head, body: JSON.stringify({ vaults: [VAULT] }) });
  const qr = (await (await fetch(`${base}/api/handsfree/mac/qr`, { method: 'POST', headers: { 'X-Dreamcontext-Vault': VAULT } })).json().catch(() => ({}))).url;
  ok('(d) Mac mode starts and gives a sign-in link', setup.ok && start.ok && typeof qr === 'string', `${setup.status} ${start.status} ${qr}`);
  if (typeof qr !== 'string') return;
  const pctx = await browser.newContext({ ...pw.devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  await markAnnouncementsSeen(pctx, base);
  const p = await pctx.newPage();
  const watch = watchPage(p, 'phone', { expected: [/status of 409/, /^409 GET \/api\/agent\/super-stage\b/] }); // the member is off on purpose: its stage answers 409
  await p.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  ok('(d) the phone signs in', await until(p, async () => p.url().includes(`vault=${VAULT}`), 25000), p.url());
  for (let i = 0; i < 3; i++) { const x = p.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await p.waitForTimeout(300); }
  await until(p, () => drawerShown(p), 20000);
  const prow = p.locator(`[data-testid="phone-team-row"][data-vault="${VAULT}"]`);
  await until(p, async () => (await prow.count()) === 1, 20000);
  await openDrawer(p); await prow.click();
  const sheet = p.locator('[data-testid="phone-team-sheet"]:visible');
  await until(p, async () => (await sheet.count()) === 1, 10000);
  await sheet.getByText('Desk Helper', { exact: false }).first().click();
  await p.waitForTimeout(1500);
  // An off member opens on the phone as its stage (no live Super to mirror): the app's own event.
  if (!(await p.locator('[data-testid="phone-member-stage"]:visible').count())) {
    // The phone's Super view first (the member's stage lives there), then the member.
    await p.getByRole('button', { name: 'Super Agent', exact: true }).first().click().catch(() => {});
    await p.waitForTimeout(1500);
    await openMember(p, SLUG);
  }
  const chip = p.locator('[data-testid="phone-member-chip"][data-ref="scorecard"]:visible').first();
  const hasChip = await until(p, async () => (await chip.count()) === 1, 20000);
  if (!hasChip) { await shot(p, '05-debug-phone'); console.log('   phone text:', (await p.locator('body').innerText()).slice(0, 600).replace(/\n/g, ' | ')); }
  ok('(d) the member\'s stage on the phone has a Scorecard chip', hasChip);
  if (!hasChip) { await pctx.close(); return; }
  await chip.click();
  const card = p.locator('[data-testid="phone-member-card-sheet"]:visible [data-testid="sc-full"]').first();
  ok('(d) the Scorecard opens in the phone sheet, one column', await until(p, async () => (await card.count()) === 1, 10000) && (await card.getAttribute('data-columns')) === '1');
  await p.waitForTimeout(1000);
  await shot(p, '05-phone-scorecard-390');
  const pl = await look(card);
  ok('(d) phone: no criteria add row, no goal button, no "Use it"', (await card.getByTestId('sc-crit-new').count()) === 0 && (await card.getByTestId('sc-goal-add').count()) === 0 && (await card.getByTestId('sc-lesson-use').count()) === 0);
  ok('(d) phone: no sideways overflow', !pl.overflow);
  // Rate the one unrated run from the phone.
  const unrated = card.locator('[data-testid="sc-run"]').filter({ hasText: 'Rate this run' }).first();
  if (await unrated.count()) {
    const before = Object.keys((await (await fetch(`${base}/api/agents/${SLUG}/scorecard`, { headers: { 'X-Dreamcontext-Vault': VAULT } })).json()).card.ratings).length;
    await unrated.getByTestId('sc-star-5').click();
    ok('(d) a rating from the phone is stored', await until(p, async () => Object.keys((await (await fetch(`${base}/api/agents/${SLUG}/scorecard`, { headers: { 'X-Dreamcontext-Vault': VAULT } })).json()).card.ratings).length > before, 8000));
  } else ok('(d) an unrated run row is on the phone', false, (await card.innerText()).slice(0, 400));
  const undo = card.locator('[data-testid="sc-learned"] [data-testid="sc-lesson-undo"]').first();
  ok('(d) the lesson\'s Undo is on the phone', (await undo.count()) === 1);
  await undo.click().catch(() => {});
  ok('(d) Undo from the phone retires the lesson', await until(p, async () => !((await (await fetch(`${base}/api/agents/${SLUG}/scorecard`, { headers: { 'X-Dreamcontext-Vault': VAULT } })).json()).card.lessons.some((l) => l.status === 'active')), 8000));
  await p.waitForTimeout(800);
  await shot(p, '06-phone-after-undo-390');
  ok('phone: no console errors', watch.errors.length === 0, watch.errors.slice(0, 6).join('\n'));
  ok('phone: no failed requests', watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));
  await pctx.close();
}

async function main() {
  let srv = null;
  try {
    setup();
    const port = await freePort();
    srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
    const base = `http://127.0.0.1:${port}`;
    const pw = await import('playwright');
    const browser = await pw.chromium.launch();
    try {
      const deskCtx = await desk(browser, base);
      await w3(deskCtx, base);
      await phone(browser, base, pw);
    } finally { await browser.close(); }
  } catch (e) {
    ok('ran to the end', false, e?.stack ?? e);
    try { console.log(readFileSync(join(SCRATCH, 'server.log'), 'utf-8').slice(-2000)); } catch { /* none */ }
  } finally { srv?.kill(); rmSync(SCRATCH, { recursive: true, force: true }); }
  console.log(`\nscreenshots: ${OUT}`);
  console.log(summary());
  process.exit(result.fails.length ? 1 : 0);
}

main();
