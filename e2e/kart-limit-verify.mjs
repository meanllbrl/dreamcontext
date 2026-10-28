/**
 * Verify a chat card's rate-limit ring on the Super stage, in the real app UI, in Chromium AND
 * WebKit. A scratch vault in a fake HOME under the OS temp dir, a `claude` stand-in that, as the
 * Super Agent, really runs `dreamcontext super delegate` (so the child cards are the app's own),
 * and `/api/agent/usage-limits` answered by a faked payload at low / medium / high / unknown.
 *   npm run build
 *   OUT_DIR=<dir> node e2e/kart-limit-verify.mjs
 * Prints, per browser and scenario, each card ring's data-known / data-tight / title.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { markAnnouncementsSeen, setTheme } from '../scripts/verify/lib/measure.mjs';

const ROOT = mkdtempSync(join(realpathSync(tmpdir()), 'dc-kart-limit-'));
const HOME = join(ROOT, 'home');
const PROJ = join(ROOT, 'proj');
const CLI = resolve('dist/index.js');
const OUT = resolve(process.env.OUT_DIR ?? join(ROOT, 'shots'));
const REPORTS = join(ROOT, 'reports.ndjson');
for (const d of [OUT, PROJ, join(HOME, '.local', 'bin'), join(HOME, '.dreamcontext')]) mkdirSync(d, { recursive: true });

const run = (args, cwd = PROJ) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
spawnSync('git', ['init', '-q'], { cwd: PROJ });
run(['init', '-y', '--name', 'orbit']);
run(['vaults', 'add', 'orbit', PROJ]);

// ── The stand-in `claude`: the Super delegates two children; a child answers in one line ──
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { out({}); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
let brief = ''; try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = at('--session-id') || at('--resume') || ('stand-in-' + process.pid);
const cli = (...a) => { const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...a], { env: process.env, encoding: 'utf-8', timeout: 60000 }); return { a: a.join(' '), s: r.status, o: ((r.stdout || '') + (r.stderr || '')).slice(0, 300) }; };
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, ...o }) + '\\n');
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = [
      cli('super', 'delegate', '--prompt', 'Split last month trials by data sources connected.', '--brief', 'Cohort split'),
      cli('super', 'delegate', '--prompt', 'Design a day-1 prompt for single-source trials.', '--brief', 'Day-1 prompt'),
    ];
    report({ kind: 'handover', steps });
    return 'Two chats started.';
  }
  return 'On it.';
}
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
      const said = role === 'super' ? superTurn(text) : 'Working on it.';
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;
writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, chatView: true, screenMigrated: true, chatPermissionMode: 'auto', lightMode: 'off', superAgent: true }));

// ── Server ──────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => res(p)); }); });
const BASE = `http://127.0.0.1:${port}`;
const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
const server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const log = join(ROOT, 'server.log');
server.stdout.on('data', (d) => appendFileSync(log, d));
server.stderr.on('data', (d) => appendFileSync(log, d));
for (let end = Date.now() + 30000, up = false; !up;) {
  try { up = (await fetch(`${BASE}/`)).ok; } catch { /* not up */ }
  if (!up) { if (Date.now() > end) { server.kill(); throw new Error('server did not come up'); } await sleep(300); }
}

// ── The faked usage payload ───────────────────────────────────────────────────────────
const H = 3600_000;
const SCENARIOS = {
  low: (now) => ({ fetchedAtMs: now - 60_000, limits: [{ key: 'session', percent: 12, resetsAt: now + 3.5 * H }, { key: 'weekly', percent: 8, resetsAt: now + 100 * H }] }),
  medium: (now) => ({ fetchedAtMs: now - 60_000, limits: [{ key: 'session', percent: 55, resetsAt: now + 2 * H }, { key: 'weekly', percent: 41, resetsAt: now + 60 * H }] }),
  high: (now) => ({ fetchedAtMs: now - 60_000, limits: [{ key: 'session', percent: 94, resetsAt: now + 0.5 * H }, { key: 'weekly', percent: 78, resetsAt: now + 30 * H }] }),
  unknown: () => ({ fetchedAtMs: null, limits: [] }),
};
let scenario = 'low';

