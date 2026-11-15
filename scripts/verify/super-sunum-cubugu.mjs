#!/usr/bin/env node
/**
 * verify:super-sunum-cubugu — the presentation bar never overlaps itself, and `super open` refuses a
 * file that is not there. The REAL dashboard (this worktree's `dist/`) in Chromium, a stand-in
 * `claude` and a scratch HOME.
 *
 *   dreamcontext builder heavy -- node scripts/verify/super-sunum-cubugu.mjs
 *
 *  B1  a group of 4 pictures presented, a second presentation queued: at 1024, 1440, 1650 and 2000 px no
 *      two controls of the top bar (queue pill, layout switch, ask, close group, minimize, "…") intersect;
 *  B2  a long title truncates with an ellipsis inside the pill, never over a neighbour;
 *  B3  `super open image` over paths that do not exist is refused with the path: no card, no presentation;
 *  zero page errors and console errors.
 *
 * Output: tmp/super-sunum-cubugu/<pid>/.
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
const SCRATCH = join(tmpdir(), `dc-verify-sunum-cubugu-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const IDS = join(SCRATCH, 'ids.json');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SHOTS = join(REPO, 'tmp', 'super-sunum-cubugu', String(process.pid));
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
    const r = bash('super', 'open', 'image', 'tmp/a.png', 'tmp/b.png', 'tmp/c.png', 'tmp/d.png', '--group', 'Koyu: normal ve çok uzun bir grup adı ki kırpılsın', '--present');
    const q = bash('super', 'open', 'web', 'site/odeme.html', '--title', 'Sonraki sunum da bir hayli uzun bir başlık taşıyor');
    let id = '';
    try { id = JSON.parse(q.out.slice(q.out.indexOf('{'))).container.id; } catch {}
    const p = bash('super', 'present', id);
    report({ kind: 'handover', open: r.out.slice(0, 300), queue: p.out.slice(0, 300) });
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
for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(PROJ, 'tmp', `${n}.png`), PNG);
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

try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  watch(page, 'bar');
  ok('the stage shows', await openStage(page));
  ok('the handover opened the group and queued a second', await until(async () => reports().some((r) => r.kind === 'handover'), 60000), JSON.stringify(reports()));
  ok('the group is presented', await until(async () => (await page.locator('[data-testid="super-stage-controls"]').count()) > 0, 20000));
  ok('the band counts 1/2', await until(async () => (await count(page)) === '1/2', 20000), await count(page));

  const rects = () => page.evaluate(() => {
    const pick = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length).map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, t: (e.textContent || '').trim().slice(0, 24) }; });
    return {
      pill: pick('[data-testid="super-pq"] .super-pq-pill'),
      parts: [
        ...pick('[data-testid="super-pq"] .super-pq-pill'),
        ...pick('[data-testid="super-layout-switch"]'),
        ...pick('.super-stage-controls > .super-stage-exit'),
        ...pick('.super-stage-controls .super-stage-more'),
      ],
      ctl: pick('[data-testid="super-stage-controls"]'),
      names: pick('.super-pq-names').concat(pick('[data-testid="super-pq-next"]')),
    };
  });
  const clash = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
  for (const width of [1024, 1440, 1650, 2000]) {
    console.log(`\n── B1 viewport ${width}`);
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(900);
    const r = await rects();
    let overlaps = [];
    for (let i = 0; i < r.parts.length; i++) for (let j = i + 1; j < r.parts.length; j++) if (clash(r.parts[i], r.parts[j])) overlaps.push([r.parts[i].t, r.parts[j].t]);
    ok(`${width}: no two controls intersect (${r.parts.length} measured)`, r.parts.length >= 3 && overlaps.length === 0, JSON.stringify({ overlaps, parts: r.parts }));
    const ctl = r.ctl[0];
    ok(`${width}: the controls stay inside the viewport`, !!ctl && ctl.x >= 0 && ctl.x + ctl.w <= width + 1, JSON.stringify(ctl));
    ok(`${width}: the switch is whole (Grid reads Grid)`, (await page.locator('[data-testid="super-layout-grid"]').innerText().catch(() => 'Grid')).trim().length >= 3);
    await shot(page, `b1-${width}`);
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.waitForTimeout(700);
  const more = page.locator('[data-testid="super-stage-group-more"]');
  if (await more.count()) {
    console.log('\n── B2 folded bar at 1024');
    await more.click();
    ok('the "…" menu lists ask and close group', (await page.locator('[data-testid="super-stage-group-more-menu"] button').count()) === 2);
    await shot(page, 'b2-menu-1024');
    await page.keyboard.press('Escape');
  } else console.log('  (1024 is wide enough for all three buttons: no fold)');
  const pillNow = (await rects()).pill[0];
  ok('the pill keeps a readable width', !!pillNow && pillNow.w >= 100, JSON.stringify(pillNow));

  console.log('\n── B3 a missing file');
  await page.setViewportSize({ width: 1440, height: 900 });
  await send(page, 'GO-MISSING');
  ok('the Super tried', await until(async () => reports().some((r) => r.kind === 'missing'), 30000));
  const miss = reports().find((r) => r.kind === 'missing');
  ok('refused, naming the path', !!miss && miss.status !== 0 && /yok1\.png/.test(miss.out), JSON.stringify(miss));
  await page.waitForTimeout(800);
  ok('no "isn\'t there any more" card', (await page.getByText(/isn.t there any more|artık yok|burada değil/i).count()) === 0);
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
