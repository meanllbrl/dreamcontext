#!/usr/bin/env node
/**
 * How long the app takes to LOAD where the owner waits (2026-11-23): opening the app, opening a
 * project, opening a whiteboard. Real dashboard (a built dist), scratch HOME, COPIES of real brains
 * (read only), a scripted `claude` stand-in (no tokens spent). Every request the page makes is
 * recorded with its time and size, so the table names what the wait is made of.
 *
 *   node scripts/verify/load-time.mjs --tag before --out tmp/perf \
 *        --brain <dir holding _dream_context>   # the open project (A)
 *        [--brain2 <dir>]                         # the closed project (B); default: a small synthetic one
 *        [--repo <dir holding dist/>] [--rounds 3] [--board <slug>] [--shots] [--width 1440]
 *        [--cold-only]                            # only the app-open step
 *        [--cpu-prof <dir>]                      # the server runs under node --cpu-prof (one file per round)
 *
 * Steps (ms from the click or from navigation start, median of --rounds):
 *   cold     page load -> `rail`: the rail is on screen; `chat`: the chat composer is usable;
 *            `quiet`: no request in flight for 500 ms. Round 1 runs on a server just started.
 *   project  click the closed project's chat row -> its composer is usable.
 *   boards   rail Whiteboards -> `list`: the board list has rows; `board`: the board's canvas is
 *            drawn (no loading skeleton left in the page).
 * Per step: the requests that ran inside it (path, ms, KB), slowest first.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const REPO = resolve(arg('repo', '.'));
const OUT = resolve(arg('out', 'tmp/perf'));
const TAG = arg('tag', 'after');
const ROUNDS = Number(arg('rounds', 3));
const BRAIN = arg('brain', '');
const BRAIN2 = arg('brain2', '');
const BOARD = arg('board', '');
const WIDTH = Number(arg('width', 1440));
const PORT = Number(arg('port', 47000 + Math.floor(Math.random() * 500)));
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-load-time-${TAG}-${process.pid}`);
const HOME = join(SCRATCH, 'home');
mkdirSync(OUT, { recursive: true });

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || 'v-' + process.pid;
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, env: env(), encoding: 'utf-8' });

function transcript(id, turns) {
  const rows = [];
  let n = 0;
  const e = (type, message) => rows.push(JSON.stringify({ type, uuid: randomUUID(), parentUuid: null, timestamp: new Date(Date.now() - 86400000 + (n++) * 1000).toISOString(), cwd: '/tmp/x', sessionId: id, version: '2.1.220', gitBranch: 'main', message }));
  const para = 'Sıradaki adımda dosyayı okudum, ilgili yolu izledim ve **sonucu** burada özetliyorum: `src/app.ts` değişti, testler geçiyor. '.repeat(3);
  for (let t = 0; t < turns; t++) {
    e('user', { role: 'user', content: [{ type: 'text', text: `Tur ${t}: sıradaki adımı yap ve bana yaz.` }] });
    for (let k = 0; k < 4; k++) {
      const tid = `toolu_${id.slice(0, 6)}_${t}_${k}`;
      e('assistant', { role: 'assistant', content: [{ type: 'text', text: k % 2 ? para : `Adım ${k}: bakıyorum.` }, { type: 'tool_use', id: tid, name: k % 2 ? 'Read' : 'Bash', input: k % 2 ? { file_path: '/tmp/x/src/app.ts' } : { command: `echo ${t}-${k}`, description: `Adım ${k}` } }] });
      e('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: [{ type: 'text', text: `çıktı ${t}-${k}\n`.repeat(20) }] }] });
    }
    e('assistant', { role: 'assistant', content: [{ type: 'text', text: `## Sonuç ${t}\n\n${para}` }] });
  }
  return `${rows.join('\n')}\n`;
}

const superRecord = (session) => ({ v: 1, session, enabled: true, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [] });

function project(name, chats, brain) {
  const p = join(SCRATCH, name);
  const root = join(p, '_dream_context');
  if (brain) {
    // Only read: the bulk no page lists (scratch, media, mail, ad files) stays behind.
    const skip = new Set(['tmp', 'marketing', 'inbox', 'workspace', 'social', 'ads']);
    const src = resolve(brain, '_dream_context');
    cpSync(src, root, { recursive: true, filter: (s) => !(dirname(s) === src && skip.has(basename(s))) && !s.endsWith('.lock') });
    for (const f of ['.agent-sessions.json', '.super-agent.json']) rmSync(join(root, 'state', f), { force: true });
    // The board the page opens first is the one --board names (the copied prefs remember another).
    const prefs = join(root, 'state', '.whiteboard-prefs.json');
    if (BOARD && name === 'acme' && existsSync(prefs)) {
      const j = JSON.parse(readFileSync(prefs, 'utf-8'));
      (j.settings ?? j).lastBoard = BOARD;
      writeFileSync(prefs, JSON.stringify(j));
    }
  }
  mkdirSync(join(root, 'state'), { recursive: true });
  spawnSync('git', ['-C', p, 'init', '-q']);
  dc(p, 'vaults', 'add', name, p);
  const superId = randomUUID();
  writeFileSync(join(root, 'state', '.super-agent.json'), JSON.stringify(superRecord(superId)));
  const sessions = chats.map((c, i) => ({ title: c.title, kind: 'chat', sessionId: c.id, pane: i, active: true, window: `w${i}`, size: 1, bypass: true }));
  const windows = chats.map((c, i) => ({ id: `w${i}`, name: c.title, activePane: i }));
  writeFileSync(join(root, 'state', '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows, generation: 1 }));
  return { name, p, superId };
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme', 'globex'], projectOrder: ['acme', 'globex'], lastVault: 'acme' }));
  const chatsA = [{ title: 'Alpha', id: randomUUID() }, { title: 'Beta', id: randomUUID() }, { title: 'Delta', id: randomUUID() }];
  const chatsG = [{ title: 'Gamma', id: randomUUID() }];
  const A = project('acme', chatsA, BRAIN ? resolve(BRAIN) : '');
  const G = project('globex', chatsG, BRAIN2 ? resolve(BRAIN2) : '');
  const dir = join(HOME, '.claude', 'projects', 'scratch-proj');
  mkdirSync(dir, { recursive: true });
  [A.superId, ...chatsA.map((c) => c.id), G.superId, ...chatsG.map((c) => c.id)]
    .forEach((id, i) => writeFileSync(join(dir, `${id}.jsonl`), transcript(id, 80 + i * 40)));
}

async function server() {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  mkdirSync(join(SCRATCH, 'cwd'), { recursive: true });
  const prof = arg("cpu-prof", "") ? ["--cpu-prof", `--cpu-prof-dir=${resolve(arg("cpu-prof"))}`] : [];
  const srv = spawn(process.execPath, [...prof, CLI, 'dashboard', '--launcher', '--no-open', '-p', String(PORT)], { cwd: join(SCRATCH, 'cwd'), env: { ...env(), PATH }, stdio: 'ignore' });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return srv; } catch { /* up soon */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up');
}

