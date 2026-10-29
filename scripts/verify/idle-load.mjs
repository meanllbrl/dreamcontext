#!/usr/bin/env node
/**
 * What the app costs while NOBODY is doing anything — the measured BEFORE/AFTER for task "the
 * desktop app stays light on an 8GB MacBook Air: no full-transcript re-reads, no endless
 * animations, no polling while unseen" (owner, 2026-10-17: "bazı Air cihazlarda kara kare olacak
 * kadar kasıyor").
 *
 *   npm run build && npm run verify:idle-load
 *   DC_VERIFY_DIST=<a copied main build>/dist/index.js DC_VERIFY_PHASE=before npm run verify:idle-load
 *
 * THE FIXTURE (scratch HOME, always — nothing reads or writes the developer's ~/.claude*, real
 * vaults or a running app server): a vault `proj` with 300 generated tasks, a linked git
 * worktree, and TEN chat tabs restored into ten panes, each a resumed conversation whose
 * transcript is 5–50 MB; two more empty vaults `b` and `c` for the hidden-tab rows; a vault
 * `term` with four Terminal (legacy) panes for the WebGL row; an Assistant configured for the
 * notch rows. `claude` is an inert stand-in on PATH that answers the stream-json control
 * handshake and nothing else — no tokens are spent.
 *
 * WHAT IS MEASURED → tmp/verify-idle-load/<PHASE>/numbers.json:
 *   a  server  30 s V8 CPU profile of the scratch server (inspector) with the ten panes idle:
 *              busy %, the route handlers' inclusive share, the top self-time functions
 *   b  rss     server RSS min / max over the same 30 s
 *   c  polling API requests/min (WebSockets excluded) focused / visible-unfocused / hidden
 *              (2 min), per endpoint; ms from refocus (after 12 s unfocused) and from
 *              hidden → visible to the first refetch
 *   c3 tabs3   three project tabs: requests from the two HIDDEN ones over 2 min focused, across
 *              a refocus and a window hidden → visible, split into explicit-interval endpoints
 *              (kept by design) and everything else (must be 0)
 *   d  motion  `document.getAnimations()` running endless animations, names, focused /
 *              unfocused / hidden / Light mode, plus computed backdrop-filter in Light mode;
 *              how often a clock-held endless animation moves per second (lib/motionClock.ts)
 *   e  trace   Chromium devtools.timeline 10 s idle at 4× CPU throttle: style recalcs/s,
 *              layouts/s
 *   f  composer type 60 chars into a pane's composer with five long panes (vault `five`): getComputedStyle
 *              calls on composer elements per key after the first, long tasks > 50 ms (4×)
 *   k  keys    Chromium + WebKit: 60 keys into a pane's composer with five long panes: ms per key,
 *              layout-forcing reads per key, React commits per key, forced style recalcs (Chromium trace)
 *   g  drag    Chromium + WebKit: drag a tab across five panes by real mouse: max rAF gap, the
 *              zone under the pointer highlighted, the drop layer gone after release / Escape
 *   h  webgl   four Terminal panes: live WebGL contexts (wrapped getContext)
 *   i  notch   `claude` children of the server right after the notch boots
 *   j  notch   DOM mutations/min in the idle notch
 *   stream7    (opt-in) seven panes stream a long answer at once (the stand-in streams on
 *              GO-STREAM, DC_IDLE_STREAM_MS long): server RSS idle / streaming / after, V8 heap
 *              snapshots (idle, streaming, after) with their top holders, rAF frame times, and on
 *              macOS WebKit a `sample` of WebContent counting the text-paint path (CPU RCA K3).
 *              STREAM_ENGINES=webkit,chromium · STREAM_HIDE=<selector> hides a candidate, STREAM_CSS=<rules> adds one (A/B)
 *
 * Unfocused is simulated the way a browser reports it (Tauri is absent here): `blur` with
 * `document.hasFocus()` false; hidden through a `visibilityState` override + the event.
 *
 * THRESHOLDS (the task's criteria) are enforced only when PHASE=after; BEFORE only records.
 * Exit 0 iff every enforced check passed. Collect, don't fail fast.
 * ENV: SECTIONS=a,c,c3,d,e,f,g,h,i (default all) · THROTTLE=4 · ENGINES=chromium,webkit (g)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import WebSocket from 'ws';
import { PHASE, distIndex, scratchDir, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);
const SCRATCH = scratchDir('dc-verify-idle-load');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const PROJ_WT = join(SCRATCH, 'proj-wt');
const PROJ_B = join(SCRATCH, 'b');
const PROJ_C = join(SCRATCH, 'c');
const PROJ_T = join(SCRATCH, 'term');
const PROJ_F = join(SCRATCH, 'five');
const OUT = shotsDir(REPO, 'idle-load');
const AFTER = PHASE === 'after';
const SECTIONS = new Set((process.env.SECTIONS || 'a,c,c3,d,e,f,g,h,i,super').split(',').map((s) => s.trim()));
const THROTTLE = Number(process.env.THROTTLE || 4);
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const PANES = 10;
const MB = 1024 * 1024;

/** A run of some SECTIONS merges into this phase's numbers.json (each run fits one shell). */
const PRIOR = (() => {
  const p = join(OUT, 'numbers.json');
  if (process.env.MERGE === '0' || !existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
})();
const numbers = { ...(PRIOR || {}), phase: PHASE, dist: DIST_INDEX, at: new Date().toISOString() };
const results = [];
const check = (name, ok, detail) => {
  const enforced = AFTER;
  results.push({ name, ok: !enforced || ok, measured: ok });
  console.log(`${enforced ? (ok ? 'PASS' : 'FAIL') : (ok ? 'ok  ' : 'over')}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── the inert `claude` ─────────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
/** Inert stand-in for \`claude\` — see scripts/verify/idle-load.mjs. One cue: the Super Agent
 *  told GO-SUPER-SETUP arranges its stage with its own verbs (two web cards, a half page). */
import { spawnSync } from 'node:child_process';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(DIST_INDEX)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
function setup() {
  const st = cli('super', 'state').json;
  const chat = (st?.containers ?? []).find((c) => c.kind === 'chat');
  cli('super', 'open', 'web', 'https://example.com/a');
  cli('super', 'open', 'web', 'https://example.org/b');
  // Two children's live browsers (jarvis AC7): room is made the way the briefing says, by
  // stacking two chat cards into Others, never by closing one.
  const chats = (st?.containers ?? []).filter((c) => c.kind === 'chat');
  for (const c of chats.slice(-2)) cli('super', 'stack', c.id);
  for (const c of chats.slice(0, 2)) cli('super', 'open', 'browser', c.ref);
  if (chat) cli('super', 'half', chat.id);
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
    }
    if (o.type === 'user' && JSON.stringify(o.message ?? '').includes('GO-STREAM')) stream('idle-stream-' + process.pid);
    if (o.type === 'user' && JSON.stringify(o.message ?? '').includes('GO-SUPER-SETUP')) {
      const sid = 'idle-super-' + process.pid;
      out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
      setup();
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'arranged' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'arranged', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    }
  }
});
const STREAM_MS = Number(process.env.DC_IDLE_STREAM_MS || 60000);
const WORDS = 'okuma yolu tek kaynağa bağlanıyor sonra yazma yolu aynı kilide alınıyor testler tek gözlemle doğrulanıyor ve akış sürüyor'.split(' ');
function stream(sid) {
  const ev = (event) => out({ type: 'stream_event', session_id: sid, event });
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  ev({ type: 'message_start', message: { id: 'msg_' + sid, role: 'assistant', content: [] } });
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  let text = '';
  let n = 0;
  const t0 = Date.now();
  // ~20 deltas/s of 3 words, a new paragraph every ~90 words: the shape of a long answer.
  const timer = setInterval(() => {
    let piece = '';
    for (let k = 0; k < 3; k++) { piece += WORDS[n % WORDS.length] + ' '; n++; }
    if (n % 90 < 3) piece += '\\n\\n';
    text += piece;
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
    if (Date.now() - t0 >= STREAM_MS) {
      clearInterval(timer);
      ev({ type: 'content_block_stop', index: 0 });
      ev({ type: 'message_stop' });
      out({ type: 'assistant', session_id: sid, message: { id: 'msg_' + sid, role: 'assistant', content: [{ type: 'text', text }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: n }, session_id: sid });
    }
  }, 50);
}
process.stdin.on('end', () => process.exit(0));
`;

// ─── fixtures ───────────────────────────────────────────────────────────────────────────
const CONVS = Array.from({ length: PANES }, (_, i) => ({ id: randomUUID(), mb: 5 * (i + 1), title: `Long chat ${i + 1}` }));
const TERMS = Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), title: `Terminal ${i + 1}` }));

/** A transcript of `mb` megabytes: real-shaped turns with usage, so session-stats folds them. */
function writeTranscript(dir, convId, mb, cwd, title) {
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${convId}.jsonl`), 'w');
  const stamp0 = Date.parse('2026-10-01T10:00:00Z');
  const filler = 'Okuma yolunu tek kaynağa bağlıyorum, sonra yazma yolunu aynı kilide alıyorum; testler tek gözlemle doğrulanıyor. '.repeat(30);
  let bytes = 0;
  let i = 0;
  const line = (o) => { const s = `${JSON.stringify(o)}\n`; writeSync(fd, s); bytes += Buffer.byteLength(s); };
  const base = (type) => ({ type, uuid: `${type}-${i}-${convId.slice(0, 8)}`, timestamp: new Date(stamp0 + i * 30_000).toISOString(), cwd, sessionId: convId, version: '2.1.220', gitBranch: 'main', isSidechain: false });
  line({ ...base('user'), message: { role: 'user', content: [{ type: 'text', text: title }] } }); i += 1;
  while (bytes < mb * MB) {
    line({ ...base('assistant'), message: {
      id: `msg_${convId.slice(0, 8)}_${i}`, role: 'assistant', model: 'claude-opus-4-1',
      content: [{ type: 'text', text: `Tur ${i}: ${filler}` }],
      usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000 },
    } }); i += 1;
    line({ ...base('user'), message: { role: 'user', content: [{ type: 'text', text: `Tur ${i}: devam et.` }] } }); i += 1;
  }
  closeSync(fd);
}

function task(i) {
  const slug = `generated-task-${String(i).padStart(3, '0')}`;
  return [slug, `---\nid: task_gen${String(i).padStart(4, '0')}\nname: Generated task ${i}\ndescription: A task the idle-load fixture generated.\npriority: medium\nurgency: medium\nstatus: ${['todo', 'in_progress', 'completed'][i % 3]}\ncreated_at: '2026-10-01'\nupdated_at: '2026-10-01'\ntags:\n  - 'kind:enhancement'\nparent_task: null\nrelated_feature: null\n---\n\n## Why\n\nFixture ${i}.\n\n## Acceptance Criteria\n\n- [ ] one\n- [x] two\n`];
}

/** Light mode is pinned OFF for every row but the Light-mode one: Auto follows the machine
 *  (on battery it turns on), and a measurement must not depend on the power cable. */
