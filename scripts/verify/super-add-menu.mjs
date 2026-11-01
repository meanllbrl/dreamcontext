#!/usr/bin/env node
/**
 * The owner opens a card on the Super stage himself (task sahip-super-sahnesinde-sag-tik-veya-ekle-…,
 * owner 2026-10-31: the whiteboard's right-click add menu, on the stage).
 *
 *   npm run build && node scripts/verify/super-add-menu.mjs
 *
 * WHAT IT DRIVES: the real dashboard server on a scratch HOME (DREAMCONTEXT_DESKTOP=1), the real
 * dashboard in Chromium, and a scripted stand-in `claude` that, as the Super Agent, runs the CLI
 * verbs this script drops in a file (no tokens spent). Everything is fictional ("Pocket Ledger").
 * Chromium has no native picker, so the picker runs on a stand-in `__TAURI_INTERNALS__.invoke`.
 *
 * WHAT IT PROVES: at 1440 and 1000 px, in the floating, side-by-side and presented views, each of
 * the six items really opens its card, with no place and no owner stamp in the record, a 13th card
 * is refused with the reason in the menu, and a card landing in Others says so; the menu keeps to
 * the stage, Escape closes only the menu, an outside click and a click on a page close it, `+ Add`
 * works by keyboard; the right click is the stage's only on its empty floor; the file stage lists
 * files past 60 knowledge pages, every refusal reads in the menu, and a pending picker holds the
 * menu open; a card opens with no state frame on the socket. Screenshots in light and dark:
 * tmp/super-add-menu/. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-add-menu-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-add-menu');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const ORDERS = join(SCRATCH, 'orders.ndjson');
const WEB = 'https://pocket-ledger.example';

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
// It answers every turn and, as the Super Agent, runs whatever this script appends to ORDERS.
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
if (role === 'super') {
  // A restarted chat carries on where the last one stopped: an order runs once.
  let done = existsSync(${JSON.stringify(REPORTS)}) ? readFileSync(${JSON.stringify(REPORTS)}, 'utf-8').trim().split('\\n').filter(Boolean).length : 0;
  setInterval(() => {
    if (!existsSync(${JSON.stringify(ORDERS)})) return;
    const rows = readFileSync(${JSON.stringify(ORDERS)}, 'utf-8').trim().split('\\n').filter(Boolean);
    for (; done < rows.length; done += 1) {
      const { seq, args } = JSON.parse(rows[done]);
      appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ seq, ...cli(...args) }) + '\\n');
    }
  }, 120);
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});



async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const record = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return { containers: [] }; } };
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


function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), join(PROJ, '_dream_context', 'knowledge'), join(PROJ, 'pics'), join(PROJ, 'clips'), join(PROJ, 'docs', 'folder'), join(SCRATCH, 'elsewhere'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const must = (what, r) => { if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`); };
  must('vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'pocket-ledger', PROJ], { env: env(), encoding: 'utf-8' }));
  must('task', dc('tasks', 'create', 'Ship the share sheet', '-w', 'Sharing a ledger takes four taps today.'));
  must('insight', dc('lab', 'create', 'weekly-signups', '--title', 'Weekly signups', '--render', 'number', '--adapter', 'script', '--unit', 'users'));
  must('whiteboard', dc('whiteboard', 'create', 'share-flow'));
  // More knowledge pages than one page of results: the file stage must still list the files.
  for (let i = 0; i < 70; i += 1) writeFileSync(join(PROJ, '_dream_context', 'knowledge', `note-${String(i).padStart(2, '0')}.md`), `---\nname: Ledger note ${i}\n---\nA note.\n`);
  mkdirSync(join(PROJ, '_dream_context', 'knowledge', 'archive'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'knowledge', 'archive', '2.memory-2026-08.md'), '---\nname: August memory\n---\nOld.\n');
  for (const f of ['docs/report.html', 'docs/plan.html', 'docs/notes.md', 'docs/with space.html']) writeFileSync(join(PROJ, f), '<!doctype html><title>Pocket Ledger</title><h1>Pocket Ledger</h1>');
  writeFileSync(join(PROJ, 'docs', 'spec.pdf'), '%PDF-1.4\n%%EOF\n');
  copyFileSync(join(REPO, 'public', 'image', 'diagram-recall.png'), join(PROJ, 'pics', 'first.png'));
  copyFileSync(join(REPO, 'public', 'image', 'diagram-recall.png'), join(PROJ, 'pics', 'second.png'));
  writeFileSync(join(PROJ, 'clips', 'demo.mp4'), 'not really a clip');
  writeFileSync(join(SCRATCH, 'elsewhere', 'secret.html'), '<h1>outside</h1>');
  symlinkSync(join(SCRATCH, 'elsewhere', 'secret.html'), join(PROJ, 'docs', 'escape.html'));
}

let seq = 0;
/** Run CLI verbs as the Super Agent (the stand-in), in order, and wait for their answers. */
async function asSuper(...orders) {
  for (const args of orders) {
    seq += 1;
    appendFileSync(ORDERS, `${JSON.stringify({ seq, args })}\n`);
    const end = Date.now() + 90_000;
    let row;
    while (!row && Date.now() < end) { row = readNd(REPORTS).find((r) => r.seq === seq); if (!row) await sleep(60); }
    if (!row) throw new Error(`no answer to: ${args.join(' ')}`);
    if (row.status !== 0) throw new Error(`failed: ${row.args}\n${row.out}`);
  }
}
const floats = () => record().containers.filter((c) => c.place === 'float' && !c.min);

