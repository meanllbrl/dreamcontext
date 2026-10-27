#!/usr/bin/env node
/**
 * AI Team history: an agent's pane shows ONE continuous, paged history of all its sessions —
 * proven in the real app (task ai-team-an-agent-s-pane-shows-one-continuous-paged-history-…).
 *
 *   npm run build && node e2e/aiteam-history-shots.mjs
 *
 * WHAT IT DRIVES: the BUILT dashboard server against an isolated scratch vault (fake HOME,
 * DREAMCONTEXT_DESKTOP=1), real Chromium at 1440 and 390 px, and a scripted stand-in for `claude`
 * (no tokens). Fixtures are fictional: "Herodot", the agent of a project called "Acme Notes".
 *
 * The agent has 3 days of routine runs (plus ten older days, so the history pages), a talk with the
 * owner yesterday, and 3 unread messages today. Checked at each width:
 *   - the pane shows day rules, session boundaries, the "3 new" divider at the top of the viewport,
 *     and "New conversation · now" above the composer (no "resumed" divider);
 *   - scrolling up loads an older page with no jump (first visible row moves < 2 px), until
 *     "Start of Herodot's history";
 *   - the roster badge clears after reading (within one feed poll);
 *   - a message sent lands at the bottom of the same flow;
 *   - no console errors.
 *
 * Screenshots: tmp/verify-aiteam-history/<width>-<name>.png. Exit 1 on any FAIL.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, setTheme } from '../scripts/verify/lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(REPO, 'tmp', 'verify-aiteam-history');
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-aiteam-history');
rmSync(SCRATCH, { recursive: true, force: true });
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme');
const DC = join(PROJ, '_dream_context');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`);
};

const STANDIN = `#!${process.execPath}
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? null); };
const sid = flag('--session-id') || flag('--resume') || 'verify-history';
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    // Like the real CLI: the conversation's transcript is written once it has a turn.
    const dir = join(process.env.HOME, '.claude', 'projects', '-fictional-acme');
    mkdirSync(dir, { recursive: true });
    const said = typeof o.message?.content === 'string' ? o.message.content : (o.message?.content ?? []).map((b) => b.text ?? '').join('');
    const now = new Date().toISOString();
    appendFileSync(join(dir, sid + '.jsonl'), JSON.stringify({ type: 'user', uuid: 'u' + Date.now(), timestamp: now, message: { content: said || 'hi' } }) + '\\n'
      + JSON.stringify({ type: 'assistant', timestamp: now, message: { content: [{ type: 'text', text: 'Done: the Acme summary is posted.' }] } }) + '\\n');
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: the Acme summary is posted.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const cli = (...args) => spawnSync(process.execPath, [distIndex(REPO), ...args], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
const must = (label, r) => { if (r.status !== 0) throw new Error(`${label} failed: ${r.stderr || r.stdout}`); return r; };

let seq = 0;
const RUNS = {};
/** A sortable thread entry id for an instant (the store's own shape). */
const idAt = (ms) => `${Math.floor(ms).toString(36).padStart(9, '0')}_${(seq++ % 1296).toString(36).padStart(2, '0')}v${String(seq).padStart(3, '0')}`;
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const files = new Map();
function entry(slug, at, e) {
  const d = new Date(at);
  const path = join(DC, 'automations', 'threads', slug, `${localDay(d)}.md`);
  const full = { id: idAt(at), via: 'runner', text: '', ...e, at: d.toISOString() };
  files.set(path, `${files.get(path) ?? ''}<!-- dc-thread-entry -->\n\`\`\`json\n${JSON.stringify(full)}\n\`\`\`\n\n`);
  return full;
}
/** A run at local `daysAgo` + hh:mm: started, its posts, ok. */
function run(slug, daysAgo, hh, mm, posts) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, 0, 0);
  const t = d.getTime();
  const runId = d.toISOString();
  entry(slug, t, { runId, kind: 'system', event: 'started' });
  let last = null;
  posts.forEach((text, i) => { last = entry(slug, t + 60_000 * (i + 1), { runId, kind: 'agent', text }); });
  const done = entry(slug, t + 60_000 * (posts.length + 1), { runId, kind: 'system', event: 'ok' });
  return { runId, last: last ?? done, done };
}

