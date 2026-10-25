#!/usr/bin/env node
/**
 * AI Team v2 D1, global agents, end to end against the built dist (AC-D1-1, AC-D1-2, AC-D1-4):
 *
 *   npm run build && node scripts/verify/global-agents.mjs
 *
 *   §1 the CLI: `agents create critic --scope global` lands in ~/.dreamcontext/agents/.
 *   §2 the launcher (no project open): "Global agents" lists Critic; "New global agent" creates
 *      Scout through the same identity form, with no photo and no board.
 *   §3 each of two projects (Northwind at 1440 light + 390 dark, Lumen at 1440 dark + 390 light):
 *      the AI Team roster lists Scout and Critic with the Global chip; Scout's stage shows the chip
 *      and its chat answers, run in THAT project's folder.
 *   §4 the same global agent runs in both projects at once: two `automations run scout --force`,
 *      overlapping in wall time, neither deferred; each output in its own project's folder.
 *   §5 nothing of either agent is in either brain.
 *
 * Fake HOME, scratch projects, fictional names, a stand-in `claude`. Every console error, page
 * error and failed request is counted (zero allowed). Screenshots in tmp/verify-global-agents/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = join(REPO, 'tmp', 'verify-global-agents');
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-global-agents');
rmSync(SCRATCH, { recursive: true, force: true });
const HOME = join(SCRATCH, 'home');
const PROJECTS = [
  { name: 'northwind', path: join(SCRATCH, 'northwind') },
  { name: 'lumen', path: join(SCRATCH, 'lumen') },
];
const RUNS = join(SCRATCH, 'runs.jsonl');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`);
};

/**
 * The stand-in `claude`. Headless (`--output-format json`): records its start, its folder and its end in RUNS,
 * holding for 4 s so two runs can overlap, then answers as the runner expects. A conversation
 * (stream-json on stdin): answers each message with who it is and the folder it runs in.
 */
const STANDIN = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? null); };
const sid = flag('--session-id') || flag('--resume') || '00000000-0000-4000-8000-000000000000';
if (flag('--output-format') === 'json') {
  const start = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
  appendFileSync(${JSON.stringify(RUNS)}, JSON.stringify({ cwd: process.cwd(), start, end: Date.now(), agent: process.env.DREAMCONTEXT_AUTOMATION_SLUG || null }) + '\\n');
  process.stdout.write(JSON.stringify({ session_id: sid, is_error: false, result: 'Checked.', total_cost_usd: 0.01, num_turns: 1, duration_ms: 4000, permission_denials: [], subtype: 'success' }) + '\\n');
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const briefPath = flag('--append-system-prompt-file');
let briefing = '';
if (briefPath) { try { briefing = readFileSync(briefPath, 'utf-8'); } catch { briefing = ''; } }
let n = 0;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    n++;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: flag('--permission-mode'), slash_commands: [] });
    const who = (briefing.match(/You are "([^"]+)"/) || [])[1] || 'Claude';
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I am ' + who + ', working in ' + process.cwd() + '.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: n, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
function cleanEnv() {
  const env = { ...process.env, HOME, PATH };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('DREAMCONTEXT_') || k.startsWith('VITEST')) delete env[k];
  }
  return env;
}
const cli = (cwd, ...args) => spawnSync(process.execPath, [distIndex(REPO), ...args], { cwd, env: cleanEnv(), encoding: 'utf-8', timeout: 120_000 });
const must = (label, r) => { if (r.status !== 0) throw new Error(`${label} failed: ${r.stderr || r.stdout}`); return r; };

/** Every path under a brain, relative. */
function brainPaths(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      out.push(relative(root, abs));
      if (statSync(abs).isDirectory()) walk(abs);
    }
  };
  walk(root);
  return out;
}

function setup() {
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true,
    screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
  // Unattended runs start only on an account under 80 %: this one is at 10 %.
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now() + 3_600_000,
      utilization: {
        five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() },
        seven_day: { utilization: 10, resets_at: new Date(Date.now() + 40 * 3_600_000).toISOString() },
      },
    },
  }));
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const p of PROJECTS) {
    mkdirSync(join(p.path, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(p.path, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false } }));
    spawnSync('git', ['init', '-q'], { cwd: p.path });
    must(`vaults add ${p.name}`, cli(p.path, 'vaults', 'add', p.name, p.path));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    import('node:net').then(({ createServer }) => {
      const srv = createServer();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
  });
}

async function startServer(port) {
  // The server starts in a project (it needs one); the launcher window opens with no vault (`/`).
  const srv = spawn(process.execPath, [distIndex(REPO), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJECTS[0].path, env: { ...cleanEnv(), DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error(`dashboard server did not come up: ${log.slice(-400)}`);
}

async function openPage(browser, base, { theme, width }, tag, consoleErrors, failedRequests) {
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 2 });
  await setTheme(context, theme);
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${tag}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${tag} pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${tag}: ${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => { if (!/\/api\/agent\/chat|net::ERR_ABORTED/.test(`${r.url()} ${r.failure()?.errorText}`)) failedRequests.push(`${tag}: ${r.failure()?.errorText} ${r.url()}`); });
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (fn, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(150); } return false; };
  const shot = async (name) => { await wait(500); await page.screenshot({ path: join(SHOTS, `${tag}-${name}.png`) }); };
  return { context, page, phone, wait, until, shot };
}

