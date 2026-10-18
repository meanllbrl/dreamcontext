#!/usr/bin/env node
// The notch peek, per session and per presence, sampled every 200 ms in real Chromium.
//   npm run build && node scripts/verify/notch-peek-focus.mjs [path to dist/index.js]
// The real dashboard server on a scratch HOME; glance/inbox/rollup are mocked per scenario and
// the Tauri bus is faked so the desktop seat path runs. Never the owner's server.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CLI = resolve(process.argv[2] ?? 'dist/index.js');
const SCRATCH = join(tmpdir(), `dc-notch-focus-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'projects', 'acme-app');
const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
writeFileSync(join(PROJ, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1' }));
spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: { ...process.env, HOME } });
const port = await freePort();
const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...process.env, HOME, PATH }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 300)); }

const S = { lookingAt: null, lookingAtSession: null, chats: [], events: [] };
const ask = (vault, sid, id) => ({ sessionId: sid, vault, activity: 'asking', since: new Date().toISOString(), title: 'T', ask: { id, kind: 'question', tool: 'AskUserQuestion', text: `${vault} asks ${id}?` } });
const fin = (vault, sid) => ({ id: `fin:${sid}`, kind: 'finished', at: Date.now(), sessionId: sid, vault, mode: 'chat', title: 'Turn', lastText: `${vault} ${sid} done` });

const notchTauri = () => {
  const handlers = new Map(); let seq = 0;
  const drop = (event, id) => { const l = handlers.get(event); if (l) l.delete(id); };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: drop };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'assistant' }, currentWebview: { windowLabel: 'assistant', label: 'assistant' } },
    transformCallback: (cb) => { const id = ++seq; window[`_${id}`] = cb; return id; },
    invoke: async (cmd, args) => {
      if (cmd === 'plugin:event|listen') { const l = handlers.get(args.event) ?? new Set(); l.add(args.handler); handlers.set(args.event, l); return args.handler; }
      if (cmd === 'plugin:event|unlisten') { drop(args.event, args.eventId); return null; }
      if (cmd.startsWith('mic_take_')) throw new Error(`Command ${cmd} not found`);
      if (cmd === 'plugin:window|outer_position') return { x: 0, y: 0 };
      if (cmd === 'plugin:window|scale_factor') return 1;
      if (cmd === 'plugin:window|is_visible') return true;
      if (cmd === 'plugin:window|inner_size' || cmd === 'plugin:window|outer_size') return { width: 460, height: 152 };
      if (cmd === 'plugin:window|cursor_position') return { x: 5000, y: 5000 };
      return null;
    },
  };
};

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 460, height: 152 } });
await page.addInitScript(notchTauri);
await page.route('**/api/assistant/glance', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ chats: S.chats, delegations: [] }) }));
await page.route('**/api/assistant/inbox', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lookingAt: S.lookingAt, lookingAtSession: S.lookingAtSession, events: S.events, posts: [], running: [], muted: [] }) }));
await page.route('**/api/assistant/rollup', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ starting: 0, working: 0, stale: 0, asking: S.chats.filter((c) => c.ask).length, idle: 0, proposals: 0 }) }));
await page.goto(`${base}/?assistant=1`);
await page.waitForSelector('.dc-notch', { timeout: 20000 });
await page.waitForTimeout(5000);

/** Sample the peek for `ms`: when it first showed, when it folded, what it said. */
async function watch(ms) {
  const t0 = Date.now();
  let shownAt = null, hiddenAt = null, text = null;
  while (Date.now() - t0 < ms) {
    const r = await page.evaluate(() => ({ on: !!document.querySelector('.dc-notch')?.classList.contains('dc-notch--peek'), text: document.querySelector('.dc-peek')?.textContent ?? null }));
    const t = Date.now() - t0;
    if (r.on && shownAt === null) { shownAt = t; text = r.text; }
    if (!r.on && shownAt !== null && hiddenAt === null) hiddenAt = t;
    await page.waitForTimeout(200);
  }
  return { shownAt, hiddenAt, onFor: shownAt === null ? 0 : (hiddenAt ?? ms) - shownAt, text: text?.replace('×', '').slice(0, 48) ?? null };
}
async function settle() {
  S.chats = []; S.events = [];
  for (let i = 0; i < 60; i++) {
    const on = await page.evaluate(() => !!document.querySelector('.dc-notch')?.classList.contains('dc-notch--peek'));
    if (!on) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(4500);
}

const results = [];
const check = (name, ok, r) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${JSON.stringify(r)}`); };

// A. In another app: a prompt peeks for its full time (still down 11 s on).
S.lookingAt = null; S.lookingAtSession = null;
S.chats = [ask('Tilki', 's-tilki', 'q1')];
let r = await watch(16000);
check('A  other app, Tilki asks -> peeks, full time (>11 s)', r.shownAt !== null && r.onFor > 11000, r);
await settle();

// B. In the app, another project's chat asks: a 5 s glance.
S.lookingAt = 'dreamcontext'; S.lookingAtSession = 's-dc';
await page.waitForTimeout(4500);
S.chats = [ask('Tilki', 's-tilki', 'q2')];
r = await watch(16000);
check('B  in app (dc/s-dc), Tilki asks -> peeks, ~5 s glance', r.shownAt !== null && r.onFor >= 4000 && r.onFor <= 7500, r);
await settle();

// C. The chat he is focused on asks: no peek.
S.chats = [ask('dreamcontext', 's-dc', 'q3')];
r = await watch(9000);
check('C  in app, the FOCUSED chat asks -> no peek', r.shownAt === null, r);
await settle();

// D. Another chat in the SAME project asks: a 5 s glance.
S.chats = [ask('dreamcontext', 's-dc2', 'q4')];
r = await watch(16000);
check('D  in app, another chat of the same project asks -> ~5 s glance', r.shownAt !== null && r.onFor >= 4000 && r.onFor <= 7500, r);
await settle();

// E. In another app: the same chat finishes twice. Both turns are news.
S.lookingAt = null; S.lookingAtSession = null;
await page.waitForTimeout(4500);
S.events = [fin('Tilki', 's-tilki')];
r = await watch(9000);
check('E1 other app, Tilki finishes (turn 1) -> peeks', r.shownAt !== null, r);
S.events = [];          // the chat works again: its finish leaves the inbox
await settle();         // turn 1's peek is down before turn 2 (or turn 1 would be read as turn 2)
S.events = [fin('Tilki', 's-tilki')];
r = await watch(9000);
check('E2 other app, the SAME chat finishes again (turn 2) -> peeks again', r.shownAt !== null, r);
await settle();

// F. In the app: the focused chat's finish never peeks; another chat's is a glance.
S.lookingAt = 'Tilki'; S.lookingAtSession = 's-tilki';
await page.waitForTimeout(4500);
S.events = [fin('Tilki', 's-tilki')];
r = await watch(9000);
check('F1 in app (Tilki/s-tilki), the FOCUSED chat finishes -> no peek', r.shownAt === null, r);
S.events = [fin('Tilki', 's-tilki2')];
r = await watch(16000);
check('F2 in app, another Tilki chat finishes -> ~5 s glance', r.shownAt !== null && r.onFor >= 4000 && r.onFor <= 7500, r);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed  (${CLI})`);
await browser.close();
srv.kill();
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
