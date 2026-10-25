#!/usr/bin/env node
/**
 * Several references in one owner message, with the REAL model (task super-e-tek-mesajda-birden-
 * cok-referans-…, plan r1 W1 'Model check' and R3-6): briefed with this checkout's briefing (rev
 * 12), does the Super Agent answer each PART of a message in its own section, opening with that
 * part's ref from `<owner-msg parts="…">`, in his order, one ref per line; keep the pad right per
 * line; and leave its open question open when no part is it?
 *
 *   node scripts/verify/super-multi-ref-model.mjs [a|b]
 *
 * The rig is super-reply-model.mjs's: one `claude -p --input-format stream-json --output-format
 * stream-json --verbose --model opus --effort medium` session per case, each owner message ONE
 * user write with his words first and the server's `<owner-msg …/>` block after them (built by
 * this checkout's own `ownerMsgBlock`, bundled from src/lib/super/types.ts). The only
 * pre-approved tool is `Bash(dreamcontext super:*)`; a stub `dreamcontext` first on a minimal
 * PATH logs its argv and prints a canned `super state` (fictional project "orbit"). Scratch cwd,
 * no session persistence, project settings only, no MCP servers.
 *
 *  (a) a first answer from the Super, then one message: a preamble + 3 parts (a note he says is
 *      done, a reply to that answer, a child's question) -> 3 part sections with the right part
 *      refs, in order, one per line, at most one message-ref section; `note done` only for the
 *      line he said is done; the Super's own open question (not a part) stays open;
 *  (b) two stacked chips sharing one comment + one single part -> 2 sections, the first opening
 *      with both part marks one per line, the second with the third part's.
 * Transcripts under tmp/verify-super-multi-ref-model/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = join(REPO, 'tmp', 'verify-super-multi-ref-model');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-multi-ref-model-${process.pid}`);
const BIN = join(SCRATCH, 'bin');
const CWD = join(SCRATCH, 'orbit');
const ARGV_LOG = join(OUT, 'argv.log');
const CLAUDE = process.env.CLAUDE_BIN || spawnSync('which', ['claude'], { encoding: 'utf-8' }).stdout.trim();

const STATE = {
  vault: 'orbit', enabled: true, session: 'sup-1',
  children: {
    c1: { sessionId: 'c1', brief: 'Checkout form', row: 'asking', line: 'Asking how to build the card field' },
    c2: { sessionId: 'c2', brief: 'Pricing card', row: 'done', line: 'Renamed the Team plan card; 14 tests pass' },
  },
  queue: [
    { id: 'q-ask-1', sessionId: 'sup-1', kind: 'ask', state: 'escalated', ownerText: 'Should staging go to production today?' },
    { id: 'q-c1', sessionId: 'c1', kind: 'question', state: 'escalated', ownerText: 'Stripe Elements or a plain form for the card field?' },
  ],
  pad: [
    { id: 'n1', section: 'waiting', text: 'Windows tests for the CLI' },
    { id: 'n2', section: 'now', text: 'Docs page for the CLI' },
    { id: 'n3', section: 'waiting', text: 'Dark mode for the pricing page' },
  ],
};
const STUB = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify({ case: process.env.PROBE_CASE, argv }) + '\\n');
if (argv[0] === 'super' && argv[1] === 'state') process.stdout.write(${JSON.stringify(JSON.stringify(STATE, null, 2))} + '\\n');
else process.stdout.write('{"ok":true}\\n');
`;

let failures = 0;
const ok = (name, pass, detail = '') => { if (!pass) failures += 1; console.log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `  (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bundle(src, name) {
  const file = join(SCRATCH, `${name}.mjs`);
  const r = spawnSync(join(REPO, 'node_modules', '.bin', 'esbuild'), [join(REPO, src), '--bundle', '--platform=node', '--format=esm', `--outfile=${file}`, '--packages=external', '--log-level=error'], { cwd: REPO, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`could not bundle ${src}: ${r.stderr.slice(0, 400)}`);
  return import(file);
}

let T; // src/lib/super/types.ts, bundled
const quoteOf = (text) => Array.from(text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 100).join('').trim();
const noteBlock = (p) => `[About agenda line note=${p.id} section=${p.section}]\nline: ${JSON.stringify(p.text)}`;
const itemBlock = (id) => `[About agenda line item=${id} section=waiting]`;
const replyBlock = (text) => `[Reply to message ref=${T.msgRef(text)} from=super]\nquote: ${JSON.stringify(quoteOf(text))}`;

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
  s.say = (text) => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }, { type: 'text', text: T.ownerMsgBlock(text) }] } })}\n`);
  s.results = () => s.events.filter((e) => e.type === 'result').length;
  s.texts = () => s.events.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text));
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

const MARK_LINE = /^[ \t]*<!--\s*re:([^\n>]*?)-->[ \t]*$/;
/** Each section's marks, in order: consecutive mark lines are one section's stack. A line naming
 *  several refs is reported as such (`multi`). */
