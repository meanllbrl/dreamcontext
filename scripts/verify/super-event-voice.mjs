#!/usr/bin/env node
/**
 * Event voice, end to end against the REAL dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1),
 * the real chat WebSockets and the real CLI. No browser: this script is the window (it answers the
 * super chat's `super_command` frames by opening the child's chat socket, as chatSession does).
 * The `claude` on PATH is a stand-in: the super delegates on the owner's word; the child ends its
 * turn with a background task running (the CLI's background_tasks_changed roster, as 2.1.306
 * emits it for run_in_background and Monitor), checks in once while it runs, then the roster
 * empties and the CLI's notification turn ends.
 *
 *   npm run build:cli && node scripts/verify/super-event-voice.mjs [repo]   (BG_MS=70000 outlasts the 30 s settle window)
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.argv[2] || join(HERE, '..', '..'));
const TSX = process.execPath;
const CLI_TS = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-verify-olay-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const BG_MS = Number(process.env.BG_MS || 15000);

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
let brief = ''; try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-' + process.pid;
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const cli = (...a) => { const r = spawnSync(${JSON.stringify(TSX)}, [${JSON.stringify(CLI_TS)}, ...a], { env: process.env, encoding: 'utf-8', timeout: 90000 }); return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const turn = (said) => {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, session_id: sid });
};
const roster = (n) => out({ type: 'system', subtype: 'background_tasks_changed', tasks: Array.from({ length: n }, (_, i) => ({ task_id: 'bg' + i, task_type: 'local_bash', description: 'integration tests' })) });
let buf = '';
process.stdin.on('data', (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = o.message?.content ?? [];
    const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    report({ kind: 'frame', text: text.slice(0, 3000) });
    if (role === 'super') {
      if (text.includes('GO-DELEGATE')) {
        const r = cli('super', 'delegate', '--prompt', 'CHILD-BG run the integration tests', '--brief', 'Integration tests');
        report({ kind: 'delegate', status: r.status, out: r.out.slice(0, 600) });
        turn('started the tests');
      } else turn('ok');
      continue;
    }
    if (text.includes('CHILD-BG')) {
      out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
      roster(1);
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Tests started in the background; 46 suites left.' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'running', num_turns: 1, session_id: sid });
      report({ kind: 'child-turn-end', bg: 1 });
      setTimeout(() => { turn('Still running: 20 suites left.'); report({ kind: 'child-turn-end', bg: 1 }); }, ${Math.round(BG_MS / 2)});
      setTimeout(() => { roster(0); report({ kind: 'roster-empty' }); turn('All 46 suites passed.'); report({ kind: 'child-turn-end', bg: 0 }); }, ${BG_MS});
      continue;
    }
    turn('ok');
  }
});
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const results = [];
const check = (label, cond, detail) => { results.push(!!cond); console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`); };

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2));
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(TSX, [CLI_TS, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add: ${r.stderr || r.stdout}`);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(TSX, [CLI_TS, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(SCRATCH, 'server.log'));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (let i = 0; i < 200; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/super/state`, { headers: { 'X-Dreamcontext-Vault': 'acme-app' } })).status < 500) return srv; } catch { /* not up */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('server did not come up');
}

function openChat(port, params, onFrame) {
  const q = new URLSearchParams({ vault: 'acme-app', ...params });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/chat?${q}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  ws.on('message', (d) => { let o; try { o = JSON.parse(String(d)); } catch { return; } onFrame?.(o, ws); });
  return new Promise((res, rej) => { ws.once('open', () => res(ws)); ws.once('error', rej); });
}

const stateFile = () => JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8'));

