#!/usr/bin/env node
/**
 * Live walk of sahip-karti-yerinde (plan-r7 criteria 11 and 12): a card a crew child leaves for
 * the owner is done where the owner is, and its result reaches the child even when it was parked.
 * End to end through the REAL server (built dist), the real chat processes it spawns, the real
 * park sweep and the real dashboard in Chromium.
 *
 *   npm run build && node scripts/verify/verify-owner-card.mjs --out <dir>
 *
 *   Run      main's Super delegates a child; the child posts a `run` card (a harmless
 *            `sleep; echo`); the sweep parks it under forced HARD pressure; the Super hears
 *            `event=parked`, never `gone`; the item stays open. The owner presses ▶ Run in the
 *            Super-chat slot; the child is woken, its next turn is the `[ran in chat]` receipt,
 *            the item closes by itself and the Super gets one `event=owner-result`.
 *   Secret   a second crew child, working in a git worktree of the project under the fake
 *            ~/.claude-worktrees, posts a `secret` card and is parked. A hand-written receipt for
 *            that card is drawn read-only ("Kept from before a restart"). The owner fills the card
 *            in the slot: the `.env` lands in the WORKTREE (never the project root), its
 *            `.gitignore` covers it, the child is woken and gets the receipt, and the hand-written
 *            entry is gone with the delivery. The typed value reaches no Super event.
 *   Refused  a curl-shape `POST /api/agent/card-ticket` (no Origin, no key), a node `ws` start
 *            with no Origin, no key and no ticket, and a no-Origin attach to the owner's LIVE run:
 *            403 each, not one replay byte.
 *   Observed the slot, the bar row (CardHead) and the agenda line at 1440 and 390 px, light theme,
 *            into --out (slot-1440.png, bar-390.png, ...); console errors and failed requests per
 *            page into <out>/console.json. Any console error fails the walk.
 *
 * Scratch only (patterns of verify-owner-reach.mjs and super-owner-wait.mjs): a fake HOME,
 * another port, a scripted stand-in `claude` (no tokens), the owner key handed to the server the
 * way the shell hands it (DREAMCONTEXT_OWNER_KEY_STDIN + one line on stdin) and given to the
 * page's owner requests the way the shell's IPC would, hard pressure forced through the park
 * sweep's verify hooks (DREAMCONTEXT_PARK_PRESSURE / _IDLE_MS / _SWEEP_MS / _FOCUS_MS) and the
 * sweep switched on and off through the owner's own setting (`parkIdleChats` in agent-ui.json),
 * so a child is parked only when a step asks. Never the installed app, never the real
 * ~/.dreamcontext. Every process and temp dir it started goes at exit, also on failure.
 * Fixture names are fictional (pattern synthetic-fixtures-for-published-artifacts).
 *
 * One PASS/FAIL line per step; exit non-zero on any FAIL.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ─── Pure helpers (exported for tests/unit/owner-card-livewalk-helpers.test.ts) ─────────────

/** `--out <dir>` (required). */
export function parseArgs(argv) {
  const i = argv.indexOf('--out');
  const out = i >= 0 ? argv[i + 1] : undefined;
  if (!out || out.startsWith('--')) return { error: 'usage: node scripts/verify/verify-owner-card.mjs --out <dir>' };
  return { out: resolve(out) };
}