const stage = (page) => page.locator('[data-testid="super-surface"]:visible').first();
const menu = (page) => page.locator('[data-testid="super-add-menu"]');
const addBtn = (page) => page.locator('[data-testid="super-add-btn"]:visible');
const isMenu = async (page) => (await menu(page).count()) > 0;

/** A point of the stage whose own floor is on top: where the right click belongs to the stage. */
const floorPoint = (page) => page.evaluate(() => {
  const root = [...document.querySelectorAll('[data-testid="super-surface"]')].find((e) => e.getBoundingClientRect().width > 0);
  const b = root.getBoundingClientRect();
  for (let y = b.bottom - 12; y > b.top + 8; y -= 24) {
    for (let x = b.left + 10; x < b.right - 8; x += 24) {
      if (document.elementFromPoint(x, y) === root) return { x, y };
    }
  }
  return null;
});

async function openByRightClick(page) {
  const p = await floorPoint(page);
  if (!p) throw new Error('no empty floor on this stage');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await until(page, () => isMenu(page), 3000);
  return p;
}

async function openMenu(page) {
  if (await addBtn(page).count()) await addBtn(page).click();
  else await openByRightClick(page);
  await until(page, () => isMenu(page), 3000);
}

const ITEMS = {
  task: { pick: async (page) => page.locator('.wb-picker-row', { hasText: 'Ship the share sheet' }).first().click(), ref: 'ship-the-share-sheet' },
  knowledge: { pick: async (page) => { await page.locator('.super-add-menu .wb-picker-search').fill('Ledger note 7'); await page.waitForTimeout(400); await page.locator('.wb-picker-row[data-page-ref="note-07"]').click(); }, ref: 'note-07' },
  insight: { pick: async (page) => page.locator('.wb-picker-row', { hasText: 'Weekly signups' }).first().click(), ref: 'weekly-signups' },
  whiteboard: { pick: async (page) => page.locator('.wb-picker-row', { hasText: /share-flow/i }).first().click(), ref: 'share-flow' },
  file: { pick: async (page) => page.locator('.wb-picker-row[data-page-ref="docs/report.html"]').click(), ref: 'docs/report.html' },
  web: { pick: async (page) => { await page.locator('.super-add-menu .wb-picker-search').fill(`${WEB}/plans`); await page.keyboard.press('Enter'); }, ref: `${WEB}/plans` },
};

