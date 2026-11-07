#!/usr/bin/env node
/**
 * App tools end to end on this Mac, nothing sent to GitHub or to a model (app-araclari plan r3,
 * criteria 2, 3, 6, 7, 11). A scratch HOME holds one project with one app made from the template
 * and two extra tools, a brain app list (`app-catalog.json`) naming two apps NOT installed here,
 * and a LOCAL app host (a folder of bare repos standing in for GitHub) where one of them is
 * shared with the signed-in account and the other is not.
 *
 *   CLI   apps tools --json: the installed app's tools, the two others "not installed" with
 *         shared true / false; apps do reads and returns the app's own answer; a changing tool
 *         without --confirm is refused before the app sees it.
 *   Hook  the prompt hook names the reading tool, the changing tool asks first, the shared app
 *         offers the install button, the unshared one does not.
 *   UI    a chat turn (a scripted stand-in for claude) runs `apps do` and answers with two
 *         app-install buttons: the row says "<App> › <tool> (reads)"; the shared repo's button
 *         opens the install sheet; the unshared one says who to ask. The app card reads
 *         "2 tools · 1 changes things". Screenshots at 390 and 1440, no console errors.
 *
 *   npm run build && dreamcontext builder heavy -- node scripts/verify/app-tools.mjs [--out <dir>]
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-verify-app-tools-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const HOST = join(SCRATCH, 'host');
const LOGIN = 'ornek-kullanici';
const outArg = process.argv.indexOf('--out');
const SHOTS = outArg > 0 ? process.argv[outArg + 1] : join(SCRATCH, 'shots');

const findings = [];
let passed = 0;
const check = (ok, what, detail) => {
  if (ok) { passed++; console.log(`  ✓ ${what}`); } else { findings.push(what); console.log(`  ✗ ${what}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}`); }
  return ok;
};

// ─── the scripted `claude`: one turn that asks the app, then offers the two installs ───────
const ANSWER = [
  'The app counted the visits: see the row above.',
  '',
  '```dream-actions',
  JSON.stringify([
    { label: 'Install CRM', action: 'app-install', repo: 'acme/crm' },
    { label: 'Install Gizli', action: 'app-install', repo: 'acme/gizli' },
  ]),
  '```',
].join('\n');
const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = '';
async function turn() {
  out({ type: 'system', subtype: 'init', session_id: 'verify-app-tools', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'dreamcontext apps do demo hello --json', description: 'Ask the app' } }] } });
  await sleep(500);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '{"ok":true,"app":"demo","tool":"hello","effect":"read","body":{"visits":3}}\\n✓ Ziyaret Sayacı › Say hello and count visits (reads)' }] }] } });
  await sleep(200);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(ANSWER)} }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'verify-app-tools' });
}
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type === 'user') void turn();
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
const ENV = { ...clean, HOME, PATH, DREAMCONTEXT_VERSION_CHECK: '0', DREAMCONTEXT_AUTO_UPGRADE: '0', DREAMCONTEXT_APPS_LOCAL_HOST: HOST, DREAMCONTEXT_APPS_LOCAL_LOGIN: LOGIN, GIT_CONFIG_GLOBAL: '/dev/null' };
const dc = (args, extra = {}, input) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: { ...ENV, ...extra }, encoding: 'utf-8', input, timeout: 60_000 });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...ENV, GIT_AUTHOR_NAME: 'Ornek', GIT_AUTHOR_EMAIL: 'ornek@example.com', GIT_COMMITTER_NAME: 'Ornek', GIT_COMMITTER_EMAIL: 'ornek@example.com' }, encoding: 'utf-8' });

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  git(PROJ, 'init', '-q');
  const add = dc(['vaults', 'add', 'proj', PROJ]);
  if (add.status !== 0) throw new Error(`vaults add: ${add.stderr || add.stdout}`);

  // The installed app: the template, plus a tool that changes something.
  const made = dc(['apps', 'new', 'demo', '--name', 'Ziyaret Sayacı']);
  if (made.status !== 0) throw new Error(`apps new: ${made.stdout}${made.stderr}`);
  const root = join(`${PROJ}-apps`, 'demo');
  const m = JSON.parse(readFileSync(join(root, 'dreamcontext-app.json'), 'utf-8'));
  m.actions.push({ id: 'note', title: 'Send the owner a note', method: 'POST', path: '/api/note', does: 'Sends a note to the owner as a notification.', topics: ['note', 'notification'], params: { text: { type: 'string', required: true, desc: 'The note' } } });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify(m, null, 2));
  const server = readFileSync(join(root, 'server.mjs'), 'utf-8').replace("dc.actions(['hello']);", "dc.actions(['hello', 'note']);");
  writeFileSync(join(root, 'server.mjs'), server);

  // The brain's app list: two apps the project has, neither installed here (a publish writes it).
  const at = new Date().toISOString();
  writeFileSync(join(PROJ, '_dream_context', 'app-catalog.json'), JSON.stringify({ apps: [
    { slug: 'crm', name: 'CRM', does: 'Customers, deals and the revenue pipeline.', repo: 'acme/crm', visibility: 'private', publishedBy: 'ayse', tools: [{ id: 'pipeline', title: 'Revenue pipeline', effect: 'read' }], at },
    { slug: 'gizli', name: 'Gizli Rapor', does: 'The board report and its revenue forecast.', repo: 'acme/gizli', visibility: 'private', publishedBy: 'mert', tools: [{ id: 'forecast', title: 'Revenue forecast', effect: 'read' }], at },
  ] }, null, 2));

  // The local host: acme/crm is shared with this login, acme/gizli exists but is not.
  const repoOf = (owner, name, collaborators) => {
    mkdirSync(join(HOST, owner), { recursive: true });
    const bare = join(HOST, owner, `${name}.git`);
    git(SCRATCH, 'init', '-q', '--bare', '-b', 'main', bare);
    const work = join(SCRATCH, `w-${name}`);
    mkdirSync(work, { recursive: true });
    git(work, 'init', '-q', '-b', 'main');
    writeFileSync(join(work, 'dreamcontext-app.json'), JSON.stringify({ slug: name, name: name === 'crm' ? 'CRM' : 'Gizli Rapor', backend: { command: 'node s.mjs', health: '/health' }, actions: [] }, null, 2));
    writeFileSync(join(work, 's.mjs'), '// sample\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'first');
    git(work, 'push', '-q', bare, 'main');
    writeFileSync(join(HOST, owner, `${name}.json`), JSON.stringify({ id: name, ownerId: `local-${owner}`, private: true, topics: ['dreamcontext-app'], collaborators, invitations: [], createdAt: at, description: '' }, null, 2));
  };
  repoOf('acme', 'crm', [LOGIN]);
  repoOf('acme', 'gizli', []);
}

const freePort = () => new Promise((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

async function startServer(port) {
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...ENV, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_PARENT_PID: String(process.pid), DREAMCONTEXT_AUTO_DASHBOARD: '0' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = '';
  srv.stderr.on('data', (c) => { err += c.toString('utf-8'); });
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status < 500) return srv; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not come up: ${err.slice(-400)}`);
}

const hook = (prompt) => dc(['hook', 'user-prompt-submit'], { DREAMCONTEXT_RECALL_MODE: 'raw', DREAMCONTEXT_SERVER_PID: String(process.pid) }, JSON.stringify({ session_id: 'verify-hook', prompt })).stdout;
const appLines = (out) => out.split('\n').filter((l) => l.startsWith('→ APP TOOL') || l.startsWith('→ The project has the app'));

async function cliAndHook(port) {
  console.log('── CLI and hook');
  // The server writes the offline "shared with you" snapshot the hook reads.
  const shared = await (await fetch(`http://127.0.0.1:${port}/api/apps/shared?vault=proj`)).json().catch(() => null);
  check(!!shared && (shared.shared ?? []).some((s) => s.fullName === 'acme/crm'), 'the local host lists acme/crm as shared with this account', JSON.stringify(shared));

  const tools = dc(['apps', 'tools', '--json']);
  let list = null;
  try { list = JSON.parse(tools.stdout); } catch { /* checked below */ }
  check(!!list && list.installed.length === 1 && list.installed[0].slug === 'demo', 'apps tools: only the app on this Mac is installed', tools.stdout + tools.stderr);
  const demo = list?.installed[0];
  check(!!demo && demo.tools.map((t) => `${t.id}:${t.effect}`).join(',') === 'hello:read,note:change', 'apps tools: hello reads, note changes', JSON.stringify(demo?.tools));
  const ni = Object.fromEntries((list?.notInstalled ?? []).map((a) => [a.slug, a.sharedWithMe]));
  check(ni.crm === true && ni.gizli === false, 'apps tools: crm shared, gizli not, both "not installed"', JSON.stringify(list?.notInstalled));

  const read = dc(['apps', 'do', 'demo', 'hello', '--json']);
  let body = null;
  try { body = JSON.parse(read.stdout.split('\n').find((l) => l.startsWith('{')) ?? 'null'); } catch { /* checked below */ }
  check(read.status === 0 && body?.ok === true && typeof body?.body?.visits === 'number', 'apps do reads: the answer is the app\'s own number', read.stdout + read.stderr);
  const plain = dc(['apps', 'do', 'demo', 'hello']);
  check(/✓ Ziyaret Sayacı › Say hello and count visits \(reads\)/.test(plain.stdout), 'apps do ends with "<App> › <tool> (reads)"', plain.stdout);

  const change = dc(['apps', 'do', 'demo', 'note', '--input', '{"text":"merhaba"}']);
  check(change.status !== 0 && /needs_confirm|--confirm/.test(change.stdout + change.stderr), 'a changing tool without --confirm is refused', change.stdout + change.stderr);
  const bad = dc(['apps', 'do', 'demo', 'note', '--input', '{}', '--confirm']);
  check(bad.status !== 0 && /bad_input|text/.test(bad.stdout + bad.stderr), 'an input that misses a required field is refused before the call', bad.stdout + bad.stderr);
  const crew = dc(['apps', 'do', 'demo', 'note', '--input', '{"text":"x"}', '--confirm'], { DREAMCONTEXT_SUPER_CREW: '1' });
  check(crew.status !== 0 && /needs_owner/.test(crew.stdout + crew.stderr), 'a Super child cannot change through the app, even with --confirm', crew.stdout + crew.stderr);

  const visits = appLines(hook('how many visits did the app count?'));
  check(visits.some((l) => l.includes('demo › hello') && l.includes('apps do demo hello --json')), 'hook: the reading tool and its call', visits.join('\n'));
  const note = appLines(hook('send the owner a note notification'));
  check(note.some((l) => l.includes('demo › note') && l.includes('only after the owner says yes')), 'hook: the changing tool asks first', note.join('\n'));
  const crm = appLines(hook('how does the revenue pipeline of our customers look?'));
  check(crm.some((l) => l.includes('"CRM"') && l.includes('app-install button')), 'hook: the shared app not installed here offers the install button', crm.join('\n'));
  const gizli = appLines(hook('what does the board report forecast say?'));
  check(gizli.some((l) => l.includes('"Gizli Rapor"') && l.includes('not shared with this account') && !l.includes('app-install')), 'hook: the unshared app says who to ask, no button', gizli.join('\n'));
}