/** The one line that tells the lead what to build first, or null when the build is there. */
export function missingBuildLine(repo, exists = existsSync) {
  const need = [join(repo, 'dist', 'index.js'), join(repo, 'dist', 'dashboard', 'index.html')];
  const missing = need.filter((p) => !exists(p));
  if (!missing.length) return null;
  return `FAIL build missing (${missing.map((p) => p.slice(repo.length + 1)).join(', ')}): run \`npm run build\` in ${repo} first (the walk needs the built server and dashboard: the run card's websocket is not proxied by Vite)`;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How the Super was told about one child: the event lines naming it, across its turns. */
export function childEvents(texts, child) {
  const lines = texts.join('\n').split('\n').filter((l) => new RegExp(`child=${esc(child)}(\\s|$)`).test(l));
  const count = (ev) => lines.filter((l) => new RegExp(`event=${esc(ev)}(\\s|$)`).test(l)).length;
  return { parked: count('parked'), gone: count('gone'), ownerResult: count('owner-result'), lines };
}

/** The receipts file of one target (owner-receipts.ts `fileKey`: `main` / `m~<slug>`). */
export function receiptFileOf(home, childRecordId, childId) {
  return join(home, '.dreamcontext', 'cards', 'receipts', `${childRecordId.replace(':', '~')}__${childId}.json`);
}

/** A receipt entry written BY HAND (no valid MAC): the slot must draw it read-only, `kept`. */
export function writeHandEntry(home, target, entry) {
  const file = receiptFileOf(home, target.childRecordId, target.childId);
  mkdirSync(join(home, '.dreamcontext', 'cards'), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  let entries = [];
  try { entries = JSON.parse(readFileSync(file, 'utf-8')).entries ?? []; } catch { /* none yet */ }
  entries.push({ ...entry, mac: '0'.repeat(64) });
  writeFileSync(file, JSON.stringify({ v: 1, entries }), { mode: 0o600 });
  return file;
}

/** The ids of the entries a receipts file holds now ([] when it is gone). */
export function receiptIds(home, target) {
  try { return (JSON.parse(readFileSync(receiptFileOf(home, target.childRecordId, target.childId), 'utf-8')).entries ?? []).map((e) => e.id); } catch { return []; }
}

// ─── The walk ───────────────────────────────────────────────────────────────────────────

const SCRATCH = join(tmpdir(), `dreamcontext-verify-owner-card-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const WORKTREE = join(HOME, '.claude-worktrees', `${VAULT}-super-anahtar`);
const CLI = join(REPO, 'dist', 'index.js');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const MAIN_RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const AGENT_UI = join(HOME, '.dreamcontext', 'agent-ui.json');
const OWNER_KEY = randomBytes(32).toString('hex');
/** Long enough to attach to while it runs; nothing in it the run path refuses. */
const RUN_CMD = 'sleep 8; echo kart-yerinde-ok';
const SECRET_VALUE = `vk_${randomBytes(9).toString('hex')}`;
const SECRET_KEY = 'VERIFY_TOKEN';
/** The park sweep's verify hooks (chat-park.ts envMs / forcedPressure). */
const PARK_ENV = { DREAMCONTEXT_PARK_PRESSURE: 'hard', DREAMCONTEXT_PARK_IDLE_MS: '4000', DREAMCONTEXT_PARK_SWEEP_MS: '1500', DREAMCONTEXT_PARK_FOCUS_MS: '3000' };

/** The stand-in `claude` (the shape of lib/super-scratch.mjs `superStandin`), plus what this walk
 *  needs: an assistant frame carries the SAME uuid as its transcript row (card records are keyed
 *  by it, chat-registry.ts), a child's exit is reported (a park drains it), and a child can move
 *  into a worktree (its transcript rows then carry that cwd, which is how the server reads the
 *  folder a session works in). */
function standin() {
  const fence = "(o) => '\\n\\n```dream-view\\n' + JSON.stringify(o) + '\\n```'";
  return `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\\n');
const fence = ${fence};
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: ((r.stdout || '') + (r.stderr || '')).slice(0, 600) };
};
if (!argv.includes('stream-json')) {
  if (argv.includes('-p')) out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: at('--resume') || randomUUID(), num_turns: 1, total_cost_usd: 0, duration_ms: 5 });
  else out({});
  process.exit(0);
}
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = at('--session-id') || at('--resume') || randomUUID();
const tdir = join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
try { mkdirSync(tdir, { recursive: true }); } catch {}
const row = (o) => { try { appendFileSync(join(tdir, sid + '.jsonl'), JSON.stringify({ cwd: process.cwd(), uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: sid, ...o }) + '\\n'); } catch {} };
report({ kind: 'spawn', role, sid, resumed: !!at('--resume') });
process.on('exit', () => { try { report({ kind: 'exit', role, sid }); } catch {} });
process.on('SIGTERM', () => process.exit(0));
let secretAsked = false;
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const d = cli('super', 'delegate', '--prompt', 'RUNCARD: deploy adimini sahibine birak.', '--brief', 'Kargo kurulumu');
    report({ kind: 'delegated', which: 'run', sid: d.json?.sessionId ?? null, status: d.status, out: d.out });
    return 'Isi devraldim; kargo kurulumu basladi.';
  }
  if (text.includes('GO-SECRET') && !secretAsked) {
    secretAsked = true;
    const d = cli('super', 'delegate', '--prompt', 'SECRETCARD: odeme anahtarini sahibinden iste.', '--brief', 'Odeme anahtari');
    report({ kind: 'delegated', which: 'secret', sid: d.json?.sessionId ?? null, status: d.status, out: d.out });
    return 'Odeme anahtari isi basladi.';
  }
  return 'Not aldim.';
}
async function childTurn(text) {
  if (text.includes('[ran in chat]')) { report({ kind: 'receipt', which: 'run', sid, text: text.slice(0, 2000) }); return 'Komut calisti, devam ediyorum.'; }
  if (text.includes('[secret submitted')) { report({ kind: 'receipt', which: 'secret', sid, text: text.slice(0, 2000) }); return 'Anahtar kaydedildi, devam ediyorum.'; }
  if (text.includes('RUNCARD')) {
    report({ kind: 'card', which: 'run', sid });
    return 'Deploy oncesi bu komut senin terminalinde calismali.' + fence({ type: 'run', id: 'kargo-deploy', command: ${JSON.stringify(RUN_CMD)}, why: 'Deploy oncesi son kontrol; senin terminalinde calisir.' });
  }
  if (text.includes('SECRETCARD')) {
    process.chdir(${JSON.stringify(WORKTREE)});
    report({ kind: 'card', which: 'secret', sid, cwd: process.cwd() });
    return 'Odeme saglayicisinin test anahtari lazim.' + fence({ type: 'secret', id: 'odeme-anahtari', title: 'Odeme test anahtari', file: '.env', fields: [{ key: ${JSON.stringify(SECRET_KEY)} }] });
  }
  return 'Hazirim.';
}
let inited = false;
async function turn(blocks, content) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  const text = blocks.join('\\n');
  report({ kind: role + '-turn', sid, text: text.slice(0, 8000) });
  row({ type: 'user', message: { role: 'user', content } });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(text) : await childTurn(text); } catch (e) { said = 'error ' + e; }
  const uuid = randomUUID();
  const message = { role: 'assistant', content: [{ type: 'text', text: said }] };
  row({ type: 'assistant', uuid, message });
  out({ type: 'assistant', uuid, session_id: sid, message });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
}
let buf = '';
let chain = Promise.resolve();
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    chain = chain.then(() => turn(blocks, content));
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;
}

