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
 *   1b. the garble guard (task sesli-giris-bozuk…): the stand-in whisper switches mode per take —
 *      `clean` (one pass, sent: c), `icelandic` (`auto` hears Icelandic at -0.7, a Turkish pin
 *      hears Turkish: the retry is sent, a), `bad` (weak in every language: nothing is sent, the
 *      "Anlayamadım" notice shows and the cue starts, b); the chat's stand-in agent runs
 *      `dreamcontext voice retry <ref>` on the `<voice-take>` block it received and gets the
 *      forced text, while a take bound to another chat answers 403 (d);
 *   1c. the same notice in the REAL Super composer at 1440 and 390, mounted alone in the
 *      composer-voice harness (scripts/verify/harness/composer-voice, `?stt=garbled`);
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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
/** What a Turkish pin hears in `icelandic` mode: its own sentence, so the retried take's
 *  bubble and answer are told apart from the first one's. */
const SAID_A = 'İkinci mesaj, yeniden denendi.';
/** The stand-in whisper's mode for the NEXT take: clean | icelandic | bad. */
const MODE_FILE = join(SCRATCH, 'whisper-mode');
/** Where the chat stand-in leaves its window token and what `voice retry` answered. */
const AGENT_DIR = join(SCRATCH, 'agent');

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
    const blocks = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text);
    const text = blocks[0] || '';
    // The briefing's rule, acted out: a dictated message names its take; retry it once.
    const take = blocks.map((b) => /^<voice-take ref="(vt_[0-9a-f]{32})"/.exec(b)).find(Boolean);
    let retry = '';
    if (take) {
      fs.mkdirSync(${JSON.stringify(AGENT_DIR)}, { recursive: true });
      fs.writeFileSync(path.join(${JSON.stringify(AGENT_DIR)}, 'token.json'), JSON.stringify({ url: process.env.DREAMCONTEXT_WINDOW_URL, token: process.env.DREAMCONTEXT_WINDOW_TOKEN, ref: take[1] }));
      const r = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'voice', 'retry', take[1], '--language', 'tr'], { encoding: 'utf-8' });
      fs.appendFileSync(path.join(${JSON.stringify(AGENT_DIR)}, 'retries.jsonl'), JSON.stringify({ ref: take[1], status: r.status, out: r.stdout, err: r.stderr }) + '\\n');
      try { retry = ' | RETRY ' + JSON.parse(r.stdout).text; } catch { retry = ' | RETRY failed'; }
    }
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ECHO ' + text + retry }] };
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
      const language = (/name="language"\\r\\n\\r\\n([^\\r]*)/.exec(body.toString('latin1')) || [])[1] || '';
      let mode = 'clean';
      try { mode = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf-8').trim() || 'clean'; } catch {}
      fs.appendFileSync(${JSON.stringify(WHISPER_LOG)}, JSON.stringify({ bytes: body.length, wav: riff >= 0 && body.toString('ascii', riff + 8, riff + 12) === 'WAVE', mode, language }) + '\\n');
      const seg = (lp) => [{ start: 0, end: 3, avg_logprob: lp, no_speech_prob: 0.02 }];
      const turkish = { text: ' ${SAID} ', language: 'turkish', segments: seg(-0.08) };
      const icelandic = { text: ' Nei þurfum það í skanki ', language: 'icelandic', segments: seg(-0.7) };
      const answer = mode === 'clean' ? turkish
        : mode === 'icelandic' ? (language === 'auto' ? icelandic : language === 'tr' ? { ...turkish, text: ' ${SAID_A} ' } : { text: ' ne olja ne mitja ', language: 'turkish', segments: seg(-0.8) })
          : (language === 'auto' ? { ...icelandic, segments: seg(-0.8) } : { text: ' ne olja ne mitja ', language: 'turkish', segments: seg(-0.8) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer));
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
let harness = null;
try {
  const { chromium, devices } = await import('@playwright/test');
  // The stand-in gets a port of its own: the owner's real whisper may be serving :47113.
  const whisperPort = await freePort();
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
  writeFileSync(MODE_FILE, 'clean');
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
      DREAMCONTEXT_WHISPER_PORT: String(whisperPort),
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
  // A Turkish phone: its UI language is one of the language-context signals.
  const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, locale: 'tr-TR' });
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
  // At rest the phone draws no caption at all: the mic is the instruction (owner, 2026-10-21).
  const note = (await phone.evaluate(() => [...document.querySelectorAll('.chat-cmp-voice-note')].map((e) => e.textContent).join('|'))).trim();
  report.check(`no resting caption beside the phone's mic ("${note}")`, note === '');
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

  console.log('\n── 1b. the garble guard: (c) clean, (a) Icelandic then a retry, (b) both bad, (d) the agent retries');
  report.check('(c) a clean take is one pass, quality clean', first?.body?.passes === 1 && first?.body?.quality === 'clean', JSON.stringify(first?.body));
  /** One more hold-and-release on the mic; resolves with the new `/stt` answer. */
  const takeOnce = async () => {
    const before = stt.length;
    await phone.mouse.move(1, 1);
    await until(async () => (await vis('.chat-cmp-mic:not([disabled])').count()) === 1, 10000);
    const b = await mic.boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }] });
    await until(async () => (await vis('.chat-cmp-mic.is-recording').count()) === 1, 5000);
    await phone.waitForTimeout(2500);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(async () => stt.length > before, 20000);
    return stt[stt.length - 1];
  };
  const echoes = async () => ((await pane()).match(/ECHO /g) ?? []).length;

  writeFileSync(MODE_FILE, 'icelandic');
  const echoA = await echoes();
  const a = await takeOnce();
  const langs = readFileSync(WHISPER_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).slice(-2).map((l) => l.language);
  report.check('(a) `auto` heard Icelandic, the retry pinned to the context language (tr) won: 2 passes, the Turkish text', a?.status === 200 && a.body?.passes === 2 && a.body?.text === SAID_A && a.body?.language === 'tr' && langs.join(',') === 'auto,tr', JSON.stringify({ body: a?.body, langs }));
  report.check('(a) …and it was sent, and answered', await until(async () => (await pane()).includes(`ECHO ${SAID_A}`) && (await echoes()) > echoA, 20000), (await pane()).slice(-200));
  await phone.screenshot({ path: join(SHOTS, '390x844-retried.png') });

  console.log('   (d) the chat\'s agent retries the take it received');
  const retries = () => (existsSync(join(AGENT_DIR, 'retries.jsonl')) ? readFileSync(join(AGENT_DIR, 'retries.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  await until(async () => retries().length >= 2, 15000);
  const last = retries().at(-1);
  let lastOut = null; try { lastOut = JSON.parse(last?.out ?? ''); } catch { /* shown below */ }
  report.check('(d) `dreamcontext voice retry <ref> --language tr` from the chat\'s own agent: exit 0, the forced Turkish text', last?.status === 0 && lastOut?.text === SAID_A && lastOut?.language === 'tr' && lastOut?.ref === last?.ref, JSON.stringify(last));
  report.check('(d) …and the agent\'s answer carries it', (await pane()).includes(`RETRY ${SAID_A}`), (await pane()).slice(-200));
  const agent = JSON.parse(readFileSync(join(AGENT_DIR, 'token.json'), 'utf-8'));
  // A take bound to ANOTHER chat (its record copied with a foreign session): this chat's token is refused.
  const takesDir = join(HOME, '.dreamcontext', 'logs', 'voice-takes');
  const foreign = `vt_${'f'.repeat(32)}`;
  const rec = JSON.parse(readFileSync(join(takesDir, `${agent.ref}.json`), 'utf-8'));
  writeFileSync(join(takesDir, `${foreign}.json`), JSON.stringify({ ...rec, session: 'another-chat' }), { mode: 0o600 });
  writeFileSync(join(takesDir, `${foreign}.wav`), readFileSync(join(takesDir, `${agent.ref}.wav`)), { mode: 0o600 });
  const retx = (body, token) => fetch(`${agent.url}/api/agent/voice/retranscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-dreamcontext-window-token': token } : {}) }, body: JSON.stringify(body) }).then((r) => r.status);
  report.check('(d) another chat\'s take with this chat\'s token: 403', (await retx({ ref: foreign }, agent.token)) === 403);
  report.check('(d) no token: 401', (await retx({ ref: agent.ref })) === 401);
  report.check('(d) the route is refused on the phone listener (route policy)', (await phone.evaluate(async (ref) => (await fetch('/api/agent/voice/retranscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }) })).status, agent.ref)) === 403);

  writeFileSync(MODE_FILE, 'bad');
  const echoB = await echoes();
  const b = await takeOnce();
  report.check('(b) both passes weak: `garbled`, no text, 2 passes', b?.status === 200 && b.body?.garbled === true && b.body?.text === undefined && b.body?.passes === 2, JSON.stringify({ ...b?.body, cue: b?.body?.cue ? `${b.body.cue.b64.length} b64 chars` : null }));
  report.check('(b) …the cue rode along (rendered by the Mac\'s say)', typeof b?.body?.cue?.b64 === 'string' && b.body.cue.b64.length > 1000);
  const notice = async () => (await phone.evaluate(() => [...document.querySelectorAll('.chat-cmp-voice-note')].map((e) => e.textContent).join('|'))).trim();
  report.check('(b) the notice is shown', await until(async () => /Anlayamadım|Missed that/.test(await notice()), 5000), await notice());
  report.check('(b) the cue player started', await until(async () => (await phone.evaluate(() => window.__dcCue?.starts ?? 0)) >= 1, 5000), JSON.stringify(await phone.evaluate(() => window.__dcCue ?? null)));
  await phone.waitForTimeout(1500);
  report.check('(b) nothing was sent: no new message, an empty composer', (await echoes()) === echoB && (await vis('.chat-cmp-input').first().inputValue().catch(() => '')) === '', `${await echoes()} vs ${echoB}`);
  const heardLine = await phone.evaluate(() => document.querySelector('.chat-cmp-voice-heard')?.textContent ?? '');
  report.check('(b) what was heard is shown dimmed beside it, as text', heardLine.length > 0, heardLine);
  report.check('(b) no horizontal overflow at 390 with the notice', !(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await phone.screenshot({ path: join(SHOTS, '390x844-garbled.png') });

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

  // The one 403 this run asks for on purpose (1b (d): the route policy refusing retranscribe).
  const unexpected403 = forbidden.filter((f) => f !== 'POST /api/agent/voice/retranscribe');
  // The browser logs the deliberate 403 as a failed resource; nothing else may.
  const deliberate = forbidden.length - unexpected403.length;
  const errs = errors.filter((e, i, all) => !(e.includes('status of 403') && all.slice(0, i + 1).filter((x) => x.includes('status of 403')).length <= deliberate));
  report.check('no console error on the phone (but the deliberate 403)', errs.length === 0, errs.slice(0, 5).join(' | '));
  report.check('no 403 on any request the phone made but the one asked for', unexpected403.length === 0, unexpected403.slice(0, 8).join(' | '));

  console.log('\n── 1c. the Super composer\'s notice at 1440 and 390 (the real Composer in its harness)');
  const DASH = join(REPO, 'dashboard');
  const HARNESS = join(REPO, 'scripts', 'verify', 'harness', 'composer-voice');
  const fromDash = (p) => import(pathToFileURL(join(DASH, 'node_modules', p)).href);
  const { createServer } = await fromDash('vite/dist/node/index.js');
  const react = (await fromDash('@vitejs/plugin-react/dist/index.js')).default;
  harness = await createServer({
    configFile: false, root: HARNESS, logLevel: 'error', plugins: [react()],
    define: { __DC_VERSION__: JSON.stringify('0.0.0-harness') },
    resolve: {
      alias: [
        { find: /^react$/, replacement: join(DASH, 'node_modules', 'react') },
        { find: /^react\/(.*)$/, replacement: join(DASH, 'node_modules', 'react', '$1') },
        { find: /^react-dom$/, replacement: join(DASH, 'node_modules', 'react-dom') },
        { find: /^react-dom\/(.*)$/, replacement: join(DASH, 'node_modules', 'react-dom', '$1') },
        { find: /^@tanstack\/react-query$/, replacement: join(DASH, 'node_modules', '@tanstack', 'react-query') },
      ],
      dedupe: ['react', 'react-dom'],
    },
    server: { port: 0, host: '127.0.0.1', fs: { allow: [REPO] } },
    optimizeDeps: { entries: [join(HARNESS, 'index.html')] },
  });
  await harness.listen();
  const hbase = harness.resolvedUrls.local[0];
  for (const width of [1440, 390]) {
    const dctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, permissions: ['microphone'] });
    const page = await dctx.newPage();
    const derr = [];
    page.on('console', (m) => { if (m.type() === 'error') derr.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => derr.push(String(e).slice(0, 200)));
    await page.goto(`${hbase}?mode=super&theme=dark&lang=tr&stt=garbled`);
    await page.waitForSelector('.chat-cmp-mic', { timeout: 30_000 });
    await page.waitForTimeout(400);
    const press = (type) => page.locator('.chat-cmp-mic').dispatchEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 });
    await press('pointerdown');
    await page.waitForSelector('.chat-cmp-mic.is-recording', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await press('pointerup');
    const shown = await until(async () => (await page.locator('.chat-cmp-voice-note').allTextContents()).join('|').includes('Anlayamadım'), 8000);
    const cue = await until(async () => (await page.evaluate(() => window.__dcCue?.starts ?? 0)) >= 1, 5000);
    const sent = await page.evaluate(() => (window.__armed ?? []).length + (window.__sent ?? []).length);
    const cut = await page.evaluate(() => { const el = document.querySelector('.chat-cmp-voice-note'); return el ? el.scrollWidth > el.clientWidth + 1 : null; });
    const box = await page.locator('.chat-cmp').boundingBox();
    const file = join(SHOTS, `super-${width}-garbled.png`);
    await page.screenshot({ path: file, clip: box ? { x: 0, y: Math.max(0, box.y - 8), width, height: box.height + 16 } : undefined });
    report.check(`(${width}) the Super composer shows "Anlayamadım, tekrar eder misin?" in full`, shown && cut === false, JSON.stringify({ notes: await page.locator('.chat-cmp-voice-note').allTextContents(), cut }));
    report.check(`(${width}) the cue player started; nothing was sent`, cue && sent === 0, JSON.stringify({ cue: await page.evaluate(() => window.__dcCue ?? null), sent }));
    report.check(`(${width}) no console error`, derr.length === 0, derr.slice(0, 3).join(' | '));
    await dctx.close();
  }

  // A desktop take started from the shell's hotkey has no gesture: in WKWebView the cue's context
  // may never start, and resume() stays pending (Web Audio spec). Simulated: every AudioContext
  // stays suspended and resume() never settles. The notice must show alone, logged.
  {
    const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
    await sctx.addInitScript(() => {
      const Real = window.AudioContext;
      window.AudioContext = class extends Real {
        get state() { return 'suspended'; }
        resume() { return new Promise(() => {}); }
      };
    });
    const page = await sctx.newPage();
    const logs = []; const serr = [];
    page.on('console', (m) => { logs.push(m.text()); if (m.type() === 'error') serr.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => serr.push(String(e).slice(0, 200)));
    await page.goto(`${hbase}?mode=super&theme=dark&lang=tr&stt=garbled`);
    await page.waitForSelector('.chat-cmp-mic', { timeout: 30_000 });
    await page.waitForTimeout(400);
    const press = (type) => page.locator('.chat-cmp-mic').dispatchEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 });
    await press('pointerdown');
    await page.waitForTimeout(1500);
    await press('pointerup');
    const shown = await until(async () => (await page.locator('.chat-cmp-voice-note').allTextContents()).join('|').includes('Anlayamadım'), 8000);
    const settled = await until(async () => (await page.evaluate(() => window.__dcCue?.last)) === 'suspended', 3000);
    const stats = await page.evaluate(() => window.__dcCue ?? null);
    report.check('(1440, context never starts) the notice shows alone: cue reported suspended, never started, logged', shown && settled && stats?.starts === 0 && logs.some((l) => l.includes('cue: suspended')), JSON.stringify({ shown, stats, logged: logs.filter((l) => l.includes('cue')) }));
    report.check('(1440, context never starts) no console error', serr.length === 0, serr.slice(0, 3).join(' | '));
    const box = await page.locator('.chat-cmp').boundingBox();
    await page.screenshot({ path: join(SHOTS, 'super-1440-garbled-suspended.png'), clip: box ? { x: 0, y: Math.max(0, box.y - 8), width: 1440, height: box.height + 16 } : undefined });
    await sctx.close();
  }

  console.log('\n── 1d. Settings → Voice → "Languages I speak" (desktop, 1440)');
  {
    const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await sctx.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
    await markAnnouncementsSeen(sctx, base);
    const page = await sctx.newPage();
    const serr = [];
    page.on('console', (m) => { if (m.type() === 'error') serr.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => serr.push(String(e).slice(0, 200)));
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 3 && await page.locator('.announcements-modal-close').count(); i += 1) {
      await page.locator('.announcements-modal-close').first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
    const settingsBtn = page.getByRole('button', { name: 'Settings', exact: true }).first();
    if (!(await until(async () => (await settingsBtn.count()) > 0, 15000))) await page.screenshot({ path: join(SHOTS, 'settings-1440-debug.png') });
    let step = 'settings button';
    try {
      await settingsBtn.click({ timeout: 20_000 });
      step = 'settings nav';
      await page.waitForSelector('.settings-nav', { timeout: 15000 });
      step = 'Chat section (the agent settings, Voice last)';
      await page.locator('.settings-nav-item', { hasText: /^Chat/ }).first().click({ timeout: 10_000 });
      step = 'voice group summary';
      const group = page.locator('details', { hasText: 'Voice — dreamcontext Assistant' }).last();
      await group.locator('summary').first().click({ timeout: 10_000 });
    } catch (err) {
      await page.screenshot({ path: join(SHOTS, 'settings-1440-fail.png') });
      throw new Error(`Settings step "${step}": ${String(err).slice(0, 160)}`);
    }
    const row = page.getByRole('group', { name: 'Languages I speak' });
    const drawn = await until(async () => (await row.count()) === 1 && await row.isVisible(), 10000);
    report.check('the "Languages I speak" row is drawn, its boxes off by default', drawn && (await row.locator('input:checked').count()) === 0);
    // Controlled by the saved status, like every row in this card: it flips when the server answers.
    await row.getByLabel('Turkish').click();
    const saved = await until(async () => {
      const st = await (await fetch(`${base}/api/agent/voice/status`)).json();
      return Array.isArray(st.sttLanguages) && st.sttLanguages.join(',') === 'tr';
    }, 8000);
    const shownChecked = await until(async () => row.getByLabel('Turkish').isChecked(), 5000);
    report.check('ticking Turkish saves it (status: sttLanguages = ["tr"]) and the box shows it', saved && shownChecked);
    await row.scrollIntoViewIfNeeded();
    const rbox = await row.boundingBox();
    await page.screenshot({ path: join(SHOTS, 'settings-1440-languages.png'), clip: rbox ? { x: 0, y: Math.max(0, rbox.y - 140), width: 1440, height: rbox.height + 220 } : undefined });
    report.check('no console error in Settings', serr.length === 0, serr.slice(0, 3).join(' | '));
    await sctx.close();
  }
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err).slice(0, 600));
} finally {
  await browser?.close().catch(() => {});
  await harness?.close().catch(() => {});
  server?.kill();
  // The whisper stand-in is the server's child; make sure no stray one keeps the port.
  spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'whisper-server')]);
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed${report.fails.length ? `:\n  - ${report.fails.join('\n  - ')}` : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(report.fails.length ? 1 : 0);
