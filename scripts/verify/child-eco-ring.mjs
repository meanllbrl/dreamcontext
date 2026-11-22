#!/usr/bin/env node
/**
 * A Super child's context ring and ECO lamp on its own ladder (super-cocuk-tasarruf k10, k12).
 *
 *   dreamcontext builder heavy -- node scripts/verify/child-eco-ring.mjs --out <dir>
 *
 * Real dashboard server (dist), scratch HOME, a fictional project (acme), a scripted `claude`
 * stand-in (no tokens). The child is opened EXACTLY the way it is in use: the owner's chat hands
 * over to the Super, and the Super stand-in runs the real `dreamcontext super delegate` from
 * inside its own process (the window opens the tab, the server records it). A text `CTX=<n>`
 * makes the stand-in answer with a main-chain usage of n context tokens: the delegate's prompt
 * carries CTX=300000, and an owner line `SEND CTX=450000` in the Super's composer makes the Super
 * run the real `super send <child> CTX=450000`.
 *
 * Owner pane first (its own chat, before the hand-over): 300k then 450k. Then the child: 300k
 * then 450k. Each step reads the ring's title, its lit bands, the usage panel's band bar and the
 * ECO pill, and photographs it (1440 light and dark, plus a 390 phone pass of the child).
 *
 * Wants: child = ECO asks at 250k, insists at 400k, seams 25/15/60, danger at 450k;
 * owner = 300k / 650k, seams 30/35/35, caution at 450k. Every spawn's argv and tab id is logged
 * (spawn-argv.json): the child's spawn must carry --strict-mcp-config (lean), the owner's not.
 * Exit 1 on a failed check or a console error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const REPO = resolve(arg('repo', '.'));
const OUT = resolve(arg('out', 'tmp/verify/child-eco-ring'));
const PORT = Number(arg('port', 45883));
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-child-eco-ring-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const ACME = join(SCRATCH, 'acme');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(ACME, '_dream_context', 'state', '.super-agent.json');
const failures = [];
const consoleErrors = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail ?? ''}`}`);
  if (!ok) failures.push(`${name} ${detail ?? ''}`);
  return !!ok;
};
mkdirSync(OUT, { recursive: true });

const STANDIN = `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : ''; };
let brief = '';
try { brief = fs.readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'chat';
const sid = at('--session-id') || at('--resume') || 'v-' + process.pid;
const report = (o) => fs.appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, sid, pid: process.pid, t: Date.now(), ...o }) + '\\n');
report({ kind: 'spawn', tab: process.env.DREAMCONTEXT_TAB_SESSION || '', argv });
const cli = (...a) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...a], { env: process.env, encoding: 'utf-8', timeout: 90000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: a.join(' '), status: r.status, json, out: ((r.stdout || '') + (r.stderr || '')).slice(0, 800) };
};
let kid = '';
function superTurn(text) {
  if (/DELEGATE-NOW/.test(text)) {
    const d = cli('super', 'delegate', '--prompt', 'CTX=300000 fix the Acme checkout', '--brief', 'Fix the checkout', '--mode', 'develop', '--model', 'opus');
    kid = (d.json && d.json.sessionId) || '';
    report({ kind: 'delegate', step: d, child: kid });
    return 'delegated';
  }
  const m = /SEND (CTX=\\d+)/.exec(text);
  if (m) {
    const s = cli('super', 'send', kid || 'missing', m[1] + ' keep going on the checkout');
    report({ kind: 'send', step: s });
    return 'sent';
  }
  return 'noted';
}
let inited = false;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    const content = o.message && o.message.content;
    const text = typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
    let said = 'ok';
    if (role === 'super') { try { said = superTurn(text.trim()); } catch (e) { said = 'error ' + e; } }
    const mm = role === 'super' ? null : /CTX=(\\d+)/.exec(text || '');
    const ctx = mm ? Number(mm[1]) : 1000;
    report({ kind: 'turn', ctx, text: (text || '').slice(0, 160) });
    const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: Math.max(0, ctx - 20), output_tokens: 10 };
    out({ type: 'assistant', message: { id: 'msg-' + Date.now() + '-' + Math.random(), role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'Context now ' + ctx + '. ') + said }], usage }, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return {}; } };
const cardId = (sid) => `chat-${createHash('sha1').update(sid).digest('hex').slice(0, 12)}`;

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(ACME, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['-C', ACME, 'init', '-q']);
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme'], projectOrder: ['acme'], lastVault: 'acme' }));
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme', ACME], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add: ${r.stderr || r.stdout}`);
  // Eco on for the vault: the default ladder for every pane; a child resolves its own.
  writeFileSync(join(ACME, '_dream_context', 'state', '.config.json'), JSON.stringify({ contextHandoff: { enabled: true } }));
}

async function server() {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(PORT)], { cwd: ACME, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(OUT, 'server.log'), { flags: 'w' });
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return srv; } catch { /* up soon */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('server did not come up');
}

