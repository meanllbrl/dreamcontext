#!/usr/bin/env node
/**
 * Codex as a dependency, end to end, from a machine that has none of it.
 *
 *   npm run build && node scripts/verify/codex-install.mjs
 *
 * WHAT IT DRIVES: the real dist server on a launchd-like PATH in a fake HOME with no Codex, the
 * real React model picker, and a REAL `npm install` of the pinned package from the official
 * registry (about 100 MB, no account, no model call). `claude` is a stand-in, and so is `codex login`
 * (see the sign-in step: the real one opens a tab on this Mac).
 *
 * Checks: readiness says missing; Install in the picker lands Codex with no restart; the list comes
 * alive; Sign in runs the login and offers its page; a failed install says why
 * while a Claude chat still answers; `doctor --machine` shows both rows.
 * FAILURE POLICY: collect, don't fail fast; exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-codex-install');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const STUBS = join(SCRATCH, 'stubs');
const SHOTS = process.env.SHOTS_DIR || join(SCRATCH, 'shots');
const OPENED = join(SCRATCH, 'opened.txt');
const NARROW = `${STUBS}:/usr/bin:/bin:/usr/sbin:/sbin`;
const NODE = process.execPath;

const CLAUDE = `#!${NODE}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'claude-verify', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CLAUDE STILL ANSWERS' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'claude-verify' });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function freePort() {
  return new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

const results = [];
const ok = (label, cond, detail) => { results.push(!!cond); console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `  — ${String(detail).slice(0, 300)}` : ''}`); };

const childEnv = (extra = {}) => ({ HOME, USER: process.env.USER, SHELL: '/bin/sh', PATH: NARROW, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_CLI: join(REPO, 'dist', 'index.js'), ...extra });

async function startServer(port, extra) {
  const srv = spawn(NODE, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: childEnv(extra), stdio: 'ignore' });
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

const toolsOf = async (base) => (await (await fetch(`${base}/api/agent/tools`)).json()).tools.find((t) => t.tool === 'codex');
const readiness = async (base) => (await (await fetch(`${base}/api/onboarding/readiness?fresh=1`)).json()).checks;

async function openPicker(browser, base, width, height = 900) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 4 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
    if (await page.locator('.agent-surface.expanded').count()) break;
    const el = page.locator(sel).first();
    if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
  }
  const start = page.getByRole('button', { name: /Start chat/ });
  if (await start.count()) { await start.first().click(); await page.waitForTimeout(1500); }
  await page.locator('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]:visible').first().click();
  await page.waitForTimeout(400);
  const menu = page.locator('[data-testid="model-picker"]:visible').first();
  await menu.getByRole('button', { name: /^Codex/ }).first().click();
  await page.waitForTimeout(300);
  return { page, menu, errors };
}

async function main() {
  const { chromium } = await import('@playwright/test');
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), STUBS, SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), CLAUDE); chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const add = spawnSync(NODE, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ], { env: childEnv(), encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(add.stderr || add.stdout);

  const browser = await chromium.launch();
  try {
    // ── A failed install first: an unreachable registry, a Claude chat in the same window ──
    {
      console.log('failure stays on its own row');
      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      const srv = await startServer(port, { npm_config_https_proxy: 'http://127.0.0.1:9', npm_config_proxy: 'http://127.0.0.1:9', npm_config_fetch_retries: '0' });
      const { page, menu } = await openPicker(browser, base, 1440);
      await menu.locator('[data-testid="codex-fix"]').click();
      await menu.locator('[data-testid="codex-fix-error"]').waitFor({ timeout: 120_000 }).catch(() => {});
      const err = await menu.locator('[data-testid="codex-fix-error"]').innerText().catch(() => '');
      ok('a failed install says why, on the same line', err.length > 8, err);
      ok('it offers to try again', (await menu.locator('[data-testid="codex-fix"]').innerText().catch(() => '')) === 'Try again');
      await page.screenshot({ path: join(SHOTS, 'install-failed.png') });
      await page.keyboard.press('Escape');
      const input = page.locator('.chat-cmp-input:visible').first();
      await input.click(); await input.fill('ping'); await page.keyboard.press('Enter');
      const answered = await page.getByText('CLAUDE STILL ANSWERS').first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
      ok('a Claude chat still answers after the failure', answered);
      ok('nothing half-installed was left', !existsSync(join(HOME, '.dreamcontext/tools/codex/bin/codex')));
      await page.close();
      srv.kill();
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log('install from nothing');
    const doctorBefore = spawnSync(NODE, [join(REPO, 'dist', 'index.js'), 'doctor', '--machine', '--json'], { cwd: HOME, env: childEnv(), encoding: 'utf-8' });
    const before = JSON.parse(doctorBefore.stdout.slice(doctorBefore.stdout.indexOf('{'))).machine.checks;
    ok('doctor lists Codex as missing', before.find((c) => c.id === 'codex')?.status === 'missing', JSON.stringify(before.find((c) => c.id === 'codex')));
    ok('a missing Codex does not make the machine unready', JSON.parse(doctorBefore.stdout.slice(doctorBefore.stdout.indexOf('{'))).machine.checks.find((c) => c.id === 'codex')?.tier === 'recommended');

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const srv = await startServer(port);
    const first = await toolsOf(base);
    ok('narrow PATH, no Codex: installed false', first.installed === false && first.ready === false, JSON.stringify(first));
    const { page, menu, errors } = await openPicker(browser, base, 1440);
    const note = await menu.locator('[data-testid="model-picker-signin"]').innerText();
    ok('the picker says it, with Install on the same line', /not installed/.test(note) && /Install/.test(note), note);
    await page.screenshot({ path: join(SHOTS, 'picker-install-1440.png') });

    await menu.locator('[data-testid="codex-fix"]').click();
    ok('a working line shows while it installs', await menu.locator('[data-testid="codex-fix-working"]').waitFor({ timeout: 5000 }).then(() => true, () => false));
    await page.screenshot({ path: join(SHOTS, 'picker-installing-1440.png') });
    const landed = await menu.locator('[data-testid="model-picker-signin"]').filter({ hasText: 'not signed in' }).waitFor({ timeout: 300_000 }).then(() => true, () => false);
    ok('the row comes alive with no restart: not installed became not signed in', landed, await menu.innerText().catch(() => ''));
    const after = await toolsOf(base);
    ok('the server sees the managed Codex at the pinned version', after.installed && after.runs && after.version === '0.164.0' && existsSync(join(HOME, '.dreamcontext/tools/codex/bin/codex')), JSON.stringify(after));
    await page.screenshot({ path: join(SHOTS, 'picker-signin-1440.png') });
    const launcher = readFileSync(join(HOME, '.dreamcontext/tools/codex/bin/codex'), 'utf-8');
    ok('the launcher names no Node', !/\bnode\b/.test(launcher.replace(/node_modules/g, '')), launcher);
    const direct = spawnSync(join(HOME, '.dreamcontext/tools/codex/bin/codex'), ['--version'], { env: { PATH: '/nonexistent' }, encoding: 'utf-8' });
    ok('it starts with no usable PATH at all', direct.status === 0 && direct.stdout.includes('0.164.0'), `${direct.stdout}${direct.stderr}`);

    console.log('sign in');
    // Codex opens the browser through macOS itself, so nothing here can stand in for that call: a
    // real `codex login` would open a tab on this Mac. This stand-in prints what the real one
    // prints, and proves the route from the button to the page a person can open by hand.
    const managed = join(HOME, '.dreamcontext/tools/codex/bin/codex');
    const realLauncher = readFileSync(managed, 'utf-8');
    writeFileSync(managed, `#!/bin/sh\nif [ "$1" = login ]; then echo "$1" >> '${OPENED}'; echo 'If your browser did not open, navigate to this URL to authenticate:'; echo 'https://auth.openai.com/oauth/authorize?state=verify'; echo 'http://localhost:1455/auth/callback?code=SECRET'; sleep 30; exit 0; fi\n${realLauncher.split('\n').slice(1).join('\n')}`);
    await menu.locator('[data-testid="codex-fix"]').click();
    const page2 = menu.locator('[data-testid="codex-signin-page"]');
    ok('Sign in starts codex login and offers the page by hand', await page2.waitFor({ timeout: 15_000 }).then(() => true, () => false), existsSync(OPENED) ? 'login ran, no link' : 'login never ran');
    ok('it says what it is waiting for', /browser/.test(await menu.locator('[data-testid="codex-fix-working"]').innerText().catch(() => '')));
    const runs = await page.evaluate(() => document.body.innerText);
    ok('the local callback never reaches the screen', !runs.includes('SECRET'));
    await page.screenshot({ path: join(SHOTS, 'picker-signing-in-1440.png') });

    const statusChecks = await readiness(base);
    ok('the readiness model agrees: Codex ok with a version', statusChecks.find((c) => c.id === 'codex')?.status === 'ok' && statusChecks.find((c) => c.id === 'codex')?.version === '0.164.0', JSON.stringify(statusChecks.find((c) => c.id === 'codex')));
    ok('sign-in reads as still to do', statusChecks.find((c) => c.id === 'codex-auth')?.status === 'needs-action', JSON.stringify(statusChecks.find((c) => c.id === 'codex-auth')));

    // Signed in, the way the registry reads it (presence of the record), to see the list open up.
    mkdirSync(join(HOME, '.codex'), { recursive: true });
    writeFileSync(join(HOME, '.codex', 'auth.json'), '{"note":"verify placeholder, not a credential"}');
    const ready = await toolsOf(base);
    ok('ready true', ready.ready === true, JSON.stringify(ready));
    await page.close();
    const phone = await openPicker(browser, base, 390, 844);
    await phone.page.screenshot({ path: join(SHOTS, 'picker-ready-390.png') });
    await phone.page.close();
    ok('no page errors', errors.length === 0, errors.join(' | '));
    srv.kill();
  } finally {
    await browser.close();
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed. Screenshots: ${SHOTS}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
