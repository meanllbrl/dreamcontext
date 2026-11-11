#!/usr/bin/env node
/**
 * Main's team card for a member that waits on the owner (2026-11-11, the owner's screenshots of a
 * member stuck on a real-purchase approval): the card on main's stage and its conversation.
 *
 *   npm run build && node scripts/verify/look-member-waiting.mjs [out-folder] [dist/index.js]
 *
 * A seeded scratch vault, no process of the member's: main's record holds the member's ONE card
 * with two jobs (an older request, done, as the chain root; a newer follow-up the member took),
 * the member's record holds both requests and an open refused call (the classifier's), and the
 * member's transcript holds only the newer exchange. Shots at 1440 and 390 px, light and dark:
 *   1-stage   main's stage with the card: "asks you", no spinner (was: "working" + spinner)
 *   2-card    the card opened: the conversation, and NO old request drawn under it as "waiting"
 * The second argument runs another build (the "before" shots). Fictional fixture names.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { applyTheme, cleanEnv, freePort, pageFetch, superStandin, toMainStage, until } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'member-waiting'));
const CLI = resolve(process.argv[3] || join(REPO, 'dist', 'index.js'));
const SCRATCH = join(tmpdir(), `dreamcontext-look-member-waiting-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const MAIN = '7a1c0de0-0000-4000-8000-00000000a001';
const MEMBER_SID = '7a1c0de0-0000-4000-8000-00000000b001';
const SLUG = 'quill';

// The dist is one bundle: these three are spelled here exactly as src/lib/super spells them
// (types.ts emptySuperState, store.ts memberTeamCardId, owner-wait.ts refusalWait).
const emptySuperState = () => ({ v: 1, session: null, enabled: false, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [] });
const memberTeamCardId = (member) => `team-${createHash('sha1').update(`member:${member}`).digest('hex').slice(0, 12)}`;
const refusalWait = (tool, input, reason) => ({
  kind: 'refusal', id: `rf-${createHash('sha256').update(`${tool}\n${input}`).digest('hex').slice(0, 16)}`,
  line: `${tool}: ${input}`.replace(/\s+/g, ' ').trim(), key: tool,
  refusal: { tool, input, whole: true, source: 'classifier', reason },
});

const env = (extra = {}) => cleanEnv(HOME, extra);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const DAY = 86_400_000;
const now = Date.now();

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state', '.super', 'members'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, superStandin({ reports: join(SCRATCH, 'reports.ndjson'), cli: CLI }));
  chmodSync(bin, 0o755);
  for (const r of [dc('vaults', 'add', VAULT, PROJ), dc('agents', 'create', SLUG, '--title', 'Quill · Checkout QA', '--prompt', 'Tests the checkout flows.')]) {
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  }
  const oldReq = { id: 'q-old-1', sessionId: MEMBER_SID, kind: 'request', state: 'done', createdAt: now - 5 * DAY, acceptedAt: now - 5 * DAY + 60_000,
    text: 'Owner-approved (6 Nov): buy the cheapest plan on Northwind, Contoso and Fabrikam with the QA card; no upsell, cancel and refund the same day.',
    result: 'Bought on Northwind and Contoso; Fabrikam stopped on a captcha.' };
  const newReq = { id: 'q-new-1', sessionId: MEMBER_SID, kind: 'request', state: 'delivered', createdAt: now - 20 * 60_000, acceptedAt: now - 19 * 60_000,
    text: 'Owner-approved (11 Nov): buy on Tailspin and Wingtip with the QA card; no upsell, cancel and refund the same day.' };
  const cmd = 'dreamcontext super delegate --prompt "Buy the cheapest plan on Tailspin and Wingtip with the QA card" 2>&1';
  const wait = refusalWait('Bash', cmd, 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Real-World Transactions].');
  const refusal = { id: 'q-ref-1', sessionId: MEMBER_SID, kind: 'owner', own: true, state: 'escalated', createdAt: now - 18 * 60_000, wait, ownerText: wait.line };
  const member = { ...emptySuperState(), session: MEMBER_SID, enabled: true, member: SLUG, queue: [oldReq, newReq, refusal] };
  writeFileSync(join(PROJ, '_dream_context', 'state', '.super', 'members', `${SLUG}.json`), JSON.stringify(member, null, 2));
  const root = { id: 'team-old-1', member: SLUG, runId: new Date(now - 5 * DAY).toISOString(), jobKind: 'run', queued: false, brief: 'Northwind, Contoso, Fabrikam purchase', startedAt: now - 5 * DAY, request: oldReq.id, told: 'done' };
  const follow = { id: 'team-new-1', member: SLUG, runId: new Date(now - 20 * 60_000).toISOString(), jobKind: 'run', queued: false, brief: 'Tailspin and Wingtip purchase', startedAt: now - 20 * 60_000, request: newReq.id, open: true, followUpOf: root.id, by: 'super' };
  const main = { ...emptySuperState(), session: MAIN, enabled: true, team: [follow, root],
    containers: [{ id: memberTeamCardId(SLUG), kind: 'team', ref: root.id, shape: 'square', place: 'float' }] };
  writeFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), JSON.stringify(main, null, 2));
  // The member's transcript holds only the newer exchange (its older request is in no turn here).
  const tdir = join(HOME, '.claude', 'projects', realpathSync(PROJ).replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const row = (o, at) => JSON.stringify({ ...o, cwd: realpathSync(PROJ), uuid: `u-${at}`, timestamp: new Date(at).toISOString(), sessionId: MEMBER_SID });
  writeFileSync(join(tdir, `${MEMBER_SID}.jsonl`), [
    row({ type: 'user', message: { role: 'user', content: newReq.text } }, now - 19 * 60_000),
    row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A question waits: do you approve a real purchase on Tailspin and Wingtip with the QA card? The safety check stopped it.' }] } }, now - 18 * 60_000),
  ].join('\n') + '\n');
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH, DREAMCONTEXT_CLI: CLI }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(OUT, 'server.log'));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const SIZES = [{ w: 1440, h: 900 }, { w: 390, h: 844 }];
async function shots(page, name, focus) {
  for (const { w, h } of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ['light', 'dark']) {
      await applyTheme(page, theme);
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(OUT, `${name}-${w}-${theme}.png`) });
      const el = focus(page);
      if (await el.count() && await el.first().isVisible().catch(() => false)) {
        await el.first().screenshot({ path: join(OUT, `${name}-${w}-${theme}-crop.png`) }).catch(() => {});
      } else console.log(`  (shot ${name} @${w} ${theme}: its element is not on screen)`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await applyTheme(page, 'light');
}

seed();
const port = await freePort();
const srv = await startServer(port);
const browser = await chromium.launch();
const errors = [];
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${port}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await toMainStage(page);
  const member = await pageFetch(page, VAULT, 'GET', `/super/state?superId=m:${SLUG}`);
  console.log('member record open items:', JSON.stringify((member.json?.queue ?? []).filter((q) => q.state !== 'done').map((q) => [q.id, q.kind, q.state])));
  const tile = page.locator('[data-testid="super-team-tile"]:visible').first();
  if (!(await until(page, async () => (await tile.count()) > 0, 20000))) throw new Error('no team card on main\'s stage');
  await page.waitForTimeout(2500);
  const status = await tile.getAttribute('data-team-status');
  const spin = await tile.locator('.super-tile-spin').count();
  console.log(`card: status=${status} spinner=${spin} state="${await tile.locator('[data-testid="super-team-state"]').innerText()}"`);
  await shots(page, '1-stage', (pg) => pg.locator('[data-testid="super-team-tile"]:visible'));
  // The card's clip takes the pointer (what a real click hits): click where the card is.
  const box = await tile.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const conv = page.locator('[data-testid="team-job-conversation"]:visible').first();
  await until(page, async () => (await conv.count()) > 0, 15000);
  await page.waitForTimeout(2500);
  const fallback = await page.locator('[data-testid="team-job-request-fallback"]:visible').count();
  console.log(`card opened: old request redrawn under the conversation = ${fallback}`);
  await shots(page, '2-card', (pg) => pg.locator('[data-testid="team-job-conversation"]:visible'));
  console.log(`console errors: ${errors.length}${errors.length ? `\n  ${errors.slice(0, 6).join('\n  ')}` : ''}`);
} catch (err) {
  console.error(String(err));
  code = 1;
} finally {
  await browser.close();
  srv.kill();
  rmSync(SCRATCH, { recursive: true, force: true });
}
process.exit(code);