function sectionsOf(texts) {
  const out = [];
  for (const t of texts) {
    let cur = null;
    for (const line of t.split('\n')) {
      const m = MARK_LINE.exec(line);
      if (!m) { cur = null; continue; }
      const refs = m[1].trim().split(/[\s,]+/).filter(Boolean);
      if (!cur) { cur = { refs: [], multi: false }; out.push(cur); }
      cur.refs.push(...refs);
      if (refs.length > 1) cur.multi = true;
    }
  }
  return out;
}
const argvOf = (caseId) => readFileSync(ARGV_LOG, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.case === caseId).map((x) => x.argv.join(' '));

/** First turn: something to reply to. Returns the Super's last text, marks stripped. */
async function firstAnswer(s) {
  s.say('What did the pricing card job end up doing?');
  await s.idle(1, 6000);
  return s.texts().map((t) => t.replace(/(^|\n)[ \t]*<!--\s*re:[^\n>]*?-->[ \t]*\n?/g, '$1')).filter((t) => t.trim()).at(-1) ?? '';
}

async function caseA(brief) {
  console.log('\n── (a) a preamble + 3 parts: a note he says is done, a reply, a child\'s question');
  const s = session('a', brief);
  const first = await firstAnswer(s);
  ok('(a) the Super answered first', !!first.trim(), first);
  const [, n2] = STATE.pad;
  const msg = [
    'Three things, quickly:',
    noteBlock(n2), 'This one is done, I published the docs page myself.',
    replyBlock(first), 'Good. Rename the Starter card the same way.',
    itemBlock('q-c1'), 'Use Stripe Elements.',
  ].join('\n\n');
  const parts = T.partRefs(msg);
  const before = s.texts().length;
  s.say(msg);
  await s.idle(2, 10000);
  s.end();
  await sleep(1000);
  writeFileSync(join(OUT, 'case-a.ndjson'), s.raw);
  if (s.err) writeFileSync(join(OUT, 'case-a.stderr.txt'), s.err);
  const texts = s.texts().slice(before);
  const secs = sectionsOf(texts);
  const argv = argvOf('a');
  writeFileSync(join(OUT, 'case-a.reply.txt'), `--- message\n${msg}\n${T.ownerMsgBlock(msg)}\n\n--- answer\n${texts.join('\n\n----\n\n')}\n\n--- sections\n${JSON.stringify(secs)}\n\n--- argv\n${argv.join('\n')}\n`);
  console.log(`  parts: ${parts.join(' ')}; message ref ${T.msgRef(msg)}; sections: ${JSON.stringify(secs.map((x) => x.refs))}`);
  for (const t of texts) console.log(`  · ${t.replace(/\s+/g, ' ').slice(0, 220)}`);
  const partSecs = secs.filter((x) => x.refs.some((r) => parts.includes(r)));
  ok('(a) three part sections, one per part', partSecs.length === 3 && partSecs.every((x) => x.refs.length === 1), JSON.stringify(partSecs));
  ok('(a) in his order', JSON.stringify(partSecs.map((x) => x.refs[0])) === JSON.stringify(parts), JSON.stringify(partSecs.map((x) => x.refs[0])));
  ok('(a) one ref per line, never several', secs.every((x) => !x.multi));
  ok('(a) at most one message-ref section, no unknown ref', secs.filter((x) => x.refs.includes(T.msgRef(msg))).length <= 1
    && secs.flatMap((x) => x.refs).every((r) => parts.includes(r) || r === T.msgRef(msg) || r === T.msgRef('What did the pricing card job end up doing?')), JSON.stringify(secs));
  const noteDone = argv.filter((a) => /^super note done\b/.test(a));
  ok('(a) `note done` runs for n2 (the line he said is done)', noteDone.some((a) => /\bn2\b/.test(a)), argv.join(' | '));
  ok('(a) and for no other line', noteDone.every((a) => /\bn2\b/.test(a) && !/\bn[13]\b/.test(a)), noteDone.join(' | '));
  ok('(a) the Super\'s own open question (not a part) stays open', !argv.some((a) => /q-ask-1/.test(a) && /\b(queue done|answer)\b/.test(a)), argv.filter((a) => /q-ask-1/.test(a)).join(' | '));
}

