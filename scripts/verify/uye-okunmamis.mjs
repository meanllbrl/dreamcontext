#!/usr/bin/env node
/**
 * A member's unread mark on the side menu's Team row (owner 2026-11-15: "team member bana mesaj
 * gönderdiğinde burada okunmamış mesaj gözükmüyor, neden orada 12 yazıyor").
 *
 *   npm run build && node scripts/verify/uye-okunmamis.mjs [out-folder] [dist/index.js]
 *
 * A seeded scratch vault in the live case's shape: the member's record holds 8 finished owner jobs
 * nothing ever marked seen, its read marks hold 4 replies newer than a days-old `seenAt`, its
 * transcript one exchange. The stand-in `claude` answers on the member's stage. Shots at 1440 px:
 *   1-row             the Team row before the stage is opened (was 12, now 4: its replies only)
 *   2-open            the member's stage opened and read: the row's number goes
 *   3-reply-open      a reply that lands while the stage is open and read: no number
 *   4-reply-away      a reply that lands while the owner is on main's stage: the row shows 1
 * The second argument runs another build (the "before" shots). Fictional fixture names.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { cleanEnv, freePort, pageFetch, sayOnStage, stage, startServer, superStandin, toMainStage, until } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'uye-okunmamis'));
const CLI = resolve(process.argv[3] || join(REPO, 'dist', 'index.js'));
const SCRATCH = join(tmpdir(), `dreamcontext-uye-okunmamis-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const MAIN = '7a1c0de0-0000-4000-8000-00000000a001';
const MEMBER_SID = '7a1c0de0-0000-4000-8000-00000000b001';
const SLUG = 'quill';
const SUPER_ID = `m:${SLUG}`;

const emptySuperState = () => ({ v: 1, session: null, enabled: false, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [] });
const env = (extra = {}) => cleanEnv(HOME, extra);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const MIN = 60_000;
const DAY = 86_400_000;
const now = Date.now();

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  const members = join(PROJ, '_dream_context', 'state', '.super', 'members');
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), members, OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  // The member answers at once; a message saying "later" is answered 10 s on (the owner has left).
  writeFileSync(bin, superStandin({
    reports: join(SCRATCH, 'reports.ndjson'), cli: CLI,
    member: "if (/later/.test(text)) await sleep(10000); else await sleep(1500); return /later/.test(text) ? 'Checked again: still on plan.' : 'Spend is on plan, 3 sign-ups so far.';",
  }));
  chmodSync(bin, 0o755);
  for (const r of [dc('vaults', 'add', VAULT, PROJ), dc('agents', 'create', SLUG, '--title', 'Quill · Ads Manager', '--prompt', 'Runs the paid ads.')]) {
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  }
  // 8 owner jobs it finished days ago, never marked seen (the window has not written `seenAt` since 2026-10-22).
  const children = {};
  for (let i = 1; i <= 8; i++) {
    const sid = `7a1c0de0-0000-4000-8000-0000000c000${i}`;
    children[sid] = { sessionId: sid, brief: `Ad check ${i}`, adopted: false, mode: 'basic', workOrigin: 'owner', row: 'gone', startedAt: now - (6 * DAY) + i * MIN, rowAt: now - (6 * DAY) + i * 2 * MIN, finishedAt: now - (6 * DAY) + i * 3 * MIN };
  }
  const member = { ...emptySuperState(), session: MEMBER_SID, enabled: true, member: SLUG, children };
  writeFileSync(join(members, `${SLUG}.json`), JSON.stringify(member, null, 2));
  // 4 replies newer than a `seenAt` six days old.
  const replies = [now - 3 * DAY, now - 2 * DAY, now - 52 * MIN, now - 49 * MIN];
  writeFileSync(join(members, `${SLUG}.read-marks.json`), JSON.stringify({ since: now - 7 * DAY, read: [], replies, seenAt: now - 6 * DAY }));
  const main = { ...emptySuperState(), session: MAIN, enabled: true };
  writeFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), JSON.stringify(main, null, 2));
  const tdir = join(HOME, '.claude', 'projects', realpathSync(PROJ).replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const row = (o, at) => JSON.stringify({ ...o, cwd: realpathSync(PROJ), uuid: `u-${at}`, timestamp: new Date(at).toISOString(), sessionId: MEMBER_SID });
  writeFileSync(join(tdir, `${MEMBER_SID}.jsonl`), [
    row({ type: 'user', message: { role: 'user', content: 'how are the ads going' } }, now - 50 * MIN),
    row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Six hours in: 562 spent, 3 sign-ups, all 16 ads on. Too early to call; first real read tomorrow.' }] } }, now - 49 * MIN),
  ].join('\n') + '\n');
}

const rowSel = `[data-testid="team-list-member"][data-slug="${SLUG}"]`;
async function rowMark(page) {
  const r = page.locator(`${rowSel}:visible`).first();
  if (!(await r.count())) return 'no row';
  const n = r.locator('[data-testid="mark-unread"]');
  return (await n.count()) ? `unread ${await n.innerText()}` : 'no number';
}
async function serverUnread(page) {
  const r = await pageFetch(page, VAULT, 'GET', '/agent/sessions?summary=1');
  return (r.json?.members ?? []).find((m) => m.slug === SLUG)?.unread ?? null;
}
async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}-1440.png`) });
  const r = page.locator(`${rowSel}:visible`).first();
  if (await r.count()) await r.screenshot({ path: join(OUT, `${name}-row.png`) }).catch(() => {});
}
/** What each step must show; any miss fails the run (the "before" build fails it by design). */
const WANT = { '1-row': 'unread 4', '2-open': 'no number', '3-reply-open': 'no number', '4-reply-away': /^unread [1-9]/ };
const misses = [];
async function report(page, name) {
  const row = await rowMark(page);
  console.log(`${name}: row=${row} server.unread=${await serverUnread(page)}`);
  const want = WANT[name];
  if (want && !(typeof want === 'string' ? row === want : want.test(row))) misses.push(`${name}: row shows "${row}", want ${want}`);
  await shot(page, name);
}

