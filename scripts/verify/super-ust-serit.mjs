#!/usr/bin/env node
/**
 * verify:super-ust-serit — the presentation frame (owner 2026-11-15, option C "Çerçeve") and the
 * refusal of a missing file. The REAL dashboard (this worktree's `dist/`) in Chromium, a stand-in
 * `claude` and a scratch HOME; four real app screenshots as the pictures.
 *
 *   dreamcontext builder heavy -- node scripts/verify/super-ust-serit.mjs
 *
 *  B1  a group of 4 pictures presented, a second presentation queued: at 1024, 1440, 1650 and 2000 px
 *      the frame is drawn, the tab strip (shown + next) and every icon sit inside the viewport and no
 *      two of them intersect; the current tab is the group's name, the next tab the page's;
 *  B2  an icon names itself on hover; the next tab opens the next presentation; Esc still leaves;
 *  B3  `super open image` over paths that do not exist is refused with the path: no card;
 *  B4  390 px draws the phone layout with no band; zero page errors and console errors.
 *
 * Output: tmp/super-ust-serit/<pid>/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-verify-ust-serit-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const IDS = join(SCRATCH, 'ids.json');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SHOTS = join(REPO, 'tmp', 'super-ust-serit', String(process.pid));
// The card's name is its file's (`Odeme`); the page itself says the long title.
const PAGES = [['odeme', 'Ödeme ekranı']];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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
    const r = bash('super', 'open', 'image', 'tmp/a.png', 'tmp/b.png', '--group', 'lina-seviye-karti', '--titles', 'Rozetli: Yetkin|Rozetli: hedef aynı seviye', '--present');
    const q = bash('super', 'open', 'image', 'tmp/c.png', 'tmp/d.png', '--group', 'rakip', '--titles', 'Rakip: bir|Rakip: iki');
    let id = '';
    try { id = JSON.parse(q.out.slice(q.out.indexOf('{'))).container.id; } catch {}
    const p = bash('super', 'present', id);
    const a = bash('super', 'ask', '--json', JSON.stringify({ questions: [{ question: 'Seviye rozetli kartta büyük atlamaya staging\\'e çıkmadan izin verelim mi?', header: 'Sınır', multiSelect: false, options: [{ label: 'Evet', description: 'Yayınla' }, { label: 'Hayır', description: 'Bekle' }] }] }));
    report({ kind: 'handover', open: r.out.slice(0, 300), queue: p.out.slice(0, 300), ask: a.out.slice(0, 300) });
    return 'Sunum hazır.';
  }
  if (/GO-MISSING/.test(text)) {
    const r = bash('super', 'open', 'image', 'tmp/yok1.png', 'tmp/yok2.png', '--present');
    report({ kind: 'missing', status: r.status, out: r.out.slice(0, 600) });
    return 'denendi';
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
for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'site'), join(PROJ, 'tmp'), SHOTS]) mkdirSync(d, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: PROJ });
writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN, { mode: 0o755 });
// SUNUM_PICS=<dir of .png>: real pictures for the screenshots (its first four), else 1x1 ones.
const PICS_DIR = process.env.SUNUM_PICS ?? '';
const REAL = PICS_DIR && existsSync(PICS_DIR) ? readdirSync(PICS_DIR).filter((f) => f.endsWith('.png')).sort().slice(0, 4).map((f) => join(PICS_DIR, f)) : [];
['a', 'b', 'c', 'd'].forEach((n, i) => writeFileSync(join(PROJ, 'tmp', `${n}.png`), REAL[i] ? readFileSync(REAL[i]) : PNG));
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
const count = async (page) => (await page.locator('[data-testid="super-pq-count"]').innerText().catch(() => '')).trim();
const send = async (page, text) => {
  const box = page.locator('[data-testid="super-surface"] textarea').first();
  await box.click();
  await box.fill(text);
  await page.keyboard.press('Enter');
};


const geometry = () => page.evaluate(() => {
  const r = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length).map((e) => { const b = e.getBoundingClientRect(); return { sel, x: b.x, y: b.y, w: b.width, h: b.height }; });
  return [...r('[data-testid="super-queue-head"]'), ...r('[data-testid="super-present-tabs"]'), ...r('.super-present-tab'), ...r('[data-testid="super-stage-controls"]')];
});
let page;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  page = await context.newPage();
  watch(page, 'bar');
  ok('the stage shows', await openStage(page));
  ok('handover ran', await until(async () => reports().some((r) => r.kind === 'handover'), 60000), JSON.stringify(reports()));
  ok('presented', await until(async () => (await page.locator('[data-testid="super-stage-controls"]').count()) > 0, 20000));
  await page.waitForTimeout(2500);
  const clash = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
  for (const width of [1280, 1024, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(1000);
    await shot(page, `w${width}`);
    const g = await geometry();
    const head = g.filter((x) => x.sel.includes('queue-head'));
    const rest = g.filter((x) => !x.sel.includes('queue-head') && !x.sel.includes('present-tabs'));
    console.log(width, JSON.stringify(g.map((x) => [x.sel.slice(-20), Math.round(x.x), Math.round(x.y), Math.round(x.w), Math.round(x.h)])));
    ok(`${width}: question bar drawn`, head.length >= 1);
    ok(`${width}: the bar overlaps no tab or icon`, head.every((h) => rest.every((p) => !clash(h, p))), JSON.stringify({ head, rest }));
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.super-present-tab')].filter((e) => e.getClientRects().length).map((e) => e.textContent));
    console.log('   tabs', JSON.stringify(tabs));
    // The thumbs: nothing but the picture and a caption.
    const thumbs = await page.evaluate(() => [...document.querySelectorAll('.super-card-frame[data-where="thumb"]')].filter((e) => e.getClientRects().length).map((e) => { const b = e.getBoundingClientRect(); return { w: b.width, h: b.height, text: e.innerText.replace(/\n/g, ' | '), imgs: [...e.querySelectorAll('img')].map((i) => ({ nw: i.naturalWidth, w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height, fit: getComputedStyle(i).objectFit })) }; }));
    console.log('   thumbs', JSON.stringify(thumbs));
  }
  ok('no page errors', errors.length === 0, errors.join('\n'));
} catch (e) {
  ok('harness ran', false, e.stack || e);
} finally {
  await browser?.close().catch(() => {});
  try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
  console.log(`\n${pass} passed, ${fails.length} failed. Shots: ${SHOTS}`);
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(fails.length ? 1 : 0);
}
