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
 * straight into that view.
 *
 * Every kind of group (owner 2026-10-28: "files too, everything"): the Super then opens a PDF
 * group, a file group (project HTML files), a task group and a mixed group (picture, PDF, file,
 * task). Each opens whole through another way in (the panel's "Open all", a double-click, the
 * tile's hover button, `super present <group>`), every card drawn with its content, side by side,
 * and comes back to its group. Screenshots: tmp/super-group-present/. Exit 0 iff all pass.
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
// The other kinds (fictional "Pocket Ledger" files and tasks).
const PDFS = ['docs/spec.pdf', 'docs/terms.pdf'];
// A file card is a `web` card on a project file the reader draws (.html; .pdf and pictures have their own kinds).
const FILES = ['docs/report.html', 'docs/pricing.html', 'docs/notes.html'];
const TASKS = ['ledger-export', 'ledger-import'];
const MIXED = { image: 'shots/mixed.png', pdf: 'docs/mixed.pdf', web: 'docs/mixed.html', task: 'ledger-audit' };
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');

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
  if (text.includes('OPEN-KINDS')) {
    const steps = [
      cli('super', 'open', 'pdf', ${PDFS.map((r) => JSON.stringify(r)).join(', ')}),
      cli('super', 'open', 'web', ${FILES.map((r) => JSON.stringify(r)).join(', ')}, '--group', 'Ledger files'),
      cli('super', 'open', 'task', ${TASKS.map((r) => JSON.stringify(r)).join(', ')}, '--group', 'Ledger tasks'),
      cli('super', 'open', 'image', ${JSON.stringify(MIXED.image)}, '--no-group'),
      cli('super', 'open', 'pdf', ${JSON.stringify(MIXED.pdf)}, '--no-group'),
      cli('super', 'open', 'web', ${JSON.stringify(MIXED.web)}),
      cli('super', 'open', 'task', ${JSON.stringify(MIXED.task)}),
    ];
    const rec = JSON.parse(readFileSync(${JSON.stringify(RECORD)}, 'utf-8'));
    const ids = ${JSON.stringify(Object.values(MIXED))}.map((ref) => rec.containers.find((c) => c.ref === ref || c.ref.endsWith('/' + ref))?.id).filter(Boolean);
    steps.push(cli('super', 'group', ...ids, '--name', 'Ledger mixed'));
    report({ kind: 'kinds', steps });
    return 'opened every kind';
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
    try { said = role === 'super' ? superTurn(blocks.find((b) => /\\[super handover\\]|PRESENT-GROUP|OPEN-KINDS/.test(b)) ?? blocks[0] ?? '') : 'ok'; } catch (e) { said = 'error ' + e; }
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
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'shots'), join(PROJ, 'docs'), join(PROJ, 'src'), OUT]) mkdirSync(d, { recursive: true });
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
  const m = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1200x800', '-frames:v', '1', join(PROJ, MIXED.image)], { encoding: 'utf-8' });
  if (m.status !== 0) throw new Error(`ffmpeg failed: ${m.stderr}`);
  [...PDFS, MIXED.pdf].forEach((rel, i) => writeFileSync(join(PROJ, rel), onePagePdf(['Pocket Ledger spec', 'Pocket Ledger terms', 'Pocket Ledger invoice'][i])));
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>\n`;
  writeFileSync(join(PROJ, FILES[0]), page('Ledger report', 'October closed at 4,210 EUR across cash and card.'));
  writeFileSync(join(PROJ, FILES[1]), page('Ledger pricing', 'Free for one account, 3 EUR a month for more.'));
  writeFileSync(join(PROJ, FILES[2]), page('Ledger notes', 'Export the month as CSV, then import it back.'));
  writeFileSync(join(PROJ, MIXED.web), page('Mixed notes', 'One picture, one PDF, one file and one task, seen together.'));
  for (const [slug, why] of [[TASKS[0], 'Export the month as CSV'], [TASKS[1], 'Import a CSV back'], [MIXED.task, 'Audit the totals']]) {
    const t = spawnSync(process.execPath, [CLI, 'tasks', 'create', slug, '-d', why, '-w', why], { cwd: PROJ, env: env(), encoding: 'utf-8' });
    if (t.status !== 0) throw new Error(`tasks create failed: ${t.stderr || t.stdout}`);
  }
}

/** A one-page PDF with one line of text (a valid xref, so every viewer opens it). */
function onePagePdf(text) {
  const content = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
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

  /** A line to the Super Agent through its own composer. */
  const say = async (text) => {
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill(text);
    await page.keyboard.press('Enter');
  };

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
  await say(`PRESENT-GROUP ${g.id}`);
  ok('`super present <group>` succeeded', await until(page, async () => readNd(REPORTS).find((r) => r.kind === 'present')?.steps?.[0]?.status === 0, 60000),
    JSON.stringify(readNd(REPORTS).find((r) => r.kind === 'present')));
  await checkAll('super present');
  await page.screenshot({ path: join(OUT, '5-super-present-1440.png') });
  await backToGroup('super present');

  // ── Every kind of group ────────────────────────────────────────────────────────────────
  await page.keyboard.press('Escape');
  await settle(page);
  console.log('\n── the Super opens a PDF, a file, a task and a mixed group');
  await say('OPEN-KINDS');
  const kindsDone = await until(page, async () => !!readNd(REPORTS).find((r) => r.kind === 'kinds'), 60000);
  const kinds = readNd(REPORTS).find((r) => r.kind === 'kinds');
  ok('every open and the mixed `super group` succeeded', kindsDone && kinds.steps.every((x) => x.status === 0), JSON.stringify(kinds?.steps?.filter((x) => x.status !== 0)));
  const kindOf = (id) => record().containers.find((c) => c.id === id)?.kind;
  const groupWith = (pred) => record().groups.find((x) => pred(x.cards.map(kindOf)));
  const GROUPS = [
    { label: 'PDF group', way: 'super present', n: 2, kinds: ['pdf'], find: () => groupWith((ks) => ks.length === 2 && ks.every((k) => k === 'pdf')) },
    { label: 'file group', way: 'open all', n: 3, kinds: ['web'], find: () => record().groups.find((x) => x.name === 'Ledger files') },
    { label: 'task group', way: 'tile button', n: 2, kinds: ['task'], find: () => record().groups.find((x) => x.name === 'Ledger tasks') },
    { label: 'mixed group', way: 'double-click', n: 4, kinds: ['image', 'pdf', 'web', 'task'], find: () => record().groups.find((x) => x.name === 'Ledger mixed') },
  ];
  ok('the four groups are on the record', await until(page, async () => GROUPS.every((x) => x.find()?.cards.length === x.n), 15000),
    JSON.stringify(record().groups.map((x) => ({ name: x.name, kinds: x.cards.map(kindOf) }))));
  await settle(page);
  await page.screenshot({ path: join(OUT, '6-every-kind-on-stage-1440.png') });

  // A presented card shows its content: a picture loaded, a PDF page drawn, a file's or a task's text.
  const cardsOf = (grp) => page.locator('[data-testid="super-container"]:visible').evaluateAll((els, ids) => els
    .filter((e) => ids.includes(e.getAttribute('data-container-id')))
    .map((e) => {
      const r = e.getBoundingClientRect();
      const img = e.querySelector('img');
      const media = [...e.querySelectorAll('img, canvas, iframe, embed, object, video')].map((m) => m.getBoundingClientRect()).filter((m) => m.width > 40 && m.height > 40).length;
      const text = (e.querySelector('.super-card-view, .super-card-body')?.innerText ?? '').trim().length;
      return { id: e.getAttribute('data-container-id'), where: e.getAttribute('data-where'), x: r.x, y: r.y, w: r.width, h: r.height,
        img: img ? img.complete && img.naturalWidth > 0 : null, media, text };
    }), grp.cards);
  const hasContent = (c) => c.media > 0 || c.text > 10;
  for (const spec of GROUPS) {
    const grp = spec.find();
    console.log(`\n── ${spec.label} (${spec.kinds.join(', ')}) through ${spec.way}`);
    const gTile = page.locator(`[data-testid="super-group"][data-group-id="${grp.id}"]`);
    ok(`${spec.label}: the stage draws its tile`, await until(page, async () => (await gTile.count()) === 1 && await gTile.isVisible(), 8000));
    if (spec.way === 'open all') {
      await gTile.click();
      await until(page, async () => (await page.locator('[data-testid="super-group-panel"]:visible').count()) === 1, 4000);
      await settle(page);
      await page.locator('[data-testid="super-group-panel-open-all"]:visible').click();
    } else if (spec.way === 'double-click') {
      await gTile.dblclick();
    } else if (spec.way === 'tile button') {
      await gTile.hover();
      await page.locator(`[data-testid="super-group"][data-group-id="${grp.id}"] [data-testid="super-group-open-all"]`).click({ force: true });
    } else {
      await say(`PRESENT-GROUP ${grp.id}`);
      ok(`${spec.label}: \`super present <group>\` succeeded`, await until(page, async () => readNd(REPORTS).filter((r) => r.kind === 'present').at(-1)?.steps?.[0]?.args?.includes(grp.id)
        && readNd(REPORTS).filter((r) => r.kind === 'present').at(-1).steps[0].status === 0, 60000));
    }
    let cards = [];
    await until(page, async () => {
      const v = record().view;
      if (v?.mode !== 'present' || (v.cards ?? []).length !== spec.n) return false;
      cards = await cardsOf(grp);
      return cards.length === spec.n && cards.every(hasContent);
    }, 20000);
    await settle(page);
    cards = await cardsOf(grp);
    const overlap = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
    ok(`${spec.label}: all ${spec.n} cards are presented at once, in the layout their count picks`,
      cards.length === spec.n && cards.every((c) => c.where === 'present') && record().view?.layout === (spec.n === 2 ? 'compare' : 'grid'),
      JSON.stringify({ view: record().view, cards }));
    ok(`${spec.label}: …each shows its content, side by side, none covering another, each readable`,
      cards.length === spec.n && cards.every(hasContent) && cards.every((c) => c.img !== false) && !cards.some((a, i) => cards.some((b, j) => i < j && overlap(a, b)))
      && cards.every((c) => c.w >= 280 && c.h >= 200), JSON.stringify(cards));
    ok(`${spec.label}: …and the way back says "Back to the group"`, (await page.locator('[data-testid="super-stage-exit"][data-to-group="true"]:visible').innerText().catch(() => '')).trim() === 'Back to the group');
    await page.screenshot({ path: join(OUT, `7-${spec.label.replace(/ /g, '-')}-all-1440.png`) });
    if (spec.way === 'double-click') {
      await page.locator('[data-testid="super-surface"]').click({ position: { x: 5, y: 450 } }).catch(() => {});
      await page.keyboard.press('Escape');
    } else {
      await page.locator('[data-testid="super-stage-exit"]:visible').click();
    }
    ok(`${spec.label}: one action leaves the presentation and reopens the group`, await until(page, async () => record().view?.mode === 'float'
      && (await page.locator('[data-testid="super-group-panel"]:visible').count()) === 1, 8000), JSON.stringify(record().view));
    await settle(page);
    const items = await page.locator('[data-testid="super-group-panel"] [data-testid="super-group-item"]').count();
    ok(`${spec.label}: …its panel lists the ${spec.n} cards; the group is unchanged`, items === spec.n && record().groups.find((x) => x.id === grp.id)?.cards.length === spec.n, String(items));
    await page.keyboard.press('Escape');
    await until(page, async () => (await page.locator('[data-testid="super-group-panel"]:visible').count()) === 0, 4000);
    await settle(page);
  }

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
