#!/usr/bin/env node
/**
 * A FINISHED child's card opens its conversation, read only (bug 2026-10-25, task
 * super/biten-cocuk-karti): clicking the card of a child that did its job and exited drew a big
 * empty white pane ("Read only." in the head, nothing under it).
 *
 *   npm run build && node scripts/verify/super-gone-child.mjs
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard in
 * Chromium, a scripted stand-in `claude` (no tokens; fictional "Pocket Ledger"). On hand-over the
 * Super Agent delegates ONE child; the child answers one turn (a tool row, then its final
 * report), writes it to its transcript the way Claude Code does, and EXITS by itself: `gone`.
 *
 *   G1  the child exited and the record calls it gone; its card stays on the stage.
 *   G2  after a reload (the relaunch path: a gone child comes back as a DORMANT tab, no process)
 *       clicking its card shows it side by side WITH its messages: the prompt, the tool row and
 *       the final report, read only (no composer), and no `claude` was started for it.
 *   G3  at 1440 px, light and dark: screenshots of that card (tmp/super-gone-child/).
 * Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-gone-child-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-gone-child');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const SLUG = join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));
const REPORT_TEXT = 'PLAN-DONE: the export plan is written and reviewed';

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
const convo = at('--resume') || at('--session-id') || '';
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, convo, pid: process.pid, t: Date.now(), ...o }) + '\\n');
report({ kind: 'spawn', resume: at('--resume') });
process.on('exit', () => report({ kind: 'exit' }));
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
let row = 0;
const persist = (o) => {
  if (!/^[0-9a-f-]{36}$/.test(convo)) return;
  mkdirSync(${JSON.stringify(SLUG)}, { recursive: true });
  appendFileSync(join(${JSON.stringify(SLUG)}, convo + '.jsonl'), JSON.stringify({ sessionId: convo, uuid: convo.slice(0, 8) + '-' + (++row), timestamp: new Date().toISOString(), cwd: process.cwd(), ...o }) + '\\n');
};
let inited = false;
function turn(text) {
  persist({ type: 'user', message: { role: 'user', content: text } });
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: 'v-' + process.pid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  if (role === 'super') {
    if (text.startsWith('[super handover]')) {
      const steps = [cli('super', 'delegate', '--prompt', 'Write the export plan', '--brief', 'Export plan', '--mode', 'plan')];
      report({ kind: 'handover', steps });
      said = 'arranged';
    }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SUPER ' + said }] } });
  } else {
    const id = 'toolu_plan_' + process.pid;
    const use = { type: 'tool_use', id, name: 'Bash', input: { command: 'ls src/export', description: 'List the export module' } };
    persist({ type: 'assistant', message: { role: 'assistant', content: [use] } });
    out({ type: 'assistant', message: { role: 'assistant', content: [use] } });
    const res = { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'csv.ts\\npdf.ts' }] };
    persist({ type: 'user', message: { role: 'user', content: [res] } });
    out({ type: 'user', message: { role: 'user', content: [res] } });
    said = ${JSON.stringify(REPORT_TEXT)};
    persist({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'v-' + process.pid });
  // The child did its job and leaves: the process exits on its own (status gone).
  if (role === 'child') setTimeout(() => process.exit(0), 1500);
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
    if (blocks.length) turn(blocks[0]);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
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
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(SCRATCH, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const reports = () => { try { return readFileSync(REPORTS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], children: {} }; } };
/** The child's chat card id, as the record names it. */
const cardId = (sid) => record().containers.find((c) => c.kind === 'chat' && c.ref === sid)?.id ?? '';
const spawnsOf = (sid) => reports().filter((r) => r.kind === 'spawn' && r.convo === sid);
const exited = (sid) => spawnsOf(sid).length > 0 && spawnsOf(sid).every((s) => reports().some((r) => r.kind === 'exit' && r.pid === s.pid));

