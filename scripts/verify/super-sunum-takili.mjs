#!/usr/bin/env node
/**
 * verify:super-sunum-takili — "1 presentation waiting" never sticks on the Super stage (owner
 * 2026-11-18, "şu takılı kalıyor": a picture question's presentation came back after every close
 * while its question stayed open, and the strip had no way to dismiss it). The REAL dashboard
 * (this worktree's `dist/`) in Chromium, a stand-in `claude`, a scratch HOME; a fictional shop.
 *
 *   dreamcontext builder heavy -- node scripts/verify/super-sunum-takili.mjs
 *
 *  T3  (first, before any question) the ✕: a waiting presentation leaves unseen, the stage stays;
 *  T1  page 1 presented, the Super asks a question showing page 2: it waits; leaving page 1 shows
 *      the strip "1 presentation waiting · Fiyat" with Continue and a ✕;
 *  T2  the field case: Continue opens the question's page, closing it empties the queue while the
 *      question stays open: no strip comes back;
 *  T5  he leaves a shown presentation another way (a page side by side): it never returns, the
 *      reopened screen names only what he has not seen;
 *  T4  a restart with a stale item (waiting since yesterday) on the record: no strip;
 *  every state shot in dark and light; zero page errors and console errors.
 *
 * Output: tmp/super-sunum-takili/<SHOT_TAG or pid>/.
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
const SCRATCH = join(tmpdir(), `dc-verify-sunum-takili-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const IDS = join(SCRATCH, 'ids.json');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SHOTS = join(REPO, 'tmp', 'super-sunum-takili', process.env.SHOT_TAG || String(process.pid));
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
  const ask = /Super Agent event|\\[super event/i.test(text) ? null : text.match(/^\\s*GO-ASK\\s*$/m);
  if (ask) {
    const ids = JSON.parse(readFileSync(${JSON.stringify(IDS)}, 'utf-8'));
    const r = bash('super', 'ask', 'Silme güvenliği planı uygun mu?', '--title', 'Silme güvenliği planı', '--option', 'Evet::plan böyle kalsın', '--option', 'Hayır::değiştirelim', '--show', ids[1]);
    report({ kind: 'ask', out: r.out.slice(0, 600) });
    return 'Soruyu sordum, plan sırada.';
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
let server;
const base = `http://127.0.0.1:${port}`;
const startServer = async () => {
  server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env, stdio: 'ignore', detached: true });
  server.on('error', () => {});
  const end = Date.now() + 90000;
  while (Date.now() < end) { try { if ((await fetch(`${base}/api/health`)).status < 500) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
};
const stopServer = async () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } await new Promise((r) => setTimeout(r, 1500)); };
await startServer();
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const record = () => JSON.parse(readFileSync(RECORD, 'utf-8'));
const waiting = () => record().presentQueue?.items ?? [];

let browser;
const errors = [];
const watch = (page, where) => {
  page.on('pageerror', (e) => errors.push(`${where} crash: ${String(e.message).slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Content Security Policy|favicon|ERR_BLOCKED|ERR_CONNECTION_REFUSED|\/api\/.*ws/.test(m.text())) errors.push(`${where}: ${m.text().slice(0, 200)}`); });
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
const exit = (page) => page.locator('[data-testid="super-stage-exit"]').click();
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
  console.log('\n── T0 the stage');
  ok('the stage shows', await openStage(page));
  ok('the handover presented page 1', await until(async () => reports().some((r) => r.kind === 'handover'), 60000), JSON.stringify(reports()));
  ok('page 1 is presented', await until(async () => (await page.locator('[data-testid="super-stage-controls"]').count()) > 0, 20000));
  console.log('\n── T3 the ✕ dismisses a waiting one');
  await send(page, 'GO-PRESENT 3');
  ok('page 3 waits', await until(async () => waiting().length === 2, 20000), JSON.stringify(record().presentQueue));
  await page.waitForTimeout(800);
  await exit(page);
  ok('the strip names page 3', await until(async () => /Logo/.test(await pq(page).innerText().catch(() => '')), 10000));
  await page.locator('[data-testid="super-pq-dismiss"]').click();
  ok('✕: the strip leaves', await until(async () => (await pq(page).count()) === 0, 10000));
  ok('✕: the record\'s queue is empty and nothing was presented', waiting().length === 0 && record().view.mode !== 'present', JSON.stringify({ q: record().presentQueue, v: record().view }));
  await shot(page, '3-carpi');

  console.log('\n── T5 a presentation he saw and left another way never comes back (owner 2026-11-21)');
  await send(page, 'GO-PRESENT 1');
  ok('T5: page 1 opens', await until(async () => at(1).test(await count(page)), 20000), await count(page));
  await page.waitForTimeout(1200);
  await send(page, 'GO-PRESENT 3');
  ok('T5: page 3 waits behind it', await until(async () => waiting().length === 2, 20000), JSON.stringify(record().presentQueue));
  await page.waitForTimeout(800);
  {
    // He leaves page 1 without a queue button: page 2 side by side, the patch the window sends.
    const ids5 = JSON.parse(readFileSync(IDS, 'utf-8'));
    const st = await page.evaluate(async (card) => (await fetch('/api/super/layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'proj' },
      body: JSON.stringify({ view: { mode: 'half', card } }),
    })).status, ids5[1]);
    ok('T5: the side-by-side gesture lands', st < 300, String(st));
    ok('T5: page 1 left the queue as seen, page 3 still waits', waiting().length === 1 && waiting()[0].cards[0] === ids5[2], JSON.stringify(record().presentQueue));
    // The screen opens again: only page 3 is waiting.
    await page.reload({ waitUntil: 'domcontentloaded' });
    ok('T5: the stage shows after reopening', await openStage(page));
    await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'proj' }, body: JSON.stringify({ view: { mode: 'float' } }) }));
    ok('T5: the strip names page 3 only', await until(async () => { const t = await pq(page).innerText().catch(() => ''); return /Logo/.test(t) && !/Odeme|Ödeme/.test(t); }, 10000), await pq(page).innerText().catch(() => ''));
    await shot(page, '5-yeniden-acilis');
    await page.locator('[data-testid="super-pq-resume"]').click();
    ok('T5: Continue opens page 3', await until(async () => at(3).test(await count(page)), 10000), await count(page));
    await page.waitForTimeout(600);
    await exit(page);
    await page.waitForTimeout(2500);
    ok('T5: passing page 3 leaves no strip and an empty queue (page 1 never returns)', (await pq(page).count()) === 0 && waiting().length === 0, JSON.stringify(record().presentQueue));
  }

  await send(page, 'GO-PRESENT 1');
  ok('page 1 opens at once', await until(async () => at(1).test(await count(page)), 20000), await count(page));
  await page.waitForTimeout(1200);

  console.log('\n── T1 a question\'s presentation waits behind page 1');
  await send(page, 'GO-ASK');
  ok('the question was asked', await until(async () => reports().some((r) => r.kind === 'ask'), 30000), JSON.stringify(reports().slice(-1)));
  ok('its page waits in the queue', await until(async () => waiting().length === 2 && !!waiting()[1].ask, 15000), JSON.stringify(record().presentQueue));
  const askId = waiting()[1]?.ask;
  await page.waitForTimeout(800);
  await exit(page);
  ok('leaving page 1 shows the strip with the question\'s page', await until(async () => (await pq(page).getAttribute('data-kind')) === 'wait' && /Fiyat/.test(await pq(page).innerText()), 10000));
  ok('the strip has a ✕', (await page.locator('[data-testid="super-pq-dismiss"]').count()) === 1);
  await shot(page, '1-bekliyor');

  console.log('\n── T2 Continue, then close: the strip does not come back');
  await page.locator('[data-testid="super-pq-resume"]').click();
  ok('Continue opens the question\'s page', await until(async () => at(2).test(await count(page)), 10000), await count(page));
  await page.waitForTimeout(600);
  await exit(page);
  await page.waitForTimeout(2500);
  ok('closing it leaves no strip', (await pq(page).count()) === 0, await pq(page).innerText().catch(() => ''));
  ok('the record\'s queue is empty', waiting().length === 0, JSON.stringify(record().presentQueue));
  ok('the question is still open', record().queue.some((q) => q.id === askId && q.state === 'escalated'), JSON.stringify(record().queue.map((q) => [q.id, q.state])));
  await shot(page, '2-kapatildi');

  console.log('\n── T4 a stale item does not survive a restart');
  await stopServer();
  const r = record();
  const ids = JSON.parse(readFileSync(IDS, 'utf-8'));
  r.presentQueue = { items: [{ id: 'pq90', cards: [ids[2]], at: Date.now() - 26 * 3600 * 1000 }], seen: 0, seq: 90 };
  r.view = { mode: 'float' };
  writeFileSync(RECORD, JSON.stringify(r));
  await startServer();
  ok('the stage shows after the restart', await openStage(page));
  await page.waitForTimeout(2500);
  ok('no strip for yesterday\'s item', (await pq(page).count()) === 0, await pq(page).innerText().catch(() => ''));
  await shot(page, '4-yeniden-baslatma');
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
