#!/usr/bin/env node
/**
 * A hotkey take on the NATIVE microphone, driven in Chromium.
 *
 *   npm run build && node scripts/verify/assistant-native-mic.mjs
 *
 * The real server and notch UI (isolated HOME, a stand-in `claude`), with the shell's mic
 * commands (`desktop/src-tauri/src/mic.rs`) answered by a mock that behaves like Rust: the take
 * has been recording since the press, `mic_take_end` hands back the real binary body (rate,
 * timings, f32 samples). What it proves is the page half: which commands are called in which
 * order, that no WebKit microphone is opened, that the take is gated and uploaded with its
 * capture facts, and the three release timings — a normal hold, a release while the claim is in
 * flight, a release before the panel even landed — plus a tap that must record nothing.
 * CoreAudio itself is not here; on the owner's machine voice.jsonl records `firstSampleMs`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-native-mic');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'projects', 'alpha-app');

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : (argv[i + 1] ?? null); };
let initDone = false;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!initDone) { initDone = true; out({ type: 'system', subtype: 'init', session_id: flag('--session-id') ?? flag('--resume') ?? 'c', model: 'x', cwd: process.cwd(), slash_commands: [] }); }
    out({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5-5', usage: { input_tokens: 3, cache_read_input_tokens: 60000, cache_creation_input_tokens: 2000, output_tokens: 9 }, content: [{ type: 'text', text: '<!-- notch:present -->\\nHEARD:' + text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
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

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const { DREAMCONTEXT_RECALL_MODE: _r, ...env } = process.env;
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('server did not come up');
}

/** The notch's Tauri bus, plus a mic that answers like src/mic.rs. */
const notchTauri = (samples) => {
  const handlers = new Map();
  let seq = 0;
  window.__mics = 0;
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum) navigator.mediaDevices.getUserMedia = (c) => { window.__mics += 1; return gum(c); };
  window.__mic = { calls: [], beginDelayMs: 0, seatDelayMs: 0, pressAt: 0, nextId: 1, open: null };
  const drop = (event, id) => { const list = handlers.get(event); if (list) list.delete(id); };
  const body = (rate, sinceMs) => {
    const buf = new ArrayBuffer(16 + samples.length * 4);
    const v = new DataView(buf);
    [rate, 30, 45, sinceMs].forEach((n, i) => v.setUint32(i * 4, n, true));
    samples.forEach((s, i) => v.setFloat32(16 + i * 4, s, true));
    return buf;
  };
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
      const m = window.__mic;
      if (cmd.startsWith('mic_take_')) m.calls.push({ cmd, id: args?.id ?? null, t: Date.now() - m.pressAt });
      if (cmd === 'mic_take_cancel') {
        if (args?.id === Number.MAX_SAFE_INTEGER) return null;                  // the probe
        if (m.open && (args?.id == null ? !m.open.claimed : args.id === m.open.id)) m.open = null;
        return null;
      }
      if (cmd === 'mic_take_begin') {
        if (m.beginDelayMs) await new Promise((r) => setTimeout(r, m.beginDelayMs));
        if (!m.open) m.open = { id: m.nextId++, at: Date.now(), claimed: true };
        m.open.claimed = true;
        return { id: m.open.id, sinceMs: Date.now() - m.open.at };
      }
      if (cmd === 'mic_take_end') {
        if (!m.open || m.open.id !== args.id) throw new Error('no such take');
        const since = Date.now() - m.open.at;
        m.open = null;
        return body(48_000, since);
      }
      if (cmd === 'plugin:window|is_visible' && m.seatDelayMs) await new Promise((r) => setTimeout(r, m.seatDelayMs));
      if (cmd === 'plugin:window|outer_position') return { x: 0, y: 0 };
      if (cmd === 'plugin:window|scale_factor') return 1;
      return null;
    },
  };
  // What Rust does on the Carbon edge, BEFORE the page hears it: open an unclaimed take.
  window.__hotkey = (state) => {
    const m = window.__mic;
    if (state === 'pressed') { m.pressAt = Date.now(); if (!m.open) m.open = { id: m.nextId++, at: Date.now(), claimed: false }; }
    const ids = [...(handlers.get('assistant://hotkey') ?? [])];
    for (const id of ids) window[`_${id}`]?.({ event: 'assistant://hotkey', id: 0, payload: { state } });
    return ids.length;
  };
  window.__fireTauri = (event, payload) => {
    const ids = [...(handlers.get(event) ?? [])];
    for (const id of ids) window[`_${id}`]?.({ event, id: 0, payload });
    return ids.length;
  };
};