const results = [];
function step(label, cond, detail) {
  results.push({ label, pass: !!cond, ...(cond ? {} : { detail: detail === undefined ? undefined : String(detail).slice(0, 900) }) });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${!cond && detail !== undefined ? `\n      ${String(detail).slice(0, 900)}` : ''}`);
  return !!cond;
}
const note = (s) => console.log(`  · ${s}`);

const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return d; } };
const reports = () => readNd(REPORTS);
const mainRecord = () => readJson(MAIN_RECORD, { queue: [], children: {} });
const superTexts = () => reports().filter((r) => r.kind === 'super-turn').map((r) => r.text);
const cardItem = (type) => (mainRecord().queue ?? []).filter((q) => q.kind === 'owner' && q.card?.spec?.type === type).pop();
const env = (extra = {}) => {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_')));
  return { ...e, HOME, DREAMCONTEXT_DESKTOP: '1', ...extra };
};
const until = async (fn, ms = 20000, every = 200) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await Promise.resolve().then(fn).catch(() => false)) return true; await new Promise((r) => setTimeout(r, every)); }
  return false;
};
const freePort = async () => {
  const { createServer } = await import('node:net');
  return new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
};

function agentUi(parkIdleChats) {
  writeFileSync(AGENT_UI, `${JSON.stringify({
    ...readJson(AGENT_UI, {}),
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
    parkIdleChats,
  }, null, 2)}\n`);
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', env: env({ GIT_AUTHOR_NAME: 'Verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid', GIT_COMMITTER_NAME: 'Verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid' }) });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function setupScratch(out) {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), out]) mkdirSync(d, { recursive: true });
  agentUi(false);
  writeFileSync(join(PROJ, 'README.md'), '# Acme Storefront\n');
  git(PROJ, 'init', '-q');
  git(PROJ, 'add', 'README.md');
  git(PROJ, 'commit', '-q', '-m', 'init');
  git(PROJ, 'worktree', 'add', '-q', '-b', 'super/anahtar', WORKTREE);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, standin());
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}

/** The real dashboard server, given the owner key the way the desktop shell gives it. */
async function startServer(port, out) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...env(PARK_ENV), PATH, SHELL: '/bin/sh', DREAMCONTEXT_CLI: CLI, DREAMCONTEXT_OWNER_KEY_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  srv.stdin.end(`${OWNER_KEY}\n`);
  const log = createWriteStream(join(out, 'server.log'));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    if (srv.exitCode !== null) break;
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

/** Console errors, crashes and failed requests of one page (lib/super-scratch.mjs watchPage). */
function watch(page, name, store) {
  const rec = { errors: [], failed: [] };
  store[name] = rec;
  page.on('console', (m) => { if (m.type() === 'error') rec.errors.push(`console: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => rec.errors.push(`crash: ${String(e).slice(0, 300)}`));
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(why)) return;
    rec.failed.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '').replace(/ticket=[^&]+/, 'ticket=…')} ${why}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) rec.failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
  });
  return rec;
}

async function clean(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove());
    if (!document.getElementById('verify-kill')) {
      const s = document.createElement('style'); s.id = 'verify-kill';
      s.textContent = '.announcements-modal-scrim,.sleep-tracker-wrap{display:none!important}';
      document.head.appendChild(s);
    }
  }).catch(() => {});
}

