#!/usr/bin/env node
/**
 * The Mac drawer is flat window rows (no chat rows, 1 Kasim 2026); a phone keeps chats by name.
 *
 *   npm run build && node scripts/verify/drawer-flat.mjs
 *
 * Scratch HOME, fictional projects: acme with two chat windows and three chats. Mac window
 * (Tauri marker, 1440): window rows only, no chat row, no nesting. Phone context (390, touch):
 * chat rows by name still there. Screenshots: tmp/verify-pencere-adi/*.png
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), `dreamcontext-verify-pencere-adi-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const SPAWNS = join(HOME, 'spawns.log');
const SHOTS = join(REPO, 'tmp', 'verify-pencere-adi');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');

const STANDIN = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
fs.appendFileSync(path.join(process.env.HOME, 'spawns.log'), JSON.stringify({ pid: process.pid, sid, resume: !!at('--resume') }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    if (text.includes('HOLD')) continue;
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ECHO ' + text }] };
    out({ type: 'assistant', message });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ECHO', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const SOCKETS = `(() => {
  const Real = window.WebSocket;
  window.__chatUrls = [];
  window.WebSocket = class extends Real {
    constructor(url, protocols) { super(url, protocols); if (String(url).includes('/api/agent/chat')) window.__chatUrls.push(String(url)); }
  };
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
})();`;

const report = { pass: 0, fails: [], console: [], shots: [] };
const check = (label, cond, detail) => {
  if (cond) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 300)}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME });
const cli = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(), encoding: 'utf-8' });
const spawns = () => (existsSync(SPAWNS) ? readFileSync(SPAWNS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const ID = {
  pricing: crypto.randomUUID(), funnel: crypto.randomUUID(), research: crypto.randomUUID(),
  initRun: crypto.randomUUID(), initPast: crypto.randomUUID(),
  globexOwn: crypto.randomUUID(), globexChild: crypto.randomUUID(), globexSuper: crypto.randomUUID(),
};

function project(name) {
  const p = join(SCRATCH, name);
  mkdirSync(join(p, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['-C', p, 'init', '-q']);
  const r = cli(p, 'vaults', 'add', name, p);
  if (r.status !== 0) throw new Error(`vaults add ${name}: ${r.stderr || r.stdout}`);
  return p;
}
const roster = (p, sessions, windows = [{ id: 'main', name: 'Chat', activePane: 0 }]) => writeFileSync(join(p, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows, generation: 1 }));
const tab = (title, sessionId, window = 'main', o = {}) => ({ title, kind: 'chat', sessionId, pane: 0, active: false, window, size: 1, bypass: false, minimized: false, ...o });
const transcript = (p, sid, text) => {
  const dir = join(HOME, '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const row = (o) => JSON.stringify({ ...o, cwd: p, uuid: crypto.randomUUID(), timestamp: new Date(Date.now() - 3600_000).toISOString(), sessionId: sid });
  writeFileSync(join(dir, `${sid}.jsonl`), [row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }), row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Answered.' }] } })].join('\n') + '\n');
};

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  const acme = project('acme'); const globex = project('globex'); const initech = project('initech');
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme', 'globex', 'initech'], projectOrder: ['acme', 'globex', 'initech'], lastVault: 'acme' }));
  // acme: two chat windows, three chats.
  roster(acme, [
    tab('Pricing notes', ID.pricing, 'main', { active: true }),
    tab('Funnel check', ID.funnel, 'main'),
    tab('Market research', ID.research, 'w2'),
  ], [{ id: 'main', name: 'Chat', activePane: 0 }, { id: 'w2', name: 'Research', activePane: 0 }]);
  // initech: one chat (it runs in the second window), one past chat only on disk.
  roster(initech, [tab('Initech running chat', ID.initRun, 'main', { active: true })]);
  transcript(initech, ID.initPast, 'Initech old question about churn');
  // globex: handed over; the owner's chat and one child of the Super in the roster.
  writeFileSync(join(globex, '_dream_context', 'state', '.super-agent.json'), JSON.stringify({
    v: 1, session: ID.globexSuper, enabled: true, containers: [], groups: [], view: { mode: 'float' },
    children: { [ID.globexChild]: { sessionId: ID.globexChild, startedAt: Date.now() - 60_000 } },
    queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [],
  }));
  roster(globex, [tab('Globex owner chat', ID.globexOwn, 'main', { active: true }), tab('Globex child job', ID.globexChild, 'main')]);
  return { acme, globex, initech };
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  mkdirSync(join(SCRATCH, 'cwd'), { recursive: true });
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--launcher', '--no-open', '-p', String(port)], { cwd: join(SCRATCH, 'cwd'), env: { ...env(), PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore' });
  if (!(await until(async () => (await fetch(`http://127.0.0.1:${port}/`)).ok, 40_000, 300))) { srv.kill(); throw new Error('server did not come up'); }
  return srv;
}

let shotN = 0;
const shot = async (p, name) => { const f = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`); await p.screenshot({ path: f }); report.shots.push(f); };
const dismiss = async (p) => {
  for (let i = 0; i < 3; i++) {
    const g = p.getByRole('button', { name: 'Got it' });
    if (await g.isVisible().catch(() => false)) { await g.click(); await sleep(300); continue; }
    const x = p.locator('.announcements-modal-close');
    if (await x.count()) { await x.first().click().catch(() => {}); await sleep(300); continue; }
    break;
  }
};
async function windowCtx(browser, base, vault, { w = 1440, h = 900, watch = false, phone = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'dark', ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  if (!phone) await ctx.addInitScript(SOCKETS);
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  if (watch) {
    p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource|__TAURI|tauri/i.test(m.text())) report.console.push(m.text().slice(0, 200)); });
    p.on('pageerror', (e) => { if (!/__TAURI|tauri|invoke/i.test(String(e))) report.console.push(String(e).slice(0, 200)); });
  }
  await p.route('**/api/onboarding/readiness**', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); });
  await p.goto(`${base}/?vault=${vault}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await dismiss(p);
  return { ctx, p };
}
const proj = (p, vault) => p.locator(`[data-drawer-project="${vault}"]`);
let srv = null; let browser = null;
try {
  const { chromium } = await import('@playwright/test');
  seed();
  const port = await freePort();
  srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();

  const { p } = await windowCtx(browser, base, 'acme', { watch: true });
  if (await p.locator('[data-testid="ns-rail-chat"]').first().isVisible().catch(() => false)) { await p.locator('[data-testid="ns-rail-chat"]').first().click(); await sleep(900); }
  await until(async () => (await proj(p, 'acme').locator('[data-testid="drawer-window-row"]').count()) >= 2, 15_000);
  const names = async () => (await proj(p, 'acme').locator('[data-testid="drawer-window-row"]').allTextContents()).map((t) => t.trim());
  report.before = await names();
  await p.locator('[data-testid="drawer-new-window"]').click();
  await sleep(500);
  await p.locator('[data-testid="drawer-new-menu"] button', { hasText: 'acme' }).first().click();
  await until(async () => (await proj(p, 'acme').locator('[data-testid="drawer-window-row"]').count()) >= 3, 15_000);
  await sleep(800);
  const after = await names();
  report.after = after;
  console.log('windows after new:', JSON.stringify(after));
  check('the stored default name is drawn as Window', after.some((n) => /^Window\b/.test(n)), JSON.stringify(after));
  check('no row is called Chat', !after.some((n) => /^Chat\b/.test(n)), JSON.stringify(after));
  await shot(p, 'new-window-name');
} catch (e) {
  report.fails.push(`threw: ${String(e?.stack ?? e).slice(0, 400)}`);
  console.log(`  x threw: ${String(e?.stack ?? e).slice(0, 400)}`);
} finally {
  await browser?.close().catch(() => {});
  srv?.kill();
  rmSync(SCRATCH, { recursive: true, force: true });
}
for (const c of report.console) console.log(`  console: ${c}`);
if (report.console.length) report.fails.push(`${report.console.length} console error(s)`);
for (const f of report.shots) console.log(`screenshot: ${f}`);
console.log(`${report.pass} passed, ${report.fails.length} failed${report.fails.length ? `: ${report.fails.join(' | ')}` : ''}`);
process.exit(report.fails.length ? 1 : 0);
