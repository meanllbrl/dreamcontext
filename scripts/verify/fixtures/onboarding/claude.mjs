/**
 * Stand-in for `claude`, used by scripts/verify/onboarding.mjs. Never the real CLI: it lives in
 * a fake HOME and answers exactly the calls onboarding makes, logging each one so a row can
 * assert what ran.
 *
 * State lives in `$HOME/.verify/`:
 *   claude-auth.json   what `auth status --json` answers (loggedIn true/false)
 *   claude-login-mode  `hang` makes `auth login` wait until killed (the Cancel row); anything
 *                      else signs in after a short pause, the way a browser round trip would
 *   claude-login.pid   the pid of the running `auth login`, so the harness can prove a cancel
 *   claude-first-message.txt  the first user message a chat session received
 *   log                one line per call: `claude <kind> <argv>`
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '';
const V = path.join(HOME, '.verify');
const argv = process.argv.slice(2);

function log(kind) {
  try { fs.appendFileSync(path.join(V, 'log'), `claude\t${kind}\t${argv.join(' ')}\n`); } catch { /* best-effort */ }
}

function readAuth() {
  try { return JSON.parse(fs.readFileSync(path.join(V, 'claude-auth.json'), 'utf-8')); } catch { return { loggedIn: false }; }
}

if (argv[0] === '--version' || argv[0] === '-v') {
  log('version');
  process.stdout.write('2.1.300 (Claude Code)\n');
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  const auth = readAuth();
  process.stdout.write(JSON.stringify({
    loggedIn: auth.loggedIn === true,
    authMethod: auth.loggedIn ? 'claude.ai' : 'none',
    apiProvider: 'firstParty',
    ...(auth.loggedIn ? { email: 'verify@example.com', subscriptionType: 'max' } : {}),
  }));
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'login') {
  log('login');
  fs.writeFileSync(path.join(V, 'claude-login.pid'), String(process.pid));
  let mode = '';
  try { mode = fs.readFileSync(path.join(V, 'claude-login-mode'), 'utf-8').trim(); } catch { mode = ''; }
  if (mode === 'hang') {
    setInterval(() => {}, 1 << 30);
  } else {
    setTimeout(() => {
      fs.writeFileSync(path.join(V, 'claude-auth.json'), JSON.stringify({ loggedIn: true }));
      log('login-done');
      process.exit(0);
    }, 2500);
  }
} else if (!argv.includes('--input-format')) {
  // `--help` (the model picker) and anything else: quiet.
  log('other');
  process.exit(0);
} else {
  runEngine();
}

/** A minimal stream-json engine: enough for a chat session to open and take a first turn. */
function runEngine() {
  log('engine');
  const idFlag = argv.indexOf('--session-id') !== -1 ? argv.indexOf('--session-id') : argv.indexOf('--resume');
  const convId = idFlag !== -1 ? argv[idFlag + 1] : 'verify';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let buf = '';
  let firstSeen = false;
  process.stdin.on('data', (c) => {
    buf += c.toString('utf-8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'user') continue;
      const content = o.message && o.message.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : '';
      if (!firstSeen) {
        firstSeen = true;
        try { fs.writeFileSync(path.join(V, 'claude-first-message.txt'), text); } catch { /* best-effort */ }
      }
      out({ type: 'system', subtype: 'init', session_id: convId, model: 'claude-opus-5',
        permissionMode: 'auto', slash_commands: [], claude_code_version: '2.1.300' });
      out({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5',
        content: [{ type: 'text', text: 'Hello. Tell me about this project.' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  setInterval(() => {}, 1 << 30);
}
