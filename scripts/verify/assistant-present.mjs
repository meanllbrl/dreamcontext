#!/usr/bin/env node
/**
 * The notch shows each Assistant reply the way its cue says — driven in Chromium.
 *
 *   npm run build && node scripts/verify/assistant-present.mjs
 *
 * The real dashboard server on an isolated HOME, the real notch UI on a mocked Tauri bus (as in
 * assistant.mjs), and a stand-in `claude` that answers LATE and STREAMS its reply as the real
 * CLI does (content_block_start / text_delta / content_block_stop, then the whole message), so
 * the cue arrives the way it does in the owner's app. The owner folds the notch after sending;
 * the reply decides what happens next:
 *   present        → the folded notch OPENS by itself, then folds again once it has been read
 *   present stay   → it opens and STAYS open
 *   progress       → it does NOT open; a peek shows the line
 * No real `claude`, no paid speech (TTS is routed to a 204), no system audio focus.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-present');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'projects', 'alpha-app');

// LATER:<ms>:<base64 reply> — wait, then stream the reply as one text block, in small deltas.
const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : (argv[i + 1] ?? null); };
let initDone = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(text) {
  const conv = flag('--session-id') ?? flag('--resume') ?? 'conv-' + process.pid;
  if (!initDone) { initDone = true; out({ type: 'system', subtype: 'init', session_id: conv, model: 'x', cwd: process.cwd(), slash_commands: [] }); }
  const m = /^LATER:(\\d+):(.*)$/s.exec(text);
  const reply = m ? Buffer.from(m[2], 'base64').toString('utf-8') : 'ok';
  if (m) await sleep(Number(m[1]));
  out({ type: 'stream_event', event: { type: 'message_start', message: {} } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (let i = 0; i < reply.length; i += 9) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(i, i + 9) } } });
    await sleep(15);
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    void turn(((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
  }
});
process.stdin.on('end', () => process.exit(0));
`;

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1' }));
  const add = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'alpha-app', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const { DREAMCONTEXT_RECALL_MODE: _r, ...env } = process.env;
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error(`server did not come up\n${log}`);
}

/** The notch as the desktop app loads it: window `assistant` on a mocked Tauri bus. */
const notchTauri = () => {
  const handlers = new Map();
  let seq = 0;
  const drop = (event, id) => { const list = handlers.get(event); if (list) list.delete(id); };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: drop };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'assistant' }, currentWebview: { windowLabel: 'assistant', label: 'assistant' } },
    transformCallback: (cb) => { const id = ++seq; window[`_${id}`] = cb; return id; },
    invoke: async (cmd, args) => {
      if (cmd === 'plugin:event|listen') {
        const list = handlers.get(args.event) ?? new Set();
        list.add(args.handler);
        handlers.set(args.event, list);
        return args.handler;
      }
      if (cmd === 'plugin:event|unlisten') { drop(args.event, args.eventId); return null; }
      if (cmd === 'plugin:window|outer_position') return { x: 0, y: 0 };
      if (cmd === 'plugin:window|scale_factor') return 1;
      return null;
    },
  };
  window.__fireTauri = (event, payload) => {
    const ids = [...(handlers.get(event) ?? [])];
    for (const id of ids) window[`_${id}`]?.({ event, id: 0, payload });
    return ids.length;
  };
};

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

