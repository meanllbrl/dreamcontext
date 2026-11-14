#!/usr/bin/env node
/**
 * One Super Agent pin, one process (field 2026-11-14: two Super processes per project for an
 * hour, the window's state pushed to the old one).
 *
 *   npm run build:cli && node scripts/verify/super-eski-surec.mjs
 *
 * The real dashboard server (dist, scratch HOME, DREAMCONTEXT_DESKTOP=1), a recorded Super and
 * the real chat WebSocket route. `claude` is a scripted stand-in in the fake HOME (no tokens
 * spent): it reports every spawn and exit to a file, answers each user frame with a `result`
 * (SLOW takes 4 s), exits on stdin EOF like the CLI, and acts out a `/clear` rotation on CLEAR:
 * a new conversation id, its transcript, and the tab map pin → new id (what the SessionStart
 * hook records).
 *
 * The field path: the Super rotated (`/clear` hand-off), so the conversation its process holds
 * is no longer the one its pin maps to; the window then opened the pin again with a plain resume
 * (no reattach). Nothing held the mapped id, so the server accepted a second process, and the
 * first, still attached to the open screen, waited for a socket close that never came.
 *
 *   E0  a cold start (no Super process yet) opened the NEW way (`reattach=passive`): one process,
 *       spawned with its window env (DREAMCONTEXT_WINDOW_URL/TOKEN), so `dreamcontext super` works.
 *   E1  that plain open after a rotation: a second process is accepted and the FIRST EXITS,
 *       although its screen stays open (before the fix it lived on).
 *   E3  the window's NEW open (`reattach=passive`) beside a live screen: no new process; the
 *       newcomer is told 4409 (another screen holds it).
 *   E4  after that screen drops (a reload): the passive open ADOPTS the same process.
 *   E2  the plain open while the old process runs a turn: the turn is not cut; it exits when
 *       that turn ends.
 *
 * Exit 0 iff every check passed (78 = its own setup failed).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-eski-surec-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const CLI = join(REPO, 'dist', 'index.js');
const TRANSCRIPTS = join(HOME, '.claude', 'projects', 'acme-app');
const TAB_MAP = join(PROJ, '_dream_context', 'state', '.agent-session-map');
const PIN = randomUUID();

const STANDIN = `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
let convo = at('--resume') || at('--session-id') || randomUUID();
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ pid: process.pid, t: Date.now(), convo, ...o }) + '\\n');
const transcript = (id) => { mkdirSync(${JSON.stringify(TRANSCRIPTS)}, { recursive: true }); appendFileSync(join(${JSON.stringify(TRANSCRIPTS)}, id + '.jsonl'), JSON.stringify({ sessionId: id }) + '\\n'); };
report({ kind: 'spawn', tab: process.env.DREAMCONTEXT_TAB_SESSION || '', windowUrl: process.env.DREAMCONTEXT_WINDOW_TOKEN ? process.env.DREAMCONTEXT_WINDOW_URL || '' : '' });
transcript(convo);
out({ type: 'system', subtype: 'init', session_id: convo, apiKeySource: 'none', model: 'stand-in' });
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = JSON.stringify(o.message?.content ?? '');
    if (text.includes('CLEAR')) {
      // A /clear: a new conversation in this same process, and the tab map moves to it.
      const from = convo;
      convo = randomUUID();
      transcript(convo);
      const tab = process.env.DREAMCONTEXT_TAB_SESSION;
      if (tab) { mkdirSync(${JSON.stringify(TAB_MAP)}, { recursive: true }); writeFileSync(join(${JSON.stringify(TAB_MAP)}, tab + '.json'), JSON.stringify({ current: convo, updated: new Date().toISOString() })); }
      out({ type: 'system', subtype: 'init', session_id: convo, apiKeySource: 'none', model: 'stand-in' });
      report({ kind: 'clear', from });
    }
    const ms = text.includes('SLOW') ? 4000 : 50;
    report({ kind: 'turn', slow: ms > 50 });
    setTimeout(() => {
      out({ type: 'assistant', session_id: convo, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
      out({ type: 'result', subtype: 'success', session_id: convo, result: 'ok', num_turns: 1 });
      report({ kind: 'result' });
    }, ms);
  }
});
process.stdin.on('end', () => { report({ kind: 'eof' }); setTimeout(() => process.exit(0), 100); });
process.on('SIGTERM', () => { report({ kind: 'sigterm' }); process.exit(143); });
`;

let failed = 0;
let serverLog = () => '';
const check = (label, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reports = () => (existsSync(REPORTS) ? readFileSync(REPORTS, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const spawns = () => reports().filter((r) => r.kind === 'spawn');
const saw = (pid, kind) => reports().some((r) => r.pid === pid && r.kind === kind);
const count = (pid, kind) => reports().filter((r) => r.pid === pid && r.kind === kind).length;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };

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
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const add = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
  // The Super is on, its session recorded: the server opens super mode for that pin only.
  writeFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), JSON.stringify({
    v: 1, session: PIN, enabled: true, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [],
    notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [],
  }, null, 2));
  // As in the field, the pane has rotated before: its pin's first transcript, and the tab map
  // pointing the pin at the conversation it moved on to.
  const earlier = randomUUID();
  mkdirSync(TRANSCRIPTS, { recursive: true });
  for (const id of [PIN, earlier]) writeFileSync(join(TRANSCRIPTS, `${id}.jsonl`), JSON.stringify({ sessionId: id }) + '\n');
  mkdirSync(TAB_MAP, { recursive: true });
  writeFileSync(join(TAB_MAP, `${PIN}.json`), JSON.stringify({ current: earlier, updated: new Date().toISOString() }));
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DREAMCONTEXT_') && !k.startsWith('CLAUDE')));

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    // Nothing of the session running this script leaks in (its own window URL and token would
    // reach the stand-in and hide a missing one).
    cwd: PROJ, env: { ...cleanEnv(), HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  serverLog = () => log;
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  const ok = await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/agent/live-chats`)).status < 500; } catch { return false; } }, 60000);
  if (!ok) { srv.kill(); throw new Error(`server did not come up:\n${log.slice(-2000)}`); }
  return srv;
}

/** A chat socket for the Super pin, as the window opens it. */
function open(port, reattach = '') {
  const url = `ws://127.0.0.1:${port}/api/agent/chat?vault=acme&bypass=0&resume=${PIN}&mode=super${reattach ? `&reattach=${reattach}` : ''}`;
  const ws = new WebSocket(url, { headers: { Origin: `http://127.0.0.1:${port}` } });
  ws.frames = [];
  ws.closeCode = null;
  ws.on('message', (d) => { try { ws.frames.push(JSON.parse(String(d))); } catch { /* not json */ } });
  ws.on('close', (code) => { ws.closeCode = code; ws.closedAt ??= Date.now(); });
  ws.on('error', () => { /* the close says it */ });
  ws.on('unexpected-response', (_req, res) => { ws.closeCode = res.statusCode; ws.emit('close', res.statusCode); });
  ws.opened = new Promise((r) => { ws.once('open', () => r(true)); ws.once('close', () => r(false)); });
  return ws;
}
const say = (ws, text) => ws.send(JSON.stringify({ type: 'user', text }));