const wait = (p, ms = 800) => p.waitForTimeout(ms);
const until = async (p, fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(p, 250); } return false; };

/** The ring of `root`: its title, lit bands, then (panel opened) the band bar and the ECO pill. */
async function readPane(p, root) {
  const btn = root.locator('.chat-cmp-usagebtn').first();
  const title = await btn.getAttribute('title');
  const bands = await btn.locator('[data-band]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-band')))]);
  await btn.click();
  await wait(p, 600);
  const panel = p.locator('.chat-cmp-bandbar:visible').first();
  const segs = await panel.locator('.chat-cmp-bandseg').evaluateAll((els) => {
    const total = els.reduce((a, e) => a + e.getBoundingClientRect().width, 0);
    return els.map((e) => Math.round((e.getBoundingClientRect().width / (total || 1)) * 1000) / 10);
  }).catch(() => []);
  const eco = (await p.locator('.chat-cmp-eco:visible').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  return { title, bands, segs, eco };
}

const WANT = {
  child: { nudge: '250k', hard: '400k', seams: [25, 15, 60], at450: 'danger' },
  owner: { nudge: '300k', hard: '650k', seams: [30, 35, 35], at450: 'caution' },
};

async function judge(p, tag, who, label, root, shot) {
  const n = label === '300k' ? '300' : '450';
  const shown = await until(p, async () => {
    const t = (await root.locator('.chat-cmp-usagebtn').first().getAttribute('title')) ?? '';
    return /Context window/.test(t) && t.includes(n);
  }, 30000);
  check(`${tag} ${who} @${label}: the ring reads the new context`, shown);
  const r = await readPane(p, root);
  console.log(`    ${who} @${label}: ${JSON.stringify(r)}`);
  const w = WANT[who];
  check(`${tag} ${who} @${label}: ECO pill says asks at ${w.nudge} · insists at ${w.hard}`, r.eco.includes(`asks at ${w.nudge}`) && r.eco.includes(`insists at ${w.hard}`), r.eco);
  check(`${tag} ${who} @${label}: ring title names ${w.nudge}/${w.hard}`, (r.title ?? '').includes(`asks at ${w.nudge}`) && (r.title ?? '').includes(`insists at ${w.hard}`), r.title);
  check(`${tag} ${who} @${label}: band bar seams ${w.seams.join('/')}%`, r.segs.length === 3 && r.segs.every((s, i) => Math.abs(s - w.seams[i]) <= 1.5), JSON.stringify(r.segs));
  const lit = label === '450k' ? w.at450 : 'caution';
  check(`${tag} ${who} @${label}: the ring lights ${lit}`, r.bands.includes(lit), JSON.stringify(r.bands));
  await p.screenshot({ path: join(OUT, `${shot}-${who}-${label}-panel.png`) });
  await p.keyboard.press('Escape');
  await wait(p, 300);
  return r;
}

async function say(p, root, text) {
  const input = root.locator('.chat-cmp-input').first();
  await input.click();
  await input.fill(text);
  await p.keyboard.press('Enter');
}

