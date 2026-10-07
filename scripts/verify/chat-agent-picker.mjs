#!/usr/bin/env node
/**
 * The Chat composer's AGENT picker, end to end.
 *
 *   npm run build && node scripts/verify/chat-agent-picker.mjs
 *
 * WHAT IT DRIVES: the real dashboard server (`dist/index.js dashboard`), the real
 * `/api/agent/chat` WebSocket upgrade, real React in Chromium, and a scripted stand-in for
 * `claude` on a scratch HOME that echoes back the briefing file and permission mode it was
 * spawned with. No tokens are spent.
 *
 *   §1 server: a malformed `chatAgent` is refused at the upgrade; an unapproved agent is
 *      refused with a named reason; an approved one is spawned with its identity briefing
 *      ahead of the tab's mode brief, under the tab's own permission mode.
 *   §1b server: every chat gets `--agents` for the approved agents (never an unapproved one,
 *      never the tab's own agent) and a roster in its briefing saying it can call them.
 *   §2 browser: the mode menu lists Claude and every agent, the unapproved one unpickable;
 *      picking an agent in an EMPTY chat reuses the tab, the trigger names the agent, and the
 *      socket carries `chatAgent`; the agent answers from its identity.
 *   §3 browser: picking Claude in a chat WITH history opens a new tab beside it, without
 *      `chatAgent`, and the agent's tab survives.
 *   §4 browser: a reload restores the agent's tab as that agent (`chatAgent` + `resume`).
 *
 * Isolated fake HOME, always; collect, don't fail fast. Exit 0 iff everything passed.
 * `VERIFY_SHOTS=<dir>` saves the open menu, the agent's chat and the final pane.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-agent-picker');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const ECHO = '<<<DC-SPAWN-ECHO>>>';
const AGENT = 'funnel-watch';
const DRAFT = 'draft-agent';

const STANDIN = `#!${process.execPath}
import { readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? null); };
const briefPath = flag('--append-system-prompt-file');
let briefing = null;
if (briefPath) { try { briefing = readFileSync(briefPath, 'utf-8'); } catch (e) { briefing = 'READ-FAILED'; } }
const agentsFile = flag('--agents');
let agents = null;
if (agentsFile) { try { agents = JSON.parse(readFileSync(agentsFile, 'utf-8')); } catch (e) { agents = 'READ-FAILED'; } }
const report = { permissionMode: flag('--permission-mode'), briefing, agents };
let n = 0;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    n++;
    out({ type: 'system', subtype: 'init', session_id: 'verify-agent-picker', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: report.permissionMode, slash_commands: [] });
    const who = (briefing || '').match(/You are "([^"]+)"/);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I am ' + (who ? who[1] : 'Claude') + '. ' + ${JSON.stringify(ECHO)} + JSON.stringify(report) }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: n, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'verify-agent-picker' });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const cli = (args) => spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args],
  { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'state', '.config.json'), JSON.stringify({
    platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false },
  }));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const add = cli(['vaults', 'add', 'proj', PROJ]);
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);

  const promptFile = join(SCRATCH, 'prompt.md');
  writeFileSync(promptFile, 'Watch the signup funnel and flag any step that drops.');
  for (const [slug, title] of [[AGENT, 'Funnel watch'], [DRAFT, 'Draft agent'], ['weekly-brief', 'Weekly brief']]) {
    const r = cli(['automations', 'create', slug, '--title', title, '--mode', 'call', '--prompt-file', promptFile]);
    if (r.status !== 0) throw new Error(`automations create ${slug} failed: ${r.stderr || r.stdout}`);
  }
  // An edit after approval: the draft agent is no longer approved on this machine.
  const manifest = join(PROJ, '_dream_context', 'automations', `${DRAFT}.md`);
  writeFileSync(manifest, readFileSync(manifest, 'utf-8').replace('flag any step that drops.', 'flag any step that drops, then email it.'));
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

/** One WS open: resolves with the echo report, a `_meta` error, or the upgrade's refusal. */
async function openChat(WebSocket, port, params) {
  const qs = new URLSearchParams({ vault: 'proj', bypass: '0', sessionId: crypto.randomUUID(), ...params }).toString();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/chat?${qs}`);
  return await new Promise((resolve) => {
    const timer = setTimeout(() => done({ kind: 'timeout' }), 20_000);
    function done(r) { clearTimeout(timer); try { ws.close(); } catch { /* closing */ } resolve(r); }
    ws.on('unexpected-response', (_req, res) => done({ kind: 'refused', status: res.statusCode }));
    ws.on('error', (err) => done({ kind: 'error', message: String(err) }));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'user', text: 'GO' })));
    ws.on('message', (raw) => {
      let f; try { f = JSON.parse(raw.toString('utf-8')); } catch { return; }
      if (f?.type === '_meta' && f.subtype === 'error') { done({ kind: 'meta-error', message: f.message, code: f.code }); return; }
      const text = f?.type === 'assistant' ? (f.message?.content ?? []).map((b) => b.text ?? '').join('') : '';
      const at = text.indexOf(ECHO);
      if (at >= 0) done({ kind: 'echo', ...JSON.parse(text.slice(at + ECHO.length)) });
    });
  });
}

const WS_SPY = `
  window.__dcChatSockets = [];
  const Native = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    try { if (String(url).includes('/api/agent/chat')) window.__dcChatSockets.push(String(url)); } catch {}
    return protocols === undefined ? new Native(url) : new Native(url, protocols);
  };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, Native);
