#!/usr/bin/env node
/**
 * Which answer is to which message, with the REAL model (task super-sohbetinde-her-cevabin-
 * ustunde-…, plan r2 'Observed 4' and R2-7): does the Super Agent, briefed with this checkout's
 * briefing, open each answer with `<!-- re:<ref> -->` naming the right `<owner-msg ref>`, and does
 * it know its own message from a `[Reply to message …]` pointer?
 *
 *   node scripts/verify/super-reply-model.mjs
 *
 * One `claude -p --input-format stream-json --output-format stream-json --verbose --model opus
 * --effort medium` session per case, fed the way the bridge feeds it: each owner message is ONE
 * user write with his words first and the server's `<owner-msg ref="…"/>` block after them. The
 * only pre-approved tool is `Bash(dreamcontext super:*)`; a stub `dreamcontext` FIRST on a minimal
 * PATH logs its argv and prints a canned `super state` (fictional project "orbit"), slowly, so the
 * first turn is still running when the 2nd and 3rd messages are written (the real steer shape).
 * Isolation as super-agenda-about-model.mjs: scratch cwd, no session persistence, project settings
 * only, no MCP servers; HOME stays real only so the CLI is signed in.
 *
 *  (a) three messages, the 2nd and 3rd while the first turn runs -> every message's ref is named by
 *      a mark at a block's head or at a section's line start (3 of 3), and no mark names a ref he
 *      never sent;
 *  (b) a reply to the Super's own earlier answer (`[Reply to message ref=… from=super]` + a quote of
 *      its first 100 characters) -> the answer addresses it and never asks him to paste or resend it.
 * Transcripts under tmp/verify-super-reply-model/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = join(REPO, 'tmp', 'verify-super-reply-model');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-reply-model-${process.pid}`);
const BIN = join(SCRATCH, 'bin');
const CWD = join(SCRATCH, 'orbit');
const ARGV_LOG = join(OUT, 'argv.log');
const CLAUDE = process.env.CLAUDE_BIN || spawnSync('which', ['claude'], { encoding: 'utf-8' }).stdout.trim();

/** The server's message reference and the window's reply block (src/lib/super/types.ts,
 *  superHandover.ts; both pinned by their unit tests). */
function msgRef(text) {
  let h = 0x811c9dc5;
  const s = (text ?? '').trim();
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 2_176_782_336).toString(36).padStart(6, '0');
}
const ownerMsgBlock = (text) => `<owner-msg ref="${msgRef(text)}"/>`;
const quoteOf = (text) => Array.from(text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 100).join('').trim();
const MARK_RE = /^\s*<!--\s*re:\s*((?:[0-9a-z]{6}\s*){1,3})-->[ \t]*(?:\r?\n)?/;