/** One shot per width: the element's own crop when it is on screen, else the whole page.
 *  `prepare` runs after each resize (a list a width change folded is opened again). */
async function shotAt(page, out, name, locate, shots, prepare) {
  for (const { w, h } of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(900);
    if (prepare) await prepare(page).catch(() => {});
    await clean(page);
    await page.mouse.move(2, 2);
    const file = join(out, `${name}-${w}.png`);
    const el = locate ? locate(page).first() : null;
    let cropped = false;
    if (el && await el.count() && await el.isVisible().catch(() => false)) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      cropped = await el.screenshot({ path: file }).then(() => true).catch(() => false);
    }
    if (!cropped) await page.screenshot({ path: file });
    shots.push({ file, cropped });
    if (locate && !cropped) note(`${name}@${w}: its element was not on screen; whole page shot`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
}

async function handOver(page, base) {
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await clean(page);
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 60000);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('Kargo kurulumunu canliya al.'); await page.keyboard.press('Enter');
  await until(() => reports().some((r) => r.kind === 'child-turn'), 30000);
  await page.waitForTimeout(1200);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  const btn = page.locator('[data-testid="super-handover-btn"]:visible').first();
  if (await btn.count()) await btn.click();
  return until(() => reports().some((r) => r.kind === 'delegated' && r.which === 'run'), 90000);
}

async function toMainStage(page) {
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click().catch(() => {});
  return until(async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 15000);
}

