#!/usr/bin/env node
/**
 * Why the Super Agent's stage stutters, measured (task super-agent-ekrani-kasmaz-olculen-3-sebep-
 * duzeltilir). Not a pass/fail suite: a MEASUREMENT, run once on the build before a change and once
 * after it, in the same scenario, so the two numbers.json files compare line by line.
 *
 *   npm run build && node scripts/verify/super-jank.mjs                 (DC_VERIFY_PHASE=after)
 *   DC_VERIFY_DIST=tmp/jank/dist-before/index.js DC_VERIFY_PHASE=before node scripts/verify/super-jank.mjs
 *
 * THE STAGE — the real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1) and the real
 * dashboard, a `claude` stand-in on PATH (no tokens). Eight long chats are handed over (eight
 * children); the Super Agent's stand-in then arranges a full stage with its own verbs: two chats in
 * Others, six chat tiles, a group of three tasks, a group of a note and a task, two insight tiles, a
 * local site card and a child's live browser card (12 floating tiles), 18 jobs in the pool (26 rows
 * in the job list) and its own open question at the head of the queue.
 *
 * THE SCENARIOS, each a 10 s window after a settle:
 *   idle        nothing streams
 *   stream      three children stream tokens (~30 deltas/s each) with a tool call every ~4 s
 *   list        the same, with the job list open
 *   drag        the same, while a floating tile is dragged around in circles
 *   type        the same, while the owner types into the centre's composer
 *   superStream the centre (the Super Agent's own chat) streams too
 * Chromium also runs stream / drag / type under a 4x CPU throttle (THROTTLE), the "heavy machine".
 * WebKit (the app's WKWebView engine) runs idle / stream / drag / type.
 *
 * PER WINDOW: frame gaps (rAF: p50 / p95 / max, frames over 33 ms and 50 ms), long tasks (Chromium),
 * input event durations while typing (Event Timing, Chromium), React commits (a DevTools-hook stub
 * counts every commit; CENSUS=1 also names the components that re-rendered — use an unminified
 * build for names), WebSocket frames received per second, DOM nodes (document and stage), JS heap,
 * and Chromium's own Script / Layout / Style time (CDP Performance.getMetrics). TRACE=1 adds a
 * devtools.timeline trace per Chromium window, summed by event name (paint, raster, composite).
 *
 * DIAGNOSIS (how the three causes were found; Chromium):
 *   PROFILE=1      a CPU profile per window: self time by function, inclusive time by component,
 *                  and who calls the forced layout reads (clientHeight / scrollHeight).
 *   EXPERIMENT=…   take one suspect off the page before measuring: noanim (every animation and
 *                  transition), notiles (the floating cards), detachgarage (the hidden chats'
 *                  garage), nohas (every :has() rule), drop:<text> (the CSS rules containing it).
 *   SHOTS=1        only the stage's screenshots (idle, then streaming), at VIEW_W x VIEW_H.
 *
 * Results of the run that found them: the task's Technical Details (before / after table).
 * Nothing here is published: the vault, the chats and the tasks are generated and fictional.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { PHASE, distIndex, scratchDir, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);
const SCRATCH = scratchDir('dc-verify-super-jank');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const OUT = shotsDir(REPO, 'super-jank');
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const THROTTLE = Number(process.env.THROTTLE || 4);
const WINDOW_MS = Number(process.env.WINDOW_MS || 10_000);
const CENSUS = process.env.CENSUS === '1';
const TRACE = process.env.TRACE === '1';
const PROFILE = process.env.PROFILE === '1';
const ONLY = process.env.SCENARIOS ? new Set(process.env.SCENARIOS.split(',').map((s) => s.trim())) : null;
const PANES = 8;
const STREAMERS = 3;
const POOL = 18;
const MB = 1024 * 1024;
const VIEW = { width: Number(process.env.VIEW_W || 1800), height: Number(process.env.VIEW_H || 1130) };
/** SHOTS=1: only the stage's screenshots (idle, then three children streaming), no windows. */
const SHOTS = process.env.SHOTS === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
// The Super Agent (told GO-SUPER-SETUP) arranges the stage with its own verbs, then follows
// $HOME/super-cmd.txt (one `send <child> <text>` per line) so the harness can start the children's
// turns from inside the super chat, the only place `super send` runs. A child told GO-STREAM streams
// until $HOME/stop-stream exists; the super agent told GO-SUPER-STREAM until $HOME/stop-super-stream.
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const HOME = process.env.HOME;
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const SID = at('--resume') || at('--session-id') || ('jank-' + process.pid);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(DIST_INDEX)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
const init = () => out({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: SID });
const WORDS = 'okuma yolunu tek kaynağa bağlıyorum sonra yazma yolunu aynı kilide alıyorum testler tek gözlemle doğrulanıyor ve kart yalnız kendi satırını çiziyor'.split(' ');