const STATE = {
  vault: 'orbit', enabled: true, session: 'sup-1',
  children: {
    c1: { sessionId: 'c1', brief: 'Checkout form', row: 'working', line: 'Validating the card field' },
    c2: { sessionId: 'c2', brief: 'Pricing card', row: 'done', line: 'Renamed the Team plan card; 14 tests pass' },
    c3: { sessionId: 'c3', brief: 'Deploy', row: 'done', line: 'Staging deploy is green' },
  },
  queue: [],
  pad: [{ id: 'n1', section: 'now', text: 'Checkout form validation' }],
};
const STUB = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify({ case: process.env.PROBE_CASE, argv }) + '\\n');
const done = () => {
  if (argv[0] === 'super' && argv[1] === 'state') process.stdout.write(${JSON.stringify(JSON.stringify(STATE, null, 2))} + '\\n');
  else process.stdout.write('{"ok":true}\\n');
};
// The first turn stays running while the next messages are written.
if (process.env.PROBE_CASE === 'a' && argv[1] === 'state') setTimeout(done, 9000); else done();
`;

let failures = 0;
const ok = (name, pass, detail = '') => { if (!pass) failures += 1; console.log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `  (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function briefing() {
  const file = join(SCRATCH, 'chat-modes.mjs');
  const r = spawnSync(join(REPO, 'node_modules', '.bin', 'esbuild'), [join(REPO, 'src', 'server', 'chat-modes.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${file}`, '--packages=external', '--log-level=error'], { cwd: REPO, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`could not bundle the briefing: ${r.stderr.slice(0, 400)}`);
  const text = (await import(file)).superBriefing();
  if (!text.includes('<owner-msg ref=')) throw new Error('the briefing has no reply-links bullet');
  return text;
}

/** A live stream-json session: write owner messages, read events. */
function session(caseId, brief) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--effort', 'medium',
    '--allowedTools', 'Bash(dreamcontext super:*)', '--append-system-prompt', brief,
    '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ];
  const PATH = [BIN, '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const child = spawn(CLAUDE, args, { cwd: CWD, env: { ...process.env, PATH, PROBE_CASE: caseId }, stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { child, raw: '', err: '', events: [], lastAt: Date.now(), closed: false };
  let buf = '';
  child.stdout.on('data', (d) => {
    s.raw += d; buf += d; s.lastAt = Date.now();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { s.events.push(JSON.parse(line)); } catch { /* partial */ }
    }
  });
  child.stderr.on('data', (d) => { s.err += d; });
  child.on('close', () => { s.closed = true; });
  s.say = (text) => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }, { type: 'text', text: ownerMsgBlock(text) }] } })}\n`);
  s.results = () => s.events.filter((e) => e.type === 'result').length;
  s.texts = () => s.events.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text));
  s.toolUses = () => s.events.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === 'tool_use'));
  /** Idle: at least `n` results and nothing new for `quiet` ms. */
  s.idle = async (n, quiet = 8000, max = 6 * 60 * 1000) => {
    for (const end = Date.now() + max; Date.now() < end;) {
      if (s.results() >= n && Date.now() - s.lastAt > quiet) return true;
      if (s.closed) return s.results() >= n;
      await sleep(500);
    }
    return false;
  };
  s.end = () => { try { child.stdin.end(); } catch { /* gone */ } setTimeout(() => child.kill('SIGTERM'), 3000); };
  return s;
}

/** Every mark a block carries: its head, or one per section on its own line (both read). */
const LINE_MARK_RE = /(^|\n)[ \t]*<!--\s*re:\s*((?:[0-9a-z]{6}\s*){1,3})-->/g;
const marksOf = (texts) => texts.flatMap((t) => [...t.matchAll(LINE_MARK_RE)].map((m) => m[2].trim().split(/\s+/)));

async function caseA(brief) {
  console.log('\n── (a) three messages, the 2nd and 3rd while the first turn runs');
  const MSG = [
    'Where is the checkout form job right now?',
    'Also: did the pricing card rename finish?',
    'And is the staging deploy green?',
  ];
  const s = session('a', brief);
  s.say(MSG[0]);
  // The first turn is running once it called a tool (the stub holds `super state` for 9 s).
  const started = await (async () => { for (const end = Date.now() + 120000; Date.now() < end;) { if (s.toolUses().length) return true; await sleep(300); } return false; })();
  ok('(a) the first turn is running (a tool call) before the next messages', started);
  await sleep(1500);
  s.say(MSG[1]);
  await sleep(1500);
  s.say(MSG[2]);
  const runningWhenWritten = s.results() === 0;
  ok('(a) the 2nd and 3rd were written while the first turn still ran', runningWhenWritten);
  await s.idle(1, 15000);
  s.end();
  await sleep(1000);
  writeFileSync(join(OUT, 'case-a.ndjson'), s.raw);
  if (s.err) writeFileSync(join(OUT, 'case-a.stderr.txt'), s.err);
  const texts = s.texts();
  const marks = marksOf(texts);
  const sent = new Set(MSG.map(msgRef));
  const named = new Set(marks.flat());
  writeFileSync(join(OUT, 'case-a.reply.txt'), `${texts.join('\n\n----\n\n')}\n\n--- sent refs\n${MSG.map((m) => `${msgRef(m)}  ${m}`).join('\n')}\n`);
  console.log(`  sent: ${[...sent].join(' ')}; marks: ${JSON.stringify(marks)}`);
  for (const t of texts) console.log(`  · ${t.replace(/\s+/g, ' ').slice(0, 160)}`);
  ok('(a) every message is answered by a marked block (3 of 3)', MSG.every((m) => named.has(msgRef(m))), `${[...named].filter((r) => sent.has(r)).length}/3`);
  ok('(a) no mark names a ref he never sent', [...named].every((r) => sent.has(r)), [...named].filter((r) => !sent.has(r)).join(' '));
}

async function caseB(brief) {
  console.log('\n── (b) a reply to the Super\'s own earlier answer');
  const s = session('b', brief);
  s.say('What did the pricing card job end up doing?');
  await s.idle(1, 6000);
  const first = s.texts().map((t) => t.replace(LINE_MARK_RE, '$1')).filter((t) => t.trim()).at(-1) ?? '';
  ok('(b) the Super answered first', !!first.trim(), first);
  const reply = `[Reply to message ref=${msgRef(first)} from=super]\nquote: ${JSON.stringify(quoteOf(first))}\n\nok, then rename the Starter card the same way`;
  const before = s.texts().length;
  s.say(reply);
  await s.idle(2, 8000);
  s.end();
  await sleep(1000);
  writeFileSync(join(OUT, 'case-b.ndjson'), s.raw);
  if (s.err) writeFileSync(join(OUT, 'case-b.stderr.txt'), s.err);
  const answer = s.texts().slice(before).map((t) => t.replace(LINE_MARK_RE, '$1')).join('\n\n');
  writeFileSync(join(OUT, 'case-b.reply.txt'), `--- first answer\n${first}\n\n--- his reply\n${reply}\n\n--- answer\n${answer}\n`);
  console.log(`  first: ${first.replace(/\s+/g, ' ').slice(0, 200)}`);
  console.log(`  answer: ${answer.replace(/\s+/g, ' ').slice(0, 300)}`);
  ok('(b) the answer addresses the replied-to work (the cards)', /starter|card|pricing|rename/i.test(answer), answer.slice(0, 200));
  ok('(b) it never asks him to paste, resend or name the message', !/\b(paste|resend|re-send|send (me )?the (full|whole|original)|which message|what message|full message|share the message)\b/i.test(answer), answer.slice(0, 200));
}

async function main() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [BIN, CWD, OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(ARGV_LOG, '');
  writeFileSync(join(BIN, 'dreamcontext'), STUB);
  chmodSync(join(BIN, 'dreamcontext'), 0o755);
  const brief = await briefing();
  console.log(`claude: ${CLAUDE}; briefing ${brief.length} characters; scratch ${SCRATCH}`);
  const only = process.argv[2];
  if (!only || only.includes('a')) await caseA(brief);
  if (!only || only.includes('b')) await caseB(brief);
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — transcripts in ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
