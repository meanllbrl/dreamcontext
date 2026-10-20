/**
 * Capture the v0.32.0 announcement's desktop screenshots: the Super Agent's stage, the two
 * switches in Settings → Chat (Super Agent, Light mode), and the funnel explorer's Table tab.
 * The hands-free shots come from e2e/announce-shots-0-32-handsfree.mjs.
 *
 * Runs against THIS CUT's own build over the fictional "orbit" demo vault in a fake HOME (the
 * same root the hands-free driver uses), with a `claude` stand-in that answers from a fixed
 * script and, as the Super Agent, really runs `dreamcontext super …` from inside its chat, so the
 * stage is the app's own layout of real cards. No turn is spent.
 *   npm run build
 *   (demo root: see e2e/announce-shots-0-32-handsfree.mjs, plus the funnel insight:)
 *   cd $DEMO_ROOT/proj && HOME=$DEMO_ROOT/home node <repo>/dist/index.js lab create checkout-funnels \
 *     --title "Checkout funnels" --category Revenue --preset funnel-explorer
 *   … lab data write checkout-funnels --file <snapshot('full') of scripts/verify/fixtures/acme-funnel-snapshot.mjs>
 *   DEMO_ROOT=$DEMO_ROOT node e2e/announce-shots-0-32.mjs
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that cannot be reached is reported and skipped.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { markAnnouncementsSeen, setTheme } from '../scripts/verify/lib/measure.mjs';

const DEMO = process.env.DEMO_ROOT;
if (!DEMO) throw new Error('DEMO_ROOT is required (the demo vault root)');
const HOME = join(DEMO, 'home');
if (!realpathSync(HOME).startsWith(realpathSync(tmpdir()) + '/')) throw new Error('the demo HOME must sit under os.tmpdir()');
const PROJ = realpathSync(join(DEMO, 'proj'));
const CLI = resolve('dist/index.js');
const OUT = resolve('dashboard/public/announcements/shots/v0-32-0');
const RAW = join(DEMO, 'raw');
const REPORTS = join(DEMO, 'super-reports.ndjson');
const VAULT = 'orbit';
const ONLY = (process.env.ONLY ?? 'all').split(',');
const on = (g) => ONLY.includes('all') || ONLY.includes(g);
for (const d of [OUT, RAW, join(HOME, '.local', 'bin')]) mkdirSync(d, { recursive: true });
rmSync(REPORTS, { force: true });

// ── The stand-in `claude` ──────────────────────────────────────────────────────────────
const CHILD = [
  ['Why did trial-to-paid fall', 'It fell the week the v2 onboarding emails shipped, and single-source trials fell hardest.'],
  ['data sources each trial connected', 'Two-source trials converted at 31%, single-source trials at 11%. Single-source trials carry the whole drop.'],
  ['day-1', 'Draft: "Connect a second data source and watch your numbers join up. It takes two minutes." Shown once the first dashboard loads.'],
];
const SUPER_EVENT = [
  ['Cohort split', 'The split is in: two-source trials convert at 31%, single-source at 11%. The drop is the single-source trials.'],
  ['Day-1 prompt', 'The day-1 prompt draft is in its card. Say the word and I put it on the investigation task.'],
];
const SUPER_HANDOVER = 'Your trial-to-paid chat is with me now. I started two more: one splits the drop by data sources, one drafts a day-1 prompt to connect a second source. The task, its insight and the September interviews are on the stage.';
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const CHILD = ${JSON.stringify(CHILD)};
const SUPER_EVENT = ${JSON.stringify(SUPER_EVENT)};
const SUPER_HANDOVER = ${JSON.stringify(SUPER_HANDOVER)};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { out({}); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = at('--session-id') || at('--resume') || ('stand-in-' + process.pid);
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: ((r.stdout || '') + (r.stderr || '')).slice(0, 400) };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const adopted = [...text.matchAll(/child=([0-9a-zA-Z-]+)/g)].map((m) => m[1]);
    const steps = adopted.map((c) => cli('super', 'brief', c, 'Trial-to-paid drop'));
    steps.push(cli('super', 'delegate', '--prompt', 'Split last month\\'s trials by how many data sources each trial connected, and compare their trial-to-paid.', '--brief', 'Cohort split'));
    steps.push(cli('super', 'delegate', '--prompt', 'Draft a day-1 in-app prompt that asks a new trial to connect a second data source.', '--brief', 'Day-1 prompt'));
    steps.push(cli('super', 'open', 'task', 'investigate-trial-to-paid-drop', '--shape', 'tall', '--title', 'Investigate trial-to-paid drop'));
    steps.push(cli('super', 'open', 'insight', 'trial-to-paid', '--title', 'Trial-to-paid'));
    steps.push(cli('super', 'open', 'knowledge', 'research/trial-interviews-sept', '--shape', 'tall', '--title', 'Trial interviews, September'));
    report({ kind: 'handover', adopted, steps });
    return SUPER_HANDOVER;
  }
  if (text.startsWith('[super event]')) {
    const hit = SUPER_EVENT.find(([k]) => text.includes(k));
    report({ kind: 'event', hit: hit ? hit[0] : null });
    return hit ? hit[1] : 'Noted.';
  }
  return 'On it.';
}
const childTurn = (text) => (CHILD.find(([k]) => text.includes(k)) ?? [null, 'On it.'])[1];
let inited = false; let buf = ''; let chain = Promise.resolve();
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
    chain = chain.then(async () => {
      if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
      let said = 'On it.';
      try { said = role === 'super' ? superTurn(text) : childTurn(text); } catch (e) { said = 'error ' + e; }
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;
writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
// A clean start: no roster, no super state, and the Super Agent switch back at its default (off).
rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
rmSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), { force: true });
const uiFile = join(HOME, '.dreamcontext', 'agent-ui.json');
if (existsSync(uiFile)) {
  const ui = JSON.parse(readFileSync(uiFile, 'utf-8'));
  writeFileSync(uiFile, `${JSON.stringify({ ...ui, superAgent: false }, null, 2)}\n`);
}

// ── Server ──────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
const server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
  cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const log = join(DEMO, 'server-0-32.log');
server.stdout.on('data', (d) => appendFileSync(log, d));
server.stderr.on('data', (d) => appendFileSync(log, d));
{
  const end = Date.now() + 30000;
  let up = false;
  while (!up && Date.now() < end) { try { up = (await fetch(`${BASE}/`)).ok; } catch { /* not up */ } if (!up) await sleep(300); }
  if (!up) { server.kill(); throw new Error('dashboard server did not come up'); }
}