async function main() {
  if (!existsSync(join(REPO, 'dist', 'dashboard', 'index.html'))) throw new Error('run npm run build first');
  setup();
  const port = await freePort();
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const r = await fetch(`${base}/api/assistant/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nova', character: 'Terse.' }) });
    ok('the assistant is created', r.status === 200);

    const page = await browser.newPage({ viewport: { width: 580, height: 560 } });
    await page.addInitScript(notchTauri);
    if (process.env.DEBUG_NOTCH) page.on('console', (m) => { if (m.text().includes('[DBG')) console.log('    ', Date.now() % 100000, m.text().slice(0, 300)); });
    await page.route('**/api/agent/voice/tts', (route) => route.fulfill({ status: 204, body: '' }));
    await page.route('**/api/agent/voice/focus', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ granted: true, holder: null, ducked: false, gain: 1, paused: [] }) }));
    await page.goto(`${base}/?assistant=1`);
    await page.waitForSelector('.dc-notch__pill', { timeout: 20_000 });

    const panelOpen = () => page.locator('.dc-notch__panel').isVisible();
    const until = async (cond, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await cond()) return true; await page.waitForTimeout(150); }
      return cond();
    };

    /** Open the notch, send `text`, then fold it as the owner would (Esc). */
    async function sendAndFold(text) {
      if (!(await panelOpen())) await page.click('.dc-notch__pill');
      await page.waitForSelector('.dc-notch__panel:not([hidden]) textarea', { timeout: 20_000 });
      const ta = page.locator('.dc-notch__chat .agent-pane-chat textarea').first();
      await ta.fill(text);
      await ta.press('Enter');
      await page.waitForTimeout(300);
      // The pointer leaves the notch, as it does when the owner goes back to work: a notch
      // under the pointer never folds by itself (Notch.tsx hoverRef), on purpose.
      await page.mouse.move(8, 550);
      await page.evaluate(() => window.__fireTauri('assistant://hover', { inside: false }));
      await page.keyboard.press('Escape');
      if (await panelOpen()) await page.evaluate(() => window.__fireTauri('assistant://escape', {}));
      return until(async () => !(await panelOpen()), 3000);
    }

    console.log('\n── present: the folded notch opens for the answer, then folds once read');
    ok('folded after sending', await sendAndFold(`LATER:2500:${b64('<!-- notch:present -->\nKısa bir cevap. İkinci cümle burada.')}`));
    const opened = await until(panelOpen, 8000);
    ok('a present reply OPENS the folded notch by itself', opened);
    // In this harness the window IS the viewport, so the panel grows under the parked pointer
    // and Chromium reports a pointerenter. In the app the window is panel-sized and the native
    // tracker says where the pointer really is: away.
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__fireTauri('assistant://hover', { inside: false }));
    const t0 = Date.now();
    const folded = await until(async () => !(await panelOpen()), 25_000);
    ok('…and folds again once it has been read (no stay)', folded, `still open after ${Date.now() - t0} ms`);

    console.log('\n── present stay: it opens and stays');
    ok('folded after sending', await sendAndFold(`LATER:2500:${b64('<!-- notch:present stay -->\nOnay gerekiyor: iki seçenek var, hangisi?')}`));
    ok('a present-stay reply opens the notch', await until(panelOpen, 8000));
    await page.waitForTimeout(22_000);
    ok('…and is STILL open 22 s later', await panelOpen());
    await page.keyboard.press('Escape');
    if (await panelOpen()) await page.evaluate(() => window.__fireTauri('assistant://escape', {}));
    await until(async () => !(await panelOpen()), 3000);

    console.log('\n── buttons under a plain present cue: the owner\'s rule keeps it open anyway');
    const withButtons = '<!-- notch:present -->\nTask hazır.\n\n```dream-actions\n[{"label":"Görevi aç","action":"task","id":"x","vault":"alpha-app"}]\n```';
    ok('folded after sending', await sendAndFold(`LATER:2500:${b64(withButtons)}`));
    ok('a reply with something to click opens the notch', await until(panelOpen, 8000));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__fireTauri('assistant://hover', { inside: false }));
    await page.waitForTimeout(22_000);
    ok('…and STAYS open although the cue said only present', await panelOpen());
    await page.keyboard.press('Escape');
    if (await panelOpen()) await page.evaluate(() => window.__fireTauri('assistant://escape', {}));
    await until(async () => !(await panelOpen()), 3000);

    console.log('\n── progress: it never opens; the line peeks');
    ok('folded after sending', await sendAndFold(`LATER:2500:${b64('<!-- notch:progress -->\nTilki projesine bakıyorum…')}`));
    await page.waitForTimeout(5000);
    ok('a progress line does NOT open the notch', !(await panelOpen()));
    const peekText = await page.locator('.dc-notch').innerText().catch(() => '');
    ok('…the line is visible in the peek', peekText.includes('Tilki projesine'), peekText.slice(0, 200));

    console.log('\n── the notch reports what it did (voice.jsonl), so "it never opens" can be checked');
    let lines = [];
    try {
      lines = readFileSync(join(HOME, '.dreamcontext', 'logs', 'voice.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    } catch { /* no log */ }
    const notch = lines.filter((l) => l.kind === 'notch');
    ok('each presentation that opened the notch is one "opened" line', notch.filter((l) => l.action === 'opened').length === 3, JSON.stringify(notch));
    ok('…with its cue, stay and seat', notch.some((l) => l.stay === true && l.seat === 'notch') && notch.some((l) => l.stay === false));
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