function setup() {
  const st = cli('super', 'state', '--json').json || cli('super', 'state').json || {};
  const chats = (st.containers || []).filter((c) => c.kind === 'chat');
  for (const c of chats.slice(-4)) cli('super', 'stack', c.id);
  const idOf = (ref) => ((cli('super', 'state').json || {}).containers || []).find((c) => c.ref === ref)?.id;
  cli('super', 'open', 'task', 'generated-task-001', 'generated-task-002', 'generated-task-003');
  const t = ['generated-task-001', 'generated-task-002', 'generated-task-003'].map(idOf).filter(Boolean);
  cli('super', 'group', ...t, '--name', 'Release checks');
  cli('super', 'open', 'knowledge', 'release-notes');
  cli('super', 'open', 'task', 'generated-task-004');
  const g2 = [idOf('release-notes'), idOf('generated-task-004')].filter(Boolean);
  cli('super', 'group', ...g2, '--name', 'Docs');
  cli('super', 'open', 'web', process.env.JANK_SITE || 'https://example.com/');
  if (chats[0]) cli('super', 'open', 'browser', chats[0].ref);
  cli('super', 'open', 'insight', 'weekly-active-users');
  cli('super', 'open', 'insight', 'trial-signups');
  for (let i = 0; i < ${POOL}; i += 1) cli('super', 'pool', 'add', '--prompt', 'Pool job ' + i + ': check the release notes once more.', '--brief', 'Pool job ' + i, '--note', 'later');
  cli('super', 'ask', 'Shall I merge the three release branches now?', '--options', 'Yes|Not yet|Ask me later');
}

let streaming = false;
async function stream(stopFile, label) {
  streaming = true;
  init();
  let n = 0;
  const msg = () => 'msg_' + SID.slice(0, 8) + '_' + (n++);
  while (!existsSync(stopFile)) {
    const id = msg();
    out({ type: 'stream_event', event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], usage: { input_tokens: 10, output_tokens: 1 } } } });
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    let text = '';
    for (let k = 0; k < 120 && !existsSync(stopFile); k += 1) {
      const piece = WORDS[(k * 7 + n) % WORDS.length] + ' ' + WORDS[(k * 3 + 1) % WORDS.length] + (k % 17 === 16 ? '.\\n\\n' : ' ');
      text += piece;
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
      await sleep(33);
    }
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    const tool = 'toolu_' + id;
    out({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: label + ' ' + text }, { type: 'tool_use', id: tool, name: 'Bash', input: { command: 'npm test -- --run src/lib/' + n, description: 'Run the tests' } }] } });
    out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 200 } } });
    out({ type: 'stream_event', event: { type: 'message_stop' } });
    await sleep(250);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: [{ type: 'text', text: 'Tests: 42 passed' }] }] } });
  }
  out({ type: 'assistant', message: { id: msg(), role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
  result('Done.');
  streaming = false;
}

function followCommands() {
  setInterval(() => {
    const f = join(HOME, 'super-cmd.txt');
    if (!existsSync(f)) return;
    let body = '';
    try { body = readFileSync(f, 'utf-8'); unlinkSync(f); } catch { return; }
    for (const line of body.split('\\n').map((l) => l.trim()).filter(Boolean)) {
      const [verb, child, ...rest] = line.split(' ');
      if (verb === 'send') cli('super', 'send', child, rest.join(' '));
    }
  }, 300);
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
      continue;
    }
    if (o.type !== 'user') continue;
    const text = JSON.stringify(o.message ?? '');
    if (text.includes('GO-SUPER-SETUP')) {
      init(); setup(); followCommands();
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'arranged' }] } });
      result('arranged');
    } else if (text.includes('GO-SUPER-STREAM')) {
      if (!streaming) void stream(join(HOME, 'stop-super-stream'), 'super');
    } else if (text.includes('GO-STREAM')) {
      if (!streaming) void stream(join(HOME, 'stop-stream'), 'child');
    } else if (!streaming) {
      init();
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
      result('ok');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// ─── fixtures ───────────────────────────────────────────────────────────────────────────
const CONVS = Array.from({ length: PANES }, (_, i) => ({ id: randomUUID(), mb: 1 + (i % 3), title: `Release lane ${i + 1}` }));

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
    line({ ...base('assistant'), message: { id: `msg_${convId.slice(0, 8)}_${i}`, role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'text', text: `Tur ${i}: ${filler}` }], usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000 } } }); i += 1;
    line({ ...base('user'), message: { role: 'user', content: [{ type: 'text', text: `Tur ${i}: devam et.` }] } }); i += 1;
  }
  closeSync(fd);
}

