#!/usr/bin/env node
/**
 * AI Team v2, wave A2: an agent's STAGE, its figure, its autonomy, account protection's settings
 * and Approve on an agent-opened task, proven in the real app.
 *
 *   npm run build && node scripts/verify/ai-team-stage.mjs
 *
 * WHAT IT DRIVES: the BUILT dashboard server against an isolated scratch vault (fake HOME,
 * DREAMCONTEXT_DESKTOP=1), real Chromium, and a scripted stand-in for `claude` that answers every
 * message with who it is and the permission mode it was spawned with. No tokens are spent.
 * Fixtures are fictional (a project called "Lumen Notes").
 *
 *   §1 server: a stage chat is spawned at its agent's level (Balanced → auto, Free →
 *      bypassPermissions, even with the pane's bypass flag off/on); the first accepted stage
 *      conversation is recorded once as the home session, machine-locally, nothing under state/.
 *   §2 browser, light and dark × 1440 and 390: the roster and the stage draw figures; the
 *      stand-in's answer streams into the centre card; a running routine and a delivery that
 *      opens in-app are on the cards; at 390 the cards wait behind "Cards".
 *   §3 browser: Autonomy set to Ask in the Edit dialog; the stage chip follows; the next chat runs
 *      in `default` mode.
 *   §4 browser: Only mine and the threshold persist across a reload; the waiting line shows the
 *      wake time.
 *   §5 browser: Approve on an agent-opened task folds the strip into chips, survives a reload,
 *      and Object is still reachable from ⋯.
 *   §6 browser: with the home conversation held by another live socket, the stage offers
 *      "Open its tab" instead of a second process.
 *
 * Screenshots: tmp/verify-ai-team-stage/<name>.png. Collect, don't fail fast; exit 1 on any FAIL,
 * console error or failed request.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = join(REPO, 'tmp', 'verify-ai-team-stage');
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-ai-team-stage');
rmSync(SCRATCH, { recursive: true, force: true });
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'lumen');
const DC = join(PROJ, '_dream_context');
const ECHO = '<<<DC-STAGE-ECHO>>>';
const TASK = 'retry-the-failed-sync-once';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`);
};

// ─── The stand-in claude ─────────────────────────────────────────────────────

const STANDIN = `#!${process.execPath}
import { readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? null); };
const briefPath = flag('--append-system-prompt-file');
let briefing = '';
if (briefPath) { try { briefing = readFileSync(briefPath, 'utf-8'); } catch { briefing = ''; } }
const report = { permissionMode: flag('--permission-mode'), autonomy: (briefing.match(/YOUR AUTONOMY: (\\w+)/) || [])[1] || null };
const sid = flag('--session-id') || flag('--resume') || 'verify-stage';
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
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: report.permissionMode, slash_commands: [] });
    const who = (briefing.match(/You are "([^"]+)"/) || [])[1] || 'Claude';
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I am ' + who + '. ' + ${JSON.stringify(ECHO)} + JSON.stringify(report) }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: n, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const cli = (...args) => spawnSync(process.execPath, [distIndex(REPO), ...args], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
const must = (label, r) => { if (r.status !== 0) throw new Error(`${label} failed: ${r.stderr || r.stdout}`); return r; };

function setupScratch() {
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(DC, 'state'), join(DC, 'knowledge'), join(DC, 'automations', 'output', 'scout')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(DC, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false } }));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true,
    screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  must('vaults add', cli('vaults', 'add', 'lumen', PROJ));

  must('agents create scout', cli('agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'Watches the Lumen Notes sync and reports what broke.'));
  must('agents create roamer', cli('agents', 'create', 'roamer', '--title', 'Roamer', '--prompt', 'Tidies the Lumen Notes docs on its own.'));
  must('agents edit roamer', cli('agents', 'edit', 'roamer', '--autonomy', 'free'));
  must('routine', cli('automations', 'create', 'scout-daily', '--title', 'Morning sync check', '--agent', 'scout', '--job', 'Check last night\'s sync.', '--days', 'daily', '--at', '08:00'));

  writeFileSync(join(DC, 'knowledge', 'sync-outage-10-23.md'), '# Sync outage 10-23\n\nThree lessons failed to sync between 22:00 and 22:25.\n');
  writeFileSync(join(DC, 'automations', 'output', 'scout', 'sync-errors.csv'), 'time,lesson,error\n22:01,Algebra 1,timeout\n');
  must('post 1', cli('automations', 'post', '--file', 'automations/output/scout/sync-errors.csv', '--run', '2026-10-24T08:00:00.000Z', 'scout-daily', '--', '- 3 lessons failed to sync last night\n- all between 22:00 and 22:25'));
  must('post 2', cli('automations', 'post', '--file', 'knowledge/sync-outage-10-23.md', '--run', '2026-10-24T09:00:00.000Z', 'scout', '--', '- Outage report written'));

  // A routine running right now: its run lock, held by this (live) process.
  mkdirSync(join(DC, 'automations', 'cache'), { recursive: true });
  writeFileSync(join(DC, 'automations', 'cache', '.scout-daily.lock'), JSON.stringify({ pid: process.pid, at: Date.now() - 4 * 60_000 }));

  // A task an agent opened.
  mkdirSync(join(DC, 'overrides'), { recursive: true });
  writeFileSync(join(DC, 'state', `${TASK}.md`), [
    '---', `id: task_retrysync`, `name: Retry the failed sync once`, "description: ''", 'priority: high', 'urgency: medium', 'status: todo',
    "created_at: '2026-10-24'", "updated_at: '2026-10-24'", 'tags: []', 'parent_task: null', 'related_feature: null', 'version: null',
    'filed_by: agent', 'filing_basis:', '  kind: ask', "  quote: 'when a sync fails at night, retry it once before telling me'", '  session: s1', "  at: '2026-10-24'", '  verified: true',
    '---', '', '## Why', '', 'A failed night sync waits for the owner until morning.', '',
  ].join('\n'));

  // Two connected accounts, and unattended work waiting for one until two hours from now.
  const accounts = ['owner-example-test', 'team-example-test'].map((id, i) => {
    const dir = join(HOME, '.dreamcontext', 'claude-accounts', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${id.split('-')[0]}@example.test` } }));
    return { id, accountUuid: '', email: `${id.split('-')[0]}@example.test`, organizationUuid: '', organizationName: 'Lumen Notes', tier: 'max', configDir: dir, preferred: i === 0 };
  });
  writeFileSync(join(HOME, '.dreamcontext', 'claude-accounts.json'), `${JSON.stringify({ accounts }, null, 2)}\n`);
  writeFileSync(join(HOME, '.dreamcontext', 'automations-account-wait.json'), JSON.stringify({ wakeAt: Date.now() + 2 * 3_600_000, at: Date.now() }));
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
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [distIndex(REPO), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
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

/** One WS chat open: resolves with the echo, a refusal, or a meta error. `hold` keeps it open. */
async function openChat(WebSocket, port, params, { hold = false } = {}) {
  const qs = new URLSearchParams({ vault: 'lumen', bypass: '0', ...params }).toString();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/chat?${qs}`, { headers: { origin: `http://127.0.0.1:${port}` } });
  return await new Promise((resolve) => {
    const timer = setTimeout(() => done({ kind: 'timeout' }), 20_000);
    function done(r) { clearTimeout(timer); if (!hold) { try { ws.close(); } catch { /* closing */ } } resolve({ ...r, ws }); }
    ws.on('unexpected-response', (_req, res) => done({ kind: 'refused', status: res.statusCode }));
    ws.on('error', (err) => done({ kind: 'error', message: String(err) }));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'user', text: 'GO' })));
    ws.on('message', (raw) => {
      let f; try { f = JSON.parse(raw.toString('utf-8')); } catch { return; }
      if ((f?.type === '_meta' || f?.type === 'dc_meta') && f.subtype === 'error') { done({ kind: 'meta-error', message: f.message, code: f.code }); return; }
      const text = f?.type === 'assistant' ? (f.message?.content ?? []).map((b) => b.text ?? '').join('') : '';
      const at = text.indexOf(ECHO);
      if (at >= 0) done({ kind: 'echo', ...JSON.parse(text.slice(at + ECHO.length)) });
    });
  });
}

