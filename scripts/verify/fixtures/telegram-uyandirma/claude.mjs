#!/usr/bin/env node
/**
 * Stand-in for `claude` in the fake HOME of scripts/verify/telegram-uyandirma.mjs: a minimal
 * stream-json engine. Each user turn is answered "Uyandım: <his words>", so a check can see the
 * answer reach Telegram. Every start is logged to $HOME/.verify/claude.log with its argv (which
 * session it resumed, which permission mode), never the real CLI.
 */
import fs from 'node:fs';
import path from 'node:path';

const V = path.join(process.env.HOME || '', '.verify');
const argv = process.argv.slice(2);
try { fs.mkdirSync(V, { recursive: true }); fs.appendFileSync(path.join(V, 'claude.log'), `${new Date().toISOString()} ${argv.join(' ')} window-verbs=${process.env.DREAMCONTEXT_WINDOW_URL && process.env.DREAMCONTEXT_WINDOW_TOKEN ? 'yes' : 'no'}\n`); } catch { /* best-effort */ }
if (argv[0] === '--version' || argv[0] === '-v') { process.stdout.write('2.1.300 (Claude Code)\n'); process.exit(0); }
if (argv[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })); process.exit(0); }
if (!argv.includes('--input-format')) process.exit(0);

const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const session = at('--resume') || at('--session-id') || 'verify';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
out({ type: 'system', subtype: 'init', session_id: session, tools: [], mcp_servers: [], model: 'fake', permissionMode: at('--permission-mode') || 'default' });
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    // His words: the first plain line (a server-added note or block may follow them).
    const full = textOf(o.message?.content).replace(/[\uE000-\uF8FF][0-9a-z]{6}[\uE000-\uF8FF]/g, '');
    const said = full.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('<')) || '';
    try { fs.appendFileSync(path.join(V, 'claude-turns.log'), `${session} ${JSON.stringify(said)} (turn ${full.length} chars)\n`); } catch { /* best-effort */ }
    const reply = `Uyandım: ${said}`;
    setTimeout(() => {
      out({ type: 'assistant', parent_tool_use_id: null, session_id: session, message: { id: `m${Date.now()}`, role: 'assistant', content: [{ type: 'text', text: reply }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: session, duration_ms: 5, num_turns: 1 });
    }, 300);
  }
});
process.stdin.on('end', () => process.exit(0));