const until = async (fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await fn().catch(() => false)) return true; return false; };
const reports = () => (existsSync(REPORTS) ? readFileSync(REPORTS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const pw = await import('@playwright/test');
const failed = [];

for (const engine of ['chromium', 'webkit']) {
  const b = await pw[engine].launch();
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await setTheme(ctx, 'dark');
  await markAnnouncementsSeen(ctx, BASE);
  let usageCalls = 0;
  await ctx.route('**/api/agent/usage-limits*', (route) => { usageCalls++; route.fulfill({ json: SCENARIOS[scenario](Date.now()) }); });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const tiles = page.locator('[data-tile="chat"]:visible');
  const toChat = async () => {
    await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(200); }
    await page.locator('nav button').filter({ has: page.locator('.sidebar-label', { hasText: /^\s*Chat\s*$/i }) }).first().click();
    await sleep(1500);
  };
  try {
    await page.goto(`${BASE}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
    await toChat();
    if (!(await page.locator('[data-testid="super-surface"]:visible').count())) {
      if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click();
      const input = page.locator('.chat-cmp-input:visible').first();
      await input.click();
      await input.fill('Why did trial-to-paid fall last week?');
      await page.keyboard.press('Enter');
      await sleep(2500);
      await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
      await until(async () => reports().some((r) => r.kind === 'handover'), 90000);
    }
    await until(async () => (await tiles.count()) >= 2, 60000);
    for (const name of ['low', 'medium', 'high', 'unknown']) {
      scenario = name;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await toChat();
      await until(async () => (await tiles.count()) >= 2, 60000);
      // A LIVE chat knows its account and shows the reading; a SAVED card (no process in this
      // window) does not know which account it would run on, so it must say unknown.
      const live = page.locator('[data-tile="chat"]:visible:not([data-kind="saved"]) [data-testid="chat-limit-ring"]');
      const want = name === 'unknown' ? 'false' : 'true';
      await until(async () => (await live.count()) >= 1 && (await page.locator(`[data-tile="chat"]:visible:not([data-kind="saved"]) [data-testid="chat-limit-ring"][data-known="${want}"]`).count()) === (await live.count()), 20000);
      await sleep(1200);
      const rings = await page.locator('[data-tile="chat"]:visible [data-testid="chat-limit-ring"]').evaluateAll((els) => els.map((e) => ({ kind: e.closest('[data-tile]')?.dataset.kind ?? '', known: e.dataset.known, tight: e.dataset.tight ?? '', title: e.getAttribute('title') })));
      console.log(`${engine} ${name}: usage calls so far ${usageCalls}`);
      for (const r of rings) console.log(`   ${r.kind.padEnd(7)} known=${r.known} tight=${r.tight || '-'} | ${r.title}`);
      const liveRings = rings.filter((r) => r.kind !== 'saved');
      const wantTight = name === 'high' ? 'true' : '';
      if (!liveRings.length || liveRings.some((r) => r.known !== want || r.tight !== wantTight)
        || rings.some((r) => r.kind === 'saved' && r.known !== 'false')) failed.push(`${engine}/${name}`);
      if (usageCalls > 2 * (Object.keys(SCENARIOS).indexOf(name) + 2)) failed.push(`${engine}/${name}: ${usageCalls} usage calls, not one shared poll`);
      // The stage, and a close-up of the first tile's top-left corner.
      await page.screenshot({ path: join(OUT, `${engine}-${name}-stage.png`) });
      const box = await tiles.first().boundingBox();
      if (box) await page.screenshot({ path: join(OUT, `${engine}-${name}-tile.png`), clip: { x: box.x - 6, y: box.y - 6, width: Math.min(box.width + 12, 360), height: Math.min(box.height + 12, 360) } });
    }
    // The composer's own ring, for comparison.
    const cmp = page.locator('.chat-cmp-usagebtn:visible').first();
    if (await cmp.count()) {
      const box = await cmp.boundingBox();
      await page.screenshot({ path: join(OUT, `${engine}-composer-ring.png`), clip: { x: box.x - 40, y: box.y - 10, width: box.width + 140, height: box.height + 20 } });
    }
  } catch (e) {
    failed.push(`${engine}: ${String(e?.message ?? e).slice(0, 300)}`);
    await page.screenshot({ path: join(OUT, `${engine}-error.png`) }).catch(() => {});
  }
  await b.close();
}
server.kill();
console.log(failed.length ? `FAIL ${failed.join(' | ')}` : 'PASS all scenarios, both engines');
console.log(`shots: ${OUT}  log: ${log}`);
process.exit(failed.length ? 1 : 0);