const stageFile = () => join(HOME, '.dreamcontext', 'local', createHash('sha256').update(realpathSync(PROJ), 'utf8').digest('hex').slice(0, 16), 'agent-stage.json');
const readStage = () => (existsSync(stageFile()) ? JSON.parse(readFileSync(stageFile(), 'utf-8')) : { agents: {} });

// ─── §1 the server ───────────────────────────────────────────────────────────

async function serverLeg(WebSocket, port) {
  console.log('\n── §1 the stage chat envelope');
  const stateBefore = readdirSync(join(DC, 'state')).sort().join(',');
  const roamerHome = crypto.randomUUID();
  const roamer = await openChat(WebSocket, port, { chatAgent: 'roamer', stage: '1', sessionId: roamerHome });
  check('a Free agent\'s stage chat runs bypassPermissions with the pane flag off', roamer.kind === 'echo' && roamer.permissionMode === 'bypassPermissions', JSON.stringify({ kind: roamer.kind, mode: roamer.permissionMode }));
  check('…and its briefing carries the Free brief', roamer.autonomy === 'Free', roamer.autonomy);
  const scoutBypass = await openChat(WebSocket, port, { chatAgent: 'scout', bypass: '1', sessionId: crypto.randomUUID() });
  check('a Balanced agent runs auto even when the pane asks for bypass', scoutBypass.kind === 'echo' && scoutBypass.permissionMode === 'auto', scoutBypass.permissionMode);
  check('the first accepted stage conversation is the home session', readStage().agents?.roamer?.homeSessionId === roamerHome, JSON.stringify(readStage()));
  await new Promise((r) => setTimeout(r, 1500));
  await openChat(WebSocket, port, { chatAgent: 'roamer', stage: '1', sessionId: crypto.randomUUID() });
  check('…recorded once: a second stage conversation keeps the first', readStage().agents?.roamer?.homeSessionId === roamerHome);
  // Any chat leaves its context-watch handoff under state/ (context-watch.ts); the stage itself adds
  // nothing there: its home session lives in the machine-local store only.
  const stateAfter = readdirSync(join(DC, 'state')).filter((f) => f !== '.context-watch').sort().join(',');
  const grepState = spawnSync('grep', ['-rl', roamerHome, join(DC, 'state')], { encoding: 'utf-8' }).stdout.split('\n').filter((f) => f && !f.includes('/.context-watch/'));
  check('the stage adds nothing under _dream_context/state/', stateAfter === stateBefore.split(',').filter((f) => f !== '.context-watch').join(',') && grepState.length === 0, grepState.join(' '));
  const stage = await (await fetch(`http://127.0.0.1:${port}/api/agents/scout/stage`)).json();
  const s = stage.stage ?? {};
  check('the stage route answers with every card', s.slug === 'scout' && s.autonomy === 'balanced' && s.liveJobs?.length === 1 && s.files?.length === 2 && s.reports?.length === 2 && s.routines?.length === 1,
    JSON.stringify({ live: s.liveJobs?.length, files: s.files?.map((f) => f.kind), reports: s.reports?.length, routines: s.routines?.length }));
}

