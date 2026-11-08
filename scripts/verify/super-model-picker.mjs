#!/usr/bin/env node
/**
 * The new model picker on every chat: normal, Super Agent, agent-bound.
 *
 *   npm run build && node scripts/verify/super-model-picker.mjs
 *
 * Real dashboard server and React surface in Chromium on a scratch HOME and a fictional vault.
 * `claude` is a stand-in that records its argv and every live model switch; `codex` is
 * scripts/verify/fake-codex.mjs. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-super-picker');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const LOG = join(SCRATCH, 'claude.log');
const SHOTS = process.env.SHOTS_DIR || join(SCRATCH, 'shots');
const CLI = join(REPO, 'dist', 'index.js');
const FIXTURES = join(REPO, 'src/vendor/t3/apps/server/src/orchestration-v2/testkit/fixtures');

const STANDIN = `#!${process.execPath}
const fs = require('node:fs');
const log = (o) => fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(o) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
log({ argv: process.argv.slice(2) });
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') {
      log({ control: o.request });
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    out({ type: 'system', subtype: 'init', session_id: 'claude-verify', model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CLAUDE SAYS: ' + text.slice(0, 60) }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'claude-verify' });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1', FAKE_CODEX_FIXTURES: FIXTURES, FAKE_CODEX_LOG: join(SCRATCH, 'fake-codex.log'), DREAMCONTEXT_CLI: CLI });

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.codex'), join(PROJ, '_dream_context', 'state'), SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  writeFileSync(join(HOME, '.local', 'bin', 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${join(REPO, 'scripts/verify/fake-codex.mjs')}" "$@"\n`);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  chmodSync(join(HOME, '.local', 'bin', 'codex'), 0o755);
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{"note":"verify placeholder, not a credential"}');
  writeFileSync(join(HOME, '.codex', 'config.toml'), 'model = "gpt-6-luna"\n');
  writeFileSync(join(HOME, '.codex', 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] },
  ] }));
  // An old settings file: the removed favourites field must be ignored, not break the read.
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true, modelFavourites: ['codex:gpt-6-luna'],
  }));
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const run = (...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: PROJ, env: env(), encoding: 'utf-8' }); if (r.status !== 0) throw new Error(`${a.join(' ')}: ${r.stderr || r.stdout}`); };
  run('vaults', 'add', 'proj', PROJ);
  run('agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'You read the product funnel and name what moved.');
}

async function serve(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('server did not come up');
}

const results = [];
const ok = (label, cond, detail) => { results.push(!!cond); console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `  — ${String(detail).slice(0, 300)}` : ''}`); };
const logged = () => (existsSync(LOG) ? readFileSync(LOG, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const uiFile = () => JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), 'utf-8'));

async function main() {
  const { chromium } = await import('@playwright/test');
  setup();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await serve(port);
  const browser = await chromium.launch();
  const errors = [];
  const open = async ({ width = 1440, height = 900, theme = 'dark' } = {}) => {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
    return page;
  };
  const kit = (page) => {
    const vis = (s) => page.locator(`${s}:visible`);
    const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); } return false; };
    const picker = () => vis('[data-testid="model-picker"]').first();
    const openPicker = async () => {
      await page.keyboard.press('Escape');
      await vis('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]').first().click({ timeout: 8000 });
      await until(async () => (await vis('[data-testid="model-picker"]').count()) > 0, 5000);
    };
    const expand = async () => {
      for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
      if (await vis('.chat-cmp-input').count()) return;
      // The new shell's drawer holds the way in; a phone has the classic surface.
      const drawerNew = page.getByText('New Chat', { exact: true }).first();
      if (await drawerNew.isVisible().catch(() => false)) { await drawerNew.click({ force: true }); await until(async () => (await vis('.chat-cmp-input').count()) > 0); return; }
      if (!(await page.locator('.agent-surface.expanded').count())) {
        for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
          const el = page.locator(sel).first();
          if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
          if (await page.locator('.agent-surface.expanded').count()) break;
        }
      }
      if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat|New chat/ }).first().click({ timeout: 5000 }).catch(() => {});
      await until(async () => (await vis('.chat-cmp-input').count()) > 0);
      if (!(await vis('.chat-cmp-input').count())) { await page.screenshot({ path: join(SHOTS, 'debug-expand.png') }); console.log(`  body: ${(await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | ')}`); }
    };
    const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
    return { vis, until, picker, openPicker, expand, shot };
  };

  try {
    console.log('── normal chat, empty');
    const page = await open();
    const k = kit(page);
    await k.expand();
    ok('a chat opens', (await k.vis('.chat-cmp-input').count()) > 0);
    const trigger = () => k.vis('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]').first();
    ok('the trigger names the version', /\d/.test(await trigger().innerText()), await trigger().innerText());
    await k.openPicker();
    const rows = () => k.picker().getByRole('menuitemradio').allInnerTexts();
    ok('the new picker opens', (await k.vis('[data-testid="model-picker"]').count()) === 1);
    ok('versions, most capable first', JSON.stringify((await rows()).slice(0, 4)) === JSON.stringify(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']), await rows());
    ok('no favourites anywhere', !/favourite/i.test(await k.picker().innerHTML()) && !(await k.picker().innerText()).includes('★'));
    await k.shot('01-claude-list-1440-dark');
    await k.picker().getByRole('button', { name: /Legacy models/ }).click();
    ok('Legacy: the older versions, with their count', (await rows()).includes('Opus 4.8') && (await k.picker().innerText()).includes('9 models'), await rows());
    await k.shot('02-claude-legacy-1440-dark');
    await k.picker().getByLabel('Search models').fill('4.8');
    ok('search finds a legacy row of the rail\'s own tool', (await rows()).includes('Opus 4.8'), await rows());
    await k.picker().getByLabel('Search models').fill('');
    await k.picker().getByRole('menuitemradio', { name: 'Opus 4.6' }).click();
    ok('the trigger follows the older version', (await trigger().innerText()).includes('Opus 4.6'), await trigger().innerText());
    ok('the live switch carries the exact id', await k.until(async () => logged().some((e) => e.control?.model === 'claude-opus-4-6'), 8000), JSON.stringify(logged().slice(-3)));
    await k.openPicker();
    ok('reopened: the older row is on view and marked', await k.picker().locator('.mp-row.is-active').innerText().then((t) => t.includes('Opus 4.6')));
    await k.picker().getByRole('button', { name: /^Effort/ }).click();
    ok('efforts follow the model (no Xhigh on 4.6)', !(await k.vis('.mp-efforts').first().innerText()).toLowerCase().includes('xhigh'), await k.vis('.mp-efforts').first().innerText());
    await k.shot('03-effort-follows-1440-dark');

    console.log('── fresh chat → Codex');
    await k.picker().getByRole('button', { name: 'Codex', exact: true }).click();
    await k.shot('04-codex-note-1440-dark');
    await k.picker().getByRole('menuitemradio', { name: /GPT-6 Luna/ }).click();
    await page.waitForTimeout(500);
    ok('an empty chat switches with no dialog', (await page.getByRole('alertdialog').count()) === 0);
    const placeholder = () => k.vis('.chat-cmp-input').first().getAttribute('placeholder');
    ok('the same tab is now on Codex', await k.until(async () => /Message Codex/.test(await placeholder()), 45000), await placeholder());

    console.log('── started chat → Codex, handoff confirm');
    await page.locator('.agent-new-split button:visible').first().click({ timeout: 5000 });
    await k.until(async () => /Message Claude/.test(await placeholder()), 15000);
    const claudeTab = /Message Claude/.test(await placeholder());
    ok('a second chat opens on Claude', claudeTab, await placeholder());
    if (claudeTab) {
      await k.vis('.chat-cmp-input').first().fill('REMEMBER marigold');
      await page.keyboard.press('Enter');
      await k.until(async () => (await k.vis('.chat-pane').first().innerText()).includes('CLAUDE SAYS'));
      await page.waitForTimeout(1500);
      await k.openPicker();
      await k.picker().getByRole('button', { name: 'Codex', exact: true }).click();
      await k.picker().getByRole('menuitemradio', { name: /GPT-6 Luna/ }).click();
      const sheet = page.getByRole('alertdialog').first();
      ok('a started chat asks first', await k.until(async () => (await sheet.count()) > 0, 5000));
      await k.shot('05-handoff-confirm-1440-dark');
      await sheet.getByRole('button', { name: /Stay here/ }).click();

      console.log('── an older version survives a reopen');
      await k.openPicker();
      await k.picker().getByRole('button', { name: /Legacy models/ }).click();
      await k.picker().getByRole('menuitemradio', { name: 'Opus 4.8' }).click();
      await page.waitForTimeout(2500);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
      await k.expand();
      // Restored tabs come back beside each other: find the Claude one.
      for (const tab of await k.vis('.agent-tab-title').all()) {
        await tab.click().catch(() => {});
        await page.waitForTimeout(800);
        if (/Opus 4\.8/.test(await trigger().innerText().catch(() => ''))) break;
      }
      await k.until(async () => /Opus 4\.8/.test(await trigger().innerText()), 10000);
      ok('the reopened chat names Opus 4.8', (await trigger().innerText()).includes('Opus 4.8'), await trigger().innerText());
      await k.openPicker();
      ok('its row is on view and marked, Legacy already open', (await k.picker().locator('.mp-row.is-active').innerText()).includes('Opus 4.8'));
      await k.shot('05b-reopened-legacy-1440-dark');

      console.log('── a spawn on an older version');
      // A reload reattaches the live process: a new chat is what spawns. Its default is this pick.
      await k.picker().getByRole('button', { name: /Set as default/ }).click();
      await k.until(async () => uiFile().chatDefaultModel === 'claude-opus-4-8', 6000);
      await page.keyboard.press('Escape');
      await page.locator('.agent-new-split button:visible').first().click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      await k.vis('.chat-cmp-input').first().fill('Which version?');
      await page.keyboard.press('Enter');
      ok('the spawn runs that exact id', await k.until(async () => logged().some((e) => { const at = e.argv?.indexOf('--model') ?? -1; return at >= 0 && e.argv[at + 1] === 'claude-opus-4-8'; }), 15000), JSON.stringify(logged().filter((e) => e.argv).slice(-1)));
    }
    await page.close();

    console.log('── agent-bound chat');
    const a = await open();
    const ka = kit(a);
    await a.getByTestId('drawer-member-row').first().click();
    await a.waitForTimeout(2500);
    // The owner's step in the app, on this scratch agent.
    await a.getByRole('button', { name: 'Review it' }).click({ timeout: 5000 });
    await a.waitForTimeout(1500);
    await a.locator('.aiteam-approval button:visible, [data-team-approval] button:visible').first().click({ timeout: 5000 });
    await a.waitForTimeout(1500);
    await a.locator('.aiteam-approval-foot .agent-btn--primary:visible').first().click({ timeout: 5000 });
    await a.waitForTimeout(1500);
    await ka.vis('.agent-chat-pane-host .chat-cmp-input, [data-stage="scout"] .chat-cmp-input').first().waitFor({ timeout: 15000 }).catch(() => {});
    await a.screenshot({ path: join(SHOTS, 'debug-agent-approve.png') });
    const first = ka.vis('.agent-chat-pane-host .chat-cmp-input, .aiteam-convo .chat-cmp-input').first();
    if (await first.count()) {
      await first.fill('hello');
      await a.keyboard.press('Enter');
      await ka.until(async () => (await ka.vis('.agent-chat-pane-host .chat-cmp-input').count()) > 0, 20000);
      await a.waitForTimeout(2000);
    }
    await a.screenshot({ path: join(SHOTS, 'debug-agent.png') });
    await ka.openPicker().catch(() => {});
    const bound = (await ka.vis('.agent-chat-pane-host [data-testid="model-picker"]').count()) === 1;
    ok('an agent\'s chat draws the new picker', bound, await a.locator('body').innerText().then((t) => t.slice(0, 200)));
    if (bound) {
      await ka.picker().getByRole('button', { name: 'Codex', exact: true }).click();
      ok('Codex is on view and cannot be picked', await ka.picker().getByRole('menuitemradio', { name: /GPT-6 Luna/ }).isDisabled());
      ok('one line says why', (await ka.vis('[data-testid="model-picker-lock"]').first().innerText()).includes('stays on its own tool'));
      await ka.shot('06-agent-locked-1440-dark');
    }
    await a.close();

    console.log('── Super Agent');
    const s = await open();
    const ks = kit(s);
    await ks.expand();
    const hand = ks.vis('[data-testid="super-handover-btn"]').first();
    if (await hand.count()) await hand.click();
    else await s.getByText('Super Agent', { exact: true }).first().click({ force: true });
    ok('the Super stage shows', await ks.until(async () => (await ks.vis('[data-testid="super-surface"]').count()) > 0, 30000));
    await ks.until(async () => (await ks.vis('.super-centre .chat-cmp-input, [data-super-slot="centre"] .chat-cmp-input').count()) > 0, 30000);
    await s.waitForTimeout(1500);
    await ks.openPicker();
    ok('Super draws the new picker, not the old menu', (await ks.vis('[data-testid="model-picker"]').count()) === 1 && !(await ks.picker().innerText()).includes('Other models'));
    ok('Claude rows are live', await ks.picker().getByRole('menuitemradio', { name: 'Sonnet 5.5' }).isEnabled());
    await ks.shot('07-super-claude-1440-dark');
    await ks.picker().getByRole('button', { name: 'Codex', exact: true }).click();
    ok('Super: Codex is on view and cannot be picked', await ks.picker().getByRole('menuitemradio', { name: /GPT-6 Luna/ }).isDisabled());
    const line = await ks.vis('[data-testid="model-picker-lock"]').first().innerText();
    ok('Super: one line says why, and offers a new chat', line.includes('always runs on Claude') && line.includes('Open Codex in a new chat'), line);
    await ks.shot('08-super-locked-1440-dark');
    await s.emulateMedia({ colorScheme: 'light' });
    await s.waitForTimeout(400);
    await ks.shot('09-super-locked-1440-light');
    await s.emulateMedia({ colorScheme: 'dark' });
    await ks.picker().getByLabel('Search models').fill('luna');
    ok('Super: a search keeps the lock and its line', await ks.picker().getByRole('menuitemradio', { name: /GPT-6 Luna/ }).isDisabled() && (await ks.vis('[data-testid="model-picker-lock"]').count()) === 1);
    await ks.picker().getByLabel('Search models').fill('');
    await ks.picker().getByRole('button', { name: 'Claude', exact: true }).click();
    await ks.picker().getByRole('button', { name: /Set as default/ }).click();
    ok('Super: Set as default writes the Super default, not the chat default', await ks.until(async () => !!uiFile().superModel && uiFile().chatDefaultModel === 'claude-opus-4-8', 6000), JSON.stringify(uiFile()));
    ok('the old favourites field is gone after a save', !('modelFavourites' in uiFile()), JSON.stringify(uiFile()));
    await ks.picker().getByRole('button', { name: 'Codex', exact: true }).click();
    await ks.picker().getByRole('button', { name: 'Open Codex in a new chat' }).click();
    const ph = () => ks.vis('.chat-cmp-input').first().getAttribute('placeholder');
    ok('the link opens a Codex chat on screen', await ks.until(async () => /Message Codex/.test(await ph()), 45000), await ph().catch(() => ''));
    const sup = await s.evaluate(async () => (await (await fetch('/api/super/state', { headers: { 'X-Dreamcontext-Vault': 'proj' } })).json()));
    ok('the Super Agent stays handed over behind it', sup?.enabled === true, JSON.stringify(sup).slice(0, 200));
    await ks.shot('10-super-opened-codex-1440-dark');
    await s.close();

    console.log('── widths and themes');
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      for (const theme of ['dark', 'light']) {
        const v = await open({ width, height, theme });
        const kv = kit(v);
        await kv.expand();
        await kv.openPicker().catch(() => {});
        await kv.picker().getByRole('button', { name: 'Codex', exact: true }).click().catch(() => {});
        const box = await kv.picker().boundingBox().catch(() => null);
        ok(`${width} ${theme}: the picker fits`, !!box && box.x >= 0 && box.x + box.width <= width && box.y >= 0, JSON.stringify(box));
        await kv.shot(`11-picker-${width}-${theme}`);
        await v.close();
      }
    }
    ok('no console or page error', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed · shots: ${SHOTS}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