function task(i) {
  const slug = `generated-task-${String(i).padStart(3, '0')}`;
  return [slug, `---\nid: task_gen${String(i).padStart(4, '0')}\nname: Generated task ${i}\ndescription: A task the jank fixture generated.\npriority: medium\nurgency: medium\nstatus: ${['todo', 'in_progress', 'completed'][i % 3]}\ncreated_at: '2026-10-01'\nupdated_at: '2026-10-01'\ntags:\n  - 'kind:enhancement'\nparent_task: null\nrelated_feature: null\n---\n\n## Why\n\nFixture ${i}.\n\n## Acceptance Criteria\n\n- [ ] one\n- [x] two\n- [ ] three\n`];
}

const days = (n, f) => Array.from({ length: n }, (_, i) => ({ t: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), v: Math.round(f(i)) }));
const INSIGHTS = [
  { slug: 'weekly-active-users', title: 'Weekly active users', render: 'number', unit: 'users', points: days(12, (i) => 8200 + i * 140 + (i % 3) * 90) },
  { slug: 'trial-signups', title: 'Trial signups, daily', render: 'line', unit: 'signups', points: days(30, (i) => 120 + 30 * Math.sin(i / 3) + i * 2.5) },
];

function scratchEnv(extra) {
  const env = { ...process.env };
  for (const k of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'DREAMCONTEXT_PARENT_PID', 'DREAMCONTEXT_SERVER_PID', 'DREAMCONTEXT_TAB_SESSION']) delete env[k];
  return { ...env, ...extra };
}
const dc = (...args) => spawnSync(process.execPath, [DIST_INDEX, ...args], { cwd: PROJ, env: scratchEnv({ HOME }), encoding: 'utf-8' });
const must = (what, r) => { if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`); return r; };

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, '_dream_context', 'knowledge'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, titleMigrated: true,
    hotkey: 'Ctrl+A', renderer: 'webgl', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const [slug, body] of Array.from({ length: 300 }, (_, i) => task(i))) writeFileSync(join(PROJ, '_dream_context', 'state', `${slug}.md`), body);
  writeFileSync(join(PROJ, '_dream_context', 'knowledge', 'release-notes.md'), '---\nname: Release notes\ndescription: How a release is written up.\ntags: []\n---\n\n# Release notes\n\nOne line per change.\n');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: PROJ });
  const tdir = join(HOME, '.claude', 'projects', 'scratch-proj');
  for (const c of CONVS) writeTranscript(tdir, c.id, c.mb, PROJ, c.title);
  writeFileSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({
    activePane: 0,
    sessions: CONVS.map((c, i) => ({ title: c.title, kind: 'chat', bypass: false, minimized: false, size: 1, sessionId: c.id, pane: i, active: true })),
  }, null, 2));
  must('vaults add', spawnSync(process.execPath, [DIST_INDEX, 'vaults', 'add', 'proj', PROJ], { env: scratchEnv({ HOME }), encoding: 'utf-8' }));
  for (const i of INSIGHTS) {
    must(`lab create ${i.slug}`, dc('lab', 'create', i.slug, '--title', i.title, '--render', i.render, '--adapter', 'script', '--unit', i.unit, '--no-board'));
    mkdirSync(join(PROJ, '_dream_context', 'lab', 'scripts'), { recursive: true });
    writeFileSync(join(PROJ, '_dream_context', 'lab', 'scripts', `${i.slug}.mjs`), `export default async function () { return [{ name: ${JSON.stringify(i.title)}, points: ${JSON.stringify(i.points)} }]; }\n`);
    must(`lab sync ${i.slug}`, dc('lab', 'sync', i.slug));
  }
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

/** The "site" a child would serve: a small local page (a dev server's look). */
async function startSite() {
  const port = await freePort();
  const srv = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Orbit Notes preview</title><style>body{font:16px system-ui;margin:40px}</style><h1>Orbit Notes</h1><p>Local preview.</p>');
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${port}/` };
}