function setupScratch() {
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(DC, 'state'), join(DC, 'knowledge')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(DC, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false } }));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true,
    screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  must('vaults add', cli('vaults', 'add', 'acme', PROJ));
  must('agents create', cli('agents', 'create', 'herodot', '--title', 'Herodot', '--prompt', 'Herodot summarises the fictional Acme channel.'));
  must('agents create galileo', cli('agents', 'create', 'galileo', '--title', 'Galileo', '--prompt', 'Galileo watches the fictional Acme competitors.'));
  must('routine', cli('automations', 'create', 'herodot-daily', '--title', 'Herodot daily', '--agent', 'herodot', '--job', 'Summarise yesterday in #acme.', '--days', 'daily', '--at', '09:00'));

  // Ten older days (so the history pages), then the last three days.
  for (let d = 12; d >= 3; d--) run('herodot-daily', d, 9, 0, [`Day ${d} ago: #acme was quiet, nothing to act on.`]);
  run('herodot-daily', 2, 9, 0, ['Morning round: 6 new messages in #acme, nothing needs action.']);
  const read = RUNS.yesterday = run('herodot-daily', 1, 12, 0, ['Yesterday\'s thread decided: the player "skip" button moves to 15 s. I opened `acme-player-skip`.']);
  run('herodot-daily', 0, 9, 0, ['Morning round: 6 new messages in #acme, no action needed.']);
  RUNS.today = run('herodot-daily', 0, 12, 28, ['Anil wants a roadmap: skip/quotes done, video series, story mode, leaderboard, mascot.', 'Draft: `roadmap/acme-q4.md`. Approve it and I post the summary to Slack.']);
  for (const [path, text] of files) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
  // Read up to yesterday's run: today's two runs are the 3 unread messages.
  // Keyed by the project root as the server spells it (the vault's path, and its realpath).
  const mark = { 'herodot-daily': read.done.id };
  writeFileSync(join(HOME, '.dreamcontext', 'automations-threads-read.json'), JSON.stringify({ [PROJ]: mark, [realpathSync(PROJ)]: mark }));

  // A talk with the owner yesterday at 18:42, on this machine.
  const talkId = randomUUID();
  const started = new Date(); started.setDate(started.getDate() - 1); started.setHours(18, 42, 0, 0);
  const key = createHash('sha256').update(realpathSync(PROJ), 'utf8').digest('hex').slice(0, 16);
  const local = join(HOME, '.dreamcontext', 'local', key);
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, 'agent-sessions.json'), JSON.stringify({ agents: { herodot: [{ id: talkId, at: started.toISOString(), kind: 'stage', hadTurns: true }] } }));
  const tdir = join(HOME, '.claude', 'projects', '-fictional-acme');
  mkdirSync(tdir, { recursive: true });
  const tpath = join(tdir, `${talkId}.jsonl`);
  writeFileSync(tpath, [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: started.toISOString(), message: { content: 'Can you add this decision to the roadmap?' } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(started.getTime() + 20_000).toISOString(), message: { content: [{ type: 'text', text: 'Done: it is under **Q4 · Player** in the roadmap, with yesterday\'s thread as its source.' }] } }),
  ].join('\n') + '\n');
  const end = new Date(started.getTime() + 60_000);
  utimesSync(tpath, end, end);
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

