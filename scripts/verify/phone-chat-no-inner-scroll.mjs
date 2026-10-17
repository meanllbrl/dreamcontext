#!/usr/bin/env node
/**
 * A phone chat scrolls as ONE page: no card inside the transcript scrolls on its own.
 *
 *   npm run build && node scripts/verify/phone-chat-no-inner-scroll.mjs
 *
 * THE REPORT (owner, 2026-10-17, from the phone): "her container kendi içinde kayıyor o da berbat;
 * her bir chat widget kendi içinde kaymamalı". A thumb that scrolls the transcript lands inside a
 * tool output, a code block or a report and scrolls THAT instead, and the page stops moving.
 *
 * WHAT IT DRIVES: the real dashboard server (scratch HOME, a scripted `claude` stand-in, no
 * tokens) and Chromium as a phone (390x844 and 375x667, touch, coarse pointer) dressed as Mac
 * mode's phone surface on the main listener. One turn carries every kind of widget the chat
 * draws for long content: thinking, a long Bash output, a long Read, an Edit diff, a Write, a
 * Grep, a todo list, a sub-agent report, a long fenced code block with long lines, a wide table
 * and a tall dream-html block. Every tool card is opened, then EVERY element inside the
 * transcript is measured.
 *
 * CHECKS: no element inside `.chat-scroll` is a scroller holding more than it shows, vertically
 * or horizontally (the transcript itself is the one scroller); no card cuts its content at a
 * max-height; no horizontal overflow of the page; the dream-html frame is as tall as its body.
 * `--report` prints every scroller found (for a before/after list).
 *
 * `DC_CLI=<dist/index.js>` runs another build. FAILURE POLICY: collect, don't fail fast; exit 0
 * iff every check passed. Screenshots: tmp/verify-phone-chat-no-inner-scroll/*.png
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-phone-chat-no-inner-scroll');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-phone-chat-no-inner-scroll');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');
const REPORT = process.argv.includes('--report');

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\`: one turn with every long widget. */
const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\\n');
const ROOT = process.cwd();
let inited = false; let buf = '';
const tool = (name, input, result) => {
  const id = 'toolu_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  out({ type: 'assistant', message: { id: 'msg_' + id, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: result }] }] } });
};
const say = (text) => out({ type: 'assistant', message: { id: 'msg_' + crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text }] } });
function rich() {
  out({ type: 'assistant', message: { id: 'msg_think', role: 'assistant', content: [{ type: 'thinking', thinking: lines(40, (i) => 'Thinking line ' + i + ': weighing which file holds the invoice export and why the totals drift by a cent.') }] } });
  tool('Bash', { command: 'npm test -- --reporter verbose', description: 'Run the test suite' }, lines(220, (i) => '  ✓ invoice export case ' + i + ' rounds every line to the cent and keeps the currency (' + (i * 3) + ' ms)'));
  tool('Read', { file_path: ROOT + '/src/invoice/export.ts' }, lines(300, (i) => String(i).padStart(5) + '\\t' + 'export const line' + i + ' = computeLineTotal(order.items[' + i + '], { currency: order.currency, rounding: "half-even" });'));
  tool('Edit', { file_path: ROOT + '/src/invoice/export.ts', old_string: lines(40, (i) => 'const total' + i + ' = Math.round(amount' + i + ' * 100) / 100; // old rounding that drifts by a cent on long orders'), new_string: lines(40, (i) => 'const total' + i + ' = roundHalfEven(amount' + i + ', 2); // banker rounding, matches the ledger') }, 'The file has been updated.');
  tool('Write', { file_path: ROOT + '/src/invoice/rounding.ts', content: lines(120, (i) => 'export function helper' + i + '(value: number): number { return Math.round(value * 10 ** 2) / 10 ** 2 + ' + i + ' * 0; }') }, 'File created successfully.');
  tool('Grep', { pattern: 'Math.round', path: ROOT + '/src' }, lines(160, (i) => ROOT + '/src/module' + i + '/file' + i + '.ts:' + (i * 7) + ':  const v = Math.round(x * 100) / 100;'));
  tool('TodoWrite', { todos: Array.from({ length: 14 }, (_, i) => ({ content: 'Step ' + (i + 1) + ': fix the rounding in module ' + (i + 1) + ' and re-run its tests', activeForm: 'Fixing module ' + (i + 1), status: i < 5 ? 'completed' : i === 5 ? 'in_progress' : 'pending' })) }, 'Todos have been modified successfully.');
  tool('Agent', { description: 'Audit rounding', prompt: 'Find every place that rounds money.', subagent_type: 'Explore' }, lines(90, (i) => '- Finding ' + i + ': src/module' + i + '/file' + i + '.ts rounds with Math.round before summing, which drifts on orders over 40 lines.'));
  const code = lines(70, (i) => '  const veryLongVariableNameForLine' + i + ' = await someService.computeTheTotalForTheInvoiceLine({ orderId, lineIndex: ' + i + ', currency: "EUR", rounding: "half-even" });');
  const table = '| Module | File | Before | After | Drift | Orders | Owner | Status |\\n|---|---|---|---|---|---|---|---|\\n' + lines(12, (i) => '| module' + i + ' | src/module' + i + '/file' + i + '.ts | 10.005 | 10.00 | 0.01 | ' + (i * 113) + ' | team-' + i + ' | fixed in \`npm test\` on **CI** |');
  const html = '<div class="dc-doc"><h2 class="dc-h2">Rounding audit</h2>' + Array.from({ length: 30 }, (_, i) => '<p class="dc-p">Module ' + (i + 1) + ' now rounds half-even before it sums.</p>').join('') + '</div>';
  const narrow = '| Task | Status | Why it matters |\\n|---|---|---|\\n' + lines(4, (i) => '| recall-v' + i + ' | done | It spans all nine channels so a recall no longer misses the automations of module ' + i + '. |');
  say('Here is what changed.\\n\\n\`\`\`ts\\n' + code + '\\n\`\`\`\\n\\n' + table + '\\n\\n' + narrow + '\\n\\n\`\`\`dream-html\\n' + html + '\\n\`\`\`\\n\\nAll ' + 220 + ' tests pass.');
}
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    rich();
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const report = {
  pass: 0, fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const cli = (args, cwd = PROJ) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, SHOTS]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  mkdirSync(join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  cli(['init', '-y', '--name', 'proj', '--description', 'A scratch project for the phone scroll check']);
  const r = cli(['vaults', 'add', 'proj', PROJ]);
  if (r.status !== 0) throw new Error(`vaults add: ${r.stderr || r.stdout}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`[server] ${s}`); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

/** Every element inside the visible transcript that scrolls on its own, or cuts its content. */
const measure = (page) => page.evaluate(() => {
  const scroll = [...document.querySelectorAll('.agent-surface[data-mobile] .chat-scroll')].find((e) => e.getBoundingClientRect().height > 0);
  if (!scroll) return { ok: false };
  const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
  const scrollers = []; const cut = [];
  for (const el of scroll.querySelectorAll('*')) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    // A field the owner types into scrolls by nature (an answer box): not a card.
    if (el.matches('textarea, input, select, [contenteditable="true"]')) continue;
    const cs = getComputedStyle(el);
    const scrolls = (v) => v === 'auto' || v === 'scroll';
    const v = scrolls(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const h = scrolls(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (v || h) scrollers.push({ el: name(el), v, h, sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth, maxH: cs.maxHeight });
    // Content cut at a max-height with no way to scroll to it (a clamp hiding the rest).
    else if (cs.maxHeight !== 'none' && cs.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 4 && !cs.webkitLineClamp?.match(/^\d/)) {
      cut.push({ el: name(el), sh: el.scrollHeight, ch: el.clientHeight, maxH: cs.maxHeight });
    }
  }
  const frames = [...scroll.querySelectorAll('iframe')].map((f) => Math.round(f.getBoundingClientRect().height));
  // Nothing that no longer scrolls may be cut at the column's edge instead: every painted box
  // stays inside the transcript's width (a positioned overlay, like a hover bar, is not content;
  // nor is a visually hidden box, like a stacked table's header row: clipped to nothing on screen).
  const edge = scroll.getBoundingClientRect();
  const wide = [];
  const unseen = [...scroll.querySelectorAll('*')].filter((a) => getComputedStyle(a).clipPath === 'inset(50%)');
  for (const el of scroll.querySelectorAll('*')) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0 || el.closest('[style*="position: absolute"], .chat-m-hoverbar')) continue;
    if (unseen.some((h) => h.contains(el))) continue;
    if (getComputedStyle(el).position === 'absolute') continue;
    if (b.right > edge.right + 1 || b.left < edge.left - 1) wide.push({ el: name(el), left: Math.round(b.left), right: Math.round(b.right), edge: Math.round(edge.right) });
  }
  return {
    ok: true, scrollers, cut, frames, wide: wide.slice(0, 20), wideCount: wide.length,
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    transcript: { sh: scroll.scrollHeight, ch: scroll.clientHeight },
  };
});

let server = null;
let browser = null;
try {
  const { chromium, devices } = await import('@playwright/test');
  console.log(`· build: ${CLI}`);
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  browser = await chromium.launch();
  for (const size of [{ name: '390x844', device: 'iPhone 13', viewport: { width: 390, height: 844 } }, { name: '375x667', device: 'iPhone SE', viewport: { width: 375, height: 667 } }]) {
    console.log(`\n── phone ${size.name}`);
    const ctx = await browser.newContext({ ...devices[size.device], viewport: size.viewport });
    await ctx.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState !== 'interactive' || document.querySelector('meta[name="dreamcontext-surface"]')) return;
        const m = document.createElement('meta'); m.name = 'dreamcontext-surface'; m.content = 'mac'; document.head.appendChild(m);
      });
    });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await until(async () => (await page.locator('[data-testid="phone-list"]:visible').count()) === 1, 25000);
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await page.waitForTimeout(300); }
    await page.locator('[data-testid="list-new"]').click();
    const input = page.locator('.chat-cmp-input:visible').first();
    const opened = await until(async () => (await input.count()) > 0, 20000);
    if (!opened) await page.screenshot({ path: join(SHOTS, `${size.name}-no-chat.png`) });
    report.check('"New chat" opens a chat', opened);
    await page.waitForTimeout(800);
    await input.click(); await input.fill('RICH'); await page.keyboard.press('Enter');
    report.check('the rich turn arrived (its last line is on screen)', await until(async () => (await page.locator('.chat-scroll:visible').innerText()).includes('tests pass'), 30000));
    await page.waitForTimeout(1500);
    // Open everything a tap opens: tool runs, tool cards, thinking, the sub-agent report.
    for (let pass = 0; pass < 4; pass++) {
      const toggles = page.locator('.chat-scroll:visible [aria-expanded="false"]');
      const n = await toggles.count();
      if (!n) break;
      for (let i = 0; i < n; i++) { await toggles.nth(0).click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(120); }
    }
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.waitForTimeout(1500);
    const m = await measure(page);
    if (REPORT) console.log(JSON.stringify({ scrollers: m.scrollers, cut: m.cut, frames: m.frames }, null, 2));
    report.check(`no card inside the transcript scrolls on its own (${m.scrollers?.length ?? '?'} found)`, m.ok && m.scrollers.length === 0, JSON.stringify(m.scrollers?.slice(0, 12)));
    report.check(`no card cuts its content at a max-height (${m.cut?.length ?? '?'} found)`, m.ok && m.cut.length === 0, JSON.stringify(m.cut?.slice(0, 12)));
    report.check('the page does not overflow sideways', m.ok && !m.pageOverflow);
    report.check(`nothing is cut at the column's edge instead (${m.wideCount} boxes past it)`, m.ok && m.wideCount === 0, JSON.stringify(m.wide));
    report.check(`the transcript itself is the one scroller (${m.transcript?.sh} > ${m.transcript?.ch})`, m.ok && m.transcript.sh > m.transcript.ch);
    const tables = await page.evaluate(() => [...document.querySelectorAll('.chat-scroll table')].filter((t) => t.getBoundingClientRect().height > 0).map((t) => ({
      wide: t.hasAttribute('data-wide'),
      display: getComputedStyle(t).display,
      labels: [...t.querySelectorAll('td')].slice(0, 8).map((td) => getComputedStyle(td, '::before').content),
      // A cell mixing text, \`code\` and bold stays one line of text: a grid cell would make each
      // piece its own (blockified) item and set them under the wrong label.
      inlineMarks: [...t.querySelectorAll('td code, td strong')].slice(0, 4).map((e) => getComputedStyle(e).display),
      roles: [t.getAttribute('role'), t.querySelector('tr')?.getAttribute('role'), t.querySelector('td')?.getAttribute('role')],
      // A label cell broken mid-word: its one word (no space, no hyphen or slash to break at)
      // lands on more than one line box.
      brokenWords: [...t.querySelectorAll('[data-fit]')].filter((c) => {
        if (/[\s\-/]/.test((c.textContent ?? '').trim())) return false;
        const r = document.createRange(); r.selectNodeContents(c);
        return new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size > 1;
      }).length,
    })));
    const wideT = tables.find((t) => t.wide); const narrowT = tables.find((t) => !t.wide);
    report.check('the 8-column table is one block per row, each value under its header', !!wideT && wideT.display === 'block' && wideT.labels[0] === '"Module"' && wideT.labels[7] === '"Status"', JSON.stringify(wideT));
    report.check('a wide cell with `code` and bold keeps them inline, under its own label', !!wideT && wideT.inlineMarks.length >= 2 && wideT.inlineMarks.every((d) => d === 'inline'), JSON.stringify(wideT?.inlineMarks));
    report.check('the stacked table keeps its table roles for a screen reader', !!wideT && wideT.roles.join() === 'table,row,cell', JSON.stringify(wideT?.roles));
    report.check('the 3-column table stays a table and breaks no label mid-word', !!narrowT && narrowT.display === 'table' && narrowT.brokenWords === 0, JSON.stringify(narrowT));
    report.check(`the dream-html block is as tall as its 30 paragraphs (${m.frames})`, m.ok && m.frames.length >= 1 && m.frames.every((h) => h > 600), JSON.stringify(m.frames));
    // One screenshot per widget kind, each scrolled to the top of the screen.
    for (const [tag, sel] of [['terminal', '.chat-m-terminal'], ['diff', '.chat-m-diff'], ['code', '.chat-msg-assistant-body pre'], ['table', 'table[data-wide]'], ['narrow-table', 'table:not([data-wide])'], ['html', 'iframe']]) {
      const el = page.locator(`.chat-scroll:visible ${sel}`).first();
      if (!(await el.count())) { report.check(`a ${tag} widget is on screen to look at`, false); continue; }
      await el.evaluate((e) => e.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `${size.name}-${tag}.png`) });
    }
    await ctx.close();
  }
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err));
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  try { server?.kill('SIGTERM'); } catch { /* gone */ }
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
if (report.fails.length) { for (const f of report.fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