async function main() {
  setup();
  const port = await freePort();
  const srv = await startServer(port);
  try {
    // ── E1 ──────────────────────────────────────────────────────────────────────────
    const a = open(port, 'passive');       // the window's new open, on a cold server
    await a.opened;
    await until(() => spawns().length === 1);
    const first = spawns()[0]?.pid;
    check('E0 a passive open on a cold server starts one Super process', !!first && alive(first), `pid ${first}`);
    check('E0 …with its window env (the super verbs can reach the window)', spawns()[0]?.windowUrl === `http://127.0.0.1:${port}`,
      `DREAMCONTEXT_WINDOW_URL=${spawns()[0]?.windowUrl || '(none)'}`);
    say(a, 'CLEAR');                       // the /clear hand-off: same process, new conversation
    await until(() => saw(first, 'clear') && saw(first, 'result'));
    const b = open(port);                  // the window's old open: a plain resume, no reattach
    await b.opened;
    await until(() => spawns().length === 2);
    const second = spawns()[1]?.pid;
    check('E1 the plain-resume open after the rotation starts a second process', !!second && alive(second), `pid ${second}`);
    const firstGone = await until(() => !alive(first), 10000);
    // Its stdin was ended while its screen's socket was still open (the server closes that
    // socket only after the process exits, as for any ended chat).
    const eofAt = reports().find((r) => r.pid === first && r.kind === 'eof')?.t ?? Infinity;
    check('E1 the FIRST process exits although its screen stays open', firstGone && eofAt < (a.closedAt ?? Infinity),
      `alive=${alive(first)} eof=${saw(first, 'eof')} eof before socket close=${eofAt < (a.closedAt ?? Infinity)}`);
    check('E1 one process holds the pin afterwards', !!second && alive(second) && !alive(first));

    // ── E3 ──────────────────────────────────────────────────────────────────────────
    const before = spawns().length;
    const c = open(port, 'passive');       // the window's new open, beside b (live)
    await c.opened;
    await until(() => c.closeCode !== null, 8000);
    check('E3 a passive open beside a live screen starts no process', spawns().length === before, `spawns ${spawns().length}`);
    check('E3 …and is told another screen holds it (4409)', c.closeCode === 4409, `close ${c.closeCode}`);

    // ── E4 ──────────────────────────────────────────────────────────────────────────
    b.terminate();                         // a reload: the holder's socket is gone
    await sleep(500);
    const d = open(port, 'passive');
    await d.opened;
    const adopted = await until(() => d.frames.some((f) => f.subtype === 'reattached' && f.adopted === true), 8000);
    check('E4 after a reload the passive open ADOPTS the same process', adopted && spawns().length === before && alive(second),
      `adopted=${adopted} spawns ${spawns().length}`);

    // ── E2 ──────────────────────────────────────────────────────────────────────────
    say(d, 'CLEAR');
    await until(() => count(second, 'result') >= 1);
    say(d, 'SLOW job');
    await until(() => count(second, 'turn') >= 2);
    const n0 = spawns().length;
    const e = open(port);                  // a plain open while that turn runs
    await e.opened;
    await until(() => spawns().length === n0 + 1);
    check('E2 the plain open mid-turn starts a second process', spawns().length === n0 + 1, `spawns ${spawns().length}`);
    await sleep(1000);
    check('E2 the running turn is not cut', alive(second) && !saw(second, 'eof') && !saw(second, 'sigterm'));
    const ended = await until(() => count(second, 'result') >= 2, 8000);
    const exited = await until(() => !alive(second), 8000);
    check('E2 …it finishes its turn, then exits', ended && exited, `result=${ended} eof=${saw(second, 'eof')} alive=${alive(second)}`);
    a.close(); d.close(); e.close();
  } finally {
    srv.kill();
    await sleep(500);
    for (const r of spawns()) if (alive(r.pid)) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  if (failed) console.log(`\n${failed} check(s) FAILED; scratch kept: ${SCRATCH}\n${serverLog().slice(-1500)}`);
  else { console.log('\nall checks passed'); rmSync(SCRATCH, { recursive: true, force: true }); }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(78); });