/** In the page: the first time each named thing is on screen, read every frame. */
const PROBE = `(() => {
  const vis = (sel) => [...document.querySelectorAll(sel)].some((el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
  const marks = {};
  window.__marks = marks;
  window.__want = {};
  const tick = () => {
    const now = performance.now();
    for (const [k, test] of Object.entries(window.__want)) if (marks[k] === undefined && test()) marks[k] = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__vis = vis;
  // Main-thread time in long tasks (>50 ms), summed: what the page itself spent blocked.
  window.__long = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long += e.duration; }).observe({ type: 'longtask', buffered: true }); } catch { /* none */ }
})();`;

/** The server's CPU time so far (ms, user + system, from ps): load-independent, unlike a wall clock. */
function cpuMs(pid) {
  const out = spawnSync('ps', ['-p', String(pid), '-o', 'time='], { encoding: 'utf-8' }).stdout.trim();
  const parts = out.split(':').map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return null;
  const sec = parts.reduce((acc, x) => acc * 60 + x, 0);
  return Math.round(sec * 1000);
}

const med = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null; };

/** Records every request as {path, start, end, kb} relative to page time zero. */
function recorder(p) {
  const list = [];
  let origin = null;
  p.on("framenavigated", () => { origin = null; });
  p.on('requestfinished', async (r) => {
    try {
      const t = r.timing();
      if (origin === null) origin = await p.evaluate(() => performance.timeOrigin).catch(() => null);
      const s = await r.sizes().catch(() => ({ responseBodySize: 0 }));
      const u = new URL(r.url());
      list.push({ path: u.pathname + (u.search.length < 60 ? u.search : u.search.slice(0, 60) + '…'), start: t.startTime - (origin ?? 0), ms: Math.round(t.responseEnd), wait: Math.round(t.responseStart - t.requestStart), kb: Math.round((s.responseBodySize || 0) / 1024) });
    } catch { /* closed */ }
  });
  return list;
}