`;

const report = {
  pass: 0, fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
};
const ok = (l, c, d) => report.check(l, c, d);

async function serverLeg(WebSocket, port) {
  console.log('\n── §1 the server envelope');
  const bad = await openChat(WebSocket, port, { chatAgent: '../etc' });
  ok('a malformed chatAgent is refused at the upgrade (400)', bad.kind === 'refused' && bad.status === 400, JSON.stringify(bad));
  const draft = await openChat(WebSocket, port, { chatAgent: DRAFT });
  ok('an unapproved agent is refused with a named reason, nothing spawned',
    draft.kind === 'meta-error' && draft.code === 'agent_refused' && /not approved/.test(draft.message), JSON.stringify(draft));
  const good = await openChat(WebSocket, port, { chatAgent: AGENT, mode: 'plan' });
  const b = good.briefing ?? '';
  ok('an approved agent spawns with its identity briefing', good.kind === 'echo'
    && b.includes('AGENT CONVERSATION') && b.includes('You are "Funnel watch"') && b.includes('Watch the signup funnel'), b.slice(0, 300));
  ok('…the identity comes before the tab mode brief, which is still there',
    b.indexOf('AGENT CONVERSATION') >= 0 && b.indexOf('AGENT CONVERSATION') < b.indexOf('# Mode: Plan'));
  ok('…under the tab permission mode, not a board scope', good.permissionMode === 'auto', good.permissionMode);
  const plain = await openChat(WebSocket, port, {});
  ok('a chat without chatAgent is plain Claude', plain.kind === 'echo' && !(plain.briefing ?? '').includes('AGENT CONVERSATION'));

  console.log('\n── §1b the agents as sub-agents');
  const keys = (r) => (r.agents && typeof r.agents === 'object' ? Object.keys(r.agents).sort().join(',') : String(r.agents));
  ok('a plain chat is spawned with --agents for every APPROVED agent', keys(plain) === `${AGENT},weekly-brief`, keys(plain));
  ok('…each carrying the agent identity as its prompt',
    (plain.agents?.[AGENT]?.prompt ?? '').includes('called as a sub-agent') && (plain.agents?.[AGENT]?.prompt ?? '').includes('Watch the signup funnel'));
  ok('…and the briefing tells Claude it can call them',
    (plain.briefing ?? '').includes("## This project's agents") && (plain.briefing ?? '').includes(`- \`${AGENT}\` Funnel watch`)
    && !(plain.briefing ?? '').includes(`\`${DRAFT}\``));
  ok("an agent's own tab can call the others, never itself", keys(good) === 'weekly-brief', keys(good));
}