/** 0.3 s of a quiet 440 Hz tone, 24 kHz mono PCM16: something the speech queue can play. */
function toneWav() {
  const rate = 24_000;
  const n = Math.round(rate * 0.3);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return buf;
}

async function main() {
  if (!existsSync(join(REPO, 'dist', 'dashboard', 'index.html'))) throw new Error('run npm run build first');
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1' }));
  const add = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'alpha-app', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(add.stderr || add.stdout);

  const port = await freePort();
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  // 0.3 s of room, then 1.2 s of a voice-level tone, at 48 kHz: the owner's raw level.
  const rate = 48_000;
  const samples = Array.from({ length: Math.round(rate * 1.5) }, (_, i) => (i < rate * 0.3
    ? (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.0003
    : 0.03 * Math.sin((2 * Math.PI * 220 * i) / rate)));
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const r = await fetch(`${base}/api/assistant/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nova', character: 'Terse.' }) });
    ok('the assistant is created', r.status === 200);

    const page = await browser.newPage({ viewport: { width: 600, height: 720 } });
    await page.addInitScript(notchTauri, samples);
    const stt = [];
    await page.route('**/api/agent/voice/stt', async (route) => {
      const req = route.request();
      stt.push({ meta: JSON.parse(req.headers()['x-dreamcontext-take'] ?? '{}'), bytes: req.postDataBuffer()?.length ?? 0 });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: `take ${stt.length}` }) });
    });
    let speak = false;
    await page.route('**/api/agent/voice/tts', (route) => (speak
      ? route.fulfill({ status: 200, contentType: 'audio/wav', body: toneWav() })
      : route.fulfill({ status: 204, body: '' })));
    await page.route('**/api/agent/voice/focus', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ granted: true, holder: null, ducked: false, gain: 1, paused: [] }) }));
    await page.goto(`${base}/?assistant=1`);
    await page.waitForSelector('.dc-notch__pill', { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelector('.dc-notch__chat .agent-pane-chat textarea'), null, { timeout: 20_000 });
    await page.waitForTimeout(1200);
    const calls = () => page.evaluate(() => window.__mic.calls.map((c) => `${c.cmd.replace('mic_take_', '')}${c.id == null ? '' : ':' + c.id}`));
    const reset = () => page.evaluate(() => { window.__mic.calls = []; });
    const fold = async () => {
      await page.waitForTimeout(800);
      await page.evaluate(() => window.__fireTauri('assistant://escape', {}));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    };

    console.log('\n── a normal hold: the press is on tape, the release ends it');
    ok('the probe found the native microphone (a cancel of an impossible id)', (await calls()).includes(`cancel:${Number.MAX_SAFE_INTEGER}`), JSON.stringify(await calls()));
    await reset();
    await page.evaluate(() => window.__hotkey('pressed'));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__hotkey('released'));
    await page.waitForFunction(() => document.body.innerText.includes('HEARD:take 1'), null, { timeout: 15_000 }).catch(() => null);
    const a = await calls();
    ok('the composer CLAIMS the take the press opened, then ends that same take', a.join(',') === 'begin,end:1', a.join(','));
    ok('no WebKit microphone was opened', (await page.evaluate(() => window.__mics)) === 0);
    ok('the take is uploaded with its capture facts (native, 48 kHz, from the press)', stt.length === 1 && stt[0].meta.source === 'native' && stt[0].meta.rate === 48000 && stt[0].meta.wallMs >= 1400, JSON.stringify(stt[0]));
    ok('…as a 16 kHz WAV of the whole take (~1.5 s)', stt[0]?.bytes > 44 + 16_000 * 2 * 1.4 && stt[0]?.bytes < 44 + 16_000 * 2 * 1.6, String(stt[0]?.bytes));
    ok('…and the transcript is sent to the Assistant', await page.evaluate(() => document.body.innerText.includes('HEARD:take 1')));
    await fold();

    console.log('\n── released while the claim is still in flight: ended, not thrown away');
    await reset();
    await page.evaluate(() => { window.__mic.beginDelayMs = 900; });
    await page.evaluate(() => window.__hotkey('pressed'));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__hotkey('released'));
    await page.waitForFunction(() => document.body.innerText.includes('HEARD:take 2'), null, { timeout: 15_000 }).catch(() => null);
    const b = await calls();
    ok('begin, then end once the claim landed — no cancel', b.join(',') === 'begin,end:2', b.join(','));
    ok('…and that take reaches the Assistant', await page.evaluate(() => document.body.innerText.includes('HEARD:take 2')));
    await page.evaluate(() => { window.__mic.beginDelayMs = 0; });
    await fold();

    console.log('\n── a tap only opens the panel: the microphone is released, nothing is sent');
    await reset();
    const before = stt.length;
    await page.evaluate(() => window.__hotkey('pressed'));
    await page.waitForTimeout(90);
    await page.evaluate(() => window.__hotkey('released'));
    await page.waitForTimeout(2000);
    const c = await calls();
    ok('the unclaimed take is cancelled, never claimed', c.join(',') === 'cancel' && (await page.evaluate(() => window.__mic.open)) === null, c.join(','));
    ok('nothing is uploaded', stt.length === before, String(stt.length - before));
    await fold();

    console.log('\n── a real hold that ended before the panel landed is still a take');
    await reset();
    await page.evaluate(() => { window.__mic.seatDelayMs = 900; });
    await page.evaluate(() => window.__hotkey('pressed'));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__hotkey('released'));
    await page.waitForFunction(() => document.body.innerText.includes('HEARD:take 3'), null, { timeout: 15_000 }).catch(() => null);
    const d = await calls();
    ok('claimed and ended after the panel landed', /^begin,end:\d+$/.test(d.join(',')), d.join(','));
    ok('…and the words reach the Assistant', await page.evaluate(() => document.body.innerText.includes('HEARD:take 3')));
    await page.evaluate(() => { window.__mic.seatDelayMs = 0; });
    await fold();

    console.log('\n── a spoken turn is timed end to end in voice.jsonl (lib/voice/turnTrace.ts)');
    speak = true;
    const turns = () => {
      try {
        return readFileSync(join(HOME, '.dreamcontext', 'logs', 'voice.jsonl'), 'utf-8')
          .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'turn');
      } catch { return []; }
    };
    // Read-aloud starts OFF (assistant.mjs W3): open the panel with a tap and switch it on.
    await page.evaluate(() => window.__hotkey('pressed'));
    await page.waitForTimeout(90);
    await page.evaluate(() => window.__hotkey('released'));
    await page.waitForTimeout(1200);
    const readAloud = () => page.evaluate(() => document.querySelector('.dc-notch__chat .chat-cmp-readaloud')?.getAttribute('aria-pressed') ?? 'missing');
    if (await readAloud() === 'false') await page.click('.dc-notch__chat .chat-cmp-readaloud');
    ok('read-aloud is switched on for this turn', await readAloud() === 'true', await readAloud());
    await page.waitForTimeout(400);
    const had = turns().length;
    await page.evaluate(() => window.__hotkey('pressed'));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__hotkey('released'));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !turns().slice(had).some((t) => t.outcome === 'answered')) await page.waitForTimeout(250);
    const t = turns().slice(had).find((x) => x.outcome === 'answered');
    ok('one answered turn is logged', !!t, JSON.stringify(turns().slice(had)));
    const order = t ? [t.sttMs, t.sentMs, t.firstTextMs, t.ttsAskedMs, t.ttsReadyMs, t.audioMs] : [];
    ok('…with every stage from whisper to the first audible chunk, in order', order.length === 6
      && order.every((v) => Number.isInteger(v) && v >= 0) && order.every((v, i) => i === 0 || v >= order[i - 1]), JSON.stringify(t));
    ok('…timed from the release, so whisper is not 0', t?.sttMs > 0, String(t?.sttMs));
    ok('…and the first API call\'s footprint and the configured effort', t?.cacheRead === 60000 && t?.cacheCreation === 2000
      && t?.input === 3 && t?.model === 'claude-sonnet-5-5' && typeof t?.effort === 'string' && t?.toolsBeforeText === 0, JSON.stringify(t));
    ok('…and no stream delta came, so firstToken is absent rather than 0', t && !('firstTokenMs' in t), JSON.stringify(t));
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
