#!/usr/bin/env node
/**
 * Closing cards straight from Others (owner 2026-10-28: "sağ aşağıdaki others içinde de çarpılara
 * basarak kapatabilmemiz lazım"): every tile in the Others panel has the stage card's ×.
 *
 *   npm run build && node scripts/verify/super-others-close.mjs
 *
 * The real dashboard server on a scratch HOME, the real dashboard in Chromium, a scripted stand-in
 * `claude` (no tokens spent) that as the Super Agent puts two pictures, a picture group, a page, a
 * PDF and an idle child chat into Others. Everything is fictional ("Pocket Ledger").
 *
 * At 1440x900, then again at a phone width (390x844), it opens Others and closes one of each kind
 * with its ×: a picture and a page close at once; the group asks "Close its cards?" and closes
 * them with the panel still open; the child chat asks "This chat?" and "End session" ends it; the
 * last card closes the panel and the corner stack. After every close the record, the panel's count
 * and the corner stack's count all drop by one. Screenshots: tmp/super-others-close/. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-others-close-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-others-close');
const REPORTS = join(SCRATCH, 'reports.ndjson');
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
const sid = 'verify-' + role + '-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: ((r.stdout || '') + (r.stderr || '')).slice(0, 400) };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, ...o }) + '\\n');
const record = () => JSON.parse(readFileSync(${JSON.stringify(RECORD)}, 'utf-8'));
function fill(tag) {
  const steps = [
    cli('super', 'open', 'image', 'shots/' + tag + '-a.png', 'shots/' + tag + '-b.png', '--group', 'Ledger shots ' + tag),
    cli('super', 'open', 'image', 'shots/' + tag + '-c.png', '--no-group'),
    cli('super', 'open', 'web', 'docs/' + tag + '.html', '--no-group'),
    cli('super', 'open', 'pdf', 'docs/' + tag + '.pdf', '--no-group'),
    cli('super', 'delegate', '--prompt', 'CHILD ' + tag, '--brief', 'Ledger export ' + tag),
  ];
  const rec = record();
  for (const c of rec.containers) if (c.kind !== 'chat' && c.kind !== 'agenda' && !rec.groups.some((g) => g.cards.includes(c.id))) steps.push(cli('super', 'stack', c.id));
  for (const g of rec.groups) steps.push(cli('super', 'stack', g.id));
  report({ kind: 'fill', tag, steps });
}
function superTurn(text) {
  if (text.startsWith('[super handover]')) { fill('one'); return 'filled'; }
  if (text.includes('REFILL')) { fill('two'); return 'refilled'; }
  if (text.includes('STACK-CHATS')) {
    const rec = record();
    report({ kind: 'stack-chats', steps: rec.containers.filter((c) => c.kind === 'chat' && rec.children[c.ref] && !rec.children[c.ref].adopted).map((c) => cli('super', 'stack', c.id)) });
    return 'stacked';
  }
  return 'ok';
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
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    let said = 'ok';
    try { said = role === 'super' ? superTurn(blocks.find((b) => /\\[super handover\\]|REFILL|STACK-CHATS/.test(b)) ?? blocks[0] ?? '') : 'done'; } catch (e) { said = 'error ' + e; }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
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
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'shots'), join(PROJ, 'docs'), OUT]) mkdirSync(d, { recursive: true });
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
  for (const tag of ['one', 'two']) {
    ['a', 'b', 'c'].forEach((x, i) => {
      const f = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${['testsrc', 'smptebars', 'rgbtestsrc'][i]}=size=800x600`, '-frames:v', '1', join(PROJ, 'shots', `${tag}-${x}.png`)], { encoding: 'utf-8' });
      if (f.status !== 0) throw new Error(`ffmpeg failed: ${f.stderr}`);
    });
    writeFileSync(join(PROJ, 'docs', `${tag}.pdf`), onePagePdf(`Pocket Ledger terms ${tag}`));
    writeFileSync(join(PROJ, 'docs', `${tag}.html`), `<!doctype html><html><head><meta charset="utf-8"><title>Ledger ${tag}</title></head><body><h1>Ledger report ${tag}</h1><p>October closed at 4,210 EUR.</p></body></html>\n`);
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
  const say = async (text) => {
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill(text);
    await page.keyboard.press('Enter');
  };

  /** The Super's delegated children's cards (the owner's own handed-over chat stays on the stage). */
  const delegated = () => { const r = record(); return r.containers.filter((c) => c.kind === 'chat' && r.children[c.ref] && !r.children[c.ref].adopted && r.children[c.ref].endedAt === undefined); };
  const kindOf = (id) => record().containers.find((c) => c.id === id)?.kind;
  /** What sits in Others on the record: ungrouped cards and groups placed there. */
  const othersOnRecord = () => {
    const r = record();
    const grouped = new Set(r.groups.flatMap((g) => g.cards));
    return [...r.containers.filter((c) => c.place === 'others' && !grouped.has(c.id)).map((c) => c.id), ...r.groups.filter((g) => g.place === 'others').map((g) => g.id)];
  };
  const stackCount = async () => Number((await page.locator('[data-testid="super-others-stack"] .super-others-count').innerText().catch(() => '0')).trim() || 0);
  const panelCount = async () => Number((await page.locator('[data-testid="super-others-fan"] .super-group-panel-head .super-tile-count').innerText().catch(() => '0')).trim() || 0);
  const tiles = () => page.locator('[data-testid="super-others-fan"] [data-testid="super-others-item"]');
  const tileOf = (id) => page.locator(`[data-testid="super-others-fan"] [data-testid="super-others-item"][data-container-id="${id}"]`);
  const openOthers = async () => {
    if ((await page.locator('[data-testid="super-others-fan"]:visible').count()) === 0) await page.locator('[data-testid="super-others-stack"]:visible').click();
    return until(page, async () => (await page.locator('[data-testid="super-others-fan"]:visible').count()) === 1, 4000);
  };

  async function fillAndClose(tag, width) {
    const label = (s) => `${width}px: ${s}`;
    ok(label('the Super filled Others (every open and stack succeeded)'), await until(page, async () => readNd(REPORTS).some((r) => r.kind === 'fill' && r.tag === tag), 60000)
      && readNd(REPORTS).find((r) => r.kind === 'fill' && r.tag === tag).steps.every((x) => x.status === 0), JSON.stringify(readNd(REPORTS).find((r) => r.kind === 'fill' && r.tag === tag)?.steps.filter((x) => x.status !== 0)));
    // The child's card comes once its chat runs; then the Super puts it in Others too.
    ok(label('the child chat has its card'), await until(page, async () => delegated().length === 1, 30000), JSON.stringify(record().children));
    // A live job's card is never put in Others (the server's rule): once its turn is over, it may go.
    const live = () => { const r = record(); return delegated().some((c) => ['working', 'asking', 'stuck', 'waiting'].includes(r.children[c.ref]?.row)); };
    await until(page, async () => !live(), 30000);
    let stacked = false;
    for (let i = 0; i < 4 && !stacked; i++) {
      const before = readNd(REPORTS).filter((r) => r.kind === 'stack-chats').length;
      await say('STACK-CHATS');
      stacked = await until(page, async () => readNd(REPORTS).filter((r) => r.kind === 'stack-chats').length > before && delegated().every((c) => c.place === 'others'), 15000);
      if (!stacked) await page.waitForTimeout(2000);
    }
    ok(label('…and it is put in Others'), stacked, JSON.stringify(readNd(REPORTS).filter((r) => r.kind === 'stack-chats').at(-1)));
    await settle(page);
    const ids = othersOnRecord();
    const chat = ids.find((id) => kindOf(id) === 'chat');
    const group = ids.find((id) => id.startsWith('grp-'));
    const image = ids.find((id) => kindOf(id) === 'image');
    const web = ids.find((id) => kindOf(id) === 'web');
    const pdf = ids.find((id) => kindOf(id) === 'pdf');
    ok(label('Others holds a picture, a page, a PDF, a group and a chat'), ids.length === 5 && chat && group && image && web && pdf, JSON.stringify(ids.map((id) => [id, kindOf(id)])));
    // A narrow stage also puts in Others what it has no room for (the owner's own chat): counted too.
    await until(page, async () => (await stackCount()) >= 5, 8000);
    await settle(page);
    const base = await stackCount();
    const overflow = base - 5;
    ok(label(`the corner stack counts the 5 (and ${overflow} the stage had no room for)`), base >= 5 && (width < 800 || overflow === 0), String(base));
    ok(label('Others opens'), await openOthers());
    await settle(page);
    // The agenda is never closed (its close folds it to its pill): the one tile with no ×.
    const agendaTiles = (await tiles().evaluateAll((els) => els.map((e) => e.getAttribute('data-container-id')))).filter((id) => kindOf(id) === 'agenda').length;
    ok(label(`every tile has its × (the agenda: ${agendaTiles ? 'none, as on the stage' : 'not here'}), and the panel is inside the window`), (await tiles().count()) === base
      && (await page.locator('[data-testid="super-others-fan"] [data-testid="super-panel-item-close"]').count()) === base - agendaTiles
      && (await page.locator('[data-testid="super-others-fan"]').evaluate((p) => { const r = p.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; })),
      JSON.stringify(await page.locator('[data-testid="super-others-fan"]').boundingBox()));
    // Hidden until hovered (a mouse), shown on hover, keyboard reachable with a label.
    const x = tileOf(image).locator('[data-testid="super-panel-item-close"]');
    const op = () => x.evaluate((b) => getComputedStyle(b.parentElement).opacity);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    const hiddenOp = await op();
    await tileOf(image).hover();
    await page.waitForTimeout(300);
    ok(label('the × shows on hover, top right of the tile, with a label'), hiddenOp === '0' && (await op()) === '1' && (await x.getAttribute('aria-label')) === 'Close this card'
      && await x.evaluate((b) => { const t = b.closest('[data-panel-item]').getBoundingClientRect(); const r = b.getBoundingClientRect(); return r.right <= t.right && r.right > t.right - 40 && r.top >= t.top && r.top < t.top + 40; }), hiddenOp);
    await page.screenshot({ path: join(OUT, `${width}-1-others-hover.png`) });

    let n = base;
    const dropped = async (what, id, gone) => {
      n -= 1;
      ok(label(`${what}: gone from the record`), await until(page, gone, 15000), JSON.stringify(othersOnRecord()));
      ok(label(`${what}: the panel and the stack say ${n} at once`), await until(page, async () => (await tileOf(id).count()) === 0 && ((n === 0 && (await panelCount()) === 0) || ((await panelCount()) === n && (await stackCount()) === n && (await tiles().count()) === n)), 8000),
        JSON.stringify({ panel: await panelCount(), stack: await stackCount(), tiles: await tiles().count() }));
    };

    // A picture: closes at once, by keyboard (Tab from its tile to its ×, Enter).
    await tileOf(image).focus();
    await page.keyboard.press('Tab');
    ok(label('Tab from a tile lands on its ×'), await page.evaluate(() => document.activeElement?.getAttribute('data-testid')) === 'super-panel-item-close');
    await page.keyboard.press('Enter');
    await dropped('the picture', image, async () => !record().containers.some((c) => c.id === image));
    ok(label('…focus stays in the panel'), await page.evaluate(() => !!document.activeElement?.closest('[data-testid="super-others-fan"]')));

    // A page: one click.
    await tileOf(web).hover();
    await tileOf(web).locator('[data-testid="super-panel-item-close"]').click();
    await dropped('the page', web, async () => !record().containers.some((c) => c.id === web));

    // The group: asks first, like its close-all; the panel stays open.
    const groupCards = record().groups.find((g) => g.id === group).cards;
    await tileOf(group).hover();
    await tileOf(group).locator('[data-testid="super-panel-item-close"]').click();
    const gAsk = tileOf(group).locator('[data-testid="super-panel-close-choice"]');
    ok(label('the group asks "Close its cards?" with its count'), (await gAsk.count()) === 1 && /Close its cards\?/.test(await gAsk.innerText())
      && (await gAsk.locator('[data-testid="super-panel-close-end"]').innerText()).trim() === 'Close 2 cards', await gAsk.innerText().catch(() => ''));
    ok(label('…nothing closed yet'), othersOnRecord().includes(group));
    await page.screenshot({ path: join(OUT, `${width}-2-group-asks.png`) });
    await gAsk.locator('[data-testid="super-panel-close-end"]').click();
    await dropped('the group', group, async () => !record().groups.some((g) => g.id === group) && !record().containers.some((c) => groupCards.includes(c.id)));
    ok(label('…and Others stays open'), (await page.locator('[data-testid="super-others-fan"]:visible').count()) === 1);

    // The chat: asks "This chat?" like its stage card; End session ends the child.
    const ref = record().containers.find((c) => c.id === chat).ref;
    await tileOf(chat).hover();
    await tileOf(chat).locator('[data-testid="super-panel-item-close"]').click();
    const cAsk = tileOf(chat).locator('[data-testid="super-panel-close-choice"]');
    ok(label('the chat asks "This chat?" with End session'), (await cAsk.count()) === 1 && /This chat\?/.test(await cAsk.innerText())
      && (await cAsk.locator('[data-testid="super-panel-close-end"]').innerText()).trim() === 'End session', await cAsk.innerText().catch(() => ''));
    await page.screenshot({ path: join(OUT, `${width}-3-chat-asks.png`) });
    // Escape takes the question back, the panel stays.
    await page.keyboard.press('Escape');
    ok(label('Escape cancels the question, Others stays open'), await until(page, async () => (await cAsk.count()) === 0, 3000) && (await page.locator('[data-testid="super-others-fan"]:visible').count()) === 1);
    await tileOf(chat).hover();
    await tileOf(chat).locator('[data-testid="super-panel-item-close"]').click();
    await cAsk.locator('[data-testid="super-panel-close-end"]').click();
    await dropped('the chat', chat, async () => !record().containers.some((c) => c.id === chat) && record().children[ref]?.endedAt !== undefined);

    // The last card: the panel and the corner stack go.
    await page.screenshot({ path: join(OUT, `${width}-4-last-card.png`) });
    await tileOf(pdf).hover();
    await tileOf(pdf).locator('[data-testid="super-panel-item-close"]').click();
    await dropped('the PDF (the last card)', pdf, async () => !record().containers.some((c) => c.id === pdf));
    if (overflow === 0) {
      ok(label('…Others closes, and its stack leaves the corner'), await until(page, async () => (await page.locator('[data-testid="super-others-fan"]').count()) === 0
        && (await page.locator('[data-testid="super-others-stack"]').count()) === 0, 4000));
    } else {
      ok(label(`…Others keeps only the ${overflow} the stage has no room for`), (await tiles().count()) === overflow && othersOnRecord().length === 0);
      await page.keyboard.press('Escape');
    }
    await page.screenshot({ path: join(OUT, `${width}-5-empty.png`) });
  }

  console.log('\n── 1440: hand over, the Super fills Others');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  await fillAndClose('one', 1440);

  console.log('\n── 390 (a phone width): the Super fills Others again');
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('[data-testid="super-others-fan"]').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  await settle(page);
  await say('REFILL');
  await fillAndClose('two', 390);

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
