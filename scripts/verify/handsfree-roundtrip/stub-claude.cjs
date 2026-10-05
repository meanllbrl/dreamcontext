#!/usr/bin/env node
/**
 * Inert stand-in for `claude` in the round trip's CLOUD scratch env (never the real CLI, no
 * tokens). It speaks enough stream-json to be a live chat session and answers every user
 * message with one fixed line; `auth status --json` reports a signed-in account; anything
 * else exits 0 quietly.
 *
 * Like the real CLI it appends the conversation to `<config dir>/projects/<enc(cwd)>/<id>.jsonl`
 * (config dir = $CLAUDE_CONFIG_DIR, else ~/.claude). On the Mac seam the cloud keeps laptop
 * path P at <mirror>P, so `cwd` is mapped back to P first: in production the two are equal.
 * Every spawn is logged (config dir, session id, cwd) to the harness log for the assertions.
 */
const { appendFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const MIRROR = '__MIRROR__';
const SPAWN_LOG = '__SPAWN_LOG__';
const REPLY = 'Roundtrip stub reply: the cloud heard you.';
const argv = process.argv.slice(2);
if (argv[0] === '--version' || argv[0] === '-v') { process.stdout.write('2.0.0 (Claude Code)\n'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'kerem@example.com' }) + '\n');
  process.exit(0);
}
if (!argv.includes('stream-json')) process.exit(0);


const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const idFlag = argv.includes('--resume') ? '--resume' : argv.includes('--session-id') ? '--session-id' : null;
const session = idFlag ? argv[argv.indexOf(idFlag) + 1] : randomUUID();
const laptopCwd = process.cwd().startsWith(MIRROR + '/') ? process.cwd().slice(MIRROR.length) : process.cwd();
const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || '/', '.claude');
const tdir = join(configDir, 'projects', laptopCwd.replace(/[^A-Za-z0-9]/g, '-'));
appendFileSync(SPAWN_LOG, JSON.stringify({ at: Date.now(), configDir: process.env.CLAUDE_CONFIG_DIR || null, session, cwd: process.cwd(), argv }) + '\n');
let parent = null;
function record(o) {
  try {
    mkdirSync(tdir, { recursive: true });
    const line = { ...o, uuid: randomUUID(), parentUuid: parent, sessionId: session, cwd: laptopCwd, timestamp: new Date().toISOString() };
    parent = line.uuid;
    appendFileSync(join(tdir, `${session}.jsonl`), JSON.stringify(line) + '\n');
  } catch (e) { appendFileSync(SPAWN_LOG, JSON.stringify({ transcriptError: String(e) }) + '\n'); }
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type !== 'user') continue;
    record({ type: 'user', message: o.message });
    record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } });
    out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'default', slash_commands: [] });
    out({ type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: REPLY, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: session });
  }
});
process.stdin.on('end', () => process.exit(0));
