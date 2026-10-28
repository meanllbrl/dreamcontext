/**
 * Screenshots of where the Super Agent's hand-over button sits, in the real app UI. A scratch
 * vault in a fake HOME under the OS temp dir and a `claude` stand-in that answers one line, two
 * chats open on the Chat screen. Desktop (1440x900) and phone (390x844), light and dark.
 *   npm run build
 *   OUT_DIR=<dir> SHOT_TAG=before node e2e/super-dugme-shots.mjs
 * SHOT_TAG names the files; SHOT_THEMES=dark,light picks the themes; SHOT_INJECT=<file.js>
 * runs a script in the page before each shot (used to mock a placement); SHOT_HANDOVER=1 also
 * presses the Super Agent tab and shoots the handed-over screen (desktop only).
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { markAnnouncementsSeen, setTheme } from '../scripts/verify/lib/measure.mjs';

const ROOT = mkdtempSync(join(realpathSync(tmpdir()), 'dc-super-dugme-'));
const HOME = join(ROOT, 'home');
const PROJ = join(ROOT, 'proj');
const CLI = resolve('dist/index.js');
const OUT = resolve(process.env.OUT_DIR ?? join(ROOT, 'shots'));
const TAG = process.env.SHOT_TAG ?? 'before';
const THEMES = (process.env.SHOT_THEMES ?? 'dark').split(',');
const INJECT = process.env.SHOT_INJECT ? readFileSync(process.env.SHOT_INJECT, 'utf-8') : '';
for (const d of [OUT, PROJ, join(HOME, '.local', 'bin'), join(HOME, '.dreamcontext')]) mkdirSync(d, { recursive: true });

const run = (args, cwd = PROJ) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
spawnSync('git', ['init', '-q'], { cwd: PROJ });
run(['init', '-y', '--name', 'orbit']);
run(['vaults', 'add', 'orbit', PROJ]);

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { out({}); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || ('stand-in-' + process.pid);
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    const said = 'Looking at last week\\'s trial cohort now.';
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;
writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
// An OLD blob that still says superAgent:false: the button must show anyway.
writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, chatView: true, screenMigrated: true, chatPermissionMode: 'auto', lightMode: 'off', superAgent: false }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => res(p)); }); });
const BASE = `http://127.0.0.1:${port}`;
const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
const server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => appendFileSync(join(ROOT, 'server.log'), d));
server.stderr.on('data', (d) => appendFileSync(join(ROOT, 'server.log'), d));
for (let end = Date.now() + 30000, up = false; !up;) {
  try { up = (await fetch(`${BASE}/`)).ok; } catch { /* not up */ }
  if (!up) { if (Date.now() > end) { server.kill(); throw new Error('server did not come up'); } await sleep(300); }
}

const pw = await import('@playwright/test');
const b = await pw.chromium.launch();
const results = [];
try {
  for (const theme of THEMES) {
    for (const [form, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
      const ctx = await b.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
      await setTheme(ctx, theme);
      await markAnnouncementsSeen(ctx, BASE);
      const page = await ctx.newPage();
      page.setDefaultTimeout(20000);
      const logs = [];
      page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
      await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
      for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(200); }
      // Home first: the screen a new user lands on.
      if (INJECT) await page.evaluate(INJECT).catch((e) => logs.push(`inject: ${e.message}`));
      await sleep(600);
      await page.screenshot({ path: join(OUT, `${TAG}-home-${form}-${theme}.png`) });
      const chatNav = page.locator('nav button, a, [role="tab"], button').filter({ has: page.locator('.sidebar-label', { hasText: /^\s*Chat\s*$/i }) }).first();
      if (await chatNav.count()) { await chatNav.click(); await sleep(1500); }
      if (await page.getByRole('button', { name: /Start chat/ }).count()) await page.getByRole('button', { name: /Start chat/ }).first().click().catch(() => {});
      await sleep(1500);
      const input = page.locator('.chat-cmp-input:visible').first();
      if (await input.count()) {
        await input.click();
        await input.fill('Why did trial-to-paid fall last week?');
        await page.keyboard.press('Enter');
        await sleep(2500);
      }
      if (INJECT) await page.evaluate(INJECT).catch((e) => logs.push(`inject: ${e.message}`));
      await sleep(600);
      await page.screenshot({ path: join(OUT, `${TAG}-chat-${form}-${theme}.png`) });
      const btn = page.locator('[data-testid="super-handover-btn"]:visible');
      const firstTab = page.locator('.agent-tab:visible').first();
      const row = { theme, form, handoverButtonVisible: await btn.count(), rect: (await btn.count()) ? await btn.first().boundingBox() : null, firstChatTab: (await firstTab.count()) ? await firstTab.boundingBox() : null };
      if (process.env.SHOT_HANDOVER && form === 'desktop' && row.handoverButtonVisible) {
        await btn.first().click();
        await page.locator('[data-testid="super-handover-btn"][data-state="handed-over"]:visible').waitFor({ timeout: 60000 }).catch(() => {});
        await sleep(4000);
        await page.screenshot({ path: join(OUT, `${TAG}-handedover-${form}-${theme}.png`) });
        row.takeBack = (await btn.count()) ? { rect: await btn.first().boundingBox(), state: await btn.first().getAttribute('data-state'), label: await btn.first().innerText() } : null;
      }
      row.consoleErrors = logs.slice(0, 5);
      results.push(row);
      await ctx.close();
    }
  }
} finally {
  await b.close();
  server.kill();
}
console.log(JSON.stringify({ out: OUT, results }, null, 2));