async function scene(browser, { w, h, dark }) {
  const theme = dark ? 'dark' : 'light';
  const tag = `${w}-${theme}`;
  console.log(`\n── ${tag}`);
  seed();
  let srv = await server();
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 2 });
  await ctx.addInitScript((d) => { try { localStorage.setItem('theme', d ? 'dark' : 'light'); localStorage.setItem('dreamcontext-theme', d ? 'dark' : 'light'); } catch { /* */ } }, dark);
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|first-read|403/.test(m.text())) consoleErrors.push(`${tag}: ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => consoleErrors.push(`${tag}: ${String(e).slice(0, 200)}`));
  p.on('response', (r) => { if (r.status() >= 400 && !/first-read/.test(r.url())) consoleErrors.push(`${tag}: ${r.status()} ${r.url()}`); });
  try {
    await p.route('**/api/onboarding/readiness**', async (r) => { try { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); } catch { /* page closed */ } });
    await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`);
    await wait(p, 3000);
    for (let i = 0; i < 3; i++) { await p.keyboard.press('Escape'); await wait(p, 150); }
    const g = p.getByRole('button', { name: 'Got it' });
    if (await g.isVisible().catch(() => false)) { await g.click(); await wait(p, 300); }
    if (!(await p.locator('.chat-cmp-input:visible').count())) await p.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    check(`${tag}: a composer is up`, await until(p, async () => (await p.locator('.chat-cmp-input:visible').count()) > 0, 25000));

    // 1. The owner's own chat, before any hand-over.
    const ownerRoot = p.locator('.chat-pane:visible').filter({ has: p.locator('.chat-cmp-input') }).first();
    await say(p, ownerRoot, 'CTX=300000 hello, Acme owner work');
    await until(p, async () => reports().some((r) => r.kind === 'turn' && r.role === 'chat'), 20000);
    const ownerSpawn = reports().find((r) => r.kind === 'spawn' && r.role === 'chat');
    console.log(`    owner tab ${ownerSpawn?.tab} · session ${ownerSpawn?.sid}`);
    await judge(p, tag, 'owner', '300k', ownerRoot, tag);
    await say(p, ownerRoot, 'CTX=450000 more Acme owner work');
    await judge(p, tag, 'owner', '450k', ownerRoot, tag);

    // 2. The Super's stage (the drawer's Super Agent row); the Super delegates through the real CLI.
    await p.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click().catch(() => {});
    const stageEl = p.locator('[data-testid="super-surface"]:visible').first();
    check(`${tag}: the Super stage opens`, await until(p, async () => (await stageEl.count()) > 0, 20000));
    const stageInput = async () => { const c = stageEl.locator('[data-super-slot="centre"] .chat-cmp-input'); return (await c.count()) ? c.first() : stageEl.locator('.chat-cmp-input').first(); };
    const sayStage = async (text) => { const i = await stageInput(); await i.click(); await i.fill(text); await p.keyboard.press('Enter'); };
    check(`${tag}: the stage has a composer`, await until(p, async () => (await stageEl.locator('.chat-cmp-input').count()) > 0, 30000));
    await sayStage('DELEGATE-NOW start the Acme checkout child');
    check(`${tag}: the Super ran super delegate`, await until(p, async () => reports().some((r) => r.kind === 'delegate'), 120000));
    const d = reports().find((r) => r.kind === 'delegate');
    const kid = d?.child ?? '';
    check(`${tag}: super delegate answered a session id`, /^[0-9a-f-]{36}$/i.test(kid), d?.step?.out);
    await until(p, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'chat' && (r.sid === kid || r.tab === kid)), 30000);
    const childSpawn = reports().find((r) => r.kind === 'spawn' && r.role === 'chat' && (r.sid === kid || r.tab === kid));
    console.log(`    child ${kid} · spawn tab ${childSpawn?.tab} · session ${childSpawn?.sid}`);
    const rec = record().children?.[kid];
    console.log(`    record child: ${JSON.stringify(rec ? { adopted: rec.adopted, mcp: rec.mcp, mode: rec.mode } : null)}`);
    check(`${tag}: the child's spawn is lean (--strict-mcp-config)`, !!childSpawn?.argv?.includes('--strict-mcp-config'), JSON.stringify(childSpawn?.argv));
    check(`${tag}: the owner's spawn is not lean`, !!ownerSpawn && !ownerSpawn.argv.includes('--strict-mcp-config'));

    // The child's pane: its card on the stage (opened full when the card has no composer).
    const cardEl = p.locator(`[data-container-id="${cardId(kid)}"]`);
    check(`${tag}: the child's card is on the stage`, await until(p, async () => (await cardEl.count()) > 0, 30000));
    check(`${tag}: the child's first turn (CTX=300000 in the delegate prompt) ran`, await until(p, async () => reports().some((r) => r.kind === 'turn' && r.sid === kid && r.ctx === 300000), 30000));
    await p.screenshot({ path: join(OUT, `${tag}-stage-card.png`) });
    // Handed over, the child's composer (and its ring) is replaced by the read-only line: the ring
    // is read where the owner can see it, after the take-back, in the child's own tab.
    const dis = await p.evaluate(async () => { const r = await fetch('/api/super/disable', { method: 'POST', headers: { 'X-Dreamcontext-Vault': 'acme', 'Content-Type': 'application/json' }, body: '{}' }); return r.status; });
    check(`${tag}: take-back answered 200`, dis === 200, String(dis));
    await wait(p, 1500);
    const toChildTab = async () => {
      await p.locator('aside, nav').getByText('Window', { exact: true }).first().click().catch(() => {});
      await wait(p, 1500);
      const tab = p.getByText('Fix the checkout', { exact: true }).first();
      if (await tab.isVisible().catch(() => false)) { await tab.click(); await wait(p, 900); }
      return p.locator('.chat-pane:visible').filter({ has: p.locator('.chat-cmp-input') }).filter({ hasText: 'Acme checkout' }).first();
    };
    let childRoot = await toChildTab();
    check(`${tag}: the child's own tab shows a composer after the take-back`, await until(p, async () => (await childRoot.count()) > 0, 20000));
    await p.screenshot({ path: join(OUT, `${tag}-child-tab.png`) });
    await say(p, childRoot, 'CTX=300000 the owner checks the child');
    await judge(p, tag, 'child', '300k', childRoot, tag);
    await say(p, childRoot, 'CTX=450000 the owner pushes the child');
    await until(p, async () => reports().some((r) => r.kind === 'turn' && r.sid === kid && r.ctx === 450000), 30000);
    await judge(p, tag, 'child', '450k', childRoot, tag);

    // The same child after an app restart: its next message respawns it; still lean, still its ladder.
    const spawnsBefore = reports().filter((r) => r.kind === 'spawn' && (r.sid === kid || r.tab === kid)).length;
    srv.kill();
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
    await wait(p, 1500);
    srv = await server();
    await p.reload();
    await wait(p, 3000);
    for (let i = 0; i < 3; i++) { await p.keyboard.press('Escape'); await wait(p, 150); }
    await p.locator('aside, nav').getByText('Window', { exact: true }).first().click().catch(() => {});
    await wait(p, 1500);
    const backTab = p.getByText('Fix the checkout', { exact: true }).first();
    check(`${tag}: after a restart the child's tab is back`, await until(p, async () => backTab.isVisible(), 25000));
    await backTab.click();
    await wait(p, 1200);
    childRoot = p.locator('.chat-pane:visible').filter({ has: p.locator('.chat-cmp-input') }).first();
    await say(p, childRoot, 'CTX=450000 after the restart');
    check(`${tag}: after a restart the child respawned`, await until(p, async () => reports().filter((r) => r.kind === 'spawn' && (r.sid === kid || r.tab === kid)).length > spawnsBefore, 30000));
    const re = reports().filter((r) => r.kind === 'spawn' && (r.sid === kid || r.tab === kid)).at(-1);
    console.log(`    respawn tab ${re?.tab} · session ${re?.sid} · strict ${re?.argv?.includes('--strict-mcp-config')}`);
    check(`${tag}: after a restart the child's spawn is still lean`, !!re?.argv?.includes('--strict-mcp-config'), JSON.stringify(re?.argv));
    await judge(p, `${tag} restart`, 'child', '450k', childRoot, `${tag}-restart`);
  } catch (e) {
    failures.push(`${tag} harness: ${String(e).slice(0, 400)}`);
    console.log(String(e));
    await p.screenshot({ path: join(OUT, `${tag}-harness-error.png`) }).catch(() => {});
  } finally {
    writeFileSync(join(OUT, `${tag}-spawn-argv.json`), JSON.stringify(reports().filter((r) => r.kind !== 'turn'), null, 2));
    await ctx.close();
    srv.kill();
    spawnSync('pkill', ['-f', SCRATCH]);
  }
}

// CHROMIUM_PATH: a cached browser of another Playwright build when this one's is missing.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const only = arg('only', '');
  const scenes = [{ w: 1440, h: 900, dark: false }, { w: 1440, h: 900, dark: true }, { w: 390, h: 844, dark: false }];
  for (const sc of scenes) if (!only || only === `${sc.w}-${sc.dark ? 'dark' : 'light'}`) await scene(browser, sc);
} finally {
  await browser.close();
}
for (const e of consoleErrors) failures.push(`console: ${e}`);
if (failures.length) { console.log(`\nFAIL (${failures.length})`); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('\nPASS');