async function ui(port) {
  console.log('── UI');
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const base = `http://127.0.0.1:${port}`;
  const errors = [];
  const NOISE = /favicon\.ico|\/api\/apps\/[^/]+\/icon|status of 4\d\d/;
  const open = async (width) => {
    const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(`@${width} ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => errors.push(`@${width} crash ${String(e.message).slice(0, 200)}`));
    return { ctx, page };
  };
  const shot = async (page, name) => { const f = join(SHOTS, `${name}.png`); await page.screenshot({ path: f }); console.log(`  screenshot: ${f}`); };
  const until = async (fn, ms = 20_000, page) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); } return false; };

  // The app card, both widths.
  for (const w of [1440, 390]) {
    const { ctx, page } = await open(w);
    await page.goto(`${base}/?vault=proj&page=apps`, { waitUntil: 'domcontentloaded' });
    const card = page.locator('.app-card').filter({ hasText: 'Ziyaret Sayacı' }).first();
    const ok = await until(async () => (await card.innerText()).includes('2 tools'), 20_000, page);
    const text = ok ? (await card.innerText()).replace(/\s+/g, ' ') : '';
    check(ok && text.includes('1 changes things'), `@${w} the app card reads "2 tools · 1 changes things"`, text);
    await shot(page, `apps-card-${w}`);
    await ctx.close();
  }

  // The chat turn and its buttons.
  for (const w of [1440, 390]) {
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    const { ctx, page } = await open(w);
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
    if (!(await page.locator('.agent-surface.expanded').count())) {
      for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
        if (await page.locator('.agent-surface.expanded').count()) break;
      }
    }
    const input = page.locator('.chat-cmp-input:visible').first();
    if (!(await input.count())) await page.getByRole('button', { name: /Start chat/ }).first().click().catch(() => {});
    const opened = await until(async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 20_000, page);
    if (!check(opened, `@${w} a chat opens`)) { await shot(page, `chat-failed-${w}`); await ctx.close(); continue; }
    await page.locator('.chat-cmp-input:visible').first().fill('how many visits?');
    await page.keyboard.press('Enter');
    const done = await until(async () => (await page.locator('.chat-action-btn:visible').count()) >= 2, 40_000, page);
    check(done, `@${w} the answer draws the two install buttons`);
    const row = page.locator('.chat-dreamcard:visible').first();
    const rowText = (await row.count()) ? (await row.innerText()).replace(/\s+/g, ' ') : '';
    check(/Ziyaret Sayacı › Say hello and count visits \(reads\)/.test(rowText), `@${w} the row says "<App> › <tool> (reads)"`, rowText);
    await shot(page, `chat-${w}`);
    if (w === 1440) {
      await page.locator('.chat-action-btn:visible', { hasText: 'Install CRM' }).first().click();
      const sheet = await until(async () => (await page.getByText('acme/crm', { exact: false }).count()) > 0 && (await page.locator('[role="dialog"]').count()) > 0, 20_000, page);
      check(sheet, '@1440 the shared repo\'s button opens the install sheet on acme/crm');
      await shot(page, 'install-sheet-1440');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      // Back to the chat for the second button.
      for (const sel of ['.agent-fab', '.agent-overlay-head']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1000); }
        if (await page.locator('.chat-action-btn:visible').count()) break;
      }
      const btn = page.locator('.chat-action-btn:visible', { hasText: 'Install Gizli' }).first();
      if (await btn.count()) {
        await btn.click();
        const note = await until(async () => (await page.getByText('acme/gizli is not shared with you', { exact: false }).count()) > 0, 20_000, page);
        check(note, '@1440 the unshared repo\'s button opens no sheet and says who to ask');
        check((await page.locator('[role="dialog"]').count()) === 0, '@1440 …and no install sheet is open');
        await shot(page, 'not-shared-1440');
      } else {
        check(false, '@1440 the second button is reachable after the first');
      }
    }
    await ctx.close();
  }
  check(errors.length === 0, 'no console errors', errors.join('\n'));
  await browser.close();
}

let server = null;
try {
  console.log(`· scratch ${SCRATCH}`);
  setup();
  const port = await freePort();
  server = await startServer(port);
  await cliAndHook(port);
  await ui(port);
} catch (e) {
  findings.push(`harness: ${e instanceof Error ? e.stack : String(e)}`);
  console.error(e);
} finally {
  if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } }
  dc(['apps', 'stop', 'demo']);
}
console.log(`\n${findings.length ? '❌' : '✅'} ${passed} passed, ${findings.length} failed`);
for (const f of findings) console.log(`   ✗ ${f}`);
console.log(`shots: ${SHOTS}`);
process.exit(findings.length ? 1 : 0);