async function sayCentre(page, text) {
  const centre = page.locator('[data-super-slot="centre"] .chat-cmp-input:visible');
  const input = (await centre.count()) ? centre.first() : page.locator('[data-testid="super-surface"]:visible .chat-cmp-input').first();
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

const slotCard = (page, type) => page.locator(`[data-testid="super-owner-card"][data-kind="${type}"]:visible`);
const barCard = (page) => page.locator('[data-testid="super-job-bar"]:visible');
const agendaWaiting = (page) => page.locator('[data-testid="super-agenda-section-waiting"] [data-testid="super-agenda-row"]:visible');
/** The bar row's text as drawn (the whole command, its folder), whitespace folded. */
const drawnText = async (loc) => (await loc.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

/**
 * The agenda's Waiting list, open. On a small stage the agenda card is COMPACT (counts only:
 * "1 Waiting", "0 Now", "0 Done"); its lines show only once the card is opened. So: the lines when
 * they are already there, else a press on the compact Waiting count (the card frame's click opens
 * it), else on the agenda card itself.
 */
async function openAgendaList(page) {
  const listed = async () => (await agendaWaiting(page).count()) > 0;
  if (await listed()) return true;
  const count = page.locator('[data-testid="super-agenda-tile-waiting"]:visible').first();
  if (await count.count()) {
    await count.click().catch(() => {});
    if (await until(listed, 6000)) return true;
  }
  const card = page.locator('[data-testid="super-container"]:visible').filter({ has: page.locator('[data-testid="super-agenda"]') }).first();
  if (await card.count()) {
    await card.click().catch(() => {});
    if (await until(listed, 6000)) return true;
  }
  return listed();
}

/** Park a child through the real sweep: switch parking on, wait for its process to exit, off. */
async function parkChild(sid) {
  const exitsBefore = reports().filter((r) => r.kind === 'exit' && r.sid === sid).length;
  agentUi(true);
  const parked = await until(() => reports().filter((r) => r.kind === 'exit' && r.sid === sid).length > exitsBefore, 45000, 300);
  agentUi(false);
  return parked;
}

/** A node `ws` client with NO Origin, NO owner key and NO ticket (the Super's own Bash shape). */
async function noOriginUpgrade(base, query) {
  const require = createRequire(join(REPO, 'package.json'));
  const WebSocket = require('ws');
  return new Promise((done) => {
    const url = `${base.replace(/^http/, 'ws')}/api/agent/terminal?${query}`;
    const ws = new WebSocket(url);
    let bytes = 0;
    let status = null;
    let opened = false;
    const finish = () => { try { ws.terminate(); } catch { /* gone */ } done({ status, bytes, opened }); };
    ws.on('unexpected-response', (_req, res) => { status = res.statusCode; res.on('data', () => {}); setTimeout(finish, 300); });
    ws.on('open', () => { opened = true; setTimeout(finish, 1500); });
    ws.on('message', (d) => { bytes += d.length ?? String(d).length; });
    ws.on('error', () => setTimeout(finish, 300));
    setTimeout(finish, 8000);
  });
}

/** The card's record as `GET /api/agent/cards` sees it (readable without Origin, by design). */
async function cardRecord(base, session, cardRef) {
  try {
    const r = await fetch(`${base}/api/agent/cards?session=${encodeURIComponent(session)}`, { headers: { 'X-Dreamcontext-Vault': VAULT } });
    const j = await r.json();
    const list = Array.isArray(j) ? j : (j.cards ?? []);
    return list.find((c) => c.cardRef === cardRef) ?? null;
  } catch { return null; }
}

function curlTicket(base, body) {
  const url = `${base}/api/agent/card-ticket`;
  const r = spawnSync('curl', ['-s', '-o', '-', '-w', '\n%{http_code}', '-X', 'POST', '-H', 'Content-Type: application/json', '--data', JSON.stringify(body), url], { encoding: 'utf-8', timeout: 15000 });
  if (r.status === 0) {
    const lines = r.stdout.trimEnd().split('\n');
    const code = Number(lines.pop());
    let json = null; try { json = JSON.parse(lines.join('\n')); } catch { /* none */ }
    return { status: code, json, how: 'curl' };
  }
  return null;
}

async function caseRun(page, base, out, shots) {
  console.log('\n── run: a parked child\'s run card, pressed in the Super-chat slot');
  step('main\'s Super delegated the run child', reports().some((r) => r.kind === 'delegated' && r.which === 'run' && r.status === 0),
    JSON.stringify(reports().filter((r) => r.kind === 'delegated')));
  step('the child posted its run card', await until(() => reports().some((r) => r.kind === 'card' && r.which === 'run'), 60000));
  const sid = reports().find((r) => r.kind === 'card' && r.which === 'run')?.sid;
  step('an open owner item carries the card handle (record, not chat text)', await until(() => {
    const q = cardItem('run');
    return q && q.state !== 'done' && q.sessionId === sid && q.card?.spec?.command === RUN_CMD && /^[0-9a-f]{32}$/.test(q.card?.cardRef ?? '');
  }, 30000), JSON.stringify(cardItem('run') ?? mainRecord().queue));
  const item = cardItem('run');
  const handle = item?.card;
  if (!handle) return null;

  console.log('\n── refused: no owner proof');
  const body = { session: handle.postingSession, card: handle.cardRef, action: 'start', shown: RUN_CMD };
  let ticket = curlTicket(base, body);
  if (!ticket) {
    const r = await fetch(`${base}/api/agent/card-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch { /* none */ }
    ticket = { status: r.status, json, how: 'fetch' };
  }
  step(`a curl-shape POST /api/agent/card-ticket (no Origin, no key): 403 owner_only (${ticket.how})`, ticket.status === 403 && ticket.json?.error === 'owner_only', JSON.stringify(ticket));
  const q = `session=${encodeURIComponent(handle.postingSession)}&card=${handle.cardRef}`;
  const start = await noOriginUpgrade(base, `${q}&start=1`);
  step('a no-Origin, no-key node ws START (no ticket): 403, never opened, 0 bytes', start.status === 403 && !start.opened && start.bytes === 0, JSON.stringify(start));
  await new Promise((r) => setTimeout(r, 800));
  const rec0 = await cardRecord(base, handle.postingSession, handle.cardRef);
  step('…and nothing started: the record is open with no run', !!rec0 && rec0.state === 'open' && !rec0.run, JSON.stringify(rec0));

  console.log('\n── park under hard pressure');
  step('the sweep parks the waiting child under forced hard pressure (its process exits)', await parkChild(sid), JSON.stringify(reports().filter((r) => r.sid === sid && (r.kind === 'exit' || r.kind === 'spawn'))));
  step('the Super is told ONE event=parked for it, and no gone', await until(() => { const e = childEvents(superTexts(), sid); return e.parked === 1 && e.gone === 0; }, 30000),
    JSON.stringify(childEvents(superTexts(), sid).lines));
  step('…its line says it wakes by itself', superTexts().some((t) => t.includes('It wakes by itself when the owner acts; do not resume it for this.')));
  const parkedItem = cardItem('run');
  step('the owner item stays open (Needs you, not closed by the park)', parkedItem?.state !== 'done' && parkedItem?.id === item.id, JSON.stringify(parkedItem));
  step('the child\'s row still says waiting', await until(() => mainRecord().children?.[sid]?.row === 'waiting', 10000), JSON.stringify(mainRecord().children?.[sid]));

  console.log('\n── observed: the slot, the bar row, the agenda line');
  await toMainStage(page);
  step('the Super-chat slot draws the run card from the record', await until(async () => (await slotCard(page, 'run').count()) > 0, 20000));
  step('…with the whole command', await until(async () => (await slotCard(page, 'run').locator('[data-testid="run-card-command"]').first().innerText()).includes(RUN_CMD), 10000));
  step('…and its folder (the project root: this child has no worktree)', await until(async () => (await slotCard(page, 'run').locator('[data-testid="run-card-folder"]').first().innerText().catch(() => '')).includes(VAULT), 10000),
    await slotCard(page, 'run').innerText().catch(() => ''));
  step('the slot shows the Paused chip', await until(async () => (await slotCard(page, 'run').locator('[data-testid="super-owner-paused"]').count()) > 0, 10000));
  // The bar row is asserted on what it DRAWS (the whole command, the folder's name), never on
  // how it is laid out: the row may wrap the command over several lines.
  const bar = barCard(page);
  const runVerb = bar.locator('[data-testid="super-queue-card-run"]').first();
  step('the bar row (CardHead) draws ▶ Run and the whole command', await until(async () =>
    (await runVerb.count()) > 0 && (await drawnText(bar)).includes(RUN_CMD), 15000),
  await drawnText(bar));
  step('…sending exactly that command as `shown`', (await runVerb.getAttribute('data-shown').catch(() => null)) === RUN_CMD);
  step('…and the folder it runs in, by name', await until(async () => (await drawnText(bar)).includes(VAULT), 10000), await drawnText(bar));
  step('…with Not needed and a Paused chip', (await bar.locator('[data-testid="super-queue-card-not-needed"]').count()) > 0
    && (await bar.locator('[data-testid="super-queue-paused"]').count()) > 0,
  await drawnText(bar));
  await shotAt(page, out, 'slot', (p) => slotCard(p, 'run'), shots);
  await shotAt(page, out, 'bar', (p) => barCard(p), shots);
  // The agenda: its compact card is opened first, then its Waiting line is found and pressed.
  step('the agenda\'s Waiting list opens and has the card\'s line', await until(() => openAgendaList(page), 20000, 500),
    await page.locator('[data-testid="super-agenda"]:visible').first().innerText().catch(() => '(no agenda on screen)'));
  await shotAt(page, out, 'agenda', (p) => p.locator('[data-testid="super-agenda-section-waiting"]:visible'), shots, openAgendaList);
  if (await openAgendaList(page)) {
    const rows = agendaWaiting(page);
    const named = rows.filter({ hasText: 'Kargo kurulumu' });
    const line = (await named.count()) ? named.first() : rows.first();
    const press = line.locator('button').first();
    await (await press.count() ? press : line).click().catch(() => {});
    step('the agenda line opens the slot (the card is in view)', await until(() => page.evaluate((itemId) => {
      const el = document.querySelector(`[data-testid="super-owner-card"][data-item="${itemId}"]`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    }, item.id), 8000), await line.innerText().catch(() => ''));
  }

  console.log('\n── he presses ▶ Run in the slot');
  const play = slotCard(page, 'run').locator('[data-testid="run-card-play"]').first();
  await play.scrollIntoViewIfNeeded().catch(() => {});
  await play.click();
  step('the run starts (the record has a live run)', await until(async () => !!(await cardRecord(base, handle.postingSession, handle.cardRef))?.run, 15000, 150),
    JSON.stringify(await cardRecord(base, handle.postingSession, handle.cardRef)));
  const attach = await noOriginUpgrade(base, q);
  step('a no-Origin attach to his LIVE run: 403, never opened, 0 replay bytes', attach.status === 403 && !attach.opened && attach.bytes === 0, JSON.stringify(attach));
  step('the run ends in the slot (exit 0)', await until(async () => {
    const r = await cardRecord(base, handle.postingSession, handle.cardRef);
    return r && !r.run && r.exit === 0;
  }, 30000, 300), JSON.stringify(await cardRecord(base, handle.postingSession, handle.cardRef)));
  const seen = new Set();
  const resultLine = slotCard(page, 'run').locator('[data-testid="super-owner-result"]');
  await until(async () => {
    const d = cardItem('run')?.delivery;
    if (d) seen.add(d);
    if (!seen.has('shot') && await resultLine.count()) {
      seen.add('shot');
      await clean(page);
      await slotCard(page, 'run').first().screenshot({ path: join(out, 'slot-result-1440.png') }).then(() => shots.push({ file: join(out, 'slot-result-1440.png'), cropped: true })).catch(() => {});
      note(`result line shot: "${(await resultLine.first().innerText().catch(() => '')).trim()}"`);
    }
    return cardItem('run')?.state === 'done';
  }, 60000, 150);
  note(`delivery states seen on the item: ${[...seen].filter((s) => s !== 'shot').join(' → ') || 'none'}`);
  step('the parked child is woken (a resumed process of the same session)', reports().some((r) => r.kind === 'spawn' && r.sid === sid && r.resumed),
    JSON.stringify(reports().filter((r) => r.sid === sid && (r.kind === 'spawn' || r.kind === 'exit'))));
  step('its next turn is the receipt: [ran in chat] and the command', await until(() => reports().some((r) => r.kind === 'receipt' && r.which === 'run' && r.sid === sid && r.text.includes(`$ ${RUN_CMD}`)), 30000),
    JSON.stringify(reports().filter((r) => r.kind === 'child-turn' && r.sid === sid).map((r) => r.text.slice(0, 200))));
  const done = cardItem('run');
  step('the item closes by itself, delivery "sent"', done?.state === 'done' && done?.delivery === 'sent', JSON.stringify(done));
  step('the Super gets exactly one event=owner-result for it, and never gone', await until(() => { const e = childEvents(superTexts(), sid); return e.ownerResult === 1 && e.gone === 0; }, 30000),
    JSON.stringify(childEvents(superTexts(), sid).lines));
  step('the 11 Nov loop is gone: one owner item for this card, zero gone events', (mainRecord().queue ?? []).filter((x) => x.kind === 'owner' && x.card?.cardRef === handle.cardRef).length === 1
    && childEvents(superTexts(), sid).gone === 0);
  return { sid, handle };
}

async function caseSecret(page, out, shots) {
  console.log('\n── secret: a parked worktree child\'s secret card, filled in the slot');
  await sayCentre(page, 'GO-SECRET odeme anahtari');
  step('main\'s Super delegated the secret child', await until(() => reports().some((r) => r.kind === 'delegated' && r.which === 'secret' && r.status === 0), 45000),
    JSON.stringify(reports().filter((r) => r.kind === 'delegated')));
  step('the child moved into its worktree and posted a secret card', await until(() => reports().some((r) => r.kind === 'card' && r.which === 'secret'), 60000));
  const sid = reports().find((r) => r.kind === 'card' && r.which === 'secret')?.sid;
  step('an open owner item carries the secret card handle', await until(() => { const q = cardItem('secret'); return q && q.state !== 'done' && q.sessionId === sid; }, 30000),
    JSON.stringify(mainRecord().queue));
  const item = cardItem('secret');
  const handle = item?.card;
  if (!handle) return;
  step('the sweep parks it under forced hard pressure', await parkChild(sid));
  step('the Super is told event=parked for it, no gone', await until(() => { const e = childEvents(superTexts(), sid); return e.parked === 1 && e.gone === 0; }, 30000),
    JSON.stringify(childEvents(superTexts(), sid).lines));

  // A receipt written by hand (no MAC under this boot's key): drawn read-only, proves nothing.
  const target = { childRecordId: handle.childRecordId, childId: handle.deliverTo };
  writeHandEntry(HOME, target, { id: 'hand-written-1', cardRef: handle.cardRef, kind: 'secret', text: '[secret submitted · Odeme test anahtari] (written by hand)', at: Date.now() - 3600_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
  await toMainStage(page);
  const card = slotCard(page, 'secret');
  step('the slot draws the secret card from the record', await until(async () => (await card.count()) > 0, 20000));
  step('…and its folder is the worktree', await until(async () => (await card.locator('[data-testid="secret-card-folder"]').first().innerText().catch(() => '')).includes(WORKTREE.split('/').pop()), 10000),
    await card.innerText().catch(() => ''));
  step('the hand-written receipt is drawn read-only: "Kept from before a restart; not checked"', await until(async () =>
    (await card.locator('[data-testid="super-owner-kept"]').count()) > 0 && /Kept from before a restart; not checked/.test(await card.locator('[data-testid="super-owner-kept"]').first().innerText()), 15000),
  await card.innerText().catch(() => ''));
  step('…delivered nowhere: the child got no receipt from it', !reports().some((r) => r.kind === 'receipt' && r.sid === sid));
  await shotAt(page, out, 'slot-kept', (p) => slotCard(p, 'secret'), shots);
  await shotAt(page, out, 'bar-secret', (p) => barCard(p), shots);

  const input = card.locator(`[id="secret-${handle.spec.id}-${SECRET_KEY}"]`).first();
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click();
  await input.fill(SECRET_VALUE);
  await card.locator('.chat-secretcard-foot button.primary').first().click();
  const wtEnv = join(WORKTREE, '.env');
  step('the .env lands in the child\'s WORKTREE with the value', await until(() => existsSync(wtEnv) && readFileSync(wtEnv, 'utf-8').includes(`${SECRET_KEY}=`) && readFileSync(wtEnv, 'utf-8').includes(SECRET_VALUE), 20000),
    existsSync(wtEnv) ? '(the file is there without the value)' : '(no .env in the worktree)');
  step('…not in the project root', !existsSync(join(PROJ, '.env')));
  const ignored = spawnSync('git', ['-C', WORKTREE, 'check-ignore', '-q', '.env']);
  step('…and the worktree\'s .gitignore covers it', ignored.status === 0 && existsSync(join(WORKTREE, '.gitignore')), `check-ignore exit ${ignored.status}`);
  step('the parked child is woken and its next turn is the [secret submitted] receipt', await until(() => reports().some((r) => r.kind === 'receipt' && r.which === 'secret' && r.sid === sid), 60000),
    JSON.stringify(reports().filter((r) => r.sid === sid).map((r) => r.kind)));
  step('the item closes by itself, delivery "sent"', await until(() => { const q = cardItem('secret'); return q?.state === 'done' && q?.delivery === 'sent'; }, 20000), JSON.stringify(cardItem('secret')));
  step('the hand-written entry left with the delivery', await until(() => !receiptIds(HOME, target).includes('hand-written-1'), 10000), JSON.stringify(receiptIds(HOME, target)));
  step('the Super gets one event=owner-result for it', await until(() => childEvents(superTexts(), sid).ownerResult === 1, 30000), JSON.stringify(childEvents(superTexts(), sid).lines));
  step('the typed value reached no Super turn and no receipts file', !superTexts().some((t) => t.includes(SECRET_VALUE)) && !receiptIds(HOME, target).length
    && !readFileSync(MAIN_RECORD, 'utf-8').includes(SECRET_VALUE));
}

async function main(out) {
  const missing = missingBuildLine(REPO);
  if (missing) { console.log(missing); return; }
  let srv = null;
  let browser = null;
  const pages = {};
  const shots = [];
  const stop = () => {
    try { srv?.kill('SIGTERM'); } catch { /* gone */ }
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
  };
  // Registered before anything is made, so a failed setup leaves nothing behind either.
  process.once('exit', () => { stop(); if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true }); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(130));
  let base = '';
  try {
    setupScratch(out);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    srv = await startServer(port, out);
    console.log(`── server on ${base} (hard pressure forced, parking off until a step asks), scratch ${SCRATCH}`);
    const { chromium } = createRequire(join(REPO, 'package.json'))('playwright');
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
    await context.addInitScript(() => {
      try {
        if (!localStorage.getItem('dreamcontext-theme')) localStorage.setItem('dreamcontext-theme', 'light');
      } catch { /* no storage */ }
      // The run card's ▶ is desktop-only (isDesktop: the Tauri marker); its PTY is the server's.
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    });
    await markAnnouncementsSeen(context, base);
    const page = await context.newPage();
    watch(page, 'main', pages);
    // Chromium has no shell IPC: the owner's own requests get the key the shell would give them.
    const withKey = (r) => r.continue({ headers: { ...r.request().headers(), 'x-dreamcontext-owner-key': OWNER_KEY } });
    for (const p of ['**/api/agent/card-ticket', '**/api/agent/cards/**', '**/api/agent/secret']) await page.route(p, withKey);

    console.log('── setup: hand-over');
    if (!step('main Super handed over and delegated a child', await handOver(page, base), JSON.stringify(reports().slice(-6)))) return;
    await caseRun(page, base, out, shots);
    await caseSecret(page, out, shots);
    const errs = Object.values(pages).flatMap((p) => p.errors);
    step('no console error or page crash on any page', errs.length === 0, errs.slice(0, 6).join('\n      '));
  } catch (err) {
    step('the walk ran to its end', false, err?.stack ?? String(err));
  } finally {
    await browser?.close().catch(() => {});
    stop();
    try { writeFileSync(join(out, 'console.json'), `${JSON.stringify(pages, null, 2)}\n`); } catch { /* out unwritable */ }
    try { writeFileSync(join(out, 'reports.ndjson'), readFileSync(REPORTS, 'utf-8').replaceAll(SECRET_VALUE, '[typed value]')); } catch { /* none */ }
    try { writeFileSync(join(out, 'record.json'), readFileSync(MAIN_RECORD, 'utf-8')); } catch { /* none */ }
    try { writeFileSync(join(out, 'result.json'), `${JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2)}\n`); } catch { /* out unwritable */ }
  }
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] ?? '').href; } catch { return false; } })();
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.log(`FAIL ${args.error}`); process.exit(2); }
  mkdirSync(args.out, { recursive: true });
  main(args.out).then(() => {
    const failed = results.filter((r) => !r.pass);
    const missing = missingBuildLine(REPO);
    if (missing) process.exit(1);
    console.log(`\n${results.length - failed.length} passed ${failed.length} failed${failed.length ? `:\n  - ${failed.map((f) => f.label).join('\n  - ')}` : ''}`);
    console.log(`output kept in ${args.out}`);
    process.exit(failed.length ? 1 : 0);
  }).catch((err) => {
    console.log(`FAIL the walk stopped: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