async function startServer(site) {
  const port = await freePort();
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: scratchEnv({ HOME, PATH, DREAMCONTEXT_DESKTOP: '1', JANK_SITE: site }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', () => {});
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok) return { srv, port, base: `http://127.0.0.1:${port}` }; } catch { /* not up */ }
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
  spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
}

// ─── in-page probes ─────────────────────────────────────────────────────────────────────
const PROBE = `
  (() => {
    const W = window;
    W.__jank = { commits: 0, census: null, long: [], events: [] };
    const fiberName = (f) => { const t = f.type; if (!t) return null; if (typeof t === 'function') return t.displayName || t.name || 'anon'; if (typeof t === 'object') { const inner = t.type || t.render; return (t.displayName || (inner && (inner.displayName || inner.name)) || 'memo'); } return null; };
    const FN = new Set([0, 1, 11, 14, 15]);
    const walk = (next, counts) => {
      // DevTools' rule: a child list that is the same object as the previous one bailed out whole.
      const prev = next.alternate;
      if (prev && next.child === prev.child) return;
      for (let c = next.child; c; c = c.sibling) {
        if (FN.has(c.tag) && (c.flags & 1)) { const n = fiberName(c); if (n) counts[n] = (counts[n] || 0) + 1; }
        walk(c, counts);
      }
    };
    W.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, renderers: new Map(), isDisabled: false,
      inject() { return 1; },
      onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
      onCommitFiberRoot(_id, root) {
        W.__jank.commits += 1;
        if (W.__jank.census) { try { walk(root.current, W.__jank.census); } catch {} }
      },
    };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) W.__jank.long.push({ start: e.startTime, d: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) W.__jank.events.push({ name: e.name, d: e.duration, start: e.startTime }); }).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch {}
    W.__jankFrames = { run: false, gaps: [], last: 0, gen: 0 };
    W.__jankStart = () => {
      const F = W.__jankFrames; F.run = true; F.gaps = []; F.last = 0;
      // A window that starts before the last one's frame chain saw its stop must not run two chains.
      const gen = ++F.gen;
      W.__jank.commits = 0; W.__jank.long = []; W.__jank.events = [];
      const tick = (t) => { if (!F.run || F.gen !== gen) return; if (F.last) F.gaps.push(t - F.last); F.last = t; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    };
    W.__jankStop = () => {
      const F = W.__jankFrames; F.run = false;
      const g = F.gaps.slice().sort((a, b) => a - b);
      const q = (p) => (g.length ? g[Math.min(g.length - 1, Math.floor(p * g.length))] : null);
      const surface = document.querySelector('[data-testid="super-surface"]');
      return {
        frames: g.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: g.length ? g[g.length - 1] : null,
        over33: g.filter((x) => x > 33.4).length, over50: g.filter((x) => x > 50).length,
        commits: W.__jank.commits,
        longTasks: W.__jank.long.length, longMs: Math.round(W.__jank.long.reduce((s, x) => s + x.d, 0)),
        longMax: Math.round(W.__jank.long.reduce((m, x) => Math.max(m, x.d), 0)),
        inputEvents: W.__jank.events.filter((e) => /key|input|beforeinput|pointer|mouse/.test(e.name)).length,
        inputP95: (() => { const d = W.__jank.events.filter((e) => /key|input/.test(e.name)).map((e) => e.d).sort((a, b) => a - b); return d.length ? d[Math.min(d.length - 1, Math.floor(0.95 * d.length))] : null; })(),
        inputMax: W.__jank.events.filter((e) => /key|input/.test(e.name)).reduce((m, e) => Math.max(m, e.d), 0),
        domNodes: document.getElementsByTagName('*').length,
        stageNodes: surface ? surface.getElementsByTagName('*').length : 0,
        heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / MB_) : null,
      };
    };
    const MB_ = 1048576;
  })();
`;

const pctl = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v]));

