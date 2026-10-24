#!/usr/bin/env node
/**
 * Pictures opened together are ONE group on the Super stage (owner 2026-10-22, Tilki stage: five
 * before/after mockups landed as five scattered tiles around the centre chat: "image'ler neden
 * dağınık şekilde? bunlar gruplanmalı").
 *
 *   npm run build && node scripts/verify/super-image-group.mjs
 *
 * WHAT IT DRIVES — the real dashboard server on a scratch HOME (DREAMCONTEXT_DESKTOP=1), the real
 * dashboard in Chromium at 1440×900, and a scripted stand-in `claude` that, as the Super Agent on
 * hand-over, opens two pictures in two SEPARATE `super open image` calls (no flag), then three in
 * ONE call (no flag). No tokens spent; everything is fictional ("Pocket Ledger").
 *
 * WHAT IT PROVES — the record holds the two picture groups: the two separate pictures in one
 * ("before", their folder), the three in another ("after", labelled with `--titles`); the second
 * separate call answered `autoGroup`; the stage draws the group tiles and no loose picture tile.
 *
 * Card names (owner 2026-10-22, 19:39: "başlıkları yok"): every name a group tile lists is
 * readable: a picture by its file name ("A agac listede"), never a path; `--titles` labels win; a
 * task group lists the tasks' titles, never their slugs.
 *
 * The stage tidies itself ("kullanılmayan kartlar kalabalık oluşturuyor"): with the idle bar
 * shortened to 20 s (DREAMCONTEXT_SUPER_TIDY_IDLE_MS, verify only), what nobody touched goes to
 * Others (never closed) while the group the owner just opened stays on the stage.
 *
 * Pictures follow their job (owner 2026-10-23: "anlamsız iki grup kartı neden oluşmuş"): the
 * super delegates a child, shows its designs with `--for <child>` and, in the same moment, two
 * pictures for no job; it then sends the child new work. With the grace shortened to 3 s
 * (DREAMCONTEXT_SUPER_TIDY_GRACE_MS, verify only) the turned-down designs go to Others (never
 * closed) while the pictures shown for no job stay on the stage.
 * Screenshots: tmp/super-image-group/. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-image-group-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-image-group');
const REPORTS = join(SCRATCH, 'reports.ndjson');

const BEFORE = ['mockups/before/A-agac-listede.png', 'mockups/before/B_org_semasi.png'];
const AFTER = ['mockups/after/share-phone.png', 'mockups/after/share-desktop.png', 'mockups/after/share-sheet.png'];
const AFTER_TITLES = ['Sonra: telefon', 'Sonra: masaüstü', 'Sonra: paylaş'];
const TASKS = [['ship-the-share-sheet', 'Ship the share sheet'], ['fix-the-ledger-export', 'Fix the ledger export']];
const IDLE_MS = 20_000;
const GRACE_MS = 3_000;
const JOB_PICS = ['mockups/share/v1-sheet.png', 'mockups/share/v1-phone.png'];
const NO_JOB = ['mockups/ideas/idea-a.png', 'mockups/ideas/idea-b.png'];
// Two words that need two lines on a group tile (owner 2026-10-23: "Pencere düzeltmesi" showed as "Pencere…").
const TASK_GROUP = 'Paylaşım düzeltmesi';

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
    const steps = [
      ${BEFORE.map((r) => `cli('super', 'open', 'image', ${JSON.stringify(r)})`).join(',\n      ')},
      cli('super', 'open', 'image', ${AFTER.map((r) => JSON.stringify(r)).join(', ')}, '--titles', ${JSON.stringify(AFTER_TITLES.join('|'))}),
      cli('super', 'open', 'task', ${TASKS.map(([slug]) => JSON.stringify(slug)).join(', ')}, '--group', ${JSON.stringify(TASK_GROUP)}),
    ];
    report({ kind: 'handover', steps });
    return 'opened the pictures';
  }
  if (text.includes('JOB-PICS')) {
    const d = cli('super', 'delegate', '--prompt', 'CHILD-PICS draw the share sheet', '--brief', 'Share sheet designs');
    const child = (d.out.match(/"sessionId"\\s*:\\s*"([^"]+)"/) || [])[1] || '';
    const steps = [d,
      cli('super', 'open', 'image', ${JOB_PICS.map((r) => JSON.stringify(r)).join(', ')}, '--for', child),
      cli('super', 'open', 'image', ${NO_JOB.map((r) => JSON.stringify(r)).join(', ')}),
    ];
    report({ kind: 'job-pics', child, steps });
    return 'showed the share sheet designs';
  }
  const send = text.match(/JOB-SEND ([A-Za-z0-9_-]+)/);
  if (send) {
    report({ kind: 'job-send', steps: [cli('super', 'send', send[1], 'Not this one: draw another share sheet.')] });
    return 'sent new work';
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
    try { said = role === 'super' ? superTurn(blocks.find((b) => /\\[super handover\\]|JOB-PICS|JOB-SEND/.test(b)) ?? blocks[0] ?? '') : 'ok'; } catch (e) { said = 'error ' + e; }
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
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'mockups', 'before'), join(PROJ, 'mockups', 'after'), join(PROJ, 'mockups', 'share'), join(PROJ, 'mockups', 'ideas'), OUT]) mkdirSync(d, { recursive: true });
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
  for (const [, name] of TASKS) {
    const t = spawnSync(process.execPath, [CLI, 'tasks', 'create', name, '-w', 'A fictional Pocket Ledger task.'], { cwd: PROJ, env: env(), encoding: 'utf-8' });
    if (t.status !== 0) throw new Error(`tasks create failed: ${t.stderr || t.stdout}`);
  }
  const pics = ['diagram-recall.png', 'diagram-loop.png', 'diagram-memory.png', 'diagram-architecture.png', 'diagram-howitworks.png'];
  [...BEFORE, ...AFTER, ...JOB_PICS, ...NO_JOB].forEach((rel, i) => copyFileSync(join(REPO, 'public', 'image', pics[i % pics.length]), join(PROJ, rel)));
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...env(), PATH, DREAMCONTEXT_SUPER_TIDY_IDLE_MS: String(IDLE_MS), DREAMCONTEXT_SUPER_TIDY_TICK_MS: '1000', DREAMCONTEXT_SUPER_TIDY_GRACE_MS: String(GRACE_MS) }, stdio: ['ignore', 'pipe', 'pipe'],
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

  console.log('\n── hand over: the super opens 2 pictures one by one, then 3 in one call');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super agent opened the five pictures and the tasks', await until(page, async () => !!readNd(REPORTS).find((r) => r.kind === 'handover') && [...BEFORE, ...AFTER].every((r) => idOf(r)), 60000),
    JSON.stringify(readNd(REPORTS).find((r) => r.kind === 'handover')?.steps));
  const steps = readNd(REPORTS).find((r) => r.kind === 'handover')?.steps ?? [];
  ok('every open call succeeded', steps.length === 4 && steps.every((s) => s.status === 0), JSON.stringify(steps));
  const parse = (s) => { try { return JSON.parse(s.out); } catch { return {}; } };
  ok('the first single picture stood alone (no group in its answer)', steps[0] && !parse(steps[0]).group, steps[0]?.out);
  ok('the second single call answered autoGroup with the two pictures', parse(steps[1] ?? { out: '' }).autoGroup === true && parse(steps[1]).group?.cards?.length === 2, steps[1]?.out);

  const rec = record();
  const groupOf = (ref) => rec.groups.find((g) => g.cards.includes(idOf(ref)));
  ok('the record holds the two picture groups and the task group', rec.groups.length === 3, JSON.stringify(rec.groups));
  const gb = groupOf(BEFORE[0]);
  const ga = groupOf(AFTER[0]);
  ok('the two separate pictures are one group, "before"', gb && gb.name === 'before' && BEFORE.every((r) => gb.cards.includes(idOf(r))) && gb.cards.length === 2, JSON.stringify(gb));
  ok('the three named in one call are one group, "after"', ga && ga.name === 'after' && AFTER.every((r) => ga.cards.includes(idOf(r))) && ga.cards.length === 3, JSON.stringify(ga));
  ok('both groups float on the stage', rec.groups.every((g) => g.place === 'float'));

  await settle(page);
  await page.waitForTimeout(2500);
  const tiles = await page.locator('[data-testid="super-group"]:visible').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')));
  ok('the stage draws the three group tiles', tiles.length === 3 && rec.groups.every((g) => tiles.includes(g.id)), JSON.stringify(tiles));
  const loose = await page.locator('[data-testid="super-container"]:visible').evaluateAll((els) => els.map((e) => e.getAttribute('data-container-id')));
  const pictureIds = [...BEFORE, ...AFTER].map(idOf);
  ok('no picture floats as a loose tile', !loose.some((id) => pictureIds.includes(id)), JSON.stringify(loose));
  await page.screenshot({ path: join(OUT, '1-groups-1440.png') });

  console.log('\n── every card a readable name');
  const namesIn = (gid) => page.locator(`[data-testid="super-group"][data-group-id="${gid}"] .super-tile-member`).allInnerTexts();
  const tg = rec.groups.find((g) => g.name === TASK_GROUP);
  const nb = await namesIn(gb?.id);
  ok('the "before" tile names its pictures by file name, no path', nb.join('|') === 'A agac listede|B org semasi', JSON.stringify(nb));
  const na = await namesIn(ga?.id);
  ok('the "after" tile shows the --titles labels', AFTER_TITLES.every((t) => na.includes(t)) || (na.length === 2 && na.every((t) => AFTER_TITLES.includes(t))), JSON.stringify(na));
  const nt = await namesIn(tg?.id);
  ok('the task group lists the tasks\' titles, never their slugs', nt.join('|') === TASKS.map(([, n]) => n).join('|'), JSON.stringify(nt));
  const allNames = (await page.locator('.super-tile-member').allInnerTexts()).join('|');
  ok('no group lists a path', !/[\\/]/.test(allNames.replace(/Sonra: /g, '')), allNames);
  // The group's name reads whole on two lines, and the tile still holds every row it draws.
  const fit = await page.locator(`[data-testid="super-group"][data-group-id="${tg?.id}"]`).evaluate((card) => {
    const name = card.querySelector('.super-tile-name');
    const body = card.querySelector('.super-card-clip').getBoundingClientRect();
    const rows = [...card.querySelectorAll('.super-tile-members li')].map((li) => li.getBoundingClientRect().bottom);
    return { text: name.textContent, lines: name.getClientRects().length && Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)), clipped: name.scrollHeight > name.clientHeight + 1, rows: rows.length, overflow: Math.max(0, ...rows.map((b) => b - body.bottom)) };
  });
  ok(`the "${TASK_GROUP}" tile shows its whole name on two lines`, fit.text === TASK_GROUP && fit.lines === 2 && !fit.clipped, JSON.stringify(fit));
  ok('…and every member row it lists sits inside the tile', fit.rows >= 1 && fit.overflow <= 0.5, JSON.stringify(fit));

  console.log('\n── the stage tidies itself (idle bar 20 s for the check)');
  // The owner opens the "after" group now and then: touched, it stays.
  const openAfter = async () => {
    await page.locator(`[data-testid="super-group"][data-group-id="${ga.id}"]`).click();
    await until(page, async () => (await page.locator('[data-testid="super-group-panel"]:visible').count()) > 0, 4000);
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  };
  await openAfter();
  const tidied = await until(page, async () => {
    const r = record();
    return ['before', TASK_GROUP].every((n) => r.groups.find((g) => g.name === n)?.place === 'others');
  }, 40000);
  const r2 = record();
  ok(`what nobody touched went to Others ("before", "${TASK_GROUP}")`, tidied, JSON.stringify(r2.groups.map((g) => [g.name, g.place])));
  ok('…the group the owner opened is still on the stage', r2.groups.find((g) => g.id === ga.id)?.place === 'float', JSON.stringify(r2.groups.map((g) => [g.name, g.place])));
  ok('…and nothing was closed', [...BEFORE, ...AFTER].every((ref) => r2.containers.some((c) => c.ref === ref)) && TASKS.every(([slug]) => r2.containers.some((c) => c.ref === slug)));
  await settle(page);
  await page.waitForTimeout(1500);
  const left = await page.locator('[data-testid="super-group"]:visible').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')));
  ok('the stage draws only the group in use', left.length === 1 && left[0] === ga.id, JSON.stringify(left));
  await page.screenshot({ path: join(OUT, '2-tidied-1440.png') });

  console.log('\n── pictures follow their job (grace 3 s for the check)');
  const say = async (text) => {
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill(text);
    await page.keyboard.press('Enter');
  };
  await say('JOB-PICS');
  ok('the super delegated a child and showed its designs for it', await until(page, async () => {
    const r = readNd(REPORTS).find((x) => x.kind === 'job-pics');
    return !!r && [...JOB_PICS, ...NO_JOB].every((ref) => idOf(ref));
  }, 60000), JSON.stringify(readNd(REPORTS).find((x) => x.kind === 'job-pics')?.steps));
  const jp = readNd(REPORTS).find((x) => x.kind === 'job-pics');
  ok('…every call succeeded', jp && jp.child && jp.steps.every((s) => s.status === 0), JSON.stringify(jp?.steps));
  const r3 = record();
  const groupOfRef = (r, ref) => r.groups.find((g) => g.cards.includes(r.containers.find((c) => c.ref === ref)?.id));
  const gj = groupOfRef(r3, JOB_PICS[0]);
  const gn = groupOfRef(r3, NO_JOB[0]);
  ok('the designs are one group linked to the child\'s job; the other two one group for no job',
    gj && gn && gj.id !== gn.id && JOB_PICS.every((ref) => r3.containers.find((c) => c.ref === ref)?.forChild === jp?.child)
      && NO_JOB.every((ref) => !r3.containers.find((c) => c.ref === ref)?.forChild),
    JSON.stringify({ gj, gn, links: r3.containers.filter((c) => c.kind === 'image').map((c) => [c.ref, c.forChild ?? null]) }));
  await settle(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, '3-job-shown-1440.png') });
  // Both groups' idle clocks start again with a look of the owner's (before the move it keeps
  // nothing): the idle bar cannot be what moves the designs.
  for (const g of [gj, gn]) {
    await page.locator(`[data-testid="super-group"][data-group-id="${g?.id}"]`).click();
    await until(page, async () => (await page.locator('[data-testid="super-group-panel"]:visible').count()) > 0, 4000);
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1500);
  const lookedAt = Date.now();
  const sentAt = Date.now();
  await say(`JOB-SEND ${jp?.child}`);
  const moved = await until(page, async () => record().groups.find((g) => g.id === gj?.id)?.place === 'others', IDLE_MS - 5000);
  const movedAfter = Date.now() - lookedAt;
  const r4 = record();
  ok('the send reached the child', readNd(REPORTS).find((x) => x.kind === 'job-send')?.steps?.[0]?.status === 0, JSON.stringify(readNd(REPORTS).find((x) => x.kind === 'job-send')));
  ok('once the child is sent new work, its designs go to Others within seconds (well before the idle bar)', moved && movedAfter < IDLE_MS - 3000,
    JSON.stringify({ took: Date.now() - sentAt, movedAfter, groups: r4.groups.map((g) => [g.name, g.place]) }));
  ok('…the pictures shown for no job at the same moment stay on the stage', r4.groups.find((g) => g.id === gn?.id)?.place === 'float', JSON.stringify(r4.groups.map((g) => [g.name, g.place])));
  ok('…and nothing was closed', [...JOB_PICS, ...NO_JOB].every((ref) => r4.containers.some((c) => c.ref === ref)));
  await settle(page);
  await page.waitForTimeout(800);
  const drawn = await page.locator('[data-testid="super-group"]:visible').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')));
  ok('the stage draws the no-job group, not the turned-down designs', drawn.includes(gn?.id) && !drawn.includes(gj?.id), JSON.stringify(drawn));
  await page.screenshot({ path: join(OUT, '4-job-moved-1440.png') });
  // The same moment at phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.waitForTimeout(1200);
  const narrow = await page.locator('[data-testid="super-group"]:visible').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')));
  ok('at phone width the turned-down designs are not drawn either', !narrow.includes(gj?.id) && record().groups.find((g) => g.id === gj?.id)?.place === 'others', JSON.stringify(narrow));
  await page.screenshot({ path: join(OUT, '5-job-moved-390.png') });
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
