#!/usr/bin/env node
/**
 * The hands-free phone sends a voice message the Mac's whisper turns into text
 * (task the-hands-free-phone-sends-a-voice-message-that-the-mac-s-whisper-turns-into-text, AC6).
 *
 *   npm run build && node scripts/verify/handsfree-phone-voice.mjs
 *
 * WHAT IT DRIVES — the real dashboard server (scratch HOME, desktop flag, the power runner only
 * logging, the loopback stand-in for cloudflared, so the phone goes through the PHONE LISTENER and
 * its route policy). Whisper is a stand-in `whisper-server` (DREAMCONTEXT_WHISPER_BIN/_MODEL): it
 * answers `/inference` with a fixed sentence and logs the bytes of the WAV it received, so the
 * check proves the take arrived, not what a model made of it. The phone is Chromium as an iPhone
 * 13 at 390x844 whose microphone is a FAKE device playing a sentence macOS `say` spoke, so the
 * composer's own capture path (getUserMedia → the graph → wavEncoder) records real speech.
 *
 *   1. dictation installed: the phone's new chat composer draws the hold-to-talk mic, and no
 *      read-aloud switch; holding it records, letting go sends the take to POST
 *      /api/agent/voice/stt through the phone listener (200), whisper receives a WAV, the text is
 *      written into the composer and sent (the owner's bubble, then the chat's answer);
 *   2. dictation gone (the model removed): after a reload the mic is not drawn.
 *   Across the run: no console error and no 403 on any request the phone made.
 *
 * HONEST LIMIT — Chromium's fake microphone, not an iPhone's: WebKit's own getUserMedia
 * permission sheet and Safari's audio session are the owner's iPhone check.
 *
 * Screenshots: tmp/verify-handsfree-phone-voice/*.png. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-phone-voice');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-phone-voice');
const CLI = join(REPO, 'dist', 'index.js');
const TAKE = join(SCRATCH, 'take.wav');
const WHISPER_LOG = join(SCRATCH, 'whisper.log');
const MODEL = join(SCRATCH, 'ggml-base.bin');
const SAID = 'Telefondan sesli mesaj. Bu bir deneme.';

/** `claude -p` stand-in: answers every user turn with ECHO <text>. */
const CLAUDE = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const row = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, cwd: process.cwd(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text)[0] || '';
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ECHO ' + text }] };
    row({ type: 'assistant', message }); out({ type: 'assistant', message });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ECHO', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

/** `whisper-server` stand-in: `--port N`; GET / is ready; POST /inference logs the WAV it got. */
const WHISPER = `#!${process.execPath}
const http = require('node:http'); const fs = require('node:fs');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]);
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/inference') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const riff = body.indexOf('RIFF');
      fs.appendFileSync(${JSON.stringify(WHISPER_LOG)}, JSON.stringify({ bytes: body.length, wav: riff >= 0 && body.toString('ascii', riff + 8, riff + 12) === 'WAVE' }) + '\\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: ' ${SAID} ', language: 'turkish' }));
    });
    return;
  }
  res.writeHead(200); res.end('ok');
}).listen(port, '127.0.0.1');
`;

const report = {
  pass: 0, fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const portFree = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(true));
});