async function openStage(page, base) {
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  const tabsShown = async () => (await page.locator('.agent-pane-tabbar .agent-tab:visible').count()) > 0;
  for (let i = 0; i < 60 && !(await tabsShown()); i += 1) await page.waitForTimeout(500);
  if (!(await tabsShown())) {
    for (let i = 0; i < 3; i += 1) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(1500);
  }
  for (let i = 0; i < 120 && (await page.evaluate(() => document.querySelectorAll('.agent-panes > .agent-pane').length)) < PANES; i += 1) await page.waitForTimeout(500);
  await page.waitForTimeout(3_000);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  for (let i = 0; i < 80 && !(await page.locator('[data-testid="super-surface"]:visible').count()); i += 1) await page.waitForTimeout(250);
  for (let i = 0; i < 120 && !(await page.locator('[data-super-slot="centre"] .chat-cmp-input').count()); i += 1) await page.waitForTimeout(250);
  const composer = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
  await composer.click();
  await composer.fill('GO-SUPER-SETUP');
  await page.keyboard.press('Enter');
  const owner = () => page.evaluate(async () => (await (await fetch('/api/super/state', { headers: { 'x-dreamcontext-vault': 'proj' } })).json().catch(() => null)));
  let st = null;
  for (let i = 0; i < 240; i += 1) {
    st = await owner();
    if ((st?.queue ?? []).some((q) => q.kind === 'ask') && (st?.pool ?? []).length >= POOL) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(6_000);
  return st;
}

async function stageFacts(page, st) {
  const drawn = await page.evaluate(() => ({
    tiles: document.querySelectorAll('[data-testid="super-container"][data-where="float"]').length,
    tileKinds: [...document.querySelectorAll('[data-testid="super-container"][data-where="float"]')].map((e) => e.dataset.kind).join(','),
    groups: document.querySelectorAll('.super-group-frame, [data-testid="super-group"]').length,
    others: document.querySelector('[data-testid="super-others-stack"]')?.textContent?.match(/\d+/)?.[0] ?? null,
    queueHead: !!document.querySelector('[data-testid="super-queue-head"]'),
  }));
  return {
    children: Object.keys(st?.children ?? {}).length,
    containers: (st?.containers ?? []).length,
    floatingRecord: (st?.containers ?? []).filter((c) => c.place === 'float').length,
    groups: (st?.groups ?? []).length,
    pool: (st?.pool ?? []).length,
    queue: (st?.queue ?? []).length,
    kinds: (st?.containers ?? []).reduce((o, c) => { o[c.kind] = (o[c.kind] || 0) + 1; return o; }, {}),
    ...drawn,
  };
}

function wsCounter(page) {
  const counts = new Map();
  let on = false;
  page.on('websocket', (ws) => {
    const key = new URL(ws.url()).pathname;
    ws.on('framereceived', (f) => {
      if (!on) return;
      const c = counts.get(key) || { n: 0, bytes: 0 };
      c.n += 1; c.bytes += typeof f.payload === 'string' ? f.payload.length : f.payload?.length ?? 0;
      counts.set(key, c);
    });
  });
  return {
    start() { counts.clear(); on = true; },
    stop(ms) {
      on = false;
      const total = [...counts.values()].reduce((s, c) => s + c.n, 0);
      const bytes = [...counts.values()].reduce((s, c) => s + c.bytes, 0);
      return { wsMsgPerSec: Math.round((total / ms) * 10000) / 10, wsKbPerSec: Math.round((bytes / 1024 / ms) * 10000) / 10, wsSockets: counts.size };
    },
  };
}

const CDP_KEYS = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize', 'Nodes'];
async function cdpMetrics(cdp) {
  if (!cdp) return null;
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.filter((m) => CDP_KEYS.includes(m.name)).map((m) => [m.name, m.value]));
}

const TRACE_NAMES = ['FunctionCall', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'Layout', 'UpdateLayoutTree', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'RasterTask', 'CompositeLayers', 'UpdateLayer', 'ParseHTML', 'MajorGC', 'MinorGC', 'V8.GC_SCAVENGER', 'GPUTask', 'DecodeImage', 'ImageDecodeTask'];