async function caseB(brief) {
  console.log('\n── (b) two stacked chips sharing one comment + one single part');
  const s = session('b', brief);
  const [n1, , n3] = STATE.pad;
  const first = await firstAnswer(s);
  ok('(b) the Super answered first', !!first.trim(), first);
  const msg = [
    noteBlock(n1), noteBlock(n3), 'Both of these can wait until next week.',
    replyBlock(first), 'Then close that job.',
  ].join('\n\n');
  const parts = T.partRefs(msg);
  const before = s.texts().length;
  s.say(msg);
  await s.idle(2, 10000);
  s.end();
  await sleep(1000);
  writeFileSync(join(OUT, 'case-b.ndjson'), s.raw);
  if (s.err) writeFileSync(join(OUT, 'case-b.stderr.txt'), s.err);
  const texts = s.texts().slice(before);
  const secs = sectionsOf(texts).filter((x) => x.refs.some((r) => parts.includes(r)));
  writeFileSync(join(OUT, 'case-b.reply.txt'), `--- message\n${msg}\n${T.ownerMsgBlock(msg)}\n\n--- answer\n${texts.join('\n\n----\n\n')}\n\n--- sections\n${JSON.stringify(secs)}\n`);
  console.log(`  parts: ${parts.join(' ')}; sections: ${JSON.stringify(secs.map((x) => x.refs))}`);
  for (const t of texts) console.log(`  · ${t.replace(/\s+/g, ' ').slice(0, 220)}`);
  ok('(b) two sections', secs.length === 2, JSON.stringify(secs));
  ok('(b) the first opens with both stacked marks, one per line', JSON.stringify(secs[0]?.refs) === JSON.stringify(parts.slice(0, 2)) && !secs[0]?.multi, JSON.stringify(secs[0]));
  ok('(b) the second with the third part\'s mark', JSON.stringify(secs[1]?.refs) === JSON.stringify([parts[2]]), JSON.stringify(secs[1]));
}

async function main() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [BIN, CWD, OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(ARGV_LOG, '');
  writeFileSync(join(BIN, 'dreamcontext'), STUB);
  chmodSync(join(BIN, 'dreamcontext'), 0o755);
  T = await bundle('src/lib/super/types.ts', 'types');
  const brief = (await bundle('src/server/chat-modes.ts', 'chat-modes')).superBriefing();
  if (!brief.includes('parts="…"')) throw new Error('the briefing has no multi-reference rule (rev 12)');
  console.log(`claude: ${CLAUDE}; briefing ${brief.length} characters; scratch ${SCRATCH}`);
  const only = process.argv[2];
  if (!only || only.includes('a')) await caseA(brief);
  if (!only || only.includes('b')) await caseB(brief);
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — transcripts in ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