async function main() {
  console.log(`repo: ${REPO}\nscratch: ${SCRATCH}`);
  setup();
  const port = await freePort();
  const srv = await startServer(port);
  const children = [];
  try {
    const en = await fetch(`http://127.0.0.1:${port}/api/super/enable`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Dreamcontext-Vault': 'acme-app' }, body: JSON.stringify({ adopt: [] }) });
    const { session } = await en.json();
    check('hand-over enabled', en.status === 200 && session, `status ${en.status}`);
    // The window: answers the super chat's delegate command by opening the child's chat.
    const sup = await openChat(port, { mode: 'super', sessionId: session }, async (o, ws) => {
      if (o.type !== '_meta' || o.subtype !== 'super_command') return;
      if (o.verb !== 'delegate') { ws.send(JSON.stringify({ type: 'super_command_result', id: o.id, ok: true, result: null })); return; }
      const sid = randomUUID();
      const c = await openChat(port, { mode: 'basic', sessionId: sid });
      children.push(c);
      c.send(JSON.stringify({ type: 'user', text: String(o.args.prompt) }));
      ws.send(JSON.stringify({ type: 'super_command_result', id: o.id, ok: true, result: { sessionId: sid } }));
    });
    // Let the handover turn run, then the owner speaks.
    for (let i = 0; i < 60 && !readNd(REPORTS).some((r) => r.role === 'super' && r.text?.startsWith('[super handover]')); i += 1) await sleep(500);
    await sleep(2000);
    sup.send(JSON.stringify({ type: 'user', text: 'GO-DELEGATE the integration tests, I am waiting' }));
    let child = null;
    for (let i = 0; i < 120 && !child; i += 1) { await sleep(500); child = Object.keys(stateFile().children ?? {})[0] ?? null; }
    const d = readNd(REPORTS).find((r) => r.kind === 'delegate');
    check('the super delegated in the owner\'s turn', d?.status === 0 && child, d?.out?.slice(0, 160));
    check('the child is recorded awaited', stateFile().children?.[child]?.awaited === true, JSON.stringify(stateFile().children?.[child]));
    // While the background work runs: rows only, no event, no settle chip.
    const samples = [];
    const t0 = Date.now();
    let emptyAt = null;
    while (Date.now() - t0 < BG_MS + 45_000) {
      await sleep(1000);
      const s = stateFile();
      const rep = readNd(REPORTS);
      emptyAt ??= rep.find((r) => r.kind === 'roster-empty')?.t ?? null;
      samples.push({ t: Date.now(), row: s.children?.[child]?.row, settling: !!s.children?.[child]?.settling, events: rep.filter((r) => r.role === 'super' && r.text?.startsWith('[super events]')).length, empty: emptyAt !== null });
      if (emptyAt && rep.some((r) => r.role === 'super' && r.text?.startsWith('[super events]') && r.t > emptyAt)) break;
    }
    const ends = readNd(REPORTS).filter((r) => r.kind === 'child-turn-end');
    const during = samples.filter((x) => !x.empty);
    check('the child ended turns while its background work ran', ends.filter((e) => e.bg === 1).length === 2, `${ends.length} turn ends`);
    const early = readNd(REPORTS).filter((r) => r.role === 'super' && r.text?.startsWith('[super events]') && (!emptyAt || r.t < emptyAt));
    check('no [super events] turn before the background work ended', early.length === 0, `${early.length} early`);
    check('while it ran: the row stays working, no "bitiyor", no event', during.length > 3 && during.every((x) => x.row === 'working' && !x.settling && x.events === 0), JSON.stringify(during.map((x) => `${x.row}${x.settling ? '*' : ''}/${x.events}`)));
    const evs = readNd(REPORTS).filter((r) => r.role === 'super' && r.text?.startsWith('[super events]') && emptyAt && r.t > emptyAt);
    check('exactly one [super events] turn after the work ended', evs.length === 1, `${evs.length}`);
    const ev = evs[0];
    check('it came >= 30 s after the background work ended', ev && emptyAt && ev.t - emptyAt >= 30_000, ev && emptyAt ? `${ev.t - emptyAt} ms` : 'none');
    check('it carries event=done awaited=owner and the tell-him line', !!ev && /event=done awaited=owner/.test(ev.text) && ev.text.includes('tell him its result now'), ev?.text?.split('\n')[1]);
    check('the silent rule says no text at all', !!ev && ev.text.includes('write no text at all in this turn') && !ev.text.includes('Write the owner nothing'));
    check('the owner\'s language, never the note\'s', !!ev && ev.text.includes('in the language the owner writes to you in, never the language of this note'));
    const batch = ev?.text.match(/batch=(b-[a-z0-9-]+)/)?.[1];
    await sleep(3000);
    const s = stateFile();
    check('its batch renders in full (ownerBatches)', batch && s.ownerBatches?.includes(batch), `${batch} in ${JSON.stringify(s.ownerBatches)}`);
    check('the awaited mark is spent after that turn', s.children?.[child]?.awaited === undefined, JSON.stringify(s.children?.[child]));
    check('the row is done', s.children?.[child]?.row === 'done');
    for (const c of children) c.close();
    sup.close();
  } finally {
    srv.kill();
    await sleep(500);
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed  (server log: ${join(SCRATCH, 'server.log')})`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