/** One item of the menu, really opened: the card lands with no place and no owner stamp. */
async function addItem(page, name) {
  await openMenu(page);
  await page.locator(`[data-testid="super-add-${name}"]`).click();
  await ITEMS[name].pick(page);
  const closed = await until(page, async () => !(await isMenu(page)), 6000);
  const card = await (async () => { const end = Date.now() + 4000; let k; while (!k && Date.now() < end) { k = record().containers.find((c) => c.ref === ITEMS[name].ref); if (!k) await sleep(80); } return k; })();
  return { closed, card, clean: !!card && !('pos' in card) && !('sizeBy' in card) };
}

async function clearStage(page) {
  for (const c of record().containers) if (c.kind !== 'agenda') await asSuper(['super', 'close', c.id]).catch((e) => { if (!/unknown_container/.test(e.message)) throw e; });
  if (record().view?.mode !== 'float') await asSuper(['super', record().view.mode === 'present' ? 'present' : 'half', '--off']);
  await settle(page);
}

async function setLayout(page, layout) {
  await clearStage(page);
  if (layout === 'half') await asSuper(['super', 'open', 'web', `${WEB}/shown`]);
  if (layout === 'present') {
    await asSuper(['super', 'open', 'task', 'shown-one', 'shown-two']);
    await asSuper(['super', 'present', ...record().containers.filter((c) => c.ref.startsWith('shown-')).map((c) => c.id)]);
  }
  await settle(page);
}

async function theme(page, name) {
  await page.emulateMedia({ colorScheme: name });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), name);
}

/** A native picker that answers what this script says next (and never touches the Mac's). */
const fakePicker = (page) => page.evaluate(() => {
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd) => {
      if (cmd !== 'pick_paths') return null;
      const next = window.__nextPick;
      if (next === 'hold') return new Promise((resolve) => { window.__release = resolve; });
      if (next === 'fail') throw new Error('no panel');
      return next;
    },
    transformCallback: () => 0,
  };
});
const pickNext = (page, value) => page.evaluate((v) => { window.__nextPick = v; }, value);