seed();
const port = await freePort();
const srv = await startServer({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(OUT, 'server.log'), extraEnv: { DREAMCONTEXT_CLI: CLI } });
const browser = await chromium.launch();
const errors = [];
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.addInitScript(([v]) => { try { localStorage.setItem(`dc.drawer.team.${v}`, '1'); } catch { /* none */ } }, [VAULT]);
  await page.goto(`http://127.0.0.1:${port}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await toMainStage(page);
  if (!(await until(page, async () => (await page.locator(`${rowSel}:visible`).count()) > 0, 20000))) throw new Error('no member row on the side menu');
  await page.waitForTimeout(2000);
  await report(page, '1-row');

  // Open the member's stage from its row and read it.
  await page.locator(`${rowSel}:visible`).first().click();
  if (!(await until(page, async () => (await stage(page, SUPER_ID).count()) > 0, 20000))) throw new Error('the member stage did not open');
  await until(page, async () => (await stage(page, SUPER_ID).getByText('Too early to call', { exact: false }).count()) > 0, 20000);
  await until(page, async () => (await rowMark(page)) === 'no number', 20000);
  await report(page, '2-open');

  // A reply lands while he reads the open stage.
  await sayOnStage(page, SUPER_ID, 'how are the ads going now?');
  await until(page, async () => (await stage(page, SUPER_ID).getByText('3 sign-ups so far', { exact: false }).count()) > 0, 30000);
  await page.waitForTimeout(4000);
  await until(page, async () => (await serverUnread(page)) === 0, 20000);
  await report(page, '3-reply-open');

  // A reply that lands while he is on main's stage.
  await sayOnStage(page, SUPER_ID, 'look again later');
  await page.waitForTimeout(800);
  await toMainStage(page);
  await until(page, async () => (await rowMark(page)).startsWith('unread'), 40000);
  await report(page, '4-reply-away');
  if (process.env.UYE_DEBUG) {
    const { readFileSync } = await import('node:fs');
    console.log('marks:', readFileSync(join(PROJ, '_dream_context', 'state', '.super', 'members', `${SLUG}.read-marks.json`), 'utf-8').replace(/"read":\[[^\]]*\]/, '"read":[…]'));
    for (const l of readFileSync(join(SCRATCH, 'reports.ndjson'), 'utf-8').trim().split('\n')) { const o = JSON.parse(l); if (o.kind !== 'stdin-user') console.log(' ', o.t, o.kind, o.role, (o.text ?? '').slice(0, 90).replace(/\n/g, ' ')); }
  }
  console.log(`console errors: ${errors.length}${errors.length ? `\n  ${errors.slice(0, 6).join('\n  ')}` : ''}`);
  if (misses.length) { console.error(`FAIL\n  ${misses.join('\n  ')}`); code = 1; } else console.log('PASS');
} catch (err) {
  console.error(String(err));
  code = 1;
} finally {
  await browser.close();
  srv.kill();
  rmSync(SCRATCH, { recursive: true, force: true });
}
process.exit(code);