const { chromium } = await import('@playwright/test');
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });
await setTheme(ctx, 'dark');
await markAnnouncementsSeen(ctx, BASE);
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"],.agent-fab{display:none!important}`;
const captured = [];
const failed = [];
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(200); }
  return false;
};
async function shot(name, clip, { clean = true } = {}) {
  if (clean) await page.addStyleTag({ content: CLEAN });
  await sleep(500);
  const raw = join(RAW, `${name}-2x.png`);
  await page.screenshot({ path: raw, ...(clip ? { clip } : {}) });
  spawnSync('sips', ['-Z', '1600', raw, '--out', join(OUT, `${name}.png`)]);
  captured.push(name);
  console.log('  ✓', name);
}
async function scene(name, fn) {
  if (!on(name)) return;
  try { await fn(); } catch (e) { failed.push(name); console.log('  ✗', name, String(e?.stack ?? e).slice(0, 500)); }
}
async function home() {
  await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
  await sleep(1200);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(200); }
}
async function nav(title) {
  await home();
  await page.locator(`.sidebar-item[title^="${title}"]`).first().click();
  await sleep(2500);
}

// ── Funnel explorer: the Table tab ───────────────────────────────────────────────────
await scene('funnel-table', async () => {
  await nav('Insights');
  await page.evaluate(() => { window.history.pushState(null, '', `/lab/checkout-funnels${window.location.search}`); window.dispatchEvent(new PopStateEvent('popstate')); });
  const xp = page.locator('[data-lab-explorer-page="checkout-funnels"]').first();
  await xp.waitFor({ timeout: 20000 });
  await xp.locator('[data-lab-tab-key="table"]').first().click();
  const table = xp.locator('[data-lab-funnel-table]').first();
  await table.waitFor();
  await sleep(1200);
  const tabs = await xp.locator('[data-lab-tab-key]').first().boundingBox();
  const tb = await table.boundingBox();
  const last = await table.locator('[data-funnel-row]').last().boundingBox();
  const x = Math.max(0, tb.x - 16);
  const y = Math.max(0, tabs.y - 12);
  await shot('funnel-table', { x, y, width: Math.min(1600 - x, tb.width + 32), height: last.y + last.height - y + 20 });
});