async function launcher(browser, base, combo, consoleErrors, failedRequests, create) {
  const tag = `launcher-${combo.width}-${combo.theme}`;
  console.log(`\n── §2 the launcher @${tag}`);
  const ui = await openPage(browser, base, combo, tag, consoleErrors, failedRequests);
  const { page } = ui;
  try {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await ui.wait(1500);
    for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim, .onb-scrim').count()); i++) { await page.keyboard.press('Escape'); await ui.wait(300); }
    await page.locator('[data-launcher-global-agents]').click({ timeout: 15000 });
    const dialog = page.locator('[data-global-agents]');
    check(`${tag}: "Global agents" lists the one the CLI made`, await ui.until(async () => (await dialog.locator('[data-global-agent="critic"]').count()) === 1));
    if (create) {
      await dialog.locator('[data-new-global-agent]').click();
      check(`${tag}: the form is the identity form with no photo and no board`,
        (await dialog.locator('.aid-photo').count()) === 0 && (await dialog.locator('select').count()) === 2 && (await dialog.locator('[data-global-note]').count()) === 1);
      await ui.shot('1-form');
      await dialog.locator('.aid-input').first().fill('Scout');
      await dialog.locator('.aid-textarea').first().fill('You find out what changed in the project and say it in three lines.');
      await dialog.locator('.aid-btn--primary').click();
      check(`${tag}: "New global agent" creates Scout, listed beside Critic`,
        await ui.until(async () => (await dialog.locator('[data-global-agent="scout"]').count()) === 1 && (await dialog.locator('[data-global-agent="critic"]').count()) === 1, 15000));
      check(`${tag}: …on this machine, approved`, existsSync(join(HOME, '.dreamcontext', 'agents', 'scout.md'))
        && /In every project/.test(await dialog.locator('[data-global-agent="scout"]').innerText()));
    }
    check(`${tag}: the dialog does not overflow sideways`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    // Guards a bar whose controls spill past the LEFT edge, which scrollWidth never sees.
    const lefts = await page.evaluate(() => ['.launcher-viewtoggle', '[data-launcher-global-agents]', '.launcher-search']
      .map((sel) => document.querySelector(sel)?.getBoundingClientRect()).map((r) => (r ? [Math.round(r.left), Math.round(r.right)] : null)));
    check(`${tag}: every launcher control sits inside the window (Space/List, Global agents, search)`,
      lefts.every((x) => x && x[0] >= 0 && x[1] <= combo.width + 1), JSON.stringify(lefts));
    // Guards a modal that leaves the focus on the page behind it.
    check(`${tag}: the dialog holds the focus`, await page.evaluate(() => !!document.activeElement?.closest('[data-global-agents]')));
    await ui.shot(create ? '2-created' : '1-list');
  } finally {
    await ui.context.close();
  }
}

async function project(browser, base, proj, combo, consoleErrors, failedRequests) {
  const tag = `${proj.name}-${combo.width}-${combo.theme}`;
  console.log(`\n── §3 ${proj.name} @${combo.width} ${combo.theme}`);
  const ui = await openPage(browser, base, combo, tag, consoleErrors, failedRequests);
  const { page, phone } = ui;
  try {
    await page.goto(`${base}/?vault=${proj.name}`, { waitUntil: 'domcontentloaded' });
    await ui.wait(2000);
    for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await ui.wait(300); }
    if (phone) { const menu = page.locator('.phone-bar button').first(); if (await menu.count()) { await menu.click(); await ui.wait(400); } }
    await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^AI Team$/ }) }).first().click();
    await page.locator('.aiteam').waitFor({ timeout: 15000 });
    const chip = (slug) => page.locator(`[data-team-row="${slug}"] [data-global-chip]`);
    check(`${tag}: the roster lists Scout and Critic, each with the Global chip`,
      await ui.until(async () => (await chip('scout').count()) === 1 && (await chip('critic').count()) === 1, 15000));
    if (phone) await ui.shot('1-roster');
    await page.locator('[data-team-row="scout"]').click();
    // On a phone the header's chips give way to the name (AiTeamPage.css, as the owner chip does);
    // the roster row above carries it there.
    check(phone ? `${tag}: Scout's stage opens` : `${tag}: Scout's stage opens with the Global chip`,
      await ui.until(() => page.locator(phone ? '.aiteam-stage[data-stage="scout"]' : '.aiteam-stage[data-stage="scout"] .aiteam-convo-head [data-global-chip]').isVisible()));
    const pane = page.locator('.aiteam-stage .agent-chat-pane-host .chat-pane');
    const input = page.locator('.aiteam-stage .chat-cmp-input').first();
    check(`${tag}: its stage chat is the real Chat pane`, await ui.until(() => input.isVisible(), 20000));
    await input.click();
    await page.keyboard.type('What changed today?');
    await page.keyboard.press('Enter');
    const answered = await ui.until(async () => (await pane.innerText()).includes('I am Scout'), 20000);
    const said = (await pane.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(`${tag}: Scout answers on its stage`, answered, said.slice(-160));
    // Guards a global agent that runs in its own folder instead of the project's.
    check(`${tag}: …working in ${proj.name}'s own folder`, said.includes(`working in ${proj.path}`) || said.includes(`working in /private${proj.path}`), said.slice(-200));
    check(`${tag}: the page does not overflow sideways`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await ui.shot(phone ? '2-stage' : '1-stage');
  } finally {
    await ui.context.close();
  }
}