async function waitMark(p, key, test, timeout = 30000) {
  await p.evaluate(([k, src]) => { window.__want[k] = new Function(`return (${src})`)(); }, [key, test.toString()]);
  await p.waitForFunction((k) => window.__marks[k] !== undefined, key, { timeout }).catch(() => {});
  return p.evaluate((k) => window.__marks[k] ?? null, key);
}

async function quiet(p, list, ms = 600, cap = 20000) {
  const t0 = Date.now();
  let last = list.length; let since = Date.now();
  while (Date.now() - t0 < cap) {
    await p.waitForTimeout(100);
    if (list.length !== last) { last = list.length; since = Date.now(); }
    if (Date.now() - since >= ms) break;
  }
}

const top = (reqs, from, to, n = 12) => reqs.filter((r) => r.start >= from - 5 && r.start <= to)
  .sort((a, b) => b.ms - a.ms).slice(0, n).map((r) => `${String(r.ms).padStart(5)}ms ${String(r.kb).padStart(6)}KB  +${Math.round(r.start - from)}  ${r.path}`);

async function main() {
  seed();
  const report = { tag: TAG, repo: REPO, width: WIDTH, cold: [], project: [], boards: [] };
  const browser = await chromium.launch();
  const errs = [];
  for (let round = 0; round < ROUNDS; round++) {
    // Every round starts its own server, like the app does on launch.
    const tServer = Date.now();
    const srv = await server();
    const serverUp = Date.now() - tServer;
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, colorScheme: 'light' });
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
    p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    await p.addInitScript(PROBE);
    await p.addInitScript(([board]) => {
      try { localStorage.setItem('dc.announcements.seen', '9999'); if (board) localStorage.setItem('dc.wbLastBoard.acme', board); } catch { /* none */ }
    }, [BOARD]);
    await p.route('**/api/onboarding/readiness**', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); });
    const reqs = recorder(p);
    await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`, { waitUntil: 'commit' });
    const rail = await waitMark(p, 'rail', () => window.__vis('[data-testid="ns-tab-chat"]'), 90000);
    const chat = await waitMark(p, 'chat', () => window.__vis('.project-instance:not([hidden]) textarea.chat-cmp-input'), 90000);
    await quiet(p, reqs);
    const quietAt = await p.evaluate(() => performance.now());
    const coldCpu = cpuMs(srv.pid);
    const coldLong = await p.evaluate(() => Math.round(window.__long));
    const got = p.getByRole('button', { name: 'Got it' });
    if (await got.isVisible().catch(() => false)) await got.click();
    report.cold.push({ round, serverUp, serverCpu: coldCpu, pageLong: coldLong, rail, chat, quiet: Math.round(quietAt), requests: reqs.length, kb: reqs.reduce((s, r) => s + r.kb, 0), top: top(reqs, 0, chat ?? quietAt, 20) });
    if (flag('shots') && round === ROUNDS - 1) await p.screenshot({ path: join(OUT, `${TAG}-cold-${WIDTH}.png`) });
    if (flag('cold-only')) {
      await ctx.close();
      srv.kill(arg('cpu-prof', '') ? 'SIGINT' : 'SIGTERM');
      await new Promise((r) => setTimeout(r, arg('cpu-prof', '') ? 3000 : 800));
      continue;
    }

    // Open the closed project B from the left panel: its row opens it (the owner's press); a row
    // that only unfolds is followed by its chat row.
    const header = p.locator('[data-drawer-project="globex"] [data-testid="drawer-project-row"]').first();
    const gRow = p.locator('[data-drawer-project="globex"] .ns-dr-child').filter({ hasText: 'Gamma' }).first();
    const n0 = reqs.length;
    const cpu0 = cpuMs(srv.pid);
    const plong0 = await p.evaluate(() => window.__long);
    await p.evaluate(() => { window.__was = document.querySelector('.project-instance:not([hidden])')?.dataset.instance ?? ''; });
    let t0 = await p.evaluate(() => performance.now());
    await header.click().catch(() => {});
    await p.waitForTimeout(300);
    if (await p.evaluate(() => document.querySelector('.project-instance:not([hidden])')?.dataset.instance === window.__was)) await gRow.click().catch(() => {});
    const pChat = await waitMark(p, "projChat", () => { const i = document.querySelector(".project-instance:not([hidden])"); return !!i && i.dataset.instance !== window.__was && !document.querySelector(".project-instance[hidden][data-holding=\"hold\"]") && window.__vis(".project-instance:not([hidden]) textarea.chat-cmp-input"); }, 30000);
    if (pChat === null) process.stderr.write(`project open not seen: ${JSON.stringify(await p.evaluate(() => ({ was: window.__was, inst: [...document.querySelectorAll('.project-instance')].map((i) => [i.dataset.instance, i.hidden, i.dataset.holding, i.querySelectorAll('textarea.chat-cmp-input').length]) })))}\n`);
    await quiet(p, reqs);
    const pQuiet = await p.evaluate(() => performance.now());
    const pCpu = cpuMs(srv.pid) - cpu0;
    const pLong = Math.round((await p.evaluate(() => window.__long)) - plong0);
    report.project.push({ round, serverCpu: pCpu, pageLong: pLong, chat: pChat ? Math.round(pChat - t0) : null, quiet: Math.round(pQuiet - t0), requests: reqs.length - n0, kb: reqs.slice(n0).reduce((s, r) => s + r.kb, 0), top: top(reqs, t0, pChat ?? pQuiet) });
    if (flag('shots') && round === ROUNDS - 1) await p.screenshot({ path: join(OUT, `${TAG}-project-${WIDTH}.png`) });

    // Back to A, then Whiteboards.
    const aRow = p.locator('[data-drawer-project="acme"] .ns-dr-child').filter({ hasText: 'Alpha' }).first();
    if (!(await aRow.isVisible().catch(() => false))) await p.locator('[data-drawer-project="acme"] [data-testid="drawer-project-row"]').first().click().catch(() => {});
    await aRow.click({ timeout: 10000 }).catch(() => {});
    await p.waitForFunction(() => document.querySelector('.project-instance:not([hidden])')?.dataset.instance === 'inst-1', null, { timeout: 15000 }).catch(() => process.stderr.write('did not get back to project A\n'));
    await p.waitForTimeout(1500);
    await quiet(p, reqs);
    const n1 = reqs.length;
    const cpu1 = cpuMs(srv.pid);
    const blong0 = await p.evaluate(() => window.__long);
    t0 = await p.evaluate(() => performance.now());
    await p.locator('[data-testid="ns-tab-whiteboards"]').filter({ visible: true }).first().click();
    const list = await waitMark(p, 'list', () => window.__vis('.wbx-row'), 30000);
    const board = await waitMark(p, 'board', () => { const i = document.querySelector('.project-instance:not([hidden])'); return !!i && window.__vis('canvas.excalidraw__canvas') && !i.querySelector('.shell-main [data-testid="loading-skeleton"]'); }, 30000);
    await quiet(p, reqs, 800);
    const bQuiet = await p.evaluate(() => performance.now());
    const bCpu = cpuMs(srv.pid) - cpu1;
    const bLong = Math.round((await p.evaluate(() => window.__long)) - blong0);
    report.boards.push({ round, serverCpu: bCpu, pageLong: bLong, list: list ? Math.round(list - t0) : null, board: board ? Math.round(board - t0) : null, quiet: Math.round(bQuiet - t0), requests: reqs.length - n1, kb: reqs.slice(n1).reduce((s, r) => s + r.kb, 0), top: top(reqs, t0, bQuiet, 15) });
    if (flag('shots') && round === ROUNDS - 1) await p.screenshot({ path: join(OUT, `${TAG}-board-${WIDTH}.png`) });

    // The heavy board (--board), opened from the list: the click to its drawn canvas.
    if (BOARD) {
      const heavyRow = p.locator(`[data-slug="${BOARD}"] .wbx-row-open`).filter({ visible: true }).first();
      if (await heavyRow.isVisible().catch(() => false)) {
        const n2 = reqs.length;
        const cpu2 = cpuMs(srv.pid);
        const long0 = await p.evaluate(() => window.__long);
        await p.evaluate(() => { window.__sawSkel = false; window.__want.skel = () => { if (document.querySelector('.shell-main [data-testid="loading-skeleton"], .wbp-shell-main [data-testid="loading-skeleton"]')) window.__sawSkel = true; return false; }; });
        t0 = await p.evaluate(() => performance.now());
        await heavyRow.click();
        const drawn = await waitMark(p, 'heavy', () => window.__sawSkel && window.__vis('canvas.excalidraw__canvas') && !document.querySelector('.wbp-shell-main [data-testid="loading-skeleton"]'), 30000);
        await quiet(p, reqs, 800);
        const hQuiet = await p.evaluate(() => performance.now());
        const long1 = await p.evaluate(() => window.__long);
        report.heavy = report.heavy ?? [];
        report.heavy.push({ round, serverCpu: cpuMs(srv.pid) - cpu2, board: drawn ? Math.round(drawn - t0) : null, quiet: Math.round(hQuiet - t0), longMs: Math.round(long1 - long0), requests: reqs.length - n2, kb: reqs.slice(n2).reduce((a, r) => a + r.kb, 0), top: top(reqs, t0, hQuiet, 10) });
        if (flag('shots') && round === ROUNDS - 1) await p.screenshot({ path: join(OUT, `${TAG}-heavy-board-${WIDTH}.png`) });
      } else process.stderr.write(`no row for board ${BOARD}\n`);
    }
    await ctx.close();
    srv.kill(arg('cpu-prof', '') ? 'SIGINT' : 'SIGTERM');
    await new Promise((r) => setTimeout(r, arg('cpu-prof', '') ? 3000 : 800));
  }
  await browser.close();
  report.errors = [...new Set(errs)];
  const s = (k, f) => med(report[k].map((x) => x[f]));
  report.summary = {
    cold: { serverUp: s('cold', 'serverUp'), serverCpu: s('cold', 'serverCpu'), pageLong: s('cold', 'pageLong'), rail: s('cold', 'rail'), chat: s('cold', 'chat'), quiet: s('cold', 'quiet'), requests: s('cold', 'requests'), kb: s('cold', 'kb') },
    project: !report.project.length ? null : { serverCpu: s('project', 'serverCpu'), pageLong: s('project', 'pageLong'), chat: s('project', 'chat'), quiet: s('project', 'quiet'), requests: s('project', 'requests'), kb: s('project', 'kb') },
    heavy: report.heavy ? { serverCpu: s('heavy', 'serverCpu'), board: s('heavy', 'board'), quiet: s('heavy', 'quiet'), longMs: s('heavy', 'longMs'), requests: s('heavy', 'requests'), kb: s('heavy', 'kb') } : null,
    boards: !report.boards.length ? null : { serverCpu: s('boards', 'serverCpu'), pageLong: s('boards', 'pageLong'), list: s('boards', 'list'), board: s('boards', 'board'), quiet: s('boards', 'quiet'), requests: s('boards', 'requests'), kb: s('boards', 'kb') },
  };
  writeFileSync(join(OUT, `${TAG}-load.json`), JSON.stringify(report, null, 1));
  for (const [k, v] of Object.entries(report.summary)) process.stdout.write(`${k.padEnd(8)} ${JSON.stringify(v)}\n`);
  for (const k of ['cold', 'project', 'boards', 'heavy']) {
    if (!report[k]?.length) continue;
    process.stdout.write(`\n${k} round 1 slowest requests:\n${report[k][0].top.join('\n')}\n`);
    if (report[k].length > 1) process.stdout.write(`${k} round ${report[k].length} slowest requests:\n${report[k].at(-1).top.slice(0, 8).join('\n')}\n`);
  }
  process.stdout.write(`\nerrors: ${JSON.stringify(report.errors)}\n`);
  rmSync(SCRATCH, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); rmSync(SCRATCH, { recursive: true, force: true }); process.exit(1); });
