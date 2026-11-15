#!/usr/bin/env node
/**
 * The unread number on the side menu's Super Agent row (owner 2026-11-15: "super agent sekmesinde
 * hala doğru değil. 7 okunmamış var diyor ama tıkladıktan sonra da gitmiyor").
 *
 *   npm run build && node scripts/verify/super-okunmamis-sol.mjs [out-folder] [dist/index.js]
 *
 * A seeded scratch vault in the live case's shape: main Super's transcript holds seven long
 * replies from half an hour ago and a newest one; its read marks hold only the newest (he was on
 * the stage, at its bottom, when it landed). A member stands by as the place to be "away". Shots
 * at 1440 px:
 *   1-open        main's stage open (the row clicked): the row has no number (was 7)
 *   2-bottom      the stage at its bottom, the old seven still above: no number
 *   3-reply-away  a reply that lands on main while the owner is on the member's stage: only the new
 *   4-back        main's stage clicked again and read: no number
 * The second argument runs another build (the "before" shots). Fictional fixture names.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { cleanEnv, freePort, openMember, pageFetch, sayOnStage, stage, startServer, superStandin, toMainStage, until } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'super-okunmamis-sol'));
const CLI = resolve(process.argv[3] || join(REPO, 'dist', 'index.js'));
const SCRATCH = join(tmpdir(), `dreamcontext-super-okunmamis-sol-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const MAIN = '7a1c0de0-0000-4000-8000-00000000a002';
const MEMBER_SID = '7a1c0de0-0000-4000-8000-00000000b002';
const SLUG = 'quill';

const emptySuperState = () => ({ v: 1, session: null, enabled: false, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [] });
const env = (extra = {}) => cleanEnv(HOME, extra);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const MIN = 60_000;
const DAY = 86_400_000;
const now = Date.now();

/** superUnread.ts wordsKey / superTypes.ts msgRef, mirrored: the read mark of a prose block. */
function msgRef(text) {
  let h = 0x811c9dc5; const s = (text ?? '').trim();
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 2_176_782_336).toString(36).padStart(6, '0');
}
const wordsKey = (t) => msgRef(t.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' '));

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  const superDir = join(PROJ, '_dream_context', 'state', '.super');
  const members = join(superDir, 'members');
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), members, OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  // Main answers 10 s on (the owner has gone to the member's stage by then).
  writeFileSync(bin, superStandin({
    reports: join(SCRATCH, 'reports.ndjson'), cli: CLI,
    main: "await sleep(10000); return 'Checked again: the welcome flow is live.';",
    member: "return 'Spend is on plan.';",
  }));
  chmodSync(bin, 0o755);
  for (const r of [dc('vaults', 'add', VAULT, PROJ), dc('agents', 'create', SLUG, '--title', 'Quill · Ads Manager', '--prompt', 'Runs the paid ads.')]) {
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  }
  writeFileSync(join(members, `${SLUG}.json`), JSON.stringify({ ...emptySuperState(), session: MEMBER_SID, enabled: true, member: SLUG }, null, 2));
  writeFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), JSON.stringify({ ...emptySuperState(), session: MAIN, enabled: true }, null, 2));

  // Seven long replies from half an hour ago (each taller than a third of the view) and a newest one.
  const para = (i) => `**Result ${i}.** ${'The storefront check ran end to end and every step answered as planned. '.repeat(14)}`;
  const old = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ text: para(i), at: now - (40 - i * 2) * MIN }));
  const newest = { text: 'All seven checks are written up above. Nothing waits on you.', at: now - 20 * MIN };
  const tdir = join(HOME, '.claude', 'projects', realpathSync(PROJ).replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const row = (o, at, sid) => JSON.stringify({ ...o, cwd: realpathSync(PROJ), uuid: `u-${at}`, timestamp: new Date(at).toISOString(), sessionId: sid });
  writeFileSync(join(tdir, `${MAIN}.jsonl`), [
    row({ type: 'user', message: { role: 'user', content: 'run the storefront checks' } }, now - 45 * MIN, MAIN),
    ...[...old, newest].map((m) => row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: m.text }] } }, m.at, MAIN)),
  ].join('\n') + '\n');
  // He read the newest at the bottom; the seven above were never on screen.
  writeFileSync(join(superDir, 'read-marks.json'), JSON.stringify({ since: now - 7 * DAY, read: [{ key: `t:${wordsKey(newest.text)}`, ts: newest.at }] }));
  writeFileSync(join(tdir, `${MEMBER_SID}.jsonl`), [
    row({ type: 'user', message: { role: 'user', content: 'how are the ads' } }, now - 30 * MIN, MEMBER_SID),
    row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On plan.' }] } }, now - 29 * MIN, MEMBER_SID),
  ].join('\n') + '\n');
}

const rowSel = '[data-testid="drawer-super-row"]';
async function rowMark(page) {
  const r = page.locator(`${rowSel}:visible`).first();
  if (!(await r.count())) return 'no row';
  const n = r.locator('[data-testid="mark-unread"]');
  return (await n.count()) ? `unread ${await n.innerText()}` : 'no number';
}
async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}-1440.png`) });
  const r = page.locator(`${rowSel}:visible`).first();
  if (await r.count()) await r.screenshot({ path: join(OUT, `${name}-row.png`) }).catch(() => {});
}
// Away: only what landed after he read (the reply, and an event turn the stand-in also answers);
// the seven old ones would make it 8 or more.
const WANT = { '1-open': 'no number', '2-bottom': 'no number', '3-reply-away': /^unread [12]$/, '4-back': 'no number' };
const misses = [];
async function report(page, name) {
  const row = await rowMark(page);
  console.log(`${name}: row=${row}`);
  const want = WANT[name];
  if (want && !(typeof want === 'string' ? row === want : want.test(row))) misses.push(`${name}: row shows "${row}", want ${WANT[name]}`);
  await shot(page, name);
}
async function toBottom(page) {
  await stage(page, 'main').evaluate((el) => {
    for (const s of el.querySelectorAll('*')) if (s.scrollHeight > s.clientHeight + 40 && getComputedStyle(s).overflowY !== 'visible') s.scrollTop = s.scrollHeight;
  });
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
  await page.goto(`http://127.0.0.1:${port}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await toMainStage(page))) throw new Error('main stage did not open');
  await until(page, async () => (await stage(page, 'main').getByText('Nothing waits on you', { exact: false }).count()) > 0, 20000);
  await page.waitForTimeout(3000);
  await report(page, '1-open');

  await toBottom(page);
  await page.waitForTimeout(2500);
  await report(page, '2-bottom');

  // A reply that lands on main while he is on the member's stage.
  await sayOnStage(page, 'main', 'check the welcome flow once more');
  await page.waitForTimeout(1500);
  await openMember(page, SLUG);
  await until(page, async () => (await stage(page, `m:${SLUG}`).count()) > 0, 20000);
  await until(page, async () => (await rowMark(page)).startsWith('unread'), 40000);
  await page.waitForTimeout(1000);
  await report(page, '3-reply-away');

  await toMainStage(page);
  await until(page, async () => (await rowMark(page)) === 'no number', 20000);
  await report(page, '4-back');
  const marks = await pageFetch(page, VAULT, 'GET', '/agent/super-read');
  console.log(`read marks on disk: ${marks.json?.read?.length ?? '?'}`);
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