async function window_(page, cdp, ws, name, act, throttle) {
  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  if (CENSUS) await page.evaluate(() => { window.__jank.census = {}; });
  const m0 = await cdpMetrics(cdp);
  let traceEvents = null;
  if (cdp && TRACE) {
    traceEvents = [];
    cdp.on('Tracing.dataCollected', (d) => traceEvents.push(...d.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  }
  if (cdp && PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
  await page.evaluate(() => window.__jankStart());
  ws.start();
  const t0 = Date.now();
  await act();
  const left = WINDOW_MS - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left);
  const ms = Date.now() - t0;
  const r = await page.evaluate(() => window.__jankStop());
  const wsr = ws.stop(ms);
  const m1 = await cdpMetrics(cdp);
  let trace = null;
  if (traceEvents) {
    const done = new Promise((res) => cdp.once('Tracing.tracingComplete', res));
    await cdp.send('Tracing.end');
    await done;
    const main = traceEvents.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
    const sum = {};
    for (const e of traceEvents) {
      if (e.ph !== 'X' || !TRACE_NAMES.includes(e.name)) continue;
      const k = `${e.name}${main && e.tid === main.tid && e.pid === main.pid ? '' : '@other'}`;
      sum[k] = (sum[k] || 0) + (e.dur || 0) / 1000;
    }
    trace = Object.fromEntries(Object.entries(sum).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)]));
  }
  let profile = null;
  if (cdp && PROFILE) {
    const { profile: pr } = await cdp.send('Profiler.stop');
    const byId = new Map(pr.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of pr.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const selfT = new Map();
    pr.samples.forEach((sid, k) => selfT.set(sid, (selfT.get(sid) || 0) + (pr.timeDeltas[k] || 0)));
    const self = new Map();
    const incl = new Map();
    const callers = new Map();
    for (const [sid, t] of selfT) {
      const n = byId.get(sid);
      const name = n.callFrame.functionName || '(anon)';
      if (['(idle)', '(program)', '(root)'].includes(name)) continue;
      const key = `${name} ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber}`;
      self.set(key, (self.get(key) || 0) + t);
      if (name === 'get clientHeight' || name === 'get scrollHeight' || name === 'fieldContentHeight') {
        const chain = [];
        for (let cur = parent.get(sid); cur !== undefined && chain.length < 4; cur = parent.get(cur)) {
          const c = byId.get(cur)?.callFrame; if (c?.functionName) chain.push(`${c.functionName}:${c.lineNumber}`);
        }
        const ck = `${name} <- ${chain.join(' <- ')}`;
        callers.set(ck, (callers.get(ck) || 0) + t);
      }
      const seen = new Set();
      for (let cur = sid; cur !== undefined; cur = parent.get(cur)) {
        const fn = byId.get(cur)?.callFrame.functionName;
        if (fn && /^[A-Z]/.test(fn) && !seen.has(fn)) { seen.add(fn); incl.set(fn, (incl.get(fn) || 0) + t); }
      }
    }
    const top = (m, n) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v / 1000)]));
    profile = { self: top(self, 30), components: top(incl, 40), callers: top(callers, 12) };
  }
  const census = CENSUS ? await page.evaluate(() => { const c = window.__jank.census; window.__jank.census = null; return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 40)); }) : undefined;
  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const cdpDelta = m0 && m1 ? {
    scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000),
    layoutMs: Math.round((m1.LayoutDuration - m0.LayoutDuration) * 1000),
    styleMs: Math.round((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000),
    taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000),
    layouts: m1.LayoutCount - m0.LayoutCount,
    styleRecalcs: m1.RecalcStyleCount - m0.RecalcStyleCount,
    heapMb: Math.round(m1.JSHeapUsedSize / MB),
    nodesCdp: m1.Nodes,
  } : {};
  const secs = ms / 1000;
  const row = round({
    ms, ...r, commitsPerSec: r.commits / secs, ...wsr, ...cdpDelta,
    busyPct: cdpDelta.taskMs !== undefined ? (cdpDelta.taskMs / ms) * 100 : undefined,
  });
  if (trace) row.trace = trace;
  if (profile) row.profile = profile;
  if (census) row.census = census;
  console.log(`      ${name.padEnd(22)} p50 ${row.p50} p95 ${row.p95} max ${row.max} >33ms ${row.over33}/${row.frames} commits/s ${row.commitsPerSec} long ${row.longTasks} (${row.longMs} ms) ws ${row.wsMsgPerSec}/s task ${row.taskMs ?? '-'} ms script ${row.scriptMs ?? '-'} style ${row.styleMs ?? '-'} layout ${row.layoutMs ?? '-'} nodes ${row.domNodes}/${row.stageNodes} heap ${row.heapMb ?? '-'}`);
  return row;
}