const result = { pass: 0, fails: [] };
const ok = (label, cond, detail) => {
  if (cond) { result.pass++; console.log(`  ✓ ${label}`); }
  else { result.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};

async function openChat(page, base) {
  await page.goto(`${base}/?vault=pocket-ledger`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
}

/** What the shown card draws: its text, and whether a composer or the read-only line is there. */
const shown = (page) => page.locator('[data-testid="super-shown"]').first().evaluate((el) => ({
  text: el.innerText,
  tools: el.querySelectorAll('.chat-tool, [data-tool-name], .chat-tool-row').length,
  composer: el.querySelectorAll('.chat-cmp-input').length,
  readOnly: el.querySelectorAll('[data-testid="super-readonly"]').length,
  h: el.getBoundingClientRect().height,
})).catch(() => null);

async function main() {
  const { chromium } = await import('playwright');
  setupScratch();
  const port = await freePort();
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => { if (!localStorage.getItem('dreamcontext-theme')) localStorage.setItem('dreamcontext-theme', 'light'); });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    console.log('\n── hand over, one delegated child that finishes and exits');
    await openChat(page, base);
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
    await until(page, async () => (await page.getByTestId('super-handover-btn').count()) > 0);
    await page.waitForTimeout(1500);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    ok('the handover delegated a child', await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000));
    const child = reports().find((r) => r.kind === 'handover')?.steps?.[0]?.json?.sessionId;
    ok('…with a session id', !!child, JSON.stringify(reports().find((r) => r.kind === 'handover')));
    ok('G1 the child ran and exited by itself', await until(page, async () => exited(child), 40000));
    ok('G1 the record calls it gone', await until(page, async () => record().children?.[child]?.row === 'gone', 20000), JSON.stringify(record().children?.[child]));
    ok('G1 the record keeps its card', !!cardId(child), JSON.stringify(record().containers));
    // A finished job may go to Others (super-live-card.mjs §5): the owner opens it from there.
    const stacked = page.locator('[data-testid="super-others-stack"]');
    const item = page.locator(`[data-testid="super-others-item"][data-container-id="${cardId(child)}"]`);
    ok('G1 its card is in the Others stack', await until(page, async () => record().containers.find((c) => c.ref === child)?.place === 'others' && (await stacked.count()) === 1, 10000),
      JSON.stringify(record().containers.find((c) => c.ref === child)));

    console.log('── relaunch: the gone child is a dormant tab now');
    const spawnsBefore = spawnsOf(child).length;
    await openChat(page, base);
    await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 20000);
    ok('G2 the Others stack is there after the reload', await until(page, async () => (await stacked.count()) === 1, 20000));
    await page.waitForTimeout(2500);
    await stacked.click();
    ok('G2 its card is in the Others panel', await until(page, async () => (await item.count()) === 1, 5000));
    await item.click();
    const sided = await until(page, async () => record().view?.mode === 'half' && record().view?.card === cardId(child), 8000);
    ok('G2 clicking its card shows it side by side', sided, JSON.stringify(record().view));
    ok('G2 the side-by-side card shows its messages: the prompt and the final report', await until(page, async () => {
      const s = await shown(page);
      return !!s && s.text.includes(REPORT_TEXT) && s.text.includes('Write the export plan');
    }, 15000), JSON.stringify(await shown(page)));
    const s = await shown(page);
    ok('G2 …and its tool row', !!s && /Listed the export module/.test(s.text), JSON.stringify(s));
    ok('G2 read only: no composer, the read-only line instead', !!s && s.composer === 0 && s.readOnly === 1, JSON.stringify(s));
    ok('G2 no claude was started to show it', spawnsOf(child).length === spawnsBefore, JSON.stringify(spawnsOf(child)));
    // The card flies to its half; shoot once it stands still.
    const rectOf = () => page.locator('[data-testid="super-shown"]').first().evaluate((el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`; });
    let prev = '';
    await until(page, async () => { const now = await rectOf(); const still = now === prev; prev = now; await page.waitForTimeout(300); return still; }, 8000);
    await page.screenshot({ path: join(OUT, 'gone-child-1440-light.png') });
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'dark'));
    await openChat(page, base);
    await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 20000);
    ok('G3 dark: the shown card still has its messages after another reload', await until(page, async () => ((await shown(page))?.text ?? '').includes(REPORT_TEXT), 20000), JSON.stringify(await shown(page)));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(OUT, 'gone-child-1440-dark.png') });
    ok('no console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
  } catch (e) {
    ok('ran to the end', false, e?.stack ?? e);
  } finally {
    await browser.close();
    srv.kill();
    spawnSync('pkill', ['-f', SCRATCH]);
  }
  console.log(`\n${result.pass} passed, ${result.fails.length} failed${result.fails.length ? `:\n  - ${result.fails.join('\n  - ')}` : ''}`);
  console.log(`screenshots: ${OUT}`);
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
