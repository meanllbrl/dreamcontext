#!/usr/bin/env node
/**
 * verify:super-kart-sekme — a narrow Super stage never splits the screen between a shown card and
 * the chat (owner 2026-11-17, round 2: ONE row of tabs, the chat's first, like a browser's). The
 * REAL dashboard (this worktree's `dist/`) in Chromium at 1000x800, a stand-in `claude` and a
 * scratch HOME, recorded as a video:
 *
 *   dreamcontext builder heavy -- node scripts/verify/super-kart-sekme.mjs
 *
 *  K1  the chat is open; the Super shows a card: it arrives as a tab, the chat's tab stays picked,
 *      the chat runs the whole stage, no name written twice;
 *  K2  the card's tab opens the card over the chat's composer; the chat's tab goes back;
 *  K3  the card open, a message typed and sent goes back to the chat's tab by itself;
 *  K4  the stage at 1440 is unchanged (the card beside the chat, no row of tabs);
 *  zero page and console errors. Output: tmp/super-kart-sekme/<pid>/ (video.webm, two pngs).
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
const SCRATCH = join(tmpdir(), `dc-verify-kart-sekme-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const IDS = join(SCRATCH, 'ids.json');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SHOTS = join(REPO, 'tmp', 'super-kart-sekme', String(process.pid));
// The card's name is its file's (`Odeme`); the page itself says the long title.
const PAGES = [['odeme', 'Ödeme ekranı'], ['fiyat', 'Fiyat sayfası'], ['logo', 'Logo seçenekleri']];

// The stand-in `claude`: the handover only says hello; "GO-SHOW" opens the payment page and
// presents it; anything else gets a short reply. Each CLI call is a real Bash tool call.
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
  if (text.includes('[super handover]')) return 'Merhaba, buradayım.';
  if (/Super Agent event|\\[super event/i.test(text)) return 'tamam';
  if (/^\\s*GO-SHOW\\s*$/m.test(text)) {
    const r = bash('super', 'open', 'web', 'site/odeme.html');
    let id = '';
    try { id = JSON.parse(r.out.slice(r.out.indexOf('{'))).container.id; } catch {}
    writeFileSync(${JSON.stringify(IDS)}, JSON.stringify([id]));
    const p = bash('super', 'present', id);
    report({ kind: 'present', id, out: p.out.slice(0, 300) });
    return 'Ödeme ekranını açtım, üstte sekmesinde duruyor.';
  }
  report({ kind: 'said', text: text.slice(0, 200) });
  return 'Not aldım: ' + text.trim().slice(0, 60);
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

const pause = (page, ms = 1600) => page.waitForTimeout(ms);
const tabs = (page) => page.locator('[data-testid="super-sheet-tabs"]');
const chatTab = (page) => page.locator('[data-testid="super-sheet-chat"]');
const cardTab = (page) => page.locator('[data-testid="super-sheet-tab"]').first();
const sheets = (page) => page.locator('[data-testid="super-container"][data-where="sheet"]');
const typeAndSend = async (page, text) => {
  const box = page.locator('[data-testid="super-surface"] textarea').first();
  await box.click();
  await box.pressSequentially(text, { delay: 60 });
  await pause(page, 600);
  await page.keyboard.press('Enter');
};

let video = '';
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, colorScheme: 'light', recordVideo: { dir: SHOTS, size: { width: 1000, height: 800 } } });
  const page = await context.newPage();
  watch(page, '1000');
  console.log('\n── K1 the card arrives as a tab');
  ok('the stage shows, narrow', await openStage(page) && await until(async () => (await page.locator('[data-testid="super-surface"][data-narrow="true"]:visible').count()) > 0, 10000));
  await pause(page, 2000);
  await send(page, 'GO-SHOW');
  ok('the Super presented the card', await until(async () => reports().some((r) => r.kind === 'present'), 30000), JSON.stringify(reports()));
  ok('…it arrives as a tab, the chat\'s tab stays picked', await until(async () => (await cardTab(page).count()) === 1 && (await chatTab(page).getAttribute('aria-selected')) === 'true', 15000));
  ok('…no card drawn over the chat', (await sheets(page).count()) === 0);
  ok('…no second strip naming it again', (await page.locator('[data-testid="super-present-tabs"]').count()) === 0);
  const stageBox = await page.locator('[data-testid="super-surface"]:visible').first().boundingBox();
  const chatBox = await page.locator('[data-testid="super-centre"]').boundingBox();
  ok('…the chat runs the stage\'s height', !!chatBox && !!stageBox && chatBox.height > stageBox.height * 0.8, JSON.stringify({ chatBox, stageBox }));
  await pause(page, 2000);
  await page.screenshot({ path: join(SHOTS, 'kapali-sohbet.png') });

  console.log('\n── K2 the card\'s tab, then back to the chat');
  await cardTab(page).click();
  ok('the card opens', await until(async () => (await sheets(page).count()) === 1 && (await cardTab(page).getAttribute('aria-selected')) === 'true', 5000));
  ok('…the composer stays at the foot', await page.locator('[data-testid="super-surface"] textarea').first().isVisible());
  await pause(page, 2000);
  await page.screenshot({ path: join(SHOTS, 'acik-kart.png') });
  await chatTab(page).click();
  ok('the chat\'s tab goes back to the chat', await until(async () => (await sheets(page).count()) === 0 && (await chatTab(page).getAttribute('aria-selected')) === 'true', 5000));
  await pause(page, 2000);

  console.log('\n── K3 send from the card, back to the chat by itself');
  await cardTab(page).click();
  await until(async () => (await sheets(page).count()) === 1, 5000);
  await pause(page, 1500);
  await typeAndSend(page, 'Fiyat satırını büyüt');
  ok('sending goes back to the chat\'s tab', await until(async () => (await sheets(page).count()) === 0 && (await chatTab(page).getAttribute('aria-selected')) === 'true', 5000));
  ok('…and the Super answered', await until(async () => reports().some((r) => r.kind === 'said' && /Fiyat/.test(r.text)), 20000));
  await pause(page, 2500);
  video = await page.video()?.path() ?? '';
  await context.close();

  console.log('\n── K4 a wide stage is unchanged');
  const wide = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const wpage = await wide.newPage();
  watch(wpage, '1440');
  await openStage(wpage);
  // The narrow run's presentation ended with its turn; the Super shows the card again here.
  const before = reports().filter((r) => r.kind === 'present').length;
  await send(wpage, 'GO-SHOW');
  await until(async () => reports().filter((r) => r.kind === 'present').length > before, 30000);
  ok('1440: the card beside the chat, no row of tabs', await until(async () => (await wpage.locator('[data-testid="super-container"][data-where="present"]').count()) === 1, 15000)
    && (await tabs(wpage).count()) === 0);
  await wpage.screenshot({ path: join(SHOTS, 'genis-1440.png') });
  await wide.close();
  ok('no page or console errors', errors.length === 0, errors.join('\n'));
} catch (err) {
  fails.push(`crashed: ${err instanceof Error ? err.message : err}`);
  console.log(err);
} finally {
  await browser?.close().catch(() => {});
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
}
if (video) console.log(`video: ${video}`);
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${SHOTS}`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length ? 1 : 0);