function setupScratch(lightMode = 'off') {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ_B, '_dream_context', 'state'), join(PROJ_C, '_dream_context', 'state'), join(PROJ_T, '_dream_context', 'state'), join(PROJ_F, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeAgentUi(lightMode, true);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const [slug, body] of Array.from({ length: 300 }, (_, i) => task(i))) writeFileSync(join(PROJ, '_dream_context', 'state', `${slug}.md`), body);
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf-8' });
  for (const p of [PROJ, PROJ_B, PROJ_C, PROJ_T, PROJ_F]) git(p, 'init', '-q', '-b', 'main');
  writeFileSync(join(PROJ, 'README.md'), '# proj\n');
  git(PROJ, 'add', 'README.md');
  git(PROJ, '-c', 'user.email=v@example.invalid', '-c', 'user.name=verify', 'commit', '-q', '-m', 'init');
  git(PROJ, 'worktree', 'add', '-q', PROJ_WT, '-b', 'side');
  const tdir = join(HOME, '.claude', 'projects', 'scratch-proj');
  for (const c of CONVS) writeTranscript(tdir, c.id, c.mb, PROJ, c.title);
  const termDir = join(HOME, '.claude', 'projects', 'scratch-term');
  for (const t of TERMS) writeTranscript(termDir, t.id, 1, PROJ_T, t.title);
  writeFileSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({
    activePane: 0,
    sessions: CONVS.map((c, i) => ({ title: c.title, kind: 'chat', bypass: false, minimized: false, size: 1, sessionId: c.id, pane: i, active: true })),
  }, null, 2));
  writeFileSync(join(PROJ_T, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({
    activePane: 0,
    sessions: TERMS.map((t, i) => ({ title: t.title, kind: 'agent', bypass: false, minimized: false, size: 1, sessionId: t.id, pane: i, active: true })),
  }, null, 2));
  // The composer row's five long panes: the five longest conversations (30-50 MB).
  writeFileSync(join(PROJ_F, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({
    activePane: 0,
    sessions: CONVS.slice(5).map((c, i) => ({ title: c.title, kind: 'chat', bypass: false, minimized: false, size: 1, sessionId: c.id, pane: i, active: true })),
  }, null, 2));
  for (const [name, p] of [['proj', PROJ], ['b', PROJ_B], ['c', PROJ_C], ['term', PROJ_T], ['five', PROJ_F]]) {
    const r = spawnSync(process.execPath, [DIST_INDEX, 'vaults', 'add', name, p], { env: scratchEnv({ HOME }), encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`vaults add ${name} failed: ${r.stderr || r.stdout}`);
  }
}

/** The caller's env minus what could reach the owner's real account: a builder session's
 *  config dir, any API key, and the desktop parent pid (the scratch server must never think it
 *  belongs to the running app). Everything the scratch server needs is set on top. */
function scratchEnv(extra) {
  const env = { ...process.env };
  for (const k of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'DREAMCONTEXT_PARENT_PID', 'DREAMCONTEXT_SERVER_PID', 'DREAMCONTEXT_TAB_SESSION']) delete env[k];
  return { ...env, ...extra };
}

function writeAgentUi(lightMode, chatView) {
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, titleMigrated: true,
    hotkey: 'Ctrl+A', renderer: 'webgl', chatView, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode, superAgent: true,
  }, null, 2)}\n`);
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer() {
  const port = await freePort();
  const inspect = await freePort();
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [`--inspect=127.0.0.1:${inspect}`, DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: scratchEnv({ HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', () => {});
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok) return { srv, port, inspect, base: `http://127.0.0.1:${port}` }; } catch { /* not up */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

async function stopServer(s) {
  if (!s) return;
  s.srv.kill('SIGTERM');
  await sleep(800);
  try { s.srv.kill('SIGKILL'); } catch { /* gone */ }
  // Any stand-in the server spawned dies with its stdin; make sure (scratch PATH only).
  spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
}

// ─── server-side probes ─────────────────────────────────────────────────────────────────
async function cpuProfile(inspectPort, ms) {
  const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 1000 });
  await send('Profiler.start');
  await sleep(ms);
  const { profile } = await send('Profiler.stop');
  ws.close();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const self = new Map();
  profile.samples.forEach((sid, k) => self.set(sid, (self.get(sid) || 0) + (profile.timeDeltas[k] || 0)));
  const total = profile.endTime - profile.startTime;
  let idle = 0;
  const handlerTime = new Map();
  const selfByFn = new Map();
  for (const [sid, t] of self) {
    const n = byId.get(sid);
    const fn = n.callFrame.functionName || '(anonymous)';
    if (fn === '(idle)') { idle += t; continue; }
    const key = `${fn} ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber}`;
    selfByFn.set(key, (selfByFn.get(key) || 0) + t);
    // Attribute this sample to the OUTERMOST route handler on its stack (inclusive time).
    let h = null;
    for (let cur = sid; cur !== undefined; cur = parent.get(cur)) {
      const name = byId.get(cur)?.callFrame.functionName || '';
      if (/^handle[A-Z]\w+$/.test(name)) h = name;
    }
    if (h) handlerTime.set(h, (handlerTime.get(h) || 0) + t);
  }
  const pct = (t) => Math.round((t / total) * 1000) / 10;
  return {
    busyPct: pct(total - idle),
    handlers: Object.fromEntries([...handlerTime].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, t]) => [k, pct(t)])),
    topSelf: Object.fromEntries([...selfByFn].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, t]) => [k, pct(t)])),
  };
}

function rssKb(pid) {
  const r = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf-8' });
  return Number((r.stdout || '').trim()) || 0;
}

function claudeChildren(serverPid) {
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8' }).stdout.split('\n');
  const rows = ps.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
  const kids = new Set([serverPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows) if (kids.has(r.ppid) && !kids.has(r.pid)) { kids.add(r.pid); changed = true; }
  }
  return rows.filter((r) => kids.has(r.pid) && r.pid !== serverPid && r.cmd.includes(join(HOME, '.local', 'bin', 'claude')));
}

// ─── in-page helpers ────────────────────────────────────────────────────────────────────
const SPY = `
  (() => {
    const gcs = window.getComputedStyle.bind(window);
    window.__dcGcs = 0;
    window.getComputedStyle = function (el, pseudo) {
      try { if (el && el.closest && el.closest('.chat-cmp')) window.__dcGcs += 1; } catch {}
      return gcs(el, pseudo);
    };
    window.__dcGl = [];
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      const ctx = getContext.call(this, kind, ...rest);
      if (ctx && /webgl/.test(String(kind))) window.__dcGl.push({ canvas: this, ctx });
      return ctx;
    };
    window.__dcLong = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__dcLong.push({ start: e.startTime, d: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}
  })();
`;
const setUnfocused = (page) => page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
const setFocused = (page) => page.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
const setHidden = (page, hidden) => page.evaluate((h) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
  if (h) document.hasFocus = () => false;
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
const runningEndless = (page) => page.evaluate(() => document.getAnimations()
  .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity)
  .map((a) => a.animationName || a.constructor.name));