// ─── the actions ────────────────────────────────────────────────────────────────────────
function superCmd(lines) { writeFileSync(join(HOME, 'super-cmd.txt'), `${lines.join('\n')}\n`); }

async function startStreams(page, st) {
  rmSync(join(HOME, 'stop-stream'), { force: true });
  const kids = (st?.containers ?? []).filter((c) => c.kind === 'chat' && c.place === 'float').slice(0, STREAMERS).map((c) => c.ref);
  superCmd(kids.map((k) => `send ${k} GO-STREAM`));
  // Until the three tiles say "working".
  for (let i = 0; i < 80; i += 1) {
    const n = await page.evaluate(() => document.querySelectorAll('[data-testid="super-container"][data-status="working"]').length);
    if (n >= STREAMERS) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(3_000);
  return page.evaluate(() => document.querySelectorAll('[data-testid="super-container"][data-status="working"]').length);
}
async function stopStreams(page) {
  writeFileSync(join(HOME, 'stop-stream'), '1');
  for (let i = 0; i < 60; i += 1) {
    const n = await page.evaluate(() => document.querySelectorAll('[data-testid="super-container"][data-status="working"]').length);
    if (n === 0) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2_000);
}

async function dragLoop(page) {
  // The tile in the top-left of the orbit: press, then circle for the whole window, drop where it started.
  const box = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="super-container"][data-where="float"]')]
      .filter((e) => e.dataset.kind !== 'chat' || !e.dataset.status || e.dataset.status === 'idle');
    const el = els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 24 };
  });
  if (!box) return;
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 10, box.y + 4, { steps: 3 });
  const t0 = Date.now();
  let a = 0;
  while (Date.now() - t0 < WINDOW_MS - 600) {
    a += 0.18;
    await page.mouse.move(box.x + 60 * Math.cos(a) - 60 + 10, box.y + 40 * Math.sin(a), { steps: 1 });
    await page.waitForTimeout(16);
  }
  await page.mouse.move(box.x, box.y, { steps: 4 });
  await page.mouse.up();
}

async function typeLoop(page) {
  const composer = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
  await composer.click();
  const text = 'Release branches look fine, merge the docs lane first and then tell me what is left ';
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < WINDOW_MS - 400) {
    await page.keyboard.type(text[i % text.length]);
    i += 1;
    await page.waitForTimeout(70);
  }
  await composer.fill('');
}

async function openList(page) {
  const btn = page.locator('[data-testid="super-job-count-all"], [data-testid="super-job-count-working"]').first();
  await btn.click().catch(() => {});
  await page.waitForTimeout(800);
  return page.evaluate(() => document.querySelectorAll('[data-testid="super-job-row"]').length);
}
async function closeList(page) { await page.keyboard.press('Escape'); await page.waitForTimeout(500); }

async function superStream(page) {
  rmSync(join(HOME, 'stop-super-stream'), { force: true });
  const composer = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
  await composer.click();
  await composer.fill('GO-SUPER-STREAM');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3_000);
}
async function stopSuperStream(page) { writeFileSync(join(HOME, 'stop-super-stream'), '1'); await page.waitForTimeout(3_000); }