const shot = async (page, name) => { await page.waitForTimeout(500); await page.screenshot({ path: join(OUT, `${name}.png`) }); };
const noteOf = (page) => page.locator('[data-testid="super-add-note"]').getAttribute('data-note', { timeout: 300 }).catch(() => null);
/** Every card's place on the stage, to tell whether a key moved anything. */
const cardRects = (page) => page.locator('[data-testid="super-container"]').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return [e.dataset.containerId, Math.round(b.x), Math.round(b.y), Math.round(b.width)]; }));

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  // The stand-in's pages, and a switch that drops the Super chat's state frames (no socket push).
  await context.route(`${WEB}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Plans</title><h1>Pocket Ledger plans</h1>' }));
  let dropFrames = false;
  let dropped = 0;
  await context.routeWebSocket(/\/api\/agent\/chat/, (ws) => {
    const server2 = ws.connectToServer();
    ws.onMessage((m) => server2.send(m));
    server2.onMessage((m) => {
      if (dropFrames && String(m).includes('super_state')) { dropped += 1; return; }
      ws.send(m);
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  lastPage = page;
  const errors = [];
  // A refusal is an answer, not a fault: the browser logs each 4xx, and the picker logs its failure.
  // So is the 404 of a task card whose ref this script made up to fill the stage.
  const expected = (m) => /\/api\/super\/open|\/api\/agent\/pick-paths|\/api\/(tasks\/|graph\/content\?path=state%2F)(a-card|shown-|fill-|strip-)/.test(m.location().url ?? '') || /^\[picker\]/.test(m.text());
  page.on('console', (m) => { if (m.type() === 'error' && !expected(m)) errors.push(`${m.text()} @ ${m.location().url}`); });
  page.on('pageerror', (e) => errors.push(String(e)));
  // Which API calls are still open when a list waits: a list stuck on Loading is explained by them.
  const open = new Map();
  page.on('request', (r) => { if (r.url().includes('/api/')) open.set(r, Date.now()); });
  let firstPages = true;
  const settled = (r) => {
    if (firstPages && r.url().includes('/whiteboards/pages')) {
      firstPages = false;
      const t = r.timing();
      console.log(`  · first page list: ${Date.now() - open.get(r)} ms in all, connect ${Math.round(t.connectEnd - t.connectStart)} ms, answer ${Math.round(t.responseStart - t.requestStart)} ms`);
    }
    open.delete(r);
  };
  page.on('requestfinished', settled);
  page.on('requestfailed', settled);
  const openCalls = () => [...open].map(([r, at]) => `${Math.round((Date.now() - at) / 1000)}s ${r.method()} ${r.url().replace(base, '')}`).join('\n');

  console.log('\n── hand over');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  await settle(page);
  await asSuper(['super', 'state']);
  await page.waitForTimeout(1500);

  /** One part of the run: a crash in it is a failure, and the parts after it still run. */
  const part = async (name, fn) => {
    console.log(`\n── ${name}`);
    try { await fn(); } catch (e) {
      ok(`${name} ran to its end`, false, e?.stack || e);
      await page.screenshot({ path: join(OUT, `crash-${name.replace(/\W+/g, '-').slice(0, 40)}.png`) }).catch(() => {});
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('Escape').catch(() => {});
    }
  };

  await part('AC1: the right click belongs to the stage only on its floor', async () => {
  await page.evaluate(() => { window.__prevented = []; document.addEventListener('contextmenu', (e) => { window.__prevented.push([e.target.className || e.target.tagName, e.defaultPrevented]); }); });
  const p0 = await openByRightClick(page);
  ok('a right click on the empty floor opens the menu', await isMenu(page));
  const labels = await page.locator('[data-testid="super-add-menu"] .wb-palette-item').allInnerTexts();
  ok('with its six items, in order', JSON.stringify(labels) === JSON.stringify(['Web page…', 'File…', 'Knowledge page…', 'Task…', 'Insight…', 'Whiteboard…']), JSON.stringify(labels));
  const placed = await menu(page).boundingBox();
  const root0 = await stage(page).boundingBox();
  ok('the menu opens at the press, inside the stage', Math.abs(placed.x + placed.width / 2 - p0.x) < placed.width && placed.y + placed.height <= root0.y + root0.height && placed.x + placed.width <= root0.x + root0.width, JSON.stringify({ placed, p0 }));
  await page.mouse.click(root0.x + 8, root0.y + 8);
  ok('an outside click closes it', await until(page, async () => !(await isMenu(page)), 2000));
  await addBtn(page).click();
  const fromBtn = await page.locator('[data-testid="super-add-menu"] .wb-palette-item').allInnerTexts();
  ok('`+ Add` opens the same menu', JSON.stringify(fromBtn) === JSON.stringify(labels));
  await addBtn(page).click();
  ok('a second press closes it', await until(page, async () => !(await isMenu(page)), 2000));
  await page.evaluate(() => { window.__prevented = []; });
  for (const sel of ['[data-testid="super-centre"]']) {
    const b = await page.locator(sel).first().boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
    await page.waitForTimeout(200);
    ok(`a right click over ${sel} opens nothing and keeps the page's own menu`, !(await isMenu(page)) && (await page.evaluate(() => window.__prevented.every(([, p]) => !p))), JSON.stringify(await page.evaluate(() => window.__prevented)));
  }
  await asSuper(['super', 'open', 'task', 'a-card', 'a-stacked']);
  await asSuper(['super', 'stack', record().containers.find((c) => c.ref === 'a-stacked').id]);
  await settle(page);
  for (const [what, sel] of [['the agenda', '[data-testid="super-container"][data-kind="agenda"], [data-container-id^="agenda"]'], ['Others', '.super-others']]) {
    const box = await page.locator(sel).first().boundingBox();
    await page.evaluate(() => { window.__prevented = []; });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.waitForTimeout(200);
    ok(`a right click over ${what} opens nothing`, !(await isMenu(page)) && (await page.evaluate(() => window.__prevented.every(([, p]) => !p))));
  }
  const cardBox = await page.locator('[data-testid="super-container"]').last().boundingBox();
  await page.evaluate(() => { window.__prevented = []; });
  await page.mouse.click(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2, { button: 'right' });
  await page.waitForTimeout(200);
  ok('a right click over a card opens nothing', !(await isMenu(page)) && (await page.evaluate(() => window.__prevented.every(([, p]) => !p))));
  });

  await part('AC7: keys and focus', async () => {
  await addBtn(page).focus();
  await page.keyboard.press('Enter');
  ok('`+ Add` opens by keyboard, focus in the menu', await until(page, async () => isMenu(page), 2000) && await page.evaluate(() => !!document.activeElement?.closest('.super-add-menu')));
  await page.keyboard.press('Escape');
  ok('Escape closes the menu and focus returns to `+ Add`', await until(page, async () => !(await isMenu(page)), 2000) && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'super-add-btn');
  ok('…and the surface stays open', (await page.locator('[data-testid="super-surface"]:visible').count()) > 0);
  await addBtn(page).click();
  await page.locator('[data-testid="super-add-web"]').click();
  await page.locator('.super-add-menu .wb-picker-search').fill('https://half-typed');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(200);
  ok('leaving for another app keeps the menu and what was typed', (await isMenu(page)) && (await page.locator('.super-add-menu .wb-picker-search').inputValue()) === 'https://half-typed');
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="super-add-task"]').click();
  await page.keyboard.press('Escape');
  ok('Escape in a stage goes back to the menu', (await isMenu(page)) && (await menu(page).getAttribute('data-stage')) === 'menu');
  await page.keyboard.press('Escape');
  ok('…and a second one closes it', await until(page, async () => !(await isMenu(page)), 2000));
  });

  await part('the file stage', async () => {
  const root0 = await stage(page).boundingBox();
  await addBtn(page).click();
  await page.locator('[data-testid="super-add-file"]').click();
  await page.locator('.super-add-menu .wb-picker-row').first().waitFor().catch((e) => { throw new Error(`${e.message}\nopen calls:\n${openCalls()}`); });
  const fileRows = await page.locator('.super-add-menu .wb-picker-row').evaluateAll((r) => r.map((e) => e.dataset.pageRef));
  ok('past 60 knowledge pages it lists only .html and .pdf files', fileRows.includes('docs/report.html') && fileRows.includes('docs/spec.pdf') && fileRows.every((f) => /\.(html|pdf)$/.test(f)), JSON.stringify(fileRows));
  await shot(page, 'file-stage-1440');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await fakePicker(page);
  const refusals = [
    ['outside the project', join(SCRATCH, 'elsewhere', 'secret.html'), /outside the project/],
    ['a symlink out of it', join(PROJ, 'docs', 'escape.html'), /outside the project/],
    ['a plain .md', join(PROJ, 'docs', 'notes.md'), /no card/],
    ['an .html with a space', join(PROJ, 'docs', 'with space.html'), /space in its name/],
    ['a folder', join(PROJ, 'docs', 'folder'), /not a file/],
    ['a file that is gone', join(PROJ, 'docs', 'gone.pdf'), /could not be found/],
  ];
  await addBtn(page).click();
  await page.locator('[data-testid="super-add-file"]').click();
  const count0 = record().containers.length;
  for (const [what, path, want] of refusals) {
    await pickNext(page, [path]);
    await page.locator('[data-testid="super-add-pick"]').click();
    const said = await until(page, async () => want.test(await page.locator('[data-testid="super-add-error"]').innerText()), 4000);
    ok(`${what}: refused in the menu, with the reason`, said && (await isMenu(page)));
  }
  ok('…and none of them made a card', record().containers.length === count0);
  await shot(page, 'file-refused-1440');
  await pickNext(page, []);
  await page.locator('[data-testid="super-add-pick"]').click();
  await page.waitForTimeout(300);
  ok('a cancelled picker is silent and leaves the menu', (await isMenu(page)) && (await page.locator('[data-testid="super-add-error"]').count()) === 0);
  await page.route('**/api/agent/pick-paths', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"no"}' }));
  await pickNext(page, 'fail');
  await page.locator('[data-testid="super-add-pick"]').click();
  ok('a picker that cannot open says so in the menu', await until(page, async () => /file picker could not open/.test(await page.locator('[data-testid="super-add-error"]').innerText()), 4000));
  await pickNext(page, 'hold');
  await page.locator('[data-testid="super-add-pick"]').click();
  await page.waitForTimeout(200);
  await page.mouse.click(root0.x + 8, root0.y + 8);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(250);
  ok('a picker that is open holds the menu against a click outside and the window\'s blur', await isMenu(page));
  await addBtn(page).click();
  await page.waitForTimeout(200);
  ok('…and against a press on `+ Add`', await isMenu(page));
  ok('…and its button is disabled meanwhile', await page.locator('[data-testid="super-add-pick"]').isDisabled());
  await page.evaluate((p) => window.__release([p]), join(PROJ, 'pics', 'first.png'));
  ok('the picked picture opens its card and the menu closes', await until(page, async () => !(await isMenu(page)), 4000) && record().containers.some((c) => c.kind === 'image' && c.ref === 'pics/first.png'));
  await pickNext(page, [join(PROJ, 'clips', 'demo.mp4')]);
  await addBtn(page).click();
  await page.locator('[data-testid="super-add-file"]').click();
  await page.locator('[data-testid="super-add-pick"]').click();
  ok('the picked clip opens its card', await until(page, async () => record().containers.some((c) => c.kind === 'video' && c.ref === 'clips/demo.mp4'), 4000));
  });
  await page.unroute('**/api/agent/pick-paths').catch(() => {});

  await part('AC6: a picture joining a group in Others, a card in a group resting there', async () => {
  await setLayout(page, 'half');
  await pickNext(page, [join(PROJ, 'pics', 'first.png')]);
  await addBtn(page).click();
  await page.locator('[data-testid="super-add-file"]').click();
  await page.locator('[data-testid="super-add-pick"]').click();
  await until(page, async () => !(await isMenu(page)), 5000);
  await page.waitForTimeout(500);
  const before = await noteOf(page);
  await pickNext(page, [join(PROJ, 'pics', 'second.png')]);
  await addBtn(page).click();
  await page.locator('[data-testid="super-add-file"]').click();
  await page.locator('[data-testid="super-add-pick"]').click();
  await until(page, async () => !(await isMenu(page)), 5000);
  await page.waitForTimeout(500);
  const after = await noteOf(page);
  ok('the second picture joins its group, in Others beside a page, and the note says so', record().groups?.length === 1 && after !== null && after !== before, `${before} → ${after} ${JSON.stringify(record().groups)}`);
  await setLayout(page, 'float');
  await asSuper(['super', 'open', 'task', 'ship-the-share-sheet', 'grouped-b', '--group', 'Later']);
  await asSuper(['super', 'stack', record().groups.find((g) => g.name === 'Later').id]);
  await settle(page);
  const r = await addItem(page, 'task');
  await page.waitForTimeout(500);
  ok('a card reopened inside a group resting in Others says so too', r.closed && (await noteOf(page)) !== null);
  await clearStage(page);
  });
  await page.evaluate(() => { delete window.__TAURI_INTERNALS__; });

  await part('a knowledge page listed by its path', async () => {
  await openMenu(page);
  await page.locator('[data-testid="super-add-knowledge"]').click();
  await page.locator('.super-add-menu .wb-picker-search').fill('August memory');
  await page.locator('.wb-picker-row', { hasText: 'August memory' }).click();
  ok('it opens by its slug', await until(page, async () => record().containers.some((c) => c.kind === 'knowledge' && c.ref === 'archive/2.memory-2026-08'), 5000));
  await asSuper(['super', 'half', record().containers.find((c) => c.ref === 'archive/2.memory-2026-08').id]);
  await settle(page);
  ok('side by side, the card reads its page', await until(page, async () => (await stage(page).innerText()).includes('Old.'), 8000), (await stage(page).innerText()).slice(0, 300));
  await shot(page, 'knowledge-dotted-half');
  await clearStage(page);
  });

  await part('AC6: no socket, the card still draws', async () => {
  await clearStage(page);
  dropFrames = true;
  dropped = 0;
  const noSock = await addItem(page, 'task');
  await page.waitForTimeout(600);
  ok('with the state frames dropped the card is on the stage', noSock.closed && (await page.locator(`[data-testid="super-container"][data-container-id="${noSock.card?.id}"]`).count()) === 1, `dropped ${dropped}`);
  ok('…and frames really were dropped', dropped > 0, `dropped ${dropped}`);
  dropFrames = false;
  await asSuper(['super', 'stack', noSock.card.id]);
  await settle(page);
  const back = await addItem(page, 'task');
  await page.waitForTimeout(500);
  ok('a card back from Others on a floating stage shows no note', back.closed && record().containers.find((c) => c.id === noSock.card.id)?.place === 'float' && (await page.locator('[data-testid="super-add-note"]').count()) === 0);
  });
  dropFrames = false;

  for (const [w, h] of [[1440, 900], [1000, 760]]) {
    await page.setViewportSize({ width: w, height: h });
    await settle(page);
    if (w === 1000) {
      // Beside the open sidebar a 1000 px window leaves a phone-width stage: the chat alone, its
      // cards in Others, and `+ Add` in its head.
      await part('a phone-width stage beside the open sidebar', async () => {
        await clearStage(page);
        const wide = (await stage(page).boundingBox()).width;
        ok(`the stage is phone-width (${wide} px) and \`+ Add\` is there`, wide < 640 && (await addBtn(page).count()) === 1, String(wide));
        const before = await noteOf(page);
        const r = await addItem(page, 'task');
        await page.waitForTimeout(450);
        const now = await noteOf(page);
        ok('a card opens from it and the note says where it went', r.closed && r.clean && now !== null && now !== before, `${before} → ${now}`);
        await shot(page, 'note-1000-sidebar-open');
      });
      await page.locator('[data-testid="ns-drawer-toggle"]').click();
      await settle(page);
    }
    const narrow = (await stage(page).getAttribute('data-narrow')) === 'true';
    console.log(`\n── ${w} px (${(await stage(page).boundingBox()).width} stage${narrow ? ', narrow' : ''})`);
    for (const layout of ['float', 'half', 'present']) {
      await part(`${w} ${layout}`, async () => {
      await setLayout(page, layout);
      const shown = await stage(page).getAttribute('data-mode');
      ok(`${w} ${layout}: the stage is in that view`, (layout === 'float' ? shown === 'float' : shown === layout), shown);
      if (narrow && layout !== 'float') {
        ok(`${w} ${layout}: no \`+ Add\` under the page`, (await addBtn(page).count()) === 0);
        await openByRightClick(page);
        ok(`${w} ${layout}: the right click opens it from the side band`, await isMenu(page));
        await page.keyboard.press('Escape');
      }
      for (const name of ['dark', 'light']) {
        await theme(page, name);
        await openMenu(page);
        const b = await menu(page).boundingBox();
        const r = await stage(page).boundingBox();
        ok(`${w} ${layout} ${name}: the menu stays inside the stage`, b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width + 1 && b.y + b.height <= r.y + r.height + 1, JSON.stringify({ b, r }));
        await shot(page, `menu-${w}-${layout}-${name}`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
      }
      // Each item really opens in one theme per width, the refusal below is shot in both.
      await theme(page, w === 1440 ? 'dark' : 'light');
      for (const item of ['task', 'knowledge', 'insight', 'whiteboard', 'file', 'web']) {
        // A page opened on a floating stage takes it side by side: each page item starts over.
        if (layout === 'float' && (item === 'file' || item === 'web')) await setLayout(page, 'float');
        const noteBefore = await noteOf(page);
        const r = await addItem(page, item);
        ok(`${w} ${layout}: ${item} opens its card, with no place and no owner stamp`, r.closed && r.clean, JSON.stringify(r.card));
        await page.waitForTimeout(450);
        const inOthers = await page.evaluate((id) => !document.querySelector(`[data-testid="super-container"][data-container-id="${id}"]`), r.card?.id);
        const noteNow = await noteOf(page);
        const note = noteNow !== null && noteNow !== noteBefore;
        if (inOthers) ok(`${w} ${layout}: ${item} landed in Others and the note says so`, note, `${noteBefore} → ${noteNow}`);
        else ok(`${w} ${layout}: ${item} is on the stage and no note says otherwise`, !note, `${noteBefore} → ${noteNow}`);
        if (note && item === 'task') await shot(page, `note-${w}-${layout}`);
        await page.waitForTimeout(item === 'whiteboard' ? 600 : 100);
      }
      await shot(page, `cards-${w}-${layout}`);
      await setLayout(page, layout);
      const room = 12 - floats().length;
      if (room > 0) await asSuper(['super', 'open', 'task', ...Array.from({ length: room }, (_v, i) => `fill-${i}`)]);
      await settle(page);
      const before = record().containers.length;
      await openMenu(page);
      await page.locator('[data-testid="super-add-knowledge"]').click();
      await page.waitForTimeout(500);
      await page.locator('.wb-picker-row[data-page-ref]').first().click();
      const refused = await until(page, async () => /stage is full/.test(await page.locator('[data-testid="super-add-error"]').innerText()), 4000);
      ok(`${w} ${layout}: the 13th card is refused in the menu, nothing added`, refused && record().containers.length === before && (await isMenu(page)), `${before} → ${record().containers.length}`);
      for (const name of ['dark', 'light']) { await theme(page, name); await shot(page, `full-${w}-${layout}-${name}`); }
      await theme(page, 'dark');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      });
    }
  }

  await part('AC7: a presentation survives the menu', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await clearStage(page);
  await asSuper(['super', 'open', 'task', 'strip-a', 'strip-b', 'strip-c']);
  await asSuper(['super', 'present', '--layout', 'filmstrip', ...record().containers.filter((c) => c.ref.startsWith('strip-')).map((c) => c.id)]);
  await settle(page);
  await openByRightClick(page);
  const strip0 = JSON.stringify(await cardRects(page));
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  ok('with the menu open the arrows do not play the filmstrip', JSON.stringify(await cardRects(page)) === strip0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  ok('Escape closes the menu and the presentation goes on', !(await isMenu(page)) && record().view?.mode === 'present' && (await stage(page).getAttribute('data-mode')) === 'present');
  if (await addBtn(page).count()) {
    await addBtn(page).focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    ok('…and with the menu closed the same arrow plays it (the check above can fail)', JSON.stringify(await cardRects(page)) !== strip0);
  }
  });

  await part('AC7: a small window, a click on a page', async () => {
  await clearStage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page);
  await openByRightClick(page);
  await page.setViewportSize({ width: 820, height: 420 });
  await page.waitForTimeout(800);
  ok('the menu stays open as the window shrinks', await isMenu(page));
  const shrunk = await menu(page).boundingBox();
  const room = await stage(page).boundingBox();
  ok('…and inside the smaller stage', shrunk.x >= room.x && shrunk.y >= room.y && shrunk.x + shrunk.width <= room.x + room.width + 1 && shrunk.y + shrunk.height <= room.y + room.height + 1, JSON.stringify({ shrunk, room }));
  await shot(page, 'small-window');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await asSuper(['super', 'open', 'web', `${WEB}/framed`]);
  await settle(page);
  const load = page.locator('[data-testid="super-container"] button', { hasText: /^Load$/ }).first();
  if (await load.count()) { await load.click(); await page.waitForTimeout(800); }
  const frame = page.locator('[data-testid="super-container"] iframe').first();
  await page.waitForTimeout(800);
  if (await frame.count()) {
    const inFrame = await frame.boundingBox();
    await page.mouse.click(inFrame.x + inFrame.width / 2, inFrame.y + inFrame.height / 2, { button: 'right' });
    await page.waitForTimeout(200);
    ok('a right click over a page opens nothing', !(await isMenu(page)));
    await openMenu(page);
    const fb = await frame.boundingBox();
    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
    ok('a click on a web card\'s page closes the menu (Chromium)', await until(page, async () => !(await isMenu(page)), 2500));
  } else ok('a web card holds a frame to click', false);
  });

  ok('no console errors', errors.length === 0, errors.slice(0, 6).join('\n'));
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