async function openVault(page, base, vault) {
  await page.goto(`${base}/?vault=${vault}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const tabsShown = async () => (await page.locator('.agent-pane-tabbar .agent-tab:visible').count()) > 0;
  // Restored tabs open the overlay by themselves; Escape would fold it again. Only a page
  // that came up without it (a first-run modal on top, an empty vault) is cleared and opened.
  for (let i = 0; i < 20 && !(await tabsShown()); i += 1) await page.waitForTimeout(500);
  if (await tabsShown()) return;
  for (let i = 0; i < 3; i += 1) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  const rail = page.locator('.sidebar-item', { hasText: /^\s*Chat\b/ }).first();
  if (await rail.count()) { await rail.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
  for (let i = 0; i < 3 && !(await page.locator('.agent-surface.expanded').count()); i += 1) {
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(1200);
  }
}
const paneCount = (page) => page.evaluate(() => document.querySelectorAll('.agent-panes > .agent-pane').length);
async function untilPanes(page, n, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await paneCount(page)) >= n) return true; await page.waitForTimeout(500); }
  return false;
}

function requestCounter(page) {
  const log = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'websocket') return;
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return;
    log.push({ t: Date.now(), path: u.pathname, vault: r.headers()['x-dreamcontext-vault'] || null });
  });
  return {
    since: (t0, t1 = Date.now(), filter = () => true) => log.filter((x) => x.t >= t0 && x.t < t1 && filter(x)),
    firstAfter: (t0, filter = () => true) => log.find((x) => x.t >= t0 && filter(x)) || null,
  };
}
const byPath = (xs) => xs.reduce((o, x) => { o[x.path] = (o[x.path] || 0) + 1; return o; }, {});
/** Endpoints whose queries carry their OWN interval by design and keep it in a hidden tab
 *  (hooks/useAgentCapabilities.ts:14-19; useTasks `useSyncStatus`; useAutomations' dispatcher,
 *  questions and feed). Everything else a hidden tab asks for is a default-interval or focus
 *  refetch, which must be 0. */
const EXPLICIT = /^\/api\/(agent\/(capabilities|model-config|session-stats|usage-limits|accounts|task-progress|shelf|session-facts|goal-live|teammates|council-live)|tasks\/sync-status|automations\/(dispatcher|questions|threads))\b/;

// ─── sections ───────────────────────────────────────────────────────────────────────────
async function sectionsOnMain(server, browser) {
  const ctx = await browser.newContext({ viewport: { width: 2560, height: 1300 }, colorScheme: 'dark', reducedMotion: 'no-preference' });
  await ctx.addInitScript(SPY);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  const reqs = requestCounter(page);
  await openVault(page, server.base, 'proj');
  const panesUp = await untilPanes(page, PANES);
  await page.waitForTimeout(8_000); // replay settles, first polls land
  // A headless page does not hold focus by itself: make it the focused window, the state every
  // "focused" row below is about (both builds see the same events).
  await setFocused(page);
  numbers.setup = { panes: await paneCount(page), panesUp };
  console.log(`      setup: ${JSON.stringify(numbers.setup)}`);
  await page.screenshot({ path: join(OUT, 'main-10-panes.png') });

  if (SECTIONS.has('a')) {
    // Idle means AFTER the boot: the first read of ten 5-50 MB transcripts is a one-time cost
    // whose memory is released over the next half minute. Both phases wait the same.
    await page.waitForTimeout(Number(process.env.SETTLE_MS || 45_000));
    const rss = [];
    const sampler = setInterval(() => rss.push(rssKb(server.srv.pid)), 1000);
    const prof = await cpuProfile(server.inspect, 30_000);
    clearInterval(sampler);
    const mb = rss.filter(Boolean).map((k) => Math.round(k / 1024));
    numbers.server = { ...prof, rssMinMb: Math.min(...mb), rssMaxMb: Math.max(...mb), rssRangeMb: Math.max(...mb) - Math.min(...mb), rssSeriesMb: mb };
    console.log(`      server: busy ${prof.busyPct}% handlers ${JSON.stringify(prof.handlers)} rss ${numbers.server.rssMinMb}-${numbers.server.rssMaxMb}MB`);
    const worst = Object.values(prof.handlers)[0] ?? 0;
    check('AC1 server idle busy <= 10 %', prof.busyPct <= 10, `${prof.busyPct}%`);
    check('AC1 no handler > 3 %', worst <= 3, JSON.stringify(prof.handlers));
    check('AC1 server RSS range <= 100 MB', numbers.server.rssRangeMb <= 100, `${numbers.server.rssMinMb}-${numbers.server.rssMaxMb} MB`);
  }

  if (SECTIONS.has('d')) {
    if (process.env.DIAG === '1') console.log('      DIAG animations:', JSON.stringify(await page.evaluate(() => document.getAnimations().map((a) => [a.animationName, a.playState, a.effect?.getTiming().iterations, String(a.effect?.target?.className || '').slice(0, 60)]))));
    if (process.env.DIAG === '1') console.log('      DIAG vars:', JSON.stringify(await page.evaluate(() => { const f = document.querySelector('.sleep-tracker-face .smascot-face'); const cs = f ? getComputedStyle(f) : null; const rs = getComputedStyle(document.documentElement); return { ds: { ...document.documentElement.dataset }, rootAmbient: rs.getPropertyValue('--dc-motion-ambient-name'), rootPlay: rs.getPropertyValue('--dc-motion-play'), faceAmbient: cs?.getPropertyValue('--dc-motion-ambient-name'), faceName: cs?.animationName, faceAnim: cs?.animation }; })));
    if (process.env.DIAG === '1') console.log('      DIAG smascot:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.smascot, [class*="about-"]')].slice(0, 8).map((el) => { const cs = getComputedStyle(el); return [String(el.className).slice(0, 50), el.closest('[class]')?.parentElement?.className?.slice?.(0, 40), cs.animationName, cs.animationPlayState, el.getClientRects().length]; }))));
    const focused = await runningEndless(page);
    // The 15 fps clock (lib/motionClock.ts, task: durum animasyonları WindowServer'ı yormaz): an
    // endless animation is PAUSED and stepped, never left on the display link. Proof it still
    // moves, and how often: the distinct currentTime values of a held one over 1 s of frames.
    const stepped = await page.evaluate(async () => {
      const held = document.getAnimations().filter((a) => a.playState === 'paused' && a.effect?.getTiming().iterations === Infinity);
      if (!held.length) return { held: 0, movesPerSec: null, frames: 0 };
      const a = held[0];
      const seen = new Set();
      let frames = 0;
      const t0 = performance.now();
      await new Promise((done) => {
        const f = () => { frames += 1; seen.add(String(a.currentTime)); if (performance.now() - t0 < 1000) requestAnimationFrame(f); else done(); };
        requestAnimationFrame(f);
      });
      return { held: held.length, movesPerSec: seen.size, frames };
    });
    await setUnfocused(page); await page.waitForTimeout(500);
    const unfocused = await runningEndless(page);
    await setHidden(page, true); await page.waitForTimeout(500);
    const hidden = await runningEndless(page);
    await setHidden(page, false); await setFocused(page); await page.waitForTimeout(500);
    numbers.motion = { windowActiveAtFocused: await page.evaluate(() => document.documentElement.dataset.windowActive ?? null), focused: focused.length, unfocused: unfocused.length, hidden: hidden.length, focusedNames: [...new Set(focused)], unfocusedNames: [...new Set(unfocused)], stepped };
    console.log(`      motion: ${JSON.stringify(numbers.motion)}`);
    check('AC7 hidden -> 0 running endless animations', hidden.length === 0, `${hidden.length}`);
    if (AFTER) {
      check('AC4 focused + unfocused -> 0 endless animations on the display link', focused.length === 0 && unfocused.length === 0, `${focused.length} / ${unfocused.length}`);
      check('AC4 a held endless animation still moves, 10-22 times a second', stepped.held > 0 && stepped.movesPerSec >= 10 && stepped.movesPerSec <= 22, JSON.stringify(stepped));
    }
  }

  if (SECTIONS.has('e')) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    const events = [];
    cdp.on('Tracing.dataCollected', (d) => events.push(...d.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' });
    await page.waitForTimeout(10_000);
    await new Promise((r) => { cdp.once('Tracing.tracingComplete', r); cdp.send('Tracing.end'); });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const n = (name) => events.filter((e) => e.name === name && (e.ph === 'X' || e.ph === 'B')).length;
    numbers.trace = { styleRecalcsPerS: Math.round(n('UpdateLayoutTree') / 10 * 10) / 10, layoutsPerS: Math.round(n('Layout') / 10 * 10) / 10, throttle: THROTTLE };
    console.log(`      trace: ${JSON.stringify(numbers.trace)}`);
    const before = readBefore()?.trace?.styleRecalcsPerS;
    if (before != null) check('AC7 idle style recalcs/s <= 1/3 of BEFORE', numbers.trace.styleRecalcsPerS <= before / 3, `${numbers.trace.styleRecalcsPerS} vs BEFORE ${before}`);
  }

  if (SECTIONS.has('conn')) {
    const series = [];
    for (let i = 0; i < 20; i += 1) {
      series.push(await page.evaluate(() => [...document.querySelectorAll('.agent-panes > .agent-pane')].filter((p) => /Connecting|Reconnecting/.test(p.textContent || '')).length));
      await page.waitForTimeout(2000);
    }
    console.log(`      conn: panes still connecting every 2 s after boot+8s: ${JSON.stringify(series)}`);
  }

  if (SECTIONS.has('r')) {
    // Diagnosis: every request around one refocus after a 20 s unfocused gap.
    await page.waitForTimeout(16_000);
    await setUnfocused(page);
    await page.waitForTimeout(20_000);
    const ds = await page.evaluate(() => document.documentElement.dataset.windowActive);
    await setFocused(page);
    const at = Date.now();
    await page.waitForTimeout(3_000);
    console.log(`      refocus diag (windowActive before=${ds}):`, JSON.stringify(reqs.since(at - 3000, at + 3000).map((x) => `${x.t - at} ${x.path}`)));
  }

  if (SECTIONS.has('c')) {
    const t0 = Date.now(); await page.waitForTimeout(60_000); const t1 = Date.now();
    await setUnfocused(page);
    await page.waitForTimeout(60_000); const t2 = Date.now();
    await setFocused(page);
    // The refocus row on its own gap: 20 s unfocused is past the 10 s line and short of the
    // x4 interval (60 s), so the default queries are STALE when the window comes back.
    await page.waitForTimeout(16_000);
    await setUnfocused(page);
    await page.waitForTimeout(20_000);
    // The clock is read BEFORE the event: a refetch fires synchronously inside it.
    const refocusAt = Date.now();
    await setFocused(page);
    await page.waitForTimeout(3_000);
    const firstRefocus = reqs.firstAfter(refocusAt, (x) => !EXPLICIT.test(x.path));
    await page.waitForTimeout(5_000);
    await setHidden(page, true);
    const h0 = Date.now(); await page.waitForTimeout(120_000); const h1 = Date.now();
    const visibleAt = Date.now();
    await setHidden(page, false);
    await page.waitForTimeout(3_000);
    const firstVisible = reqs.firstAfter(visibleAt, (x) => !EXPLICIT.test(x.path));
    const focusedReqs = reqs.since(t0, t1);
    const unfocusedReqs = reqs.since(t1 + 1, t2);
    const hiddenReqs = reqs.since(h0 + 500, h1);
    numbers.polling = {
      focusedPerMin: focusedReqs.length, unfocusedPerMin: unfocusedReqs.length, hiddenPer2Min: hiddenReqs.length,
      refocusFirstMs: firstRefocus ? firstRefocus.t - refocusAt : null, visibleFirstMs: firstVisible ? firstVisible.t - visibleAt : null,
      focusedByPath: byPath(focusedReqs), unfocusedByPath: byPath(unfocusedReqs), hiddenByPath: byPath(hiddenReqs),
    };
    console.log(`      polling: focused ${focusedReqs.length}/min unfocused ${unfocusedReqs.length}/min hidden ${hiddenReqs.length}/2min refocus ${numbers.polling.refocusFirstMs}ms visible ${numbers.polling.visibleFirstMs}ms`);
    console.log(`        hidden: ${JSON.stringify(numbers.polling.hiddenByPath)}`);
    check('AC6 visible-unfocused <= 30 % of focused requests/min', unfocusedReqs.length <= focusedReqs.length * 0.3, `${unfocusedReqs.length} vs ${focusedReqs.length}`);
    check('AC6 hidden -> 0 polling requests over 2 min', hiddenReqs.length === 0, JSON.stringify(numbers.polling.hiddenByPath));
    check('AC6 unfocused -> focused (>= 10 s) refetches within 1 s', firstRefocus !== null && firstRefocus.t - refocusAt <= 1000, `${numbers.polling.refocusFirstMs} ms`);
    check('AC6 hidden -> visible refetches within 1 s', firstVisible !== null && firstVisible.t - visibleAt <= 1000, `${numbers.polling.visibleFirstMs} ms`);
  }

  if (SECTIONS.has('c3')) {
    const pick = async (name) => {
      await page.locator('.project-tabs-add').click();
      await page.waitForSelector('.psw-input', { timeout: 10_000 });
      await page.locator('.psw-input').fill(name);
      await page.locator('.psw-row').filter({ has: page.locator('.psw-row-name', { hasText: new RegExp(`^${name}$`) }) }).first().click();
      await page.waitForTimeout(3_000);
      for (let i = 0; i < 3; i += 1) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
    };
    let opened = true;
    try {
      const chips = () => page.evaluate(() => [...document.querySelectorAll('.project-tab .project-tab-name')].map((e) => e.textContent.trim()));
      for (let i = 0; i < 3; i += 1) {
        const have = await chips();
        if (have.includes('b') && have.includes('c')) break;
        for (const v of ['b', 'c']) if (!(await chips()).includes(v)) await pick(v);
        console.log(`      tabs3: chips ${JSON.stringify(await chips())}`);
      }
      if (!((await chips()).includes('b') && (await chips()).includes('c'))) throw new Error(`three chips did not open: ${JSON.stringify(await chips())}`);
      if (process.env.DIAG === '1') for (const w of [1000, 4000, 8000]) { await page.waitForTimeout(w); console.log(`      DIAG chips +${w}: ${JSON.stringify(await chips())}`); }
      await page.locator(".project-tab[data-vault] .project-tab-main").filter({ has: page.locator('.project-tab-name', { hasText: /^proj$/ }) }).first().click();
      await page.waitForTimeout(16_000); // b and c hidden >= 15 s
    } catch (e) { opened = false; console.log(`      tabs3: could not open b/c (${e.message})`); }
    if (opened) {
      const switchAt = Date.now();
      await page.locator(".project-tab[data-vault] .project-tab-main").filter({ has: page.locator('.project-tab-name', { hasText: /^b$/ }) }).first().click();
      await page.waitForTimeout(1_500);
      const firstB = reqs.firstAfter(switchAt, (x) => x.vault === 'b' && !EXPLICIT.test(x.path));
      if (process.env.DIAG === '1') console.log('      DIAG switch:', JSON.stringify(reqs.since(switchAt - 20000, switchAt + 1500).filter((x) => x.vault === 'b').map((x) => `${x.t - switchAt} ${x.path}`)), await page.evaluate(() => [...document.querySelectorAll('.project-tab')].map((e) => `${e.textContent.trim()}:${e.getAttribute('data-active')}`).join(' | ')));
      await page.locator(".project-tab[data-vault] .project-tab-main").filter({ has: page.locator('.project-tab-name', { hasText: /^proj$/ }) }).first().click();
      await page.waitForTimeout(16_000);
      const w0 = Date.now();
      await page.waitForTimeout(40_000);
      await setUnfocused(page); await page.waitForTimeout(12_000); await setFocused(page);
      await page.waitForTimeout(20_000);
      await setHidden(page, true); await page.waitForTimeout(5_000); await setHidden(page, false);
      await page.waitForTimeout(43_000);
      const w1 = Date.now();
      const hiddenTabs = reqs.since(w0, w1, (x) => x.vault === 'b' || x.vault === 'c');
      const other = hiddenTabs.filter((x) => !EXPLICIT.test(x.path));
      numbers.tabs3 = { switchFirstMs: firstB ? firstB.t - switchAt : null, hiddenTabsTotal: hiddenTabs.length, hiddenTabsDefault: other.length, hiddenTabsByPath: byPath(hiddenTabs) };
      console.log(`      tabs3: ${JSON.stringify(numbers.tabs3)}`);
      check('AC6 switching to a tab hidden >= 15 s refetches within 1 s', firstB !== null && firstB.t - switchAt <= 1000, `${numbers.tabs3.switchFirstMs} ms`);
      check('AC6 two hidden tabs: 0 default-interval / focus requests over 2 min (refocus + hidden->visible included)', other.length === 0, JSON.stringify(byPath(other)));
    }
  }

  if (SECTIONS.has('d')) {
    // Light mode: the setting through the real write path, then a fresh boot.
    await fetch(`${server.base}/api/launcher/agent-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(AFTER ? { merge: true, patch: { lightMode: 'on' } } : { ...JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), 'utf-8')), lightMode: 'on' }) });
    await openVault(page, server.base, 'proj');
    await untilPanes(page, PANES, 60_000);
    await page.waitForTimeout(4_000);
    const light = await runningEndless(page);
    // AC7: a one-shot entrance started while Light mode is on still reaches its end state —
    // never paused, never removed (only ENDLESS animations are touched).
    const entrances = await page.evaluate(() => document.getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .map((a) => [a.animationName || a.constructor.name, a.playState]));
    const stuck = entrances.filter(([, st]) => st === 'paused' || st === 'idle');
    const blur = await page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => {
      const cs = getComputedStyle(el); return (cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none');
    }).length);
    numbers.motion = { ...(numbers.motion || {}), light: light.length, lightNames: [...new Set(light)], lightBackdropElements: blur, dataLight: await page.evaluate(() => document.documentElement.dataset.light ?? null) };
    console.log(`      light: ${JSON.stringify({ light: light.length, blur, dataLight: numbers.motion.dataLight })}`);
    check('AC12 Light mode on -> 0 endless animations on the display link (status held by the clock)', light.length === 0, JSON.stringify(numbers.motion.lightNames));
    numbers.motion.lightEntrances = entrances.length;
    check('AC7 entrance animations in Light mode reach their end (none paused)', stuck.length === 0 && entrances.length > 0, `${entrances.length} entrances, ${stuck.length} stuck`);
    check('AC12 Light mode on -> computed backdrop-filter none everywhere', blur === 0, `${blur} elements`);
    await fetch(`${server.base}/api/launcher/agent-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(AFTER ? { merge: true, patch: { lightMode: 'off' } } : { ...JSON.parse(readFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), 'utf-8')), lightMode: 'off' }) });
  }
  numbers.pageErrors = errors.slice(0, 10);
  await ctx.close();
}

/** f: type into a pane's composer with FIVE long panes on screen (its own vault, `five`). */
async function sectionComposer(server, browser) {
  const ctx = await browser.newContext({ viewport: { width: 2000, height: 1200 }, colorScheme: 'dark', reducedMotion: 'no-preference' });
  await ctx.addInitScript(SPY);
  const page = await ctx.newPage();
  await openVault(page, server.base, 'five');
  await untilPanes(page, 5, 60_000);
  await page.waitForTimeout(10_000);
  await setFocused(page);
  const cdp = await ctx.newCDPSession(page);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click();
  await page.keyboard.type('a');
  await page.waitForTimeout(400);
  const t0 = await page.evaluate(() => { window.__dcGcs = 0; window.__dcLong = []; return performance.now(); });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  if (process.env.DIAG === '1') { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
  const text = 'the composer types sixty characters without a long task.....';
  for (const ch of text.slice(0, 60)) await page.keyboard.type(ch, { delay: 30 });
  await page.waitForTimeout(800);
  if (process.env.DIAG === '1') {
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((sid, k) => { const n = byId.get(sid); const key = `${n.callFrame.functionName || '(anon)'} ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber}`; self.set(key, (self.get(key) || 0) + (profile.timeDeltas[k] || 0)); });
    console.log('      DIAG composer self-time (ms):', [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, t]) => `${Math.round(t / 1000)} ${k}`).join('\n        '));
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const t1 = await page.evaluate(() => performance.now());
  const { gcs, long } = await page.evaluate(([a, b]) => ({ gcs: window.__dcGcs, long: window.__dcLong.filter((e) => e.start >= a && e.start <= b && e.d > 50).map((e) => e.d) }), [t0, t1]);
  numbers.composer = { keys: 60, getComputedStylePerKey: Math.round((gcs / 60) * 100) / 100, getComputedStyleTotal: gcs, longTasksOver50: long.length, longestMs: Math.round(Math.max(0, ...long)) };
  console.log(`      composer: ${JSON.stringify(numbers.composer)}`);
  check('AC8 0 getComputedStyle calls on composer elements per key after the first', gcs === 0, `${gcs} over 60 keys`);
  check('AC8 no long task > 50 ms while typing (4x)', long.length === 0, `${long.length} (longest ${numbers.composer.longestMs} ms)`);
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace');
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await ctx.close();
}

/**
 * k: what ONE keystroke costs in a pane's composer with five long panes (vault `five`), in
 * Chromium AND WebKit (the app's engine). Per key: the main-thread ms from keydown to the end of
 * the key's task (React's render + layout effects included) and to the frame after it, the
 * layout-forcing reads JS made (scrollHeight & co. — each one makes the engine resolve the whole
 * dirty document) and their ms, React commits, the components that re-rendered (CENSUS=1, names
 * need an unminified build), and in Chromium the style recalcs / layouts the trace saw forced
 * from script (inside an event or a function call, not the frame's own).
 */
const KEYCOST = `
  (() => {
    const W = window;
    const K = W.__dcKey = { on: false, keys: [], cur: null, reads: 0, readMs: 0, commits: 0, census: null };
    const timed = (proto, prop) => {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.get) return;
      Object.defineProperty(proto, prop, { configurable: true, get() {
        if (!K.on) return d.get.call(this);
        const s = performance.now(); try { return d.get.call(this); } finally { K.reads += 1; K.readMs += performance.now() - s; }
      } });
    };
    for (const p of ['scrollHeight', 'scrollWidth', 'clientHeight', 'clientWidth', 'scrollTop']) timed(Element.prototype, p);
    for (const p of ['offsetHeight', 'offsetWidth', 'offsetTop', 'offsetLeft']) timed(HTMLElement.prototype, p);
    const gbcr = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (!K.on) return gbcr.call(this);
      const s = performance.now(); try { return gbcr.call(this); } finally { K.reads += 1; K.readMs += performance.now() - s; }
    };
    const gcs = W.getComputedStyle;
    W.getComputedStyle = function (...a) {
      if (!K.on) return gcs.apply(W, a);
      const s = performance.now(); try { return gcs.apply(W, a); } finally { K.reads += 1; K.readMs += performance.now() - s; }
    };
    const fiberName = (f) => { const t = f.type; if (!t) return null; if (typeof t === 'function') return t.displayName || t.name || 'anon'; if (typeof t === 'object') { const inner = t.type || t.render; return (t.displayName || (inner && (inner.displayName || inner.name)) || 'memo'); } return null; };
    const FN = new Set([0, 1, 11, 14, 15]);
    const walk = (next, counts) => {
      const prev = next.alternate;
      if (prev && next.child === prev.child) return;
      for (let c = next.child; c; c = c.sibling) {
        if (FN.has(c.tag) && ((c.flags & 1) || (c.alternate && c.memoizedState !== c.alternate.memoizedState))) { const n = fiberName(c) + ((c.flags & 1) ? '' : '(bailed)'); if (n) counts[n] = (counts[n] || 0) + 1; }
        walk(c, counts);
      }
    };
    W.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, renderers: new Map(), isDisabled: false,
      inject() { return 1; },
      onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
      onCommitFiberRoot(_id, root) {
        if (!K.on) return;
        K.commits += 1;
        if (K.census) { try { const c = {}; walk(root.current, c); const key = (window.event ? window.event.type : 'no-event') + ' :: ' + Object.keys(c).sort().join(','); K.census[key] = (K.census[key] || 0) + 1; } catch (e) { K.census['err ' + e] = 1; } }
      },
    };
    K.muts = {};
    if (W.__dcExp === 'nodefault') {
      const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'defaultValue');
      Object.defineProperty(HTMLTextAreaElement.prototype, 'defaultValue', { configurable: true, get: d.get, set(v) { if (this.classList.contains('chat-cmp-input')) return; d.set.call(this, v); } });
    }
    const desc = (n) => n && n.nodeType === 1 ? (n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')) : n ? ('#' + n.nodeName) + '<' + desc(n.parentNode) : '?';
    W.addEventListener('DOMContentLoaded', () => {
      new MutationObserver((list) => { if (!K.on) return; for (const m of list) { const k = m.type + ' ' + (m.attributeName || '') + ' ' + desc(m.target); K.muts[k] = (K.muts[k] || 0) + 1; } })
        .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const ch = new MessageChannel();
    W.addEventListener('keydown', () => {
      if (!K.on) return;
      const rec = { t0: performance.now(), sync: null, frame: null };
      K.keys.push(rec);
      // A message posted from keydown runs after the key's own task (keydown → beforeinput →
      // input → React's discrete render + layout effects).
      ch.port1.onmessage = () => { rec.sync = performance.now() - rec.t0; };
      ch.port2.postMessage(0);
      // setTimeout from the next rAF callback runs after that frame's style + layout + paint.
      requestAnimationFrame(() => setTimeout(() => { rec.frame = performance.now() - rec.t0; }, 0));
    }, true);
  })();
`;

async function sectionKeyCost(server, engineName) {
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  const ctx = await browser.newContext({ viewport: { width: 2000, height: 1200 }, colorScheme: 'dark', reducedMotion: 'no-preference' });
  if (process.env.EXPERIMENT) await ctx.addInitScript(`window.__dcExp = ${JSON.stringify(process.env.EXPERIMENT)};`);
  await ctx.addInitScript(KEYCOST);
  const page = await ctx.newPage();
  try {
    await openVault(page, server.base, 'five');
    await untilPanes(page, 5, 60_000);
    await page.waitForTimeout(10_000);
    await setFocused(page);
    const input = page.locator('.chat-cmp-input:visible').first();
    if (process.env.EXPERIMENT === 'nospell') await input.evaluate((el) => { el.spellcheck = false; });
    await input.click();
    await page.keyboard.type('warm up ');
    await page.waitForTimeout(600);
    const cdp = engineName === 'chromium' ? await ctx.newCDPSession(page) : null;
    const trace = [];
    if (cdp) {
      cdp.on('Tracing.dataCollected', (d) => { for (const e of d.value) trace.push(e); });
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
      if (process.env.PROFILE === '1') { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); await cdp.send('Profiler.start'); }
    }
    const KEYS = Number(process.env.KEYS || 60);
    // AppleSpell (macOS's spelling server) is its own process: its CPU seconds before and after.
    const spellCpu = () => {
      const r = spawnSync('ps', ['-Ao', 'time=,comm='], { encoding: 'utf-8' });
      return (r.stdout || '').split('\n').filter((l) => /AppleSpell/.test(l)).reduce((sum, l) => {
        const t = l.trim().split(/\s+/)[0]; const [m, sec] = t.split(':'); return sum + Number(m) * 60 + Number(sec);
      }, 0);
    };
    const spell0 = spellCpu();
    const wall0 = Date.now();
    await page.evaluate((census) => { const K = window.__dcKey; K.keys = []; K.reads = 0; K.readMs = 0; K.commits = 0; K.census = census ? {} : null; K.on = true; }, process.env.CENSUS === '1');
    // Ten words of six, one line in a pane's composer: the keystroke path, not a wrap.
    const text = 'typing feels like typing here, one key at a time, no stalls.';
    for (let i = 0; i < KEYS; i += 1) { await page.keyboard.type(text[i % text.length], { delay: 0 }); await page.waitForTimeout(70); }
    await page.waitForTimeout(400);
    const k = await page.evaluate(() => { const K = window.__dcKey; K.on = false; return { keys: K.keys, reads: K.reads, readMs: K.readMs, commits: K.commits, census: K.census, muts: K.muts }; });
    if (process.env.PROFILE === '1') console.log('      MUTATIONS:\n        ' + Object.entries(k.muts).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([m, c]) => `${c} ${m}`).join('\n        '));
    const spellMs = Math.round((spellCpu() - spell0) * 1000);
    const wallMs = Date.now() - wall0;
    let forced = null;
    if (cdp && process.env.PROFILE === '1') {
      const { profile } = await cdp.send('Profiler.stop');
      const self = new Map();
      const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      profile.samples.forEach((sid, i) => { const n = byId.get(sid); const key = `${n.callFrame.functionName || '(anon)'} ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber}`; self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0)); });
      console.log('      PROFILE self ms:\n        ' + [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k2, t]) => `${(t / 1000).toFixed(1)} ${k2}`).join('\n        '));
    }
    if (cdp) {
      const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
      await cdp.send('Tracing.end');
      await done;
      // The renderer main thread: the one running the key events.
      const evts = trace.filter((e) => e.ph === 'X' || e.ph === 'B' || e.ph === 'E');
      const keyEv = evts.filter((e) => e.name === 'EventDispatch' && e.ph === 'X' && /^(keydown|keypress|beforeinput|input|keyup)$/.test(e.args?.data?.type || ''));
      const tid = keyEv[0]?.tid;
      const main = evts.filter((e) => e.tid === tid && e.ph === 'X');
      const spans = main.filter((e) => e.name === 'EventDispatch' || e.name === 'FunctionCall' || e.name === 'TimerFire' || e.name === 'FireAnimationFrame');
      const scriptSpans = main.filter((e) => e.name === 'EventDispatch' || e.name === 'FunctionCall' || e.name === 'TimerFire');
      const inside = (e, set) => set.some((s) => e.ts >= s.ts && e.ts + (e.dur || 0) <= s.ts + s.dur);
      const recalc = main.filter((e) => e.name === 'UpdateLayoutTree');
      const layout = main.filter((e) => e.name === 'Layout');
      const fRecalc = recalc.filter((e) => inside(e, scriptSpans));
      const fLayout = layout.filter((e) => inside(e, scriptSpans));
      const ms = (xs) => xs.reduce((s, e) => s + (e.dur || 0), 0) / 1000;
      const per = (n) => Math.round((n / KEYS) * 100) / 100;
      if (process.env.PROFILE === '1') {
        const by = new Map();
        for (const e of main) { const kk = e.name === 'EventDispatch' ? `EventDispatch:${e.args?.data?.type}` : e.name; const v = by.get(kk) || [0, 0]; v[0] += e.dur || 0; v[1] += 1; by.set(kk, v); }
        const ec = (xs) => xs.map((e) => e.args?.elementCount ?? e.args?.data?.elementCount ?? '?');
        console.log('      TRACE forced recalc elementCount (first 30):', ec(fRecalc).slice(0, 30).join(','));
        console.log('      TRACE all recalc elementCount (first 40):', ec(recalc).slice(0, 40).join(','));
        console.log('      TRACE forced layout dirty/total:', fLayout.slice(0, 10).map((e) => JSON.stringify(e.args?.beginData ? { d: e.args.beginData.dirtyObjects, t: e.args.beginData.totalObjects } : e.args)).join(' '));
        console.log('      TRACE ms/key by event:\n        ' + [...by].sort((a, b) => b[1][0] - a[1][0]).slice(0, 30).map(([n, [d, c]]) => `${(d / 1000 / KEYS).toFixed(2)} ms  x${(c / KEYS).toFixed(1)}  ${n}`).join('\n        '));
      }
      forced = {
        styleRecalcsPerKey: per(recalc.length), forcedStyleRecalcsPerKey: per(fRecalc.length), forcedStyleMsPerKey: per(ms(fRecalc)),
        layoutsPerKey: per(layout.length), forcedLayoutsPerKey: per(fLayout.length), forcedLayoutMsPerKey: per(ms(fLayout)),
        styleMsPerKey: per(ms(recalc)), layoutMsPerKey: per(ms(layout)), spans: spans.length,
      };
    }
    const done = k.keys.filter((r) => r.sync != null);
    const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null);
    const p95 = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] * 100) / 100 : null; };
    const row = {
      keys: k.keys.length,
      syncMsPerKey: avg(done.map((r) => r.sync)), syncMsP95: p95(done.map((r) => r.sync)),
      frameMsPerKey: avg(k.keys.filter((r) => r.frame != null).map((r) => r.frame)),
      layoutReadsPerKey: Math.round((k.reads / KEYS) * 100) / 100, layoutReadMsPerKey: Math.round((k.readMs / KEYS) * 100) / 100,
      reactCommitsPerKey: Math.round((k.commits / KEYS) * 100) / 100,
      appleSpellCpuMsPerKey: Math.round((spellMs / KEYS) * 100) / 100, appleSpellCpuPct: Math.round((spellMs / wallMs) * 1000) / 10,
      spellcheck: process.env.EXPERIMENT !== 'nospell',
      ...(forced || {}),
      ...(k.census ? { census: Object.fromEntries(Object.entries(k.census).sort((a, b) => b[1] - a[1]).slice(0, 40)) } : {}),
    };
    (numbers.keyCost ||= {})[engineName] = row;
    console.log(`      keyCost ${engineName}: ${JSON.stringify(row)}`);
  } finally {
    await page.keyboard.press('Meta+a').catch(() => {}); await page.keyboard.press('Backspace').catch(() => {});
    await ctx.close();
    await browser.close();
  }
}

/** Diagnosis (DIAG_TIMING=1): time every rAF callback and pointer/mouse listener, by source. */
const TIMING = `
  (() => {
    const t = new Map(); window.__dcTiming = t; window.__dcTimingOn = false;
    const key = (fn, kind) => kind + ' ' + String(fn).replace(/\\s+/g, ' ').slice(0, 90);
    const wrap = (fn, kind) => function (...a) {
      if (!window.__dcTimingOn) return fn.apply(this, a);
      const s = performance.now(); try { return fn.apply(this, a); } finally {
        const k = key(fn, kind); const e = t.get(k) || [0, 0]; e[0] += performance.now() - s; e[1] += 1; t.set(k, e); }
    };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf(wrap(cb, 'raf'));
    const add = EventTarget.prototype.addEventListener;
    const wrapped = new WeakMap();
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      if (typeof fn === 'function' && /^(pointer|mouse)/.test(type)) { let w = wrapped.get(fn); if (!w) { w = wrap(fn, type); wrapped.set(fn, w); } return add.call(this, type, w, opts); }
      return add.call(this, type, fn, opts);
    };
    const rem = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.removeEventListener = function (type, fn, opts) { return rem.call(this, type, (typeof fn === 'function' && wrapped.get(fn)) || fn, opts); };
  })();