// ─── one engine ─────────────────────────────────────────────────────────────────────────
async function runEngine(engine, numbers) {
  setupScratch();
  const site = await startSite();
  const server = await startServer(site.url);
  const browser = await (engine === 'webkit' ? webkit : chromium).launch(engine === 'webkit' ? {} : { args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: VIEW, colorScheme: 'dark', reducedMotion: 'no-preference' });
    await ctx.addInitScript(PROBE);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
    const ws = wsCounter(page);
    // A headless page holds no focus by itself: the owner's window is focused.
    await page.evaluate(() => {}).catch(() => {});
    const st = await openStage(page, server.base);
    await page.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
    const facts = await stageFacts(page, st);
    console.log(`  [${engine}] stage: ${JSON.stringify(facts)}`);
    await page.screenshot({ path: join(OUT, `${engine}-stage.png`) });
    if (SHOTS) {
      const tag = `${engine}-${VIEW.width}`;
      await page.mouse.move(2, VIEW.height - 2);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(OUT, `${tag}-idle.png`) });
      await startStreams(page, st);
      await page.screenshot({ path: join(OUT, `${tag}-streaming.png`) });
      await stopStreams(page);
      numbers[engine] = { facts, shots: [`${tag}-idle.png`, `${tag}-streaming.png`], pageErrors: errors.slice(0, 10) };
      await ctx.close();
      return;
    }
    const cdp = engine === 'chromium' ? await ctx.newCDPSession(page) : null;
    if (cdp) await cdp.send('Performance.enable');
    // Diagnosis only (EXPERIMENT=noanim|notiles): take one suspect off the page before measuring.
    if (process.env.EXPERIMENT === 'noanim') await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    if (process.env.EXPERIMENT === 'notiles') await page.addStyleTag({ content: '.super-card-frame{display:none!important}' });
    if (process.env.EXPERIMENT?.startsWith('drop:')) await page.evaluate((needle) => { let n = 0; for (const sh of document.styleSheets) { let r; try { r = sh.cssRules; } catch { continue; } for (let i = r.length - 1; i >= 0; i--) if (r[i].cssText.includes(needle)) { sh.deleteRule(i); n++; } } console.log('dropped', n); }, process.env.EXPERIMENT.slice(5));
    if (process.env.EXPERIMENT === 'nohas') await page.evaluate(() => { for (const sh of document.styleSheets) { let r; try { r = sh.cssRules; } catch { continue; } for (let i = r.length - 1; i >= 0; i--) if (r[i].cssText.includes(':has(')) sh.deleteRule(i); } });
    if (process.env.EXPERIMENT === 'detachgarage') await page.evaluate(() => { const g = document.querySelector('.agent-garage'); window.__garage = g; g?.remove(); });
    const rows = {};
    const want = (k) => !ONLY || ONLY.has(k);
    const throttles = engine === 'chromium' ? [1, THROTTLE] : [1];
    for (const th of throttles) {
      const sfx = th === 1 ? '' : `@${th}x`;
      if (want('idle') && th === 1) rows[`idle${sfx}`] = await window_(page, cdp, ws, `idle${sfx}`, async () => {}, th);
      const working = await startStreams(page, st);
      if (th === 1) facts.streaming = working;
      if (want('stream')) rows[`stream${sfx}`] = await window_(page, cdp, ws, `stream${sfx}`, async () => {}, th);
      if (want('list') && th === 1) {
        const n = await openList(page);
        facts.listRows = n;
        await page.screenshot({ path: join(OUT, `${engine}-list.png`) });
        rows[`list${sfx}`] = await window_(page, cdp, ws, `list${sfx}`, async () => {}, th);
        await closeList(page);
      }
      if (want('drag')) rows[`drag${sfx}`] = await window_(page, cdp, ws, `drag${sfx}`, () => dragLoop(page), th);
      if (want('type')) rows[`type${sfx}`] = await window_(page, cdp, ws, `type${sfx}`, () => typeLoop(page), th);
      if (want('superStream') && th === 1 && engine === 'chromium') {
        await superStream(page);
        rows[`superStream${sfx}`] = await window_(page, cdp, ws, `superStream${sfx}`, async () => {}, th);
        await page.screenshot({ path: join(OUT, `${engine}-streaming.png`) });
        await stopSuperStream(page);
      }
      await stopStreams(page);
    }
    numbers[engine] = { facts, rows, pageErrors: errors.slice(0, 10) };
    await ctx.close();
  } finally {
    await browser.close();
    await stopServer(server);
    site.srv.close();
  }
}

// ─── main ───────────────────────────────────────────────────────────────────────────────
const numbers = { phase: PHASE, dist: DIST_INDEX, at: new Date().toISOString(), windowMs: WINDOW_MS, throttle: THROTTLE, census: CENSUS, viewport: VIEW };
let exitCode = 0;
try {
  console.log(`[super-jank] phase=${PHASE} dist=${DIST_INDEX} engines=${ENGINES.join(',')}`);
  mkdirSync(OUT, { recursive: true });
  for (const e of ENGINES) await runEngine(e, numbers);
} catch (e) {
  console.error(`[super-jank] aborted: ${e.stack || e}`);
  exitCode = 2;
} finally {
  const file = join(OUT, SHOTS ? `shots-${VIEW.width}.json` : CENSUS ? 'census.json' : 'numbers.json');
  writeFileSync(file, `${JSON.stringify(numbers, null, 2)}\n`);
  console.log(`[super-jank] numbers → ${file}`);
}
process.exit(exitCode);