async function browserLeg(port, consoleErrors) {
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    // The phone first: the desktop pass ends with steps that change the history (new posts).
    for (const width of [390, 1440]) {
      const tag = String(width);
      const phone = width === 390;
      // Each width starts with the same 3 unread (the previous width's reading cleared them).
      writeFileSync(join(HOME, '.dreamcontext', 'automations-threads-read.json'), READ_BACK);
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: 'light', deviceScaleFactor: 2 });
      await setTheme(context, 'light');
      await markAnnouncementsSeen(context, base);
      const page = await context.newPage();
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${tag}: ${m.text()}`); });
      page.on('pageerror', (e) => consoleErrors.push(`${tag} pageerror: ${e.message}`));
      const wait = (ms) => page.waitForTimeout(ms);
      const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(200); } return false; };
      const shot = async (name) => { await wait(400); await page.screenshot({ path: join(SHOTS, `${tag}-${name}.png`) }); };

      console.log(`\n── @${tag}`);
      await page.goto(`${base}/?vault=acme`, { waitUntil: 'domcontentloaded' });
      await wait(2000);
      for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await wait(300); }
      if (phone) { const menu = page.locator('.phone-bar button').first(); if (await menu.count()) { await menu.click(); await wait(400); } }
      await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^AI Team$/ }) }).first().click();
      await page.locator('.aiteam').waitFor({ timeout: 15000 });
      const badge = page.locator('[data-team-row="herodot"] .sidebar-badge');
      check(`${tag}: the roster badge says 3 before reading`, await until(async () => (await badge.innerText()).trim() === '3'), await badge.innerText().catch(() => 'none'));
      if (phone) { await shot('0-list'); await page.locator('[data-team-row="herodot"]').click(); }
      else await page.locator('[data-team-row="herodot"]').click();

      const pane = page.locator('.aiteam-stage .chat-pane');
      const scroller = page.locator('.aiteam-stage .chat-scroll');
      check(`${tag}: the stage opens (not the activity)`, await until(() => page.locator('.aiteam-stage[data-stage="herodot"]').isVisible()));
      const divider = page.locator('.aiteam-stage [data-feed-divider]');
      check(`${tag}: the "3 new" divider is drawn`, await until(async () => /3 new/.test(await divider.innerText()), 20000), await divider.innerText().catch(() => ''));
      await wait(800);
      const dividerTop = await divider.evaluate((el) => {
        const sc = el.closest('.chat-scroll');
        return el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      });
      check(`${tag}: …at the top of the viewport (${Math.round(dividerTop)} px from the top)`, dividerTop >= -2 && dividerTop < 120);
      await shot('1-unread-divider');

      const days = await page.locator('.aiteam-stage [data-feed-day]').allInnerTexts();
      check(`${tag}: day rules (Today / Yesterday / …)`, days.includes('Today') && days.includes('Yesterday'), days.join(' | '));
      const bounds = await page.locator('.aiteam-stage [data-feed-boundary]').allInnerTexts();
      check(`${tag}: one boundary per session, with label and duration`, bounds.some((b) => /Herodot daily ran · .* · \d+ min/.test(b)) && bounds.some((b) => /Conversation with you · /.test(b)), bounds.slice(-4).join(' | '));
      check(`${tag}: "New conversation · now" above the live turns, no "resumed" divider`,
        (await page.locator('.aiteam-stage [data-feed-live]').innerText()).includes('New conversation · now')
          && !(await pane.innerText()).includes('earlier conversation ↑ · resumed'));
      check(`${tag}: past posts are read-only rows (no Edit, no Retry)`,
        (await page.locator('.aiteam-stage .chat-scroll [aria-label="Edit"], .aiteam-stage .chat-scroll [aria-label="Retry"]').count()) === 0);

      // Read down to the bottom: every unread run's end passes the viewport.
      for (let i = 0; i < 12; i++) { await scroller.evaluate((el) => { el.scrollTop += 220; }); await wait(250); }
      await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await shot('2-flow-bottom');
      const cleared = await until(async () => (await badge.count()) === 0, 30000);
      check(`${tag}: the roster badge clears after reading (within one feed poll)`, cleared, cleared ? '' : await badge.innerText().catch(() => ''));

      // Scroll up: older pages load with no jump, until the start of the history.
      const boundariesBefore = await page.locator('.aiteam-stage [data-feed-boundary]').count();
      let maxJump = 0;
      let loads = 0;
      for (let i = 0; i < 40; i++) {
        if (await page.locator('.aiteam-stage [data-feed-end]').count()) break;
        await scroller.evaluate((el) => { el.scrollTop = 0; });
        await wait(300);
        // The first boundary on screen, measured before and after the gesture lands a page.
        const probe = await scroller.evaluate((el) => {
          const top = el.getBoundingClientRect().top;
          const b = [...el.querySelectorAll('[data-feed-boundary]')].find((n) => n.getBoundingClientRect().bottom > top);
          return b ? { key: b.getAttribute('data-feed-boundary'), y: b.getBoundingClientRect().top - top } : null;
        });
        await scroller.hover();
        await page.mouse.wheel(0, -400);
        await wait(900);
        const after = probe ? await scroller.evaluate((el, key) => {
          const n = el.querySelector(`[data-feed-boundary="${CSS.escape(key)}"]`);
          return n ? n.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
        }, probe.key) : null;
        const count = await page.locator('.aiteam-stage [data-feed-boundary]').count();
        if (probe && after !== null && count > boundariesBefore + loads) {
          // A page landed: the row the reader looked at stays put (at scrollTop 0 the wheel itself moves nothing).
          maxJump = Math.max(maxJump, Math.abs(after - probe.y));
          loads = count - boundariesBefore;
        }
      }
      const end = await until(async () => (await page.locator('.aiteam-stage [data-feed-end]').count()) > 0, 8000);
      check(`${tag}: scrolling up loads older pages until "Start of Herodot's history"`, end && loads > 0,
        `${boundariesBefore} → ${await page.locator('.aiteam-stage [data-feed-boundary]').count()} boundaries`);
      check(`${tag}: …with no jump: the first visible row moves ${maxJump.toFixed(1)} px (< 2)`, maxJump < 2);
      await shot('3-older-page-start');

      // A boundary: the talk's.
      const talkB = page.locator('.aiteam-stage [data-feed-boundary^="talk::"]').first();
      await talkB.scrollIntoViewIfNeeded();
      await wait(300);
      await shot('4-session-boundary');

      // Send: lands at the bottom of the same flow.
      const input = page.locator('.aiteam-stage .chat-cmp-input').first();
      await input.click();
      await page.keyboard.type('I approve the draft, post the summary to Slack.');
      await page.keyboard.press('Enter');
      const answered = await until(async () => (await pane.innerText()).includes('Done: the Acme summary is posted.'), 20000);
      const order = await pane.evaluate((el) => {
        const live = el.querySelector('[data-feed-live]');
        const all = [...el.querySelectorAll('*')];
        // The newest copy: an earlier width's same message is already history above.
        const mine = all.filter((n) => n.textContent?.trim() === 'I approve the draft, post the summary to Slack.').pop();
        return !!live && !!mine && (live.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      check(`${tag}: a message sent lands at the bottom, under "New conversation · now"`, answered && order);
      await shot('5-sent');
      if (!phone) await deepLeg(page, pane, tag, wait, until, shot);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/** Criteria 11, 15, 16, 18 at 1440: live merges, boundary clicks, reopen vs continue, a respawn. */
async function deepLeg(page, pane, tag, wait, until, shot) {
  const boundaryKeys = () => page.locator('.aiteam-stage [data-feed-boundary]').evaluateAll((ns) => ns.map((n) => n.getAttribute('data-feed-boundary')));
  const todayKey = `herodot-daily::${RUNS.today.runId}`;
  const yKey = `herodot-daily::${RUNS.yesterday.runId}`;
  let historyReads = 0;
  page.on('request', (r) => { if (/\/api\/agents\/herodot\/history/.test(r.url())) historyReads++; });

  // AC15: a run that posts again while the pane is open: the post lands in place, under its run.
  must('post again', cli('automations', 'post', '--run', RUNS.today.runId, 'herodot-daily', '--', 'Second post: the Slack summary is ready.'));
  const inPlace = await until(async () => (await pane.innerText()).includes('Second post: the Slack summary is ready.'), 45000);
  const place = await pane.evaluate((el, key) => {
    const post = [...el.querySelectorAll('*')].find((n) => n.children.length === 0 && n.textContent?.includes('Second post: the Slack'));
    const b = el.querySelector(`[data-feed-boundary="${CSS.escape(key)}"]`);
    const live = el.querySelector('[data-feed-live]');
    const after = (a, z) => !!a && !!z && (a.compareDocumentPosition(z) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    return after(b, post) && after(post, live);
  }, todayKey);
  check(`${tag}: a second post of a run lands in place, under its run`, inPlace && place);
  // A late reply to yesterday's run moves that run to the end, above the live boundary.
  must('late reply', cli('automations', 'post', '--run', RUNS.yesterday.runId, 'herodot-daily', '--', 'Late follow-up: the skip change shipped.'));
  const moved = await until(async () => { const k = await boundaryKeys(); return k[k.length - 1] === yKey; }, 45000);
  check(`${tag}: a late reply moves its run to the end`, moved, (await boundaryKeys()).slice(-3).join(' | '));
  await shot('6-live-merge');

  // AC18: a run boundary lands the activity view on that run; back keeps the same session.
  await page.locator(`.aiteam-stage [data-feed-boundary="${todayKey}"]`).click();
  const landed = await until(async () => (await page.locator(`[data-item-key^="${todayKey}:"]`).count()) > 0, 10000);
  check(`${tag}: a run boundary click opens the activity at that run`, landed);
  await shot('7-run-boundary-activity');
  await page.locator('[data-team-stage]').click();
  const back = await until(async () => (await pane.innerText()).includes('I approve the draft, post the summary to Slack.'), 10000);
  check(`${tag}: stage → activity → back keeps the same session (its turn still live, no new boundary)`,
    back && (await page.locator('.aiteam-stage [data-feed-live]').innerText()).includes('New conversation · now'));

  // AC11: a level respawn keeps the loaded pages without refetch and reopens pinned.
  const rowsBefore = await page.locator('.aiteam-stage [data-feed-boundary]').count();
  const readsBefore = historyReads;
  await page.locator('.aiteam-stage .aiteam-convo-head .aiteam-autonomy').click();
  await page.locator('.aid-segment[data-autonomy="ask"]').waitFor({ timeout: 10000 });
  await page.locator('.aid-segment[data-autonomy="ask"]').click();
  await page.locator('.aid-btn--primary').click();
  await until(async () => /Ask/.test(await page.locator('.aiteam-stage .aiteam-convo-head .aiteam-autonomy').innerText()), 10000);
  await wait(2500);
  check(`${tag}: a level respawn keeps the loaded feed with no refetch, pinned to the bottom`,
    (await page.locator('.aiteam-stage [data-feed-boundary]').count()) === rowsBefore && historyReads === readsBefore
      && (await page.locator('.aiteam-stage .chat-jump').count()) === 0,
    `boundaries ${rowsBefore}→${await page.locator('.aiteam-stage [data-feed-boundary]').count()}, reads +${historyReads - readsBefore}`);

  // AC16: deselect an IDLE stage that had a turn and reopen: a new session, that talk above it.
  const talksBefore = (await boundaryKeys()).filter((k) => k.startsWith('talk::')).length;
  await page.locator('[data-team-row="galileo"]').click();
  await until(() => page.locator('.aiteam-stage[data-stage="galileo"]').isVisible());
  await page.locator('[data-team-row="herodot"]').click();
  const reopened = await until(async () => {
    const keys = await boundaryKeys();
    return keys.filter((k) => k.startsWith('talk::')).length === talksBefore + 1
      && (await page.locator('.aiteam-stage [data-feed-live]').innerText()).includes('New conversation · now');
  }, 15000);
  check(`${tag}: deselecting an idle stage and reopening starts a new session, its talk now history`, reopened, `talks ${talksBefore} → ${(await boundaryKeys()).filter((k) => k.startsWith('talk::')).length}`);
  await shot('8-reopened-new');
  // With a typed draft, the session is kept and continues, the draft still in the composer.
  const input = page.locator('.aiteam-stage .chat-cmp-input').first();
  await input.click();
  await page.keyboard.type('half a thought');
  await page.locator('[data-team-row="galileo"]').click();
  await until(() => page.locator('.aiteam-stage[data-stage="galileo"]').isVisible());
  await page.locator('[data-team-row="herodot"]').click();
  const continuing = await until(async () => /Continuing · started/.test(await page.locator('.aiteam-stage [data-feed-live]').innerText()), 15000);
  const draft = await page.locator('.aiteam-stage .chat-cmp-input').first().evaluate((el) => el.value ?? el.textContent ?? '');
  check(`${tag}: deselecting with a draft and reopening continues ("Continuing"), the draft kept`, continuing && draft.includes('half a thought'), draft);
  await shot('9-continuing');

  // AC18: a talk boundary opens that conversation in a Chat tab.
  await page.locator('.aiteam-stage [data-feed-boundary^="talk::"]').first().click();
  const tabbed = await until(async () => {
    const texts = await page.locator('.chat-pane').evaluateAll((ps) => ps.filter((p) => !p.closest('.aiteam-stage')).map((p) => p.innerText));
    return texts.some((t) => t.includes('Can you add this decision to the roadmap?'));
  }, 20000);
  check(`${tag}: a talk boundary click opens that conversation in a Chat tab`, tabbed);
  await shot('10-talk-in-chat');
}

let READ_BACK = '';
const consoleErrors = [];
let srv = null;
try {
  setupScratch();
  READ_BACK = (await import('node:fs')).readFileSync(join(HOME, '.dreamcontext', 'automations-threads-read.json'), 'utf-8');
  const port = await freePort();
  srv = await startServer(port);
  const hist = await (await fetch(`http://127.0.0.1:${port}/api/agents/herodot/history`)).json();
  check('server: page 1 holds 8 sessions, a cursor, and the 3 unread', hist.sessions?.length === 8 && !!hist.nextBefore && hist.unreadCount === 3,
    JSON.stringify({ n: hist.sessions?.length, next: !!hist.nextBefore, unread: hist.unreadCount }));
  await browserLeg(port, consoleErrors);
} catch (err) {
  check('the run completed', false, String(err?.stack ?? err));
} finally {
  srv?.kill();
}
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
