#!/usr/bin/env node
/**
 * A group seen whole (owner 2026-10-27, screen recording of the Super stage: to look at three
 * panel screenshots he clicked the group, one picture, closed it, went back to the group, the
 * next one…). One action shows every card of a group at once, one action goes back.
 *
 *   npm run build && node scripts/verify/super-group-present.mjs
 *
 * Drives the real dashboard server on a scratch HOME and the real dashboard in Chromium at
 * 1440x900, with a scripted stand-in `claude` that, as the Super Agent, opens three wide 1440 px
 * screenshots in one `super open image` call (one group), and later runs `super present <group>`.
 * No tokens spent; everything is fictional ("Pocket Ledger").
 *
 * Proves: the group panel's "Open all" shows all three pictures at once (no overlap, each
 * readable); "Back to the group" leaves the presentation and reopens the group's panel; a
 * double-click on the group tile does the same as "Open all"; `super present <group>` opens it
 * straight into that view. Screenshots: tmp/super-group-present/. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-group-present-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-group-present');
const REPORTS = join(SCRATCH, 'reports.ndjson');

const SHOTS = ['shots/card-1440.png', 'shots/bind-dialog-1440.png', 'shots/unbind-dialog-1440.png'];
const TITLES = ['Araç sayfası kartı', 'Bağlama onayı', 'Çözme onayı'];

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-super-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, ...o }) + '\\n');
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    report({ kind: 'handover', steps: [cli('super', 'open', 'image', ${SHOTS.map((r) => JSON.stringify(r)).join(', ')}, '--titles', ${JSON.stringify(TITLES.join('|'))})] });
    return 'opened the panel shots';
  }
  const g = text.match(/PRESENT-GROUP (grp-[a-z0-9-]+)/);
  if (g) {
    report({ kind: 'present', steps: [cli('super', 'present', g[1])] });
    return 'presented the group';
  }
  return 'ok';
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
    let said = 'ok';
    try { said = role === 'super' ? superTurn(blocks.find((b) => /\\[super handover\\]|PRESENT-GROUP/.test(b)) ?? blocks[0] ?? '') : 'ok'; } catch (e) { said = 'error ' + e; }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    running = false;
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'shots'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'pocket-ledger', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  // Wide 1440 px panel shots, like the owner's (ffmpeg test patterns, three different ones).
  SHOTS.forEach((rel, i) => {
    const f = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${['testsrc', 'smptebars', 'rgbtestsrc'][i]}=size=1440x900`, '-frames:v', '1', join(PROJ, rel)], { encoding: 'utf-8' });
    if (f.status !== 0) throw new Error(`ffmpeg failed: ${f.stderr}`);
  });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = createWriteStream(join(SCRATCH, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const readNd = (path) => { try { return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const record = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return { containers: [], groups: [] }; } };
const idOf = (ref) => record().containers.find((c) => c.ref === ref)?.id;

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};
const settle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => page.waitForTimeout(900));

async function openChat(page, base) {
  await page.goto(`${base}/?vault=pocket-ledger`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
}

let server = null;
let browser = null;
let lastPage = null;
try {
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  lastPage = page;
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n── hand over: the super opens three wide screenshots as one group');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the three pictures are one group', await until(page, async () => record().groups.some((g) => g.cards.length === 3), 60000),
    JSON.stringify(readNd(REPORTS)));
  const g = record().groups.find((x) => x.cards.length === 3);
  const tile = page.locator(`[data-testid="super-group"][data-group-id="${g.id}"]`);
  await settle(page);
  ok('the stage draws the group tile', await until(page, async () => (await tile.count()) === 1 && await tile.isVisible()));

  // Every picture of the group on screen at once: three presented cards, side by side, none hidden.
  const shownAll = async () => {
    const view = record().view;
    if (view?.mode !== 'present' || (view.cards ?? []).length !== 3) return null;
    const rects = await page.locator('[data-testid="super-container"]:visible').evaluateAll((els, ids) => els
      .filter((e) => ids.includes(e.getAttribute('data-container-id')))
      .map((e) => { const r = e.getBoundingClientRect(); const img = e.querySelector('img'); const ir = img?.getBoundingClientRect();
        return { id: e.getAttribute('data-container-id'), where: e.getAttribute('data-where'), x: r.x, y: r.y, w: r.width, h: r.height, img: ir ? { w: ir.width, h: ir.height, done: img.complete && img.naturalWidth > 0 } : null }; }), g.cards);
    return rects;
  };
  const checkAll = async (label) => {
    let rects = null;
    await until(page, async () => { rects = await shownAll(); return rects && rects.length === 3 && rects.every((r) => r.img?.done); }, 15000);
    await settle(page);
    rects = await shownAll();
    const overlap = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
    ok(`${label}: all three pictures are on screen at once`, rects && rects.length === 3 && rects.every((r) => r.where === 'present' && r.img?.done), JSON.stringify(rects));
    ok(`${label}: …side by side, none covering another, each a readable size`, rects && rects.length === 3
      && !rects.some((a, i) => rects.some((b, j) => i < j && overlap(a, b))) && rects.every((r) => r.img && r.img.w >= 280), JSON.stringify(rects));
    ok(`${label}: …and the way back says "Back to the group"`, (await page.locator('[data-testid="super-stage-exit"][data-to-group="true"]:visible').innerText().catch(() => '')).trim() === 'Back to the group');
  };
  const backToGroup = async (label) => {
    await page.locator('[data-testid="super-stage-exit"]:visible').click();
    ok(`${label}: one click leaves the presentation and reopens the group`, await until(page, async () => record().view?.mode === 'float'
      && (await page.locator('[data-testid="super-group-panel"]:visible').count()) === 1, 8000), JSON.stringify(record().view));
    await settle(page);
    const items = await page.locator('[data-testid="super-group-panel"] [data-testid="super-group-item"]').count();
    ok(`${label}: …its panel lists the three pictures; the group is unchanged`, items === 3 && record().groups.find((x) => x.id === g.id)?.cards.length === 3, String(items));
  };

  console.log('\n── "Open all" on the group panel');
  await tile.click();
  ok('a click opens the group panel', await until(page, async () => (await page.locator('[data-testid="super-group-panel"]:visible').count()) === 1, 4000));
  await settle(page);
  await page.screenshot({ path: join(OUT, '1-group-panel-1440.png') });
  await page.locator('[data-testid="super-group-panel-open-all"]:visible').click();
  await checkAll('open all');
  await page.screenshot({ path: join(OUT, '2-all-at-once-1440.png') });
  await backToGroup('open all');
  await page.screenshot({ path: join(OUT, '3-back-to-group-1440.png') });
  await page.keyboard.press('Escape');
  await until(page, async () => (await page.locator('[data-testid="super-group-panel"]:visible').count()) === 0, 4000);
  await settle(page);

  console.log('\n── double-click on the group tile');
  await tile.dblclick();
  await checkAll('double-click');
  await page.screenshot({ path: join(OUT, '4-double-click-1440.png') });
  console.log('\n── Esc goes back to the group too');
  await page.locator('[data-testid="super-surface"]').click({ position: { x: 5, y: 450 } }).catch(() => {});
  await page.keyboard.press('Escape');
  ok('Esc leaves the presentation and reopens the group', await until(page, async () => record().view?.mode === 'float'
    && (await page.locator('[data-testid="super-group-panel"]:visible').count()) === 1, 8000), JSON.stringify(record().view));
  await page.keyboard.press('Escape');
  await settle(page);

  console.log('\n── the Super opens the group straight into that view');
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click();
  await input.fill(`PRESENT-GROUP ${g.id}`);
  await page.keyboard.press('Enter');
  ok('`super present <group>` succeeded', await until(page, async () => readNd(REPORTS).find((r) => r.kind === 'present')?.steps?.[0]?.status === 0, 60000),
    JSON.stringify(readNd(REPORTS).find((r) => r.kind === 'present')));
  await checkAll('super present');
  await page.screenshot({ path: join(OUT, '5-super-present-1440.png') });
  await backToGroup('super present');

  ok('no console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
  await context.close();
} catch (e) {
  fails.push(`crashed: ${e?.stack || e}`);
  if (lastPage) await lastPage.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  console.log(`  ✗ crashed: ${e?.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${OUT}`);
process.exit(fails.length === 0 ? 0 : 1);