async function main() {
  setup();
  console.log('── §1 the CLI');
  const made = cli(PROJECTS[0].path, 'agents', 'create', 'critic', '--title', 'Critic', '--prompt', 'You read a change and say what is wrong with it.', '--scope', 'global');
  check('`agents create critic --scope global` succeeds', made.status === 0, (made.stdout + made.stderr).trim().slice(0, 200));
  check('…its file is on this machine', existsSync(join(HOME, '.dreamcontext', 'agents', 'critic.md')));
  const listed = PROJECTS.map((p) => JSON.parse(cli(p.path, 'agents', 'list', '--json').stdout || '{"agents":[]}').agents);
  check('…both projects list it as global, may run', listed.every((rows) => rows.some((r) => r.slug === 'critic' && r.scope === 'global' && r.approvedToRun)), JSON.stringify(listed.map((r) => r.map((x) => `${x.slug}:${x.scope}`))));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const consoleErrors = [];
  const failedRequests = [];
  const browser = await chromium.launch();
  try {
    await launcher(browser, base, { width: 1440, theme: 'light' }, consoleErrors, failedRequests, true);
    await launcher(browser, base, { width: 390, theme: 'dark' }, consoleErrors, failedRequests, false);
    await project(browser, base, PROJECTS[0], { width: 1440, theme: 'light' }, consoleErrors, failedRequests);
    await project(browser, base, PROJECTS[0], { width: 390, theme: 'dark' }, consoleErrors, failedRequests);
    await project(browser, base, PROJECTS[1], { width: 1440, theme: 'dark' }, consoleErrors, failedRequests);
    await project(browser, base, PROJECTS[1], { width: 390, theme: 'light' }, consoleErrors, failedRequests);
  } finally {
    await browser.close();
    srv.kill();
  }
  check('no console or page errors', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));
  check('no failed requests', failedRequests.length === 0, failedRequests.slice(0, 4).join(' | '));

  console.log('\n── §4 one global agent, two projects, at once');
  const runIn = (p) => new Promise((resolve) => {
    const child = spawn(process.execPath, [distIndex(REPO), 'automations', 'run', 'scout', '--force'], { cwd: p.path, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
  const runs = await Promise.all(PROJECTS.map(runIn));
  check('both runs exit 0', runs.every((r) => r.code === 0), runs.map((r) => `${r.code}: ${r.out.trim().slice(-160)}`).join(' || '));
  check('…neither deferred, skipped or locked out', runs.every((r) => !/defer|skipp|locked|already running|waiting/i.test(r.out)), runs.map((r) => r.out.trim().slice(-160)).join(' || '));
  const recorded = existsSync(RUNS) ? readFileSync(RUNS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const byProject = PROJECTS.map((p) => recorded.find((r) => r.cwd === p.path || r.cwd === `/private${p.path}`));
  check('each project ran it in its own folder', byProject.every(Boolean), JSON.stringify(recorded.map((r) => r.cwd)));
  if (byProject.every(Boolean)) {
    const [x, y] = byProject;
    check(`…overlapping in wall time (${Math.min(x.end, y.end) - Math.max(x.start, y.start)} ms together)`, x.start < y.end && y.start < x.end);
  }
  const outputs = readdirSync(join(HOME, '.dreamcontext', 'agents', 'scout', 'projects')).map((key) => {
    const dir = join(HOME, '.dreamcontext', 'agents', 'scout', 'projects', key, 'output', 'scout');
    return existsSync(dir) ? readdirSync(dir).length : 0;
  });
  check('each run\'s output is in its own project\'s folder on this machine', outputs.length === 2 && outputs.every((n) => n === 1), JSON.stringify(outputs));

  console.log('\n── §5 the brains');
  for (const p of PROJECTS) {
    const named = brainPaths(join(p.path, '_dream_context')).filter((rel) => /scout|critic/i.test(rel));
    check(`${p.name}'s brain holds nothing of Scout or Critic`, named.length === 0, named.join(', '));
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed} passed, ${failed} failed`);
  console.log(`  screenshots: ${SHOTS}`);
  if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`FAIL  run crashed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