// ─── §2-§6 the browser ───────────────────────────────────────────────────────

async function browserLeg(WebSocket, port, consoleErrors, failedRequests) {
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      for (const width of [1440, 390]) {
        const tag = `${width}-${theme}`;
        const phone = width === 390;
        const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: 2 });
        await setTheme(context, theme);
        await markAnnouncementsSeen(context, base);
        await context.addInitScript(() => { window.confirm = () => { window.__confirms = (window.__confirms ?? 0) + 1; return true; }; });
        const page = await context.newPage();
        page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${tag}: ${m.text()}`); });
        page.on('pageerror', (e) => consoleErrors.push(`${tag} pageerror: ${e.message}`));
        page.on('requestfailed', (r) => { if (!/\/api\/agent\/chat/.test(r.url())) failedRequests.push(`${tag}: ${r.failure()?.errorText} ${r.url()}`); });
        const wait = (ms) => page.waitForTimeout(ms);
        const until = async (fn, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(150); } return false; };
        const shot = async (name) => { await wait(500); await page.screenshot({ path: join(SHOTS, `${tag}-${name}.png`) }); };
        /** One part of the page, scrolled into view first (a settings block, a dialog field). */
        const shotOf = async (sel, name) => {
          const el = page.locator(sel).first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await wait(400);
          await el.screenshot({ path: join(SHOTS, `${tag}-${name}.png`) });
        };
        /** Reload once the page is quiet, so no request of its own is cut off by the reload. */
        const reload = async () => { await page.waitForLoadState('networkidle').catch(() => {}); await page.reload({ waitUntil: 'domcontentloaded' }); };
        const nav = async (label) => {
          if (phone) { const menu = page.locator('.phone-bar button').first(); if (await menu.count()) { await menu.click(); await wait(400); } }
          await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: new RegExp(`^${label}$`) }) }).first().click();
          await wait(800);
        };
        const goHome = async () => {
          await page.goto(`${base}/?vault=lumen`, { waitUntil: 'domcontentloaded' });
          await wait(2000);
          for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await wait(300); }
        };

        console.log(`\n── §2 the stage @${tag}`);
        await goHome();
        await nav('AI Team');
        await page.locator('.aiteam').waitFor({ timeout: 15000 });
        const rosterFigures = await page.locator('.aiteam-roster .agent-figure').count();
        check(`${tag}: the roster draws figures`, rosterFigures >= 2, String(rosterFigures));
        if (phone) {
          await shot('1-list');
          await page.locator('[data-team-row="scout"]').click();
        } else {
          await page.locator('[data-team-row="scout"]').click();
        }
        const stageUp = await until(() => page.locator('.aiteam-stage[data-stage="scout"]').isVisible());
        check(`${tag}: Scout opens on its stage`, stageUp);
        const tone = await page.locator('.aiteam-stage-head .agent-figure').first().evaluate((el) => getComputedStyle(el).getPropertyValue('--fc-body') && getComputedStyle(el.querySelector('*')).fill).catch(() => '');
        check(`${tag}: the stage header wears its figure in a theme tone`, /rgb/.test(tone), tone);
        // Looking at a teammate starts nothing; the card is the way in.
        const sessionsBefore = (await (await fetch(`${base}/api/agent/live-chats?vault=lumen`)).json().catch(() => ({}))).chats?.length ?? null;
        check(`${tag}: opening the stage spawns nothing until the card is clicked`, await page.locator('[data-stage-start]').isVisible(), `live chats: ${sessionsBefore}`);
        if (!phone) await shot('0-stage-before-talk');
        await page.locator('[data-stage-start]').click();
        const input = page.locator('.aiteam-stage-chat .chat-cmp-input').first();
        const inputUp = await until(() => input.isVisible(), 20000);
        check(`${tag}: the centre card is a live chat`, inputUp);
        await input.click();
        await page.keyboard.type('What broke last night?');
        await page.keyboard.press('Enter');
        const answered = await until(async () => (await page.locator('.aiteam-stage-chat').innerText()).includes('I am Scout'), 20000);
        const chatText = await page.locator('.aiteam-stage-chat').innerText().catch(() => '');
        check(`${tag}: the stand-in's answer streams into the centre card`, answered, chatText.replace(/\s+/g, ' ').slice(-160));
        const echoed = /"permissionMode":"(\w+)"/.exec(chatText)?.[1];
        check(`${tag}: …spawned at its level (${theme === 'light' && !phone ? 'auto' : 'default'})`, echoed === (theme === 'light' && !phone ? 'auto' : 'default'), echoed);
        if (phone) {
          const sideHidden = !(await page.locator('.aiteam-stage-side').isVisible());
          check(`${tag}: at 390 the chat fills the stage, the cards wait`, sideHidden);
          await shot('2-stage-chat');
          await page.locator('.aiteam-stage-head .aiteam-pill').click();
          await until(() => page.locator('.aiteam-stage-side').isVisible());
        }
        const running = await page.locator('.aiteam-card--running').innerText().catch(() => '');
        check(`${tag}: the running routine is on a card`, /Morning sync check/.test(running) && /working/i.test(running), running.replace(/\s+/g, ' '));
        const files = page.locator('.aiteam-card--file');
        check(`${tag}: the deliveries are on cards`, (await files.count()) === 2);
        await shot(phone ? '3-stage-cards' : '1-stage');
        if (!phone) {
          // The side panel beside the stage: the conversation keeps a usable width.
          await page.locator('.aiteam-stage-head .aiteam-pill').last().click();
          await page.locator('.aiteam-panel').first().waitFor({ timeout: 10000 });
          await wait(500);
          const chatW = await page.locator('.aiteam-stage-chat').evaluate((el) => el.getBoundingClientRect().width);
          check(`${tag}: with the panel open the chat keeps its width (${Math.round(chatW)} px)`, chatW >= 380);
          await shot('1b-stage-with-panel');
          await page.locator('.aiteam-panel-close').first().click();
          await wait(400);
        }
        await files.filter({ hasText: 'sync-outage-10-23.md' }).first().click();
        const opened = await until(() => page.locator('button', { hasText: 'Copy path' }).first().isVisible(), 8000);
        check(`${tag}: a delivery opens in the app`, opened);
        await shot('4-delivery-open');
        await page.keyboard.press('Escape');
        await wait(500);

        if (theme === 'light' && !phone) {
          console.log(`\n── §3 autonomy @${tag}`);
          await page.locator('.aiteam-stage-head .aiteam-autonomy').click();
          await page.locator('.aid-segment[data-autonomy="ask"]').waitFor({ timeout: 10000 });
          await shotOf('.aid-autonomy', '5-autonomy-dialog');
          await page.locator('.aid-segment[data-autonomy="ask"]').click();
          await page.locator('.aid-btn--primary').click();
          const chip = await until(async () => /Ask/.test(await page.locator('.aiteam-stage-head .aiteam-autonomy').innerText()), 10000);
          check(`${tag}: the stage chip follows the dialog (Autonomy: Ask)`, chip, await page.locator('.aiteam-stage-head .aiteam-autonomy').innerText().catch(() => ''));
          const agentFile = readFileSync(join(DC, 'agents', 'scout.md'), 'utf-8');
          check(`${tag}: the level is saved in the agent's file`, /^autonomy: ask$/m.test(agentFile));
          // The live conversation is respawned at the new level: the next answer runs `default`.
          await wait(1500);
          const input2 = page.locator('.aiteam-stage-chat .chat-cmp-input').first();
          if (!(await until(() => input2.isVisible(), 20000))) {
            await shot('debug-after-autonomy');
            console.log('stage chat after the level change:', (await page.locator('.aiteam-stage-chat').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
          }
          await input2.click();
          await page.keyboard.type('And now?');
          await page.keyboard.press('Enter');
          const modes = async () => [...(await page.locator('.aiteam-stage-chat').innerText()).matchAll(/"permissionMode":"(\w+)"/g)].map((m) => m[1]);
          const respawned = await until(async () => (await modes()).at(-1) === 'default', 20000);
          check(`${tag}: after Ask, the stage conversation runs in default mode`, respawned, (await modes()).join(','));
          await shot('6-autonomy-chip');

          console.log(`\n── §4 accounts @${tag}`);
          await nav('Settings');
          await page.locator('.settings-nav-item', { hasText: /^Chat/ }).first().click();
          // The panel probes stale usage once on open: let it finish, a reload must not cut it off.
          await until(async () => /could not be re-read|Updated \d+ account/.test(await page.locator('.dc-acct-foot, .settings-section').first().innerText()), 30000);
          await page.locator('[data-only-mine="team-example-test"]').waitFor({ timeout: 10000 });
          // Controlled by the server's answer: it shows checked once the save came back.
          await page.locator('[data-only-mine="team-example-test"]').click();
          await until(() => page.locator('[data-only-mine="team-example-test"]').isChecked(), 8000);
          const thr = page.locator('.dc-acct-threshold-input');
          await thr.fill('70');
          await thr.press('Enter');
          await wait(800);
          await reload();
          await wait(2000);
          await nav('Settings');
          await page.locator('.settings-nav-item', { hasText: /^Chat/ }).first().click();
          // The panel probes stale usage once on open: let it finish, a reload must not cut it off.
          await until(async () => /could not be re-read|Updated \d+ account/.test(await page.locator('.dc-acct-foot, .settings-section').first().innerText()), 30000);
          await page.locator('[data-only-mine="team-example-test"]').waitFor({ timeout: 10000 });
          check(`${tag}: Only mine persists across a reload`, await page.locator('[data-only-mine="team-example-test"]').isChecked());
          check(`${tag}: the threshold persists across a reload`, (await page.locator('.dc-acct-threshold-input').inputValue()) === '70');
          const reg = JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'claude-accounts.json'), 'utf-8'));
          check(`${tag}: …both on disk`, reg.agentThreshold === 70 && reg.accounts.find((a) => a.id === 'team-example-test')?.ownerOnly === true);
          // Saving a setting clears the wait (the usable accounts changed): put one back to see the line.
          writeFileSync(join(HOME, '.dreamcontext', 'automations-account-wait.json'), JSON.stringify({ wakeAt: Date.now() + 2 * 3_600_000, at: Date.now() }));
          await reload();
          await wait(2000);
          await nav('Settings');
          await page.locator('.settings-nav-item', { hasText: /^Chat/ }).first().click();
          // The panel probes stale usage once on open: let it finish, a reload must not cut it off.
          await until(async () => /could not be re-read|Updated \d+ account/.test(await page.locator('.dc-acct-foot, .settings-section').first().innerText()), 30000);
          const waitLine = await until(() => page.locator('[data-agent-wait]').isVisible(), 10000);
          const waitText = await page.locator('[data-agent-wait]').innerText().catch(() => '');
          check(`${tag}: the waiting line shows the wake time`, waitLine && /Agent jobs waiting · wakes \d{1,2}:\d{2}/.test(waitText), waitText);
          await shotOf('.dc-acct-policy', '7-accounts');
          await shotOf('.dc-acct-list', '7b-accounts-only-mine');

          console.log(`\n── §5 approve @${tag}`);
          await nav('Tasks');
          await until(async () => (await page.locator('.bd-card').count()) > 0, 15000);
          await page.locator(`.bd-card[data-task-slug="${TASK}"]`).first().click({ position: { x: 24, y: 14 } });
          await until(async () => (await page.locator('.detail-panel').count()) === 1);
          await page.locator('[data-testid="approve-btn"]').waitFor({ timeout: 10000 });
          await shot('8-approve-before');
          await page.locator('[data-testid="approve-btn"]').click();
          const folded = await until(() => page.locator('[data-testid="filing-approved"]').isVisible());
          check(`${tag}: Approve folds the strip into chips`, folded, await page.locator('[data-testid="filing-approved"]').innerText().catch(() => ''));
          const card = readFileSync(join(DC, 'state', `${TASK}.md`), 'utf-8');
          check(`${tag}: …the status is unchanged and the approval recorded`, /^status: todo$/m.test(card) && /filing_approved:/.test(card) && /Approved \(owner\)/.test(card));
          await reload();
          await wait(2000);
          await nav('Tasks');
          await until(async () => (await page.locator('.bd-card').count()) > 0, 15000);
          await page.locator(`.bd-card[data-task-slug="${TASK}"]`).first().click({ position: { x: 24, y: 14 } });
          await until(async () => (await page.locator('.detail-panel').count()) === 1);
          check(`${tag}: the chips survive a reload`, await until(() => page.locator('[data-testid="filing-approved"]').isVisible()));
          await page.locator('[data-testid="filing-approved"] [aria-haspopup="menu"]').click();
          check(`${tag}: Object is still reachable from ⋯`, await until(() => page.locator('[data-testid="object-btn"]').isVisible()));
          await shot('9-approve-after');
          await page.keyboard.press('Escape');
        }

        if (theme === 'dark' && !phone) {
          console.log(`\n── §6 held elsewhere @${tag}`);
          // The home session of Roamer, held by another live socket (as a Chat tab would hold it).
          const home = readStage().agents?.roamer?.homeSessionId;
          const held = await openChat(WebSocket, port, { chatAgent: 'roamer', resume: home }, { hold: true });
          check(`${tag}: another socket holds Roamer's home conversation`, held.kind === 'echo', held.kind);
          await goHome();
          await nav('AI Team');
          await page.locator('[data-team-row="roamer"]').click();
          const offered = await until(() => page.locator('.aiteam-stage-note button', { hasText: 'Open its tab' }).isVisible(), 15000);
          check(`${tag}: the stage offers "Open its tab" instead of a second process`, offered);
          await shot('10-held');
          try { held.ws.close(); } catch { /* closing */ }
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

let server;
const consoleErrors = [];
const failedRequests = [];
try {
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  check('server boots', true);
  const { WebSocket } = await import('ws');
  await serverLeg(WebSocket, port);
  await browserLeg(WebSocket, port, consoleErrors, failedRequests);
} catch (err) {
  check('the run completes', false, String(err?.stack ?? err).slice(0, 600));
} finally {
  server?.kill();
}

console.log(`\nscreenshots: ${SHOTS}`);
for (const f of readdirSync(SHOTS).sort()) console.log(`  ${join(SHOTS, f)}`);
console.log(`console errors: ${consoleErrors.length}${consoleErrors.length ? `\n  ${consoleErrors.join('\n  ')}` : ''}`);
console.log(`failed requests: ${failedRequests.length}${failedRequests.length ? `\n  ${failedRequests.join('\n  ')}` : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length || consoleErrors.length || failedRequests.length ? 1 : 0);