`;

async function sectionDrag(server, engineName) {
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  const ctx = await browser.newContext({ viewport: { width: 2400, height: 1200 }, colorScheme: 'dark' });
  if (process.env.DIAG_TIMING === '1') await ctx.addInitScript(TIMING);
  const page = await ctx.newPage();
  const out = {};
  try {
    if (process.env.EXPERIMENT_LIGHT === '1') await fetch(`${server.base}/api/launcher/agent-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ merge: true, patch: { lightMode: 'on' } }) });
    await openVault(page, server.base, 'proj');
    await untilPanes(page, 5, 60_000);
    await page.waitForTimeout(4_000);
    if (!(await page.locator('.agent-pane-tabbar .agent-tab:visible').count())) throw new Error('the chat surface did not show its tabs');
    const tabs = page.locator('.agent-pane-tabbar .agent-tab:visible');
    const src = await tabs.nth(0).boundingBox();
    const panes = await page.locator('.agent-panes > .agent-pane').evaluateAll((els) => els.slice(0, 5).map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }));
    await page.evaluate(() => {
      const s = { frames: [], done: false }; window.__dcDrag = s;
      const tick = (t) => { if (s.done) return; s.frames.push(t); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    });
    const mark = (l) => page.evaluate((x) => { (window.__dcMarks ||= []).push([x, performance.now()]); }, l);
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    if (process.env.EXPERIMENT_CSS) await page.addStyleTag({ content: process.env.EXPERIMENT_CSS });
    if (process.env.DIAG_TIMING === '1') await page.evaluate(() => { window.__dcTiming.clear(); window.__dcTimingOn = true; });
    await mark('down');
    await page.mouse.down();
    if (process.env.EXPERIMENT_SHIELD === '1') {
      await page.mouse.move(src.x + src.width / 2 + 8, src.y + src.height / 2, { steps: 2 });
      await page.evaluate(() => { const d = document.createElement('div'); d.id = '__dcShield'; d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:transparent'; document.body.appendChild(d); });
    }
    let highlighted = 0; let probes = 0; let zoneSeen = false;
    for (const [pi, p] of panes.slice(1).entries()) {
      for (const fx of [0.15, 0.5, 0.85]) {
        await mark(`move p${pi + 1} ${fx}`);
        await page.mouse.move(p.x + p.w * fx, p.y + p.h * 0.5, { steps: 6 });
        await page.waitForTimeout(60);
        probes += 1;
        const st = await page.evaluate(() => ({ layer: !!document.querySelector('.agent-pane-droplayer'), over: document.querySelectorAll('[data-over="true"]').length }));
        if (st.layer) zoneSeen = true;
        if (st.over > 0) highlighted += 1;
      }
    }
    await page.mouse.move(panes[2].x + panes[2].w * 0.5, panes[2].y + panes[2].h * 0.5, { steps: 4 });
    out.selectionChars = await page.evaluate(() => String(getSelection() || '').length);
    const beforeEsc = await page.evaluate(() => ({ layer: !!document.querySelector('.agent-pane-droplayer'), tabs: [...document.querySelectorAll('.agent-pane-tabbar .agent-tab')].filter((e) => e.getClientRects().length).length }));
    await page.keyboard.press('Escape');
    const afterEsc = await page.evaluate(() => ({ layer: !!document.querySelector('.agent-pane-droplayer'), tabs: [...document.querySelectorAll('.agent-pane-tabbar .agent-tab')].filter((e) => e.getClientRects().length).length }));
    out.escape = { beforeEsc, afterEsc };
    await page.mouse.up();
    await page.waitForTimeout(400);
    out.escape.afterUp = await page.evaluate(() => [...document.querySelectorAll('.agent-pane-tabbar .agent-tab')].filter((e) => e.getClientRects().length).length);
    check(`AC9 [${engineName}] Escape mid-drag cancels the drag and leaves the chat surface open`, !afterEsc.layer && afterEsc.tabs > 0 && out.escape.afterUp > 0, JSON.stringify(out.escape));
    await mark('end');
    if (process.env.DIAG_TIMING === '1') console.log(`      DIAG timing[${engineName}]:\n        ` + (await page.evaluate(() => { window.__dcTimingOn = false; return [...window.__dcTiming].sort((a, b) => b[1][0] - a[1][0]).slice(0, 10).map(([k, [ms, n]]) => `${Math.round(ms)}ms x${n} ${k}`); })).join('\n        '));
    const deltas = await page.evaluate(() => { const s = window.__dcDrag; s.done = true; const d = []; for (let i = 1; i < s.frames.length; i += 1) d.push(s.frames[i] - s.frames[i - 1]); return d; });
    if (process.env.DIAG === '1') console.log(`      DIAG gaps[${engineName}]:`, JSON.stringify(await page.evaluate(() => {
      const s = window.__dcDrag; const m = window.__dcMarks || []; const out = [];
      for (let i = 1; i < s.frames.length; i += 1) {
        const g = s.frames[i] - s.frames[i - 1];
        if (g > 40) { const before = m.filter(([, t]) => t <= s.frames[i - 1]).pop(); out.push([Math.round(g), before ? before[0] : 'start', Math.round(s.frames[i - 1] - (before ? before[1] : 0))]); }
      }
      return out;
    })));
    const layerAfterEscape = await page.evaluate(() => !!document.querySelector('.agent-pane-droplayer'));
    // A full drop (split right of pane 2), then the layer must be gone.
    const s2 = await tabs.nth(0).boundingBox();
    await page.mouse.move(s2.x + s2.width / 2, s2.y + s2.height / 2);
    await page.mouse.down();
    await page.mouse.move(panes[3].x + panes[3].w * 0.9, panes[3].y + panes[3].h * 0.5, { steps: 12 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(600);
    const layerAfterDrop = await page.evaluate(() => !!document.querySelector('.agent-pane-droplayer'));
    out.maxRafGapMs = Math.round(Math.max(0, ...deltas));
    out.highlightedProbes = `${highlighted}/${probes}`;
    out.dropLayerSeen = zoneSeen;
    out.layerAfterEscape = layerAfterEscape;
    out.layerAfterDrop = layerAfterDrop;
    await page.screenshot({ path: join(OUT, `drag-${engineName}.png`) });
    console.log(`      drag[${engineName}]: ${JSON.stringify(out)}`);
    check(`AC9 [${engineName}] max rAF gap during a tab drag <= 50 ms`, out.maxRafGapMs <= 50, `${out.maxRafGapMs} ms`);
    check(`AC9 [${engineName}] the zone under the pointer is highlighted`, highlighted === probes, out.highlightedProbes);
    check(`AC9 [${engineName}] no drop layer after Escape / release`, !layerAfterEscape && !layerAfterDrop, JSON.stringify({ layerAfterEscape, layerAfterDrop }));
  } catch (e) {
    out.error = String(e.message || e);
    await page.screenshot({ path: join(OUT, `drag-${engineName}-failed.png`) }).catch(() => {});
    console.log(`      drag[${engineName}] failed: ${out.error}`);
    check(`AC9 [${engineName}] drag measured`, false, out.error);
  } finally {
    await browser.close();
  }
  (numbers.drag ||= {})[engineName] = out;
}

/**
 * g2: the four drops give the SAME layout as the old native drag (split right, split left, add
 * as a tab, reorder), and a Finder file dropped on a pane still lands in that pane's composer.
 * Chromium, five panes (vault `five`); each phase records its layouts, AFTER compares with BEFORE.
 */
async function sectionDropLayouts(server, browser) {
  const ctx = await browser.newContext({ viewport: { width: 2400, height: 1200 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const out = { layouts: [] };
  try {
    await openVault(page, server.base, 'five');
    await untilPanes(page, 5, 60_000);
    await page.waitForTimeout(6_000);
    /** Every tab strip left to right: its tab titles, the active one marked with `*`. */
    const layout = () => page.evaluate(() => [...document.querySelectorAll('.agent-pane-tabbar')]
      .filter((b) => b.getClientRects().length)
      .map((b) => ({ x: b.getBoundingClientRect().left, tabs: [...b.querySelectorAll('.agent-tab')].map((t) => `${t.classList.contains('active') ? '*' : ''}${t.querySelector('.agent-tab-title')?.textContent?.trim()}`) }))
      .sort((a, c) => a.x - c.x).map((b) => b.tabs.join('+')).join(' | '));
    const paneRects = () => page.locator('.agent-panes > .agent-pane').evaluateAll((els) => els
      .map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })
      .filter((r) => r.w > 0).sort((a, b) => a.x - b.x));
    const tabBox = async (title) => page.locator('.agent-pane-tabbar .agent-tab:visible', { has: page.locator('.agent-tab-title', { hasText: new RegExp(`^${title}$`) }) }).first().boundingBox();
    const drag = async (from, x, y) => {
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 14 });
      await page.waitForTimeout(120);
      await page.mouse.up();
      await page.waitForTimeout(1_500);
    };
    out.layouts.push(['start', await layout()]);
    let r = await paneRects();
    await drag(await tabBox('Long chat 6'), r[1].x + r[1].w * 0.85, r[1].y + r[1].h / 2);
    out.layouts.push(['split right', await layout()]);
    r = await paneRects();
    await drag(await tabBox('Long chat 10'), r[0].x + r[0].w * 0.15, r[0].y + r[0].h / 2);
    out.layouts.push(['split left', await layout()]);
    r = await paneRects();
    await drag(await tabBox('Long chat 8'), r[1].x + r[1].w * 0.5, r[1].y + r[1].h / 2);
    out.layouts.push(['add as tab', await layout()]);
    // Reorder: the strip holding two tabs now — its second tab dropped before its first.
    const strip = await page.evaluate(() => [...document.querySelectorAll('.agent-pane-tabbar')].filter((b) => b.getClientRects().length && b.querySelectorAll('.agent-tab').length > 1)
      .map((b) => [...b.querySelectorAll('.agent-tab-title')].map((t) => t.textContent.trim()))[0] || null);
    if (strip) {
      const first = await tabBox(strip[0]);
      await drag(await tabBox(strip[1]), first.x + 4, first.y + first.height / 2);
    }
    out.layouts.push(['reorder', await layout()]);
    // A Finder file onto the third pane: the composer of that pane names it.
    r = await paneRects();
    const px = r[2].x + r[2].w / 2; const py = r[2].y + r[2].h * 0.4;
    await page.evaluate(([x, y]) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped from Finder'], 'finder-note.txt', { type: 'text/plain' }));
      const at = document.elementFromPoint(x, y);
      for (const type of ['dragenter', 'dragover', 'drop']) at.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    }, [px, py]);
    await page.waitForTimeout(3_000);
    out.fileDrop = await page.evaluate(() => [...document.querySelectorAll('.chat-cmp-attachment-name')].some((e) => e.textContent.includes('finder-note'))
      || [...document.querySelectorAll('textarea, [contenteditable]')].some((e) => (e.value || e.textContent || '').includes('finder-note'))
      || document.body.innerText.includes('finder-note'));
    await page.screenshot({ path: join(OUT, 'drop-layouts.png') });
  } catch (e) {
    out.error = String(e.message || e);
  } finally {
    await ctx.close();
  }
  numbers.dropLayouts = out;
  console.log(`      drops: ${JSON.stringify(out)}`);
  const before = readBefore()?.dropLayouts;
  if (before) {
    const same = JSON.stringify(before.layouts) === JSON.stringify(out.layouts);
    check('AC9 split right / split left / add as tab / reorder give the same layout as before', same && !out.error, same ? out.layouts.map(([k, v]) => `${k}: ${v}`).join(' ; ') : `BEFORE ${JSON.stringify(before.layouts)} AFTER ${JSON.stringify(out.layouts)}`);
    check('AC9 a Finder file dropped on a pane still lands in its composer', out.fileDrop === true && before.fileDrop === true, JSON.stringify({ before: before.fileDrop, after: out.fileDrop }));
  }
}

/**
 * shots: what the owner sees, BEFORE beside AFTER — the project tab strip and a composer, light
 * and dark, at a desktop (1440) and a phone (390) width, and (AFTER) the Settings Light mode
 * row. Light mode is pinned off (the fixture), except for the Settings row's own shots.
 */
async function sectionShots(server, browser) {
  const dir = join(OUT, 'shots');
  mkdirSync(dir, { recursive: true });
  const errors = [];
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
      await ctx.addInitScript((t) => { try { localStorage.setItem('dreamcontext-theme', t); } catch {} }, theme);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`${theme}/${width}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`${theme}/${width}: ${m.text().slice(0, 160)}`); });
      await openVault(page, server.base, 'five');
      await page.waitForTimeout(8_000);
      await page.screenshot({ path: join(dir, `${theme}-${width}-surface.png`) });
      const strip = page.locator('.project-tabs-track').first();
      if (await strip.count()) await strip.screenshot({ path: join(dir, `${theme}-${width}-tab-strip.png`) }).catch(() => {});
      const cmp = page.locator('.chat-cmp:visible').first();
      if (await cmp.count()) {
        await page.locator('.chat-cmp-input:visible').first().click().catch(() => {});
        await page.keyboard.type('Typing feels instant here', { delay: 10 });
        await cmp.screenshot({ path: join(dir, `${theme}-${width}-composer.png`) }).catch(() => {});
      }
      await ctx.close();
    }
  }
  numbers.shots = { dir, consoleErrors: errors.slice(0, 20) };
  console.log(`      shots: ${dir} · console errors ${errors.length}${errors.length ? `: ${JSON.stringify(errors.slice(0, 5))}` : ''}`);
}

/**
 * The Super Agent's phase (task chat-gets-a-super-agent-mode…, AC12): the main vault's ten live
 * panes handed over (ten children ≥ the plan's 8), the stage filled to the 12-card cap by the
 * agent's own verbs (two web cards, one chat as a half page: plan-r8), then idle. Server busy and per-handler time over 30 s; requests the agent
 * cards make (0 — they read the live ChatSession); mounted chats, live iframes, live WebGL; and
 * a hidden window's super requests over 2 minutes (0 — everything is pushed).
 */
async function sectionSuper(server, browser) {
  const ctx = await browser.newContext({ viewport: { width: 2560, height: 1300 }, colorScheme: 'dark', reducedMotion: 'no-preference' });
  await ctx.addInitScript(SPY);
  const page = await ctx.newPage();
  const reqs = requestCounter(page);
  await openVault(page, server.base, 'proj');
  await untilPanes(page, PANES);
  await setFocused(page);
  await page.waitForTimeout(5_000);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  for (let i = 0; i < 60 && !(await page.locator('[data-testid="super-surface"]:visible').count()); i += 1) await page.waitForTimeout(250);
  const owner = (path, body) => page.evaluate(async ([p, b]) => {
    const r = await fetch(p, b ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'proj' }, body: JSON.stringify(b) } : { headers: { 'x-dreamcontext-vault': 'proj' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [path, body]);
  // The owner tells Claude to arrange the stage; it opens two web cards and puts a chat side
  // by side with its own verbs (the owner's route only patches cards that exist).
  for (let i = 0; i < 80 && !(await page.locator('[data-super-slot="centre"] .chat-cmp-input').count()); i += 1) await page.waitForTimeout(250);
  const composer = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
  await composer.click();
  await composer.fill('GO-SUPER-SETUP');
  await page.keyboard.press('Enter');
  let st = null;
  for (let i = 0; i < 120; i += 1) {
    st = (await owner('/api/super/state')).body;
    if ((st?.containers ?? []).filter((c) => c.kind === 'web').length >= 2 && (st?.containers ?? []).filter((c) => c.kind === 'browser').length >= 2 && st?.view?.mode === 'half') break;
    await page.waitForTimeout(500);
  }
  const children = Object.keys(st?.children ?? {});
  await page.waitForTimeout(20_000);
  const containers = (st?.containers ?? []).length;
  const drawn = await page.locator('[data-testid="super-container"]').count();
  numbers.super = { children: children.length, containers, drawn, view: st?.view?.mode ?? null, webs: (st?.containers ?? []).filter((c) => c.kind === 'web').length, browsers: (st?.containers ?? []).filter((c) => c.kind === 'browser').length };
  console.log(`      super: handed over, ${children.length} children, ${containers} cards (${drawn} drawn, view ${numbers.super.view}, ${numbers.super.webs} web)`);
  check('AC12 super: the stage holds 14 cards (12 floating, 2 in Others) with 2 web, 2 live browser cards and a half page', containers === 14 && numbers.super.webs === 2 && numbers.super.browsers === 2 && numbers.super.view === 'half', JSON.stringify(numbers.super));
  await page.screenshot({ path: join(OUT, 'super-handed-over.png') });

  const t0 = Date.now();
  const prof = await cpuProfile(server.inspect, 30_000);
  const during = reqs.since(t0);
  const cardReqs = during.filter((x) => children.some((c) => x.path.includes(c)));
  const superReqs = during.filter((x) => x.path.startsWith('/api/super/'));
  const mounted = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="super-surface"]');
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      chatsShown: surface ? [...surface.querySelectorAll('.chat-scroll')].filter(vis).length : -1,
      chatsInDom: document.querySelectorAll('.chat-scroll').length,
      iframes: surface ? [...surface.querySelectorAll('iframe')].filter((f) => f.isConnected).length : -1,
      liveBrowsers: surface ? surface.querySelectorAll('[data-kind="browser"] [data-live]').length : -1,
      browserCards: surface ? surface.querySelectorAll('[data-kind="browser"]').length : -1,
      webgl: window.__dcGl.filter(({ canvas, ctx: c }) => canvas.isConnected && !c.isContextLost()).length,
      backdrop: [...document.querySelectorAll('[data-testid="super-surface"] *')].filter((el) => { const v = getComputedStyle(el).backdropFilter; return v && v !== 'none'; }).length,
    };
  });
  Object.assign(numbers.super, { server: prof, idleRequests: byPath(during), cardRequests: cardReqs.length, superRequestsWhileIdle: superReqs.length, ...mounted });
  console.log(`      super idle: busy ${prof.busyPct}% handlers ${JSON.stringify(prof.handlers)} requests ${JSON.stringify(byPath(during))} mounted ${JSON.stringify(mounted)}`);
  const worst = Object.values(prof.handlers)[0] ?? 0;
  check('AC12 super: server busy <= 10 % (handed over, idle 30 s)', prof.busyPct <= 10, `${prof.busyPct}%`);
  check('AC12 super: no handler > 3 %', worst <= 3, JSON.stringify(prof.handlers));
  check('AC12 super: 0 requests per agent container', cardReqs.length === 0, JSON.stringify(cardReqs.slice(0, 5)));
  check('AC12 super: 0 super requests while idle (state is pushed)', superReqs.length === 0, JSON.stringify(byPath(superReqs)));
  check('AC12 super: <= 1 mounted child chat besides the centre', mounted.chatsShown <= 2, JSON.stringify(mounted));
  check('AC12 super: <= 2 live iframes', mounted.iframes <= 2, `${mounted.iframes}`);
  check('AC7 super: <= 2 live browser cards re-render (the rest frozen)', mounted.liveBrowsers <= 2, JSON.stringify({ live: mounted.liveBrowsers, cards: mounted.browserCards }));
  check('AC12 super: WebGL contexts <= 2', mounted.webgl <= 2, `${mounted.webgl}`);
  check('AC12 super: no backdrop-filter in the surface', mounted.backdrop === 0, `${mounted.backdrop}`);

  await setHidden(page, true);
  const h0 = Date.now();
  await page.waitForTimeout(120_000);
  const hidden = reqs.since(h0).filter((x) => x.path.startsWith('/api/super/'));
  numbers.super.hiddenSuperRequests2min = hidden.length;
  check('AC12 super: hidden window -> 0 super requests over 2 min', hidden.length === 0, JSON.stringify(byPath(hidden)));
  await setHidden(page, false);
  await ctx.close();
}

async function sectionWebgl(server, browser) {
  writeAgentUi('off', false);
  const ctx = await browser.newContext({ viewport: { width: 2000, height: 1100 }, colorScheme: 'dark' });
  await ctx.addInitScript(SPY);
  const page = await ctx.newPage();
  await openVault(page, server.base, 'term');
  await page.waitForTimeout(4_000);
  // Four Terminal (legacy) panes the way a person opens them: start one, then ⌘D splits.
  const xterms = () => page.evaluate(() => document.querySelectorAll('.xterm').length);
  if (!(await xterms())) await page.getByRole('button', { name: /Start agent in app/ }).first().click().catch(() => {});
  for (let i = 0; i < 40 && (await xterms()) < 1; i += 1) await page.waitForTimeout(250);
  for (let n = 1; n < 4; n += 1) {
    await page.locator('.xterm').last().click().catch(() => {});
    await page.keyboard.press('Meta+d');
    for (let i = 0; i < 40 && (await xterms()) <= n; i += 1) await page.waitForTimeout(250);
  }
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: join(OUT, 'webgl-4-terminals.png') });
  const live = () => page.evaluate(() => window.__dcGl.filter(({ canvas, ctx: c }) => canvas.isConnected && !c.isContextLost()).length);
  const created = await page.evaluate(() => window.__dcGl.length);
  const atRest = await live();
  numbers.webgl = { terminals: await page.evaluate(() => document.querySelectorAll('.xterm').length), created, live: atRest };
  console.log(`      webgl: ${JSON.stringify(numbers.webgl)}`);
  check('AC10 with 4 terminal panes <= 2 live WebGL contexts', atRest <= 2, `${atRest} live of ${created} created`);
  writeAgentUi('off', true);
  await ctx.close();
}

async function sectionNotch(server, browser) {
  const created = await fetch(`${server.base}/api/assistant/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nova', character: 'Terse.' }) });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const kids0 = claudeChildren(server.srv.pid).length;
  await page.goto(`${server.base}/?assistant=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8_000);
  const kids = claudeChildren(server.srv.pid).length - kids0;
  await page.evaluate(() => {
    window.__dcMut = 0;
    new MutationObserver((l) => { window.__dcMut += l.length; }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.waitForTimeout(60_000);
  const mutations = await page.evaluate(() => window.__dcMut);
  numbers.notch = { assistantCreated: created.status, claudeChildrenAtBoot: kids, mutationsPerMin: mutations };
  console.log(`      notch: ${JSON.stringify(numbers.notch)}`);
  check('AC11 0 claude children at notch boot', kids === 0, `${kids}`);
  check('AC11 an idle notch makes 0 DOM mutations per minute', mutations === 0, `${mutations}`);
  await ctx.close();
}

// ─── stream7: seven chats streaming at once (K3 paint, K4 server memory) ────────────────
/** One V8 heap snapshot of the server over the inspector, written to `file`, and its top
 *  holders by constructor (self size), plus the largest strings' heads. */
async function heapSnapshot(inspectPort, file) {
  const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl, { maxPayload: 1024 * MB });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0;
  const pending = new Map();
  const fd = openSync(file, 'w');
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.method === 'HeapProfiler.addHeapSnapshotChunk') { writeSync(fd, m.params.chunk); return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('HeapProfiler.enable');
  await send('HeapProfiler.collectGarbage');
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  ws.close();
  closeSync(fd);
  return summarizeHeap(JSON.parse(readFileSync(file, 'utf-8')));
}

/** Server allocation sampling over `ms` — INCLUDING objects GC already collected, so churn
 *  shows up, not just what survives. Top allocating functions (MB allocated, sampled). */
async function allocationSampling(inspectPort, ms) {
  const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl, { maxPayload: 1024 * MB });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('HeapProfiler.enable');
  await send('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await sleep(ms);
  const { profile } = await send('HeapProfiler.stopSampling');
  ws.close();
  const self = new Map();
  const incl = new Map();
  const walk = (node, stack) => {
    const cf = node.callFrame;
    const key = `${cf.functionName || '(anon)'} ${(cf.url || '').split('/').pop()}:${cf.lineNumber}`;
    self.set(key, (self.get(key) || 0) + node.selfSize);
    let sub = node.selfSize;
    const next = [...stack, key];
    for (const c of node.children || []) sub += walk(c, next);
    if (!stack.includes(key)) incl.set(key, (incl.get(key) || 0) + sub);
    return sub;
  };
  const total = walk(profile.head, []);
  const mb = (b) => Math.round(b / MB * 10) / 10;
  return {
    allocatedMb: mb(total),
    topSelf: Object.fromEntries([...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, mb(v)])),
    topInclusive: Object.fromEntries([...incl].filter(([k]) => !/^\(root\)|^\(anon\) :-1/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, mb(v)])),
  };
}

/** The page's own JS profile (Chromium CDP) over `ms`: top self and inclusive functions. */
async function pageProfile(ctx, page, ms) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await page.waitForTimeout(ms);
  const { profile } = await cdp.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const self = new Map();
  const incl = new Map();
  const total = profile.endTime - profile.startTime;
  let idle = 0;
  profile.samples.forEach((sid, k) => {
    const dt = profile.timeDeltas[k] || 0;
    const n = byId.get(sid);
    const key = (x) => `${x.callFrame.functionName || '(anon)'} ${(x.callFrame.url || '').split('/').pop().split('?')[0]}:${x.callFrame.lineNumber}`;
    if (n.callFrame.functionName === '(idle)') { idle += dt; return; }
    self.set(key(n), (self.get(key(n)) || 0) + dt);
    const seen = new Set();
    for (let cur = sid; cur !== undefined; cur = parent.get(cur)) {
      const k2 = key(byId.get(cur));
      if (seen.has(k2)) continue;
      seen.add(k2);
      incl.set(k2, (incl.get(k2) || 0) + dt);
    }
  });
  const pct = (t) => Math.round((t / total) * 1000) / 10;
  return {
    busyPct: pct(total - idle),
    topSelf: Object.fromEntries([...self].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => [k, pct(v)])),
    topInclusive: Object.fromEntries([...incl].filter(([k]) => !/^\(root\)|^\(program\)|^\(anon\) :-1/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, pct(v)])),
  };
}

function summarizeHeap(snap) {
  const f = snap.snapshot.meta.node_fields;
  const types = snap.snapshot.meta.node_types[0];
  const N = f.length;
  const iType = f.indexOf('type'), iName = f.indexOf('name'), iSelf = f.indexOf('self_size');
  const by = new Map();
  const bigStrings = [];
  let total = 0;
  for (let i = 0; i < snap.nodes.length; i += N) {
    const type = types[snap.nodes[i + iType]];
    const size = snap.nodes[i + iSelf];
    total += size;
    const name = type === 'object' || type === 'closure' ? snap.strings[snap.nodes[i + iName]] : `(${type})`;
    by.set(name, (by.get(name) || 0) + size);
    if ((type === 'string' || type === 'concatenated string' || type === 'sliced string') && size > 256 * 1024) {
      bigStrings.push({ kb: Math.round(size / 1024), head: String(snap.strings[snap.nodes[i + iName]] || '').slice(0, 90) });
    }
  }
  const mb = (b) => Math.round(b / MB * 10) / 10;
  return {
    totalMb: mb(total),
    top: Object.fromEntries([...by].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => [k, mb(v)])),
    bigStrings: bigStrings.sort((a, b) => b.kb - a.kb).slice(0, 12),
  };
}

/** Native stacks of the browser's WebContent process (macOS `sample`): how many samples sit in
 *  the text-painting path the CPU RCA found (K3). */
function sampleWebContent(engine, seconds, file) {
  if (process.platform !== 'darwin' || engine !== 'webkit') return null;
  const ps = spawnSync('ps', ['-axo', 'pid=,%cpu=,command='], { encoding: 'utf-8' }).stdout.split('\n');
  const rows = ps.map((l) => l.trim().match(/^(\d+)\s+([\d.]+)\s+(.*)$/)).filter(Boolean)
    .filter((m) => /ms-playwright\/webkit/.test(m[3]) && /WebContent/.test(m[3]))
    .sort((a, b) => Number(b[2]) - Number(a[2]));
  if (!rows.length) return null;
  spawnSync('sample', [rows[0][1], String(seconds), '-file', file], { encoding: 'utf-8' });
  const text = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  // `sample`'s call graph prints each frame with its INCLUSIVE count first: take the largest
  // count seen on any line naming the symbol (its outermost occurrence).
  const inclusive = (sym) => {
    let best = 0;
    for (const line of text.split('\n')) {
      if (!line.includes(sym)) continue;
      const m = line.match(/^[\s+!:|]*(\d+)\s/);
      if (m) best = Math.max(best, Number(m[1]));
    }
    return best;
  };
  const main = text.match(/Thread_\d+\s+DispatchQueue_1: com\.apple\.main-thread[^\n]*\n\s*\+?\s*(\d+)/);
  return {
    pid: Number(rows[0][1]),
    mainThreadSamples: main ? Number(main[1]) : null,
    updateRendering: inclusive('updateRendering'),
    textBoxPaint: inclusive('TextBoxPainter'),
    layoutSimpleText: inclusive('layoutSimpleText'),
    widthIteratorAdvance: inclusive('WidthIterator::advance'),
    styleUpdate: inclusive('updateStyleIfNeeded'),
    layout: inclusive('LocalFrameView::layout'),
  };
}

const STREAMERS = 7;

async function sectionStream(server, engine) {
  const browserType = engine === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch();
  const ctx = await browser.newContext({ viewport: { width: 2000, height: 1200 }, colorScheme: 'dark', reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  try {
    await openVault(page, server.base, 'proj');
    await untilPanes(page, PANES, 90_000);
    await page.waitForTimeout(Number(process.env.SETTLE_MS || 45_000));
    await setFocused(page);
    if (process.env.STREAM_HIDE) {
      await page.addStyleTag({ content: `${process.env.STREAM_HIDE} { display: none !important; }` });
    }
    if (process.env.STREAM_CSS) await page.addStyleTag({ content: process.env.STREAM_CSS });
    const rssIdle = rssKb(server.srv.pid);
    const heapIdle = process.env.HEAP === '0' ? null : await heapSnapshot(server.inspect, join(OUT, 'heap-idle.heapsnapshot'));

    // Seven panes start a long answer, each through its own composer.
    const panes = page.locator('.agent-panes > .agent-pane');
    let started = 0;
    for (let i = 0; i < STREAMERS; i += 1) {
      const input = panes.nth(i).locator('.chat-cmp-input');
      if (!(await input.count())) continue;
      await input.first().click();
      await page.keyboard.type('GO-STREAM');
      await page.keyboard.press('Enter');
      started += 1;
      await page.waitForTimeout(150);
    }
    const streamMs = Number(process.env.DC_IDLE_STREAM_MS || 60_000);
    await page.waitForTimeout(5_000);
    const streaming = await page.evaluate(() => document.querySelectorAll('.chat-msg-assistant-row[data-done="false"]').length);

    // Frames + RSS over a 20 s window in the middle of the stream.
    await page.evaluate(() => {
      window.__dcFrames = [];
      window.__dcFramesOn = true;
      let last = performance.now();
      const f = (t) => { window.__dcFrames.push(t - last); last = t; if (window.__dcFramesOn) requestAnimationFrame(f); };
      requestAnimationFrame(f);
    });
    const rss = [];
    const sampler = setInterval(() => rss.push(rssKb(server.srv.pid)), 1000);
    const allocP = process.env.ALLOC === '0' ? null : allocationSampling(server.inspect, 15_000);
    let jsProfile = null;
    const sampled = process.env.SAMPLE === '0' ? null : sampleWebContent(engine, 15, join(OUT, `sample-webcontent-${engine}.txt`));
    if (!sampled) {
      if (engine === 'chromium') jsProfile = await pageProfile(ctx, page, 15_000);
      else await page.waitForTimeout(15_000);
    }
    const alloc = allocP ? await allocP : null;
    await page.waitForTimeout(5_000);
    const frames = await page.evaluate(() => { window.__dcFramesOn = false; return window.__dcFrames; });
    const heapStreaming = process.env.HEAP === '0' ? null : await heapSnapshot(server.inspect, join(OUT, 'heap-streaming.heapsnapshot'));
    clearInterval(sampler);
    // Let every answer finish, then a quiet half minute: what the server keeps afterwards.
    // Started ~25 s ago (plus the snapshot): waiting one more stream length ends every answer
    // and leaves >= 25 s of quiet before the after-reading.
    await page.waitForTimeout(streamMs);
    const rssAfter = [];
    for (let i = 0; i < 10; i += 1) { rssAfter.push(rssKb(server.srv.pid)); await sleep(1000); }
    const heapAfter = process.env.HEAP === '0' ? null : await heapSnapshot(server.inspect, join(OUT, 'heap-after.heapsnapshot'));

    const sorted = [...frames].sort((a, b) => a - b);
    const pick = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0);
    const mb = (xs) => xs.filter(Boolean).map((k) => Math.round(k / 1024));
    const during = mb(rss);
    const after = mb(rssAfter);
    numbers[`stream7_${engine}`] = {
      started, streaming, hide: process.env.STREAM_HIDE || null, css: process.env.STREAM_CSS || null,
      frames: { n: frames.length, fps: Math.round(frames.length / 20), p50: pick(0.5), p95: pick(0.95), over50: frames.filter((d) => d > 50).length },
      webcontent: sampled,
      rssIdleMb: Math.round(rssIdle / 1024),
      rssStreamingMb: { min: Math.min(...during), max: Math.max(...during) },
      rssAfterMb: { min: Math.min(...after), max: Math.max(...after) },
      heapIdle, heapStreaming, heapAfter,
      serverAlloc15s: alloc, pageJs: jsProfile,
      pageErrors: errors.slice(0, 5),
    };
    console.log(`      stream7 ${engine}: ${JSON.stringify({ ...numbers[`stream7_${engine}`], heapIdle: heapIdle?.totalMb, heapStreaming: heapStreaming?.totalMb, heapAfter: heapAfter?.totalMb, serverAlloc15s: alloc?.allocatedMb, pageJs: jsProfile?.busyPct })}`);
    if (alloc) console.log(`      server alloc 15 s: ${JSON.stringify(alloc)}`);
    if (jsProfile) console.log(`      page js: ${JSON.stringify(jsProfile)}`);
    if (heapStreaming) console.log(`      heap top (streaming): ${JSON.stringify(heapStreaming.top)}`);
    if (heapAfter) console.log(`      heap top (after): ${JSON.stringify(heapAfter.top)}`);
    check('stream7 seven answers streamed at once', streaming >= STREAMERS, `${streaming}/${STREAMERS}`);
  } finally {
    await ctx.close();
    await browser.close();
  }
}

function readBefore() {
  const p = join(REPO, 'tmp', 'verify-idle-load', 'before', 'numbers.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

// ─── main ───────────────────────────────────────────────────────────────────────────────
let server = null;
let exitCode = 0;
try {
  console.log(`[idle-load] phase=${PHASE} dist=${DIST_INDEX}`);
  setupScratch();
  server = await startServer();
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    if (['a', 'c', 'c3', 'd', 'e', 'r', 'conn'].some((s) => SECTIONS.has(s))) await sectionsOnMain(server, browser);
    if (SECTIONS.has('f')) await sectionComposer(server, browser);
    if (SECTIONS.has('dump')) {
      const page = await browser.newPage({ viewport: { width: 2400, height: 1200 } });
      await openVault(page, server.base, 'proj');
      await untilPanes(page, 5, 60_000);
      await page.waitForTimeout(3_000);
      console.log(await page.evaluate(() => [...document.querySelectorAll('[class*="agent-tab"]')].slice(0, 6).map((e) => `${e.tagName}.${e.className} draggable=${e.getAttribute('draggable')} parent=${e.parentElement?.className}`).join('\n')));
      await page.screenshot({ path: join(OUT, 'dump-proj.png') });
      writeAgentUi('off', false);
      await openVault(page, server.base, 'term');
      await page.waitForTimeout(10_000);
      console.log(await page.evaluate(() => `xterm=${document.querySelectorAll('.xterm').length} panes=${document.querySelectorAll('.agent-pane').length} text=${(document.querySelector('.agent-panes')?.textContent || '').slice(0, 300)}`));
      await page.screenshot({ path: join(OUT, 'dump-term.png') });
      writeAgentUi('off', true);
    }
    if (SECTIONS.has('g2')) await sectionDropLayouts(server, browser);
    if (SECTIONS.has('shots')) await sectionShots(server, browser);
    if (SECTIONS.has('h')) await sectionWebgl(server, browser);
    if (SECTIONS.has('i')) await sectionNotch(server, browser);
    if (SECTIONS.has('super')) await sectionSuper(server, browser);
  } finally {
    await browser.close();
  }
  if (SECTIONS.has('g')) for (const e of ENGINES) await sectionDrag(server, e);
  if (SECTIONS.has('k')) for (const e of ENGINES) await sectionKeyCost(server, e);
  if (SECTIONS.has('stream7')) for (const e of (process.env.STREAM_ENGINES || 'webkit').split(',')) await sectionStream(server, e.trim());
} catch (e) {
  console.error(`[idle-load] aborted: ${e.stack || e}`);
  exitCode = 2;
} finally {
  await stopServer(server);
  mkdirSync(OUT, { recursive: true });
  const names = new Set(results.map((r) => r.name));
  numbers.checks = [...(PRIOR?.checks || []).filter((r) => !names.has(r.name)), ...results];
  writeFileSync(join(OUT, 'numbers.json'), `${JSON.stringify(numbers, null, 2)}\n`);
  console.log(`[idle-load] numbers → ${join(OUT, 'numbers.json')}`);
}
const failed = results.filter((r) => !r.ok);
if (AFTER && failed.length) { console.log(`[idle-load] ${failed.length} check(s) FAILED`); exitCode = exitCode || 1; }
process.exit(exitCode);
