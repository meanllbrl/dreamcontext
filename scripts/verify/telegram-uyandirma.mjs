#!/usr/bin/env node
/**
 * A slept or closed Super does not wake from Telegram (owner 2026-11-16, Ege's bot): reproduced on
 * the REAL dashboard server in a scratch HOME, never the owner's vault or app.
 *
 * The scene: main's Super is on and Ege (an AI Team member) has its own Super, each with its own
 * Telegram bot bound; NO window holds either chat (closed tab, slept, or the app's window hidden:
 * the `open -g dreamcontext://…` the hub sends to reopen a window goes nowhere, see the preload).
 * His messages arrive through the hub's real poller from a fake Telegram (the preload answers
 * api.telegram.org from files). `claude` is a stand-in that answers "Uyandım: <his words>".
 *
 *   node scripts/verify/telegram-uyandirma.mjs [--repo <checkout>] [--expect answered|unanswered] [--wait-s 75]
 *
 * --repo: the code under test (default: this checkout), so the same scene runs on the old code
 * (`--repo <a main/dev worktree> --expect unanswered`) and on the fix (`--expect answered`).
 * Prints what Telegram received per bot, what the hub tried to open, which `claude` processes
 * started and the window-open log; exit 0 = the outcome matched --expect, 1 = it did not,
 * 78 = the harness itself failed to come up.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'telegram-uyandirma');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const REPO = arg('--repo', join(HERE, '..', '..'));
const EXPECT = arg('--expect', 'answered');
const WAIT_S = Number(arg('--wait-s', '75'));
const MAIN_TOKEN = '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const EGE_TOKEN = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const harness = (why) => { process.stdout.write(`HARNESS: ${why}\n`); process.exit(78); };
const freePort = () => new Promise((done, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scratch = mkdtempSync(join(tmpdir(), 'dc-verify-tg-wake-'));
const home = join(scratch, 'home');
const proj = join(scratch, 'proj');
const V = join(home, '.verify');
mkdirSync(join(home, '.dreamcontext'), { recursive: true });
mkdirSync(join(proj, '_dream_context', 'state'), { recursive: true });
mkdirSync(V, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: proj });
const bin = join(home, '.local', 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(FIX, 'claude.mjs')}" "$@"\n`);
chmodSync(join(bin, 'claude'), 0o755);

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const env = {
  ...clean, HOME: home, PATH: `${bin}:${process.env.PATH}`, npm_config_cache: join(process.env.HOME ?? home, '.npm'),
  DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0',
};
// tsx through npx, as scripts/verify/lib/app.mjs runs the API (npm's cache stays the real one).
if (!existsSync(join(REPO, 'src', 'cli', 'index.ts'))) harness(`no source checkout at ${REPO}`);
const TSX = ['--yes', 'tsx'];
const cli = (args) => spawnSync('npx', [...TSX, join(REPO, 'src', 'cli', 'index.ts'), ...args], { cwd: proj, env, encoding: 'utf-8' });

let server = null;
/** Sockets this check holds open (the plain tab), closed at the end. */
const held = [];
const stop = () => {
  for (const sock of held) { try { sock.destroy(); } catch { /* gone */ } }
  if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } }
  spawnSync('pkill', ['-f', join(FIX, 'claude.mjs')]);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { stop(); process.exit(1); });