let server = null;
let browser = null;
try {
  const { chromium, devices } = await import('@playwright/test');
  if (!(await portFree(47_113))) throw new Error('port 47113 (whisper-server) is in use on this machine: stop the real one for this check');
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, SHOTS]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  mkdirSync(join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  for (const [name, body] of [['claude', CLAUDE], ['whisper-server', WHISPER]]) {
    const p = join(HOME, '.local', 'bin', name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  writeFileSync(MODEL, Buffer.alloc(2_000_000));
  const said = spawnSync('say', ['-o', TAKE, '--data-format=LEI16@16000', SAID]);
  if (said.status !== 0 || !existsSync(TAKE)) throw new Error('macOS `say` could not write the take');
  cli(['init', '-y', '--name', 'proj', '--description', 'A scratch project for the phone voice check']);
  cli(['vaults', 'add', 'proj', PROJ]);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
  server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: {
      ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1',
      DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(SCRATCH, 'power.log'), DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1',
      DREAMCONTEXT_WHISPER_BIN: join(HOME, '.local', 'bin', 'whisper-server'), DREAMCONTEXT_WHISPER_MODEL: MODEL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!(await until(async () => (await fetch(`${base}/`)).ok, 30000, 300))) throw new Error('server did not come up');
  const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  report.check('Mac mode is set up', (await post('/api/handsfree/mac/setup')).status === 200);
  report.check('Mac mode starts for the project (loopback stand-in tunnel)', (await post('/api/handsfree/mac/start', { vaults: ['proj'] })).status === 200);
  const qr = (await post('/api/handsfree/mac/qr')).json.url;
  report.check('a one-time sign-in link on the phone listener', typeof qr === 'string' && !qr.includes(`:${port}/`), qr);
  const phoneOrigin = new URL(qr).origin;

  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${TAKE}`],
  });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  await ctx.grantPermissions(['microphone'], { origin: phoneOrigin });
  await markAnnouncementsSeen(ctx, base);
  const phone = await ctx.newPage();
  const errors = []; const forbidden = []; const stt = [];
  phone.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  phone.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  phone.on('response', async (r) => {
    const path = r.url().replace(/^https?:\/\/[^/]+/, '');
    if (r.status() === 403) forbidden.push(`${r.request().method()} ${path}`);
    if (path.startsWith('/api/agent/voice/stt')) stt.push({ status: r.status(), origin: new URL(r.url()).origin, body: await r.json().catch(() => null) });
  });
  const vis = (sel) => phone.locator(`${sel}:visible`);

  console.log('\n── 1. dictation installed: the mic, a take, the text');
  await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  report.check('signed in through the phone listener', await until(async () => phone.url().includes('vault=proj'), 25000), phone.url());
  report.check('the phone opens on the Sohbetler list', await until(async () => (await vis('[data-testid="phone-list"]').count()) === 1, 20000));
  const caps = await phone.evaluate(async () => (await fetch('/api/agent/capabilities', { credentials: 'same-origin' })).json());
  report.check('capabilities says dictation is installed (a boolean, no path)', caps.dictation === true && !JSON.stringify(caps).includes('whisper'), JSON.stringify({ dictation: caps.dictation }));
  await vis('[data-testid="list-new"]').click();
  report.check('a new chat opens with its composer', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 15000));
  const mic = vis('.chat-cmp-mic').first();
  report.check('the composer draws the hold-to-talk mic', await until(async () => (await mic.count()) === 1, 10000));
  report.check('…and no read-aloud switch (speech stays the laptop\'s)', (await vis('.chat-cmp-readaloud').count()) === 0);
  // At rest the hint is dropped on a narrow pane by the existing CSS (`data-rest`); its words are read.
  const note = (await phone.evaluate(() => [...document.querySelectorAll('.chat-cmp-voice-note')].map((e) => e.textContent).join('|'))).trim();
  report.check(`the resting hint speaks of the mic, not a hotkey ("${note}")`, note === 'Hold the mic to speak');
  const box = await mic.boundingBox();
  report.check(`the mic is a touch target (${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)})`, !!box && box.width >= 32 && box.height >= 32);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  report.check('no horizontal overflow at 390', !overflow);
  await phone.screenshot({ path: join(SHOTS, '390x844-mic.png') });

  // Diagnostics: the pointer events the mic sees, so a take that ends early says why.
  await phone.evaluate(() => {
    const m = [...document.querySelectorAll('.chat-cmp-mic')].find((e) => e.getBoundingClientRect().height > 0);
    window.__micEvents = [];
    window.__docEvents = [];
    for (const t of ['pointerdown', 'touchstart']) document.addEventListener(t, (e) => { const el = e.target; window.__docEvents.push(`${t}:${e.pointerType ?? ''}:${el?.tagName}.${String(el?.className).slice(0, 40)}@${Math.round(e.clientX ?? e.touches?.[0]?.clientX ?? -1)},${Math.round(e.clientY ?? e.touches?.[0]?.clientY ?? -1)}`); }, true);
    for (const t of ['pointerdown', 'pointerup', 'pointerleave', 'pointercancel']) m?.addEventListener(t, (e) => window.__micEvents.push(`${t}:${e.pointerType}@${Math.round(performance.now())}`));
  });
  // Hold, speak (the fake device plays the sentence), let go — with a FINGER (CDP touch events):
  // a touch pointer is implicitly captured by the button it went down on, exactly as on the
  // iPhone, so the row reflowing while recording does not end the take under it.
  const cdp = await ctx.newCDPSession(phone);
  // Measured again right before the touch: the row settles (the model chip loads) after the first look.
  // The emulator keeps a MOUSE pointer where the last click left it; an iPhone has none. Parked in
  // a corner, so the row reflowing under it raises no hover `pointerleave` on the mic.
  await phone.mouse.move(1, 1);
  await phone.waitForTimeout(800);
  const now = await mic.boundingBox();
  const at = [{ x: now.x + now.width / 2, y: now.y + now.height / 2, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at });
  report.check('holding it records', await until(async () => (await vis('.chat-cmp-mic.is-recording').count()) === 1, 5000),
    JSON.stringify(await phone.evaluate(() => ({ events: window.__micEvents, doc: window.__docEvents, note: document.querySelector('.chat-cmp-voice-note')?.textContent, mic: (() => { const m = [...document.querySelectorAll('.chat-cmp-mic')].find((e) => e.getBoundingClientRect().height > 0); const r = m?.getBoundingClientRect(); return r ? [Math.round(r.x), Math.round(r.y)] : null; })() }))) + ` touch@${Math.round(at[0].x)},${Math.round(at[0].y)}`);
  await phone.waitForTimeout(1200);
  await phone.screenshot({ path: join(SHOTS, '390x844-recording.png') });
  await phone.waitForTimeout(2000);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  report.check('letting go sends the take to the Mac (POST /api/agent/voice/stt on the phone listener, 200)', await until(async () => stt.some((r) => r.status === 200), 20000), JSON.stringify(stt));
  const first = stt.find((r) => r.status === 200);
  report.check('…over the phone listener\'s origin, answered with the transcript', !!first && first.origin === phoneOrigin && first.body?.text === SAID, JSON.stringify(first));
  const heard = existsSync(WHISPER_LOG) ? readFileSync(WHISPER_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  report.check(`whisper received the take as a WAV (${heard[0]?.bytes ?? 0} bytes)`, heard.length >= 1 && heard[0].wav && heard[0].bytes > 20_000, JSON.stringify(heard));
  const pane = async () => (await vis('.chat-pane').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  report.check('the text was written into the composer and sent: the owner\'s bubble, then the answer', await until(async () => {
    const t = await pane();
    return t.includes(SAID) && t.includes(`ECHO ${SAID}`) && t.indexOf(SAID) < t.indexOf(`ECHO ${SAID}`);
  }, 20000), (await pane()).slice(-200));
  await phone.waitForTimeout(500);
  await phone.screenshot({ path: join(SHOTS, '390x844-sent.png') });

  console.log('\n── 2. dictation gone: no mic');
  rmSync(MODEL, { force: true });
  await phone.reload({ waitUntil: 'domcontentloaded' });
  await until(async () => (await vis('[data-testid="phone-list"]').count()) === 1 || (await vis('.chat-cmp-input').count()) > 0, 20000);
  const caps2 = await phone.evaluate(async () => (await fetch('/api/agent/capabilities', { credentials: 'same-origin' })).json());
  report.check('capabilities now says dictation is not installed', caps2.dictation === false, JSON.stringify({ dictation: caps2.dictation }));
  if ((await vis('[data-testid="phone-list"]').count()) === 1) await vis('[data-testid="list-new"]').click();
  await until(async () => (await vis('.chat-cmp-input').count()) > 0, 15000);
  await phone.waitForTimeout(1500);
  report.check('the composer draws no mic', (await vis('.chat-cmp-mic').count()) === 0);
  await phone.screenshot({ path: join(SHOTS, '390x844-no-whisper.png') });

  report.check('no console error on the phone', errors.length === 0, errors.slice(0, 5).join(' | '));
  report.check('no 403 on any request the phone made', forbidden.length === 0, forbidden.slice(0, 8).join(' | '));
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err).slice(0, 600));
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
  // The whisper stand-in is the server's child; make sure no stray one keeps the port.
  spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'whisper-server')]);
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed${report.fails.length ? `:\n  - ${report.fails.join('\n  - ')}` : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(report.fails.length ? 1 : 0);