// ── Settings → Chat: Light mode and the Super Agent switch (turned on here) ───────────
await scene('settings-chat', async () => {
  await nav('Settings');
  await page.locator('.settings-nav-item').filter({ hasText: /^\s*Chat/ }).first().click();
  await sleep(1200);
  const sw = page.getByRole('switch', { name: 'Show the Super Agent' });
  await sw.waitFor();
  if (!(await sw.isChecked())) await sw.click();
  await until(async () => sw.isChecked(), 5000);
  const light = page.locator('.setting-row', { hasText: 'Light mode' }).first();
  const superGroup = page.locator('.setting-group', { hasText: 'Show the Super Agent' }).last();
  await superGroup.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.activeElement?.blur());
  await sleep(1000);
  const a = await light.boundingBox();
  const g = await superGroup.boundingBox();
  const top = a.y - 16;
  const bottom = g.y + g.height + 12;
  const left = Math.min(a.x, g.x) - 16;
  const right = Math.max(a.x + a.width, g.x + g.width) + 16;
  await shot('settings-chat', { x: left, y: Math.max(0, top), width: right - left, height: bottom - Math.max(0, top) });
});

// ── The Super Agent: hand a chat over, the agent lays out its stage ──────────────────
await scene('super-stage', async () => {
  // Run alone (ONLY=super-stage), the Settings scene has not switched the hand-over button on.
  const cur = await (await fetch(`${BASE}/api/launcher/agent-settings`)).json();
  if (!cur.superAgent) {
    await fetch(`${BASE}/api/launcher/agent-settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ ...cur, superAgent: true }) });
  }
  await nav('Chat');
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click();
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.waitFor({ timeout: 20000 });
  await input.click();
  await input.fill('Why did trial-to-paid fall to 13% last week?');
  await page.keyboard.press('Enter');
  await until(async () => /single-source trials fell hardest/.test(await page.locator('.chat-scroll:visible').first().innerText()), 30000);
  await sleep(1000);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  await until(async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 20000);
  const reports = () => (existsSync(REPORTS) ? readFileSync(REPORTS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  await until(async () => reports().some((r) => r.kind === 'handover'), 90000);
  const ho = reports().find((r) => r.kind === 'handover');
  for (const s of ho?.steps ?? []) if (s.status !== 0) console.log(`    ! ${s.args}: exit ${s.status} ${s.out}`);
  await until(async () => (await page.locator('[data-testid="super-container"]').count()) >= 6, 30000);
  // Both delegated children answered and the super agent read both results.
  await until(async () => reports().filter((r) => r.kind === 'event' && r.hit).length >= 2, 60000);
  await until(async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);
  await sleep(3000);
  await page.mouse.move(800, 990);
  await shot('super-stage');
});

await b.close();
server.kill('SIGTERM');
console.log(`\ncaptured ${captured.length}: ${captured.join(', ')}`);
if (failed.length) console.log(`FAILED ${failed.length}: ${failed.join(', ')}`);
process.exit(0);
