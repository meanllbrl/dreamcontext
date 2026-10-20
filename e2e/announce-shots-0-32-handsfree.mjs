/**
 * Capture the v0.32.0 announcement's hands-free screenshots: Mac mode on the Mac, and the
 * phone that drives it (sign-in with the hands-free mark, the chat list with its live Mac
 * badge, a chat the Mac is running).
 *
 * Runs against THIS CUT's own build over the fictional "orbit" demo vault plus a second
 * fictional project, in a fake HOME under the OS temp dir (nothing real on screen):
 *   npm run build
 *   T=$(node -e "console.log(require('fs').realpathSync(require('os').tmpdir()))")
 *   ROOT=$T/dc-ann-032 DC=$PWD/dist/index.js <main checkout>/marketing/build-demo-vault-v2.sh
 *   unlink $T/dc-ann-032/home/Library/Keychains     # no live Claude login in the fake HOME
 *   (mkdir $T/dc-ann-032/atlas-mobile; cd there; git init; HOME=$T/dc-ann-032/home
 *    node dist/index.js init -y --name atlas-mobile …; … vaults add atlas-mobile <dir>)
 *   DEMO_ROOT=$T/dc-ann-032 node e2e/announce-shots-0-32-handsfree.mjs
 *
 * The HOME must sit under os.tmpdir(): the server honours its power and tunnel stand-ins only
 * there (`DREAMCONTEXT_MAC_VERIFY_POWER_LOG`, `DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL`), so Mac mode
 * never runs pmset on this machine and no Cloudflare tunnel opens. `claude` is a stand-in that
 * answers from a fixed script: no turn is spent.
 *
 * Writes shots/v0-32-0/handsfree-mac.png and handsfree-phone.png (the three phone screens laid
 * side by side, since a story column is landscape); the raw phone captures stay in
 * $DEMO_ROOT/raw. COLLECT-DON'T-FAIL-FAST: a scene that cannot be reached is reported.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { markAnnouncementsSeen, setTheme } from '../scripts/verify/lib/measure.mjs';

const DEMO = process.env.DEMO_ROOT;
if (!DEMO) throw new Error('DEMO_ROOT is required (the demo vault root)');
const HOME = join(DEMO, 'home');
if (!realpathSync(HOME).startsWith(realpathSync(tmpdir()) + '/')) throw new Error('the demo HOME must sit under os.tmpdir()');
const PROJ = realpathSync(join(DEMO, 'proj'));
const ATLAS = realpathSync(join(DEMO, 'atlas-mobile'));
const CLI = resolve('dist/index.js');
const OUT = resolve('dashboard/public/announcements/shots/v0-32-0');
const RAW = join(DEMO, 'raw');
const POWER_LOG = join(DEMO, 'power.log');
const VAULT = 'orbit';
const OTHER = 'atlas-mobile';
for (const d of [OUT, RAW, join(HOME, '.local', 'bin')]) mkdirSync(d, { recursive: true });

// ── The stand-in `claude`: answers from a fixed script, writes the transcript like Claude Code ──
const REPLIES = {
  'Split it by how many data sources each trial connected.':
    'Two-source trials converted at 31%, single-source trials at 11%. The drop is almost all single-source trials, starting the week the v2 onboarding emails shipped.',
};
const STANDIN = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const REPLIES = ${JSON.stringify(REPLIES)};
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const row = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, cwd: process.cwd(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const text = (typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('')).trim();
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    const said = Object.entries(REPLIES).find(([k]) => text.includes(k))?.[1] ?? 'On it.';
    const message = { role: 'assistant', content: [{ type: 'text', text: said }] };
    row({ type: 'assistant', message }); out({ type: 'assistant', message });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;
writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);

// ── Past chats (Claude Code transcripts) for both projects; one stays live on the Mac ──
const LIVE = crypto.randomUUID();
// A re-run starts from the same list: drop the transcripts and the roster an earlier run left.
for (const root of [PROJ, ATLAS]) rmSync(join(HOME, '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });
rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
const tdir = (root) => { const d = join(HOME, '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-')); mkdirSync(d, { recursive: true }); return d; };
function seed(root, sid, user, assistant, hoursAgo) {
  const ts = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  const rows = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: user }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistant }] } },
  ].map((o) => JSON.stringify({ ...o, cwd: root, uuid: crypto.randomUUID(), timestamp: ts, sessionId: sid }));
  const file = join(tdir(root), `${sid}.jsonl`);
  writeFileSync(file, `${rows.join('\n')}\n`);
  const when = new Date(ts);
  utimesSync(file, when, when); // the list's age reads the file's time
}
seed(PROJ, LIVE, 'Why did trial-to-paid fall to 13% last week?',
  'It fell the week the v2 onboarding emails shipped, and single-source trials fell hardest. I can split the cohort by data sources next.', 0.4);
seed(PROJ, crypto.randomUUID(), 'Draft the annual plan copy for the pricing page', 'Here is a first draft: two months free when you pay for a year.', 3);
seed(PROJ, crypto.randomUUID(), 'Which teams churned in September, and why?', 'Nine teams; six never set up a usage alert.', 26);
seed(PROJ, crypto.randomUUID(), 'Make the onboarding emails one action each', 'Rewrote all five; each now opens with its one action.', 50);
seed(PROJ, crypto.randomUUID(), 'One question for the churn exit survey', 'Proposed: "What would have made you stay?"', 74);
seed(ATLAS, crypto.randomUUID(), 'Offline sync: which edit wins?', 'Last write wins per field, with the device clock checked against the server.', 30);

// ── Server ──────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
const server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
  cwd: PROJ,
  env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: POWER_LOG, DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`[server] ${s}`); });
if (!(await until(async () => (await fetch(`${base}/`)).ok, 30000, 300))) throw new Error('dashboard server did not come up');
const mac = async (method, path, body) => {
  const res = await fetch(`${base}/api/handsfree/mac/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const captured = [];
const failed = [];
async function scene(name, fn) {
  try { await fn(); captured.push(name); console.log('  ✓', name); } catch (e) { failed.push(name); console.log('  ✗', name, String(e?.stack ?? e).slice(0, 400)); }
}
const dismiss = async (page) => {
  for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await page.waitForTimeout(300); }
};
const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"],.agent-fab{display:none!important}`;

const { chromium, devices } = await import('@playwright/test');
const browser = await chromium.launch();
try {
  const setup = await mac('POST', 'setup', {});
  if (setup.status !== 200) throw new Error(`Mac mode setup: ${setup.status} ${JSON.stringify(setup.json).slice(0, 200)}`);

  // ── 1. The Mac: the Hands-free sheet, ready to start, both projects chosen ──────────
  await scene('handsfree-mac', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    await ctx.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
    await setTheme(ctx, 'dark');
    await markAnnouncementsSeen(ctx, base);
    const page = await ctx.newPage();
    await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.locator('[data-testid="hf-button"]').click();
    await page.locator('[data-testid="hf-mac-projects"]').waitFor({ timeout: 10000 });
    const other = page.locator('.hf-mac-project', { hasText: OTHER }).locator('input');
    if (!(await other.isChecked())) await other.click();
    await page.addStyleTag({ content: CLEAN });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(RAW, 'handsfree-mac-2x.png') });
    await ctx.close();
  });

  // ── 2. A chat the laptop started, left running on the Mac (the tab's title in the roster) ─
  writeFileSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), `${JSON.stringify({
    sessions: [{ title: 'Trial-to-paid drop', bypass: false, minimized: false, size: 0, sessionId: LIVE, kind: 'chat' }], generation: 1,
  }, null, 2)}\n`);
  const { WebSocket: NodeWs } = await import('ws');
  const laptop = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=${VAULT}&bypass=0&resume=${LIVE}`);
  laptop.on('error', () => {});
  await new Promise((r) => laptop.on('open', r));
  laptop.send(JSON.stringify({ type: 'user', text: 'Split it by how many data sources each trial connected.' }));
  const transcript = join(tdir(PROJ), `${LIVE}.jsonl`);
  if (!(await until(() => /Two-source trials/.test(readFileSync(transcript, 'utf-8')), 20000))) console.log('  ! the live chat did not answer');
  await sleep(800);
  laptop.terminate();

  const started = await mac('POST', 'start', { vaults: [VAULT, OTHER] });
  if (started.status !== 200 || !started.json.url) throw new Error(`Mac mode start: ${started.status} ${JSON.stringify(started.json).slice(0, 200)}`);
  const phoneUrl = started.json.url;

  // ── 3. The phone: sign-in, the chat list, the Mac's chat ────────────────────────────
  const phone = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await setTheme(phone, 'dark');
  // The phone listener answers nothing before sign-in: read the ids from the Mac's own listener.
  await markAnnouncementsSeen(phone, base);
  const page = await phone.newPage();
  await scene('phone-signin', async () => {
    await page.goto(`${phoneUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('.hf-hero-mark').waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(RAW, 'phone-signin.png') });
  });
  await scene('phone-list', async () => {
    const qr = (await mac('POST', 'qr')).json.url;
    await page.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.locator('[data-testid="phone-list"]:visible').waitFor({ timeout: 25000 });
    await until(async () => (await page.locator('.mlist-head [data-testid="phone-live-badge"][data-live="true"]:visible').count()) === 1, 15000);
    await until(async () => (await page.locator('.mlist-title-text:visible', { hasText: 'Trial-to-paid drop' }).count()) === 1, 15000);
    await until(async () => (await page.locator('.mlist-title-text:visible').count()) >= 5, 15000);
    await page.waitForTimeout(1200);
    await dismiss(page);
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(RAW, 'phone-list.png') });
  });
  await scene('phone-chat', async () => {
    await page.locator('.mlist-title-text:visible', { hasText: 'Trial-to-paid drop' }).first().click();
    await until(async () => (await page.locator('.chat-scroll:visible').count()) > 0, 15000);
    await until(async () => /Two-source trials/.test(await page.locator('.chat-scroll:visible').first().innerText()), 15000);
    await page.mouse.move(200, 780); // off the message the tap landed on, so no hover toolbar
    await page.waitForTimeout(1200);
    await dismiss(page);
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(RAW, 'phone-chat.png') });
  });
  await phone.close();

  // ── 4. Finals: the Mac window at 1600, the three phone screens side by side ─────────
  spawnSync('sips', ['-Z', '1600', join(RAW, 'handsfree-mac-2x.png'), '--out', join(OUT, 'handsfree-mac.png')]);
  const shots = ['phone-signin', 'phone-list', 'phone-chat'].filter((n) => existsSync(join(RAW, `${n}.png`)));
  if (shots.length === 3) {
    await scene('handsfree-phone', async () => {
      const b64 = (n) => `data:image/png;base64,${readFileSync(join(RAW, `${n}.png`)).toString('base64')}`;
      const board = await browser.newPage({ viewport: { width: 1600, height: 1060 }, deviceScaleFactor: 1 });
      await board.setContent(`<body style="margin:0;background:#0d0f16">
        <div style="display:flex;justify-content:center;align-items:center;gap:44px;height:1060px">
          ${shots.map((n) => `<img src="${b64(n)}" style="width:440px;height:952px;border-radius:44px;border:1px solid #2a2d3a;box-shadow:0 24px 60px -30px rgba(0,0,0,.8);display:block">`).join('')}
        </div></body>`);
      await board.waitForTimeout(300);
      await board.screenshot({ path: join(OUT, 'handsfree-phone.png') });
      await board.close();
    });
  }
} finally {
  await browser.close().catch(() => {});
  await fetch(`${base}/api/handsfree/mac/stop`, { method: 'POST' }).catch(() => {});
  server.kill('SIGTERM');
}
console.log(`\ncaptured ${captured.length}: ${captured.join(', ')}`);
if (failed.length) console.log(`FAILED ${failed.length}: ${failed.join(', ')}`);
process.exit(0);