try {
  for (const step of [['vaults', 'add', 'proj', proj], ['agents', 'create', 'ege', '--title', 'Ege', '--prompt', 'Kişisel antrenör.']]) {
    const r = cli(step);
    if (r.status !== 0) harness(`${step.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
  }
  const set = spawnSync('npx', [...TSX, join(FIX, 'setup.ts'), REPO, proj], { cwd: proj, env, encoding: 'utf-8' });
  if (set.status !== 0) harness(`setup failed: ${(set.stderr || set.stdout).trim().split('\n').slice(-3).join(' ')}`);
  const { mainSession, egeSession } = JSON.parse(set.stdout.trim().split('\n').pop());

  const port = await freePort();
  server = spawn('npx', [...TSX, join(REPO, 'src', 'cli', 'index.ts'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: proj, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, NODE_OPTIONS: `--import=${pathToFileURL(join(FIX, 'preload.mjs')).href}` },
  });
  const serverLog = join(V, 'server.log');
  server.stdout.on('data', (d) => appendFileSync(serverLog, d));
  server.stderr.on('data', (d) => appendFileSync(serverLog, d));
  const end = Date.now() + 90_000;
  for (;;) {
    if (server.exitCode != null) harness(`the server exited (${server.exitCode}); see ${serverLog}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.status < 500) break; } catch { /* not yet */ }
    if (Date.now() > end) harness('the server did not answer in 90 s');
    await sleep(300);
  }
  // Both bots are served once the hub has set their menus (its start step).
  const outbox = () => { try { return readFileSync(join(V, 'tg-outbox.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const upEnd = Date.now() + 60_000;
  while (!(outbox().some((c) => c.token === '111111') && outbox().some((c) => c.token === '222222'))) {
    if (Date.now() > upEnd) harness('the Telegram hub never served both bots');
    await sleep(300);
  }
  await sleep(1500);

  // His messages, as Telegram delivers them: main's bot, then Ege's bot twice (the 02:44-02:49 evening).
  let uid = 9000;
  const push = (token, text) => appendFileSync(join(V, 'tg-inbox.jsonl'), `${JSON.stringify({ token, update: { update_id: ++uid, message: { message_id: uid, date: Math.floor(Date.now() / 1000), chat: { id: 777, type: 'private' }, from: { id: 777, is_bot: false, first_name: 'Owner' }, text } } })}\n`);
  const t0 = Date.now();
  push(MAIN_TOKEN, 'Alo');
  push(EGE_TOKEN, 'Selam');
  push(EGE_TOKEN, 'hey');

  const texts = (bot) => outbox().filter((c) => c.token === bot && c.method === 'sendMessage' && c.at >= t0).map((c) => String(c.params.text ?? '').replace(/<[^>]+>/g, ''));
  const answered = () => texts('111111').some((t) => t.includes('Uyandım: Alo'))
    && texts('222222').some((t) => t.includes('Uyandım: Selam')) && texts('222222').some((t) => t.includes('Uyandım: hey'));
  const waitEnd = Date.now() + WAIT_S * 1000;
  while (!answered() && Date.now() < waitEnd) await sleep(500);
  const tookS = Math.round((Date.now() - t0) / 100) / 10;
  await sleep(1500); // anything late (a second notice, a duplicate) shows too

  let ok = answered();

  // Phase 2, the blank member stage: a window's session link that lands as a PLAIN chat tab of
  // Ege's conversation (no `mode=super`), then his next message on Ege's bot.
  const plainTab = await new Promise((done) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path: `/api/agent/chat?vault=proj&bypass=0&resume=${egeSession}`,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), Host: `127.0.0.1:${port}` },
    });
    req.on('upgrade', (_res, socket) => { held.push(socket); done('opened (101): a plain tab now runs Ege\'s conversation'); });
    req.on('response', (res) => done(`refused (${res.statusCode})`));
    req.on('error', (e) => done(`error ${e.message}`));
    req.end();
  });
  await sleep(4000);
  const t1 = Date.now();
  push(EGE_TOKEN, 'Ege orada mısın?');
  const again = () => outbox().some((c) => c.token === '222222' && c.method === 'sendMessage' && c.at >= t1 && String(c.params.text ?? '').includes('Uyandım: Ege orada mısın?'));
  const againEnd = Date.now() + WAIT_S * 1000;
  while (!again() && Date.now() < againEnd) await sleep(500);
  const answeredAgain = again();
  const egeAfter = outbox().filter((c) => c.token === '222222' && c.method === 'sendMessage' && c.at >= t1).map((c) => String(c.params.text ?? '').replace(/<[^>]+>/g, ''));
  ok = ok && answeredAgain;

  const read = (f) => { try { return readFileSync(f, 'utf-8').trim(); } catch { return ''; } };
  process.stdout.write(`repo: ${REPO}\nscratch: ${scratch}\nsessions: main ${mainSession.slice(0, 8)}, ege ${egeSession.slice(0, 8)}\n`);
  process.stdout.write(`\n== main's bot received (after his "Alo") ==\n${texts('111111').map((t) => `  ${t}`).join('\n') || '  (nothing)'}\n`);
  process.stdout.write(`\n== Ege's bot received (after "Selam", "hey") ==\n${texts('222222').map((t) => `  ${t}`).join('\n') || '  (nothing)'}\n`);
  process.stdout.write(`\n== plain chat tab opening Ege's conversation: ${plainTab} ==\n== Ege's bot after "Ege orada mısın?" ==\n${egeAfter.map((t) => `  ${t}`).join('\n') || '  (nothing)'}\n`);
  process.stdout.write(`\n== window links the hub tried to open (open -g; the app stays hidden) ==\n${read(join(V, 'opened.log')) || '  (none)'}\n`);
  const starts = read(join(V, 'claude.log')).split('\n').filter((l) => l.includes('--input-format'));
  process.stdout.write(`\n== claude processes started ==\n${starts.map((l) => {
    const a = l.split(' ');
    const at = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : '-'; };
    return `  resume=${at('--resume').slice(0, 8)} session-id=${at('--session-id').slice(0, 8)} permission=${at('--permission-mode')} model=${at('--model')}`;
  }).join('\n') || '  (none)'}\n`);
  process.stdout.write(`\n== turns the stand-in claude took ==\n${read(join(V, 'claude-turns.log')) || '  (none)'}\n`);
  process.stdout.write(`\n== ~/.dreamcontext/logs/window-open.log ==\n${read(join(home, '.dreamcontext', 'logs', 'window-open.log')) || '  (empty)'}\n`);
  const dup = ['Uyandım: Alo', 'Uyandım: Selam', 'Uyandım: hey', 'Uyandım: Ege orada mısın?'].filter((w) => [...texts('111111'), ...texts('222222')].filter((t) => t.includes(w)).length > 1);
  process.stdout.write(`\nRESULT: ${ok ? `answered on Telegram in ${tookS}s` : `NOT answered within ${WAIT_S}s`}${dup.length ? `; DUPLICATES: ${dup.join(', ')}` : ''}\n`);
  stop();
  const pass = EXPECT === 'answered' ? ok && dup.length === 0 && plainTab.startsWith('refused') : !ok;
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} (expected ${EXPECT})\n`);
  // The server may still be flushing a file as it goes: the scratch is removed best-effort.
  if (pass) { await sleep(1500); try { rmSync(scratch, { recursive: true, force: true }); } catch { /* left in tmp */ } }
  process.exit(pass ? 0 : 1);
} catch (err) {
  stop();
  harness(String(err?.stack ?? err));
}