async function browserLeg(chromium, base) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: 'dark' });
  await page.addInitScript(WS_SPY);
  page.on('pageerror', (e) => console.log(`  [page error] ${String(e).slice(0, 160)}`));
  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  const sockets = () => page.evaluate(() => window.__dcChatSockets ?? []);
  const lastSocket = async () => (await sockets()).at(-1) ?? '';
  const tabCount = () => page.locator('.agent-tab').count();
  const openSurface = async () => {
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
    if (!(await page.locator('.agent-surface.expanded').count())) {
      for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
        if (await page.locator('.agent-surface.expanded').count()) break;
      }
    }
  };
  const say = async (text) => {
    await vis('.chat-cmp-input').first().click();
    await vis('.chat-cmp-input').first().fill(text);
    await page.keyboard.press('Enter');
  };
  const paneText = async () => (await vis('.chat-pane').first().innerText()).replace(/\s+/g, ' ');
  const modeTrigger = () => vis('.chat-cmp-perm-wrap .chat-cmp-modeltrigger').first();
  const shots = process.env.VERIFY_SHOTS;

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await openSurface();
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(async () => (await vis('.chat-cmp-input').count()) > 0));
  await page.waitForTimeout(600);

  console.log('\n── §2 the menu, and an agent picked in an empty chat');
  await modeTrigger().click();
  await page.waitForTimeout(400);
  const select = () => vis('.chat-cmp-modemenu .chat-cmp-agentselect').first();
  const rows = vis('.chat-cmp-modemenu .chat-cmp-agentoption');
  const chip = (name) => rows.filter({ hasText: name }).first();
  const grid = await vis('.chat-cmp-modemenu .chat-cmp-scroll.is-grid').first().boundingBox();
  const sel = await select().boundingBox();
  ok('the agent selector is ONE row under the modes, naming Claude',
    sel.y > grid.y + grid.height && sel.height <= 40 && (await select().innerText()).includes('Claude'),
    `grid=${JSON.stringify(grid)} select=${JSON.stringify(sel)}`);
  ok('…and the closed menu draws no roster', (await rows.count()) === 0);
  if (shots) await page.screenshot({ path: `${shots}/chat-agent-picker-closed.png` });
  await select().click();
  await page.waitForTimeout(250);
  const names = (await rows.allInnerTexts()).map((t) => t.trim().split('\n').pop().trim());
  ok('opened, it lists Claude and every agent, by name', names[0] === 'Claude' && [...names.slice(1)].sort().join('|') === 'Draft agent|Funnel watch|Weekly brief', names.join('|'));
  ok('…Claude is the selected one', (await rows.first().getAttribute('aria-selected')) === 'true');
  ok('…the unapproved agent cannot be picked, and says where to fix it',
    (await chip('Draft agent').isDisabled())
    && ((await chip('Draft agent').getAttribute('title')) ?? '').includes('Approve it in Automations first'));
  if (shots) await page.screenshot({ path: `${shots}/chat-agent-picker-menu.png` });
  const tabsBefore = await tabCount();
  const socketsBefore = (await sockets()).length;
  await chip('Funnel watch').click();
  ok('picking the agent opens a socket with chatAgent', await until(async () => (await sockets()).length > socketsBefore
    && (await lastSocket()).includes(`chatAgent=${AGENT}`)), await lastSocket());
  ok('…as a NEW conversation (sessionId, not resume)', /[?&]sessionId=/.test(await lastSocket()) && !/[?&]resume=/.test(await lastSocket()));
  ok('…in the same tab, since nothing had been said in it', (await tabCount()) === tabsBefore, `${tabsBefore} → ${await tabCount()}`);
  ok('…and the trigger names the agent', await until(async () => (await modeTrigger().innerText()).includes('Funnel watch')), await modeTrigger().innerText());
  await say('Who are you?');
  ok('the agent answers as itself', await until(async () => (await paneText()).includes('I am Funnel watch'), 25000), (await paneText()).slice(-200));
  if (shots) await page.screenshot({ path: `${shots}/chat-agent-picker-agent.png` });

  console.log('\n── §3 back to Claude from a chat with history');
  const tabsMid = await tabCount();
  await modeTrigger().click();
  await page.waitForTimeout(300);
  ok('…the selector names the agent now',
    (await select().innerText()).includes('Funnel watch'));
  await select().click();
  await page.waitForTimeout(250);
  ok('…and is the selected one in the list', (await chip('Funnel watch').getAttribute('aria-selected')) === 'true');
  await chip('Claude').click();
  ok('picking Claude opens a new tab beside it', await until(async () => (await tabCount()) === tabsMid + 1), `${tabsMid} → ${await tabCount()}`);
  ok('…on a socket without chatAgent', !(await lastSocket()).includes('chatAgent='), await lastSocket());
  await say('And you?');
  ok('…where plain Claude answers', await until(async () => (await paneText()).includes('I am Claude'), 25000));

  console.log('\n── §4 a relaunch restores the agent tab');
  await page.waitForTimeout(1500); // the roster PUT is debounced
  await page.evaluate(() => { window.__dcChatSockets = []; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const restored = await sockets();
  ok('the agent tab resumes as the agent (chatAgent + resume)',
    restored.some((u) => u.includes(`chatAgent=${AGENT}`) && /[?&]resume=/.test(u)), restored.join('\n      '));
  ok('…and the plain tab resumes without it', restored.some((u) => !u.includes('chatAgent=') && /[?&]resume=/.test(u)));
  if (shots) { await openSurface(); await page.waitForTimeout(800); await page.screenshot({ path: `${shots}/chat-agent-picker-final.png` }); }
  await browser.close();
}

let server = null;
try {
  const { WebSocket } = await import('ws');
  const { chromium } = await import('@playwright/test');
  console.log('· setting up scratch vault, two agents and a scripted claude (isolated HOME)…');
  setupScratch();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  await serverLeg(WebSocket, port);
  await browserLeg(chromium, `http://127.0.0.1:${port}`);
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
