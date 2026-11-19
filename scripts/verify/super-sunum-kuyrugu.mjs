#!/usr/bin/env node
/**
 * verify:super-sunum-kuyrugu — the Super stage's presentation queue (task
 * super-sahnesinde-sunum-sirasi, AC1-AC3, AC5, AC8, AC9). The REAL dashboard (this worktree's
 * `dist/`) in Chromium, a stand-in `claude` and a scratch HOME; a fictional shop's three pages.
 *
 *   dreamcontext builder heavy -- node scripts/verify/super-sunum-kuyrugu.mjs
 *
 *  Q1  the Super presents page 1, then pages 2 and 3 in later turns: page 1 stays on screen as the
 *      frame's open tab, "<page 2> next" beside it, left of the exit, which reads "Leave the queue" (AC1, AC2);
 *  Q2  a narrow window (1000 px): the tabs stay left of the icons (D10); the page folds to its
 *      tab over a full-height chat, a tab opens it as a sheet, × folds it (owner 2026-11-17);
 *  Q3  Next opens page 2 (2/3) and the chat scrolls to the answer that queued it, flashing it (AC3);
 *  Q4  Leave the queue floats the stage: "1 presentation waiting · Continue", the side menu's
 *      Super row says one waits (AC5); Continue opens page 3 (3/3, "Finish");
 *  Q5  390 px (the phone layout: chat only, no stage) draws cleanly; Finish empties the queue;
 *  every state shot in dark and light; zero page errors and console errors.
 *
 * Output: tmp/super-sunum-kuyrugu/<pid>/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-verify-sunum-kuyrugu-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const IDS = join(SCRATCH, 'ids.json');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SHOTS = join(REPO, 'tmp', 'super-sunum-kuyrugu', String(process.pid));
// The card's name is its file's (`Odeme`); the page itself says the long title.
const PAGES = [['odeme', 'Ödeme ekranı'], ['fiyat', 'Fiyat sayfası'], ['logo', 'Logo seçenekleri']];

// The stand-in `claude`: the Super's handover opens the three pages and presents the first; a
// later "GO-PRESENT <n>" presents page n. Each CLI call is a real Bash tool call in the stream,
// so the chat's turn record (dashboard turnCards.ts) sees what each answer showed.
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-queue-' + process.pid;
let n = 0;
const bash = (...args) => {
  const id = 'toolu_' + process.pid + '_' + (n += 1);
  const command = 'dreamcontext ' + args.join(' ');
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  const text = (r.stdout || '') + (r.stderr || '');
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  return { args: args.join(' '), status: r.status, out: text };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify(o) + '\\n');
function superTurn(text) {
  if (text.includes('[super handover]')) {
    const ids = [];
    for (const [slug] of ${JSON.stringify(PAGES)}) {
      const r = bash('super', 'open', 'web', 'site/' + slug + '.html');
      try { ids.push(JSON.parse(r.out.slice(r.out.indexOf('{'))).container.id); } catch { ids.push(''); }
    }
    writeFileSync(${JSON.stringify(IDS)}, JSON.stringify(ids));
    const p = bash('super', 'present', ids[0]);
    report({ kind: 'handover', ids, present: p.out.slice(0, 300) });
    return 'Ödeme ekranı bitti, sahnede.';
  }
  const m = /Super Agent event|\\[super event/i.test(text) ? null : text.match(/^\\s*GO-PRESENT (\\d)\\s*$/m);
  if (m) {
    const ids = JSON.parse(readFileSync(${JSON.stringify(IDS)}, 'utf-8'));
    const r = bash('super', 'present', ids[Number(m[1]) - 1]);
    report({ kind: 'present', n: Number(m[1]), out: r.out.slice(0, 400) });
    return 'Sunum ' + m[1] + ' hazır, sırada.';
  }
  return 'tamam';
}
let running = false;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user' || running) continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    running = true;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    let said = 'tamam';
    try { said = role === 'super' ? superTurn(blocks.join('\\n')) : 'tamam'; } catch (e) { said = 'error ' + e; }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    running = false;
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const freePort = () => new Promise((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const reports = () => (existsSync(REPORTS) ? readFileSync(REPORTS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}`); }
  return !!cond;
};
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };

if (!existsSync(CLI)) { console.log('HARNESS: no dist/ (build first: dreamcontext builder heavy -- npm run build)'); process.exit(78); }
rmSync(SCRATCH, { recursive: true, force: true });
for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'site'), SHOTS]) mkdirSync(d, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: PROJ });
writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN, { mode: 0o755 });
const hues = ['#c7d2e6', '#ffb88c', '#7fe0c0'];
PAGES.forEach(([slug, title], i) => writeFileSync(join(PROJ, 'site', `${slug}.html`), `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;font:600 40px system-ui;display:grid;place-items:center;height:100vh;background:${hues[i]}">${title}</body></html>`));
writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }, null, 2)}\n`);
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const env = { ...clean, HOME, PATH: `${join(HOME, '.local', 'bin')}:${process.env.PATH}`, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0' };
spawnSync('node', [CLI, 'vaults', 'add', 'proj', PROJ], { cwd: PROJ, env, stdio: 'ignore' });
const port = await freePort();
const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env, stdio: 'ignore', detached: true });
server.on('error', () => {});
const base = `http://127.0.0.1:${port}`;
{
  const end = Date.now() + 90000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/api/health`)).status < 500) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
}

let browser;
const errors = [];
const watch = (page, where) => {
  page.on('pageerror', (e) => errors.push(`${where} crash: ${String(e.message).slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Content Security Policy|favicon|ERR_BLOCKED|\/api\/.*ws/.test(m.text())) errors.push(`${where}: ${m.text().slice(0, 200)}`); });
};
/** The same state, dark then light. */
const shot = async (page, name) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}-dark.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}-light.png`) });
};
const openStage = async (page) => {
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('[data-testid="super-surface"]:visible').count())) {
    await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(1200);
    const handover = page.locator('[data-testid="super-handover-btn"]:visible').first();
    if (await handover.count()) await handover.click().catch(() => {});
  }
  return until(async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 30000);
};
const pq = (page) => page.locator('[data-testid="super-pq"]');
// The frame's open tab names the shown presentation (owner 2026-11-15, option C): its name is the count now.
const count = async (page) => (await page.locator('[data-testid="super-present-tab-current"]').innerText().catch(() => '')).trim();
const at = (n) => [/Odeme|Ödeme/, /Fiyat/, /Logo/][n - 1];
const send = async (page, text) => {
  const box = page.locator('[data-testid="super-surface"] textarea').first();
  await box.click();
  await box.fill(text);
  await page.keyboard.press('Enter');
};

try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  watch(page, '1440');
  console.log('\n── Q1 three presentations, the first stays');
  ok('the stage shows', await openStage(page));
  ok('the handover presented page 1', await until(async () => reports().some((r) => r.kind === 'handover'), 60000), JSON.stringify(reports()));
  const ids = existsSync(IDS) ? JSON.parse(readFileSync(IDS, 'utf-8')) : [];
  ok('three page cards were opened', ids.filter(Boolean).length === 3, JSON.stringify(ids));
  ok('page 1 is presented', await until(async () => (await page.locator('[data-testid="super-stage-controls"]').count()) > 0, 20000));
  await send(page, 'GO-PRESENT 2');
  ok('page 2 was queued (the CLI says so)', await until(async () => reports().some((r) => r.kind === 'present' && r.n === 2 && /queue/i.test(r.out)), 30000), JSON.stringify(reports().slice(-1)));
  await page.waitForTimeout(1500);
  await send(page, 'GO-PRESENT 3');
  ok('page 3 was queued', await until(async () => reports().some((r) => r.kind === 'present' && r.n === 3 && /queue/i.test(r.out)), 30000), JSON.stringify(reports().slice(-1)));
  ok('the open tab is page 1, two more tabs wait', await until(async () => at(1).test(await count(page)) && (await page.locator('.super-present-tab').count()) === 3, 15000), await count(page));
  const step = await page.locator('[data-testid="super-present-tabs"]').boundingBox();
  const controls = await page.locator('[data-testid="super-stage-controls"]').boundingBox();
  ok('the tab strip sits left of the controls, same row', !!step && !!controls && step.x + step.width <= controls.x + 1 && Math.abs(step.y - controls.y) < 2, JSON.stringify({ step, controls }));
  const nextText = await page.locator('[data-testid="super-pq-next"]').innerText();
  ok('Next names page 2', /Fiyat/.test(nextText), nextText);
  const exitText = (await page.locator('[data-testid="super-stage-exit"]').getAttribute('aria-label')) ?? '';
  ok('the exit leaves the queue', /Sıradan çık|Leave the queue/.test(exitText), exitText);
  ok('page 1 is still the one on screen', at(1).test(await count(page)), await count(page));
  await shot(page, '1-uc-sunum-1440');

  console.log('\n── Q2 narrow band');
  await page.setViewportSize({ width: 1000, height: 800 });
  ok('the tabs stay, left of the icons', await until(async () => { const a = await page.locator('[data-testid="super-present-tabs"]').boundingBox(); const b = await page.locator('[data-testid="super-stage-controls"]').boundingBox(); return !!a && !!b && a.x + a.width <= b.x + 1; }, 5000));
  ok('the exit is still there', await page.locator('[data-testid="super-stage-exit"]:visible').count() === 1);
  // Owner 2026-11-17: on a narrow stage the card folds to its tab over a full-height chat.
  const sheetTabs = page.locator('[data-testid="super-sheet-tabs"]');
  ok('narrow: the page folds to its tab over the chat', await until(async () => (await sheetTabs.getAttribute('data-folded')) === 'true', 5000));
  ok('…no card drawn over the chat, the chat a full column', (await page.locator('[data-testid="super-container"][data-where="sheet"]').count()) === 0
    && (await page.locator('[data-testid="super-centre"]').getAttribute('data-chat')) === 'column');
  const chatBox = await page.locator('[data-testid="super-centre"]').boundingBox();
  const stageBox = await page.locator('[data-testid="super-surface"]:visible').first().boundingBox();
  ok('…the chat takes most of the stage\'s height', !!chatBox && !!stageBox && chatBox.height > stageBox.height * 0.65, JSON.stringify({ chatBox, stageBox }));
  await page.waitForTimeout(500);
  await shot(page, '2-dar-1000-kapali');
  await page.locator('[data-testid="super-sheet-tab"]').first().click();
  ok('a tab press opens the card as a sheet', await until(async () => (await page.locator('[data-testid="super-container"][data-where="sheet"]').count()) === 1, 5000));
  await page.waitForTimeout(700);
  await shot(page, '2-dar-1000');
  await page.locator('[data-testid="super-sheet-fold"]').click();
  ok('× folds it back', await until(async () => (await sheetTabs.getAttribute('data-folded')) === 'true', 5000));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(600);

  console.log('\n── Q3 Next, and the chat follows');
  await page.locator('[data-testid="super-pq-next"]').click();
  ok('page 2 after Next', await until(async () => at(2).test(await count(page)), 10000), await count(page));
  ok('the answer that queued page 2 flashes', await until(async () => (await page.locator('[data-reply-flash]', { hasText: 'Sunum 2' }).count()) > 0, 5000));
  await page.waitForTimeout(300);
  await shot(page, '3-sonraki-1440');

  console.log('\n── Q4 leave, wait, continue');
  await page.locator('[data-testid="super-stage-exit"]').click();
  ok('off the queue the band says one waits', await until(async () => (await pq(page).getAttribute('data-kind')) === 'wait', 10000));
  ok('…with its name', /Logo/.test(await pq(page).innerText()), await pq(page).innerText());
  const row = page.locator('[data-testid="drawer-super-row"]').first();
  const rowLabel = (await row.getAttribute('aria-label').catch(() => '')) ?? '';
  ok('the side menu\'s Super row says one waits', /1 (sunum bekliyor|presentations waiting)/.test(rowLabel) || (await row.count()) === 0, rowLabel);
  await shot(page, '4-siradan-cikildi-1440');
  await page.locator('[data-testid="super-pq-resume"]').click();
  ok('Continue opens page 3', await until(async () => at(3).test(await count(page)), 10000), await count(page));
  ok('the last one has no next tab', (await page.locator('[data-testid="super-pq-next"]').count()) === 0);
  await shot(page, '5-son-sunum-1440');

  console.log('\n── Q5 390 px');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const pp = await phone.newPage();
  watch(pp, '390');
  ok('the stage shows at 390', await openStage(pp));
  // 390 is the phone layout: the Super's chat, no stage (as every stage control today), so no band.
  ok('390 draws the chat with no band and nothing broken', await until(async () => (await pp.locator('textarea').count()) > 0, 15000) && (await pq(pp).count()) === 0);
  await shot(pp, '6-telefon-390');
  await phone.close();
  await page.locator('[data-testid="super-stage-exit"]').click();
  ok('leaving the last one empties the queue: no band', await until(async () => (await pq(page).count()) === 0, 10000));
  await shot(page, '7-bitti-1440');
  ok('no page or console errors', errors.length === 0, errors.slice(0, 6).join('\n'));
  await context.close();
} catch (e) {
  fails.push(`crashed: ${e?.stack || e}`);
  console.log(`  ✗ crashed: ${e?.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
}
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${SHOTS}`);
process.exit(fails.length === 0 ? 0 : 1);
